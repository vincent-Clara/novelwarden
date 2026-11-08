/**
 * 創作流水線的資料層：路徑規則、細綱讀寫、改名、新鮮度鏈、流水線索引、全書事實、工作區卡。
 *
 * 一章一綱之後只有**一條軸**：細綱號 = 章號。細綱**映象正文在章節根下的相對路徑**
 * （`chapters/第一卷/003-深處.txt` ↔ `summaries/第一卷/003-深處.md`），有正文的章按路徑認它的細綱，
 * 還沒有正文的章按號認計劃；定稿反向更新的也是同一份細綱，不再另寫一份單章摘要。從前的卷、
 * 劇情段位次、中轉站 `manuscripts/`、拆章與 `plots/` 都不讀了；老工程磁碟上的那幾個目錄一個位元組都不動，
 * 程式碼只是不再讀它們。
 *
 * 章節那一側的讀寫（掃描、副檔名、草稿）另見 tests/integration/files/chapters.test.js。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');
const { outlineOf, writeOutline } = require('../../helpers/outline');

let wsMod;
const wsOf = (p) => new wsMod.Workspace(p);

let bundle;
let h;
let t;
let project;
const dirs = [];

/** 一份排過的細綱（「關鍵事件」非空，isPlotFilled 才認）。 */
const filledSections = (extra = {}) => ({
  ...bundle.plotFile.emptyPlotSections(),
  梗概: '林昭成功進入青雲宗。',
  关键事件: '他在山門外等到天黑，翻過側峰，被巡邏的人撞見。',
  看点: '他站在藏書閣門口，門裡亮著燈。',
  ...extra,
});

/** 一份最小的可寫細綱。 */
const writable = (no, title, extra = {}) => ({
  no, title, upstreamHash: '', done: false, sections: filledSections(), ...extra,
});

/** 定稿時模型答回來的七節（反向更新之後的樣子）。 */
const FINALIZED = (extra = {}) => ({
  ...bundle.plotFile.emptyPlotSections(),
  梗概: '夜入青雲。',
  出场人物: '林昭',
  关键事件: '等、翻、被撞見。',
  看点: '- 藏書閣門裡亮著燈。',
  ...extra,
});

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    fs: './src/core/model/fs.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    plotFile: './src/core/model/plotFile.ts',
    outlineFile: './src/core/model/outlineFile.ts',
    model: './src/core/model/pipeline.ts',
    pipe: './src/core/views/pipeline.ts',
    workbench: './src/core/views/workbench.ts',
    guard: './src/core/workspace/guard.ts',
    kind: './src/core/workspace/kind.ts',
    logger: './src/core/runtime/logger.ts',
  });
  wsMod = bundle.ws;
  h = makeFakeHost({ settings: () => ({}), overrides: { reviewReplace: undefined } });
  bundle.host.initHost(h.host);
  t = await makeTempProject(bundle.project, {
    prefix: 'pipeline',
    title: '青雲劍錄',
    keepExamples: true,
  });
  dirs.push(t.dir);
  project = t.project;
});

after(() => {
  for (const dir of dirs) {
    cleanup(dir);
  }
});

describe('資料層 · 目錄與路徑規則', () => {
  const plot = '.novelwarden/summaries/012-夜入青雲.md';

  // 細綱與全文大綱（global.md）都在 summaries/。
  test('初始化建出 summaries/', () => {
    assert.ok(t.has('.novelwarden/summaries'));
  });

  // 卷與中轉站兩層刪掉了，細綱也搬出了 plots/：新工程不再建那幾個目錄（老工程裡的原樣留著，見 guard.ts）。
  test('初始化不再建 volumes/、manuscripts/ 與 plots/', () => {
    assert.ok(!t.has('.novelwarden/volumes') && !t.has('.novelwarden/manuscripts') && !t.has('.novelwarden/plots'));
  });

  // 架構三件寫空模板：結構完整、全是佔位，狀態機於是從「生成小說配置」開始。
  test('初始化寫入架構三件的空模板', () => {
    for (const rel of ['.novelwarden/config.md', '.novelwarden/premise.md', '.novelwarden/world.md']) {
      assert.ok(t.has(rel), rel);
    }
  });

  test('空模板都不算填過', async () => {
    assert.deepEqual(await project.settingFilled(), {
      config: false, premise: false, characters: false, world: false, lore: false,
    });
  });

  // 細綱映象正文在章節根下的相對路徑，副檔名換成 .md（與草稿同一套）。
  test('正文 → 細綱：相對路徑相同，副檔名換成 .md', () => {
    assert.equal(project.plotPathForChapter('chapters/012-夜入青雲.md'), plot);
    assert.equal(project.plotPathForChapter('chapters/第一卷/003-深處.txt'), '.novelwarden/summaries/第一卷/003-深處.md');
    assert.equal(project.plotPathForChapter('chapters/001 序'), '.novelwarden/summaries/001 序.md');
  });

  test('細綱 → 照它寫出來的正文：反推回章節根', () => {
    assert.equal(project.chapterPathForPlot('.novelwarden/summaries/第二卷/010-雪夜.md'), 'chapters/第二卷/010-雪夜.txt');
    assert.equal(project.chapterPathForPlot('chapters/010-雪夜.md'), undefined);
  });

  // 前面一章都沒有時落在根下。「第 9 章」是 `listChapters` 給無標題章的回落值——那是沒有名字，不是名字。
  test('還沒有正文也沒有細綱的章：落在根下，回落標題不進檔名', async () => {
    assert.equal(await project.plotPathForNewChapter(12, '夜入青雲'), plot);
    assert.equal(await project.plotPathForNewChapter(9, '第 9 章'), '.novelwarden/summaries/009.md');
  });
});

