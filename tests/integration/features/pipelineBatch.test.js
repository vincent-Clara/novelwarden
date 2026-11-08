/**
 * 工程頁流水線批次動作：批次拆細綱、批次寫正文（補齊架構在 settingsBatch.test.js）。
 *
 * - **批次拆細綱**（二期）：區間裡還沒有細綱的章，每批 5 章、嚴格序列地走生成鏈
 *   （generation/structured.ts）。每批寫完就落盤，後一批讀得到它；一批失敗就停。
 * - **批次寫章**：四期改成嚴格序列，用例在 writeBatch.test.js；這裡只留「取消就一次都不調」。
 *
 * 這兩條路的失敗方式和單次生成完全不同——一次跑幾十章，所以要釘住的是：
 * 1. **只補不改**：已經有產物的章一律跳過，不問、不覆蓋（第 19 條的批次那一面）。
 * 2. **一批失敗就停**：後一批要接著它往下排。
 * 3. **失敗留在那一章上**：toast 五秒就沒了（第 16 條）。
 * 4. **沒有前置產物就不跑**：沒有大綱還寫細綱，等於讓模型憑空編四十章。
 * 5. **動手前說清調幾次模型**，併發不改變這個數（第 4 條）。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { loadBundle, loadModule } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost, sleep } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');
const { outlineOf, writeOutline } = require('../../helpers/outline');

let wsMod;
const wsOf = (p) => new wsMod.Workspace(p);

/** 模型交回的一章藍圖（細綱合同：七節裡除連續性事實之外的欄位）。標題故意和磁碟那份不一樣。 */
const bp = (no, over = {}) => ({
  chapterNumber: no,
  title: '模型起的名',
  synopsis: '進入宗門',
  characters: ['林昭', '沈青'],
  timePlace: '入宗當夜，青雲宗山門',
  keyEvents: ['踩點、失手、翻牆', '收在藏書閣門口。'],
  highlights: ['藏書閣裡有人在等他'],
  foreshadowing: [],
  stateChange: '',
  ...over,
});
/** 按契約裡寫的區間應答：「寫第 3–5 章的細綱：」。 */
function blueprintsFor(messages, over = {}) {
  const user = messages[messages.length - 1].content;
  const m = /寫第 (\d+)(?:–(\d+))? 章的細綱：/.exec(user);
  const from = Number(m?.[1] ?? 1);
  const to = Number(m?.[2] ?? from);
  const items = [];
  for (let no = from; no <= to; no++) {
    items.push(bp(no, typeof over === 'function' ? over(no) : over));
  }
  return JSON.stringify({ blueprints: items });
}
const OUTLINE = outlineOf(20, { title: '大綱', text: { 1: '林昭進入青雲宗。' } });
/** 一條敘事線（有了它批次拆細綱就不先排線）。 */
const THREAD = '.novelwarden/threads/青雲舊案.md';
/** 排線的系統提示裡認得出的那一句。 */
const PLAN_MARK = '只從作者給的小說配置、故事前提、角色圖譜與情節大綱裡排出這本書的敘事線';
/** 總章數 3：預設的那一批收在第 3 章，下面批次寫正文那幾組只面對這三章。 */
const CONFIG = '---\ntotalChapters: 3\n---\n\n# 小說配置\n\n## 核心梗概\n\n少年入宗。\n';

let bundle;
let h;
let fake;
let t;
let project;

/** `config.read()` 的返回值，configure() 每次整體換掉。 */
let settings = {};
/** 第 N 次呼叫該返回什麼。 */
let replyFn = () => '';
/** warn / error 級日誌。helper 沒有這個能力，內聯一個 sink。 */
const warns = [];

function configure(extra = {}) {
  settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
    ...extra,
  };
  fake.calls.length = 0;
  h.toasts.length = 0;
  h.confirms.length = 0;
  warns.length = 0;
  // 答案佇列也清空：流程發現「沒有可做的」時會在彈確認框之前就返回，
  // 留在佇列裡的那個答案會被下一個用例的確認框讀到，串成一串假失敗。
  h.answers.length = 0;
}

