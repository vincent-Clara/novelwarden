/**
 * 快捷鍵表（`media/src/editor/shortcuts.ts`）守兩頭，外加「幫助 → 快捷鍵一覽」面板（`editor/shortcutsPanel.ts`）。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 選單上的 kbd | 標題欄四個選單上寫著鍵的每一項都在表裡（`menu`）、字與表一樣；表裡寫了 `menu` 的每一條選單上都有。Mac 上寫 ⌘ / ⌥ |
 * | 表裡的每一條都有人處理 | 照它的生效範圍擺好場面（正文裡 / 頁面上 / 對話輸入框裡 / 某個面板開著時）按一下，得被接走（`defaultPrevented`）；瀏覽器自己的那幾樣（剪下、複製……）反過來不許被接走。`where` 沒有對應的場面就算沒測到，用例失敗 |
 * | 被接走的每一下都在表裡 | 在正文裡、頁面上、對話輸入框裡把幾百種按法（字母、數字、標點、F1–F12、方向鍵這些 × 修飾鍵組合）挨個按一遍，被接走的每一下都得是表裡這一檔認的某一條 |
 * | 快捷鍵一覽 | Ctrl+/（對話輸入框裡也行）與「幫助 → 快捷鍵一覽」開啟；按分組列出全部；篩選；Esc / 點外面 / × / 再按 Ctrl+/ 關、焦點還回去；Esc 不連帶退出專注模式；別的彈窗開著時不開；組字中途不算；Mac 上寫 ⌘ |
 *
 * 「被接走的每一下都在表裡」只掃這三處場面：面板裡那幾個鍵（查詢框裡的回車、補全框裡的方向鍵……）各自的面板裡就那麼幾個，
 * 由「表裡的每一條都有人處理」那一半按到；對話輸入框自己的回車傳送、`@`（引用選擇器）不是快捷鍵，不掃。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file, listing } = require('../../helpers/dom');
const { loadModule } = require('../../helpers/load');

const { SHORTCUTS, formatKey, matchesKey, parseKey, shortcutLabel } = loadModule('media/src/editor/shortcuts.ts');

const SHIMS = ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'];
const S = '.novelwarden/summaries';
const CH = 'chapters/003-夜訪.md';
const TEXT = '# 第三章 夜訪\n\n雨下了三天。\n\n林昭推門進來。\n\n- 一\n- 二\n';
const chapterRow = (no, title) => ({
  no,
  label: `第 ${no} 章《${title}》`,
  title,
  relPath: `chapters/00${no}-${title}.md`,
  plotPath: `${S}/00${no}-${title}.md`,
  plotExists: true,
  chapterPath: `chapters/00${no}-${title}.md`,
  wordCount: 100,
  targetWords: 3000,
  stage: 'done',
});
const INDEX = [chapterRow(2, '入鎮'), chapterRow(3, '夜訪'), chapterRow(4, '北行')];
const NAMES = [{ name: '林昭', aliases: [], source: 'character', category: '', brief: '', path: '.novelwarden/characters/林昭.md' }];

const SHIFTED = { '/': '?', '=': '+', '-': '_', ',': '<', '.': '>', ';': ':', "'": '"', '[': '{', ']': '}', '\\': '|', '`': '~' };
const DIGIT_SHIFTED = ')!@#$%^&*(';
const CODE = { '/': 'Slash', '=': 'Equal', '-': 'Minus', ',': 'Comma', '.': 'Period', ';': 'Semicolon', "'": 'Quote', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash', '`': 'Backquote' };
const NAMED = { Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', Plus: '+' };

/** 一種按法 → 瀏覽器發出來的那個 keydown（Linux：Mod 是 Ctrl）。 */
function eventFor(spec) {
  const k = parseKey(spec);
  const init = { ctrlKey: k.mod || k.ctrl, altKey: k.alt, shiftKey: k.shift, metaKey: false };
  if (/^[a-z]$/.test(k.key)) {
    return { ...init, key: k.shift ? k.key.toUpperCase() : k.key, code: `Key${k.key.toUpperCase()}` };
  }
  if (/^\d$/.test(k.key)) {
    return { ...init, key: k.key, code: `Digit${k.key}` };
  }
  if (CODE[k.key]) {
    return { ...init, key: k.key, code: CODE[k.key] };
  }
  return { ...init, key: NAMED[k.key] ?? k.key, code: k.key === 'Plus' ? 'Equal' : undefined };
}

