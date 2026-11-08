/**
 * 快捷鍵表（`media/src/editor/shortcuts.ts`，純資料 + 純函式）：沒有撞車的鍵、每一條都有分組與說明、平臺顯示
 * （Windows / Linux 寫 `Ctrl+Shift+F`，Mac 寫 `⇧⌘F`）、按法怎麼認（`matchesKey`）、篩選與分組。README 那張快捷鍵表
 * 與這張表逐條對得上在 shortcutsReadme.test.js。
 *
 * 「表裡每一條都真的有人處理、被接走的每一下都在表裡」要真的按鍵，在 tests/dom/standalone/shortcuts.test.js。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const {
  SHORTCUTS,
  SHORTCUT_GROUPS,
  filterShortcuts,
  formatKey,
  formatKeys,
  groupShortcuts,
  isMacPlatform,
  keyName,
  matchesKey,
  parseKey,
  primaryKey,
  scopeText,
  shortcutById,
  shortcutLabel,
} = loadModule('media/src/editor/shortcuts.ts');

/** 按法規範化：修飾鍵排好序（`Shift+Alt+Up` 與 `Alt+Shift+Up` 是同一種）。 */
const norm = (spec) => {
  const k = parseKey(spec);
  return [k.mod && 'Mod', k.ctrl && 'Ctrl', k.alt && 'Alt', k.shift && 'Shift', k.key].filter(Boolean).join('+');
};
/** 同時會收到按鍵的幾檔：正文裡三檔都收得到，頁面上收得到 global 與 workbench。 */
const OVERLAPPING = new Set(['global', 'workbench', 'editor']);

describe('快捷鍵表：每一條都寫全了', () => {
  test('id 不重複', () => {
    const ids = SHORTCUTS.map((s) => s.id);
    assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
  });

  test('每一條都有分組（在分組表裡）、說明、至少一種按法', () => {
    const bad = SHORTCUTS.filter(
      (s) => !SHORTCUT_GROUPS.includes(s.group) || !s.label.trim() || s.keys.length === 0
    ).map((s) => s.id);
    assert.deepEqual(bad, []);
  });

  test('「某個面板裡」那一檔都寫了在哪兒；別的檔按檔說', () => {
    assert.deepEqual(
      SHORTCUTS.filter((s) => !scopeText(s)).map((s) => s.id),
      []
    );
    assert.equal(scopeText(shortcutById('save')), '哪裡都行');
    assert.equal(scopeText(shortcutById('find')), '編輯區裡或頁面上');
    assert.equal(scopeText(shortcutById('undo')), '游標在編輯區裡');
    assert.equal(scopeText(shortcutById('findBoxNext')), '查詢條的查詢框裡');
  });

  test('每一種按法都寫得對：認得出的修飾鍵、最後一段是鍵', () => {
    const bad = [];
    for (const s of SHORTCUTS) {
      for (const spec of [...s.keys, ...(s.also ?? [])]) {
        const parts = spec.split('+');
        const key = parts.pop();
        if (!key || parts.some((m) => !['Mod', 'Ctrl', 'Alt', 'Shift'].includes(m))) {
          bad.push(`${s.id}:${spec}`);
        }
      }
    }
    assert.deepEqual(bad, []);
  });

  test('沒有撞車的鍵：正文裡、頁面上同時收得到的那幾檔之間一種按法只歸一條；同一個面板裡也是', () => {
    const seen = new Map();
    const clashes = [];
    for (const s of SHORTCUTS) {
      const context = OVERLAPPING.has(s.scope) ? '編輯區與頁面' : s.where;
      for (const spec of [...s.keys, ...(s.also ?? [])]) {
        const key = `${context}|${norm(spec)}`;
        if (seen.has(key)) {
          clashes.push(`${seen.get(key)} 與 ${s.id}：${spec}`);
        }
        seen.set(key, s.id);
      }
    }
    assert.deepEqual(clashes, []);
  });

  test('瀏覽器自己的那幾樣（剪下 / 複製 / 貼上 / 全選）標著 native；瀏覽器攔不住的寫明瞭', () => {
    assert.deepEqual(
      SHORTCUTS.filter((s) => s.native).map((s) => s.id),
      ['cut', 'copy', 'paste', 'selectAll']
    );
    for (const id of ['closeTab', 'newFile']) {
      assert.match(shortcutById(id).note, /瀏覽器多半攔不住/, id);
    }
  });

  test('分組的順序就是面板與 README 的順序，組裡按表裡的先後', () => {
    const groups = groupShortcuts(SHORTCUTS);
    assert.deepEqual(
      groups.map((g) => g.group),
      SHORTCUT_GROUPS.filter((g) => SHORTCUTS.some((s) => s.group === g))
    );
    assert.deepEqual(groups[0].items.map((s) => s.id).slice(0, 2), ['quickOpen', 'save']);
  });
});

