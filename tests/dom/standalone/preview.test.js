/**
 * Markdown 預覽（`media/src/editor/pane.ts` 的 `setPreviewing`，滾動對應在 `previewSync.ts`，切塊與換算在
 * `previewCore.ts`——純函式那一半在 tests/unit/editor/previewCore.test.js）。
 *
 * jsdom 沒有排版：編輯區用 `mirrorLayout`（量位置那一份映象裡第 k 行的頂 = 18 + 30k，視口 300），預覽用 `previewLayout`
 * （帶 `data-line` 的一塊，頂 = 第幾行 × 40、高 = 佔幾行 × 40），只驗「按行號找到哪一處、滾到了哪」，不驗畫素。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 按標籤記 | 每個標籤各自記著在預覽還是在編輯：切走再切回來照舊（預覽的滾動也照舊）；狀態列寫「預覽」、按鈕寫「編輯」；
 *   從另一塊搬過來、重新整理恢復也照舊（⚑） |
 * | Ctrl+Shift+V | 正文裡、預覽裡、頁面上都切；對話輸入框裡不攔；不是 Markdown 的檔案不攔（照常是貼上）；按鈕提示寫著鍵 |
 * | 滾動對應 | 編輯 → 預覽：編輯區視口頂上那一行（帶小數）在預覽裡對應的那一處停在頂上；預覽 → 編輯反過來；游標不在視口裡就挪到
 *   視口頂上那一行的行首（⚑），在的話不動 |
 * | 重畫不彈回頂上 | 預覽開著時磁碟上的新版進來、儲存回執，預覽的滾動位置留著 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, MIRROR_LAYOUT, PREVIEW_LAYOUT, file } = require('../../helpers/dom');

const SHIMS = ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'];
const A = '.novelwarden/characters/林昭.md';
const B = '.novelwarden/characters/沈青.md';
/** 行：0 標題，2 一段，4–5 一段（兩行），7–8 列表兩項。 */
const TEXT = '# 林昭\n\n青雲宗外門弟子。\n\n性子急，\n話不多。\n\n- 劍\n- 玉佩\n';
const LINES = TEXT.split('\n').length;
const { line: LH } = MIRROR_LAYOUT;
const { line: PH } = PREVIEW_LAYOUT;

function harness(opts = {}) {
  const { shims = [], ...rest } = opts;
  const ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: [...SHIMS, ...shims], ...rest });
  ui.window.__nfToast = () => {};
  const doc = ui.doc;
  const h = {
    ui,
    doc,
    area: () => doc.getElementById('edArea'),
    preview: () => doc.getElementById('edPreview'),
    btn: () => doc.getElementById('edPreviewBtn'),
    previewing: () => !doc.getElementById('edPreview').classList.contains('hidden'),
    open: (p, text = TEXT, extra) => ui.post({ type: 'editorOpen', file: file(p, text, { kind: 'character', ...extra }) }),
    tab: (p) => [...doc.querySelectorAll('#wbEditor .ed-tab')].find((t) => t.dataset.path === p),
    key(target, init) {
      const ev = new ui.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(ev);
      return ev;
    },
    toggleKey: (target) => h.key(target, { key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true }),
  };
  return h;
}

