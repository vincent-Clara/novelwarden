/**
 * 外觀（`media/src/editor/look.ts` / `lookPanel.ts`，選單那一半在 `view/lookMenu.ts`）：字號快捷鍵、外觀面板、
 * 排版變數、護眼主題。取值的校驗與上下限在 tests/unit/editor/lookCore.test.js。
 *
 * jsdom 沒有排版，也不解析 `var()`：「映象層與 textarea 讀同一組變數」那一組把構建出來的 standalone.css 塞進頁面，
 * 看兩邊算出來的是不是同一個 `var(--nf-ed-…)`，並按 CSSOM 核對那幾條規則寫在一起。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 「檢視」選單 | 第二組是「外觀」：放大 / 縮小 / 還原字號（寫著快捷鍵）與「外觀設定…」；點了就變；到頭置灰 |
 * | 字號快捷鍵 | Ctrl+= / Ctrl++ / Ctrl+- / Ctrl+0 **只在焦點在編輯區裡時攔**；對話輸入框、頁面上、組字中途一律放行給瀏覽器 |
 * | 外觀面板 | 頁面模板裡沒有；開啟時焦點進面板、不是遮罩（`.modal-overlay`）；字型 / 字號 / 行距 / 版心改了當場換變數；字號越界夾回去；恢復預設；Esc 關、焦點回編輯區；只開一個 |
 * | 同一組變數 | textarea 與映象層算出來是同一組 `var(--nf-ed-…)`；CSS 裡同一條規則；版心的居中算式三處同一條；預覽也讀它；不往元素上單寫字號 |
 * | 護眼主題 | 標題欄按鈕深 → 淺 → 護眼 → 深；面板裡挑「護眼」；記在 `novelforge.theme`；theme.css 裡那一套變數與淺色一樣全；`theme-color` 跟著換成標題欄底色 |
 * | 記在本地 | 記進 `novelforge.editor.prefs`、同一處的成對符號開關不丟；重新整理時壞值回落預設、越界夾回去 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mount, JSDOM_SKIP, MEDIA, file, standaloneBodyHtml } = require('../../helpers/dom');

const SHIMS = ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'];
const SONG = "'Noto Serif CJK SC', 'Source Han Serif SC', 'Songti SC', 'STSong', 'SimSun', Georgia, serif";

/** 一個裝好編輯器、開著一章正文的頁面，外加幾樣小工具。 */
function harness(opts = {}) {
  const ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: SHIMS, ...opts });
  ui.post({ type: 'editorOpen', file: file('chapters/001-雨夜.md', '雨夜。\n\n林昭推門。', { kind: 'chapter' }) });
  const area = () => ui.doc.getElementById('edArea');
  /** `<html>` 上那組變數的當前值。 */
  const v = (name) => ui.doc.documentElement.style.getPropertyValue(name).trim();
  const key = (target, init) => {
    const ev = new ui.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(ev);
    return ev;
  };
  const viewMenu = () => {
    ui.clickEl(ui.doc.querySelector('[data-menu="view"]'));
    return ui.doc.querySelector('.wb-menu-drop');
  };
  const closeBar = () => ui.doc.body.dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
  const item = (label) => [...viewMenu().querySelectorAll('.wb-menu-item')].find((b) => b.querySelector('.wb-menu-label')?.textContent === label);
  const pickMenu = (label) => {
    const btn = item(label);
    assert.ok(btn, `「檢視」裡沒有「${label}」`);
    ui.clickEl(btn);
  };
  const panel = () => ui.doc.querySelector('.ed-look');
  const part = (cls) => panel()?.querySelector(`.${cls}`);
  const change = (input, value, type = 'change') => {
    input.value = String(value);
    input.dispatchEvent(new ui.window.Event(type, { bubbles: true }));
  };
  return { ui, area, v, key, viewMenu, closeBar, item, pickMenu, panel, part, change };
}

