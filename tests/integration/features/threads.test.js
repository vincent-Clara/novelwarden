/**
 * 敘事線（2026-10-20 重做）：工程頁「從大綱排出」（排線）。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 沒有情節大綱時不調模型 | 第 4 條：沒有東西可排就不花錢 |
 * | 確認框報 2 次呼叫（排 1 次、轉寫 1 次，最多 3 次）與檔位，說清已有的不動、主線已有就不再排 | 第 4 條：動手之前寫明 |
 * | 一條線一個新檔案，伏筆寫線上下；已有的、作者寫的一個字不動 | 第 3 條、第 19 條的批次路徑 |
 * | 同名跳過；種類不是四種之一、主線重複、區間越界的不收，提示裡分開說 | 設計稿：種類定死四種、主線全書一條；第 2 條 |
 * | 伏筆與全書已有的重名跳過，章號不合理的只去掉章號 | 同一樣東西只有一份 |
 * | 提示裡有配置、前提、角色圖譜（含暗設，老卡的「未收伏筆」不讀）、情節大綱與已有的線和伏筆，**不讀細綱** | 線在大綱這一層排，細綱反過來照著線排 |
 * | 解析不出來掛紅 ❗、檔案不動；成了清掉 | 第 16 條 |
 *
 * 定稿第三步（認事件 / 歸併 / 當前進度）：
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 認事件每次都跑（線是空的也跑），歸併、當前進度按需 0–1 次 | 設計稿 ⚑6：正文裡長出來的線只能在這裡認出來；第 4 條 |
 * | 提示裡有本章計劃（只讀各條線裡這一章的計劃事件；老細綱裡的「新增伏筆」不讀）、沒收束的線（帶現在走到哪）、沒收的伏筆 | 設計稿「三、a」；二期細綱刪了「新增伏筆」 |
 * | 證據逐字找得到的才記，按章號插在那條線下；作者的行、計劃事件不動 | 沒有原文撐著的事件多半是編的；第 3 條 |
 * | 新線一條一個新檔案（來源：正文），掛不上線的新伏筆進「未歸屬的伏筆」 | 線從正文裡長出來；能掛就掛 |
 * | 當前進度：機器的換寫並蓋章，作者改過的不覆蓋、線上掛黃 ❗ | 照角色卡「當前狀態」；第 19 條的例外 |
 * | 收了的線不送、模型提了也不記；重新定稿不重複記，證據已經不在正文裡的這一章舊事件清掉 | 設計稿 ⚑7 |
 * | 歸併：新認出的其實是已有的那一條，不另建 | 同一樣東西只有一份 |
 * | 認事件失敗整步沒成，當前進度沒成只算部分完成；都掛黃 ❗ 在章節上 | 第 16 條 |
 *
 * 工程頁「標為收束 / 放棄」（2026-10-24）：
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 先問一句，取消不寫；記在最近一次有動靜的那一章、同章寫在最後，只追加一行；不帶證據，重新同步不清掉 | 同步漏報的收束後面補不回來，作者補一筆；第 3 條 |
 * | 還沒發生過事的只能放棄，記在敘事線判到的那一章；已經收了的不再記 | 沒開始的線談不上收束 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, TIME_MARK, timeReply } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');
const { outlineOf, writeOutline } = require('../../helpers/outline');

let bundle;
let h;
let fake;
let t;
let project;
/** 排線那一次答什麼。 */
let planReply;

/** 敘事線目錄：一條線一個檔案。 */
const THREADS = '.novelwarden/threads';
const file = (name) => `${THREADS}/${name}.md`;
/** 目錄裡有哪幾條線（檔名）。 */
const names = () => (t.has(THREADS) ? require('fs').readdirSync(t.rel(THREADS)).sort() : []);

/** 寫一份還沒定稿的細綱（計劃）：七節裡只填幾節，鉤子寫在「看點」裡。 */
function plot(no, title, events, highlight) {
  t.write(
    `.novelwarden/summaries/00${no}-${title}.md`,
    `---\nno: ${no}\ntitle: ${title}\ntargetWords: 3000\n---\n\n# 第${no}章 ${title}\n\n## 梗概\n\n第${no}章的梗概\n\n## 關鍵事件\n\n${events}\n\n## 看點\n\n- ${highlight}\n`
  );
}

/** 排線的系統提示裡認得出的那一句。 */
const PLAN_MARK = '只從作者給的小說配置、故事前提、角色圖譜與情節大綱裡排出這本書的敘事線';

function reply(messages) {
  const system = messages[0]?.content ?? '';
  if (system.includes(PLAN_MARK)) {
    return planReply(messages);
  }
  // 故事時間（同步時單獨一次，2026-10-24 重做）：都緊接上一章。
  if ((messages[0]?.content ?? '').includes(TIME_MARK)) {
    return timeReply(messages);
  }
  return '（認不出這一步）';
}

async function failuresOf(key) {
  return (await bundle.errorLog.listActiveFailures(project))[key] ?? [];
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    threads: './src/core/features/threads.ts',
    finalize: './src/core/features/finalize.ts',
    threadFile: './src/core/model/threadFile.ts',
    errorLog: './src/core/runtime/errorLog.ts',
    logger: './src/core/runtime/logger.ts',
    db: './src/core/runtime/db.ts',
  });
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, { reply });
  t = await makeTempProject(bundle.project, { prefix: 'threads', title: '青雲劍錄' });
  project = t.project;
});

after(() => {
  if (t) cleanup(t.dir, bundle?.db);
});

