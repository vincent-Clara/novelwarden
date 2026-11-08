/**
 * 「更新角色卡」：分批、增量/全量、失敗降級、併發與審閱排隊。
 * 遷自 scripts/smoke-characterCard.js（86 條斷言）。
 *
 * 這條流程是唯一一處「一次動作要調 N 次模型」的地方，N 由上下文預算算出，
 * 且要在動手前告訴作者。這些都不能靠手測——章節一多就要造幾十萬字語料。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, makeSettings } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

function cardJson(overrides) {
  return JSON.stringify({
    aliases: [],
    tags: ['主角'],
    身份: '倖存者',
    外貌: '',
    性格: '沉默寡言',
    语言习惯: '答話極短',
    人物关系: '',
    当前状态: '在客棧',
    暗设: '',
    ...overrides,
  });
}

let bundle;
let projectMod;
let castMod;
let cardMod;
let errorLog;
let h;
let fake;
let t;
let project;

/**
 * 預設併發 1，讓絕大多數用例保持序列行為；併發那一節自己把它調大。
 * 視窗刻意開得小（4000），好讓幾章正文就撐出多批來。
 */
let settings;

const CARD = '.novelwarden/characters/林昭.md';

/**
 * 對應原指令碼的 `expect()`：清答案佇列與各錄製器，並把「調了幾次」歸零。
 * **刻意不動應答佇列**——原指令碼的 expect() 也不動 `replies`。
 */
function expect(...values) {
  h.expect(...values);
  fake.calls.length = 0;
  h.resetPeaks();
}

/**
 * 確認框裡報的次數（2026-10-25 起改成轉寫）：每批寫 1 次、轉寫 1 次，轉寫不合格重轉 1 次。假模型直接給 JSON，
 * 不轉寫，實際呼叫次數就是批數。
 */
const batchCalls = (batches) =>
  `分 ${batches} 批，預計 ${batches * 2} 次呼叫，最多 ${batches * 3} 次（${batches > 1 ? '每批' : ''}寫 1 次、轉寫模型照抄成 JSON 1 次`;

/** 對應原指令碼的 `replies = [...]`；順帶把模型側併發峰值歸零。 */
function setReplies(items) {
  fake.reset(items);
}

/**
 * 造一章：`words` 字的成品正文 + 一份定稿過（帶 sourceHash 與 cast）的細綱。
 *
 * 角色卡通讀的是 `chapters/` 裡的正文、出場統計來自定稿過的細綱——
 * 沒定稿的細綱裡「出場人物」寫的是計劃，不算出場（D13）。
 */
function makePlot(no, title, cast, words = 400) {
  const pad = '雨下了三天，石板路泡得發白。'.repeat(Math.ceil(words / 14)).slice(0, words);
  const stem = `${String(no).padStart(3, '0')}-${title}`;
  t.write(`chapters/${stem}.md`, `# ${title}\n\n${pad}\n`);
  t.write(
    `.novelwarden/summaries/${stem}.md`,
    `---\nno: ${no}\ntitle: ${title}\nsourceHash: x\ncast: [${cast.join(', ')}]\n---\n\n` +
      `# 第${no}章 ${title}\n\n## 梗概\n\n略。\n\n## 出場人物\n\n${cast.join('、')}\n\n## 關鍵事件\n\n甲乙丙。\n\n## 看點\n\n略。\n`
  );
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    cast: './src/core/views/cast.ts',
    characterCard: './src/core/features/characterCard.ts',
    registry: './src/core/llm/registry.ts',
    // 失敗記錄會落進工程庫；這裡要能讀回來斷言，收尾還要關掉連線。
    db: './src/core/runtime/db.ts',
    errorLog: './src/core/runtime/errorLog.ts',
  });
  ({ project: projectMod, cast: castMod, characterCard: cardMod, errorLog } = bundle);

  settings = makeSettings({ contextWindow: 4000 });
  h = makeFakeHost({ supportsVscodeLm: true, settings: () => settings });
  // 真實的 diff 審閱是「彈出去等使用者」，這裡也要留出重入的機會，
  // 否則序列與否根本測不出來。
  h.setReviewDelay(6);
  bundle.host.initHost(h.host);
  // `replies.length > 1 ? shift() : replies[0]` = repeatLast；`?? cardJson()` = fallback；
  // stream 裡的 sleep(4) = delayMs（不留延時的話併發與序列跑出來一樣）。
  fake = installFakeProvider(bundle.registry, {
    repeatLast: true,
    fallback: cardJson(),
    delayMs: 4,
  });

  t = await makeTempProject(projectMod, { prefix: 'charcard', title: '角色卡測試' });
  project = t.project;

  // 林昭出場 1、2、4、5 章；沈氏只在第 3 章；「客棧掌櫃」全程沒有角色卡。
  makePlot(1, '楔子', ['林昭', '客棧掌櫃']);
  makePlot(2, '入鎮', ['林昭']);
  makePlot(3, '夜談', ['沈氏', '客棧掌櫃']);
  makePlot(4, '追兵', ['林昭']);
  makePlot(5, '渡口', ['林昭']);
  t.write(CARD, '---\nname: 林昭\naliases: [阿昭]\ntags: [主角]\n---\n\n# 林昭\n\n## 身份\n\n（待補充）\n');
  project.invalidate();
});

