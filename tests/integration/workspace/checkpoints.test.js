/**
 * 存檔點的落盤一半（`src/core/workspace/checkpoints.ts`）與退回的編排（`src/core/features/checkpoint.ts` 的
 * `restoreCheckpoint`、閘道器的 `restoreBytes`）：真臨時工程。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 存哪些：創作產物（含草稿、細綱、角色卡、設定），不存會話、歷史版本、回收站、manifest、工程根的隨手記 | 與歷史版本同一個口徑；會話與內部檔案不是書 |
 * | 同樣的內容只存一份；第二個存檔點只多存改過的那幾份 | 存檔點要存得起，自動存幾十個也不翻倍 |
 * | 自動存檔點與最近一個一模一樣不另存；手動的照存 | 自動的不刷屏；作者要一個帶名字的點 |
 * | 超過 2 MB 的不存、記下來，跟現在比時不算「之後新建」 | 第 2 條：不靜默丟 |
 * | `.gitignore` 只在建目錄那一次放 | 同歷史版本：作者刪掉就是想讓 git 收 |
 * | 整個目錄是內部檔案：讀不到、寫不進、列不出、搜不到、監聽擋掉 | 一堆按 hash 命名的物件，只經面板看 |
 * | 跟現在比：改過的 / 之後刪掉的 / 之後新建的，`hashNow` 與閘道器樂觀鎖同一個口徑 | 退回時原樣帶回來當樂觀鎖 |
 * | 退回位元組原樣（GBK 章節不轉碼）、細綱的指紋一起回到當時（不重記 upstreamHash） | 第 18 條：整本退回之後就是當時那條鏈 |
 * | 退回之前先存「退回之前」；編輯器未儲存的跳過；樂觀鎖對不上的跳過；勾了才搬進回收站；被蓋掉的存一版歷史 | 第 3、6 條 |
 * | 有任務在跑就不退 | 一邊寫一邊退，誰也說不清 |
 * | 自動的留最近 30 個，手動的不裁；寫備註即留住；清理只刪沒人引用、寫下超過一小時的物件；有清單讀不懂就不清 | 存檔點不能無限長，也不能清錯 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject, makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let cp;
const dirs = [];

/** 「雨夜」兩個字的 GBK 位元組，外加一個換行：退回之後必須一個位元組不差。 */
const GBK = Buffer.from([0xd3, 0xea, 0xd2, 0xb9, 0x0a]);

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    fsx: './src/core/model/fs.ts',
    guard: './src/core/workspace/guard.ts',
    checkpoints: './src/core/workspace/checkpoints.ts',
    ws: './src/core/workspace/index.ts',
    feature: './src/core/features/checkpoint.ts',
    watch: './src/core/watchPolicy.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}), overrides: { reviewReplace: undefined } }).host);
  cp = bundle.checkpoints;
});

after(() => {
  for (const d of dirs) cleanup(d);
});

async function fresh(prefix) {
  const t = await makeTempProject(bundle.project, { prefix });
  dirs.push(t.dir);
  t.write('chapters/001-雨夜.md', '# 雨夜\n\n他推開門。\n');
  t.write('chapters/第一卷/002-深處.md', '# 深處\n\n山很深。\n');
  t.write('.novelwarden/summaries/001-雨夜.md', '---\nno: 1\nupstreamHash: aaaa\n---\n\n## 梗概\n\n雨夜。\n');
  t.write('.novelwarden/characters/林昭.md', '---\nname: 林昭\n---\n\n## 一句話\n\n劍客。\n');
  t.write('drafts/001-雨夜.md', '草稿：先寫門。\n');
  return { t, ws: new bundle.ws.Workspace(t.project) };
}

const objectCount = (t) => {
  const root = t.rel('.novelwarden/checkpoints/objects');
  if (!fs.existsSync(root)) return 0;
  return fs.readdirSync(root).reduce((n, d) => n + fs.readdirSync(path.join(root, d)).filter((f) => !f.endsWith('.tmp')).length, 0);
};

const hashOf = (t, rel) => bundle.fsx.hash(fs.readFileSync(t.rel(rel), 'utf8'));

