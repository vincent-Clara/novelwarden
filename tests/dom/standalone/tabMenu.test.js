/**
 * 標籤右鍵選單裡關閉類之後的那幾項（獨立版內建編輯器，`editor/tabMenu.ts`）。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 選單項 | 關閉類之後依次是「移到另一側」「在檔案頁中定位」「複製相對路徑」「重新開啟剛關閉的」；「固定」只有臨時標籤有 |
 * | 移到另一側 | 連同未儲存內容與撤銷歷史搬過去（Ctrl+Z 在那邊退得回去），不經後端（不發 openEditor），原來那塊不再有它；儲存的基線不變 |
 * | 一個路徑只屬於一塊 | 搬過去之後儲存回執、磁碟核對都落在新的那一塊 |
 * | 衝突條跟著走 | 搬之前掛著的衝突條搬過去還掛著 |
 * | 搬回來 | 右邊空了就整塊收起 |
 * | 在檔案頁中定位 | 切到「檔案」頁、展開到它、那一行標出來 |
 * | 複製相對路徑 | 寫進剪貼簿 |
 * | 重新開啟剛關閉的 | 按塊記：右邊關掉的只在右邊的選單裡，點了按原來那一塊重新開啟；沒有時置灰 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file, listing } = require('../../helpers/dom');

describe('標籤右鍵：移到另一側', { skip: JSDOM_SKIP }, () => {
  let ui;
  const main = () => ui.panes()[0];
  const right = () => ui.panes()[1];
  const tabIn = (pane, name) => [...pane.querySelectorAll('.ed-tab')].find((t) => t.textContent.includes(name));
  const areaOf = (pane) => pane.querySelector('textarea');
  /** 貼上進來一段（貼上各自一步撤銷，不與前後並）。 */
  const type = (area, text) => {
    area.focus();
    area.value = text;
    area.selectionStart = area.selectionEnd = text.length;
    area.dispatchEvent(new ui.window.InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
  };
  const menuOf = (tab) => ui.rightClick(tab);
  const itemStartingWith = (menu, prefix) => [...menu.querySelectorAll('button')].find((b) => b.textContent.startsWith(prefix));

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'] });
    ui.post({ type: 'editorOpen', file: file('chapters/001-楔子.md', '原文') });
    ui.post({ type: 'editorOpen', file: file('notes.md', '筆記') });
    ui.clickEl(tabIn(main(), '001-楔子'));
    type(areaOf(main()), '原文，改了一筆');
    type(areaOf(main()), '原文，改了一筆，又一筆');
  });

  test('關閉類之後依次是移到另一側、定位、複製路徑、重新開啟', () => {
    const items = ui.itemsOf(menuOf(tabIn(main(), '001-楔子')));
    const at = (prefix) => items.findIndex((l) => l.startsWith(prefix));
    assert.ok(at('關閉其它') >= 0, JSON.stringify(items));
    assert.ok(at('關閉其它') < at('移到另一側'), JSON.stringify(items));
    assert.ok(at('移到另一側') < at('在檔案頁中定位'), JSON.stringify(items));
    assert.ok(at('在檔案頁中定位') < at('複製相對路徑'), JSON.stringify(items));
    assert.ok(at('複製相對路徑') < at('重新開啟剛關閉的'), JSON.stringify(items));
    assert.equal(items[at('移到另一側')], '移到另一側（右側）');
    ui.closeMenu();
  });

  test('沒關過東西：「重新開啟剛關閉的」置灰', () => {
    const menu = menuOf(tabIn(main(), '001-楔子'));
    assert.equal(itemStartingWith(menu, '重新開啟剛關閉的').disabled, true);
    ui.closeMenu();
  });

  test('移到另一側：右邊那一塊出來，帶著未儲存的內容，不經後端', () => {
    ui.sent.length = 0;
    ui.clickEl(itemStartingWith(menuOf(tabIn(main(), '001-楔子')), '移到另一側'));
    assert.equal(ui.panes().length, 2);
    assert.ok(!right().classList.contains('hidden'));
    assert.equal(areaOf(right()).value, '原文，改了一筆，又一筆');
    assert.ok(tabIn(right(), '001-楔子').classList.contains('dirty'));
    assert.equal(ui.sent.filter((m) => m.type === 'openEditor').length, 0);
  });

  test('原來那一塊不再有它（一個路徑只屬於一塊）', () => {
    assert.equal(tabIn(main(), '001-楔子'), undefined);
    assert.ok(tabIn(main(), 'notes.md'));
  });

  test('撤銷歷史跟著搬：在右邊 Ctrl+Z 退回上一步', () => {
    const area = areaOf(right());
    area.focus();
    area.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    assert.equal(area.value, '原文，改了一筆');
  });

  test('儲存帶的還是原來的基線（不是強制儲存）', () => {
    ui.sent.length = 0;
    ui.doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
    const save = ui.last('saveFile');
    assert.deepEqual({ path: save.path, baseHash: save.baseHash }, { path: 'chapters/001-楔子.md', baseHash: 'h-chapters/001-楔子.md' });
  });

  test('儲存回執落在右邊那一塊', () => {
    ui.post({ type: 'editorSaved', file: file('chapters/001-楔子.md', '原文，改了一筆', { hash: 'h-saved' }) });
    assert.ok(!tabIn(right(), '001-楔子').classList.contains('dirty'));
  });

  test('搬回來：右邊空了就整塊收起', () => {
    ui.clickEl(itemStartingWith(menuOf(tabIn(right(), '001-楔子')), '移到另一側'));
    assert.ok(tabIn(main(), '001-楔子'));
    assert.ok(right().classList.contains('hidden'));
    assert.ok(ui.doc.getElementById('wbDraftResizer').classList.contains('hidden'));
  });
});

