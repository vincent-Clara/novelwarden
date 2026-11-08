/**
 * 內建編輯器的查詢替換條與高亮映象層（`media/src/editor/find.ts` / `highlight.ts`）。
 *
 * jsdom 沒有排版：映象層只測 DOM 內容（`<mark>` 與匹配一一對得上、class 分得出當前那一處），不測畫素。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | DOM 只有一份 | 頁面模板裡沒有查詢條；開啟時現造、插在 `.ed-stage` 前面；草稿區有自己的那一條 |
 * | 從游標往後找 | 打字時從游標往後最近一處選中，計數「k/N」，焦點留在查詢框 |
 * | 上一個 / 下一個 | Enter / Shift+Enter / F3 / Shift+F3、按鈕，到頭繞回；組字中途的 Enter 不算 |
 * | 預填 | Ctrl+F 時一行之內的短選區填進查詢框 |
 * | Aa / .* | 區分大小寫、正則；正則寫錯了說一句、不拋 |
 * | 映象層 | `<mark>` 與匹配一致、當前那一處另一種 class；文字一變下一幀重算；按行分塊、改一行只換那一塊；換檔案清掉舊的；超大檔案不畫並說一句 |
 * | Esc | 關掉、清高亮、焦點回編輯區 |
 * | 替換 | Ctrl+H 展開替換行；選區正好是當前那一處才換、換完跳下一處；替換框 Enter；一處一步撤銷；`$1` |
 * | 全部替換 | 一次改完、提示替換了 N 處、Ctrl+Z 一步退回 |
 * | 快捷鍵的邊界 | 焦點在對話輸入框時 Ctrl+F 不攔；預覽模式下先切回編輯；「編輯」選單「查詢」後面緊跟「替換」 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, MIRROR_LAYOUT, file, standaloneBodyHtml } = require('../../helpers/dom');

/** 等兩幀：文字變了之後查詢條下一幀重算，映象層隨之重畫（jsdom 沒有 rAF，退回 16ms 定時器）。 */
const frames = () => new Promise((resolve) => setTimeout(resolve, 60));

function harness(scripts = ['editor.js']) {
  const ui = mount({ body: 'standalone', scripts, shims: ['pointerCapture', 'confirm'] });
  const main = () => ui.doc.getElementById('wbEditor');
  const draft = () => ui.doc.querySelector('.wb-editor-draft');
  const area = (root = main()) => root.querySelector('textarea.ed-area');
  const bar = (root = main()) => root.querySelector('.ed-find');
  const part = (cls, root = main()) => root.querySelector(`.ed-find .${cls}`);
  const press = (target, init) => {
    const ev = new ui.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(ev);
    return ev;
  };
  const ctrl = (key, target = area()) => press(target, { key, ctrlKey: true });
  const type = (input, value) => {
    input.value = value;
    input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  };
  const open = (path, text, extra) => ui.post({ type: 'editorOpen', file: file(path, text, extra) });
  const marks = (root = main()) => [...root.querySelectorAll('.ed-mirror:not(.ed-mirror-probe) mark')];
  const selected = (a = area()) => a.value.slice(a.selectionStart, a.selectionEnd);
  const count = (root = main()) => part('ed-find-count', root).textContent;
  const isOpen = (root = main()) => !!bar(root) && !bar(root).classList.contains('hidden');
  return { ui, main, draft, area, bar, part, press, ctrl, type, open, marks, selected, count, isOpen };
}

