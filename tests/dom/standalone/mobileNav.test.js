/**
 * 窄屏導航（2026-10-31，手機端全面最佳化）：底欄的「正文」「更多」、標題欄的「⋯」、返回鍵一層層收、軟鍵盤彈著時底欄讓位、
 * 編輯區頂上只留兩行（標籤條末尾的「儲存」「⋯」、章節條的「操作 ▾」）、窄屏上不併排開第二塊。
 * 樣式那一半（底欄的排布、藏哪幾樣）在 touch.test.js；後端 `openChapter` 的 `beside: false` 在 integration/generation/chapterWorkbench.test.js。
 * 真瀏覽器（412×915 觸屏）的核對見 media/README.md「觸屏與窄屏」。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 頁面 | 底欄多「正文」「更多」兩顆，是 `data-nav` 不是 `data-tab`；標題欄有「⋯」，沒有從前那顆「編輯器」開關 |
 * | 底欄 | 點「正文」翻上編輯區、不發 switchTab；點側欄的頁籤、「更多」裡挑一頁、編輯器要在檔案頁定位：都先把編輯區收下去；「更多」列檔案 / 歷史 / 日誌 / 設定，日誌有沒看過的錯誤時那一項說出來 |
 * | 標題欄「⋯」 | 先列檔案 / 編輯 / 檢視 / 幫助，點一個換成它的下拉、仍貼著「⋯」，再點「⋯」收起；手機、平板上不列「退出」「開啟日誌目錄」 |
 * | 返回鍵 | 開著幾層就在歷史裡壓幾層（浮窗不算一層）；按返回先收選單、再收編輯區；不是按返回收掉的自己退掉多壓的那條；`nfBack()` 收掉一層回 true、沒什麼可收回 false；寬屏與作者還沒碰過頁面時不壓 |
 * | 軟鍵盤 | 焦點在輸入框裡、可視高度比沒鍵盤時矮了一截：掛 kb-open；高度回來（按返回收了鍵盤）就摘掉；不在輸入框裡不算 |
 * | 編輯區頂上兩行 | 標籤條末尾「儲存」亮滅跟著工具欄那顆、點了就是儲存；「↶」「↷」亮滅跟著這份檔案的撤銷記錄、按下不奪焦點；「⋯」列工具欄的按鈕（不列儲存與麵包屑裡的目錄段），點一項就是點那顆，最後一項「補全名詞」；章節條「操作 ▾」列那一排動作、帶呼叫次數、亮滅照舊，點了發 chapterAction 並收起編輯區（生成在對話頁） |
 * | 觸屏的框 | 手指長按輸入框不彈我們的選單（系統的選字選單），滑鼠右鍵照舊；狀態列「未儲存」不帶（Ctrl+S） |
 * | 不併排 | 窄屏上要開在第二塊的開在主區；「開啟這一章」帶 `beside: false` |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file, sampleChapterIndex, sampleTree, viewState } = require('../../helpers/dom');

const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));
/**
 * 等到 `cond()` 成立（最多 2 秒）。返回鍵那一套是幾個定時器接力（對賬 → history.go → popstate → 再對賬）：機器一忙，接力的頭一棒
 * 晚到，寫死的 20ms 與它同一輪到點、先醒，斷言就跑在接力完之前（CI 上掛過）。要等「變成什麼樣」的一律用它。
 */
async function until(cond, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) {
    await wait(10);
  }
}
const URL = `http://localhost/?project=${encodeURIComponent('/書/青雲劍錄')}`;
const SHIMS = ['clipboard', 'scrollIntoView', 'pointerCapture', 'confirm', 'narrow'];

function phone(scripts = ['view.js', 'editor.js']) {
  const ui = mount({ body: 'standalone', scripts, shims: SHIMS, url: URL });
  ui.post({ type: 'state', state: viewState() });
  return ui;
}

