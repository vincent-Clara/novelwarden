/**
 * 全書查詢替換面板（`media/src/editor/bookFind.ts`）與「編輯 → 全書查詢替換…」（`media/src/view/bookFindMenu.ts`）。
 * 結果由後端推來（`bookFindResult` / `bookReplaceDone`），這裡按訊息造；純函式的口徑在 tests/unit/editor/bookFindCore.test.js，
 * 後端在 tests/integration/views/bookFind.test.js 與 tests/integration/features/bookReplace.test.js。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 開啟 / 收起 | Ctrl+Shift+F 開啟、壓在側欄上（編輯區不擋）、焦點進查詢框；Ctrl+Shift+H 焦點進替換框；不開本檔案的查詢條；Esc、×、點活動欄頁簽收起；編輯區裡的選區預填 |
 * | 選單 | 「編輯」選單「替換」後面緊跟「全書查詢替換…」、寫著 Ctrl+Shift+F、點了開啟；沒開工程置灰、不開 |
 * | 停頓再搜 | 停頓 300ms 才發 `bookFind`（預設只勾正文）；組字中途不發；新的一次之前先 `cancelBookFind` 上一次；Enter 當場搜；別人的 requestId 不認 |
 * | 結果 | 按範圍分組、檔案的稱呼與處數、每一處一行上下文（命中的字高亮）、到了上限與沒搜的說明、正則寫錯 |
 * | 點一處 | 沒開著的開成正常標籤（不帶 preview）、到了之後選中那一處（按行列認、本檔案查詢條亮著同一個查詢串）、焦點進編輯區；開著的直接切過去 |
 * | 未儲存 | 編輯器裡有未儲存修改的檔案標「未儲存」；預覽裡勾不了；替換請求裡列進 `dirty` |
 * | 預覽 | 「預覽替換」髮帶 replacement 的 `bookFind`；舊字劃掉、新字跟著；每一處、每個檔案都能勾掉；計數跟著變 |
 * | 替換所選 | 兩段式：第一下只換字，第二下才發 `bookReplace`（勾掉的不帶、每份帶預覽時的 hash）；改了勾選退回第一段 |
 * | 彙總 | 替換了幾個檔案幾處、歷史版本、跳過了哪些與為什麼；之後自動再搜一次 |
 * | 磁碟同步 | 已開啟的乾淨標籤：替換完 `state` 一到就核對，後端說磁碟上變了就地換成新內容 |
 */
const { describe, test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file, viewState } = require('../../helpers/dom');

const URL = 'http://localhost/?project=%2Ftmp%2F%E9%9D%92%E4%BA%91';
const C1 = 'chapters/001-入宗.md';
const C2 = 'chapters/002-下山.md';
const P1 = '.novelwarden/summaries/001-入宗.md';
const T1 = '# 入宗\n\n林晚推開山門。\n山風裡林晚站了很久。\n';
const T2 = '# 下山\n\n林晚下山去了。\n';

const hit = (text, line, col, extra = {}) => {
  const lines = text.split('\n');
  const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + col;
  return { start, end: start + 2, line, col, before: lines[line - 1].slice(0, col), text: '林晚', after: lines[line - 1].slice(col + 2), ...extra };
};

/** 一份結果：第 1 章兩處、第 2 章一處、第 1 章細綱一處。 */
function result(extra = {}, replacement) {
  const r = (h) => (replacement === undefined ? h : { ...h, replacement });
  return {
    files: [
      { path: C1, scope: 'chapter', label: '第 1 章 入宗', hash: 'h1', count: 2, hits: [r(hit(T1, 3, 0)), r(hit(T1, 4, 3))] },
      { path: C2, scope: 'chapter', label: '第 2 章 下山', hash: 'h2', count: 1, hits: [r(hit(T2, 3, 0))] },
      { path: P1, scope: 'plot', label: '細綱 · 第 1 章 入宗', hash: 'hp', count: 1, hits: [r({ start: 60, end: 62, line: 9, col: 0, before: '', text: '林晚', after: '入宗' })] },
    ],
    listed: 4,
    scanned: 6,
    skipped: [],
    ...extra,
  };
}