describe('資料層 · 細綱讀寫', () => {
  let plotRel;
  let noPlot;
  let plotBack;
  let listed;
  let nextNo;

  before(async () => {
    noPlot = await project.readPlot('.novelwarden/summaries/012-夜入青雲.md');
    nextNo = await project.nextPlotNo();

    plotRel = await wsOf(project).writePlot(writable(12, '夜入青雲', {
      sections: filledSections({ 出场人物: '林昭、沈青' }),
      targetWords: 3000,
      upstreamHash: 'OUTLINE_A',
    }));
    plotBack = await project.readPlot(plotRel);
    listed = await project.listPlots();
  });

  test('沒寫過時讀不出細綱', () => {
    assert.equal(noPlot, undefined);
  });

  test('空工程的下一章是第 1 章', () => {
    assert.equal(nextNo, 1);
  });

  test('沒有正文、前面也沒有章：細綱落在 summaries/ 根下，名字帶三位序號', () => {
    assert.equal(plotRel, '.novelwarden/summaries/012-夜入青雲.md', plotRel);
  });

  test('七節讀得回來', () => {
    assert.equal(plotBack.sections.梗概, '林昭成功進入青雲宗。');
    assert.ok(plotBack.sections.关键事件.includes('翻過側峰'), plotBack.sections.关键事件);
    assert.ok(plotBack.sections.看点.includes('藏書閣'), plotBack.sections.看点);
  });

  test('章號來自檔名', () => {
    assert.equal(plotBack.no, 12);
  });

  test('目標字數讀得回來（狀態機拿它判「寫夠沒有」）', () => {
    assert.equal(plotBack.targetWords, 3000);
  });

  // 沒定稿時「出場人物」寫的是計劃出場：挑角色卡、預檢用，按頓號切出名字。
  test('計劃出場從「出場人物」一節讀回來', () => {
    assert.deepEqual(plotBack.characters, ['林昭', '沈青']);
  });

  test('還沒定稿：sourceHash 是空串', () => {
    assert.equal(plotBack.sourceHash, '');
  });

  test('listPlots 列得到它', () => {
    assert.equal(listed.filter((p) => p.no === 12).length, 1, JSON.stringify(listed.map((p) => p.no)));
  });

  // 跨細綱與 chapters/ 取最大號 +1（見 NovelProject.nextPlotNo 的註釋）。
  test('有第 12 章細綱之後，新建細綱落到第 13 章', async () => {
    assert.equal(await project.nextPlotNo(), 13);
  });
});

/**
 * 老工程留下的東西：`plots/` 裡的細綱、`summaries/` 子目錄裡按章節路徑映象的單章摘要、老四節格式的
 * 細綱、`summaries/` 根下的老單章摘要。**解析一律不拋**（第 1 條），讀進來如實退化，那些檔案一個位元組
 * 都不動。`plots/` 不做遷移（作者定案 2）：判成 other，不讀、不顯示、不刪，目錄守衛照舊攔著；
 * `summaries/` 下的老摘要（根下與子目錄裡的）本來就映象正文的路徑、就是這七節、帶著 sourceHash 與 cast，
 * 直接當成定稿過的細綱。
 */
describe('資料層 · 老工程留下的檔案', () => {
  const LEGACY_PLOT = '.novelwarden/plots/007-老細綱.md';
  const LEGACY_PLOT_TEXT =
    '---\nno: 7\ntitle: 老細綱\nrole: 開篇\n---\n\n## 本章目的\n\n進宗門\n\n## 關鍵事件\n\n甲、乙、丙。\n\n## 章末鉤子\n\n門裡有人。\n';
  const NESTED = '.novelwarden/summaries/卷一/001-高燒.md';
  const OLD = '.novelwarden/summaries/008-老格式.md';
  const OLD_TEXT = '---\nno: 8\ntitle: 老格式\n---\n\n## 目標\n\n進宗門\n\n## 劇情脈絡\n\n甲、乙、丙。\n';
  const OLD_SUMMARY = '.novelwarden/summaries/009-舊摘要.md';
  let listed;
  let index;
  let old;
  let oldPipe;
  let oldSummary;
  let oldSummaryPipe;

  before(async () => {
    t.write(LEGACY_PLOT, LEGACY_PLOT_TEXT);
    t.write(NESTED, '---\nchapter: 1\nsourceHash: x\n---\n\n## 關鍵事件\n\n老卷裡的一章。\n');
    t.write(OLD, OLD_TEXT);
    // 老工程的單章摘要：frontmatter 記的是 `chapter:`，帶 sourceHash 與 cast，小節本來就是七節裡的那幾節。
    t.write('chapters/009-舊摘要.md', '# 舊摘要\n\n他回到鎮上。\n');
    project.invalidate();
    const chapter9 = (await project.listChapters()).find((c) => c.order === 9);
    t.write(
      OLD_SUMMARY,
      `---\nchapter: 9\nsourceHash: ${chapter9.contentHash}\ncast: [林昭(阿昭)]\ngeneratedBy: novelwarden\n---\n\n` +
        '# 第9章 舊摘要 · 摘要\n\n## 梗概\n\n他回到鎮上。\n\n## 出場人物\n\n林昭\n\n## 關鍵事件\n\n回鎮。\n'
    );
    project.invalidate();
    listed = await project.listPlots();
    index = await bundle.pipe.buildPipelineIndex(project);
    old = await project.readPlot(OLD);
    oldPipe = await bundle.pipe.buildPlotPipeline(project, { no: 8, plot: old });
    oldSummary = listed.find((p) => p.relPath === OLD_SUMMARY);
    oldSummaryPipe = index.byNo.get(9);
  });

  after(() => {
    t.remove('.novelwarden/plots');
    t.remove('.novelwarden/summaries/卷一');
    t.remove(OLD);
    t.remove(OLD_SUMMARY);
    t.remove('chapters/009-舊摘要.md');
    project.invalidate();
  });

  test('plots/ 裡的細綱不進 listPlots', () => {
    assert.ok(!listed.some((p) => p.relPath === LEGACY_PLOT), listed.map((p) => p.relPath).join('|'));
  });

  test('plots/ 裡的細綱不進流水線', () => {
    assert.ok(!index.byNo.has(7), index.rows.map((r) => r.no).join(','));
  });

  test('plots/ 裡的檔案判成 other', () => {
    assert.equal(bundle.kind.kindOfPath(project, LEGACY_PLOT).kind, 'other');
  });

  // 程式碼不再讀它，不等於可以替作者處置它：整棵目錄照舊不能改名、搬走或刪除。
  test('plots/ 目錄照舊受保護', () => {
    assert.equal(bundle.guard.isProtectedPath(project, '.novelwarden/plots'), true);
  });

  test('讀一遍不改動 plots/ 裡的檔案', () => {
    assert.equal(t.read(LEGACY_PLOT), LEGACY_PLOT_TEXT);
  });

  // 老工程的單章摘要本來就映象正文的相對路徑：分卷的書，摘要就在卷目錄裡。
  test('summaries/ 子目錄裡的老摘要照樣是細綱', () => {
    assert.ok(listed.some((p) => p.relPath === NESTED), listed.map((p) => p.relPath).join('|'));
  });

  test('summaries/ 子目錄裡的檔案判成 plot', () => {
    assert.equal(bundle.kind.kindOfPath(project, NESTED).kind, 'plot');
  });

  test('老四節細綱讀得出來，不拋', () => {
    assert.equal(old?.no, 8);
    assert.equal(old?.title, '老格式');
  });

  // 「目標」「劇情脈絡」都不是七節裡的名字：如實說「待寫細綱」，而不是假裝排過。
  test('老四節細綱七節全空，算沒排過', () => {
    assert.ok(!bundle.plotFile.isPlotFilled(old.sections), JSON.stringify(old.sections));
    assert.equal(oldPipe.stage, 'plot', oldPipe.stage);
  });

  test('讀一遍不改動那份檔案', () => {
    assert.equal(t.read(OLD), OLD_TEXT);
  });

  test('summaries/ 根下的老摘要當成一份細綱讀進來，章號取檔名', () => {
    assert.equal(oldSummary?.no, 9, listed.map((p) => p.relPath).join('|'));
  });

  test('老摘要帶著的 sourceHash 讀得回來', async () => {
    const chapter9 = (await project.listChapters()).find((c) => c.order === 9);
    assert.equal(oldSummary.sourceHash, chapter9.contentHash);
  });

  // 定稿過的細綱，出場人物取 frontmatter 的 cast（實際出場），別名一併讀回來。
  test('老摘要的 cast 就是這一章的實際出場', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(oldSummary.cast)), [{ name: '林昭', aliases: ['阿昭'] }]);
  });

  test('sourceHash 對得上正文：這一章算定稿過、寫完了', () => {
    assert.equal(oldSummaryPipe?.stage, 'done', JSON.stringify(oldSummaryPipe));
  });
});

