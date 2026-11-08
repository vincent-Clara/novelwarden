/**
 * 「轉到…」面板（`media/src/editor/quickOpen.ts`）與標題欄「檔案 → 轉到…」（`media/src/view/quickOpenMenu.ts`）。
 * 索引由後端推來（`quickOpenIndex`），這裡按訊息造；匹配與排序的口徑在 tests/unit/editor/quickOpenCore.test.js。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 開啟 / 關閉 | Ctrl+P（Mac 的 Cmd+P）開啟、攔下「列印」、焦點進輸入框、發 `requestQuickOpen`；Esc 關掉且焦點還回去；點外面關；不是全屏遮罩 |
 * | 過濾與選擇 | 過濾串從輸入框的值算；↑↓ 換選中；匹配的字高亮 |
 * | 開啟什麼 | 章節發 `openChapter`（與工程頁點章節行同一條，沒有正文時給細綱路徑）；Ctrl+Enter 開到第二塊；角色等發 `openEditor`；點一行也能開；之後焦點進編輯區 |
 * | 焦點在別處 | 焦點在對話輸入框裡時照樣開啟；輸入法組字中不響應（全域與面板裡都是） |
 * | 選單 | 「檔案 → 轉到…」緊跟「開啟檔案…」、寫著 Ctrl+P、點了開啟 |
 * | 沒開工程 | 不開、不發請求、說一句；選單項置灰 |
 * | 最近開啟的 | 編輯器裡開過的檔案按工程記在 localStorage，空輸入時列在前面 |
 * | 外掛形態 | 沒有 `#wbEditor` 就不裝 |
 * | 與臨時標籤 | 從這裡開啟的不帶 `preview`，開成正常標籤、不換掉別的臨時標籤；開啟一份已經開成臨時標籤的，它就此轉正 |
 */
const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file, viewState } = require('../../helpers/dom');

const URL = 'http://localhost/?project=%2Ftmp%2F%E9%9D%92%E4%BA%91';

/** 一份索引：分卷的章、只有細綱的第 4 章、角色、設定、文件、草稿。 */
function index(extra = {}) {
  return {
    initialized: true,
    chapters: [
      { no: 1, title: '楔子', volume: '', chapterPath: 'chapters/001-楔子.md', plotPath: '.novelwarden/summaries/001-楔子.md', words: 300 },
      { no: 2, title: '入鎮', volume: '第一卷', chapterPath: 'chapters/第一卷/002-入鎮.md', words: 2980 },
      { no: 3, title: '夜訪', volume: '第一卷', chapterPath: 'chapters/第一卷/003-夜訪.md', plotPath: '.novelwarden/summaries/第一卷/003-夜訪.md', words: 3100 },
      { no: 4, title: '北行', volume: '第一卷', plotPath: '.novelwarden/summaries/第一卷/004-北行.md', words: 0 },
      { no: 12, title: '夜入青雲', volume: '第二卷', chapterPath: 'chapters/第二卷/012-夜入青雲.md', plotPath: '.novelwarden/summaries/第二卷/012-夜入青雲.md', words: 3012 },
    ],
    characters: [{ name: '林昭', aliases: ['阿昭'], path: '.novelwarden/characters/林昭.md' }],
    lore: [{ title: '青雲宗', path: '.novelwarden/lore/青雲宗.md' }],
    docs: [{ key: 'outline', label: '情節大綱', path: '.novelwarden/outline.md' }],
    drafts: [{ path: 'drafts/第一卷/003-夜訪.md', name: '003-夜訪.md', no: 3 }],
    ...extra,
  };
}

