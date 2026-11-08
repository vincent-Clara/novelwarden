/**
 * 章節條（W6 章節工作臺，獨立版）：編輯區里正開著某一章的正文或細綱時，主區頂上一條——
 * 這一章在哪一步、寫了多少，以及對這一章能做的幾件事。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 開著角色卡、大綱這類檔案 | 不出現（它說的是「這一章」） |
 * | 開著某一章的正文 | 出現，寫「第 2 章《入鎮》 · 待定稿 · 2980 / 3000 字」 |
 * | 按鈕亮滅 | 按這一章的狀態：沒正文只亮「寫這一章」，有正文亮「接著寫 / 重寫 / 定稿」 |
 * | 點按鈕 | 發 `chapterAction`，帶這一行的主路徑與動作 |
 * | 提示裡寫呼叫次數 | 與主按鈕同一個數（D16） |
 * | 另一份沒開著 | 「並排看細綱 / 正文」把它開到另一塊 |
 * | 開著細綱 | 同樣認得出是哪一章 |
 * | 章節索引更新 | 條上的字數跟著變 |
 *
 * 資料來自章節索引（`chapterIndex` 訊息，哪個頁籤都推）與編輯器自己的「正在編輯哪個檔案」。
 * 上一章 / 下一章在 chapterNav.test.js。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file, sampleTree, sampleChapterIndex } = require('../../helpers/dom');

describe('章節條', { skip: JSDOM_SKIP }, () => {
  let ui;
  const bar = () => ui.doc.getElementById('edChapterBar');
  const info = () => bar().querySelector('.ed-chapter-info').textContent;
  const btn = (action) => bar().querySelector(`button[data-action="${action}"]`);
  const pair = () => bar().querySelector('.ed-chapter-pair');

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: ['pointerCapture', 'confirm'] });
    ui.post({ type: 'chapterIndex', chapters: sampleChapterIndex() });
  });

  test('一開始沒有開著章節：不出現', () => {
    assert.ok(bar(), '沒有章節條的 DOM');
    assert.ok(bar().classList.contains('hidden'));
  });

  test('開著角色卡：不出現', () => {
    ui.post({ type: 'editorOpen', file: file('.novelwarden/characters/林昭.md', '# 林昭') });
    assert.ok(bar().classList.contains('hidden'));
  });

  test('開著第 2 章的正文：寫這一章在哪一步、寫了多少', () => {
    ui.post({ type: 'editorOpen', file: file('chapters/002-入鎮.md', '# 入鎮\n\n正文') });
    assert.ok(!bar().classList.contains('hidden'));
    assert.equal(info(), '第 2 章《入鎮》 · 待同步 · 2980 / 3000 字');
  });

  test('有正文：接著寫、重寫（要有細綱）、定稿按狀態亮滅；寫這一章不亮', () => {
    assert.equal(btn('write').disabled, true);
    assert.equal(btn('continue').disabled, false);
    // 第 2 章是老工程裡的章，沒有細綱：重寫沒有依據。
    assert.equal(btn('rewrite').disabled, true);
    assert.equal(btn('finalize').disabled, false);
  });

  test('提示裡寫呼叫次數（與主按鈕同一個數）', () => {
    assert.match(btn('continue').title, /預計 1–2 次呼叫，最多 9 次/);
    // 定稿 = 照正文更新細綱 + 出場角色的當前狀態（D17）+ 敘事線 1–3 次（敘事線重做：認事件每次都跑）+ 故事時間；
    // 2026-10-25 起每次寫完都轉寫一次、不合格重轉一次。
    assert.match(btn('finalize').title, /預計 6–12 次呼叫，最多 18 次/);
  });

  test('點「接著寫」發 chapterAction', () => {
    ui.clickEl(btn('continue'));
    const sent = ui.last('chapterAction');
    assert.deepEqual({ plotRelPath: sent.plotRelPath, action: sent.action }, { plotRelPath: 'chapters/002-入鎮.md', action: 'continue' });
  });

  test('這一章沒有細綱：不給「並排看細綱」', () => {
    assert.equal(pair(), null);
  });

  test('開著第 4 章的細綱（還沒有正文）：認得出是哪一章，只亮「寫這一章」', () => {
    ui.post({ type: 'editorOpen', file: file('.novelwarden/summaries/004-北行.md', '# 第4章 北行') });
    assert.equal(info(), '第 4 章《北行》 · 待寫正文 · 還沒有正文');
    assert.equal(btn('write').disabled, false);
    assert.equal(btn('continue').disabled, true);
    assert.equal(btn('finalize').disabled, true);
    ui.clickEl(btn('write'));
    assert.equal(ui.last('chapterAction').action, 'write');
  });

  test('第 5 章細綱只是骨架：寫這一章不亮，提示說先排細綱', () => {
    ui.post({ type: 'editorOpen', file: file('.novelwarden/summaries/005-赤星.md', '# 第5章 赤星') });
    assert.equal(btn('write').disabled, true);
    assert.match(btn('write').title, /先把這一章的細綱排好/);
  });

  test('開著第 3 章正文、細綱沒開：「並排看細綱」開到第二塊', () => {
    ui.post({ type: 'editorOpen', file: file('chapters/003-夜訪.md', '# 夜訪\n\n正文') });
    assert.equal(pair().textContent, '並排看細綱');
    ui.clickEl(pair());
    const open = ui.last('openEditor');
    assert.deepEqual({ path: open.path, pane: open.pane }, { path: '.novelwarden/summaries/003-夜訪.md', pane: 'draft' });
  });

  test('細綱已經並排開著：不再給這顆按鈕', () => {
    ui.post({ type: 'editorOpen', file: file('.novelwarden/summaries/003-夜訪.md', '# 第3章 夜訪'), pane: 'draft' });
    ui.post({ type: 'editorOpen', file: file('chapters/003-夜訪.md', '# 夜訪\n\n正文') });
    assert.equal(pair(), null);
  });

  test('章節索引更新（寫完了一章）：條上的字數跟著變', () => {
    const tree = sampleTree();
    tree.plots[2].wordCount = 3100;
    tree.plots[2].targetWords = 3000;
    ui.post({ type: 'chapterIndex', chapters: sampleChapterIndex(tree.plots) });
    assert.equal(info(), '第 3 章《夜訪》 · 已完成 · 3100 / 3000 字');
  });
});
