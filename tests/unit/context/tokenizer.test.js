/**
 * token 估算與按預算擷取。遷自 scripts/smoke.js 的 `== tokenizer.ts ==` 一節。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT, loadModule } = require('../../helpers/load');

const SAMPLE = path.join(ROOT, 'sample-novel');

describe('tokenizer.ts', () => {
  let tk;
  let text;

  before(() => {
    tk = loadModule('src/core/context/tokenizer.ts');
    // 取一段真實正文（`chapters/` 是裝配器實際要按預算截的那一份），
    // 而不是細綱那種短小的結構化文字。
    text = fs.readFileSync(path.join(SAMPLE, 'chapters/002-客栈里的女人.md'), 'utf8');
  });

  test('空串為 0', () => {
    assert.equal(tk.estimateTokens(''), 0);
  });

  test('中文按 1.5x 估算', () => {
    assert.equal(tk.estimateTokens('雨下了三天'), Math.ceil(5 * 1.5));
  });

  test('英文按 4 字元估算', () => {
    assert.equal(tk.estimateTokens('abcdefgh'), 2);
  });

  test('中文估算高於英文同長度', () => {
    assert.ok(tk.estimateTokens('一二三四') > tk.estimateTokens('abcd'));
  });

  test('示例正文 token 數量級合理（500~2000）', () => {
    const full = tk.estimateTokens(text);
    assert.ok(full > 500 && full < 2000, `got ${full}`);
  });

  describe('takeTail', () => {
    test('takeTail 不超預算', () => {
      const tail = tk.takeTail(text, 100);
      assert.ok(tk.estimateTokens(tail) <= 100, `got ${tk.estimateTokens(tail)}`);
    });

    test('takeTail 取的是結尾', () => {
      const tail = tk.takeTail(text, 100);
      assert.ok(text.trimEnd().endsWith(tail.trimEnd().slice(-20)));
    });

    test('takeTail 不足預算時原樣返回', () => {
      assert.equal(tk.takeTail('短文字', 1000), '短文字');
    });
  });

  describe('takeHead', () => {
    test('takeHead 帶截斷標記', () => {
      // 不靜默截斷：降級/丟棄必須留下痕跡。
      assert.ok(tk.takeHead(text, 100).includes('因上下文預算截斷'));
    });

    test('takeHead 取的是開頭', () => {
      assert.ok(tk.takeHead(text, 100).startsWith(text.slice(0, 40)));
    });

    test('takeHead 不足預算時原樣返回', () => {
      assert.equal(tk.takeHead('短文字', 1000), '短文字');
    });
  });
});
