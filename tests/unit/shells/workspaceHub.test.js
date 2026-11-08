/**
 * WorkspaceHub：一個程序同時開幾個工程，每個視窗（連線）各綁一個或者空著。
 * 測試寫進臨時目錄，設定存記憶體，不碰 ~/.novelwarden。
 *
 * FileHost / ChatController / initHost 共享模組級單例，必須 loadBundle。
 */
const { describe, test, before, beforeEach, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadBundle, loadModule } = require('../../helpers/load');

const bundle = loadBundle({
  workspaceHub: './src/shells/standalone/workspaceHub.ts',
  fileHost: './src/shells/standalone/fileHost.ts',
  scopedHost: './src/shells/standalone/scopedHost.ts',
  progress: './src/core/runtime/progress.ts',
  host: './src/core/host.ts',
  secrets: './src/core/llm/registry.ts',
  stores: './src/core/stores.ts',
});

const { readWindowState, writeWindowState, rememberOpen } = loadModule(
  'src/shells/standalone/windowState.ts'
);


const { WorkspaceHub } = bundle.workspaceHub;
const { FileHost } = bundle.fileHost;
const { ScopedHost, currentScope, runInScope } = bundle.scopedHost;

let windowDir;
let projA;
let projB;
/** 不在任何視窗上下文裡的廣播（啟動期的 getHost()）。 */
let stray;
/** 設定存記憶體，不碰 ~/.novelwarden/config.json。 */
let config;
/** @type {InstanceType<typeof WorkspaceHub>} */
let hub;
let windows;