function harness(extraShims = []) {
  const ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js', 'explorer.js'], shims: [...SHIMS, ...extraShims] });
  ui.doc.execCommand = () => true;
  ui.window.prompt = () => null;
  ui.window.__nfToast = () => {};
  ui.post({ type: 'chapterIndex', chapters: INDEX });
  ui.post({ type: 'dirListings', listings: [listing('', { 'a.md': 'file', 子目錄: 'dir' })] });
  const doc = ui.doc;
  const h = {
    ui,
    doc,
    area: () => doc.getElementById('edArea'),
    chat: () => doc.getElementById('input'),
    open: () => ui.post({ type: 'editorOpen', file: file(CH, TEXT, { kind: 'chapter' }) }),
    key(target, init) {
      const ev = new ui.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(ev);
      return ev;
    },
    blur() {
      doc.activeElement?.blur?.();
    },
    /** 還有什麼開著（面板、浮層、對話方塊、專注模式、選單、目錄選擇器）。 */
    somethingOpen() {
      return !!(
        doc.querySelector('.ed-dialog, .ed-keys-overlay, .qo-panel, .ed-look-overlay, .wb-menu-drop, .ctx-menu, .nf-picker.open') ||
        doc.querySelector('#wbSide.bf-open') ||
        [...doc.querySelectorAll('.ed-find')].some((f) => !f.classList.contains('hidden')) ||
        (doc.querySelector('.nc-box') && !doc.querySelector('.nc-box').classList.contains('hidden')) ||
        doc.body.classList.contains('nf-focus')
      );
    },
    /** 回到起點：什麼都沒開、正文開著、在編輯（不在預覽裡）。 */
    reset() {
      for (let i = 0; i < 8 && h.somethingOpen(); i++) {
        const bf = doc.querySelector('#wbSide.bf-open .bf-close');
        if (bf) {
          ui.clickEl(bf);
          continue;
        }
        const focused = doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : h.area();
        h.key(focused, { key: 'Escape' });
        if (h.somethingOpen()) {
          h.key(h.area(), { key: 'Escape' });
        }
      }
      if (![...doc.querySelectorAll('#wbEditor .ed-tab')].some((t) => t.dataset.path === CH)) {
        h.open();
      }
      if (!doc.getElementById('edPreview').classList.contains('hidden')) {
        ui.clickEl(doc.getElementById('edPreviewBtn'));
      }
      assert.equal(h.somethingOpen(), false, '回不到起點');
    },
    /** 名詞表（補全框要它）。 */
    serveNames() {
      const req = ui.last('requestNameIndex');
      ui.post({ type: 'nameIndex', requestId: req.requestId, sig: 'n1', index: { initialized: true, names: NAMES } });
    },
  };
  h.open();
  return h;
}

// ---------------------------------------------------------------- 場面

/** 正文裡（textarea 有焦點）。 */
const inEditor = (h) => {
  h.area().focus();
  return h.area();
};
/** 頁面上（焦點不在任何輸入框裡）。 */
const onPage = (h) => {
  h.blur();
  return h.doc.body;
};
/** 左邊的對話輸入框裡。 */
const inChat = (h) => {
  h.chat().focus();
  return h.chat();
};

/** 每一檔在哪兒按：global 在對話輸入框裡按（證明哪裡都行），workbench 在頁面上，editor 在正文裡。 */
const BY_SCOPE = { global: inChat, workbench: onPage, editor: inEditor };

