/**
 * 歡迎頁的新手上手（2026-10-24）：「新建一本書」「匯入寫好的書（txt）」各一張表單，建好就開啟、切到「工程 → 章節」。
 *
 * | 用例組 | 釘的是什麼 |
 * |---|---|
 * | 歡迎頁 | 開始三條路、最近、怎麼上手 |
 * | 新建一本書 | 一張表單：書名必填、作者可空、「放在」預設是後端給的目錄、「選…」開目錄選擇器填回來；說明寫出會建在哪；Enter 提交發 `createProject`；建好照常 `openFolder`，開啟之後切到「工程 → 章節」，不匯入任何東西 |
 * | 匯入寫好的書 | 先挑一本 txt（選擇器只列目錄與 .txt）→ `inspectBook`；別人的回答不認；認不出章只說為什麼、不開表單；認得出就開同一張表單，說明寫認出幾章、丟掉了什麼，書名預設取檔名；提交帶 `importFrom`，開啟之後帶著 `hostPath` 發 `importManuscript` |
 * | 新視窗中開啟專案 | 這個視窗開著別的書：建好的開在新視窗，網址帶 `book` / `import`；新視窗讀了就摘掉，開啟之後接著匯入 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP } = require('../../helpers/dom');

/** jsdom 那邊造的物件原型不同，比內容先轉成普通物件。 */
const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const formOpen = (ui) => !ui.doc.getElementById('providerModal').classList.contains('hidden');
const formTitle = (ui) => ui.doc.getElementById('providerModalTitle').textContent;
const field = (ui, key) => ui.doc.querySelector(`.nf-form [data-key="${key}"]`);
const note = (ui) => ui.doc.querySelector('.nf-form .form-note');
const submitBtn = (ui) => ui.doc.querySelector('.nf-form .modal-foot .primary');
const pickerOpen = (ui) => ui.doc.querySelector('.nf-picker').classList.contains('open');
const pickerTitle = (ui) => ui.doc.querySelector('.nf-picker h2').textContent;
const pickerBtn = (ui, label) => [...ui.doc.querySelectorAll('.nf-picker-actions button')].find((b) => b.textContent === label);
const pickerRow = (ui, name) => [...ui.doc.querySelectorAll('.nf-picker-row')].find((r) => r.textContent.includes(name));

function type(ui, key, value) {
  const input = field(ui, key);
  input.value = value;
  input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
}

