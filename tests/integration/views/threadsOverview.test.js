/**
 * 編輯區「敘事線總覽」的資料（`views/threads.ts` 的 `buildThreadsOverview`，敘事線重做三期），真臨時工程：讀一遍敘事線目錄
 * 與章節、細綱兩份列表，交給純函式 `buildThreadsMatrix`（那一半的細節在 tests/unit/views/threadsOverview.test.js）。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 列 | 有細綱或正文的章一章一列：標題（細綱優先，回落標題給空串）、卷目錄、四種定稿狀態、正文 / 細綱路徑；細綱按路徑配對 |
 * | 現在 | 「定稿到第 N 章」與工程頁「敘事線」頁籤同一個數 |
 * | 行 | 一條線一個檔案讀進來，分組與伏筆都在；七期的 `threads.md` 不認 |
 * | 還不是小說工程 | `initialized: false`，其餘都是空的 |
 * | 不寫盤 | 讀完之後工程目錄一個位元組沒變 |
 * | controller | `requestThreadsOverview` 回 `threadsOverview`，帶同一個 `requestId` |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let project;

const plot = (no, title, extra = '') => `---\nno: ${no}\ntitle: ${title}\n${extra}---\n\n# ${title}\n\n## 梗概\n梗概\n\n## 關鍵事件\n事件\n`;

/** 工程目錄下全部檔案的「路徑 → 內容」（看讀完之後有沒有寫盤）。 */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, ent.name);
      if (ent.isDirectory()) {
        walk(abs);
      } else if (!/\.(db|sqlite)(-\w+)?$/.test(ent.name)) {
        out[path.relative(dir, abs)] = fs.readFileSync(abs, 'utf8');
      }
    }
  };
  walk(dir);
  return out;
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    threads: './src/core/views/threads.ts',
    projectView: './src/core/views/projectView.ts',
    controller: './src/core/controller/index.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  t = await makeTempProject(bundle.project, { prefix: 'threads-overview', title: '青雲劍錄' });
  project = t.project;

  // 第 1 章：根下，定稿過。
  t.write('chapters/001-楔子.md', '# 楔子\n\n雨下了三天。');
  t.write('.novelwarden/summaries/001-楔子.md', plot(1, '楔子', 'sourceHash: abc\n'));
  // 第 2 章：第一卷裡，定稿過；細綱的標題優先。
  t.write('chapters/第一卷/002-入鎮.md', '# 入鎮\n\n他走進鎮子。');
  t.write('.novelwarden/summaries/第一卷/002-入鎮.md', plot(2, '入鎮（改）', 'sourceHash: def\n'));
  // 第 3 章：寫了沒定稿，沒有細綱。
  t.write('chapters/第一卷/003-夜訪.txt', '夜裡有人敲門。');
  // 第 4 章：只有細綱。
  t.write('.novelwarden/summaries/第一卷/004-北行.md', plot(4, '北行'));
  // 第 5 章：正文在外面改了名，舊細綱成了孤兒——不冒認，這一章「寫了沒定稿」。
  t.write('chapters/第一卷/005-新名.md', '# 新名\n\n正文');
  t.write('.novelwarden/summaries/第一卷/005-舊名.md', plot(5, '舊名', 'sourceHash: ghi\n'));

  t.write(
    '.novelwarden/threads/林昭與沈青.md',
    [
      '---',
      'kind: 感情線',
      'plan: 1-8',
      '---',
      '',
      '# 林昭與沈青',
      '',
      '## 意圖',
      '從互相猜忌到並肩',
      '',
      '## 伏筆',
      '- 玉佩的來歷：林昭的玉佩是沈家舊物（計劃第 1 章埋、第 6 章前收）',
      '',
      '## 進展',
      '- 第 1 章 · 推進：兩人初遇 〔證據：「她的劍停在他喉前三寸」〕',
      '- 第 1 章 · 埋〈玉佩的來歷〉：玉佩露面 〔證據：「他摸了摸懷裡的玉佩」〕',
      '- 第 2 章 · 計劃 · 推進：結盟',
      '- 第 4 章 · 計劃 · 收〈玉佩的來歷〉：認出雲紋',
      '',
    ].join('\n')
  );
  t.write('.novelwarden/threads/青崖舊案.md', '---\nkind: 主線\n---\n\n# 青崖舊案\n\n## 進展\n- 第 2 章 · 推進：找到令牌\n');
  t.write('.novelwarden/threads/未归属的伏笔.md', '# 未歸屬的伏筆\n\n## 伏筆\n- 斷劍（第 3 章前收）\n');
  // 七期的單檔案不認。
  t.write('.novelwarden/threads.md', '# 敘事線\n\n## 舊的線\n- 第 1 章 · 推進：不該出現\n');
  // 第 1、2 章定稿時敘事線判過了：水位記在 project.json（四期），偏差只算判過的章。
  await project.writeManifest({ ...(await project.readManifest()), threadsThrough: 2 });
  project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle.db);
});

