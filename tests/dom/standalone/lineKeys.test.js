/**
 * 段落快捷鍵（`media/src/editor/lines.ts`）。「段」= 一個邏輯行，空白行被跳過。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | Alt+↑ / Alt+↓ | 與上 / 下一個非空行交換，中間的空行原地不動，選區跟著走；碰到的幾行當成一塊 |
 * | Shift+Alt+↓ / ↑ | 在下 / 上方複製這幾行，正文按分段格式補段間隔；向下時選區落在新的那份 |
 * | Ctrl+Shift+K | 刪掉這幾行，正文空行分段時順帶刪一個相鄰的空行 |
 * | Ctrl+Enter / Cmd+Enter | 在當前段下面另起一段（正文按分段格式，其餘沿用縮排） |
 * | 撤銷 | 每個操作一步 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file, viewState } = require('../../helpers/dom');

const W = '　　';

describe('段落快捷鍵', { skip: JSDOM_SKIP }, () => {
  let ui;
  const area = () => ui.doc.getElementById('edArea');
  const open = (path, text, kind) => ui.post({ type: 'editorOpen', file: file(path, text, kind ? { kind } : undefined) });
  const style = (paragraphStyle) => ui.post({ type: 'state', state: viewState({ paragraphStyle }) });
  const select = (start, end = start) => area().setSelectionRange(start, end);
  const press = (init) => {
    const ev = new ui.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    area().dispatchEvent(ev);
    return ev;
  };
  const undo = () => press({ key: 'z', ctrlKey: true });
  const selected = () => area().value.slice(area().selectionStart, area().selectionEnd);

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['editor.js'], shims: ['pointerCapture', 'confirm'] });
  });

  test('Alt+↓：與下一個非空行交換，中間的空行原地不動，游標跟著走', () => {
    open('chapters/001-雨夜.md', '甲段\n\n乙段\n\n丙段', 'chapter');
    select(1);
    const ev = press({ key: 'ArrowDown', altKey: true });
    assert.equal(ev.defaultPrevented, true);
    assert.equal(area().value, '乙段\n\n甲段\n\n丙段');
    assert.equal(area().selectionStart, 5, '游標還在「甲」後面');
  });

  test('Alt+↑：換回去', () => {
    press({ key: 'ArrowUp', altKey: true });
    assert.equal(area().value, '甲段\n\n乙段\n\n丙段');
    assert.equal(area().selectionStart, 1);
  });

  test('一次交換一步撤銷', () => {
    undo();
    assert.equal(area().value, '乙段\n\n甲段\n\n丙段');
  });

  test('選中幾行：當成一塊移動，選區跟著走', () => {
    open('chapters/002-塊.md', '一\n二\n三\n四', 'chapter');
    select(2, 5);
    assert.equal(selected(), '二\n三');
    press({ key: 'ArrowDown', altKey: true });
    assert.equal(area().value, '一\n四\n二\n三');
    assert.equal(selected(), '二\n三');
  });

  test('到底了：不動，也接下這一下', () => {
    open('chapters/003-到底.md', '一\n二', 'chapter');
    select(3);
    const ev = press({ key: 'ArrowDown', altKey: true });
    assert.equal(ev.defaultPrevented, true);
    assert.equal(area().value, '一\n二');
  });

  test('游標在空行上：不動', () => {
    open('chapters/004-空行.md', '一\n\n二', 'chapter');
    select(2);
    press({ key: 'ArrowDown', altKey: true });
    assert.equal(area().value, '一\n\n二');
  });

  test('Shift+Alt+↓：正文空行分段，在下方複製並空一行，游標落在新的那份', () => {
    style('blank');
    open('chapters/005-複製.md', '甲段\n\n乙段', 'chapter');
    select(1);
    press({ key: 'ArrowDown', altKey: true, shiftKey: true });
    assert.equal(area().value, '甲段\n\n甲段\n\n乙段');
    assert.equal(area().selectionStart, 5);
    undo();
    assert.equal(area().value, '甲段\n\n乙段');
  });

  test('Shift+Alt+↑：段首縮排時不空行，游標留在上面那份', () => {
    style('indent');
    open('chapters/006-複製.md', `${W}甲段\n${W}乙段`, 'chapter');
    select(3);
    press({ key: 'ArrowUp', altKey: true, shiftKey: true });
    assert.equal(area().value, `${W}甲段\n${W}甲段\n${W}乙段`);
    assert.equal(area().selectionStart, 3);
  });

  test('非正文複製：只隔一個換行', () => {
    style('blank');
    open('.novelwarden/characters/林昭.md', '- 甲\n- 乙', 'character');
    select(1);
    press({ key: 'ArrowDown', altKey: true, shiftKey: true });
    assert.equal(area().value, '- 甲\n- 甲\n- 乙');
  });

  test('Ctrl+Shift+K：正文空行分段時順帶刪一個相鄰的空行', () => {
    open('chapters/007-刪除.md', '甲段\n\n乙段\n\n丙段', 'chapter');
    select(5);
    const ev = press({ key: 'K', ctrlKey: true, shiftKey: true });
    assert.equal(ev.defaultPrevented, true);
    assert.equal(area().value, '甲段\n\n丙段');
    assert.equal(area().selectionStart, 4, '游標落在下一段的行首');
    undo();
    assert.equal(area().value, '甲段\n\n乙段\n\n丙段');
  });

  test('Ctrl+Shift+K 刪最後一段：前面的空行一起刪，不在文末留空行', () => {
    open('chapters/008-刪除.md', '甲段\n\n乙段', 'chapter');
    select(5);
    press({ key: 'k', ctrlKey: true, shiftKey: true });
    assert.equal(area().value, '甲段');
  });

  test('Ctrl+Shift+K：段首縮排時只刪這幾行', () => {
    style('indent');
    open('chapters/009-刪除.md', `${W}甲\n${W}乙\n${W}丙`, 'chapter');
    select(5, 9);
    press({ key: 'k', ctrlKey: true, shiftKey: true });
    assert.equal(area().value, `${W}甲`);
  });

  test('Ctrl+Shift+K：非正文只刪這一行', () => {
    style('blank');
    open('notes.md', '一\n\n二\n\n三');
    select(3);
    press({ key: 'k', ctrlKey: true, shiftKey: true });
    assert.equal(area().value, '一\n\n\n三');
  });

  test('Ctrl+Enter：在當前段下面另起一段（正文按分段格式）', () => {
    style('both');
    open('chapters/010-另起.md', `${W}他推開門。\n\n${W}她笑了。`, 'chapter');
    select(3);
    const ev = press({ key: 'Enter', ctrlKey: true });
    assert.equal(ev.defaultPrevented, true);
    assert.equal(area().value, `${W}他推開門。\n\n${W}\n\n${W}她笑了。`);
    assert.equal(area().selectionStart, 11);
    undo();
    assert.equal(area().value, `${W}他推開門。\n\n${W}她笑了。`);
  });

  test('Cmd+Enter 也認；非正文沿用縮排', () => {
    open('.novelwarden/outline.md', '  - 第一卷\n下一行', 'outline');
    select(2);
    press({ key: 'Enter', metaKey: true });
    assert.equal(area().value, '  - 第一卷\n  \n下一行');
    assert.equal(area().selectionStart, 10);
  });

  test('Mac 的 Cmd+Shift+K 也認', () => {
    open('notes2.md', '一\n二');
    select(0);
    press({ key: 'k', metaKey: true, shiftKey: true });
    assert.equal(area().value, '二');
  });
});
