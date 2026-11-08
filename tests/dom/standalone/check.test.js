/**
 * 寫作體檢（獨立版內建編輯器，`media/src/editor/check.ts` / `checkPanel.ts`，「檢視 → 體檢」在 `view/checkMenu.ts`）。
 * 口徑（四類怎麼認、比喻詞超限、英文大小寫、與生成鏈對拍）在 tests/unit/editor/checkCore.test.js 釘著，這裡釘整條鏈路
 * （jsdom 沒有排版，映象層測 DOM 內容不測畫素）：
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 只看正文 | 章節、草稿上畫 `check` 圖層，角色卡、敏感詞表本身、沒給 `kind` 的不畫、狀態列那一格藏起來；詞表換了當場重畫 |
 * | 與別的圖層共存 | 查詢、段落聚焦開著時三層的 class 落在同一段字上，收起查詢體檢照舊；樣式不碰排版、比查詢低一級，三套主題都有顏色 |
 * | 打字 | 改了字之後同一輪裡重查（新詞標上、舊的挪到新位置）；輸入法組字中途不重查、不亂跳，上屏之後再查 |
 * | 狀態列與面板 | 「體檢 N」「體檢 ✓」、懸停提示；點開按類別列詞與次數，Esc / 點外面 / 再點一下收起，按下滑鼠不奪焦點 |
 * | 點詞跳轉 | 依次跳到每一處並選中、焦點進正文、到底繞回 |
 * | 替換 | 「替換本處」先選中再換、換完選下一處，一步撤銷；「全部替換」一次換完、一步撤銷 |
 * | 「檢視 → 體檢」 | 兩個開關預設開、關掉高亮 / 那一格、記進 `novelforge.editor.prefs` 不沖掉別的、重新整理照舊；「編輯敏感詞表…」 |
 * | 編輯敏感詞表 | 面板裡與選單裡都發 `editSensitiveWords`，後端開啟的那一份進編輯器（不體檢它）；沒開工程置灰 |
 * | 大章節 | 兩萬字以上節流到定時器裡，其間舊的跟著挪；面板上的動作先當場重查 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mount, JSDOM_SKIP, file } = require('../../helpers/dom');
const { ROOT } = require('../../helpers/load');

const SHIMS = ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'];
const PREFS_KEY = 'novelforge.editor.prefs';
const SENSITIVE = '.novelwarden/sensitive.txt';
const CH = 'chapters/003-夜訪.md';
/** 等微任務跑完（體檢在微任務裡重查）。 */
const flush = () => new Promise((resolve) => setImmediate(resolve));
/** 等兩幀（jsdom 沒有 rAF，映象層退回 16ms 定時器）。 */
const frames = () => new Promise((resolve) => setTimeout(resolve, 60));

const TERMS = {
  banned: ['能量', '神經'],
  sensitive: [{ term: '賭博', replacement: '博戲' }, { term: 'SB' }],
  sensitivePath: SENSITIVE,
  sensitiveExists: true,
  sensitiveBad: [],
};
/** 敏感詞「賭博」、敏感詞「SB」（小寫的 sb）、禁用詞「能量」、英文縮寫「PTSD」：四個問題。 */
const TEXT = '林昭賭博輸光了，能量耗盡。\n\nPTSD 又犯了，sb 才信。';