/**
 * 這一章已經有正文時改細綱的標題：細綱映象正文的路徑，**檔名跟著正文不動**，只換 frontmatter
 * 裡的標題。改檔名的是正文那一側（工程頁「重新命名」，細綱跟著搬，見 files/fileOps.test.js）。
 */
describe('資料層 · 有正文時改細綱標題', () => {
  const rel = '.novelwarden/summaries/012-夜入青雲.md';
  let renamed;
  let plotHashBefore;
  let plotHashAfter;
  let after;
  let pipe;

  before(async () => {
    // 改名前的內容指紋。改名**絕不能**動它：一旦哪個欄位進了雜湊，
    // 改個名就會讓這一章的正文憑空標髒（AGENTS.md 第 18 條 (b)）。
    plotHashBefore = bundle.plotFile.plotContentHash(await project.readPlot(rel));
    t.write('chapters/012-夜入青雲.md', '# 夜入青雲\n\n正文若干字。\n');
    project.invalidate();

    const plot = await project.readPlot(rel);
    renamed = await wsOf(project).writePlot({ ...plot, title: '夜入' });
    after = await project.readPlot(rel);
    plotHashAfter = bundle.plotFile.plotContentHash(after);
    pipe = await bundle.pipe.buildPlotPipeline(project, { no: 12, plot: after });
  });

  test('落點仍是正文的映象', () => {
    assert.equal(renamed, rel, String(renamed));
  });

  test('標題換了', () => {
    assert.equal(after.title, '夜入');
  });

  test('沒有多出第二份細綱', async () => {
    assert.equal((await project.listPlots()).filter((p) => p.no === 12).length, 1);
  });

  test('正文不跟著改名', () => {
    assert.ok(t.has('chapters/012-夜入青雲.md'));
  });

  test('細綱與正文按路徑認到一起', () => {
    assert.equal(pipe.chapter.relPath, 'chapters/012-夜入青雲.md', JSON.stringify(pipe.chapter));
  });

  // 這一條是防「改個名把整章標髒」的迴歸線。
  test('細綱的內容指紋沒變', () => {
    assert.equal(plotHashAfter, plotHashBefore);
  });
});

/**
 * 新建細綱那條路的主流程：建出來只有序號（`030.md`），細綱排出來才給它起名。
 * 起名走的是 `writePlot`（還沒有正文時：標題變 → 檔名變），不是 fileOps。
 */
describe('資料層 · 給未命名的細綱起名', () => {
  let bare;
  let named;
  let plotRead;
  let plotText;
  let pipe;
  let dest;

  before(async () => {
    bare = await wsOf(project).writePlot(writable(30, '', { sections: filledSections({ 梗概: '起個名字。' }) }));
    const plot = await project.readPlot(bare);
    named = await wsOf(project).writePlot({ ...plot, title: '風起' });
    plotRead = await project.readPlot(named);
    plotText = t.read('.novelwarden/summaries/030-風起.md');
    pipe = await bundle.pipe.buildPlotPipeline(project, { no: 30, plot: plotRead });
    dest = await bundle.pipe.chapterTargetOf(project, named);
  });

  test('未命名時落成純序號名', () => {
    assert.equal(bare, '.novelwarden/summaries/030.md', String(bare));
  });

  test('起名後序號字首保留，後面補分隔符', () => {
    assert.equal(named, '.novelwarden/summaries/030-風起.md', String(named));
  });

  test('舊的純序號檔案被刪掉，不會一章變兩份', () => {
    assert.ok(!t.has('.novelwarden/summaries/030.md'));
  });

  test('title: 換成真標題', () => {
    assert.equal(plotRead.title, '風起', plotRead.title);
  });

  // 標題行就說「第 N 章」：細綱號 = 章號，從前那個「劇情段 N」的說法沒有了。
  test('H1 跟著換成「第N章 標題」', () => {
    assert.ok(plotText.includes('# 第30章 風起'), plotText.slice(0, 300));
  });

  // 正文照細綱的路徑反推著落：落盤之後映象回去正好是這一份。
  test('寫正文時落在細綱反推出來的位置', () => {
    assert.deepEqual({ exists: dest.exists, rel: dest.rel }, { exists: false, rel: 'chapters/030-風起.txt' });
  });

  test('流水線這一行的標題取細綱的', () => {
    assert.equal(pipe.title, '風起', pipe.title);
  });

  after(() => {
    t.remove('.novelwarden/summaries/030-風起.md');
    project.invalidate();
  });
});

