/**
 * 章節工作臺的後端一半（W6）：`openChapter` 與 `chapterAction`。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 有正文、有細綱、宿主能並排 | 正文開在主區，細綱並排——點一下就能對照著看 |
 * | 宿主不能並排 | 只開正文（能力探測，不判斷是哪個殼） |
 * | 前端眼下沒有第二塊（窄屏，`beside: false`） | 同樣只開正文：並排的那份開進同一塊會頂掉正文的臨時標籤 |
 * | 還沒有正文 | 只開細綱 |
 * | 兩樣都沒有 | 說找不到，不開一個空檔案 |
 * | 有正文、還沒有細綱（2026-10-23） | 按模板建一份空骨架（標題是章名、沒有上游指紋）再並排開；建過一次再點就認它、不另建 |
 * | 上一次並排開的是草稿（2026-10-23） | 點開一章旁邊開這一章的草稿（沒有就建）、不開細綱；工具欄「細綱」（`openPlot`）點過就換回細綱 |
 * | 工具欄「細綱」 | 並排開這一章的細綱，還沒有就按模板建；不認真實章節列表之外的路徑 |
 * | 工具條「接著寫」 | 等於對這一章按主按鈕：切到正文層、按那種寫法生成，照樣當場問寫不寫 |
 * | 工具條「定稿」 | 走定稿那條工程動作 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, filler } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let t;
let project;
let controller;
let posted = [];
let beside = [];
let replies = [];
let fake;

const P1 = '.novelwarden/summaries/001-夜入青雲.md';
const P2 = '.novelwarden/summaries/002-客棧.md';
const CH1 = 'chapters/001-夜入青雲.txt';

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    controller: './src/core/controller/index.ts',
    plotFile: './src/core/model/plotFile.ts',
    db: './src/core/runtime/db.ts',
  });
  // 多配一個 strong：「重寫…」的確認框上為這一輪換它。對話頁選定的（`models` 首項）仍是 m。
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }, { name: 'strong', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
  h = makeFakeHost({
    name: 'standalone',
    supportsVscodeLm: true,
    settings: () => settings,
    overrides: { openBeside: async (p) => { beside.push(p); } },
  });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply: () => replies.shift() ?? '',
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'chapter-bench', title: '青雲劍錄' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  const empty = bundle.plotFile.emptyPlotSections();
  for (const [no, title] of [[1, '夜入青雲'], [2, '客棧']]) {
    await ws.writePlot({
      no, title, targetWords: 1000, upstreamHash: '', done: false,
      sections: { ...empty, 梗概: `第 ${no} 章的梗概`, 关键事件: `第 ${no} 章的關鍵事件`, 看点: `第 ${no} 章的看點` },
    });
  }
  await ws.createChapter(1, '夜入青雲', filler(300, 1));
  await project.syncManifest();

  controller = new bundle.controller.ChatController(project);
  controller.attach({
    kind: 'sidebar',
    post: (m) => {
      posted.push(m);
      if (m.type === 'gate') {
        void controller.handle({ type: 'gateResult', requestId: m.requestId, verdict: 'proceed' });
      }
    },
    reveal() {},
  });
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

async function open(plotRelPath, extra = {}) {
  h.expect();
  beside = [];
  posted = [];
  await controller.handle({ type: 'openChapter', plotRelPath, ...extra });
  // 找不到時的那句話走面板的 toast（`c.toast` 推給前端），不走宿主的通知。
  const toasts = posted.filter((m) => m.type === 'toast').map((m) => `${m.level ?? 'info'}: ${m.message}`);
  return { opened: [...h.opened], beside: [...beside], toasts };
}

describe('openChapter', () => {
  test('有正文有細綱：正文開在主區，細綱並排', async () => {
    const r = await open(P1);
    assert.deepEqual(r.opened, [CH1]);
    assert.deepEqual(r.beside, [P1]);
  });

  test('給的是章節路徑也認得出是哪一章', async () => {
    const r = await open(CH1);
    assert.deepEqual(r.opened, [CH1]);
    assert.deepEqual(r.beside, [P1]);
  });

  test('還沒有正文：只開細綱', async () => {
    const r = await open(P2);
    assert.deepEqual(r.opened, [P2]);
    assert.deepEqual(r.beside, []);
  });

  test('兩樣都沒有：說找不到，什麼都不開', async () => {
    const r = await open('.novelwarden/summaries/009.md');
    assert.deepEqual(r.opened, []);
    assert.ok(r.toasts.some((m) => m.startsWith('error:')), JSON.stringify(r.toasts));
  });

  test('宿主不能並排（沒有 openBeside）：只開正文', async () => {
    const saved = h.host.openBeside;
    delete h.host.openBeside;
    try {
      const r = await open(P1);
      assert.deepEqual(r.opened, [CH1]);
      assert.deepEqual(r.beside, []);
    } finally {
      h.host.openBeside = saved;
    }
  });

  test('前端說眼下沒有第二塊（窄屏，beside: false）：只開正文，不併排、不建細綱', async () => {
    const r = await open(P1, { beside: false });
    assert.deepEqual(r.opened, [CH1]);
    assert.deepEqual(r.beside, []);
  });

  // 2026-10-18 的迴歸：分卷的書，細綱映象正文的相對路徑躺在 `summaries/第二卷/` 裡。合併細綱與摘要那一次
  // 只認 `summaries/` 根下，點章節名只開了正文，旁邊那份細綱打不開。
  test('正文在卷目錄裡：旁邊開啟的是 summaries/ 同一個卷目錄裡的那份細綱', async () => {
    t.write('chapters/第二卷/003-雪夜.txt', '雪下了一夜。\n');
    t.write('.novelwarden/summaries/第二卷/003-雪夜.md', '---\nno: 3\ntitle: 雪夜\n---\n\n## 關鍵事件\n\n- 雪下了一夜。\n');
    project.invalidate();
    try {
      const r = await open('chapters/第二卷/003-雪夜.txt');
      assert.deepEqual(r.opened, ['chapters/第二卷/003-雪夜.txt']);
      assert.deepEqual(r.beside, ['.novelwarden/summaries/第二卷/003-雪夜.md']);
    } finally {
      // 第 3 章有正文、第 2 章沒有會讓後面「重寫…」先問一句章號斷了（features/chapterGap.ts）。
      t.remove('chapters/第二卷');
      t.remove('.novelwarden/summaries/第二卷');
      project.invalidate();
    }
  });
});

describe('openChapter：沒有細綱按模板建、旁邊開哪一份跟上一次走', () => {
  const CH4 = 'chapters/004-遠行.md';
  const P4 = '.novelwarden/summaries/004-遠行.md';
  const D1 = 'drafts/001-夜入青雲.txt';
  const D4 = 'drafts/004-遠行.md';
  const results = {};

  before(async () => {
    t.write(CH4, '# 遠行\n\n天還沒亮。\n');
    project.invalidate();
    results.first = await open(CH4);
    results.made = await project.readPlot(P4);
    results.again = await open(CH4);

    // 工具欄「草稿」開過一次草稿：之後點開一章，旁邊開的是草稿。
    beside = [];
    await controller.handle({ type: 'openDraft', path: CH1 });
    results.draftBtn = [...beside];
    results.draftMode = await open(P1);
    results.draftMode4 = await open(CH4);

    // 工具欄「細綱」：並排開細綱，換回細綱。
    beside = [];
    await controller.handle({ type: 'openPlot', path: CH1 });
    results.plotBtn = [...beside];
    results.plotMode = await open(P1);

    posted = [];
    beside = [];
    await controller.handle({ type: 'openPlot', path: 'chapters/不存在.md' });
    results.unknown = { beside: [...beside], toasts: posted.filter((m) => m.type === 'toast').map((m) => `${m.level}: ${m.message}`) };
  });

  after(() => {
    // 第 4 章有正文、2–3 章沒有會讓後面「重寫…」先問一句章號斷了（features/chapterGap.ts）。
    for (const rel of [CH4, P4, D1, D4]) t.remove(rel);
    project.invalidate();
  });

  test('有正文沒細綱：按模板建一份再並排開', () => {
    assert.deepEqual(results.first.opened, [CH4]);
    assert.deepEqual(results.first.beside, [P4]);
    assert.equal(results.made?.title, '遠行');
    assert.equal(results.made?.upstreamHash ?? '', '');
    assert.deepEqual(Object.values(results.made.sections).filter((v) => v.trim()), []);
  });

  test('再點就認那一份，不另建', () => {
    assert.deepEqual(results.again.beside, [P4]);
    assert.ok(!results.again.toasts.some((m) => m.startsWith('error:')), JSON.stringify(results.again.toasts));
  });

  test('點過「草稿」之後，點開一章旁邊開草稿、不開細綱', () => {
    assert.deepEqual(results.draftBtn, [D1]);
    assert.deepEqual(results.draftMode.opened, [CH1]);
    assert.deepEqual(results.draftMode.beside, [D1]);
  });

  test('那一章還沒有草稿就建一份', () => {
    assert.deepEqual(results.draftMode4.beside, [D4]);
    assert.ok(t.has(D4));
  });

  test('點過「細綱」就換回細綱', () => {
    assert.deepEqual(results.plotBtn, [P1]);
    assert.deepEqual(results.plotMode.beside, [P1]);
  });

  test('「細綱」不認章節列表之外的路徑', () => {
    assert.deepEqual(results.unknown.beside, []);
    assert.ok(results.unknown.toasts.some((m) => m.startsWith('error:')), JSON.stringify(results.unknown.toasts));
  });
});

describe('chapterAction', () => {
  let gate;
  let session;

  before(async () => {
    replies = [{ text: filler(800, 2), stop: 'end' }];
    posted = [];
    await controller.handle({ type: 'chapterAction', plotRelPath: P1, action: 'continue' });
    gate = posted.find((m) => m.type === 'gate');
    session = [...posted].reverse().find((m) => m.type === 'session')?.session;
  });

  test('接著寫：切到這一章的正文層', () => {
    assert.deepEqual(session.target, { kind: 'manuscript', plotRelPath: P1 });
  });

  test('照樣當場問寫不寫，說的是追加', () => {
    assert.ok(gate, JSON.stringify(posted.map((m) => m.type)));
    assert.ok(gate.title.includes('追加到'), gate.title);
  });

  test('追加進了第 1 章', () => {
    const text = t.read(CH1);
    assert.ok(text.includes(filler(300, 1)) && text.includes(filler(800, 2)));
  });

  test('還沒有正文時點「定稿」：說無法定稿，不起任務', async () => {
    posted = [];
    await controller.handle({ type: 'chapterAction', plotRelPath: P2, action: 'finalize' });
    const toasts = posted.filter((m) => m.type === 'toast').map((m) => m.message);
    assert.ok(toasts.some((m) => m.includes('無法同步')), JSON.stringify(toasts));
  });
});

/**
 * 工程頁「故事架構」右鍵「重寫…」：先問一句要求，再對那一件發一輪生成。
 * 取消就什麼都不做；「討論」那條（setTarget）不在這裡——它只切層、不花錢。
 */
