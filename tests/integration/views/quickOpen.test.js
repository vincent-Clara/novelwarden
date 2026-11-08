/**
 * 「轉到…」（Ctrl+P）的索引（`src/core/views/quickOpen.ts`），真臨時工程。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 章節 | 一個章號一條：章號、標題（細綱優先，回落標題給空串）、卷目錄、正文 / 細綱路徑（沒有就缺席）、字數；`.txt` 正文也是章；只有細綱的章；細綱按路徑配對（改了名的正文不冒認舊細綱） |
 * | 角色 / 設定 | 名字與別名、設定標題、路徑（子目錄裡的也在） |
 * | 文件 | 架構三件、大綱、文風、敘事線、全文大綱，**有檔案的才列** |
 * | 草稿 | 路徑、檔名、檔名裡的章號 |
 * | 還不是小說工程 | `initialized: false`，列表全空 |
 * | 讀盤 | 章節與細綱借快取（熱的時候一章都不讀）；冷的時候每個檔案至多讀一次；草稿只列不讀 |
 * | controller | `requestQuickOpen` 回 `quickOpenIndex`，帶同一個 `requestId` |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let project;

const plot = (no, title) =>
  `---\nno: ${no}\ntitle: ${title}\n---\n\n# ${title}\n\n## 梗概\n梗概\n\n## 關鍵事件\n事件\n`;

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    quickOpen: './src/core/views/quickOpen.ts',
    editorLabel: './src/core/views/editorLabel.ts',
    controller: './src/core/controller/index.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  t = await makeTempProject(bundle.project, { prefix: 'quick-open', title: '青雲劍錄' });
  project = t.project;

  // 第 1 章：根下，有正文有細綱。
  t.write('chapters/001-楔子.md', '# 楔子\n\n雨下了三天。');
  t.write('.novelwarden/summaries/001-楔子.md', plot(1, '楔子'));
  // 第 2 章：第一卷裡，細綱的標題與正文的不一樣——細綱優先。
  t.write('chapters/第一卷/002-入鎮.md', '# 入鎮\n\n他走進鎮子。');
  t.write('.novelwarden/summaries/第一卷/002-入鎮.md', plot(2, '入鎮（改）'));
  // 第 3 章：.txt 正文，沒有細綱。
  t.write('chapters/第一卷/003-夜訪.txt', '夜裡有人敲門。');
  // 第 4 章：只有細綱，在第二卷。
  t.write('.novelwarden/summaries/第二卷/004-北行.md', plot(4, '北行'));
  // 第 5 章：純序號的正文，沒有標題。
  t.write('chapters/第二卷/005.md', '正文');
  // 第 6 章：正文在外面改了名，舊細綱成了孤兒——不冒認。
  t.write('chapters/第二卷/006-新名.md', '# 新名\n\n正文');
  t.write('.novelwarden/summaries/第二卷/006-舊名.md', plot(6, '舊名'));

  t.write('.novelwarden/characters/林昭.md', '---\nname: 林昭\naliases: [阿昭, 小林]\n---\n\n# 林昭\n');
  t.write('.novelwarden/characters/配角/李叔.md', '# 李叔\n');
  t.write('.novelwarden/lore/門派/青雲宗.md', '---\ntitle: 青雲宗\nkeywords: [門派]\n---\n\n# 青雲宗\n');
  t.write('drafts/第一卷/002-入鎮.md', '草稿');
  t.write('drafts/隨手記.md', '隨手記');
  t.write('.novelwarden/threads/林昭與沈青.md', '---\nkind: 感情線\n---\n\n# 林昭與沈青\n');
  t.write('.novelwarden/threads/未归属的伏笔.md', '# 未歸屬的伏筆\n');
  t.write('.novelwarden/threads/主線.md', '---\nkind: 主線\n---\n\n# 主線\n');
  // 七期的單檔案不認：不列。
  t.write('.novelwarden/threads.md', '# 敘事線\n');
  // 世界觀刪掉：沒有檔案的不列。
  fs.rmSync(t.rel('.novelwarden/world.md'));
  project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle.db);
});

describe('views/quickOpen › 索引', () => {
  let index;
  before(async () => {
    index = await bundle.quickOpen.buildQuickOpenIndex(project);
  });

  test('是小說工程', () => {
    assert.equal(index.initialized, true);
  });

  test('一個章號一條，按章號升序', () => {
    assert.deepEqual(index.chapters.map((c) => c.no), [1, 2, 3, 4, 5, 6]);
  });

  test('根下的章：卷目錄是空串，正文與細綱都在，字數是正文的', () => {
    assert.deepEqual(index.chapters[0], {
      no: 1,
      title: '楔子',
      volume: '',
      chapterPath: 'chapters/001-楔子.md',
      plotPath: '.novelwarden/summaries/001-楔子.md',
      words: 5,
    });
  });

  test('卷裡的章：卷目錄、細綱映象正文的路徑、標題取細綱的', () => {
    const c = index.chapters[1];
    assert.equal(c.volume, '第一卷');
    assert.equal(c.title, '入鎮（改）');
    assert.equal(c.chapterPath, 'chapters/第一卷/002-入鎮.md');
    assert.equal(c.plotPath, '.novelwarden/summaries/第一卷/002-入鎮.md');
  });

  test('.txt 正文也是一章；沒有細綱時 plotPath 缺席，標題取檔名', () => {
    const c = index.chapters[2];
    assert.equal(c.chapterPath, 'chapters/第一卷/003-夜訪.txt');
    assert.equal('plotPath' in c, false);
    assert.equal(c.title, '夜訪');
    assert.equal(c.words, 6);
  });

  test('只有細綱的章：chapterPath 缺席、字數 0、卷目錄取細綱所在的', () => {
    const c = index.chapters[3];
    assert.equal('chapterPath' in c, false);
    assert.equal(c.plotPath, '.novelwarden/summaries/第二卷/004-北行.md');
    assert.equal(c.volume, '第二卷');
    assert.equal(c.words, 0);
    assert.equal(c.title, '北行');
  });

  test('沒有標題的章：標題是空串（不把「第 5 章」當標題）', () => {
    assert.equal(index.chapters[4].title, '');
  });

  test('正文改過名的章不冒認舊細綱（按路徑配對）', () => {
    const c = index.chapters[5];
    assert.equal(c.chapterPath, 'chapters/第二卷/006-新名.md');
    assert.equal('plotPath' in c, false);
    assert.equal(c.title, '新名');
  });

  test('角色卡：名字、別名、路徑（子目錄裡的也在）', () => {
    const byName = (name) => index.characters.find((c) => c.name === name);
    assert.equal(index.characters.length, 2);
    assert.deepEqual(byName('林昭'), { name: '林昭', aliases: ['阿昭', '小林'], path: '.novelwarden/characters/林昭.md' });
    assert.deepEqual(byName('李叔'), { name: '李叔', aliases: [], path: '.novelwarden/characters/配角/李叔.md' });
  });

  test('設定條目：標題與路徑', () => {
    assert.deepEqual(index.lore, [{ title: '青雲宗', path: '.novelwarden/lore/門派/青雲宗.md' }]);
  });

  test('檔案：有檔案的才列（世界觀刪了不在），按架構 → 大綱 → 文風 → 敘事線 → 全文大綱；敘事線一條線一項（按檔名）、未歸屬的伏筆排最後', () => {
    assert.deepEqual(
      index.docs.map((d) => [d.key, d.label, d.path]),
      [
        ['config', '小說配置', '.novelwarden/config.md'],
        ['premise', '故事前提', '.novelwarden/premise.md'],
        ['outline', '情節大綱', '.novelwarden/outline.md'],
        ['style', '文風指南', '.novelwarden/style.md'],
        ['threads', '林昭與沈青', '.novelwarden/threads/林昭與沈青.md'],
        ['threads', '主線', '.novelwarden/threads/主線.md'],
        ['threads', '未歸屬的伏筆', '.novelwarden/threads/未归属的伏笔.md'],
        ['globalSummary', '全文大綱', '.novelwarden/summaries/global.md'],
      ]
    );
  });

  test('每份文件的稱呼與內建編輯器標籤上的一字不差（views/editorLabel.ts 同一張表）', () => {
    for (const doc of index.docs) {
      assert.equal(bundle.editorLabel.describeEditorFile(project, doc.path).title, doc.label, doc.path);
    }
  });

  test('草稿：路徑、檔名、檔名裡的章號（認不出就缺席）', () => {
    assert.deepEqual(index.drafts, [
      { path: 'drafts/第一卷/002-入鎮.md', name: '002-入鎮.md', no: 2 },
      { path: 'drafts/隨手記.md', name: '隨手記.md' },
    ]);
  });

  test('全文大綱不當成一章（summaries/global.md 沒有數字字首）', () => {
    assert.ok(!index.chapters.some((c) => c.plotPath === '.novelwarden/summaries/global.md'));
  });
});

describe('views/quickOpen › 還不是小說工程', () => {
  test('initialized: false，列表全空', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novelwarden-quick-open-bare-'));
    try {
      fs.mkdirSync(path.join(dir, 'chapters'));
      fs.writeFileSync(path.join(dir, 'chapters', '001-楔子.md'), '正文');
      const bare = bundle.project.NovelProject.open(dir);
      assert.deepEqual(await bundle.quickOpen.buildQuickOpenIndex(bare), {
        initialized: false,
        chapters: [],
        characters: [],
        lore: [],
        docs: [],
        drafts: [],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('views/quickOpen › 讀盤', () => {
  /** 量一次構建讀了哪些檔案（相對工程根）、各幾次。 */
  async function measure() {
    const original = fsp.readFile;
    const reads = new Map();
    fsp.readFile = async (...args) => {
      const key = path.relative(t.dir, path.resolve(String(args[0]))).replace(/\\/g, '/');
      reads.set(key, (reads.get(key) ?? 0) + 1);
      return original.apply(fsp, args);
    };
    try {
      await bundle.quickOpen.buildQuickOpenIndex(project);
    } finally {
      fsp.readFile = original;
    }
    return reads;
  }

  test('冷的時候：每個檔案至多讀一次', async () => {
    project.invalidate();
    const reads = await measure();
    const repeated = [...reads].filter(([, n]) => n > 1).map(([f]) => f);
    assert.deepEqual(repeated, []);
  });

  test('章節與細綱借工程上的快取：熱的時候一章正文、一份細綱都不讀', async () => {
    project.invalidate();
    await Promise.all([project.listChapters(), project.listPlots()]);
    const reads = await measure();
    const touched = [...reads.keys()].filter((f) => f.startsWith('chapters/') || f.startsWith('.novelwarden/summaries/'));
    assert.deepEqual(touched, []);
  });

  test('草稿、敘事線只列不讀；大綱、配置、manifest 的內容一律不讀', async () => {
    const reads = await measure();
    const touched = [...reads.keys()].filter(
      (f) =>
        f.startsWith('drafts/') ||
        ['.novelwarden/outline.md', '.novelwarden/config.md', '.novelwarden/project.json'].includes(f) ||
        f.startsWith('.novelwarden/threads')
    );
    assert.deepEqual(touched, []);
  });
});

describe('controller › requestQuickOpen', () => {
  test('回 quickOpenIndex，帶同一個 requestId', async () => {
    const posted = [];
    const controller = new bundle.controller.ChatController(project);
    controller.attach({ kind: 'sidebar', post: (m) => posted.push(m), reveal() {} });
    try {
      await controller.handle({ type: 'requestQuickOpen', requestId: 'qo-1' });
      const reply = posted.find((m) => m.type === 'quickOpenIndex');
      assert.ok(reply, JSON.stringify(posted.map((m) => m.type)));
      assert.equal(reply.requestId, 'qo-1');
      assert.equal(reply.index.chapters.length, 6);
    } finally {
      controller.dispose();
    }
  });
});
