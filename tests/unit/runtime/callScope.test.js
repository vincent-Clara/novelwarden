/**
 * 「這一次」（runtime/callScope.ts）：作者在調模型之前的確認框上挑的模型與上下文詳細度，怎麼落到 `readConfig()` 與模型池上
 * （docs/design/plans/2026-10-20-call-choice.md）。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 作用域外照設定 | 選擇只管這一次，不寫回設定 |
 * | 作用域裡 `readConfig()` 換了詳細度、多了 `pinnedModel` | `readConfig()` 是作者的選擇唯一的落點 |
 * | 釘了模型：池裡只有它、失敗不換人、預算用它的視窗 | 選了誰就是誰（與對話頁同一條規矩）；切批用幹活那個模型的視窗（第 13 條） |
 * | 巢狀：模型整項替換，詳細度沒問就沿用外面那一次 | 裡面選「按分檔」就是不釘，哪怕外面釘了 |
 * | 同時跑的兩次各是各的 | `AsyncLocalStorage` 按呼叫鏈分，批次寫章跑著時對話頁另起一次不串 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');

let bundle;
let fake;
const behavior = {};

const SETTINGS = {
  providers: [
    {
      id: 'p',
      kind: 'vscode-lm',
      models: [
        { name: 'a', contextWindow: 100000 },
        { name: 'b', contextWindow: 32000 },
        { name: 'c', contextWindow: 64000 },
      ],
    },
  ],
  models: ['p/a'],
  tierModels: { balanced: ['p/a', 'p/c'] },
  contextDetail: 3,
};

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    config: './src/core/config.ts',
    pool: './src/core/llm/pool.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    collect: './src/core/llm/collect.ts',
    scope: './src/core/runtime/callScope.ts',
  });
  bundle.host.initHost(makeFakeHost({ supportsVscodeLm: true, settings: () => SETTINGS }).host);
  fake = installFakeProvider(bundle.registry, {
    behavior,
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
    reply: (messages) => `ok:${messages.ref}`,
  });
});

const readConfig = () => bundle.config.readConfig();
const withCallChoice = (choice, fn) => bundle.scope.withCallChoice(choice, fn);

describe('作用域外', () => {
  test('照設定：詳細度 3，不釘模型', () => {
    const c = readConfig();
    assert.equal(c.contextDetail, 3);
    assert.equal(c.pinnedModel, undefined);
    assert.equal(bundle.scope.currentCallChoice(), undefined);
  });
});

describe('作用域裡', () => {
  test('readConfig 換了詳細度、釘了模型；對話頁那個模型不動', async () => {
    const c = await withCallChoice({ model: 'p/b', contextDetail: 1 }, async () => readConfig());
    assert.equal(c.contextDetail, 1);
    assert.equal(c.pinnedModel, 'p/b');
    assert.equal(c.model, 'p/a');
  });

  test('出了作用域就回到設定', async () => {
    await withCallChoice({ contextDetail: 1 }, async () => {});
    assert.equal(readConfig().contextDetail, 3);
  });

  test('釘了模型：池裡只有它，標「這一次指定」，預算是它的視窗', async () => {
    const pool = await withCallChoice({ model: 'p/b' }, () => bundle.pool.createModelPool({ task: 'manuscript' }));
    assert.deepEqual(pool.refs, ['p/b']);
    assert.ok(pool.label.includes('這一次指定'), pool.label);
    assert.equal(pool.tier, 'balanced');
    assert.equal(pool.primaryBudget.contextWindow, 32000);
    assert.equal(bundle.pool.budgetForTask('manuscript').contextWindow, 100000);
    const pinned = await withCallChoice({ model: 'p/b' }, async () => bundle.pool.budgetForTask('manuscript'));
    assert.equal(pinned.contextWindow, 32000);
  });

  test('釘了模型：失敗不換同檔其餘模型', async () => {
    for (const k of Object.keys(behavior)) delete behavior[k];
    behavior['p/b'] = 'fail';
    fake.reset();
    await withCallChoice({ model: 'p/b' }, async () => {
      const pool = await bundle.pool.createModelPool({ task: 'manuscript' });
      await assert.rejects(pool.run('第 1 章', (llm) => bundle.collect.collectText(llm.stream([], {}))));
    });
    assert.deepEqual(fake.calls.map((c) => c.ref), ['p/b']);
    delete behavior['p/b'];
  });
});

describe('巢狀', () => {
  test('裡面選「按分檔」：不釘了；詳細度沒問就沿用外面', async () => {
    const c = await withCallChoice({ model: 'p/b', contextDetail: 2 }, () => withCallChoice({}, async () => readConfig()));
    assert.equal(c.pinnedModel, undefined);
    assert.equal(c.contextDetail, 2);
  });

  test('裡面另挑了：裡面的優先', async () => {
    const c = await withCallChoice({ model: 'p/b', contextDetail: 2 }, () =>
      withCallChoice({ model: 'p/c', contextDetail: 4 }, async () => readConfig())
    );
    assert.equal(c.pinnedModel, 'p/c');
    assert.equal(c.contextDetail, 4);
  });
});

describe('同時跑的兩次', () => {
  test('各是各的，中間的 await 不串', async () => {
    const tick = () => new Promise((r) => setTimeout(r, 5));
    const seen = (choice) =>
      withCallChoice(choice, async () => {
        const out = [];
        for (let i = 0; i < 3; i++) {
          await tick();
          out.push(`${readConfig().pinnedModel}/${readConfig().contextDetail}`);
        }
        return out;
      });
    const [x, y] = await Promise.all([seen({ model: 'p/b', contextDetail: 1 }), seen({ model: 'p/c', contextDetail: 4 })]);
    assert.deepEqual(x, ['p/b/1', 'p/b/1', 'p/b/1']);
    assert.deepEqual(y, ['p/c/4', 'p/c/4', 'p/c/4']);
  });
});
