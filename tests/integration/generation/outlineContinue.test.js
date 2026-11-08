/**
 * `/續寫大綱`（2026-10-24）：停在一章上也能往後排大綱。從前回全書那一層只有目標下拉框最上面那一項，
 * 主按鈕又只在「下一章超出大綱」時才推續寫，作者找不到入口。
 *
 * | 用例組 | 釘的是什麼 |
 * |---|---|
 * | 跨層 | 在第 3 章的細綱上 `/續寫大綱`：前端不帶區間，後端按大綱排到哪現算（第 4–23 章）；這一輪臨時換到情節大綱，跑完回到第 3 章 |
 * | 重來 | 會話已經回到原來那一章，重來一輪照樣換過去再回來，區間照舊 |
 * | 大綱那一層 | 續寫就是這一層自己的生成；區間收在總章數；會話留在大綱那一層 |
 * | 攔下 | 排到最後一章：不調模型、不記一輪，說總章數；要續的那一段裡已經有正文：不調模型，指去從已寫正文補齊 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let fake;
let t;
let project;
let controller;
let posted;
let gates;

const pad3 = (n) => String(n).padStart(3, '0');
const CH = (no) => `chapters/${pad3(no)}-第${no}章.md`;
const PLOT = (no) => `.novelwarden/summaries/${pad3(no)}-第${no}章.md`;
const PLOT3 = { kind: 'plot', plotRelPath: PLOT(3) };
const OUTLINE = { kind: 'outline' };
/** `/續寫大綱` 發出來的樣子：帶著情節大綱的階段與目標，不帶區間。 */
const CONTINUE = { stage: 'outline', capability: 'generate', target: OUTLINE };

function plotText(no) {
  return ['---', `no: ${no}`, `title: 第${no}章`, '---', '', `# 第${no}章 第${no}章`, '', '## 梗概', '', `第${no}章的梗概。`, ''].join('\n');
}

/** 模型續出來的那一段：一章一條。 */
const outlineOf = (from, to) =>
  Array.from({ length: to - from + 1 }, (_, i) => `## 第${from + i}章：續${from + i}\n\n林昭往下查，第${from + i}章。`).join('\n\n');

function attach() {
  posted = [];
  controller.attach({
    kind: 'sidebar',
    post: (m) => {
      posted.push(m);
      if (m.type === 'gate') {
        gates.push(m);
        void controller.handle({ type: 'gateResult', requestId: m.requestId, verdict: 'proceed' });
      }
    },
    reveal() {},
  });
}

const payload = (over) => ({ text: '', targetNo: 3, attachments: [], excludedIds: [], ...over });

async function continueOutline(answer, text = '') {
  posted.length = 0;
  gates = [];
  h.expect();
  fake.reset(answer === undefined ? [] : [{ text: answer, stop: 'end' }]);
  await controller.handle({ type: 'send', payload: payload({ text, ...CONTINUE }) });
  project.invalidate();
}