describe('排敘事線 · 還沒有情節大綱', () => {
  // 情節大綱是各章細綱梗概的彙總：細綱排了、梗概卻空著，大綱裡就沒有這一章。
  test('不調模型、不彈確認框，說清先排大綱（細綱排了、梗概空著也不算）', async () => {
    t.write('.novelwarden/summaries/001-雪夜.md', '---\nno: 1\ntitle: 雪夜\n---\n\n# 第1章 雪夜\n\n## 關鍵事件\n\n林昭在雪夜裡被人追殺。\n');
    project.invalidate();
    h.expect('開始排');
    fake.reset();
    assert.equal(await bundle.threads.generateThreads(project), 0);
    assert.equal(fake.callCount(), 0);
    assert.equal(h.confirms.length, 0);
    assert.ok(h.toasts.some((x) => x.includes('先排出情節大綱')), h.toasts.join('|'));
  });
});

/** 作者手寫的一條主線：帶一條伏筆。 */
const HAND = [
  '---',
  'kind: 主線',
  'plan: 1-20',
  '---',
  '',
  '# 青雲舊案',
  '',
  '## 意圖',
  '十年前那把火是誰放的。',
  '',
  '## 伏筆',
  '- 火摺子：現場留下的火摺子',
  '',
  '## 進展',
  '- 作者自己加的備註',
  '',
].join('\n');

const OUTLINE = outlineOf(20, { titles: { 1: '入宗' }, text: { 1: '林昭揹著舊案入宗，與沈青從猜忌到並肩，查出當年放火的人。' } });

describe('排敘事線', () => {
  let returned;
  let confirm;
  let user;
  let system;

  before(async () => {
    t.write(
      '.novelwarden/config.md',
      '---\ngenre: 玄幻\ntotalChapters: 20\nwordsPerChapter: 3000\n---\n# 設定\n\n## 一句話\n\n少年揹著舊案入宗。\n'
    );
    t.write('.novelwarden/premise.md', '# 故事前提\n\n## 懸念骨架\n\n誰放的那把火。\n');
    writeOutline(t, OUTLINE);
    t.write(
      '.novelwarden/characters/沈青.md',
      '---\nname: 沈青\n---\n\n# 沈青\n\n## 身份\n\n青雲宗外門弟子\n\n## 人物關係\n\n與林昭互相猜忌\n\n## 暗設\n\n她是沈家遺孤\n'
    );
    // 老卡（敘事線重做第 10 個提交之前）：「未收伏筆」是認不出的小節，排線不讀。
    t.write(
      '.novelwarden/characters/李叔.md',
      '---\nname: 李叔\n---\n\n# 李叔\n\n## 身份\n\n鎮口守衛\n\n## 未收伏筆\n\n他認得那塊令牌\n'
    );
    plot(2, '入宗', '林昭拜入青雲宗。', '有人認出了他');
    t.write(file('青雲舊案'), HAND);
    project.invalidate();
    planReply = () =>
      '```json\n' +
      JSON.stringify({
        threads: [
          { title: '青雲 舊案', kind: '主线', intent: '換個說法再提一遍' },
          {
            title: '林昭與沈青',
            kind: '感情线',
            from: 3,
            to: 18,
            intent: '從互相猜忌到並肩。',
            foreshadowing: [
              { title: '玉佩的來歷', what: '林昭的玉佩是沈家舊物', plant: 3, resolve: 18 },
              { title: '火 摺子', what: '與已有的重名' },
              { title: '沈青的舊傷', what: '舊傷', plant: 25 },
            ],
          },
          { title: '執法堂', kind: '支线', from: 2, to: 30, intent: '超出全書章數' },
          { title: '宗門大比', kind: '主线', intent: '主線已經有了' },
          { title: '斷劍之謎', kind: '懸念', intent: '種類不對' },
          { title: '林昭的成長', kind: '人物线', intent: '從復仇到放下。' },
        ],
      }) +
      '\n```';
    fake.reset();
    h.expect('開始排');
    returned = await bundle.threads.generateThreads(project);
    confirm = h.confirms[0];
    const call = fake.calls[0];
    system = call[0].content;
    user = call[call.length - 1].content;
  });

  // 2026-10-25 起排線也轉寫：排 1 次、轉寫 1 次，轉寫不合格重轉 1 次；轉寫那一檔單列一行。模型直接給了 JSON 就不轉（這裡只調 1 次）。
  test('確認框報 2 次呼叫（最多 3 次）、哪一檔、轉寫單列，已有的不動、主線已有就不再排', () => {
    assert.ok(confirm.message.includes('要從情節大綱排出敘事線，預計 2 次呼叫，最多 3 次（排 1 次、轉寫模型照抄成 JSON 1 次'), confirm.message);
    assert.ok(confirm.call.tiers.join('\n').includes('劇情細綱'), confirm.call.tiers.join('\n'));
    assert.ok((confirm.call.fixed ?? []).join('\n').includes('不跟這一次挑的模型'), JSON.stringify(confirm.call));
    assert.ok(confirm.detail.includes('已有的 1 條不會改動') && confirm.detail.includes('主線已經有了'), confirm.detail);
    assert.equal(returned, 1);
    assert.equal(fake.callCount(), 1);
  });

  test('提示裡有配置、前提、角色圖譜（含暗設，老卡的「未收伏筆」不讀）、情節大綱、已有的線與伏筆；不讀細綱', () => {
    assert.ok(system.includes('1–20 之間的整數'), system);
    assert.ok(system.includes('已經有了，這一次不要再排主線'), system);
    for (const s of ['少年揹著舊案入宗', '誰放的那把火', '與沈青從猜忌到並肩', '- 沈青（青雲宗外門弟子）', '與林昭互相猜忌', '暗設（讀者還不知道）：她是沈家遺孤']) {
      assert.ok(user.includes(s), s);
    }
    assert.ok(user.includes('- 李叔（鎮口守衛）') && !user.includes('他認得那塊令牌') && !user.includes('未收伏筆'), user);
    assert.ok(user.includes('【已有的敘事線（不要重複）】\n- 青雲舊案（主線 · 計劃第 1–20 章）意圖：十年前那把火是誰放的。'), user);
    assert.ok(user.includes('【已有的伏筆（不要重複）】\n火摺子'), user);
    assert.ok(!user.includes('有人認出了他') && !user.includes('拜入青雲宗'), '細綱不讀');
  });

  test('一條線一個新檔案，伏筆寫線上下；作者寫的那條一個字不動', async () => {
    assert.equal(t.read(file('青雲舊案')), HAND);
    assert.deepEqual(names(), ['林昭與沈青.md', '林昭的成長.md', '青雲舊案.md'].sort());
    const { threads: list } = await project.readThreads();
    const by = Object.fromEntries(list.map((x) => [x.name, x]));
    const pair = by['林昭與沈青'];
    assert.deepEqual([pair.kind, pair.origin, pair.from, pair.to, pair.intent], ['感情线', '计划', 3, 18, '從互相猜忌到並肩。']);
    assert.deepEqual(pair.foreshadowing, [
      { name: '玉佩的來歷', what: '林昭的玉佩是沈家舊物', plant: 3, resolve: 18 },
      { name: '沈青的舊傷', what: '舊傷' },
    ]);
    assert.deepEqual([by['林昭的成長'].kind, by['林昭的成長'].from, by['林昭的成長'].to], ['人物线', undefined, undefined]);
  });

  test('提示裡說清排出幾條線、幾條伏筆，跳過與不合格分開說，並開啟第一條', () => {
    const done = h.toasts.find((x) => x.includes('排出 2 條敘事線、2 條伏筆'));
    assert.ok(done, h.toasts.join('|'));
    assert.ok(done.includes('同名跳過 1 條') && done.includes('3 條不合格沒收'), done);
    assert.deepEqual(h.opened, [file('林昭與沈青')]);
  });
});