describe('查詢條：開啟、從游標往後找、上一個 / 下一個', { skip: JSDOM_SKIP }, () => {
  let h;

  before(() => {
    h = harness();
    h.open('chapters/001.md', '甲乙甲丙甲');
  });

  test('頁面模板裡沒有查詢條（兩塊編輯區都由指令碼現造，DOM 只有一份）', () => {
    assert.equal(standaloneBodyHtml().includes('ed-find'), false);
    assert.equal(h.bar(), null);
  });

  test('Ctrl+F 開啟這一塊的查詢條，插在正文區前面，焦點落在查詢框', () => {
    const ev = h.ctrl('f');
    assert.equal(ev.defaultPrevented, true);
    assert.equal(h.isOpen(), true);
    assert.equal(h.bar().nextElementSibling.classList.contains('ed-stage'), true);
    assert.equal(h.ui.doc.activeElement, h.part('ed-find-input'));
    assert.equal(h.ui.doc.querySelectorAll('#wbEditor .ed-find').length, 1);
  });

  test('打字時從游標往後找最近的一處並選中，計數寫第幾處', () => {
    h.area().setSelectionRange(1, 1);
    h.type(h.part('ed-find-input'), '甲');
    assert.deepEqual([h.area().selectionStart, h.area().selectionEnd], [2, 3]);
    assert.equal(h.count(), '2/3');
  });

  test('選中時焦點仍留在查詢框裡（接著打字不會打進正文）', () => {
    assert.equal(h.ui.doc.activeElement, h.part('ed-find-input'));
  });

  test('Enter 下一處，到最後一處之後繞回第一處', () => {
    const input = h.part('ed-find-input');
    h.press(input, { key: 'Enter' });
    assert.deepEqual([h.area().selectionStart, h.count()], [4, '3/3']);
    h.press(input, { key: 'Enter' });
    assert.deepEqual([h.area().selectionStart, h.count()], [0, '1/3']);
  });

  test('Shift+Enter 上一處，到第一處之前繞回最後一處', () => {
    h.press(h.part('ed-find-input'), { key: 'Enter', shiftKey: true });
    assert.deepEqual([h.area().selectionStart, h.count()], [4, '3/3']);
  });

  test('「上一個」「下一個」按鈕', () => {
    h.ui.clickEl(h.part('ed-find-prev'));
    assert.equal(h.count(), '2/3');
    h.ui.clickEl(h.part('ed-find-next'));
    assert.equal(h.count(), '3/3');
  });

  test('輸入法組字中途的 Enter 不跳', () => {
    const before = h.area().selectionStart;
    h.press(h.part('ed-find-input'), { key: 'Enter', isComposing: true });
    assert.equal(h.area().selectionStart, before);
  });

  test('編輯區裡 F3 下一處、Shift+F3 上一處', () => {
    h.area().focus();
    h.area().setSelectionRange(0, 0);
    const ev = h.press(h.area(), { key: 'F3' });
    assert.equal(ev.defaultPrevented, true);
    assert.deepEqual([h.area().selectionStart, h.count()], [0, '1/3']);
    h.press(h.area(), { key: 'F3' });
    assert.equal(h.count(), '2/3');
    h.press(h.area(), { key: 'F3', shiftKey: true });
    assert.equal(h.count(), '1/3');
  });

  test('找不到時寫「無結果」，選區不動', () => {
    h.area().setSelectionRange(1, 1);
    h.type(h.part('ed-find-input'), '丁');
    assert.equal(h.count(), '無結果');
    assert.deepEqual([h.area().selectionStart, h.area().selectionEnd], [1, 1]);
  });

  test('Ctrl+F 時一行之內的短選區預填進查詢框，它就是當前那一處', () => {
    h.press(h.part('ed-find-input'), { key: 'Escape' });
    h.area().setSelectionRange(1, 3);
    h.ctrl('f');
    assert.equal(h.part('ed-find-input').value, '乙甲');
    assert.equal(h.count(), '1/1');
  });

  test('跨行的選區不預填，查詢框留著上一次的字', () => {
    h.open('chapters/002.md', '甲\n乙');
    h.area().setSelectionRange(0, 3);
    h.ctrl('f');
    assert.equal(h.part('ed-find-input').value, '乙甲');
  });
});

describe('查詢條：區分大小寫、正則', { skip: JSDOM_SKIP }, () => {
  let h;

  before(() => {
    h = harness();
    h.open('notes/a.md', 'Abc abc 第3章 第12章');
    h.ctrl('f');
  });

  test('預設不區分大小寫；按下「Aa」之後區分', () => {
    h.area().setSelectionRange(0, 0);
    h.type(h.part('ed-find-input'), 'abc');
    assert.equal(h.count(), '1/2');
    h.ui.clickEl(h.part('ed-find-case'));
    assert.equal(h.part('ed-find-case').getAttribute('aria-pressed'), 'true');
    assert.equal(h.count(), '1/1');
    assert.equal(h.selected(), 'abc');
    h.ui.clickEl(h.part('ed-find-case'));
  });

  test('按下「.*」之後按正則找', () => {
    h.ui.clickEl(h.part('ed-find-regex'));
    h.area().setSelectionRange(0, 0);
    h.type(h.part('ed-find-input'), '第\\d+章');
    assert.equal(h.count(), '1/2');
    assert.equal(h.selected(), '第3章');
  });

  test('正則寫錯了：不拋，查詢條上說一句，沒有高亮', () => {
    h.type(h.part('ed-find-input'), '第(\\d+章');
    assert.equal(h.part('ed-find-note').textContent, '正則寫錯了');
    assert.equal(h.part('ed-find-note').classList.contains('hidden'), false);
    assert.equal(h.count(), '');
    assert.equal(h.marks().length, 0);
  });

  test('改對了，提示收起', () => {
    h.type(h.part('ed-find-input'), '第(\\d+)章');
    assert.equal(h.part('ed-find-note').classList.contains('hidden'), true);
    assert.equal(h.count(), '1/2');
  });
});

