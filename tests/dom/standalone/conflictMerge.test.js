/**
 * 衝突條上的「對比合併…」（`media/src/editor/conflictMerge.ts`）與它收的 `editorReplace`（`replace.ts`）。
 * 合併檢視本身由後端的 `prompt kind: 'merge'` 驅動（merge.test.js），這裡只釘編輯器這一半。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 按鈕 | 衝突條上排第一個（說明文字之後），原來兩顆還在；草稿區的衝突條也有 |
 * | 點了 | 發 `mergeWithDisk`，帶編輯器裡的這一份與一個 requestId |
 * | 收到 `editorReplace`（帶 base） | 內容換成合併結果、衝突條收起、仍是未儲存；Ctrl+S 發的 baseHash 是磁碟那份的（不必強制儲存）；一步撤銷退回合併之前 |
 * | 合併結果與磁碟一樣 | 換完就是已儲存的樣子 |
 * | 別的頁面發的 requestId | 不認 |
 * | 磁碟上沒了（`gone`） | 衝突條亮著說「被刪或改名」，「對比合併…」藏起來（沒有磁碟版本可合併）；檔案回來了又出現 |
 * | 合併之後的自動儲存 | 撞衝突停下的自動儲存接著走：狀態列不再「已暫停」，停筆 2 秒就存，帶的是磁碟那份的 hash |
 * | 合併之後磁碟再變 | 核對磁碟帶的是新基線；磁碟再變——哪怕變回撞衝突時見過的那一份——照樣報、掛衝突條 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file, viewState } = require('../../helpers/dom');

const PATH = 'chapters/001-雨夜.md';

function harness(extraShims = []) {
  const ui = mount({ body: 'standalone', scripts: ['editor.js'], shims: ['pointerCapture', 'confirm', 'scrollIntoView', ...extraShims] });
  const toasts = [];
  ui.window.__nfToast = (m) => toasts.push(m);
  const area = () => ui.doc.getElementById('edArea');
  return {
    ui,
    toasts,
    area,
    bar: () => ui.doc.getElementById('edConflict'),
    mergeBtn: () => ui.doc.querySelector('#edConflict .ed-conflict-merge'),
    tab: () => ui.doc.querySelector('#edTabs .ed-tab'),
    status: () => ui.doc.getElementById('edStatusSave').textContent,
    autoFlag: () => ui.doc.querySelector('#wbEditor .ed-status .ed-autosave'),
    saves: () => ui.sent.filter((m) => m.type === 'saveFile'),
    tick: (ms) => ui.window.__clock.tick(ms),
    toggleAutoSave: () =>
      ui.window.dispatchEvent(new ui.window.CustomEvent('nf-editor-command', { detail: { name: 'toggleAutoSave' } })),
    /** 推一條 state，等核對磁碟的去抖過去，回那一次 checkEditorFiles 裡這份檔案帶的 hash。 */
    checkedHash(path) {
      ui.post({ type: 'state', state: viewState() });
      ui.window.__clock.tick(400);
      const msg = ui.sent.filter((m) => m.type === 'checkEditorFiles').at(-1);
      return msg?.files.find((f) => f.path === path)?.hash;
    },
    /** 點「對比合併…」，後端把 `text` 放回、基線換成 `base`。 */
    merge(text, base) {
      ui.clickEl(ui.doc.querySelector('#edConflict .ed-conflict-merge'));
      const { requestId } = ui.sent.filter((m) => m.type === 'mergeWithDisk').at(-1);
      ui.post({ type: 'editorReplace', requestId, path: PATH, text, base });
    },
    type(text) {
      area().value = text;
      area().dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    },
    key(key, extra = {}) {
      area().dispatchEvent(new ui.window.KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true, ...extra }));
    },
  };
}

