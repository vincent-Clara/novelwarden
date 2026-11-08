/**
 * 內建編輯器：關標籤時問「儲存 / 不儲存 / 取消」（`editor/closing.ts` + `editor/dialog.ts`），以及「還原」
 * 「用編輯器內容強制儲存」的確認——編輯器裡不再用 `window.confirm`。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 三顆按鈕，焦點在「儲存」上；Enter 選它、Esc 取消、Tab 不出對話方塊 | 鍵盤可用；`window.confirm` 說不出「儲存」與「不儲存」的區別 |
 * | 「儲存」等回執才關；撞上衝突不關、衝突條留著 | 存沒存成要看後端，關早了衝突那一份就沒處取捨了 |
 * | 批次關閉合成一個對話方塊問一次，列出哪幾份 | 從前是每個髒標籤各彈一個原生框 |
 * | 還原 / 強制儲存兩顆按鈕，取消就什麼都不發 | 同一種對話方塊 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file } = require('../../helpers/dom');

function setup(scripts = ['editor.js']) {
  const ui = mount({ body: 'standalone', scripts, shims: ['clipboard', 'scrollIntoView', 'pointerCapture', 'fakeTimers'] });
  ui.window.confirm = () => {
    throw new Error('不該調 window.confirm');
  };
  const area = () => ui.doc.getElementById('edArea');
  const tabs = () => [...ui.panes()[0].querySelectorAll('.ed-tab')];
  const names = () => tabs().map((t) => t.querySelector('.ed-tab-name').textContent);
  const tabEl = (name) => tabs().find((t) => t.querySelector('.ed-tab-name').textContent === name);
  const type = (text) => {
    area().value = text;
    area().dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  };
  const open = (path, text, extra) => ui.post({ type: 'editorOpen', file: file(path, text, extra) });
  const keyOn = (target, k, extra = {}) =>
    target.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
  const saves = () => ui.sent.filter((m) => m.type === 'saveFile');
  const closeBtn = (name) => tabEl(name).querySelector('.ed-tab-close');
  return { ui, area, tabs, names, tabEl, type, open, keyOn, saves, closeBtn };
}

describe('關一個有未儲存修改的標籤', { skip: JSDOM_SKIP }, () => {
  let s;

  before(() => {
    s = setup();
    s.open('a.md', '甲');
    s.open('b.md', '乙');
  });

  test('沒改過的直接關，不問', () => {
    s.ui.clickEl(s.closeBtn('b.md'));
    assert.equal(s.ui.dialog(), null);
    assert.deepEqual(s.names(), ['a.md']);
  });

  test('改過的先問：取消 / 不儲存 / 儲存，焦點在「儲存」上', () => {
    s.type('甲，改了');
    s.ui.clickEl(s.closeBtn('a.md'));
    const dlg = s.ui.dialog();
    assert.ok(dlg, '沒有彈對話方塊');
    assert.equal(dlg.getAttribute('role'), 'dialog');
    assert.match(dlg.textContent, /「a\.md」有未儲存的修改/);
    assert.deepEqual(s.ui.dialogButtons(), ['取消', '不儲存', '儲存']);
    assert.equal(s.ui.doc.activeElement.textContent, '儲存');
  });

  test('取消：標籤留著，修改一個字不少', async () => {
    await s.ui.answer('取消');
    assert.equal(s.ui.dialog(), null);
    assert.deepEqual(s.names(), ['a.md']);
    assert.equal(s.area().value, '甲，改了');
  });

  test('Esc 等於取消', async () => {
    s.ui.clickEl(s.closeBtn('a.md'));
    s.keyOn(s.ui.doc.activeElement, 'Escape');
    await s.ui.flush();
    assert.equal(s.ui.dialog(), null);
    assert.deepEqual(s.names(), ['a.md']);
  });

  test('Tab 在幾顆按鈕之間繞，不出對話方塊', () => {
    s.ui.clickEl(s.closeBtn('a.md'));
    s.keyOn(s.ui.doc.activeElement, 'Tab');
    assert.equal(s.ui.doc.activeElement.textContent, '取消', '從最右的「儲存」往後繞回第一顆');
    s.keyOn(s.ui.doc.activeElement, 'Tab', { shiftKey: true });
    assert.equal(s.ui.doc.activeElement.textContent, '儲存');
  });

  test('對話方塊開著時 Ctrl+S 不往下傳', () => {
    const before = s.saves().length;
    s.keyOn(s.ui.doc.activeElement, 's', { ctrlKey: true });
    assert.equal(s.saves().length, before);
    assert.ok(s.ui.dialog());
  });

  test('Enter 選主按鈕「儲存」：發出儲存，回執回來之前標籤還在', async () => {
    s.keyOn(s.ui.doc.activeElement, 'Enter');
    await s.ui.flush();
    assert.equal(s.ui.dialog(), null);
    assert.equal(s.ui.last('saveFile').text, '甲，改了');
    assert.deepEqual(s.names(), ['a.md'], '還沒收到回執，不能關');
    assert.equal(s.ui.doc.getElementById('edStatusSave').textContent, '儲存中…');
  });

  test('回執回來才關', async () => {
    s.ui.post({ type: 'editorSaved', file: file('a.md', '甲，改了', { hash: 'h-a2' }) });
    await s.ui.flush();
    assert.deepEqual(s.names(), []);
  });

  test('「不儲存」：直接關，不發儲存', async () => {
    s.open('c.md', '丙');
    s.type('丙，改了');
    const before = s.saves().length;
    s.ui.clickEl(s.closeBtn('c.md'));
    await s.ui.answer('不儲存');
    assert.deepEqual(s.names(), []);
    assert.equal(s.saves().length, before);
  });
});

describe('「儲存」撞上衝突就不關', { skip: JSDOM_SKIP }, () => {
  let s;

  before(() => {
    s = setup();
    s.open('a.md', '甲');
    s.type('甲，改了');
    s.open('b.md', '乙');
  });

  test('點了儲存、回來的是衝突：標籤留著，切過去掛著衝突條', async () => {
    // 從另一個標籤上關 a（右鍵「關閉」也是同一條路）：先切回 a 再點它的叉。
    s.ui.clickEl(s.closeBtn('a.md'));
    await s.ui.answer('儲存');
    s.ui.post({ type: 'editorConflict', path: 'a.md', diskText: '甲（磁碟）', diskHash: 'h-disk' });
    await s.ui.flush();
    assert.deepEqual(s.names(), ['a.md', 'b.md']);
    assert.equal(s.ui.panes()[0].querySelector('.ed-tab.active .ed-tab-name').textContent, 'a.md');
    assert.equal(s.ui.doc.getElementById('edConflict').classList.contains('hidden'), false);
    assert.equal(s.area().value, '甲，改了');
  });

  test('出錯（比如越界、太大）也不關', async () => {
    s.ui.clickEl(s.closeBtn('a.md'));
    await s.ui.answer('儲存');
    s.ui.post({ type: 'editorError', path: 'a.md', message: '內容超過大小上限，未寫入。' });
    await s.ui.flush();
    assert.deepEqual(s.names(), ['a.md', 'b.md']);
  });

  test('等回執的工夫裡又改了：存成了也不關（關了那幾筆就沒了）', async () => {
    s.ui.clickEl(s.tabEl('a.md'));
    s.ui.clickEl(s.closeBtn('a.md'));
    await s.ui.answer('儲存');
    const sent = s.ui.last('saveFile').text;
    s.type(`${sent}又一筆`);
    s.ui.post({ type: 'editorSaved', file: file('a.md', sent, { hash: 'h-a3' }) });
    await s.ui.flush();
    assert.ok(s.names().includes('a.md'));
  });
});

describe('批次關閉合成一個對話方塊', { skip: JSDOM_SKIP }, () => {
  let s;

  before(() => {
    s = setup(['view.js', 'editor.js']);
    s.open('a.md', '甲');
    s.open('b.md', '乙');
    s.type('乙，改了');
    s.open('c.md', '丙');
    s.type('丙，改了');
    s.open('d.md', '丁');
  });

  const closeOthersOf = (name) => {
    const menu = s.ui.rightClick(s.tabEl(name));
    const label = s.ui.itemsOf(menu).find((l) => l.startsWith('關閉其它'));
    s.ui.pick(menu, label);
  };

  test('關閉其它：只彈一個對話方塊，列出沒儲存的那幾份', () => {
    closeOthersOf('a.md');
    const dlgs = s.ui.doc.querySelectorAll('.ed-dialog');
    assert.equal(dlgs.length, 1);
    assert.match(dlgs[0].textContent, /這 2 份有未儲存的修改/);
    const items = [...dlgs[0].querySelectorAll('.ed-dialog-list li')].map((li) => li.textContent);
    assert.deepEqual(items, ['b.md', 'c.md']);
    assert.deepEqual(s.ui.dialogButtons(), ['取消', '全部不儲存', '全部儲存']);
  });

  test('取消：一個都不關（沒改過的也不關）', async () => {
    await s.ui.answer('取消');
    assert.deepEqual(s.names(), ['a.md', 'b.md', 'c.md', 'd.md']);
  });

  test('全部儲存：兩份各發一次儲存，沒改過的那份先不關', async () => {
    closeOthersOf('a.md');
    const before = s.saves().length;
    await s.ui.answer('全部儲存');
    const sent = s.saves().slice(before);
    assert.deepEqual(sent.map((m) => m.path), ['b.md', 'c.md']);
    assert.deepEqual(s.names(), ['a.md', 'b.md', 'c.md', 'd.md']);
  });

  test('一份存成、一份撞衝突：存成的與沒改過的關掉，衝突的留著', async () => {
    s.ui.post({ type: 'editorSaved', file: file('b.md', '乙，改了', { hash: 'h-b2' }) });
    s.ui.post({ type: 'editorConflict', path: 'c.md', diskText: '丙（磁碟）', diskHash: 'h-c-disk' });
    await s.ui.flush();
    assert.deepEqual(s.names(), ['a.md', 'c.md']);
  });

  test('全部不儲存：一下都關掉', async () => {
    s.open('e.md', '戊');
    s.type('戊，改了');
    s.ui.clickEl(s.tabEl('a.md'));
    closeOthersOf('a.md');
    assert.deepEqual(
      [...s.ui.dialog().querySelectorAll('.ed-dialog-list li')].map((li) => li.textContent),
      ['c.md', 'e.md']
    );
    await s.ui.answer('全部不儲存');
    assert.deepEqual(s.names(), ['a.md']);
  });
});

describe('Ctrl+W 與「檔案 → 關閉編輯器」同樣先問', { skip: JSDOM_SKIP }, () => {
  test('Ctrl+W 關有修改的標籤彈三選一', async () => {
    const s = setup();
    s.open('a.md', '甲');
    s.type('甲，改了');
    s.keyOn(s.area(), 'w', { ctrlKey: true });
    assert.deepEqual(s.ui.dialogButtons(), ['取消', '不儲存', '儲存']);
    // 連按兩下不疊第二個對話方塊。
    s.keyOn(s.area(), 'w', { ctrlKey: true });
    assert.equal(s.ui.doc.querySelectorAll('.ed-dialog').length, 1);
    await s.ui.answer('取消');
    assert.deepEqual(s.names(), ['a.md']);
  });

  test('「關閉編輯器」命令也一樣', async () => {
    const s = setup();
    s.open('a.md', '甲');
    s.type('甲，改了');
    s.ui.window.dispatchEvent(new s.ui.window.CustomEvent('nf-editor-command', { detail: { name: 'close' } }));
    assert.ok(s.ui.dialog());
    await s.ui.answer('不儲存');
    assert.deepEqual(s.names(), []);
  });
});

describe('「還原」與「用編輯器內容強制儲存」的確認', { skip: JSDOM_SKIP }, () => {
  let s;

  before(() => {
    s = setup();
    s.open('a.md', '甲');
    s.type('甲，改了');
  });

  test('還原：兩顆按鈕，取消就不發 reloadFile', async () => {
    s.ui.clickEl(s.ui.doc.getElementById('edRevertBtn'));
    assert.deepEqual(s.ui.dialogButtons(), ['取消', '放棄修改']);
    await s.ui.answer('取消');
    assert.equal(s.ui.last('reloadFile'), undefined);
    assert.equal(s.area().value, '甲，改了');
  });

  test('還原：點「放棄修改」才發', async () => {
    s.ui.clickEl(s.ui.doc.getElementById('edRevertBtn'));
    await s.ui.answer('放棄修改');
    assert.equal(s.ui.last('reloadFile').path, 'a.md');
  });

  test('沒改過時點還原不問', () => {
    const r = setup();
    r.open('a.md', '甲');
    r.ui.clickEl(r.ui.doc.getElementById('edRevertBtn'));
    assert.equal(r.ui.dialog(), null);
    assert.ok(r.ui.last('reloadFile'));
  });

  test('強制儲存：兩顆按鈕，取消就什麼都不發', async () => {
    s.ui.post({ type: 'editorOpen', file: file('a.md', '甲', { hash: 'h-a' }) });
    s.type('甲，又改了');
    s.keyOn(s.area(), 's', { ctrlKey: true });
    s.ui.post({ type: 'editorConflict', path: 'a.md', diskText: '甲（磁碟）', diskHash: 'h-disk' });
    const before = s.saves().length;
    s.ui.clickEl(s.ui.doc.getElementById('edConflictForce'));
    assert.deepEqual(s.ui.dialogButtons(), ['取消', '覆蓋磁碟上的版本']);
    await s.ui.answer('取消');
    assert.equal(s.saves().length, before);
  });

  test('強制儲存：確認之後發不帶基線的儲存', async () => {
    s.ui.clickEl(s.ui.doc.getElementById('edConflictForce'));
    await s.ui.answer('覆蓋磁碟上的版本');
    const msg = s.ui.last('saveFile');
    assert.equal(msg.baseHash, undefined);
    assert.equal(msg.text, '甲，又改了');
  });

  test('關掉之後焦點回到開啟之前的地方', async () => {
    s.ui.post({ type: 'editorSaved', file: file('a.md', '甲，又改了', { hash: 'h-a9' }) });
    s.type('再改一筆');
    s.area().focus();
    s.ui.clickEl(s.ui.doc.getElementById('edRevertBtn'));
    assert.notEqual(s.ui.doc.activeElement, s.area());
    await s.ui.answer('取消');
    assert.equal(s.ui.doc.activeElement, s.area());
  });
});
