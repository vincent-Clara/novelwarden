/**
 * 名詞高亮與懸停浮窗（獨立版內建編輯器，`media/src/editor/nameMarks.ts`；認哪幾段是名字的口徑在
 * tests/unit/editor/namesCore.test.js，映象層分塊在 find.test.js，真瀏覽器裡對得齊、量得準的核對見檔案末尾說明）。
 *
 * jsdom 沒有排版：圖層只測 DOM（`<mark>` 的字與 class）；浮窗與 Ctrl+點選要「滑鼠底下是哪個字」，這裡給映象層裝一份
 * 假排版（一行一塊、每塊 20px 高，每個字 10px 寬），按格子座標指字。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 名詞圖層 | 開啟正文就要名詞表；表到了角色 / 設定 / 未建條目三種 class；打出一個名字同一輪裡標上；撤銷跟著；角色卡裡不標它自己；配置檔案不畫；與體檢疊在同一段字上兩層 class 都在 |
 * | 浮窗 | 停夠 400ms 才彈：名字、型別、別名命中寫「這裡寫的是」、一句話、底下那一行；沒停夠就移開不彈；移到別處、打字、換檔案就收起；拖選區時不彈 |
 * | Ctrl+點選 | 角色名、設定名在這一塊開啟卡或條目（按下被攔下）；未建條目說一句；不按 Ctrl 照常放游標；按住 Ctrl 指著能開啟的名字時手形 |
 * | 觸屏 | 手指點名字當場彈浮窗（底下一顆「開啟角色卡」，按下不奪焦點），補發的相容滑鼠事件不當懸停，點別的字收起；軟鍵盤彈著（正在打字）時點名字不彈；手指長按正文走系統的選字選單，滑鼠右鍵名字選單最前面「開啟「林昭」的角色卡」 |
 * | 「檢視 → 名詞高亮」 | 預設開；關掉清圖層、不彈浮窗、記進偏好且不沖掉別的；再開重畫、刪掉那一項；重新整理之後照舊關著、也不去要名詞表 |
 * | 樣式 | names 圖層只碰底色與下劃線（不佔排版），與體檢一樣重且排在它前面；三套主題都給了三個顏色 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mount, JSDOM_SKIP, file } = require('../../helpers/dom');
const { ROOT } = require('../../helpers/load');

const SHIMS = ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'];
const URL = `http://localhost/?project=${encodeURIComponent('/書/青雲劍錄')}`;
const PREFS_KEY = 'novelforge.editor.prefs';
const CH = 'chapters/001-楔子.md';
const CARD = '.novelwarden/characters/林昭.md';
/** 等微任務跑完（圖層在微任務裡重算）。 */
const flush = () => new Promise((resolve) => setImmediate(resolve));
/** 等一幀多（滑鼠在下一幀量；jsdom 沒有 rAF，退回 16ms 定時器）。 */
const frames = () => new Promise((resolve) => setTimeout(resolve, 60));
/** 停夠了（400ms）再多一點。 */
const dwell = () => new Promise((resolve) => setTimeout(resolve, 520));

const NAMES = {
  initialized: true,
  names: [
    { name: '林昭', aliases: ['阿昭'], source: 'character', category: '', brief: '青雲宗外門弟子。', path: CARD },
    { name: '林昭陽', aliases: [], source: 'character', category: '', brief: '', path: '.novelwarden/characters/林昭陽.md' },
    { name: '沈懷山', aliases: [], source: 'character', category: '', brief: '', path: '.novelwarden/characters/沈懷山.md' },
    { name: '青雲宗', aliases: ['青雲門'], source: 'lore', category: '門派', brief: '正道第一大宗', path: '.novelwarden/lore/門派/青雲宗.md' },
    { name: '青崖鎮', aliases: [], source: 'lore', category: '地點', brief: '', path: '.novelwarden/lore/地點/青崖鎮.md' },
    { name: '黑水河', aliases: [], source: 'unfiled', category: '地點', brief: '河上起了霧' },
  ],
};

/**
 * 給高亮映象層（不含量位置用的那一份）一份假排版：映象框 2000×2000；第 i 塊佔 y ∈ [20i, 20i+20)；塊裡第 k 個字佔
 * x ∈ [10k, 10k+10)。`at(行, 列)` 給那個字中間的視口座標。
 */
