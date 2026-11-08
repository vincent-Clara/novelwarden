/**
 * 確認框上那兩個下拉框的純函式（model/callChoice.ts）與分檔在「這一次指定了模型」時的說法（model/tiers.ts）。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 前端交上來的選擇容錯讀取：不是物件 = 沒問過；認不出的那一項丟掉 | 第 1 條：讀壞了不崩，退回設定 |
 * | 日誌與 VS Code 模態框裡那一行寫清用誰、換不換人、哪一級 | 作者看得出這一次跟設定哪裡不一樣 |
 * | 釘了模型：清單隻有它，`describeTier` / `describeTaskModels` 說「這一次指定」 | 確認框與日誌的說法只從 `refsForTask` 取 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');

let choice;
let tiers;

before(() => {
  const bundle = loadBundle({ choice: './src/core/model/callChoice.ts', tiers: './src/core/model/tiers.ts' });
  choice = bundle.choice;
  tiers = bundle.tiers;
});

describe('normalizeCallChoice', () => {
  test('不是物件：沒問過', () => {
    for (const raw of [undefined, null, true, 'p/a', 3]) {
      assert.equal(choice.normalizeCallChoice(raw), undefined, String(raw));
    }
  });

  test('空物件：問過、全照預設（按分檔、設定那一級）', () => {
    assert.deepEqual(choice.normalizeCallChoice({}), {});
  });

  test('認得出的留下，認不出的丟掉', () => {
    assert.deepEqual(choice.normalizeCallChoice({ model: ' p/a ', contextDetail: 2 }), { model: 'p/a', contextDetail: 2 });
    assert.deepEqual(choice.normalizeCallChoice({ model: '', contextDetail: 5 }), {});
    assert.deepEqual(choice.normalizeCallChoice({ model: 7, contextDetail: '2' }), {});
  });
});

describe('describeCallChoice', () => {
  test('按分檔 / 只用某個模型，帶上級別', () => {
    assert.equal(choice.describeCallChoice({}), '按分檔');
    assert.equal(choice.describeCallChoice({ contextDetail: 1 }), '按分檔 · 上下文詳細度「精簡」');
    assert.equal(choice.describeCallChoice({ model: 'p/b', contextDetail: 4 }), '只用 p/b（失敗不換人） · 上下文詳細度「完整」');
  });
});

describe('分檔：這一次指定了模型', () => {
  const config = { models: ['p/a'], tierModels: { fast: [], balanced: ['p/a', 'p/c'], quality: [] }, taskTiers: {} };

  test('不釘：照檔位', () => {
    const picked = tiers.refsForTask(config, 'manuscript');
    assert.deepEqual(picked, { tier: 'balanced', refs: ['p/a', 'p/c'], inherited: false, pinned: false });
  });

  test('釘了：只有它，檔位照記（日誌用）', () => {
    const picked = tiers.refsForTask({ ...config, pinnedModel: 'p/b' }, 'manuscript');
    assert.deepEqual(picked, { tier: 'balanced', refs: ['p/b'], inherited: false, pinned: true });
    assert.equal(tiers.describeTier(picked), '這一次指定');
    assert.equal(tiers.describeTaskModels({ ...config, pinnedModel: 'p/b' }, 'manuscript'), '批次寫正文 → 這一次指定：p/b');
  });
});