/**
 * 建一章空骨架——還沒排過（isPlotFilled 只看關鍵事件）。梗概也空著：梗概就是情節大綱裡這一章那一條，
 * 「大綱為空」那一組要的正是一條都沒有；後面幾組照大綱寫（`writeOutline`）。
 */
async function skeleton(no, title, extra = {}) {
  return wsOf(project).writePlot({
    no,
    title,
    upstreamHash: '',
    done: false,
    sections: bundle.plotFile.emptyPlotSections(),
    ...extra,
  });
}

/** 按號取這一章的流水線。 */
async function pipelineOf(no) {
  project.invalidate();
  return bundle.pipe.buildPlotPipeline(project, { no, plot: await project.getPlot(no) });
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    batch: './src/core/features/pipelineBatch.ts',
    plotFile: './src/core/model/plotFile.ts',
    outlineFile: './src/core/model/outlineFile.ts',
    pipe: './src/core/views/pipeline.ts',
    errorLog: './src/core/runtime/errorLog.ts',
    db: './src/core/runtime/db.ts',
    logger: './src/core/runtime/logger.ts',
  });
  wsMod = bundle.ws;

  // 假宿主沒有 reviewReplace——批次路徑本來就不該逐份彈 diff。
  h = makeFakeHost({
    name: 'standalone',
    supportsVscodeLm: true,
    settings: () => settings,
    overrides: { reviewReplace: undefined },
  });
  bundle.host.initHost(h.host);
  bundle.logger.addLogSink((e) => {
    if (e.level === 'warn' || e.level === 'error') {
      warns.push(`${e.message} ${e.detail ?? ''}`);
    }
  });
  fake = installFakeProvider(bundle.registry, { reply: (messages, i) => replyFn(messages, i) });

  t = await makeTempProject(bundle.project, {
    prefix: 'batch',
    title: '青雲劍錄',
    keepExamples: true,
  });
  project = t.project;
  // 作者給第 1、3 章定了字數：批次拆細綱不該把它們抹掉。
  for (const [no, title, extra] of [[1, '楔子', { targetWords: 5000 }], [2, '入鎮'], [3, '夜訪', { targetWords: 3000 }]]) {
    await skeleton(no, title, extra);
  }
  t.write('.novelwarden/config.md', CONFIG);
  // 已經有一條敘事線：批次拆細綱開跑前不再先排線（「一條敘事線都沒有」那一組單獨測）。
  t.write(THREAD, '---\nkind: 主線\n---\n\n# 青雲舊案\n\n## 意圖\n十年前那把火。\n');
  project.invalidate();
  await project.syncManifest();
});