// 必須與生產程式碼同源：workspaceHub.ts 用的是 **非同步** fsp.realpath，而
// Node 在 Windows 上兩者對 8.3 短名的處理相反——fs.realpathSync 原樣保留
// `RUNNER~1`，fsp.realpath 會展開成 `runneradmin`。CI 的 runner 使用者名稱超過
// 8 字元，os.tmpdir() 就返回短名，用 sync 版對期望值會與實現差一截路徑。
// 本機使用者名稱短，短名不出現，所以這個坑只在 CI 上炸。
function real(p) {
  return fs.realpathSync.native(p);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 開一個視窗。`project` 是它網址上的 `?project=`。 */
async function openWindow(project) {
  const messages = [];
  const conn = hub.connect((m) => messages.push(m), project);
  windows.push(conn);
  await conn.ready;
  return {
    conn,
    messages,
    ofType: (type) => messages.filter((m) => m.type === type),
    last: (type) => messages.filter((m) => m.type === type).pop(),
    send: (msg) => hub.receive(conn, msg),
    clear: () => {
      messages.length = 0;
    },
  };
}

before(() => {
  windowDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-hub-win-'));
  projA = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-hub-a-'));
  projB = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-hub-b-'));
  fs.writeFileSync(path.join(projA, 'note-a.txt'), 'a', 'utf8');
  fs.writeFileSync(path.join(projB, 'note-b.txt'), 'b', 'utf8');

  stray = [];
  config = {
    data: undefined,
    read() {
      return this.data;
    },
    async write(s) {
      this.data = s;
    },
  };
  bundle.host.initHost(new ScopedHost(new FileHost(config, (m) => stray.push(m))));
  bundle.progress.setTaskOwnerResolver(() => currentScope()?.owner);
  bundle.secrets.initSecrets({
    data: Object.create(null),
    async get(k) {
      return this.data[k];
    },
    async set(k, v) {
      this.data[k] = v;
    },
    async delete(k) {
      delete this.data[k];
    },
  });
});

beforeEach(() => {
  windows = [];
  stray.length = 0;
  hub = new WorkspaceHub({ config, windowDir, idleMs: 20 });
});

afterEach(async () => {
  for (const c of windows) {
    hub.disconnect(c);
  }
  await hub.closeAll();
});

after(() => {
  fs.rmSync(windowDir, { recursive: true, force: true });
  fs.rmSync(projA, { recursive: true, force: true });
  fs.rmSync(projB, { recursive: true, force: true });
});

describe('WorkspaceHub：一個視窗', () => {
  test('開啟目錄後這個視窗的 snapshot 只有一項，id 是 realpath', async () => {
    const w = await openWindow();
    await w.send({ type: 'openFolder', path: projA });
    const snap = hub.snapshot(w.conn);
    assert.equal(snap.currentId, real(projA));
    assert.equal(snap.items.length, 1);
    assert.equal(snap.items[0].root, real(projA));
    assert.equal(snap.items[0].name, path.basename(projA));
    assert.equal(snap.openInNewWindow, true);
    assert.ok(hub.controllerOf(projA));
    assert.ok(w.ofType('init').length > 0);
  });

  test('同一 realpath 再 open 不重建 controller、不重推 init', async () => {
    const w = await openWindow();
    await w.send({ type: 'openFolder', path: projA });
    const first = hub.controllerOf();
    const inits = w.ofType('init').length;
    await w.send({ type: 'openFolder', path: path.join(projA, '.') });
    assert.equal(hub.controllerOf(), first);
    assert.equal(w.ofType('init').length, inits);
  });

  test('replace 換成另一目錄：這個視窗只留新的，舊的沒有視窗了按空閒回收', async () => {
    const w = await openWindow();
    await w.send({ type: 'openFolder', path: projA });
    await w.send({ type: 'openFolder', path: projB });
    assert.equal(hub.snapshot(w.conn).currentId, real(projB));
    await sleep(80);
    assert.deepEqual(hub.openRoots(), [real(projB)]);
  });

  test('mode add 在已有工程時不改當前 id', async () => {
    const w = await openWindow();
    await w.send({ type: 'openFolder', path: projA });
    await w.send({ type: 'openFolder', path: projB, mode: 'add' });
    assert.equal(hub.snapshot(w.conn).currentId, real(projA));
    assert.ok(w.ofType('toast').some((m) => m.message.includes('一個工程')));
  });

  test('close 後視窗為空、工程當場關掉；lastOpen 清掉、recents 保留', async () => {
    const w = await openWindow();
    await w.send({ type: 'openFolder', path: projA });
    await w.send({ type: 'closeFolder' });
    assert.equal(hub.snapshot(w.conn).currentId, null);
    assert.equal(w.last('workspaces').currentId, null);
    assert.deepEqual(hub.openRoots(), []);
    assert.equal(hub.controllerOf(), undefined);
    const win = readWindowState(windowDir);
    assert.equal(win.lastOpen, null);
    assert.ok(win.recents.some((r) => r.root === real(projA)));
  });

  test('不是目錄則 toast，視窗不變', async () => {
    const w = await openWindow();
    const file = path.join(windowDir, 'not-a-dir.txt');
    fs.writeFileSync(file, 'x', 'utf8');
    await w.send({ type: 'openFolder', path: file });
    assert.equal(hub.snapshot(w.conn).currentId, null);
    assert.ok(w.ofType('toast').some((m) => m.message.includes('不是目錄')));
  });

  test('目錄不存在則 toast；已開著的工程不受影響', async () => {
    const w = await openWindow();
    await w.send({ type: 'openFolder', path: projA });
    await w.send({ type: 'openFolder', path: path.join(windowDir, 'no-such-book') });
    assert.equal(hub.snapshot(w.conn).currentId, real(projA));
    assert.ok(w.ofType('toast').some((m) => m.message.includes('不存在')));
  });

  test('listHostDir 只回發起的視窗，條目沒有正文', async () => {
    const w = await openWindow();
    const other = await openWindow();
    await w.send({ type: 'listHostDir', path: projA });
    const listing = w.ofType('hostDir')[0];
    assert.ok(listing);
    assert.ok(listing.entries.some((e) => e.name === 'note-a.txt'));
    assert.ok(listing.entries.every((e) => !('text' in e) && !('content' in e)));
    assert.equal(other.ofType('hostDir').length, 0);
  });

  test('空視窗裡「檔案」頁要根目錄、編輯器核對磁碟：靜靜吃掉，不彈「請先開啟資料夾」', async () => {
    const w = await openWindow();
    w.clear();
    await w.send({ type: 'listDir', dirs: [''] });
    await w.send({ type: 'checkEditorFiles', files: [] });
    assert.equal(w.ofType('toast').length, 0);
  });

  test('空視窗 ready 不發 init', async () => {
    const w = await openWindow();
    w.clear();
    await w.send({ type: 'ready' });
    assert.ok(w.ofType('workspaces').some((m) => m.currentId === null));
    assert.ok(w.ofType('settings').length > 0);
    assert.equal(w.ofType('init').length, 0);
  });

  test('空視窗發創作訊息：提示先開啟資料夾', async () => {
    const w = await openWindow();
    await w.send({ type: 'stop' });
    assert.ok(w.ofType('toast').some((m) => /開啟資料夾/.test(m.message)));
  });

  test('createFile 寫空檔案，已存在則拒絕', async () => {
    const w = await openWindow();
    await w.send({ type: 'openFolder', path: projA });
    w.clear();
    await w.send({ type: 'createFile', relPath: 'fresh.md' });
    assert.equal(fs.readFileSync(path.join(projA, 'fresh.md'), 'utf8'), '');
    assert.ok(w.ofType('editorOpen').some((m) => m.file.path === 'fresh.md'));
    w.clear();
    await w.send({ type: 'createFile', relPath: 'fresh.md' });
    assert.ok(w.ofType('toast').some((m) => /已存在/.test(m.message)));
  });

  test('createFile 無工程則 toast', async () => {
    const w = await openWindow();
    await w.send({ type: 'createFile', relPath: 'x.md' });
    assert.ok(w.ofType('toast').some((m) => /開啟資料夾/.test(m.message)));
  });

  test('openReadme 開啟工程根 README', async () => {
    fs.writeFileSync(path.join(projA, 'README.md'), '# hi', 'utf8');
    const w = await openWindow();
    await w.send({ type: 'openFolder', path: projA });
    w.clear();
    await w.send({ type: 'openReadme' });
    assert.ok(w.ofType('editorOpen').some((m) => m.file.path === 'README.md'));
  });
});

describe('WorkspaceHub：幾個視窗', () => {
  test('兩個視窗各開一個工程，互不幹擾', async () => {
    const a = await openWindow();
    const b = await openWindow();
    await a.send({ type: 'openFolder', path: projA });
    await b.send({ type: 'openFolder', path: projB });
    assert.equal(hub.snapshot(a.conn).currentId, real(projA));
    assert.equal(hub.snapshot(b.conn).currentId, real(projB));
    assert.deepEqual(hub.openRoots().sort(), [real(projA), real(projB)].sort());
    assert.notEqual(hub.controllerOf(projA), hub.controllerOf(projB));
  });

  test('工程的訊息只發給開著它的視窗', async () => {
    const a = await openWindow();
    const b = await openWindow();
    await a.send({ type: 'openFolder', path: projA });
    await b.send({ type: 'openFolder', path: projB });
    a.clear();
    b.clear();
    await a.send({ type: 'createFile', relPath: 'only-a.md' });
    assert.ok(a.ofType('editorOpen').some((m) => m.file.path === 'only-a.md'));
    assert.equal(b.ofType('editorOpen').length, 0);
    fs.rmSync(path.join(projA, 'only-a.md'));
  });

  test('getHost() 落到所在視窗的上下文，不廣播給別的視窗', async () => {
    const a = await openWindow(projA);
    const b = await openWindow(projB);
    a.clear();
    b.clear();
    await runInScope(a.conn.runtime.scope, async () => {
      await Promise.resolve();
      bundle.host.getHost().toast('只給 A');
    });
    assert.ok(a.ofType('toast').some((m) => m.message === '只給 A'));
    assert.equal(b.ofType('toast').length, 0);
    assert.equal(stray.length, 0);
  });

  test('長任務只出現在它那個工程的視窗裡', async () => {
    const a = await openWindow(projA);
    const b = await openWindow(projB);
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    a.clear();
    b.clear();
    const running = runInScope(a.conn.runtime.scope, () =>
      bundle.progress.runTask('測試任務', () => gate)
    );
    await sleep(10);
    assert.ok(a.last('tasks').tasks.some((t) => t.title === '測試任務'));
    assert.ok(b.ofType('tasks').every((m) => m.tasks.length === 0));
    release();
    await running;
  });

  test('兩個視窗開同一個工程共用一份 controller；一個視窗關掉不影響另一個', async () => {
    const a = await openWindow();
    const b = await openWindow();
    await a.send({ type: 'openFolder', path: projA });
    await b.send({ type: 'openFolder', path: projA });
    assert.equal(hub.openRoots().length, 1);
    await a.send({ type: 'closeFolder' });
    assert.equal(hub.snapshot(a.conn).currentId, null);
    assert.equal(hub.snapshot(b.conn).currentId, real(projA));
    assert.ok(hub.controllerOf(projA));
  });

  test('新視窗帶 ?project= 就開那個工程，不帶落到最近操作的那個', async () => {
    const a = await openWindow(projA);
    assert.equal(hub.snapshot(a.conn).currentId, real(projA));
    const b = await openWindow(projB);
    assert.equal(hub.snapshot(b.conn).currentId, real(projB));
    const c = await openWindow();
    assert.equal(hub.snapshot(c.conn).currentId, real(projB));
    await a.send({ type: 'windowFocus' });
    const d = await openWindow();
    assert.equal(hub.snapshot(d.conn).currentId, real(projA));
    assert.equal(readWindowState(windowDir).lastOpen, real(projA));
  });

  test('?project= 指向不存在的目錄：空視窗 + toast', async () => {
    const w = await openWindow(path.join(windowDir, 'gone-book'));
    assert.equal(hub.snapshot(w.conn).currentId, null);
    assert.ok(w.ofType('toast').some((m) => m.message.includes('不存在')));
  });

  test('MCP：帶 project 落到那個工程，不帶落到最近操作的；沒開著的回 undefined', async () => {
    const a = await openWindow(projA);
    await openWindow(projB);
    await a.send({ type: 'windowFocus' });
    assert.ok(hub.mcpBackend(projA));
    assert.ok(hub.mcpBackend(projB));
    assert.ok(hub.mcpBackend());
    assert.equal(hub.controllerOf(), hub.controllerOf(projA));
    assert.equal(hub.mcpBackend(path.join(windowDir, 'not-open')), undefined);
  });

  test('視窗全關了：最近操作的工程留著（MCP 還要用），別的空閒回收', async () => {
    const a = await openWindow(projA);
    const b = await openWindow(projB);
    hub.disconnect(a.conn);
    hub.disconnect(b.conn);
    await sleep(80);
    assert.deepEqual(hub.openRoots(), [real(projB)]);
  });

  test('視窗在空閒期內回來（重新整理）就接著用同一份', async () => {
    const a = await openWindow(projA);
    await openWindow(projB);
    const ctrl = hub.controllerOf(projA);
    hub.disconnect(a.conn);
    const again = await openWindow(projA);
    await sleep(80);
    assert.equal(hub.controllerOf(projA), ctrl);
    assert.equal(hub.snapshot(again.conn).currentId, real(projA));
  });

  test('改設定：所有視窗都收到新設定與新的 openInNewWindow；不帶這一項保持原值', async () => {
    const a = await openWindow(projA);
    const b = await openWindow();
    await a.send({ type: 'switchTab', tab: 'settings' });
    const current = a.last('settings').settings;
    await a.send({ type: 'saveSettings', settings: { ...current, openInNewWindow: false } });
    assert.equal(b.last('settings').settings.openInNewWindow, false);
    assert.equal(b.last('workspaces').openInNewWindow, false);
    await a.send({ type: 'saveSettings', settings: { ...current, openInNewWindow: undefined } });
    assert.equal(b.last('settings').settings.openInNewWindow, false);
    await a.send({ type: 'saveSettings', settings: { ...current, openInNewWindow: true } });
    assert.equal(b.last('workspaces').openInNewWindow, true);
  });
});

// 歡迎頁「新建一本書」「匯入寫好的書」（2026-10-24）。
describe('WorkspaceHub：歡迎頁新建一本書', () => {
  test('createProject：在「放在」下建好、初始化，只回 projectCreated（開啟由前端照常發 openFolder）', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-hub-new-'));
    try {
      const w = await openWindow();
      const other = await openWindow();
      await w.send({ type: 'createProject', parent, title: '雪夜', author: '某某', importFrom: '/tmp/原稿.txt' });
      const made = w.last('projectCreated');
      // 真實路徑：與開啟之後的 currentId 同一個口徑。
      assert.equal(made.root, real(path.join(parent, '雪夜')));
      assert.equal(made.importFrom, '/tmp/原稿.txt');
      const manifest = JSON.parse(fs.readFileSync(path.join(parent, '雪夜', '.novelwarden', 'project.json'), 'utf8'));
      assert.equal(manifest.title, '雪夜');
      assert.equal(manifest.author, '某某');
      // 還沒開啟：開在這個視窗還是新視窗是前端的事。
      assert.equal(hub.snapshot(w.conn).currentId, null);
      assert.equal(other.ofType('projectCreated').length, 0);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  test('createProject 沒建成：只回這個視窗一條 toast，不回 projectCreated', async () => {
    const w = await openWindow(projA);
    // projA 裡已經有 note-a.txt：拿它的上一層當「放在」、它的名字當書名，撞上一個有東西的同名資料夾。
    await w.send({ type: 'createProject', parent: path.dirname(projA), title: path.basename(projA), author: '' });
    assert.equal(w.ofType('projectCreated').length, 0);
    assert.ok(w.ofType('toast').some((m) => m.level === 'error' && m.message.includes('裡面還有別的東西')));
    assert.equal(hub.snapshot(w.conn).currentId, real(projA));
  });

  test('inspectBook：回切得出幾章，不寫任何檔案', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-hub-book-'));
    try {
      const book = path.join(dir, '青雲劍錄.txt');
      fs.writeFileSync(book, '第一章 入宗\n林昭站在山門前。\n第二章 雪夜\n雪下了一夜。', 'utf8');
      const w = await openWindow();
      await w.send({ type: 'inspectBook', path: book });
      const r = w.last('bookInspected');
      assert.equal(r.path, book);
      assert.equal(r.title, '青雲劍錄');
      assert.equal(r.chapters, 2);
      assert.match(r.headline, /認出 2 章/);
      assert.deepEqual(fs.readdirSync(dir), ['青雲劍錄.txt']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('workspaces 帶「放在」的預設值：最近開啟的那本書所在的目錄', async () => {
    const w = await openWindow(projA);
    assert.equal(w.last('workspaces').newProjectParent, path.dirname(real(projA)));
  });

  test('一本都沒開啟過：預設是家目錄', async () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-hub-win2-'));
    try {
      const other = new WorkspaceHub({ config, windowDir: fresh, idleMs: 20 });
      assert.equal(other.snapshot().newProjectParent, os.homedir());
      await other.closeAll();
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe('WorkspaceHub：啟動', () => {
  test('bootstrap 恢復 lastOpen，不帶 ?project= 的視窗落到它上面', async () => {
    rememberOpen(projA, windowDir);
    await hub.bootstrap();
    assert.equal(hub.defaultRoot(), real(projA));
    const w = await openWindow();
    assert.equal(hub.snapshot(w.conn).currentId, real(projA));
  });

  test('bootstrap 清掉已不存在的 lastOpen，保留 recents', async () => {
    const gone = path.join(windowDir, 'missing-book');
    writeWindowState(
      {
        lastOpen: gone,
        recents: [{ root: gone, name: 'missing-book', openedAt: 1 }],
      },
      windowDir
    );
    await hub.bootstrap();
    assert.equal(hub.defaultRoot(), undefined);
    const win = readWindowState(windowDir);
    assert.equal(win.lastOpen, null);
    assert.equal(win.recents[0].name, 'missing-book');
  });
});