const editorOpen = (ui) => ui.doc.body.classList.contains('editor-open');
const nav = (ui, name) => ui.doc.querySelector(`.tab[data-nav="${name}"]`);
const tab = (ui, name) => ui.doc.querySelector(`.tab[data-tab="${name}"]`);
const depth = (ui) => ui.window.history.state?.nfLayer ?? 0;
const menuItems = (ui) => [...ui.doc.querySelectorAll('.ctx-menu button')].map((b) => b.textContent);
const dropItems = (ui) => [...ui.doc.querySelectorAll('.wb-menu-drop .wb-menu-item .wb-menu-label')].map((n) => n.textContent);
const pickMenu = (ui, label) => ui.clickEl([...ui.doc.querySelectorAll('.ctx-menu button')].find((b) => b.textContent.startsWith(label)));
const pickDrop = (ui, label) =>
  ui.clickEl([...ui.doc.querySelectorAll('.wb-menu-drop .wb-menu-item')].find((b) => b.querySelector('.wb-menu-label')?.textContent === label));

describe('窄屏導航：頁面', { skip: JSDOM_SKIP }, () => {
  test('底欄多「正文」「更多」兩顆，是 data-nav 不是 data-tab；標題欄有「⋯」，沒有「編輯器」開關', () => {
    const ui = phone(['view.js']);
    assert.ok(nav(ui, 'editor') && nav(ui, 'more'));
    assert.equal(nav(ui, 'editor').dataset.tab, undefined);
    assert.equal(nav(ui, 'more').classList.contains('active'), false);
    assert.ok(ui.doc.getElementById('wbMoreBtn'));
    assert.equal(ui.doc.getElementById('wbEditorToggle'), null);
  });
});

describe('窄屏導航：底欄', { skip: JSDOM_SKIP }, () => {
  let ui;
  before(() => {
    ui = phone();
  });

  test('點「正文」：編輯區翻上來，不發 switchTab', () => {
    const before = ui.sent.length;
    ui.clickEl(nav(ui, 'editor'));
    assert.equal(editorOpen(ui), true);
    assert.equal(ui.sent.slice(before).some((m) => m.type === 'switchTab'), false);
  });

  test('點側欄的頁籤：編輯區收下去、切過去', () => {
    ui.clickEl(tab(ui, 'project'));
    assert.equal(editorOpen(ui), false);
    assert.equal(ui.last('switchTab').tab, 'project');
    assert.ok(ui.doc.getElementById('pane-project').classList.contains('active'));
  });

  test('「更多」：列檔案 / 歷史 / 日誌 / 設定；挑一頁切過去、編輯區收下去', () => {
    ui.clickEl(nav(ui, 'editor'));
    ui.clickEl(nav(ui, 'more'));
    assert.deepEqual(menuItems(ui), ['檔案', '歷史', '日誌', '設定']);
    pickMenu(ui, '日誌');
    assert.equal(editorOpen(ui), false);
    assert.equal(ui.last('switchTab').tab, 'logs');
    assert.ok(ui.doc.getElementById('pane-logs').classList.contains('active'));
    assert.equal(ui.doc.querySelector('.ctx-menu'), null);
  });

  test('「更多」：正開著的那一頁打 ✓；日誌有沒看過的錯誤時那一項說出來', () => {
    ui.clickEl(tab(ui, 'chat'));
    ui.doc.getElementById('logsErrorDot').classList.remove('hidden');
    ui.clickEl(nav(ui, 'more'));
    assert.ok(menuItems(ui).includes('日誌（有新的錯誤）'), menuItems(ui).join(' / '));
    ui.closeMenu();
    ui.doc.getElementById('logsErrorDot').classList.add('hidden');
    pickMenuAfterOpen(ui, '設定');
    ui.clickEl(nav(ui, 'more'));
    assert.ok(menuItems(ui).includes('✓ 設定'), menuItems(ui).join(' / '));
    ui.closeMenu();
  });

  test('編輯器要在檔案頁定位（麵包屑的目錄段）：編輯區收下去、切到檔案頁', () => {
    ui.clickEl(nav(ui, 'editor'));
    ui.window.dispatchEvent(new ui.window.CustomEvent('nf-reveal-in-files', { detail: { path: 'chapters' } }));
    assert.equal(editorOpen(ui), false);
    assert.ok(ui.doc.getElementById('pane-files').classList.contains('active'));
  });
});

