/**
 * `write` 工具：agent 的落盤口。
 *
 * 這裡釘五件事，每一件都是這一層特有的（寫盤本身的行為由
 * `tests/integration/workspace/*.test.js` 守著）：
 *
 * 1. **`review` 永遠 true，且不是工具引數**——模型沒有關掉審閱的口子。
 *    細綱與正文（`chapters/` 下的章節）走的是同一個閘道器、同一張審閱框。
 * 2. **draftId 找不到 / 是討論類產出 → error，絕不靜默寫空檔案。**
 * 3. **作者拒絕 → 磁碟一字未改，且回給模型的話要說清「沒有採納」**，
 *    否則它會原地重試同一個動作。
 * 4. **守衛照舊攔**：越界、受保護路徑、同名不覆蓋，一條都不放行。
 * 5. **寫失敗掛一條失敗記錄**（第 16 條），成功清掉。
 *
 * 順帶釘住一期下沉到寫入路徑上的記賬：細綱的 `upstreamHash` 記的是**大綱裡覆蓋
 * 本章那一節**的指紋，不是全書大綱的——續寫後面一段大綱不該讓前面的細綱掛 ⟳。
 *
 * 細綱在 `.novelwarden/summaries/NNN-標題.md`（與單章摘要併成了一份，七節）；老工程的
 * `plots/` 不再是細綱，細綱草稿寫不進去。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');
const { outlineOf } = require('../../helpers/outline');

let bundle;
let t;
let project;
let h;
let ctx;
/** DraftStore 的替身：按 id 取。 */
let drafts;
let reports;

const PLOT_REL = '.novelwarden/summaries/001-夜入青雲.md';
const PLOT2_REL = '.novelwarden/summaries/002-藏書閣.md';
const CHAPTER_REL = 'chapters/003-雪夜.md';
/** 兩節的大綱：第 1 章落在前一節裡。 */
const OUTLINE = outlineOf(40, { title: '大綱', text: { 1: '林昭入宗。', 21: '林昭下山。' } });

const tool = () => bundle.tools.NOVEL_TOOLS.find((x) => x.name === 'write');
const run = (args) => tool().run(ctx, args);

/**
 * 一份「已解析出結構化產物」的細綱草稿：七節裡排了四節，出場的人就寫在「出場人物」一節裡
 * （產物上沒有單獨的 characters 欄位）。
 */
function plotDraft(id, sections) {
  return {
    id,
    action: { stage: 'plot', capability: 'generate' },
    target: { kind: 'plot', plotRelPath: PLOT_REL },
    raw: '…',
    artifact: { kind: 'plot', sections, title: '模型起的名字' },
    summary: '細綱 · 4/8 節',
    words: 620,
    createdAt: new Date().toISOString(),
  };
}

function sections(events) {
  return {
    ...bundle.plotFile.emptyPlotSections(),
    梗概: '林昭進入宗門',
    出场人物: '林昭、沈青',
    关键事件: events,
    看点: '第三塊令牌',
  };
}