describe('新鮮度鏈', () => {
  const plotRel = '.novelwarden/summaries/012-夜入青雲.md';
  const CHAPTER = 'chapters/012-夜入青雲.md';
  // 只寫第 12 章那一條：大綱是各章細綱的梗概，寫別的章會多出幾份空殼細綱（後面「缺號的不補空行」看的就是這一點）。
  const OUTLINE = outlineOf(12, { from: 12, title: '大綱', text: { 12: '林昭進青雲宗。' } });
  let pFresh;
  let pOutlineChanged;
  let pWritten;
  let pPlotChanged;
  let pFinalized;
  let pEditedAfterFinalize;
  let pProseChanged;

  const build = async () => {
    project.invalidate();
    const plot = await project.readPlot(plotRel);
    return bundle.pipe.buildPlotPipeline(project, { no: plot.no, plot });
  };

  before(async () => {
    writeOutline(t, OUTLINE);
    project.invalidate();

    // 細綱記下當時梗概（大綱裡第 12 章那一條）的指紋。
    const plot = await project.readPlot(plotRel);
    await wsOf(project).writePlot({ ...plot, upstreamHash: bundle.plotFile.plotSynopsisHash(plot.sections.梗概) });
    pFresh = await build();

    // 改大綱裡本章那一條 → 細綱標髒。零模型呼叫。
    writeOutline(t, OUTLINE.replace('林昭進青雲宗。', '林昭進青雲宗（改了）。'));
    pOutlineChanged = await build();

    // 正文寫夠（細綱定了 3000 字），並按正文落盤那一步的樣子在細綱上記 writtenFrom。
    t.write(CHAPTER, `# 夜入青雲\n\n${'雨'.repeat(2600)}\n`);
    project.invalidate();
    const current = await project.readPlot(plotRel);
    await wsOf(project).recordWrittenFrom(plotRel, bundle.plotFile.plotContentHash(current));
    pWritten = await build();

    // 改細綱 → 這一章的正文標髒。
    const p = await project.readPlot(plotRel);
    p.sections.关键事件 = '改成三拍：等、翻、被撞見。';
    await wsOf(project).writePlot(p);
    pPlotChanged = await build();

    // 定稿：細綱照正文反向更新，記下正文的 contentHash，writtenFrom 刷成更新後的指紋。
    const chapter = (await project.listChapters()).find((c) => c.order === 12);
    await wsOf(project).finalizePlot(chapter, FINALIZED(), [{ name: '林昭', aliases: [] }]);
    pFinalized = await build();

    // 定稿之後作者又改了細綱。
    const q = await project.readPlot(plotRel);
    q.sections.关键事件 = '等、翻、被撞見，又被放走。';
    await wsOf(project).writePlot(q);
    pEditedAfterFinalize = await build();

    // 定稿之後又改了正文。
    await wsOf(project).write(CHAPTER, { text: '天快亮了。' }, { mode: 'append' });
    pProseChanged = await build();
  });

  test('剛排的細綱不髒', () => {
    assert.equal(pFresh.plot.upstreamStale, false);
  });

  test('改了大綱裡本章那一條，細綱標髒', () => {
    assert.equal(pOutlineChanged.plot.upstreamStale, true);
  });

  test('剛寫完的正文不髒', () => {
    assert.equal(pWritten.chapter.upstreamStale, false);
  });

  test('寫夠了、沒定稿：待定稿', () => {
    assert.equal(pWritten.stage, 'finalize', pWritten.stage);
  });

  test('改細綱後正文標髒', () => {
    assert.equal(pPlotChanged.chapter.upstreamStale, true);
  });

  // 從前正文在中轉站，拆分就是閘口；現在沒拆分這一步，細綱改了而作者還沒認可過
  // 那份正文，下一步就該是拿新細綱重寫。
  test('沒定稿的章：細綱改了退回待寫正文（重寫）', () => {
    assert.equal(pPlotChanged.stage, 'manuscript', pPlotChanged.stage);
  });

  test('定稿之後這一章寫完了', () => {
    assert.equal(pFinalized.stage, 'done', pFinalized.stage);
  });

  // 定稿把細綱改成了正文寫成的樣子，兩者此刻是對得上的。
  test('定稿重新整理 writtenFrom，正文不再掛 ⟳', () => {
    assert.equal(pFinalized.chapter.upstreamStale, false);
  });

  // **定稿過的章不被拉回去**：那是作者已經認可的文字，把它標成「待寫正文」是在攛掇他
  // 重寫。工程頁那一行仍會掛 ⟳ 提醒，夠了。
  test('定稿過的章：細綱改了也不退回，只掛 ⟳', () => {
    assert.equal(pEditedAfterFinalize.stage, 'done', pEditedAfterFinalize.stage);
    assert.equal(pEditedAfterFinalize.chapter.upstreamStale, true);
  });

  test('定稿之後正文又改過：定稿標過期', () => {
    assert.equal(pProseChanged.summary.stale, true, JSON.stringify(pProseChanged.summary));
  });

  test('定稿之後正文又改過：不再算寫完', () => {
    assert.notEqual(pProseChanged.stage, 'done');
  });

  // 只改 frontmatter 裡的 status 不該讓下游標髒——`plotContentHash` 只雜湊
  // 七個小節（第 18b 條）。
  test('把細綱標成 done 不改變它的內容指紋', async () => {
    const p = await project.readPlot(plotRel);
    const before = bundle.plotFile.plotContentHash(p);
    await wsOf(project).writePlot({ ...p, done: true });
    assert.equal(bundle.plotFile.plotContentHash(await project.readPlot(plotRel)), before);
  });

  // 作者手工宣佈「這一章過了」：只允許向前覆蓋推導值——定稿之後正文又改過也算。
  test('標了 done 的章算完成', async () => {
    const p = await build();
    assert.equal(p.stage, 'done', p.stage);
  });
});

describe('新鮮度鏈 · 手寫產物不標髒', () => {
  let p;

  before(async () => {
    // 作者手寫的細綱沒有 upstreamHash，手寫的正文沒有 writtenFrom。拿一個憑空的
    // 過期標記去催他重做，比不標更糟——他會學會無視所有標記。
    t.write('.novelwarden/summaries/020-手寫.md', '## 梗概\n\n我自己寫的\n\n## 關鍵事件\n\nx');
    t.write('chapters/020-手寫.md', '# 手寫\n\n正文');
    project.invalidate();
    const plot = await project.readPlot('.novelwarden/summaries/020-手寫.md');
    // 收的是「一章」（章號 + 細綱 + 成品）。直接把 `Plot` 遞進去也**編譯得過**
    // （它恰好有 `no`，另兩個欄位可選），但 plot/chapter 會雙雙是 undefined，
    // 於是整章按空事實推導——斷言看著綠，測的卻不是這一章。
    p = await bundle.pipe.buildPlotPipeline(project, { no: plot.no, plot });
  });

  test('前提：這一章的細綱與正文都認到了', () => {
    assert.ok(p.plot.exists && p.chapter.exists, JSON.stringify(p));
  });

  test('手寫細綱（無 upstreamHash）不標髒', () => {
    assert.equal(p.plot.upstreamStale, false);
  });

  test('從沒記過 writtenFrom 的正文不標髒', () => {
    assert.equal(p.chapter.upstreamStale, false);
  });
});