function fakeLayout(ui) {
  const proto = ui.window.Element.prototype;
  const rect0 = proto.getBoundingClientRect;
  const rects0 = proto.getClientRects;
  const LINE = 20;
  const CHAR = 10;
  const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
  const layoutOf = (node) => {
    if (!node.closest?.('.ed-mirror:not(.ed-mirror-probe)')) {
      return undefined;
    }
    if (node.classList.contains('ed-mirror')) {
      return box(0, 0, 2000, 2000);
    }
    const content = node.closest('.ed-mirror-content');
    if (node.parentElement === content) {
      return box(0, [...content.children].indexOf(node) * LINE, 2000, LINE);
    }
    if (node.tagName === 'MARK') {
      const block = node.parentElement;
      let offset = 0;
      for (const n of block.childNodes) {
        if (n === node) {
          break;
        }
        offset += n.textContent.length;
      }
      return box(offset * CHAR, [...content.children].indexOf(block) * LINE, node.textContent.length * CHAR, LINE);
    }
    return undefined;
  };
  proto.getBoundingClientRect = function () {
    return layoutOf(this) ?? rect0.call(this);
  };
  proto.getClientRects = function () {
    const r = layoutOf(this);
    return r ? [r] : rects0.call(this);
  };
  return (line, col) => ({ clientX: col * CHAR + CHAR / 2, clientY: line * LINE + LINE / 2 });
}

function harness(opts = {}) {
  const ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: SHIMS, url: URL, ...opts });
  const toasts = [];
  ui.window.__nfToast = (m) => toasts.push(m);
  ui.doc.execCommand = () => true;
  const area = () => ui.doc.getElementById('edArea');
  const h = {
    ui,
    toasts,
    area,
    open(p, text, kind = 'chapter') {
      ui.post({ type: 'editorOpen', file: file(p, text, kind ? { kind } : undefined) });
      const a = area();
      a.setSelectionRange(a.value.length, a.value.length);
    },
    /** 回最近那一次名詞表請求。 */
    serve(index = NAMES, sig = 's1') {
      const req = ui.last('requestNameIndex');
      assert.ok(req, '應該發過 requestNameIndex');
      ui.post({ type: 'nameIndex', requestId: req.requestId, sig, ...(index ? { index } : {}) });
    },
    /** names 圖層上畫著的：[字, 來源]。 */
    marks: () =>
      [...ui.doc.querySelectorAll('#wbEditor .ed-mirror:not(.ed-mirror-probe) mark')]
        .map((m) => [m.textContent, [...m.classList].find((c) => c.startsWith('ed-hl-name-'))])
        .filter(([, cls]) => cls)
        .map(([t, cls]) => [t, cls.replace('ed-hl-name-', '')]),
    /** 在游標處打幾個字（一下一個字）。 */
    type(text) {
      for (const ch of text) {
        const a = area();
        const s = a.selectionStart;
        a.value = a.value.slice(0, s) + ch + a.value.slice(a.selectionEnd);
        a.setSelectionRange(s + 1, s + 1);
        a.dispatchEvent(new ui.window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
      }
    },
    key(init, target = area()) {
      const ev = new ui.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(ev);
      return ev;
    },
    mouse(type, point, init = {}) {
      const ev = new ui.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...point, ...init });
      area().dispatchEvent(ev);
      return ev;
    },
    tip: () => ui.doc.querySelector('.nm-tip'),
    tipText: (cls) => h.tip()?.querySelector(`.${cls}`)?.textContent,
    count: (type) => ui.sent.filter((m) => m.type === type).length,
  };
  return h;
}

