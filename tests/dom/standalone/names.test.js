/**
 * 名詞補全（獨立版內建編輯器，`media/src/editor/names.ts`；匹配與排序的口徑在 tests/unit/editor/namesCore.test.js）。
 *
 * jsdom 沒有排版：彈出框貼不貼著游標測不了畫素，只測它掛在 body 上、給了 left / top。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 按鍵彈出 | Alt+/ 發 `requestNameIndex`、表到了才彈；游標前「林」列出以它開頭的；高亮、型別、一句話；Esc 收起且不往下傳 |
 * | 選與插入 | ↑↓ 繞著選、Enter / Tab 插入、點一行插入；換掉打過的字、游標落在後面；**一步撤銷** |
 * | 別名 | 「阿昭 → 林昭」，插入的是阿昭 |
 * | 空查詢 | 什麼都匹配不上就列全部，最近在本檔案出現的排前面 |
 * | 接著打字 | 跟著篩；打了標點收起 |
 * | 收起 | 點外面（框裡按下不收）、切標籤、滾輪 |
 * | 名詞表 | 再要時帶著 `have`；沒變只回指紋照樣能彈；變了按新的列；別的頁面的 requestId 不認 |
 * | 不彈 | 配置這類檔案（`kind: setting`）說一句、不發請求；輸入法組字中的 Alt+/ 放行 |
 * | 邊打邊彈 | 上屏「沈懷」彈、Tab 接受、一步撤銷；**回車不被搶**（照常換段、框收起）；繼續打字收起；打完整了、一個字、組字中途不彈；開著框又組字先藏起來、上屏再篩；鍵盤打字也彈；配置檔案不彈 |
 * | 「檢視 → 補全」 | 「名詞補全 Alt+/」（不能補全的檔案上置灰、點了彈出）與「邊打邊彈名詞補全」（預設關、記進 `novelforge.editor.prefs` 不沖掉別的、再點關掉刪掉那一項） |
 * | 碼字統計 | 補上的字算作者碼的字，撤銷那一步減回去 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file } = require('../../helpers/dom');

const SHIMS = ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'];
const URL = `http://localhost/?project=${encodeURIComponent('/書/青雲劍錄')}`;
const PREFS_KEY = 'novelforge.editor.prefs';
const CH = 'chapters/001-楔子.md';

const NAMES = {
  initialized: true,
  names: [
    { name: '林昭', aliases: ['阿昭', '小林'], source: 'character', category: '', brief: '青雲宗外門弟子。', path: '.novelwarden/characters/林昭.md' },
    { name: '林昭陽', aliases: [], source: 'character', category: '', brief: '', path: '.novelwarden/characters/林昭陽.md' },
    { name: '沈懷山', aliases: ['老沈'], source: 'character', category: '', brief: '', path: '.novelwarden/characters/沈懷山.md' },
    { name: '青雲宗', aliases: ['青雲門'], source: 'lore', category: '門派', brief: '正道第一大宗', path: '.novelwarden/lore/門派/青雲宗.md' },
    { name: '青崖鎮', aliases: [], source: 'lore', category: '地點', brief: '', path: '.novelwarden/lore/地點/青崖鎮.md' },
    { name: '黑水河', aliases: [], source: 'unfiled', category: '地點', brief: '河上起了霧' },
    { name: 'Lin Zhao', aliases: [], source: 'character', category: '', brief: '', path: '.novelwarden/characters/lin.md' },
    { name: 'Lindy', aliases: [], source: 'character', category: '', brief: '', path: '.novelwarden/characters/lindy.md' },
  ],
};

function harness(opts = {}) {
  const ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: SHIMS, url: URL, ...opts });
  const toasts = [];
  ui.window.__nfToast = (m) => toasts.push(m);
  ui.doc.execCommand = () => true;
  const area = () => ui.doc.getElementById('edArea');
  const fire = (inputType, extra) => area().dispatchEvent(new ui.window.InputEvent('input', { bubbles: true, inputType, ...extra }));
  const h = {
    ui,
    toasts,
    area,
    open(path, text, kind = 'chapter') {
      ui.post({ type: 'editorOpen', file: file(path, text, kind ? { kind } : undefined) });
      h.end();
    },
    end() {
      const a = area();
      a.setSelectionRange(a.value.length, a.value.length);
    },
    caret: () => area().selectionStart,
    /** 鍵盤打字：一下一個字。 */
    type(text) {
      for (const ch of text) {
        const a = area();
        const s = a.selectionStart;
        a.value = a.value.slice(0, s) + ch + a.value.slice(a.selectionEnd);
        a.setSelectionRange(s + ch.length, s + ch.length);
        fire('insertText', { data: ch });
      }
    },
    /** 輸入法：組字幾步（拼音），返回上屏的函式。 */
    compose(steps) {
      const a = area();
      const base = a.value;
      const at = a.selectionStart;
      a.dispatchEvent(new ui.window.CompositionEvent('compositionstart', { bubbles: true }));
      for (const step of steps) {
        a.value = base.slice(0, at) + step + base.slice(at);
        a.setSelectionRange(at + step.length, at + step.length);
        fire('insertCompositionText', { isComposing: true });
      }
      return (commit) => {
        a.value = base.slice(0, at) + commit + base.slice(at);
        a.setSelectionRange(at + commit.length, at + commit.length);
        a.dispatchEvent(new ui.window.CompositionEvent('compositionend', { bubbles: true, data: commit }));
      };
    },
    /** 輸入法一下上屏。 */
    ime(commit, steps = ['x']) {
      h.compose(steps)(commit);
    },
    key(init, target = area()) {
      const ev = new ui.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(ev);
      return ev;
    },
    trigger: () => h.key({ key: '/', code: 'Slash', altKey: true }),
    undo: () => h.key({ key: 'z', ctrlKey: true }),
    /** 最近一次名詞表請求。 */
    request: () => ui.last('requestNameIndex'),
    /** 回最近那一次請求。 */
    serve(index = NAMES, sig = 's1') {
      const req = h.request();
      assert.ok(req, '應該發過 requestNameIndex');
      ui.post({ type: 'nameIndex', requestId: req.requestId, sig, ...(index ? { index } : {}) });
    },
    box: () => ui.doc.querySelector('.nc-box'),
    shown: () => !!h.box() && !h.box().classList.contains('hidden'),
    rows: () => [...ui.doc.querySelectorAll('.nc-box .nc-item')],
    /** 每一行的名字那一格（別名行帶「 → 正名」）。 */
    names: () => h.rows().map((r) => r.querySelector('.nc-name').textContent),
    active: () => h.rows().findIndex((r) => r.classList.contains('active')),
    mousedown(target) {
      target.dispatchEvent(new ui.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    },
  };
  return h;
}

