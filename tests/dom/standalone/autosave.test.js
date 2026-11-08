/**
 * 內建編輯器：儲存狀態（`editor/saving.ts`）與自動儲存（`editor/autosave.ts`）。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 「● 未儲存」→「儲存中…」→「已儲存 14:32」，存成了不彈 toast，衝突照樣彈 | 從前每次 Ctrl+S 都彈「已儲存 路徑」 |
 * | 發出去 10 秒沒回音說一句 | 斷線時訊息在 bridge 的 outbox 裡等重連，作者得知道還沒存上 |
 * | 同一份同一時刻只有一個儲存在路上，期間又改了等回執後再存一次 | 兩個儲存同時在路上，後一個帶的是過期的基線，必撞假衝突 |
 * | 自動儲存預設關，「檔案 → 自動儲存」打 ✓，狀態列標出來 | 正文一儲存，定稿過的章就回到「待定稿」，得是作者自己選的 |
 * | 停筆 2 秒（組字中不算）、切走標籤、視窗失焦 / 頁面藏起來時儲存 | 三個時機 |
 * | 撞上衝突就停止自動儲存這一份，直到衝突解決；磁碟上沒了的不存；對話方塊開著不存 | 絕不強制儲存、絕不靜默重建、不搶在作者決定之前 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file } = require('../../helpers/dom');

function setup(scripts = ['editor.js']) {
  const ui = mount({ body: 'standalone', scripts, shims: ['clipboard', 'scrollIntoView', 'pointerCapture', 'fakeTimers'] });
  const toasts = [];
  // view.js 沒裝時 editor 的 toast 落到這裡；裝了的話也換成記錄，好斷言。
  ui.window.__nfToast = (message, isError) => toasts.push({ message, isError: !!isError });
  const area = () => ui.doc.getElementById('edArea');
  const tabEl = (name) =>
    [...ui.panes()[0].querySelectorAll('.ed-tab')].find((t) => t.querySelector('.ed-tab-name').textContent === name);
  const type = (text) => {
    area().value = text;
    area().dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  };
  const key = (k, extra = {}) =>
    area().dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
  const saves = () => ui.sent.filter((m) => m.type === 'saveFile');
  const status = () => ui.doc.getElementById('edStatusSave').textContent;
  const flag = () => ui.panes()[0].querySelector('.ed-status .ed-autosave');
  const tick = (ms) => ui.window.__clock.tick(ms);
  const toggleAutoSave = () =>
    ui.window.dispatchEvent(new ui.window.CustomEvent('nf-editor-command', { detail: { name: 'toggleAutoSave' } }));
  const saved = (path, text, hash) => ui.post({ type: 'editorSaved', file: file(path, text, { hash }) });
  return { ui, toasts, area, tabEl, type, key, saves, status, flag, tick, toggleAutoSave, saved };
}

describe('儲存狀態', { skip: JSDOM_SKIP }, () => {
  let s;

  before(() => {
    s = setup();
    s.ui.post({ type: 'editorOpen', file: file('a.md', '甲', { hash: 'h0' }) });
  });

  test('這次會話還沒存過：「已儲存」', () => {
    assert.equal(s.status(), '已儲存');
  });

  test('改了：「● 未儲存」', () => {
    s.type('甲，改了');
    assert.match(s.status(), /^● 未儲存/);
  });

  test('發出去：「儲存中…」', () => {
    s.key('s', { ctrlKey: true });
    assert.equal(s.saves().length, 1);
    assert.equal(s.status(), '儲存中…');
  });

  test('回執到了：「已儲存 時:分」，不彈 toast', () => {
    s.saved('a.md', '甲，改了', 'h1');
    assert.match(s.status(), /^已儲存 \d\d:\d\d$/);
    assert.equal(s.toasts.length, 0);
  });

  test('發出去 10 秒沒迴音：說一句', () => {
    s.type('甲，又改了');
    s.key('s', { ctrlKey: true });
    s.tick(9999);
    assert.equal(s.status(), '儲存中…');
    s.tick(1);
    assert.match(s.status(), /還沒收到迴音/);
    assert.match(s.ui.doc.getElementById('edStatusSave').title, /連線斷了的話/);
  });

  test('迴音終於到了：照常「已儲存」', () => {
    s.saved('a.md', '甲，又改了', 'h2');
    assert.match(s.status(), /^已儲存 \d\d:\d\d$/);
  });

  test('衝突照樣彈 toast', () => {
    s.type('甲，第三版');
    s.key('s', { ctrlKey: true });
    s.ui.post({ type: 'editorConflict', path: 'a.md', diskText: '甲（磁碟）', diskHash: 'h-disk' });
    assert.equal(s.toasts.length, 1);
    assert.equal(s.toasts[0].isError, true);
    assert.match(s.status(), /^● 未儲存/);
  });

  test('出錯照樣彈 toast（index.ts 那條），狀態列不再「儲存中」', () => {
    const t = setup();
    t.ui.post({ type: 'editorOpen', file: file('a.md', '甲') });
    t.type('甲，改了');
    t.key('s', { ctrlKey: true });
    t.ui.post({ type: 'editorError', path: 'a.md', message: '內容超過大小上限，未寫入。' });
    assert.equal(t.toasts.at(-1).message, '內容超過大小上限，未寫入。');
    assert.match(t.status(), /^● 未儲存/);
  });

  test('儲存期間又打了字：回執之後照實寫「未儲存」', () => {
    const t = setup();
    t.ui.post({ type: 'editorOpen', file: file('a.md', '甲', { hash: 'h0' }) });
    t.type('甲，改了');
    t.key('s', { ctrlKey: true });
    t.type('甲，改了，又打了幾個字');
    t.saved('a.md', '甲，改了', 'h1');
    assert.match(t.status(), /^● 未儲存/);
  });
});

describe('同一份同一時刻只有一個儲存在路上', { skip: JSDOM_SKIP }, () => {
  let s;

  before(() => {
    s = setup();
    s.ui.post({ type: 'editorOpen', file: file('a.md', '甲', { hash: 'h0' }) });
    s.type('甲，改了');
    s.key('s', { ctrlKey: true });
  });

  test('回執回來之前再按 Ctrl+S 不發第二個', () => {
    s.type('甲，改了，又改了');
    s.key('s', { ctrlKey: true });
    assert.equal(s.saves().length, 1);
  });

  test('回執是「存成了」而還有沒存上的修改：接著再存一次，帶新的基線', () => {
    s.saved('a.md', '甲，改了', 'h1');
    assert.equal(s.saves().length, 2);
    assert.equal(s.saves()[1].baseHash, 'h1');
    assert.equal(s.saves()[1].text, '甲，改了，又改了');
  });

  test('撞上衝突就不再接著存', () => {
    s.type('甲，改了，又改了，第三次');
    s.key('s', { ctrlKey: true });
    assert.equal(s.saves().length, 2, '第二個還在路上');
    s.ui.post({ type: 'editorConflict', path: 'a.md', diskText: '甲（磁碟）', diskHash: 'h-disk' });
    assert.equal(s.saves().length, 2);
  });
});

describe('自動儲存：開關', { skip: JSDOM_SKIP }, () => {
  let s;
  const fileMenu = () => {
    s.ui.clickEl(s.ui.doc.querySelector('[data-menu="file"]'));
    return [...s.ui.doc.querySelectorAll('.wb-menu-drop .wb-menu-item')];
  };
  const autoItem = () => fileMenu().find((b) => b.querySelector('.wb-menu-label')?.textContent === '自動儲存');

  before(() => {
    s = setup(['view.js', 'editor.js']);
    s.ui.window.__nfToast = () => {};
    s.ui.post({ type: 'editorOpen', file: file('a.md', '甲', { hash: 'h0' }) });
  });

  test('「檔案」選單裡「自動儲存」緊跟在「全部儲存」後面', () => {
    const labels = fileMenu().map((b) => b.querySelector('.wb-menu-label')?.textContent);
    s.ui.closeMenu();
    assert.equal(labels[labels.indexOf('全部儲存') + 1], '自動儲存');
  });

  test('預設關：沒有 ✓，狀態列不掛「自動儲存」，停筆也不存', () => {
    const item = autoItem();
    assert.equal(item.getAttribute('aria-checked'), 'false');
    s.ui.closeMenu();
    assert.equal(s.flag(), null);
    s.type('甲，改了');
    s.tick(5000);
    assert.equal(s.saves().length, 0);
  });

  test('點一下開啟：打 ✓，狀態列掛「自動儲存」', () => {
    s.ui.clickEl(autoItem());
    const item = autoItem();
    assert.equal(item.getAttribute('aria-checked'), 'true');
    assert.equal(item.querySelector('.wb-menu-check').textContent, '✓');
    s.ui.closeMenu();
    assert.equal(s.flag()?.textContent, '自動儲存');
  });

  test('再點一下關掉：✓ 與狀態列那一枚都沒了', () => {
    s.ui.clickEl(autoItem());
    assert.equal(autoItem().getAttribute('aria-checked'), 'false');
    s.ui.closeMenu();
    assert.equal(s.flag(), null);
  });
});

describe('自動儲存：三個時機', { skip: JSDOM_SKIP }, () => {
  let s;

  before(() => {
    s = setup();
    s.ui.post({ type: 'editorOpen', file: file('a.md', '甲', { hash: 'ha' }) });
    s.ui.post({ type: 'editorOpen', file: file('b.md', '乙', { hash: 'hb' }) });
    s.toggleAutoSave();
  });

  test('停筆 2 秒存那一份，照樣帶基線', () => {
    s.type('乙，改了');
    s.tick(1999);
    assert.equal(s.saves().length, 0);
    s.tick(1);
    assert.equal(s.saves().length, 1);
    assert.equal(s.saves()[0].path, 'b.md');
    assert.equal(s.saves()[0].baseHash, 'hb');
    s.saved('b.md', '乙，改了', 'hb2');
  });

  test('一直在打字就一直不存', () => {
    for (let i = 0; i < 5; i++) {
      s.type(`乙，改了${'。'.repeat(i + 1)}`);
      s.tick(1500);
    }
    assert.equal(s.saves().length, 1);
    s.tick(500);
    assert.equal(s.saves().length, 2);
    s.saved('b.md', s.saves()[1].text, 'hb3');
  });

  test('輸入法組字中途不算停筆，上屏之後重新計時', () => {
    const a = s.area();
    a.dispatchEvent(new s.ui.window.CompositionEvent('compositionstart', { bubbles: true }));
    a.value = `${a.value}lin`;
    a.dispatchEvent(new s.ui.window.InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', isComposing: true }));
    s.tick(5000);
    assert.equal(s.saves().length, 2, '組字中途存了');
    a.value = a.value.replace(/lin$/, '林');
    a.dispatchEvent(new s.ui.window.CompositionEvent('compositionend', { bubbles: true, data: '林' }));
    s.tick(1999);
    assert.equal(s.saves().length, 2);
    s.tick(1);
    assert.equal(s.saves().length, 3);
    assert.match(s.saves()[2].text, /林$/);
    s.saved('b.md', s.saves()[2].text, 'hb4');
  });

  test('切走一個標籤時存它', () => {
    s.type('乙，切走之前改的');
    s.ui.clickEl(s.tabEl('a.md'));
    assert.equal(s.saves().length, 4);
    assert.equal(s.saves()[3].path, 'b.md');
    s.saved('b.md', '乙，切走之前改的', 'hb5');
  });

  test('視窗失去焦點時存全部有修改的', () => {
    s.type('甲，改了');
    s.ui.clickEl(s.tabEl('b.md'));
    s.saved('a.md', '甲，改了', 'ha2');
    s.type('乙，又改了');
    s.ui.clickEl(s.tabEl('a.md'));
    s.saved('b.md', '乙，又改了', 'hb6');
    s.type('甲，失焦之前改的');
    const before = s.saves().length;
    s.ui.window.dispatchEvent(new s.ui.window.Event('blur'));
    const sent = s.saves().slice(before);
    assert.deepEqual(sent.map((m) => m.path), ['a.md']);
    s.saved('a.md', '甲，失焦之前改的', 'ha3');
  });

  test('頁面藏起來時也存', () => {
    s.type('甲，藏起來之前改的');
    Object.defineProperty(s.ui.doc, 'visibilityState', { configurable: true, get: () => 'hidden' });
    const before = s.saves().length;
    s.ui.doc.dispatchEvent(new s.ui.window.Event('visibilitychange'));
    assert.equal(s.saves().length, before + 1);
    s.saved('a.md', '甲，藏起來之前改的', 'ha4');
  });

  test('存成了不彈 toast', () => {
    assert.equal(s.toasts.length, 0);
  });
});

describe('自動儲存：閘', { skip: JSDOM_SKIP }, () => {
  let s;

  before(() => {
    s = setup();
    s.ui.post({ type: 'editorOpen', file: file('a.md', '甲', { hash: 'ha' }) });
    s.toggleAutoSave();
  });

  test('同一份只有一個在路上：期間又改了，等回執後再存一次', () => {
    s.type('甲，改了');
    s.tick(2000);
    assert.equal(s.saves().length, 1);
    s.type('甲，改了，又改了');
    s.tick(2000);
    assert.equal(s.saves().length, 1, '第一個還在路上');
    s.saved('a.md', '甲，改了', 'ha2');
    assert.equal(s.saves().length, 2);
    assert.equal(s.saves()[1].baseHash, 'ha2');
    s.saved('a.md', '甲，改了，又改了', 'ha3');
  });

  test('撞上衝突：不強制儲存，這一份停止自動儲存，不切標籤', () => {
    s.ui.post({ type: 'editorOpen', file: file('b.md', '乙', { hash: 'hb' }) });
    s.ui.clickEl(s.tabEl('a.md'));
    s.type('甲，衝突之前');
    s.ui.clickEl(s.tabEl('b.md')); // 切走時存 a
    const sent = s.saves().at(-1);
    assert.equal(sent.path, 'a.md');
    s.ui.post({ type: 'editorConflict', path: 'a.md', diskText: '甲（別處改的）', diskHash: 'ha-disk' });
    assert.equal(s.ui.panes()[0].querySelector('.ed-tab.active .ed-tab-name').textContent, 'b.md', '自動儲存撞上的衝突不切標籤');
    assert.ok(s.tabEl('a.md').querySelector('.ed-tab-flag'));
    assert.equal(s.toasts.at(-1).isError, true);
    assert.ok(s.saves().every((m) => m.baseHash !== undefined), '絕不強制儲存');
  });

  test('衝突沒解決之前，停筆、切標籤、失焦都不再存它，狀態列寫「自動儲存已暫停」', () => {
    s.ui.clickEl(s.tabEl('a.md'));
    const before = s.saves().length;
    s.type('甲，衝突之後又寫');
    s.tick(5000);
    s.ui.clickEl(s.tabEl('b.md'));
    s.ui.window.dispatchEvent(new s.ui.window.Event('blur'));
    assert.equal(s.saves().filter((m) => m.path === 'a.md').length, s.saves().slice(0, before).filter((m) => m.path === 'a.md').length);
    s.ui.clickEl(s.tabEl('a.md'));
    assert.equal(s.flag()?.textContent, '自動儲存已暫停');
  });

  test('在衝突條上選了（用磁碟版本），之後接著自動儲存', () => {
    s.key('s', { ctrlKey: true }); // 衝突條收起了：按 Ctrl+S 再看一遍
    s.ui.post({ type: 'editorConflict', path: 'a.md', diskText: '甲（別處改的）', diskHash: 'ha-disk' });
    s.ui.clickEl(s.ui.doc.getElementById('edConflictTake'));
    assert.equal(s.flag()?.textContent, '自動儲存');
    const before = s.saves().length;
    s.type('甲（別處改的），接著寫');
    s.tick(2000);
    assert.equal(s.saves().length, before + 1);
    assert.equal(s.saves().at(-1).baseHash, 'ha-disk');
    s.saved('a.md', '甲（別處改的），接著寫', 'ha5');
  });

  test('磁碟上沒了的不自動儲存', () => {
    s.ui.post({ type: 'editorDiskGone', path: 'a.md' });
    const before = s.saves().length;
    s.type('甲，磁碟上沒了之後寫的');
    s.tick(5000);
    s.ui.window.dispatchEvent(new s.ui.window.Event('blur'));
    assert.equal(s.saves().length, before);
    assert.equal(s.flag()?.textContent, '自動儲存已暫停');
    assert.equal(s.ui.dialog(), null, '自動儲存不彈「要不要重建」');
  });

  test('核對磁碟發現改過的標籤在磁碟上變了：也停下', () => {
    const t = setup();
    t.ui.post({ type: 'editorOpen', file: file('a.md', '甲', { hash: 'ha' }) });
    t.toggleAutoSave();
    t.type('甲，改了');
    t.ui.post({ type: 'editorDiskChanged', file: file('a.md', '甲（agent 改的）', { hash: 'ha2' }) });
    t.tick(5000);
    assert.equal(t.saves().length, 0);
  });

  test('對話方塊開著時不存（比如正問著要不要還原），答完之後照常', async () => {
    const t = setup();
    t.ui.post({ type: 'editorOpen', file: file('a.md', '甲', { hash: 'ha' }) });
    t.toggleAutoSave();
    t.type('甲，改了');
    t.ui.clickEl(t.ui.doc.getElementById('edRevertBtn'));
    assert.ok(t.ui.dialog());
    t.tick(5000);
    t.ui.window.dispatchEvent(new t.ui.window.Event('blur'));
    assert.equal(t.saves().length, 0, '作者正決定要不要丟掉這些修改');
    await t.ui.answer('取消');
    t.tick(2000);
    assert.equal(t.saves().length, 1);
  });

  test('點了「還原」：磁碟版回來之前不把要丟掉的修改存下去', async () => {
    const t = setup();
    t.ui.post({ type: 'editorOpen', file: file('a.md', '甲', { hash: 'ha' }) });
    t.toggleAutoSave();
    t.type('甲，要丟掉的');
    t.ui.clickEl(t.ui.doc.getElementById('edRevertBtn'));
    await t.ui.answer('放棄修改');
    t.tick(5000);
    t.ui.window.dispatchEvent(new t.ui.window.Event('blur'));
    assert.equal(t.saves().length, 0);
    t.ui.post({ type: 'editorOpen', file: file('a.md', '甲', { hash: 'ha' }) });
    assert.equal(t.area().value, '甲');
    t.type('甲，還原之後寫的');
    t.tick(2000);
    assert.equal(t.saves().length, 1);
  });
});
