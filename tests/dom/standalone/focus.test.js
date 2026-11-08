/**
 * 專注（`media/src/editor/focus.ts` / `typewriter.ts` / `paragraphFocus.ts`，選單那一半在 `view/lookMenu.ts`）：
 * 專注模式、全屏、打字機滾動、段落聚焦。認段落、算滾動目標的純函式在 tests/unit/editor/focusCore.test.js。
 *
 * jsdom 沒有排版：打字機滾動用 `mirrorLayout` 那份假排版（量位置那一份映象裡第 k 行的頂 = 18 + 30k，視口 300），
 * 只驗「調了沒有、滾到的目標對不對」；段落聚焦驗映象層上那一層 `<mark>` 包的是不是游標那一段。
 * jsdom 也沒有 Fullscreen API——正好驗「不支援就置灰」，支援的那一面在頁面上補一個假的。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 「檢視」選單 | 第三組「專注」：專注模式（F8）/ 全屏 / 打字機滾動 / 段落聚焦，開著的打 ✓ |
 * | 全屏 | 不支援時置灰、提示說不支援；支援時點了請求全屏、全屏中打 ✓、再點退出 |
 * | 專注模式 | 進出（選單、F8、Esc）；Esc 先收查詢條；組字中的 F8 不算；兩塊編輯區只專注當前那一塊、當前那一塊換了跟過去；記在偏好裡、重新整理還在 |
 * | 打字機滾動 | 打字、回車、方向鍵之後把游標那一行滾到視口中間；組字中途不滾、上屏才滾；滾輪翻看與點選不拉回、下一次打字才回來；關著不滾；底下墊半屏 |
 * | 段落聚焦 | 開了 textarea 調淡、映象層 focus 圖層包著游標那一段；換段跟著換；打字之後包進新字；按三種分段格式認；非正文不做；與查詢高亮疊得上；關掉撤乾淨 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, MIRROR_LAYOUT, file, viewState } = require('../../helpers/dom');

const SHIMS = ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'];
/** 等兩幀（jsdom 沒有 rAF，退回 16ms 定時器）。 */
const frames = () => new Promise((resolve) => setTimeout(resolve, 60));

function harness(opts = {}) {
  const { shims = SHIMS, ...rest } = opts;
  const ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims, ...rest });
  const main = () => ui.doc.getElementById('wbEditor');
  const draft = () => ui.doc.querySelector('.wb-editor-draft');
  const area = (root = main()) => root.querySelector('textarea.ed-area');
  const open = (p, text, extra, msg) => ui.post({ type: 'editorOpen', file: file(p, text, { kind: 'chapter', ...extra }), ...msg });
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
  /** 「檢視」裡那一項（開著選單拿完就收）。 */
  const entry = (label) => {
    const btn = [...viewMenu().querySelectorAll('.wb-menu-item')].find((b) => b.querySelector('.wb-menu-label').textContent === label);
    closeBar();
    return btn;
  };
  const pickMenu = (label) => {
    const btn = [...viewMenu().querySelectorAll('.wb-menu-item')].find((b) => b.querySelector('.wb-menu-label').textContent === label);
    assert.ok(btn, `「檢視」裡沒有「${label}」`);
    ui.clickEl(btn);
  };
  const focusOn = () => ui.doc.body.classList.contains('nf-focus');
  /** 在游標處打一個字（與真的打字一樣：先改 value、落游標，再發 input）。 */
  const type = (a, text, init = {}) => {
    const at = a.selectionStart;
    a.value = a.value.slice(0, at) + text + a.value.slice(a.selectionEnd);
    a.setSelectionRange(at + text.length, at + text.length);
    a.dispatchEvent(new ui.window.InputEvent('input', { bubbles: true, inputType: 'insertText', ...init }));
  };
  return { ui, main, draft, area, open, key, viewMenu, closeBar, entry, pickMenu, focusOn, type };
}