/** 面板上點「整本退回」會發的那一份請求。 */
async function wholeRequest(t, id, { trashAdded = false, dirty = [] } = {}) {
  const d = await cp.diffCheckpoint(t.project, id);
  const paths = d.entries.filter((e) => e.status !== 'added').map((e) => e.path);
  const trash = trashAdded ? d.entries.filter((e) => e.status === 'added').map((e) => e.path) : [];
  const expect = {};
  for (const e of d.entries) expect[e.path] = e.hashNow ?? null;
  return { id, paths, trash, expect, dirty };
}

describe('存哪些', () => {
  let t;
  let files;

  before(async () => {
    ({ t } = await fresh('cp-tracked'));
    t.write('README.md', '工程根的隨手記\n');
    t.write('.novelwarden/sessions/s1.json', '{}');
    t.write('.novelwarden/history/chapters/001-雨夜.md/2026-10-01_10-00-00+0800.txt', '舊稿');
    t.write('.novelwarden/.trash/chapters/009-刪掉的.md', '刪掉的');
    files = await cp.trackedFiles(t.project);
  });

  test('章節（含卷目錄裡的）、細綱、角色卡、草稿、架構模板都在', () => {
    for (const rel of ['chapters/001-雨夜.md', 'chapters/第一卷/002-深處.md', '.novelwarden/summaries/001-雨夜.md', '.novelwarden/characters/林昭.md', 'drafts/001-雨夜.md']) {
      assert.ok(files.includes(rel), `${rel} 不在：${files.join('、')}`);
    }
    assert.ok(files.some((f) => f.startsWith('.novelwarden/') && /config|premise|world|outline/.test(f)), files.join('、'));
  });

  test('會話、歷史版本、回收站、manifest、工程根的隨手記都不在', () => {
    for (const bad of ['README.md', '.novelwarden/sessions/s1.json', '.novelwarden/project.json']) {
      assert.ok(!files.includes(bad), bad);
    }
    assert.ok(!files.some((f) => f.includes('/history/') || f.includes('.trash')), files.join('、'));
  });
});

describe('存：去重、自動不刷屏、.gitignore、太大的不存', () => {
  let t;
  let first;

  before(async () => {
    ({ t } = await fresh('cp-create'));
    first = await cp.createCheckpoint(t.project, { note: '開頭', auto: false });
  });

  test('第一個：每份內容一個物件，清單記下備註與手動', async () => {
    assert.equal(first.created, true);
    assert.equal(first.newObjects, objectCount(t));
    const info = await cp.readCheckpoint(t.project, first.id);
    assert.equal(info.note, '開頭');
    assert.equal(info.auto, false);
    assert.ok(info.files['chapters/001-雨夜.md'].words > 0);
  });

  test('.gitignore 只在建目錄那一次放；刪掉之後不再補', async () => {
    assert.equal(t.read('.novelwarden/checkpoints/.gitignore'), '*\n');
    t.remove('.novelwarden/checkpoints/.gitignore');
    await cp.createCheckpoint(t.project, { note: '', auto: false });
    assert.equal(t.has('.novelwarden/checkpoints/.gitignore'), false);
  });

  test('第二個：只多存改過的那一份', async () => {
    const before = objectCount(t);
    t.write('chapters/001-雨夜.md', '# 雨夜\n\n他慢慢推開門。\n');
    const r = await cp.createCheckpoint(t.project, { note: '改了一章', auto: false });
    assert.equal(r.newObjects, 1);
    assert.equal(objectCount(t), before + 1);
  });

  test('自動的與最近一個一模一樣就不另存，沿用最近那一個', async () => {
    const latest = (await cp.listCheckpoints(t.project))[0];
    const r = await cp.createCheckpoint(t.project, { note: '批次寫章之前', auto: true });
    assert.equal(r.created, false);
    assert.equal(r.id, latest.id);
  });

  test('手動的一模一樣也照樣存（只多一份清單）', async () => {
    const n = (await cp.listCheckpoints(t.project)).length;
    const r = await cp.createCheckpoint(t.project, { note: '再存一個', auto: false });
    assert.equal(r.created, true);
    assert.equal(r.newObjects, 0);
    assert.equal((await cp.listCheckpoints(t.project)).length, n + 1);
  });

  test('列表新的在前；同一秒的第二個帶序號', async () => {
    const now = new Date(2025, 0, 2, 3, 4, 5).getTime(); // 別的用例都在此刻，撞不上
    const a = await cp.createCheckpoint(t.project, { note: 'a', auto: false, now });
    const b = await cp.createCheckpoint(t.project, { note: 'b', auto: false, now });
    assert.equal(a.id, cp.checkpointIdOf(new Date(now)));
    assert.equal(b.id, `${a.id}-2`);
    const list = await cp.listCheckpoints(t.project);
    assert.ok(list.every((c, i) => i === 0 || list[i - 1].time >= c.time));
    assert.equal(list.at(-1).id, a.id);
  });

  test('超過 2 MB 的不存、記下來；跟現在比時不算之後新建', async () => {
    t.write('chapters/003-大.md', '字'.repeat(800_000)); // 2.4 MB
    const r = await cp.createCheckpoint(t.project, { note: '大', auto: false });
    assert.deepEqual(r.skipped, ['chapters/003-大.md']);
    const info = await cp.readCheckpoint(t.project, r.id);
    assert.equal(info.files['chapters/003-大.md'], undefined);
    const d = await cp.diffCheckpoint(t.project, r.id);
    assert.equal(d.entries.length, 0);
    t.remove('chapters/003-大.md');
  });

  test('還不是小說工程：存不了，說為什麼', async () => {
    const dir = makeTempDir('cp-not-project');
    dirs.push(dir.dir);
    const p = bundle.project.NovelProject.open(dir.dir);
    assert.match(await cp.checkpointUnavailable(p), /還不是小說工程/);
    await assert.rejects(cp.createCheckpoint(p, { note: '', auto: false }), /還不是小說工程/);
    assert.equal(fs.existsSync(path.join(dir.dir, '.novelwarden')), false);
  });
});

