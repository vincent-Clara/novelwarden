/**
 * 獨立版內建編輯器：主區/草稿區兩塊編輯區，以及標籤右鍵選單與檔案搬家。
 *
 * 遷自 scripts/smoke-view.js 的這兩節：
 *   == 內建編輯器：兩塊編輯區 ==（1390） == 內建編輯器：右鍵選單與標籤搬家 ==（2441）
 *
 * 走的是 html.ts 的 body：editor.js 只在有 `#wbEditor` 時才跑，外掛形態的
 * body 裡沒有那塊 DOM，它會直接退出——所以覆蓋它必須用獨立版的結構。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file } = require('../../helpers/dom');

describe('內建編輯器：兩塊編輯區', { skip: JSDOM_SKIP }, () => {
  let ui;
  const tabsOf = (pane) => [...pane.querySelectorAll('.ed-tab-name')].map((n) => n.textContent);

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['editor.js'], shims: ['pointerCapture', 'confirm'] });
  });

  test('一開始只有主區一塊', () => {
    assert.equal(ui.panes().length, 1, `${ui.panes().length} 塊`);
  });

  test('草稿分隔條藏著', () => {
    assert.ok(ui.doc.getElementById('wbDraftResizer').classList.contains('hidden'));
  });

  // ---- 主區開啟正文
  test('正文開在主區', () => {
    ui.post({
      type: 'editorOpen',
      file: file('chapters/001-楔子.md', '# 楔子\n\n正文', { draftPath: 'drafts/001-楔子.md' }),
    });
    assert.equal(tabsOf(ui.panes()[0]).join(','), '001-楔子.md', tabsOf(ui.panes()[0]).join(','));
  });

  test('是章節時顯示「草稿」按鈕', () => {
    assert.ok(!ui.doc.getElementById('edDraftBtn').classList.contains('hidden'));
  });

  // 2026-10-23：草稿旁邊多一顆「細綱」，同樣只對章節給，傳章節路徑（細綱在哪、要不要按模板建由後端定）。
  test('是章節時顯示「細綱」按鈕，排在「草稿」前面', () => {
    const plot = ui.doc.getElementById('edPlotBtn');
    assert.ok(!plot.classList.contains('hidden'));
    assert.equal(plot.nextElementSibling, ui.doc.getElementById('edDraftBtn'));
  });

  test('點「細綱」發 openPlot，帶的是章節路徑', () => {
    ui.clickEl(ui.doc.getElementById('edPlotBtn'));
    const req = ui.last('openPlot');
    assert.ok(req, '沒發出 openPlot');
    assert.equal(req.path, 'chapters/001-楔子.md', JSON.stringify(req));
  });

  test('點「草稿」發 openDraft，帶的是章節路徑', () => {
    ui.clickEl(ui.doc.getElementById('edDraftBtn'));
    const req = ui.last('openDraft');
    assert.ok(req, '沒發出 openDraft');
    assert.equal(req.path, 'chapters/001-楔子.md', JSON.stringify(req));
  });

  // ---- 後端回一份草稿，開在第二塊
  test('草稿區被建立出來', () => {
    ui.post({
      type: 'editorOpen',
      pane: 'draft',
      file: file('drafts/001-楔子.md', '# 楔子 · 草稿\n\n'),
    });
    assert.equal(ui.panes().length, 2, `${ui.panes().length} 塊`);
  });

  test('第二塊帶 wb-editor-draft', () => {
    assert.ok(ui.panes()[1].classList.contains('wb-editor-draft'));
  });

  test('草稿分隔條露出來', () => {
    assert.ok(!ui.doc.getElementById('wbDraftResizer').classList.contains('hidden'));
  });

  test('正文仍在主區', () => {
    assert.equal(tabsOf(ui.panes()[0]).join(','), '001-楔子.md', tabsOf(ui.panes()[0]).join(','));
  });

  test('草稿在草稿區', () => {
    assert.equal(tabsOf(ui.panes()[1]).join(','), '001-楔子.md', tabsOf(ui.panes()[1]).join(','));
  });

  // ---- 儲存回執按 path 找對應的那一塊，別把 draftPath 沖掉
  test('儲存後「草稿」按鈕還在', () => {
    ui.post({
      type: 'editorSaved',
      file: file('chapters/001-楔子.md', '# 楔子\n\n改過了', { draftPath: 'drafts/001-楔子.md' }),
    });
    assert.ok(!ui.doc.getElementById('edDraftBtn').classList.contains('hidden'));
  });

  // ---- 非章節檔案不顯示「草稿」按鈕
  test('非章節不顯示「草稿」「細綱」按鈕', () => {
    ui.post({ type: 'editorOpen', file: file('.novelwarden/style.md', '# 文風指南') });
    assert.ok(ui.doc.getElementById('edDraftBtn').classList.contains('hidden'));
    assert.ok(ui.doc.getElementById('edPlotBtn').classList.contains('hidden'));
  });

  // ---- 一個路徑只屬於一塊：把主區的正文改開到草稿區
  test('主區交出了這個路徑，只剩另一份檔案', () => {
    ui.post({ type: 'editorOpen', pane: 'draft', file: file('chapters/001-楔子.md', '# 楔子\n\n改過了') });
    assert.equal(tabsOf(ui.panes()[0]).join(','), 'style.md', tabsOf(ui.panes()[0]).join(','));
  });

  test('草稿區現在有兩個標籤', () => {
    assert.equal(ui.panes()[1].querySelectorAll('.ed-tab').length, 2, tabsOf(ui.panes()[1]).join(','));
  });
});

describe('內建編輯器：右鍵選單與標籤搬家', { skip: JSDOM_SKIP }, () => {
  let ui;
  let tabItems;
  let area;
  let areaMenu;
  const tabs = () => [...ui.doc.querySelectorAll('.ed-tab')];
  const btn = (menu, label) => [...menu.querySelectorAll('button')].find((b) => b.textContent === label);

  before(() => {
    // 原指令碼這一節用的是 mountExplorer（view.js + editor.js + explorer.js）：
    // 右鍵選單引擎在 view.js 裡，`window.__nfContextMenu` 是兩邊的唯一介面。
    ui = mount({
      body: 'standalone',
      scripts: ['view.js', 'editor.js', 'explorer.js'],
      shims: ['clipboard', 'scrollIntoView', 'pointerCapture', 'confirm'],
    });
    ui.post({ type: 'editorOpen', file: file('a.md', '甲的內容') });
    ui.post({ type: 'editorOpen', file: file('b.md', '乙的內容') });
  });

  test('開啟了兩個標籤', () => {
    assert.equal(tabs().length, 2, String(tabs().length));
  });

  // ---- 標籤選單
  test('標籤選單含關閉/關閉右側/關閉其它', () => {
    tabItems = ui.itemsOf(ui.rightClick(tabs()[0]));
    assert.ok(
      tabItems.includes('關閉') &&
      tabItems.some((l) => l.startsWith('關閉右側')) &&
      tabItems.some((l) => l.startsWith('關閉其它')),
      JSON.stringify(tabItems));
  });

  test('關閉其它後只剩一個標籤', () => {
    ui.clickEl(btn(ui.rightClick(tabs()[0]), tabItems.find((l) => l.startsWith('關閉其它'))));
    assert.equal(tabs().length, 1, String(tabs().length));
    ui.closeMenu();
  });

  // ---- 正文區選單
  test('正文區選單含剪下/複製/貼上/全選', () => {
    area = ui.doc.getElementById('edArea');
    areaMenu = ui.rightClick(area);
    assert.ok(['剪下', '複製', '貼上', '全選'].every((l) => ui.itemsOf(areaMenu).includes(l)),
      JSON.stringify(ui.itemsOf(areaMenu)));
  });

  test('無選中時剪下/複製置灰', () => {
    assert.ok(btn(areaMenu, '剪下').disabled && btn(areaMenu, '複製').disabled);
    ui.closeMenu();
  });

  test('全選選中全文', () => {
    ui.clickEl(btn(ui.rightClick(area), '全選'));
    assert.equal(area.selectionStart, 0, `${area.selectionStart}-${area.selectionEnd}/${area.value.length}`);
    assert.equal(area.selectionEnd, area.value.length,
      `${area.selectionStart}-${area.selectionEnd}/${area.value.length}`);
    ui.closeMenu();
  });

  // ---- 標籤搬家：未儲存草稿原樣帶走
  test('搬家後請求開啟新路徑', () => {
    area.value = '甲的內容，改了一半';
    area.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    ui.window.dispatchEvent(new ui.window.CustomEvent('nf-files-moved', { detail: { from: 'a.md', to: 'sub/a.md' } }));
    const reopen = [...ui.sent].reverse().find((m) => m.type === 'openEditor' && m.path === 'sub/a.md');
    assert.ok(reopen, JSON.stringify(reopen));
    assert.equal(reopen.pane, 'main', JSON.stringify(reopen));
  });

  // hash 變了也沒關係：moved 標記豁免基線檢查。
  test('搬家後只剩一個標籤且是新路徑', () => {
    ui.post({ type: 'editorOpen', file: Object.assign(file('sub/a.md', '甲的內容'), { hash: 'h-other' }) });
    assert.equal(tabs().length, 1, tabs().map((t) => t.textContent).join(','));
    assert.ok(tabs()[0].textContent.includes('a'), tabs().map((t) => t.textContent).join(','));
  });

  test('未儲存草稿跟著搬', () => {
    assert.equal(ui.doc.getElementById('edArea').value, '甲的內容，改了一半',
      ui.doc.getElementById('edArea').value);
  });

  test('草稿仍是髒標記', () => {
    assert.ok(tabs()[0].classList.contains('dirty'));
  });
});

/**
 * 已開啟的檔案被再次開啟（落盤後自動開啟、工程頁再點一次）：從前一律當成
 * reload，把編輯器裡沒儲存的修改直接沖掉。現在只有「還原」發起的那一次才衝。
 */
