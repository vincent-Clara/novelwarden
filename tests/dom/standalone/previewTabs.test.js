/**
 * 臨時標籤（獨立版內建編輯器，預設開，「檢視 → 單擊開啟為臨時標籤」可關）。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 單擊開啟（`editorOpen` 帶 `preview`） | 名字斜體；下一次單擊開啟別的檔案**在原位置換掉它**，每塊最多一個 |
 * | 編輯 / 儲存 / 雙擊標籤 / 「固定」 | 轉正；之後單擊開啟的另開一個 |
 * | 被別的路子正常開啟一次（落盤後自動開啟、雙擊那一行） | 轉正；單擊開啟一份已經固定的不把它降回臨時 |
 * | 兩塊編輯區 | 各自最多一個 |
 * | 改過的標籤 | 永遠不會被換掉（一改就轉正） |
 * | 開關關掉 | 現有的臨時標籤轉正，之後單擊開啟的都是正常標籤；再開啟恢復 |
 * | 「檢視」選單 | 在「編輯」與「幫助」之間，第一項「單擊開啟為臨時標籤」，預設打 ✓ |
 * | 檔案頁 / 工程頁 | 單擊發 `preview`，雙擊（第二下點選）不帶——轉正 |
 * | 重新整理恢復 | 臨時的那一個記著（⚑），重新整理後還是臨時的 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file, listing, sampleTree } = require('../../helpers/dom');

const SHIMS = ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'];

const names = (pane) => [...pane.querySelectorAll('.ed-tab')].map((t) => t.querySelector('.ed-tab-name').textContent);
const previews = (pane) => [...pane.querySelectorAll('.ed-tab.preview')].map((t) => t.querySelector('.ed-tab-name').textContent);
const openPreview = (ui, path, extra) => ui.post({ type: 'editorOpen', file: file(path, `${path} 的內容`), preview: true, ...extra });
const openNormal = (ui, path, extra) => ui.post({ type: 'editorOpen', file: file(path, `${path} 的內容`), ...extra });

describe('臨時標籤：複用與轉正', { skip: JSDOM_SKIP }, () => {
  let ui;
  const main = () => ui.panes()[0];
  const area = () => ui.doc.getElementById('edArea');
  const tab = (name) => [...main().querySelectorAll('.ed-tab')].find((t) => t.querySelector('.ed-tab-name').textContent === name);

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: SHIMS });
    openNormal(ui, 'a.md');
    openPreview(ui, 'b.md');
  });

  test('單擊開啟的是臨時標籤：名字斜體那一格', () => {
    assert.deepEqual(previews(main()), ['b.md']);
  });

  test('懸停提示說它是臨時的', () => {
    assert.match(tab('b.md').title, /臨時標籤/);
  });

  test('再單擊開啟別的檔案：在原位置換掉它，標籤數不變', () => {
    openNormal(ui, 'z.md');
    ui.clickEl(tab('b.md'));
    openPreview(ui, 'c.md');
    assert.deepEqual(names(main()), ['a.md', 'c.md', 'z.md']);
    assert.deepEqual(previews(main()), ['c.md']);
  });

  test('換掉的那一份進不了「最近關閉」', () => {
    const items = ui.itemsOf(ui.rightClick(tab('c.md')));
    assert.ok(items.includes('重新開啟剛關閉的'), JSON.stringify(items));
    ui.closeMenu();
  });

  test('在裡面打字：轉正', () => {
    area().value += '，改了一筆';
    area().dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    assert.deepEqual(previews(main()), []);
  });

  test('改過的標籤不會被換掉：下一次單擊開啟另開一個', () => {
    openPreview(ui, 'd.md');
    assert.deepEqual(names(main()), ['a.md', 'c.md', 'z.md', 'd.md']);
    assert.ok(tab('c.md').classList.contains('dirty'));
    assert.deepEqual(previews(main()), ['d.md']);
  });

  test('雙擊標籤（第二下點選）：轉正', () => {
    tab('d.md').dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true, detail: 1 }));
    tab('d.md').dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true, detail: 2 }));
    assert.deepEqual(previews(main()), []);
  });

  test('dblclick 落在標籤上也轉正', () => {
    openPreview(ui, 'e.md');
    tab('e.md').dispatchEvent(new ui.window.MouseEvent('dblclick', { bubbles: true }));
    assert.deepEqual(previews(main()), []);
  });

  test('儲存（Ctrl+S）：轉正，哪怕沒有可存的', () => {
    openPreview(ui, 'f.md');
    ui.doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
    assert.deepEqual(previews(main()), []);
  });

  test('被別的路子正常開啟一次（落盤後自動開啟、雙擊那一行）：轉正', () => {
    openPreview(ui, 'g.md');
    openNormal(ui, 'g.md');
    assert.deepEqual(previews(main()), []);
  });

  test('單擊開啟一份已經固定的：不把它降回臨時', () => {
    openPreview(ui, 'g.md');
    assert.deepEqual(previews(main()), []);
  });

  test('右鍵「固定」：只有臨時標籤有這一項，點了轉正', () => {
    openPreview(ui, 'h.md');
    assert.ok(!ui.itemsOf(ui.rightClick(tab('a.md'))).includes('固定'));
    ui.closeMenu();
    const menu = ui.rightClick(tab('h.md'));
    ui.pick(menu, '固定');
    assert.deepEqual(previews(main()), []);
  });

  test('兩塊編輯區各自最多一個', () => {
    openPreview(ui, 'p1.md');
    openPreview(ui, 'q1.md', { pane: 'draft' });
    openPreview(ui, 'q2.md', { pane: 'draft' });
    assert.deepEqual([previews(main()), previews(ui.panes()[1])], [['p1.md'], ['q2.md']]);
    assert.deepEqual(names(ui.panes()[1]), ['q2.md']);
  });
});

describe('臨時標籤：「檢視」選單的開關', { skip: JSDOM_SKIP }, () => {
  let ui;
  const main = () => ui.panes()[0];
  const viewMenu = () => {
    ui.clickEl(ui.doc.querySelector('[data-menu="view"]'));
    return ui.doc.querySelector('.wb-menu-drop');
  };
  const item = (drop) => [...drop.querySelectorAll('.wb-menu-item')].find((b) => b.textContent.includes('單擊開啟為臨時標籤'));
  const closeBar = () => ui.doc.body.dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: SHIMS });
    openPreview(ui, 'a.md');
  });

  test('「檢視」第一項是「單擊開啟為臨時標籤」，預設打 ✓', () => {
    const drop = viewMenu();
    const first = drop.querySelector('.wb-menu-item');
    assert.match(first.textContent, /單擊開啟為臨時標籤/);
    assert.equal(first.getAttribute('aria-checked'), 'true');
    assert.equal(first.querySelector('.wb-menu-check').textContent, '✓');
    closeBar();
  });

  test('關掉：現有的臨時標籤轉正，勾去掉', () => {
    ui.clickEl(item(viewMenu()));
    assert.deepEqual(previews(main()), []);
    assert.equal(item(viewMenu()).getAttribute('aria-checked'), 'false');
    closeBar();
  });

  test('關著時單擊開啟的都是正常標籤，不換掉別的', () => {
    openPreview(ui, 'b.md');
    openPreview(ui, 'c.md');
    assert.deepEqual(names(main()), ['a.md', 'b.md', 'c.md']);
    assert.deepEqual(previews(main()), []);
  });

  test('再開啟：又打 ✓，單擊開啟的又是臨時標籤', () => {
    ui.clickEl(item(viewMenu()));
    assert.equal(item(viewMenu()).getAttribute('aria-checked'), 'true');
    closeBar();
    openPreview(ui, 'd.md');
    assert.deepEqual(previews(main()), ['d.md']);
  });
});

describe('臨時標籤：檔案頁與工程頁的單擊 / 雙擊', { skip: JSDOM_SKIP }, () => {
  let ui;
  const row = (name) => ui.rows().find((r) => r.querySelector('.fx-name')?.textContent === name);
  const click = (node, detail) => node.dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true, detail }));

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js', 'explorer.js'], shims: SHIMS });
    ui.post({ type: 'dirListings', listings: [listing('', { 'a.md': 'file' })] });
    ui.post({ type: 'project', tree: sampleTree() });
  });

  test('檔案頁單擊一行：openEditor 帶 preview', () => {
    click(row('a.md'), 1);
    assert.equal(ui.last('openEditor').preview, true);
  });

  test('檔案頁雙擊（第二下點選）：不帶 preview', () => {
    click(row('a.md'), 2);
    const msg = ui.last('openEditor');
    assert.equal(msg.path, 'a.md');
    assert.equal('preview' in msg, false);
  });

  test('工程頁單擊章節名：openChapter 帶 preview，雙擊不帶', () => {
    const label = [...ui.doc.querySelectorAll('#projectBody .row-plot:not(.row-architecture) .row-label')]
      .find((l) => l.textContent.includes('夜訪'));
    click(label, 1);
    assert.equal(ui.last('openChapter').preview, true);
    click(label, 2);
    assert.equal('preview' in ui.last('openChapter'), false);
  });

  test('工程頁單擊角色卡：openEditor 帶 preview', () => {
    const label = [...ui.doc.querySelectorAll('#projectBody .row-label')].find((l) => l.textContent === '林昭');
    click(label, 1);
    const msg = ui.last('openEditor');
    assert.deepEqual({ path: msg.path, preview: msg.preview }, { path: '.novelwarden/characters/林昭.md', preview: true });
  });
});

describe('臨時標籤：重新整理恢復（⚑ 記著）', { skip: JSDOM_SKIP }, () => {
  test('存下來的快照裡標著哪一個是臨時的；重新整理後它還是臨時的', () => {
    const first = mount({ body: 'standalone', scripts: ['editor.js'], shims: SHIMS, storage: {} });
    openNormal(first, 'a.md');
    openPreview(first, 'b.md');
    const saved = first.window.localStorage.getItem('novelforge.editor.v1');
    const data = JSON.parse(saved);
    assert.deepEqual(data.panes.main.open.map((o) => [o.path, !!o.preview]), [['a.md', false], ['b.md', true]]);

    const second = mount({ body: 'standalone', scripts: ['editor.js'], shims: SHIMS, storage: { 'novelforge.editor.v1': saved } });
    const reopen = second.sent.filter((m) => m.type === 'openEditor');
    assert.deepEqual(reopen.map((m) => m.path), ['a.md', 'b.md']);
    // 開啟請求上不帶標記（只記在前端，不隨廣播出去）。
    assert.ok(reopen.every((m) => !('preview' in m)));
    openNormal(second, 'a.md');
    openNormal(second, 'b.md');
    assert.deepEqual(previews(second.panes()[0]), ['b.md']);
  });
});
