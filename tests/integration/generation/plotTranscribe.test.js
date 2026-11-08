/**
 * 細綱試點（2026-10-25）：寫細綱的模型按小標題寫自然語言，轉寫模型照抄成 JSON。
 *
 * 作者實測同一份上下文，要模型直接出 JSON 寫出來的細綱明顯不如放開寫。於是細綱（單章、批次、批次拆細綱）的提示詞不再
 * 要 JSON，轉寫那一步由「轉寫」那一檔的模型做：作者定的是**固定的轉寫模型**——不跟對話頁選的、也不跟確認框上為這一次
 * 挑的模型。那一檔沒配就沿用預設模型。
 *
 * | 用例組 | 釘的是什麼 |
 * |---|---|
 * | 批次 · 照抄收下 | 寫一次、轉一次；寫細綱的是對話頁那個模型，轉寫的是轉寫那一檔；轉寫只看原文，不帶書的上下文；氣泡換成規範化 JSON |
 * | 批次 · 改了字 | 轉寫改了原文的字不收，重轉一次（說清哪幾處）；全程只重轉一次，還改就對半拆、各寫各轉 |
 * | 批次 · 原文沒寫那一章 | 偷懶：報漏寫，不重轉（轉寫搬不出原文沒有的章） |
 * | 批次 · 不像細綱 | 連「梗概」「關鍵事件」都沒有的輸出不花轉寫那一次，按解不出來走拆半 / 重建 |
 * | 單章 | 寫第 N 章細綱也轉寫；照抄的落進細綱七節與「設定」一節 |
 * | 單章 · 轉寫兩次不合格 | 按小節讀原文，敘事線計劃與「設定」一節帶不上，說明裡寫清 |
 * | 批次拆細綱 · 確認框釘了模型 | 寫細綱用釘的那個，轉寫照樣走轉寫那一檔（第 12 條的例外） |
 * | 轉寫模型呼叫失敗 | 寫好的原文不丟：單章按小節讀、說明裡寫清；批次報錯，原文留在氣泡裡 |
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
let project;
let controller;
let posted;
let gates;
let onGate = async () => 'skip';
/** 按模型引用注入異常（fakeProvider 的 behavior）：建 provider 時現讀，改它隻影響之後建的。 */
const behavior = {};

const CONFIG = [
  '---',
  'genre: 玄幻',
  'structure: three_act',
  'totalChapters: 30',
  'wordsPerChapter: 400',
  '---',
  '# 小說配置',
  '## 一句話',
  '少年入宗查舊案',
  '## 核心梗概',
  '林昭揹著滅門舊案進青雲宗。',
].join('\n');

const OUTLINE = outlineOf(20, { titles: { 1: '入局' }, text: { 1: '林昭進青雲宗，查出第一塊令牌的來歷。' } });
const THREAD = '.novelwarden/threads/青雲舊案.md';

/** 寫細綱的模型按格式寫出來的一章。 */
const prose = (no) =>
  [
    `## 第${no}章：第${no}章題`,
    '### 梗概',
    `第 ${no} 章的梗概`,
    '### 出場人物',
    '林昭、沈青',
    '### 時間地點',
    '青雲宗山門，入夜',
    '### 關鍵事件',
    `- 第 ${no} 章：林昭在山門外踩點。`,
    '- 他翻牆進了後院，落在藏書閣門口。',
    '### 看點',
    `- 第 ${no} 章的鉤子`,
    '### 狀態變更',
    '無',
    '### 敘事線',
    '- 青雲舊案·推進：林昭摸到藏書閣。',
    '### 新角色',
    '無',
    '### 設定',
    '- 藏經閣（地點，新）：宗門藏舊卷宗的地方。',
  ].join('\n');

/** 轉寫模型照抄出來的那一章。 */
const copied = (no, over = {}) => ({
  chapterNumber: no,
  title: `第${no}章題`,
  synopsis: `第 ${no} 章的梗概`,
  characters: ['林昭', '沈青'],
  timePlace: '青雲宗山門，入夜',
  keyEvents: [`第 ${no} 章：林昭在山門外踩點。`, '他翻牆進了後院，落在藏書閣門口。'],
  highlights: [`第 ${no} 章的鉤子`],
  stateChange: '無',
  threads: [{ line: '青雲舊案', type: '推进', what: '林昭摸到藏書閣。' }],
  newCharacters: [],
  settings: [{ name: '藏經閣', category: '地點', isNew: true, note: '宗門藏舊卷宗的地方。' }],
  ...over,
});
const json = (...items) => JSON.stringify({ blueprints: items });
const PLOT_T = (no) => ({ kind: 'plot', plotRelPath: `.novelwarden/summaries/${String(no).padStart(3, '0')}.md` });
const TRANSCRIBER = '格式轉寫員';

