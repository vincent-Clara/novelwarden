/**
 * `book` 工具：拆書（匯入原稿、從已寫正文補齊、從參考書學寫法）。
 *
 * 都是工程頁那幾顆按鈕背後的同一個函式。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | import / learn 缺 path 當場報錯、不彈框 | 不放它跑一趟空的 |
 * | path 只認工程裡的 txt | 章節檔案、隱藏目錄、工程外的路徑一律不認（`features/bookText.ts`） |
 * | 匯入：作者取消就回「不要重試」、零呼叫 | 切分結果先給作者看，他說了算 |
 * | 補齊：作者在第一個框取消就零呼叫 | 動手前報呼叫次數（第 4 條） |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

const CH1 = 'chapters/001-夜入青雲.md';

let bundle;
let t;
let h;
let fake;
let ctx;

const tool = () => bundle.tools.NOVEL_TOOLS.find((x) => x.name === 'book');
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
  h.confirms.length = 0;
  h.picks.length = 0;
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

  // 已寫了第 1 章正文（還沒細綱）：從已寫正文補齊有活可幹。
  t = await makeTempProject(bundle.project, { prefix: 'bookTool', title: '青雲劍錄' });
  t.write(CH1, '# 夜入青雲\n\n雨下了三天。山門在雨裡，林昭在門外。\n');
  t.project.invalidate();
  await t.project.syncManifest();
  resetCtx();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('引數', () => {
  test('import / learn 要 path，缺了當場報錯、不彈框', async () => {
    resetCtx();
    h.expect();
    for (const action of ['import', 'learn']) {
      const r = await run({ action });
      assert.ok(r.error?.startsWith(`${action} 需要引數：path。path：工程裡那本 txt 的相對路徑`), r.error);
    }
    assert.equal(h.confirms.length + h.picks.length, 0);
  });

  test('derive 不認 path，只有 import / learn 認', async () => {
    resetCtx();
    const r = await run({ action: 'derive', path: '原稿.txt' });
    assert.equal(r.error, 'derive 不認 path，只有 import / learn 認。');
    assert.equal(h.confirms.length, 0);
  });

  test('path 只認工程裡的 txt：章節檔案報錯回給模型，不花錢', async () => {
    resetCtx();
    const r = await run({ action: 'import', path: CH1 });
    assert.match(r.error, /不是工程裡能拆的 txt/, JSON.stringify(r));
    assert.equal(fake.calls.length, 0);
    assert.equal(ctx.usage.calls, 0);
  });
});

describe('轉發給工程頁那幾個函式', () => {
  test('匯入：作者在確認框取消，回給模型「不要重試」、零呼叫', async () => {
    resetCtx();
    t.write('原稿.txt', '第一章 入宗\n林昭入宗。');
    t.project.invalidate();
    h.expect(undefined);
    const r = await run({ action: 'import', path: '原稿.txt' });
    assert.match(h.confirms[0].message, /^從《原稿》認出 1 章/);
    assert.match(r.text, /這一次沒有匯入/);
    assert.match(r.text, /不要重試同一個動作/);
    assert.equal(ctx.usage.calls, 0);
  });

  test('從已寫正文補齊：作者在第一個框取消，零呼叫', async () => {
    resetCtx();
    h.expect(undefined);
    const r = await run({ action: 'derive' });
    assert.match(h.confirms[0].message, /^從已寫正文補齊第 1–\d+ 章/);
    assert.match(r.text, /從已寫正文補齊這一次沒有呼叫模型/);
    assert.equal(fake.calls.length, 0);
  });
});

describe('工具定義本身', () => {
  test('引數只有 action 與 path', () => {
    assert.deepEqual(Object.keys(tool().parameters.properties).sort(), ['action', 'path']);
    assert.deepEqual(tool().parameters.properties.action.enum, ['import', 'derive', 'learn']);
  });

  // 典型順序寫在描述裡：先匯入再補齊，模型才不會拿著原稿直接 derive。
  test('描述裡寫著先 import 再 derive', () => {
    assert.ok(tool().description.includes('import 匯入原稿 → derive'), tool().description);
  });
});
