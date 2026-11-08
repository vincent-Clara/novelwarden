/**
 * 段級 diff（W11）：合併檢視按段對齊兩個版本。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 相同的段連成一截，相鄰的增刪改併成一處 | 一段改寫 = 刪一段 + 加一段，挨著的就是同一處 |
 * | 只差空白的兩段算同一段 | 不值得讓作者為一個換行點一次「採用」 |
 * | 組合合併結果：沒給的用新版、空的整段刪 | 合併檢視交回去的就是這一份 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const d = loadModule('src/core/model/paragraphDiff.ts');

describe('paragraphDiff.ts · 切段', () => {
  test('按空行切，段內換行保留，首尾空白去掉', () => {
    assert.deepEqual(d.splitParagraphs('\n\n甲\n乙\n\n  \n丙  \n\n\n'), ['甲\n乙', '丙']);
  });

  test('CRLF 照認', () => {
    assert.deepEqual(d.splitParagraphs('甲\r\n\r\n乙'), ['甲', '乙']);
  });
});

describe('paragraphDiff.ts · diff', () => {
  test('一模一樣：一截 same', () => {
    assert.deepEqual(d.diffParagraphs('甲\n\n乙', '甲\n\n乙'), [{ kind: 'same', paragraphs: ['甲', '乙'] }]);
  });

  test('改了中間一段：刪一段 + 加一段併成一處', () => {
    assert.deepEqual(d.diffParagraphs('甲\n\n乙\n\n丙', '甲\n\n乙二\n\n丙'), [
      { kind: 'same', paragraphs: ['甲'] },
      { kind: 'change', old: ['乙'], new: ['乙二'] },
      { kind: 'same', paragraphs: ['丙'] },
    ]);
  });

  test('只增、只刪', () => {
    assert.deepEqual(d.diffParagraphs('甲\n\n丙', '甲\n\n乙\n\n丙')[1], { kind: 'change', old: [], new: ['乙'] });
    assert.deepEqual(d.diffParagraphs('甲\n\n乙\n\n丙', '甲\n\n丙')[1], { kind: 'change', old: ['乙'], new: [] });
  });

  test('兩處不相鄰的改動是兩處', () => {
    const segs = d.diffParagraphs('一\n\n二\n\n三\n\n四', '一改\n\n二\n\n三\n\n四改');
    assert.equal(d.changeCount(segs), 2);
  });

  test('只差空白的兩段算同一段，文字取新版', () => {
    const segs = d.diffParagraphs('甲 乙', '甲乙');
    assert.deepEqual(segs, [{ kind: 'same', paragraphs: ['甲乙'] }]);
  });

  test('一邊是空的', () => {
    assert.deepEqual(d.diffParagraphs('', '甲'), [{ kind: 'change', old: [], new: ['甲'] }]);
    assert.deepEqual(d.diffParagraphs('', ''), []);
  });
});

describe('paragraphDiff.ts · 拼結果', () => {
  const segs = d.diffParagraphs('甲\n\n乙\n\n丙', '甲\n\n乙二\n\n丙');

  test('沒給結果的用新版', () => {
    assert.equal(d.joinMerge(segs), '甲\n\n乙二\n\n丙\n');
  });

  test('保留原文 / 手改 / 整段刪', () => {
    assert.equal(d.joinMerge(segs, { 1: d.sideText(segs[1], 'old') }), '甲\n\n乙\n\n丙\n');
    assert.equal(d.joinMerge(segs, { 1: '作者自己寫的' }), '甲\n\n作者自己寫的\n\n丙\n');
    assert.equal(d.joinMerge(segs, { 1: '' }), '甲\n\n丙\n');
  });
});