describe('內部檔案：讀不到、寫不進、列不出、搜不到、監聽擋掉', () => {
  let t;
  let ws;
  let id;

  before(async () => {
    ({ t, ws } = await fresh('cp-internal'));
    id = (await cp.createCheckpoint(t.project, { note: '', auto: false })).id;
  });

  test('讀清單當不存在；往裡寫、建目錄都拒', async () => {
    await assert.rejects(ws.read(`.novelwarden/checkpoints/points/${id}.json`), (e) => e.code === 'notFound');
    await assert.rejects(ws.write('.novelwarden/checkpoints/x.md', { text: 'x' }), (e) => e.code === 'protected');
    await assert.rejects(ws.mkdir('.novelwarden/checkpoints/new'), (e) => e.code === 'protected');
    await assert.rejects(ws.remove('.novelwarden/checkpoints'), (e) => ['protected', 'notFound'].includes(e.code));
  });

  test('列 .novelwarden 看不見它；全文檢索搜不到物件裡的字', async () => {
    assert.ok(!(await ws.list('.novelwarden')).some((e) => e.name === 'checkpoints'));
    t.remove('chapters/001-雨夜.md'); // 現在只有存檔點裡還有「推開門」
    const r = await ws.search('推開門');
    assert.equal(r.hits.length, 0, JSON.stringify(r.hits));
  });

  test('監聽擋掉它的變動（相對、絕對、Windows 分隔符都認）', () => {
    assert.equal(bundle.watch.shouldIgnoreChange('.novelwarden/checkpoints/objects/3f/abc'), true);
    assert.equal(bundle.watch.shouldIgnoreChange(t.rel('.novelwarden/checkpoints/points/x.json')), true);
    assert.equal(bundle.watch.shouldIgnoreChange('.novelwarden\\checkpoints\\points\\x.json'), true);
    assert.equal(bundle.watch.shouldIgnoreChange('.novelwarden/checkpointsx.md'), false);
  });
});

