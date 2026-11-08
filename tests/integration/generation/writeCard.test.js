/**
 * 寫正文那張落盤卡片（W7 的後端一半）：卡片上說清寫了多長、是不是追加、有沒有重演上一章結尾；
 * 寫的過程中推進度，丟棄一輪時讓氣泡退回去。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 「x / y 字 · 已達標 / 未寫夠」 | 作者點寫入之前就該知道這一章夠不夠長（D6） |
 * | 續寫了幾輪、一共調了幾次 | 第 4 條：錢花在哪要看得見 |
 * | 接著寫的卡片說「追加」，寫明已有與新寫各多少 | 點下去之後這一章是多長 |
 * | 重演：gate 帶紅色塊與兩段式確認 | 不替作者拒收，但不能讓他一下點過去（總計劃 §2.4） |
 * | 寫的過程中推 `writeProgress` | 氣泡頂上那條進度（W7） |
 * | 丟棄一輪時推 `streamReset` | 氣泡裡不留一段不會被寫入的文字 |
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
let gates = [];
let script = [];

const P2 = '.novelwarden/summaries/002-客棧.md';
const P3 = '.novelwarden/summaries/003-夜访.md';
const P4 = '.novelwarden/summaries/004-井.md';

const CH1_END =
  '客棧的燈還亮著，沈氏坐在櫃檯後面撥算盤，看見他進門，手指停在半空，半晌才說了一句：“李叔來過，問你去了哪裡，我說你出城收賬去了。”林昭沒有答話，把溼透的斗篷掛在門後，從灶上端下那碗早就涼了的薑湯，一口一口喝完。';

function attach() {
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

async function send(plotRelPath, replies, extra = {}) {
  script = [...replies];
  posted = [];
  gates = [];
  await controller.handle({
    type: 'send',
    payload: {
      text: '',
      stage: 'manuscript',
      capability: 'generate',
      target: { kind: 'manuscript', plotRelPath },
      targetNo: 0,
      attachments: [],
      excludedIds: [],
      ...extra,
    },
  });
  const turns = posted.filter((m) => m.type === 'turnDone').map((m) => m.turn);
  return {
    gate: gates[0],
    assistant: [...turns].reverse().find((x) => x.role === 'assistant'),
    progress: posted.filter((m) => m.type === 'writeProgress'),
    resets: posted.filter((m) => m.type === 'streamReset'),
  };
}

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
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  installFakeProvider(bundle.registry, {
    reply: () => script.shift() ?? '',
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'write-card', title: '青雲劍錄' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  const empty = bundle.plotFile.emptyPlotSections();
  for (const [no, title] of [[1, '夜入青雲'], [2, '客棧'], [3, '夜訪'], [4, '井']]) {
    await ws.writePlot({
      no, title, targetWords: 1000, upstreamHash: '', done: false,
      sections: { ...empty, 梗概: `第 ${no} 章的梗概`, 关键事件: `第 ${no} 章的關鍵事件`, 看点: `- 第 ${no} 章的看點` },
    });
  }
  await ws.createChapter(1, '夜入青雲', `${filler(900, 1)}\n\n${CH1_END}`);
  await ws.createChapter(3, '夜訪', filler(300, 3));
  await project.syncManifest();

  controller = new bundle.controller.ChatController(project);
  attach();
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('寫第 2 章：截斷續寫一輪，開頭重演了上一章結尾', () => {
  let r;
  before(async () => {
    r = await send(P2, [
      { text: `${CH1_END}\n\n${filler(700, 20)}`, stop: 'maxTokens', chunks: 4 },
      { text: filler(400, 21), stop: 'end' },
    ]);
  });

  test('卡片寫明字數與達標', () => {
    assert.match(r.gate.detail, /\d+ \/ 1000 字 · 已達標/);
  });

  test('卡片寫明續寫了幾輪、一共調了幾次', () => {
    assert.match(r.gate.detail, /這一輪一共調了 2 次模型（續寫 1 輪）/);
  });

  test('重演：紅色塊寫明重合的原句，寫入要點兩下', () => {
    assert.match(r.gate.danger, /與上一章結尾大段重合/);
    assert.match(r.gate.danger, /沈氏坐在櫃檯後面/);
    assert.equal(r.gate.confirm, '確定仍要寫入');
  });

  test('氣泡上的記錄也帶著字數與重演', () => {
    assert.equal(r.assistant.artifact.length.target, 1000);
    assert.ok(r.assistant.artifact.replay.includes('沈氏'));
  });

  test('寫的過程中推進度：第 0 輪起，報到第 1 輪', () => {
    assert.ok(r.progress.length >= 2, String(r.progress.length));
    assert.equal(r.progress[0].round, 0);
    assert.ok(r.progress.some((p) => p.round === 1));
    assert.ok(r.progress.every((p) => p.target === 1000 && p.turnId === r.assistant.id));
  });
});

describe('接著寫第 3 章：卡片說「追加」', () => {
  let r;
  before(async () => {
    r = await send(P3, [{ text: filler(600, 30), stop: 'end' }], { writeMode: 'continue' });
  });

  test('標題說追加，不說覆蓋', () => {
    assert.ok(r.gate.title.includes('追加到'), r.gate.title);
  });

  test('寫明已有多少、這一次新寫多少', () => {
    assert.match(r.gate.detail, /900 \/ 1000 字 · 已達標（已有 300 字，這一次新寫 600 字，追加在末尾）/);
  });

  test('沒有重演的紅色塊', () => {
    assert.equal(r.gate.danger, undefined);
    assert.equal(r.gate.confirm, undefined);
  });

  test('追加進了磁碟', () => {
    const text = t.read('chapters/003-夜訪.txt');
    assert.ok(text.includes(filler(300, 3)) && text.includes(filler(600, 30)));
  });
});

describe('寫第 4 章：丟棄一輪、最後未寫夠', () => {
  let r;
  before(async () => {
    r = await send(P4, [
      { text: filler(400, 40), stop: 'end' },
      { text: filler(50, 41), stop: 'maxTokens' },
      { text: filler(60, 42), stop: 'maxTokens' },
    ]);
  });

  test('丟棄那一輪時推了 streamReset，退回到丟棄之前那一版', () => {
    assert.ok(r.resets.length >= 1);
    assert.equal(r.resets[0].text, filler(400, 40));
  });

  test('卡片寫「未寫夠」，照樣問寫不寫', () => {
    assert.ok(r.gate);
    assert.match(r.gate.detail, /400 \/ 1000 字 · 未寫夠/);
  });
});
