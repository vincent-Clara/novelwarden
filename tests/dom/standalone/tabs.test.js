/**
 * 標籤分得清、路徑看得懂（獨立版內建編輯器）。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 同一章的正文 / 細綱 / 草稿 | 名字一樣，前面的短標記各不相同（正文不帶）；懸停是完整相對路徑 |
 * | 兩卷裡各一個「003-夜訪」 | 同一種、不同目錄的再加最短的區分目錄；只剩一個時不再加 |
 * | 兩塊編輯區各開一份同名的 | 放在一起比，也加區分目錄 |
 * | 後端沒給稱呼 | 標籤寫檔名、工具欄寫原始路徑（一段，不能點） |
 * | 麵包屑 | 「細綱 › 第一卷 › 第 3 章 夜訪」，原始路徑在懸停提示上；目錄段是按鈕，檔案段不是；章節的標題取章節索引（改了標題、檔名沒動時也對） |
 * | 點麵包屑的目錄段 | 「檔案」頁切出來、展開到那個目錄、那一行標出來 |
 * | 標籤條 | 滾輪橫著滾；啟用的那個滾進視野；重畫不把滾動位置歸零 |
 * | 「▾」 | 兩塊編輯區開著的全部檔案按塊分組、標出沒儲存的；點了切過去；關掉的列在「最近關閉」，點了重新開啟 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file, listing } = require('../../helpers/dom');

/** 後端 `views/editorLabel.ts` 給的稱呼（這裡手寫，形狀一樣）。 */
const L = {
  ch3: { tag: '', title: '003-夜訪', crumbs: [{ label: '正文', dir: 'chapters' }, { label: '第 3 章 夜訪' }] },
  plot3: {
    tag: '細綱',
    title: '003-夜訪',
    crumbs: [
      { label: '細綱', dir: '.novelwarden/summaries' },
      { label: '第一卷', dir: '.novelwarden/summaries/第一卷' },
      { label: '第 3 章 夜訪' },
    ],
  },
  draft3: { tag: '草稿', title: '003-夜訪', crumbs: [{ label: '草稿', dir: 'drafts' }, { label: '第 3 章 夜訪' }] },
  vol1: {
    tag: '',
    title: '003-夜訪',
    crumbs: [{ label: '正文', dir: 'chapters' }, { label: '第一卷', dir: 'chapters/第一卷' }, { label: '第 3 章 夜訪' }],
  },
  vol2: {
    tag: '',
    title: '003-夜訪',
    crumbs: [{ label: '正文', dir: 'chapters' }, { label: '第二卷', dir: 'chapters/第二卷' }, { label: '第 3 章 夜訪' }],
  },
};

const open = (ui, path, label, extra) => ui.post({ type: 'editorOpen', file: file(path, `${path} 的內容`, { label }), ...extra });

describe('標籤：同一章的三份分得清', { skip: JSDOM_SKIP }, () => {
  let ui;
  const tabs = () => [...ui.doc.querySelectorAll('.ed-tab')];
  const shown = (tab) => [tab.querySelector('.ed-tab-tag')?.textContent ?? '', tab.querySelector('.ed-tab-name').textContent];

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: ['pointerCapture', 'confirm', 'scrollIntoView'] });
    open(ui, 'chapters/003-夜訪.md', L.ch3);
    open(ui, '.novelwarden/summaries/第一卷/003-夜訪.md', L.plot3);
    open(ui, 'drafts/003-夜訪.md', L.draft3);
  });

  test('名字都去掉了副檔名，正文不帶短標記、細綱與草稿各帶一個', () => {
    assert.deepEqual(tabs().map(shown), [
      ['', '003-夜訪'],
      ['細綱', '003-夜訪'],
      ['草稿', '003-夜訪'],
    ]);
  });

  test('短標記不同就不算同名：不加區分目錄', () => {
    assert.equal(ui.doc.querySelectorAll('.ed-tab-desc').length, 0);
  });

  test('懸停提示是完整的相對路徑', () => {
    assert.deepEqual(
      tabs().map((t) => t.title),
      ['chapters/003-夜訪.md', '.novelwarden/summaries/第一卷/003-夜訪.md', 'drafts/003-夜訪.md']
    );
  });

  test('後端沒給稱呼：標籤寫檔名', () => {
    ui.post({ type: 'editorOpen', file: file('notes.txt', '隨手記') });
    assert.deepEqual(shown(tabs()[3]), ['', 'notes.txt']);
  });
});