function harness(opts = {}) {
  const ui = mount({
    body: 'standalone',
    scripts: ['view.js', 'editor.js'],
    shims: ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'],
    url: URL,
    ...opts,
  });
  const toasts = [];
  ui.window.__nfToast = (m) => toasts.push(m);
  if (!opts.empty) {
    ui.post({ type: 'state', state: viewState() });
  }
  const { doc, window } = ui;
  const h = {
    ui,
    doc,
    toasts,
    panel: () => doc.querySelector('.qo-panel'),
    input: () => doc.querySelector('.qo-panel .qo-input'),
    rows: () => [...doc.querySelectorAll('.qo-panel .qo-item')],
    names: () => h.rows().map((r) => r.querySelector('.qo-name').textContent),
    activeName: () => doc.querySelector('.qo-panel .qo-item.active .qo-name')?.textContent,
    sections: () => [...doc.querySelectorAll('.qo-panel .qo-section')].map((n) => n.textContent),
    note: () => {
      const n = doc.querySelector('.qo-panel .qo-note');
      return n && !n.classList.contains('hidden') ? n.textContent : '';
    },
    mainArea: () => doc.getElementById('edArea'),
    /** 按一下鍵，返回事件（看 defaultPrevented）。 */
    key(target, key, init = {}) {
      const ev = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(ev);
      return ev;
    },
    ctrlP(target = doc.body, init = {}) {
      return h.key(target, 'p', { ctrlKey: true, code: 'KeyP', ...init });
    },
    type(text) {
      h.input().value = text;
      h.input().dispatchEvent(new window.Event('input', { bubbles: true }));
    },
    /** 後端回索引（回最近那一次請求）。 */
    respond(idx = index()) {
      const req = ui.last('requestQuickOpen');
      assert.ok(req, '沒發 requestQuickOpen');
      ui.post({ type: 'quickOpenIndex', requestId: req.requestId, index: idx });
    },
    /** Ctrl+P 開啟並回索引。 */
    open(idx) {
      h.ctrlP();
      h.respond(idx);
    },
    /** 第 n 條之後發出去的訊息（拷成本 realm 的普通物件，deepStrictEqual 才比得上）。 */
    sentAfter(n) {
      return JSON.parse(JSON.stringify(ui.sent.slice(n)));
    },
  };
  return h;
}

describe('「轉到…」面板 · 開啟與關閉', { skip: JSDOM_SKIP }, () => {
  let h;
  beforeEach(() => {
    h = harness();
  });

  test('Ctrl+P 開啟面板、攔下「列印」、焦點進輸入框、發 requestQuickOpen', () => {
    const ev = h.ctrlP();
    assert.ok(h.panel(), '沒開面板');
    assert.equal(ev.defaultPrevented, true);
    assert.equal(h.doc.activeElement, h.input());
    const req = h.ui.last('requestQuickOpen');
    assert.ok(req && typeof req.requestId === 'string' && req.requestId !== '');
  });

  test('Mac 的 Cmd+P 也一樣', () => {
    h.key(h.doc.body, 'p', { metaKey: true });
    assert.ok(h.panel());
  });

  test('Ctrl+Shift+P、Ctrl+Alt+P 不開', () => {
    h.ctrlP(h.doc.body, { shiftKey: true });
    h.ctrlP(h.doc.body, { altKey: true });
    assert.equal(h.panel(), null);
  });

  test('索引到之前說在讀，到了列出前幾章', () => {
    h.ctrlP();
    assert.match(h.note(), /正在讀取/);
    assert.deepEqual(h.rows(), []);
    h.respond();
    assert.deepEqual(h.names(), ['楔子', '入鎮', '夜訪', '北行', '夜入青雲']);
    assert.deepEqual(h.sections(), ['章節']);
    assert.equal(h.activeName(), '楔子');
  });

  test('不是全屏遮罩：掛在 body 上的一塊，沒有 modal-overlay', () => {
    h.open();
    assert.equal(h.panel().parentElement, h.doc.body);
    assert.equal(h.panel().closest('.modal-overlay'), null);
    assert.equal(h.doc.querySelector('.modal-overlay:not(.hidden)'), null);
  });

  test('Esc 關掉，焦點還回開啟之前的地方', () => {
    const chat = h.doc.getElementById('input');
    chat.focus();
    h.ctrlP(chat);
    h.respond();
    assert.equal(h.doc.activeElement, h.input());
    const ev = h.key(h.input(), 'Escape');
    assert.equal(h.panel(), null);
    assert.equal(ev.defaultPrevented, true);
    assert.equal(h.doc.activeElement, chat);
  });

  test('點面板外面關掉；點面板裡面不關', () => {
    h.open();
    h.input().dispatchEvent(new h.ui.window.MouseEvent('mousedown', { bubbles: true }));
    assert.ok(h.panel());
    h.doc.getElementById('wbEditor').dispatchEvent(new h.ui.window.MouseEvent('mousedown', { bubbles: true }));
    assert.equal(h.panel(), null);
  });

  test('開著時再按 Ctrl+P 不另開一個，輸入框裡的字全選上', () => {
    h.open();
    h.type('夜');
    h.ctrlP(h.input());
    assert.equal(h.doc.querySelectorAll('.qo-panel').length, 1);
    assert.equal(h.input().selectionStart, 0);
    assert.equal(h.input().selectionEnd, 1);
  });

  test('再開啟時先拿上一份索引畫出來，同時再要一份新的', () => {
    h.open();
    h.key(h.input(), 'Escape');
    const before = h.ui.sent.filter((m) => m.type === 'requestQuickOpen').length;
    h.ctrlP();
    assert.equal(h.ui.sent.filter((m) => m.type === 'requestQuickOpen').length, before + 1);
    assert.equal(h.names().length, 5);
    h.respond(index({ chapters: [index().chapters[0]] }));
    assert.deepEqual(h.names(), ['楔子']);
  });

  test('新的索引到了、輸入沒變：停在原來選中的那一條上', () => {
    h.open();
    h.key(h.input(), 'Escape');
    h.ctrlP();
    h.key(h.input(), 'ArrowDown');
    h.key(h.input(), 'ArrowDown');
    assert.equal(h.activeName(), '夜訪');
    h.respond();
    assert.equal(h.activeName(), '夜訪');
  });

  test('別的頁面的 requestId 不認', () => {
    h.ctrlP();
    h.ui.post({ type: 'quickOpenIndex', requestId: 'someone-else', index: index() });
    assert.deepEqual(h.rows(), []);
    assert.match(h.note(), /正在讀取/);
  });

  test('還不是小說工程：照實說', () => {
    h.open({ initialized: false, chapters: [], characters: [], lore: [], docs: [], drafts: [] });
    assert.match(h.note(), /還不是小說工程/);
  });

  test('頁內對話方塊或彈窗開著時不開', () => {
    const overlay = h.doc.getElementById('providerModal');
    overlay.classList.remove('hidden');
    h.ctrlP();
    assert.equal(h.panel(), null);
    overlay.classList.add('hidden');
  });
});

