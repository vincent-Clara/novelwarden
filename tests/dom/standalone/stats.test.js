/**
 * 碼字統計（獨立版內建編輯器，`media/src/editor/stats.ts` / `statsPanel.ts` / `statsDaily.ts`，「檢視 → 統計」在
 * `view/statsMenu.ts`）。口徑（一處改動算幾個字、哪些算碼字、時長、今日記錄怎麼合）在
 * tests/unit/editor/writingStats.test.js 釘著，這裡釘整條鏈路：
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 全文與選中 | 「全文 N 字」；有選區「選中 N 字 / 全文 M 字」；字元數在懸停提示裡 |
 * | 距目標 | 章節正文「3,120 / 4,000 字，還差 880」＋細進度條、實時跟著打字變、超了說超出、開頭的 `# 標題` 不算；細綱、草稿、沒目標、索引裡沒有的不顯示；章節索引更新了跟著變 |
 * | 本次碼字 | 打字、輸入法上屏漲，退格倒扣；貼上、一鍵排版、全部替換不漲；撤銷替換不動、撤銷自己打的減回去、重做加回來；組字中途不算 |
 * | 面板 | 點那一格彈出（本章、本次、今日、按檔案、重新開始計時），開著打字跟著變，Esc / 點外面 / 再點一下收起，按下滑鼠不奪焦點 |
 * | 時長與速度 | 停筆超過 2 分鐘那段不算；寫夠 1 分鐘才報速度 |
 * | 重新開始計時 | 本次歸零，今日不動；面板裡與「檢視」選單裡都有 |
 * | 「檢視 → 統計」 | 三個開關預設值與 ✓、關掉距目標就不顯示、記進 `novelforge.editor.prefs` 而不沖掉段落那幾項（反過來也一樣） |
 * | 今日碼字 | 重新整理後還在、別的視窗記的（`storage` 事件）加進來且不被這邊覆蓋、過了午夜換新的一天、壞值回落、記不了只算這一頁 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file } = require('../../helpers/dom');

const SHIMS = ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'];
const PROJECT = '/書/青雲劍錄';
const URL = `http://localhost/?project=${encodeURIComponent(PROJECT)}`;
const DAILY_KEY = `novelforge.editor.stats.daily@${PROJECT}`;
const PREFS_KEY = 'novelforge.editor.prefs';
/** 狀態列把本次 / 今日也顯示出來（預設關）。 */
const SHOW_ALL = JSON.stringify({ stats: { goal: true, session: true, today: true } });

/** 章節索引裡的第 3 章（目標 10 字）與第 4 章（沒寫目標）。 */
const CH3 = 'chapters/003-夜訪.md';
const CH4 = 'chapters/004-北行.md';
const PLOT3 = '.novelwarden/summaries/003-夜訪.md';
const entry = (no, title, extra) => ({
  no,
  label: `第 ${no} 章《${title}》`,
  title,
  relPath: `chapters/00${no}-${title}.md`,
  plotPath: `.novelwarden/summaries/00${no}-${title}.md`,
  plotExists: true,
  chapterPath: `chapters/00${no}-${title}.md`,
  wordCount: 0,
  stage: 'finalize',
  ...extra,
});
const INDEX = [entry(3, '夜訪', { targetWords: 10 }), entry(4, '北行')];