/** `context` 那幾檔：照 `where` 擺好場面，返回在哪兒按。表裡新加了一種 `where`，這裡也得加。 */
const BY_WHERE = {
  查詢條的查詢框裡: (h) => {
    h.key(inEditor(h), eventFor('Mod+F'));
    return h.doc.querySelector('#wbEditor .ed-find-input');
  },
  查詢條的替換框裡: (h) => {
    h.key(inEditor(h), eventFor('Mod+H'));
    return h.doc.querySelector('#wbEditor .ed-replace-input');
  },
  補全框開著時: (h) => {
    h.key(inEditor(h), eventFor('Alt+/'));
    h.serveNames();
    assert.ok(h.doc.querySelector('.nc-box:not(.hidden)'), '補全框沒彈出來');
    return h.area();
  },
  '「轉到…」面板裡': (h) => {
    h.key(onPage(h), eventFor('Mod+P'));
    return h.doc.querySelector('.qo-panel .qo-input');
  },
  專注模式裡: (h) => {
    h.key(onPage(h), eventFor('F8'));
    assert.ok(h.doc.body.classList.contains('nf-focus'));
    return inEditor(h);
  },
  '面板、彈窗、選單開著時': (h) => {
    h.ui.window.dispatchEvent(new h.ui.window.CustomEvent('nf-view-command', { detail: { name: 'openLook' } }));
    assert.ok(h.doc.querySelector('.ed-look-overlay'), '外觀面板沒開');
    return h.doc.activeElement;
  },
  '「檔案」頁的樹上選中一行時': (h) => {
    h.doc.getElementById('pane-files').classList.add('active');
    const row = [...h.doc.querySelectorAll('#filesBody .fx-row')].find((r) => r.textContent.includes('a.md'));
    row.dispatchEvent(new h.ui.window.FocusEvent('focus', { bubbles: true }));
    row.focus();
    return row;
  },
};

function placeFor(h, s) {
  if (s.scope === 'context') {
    const setup = BY_WHERE[s.where];
    assert.ok(setup, `「${s.where}」（${s.id}）沒有探針：在 BY_WHERE 里加一個`);
    return setup(h);
  }
  return BY_SCOPE[s.scope](h);
}

describe('快捷鍵表：表裡的每一條都真的有人處理', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
  });

  for (const s of SHORTCUTS) {
    for (const spec of s.keys) {
      const where = s.scope === 'context' ? s.where : { global: '對話輸入框裡', workbench: '頁面上', editor: '正文裡' }[s.scope];
      test(`${s.id}：${spec}（${where}）${s.native ? '是瀏覽器自己的，編輯器不攔' : '被接走'}`, () => {
        h.reset();
        const target = placeFor(h, s);
        const ev = h.key(target, eventFor(spec));
        assert.equal(ev.defaultPrevented, !s.native, `${s.label}`);
        h.doc.getElementById('pane-files').classList.remove('active');
        h.reset();
      });
    }
  }
});

// ---------------------------------------------------------------- 反過來掃

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
const DIGITS = '0123456789'.split('');
const PUNCT = Object.keys(SHIFTED);
const NAMED_KEYS = ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Backspace', 'Delete', ' '];
const F_KEYS = Array.from({ length: 12 }, (_, i) => `F${i + 1}`);
const MODS = [
  {},
  { shiftKey: true },
  { ctrlKey: true },
  { ctrlKey: true, shiftKey: true },
  { altKey: true },
  { altKey: true, shiftKey: true },
  { ctrlKey: true, altKey: true },
  { metaKey: true },
  { metaKey: true, shiftKey: true },
];

/** 幾百種按法：字母、數字、標點（按著 Shift 時是美式鍵盤打出來的那個字）、有名字的鍵、F1–F12，× 修飾鍵組合。 */
function* universe({ typing }) {
  for (const mods of MODS) {
    const plain = !mods.ctrlKey && !mods.metaKey && !mods.altKey;
    for (const ch of [...LETTERS, ...DIGITS, ...PUNCT]) {
      if (plain) {
        continue; // 那是打字
      }
      let key = ch;
      if (mods.shiftKey) {
        key = /[a-z]/.test(ch) ? ch.toUpperCase() : /\d/.test(ch) ? DIGIT_SHIFTED[Number(ch)] : SHIFTED[ch];
      }
      if (!typing && key === '@') {
        continue; // 對話輸入框自己的 @（打出 @ 就彈引用選擇器，帶不帶修飾鍵都一樣）
      }
      const code = /[a-z]/.test(ch) ? `Key${ch.toUpperCase()}` : /\d/.test(ch) ? `Digit${ch}` : CODE[ch];
      yield { key, code, ...mods };
    }
    for (const key of [...NAMED_KEYS, ...F_KEYS]) {
      if (!typing && key === 'Enter') {
        continue; // 對話輸入框自己的回車傳送
      }
      if (!typing && plain && !key.startsWith('F')) {
        continue;
      }
      yield { key, ...mods };
    }
  }
}