describe('跟現在比', () => {
  test('改過的 / 之後刪掉的 / 之後新建的；hashNow 與閘道器樂觀鎖同一個口徑', async () => {
    const { t } = await fresh('cp-diff');
    const { id } = await cp.createCheckpoint(t.project, { note: '', auto: false });
    t.write('chapters/001-雨夜.md', '# 雨夜\n\n他慢慢推開門，雨很大。\n');
    t.remove('chapters/第一卷/002-深處.md');
    t.write('chapters/004-新.md', '# 新\n\n新的一章。\n');
    const d = await cp.diffCheckpoint(t.project, id);
    const by = Object.fromEntries(d.entries.map((e) => [e.path, e]));
    assert.equal(by['chapters/001-雨夜.md'].status, 'changed');
    assert.equal(by['chapters/001-雨夜.md'].kind, 'chapter');
    assert.equal(by['chapters/001-雨夜.md'].hashNow, hashOf(t, 'chapters/001-雨夜.md'));
    assert.equal(by['chapters/第一卷/002-深處.md'].status, 'deleted');
    assert.equal(by['chapters/第一卷/002-深處.md'].hashNow, undefined);
    assert.equal(by['chapters/004-新.md'].status, 'added');
    assert.equal(d.entries.length, 3);
    assert.ok(d.unchanged > 0);
  });

  test('存檔點不在了：notFound；名字帶斜槓的不認', async () => {
    const { t } = await fresh('cp-diff-missing');
    await assert.rejects(cp.diffCheckpoint(t.project, '2026-01-01_00-00-00+0800'), (e) => e.code === 'notFound');
    await assert.rejects(cp.diffCheckpoint(t.project, '../../x'), (e) => e.code === 'notFound');
  });
});

describe('整本退回', () => {
  let t;
  let id;
  let outcome;
  let plotBefore;

  before(async () => {
    ({ t } = await fresh('cp-restore'));
    fs.writeFileSync(t.rel('chapters/005-舊碼.txt'), GBK);
    plotBefore = fs.readFileSync(t.rel('.novelwarden/summaries/001-雨夜.md'));
    id = (await cp.createCheckpoint(t.project, { note: '第一卷寫完', auto: false })).id;

    t.write('chapters/001-雨夜.md', '# 雨夜\n\n全改了。\n');
    fs.writeFileSync(t.rel('chapters/005-舊碼.txt'), '改成了 utf8\n');
    t.write('.novelwarden/summaries/001-雨夜.md', '---\nno: 1\nupstreamHash: bbbb\nsourceHash: cccc\n---\n\n## 梗概\n\n全變了。\n');
    t.remove('chapters/第一卷'); // 整個卷目錄刪掉
    t.write('chapters/006-之後新建.md', '# 之後新建\n\n後來寫的。\n');

    outcome = await bundle.feature.restoreCheckpoint(t.project, await wholeRequest(t, id), { busy: false });
  });

  test('改過的、刪掉的都回來了；位元組原樣（GBK 不轉碼）', () => {
    assert.equal(t.read('chapters/001-雨夜.md'), '# 雨夜\n\n他推開門。\n');
    assert.deepEqual(fs.readFileSync(t.rel('chapters/005-舊碼.txt')), GBK);
    assert.equal(t.read('chapters/第一卷/002-深處.md'), '# 深處\n\n山很深。\n');
    assert.equal(outcome.refused, undefined);
    assert.deepEqual(outcome.skipped, []);
  });

  test('細綱連同 frontmatter 的指紋回到當時，一個位元組不差（不按大綱此刻重記）', () => {
    assert.deepEqual(fs.readFileSync(t.rel('.novelwarden/summaries/001-雨夜.md')), plotBefore);
  });

  test('之後新建的預設不動', () => {
    assert.equal(t.has('chapters/006-之後新建.md'), true);
    assert.deepEqual(outcome.trashed, []);
  });

  test('先存了一個「退回到 … 之前」的自動存檔點，裡面是退回之前的樣子', async () => {
    const before = await cp.readCheckpoint(t.project, outcome.before);
    assert.equal(before.auto, true);
    assert.match(before.note, /^退回到.*「第一卷寫完」之前$/);
    assert.ok(before.files['chapters/006-之後新建.md']);
    const restored = await bundle.feature.restoreCheckpoint(t.project, await wholeRequest(t, outcome.before), { busy: false });
    assert.equal(t.read('chapters/001-雨夜.md'), '# 雨夜\n\n全改了。\n', '退回本身也能撤回');
    assert.equal(restored.refused, undefined);
  });

  test('被蓋掉的那一份存了一版歷史', () => {
    const dir = t.rel('.novelwarden/history/chapters/001-雨夜.md');
    assert.ok(fs.existsSync(dir) && fs.readdirSync(dir).length > 0);
  });

  test('章節清單跟著同步（卷目錄裡那一章回來了）', async () => {
    t.project.invalidate();
    const chapters = await t.project.listChapters();
    assert.ok(chapters.some((c) => c.relPath === 'chapters/第一卷/002-深處.md'));
  });
});

