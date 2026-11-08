/**
 * 「版本」對比標籤的純函式（`media/src/editor/versionDiffCore.ts`，零 DOM）：按行比、逐字標、「用回這一處」的替換。
 * 畫出來、點按鈕、放回編輯區在 tests/dom/standalone/versions.test.js。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 按行比 | 三種分段格式裡一行就是一段：「段首縮排」不空行也能逐段比（合併檢視按空行切段，整章會成一段） |
 * | 空白 | 空行不算行、行首行尾空白不算不同；只差這些時 `onlyWhitespace` |
 * | 最短 | 隨機兩版：相同的行數等於 LCS，塊首尾相接蓋滿兩邊 |
 * | 逐字 | 刪掉的在左、加上的在右；夾在兩處改動中間的一兩個字並進改動；改得太多不標（給 undefined） |
 * | 用回這一處 | 兩邊都有、只有右邊（刪）、只有左邊（插回去，分隔照左邊原來的）、在開頭 / 結尾；逐處用回去還原出左邊 |
 * | 換行 | `\r\n` 歸一成 `\n`，下標與編輯區 `area.value` 同一套 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const { diffLines, onlyWhitespace, blockText, charDiff, revertEdit, MAX_CHAR_EDITS } = loadModule(
  'media/src/editor/versionDiffCore.ts'
);

/** 塊的樣子：['same' | 'change', 左邊幾行, 右邊幾行]。 */
const shape = (d) => d.blocks.map((b) => [b.kind, b.left[1] - b.left[0], b.right[1] - b.right[0]]);
const apply = (text, e) => text.slice(0, e.start) + e.text + text.slice(e.end);

describe('diffLines：按行比', () => {
  test('「段首縮排」格式：段與段之間不空行，照樣逐段比出改了哪一段', () => {
    const before = '　　他推開門。\n　　雨下了三天。\n　　燈還亮著。\n';
    const after = '　　他推開門。\n　　雨還在下。\n　　燈還亮著。\n';
    const d = diffLines(before, after);
    assert.deepEqual(shape(d), [
      ['same', 1, 1],
      ['change', 1, 1],
      ['same', 1, 1],
    ]);
    assert.equal(d.changes, 1);
    assert.equal(blockText(d, d.blocks[1], 'left'), '　　雨下了三天。');
    assert.equal(blockText(d, d.blocks[1], 'right'), '　　雨還在下。');
  });

  test('空行不算行、行首行尾空白不算不同：一鍵排版補的縮排、多一個空行都不是改動', () => {
    const d = diffLines('他推開門。\n\n雨下了三天。\n', '　　他推開門。\n\n\n　　雨下了三天。  \n');
    assert.equal(d.changes, 0);
    assert.equal(onlyWhitespace(d), true);
    assert.equal(onlyWhitespace(diffLines('一\n', '一\n')), false);
  });

  test('加了一段、刪了一段：一邊是空的', () => {
    const d = diffLines('甲\n乙\n丁\n', '甲\n乙\n丙\n丁\n');
    assert.deepEqual(shape(d), [
      ['same', 2, 2],
      ['change', 0, 1],
      ['same', 1, 1],
    ]);
    assert.deepEqual(shape(diffLines('甲\n乙\n丙\n', '乙\n丙\n')), [
      ['change', 1, 0],
      ['same', 2, 2],
    ]);
  });

  test('最短：隨機兩版，相同的行數等於 LCS，塊首尾相接蓋滿兩邊', () => {
    const lcs = (a, b) => {
      const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
      for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
          dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
      return dp[0][0];
    };
    let seed = 7;
    const rnd = (n) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let t = 0; t < 2000; t++) {
      const a = Array.from({ length: rnd(10) }, () => '甲乙丙'[rnd(3)]);
      const b = Array.from({ length: rnd(10) }, () => '甲乙丙'[rnd(3)]);
      const d = diffLines(a.join('\n'), b.join('\n'));
      let same = 0;
      let at = [0, 0];
      for (const blk of d.blocks) {
        assert.deepEqual([blk.left[0], blk.right[0]], at, JSON.stringify({ a, b }));
        at = [blk.left[1], blk.right[1]];
        if (blk.kind === 'same') {
          same += blk.left[1] - blk.left[0];
        }
      }
      assert.deepEqual(at, [a.length, b.length]);
      assert.equal(same, lcs(a, b), JSON.stringify({ a, b }));
    }
  });

  test('\\r\\n 歸一成 \\n：下標與編輯區 area.value 同一套', () => {
    const d = diffLines('甲\r\n乙\r\n', '甲\r\n丙\r\n');
    assert.equal(d.after, '甲\n丙\n');
    assert.deepEqual([d.right[1].start, d.right[1].end], [2, 3]);
  });
});