describe('「轉到…」面板 · 過濾與選擇', { skip: JSDOM_SKIP }, () => {
  let h;
  beforeEach(() => {
    h = harness();
    h.open();
  });

  test('輸入過濾：標題子串排第一，匹配的字高亮', () => {
    h.type('夜訪');
    assert.equal(h.names()[0], '夜訪');
    const marks = [...h.rows()[0].querySelectorAll('.qo-name mark')].map((m) => m.textContent);
    assert.deepEqual(marks, ['夜訪']);
  });

  test('第十二章直接命中第 12 章，小字寫「第 12 章 · 第二卷 · 3012 字」', () => {
    h.type('第十二章');
    assert.equal(h.names()[0], '夜入青雲');
    assert.equal(h.rows()[0].querySelector('.qo-detail').textContent, '第 12 章 · 第二卷 · 3012 字');
    assert.equal(h.rows()[0].querySelector('.qo-detail mark').textContent, '第 12 章');
  });

  test('每一條有型別標記與一行小字（角色寫別名）', () => {
    h.type('阿昭');
    const row = h.rows()[0];
    assert.equal(row.querySelector('.qo-badge').textContent, '角色');
    assert.equal(row.querySelector('.qo-name').textContent, '林昭');
    assert.equal(row.querySelector('.qo-detail').textContent, '別名 阿昭');
  });

  test('沒有匹配的說一句', () => {
    h.type('zzzz');
    assert.deepEqual(h.rows(), []);
    assert.match(h.note(), /沒有匹配/);
  });

  test('↓↑ 換選中、到頭繞回；改了輸入回到第一條', () => {
    assert.equal(h.activeName(), '楔子');
    h.key(h.input(), 'ArrowDown');
    assert.equal(h.activeName(), '入鎮');
    h.key(h.input(), 'ArrowUp');
    h.key(h.input(), 'ArrowUp');
    assert.equal(h.activeName(), '夜入青雲');
    h.type('夜');
    assert.equal(h.rows()[0].classList.contains('active'), true);
  });

  test('選中的那一條標 aria-selected，輸入框指向它', () => {
    h.key(h.input(), 'ArrowDown');
    const active = h.doc.querySelector('.qo-item.active');
    assert.equal(active.getAttribute('aria-selected'), 'true');
    assert.equal(h.input().getAttribute('aria-activedescendant'), active.id);
  });

  test('超過上限只列前 50 條並說一共幾條', () => {
    h.key(h.input(), 'Escape');
    const many = Array.from({ length: 120 }, (_, i) => ({
      no: i + 1, title: `風雪${i + 1}`, volume: '', chapterPath: `chapters/${i + 1}.md`, words: 1,
    }));
    h.open(index({ chapters: many }));
    h.type('風雪');
    assert.equal(h.rows().length, 50);
    assert.match(h.note(), /只列出前 50 條（一共 120 條）/);
  });

  test('Tab 不把焦點帶出面板', () => {
    const ev = h.key(h.input(), 'Tab');
    assert.equal(ev.defaultPrevented, true);
    assert.ok(h.panel());
  });
});

