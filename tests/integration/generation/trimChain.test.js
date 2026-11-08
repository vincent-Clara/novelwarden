/**
 * 刪修飾（generation/trim.ts）：寫正文鏈的最後一步，經 `generate` 跑，設定裡開著才跑。
 *
 * | 情形 | 斷言 |
 * |---|---|
 * | 刪得合格 | 多 1 次呼叫；Draft 是刪後的、帶刪之前那版；氣泡退回刪後的；帶編號的輸出不流進氣泡；訊息不帶裝配內容 |
 * | 模型加了字 | 整段退回，Draft 原樣、不帶刪之前那版，說明裡寫退回原因 |
 * | 刪到八成以下 | 從刪得最多的段退回，夠八成為止 |
 * | 呼叫失敗 | 正文保持原樣，照樣出 Draft |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, filler } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let fake;
let t;
let script = [];

const P1 = '.novelwarden/summaries/001-夜入青雲.md';

/** 兩段正文，每段中間夾一個可刪的程度副詞；第三段是對白。目標 1000 字。 */
const A = `${filler(520, 1).slice(0, -1)}格外${filler(30, 2)}`;
const B = `${filler(520, 3).slice(0, -1)}狠狠${filler(30, 4)}`;
const C = '“這一句是對白，不許動。”';
const CHAPTER = [A, B, C].join('\n\n');
const strip = (s, w) => s.replace(w, '');
/** 模型交回來的：兩段各刪一個詞。 */
const GOOD = `[1] ${strip(A, '格外')}\n\n[2] ${strip(B, '狠狠')}\n\n[3] ${C}`;

function recorder() {
  const r = { deltas: [], resets: [], error: undefined };
  return {
    r,
    handlers: {
      onDelta: (d) => r.deltas.push(d),
      onReasoning: () => {},
      onDone: () => {},
      onError: (m) => { r.error = m; },
      onCancelled: () => {},
      onProgress: () => {},
      onReset: (full) => r.resets.push(full),
    },
  };
}

async function write(replies) {
  script = [...replies];
  fake.calls.length = 0;
  const rec = recorder();
  const out = await bundle.generate.generate(
    t.project,
    { action: { stage: 'manuscript', capability: 'generate' }, target: { kind: 'manuscript', plotRelPath: P1 }, ask: '' },
    rec.handlers,
    { signal: new AbortController().signal }
  );
  return { ...out, rec: rec.r, calls: fake.calls.length, last: fake.calls.at(-1) };
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    generate: './src/core/generation/generate.ts',
    plotFile: './src/core/model/plotFile.ts',
    db: './src/core/runtime/db.ts',
  });
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
    trimModifiers: true,
  };
  const h = makeFakeHost({ settings, overrides: { reviewReplace: undefined } });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply: (messages, i) => {
      const next = script.shift();
      if (typeof next === 'function') return next(messages, i);
      return next ?? '';
    },
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });
  t = await makeTempProject(bundle.project, { prefix: 'trim', title: '青雲劍錄' });
  const ws = new bundle.ws.Workspace(t.project);
  await ws.writePlot({
    no: 1,
    title: '夜入青雲',
    targetWords: 1000,
    upstreamHash: '',
    done: false,
    // 關鍵事件那一句是記號：寫正文那一次的執行卡裡有它，刪修飾那一次不該有。
    sections: { ...bundle.plotFile.emptyPlotSections(), 梗概: '梗概', 出场人物: '林昭', 关键事件: '林昭夜闖青雲山門' },
  });
  await t.project.syncManifest();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('刪得合格', () => {
  let r;
  before(async () => {
    r = await write([{ text: CHAPTER, stop: 'end' }, { text: GOOD, stop: 'end' }]);
  });

  test('多調 1 次；Draft 是刪後的，帶刪之前那版', () => {
    assert.equal(r.calls, 2);
    assert.equal(r.draft.calls, 2);
    assert.equal(r.draft.raw, [strip(A, '格外'), strip(B, '狠狠'), C].join('\n\n'));
    assert.equal(r.draft.untrimmed, CHAPTER);
  });

  test('開著刪修飾往多寫兩成：目標 1000，給模型的是約 1200 字', () => {
    assert.match(fake.calls[0].at(-1).content, /約 1200 字，不必精確/);
    assert.equal(r.draft.length.target, 1000);
  });

  test('說明裡寫刪了幾段、多少字', () => {
    const note = r.draft.notes.find((n) => n.startsWith('刪修飾：'));
    assert.match(note, /3 段裡刪了 2 段/);
  });

  test('氣泡：帶編號的輸出不流進去，最後退回刪後的正文', () => {
    assert.ok(!r.rec.deltas.join('').includes('[1]'));
    assert.ok(r.rec.deltas.join('').includes('——刪修飾——'));
    assert.equal(r.rec.resets.at(-1), r.draft.raw);
  });

  test('刪修飾那一次只有兩條訊息：規矩與編號的正文', () => {
    assert.equal(r.last.length, 2);
  });

  test('正文按段編號交給它，對白段也在', () => {
    assert.match(r.last[1].content, /\[3\] “這一句是對白，不許動。”/);
  });

  // 對照：記號確實在裝配裡，下一條「不在」才說明得了問題。
  test('寫正文那一次的裝配帶著本章細綱的關鍵事件', () => {
    assert.ok(fake.calls[0].at(-1).content.includes('林昭夜闖青雲山門'));
  });

  test('刪修飾那一次不帶裝配內容：本章細綱的關鍵事件不在', () => {
    assert.ok(!r.last[1].content.includes('林昭夜闖青雲山門'));
  });
});