describe('名詞高亮：names 圖層', { skip: JSDOM_SKIP }, () => {
  let h;
  before(async () => {
    h = harness();
    h.open(CH, '阿昭走進青雲門，沈懷山在黑水河邊等他。\n林昭陽看著林昭。');
  });

  test('開啟一章正文就去要名詞表；表到之前什麼都不畫', () => {
    assert.ok(h.ui.last('requestNameIndex'));
    assert.deepEqual(h.marks(), []);
  });

  test('表到了：角色、設定、未建條目三種 class；長的名字不被認成短的', async () => {
    h.serve();
    await flush();
    assert.deepEqual(h.marks(), [
      ['阿昭', 'character'],
      ['青雲門', 'lore'],
      ['沈懷山', 'character'],
      ['黑水河', 'unfiled'],
      ['林昭陽', 'character'],
      ['林昭', 'character'],
    ]);
  });

  test('打出一個名字：同一輪裡標上；撤銷之後跟著拿掉', async () => {
    h.type('青崖鎮');
    await flush();
    assert.deepEqual(h.marks().at(-1), ['青崖鎮', 'lore']);
    h.key({ key: 'z', ctrlKey: true });
    await flush();
    await frames();
    assert.equal(h.marks().some(([t]) => t === '青崖鎮'), false);
    assert.equal(h.marks().length, 6);
  });

  test('角色卡自己那一份裡不標它自己（別名也不標），別的照標', async () => {
    h.open(CARD, '林昭，外號阿昭，青雲宗弟子。', 'character');
    await flush();
    assert.deepEqual(h.marks(), [['青雲宗', 'lore']]);
  });

  test('配置這類檔案不畫', async () => {
    h.open('.novelwarden/config.md', '主角林昭。', 'setting');
    await flush();
    assert.deepEqual(h.marks(), []);
  });

  test('與寫作體檢疊在同一段字上：兩層的 class 都在那一段上', async () => {
    h.ui.post({
      type: 'checkTerms',
      terms: { banned: ['青雲門'], sensitive: [], sensitivePath: '.novelwarden/sensitive.txt', sensitiveExists: false, sensitiveBad: [] },
    });
    h.open('chapters/002-下山.md', '他回到青雲門。');
    await flush();
    const mark = [...h.ui.doc.querySelectorAll('#wbEditor .ed-mirror:not(.ed-mirror-probe) mark')].find((m) => m.textContent === '青雲門');
    assert.ok(mark.classList.contains('ed-hl-name-lore'));
    assert.ok(mark.classList.contains('ed-hl-chk-banned'));
  });
});

