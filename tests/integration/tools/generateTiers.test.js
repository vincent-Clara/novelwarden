/**
 * agent 的 `generate` 用哪個模型（AGENTS 第 12 / 13 條的延伸）。
 *
 * | 層 | 用哪個 | 為什麼 |
 * |---|---|---|
 * | 正文 | **對話頁選定的那個** | 中途換人會讓文風斷掉 |
 * | 大綱 | 同上 | 一次定調，沒有對應檔位 |
 * | 架構 | `setting` 檔（故事架構） | 與工程頁「補齊架構」同一個模型 |
 * | 細綱 | `plotOutline` 檔 | 與工程頁「批次拆細綱」同一個模型 |
 *
 * 還有一條容易漏的：走池時**視窗要跟著幹活那個模型走**（第 13 條），
 * 拿 200k 的對話模型視窗給快速檔的 32k 模型裝配上下文會穩定超窗。
 *
 * 正文層的 target 用**章節路徑**給（`chapters/NNN-標題.md`）：一章一綱之後正文直接
 * 落在那裡，工具按章號去認同號的細綱。
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
let fake;
let ctx;
let settings;

const PLOT_REL = '.novelwarden/summaries/001-夜入青雲.md';
const CHAPTER_REL = 'chapters/001-夜入青雲.md';
const OUTLINE_REL = '.novelwarden/outline.md';
const CONFIG_REL = '.novelwarden/config.md';

const tool = () => bundle.tools.NOVEL_TOOLS.find((x) => x.name === 'generate');
const run = (args) => tool().run(ctx, args);

function resetCtx() {
  ctx = {
    project,
    workspace: new bundle.ws.Workspace(project),
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
    providers: './src/core/model/providers.ts',
    tiers: './src/core/model/tiers.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    tools: './src/core/tools/novel/index.ts',
    db: './src/core/runtime/db.ts',
  });

  settings = {
    providers: [
      {
        id: 'chat',
        kind: 'vscode-lm',
        models: [{ name: 'big', contextWindow: 200000, maxOutputTokens: 4000 }],
      },
      {
        id: 'cheap',
        kind: 'vscode-lm',
        models: [
          { name: 'plotter', contextWindow: 64000, maxOutputTokens: 2000 },
          { name: 'quick', contextWindow: 32000, maxOutputTokens: 1000 },
          { name: 'architect', contextWindow: 128000, maxOutputTokens: 8000 },
        ],
      },
    ],
    models: ['chat/big'],
    // plotOutline 預設歸均衡檔，setting（故事架構）預設歸精標檔。
    tierModels: { balanced: ['cheap/plotter'], fast: ['cheap/quick'], quality: ['cheap/architect'] },
    concurrency: 1,
  };
  bundle.host.initHost(makeFakeHost({ supportsVscodeLm: true, settings: () => settings }).host);
  fake = installFakeProvider(bundle.registry, {
    // 這裡只看每一層用的是哪個模型，產物長什麼樣無所謂；給的是細綱合同的單項形式，
    // 細綱層拿到的是一份像樣的應答。
    reply: () =>
      JSON.stringify({
        blueprints: [
          {
            chapterNumber: 1,
            title: '夜入青雲',
            synopsis: '林昭進入宗門。',
            characters: ['林昭'],
            keyEvents: ['踩點、失手、翻牆。'],
            highlights: ['牆內有人在等他。'],
          },
        ],
      }),
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'agenttier', title: '青雲劍錄' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  await ws.writePlot({
    no: 1,
    title: '夜入青雲',
    upstreamHash: '',
    done: false,
    sections: { ...bundle.plotFile.emptyPlotSections(), 梗概: '進入宗門' },
  });
  await project.syncManifest();
  resetCtx();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('細綱層走 plotOutline 檔', () => {
  before(async () => {
    resetCtx();
    await run({ target: PLOT_REL, capability: 'generate' });
  });

  test('用的是那一檔的首選，不是對話頁那個', () => {
    assert.equal(fake.calls[0].ref, 'cheap/plotter', String(fake.calls[0].ref));
  });
});

// ★ 第 12 條：中途換人會讓文風斷掉。
describe('正文層嚴格用對話頁選定的那個模型', () => {
  before(async () => {
    resetCtx();
    await run({ target: CHAPTER_REL, capability: 'generate' });
  });

  test('不走池', () => {
    assert.equal(fake.calls[0].ref, 'chat/big', String(fake.calls[0].ref));
  });

  test('把那一檔配得再滿也不換', async () => {
    resetCtx();
    settings.tierModels.balanced = ['cheap/plotter'];
    settings.tierModels.fast = ['cheap/quick'];
    await run({ target: CHAPTER_REL, capability: 'generate' });
    assert.equal(fake.calls[0].ref, 'chat/big', String(fake.calls[0].ref));
  });
});

describe('大綱層也用對話頁那個（一次定調，沒有對應檔位）', () => {
  test('不走池', async () => {
    resetCtx();
    await run({ target: OUTLINE_REL, capability: 'generate' });
    assert.equal(fake.calls[0].ref, 'chat/big', String(fake.calls[0].ref));
  });
});

// 架構四件與工程頁「補齊架構」是同一件事：用同一檔的同一個模型，作者在設定頁配一處就夠。
describe('架構層走 setting 檔（故事架構）', () => {
  test('用的是那一檔的首選，不是對話頁那個', async () => {
    resetCtx();
    await run({ target: CONFIG_REL, capability: 'generate' });
    assert.equal(fake.calls[0].ref, 'cheap/architect', String(fake.calls[0].ref));
  });

  test('那一檔沒配就回到對話頁那個', async () => {
    resetCtx();
    const saved = settings.tierModels.quality;
    settings.tierModels.quality = [];
    await run({ target: CONFIG_REL, capability: 'generate' });
    assert.equal(fake.calls[0].ref, 'chat/big', String(fake.calls[0].ref));
    settings.tierModels.quality = saved;
  });
});

// 六期定了 agent 不做審稿（報告要作者勾選才修稿）：工具不該為一件它不做的事走某個檔位。
describe('審稿當場拒絕，不走任何檔位', () => {
  test('給 error，一次模型都不調', async () => {
    resetCtx();
    const r = await run({ target: CHAPTER_REL, capability: 'review' });
    assert.ok(r.error && r.error.includes('審稿'), JSON.stringify(r));
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
  });
});

// 拆場景、拆卷那兩檔隨那兩層一起刪掉了。忘記刪的話，設定頁會多出一行點了
// 沒用的檔位，而作者會以為自己在配一個真存在的任務。
describe('刪掉的層沒有留下檔位', () => {
  test('拆場景不在任務清單裡', () => {
    assert.ok(!bundle.tiers.LLM_TASKS.includes('sceneBreakdown'), bundle.tiers.LLM_TASKS.join(','));
  });

  test('沒有卷那一層的任務', () => {
    assert.ok(
      !bundle.tiers.LLM_TASKS.some((task) => /volume|split/i.test(task)),
      bundle.tiers.LLM_TASKS.join(',')
    );
  });
});

describe('檔位沒配模型時沿用預設模型清單', () => {
  test('清空那一檔就回到對話頁那個', async () => {
    resetCtx();
    const saved = settings.tierModels.balanced;
    settings.tierModels.balanced = [];
    await run({ target: PLOT_REL, capability: 'generate' });
    assert.equal(fake.calls[0].ref, 'chat/big', String(fake.calls[0].ref));
    settings.tierModels.balanced = saved;
  });
});

// 排程交給了外部 agent（經 MCP），它用的是宿主自己的模型；這裡不再給它留一檔。
describe('沒有 agent 這一項任務檔位', () => {
  test('不在任務清單裡', () => {
    assert.ok(!bundle.tiers.LLM_TASKS.includes('agent'), bundle.tiers.LLM_TASKS.join(','));
  });

  test('也沒有殘留的中文名、說明與預設檔', () => {
    assert.equal(bundle.tiers.TASK_LABEL.agent, undefined);
    assert.equal(bundle.tiers.TASK_HINT.agent, undefined);
    assert.equal(bundle.tiers.DEFAULT_TASK_TIERS.agent, undefined);
  });
});