describe('退回的閘門', () => {
  test('勾了才把之後新建的搬進回收站（第 6 條，不真刪）', async () => {
    const { t } = await fresh('cp-trash');
    const { id } = await cp.createCheckpoint(t.project, { note: '', auto: false });
    t.write('chapters/007-後來.md', '# 後來\n');
    const o = await bundle.feature.restoreCheckpoint(t.project, await wholeRequest(t, id, { trashAdded: true }), { busy: false });
    assert.deepEqual(o.trashed, ['chapters/007-後來.md']);
    assert.equal(t.has('chapters/007-後來.md'), false);
    assert.equal(t.has('.novelwarden/.trash/chapters/007-後來.md'), true);
  });

  test('編輯器裡有未儲存修改的跳過；面板開啟之後又改過的跳過；又建出來的跳過', async () => {
    const { t } = await fresh('cp-locks');
    const { id } = await cp.createCheckpoint(t.project, { note: '', auto: false });
    t.write('chapters/001-雨夜.md', '# 雨夜\n\n改一。\n');
    t.write('.novelwarden/characters/林昭.md', '---\nname: 林昭\n---\n\n## 一句話\n\n改過。\n');
    t.remove('chapters/第一卷/002-深處.md');
    const req = await wholeRequest(t, id, { dirty: ['chapters/001-雨夜.md'] });
    // 面板開啟之後：角色卡又被改了一次，刪掉的那一章又被建了出來。
    t.write('.novelwarden/characters/林昭.md', '---\nname: 林昭\n---\n\n## 一句話\n\n又改了。\n');
    t.write('chapters/第一卷/002-深處.md', '# 深處\n\n別處剛寫的。\n');
    const o = await bundle.feature.restoreCheckpoint(t.project, req, { busy: false });
    const reasons = Object.fromEntries(o.skipped.map((s) => [s.path, s.reason]));
    assert.equal(reasons['chapters/001-雨夜.md'], 'dirty');
    assert.equal(reasons['.novelwarden/characters/林昭.md'], 'changed');
    assert.equal(reasons['chapters/第一卷/002-深處.md'], 'appeared');
    assert.equal(t.read('chapters/001-雨夜.md'), '# 雨夜\n\n改一。\n');
    assert.match(t.read('.novelwarden/characters/林昭.md'), /又改了/);
    assert.match(t.read('chapters/第一卷/002-深處.md'), /別處剛寫的/);
  });

  test('有任務在跑：不退，什麼都不動，也不存「退回之前」', async () => {
    const { t } = await fresh('cp-busy');
    const { id } = await cp.createCheckpoint(t.project, { note: '', auto: false });
    t.write('chapters/001-雨夜.md', '# 雨夜\n\n改了。\n');
    const n = (await cp.listCheckpoints(t.project)).length;
    const o = await bundle.feature.restoreCheckpoint(t.project, await wholeRequest(t, id), { busy: true });
    assert.match(o.refused, /有任務在跑/);
    assert.equal(t.read('chapters/001-雨夜.md'), '# 雨夜\n\n改了。\n');
    assert.equal((await cp.listCheckpoints(t.project)).length, n);
  });

  test('單份：只退回那一份；存檔點裡沒有的路徑、越界的路徑都不碰', async () => {
    const { t } = await fresh('cp-single');
    const { id } = await cp.createCheckpoint(t.project, { note: '', auto: false });
    t.write('chapters/001-雨夜.md', '# 雨夜\n\n改了。\n');
    t.write('drafts/001-雨夜.md', '草稿也改了。\n');
    const o = await bundle.feature.restoreCheckpoint(
      t.project,
      {
        id,
        paths: ['chapters/001-雨夜.md', 'chapters/999-沒有.md', '../外面.md'],
        trash: [],
        expect: { 'chapters/001-雨夜.md': hashOf(t, 'chapters/001-雨夜.md') },
        dirty: [],
      },
      { busy: false }
    );
    assert.deepEqual(o.restored, ['chapters/001-雨夜.md']);
    assert.equal(t.read('drafts/001-雨夜.md'), '草稿也改了。\n');
    assert.deepEqual(o.skipped.map((s) => [s.path, s.reason]), [['chapters/999-沒有.md', 'notInCheckpoint']]);
  });

  test('閘道器的 restoreBytes：absent 時目標已在報 exists；基線對不上報衝突；不能寫進內部目錄', async () => {
    const { t, ws } = await fresh('cp-bytes');
    await assert.rejects(ws.restoreBytes('chapters/001-雨夜.md', Buffer.from('x'), { absent: true }), (e) => e.code === 'exists');
    await assert.rejects(ws.restoreBytes('chapters/001-雨夜.md', Buffer.from('x'), { baseHash: 'nope' }), (e) => e instanceof bundle.ws.WsConflictError);
    await assert.rejects(ws.restoreBytes('.novelwarden/sessions/x.json', Buffer.from('x')), (e) => e.code === 'protected');
    await assert.rejects(ws.restoreBytes('../外面.md', Buffer.from('x')), (e) => e.code === 'outOfRoot');
    assert.equal(t.read('chapters/001-雨夜.md'), '# 雨夜\n\n他推開門。\n');
  });
});

