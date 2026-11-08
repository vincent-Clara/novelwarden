/**
 * 切換檔案時游標與滾動各記各的（獨立版內建編輯器，`media/src/editor/pane.ts` 的 `renderAll` / `stashView` / `restoreView`，
 * 關掉之後的那一份在 `store.ts` 的 `rememberView` / `takeView`）。
 *
 * jsdom 沒有排版：`scrollTop` 寫什麼讀回什麼，滾動事件不會自己來——這裡直接寫 textarea 的 `scrollTop` 當「滾到了這裡」。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 新開一份 | 從頂上開始，不沿用上一份的滾動偏移 |
 * | 從別處再開啟一份開著的（工程頁、檔案頁、「轉到…」） | 回到它自己的游標與滾動；切走的那一份的也留住，點標籤回去還在 |
 * | 臨時標籤被換掉、再單擊開啟 | 回到換掉時的位置 |
 * | 關掉再開啟 | 回到關掉時的位置；只放回一次（之後由開著的那一份自己記） |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file } = require('../../helpers/dom');

const SHIMS = ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'];
const TEXT = Array.from({ length: 200 }, (_, i) => `第 ${i + 1} 段。`).join('\n\n');
const A = 'chapters/001-楔子.md';
const B = 'chapters/002-客棧.md';
const C = 'chapters/003-夜訪.md';

function harness() {
  const ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: SHIMS });
  ui.window.__nfToast = () => {};
  const doc = ui.doc;
  const h = {
    ui,
    area: () => doc.getElementById('edArea'),
    open: (p, extra) => ui.post({ type: 'editorOpen', file: file(p, TEXT, { kind: 'chapter' }), ...extra }),
    tab: (p) => [...doc.querySelectorAll('#wbEditor .ed-tab')].find((t) => t.dataset.path === p),
    /** 滾到 `top`、游標放在 `caret`（作者在這一份裡看到這兒、點在這兒）。 */
    at(top, caret) {
      h.area().setSelectionRange(caret, caret);
      h.area().scrollTop = top;
    },
    where: () => ({ top: h.area().scrollTop, caret: h.area().selectionStart }),
  };
  return h;
}

describe('切換檔案：游標與滾動各記各的', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
    h.open(A);
    h.at(300, 120);
  });

  test('新開一份：從頂上開始，不沿用上一份的偏移', () => {
    h.open(B);
    assert.deepEqual(h.where(), { top: 0, caret: 0 });
    h.at(900, 400);
  });

  test('從別處再開啟一份開著的：回到它自己的位置', () => {
    h.open(A);
    assert.deepEqual(h.where(), { top: 300, caret: 120 });
  });

  test('切走的那一份也留住了：點標籤回去還在', () => {
    h.ui.clickEl(h.tab(B));
    assert.deepEqual(h.where(), { top: 900, caret: 400 });
    h.ui.clickEl(h.tab(A));
    assert.deepEqual(h.where(), { top: 300, caret: 120 });
  });
});

describe('關掉 / 換掉之後再開啟：回到原處', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
  });

  test('臨時標籤被換掉、再單擊開啟：回到換掉時的位置', () => {
    h.open(A, { preview: true });
    h.at(450, 200);
    h.open(B, { preview: true });
    assert.equal(h.tab(A), undefined, '臨時標籤被換掉了');
    assert.deepEqual(h.where(), { top: 0, caret: 0 });
    h.open(A, { preview: true });
    assert.deepEqual(h.where(), { top: 450, caret: 200 });
  });

  test('關掉再開啟：回到關掉時的位置', () => {
    h.open(C);
    h.at(600, 300);
    h.ui.clickEl(h.tab(C).querySelector('.ed-tab-close'));
    assert.equal(h.tab(C), undefined, '關掉了');
    h.open(C);
    assert.deepEqual(h.where(), { top: 600, caret: 300 });
  });

  test('只放回一次：開著時由它自己記，換個位置再切回來是新的位置', () => {
    h.at(60, 10);
    h.ui.clickEl(h.tab(A));
    h.ui.clickEl(h.tab(C));
    assert.deepEqual(h.where(), { top: 60, caret: 10 });
  });
});
