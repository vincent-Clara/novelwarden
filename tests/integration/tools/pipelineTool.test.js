/**
 * `pipeline` 工具：流水線上的批次動作（補齊架構、批次拆細綱、批次寫章、新建細綱骨架）。
 *
 * 五件事：
 *
 * 1. **確認框照彈**——作者不同意就一次模型都不調，且回給模型的話要說清
 *    「不要重試同一個動作」。
 * 2. **預計次數報給呼叫方記賬**：彈窗寫著 N 次、賬上記 1 次，正是第 4 條要防的。
 * 3. **批次寫正文走既有流程**：正文直接落同號的 `chapters/NNN-標題.txt`（一章一綱，
 *    沒有中轉站），並在細綱上記 `writtenFrom`——這正是「不要自己用 write 拼」的理由。
 * 4. **區間與模式**：`from` / `to` / `mode` / `review` 轉給批次寫章並寫進確認框與動手前那一問；
 *    只給 `from` 按預設章數往後數；引數不對當場報錯，不彈框、不花錢。
 * 5. **只補空白**：沒事可做時再調一次不花錢。
 *
 * 帶 action 工具共用的那一套（拒絕刪除類、認不出的動作、引數對不上動作）在 actionTool.test.js。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');
const { outlineOf } = require('../../helpers/outline');

let bundle;
let t;
let project;
let h;
let fake;
let ctx;
let reports;
let settings;

const PLOT1 = '.novelwarden/summaries/001-夜入青雲.md';
const CH1 = 'chapters/001-夜入青雲.txt';
const CH2 = 'chapters/002-藏書閣.txt';

/** 細綱層的應答：按契約裡寫的區間給一批藍圖（「寫第 1–2 章的細綱：」）。 */
function plotReply(messages) {
  const user = messages[messages.length - 1].content;
  const m = /寫第 (\d+)(?:–(\d+))? 章的細綱：/.exec(user);
  const from = Number(m?.[1] ?? 1);
  const to = Number(m?.[2] ?? from);
  const blueprints = [];
  for (let no = from; no <= to; no++) {
    blueprints.push({
      chapterNumber: no,
      title: '模型起的名',
      synopsis: '林昭夜裡翻牆進宗門。',
      characters: ['林昭'],
      timePlace: '雨夜，青雲宗山門',
      keyEvents: ['踩點、失手、翻牆', '收在藏書閣門口。'],
      highlights: ['牆內有人在等他。'],
      foreshadowing: [],
      stateChange: '',
    });
  }
  return JSON.stringify({ blueprints });
}
const MANUSCRIPT_TEXT = '雨下了三天。山門在雨裡，林昭在門外。';

/**
 * 按裝配出的系統提示認是哪一層在問：批次拆細綱與批次寫章在同一個用例檔案裡
 * 跑，各自要拿到自己那一層該有的形狀。
 */
function replyFor(messages) {
  const system = messages[0]?.content ?? '';
  if (system.includes('中文長篇小說作者，正在為')) return MANUSCRIPT_TEXT;
  return plotReply(messages);
}

const tool = () => bundle.tools.NOVEL_TOOLS.find((x) => x.name === 'pipeline');
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
  if (fake) {
    fake.calls.length = 0;
  }
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

  settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply: (messages) => replyFor(messages),
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'pipelineTool', title: '青雲劍錄' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  // 情節大綱是各章細綱梗概的彙總：寫進去就是第 1、2 章各一份只有梗概的細綱（下面再把它們起名、寫幾節）。
  await ws.write(
    project.relPath(project.outlinePath),
    { text: outlineOf(2, { title: '大綱', text: { 1: '林昭入宗。' } }) },
    { mode: 'overwrite' }
  );
  // 全書兩章：批次拆細綱的預設區間（下一可寫章起 5 章）收在第 2 章，一批就完。
  await ws.write(
    project.relPath(project.configPath),
    { text: '---\ntotalChapters: 2\n---\n\n# 小說配置\n\n## 核心梗概\n\n少年入宗。\n' },
    { mode: 'overwrite', review: false }
  );
  // 兩章細綱都只起了個頭（「關鍵事件」空著）：批次拆細綱有活可幹。
  for (const [no, title] of [[1, '夜入青雲'], [2, '藏書閣']]) {
    await ws.writePlot({
      no,
      title,
      upstreamHash: '',
      done: false,
      sections: { ...bundle.plotFile.emptyPlotSections(), 梗概: '進入宗門' },
    });
  }
  await project.syncManifest();
  resetCtx();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('批次拆細綱：作者不同意就什麼都不做', () => {
  let r;

  before(async () => {
    resetCtx();
    // 佇列為空 = 確認框返回 undefined = 使用者取消。
    h.expect();
    r = await run({ action: 'batchPlots' });
  });

  test('確認框彈過了', () => {
    assert.equal(h.confirms.length, 1, JSON.stringify(h.confirms));
  });

  // 第 4 條：動手前必須寫明預計呼叫次數（有自動修復，所以還有上限）。
  test('確認框裡寫了預計呼叫幾次', () => {
    assert.ok(/預計 \d+ 次呼叫，最多 \d+ 次/.test(h.confirms[0].message), h.confirms[0].message);
  });

  test('一次模型都沒調', () => {
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
  });

  test('沒有報呼叫次數', () => {
    assert.equal(ctx.usage.calls, 0);
  });

  test('回給模型的話說清了沒調模型', () => {
    assert.ok(r.text.includes('沒有呼叫模型'), r.text);
  });

  // 不說清楚它會原地再發一遍——那是最常見的燒錢方式。
  test('還明說了不要重試同一個動作', () => {
    assert.ok(r.text.includes('不要重試'), r.text);
  });

  test('磁碟上一章細綱都沒多', async () => {
    const plots = await project.listPlots();
    assert.ok(plots.every((p) => !bundle.plotFile.isPlotFilled(p.sections)), JSON.stringify(plots.map((p) => p.no)));
  });
});