const toasts = () => posted.filter((m) => m.type === 'toast').map((m) => m.message);
const prompt = (i = 0) => fake.calls[i].map((m) => m.content).join('\n');
const lastUser = () => controller.current.turns.filter((x) => x.role === 'user').at(-1);

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    controller: './src/core/controller/index.ts',
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
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });
  t = await makeTempProject(bundle.project, { prefix: 'outlineContinue', title: '天機錄' });
  project = t.project;
  t.write('.novelwarden/config.md', '---\ngenre: 武俠\ntotalChapters: 30\nwordsPerChapter: 400\n---\n\n# 小說配置\n\n## 核心梗概\n\n林昭查舊案。\n');
  t.write(CH(1), '# 第1章\n\n第1章的正文。\n');
  t.write(CH(2), '# 第2章\n\n第2章的正文。\n');
  for (const no of [1, 2, 3]) {
    t.write(PLOT(no), plotText(no));
  }
  project.invalidate();
  controller = new bundle.controller.ChatController(project);
  attach();
  await controller.handle({ type: 'setTarget', target: PLOT3 });
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('跨層：在第 3 章的細綱上 /續寫大綱', () => {
  before(async () => {
    await continueOutline(outlineOf(4, 23), '讓主角在第 10 章前進宗門');
  });

  test('一次呼叫；區間由後端按大綱排到哪現算：第 4–23 章', () => {
    assert.equal(fake.callCount(), 1);
    assert.ok(prompt().includes('本次必須寫第 4–23 章的情節大綱'), prompt().slice(-2000));
    assert.ok(prompt().includes('讓主角在第 10 章前進宗門'));
  });

  test('命令記成「續寫大綱」，區間記在這一輪上（重來照用）', () => {
    const turn = lastUser();
    assert.equal(turn.command, '續寫大綱');
    assert.equal(turn.continueOutline, true);
    assert.deepEqual(turn.range, { from: 4, to: 23 });
  });

  test('卡片落在那一段，寫進各章細綱的梗概', async () => {
    assert.ok(gates[0]?.title.includes('情節大綱 · 第 4–23 章'), gates[0]?.title);
    const outline = await project.readOutline();
    assert.equal((outline.match(/^## 第\d+章/gm) ?? []).length, 23, outline.slice(0, 300));
    assert.ok(outline.includes('林昭往下查，第23章。'));
  });

  test('跑完回到第 3 章的細綱', () => {
    assert.deepEqual(controller.current.target, PLOT3);
    assert.equal(controller.current.stage, 'plot');
    assert.equal(controller.current.capability, 'discuss');
    assert.deepEqual(posted.filter((m) => m.type === 'session').at(-1).session.target, PLOT3);
  });
});

describe('重來', () => {
  test('會話已經回到第 3 章：照樣換到情節大綱、區間照舊，跑完再回來', async () => {
    const turn = lastUser();
    posted.length = 0;
    gates = [];
    h.expect();
    fake.reset([{ text: outlineOf(4, 23), stop: 'end' }]);
    await controller.handle({ type: 'retry', turnId: turn.id, payload: payload({ stage: 'plot', capability: 'discuss', target: PLOT3 }) });
    project.invalidate();
    assert.equal(fake.callCount(), 1);
    assert.ok(prompt().includes('本次必須寫第 4–23 章的情節大綱'), prompt().slice(-2000));
    assert.deepEqual(controller.current.target, PLOT3);
    assert.equal(controller.current.stage, 'plot');
  });
});

describe('大綱那一層', () => {
  before(async () => {
    await controller.handle({ type: 'setTarget', target: OUTLINE });
    await continueOutline(outlineOf(24, 30));
  });

  test('續寫就是這一層自己的生成：區間收在總章數（第 24–30 章）', () => {
    assert.equal(fake.callCount(), 1);
    assert.ok(prompt().includes('本次必須寫第 24–30 章的情節大綱'), prompt().slice(-2000));
    assert.deepEqual(lastUser().range, { from: 24, to: 30 });
  });

  test('會話留在大綱那一層', () => {
    assert.deepEqual(controller.current.target, OUTLINE);
    assert.equal(controller.current.stage, 'outline');
  });
});

describe('攔下', () => {
  test('排到最後一章了：不調模型、不記一輪，說總章數', async () => {
    const before0 = controller.current.turns.length;
    await continueOutline();
    assert.equal(fake.callCount(), 0);
    assert.equal(controller.current.turns.length, before0);
    assert.ok(toasts().some((m) => m.includes('已經排到第 30 章，全書共 30 章')), toasts().join('|'));
  });

  test('要續的那一段裡已經有正文：不調模型，指去從已寫正文補齊', async () => {
    t.write('.novelwarden/config.md', '---\ngenre: 武俠\ntotalChapters: 60\nwordsPerChapter: 400\n---\n\n# 小說配置\n\n## 核心梗概\n\n林昭查舊案。\n');
    t.write(CH(31), '# 第31章\n\n先寫了的第31章。\n');
    project.invalidate();
    const before0 = controller.current.turns.length;
    await continueOutline();
    assert.equal(fake.callCount(), 0);
    assert.equal(controller.current.turns.length, before0);
    assert.ok(toasts().some((m) => m.includes('情節大綱只排到第 30 章，可第 31 章裡已經有正文') && m.includes('從已寫正文補齊')), toasts().join('|'));
  });
});
