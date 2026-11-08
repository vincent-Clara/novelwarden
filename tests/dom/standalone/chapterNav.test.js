/**
 * 上一章 / 下一章（獨立版內建編輯器，`editor/chapterNav.ts` + 章節條）。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 資料 | 只靠 `chapterIndex`（對話頁開著、從沒推過工程樹）也有章節條、能翻章 |
 * | 到頭了 | 章節條上那一顆禁用；快捷鍵說一句 |
 * | 正文跟正文、細綱跟細綱 | 當前標籤是哪一面就換成相鄰那一章的哪一面；順序按章號（分卷目錄裡的照樣排進來） |
 * | 沒改過 | 在原位置換掉（開啟請求帶 `replace`，收到時佔它的位置） |
 * | 改過了 | 另開一個標籤，改過的那一份留著 |
 * | 相鄰那一章已經開著 | 直接切過去，不發開啟請求 |
 * | 相鄰那一章沒有這一面 | 照實說，不開啟不存在的檔案 |
 * | 另一塊開著配對檔案 | 同樣換成相鄰那一章的配對檔案，不搶焦點；相鄰那一章沒有配對的那一面時說一句、旁邊那份不動 |
 * | 快捷鍵 Alt+PageUp / Alt+PageDown | 焦點在對話輸入框裡不攔；輸入法組字中途不攔 |
 * | 章節條在左側，當前檔案在右側 | 在條上按下去不把「當前這一塊」搶到左側，翻的是右側那一份 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file } = require('../../helpers/dom');

const S = '.novelwarden/summaries';
const row = (no, title, chapterPath, plotPath, plotExists, stage, wordCount = 0) => ({
  no,
  label: `第 ${no} 章《${title}》`,
  title,
  relPath: chapterPath || plotPath,
  plotPath,
  plotExists,
  chapterPath,
  wordCount,
  targetWords: 3000,
  stage,
});
/** 六章：第 2 章在卷目錄裡；第 5 章只有正文、第 6 章只有細綱。 */
const INDEX = [
  row(1, '雨夜', 'chapters/001-雨夜.md', `${S}/001-雨夜.md`, true, 'done', 3000),
  row(2, '入鎮', 'chapters/第一卷/002-入鎮.md', `${S}/第一卷/002-入鎮.md`, true, 'finalize', 2980),
  row(3, '夜訪', 'chapters/003-夜訪.md', `${S}/003-夜访.md`, true, 'done', 3100),
  row(4, '北行', 'chapters/004-北行.md', `${S}/004-北行.md`, true, 'finalize', 2900),
  row(5, '赤星', 'chapters/005-赤星.md', `${S}/005-赤星.md`, false, 'finalize', 2500),
  row(6, '歸途', '', `${S}/006-歸途.md`, true, 'manuscript'),
];

const SHIMS = ['pointerCapture', 'confirm', 'scrollIntoView'];

function setup() {
  const ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: SHIMS });
  ui.post({ type: 'chapterIndex', chapters: INDEX });
  return ui;
}
const open = (ui, path, extra) => ui.post({ type: 'editorOpen', file: file(path, `${path} 的內容`), ...extra });
const echo = (ui, msg) => open(ui, msg.path, { pane: msg.pane, ...(msg.replace ? { replace: msg.replace } : {}) });
const key = (ui, k, extra) =>
  ui.doc.activeElement.dispatchEvent(
    new ui.window.KeyboardEvent('keydown', { key: k, altKey: true, bubbles: true, cancelable: true, ...extra })
  );
const opens = (ui) => ui.sent.filter((m) => m.type === 'openEditor');
const tabPaths = (pane) => [...pane.querySelectorAll('.ed-tab')].map((t) => t.dataset.path);
const toastText = (ui) => ui.doc.getElementById('toast').textContent;
const bar = (ui) => ui.doc.getElementById('edChapterBar');
const nav = (ui, which) => bar(ui).querySelector(`button[data-nav="${which}"]`);