after(() => {
  // **必須先關庫再刪目錄**：Windows 上 SQLite 連線開著時刪不掉。
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('分批與「預計呼叫次數」', () => {
  let callCount;
  let ask;
  let confirmMessages;
  let corpus;
  let call0;
  let call1;
  let reviewedCount;
  let card;
  let opened;

  before(async () => {
    expect('開始');
    setReplies([cardJson()]);
    await cardMod.updateCharacterCard(project, CARD, 'full');

    callCount = fake.calls.length;
    ask = h.confirms.find((c) => c.message.includes('次呼叫'));
    confirmMessages = h.confirms.map((c) => c.message);
    // 只讀該角色出場的那 4 章，第 3 章（沈氏）不該進來。
    corpus = fake.calls.map((m) => m[1].content).join('\n');
    call0 = fake.calls[0];
    call1 = fake.calls[1];
    reviewedCount = h.reviewed.length;
    card = t.read(CARD);
    opened = [...h.opened];
  });

  // 4000 的視窗裝不下 4 章 400 字的正文，必須分批。
  test('分成了多批', () => {
    assert.ok(callCount > 1, `只調了 ${callCount} 次`);
  });

  test('動手前問過使用者', () => {
    assert.ok(!!ask, JSON.stringify(confirmMessages));
  });

  test('確認框寫明預計呼叫次數：每批寫 1 次、轉寫 1 次', () => {
    assert.ok(ask && ask.message.includes(batchCalls(callCount)), ask && ask.message);
  });

  test('確認框寫明要讀幾章', () => {
    assert.ok(ask && ask.message.includes('通讀 4 章'), ask && ask.message);
  });

  test('只裝該角色的出場章節', () => {
    assert.ok(!corpus.includes('夜談'), '第 3 章不該出現');
  });

  test('裝進了他出場的章節', () => {
    assert.ok(['楔子', '入鎮', '追兵', '渡口'].every((x) => corpus.includes(x)));
  });

  // 後一批要看得到前一批的產出，否則就成了各寫各的。
  test('後續批次帶上當前檔案', () => {
    assert.ok(
      call1[1].content.includes('當前的角色檔案') && call1[1].content.includes('沉默寡言'),
      call1[1].content.slice(0, 200)
    );
  });

  test('提示詞要求控制篇幅', () => {
    assert.ok(call0[0].content.includes('精煉') && call0[0].content.includes('字以內'));
  });

  test('提示詞點名性格與語言習慣優先', () => {
    assert.ok(call0[0].content.includes('「性格」和「語言習慣」'));
  });

  test('走了 diff 審閱', () => {
    assert.equal(reviewedCount, 1, String(reviewedCount));
  });

  test('寫回了模型產出', () => {
    assert.ok(card.includes('沉默寡言'), card.slice(0, 200));
  });

  test('回寫出場章節', () => {
    assert.ok(card.includes('appearsIn: [1, 2, 4, 5]'), card.split('\n')[5]);
  });

  test('記下讀到第幾章', () => {
    assert.ok(card.includes('updatedThrough: 5'), card);
  });

  test('保留作者寫的別名', () => {
    assert.ok(card.includes('阿昭'));
  });

  test('單卡更新後自動開啟該卡', () => {
    assert.ok(opened.includes(CARD), JSON.stringify(opened));
  });
});

describe('增量更新', () => {
  let corpus;
  let callCount;
  let card;
  let callCountAgain;
  let toastsAgain;

  before(async () => {
    project.invalidate();
    makePlot(6, '新章', ['林昭']);
    // 作者在卡上寫了性別：模型說什麼都不改。
    t.write(CARD, t.read(CARD).replace(/^name: 林昭$/m, 'name: 林昭\ngender: 男'));
    project.invalidate();

    expect('開始');
    setReplies([cardJson({ 当前状态: '已渡河', 性别: '女' })]);
    await cardMod.updateCharacterCard(project, CARD, 'incremental');

    corpus = fake.calls.map((m) => m[1].content).join('\n');
    callCount = fake.calls.length;
    card = t.read(CARD);

    // 沒有新章節時不該白跑一次模型。
    expect();
    await cardMod.updateCharacterCard(project, CARD, 'incremental');
    callCountAgain = fake.calls.length;
    toastsAgain = [...h.toasts];
  });

  test('增量只讀新章節', () => {
    assert.ok(corpus.includes('新章'), corpus.slice(0, 100));
  });

  test('增量不重讀舊章節', () => {
    assert.ok(!corpus.includes('楔子') && !corpus.includes('渡口'));
  });

  test('增量只調一次模型', () => {
    assert.equal(callCount, 1, String(callCount));
  });

  test('增量後 updatedThrough 前進', () => {
    assert.ok(card.includes('updatedThrough: 6'), card);
  });

  test('增量後 appearsIn 含新章', () => {
    assert.ok(card.includes('6'), card);
  });

  test('增量寫入了新內容', () => {
    assert.ok(card.includes('已渡河'));
  });

  test('卡上寫了的性別給模型看，模型給的另一個不採納', () => {
    assert.ok(corpus.includes('性別：男'), corpus.slice(0, 300));
    assert.match(card, /^gender: 男$/m);
    assert.doesNotMatch(card, /gender: 女/);
  });

  test('沒有新章節時不調模型', () => {
    assert.equal(callCountAgain, 0, String(callCountAgain));
  });

  test('沒有新章節時明說', () => {
    assert.ok(toastsAgain.some((x) => x.includes('沒有新的出場章節')), toastsAgain.join(' | '));
  });
});

describe('解析失敗與取消', () => {
  let partialCard;
  let partialLine;
  let partialActive;
  let partialMarks;
  let beforeAllFail;
  let afterAllFail;
  let allFailReviewed;
  let allFailToasts;
  let allFailActive;
  let allFailMarks;
  let successCard;
  let successActive;
  let cancelCallCount;
  let keptCard;
  let afterDiscard;

  before(async () => {
    // 某一批解析失敗：其餘批的成果照樣寫回，但 updatedThrough 不能跳過失敗的章。
    // 這裡讓第一批失敗、後面成功——若把 updatedThrough 推到最後一章，
    // 第 1、2 章就再也不會被讀到了。
    makePlot(7, '第七', ['林昭']);
    makePlot(8, '第八', ['林昭']);
    project.invalidate();
    fs.writeFileSync(
      t.rel(CARD),
      '---\nname: 林昭\naliases: [阿昭]\ntags: [主角]\nappearsIn: [1, 2, 4, 5, 6]\nupdatedThrough: 0\n---\n\n# 林昭\n\n## 身份\n\n舊的\n',
      'utf8'
    );
    expect('開始');
    setReplies(['模型答非所問，完全不是 JSON', cardJson({ 身份: '新的' })]);
    await cardMod.updateCharacterCard(project, CARD, 'full');
    partialCard = t.read(CARD);
    // 第一批（含第 1、2 章）失敗 → 水位線必須停在 0，否則那兩章被永久跳過。
    partialLine = partialCard.split('\n').find((l) => l.startsWith('updatedThrough'));

    // 部分失敗必須在介面上留痕：卡確實更新了一部分，但還缺一塊。
    partialActive = await errorLog.listActiveFailures(project);
    partialMarks = partialActive[CARD] || [];

    // 全部失敗：不改卡、不推進 updatedThrough、明確報錯。
    beforeAllFail = t.read(CARD);
    expect('開始');
    setReplies(['還是不是 JSON']);
    await cardMod.updateCharacterCard(project, CARD, 'full');
    afterAllFail = t.read(CARD);
    allFailReviewed = h.reviewed.length;
    allFailToasts = [...h.toasts];

    // ★ 這次修的 bug：日誌與 toast 都要求使用者「恰好在看」，而卡一字未改，
    //   介面上跟更新成功的一模一樣。失敗必須掛在卡上，一直掛到成功為止。
    allFailActive = await errorLog.listActiveFailures(project);
    allFailMarks = allFailActive[CARD] || [];

    // 修好之後標記必須自己消失——留著比一開始不報錯更糟。
    expect('開始');
    setReplies([cardJson({ 身份: '這次成了' })]);
    await cardMod.updateCharacterCard(project, CARD, 'full');
    successCard = t.read(CARD);
    successActive = await errorLog.listActiveFailures(project);

    // 使用者在確認框點取消：一次模型都不該調。
    expect(undefined);
    setReplies([cardJson()]);
    await cardMod.updateCharacterCard(project, CARD, 'full');
    cancelCallCount = fake.calls.length;

    // 審閱時放棄：卡不變。
    keptCard = t.read(CARD);
    h.setReviewVerdict('discard');
    expect('開始');
    setReplies([cardJson({ 身份: '不該寫進去' })]);
    await cardMod.updateCharacterCard(project, CARD, 'full');
    afterDiscard = t.read(CARD);
    h.setReviewVerdict('apply');
  });

  test('部分失敗仍寫回成功的部分', () => {
    assert.ok(partialCard.includes('新的'), partialCard.slice(0, 300));
  });

  test('水位線停在第一個失敗章節之前', () => {
    assert.equal(partialLine, 'updatedThrough: 0', partialLine);
  });

  test('部分失敗在卡上留下標記', () => {
    assert.ok(partialMarks.length > 0, JSON.stringify(partialActive));
  });

  test('部分失敗標記為「部分完成」而非「未改動」', () => {
    assert.equal(partialMarks[0] && partialMarks[0].severity, 'warn', partialMarks[0] && partialMarks[0].severity);
  });

  test('部分失敗的說明裡給出水位線', () => {
    assert.ok(
      partialMarks[0] && partialMarks[0].message.includes('已讀到'),
      partialMarks[0] && partialMarks[0].message
    );
  });

  test('全部失敗時角色卡一字不改', () => {
    assert.equal(afterAllFail, beforeAllFail);
  });

  test('全部失敗時不彈審閱', () => {
    assert.equal(allFailReviewed, 0, String(allFailReviewed));
  });

  test('全部失敗時報錯', () => {
    assert.ok(allFailToasts.some((x) => x.startsWith('error:')), allFailToasts.join(' | '));
  });

  test('全部失敗在卡上留下標記', () => {
    assert.ok(allFailMarks.length > 0, JSON.stringify(allFailActive));
  });

  test('全部失敗標記為「未改動」', () => {
    assert.equal(allFailMarks[0] && allFailMarks[0].severity, 'error', allFailMarks[0] && allFailMarks[0].severity);
  });

  test('標記裡說清了是解析失敗、卡未改動', () => {
    assert.ok(
      allFailMarks[0] && allFailMarks[0].message.includes('解析失敗') && allFailMarks[0].message.includes('未改動'),
      allFailMarks[0] && allFailMarks[0].message
    );
  });

  // 同一張卡 + 同一動作只留最新一條：連著失敗兩次不該並排掛兩個感嘆號。
  test('同一動作只保留最新一條', () => {
    assert.equal(allFailMarks.length, 1, String(allFailMarks.length));
  });

  test('成功后角色卡確實更新了', () => {
    assert.ok(successCard.includes('這次成了'));
  });

  test('成功一次後標記自動消失', () => {
    assert.ok(!successActive[CARD], JSON.stringify(successActive));
  });

  test('使用者取消則不調模型', () => {
    assert.equal(cancelCallCount, 0, String(cancelCallCount));
  });

  test('審閱放棄則不落盤', () => {
    assert.equal(afterDiscard, keptCard);
  });
});

describe('定稿裡沒出場過的角色', () => {
  let callCount;
  let toasts;

  before(async () => {
    t.write('.novelwarden/characters/幽靈.md', '---\nname: 幽靈\n---\n\n# 幽靈\n');
    project.invalidate();
    expect('開始');
    setReplies([cardJson()]);
    await cardMod.updateCharacterCard(project, '.novelwarden/characters/幽靈.md', 'full');
    callCount = fake.calls.length;
    toasts = [...h.toasts];
  });

  test('沒出場的角色不調模型', () => {
    assert.equal(callCount, 0, String(callCount));
  });

  test('沒出場的角色明確報錯', () => {
    assert.ok(
      toasts.some((x) => x.startsWith('error:') && x.includes('幽靈')),
      toasts.join(' | ')
    );
  });
});

describe('給未建卡的人物建卡', () => {
  let beforeCount;
  let afterCount;
  let created;
  let reviewedCount;
  let calls;
  let index;
  let missingToasts;

  before(async () => {
    project.invalidate();
    const before = await project.listCharacters();
    beforeCount = before.length;
    expect('開始');
    // 模型把同場的林昭當成了掌櫃：別名裡混進林昭的名字（實戰裡配角卡掛上了主角名）。
    setReplies([cardJson({ 身份: '停舟客棧的掌櫃', 性别: '女性', aliases: ['林昭', '老闆娘', '沈氏'] })]);
    await cardMod.createCardForCast(project, '客棧掌櫃');

    const after = await project.listCharacters();
    afterCount = after.length;
    created = after.find((c) => c.name === '客棧掌櫃');
    reviewedCount = h.reviewed.length;
    calls = [...fake.calls];

    // 建完之後他就不該再出現在「未建卡」列表裡了。
    project.invalidate();
    index = await castMod.buildCastIndex(project);

    // 定稿裡沒有的人不能憑空建卡。
    expect('開始');
    await cardMod.createCardForCast(project, '查無此人');
    missingToasts = [...h.toasts];
  });

  test('確實建出了一張卡', () => {
    assert.equal(afterCount, beforeCount + 1, `${beforeCount} → ${afterCount}`);
  });

  test('新卡帶出場章節', () => {
    assert.ok(
      created && created.appearsIn.join(',') === '1,3',
      created && created.appearsIn.join(',')
    );
  });

  test('新卡填上了模型產出', () => {
    assert.ok(created && created.sections.身份.includes('掌櫃'), created && created.sections.身份);
  });

  test('卡上沒寫的性別從正文補上，規範成「女」', () => {
    assert.equal(created && created.gender, '女');
  });

  // 剛建出來的空卡沒有作者寫的內容，不必走 diff。
  test('新建卡不走 diff 審閱', () => {
    assert.equal(reviewedCount, 0, String(reviewedCount));
  });

  test('只讀該人物的出場章節', () => {
    assert.ok(calls.every((m) => !m[1].content.includes('入鎮')), '第 2 章沒有客棧掌櫃');
  });

  test('提示詞點名同場的其他人物不是他', () => {
    assert.ok(
      calls.some((m) => /出場的其他人物：林昭、沈氏。他們都不是客棧掌櫃/.test(m[1].content)),
      calls.map((m) => m[1].content.slice(0, 120)).join(' || ')
    );
  });

  test('別名裡別人的名字被攔下，專屬稱呼保留', () => {
    assert.deepEqual(created && created.aliases, ['老闆娘']);
  });

  test('建卡後離開未建卡列表', () => {
    assert.ok(
      !index.unknown.some((m) => m.name === '客棧掌櫃'),
      index.unknown.map((m) => m.name).join('、')
    );
  });

  test('建卡後進入已建卡列表', () => {
    assert.ok(index.known.some((m) => m.card && m.card.name === '客棧掌櫃'));
  });

  test('定稿裡沒有的人不建卡', () => {
    assert.ok(missingToasts.some((x) => x.startsWith('error:')), missingToasts.join(' | '));
  });
});

describe('批次更新所有角色卡', () => {
  let ask;
  let confirmMessages;
  let callCount;
  let corpus;
  let reviewedCount;
  let openedCount;
  let linCard;
  let fullCorpus;
  let fullReviewedCount;
  let bothRewritten;
  let fullToasts;
  let cancelCallCount;
  let idleConfirms;
  let idleToasts;

  before(async () => {
    // 上一節的失敗用例把林昭的水位線打回了 0；這裡重置成「讀到第 6 章」，
    // 增量批次才只剩第 7、8 章可讀。幽靈沒出場、客棧掌櫃沒有新章。
    fs.writeFileSync(
      t.rel(CARD),
      '---\nname: 林昭\naliases: [阿昭]\ntags: [主角]\nappearsIn: [1, 2, 4, 5, 6]\nupdatedThrough: 6\n---\n\n# 林昭\n\n## 身份\n\n舊的\n',
      'utf8'
    );
    project.invalidate();

    // ---- 增量：只挑有新出場的卡，動手前報總呼叫次數。
    project.invalidate();
    expect('逐張確認後開始');
    setReplies([cardJson({ 当前状态: '批次測試中' })]);
    await cardMod.updateAllCharacterCards(project, 'incremental');

    ask = h.confirms.find((c) => c.message.includes('次呼叫'));
    confirmMessages = h.confirms.map((c) => c.message);
    callCount = fake.calls.length;
    corpus = fake.calls.map((m) => m[1].content).join('\n');
    reviewedCount = h.reviewed.length;
    openedCount = h.opened.length;
    linCard = t.read(CARD);

    // ---- 從頭重建：全部有出場的卡全量重讀，可整體直接採納。
    expect('全部直接採納並開始');
    setReplies([cardJson({ 身份: '重建的身份' })]);
    await cardMod.updateAllCharacterCards(project, 'full');

    fullCorpus = fake.calls.map((m) => m[1].content).join('\n');
    fullReviewedCount = h.reviewed.length;
    bothRewritten =
      t.read(CARD).includes('重建的身份') &&
      t.read('.novelwarden/characters/客棧掌櫃.md').includes('重建的身份');
    fullToasts = [...h.toasts];

    // ---- 取消：一次模型都不調。
    expect(undefined);
    setReplies([cardJson()]);
    await cardMod.updateAllCharacterCards(project, 'full');
    cancelCallCount = fake.calls.length;

    // ---- 無可更新：不彈確認框，直接說明。
    expect();
    await cardMod.updateAllCharacterCards(project, 'incremental');
    idleConfirms = h.confirms.map((c) => c.message);
    idleToasts = [...h.toasts];
  });

  test('批次動手前問過使用者', () => {
    assert.ok(!!ask, JSON.stringify(confirmMessages));
  });

  test('確認框給出兩種採納方式', () => {
    assert.ok(
      ask && ask.actions.includes('逐張確認後開始') && ask.actions.includes('全部直接採納並開始'),
      ask && JSON.stringify(ask.actions)
    );
  });

  test('預計呼叫次數與實際批數一致', () => {
    assert.ok(ask && ask.message.includes(batchCalls(callCount)), ask && ask.message);
  });

  test('跳過情況寫進明細', () => {
    assert.ok(ask && ask.detail.includes('幽靈') && ask.detail.includes('客棧掌櫃'), ask && ask.detail);
  });

  test('增量批次只讀新出場的章節', () => {
    assert.ok(corpus.includes('第七') && !corpus.includes('楔子'), corpus.slice(0, 120));
  });

  test('逐張確認模式走了 diff 審閱', () => {
    assert.equal(reviewedCount, 1, String(reviewedCount));
  });

  test('批次不自動開啟卡', () => {
    assert.equal(openedCount, 0, JSON.stringify(h.opened));
  });

  test('林昭的卡已更新', () => {
    assert.ok(linCard.includes('批次測試中'));
  });

  test('重建讀全部出場章節', () => {
    assert.ok(fullCorpus.includes('楔子') && fullCorpus.includes('夜談'));
  });

  test('直接採納模式不走審閱', () => {
    assert.equal(fullReviewedCount, 0, String(fullReviewedCount));
  });

  test('兩張卡都已重寫', () => {
    assert.ok(bothRewritten);
  });

  test('完成提示報數', () => {
    assert.ok(fullToasts.some((x) => x.includes('已更新 2 張')), fullToasts.join(' | '));
  });

  test('使用者取消則不調模型', () => {
    assert.equal(cancelCallCount, 0, String(cancelCallCount));
  });

  test('沒有新章節時不彈確認框', () => {
    assert.equal(idleConfirms.length, 0, JSON.stringify(idleConfirms));
  });

  test('沒有新章節時明說', () => {
    assert.ok(idleToasts.some((x) => x.includes('沒有需要更新的角色卡')), idleToasts.join(' | '));
  });
});

describe('批次更新：併發與審閱排隊', () => {
  let callsPeak;
  let reviewPeak;
  let reviewedCount;
  let firstConfirm;
  let linCard;
  let ask;
  let callCount;

  before(async () => {
    settings.concurrency = 3;
    try {
      // 逐張確認 + 併發：分析可以重疊，但 diff 一次只能彈一張——
      // 同時彈三個 diff，使用者根本不知道自己在看誰。
      expect('逐張確認後開始');
      setReplies([cardJson({ 当前状态: '併發審閱' })]);
      await cardMod.updateAllCharacterCards(project, 'full');

      callsPeak = fake.peak();
      reviewPeak = h.reviewPeak();
      reviewedCount = h.reviewed.length;
      firstConfirm = h.confirms[0];
      linCard = t.read(CARD);
      // 預計呼叫次數是承諾，不能因為併發就對不上賬。
      ask = h.confirms.find((c) => c.message.includes('次呼叫'));
      callCount = fake.calls.length;
    } finally {
      settings.concurrency = 1;
    }
  });

  test('併發時確實重疊了模型請求', () => {
    assert.ok(callsPeak > 1, `峰值 ${callsPeak}`);
  });

  test('併發不超過配置值', () => {
    assert.ok(callsPeak <= 3, `峰值 ${callsPeak}`);
  });

  test('diff 審閱仍然一次只彈一張', () => {
    assert.equal(reviewPeak, 1, `峰值 ${reviewPeak}`);
  });

  test('每張卡都審閱到了', () => {
    assert.equal(reviewedCount, 2, String(reviewedCount));
  });

  test('確認框寫明併發', () => {
    assert.ok(
      firstConfirm && firstConfirm.detail.includes('併發 2 張'),
      firstConfirm && firstConfirm.detail
    );
  });

  test('逐張確認時說明 diff 會排隊', () => {
    assert.ok(
      firstConfirm && firstConfirm.detail.includes('一張一張彈出'),
      firstConfirm && firstConfirm.detail
    );
  });

  test('兩張卡都寫盤了', () => {
    assert.ok(linCard.includes('併發審閱'));
  });

  test('併發不改變預計呼叫次數', () => {
    assert.ok(ask && ask.message.includes(batchCalls(callCount)), ask && ask.message);
  });
});

describe('給未建卡的人全部建卡', () => {
  let ask;
  let confirmMessages;
  let pending;
  let cancelCallCount;
  let noEmptyCard;
  let bothCreated;
  let boatmanCard;
  let reviewedCount;
  let callsPeak;
  let doneToasts;
  let index;
  let idleConfirms;
  let idleToasts;

  before(async () => {
    // 造兩個還沒有卡的人物，各出場兩章。
    makePlot(9, '渡船', ['艄公', '貨郎']);
    makePlot(10, '雨歇', ['艄公', '貨郎']);
    project.invalidate();

    // ---- 取消：一次模型都不調。
    expect(undefined);
    setReplies([cardJson()]);
    await cardMod.createCardsForAllCast(project);
    ask = h.confirms.find((c) => c.message.includes('次呼叫'));
    confirmMessages = h.confirms.map((c) => c.message);
    // 未建卡的人不止這兩位（沈氏一直沒建卡），所以報數按實際人數對，
    // 而不是釘死一個數字——重要的是「說的人數 = 列出的人數」。
    pending = await castMod.buildCastIndex(project).then((idx) => idx.unknown.length);
    cancelCallCount = fake.calls.length;
    noEmptyCard = !fs.existsSync(t.rel('.novelwarden/characters/艄公.md'));

    // ---- 真跑：併發建卡，新卡不走 diff。
    settings.concurrency = 3;
    try {
      expect('開始建卡');
      setReplies([cardJson({ 身份: '批次建出來的' })]);
      await cardMod.createCardsForAllCast(project);

      bothCreated =
        fs.existsSync(t.rel('.novelwarden/characters/艄公.md')) &&
        fs.existsSync(t.rel('.novelwarden/characters/貨郎.md'));
      boatmanCard = t.read('.novelwarden/characters/艄公.md');
      reviewedCount = h.reviewed.length;
      callsPeak = fake.peak();
      doneToasts = [...h.toasts];

      project.invalidate();
      index = await castMod.buildCastIndex(project);
    } finally {
      settings.concurrency = 1;
    }

    // ---- 人都建過了：不彈確認框，直接說明。
    expect();
    await cardMod.createCardsForAllCast(project);
    idleConfirms = h.confirms.map((c) => c.message);
    idleToasts = [...h.toasts];
  });

  test('批次建卡動手前問過使用者', () => {
    assert.ok(!!ask, JSON.stringify(confirmMessages));
  });

  test('確認框報清人數', () => {
    assert.ok(
      ask && ask.message.includes(`給 ${pending} 位未建卡的人物建卡`),
      ask && ask.message
    );
  });

  test('確認框列出是哪幾位', () => {
    assert.ok(ask && ask.detail.includes('艄公') && ask.detail.includes('貨郎'), ask && ask.detail);
  });

  test('使用者取消則不調模型', () => {
    assert.equal(cancelCallCount, 0, String(cancelCallCount));
  });

  test('取消時不留下空卡', () => {
    assert.ok(noEmptyCard);
  });

  test('兩張新卡都建出來了', () => {
    assert.ok(bothCreated);
  });

  test('新卡填上了模型產出', () => {
    assert.ok(boatmanCard.includes('批次建出來的'));
  });

  test('新卡帶出場章節', () => {
    assert.ok(boatmanCard.includes('appearsIn: [9, 10]'), boatmanCard.slice(0, 200));
  });

  test('批次建卡不走 diff 審閱', () => {
    assert.equal(reviewedCount, 0, String(reviewedCount));
  });

  test('併發時確實重疊了模型請求', () => {
    assert.ok(callsPeak > 1, `峰值 ${callsPeak}`);
  });

  test('完成提示報數', () => {
    assert.ok(doneToasts.some((x) => x.includes(`已建 ${pending} 張`)), doneToasts.join(' | '));
  });

  test('建完後未建卡列表裡沒有他們', () => {
    assert.ok(
      !index.unknown.some((m) => m.name === '艄公' || m.name === '貨郎'),
      index.unknown.map((m) => m.name).join('、')
    );
  });

  test('沒人可建時不彈確認框', () => {
    assert.equal(idleConfirms.length, 0, JSON.stringify(idleConfirms));
  });

  test('沒人可建時明說', () => {
    assert.ok(idleToasts.some((x) => x.includes('都已經有角色卡')), idleToasts.join(' | '));
  });
});