function harness(opts = {}) {
  const ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: SHIMS, url: URL, ...opts });
  const toasts = [];
  ui.window.__nfToast = (m) => toasts.push(m);
  ui.doc.execCommand = () => true;
  const area = () => ui.doc.getElementById('edArea');
  const cell = () => ui.doc.getElementById('edStatusWords');
  const h = {
    ui,
    toasts,
    area,
    cell,
    words: () => cell().textContent,
    bar: () => cell().querySelector('.ed-words-bar'),
    open(path, text, extra) {
      ui.post({ type: 'editorOpen', file: file(path, text, extra) });
      h.end();
    },
    index(chapters = INDEX) {
      ui.post({ type: 'chapterIndex', chapters });
    },
    /** 游標挪到末尾。 */
    end() {
      const a = area();
      a.setSelectionRange(a.value.length, a.value.length);
    },
    select(start, end) {
      area().setSelectionRange(start, end);
      area().dispatchEvent(new ui.window.Event('select', { bubbles: true }));
    },
    /** 在選區處打進去（鍵盤），`inputType` 換成 insertFromPaste 就是貼上。 */
    type(text, inputType = 'insertText') {
      const a = area();
      const s = a.selectionStart;
      const e = a.selectionEnd;
      a.value = a.value.slice(0, s) + text + a.value.slice(e);
      a.setSelectionRange(s + text.length, s + text.length);
      a.dispatchEvent(new ui.window.InputEvent('input', { bubbles: true, inputType }));
    },
    paste(text) {
      h.type(text, 'insertFromPaste');
    },
    backspace(n) {
      const a = area();
      const p = a.selectionStart;
      a.value = a.value.slice(0, p - n) + a.value.slice(p);
      a.setSelectionRange(p - n, p - n);
      a.dispatchEvent(new ui.window.InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    },
    /** 輸入法：`steps` 是組字中途顯示的拼音，最後上屏 `commit`。 */
    compose(steps, commit) {
      const a = area();
      const base = a.value;
      const at = a.selectionStart;
      a.dispatchEvent(new ui.window.CompositionEvent('compositionstart', { bubbles: true }));
      for (const step of steps) {
        a.value = base.slice(0, at) + step + base.slice(at);
        a.setSelectionRange(at + step.length, at + step.length);
        a.dispatchEvent(new ui.window.InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', isComposing: true }));
      }
      return () => {
        a.value = base.slice(0, at) + commit + base.slice(at);
        a.setSelectionRange(at + commit.length, at + commit.length);
        a.dispatchEvent(new ui.window.CompositionEvent('compositionend', { bubbles: true, data: commit }));
      };
    },
    key(init, target = area()) {
      const ev = new ui.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(ev);
      return ev;
    },
    undo: () => h.key({ key: 'z', ctrlKey: true }),
    redo: () => h.key({ key: 'y', ctrlKey: true }),
    /** 狀態列上的「本次 ±N 字」那幾個字。 */
    session: () => /本次 ([+-]?[\d,]+) 字/.exec(h.words())?.[1],
    today: () => /今日 (-?[\d,]+) 字/.exec(h.words())?.[1],
    panel: () => ui.doc.querySelector('.ed-stats-panel'),
    clickCell() {
      ui.clickEl(cell());
      return h.panel();
    },
    sec: (cls) => h.panel()?.querySelector(`.${cls}`),
    flushDaily() {
      ui.window.dispatchEvent(new ui.window.Event('pagehide'));
    },
    daily: () => JSON.parse(ui.window.localStorage.getItem(DAILY_KEY) || 'null'),
    /** 把視窗裡的 `Date.now` 釘在某一刻（時長、跨午夜）。 */
    clock(at) {
      ui.window.Date.now = () => at;
    },
  };
  return h;
}

/** 本地日期的 `YYYY-MM-DD`（與 `writingStats.dayKey` 同一個演算法，測的是「今天」是哪個鍵）。 */
function dayOf(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('狀態列字數那一格：全文與選中', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
    h.open('notes.md', 'hello world 林昭。');
  });

  test('沒有選區：全文 N 字（中文按字、英文按詞）', () => {
    assert.equal(h.words(), '全文 4 字');
  });

  test('有選區：選中 N 字 / 全文 M 字', () => {
    h.select(0, 5);
    assert.equal(h.words(), '選中 1 字 / 全文 4 字');
    h.select(12, 14);
    assert.equal(h.words(), '選中 2 字 / 全文 4 字');
  });

  test('選區收起：只寫全文', () => {
    h.select(3, 3);
    assert.equal(h.words(), '全文 4 字');
  });

  test('字元數（含標點與空白）在懸停提示裡', () => {
    assert.match(h.cell().title, /15 字元/);
  });

  test('沒有目標時不畫進度條', () => {
    assert.equal(h.bar().classList.contains('hidden'), true);
  });

  test('上千的字數帶千分位', () => {
    h.open('long.md', '林'.repeat(3120));
    assert.equal(h.words(), '全文 3,120 字');
  });
});