describe('排敘事線 · 失敗與取消', () => {
  test('作者取消：不調模型', async () => {
    fake.reset();
    h.expect('算了');
    assert.equal(await bundle.threads.generateThreads(project), 0);
    assert.equal(fake.callCount(), 0);
  });

  test('解析不出來：掛紅 ❗、檔案不動；再排一次成了就清掉', async () => {
    const before = names();
    planReply = () => '我覺得可以寫幾條伏筆。';
    fake.reset();
    h.expect('開始排');
    assert.equal(await bundle.threads.generateThreads(project), 1);
    assert.deepEqual(names(), before);
    const [f] = await failuresOf(THREADS);
    assert.equal(f?.severity, 'error');
    assert.match(f.message, /排敘事線失敗/);
    assert.ok(h.erred());

    planReply = () => JSON.stringify({ threads: [{ title: '新的一條', kind: '支线', from: 4, to: 6, intent: '意图' }] });
    fake.reset();
    h.expect('開始排');
    await bundle.threads.generateThreads(project);
    assert.deepEqual(await failuresOf(THREADS), []);
    assert.deepEqual(names(), [...before, '新的一條.md'].sort());
  });

  test('一條都不合格也算失敗，不寫檔案', async () => {
    const before = names();
    planReply = () => JSON.stringify({ threads: [{ title: '林昭的成長', kind: '人物线', intent: '重名' }] });
    fake.reset();
    h.expect('開始排');
    await bundle.threads.generateThreads(project);
    assert.deepEqual(names(), before);
    assert.match((await failuresOf(THREADS))[0]?.message ?? '', /都不合格/);
  });
});

// ---------------------------------------------------------------- 定稿第三步

const CH4 = 'chapters/004-夜談.md';
const CH4_TEXT = [
  '夜裡，沈青坐在廊下，把那塊玉佩翻過來，背面刻著一個小小的沈字。',
  '林昭看著她，忽然明白那塊玉佩原來是沈家的舊物。',
  '從今往後，他不再疑她。',
  '院外有人提著燈走過，腳步很輕。',
].join('\n\n');

/** 認事件、歸併、當前進度那三次各答什麼。 */
let findReply;
let mergeReply;
let progressReply;

const FIND_MARK = '你是小說定稿事實審查員';
const MERGE_MARK = '判斷它們是不是已有的某一條換了個說法';
const PROGRESS_MARK = '給每一條寫一兩句「當前進度」';

/** 定稿那幾步的應答：更新細綱（有計劃時是 REFINE_SYSTEM，它包著 SUMMARY_SYSTEM）、敘事線三段，其餘照排線。 */
function finalizeReply(messages) {
  const system = messages[0]?.content ?? '';
  if (system.includes('建立可檢索的章節檔案')) {
    return JSON.stringify({
      梗概: '沈青與林昭夜談，玉佩的來歷揭開。',
      出场人物: [{ name: '林昭', aliases: [] }, { name: '沈青', aliases: [] }],
      时间地点: '青雲宗，夜。',
      关键事件: ['夜談'],
      状态变更: '',
      连续性事实: ['玉佩背面刻著沈字'],
    });
  }
  if (system.includes(FIND_MARK)) {
    return findReply(messages);
  }
  if (system.includes(MERGE_MARK)) {
    return mergeReply(messages);
  }
  if (system.includes(PROGRESS_MARK)) {
    return progressReply(messages);
  }
  return reply(messages);
}

async function chapter4() {
  project.invalidate();
  return (await project.listChapters()).find((c) => c.order === 4);
}