describe('名詞補全：按鍵彈出', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
    h.open(CH, '他看見林');
  });

  test('Alt+/：發 requestNameIndex（第一次不帶 have），表到之前不彈', () => {
    const ev = h.trigger();
    assert.equal(ev.defaultPrevented, true, 'Mac 上 Option+/ 會打出 ÷，攔下');
    const req = h.request();
    assert.ok(req && typeof req.requestId === 'string');
    assert.equal('have' in req, false);
    assert.equal(h.box(), null);
  });

  test('表到了：在游標處彈出，掛在 body 上、給了位置', () => {
    h.serve();
    assert.equal(h.shown(), true);
    assert.equal(h.box().parentElement, h.ui.doc.body);
    assert.match(h.box().style.left, /px$/);
    assert.match(h.box().style.top, /px$/);
  });

  test('游標前「林」：列出以它開頭的名字，第一條選中，打過的字高亮', () => {
    assert.deepEqual(h.names(), ['林昭', '林昭陽']);
    assert.equal(h.active(), 0);
    assert.equal(h.rows()[0].querySelector('mark').textContent, '林');
    assert.equal(h.rows()[0].getAttribute('aria-selected'), 'true');
  });

  test('每條寫型別與一句話', () => {
    const row = h.rows()[0];
    assert.equal(row.querySelector('.nc-badge').textContent, '角色');
    assert.equal(row.querySelector('.nc-brief').textContent, '青雲宗外門弟子。');
    assert.match(h.box().querySelector('.nc-foot').textContent, /Enter \/ Tab 插入/);
  });

  test('Esc 收起，正文不動，這一下不往下傳（查詢條、專注模式不再收一遍）', () => {
    let reached = false;
    const spy = (e) => {
      if (e.key === 'Escape') reached = true;
    };
    h.ui.doc.addEventListener('keydown', spy);
    const ev = h.key({ key: 'Escape' });
    h.ui.doc.removeEventListener('keydown', spy);
    assert.equal(h.box(), null);
    assert.equal(ev.defaultPrevented, true);
    assert.equal(reached, false);
    assert.equal(h.area().value, '他看見林');
  });

  test('↑↓ 繞著選：↓ 到第二條，↑↑ 繞回第二條', () => {
    h.trigger();
    h.key({ key: 'ArrowDown' });
    assert.equal(h.active(), 1);
    h.key({ key: 'ArrowUp' });
    h.key({ key: 'ArrowUp' });
    assert.equal(h.active(), 1);
  });

  test('Enter 插入：換掉打過的「林」、補成「林昭陽」，游標落在後面，框收起', () => {
    const ev = h.key({ key: 'Enter' });
    assert.equal(ev.defaultPrevented, true);
    assert.equal(h.area().value, '他看見林昭陽');
    assert.equal(h.caret(), 6);
    assert.equal(h.box(), null);
  });

  test('一步撤銷：回到「他看見林」', () => {
    h.undo();
    assert.equal(h.area().value, '他看見林');
  });

  test('Tab 也插入', () => {
    h.end();
    h.trigger();
    h.key({ key: 'Tab' });
    assert.equal(h.area().value, '他看見林昭');
  });

  test('別名命中：寫「阿昭 → 林昭」，插入的是阿昭', () => {
    h.open('chapters/002-入鎮.md', '他喊：阿');
    h.trigger();
    assert.deepEqual(h.names(), ['阿昭 → 林昭']);
    h.key({ key: 'Enter' });
    assert.equal(h.area().value, '他喊：阿昭');
  });

  test('什麼都匹配不上：列全部，最近在本檔案出現的排前面', () => {
    h.open('chapters/003-夜訪.md', '沈懷山推門進來。青崖鎮下著雨。他說');
    h.trigger();
    assert.equal(h.rows().length, NAMES.names.length);
    assert.deepEqual(h.names().slice(0, 2), ['青崖鎮', '沈懷山']);
  });

  test('未建條目寫「未建條目」與那一句說明', () => {
    const row = h.rows().find((r) => r.querySelector('.nc-name').textContent === '黑水河');
    assert.equal(row.querySelector('.nc-badge').textContent, '地點');
    assert.equal(row.querySelector('.nc-brief').textContent, '未建條目 · 河上起了霧');
  });

  test('接著打字跟著篩：打「青」剩下青雲宗、青崖鎮，打了標點就收起', () => {
    h.type('青');
    assert.deepEqual(h.names().sort(), ['青崖鎮', '青雲宗'].sort());
    h.type('崖');
    assert.deepEqual(h.names(), ['青崖鎮']);
    h.type('，');
    assert.equal(h.box(), null);
  });

  test('點一行插入；框裡按下滑鼠不收起', () => {
    h.open('chapters/004-北行.md', '林');
    h.trigger();
    h.mousedown(h.rows()[1]);
    assert.equal(h.shown(), true);
    h.ui.clickEl(h.rows()[1]);
    assert.equal(h.area().value, '林昭陽');
  });

  test('點外面收起', () => {
    h.open('chapters/005-雨.md', '林');
    h.trigger();
    h.mousedown(h.ui.doc.body);
    assert.equal(h.box(), null);
  });

  test('切標籤收起', () => {
    h.trigger();
    assert.equal(h.shown(), true);
    h.open('chapters/006-別處.md', '雨');
    assert.equal(h.box(), null);
  });

  test('滾輪收起', () => {
    h.open('chapters/007-風.md', '林');
    h.trigger();
    h.area().dispatchEvent(new h.ui.window.WheelEvent('wheel', { bubbles: true, deltaY: 40 }));
    assert.equal(h.box(), null);
  });

  test('磁碟上變過之後再要：帶著手上那份的 have；沒變只回指紋也照樣彈', () => {
    h.ui.post({ type: 'state', state: {} });
    h.trigger();
    const req = h.request();
    assert.equal(req.have, 's1');
    assert.equal(h.shown(), true, '問的工夫裡先拿手上那份彈');
    h.serve(undefined, 's1');
    assert.deepEqual(h.names(), ['林昭', '林昭陽']);
    h.key({ key: 'Escape' });
  });

  test('表變了：按新的列', () => {
    h.ui.post({ type: 'state', state: {} });
    h.trigger();
    h.serve({ initialized: true, names: [...NAMES.names, { name: '林間', aliases: [], source: 'lore', category: '地點', brief: '' }] }, 's2');
    assert.ok(h.names().includes('林間'));
    h.key({ key: 'Escape' });
  });

  test('別的頁面的 requestId 不認', () => {
    h.ui.post({ type: 'state', state: {} });
    h.trigger();
    h.key({ key: 'Escape' });
    h.ui.post({ type: 'nameIndex', requestId: 'someone-else', sig: 's9', index: { initialized: true, names: [] } });
    h.trigger();
    assert.ok(h.rows().length > 0, '別人的空表沒換掉這邊的');
    h.key({ key: 'Escape' });
  });

  test('配置這類檔案（kind: setting）：不彈、不發請求，說一句', () => {
    h.open('.novelwarden/config.md', '林', 'setting');
    const before = h.ui.sent.filter((m) => m.type === 'requestNameIndex').length;
    h.trigger();
    assert.equal(h.box(), null);
    assert.equal(h.ui.sent.filter((m) => m.type === 'requestNameIndex').length, before);
    assert.match(h.toasts.at(-1), /只在正文/);
  });

  test('敏感詞表（kind: sensitive，寫作體檢讀的 sensitive.txt）也不彈', () => {
    h.open('.novelwarden/sensitive.txt', '林', 'sensitive');
    h.trigger();
    assert.equal(h.box(), null);
  });

  test('沒給 kind（沒開啟工程）也不彈', () => {
    h.open('notes.md', '林', null);
    h.trigger();
    assert.equal(h.box(), null);
  });

  test('輸入法組字中的 Alt+/：放行，不彈', () => {
    h.open('chapters/008-組字.md', '林');
    const ev = h.key({ key: '/', code: 'Slash', altKey: true, isComposing: true });
    assert.equal(ev.defaultPrevented, false);
    assert.equal(h.box(), null);
  });

  test('細綱、角色卡、設定也能補全', () => {
    for (const [path, kind] of [
      ['.novelwarden/summaries/009-x.md', 'plot'],
      ['.novelwarden/characters/林昭.md', 'character'],
      ['.novelwarden/lore/地點/青崖鎮.md', 'lore'],
    ]) {
      h.open(path, '林', kind);
      h.trigger();
      assert.equal(h.shown(), true, kind);
      h.key({ key: 'Escape' });
    }
  });
});