describe('狀態列字數那一格：距目標（只對章節正文）', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
    h.index();
    h.open(CH3, '# 夜訪\n\n林昭推開門。', { kind: 'chapter' });
  });

  test('本章字數 / 目標，還差多少；開頭的「# 標題」那一行不算（與工程頁同一個數法）', () => {
    assert.equal(h.words(), '5 / 10 字，還差 5');
  });

  test('一條細進度條，寬度是寫了幾成', () => {
    assert.equal(h.bar().classList.contains('hidden'), false);
    assert.equal(h.bar().querySelector('.ed-words-fill').style.width, '50%');
    assert.equal(h.bar().classList.contains('enough'), false);
  });

  test('打字實時跟著變，不等儲存；到了八成進度條換色', () => {
    h.type('雨下了');
    assert.equal(h.words(), '8 / 10 字，還差 2');
    assert.equal(h.bar().classList.contains('enough'), true);
    h.type('三天');
    assert.equal(h.words(), '10 / 10 字，正好寫夠');
  });

  test('超了說超出多少，進度條停在滿格', () => {
    h.type('又');
    assert.equal(h.words(), '11 / 10 字，超出 1');
    assert.equal(h.bar().querySelector('.ed-words-fill').style.width, '100%');
    assert.equal(h.bar().classList.contains('over'), true);
  });

  test('有選區時前面加選中字數', () => {
    h.select(6, 8);
    assert.equal(h.words(), '選中 2 字 · 11 / 10 字，超出 1');
    h.end();
  });

  test('懸停提示說目標從哪來', () => {
    assert.match(h.cell().title, /本章目標 10 字（細綱的目標字數，沒寫就是小說配置的每章字數）/);
  });

  test('章節索引裡的目標變了：跟著變', () => {
    h.index([entry(3, '夜訪', { targetWords: 20 }), entry(4, '北行')]);
    assert.equal(h.words(), '11 / 20 字，還差 9');
  });

  test('細綱不顯示目標', () => {
    h.open(PLOT3, '## 梗概\n\n林昭夜訪。', { kind: 'plot' });
    assert.equal(h.words(), '全文 6 字');
    assert.equal(h.bar().classList.contains('hidden'), true);
  });

  test('草稿不顯示目標', () => {
    h.open('drafts/003-夜訪.md', '草稿裡的字', { kind: 'draft' });
    assert.equal(h.words(), '全文 5 字');
  });

  test('這一章沒寫目標（細綱與小說配置都沒有）：不顯示', () => {
    h.open(CH4, '出了城。', { kind: 'chapter' });
    assert.equal(h.words(), '全文 3 字');
  });

  test('章節索引裡還沒有這一章：不顯示', () => {
    h.open('chapters/005-新章.md', '新的一章', { kind: 'chapter' });
    assert.equal(h.words(), '全文 4 字');
  });

  test('「檢視 → 統計」關掉「距目標」：章節正文也只寫全文', () => {
    h.open(CH3, '# 夜訪\n\n林昭推開門。', { kind: 'chapter' });
    assert.match(h.words(), /\/ 20 字/);
    h.ui.window.dispatchEvent(new h.ui.window.CustomEvent('nf-stats-command', { detail: { name: 'toggleGoal' } }));
    assert.equal(h.words(), '全文 11 字');
    h.ui.window.dispatchEvent(new h.ui.window.CustomEvent('nf-stats-command', { detail: { name: 'toggleGoal' } }));
    assert.match(h.words(), /11 \/ 20 字/);
  });
});

