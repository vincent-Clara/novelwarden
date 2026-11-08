/**
 * 內建編輯器的章節索引（`chapterIndex` 訊息）的後端一半。
 *
 * 章節條上的字數、狀態與上一章 / 下一章的章節順序從前只靠工程樹（`project` 訊息），而工程樹**只在「工程」頁籤
 * 開著時才推**——作者大多待在對話頁，章節條因此是舊的，從沒開啟過工程頁時乾脆沒有資料。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 連上就推一份（`init` 之後），哪個頁籤都推 | 編輯器不必等作者切到工程頁 |
 * | 一章一行、按章號升序，欄位與工程樹那一行一字不差 | 同一個函式算的；章節條與工程頁不許說兩樣 |
 * | 存了正文（`pushState`）就推新的，字數跟著變 | 資料要隨時是新的 |
 * | 內容沒變的 `pushState` 不推 | 作者每存一次盤就跑一次 `pushState`，絕大多數時候章節沒動 |
 * | 新連上的前端（`ready`）照樣推，哪怕沒變 | 它手上什麼都沒有 |
 * | 還不是小說工程：空的 | 第 1 條：不崩 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject, makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { makeSettings } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let controller;
let posted = [];
/** 最近一次推出去的那份章節索引（不論這一輪推沒推）。 */
let latest = [];

const all = (type) => posted.filter((m) => m.type === type);
const lastOf = (type) => [...posted].reverse().find((m) => m.type === type);

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    projectView: './src/core/views/projectView.ts',
    controller: './src/core/controller/index.ts',
    db: './src/core/runtime/db.ts',
  });
  const settings = makeSettings({ contextWindow: 100000 });
  bundle.host.initHost(makeFakeHost({ name: 'standalone', settings: () => settings }).host);
  t = await makeTempProject(bundle.project, { prefix: 'chapter-index', title: '青雲劍錄' });
  t.write('chapters/001-雨夜.md', '# 雨夜\n\n他推開門。\n');
  t.write('chapters/第一卷/002-入鎮.md', '# 入鎮\n\n鎮上起了霧。\n');
  t.write('.novelwarden/summaries/003-北行.md', '---\ntargetWords: 3000\n---\n# 第3章 北行\n\n## 關鍵事件\n\n- 出城\n');
  controller = new bundle.controller.ChatController(t.project);
  controller.attach({
    kind: 'sidebar',
    post: (m) => {
      posted.push(m);
      if (m.type === 'chapterIndex') {
        latest = m.chapters;
      }
    },
    reveal() {},
  });
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('chapterIndex：連上就推，哪個頁籤都推', () => {
  before(async () => {
    // 檔案是建好工程之後才寫的：章節 / 細綱列表的快取要失效（真實環境裡由檔案監聽觸發的 pushState 做）。
    t.project.invalidate();
    posted = [];
    await controller.handle({ type: 'ready' });
  });

  test('ready 之後推了一份，排在 init 後面', () => {
    const types = posted.map((m) => m.type);
    assert.ok(types.includes('chapterIndex'), types.join(','));
    assert.ok(types.indexOf('init') < types.indexOf('chapterIndex'), types.join(','));
  });

  test('在對話頁（沒開過工程頁）：沒推工程樹，章節索引照樣在', () => {
    assert.equal(controller.tab, 'chat');
    assert.equal(all('project').length, 0);
    assert.equal(lastOf('chapterIndex').chapters.length, 3);
  });

  test('一章一行、按章號升序，正文與細綱的路徑都在', () => {
    const rows = lastOf('chapterIndex').chapters;
    assert.deepEqual(rows.map((r) => r.no), [1, 2, 3]);
    assert.deepEqual(
      rows.map((r) => [r.chapterPath, r.plotPath, r.plotExists]),
      [
        ['chapters/001-雨夜.md', '.novelwarden/summaries/001-雨夜.md', false],
        // 分卷的正文：細綱映象它的相對路徑（第 8 條）。
        ['chapters/第一卷/002-入鎮.md', '.novelwarden/summaries/第一卷/002-入鎮.md', false],
        ['', '.novelwarden/summaries/003-北行.md', true],
      ]
    );
  });

  test('只排了細綱的那一章：主路徑是細綱、目標字數取細綱的', () => {
    const row = lastOf('chapterIndex').chapters[2];
    assert.equal(row.relPath, '.novelwarden/summaries/003-北行.md');
    assert.equal(row.targetWords, 3000);
    assert.equal(row.wordCount, 0);
    assert.equal(row.label, '第 3 章《北行》');
  });

  test('欄位與工程樹那一行一字不差', async () => {
    t.project.invalidate();
    const tree = await bundle.projectView.buildProjectTree(t.project);
    const keys = ['no', 'label', 'title', 'relPath', 'plotPath', 'plotExists', 'chapterPath', 'wordCount', 'targetWords', 'stage'];
    const pick = (o) => Object.fromEntries(keys.map((k) => [k, o[k]]));
    assert.deepEqual(lastOf('chapterIndex').chapters.map(pick), tree.plots.map(pick));
  });
});

