/**
 * `summary` 工具：定稿與全文大綱（定稿一章、把沒定稿的章的細綱照正文同步、重建全文大綱）。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 定稿按章號認，給細綱路徑也行 | agent 手裡多半是細綱路徑；定稿改的就是那一份細綱，不另落一份 |
 * | 定稿記上正文的指紋，舊版進回收站 | `sourceHash` 是「這一章寫完」的判據；舊版是作者可能推敲過的計劃，要找得回來 |
 * | 還沒有正文就不花錢 | 定稿是照正文改細綱，沒有正文時調一次模型只能複述細綱 |
 * | 定稿調了幾次、賬上記幾次 | 第 4 條：彈窗、賬、回話三處的次數是同一個數 |
 * | 同步與重建的確認框照彈，作者取消就零呼叫 | 轉發工程頁那個動作，不給 agent 另開一條快路 |
 * | 越界路徑給 error、不調模型 | 工程根之外的路徑一律不認 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let project;
let h;
let fake;
let ctx;
let reports;

const PLOT1 = '.novelwarden/summaries/001-夜入青雲.md';
const PLOT2 = '.novelwarden/summaries/002-藏書閣.md';
const CH1 = 'chapters/001-夜入青雲.md';
const SUMMARY_JSON = JSON.stringify({
  梗概: '林昭夜入青雲宗。',
  出场人物: ['林昭'],
  时间地点: '雨夜，山門外。',
  关键事件: ['翻牆入宗'],
  状态变更: '林昭進了宗門。',
});

const tool = () => bundle.tools.NOVEL_TOOLS.find((x) => x.name === 'summary');
const run = (args) => tool().run(ctx, args);

function resetCtx() {
  reports = [];
  ctx = {
    project,
    workspace: new bundle.ws.Workspace(project),
    drafts: { get: () => undefined, put: () => {}, bySession: () => [] },
    sessionId: 's1',
    signal: new AbortController().signal,
    usage: { calls: 0, record(n) { this.calls += n; } },
    report: (m) => reports.push(m),
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
    reply: () => SUMMARY_JSON,
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'summaryTool', title: '青雲劍錄' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  // 兩章細綱，只有第 1 章寫了正文：第 2 章是「有細綱、沒正文」的那一種。
  for (const [no, title] of [[1, '夜入青雲'], [2, '藏書閣']]) {
    await ws.writePlot({
      no,
      title,
      upstreamHash: '',
      done: false,
      sections: { ...bundle.plotFile.emptyPlotSections(), 梗概: '進入宗門', 关键事件: '踩點、翻牆。' },
    });
  }
  t.write(CH1, '# 夜入青雲\n\n雨下了三天。山門在雨裡，林昭在門外。\n');
  project.invalidate();
  await project.syncManifest();
  resetCtx();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

// 先跑取消的兩條：此時第 1 章有正文、細綱還沒定稿，同步與重建都有活可幹，確認框一定會彈。
describe('同步與重建：確認框照彈，作者取消就零呼叫', () => {
  test('sync：框裡寫著幾章過期、要調幾次；取消後回話說清沒調模型', async () => {
    resetCtx();
    h.expect();
    const r = await run({ action: 'sync' });
    assert.equal(
      h.confirms.at(-1).message,
      '有 1 章寫了正文還沒同步（或同步後正文又改過），逐章同步：照正文更新細綱、更新出場角色的當前狀態、認這一章在敘事線上發生了什麼、推這一章的故事時間。預計 6–12 次呼叫，最多 18 次。現在同步？'
    );
    assert.ok(r.text.includes('批次同步這一次沒有呼叫模型'), r.text);
    assert.ok(r.text.includes('不要重試'), r.text);
    assert.equal(fake.calls.length, 0);
    assert.equal(ctx.usage.calls, 0);
  });

  // 重建不報次數：回話只說交出去了，次數以確認框為準，賬上記 0。
  test('rebuildGlobal：先提醒有沒定稿的章；取消後零呼叫，回話說交出去了', async () => {
    resetCtx();
    h.expect();
    const r = await run({ action: 'rebuildGlobal' });
    assert.ok(
      h.confirms.at(-1).message.startsWith('有 1 章的細綱還沒照正文更新'),
      h.confirms.at(-1).message
    );
    assert.equal(r.error, undefined, r.error);
    assert.ok(r.text.includes('全文大綱重建已交給 Novelwarden 執行'), r.text);
    assert.equal(fake.calls.length, 0);
    assert.equal(ctx.usage.calls, 0);
  });
});

describe('定稿：引數', () => {
  test('缺 path 當場報錯，帶上引數說明', async () => {
    resetCtx();
    const r = await run({ action: 'finalize' });
    assert.ok(r.error.startsWith('finalize 需要引數：path。path：那一章的章節路徑或細綱路徑'), r.error);
  });

  // summary 的哪個動作都不認區間：報錯裡不該憑空列出「只有 X 認」。
  test('給了區間當場報錯', async () => {
    resetCtx();
    const r = await run({ action: 'finalize', path: PLOT1, from: 1 });
    assert.equal(r.error, 'finalize 不認 from。');
    assert.equal(fake.calls.length, 0);
  });

  test('sync 不認 path，只有 finalize 認', async () => {
    resetCtx();
    const r = await run({ action: 'sync', path: PLOT1 });
    assert.equal(r.error, 'sync 不認 path，只有 finalize 認。');
  });
});

describe('定稿：還沒有正文就不花錢', () => {
  let r;

  before(async () => {
    resetCtx();
    r = await run({ action: 'finalize', path: PLOT2 });
  });

  test('給 error，說清這一章還沒有正文', () => {
    assert.ok(r.error && r.error.includes('還沒有正文'), JSON.stringify(r));
  });

  // 不是引數錯，是執行失敗：error 前面掛著動作的說法，模型知道是哪一步沒成。
  test('error 以動作的說法開頭', () => {
    assert.ok(r.error.startsWith('同步一章'), r.error);
  });

  test('一次模型都沒調，也一次都不報', () => {
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
    assert.equal(ctx.usage.calls, 0);
  });
});

describe('定稿：按章號認，給細綱路徑也行', () => {
  let r;

  before(async () => {
    resetCtx();
    r = await run({ action: 'finalize', path: PLOT1 });
  });

  test('沒有 error', () => {
    assert.equal(r.error, undefined, r.error);
  });

  test('報的是那一章的章號', () => {
    assert.ok(r.text.includes('第 1 章'), r.text);
  });

  // 定稿改的是那一份細綱本身，不另落一份：同一章在 summaries/ 根下有兩份就撞號了。
  test('細綱照正文更新在原處，記上正文的指紋', async () => {
    const plot = await project.readPlot(PLOT1);
    const chapter = (await project.listChapters()).find((c) => c.order === 1);
    assert.equal(plot.sourceHash, chapter.contentHash);
  });

  test('舊版細綱先複製一份進回收站', () => {
    assert.ok(t.has('.novelwarden/.trash/.novelwarden/summaries/001-夜入青雲.md'));
  });

  // 更新細綱 1 次 + 認敘事線 1 次（敘事線重做：線是空的也認）+ 故事時間 1 次（2026-10-24 重做）；沒有角色卡，角色狀態不調。
  test('調了三次、記了三次，氣泡裡也說了', () => {
    assert.equal(fake.calls.length, 3, String(fake.calls.length));
    assert.equal(ctx.usage.calls, 3);
    assert.ok(reports.some((m) => m.includes('呼叫模型 3 次')), JSON.stringify(reports));
  });

  test('display 寫著這一下調了幾次', () => {
    assert.deepEqual(r.display, { title: 'summary finalize', detail: '3 次呼叫' });
  });

  test('越界路徑給 error，且不調模型', async () => {
    resetCtx();
    const bad = await run({ action: 'finalize', path: '../../etc/passwd' });
    assert.ok(bad.error, JSON.stringify(bad));
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
  });

  // 只補沒定稿的：定稿之後細綱與正文對得上，同步不彈框、不花錢。
  test('定稿之後再同步：沒事可做，不花錢', async () => {
    resetCtx();
    const before = h.confirms.length;
    const again = await run({ action: 'sync' });
    assert.equal(h.confirms.length, before, '不該彈確認框');
    assert.equal(fake.calls.length, 0);
    assert.ok(again.text.includes('沒有呼叫模型'), again.text);
  });
});

describe('工具定義本身', () => {
  test('三個動作都調模型：costly、mutating', () => {
    assert.equal(tool().costly, true);
    assert.equal(tool().mutating, true);
  });

  test('引數只有 action 與 path', () => {
    assert.deepEqual(Object.keys(tool().parameters.properties).sort(), ['action', 'path']);
    assert.deepEqual(tool().parameters.properties.action.enum, ['finalize', 'sync', 'rebuildGlobal']);
  });

  // 定稿 = 照正文反向更新細綱（帶連續性事實）+ 出場角色的當前狀態 + 敘事線。
  test('finalize 的說法是「同步」：反向更新細綱與連續性事實，再更新角色狀態、認這一章在敘事線上發生了什麼、推故事時間', () => {
    assert.ok(
      tool().description.includes(
        'finalize=同步一章（照正文反向更新它的細綱與連續性事實，再更新出場角色的當前狀態、認這一章在敘事線上發生了什麼（帶原文證據記下事件、更新各條線的當前進度，正文裡新長出來的線也認出來）、推這一章的故事時間）（調模型，要 path）'
      ),
      tool().description
    );
  });

  test('動手前那一問寫著是哪一章', () => {
    const intent = tool().intent({ action: 'finalize', path: PLOT1 });
    assert.equal(intent.gate, 'mutating');
    assert.ok(intent.detail.startsWith(PLOT1), intent.detail);
  });
});