function harness(opts = {}) {
  const { shims = SHIMS, terms = TERMS, ...rest } = opts;
  const ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims, ...rest });
  const toasts = [];
  ui.window.__nfToast = (m) => toasts.push(m);
  ui.doc.execCommand = () => true;
  if (terms) {
    ui.post({ type: 'checkTerms', terms });
  }
  const main = () => ui.doc.getElementById('wbEditor');
  const area = () => ui.doc.getElementById('edArea');
  const h = {
    ui,
    toasts,
    main,
    area,
    open(p, text, extra) {
      ui.post({ type: 'editorOpen', file: file(p, text, extra) });
      const a = area();
      a.setSelectionRange(0, 0);
    },
    /** 映象層裡某一層的 `<mark>`（`cls` 給類名，不給就是 check 那四類）。 */
    marks(cls) {
      const all = [...main().querySelectorAll('.ed-mirror:not(.ed-mirror-probe) mark')];
      return all.filter((m) => (cls ? m.classList.contains(cls) : [...m.classList].some((c) => c.startsWith('ed-hl-chk-'))));
    },
    /** 每一段 check 標記：[字, 類別]。 */
    checkMarks() {
      return h.marks().map((m) => [m.textContent, [...m.classList].filter((c) => c.startsWith('ed-hl-chk-')).map((c) => c.slice(10)).join('+')]);
    },
    cell: () => main().querySelector('.ed-status .ed-check'),
    cellShown: () => !!h.cell() && !h.cell().classList.contains('hidden'),
    panel: () => ui.doc.querySelector('.ed-check-panel'),
    clickCell() {
      ui.clickEl(h.cell());
      return h.panel();
    },
    /** 面板上某個詞那一行。 */
    row(term) {
      return [...(h.panel()?.querySelectorAll('.ed-check-row') ?? [])].find((r) => r.querySelector('.ed-check-term').textContent === term);
    },
    clickWord(term) {
      ui.clickEl(h.row(term).querySelector('.ed-check-word'));
    },
    times: (term) => h.row(term)?.querySelector('.ed-check-times').textContent,
    selected: () => [area().selectionStart, area().selectionEnd],
    /** 在選區處打進去（鍵盤）。 */
    type(text) {
      const a = area();
      const s = a.selectionStart;
      a.value = a.value.slice(0, s) + text + a.value.slice(a.selectionEnd);
      a.setSelectionRange(s + text.length, s + text.length);
      a.dispatchEvent(new ui.window.InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    },
    /** 輸入法：`steps` 是組字中途顯示的拼音，返回上屏 `commit` 的那一下。 */
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
    viewMenu() {
      ui.closeMenu();
      ui.clickEl(ui.doc.querySelector('[data-menu="view"]'));
      return ui.doc.querySelector('.wb-menu-drop');
    },
    menuItem(label) {
      return [...h.viewMenu().querySelectorAll('.wb-menu-item')].find((b) => b.querySelector('.wb-menu-label').textContent === label);
    },
    pickMenu(label) {
      const btn = h.menuItem(label);
      assert.ok(btn, `「檢視」裡沒有「${label}」`);
      ui.clickEl(btn);
      ui.closeMenu();
    },
    storedPrefs: () => JSON.parse(ui.window.localStorage.getItem(PREFS_KEY)),
  };
  return h;
}

describe('寫作體檢：只看正文', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
    h.open(CH, TEXT, { kind: 'chapter' });
  });

  test('章節：四類各自標出來（敏感詞英文不分大小寫）', () => {
    assert.deepEqual(h.checkMarks(), [
      ['賭博', 'sensitive'],
      ['能量', 'banned'],
      ['PTSD', 'acronym'],
      ['sb', 'sensitive'],
    ]);
  });

  test('映象層裡的文字與 textarea 一字不差（標記只是包住那幾個字）', () => {
    const content = h.main().querySelector('.ed-mirror:not(.ed-mirror-probe) .ed-mirror-content');
    assert.equal(content.textContent, TEXT);
  });

  test('狀態列一格「體檢 4」，挨著字數那一格、在 spacer 之前', () => {
    assert.equal(h.cell().textContent, '體檢 4');
    assert.equal(h.cell().classList.contains('has-issues'), true);
    assert.equal(h.cell().previousElementSibling.id, 'edStatusWords');
    assert.equal(h.cell().nextElementSibling.classList.contains('spacer'), true);
  });

  test('懸停提示：各類幾個', () => {
    assert.match(h.cell().title, /敏感詞 2 處 · 禁用詞 1 處 · 英文縮寫 1 處/);
  });

  test('草稿也是正文：照樣查', () => {
    h.open('drafts/003-夜訪.md', '能量。', { kind: 'draft' });
    assert.deepEqual(h.checkMarks(), [['能量', 'banned']]);
    assert.equal(h.cell().textContent, '體檢 1');
  });

  test('角色卡（不是正文）：不畫、那一格藏起來', () => {
    h.open('.novelwarden/characters/林昭.md', TEXT, { kind: 'character' });
    assert.deepEqual(h.checkMarks(), []);
    assert.equal(h.cellShown(), false);
  });

  test('沒給 kind（沒開啟工程）：當非正文', () => {
    h.open('notes.md', TEXT);
    assert.deepEqual(h.checkMarks(), []);
    assert.equal(h.cellShown(), false);
  });

  test('切回章節：當場畫回來', () => {
    h.ui.clickEl([...h.main().querySelectorAll('.ed-tab')].find((t) => t.title.includes(CH) || t.textContent.includes('003-夜訪') && !t.textContent.includes('草稿')));
    assert.equal(h.area().value, TEXT);
    assert.equal(h.checkMarks().length, 4);
    assert.equal(h.cell().textContent, '體檢 4');
  });

  test('沒有問題：「體檢 ✓」', () => {
    h.open('chapters/004.md', '雨停了。', { kind: 'chapter' });
    assert.equal(h.cell().textContent, '體檢 ✓');
    assert.equal(h.cell().classList.contains('has-issues'), false);
  });

  test('比喻詞沒超上限（3 次）：不畫、不算', () => {
    h.open('chapters/005.md', '彷彿、猶如、宛如。', { kind: 'chapter' });
    assert.deepEqual(h.checkMarks(), []);
    assert.equal(h.cell().textContent, '體檢 ✓');
  });

  test('超了：每一處都畫，算超出的那幾個', () => {
    h.open('chapters/006.md', '彷彿、猶如、宛如、如同、好似。', { kind: 'chapter' });
    assert.deepEqual(h.checkMarks().map(([, c]) => c), ['simile', 'simile', 'simile', 'simile', 'simile']);
    assert.equal(h.cell().textContent, '體檢 2');
  });

  test('後端推來新的詞表：當場重查重畫', () => {
    h.open('chapters/007.md', '他的神經繃緊了，剎那間。', { kind: 'chapter' });
    assert.deepEqual(h.checkMarks(), [['神經', 'banned']]);
    h.ui.post({ type: 'checkTerms', terms: { ...TERMS, banned: ['剎那'] } });
    assert.deepEqual(h.checkMarks(), [['剎那', 'banned']]);
    h.ui.post({ type: 'checkTerms', terms: TERMS });
  });
});

