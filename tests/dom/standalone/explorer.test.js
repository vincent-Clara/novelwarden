/**
 * 獨立版「檔案」頁（資源管理器）：懶載入目錄樹、開啟檔案的分流、
 * 截斷與讀失敗的降級，以及剪貼簿與右鍵選單。
 *
 * 遷自 scripts/smoke-view.js 的這兩節：
 *   == 資源管理器（獨立版「檔案」頁）==（1640） == 檔案頁：剪貼簿與右鍵選單 ==（2379）
 *
 * explorer.js 只在有 `#filesBody` 時才跑，所以必須用 html.ts 的 body；
 * view.js 也一起裝上——右鍵選單引擎在那邊，`window.__nfContextMenu`
 * 是兩個檔案之間的唯一介面，測試要覆蓋到它真的被接上了。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, listing } = require('../../helpers/dom');

const EXPLORER = {
  body: 'standalone',
  scripts: ['view.js', 'editor.js', 'explorer.js'],
  shims: ['clipboard', 'scrollIntoView', 'pointerCapture', 'confirm'],
};

describe('資源管理器（獨立版「檔案」頁）', { skip: JSDOM_SKIP }, () => {
  let ui;
  let expanded;
  let collapsed;
  let menu;

  before(() => {
    ui = mount(EXPLORER);
  });

  // 掛載即要一份工程根：切到「檔案」頁時樹已經在了，不必等一次往返。
  test('掛載後請求工程根', () => {
    const first = ui.last('listDir');
    assert.ok(first, '沒發出 listDir');
    assert.ok(first.dirs.includes(''), JSON.stringify(first));
  });

  // 這一條是這個功能存在的理由：工程頁永遠看不見 .novelwarden。
  test('點開頭的資料夾列得出來', () => {
    ui.post({
      type: 'dirListings',
      listings: [listing('', { '.novelwarden': 'dir', chapters: 'dir', 'README.md': 'file' })],
    });
    assert.ok(ui.names().includes('.novelwarden'), ui.names().join(','));
  });

  test('點開頭的行壓暗顯示', () => {
    assert.ok(ui.rows().some((r) => r.textContent.includes('.novelwarden') && r.classList.contains('fx-dotted')));
  });

  test('目錄在檔案之前', () => {
    assert.equal(ui.names().join(','), '.novelwarden,chapters,README.md', ui.names().join(','));
  });

  // ---- 展開一個目錄：懶載入，展開哪個才要哪個
  test('展開後請求那個目錄', () => {
    ui.sent.length = 0;
    ui.click(ui.rows().find((r) => r.textContent.includes('.novelwarden')));
    expanded = ui.last('listDir');
    assert.ok(expanded, '沒發出 listDir');
    assert.ok(expanded.dirs.includes('.novelwarden'), JSON.stringify(expanded));
  });

  test('請求帶的是全量展開集合', () => {
    assert.ok(expanded.dirs.includes(''), JSON.stringify(expanded));
  });

  test('還沒回資料時顯示載入中', () => {
    assert.ok(ui.names().some((n) => n === '載入中…'), ui.names().join(','));
  });

  test('子項掛在父目錄下', () => {
    ui.post({
      type: 'dirListings',
      listings: [listing('.novelwarden', { summaries: 'dir', 'project.json': 'file' })],
    });
    assert.equal(ui.names().join(','), '.novelwarden,summaries,project.json,chapters,README.md',
      ui.names().join(','));
  });

  test('子項有縮排', () => {
    assert.notEqual(ui.rows()[1].style.paddingLeft, ui.rows()[0].style.paddingLeft,
      `${ui.rows()[0].style.paddingLeft} vs ${ui.rows()[1].style.paddingLeft}`);
  });

  // ---- 摺疊：子目錄一併收起，再展開時不該憑空還開著
  test('摺疊後不再關注該目錄', () => {
    ui.sent.length = 0;
    ui.click(ui.rows().find((r) => r.textContent.includes('summaries')));
    ui.click(ui.rows().find((r) => r.textContent.includes('.novelwarden')));
    collapsed = ui.last('listDir');
    assert.ok(collapsed, '沒發出 listDir');
    assert.ok(!collapsed.dirs.includes('.novelwarden'), JSON.stringify(collapsed));
  });

  test('子目錄跟著一起收起', () => {
    assert.ok(!collapsed.dirs.includes('.novelwarden/summaries'), JSON.stringify(collapsed));
  });

  // ---- 點檔案：可編輯的進內建編輯器
  test('點文字檔案發 openEditor', () => {
    ui.sent.length = 0;
    ui.click(ui.rows().find((r) => r.textContent.includes('README.md')));
    assert.ok(ui.last('openEditor'), JSON.stringify(ui.sent));
    assert.equal(ui.last('openEditor').path, 'README.md', JSON.stringify(ui.sent));
  });

  // ---- 二進位制檔案：不撞一個必然失敗的 openEditor，直接交系統程式
  test('點不可編輯的檔案走 openExternal', () => {
    ui.post({
      type: 'dirListings',
      listings: [
        Object.assign(listing('', { '封面.png': 'file' }), {
          entries: [{ kind: 'file', name: '封面.png', relPath: '封面.png', editable: false, bytes: 9, modified: 0 }],
        }),
      ],
    });
    ui.sent.length = 0;
    ui.click(ui.rows()[0]);
    assert.ok(ui.last('openExternal'), JSON.stringify(ui.sent));
    assert.equal(ui.last('openExternal').path, '封面.png', JSON.stringify(ui.sent));
  });

  test('不可編輯的行置灰', () => {
    assert.ok(ui.rows()[0].classList.contains('fx-binary'));
  });

  // ---- 高亮跟著編輯器走（點章節、採納寫入也會開檔案，不只這棵樹）
  test('編輯器開啟誰就高亮誰', () => {
    ui.post({ type: 'dirListings', listings: [listing('', { 'a.md': 'file', 'b.md': 'file' })] });
    ui.post({ type: 'editorOpen', file: { path: 'b.md', name: 'b.md', text: '', hash: 'h', bytes: 0 } });
    assert.ok(
      ui.rows().filter((r) => r.classList.contains('active')).map((r) => r.textContent.trim()).join(',').includes('b.md'),
      ui.names().join(','));
  });

  // ---- 不靜默截斷
  test('截斷時如實告知', () => {
    ui.post({
      type: 'dirListings',
      listings: [Object.assign(listing('', { 'a.md': 'file' }), { truncated: 3000 })],
    });
    assert.ok(ui.names().some((n) => n.includes('未列出')), ui.names().join(','));
  });

  // ---- 讀不動的目錄降級成一行提示，不炸整頁
  test('讀失敗顯示原因', () => {
    ui.post({
      type: 'dirListings',
      listings: [{ relPath: '', entries: [], truncated: 0, error: '目錄不存在（可能剛被刪除或改名）' }],
    });
    assert.ok(ui.names().some((n) => n.includes('目錄不存在')), ui.names().join(','));
  });

  test('讀失敗不拋異常把樹清空', () => {
    assert.equal(ui.rows().length, 1, `${ui.rows().length}`);
  });

  // ---- 右鍵複用 view.js 的選單引擎（另起一套會兩層選單一起彈）
  test('右鍵彈出選單', () => {
    ui.post({ type: 'dirListings', listings: [listing('', { 'a.md': 'file' })] });
    ui.rows()[0].dispatchEvent(new ui.window.MouseEvent('contextmenu', { bubbles: true }));
    menu = ui.doc.querySelector('.ctx-menu');
    assert.ok(menu);
  });

  test('選單裡有「開啟」', () => {
    assert.ok(menu && [...menu.querySelectorAll('button')].some((b) => b.textContent === '開啟'),
      menu && [...menu.querySelectorAll('button')].map((b) => b.textContent).join(','));
    ui.closeMenu();
  });
});

describe('檔案頁：剪貼簿與右鍵選單', { skip: JSDOM_SKIP }, () => {
  let ui;
  let written;
  let fileItems;
  const btn = (menu, label) => [...menu.querySelectorAll('button')].find((b) => b.textContent === label);
  // render() 會整批重建行，每次操作後都要重新按名字找行。
  const fileRowOf = (name) => ui.rows().find((r) => r.textContent.includes(name));

  before(() => {
    ui = mount(EXPLORER);
    written = [];
    ui.window.navigator.clipboard = { writeText: (t) => { written.push(t); return Promise.resolve(); } };
    ui.doc.getElementById('pane-files').classList.add('active');
    ui.post({ type: 'dirListings', listings: [listing('', { 子目錄: 'dir', 'a.md': 'file' })] });
  });

  test('檔案行選單含剪下/複製/貼上/重新命名', () => {
    fileItems = ui.itemsOf(ui.rightClick(fileRowOf('a.md')));
    assert.ok(['剪下', '複製', '貼上', '重新命名'].every((l) => fileItems.includes(l)), JSON.stringify(fileItems));
  });

  test('沒有剪貼簿時貼上置灰', () => {
    assert.ok(btn(ui.rightClick(fileRowOf('a.md')), '貼上').disabled);
    ui.closeMenu();
  });

  // 複製：內部登記 + 路徑外送系統剪貼簿。
  test('複製把路徑寫進系統剪貼簿', () => {
    ui.clickEl(btn(ui.rightClick(fileRowOf('a.md')), '複製'));
    assert.ok(written.includes('a.md'), JSON.stringify(written));
  });

  test('貼上變為可用', () => {
    assert.ok(!btn(ui.rightClick(fileRowOf('a.md')), '貼上').disabled);
    ui.closeMenu();
  });

  // 在資料夾行上貼上：落點是該資料夾。
  test('貼上發 fileAction', () => {
    ui.clickEl(btn(ui.rightClick(fileRowOf('子目錄')), '貼上'));
    const pasteMsg = ui.last('fileAction');
    assert.ok(pasteMsg, '沒發出 fileAction');
    assert.equal(pasteMsg.action, 'paste', JSON.stringify(pasteMsg));
    assert.equal(pasteMsg.op, 'copy', JSON.stringify(pasteMsg));
    assert.equal(pasteMsg.relPaths.join(','), 'a.md', JSON.stringify(pasteMsg));
    assert.equal(pasteMsg.targetDir, '子目錄', JSON.stringify(pasteMsg));
  });

  // 複製態在貼上後保留（可再粘）；重新命名走 renameAny。
  test('複製態貼上後保留', () => {
    assert.ok(!btn(ui.rightClick(fileRowOf('子目錄')), '貼上').disabled);
    ui.closeMenu();
  });

  test('重新命名發 renameAny', () => {
    ui.clickEl(btn(ui.rightClick(fileRowOf('a.md')), '重新命名'));
    const ren = ui.last('fileAction');
    assert.ok(ren, '沒發出 fileAction');
    assert.equal(ren.action, 'renameAny', JSON.stringify(ren));
    assert.equal(ren.relPath, 'a.md', JSON.stringify(ren));
  });

  // 剪下 + move 完成後清除剪下態。
  test('剪下後行帶 fx-cut 標記', () => {
    ui.clickEl(btn(ui.rightClick(fileRowOf('a.md')), '剪下'));
    assert.ok(ui.rows().some((r) => r.classList.contains('fx-cut')));
  });

  test('move 完成後剪下態清除', () => {
    ui.post({ type: 'filesOpDone', op: 'move', results: [{ from: 'a.md', to: '子目錄/a.md', ok: true }] });
    assert.ok(btn(ui.rightClick(fileRowOf('子目錄')), '貼上').disabled);
    ui.closeMenu();
  });

  // 快捷鍵：焦點行上 Ctrl+C（按鍵落在那一行上——真的焦點在哪，keydown 就從哪發出來）。
  test('Ctrl+C 複製焦點行', () => {
    ui.post({ type: 'dirListings', listings: [listing('', { 'b.md': 'file' })] });
    const bRow = fileRowOf('b.md');
    bRow.dispatchEvent(new ui.window.FocusEvent('focus', { bubbles: true }));
    bRow.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true }));
    assert.ok(written.includes('b.md'), JSON.stringify(written));
  });

  // 從前只看「檔案頁開著、有選中行」：點開一個檔案之後焦點進了編輯區，編輯區裡的 Ctrl+C / X / V 被這裡攔下，
  // 複製的成了那個檔案。現在按鍵得落在樹上。
  test('選中過一行之後，編輯區裡的 Ctrl+C / Ctrl+X / Ctrl+V 照常歸編輯區（不攔、不動檔案剪貼簿）', () => {
    const bRow = fileRowOf('b.md');
    bRow.dispatchEvent(new ui.window.FocusEvent('focus', { bubbles: true }));
    const before = written.length;
    const area = ui.doc.querySelector('#wbEditor textarea.ed-area');
    const prevented = ['c', 'x', 'v'].map((key) => {
      const ev = new ui.window.KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true });
      area.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    assert.deepEqual(prevented, [false, false, false]);
    assert.equal(written.length, before, JSON.stringify(written));
  });
});
