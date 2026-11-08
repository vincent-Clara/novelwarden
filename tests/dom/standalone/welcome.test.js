/**
 * 空視窗 Get Started：#nfWelcome、no-workspace、Recent、關閉資料夾。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP } = require('../../helpers/dom');

describe('獨立版空視窗歡迎頁', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount({
      body: 'standalone',
      empty: true,
      scripts: ['view.js'],
      shims: ['clipboard', 'scrollIntoView'],
    });
  });

  test('頁面有 Get Started 節點', () => {
    assert.ok(ui.doc.getElementById('nfWelcome'));
    assert.ok(ui.doc.body.classList.contains('no-workspace'));
  });

  test('無工程時輸入框禁用', () => {
    assert.equal(ui.doc.getElementById('input').disabled, true);
  });

  // W12：側欄每一頁的遮罩上都看得見下一步，不必先找到歡迎頁。
  test('側欄遮罩上有「開啟資料夾…」，與歡迎頁那顆同一個動作', () => {
    for (const id of ['pane-chat', 'pane-project', 'pane-files', 'pane-history']) {
      const btn = ui.doc.querySelector(`#${id} .ws-empty button`);
      assert.ok(btn && btn.textContent === '開啟資料夾…', id);
    }
    let intent;
    const onPick = (e) => {
      intent = e.detail.intent;
      e.preventDefault();
    };
    ui.window.addEventListener('nf-pick-folder', onPick);
    ui.clickEl(ui.doc.querySelector('#pane-chat .ws-empty button'));
    ui.window.removeEventListener('nf-pick-folder', onPick);
    assert.equal(intent, 'open');
  });

  test('workspaces 帶 recents 時畫出 Recent', () => {
    ui.post({
      type: 'workspaces',
      currentId: null,
      items: [],
      recents: [{ root: '/tmp/my-book', name: 'my-book' }],
    });
    const list = ui.doc.getElementById('nfRecentList');
    assert.ok(list.textContent.includes('my-book'));
    assert.ok(list.textContent.includes('/tmp/my-book'));
  });

  test('開啟工程後去掉 no-workspace 並更新標題', () => {
    ui.post({
      type: 'workspaces',
      currentId: '/tmp/my-book',
      items: [{ id: '/tmp/my-book', root: '/tmp/my-book', name: 'my-book' }],
      recents: [{ root: '/tmp/my-book', name: 'my-book' }],
    });
    assert.equal(ui.doc.body.classList.contains('no-workspace'), false);
    // 寬屏露完整目錄、窄屏露書名（資料夾名）：兩份都寫著，CSS 按寬度挑（窄屏上整條路徑只露得出開頭那一截）。
    const titleText = ui.doc.getElementById('wbTitleText');
    assert.equal(titleText.querySelector('.wb-title-full').textContent, '/tmp/my-book - Novelwarden');
    assert.equal(titleText.querySelector('.wb-title-short').textContent, 'my-book');
    assert.equal(titleText.title, '/tmp/my-book');
    assert.equal(ui.doc.title, 'my-book - Novelwarden');
    assert.equal(ui.doc.getElementById('input').disabled, false);
  });

  test('點 Recent 發 openFolder', () => {
    ui.sent.length = 0;
    ui.clickEl(ui.doc.querySelector('#nfRecentList button'));
    const msg = ui.last('openFolder');
    assert.ok(msg);
    assert.equal(msg.path, '/tmp/my-book');
    assert.equal(msg.mode, 'replace');
  });
});
