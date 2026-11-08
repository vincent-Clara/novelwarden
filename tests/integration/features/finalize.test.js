/**
 * 定稿：照正文反向更新這一章的細綱（帶連續性事實與證據），再用一次呼叫更新本章出場角色的當前狀態；敘事線那一步
 * （認事件每次都跑，敘事線重做）這裡一條線都沒有、什麼都認不出，只算 1 次——它自己的斷言在 features/threads.test.js；故事時間
 * 那一步（2026-10-24 重做：單獨一次）也算 1 次——它自己的斷言在 features/storyTimeline.test.js。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 連續性事實每條帶一句正文原句，找不到依據的丟掉 | D18：證據確定性地找，不調模型 |
 * | 有細綱時拿它與正文對照著改（`REFINE_SYSTEM`，先給當前細綱再給正文） | 作者定案 3：這是修改，不是重寫 |
 * | 當前細綱裡的舊連續性事實不給模型 | 證據要回原文逐字校驗，舊句子照抄只會抄到對不上的 |
 * | 沒有細綱、或七節全空時照正文從頭整理（`SUMMARY_SYSTEM`） | 拆書匯入、作者手寫的正文也能直接定稿 |
 * | 定稿保留 targetWords / upstreamHash / title，記 sourceHash、cast，重新整理 writtenFrom | 計劃那一側的賬定稿不該動；不刷 writtenFrom 正文會立刻掛 ⟳ |
 * | 舊版細綱先複製進 `.trash/` | 七節整體替換，作者要能找回原來的計劃 |
 * | 帶著細綱也不多調：更新細綱仍是 1 次 | 呼叫次數和從前寫摘要那一次一樣（`FINALIZE_CALLS` 不變） |
 * | 機器的卡換上新狀態、只動那一節 | D15；整卡重渲染會抹掉作者自加的小節 |
 * | 作者改過的卡不寫、掛黃 ❗，對比後能採用或放棄 | 第 3 條：不靜默覆蓋 |
 * | 出場的人都沒卡時只有細綱、認敘事線與故事時間那 3 次 | 第 4 條：預計 6–12 次（寫 3–6 次、轉寫 3–6 次；假模型直接給 JSON 不轉），不白調 |
 * | 不回退到更早的章 | 重新定稿早前的章不該把狀態倒回去 |
 * | 角色狀態失敗時細綱照樣在，黃 ❗ 掛在章節上 | 第 16 條：部分完成 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, makeSettings } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let fake;
let t;
let project;

const TEXT = [
  '雨下了一整夜。林昭推開客棧的門，簷下的燈籠被風吹得直晃。',
  '青鱗從暗處撲出來，他側身躲開，血順著左臂往下淌，他把袖子紮緊了。',
  '沈氏在櫃檯後看著他，沒說話。她把那塊殘令收進了袖中。',
  '天亮時，林昭離開了青崖鎮，往北去了。',
].join('\n\n');

const CH = (no) => `chapters/00${no}-第${no}章.md`;
const CARD = (name) => `.novelwarden/characters/${name}.md`;
/** 「更新細綱」那條規則只在 REFINE_SYSTEM 裡有：拿它認出這一次是不是照著當前細綱改。 */
const REFINE_RULE = '關於「當前細綱」';

/** 模型這一次該答什麼：細綱（定稿）一種、角色狀態一種。`state` 可以換掉（失敗那一節）。 */
let stateReply;
/** 給了就拿它當定稿那一次的回答（解析失敗那一節）。 */
let summaryReply;
function reply(messages) {
  const system = messages[0]?.content ?? '';
  // SUMMARY_SYSTEM 與 REFINE_SYSTEM 開頭同一句：兩種定稿都走這一支。
  if (system.includes('建立可檢索的章節檔案')) {
    if (summaryReply) {
      return summaryReply;
    }
    return JSON.stringify({
      梗概: '林昭夜裡在客棧遇襲，天亮後離開。',
      出场人物: [{ name: '林昭', aliases: [] }, { name: '沈氏', aliases: [] }, { name: '李叔', aliases: [] }],
      时间地点: '青崖鎮，夜。',
      关键事件: ['遇襲', '離鎮'],
      状态变更: '林昭受了傷。',
      连续性事实: ['林昭左臂被青鱗劃傷，血流不止', '沈氏把殘令收進袖中', '城主暗中投靠了魔教'],
    });
  }
  if (system.includes('依據本章正文更新角色的「當前狀態」')) {
    return stateReply(messages);
  }
  // 敘事線認事件：一條線都沒有，什麼都認不出。
  if (system.includes('你是小說定稿事實審查員')) {
    return JSON.stringify({ events: [], newThreads: [], newForeshadowing: [] });
  }
  // 故事時間：同一天。
  if (system.includes('你是小說的時間校對員')) {
    const no = Number(/【第(\d+)章 /.exec(messages[messages.length - 1].content)?.[1] ?? 0);
    return JSON.stringify({ times: [{ chapter: no, days: 0, reason: '緊接上一章' }] });
  }
  return '（認不出這一步）';
}