describe('名詞高亮：懸停浮窗與 Ctrl+點選', { skip: JSDOM_SKIP }, () => {
  let h;
  let at;
  before(async () => {
    h = harness();
    at = fakeLayout(h.ui);
    h.open(CH, '阿昭走進青雲門。\n黑水河邊。');
    h.serve();
    await flush();
  });

  test('停在名字上夠 400ms：浮窗寫正名、型別、別名命中、一句話、Ctrl+點選開啟什麼', async () => {
    h.mouse('mousemove', at(0, 1));
    await frames();
    assert.equal(h.tip(), null, '沒停夠不彈');
    await dwell();
    assert.ok(h.tip());
    assert.equal(h.tip().parentElement, h.ui.doc.body);
    assert.equal(h.tipText('nm-name'), '林昭');
    assert.equal(h.tipText('nm-badge'), '角色');
    assert.equal(h.tipText('nm-alias'), '這裡寫的是「阿昭」');
    assert.equal(h.tipText('nm-brief'), '青雲宗外門弟子。');
    assert.equal(h.tipText('nm-foot'), 'Ctrl+點選開啟角色卡');
  });

  test('在同一個名字裡挪：不閃；移到沒有名字的字上：收起', async () => {
    h.mouse('mousemove', at(0, 0));
    await frames();
    assert.ok(h.tip());
    h.mouse('mousemove', at(0, 3));
    await frames();
    assert.equal(h.tip(), null);
  });

  test('設定：分類做型別，關鍵詞命中也寫「這裡寫的是」，底下說開啟設定條目', async () => {
    h.mouse('mousemove', at(0, 5));
    await frames();
    await dwell();
    assert.equal(h.tipText('nm-name'), '青雲宗');
    assert.equal(h.tipText('nm-badge'), '門派');
    assert.equal(h.tipText('nm-alias'), '這裡寫的是「青雲門」');
    assert.equal(h.tipText('nm-brief'), '正道第一大宗');
    assert.equal(h.tipText('nm-foot'), 'Ctrl+點選開啟設定條目');
  });

  test('打字收起（光按 Ctrl 不算）', () => {
    assert.ok(h.tip());
    h.key({ key: 'Control', ctrlKey: true });
    assert.ok(h.tip());
    h.key({ key: 'a' });
    assert.equal(h.tip(), null);
  });

  test('未建條目：型別帶「未建條目」，底下說還沒建條目', async () => {
    h.mouse('mousemove', at(1, 0));
    await frames();
    await dwell();
    assert.equal(h.tipText('nm-name'), '黑水河');
    assert.equal(h.tipText('nm-badge'), '地點 · 未建條目');
    assert.equal(h.tipText('nm-brief'), '河上起了霧');
    assert.equal(h.tipText('nm-foot'), '設定名錄裡出現過，還沒建條目');
  });

  test('移出編輯區：收起', () => {
    h.mouse('mouseleave', at(1, 0));
    assert.equal(h.tip(), null);
  });

  test('沒停夠就移開：不彈', async () => {
    h.mouse('mousemove', at(0, 0));
    await frames();
    h.mouse('mousemove', at(0, 3));
    await dwell();
    assert.equal(h.tip(), null);
  });

  test('按著滑鼠拖選區時不彈', async () => {
    h.mouse('mousemove', at(0, 0), { buttons: 1 });
    await frames();
    await dwell();
    assert.equal(h.tip(), null);
  });

  test('按住 Ctrl 指著能開啟的名字：手形；鬆開、指著未建條目：不是', async () => {
    h.mouse('mousemove', at(0, 0), { ctrlKey: true });
    await frames();
    assert.equal(h.area().classList.contains('nm-link'), true);
    h.mouse('mousemove', at(0, 0));
    await frames();
    assert.equal(h.area().classList.contains('nm-link'), false);
    h.mouse('mousemove', at(1, 0), { ctrlKey: true });
    await frames();
    assert.equal(h.area().classList.contains('nm-link'), false);
  });

  test('Ctrl+點選角色名：在這一塊開啟角色卡，按下被攔下（不挪游標）', () => {
    const ev = h.mouse('mousedown', at(0, 0), { ctrlKey: true });
    assert.equal(ev.defaultPrevented, true);
    const msg = h.ui.last('openEditor');
    assert.deepEqual([msg.path, msg.pane, 'preview' in msg], [CARD, 'main', false]);
  });

  test('Ctrl+點選設定名：開啟設定條目', () => {
    h.mouse('mousedown', at(0, 4), { ctrlKey: true });
    assert.equal(h.ui.last('openEditor').path, '.novelwarden/lore/門派/青雲宗.md');
  });

  test('Ctrl+點選未建條目：說一句，不開啟', () => {
    const before = h.count('openEditor');
    const ev = h.mouse('mousedown', at(1, 1), { ctrlKey: true });
    assert.equal(ev.defaultPrevented, true);
    assert.equal(h.count('openEditor'), before);
    assert.match(h.toasts.at(-1), /「黑水河」還沒建條目/);
  });

  test('不按 Ctrl 點名字、Ctrl+點別的字：照常（不攔、不開啟）', () => {
    const before = h.count('openEditor');
    assert.equal(h.mouse('mousedown', at(0, 0)).defaultPrevented, false);
    assert.equal(h.mouse('mousedown', at(0, 3), { ctrlKey: true }).defaultPrevented, false);
    assert.equal(h.count('openEditor'), before);
  });

  test('換了檔案：浮窗收起', async () => {
    h.mouse('mousemove', at(0, 0));
    await frames();
    await dwell();
    assert.ok(h.tip());
    h.open('chapters/002-別處.md', '這裡什麼都沒有。');
    assert.equal(h.tip(), null);
  });
});