/** 「檢視」選單拆成組（分隔線隔開），每一項「名字|快捷鍵」。 */
function menuGroups(drop) {
  const groups = [[]];
  for (const node of drop.children) {
    if (node.classList.contains('wb-menu-sep')) {
      groups.push([]);
    } else {
      const label = node.querySelector('.wb-menu-label').textContent;
      const kbd = node.querySelector('.wb-menu-kbd')?.textContent;
      groups[groups.length - 1].push(kbd ? `${label}|${kbd}` : label);
    }
  }
  return groups;
}

describe('外觀：「檢視」選單那一組', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
  });

  test('第一組仍是「單擊開啟為臨時標籤」，第二組是「外觀」', () => {
    const groups = menuGroups(h.viewMenu());
    h.closeBar();
    assert.deepEqual(groups.slice(0, 2), [
      ['單擊開啟為臨時標籤'],
      ['放大字號|Ctrl+=', '縮小字號|Ctrl+-', '還原字號|Ctrl+0', '外觀設定…'],
    ]);
  });

  test('點「放大字號」：字號變數變成 16px', () => {
    h.pickMenu('放大字號');
    assert.equal(h.v('--nf-ed-font-size'), '16px');
  });

  test('提示裡寫著當前字號與預設字號', () => {
    const tip = h.item('還原字號').title;
    h.closeBar();
    assert.match(tip, /當前 16px，預設 15px/);
  });

  test('點「還原字號」：回到 15px', () => {
    h.pickMenu('還原字號');
    assert.equal(h.v('--nf-ed-font-size'), '15px');
  });

  test('點「縮小字號」：14px', () => {
    h.pickMenu('縮小字號');
    assert.equal(h.v('--nf-ed-font-size'), '14px');
  });

  test('縮到最小（12px）：「縮小字號」置灰、「放大字號」照常', () => {
    h.pickMenu('縮小字號');
    h.pickMenu('縮小字號');
    const drop = h.viewMenu();
    const find = (label) => [...drop.querySelectorAll('.wb-menu-item')].find((b) => b.querySelector('.wb-menu-label').textContent === label);
    const [dec, inc] = [find('縮小字號'), find('放大字號')];
    h.closeBar();
    assert.deepEqual([h.v('--nf-ed-font-size'), dec.disabled, inc.disabled], ['12px', true, false]);
  });
});

describe('外觀：字號快捷鍵只在焦點在編輯區時攔', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
  });

  test('編輯區裡 Ctrl+=：攔下，字號 16px', () => {
    h.area().focus();
    const ev = h.key(h.area(), { key: '=', code: 'Equal', ctrlKey: true });
    assert.deepEqual([ev.defaultPrevented, h.v('--nf-ed-font-size')], [true, '16px']);
  });

  test('Ctrl++（Shift+=）也放大', () => {
    const ev = h.key(h.area(), { key: '+', code: 'Equal', ctrlKey: true, shiftKey: true });
    assert.deepEqual([ev.defaultPrevented, h.v('--nf-ed-font-size')], [true, '17px']);
  });

  test('Ctrl+-：縮小', () => {
    h.key(h.area(), { key: '-', code: 'Minus', ctrlKey: true });
    assert.equal(h.v('--nf-ed-font-size'), '16px');
  });

  test('Ctrl+0：還原', () => {
    const ev = h.key(h.area(), { key: '0', code: 'Digit0', ctrlKey: true });
    assert.deepEqual([ev.defaultPrevented, h.v('--nf-ed-font-size')], [true, '15px']);
  });

  test('Mac 的 Cmd 也認', () => {
    h.key(h.area(), { key: '=', code: 'Equal', metaKey: true });
    assert.equal(h.v('--nf-ed-font-size'), '16px');
    h.key(h.area(), { key: '0', code: 'Digit0', metaKey: true });
  });

  test('焦點在對話輸入框裡：不攔（瀏覽器照常縮放整頁），字號不變', () => {
    const input = h.ui.doc.getElementById('input');
    input.focus();
    const ev = h.key(input, { key: '=', code: 'Equal', ctrlKey: true });
    assert.deepEqual([ev.defaultPrevented, h.v('--nf-ed-font-size')], [false, '15px']);
  });

  test('焦點在頁面上（沒在任何輸入框裡）：不攔', () => {
    h.ui.doc.activeElement?.blur();
    const ev = h.key(h.ui.doc.body, { key: '-', code: 'Minus', ctrlKey: true });
    assert.deepEqual([ev.defaultPrevented, h.v('--nf-ed-font-size')], [false, '15px']);
  });

  test('輸入法組字中途：放行', () => {
    h.area().focus();
    const ev = h.key(h.area(), { key: '=', code: 'Equal', ctrlKey: true, isComposing: true });
    assert.deepEqual([ev.defaultPrevented, h.v('--nf-ed-font-size')], [false, '15px']);
  });

  test('不帶 Ctrl 的 = 照常是打字', () => {
    const ev = h.key(h.area(), { key: '=', code: 'Equal' });
    assert.equal(ev.defaultPrevented, false);
  });

  test('按字認、不按位置認：德語佈局上 Ctrl+ß（主鍵盤 - 那個位置）不算縮小', () => {
    const ev = h.key(h.area(), { key: 'ß', code: 'Minus', ctrlKey: true });
    assert.deepEqual([ev.defaultPrevented, h.v('--nf-ed-font-size')], [false, '15px']);
  });

  test('小鍵盤的 + 也認', () => {
    h.key(h.area(), { key: '+', code: 'NumpadAdd', ctrlKey: true });
    assert.equal(h.v('--nf-ed-font-size'), '16px');
    h.key(h.area(), { key: '0', code: 'Numpad0', ctrlKey: true });
  });
});

