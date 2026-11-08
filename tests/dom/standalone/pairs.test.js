/**
 * 成對符號自動補全（`media/src/editor/pairs.ts`）。
 *
 * 中文標點多半是輸入法打出來的，keydown 裡看不到那個字，所以補全掛在「內容變了」上：鍵盤打字
 * （`insertText`）與輸入法上屏（`compositionend`）兩條路都要測。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 敲左半邊 | 補右半邊、游標停中間，一次撤銷兩個一起退 |
 * | 輸入法上屏左半邊 | 同上 |
 * | 有選區時敲左半邊（鍵盤 / 輸入法） | 把選中的字包起來，之後選中被包的那段 |
 * | 緊挨著自動補的右半邊再敲同一個右半邊 | 跳過不重複（輸入法交替出 “ ” 時也吸收） |
 * | 剛補完就退格 | 左右一起刪 |
 * | 游標後面緊跟著正文 | 不補（⚑） |
 * | 不是自動補的右半邊 | 不跳過 |
 * | Markdown 也補、json 不補 | 只對正文與 Markdown |
 * | 撤銷之後 | 記著的那幾對作廢，不誤刪 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file } = require('../../helpers/dom');

function harness() {
  const ui = mount({ body: 'standalone', scripts: ['editor.js'], shims: ['pointerCapture', 'confirm'] });
  const area = () => ui.doc.getElementById('edArea');
  const fire = (inputType, extra) =>
    area().dispatchEvent(new ui.window.InputEvent('input', { bubbles: true, inputType, ...extra }));
  const h = {
    ui,
    area,
    open(path, text, kind) {
      ui.post({ type: 'editorOpen', file: file(path, text, kind ? { kind } : undefined) });
    },
    select(start, end = start) {
      area().setSelectionRange(start, end);
    },
    /** 鍵盤打字：一下一個字，蓋掉選區。 */
    type(text) {
      for (const ch of text) {
        const a = area();
        const s = a.selectionStart;
        a.value = a.value.slice(0, s) + ch + a.value.slice(a.selectionEnd);
        a.setSelectionRange(s + ch.length, s + ch.length);
        fire('insertText', { data: ch });
      }
    },
    /** 輸入法：組字幾步，最後上屏 `commit`（蓋掉組字開始時的選區）。 */
    ime(steps, commit) {
      const a = area();
      const start = a.selectionStart;
      const end = a.selectionEnd;
      const before = a.value;
      a.dispatchEvent(new ui.window.CompositionEvent('compositionstart', { bubbles: true }));
      for (const step of [...steps, commit]) {
        a.value = before.slice(0, start) + step + before.slice(end);
        a.setSelectionRange(start + step.length, start + step.length);
        fire('insertCompositionText', { isComposing: true });
      }
      a.dispatchEvent(new ui.window.CompositionEvent('compositionend', { bubbles: true, data: commit }));
    },
    backspace() {
      const a = area();
      const s = a.selectionStart;
      a.value = a.value.slice(0, s - 1) + a.value.slice(s);
      a.setSelectionRange(s - 1, s - 1);
      fire('deleteContentBackward');
    },
    undo() {
      area().dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    },
    caret: () => area().selectionStart,
    selected: () => area().value.slice(area().selectionStart, area().selectionEnd),
  };
  return h;
}

