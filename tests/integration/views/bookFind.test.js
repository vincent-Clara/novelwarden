/**
 * 全書查詢（`src/core/views/bookFind.ts`），真臨時工程。一份檔案裡的口徑（護住的字、上下文）在
 * tests/unit/model/bookFind.test.js，替換在 tests/integration/features/bookReplace.test.js。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 按範圍 | 只搜勾著的範圍；範圍按面板順序、正文 / 細綱 / 草稿按章號；二進位制草稿不讀 |
 * | 稱呼 | 「第 3 章 夜訪」「細綱 · 第 1 章 楔子」「草稿 · …」「角色 · 林晚」「設定 · 青雲宗」「情節大綱」 |
 * | 每份檔案 | hash 與編輯器的樂觀鎖同一個演算法；一共幾處；每一處的行、列、上下文 |
 * | 護住的字 | 細綱 frontmatter 裡的指紋不搜 |
 * | 預覽 | 帶 replacement 時每一處帶換成什麼（正則 `$1` 逐處展開） |
 * | 上限 | 列滿就停：多出來的不列、後面的檔案不讀、說停在哪一份上 |
 * | 叫停 | 叫停了就不往下讀、返回 undefined；controller 上叫停的請求不回話（先到的叫停也認） |
 * | 跳過 | 超過 2 MB 的不讀、列進 skipped |
 * | 正則寫錯 | 一份都不讀，給 error |
 * | 讀盤 | 每份檔案讀一次（列表借工程上的快取） |
 * | controller | `bookFind` 回 `bookFindResult`，帶同一個 requestId |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let project;

const plotText = (no, title, extra = '') =>
  `---\nno: ${no}\ntitle: ${title}\nsourceHash: 1a1a1a\ncast: [林晚]\n---\n\n# 第${no}章 ${title}\n\n## 梗概\n林晚${extra}\n\n## 關鍵事件\n- 事件\n`;

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    bookFind: './src/core/views/bookFind.ts',
    workspace: './src/core/workspace/index.ts',
    controller: './src/core/controller/index.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  t = await makeTempProject(bundle.project, { prefix: 'book-find', title: '青雲劍錄' });
  project = t.project;

  t.write('chapters/001-楔子.md', '# 楔子\n\n林晚推開門。\n林晚沒有說話。\n');
  t.write('chapters/第一卷/002-入鎮.md', '# 入鎮\n\n鎮上沒人認得林晚。\n');
  t.write('chapters/第一卷/003-夜訪.txt', '夜裡，林晚敲了敲門。');
  t.write('chapters/010-遠行.md', '# 遠行\n\n一個人走了。\n');
  t.write('.novelwarden/summaries/001-楔子.md', plotText(1, '楔子'));
  t.write('.novelwarden/summaries/第一卷/002-入鎮.md', plotText(2, '入鎮', '進鎮'));
  t.write('drafts/001-楔子.md', '草稿裡的林晚');
  t.write('drafts/封面.png', '林晚');
  t.write('.novelwarden/characters/林晚.md', '---\nname: 林晚\naliases: [阿晚]\n---\n\n# 林晚\n\n## 身份\n林晚是主角。\n');
  t.write('.novelwarden/lore/門派/青雲宗.md', '---\ntitle: 青雲宗\n---\n\n# 青雲宗\n\n林晚拜入的門派。\n');
  // 老工程留下的 outline.md：情節大綱現在是各章細綱梗概的彙總，這一份不再讀，也不在全書查詢裡。
  t.write('.novelwarden/outline.md', '# 情節大綱\n\n## 第1–5章：林晚入宗\n林晚拜入青雲宗。\n');
  project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle.db);
});

const search = (q, opts) => bundle.bookFind.searchBook(project, { query: '林晚', scopes: ['chapter'], ...q }, opts);

describe('views/bookFind › 按範圍', () => {
  test('只搜正文：按章號，分卷的、.txt 的都在；沒有命中的不列', async () => {
    const r = await search({});
    assert.deepEqual(r.files.map((f) => f.path), ['chapters/001-楔子.md', 'chapters/第一卷/002-入鎮.md', 'chapters/第一卷/003-夜訪.txt']);
    assert.deepEqual(r.files.map((f) => f.count), [2, 1, 1]);
    assert.equal(r.listed, 4);
    assert.equal(r.scanned, 4);
    assert.equal(r.truncated, undefined);
    assert.deepEqual(r.skipped, []);
  });

  test('稱呼與編輯器標籤、麵包屑同一套', async () => {
    const r = await search({ scopes: ['chapter', 'plot', 'draft', 'character', 'lore', 'doc'] });
    assert.deepEqual(r.files.map((f) => [f.scope, f.label]), [
      ['chapter', '第 1 章 楔子'],
      ['chapter', '第 2 章 入鎮'],
      ['chapter', '第 3 章 夜訪'],
      ['plot', '細綱 · 第 1 章 楔子'],
      ['plot', '細綱 · 第 2 章 入鎮'],
      ['draft', '草稿 · 第 1 章 楔子'],
      ['character', '角色 · 林晚'],
      ['lore', '設定 · 青雲宗'],
    ]);
  });

  test('二進位制副檔名的草稿不讀', async () => {
    const r = await search({ scopes: ['draft'] });
    assert.deepEqual(r.files.map((f) => f.path), ['drafts/001-楔子.md']);
  });

  test('一個範圍都沒勾：什麼都不搜', async () => {
    const r = await search({ scopes: [] });
    assert.deepEqual(r, { files: [], listed: 0, scanned: 0, skipped: [] });
  });
});

describe('views/bookFind › 每份檔案', () => {
  test('hash 與編輯器開啟它時拿到的一樣（替換時的樂觀鎖基線）', async () => {
    const r = await search({});
    const ws = new bundle.workspace.Workspace(project);
    for (const f of r.files) {
      assert.equal(f.hash, (await ws.read(f.path)).hash, f.path);
    }
  });

  test('每一處：行、列、同一行的上下文', async () => {
    const r = await search({});
    assert.deepEqual(
      r.files[0].hits.map((h) => ({ line: h.line, col: h.col, before: h.before, text: h.text, after: h.after })),
      [
        { line: 3, col: 0, before: '', text: '林晚', after: '推開門。' },
        { line: 4, col: 0, before: '', text: '林晚', after: '沒有說話。' },
      ]
    );
  });

  test('細綱 frontmatter 裡的指紋不搜，cast 照搜', async () => {
    const digits = await search({ query: '1a', scopes: ['plot'] });
    assert.deepEqual(digits.files, []);
    const cast = await search({ scopes: ['plot'] });
    assert.equal(cast.files[0].count, 2, 'cast 裡一處、梗概裡一處');
  });

  test('預覽：每一處帶換成什麼，正則 $1 逐處展開', async () => {
    const lit = await search({ replacement: '林婉' });
    assert.ok(lit.files.every((f) => f.hits.every((h) => h.replacement === '林婉')));
    const re = await search({ query: '(林)晚', regex: true, replacement: '$1婉' });
    assert.ok(re.files.every((f) => f.hits.every((h) => h.replacement === '林婉')));
  });
});

describe('views/bookFind › 上限、叫停、跳過、壞正則', () => {
  test('列滿就停：這一份多出來的不列，後面的檔案不讀，說停在哪一份上', async () => {
    const r = await search({}, { limit: 1 });
    assert.equal(r.listed, 1);
    assert.deepEqual(r.files.map((f) => [f.path, f.count, f.hits.length]), [['chapters/001-楔子.md', 2, 1]]);
    assert.deepEqual(r.truncated, { limit: 1, at: '第 1 章 楔子' });
    assert.equal(r.scanned, 1);
  });

  test('正好列滿：下一份有命中才說到了上限，停在那一份上（那一份不列）', async () => {
    const r = await search({}, { limit: 2 });
    assert.equal(r.listed, 2);
    assert.deepEqual(r.files.map((f) => f.path), ['chapters/001-楔子.md']);
    assert.deepEqual(r.truncated, { limit: 2, at: '第 2 章 入鎮' });
  });

  test('叫停：不往下讀，返回 undefined', async () => {
    let asked = 0;
    const r = await search({}, { cancelled: () => ++asked > 1 });
    assert.equal(r, undefined);
  });

  test('超過 2 MB 的不讀，列進 skipped', async () => {
    t.write('chapters/020-巨章.md', `林晚${'字'.repeat(1024 * 1024)}`);
    project.invalidate();
    try {
      const r = await search({});
      assert.deepEqual(r.skipped.map((s) => [s.path, s.label]), [['chapters/020-巨章.md', '第 20 章 巨章']]);
      assert.match(r.skipped[0].reason, /2 MB/);
      assert.ok(!r.files.some((f) => f.path === 'chapters/020-巨章.md'));
    } finally {
      t.remove('chapters/020-巨章.md');
      project.invalidate();
    }
  });

  test('正則寫錯：一份都不讀，給 error', async () => {
    const r = await search({ query: '(', regex: true });
    assert.ok(r.error);
    assert.equal(r.scanned, 0);
  });
});

describe('views/bookFind › 讀盤', () => {
  test('列表借工程上的快取：熱的時候每份檔案讀一次', async () => {
    project.invalidate();
    await Promise.all([project.listChapters(), project.listPlots()]);
    const original = fsp.readFile;
    const reads = new Map();
    fsp.readFile = async (...args) => {
      const key = path.relative(t.dir, path.resolve(String(args[0]))).replace(/\\/g, '/');
      reads.set(key, (reads.get(key) ?? 0) + 1);
      return original.apply(fsp, args);
    };
    try {
      await search({ scopes: ['chapter', 'plot', 'draft', 'character', 'lore', 'doc'] });
    } finally {
      fsp.readFile = original;
    }
    assert.deepEqual([...reads].filter(([, n]) => n > 1), []);
    assert.equal(reads.get('chapters/010-遠行.md'), 1, '沒有命中的也讀了一次');
    assert.equal(reads.has('drafts/封面.png'), false);
  });
});

describe('controller › bookFind', () => {
  function attach() {
    const posted = [];
    const controller = new bundle.controller.ChatController(project);
    controller.attach({ kind: 'sidebar', post: (m) => posted.push(m), reveal() {} });
    return { controller, posted };
  }

  test('回 bookFindResult，帶同一個 requestId', async () => {
    const { controller, posted } = attach();
    try {
      await controller.handle({ type: 'bookFind', requestId: 'bf-1', query: { query: '林晚', scopes: ['chapter'] } });
      const reply = posted.find((m) => m.type === 'bookFindResult');
      assert.ok(reply, JSON.stringify(posted.map((m) => m.type)));
      assert.equal(reply.requestId, 'bf-1');
      assert.equal(reply.result.listed, 4);
    } finally {
      controller.dispose();
    }
  });

  test('叫停的請求不回話：搜到一半叫停的，與叫停先到的', async () => {
    const { controller, posted } = attach();
    try {
      const running = controller.handle({ type: 'bookFind', requestId: 'bf-2', query: { query: '林晚', scopes: ['chapter', 'plot'] } });
      await controller.handle({ type: 'cancelBookFind', requestId: 'bf-2' });
      await running;
      await controller.handle({ type: 'cancelBookFind', requestId: 'bf-3' });
      await controller.handle({ type: 'bookFind', requestId: 'bf-3', query: { query: '林晚', scopes: ['chapter'] } });
      assert.deepEqual(posted.filter((m) => m.type === 'bookFindResult'), []);
    } finally {
      controller.dispose();
    }
  });
});