function harness(opts = {}) {
  const ui = mount({
    body: 'standalone',
    scripts: ['view.js', 'editor.js'],
    shims: ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard', 'fakeTimers'],
    url: URL,
    ...opts,
  });
  const toasts = [];
  ui.window.__nfToast = (m, isError) => toasts.push({ m, isError: !!isError });
  if (!opts.empty) {
    ui.post({ type: 'state', state: viewState() });
  }
  const { doc, window } = ui;
  const h = {
    ui,
    doc,
    toasts,
    tick: (ms) => window.__clock.tick(ms),
    panel: () => doc.querySelector('.bf-panel'),
    isOpen: () => !!h.panel() && !h.panel().classList.contains('hidden'),
    q: (cls) => doc.querySelector(`.bf-panel .${cls}`),
    all: (cls) => [...doc.querySelectorAll(`.bf-panel .${cls}`)],
    area: () => doc.getElementById('edArea'),
    key(target, key, init = {}) {
      const ev = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(ev);
      return ev;
    },
    ctrlShift(letter, target = doc.body) {
      return h.key(target, letter.toUpperCase(), { ctrlKey: true, shiftKey: true, code: `Key${letter.toUpperCase()}` });
    },
    type(input, value, init = {}) {
      input.value = value;
      input.dispatchEvent(new window.InputEvent('input', { bubbles: true, ...init }));
    },
    /** 第 n 條之後發出去的某種訊息（拷成本 realm 的普通物件）。 */
    sent: (type) => JSON.parse(JSON.stringify(ui.sent.filter((m) => m.type === type))),
    last: (type) => h.sent(type).at(-1),
    /** 開啟、輸入、等停頓、回結果。 */
    search(query = '林晚', r = result()) {
      if (!h.isOpen()) {
        h.ctrlShift('f');
      }
      h.type(h.q('bf-query'), query);
      h.tick(300);
      h.respond(r);
    },
    respond(r = result()) {
      const req = h.last('bookFind');
      assert.ok(req, '沒發 bookFind');
      ui.post({ type: 'bookFindResult', requestId: req.requestId, result: r });
    },
    status: () => h.q('bf-status').textContent,
    open: (path, text, extra) => ui.post({ type: 'editorOpen', file: file(path, text, { kind: 'chapter', ...extra }) }),
  };
  return h;
}

describe('全書查詢替換 · 開啟與收起', { skip: JSDOM_SKIP }, () => {
  let h;
  beforeEach(() => {
    h = harness();
  });

  test('Ctrl+Shift+F 開啟、壓在側欄上、焦點進查詢框；不開本檔案的查詢條', () => {
    h.open(C1, T1);
    const ev = h.ctrlShift('f', h.area());
    assert.equal(ev.defaultPrevented, true);
    assert.equal(h.isOpen(), true);
    assert.equal(h.panel().parentElement, h.doc.getElementById('wbSide'));
    assert.equal(h.doc.getElementById('wbSide').classList.contains('bf-open'), true);
    assert.equal(h.doc.activeElement, h.q('bf-query'));
    assert.equal(h.doc.querySelector('#wbEditor .ed-find:not(.hidden)'), null, 'Ctrl+Shift+F 不該開本檔案的查詢條');
    // 編輯區沒被擋：面板不在編輯器裡，也不是遮罩。
    assert.equal(h.doc.getElementById('wbEditor').contains(h.panel()), false);
    assert.equal(h.doc.querySelector('.modal-overlay:not(.hidden)'), null);
  });

  test('Ctrl+F 仍是本檔案的查詢條，不開全書面板', () => {
    h.open(C1, T1);
    h.key(h.area(), 'f', { ctrlKey: true });
    assert.equal(h.isOpen(), false);
    assert.ok(h.doc.querySelector('#wbEditor .ed-find:not(.hidden)'));
  });

  test('Ctrl+Shift+H：查詢框有字時焦點進替換框', () => {
    h.ctrlShift('f');
    h.type(h.q('bf-query'), '林晚');
    h.q('bf-query').blur();
    h.ctrlShift('h');
    assert.equal(h.doc.activeElement, h.q('bf-replace'));
  });

  test('編輯區裡選著一行之內的幾個字：預填進查詢框、當場搜', () => {
    h.open(C1, T1);
    h.area().focus();
    h.area().setSelectionRange(T1.indexOf('林晚'), T1.indexOf('林晚') + 2);
    h.ctrlShift('f', h.area());
    assert.equal(h.q('bf-query').value, '林晚');
    assert.equal(h.last('bookFind').query.query, '林晚');
  });

  test('Esc 收起、側欄原來那一頁露出來、焦點還回去；結果留著，再開啟還在', () => {
    const chat = h.doc.getElementById('input');
    chat.focus();
    h.ctrlShift('f', chat);
    h.search();
    const ev = h.key(h.q('bf-query'), 'Escape');
    assert.equal(ev.defaultPrevented, true);
    assert.equal(h.isOpen(), false);
    assert.equal(h.doc.getElementById('wbSide').classList.contains('bf-open'), false);
    assert.equal(h.doc.activeElement, chat);
    h.ctrlShift('f');
    assert.equal(h.all('bf-file').length, 3);
  });

  test('× 與點活動欄頁籤都收起', () => {
    h.ctrlShift('f');
    h.ui.clickEl(h.q('bf-close'));
    assert.equal(h.isOpen(), false);
    h.ctrlShift('f');
    h.ui.clickEl(h.doc.querySelector('.tabbar .tab[data-tab="project"]'));
    assert.equal(h.isOpen(), false);
  });
});