describe('內建編輯器：再次開啟不沖掉未儲存的修改', { skip: JSDOM_SKIP }, () => {
  let ui;
  const area = () => ui.doc.getElementById('edArea');
  const conflictBar = () => ui.doc.getElementById('edConflict');
  const type = (text) => {
    area().value = text;
    area().dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  };
  const open = (text, hash) =>
    ui.post({ type: 'editorOpen', file: file('chapters/001-楔子.md', text, hash ? { hash } : undefined) });

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['editor.js'], shims: ['pointerCapture', 'confirm'] });
    open('原文');
    type('原文，改了一半');
  });

  test('磁碟沒變：草稿原樣留著，不掛衝突條', () => {
    open('原文');
    assert.equal(area().value, '原文，改了一半', area().value);
    assert.ok(conflictBar().classList.contains('hidden'));
  });

  test('磁碟變了：草稿仍留著，掛衝突條且不說「儲存已取消」', () => {
    open('剛寫入的新版', 'h-new');
    assert.equal(area().value, '原文，改了一半', area().value);
    assert.ok(!conflictBar().classList.contains('hidden'));
    const text = ui.doc.getElementById('edConflictText').textContent;
    assert.ok(text.includes('沒有覆蓋') && !text.includes('儲存已取消'), text);
  });

  test('選「用磁碟版本覆蓋」才換成新版', () => {
    ui.clickEl(ui.doc.getElementById('edConflictTake'));
    assert.equal(area().value, '剛寫入的新版', area().value);
    assert.ok(conflictBar().classList.contains('hidden'));
  });

  test('點「還原」之後的那次開啟照舊沖掉修改', async () => {
    type('又改了一筆');
    ui.clickEl(ui.doc.getElementById('edRevertBtn'));
    // 有未儲存的修改：先在頁內對話方塊裡問一句（不再是 window.confirm）。
    await ui.answer('放棄修改');
    assert.ok(ui.last('reloadFile'), '沒發出 reloadFile');
    open('磁碟上的版本', 'h-disk');
    assert.equal(area().value, '磁碟上的版本', area().value);
    assert.ok(conflictBar().classList.contains('hidden'));
  });
});