describe('寫作體檢：與查詢、段落聚焦同時開著', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
    h.open(CH, TEXT, { kind: 'chapter' });
  });

  test('查詢「能量」：同一段字上既有查詢的 class 也有體檢的', () => {
    h.key({ key: 'f', ctrlKey: true });
    const input = h.main().querySelector('.ed-find-input');
    input.value = '能量';
    input.dispatchEvent(new h.ui.window.Event('input', { bubbles: true }));
    const both = h.marks('ed-hl-find-current');
    assert.equal(both.length, 1);
    assert.equal(both[0].textContent, '能量');
    assert.equal(both[0].classList.contains('ed-hl-chk-banned'), true);
    // 別的體檢標記不受影響。
    assert.equal(h.checkMarks().length, 4);
    h.key({ key: 'Escape' }, input);
  });

  test('收起查詢：查詢的標記沒了，體檢的照舊', () => {
    assert.equal(h.marks('ed-hl-find').length + h.marks('ed-hl-find-current').length, 0);
    assert.equal(h.checkMarks().length, 4);
  });

  test('段落聚焦：focus 圖層與 check 圖層落在同一段字上', () => {
    const a = h.area();
    a.focus();
    a.setSelectionRange(3, 3);
    h.pickMenu('段落聚焦');
    const inFocus = h.marks('ed-hl-focus');
    assert.equal(inFocus.map((m) => m.textContent).join(''), '林昭賭博輸光了，能量耗盡。');
    const both = inFocus.filter((m) => m.classList.contains('ed-hl-chk-sensitive'));
    assert.deepEqual(both.map((m) => m.textContent), ['賭博']);
    // 不在當前段的體檢標記照樣畫著。
    assert.ok(h.checkMarks().some(([t]) => t === 'PTSD'));
    h.pickMenu('段落聚焦');
  });

  test('樣式：check 圖層只畫下劃線（不碰排版、不改字色），選擇器比查詢低一級', () => {
    const css = fs.readFileSync(path.join(ROOT, 'dist', 'media', 'standalone.css'), 'utf8');
    const rules = [...css.matchAll(/([^{}]*ed-hl-chk-[^{}]*)\{([^}]*)\}/g)];
    assert.equal(rules.length, 4);
    for (const [, selector, body] of rules) {
      assert.match(selector.trim(), /^:where\(\.ed-mirror\) mark\.ed-hl-chk-\w+$/);
      assert.doesNotMatch(body, /(^|[;\s])(padding|margin|border|font-weight|color)\s*:/);
      assert.match(body, /text-decoration:/);
    }
    // 查詢的底色仍是 `.ed-mirror mark.ed-hl-find`（比 :where 那一條高一級，敏感詞的淡底色蓋不過它）。
    assert.match(css, /\.ed-mirror mark\.ed-hl-find\s*\{/);
  });

  test('深 / 淺 / 護眼三套主題都給了體檢的五個顏色', () => {
    const css = fs.readFileSync(path.join(ROOT, 'dist', 'media', 'standalone.css'), 'utf8');
    const style = h.ui.doc.createElement('style');
    style.textContent = css;
    h.ui.doc.head.appendChild(style);
    const isTheme = (sel, theme) => /^:root\[data-theme=['"]?(\w+)['"]?\]$/.exec(sel.trim())?.[1] === theme;
    const vars = (theme) =>
      [...style.sheet.cssRules]
        .filter((r) => r.selectorText && r.selectorText.split(',').some((sel) => isTheme(sel, theme)))
        .flatMap((r) => [...r.style].filter((n) => n.startsWith('--nf-chk-')))
        .sort();
    const want = ['--nf-chk-acronym', '--nf-chk-banned', '--nf-chk-sensitive', '--nf-chk-sensitive-bg', '--nf-chk-simile'];
    for (const theme of ['dark', 'light', 'sepia']) {
      assert.deepEqual(vars(theme), want, theme);
    }
    style.remove();
  });
});

