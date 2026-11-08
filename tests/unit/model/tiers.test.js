/**
 * 模型分檔的配置容錯：tierModels / taskTiers 讀壞了不崩、空檔位繼承 models、
 * 認不出的任務名與檔位名一律回落內建預設。
 * 遷自 scripts/smoke-providers.js 的 `== 模型分檔的配置容錯 ==` 一節。
 *
 * config.ts 與 tiers.ts 打進同一個 bundle：這樣 config 內部那份 tiers 與用例裡斷言用的
 * DEFAULT_TASK_TIERS 是同一個例項（tiers.ts 零 import、全是常量，分開也對，但同 bundle 更穩）。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');

/** 當前這一輪的設定。每個 describe 的 before() 自己改。 */
let settings = {};

const providers = [
  { id: 'glm', models: [{ name: 'glm-4-plus' }, { name: 'glm-4-air' }] },
  { id: 'ds', models: [{ name: 'deepseek-chat' }] },
];

let configMod;
let tiersMod;

before(() => {
  const bundle = loadBundle({
    config: './src/core/config.ts',
    tiers: './src/core/model/tiers.ts',
  });
  configMod = bundle.config;
  tiersMod = bundle.tiers;
  // readConfig 由注入的 ConfigStore 供數：這裡用記憶體物件模擬 settings.json。
  configMod.initConfigFromHost({
    config: {
      read: () => settings,
      write: async (s) => { settings = s; },
    },
  });
  configMod.setLegacyConfigReader({ read: () => settings });
});