describe('全書查詢替換 · 選單與沒開工程', { skip: JSDOM_SKIP }, () => {
  test('「編輯」選單「替換」後面緊跟「全書查詢替換…」，寫著 Ctrl+Shift+F，點了開啟', () => {
    const h = harness();
    h.ui.clickEl(h.doc.querySelector('[data-menu="edit"]'));
    const items = [...h.doc.querySelectorAll('.wb-menu-drop .wb-menu-item')];
    const labels = items.map((b) => b.querySelector('.wb-menu-label').textContent);
    const at = labels.indexOf('替換');
    assert.equal(labels[at + 1], '全書查詢替換…');
    assert.equal(items[at + 1].querySelector('.wb-menu-kbd').textContent, 'Ctrl+Shift+F');
    assert.equal(items[at + 1].disabled, false);
    h.ui.clickEl(items[at + 1]);
    assert.equal(h.isOpen(), true);
  });

  test('沒開工程：選單項置灰、提示原因；快捷鍵不開面板、說一句', () => {
    const h = harness({ empty: true });
    h.ui.clickEl(h.doc.querySelector('[data-menu="edit"]'));
    const item = [...h.doc.querySelectorAll('.wb-menu-drop .wb-menu-item')].find(
      (b) => b.querySelector('.wb-menu-label').textContent === '全書查詢替換…'
    );
    assert.equal(item.disabled, true);
    assert.match(item.title, /先開啟一個工程/);
    h.ctrlShift('f');
    assert.equal(h.isOpen(), false);
    assert.equal(h.sent('bookFind').length, 0);
    assert.match(h.toasts.at(-1).m, /先開啟一個工程/);
  });
});