describe('流水線索引', () => {
  let index;
  let plotNos;
  let chapterNos;

  before(async () => {
    // 只有正文、沒有細綱的一章（老工程裡每一章都是這樣）。
    t.write('chapters/025-只有正文.md', '# 只有正文\n\n作者早就寫好的一章。\n');
    // 同號兩份章節：作者手改檔名撞了號。
    t.write('chapters/026-a.md', '# a\n\n甲。\n');
    t.write('chapters/026-b.md', '# b\n\n乙。\n');
    t.write('.novelwarden/config.md', '---\ntotalChapters: 60\n---\n\n# 小說配置\n');
    project.invalidate();
    index = await bundle.pipe.buildPipelineIndex(project);
    plotNos = (await project.listPlots()).map((p) => p.no);
    chapterNos = (await project.listChapters()).map((c) => c.order);
  });

  // 細綱號 = 章號：兩條列表按號合併成一條軸，一個章號一行。
  test('一個章號一行（細綱號 ∪ 章節號），升序', () => {
    const expected = [...new Set([...plotNos, ...chapterNos])].sort((a, b) => a - b);
    assert.deepEqual(index.rows.map((r) => r.no), expected);
  });

  test('缺號的不補空行', () => {
    assert.ok(!index.rows.some((r) => r.no === 1), index.rows.map((r) => r.no).join(','));
  });

  test('byNo 按章號索引', () => {
    assert.equal(index.byNo.get(12)?.plot.relPath, '.novelwarden/summaries/012-夜入青雲.md');
  });

  test('只有正文的章也佔一行，細綱路徑是它應該在的位置', () => {
    const row = index.byNo.get(25);
    assert.equal(row?.plot.exists, false, JSON.stringify(row?.plot));
    assert.equal(row?.plot.relPath, '.novelwarden/summaries/025-只有正文.md');
  });

  // 老工程的章有字，於是是「待定稿」或「已完成」——不被倒回去要求補細綱。
  test('只有正文的章不被倒回去要求補細綱', () => {
    assert.equal(index.byNo.get(25)?.stage, 'finalize', index.byNo.get(25)?.stage);
  });

  // 撞號時不猜、不崩：認路徑排序第一份，兩份都還在章節列表裡，作者看得見衝突。
  test('同號兩份章節時只佔一行，認路徑排序第一份', () => {
    assert.equal(index.rows.filter((r) => r.no === 26).length, 1);
    assert.equal(index.byNo.get(26)?.chapter.relPath, 'chapters/026-a.md');
    assert.equal(index.chapters.filter((c) => c.order === 26).length, 2);
  });

  test('完成度只有三段', () => {
    assert.deepEqual(Object.keys(index.byNo.get(12).progress).sort(), ['manuscript', 'plot', 'summary']);
  });

  // 大綱、配置、manifest 與細綱列表只讀一次，跟索引一起返回：工程樹與出場索引接著用這一份
  // （出場索引只認其中定稿過的細綱）。
  test('大綱與配置跟索引一起返回', async () => {
    assert.equal(index.outline, await project.readOutline());
    assert.equal(index.config.totalChapters, 60);
    assert.ok(index.plots && index.manifest, Object.keys(index).join(','));
  });

  // 單章不被倒回去要求補細綱，但**全書**是會被推回架構那一步的——這是有意的（D11）：
  // 新鏈路寫正文要讀前提、角色與世界觀，沒有它們上下文就是空的。
  // （從 volumeFlow.test.js「老工程照舊」挪過來，結論按一章一綱的口徑改了。）
  test('老工程：有正文、沒有架構，全書被推回架構的第一件', async () => {
    const facts = await bundle.pipe.buildBookFacts(project, index);
    assert.equal(bundle.model.deriveBookStage(facts), 'setting');
    assert.deepEqual(bundle.model.deriveBookNextStep('setting', facts)?.target, { kind: 'setting', doc: 'config' });
  });
});

/**
 * 「N 章的上游產物有變更」只在標髒的那幾章變了時記：索引每次 `pushState` 都建一趟，
 * 名單不變還照記，編輯器裡打幾個字日誌頁就被同一行刷屏。
 */
describe('流水線索引 · 上游變更的日誌不刷屏', () => {
  let p;
  let pr;
  let afterSame;
  let afterMore;
  let afterCleared;
  let afterAgain;
  /** 排過之後梗概（大綱裡那一條）改過的細綱：upstreamHash 對不上，標髒。 */
  const stalePlot = (no, title) => `---\nno: ${no}\ntitle: ${title}\nupstreamHash: 舊的指紋\n---\n\n## 梗概\n\n改過的梗概。\n\n## 關鍵事件\n\n- 計劃。\n`;
  /** 手寫的細綱：沒有 upstreamHash，不標髒。 */
  const handPlot = (no, title) => `---\nno: ${no}\ntitle: ${title}\n---\n\n## 梗概\n\n改過的梗概。\n\n## 關鍵事件\n\n- 計劃。\n`;
  const staleLogs = () =>
    bundle.logger
      .recentLogs()
      .filter((e) => e.scope === '流水線' && e.message.endsWith('章的上游產物有變更'))
      .map((e) => e.detail.split('｜')[0]);
  const rebuild = async (times) => {
    pr.invalidate();
    for (let i = 0; i < times; i++) {
      await bundle.pipe.buildPipelineIndex(pr);
    }
    return staleLogs();
  };

  before(async () => {
    p = await makeTempProject(bundle.project, { prefix: 'stalelog', title: '刷屏' });
    dirs.push(p.dir);
    pr = p.project;
    bundle.logger.clearLogs();
    p.write('.novelwarden/summaries/082-雪夜.md', stalePlot(82, '雪夜'));
    afterSame = await rebuild(3);

    p.write('.novelwarden/summaries/083-冰河.md', stalePlot(83, '冰河'));
    afterMore = await rebuild(2);

    p.write('.novelwarden/summaries/082-雪夜.md', handPlot(82, '雪夜'));
    p.write('.novelwarden/summaries/083-冰河.md', handPlot(83, '冰河'));
    afterCleared = await rebuild(2);

    p.write('.novelwarden/summaries/082-雪夜.md', stalePlot(82, '雪夜'));
    afterAgain = await rebuild(2);
  });

  test('標髒的章沒變：建幾趟索引都只記一條', () => {
    assert.deepEqual(afterSame, ['第 82 章']);
  });

  test('又有一章標髒：再記一條', () => {
    assert.deepEqual(afterMore, ['第 82 章', '第 82 章、第 83 章']);
  });

  test('都不髒了：不記', () => {
    assert.deepEqual(afterCleared, afterMore);
  });

  test('消掉之後又標髒：重新記', () => {
    assert.deepEqual(afterAgain, [...afterMore, '第 82 章']);
  });
});