describe('寫作體檢：打字與輸入法', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
    h.open(CH, TEXT, { kind: 'chapter' });
  });

  test('在最前面打字：舊的標記挪到新位置（字還是那幾個字），同一輪裡就對', async () => {
    h.area().setSelectionRange(0, 0);
    h.type('雨夜，');
    await flush();
    await frames();
    assert.deepEqual(h.checkMarks().map(([t]) => t), ['賭博', '能量', 'PTSD', 'sb']);
    assert.equal(h.main().querySelector('.ed-mirror:not(.ed-mirror-probe) .ed-mirror-content').textContent, h.area().value);
  });

  test('打出一個禁用詞：同一輪裡標上、計數跟著漲', async () => {
    const a = h.area();
    a.setSelectionRange(a.value.length, a.value.length);
    h.type('神經');
    await flush();
    assert.equal(h.cell().textContent, '體檢 5');
    assert.deepEqual(h.checkMarks().at(-1), ['神經', 'banned']);
  });

  test('刪掉它：標記沒了、計數回去', async () => {
    const a = h.area();
    const at = a.value.length;
    a.value = a.value.slice(0, at - 2);
    a.setSelectionRange(at - 2, at - 2);
    a.dispatchEvent(new h.ui.window.InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    await flush();
    // 重查的結果與映象層平移之後的一樣：不再畫一遍，映象層自己下一幀重畫。
    await frames();
    assert.equal(h.cell().textContent, '體檢 4');
    assert.equal(h.checkMarks().some(([t]) => t === '神經'), false);
  });

  test('撤銷 / 重做（沒有改動可用）：先挪、再查，計數跟著', async () => {
    h.undo();
    await flush();
    assert.equal(h.cell().textContent, '體檢 5');
    h.undo();
    await flush();
    assert.equal(h.cell().textContent, '體檢 4');
    assert.deepEqual(h.checkMarks().map(([t]) => t), ['賭博', '能量', 'PTSD', 'sb']);
    h.redo();
    await flush();
    assert.equal(h.cell().textContent, '體檢 5');
    h.undo();
    await flush();
  });

  test('輸入法組字中途：拼音「sb」不當成敏感詞、計數不跳，舊標記挪到拼音後面', async () => {
    const a = h.area();
    a.setSelectionRange(0, 0);
    const commit = h.compose(['s', 'sb'], '傻');
    await flush();
    await frames();
    assert.equal(h.cell().textContent, '體檢 4');
    assert.deepEqual(h.checkMarks().map(([t]) => t), ['賭博', '能量', 'PTSD', 'sb']);
    assert.equal(h.marks().filter((m) => m.textContent === 'sb').length, 1);
    commit();
    await flush();
    await frames();
    assert.equal(h.area().value.startsWith('傻雨夜，'), true);
    assert.equal(h.cell().textContent, '體檢 4');
    assert.deepEqual(h.checkMarks().map(([t]) => t), ['賭博', '能量', 'PTSD', 'sb']);
  });

  test('上屏的字是敏感詞：上屏之後才標出來', async () => {
    const a = h.area();
    a.setSelectionRange(0, 0);
    const commit = h.compose(['du', 'dubo'], '賭博');
    await flush();
    assert.equal(h.cell().textContent, '體檢 4');
    commit();
    await flush();
    assert.equal(h.cell().textContent, '體檢 5');
    assert.deepEqual(h.checkMarks()[0], ['賭博', 'sensitive']);
  });
});