describe('本次碼字：只算親手打的字', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness({ storage: { [PREFS_KEY]: SHOW_ALL } });
    h.index();
    h.open(CH3, '林昭。\n\n\n她笑了。  ', { kind: 'chapter' });
  });

  test('開著之後還沒動筆：本次 0 字', () => {
    assert.equal(h.session(), '0');
  });

  test('鍵盤打字：漲', () => {
    h.type('推開門');
    assert.equal(h.session(), '+3');
  });

  test('貼上大段文字：全文漲、本次不漲', () => {
    h.paste('門外的雨下了一整夜');
    assert.match(h.words(), /^1[0-9] \/ 10 字/);
    assert.equal(h.session(), '+3');
  });

  test('一鍵排版：不漲', () => {
    const before = h.area().value;
    h.ui.clickEl(h.ui.doc.querySelector('#edToolbar .ed-format-btn'));
    assert.notEqual(h.area().value, before, '夾具要讓排版真的改點什麼');
    assert.equal(h.session(), '+3');
  });

  test('全部替換（替換之後字多了）：不漲', () => {
    h.key({ key: 'h', ctrlKey: true });
    const part = (cls) => h.ui.doc.querySelector(`#wbEditor .ed-find .${cls}`);
    part('ed-replace-input').value = '林昭昭';
    part('ed-find-input').value = '林昭';
    part('ed-find-input').dispatchEvent(new h.ui.window.Event('input', { bubbles: true }));
    h.ui.clickEl(part('ed-replace-all'));
    assert.match(h.area().value, /林昭昭/);
    assert.equal(h.session(), '+3');
    h.key({ key: 'Escape' }, part('ed-find-input'));
  });

  test('撤銷替換、排版、貼上：不動；再撤銷自己打的那三個字：減回去', () => {
    h.undo();
    h.undo();
    h.undo();
    assert.equal(h.session(), '+3');
    h.undo();
    assert.equal(h.session(), '0');
    assert.equal(h.area().value, '林昭。\n\n\n她笑了。  ');
  });

  test('重做：自己打的加回來，貼上的照樣不算', () => {
    h.redo();
    assert.equal(h.session(), '+3');
    h.redo();
    assert.equal(h.session(), '+3');
  });

  test('退格刪字：倒扣', () => {
    h.end();
    h.type('一二三四');
    assert.equal(h.session(), '+7');
    h.backspace(2);
    assert.equal(h.session(), '+5');
  });

  test('輸入法組字中途（拼音還沒上屏）不算，上屏那一下算', () => {
    const commit = h.compose(['y', 'ye'], '夜');
    assert.equal(h.session(), '+5');
    commit();
    assert.equal(h.session(), '+6');
  });

  test('今日碼字與本次同一個口徑', () => {
    assert.equal(h.today(), '6');
  });
});

describe('碼字統計面板', { skip: JSDOM_SKIP }, () => {
  let h;
  const t0 = new Date(2026, 9, 18, 14, 2).getTime();
  before(() => {
    h = harness({ storage: { [PREFS_KEY]: SHOW_ALL } });
    h.clock(t0);
    h.index();
    h.open(CH3, '# 夜訪\n\n林昭', { kind: 'chapter' });
  });

  test('按下滑鼠不奪編輯區的焦點', () => {
    const ev = new h.ui.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    h.cell().dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true);
  });

  test('點那一格：彈出面板（本章、本次碼字、今日碼字、按檔案、重新開始計時）', () => {
    const panel = h.clickCell();
    assert.ok(panel, '面板沒出來');
    assert.equal(panel.parentElement, h.ui.doc.body);
    const heads = [...panel.querySelectorAll('.ed-stats-head')].map((n) => n.firstChild.textContent);
    assert.deepEqual(heads, ['本章', '本次碼字', '今日碼字', '本次按檔案']);
    assert.ok(panel.querySelector('.ed-stats-restart'));
    assert.equal(h.cell().getAttribute('aria-expanded'), 'true');
  });

  test('本章：標題、字數與目標', () => {
    assert.equal(h.sec('ed-stats-file').querySelector('.ed-stats-title').textContent, '第 3 章《夜訪》');
    assert.equal(h.sec('ed-stats-file').querySelector('.ed-stats-big').textContent, '2 / 10 字，還差 8');
  });

  test('還沒動筆：按檔案那一節照實說', () => {
    assert.match(h.sec('ed-stats-files').textContent, /還沒有動筆/);
  });

  test('開著時接著打字：數跟著變；時長只算兩下之間、速度寫夠 1 分鐘才報', () => {
    h.type('推');
    h.clock(t0 + 30_000);
    h.type('開');
    assert.equal(h.sec('ed-stats-session').querySelector('.ed-stats-big').textContent, '+2 字');
    assert.match(h.sec('ed-stats-session').textContent, /寫了 不到 1 分鐘 · 寫夠 1 分鐘才算速度/);
    h.clock(t0 + 120_000);
    h.type('門');
    assert.match(h.sec('ed-stats-session').textContent, /寫了 2 分鐘 · 每小時約 90 字/);
  });

  test('停筆超過 2 分鐘的那段不算時長', () => {
    h.clock(t0 + 120_000 + 10 * 60_000);
    h.type('。');
    h.clock(t0 + 120_000 + 10 * 60_000 + 60_000);
    h.type('雨');
    assert.match(h.sec('ed-stats-session').textContent, /寫了 3 分鐘/);
  });

  test('按檔案：這一章一行，寫了多少、多久', () => {
    const rows = [...h.sec('ed-stats-files').querySelectorAll('.ed-stats-row')];
    assert.deepEqual(
      rows.map((r) => [...r.children].map((c) => c.textContent)),
      [['第 3 章《夜訪》', '+4 字', '3 分鐘']]
    );
    assert.equal(rows[0].title, CH3);
  });

  test('今日碼字：同一個數，說清跨重新整理、跨視窗累計', () => {
    assert.equal(h.sec('ed-stats-today').querySelector('.ed-stats-big').textContent, '4 字');
    assert.match(h.sec('ed-stats-today').textContent, /重新整理、幾個視窗都累計/);
  });

  test('Esc 收起', () => {
    h.key({ key: 'Escape' }, h.ui.doc.body);
    assert.equal(h.panel(), null);
    assert.equal(h.cell().getAttribute('aria-expanded'), 'false');
  });

  test('點面板外面收起；點面板裡面不收', () => {
    h.clickCell();
    h.panel().dispatchEvent(new h.ui.window.MouseEvent('mousedown', { bubbles: true }));
    assert.ok(h.panel());
    h.ui.doc.body.dispatchEvent(new h.ui.window.MouseEvent('mousedown', { bubbles: true }));
    assert.equal(h.panel(), null);
  });

  test('再點一下那一格收起', () => {
    h.clickCell();
    assert.ok(h.panel());
    h.clickCell();
    assert.equal(h.panel(), null);
  });

  test('面板裡的「重新開始計時」：本次歸零、明細清空，今日不動', () => {
    h.clickCell();
    h.ui.clickEl(h.panel().querySelector('.ed-stats-restart'));
    assert.equal(h.sec('ed-stats-session').querySelector('.ed-stats-big').textContent, '0 字');
    assert.match(h.sec('ed-stats-files').textContent, /還沒有動筆/);
    assert.equal(h.sec('ed-stats-today').querySelector('.ed-stats-big').textContent, '4 字');
    assert.equal(h.session(), '0');
    assert.equal(h.today(), '4');
    assert.match(h.toasts.at(-1), /重新算/);
  });

  test('重新開始計時之後撤銷之前打的字：不倒扣這一次', () => {
    h.undo();
    assert.equal(h.session(), '0');
    h.key({ key: 'Escape' }, h.ui.doc.body);
  });
});