/** 「有幾個章號不止一個正文檔案」也是索引每趟都會碰到的，同樣只在撞號的名單變了時記。 */
describe('流水線索引 · 撞號的日誌不刷屏', () => {
  let p;
  let pr;
  let afterSame;
  let afterMore;
  let afterCleared;
  let afterAgain;
  const duplicateLogs = () =>
    bundle.logger
      .recentLogs()
      .filter((e) => e.scope === '流水線' && e.message.startsWith('有幾個章號不止一個正文檔案'))
      .map((e) => e.detail);
  const rebuild = async (times) => {
    pr.invalidate();
    for (let i = 0; i < times; i++) {
      await bundle.pipe.buildPipelineIndex(pr);
    }
    return duplicateLogs();
  };

  before(async () => {
    p = await makeTempProject(bundle.project, { prefix: 'duplog', title: '撞號' });
    dirs.push(p.dir);
    pr = p.project;
    bundle.logger.clearLogs();

    p.write('chapters/090-a.md', '# a\n\n甲。\n');
    p.write('chapters/090-b.md', '# b\n\n乙。\n');
    afterSame = await rebuild(3);

    p.write('chapters/091-a.md', '# a\n\n甲。\n');
    p.write('chapters/091-b.md', '# b\n\n乙。\n');
    afterMore = await rebuild(2);

    p.remove('chapters/090-b.md');
    p.remove('chapters/091-b.md');
    afterCleared = await rebuild(2);

    p.write('chapters/090-b.md', '# b\n\n乙。\n');
    afterAgain = await rebuild(2);
  });

  test('撞號的章沒變：建幾趟索引都只記一條', () => {
    assert.deepEqual(afterSame, ['第 90 章']);
  });

  test('又撞了一個號：再記一條', () => {
    assert.deepEqual(afterMore, ['第 90 章', '第 90 章、第 91 章']);
  });

  test('都不撞了：不記', () => {
    assert.deepEqual(afterCleared, afterMore);
  });

  test('解開之後又撞號：重新記', () => {
    assert.deepEqual(afterAgain, [...afterMore, '第 90 章']);
  });
});

/**
 * 全書狀態機要的事實（`buildBookFacts`）。**只有這一份**：主按鈕、工程頁的全書階段與
 * agent 的狀態注入都吃它（第 20 條）。另起一個工程，從空白一步步推到「在寫」。
 */
describe('全書事實 · 從空工程一路推到在寫', () => {
  let p;
  let pr;
  const facts = async () => bundle.pipe.buildBookFacts(pr);
  const stageOf = async () => bundle.model.deriveBookStage(await facts());
  let empty;
  let beforeLore;
  let afterSettings;
  let afterPlot;
  let afterChapters;
  let afterEmptyChapter;

  before(async () => {
    p = await makeTempProject(bundle.project, { prefix: 'bookfacts', title: '全書' });
    dirs.push(p.dir);
    pr = p.project;
    empty = { facts: await facts(), stage: await stageOf() };

    // 架構前四件與大綱（第 1–20 章）。
    p.write('.novelwarden/config.md', '---\ntotalChapters: 30\nwordsPerChapter: 400\n---\n\n# 小說配置\n\n## 核心梗概\n\n回鎮查火。\n');
    p.write('.novelwarden/premise.md', '# 故事前提\n\n## 核心衝突鏈\n\n回鎮 → 被認出。\n');
    p.write('.novelwarden/world.md', '# 世界觀\n\n## 規則與漏洞\n\n過所制度。\n');
    p.write('.novelwarden/characters/林昭.md', '---\nname: 林昭\n---\n\n# 林昭\n');
    writeOutline(p, outlineOf(20, { title: '大綱' }));
    pr.invalidate();
    beforeLore = { facts: await facts(), stage: await stageOf() };

    // 第五件設定清單：一條條目就算填過（與角色圖譜一張卡就算同理）。
    p.write('.novelwarden/lore/地域/青崖镇.md', '---\ntitle: 青崖鎮\nkeywords: [青崖鎮]\n---\n\n# 青崖鎮\n');
    pr.invalidate();
    afterSettings = { facts: await facts(), stage: await stageOf() };

    await wsOf(pr).writePlot(writable(1, '楔子'));
    afterPlot = { facts: await facts(), stage: await stageOf() };

    // 第 1、2、4 章有正文：下一個該寫的是缺口第 3 章。
    p.write('chapters/001-楔子.md', '# 楔子\n\n雨下了三天。\n');
    p.write('chapters/002-入鎮.md', '# 入鎮\n\n他走進鎮子。\n');
    p.write('chapters/004-夜訪.md', '# 夜訪\n\n三更時分。\n');
    pr.invalidate();
    afterChapters = await facts();

    // 空檔案不算寫過：作者建了一個空章節佔位，主按鈕仍該說「寫這一章」。
    p.write('chapters/003.md', '');
    pr.invalidate();
    afterEmptyChapter = await facts();
  });

  test('空工程：架構五件都沒有，從「架構」開始', () => {
    assert.deepEqual(empty.facts.settings, { config: false, premise: false, characters: false, world: false, lore: false });
    assert.equal(empty.stage, 'setting');
  });

  // 初始化寫的大綱模板只有一行 `>` 說明：那是腳手架，不是大綱。
  test('空工程：大綱模板不算寫過，覆蓋到第 0 章', () => {
    assert.equal(empty.facts.outlineFilled, false);
    assert.equal(empty.facts.outlineCoverage, 0);
  });

  test('空工程：下一章是第 1 章，沒有細綱', () => {
    assert.equal(empty.facts.nextChapterNo, 1);
    assert.equal(empty.facts.nextPlotFilled, false);
  });

  // 設定名錄：大綱寫在前面也不跳過——五件按順序，世界觀之後是設定清單。
  test('前四件齊了、還沒有設定條目：架構那一檔推設定清單', () => {
    assert.equal(beforeLore.facts.settings.lore, false);
    assert.equal(beforeLore.stage, 'setting');
    assert.deepEqual(bundle.model.deriveBookNextStep('setting', beforeLore.facts).target, { kind: 'setting', doc: 'lore' });
  });

  test('架構齊了：五件都認', () => {
    assert.deepEqual(afterSettings.facts.settings, { config: true, premise: true, characters: true, world: true, lore: true });
  });

  test('大綱按章標題算覆蓋到第幾章', () => {
    assert.equal(afterSettings.facts.outlineFilled, true);
    assert.equal(afterSettings.facts.outlineCoverage, 20);
  });

  test('總章數取自 config.md', () => {
    assert.equal(afterSettings.facts.totalChapters, 30);
  });

  test('架構與大綱齊了、第 1 章沒有細綱：拆細綱', () => {
    assert.equal(afterSettings.stage, 'plots');
  });

  test('第 1 章排好細綱：在寫', () => {
    assert.equal(afterPlot.facts.nextPlotFilled, true);
    assert.equal(afterPlot.stage, 'writing');
  });

  // 連續才算：跳著寫是作者的自由，但主按鈕只推一個，推的應該是那個缺口。
  test('第 1、2、4 章有正文時，下一個該寫的是第 3 章', () => {
    assert.equal(afterChapters.nextChapterNo, 3);
  });

  test('空章節檔案不算寫過', () => {
    assert.equal(afterEmptyChapter.nextChapterNo, 3);
  });

  describe('chapterTargetOf · 正文該落在哪', () => {
    test('同號章節已存在（哪怕是空檔案）就用它', async () => {
      await wsOf(pr).writePlot(writable(3, '夜渡'));
      const dest = await bundle.pipe.chapterTargetOf(pr, '.novelwarden/summaries/003-夜渡.md');
      assert.deepEqual({ exists: dest.exists, rel: dest.rel, no: dest.no }, { exists: true, rel: 'chapters/003.md', no: 3 });
    });

    test('還沒有就是 chapters/NNN-<細綱標題>.txt', async () => {
      await wsOf(pr).writePlot(writable(5, '客棧裡的女人'));
      const dest = await bundle.pipe.chapterTargetOf(pr, '.novelwarden/summaries/005-客棧裡的女人.md');
      assert.deepEqual(
        { exists: dest.exists, rel: dest.rel, title: dest.title },
        { exists: false, rel: 'chapters/005-客棧裡的女人.txt', title: '客棧裡的女人' }
      );
    });

    test('細綱沒有標題時落成純序號名', async () => {
      await wsOf(pr).writePlot(writable(6, ''));
      const dest = await bundle.pipe.chapterTargetOf(pr, '.novelwarden/summaries/006.md');
      assert.equal(dest.rel, 'chapters/006.txt');
    });

    test('認不出章號時拋錯，而不是亂落', async () => {
      await assert.rejects(() => bundle.pipe.chapterTargetOf(pr, '.novelwarden/summaries/沒有號.md'), /認不出/);
    });
  });
});