describe('寫作體檢：面板', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
    h.open(CH, TEXT, { kind: 'chapter' });
  });

  test('按下滑鼠不奪編輯區的焦點', () => {
    const ev = new h.ui.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    h.cell().dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true);
  });

  test('點開：掛在 body 上、那一格 aria-expanded', () => {
    const panel = h.clickCell();
    assert.ok(panel);
    assert.equal(panel.parentElement, h.ui.doc.body);
    assert.equal(h.cell().getAttribute('aria-expanded'), 'true');
    assert.match(panel.querySelector('.ed-check-aside').textContent, /4 個問題/);
  });

  test('按類別列：敏感詞 → 禁用詞 → 英文縮寫，每一類幾處', () => {
    const secs = [...h.panel().querySelectorAll('.ed-check-sec')].map((s) => [
      s.querySelector('.ed-check-sec-label').textContent,
      s.querySelector('.ed-check-sec-count').textContent,
    ]);
    assert.deepEqual(secs, [
      ['敏感詞', '2 處'],
      ['禁用詞', '1 處'],
      ['英文縮寫', '1 處'],
    ]);
  });

  test('詞與次數；有替換詞的那一個帶「替換本處」「全部替換」，別的沒有', () => {
    assert.equal(h.times('賭博'), '×1');
    assert.equal(h.row('賭博').querySelector('.ed-check-replacement').textContent, '博戲');
    assert.ok(h.row('賭博').querySelector('.ed-check-replace-one'));
    assert.ok(h.row('賭博').querySelector('.ed-check-replace-all'));
    assert.equal(h.row('SB').querySelector('.ed-check-replace-one'), null);
    assert.equal(h.row('能量').querySelector('.ed-check-replace-all'), null);
  });

  test('說清禁用詞與寫正文時數的是同一份、敏感詞表在哪', () => {
    const text = h.panel().textContent;
    assert.match(text, /與寫正文時寫完數的是同一份/);
    assert.match(text, /\.novelwarden\/sensitive\.txt/);
    assert.match(text, /不調模型/);
  });

  test('開著打字：跟著變', async () => {
    const a = h.area();
    a.setSelectionRange(a.value.length, a.value.length);
    h.type('能量');
    await flush();
    assert.equal(h.times('能量'), '×2');
    h.undo();
    await flush();
    assert.equal(h.times('能量'), '×1');
  });

  test('Esc 收起（捕獲階段吞掉，不往下傳）', () => {
    const ev = h.key({ key: 'Escape' }, h.ui.doc.body);
    assert.equal(h.panel(), null);
    assert.equal(h.cell().getAttribute('aria-expanded'), 'false');
    assert.equal(ev.defaultPrevented, false);
  });

  test('點外面收起；點面板裡面不收', () => {
    h.clickCell();
    h.panel().dispatchEvent(new h.ui.window.MouseEvent('mousedown', { bubbles: true }));
    assert.ok(h.panel());
    h.ui.doc.body.dispatchEvent(new h.ui.window.MouseEvent('mousedown', { bubbles: true }));
    assert.equal(h.panel(), null);
  });

  test('再點一下那一格收起', () => {
    h.clickCell();
    h.clickCell();
    assert.equal(h.panel(), null);
  });

  test('不是正文時那一格藏起來，開著的面板跟著收', () => {
    h.clickCell();
    h.open('.novelwarden/characters/林昭.md', '主角。', { kind: 'character' });
    assert.equal(h.panel(), null);
  });

  test('敏感詞表還沒建、有壞行：面板裡說一句', () => {
    h.ui.post({
      type: 'checkTerms',
      terms: { ...TERMS, sensitiveExists: false, sensitive: [], sensitiveBad: [{ line: 3, reason: '「=>」前面沒有詞' }, { line: 7, reason: '太長了' }] },
    });
    h.open(CH, TEXT, { kind: 'chapter' });
    h.clickCell();
    const text = h.panel().textContent;
    assert.match(text, /還沒有敏感詞表/);
    assert.match(text, /敏感詞表第 3、7 行沒看懂，已跳過/);
    assert.match(h.panel().querySelector('.ed-check-bad').title, /第 3 行：「=>」前面沒有詞/);
    h.key({ key: 'Escape' }, h.ui.doc.body);
    h.ui.post({ type: 'checkTerms', terms: TERMS });
  });
});

