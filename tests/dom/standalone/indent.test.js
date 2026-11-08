/**
 * 內建編輯器的 Tab / Shift+Tab 縮排。
 *
 * 從前選中一段按 Tab，整段被換成兩個空格（`value.slice(0, start) + '  ' + value.slice(end)`），
 * 而且斷撤銷。現在：
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 縮排單位 | 正文（kind 是 chapter / draft）兩個全形空格，其餘檔案兩個半形空格，沒給 kind 當非正文 |
 * | 選中一行裡的幾個字按 Tab | **字不丟**，行首加一級，選區跟著平移 |
 * | 選中多行按 Tab | 每行行首加一級、空行跳過，選區仍覆蓋這幾行；止於下一行行首時那一行不算 |
 * | Shift+Tab | 每行去一級（全形兩個 / 單個全形 / 兩個半形 / 一個半形 / \t），沒有選區就是游標那一行 |
 * | 撤銷 | 一次按鍵一步 |
 * | 輸入法組字 | 組字時的 Tab 放行給輸入法，不處理 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file } = require('../../helpers/dom');

const W = '　';

describe('Tab 縮排', { skip: JSDOM_SKIP }, () => {
  let ui;
  const area = () => ui.doc.getElementById('edArea');
  const open = (path, text, kind) =>
    ui.post({ type: 'editorOpen', file: file(path, text, kind ? { kind } : undefined) });
  const press = (init) => {
    const ev = new ui.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    area().dispatchEvent(ev);
    return ev;
  };
  const tab = () => press({ key: 'Tab' });
  const shiftTab = () => press({ key: 'Tab', shiftKey: true });
  const select = (start, end = start) => area().setSelectionRange(start, end);
  const selected = () => area().value.slice(area().selectionStart, area().selectionEnd);

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['editor.js'], shims: ['pointerCapture', 'confirm'] });
  });

  test('正文：沒有選區時在游標處插兩個全形空格', () => {
    open('chapters/001-雨夜.md', '雨夜。', 'chapter');
    select(0);
    const ev = tab();
    assert.equal(ev.defaultPrevented, true, 'Tab 不能切走焦點');
    assert.equal(area().value, `${W}${W}雨夜。`);
    assert.equal(area().selectionStart, 2);
  });

  test('草稿也是正文', () => {
    open('drafts/001-雨夜.md', '草稿', 'draft');
    select(0);
    tab();
    assert.equal(area().value, `${W}${W}草稿`);
  });

  test('角色卡等 Markdown：兩個半形空格', () => {
    open('.novelwarden/characters/林昭.md', '- 身份', 'character');
    select(0);
    tab();
    assert.equal(area().value, '  - 身份');
  });

  test('後端沒給 kind：當非正文，用半形', () => {
    open('notes.txt', '隨手記');
    select(0);
    tab();
    assert.equal(area().value, '  隨手記');
  });

  test('選中一行裡的幾個字按 Tab：字不丟，行首加一級，選區跟著平移', () => {
    open('chapters/002-入鎮.md', '林昭推開客棧的門。\n第二行', 'chapter');
    select(2, 6);
    assert.equal(selected(), '推開客棧');
    tab();
    assert.equal(area().value, `${W}${W}林昭推開客棧的門。\n第二行`);
    assert.equal(selected(), '推開客棧', '選區仍是那幾個字');
  });

  test('選中多行按 Tab：每行加一級，空行跳過，選區仍覆蓋這幾行', () => {
    open('chapters/003-夜訪.md', '第一段\n\n第二段\n第三段', 'chapter');
    select(0, '第一段\n\n第二段'.length);
    tab();
    assert.equal(area().value, `${W}${W}第一段\n\n${W}${W}第二段\n第三段`);
    assert.equal(selected(), `${W}${W}第一段\n\n${W}${W}第二段`, '從行首起選的，新縮排算進選區');
  });

  test('選區止於下一行行首：那一行不縮排', () => {
    open('chapters/004-北行.md', '甲\n乙\n丙', 'chapter');
    select(0, '甲\n'.length);
    tab();
    assert.equal(area().value, `${W}${W}甲\n乙\n丙`);
  });

  test('一次按鍵一步撤銷', () => {
    open('chapters/005-赤星.md', '一\n二\n三', 'chapter');
    select(0, area().value.length);
    tab();
    assert.equal(area().value, `${W}${W}一\n${W}${W}二\n${W}${W}三`);
    press({ key: 'z', ctrlKey: true });
    assert.equal(area().value, '一\n二\n三');
    assert.equal(area().selectionStart, 0);
    assert.equal(area().selectionEnd, area().value.length, '撤銷後選區回到按 Tab 之前');
  });

  test('Shift+Tab：每行去一級，認全形兩個 / 單個全形 / 兩個半形 / 一個半形 / \\t', () => {
    const text = [`${W}${W}${W}甲`, `${W}乙`, '   丙', ' 丁', '\t戊', '己'].join('\n');
    open('chapters/006-去縮排.md', text, 'chapter');
    select(0, text.length);
    shiftTab();
    assert.equal(area().value, [`${W}甲`, '乙', ' 丙', '丁', '戊', '己'].join('\n'), '每行最多去一級');
    assert.equal(area().selectionStart, 0);
    assert.equal(area().selectionEnd, area().value.length);
  });

  test('Shift+Tab 沒有選區：去游標所在那一行的一級，游標跟著挪', () => {
    open('chapters/007-一行.md', `甲\n${W}${W}乙丙\n丁`, 'chapter');
    select(`甲\n${W}${W}乙`.length);
    shiftTab();
    assert.equal(area().value, '甲\n乙丙\n丁');
    assert.equal(area().selectionStart, '甲\n乙'.length);
  });

  test('Shift+Tab 行首沒有縮排：什麼都不動，也不記撤銷', () => {
    open('chapters/008-無縮排.md', '甲乙', 'chapter');
    select(1);
    shiftTab();
    assert.equal(area().value, '甲乙');
    press({ key: 'z', ctrlKey: true });
    assert.equal(area().value, '甲乙');
  });

  test('輸入法組字時的 Tab 放行給輸入法，不處理', () => {
    open('chapters/009-組字.md', '雨夜', 'chapter');
    select(0);
    const ev = press({ key: 'Tab', isComposing: true });
    assert.equal(ev.defaultPrevented, false);
    assert.equal(area().value, '雨夜');
    const old = press({ key: 'Tab', keyCode: 229 });
    assert.equal(old.defaultPrevented, false, '老瀏覽器組字時 keyCode 是 229');
    assert.equal(area().value, '雨夜');
  });
});
