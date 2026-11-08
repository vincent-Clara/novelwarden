/**
 * 觸屏與手機窄屏（2026-10-24，Android 殼實測之後）：樣式裡那幾條能力探測的規矩、右鍵選單與標題欄下拉整個落在可視區裡、
 * 工程頁三隻懸停浮窗在手指下的入口（長按選單最前面的「看一眼」、點感嘆號）、窄屏上把歡迎頁翻上來。
 * 擺位置的幾何本身在 tests/unit/view/menuPlace.test.js；名詞浮窗與敘事線總覽的觸屏互動在 nameMarks.test.js / threadsOverview.test.js；
 * 標題欄的書名在 welcome.test.js；窄屏底欄、標題欄「⋯」、返回鍵與編輯區頂上兩行的互動在 mobileNav.test.js。真瀏覽器（360×640 觸屏、1440×860 桌面）與 Android 真機的核對見 media/README.md「觸屏與窄屏」。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 樣式 | 整頁的列不被 min-content 撐開；`(hover: none)` 裡整頁不選字、正文與要複製的那幾樣照常能選、懸停才露的東西常顯、不提快捷鍵、不顯示「外部開啟」；`(pointer: coarse)`（與沒登記指標的 `(pointer: none)`）裡點選目標放大、文字按鈕的點選區往四周借；窄屏上活動欄成了底欄（檔案 / 歷史 / 日誌 / 設定收進「更多」）、標題欄藏選單欄、編輯區頂上只留標籤條與章節條、提示條浮在底欄上；軟鍵盤彈著（kb-open）或可視高度很矮時、正在打字就讓出底欄與流水線條 / 章節條；寬屏上窄屏那幾顆不出來；區分只用媒體查詢，不認 UA；頁頭宣告瞭 `interactive-widget=resizes-content` 與 `theme-color` |
 * | 右鍵選單 | 下半屏放不下：往上翻 / 平移貼底；比可視區還高：壓 max-height；桌面上右下角照舊往左上翻 |
 * | 標題欄下拉與子選單 | 「幫助」的下拉伸出右邊就往左收（與按鈕右沿對齊）；子選單右邊放不下翻到左邊、貼邊；點一下父選單項也展開子選單；手指點之前補發的 mouseenter / mouseover 不展開子選單、不換選單（實機上一點父項就開啟了最近的書、點「編輯」把選單全關了） |
 * | 工程頁的「看一眼」 | 手指長按章節行：最前面「細綱速覽」（掛著失敗的還有「看失敗原因」），點了釘住浮窗、按在外面才收；滑鼠右鍵沒有這幾項；手指點之後補發的 mouseover 不彈浮窗；手指點感嘆號釘住失敗浮窗，滑鼠點不彈；說明被截斷的行長按有「看完整說明」 |
 * | 窄屏的歡迎頁 | 空視窗與「幫助 → 歡迎頁面」把編輯區那層覆蓋翻上來；開啟一本書之後收起；寬屏不碰 |
 * | 不順手聚焦 | 手指點「對話」頁籤、手機上一載入、手指點編輯器頁籤切檔案：都不把焦點放進輸入框 / 正文區（一聚焦就彈軟鍵盤）；滑鼠照舊聚焦 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mount, JSDOM_SKIP, sampleTree, viewState, file } = require('../../helpers/dom');
const { ROOT } = require('../../helpers/load');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 產物裡某個 @media 塊的內容（按花括號配對）。 */
function mediaBlocks(css, query) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = css.indexOf(`@media ${query}`, from);
    if (at < 0) {
      return out;
    }
    const open = css.indexOf('{', at);
    let depth = 0;
    let i = open;
    for (; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) break;
    }
    out.push(css.slice(open + 1, i));
    from = i;
  }
}