describe('寫作體檢：點詞跳轉選中', { skip: JSDOM_SKIP }, () => {
  let h;
  const text = '能量一，能量二，能量三。';
  before(() => {
    h = harness();
    h.open(CH, text, { kind: 'chapter' });
    h.ui.doc.body.focus();
    h.clickCell();
  });

  test('點一下：游標之後的第一處被選中，焦點進正文，面板上寫「1/3」', () => {
    h.clickWord('能量');
    assert.deepEqual(h.selected(), [0, 2]);
    assert.equal(h.ui.doc.activeElement, h.area());
    assert.equal(h.times('能量'), '1/3');
    assert.ok(h.panel(), '面板還開著');
  });

  test('再點：下一處', () => {
    h.clickWord('能量');
    assert.deepEqual(h.selected(), [4, 6]);
    assert.equal(h.times('能量'), '2/3');
    h.clickWord('能量');
    assert.deepEqual(h.selected(), [8, 10]);
  });

  test('到底了繞回第一處', () => {
    h.clickWord('能量');
    assert.deepEqual(h.selected(), [0, 2]);
    assert.equal(h.times('能量'), '1/3');
  });

  test('面板上的按鈕按下滑鼠不奪焦點（選區留著）', () => {
    const btn = h.row('能量').querySelector('.ed-check-word');
    const ev = new h.ui.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    btn.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true);
  });

  test('預覽裡點詞：先切回編輯再選中', () => {
    h.key({ key: 'Escape' }, h.ui.doc.body);
    h.ui.clickEl(h.ui.doc.getElementById('edPreviewBtn'));
    assert.equal(h.area().classList.contains('hidden'), true);
    h.clickCell();
    h.clickWord('能量');
    assert.equal(h.area().classList.contains('hidden'), false);
    const [s, e] = h.selected();
    assert.equal(h.area().value.slice(s, e), '能量');
  });
});

describe('寫作體檢：替換本處與本檔案全部替換', { skip: JSDOM_SKIP }, () => {
  let h;
  const text = '賭博，賭博，賭博。';
  before(() => {
    h = harness();
    h.open(CH, text, { kind: 'chapter' });
    const a = h.area();
    a.setSelectionRange(a.value.length, a.value.length);
    h.clickCell();
  });

  test('沒選中這個詞時「替換本處」只選中下一處（到底繞回第一處），一個字不改', () => {
    h.ui.clickEl(h.row('賭博').querySelector('.ed-check-replace-one'));
    assert.equal(h.area().value, text);
    assert.deepEqual(h.selected(), [0, 2]);
  });

  test('再按一下：換掉選中的這一處，接著選中下一處', () => {
    h.ui.clickEl(h.row('賭博').querySelector('.ed-check-replace-one'));
    assert.equal(h.area().value, '博戲，賭博，賭博。');
    assert.deepEqual(h.selected(), [3, 5]);
    assert.equal(h.cell().textContent, '體檢 2');
  });

  test('Ctrl+Z 一步退回', async () => {
    h.undo();
    await flush();
    assert.equal(h.area().value, text);
    assert.equal(h.cell().textContent, '體檢 3');
  });

  test('「全部替換」：一次換完、說替換了幾處', () => {
    h.ui.clickEl(h.row('賭博').querySelector('.ed-check-replace-all'));
    assert.equal(h.area().value, '博戲，博戲，博戲。');
    assert.match(h.toasts.at(-1), /替換了 3 處/);
    assert.equal(h.cell().textContent, '體檢 ✓');
    assert.equal(h.row('賭博'), undefined);
  });

  test('Ctrl+Z 一步全部退回，Ctrl+Y 再來', async () => {
    h.undo();
    await flush();
    assert.equal(h.area().value, text);
    assert.equal(h.cell().textContent, '體檢 3');
    h.redo();
    await flush();
    assert.equal(h.area().value, '博戲，博戲，博戲。');
  });

  test('替換之後是未儲存（不寫盤、不發 saveFile）', () => {
    assert.equal(h.ui.sent.some((m) => m.type === 'saveFile'), false);
    assert.match(h.ui.doc.getElementById('edStatusSave').textContent, /未儲存/);
  });

  test('大小寫不同的幾處一起換（敏感詞英文不分大小寫）', () => {
    h.key({ key: 'Escape' }, h.ui.doc.body);
    h.ui.post({ type: 'checkTerms', terms: { ...TERMS, sensitive: [{ term: 'sb', replacement: '某人' }] } });
    h.open('chapters/008.md', 'SB 說 sb 不對。', { kind: 'chapter' });
    h.clickCell();
    h.ui.clickEl(h.row('sb').querySelector('.ed-check-replace-all'));
    assert.equal(h.area().value, '某人 說 某人 不對。');
  });
});