describe('保留與清理', () => {
  test('自動的留最近 30 個，手動的不裁；裁掉之後沒人用的物件寫下一小時之後才清', async () => {
    const { t } = await fresh('cp-prune');
    const manual = await cp.createCheckpoint(t.project, { note: '手動', auto: false });
    const base = Date.now();
    for (let i = 0; i < 32; i++) {
      t.write('chapters/001-雨夜.md', `# 雨夜\n\n第 ${i} 版。\n`);
      await cp.createCheckpoint(t.project, { note: `自動 ${i}`, auto: true, now: base + i * 1000 });
    }
    const list = await cp.listCheckpoints(t.project);
    assert.equal(list.filter((c) => c.auto).length, 30);
    assert.ok(list.some((c) => c.id === manual.id));
    assert.ok(!list.some((c) => c.note === '自動 0' || c.note === '自動 1'));

    // 「第 0 版」「第 1 版」的物件沒人用了，但剛寫下：這次不清。一小時之後再清。
    const before = objectCount(t);
    assert.equal(await cp.collectGarbage(t.project), 0);
    assert.equal(await cp.collectGarbage(t.project, Date.now() + 2 * 3600_000), 2);
    assert.equal(objectCount(t), before - 2);
    // 還在的存檔點都讀得回來。
    for (const c of await cp.listCheckpoints(t.project)) {
      for (const rel of Object.keys(c.files)) {
        await cp.readCheckpointBytes(t.project, c, rel);
      }
    }
  });

  test('有一份清單讀不懂：整個不清（寧可多留）', async () => {
    const { t } = await fresh('cp-gc-unreadable');
    await cp.createCheckpoint(t.project, { note: '', auto: false });
    t.write('.novelwarden/checkpoints/objects/ff/' + 'f'.repeat(62), '沒人用的');
    t.write('.novelwarden/checkpoints/points/2026-01-01_00-00-00+0800.json', '{壞了');
    assert.equal(await cp.collectGarbage(t.project, Date.now() + 2 * 3600_000), 0);
    assert.equal((await cp.listCheckpoints(t.project)).length, 1, '讀不懂的那份不進列表');
  });

  test('寫備註：自動的就此留住（變成手動）', async () => {
    const { t } = await fresh('cp-note');
    const { id } = await cp.createCheckpoint(t.project, { note: '批次寫章之前', auto: true });
    const info = await cp.noteCheckpoint(t.project, id, '  寫完第三章  ');
    assert.equal(info.auto, false);
    assert.equal(info.note, '寫完第三章');
    assert.equal((await cp.readCheckpoint(t.project, id)).auto, false);
  });

  test('物件壞了：讀這一份報 notFound，退回時跳過它、說出來', async () => {
    const { t } = await fresh('cp-corrupt');
    const { id } = await cp.createCheckpoint(t.project, { note: '', auto: false });
    const info = await cp.readCheckpoint(t.project, id);
    const sha = info.files['chapters/001-雨夜.md'].sha;
    fs.writeFileSync(t.rel('.novelwarden/checkpoints/objects', sha.slice(0, 2), sha.slice(2)), '壞了');
    t.write('chapters/001-雨夜.md', '# 雨夜\n\n改了。\n');
    const o = await bundle.feature.restoreCheckpoint(t.project, await wholeRequest(t, id), { busy: false });
    assert.equal(o.skipped[0].reason, 'unreadable');
    assert.match(o.skipped[0].detail, /壞了/);
    assert.equal(t.read('chapters/001-雨夜.md'), '# 雨夜\n\n改了。\n');
  });
});