describe('批次拆細綱：作者同意', () => {
  let r;

  before(async () => {
    resetCtx();
    h.expect('開始拆細綱');
    r = await run({ action: 'batchPlots' });
  });

  test('兩章都排了細綱', async () => {
    const plots = await project.listPlots();
    assert.ok(plots.every((p) => bundle.plotFile.isPlotFilled(p.sections)), JSON.stringify(plots.map((p) => p.sections)));
  });

  // 批次拆細綱改的是七個小節：作者起的標題不該被抹掉。
  test('標題沿用磁碟那份', async () => {
    const plot = await project.readPlot(PLOT1);
    assert.equal(plot.title, '夜入青雲');
  });

  // 計劃出場寫進「出場人物」一節，讀回來就是 characters（沒定稿，取的是計劃）。
  test('計劃出場的人隨產物落盤', async () => {
    const plot = await project.readPlot(PLOT1);
    assert.deepEqual(plot.characters, ['林昭']);
  });

  // 兩章一批：一次呼叫出兩份；拆完再排一次敘事線。
  test('兩章一批，調了一次模型；拆完排一次敘事線', () => {
    assert.equal(fake.calls.length, 2, String(fake.calls.length));
  });

  // ★ 實際調了幾次，賬上就記幾次。
  test('呼叫次數報了出去', () => {
    assert.equal(ctx.usage.calls, 2);
  });

  test('用量在氣泡裡說出來了', () => {
    assert.ok(reports.some((m) => m.includes('2')), JSON.stringify(reports));
  });

  test('返回文字裡有次數', () => {
    assert.ok(r.text.includes('2 次'), r.text);
  });

  test('沒事可做時再調一次不花錢', async () => {
    resetCtx();
    h.expect('開始拆細綱');
    const again = await run({ action: 'batchPlots' });
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
    assert.equal(ctx.usage.calls, 0);
    assert.ok(again.text.includes('沒有呼叫模型'), again.text);
  });
});

/**
 * 批次的區間與模式（六期）：工程頁兩個彈窗能選的，agent 這條路也能給。確認框照彈，
 * 區間與模式寫在框裡——「批次寫章」與「把第 1–2 章寫完並定稿」是分量不一樣的兩件事。
 * 這裡一律在確認框上取消：只看框裡寫了什麼，不花錢。
 */
describe('批次寫章：區間與模式寫進確認框', () => {
  test('from / to / mode / review 都轉給了批次寫章', async () => {
    resetCtx();
    h.expect();
    const r = await run({ action: 'batchManuscripts', from: 1, to: 2, mode: 'finalize', review: true });
    const message = h.confirms[h.confirms.length - 1].message;
    assert.ok(message.startsWith('第 1–2 章：要寫 2 章正文（寫完即同步、寫完即審稿）'), message);
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
    assert.ok(r.text.includes('沒有呼叫模型'), r.text);
  });

  // 只給起點：按批次寫章的預設（3 章）往後數，再由 feature 按磁碟收住（第 3 章起沒有細綱）。
  test('只給 from 時按預設章數往後數', async () => {
    resetCtx();
    h.expect();
    await run({ action: 'batchManuscripts', from: 2 });
    const message = h.confirms[h.confirms.length - 1].message;
    assert.ok(message.startsWith('第 2 章：要寫 1 章正文（只寫正文）'), message);
  });

  test('批次拆細綱也認區間', async () => {
    resetCtx();
    h.expect();
    const r = await run({ action: 'batchPlots', from: 2, to: 2 });
    // 第 2 章已經排過細綱：feature 自己說「都排過了」，不彈確認框、不花錢。
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
    assert.ok(r.text.includes('沒有呼叫模型'), r.text);
  });
});