/** 最近那一次帶這句系統提示的呼叫的使用者訊息。 */
const userOf = (mark) => {
  const call = fake.calls.findLast((c) => c[0].content.includes(mark));
  return call ? call[call.length - 1].content : '';
};

/** 一條感情線：當前進度是機器寫的（指紋對得上），玉佩那條伏筆第 1 章埋下、計劃第 4 章收。 */
function pairFile() {
  return bundle.threadFile.patchProgress(
    [
      '---',
      'kind: 感情線',
      'plan: 3-18',
      '---',
      '',
      '# 林昭與沈青',
      '',
      '## 意圖',
      '從互相猜忌到並肩。',
      '',
      '## 當前進度',
      '',
      '## 伏筆',
      '- 玉佩的來歷：林昭的玉佩是沈家舊物（計劃第 1 章埋、第 4 章前收）',
      '',
      '## 進展',
      '- 第 1 章 · 埋〈玉佩的來歷〉：玉佩露面 〔證據：「懷裡揣著一塊玉佩」〕',
      '- 第 4 章 · 計劃 · 收〈玉佩的來歷〉：揭開玉佩的來歷',
      '- 作者自己加的備註',
      '',
    ].join('\n'),
    '兩人剛結識，互相提防。',
    3
  );
}

function writeThreads() {
  t.remove(THREADS);
  t.write(file('林昭與沈青'), pairFile());
  // 作者自己寫的當前進度（沒有指紋）：機器不覆蓋。
  t.write(file('斷劍之謎'), '---\nkind: 支線\nplan: 3-9\n---\n\n# 斷劍之謎\n\n## 意圖\n斷劍裡的字是誰刻的。\n\n## 當前進度\n作者寫的進度。\n');
  t.write(file('已經收了'), '---\nplan: 1-2\n---\n\n# 已經收了\n\n## 進展\n- 第 2 章 · 收束：收了 〔證據：「x」〕\n');
  project.invalidate();
}