describe('全書查詢替換 · 停頓再搜與結果', { skip: JSDOM_SKIP }, () => {
  let h;
  beforeEach(() => {
    h = harness();
    h.ctrlShift('f');
  });

  test('停頓 300ms 才發；預設只勾正文、兩顆開關關著', () => {
    h.type(h.q('bf-query'), '林晚');
    h.tick(299);
    assert.equal(h.sent('bookFind').length, 0);
    h.tick(1);
    const req = h.last('bookFind');
    assert.deepEqual(req.query, { query: '林晚', caseSensitive: false, regex: false, scopes: ['chapter'] });
    assert.match(h.status(), /正在搜/);
    assert.equal(h.q('bf-stop').classList.contains('hidden'), false);
  });

  test('組字中途不發，上屏之後再算', () => {
    h.type(h.q('bf-query'), 'lin', { isComposing: true });
    h.tick(500);
    assert.equal(h.sent('bookFind').length, 0);
    h.q('bf-query').value = '林';
    h.q('bf-query').dispatchEvent(new h.ui.window.Event('compositionend', { bubbles: true }));
    h.tick(300);
    assert.equal(h.last('bookFind').query.query, '林');
  });

  test('新的一次發出之前先叫停上一次；Enter 當場搜', () => {
    h.type(h.q('bf-query'), '林');
    h.tick(300);
    const first = h.last('bookFind').requestId;
    h.type(h.q('bf-query'), '林晚');
    h.key(h.q('bf-query'), 'Enter');
    assert.deepEqual(h.last('cancelBookFind'), { type: 'cancelBookFind', requestId: first });
    assert.equal(h.last('bookFind').query.query, '林晚');
    assert.notEqual(h.last('bookFind').requestId, first);
  });

  test('開關、範圍一換就當場搜（帶上新的條件）', () => {
    h.type(h.q('bf-query'), '林晚');
    h.tick(300);
    h.ui.clickEl(h.q('bf-regex'));
    assert.equal(h.last('bookFind').query.regex, true);
    const plotBox = h.doc.querySelector('.bf-scope input[data-scope="plot"]');
    plotBox.checked = true;
    plotBox.dispatchEvent(new h.ui.window.Event('change', { bubbles: true }));
    assert.deepEqual(h.last('bookFind').query.scopes, ['chapter', 'plot']);
  });

  test('結果：按範圍分組、檔案的稱呼與處數、每一處一行上下文，命中的字高亮', () => {
    h.search();
    assert.deepEqual(h.all('bf-group').map((g) => g.textContent), ['正文 · 2 個檔案 3 處', '細綱 · 1 個檔案 1 處']);
    assert.deepEqual(h.all('bf-file-label').map((n) => n.textContent), ['第 1 章 入宗', '第 2 章 下山', '細綱 · 第 1 章 入宗']);
    assert.deepEqual(h.all('bf-file-count').map((n) => n.textContent), ['2', '1', '1']);
    const row = h.all('bf-hit')[1];
    assert.equal(row.querySelector('.bf-line').textContent, '4');
    assert.equal(row.querySelector('.bf-ctx').textContent, '山風裡林晚站了很久。');
    assert.equal(row.querySelector('mark.bf-mark').textContent, '林晚');
    assert.equal(h.status(), '3 個檔案，4 處');
  });

  test('使用者內容不當 HTML：上下文裡的 <script> 只是字', () => {
    h.search('林晚', result({ files: [{ ...result().files[0], hits: [{ ...hit(T1, 3, 0), before: '<b>粗</b>', after: '<script>x</script>' }] }] }));
    assert.equal(h.doc.querySelector('.bf-ctx b'), null);
    assert.equal(h.doc.querySelector('.bf-ctx script'), null);
    assert.match(h.q('bf-ctx').textContent, /<script>x<\/script>/);
  });

  test('到了上限、有檔案沒搜：說出來；這一份沒列全的寫「列了幾處 / 一共幾處」', () => {
    const r = result({ truncated: { limit: 3, at: '細綱 · 第 1 章 入宗' }, skipped: [{ path: 'chapters/009.md', label: '第 9 章', reason: '超過 2 MB，沒有搜' }] });
    r.files[0].count = 5;
    h.search('林晚', r);
    const notes = h.all('bf-note').map((n) => n.textContent);
    assert.match(notes[0], /只列了前 3 處：搜到「細綱 · 第 1 章 入宗」就停了/);
    assert.match(notes[1], /第 9 章（超過 2 MB，沒有搜）/);
    assert.equal(h.all('bf-file-count')[0].textContent, '2/5');
  });

  test('正則寫錯：說一句、查詢框標紅', () => {
    h.search('(', { files: [], listed: 0, scanned: 0, skipped: [], error: 'Unterminated group' });
    assert.equal(h.status(), '正則寫錯了');
    assert.equal(h.q('bf-query').classList.contains('invalid'), true);
  });

  test('別的視窗的 requestId 不認；停止之後回來的也不認', () => {
    h.type(h.q('bf-query'), '林晚');
    h.tick(300);
    h.ui.post({ type: 'bookFindResult', requestId: 'someone-else', result: result() });
    assert.equal(h.all('bf-file').length, 0);
    const req = h.last('bookFind');
    h.ui.clickEl(h.q('bf-stop'));
    assert.deepEqual(h.last('cancelBookFind'), { type: 'cancelBookFind', requestId: req.requestId });
    assert.equal(h.status(), '已停止');
    h.ui.post({ type: 'bookFindResult', requestId: req.requestId, result: result() });
    assert.equal(h.all('bf-file').length, 0);
  });

  test('點檔案那一行收起 / 展開它的那幾處', () => {
    h.search();
    const head = h.all('bf-file-head')[0];
    h.ui.clickEl(head);
    assert.equal(h.all('bf-file')[0].classList.contains('collapsed'), true);
    h.ui.clickEl(head);
    assert.equal(h.all('bf-file')[0].classList.contains('collapsed'), false);
  });
});