describe('名詞高亮：觸屏（手指點名字、浮窗上的「開啟」）', { skip: JSDOM_SKIP }, () => {
  let h;
  let at;
  /** 手指點一下：先一下手指的 pointerdown，再是 Chromium 補發的相容 mousemove / mousedown / click。 */
  const tap = (point) => {
    h.area().dispatchEvent(new h.ui.window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', ...point }));
    h.mouse('mousemove', point);
    h.mouse('mousedown', point);
    h.mouse('click', point);
  };
  before(async () => {
    h = harness();
    at = fakeLayout(h.ui);
    h.open(CH, '阿昭走進青雲門。\n黑水河邊。');
    h.serve();
    await flush();
  });

  test('手指點在名字上：當場彈浮窗（不等懸停），底下一顆「開啟角色卡」；點名字本身不開啟卡片', async () => {
    const before = h.count('openEditor');
    tap(at(0, 1));
    assert.ok(h.tip());
    assert.equal(h.tipText('nm-name'), '林昭');
    assert.equal(h.tipText('nm-open'), '開啟角色卡');
    assert.equal(h.count('openEditor'), before);
    // 補發的相容 mousemove 不當懸停：過了懸停延遲也不另彈、不收
    await dwell();
    assert.equal(h.tipText('nm-name'), '林昭');
  });

  test('浮窗上的「開啟角色卡」：按下去不奪焦點（正文區一失焦浮窗就收了），點了在這一塊開啟、收起浮窗', () => {
    const btn = h.tip().querySelector('.nm-open');
    const down = new h.ui.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    btn.dispatchEvent(down);
    assert.equal(down.defaultPrevented, true);
    h.ui.clickEl(btn);
    const msg = h.ui.last('openEditor');
    assert.deepEqual([msg.path, msg.pane], [CARD, 'main']);
    assert.equal(h.tip(), null);
  });

  test('手指點別的字：收起；點未建條目：說它還沒建條目', () => {
    tap(at(0, 3));
    assert.equal(h.tip(), null);
    tap(at(1, 1));
    assert.equal(h.tipText('nm-foot'), '設定名錄裡出現過，還沒建條目');
  });

  test('軟鍵盤彈著（正在打字）時點名字：不彈（是在挪游標）', () => {
    h.ui.doc.body.classList.add('kb-open');
    tap(at(0, 1));
    assert.equal(h.tip(), null);
    h.ui.doc.body.classList.remove('kb-open');
  });

  test('手指長按正文：不彈我們的選單（系統的選字選單貼在選區上方、不擋把手）', () => {
    const point = at(0, 0);
    h.area().dispatchEvent(new h.ui.window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', ...point }));
    const ev = new h.ui.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, ...point });
    h.area().dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, false);
    assert.equal(h.ui.doc.querySelector('.ctx-menu'), null);
  });

  test('滑鼠右鍵名字：選單最前面「開啟「林昭」的角色卡」，點了在這一塊開啟；不是名字、未建條目不給', () => {
    h.area().dispatchEvent(new h.ui.window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', ...at(0, 0) }));
    let menu = h.ui.rightClick(h.area(), at(0, 0).clientX, at(0, 0).clientY);
    assert.deepEqual(h.ui.itemsOf(menu).slice(0, 2), ['開啟「林昭」的角色卡', '剪下']);
    h.ui.pick(menu, '開啟「林昭」的角色卡');
    const msg = h.ui.last('openEditor');
    assert.deepEqual([msg.path, msg.pane], [CARD, 'main']);
    menu = h.ui.rightClick(h.area(), at(0, 4).clientX, at(0, 4).clientY);
    assert.equal(h.ui.itemsOf(menu)[0], '開啟「青雲宗」的設定條目');
    h.ui.closeMenu();
    menu = h.ui.rightClick(h.area(), at(0, 3).clientX, at(0, 3).clientY);
    assert.equal(h.ui.itemsOf(menu)[0], '剪下');
    h.ui.closeMenu();
    menu = h.ui.rightClick(h.area(), at(1, 1).clientX, at(1, 1).clientY);
    assert.equal(h.ui.itemsOf(menu)[0], '剪下');
    h.ui.closeMenu();
  });
});