describe('名詞補全：邊打邊彈', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness({ storage: { [PREFS_KEY]: JSON.stringify({ nameAutoPopup: true }) } });
    h.open(CH, '他看見');
    // 開著邊打邊彈、對著一份能補全的檔案：表先要一份。
    h.serve();
  });

  test('開啟能補全的檔案就先要名詞表', () => {
    assert.ok(h.request());
  });

  test('輸入法上屏「沈懷」：彈出，只列沒打完的', () => {
    h.ime('沈懷');
    assert.equal(h.shown(), true);
    assert.deepEqual(h.names(), ['沈懷山']);
    assert.match(h.box().querySelector('.nc-foot').textContent, /回車照常換段/);
  });

  test('回車不被搶：照常換段，框收起，名字沒補', () => {
    h.key({ key: 'Enter' });
    assert.equal(h.box(), null);
    assert.ok(h.area().value.startsWith('他看見沈懷\n'), JSON.stringify(h.area().value));
    assert.ok(!h.area().value.includes('沈懷山'));
  });

  test('Tab 接受：補成「青崖鎮」，一步撤銷回到「青崖」', () => {
    h.open('chapters/002-入鎮.md', '');
    h.ime('青崖');
    assert.deepEqual(h.names(), ['青崖鎮']);
    h.key({ key: 'Tab' });
    assert.equal(h.area().value, '青崖鎮');
    h.undo();
    assert.equal(h.area().value, '青崖');
  });

  test('↑↓ 在框裡選，Tab 插入選中的那一條', () => {
    h.open('chapters/003-夜訪.md', '');
    h.type('Li');
    assert.deepEqual(h.names(), ['Lindy', 'Lin Zhao']);
    h.key({ key: 'ArrowDown' });
    assert.equal(h.active(), 1);
    h.key({ key: 'Tab' });
    assert.equal(h.area().value, 'Lin Zhao');
  });

  test('「林昭」打完整了不彈（哪怕還有「林昭陽」）', () => {
    h.open('chapters/004-北行.md', '');
    h.ime('林昭');
    assert.equal(h.box(), null);
  });

  test('繼續打別的字：收起', () => {
    h.open('chapters/005-雨.md', '');
    h.ime('沈懷');
    assert.equal(h.shown(), true);
    h.ime('了');
    assert.equal(h.box(), null);
  });

  test('打完整了不彈', () => {
    h.open('chapters/006-風.md', '');
    h.ime('沈懷山');
    assert.equal(h.box(), null);
  });

  test('一個字不彈', () => {
    h.open('chapters/007-雲.md', '');
    h.ime('沈');
    assert.equal(h.box(), null);
  });

  test('組字中途不彈（拼音還沒上屏），上屏才彈', () => {
    h.open('chapters/008-組字.md', '');
    const commit = h.compose(['s', 'shen', 'shenhuai']);
    assert.equal(h.box(), null);
    commit('沈懷');
    assert.equal(h.shown(), true);
  });

  test('框開著又開始組字：先藏起來、鍵不接管；上屏之後按新的文字再篩', () => {
    const commit = h.compose(['q']);
    assert.equal(h.shown(), false);
    const ev = h.key({ key: 'Enter', isComposing: true });
    assert.equal(ev.defaultPrevented, false, '組字中的回車是輸入法的');
    commit('了');
    assert.equal(h.box(), null, '上屏了別的字，收起');
  });

  test('鍵盤打字也彈（英文名，不分大小寫）', () => {
    h.open('chapters/009-en.md', '');
    h.type('li');
    assert.deepEqual(h.names(), ['Lindy', 'Lin Zhao']);
    h.key({ key: 'Escape' });
  });

  test('配置這類檔案不彈', () => {
    h.open('.novelwarden/config.md', '', 'setting');
    h.ime('沈懷');
    assert.equal(h.box(), null);
  });

  test('刪字不彈', () => {
    h.open('chapters/010-刪.md', '沈懷山');
    const a = h.area();
    a.value = '沈懷';
    a.setSelectionRange(2, 2);
    a.dispatchEvent(new h.ui.window.InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    assert.equal(h.box(), null);
  });
});