describe('全書查詢替換 · 點一處跳過去', { skip: JSDOM_SKIP }, () => {
  let h;
  beforeEach(() => {
    h = harness();
  });

  test('沒開著的：開成正常標籤（不帶 preview），到了之後選中那一處、焦點進編輯區，本檔案的查詢條亮著同一個查詢串', () => {
    h.search();
    const before = h.ui.sent.length;
    h.ui.clickEl(h.all('bf-hit')[1]);
    const opened = JSON.parse(JSON.stringify(h.ui.sent.slice(before))).filter((m) => m.type === 'openEditor');
    assert.deepEqual(opened, [{ type: 'openEditor', path: C1, pane: 'main' }]);
    h.open(C1, T1);
    const a = h.area();
    assert.equal(a.value.slice(a.selectionStart, a.selectionEnd), '林晚');
    assert.equal(a.selectionStart, T1.lastIndexOf('林晚'));
    assert.equal(h.doc.activeElement, a);
    assert.equal(h.doc.querySelector('#wbEditor .ed-find .ed-find-input').value, '林晚');
    assert.equal(h.doc.querySelector('#wbEditor .ed-find').classList.contains('hidden'), false);
  });

  test('已經開著的：直接切過去選中，不發 openEditor', () => {
    h.open(C2, T2);
    h.open(C1, T1);
    h.search();
    const before = h.sent('openEditor').length;
    h.ui.clickEl(h.all('bf-hit')[2]);
    assert.equal(h.sent('openEditor').length, before);
    const a = h.area();
    assert.equal(h.doc.querySelector('#wbEditor .ed-tab.active .ed-tab-name').textContent.includes('002'), true);
    assert.equal(a.selectionStart, T2.indexOf('林晚'));
  });

  test('按行列認位置：磁碟上是 \\r\\n、編輯區裡是 \\n 也選得準', () => {
    const crlf = T1.replace(/\n/g, '\r\n');
    const r = result();
    // 後端按磁碟那一份算的下標比編輯區裡多出幾個 \r，行列不變。
    r.files[0].hits[1] = { ...hit(T1, 4, 3), start: crlf.lastIndexOf('林晚'), end: crlf.lastIndexOf('林晚') + 2 };
    h.open(C1, T1);
    h.search('林晚', r);
    h.ui.clickEl(h.all('bf-hit')[1]);
    assert.equal(h.area().selectionStart, T1.lastIndexOf('林晚'));
  });

  test('編輯區裡那幾個字已經改掉了：照實說一句', () => {
    h.open(C1, '# 入宗\n\n什麼都沒有。\n');
    h.search();
    h.ui.clickEl(h.all('bf-hit')[0]);
    assert.match(h.toasts.at(-1).m, /找不到了/);
  });

  test('鍵盤：在一處上按 Enter 也跳', () => {
    h.open(C1, T1);
    h.search();
    h.key(h.all('bf-hit')[0], 'Enter');
    assert.equal(h.area().selectionStart, T1.indexOf('林晚'));
  });
});

