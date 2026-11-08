/**
 * Tab / Shift+Tab 縮排的純函式（`media/src/editor/indent.ts`）。編輯器裡的整條鏈路
 * （按鍵、縮排單位、撤銷、輸入法）在 tests/dom/standalone/indent.test.js，這裡只釘邊角。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const { indentLines, outdentLines } = loadModule('media/src/editor/indent.ts');

const W = '　';
const sel = (start, end = start) => ({ start, end });
/** 把一次縮排的結果套回原文，返回新文字與新選區裡的字。 */
function run(value, edit) {
  const next = value.slice(0, edit.start) + edit.text + value.slice(edit.end);
  return { next, picked: next.slice(edit.selection.start, edit.selection.end) };
}

describe('indentLines', () => {
  test('只有空白的行也跳過', () => {
    const value = `甲\n${W}\n乙`;
    const { next } = run(value, indentLines(value, sel(0, value.length), '  '));
    assert.equal(next, `  甲\n${W}\n  乙`);
  });

  test('碰到的全是空行：不動', () => {
    assert.equal(indentLines('\n\n', sel(0, 2), '  '), undefined);
  });

  test('選區從第一行中間起：起點跟著平移', () => {
    const value = '甲乙丙\n丁';
    const r = run(value, indentLines(value, sel(1, 5), '  '));
    assert.equal(r.next, '  甲乙丙\n  丁');
    assert.equal(r.picked, '乙丙\n  丁');
  });

  test('開頭就是換行時，第一行認得對', () => {
    const value = '\n甲';
    const r = run(value, indentLines(value, sel(0, 2), '  '));
    assert.equal(r.next, '\n  甲');
  });
});

describe('outdentLines', () => {
  test('游標在被去掉的縮排中間：挪到行首', () => {
    const value = `${W}${W}甲`;
    const edit = outdentLines(value, sel(1));
    assert.equal(edit.text, '甲');
    assert.deepEqual(edit.selection, sel(0));
  });

  test('第一行在文首、游標在 0：去的是第一行', () => {
    const value = '  甲\n  乙';
    const r = run(value, outdentLines(value, sel(0)));
    assert.equal(r.next, '甲\n  乙');
  });

  test('一處都沒去：返回 undefined', () => {
    assert.equal(outdentLines('甲\n乙', sel(0, 3)), undefined);
  });
});
