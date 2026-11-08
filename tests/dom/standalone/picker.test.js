/**
 * 遠端風目錄選擇器：hostDir 列出名字、點目錄再列舉、確定發 openFolder。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP } = require('../../helpers/dom');

describe('獨立版目錄選擇器', { skip: JSDOM_SKIP }, () => {
  let ui;
  let prompted;

  before(() => {
    ui = mount({
      body: 'standalone',
      empty: true,
      scripts: ['view.js'],
      shims: ['clipboard', 'scrollIntoView', 'confirm'],
    });
    prompted = false;
    ui.window.prompt = () => {
      prompted = true;
      return '';
    };
  });

  test('點開啟資料夾出現選擇器，不走 prompt', () => {
    ui.clickEl(ui.doc.querySelector('[data-welcome="openFolder"]'));
    assert.equal(prompted, false);
    const picker = ui.doc.querySelector('.nf-picker');
    assert.ok(picker?.classList.contains('open'));
    const req = ui.last('listHostDir');
    assert.equal(req.path, '~');
  });

  test('hostDir 列出名字', () => {
    ui.post({
      type: 'hostDir',
      path: '/home/me',
      parent: '/home',
      entries: [
        { name: 'books', kind: 'dir', absPath: '/home/me/books' },
        { name: 'note.txt', kind: 'file', absPath: '/home/me/note.txt' },
      ],
      truncated: 0,
    });
    const labels = [...ui.doc.querySelectorAll('.nf-picker-row')].map((r) => r.textContent);
    assert.ok(labels.some((t) => t.includes('..')));
    assert.ok(labels.some((t) => t.includes('books')));
    assert.ok(labels.some((t) => t.includes('note.txt')));
  });

  test('點目錄發出新的 listHostDir', () => {
    ui.sent.length = 0;
    const row = [...ui.doc.querySelectorAll('.nf-picker-row')].find((r) =>
      r.textContent.includes('books')
    );
    ui.clickEl(row);
    const req = ui.last('listHostDir');
    assert.equal(req.path, '/home/me/books');
  });

  test('確定發出 openFolder 當前路徑', () => {
    ui.post({
      type: 'hostDir',
      path: '/home/me/books',
      parent: '/home/me',
      entries: [],
      truncated: 0,
    });
    ui.sent.length = 0;
    const ok = [...ui.doc.querySelectorAll('.nf-picker-actions button')].find(
      (b) => b.textContent === '確定'
    );
    ui.clickEl(ok);
    const msg = ui.last('openFolder');
    assert.ok(msg);
    assert.equal(msg.path, '/home/me/books');
    assert.equal(msg.mode, 'replace');
  });

  test('開著工程時，選擇器從這個工程的目錄起', () => {
    ui.post({
      type: 'workspaces',
      currentId: 'D:\\books\\雪夜',
      items: [{ id: 'D:\\books\\雪夜', root: 'D:\\books\\雪夜', name: '雪夜' }],
      recents: [],
    });
    ui.sent.length = 0;
    ui.clickEl(ui.doc.querySelector('[data-welcome="openFolder"]'));
    assert.equal(ui.last('listHostDir').path, 'D:\\books\\雪夜');
  });
});