describe('標籤：同名的加最短的區分目錄', { skip: JSDOM_SKIP }, () => {
  let ui;
  const descs = (pane) => [...pane.querySelectorAll('.ed-tab')].map((t) => t.querySelector('.ed-tab-desc')?.textContent ?? '');

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: ['pointerCapture', 'confirm', 'scrollIntoView'] });
    open(ui, 'chapters/第一卷/003-夜訪.md', L.vol1);
    open(ui, 'chapters/第二卷/003-夜訪.md', L.vol2);
  });

  test('兩卷裡各一個「003-夜訪」：後面寫卷名', () => {
    assert.deepEqual(descs(ui.panes()[0]), ['第一卷', '第二卷']);
  });

  test('關掉一個：剩下那個不再加', () => {
    ui.clickEl(ui.doc.querySelectorAll('.ed-tab-close')[1]);
    assert.deepEqual(descs(ui.panes()[0]), ['']);
  });

  test('兩塊編輯區各開一份同名的：放在一起比，兩邊都加', () => {
    open(ui, 'chapters/第二卷/003-夜訪.md', L.vol2, { pane: 'draft' });
    assert.deepEqual([descs(ui.panes()[0]), descs(ui.panes()[1])], [['第一卷'], ['第二卷']]);
  });

  test('右邊那一份關掉：左邊那份的區分目錄跟著收起', () => {
    ui.clickEl(ui.panes()[1].querySelector('.ed-tab-close'));
    assert.deepEqual(descs(ui.panes()[0]), ['']);
  });
});