describe('「轉到…」面板 · 開啟什麼', { skip: JSDOM_SKIP }, () => {
  let h;
  beforeEach(() => {
    h = harness();
    h.open();
  });

  test('章節：Enter 發 openChapter（與工程頁點章節行同一條），面板關掉', () => {
    h.type('夜訪');
    const n = h.ui.sent.length;
    h.key(h.input(), 'Enter');
    assert.deepEqual(h.sentAfter(n), [{ type: 'openChapter', plotRelPath: 'chapters/第一卷/003-夜訪.md' }]);
    assert.equal(h.panel(), null);
  });

  test('只有細綱的章：openChapter 給的是細綱路徑', () => {
    h.type('北行');
    const n = h.ui.sent.length;
    h.key(h.input(), 'Enter');
    assert.deepEqual(h.sentAfter(n), [{ type: 'openChapter', plotRelPath: '.novelwarden/summaries/第一卷/004-北行.md' }]);
  });

  test('章節：Ctrl+Enter 把正文開到第二塊編輯區', () => {
    h.type('夜訪');
    const n = h.ui.sent.length;
    h.key(h.input(), 'Enter', { ctrlKey: true });
    assert.deepEqual(h.sentAfter(n), [{ type: 'openEditor', path: 'chapters/第一卷/003-夜訪.md', pane: 'draft' }]);
  });

  test('角色：Enter 發 openEditor 開那張卡（主區），不帶別的標記', () => {
    h.type('林昭');
    const n = h.ui.sent.length;
    h.key(h.input(), 'Enter');
    assert.deepEqual(h.sentAfter(n), [{ type: 'openEditor', path: '.novelwarden/characters/林昭.md', pane: 'main' }]);
  });

  test('設定、檔案、草稿：Ctrl+Enter 開到第二塊', () => {
    for (const [q, path] of [
      ['青雲宗', '.novelwarden/lore/青雲宗.md'],
      ['情節大綱', '.novelwarden/outline.md'],
      ['003-夜訪.md', 'drafts/第一卷/003-夜訪.md'],
    ]) {
      if (!h.panel()) {
        h.ctrlP();
      }
      h.type(q);
      const n = h.ui.sent.length;
      h.key(h.input(), 'Enter', { ctrlKey: true });
      assert.deepEqual(h.sentAfter(n), [{ type: 'openEditor', path, pane: 'draft' }], q);
    }
  });

  test('點一行也能開；Ctrl+點選開到第二塊', () => {
    h.type('林昭');
    let n = h.ui.sent.length;
    h.ui.clickEl(h.rows()[0]);
    assert.deepEqual(h.sentAfter(n), [{ type: 'openEditor', path: '.novelwarden/characters/林昭.md', pane: 'main' }]);
    h.ctrlP();
    h.type('林昭');
    n = h.ui.sent.length;
    h.rows()[0].dispatchEvent(new h.ui.window.MouseEvent('click', { bubbles: true, ctrlKey: true }));
    assert.deepEqual(h.sentAfter(n), [{ type: 'openEditor', path: '.novelwarden/characters/林昭.md', pane: 'draft' }]);
  });

  test('按下滑鼠不把焦點從輸入框拿走', () => {
    h.type('夜');
    const ev = new h.ui.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    h.rows()[0].dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true);
  });

  test('開啟章節之後焦點進正文那一塊，並排的細綱隨後到了也不把焦點搶走', () => {
    h.doc.getElementById('input').focus();
    h.ctrlP(h.doc.getElementById('input'));
    h.type('夜訪');
    h.key(h.input(), 'Enter');
    h.ui.post({ type: 'editorOpen', file: file('chapters/第一卷/003-夜訪.md', '正文', { kind: 'chapter' }) });
    assert.equal(h.doc.activeElement, h.mainArea());
    h.ui.post({ type: 'editorOpen', file: file('.novelwarden/summaries/第一卷/003-夜訪.md', '細綱', { kind: 'plot' }), pane: 'draft' });
    assert.equal(h.doc.activeElement, h.mainArea());
    // 當前那一塊（Ctrl+S 存的就是它）也是正文那一塊。
    const status = { hasFile: false, path: null };
    h.ui.window.dispatchEvent(new h.ui.window.CustomEvent('nf-editor-query', { detail: status }));
    assert.equal(status.path, 'chapters/第一卷/003-夜訪.md');
  });

  // 後端的 openChapter 在一條訊息裡先開正文、再開細綱（按順序推）；就算哪天兩份回來的先後反了
  // （獨立版對每條 WebSocket 訊息併發處理，連發兩條開啟請求時就是這樣），焦點也還是落在正文那一塊。
  test('細綱先到、正文後到：焦點照樣落在正文那一塊', () => {
    h.type('夜訪');
    h.key(h.input(), 'Enter');
    h.ui.post({ type: 'editorOpen', file: file('.novelwarden/summaries/第一卷/003-夜訪.md', '細綱', { kind: 'plot' }), pane: 'draft' });
    h.ui.post({ type: 'editorOpen', file: file('chapters/第一卷/003-夜訪.md', '正文', { kind: 'chapter' }) });
    assert.equal(h.doc.activeElement, h.mainArea());
    const status = { hasFile: false, path: null };
    h.ui.window.dispatchEvent(new h.ui.window.CustomEvent('nf-editor-query', { detail: status }));
    assert.equal(status.path, 'chapters/第一卷/003-夜訪.md');
  });

  test('Ctrl+Enter 之後焦點進第二塊編輯區', () => {
    h.type('林昭');
    h.key(h.input(), 'Enter', { ctrlKey: true });
    h.ui.post({ type: 'editorOpen', file: file('.novelwarden/characters/林昭.md', '# 林昭', { kind: 'character' }), pane: 'draft' });
    const draftArea = h.ui.panes()[1].querySelector('textarea');
    assert.equal(h.doc.activeElement, draftArea);
  });

  test('別處開啟的檔案不搶焦點（只認從面板開啟的那一份）', () => {
    h.key(h.input(), 'Escape');
    const chat = h.doc.getElementById('input');
    chat.focus();
    h.ui.post({ type: 'editorOpen', file: file('chapters/001-楔子.md', '正文', { kind: 'chapter' }) });
    assert.equal(h.doc.activeElement, chat);
  });
});