describe('區間與模式的引數不對就當場報錯，不彈框、不花錢', () => {
  const cases = [
    ['from 大於 to', { action: 'batchPlots', from: 3, to: 1 }, '區間'],
    ['只給 to', { action: 'batchPlots', to: 3 }, 'from'],
    ['from 不是數', { action: 'batchManuscripts', from: '第三章' }, '章號'],
    ['不認區間的動作給了區間', { action: 'newPlot', from: 1 }, '不認 from，只有 batchPlots / batchManuscripts 認'],
    ['拆細綱給了模式', { action: 'batchPlots', mode: 'finalize' }, '不認 mode，只有 batchManuscripts 認'],
    ['補齊架構給了審稿', { action: 'completeSettings', review: true }, '不認 review，只有 batchManuscripts 認'],
    ['區間只給了半個數', { action: 'batchPlots', from: 1, to: '末尾' }, '章號'],
    ['模式寫錯', { action: 'batchManuscripts', mode: 'all' }, 'mode 只能是'],
  ];
  for (const [name, args, word] of cases) {
    test(name, async () => {
      resetCtx();
      const before = h.confirms.length;
      const r = await run(args);
      assert.ok(r.error && r.error.includes(word), JSON.stringify(r));
      assert.equal(h.confirms.length, before, '不該彈確認框');
      assert.equal(fake.calls.length, 0, String(fake.calls.length));
      assert.equal(ctx.usage.calls, 0);
    });
  }
});

/**
 * 批次寫正文是 `pipeline` 存在的理由之一：正文落盤要在細綱上記 `writtenFrom`（第 18 條），
 * agent 拿著 write 自己拼就會漏掉這一步——那一章從此永遠不會因為細綱改過而掛 ⟳。
 */
describe('批次寫正文：正文直接落同號章節，並在細綱上記指紋', () => {
  let r;

  before(async () => {
    resetCtx();
    h.expect('開始寫章');
    r = await run({ action: 'batchManuscripts' });
  });

  // 四期：預設是下一可寫章起 3 章、只寫正文；全書只有兩章細綱，收在第 2 章。上限含自動續寫與寫前比對（2026-10-25 起含轉寫）。
  test('確認框寫了區間與預計呼叫幾次', () => {
    assert.equal(h.confirms[0].message, '第 1–2 章：要寫 2 章正文（只寫正文），預計 2–8 次呼叫，最多 24 次。現在寫？');
  });

  // 一章一綱：沒有中轉站，正文就落在 chapters/ 裡那個同號的檔案上。
  test('兩章正文都落進了 chapters/', async () => {
    const chapters = await project.listChapters();
    assert.deepEqual(chapters.map((c) => c.relPath), [CH1, CH2]);
  });

  test('正文內容就是模型寫的那一段', () => {
    assert.ok(t.read(CH1).includes('山門在雨裡'), t.read(CH1));
  });

  test('不再建中轉站目錄', () => {
    assert.ok(!t.has('.novelwarden/manuscripts/001-夜入青雲.md'));
  });

  // ★ 少了這一步，細綱後來改過也不會讓這一章掛 ⟳。
  test('細綱上記了 writtenFrom，且等於細綱當前內容的指紋', async () => {
    const plot = await project.readPlot(PLOT1);
    assert.equal(plot.writtenFrom, bundle.plotFile.plotContentHash(plot));
  });

  test('調了兩次模型，賬上也記兩次', () => {
    assert.equal(fake.calls.length, 2, String(fake.calls.length));
    assert.equal(ctx.usage.calls, 2);
  });

  test('返回文字裡有次數', () => {
    assert.ok(r.text.includes('2 次'), r.text);
  });

  // 只補空白：已經寫過的章不再動，也不再花錢。
  test('再調一次沒事可做，不花錢', async () => {
    resetCtx();
    const again = await run({ action: 'batchManuscripts' });
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
    assert.equal(ctx.usage.calls, 0);
    assert.ok(again.text.includes('沒有呼叫模型'), again.text);
  });
});

