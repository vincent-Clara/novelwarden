/**
 * `extract` 工具：從已寫的東西里提煉參考材料（文風指南、設定條目、敘事線）。
 *
 * 三樣都是工程頁工具欄上那幾顆按鈕背後的同一個函式，確認框照彈。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 作者取消就零呼叫，賬上也記 0 | 文風、設定不報次數：次數只在確認框裡，這裡猜一個數就是第 4 條要防的對不上 |
 * | 排敘事線報次數；取消時回話說清沒調模型 | 不說清楚它會原地再發一遍 |
 * | 補記敘事線（四期）：沒有要補的章不彈框、零呼叫、回話說清 | 與工程頁「從正文補記」同一個函式 |
 * | 一個引數都不認 | 幾個動作都不要引數，給了就是模型記錯了工具 |
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
let t;
let h;
let fake;
let ctx;

const tool = () => bundle.tools.NOVEL_TOOLS.find((x) => x.name === 'extract');
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
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    plotFile: './src/core/model/plotFile.ts',
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

  // 一章排過的細綱 + 一章正文：三個動作都有東西可提煉，確認框一定會彈。
  t = await makeTempProject(bundle.project, { prefix: 'extractTool', title: '青雲劍錄' });
  const ws = new bundle.ws.Workspace(t.project);
  await ws.writePlot({
    no: 1,
    title: '夜入青雲',
    upstreamHash: '',
    done: false,
    sections: { ...bundle.plotFile.emptyPlotSections(), 梗概: '進入宗門', 关键事件: '踩點、失手、翻牆。' },
  });
  t.write('chapters/001-夜入青雲.md', '# 夜入青雲\n\n雨下了三天。山門在雨裡，林昭在門外。\n');
  // 敘事線從情節大綱排：有大綱，確認框才會彈。
  writeOutline(t, outlineOf(10, { text: { 1: '林昭夜入青雲宗。' } }));
  t.project.invalidate();
  await t.project.syncManifest();
  resetCtx();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('排敘事線：轉發給工程頁那個動作', () => {
  let r;

  before(async () => {
    resetCtx();
    h.expect();
    r = await run({ action: 'threads' });
  });

  test('確認框寫著從情節大綱排、預計呼叫幾次', () => {
    assert.match(h.confirms.at(-1).message, /^要從情節大綱排出敘事線，預計 2 次呼叫，最多 3 次/);
  });

  test('作者取消：一次模型都不調，賬上也不記', () => {
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
    assert.equal(ctx.usage.calls, 0);
    assert.ok(r.text.includes('排敘事線這一次沒有呼叫模型'), r.text);
  });
});

// 敘事線重做四期：從已寫正文補記，與工程頁「從正文補記」同一個函式。這一本一章都沒定稿，沒有要補的：不彈框、零呼叫、回話說清。
describe('補記敘事線：轉發給工程頁那個動作', () => {
  test('一章都沒定稿：不彈確認框，零呼叫，回話說清沒調模型；提示條說先定稿', async () => {
    resetCtx();
    h.expect();
    const r = await run({ action: 'threadsFromText' });
    assert.equal(r.error, undefined, r.error);
    assert.equal(h.confirms.length, 0);
    assert.equal(fake.calls.length, 0);
    assert.equal(ctx.usage.calls, 0);
    assert.ok(r.text.includes('補記敘事線這一次沒有呼叫模型'), r.text);
    assert.ok(h.toasts.some((x) => x.includes('還沒有同步過的章')), h.toasts.join('\n'));
  });
});

describe('文風與設定：交出去，賬上記 0', () => {
  // 樣章先讓作者挑（輸入框）：取消就什麼都不做。
  test('style：作者取消挑樣章，零呼叫，回話指到 style.md', async () => {
    resetCtx();
    const inputs = h.inputs.length;
    h.expect();
    const r = await run({ action: 'style' });
    assert.equal(h.inputs.length, inputs + 1, '該先讓作者挑樣章');
    assert.equal(r.error, undefined, r.error);
    assert.ok(r.text.includes('.novelwarden/style.md'), r.text);
    assert.equal(fake.calls.length, 0);
    assert.equal(ctx.usage.calls, 0);
  });

  // 設定條目不在 extract 裡了（整本重掃刪了，換成 lore 工具）。
  test('沒有 lore 動作：當場報錯，零呼叫', async () => {
    resetCtx();
    h.expect();
    const r = await run({ action: 'lore' });
    assert.ok(r.error, JSON.stringify(r));
    assert.equal(fake.calls.length, 0);
    assert.equal(ctx.usage.calls, 0);
  });
});

describe('工具定義本身', () => {
  test('引數只有 action', () => {
    assert.deepEqual(Object.keys(tool().parameters.properties), ['action']);
    assert.deepEqual(tool().parameters.properties.action.enum, ['style', 'threads', 'threadsFromText']);
  });

  test('三個動作都調模型：costly、mutating', () => {
    assert.equal(tool().costly, true);
    assert.equal(tool().mutating, true);
  });

  // 哪個動作都不認的引數：報錯裡不列「只有 X 認」。
  test('給了引數當場報錯，不彈框', async () => {
    resetCtx();
    const before = h.confirms.length;
    const r = await run({ action: 'threads', path: '.novelwarden/summaries/001-夜入青雲.md' });
    assert.equal(r.error, 'threads 不認 path。');
    assert.equal(h.confirms.length, before);
  });
});