function attach() {
  posted = [];
  controller.attach({
    kind: 'sidebar',
    post: (m) => {
      posted.push(m);
      if (m.type === 'gate') {
        gates.push(m);
        void (async () => {
          const verdict = await onGate(m);
          if (verdict) {
            await controller.handle({ type: 'gateResult', requestId: m.requestId, verdict });
          }
        })();
      }
    },
    reveal() {},
  });
}

async function send(payload) {
  posted.length = 0;
  gates = [];
  await controller.handle({
    type: 'send',
    payload: { text: '', targetNo: 0, attachments: [], excludedIds: [], ...payload },
  });
  const turns = posted.filter((m) => m.type === 'turnDone').map((m) => m.turn);
  return {
    assistant: [...turns].reverse().find((x) => x.role === 'assistant'),
    gate: gates[0],
    errors: posted.filter((m) => m.type === 'toast' && m.level === 'error').map((m) => m.message),
  };
}

const systemOf = (i) => fake.calls[i][0].content;
const userOf = (i) => fake.calls[i][fake.calls[i].length - 1].content;
const refOf = (i) => fake.calls[i].ref;

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    controller: './src/core/controller/index.ts',
    batch: './src/core/features/pipelineBatch.ts',
    db: './src/core/runtime/db.ts',
  });
  // 對話頁選的是 big；轉寫那一檔（預設快速檔）配的是 small。
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'big', contextWindow: 100000 }, { name: 'small', contextWindow: 32000 }] }],
    models: ['p/big'],
    tierModels: { fast: ['p/small'] },
    concurrency: 1,
  };
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    behavior,
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });
  t = await makeTempProject(bundle.project, { prefix: 'transcribe', title: '青雲劍錄' });
  project = t.project;
  t.write('.novelwarden/config.md', CONFIG);
  writeOutline(t, OUTLINE);
  // 有一條線：批次拆細綱就不先排線。
  t.write(THREAD, '---\nkind: 主線\n---\n\n# 青雲舊案\n\n## 意圖\n十年前那把火。\n');
  project.invalidate();
  controller = new bundle.controller.ChatController(project);
  attach();
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('細綱批次 · 按小標題寫，轉寫模型照抄成 JSON', () => {
  let r;

  before(async () => {
    fake.reset([
      { text: `${prose(6)}\n\n${prose(7)}`, stop: 'end' },
      { text: json(copied(6), copied(7)), stop: 'end' },
    ]);
    onGate = async () => 'skip';
    r = await send({ stage: 'plot', capability: 'generate', target: PLOT_T(6), range: { from: 6, to: 7 } });
  });

  test('寫一次、轉一次', () => {
    assert.equal(fake.callCount(), 2);
    assert.ok(r.gate && r.gate.detail.includes('調了 2 次'), JSON.stringify(r.gate ?? r.errors));
  });

  test('寫細綱的提示詞不要 JSON', () => {
    assert.ok(userOf(0).includes('寫第 6–7 章的細綱：一章一份') && userOf(0).includes('不寫 JSON'), userOf(0).slice(-600));
  });

  test('寫細綱的是對話頁那個模型，轉寫的是轉寫那一檔', () => {
    assert.equal(refOf(0), 'p/big');
    assert.equal(refOf(1), 'p/small');
  });

  // 轉寫只看原文：給多了它會順手補內容。
  test('轉寫只帶合同與原文，不帶書的上下文', () => {
    assert.ok(systemOf(1).includes(TRANSCRIBER), systemOf(1));
    assert.ok(userOf(1).includes('【原文】') && userOf(1).includes('第 6 章的梗概') && userOf(1).includes('原文寫的是第 6–7 章'), userOf(1).slice(0, 600));
    assert.ok(!userOf(1).includes('林昭揹著滅門舊案進青雲宗'), userOf(1).slice(0, 600));
  });

  test('氣泡換成規範化 JSON，「無」換成空的', () => {
    const decoded = JSON.parse(r.assistant.content);
    assert.deepEqual(decoded.blueprints.map((b) => b.chapterNumber), [6, 7]);
    assert.equal(decoded.blueprints[0].stateChange, '');
    assert.deepEqual(decoded.blueprints[0].threads, [{ line: '青雲舊案', type: '推进', what: '林昭摸到藏書閣。' }]);
  });
});