function card(name, fm, 当前状态, extra = '') {
  t.write(
    CARD(name),
    `---\nname: ${name}\n${fm}---\n\n# ${name}\n\n## 身份\n\n${name}的身份\n\n## 當前狀態\n\n${当前状态}\n${extra}`
  );
}

async function chapterNo(no) {
  project.invalidate();
  return (await project.listChapters()).find((c) => c.order === no);
}

async function failuresOf(key) {
  return (await bundle.errorLog.listActiveFailures(project))[key] ?? [];
}

/** 定稿那一次（第一次呼叫）發給模型的 system 與 user。 */
function finalizeCall() {
  const [system, user] = fake.calls[0];
  return { system: system.content, user: user.content };
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    finalize: './src/core/features/finalize.ts',
    characterState: './src/core/features/characterState.ts',
    stateModel: './src/core/model/characterState.ts',
    plotFile: './src/core/model/plotFile.ts',
    pipeline: './src/core/model/pipeline.ts',
    db: './src/core/runtime/db.ts',
    errorLog: './src/core/runtime/errorLog.ts',
  });
  // 多配一個模型 strong：右鍵「重新定稿」的確認框上為這一次換它。對話頁選定的（`models` 首項）仍是 m。
  h = makeFakeHost({
    supportsVscodeLm: true,
    settings: makeSettings({
      contextWindow: 16000,
      maxOutputTokens: 1000,
      providers: [{ id: 'fake', kind: 'vscode-lm', models: [{ name: 'm' }, { name: 'strong' }] }],
    }),
  });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, { reply });
  t = await makeTempProject(bundle.project, { prefix: 'finalize', title: '定稿測試' });
  project = t.project;
  for (const no of [1, 2, 3]) {
    t.write(CH(no), `# 第${no}章\n\n${TEXT}\n`);
  }
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('定稿：沒有細綱時照正文整理一份，帶連續性事實', () => {
  let outcome;
  let plotText;

  before(async () => {
    const hash = bundle.stateModel.stateHashOf('在客棧');
    card('林昭', `stateThrough: 1\nstateHash: ${hash}\n`, '在客棧', '\n## 我的筆記\n\n作者自己加的一節\n');
    // 沈氏：有內容、從沒蓋過章——作者的。
    card('沈氏', '', '守著客棧，不問來客');
    stateReply = () =>
      JSON.stringify({
        updates: [
          { name: '林昭', 当前状态: '左臂帶傷，離開青崖鎮往北' },
          { name: '沈氏', 当前状态: '收起了殘令' },
          { name: '王五', 当前状态: '名單外的人' },
        ],
      });
    fake.reset();
    outcome = await bundle.finalize.finalizeChapter(project, await chapterNo(2));
    plotText = t.read('.novelwarden/summaries/002-第2章.md');
  });

  test('一共 4 次：細綱一次、角色狀態一次、認敘事線一次、故事時間一次', () => {
    assert.equal(fake.callCount(), 4);
  });

  test('outcome 記的呼叫次數與實際一致', () => {
    assert.equal(outcome.calls, 4);
  });

  test('沒有細綱：用 SUMMARY_SYSTEM，不帶「當前細綱」那段規則', () => {
    assert.ok(!finalizeCall().system.includes(REFINE_RULE));
  });

  test('沒有細綱：user 訊息請模型照正文整理細綱', () => {
    assert.match(finalizeCall().user, /請為下面這一章整理細綱。\n\n【第2章 第2章】\n\n/);
  });

  test('每條事實都帶一句正文原句', () => {
    assert.match(plotText, /## 連續性事實\n\n- 林昭左臂被青鱗劃傷，血流不止 〔證據：「[^」]*左臂[^」]*」〕/);
    assert.match(plotText, /- 沈氏把殘令收進袖中 〔證據：「她把那塊殘令收進了袖中。」〕/);
  });

  test('找不到依據的事實丟掉，並報出來', () => {
    assert.doesNotMatch(plotText, /城主/);
    assert.deepEqual(outcome.summary.dropped, ['城主暗中投靠了魔教']);
    assert.match(bundle.finalize.describeFinalize(2, outcome), /1 條在正文裡找不到依據/);
  });

  test('原來沒有細綱：沒有東西進回收站，完成提示說「整理了一份」', () => {
    assert.equal(outcome.summary.trashed, undefined);
    assert.match(bundle.finalize.describeFinalize(2, outcome), /^第 2 章已同步：細綱照正文整理了一份，2 條連續性事實/);
  });

  test('讀回來：細綱的「連續性事實」一節帶著證據', async () => {
    project.invalidate();
    const plot = await project.getPlot(2);
    assert.match(plot.sections.连续性事实, /證據/);
  });

  test('讀回來：這一章算定稿過（sourceHash 對得上正文）', async () => {
    const chapter = await chapterNo(2);
    assert.ok(await project.finalizedPlotOf(chapter));
  });
});

describe('定稿：角色狀態', () => {
  test('機器的卡換上新狀態、蓋到第 2 章，作者自加的小節還在', () => {
    const text = t.read(CARD('林昭'));
    assert.match(text, /## 當前狀態\n\n左臂帶傷，離開青崖鎮往北\n/);
    assert.match(text, /stateThrough: 2/);
    assert.match(text, /## 我的筆記\n\n作者自己加的一節/);
  });

  test('讀回來歸機器：下一次定稿照樣能寫', async () => {
    project.invalidate();
    const lin = (await project.listCharacters()).find((c) => c.name === '林昭');
    assert.equal(lin.stateThrough, 2);
    assert.ok(bundle.stateModel.stateOwnedByMachine(lin));
  });

  test('作者的卡一個字沒動，掛黃 ❗，說明裡帶著機器那一版', async () => {
    assert.match(t.read(CARD('沈氏')), /守著客棧，不問來客/);
    const [f] = await failuresOf(CARD('沈氏'));
    assert.equal(f.severity, 'warn');
    assert.match(f.message, /你改過/);
    assert.deepEqual(bundle.characterState.proposalOf(f.detail), { no: 2, state: '收起了殘令' });
  });

  test('對比後採用：換上那一版、蓋章、清 ❗', async () => {
    h.setReviewVerdict('apply');
    await bundle.characterState.reviewCharacterState(project, CARD('沈氏'));
    assert.match(t.read(CARD('沈氏')), /## 當前狀態\n\n收起了殘令\n/);
    assert.deepEqual(await failuresOf(CARD('沈氏')), []);
    project.invalidate();
    const shen = (await project.listCharacters()).find((c) => c.name === '沈氏');
    assert.ok(bundle.stateModel.stateOwnedByMachine(shen));
  });

  test('名單外的名字忽略', async () => {
    assert.deepEqual((await project.listCharacters()).map((c) => c.name).sort(), ['林昭', '沈氏'].sort());
  });
});

describe('定稿：作者改過、對比後放棄', () => {
  before(async () => {
    card('沈氏', 'stateThrough: 2\nstateHash: stale\n', '其實她早就認出了林昭');
    stateReply = () => JSON.stringify({ updates: [{ name: '沈氏', 当前状态: '收起了殘令' }] });
    await bundle.finalize.finalizeChapter(project, await chapterNo(3));
    h.setReviewVerdict('discard');
    await bundle.characterState.reviewCharacterState(project, CARD('沈氏'));
  });

  test('不寫、清 ❗；這一節仍然歸作者', async () => {
    assert.match(t.read(CARD('沈氏')), /其實她早就認出了林昭/);
    assert.deepEqual(await failuresOf(CARD('沈氏')), []);
    project.invalidate();
    const shen = (await project.listCharacters()).find((c) => c.name === '沈氏');
    assert.ok(!bundle.stateModel.stateOwnedByMachine(shen));
  });

  test('出場了、狀態沒變的機器的卡：寫到第幾章推到這一章', () => {
    assert.match(t.read(CARD('林昭')), /stateThrough: 3/);
    assert.match(t.read(CARD('林昭')), /左臂帶傷，離開青崖鎮往北/);
  });
});

describe('定稿：不回退、沒卡、失敗', () => {
  test('卡上已經是更晚那一章的狀態：重新定稿第 1 章不回退', async () => {
    stateReply = () => JSON.stringify({ updates: [{ name: '林昭', 当前状态: '剛進青崖鎮' }] });
    const outcome = await bundle.finalize.finalizeChapter(project, await chapterNo(1));
    assert.deepEqual(outcome.states.newer, ['林昭']);
    assert.match(t.read(CARD('林昭')), /左臂帶傷/);
  });

  test('出場的人都沒建卡：只有更新細綱、認敘事線與故事時間那三次', async () => {
    t.remove('.novelwarden/characters');
    fake.reset();
    const outcome = await bundle.finalize.finalizeChapter(project, await chapterNo(1));
    assert.equal(outcome.calls, 3);
    assert.equal(fake.callCount(), 3);
    assert.match(bundle.finalize.describeFinalize(1, outcome), /出場的人都還沒有角色卡/);
  });

  test('角色狀態解析不出來：細綱照樣在，黃 ❗ 掛在章節上，呼叫照樣記賬', async () => {
    card('林昭', '', '');
    stateReply = () => '模型答非所問';
    t.remove('.novelwarden/summaries/003-第3章.md');
    const outcome = await bundle.finalize.finalizeChapter(project, await chapterNo(3));
    assert.equal(outcome.calls, 4);
    assert.ok(outcome.stateError);
    assert.ok(t.has('.novelwarden/summaries/003-第3章.md'));
    const [f] = await failuresOf(CH(3));
    assert.equal(f.severity, 'warn');
    assert.match(f.message, /細綱已照正文更新，但角色狀態沒更新成/);
  });

  test('再定稿成功，章節上那一條黃 ❗ 收掉', async () => {
    stateReply = () => JSON.stringify({ updates: [] });
    await bundle.finalize.finalizeChapter(project, await chapterNo(3));
    assert.deepEqual(await failuresOf(CH(3)), []);
  });

  // 試跑報告第 11 條：批次寫章沒寫夠八成停在這一章，掛在細綱上的黃 ❗ 只有批次把這一章寫成才清，單章定稿之後一直掛著。
  test('批次停在這一章掛在細綱上的黃 ❗：單章定稿之後收掉', async () => {
    const plotRel = '.novelwarden/summaries/003-第3章.md';
    await bundle.errorLog.recordFailure(project, {
      scope: '流水線',
      targetKind: 'plot',
      targetKey: plotRel,
      severity: 'warn',
      op: 'manuscript',
      message: '批次寫章：這一章寫進去了，但只寫到 1957 / 3000 字，不到目標的八成',
      detail: '批次在這一章停下，沒有同步，也沒有往下寫。',
    });
    assert.equal((await failuresOf(plotRel)).length, 1);
    await bundle.finalize.finalizeChapter(project, await chapterNo(3));
    assert.deepEqual(await failuresOf(plotRel), []);
  });
});

describe('定稿：有細綱時照正文反向更新它', () => {
  const PLAN_REL = '.novelwarden/summaries/004-夜雨.md';
  const PLAN = [
    '---',
    'no: 4',
    'title: 夜雨',
    'targetWords: 2400',
    'upstreamHash: 0a1b2c3d4e5f6789',
    'writtenFrom: 1111111111111111',
    'factCheckOk: true',
    'generatedBy: novelwarden',
    '---',
    '',
    '# 第4章 夜雨',
    '',
    '## 梗概',
    '',
    '林昭冒雨投宿客棧，夜裡遭青鱗伏擊，天亮前獨自離鎮。',
    '',
    '## 出場人物',
    '',
    '林昭、沈氏',
    '',
    '## 時間地點',
    '',
    '青崖鎮客棧，雨夜。',
    '',
    '## 關鍵事件',
    '',
    '林昭投宿；青鱗夜襲，林昭負傷；沈氏收起殘令；天亮離鎮。',
    '',
    '## 看點',
    '',
    '- 青鱗從暗處撲出來的那一下。',
    '',
    '## 狀態變更',
    '',
    '（待補充）',
    '',
    '## 連續性事實',
    '',
    '- 林昭在客棧留下了佩劍 〔證據：「他把佩劍留在了櫃檯上」〕',
    '',
  ].join('\n');

  let outcome;
  let chapter;
  let plot;

  before(async () => {
    t.write('chapters/004-夜雨.md', `# 夜雨\n\n${TEXT}\n`);
    t.write(PLAN_REL, PLAN);
    // 林昭有卡：角色狀態那一步照常調一次，好看出反向更新本身沒有多調。
    card('林昭', '', '');
    stateReply = () => JSON.stringify({ updates: [] });
    fake.reset();
    chapter = await chapterNo(4);
    outcome = await bundle.finalize.finalizeChapter(project, chapter);
    project.invalidate();
    plot = await project.getPlot(4);
  });

  test('用 REFINE_SYSTEM：帶著「當前細綱」那段規則', () => {
    assert.ok(finalizeCall().system.includes(REFINE_RULE));
  });

  test('REFINE_SYSTEM 是在 SUMMARY_SYSTEM 後面接一段：欄位與規則一字不差', () => {
    assert.ok(finalizeCall().system.startsWith('你是小說編輯，負責為長篇小說建立可檢索的章節檔案。'));
  });

  test('user 訊息先給當前細綱：標題是【第4章 夜雨 · 當前細綱】，後面接著它的小節', () => {
    assert.match(
      finalizeCall().user,
      /請照下面這一章的正文，把它的當前細綱改成正文實際寫成的樣子。\n\n【第4章 夜雨 · 當前細綱】\n\n## 梗概\n林昭冒雨投宿客棧，夜裡遭青鱗伏擊，天亮前獨自離鎮。\n\n## 出場人物\n林昭、沈氏\n/
    );
  });

  test('當前細綱之後才是正文：【第4章 夜雨 · 正文】', () => {
    const { user } = finalizeCall();
    const planAt = user.indexOf('【第4章 夜雨 · 當前細綱】');
    const proseAt = user.indexOf('【第4章 夜雨 · 正文】\n\n雨下了一整夜。');
    assert.ok(planAt >= 0 && proseAt > planAt, user);
  });

  test('當前細綱只給填了的小節：佔位的「狀態變更」不給', () => {
    assert.doesNotMatch(finalizeCall().user, /## 狀態變更/);
  });

  test('舊的連續性事實不給模型：它要照正文重新摘、證據重新校驗', () => {
    assert.doesNotMatch(finalizeCall().user, /佩劍/);
  });

  test('細綱落回原來那份檔案，不另起一份', () => {
    assert.equal(outcome.summary.relPath, PLAN_REL);
  });

  test('七節整體換成模型那一版：原來的梗概不在了', () => {
    assert.equal(plot.sections.梗概, '林昭夜裡在客棧遇襲，天亮後離開。');
  });

  // 梗概照正文改了（它就是大綱裡這一章那一條）：記過的上游指紋刷成新梗概的，不然一定稿就掛 ⟳。
  test('保留計劃那一側的賬：標題、目標字數；上游指紋刷成新梗概的', () => {
    assert.deepEqual(
      { title: plot.title, targetWords: plot.targetWords, upstreamHash: plot.upstreamHash },
      { title: '夜雨', targetWords: 2400, upstreamHash: bundle.plotFile.plotSynopsisHash('林昭夜裡在客棧遇襲，天亮後離開。') }
    );
  });

  test('寫前衝突檢查的放行（factCheckOk）原樣留著', () => {
    assert.equal(plot.factCheckOk, true);
  });

  test('sourceHash 記的是正文的 contentHash：這一章算定稿過', () => {
    assert.equal(plot.sourceHash, chapter.contentHash);
  });

  test('writtenFrom 刷成更新之後的內容指紋：正文不會因為定稿立刻掛 ⟳', () => {
    assert.equal(plot.writtenFrom, bundle.plotFile.plotContentHash(plot));
  });

  test('writtenFrom 不再是原來那一版的', () => {
    assert.notEqual(plot.writtenFrom, '1111111111111111');
  });

  test('cast 記下實際出場：frontmatter 裡一項一人', () => {
    assert.match(t.read(PLAN_REL), /^cast: \[林昭, 沈氏, 李叔\]$/m);
  });

  test('讀回來的出場人物取 cast（定稿過的是實際出場）', () => {
    assert.deepEqual(plot.characters, ['林昭', '沈氏', '李叔']);
  });

  test('舊版先複製一份進 .novelwarden/.trash/，原樣一個位元組不差', () => {
    assert.equal(t.read(`.novelwarden/.trash/${PLAN_REL}`), PLAN);
  });

  test('outcome 報出舊版在回收站裡的位置', () => {
    assert.equal(outcome.summary.trashed, `.novelwarden/.trash/${PLAN_REL}`);
  });

  test('完成提示說「舊版已放進回收站」', () => {
    assert.match(
      bundle.finalize.describeFinalize(4, outcome),
      /^第 4 章已同步：細綱照正文更新（舊版已放進回收站），2 條連續性事實/
    );
  });

  test('帶著細綱也不多調：更新細綱 1 次、角色狀態 1 次、認敘事線 1 次、故事時間 1 次，一共 4 次', () => {
    assert.equal(fake.callCount(), 4);
  });

  test('outcome 記的呼叫次數與實際一致', () => {
    assert.equal(outcome.calls, 4);
  });

  // 2026-10-25 起每一次寫完都轉寫一次（low / high 翻倍），轉寫不合格各重轉一次（max 再加一份）。
  test('定稿的次數估算：寫 3–6 次、轉寫 3–6 次，最多 18 次（敘事線重做：認事件每次都跑；故事時間單獨一次）', () => {
    const { low, high, max } = bundle.pipeline.FINALIZE_CALLS;
    assert.deepEqual({ low, high, max }, { low: 6, high: 12, max: 18 });
  });

  test('再定稿一次：回收站裡同名的舊版不被覆蓋，新的一份加 -2', async () => {
    fake.reset();
    const again = await bundle.finalize.finalizeChapter(project, chapter);
    assert.equal(again.summary.trashed, '.novelwarden/.trash/.novelwarden/summaries/004-夜雨-2.md');
  });
});

describe('定稿：細綱只起了個頭（七節全空）時照正文從頭整理', () => {
  const SHELL_REL = '.novelwarden/summaries/005-空殼.md';

  before(async () => {
    t.write('chapters/005-空殼.md', `# 空殼\n\n${TEXT}\n`);
    t.write(
      SHELL_REL,
      '---\nno: 5\ntitle: 空殼\ntargetWords: 1800\ngeneratedBy: novelwarden\n---\n\n# 第5章 空殼\n\n' +
        ['梗概', '出场人物', '时间地点', '关键事件', '看点', '状态变更', '连续性事实']
          .map((k) => `## ${k}\n\n（待補充）`)
          .join('\n\n') +
        '\n'
    );
    stateReply = () => JSON.stringify({ updates: [] });
    fake.reset();
    await bundle.finalize.finalizeChapter(project, await chapterNo(5));
  });

  test('用 SUMMARY_SYSTEM：空殼不算「當前細綱」', () => {
    assert.ok(!finalizeCall().system.includes(REFINE_RULE));
  });

  test('user 訊息請模型照正文整理細綱，不帶「當前細綱」那一塊', () => {
    assert.match(finalizeCall().user, /^請為下面這一章整理細綱。\n\n【第5章 空殼】\n\n雨下了一整夜。/m);
  });

  test('照樣落回那份空殼，目標字數留著', async () => {
    project.invalidate();
    const plot = await project.getPlot(5);
    assert.deepEqual({ relPath: plot.relPath, targetWords: plot.targetWords }, { relPath: SHELL_REL, targetWords: 1800 });
  });
});

// 真實模型試跑裡撞上的：定稿那次回答沒解析開時，從前把整段原文塞進「梗概」、其餘七節寫成佔位，
// 還記上 sourceHash——細綱被毀、這一章卻顯示已定稿。現在解析不了就報失敗，細綱一個字不動。
describe('定稿：模型返回解析不了', () => {
  const PLAN_REL = '.novelwarden/summaries/006-霧巷.md';
  const PLAN =
    '---\nno: 6\ntitle: 霧巷\ntargetWords: 2000\nupstreamHash: 0a1b2c3d4e5f6789\ngeneratedBy: novelwarden\n---\n\n# 第6章 霧巷\n\n' +
    '## 梗概\n\n林昭在霧巷裡甩掉跟蹤的人。\n\n## 關鍵事件\n\n- 林昭發現有人跟蹤\n- 他鑽進霧巷甩掉對方\n';
  let error;

  before(async () => {
    t.write('chapters/006-霧巷.md', `# 霧巷\n\n${TEXT}\n`);
    t.write(PLAN_REL, PLAN);
    summaryReply = '好的，這一章主要寫了林昭在客棧遇襲然後離開，整體節奏緊湊。';
    fake.reset();
    try {
      await bundle.finalize.finalizeChapter(project, await chapterNo(6));
    } catch (err) {
      error = err;
    }
    summaryReply = undefined;
  });

  test('報失敗，不當成定稿完成', () => {
    assert.ok(error && /同步失敗/.test(error.message), String(error));
  });

  test('細綱一個字都沒動', () => {
    assert.equal(t.read(PLAN_REL), PLAN);
  });

  test('這一章不算定稿過：細綱上沒有 sourceHash', async () => {
    project.invalidate();
    assert.ok(!(await project.getPlot(6)).sourceHash);
  });

  test('失敗掛在章節上，說明細綱沒有改動', async () => {
    const marks = await failuresOf('chapters/006-霧巷.md');
    assert.ok(marks.some((m) => /無法解析/.test(m.message) && /細綱沒有改動/.test(m.detail ?? '')), JSON.stringify(marks));
  });
});

// 工程頁章節右鍵「定稿」「重新定稿」（2026-10-23 作者要的）：先彈確認框，模型下拉框開啟時選著對話頁那個，可以為這一次換一個。
describe('工程頁章節右鍵「定稿」「重新定稿」：先問這一次用哪個模型', () => {
  const PLOT_REL = '.novelwarden/summaries/001-第1章.md';
  /** 這一次的呼叫都交給了誰。 */
  const refsUsed = () => [...new Set(fake.calls.map((m) => m.ref))];

  before(() => {
    stateReply = () => JSON.stringify({ updates: [] });
  });

  test('取消：不調模型，細綱一個字不動', async () => {
    const plot = t.read(PLOT_REL);
    h.expect();
    fake.reset();
    assert.equal(await bundle.finalize.askFinalizeChapterTask(project, await chapterNo(1)), 0);
    assert.equal(fake.callCount(), 0);
    assert.equal(t.read(PLOT_REL), plot);
  });

  test('確認框報次數、只有一顆「重新定稿」；模型預設是對話頁那個，帶詳細度下拉框', () => {
    const [c] = h.confirms;
    assert.deepEqual(c.actions, ['重新同步']);
    assert.match(c.message, /^重新同步第 1 章《.+》：.*預計 6–12 次呼叫，最多 18 次。$/);
    // 轉寫那一檔單列一行（不跟這一次挑的模型）。
    assert.ok(c.call.fixed?.some((f) => f.startsWith('轉寫') && f.endsWith('（不跟這一次挑的模型）')), JSON.stringify(c.call));
    assert.equal(c.call.model, 'fake/m');
    assert.ok(c.call.contextDetail, JSON.stringify(c.call));
    assert.ok(c.call.models.some((m) => m.ref === 'fake/strong'), JSON.stringify(c.call.models));
  });

  test('換一個模型：這一次的每次呼叫都用它，完成提示照舊', async () => {
    h.expect({ action: '重新同步', choice: { model: 'fake/strong' } });
    fake.reset();
    const calls = await bundle.finalize.askFinalizeChapterTask(project, await chapterNo(1));
    assert.ok(calls >= 2, String(calls));
    assert.equal(calls, fake.callCount());
    assert.deepEqual(refsUsed(), ['fake/strong']);
    assert.ok(h.toasts.some((x) => x.includes('第 1 章已同步')), h.toasts.join('|'));
  });

  // 沒定稿、或定稿之後正文又改過的章，右鍵上寫的是「定稿」：確認框上那顆按鈕也是。
  test('定稿之後正文又改過：確認框上那顆按鈕是「定稿」', async () => {
    t.write(CH(1), `# 第1章\n\n${TEXT}\n\n又補了一句。\n`);
    h.expect();
    fake.reset();
    await bundle.finalize.askFinalizeChapterTask(project, await chapterNo(1));
    assert.deepEqual(h.confirms[0].actions, ['同步']);
    assert.match(h.confirms[0].message, /^同步第 1 章/);
    assert.equal(fake.callCount(), 0);
  });

  test('下拉框不動直接點：用對話頁那個', async () => {
    h.expect('同步');
    fake.reset();
    await bundle.finalize.askFinalizeChapterTask(project, await chapterNo(1));
    assert.ok(fake.callCount() >= 2, String(fake.callCount()));
    assert.deepEqual(refsUsed(), ['fake/m']);
  });
});