describe('觸屏與窄屏：樣式', { skip: JSDOM_SKIP }, () => {
  const css = fs.readFileSync(path.join(ROOT, 'dist', 'media', 'standalone.css'), 'utf8');
  const hoverNone = mediaBlocks(css, '(hover: none)').join('\n');
  const coarse = mediaBlocks(css, '(pointer: coarse)').join('\n');
  const narrow = mediaBlocks(css, '(max-width: 900px)').join('\n');

  test('整頁的列寫死成 minmax(0, 1fr)、高度跟佈局視口（100%），不被標題欄裡不折行的路徑撐寬', () => {
    const rule = /body\.workbench\s*\{[^}]*\}/.exec(css)[0];
    assert.match(rule, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    assert.match(rule, /height:\s*100%/);
    assert.doesNotMatch(rule, /100vh/);
  });

  test('(hover: none)：整頁不選字；輸入框、編輯區、預覽、對話正文、浮窗、日誌這些照常能選', () => {
    assert.match(hoverNone, /body\.workbench\s*\{[^}]*user-select:\s*none/);
    const reopen = /body\.workbench :is\(([^)]*)\)\s*\{[^}]*user-select:\s*text/.exec(hoverNone);
    assert.ok(reopen, '沒有重新開啟選字的那一條');
    for (const sel of ['input', 'textarea', '.ed-preview', '.msg-body', '.gen-body', '.summary-tip', '.failure-tip', '.log-msg']) {
      assert.ok(reopen[1].includes(sel), `${sel} 應該能選字`);
    }
  });

  test('(hover: none)：懸停才露出來的行內按鈕、⋯、標籤上的 × 常顯', () => {
    assert.match(hoverNone, /\.row-actions\s*\{[^}]*opacity:\s*1/);
    assert.match(hoverNone, /\.msg-menu-btn\s*\{[^}]*opacity/);
    assert.match(hoverNone, /\.ed-tab \.ed-tab-close\s*\{[^}]*opacity/);
  });

  test('(pointer: coarse)：選單項、樹的行、頁籤、圖示按鈕放大到 40px 上下；標題欄加高（窄屏覆蓋層跟著它的變數走）', () => {
    assert.match(coarse, /\.wb-menu-item\s*\{[^}]*height:\s*40px/);
    assert.match(coarse, /\.ctx-menu button,\s*\.msg-menu button\s*\{[^}]*min-height:\s*40px/);
    assert.match(coarse, /\.row\s*\{[^}]*min-height:\s*40px/);
    assert.match(coarse, /\.fx-row\s*\{[^}]*min-height:\s*40px/);
    assert.match(coarse, /\.icon-btn\s*\{[^}]*min-width:\s*40px/);
    assert.match(coarse, /--nf-title-height:\s*44px/);
    assert.match(narrow, /inset:\s*var\(--nf-title-height\) 0 var\(--nf-nav-height\)/);
  });

  test('放大點選目標那一段也認 (pointer: none)（Android 模擬器 / 容器裡沒有登記觸屏）', () => {
    assert.match(css, /@media \(pointer: coarse\),\s*\(pointer: none\)/);
  });

  test('窄屏 + 可視高度很矮（橫屏或軟鍵盤彈出來）：焦點在對話輸入框裡收起底欄、流水線條、下一步、輸入框底下那行小字；在編輯區裡收起章節條、工具欄與底欄', () => {
    const short = mediaBlocks(css, '(max-width: 900px) and (max-height: 480px)').join('\n');
    assert.match(short, /body\.workbench:has\(#input:focus\) :is\(\.tabbar, \.pipeline, \.nextstep, \.composer-meta\)\s*\{[^}]*display:\s*none/);
    assert.match(short, /body\.workbench:has\(\.ed-area:focus\) :is\(\.ed-chapter-bar, \.ed-toolbar, \.tabbar\)\s*\{[^}]*display:\s*none/);
    assert.match(short, /--nf-nav-height:\s*0px/);
  });

  test('窄屏 + 軟鍵盤彈著（kb-open）：底欄讓出來、編輯區落到底；在正文裡打字時標題欄、章節條也讓出來，編輯區頂到最上面；對話頁讓出流水線條', () => {
    assert.match(narrow, /body\.kb-open\s*\{[^}]*--nf-nav-height:\s*0px/);
    assert.match(narrow, /body\.kb-open:has\(\.ed-area:focus\)\s*\{[^}]*--nf-title-height:\s*0px/);
    assert.match(narrow, /body\.kb-open:has\(\.ed-area:focus\) \.wb-title,/);
    assert.match(narrow, /body\.kb-open \.tabbar\s*\{[^}]*display:\s*none/);
    assert.match(narrow, /body\.kb-open:has\(\.ed-area:focus\) \.ed-chapter-bar,\s*body\.kb-open:has\(#input:focus\) :is\(\.pipeline, \.nextstep, \.composer-meta\)\s*\{[^}]*display:\s*none/);
  });

  test('窄屏：活動欄成了底欄（排到側欄下面），檔案 / 歷史 / 日誌 / 設定收進「更多」；標題欄藏選單欄、露書名；編輯區頂上只留標籤條與章節條', () => {
    assert.match(narrow, /\.workbench \.tabbar\s*\{[^}]*order:\s*1[^}]*height:\s*var\(--nf-nav-height\)/);
    // 構建會把屬性值的引號去掉。
    assert.match(narrow, /\.workbench \.tab:is\(\[data-tab='?files'?\], \[data-tab='?history'?\], \[data-tab='?logs'?\], \[data-tab='?settings'?\]\)\s*\{[^}]*display:\s*none/);
    assert.match(narrow, /\.wb-menubar\s*\{[^}]*display:\s*none/);
    assert.match(narrow, /\.wb-title-full\s*\{[^}]*display:\s*none/);
    assert.match(narrow, /\.wb-title-short\s*\{[^}]*display:\s*inline/);
    assert.match(narrow, /\.ed-toolbar\s*\{[^}]*display:\s*none/);
    assert.match(narrow, /\.ed-chapter-actions,\s*\.ed-chapter-nav-word\s*\{[^}]*display:\s*none/);
    assert.match(narrow, /\.workbench \.toast\s*\{[^}]*bottom:\s*calc\(var\(--nf-nav-height\)/);
    assert.match(css, /\.wb-menu-btn\s*\{[^}]*white-space:\s*nowrap/);
    // 寬屏上這幾顆都不出來。
    const wide = mediaBlocks(css, '(min-width: 901px)').join('\n');
    // 按鈕要寫成 button.…：button.primary / button.chip-btn 自帶 display，只寫類名壓不過（桌面上露出來過）。
    assert.match(wide, /\.tab\[data-nav\],\s*#wbMoreBtn,\s*button\.ed-tabs-icon,\s*button\.ed-tabs-save,\s*button\.ed-tabs-tools,\s*button\.ed-chapter-menu\s*\{[^}]*display:\s*none/);
  });

  test('(hover: none)：能打字的框把整頁關掉的長按 callout 還回來（走系統的選字選單）', () => {
    assert.match(hoverNone, /body\.workbench :is\(input, textarea, \[contenteditable\]\)\s*\{[^}]*-webkit-touch-callout:\s*default/);
  });

  test('(hover: none)：快捷鍵提示與「外部開啟」不顯示；(pointer: coarse)：文字按鈕的點選區往四周借', () => {
    assert.match(hoverNone, /\.wb-menu-kbd,\s*\.kbd-hint,[^{]*\{[^}]*display:\s*none/);
    assert.match(hoverNone, /\.ed-external-btn\s*\{[^}]*display:\s*none/);
    assert.match(coarse, /button\.link\s*\{[^}]*padding:\s*10px 4px;[^}]*margin:\s*-10px -2px/);
  });

  test('區分形態只用能力探測：樣式裡沒有按 UA、按殼分的選擇器；頁面宣告瞭鍵盤彈出時縮佈局視口', () => {
    assert.doesNotMatch(css, /android|user-agent|data-shell/i);
    const { standalonePage } = require('../../helpers/load').loadModule('src/shells/standalone/page.ts');
    assert.match(standalonePage(), /<meta name="viewport" content="[^"]*interactive-widget=resizes-content/);
    // 系統欄的顏色：手機瀏覽器與 Android 殼都按它染，換主題時頁面改它（look.test.js「護眼主題」）
    assert.match(standalonePage(), /<meta name="theme-color" content="#[0-9a-f]{6}">/);
  });
});

/** 給右鍵選單與標題欄的下拉裝上尺寸：jsdom 裡全是 0。 */
function sized(ui, sizes) {
  Object.defineProperty(ui.window, 'innerWidth', { get: () => 360, configurable: true });
  Object.defineProperty(ui.window, 'innerHeight', { get: () => 640, configurable: true });
  const pick = (node) => Object.entries(sizes).find(([cls]) => node.classList?.contains(cls))?.[1];
  Object.defineProperty(ui.window.HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      return pick(this)?.w ?? 0;
    },
  });
  Object.defineProperty(ui.window.HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return pick(this)?.h ?? 0;
    },
  });
}