describe('「轉到…」面板 · 焦點在別處與輸入法', { skip: JSDOM_SKIP }, () => {
  let h;
  beforeEach(() => {
    h = harness();
  });

  test('焦點在左側對話輸入框裡時 Ctrl+P 照樣開啟', () => {
    const chat = h.doc.getElementById('input');
    chat.focus();
    const ev = h.ctrlP(chat);
    assert.ok(h.panel());
    assert.equal(ev.defaultPrevented, true);
  });

  test('焦點在編輯區裡也能開啟', () => {
    h.ui.post({ type: 'editorOpen', file: file('chapters/001-楔子.md', '正文', { kind: 'chapter' }) });
    h.mainArea().focus();
    h.ctrlP(h.mainArea());
    assert.ok(h.panel());
  });

  test('輸入法組字中的 Ctrl+P 不響應（isComposing / keyCode 229）', () => {
    const chat = h.doc.getElementById('input');
    const ev = h.ctrlP(chat, { isComposing: true });
    assert.equal(h.panel(), null);
    assert.equal(ev.defaultPrevented, false);
    h.ctrlP(chat, { keyCode: 229 });
    assert.equal(h.panel(), null);
  });

  test('面板裡組字中的 Enter、↑↓ 交給輸入法', () => {
    h.open();
    h.type('夜');
    const n = h.ui.sent.length;
    const ev = h.key(h.input(), 'Enter', { isComposing: true });
    assert.equal(ev.defaultPrevented, false);
    assert.equal(h.ui.sent.length, n);
    assert.ok(h.panel());
    const down = h.key(h.input(), 'ArrowDown', { isComposing: true });
    assert.equal(down.defaultPrevented, false);
  });

  test('組字中途的 input 不重算，上屏（compositionend）之後再算', () => {
    h.open();
    const before = h.names();
    h.input().value = 'lin';
    h.input().dispatchEvent(new h.ui.window.InputEvent('input', { bubbles: true, isComposing: true }));
    assert.deepEqual(h.names(), before);
    h.input().value = '林昭';
    h.input().dispatchEvent(new h.ui.window.CompositionEvent('compositionend', { bubbles: true, data: '林昭' }));
    assert.equal(h.names()[0], '林昭');
  });
});