describe('專注：「檢視」選單那一組', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
    h.open('chapters/001.md', '雨夜。');
  });

  test('第三組「專注」：專注模式（F8）、全屏、打字機滾動、段落聚焦，預設都沒打 ✓', () => {
    const drop = h.viewMenu();
    const groups = [[]];
    for (const node of drop.children) {
      if (node.classList.contains('wb-menu-sep')) {
        groups.push([]);
      } else {
        const kbd = node.querySelector('.wb-menu-kbd')?.textContent;
        groups[groups.length - 1].push(`${node.querySelector('.wb-menu-label').textContent}${kbd ? `|${kbd}` : ''}|${node.getAttribute('aria-checked')}`);
      }
    }
    h.closeBar();
    assert.deepEqual(groups[2], ['專注模式|F8|false', '全屏|false', '打字機滾動|false', '段落聚焦|false']);
  });

  test('jsdom 沒有 Fullscreen API：「全屏」置灰，提示說不支援', () => {
    const btn = h.entry('全屏');
    assert.deepEqual([btn.disabled, btn.title], [true, '這個瀏覽器（或視窗）不支援全屏。']);
  });

  test('點「打字機滾動」：打 ✓', () => {
    h.pickMenu('打字機滾動');
    assert.equal(h.entry('打字機滾動').getAttribute('aria-checked'), 'true');
  });

  test('點「段落聚焦」：打 ✓', () => {
    h.pickMenu('段落聚焦');
    assert.equal(h.entry('段落聚焦').getAttribute('aria-checked'), 'true');
  });
});

describe('專注：全屏（能力探測）', { skip: JSDOM_SKIP }, () => {
  let h;
  const calls = [];
  before(() => {
    h = harness();
    h.open('chapters/001.md', '雨夜。');
    // 補一個假的 Fullscreen API：瀏覽器支援全屏的那一面。
    const { doc } = h.ui;
    let element = null;
    Object.defineProperty(doc, 'fullscreenEnabled', { configurable: true, get: () => true });
    Object.defineProperty(doc, 'fullscreenElement', { configurable: true, get: () => element });
    doc.documentElement.requestFullscreen = () => {
      calls.push('request');
      element = doc.documentElement;
      return Promise.resolve();
    };
    doc.exitFullscreen = () => {
      calls.push('exit');
      element = null;
      return Promise.resolve();
    };
  });

  test('支援時「全屏」不置灰', () => {
    assert.equal(h.entry('全屏').disabled, false);
  });

  test('點了請求整個頁面全屏', () => {
    h.pickMenu('全屏');
    assert.deepEqual(calls, ['request']);
  });

  test('全屏中打 ✓', () => {
    assert.equal(h.entry('全屏').getAttribute('aria-checked'), 'true');
  });

  test('再點一次退出全屏', () => {
    h.pickMenu('全屏');
    assert.deepEqual([calls, h.entry('全屏').getAttribute('aria-checked')], [['request', 'exit'], 'false']);
  });

  test('全屏不記進偏好（重新整理回到視窗）', () => {
    // 記憶體裡那份偏好：專注那三項都還是關的，沒有 fullscreen 這一項。
    assert.equal(h.focusOn(), false);
  });
});

