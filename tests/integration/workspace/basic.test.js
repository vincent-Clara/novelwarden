/**
 * Workspace 門面的六個方法：list / read / write / edit / move / remove。
 *
 * 本組只覆蓋最基礎的兩個 handler——`plain`（other / draft）與
 * `doc`（outline / style / globalSummary / character / lore）。
 * 帶記賬的那幾種（plot / chapter）與定稿寫入（finalizePlot）在 hashChain.test.js。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let t;
let project;
let ws;

async function codeOf(fn) {
  try {
    await fn();
  } catch (err) {
    return err?.code ?? `（不是 WsError：${err?.message}）`;
  }
  return '（沒拋）';
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    fs: './src/core/model/fs.ts',
    guard: './src/core/workspace/guard.ts',
    ws: './src/core/workspace/index.ts',
  });
  h = makeFakeHost({ settings: () => ({}), overrides: { reviewReplace: undefined } });
  bundle.host.initHost(h.host);
  t = await makeTempProject(bundle.project, { prefix: 'wsbasic' });
  project = t.project;
  ws = new bundle.ws.Workspace(project);
});

after(() => {
  if (t) cleanup(t.dir);
});

describe('write · 新建', () => {
  let r;

  before(async () => {
    r = await ws.write('隨手記.md', { text: '雨下了三天。' }, { mode: 'create' });
  });

  test('落盤了', () => {
    assert.equal(t.read('隨手記.md').trim(), '雨下了三天。');
  });

  test('返回相對路徑', () => {
    assert.equal(r.rel, '隨手記.md');
  });

  test('沒被跳過', () => {
    assert.equal(r.skipped, undefined);
  });

  test('message 說得出寫到哪了', () => {
    assert.ok(r.message.includes('隨手記.md'), r.message);
  });

  test('預設 mode 就是 create', async () => {
    assert.equal(await codeOf(() => ws.write('隨手記.md', { text: '再來' })), 'exists');
  });
});

describe('write · 同名不覆蓋', () => {
  test('mode: create 撞上已有檔案拋 exists', async () => {
    assert.equal(
      await codeOf(() => ws.write('隨手記.md', { text: '新的' }, { mode: 'create' })),
      'exists'
    );
  });

  test('拋了之後磁碟一字未改', () => {
    assert.equal(t.read('隨手記.md').trim(), '雨下了三天。');
  });
});

describe('write · 覆蓋前審閱', () => {
  test('假宿主同意就覆蓋', async () => {
    h.expect('覆蓋');
    const r = await ws.write('隨手記.md', { text: '改過的內容' }, { mode: 'overwrite' });
    assert.equal(r.skipped, undefined, JSON.stringify(r));
    assert.equal(t.read('隨手記.md').trim(), '改過的內容');
  });

  test('假宿主拒絕就跳過', async () => {
    h.expect('保留原樣');
    const r = await ws.write('隨手記.md', { text: '不該寫進去' }, { mode: 'overwrite' });
    assert.equal(r.skipped, true, JSON.stringify(r));
  });

  test('拒絕之後磁碟一字未改', () => {
    assert.equal(t.read('隨手記.md').trim(), '改過的內容');
  });

  test('review: false 時不問直接寫', async () => {
    h.expect();
    const r = await ws.write('隨手記.md', { text: '強寫' }, { mode: 'overwrite', review: false });
    assert.equal(r.skipped, undefined);
    assert.equal(h.confirms.length, 0);
    assert.equal(t.read('隨手記.md').trim(), '強寫');
  });

  test('what 給了就用它當審閱框裡的名字', async () => {
    h.expect('保留原樣');
    await ws.write('隨手記.md', { text: '甲' }, { mode: 'overwrite', what: '我的隨手記' });
    assert.ok(h.confirms[0].message.includes('我的隨手記'), h.confirms[0].message);
  });
});

describe('write · 樂觀鎖', () => {
  test('baseHash 對得上就寫', async () => {
    const base = bundle.fs.hash(t.read('隨手記.md'));
    h.expect('覆蓋');
    const r = await ws.write('隨手記.md', { text: '基線對得上' }, { mode: 'overwrite', baseHash: base });
    assert.equal(r.skipped, undefined);
  });

  test('baseHash 對不上拋 conflict', async () => {
    assert.equal(
      await codeOf(() =>
        ws.write('隨手記.md', { text: '不該寫' }, { mode: 'overwrite', baseHash: '舊的' })
      ),
      'conflict'
    );
  });

  test('衝突之後磁碟一字未改', () => {
    assert.equal(t.read('隨手記.md').trim(), '基線對得上');
  });
});

describe('write · append', () => {
  test('往不存在的檔案 append 等於新建', async () => {
    const r = await ws.write('日誌.md', { text: '第一段' }, { mode: 'append' });
    assert.equal(r.skipped, undefined);
    assert.ok(t.read('日誌.md').includes('第一段'));
  });

  test('append 不覆蓋，也不問', async () => {
    h.expect();
    await ws.write('日誌.md', { text: '第二段' }, { mode: 'append' });
    const text = t.read('日誌.md');
    assert.ok(text.includes('第一段') && text.includes('第二段'), text);
    assert.equal(h.confirms.length, 0);
  });

  test('別的檔案結尾沒有標點也照樣空一行', () => {
    assert.match(t.read('日誌.md'), /第一段\n\n第二段/);
  });

  test('章節停在半句上：接著寫的那半截直接接上，不空行；收在句末才空一行', async () => {
    t.write('chapters/091-半句.md', '他已經到了極限，全身\n');
    await ws.write('chapters/091-半句.md', { text: '的骨頭都在響。' }, { mode: 'append' });
    assert.equal(t.read('chapters/091-半句.md'), '他已經到了極限，全身的骨頭都在響。\n');
    await ws.write('chapters/091-半句.md', { text: '天亮了。' }, { mode: 'append' });
    assert.equal(t.read('chapters/091-半句.md'), '他已經到了極限，全身的骨頭都在響。\n\n天亮了。\n');
  });
});

describe('read', () => {
  before(async () => {
    t.write('長文.md', Array.from({ length: 200 }, (_, i) => `第 ${i + 1} 行`).join('\n'));
  });

  test('讀得回內容', async () => {
    const f = await ws.read('隨手記.md');
    assert.equal(f.text.trim(), '基線對得上');
  });

  test('帶上 hash（樂觀鎖基線）', async () => {
    const f = await ws.read('隨手記.md');
    assert.equal(f.hash, bundle.fs.hash(t.read('隨手記.md')));
  });

  test('帶上種類', async () => {
    assert.equal((await ws.read('.novelwarden/outline.md')).kind, 'outline');
  });

  test('讀不存在的拋 notFound', async () => {
    assert.equal(await codeOf(() => ws.read('查無此文.md')), 'notFound');
  });

  test('越界拋 outOfRoot', async () => {
    assert.equal(await codeOf(() => ws.read('../外面.md')), 'outOfRoot');
  });

  // 不靜默截斷（AGENTS 第 2 條）：截了多少必須說出來。
  test('按 limit 截斷時只給那幾行', async () => {
    const f = await ws.read('長文.md', { offset: 10, limit: 5 });
    assert.equal(f.text.split('\n').length, 5, f.text);
    assert.ok(f.text.startsWith('第 11 行'), f.text);
  });

  test('截斷時 truncated 說明從哪開始、共多少行', async () => {
    const f = await ws.read('長文.md', { offset: 10, limit: 5 });
    assert.deepEqual(f.truncated, { from: 10, total: 200 });
  });

  test('沒截斷時不給 truncated', async () => {
    const f = await ws.read('隨手記.md');
    assert.equal(f.truncated, undefined);
  });
});

describe('edit', () => {
  before(() => {
    t.write('改改.md', '甲說了一句。乙說了一句。甲又說了一句。\n');
  });

  test('替換唯一命中', async () => {
    const r = await ws.edit('改改.md', [{ old: '乙說了一句。', new: '乙沉默了。' }]);
    assert.equal(r.skipped, undefined, JSON.stringify(r));
    assert.ok(t.read('改改.md').includes('乙沉默了。'), t.read('改改.md'));
  });

  test('old 不唯一且沒給 all 就拋', async () => {
    assert.equal(await codeOf(() => ws.edit('改改.md', [{ old: '甲', new: '丙' }])), 'notUnique');
  });

  test('拋了之後一個字都沒改', () => {
    assert.ok(t.read('改改.md').includes('甲說了一句。'), t.read('改改.md'));
  });

  test('all: true 時全替換', async () => {
    const r = await ws.edit('改改.md', [{ old: '甲', new: '丙', all: true }]);
    assert.ok(!t.read('改改.md').includes('甲'), t.read('改改.md'));
    assert.ok(r.message.includes('2'), r.message);
  });

  test('old 找不到就拋，不靜默什麼都不做', async () => {
    assert.equal(
      await codeOf(() => ws.edit('改改.md', [{ old: '壓根沒有這段', new: 'x' }])),
      'notFound'
    );
  });

  // 一次多條編輯要麼全成要麼全不成——半截狀態比報錯難收拾得多。
  test('多條編輯裡有一條失敗，整批都不落盤', async () => {
    const before = t.read('改改.md');
    await codeOf(() =>
      ws.edit('改改.md', [
        { old: '丙說了一句。', new: '丙笑了。' },
        { old: '壓根沒有這段', new: 'x' },
      ])
    );
    assert.equal(t.read('改改.md'), before);
  });
});

describe('remove · 搬進 .trash/ 並保留原相對路徑', () => {
  before(async () => {
    t.write('待刪/甲.md', '甲');
    await ws.remove('待刪/甲.md');
  });

  test('原位置沒了', () => {
    assert.ok(!t.has('待刪/甲.md'));
  });

  test('回收站裡保留原相對路徑', () => {
    assert.ok(t.has('.novelwarden/.trash/待刪/甲.md'));
  });

  test('內容原樣', () => {
    assert.equal(t.read('.novelwarden/.trash/待刪/甲.md'), '甲');
  });

  test('刪受保護的固定目錄拋 protected', async () => {
    assert.equal(await codeOf(() => ws.remove('chapters')), 'protected');
  });

  test('刪不存在的拋 notFound', async () => {
    assert.equal(await codeOf(() => ws.remove('查無此文.md')), 'notFound');
  });

  test('刪回收站裡的東西拋 inTrash', async () => {
    assert.equal(await codeOf(() => ws.remove('.novelwarden/.trash/待刪/甲.md')), 'inTrash');
  });

  // 同名衝突時加序號，不覆蓋之前刪掉的東西。
  test('第二次刪同名不覆蓋回收站裡那份', async () => {
    t.write('待刪/甲.md', '第二個甲');
    await ws.remove('待刪/甲.md');
    assert.equal(t.read('.novelwarden/.trash/待刪/甲.md'), '甲');
    assert.equal(t.read('.novelwarden/.trash/待刪/甲-2.md'), '第二個甲');
  });
});

describe('move', () => {
  before(() => {
    t.write('搬家/原件.md', '原件內容');
  });

  test('搬到新位置', async () => {
    const r = await ws.move('搬家/原件.md', '搬家/新名.md');
    assert.equal(r.rel, '搬家/新名.md');
    assert.ok(t.has('搬家/新名.md'));
    assert.ok(!t.has('搬家/原件.md'));
  });

  test('目標已存在時不覆蓋', async () => {
    t.write('搬家/佔位.md', '佔位');
    assert.equal(await codeOf(() => ws.move('搬家/新名.md', '搬家/佔位.md')), 'exists');
  });

  test('不覆蓋之後兩份都還在', () => {
    assert.equal(t.read('搬家/佔位.md'), '佔位');
    assert.equal(t.read('搬家/新名.md'), '原件內容');
  });

  test('搬固定目錄拋 protected', async () => {
    assert.equal(await codeOf(() => ws.move('chapters', '正文')), 'protected');
  });

  test('搬到工程外拋 outOfRoot', async () => {
    assert.equal(await codeOf(() => ws.move('搬家/新名.md', '../外面.md')), 'outOfRoot');
  });
});

describe('list', () => {
  let entries;

  before(async () => {
    t.write('chapters/001-楔子.md', '# 楔子\n\n雨下了三天。\n');
    t.write('chapters/cover.png', 'PNG');
    project.invalidate();
    entries = await ws.list('chapters');
  });

  test('列得出條目', () => {
    assert.ok(entries.length >= 2, JSON.stringify(entries.map((e) => e.name)));
  });

  test('條目帶 kind', () => {
    assert.equal(entries.find((e) => e.name === '001-楔子.md').kind, 'chapter');
  });

  test('二進位制的那份是 other', () => {
    assert.equal(entries.find((e) => e.name === 'cover.png').kind, 'other');
  });

  test('文字檔案給字數', () => {
    assert.ok(entries.find((e) => e.name === '001-楔子.md').words > 0);
  });

  test('條目帶相對路徑', () => {
    assert.equal(entries.find((e) => e.name === '001-楔子.md').rel, 'chapters/001-楔子.md');
  });

  test('目錄也列出來，type 是 dir', async () => {
    const root = await ws.list();
    assert.equal(root.find((e) => e.name === 'chapters').type, 'dir');
  });

  test('列不存在的目錄不拋，給空陣列', async () => {
    assert.deepEqual(await ws.list('查無此目錄'), []);
  });

  test('列越界目錄不拋，給空陣列', async () => {
    assert.deepEqual(await ws.list('../外面'), []);
  });
});

// 工程庫與會話記錄是 Novelwarden 自己的東西：經 MCP 讀出來是二進位制亂碼，改壞了整頁起不來。
describe('內部檔案 · 看不見、讀不到、改不了', () => {
  before(async () => {
    t.write('.novelwarden/novelwarden.db', 'SQLite format 3\0北境');
    t.write('.novelwarden/novelwarden.db-wal', '北境\0');
    t.write('.novelwarden/novelwarden.db-shm', '\0');
    t.write('.novelwarden/sessions/s1.json', '{"title":"北境"}');
    t.write('.novelwarden/premise.md', '# 故事前提\n\n北境的雪。\n');
    project.invalidate();
  });

  test('判定只認這幾個', () => {
    for (const rel of [
      '.novelwarden/novelwarden.db',
      '.novelwarden/novelwarden.db-wal',
      '.novelwarden/novelwarden.db-shm',
      '.novelwarden/sessions',
      '.novelwarden/sessions/s1.json',
    ]) {
      assert.equal(bundle.guard.isInternalPath(project, rel), true, rel);
    }
    for (const rel of ['.novelwarden/premise.md', 'novelwarden.db', 'chapters/novelwarden.db', '.novelwarden/sessions.md']) {
      assert.equal(bundle.guard.isInternalPath(project, rel), false, rel);
    }
  });

  test('list 不列出來', async () => {
    const names = (await ws.list('.novelwarden')).map((e) => e.name);
    assert.ok(names.includes('premise.md'), names.join());
    for (const hidden of ['novelwarden.db', 'novelwarden.db-wal', 'novelwarden.db-shm', 'sessions']) {
      assert.ok(!names.includes(hidden), names.join());
    }
  });

  test('read 當不存在', async () => {
    assert.equal(await codeOf(() => ws.read('.novelwarden/novelwarden.db')), 'notFound');
    assert.equal(await codeOf(() => ws.read('.novelwarden/sessions/s1.json')), 'notFound');
  });

  test('search 搜不到', async () => {
    const r = await ws.search('北境');
    assert.deepEqual(r.hits.map((x) => x.rel), ['.novelwarden/premise.md']);
  });

  test('寫、改、刪一律拒絕', async () => {
    assert.equal(await codeOf(() => ws.write('.novelwarden/novelwarden.db', { text: 'x' }, { mode: 'overwrite' })), 'protected');
    assert.equal(await codeOf(() => ws.write('.novelwarden/sessions/新.json', { text: '{}' }, { mode: 'create' })), 'protected');
    assert.equal(await codeOf(() => ws.remove('.novelwarden/novelwarden.db-wal')), 'protected');
    assert.equal(t.read('.novelwarden/sessions/s1.json'), '{"title":"北境"}');
  });
});

describe('doc handler · 固定單檔案與角色/設定', () => {
  // 情節大綱沒有檔案：各章細綱梗概的彙總，寫進去就是按章號拆回各章細綱（docs/design/plans/2026-10-22-outline-from-plots.md）。
  test('寫大綱：拆成那一章的細綱（只有梗概），讀回來是彙總', async () => {
    const r = await ws.write('.novelwarden/outline.md', { text: '# 大綱\n\n## 第1章：入局\n第一幕。' }, { mode: 'overwrite' });
    assert.equal(r.skipped, undefined);
    assert.ok(!t.has('.novelwarden/outline.md'));
    // 第 1 章已經有正文（上面那組寫的 001-楔子.md）：細綱落在正文的映象上，標題只記在細綱裡。
    assert.match(t.read('.novelwarden/summaries/001-楔子.md'), /## 梗概\n\n第一幕。/);
    assert.match(t.read('.novelwarden/summaries/001-楔子.md'), /^title: 入局$/m);
    assert.match((await ws.read('.novelwarden/outline.md')).text, /## 第1章：入局\n第一幕。/);
  });

  test('寫角色卡', async () => {
    const r = await ws.write('.novelwarden/characters/林昭.md', { text: '# 林昭\n\n少年劍客。' });
    assert.equal(r.rel, '.novelwarden/characters/林昭.md');
    assert.ok(t.read('.novelwarden/characters/林昭.md').includes('少年劍客'));
  });

  test('寫設定條目', async () => {
    await ws.write('.novelwarden/lore/青雲宗.md', { text: '# 青雲宗\n\n山門。' });
    assert.ok(t.has('.novelwarden/lore/青雲宗.md'));
  });

  // 草稿走 plain：純文字進出，無記賬，也永不自動進上下文（第 10 條）。
  test('寫草稿', async () => {
    await ws.write('drafts/001-楔子.md', { text: '草稿內容' });
    assert.equal((await ws.read('drafts/001-楔子.md')).kind, 'draft');
  });
});