describe('「檔案 → 轉到…」', { skip: JSDOM_SKIP }, () => {
  /** 開啟「檔案」選單，取一項。 */
  function fileItems(h) {
    h.ui.closeMenu();
    h.ui.clickEl(h.doc.querySelector('[data-menu="file"]'));
    return [...h.doc.querySelectorAll('.wb-menu-drop .wb-menu-item')];
  }
  const label = (b) => b.querySelector('.wb-menu-label').textContent;

  test('緊跟「開啟檔案…」，寫著 Ctrl+P', () => {
    const h = harness();
    const items = fileItems(h);
    const at = items.findIndex((b) => label(b) === '轉到…');
    assert.ok(at > 0, items.map(label).join('、'));
    assert.equal(label(items[at - 1]), '開啟檔案…');
    assert.equal(items[at].querySelector('.wb-menu-kbd').textContent, 'Ctrl+P');
    assert.equal(items[at].disabled, false);
  });

  test('點了開啟面板、發 requestQuickOpen', () => {
    const h = harness();
    const item = fileItems(h).find((b) => label(b) === '轉到…');
    h.ui.clickEl(item);
    assert.ok(h.panel());
    assert.equal(h.doc.activeElement, h.input());
    assert.ok(h.ui.last('requestQuickOpen'));
  });
});

describe('「轉到…」 · 沒開工程', { skip: JSDOM_SKIP }, () => {
  test('Ctrl+P 不開面板、不發請求，說一句；也不彈列印', () => {
    const h = harness({ empty: true });
    const ev = h.ctrlP();
    assert.equal(h.panel(), null);
    assert.equal(h.ui.last('requestQuickOpen'), undefined);
    assert.match(h.toasts.join('\n'), /先開啟一個工程/);
    assert.equal(ev.defaultPrevented, true);
  });

  test('「檔案 → 轉到…」置灰，提示說為什麼', () => {
    const h = harness({ empty: true });
    h.ui.clickEl(h.doc.querySelector('[data-menu="file"]'));
    const item = [...h.doc.querySelectorAll('.wb-menu-drop .wb-menu-item')].find(
      (b) => b.querySelector('.wb-menu-label').textContent === '轉到…'
    );
    assert.equal(item.disabled, true);
    assert.match(item.title, /先開啟一個工程/);
  });
});