describe('工具欄麵包屑', { skip: JSDOM_SKIP }, () => {
  let ui;
  const path = () => ui.doc.getElementById('edPath');
  const segs = () => [...path().children].map((n) => n.textContent);

  before(() => {
    ui = mount({
      body: 'standalone',
      scripts: ['view.js', 'editor.js', 'explorer.js'],
      shims: ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'],
    });
    open(ui, '.novelwarden/summaries/第一卷/003-夜訪.md', L.plot3);
  });

  test('寫成「細綱 › 第一卷 › 第 3 章 夜訪」', () => {
    assert.deepEqual(segs(), ['細綱', '›', '第一卷', '›', '第 3 章 夜訪']);
  });

  test('原始相對路徑在懸停提示上', () => {
    assert.equal(path().title, '.novelwarden/summaries/第一卷/003-夜訪.md');
  });

  test('目錄段是按鈕，檔案那一段不是', () => {
    const buttons = [...path().querySelectorAll('button')].map((b) => b.textContent);
    assert.deepEqual(buttons, ['細綱', '第一卷']);
  });

  test('點目錄段：切到「檔案」頁、展開到那個目錄', () => {
    ui.sent.length = 0;
    ui.clickEl([...path().querySelectorAll('button')].find((b) => b.textContent === '第一卷'));
    assert.ok(ui.doc.getElementById('pane-files').classList.contains('active'), '沒切到檔案頁');
    assert.equal(ui.last('switchTab')?.tab, 'files');
    const dirs = ui.last('listDir')?.dirs ?? [];
    for (const dir of ['.novelwarden', '.novelwarden/summaries', '.novelwarden/summaries/第一卷']) {
      assert.ok(dirs.includes(dir), `${dir} 沒展開：${JSON.stringify(dirs)}`);
    }
  });

  test('目錄列出來之後那一行標出來', () => {
    ui.post({ type: 'dirListings', listings: [
      listing('', { '.novelwarden': 'dir' }),
      listing('.novelwarden', { summaries: 'dir' }),
      listing('.novelwarden/summaries', { 第一卷: 'dir' }),
      listing('.novelwarden/summaries/第一卷', { '003-夜访.md': 'file' }),
    ] });
    const row = ui.doc.querySelector('#filesBody .fx-row.fx-revealed');
    assert.ok(row, '沒有標出來的行');
    assert.equal(row.dataset.path, '.novelwarden/summaries/第一卷');
  });

  test('章節那一段的標題取章節索引（有正文的章改了標題、檔名不動時，與章節條、「轉到…」說的一樣）', () => {
    open(ui, 'chapters/003-夜訪.md', L.ch3);
    assert.deepEqual(segs(), ['正文', '›', '第 3 章 夜訪']);
    ui.post({ type: 'chapterIndex', chapters: [{
      no: 3, label: '第 3 章《夜半來客》', title: '夜半來客', relPath: 'chapters/003-夜訪.md',
      plotPath: '.novelwarden/summaries/003-夜訪.md', plotExists: true, chapterPath: 'chapters/003-夜訪.md',
      wordCount: 300, stage: 'finalize',
    }] });
    assert.deepEqual(segs(), ['正文', '›', '第 3 章 夜半來客']);
    // 標籤上仍寫檔名：它說的是這個檔案。
    assert.equal(ui.doc.querySelector('.ed-tab.active .ed-tab-name').textContent, '003-夜訪');
  });

  test('後端沒給稱呼：只寫原始路徑一段，不能點', () => {
    ui.post({ type: 'editorOpen', file: file('.novelwarden/project.json', '{}') });
    assert.deepEqual(segs(), ['.novelwarden/project.json']);
    assert.equal(path().querySelectorAll('button').length, 0);
  });
});

describe('標籤條：橫著滾、當前那個滾進視野', { skip: JSDOM_SKIP }, () => {
  let ui;
  const list = () => ui.panes()[0].querySelector('.ed-tabs-list');
  const TAB_WIDTH = 100;

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: ['pointerCapture', 'confirm', 'scrollIntoView'] });
    // 假排版：標籤一個 100px 寬、一個挨一個；標籤條的可見寬度 250px。
    const { HTMLElement } = ui.window;
    Object.defineProperty(HTMLElement.prototype, 'offsetLeft', {
      configurable: true,
      get() {
        return this.classList.contains('ed-tab') ? [...this.parentNode.children].indexOf(this) * TAB_WIDTH : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get() {
        return this.classList.contains('ed-tab') ? TAB_WIDTH : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return this.classList.contains('ed-tabs-list') ? 250 : 0;
      },
    });
    for (let i = 1; i <= 6; i++) {
      ui.post({ type: 'editorOpen', file: file(`notes/${i}.md`, `第 ${i} 份`) });
    }
  });

  test('標籤在可滾動的那一格里，末尾一顆「▾」', () => {
    assert.equal(list().querySelectorAll('.ed-tab').length, 6);
    assert.equal(ui.panes()[0].querySelector('.ed-tabs-more').textContent, '▾');
  });

  test('新開的（最後一個）滾進視野：右邊貼齊', () => {
    assert.equal(list().scrollLeft, 6 * TAB_WIDTH - 250);
  });

  test('切到第一個：左邊貼齊', () => {
    ui.clickEl(list().querySelectorAll('.ed-tab')[0]);
    assert.equal(list().scrollLeft, 0);
  });

  test('豎著撥滾輪：橫著滾，並且攔下預設動作', () => {
    const ev = new ui.window.WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
    list().dispatchEvent(ev);
    assert.equal(list().scrollLeft, 120);
    assert.equal(ev.defaultPrevented, true);
  });

  test('重畫標籤（切到一個已在視野裡的）不把滾動位置歸零', () => {
    // 視野是 120–370：第 3 個（200–300）在裡面。
    ui.clickEl(list().querySelectorAll('.ed-tab')[2]);
    assert.equal(list().scrollLeft, 120);
  });
});