describe('「檢視 → 統計」', { skip: JSDOM_SKIP }, () => {
  let h;
  const viewMenu = () => {
    h.ui.closeMenu();
    h.ui.clickEl(h.ui.doc.querySelector('[data-menu="view"]'));
    return h.ui.doc.querySelector('.wb-menu-drop');
  };
  const item = (drop, label) =>
    [...drop.querySelectorAll('.wb-menu-item')].find((b) => b.querySelector('.wb-menu-label').textContent === label);
  /** 懸停「統計」，返回子選單裡那幾項。 */
  const statsItems = () => {
    item(viewMenu(), '統計').dispatchEvent(new h.ui.window.MouseEvent('mouseenter'));
    return [...h.ui.doc.querySelectorAll('.wb-menu-drop.submenu .wb-menu-item')];
  };
  const sub = (label) => statsItems().find((b) => b.querySelector('.wb-menu-label').textContent === label);
  const storedPrefs = () => JSON.parse(h.ui.window.localStorage.getItem(PREFS_KEY));

  before(() => {
    // 段落那幾項先記著一個非預設值：統計寫偏好時不許把它沖掉。
    h = harness({ storage: { [PREFS_KEY]: JSON.stringify({ autoPair: false }) } });
    h.index();
    h.open(CH3, '林昭推開門。', { kind: 'chapter' });
  });

  test('「檢視」裡有「統計 ›」與「重新開始計時」', () => {
    const drop = viewMenu();
    assert.ok(item(drop, '統計'));
    assert.ok(item(drop, '重新開始計時'));
    assert.equal(item(drop, '統計').disabled, false);
    h.ui.closeMenu();
  });

  test('三個開關：距目標預設開，本次 / 今日預設關', () => {
    const states = statsItems().map((b) => [b.querySelector('.wb-menu-label').textContent, b.getAttribute('aria-checked')]);
    assert.deepEqual(states, [
      ['狀態列顯示距目標', 'true'],
      ['狀態列顯示本次碼字', 'false'],
      ['狀態列顯示今日碼字', 'false'],
    ]);
    h.ui.closeMenu();
  });

  test('預設的狀態列：只有全文 / 選中與距目標', () => {
    assert.equal(h.words(), '5 / 10 字，還差 5');
  });

  test('開啟「本次碼字」：狀態列多一項，記進偏好且不沖掉段落那幾項', () => {
    h.ui.clickEl(sub('狀態列顯示本次碼字'));
    assert.equal(h.words(), '5 / 10 字，還差 5 · 本次 0 字');
    assert.deepEqual(storedPrefs(), { autoPair: false, stats: { goal: true, session: true, today: false } });
    assert.equal(sub('狀態列顯示本次碼字').getAttribute('aria-checked'), 'true');
    h.ui.closeMenu();
  });

  test('開啟「今日碼字」、關掉「距目標」', () => {
    h.ui.clickEl(sub('狀態列顯示今日碼字'));
    h.ui.clickEl(sub('狀態列顯示距目標'));
    assert.equal(h.words(), '全文 5 字 · 本次 0 字 · 今日 0 字');
    assert.equal(storedPrefs().stats.goal, false);
  });

  test('反過來：「編輯」選單切成對符號，統計的偏好還在', () => {
    h.ui.closeMenu();
    h.ui.clickEl(h.ui.doc.querySelector('[data-menu="edit"]'));
    const pair = [...h.ui.doc.querySelectorAll('.wb-menu-drop .wb-menu-item')].find(
      (b) => b.querySelector('.wb-menu-label').textContent === '成對符號自動補全'
    );
    h.ui.clickEl(pair);
    const prefs = storedPrefs();
    assert.equal(prefs.autoPair, true);
    assert.deepEqual(prefs.stats, { goal: false, session: true, today: true });
  });

  test('重新整理之後開關照舊', () => {
    const again = harness({ storage: { [PREFS_KEY]: h.ui.window.localStorage.getItem(PREFS_KEY) } });
    again.open('notes.md', '林昭');
    assert.equal(again.words(), '全文 2 字 · 本次 0 字 · 今日 0 字');
  });

  test('選單裡的「重新開始計時」：本次歸零、說一句', () => {
    h.type('雨');
    assert.equal(h.session(), '+1');
    h.ui.clickEl(item(viewMenu(), '重新開始計時'));
    assert.equal(h.session(), '0');
    assert.equal(h.today(), '1');
    assert.match(h.toasts.at(-1), /重新算/);
  });
});

