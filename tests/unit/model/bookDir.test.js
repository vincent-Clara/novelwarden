/**
 * 新建一本書時資料夾叫什麼（`src/core/model/bookDir.ts`）。表單上預覽的路徑與後端真建的是同一個名字，
 * 建書本身在 tests/integration/workspace/newProject.test.js。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 照抄書名 | 中文、空格原樣留著（書名裡的空格是作者的） |
 * | 刪字 | 各平臺檔名裡不許有的字刪掉；開頭的點、結尾的點與空格去掉 |
 * | 空串 | 刪完什麼都不剩時是空串，呼叫方據此報錯 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const { bookDirName } = loadModule('src/core/model/bookDir.ts');

describe('bookDirName', () => {
  test('照抄書名：中文、中間的空格原樣留著，兩頭空白去掉', () => {
    assert.equal(bookDirName('青雲劍錄'), '青雲劍錄');
    assert.equal(bookDirName('  The Long Night  '), 'The Long Night');
  });

  test('檔名裡不許有的字刪掉', () => {
    assert.equal(bookDirName('青雲/劍錄:卷一?'), '青雲劍錄卷一');
    assert.equal(bookDirName('a\\b*c"d<e>f|g'), 'abcdefg');
  });

  test('開頭的點（隱藏資料夾）、結尾的點與空格（Windows 不認）去掉', () => {
    assert.equal(bookDirName('..雪夜'), '雪夜');
    assert.equal(bookDirName('雪夜...'), '雪夜');
    assert.equal(bookDirName('雪夜. .'), '雪夜');
  });

  test('刪完什麼都不剩：空串', () => {
    assert.equal(bookDirName('???'), '');
    assert.equal(bookDirName('..'), '');
    assert.equal(bookDirName('   '), '');
  });
});