describe('標籤右鍵：衝突條跟著搬', { skip: JSDOM_SKIP }, () => {
  test('改過的標籤撞上磁碟新版，搬到右邊衝突條還掛著', () => {
    const ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: ['pointerCapture', 'confirm', 'scrollIntoView'] });
    ui.post({ type: 'editorOpen', file: file('a.md', '原文') });
    const area = ui.doc.getElementById('edArea');
    area.value = '原文，改了';
    area.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    ui.post({ type: 'editorDiskChanged', file: file('a.md', '磁碟上的新版', { hash: 'h-disk' }) });
    const tab = ui.doc.querySelector('.ed-tab');
    assert.ok(tab.classList.contains('conflict'));
    const menu = ui.rightClick(tab);
    ui.clickEl([...menu.querySelectorAll('button')].find((b) => b.textContent.startsWith('移到另一側')));
    const right = ui.panes()[1];
    assert.ok(right.querySelector('.ed-tab').classList.contains('conflict'));
    assert.ok(!right.querySelector('.ed-conflict').classList.contains('hidden'));
  });
});

describe('標籤右鍵：定位、複製路徑、重新開啟', { skip: JSDOM_SKIP }, () => {
  let ui;
  const copied = [];
  const tabIn = (pane, name) => [...pane.querySelectorAll('.ed-tab')].find((t) => t.textContent.includes(name));
  const item = (menu, prefix) => [...menu.querySelectorAll('button')].find((b) => b.textContent.startsWith(prefix));

  before(() => {
    ui = mount({
      body: 'standalone',
      scripts: ['view.js', 'editor.js', 'explorer.js'],
      shims: ['pointerCapture', 'confirm', 'scrollIntoView'],
    });
    ui.window.navigator.clipboard = { writeText: (t) => (copied.push(t), Promise.resolve()) };
    ui.post({ type: 'editorOpen', file: file('chapters/第一卷/003-夜訪.md', '正文') });
    ui.post({ type: 'editorOpen', file: file('notes.md', '筆記') });
    ui.post({ type: 'editorOpen', file: file('.novelwarden/summaries/003-夜訪.md', '細綱'), pane: 'draft' });
    ui.post({ type: 'editorOpen', file: file('drafts/003-夜訪.md', '草稿'), pane: 'draft' });
  });

  test('在檔案頁中定位：切到「檔案」頁，展開到它所在的目錄', () => {
    ui.sent.length = 0;
    ui.clickEl(item(ui.rightClick(tabIn(ui.panes()[0], '003-夜訪')), '在檔案頁中定位'));
    assert.ok(ui.doc.getElementById('pane-files').classList.contains('active'));
    const dirs = ui.last('listDir').dirs;
    assert.ok(dirs.includes('chapters') && dirs.includes('chapters/第一卷'), JSON.stringify(dirs));
    assert.ok(!dirs.includes('chapters/第一卷/003-夜訪.md'), '把檔案當成目錄展開了');
  });

  test('目錄列出來之後，那個檔案的那一行標出來', () => {
    ui.post({ type: 'dirListings', listings: [
      listing('', { chapters: 'dir' }),
      listing('chapters', { 第一卷: 'dir' }),
      listing('chapters/第一卷', { '003-夜訪.md': 'file' }),
    ] });
    const row = ui.doc.querySelector('#filesBody .fx-row.fx-revealed');
    assert.equal(row?.dataset.path, 'chapters/第一卷/003-夜訪.md');
  });

  test('複製相對路徑：寫進剪貼簿', () => {
    ui.clickEl(item(ui.rightClick(tabIn(ui.panes()[0], 'notes')), '複製相對路徑'));
    assert.deepEqual(copied, ['notes.md']);
  });

  test('重新開啟剛關閉的：按塊記，帶著名字', async () => {
    // 關掉右邊的草稿（沒改過，直接關）。
    ui.clickEl(ui.panes()[1].querySelector('.ed-tab[data-path="drafts/003-夜訪.md"] .ed-tab-close'));
    await ui.flush();
    const leftItem = item(ui.rightClick(tabIn(ui.panes()[0], 'notes')), '重新開啟剛關閉的');
    assert.equal(leftItem.disabled, true, '左邊沒關過東西');
    ui.closeMenu();
    const rightItem = item(ui.rightClick(tabIn(ui.panes()[1], '003-夜訪')), '重新開啟剛關閉的');
    assert.equal(rightItem.disabled, false);
    assert.match(rightItem.textContent, /003-夜訪/);
    ui.sent.length = 0;
    ui.clickEl(rightItem);
    const msg = ui.last('openEditor');
    assert.deepEqual({ path: msg.path, pane: msg.pane }, { path: 'drafts/003-夜訪.md', pane: 'draft' });
  });

  test('重新開啟之後不再列著它', () => {
    ui.post({ type: 'editorOpen', file: file('drafts/003-夜訪.md', '草稿'), pane: 'draft' });
    const rightItem = item(ui.rightClick(tabIn(ui.panes()[1], '003-夜訪')), '重新開啟剛關閉的');
    assert.equal(rightItem.disabled, true);
    ui.closeMenu();
  });
});