describe('細綱批次 · 轉寫改了原文的字', () => {
  let r;

  before(async () => {
    const reworded = json(copied(6, { keyEvents: ['林昭夜探藏書閣，被人發現。'] }), copied(7));
    fake.reset([
      { text: `${prose(6)}\n\n${prose(7)}`, stop: 'end' },
      { text: reworded, stop: 'end' },
      { text: reworded, stop: 'end' },
      { text: prose(6), stop: 'end' },
      { text: json(copied(6)), stop: 'end' },
      { text: prose(7), stop: 'end' },
      { text: json(copied(7)), stop: 'end' },
    ]);
    onGate = async () => 'skip';
    r = await send({ stage: 'plot', capability: 'generate', target: PLOT_T(6), range: { from: 6, to: 7 } });
  });

  test('重轉那一次說清哪幾處不是原文裡的字', () => {
    assert.ok(systemOf(2).includes(TRANSCRIBER));
    assert.ok(userOf(2).includes('【上次轉寫不合格】這幾處不是原文裡的字：「林昭夜探藏書閣，被人發現。」'), userOf(2).slice(0, 600));
  });

  test('全程只重轉一次：還改就對半拆，各寫各轉', () => {
    assert.equal(fake.callCount(), 7);
    assert.ok(userOf(3).includes('寫第 6 章的細綱：') && userOf(5).includes('寫第 7 章的細綱：'), `${userOf(3).slice(-300)}\n${userOf(5).slice(-300)}`);
    assert.ok(r.gate, JSON.stringify(r.errors));
    assert.ok(r.gate.detail.includes('重轉一次') && r.gate.detail.includes('拆成兩半重試'), r.gate.detail);
  });
});

describe('細綱批次 · 原文就沒寫那一章', () => {
  let r;

  before(async () => {
    fake.reset([
      { text: prose(6), stop: 'end' },
      { text: json(copied(6)), stop: 'end' },
    ]);
    onGate = async () => 'skip';
    r = await send({ stage: 'plot', capability: 'generate', target: PLOT_T(6), range: { from: 6, to: 7 } });
  });

  test('報漏寫、不出卡片、不重轉', () => {
    assert.equal(r.gate, undefined);
    assert.ok(r.errors.some((m) => m.includes('漏寫了第 7 章')), r.errors.join('|'));
    assert.equal(fake.callCount(), 2);
  });

  test('寫好的原文留在氣泡裡', () => {
    assert.ok(r.assistant.content.includes('第 6 章的梗概'), r.assistant.content.slice(0, 200));
  });
});

describe('細綱批次 · 不像細綱的輸出不轉寫', () => {
  let r;

  before(async () => {
    fake.reset([
      { text: '我不太確定這一章要寫什麼。', stop: 'end' },
      { text: '還是不確定。', stop: 'end' },
    ]);
    onGate = async () => 'skip';
    r = await send({ stage: 'plot', capability: 'generate', target: PLOT_T(6), range: { from: 6, to: 6 } });
  });

  test('單章重建一次、還不行就停，一次轉寫都沒花', () => {
    assert.equal(fake.callCount(), 2);
    assert.ok(!fake.calls.some((c) => c[0].content.includes(TRANSCRIBER)));
    assert.ok(userOf(1).includes('【上次輸出不合格】沒有按格式寫'), userOf(1).slice(-400));
    assert.equal(r.gate, undefined);
    assert.ok(r.errors.some((m) => m.includes('細綱不合格')), r.errors.join('|'));
  });
});

