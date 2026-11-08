/**
 * 可替換的 token 計數器：註冊/切換、`prepare` 拋錯時不帶崩、用量校準統計。
 * 遷自 scripts/smoke.js 的 `== tokenCounter.ts · 可替換實現 ==` 一節。
 *
 * 這一節改的是模組級單例，用例之間有先後依賴——node:test 同檔案內預設序列執行，
 * 順序與遷移前一致。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

describe('tokenCounter.ts · 可替換實現', () => {
  let tc;
  /** 切換計數器之前，預設實現對同一段文字給出的結果，供「切回來」時比對。 */
  let before預設;

  before(() => {
    tc = loadModule('src/core/context/tokenCounter.ts');
  });

  describe('預設實現', () => {
    test('預設計數器是啟發式的', () => {
      assert.equal(tc.activeTokenCounter().id, 'heuristic');
    });

    test('預設計數器自述為估算', () => {
      assert.equal(tc.activeTokenCounter().accuracy, 'estimate');
    });

    test('登入檔裡有預設實現', () => {
      assert.ok(tc.listTokenCounters().some((c) => c.id === 'heuristic'));
    });
  });

  describe('註冊與切換', () => {
    let prepared = 0;

    before(() => {
      before預設 = tc.countTokens('雨下了三天');
      // 註冊一個「一個字元一個 token」的假計數器，驗證切換真的生效。
      tc.registerTokenCounter({
        id: 'test-exact',
        label: '測試用',
        accuracy: 'exact',
        prepare: async () => { prepared++; },
        count: (t) => t.length,
        charsFor: (n) => n,
      });
    });

    test('註冊後出現在列表裡', () => {
      assert.ok(tc.listTokenCounters().some((c) => c.id === 'test-exact'));
    });

    test('切換成功', async () => {
      assert.equal(await tc.useTokenCounter('test-exact'), true);
    });

    test('prepare 被呼叫一次', () => {
      assert.equal(prepared, 1);
    });

    test('切換後計數走新實現', () => {
      assert.equal(tc.countTokens('雨下了三天'), 5);
    });

    test('切換後反推字元數也走新實現', () => {
      assert.equal(tc.charsForTokens(100), 100);
    });

    test('新舊實現給出不同結果（確實切了）', () => {
      assert.notEqual(before預設, tc.countTokens('雨下了三天'));
    });
  });

  describe('計數器壞掉不能讓寫作流程停下', () => {
    before(() => {
      tc.registerTokenCounter({
        id: 'test-broken',
        label: '壞的',
        accuracy: 'exact',
        prepare: async () => { throw new Error('載入失敗'); },
        count: () => 0,
        charsFor: () => 0,
      });
    });

    test('prepare 拋錯時切換失敗而非拋出', async () => {
      assert.equal(await tc.useTokenCounter('test-broken'), false);
    });

    test('切換失敗後仍用原計數器', () => {
      assert.equal(tc.activeTokenCounter().id, 'test-exact');
    });

    test('未註冊的 id 返回 false', async () => {
      assert.equal(await tc.useTokenCounter('不存在'), false);
    });
  });

  describe('reset', () => {
    before(() => {
      tc.resetTokenCounter();
    });

    test('reset 回到預設實現', () => {
      assert.equal(tc.activeTokenCounter().id, 'heuristic');
    });

    test('reset 後計數恢復', () => {
      assert.equal(tc.countTokens('雨下了三天'), before預設);
    });
  });

  describe('校準迴路：只收真實用量，不拿估算冒充', () => {
    before(() => {
      tc.resetUsageStats();
    });

    test('沒有樣本時比值為 1', () => {
      assert.equal(tc.usageStats().ratio, 1);
    });

    test('記下一個樣本', () => {
      tc.recordUsage('續寫', 1200, { inputTokens: 1000, outputTokens: 500 });
      assert.equal(tc.usageStats().samples, 1);
    });

    test('比值 = 估算/實測', () => {
      assert.ok(Math.abs(tc.usageStats().ratio - 1.2) < 1e-9, String(tc.usageStats().ratio));
    });

    test('輸出 token 累計', () => {
      assert.equal(tc.usageStats().outputTotal, 500);
    });

    // 服務商沒給 usage 時什麼都不記——否則比值會被汙染成 1。
    test('沒有 inputTokens 則不計樣本', () => {
      tc.recordUsage('摘要', 800, {});
      assert.equal(tc.usageStats().samples, 1);
    });

    test('只有輸出時不計輸入樣本', () => {
      tc.recordUsage('摘要', 800, { outputTokens: 200 });
      assert.equal(tc.usageStats().samples, 1);
    });

    test('但輸出仍累計', () => {
      assert.equal(tc.usageStats().outputTotal, 700);
    });

    test('describeUsage 報出實測與偏差', () => {
      const note = tc.describeUsage(1200, { inputTokens: 1000, outputTokens: 500 });
      assert.ok(note.includes('實測 1000') && note.includes('+20%'), note);
    });

    test('沒有用量時 describeUsage 為空', () => {
      assert.equal(tc.describeUsage(1200, {}), undefined);
      tc.resetUsageStats();
    });
  });
});