describe('外觀：外觀面板', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
  });

  test('頁面模板裡沒有它（DOM 現造現拆）', () => {
    assert.equal(standaloneBodyHtml().includes('ed-look'), false);
    assert.equal(h.panel(), null);
  });

  test('「檢視 → 外觀設定…」開啟面板，焦點落在字型下拉框', () => {
    h.area().focus();
    h.pickMenu('外觀設定…');
    assert.equal(h.panel().getAttribute('role'), 'dialog');
    assert.equal(h.ui.doc.activeElement, h.part('ed-look-font'));
  });

  test('不是遮罩：外面那一層不是 .modal-overlay（不擋 Ctrl+P、不攔點選）', () => {
    assert.equal(h.ui.doc.querySelector('.modal-overlay:not(.hidden)'), null);
    assert.ok(h.panel().closest('.ed-look-overlay'));
  });

  test('面板上的值是當前的：宋體、15、1.95、鋪滿', () => {
    assert.deepEqual(
      [h.part('ed-look-font').value, h.part('ed-look-size').value, h.part('ed-look-line').value, h.part('ed-look-measure').value],
      ['song', '15', '1.95', '0']
    );
  });

  test('改字型：當場換字型變數', () => {
    h.change(h.part('ed-look-font'), 'kai');
    assert.match(h.v('--nf-ed-font-family'), /^'LXGW WenKai'/);
  });

  test('字號輸入框：當場換，越界夾進上下限、輸入框寫回夾過的值', () => {
    h.change(h.part('ed-look-size'), 99);
    assert.deepEqual([h.v('--nf-ed-font-size'), h.part('ed-look-size').value], ['32px', '32']);
  });

  test('字號輸入框清空了不算數：寫回當前字號', () => {
    h.change(h.part('ed-look-size'), '');
    assert.deepEqual([h.v('--nf-ed-font-size'), h.part('ed-look-size').value], ['32px', '32']);
  });

  test('到最大時「+」置灰', () => {
    assert.equal(h.part('ed-look-size-inc').disabled, true);
  });

  test('「−」縮一檔', () => {
    h.ui.clickEl(h.part('ed-look-size-dec'));
    assert.deepEqual([h.v('--nf-ed-font-size'), h.part('ed-look-size').value], ['31px', '31']);
  });

  test('行距滑塊：拖的時候就換，旁邊寫著當前值', () => {
    h.change(h.part('ed-look-line'), 2.2, 'input');
    assert.deepEqual([h.v('--nf-ed-line-height'), h.part('ed-look-line-value').textContent], ['2.2', '2.20']);
  });

  test('版心：挑「一行最多 40 字」，變數按 em 寫', () => {
    const select = h.part('ed-look-measure');
    const opt = [...select.options].find((o) => o.textContent === '一行最多 40 字');
    h.change(select, opt.value);
    assert.equal(h.v('--nf-ed-measure'), '40em');
  });

  test('不往 textarea 上單寫字號、字型、行距（只認那組變數）', () => {
    const s = h.area().style;
    assert.deepEqual([s.fontSize, s.fontFamily, s.lineHeight], ['', '', '']);
  });

  test('段間距不單列一項：面板上說清跟著分段格式走', () => {
    assert.match(h.panel().textContent, /段間距跟著分段格式走/);
  });

  test('恢復預設：四項回到預設，面板上的值跟著變', () => {
    h.ui.clickEl(h.part('ed-look-reset'));
    assert.deepEqual(
      [h.v('--nf-ed-font-family'), h.v('--nf-ed-font-size'), h.v('--nf-ed-line-height'), h.v('--nf-ed-measure')],
      [SONG, '15px', '1.95', '100cqi']
    );
    assert.deepEqual([h.part('ed-look-font').value, h.part('ed-look-size').value, h.part('ed-look-measure').value], ['song', '15', '0']);
  });

  test('開著時用快捷鍵改字號，面板上的值跟著變', () => {
    h.area().focus();
    h.key(h.area(), { key: '=', code: 'Equal', ctrlKey: true });
    assert.equal(h.part('ed-look-size').value, '16');
    h.key(h.area(), { key: '0', code: 'Digit0', ctrlKey: true });
  });

  test('再開啟一次：還是那一個，焦點放回面板', () => {
    h.area().focus();
    h.pickMenu('外觀設定…');
    assert.deepEqual([h.ui.doc.querySelectorAll('.ed-look').length, h.ui.doc.activeElement], [1, h.part('ed-look-font')]);
  });

  test('Esc 關掉，焦點回到開啟之前的地方（編輯區）', () => {
    const ev = h.key(h.part('ed-look-font'), { key: 'Escape' });
    assert.deepEqual([ev.defaultPrevented, h.panel(), h.ui.doc.activeElement], [true, null, h.area()]);
  });

  test('「關閉」按鈕也關', () => {
    h.pickMenu('外觀設定…');
    h.ui.clickEl(h.part('ed-look-close'));
    assert.equal(h.panel(), null);
  });
});