describe('專注：專注模式進出', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
    h.open('chapters/001.md', '雨夜。\n\n林昭推門。');
  });

  test('「檢視 → 專注模式」：body 掛 nf-focus，當前那一塊掛 ed-focused', () => {
    h.pickMenu('專注模式');
    assert.deepEqual([h.focusOn(), h.main().classList.contains('ed-focused')], [true, true]);
  });

  test('選單上打 ✓', () => {
    assert.equal(h.entry('專注模式').getAttribute('aria-checked'), 'true');
  });

  test('編輯區裡按 Esc：退出', () => {
    h.area().focus();
    const ev = h.key(h.area(), { key: 'Escape' });
    assert.deepEqual([ev.defaultPrevented, h.focusOn(), h.main().classList.contains('ed-focused')], [true, false, false]);
  });

  test('F8 進、再按 F8 出', () => {
    const ev = h.key(h.area(), { key: 'F8' });
    const entered = h.focusOn();
    h.key(h.area(), { key: 'F8' });
    assert.deepEqual([ev.defaultPrevented, entered, h.focusOn()], [true, true, false]);
  });

  test('焦點在對話輸入框裡也認 F8（那裡它沒有別的用處）', () => {
    const input = h.ui.doc.getElementById('input');
    input.focus();
    h.key(input, { key: 'F8' });
    const on = h.focusOn();
    h.key(input, { key: 'F8' });
    assert.equal(on, true);
  });

  test('從被藏起來的地方（對話輸入框）進專注模式：焦點放進正文，不落在看不見的框裡', () => {
    const input = h.ui.doc.getElementById('input');
    input.focus();
    h.key(input, { key: 'F8' });
    const focused = h.ui.doc.activeElement;
    h.key(h.area(), { key: 'F8' });
    assert.equal(focused, h.area());
  });

  test('輸入法組字中的 F8 不算', () => {
    h.area().focus();
    h.key(h.area(), { key: 'F8', isComposing: true });
    assert.equal(h.focusOn(), false);
  });

  test('帶修飾鍵的 F8 不算', () => {
    h.key(h.area(), { key: 'F8', ctrlKey: true });
    assert.equal(h.focusOn(), false);
  });

  test('Esc 先收查詢條：查詢條開著時只收它，再按一次才退出專注模式', () => {
    h.key(h.area(), { key: 'F8' });
    h.key(h.area(), { key: 'f', ctrlKey: true });
    h.area().focus();
    h.key(h.area(), { key: 'Escape' });
    const bar = h.main().querySelector('.ed-find');
    const after1 = [bar.classList.contains('hidden'), h.focusOn()];
    h.key(h.area(), { key: 'Escape' });
    assert.deepEqual([...after1, h.focusOn()], [true, true, false]);
  });

  test('選單開著時 Esc 只收選單，不連帶退出專注模式', () => {
    h.key(h.area(), { key: 'F8' });
    h.viewMenu();
    h.key(h.area(), { key: 'Escape' });
    const after1 = [h.ui.doc.querySelector('.wb-menu-drop'), h.focusOn()];
    h.key(h.area(), { key: 'Escape' });
    assert.deepEqual([...after1, h.focusOn()], [null, true, false]);
  });

  test('外觀面板開著時 Esc 只收面板', () => {
    h.key(h.area(), { key: 'F8' });
    h.pickMenu('外觀設定…');
    h.key(h.ui.doc.querySelector('.ed-look-font'), { key: 'Escape' });
    const after1 = [h.ui.doc.querySelector('.ed-look'), h.focusOn()];
    h.key(h.area(), { key: 'Escape' });
    assert.deepEqual([...after1, h.focusOn()], [null, true, false]);
  });

  test('專注模式下狀態列淡成一行，碼字統計那一格照樣點得開面板', () => {
    h.key(h.area(), { key: 'F8' });
    const status = h.main().querySelector('.ed-status');
    h.ui.clickEl(h.ui.doc.getElementById('edStatusWords'));
    const panel = h.ui.doc.querySelector('.ed-stats-panel');
    assert.deepEqual([h.focusOn(), status.classList.contains('hidden'), !!panel, panel?.parentElement], [true, false, true, h.ui.doc.body]);
  });

  test('碼字統計面板開著時 Esc 先收面板，再按一次才退出專注模式', () => {
    h.area().focus();
    h.key(h.area(), { key: 'Escape' });
    const after1 = [h.ui.doc.querySelector('.ed-stats-panel'), h.focusOn()];
    h.key(h.area(), { key: 'Escape' });
    assert.deepEqual([...after1, h.focusOn()], [null, true, false]);
  });

  test('沒開專注模式時 Esc 什麼都不攔', () => {
    const ev = h.key(h.area(), { key: 'Escape' });
    assert.equal(ev.defaultPrevented, false);
  });
});

describe('專注：兩塊編輯區只專注當前那一塊', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
    h.open('chapters/001.md', '正文。');
    h.open('.novelwarden/summaries/001.md', '細綱。', { kind: 'plot' }, { pane: 'draft' });
  });

  test('右邊那一塊是當前的：專注它，左邊那塊不掛', () => {
    h.key(h.area(h.draft()), { key: 'F8' });
    assert.deepEqual(
      [h.draft().classList.contains('ed-focused'), h.main().classList.contains('ed-focused')],
      [true, false]
    );
  });

  test('當前那一塊換了（從別處開啟了左邊的檔案）：專注跟過去', () => {
    h.open('chapters/002.md', '第二章。');
    assert.deepEqual(
      [h.main().classList.contains('ed-focused'), h.draft().classList.contains('ed-focused')],
      [true, false]
    );
  });

  test('退出之後兩塊都不掛', () => {
    h.key(h.area(), { key: 'F8' });
    assert.equal(h.ui.doc.querySelectorAll('.ed-focused').length, 0);
  });
});

