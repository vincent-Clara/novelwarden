/**
 * 思考深度的檔位表與兩家的欄位對映。
 *
 * 三條硬約束在這裡釘住：
 * - **「不思考」是不帶欄位**（兩家的對映都返回 undefined）——顯式關掉的寫法
 *   兩家都只有部分模型認，而「不帶」在所有模型上都合法，也正是這個功能出現
 *   之前的行為；
 * - **介面只有一個「極限」，兩家的名字不同**（OpenAI 是 `xhigh`，Anthropic 是
 *   `max`）：作者選的是「想到底」，不是某家的列舉值；
 * - **手動預算必須小於輸出上限且不低於 1024**，裝不下就不帶思考欄位，而不是
 *   發一個必然 400 的請求。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

let m;
before(() => {
  m = loadModule('src/core/model/thinking.ts');
});

describe('model/thinking · 檔位表', () => {
  test('五檔，順序由淺到深', () => {
    assert.deepEqual(m.THINKING_DEPTHS, ['off', 'low', 'medium', 'high', 'max']);
  });

  // 第 4 條：思考 token 按輸出計費，得作者主動選才開。
  test('預設不思考', () => {
    assert.equal(m.DEFAULT_THINKING_DEPTH, 'off');
  });

  test('每一檔都有說法與提示', () => {
    for (const depth of m.THINKING_DEPTHS) {
      assert.ok(m.THINKING_LABEL[depth], depth);
      assert.ok(m.THINKING_HINT[depth], depth);
    }
  });

  test('認不出的值一律回落「不思考」，不拋', () => {
    assert.equal(m.normalizeThinkingDepth('deep'), 'off');
    assert.equal(m.normalizeThinkingDepth(undefined), 'off');
    assert.equal(m.normalizeThinkingDepth(3), 'off');
    assert.equal(m.normalizeThinkingDepth('high'), 'high');
    assert.equal(m.isThinkingDepth('max'), true);
    assert.equal(m.isThinkingDepth('ultra'), false);
  });
});

describe('model/thinking · 兩家的欄位對映', () => {
  test('不思考時兩家都不帶欄位', () => {
    assert.equal(m.responsesEffort('off'), undefined);
    assert.equal(m.anthropicEffort('off'), undefined);
    assert.equal(m.thinkingBudget('off', 16000), undefined);
  });

  test('低 / 中 / 深三檔兩家同名', () => {
    for (const depth of ['low', 'medium', 'high']) {
      assert.equal(m.responsesEffort(depth), depth);
      assert.equal(m.anthropicEffort(depth), depth);
    }
  });

  test('極限檔在兩家的名字不同', () => {
    assert.equal(m.responsesEffort('max'), 'xhigh');
    assert.equal(m.anthropicEffort('max'), 'max');
  });
});

describe('model/thinking · 手動預算按輸出上限收緊', () => {
  test('上限夠時用檔位自己的預算', () => {
    assert.equal(m.thinkingBudget('low', 32000), 4096);
    assert.equal(m.thinkingBudget('medium', 32000), 10240);
  });

  // 預算必須小於 max_tokens（思考 token 算在輸出上限裡），留 1024 給正文。
  test('上限不夠時按上限收緊', () => {
    assert.equal(m.thinkingBudget('max', 4000), 4000 - 1024);
    assert.equal(m.thinkingBudget('high', 8000), 8000 - 1024);
  });

  test('連 1024 都留不出來時不帶思考欄位', () => {
    assert.equal(m.thinkingBudget('max', 2047), undefined);
    assert.equal(m.thinkingBudget('low', 1024), undefined);
  });
});

describe('model/thinking · 降檔', () => {
  // 上游不認某個 effort 值時退一步再試，而不是把這一輪判死。
  test('逐檔往下退，到不思考為止', () => {
    assert.equal(m.downgradeDepth('max'), 'high');
    assert.equal(m.downgradeDepth('high'), 'medium');
    assert.equal(m.downgradeDepth('medium'), 'low');
    assert.equal(m.downgradeDepth('low'), 'off');
    assert.equal(m.downgradeDepth('off'), 'off');
  });
});