describe('上一章 / 下一章：在原位置換、改過另開', { skip: JSDOM_SKIP }, () => {
  let ui;
  const main = () => ui.panes()[0];

  before(() => {
    ui = setup();
    open(ui, 'notes/a.md');
    open(ui, 'chapters/001-雨夜.md');
    open(ui, 'notes/b.md');
    ui.clickEl(main().querySelector('.ed-tab[data-path="chapters/001-雨夜.md"]'));
  });

  test('沒推過工程樹（對話頁）也有章節條，兩顆按鈕夾著這一章的說明', () => {
    assert.ok(!bar(ui).classList.contains('hidden'));
    assert.deepEqual(
      [...bar(ui).children].slice(0, 3).map((n) => n.textContent),
      ['‹ 上一章', '第 1 章《雨夜》 · 已完成 · 3000 / 3000 字', '下一章 ›']
    );
  });

  test('第一章：「上一章」禁用，提示說到頭了', () => {
    assert.equal(nav(ui, 'prev').disabled, true);
    assert.match(nav(ui, 'prev').title, /已經是第一章了/);
    assert.equal(nav(ui, 'next').disabled, false);
    assert.match(nav(ui, 'next').title, /第 2 章《入鎮》的正文（Alt\+PageDown）/);
  });

  test('第一章按 Alt+PageUp：說一句，不發開啟請求', () => {
    ui.sent.length = 0;
    key(ui, 'PageUp');
    assert.equal(opens(ui).length, 0);
    assert.match(toastText(ui), /已經是第一章了/);
  });

  test('沒改過：請後端開啟第 2 章的正文（卷目錄裡的照樣排在第 2），帶 replace', () => {
    ui.sent.length = 0;
    key(ui, 'PageDown');
    const msg = opens(ui).pop();
    assert.deepEqual(
      { path: msg.path, pane: msg.pane, replace: msg.replace },
      { path: 'chapters/第一卷/002-入鎮.md', pane: 'main', replace: 'chapters/001-雨夜.md' }
    );
    echo(ui, msg);
  });

  test('收到之後佔第 1 章原來的位置，第 1 章不在了', () => {
    assert.deepEqual(tabPaths(main()), ['notes/a.md', 'chapters/第一卷/002-入鎮.md', 'notes/b.md']);
    assert.equal(main().querySelector('.ed-tab.active').dataset.path, 'chapters/第一卷/002-入鎮.md');
  });

  test('改過了：點「下一章 ›」另開一個標籤，改過的那一份留著', () => {
    const area = ui.doc.getElementById('edArea');
    area.value += '，又寫了一句';
    area.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    ui.sent.length = 0;
    ui.clickEl(nav(ui, 'next'));
    const msg = opens(ui).pop();
    assert.equal(msg.path, 'chapters/003-夜訪.md');
    assert.equal('replace' in msg, false);
    echo(ui, msg);
    assert.deepEqual(tabPaths(main()), ['notes/a.md', 'chapters/第一卷/002-入鎮.md', 'notes/b.md', 'chapters/003-夜訪.md']);
    assert.ok(main().querySelector('.ed-tab[data-path="chapters/第一卷/002-入鎮.md"]').classList.contains('dirty'));
  });

  test('相鄰那一章已經開著：直接切過去，不發開啟請求', () => {
    ui.sent.length = 0;
    key(ui, 'PageUp');
    assert.equal(opens(ui).length, 0);
    assert.equal(main().querySelector('.ed-tab.active').dataset.path, 'chapters/第一卷/002-入鎮.md');
  });

  test('相鄰那一章沒有正文：照實說，不開啟', () => {
    open(ui, 'chapters/005-赤星.md');
    ui.sent.length = 0;
    key(ui, 'PageDown');
    assert.equal(opens(ui).length, 0);
    assert.match(toastText(ui), /第 6 章《歸途》還沒有正文/);
    assert.match(nav(ui, 'next').title, /還沒有正文/);
  });

  test('焦點在對話輸入框裡：Alt+PageDown 不攔', () => {
    ui.doc.getElementById('input').focus();
    ui.sent.length = 0;
    const ev = new ui.window.KeyboardEvent('keydown', { key: 'PageUp', altKey: true, bubbles: true, cancelable: true });
    ui.doc.getElementById('input').dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, false);
    assert.equal(opens(ui).length, 0);
  });

  test('輸入法組字中途：不攔', () => {
    ui.doc.getElementById('edArea').focus();
    const ev = new ui.window.KeyboardEvent('keydown', { key: 'PageUp', altKey: true, isComposing: true, bubbles: true, cancelable: true });
    ui.doc.getElementById('edArea').dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, false);
  });
});