describe('觸屏與窄屏：選單整個落在可視區裡（360×640）', { skip: JSDOM_SKIP }, () => {
  let ui;
  const size = { w: 150, h: 476 };
  const menu = () => ui.doc.querySelector('.ctx-menu');
  const box = () => ({ left: parseFloat(menu().style.left), top: parseFloat(menu().style.top), maxHeight: menu().style.maxHeight });
  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js'] });
    sized(ui, { 'ctx-menu': size, submenu: { w: 260, h: 80 }, 'wb-menu-drop': { w: 220, h: 300 } });
  });

  test('下半屏長按、選單比剩下的高：先往上翻；翻不下就平移到貼著底邊，整個看得見', () => {
    size.h = 300;
    ui.rightClick(ui.doc.getElementById('messages'), 40, 560);
    assert.deepEqual(box(), { left: 40, top: 260, maxHeight: '' });
    ui.closeMenu();
    size.h = 476;
    ui.rightClick(ui.doc.getElementById('messages'), 40, 300);
    assert.deepEqual(box(), { left: 40, top: 640 - 4 - 476, maxHeight: '' });
    ui.closeMenu();
  });

  test('比整個可視區還高：從頂上開始、壓 max-height（選單裡滾）；右邊放不下往左翻', () => {
    size.h = 900;
    ui.rightClick(ui.doc.getElementById('messages'), 300, 400);
    assert.deepEqual(box(), { left: 150, top: 4, maxHeight: '632px' });
    ui.closeMenu();
  });

  test('「幫助」的下拉伸出右邊就往左收；「開啟最近開啟的」子選單右邊放不下翻到左邊、再不行貼邊；點一下父項也展開', () => {
    const help = ui.doc.querySelector('[data-menu="help"]');
    help.getBoundingClientRect = () => ({ left: 300, right: 340, top: 0, bottom: 44, width: 40, height: 44 });
    ui.clickEl(help);
    const drop = ui.doc.querySelector('.wb-menu-drop');
    // 右邊伸出去：與按鈕右沿對齊（往左收）
    assert.equal(drop.style.left, `${340 - 220}px`);
    assert.equal(drop.style.top, '44px');
    ui.clickEl(help);

    ui.clickEl(ui.doc.querySelector('[data-menu="file"]'));
    const parent = [...ui.doc.querySelectorAll('.wb-menu-item')].find((b) => b.textContent.includes('開啟最近開啟的'));
    parent.getBoundingClientRect = () => ({ left: 4, right: 224, top: 200, bottom: 240, width: 220, height: 40 });
    ui.clickEl(parent);
    const sub = ui.doc.querySelector('.wb-menu-drop.submenu');
    assert.ok(sub, '點一下父選單項就該展開子選單（手指沒有懸停）');
    assert.equal(sub.style.left, `${360 - 4 - 260}px`);
    assert.equal(sub.style.top, '200px');
    ui.closeMenu();
  });

  test('手指點子選單的父項：點之前補發的 mouseenter 不展開（不然緊跟的 click 落到蓋過來的子選單項上），靠 click 展開', () => {
    const finger = (node) => node.dispatchEvent(new ui.window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    ui.clickEl(ui.doc.querySelector('[data-menu="file"]'));
    const parent = [...ui.doc.querySelectorAll('.wb-menu-item')].find((b) => b.textContent.includes('開啟最近開啟的'));
    finger(parent);
    parent.dispatchEvent(new ui.window.MouseEvent('mouseenter'));
    assert.equal(ui.doc.querySelector('.wb-menu-drop.submenu'), null);
    ui.clickEl(parent);
    assert.ok(ui.doc.querySelector('.wb-menu-drop.submenu'));
    ui.closeMenu();
  });

  test('開著「檔案」時手指點「編輯」：換成「編輯」的下拉，不是全關掉；滑鼠移過去照舊換', () => {
    const finger = (node) => node.dispatchEvent(new ui.window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    const mouse = (node) => node.dispatchEvent(new ui.window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
    const file = ui.doc.querySelector('[data-menu="file"]');
    const edit = ui.doc.querySelector('[data-menu="edit"]');
    const dropText = () => ui.doc.querySelector('.wb-menu-drop')?.textContent ?? '';
    ui.clickEl(file);
    assert.match(dropText(), /新建一本書/);
    finger(edit);
    edit.dispatchEvent(new ui.window.MouseEvent('mouseover', { bubbles: true }));
    ui.clickEl(edit);
    assert.match(dropText(), /撤銷/);
    mouse(file);
    file.dispatchEvent(new ui.window.MouseEvent('mouseover', { bubbles: true }));
    assert.match(dropText(), /新建一本書/);
    ui.closeMenu();
  });
});

describe('觸屏與窄屏：工程頁浮窗在手指下的入口', { skip: JSDOM_SKIP }, () => {
  let ui;
  const CHAPTER = 'chapters/002-入鎮.md';
  const finger = (node) => node.dispatchEvent(new ui.window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
  const mouse = (node) => node.dispatchEvent(new ui.window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
  const rowWith = (text) => [...ui.doc.querySelectorAll('#projectBody .row-plot[data-plot]')].find((n) => n.textContent.includes(text));
  const castRow = (text) => [...ui.doc.querySelectorAll('#projectBody .row')].find((n) => n.querySelector('.row-label')?.textContent.includes(text) && n.querySelector('.row-detail'));
  const summaryTip = () => ui.doc.querySelector('.summary-tip');
  const failureTip = () => ui.doc.querySelector('.failure-tip');

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js'] });
    const tree = sampleTree();
    tree.failures = { [CHAPTER]: [{ at: '2026-10-24T08:00:00.000Z', severity: 'error', message: '同步失敗：模型返回無法解析' }] };
    ui.post({ type: 'state', state: viewState() });
    ui.post({ type: 'project', tree });
  });

  test('手指長按章節行：選單最前面「細綱速覽」，掛著失敗的還有「看失敗原因」；滑鼠右鍵沒有這幾項', () => {
    finger(rowWith('入鎮'));
    let menu = ui.rightClick(rowWith('入鎮').querySelector('.row-label'));
    const items = ui.itemsOf(menu);
    assert.deepEqual(items.slice(0, 2), ['細綱速覽', '看失敗原因']);
    ui.closeMenu();
    mouse(rowWith('入鎮'));
    menu = ui.rightClick(rowWith('入鎮').querySelector('.row-label'));
    assert.equal(ui.itemsOf(menu).includes('細綱速覽'), false);
    assert.equal(ui.itemsOf(menu).includes('看失敗原因'), false);
    ui.closeMenu();
  });

  test('「細綱速覽」：釘住這一章的細綱浮窗、去要細綱；按在浮窗裡不收，按在外面才收', async () => {
    ui.sent.length = 0;
    finger(rowWith('楔子'));
    ui.pick(ui.rightClick(rowWith('楔子').querySelector('.row-label')), '細綱速覽');
    assert.ok(summaryTip());
    assert.equal(ui.last('requestSummary').plotRelPath, rowWith('楔子').dataset.plot);
    await wait(5);
    // 補發的相容滑鼠事件（移開）不收釘住的浮窗
    summaryTip().dispatchEvent(new ui.window.MouseEvent('mouseleave'));
    ui.doc.getElementById('projectBody').dispatchEvent(new ui.window.MouseEvent('mouseleave'));
    await wait(400);
    assert.ok(summaryTip());
    finger(summaryTip());
    assert.ok(summaryTip(), '按在浮窗裡（滾動、選字）不收');
    finger(ui.doc.body);
    assert.equal(summaryTip(), null);
  });

  test('手指點一下之後補發的 mouseover 不當懸停：過了延遲也不彈細綱浮窗', async () => {
    finger(rowWith('楔子'));
    rowWith('楔子').dispatchEvent(new ui.window.MouseEvent('mouseover', { bubbles: true }));
    await wait(600);
    assert.equal(summaryTip(), null);
    // 換回滑鼠：照舊懸停就彈
    mouse(rowWith('楔子'));
    rowWith('楔子').dispatchEvent(new ui.window.MouseEvent('mouseover', { bubbles: true }));
    await wait(600);
    assert.ok(summaryTip());
    ui.doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(summaryTip(), null);
  });

  test('手指點感嘆號：釘住失敗浮窗（不開啟這一章）；滑鼠點不彈', async () => {
    const mark = rowWith('入鎮').querySelector('.row-failure');
    assert.ok(mark);
    ui.sent.length = 0;
    mouse(mark);
    ui.clickEl(mark);
    assert.equal(failureTip(), null);
    finger(mark);
    ui.clickEl(mark);
    assert.ok(failureTip());
    assert.match(failureTip().textContent, /同步失敗：模型返回無法解析/);
    assert.equal(ui.last('openChapter'), undefined);
    await wait(5);
    finger(ui.doc.body);
    assert.equal(failureTip(), null);
  });

  test('說明被截斷的行：長按有「看完整說明」，點了釘住那一行說明；沒截斷的沒有', async () => {
    const row = castRow('林昭');
    assert.ok(row, '要一行帶說明的角色行');
    const detail = row.querySelector('.row-detail');
    finger(row);
    let menu = ui.rightClick(row.querySelector('.row-label'));
    assert.equal(ui.itemsOf(menu).includes('看完整說明'), false);
    ui.closeMenu();
    Object.defineProperty(detail, 'scrollWidth', { value: 300, configurable: true });
    Object.defineProperty(detail, 'clientWidth', { value: 100, configurable: true });
    finger(row);
    menu = ui.rightClick(row.querySelector('.row-label'));
    assert.equal(ui.itemsOf(menu)[0], '看完整說明');
    ui.pick(menu, '看完整說明');
    assert.equal(ui.doc.querySelector('.detail-tip')?.textContent, detail.textContent);
    await wait(5);
    finger(ui.doc.body);
    assert.equal(ui.doc.querySelector('.detail-tip'), null);
  });
});

describe('觸屏與窄屏：切頁、開啟檔案不順手聚焦輸入框（手機上一聚焦就彈軟鍵盤）', { skip: JSDOM_SKIP }, () => {
  const finger = (ui, node) => node.dispatchEvent(new ui.window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
  const mouse = (ui, node) => node.dispatchEvent(new ui.window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
  const chatTab = (ui) => ui.doc.querySelector('.tab[data-tab="chat"]');
  const otherTab = (ui) => ui.doc.querySelector('.tab[data-tab="project"]');

  test('手指點「對話」頁籤：不聚焦輸入框；滑鼠點照舊聚焦', () => {
    const ui = mount({ body: 'standalone', scripts: ['view.js'] });
    ui.post({ type: 'state', state: viewState() });
    const input = ui.doc.getElementById('input');
    ui.clickEl(otherTab(ui));
    input.blur();
    finger(ui, chatTab(ui));
    ui.clickEl(chatTab(ui));
    assert.notEqual(ui.doc.activeElement, input);
    ui.clickEl(otherTab(ui));
    mouse(ui, chatTab(ui));
    ui.clickEl(chatTab(ui));
    assert.equal(ui.doc.activeElement, input);
  });

  test('主指標不能懸停的裝置（手機）：一載入停在對話頁也不聚焦輸入框', () => {
    const ui = mount({ body: 'standalone', scripts: ['view.js'] });
    ui.window.matchMedia = (q) => ({ matches: /hover:\s*none/.test(q), addEventListener() {}, removeEventListener() {} });
    ui.doc.getElementById('input').blur();
    ui.post({ type: 'state', state: viewState() });
    ui.clickEl(otherTab(ui));
    ui.clickEl(chatTab(ui));
    assert.notEqual(ui.doc.activeElement, ui.doc.getElementById('input'));
  });

  test('手指點編輯器頁籤切檔案：不把焦點放進正文區（點進正文才打字）；滑鼠照舊', () => {
    const ui = mount({
      body: 'standalone',
      scripts: ['view.js', 'editor.js'],
      shims: ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'],
      url: `http://localhost/?project=${encodeURIComponent('/書/青雲劍錄')}`,
    });
    const open = (p, text) => ui.post({ type: 'editorOpen', file: file(p, text, { kind: 'chapter' }) });
    open('chapters/001-楔子.md', '第一章');
    open('chapters/002-入鎮.md', '第二章');
    const area = ui.doc.getElementById('edArea');
    const tabOf = (name) => [...ui.doc.querySelectorAll('.ed-tab')].find((t) => t.textContent.includes(name));
    area.blur();
    finger(ui, tabOf('楔子'));
    ui.clickEl(tabOf('楔子'));
    assert.equal(area.value, '第一章');
    assert.notEqual(ui.doc.activeElement, area);
    mouse(ui, tabOf('入鎮'));
    ui.clickEl(tabOf('入鎮'));
    assert.equal(area.value, '第二章');
    assert.equal(ui.doc.activeElement, area);
  });
});

describe('觸屏與窄屏：窄屏上把歡迎頁翻上來', { skip: JSDOM_SKIP }, () => {
  const open = (ui, id) =>
    ui.post({ type: 'workspaces', currentId: id, items: id ? [{ id, root: id, name: path.basename(id) }] : [], recents: [] });
  const editorOpen = (ui) => ui.doc.body.classList.contains('editor-open');

  test('窄屏：一開啟就是空視窗——編輯區那層覆蓋翻上來（歡迎頁在裡面）；開啟一本書之後收起，露出側欄', () => {
    const ui = mount({ body: 'standalone', scripts: ['view.js'], empty: true, shims: ['clipboard', 'scrollIntoView', 'narrow'] });
    assert.equal(editorOpen(ui), true, '裝載時就是空視窗');
    open(ui, null);
    assert.equal(editorOpen(ui), true);
    open(ui, '/tmp/my-book');
    assert.equal(editorOpen(ui), false);
  });

  test('窄屏：「幫助 → 歡迎頁面」也翻上來', () => {
    const ui = mount({ body: 'standalone', scripts: ['view.js'], shims: ['clipboard', 'scrollIntoView', 'narrow'] });
    open(ui, '/tmp/my-book');
    assert.equal(editorOpen(ui), false);
    ui.clickEl(ui.doc.querySelector('[data-menu="help"]'));
    ui.clickEl([...ui.doc.querySelectorAll('.wb-menu-item')].find((b) => b.textContent.includes('歡迎頁面')));
    assert.equal(ui.doc.body.classList.contains('show-welcome'), true);
    assert.equal(editorOpen(ui), true);
  });

  test('寬屏：不碰 editor-open（編輯區常駐）', () => {
    const ui = mount({ body: 'standalone', scripts: ['view.js'], empty: true });
    ui.window.matchMedia = () => ({ matches: false });
    open(ui, null);
    assert.equal(editorOpen(ui), false);
  });
});