describe('「▾」：兩塊編輯區開著的檔案與最近關閉', { skip: JSDOM_SKIP }, () => {
  let ui;
  const more = () => ui.panes()[0].querySelector('.ed-tabs-more');
  const openMenu = () => {
    ui.clickEl(more());
    return ui.doc.querySelector('.ctx-menu');
  };
  const btn = (menu, prefix) => [...menu.querySelectorAll('button')].find((b) => b.textContent.includes(prefix));

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: ['pointerCapture', 'confirm', 'scrollIntoView'] });
    open(ui, 'chapters/003-夜訪.md', L.ch3);
    open(ui, 'notes.txt', undefined);
    open(ui, '.novelwarden/summaries/第一卷/003-夜訪.md', L.plot3, { pane: 'draft' });
    // 左邊的正文改一筆：列表裡要標出來。
    ui.clickEl(ui.panes()[0].querySelectorAll('.ed-tab')[0]);
    const area = ui.doc.getElementById('edArea');
    area.value += '，又寫了一句';
    area.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  });

  test('點「▾」彈出列表：按塊分組，兩塊的檔案都在', () => {
    const menu = openMenu();
    assert.ok(menu, '沒彈出選單');
    const labels = ui.itemsOf(menu);
    assert.equal(labels[0], '左側編輯區');
    assert.ok(labels.indexOf('右側編輯區') > labels.findIndex((l) => l.includes('notes.txt')), JSON.stringify(labels));
    assert.ok(labels.some((l) => l.includes('細綱 003-夜訪')), JSON.stringify(labels));
    ui.closeMenu();
  });

  test('沒儲存的那一份標出來', () => {
    const menu = openMenu();
    const dirty = btn(menu, '003-夜訪（未儲存）');
    assert.ok(dirty?.textContent.startsWith('●'), dirty?.textContent);
    assert.ok(!btn(menu, 'notes.txt').textContent.includes('未儲存'));
    ui.closeMenu();
  });

  test('分組的標題點不了', () => {
    const menu = openMenu();
    assert.equal(btn(menu, '左側編輯區').disabled, true);
    ui.closeMenu();
  });

  test('點右邊那一份：切過去，當前那一塊換成右邊', () => {
    const events = [];
    ui.window.addEventListener('nf-editor-active', (e) => events.push(e.detail.path));
    ui.clickEl(btn(openMenu(), '細綱 003-夜訪'));
    assert.equal(events.pop(), '.novelwarden/summaries/第一卷/003-夜訪.md');
    assert.equal(ui.doc.querySelector('.ctx-menu'), null, '選單沒收起');
  });

  test('關掉一個：列在「最近關閉」，點了按原來那一塊重新開啟', () => {
    const notes = [...ui.panes()[0].querySelectorAll('.ed-tab')].find((t) => t.textContent.includes('notes.txt'));
    ui.clickEl(notes.querySelector('.ed-tab-close'));
    const menu = openMenu();
    const labels = ui.itemsOf(menu);
    assert.ok(labels.includes('最近關閉'), JSON.stringify(labels));
    ui.sent.length = 0;
    ui.clickEl(btn(menu, 'notes.txt · 左側'));
    assert.deepEqual(
      (({ path, pane }) => ({ path, pane }))(ui.last('openEditor')),
      { path: 'notes.txt', pane: 'main' }
    );
  });

  test('再點一下「▾」收起', () => {
    openMenu();
    // 選單開著時這一下點選冒到 document 上去，由選單引擎收起。
    more().dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
    assert.equal(ui.doc.querySelector('.ctx-menu'), null);
  });
});