describe('定稿 · 敘事線：認事件、歸併、當前進度', () => {
  let outcome;
  let findUser;

  before(async () => {
    plot(4, '夜談', '沈青與林昭夜談，玉佩的來歷揭開。', '院外有人');
    // 二期細綱刪了「新增伏筆」：老細綱裡留著的那一節當認不出的小節，定稿時不讀、不當本章計劃。
    t.write(
      '.novelwarden/summaries/004-夜談.md',
      t.read('.novelwarden/summaries/004-夜談.md').replace('## 看點', '## 新增伏筆\n\n- 院外的提燈人\n\n## 看點')
    );
    t.write(CH4, `# 第4章 夜談\n\n${CH4_TEXT}\n`);
    // 出場的人都沒有卡：角色狀態那一步不調，次數好數。
    t.remove('.novelwarden/characters');
    writeThreads();
    findReply = () =>
      JSON.stringify({
        events: [
          { line: '林昭與沈青', type: '推进', what: '兩人夜談', evidence: '沈青坐在廊下' },
          { line: '林昭與沈青', type: '收', foreshadowing: '玉佩的來歷', what: '玉佩是沈家舊物', evidence: '那塊玉佩原來是沈家的舊物' },
          { line: '林昭與沈青', type: '关系', what: '林昭—沈青，猜忌 → 信任', evidence: '從今往後，他不再疑她' },
          { line: '斷劍之謎', type: '推进', what: '編的', evidence: '斷劍上刻著一行小字' },
          { line: '已經收了', type: '推进', what: '收了的線', evidence: '院外有人提著燈走過' },
          { line: '斷劍之謎', type: '推进', what: '院外有人', evidence: '院外有人提著燈走過' },
        ],
        newThreads: [{ title: '沈家舊案', kind: '支线', intent: '沈家當年出了什麼事。', evidence: '背面刻著一個小小的沈字' }],
        newForeshadowing: [{ title: '提燈人', what: '院外提燈的人是誰', evidence: '腳步很輕' }],
      });
    mergeReply = () => JSON.stringify({ merges: [] });
    // 線名帶著種類回來（試跑裡真模型就是這麼回的）：照樣認得出。
    progressReply = () =>
      JSON.stringify({
        progress: [
          { line: '林昭與沈青（感情線）', text: '夜談之後兩人互相信任，玉佩的來歷已經揭開。' },
          { line: '「沈家舊案」', text: '玉佩上的沈字露了面。' },
          { line: '斷劍之謎', text: '不該寫的那一條。' },
        ],
      });
    fake = installFakeProvider(bundle.registry, { reply: finalizeReply });
    outcome = await bundle.finalize.finalizeChapter(project, await chapter4());
    findUser = userOf(FIND_MARK);
  });

  test('次數：更新細綱 1 + 認事件 1 + 歸併 1 + 當前進度 1 + 故事時間 1', () => {
    assert.equal(outcome.calls, 5);
    assert.equal(outcome.threads.calls, 3);
  });

  test('判過一章就記進 project.json（四期）：前三章還沒判，第 4 章記在水位之後，水位不動', async () => {
    const m = await project.readManifest();
    assert.equal(m.threadsThrough ?? 0, 0);
    assert.deepEqual(m.threadsJudged, [4]);
    assert.deepEqual(await project.readThreadsMark(), { through: 0, judged: [4] });
  });

  test('認事件的提示：本章計劃（只讀線裡的計劃事件，老細綱的新增伏筆不讀）、沒收束的線（帶現在走到哪）、沒收的伏筆；收了的線不送', () => {
    assert.ok(findUser.includes('- 林昭與沈青：收〈玉佩的來歷〉——揭開玉佩的來歷'), findUser);
    assert.ok(!findUser.includes('新增伏筆') && !findUser.includes('院外的提燈人'), findUser);
    assert.ok(findUser.includes('- 林昭與沈青（感情線 · 進行中 · 計劃第 3–18 章）意圖：從互相猜忌到並肩。；現在：兩人剛結識，互相提防。'), findUser);
    assert.ok(findUser.includes('- 玉佩的來歷（掛在「林昭與沈青」· 已埋 · 計劃第 4 章前收）'), findUser);
    assert.ok(findUser.includes('- 斷劍之謎（支線 · 計劃中 · 計劃第 3–9 章）'), findUser);
    assert.ok(!findUser.includes('已經收了'), findUser);
    assert.ok(findUser.includes('林昭看著她'), findUser);
  });

  test('證據逐字找得到的追加到對的線下（按章號插），作者的行與計劃事件不動', () => {
    const text = t.read(file('林昭與沈青'));
    assert.ok(text.includes('- 第 4 章 · 計劃 · 收〈玉佩的來歷〉：揭開玉佩的來歷\n- 作者自己加的備註\n- 第 4 章 · 推進：兩人夜談 〔證據：「沈青坐在廊下」〕'), text);
    assert.ok(text.includes('- 第 4 章 · 收〈玉佩的來歷〉：玉佩是沈家舊物 〔證據：「那塊玉佩原來是沈家的舊物」〕'), text);
    assert.ok(text.includes('- 第 4 章 · 關係：林昭—沈青，猜忌 → 信任 〔證據：「從今往後，他不再疑她」〕'), text);
    const state = bundle.threadFile.foreshadowingOf(bundle.threadFile.parseThreadFile(text, file('林昭與沈青')), 4);
    assert.deepEqual(state.map((f) => [f.name, f.status]), [['玉佩的來歷', '已收']]);
  });

  test('正文裡認出的新線：一條一個新檔案，來源是正文，認出它的那一句記成第一條事件', async () => {
    const { threads } = await project.readThreads();
    const fresh = threads.find((x) => x.name === '沈家舊案');
    assert.deepEqual([fresh.kind, fresh.origin, fresh.intent], ['支线', '正文', '沈家當年出了什麼事。']);
    assert.deepEqual(fresh.events.map((e) => [e.chapter, e.type, e.evidence]), [[4, '推进', '背面刻著一個小小的沈字']]);
  });

  test('掛不上線的新伏筆進「未歸屬的伏筆」，記一條埋', () => {
    const u = bundle.threadFile.parseUnfiledFile(t.read(file('未归属的伏笔')), file('未归属的伏笔'));
    assert.deepEqual(u.foreshadowing, [{ name: '提燈人', what: '院外提燈的人是誰' }]);
    assert.deepEqual(u.events.map((e) => [e.type, e.foreshadowing, e.evidence]), [['埋', '提燈人', '腳步很輕']]);
  });

  test('當前進度：機器的那幾條換成這一章的、蓋章；作者寫的不覆蓋、線上掛黃 ❗', async () => {
    const { threads } = await project.readThreads();
    const by = Object.fromEntries(threads.map((x) => [x.name, x]));
    assert.equal(by['林昭與沈青'].progress, '夜談之後兩人互相信任，玉佩的來歷已經揭開。');
    assert.equal(by['林昭與沈青'].progressThrough, 4);
    assert.ok(bundle.threadFile.progressOwnedByMachine(by['林昭與沈青']));
    assert.equal(by['沈家舊案'].progress, '玉佩上的沈字露了面。');
    assert.equal(by['斷劍之謎'].progress, '作者寫的進度。');
    assert.deepEqual(outcome.threads.guarded, ['斷劍之謎']);
    const [f] = await failuresOf(file('斷劍之謎'));
    assert.equal(f?.severity, 'warn');
    assert.equal(f.op, 'threadProgress');
    const progressUser = userOf(PROGRESS_MARK);
    assert.ok(progressUser.includes('【線】林昭與沈青\n種類：感情線\n意圖：從互相猜忌到並肩。\n原來的當前進度：兩人剛結識，互相提防。'), progressUser);
    assert.ok(!progressUser.includes('林昭與沈青（'), '線名不和種類粘在一起');
    assert.ok(!progressUser.includes('【人物】'), '沒有角色卡就不列');
    assert.ok(!progressUser.includes('斷劍之謎'), progressUser);
    assert.deepEqual(outcome.threads.unwritten, []);
  });

  test('編的證據、收了的線不記；完成提示裡一定說敘事線', () => {
    assert.deepEqual(
      outcome.threads.dropped.map((d) => [d.what, d.why]),
      [
        ['斷劍之謎', '證據在正文裡找不到'],
        ['已經收了', '這條線已經收束，或這一次沒送去認'],
      ]
    );
    const said = bundle.finalize.describeFinalize(4, outcome);
    for (const s of ['林昭與沈青推進、關係', '斷劍之謎推進', '收〈玉佩的來歷〉', '埋〈提燈人〉', '新認出 1 條線〈沈家舊案〉（支線）', '斷劍之謎的當前進度你改過', '另有 2 條敘事線的記錄沒有收']) {
      assert.ok(said.includes(s), `${s}｜${said}`);
    }
  });

  test('重新定稿：同一句不重複記；證據已經不在正文裡的這一章舊事件清掉（舊版存進歷史）', async () => {
    // 作者刪了「從今往後」那一句；模型這一次只給了同一句推進。
    t.write(CH4, `# 第4章 夜談\n\n${CH4_TEXT.replace('從今往後，他不再疑她。', '他仍舊看著她。')}\n`);
    findReply = () =>
      JSON.stringify({ events: [{ line: '林昭與沈青', type: '推进', what: '換個說法', evidence: '沈青坐在廊下。' }], newThreads: [], newForeshadowing: [] });
    progressReply = () => JSON.stringify({ progress: [] });
    const again = await bundle.finalize.finalizeChapter(project, await chapter4());
    const text = t.read(file('林昭與沈青'));
    assert.equal(again.threads.pruned, 1);
    assert.ok(!text.includes('從今往後'), text);
    assert.equal((text.match(/沈青坐在廊下/g) ?? []).length, 1, text);
    assert.ok(text.includes('收〈玉佩的來歷〉'), '證據還在的不動');
    assert.ok(t.has('.novelwarden/history/.novelwarden/threads/林昭與沈青.md'), '改之前存了一版歷史');
    assert.ok(bundle.finalize.describeFinalize(4, again).includes('清掉 1 條證據已經不在正文裡的舊記錄'));
  });

  test('歸併：新認出的其實是已有的那一條，不另建，事件掛到已有的那條上', async () => {
    findReply = () =>
      JSON.stringify({
        events: [],
        newThreads: [{ title: '沈家的舊案', kind: '支线', intent: '換個說法', evidence: '背面刻著一個小小的沈字' }],
        newForeshadowing: [],
      });
    mergeReply = () => JSON.stringify({ merges: [{ new: '沈家的舊案', into: '沈家舊案', reason: '同一樁舊案換了個說法' }] });
    const merged = await bundle.finalize.finalizeChapter(project, await chapter4());
    // 新線這一章沒帶來任何事件：並進去了，但如實說沒記什麼（不替它編一條推進）。
    assert.deepEqual(merged.threads.merged, [{ kind: 'thread', from: '沈家的舊案', into: '沈家舊案', reason: '同一樁舊案換了個說法', note: '這一章沒有另記事件' }]);
    assert.ok(!t.has(file('沈家的舊案')));
    assert.ok(userOf(MERGE_MARK).includes('- 沈家的舊案（支線）換個說法'));
    assert.ok(bundle.finalize.describeFinalize(4, merged).includes('〈沈家的舊案〉並進了〈沈家舊案〉（這一章沒有另記事件）'));
  });

  // 試跑報告問題 2：新伏筆只寫在 newForeshadowing 裡、並進已有的以後，這一章的「埋」整條沒了，提示卻照樣說「並進了」。
  test('新伏筆並進已有的：還沒埋的那條記一條「埋」；已經埋過的不再記，完成提示照實說；新伏筆都不另登記', async () => {
    t.write(
      file('斷劍之謎'),
      '---\nkind: 支線\nplan: 3-9\n---\n\n# 斷劍之謎\n\n## 意圖\n斷劍裡的字是誰刻的。\n\n## 當前進度\n作者寫的進度。\n\n## 伏筆\n- 斷劍的刻字：斷劍上的字是誰刻的（計劃第 4 章埋）\n'
    );
    const before = t.read(file('林昭與沈青'));
    findReply = () =>
      JSON.stringify({
        events: [],
        newThreads: [],
        newForeshadowing: [
          { title: '沈字的來歷', what: '玉佩背面刻著沈字', line: '林昭與沈青', evidence: '背面刻著一個小小的沈字' },
          { title: '廊下的斷劍', what: '林昭想起斷劍上的字', line: '斷劍之謎', evidence: '林昭看著她，忽然明白' },
        ],
      });
    mergeReply = () =>
      JSON.stringify({
        merges: [
          { new: '沈字的來歷', into: '玉佩的來歷', reason: '玉佩的來歷就是沈家' },
          { new: '廊下的斷劍', into: '斷劍的刻字', reason: '斷劍上的字是誰刻的' },
        ],
      });
    const merged = await bundle.finalize.finalizeChapter(project, await chapter4());
    // 歸併的提示：兩邊都給「是什麼」與掛在哪條線（試跑：已有的只給了名字，約一半並錯）；已有的只給還沒收的。
    const mergeUser = userOf(MERGE_MARK);
    for (const s of [
      '【新認出的伏筆】\n- 沈字的來歷（掛在「林昭與沈青」）是什麼：玉佩背面刻著沈字',
      '- 玉佩的來歷（掛在「林昭與沈青」· 已埋）是什麼：林昭的玉佩是沈家舊物',
      '- 斷劍的刻字（掛在「斷劍之謎」· 計劃）是什麼：斷劍上的字是誰刻的',
    ]) {
      assert.ok(mergeUser.includes(s), `${s}｜${mergeUser}`);
    }
    const sword = t.read(file('斷劍之謎'));
    assert.ok(sword.includes('- 第 4 章 · 埋〈斷劍的刻字〉：林昭想起斷劍上的字 〔證據：「林昭看著她，忽然明白」〕'), sword);
    assert.equal(t.read(file('林昭與沈青')), before, '玉佩的來歷第 1 章已經埋下，不再記第二條「埋」');
    for (const name of ['沈字的來歷', '廊下的斷劍']) {
      assert.ok(!sword.includes(name) && !before.includes(name), name);
    }
    const said = bundle.finalize.describeFinalize(4, merged);
    for (const s of ['埋〈斷劍的刻字〉', '〈廊下的斷劍〉並進了〈斷劍的刻字〉；', '〈沈字的來歷〉並進了〈玉佩的來歷〉（〈玉佩的來歷〉第 1 章已經埋下，這一章不再記「埋」）']) {
      assert.ok(said.includes(s), `${s}｜${said}`);
    }
  });

  test('當前進度那一次沒成：認出來的照樣記下，黃 ❗ 掛在章節上說清是哪一段', async () => {
    t.write(CH4, `# 第4章 夜談\n\n${CH4_TEXT}\n`);
    findReply = () =>
      JSON.stringify({ events: [{ line: '林昭與沈青', type: '关系', what: '又信任了', evidence: '從今往後，他不再疑她' }], newThreads: [], newForeshadowing: [] });
    progressReply = () => '寫不出來。';
    const half = await bundle.finalize.finalizeChapter(project, await chapter4());
    assert.match(half.threads.progressError, /解析不出來/);
    assert.equal(half.threadsError, undefined);
    assert.ok(t.read(file('林昭與沈青')).includes('又信任了'));
    const [f] = await failuresOf(CH4);
    assert.equal(f?.severity, 'warn');
    assert.match(f.message, /敘事線記下了，但當前進度沒更新成/);
  });

  test('送去寫當前進度、模型沒寫上的線：日誌、完成提示裡說出來，黃 ❗ 掛在章節上（不靜默丟）', async () => {
    findReply = () =>
      JSON.stringify({
        events: [
          { line: '林昭與沈青', type: '推进', what: '林昭想明白了', evidence: '林昭看著她，忽然明白' },
          { line: '沈家舊案', type: '推进', what: '院外有人', evidence: '院外有人提著燈走過' },
        ],
        newThreads: [],
        newForeshadowing: [],
      });
    progressReply = () => JSON.stringify({ progress: [{ line: '林昭與沈青（感情線）', text: '林昭想明白了玉佩的來歷。' }] });
    bundle.logger.clearLogs();
    const some = await bundle.finalize.finalizeChapter(project, await chapter4());
    assert.deepEqual(some.threads.progressed, ['林昭與沈青']);
    assert.deepEqual(some.threads.unwritten, ['沈家舊案']);
    assert.ok(bundle.finalize.describeFinalize(4, some).includes('1 條線的當前進度沒寫上（沈家舊案'), bundle.finalize.describeFinalize(4, some));
    const logs = bundle.logger.recentLogs();
    assert.ok(logs.some((l) => l.message.includes('1 條線的當前進度沒寫上') && l.detail.includes('模型回的線名：林昭與沈青（感情線）')), JSON.stringify(logs));
    const [f] = await failuresOf(CH4);
    assert.equal(f?.severity, 'warn');
    assert.match(f.message, /1 條線的當前進度沒寫上（沈家舊案）/);
  });

  test('認事件失敗：細綱照樣更新了，黃 ❗ 掛在章節上，敘事線不動；再成了就清掉', async () => {
    const before = t.read(file('林昭與沈青'));
    findReply = () => '這一章沒什麼好說的。';
    const failed = await bundle.finalize.finalizeChapter(project, await chapter4());
    assert.ok(failed.summary);
    assert.match(failed.threadsError, /解析不出來/);
    assert.equal(failed.calls, 3);
    assert.equal(t.read(file('林昭與沈青')), before);
    const [f] = await failuresOf(CH4);
    assert.equal(f?.severity, 'warn');
    assert.equal(f.op, 'threads');
    assert.ok(bundle.finalize.describeFinalize(4, failed).includes('敘事線沒認成'));

    findReply = () => JSON.stringify({ events: [], newThreads: [], newForeshadowing: [] });
    const ok = await bundle.finalize.finalizeChapter(project, await chapter4());
    assert.equal(ok.threadsError, undefined);
    assert.deepEqual(await failuresOf(CH4), []);
    assert.ok(bundle.finalize.describeFinalize(4, ok).includes('敘事線沒有新進展'));
  });

  test('一條線都沒有也認（正文裡長出來的線只能在這裡認出來）：定稿最少 3 次（加故事時間）', async () => {
    t.remove(THREADS);
    project.invalidate();
    fake.reset();
    findReply = () => JSON.stringify({ events: [], newThreads: [], newForeshadowing: [] });
    const none = await bundle.finalize.finalizeChapter(project, await chapter4());
    assert.equal(none.calls, 3);
    assert.equal(none.threads.calls, 1);
    assert.ok(userOf(FIND_MARK).includes('【還沒收束的敘事線】\n（還沒有）'));
    assert.ok(bundle.finalize.describeFinalize(4, none).includes('敘事線沒有新進展'));
    // 什麼都沒認出：不建線的檔案；目錄裡只有同步時推出來的時間線（故事時間單獨一步，2026-10-24 重做）。
    assert.deepEqual(require('fs').readdirSync(require('path').join(t.dir, THREADS)), ['时间线.md']);
  });
});