describe('寫作體檢：「檢視 → 體檢」', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    // 段落那幾項與碼字統計先記著非預設值：體檢寫偏好時不許把它們沖掉。
    h = harness({ storage: { [PREFS_KEY]: JSON.stringify({ autoPair: false, stats: { goal: false, session: true, today: false } }) } });
    h.open(CH, TEXT, { kind: 'chapter' });
  });

  test('「檢視」裡「統計」之後那一組：體檢高亮、狀態列顯示體檢（預設都開）、編輯敏感詞表…', () => {
    const labels = [...h.viewMenu().querySelectorAll('.wb-menu-item')].map((b) => b.querySelector('.wb-menu-label').textContent);
    // 後面還跟著「補全」那一組（名詞補全），體檢這三項連在一起、排在它前面。
    const at = labels.indexOf('體檢高亮');
    assert.deepEqual(labels.slice(at, at + 3), ['體檢高亮', '狀態列顯示體檢', '編輯敏感詞表…']);
    assert.ok(at > labels.indexOf('重新開始計時'), '在「統計」那一組後面');
    assert.ok(at < labels.indexOf('名詞補全'), '在「補全」那一組前面');
    assert.equal(h.menuItem('體檢高亮').getAttribute('aria-checked'), 'true');
    assert.equal(h.menuItem('狀態列顯示體檢').getAttribute('aria-checked'), 'true');
    assert.equal(h.menuItem('編輯敏感詞表…').disabled, false);
    h.ui.closeMenu();
  });

  test('關掉體檢高亮：正文裡的標記沒了，那一格照舊數', () => {
    h.pickMenu('體檢高亮');
    assert.deepEqual(h.checkMarks(), []);
    assert.equal(h.cell().textContent, '體檢 4');
    assert.match(h.cell().title, /體檢高亮關著/);
    assert.equal(h.menuItem('體檢高亮').getAttribute('aria-checked'), 'false');
    h.ui.closeMenu();
  });

  test('記進 novelforge.editor.prefs，不沖掉段落與碼字統計那幾項', () => {
    const prefs = h.storedPrefs();
    assert.deepEqual(prefs.check, { highlight: false, status: true });
    assert.equal(prefs.autoPair, false);
    assert.deepEqual(prefs.stats, { goal: false, session: true, today: false });
  });

  test('關掉狀態列那一格：藏起來', () => {
    h.pickMenu('狀態列顯示體檢');
    assert.equal(h.cellShown(), false);
    assert.deepEqual(h.storedPrefs().check, { highlight: false, status: false });
  });

  test('重新整理之後照舊', () => {
    const again = harness({ storage: { [PREFS_KEY]: h.ui.window.localStorage.getItem(PREFS_KEY) } });
    again.open(CH, TEXT, { kind: 'chapter' });
    assert.deepEqual(again.checkMarks(), []);
    assert.equal(again.cellShown(), false);
  });

  test('都開啟回來：標記與那一格都回來', () => {
    h.pickMenu('體檢高亮');
    h.pickMenu('狀態列顯示體檢');
    assert.equal(h.checkMarks().length, 4);
    assert.equal(h.cell().textContent, '體檢 4');
  });

  test('寫壞了的偏好（不是物件）：兩個都按預設開', () => {
    const again = harness({ storage: { [PREFS_KEY]: JSON.stringify({ check: 'yes' }) } });
    again.open(CH, TEXT, { kind: 'chapter' });
    assert.equal(again.checkMarks().length, 4);
    assert.equal(again.cellShown(), true);
  });
});