describe('views/threads › buildThreadsOverview', () => {
  test('列：有細綱或正文的章一章一列，標題、卷、定稿狀態、兩份路徑；計劃提到的第 6–8 章補 none', async () => {
    const o = await bundle.threads.buildThreadsOverview(project);
    assert.equal(o.initialized, true);
    assert.deepEqual(
      o.chapters.map((c) => [c.no, c.title, c.volume, c.state]),
      [
        [1, '楔子', '', 'finalized'],
        [2, '入鎮（改）', '第一卷', 'finalized'],
        [3, '夜訪', '第一卷', 'written'],
        [4, '北行', '第一卷', 'planned'],
        [5, '新名', '第一卷', 'written'],
        [6, '', '第一卷', 'none'],
        [7, '', '第一卷', 'none'],
        [8, '', '第一卷', 'none'],
      ]
    );
    const at = (no) => o.chapters.find((c) => c.no === no);
    assert.equal(at(1).chapterPath, 'chapters/001-楔子.md');
    assert.equal(at(1).plotPath, '.novelwarden/summaries/001-楔子.md');
    assert.equal(at(3).plotPath, undefined);
    assert.equal(at(4).chapterPath, undefined);
    assert.equal(at(5).plotPath, undefined, '改了名的正文不冒認舊細綱');
    assert.equal(o.volumes, true);
  });

  test('「現在」與工程頁「敘事線」頁籤同一個數', async () => {
    const o = await bundle.threads.buildThreadsOverview(project);
    const tree = await bundle.projectView.buildProjectTree(project);
    assert.equal(o.current, 2);
    assert.equal(o.current, tree.threads.current);
  });

  test('行：一條線一個檔案，按種類分組、伏筆線上下；「未歸屬的伏筆」在最後；七期的 threads.md 不認', async () => {
    const o = await bundle.threads.buildThreadsOverview(project);
    assert.deepEqual(o.groups.map((g) => [g.kind, g.lines.map((l) => l.name)]), [
      ['主线', ['青崖舊案']],
      ['感情线', ['林昭與沈青']],
    ]);
    const pair = o.groups[1].lines[0];
    assert.equal(pair.relPath, '.novelwarden/threads/林昭與沈青.md');
    // 第 2 章計劃結盟、第 2 章定稿了卻沒發生：偏差。
    assert.equal(pair.cells.find((c) => c.chapter === 2).deviation, true);
    const jade = pair.foreshadowing[0];
    assert.equal(jade.name, '玉佩的來歷');
    // 第 4 章計劃收、第 4 章沒定稿：不是偏差；虛線從第 1 章延到回收章第 6 章。
    assert.equal(jade.cells.find((c) => c.chapter === 4).deviation, false);
    assert.deepEqual(jade.span, { from: 1, to: 6, kind: 'open' });
    assert.deepEqual(o.unfiled.foreshadowing.map((f) => f.name), ['斷劍']);
    assert.ok(!JSON.stringify(o).includes('不該出現'));
  });

  test('不寫盤：讀完之後工程目錄一個位元組沒變', async () => {
    const before = snapshot(t.dir);
    await bundle.threads.buildThreadsOverview(project);
    assert.deepEqual(snapshot(t.dir), before);
  });

  test('還不是小說工程：initialized 為 false，其餘都是空的', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novelwarden-threads-overview-bare-'));
    try {
      const bare = bundle.project.NovelProject.open(dir);
      assert.deepEqual(await bundle.threads.buildThreadsOverview(bare), {
        initialized: false,
        chapters: [],
        current: 0,
        through: 0,
        volumes: false,
        groups: [],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('controller › requestThreadsOverview', () => {
  test('回 threadsOverview，帶同一個 requestId', async () => {
    const posted = [];
    const controller = new bundle.controller.ChatController(project);
    controller.attach({ kind: 'sidebar', post: (m) => posted.push(m), reveal() {} });
    try {
      await controller.handle({ type: 'requestThreadsOverview', requestId: 'tov-1' });
      const reply = posted.find((m) => m.type === 'threadsOverview');
      assert.ok(reply, JSON.stringify(posted.map((m) => m.type)));
      assert.equal(reply.requestId, 'tov-1');
      assert.equal(reply.overview.initialized, true);
      assert.equal(reply.overview.groups.length, 2);
    } finally {
      controller.dispose();
    }
  });
});