describe('上一章 / 下一章：細綱跟細綱，最後一章禁用', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = setup();
    open(ui, `${S}/004-北行.md`, { pane: 'draft' });
  });

  test('當前是細綱：下一章找細綱——第 5 章沒有細綱，照實說', () => {
    ui.sent.length = 0;
    ui.clickEl(nav(ui, 'next'));
    assert.equal(opens(ui).length, 0);
    assert.match(toastText(ui), /第 5 章《赤星》還沒有細綱/);
  });

  test('上一章：第 3 章的細綱，開在它自己那一塊', () => {
    ui.sent.length = 0;
    ui.clickEl(nav(ui, 'prev'));
    const msg = opens(ui).pop();
    assert.deepEqual({ path: msg.path, pane: msg.pane, replace: msg.replace }, { path: `${S}/003-夜访.md`, pane: 'draft', replace: `${S}/004-北行.md` });
  });

  test('最後一章：「下一章」禁用', () => {
    open(ui, `${S}/006-歸途.md`, { pane: 'draft' });
    assert.equal(nav(ui, 'next').disabled, true);
    assert.match(nav(ui, 'next').title, /已經是最後一章了/);
  });
});

describe('上一章 / 下一章：另一塊的配對檔案跟著走', { skip: JSDOM_SKIP }, () => {
  let ui;
  const active = [];
  const main = () => ui.panes()[0];
  const right = () => ui.panes()[1];

  before(() => {
    ui = setup();
    ui.window.addEventListener('nf-editor-active', (e) => active.push(e.detail.path));
    open(ui, `${S}/003-夜访.md`, { pane: 'draft' });
    open(ui, 'chapters/003-夜訪.md');
  });

  test('兩份請求：配對的那一份先發、帶 replace，再發這一塊的', () => {
    ui.doc.getElementById('edArea').focus();
    ui.sent.length = 0;
    key(ui, 'PageDown');
    const [pair, own] = opens(ui);
    assert.deepEqual(
      [pair, own].map((m) => [m.path, m.pane, m.replace]),
      [
        [`${S}/004-北行.md`, 'draft', `${S}/003-夜访.md`],
        ['chapters/004-北行.md', 'main', 'chapters/003-夜訪.md'],
      ]
    );
  });

  test('配對那一份先到：換掉右邊的，但「當前這一塊」還是左邊', () => {
    const [pair] = opens(ui);
    active.length = 0;
    echo(ui, pair);
    assert.deepEqual(tabPaths(right()), [`${S}/004-北行.md`]);
    assert.ok(!active.includes(`${S}/004-北行.md`), JSON.stringify(active));
  });

  test('這一塊的到了：左邊換成第 4 章正文，當前是它', () => {
    const [, own] = opens(ui);
    echo(ui, own);
    assert.deepEqual(tabPaths(main()), ['chapters/004-北行.md']);
    assert.equal(active.pop(), 'chapters/004-北行.md');
  });

  test('相鄰那一章沒有配對的那一面：這一塊照翻，旁邊那份不動，說一句', () => {
    ui.doc.getElementById('edArea').focus();
    ui.sent.length = 0;
    key(ui, 'PageDown');
    const sent = opens(ui);
    assert.deepEqual(sent.map((m) => [m.path, m.pane]), [['chapters/005-赤星.md', 'main']]);
    assert.match(toastText(ui), /第 5 章《赤星》還沒有細綱，旁邊那一份沒換/);
  });

  test('當前檔案在右邊、在左邊的章節條上點按鈕：翻的是右邊那一份', () => {
    echo(ui, opens(ui)[0]);
    // 切到右邊的細綱（第 4 章）。
    ui.clickEl(right().querySelector('.ed-tab'));
    assert.match(bar(ui).querySelector('.ed-chapter-info').textContent, /第 4 章/);
    ui.sent.length = 0;
    const prev = nav(ui, 'prev');
    prev.dispatchEvent(new ui.window.Event('pointerdown', { bubbles: true }));
    prev.dispatchEvent(new ui.window.FocusEvent('focusin', { bubbles: true }));
    ui.clickEl(nav(ui, 'prev'));
    const msg = opens(ui).pop();
    assert.deepEqual([msg.path, msg.pane], [`${S}/003-夜访.md`, 'draft']);
  });
});
