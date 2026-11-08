/**
 * 審稿改成轉寫（2026-10-25）：審稿模型按「總評」「問題」「目標核對」三個小標題寫自然語言，引文用「」括出來；轉寫模型
 * （「轉寫」那一檔，不跟對話頁選的模型）照抄成原來那份 JSON，之後照舊拿正文核引文、逐項核對目標（generation/review.ts）。
 *
 * | 用例組 | 釘的是什麼 |
 * |---|---|
 * | 照抄收下 | 審 1 次、轉寫 1 次；審的是對話頁那個模型，轉寫的是轉寫那一檔；轉寫只帶合同與審稿原文；氣泡是給人讀的報告 |
 * | 轉寫改了引文 | 不收，重轉一次，說清哪一處不是原文裡的字 |
 * | 轉寫兩次都不合格 | 照原來解析失敗的走法：丟棄、按格式重寫一次，照樣轉寫；告訴審稿模型的只是「整理不出來」 |
 * | 轉寫呼叫失敗 | 不重寫，報錯、不出報告；寫好的原文留在氣泡裡 |
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
let project;
/** 按模型引用注入異常（fakeProvider 的 behavior）：建 provider 時現讀。 */
const behavior = {};

const P2 = '.novelwarden/summaries/002-客棧.md';
const TRANSCRIBER = '格式轉寫員';

const CH2 = [
  '雨下了一整夜。林昭推開客棧的門，簷下的燈籠被風吹得直晃。',
  '沈氏在櫃檯後看著他，沒說話。她把那塊殘令收進了袖中。',
  filler(600, 7),
  '“你明天就走？”她問。林昭點了點頭，說：“天一亮就走。”',
].join('\n\n');

/** 審稿模型按格式寫出來的報告：一條偽造的引文、一項待核實沒給證據。 */
const PROSE = [
  '### 總評',
  '整體順暢，一處硬傷。',
  '### 問題',
  '- 劇情合理性（嚴重）：殘令前文已經交出去了。原文：「她把那塊殘令收進了袖中」',
  '- 角色狀態（建議）：編出來的一句。原文：「林昭拔劍指著她的喉嚨」',
  '- 前後章節串聯（通過）：接得上',
  '### 目標核對',
  '- g1（已完成）：回到客棧。證據：「林昭推開客棧的門」',
  '- g2（未完成）：細綱要他今晚就走，正文裡他說明天走。證據：「天一亮就走」',
  '- g3（待核實）：沒寫到李叔。證據：無',
].join('\n');

/** 轉寫模型照抄出來的那一份（`over` 換掉其中幾樣）。 */
const copied = (over = {}) =>
  JSON.stringify({
    summary: '整體順暢，一處硬傷。',
    items: [
      { category: '劇情合理性', severity: 'error', quote: '她把那塊殘令收進了袖中', description: '殘令前文已經交出去了。' },
      { category: '角色狀態', severity: 'warning', quote: '林昭拔劍指著她的喉嚨', description: '編出來的一句。' },
      { category: '前後章節串聯', severity: 'pass', quote: '', description: '接得上' },
    ],
    goalReviews: [
      { id: 'g1', status: 'completed', description: '回到客棧。', evidence: ['林昭推開客棧的門'] },
      { id: 'g2', status: 'unmet', description: '細綱要他今晚就走，正文裡他說明天走。', evidence: ['天一亮就走'] },
      { id: 'g3', status: 'unknown', description: '沒寫到李叔。', evidence: ['無'] },
    ],
    ...over,
  });

const systemOf = (i) => fake.calls[i][0].content;
const userOf = (i) => fake.calls[i][fake.calls[i].length - 1].content;
const refOf = (i) => fake.calls[i].ref;

async function review(replies) {
  fake.reset(replies);
  const r = { deltas: [], done: undefined, error: undefined };
  const out = await bundle.generate.generate(
    project,
    { action: { stage: 'manuscript', capability: 'review' }, target: { kind: 'manuscript', plotRelPath: P2 }, ask: '' },
    {
      onDelta: (d) => r.deltas.push(d),
      onReasoning: () => {},
      onDone: (full) => {
        r.done = full;
      },
      onError: (m) => {
        r.error = m;
      },
      onCancelled: () => {},
    },
    { signal: new AbortController().signal }
  );
  return { ...out, rec: r };
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
  // 對話頁選的是 big；轉寫那一檔（預設快速檔）配的是 small。
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'big', contextWindow: 100000 }, { name: 'small', contextWindow: 32000 }] }],
    models: ['p/big'],
    tierModels: { fast: ['p/small'] },
    concurrency: 1,
  };
  const h = makeFakeHost({ supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    behavior,
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });
  t = await makeTempProject(bundle.project, { prefix: 'review-transcribe', title: '青雲劍錄' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  await ws.writePlot({
    no: 2,
    title: '客棧',
    targetWords: 800,
    upstreamHash: '',
    done: false,
    sections: {
      ...bundle.plotFile.emptyPlotSections(),
      梗概: '林昭回鎮落腳',
      出场人物: '林昭、沈氏',
      关键事件: '林昭回到客棧；林昭當晚離開青崖鎮；李叔來客棧找林昭',
      看点: '- 門外有人敲了三下',
    },
  });
  await ws.createChapter(2, '客棧', CH2);
  await project.syncManifest();
});

after(() => {
  if (t) cleanup(t.dir, bundle?.db);
});