describe('工作區卡', () => {
  const plotRel = '.novelwarden/summaries/012-夜入青雲.md';
  let plotCard;
  let ms;
  let skeleton;
  let gone;
  let outline;
  let premiseCard;
  let rosterCard;

  before(async () => {
    const wb = (target) => bundle.workbench.buildWorkbench(project, target);

    // 在情節大綱裡改第 12 章那一條（大綱是各章梗概的彙總，存檔寫回這一章細綱的梗概）：排過的細綱沒跟，掛 ⟳。
    const ws = wsOf(project);
    const doc = (await ws.read('.novelwarden/outline.md')).text;
    await ws.write('.novelwarden/outline.md', { text: doc.replace('夜入青雲。', '夜入青雲，被放走。') }, { mode: 'overwrite', review: false });
    project.invalidate();

    plotCard = await wb({ kind: 'plot', plotRelPath: plotRel });

    // 正文層攤的是**本章細綱的各節**加篇幅：寫正文時最常回頭看的是「這一章要落實
    // 哪幾件事、看點落在哪」。正文字身上萬字，塞進浮窗讀不下去。
    ms = await wb({ kind: 'manuscript', plotRelPath: plotRel });

    // 「檔案在但一節都沒填」與「檔案不在」對作者是同一件事：這一層還沒做。
    const bare = await wsOf(project).writePlot(writable(40, '空骨架', { sections: bundle.plotFile.emptyPlotSections() }));
    skeleton = await wb({ kind: 'plot', plotRelPath: bare });

    // 細綱剛被改名/刪除時給一張說得清情況的空卡，而不是讓整條推送失敗。
    gone = await wb({ kind: 'plot', plotRelPath: '.novelwarden/summaries/999-不存在.md' });
    outline = await wb({ kind: 'outline' });
    premiseCard = await wb({ kind: 'setting', doc: 'premise' });
    rosterCard = await wb({ kind: 'setting', doc: 'characters' });
  });

  test('細綱卡攤開小節', () => {
    assert.deepEqual(plotCard.sections.map((s) => s.key), ['梗概', '出场人物', '关键事件', '看点']);
  });

  test('細綱卡標題帶章號', () => {
    assert.ok(plotCard.title.includes('第 12 章'), plotCard.title);
  });

  test('細綱卡指向細綱檔案', () => {
    assert.equal(plotCard.relPath, plotRel);
  });

  // 剛在大綱裡改過第 12 章那一條：作者正在看這一章，此刻正是告訴他的時候。
  test('細綱卡說出大綱那一條變過', () => {
    assert.ok(!!plotCard.warning, JSON.stringify(plotCard));
  });

  // 空小節不進卡片：卡片是給人看的，不是一張待填表格。
  test('空小節不顯示', () => {
    assert.ok(
      plotCard.sections.every((s) => s.text.trim() && s.text !== '（待補充）'),
      JSON.stringify(plotCard.sections)
    );
  });

  test('正文卡先報篇幅，再攤本章細綱', () => {
    assert.deepEqual(ms.sections.map((s) => s.key), ['篇幅', '梗概', '出场人物', '关键事件', '看点']);
  });

  test('正文卡不攤正文全文', () => {
    assert.ok(!ms.sections.some((s) => s.text.includes('雨雨雨雨')), JSON.stringify(ms.sections).slice(0, 200));
  });

  test('正文卡指向同號的章節', () => {
    assert.equal(ms.relPath, 'chapters/012-夜入青雲.md');
  });

  // 目標字數是狀態機判「寫夠沒有」的依據，卡片上必須看得見它。這一章的細綱寫了 3000。
  test('有目標字數時篇幅那一行報出它', () => {
    const words = ms.sections.find((s) => s.key === '篇幅');
    assert.ok(words && words.text.includes('3000'), JSON.stringify(ms.sections));
  });

  // 反過來：細綱與配置裡都沒寫目標字數時，判據退化成「有正文就算寫夠」——
  // 那也得說出來，否則作者看不懂它憑什麼已經算完了。
  test('沒有目標字數時卡片說清判據', async () => {
    t.write('.novelwarden/config.md', '---\ngenre: 武俠\n---\n\n# 小說配置\n');
    project.invalidate();
    const bare = await wsOf(project).writePlot(writable(41, '沒寫字數'));
    const card = await bundle.workbench.buildWorkbench(project, { kind: 'manuscript', plotRelPath: bare });
    assert.ok(card.sections.some((s) => s.key === '目標篇幅'), JSON.stringify(card.sections.map((s) => s.key)));
  });

  // 細綱沒寫就用 config.md 的每章字數。
  test('細綱沒寫目標字數時按配置的每章字數算', async () => {
    t.write('.novelwarden/config.md', '---\nwordsPerChapter: 2500\n---\n\n# 小說配置\n');
    project.invalidate();
    const card = await bundle.workbench.buildWorkbench(project, {
      kind: 'manuscript', plotRelPath: '.novelwarden/summaries/041-沒寫字數.md',
    });
    assert.ok(card.sections.every((s) => s.key !== '目標篇幅'), JSON.stringify(card.sections));
  });

  // 上一組在定稿之後又改過這一章的細綱，而正文那一側記的還是定稿時的指紋。
  test('正文卡說出細綱在正文之後改過', () => {
    assert.ok(!!ms.warning, JSON.stringify(ms));
  });

  test('空骨架細綱說「還沒排細綱」', () => {
    assert.ok(skeleton.sections.length === 0 && !!skeleton.empty, JSON.stringify(skeleton));
  });

  test('細綱不存在時給空卡而非拋', () => {
    assert.ok(!!gone.empty, JSON.stringify(gone));
  });

  test('大綱卡指向 outline.md', () => {
    assert.ok(outline.relPath.endsWith('outline.md'), outline.relPath);
  });

  test('架構卡報的是架構那一層', () => {
    assert.equal(premiseCard.stage, 'setting');
    assert.equal(premiseCard.relPath, '.novelwarden/premise.md');
  });

  // 空模板全是佔位：卡片說「還沒有」，不攤一張全是「（待補充）」的表。
  test('只有模板的架構檔案給空卡', () => {
    assert.ok(premiseCard.sections.length === 0 && !!premiseCard.empty, JSON.stringify(premiseCard));
  });

  test('角色圖譜卡指向角色目錄', () => {
    assert.equal(rosterCard.relPath, '.novelwarden/characters');
  });
});