function pickMenuAfterOpen(ui, label) {
  ui.clickEl(nav(ui, 'more'));
  pickMenu(ui, label);
}

describe('窄屏導航：標題欄「⋯」', { skip: JSDOM_SKIP }, () => {
  test('先列檔案 / 編輯 / 檢視 / 幫助；點一個換成它的下拉，仍貼著「⋯」；再點「⋯」收起', () => {
    const ui = phone(['view.js']);
    const more = ui.doc.getElementById('wbMoreBtn');
    ui.clickEl(more);
    assert.deepEqual(dropItems(ui), ['檔案', '編輯', '檢視', '幫助']);
    assert.ok(more.classList.contains('open'));
    pickDrop(ui, '檔案');
    assert.ok(dropItems(ui).includes('新建檔案'), dropItems(ui).join(' / '));
    assert.equal(ui.doc.querySelectorAll('.wb-menu-drop').length, 1);
    assert.ok(more.classList.contains('open'), '換成「檔案」之後仍貼著「⋯」');
    ui.clickEl(more);
    assert.equal(ui.doc.querySelector('.wb-menu-drop'), null);
    assert.equal(more.classList.contains('open'), false);
  });

  test('手機、平板（主指標不能懸停）上不列「退出」「開啟日誌目錄」；桌面列', () => {
    const ui = phone(['view.js']);
    const more = ui.doc.getElementById('wbMoreBtn');
    const labels = (key) => {
      ui.clickEl(more);
      pickDrop(ui, key);
      const items = dropItems(ui);
      ui.clickEl(more);
      return items;
    };
    assert.ok(labels('檔案').includes('退出'));
    assert.ok(labels('幫助').includes('開啟日誌目錄'));
    ui.window.matchMedia = (q) => ({ matches: /hover:\s*none|max-width:\s*900px/.test(q), addEventListener() {}, removeEventListener() {} });
    assert.equal(labels('檔案').includes('退出'), false);
    assert.equal(labels('幫助').includes('開啟日誌目錄'), false);
  });
});