describe('外觀：映象層與 textarea 讀同一組變數', { skip: JSDOM_SKIP }, () => {
  let h;
  let sheet;
  const css = fs.readFileSync(path.join(MEDIA, 'standalone.css'), 'utf8');
  /** 選擇器列表裡同時有這幾個的那幾條規則（頂層的，不含 @supports / @media 裡的）。 */
  const rulesWith = (rules, ...sels) =>
    [...rules].filter((r) => r.selectorText && sels.every((s) => r.selectorText.split(',').map((x) => x.trim()).includes(s)));

  before(() => {
    h = harness();
    const style = h.ui.doc.createElement('style');
    style.textContent = css;
    h.ui.doc.head.appendChild(style);
    sheet = style.sheet;
    // 開啟查詢、找一個字：映象層（.ed-mirror-content）造出來，樣式從 textarea 抄過去。
    h.area().focus();
    h.key(h.area(), { key: 'f', ctrlKey: true });
    const input = h.ui.doc.querySelector('.ed-find-input');
    input.value = '林';
    input.dispatchEvent(new h.ui.window.Event('input', { bubbles: true }));
  });

  test('textarea 的字型、字號、行距算出來是那組變數', () => {
    const cs = h.ui.window.getComputedStyle(h.area());
    assert.deepEqual(
      [cs.fontFamily, cs.fontSize, cs.lineHeight],
      ['var(--nf-ed-font-family)', 'var(--nf-ed-font-size)', 'var(--nf-ed-line-height)']
    );
  });

  test('映象層抄過去的是同一組變數', () => {
    const content = h.ui.doc.querySelector('.ed-mirror:not(.ed-mirror-probe) .ed-mirror-content');
    assert.deepEqual(
      [content.style.fontFamily, content.style.fontSize, content.style.lineHeight],
      ['var(--nf-ed-font-family)', 'var(--nf-ed-font-size)', 'var(--nf-ed-line-height)']
    );
  });

  test('CSS 裡 textarea 與映象層是同一條規則：字型、字號、行距、內邊距都讀變數', () => {
    const [rule] = rulesWith(sheet.cssRules, '.ed-area', '.ed-mirror-content');
    assert.ok(rule, '找不到 .ed-area 與 .ed-mirror-content 寫在一起的那條規則');
    assert.deepEqual(
      ['font-family', 'font-size', 'line-height', 'padding'].map((p) => rule.style.getPropertyValue(p)),
      [
        'var(--nf-ed-font-family)',
        'var(--nf-ed-font-size)',
        'var(--nf-ed-line-height)',
        'var(--nf-ed-pad-y) var(--nf-ed-pad-x) var(--nf-ed-pad-bottom)',
      ]
    );
  });

  test('版心的居中算式：@supports 裡 textarea、映象層、預覽三處同一條', () => {
    const supports = [...sheet.cssRules].find((r) => r.conditionText === '(width: 1cqi)');
    const [rule] = rulesWith(supports.cssRules, '.ed-area', '.ed-mirror-content', '.ed-preview');
    assert.match(rule.style.getPropertyValue('padding-left'), /100cqi - var\(--nf-ed-measure\)/);
    assert.equal(rule.style.getPropertyValue('padding-left'), rule.style.getPropertyValue('padding-right'));
  });

  test('居中按容器寬算：.ed-stage 是容器', () => {
    const supports = [...sheet.cssRules].find((r) => r.conditionText === '(width: 1cqi)');
    const [stage] = rulesWith(supports.cssRules, '.ed-stage');
    assert.equal(stage.style.getPropertyValue('container-type'), 'inline-size');
  });

  test('預覽讀同一組變數', () => {
    const cs = h.ui.window.getComputedStyle(h.ui.doc.getElementById('edPreview'));
    assert.deepEqual([cs.fontFamily, cs.fontSize, cs.lineHeight], ['var(--nf-ed-font-family)', 'var(--nf-ed-font-size)', 'var(--nf-ed-line-height)']);
  });

  test('別處不再寫死正文字號（15px）與行距（1.95）', () => {
    const literal = [...sheet.cssRules].filter(
      (r) =>
        r.selectorText &&
        /\.ed-(area|preview|mirror-content)\b/.test(r.selectorText) &&
        (r.style.getPropertyValue('font-size') === '15px' || r.style.getPropertyValue('line-height') === '1.95')
    );
    assert.deepEqual(literal.map((r) => r.selectorText), []);
  });

  test('窄屏收窄內邊距改的是變數，不是元素上的 padding', () => {
    const narrow = [...sheet.cssRules].find((r) => r.conditionText === '(max-width: 900px)');
    const padded = rulesWith(narrow.cssRules, '.ed-area').filter((r) => r.style.getPropertyValue('padding'));
    const root = rulesWith(narrow.cssRules, ':root')[0];
    assert.deepEqual([padded.length, root?.style.getPropertyValue('--nf-ed-pad-x').trim()], [0, '16px']);
  });

  test('改了字號：映象層當場重抄一遍樣式（不等尺寸變化）', () => {
    const content = h.ui.doc.querySelector('.ed-mirror:not(.ed-mirror-probe) .ed-mirror-content');
    content.style.removeProperty('font-size');
    h.key(h.area(), { key: '=', code: 'Equal', ctrlKey: true });
    assert.equal(content.style.fontSize, 'var(--nf-ed-font-size)');
  });
});