/**
 * 細綱映象正文的相對路徑（2026-10-18 作者定案：「必須保證相對路徑，無相對路徑是絕對錯的」）。
 * 合併細綱與摘要那一次曾把細綱改成平鋪在 `summaries/` 根下、按章號配對，分卷的書裡
 * `summaries/第二卷/…` 的老摘要於是在工程頁上一份都認不出、點章節打不開，而對話頁按路徑直接讀
 * 卻讀得到。另起一個工程，把那幾條路都走一遍。
 */
describe('細綱映象正文的相對路徑', () => {
  let p;
  let pr;
  const NESTED_PLOT = '.novelwarden/summaries/第二卷/050-雪夜.md';
  const NESTED_CHAPTER = 'chapters/第二卷/050-雪夜.txt';
  const ORPHAN = '.novelwarden/summaries/050-舊名.md';
  let listed;
  let index;
  let byNo;
  let resolved;
  let pipeView;
  let finalized;
  let newPlot;
  let dest;
  let dupPlots;

  before(async () => {
    p = await makeTempProject(bundle.project, { prefix: 'mirror', title: '分卷' });
    dirs.push(p.dir);
    pr = p.project;
    p.write('chapters/第一卷/049-渡口.md', '# 渡口\n\n他到了渡口。\n');
    p.write(NESTED_CHAPTER, '雪下了一夜。\n');
    p.write(NESTED_PLOT, '---\nno: 50\ntitle: 雪夜\n---\n\n# 第50章 雪夜\n\n## 梗概\n\n雪夜。\n\n## 關鍵事件\n\n- 雪下了一夜。\n');
    // 作者在外面給正文改過名：舊名字的細綱成了孤兒，不冒認這一章。
    p.write(ORPHAN, '---\nno: 50\ntitle: 舊名\n---\n\n## 關鍵事件\n\n- 舊的計劃。\n');
    pr.invalidate();

    listed = await pr.listPlots();
    index = await bundle.pipe.buildPipelineIndex(pr);
    byNo = await pr.getPlot(50);
    resolved = await pr.resolvePlot(ORPHAN);
    pipeView = await bundle.pipe.buildPlotPipeline(pr, { no: 50, plot: byNo });

    const chapter = (await pr.listChapters()).find((c) => c.order === 50);
    finalized = await wsOf(pr).finalizePlot(chapter, FINALIZED(), [{ name: '林昭', aliases: [] }]);

    // 新的一章（還沒有正文也沒有細綱）跟上一章放在一起：上一章在第二卷，它也落進第二卷。
    newPlot = await wsOf(pr).writePlot(writable(51, '冰河'));
    dest = await bundle.pipe.chapterTargetOf(pr, newPlot);

    // 同號的兩個檔案（作話與正文）各有各的細綱，不再互相覆蓋（7bf8ada 修過的那個 bug）。
    p.write('chapters/060 序.txt', '序。\n');
    p.write('chapters/060 正文.txt', '正文。\n');
    pr.invalidate();
    const sixty = (await pr.listChapters()).filter((c) => c.order === 60);
    for (const c of sixty) {
      await wsOf(pr).finalizePlot(c, FINALIZED({ 梗概: c.relPath }), []);
    }
    dupPlots = await Promise.all(sixty.map((c) => pr.plotOfChapter(c)));
  });

  test('子目錄裡的細綱列得出來', () => {
    assert.ok(listed.some((x) => x.relPath === NESTED_PLOT), listed.map((x) => x.relPath).join('|'));
  });

  test('子目錄裡的細綱判成 plot', () => {
    assert.equal(bundle.kind.kindOfPath(pr, NESTED_PLOT).kind, 'plot');
  });

  test('有正文的章只認正文映象的那一份，孤兒不冒認', () => {
    assert.equal(byNo?.relPath, NESTED_PLOT);
    assert.equal(index.byNo.get(50)?.plot.relPath, NESTED_PLOT);
    assert.equal(index.byNo.get(50)?.plot.exists, true);
  });

  // 對話頁按 target 路徑讀、工程頁按章號讀，兩邊必須是同一份。
  test('target 指著孤兒時也認到這一章現在的那一份', () => {
    assert.equal(resolved?.relPath, NESTED_PLOT);
  });

  test('流水線這一行的細綱與正文配上了', () => {
    assert.equal(pipeView.chapter.relPath, NESTED_CHAPTER);
    assert.equal(pipeView.plot.relPath, NESTED_PLOT);
  });

  test('定稿寫回映象的那一份，不在根下另建一份', () => {
    assert.equal(finalized.rel, NESTED_PLOT);
    assert.ok(!p.has('.novelwarden/summaries/050-雪夜.md'));
  });

  test('還沒有正文的新一章：細綱跟上一章落進同一個子目錄', () => {
    assert.equal(newPlot, '.novelwarden/summaries/第二卷/051-冰河.md');
  });

  test('照它寫正文時，正文也落進那個子目錄', () => {
    assert.deepEqual({ exists: dest.exists, rel: dest.rel }, { exists: false, rel: 'chapters/第二卷/051-冰河.txt' });
  });

  test('還沒有細綱的新一章，落點也跟上一章走', async () => {
    assert.equal(await pr.plotPathOfNo(52), '.novelwarden/summaries/第二卷/052.md');
  });

  test('有正文沒細綱的章，落點是正文的映象', async () => {
    assert.equal(await pr.plotPathOfNo(49), '.novelwarden/summaries/第一卷/049-渡口.md');
  });

  test('同號的兩個檔案各有各的細綱', () => {
    assert.deepEqual(
      dupPlots.map((x) => x?.relPath).sort(),
      ['.novelwarden/summaries/060 序.md', '.novelwarden/summaries/060 正文.md']
    );
    assert.deepEqual(dupPlots.map((x) => x?.sections.梗概).sort(), ['chapters/060 序.txt', 'chapters/060 正文.txt']);
  });
});