describe('窄屏導航：返回鍵', { skip: JSDOM_SKIP }, () => {
  test('開著編輯區：歷史裡壓一層；按返回收起編輯區，頁面還在', async () => {
    const ui = phone();
    ui.clickEl(nav(ui, 'editor'));
    await until(() => depth(ui) === 1);
    assert.equal(depth(ui), 1);
    ui.window.history.back();
    await until(() => !editorOpen(ui));
    assert.equal(editorOpen(ui), false);
    assert.equal(depth(ui), 0);
  });

  test('編輯區上再開一個選單：壓兩層；按返回先收選單、編輯區還在，再按才收編輯區', async () => {
    const ui = phone();
    ui.clickEl(nav(ui, 'editor'));
    await until(() => depth(ui) === 1);
    ui.rightClick(ui.doc.getElementById('wbEditor'));
    await until(() => depth(ui) === 2);
    assert.ok(ui.doc.querySelector('.ctx-menu'));
    assert.equal(depth(ui), 2);
    ui.window.history.back();
    await until(() => !ui.doc.querySelector('.ctx-menu') && depth(ui) === 1);
    assert.equal(ui.doc.querySelector('.ctx-menu'), null);
    assert.equal(editorOpen(ui), true);
    ui.window.history.back();
    await until(() => !editorOpen(ui));
    assert.equal(editorOpen(ui), false);
  });

  test('浮窗（細綱速覽、名字的一句話之類）不另算一層：一碰就出、一動就收，窄視窗的桌面上滑鼠劃過就出一個', async () => {
    const ui = phone();
    ui.clickEl(nav(ui, 'editor'));
    await until(() => depth(ui) === 1);
    const tip = ui.doc.createElement('div');
    tip.className = 'summary-tip';
    ui.doc.body.appendChild(tip);
    await wait(50);
    assert.equal(depth(ui), 1);
    tip.remove();
  });

  test('彈窗（存檔點）開著：按返回收彈窗', async () => {
    const ui = phone();
    ui.clickEl(ui.doc.getElementById('wbMoreBtn'));
    pickDrop(ui, '檔案');
    pickDrop(ui, '存檔點…');
    await until(() => depth(ui) === 1);
    assert.ok(ui.doc.querySelector('.modal-overlay:not(.hidden)'));
    assert.equal(depth(ui), 1);
    ui.window.history.back();
    await until(() => !ui.doc.querySelector('.modal-overlay:not(.hidden)'));
    assert.equal(ui.doc.querySelector('.modal-overlay:not(.hidden)'), null);
  });

  test('不是按返回收掉的（點了底欄「工程」）：多壓的那一條自己退掉', async () => {
    const ui = phone();
    ui.clickEl(nav(ui, 'editor'));
    await until(() => depth(ui) === 1);
    assert.equal(depth(ui), 1);
    ui.clickEl(tab(ui, 'project'));
    await until(() => depth(ui) === 0);
    assert.equal(depth(ui), 0);
    assert.equal(editorOpen(ui), false);
  });

  test('nfBack()（Android 殼的返回鍵）：收掉一層回 true；什麼都沒開回 false', async () => {
    const ui = phone();
    ui.clickEl(nav(ui, 'editor'));
    await until(() => depth(ui) === 1);
    assert.equal(ui.window.nfBack(), true);
    assert.equal(editorOpen(ui), false);
    assert.equal(ui.window.nfBack(), false);
  });

  test('寬屏：不壓（編輯區常駐，返回鍵照瀏覽器原來的意思）', async () => {
    const ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: ['clipboard', 'scrollIntoView', 'pointerCapture', 'confirm'], url: URL });
    ui.post({ type: 'state', state: viewState() });
    ui.rightClick(ui.doc.getElementById('wbEditor'));
    await wait(50);
    assert.ok(ui.doc.querySelector('.ctx-menu'));
    assert.equal(depth(ui), 0);
  });

  test('作者還沒碰過頁面：不壓（Chromium 會跳過這種條目，按返回直接離開頁面）', async () => {
    const ui = phone();
    Object.defineProperty(ui.window.navigator, 'userActivation', { configurable: true, value: { hasBeenActive: false } });
    ui.doc.body.classList.add('editor-open');
    await wait(50);
    assert.equal(depth(ui), 0);
  });
});

describe('窄屏導航：軟鍵盤彈著時底欄讓位', { skip: JSDOM_SKIP }, () => {
  test('焦點在輸入框裡、可視高度矮了一截：掛 kb-open；高度回來就摘掉；焦點不在輸入框裡不算', () => {
    const ui = phone(['view.js']);
    let height = 900;
    Object.defineProperty(ui.window, 'innerHeight', { configurable: true, get: () => height });
    const resize = () => ui.window.dispatchEvent(new ui.window.Event('resize'));
    resize();
    const input = ui.doc.getElementById('input');
    input.focus();
    height = 520;
    resize();
    assert.equal(ui.doc.body.classList.contains('kb-open'), true);
    height = 900;
    resize();
    assert.equal(ui.doc.body.classList.contains('kb-open'), false);
    input.blur();
    height = 520;
    resize();
    assert.equal(ui.doc.body.classList.contains('kb-open'), false);
  });
});