function enter(ui, key) {
  field(ui, key).dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

function emptyWindow(extra = {}) {
  const ui = mount({ body: 'standalone', empty: true, scripts: ['view.js'], shims: ['clipboard', 'scrollIntoView'], ...extra });
  return ui;
}

describe('歡迎頁：開始 / 最近 / 怎麼上手', { skip: JSDOM_SKIP }, () => {
  test('開始三條路，「怎麼上手」寫著新書、寫好的書與整理', () => {
    const ui = emptyWindow();
    const welcome = ui.doc.getElementById('nfWelcome');
    assert.deepEqual([...welcome.querySelectorAll('h2')].map((h) => h.textContent), ['開始', '最近', '怎麼上手']);
    assert.deepEqual(
      [...welcome.querySelectorAll('[data-welcome]')].map((b) => b.textContent),
      ['新建一本書…', '匯入寫好的書（txt）…', '開啟資料夾…']
    );
    const steps = welcome.querySelector('.nf-welcome-steps').textContent;
    for (const word of ['新建一本書', '匯入寫好的書', '新建第 1 章', '從已寫正文補齊', '同步', '不需要模型']) {
      assert.ok(steps.includes(word), word);
    }
  });
});

describe('新建一本書', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = emptyWindow();
    ui.post({ type: 'workspaces', currentId: null, items: [], recents: [], newProjectParent: '/home/me/小說' });
  });

  test('一張表單：書名、作者、放在；「放在」預設是後端給的目錄，書名空著不能提交', () => {
    ui.clickEl(ui.doc.querySelector('[data-welcome="newProject"]'));
    assert.ok(formOpen(ui));
    assert.equal(formTitle(ui), '新建一本書');
    assert.equal(field(ui, 'title').value, '');
    assert.equal(field(ui, 'author').value, '');
    assert.equal(field(ui, 'parent').value, '/home/me/小說');
    assert.equal(submitBtn(ui).textContent, '新建');
    assert.equal(submitBtn(ui).disabled, true);
    assert.equal(note(ui).textContent, '「書名」還空著。');
  });

  test('說明寫出會建在哪；書名裡的字都不能當資料夾名時不讓提交', () => {
    type(ui, 'title', '???');
    assert.equal(submitBtn(ui).disabled, true);
    assert.match(note(ui).textContent, /都不能當資料夾名/);
    type(ui, 'title', '雪夜');
    assert.equal(submitBtn(ui).disabled, false);
    assert.equal(note(ui).textContent, '會新建資料夾 /home/me/小說/雪夜，書就放在裡面。');
  });

  test('「選…」開目錄選擇器，從框裡那個目錄起；確定之後填回來，表單還開著', () => {
    ui.sent.length = 0;
    const browse = [...ui.doc.querySelectorAll('.nf-form .field-row button')].find((b) => b.textContent === '選…');
    ui.clickEl(browse);
    assert.ok(pickerOpen(ui));
    assert.equal(pickerTitle(ui), '放在哪個資料夾裡');
    assert.equal(ui.last('listHostDir').path, '/home/me/小說');
    // 選目錄：「新建資料夾」在。
    assert.equal(pickerBtn(ui, '新建資料夾').hidden, false);
    ui.post({ type: 'hostDir', path: '/data/books', parent: '/data', entries: [], truncated: 0 });
    ui.clickEl(pickerBtn(ui, '確定'));
    assert.equal(pickerOpen(ui), false);
    assert.ok(formOpen(ui));
    assert.equal(field(ui, 'parent').value, '/data/books');
    assert.equal(note(ui).textContent, '會新建資料夾 /data/books/雪夜，書就放在裡面。');
    assert.equal(ui.last('openFolder'), undefined);
  });

  test('從「選…」開出來的選擇器上按 Esc：只關選擇器，表單與填好的字都在', () => {
    const browse = [...ui.doc.querySelectorAll('.nf-form .field-row button')].find((b) => b.textContent === '選…');
    ui.clickEl(browse);
    assert.ok(pickerOpen(ui));
    ui.doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(pickerOpen(ui), false);
    assert.ok(formOpen(ui));
    assert.equal(field(ui, 'title').value, '雪夜');
    assert.equal(field(ui, 'parent').value, '/data/books');
  });

  test('在書名框裡按 Enter 就提交：發 createProject，不帶 importFrom', () => {
    ui.sent.length = 0;
    type(ui, 'author', '某某');
    enter(ui, 'title');
    assert.equal(formOpen(ui), false);
    assert.deepEqual(plain(ui.last('createProject')), { type: 'createProject', parent: '/data/books', title: '雪夜', author: '某某' });
  });

  test('建好了：照常開啟；開啟之後切到「工程 → 章節」，不匯入任何東西', () => {
    ui.sent.length = 0;
    ui.post({ type: 'projectCreated', root: '/data/books/雪夜' });
    assert.deepEqual(plain(ui.last('openFolder')), { type: 'openFolder', path: '/data/books/雪夜', mode: 'replace' });
    ui.post({
      type: 'workspaces',
      currentId: '/data/books/雪夜',
      items: [{ id: '/data/books/雪夜', root: '/data/books/雪夜', name: '雪夜' }],
      recents: [],
    });
    assert.ok(ui.doc.getElementById('pane-project').classList.contains('active'));
    assert.equal(ui.last('switchTab')?.tab, 'project');
    assert.ok(ui.doc.querySelector('[data-project-tab="chapters"]').classList.contains('active'));
    assert.equal(ui.last('projectAction'), undefined);
  });
});