describe('快捷鍵表：按平臺寫', () => {
  test('Windows / Linux：Ctrl、Shift、Alt 用加號連，Mod 寫 Ctrl', () => {
    assert.equal(formatKey('Mod+Shift+F', false), 'Ctrl+Shift+F');
    assert.equal(formatKey('Shift+Alt+Down', false), 'Shift+Alt+↓');
    assert.equal(formatKey('Alt+/', false), 'Alt+/');
    assert.equal(formatKey('Ctrl+Y', false), 'Ctrl+Y');
    assert.equal(formatKey('F8', false), 'F8');
    assert.equal(formatKey('Escape', false), 'Esc');
    assert.equal(formatKey('Mod+Enter', false), 'Ctrl+Enter');
  });

  test('Mac：⌃⌥⇧⌘ 的順序、不用加號，Mod 寫 ⌘、Alt 寫 ⌥、Control 寫 ⌃，回車寫 ↩', () => {
    assert.equal(formatKey('Mod+Shift+F', true), '⇧⌘F');
    assert.equal(formatKey('Shift+Alt+Down', true), '⌥⇧↓');
    assert.equal(formatKey('Alt+/', true), '⌥/');
    assert.equal(formatKey('Ctrl+Y', true), '⌃Y');
    assert.equal(formatKey('Mod+Enter', true), '⌘↩');
    assert.equal(formatKey('F8', true), 'F8');
  });

  test('幾種按法「 / 」隔開；選單上寫第一種，Mac 上優先不用 Control 的那一種', () => {
    const redo = shortcutById('redo');
    assert.equal(formatKeys(redo, false), 'Ctrl+Y / Ctrl+Shift+Z');
    assert.equal(primaryKey(redo, false), 'Ctrl+Y');
    assert.equal(primaryKey(redo, true), 'Mod+Shift+Z');
    assert.equal(shortcutLabel('redo', false), 'Ctrl+Y');
    assert.equal(shortcutLabel('redo', true), '⇧⌘Z');
    assert.equal(shortcutLabel('save', true), '⌘S');
    assert.equal(shortcutLabel('names', true), '⌥/');
  });

  test('認 Mac：platform / userAgentData / userAgent 裡的 Mac、iPhone、iPad；別的都不是', () => {
    assert.equal(isMacPlatform({ platform: 'MacIntel' }), true);
    assert.equal(isMacPlatform({ userAgentData: { platform: 'macOS' } }), true);
    assert.equal(isMacPlatform({ platform: 'iPad' }), true);
    assert.equal(isMacPlatform({ platform: '', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' }), true);
    assert.equal(isMacPlatform({ platform: 'Win32' }), false);
    assert.equal(isMacPlatform({ platform: 'Linux x86_64' }), false);
    assert.equal(isMacPlatform(undefined), false);
  });
});

describe('快捷鍵表：按法怎麼認', () => {
  const ev = (key, mods = {}, code) => ({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

  test('Mod 認 Ctrl 或 ⌘，兩樣都沒按不算；寫了 Ctrl 的只認 Control', () => {
    assert.equal(matchesKey(ev('s', { ctrlKey: true }), 'Mod+S'), true);
    assert.equal(matchesKey(ev('s', { metaKey: true }), 'Mod+S'), true);
    assert.equal(matchesKey(ev('s'), 'Mod+S'), false);
    assert.equal(matchesKey(ev('y', { ctrlKey: true }), 'Ctrl+Y'), true);
    assert.equal(matchesKey(ev('y', { metaKey: true }), 'Ctrl+Y'), false);
  });

  test('沒寫的修飾鍵不許按：Ctrl+Shift+S、Ctrl+Alt+S 都不是 Mod+S；F8 帶 Shift 不是 F8', () => {
    assert.equal(matchesKey(ev('S', { ctrlKey: true, shiftKey: true }), 'Mod+S'), false);
    assert.equal(matchesKey(ev('s', { ctrlKey: true, altKey: true }), 'Mod+S'), false);
    assert.equal(matchesKey(ev('F8', { shiftKey: true }), 'F8'), false);
    assert.equal(matchesKey(ev('a', { ctrlKey: true }), 'Alt+/'), false);
  });

  test('字母不分大小寫（按著 Shift 時 key 是大寫）；方向鍵、Esc 認瀏覽器的寫法', () => {
    assert.equal(matchesKey(ev('F', { ctrlKey: true, shiftKey: true }), 'Mod+Shift+F'), true);
    assert.equal(matchesKey(ev('ArrowUp', { altKey: true }), 'Alt+Up'), true);
    assert.equal(matchesKey(ev('Esc'), 'Escape'), true);
    assert.equal(keyName(ev('ArrowDown')), 'Down');
  });

  test('按著 Alt（Mac 上 ⌥）打出的是特殊字元：看 code（⌥/ 打出 ÷ 也認 Alt+/）', () => {
    assert.equal(matchesKey(ev('÷', { altKey: true }, 'Slash'), 'Alt+/'), true);
    assert.equal(matchesKey(ev('?', { altKey: true, shiftKey: true }, 'Slash'), 'Alt+/'), false);
  });

  test('加號寫 Plus：Shift 打出來的「+」與小鍵盤的加號都認，不看 Shift', () => {
    assert.equal(matchesKey(ev('+', { ctrlKey: true, shiftKey: true }), 'Mod+Plus'), true);
    assert.equal(matchesKey(ev('+', { ctrlKey: true }, 'NumpadAdd'), 'Mod+Plus'), true);
    assert.equal(matchesKey(ev('=', { ctrlKey: true }), 'Mod+='), true);
  });
});

describe('快捷鍵表：篩選', () => {
  test('空的篩選串給全部', () => {
    assert.equal(filterShortcuts(SHORTCUTS, '  ').length, SHORTCUTS.length);
  });

  test('按說明、在哪兒、補充說明、分組篩，不分大小寫；空白隔開的幾段都得有', () => {
    assert.deepEqual(
      filterShortcuts(SHORTCUTS, '撤銷').map((s) => s.id),
      ['undo']
    );
    assert.ok(filterShortcuts(SHORTCUTS, '段落').every((s) => /段/.test(`${s.label}${s.group}${s.note ?? ''}`)));
    assert.deepEqual(
      filterShortcuts(SHORTCUTS, '查詢 下一處').map((s) => s.id),
      ['findNext', 'findBoxNext', 'replaceBoxEnter']
    );
  });

  test('按鍵篩：兩種平臺的寫法都認（Ctrl+Shift+F 與 ⇧⌘F）', () => {
    assert.deepEqual(
      filterShortcuts(SHORTCUTS, 'ctrl+shift+f').map((s) => s.id),
      ['bookFind']
    );
    assert.deepEqual(
      filterShortcuts(SHORTCUTS, '⇧⌘F').map((s) => s.id),
      ['bookFind']
    );
    assert.deepEqual(
      filterShortcuts(SHORTCUTS, 'F8').map((s) => s.id),
      ['focusMode']
    );
  });
});