describe('rewriteArchitecture', () => {
  const PREMISE = '.novelwarden/premise.md';

  before(() => {
    t.write(PREMISE, '# 故事前提\n\n少年入青雲，一路被人看不起。\n');
  });

  test('取消那一句要求：不切層、不起生成', async () => {
    h.expect(undefined);
    posted = [];
    await controller.handle({ type: 'rewriteArchitecture', target: { kind: 'setting', doc: 'premise' } });
    assert.equal(h.inputs.length, 1);
    assert.ok(!posted.some((m) => m.type === 'session' || m.type === 'gate'), JSON.stringify(posted.map((m) => m.type)));
  });

  test('寫了要求、在確認框上取消：不切層、不起生成', async () => {
    h.expect('主角的金手指換成劍靈', undefined);
    posted = [];
    fake.reset();
    await controller.handle({ type: 'rewriteArchitecture', target: { kind: 'setting', doc: 'premise' } });
    assert.equal(h.confirms.length, 1);
    assert.equal(fake.callCount(), 0);
    assert.ok(!posted.some((m) => m.type === 'session' || m.type === 'gate'), JSON.stringify(posted.map((m) => m.type)));
  });

  test('確認框：報次數，模型預設是對話頁那個，帶詳細度下拉框', () => {
    const [c] = h.confirms;
    assert.deepEqual(c.actions, ['開始重寫']);
    assert.ok(c.message.startsWith('重寫故事架構 · 故事前提：') && c.message.includes('預計 1 次呼叫'), c.message);
    assert.equal(c.call.model, 'p/m');
    assert.ok(c.call.contextDetail, JSON.stringify(c.call));
  });

  test('寫了要求：切到那一件、發一輪生成，要求進了使用者那一輪，照樣當場問寫不寫', async () => {
    h.expect('主角的金手指換成劍靈', '開始重寫');
    fake.reset();
    replies = [{ text: '# 故事前提\n\n少年得劍靈相助，入青雲後一路逆襲打臉。\n', stop: 'end' }];
    posted = [];
    await controller.handle({ type: 'rewriteArchitecture', target: { kind: 'setting', doc: 'premise' } });
    const session = [...posted].reverse().find((m) => m.type === 'session')?.session;
    assert.deepEqual(session.target, { kind: 'setting', doc: 'premise' });
    const turns = posted.filter((m) => m.type === 'turnDone').map((m) => m.turn);
    const user = turns.find((u) => u.role === 'user');
    assert.ok(user?.content.includes('劍靈'), JSON.stringify(turns.map((u) => [u.role, u.content])));
    assert.equal(user.command, '生成這份架構檔案', JSON.stringify(user));
    assert.ok(posted.some((m) => m.type === 'gate'), JSON.stringify(posted.map((m) => m.type)));
    assert.equal(fake.calls[0].ref, 'p/m');
  });

  // 對話頁這條路認確認框上換的模型（generate 認 `pinnedModel`），只這一輪。
  test('確認框上換一個模型：這一輪只用它', async () => {
    h.expect('', { action: '開始重寫', choice: { model: 'p/strong' } });
    replies = [{ text: '# 故事前提\n\n少年入青雲。\n', stop: 'end' }];
    fake.reset();
    await controller.handle({ type: 'rewriteArchitecture', target: { kind: 'setting', doc: 'premise' } });
    assert.ok(fake.callCount() >= 1, String(fake.callCount()));
    assert.deepEqual([...new Set(fake.calls.map((m) => m.ref))], ['p/strong']);
  });

  test('不是架構或大綱的目標：什麼都不做', async () => {
    h.expect('x');
    posted = [];
    await controller.handle({ type: 'rewriteArchitecture', target: { kind: 'plot', plotRelPath: P1 } });
    assert.equal(h.inputs.length, 0);
    assert.equal(posted.length, 0);
  });
});