describe('衝突條「對比合併…」', { skip: JSDOM_SKIP }, () => {
  let h;
  let sent;

  before(() => {
    h = harness();
    h.ui.post({ type: 'editorOpen', file: file(PATH, '原文。', { kind: 'chapter', hash: 'h-old' }) });
    h.type('編輯器裡改過的。');
    h.ui.post({ type: 'editorConflict', path: PATH, diskText: '別處改過的。', diskHash: 'h-disk' });
  });

  test('衝突條亮了，「對比合併…」排第一個（說明文字之後），原來兩顆還在', () => {
    assert.ok(!h.bar().classList.contains('hidden'));
    const buttons = [...h.bar().querySelectorAll('button')].map((b) => b.textContent);
    assert.deepEqual(buttons, ['對比合併…', '用磁碟版本覆蓋編輯器', '用編輯器內容強制儲存']);
    assert.equal(h.mergeBtn().previousElementSibling.id, 'edConflictText');
  });

  test('點了發 mergeWithDisk：編輯器裡的這一份 + requestId', () => {
    h.ui.clickEl(h.mergeBtn());
    sent = h.ui.last('mergeWithDisk');
    assert.ok(sent, '沒發出 mergeWithDisk');
    assert.equal(sent.path, PATH);
    assert.equal(sent.text, '編輯器裡改過的。');
    assert.ok(sent.requestId);
  });

  test('別的頁面發的 requestId 不認', () => {
    h.ui.post({ type: 'editorReplace', requestId: 'someone-else', path: PATH, text: '不該進來', base: { text: 'x', hash: 'h-x' } });
    assert.equal(h.area().value, '編輯器裡改過的。');
    assert.ok(!h.bar().classList.contains('hidden'));
  });

  test('收到 editorReplace：內容換成合併結果、衝突條收起', () => {
    h.ui.post({
      type: 'editorReplace',
      requestId: sent.requestId,
      path: PATH,
      text: '合併之後的。',
      base: { text: '別處改過的。', hash: 'h-disk-now' },
    });
    assert.equal(h.area().value, '合併之後的。');
    assert.ok(h.bar().classList.contains('hidden'));
  });

  test('仍是未儲存，提示說照常儲存', () => {
    assert.ok(h.tab().classList.contains('dirty'));
    assert.match(h.status(), /未儲存/);
    assert.match(h.toasts.at(-1), /還沒儲存.*Ctrl\+S/);
  });

  test('Ctrl+S 照常儲存：baseHash 是磁碟那份的（不是強制儲存）', () => {
    h.key('s');
    const save = h.ui.last('saveFile');
    assert.equal(save.text, '合併之後的。');
    assert.equal(save.baseHash, 'h-disk-now');
  });

  test('一步撤銷：退回合併之前編輯器裡那份', () => {
    h.key('z');
    assert.equal(h.area().value, '編輯器裡改過的。');
  });

  test('同一個 requestId 只認一次', () => {
    h.ui.post({ type: 'editorReplace', requestId: sent.requestId, path: PATH, text: '第二次', base: { text: 'y', hash: 'h-y' } });
    assert.equal(h.area().value, '編輯器裡改過的。');
  });
});

describe('合併結果與磁碟上的一樣', { skip: JSDOM_SKIP }, () => {
  test('換完就是已儲存的樣子（圓點消失）', () => {
    const h = harness();
    h.ui.post({ type: 'editorOpen', file: file(PATH, '原文。', { kind: 'chapter', hash: 'h-old' }) });
    h.type('編輯器裡的。');
    h.ui.post({ type: 'editorConflict', path: PATH, diskText: '磁碟上的。', diskHash: 'h-disk' });
    h.ui.clickEl(h.mergeBtn());
    const { requestId } = h.ui.last('mergeWithDisk');
    h.ui.post({ type: 'editorReplace', requestId, path: PATH, text: '磁碟上的。', base: { text: '磁碟上的。', hash: 'h-disk' } });
    assert.equal(h.area().value, '磁碟上的。');
    assert.ok(!h.tab().classList.contains('dirty'));
    assert.match(h.toasts.at(-1), /與磁碟上的一致/);
  });
});