function resetCtx() {
  reports = [];
  ctx = {
    project,
    workspace: new bundle.ws.Workspace(project),
    drafts: { get: (id) => drafts.get(id), put: () => {}, bySession: () => [] },
    sessionId: 's1',
    signal: new AbortController().signal,
    usage: { calls: 0, record(n) { this.calls += n; } },
    report: (m) => reports.push(m),
    onDelta: () => {},
  };
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    plotFile: './src/core/model/plotFile.ts',
    outlineFile: './src/core/model/outlineFile.ts',
    tools: './src/core/tools/novel/index.ts',
    errorLog: './src/core/runtime/errorLog.ts',
    db: './src/core/runtime/db.ts',
  });

  h = makeFakeHost({ name: 'standalone', settings: () => ({}) });
  bundle.host.initHost(h.host);

  t = await makeTempProject(bundle.project, { prefix: 'agentwrite', title: '青雲劍錄' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  // 大綱要有內容，upstreamHash 才記得上（空大綱不該憑空標髒）。
  await ws.write(project.relPath(project.outlinePath), { text: OUTLINE }, { mode: 'overwrite' });
  for (const [no, title] of [[1, '夜入青雲'], [2, '藏書閣']]) {
    // 只寫了梗概、「關鍵事件」空著：還沒排過，落盤前後的「排過沒有」由它對照。
    await ws.writePlot({
      no,
      title,
      upstreamHash: '',
      done: false,
      sections: { ...bundle.plotFile.emptyPlotSections(), 梗概: '林昭進入宗門' },
    });
  }
  await project.syncManifest();

  drafts = new Map([
    ['d-plot', plotDraft('d-plot', sections('踩點、失手、翻牆；收在藏書閣門口。'))],
    ['d-plot2', plotDraft('d-plot2', sections('第二版：先探後翻。'))],
    // 討論類產出：沒有 artifact。
    [
      'd-talk',
      {
        id: 'd-talk',
        action: { stage: 'plot', capability: 'discuss' },
        target: { kind: 'plot', plotRelPath: PLOT_REL },
        raw: '這一章的動機不夠。',
        words: 9,
        createdAt: new Date().toISOString(),
      },
    ],
  ]);
  resetCtx();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('用 draftId 寫一份細綱', () => {
  let r;

  before(async () => {
    resetCtx();
    h.expect();
    r = await run({ path: PLOT_REL, draftId: 'd-plot', mode: 'overwrite' });
  });

  test('沒有 error', () => {
    assert.equal(r.error, undefined, r.error);
  });

  test('內容真的落盤了', async () => {
    const plot = await project.readPlot(PLOT_REL);
    assert.ok(plot.sections.关键事件.includes('踩點、失手、翻牆'), JSON.stringify(plot.sections));
  });

  // 一期把記賬下沉到寫入路徑本身：誰寫都記。
  test('upstreamHash 記上了', async () => {
    const plot = await project.readPlot(PLOT_REL);
    assert.ok(plot.upstreamHash, JSON.stringify(plot.upstreamHash));
  });

  // ★ 記的是這一章梗概（大綱裡第 1 章那一條）的指紋：以後改別的章那一條，第 1 章不掛 ⟳。
  test('upstreamHash 是這一章梗概的指紋，不是全書的', async () => {
    const plot = await project.readPlot(PLOT_REL);
    assert.equal(plot.upstreamHash, bundle.plotFile.plotSynopsisHash(plot.sections.梗概));
  });

  test('標題沒被抹掉（重寫細綱不動作者起的名字）', async () => {
    const plot = await project.readPlot(PLOT_REL);
    assert.equal(plot.title, '夜入青雲');
  });

  // 計劃出場的人寫在「出場人物」一節裡，跟著產物落盤；還沒定稿的細綱，characters 就從這一節讀。
  test('計劃出場的人隨「出場人物」一節落盤', async () => {
    const plot = await project.readPlot(PLOT_REL);
    assert.deepEqual(plot.characters, ['林昭', '沈青']);
  });

  test('返回文字裡有落點與字數', () => {
    assert.ok(r.text.includes(PLOT_REL), r.text);
    assert.ok(/\d+ 字/.test(r.text), r.text);
  });

  test('display 給介面畫一行', () => {
    assert.ok(r.display && r.display.title.includes('write'), JSON.stringify(r.display));
  });
});

describe('覆蓋已有內容一定先請作者過目', () => {
  test('作者同意就覆蓋', async () => {
    resetCtx();
    h.setReviewVerdict('apply');
    h.expect();
    const r = await run({ path: PLOT_REL, draftId: 'd-plot2', mode: 'overwrite' });
    assert.equal(r.error, undefined, r.error);
    const plot = await project.readPlot(PLOT_REL);
    assert.ok(plot.sections.关键事件.includes('先探後翻'), JSON.stringify(plot.sections));
  });

  test('確實彈了審閱（不是默默覆蓋）', () => {
    assert.equal(h.reviewed.length, 1, JSON.stringify(h.reviewed.map((x) => x.name)));
  });

  // 細綱號 = 章號：框上說「第 1 章的細綱」，與創作頁、工程頁是同一個說法，
  // 框裡緊接著還要顯示路徑，兩者對得上作者才認得出是同一份檔案。
  test('審閱框上寫的是「第 1 章的細綱」而不是路徑', () => {
    assert.equal(h.reviewed[0].name, '第 1 章的細綱');
  });

  let rejected;
  test('作者拒絕時磁碟一字未改', async () => {
    resetCtx();
    h.setReviewVerdict('discard');
    h.expect();
    rejected = await run({ path: PLOT_REL, draftId: 'd-plot', mode: 'overwrite' });
    const plot = await project.readPlot(PLOT_REL);
    assert.ok(plot.sections.关键事件.includes('先探後翻'), JSON.stringify(plot.sections));
  });

  // 不說清楚它會原地重試——那是最常見的燒錢方式。
  test('回給模型的話說清了作者沒有採納', () => {
    assert.ok(rejected.text.includes('沒有採納'), rejected.text);
  });

  test('還明說了不要重試同一個動作', () => {
    assert.ok(rejected.text.includes('不要重試'), rejected.text);
  });

  test('拒絕不算 error（那是作者的決定，不是故障）', () => {
    assert.equal(rejected.error, undefined, rejected.error);
  });
});

/**
 * 一章一綱之後正文直接落 `chapters/`：章節是作者的檔案（第 9 條），覆蓋它比覆蓋
 * 一份細綱更要緊，所以同一張審閱框必須照樣彈。
 */
describe('正文（章節）走同一個閘道器', () => {
  test('新建一章不打擾作者', async () => {
    resetCtx();
    h.setReviewVerdict('apply');
    h.expect();
    const r = await run({ path: CHAPTER_REL, content: '雪下了一夜。' });
    assert.equal(r.error, undefined, r.error);
    assert.equal(h.reviewed.length, 0, JSON.stringify(h.reviewed.map((x) => x.name)));
    assert.ok(t.read(CHAPTER_REL).includes('雪下了一夜'), t.read(CHAPTER_REL));
  });

  test('新建的章節進了章節列表', async () => {
    const chapters = await project.listChapters();
    assert.ok(chapters.some((c) => c.relPath === CHAPTER_REL && c.order === 3), JSON.stringify(chapters.map((c) => c.relPath)));
  });

  test('覆蓋一章正文先請作者過目，框上寫「第 3 章」', async () => {
    resetCtx();
    h.setReviewVerdict('discard');
    h.expect();
    const r = await run({ path: CHAPTER_REL, content: '整章換掉。', mode: 'overwrite' });
    assert.equal(h.reviewed.length, 1, JSON.stringify(h.reviewed.map((x) => x.name)));
    assert.equal(h.reviewed[0].name, '第 3 章');
    assert.ok(r.text.includes('沒有採納'), r.text);
  });

  test('作者拒絕後正文一字未改', () => {
    assert.ok(t.read(CHAPTER_REL).includes('雪下了一夜') && !t.read(CHAPTER_REL).includes('整章換掉'), t.read(CHAPTER_REL));
  });

  // 追加是寫正文的常態（「接著寫」），不打擾作者。
  test('追加不彈審閱', async () => {
    resetCtx();
    h.setReviewVerdict('apply');
    h.expect();
    const r = await run({ path: CHAPTER_REL, content: '天亮了。', mode: 'append' });
    assert.equal(r.error, undefined, r.error);
    assert.equal(h.reviewed.length, 0);
    assert.ok(t.read(CHAPTER_REL).includes('天亮了'), t.read(CHAPTER_REL));
  });
});

describe('draftId 認不出來', () => {
  let r;

  before(async () => {
    resetCtx();
    h.setReviewVerdict('apply');
    h.expect();
    r = await run({ path: PLOT2_REL, draftId: '並不存在', mode: 'overwrite' });
  });

  test('給 error', () => {
    assert.ok(r.error, JSON.stringify(r));
  });

  // 靜默降級成寫空檔案，等於把一份細綱抹平。
  test('沒寫盤', async () => {
    const plot = await project.readPlot(PLOT2_REL);
    assert.ok(!bundle.plotFile.isPlotFilled(plot.sections), JSON.stringify(plot.sections));
  });

  test('error 裡說了該怎麼辦', () => {
    assert.ok(r.error.includes('generate') || r.error.includes('content'), r.error);
  });
});

describe('討論類 draft 不能寫成產物', () => {
  let r;

  before(async () => {
    resetCtx();
    h.expect();
    r = await run({ path: PLOT2_REL, draftId: 'd-talk', mode: 'overwrite' });
  });

  test('給 error', () => {
    assert.ok(r.error, JSON.stringify(r));
  });

  test('沒寫盤', async () => {
    const plot = await project.readPlot(PLOT2_REL);
    assert.ok(!bundle.plotFile.isPlotFilled(plot.sections), JSON.stringify(plot.sections));
  });

  test('error 說清了它是討論類產出', () => {
    assert.ok(/討論|挑刺/.test(r.error), r.error);
  });
});

/**
 * 細綱的家是 `summaries/NNN-標題.md`；老工程的 `plots/` 判成 other，流水線不讀。agent 照著
 * 老提示詞把細綱草稿往那裡寫，寫進去也是一份沒人認的檔案——要當場攔下，而不是默默落一份。
 */
describe('老的 plots/ 路徑不接細綱草稿', () => {
  const LEGACY_REL = '.novelwarden/plots/001-夜入青雲.md';
  let r;

  before(async () => {
    resetCtx();
    h.setReviewVerdict('apply');
    h.expect();
    r = await run({ path: LEGACY_REL, draftId: 'd-plot', mode: 'overwrite' });
  });

  test('給 error', () => {
    assert.ok(r.error, JSON.stringify(r));
  });

  test('沒寫盤', () => {
    assert.ok(!t.has(LEGACY_REL));
  });
});

describe('八條守衛照舊攔著', () => {
  test('越界路徑給 error', async () => {
    resetCtx();
    const r = await run({ path: '../../etc/passwd', content: 'x', mode: 'overwrite' });
    assert.ok(r.error, JSON.stringify(r));
    assert.ok(r.error.includes('工程目錄'), r.error);
  });

  test('絕對路徑給 error', async () => {
    resetCtx();
    const r = await run({ path: '/tmp/x.md', content: 'x', mode: 'overwrite' });
    assert.ok(r.error, JSON.stringify(r));
  });

  test('寫進回收站給 error', async () => {
    resetCtx();
    const r = await run({ path: '.novelwarden/.trash/x.md', content: 'x', mode: 'overwrite' });
    assert.ok(r.error, JSON.stringify(r));
  });

  test('固定目錄本身給 error', async () => {
    resetCtx();
    const r = await run({ path: '.novelwarden/summaries', content: 'x', mode: 'overwrite' });
    assert.ok(r.error, JSON.stringify(r));
  });

  test('mode=create 撞上已有檔案給 error，並指路到 overwrite', async () => {
    resetCtx();
    const r = await run({ path: PLOT_REL, content: 'x' });
    assert.ok(r.error, JSON.stringify(r));
    assert.ok(r.error.includes('overwrite'), r.error);
  });

  test('create 撞名時磁碟沒被動過', async () => {
    const plot = await project.readPlot(PLOT_REL);
    assert.ok(plot.sections.关键事件.includes('先探後翻'), JSON.stringify(plot.sections));
  });
});

describe('寫失敗要留在出錯的東西身上', () => {
  before(async () => {
    resetCtx();
    await bundle.errorLog.clearFailures(project, 'plot', PLOT2_REL, 'mcpWrite');
    // create 撞上已有檔案：守衛攔下，這一章一字未改，但作者要看得出「剛才那一下沒成」。
    await run({ path: PLOT2_REL, content: 'x' });
  });

  test('errorLog 裡掛上了一條', async () => {
    const byTarget = await bundle.errorLog.listActiveFailures(project);
    assert.ok(byTarget[PLOT2_REL], JSON.stringify(Object.keys(byTarget)));
  });

  test('掛在那一章的細綱上，而且寫清了是哪個動作', async () => {
    const byTarget = await bundle.errorLog.listActiveFailures(project);
    assert.ok(byTarget[PLOT2_REL].some((f) => f.message.includes('寫入')), JSON.stringify(byTarget[PLOT2_REL]));
  });

  // 修好了還掛著標記，使用者會學會無視它。
  test('成功一次就清掉', async () => {
    resetCtx();
    h.setReviewVerdict('apply');
    h.expect();
    await run({ path: PLOT2_REL, draftId: 'd-plot', mode: 'overwrite' });
    const byTarget = await bundle.errorLog.listActiveFailures(project);
    assert.equal(byTarget[PLOT2_REL], undefined, JSON.stringify(byTarget[PLOT2_REL]));
  });
});

describe('引數本身', () => {
  test('path 必填', async () => {
    resetCtx();
    const r = await run({ content: 'x' });
    assert.ok(r.error && r.error.includes('path'), JSON.stringify(r));
  });

  test('draftId 與 content 都不給就 error', async () => {
    resetCtx();
    const r = await run({ path: PLOT2_REL });
    assert.ok(r.error, JSON.stringify(r));
  });

  test('draftId 與 content 都給也 error（不猜它想寫哪個）', async () => {
    resetCtx();
    const r = await run({ path: PLOT2_REL, draftId: 'd-plot', content: 'x' });
    assert.ok(r.error, JSON.stringify(r));
  });

  test('認不出的 mode 給 error', async () => {
    resetCtx();
    const r = await run({ path: PLOT2_REL, content: 'x', mode: '強制覆蓋' });
    assert.ok(r.error && r.error.includes('mode'), JSON.stringify(r));
  });
});

describe('工具定義本身', () => {
  test('標了 mutating', () => {
    assert.equal(tool().mutating, true);
  });

  test('不標 costly（寫盤不調模型）', () => {
    assert.ok(!tool().costly, String(tool().costly));
  });

  // ★ 模型不該有關掉審閱的口子。
  test('review 不是工具引數', () => {
    assert.ok(!('review' in tool().parameters.properties), JSON.stringify(tool().parameters.properties));
  });

  test('引數是扁平的四個標量', () => {
    const props = tool().parameters.properties;
    assert.deepEqual(Object.keys(props).sort(), ['content', 'draftId', 'mode', 'path']);
    assert.ok(Object.values(props).every((p) => p.type !== 'object'), JSON.stringify(props));
  });

  test('描述裡說清了覆蓋會請作者過目', () => {
    assert.ok(tool().description.includes('過目') || tool().description.includes('審閱'), tool().description);
  });

  // 刪除/改名/移動收益接近零，誤操作的收拾成本極高。
  test('描述裡明說沒有刪除/改名/移動', () => {
    assert.ok(tool().description.includes('刪除'), tool().description);
  });
});