describe('模型加了字', () => {
  let r;
  before(async () => {
    const bad = `[1] ${A}又加了一些原文沒有的字\n\n[2] ${B}\n\n[3] ${C}`;
    r = await write([{ text: CHAPTER, stop: 'end' }, { text: bad, stop: 'end' }]);
  });

  test('整段退回：Draft 原樣，不帶刪之前那版', () => {
    assert.equal(r.draft.raw, CHAPTER);
    assert.equal(r.draft.untrimmed, undefined);
  });

  test('說明裡寫退回原因', () => {
    assert.ok(r.draft.notes.some((n) => n.includes('刪修飾沒有刪掉什麼') && n.includes('加了原文沒有的字 1 段')), JSON.stringify(r.draft.notes));
  });
});

describe('刪到八成以下', () => {
  let r;
  before(async () => {
    // 第 1 段刪到只剩四成多（合格），第 2 段只刪一個詞：整章掉到八成以下。
    const cut = (s) => `${s.slice(0, Math.round(s.length * 0.42))}。`;
    const deep = `[1] ${cut(A)}\n\n[2] ${strip(B, '狠狠')}\n\n[3] ${C}`;
    r = await write([{ text: CHAPTER, stop: 'end' }, { text: deep, stop: 'end' }]);
  });

  test('退回刪得最多的段，夠八成為止', () => {
    assert.ok(r.draft.length.reached, JSON.stringify(r.draft.length));
    assert.equal(r.draft.raw, [A, strip(B, '狠狠'), C].join('\n\n'));
    assert.ok(r.draft.notes.some((n) => /又退回刪得最多的 1 段/.test(n)), JSON.stringify(r.draft.notes));
  });
});

describe('呼叫失敗', () => {
  let r;
  before(async () => {
    r = await write([
      { text: CHAPTER, stop: 'end' },
      () => {
        throw new bundle.provider.LlmError('假裝 503');
      },
    ]);
  });

  test('正文保持原樣，照樣出 Draft', () => {
    assert.equal(r.rec.error, undefined);
    assert.equal(r.draft.raw, CHAPTER);
    assert.ok(r.draft.notes.some((n) => n.startsWith('刪修飾呼叫失敗')), JSON.stringify(r.draft.notes));
    assert.equal(r.rec.resets.at(-1), CHAPTER);
  });
});