describe('窄屏：編輯區頂上兩行', { skip: JSDOM_SKIP }, () => {
  let ui;
  const bar = () => ui.doc.getElementById('edChapterBar');
  const save = () => ui.doc.querySelector('#edTabs .ed-tabs-save');
  const tools = () => ui.doc.querySelector('#edTabs .ed-tabs-tools');
  before(() => {
    ui = phone();
    ui.post({ type: 'chapterIndex', chapters: sampleChapterIndex() });
    // 帶上稱呼：麵包屑的「正文」那一段才是按鈕（點了在檔案頁定位），「⋯」裡不該有它。
    const label = { tag: '', title: '002-入鎮', crumbs: [{ label: '正文', dir: 'chapters' }, { label: '第 2 章 入鎮' }] };
    ui.post({ type: 'editorOpen', file: file('chapters/002-入鎮.md', '# 入鎮\n\n正文', { kind: 'chapter', label }) });
  });

  test('標籤條末尾「儲存」「⋯」；「儲存」亮滅跟著工具欄那顆，點了就是儲存', async () => {
    assert.ok(save() && tools());
    assert.equal(save().disabled, true);
    const area = ui.doc.getElementById('edArea');
    area.value = '# 入鎮\n\n正文，改了';
    area.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    await wait();
    assert.equal(save().disabled, false);
    ui.clickEl(save());
    assert.equal(ui.last('saveFile').text, '# 入鎮\n\n正文，改了');
  });

  test('「↶」「↷」：改了一筆之後「↶」亮，點了撤回去、「↷」亮，再點做回來；按下去不奪焦點（打字時軟鍵盤不收）', async () => {
    const undo = ui.doc.querySelector('#edTabs .ed-tabs-undo');
    const redo = ui.doc.querySelector('#edTabs .ed-tabs-redo');
    const area = ui.doc.getElementById('edArea');
    assert.equal(undo.disabled, false, '上一條改過一筆');
    assert.equal(redo.disabled, true);
    const down = new ui.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    undo.dispatchEvent(down);
    assert.equal(down.defaultPrevented, true);
    ui.clickEl(undo);
    await wait();
    assert.equal(area.value, '# 入鎮\n\n正文');
    assert.equal(redo.disabled, false);
    ui.clickEl(redo);
    await wait();
    assert.equal(area.value, '# 入鎮\n\n正文，改了');
    assert.equal(redo.disabled, true);
  });

  test('「⋯」列工具欄的按鈕：不列「儲存」，不列麵包屑裡的目錄段；點一項就是點那顆', () => {
    ui.clickEl(tools());
    const items = menuItems(ui);
    assert.ok(items.includes('預覽') && items.includes('還原'), items.join(' / '));
    assert.equal(items.includes('儲存'), false);
    const crumbs = [...ui.doc.querySelectorAll('#edPath button')].map((b) => b.textContent);
    assert.ok(crumbs.length > 0, '麵包屑裡沒有目錄段，這一條測不到');
    for (const c of crumbs) {
      assert.equal(items.includes(c), false, `麵包屑的「${c}」混進了選單`);
    }
    pickMenu(ui, '預覽');
    assert.equal(ui.doc.getElementById('edPreview').classList.contains('hidden'), false);
    ui.clickEl(tools());
    pickMenu(ui, '編輯');
  });

  test('「⋯」最後一項「補全名詞」：與 Alt+/、「檢視 → 名詞補全」同一條路', () => {
    ui.clickEl(tools());
    assert.equal(menuItems(ui).at(-1), '補全名詞');
    const got = [];
    ui.window.addEventListener('nf-names-command', (e) => got.push(e.detail.name), { once: true });
    pickMenu(ui, '補全名詞');
    assert.deepEqual(got, ['trigger']);
  });

  test('章節條「操作 ▾」：列那一排動作、帶呼叫次數、亮滅照舊；上一章 / 下一章的字還在（窄屏只是藏起來）', () => {
    const menuBtn = bar().querySelector('.ed-chapter-menu');
    assert.ok(menuBtn);
    assert.equal(bar().querySelector('[data-nav="prev"]').textContent, '‹ 上一章');
    ui.clickEl(menuBtn);
    const buttons = [...ui.doc.querySelectorAll('.ctx-menu button')];
    const write = buttons.find((b) => b.textContent.startsWith('寫這一章'));
    const cont = buttons.find((b) => b.textContent.startsWith('接著寫'));
    assert.match(cont.textContent, /^接著寫（預計 1–2 次呼叫）$/);
    assert.equal(write.disabled, true);
    assert.equal(cont.disabled, false);
    ui.closeMenu();
  });

  test('點「接著寫」：發 chapterAction，編輯區收下去（生成在對話頁）', () => {
    ui.clickEl(nav(ui, 'editor'));
    ui.clickEl(bar().querySelector('.ed-chapter-menu'));
    pickMenu(ui, '接著寫');
    assert.equal(ui.last('chapterAction').action, 'continue');
    assert.equal(editorOpen(ui), false);
  });

  test('窄屏上要開在第二塊的（並排的細綱、草稿）：開在主區，成了另一個標籤', () => {
    ui.post({ type: 'editorOpen', pane: 'draft', file: file('.novelwarden/summaries/002-入鎮.md', '# 細綱', { kind: 'plot' }) });
    assert.equal(ui.doc.querySelector('.wb-editor-draft'), null, '不該造出第二塊');
    const tabs = [...ui.doc.querySelectorAll('#edTabs .ed-tab')].map((t) => t.textContent);
    assert.equal(tabs.length, 2, tabs.join(' / '));
  });
});