const describeKey = (e) =>
  [e.ctrlKey && 'Ctrl', e.metaKey && 'Meta', e.altKey && 'Alt', e.shiftKey && 'Shift', e.key === ' ' ? 'Space' : e.key]
    .filter(Boolean)
    .join('+');

/** 在這一檔（`scopes`）裡，這一下是不是表裡的某一條（瀏覽器自己的那幾樣不算：它們不許被接走）。 */
function listed(e, scopes) {
  const like = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...e };
  return SHORTCUTS.some(
    (s) => !s.native && scopes.includes(s.scope) && [...s.keys, ...(s.also ?? [])].some((spec) => matchesKey(like, spec))
  );
}

function scan(h, place, scopes, opts) {
  const unlisted = [];
  let prevented = 0;
  for (const init of universe(opts)) {
    const target = place(h);
    const ev = h.key(target, init);
    if (!ev.defaultPrevented) {
      continue;
    }
    prevented++;
    if (!listed(init, scopes)) {
      unlisted.push(describeKey(init));
    }
    h.reset();
  }
  return { unlisted, prevented };
}

describe('快捷鍵表：被接走的每一下都在表裡', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
  });

  test('正文裡：被接走的都是「正文裡」「編輯區或頁面上」「哪裡都行」那幾檔的', () => {
    const { unlisted, prevented } = scan(h, inEditor, ['editor', 'workbench', 'global'], { typing: true });
    assert.deepEqual(unlisted, []);
    assert.ok(prevented >= 25, `才接走 ${prevented} 下，場面沒擺對？`);
  });

  test('頁面上：被接走的都是「編輯區或頁面上」「哪裡都行」那兩檔的', () => {
    const { unlisted, prevented } = scan(h, onPage, ['workbench', 'global'], { typing: true });
    assert.deepEqual(unlisted, []);
    assert.ok(prevented >= 12, `才接走 ${prevented} 下`);
  });

  test('對話輸入框裡：被接走的組合鍵都是「哪裡都行」那一檔的', () => {
    const { unlisted, prevented } = scan(h, inChat, ['global'], { typing: false });
    assert.deepEqual(unlisted, []);
    assert.ok(prevented >= 8, `才接走 ${prevented} 下`);
  });
});

// ---------------------------------------------------------------- 選單

const MENUS = { file: '檔案', edit: '編輯', view: '檢視', help: '幫助' };

/** 四個選單上寫著鍵的每一項：`選單 › 名字` → 鍵。 */
function menuKbds(h) {
  const out = new Map();
  for (const [key, name] of Object.entries(MENUS)) {
    h.ui.clickEl(h.doc.querySelector(`[data-menu="${key}"]`));
    for (const item of h.doc.querySelectorAll('.wb-menu-drop .wb-menu-item')) {
      const kbd = item.querySelector('.wb-menu-kbd');
      if (kbd) {
        out.set(`${name} › ${item.querySelector('.wb-menu-label').textContent}`, kbd.textContent);
      }
    }
    h.ui.closeMenu();
  }
  return out;
}

describe('快捷鍵表：選單上寫的鍵從表裡取', { skip: JSDOM_SKIP }, () => {
  test('選單上寫著鍵的每一項都在表裡，字一樣；表裡寫了 menu 的每一條選單上都有', () => {
    const h = harness();
    const shown = menuKbds(h);
    const want = new Map(SHORTCUTS.filter((s) => s.menu).map((s) => [s.menu, shortcutLabel(s.id, false)]));
    assert.deepEqual([...shown.entries()].sort(), [...want.entries()].sort());
  });

  test('Mac 上寫 ⌘ / ⌥：儲存 ⌘S、重做 ⇧⌘Z、名詞補全 ⌥/、快捷鍵一覽 ⌘/', () => {
    const h = harness(['mac']);
    const shown = menuKbds(h);
    assert.deepEqual(
      ['檔案 › 儲存', '編輯 › 重做', '檢視 › 名詞補全', '幫助 › 快捷鍵一覽', '編輯 › 全書查詢替換…'].map((p) => shown.get(p)),
      ['⌘S', '⇧⌘Z', '⌥/', '⌘/', '⇧⌘F']
    );
  });
});