describe('高亮映象層', { skip: JSDOM_SKIP }, () => {
  let h;
  const TEXT = '林昭推開門。林昭沒有說話。\n沈氏看著林昭。';

  before(() => {
    h = harness();
    h.open('chapters/001-入鎮.md', TEXT, { kind: 'chapter' });
    h.area().setSelectionRange(0, 0);
    h.ctrl('f');
    h.type(h.part('ed-find-input'), '林昭');
  });

  test('映象層與 textarea 在同一格里、排在它前面（背後），讀屏不讀它', () => {
    const mirror = h.main().querySelector('.ed-mirror:not(.ed-mirror-probe)');
    assert.equal(mirror.parentElement, h.area().parentElement);
    assert.ok(mirror.compareDocumentPosition(h.area()) & h.ui.window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.equal(mirror.getAttribute('aria-hidden'), 'true');
    assert.equal(mirror.classList.contains('hidden'), false);
  });

  test('映象裡的文字與 textarea 一字不差，<mark> 與每一處匹配一一對應', () => {
    const content = h.main().querySelector('.ed-mirror:not(.ed-mirror-probe) .ed-mirror-content');
    assert.equal(content.textContent, TEXT);
    assert.deepEqual(h.marks().map((m) => m.textContent), ['林昭', '林昭', '林昭']);
  });

  test('當前那一處另一種 class，其餘是普通匹配', () => {
    assert.deepEqual(
      h.marks().map((m) => m.classList.contains('ed-hl-find-current')),
      [true, false, false]
    );
    assert.ok(h.marks().every((m) => m.classList.contains('ed-hl')));
    h.press(h.part('ed-find-input'), { key: 'Enter' });
    assert.deepEqual(
      h.marks().map((m) => m.classList.contains('ed-hl-find-current')),
      [false, true, false]
    );
  });

  test('映象層隨 textarea 的計算樣式排版（字號、斷行規則都抄過去）', () => {
    const content = h.main().querySelector('.ed-mirror:not(.ed-mirror-probe) .ed-mirror-content');
    const cs = h.ui.window.getComputedStyle(h.area());
    assert.equal(content.style.getPropertyValue('font-size'), cs.getPropertyValue('font-size'));
    assert.equal(content.style.getPropertyValue('white-space'), cs.getPropertyValue('white-space'));
  });

  test('正文裡改了字：下一幀重算，計數與高亮跟上', async () => {
    const a = h.area();
    a.focus();
    a.value = `${TEXT}林昭`;
    a.setSelectionRange(a.value.length, a.value.length);
    a.dispatchEvent(new h.ui.window.InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
    await frames();
    assert.equal(h.marks().length, 4);
    assert.equal(h.count(), '2/4', '當前序號留在原處');
    const content = h.main().querySelector('.ed-mirror:not(.ed-mirror-probe) .ed-mirror-content');
    assert.equal(content.textContent, `${TEXT}林昭`);
  });

  test('映象按行分塊：一行一塊（行尾的換行留在塊裡）；改了一行只換那一塊，別的塊原樣留著', async () => {
    const content = h.main().querySelector('.ed-mirror:not(.ed-mirror-probe) .ed-mirror-content');
    const before = [...content.children];
    assert.deepEqual(before.map((b) => b.textContent), ['林昭推開門。林昭沒有說話。\n', '沈氏看著林昭。林昭']);
    const a = h.area();
    a.value = `${a.value}。`;
    a.setSelectionRange(a.value.length, a.value.length);
    a.dispatchEvent(new h.ui.window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: '。' }));
    await frames();
    const after = [...content.children];
    assert.equal(after.length, 2);
    assert.equal(after[0], before[0], '第一行沒變：還是原來那個元素');
    assert.notEqual(after[1], before[1]);
    assert.equal(content.textContent, a.value);
    assert.equal(h.marks().length, 4);
    // 以換行結尾：末尾那個空行單獨一塊，放零寬空格撐高（textarea 裡那一行是有的）。
    a.value = `${a.value}\n`;
    a.setSelectionRange(a.value.length, a.value.length);
    a.dispatchEvent(new h.ui.window.InputEvent('input', { bubbles: true, inputType: 'insertLineBreak' }));
    await frames();
    const last = [...content.children];
    assert.equal(last.length, 3);
    assert.equal(last[0], before[0]);
    assert.equal(last[2].textContent, '​');
  });

  test('換了檔案：舊檔案的高亮當場清掉，按新檔案重算', async () => {
    h.open('chapters/002-別處.md', '這裡沒有那個名字。', { kind: 'chapter' });
    assert.equal(h.marks().length, 0);
    await frames();
    assert.equal(h.marks().length, 0);
    assert.equal(h.count(), '無結果');
    h.open('chapters/003-再見.md', '林昭，林昭。', { kind: 'chapter' });
    await frames();
    assert.deepEqual(h.marks().map((m) => m.textContent), ['林昭', '林昭']);
    assert.equal(h.count(), '共 2 處');
  });

  test('Esc 關掉：高亮清掉，焦點回編輯區，選區停在當前那一處', () => {
    h.press(h.part('ed-find-input'), { key: 'Enter' });
    h.press(h.part('ed-find-input'), { key: 'Escape' });
    assert.equal(h.isOpen(), false);
    assert.equal(h.marks().length, 0);
    assert.equal(h.ui.doc.activeElement, h.area());
    assert.equal(h.selected(), '林昭');
  });

  test('編輯區裡按 Esc 也收起查詢條', () => {
    h.ctrl('f');
    assert.equal(h.isOpen(), true);
    const ev = h.press(h.area(), { key: 'Escape' });
    assert.equal(ev.defaultPrevented, true);
    assert.equal(h.isOpen(), false);
  });

  test('超過 30 萬字的檔案不畫高亮，查詢條上說一句（查詢照常）', () => {
    h.open('chapters/004-長.md', `${'甲'.repeat(300000)}乙`, { kind: 'chapter' });
    h.area().setSelectionRange(0, 0);
    h.ctrl('f');
    h.type(h.part('ed-find-input'), '乙');
    assert.equal(h.count(), '1/1');
    assert.equal(h.area().selectionStart, 300000);
    assert.equal(h.marks().length, 0);
    assert.match(h.part('ed-find-note').textContent, /超過 30 萬字，不畫高亮/);
  });
});