describe('模型分檔的配置容錯', () => {
  describe('缺席 / 型別不對', () => {
    let none;
    let junk;

    before(() => {
      // 缺席 / 型別不對：三檔都退化為空陣列 = 全部沿用 models，與分檔前一致。
      settings = { providers, models: ['glm/glm-4-plus'] };
      none = configMod.readConfig();

      settings = { providers, models: ['glm/glm-4-plus'], tierModels: 'nonsense', taskTiers: 42 };
      junk = configMod.readConfig();
    });

    test('沒配 tierModels 時三檔都是空陣列', () => {
      assert.ok(
        ['fast', 'balanced', 'quality'].every(
          (t) => Array.isArray(none.tierModels[t]) && none.tierModels[t].length === 0
        ),
        JSON.stringify(none.tierModels)
      );
    });

    test('沒配 taskTiers 時是空物件', () => {
      assert.equal(Object.keys(none.taskTiers).length, 0, JSON.stringify(none.taskTiers));
    });

    test('空檔位的任務沿用 models', () => {
      assert.equal(tiersMod.refsForTask(none, 'plotSummary').refs.join(','), 'glm/glm-4-plus');
    });

    test('沿用時標出 inherited', () => {
      assert.equal(tiersMod.refsForTask(none, 'plotSummary').inherited, true);
    });

    test('tierModels 不是物件時不崩', () => {
      assert.equal(junk.tierModels.fast.length, 0, JSON.stringify(junk.tierModels));
      assert.equal(junk.tierModels.quality.length, 0, JSON.stringify(junk.tierModels));
    });

    test('taskTiers 不是物件時不崩', () => {
      assert.equal(Object.keys(junk.taskTiers).length, 0);
    });
  });

  describe('檔內歸一', () => {
    let normed;

    before(() => {
      // 每檔各自走 normalizeModelList：去空、去重、保序。
      settings = {
        providers,
        models: ['glm/glm-4-plus'],
        tierModels: { fast: ['  glm/glm-4-air ', '', 'glm/glm-4-air', 42], quality: 'ds/deepseek-chat' },
      };
      normed = configMod.readConfig();
    });

    test('檔內去空白、去重、保序', () => {
      assert.equal(normed.tierModels.fast.join(','), 'glm/glm-4-air', JSON.stringify(normed.tierModels.fast));
    });

    test('檔位給成裸字串時收成單元素', () => {
      assert.equal(
        normed.tierModels.quality.join(','),
        'ds/deepseek-chat',
        JSON.stringify(normed.tierModels.quality)
      );
    });

    test('沒提到的檔仍是空陣列', () => {
      assert.equal(normed.tierModels.balanced.length, 0);
    });
  });

  describe('解析不出的引用留在檔裡', () => {
    let stale;

    before(() => {
      // 與 models 一致：解析不出的引用留在檔裡，剔除是模型池的事（那裡會 warn）。
      settings = { providers, models: ['glm/glm-4-plus'], tierModels: { fast: ['nope/x', 'glm/glm-4-air'] } };
      stale = configMod.readConfig();
    });

    test('檔裡解析不出的引用不在 readConfig 裡被丟掉', () => {
      assert.equal(stale.tierModels.fast.length, 2, stale.tierModels.fast.join(','));
    });
  });

  describe('taskTiers 的覆蓋與回落', () => {
    let tiers;

    before(() => {
      // taskTiers：認不出的任務名與非法檔位名一律丟棄，那一項回落內建預設。
      settings = {
        providers,
        models: ['glm/glm-4-plus'],
        taskTiers: { plotSummary: 'quality', extractStyle: '超級檔', nosuchTask: 'fast', loreScan: 7 },
      };
      tiers = configMod.readConfig();
    });

    test('合法的覆蓋被保留', () => {
      assert.equal(tiers.taskTiers.plotSummary, 'quality', JSON.stringify(tiers.taskTiers));
    });

    test('非法檔位名被丟棄', () => {
      assert.equal(tiers.taskTiers.extractStyle, undefined, JSON.stringify(tiers.taskTiers));
    });

    test('認不出的任務名被丟棄', () => {
      assert.equal(tiers.taskTiers.nosuchTask, undefined, JSON.stringify(tiers.taskTiers));
    });

    test('非字串檔位被丟棄', () => {
      assert.equal(tiers.taskTiers.loreScan, undefined, JSON.stringify(tiers.taskTiers));
    });

    test('覆蓋優先於內建預設', () => {
      assert.equal(tiersMod.tierOf(tiers, 'plotSummary'), 'quality');
    });

    test('丟棄後回落內建預設', () => {
      assert.equal(tiersMod.tierOf(tiers, 'extractStyle'), tiersMod.DEFAULT_TASK_TIERS.extractStyle);
    });
  });

  // 細綱試點（2026-10-25）：作者定的是固定的轉寫模型——確認框上為這一次釘的模型不管它，它照檔走。
  describe('轉寫不跟這一次釘的模型', () => {
    const base = { models: ['glm/glm-4-plus'], tierModels: { fast: ['glm/glm-4-air'], balanced: [], quality: [] }, taskTiers: {} };

    test('釘了模型：別的活只用它，轉寫照樣走快速檔', () => {
      const pinned = { ...base, pinnedModel: 'ds/deepseek-chat' };
      assert.deepEqual(tiersMod.refsForTask(pinned, 'plotOutline').refs, ['ds/deepseek-chat']);
      const t = tiersMod.refsForTask(pinned, 'transcribe');
      assert.deepEqual(t.refs, ['glm/glm-4-air']);
      assert.equal(t.pinned, false);
    });

    test('那一檔沒配：沿用預設模型', () => {
      const t = tiersMod.refsForTask({ ...base, tierModels: { fast: [], balanced: [], quality: [] }, pinnedModel: 'ds/deepseek-chat' }, 'transcribe');
      assert.deepEqual(t.refs, ['glm/glm-4-plus']);
      assert.equal(t.inherited, true);
    });

    test('預設歸快速檔', () => {
      assert.equal(tiersMod.DEFAULT_TASK_TIERS.transcribe, 'fast');
    });
  });

  describe('內建預設表自身的完備性', () => {
    // 內建預設必須給每個任務都指定一檔，否則 refsForTask 會取到 undefined。
    test('每個任務都有內建預設檔位', () => {
      assert.ok(
        tiersMod.LLM_TASKS.every((t) => tiersMod.MODEL_TIERS.includes(tiersMod.DEFAULT_TASK_TIERS[t])),
        JSON.stringify(tiersMod.DEFAULT_TASK_TIERS)
      );
    });

    test('每個任務與檔位都有中文名（設定頁要顯示）', () => {
      assert.ok(tiersMod.LLM_TASKS.every((t) => !!tiersMod.TASK_LABEL[t]));
      assert.ok(tiersMod.MODEL_TIERS.every((t) => !!tiersMod.TIER_LABEL[t]));
    });
  });
});