describe('newPlot 不花錢', () => {
  let r;

  before(async () => {
    resetCtx();
    r = await run({ action: 'newPlot' });
  });

  test('建出了一份細綱', () => {
    assert.ok(r.text.includes('.novelwarden/summaries/'), `${r.text}｜${r.error ?? ''}`);
  });

  test('一次模型都沒調', () => {
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
  });

  // 細綱號 = 章號：第 1、2 章已經有細綱和正文，新建的那一份就是第 3 章的。
  test('新建的是第 3 章的細綱', async () => {
    const plots = await project.listPlots();
    assert.deepEqual(plots.map((p) => p.no), [1, 2, 3]);
  });

  // summaries/ 子目錄裡的不算細綱（判成 other），新建的那一份必須落在根下才認得出來。
  test('新建的細綱平鋪在 summaries/ 根下', async () => {
    const plots = await project.listPlots();
    assert.match(plots[2].relPath, /^\.novelwarden\/summaries\/003[^/]*\.md$/, plots[2].relPath);
  });

  test('新建的細綱是空骨架（不算排過）', async () => {
    const plots = await project.listPlots();
    assert.ok(!bundle.plotFile.isPlotFilled(plots[2].sections), JSON.stringify(plots[2].sections));
  });
});

// 補齊故事架構（六期）：工程頁工具欄那顆按鈕背後的同一個函式，確認框照彈。
describe('補齊故事架構：轉發給工程頁那個動作', () => {
  let r;

  before(async () => {
    resetCtx();
    h.expect();
    r = await run({ action: 'completeSettings' });
  });

  // 小說配置寫了核心梗概，算填過；缺的是另外三件。
  test('確認框寫著缺哪幾件、預計呼叫幾次', () => {
    const message = h.confirms[h.confirms.length - 1].message;
    assert.ok(message.startsWith('要補齊故事前提、角色圖譜、世界觀，預計'), message);
  });

  test('作者取消：一次模型都不調，賬上也不記', () => {
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
    assert.equal(ctx.usage.calls, 0);
  });

  test('回給模型的話說的是架構，不是「沒有待處理的章」', () => {
    assert.ok(r.text.includes('補齊故事架構這一次沒有呼叫模型'), r.text);
    assert.ok(!r.text.includes('待處理的章'), r.text);
  });
});

describe('工具定義本身', () => {
  test('標了 mutating', () => {
    assert.equal(tool().mutating, true);
  });

  test('標了 costly（四個動作裡三個調模型）', () => {
    assert.equal(tool().costly, true);
  });

  test('引數是扁平的標量', () => {
    const props = tool().parameters.properties;
    // 只有區間與模式：path / name / url 歸別的工具，這裡給了只會被當場拒。
    assert.deepEqual(Object.keys(props).sort(), ['action', 'from', 'mode', 'review', 'to']);
    assert.ok(Object.values(props).every((p) => p.type !== 'object' && p.type !== 'array'), JSON.stringify(props));
  });

  test('mode 是列舉：只寫正文 / 寫完即定稿', () => {
    assert.deepEqual(tool().parameters.properties.mode.enum, ['draft', 'finalize']);
  });

  // 確認框上看得出這一下要動哪幾章、要不要定稿——那是作者決定點不點的依據。
  test('動手前那一問寫著區間與模式', () => {
    const intent = tool().intent({ action: 'batchManuscripts', from: 5, to: 8, mode: 'finalize', review: true });
    assert.ok(intent.detail.includes('第 5–8 章，寫完即同步，寫完即審稿'), intent.detail);
  });

  test('action 是這四個動作的列舉', () => {
    assert.deepEqual(tool().parameters.properties.action.enum, ['completeSettings', 'batchPlots', 'batchManuscripts', 'newPlot']);
  });

  // 只給起點時，框裡寫「從第 N 章起」——實際收在哪一章由 feature 按磁碟算，寫在下一個確認框裡。
  test('只給 from 時那一問寫「從第 N 章起」；什麼都不給就不寫區間', () => {
    assert.ok(tool().intent({ action: 'batchManuscripts', from: 3 }).detail.startsWith('從第 3 章起'));
    assert.ok(tool().intent({ action: 'batchManuscripts' }).detail.startsWith('隨後還會告訴你'));
    assert.equal(tool().intent({ action: 'batchManuscripts' }).title, '批次寫章');
  });

  // 第 5 條端到端驗收點的提示詞落點：連續多章該走批次動作而不是迴圈 generate。
  test('描述裡引導「連續多章走批次動作」', () => {
    assert.ok(tool().description.includes('連續多章'), tool().description);
  });

  test('描述裡說清了會先彈確認框告訴作者調幾次', () => {
    assert.ok(tool().description.includes('確認框'), tool().description);
  });
});