describe('「轉到…」 · 最近開啟的', { skip: JSDOM_SKIP }, () => {
  const KEY = 'novelforge.quickopen.recent@/tmp/青云';

  test('編輯器裡開過的檔案記在按工程分開的 localStorage 裡，新的在前', () => {
    const h = harness();
    h.ui.post({ type: 'editorOpen', file: file('.novelwarden/characters/林昭.md', '# 林昭', { kind: 'character' }) });
    h.ui.post({ type: 'editorOpen', file: file('chapters/第一卷/003-夜訪.md', '正文', { kind: 'chapter' }) });
    assert.deepEqual(JSON.parse(h.ui.window.localStorage.getItem(KEY)), [
      'chapters/第一卷/003-夜訪.md',
      '.novelwarden/characters/林昭.md',
    ]);
  });

  test('空輸入時「最近開啟的」列在前面，後面接前幾章（已列過的不重複）', () => {
    const h = harness();
    h.ui.post({ type: 'editorOpen', file: file('.novelwarden/characters/林昭.md', '# 林昭', { kind: 'character' }) });
    h.ui.post({ type: 'editorOpen', file: file('.novelwarden/summaries/第一卷/003-夜訪.md', '細綱', { kind: 'plot' }) });
    h.open();
    assert.deepEqual(h.sections(), ['最近開啟的', '章節']);
    assert.deepEqual(h.names(), ['夜訪', '林昭', '楔子', '入鎮', '北行', '夜入青雲']);
    assert.equal(h.activeName(), '夜訪');
  });

  test('從面板開啟的也記下（經編輯器啟用那一下），下次排第一', () => {
    const h = harness();
    h.open();
    h.type('林昭');
    h.key(h.input(), 'Enter');
    h.ui.post({ type: 'editorOpen', file: file('.novelwarden/characters/林昭.md', '# 林昭', { kind: 'character' }) });
    h.ctrlP();
    h.respond();
    assert.equal(h.names()[0], '林昭');
    assert.deepEqual(h.sections()[0], '最近開啟的');
  });

  test('記不進 localStorage（about:blank）時不報錯，只是沒有「最近開啟的」', () => {
    const h = harness({ url: undefined });
    h.ui.post({ type: 'editorOpen', file: file('.novelwarden/characters/林昭.md', '# 林昭', { kind: 'character' }) });
    h.open();
    assert.deepEqual(h.sections(), ['章節']);
  });
});

describe('「轉到…」 · 與臨時標籤', { skip: JSDOM_SKIP }, () => {
  let h;
  const previews = () => [...h.doc.querySelectorAll('.ed-tab.preview')].map((t) => t.dataset.path);
  const tabs = () => [...h.doc.querySelectorAll('.wb-editor')][0].querySelectorAll('.ed-tab');
  /** 後端照請求回 editorOpen（不帶 preview——請求上就沒有）。 */
  const echo = (msg) =>
    h.ui.post({ type: 'editorOpen', file: file(msg.path ?? msg.plotRelPath, '正文'), ...(msg.pane ? { pane: msg.pane } : {}), ...(msg.preview ? { preview: true } : {}) });

  beforeEach(() => {
    h = harness();
    // 工程頁 / 檔案頁單擊開啟的：第 1 章正文是臨時標籤。
    h.ui.post({ type: 'editorOpen', file: file('chapters/001-楔子.md', '正文'), preview: true });
  });

  test('開啟章節：openChapter 不帶 preview', () => {
    h.open();
    h.key(h.input(), 'Enter');
    const msg = h.ui.last('openChapter');
    assert.equal(msg.plotRelPath, 'chapters/001-楔子.md');
    assert.equal('preview' in msg, false);
  });

  test('開啟的正是那個臨時標籤：它就此轉正（被不帶 preview 的開啟請求開啟一次）', () => {
    assert.deepEqual(previews(), ['chapters/001-楔子.md']);
    h.open();
    h.key(h.input(), 'Enter');
    echo({ path: 'chapters/001-楔子.md' });
    assert.deepEqual(previews(), []);
  });

  test('開啟別的檔案：開成正常標籤，不換掉那個臨時標籤', () => {
    h.open();
    h.type('林昭');
    h.key(h.input(), 'Enter');
    const msg = h.ui.last('openEditor');
    assert.equal(msg.path, '.novelwarden/characters/林昭.md');
    assert.equal('preview' in msg, false);
    echo(msg);
    assert.equal(tabs().length, 2);
    assert.deepEqual(previews(), ['chapters/001-楔子.md']);
  });
});

describe('「轉到…」 · 外掛形態', { skip: JSDOM_SKIP }, () => {
  test('沒有 #wbEditor（外掛的 webview）就不裝：Ctrl+P 什麼都不做', () => {
    const ui = mount({ body: 'webview', scripts: ['view.js', 'editor.js'] });
    const ev = new ui.window.KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true });
    ui.doc.body.dispatchEvent(ev);
    assert.equal(ui.doc.querySelector('.qo-panel'), null);
    assert.equal(ev.defaultPrevented, false);
    assert.equal(ui.last('requestQuickOpen'), undefined);
  });
});