describe('「檢視 → 補全」', { skip: JSDOM_SKIP }, () => {
  let h;
  const viewMenu = () => {
    h.ui.closeMenu();
    h.ui.clickEl(h.ui.doc.querySelector('[data-menu="view"]'));
    return h.ui.doc.querySelector('.wb-menu-drop');
  };
  const item = (label) =>
    [...viewMenu().querySelectorAll('.wb-menu-item')].find((b) => b.querySelector('.wb-menu-label').textContent === label);
  const storedPrefs = () => JSON.parse(h.ui.window.localStorage.getItem(PREFS_KEY));

  before(() => {
    h = harness({ storage: { [PREFS_KEY]: JSON.stringify({ autoPair: false }) } });
    h.open(CH, '他看見林');
  });

  test('「檢視」最後一組：「名詞補全」寫著 Alt+/，「邊打邊彈名詞補全」預設沒打 ✓', () => {
    const trigger = item('名詞補全');
    assert.ok(trigger);
    assert.equal(trigger.querySelector('.wb-menu-kbd').textContent, 'Alt+/');
    assert.equal(trigger.disabled, false);
    assert.equal(item('邊打邊彈名詞補全').getAttribute('aria-checked'), 'false');
    h.ui.closeMenu();
  });

  test('點「名詞補全」：在游標處彈出', () => {
    h.ui.clickEl(item('名詞補全'));
    h.serve();
    assert.equal(h.shown(), true);
    assert.deepEqual(h.names(), ['林昭', '林昭陽']);
    h.key({ key: 'Escape' });
  });

  test('開啟「邊打邊彈」：打 ✓，記進偏好且不沖掉別的', () => {
    h.ui.clickEl(item('邊打邊彈名詞補全'));
    assert.equal(item('邊打邊彈名詞補全').getAttribute('aria-checked'), 'true');
    assert.equal(storedPrefs().nameAutoPopup, true);
    assert.equal(storedPrefs().autoPair, false, '成對符號那一項沒被沖掉');
    h.ui.closeMenu();
  });

  test('開著之後打字就彈', () => {
    h.end();
    h.ime('，沈懷');
    assert.deepEqual(h.names(), ['沈懷山']);
    h.key({ key: 'Escape' });
  });

  test('再點關掉：偏好裡刪掉那一項，打字不再彈', () => {
    h.ui.clickEl(item('邊打邊彈名詞補全'));
    assert.equal('nameAutoPopup' in storedPrefs(), false);
    assert.equal(storedPrefs().autoPair, false);
    h.ui.closeMenu();
    h.ime('，青崖');
    assert.equal(h.box(), null);
  });

  test('配置檔案上「名詞補全」置灰，提示說為什麼', () => {
    h.open('.novelwarden/config.md', '', 'setting');
    const trigger = item('名詞補全');
    assert.equal(trigger.disabled, true);
    assert.match(trigger.title, /只在正文/);
    h.ui.closeMenu();
  });

  test('重新整理之後邊打邊彈的開關照舊', () => {
    const again = harness({ storage: { [PREFS_KEY]: JSON.stringify({ nameAutoPopup: true }) } });
    again.open(CH, '');
    again.serve();
    again.ime('沈懷');
    assert.equal(again.shown(), true);
  });
});