describe('預覽：每個標籤各自記著', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
    h.open(A);
    h.open(B);
  });

  test('B 切到預覽：按鈕寫「編輯」、狀態列寫「預覽」、textarea 藏起來', () => {
    h.ui.clickEl(h.btn());
    assert.equal(h.previewing(), true);
    assert.equal(h.area().classList.contains('hidden'), true);
    assert.equal(h.btn().textContent, '編輯');
    assert.equal(h.doc.getElementById('edStatusPos').textContent, '預覽');
  });

  test('切到 A：A 還在編輯；再切回 B：B 照舊在預覽裡', () => {
    h.ui.clickEl(h.tab(A));
    assert.equal(h.previewing(), false);
    assert.equal(h.btn().textContent, '預覽');
    h.ui.clickEl(h.tab(B));
    assert.equal(h.previewing(), true);
    assert.equal(h.btn().textContent, '編輯');
  });

  test('預覽的滾動位置也按標籤記：B 滾到 120，切走再切回來還是 120', () => {
    h.preview().scrollTop = 120;
    h.preview().dispatchEvent(new h.ui.window.Event('scroll'));
    h.ui.clickEl(h.tab(A));
    h.area().scrollTop = 0;
    h.ui.clickEl(h.tab(B));
    assert.equal(h.preview().scrollTop, 120);
  });

  test('切回來的是預覽時焦點進預覽（方向鍵、翻頁鍵滾的是它）', () => {
    h.ui.clickEl(h.tab(A));
    h.ui.clickEl(h.tab(B));
    assert.equal(h.doc.activeElement, h.preview());
  });

  test('已經開著的再被開啟一次（工程頁再點一下）：照舊在預覽裡', () => {
    h.open(B);
    assert.equal(h.previewing(), true);
  });

  test('從另一塊搬過來（同一個路徑在右邊開啟）：照舊在預覽裡', () => {
    h.ui.post({ type: 'editorOpen', file: file(B, TEXT, { kind: 'character' }), pane: 'draft' });
    const draft = h.doc.querySelector('.wb-editor-draft');
    assert.equal(draft.querySelector('.ed-preview').classList.contains('hidden'), false);
    assert.equal(draft.querySelector('textarea.ed-area').classList.contains('hidden'), true);
  });

  test('按鈕提示寫著快捷鍵', () => {
    assert.match(h.btn().title, /Ctrl\+Shift\+V/);
  });
});

describe('預覽：Ctrl+Shift+V', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
    h.open(A);
  });

  test('正文裡按：切到預覽、攔下（不當貼上）、焦點進預覽', () => {
    h.area().focus();
    const ev = h.toggleKey(h.area());
    assert.equal(ev.defaultPrevented, true);
    assert.equal(h.previewing(), true);
    assert.equal(h.doc.activeElement, h.preview());
  });

  test('預覽裡再按：切回編輯、焦點回正文', () => {
    h.toggleKey(h.preview());
    assert.equal(h.previewing(), false);
    assert.equal(h.doc.activeElement, h.area());
  });

  test('頁面上（焦點不在輸入框裡）也切', () => {
    h.doc.activeElement.blur();
    h.toggleKey(h.doc.body);
    assert.equal(h.previewing(), true);
    h.toggleKey(h.doc.body);
    assert.equal(h.previewing(), false);
  });

  test('對話輸入框裡不攔（那裡是貼上為純文字）', () => {
    const chat = h.doc.getElementById('input');
    chat.focus();
    const ev = h.toggleKey(chat);
    assert.equal(ev.defaultPrevented, false);
    assert.equal(h.previewing(), false);
  });

  test('不是 Markdown 的檔案（.txt 章節）：按鈕藏著，這個鍵不攔', () => {
    h.open('chapters/001-雨夜.txt', '雨下了三天。', { kind: 'chapter' });
    assert.equal(h.btn().classList.contains('hidden'), true);
    h.area().focus();
    const ev = h.toggleKey(h.area());
    assert.equal(ev.defaultPrevented, false);
    assert.equal(h.previewing(), false);
  });

  test('輸入法組字中途不算', () => {
    h.ui.clickEl(h.tab(A));
    const ev = h.key(h.area(), { key: 'V', ctrlKey: true, shiftKey: true, isComposing: true });
    assert.equal(ev.defaultPrevented, false);
    assert.equal(h.previewing(), false);
  });
});