describe('全書查詢替換 · 預覽、勾選、替換所選、彙總', { skip: JSDOM_SKIP }, () => {
  let h;

  before(() => {
    h = harness();
    // 第 2 章開著、有未儲存的修改；第 1 章開著、沒改過。
    h.open(C2, T2);
    h.area().value = `${T2}還沒存。`;
    h.area().dispatchEvent(new h.ui.window.Event('input', { bubbles: true }));
    h.open(C1, T1);
    h.search();
  });

  test('只查詢時：未儲存的那一份標出來（列的是磁碟上的內容）', () => {
    const dirty = h.doc.querySelector(`.bf-file[data-path="${C2}"] .bf-dirty`);
    assert.ok(dirty);
    assert.match(dirty.title, /磁碟上的內容/);
    assert.equal(h.doc.querySelector(`.bf-file[data-path="${C1}"] .bf-dirty`), null);
  });

  test('「預覽替換」髮帶 replacement 的請求；回來之後舊字劃掉、新字跟著，每一處、每個檔案都有勾選框', () => {
    h.type(h.q('bf-replace'), '林婉');
    h.ui.clickEl(h.q('bf-preview'));
    const req = h.last('bookFind');
    assert.equal(req.query.replacement, '林婉');
    assert.match(h.status(), /正在預覽/);
    h.respond(result({}, '林婉'));
    const row = h.all('bf-hit')[0];
    assert.equal(row.querySelector('del.bf-old').textContent, '林晚');
    assert.equal(row.querySelector('ins.bf-new').textContent, '林婉');
    assert.equal(h.all('bf-hit-check').length, 4);
    assert.equal(h.all('bf-file-check').length, 3);
  });

  test('未儲存的那一份勾不了；按鈕與狀態行上的數不算它', () => {
    const block = h.doc.querySelector(`.bf-file[data-path="${C2}"]`);
    assert.equal(block.querySelector('.bf-file-check').disabled, true);
    assert.equal(block.querySelector('.bf-hit-check').disabled, true);
    assert.equal(h.q('bf-replace-selected').textContent, '替換所選（2 個檔案 3 處）');
    assert.match(h.status(), /勾著 2 個檔案 3 處；1 個檔案有未儲存的修改，會跳過/);
  });

  test('勾掉一處：計數跟著變，檔案那一格成了「勾了一部分」', () => {
    const box = h.doc.querySelectorAll(`.bf-file[data-path="${C1}"] .bf-hit-check`)[1];
    box.checked = false;
    box.dispatchEvent(new h.ui.window.Event('change', { bubbles: true }));
    assert.equal(h.q('bf-replace-selected').textContent, '替換所選（2 個檔案 2 處）');
    assert.equal(h.doc.querySelector(`.bf-file[data-path="${C1}"] .bf-file-check`).indeterminate, true);
  });

  test('替換所選是兩段式：第一下只換字、不發；改了勾選退回第一段', () => {
    h.ui.clickEl(h.q('bf-replace-selected'));
    assert.equal(h.sent('bookReplace').length, 0);
    assert.equal(h.q('bf-replace-selected').textContent, '再點一下：替換 2 個檔案 2 處');
    const plotBox = h.doc.querySelector(`.bf-file[data-path="${P1}"] .bf-file-check`);
    plotBox.checked = false;
    plotBox.dispatchEvent(new h.ui.window.Event('change', { bubbles: true }));
    assert.equal(h.q('bf-replace-selected').textContent, '替換所選（1 個檔案 1 處）');
    plotBox.checked = true;
    plotBox.dispatchEvent(new h.ui.window.Event('change', { bubbles: true }));
  });

  test('第二下才發：勾掉的不帶、每份帶預覽時的 hash、未儲存的列進 dirty', () => {
    h.ui.clickEl(h.q('bf-replace-selected'));
    h.ui.clickEl(h.q('bf-replace-selected'));
    const req = h.last('bookReplace');
    assert.ok(req);
    assert.deepEqual(req.request.files, [
      { path: C1, hash: 'h1', hits: [{ start: hit(T1, 3, 0).start, end: hit(T1, 3, 0).end }] },
      { path: C2, hash: 'h2', hits: [{ start: hit(T2, 3, 0).start, end: hit(T2, 3, 0).end }] },
      { path: P1, hash: 'hp', hits: [{ start: 60, end: 62 }] },
    ]);
    assert.deepEqual(req.request.dirty, [C2]);
    assert.equal(req.request.replacement, '林婉');
    assert.deepEqual(req.request.scopes, ['chapter']);
    assert.match(h.status(), /正在替換/);
  });

  test('彙總：替換了幾個檔案幾處、歷史版本是退路、跳過了哪些與為什麼；之後自動再搜一次（只查詢）', () => {
    const req = h.last('bookReplace');
    const searches = h.sent('bookFind').length;
    h.ui.post({
      type: 'bookReplaceDone',
      requestId: req.requestId,
      summary: {
        files: 2,
        hits: 2,
        replaced: [{ path: C1, label: '第 1 章 入宗', count: 1 }, { path: P1, label: '細綱 · 第 1 章 入宗', count: 1 }],
        skipped: [{ path: C2, label: '第 2 章 下山', reason: 'dirty', message: '編輯器裡有未儲存的修改：先儲存（或放棄修改），再替換一次。' }],
        chainKept: [],
        plotOnly: [],
        bodyOnly: [],
        outlineOnly: [],
        renamedCards: [],
      },
    });
    const lines = h.all('bf-summary-line').map((n) => n.textContent);
    assert.equal(lines[0], '替換了 2 個檔案、共 2 處。');
    assert.match(lines[1], /「歷史」裡找回替換前那一版/);
    assert.match(lines[1], /沒有一步撤銷/);
    assert.ok(lines.includes('跳過了 1 個檔案：'));
    assert.ok(lines.some((l) => /第 2 章 下山——編輯器裡有未儲存的修改/.test(l)));
    assert.equal(h.sent('bookFind').length, searches + 1);
    assert.equal(h.last('bookFind').query.replacement, undefined);
    assert.equal(h.q('bf-actions').classList.contains('hidden'), true);
  });

  test('已開啟的乾淨標籤：替換完 state 一到就核對，後端說磁碟上變了就地換成新內容', () => {
    const checks = h.sent('checkEditorFiles').length;
    h.ui.post({ type: 'state', state: viewState() });
    h.tick(400);
    const check = h.last('checkEditorFiles');
    assert.equal(h.sent('checkEditorFiles').length, checks + 1);
    assert.ok(check.files.some((f) => f.path === C1));
    const replaced = T1.replace('林晚', '林婉');
    h.ui.post({ type: 'editorDiskChanged', file: file(C1, replaced, { hash: 'h1-new', kind: 'chapter' }) });
    assert.equal(h.area().value, replaced);
    assert.equal(h.doc.querySelector('#wbEditor .ed-tab.active').classList.contains('dirty'), false);
  });
});