describe('替換', { skip: JSDOM_SKIP }, () => {
  let h;
  const TEXT = '林昭推門。林昭坐下。林昭笑了。';

  before(() => {
    h = harness(['view.js', 'editor.js']);
    h.open('chapters/001.md', TEXT, { kind: 'chapter' });
  });

  test('Ctrl+H 開啟查詢條並展開替換行', () => {
    h.area().focus();
    h.area().setSelectionRange(0, 0);
    const ev = h.ctrl('h');
    assert.equal(ev.defaultPrevented, true);
    assert.equal(h.isOpen(), true);
    assert.equal(h.part('ed-replace-row').classList.contains('hidden'), false);
    assert.equal(h.part('ed-find-toggle').getAttribute('aria-expanded'), 'true');
  });

  test('小三角收起 / 展開替換行', () => {
    h.ui.clickEl(h.part('ed-find-toggle'));
    assert.equal(h.part('ed-replace-row').classList.contains('hidden'), true);
    h.ui.clickEl(h.part('ed-find-toggle'));
    assert.equal(h.part('ed-replace-row').classList.contains('hidden'), false);
  });

  test('選區不是當前那一處時，「替換」這一下只選中下一處', () => {
    h.part('ed-replace-input').value = '沈氏';
    h.type(h.part('ed-find-input'), '林昭');
    h.area().setSelectionRange(1, 1);
    h.ui.clickEl(h.part('ed-replace-one'));
    assert.equal(h.area().value, TEXT);
    assert.deepEqual([h.area().selectionStart, h.selected()], [5, '林昭']);
  });

  test('選區正好是當前那一處：換掉它，跳到下一處', () => {
    h.ui.clickEl(h.part('ed-replace-one'));
    assert.equal(h.area().value, '林昭推門。沈氏坐下。林昭笑了。');
    assert.deepEqual([h.area().selectionStart, h.selected()], [10, '林昭']);
    assert.equal(h.count(), '2/2');
  });

  test('替換框裡 Enter：替換當前這一處並繞回下一處', () => {
    h.press(h.part('ed-replace-input'), { key: 'Enter' });
    assert.equal(h.area().value, '林昭推門。沈氏坐下。沈氏笑了。');
    assert.deepEqual([h.area().selectionStart, h.selected()], [0, '林昭']);
  });

  test('一處一步撤銷', () => {
    h.press(h.area(), { key: 'z', ctrlKey: true });
    assert.equal(h.area().value, '林昭推門。沈氏坐下。林昭笑了。');
    h.press(h.area(), { key: 'z', ctrlKey: true });
    assert.equal(h.area().value, TEXT);
  });

  test('全部替換：一次改完，提示替換了 N 處', () => {
    h.type(h.part('ed-find-input'), '林昭');
    h.ui.clickEl(h.part('ed-replace-all'));
    assert.equal(h.area().value, '沈氏推門。沈氏坐下。沈氏笑了。');
    assert.match(h.ui.doc.getElementById('toast').textContent, /替換了 3 處/);
    assert.equal(h.count(), '無結果');
  });

  test('全部替換隻記一步：Ctrl+Z 一下全部退回', () => {
    h.press(h.area(), { key: 'z', ctrlKey: true });
    assert.equal(h.area().value, TEXT);
    h.press(h.area(), { key: 'z', ctrlKey: true });
    assert.equal(h.area().value, TEXT, '再往前沒有了');
  });

  test('正則替換支援 $1（逐處算）', () => {
    h.open('chapters/002.md', '林昭說：好。沈氏說：走。', { kind: 'chapter' });
    h.ctrl('h');
    if (h.part('ed-find-regex').getAttribute('aria-pressed') !== 'true') {
      h.ui.clickEl(h.part('ed-find-regex'));
    }
    h.type(h.part('ed-find-input'), '(\\S{2})說：');
    h.part('ed-replace-input').value = '$1道：';
    h.ui.clickEl(h.part('ed-replace-all'));
    assert.equal(h.area().value, '林昭道：好。沈氏道：走。');
  });

  test('一處都沒有時全部替換不動文字，說一句', () => {
    h.type(h.part('ed-find-input'), '不存在');
    h.ui.clickEl(h.part('ed-replace-all'));
    assert.equal(h.area().value, '林昭道：好。沈氏道：走。');
    assert.match(h.ui.doc.getElementById('toast').textContent, /沒有可替換的/);
  });
});