describe('寫作體檢：編輯敏感詞表…', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness({ terms: { ...TERMS, sensitive: [], sensitiveExists: false } });
    h.open(CH, TEXT, { kind: 'chapter' });
  });

  test('面板裡點它：發 editSensitiveWords、面板收起', () => {
    h.clickCell();
    h.ui.clickEl(h.panel().querySelector('.ed-check-edit'));
    assert.equal(h.ui.last('editSensitiveWords')?.type, 'editSensitiveWords');
    assert.equal(h.panel(), null);
  });

  test('「檢視」裡點它：同樣發 editSensitiveWords', () => {
    h.ui.sent.length = 0;
    h.pickMenu('編輯敏感詞表…');
    assert.equal(h.ui.sent.filter((m) => m.type === 'editSensitiveWords').length, 1);
  });

  test('後端建好開啟的那一份進編輯器、成了當前標籤；它不是正文，不體檢它', () => {
    h.ui.post({ type: 'editorOpen', file: file(SENSITIVE, '# 敏感詞表\n賭博 => 博戲\n', { kind: 'sensitive' }) });
    h.ui.post({ type: 'checkTerms', terms: { ...TERMS, sensitive: [{ term: '賭博', replacement: '博戲' }] } });
    assert.equal(h.area().value, '# 敏感詞表\n賭博 => 博戲\n');
    assert.deepEqual(h.checkMarks(), []);
    assert.equal(h.cellShown(), false);
  });

  test('詞表到了：回到正文就按新詞表標', () => {
    h.ui.clickEl([...h.main().querySelectorAll('.ed-tab')].find((t) => t.textContent.includes('003')));
    assert.ok(h.checkMarks().some(([t, c]) => t === '賭博' && c === 'sensitive'));
  });

  test('沒開啟工程：選單項置灰', () => {
    const empty = harness({ empty: true, terms: null });
    const btn = empty.menuItem('編輯敏感詞表…');
    assert.equal(btn.disabled, true);
    empty.ui.closeMenu();
  });
});

describe('寫作體檢：大章節節流', { skip: JSDOM_SKIP }, () => {
  let h;
  const big = '雨'.repeat(30_000) + '能量';
  before(() => {
    h = harness({ shims: [...SHIMS, 'fakeTimers'] });
    h.open(CH, big, { kind: 'chapter' });
  });

  test('開啟時當場查一遍', () => {
    assert.equal(h.cell().textContent, '體檢 1');
    assert.deepEqual(h.checkMarks(), [['能量', 'banned']]);
  });

  test('打出新的禁用詞：不當場重查（節流到定時器裡），撥過 300ms 才標上', async () => {
    const a = h.area();
    a.setSelectionRange(a.value.length, a.value.length);
    h.type('能量');
    await flush();
    assert.equal(h.cell().textContent, '體檢 1');
    h.ui.window.__clock.tick(300);
    assert.equal(h.cell().textContent, '體檢 2');
    assert.equal(h.checkMarks().length, 2);
  });

  test('節流的空檔裡在前面打字：舊標記跟著挪（映象層自己平移），字還是那幾個字', async () => {
    const a = h.area();
    a.setSelectionRange(0, 0);
    h.type('夜');
    await flush();
    h.ui.window.__clock.tick(16);
    assert.deepEqual(h.checkMarks().map(([t]) => t), ['能量', '能量']);
    h.ui.window.__clock.tick(300);
  });

  test('面板上點詞之前先當場重查：位置是此刻的', async () => {
    const a = h.area();
    a.setSelectionRange(a.value.length, a.value.length);
    h.type('能量');
    await flush();
    assert.equal(h.cell().textContent, '體檢 2');
    h.clickCell();
    h.clickWord('能量');
    assert.equal(h.times('能量'), '1/3');
    const [s, e] = h.selected();
    assert.equal(h.area().value.slice(s, e), '能量');
    h.key({ key: 'Escape' }, h.ui.doc.body);
  });
});
