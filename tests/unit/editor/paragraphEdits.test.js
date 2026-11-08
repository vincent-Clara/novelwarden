/**
 * 回車、段落快捷鍵、成對符號記錄的純函式（`media/src/editor/enter.ts` / `lines.ts` / `pairs.ts`）。
 * 編輯器裡的整條鏈路（按鍵、撤銷、輸入法、選單）在 tests/dom/standalone/ 的 enter / lineKeys / pairs，
 * 這裡只釘邊角。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const W = '　　';
const sel = (start, end = start) => ({ start, end });
/** 把一次替換套回原文，返回新文字與選區裡的字。 */
function run(value, edit) {
  const next = value.slice(0, edit.start) + edit.text + value.slice(edit.end);
  return { next, picked: next.slice(edit.selection.start, edit.selection.end), caret: edit.selection.start };
}

let E;
let L;
let P;
before(() => {
  E = loadModule('media/src/editor/enter.ts');
  L = loadModule('media/src/editor/lines.ts');
  P = loadModule('media/src/editor/pairs.ts');
});

describe('proseEnter', () => {
  test('空檔案回車：只換行', () => {
    assert.deepEqual(run('', E.proseEnter('', sel(0), 'indent')), { next: '\n', picked: '', caret: 1 });
  });

  test('游標在段首縮排的中間：整段往下推，游標落到字前面', () => {
    const value = `${W}他`;
    assert.deepEqual(run(value, E.proseEnter(value, sel(1), 'indent')), { next: `\n${W}他`, picked: '', caret: 3 });
  });

  test('選區跨兩行：兩行之間的字一起換掉', () => {
    const value = '甲乙\n丙丁';
    assert.equal(run(value, E.proseEnter(value, sel(1, 4), 'blank')).next, '甲\n\n丁');
  });
});

describe('markdownEnter', () => {
  test('游標在列表項中間：斷開，後半截接在新的列表項後面', () => {
    const value = '- 甲乙';
    assert.equal(run(value, E.markdownEnter(value, sel(3))).next, '- 甲\n- 乙');
  });

  test('1) 這種寫法也遞增', () => {
    const value = '9) 甲';
    assert.equal(run(value, E.markdownEnter(value, sel(4))).next, '9) 甲\n10) ');
  });

  test('游標在標記之前：不當列表，只沿用游標前那一截縮排', () => {
    const value = '  - 甲';
    assert.equal(run(value, E.markdownEnter(value, sel(1))).next, ' \n  - 甲');
  });
});

describe('moveLines', () => {
  test('往上換：中間的空行原地不動', () => {
    const value = '甲\n\n\n乙';
    assert.deepEqual(run(value, L.moveLines(value, sel(4), -1)), { next: '乙\n\n\n甲', picked: '', caret: 0 });
  });

  test('選區止於下一行行首：那一行不跟著走', () => {
    const value = '一\n二\n三';
    const r = run(value, L.moveLines(value, sel(0, 2), 1));
    assert.equal(r.next, '二\n一\n三');
    assert.equal(r.picked, '一\n');
  });

  test('到頂了：undefined', () => {
    assert.equal(L.moveLines('\n甲', sel(1), -1), undefined);
  });
});

describe('deleteLines', () => {
  test('刪第一段：後面的空行一起刪', () => {
    assert.equal(run('甲\n\n乙', L.deleteLines('甲\n\n乙', sel(0), true)).next, '乙');
  });

  test('前面空一行、後面緊跟正文：不刪空行（否則兩段粘在一起）', () => {
    assert.equal(run('甲\n\n乙\n丙', L.deleteLines('甲\n\n乙\n丙', sel(3), true)).next, '甲\n\n丙');
  });

  test('文末帶換行：刪最後一段，留下恰好一個換行', () => {
    assert.equal(run('甲\n\n乙\n', L.deleteLines('甲\n\n乙\n', sel(3), true)).next, '甲\n');
  });

  test('刪光了：空檔案', () => {
    assert.deepEqual(run('甲', L.deleteLines('甲', sel(0), true)), { next: '', picked: '', caret: 0 });
  });
});

describe('duplicateLines', () => {
  test('全是空行：undefined', () => {
    assert.equal(L.duplicateLines('甲\n\n乙', sel(2), 1, '\n'), undefined);
  });
});

describe('mapPair：自動補的那一對跟著改動挪', () => {
  const pair = { left: 2, right: 5, open: '“', close: '”' };

  test('在左半邊之前插字：兩個都往後推', () => {
    assert.deepEqual(P.mapPair(pair, { at: 2, removed: '', inserted: '甲' }), { ...pair, left: 3, right: 6 });
  });

  test('在中間（含右半邊之前）插字：只推右半邊', () => {
    assert.deepEqual(P.mapPair(pair, { at: 5, removed: '', inserted: '甲乙' }), { ...pair, right: 7 });
  });

  test('刪掉的一段碰到了右半邊：作廢', () => {
    assert.equal(P.mapPair(pair, { at: 4, removed: '甲”', inserted: '' }), undefined);
  });

  test('改動在右半邊之後：不動', () => {
    assert.deepEqual(P.mapPair(pair, { at: 6, removed: '甲', inserted: '' }), pair);
  });
});

describe('shouldAutoClose', () => {
  test('行尾、文末、空白、收尾的標點之前補；正文之前不補', () => {
    assert.deepEqual(
      [undefined, '\n', ' ', '。', '”', '）', '他', 'a'].map((c) => P.shouldAutoClose(c)),
      [true, true, true, true, true, true, false, false]
    );
  });
});