describe('大章節：每敲一下不整份重數', { skip: JSDOM_SKIP }, () => {
  // 定時器換成手撥的：整份重數是節流到定時器裡的，不撥就不會發生——顯示對了，說明走的是隻數改動那一段。
  let h;
  const big = '林'.repeat(30_000);
  before(() => {
    h = harness({ shims: [...SHIMS, 'fakeTimers'] });
    h.open('big.md', big);
  });

  test('開啟時數一遍', () => {
    assert.equal(h.words(), '全文 30,000 字');
  });

  test('打字、貼上、退格：當場就對（只數改動那一段，不等重數）', () => {
    h.type('昭');
    assert.equal(h.words(), '全文 30,001 字');
    h.paste(' and more');
    assert.equal(h.words(), '全文 30,003 字');
    h.backspace(4);
    assert.equal(h.words(), '全文 30,002 字');
  });

  test('英文詞中間打字：詞數照對', () => {
    h.backspace(1);
    assert.equal(h.words(), '全文 30,002 字');
    h.type('x');
    assert.equal(h.words(), '全文 30,002 字', '「and」接成「andx」還是一個詞');
    h.type(' y');
    assert.equal(h.words(), '全文 30,003 字');
  });

  test('撤銷（沒有改動可用）：先顯示上一次的數，節流的那一下到了再整份重數', () => {
    h.undo();
    assert.equal(h.area().value, `${big}昭 and`);
    assert.equal(h.words(), '全文 30,003 字');
    h.ui.window.__clock.tick(300);
    assert.equal(h.words(), '全文 30,002 字');
  });
});