describe('專注：開關記在偏好裡', { skip: JSDOM_SKIP }, () => {
  test('三個開關記進 novelforge.editor.prefs（與成對符號同一處）', () => {
    const h = harness({ storage: { 'novelforge.editor.prefs': JSON.stringify({ autoPair: false }) } });
    h.open('chapters/001.md', '雨夜。');
    h.pickMenu('專注模式');
    h.pickMenu('打字機滾動');
    h.pickMenu('段落聚焦');
    const saved = JSON.parse(h.ui.window.localStorage.getItem('novelforge.editor.prefs'));
    assert.deepEqual(
      [saved.autoPair, saved.focusMode, saved.typewriter, saved.paragraphFocus, 'fullscreen' in saved],
      [false, true, true, true, false]
    );
  });

  test('關掉就從偏好裡刪掉那一項', () => {
    const h = harness({ storage: { 'novelforge.editor.prefs': JSON.stringify({ focusMode: true }) } });
    h.open('chapters/001.md', '雨夜。');
    h.pickMenu('專注模式');
    const saved = JSON.parse(h.ui.window.localStorage.getItem('novelforge.editor.prefs'));
    assert.equal('focusMode' in saved, false);
  });

  test('重新整理之後還在專注模式裡', () => {
    const h = harness({ storage: { 'novelforge.editor.prefs': JSON.stringify({ focusMode: true, typewriter: true }) } });
    h.open('chapters/001.md', '雨夜。');
    assert.deepEqual(
      [h.focusOn(), h.main().classList.contains('ed-focused'), h.ui.doc.body.classList.contains('nf-typewriter')],
      [true, true, true]
    );
  });

  test('寫壞的值（"true"）當關', () => {
    const h = harness({ storage: { 'novelforge.editor.prefs': JSON.stringify({ focusMode: 'true' }) } });
    assert.equal(h.focusOn(), false);
  });
});

describe('專注：打字機滾動', { skip: JSDOM_SKIP }, () => {
  let h;
  const { line, pad, viewport } = MIRROR_LAYOUT;
  /** 第 k 行（從 0 起）的中線滾到視口中間時的 scrollTop。 */
  const centered = (k) => Math.max(0, Math.round(pad + k * line + line / 2 - viewport / 2));
  const TEXT = Array.from({ length: 60 }, (_, i) => `第${i}行。`).join('\n');
  /** 編輯區裡**當下**第 k 行（從 0 起）的行首（打過回車之後行號會挪）。 */
  const lineStart = (k) => {
    const lines = h.area().value.split('\n');
    return lines.slice(0, k).join('\n').length + (k > 0 ? 1 : 0);
  };

  before(() => {
    h = harness({ shims: [...SHIMS, 'mirrorLayout'] });
    h.open('chapters/001.md', TEXT);
    h.pickMenu('打字機滾動');
  });

  test('開著時 body 掛 nf-typewriter（編輯區底下墊半屏）', () => {
    assert.equal(h.ui.doc.body.classList.contains('nf-typewriter'), true);
  });

  test('打字之後：游標那一行滾到視口中間', async () => {
    const a = h.area();
    a.focus();
    a.setSelectionRange(lineStart(20) + 2, lineStart(20) + 2);
    a.scrollTop = 0;
    h.type(a, '字');
    await frames();
    assert.equal(a.scrollTop, centered(20));
  });

  test('回車之後：新的那一段滾到中間（空行分段：回車另起一段，中間空一行）', async () => {
    const a = h.area();
    h.key(a, { key: 'Enter' });
    await frames();
    assert.equal(a.scrollTop, centered(22));
  });

  test('方向鍵挪了游標：下一幀滾過去', async () => {
    const a = h.area();
    // keydown 時瀏覽器還沒挪游標（jsdom 不挪）：先把游標放到第 30 行，再發那一下方向鍵。
    a.setSelectionRange(lineStart(30), lineStart(30));
    h.key(a, { key: 'ArrowDown' });
    await frames();
    assert.equal(a.scrollTop, centered(30));
  });

  test('組字中途不滾，上屏那一下才滾', async () => {
    const a = h.area();
    a.setSelectionRange(lineStart(40), lineStart(40));
    a.scrollTop = 7;
    a.dispatchEvent(new h.ui.window.CompositionEvent('compositionstart', { bubbles: true }));
    h.type(a, 'lin', { inputType: 'insertCompositionText', isComposing: true });
    h.key(a, { key: 'ArrowDown', isComposing: true });
    await frames();
    const during = a.scrollTop;
    a.value = a.value.replace('lin', '林');
    a.setSelectionRange(lineStart(40) + 1, lineStart(40) + 1);
    a.dispatchEvent(new h.ui.window.CompositionEvent('compositionend', { bubbles: true, data: '林' }));
    await frames();
    assert.deepEqual([during, a.scrollTop], [7, centered(40)]);
  });

  test('用滾輪翻看前文：不拉回來（點一下也不）', async () => {
    const a = h.area();
    a.scrollTop = 0;
    a.dispatchEvent(new h.ui.window.Event('scroll'));
    a.dispatchEvent(new h.ui.window.WheelEvent('wheel', { bubbles: true, deltaY: -300 }));
    a.dispatchEvent(new h.ui.window.MouseEvent('mouseup', { bubbles: true }));
    a.dispatchEvent(new h.ui.window.MouseEvent('click', { bubbles: true }));
    await frames();
    assert.equal(a.scrollTop, 0);
  });

  test('下一次打字才回到游標那裡', async () => {
    const a = h.area();
    h.type(a, '字');
    await frames();
    assert.equal(a.scrollTop, centered(40));
  });

  test('焦點不在編輯區（別處改寫了正文）：不滾', async () => {
    const a = h.area();
    a.scrollTop = 3;
    h.ui.doc.getElementById('input').focus();
    h.type(a, '字');
    await frames();
    assert.equal(a.scrollTop, 3);
  });

  test('關掉之後：打字不滾', async () => {
    h.pickMenu('打字機滾動');
    const a = h.area();
    a.focus();
    a.setSelectionRange(lineStart(50), lineStart(50));
    a.scrollTop = 5;
    h.type(a, '字');
    await frames();
    assert.deepEqual([a.scrollTop, h.ui.doc.body.classList.contains('nf-typewriter')], [5, false]);
  });
});