describe('匯入寫好的書', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = emptyWindow();
    ui.post({ type: 'workspaces', currentId: null, items: [], recents: [], newProjectParent: '/home/me' });
  });

  const pickBook = (name) => {
    ui.sent.length = 0;
    ui.clickEl(ui.doc.querySelector('[data-welcome="importBook"]'));
    ui.post({
      type: 'hostDir',
      path: '/home/me',
      parent: '/home',
      entries: [
        { name: 'books', kind: 'dir', absPath: '/home/me/books' },
        { name: '原稿.txt', kind: 'file', absPath: '/home/me/原稿.txt' },
        { name: '散文.txt', kind: 'file', absPath: '/home/me/散文.txt' },
        { name: '筆記.md', kind: 'file', absPath: '/home/me/筆記.md' },
      ],
      truncated: 0,
    });
    ui.clickEl(pickerRow(ui, name));
    ui.clickEl(pickerBtn(ui, '確定'));
  };

  test('先挑一本 txt：選擇器只列目錄與 .txt，沒點中一本不能確定，不給「新建資料夾」', () => {
    ui.clickEl(ui.doc.querySelector('[data-welcome="importBook"]'));
    assert.ok(pickerOpen(ui));
    assert.ok(pickerTitle(ui).startsWith('匯入寫好的書：選一本 txt'), pickerTitle(ui));
    assert.equal(ui.last('listHostDir').path, '~');
    assert.equal(pickerBtn(ui, '新建資料夾').hidden, true);
    ui.post({
      type: 'hostDir',
      path: '/home/me',
      parent: '/home',
      entries: [
        { name: 'books', kind: 'dir', absPath: '/home/me/books' },
        { name: '原稿.txt', kind: 'file', absPath: '/home/me/原稿.txt' },
        { name: '筆記.md', kind: 'file', absPath: '/home/me/筆記.md' },
      ],
      truncated: 0,
    });
    assert.ok(pickerRow(ui, 'books'));
    assert.ok(pickerRow(ui, '原稿.txt'));
    assert.equal(pickerRow(ui, '筆記.md'), undefined);
    assert.equal(pickerBtn(ui, '確定').disabled, true);
    ui.clickEl(pickerBtn(ui, '取消'));
  });

  test('挑好一本：發 inspectBook，等後端看切得出幾章', () => {
    pickBook('散文.txt');
    assert.equal(pickerOpen(ui), false);
    assert.deepEqual(plain(ui.last('inspectBook')), { type: 'inspectBook', path: '/home/me/散文.txt' });
    assert.equal(formOpen(ui), false);
  });

  test('認不出章：只說為什麼，不開表單', () => {
    ui.post({ type: 'bookInspected', path: '/home/me/散文.txt', title: '散文', chapters: 0, detail: [], error: '《散文》裡認不出章節標題。' });
    assert.equal(formOpen(ui), false);
    const toast = ui.doc.getElementById('toast');
    assert.ok(toast.classList.contains('error'));
    assert.equal(toast.textContent, '《散文》裡認不出章節標題。');
  });

  test('別的那一本的回答不認', () => {
    pickBook('原稿.txt');
    ui.post({ type: 'bookInspected', path: '/home/me/別的.txt', title: '別的', chapters: 3, headline: 'x', detail: [] });
    assert.equal(formOpen(ui), false);
  });

  test('認得出：同一張表單，說明寫認出幾章、丟掉了什麼，書名預設取檔名', () => {
    ui.post({
      type: 'bookInspected',
      path: '/home/me/原稿.txt',
      title: '原稿',
      chapters: 3,
      headline: '從《原稿》認出 3 章（120 字），匯入為第 1–3 章',
      detail: ['檔案：/home/me/原稿.txt（UTF-8）。', '2 行卷標題（第一卷 少年遊、第二卷 江湖遠）不算章，丟掉。'],
    });
    assert.ok(formOpen(ui));
    assert.equal(formTitle(ui), '匯入寫好的書');
    assert.equal(ui.doc.querySelector('.nf-form .form-lead').textContent, '從《原稿》認出 3 章（120 字），匯入為第 1–3 章。這一步不呼叫模型。');
    assert.equal(ui.doc.querySelectorAll('.nf-form .form-details li').length, 2);
    assert.equal(field(ui, 'title').value, '原稿');
    assert.equal(field(ui, 'parent').value, '/home/me');
    assert.equal(submitBtn(ui).textContent, '匯入');
    assert.equal(note(ui).textContent, '會新建資料夾 /home/me/原稿，書就放在裡面。');
  });

  test('點「匯入」：createProject 帶 importFrom；建好開啟之後帶著 hostPath 接著匯入', () => {
    type(ui, 'title', '青雲劍錄');
    ui.sent.length = 0;
    ui.clickEl(submitBtn(ui));
    assert.deepEqual(plain(ui.last('createProject')), {
      type: 'createProject',
      parent: '/home/me',
      title: '青雲劍錄',
      author: '',
      importFrom: '/home/me/原稿.txt',
    });
    ui.post({ type: 'projectCreated', root: '/home/me/青雲劍錄', importFrom: '/home/me/原稿.txt' });
    assert.equal(ui.last('openFolder')?.path, '/home/me/青雲劍錄');
    // 還沒開啟就不匯入。
    assert.equal(ui.last('projectAction'), undefined);
    ui.post({
      type: 'workspaces',
      currentId: '/home/me/青雲劍錄',
      items: [{ id: '/home/me/青雲劍錄', root: '/home/me/青雲劍錄', name: '青雲劍錄' }],
      recents: [],
    });
    assert.deepEqual(plain(ui.last('projectAction')), { type: 'projectAction', action: 'importManuscript', hostPath: '/home/me/原稿.txt' });
    assert.ok(ui.doc.querySelector('[data-project-tab="chapters"]').classList.contains('active'));
  });

  test('之後再推 workspaces 不再匯入一遍', () => {
    ui.sent.length = 0;
    ui.post({
      type: 'workspaces',
      currentId: '/home/me/青雲劍錄',
      items: [{ id: '/home/me/青雲劍錄', root: '/home/me/青雲劍錄', name: '青雲劍錄' }],
      recents: [],
    });
    assert.equal(ui.last('projectAction'), undefined);
  });
});