describe('全書查詢替換 · 預覽之後又改了輸入框', { skip: JSDOM_SKIP }, () => {
  test('新的預覽回來之前「替換所選」不能點（不拿舊預覽去換）', () => {
    const h = harness();
    h.search();
    h.type(h.q('bf-replace'), '林婉');
    h.ui.clickEl(h.q('bf-preview'));
    h.respond(result({}, '林婉'));
    assert.equal(h.q('bf-replace-selected').disabled, false);
    h.type(h.q('bf-replace'), '林苑');
    assert.equal(h.q('bf-replace-selected').disabled, true);
    h.tick(300);
    assert.equal(h.last('bookFind').query.replacement, '林苑');
    assert.equal(h.q('bf-replace-selected').disabled, true);
    h.respond(result({}, '林苑'));
    assert.equal(h.q('bf-replace-selected').disabled, false);
  });

  test('「退出預覽」回到只查詢', () => {
    const h = harness();
    h.search();
    h.type(h.q('bf-replace'), '林婉');
    h.ui.clickEl(h.q('bf-preview'));
    h.respond(result({}, '林婉'));
    h.ui.clickEl(h.q('bf-exit-preview'));
    assert.equal(h.last('bookFind').query.replacement, undefined);
    h.respond();
    assert.equal(h.all('bf-hit-check').length, 0);
    assert.equal(h.q('bf-actions').classList.contains('hidden'), true);
  });

  test('替換沒做成（上一次還沒換完）：預覽留著、說一句', () => {
    const h = harness();
    h.search();
    h.type(h.q('bf-replace'), '林婉');
    h.ui.clickEl(h.q('bf-preview'));
    h.respond(result({}, '林婉'));
    h.ui.clickEl(h.q('bf-replace-selected'));
    h.ui.clickEl(h.q('bf-replace-selected'));
    const req = h.last('bookReplace');
    h.ui.post({
      type: 'bookReplaceDone',
      requestId: req.requestId,
      summary: { files: 0, hits: 0, replaced: [], skipped: [], chainKept: [], plotOnly: [], bodyOnly: [], outlineOnly: [], renamedCards: [], error: '上一次全書替換還沒換完，等它換完再來。' },
    });
    assert.match(h.q('bf-summary').textContent, /還沒換完/);
    assert.equal(h.all('bf-hit-check').length, 4);
  });
});