describe('專注：段落聚焦', { skip: JSDOM_SKIP }, () => {
  let h;
  const TEXT = '第一段。\n\n第二段前半，\n續行。\n\n第三段。';
  /** 映象層上 focus 那一層包著的字（可能被查詢高亮切成幾截，拼起來）。 */
  const focused = (root = h.main()) =>
    [...root.querySelectorAll('.ed-mirror:not(.ed-mirror-probe) mark.ed-hl-focus')].map((m) => m.textContent).join('');
  const dimmed = (root = h.main()) => h.area(root).classList.contains('ed-para-dim');
  const moveTo = (a, at) => {
    a.setSelectionRange(at, at);
    a.dispatchEvent(new h.ui.window.KeyboardEvent('keyup', { bubbles: true, key: 'ArrowDown' }));
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  before(() => {
    h = harness();
    h.open('chapters/001.md', TEXT);
    const a = h.area();
    a.focus();
    a.setSelectionRange(TEXT.indexOf('續行'), TEXT.indexOf('續行'));
  });

  test('關著時：不調淡、映象層上沒有這一層', () => {
    assert.deepEqual([dimmed(), focused()], [false, '']);
  });

  test('開啟：textarea 的字調淡，映象層用實色畫游標那一段', () => {
    h.pickMenu('段落聚焦');
    assert.deepEqual([dimmed(), focused()], [true, '第二段前半，\n續行。']);
  });

  test('游標換到別的段：圖層跟著換', () => {
    moveTo(h.area(), TEXT.indexOf('第三段'));
    assert.equal(focused(), '第三段。');
  });

  test('滑鼠點過去也換', () => {
    const a = h.area();
    a.setSelectionRange(1, 1);
    a.dispatchEvent(new h.ui.window.MouseEvent('mouseup', { bubbles: true }));
    assert.equal(focused(), '第一段。');
  });

  test('打字之後：新打的字也在這一段裡（同一輪就畫好，不閃）', async () => {
    const a = h.area();
    a.setSelectionRange(4, 4);
    h.type(a, '雨');
    await flush();
    assert.equal(focused(), '第一段。雨');
  });

  test('輸入法組字中途：拼音也算在這一段裡', async () => {
    const a = h.area();
    a.dispatchEvent(new h.ui.window.CompositionEvent('compositionstart', { bubbles: true }));
    h.type(a, 'xia', { inputType: 'insertCompositionText', isComposing: true });
    await flush();
    const during = focused();
    a.value = a.value.replace('xia', '下');
    a.setSelectionRange(6, 6);
    a.dispatchEvent(new h.ui.window.CompositionEvent('compositionend', { bubbles: true, data: '下' }));
    await flush();
    assert.deepEqual([during, focused()], ['第一段。雨xia', '第一段。雨下']);
  });

  test('游標在空行上（新起的一段還沒有字）：哪一段都不畫實色', () => {
    moveTo(h.area(), h.area().value.indexOf('\n\n') + 1);
    assert.deepEqual([dimmed(), focused()], [true, '']);
  });

  test('與查詢高亮疊得上：兩層的 class 落在同一段字上', async () => {
    const a = h.area();
    moveTo(a, a.value.indexOf('第三段'));
    h.key(a, { key: 'f', ctrlKey: true });
    const input = h.main().querySelector('.ed-find-input');
    input.value = '三';
    input.dispatchEvent(new h.ui.window.Event('input', { bubbles: true }));
    const both = [...h.main().querySelectorAll('.ed-mirror:not(.ed-mirror-probe) mark')].find(
      (m) => m.classList.contains('ed-hl-focus') && m.classList.contains('ed-hl-find-current')
    );
    assert.deepEqual([both?.textContent, focused()], ['三', '第三段。']);
    h.key(input, { key: 'Escape' });
  });

  test('按工程的分段格式認：段首縮排時，有縮排的那一行另起一段', () => {
    h.ui.post({ type: 'state', state: viewState({ paragraphStyle: 'indent' }) });
    const text = '　　甲段，\n續行。\n　　乙段。';
    h.open('chapters/002.md', text);
    const a = h.area();
    a.focus();
    moveTo(a, text.indexOf('續行'));
    const first = focused();
    moveTo(a, text.indexOf('乙段'));
    assert.deepEqual([first, focused()], ['　　甲段，\n續行。', '　　乙段。']);
  });

  test('非正文（角色卡、細綱）不做：不調淡、沒有這一層', () => {
    h.open('.novelwarden/characters/林昭.md', '# 林昭\n\n主角。', { kind: 'character' });
    assert.deepEqual([dimmed(), focused()], [false, '']);
  });

  test('切回正文又有了', () => {
    h.ui.clickEl([...h.main().querySelectorAll('.ed-tab')].find((t) => t.textContent.includes('002')));
    assert.deepEqual([dimmed(), focused() !== ''], [true, true]);
  });

  test('預覽裡不畫（textarea 藏著）', () => {
    h.open('chapters/003.md', '甲。\n\n乙。');
    h.ui.clickEl(h.ui.doc.getElementById('edPreviewBtn'));
    const inPreview = [dimmed(), focused()];
    h.ui.clickEl(h.ui.doc.getElementById('edPreviewBtn'));
    assert.deepEqual([...inPreview, dimmed()], [false, '', true]);
  });

  test('超過 30 萬字不畫，也不調淡（不至於整篇都是淡字）', () => {
    h.open('chapters/004.md', `${'字'.repeat(300_001)}`);
    assert.deepEqual([dimmed(), focused()], [false, '']);
  });

  test('關掉：調淡撤掉、圖層清掉', () => {
    h.ui.clickEl([...h.main().querySelectorAll('.ed-tab')].find((t) => t.textContent.includes('003')));
    h.pickMenu('段落聚焦');
    assert.deepEqual([dimmed(), focused()], [false, '']);
  });

  test('右邊那一塊各認各的游標', () => {
    h.pickMenu('段落聚焦');
    h.open('drafts/001.md', '草稿甲。\n\n草稿乙。', { kind: 'draft' }, { pane: 'draft' });
    const a = h.area(h.draft());
    a.focus();
    moveTo(a, a.value.indexOf('草稿乙'));
    assert.deepEqual([focused(h.draft()), dimmed(h.draft())], ['草稿乙。', true]);
  });
});