describe('chapterIndex：變了才推', () => {
  test('什麼都沒變的 pushState：不推', async () => {
    posted = [];
    await controller.pushState();
    assert.ok(lastOf('state'), '連 state 都沒推');
    assert.equal(all('chapterIndex').length, 0);
  });

  test('正文多寫了幾個字：推新的，字數跟著變', async () => {
    const before = latest.find((r) => r.no === 1).wordCount;
    t.write('chapters/001-雨夜.md', '# 雨夜\n\n他推開門。門外的雨下了一整夜。\n');
    posted = [];
    await controller.pushState();
    const row = lastOf('chapterIndex').chapters.find((r) => r.no === 1);
    assert.ok(row.wordCount > before, `${before} → ${row.wordCount}`);
  });

  test('新寫了第 3 章正文：那一行有了正文路徑', async () => {
    t.write('chapters/003-北行.md', '# 北行\n\n出了城。\n');
    posted = [];
    await controller.pushState();
    const row = lastOf('chapterIndex').chapters.find((r) => r.no === 3);
    assert.equal(row.chapterPath, 'chapters/003-北行.md');
    assert.equal(row.relPath, 'chapters/003-北行.md');
  });

  test('新連上的前端：沒變也推', async () => {
    posted = [];
    await controller.handle({ type: 'ready' });
    assert.equal(all('chapterIndex').length, 1);
  });

  // 編輯器狀態列的「距目標」只認這個欄位：它必須與寫正文時判「寫夠沒有」的目標是同一個數——
  // 細綱的 targetWords，沒寫就是 config.md 的每章字數（controller/chat.ts 的 targetWordsOf 同一個式子）。
  test('細綱沒寫目標字數的章：目標取小說配置的每章字數；細綱寫了的照舊取細綱的', async () => {
    t.write('.novelwarden/config.md', '---\nwordsPerChapter: 2500\n---\n# 小說配置\n');
    posted = [];
    await controller.pushState();
    const rows = lastOf('chapterIndex').chapters;
    assert.deepEqual(rows.map((r) => [r.no, r.targetWords]), [[1, 2500], [2, 2500], [3, 3000]]);
  });
});

describe('chapterIndex：還不是小說工程', () => {
  let dir;
  let bare;
  const got = [];

  before(async () => {
    dir = makeTempDir('chapter-index-bare');
    bare = new bundle.controller.ChatController(bundle.project.NovelProject.open(dir.dir));
    bare.attach({ kind: 'sidebar', post: (m) => got.push(m), reveal() {} });
    await bare.handle({ type: 'ready' });
  });

  after(() => {
    bare?.dispose();
    if (dir) cleanup(dir.dir, bundle?.db);
  });

  test('推一份空的，不崩', () => {
    const msg = got.find((m) => m.type === 'chapterIndex');
    assert.ok(msg, got.map((m) => m.type).join(','));
    assert.deepEqual(msg.chapters, []);
  });
});