describe('成對符號：正文', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
  });

  test('鍵盤敲出左半邊：補右半邊，游標停在中間', () => {
    h.open('chapters/001-雨夜.md', '他說：', 'chapter');
    h.select(3);
    h.type('“');
    assert.equal(h.area().value, '他說：“”');
    assert.equal(h.caret(), 4);
  });

  test('補的那一下與那次輸入算一步撤銷', () => {
    h.undo();
    assert.equal(h.area().value, '他說：');
  });

  test('八對都補', () => {
    h.open('chapters/002-八對.md', '', 'chapter');
    for (const [l, r] of ['“”', '‘’', '「」', '『』', '（）', '《》', '【】', '〈〉']) {
      h.select(h.area().value.length);
      h.type(l);
      assert.equal(h.area().value.slice(-2), l + r, l);
      h.select(h.area().value.length);
    }
  });

  test('半形括號不補', () => {
    h.open('chapters/003-半形.md', '', 'chapter');
    h.type('(');
    assert.equal(h.area().value, '(');
  });

  test('輸入法上屏左半邊：也補', () => {
    h.open('chapters/004-輸入法.md', '他說：', 'chapter');
    h.select(3);
    h.ime([], '“');
    assert.equal(h.area().value, '他說：“”');
    assert.equal(h.caret(), 4);
    h.undo();
    assert.equal(h.area().value, '他說：', '上屏與補的那一下一步退掉');
  });

  test('有選區時敲左半邊：把選中的字包起來，之後選中被包的那段', () => {
    h.open('chapters/005-包裹.md', '他說你好吧', 'chapter');
    h.select(2, 4);
    h.type('“');
    assert.equal(h.area().value, '他說“你好”吧');
    assert.equal(h.selected(), '你好');
    h.undo();
    assert.equal(h.area().value, '他說你好吧');
    assert.equal(h.selected(), '你好', '撤銷回到包之前的選區');
  });

  test('輸入法上屏時也包得起來', () => {
    h.open('chapters/006-包裹.md', '書名是青雲劍錄', 'chapter');
    h.select(3, 7);
    h.ime([], '《');
    assert.equal(h.area().value, '書名是《青雲劍錄》');
    assert.equal(h.selected(), '青雲劍錄');
  });

  test('緊挨著自動補的右半邊再敲同一個右半邊：跳過，不重複', () => {
    h.open('chapters/007-跳過.md', '', 'chapter');
    h.type('“你好');
    assert.equal(h.area().value, '“你好”');
    h.type('”');
    assert.equal(h.area().value, '“你好”');
    assert.equal(h.caret(), 4, '游標挪到右半邊後面');
  });

  test('輸入法交替出的 ” 也吸收', () => {
    h.open('chapters/008-交替.md', '他說：', 'chapter');
    h.select(3);
    h.ime([], '“');
    h.ime(['ni', 'nihao'], '你好');
    assert.equal(h.area().value, '他說：“你好”');
    h.ime([], '”');
    assert.equal(h.area().value, '他說：“你好”');
    assert.equal(h.caret(), 7);
  });

  test('剛補完、中間還空著就退格：左右一起刪，一步撤銷', () => {
    h.open('chapters/009-退格.md', '他說', 'chapter');
    h.select(2);
    h.type('「');
    assert.equal(h.area().value, '他說「」');
    h.backspace();
    assert.equal(h.area().value, '他說');
    assert.equal(h.caret(), 2);
    h.undo();
    assert.equal(h.area().value, '他說「」');
  });

  test('中間有字時退格刪左半邊：只刪左半邊', () => {
    h.open('chapters/010-退格.md', '', 'chapter');
    h.type('「甲');
    h.select(1);
    h.backspace();
    assert.equal(h.area().value, '甲」');
  });

  test('游標後面緊跟著正文：不補（⚑）', () => {
    h.open('chapters/011-前面.md', '你好', 'chapter');
    h.select(0);
    h.type('“');
    assert.equal(h.area().value, '“你好');
  });

  test('游標後面是標點：補', () => {
    h.open('chapters/012-標點.md', '他說。', 'chapter');
    h.select(2);
    h.type('“');
    assert.equal(h.area().value, '他說“”。');
  });

  test('不是自動補的右半邊：照常打進去，不跳過', () => {
    h.open('chapters/013-手打.md', '“你好”', 'chapter');
    h.select(3);
    h.type('”');
    assert.equal(h.area().value, '“你好””');
  });

  test('撤銷之後記著的那幾對作廢：再敲右半邊不吞字', () => {
    h.open('chapters/014-撤銷.md', '', 'chapter');
    h.type('“');
    h.type('好');
    h.undo();
    assert.equal(h.area().value, '“”');
    h.select(1);
    h.type('”');
    assert.equal(h.area().value, '“””');
  });
});

describe('成對符號：別的檔案', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
  });

  test('Markdown（角色卡）也補', () => {
    h.open('.novelwarden/characters/林昭.md', '口頭禪：', 'character');
    h.select(4);
    h.type('“');
    assert.equal(h.area().value, '口頭禪：“”');
  });

  test('json 不補', () => {
    h.open('data.json', '', undefined);
    h.type('“');
    assert.equal(h.area().value, '“');
  });

  test('yml 不補', () => {
    h.open('a.yml', '', undefined);
    h.type('（');
    assert.equal(h.area().value, '（');
  });
});