describe('草稿區的衝突條', { skip: JSDOM_SKIP }, () => {
  test('也有「對比合併…」，點了發的是那一塊裡的檔案', () => {
    const h = harness();
    h.ui.post({ type: 'editorOpen', pane: 'draft', file: file('drafts/001-雨夜.md', '草稿。', { kind: 'draft' }) });
    const draft = h.ui.panes()[1];
    const area = draft.querySelector('textarea');
    area.value = '草稿改了。';
    area.dispatchEvent(new h.ui.window.Event('input', { bubbles: true }));
    h.ui.post({ type: 'editorConflict', path: 'drafts/001-雨夜.md', diskText: '別處的。', diskHash: 'h-d' });
    const btn = draft.querySelector('.ed-conflict .ed-conflict-merge');
    assert.ok(btn);
    h.ui.clickEl(btn);
    const sent = h.ui.last('mergeWithDisk');
    assert.equal(sent.path, 'drafts/001-雨夜.md');
    assert.equal(sent.text, '草稿改了。');
  });
});

describe('磁碟上沒了：沒有可合併的', { skip: JSDOM_SKIP }, () => {
  let h;

  before(() => {
    h = harness();
    h.ui.post({ type: 'editorOpen', file: file(PATH, '原文。', { kind: 'chapter', hash: 'h-old' }) });
    h.type('編輯器裡改過的。');
    h.ui.post({ type: 'editorDiskGone', path: PATH });
  });

  test('衝突條亮著說「被刪或改名」，「對比合併…」藏起來（與「用磁碟版本覆蓋」同一個判法）', () => {
    assert.ok(!h.bar().classList.contains('hidden'));
    assert.match(h.ui.doc.getElementById('edConflictText').textContent, /磁碟上已經沒有/);
    assert.ok(h.mergeBtn().classList.contains('hidden'));
    assert.ok(h.ui.doc.getElementById('edConflictTake').classList.contains('hidden'));
  });

  test('接著打字也不冒出來', () => {
    h.type('編輯器裡又改了。');
    assert.ok(h.mergeBtn().classList.contains('hidden'));
  });

  test('磁碟上又有了、而且與編輯器裡的不一樣：衝突條換成「被改動」，「對比合併…」回來', () => {
    h.ui.post({ type: 'editorDiskChanged', file: file(PATH, '別處又建了一份。', { kind: 'chapter', hash: 'h-back' }) });
    assert.ok(!h.bar().classList.contains('hidden'));
    assert.match(h.ui.doc.getElementById('edConflictText').textContent, /已被改動/);
    assert.ok(!h.mergeBtn().classList.contains('hidden'));
  });
});

describe('合併之後：撞衝突停下的自動儲存接著走', { skip: JSDOM_SKIP }, () => {
  let h;

  before(() => {
    h = harness(['fakeTimers']);
    h.ui.post({ type: 'editorOpen', file: file(PATH, '甲。', { kind: 'chapter', hash: 'h0' }) });
    h.toggleAutoSave();
    h.type('甲，改了。');
    h.tick(2000);
    // 自動儲存撞上衝突：這一份停下。
    h.ui.post({ type: 'editorConflict', path: PATH, diskText: '甲（別處改的）。', diskHash: 'h-disk' });
  });

  test('起點：自動儲存已暫停', () => {
    assert.equal(h.autoFlag()?.textContent, '自動儲存已暫停');
    const before = h.saves().length;
    h.tick(5000);
    assert.equal(h.saves().length, before);
  });

  test('放回編輯器之後：不再暫停，停筆 2 秒就存，帶的是磁碟那份的 hash', () => {
    h.merge('甲（別處改的），改了。', { text: '甲（別處改的）。', hash: 'h-disk' });
    assert.equal(h.autoFlag()?.textContent, '自動儲存');
    const before = h.saves().length;
    h.tick(2000);
    assert.equal(h.saves().length, before + 1);
    const sent = h.saves().at(-1);
    assert.equal(sent.text, '甲（別處改的），改了。');
    assert.equal(sent.baseHash, 'h-disk');
  });

  test('回執到了：已儲存，之後照常', () => {
    h.ui.post({ type: 'editorSaved', file: file(PATH, '甲（別處改的），改了。', { kind: 'chapter', hash: 'h1' }) });
    assert.match(h.status(), /^已儲存/);
    h.type('甲（別處改的），改了，再寫一句。');
    h.tick(2000);
    assert.equal(h.saves().at(-1).baseHash, 'h1');
  });

  test('磁碟那份正好變回了撞衝突時的基線（hash 一樣）：閘照樣放開', () => {
    const g = harness(['fakeTimers']);
    g.ui.post({ type: 'editorOpen', file: file(PATH, '乙。', { kind: 'chapter', hash: 'h0' }) });
    g.toggleAutoSave();
    g.type('乙，改了。');
    g.tick(2000);
    g.ui.post({ type: 'editorConflict', path: PATH, diskText: '乙（別處改的）。', diskHash: 'h-disk' });
    // 合併時讀到的磁碟那份已經被人改回去了，hash 與撞衝突時編輯器的基線一樣。
    g.merge('乙，改了，合併過。', { text: '乙。', hash: 'h0' });
    assert.equal(g.autoFlag()?.textContent, '自動儲存');
    const before = g.saves().length;
    g.tick(2000);
    assert.equal(g.saves().length, before + 1);
    assert.equal(g.saves().at(-1).baseHash, 'h0');
  });
});