describe('名詞補全：貼著游標、靠底翻上去', { skip: JSDOM_SKIP }, () => {
  // `mirrorLayout` 假排版：量位置那一份映象裡第 n 行（從 0 數）的 offsetTop = 18 + n × 30，行高 30。
  // 編輯區佔滿 300px 高的視口，框假裝 120px 高。
  let h;
  before(() => {
    h = harness({ shims: [...SHIMS, 'mirrorLayout'] });
    const { window } = h.ui;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 300 });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    const base = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get() {
        return this.classList.contains('nc-box') ? 120 : base.get.call(this);
      },
    });
    h.area().getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 300, width: 800, height: 300, x: 0, y: 0 });
  });

  test('游標在上面：框放在那一行下面', () => {
    h.open(CH, '林');
    h.trigger();
    h.serve();
    // 第 0 行：頂 18、底 48，框在 48 + 2。
    assert.equal(h.box().style.top, '50px');
    assert.equal(h.box().classList.contains('nc-above'), false);
    h.key({ key: 'Escape' });
  });

  test('游標靠近底邊：翻到那一行上面', () => {
    h.open('chapters/002-入鎮.md', '一\n二\n三\n四\n五\n六\n七\n林');
    h.trigger();
    // 第 7 行：頂 228、底 258；下面只剩 34px，放不下 120px，翻上去：228 − 120 − 2。
    assert.equal(h.box().style.top, '106px');
    assert.equal(h.box().classList.contains('nc-above'), true);
    h.key({ key: 'Escape' });
  });
});

describe('名詞補全：碼字統計', { skip: JSDOM_SKIP }, () => {
  let h;
  const session = () => /本次 ([+-]?[\d,]+) 字/.exec(h.ui.doc.getElementById('edStatusWords').textContent)?.[1];
  before(() => {
    h = harness({ storage: { [PREFS_KEY]: JSON.stringify({ stats: { goal: true, session: true, today: false } }) } });
    h.open(CH, '');
  });

  test('輸入法打「沈」算 1 個字', () => {
    h.ime('沈');
    assert.equal(session(), '+1');
  });

  test('補成「沈懷山」：補上的兩個字也算（⚑），本次 +3', () => {
    h.trigger();
    h.serve();
    assert.deepEqual(h.names(), ['沈懷山']);
    h.key({ key: 'Enter' });
    assert.equal(h.area().value, '沈懷山');
    assert.equal(session(), '+3');
  });

  test('撤銷補全那一步：減回去，本次 +1', () => {
    h.undo();
    assert.equal(h.area().value, '沈');
    assert.equal(session(), '+1');
  });
});