// 2026-10-24：同步漏報了收束（第 7 章就走完了），後面幾十章都不會再補報，這條線一直掛「斷了 N 章」——作者在工程頁上補一筆。
describe('工程頁：作者標為收束 / 放棄', () => {
  /** 第 7 章其實已經走完的人物線：最後一條線的事件是推進，同一章收了它唯一的伏筆。 */
  const ODD = [
    '---',
    'kind: 人物線',
    '---',
    '',
    '# 異樣的目力',
    '',
    '## 意圖',
    '林昭能看見別人看不見的東西。',
    '',
    '## 伏筆',
    '- 目力的來歷：為什麼看得見',
    '',
    '## 進展',
    '- 第 2 章 · 埋〈目力的來歷〉：雪地裡看見腳印 〔證據：「他看見了雪下的腳印」〕',
    '- 第 7 章 · 推進：師父說這是正常的 〔證據：「這本是常事」〕',
    '- 第 7 章 · 收〈目力的來歷〉：師父說破了來歷 〔證據：「你娘也是這樣」〕',
    '',
  ].join('\n');
  const PLANNED = ['---', 'kind: 支線', 'plan: 30-40', '---', '', '# 北境商路', '', '## 意圖', '商路之爭。', ''].join('\n');
  const statusOf = async (name) => {
    project.invalidate();
    const line = (await project.readThreads()).threads.find((x) => x.name === name);
    return bundle.threadFile.threadStatus(line);
  };

  before(async () => {
    t.write(file('異樣的目力'), ODD);
    t.write(file('北境商路'), PLANNED);
    await project.writeManifest({ ...(await project.readManifest()), threadsThrough: 82 });
    project.invalidate();
  });

  test('取消不寫；標為收束：記在最近一次有動靜的那一章，同章寫在最後，狀態變成已收束', async () => {
    assert.equal(await statusOf('異樣的目力'), '进行中');
    h.confirms.length = 0;
    await bundle.threads.markThreadEnded(project, file('異樣的目力'), '收束');
    assert.equal(t.read(file('異樣的目力')), ODD, '沒答就是取消，檔案不動');
    assert.match(h.confirms[0].message, /異樣的目力/);
    assert.match(h.confirms[0].detail, /第 7 章/);
    assert.match(h.confirms[0].detail, /不調模型/);

    h.expect('標為收束');
    await bundle.threads.markThreadEnded(project, file('異樣的目力'), '收束');
    const text = t.read(file('異樣的目力'));
    assert.equal(text, `${ODD}- 第 7 章 · 收束：作者標為收束\n`, '只追加一行，別的位元組不動');
    assert.equal(await statusOf('異樣的目力'), '已收束');
    // 不帶證據：重新同步第 7 章、正文裡找不到也不清掉它。
    assert.equal(bundle.threadFile.pruneChapterEvents(text, 7, '正文全改了').text.includes('作者標為收束'), true);

    h.toasts.length = 0;
    await bundle.threads.markThreadEnded(project, file('異樣的目力'), '放弃');
    assert.ok(h.toasts.some((x) => x.includes('已經是「已收束」了')), h.toasts.join('|'));
  });

  test('還沒發生過事的線標不了收束，只能放棄，記在敘事線判到的那一章', async () => {
    h.toasts.length = 0;
    await bundle.threads.markThreadEnded(project, file('北境商路'), '收束');
    assert.equal(t.read(file('北境商路')), PLANNED);
    assert.ok(h.toasts.some((x) => x.includes('標不了收束')), h.toasts.join('|'));

    h.expect('標為放棄');
    await bundle.threads.markThreadEnded(project, file('北境商路'), '放弃');
    assert.match(t.read(file('北境商路')), /## 進展\n\n- 第 82 章 · 放棄：作者標為放棄\n/);
    assert.equal(await statusOf('北境商路'), '已放弃');
  });
});

// 2026-10-24：未歸屬的伏筆在某一章被收了，模型說它在哪條送去認的線上——整條（伏筆那一行與它的全部事件）挪過去。
describe('定稿 · 未歸屬的伏筆被收時挪到線上', () => {
  const UNFILED = [
    '# 未歸屬的伏筆',
    '',
    '## 伏筆',
    '- 提燈人：院外提燈的人是誰',
    '- 別的伏筆：不動的那一條',
    '',
    '## 進展',
    '- 第 2 章 · 埋〈提燈人〉：燈影 〔證據：「院外有燈」〕',
    '- 第 3 章 · 埋〈別的伏筆〉：x 〔證據：「x」〕',
    '',
  ].join('\n');
  let outcome;

  before(async () => {
    t.write(CH4, `# 第4章 夜談\n\n${CH4_TEXT}\n`);
    t.remove('.novelwarden/characters');
    writeThreads();
    t.write(file('未归属的伏笔'), UNFILED);
    project.invalidate();
    findReply = () =>
      JSON.stringify({
        events: [{ line: '林昭與沈青', type: '收', foreshadowing: '提燈人', what: '提燈的是沈青', evidence: '院外有人提著燈走過' }],
        newThreads: [],
        newForeshadowing: [],
      });
    progressReply = () => JSON.stringify({ progress: [{ line: '林昭與沈青', text: '提燈人是沈青。' }] });
    fake = installFakeProvider(bundle.registry, { reply: finalizeReply });
    outcome = await bundle.finalize.finalizeChapter(project, await chapter4());
  });

  test('伏筆那一行與它的事件原樣挪到線上，這一章的「收」接在後面；未歸屬裡別的行不動', () => {
    const pair = t.read(file('林昭與沈青'));
    assert.match(pair, /- 玉佩的來歷：[^\n]*\n- 提燈人：院外提燈的人是誰\n/);
    assert.match(pair, /- 第 2 章 · 埋〈提燈人〉：燈影 〔證據：「院外有燈」〕\n/);
    assert.ok(pair.indexOf('第 2 章 · 埋〈提燈人〉') < pair.indexOf('第 4 章 · 收〈提燈人〉'), pair);
    const unfiled = t.read(file('未归属的伏笔'));
    assert.ok(!unfiled.includes('提燈人'), unfiled);
    assert.ok(unfiled.includes('- 別的伏筆：不動的那一條') && unfiled.includes('第 3 章 · 埋〈別的伏筆〉'), unfiled);
  });

  test('讀回來：提燈人掛在線上的、已收；完成提示說挪了', async () => {
    project.invalidate();
    const book = await project.readThreads();
    const pair = book.threads.find((x) => x.name === '林昭與沈青');
    assert.equal(bundle.threadFile.foreshadowingOf(pair, 4).find((f) => f.name === '提燈人')?.status, '已收');
    assert.ok(!bundle.threadFile.foreshadowingOf(book.unfiled, 4).some((f) => f.name === '提燈人'));
    assert.deepEqual(outcome.threads.rehomed, [{ name: '提燈人', line: '林昭與沈青' }]);
    assert.ok(bundle.finalize.describeFinalize(4, outcome).includes('〈提燈人〉從未歸屬挪到了〈林昭與沈青〉'));
  });
});