after(() => {
  // 庫開著的話 Windows 上刪不掉臨時目錄。
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('批次拆細綱 · 前置檢查', () => {
  let callCount;
  let toasts;

  before(async () => {
    configure();
    // 沒有大綱就寫細綱，等於讓模型憑空編三章。骨架的梗概都空著：大綱（各章梗概的彙總）一條都沒有。
    project.invalidate();
    h.answers.push('開始拆細綱');
    await bundle.batch.generatePlots(project);
    callCount = fake.calls.length;
    toasts = [...h.toasts];
  });

  test('大綱為空時不調模型', () => {
    assert.equal(callCount, 0, `調了 ${callCount} 次`);
  });

  test('大綱為空時說明原因', () => {
    assert.ok(toasts.some((x) => x.includes('大綱')), toasts.join('|'));
  });

  test('大綱為空時一章的細綱都沒寫', async () => {
    const plot = await project.readPlot('.novelwarden/summaries/001-楔子.md');
    assert.ok(!bundle.plotFile.isPlotFilled(plot.sections), JSON.stringify(plot.sections));
  });
});

describe('批次拆細綱', () => {
  let callCount;
  let confirm;
  let sys;
  let users;
  let returned;
  let callCountAgain;
  let toastsAgain;

  before(async () => {
    writeOutline(t, OUTLINE);
    project.invalidate();
    configure();

    // 先給第 2 章一份手寫細綱——它必須原樣保留，而且把區間斷開。
    await wsOf(project).writePlot({
      no: 2,
      title: '入鎮',
      upstreamHash: '',
      done: false,
      sections: {
        ...bundle.plotFile.emptyPlotSections(),
        梗概: '進鎮',
        关键事件: '這是作者手寫的',
      },
    });

    replyFn = (messages) => blueprintsFor(messages);
    h.answers.push('開始拆細綱');
    returned = await bundle.batch.generatePlots(project);

    callCount = fake.calls.length;
    confirm = h.confirms[0];
    // 裝配走的是同一個裝配器 → 細綱階段的配方里有大綱、沒有正文全文。
    sys = fake.calls[0].find((m) => m.role === 'system').content;
    users = fake.calls.map((c) => c.find((m) => m.role === 'user').content);

    // 再跑一次：全都有了，一次都不該調。
    configure();
    h.answers.push('開始拆細綱');
    await bundle.batch.generatePlots(project);
    callCountAgain = fake.calls.length;
    toastsAgain = [...h.toasts];
  });

  // 預設區間是下一可寫章起 5 章，收在總章數（3）。第 2 章排過，把區間斷成兩批：[1] 與 [3]。
  // 已經有敘事線：不先排線，拆完也不排（敘事線重做：拆完自動排那兩處刪了）。
  test('只為沒排過細綱的章調模型，跳過的章把區間斷開；有敘事線時不排線', () => {
    assert.equal(callCount, 2, `調了 ${callCount} 次`);
    assert.ok(!fake.calls.some((c) => c[0].content.includes(PLAN_MARK)));
    assert.ok(users[0].includes('請輸出第 1 章的細綱') && users[1].includes('請輸出第 3 章的細綱'), users.map((u) => u.slice(-200)).join('\n'));
  });

  // 第 4 條：動手前說清要調幾次模型——有自動修復，所以報預計與上限。
  test('確認框裡寫明批數與呼叫次數', () => {
    assert.ok(confirm?.message.includes('要拆 2 章細綱，分 2 批，預計 4 次呼叫，最多 10 次'), JSON.stringify(confirm));
  });

  // 細綱試點：轉寫不跟這一次挑的模型，單列一行、一直顯示。
  test('確認框單列轉寫交給誰', () => {
    assert.ok(confirm?.call.fixed?.some((x) => x.startsWith('轉寫 · 整理成 JSON') && x.includes('不跟這一次挑的模型')), JSON.stringify(confirm?.call));
    assert.ok(!confirm.call.tiers.some((x) => x.startsWith('轉寫')), JSON.stringify(confirm.call));
  });

  test('確認框說清排過的不會被改動', () => {
    assert.ok(confirm?.detail.includes('已經排過的第 2 章跳過，不會被改動'), JSON.stringify(confirm));
  });

  test('返回實際呼叫次數（agent 的預算記它）', () => {
    assert.equal(returned, 2);
  });

  test('第 1、3 章寫出細綱', async () => {
    for (const no of [1, 3]) {
      const plot = await project.getPlot(no);
      assert.ok(bundle.plotFile.isPlotFilled(plot.sections), `${no}: ${JSON.stringify(plot.sections)}`);
    }
  });

  // 梗概就是大綱裡這一章那一條，是這一批的上游：空殼上有就沿用，不讓模型改寫（docs/design/plans/2026-10-22-outline-from-plots.md）。
  test('梗概沿用空殼上那一條（大綱），不換成模型的 synopsis', async () => {
    assert.equal((await project.getPlot(1)).sections.梗概, '林昭進入青雲宗。');
    assert.equal((await project.getPlot(3)).sections.梗概, '第3章的事。');
  });

  test('細綱內容來自模型：timePlace 落進「時間地點」', async () => {
    assert.equal((await project.getPlot(1)).sections.时间地点, '入宗當夜，青雲宗山門');
  });

  // 關鍵事件、看點是一條一句的列表，落盤成 `- 一條` 一行，與定稿寫出來的樣子一致。
  test('細綱內容來自模型：keyEvents 落進「關鍵事件」，一條一行', async () => {
    assert.equal((await project.getPlot(1)).sections.关键事件, '- 踩點、失手、翻牆\n- 收在藏書閣門口。');
  });

  test('細綱內容來自模型：highlights 落進「看點」，一條一行', async () => {
    assert.equal((await project.getPlot(1)).sections.看点, '- 藏書閣裡有人在等他');
  });

  // 連續性事實要回正文定位證據，計劃時沒有正文，空著。
  test('連續性事實空著：定稿時才從正文裡摘', async () => {
    assert.equal((await project.getPlot(1)).sections.连续性事实, '');
  });

  // 批次拆細綱改的是七節與規劃欄位，不該把作者起的名字、定的字數抹掉。
  test('標題沿用磁碟那份，檔名不變', () => {
    assert.ok(t.has('.novelwarden/summaries/001-楔子.md'));
    assert.ok(!t.has('.novelwarden/summaries/001-模型起的名.md'));
  });

  test('作者定的目標字數原樣留著', async () => {
    assert.equal((await project.getPlot(1)).targetWords, 5000);
    assert.equal((await project.getPlot(3)).targetWords, 3000);
  });

  // 計劃出場寫在「出場人物」一節（一行，頓號隔開）；沒定稿，characters 從這一節讀出來。
  test('計劃出場寫進「出場人物」一節', async () => {
    assert.equal((await project.getPlot(1)).sections.出场人物, '林昭、沈青');
  });

  test('沒定稿的細綱，characters 就是計劃出場', async () => {
    assert.deepEqual((await project.getPlot(1)).characters, ['林昭', '沈青']);
  });

  // 只補不改：手寫的那一份一個字都不能動。
  test('手寫的細綱原樣保留', () => {
    assert.ok(
      t.read('.novelwarden/summaries/002-入鎮.md').includes('這是作者手寫的'),
      t.read('.novelwarden/summaries/002-入鎮.md').slice(0, 300)
    );
  });

  // 每批寫完就落盤：第二批的裝配讀得到第一批剛寫好的第 1 章。
  test('後一批讀得到前一批剛寫好的細綱', () => {
    assert.ok(users[1].includes('踩點、失手、翻牆'), users[1].slice(0, 2000));
  });

  // 上游是這一章的梗概（大綱裡這一章那一條），不是全書的指紋。
  test('細綱記下這一章梗概的指紋', async () => {
    const plot = await project.getPlot(1);
    assert.equal(plot.upstreamHash, bundle.plotFile.plotSynopsisHash('林昭進入青雲宗。'));
  });

  test('系統提示是劇情編劇的身份', () => {
    assert.ok(sys.includes('劇情編劇'), sys.slice(0, 60));
  });

  test('裝配帶上了情節大綱', () => {
    assert.ok(users[0].includes('林昭進入青雲宗'));
  });

  test('細綱階段不帶正文全文', () => {
    assert.ok(!users[0].includes('# 前文正文'), users[0].slice(0, 200));
  });

  // 契約是藍圖合同：小標題對到細綱的七節（連續性事實除外，定稿時才有），外加敘事線。從前那條
  // 「不寫畫面臺詞」的禁令刪掉了——關鍵事件可以寫到具體場面。細綱試點起按小標題寫，不寫 JSON。
  test('細綱契約是藍圖合同：小標題對到細綱的七節', () => {
    for (const key of ['梗概', '出场人物', '时间地点', '关键事件', '看点', '叙事线', '状态变更']) {
      assert.ok(users[0].includes(loadModule('src/core/model/labels.ts').traditionalLabel(key)), `契約裡沒有 ${key}：${users[0].slice(-600)}`);
    }
  });

  // 目的並進了梗概、章末鉤子並進了看點，合同裡不再單列。
  test('細綱契約不再要 purpose / suspenseHook', () => {
    assert.ok(!/purpose|suspenseHook/.test(users[0]), users[0].slice(-600));
  });

  test('細綱契約不再要老四節', () => {
    assert.ok(!/"劇情脈絡"|"衝突與轉折"/.test(users[0]), users[0].slice(-600));
  });

  test('沒有缺口時不調模型', () => {
    assert.equal(callCountAgain, 0, `調了 ${callCountAgain} 次`);
  });

  test('沒有缺口時給出說明', () => {
    assert.ok(toastsAgain.some((x) => x.includes('都已經排過細綱了')), toastsAgain.join('|'));
  });
});

describe('批次拆細綱 · 一批失敗就停', () => {
  let calls;
  let users;
  let toastsSnapshot;
  let failures;
  let plotsAfter;

  before(async () => {
    // 這一組要第 6 章以後的章：總章數臨時放到 30。
    t.write('.novelwarden/config.md', CONFIG.replace('totalChapters: 3', 'totalChapters: 30'));
    project.invalidate();
    configure();
    // 模型返回一段廢話——嚴格解碼認不出，絕不能寫盤：介面上會顯示「已規劃」，
    // 而裡面什麼都沒有。拆半、單章重建都救不回來。
    replyFn = () => '我不太確定這幾章要寫什麼。';
    // 彈窗已經把切分與呼叫次數報過了：不再彈第二個確認框。
    await bundle.batch.generatePlots(project, { range: { from: 6, to: 12 }, call: {} });
    calls = fake.calls.length;
    users = fake.calls.map((c) => c.find((m) => m.role === 'user').content);
    toastsSnapshot = [...h.toasts];
    await sleep(50);
    failures = await bundle.errorLog.listActiveFailures(project);
    // 第 6 章以後本來就有隻有梗概的空殼（大綱是各章梗概的彙總）：看的是有沒有一份被排過。
    plotsAfter = (await project.listPlots()).filter((p) => bundle.plotFile.isPlotFilled(p.sections)).map((p) => p.no);
    t.write('.novelwarden/config.md', CONFIG);
    project.invalidate();
  });

  test('彈窗確認過的不再彈確認框', () => {
    assert.equal(h.confirms.length, 0, JSON.stringify(h.confirms));
  });

  // 第 6–10 章一批：整批解不出 → 拆出第 6–7 章 → 拆出第 6 章 → 單章重建 → 仍不行，停。
  test('降級鏈走到頭就停，只調了 4 次', () => {
    assert.equal(calls, 4, users.map((u) => u.slice(-120)).join('\n'));
  });

  // 後一批（第 11–12 章）要接著前一批往下排，前一批沒成就不跑。
  test('後一批沒有跑', () => {
    assert.ok(!users.some((u) => u.includes('第 11–12 章')), users.map((u) => u.slice(-200)).join('\n'));
  });

  test('一份細綱都沒寫（空殼還是空殼）', () => {
    assert.ok(!plotsAfter.some((no) => no >= 6), plotsAfter.join(','));
  });

  test('失敗掛在那一批第一章的細綱上', () => {
    assert.ok(!!failures['.novelwarden/summaries/006.md'], JSON.stringify(Object.keys(failures)));
  });

  test('toast 說清停在哪', () => {
    assert.ok(toastsSnapshot.some((x) => x.includes('第 6–10 章的細綱沒拆成') && x.includes('已停下')), toastsSnapshot.join('|'));
  });
});

// 批次寫章（四期改成嚴格序列：續寫鏈、寫完即定稿、失敗即停、章間停下）在 writeBatch.test.js。

// 敘事線重做（設計稿 ⚑8）：批次拆細綱開跑時一條線都沒有，先從情節大綱排一次（確認框寫明 +1）；沒排成不擋拆細綱。
describe('批次拆細綱 · 一條敘事線都沒有', () => {
  let confirm;
  let returned;
  let systems;
  let toasts;

  before(async () => {
    t.write('.novelwarden/config.md', CONFIG.replace('totalChapters: 3', 'totalChapters: 30'));
    t.remove('.novelwarden/threads');
    project.invalidate();
    configure();
    replyFn = (messages) =>
      messages[0].content.includes(PLAN_MARK)
        ? JSON.stringify({ threads: [{ title: '林昭與沈青', kind: '感情线', from: 4, to: 20, intent: '從猜忌到並肩。' }] })
        : blueprintsFor(messages);
    h.answers.push('開始拆細綱');
    returned = await bundle.batch.generatePlots(project, { range: { from: 4, to: 4 } });
    confirm = h.confirms[0];
    systems = fake.calls.map((c) => c[0].content);
    toasts = [...h.toasts];
  });

  test('確認框把先排的那一次算進去，說清沒排成不擋拆細綱', () => {
    // 排線 2 次（排 1、轉寫 1；最多 3）+ 一批 1 章 2 次（最多 5）：2026-10-25 起排線也轉寫。
    assert.ok(confirm?.message.includes('要拆 1 章細綱，分 1 批，預計 4 次呼叫，最多 8 次'), confirm?.message);
    assert.ok(confirm.detail.includes('還沒有一條敘事線：開拆之前先從情節大綱排一次（排 1 次、轉寫 1 次'), confirm.detail);
  });

  test('先排線、再拆細綱；返回兩次', () => {
    assert.equal(systems.length, 2);
    assert.ok(systems[0].includes(PLAN_MARK), systems[0].slice(0, 80));
    assert.ok(systems[1].includes('劇情編劇'), systems[1].slice(0, 80));
    assert.equal(returned, 2);
  });

  test('線寫進了敘事線目錄，細綱也寫好了；完成提示裡說了排出幾條', async () => {
    assert.ok(t.has('.novelwarden/threads/林昭與沈青.md'));
    assert.ok(bundle.plotFile.isPlotFilled((await project.getPlot(4)).sections));
    assert.ok(toasts.some((x) => x.includes('寫好 1 章細綱') && x.includes('排出 1 條敘事線')), toasts.join('|'));
  });

  test('有線了再拆就不先排', async () => {
    configure();
    h.answers.push('開始拆細綱');
    await bundle.batch.generatePlots(project, { range: { from: 5, to: 5 } });
    assert.ok(h.confirms[0].message.includes('預計 2 次呼叫'), h.confirms[0].message);
    assert.ok(!fake.calls.some((c) => c[0].content.includes(PLAN_MARK)));
  });

  test('排線沒排成不擋拆細綱：細綱照寫，提示裡說一句，紅 ❗ 掛在敘事線目錄上', async () => {
    t.remove('.novelwarden/threads');
    project.invalidate();
    configure();
    replyFn = (messages) => (messages[0].content.includes(PLAN_MARK) ? '我想不出來。' : blueprintsFor(messages));
    await bundle.batch.generatePlots(project, { range: { from: 6, to: 6 }, call: {} });
    assert.ok(bundle.plotFile.isPlotFilled((await project.getPlot(6)).sections));
    assert.ok(h.toasts.some((x) => x.includes('敘事線沒排成')), h.toasts.join('|'));
    await sleep(50);
    const failures = await bundle.errorLog.listActiveFailures(project);
    assert.equal(failures['.novelwarden/threads']?.[0]?.severity, 'error');
  });

  after(() => {
    t.write('.novelwarden/config.md', CONFIG);
    t.write(THREAD, '---\nkind: 主線\n---\n\n# 青雲舊案\n\n## 意圖\n十年前那把火。\n');
    project.invalidate();
  });
});

describe('使用者取消', () => {
  let callCount;
  let stillSkeleton;
  let writeCalls;

  before(async () => {
    configure();
    await skeleton(1, '楔子');
    // answers 空著 = 使用者點了 ×。
    await bundle.batch.generatePlots(project);
    callCount = fake.calls.length;
    const plot = await project.readPlot('.novelwarden/summaries/001-楔子.md');
    stillSkeleton = !bundle.plotFile.isPlotFilled(plot.sections);

    // 寫正文那一條同樣：取消 = 一次都不調。
    await wsOf(project).writePlot({
      no: 6, title: '雪夜', upstreamHash: '', done: false,
      sections: { ...bundle.plotFile.emptyPlotSections(), 关键事件: '雪下了一夜。' },
    });
    configure();
    await bundle.batch.writeManuscripts(project);
    writeCalls = fake.calls.length;
  });

  test('取消後不調模型', () => {
    assert.equal(callCount, 0, `調了 ${callCount} 次`);
  });

  test('取消後不寫盤', () => {
    assert.ok(stillSkeleton);
  });

  test('取消批次寫正文也不調模型、不建章節', async () => {
    assert.equal(writeCalls, 0, `調了 ${writeCalls} 次`);
    assert.ok(!(await project.listChapters()).some((c) => c.order === 6));
  });
});