describe('合併之後：磁碟再變照樣報', { skip: JSDOM_SKIP }, () => {
  let h;

  before(() => {
    h = harness(['fakeTimers']);
    h.ui.post({ type: 'editorOpen', file: file(PATH, '丙。', { kind: 'chapter', hash: 'h0' }) });
    h.type('丙，改了。');
    // 核對磁碟發現別處改成了 h-seen：掛衝突條，這一份新版記下來（同一份不報第二次）。
    h.ui.post({ type: 'editorDiskChanged', file: file(PATH, '丙（第一次別處改的）。', { kind: 'chapter', hash: 'h-seen' }) });
  });

  test('起點：衝突條亮著，核對磁碟帶的是見過的那一份', () => {
    assert.ok(!h.bar().classList.contains('hidden'));
    assert.equal(h.checkedHash(PATH), 'h-seen');
  });

  test('放回編輯器（合併時磁碟已經又變成 h-now）：核對磁碟帶的是新基線 h-now', () => {
    h.merge('丙，改了，合併過。', { text: '丙（第二次別處改的）。', hash: 'h-now' });
    assert.ok(h.bar().classList.contains('hidden'));
    assert.equal(h.checkedHash(PATH), 'h-now');
  });

  test('磁碟變回撞衝突時見過的那一份（h-seen）：照樣報，掛衝突條、標籤上標「!」', () => {
    h.ui.post({ type: 'editorDiskChanged', file: file(PATH, '丙（第一次別處改的）。', { kind: 'chapter', hash: 'h-seen' }) });
    assert.ok(!h.bar().classList.contains('hidden'));
    assert.ok(h.tab().querySelector('.ed-tab-flag'));
    assert.equal(h.area().value, '丙，改了，合併過。', '編輯器裡的一個字不動');
  });

  test('磁碟變成又一份新的：同樣報', () => {
    const g = harness(['fakeTimers']);
    g.ui.post({ type: 'editorOpen', file: file(PATH, '丁。', { kind: 'chapter', hash: 'h0' }) });
    g.type('丁，改了。');
    g.ui.post({ type: 'editorDiskChanged', file: file(PATH, '丁（別處改的）。', { kind: 'chapter', hash: 'h-seen' }) });
    g.merge('丁，合併過。', { text: '丁（別處改的）。', hash: 'h-seen' });
    assert.ok(g.bar().classList.contains('hidden'));
    g.ui.post({ type: 'editorDiskChanged', file: file(PATH, '丁（別處又改的）。', { kind: 'chapter', hash: 'h-later' }) });
    assert.ok(!g.bar().classList.contains('hidden'));
  });
});