describe('觸屏：能打字的框裡長按走系統選單；狀態列不提 Ctrl+S', { skip: JSDOM_SKIP }, () => {
  test('手指長按對話輸入框：不彈我們的選單、不攔預設動作；滑鼠右鍵照舊是我們的選單', () => {
    const ui = phone(['view.js']);
    const input = ui.doc.getElementById('input');
    input.dispatchEvent(new ui.window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    const ev = new ui.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 });
    input.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, false);
    assert.equal(ui.doc.querySelector('.ctx-menu'), null);
    input.dispatchEvent(new ui.window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
    assert.ok(ui.rightClick(input));
  });

  test('手機、平板上狀態列寫「● 未儲存」，不帶（Ctrl+S）；桌面帶', async () => {
    const ui = phone();
    ui.post({ type: 'editorOpen', file: file('chapters/001-楔子.md', '第一章', { kind: 'chapter' }) });
    const area = ui.doc.getElementById('edArea');
    const state = () => ui.doc.getElementById('edStatusSave').textContent;
    area.value = '第一章，改了';
    area.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    await wait();
    assert.equal(state(), '● 未儲存（Ctrl+S）');
    ui.window.matchMedia = (q) => ({ matches: /hover:\s*none|max-width:\s*900px/.test(q), addEventListener() {}, removeEventListener() {} });
    area.value = '第一章，又改了';
    area.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    await wait();
    assert.equal(state(), '● 未儲存');
  });
});

describe('窄屏：「開啟這一章」不要並排的那一份', { skip: JSDOM_SKIP }, () => {
  test('工程頁點章節名：openChapter 帶 beside: false；寬屏不帶', () => {
    const label = (ui) =>
      [...ui.doc.querySelectorAll('#projectBody .row-plot:not(.row-architecture) .row-label')].find((l) => l.textContent.includes('夜訪'));
    const narrowUi = phone(['view.js']);
    narrowUi.post({ type: 'project', tree: sampleTree() });
    narrowUi.clickEl(label(narrowUi));
    assert.equal(narrowUi.last('openChapter').beside, false);

    const wideUi = mount({ body: 'standalone', scripts: ['view.js'], url: URL });
    wideUi.post({ type: 'state', state: viewState() });
    wideUi.post({ type: 'project', tree: sampleTree() });
    wideUi.clickEl(label(wideUi));
    assert.equal('beside' in wideUi.last('openChapter'), false);
  });
});