describe('「檢視 → 名詞高亮」', { skip: JSDOM_SKIP }, () => {
  let h;
  let at;
  const viewMenu = () => {
    h.ui.closeMenu();
    h.ui.clickEl(h.ui.doc.querySelector('[data-menu="view"]'));
    return h.ui.doc.querySelector('.wb-menu-drop');
  };
  const item = (label) =>
    [...viewMenu().querySelectorAll('.wb-menu-item')].find((b) => b.querySelector('.wb-menu-label').textContent === label);
  const storedPrefs = () => JSON.parse(h.ui.window.localStorage.getItem(PREFS_KEY));

  before(async () => {
    h = harness({ storage: { [PREFS_KEY]: JSON.stringify({ autoPair: false }) } });
    at = fakeLayout(h.ui);
    h.open(CH, '阿昭走進青雲門。');
    h.serve();
    await flush();
  });

  test('預設開：打 ✓，緊跟在「邊打邊彈名詞補全」後面，說明裡寫 Ctrl+點選', () => {
    const it = item('名詞高亮');
    assert.ok(it);
    assert.equal(it.getAttribute('aria-checked'), 'true');
    assert.equal(it.previousElementSibling.querySelector('.wb-menu-label').textContent, '邊打邊彈名詞補全');
    assert.match(it.title, /Ctrl\+點選/);
    h.ui.closeMenu();
  });

  test('關掉：圖層清掉，記進偏好且不沖掉別的；指著名字也不彈', async () => {
    assert.equal(h.marks().length, 2);
    h.ui.clickEl(item('名詞高亮'));
    h.ui.closeMenu();
    assert.deepEqual(h.marks(), []);
    assert.equal(storedPrefs().nameHighlight, false);
    assert.equal(storedPrefs().autoPair, false);
    h.mouse('mousemove', at(0, 0));
    await frames();
    await dwell();
    assert.equal(h.tip(), null);
  });

  test('再開啟：重畫，偏好裡刪掉那一項', async () => {
    h.ui.clickEl(item('名詞高亮'));
    h.ui.closeMenu();
    await flush();
    assert.equal(h.marks().length, 2);
    assert.equal('nameHighlight' in storedPrefs(), false);
    assert.equal(storedPrefs().autoPair, false);
  });

  test('重新整理之後照舊關著：不畫，也不去要名詞表', async () => {
    const again = harness({ storage: { [PREFS_KEY]: JSON.stringify({ nameHighlight: false }) } });
    again.open(CH, '阿昭走進青雲門。');
    await flush();
    assert.equal(again.count('requestNameIndex'), 0);
    assert.deepEqual(again.marks(), []);
  });
});

describe('名詞高亮：樣式', { skip: JSDOM_SKIP }, () => {
  const css = () => fs.readFileSync(path.join(ROOT, 'dist', 'media', 'standalone.css'), 'utf8');

  test('names 圖層只碰底色與下劃線（不佔排版、不改字色），選擇器與體檢一樣重、排在體檢前面', () => {
    const text = css();
    const rules = [...text.matchAll(/([^{}]*ed-hl-name-[^{}]*)\{([^}]*)\}/g)];
    assert.equal(rules.length, 3);
    for (const [, selector, body] of rules) {
      assert.match(selector.trim(), /^:where\(\.ed-mirror\) mark\.ed-hl-name-\w+$/);
      assert.doesNotMatch(body, /(^|[;\s])(padding|margin|border|font-weight|color)\s*:/);
      assert.match(body, /(background|text-decoration):/);
    }
    assert.ok(text.indexOf('ed-hl-name-character') < text.indexOf('ed-hl-chk-sensitive'), 'names 排在 check 前面');
  });

  test('深 / 淺 / 護眼三套主題都給了名詞高亮的三個顏色', () => {
    const h = harness();
    const style = h.ui.doc.createElement('style');
    style.textContent = css();
    h.ui.doc.head.appendChild(style);
    const isTheme = (sel, theme) => /^:root\[data-theme=['"]?(\w+)['"]?\]$/.exec(sel.trim())?.[1] === theme;
    const vars = (theme) =>
      [...style.sheet.cssRules]
        .filter((r) => r.selectorText && r.selectorText.split(',').some((sel) => isTheme(sel, theme)))
        .flatMap((r) => [...r.style].filter((n) => n.startsWith('--nf-name-')))
        .sort();
    for (const theme of ['dark', 'light', 'sepia']) {
      assert.deepEqual(vars(theme), ['--nf-name-character-bg', '--nf-name-lore-bg', '--nf-name-unfiled'], theme);
    }
  });
});