describe('全書查詢替換 · 頁面模板與外掛形態', { skip: JSDOM_SKIP }, () => {
  test('頁面模板裡沒有面板（由指令碼現造）', () => {
    const { standaloneBodyHtml } = require('../../helpers/dom');
    assert.equal(standaloneBodyHtml().includes('bf-panel'), false);
  });

  test('外掛形態（沒有 #wbEditor）：不裝、Ctrl+Shift+F 不攔', () => {
    const ui = mount({ body: 'webview', scripts: ['view.js', 'editor.js'] });
    const ev = new ui.window.KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    ui.doc.body.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, false);
    assert.equal(ui.doc.querySelector('.bf-panel'), null);
  });
});

describe('全書查詢替換 · 與名詞補全互不打擾', { skip: JSDOM_SKIP }, () => {
  const NAMES = {
    initialized: true,
    names: [{ name: '林晚', aliases: ['阿晚'], source: 'character', category: '', brief: '', path: '.novelwarden/characters/林晚.md' }],
  };
  const box = (h) => h.doc.querySelector('.nc-box');
  const boxShown = (h) => !!box(h) && !box(h).classList.contains('hidden');
  const altSlash = (h, target) => h.key(target, '/', { code: 'Slash', altKey: true });
  const serveNames = (h) => {
    const req = h.last('requestNameIndex');
    if (req) {
      h.ui.post({ type: 'nameIndex', requestId: req.requestId, sig: 'n1', index: NAMES });
    }
  };

  test('面板裡的輸入框打字、按 Alt+/：不彈名詞補全（補全只認編輯區的 textarea）', () => {
    const h = harness();
    h.open(C1, T1);
    serveNames(h);
    h.ctrlShift('f');
    for (const cls of ['bf-query', 'bf-replace']) {
      h.q(cls).focus();
      h.type(h.q(cls), '林', { inputType: 'insertText', data: '林' });
      altSlash(h, h.q(cls));
      h.tick(500);
      serveNames(h);
      assert.equal(boxShown(h), false, `${cls} 裡彈了名詞補全`);
    }
    assert.equal(h.isOpen(), true, 'Alt+/ 不該收起面板');
  });

  test('編輯區裡 Alt+/ 是名詞補全、不開全書面板；Ctrl+Shift+F / Ctrl+Shift+H 是全書面板、不彈補全', () => {
    const h = harness();
    h.open(C1, '# 入宗\n\n林');
    const a = h.area();
    a.focus();
    a.setSelectionRange(a.value.length, a.value.length);
    altSlash(h, a);
    serveNames(h);
    assert.equal(boxShown(h), true, 'Alt+/ 應該彈名詞補全');
    assert.equal(h.isOpen(), false, 'Alt+/ 不該開全書面板');
    const asked = h.sent('requestNameIndex').length;
    const ev = h.ctrlShift('f', a);
    assert.equal(ev.defaultPrevented, true);
    assert.equal(h.isOpen(), true);
    h.key(h.q('bf-query'), 'Escape');
    a.focus();
    h.ctrlShift('h', a);
    assert.equal(h.isOpen(), true);
    assert.equal(h.sent('requestNameIndex').length, asked, 'Ctrl+Shift+F / H 不該去要名詞表');
  });
});