describe('charDiff：一處改動裡逐字標', () => {
  test('刪掉的在左、加上的在右（下標按那段文字）', () => {
    const m = charDiff('他推開門。', '他慢慢推開門。');
    assert.deepEqual(m, { left: [], right: [[1, 3]] });
  });

  test('夾在兩處改動中間的一兩個字並進改動：不把一句改寫切成碎片', () => {
    // 「雨下了三天」→「雨還在下」：中間碰巧相同的「下」不單獨留著。
    const m = charDiff('雨下了三天。', '雨還在下。');
    assert.deepEqual(m, { left: [[1, 5]], right: [[1, 4]] });
  });

  test('碼點算：emoji 不從中間切開', () => {
    const m = charDiff('好😀', '好😎');
    assert.deepEqual(m, { left: [[1, 3]], right: [[1, 3]] });
  });

  test('改得太多：給 undefined，只標整行', () => {
    const a = '甲'.repeat(MAX_CHAR_EDITS + 10);
    const b = '乙'.repeat(MAX_CHAR_EDITS + 10);
    assert.equal(charDiff(a, b), undefined);
  });
});

describe('revertEdit：用回這一處', () => {
  test('兩邊都有：右邊那幾行換成左邊那幾行（行首縮排照左邊的）', () => {
    const before = '　　甲。\n　　乙。\n　　丙。\n';
    const after = '　　甲。\n　　乙改。\n　　丙。\n';
    const d = diffLines(before, after);
    assert.equal(apply(d.after, revertEdit(d, d.blocks[1])), before);
  });

  test('只有右邊（現在多出來的）：連同前面那道分隔一起刪；在開頭就連同後面那道', () => {
    const d = diffLines('甲\n\n丙\n', '甲\n\n乙\n\n丙\n');
    assert.equal(apply(d.after, revertEdit(d, d.blocks[1])), '甲\n\n丙\n');
    const d2 = diffLines('乙\n\n丙\n', '甲\n\n乙\n\n丙\n');
    assert.equal(apply(d2.after, revertEdit(d2, d2.blocks[0])), '乙\n\n丙\n');
  });

  test('只有左邊（現在少了的）：插回前一行之後，分隔照左邊原來的；在開頭就插在第一行之前', () => {
    const d = diffLines('甲\n\n乙\n\n丙\n', '甲\n\n丙\n');
    assert.equal(apply(d.after, revertEdit(d, d.blocks[1])), '甲\n\n乙\n\n丙\n');
    const d2 = diffLines('甲\n\n乙\n', '乙\n');
    assert.equal(apply(d2.after, revertEdit(d2, d2.blocks[0])), '甲\n\n乙\n');
  });

  test('現在是空的：整份插回去', () => {
    const d = diffLines('甲\n乙\n', '');
    assert.equal(apply(d.after, revertEdit(d, d.blocks[0])), '甲\n乙');
  });

  test('逐處用回去（從後往前，下標不受前面影響）：還原出左邊', () => {
    const before = '一\n\n二\n\n三\n\n四\n\n五\n';
    const after = '一\n\n二改\n\n三\n\n新\n\n五\n\n六\n';
    const d = diffLines(before, after);
    let text = d.after;
    for (const blk of [...d.blocks].reverse()) {
      if (blk.kind === 'change') {
        text = apply(text, revertEdit(d, blk));
      }
    }
    assert.equal(text, '一\n\n二\n\n三\n\n四\n\n五\n');
  });
});
