/**
 * `characters` 工具：角色卡（提取、建卡、增量更新 / 重寫、清理別名、合併重複、對比「當前狀態」）。
 *
 * 每個動作都是工程頁角色卡那幾顆按鈕背後的同一個函式，確認框、提示條都在 feature 自己那裡；
 * 這幾個 feature 不報呼叫次數，回給模型的只有一句「交出去了，去哪看結果」，賬上記 0。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 十個動作都在列舉裡、都寫進了描述 | 模型照著描述找動作 |
 * | 要角色卡路徑 / 人名的動作缺了當場報錯、不花錢 | 不放它跑一趟空的 |
 * | 給錯引數（建卡給 path）當場報錯，說清誰認 | 模型以為傳了、其實被忽略，比多一次往返更糟 |
 * | 還沒有角色卡時清理別名：feature 自己說明，不報錯 | 轉發，不是重寫 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

const ACTIONS = [
  'extract',
  'create',
  'createAll',
  'update',
  'rebuild',
  'updateAll',
  'rebuildAll',
  'cleanAliases',
  'mergeDuplicates',
  'reviewState',
];

let bundle;
let t;
let h;
let fake;
let ctx;

const tool = () => bundle.tools.NOVEL_TOOLS.find((x) => x.name === 'characters');
const run = (args) => tool().run(ctx, args);

function resetCtx() {
  ctx = {
    project: t.project,
    workspace: new bundle.ws.Workspace(t.project),
    drafts: { get: () => undefined, put: () => {}, bySession: () => [] },
    sessionId: 's1',
    signal: new AbortController().signal,
    usage: { calls: 0, record(n) { this.calls += n; } },
    report: () => {},
    onDelta: () => {},
  };
  fake.calls.length = 0;
  h.toasts.length = 0;
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    tools: './src/core/tools/novel/index.ts',
    db: './src/core/runtime/db.ts',
  });
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply: () => '{}',
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });
  // makeTempProject 會刪掉模板裡的示例角色卡：這是一個一張卡都沒有的工程。
  t = await makeTempProject(bundle.project, { prefix: 'charactersTool', title: '青雲劍錄' });
  resetCtx();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('動作清單', () => {
  test('十個動作都在可選動作裡，也都寫進了描述', () => {
    assert.deepEqual(tool().parameters.properties.action.enum, ACTIONS);
    for (const a of ACTIONS) {
      assert.ok(tool().description.includes(`${a}=`), a);
    }
  });

  // 清理別名、合併重複、對比當前狀態不調模型，其餘都調：描述裡各自寫明。
  test('描述裡寫明哪幾個調模型', () => {
    const d = tool().description;
    assert.ok(d.includes('cleanAliases=清理角色卡別名裡的泛稱與別人的名字（只改 aliases，正文不動）（不調模型）'), d);
    assert.ok(d.includes('（調模型，要 name）'), d);
    assert.ok(d.includes('（不調模型，要 path）'), d);
  });

  test('引數只有 action、path、name', () => {
    assert.deepEqual(Object.keys(tool().parameters.properties).sort(), ['action', 'name', 'path']);
  });

  test('costly、mutating', () => {
    assert.equal(tool().costly, true);
    assert.equal(tool().mutating, true);
  });
});

describe('引數不對就當場報錯，不花錢', () => {
  for (const action of ['update', 'rebuild', 'reviewState']) {
    test(`${action} 缺角色卡路徑`, async () => {
      resetCtx();
      const r = await run({ action });
      assert.ok(r.error?.startsWith(`${action} 需要引數：path。path：那張角色卡的工程內相對路徑`), `${action}: ${r.error}`);
      assert.equal(fake.calls.length, 0);
    });
  }

  test('create 缺人名，說明裡要求與細綱寫法一致', async () => {
    resetCtx();
    const r = await run({ action: 'create' });
    assert.ok(r.error?.startsWith('create 需要引數：name。name：出場人物的名字，與細綱裡的寫法一致'), r.error);
  });

  // 空白字串算沒給：不放它拿一個空名字去建卡。
  test('只給空白的 name 也算缺', async () => {
    resetCtx();
    const r = await run({ action: 'create', name: '   ' });
    assert.ok(r.error?.includes('需要引數：name'), r.error);
  });

  test('create 給了 path：說清只有哪幾個認', async () => {
    resetCtx();
    const r = await run({ action: 'create', name: '林昭', path: '.novelwarden/characters/林昭.md' });
    assert.equal(r.error, 'create 不認 path，只有 update / rebuild / reviewState 認。');
  });

  test('批次動作給了 name 當場報錯', async () => {
    resetCtx();
    const r = await run({ action: 'updateAll', name: '林昭' });
    assert.equal(r.error, 'updateAll 不認 name，只有 create 認。');
    assert.equal(fake.calls.length, 0);
  });
});

describe('轉發給工程頁那幾個函式', () => {
  test('還沒有角色卡時清理別名：feature 自己說明，不調模型、不報錯', async () => {
    resetCtx();
    const r = await run({ action: 'cleanAliases' });
    assert.equal(r.error, undefined, r.error);
    assert.ok(r.text.includes('別名清理已交給 Novelwarden 執行'), r.text);
    assert.ok(h.toasts.some((m) => m.includes('還沒有角色卡')), JSON.stringify(h.toasts));
    assert.equal(fake.calls.length, 0);
    assert.equal(ctx.usage.calls, 0);
  });

  // 次數只在確認框裡：回話裡不猜一個數，display 也寫「未調模型」。
  test('交出去的動作賬上記 0，display 寫「未調模型」', async () => {
    resetCtx();
    const r = await run({ action: 'mergeDuplicates' });
    assert.equal(r.error, undefined, r.error);
    assert.deepEqual(r.display, { title: 'characters mergeDuplicates', detail: '未調模型' });
    assert.equal(ctx.usage.calls, 0);
  });
});

describe('動手前那一問', () => {
  test('標題是動作的說法，框裡寫著那個人', () => {
    const intent = tool().intent({ action: 'create', name: '林昭' });
    assert.equal(intent.gate, 'mutating');
    assert.equal(intent.title, '給一位還沒有卡的出場人物建卡');
    assert.ok(intent.detail.startsWith('林昭'), intent.detail);
  });
});