// ---------------------------------------------------------------- 快捷鍵一覽

describe('快捷鍵一覽：Ctrl+/ 與「幫助 → 快捷鍵一覽」', { skip: JSDOM_SKIP }, () => {
  let h;
  const panel = () => h.doc.querySelector('.ed-keys');
  const rows = () => [...h.doc.querySelectorAll('.ed-keys .ed-keys-row')];
  const filter = (text) => {
    const input = h.doc.querySelector('.ed-keys-filter');
    input.value = text;
    input.dispatchEvent(new h.ui.window.InputEvent('input', { bubbles: true }));
  };
  before(() => {
    h = harness();
  });

  test('頁面模板裡沒有它；「幫助」裡緊跟「使用說明」，寫著 Ctrl+/', () => {
    assert.equal(panel(), null);
    h.ui.clickEl(h.doc.querySelector('[data-menu="help"]'));
    const labels = [...h.doc.querySelectorAll('.wb-menu-drop .wb-menu-item')].map(
      (b) => `${b.querySelector('.wb-menu-label').textContent}${b.querySelector('.wb-menu-kbd') ? `|${b.querySelector('.wb-menu-kbd').textContent}` : ''}`
    );
    h.ui.closeMenu();
    assert.deepEqual(labels.slice(0, 3), ['歡迎頁面', '使用說明', '快捷鍵一覽|Ctrl+/']);
  });

  test('點選單那一項開啟：模態（.modal-overlay）、焦點進篩選框、按分組列出全部', () => {
    h.ui.clickEl(h.doc.querySelector('[data-menu="help"]'));
    const item = [...h.doc.querySelectorAll('.wb-menu-drop .wb-menu-item')].find((b) => b.textContent.includes('快捷鍵一覽'));
    h.ui.clickEl(item);
    assert.ok(panel());
    assert.ok(panel().closest('.modal-overlay'));
    assert.equal(h.doc.activeElement, h.doc.querySelector('.ed-keys-filter'));
    assert.equal(rows().length, SHORTCUTS.length);
    const groups = [...h.doc.querySelectorAll('.ed-keys-group-title')].map((n) => n.textContent);
    assert.deepEqual(groups, ['檔案與標籤', '編輯', '段落', '查詢替換', '名詞補全', '檢視', '面板與幫助', '檔案頁']);
  });

  test('一行三格：鍵（幾種按法各一個 kbd）、做什麼（補充說明在下面）、在哪兒管用', () => {
    const redo = rows().find((r) => r.dataset.id === 'redo');
    assert.deepEqual([...redo.querySelectorAll('kbd')].map((k) => k.textContent), ['Ctrl+Y', 'Ctrl+Shift+Z']);
    assert.equal(redo.querySelector('.ed-keys-where').textContent, '游標在編輯區裡');
    const close = rows().find((r) => r.dataset.id === 'closeTab');
    assert.match(close.querySelector('.ed-keys-note').textContent, /瀏覽器多半攔不住/);
  });

  test('篩選：打「撤銷」只剩一條，按鍵的寫法也認，打不認識的說沒有，清空回到全部', () => {
    filter('撤銷');
    assert.deepEqual(rows().map((r) => r.dataset.id), ['undo']);
    assert.match(h.doc.querySelector('.ed-keys-count').textContent, /找到 1 個/);
    filter('ctrl+shift+f');
    assert.deepEqual(rows().map((r) => r.dataset.id), ['bookFind']);
    filter('沒有這種鍵');
    assert.equal(rows().length, 0);
    assert.match(h.doc.querySelector('.ed-keys-list').textContent, /沒有匹配的快捷鍵/);
    filter('');
    assert.equal(rows().length, SHORTCUTS.length);
  });

  test('組字中途不篩（拼音字母不算），上屏再篩', () => {
    const input = h.doc.querySelector('.ed-keys-filter');
    input.value = 'che';
    input.dispatchEvent(new h.ui.window.InputEvent('input', { bubbles: true, isComposing: true }));
    assert.equal(rows().length, SHORTCUTS.length);
    input.value = '撤銷';
    input.dispatchEvent(new h.ui.window.CompositionEvent('compositionend', { bubbles: true }));
    assert.equal(rows().length, 1);
    filter('');
  });

  test('Esc 關掉，焦點還回開啟之前的地方', () => {
    h.key(h.doc.querySelector('.ed-keys-filter'), { key: 'Escape' });
    assert.equal(panel(), null);
  });

  test('Ctrl+/：正文裡開啟，再按一下關掉、焦點回到正文', () => {
    const area = inEditor(h);
    const ev = h.key(area, eventFor('Mod+/'));
    assert.equal(ev.defaultPrevented, true);
    assert.ok(panel());
    h.key(h.doc.activeElement, eventFor('Mod+/'));
    assert.equal(panel(), null);
    assert.equal(h.doc.activeElement, area);
  });

  test('對話輸入框裡也開（這個鍵在那裡沒有別的用處）；Mac 的 ⌘/ 也認', () => {
    inChat(h);
    h.key(h.chat(), { key: '/', code: 'Slash', metaKey: true });
    assert.ok(panel());
    h.key(h.doc.activeElement, { key: 'Escape' });
    assert.equal(h.doc.activeElement, h.chat());
  });

  test('點外面那一層關掉；點面板裡面不關；× 也關', () => {
    h.key(inEditor(h), eventFor('Mod+/'));
    panel().dispatchEvent(new h.ui.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    assert.ok(panel());
    h.doc.querySelector('.ed-keys-overlay').dispatchEvent(new h.ui.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    assert.equal(panel(), null);
    h.key(inEditor(h), eventFor('Mod+/'));
    h.ui.clickEl(h.doc.querySelector('.ed-keys-x'));
    assert.equal(panel(), null);
  });

  test('專注模式裡：面板開著時 Esc 只收面板，不連帶退出專注', () => {
    h.key(onPage(h), eventFor('F8'));
    assert.ok(h.doc.body.classList.contains('nf-focus'));
    h.key(inEditor(h), eventFor('Mod+/'));
    h.key(h.doc.activeElement, { key: 'Escape' });
    assert.equal(panel(), null);
    assert.ok(h.doc.body.classList.contains('nf-focus'));
    h.key(onPage(h), eventFor('F8'));
  });

  test('輸入法組字中途的 Ctrl+/ 不算；別的彈窗（頁內對話方塊）開著時不開', async () => {
    const ev = h.key(inEditor(h), { ...eventFor('Mod+/'), isComposing: true });
    assert.equal(ev.defaultPrevented, false);
    assert.equal(panel(), null);
    // 改一個字再關標籤：彈「儲存 / 不儲存 / 取消」。
    const area = h.area();
    area.value = `${area.value}改`;
    area.dispatchEvent(new h.ui.window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: '改' }));
    h.key(area, eventFor('Mod+W'));
    assert.ok(h.ui.dialog(), '沒彈對話方塊');
    h.ui.window.dispatchEvent(new h.ui.window.Event('nf-shortcuts-command'));
    assert.equal(panel(), null);
    await h.ui.answer('取消');
  });

  test('Mac 上按 ⌘ / ⌥ 寫', () => {
    const m = harness(['mac']);
    m.key(m.area(), { key: '/', code: 'Slash', metaKey: true });
    const redo = m.doc.querySelector('.ed-keys-row[data-id="redo"]');
    assert.deepEqual([...redo.querySelectorAll('kbd')].map((k) => k.textContent), ['⌃Y', '⇧⌘Z']);
    assert.equal(m.doc.querySelector('.ed-keys-row[data-id="names"] kbd').textContent, '⌥/');
    assert.match(m.doc.querySelector('.ed-keys-filter').placeholder, /⌘F/);
    assert.equal(formatKey('Mod+/', true), '⌘/');
  });
});
