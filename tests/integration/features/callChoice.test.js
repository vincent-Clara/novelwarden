/**
 * 調模型之前的確認框（`features/askCall.ts`）：兩個下拉框的選項與預設，以及作者挑了之後這一次真的照著跑
 * （docs/design/plans/2026-10-20-call-choice.md）。拿「從大綱排出敘事線」當載體：一次呼叫，提示裡情節大綱
 * 帶多少字隨上下文詳細度（第 3 級 8000 字、第 1 級 4000 字），看得出詳細度換沒換。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 模型清單與對話頁同一份；預設按分檔；「按分檔」那幾行一項活一行 | 作者看得見不指定時誰幹活 |
 * | 看詳細度的框才給詳細度下拉框，預設是設定那一級 | 作者定案 #3：不起作用就不顯示 |
 * | 挑了模型：調的就是它；挑了級別：提示照那一級裝；設定不變 | 選擇只管這一次 |
 * | 巢狀的那一問預設跟著外面那一次，「按分檔」那幾行仍照分檔說 | 拆完展開、補建角色卡再問一次時不用重挑 |
 * | `preset`：表單上的選擇當預設 | 批次寫章表單問過、補建角色卡還要再問時 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');
const { outlineOf, writeOutline } = require('../../helpers/outline');

let bundle;
let h;
let fake;
let t;

/**
 * 情節大綱約 5800 字（一章一條，每條第二行很長）、最後一章第二行末尾是這一截：第 3 級（8000 字）整份帶得到；
 * 第 1 級（4000 字）整份放不下，每章只帶第一行，帶不到。
 */
const TAIL = '尾聲裡埋下的那枚銅錢';
const LONG_OUTLINE = outlineOf(20, {
  text: Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => [
      i + 1,
      `第${i + 1}章的事。\n${'林昭在雨夜裡追著黑衣人穿過三條巷子，'.repeat(15)}${i === 19 ? TAIL : ''}`,
    ])
  ),
});

const SETTINGS = {
  providers: [
    {
      id: 'p',
      kind: 'vscode-lm',
      models: [
        { name: 'a', contextWindow: 100000 },
        { name: 'b', contextWindow: 100000 },
      ],
    },
  ],
  models: ['p/a'],
  tierModels: { balanced: ['p/a'] },
  contextDetail: 3,
  concurrency: 1,
};

/** 排敘事線那一次的 user 訊息。 */
const userOf = (call) => call[call.length - 1].content;

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    config: './src/core/config.ts',
    threads: './src/core/features/threads.ts',
    askCall: './src/core/features/askCall.ts',
    scope: './src/core/runtime/callScope.ts',
    db: './src/core/runtime/db.ts',
  });
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => SETTINGS });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, { reply: () => '```json\n{"threads":[]}\n```' });
  t = await makeTempProject(bundle.project, { prefix: 'callChoice', title: '青雲劍錄' });
  writeOutline(t, LONG_OUTLINE);
});

after(() => {
  if (t) cleanup(t.dir, bundle?.db);
});

describe('確認框上的兩個下拉框：照預設點「開始排」', () => {
  let call;

  before(async () => {
    fake.reset();
    h.expect('開始排');
    await bundle.threads.generateThreads(t.project);
    call = h.confirms[0].call;
  });

  test('模型清單與對話頁同一份，預設按分檔', () => {
    assert.deepEqual(call.models.map((m) => m.ref), ['p/a', 'p/b']);
    assert.equal(call.model, '');
  });

  test('「按分檔」下面一項活一行：劇情細綱交給均衡檔', () => {
    assert.deepEqual(call.tiers, ['劇情細綱 → 均衡檔：p/a']);
  });

  test('排敘事線看詳細度：給了那個下拉框，預設是設定那一級', () => {
    assert.equal(call.contextDetail, 3);
  });

  test('照分檔調 p/a，第 3 級帶得到情節大綱的尾巴', () => {
    assert.deepEqual(fake.calls.map((c) => c.ref), ['p/a']);
    assert.ok(userOf(fake.calls[0]).includes(TAIL), userOf(fake.calls[0]));
  });
});

describe('作者另挑了模型與級別', () => {
  before(async () => {
    fake.reset();
    h.expect({ action: '開始排', choice: { model: 'p/b', contextDetail: 1 } });
    await bundle.threads.generateThreads(t.project);
  });

  test('調的是挑的那個模型', () => {
    assert.deepEqual(fake.calls.map((c) => c.ref), ['p/b']);
  });

  test('提示照第 1 級裝：情節大綱整份放不下 4000 字，每章只帶第一行，尾巴沒了', () => {
    assert.ok(!userOf(fake.calls[0]).includes(TAIL), userOf(fake.calls[0]));
    assert.ok(userOf(fake.calls[0]).includes('- 第20章：第20章的事。'), userOf(fake.calls[0]));
  });

  test('設定沒變', () => {
    assert.equal(bundle.config.readConfig().contextDetail, 3);
    assert.equal(bundle.config.readConfig().pinnedModel, undefined);
  });
});

describe('askCall 的預設', () => {
  const ask = (extra = {}) =>
    bundle.askCall.askCall({ message: '現在開始？', actions: ['開始'], tasks: ['plotOutline', 'plotOutline'], contextDetail: true, ...extra });

  test('巢狀的那一問跟著外面那一次；「按分檔」那幾行仍照分檔說、同一項活只列一行', async () => {
    h.expect('開始');
    const answer = await bundle.scope.withCallChoice({ model: 'p/b', contextDetail: 2 }, () => ask());
    const { call } = h.confirms[0];
    assert.equal(call.model, 'p/b');
    assert.equal(call.contextDetail, 2);
    assert.deepEqual(call.tiers, ['劇情細綱 → 均衡檔：p/a']);
    assert.equal(JSON.stringify(answer), JSON.stringify({ action: '開始', choice: { model: 'p/b', contextDetail: 2 } }));
  });

  test('preset：表單上的選擇當預設，沒給的那一項取設定', async () => {
    h.expect('開始');
    await ask({ preset: { model: 'p/b' } });
    const { call } = h.confirms[0];
    assert.equal(call.model, 'p/b');
    assert.equal(call.contextDetail, 3);
  });

  test('不看詳細度的框：沒有詳細度下拉框', async () => {
    h.expect('開始');
    await ask({ contextDetail: false });
    assert.equal(h.confirms[0].call.contextDetail, undefined);
  });

  test('取消：undefined', async () => {
    h.expect();
    assert.equal(await ask(), undefined);
  });
});
