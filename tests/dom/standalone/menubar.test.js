/**
 * 獨立版標題欄「檔案 / 編輯 / 檢視 / 幫助」：結構、點開、懸停切隔壁。「檢視」裡那幾項在 previewTabs.test.js（臨時標籤）、
 * look.test.js（外觀）與 focus.test.js（專注）。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP } = require('../../helpers/dom');

describe('獨立版標題欄選單', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount({
      body: 'standalone',
      scripts: ['view.js'],
      shims: ['clipboard', 'scrollIntoView'],
    });
  });

  test('有選單欄和四個選單按鈕，「檢視」在「編輯」與「幫助」之間', () => {
    const bar = ui.doc.getElementById('wbMenubar');
    assert.ok(bar);
    const btns = [...bar.querySelectorAll('.wb-menu-btn')];
    assert.deepEqual(
      btns.map((b) => b.textContent),
      ['檔案', '編輯', '檢視', '幫助']
    );
  });

  test('標題欄帶版本號', () => {
    const title = ui.doc.getElementById('wbTitle');
    assert.ok(title?.dataset.version);
  });

  test('點「檔案」開啟下拉', () => {
    const file = ui.doc.querySelector('[data-menu="file"]');
    ui.clickEl(file);
    const drop = ui.doc.querySelector('.wb-menu-drop');
    assert.ok(drop);
    const labels = [...drop.querySelectorAll('.wb-menu-item')].map((b) => b.textContent);
    assert.ok(labels.some((t) => t.includes('開啟資料夾')));
    assert.ok(labels.some((t) => t.includes('關閉資料夾')));
  });

  test('已開啟時懸停「幫助」切過去', () => {
    const help = ui.doc.querySelector('[data-menu="help"]');
    help.dispatchEvent(new ui.window.MouseEvent('mouseover', { bubbles: true }));
    const drop = ui.doc.querySelector('.wb-menu-drop');
    assert.ok(drop);
    const labels = [...drop.querySelectorAll('.wb-menu-item')].map((b) => b.textContent);
    assert.ok(labels.some((t) => t.includes('歡迎')));
    assert.ok(labels.some((t) => t.includes('關於')));
  });
});