describe('新視窗中開啟專案', { skip: JSDOM_SKIP }, () => {
  test('這個視窗開著別的書：建好的開在新視窗，網址帶 book 與 import，這個視窗不動', () => {
    const ui = emptyWindow({ url: 'http://localhost/?project=%2Fbooks%2F旧书' });
    const opened = [];
    ui.window.open = (url) => {
      opened.push(url);
      return {};
    };
    ui.post({
      type: 'workspaces',
      currentId: '/books/舊書',
      items: [{ id: '/books/舊書', root: '/books/舊書', name: '舊書' }],
      recents: [],
      openInNewWindow: true,
    });
    ui.sent.length = 0;
    ui.post({ type: 'projectCreated', root: '/books/新書', importFrom: '/x/原稿.txt' });
    assert.equal(opened.length, 1);
    const url = new URL(opened[0]);
    assert.equal(url.searchParams.get('project'), '/books/新書');
    assert.equal(url.searchParams.get('book'), '1');
    assert.equal(url.searchParams.get('import'), '/x/原稿.txt');
    assert.equal(ui.last('openFolder'), undefined);
  });

  test('新視窗讀了網址上的 book / import 就摘掉，開啟之後接著匯入', () => {
    const ui = emptyWindow({ url: `http://localhost/?project=${encodeURIComponent('/books/新書')}&book=1&import=${encodeURIComponent('/x/原稿.txt')}` });
    const search = new URL(ui.window.location.href).searchParams;
    assert.equal(search.has('book'), false);
    assert.equal(search.has('import'), false);
    ui.post({
      type: 'workspaces',
      currentId: '/books/新書',
      items: [{ id: '/books/新書', root: '/books/新書', name: '新書' }],
      recents: [],
    });
    assert.deepEqual(plain(ui.last('projectAction')), { type: 'projectAction', action: 'importManuscript', hostPath: '/x/原稿.txt' });
    assert.equal(ui.last('switchTab')?.tab, 'project');
  });
});

describe('建好的書沒開啟成', { skip: JSDOM_SKIP }, () => {
  test('視窗換成了別的書：作廢，不把 txt 導進那一本，之後再換回來也不補', () => {
    const ui = emptyWindow();
    ui.post({ type: 'workspaces', currentId: null, items: [], recents: [] });
    ui.post({ type: 'projectCreated', root: '/books/新書', importFrom: '/x/原稿.txt' });
    ui.sent.length = 0;
    // 空視窗那一條不算，接著等。
    ui.post({ type: 'workspaces', currentId: null, items: [], recents: [] });
    ui.post({ type: 'workspaces', currentId: '/books/別的書', items: [{ id: '/books/別的書', root: '/books/別的書', name: '別的書' }], recents: [] });
    assert.equal(ui.last('projectAction'), undefined);
    ui.post({ type: 'workspaces', currentId: '/books/新書', items: [{ id: '/books/新書', root: '/books/新書', name: '新書' }], recents: [] });
    assert.equal(ui.last('projectAction'), undefined);
  });
});
