/**
 * 新工程的空模板（架構三件、文風、情節大綱、全文大綱）經閘道器寫（AGENTS 第 7 條）。
 *
 * 從前 `model/project.ts` 的 `initialize` 自己 `writeIfAbsent`，繞過了閘道器。現在分了層：`model/` 只建固定目錄、寫
 * manifest（`scaffold` / `createManifest`），模板的內容也在那裡定義（`newProjectTemplates`，純資料）；寫盤由
 * `Workspace.initializeProject` 經 `write`（`mode: 'create'`）做——`model/` 不能反過來依賴閘道器。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 新工程照樣有這幾份空模板，字一個不差 | 行為對作者不變：主按鈕仍從「生成小說配置」開始 |
 * | 已經存在的檔案一個位元組不動 | 與從前 `writeIfAbsent` 同一個口徑（第 3 條） |
 * | 不彈審閱、不彈確認、不存歷史版本 | 只新建、不覆蓋，沒有可問的 |
 * | 不讓任何東西掛 ⟳、不給已有細綱補指紋 | 第 18 條：模板落盤只經 setting / doc 兩種 handler，它們不記賬 |
 * | 不刷日誌 | 一次初始化不該在日誌頁留六行 |
 * | `model/` 這一層自己不寫模板 | 分層：寫盤只在閘道器 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');
const { makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
const dirs = [];

function tempDir(prefix) {
  const t = makeTempDir(prefix);
  dirs.push(t.dir);
  return t;
}

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    plotFile: './src/core/model/plotFile.ts',
    ws: './src/core/workspace/index.ts',
    actions: './src/core/actions.ts',
    pipe: './src/core/views/pipeline.ts',
    logger: './src/core/runtime/logger.ts',
  });
  h = makeFakeHost({ settings: () => ({}) });
  bundle.host.initHost(h.host);
});

after(() => {
  for (const dir of dirs) cleanup(dir);
});

const TEMPLATE_RELS = [
  '.novelwarden/config.md',
  '.novelwarden/premise.md',
  '.novelwarden/world.md',
  '.novelwarden/style.md',
  '.novelwarden/summaries/global.md',
];

describe('新建一個空工程', () => {
  let t;
  let project;
  let created;
  let templates;
  let reviewed;
  let confirms;
  let logs;

  before(async () => {
    t = tempDir('newproj');
    project = bundle.project.NovelProject.open(t.dir);
    h.reviewed.length = 0;
    h.confirms.length = 0;
    bundle.logger.clearLogs();
    const mark = bundle.logger.recentLogs().length;
    created = await new bundle.ws.Workspace(project).initializeProject({ title: '霧港', author: '某人' });
    templates = project.newProjectTemplates();
    reviewed = h.reviewed.length;
    confirms = h.confirms.length;
    logs = bundle.logger.recentLogs().slice(mark).filter((e) => e.level !== 'debug');
  });

  test('模板清單就是這五份', () => {
    assert.deepEqual(templates.map((x) => x.rel).sort(), [...TEMPLATE_RELS].sort());
  });

  test('五份空模板都在，字一個不差', () => {
    for (const { rel, text } of templates) {
      assert.equal(t.read(rel), text, rel);
    }
  });

  test('返回新建了哪幾份', () => {
    assert.deepEqual([...created].sort(), [...TEMPLATE_RELS].sort());
  });

  // 情節大綱是各章細綱梗概的彙總（docs/design/plans/2026-10-22-outline-from-plots.md），沒有檔案。
  test('不建 outline.md', () => {
    assert.ok(!t.has('.novelwarden/outline.md'));
  });

  test('固定目錄建好了', () => {
    for (const d of ['chapters', '.novelwarden/characters', '.novelwarden/lore', '.novelwarden/summaries', '.novelwarden/sessions']) {
      assert.ok(fs.statSync(t.rel(d)).isDirectory(), d);
    }
  });

  test('manifest 寫好了，工程算初始化過', async () => {
    assert.equal(await project.isInitialized(), true);
    const manifest = await project.readManifest();
    assert.equal(manifest.title, '霧港');
    assert.equal(manifest.author, '某人');
  });

  test('空模板不算填過：主按鈕仍從「生成小說配置」開始', async () => {
    const filled = await project.settingFilled();
    assert.equal(filled.config, false);
    assert.equal(filled.premise, false);
    assert.equal(filled.world, false);
  });

  test('不彈審閱、不彈確認', () => {
    assert.equal(reviewed, 0);
    assert.equal(confirms, 0);
  });

  test('不存歷史版本（沒覆蓋任何東西）', () => {
    assert.equal(t.has('.novelwarden/history'), false);
  });

  test('不刷日誌：沒有 warn / error，也沒有一份模板一行', () => {
    assert.ok(!logs.some((e) => e.level === 'warn' || e.level === 'error'), JSON.stringify(logs));
    assert.ok(logs.length <= 1, JSON.stringify(logs.map((e) => e.message)));
  });
});

describe('在已有東西的目錄裡初始化：已存在的一個位元組不動', () => {
  const AUTHOR_CONFIG = '---\ngenre: 懸疑\n---\n\n# 小說配置\n\n作者自己寫好的配置，一個字都不能動。\n';
  const AUTHOR_OUTLINE = '# 情節大綱\n\n## 第 1–10 章\n\n作者寫好的大綱。\n';
  const CH = 'chapters/001-楔子.md';
  const PLOT = '.novelwarden/summaries/001-楔子.md';
  let t;
  let project;
  let created;
  let plotBefore;
  let pipe;
  let againCreated;
  let snapshot;

  function readAll() {
    return Object.fromEntries(TEMPLATE_RELS.map((rel) => [rel, t.has(rel) && fs.statSync(t.rel(rel)).isFile() ? t.read(rel) : undefined]));
  }

  before(async () => {
    t = tempDir('newproj-existing');
    t.write('.novelwarden/config.md', AUTHOR_CONFIG);
    // 老工程留下的 outline.md：不再讀，也一個位元組不動。
    t.write('.novelwarden/outline.md', AUTHOR_OUTLINE);
    t.write(CH, '# 楔子\n\n雨下了三天。\n');
    // 一份記過 writtenFrom、沒記上游指紋的細綱：初始化不該給它補 upstreamHash，也不該讓正文掛 ⟳。
    const { renderPlotFile, emptyPlotSections, plotContentHash } = bundle.plotFile;
    const sections = { ...emptyPlotSections(), 梗概: '楔子的計劃', 关键事件: '- 下雨' };
    t.write(PLOT, renderPlotFile({ no: 1, title: '楔子', upstreamHash: '', writtenFrom: plotContentHash({ sections }), done: false, sections }));
    // 文風的落點上已經有一個目錄：從前 writeIfAbsent 看到「有東西」就跳過，現在也一樣，不拋。
    fs.mkdirSync(t.rel('.novelwarden/style.md'), { recursive: true });
    plotBefore = t.read(PLOT);

    project = bundle.project.NovelProject.open(t.dir);
    created = await new bundle.ws.Workspace(project).initializeProject({ title: '舊稿新開', author: '' });
    project.invalidate();
    const plot = await project.getPlot(1);
    pipe = await bundle.pipe.buildPlotPipeline(project, { no: 1, plot });

    snapshot = readAll();
    againCreated = await new bundle.ws.Workspace(project).initializeProject({ title: '舊稿新開', author: '' });
  });

  test('作者的配置與老工程的 outline.md 一字不動', () => {
    assert.equal(t.read('.novelwarden/config.md'), AUTHOR_CONFIG);
    assert.equal(t.read('.novelwarden/outline.md'), AUTHOR_OUTLINE);
  });

  test('缺的那幾份照樣補上', () => {
    assert.deepEqual([...created].sort(), ['.novelwarden/premise.md', '.novelwarden/summaries/global.md', '.novelwarden/world.md'].sort());
  });

  test('落點被目錄佔著的那一份跳過，不拋', () => {
    assert.ok(fs.statSync(t.rel('.novelwarden/style.md')).isDirectory());
  });

  test('已有的細綱一字不動：沒被補上 upstreamHash', () => {
    assert.equal(t.read(PLOT), plotBefore);
  });

  test('第 18 條：初始化之後細綱不掛 ⟳、正文不掛 ⟳', () => {
    assert.equal(pipe.plot.upstreamStale, false);
    assert.equal(pipe.chapter.upstreamStale, false);
  });

  test('不存歷史版本', () => {
    assert.equal(t.has('.novelwarden/history'), false);
  });

  test('再初始化一次：什麼都不建、什麼都不改', () => {
    assert.deepEqual(againCreated, []);
    assert.deepEqual(readAll(), snapshot);
  });
});

describe('分層：model/ 只建目錄與 manifest，不寫模板', () => {
  let t;

  before(async () => {
    t = tempDir('newproj-model');
    const project = bundle.project.NovelProject.open(t.dir);
    await project.scaffold();
    await project.createManifest({ title: '只有骨架', author: '' });
  });

  test('目錄與 manifest 有了', () => {
    assert.ok(fs.statSync(t.rel('chapters')).isDirectory());
    assert.ok(t.has('.novelwarden/project.json'));
  });

  test('一份模板都沒寫——寫模板是閘道器的事', () => {
    for (const rel of TEMPLATE_RELS) {
      assert.equal(t.has(rel), false, rel);
    }
  });

  test('model/project.ts 裡不再有直接寫模板的 writeIfAbsent', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../src/core/model/project.ts'), 'utf8');
    assert.doesNotMatch(src, /writeIfAbsent/);
  });
});

describe('初始化流程（外掛命令、網頁按鈕、CLI 共用的 initProjectFlow）照舊建出模板', () => {
  let t;
  let ok;

  before(async () => {
    t = tempDir('newproj-flow');
    const project = bundle.project.NovelProject.open(t.dir);
    h.expect('流程建的書', '作者甲');
    ok = await bundle.actions.initProjectFlow(project, '預設名');
  });

  test('初始化成功', () => {
    assert.equal(ok, true);
  });

  test('五份模板都在，manifest 記的是作者給的書名', () => {
    for (const rel of TEMPLATE_RELS) {
      assert.ok(t.has(rel), rel);
    }
    assert.match(t.read('.novelwarden/project.json'), /流程建的書/);
  });
});

// 歡迎頁「新建一本書」「匯入寫好的書」（2026-10-24）：一張表單填好書名、作者、放在哪，一步建好。
describe('createBookAt：在一個目錄下建一本書', () => {
  const readManifest = (root) => JSON.parse(fs.readFileSync(path.join(root, '.novelwarden/project.json'), 'utf8'));

  test('建一個以書名命名的資料夾、初始化，返回它的絕對路徑', async () => {
    const t = tempDir('newbook');
    const root = await bundle.actions.createBookAt(t.dir, { title: '  青雲劍錄 ', author: ' 某某 ' });
    assert.equal(root, path.join(t.dir, '青雲劍錄'));
    const manifest = readManifest(root);
    assert.equal(manifest.title, '青雲劍錄');
    assert.equal(manifest.author, '某某');
    for (const rel of TEMPLATE_RELS) {
      assert.ok(fs.existsSync(path.join(root, rel)), rel);
    }
    assert.ok(fs.statSync(path.join(root, 'chapters')).isDirectory());
    // 與「開啟資料夾 → 初始化」是同一個結果：工程認得出自己已經初始化了。
    assert.equal(await bundle.project.NovelProject.open(root).isInitialized(), true);
  });

  test('「放在」那個目錄還不在：一路建出來', async () => {
    const t = tempDir('newbook-deep');
    const root = await bundle.actions.createBookAt(path.join(t.dir, '小說', '長篇'), { title: '雪夜', author: '' });
    assert.equal(root, path.join(t.dir, '小說', '長篇', '雪夜'));
    assert.equal(readManifest(root).author, '');
  });

  test('檔名裡不許有的字從資料夾名裡刪掉，書名照原樣記', async () => {
    const t = tempDir('newbook-chars');
    const root = await bundle.actions.createBookAt(t.dir, { title: '青雲:劍錄?', author: '' });
    assert.equal(path.basename(root), '青雲劍錄');
    assert.equal(readManifest(root).title, '青雲:劍錄?');
  });

  test('同名資料夾空著：用它', async () => {
    const t = tempDir('newbook-empty');
    fs.mkdirSync(t.rel('雪夜'));
    const root = await bundle.actions.createBookAt(t.dir, { title: '雪夜', author: '' });
    assert.equal(root, t.rel('雪夜'));
    assert.ok(fs.existsSync(t.rel('雪夜/.novelwarden/project.json')));
  });

  test('同名資料夾裡有東西：報錯，一個位元組都不寫', async () => {
    const t = tempDir('newbook-busy');
    t.write('雪夜/筆記.txt', '別人的東西');
    await assert.rejects(() => bundle.actions.createBookAt(t.dir, { title: '雪夜', author: '' }), /裡面還有別的東西/);
    assert.deepEqual(fs.readdirSync(t.rel('雪夜')), ['筆記.txt']);
  });

  test('同名資料夾已經是一本書：報錯，叫作者用「開啟資料夾」', async () => {
    const t = tempDir('newbook-twice');
    await bundle.actions.createBookAt(t.dir, { title: '雪夜', author: '' });
    await assert.rejects(() => bundle.actions.createBookAt(t.dir, { title: '雪夜', author: '' }), /已經是一本書了，用「開啟資料夾」/);
  });

  test('書名空著、只剩不能當資料夾名的字、「放在」空著：都報錯', async () => {
    const t = tempDir('newbook-bad');
    await assert.rejects(() => bundle.actions.createBookAt(t.dir, { title: '  ', author: '' }), /書名不能為空/);
    await assert.rejects(() => bundle.actions.createBookAt(t.dir, { title: '???', author: '' }), /都不能當資料夾名/);
    await assert.rejects(() => bundle.actions.createBookAt(' ', { title: '雪夜', author: '' }), /「放在」還空著/);
    assert.deepEqual(fs.readdirSync(t.dir), []);
  });
});