describe('單章細綱 · 寫第 N 章細綱也轉寫', () => {
  let r;

  before(async () => {
    fake.reset([
      { text: prose(8), stop: 'end' },
      { text: json(copied(8)), stop: 'end' },
    ]);
    onGate = async () => 'proceed';
    r = await send({ stage: 'plot', capability: 'generate', target: { kind: 'plot', plotRelPath: await project.plotPathOfNo(8) } });
  });

  test('寫一次、轉一次；轉寫的是轉寫那一檔，合同裡給了章號', () => {
    assert.equal(fake.callCount(), 2);
    assert.equal(refOf(1), 'p/small');
    assert.ok(userOf(0).includes('寫第 8 章的細綱：以「## 第8章：標題」開頭'), userOf(0).slice(-800));
    assert.ok(userOf(1).includes('原文寫的是第 8 章，只有一項，chapterNumber 是 8'), userOf(1).slice(0, 600));
  });

  test('照抄的落進細綱七節與「設定」一節', async () => {
    assert.ok(r.gate, JSON.stringify(r.errors));
    project.invalidate();
    const plot = await project.getPlot(8);
    assert.equal(plot.sections.关键事件, '- 第 8 章：林昭在山門外踩點。\n- 他翻牆進了後院，落在藏書閣門口。', JSON.stringify(plot.sections));
    assert.equal(plot.sections.出场人物, '林昭、沈青');
    assert.ok(plot.lore.some((l) => l.name === '藏經閣'), JSON.stringify(plot.lore));
  });
});

describe('單章細綱 · 轉寫兩次都不合格', () => {
  let r;

  before(async () => {
    const reworded = json(copied(9, { synopsis: '改寫過的梗概' }));
    fake.reset([
      { text: prose(9), stop: 'end' },
      { text: reworded, stop: 'end' },
      { text: reworded, stop: 'end' },
    ]);
    onGate = async () => 'proceed';
    r = await send({ stage: 'plot', capability: 'generate', target: { kind: 'plot', plotRelPath: await project.plotPathOfNo(9) } });
  });

  test('重轉一次，還不行就按小節讀原文，說明裡寫清', async () => {
    assert.equal(fake.callCount(), 3);
    assert.ok(r.gate && r.gate.detail.includes('轉寫沒成，按小節讀了原文'), JSON.stringify(r.gate ?? r.errors));
    project.invalidate();
    const plot = await project.getPlot(9);
    assert.ok(plot.sections.关键事件.includes('林昭在山門外踩點'), JSON.stringify(plot.sections));
    assert.equal(plot.sections.出场人物, '林昭、沈青', JSON.stringify(plot.sections));
  });
});

describe('批次拆細綱 · 確認框上釘了模型，轉寫照樣走轉寫那一檔', () => {
  let returned;

  before(async () => {
    fake.reset([
      { text: prose(10), stop: 'end' },
      { text: json(copied(10)), stop: 'end' },
    ]);
    returned = await bundle.batch.generatePlots(project, { range: { from: 10, to: 10 }, call: { model: 'p/big' } });
  });

  test('寫細綱用釘的那個，轉寫用 small', () => {
    assert.equal(returned, 2);
    assert.equal(refOf(0), 'p/big');
    assert.equal(refOf(1), 'p/small');
    assert.ok(systemOf(1).includes(TRANSCRIBER));
  });

  // 梗概沿用空殼上的那一條（大綱裡這一章那一條，是這一批的上游）。
  test('細綱寫進去了', async () => {
    project.invalidate();
    const plot = await project.getPlot(10);
    assert.ok(plot.sections.关键事件.includes('第 10 章：林昭在山門外踩點'), JSON.stringify(plot.sections));
  });
});

describe('轉寫模型呼叫失敗', () => {
  before(() => {
    behavior['p/small'] = 'fail';
  });
  after(() => {
    delete behavior['p/small'];
  });

  test('單章：按小節讀原文，說明裡寫清', async () => {
    fake.reset([{ text: prose(11), stop: 'end' }]);
    onGate = async () => 'skip';
    const r = await send({ stage: 'plot', capability: 'generate', target: { kind: 'plot', plotRelPath: await project.plotPathOfNo(11) } });
    assert.ok(r.gate && r.gate.detail.includes('轉寫呼叫失敗') && r.gate.detail.includes('按小節讀了原文'), JSON.stringify(r.gate ?? r.errors));
  });

  test('批次：報錯、不出卡片，寫好的原文留在氣泡裡', async () => {
    fake.reset([{ text: `${prose(6)}\n\n${prose(7)}`, stop: 'end' }]);
    onGate = async () => 'skip';
    const r = await send({ stage: 'plot', capability: 'generate', target: PLOT_T(6), range: { from: 6, to: 7 } });
    assert.equal(r.gate, undefined);
    assert.ok(r.errors.some((m) => m.includes('轉寫呼叫失敗')), r.errors.join('|'));
    assert.ok(r.assistant.content.includes('第 7 章的梗概'), r.assistant.content.slice(0, 300));
  });
});