describe('今日碼字：按工程、按本地日期，跨重新整理、跨視窗', { skip: JSDOM_SKIP }, () => {
  const t0 = new Date(2026, 9, 18, 21, 0).getTime();
  const today = dayOf(t0);
  let first;
  let saved;

  test('碼了字、頁面藏起來（或關掉）時寫進 localStorage，鍵裡帶工程', () => {
    first = harness({ storage: { [PREFS_KEY]: SHOW_ALL } });
    first.clock(t0);
    first.open('notes.md', '');
    first.type('林昭推開門');
    first.flushDaily();
    saved = first.ui.window.localStorage.getItem(DAILY_KEY);
    assert.deepEqual(JSON.parse(saved), { v: 1, days: { [today]: { words: 5, ms: 0 } } });
  });

  test('重新整理之後今日碼字還在，本次從 0 起', () => {
    const second = harness({ storage: { [PREFS_KEY]: SHOW_ALL, [DAILY_KEY]: saved } });
    second.clock(t0 + 60_000);
    second.open('notes.md', '林昭推開門');
    assert.equal(second.today(), '5');
    assert.equal(second.session(), '0');
  });

  test('別的視窗記了（storage 事件）：加進來；這邊再寫時只加自己的增量，不覆蓋別人的', () => {
    const h = harness({ storage: { [PREFS_KEY]: SHOW_ALL, [DAILY_KEY]: saved } });
    h.clock(t0 + 120_000);
    h.open('notes.md', '');
    // 另一個視窗把今天記成了 12 字（它自己又碼了 7 個）。
    const other = JSON.stringify({ v: 1, days: { [today]: { words: 12, ms: 0 } } });
    h.ui.window.localStorage.setItem(DAILY_KEY, other);
    h.ui.window.dispatchEvent(new h.ui.window.StorageEvent('storage', { key: DAILY_KEY, newValue: other }));
    assert.equal(h.today(), '12');
    h.type('雨夜');
    assert.equal(h.today(), '14');
    h.flushDaily();
    assert.equal(h.daily().days[today].words, 14);
  });

  test('過了午夜：換新的一天，前一天的照樣記在前一天', () => {
    const h = harness({ storage: { [PREFS_KEY]: SHOW_ALL } });
    const late = new Date(2026, 9, 18, 23, 59).getTime();
    h.clock(late);
    h.open('notes.md', '');
    h.type('林昭');
    assert.equal(h.today(), '2');
    h.clock(late + 2 * 60_000);
    h.type('夜');
    assert.equal(h.today(), '1');
    assert.equal(h.session(), '+3', '本次不分日子');
    h.flushDaily();
    assert.deepEqual(
      Object.fromEntries(Object.entries(h.daily().days).map(([k, v]) => [k, v.words])),
      { [dayOf(late)]: 2, [dayOf(late + 2 * 60_000)]: 1 }
    );
  });

  test('localStorage 裡那份寫壞了：當沒有，從零記，寫回去的是好的', () => {
    const h = harness({ storage: { [PREFS_KEY]: SHOW_ALL, [DAILY_KEY]: '{不是 JSON' } });
    h.clock(t0);
    h.open('notes.md', '');
    assert.equal(h.today(), '0');
    h.type('林昭推');
    h.flushDaily();
    assert.deepEqual(h.daily(), { v: 1, days: { [today]: { words: 3, ms: 0 } } });
  });

  test('換了工程：沒寫進去的按原來那個工程記，本次從頭算', () => {
    const h = harness({ storage: { [PREFS_KEY]: SHOW_ALL } });
    h.clock(t0);
    h.open('notes.md', '');
    h.type('林昭');
    const url = new h.ui.window.URL(h.ui.window.location.href);
    url.searchParams.set('project', '/書/另一本');
    h.ui.window.history.replaceState(null, '', url.toString());
    h.ui.window.dispatchEvent(new h.ui.window.Event('nf-workspace-reset'));
    assert.equal(h.daily().days[today].words, 2);
    assert.equal(h.ui.window.localStorage.getItem('novelforge.editor.stats.daily@/書/另一本'), null);
    h.open('other.md', '');
    assert.equal(h.session(), '0');
    assert.equal(h.today(), '0');
  });

  test('記不下來（沒有工程標識）：只算這一頁，面板上照實說', () => {
    const h = harness({ url: undefined, storage: { [PREFS_KEY]: SHOW_ALL } });
    h.open('notes.md', '');
    h.type('林昭');
    assert.equal(h.today(), '2');
    h.flushDaily();
    const keys = Object.keys(h.ui.window.localStorage).filter((k) => k.startsWith('novelforge.editor.stats.daily'));
    assert.deepEqual(keys, [], '一條今日碼字都沒往 localStorage 裡寫');
    h.clickCell();
    assert.match(h.sec('ed-stats-today').textContent, /只算這一頁/);
  });
});
