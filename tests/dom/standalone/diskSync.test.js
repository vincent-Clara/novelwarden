/**
 * 內建編輯器：磁碟上的改動同步到已開的標籤（`editor/diskSync.ts` + `Pane.applyDiskChange` / `markGone`）。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 收到 `state` 去抖之後、視窗拿回焦點 / 頁面重新可見時，把兩塊編輯區裡開著的檔案報給後端 | 定稿寫回細綱、批次寫章、外部 agent 的 edit、外部編輯器改了檔案，從前編輯器裡還是舊的 |
 * | 沒改過的標籤就地換、不切標籤、不搶焦點、記一步撤銷、游標夾進新長度 | 與「再次開啟時磁碟有新版」同一處理，但不能像 editorOpen 那樣把標籤切過去 |
 * | 改過的標籤一個字不動、掛衝突條、標籤上標「!」、同一份新版不報第二次 | 不靜默覆蓋（第 3 條），也別刷屏 |
 * | 磁碟上沒了：標成已刪除；儲存先問、不靜默在原路徑重建 | 閘道器對「帶了基線、檔案卻不在」是當新建處理的 |
 * | 自己儲存之後不誤報 | `editorSaved` 先到、`state` 後到，核對時帶的是新 hash；自己那次儲存在路上時收到的「變了」不認 |
 * | 別的視窗存了同一份：不把基線悄悄換成別人的 | 從前那條 `editorSaved` 會讓下一次儲存把別人的改動蓋掉 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file, viewState } = require('../../helpers/dom');

const A = 'chapters/001-雨夜.md';
const B = '.novelwarden/summaries/001-雨夜.md';
const C = 'drafts/001-雨夜.md';

function setup() {
  const ui = mount({ body: 'standalone', scripts: ['editor.js'], shims: ['pointerCapture', 'fakeTimers'] });
  // 編輯器裡不許再用 window.confirm：用到了就當場炸。
  ui.window.confirm = () => {
    throw new Error('不該調 window.confirm');
  };
  const toasts = [];
  ui.window.__nfToast = (message, isError) => toasts.push({ message, isError: !!isError });
  const area = () => ui.doc.getElementById('edArea');
  const tabEl = (name, paneIndex = 0) =>
    [...ui.panes()[paneIndex].querySelectorAll('.ed-tab')].find((t) => t.querySelector('.ed-tab-name').textContent === name);
  const activeTab = (paneIndex = 0) =>
    ui.panes()[paneIndex].querySelector('.ed-tab.active .ed-tab-name')?.textContent;
  const type = (text) => {
    area().value = text;
    area().dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  };
  const key = (k, extra = {}) =>
    area().dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
  const checks = () => ui.sent.filter((m) => m.type === 'checkEditorFiles');
  const lastCheck = () => checks().at(-1);
  const hashIn = (msg, path) => msg?.files.find((f) => f.path === path)?.hash;
  const sync = () => {
    ui.post({ type: 'state', state: viewState() });
    ui.window.__clock.tick(400);
    return lastCheck();
  };
  const changed = (path, text, hash, extra) =>
    ui.post({ type: 'editorDiskChanged', file: file(path, text, { hash, kind: 'chapter', ...extra }) });
  const status = () => ui.doc.getElementById('edStatusSave').textContent;
  const bar = () => ui.doc.getElementById('edConflict');
  return { ui, toasts, area, tabEl, activeTab, type, key, checks, lastCheck, hashIn, sync, changed, status, bar };
}

describe('磁碟上的改動：什麼時候核對', { skip: JSDOM_SKIP }, () => {
  let s;

  before(() => {
    s = setup();
    s.ui.post({ type: 'editorOpen', file: file(A, '雨夜。', { kind: 'chapter' }) });
    s.ui.post({ type: 'editorOpen', file: file(B, '# 梗概', { kind: 'plot' }) });
    s.ui.post({ type: 'editorOpen', pane: 'draft', file: file(C, '草稿', { kind: 'draft' }) });
    s.ui.window.__clock.tick(1000);
  });

  test('收到 state 之後等一會兒，把兩塊編輯區裡開著的檔案連同 hash 報給後端', () => {
    const before = s.checks().length;
    s.ui.post({ type: 'state', state: viewState() });
    s.ui.window.__clock.tick(399);
    assert.equal(s.checks().length, before, '去抖還沒到點就發了');
    s.ui.window.__clock.tick(1);
    assert.equal(s.checks().length, before + 1);
    // 訊息是頁面那一邊造的物件（另一個 realm），按 JSON 比。
    assert.deepEqual(JSON.parse(JSON.stringify(s.lastCheck().files)), [
      { path: A, hash: `h-${A}` },
      { path: B, hash: `h-${B}` },
      { path: C, hash: `h-${C}` },
    ]);
  });

  test('連著幾條 state 只核對一次', () => {
    const before = s.checks().length;
    for (let i = 0; i < 3; i++) {
      s.ui.post({ type: 'state', state: viewState() });
      s.ui.window.__clock.tick(100);
    }
    s.ui.window.__clock.tick(400);
    assert.equal(s.checks().length, before + 1);
  });

  test('視窗重新拿到焦點時也核對', () => {
    const before = s.checks().length;
    s.ui.window.dispatchEvent(new s.ui.window.Event('focus'));
    s.ui.window.__clock.tick(400);
    assert.equal(s.checks().length, before + 1);
  });

  test('頁面重新可見時也核對，藏起來時不核對', () => {
    let state = 'hidden';
    Object.defineProperty(s.ui.doc, 'visibilityState', { configurable: true, get: () => state });
    const before = s.checks().length;
    s.ui.doc.dispatchEvent(new s.ui.window.Event('visibilitychange'));
    s.ui.window.__clock.tick(400);
    assert.equal(s.checks().length, before, '藏起來時不該核對');
    state = 'visible';
    s.ui.doc.dispatchEvent(new s.ui.window.Event('visibilitychange'));
    s.ui.window.__clock.tick(400);
    assert.equal(s.checks().length, before + 1);
  });

  test('一個標籤都沒開時不發', () => {
    const empty = setup();
    empty.ui.post({ type: 'state', state: viewState() });
    empty.ui.window.__clock.tick(1000);
    assert.equal(empty.checks().length, 0);
  });
});

describe('磁碟上變了：沒改過的標籤', { skip: JSDOM_SKIP }, () => {
  let s;
  let outside;

  before(() => {
    s = setup();
    s.ui.post({ type: 'editorOpen', file: file(A, '雨夜。\n林昭推門。', { kind: 'chapter' }) });
    s.ui.post({ type: 'editorOpen', file: file(B, '# 梗概', { kind: 'plot' }) });
    // 焦點在頁面別處（比如對話輸入框）：磁碟同步不許把它搶走。
    outside = s.ui.doc.createElement('input');
    s.ui.doc.body.appendChild(outside);
    outside.focus();
  });

  test('不是當前的那一份：就地換成新內容，當前標籤不變', () => {
    assert.equal(s.activeTab(), '001-雨夜.md');
    s.changed(A, '雨夜。\n林昭推門，又退了出來。', 'h-A2');
    assert.equal(s.activeTab(), '001-雨夜.md', '當前標籤還是細綱那一份');
    assert.equal(s.area().value, '# 梗概');
    assert.equal(s.ui.doc.activeElement, outside, '焦點沒被搶走');
    assert.equal(s.toasts.length, 0, '不彈 toast');
  });

  test('切過去看到的是磁碟上的新版，仍是沒改過的', () => {
    s.ui.clickEl(s.tabEl('001-雨夜.md'));
    // 正文與細綱同名，按順序第一個是正文。
    assert.equal(s.area().value, '雨夜。\n林昭推門，又退了出來。');
    assert.equal(s.ui.panes()[0].querySelector('.ed-tab.active').classList.contains('dirty'), false);
  });

  test('換進來的那一下記一步撤銷', () => {
    s.key('z', { ctrlKey: true });
    assert.equal(s.area().value, '雨夜。\n林昭推門。');
    s.key('y', { ctrlKey: true });
    assert.equal(s.area().value, '雨夜。\n林昭推門，又退了出來。');
  });

  test('正看著的那一份：游標留在原處，焦點不動，狀態列說一句', () => {
    outside.focus();
    s.area().setSelectionRange(3, 3);
    s.changed(A, '雨夜。\n林昭推門，又退了出來，雨更大了。', 'h-A3');
    assert.equal(s.area().value, '雨夜。\n林昭推門，又退了出來，雨更大了。');
    assert.equal(s.area().selectionStart, 3);
    assert.equal(s.ui.doc.activeElement, outside);
    assert.equal(s.status(), '磁碟上有新版本，已載入');
    assert.equal(s.toasts.length, 0);
  });

  test('那一句過一會兒退回儲存狀態', () => {
    s.ui.window.__clock.tick(4000);
    assert.equal(s.status(), '已儲存');
  });

  test('游標夾進新長度', () => {
    s.area().setSelectionRange(s.area().value.length, s.area().value.length);
    s.changed(A, '短了', 'h-A4');
    assert.equal(s.area().value, '短了');
    assert.equal(s.area().selectionStart, 2);
  });

  test('之後核對時帶的是新版的 hash', () => {
    assert.equal(s.hashIn(s.sync(), A), 'h-A4');
  });
});

describe('磁碟上變了：改過的標籤', { skip: JSDOM_SKIP }, () => {
  let s;

  before(() => {
    s = setup();
    s.ui.post({ type: 'editorOpen', file: file(A, '雨夜。', { kind: 'chapter' }) });
    s.type('雨夜。林昭來了。');
    s.ui.post({ type: 'editorOpen', file: file(B, '# 梗概', { kind: 'plot' }) });
  });

  test('編輯器裡的修改一個字不動，不切標籤，標籤上掛「!」', () => {
    s.changed(A, '雨夜。（外部 agent 改的）', 'h-A2');
    assert.equal(s.activeTab(), '001-雨夜.md');
    assert.equal(s.area().value, '# 梗概', '當前還是細綱');
    const tab = s.ui.panes()[0].querySelector('.ed-tab.conflict');
    assert.ok(tab, '改過的那個標籤要標出來');
    assert.ok(tab.querySelector('.ed-tab-flag'), '標籤上要有「!」');
    assert.equal(s.toasts.length, 1);
    assert.equal(s.toasts[0].isError, true);
  });

  test('切過去：修改還在，衝突條說磁碟上被改了、沒有覆蓋', () => {
    s.ui.clickEl(s.ui.panes()[0].querySelector('.ed-tab.conflict'));
    assert.equal(s.area().value, '雨夜。林昭來了。');
    assert.equal(s.bar().classList.contains('hidden'), false);
    const text = s.ui.doc.getElementById('edConflictText').textContent;
    assert.match(text, /沒有覆蓋/);
    assert.doesNotMatch(text, /儲存已取消/);
  });

  test('同一份新版再報一次不再彈提示', () => {
    s.changed(A, '雨夜。（外部 agent 改的）', 'h-A2');
    assert.equal(s.toasts.length, 1);
  });

  test('核對時帶上見過的那份磁碟新版的 hash（同一個新版後端就不再回話）', () => {
    assert.equal(s.hashIn(s.sync(), A), 'h-A2');
  });

  test('接著打字衝突條收起，同一份新版也不再報', () => {
    s.type('雨夜。林昭來了。又一筆。');
    assert.equal(s.bar().classList.contains('hidden'), true);
    s.changed(A, '雨夜。（外部 agent 改的）', 'h-A2');
    assert.equal(s.toasts.length, 1);
    assert.equal(s.bar().classList.contains('hidden'), true);
  });

  test('磁碟上又變了一次：再掛衝突條', () => {
    s.changed(A, '雨夜。（又改了）', 'h-A3');
    assert.equal(s.toasts.length, 2);
    assert.equal(s.bar().classList.contains('hidden'), false);
    assert.equal(s.area().value, '雨夜。林昭來了。又一筆。');
  });

  test('「用磁碟版本覆蓋編輯器」之後基線換成那一份', () => {
    s.ui.clickEl(s.ui.doc.getElementById('edConflictTake'));
    assert.equal(s.area().value, '雨夜。（又改了）');
    assert.equal(s.hashIn(s.sync(), A), 'h-A3');
    assert.equal(s.ui.panes()[0].querySelector('.ed-tab.conflict'), null);
  });

  test('磁碟上的正好是編輯器裡這一份：認下來，不算衝突', () => {
    s.type('兩邊一樣');
    const before = s.toasts.length;
    s.changed(A, '兩邊一樣', 'h-same');
    assert.equal(s.toasts.length, before);
    assert.equal(s.bar().classList.contains('hidden'), true);
    assert.equal(s.ui.panes()[0].querySelector('.ed-tab.active').classList.contains('dirty'), false);
  });
});

describe('磁碟上沒了', { skip: JSDOM_SKIP }, () => {
  let s;
  const goneTab = () => s.ui.panes()[0].querySelector('.ed-tab.gone');

  before(() => {
    s = setup();
    s.ui.post({ type: 'editorOpen', file: file(A, '雨夜。', { kind: 'chapter' }) });
    s.type('雨夜。改了一筆。');
    s.ui.post({ type: 'editorOpen', file: file(B, '# 梗概', { kind: 'plot' }) });
  });

  test('標籤標成已刪除，不切過去', () => {
    s.ui.post({ type: 'editorDiskGone', path: A });
    assert.ok(goneTab(), '沒標成已刪除');
    assert.ok(goneTab().querySelector('.ed-tab-flag'));
    assert.equal(s.area().value, '# 梗概');
  });

  test('切過去：衝突條那一格說磁碟上已經沒有這個檔案，沒有「用磁碟版本覆蓋」', () => {
    s.ui.clickEl(goneTab());
    assert.equal(s.area().value, '雨夜。改了一筆。');
    assert.equal(s.bar().classList.contains('hidden'), false);
    assert.match(s.ui.doc.getElementById('edConflictText').textContent, /磁碟上已經沒有.*（被刪或改名）/);
    assert.equal(s.ui.doc.getElementById('edConflictTake').classList.contains('hidden'), true);
  });

  test('打字不讓這條說明收起', () => {
    s.type('雨夜。改了兩筆。');
    assert.equal(s.bar().classList.contains('hidden'), false);
  });

  test('核對時給空 hash：磁碟上又出現了後端就會回話', () => {
    assert.equal(s.hashIn(s.sync(), A), '');
  });

  test('按儲存先問要不要在原路徑重建，取消就什麼都不發', async () => {
    const before = s.ui.sent.filter((m) => m.type === 'saveFile').length;
    s.key('s', { ctrlKey: true });
    assert.ok(s.ui.dialog(), '沒有彈對話方塊');
    assert.deepEqual(s.ui.dialogButtons(), ['取消', '在原路徑重建']);
    await s.ui.answer('取消');
    assert.equal(s.ui.dialog(), null);
    assert.equal(s.ui.sent.filter((m) => m.type === 'saveFile').length, before);
  });

  test('衝突條上的「強制儲存」也走這一問', async () => {
    s.ui.clickEl(s.ui.doc.getElementById('edConflictForce'));
    assert.deepEqual(s.ui.dialogButtons(), ['取消', '在原路徑重建']);
    await s.ui.answer('取消');
  });

  test('答應了才發，帶著 recreate 與基線', async () => {
    s.key('s', { ctrlKey: true });
    await s.ui.answer('在原路徑重建');
    const msg = s.ui.last('saveFile');
    assert.equal(msg.recreate, true);
    assert.equal(msg.baseHash, `h-${A}`);
    assert.equal(msg.text, '雨夜。改了兩筆。');
  });

  test('存成了：已刪除的標記清掉', () => {
    s.ui.post({ type: 'editorSaved', file: file(A, '雨夜。改了兩筆。', { hash: 'h-A2', kind: 'chapter' }) });
    assert.equal(goneTab(), null);
    assert.equal(s.bar().classList.contains('hidden'), true);
  });

  test('普通儲存撞上「磁碟上沒了」：提示沒有儲存，標成已刪除，不再「儲存中」', () => {
    s.type('雨夜。改了三筆。');
    s.key('s', { ctrlKey: true });
    const msg = s.ui.last('saveFile');
    assert.equal(msg.recreate, undefined);
    assert.equal(s.status(), '儲存中…');
    s.ui.post({ type: 'editorDiskGone', path: A });
    assert.match(s.toasts.at(-1).message, /沒有儲存/);
    assert.ok(goneTab());
    assert.match(s.status(), /未儲存/);
  });

  test('磁碟上又出現了同一份：已刪除的標記清掉', () => {
    s.changed(A, '雨夜。改了兩筆。', 'h-A2');
    assert.equal(goneTab(), null);
    assert.equal(s.area().value, '雨夜。改了三筆。');
  });
});

describe('磁碟上沒了：沒改過的那一份', { skip: JSDOM_SKIP }, () => {
  let s;

  before(() => {
    s = setup();
    s.ui.post({ type: 'editorOpen', file: file(A, '雨夜。', { kind: 'chapter' }) });
    s.ui.post({ type: 'editorDiskGone', path: A });
  });

  test('「全部儲存」掃到它不彈框、不發儲存', () => {
    s.ui.window.dispatchEvent(new s.ui.window.CustomEvent('nf-editor-command', { detail: { name: 'saveAll' } }));
    assert.equal(s.ui.dialog(), null);
    assert.equal(s.ui.last('saveFile'), undefined);
  });

  test('衝突條上的「強制儲存」是明說要存：照樣問，答應了帶著基線重建', async () => {
    s.ui.clickEl(s.ui.doc.getElementById('edConflictForce'));
    assert.deepEqual(s.ui.dialogButtons(), ['取消', '在原路徑重建']);
    await s.ui.answer('在原路徑重建');
    const msg = s.ui.last('saveFile');
    assert.equal(msg.recreate, true);
    assert.equal(msg.baseHash, `h-${A}`, '重建也帶基線：期間原路徑又有了別的內容照樣撞衝突');
  });
});

describe('自己儲存之後不誤報', { skip: JSDOM_SKIP }, () => {
  let s;

  before(() => {
    s = setup();
    s.ui.post({ type: 'editorOpen', file: file(A, '雨夜。', { kind: 'chapter', hash: 'h0' }) });
    s.ui.post({ type: 'editorOpen', file: file(B, '# 梗概', { kind: 'plot' }) });
    s.ui.clickEl(s.tabEl('001-雨夜.md'));
    s.type('雨夜。林昭來了。');
    s.key('s', { ctrlKey: true });
  });

  test('儲存帶著原來的基線發出去', () => {
    assert.equal(s.ui.last('saveFile').baseHash, 'h0');
  });

  test('儲存還在路上時核對不帶這一份', () => {
    const msg = s.sync();
    assert.equal(s.hashIn(msg, A), undefined);
    assert.equal(s.hashIn(msg, B), `h-${B}`);
  });

  test('路上收到的「磁碟上變了」（讀到了自己剛寫下去的那份）不認', () => {
    s.changed(A, '雨夜。林昭來了。', 'h1');
    assert.equal(s.bar().classList.contains('hidden'), true);
    assert.equal(s.toasts.length, 0);
    assert.equal(s.status(), '儲存中…');
  });

  test('回執先到、state 後到：之後核對時帶的就是新 hash', () => {
    s.ui.post({ type: 'editorSaved', file: file(A, '雨夜。林昭來了。', { kind: 'chapter', hash: 'h1' }) });
    assert.equal(s.hashIn(s.sync(), A), 'h1');
  });

  test('遲到的「變了」報的就是自己存下去的那份：什麼都不動', () => {
    s.changed(A, '雨夜。林昭來了。', 'h1');
    assert.equal(s.bar().classList.contains('hidden'), true);
    assert.equal(s.ui.panes()[0].querySelector('.ed-tab.conflict'), null);
    assert.equal(s.toasts.length, 0);
    assert.match(s.status(), /^已儲存/);
  });
});

describe('別的視窗存了同一份（回執是廣播的）', { skip: JSDOM_SKIP }, () => {
  let s;

  before(() => {
    s = setup();
    s.ui.post({ type: 'editorOpen', file: file(A, '雨夜。', { kind: 'chapter', hash: 'h0' }) });
  });

  test('這邊沒改過：就地換成那一份', () => {
    s.ui.post({ type: 'editorSaved', file: file(A, '雨夜。別處寫的。', { kind: 'chapter', hash: 'h1' }) });
    assert.equal(s.area().value, '雨夜。別處寫的。');
    assert.equal(s.ui.panes()[0].querySelector('.ed-tab.active').classList.contains('dirty'), false);
  });

  test('這邊改過：掛衝突條，基線不悄悄換成別人的', () => {
    s.type('雨夜。別處寫的。這邊又寫了。');
    s.ui.post({ type: 'editorSaved', file: file(A, '雨夜。另一個視窗又存了。', { kind: 'chapter', hash: 'h2' }) });
    assert.equal(s.area().value, '雨夜。別處寫的。這邊又寫了。');
    assert.equal(s.bar().classList.contains('hidden'), false);
    s.key('s', { ctrlKey: true });
    assert.equal(s.ui.last('saveFile').baseHash, 'h1', '儲存仍帶這邊的基線，撞上衝突而不是蓋掉別人的');
  });
});

describe('再次開啟（生成落盤後 openFile → editorOpen）那條路不變', { skip: JSDOM_SKIP }, () => {
  test('editorOpen 照舊把那個標籤切成當前的', () => {
    const s = setup();
    s.ui.post({ type: 'editorOpen', file: file(A, '雨夜。', { kind: 'chapter' }) });
    s.ui.post({ type: 'editorOpen', file: file(B, '# 梗概', { kind: 'plot' }) });
    s.ui.post({ type: 'editorOpen', file: file(A, '雨夜。新寫的。', { kind: 'chapter', hash: 'h1' }) });
    assert.equal(s.area().value, '雨夜。新寫的。');
  });
});