describe('查詢快捷鍵的邊界', { skip: JSDOM_SKIP }, () => {
  let h;

  before(() => {
    h = harness(['view.js', 'editor.js']);
    h.ui.post({
      type: 'workspaces',
      currentId: '/tmp/book',
      items: [{ id: '/tmp/book', root: '/tmp/book', name: 'book' }],
      recents: [],
    });
    h.open('chapters/001.md', '# 第一章\n\n雨夜。');
  });

  test('焦點在左側對話輸入框時 Ctrl+F 不攔，留給瀏覽器', () => {
    const input = h.ui.doc.getElementById('input');
    input.focus();
    const ev = h.ctrl('f', input);
    assert.equal(ev.defaultPrevented, false);
    assert.equal(h.isOpen(), false);
  });

  test('Ctrl+H 同樣不攔', () => {
    const ev = h.ctrl('h', h.ui.doc.getElementById('input'));
    assert.equal(ev.defaultPrevented, false);
    assert.equal(h.isOpen(), false);
  });

  test('焦點不在任何輸入框裡時 Ctrl+F 開啟當前那塊編輯區的查詢條', () => {
    h.ui.doc.getElementById('input').blur();
    const ev = h.ctrl('f', h.ui.doc.body);
    assert.equal(ev.defaultPrevented, true);
    assert.equal(h.isOpen(), true);
    h.press(h.part('ed-find-input'), { key: 'Escape' });
  });

  test('預覽模式下按 Ctrl+F：先切回編輯再開啟', () => {
    h.ui.clickEl(h.ui.doc.getElementById('edPreviewBtn'));
    assert.equal(h.area().classList.contains('hidden'), true);
    h.ctrl('f', h.ui.doc.body);
    assert.equal(h.area().classList.contains('hidden'), false);
    assert.equal(h.ui.doc.getElementById('edPreview').classList.contains('hidden'), true);
    assert.equal(h.isOpen(), true);
    h.press(h.part('ed-find-input'), { key: 'Escape' });
  });

  test('查詢條開著時切到預覽，再在查詢框裡打字：切回編輯，焦點留在查詢框', () => {
    h.ctrl('f', h.ui.doc.body);
    h.ui.clickEl(h.ui.doc.getElementById('edPreviewBtn'));
    assert.equal(h.area().classList.contains('hidden'), true);
    h.part('ed-find-input').focus();
    h.type(h.part('ed-find-input'), '雨');
    assert.equal(h.area().classList.contains('hidden'), false);
    assert.equal(h.selected(), '雨');
    assert.equal(h.ui.doc.activeElement, h.part('ed-find-input'));
    h.press(h.part('ed-find-input'), { key: 'Escape' });
  });

  test('「編輯」選單：「查詢」後面緊跟著「替換」，點了開啟並展開替換行', () => {
    h.ui.clickEl(h.ui.doc.querySelector('[data-menu="edit"]'));
    const items = [...h.ui.doc.querySelectorAll('.wb-menu-drop .wb-menu-item')];
    const labels = items.map((b) => b.querySelector('.wb-menu-label').textContent);
    const at = labels.indexOf('查詢');
    assert.equal(labels[at + 1], '替換');
    assert.equal(items[at + 1].querySelector('.wb-menu-kbd').textContent, 'Ctrl+H');
    h.ui.clickEl(items[at + 1]);
    assert.equal(h.isOpen(), true);
    assert.equal(h.part('ed-replace-row').classList.contains('hidden'), false);
  });

  test('草稿區有自己的查詢條，與主區互不相干', () => {
    h.press(h.part('ed-find-input'), { key: 'Escape' });
    h.ui.post({ type: 'editorOpen', pane: 'draft', file: file('drafts/001.md', '草稿甲，草稿乙。') });
    const root = h.draft();
    h.ctrl('f', h.area(root));
    assert.equal(h.isOpen(root), true);
    assert.equal(h.isOpen(h.main()), false);
    h.type(h.part('ed-find-input', root), '草稿');
    assert.equal(h.count(root), '1/2');
    assert.equal(h.marks(root).length, 2);
    assert.equal(h.marks(h.main()).length, 0);
  });
});