describe('預覽：切換時兩邊滾到同一處', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness({ shims: ['mirrorLayout', 'previewLayout'] });
    h.open(A);
  });

  test('預覽裡每一塊都記著行號：標題、兩段、兩個列表項', () => {
    h.ui.clickEl(h.btn());
    const marks = [...h.preview().querySelectorAll('[data-line]')].map((n) => `${n.tagName}:${n.dataset.line}-${n.dataset.lineEnd}`);
    assert.deepEqual(marks, ['H1:0-1', 'P:2-3', 'P:4-6', 'LI:7-8', 'LI:8-9']);
    h.ui.clickEl(h.btn());
  });

  test('編輯 → 預覽：編輯區頂上是第 4 行往下一半（4.5），預覽裡滾到那一段（4–5 行）的四分之一處', () => {
    h.area().focus();
    h.area().setSelectionRange(0, 0);
    h.area().scrollTop = 4 * LH + LH / 2;
    h.toggleKey(h.area());
    // 那一段：頂 = 4 × 40、高 = 2 × 40；4.5 行在它的 (4.5 − 4) / 2 處。
    assert.equal(h.preview().scrollTop, 4 * PH + ((4.5 - 4) / 2) * 2 * PH);
  });

  test('預覽 → 編輯：預覽滾到第 7 行那一項的一半（7.5），編輯區滾到 7.5 行', () => {
    h.preview().scrollTop = 7 * PH + PH / 2;
    h.toggleKey(h.preview());
    assert.equal(h.area().scrollTop, 7.5 * LH);
  });

  test('游標原來在第 0 行、滾完不在視口裡了：挪到視口頂上那一行（第 8 行）的行首', () => {
    const starts = [0];
    for (let i = 0; i < TEXT.length; i++) if (TEXT[i] === '\n') starts.push(i + 1);
    assert.equal(h.area().selectionStart, starts[8]);
  });

  test('游標在視口裡：切過去再切回來不動它', () => {
    h.area().scrollTop = 0;
    h.area().setSelectionRange(5, 5);
    h.area().dispatchEvent(new h.ui.window.Event('select'));
    h.toggleKey(h.area());
    h.toggleKey(h.preview());
    assert.equal(h.area().selectionStart, 5);
    assert.equal(h.area().scrollTop, 0);
  });

  test('預覽開著時磁碟上的新版進來：預覽重畫，滾動位置留著', () => {
    h.toggleKey(h.area());
    h.preview().scrollTop = 200;
    h.ui.post({ type: 'editorDiskChanged', file: file(A, `${TEXT}\n新加的一行\n`, { kind: 'character', hash: 'h2' }) });
    assert.match(h.preview().textContent, /新加的一行/);
    assert.equal(h.preview().scrollTop, 200);
    h.toggleKey(h.preview());
  });

  test('行數對得上：預覽裡最後一塊的行號在文字的行數之內', () => {
    h.toggleKey(h.area());
    const last = [...h.preview().querySelectorAll('[data-line]')].pop();
    assert.ok(Number(last.dataset.lineEnd) <= h.area().value.split('\n').length);
    assert.ok(LINES > 0);
    h.toggleKey(h.preview());
  });
});

describe('預覽：重新整理恢復時記著（⚑）', { skip: JSDOM_SKIP }, () => {
  const URL = `http://localhost/?project=${encodeURIComponent('/書/青雲劍錄')}`;
  const KEY = `novelforge.editor.v1@${'/書/青雲劍錄'}`;

  test('在預覽裡的那一份記進快照；重新整理後那一份開啟時照舊在預覽裡，別的在編輯', () => {
    const h = harness({ url: URL });
    h.open(A);
    h.open(B);
    h.ui.clickEl(h.btn());
    const saved = JSON.parse(h.ui.window.localStorage.getItem(KEY));
    const open = saved.panes.main.open;
    assert.deepEqual(
      open.map((f) => [f.path, f.markdownPreview === true]),
      [
        [A, false],
        [B, true],
      ]
    );

    const again = harness({ url: URL, storage: { [KEY]: JSON.stringify(saved) } });
    assert.deepEqual(
      again.ui.sent.filter((m) => m.type === 'openEditor').map((m) => [m.path, 'markdownPreview' in m]),
      [
        [A, false],
        [B, false],
      ],
      '標記只記在前端，不隨開啟請求發出去'
    );
    again.open(A);
    again.open(B);
    assert.equal(again.previewing(), true, '重新整理前在預覽裡的 B');
    again.ui.clickEl(again.tab(A));
    assert.equal(again.previewing(), false);
  });
});