describe('外觀：護眼主題', { skip: JSDOM_SKIP }, () => {
  let h;
  const theme = () => h.ui.doc.documentElement.dataset.theme;
  before(() => {
    h = harness({ url: 'http://localhost/?project=a' });
    // 編輯器啟動時按記下的（或系統的）主題定；從深色起測。
    h.ui.window.localStorage.removeItem('novelforge.theme');
  });

  test('標題欄按鈕：深色 → 淺色 → 護眼 → 深色輪著換', () => {
    const btn = h.ui.doc.getElementById('wbThemeBtn');
    const seen = [theme()];
    for (let i = 0; i < 3; i++) {
      h.ui.clickEl(btn);
      seen.push(theme());
    }
    assert.deepEqual(seen, ['dark', 'light', 'sepia', 'dark']);
  });

  test('按鈕上寫的是下一套：深色時提示切到淺色', () => {
    assert.match(h.ui.doc.getElementById('wbThemeBtn').title, /切換到淺色/);
  });

  test('外觀面板裡挑「護眼」：當場換，記在 novelforge.theme', () => {
    h.pickMenu('外觀設定…');
    const sepia = h.panel().querySelector('.ed-look-theme input[value="sepia"]');
    sepia.checked = true;
    sepia.dispatchEvent(new h.ui.window.Event('change', { bubbles: true }));
    assert.deepEqual([theme(), h.ui.window.localStorage.getItem('novelforge.theme')], ['sepia', 'sepia']);
  });

  test('「恢復預設」不動主題', () => {
    h.ui.clickEl(h.part('ed-look-reset'));
    assert.equal(theme(), 'sepia');
  });

  test('面板上那一組單選跟著當前主題', () => {
    const checked = h.panel().querySelector('.ed-look-theme input:checked');
    assert.equal(checked.value, 'sepia');
  });

  test('theme.css 裡護眼那一套的變數與淺色一樣全', () => {
    const css = fs.readFileSync(path.join(MEDIA, 'standalone.css'), 'utf8');
    const style = h.ui.doc.createElement('style');
    style.textContent = css;
    h.ui.doc.head.appendChild(style);
    const names = (theme) => {
      const rule = [...style.sheet.cssRules].find((r) => /^:root\[data-theme=['"]?(\w+)['"]?\]$/.exec(r.selectorText)?.[1] === theme);
      assert.ok(rule, `找不到 ${theme} 那一套`);
      return [...rule.style].filter((n) => n.startsWith('--')).sort();
    };
    assert.deepEqual(names('sepia'), names('light'));
  });

  test('換主題時 <meta name="theme-color"> 跟著換成標題欄底色（手機瀏覽器的位址列、Android 殼的系統欄按它染）', () => {
    const doc = h.ui.doc;
    const style = doc.createElement('style');
    style.textContent = fs.readFileSync(path.join(MEDIA, 'standalone.css'), 'utf8');
    doc.head.appendChild(style);
    const meta = doc.createElement('meta');
    meta.name = 'theme-color';
    doc.head.appendChild(meta);
    const bar = () => h.ui.window.getComputedStyle(doc.documentElement).getPropertyValue('--nf-titlebar-background').trim();
    const seen = {};
    for (let i = 0; i < 3; i++) {
      h.ui.clickEl(doc.getElementById('wbThemeBtn'));
      assert.equal(meta.content, bar(), `${theme()}：theme-color 與標題欄底色不一致`);
      seen[theme()] = meta.content;
    }
    assert.deepEqual(Object.keys(seen).sort(), ['dark', 'light', 'sepia']);
    assert.equal(new Set(Object.values(seen)).size, 3, `三套該是三個顏色：${JSON.stringify(seen)}`);
  });
});

describe('外觀：記在本地', { skip: JSDOM_SKIP }, () => {
  test('改了記進 novelforge.editor.prefs，同一處的成對符號開關不丟', () => {
    const h = harness({ storage: { 'novelforge.editor.prefs': JSON.stringify({ autoPair: false }) } });
    h.pickMenu('放大字號');
    const saved = JSON.parse(h.ui.window.localStorage.getItem('novelforge.editor.prefs'));
    assert.deepEqual([saved.autoPair, saved.fontSize], [false, 16]);
  });

  test('別的開關存一下也不沖掉外觀那幾項', () => {
    const h = harness({ storage: { 'novelforge.editor.prefs': JSON.stringify({ fontSize: 20 }) } });
    h.ui.clickEl(h.ui.doc.querySelector('[data-menu="edit"]'));
    const toggle = [...h.ui.doc.querySelectorAll('.wb-menu-item')].find((b) => b.textContent.includes('成對符號'));
    h.ui.clickEl(toggle);
    const saved = JSON.parse(h.ui.window.localStorage.getItem('novelforge.editor.prefs'));
    assert.deepEqual([saved.autoPair, saved.fontSize], [false, 20]);
  });

  test('外觀與碼字統計的 stats 子物件互不沖掉：改字號留著 stats，改統計開關留著字號', () => {
    const h = harness({
      storage: { 'novelforge.editor.prefs': JSON.stringify({ stats: { goal: true, session: true, today: false } }) },
    });
    h.pickMenu('放大字號');
    const afterZoom = JSON.parse(h.ui.window.localStorage.getItem('novelforge.editor.prefs'));
    // 「檢視 → 統計 ›」子選單裡開啟「今日碼字」。
    const stats = [...h.viewMenu().querySelectorAll('.wb-menu-item')].find((b) => b.querySelector('.wb-menu-label').textContent === '統計');
    stats.dispatchEvent(new h.ui.window.MouseEvent('mouseenter'));
    const today = [...h.ui.doc.querySelectorAll('.wb-menu-drop.submenu .wb-menu-item')].find((b) => b.textContent.includes('今日碼字'));
    h.ui.clickEl(today);
    const afterStats = JSON.parse(h.ui.window.localStorage.getItem('novelforge.editor.prefs'));
    assert.deepEqual(
      [afterZoom.fontSize, afterZoom.stats, afterStats.fontSize, afterStats.stats],
      [16, { goal: true, session: true, today: false }, 16, { goal: true, session: true, today: true }]
    );
  });

  test('寫壞了（不是 JSON）：全當預設，下一次寫把它整份換掉', () => {
    const h = harness({ storage: { 'novelforge.editor.prefs': '{壞了' } });
    const before = h.v('--nf-ed-font-size');
    h.pickMenu('放大字號');
    const saved = JSON.parse(h.ui.window.localStorage.getItem('novelforge.editor.prefs'));
    assert.deepEqual([before, saved.fontSize, saved.autoPair], ['15px', 16, true]);
  });

  test('重新整理時壞值回落預設、越界的夾回去，好的照用', () => {
    const h = harness({
      storage: {
        'novelforge.editor.prefs': JSON.stringify({ fontFamily: 'comic', fontSize: '大', lineHeight: 2.2, measure: 999 }),
      },
    });
    assert.deepEqual(
      [h.v('--nf-ed-font-family'), h.v('--nf-ed-font-size'), h.v('--nf-ed-line-height'), h.v('--nf-ed-measure')],
      [SONG, '15px', '2.2', '80em']
    );
  });

  test('恢復預設從偏好裡刪掉那幾項（以後預設改了也跟著走）', () => {
    const h = harness({ storage: { 'novelforge.editor.prefs': JSON.stringify({ fontSize: 20, autoSave: true }) } });
    h.pickMenu('外觀設定…');
    h.ui.clickEl(h.part('ed-look-reset'));
    const saved = JSON.parse(h.ui.window.localStorage.getItem('novelforge.editor.prefs'));
    assert.deepEqual([('fontSize' in saved), saved.autoSave], [false, true]);
  });
});