describe('查詢跳轉的滾動', { skip: JSDOM_SKIP }, () => {
  let ui;
  const area = () => ui.doc.getElementById('edArea');
  const input = () => ui.doc.querySelector('#wbEditor .ed-find-input');
  const enter = () =>
    input().dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  // 「甲」在第 2 行和第 35 行（下標 1 與 34）。
  const TEXT = Array.from({ length: 40 }, (_, i) => (i === 1 || i === 34 ? `甲${i}` : `行${i}`)).join('\n');
  const topOf = (lineIndex) => MIRROR_LAYOUT.pad + lineIndex * MIRROR_LAYOUT.line;

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['editor.js'], shims: ['pointerCapture', 'confirm', 'mirrorLayout'] });
    ui.post({ type: 'editorOpen', file: file('chapters/001.md', TEXT) });
    area().setSelectionRange(0, 0);
    area().scrollTop = 0;
    area().dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
    input().value = '甲';
    input().dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  });

  test('目標已經在視口裡：不滾', () => {
    assert.equal(area().selectionStart, TEXT.indexOf('甲'));
    assert.equal(area().scrollTop, 0);
  });

  test('目標在視口外：滾到讓它停在視口偏上三分之一處', () => {
    enter();
    assert.equal(area().selectionStart, TEXT.lastIndexOf('甲'));
    assert.equal(area().scrollTop, topOf(34) - MIRROR_LAYOUT.viewport / 3);
  });

  test('繞回第一處也照樣滾回去', () => {
    enter();
    assert.equal(area().scrollTop, 0);
  });
});

describe('查詢條：再按 Ctrl+F、Esc 的落點', { skip: JSDOM_SKIP }, () => {
  let h;

  before(() => {
    h = harness();
    h.open('notes/a.md', '第3章 第12章');
    h.ctrl('f');
    h.ui.clickEl(h.part('ed-find-regex'));
    h.type(h.part('ed-find-input'), '第(\\d+)章');
  });

  test('焦點已在查詢框裡再按 Ctrl+F：不拿選區蓋掉寫好的正則', () => {
    assert.equal(h.selected(), '第3章');
    h.part('ed-find-input').focus();
    h.ctrl('f', h.part('ed-find-input'));
    assert.equal(h.part('ed-find-input').value, '第(\\d+)章');
  });

  test('焦點在查詢條的按鈕上按 Esc 也是關掉', () => {
    const next = h.part('ed-find-next');
    next.focus();
    h.press(next, { key: 'Escape' });
    assert.equal(h.isOpen(), false);
  });
});
