/**
 * 對話頁「加入選區」在獨立版：宿主取不到網頁裡的選區，從前點它一律彈貼上框——那顆按鈕比內建編輯器早一天寫出來，
 * 之後一直沒接上。現在前端先問內建編輯器（`nf-selection-query`，回答在 `media/src/editor/index.ts`）。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 編輯器裡選著字 | `addSelection` 帶上 `selection`：路徑、去掉首尾空白的文字、1-based 閉區間行號 |
 * | 多選了首尾的換行 | 行號按去掉空白之後的那一段算，不多出一行 |
 * | 沒選中 | 照舊發不帶選區的 `addSelection`（後端交給宿主彈貼上框） |
 * | Markdown 預覽裡 | 藏著的 textarea 的選區作者看不見，不算 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file, viewState } = require('../../helpers/dom');

describe('「加入選區」帶上內建編輯器的選區', { skip: JSDOM_SKIP }, () => {
  let ui;
  const area = () => ui.doc.getElementById('edArea');
  const selBtn = () => ui.doc.getElementById('selBtn');
  const tab = (name) =>
    [...ui.doc.querySelectorAll('#edTabs .ed-tab')].find((t) => t.querySelector('.ed-tab-name').textContent === name);
  const clickSel = () => {
    ui.clickEl(selBtn());
    return ui.last('addSelection');
  };

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'] });
    ui.post({ type: 'state', state: viewState() });
    ui.post({ type: 'busy', value: false });
    ui.post({ type: 'editorOpen', file: file('chapters/001-雨夜.md', '第一行\n雨下了一夜。\n林昭推門進來。\n第四行', { kind: 'chapter' }) });
  });

  test('按鈕可點', () => {
    assert.equal(selBtn().disabled, false);
  });

  test('選著字：帶上路徑、文字與行號', () => {
    const value = area().value;
    const from = value.indexOf('雨下');
    const to = value.indexOf('進來。') + '進來。'.length;
    area().setSelectionRange(from, to);
    const msg = clickSel();
    // 訊息物件出自 jsdom 那個 realm，原型對不上 deepStrictEqual，過一道 JSON。
    assert.deepEqual(JSON.parse(JSON.stringify(msg.selection)), {
      relPath: 'chapters/001-雨夜.md',
      text: '雨下了一夜。\n林昭推門進來。',
      start: 2,
      end: 3,
    }, JSON.stringify(msg));
  });

  test('多選了首尾的換行：文字去掉空白，行號不多出一行', () => {
    const value = area().value;
    const from = value.indexOf('雨下') - 1; // 帶上第一行末尾的換行
    const to = value.indexOf('第四行'); // 帶上第三行末尾的換行
    area().setSelectionRange(from, to);
    const msg = clickSel();
    assert.equal(msg.selection?.text, '雨下了一夜。\n林昭推門進來。', JSON.stringify(msg));
    assert.equal(msg.selection?.start, 2, JSON.stringify(msg));
    assert.equal(msg.selection?.end, 3, JSON.stringify(msg));
  });

  test('沒選中：不帶選區，交給宿主', () => {
    area().setSelectionRange(2, 2);
    const msg = clickSel();
    assert.ok(msg, '沒發出 addSelection');
    assert.equal(msg.selection, undefined, JSON.stringify(msg));
  });

  test('Markdown 預覽裡：不算選區', () => {
    ui.post({ type: 'editorOpen', file: file('.novelwarden/characters/林昭.md', '# 林昭\n\n主角。', { kind: 'character' }) });
    ui.clickEl(tab('林昭.md'));
    area().setSelectionRange(0, area().value.length);
    ui.clickEl(ui.doc.getElementById('edPreviewBtn'));
    const msg = clickSel();
    assert.equal(msg.selection, undefined, JSON.stringify(msg));
  });
});