describe('審稿 · 按格式寫，轉寫模型照抄成 JSON', () => {
  let r;
  before(async () => {
    r = await review([
      { text: PROSE, stop: 'end' },
      { text: copied(), stop: 'end' },
    ]);
  });

  test('審 1 次、轉寫 1 次；審的是對話頁那個模型，轉寫的是轉寫那一檔', () => {
    assert.equal(fake.callCount(), 2);
    assert.equal(r.draft.calls, 2);
    assert.equal(refOf(0), 'p/big');
    assert.equal(refOf(1), 'p/small');
  });

  test('審稿的提示詞不要 JSON：按三個小標題寫，凍結清單一項一行', () => {
    assert.ok(userOf(0).includes('按「### 總評」「### 問題」「### 目標核對」三個小標題寫審稿報告，不寫 JSON'), userOf(0).slice(-2500));
    assert.ok(userOf(0).includes('凍結清單：\n- g1：林昭回到客棧\n'), userOf(0).slice(-2500));
  });

  // 轉寫只看原文：給多了它會順手補內容。
  test('轉寫只帶合同與審稿原文，不帶待審正文與書的上下文', () => {
    assert.ok(systemOf(1).includes(TRANSCRIBER), systemOf(1));
    assert.ok(userOf(1).includes('【審稿報告 JSON 合同】') && userOf(1).includes(`【原文】\n${PROSE}`), userOf(1).slice(0, 800));
    assert.ok(!userOf(1).includes('# 待審正文'), userOf(1).slice(0, 800));
  });

  test('照舊拿正文核引文：偽造的那一條丟掉；目標照轉寫的結論，「無」換成沒有證據', () => {
    const report = r.draft.review;
    assert.deepEqual(report.issues.map((i) => [i.category, i.severity, i.quote]), [['劇情合理性', 'error', '她把那塊殘令收進了袖中']]);
    assert.deepEqual(report.passes.map((p) => p.category), ['前後章節串聯']);
    assert.equal(report.dropped.length, 1);
    assert.deepEqual(report.goals.map((g) => [g.id, g.status, g.quotes]), [
      ['g1', 'completed', ['林昭推開客棧的門']],
      ['g2', 'unmet', ['天一亮就走']],
      ['g3', 'unknown', []],
    ]);
    assert.equal(report.coverage, 'complete');
  });

  test('氣泡裡轉寫只加一行，最後換成給人讀的報告', () => {
    assert.ok(r.rec.deltas.some((d) => d.includes('——審稿轉寫成 JSON（')), r.rec.deltas.join('').slice(-300));
    assert.match(r.rec.done, /^# 第 2 章《客棧》審稿/);
    assert.doesNotMatch(r.rec.done, /"items"/);
  });
});

describe('審稿 · 轉寫改了引文', () => {
  test('不收，重轉一次，說清哪一處不是原文裡的字', async () => {
    const reworded = copied({
      items: [{ category: '劇情合理性', severity: 'error', quote: '她把那塊殘令藏進了袖中', description: '殘令前文已經交出去了。' }],
    });
    const r = await review([
      { text: PROSE, stop: 'end' },
      { text: reworded, stop: 'end' },
      { text: copied(), stop: 'end' },
    ]);
    assert.equal(fake.callCount(), 3);
    assert.ok(systemOf(2).includes(TRANSCRIBER));
    assert.ok(userOf(2).includes('【上次轉寫不合格】這幾處不是原文裡的字：「她把那塊殘令藏進了袖中」'), userOf(2).slice(0, 800));
    assert.equal(r.draft.calls, 3);
    assert.match(r.draft.notes.join('\n'), /審稿轉寫不合格（這幾處不是原文裡的字：「她把那塊殘令藏進了袖中」），重轉一次/);
    assert.deepEqual(r.draft.review.issues.map((i) => i.quote), ['她把那塊殘令收進了袖中']);
  });
});

describe('審稿 · 轉寫兩次都不合格', () => {
  test('丟棄、按格式重寫一次（審稿模型），照樣轉寫；重寫那一次只說整理不出來', async () => {
    const bad = copied({ summary: '整體還算順暢' });
    const r = await review([
      { text: PROSE, stop: 'end' },
      { text: bad, stop: 'end' },
      { text: bad, stop: 'end' },
      { text: PROSE, stop: 'end' },
      { text: copied(), stop: 'end' },
    ]);
    assert.equal(fake.callCount(), 5);
    assert.deepEqual([0, 1, 2, 3, 4].map(refOf), ['p/big', 'p/small', 'p/small', 'p/big', 'p/small']);
    assert.ok(userOf(3).includes('上一輪審稿輸出未通過格式校驗（整理不出一份報告），已被丟棄'), userOf(3).slice(0, 400));
    assert.doesNotMatch(userOf(3), /不是原文裡的字/);
    assert.equal(r.draft.calls, 5);
    assert.match(r.draft.notes.join('\n'), /審稿轉寫沒成（這幾處不是原文裡的字：「整體還算順暢」），已丟棄並重寫一次/);
    assert.ok(r.draft.review);
  });
});

describe('審稿 · 轉寫呼叫失敗', () => {
  before(() => {
    behavior['p/small'] = 'fail';
  });
  after(() => {
    delete behavior['p/small'];
  });

  test('不重寫：報錯、不出報告，寫好的原文留在氣泡裡', async () => {
    const r = await review([{ text: PROSE, stop: 'end' }]);
    assert.equal(r.draft, undefined);
    assert.match(r.rec.error, /審稿寫好了，但轉寫呼叫失敗/);
    assert.ok(r.rec.done.includes('她把那塊殘令收進了袖中'), r.rec.done.slice(0, 300));
    assert.ok(!fake.calls.slice(1).some((c) => c.ref === 'p/big'), '沒有重寫');
  });
});
