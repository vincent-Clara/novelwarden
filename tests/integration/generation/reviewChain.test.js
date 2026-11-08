/**
 * 審稿鏈與修稿鏈（五期，generation/review.ts、generation/revision.ts，經 `generate` 跑）。
 *
 * | 情形 | 斷言 |
 * |---|---|
 * | 審稿一次成功 | 1 次呼叫；Draft 帶報告、**沒有 artifact**；氣泡是給人讀的報告，不是 JSON |
 * | 偽造的引文 | 那一條被丟掉，notes 寫明 |
 * | 審稿被截斷 | 整份重來一次，重來那次說明上一次被丟棄 |
 * | 審稿不合格 | 沒按格式寫、自己給的 JSON 不合格：不轉寫，按格式重寫一次；兩次都不行報錯、不出報告 |
 * | 還沒有正文 | 不調模型，報錯 |
 * | 審稿不走續寫鏈 | 審稿 JSON 不會被當成正文續寫、查重演 |
 * | 修稿一次成功 | 發出去的有整章原文與清單；Draft 是正文產物、寫法 revise |
 * | 修稿被截斷 | 接著寫，拼成一份 |
 * | 截斷三輪仍沒寫完 | 報錯，不出 Draft |
 * | 明顯短於原稿 | 報錯，不出 Draft |
 * | 修稿落盤 | 覆蓋前審閱，不記 writtenFrom |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, filler } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let gen;
let h;
let fake;
let t;
let project;
let settings = {};
let script = [];

const P2 = '.novelwarden/summaries/002-客棧.md';
const P3 = '.novelwarden/summaries/003-夜访.md';

const CH2 = [
  '雨下了一整夜。林昭推開客棧的門，簷下的燈籠被風吹得直晃。',
  '沈氏在櫃檯後看著他，沒說話。她把那塊殘令收進了袖中。',
  filler(600, 7),
  '“你明天就走？”她問。林昭點了點頭，說：“天一亮就走。”',
].join('\n\n');

function recorder() {
  const r = { deltas: [], done: undefined, error: undefined };
  return {
    r,
    handlers: {
      onDelta: (d) => r.deltas.push(d),
      onReasoning: () => {},
      onDone: (full) => { r.done = full; },
      onError: (m) => { r.error = m; },
      onCancelled: () => {},
    },
  };
}

async function run(capability, plotRelPath, replies, extra = {}) {
  script = [...replies];
  fake.calls.length = 0;
  const rec = recorder();
  const out = await gen.generate(
    project,
    { action: { stage: 'manuscript', capability }, target: { kind: 'manuscript', plotRelPath }, ask: '', ...extra },
    rec.handlers,
    { signal: new AbortController().signal }
  );
  return { ...out, rec: rec.r, calls: fake.calls.length, users: fake.calls.map((c) => c[c.length - 1].content) };
}

const review = (replies, extra) => run('review', P2, replies, extra);
const revise = (replies, brief = '【已確認納入本次修稿的審稿項】\n1. [角色狀態 / 嚴重] 殘令前文已經交出去了') =>
  run('generate', P2, replies, { writeMode: 'revise', reviseBrief: brief });

function reviewJson({ items, goals } = {}) {
  return JSON.stringify({
    summary: '整體順暢，一處硬傷',
    items: items ?? [
      { category: '劇情合理性', severity: 'error', quote: '她把那塊殘令收進了袖中', description: '殘令前文已經交出去了' },
      { category: '角色狀態', severity: 'warning', quote: '林昭拔劍指著她的喉嚨', description: '編出來的一句' },
      { category: '前後章節串聯', severity: 'pass', description: '接得上' },
    ],
    goalReviews: goals ?? [
      { id: 'g1', status: 'completed', description: '回到客棧', evidence: [{ quote: '林昭推開客棧的門' }] },
      { id: 'g2', status: 'unmet', description: '細綱要他今晚就走，正文裡他說明天走', evidence: [{ quote: '天一亮就走' }] },
      { id: 'g3', status: 'unknown', description: '沒寫到李叔', evidence: [] },
    ],
  });
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    generate: './src/core/generation/generate.ts',
    accept: './src/core/generation/accept.ts',
    revision: './src/core/generation/revision.ts',
    plotFile: './src/core/model/plotFile.ts',
    db: './src/core/runtime/db.ts',
  });
  gen = bundle.generate;
  settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
  h = makeFakeHost({ settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply: (messages, i) => {
      const next = script.shift();
      if (typeof next === 'function') return next(messages, i);
      return next ?? '';
    },
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'review-chain', title: '青雲劍錄' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  const empty = bundle.plotFile.emptyPlotSections();
  // 凍結清單隻取關鍵事件（三條）。「看點」裡寫著章末懸念，但它不進清單：看點裡爽點與懸念混在一起，
  // 不是一件件到期的動作（從前單列的章末鉤子會凍成一項，鉤子並進看點之後就沒有這一項了）。
  await ws.writePlot({
    no: 2, title: '客棧', targetWords: 800, upstreamHash: '', done: false,
    sections: {
      ...empty,
      梗概: '林昭回鎮落腳',
      出场人物: '林昭、沈氏',
      关键事件: '林昭回到客棧；林昭當晚離開青崖鎮；李叔來客棧找林昭',
      看点: '- 門外有人敲了三下',
    },
  });
  await ws.writePlot({
    no: 3, title: '夜訪', targetWords: 800, upstreamHash: '', done: false,
    sections: { ...empty, 梗概: 'x', 关键事件: '夜訪' },
  });
  await ws.createChapter(2, '客棧', CH2);
  await project.syncManifest();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('審稿 · 一次成功', () => {
  let r;
  before(async () => {
    r = await review([{ text: reviewJson(), stop: 'end' }]);
  });

  test('調一次；Draft 帶報告、沒有 artifact', () => {
    assert.equal(r.calls, 1);
    assert.equal(r.draft.calls, 1);
    assert.equal(r.draft.artifact, undefined);
    assert.equal(r.draft.review.chapterNo, 2);
    assert.equal(r.draft.review.chapterRelPath, 'chapters/002-客棧.txt');
  });

  test('偽造的引文那一條被丟掉，notes 寫明', () => {
    assert.deepEqual(r.draft.review.issues.map((i) => i.category), ['劇情合理性']);
    assert.equal(r.draft.review.dropped.length, 1);
    assert.match(r.draft.notes.join('\n'), /丟掉 1 條引文站不住的意見/);
  });

  test('目標：三條關鍵事件按序凍結；未完成有證據留著，待核實照收', () => {
    assert.deepEqual(r.draft.review.goals.map((g) => [g.id, g.status]), [
      ['g1', 'completed'],
      ['g2', 'unmet'],
      ['g3', 'unknown'],
    ]);
  });

  test('清單裡每一項都有判斷：覆蓋完整', () => {
    assert.equal(r.draft.review.coverage, 'complete');
  });

  test('氣泡是給人讀的報告，不是 JSON', () => {
    assert.match(r.rec.done, /^# 第 2 章《客棧》審稿/);
    assert.doesNotMatch(r.rec.done, /"items"/);
    assert.equal(r.draft.raw, r.rec.done);
  });

  test('發出去的那一次是審稿：全文在', () => {
    assert.match(r.users[0], /# 待審正文/);
  });

  test('凍結清單隻有關鍵事件那三條，看點裡的章末懸念不進', () => {
    assert.ok(
      r.users[0].includes('凍結清單：\n- g1：林昭回到客棧\n- g2：林昭當晚離開青崖鎮\n- g3：李叔來客棧找林昭\n'),
      r.users[0].slice(r.users[0].indexOf('凍結清單'), r.users[0].indexOf('凍結清單') + 200)
    );
  });
});

describe('審稿 · 出岔子', () => {
  test('被截斷：整份重來一次，重來那次說清上一次被丟棄', async () => {
    const r = await review([{ text: '{"summary":"寫了一半', stop: 'maxTokens' }, { text: reviewJson(), stop: 'end' }]);
    assert.equal(r.calls, 2);
    assert.equal(r.draft.calls, 2);
    assert.match(r.users[1], /因長度限制而中斷，已被丟棄/);
    assert.match(r.draft.notes.join(), /整份重來一次/);
  });

  // 2026-10-25 起改成轉寫：連「總評」「目標核對」都沒有的不花轉寫那一次，直接按格式重寫。
  test('沒按格式寫：不轉寫，按格式重寫一次', async () => {
    const r = await review(['這一章寫得挺好，沒有問題。', { text: reviewJson(), stop: 'end' }]);
    assert.equal(r.calls, 2);
    assert.match(r.users[1], /未通過格式校驗（沒有按格式寫）/);
    assert.ok(r.draft.review);
  });

  test('模型自己給的 JSON 不合格：不轉寫，按格式重寫一次', async () => {
    const r = await review(['{"summary":"缺了 items"}', { text: reviewJson(), stop: 'end' }]);
    assert.equal(r.calls, 2);
    assert.match(r.users[1], /未通過格式校驗（缺少 items 陣列）/);
    assert.ok(r.draft.review);
  });

  test('截斷又不合格：3 次到頂', async () => {
    const r = await review([{ text: '{', stop: 'maxTokens' }, '不是 JSON', { text: reviewJson(), stop: 'end' }]);
    assert.equal(r.calls, 3);
    assert.ok(r.draft.review);
  });

  test('兩次都不合格：報錯，不出報告', async () => {
    const r = await review(['不是 JSON', '還不是']);
    assert.equal(r.calls, 2);
    assert.equal(r.draft, undefined);
    assert.match(r.rec.error, /兩次都沒有產出合格的審稿報告/);
  });

  test('這一章還沒有正文：不調模型，報錯', async () => {
    const r = await run('review', P3, ['不該被呼叫']);
    assert.equal(r.calls, 0);
    assert.match(r.rec.error, /還沒有正文，沒法審稿/);
  });

  // 審稿也在正文層：按舊判據它會被當成正文去續寫（輸出很短、又沒到八成）。
  test('審稿不走續寫鏈：短短一段 JSON 不會被續寫', async () => {
    const r = await review([{ text: reviewJson({ items: [{ category: 'x', severity: 'pass', description: 'ok' }], goals: [] }), stop: 'end' }]);
    assert.equal(r.calls, 1);
    assert.equal(r.draft.length, undefined);
  });
});

describe('修稿', () => {
  const REVISED = CH2.replace('她把那塊殘令收進了袖中。', '她看了一眼他空著的手，什麼也沒問。');

  test('一次成功：整章原文與清單都發出去了；Draft 是正文、寫法 revise', async () => {
    const r = await revise([{ text: REVISED, stop: 'end' }]);
    assert.equal(r.calls, 1);
    assert.ok(r.users[0].includes('她把那塊殘令收進了袖中。'), '原文在');
    assert.match(r.users[0], /【已確認納入本次修稿的審稿項】/);
    assert.match(r.users[0], /【修復原則】/);
    assert.equal(r.draft.writeMode, 'revise');
    assert.equal(r.draft.artifact.kind, 'manuscript');
    assert.equal(r.draft.raw.trim(), REVISED.trim());
    assert.equal(r.draft.length, undefined);
    assert.match(r.draft.notes.join(), /修訂稿 \d+ 字（原稿 \d+ 字）/);
  });

  test('被截斷：接著寫，拼成一份；續寫那一次帶已修訂的末尾', async () => {
    const half = REVISED.slice(0, Math.floor(REVISED.length / 2));
    const rest = REVISED.slice(half.length);
    const r = await revise([{ text: half, stop: 'maxTokens' }, { text: rest, stop: 'end' }]);
    assert.equal(r.calls, 2);
    assert.match(r.users[1], /# 已修訂正文（末尾，從這裡接著輸出）/);
    assert.match(r.users[1], /上一輪修稿輸出因長度限制而中斷/);
    assert.equal(r.draft.calls, 2);
    assert.ok(r.draft.raw.replace(/\s+/g, '').length >= REVISED.replace(/\s+/g, '').length - 2);
  });

  test('截斷三輪仍沒寫完：報錯，不出 Draft', async () => {
    const r = await revise([
      { text: filler(300, 21), stop: 'maxTokens' },
      { text: filler(300, 22), stop: 'maxTokens' },
      { text: filler(300, 23), stop: 'maxTokens' },
      { text: filler(300, 24), stop: 'maxTokens' },
    ]);
    assert.equal(r.calls, 4);
    assert.equal(r.draft, undefined);
    assert.match(r.rec.error, /續寫 3 輪仍沒寫完/);
  });

  test('明顯短於原稿：報錯，不出 Draft', async () => {
    const r = await revise([{ text: '她看了一眼他空著的手，什麼也沒問。', stop: 'end' }]);
    assert.equal(r.draft, undefined);
    assert.match(r.rec.error, /修訂稿明顯短於原稿/);
  });

  test('這一章沒有正文：不調模型，報錯', async () => {
    script = ['不該被呼叫'];
    fake.calls.length = 0;
    const rec = recorder();
    await gen.generate(
      project,
      { action: { stage: 'manuscript', capability: 'generate' }, target: { kind: 'manuscript', plotRelPath: P3 }, ask: '', writeMode: 'revise', reviseBrief: 'x' },
      rec.handlers,
      { signal: new AbortController().signal }
    );
    assert.equal(fake.calls.length, 0);
    assert.match(rec.r.error, /已經沒有正文了，沒法修稿/);
  });

  test('落盤：覆蓋前審閱，不記 writtenFrom', async () => {
    const r = await revise([{ text: REVISED, stop: 'end' }]);
    const before = (await project.getPlot(2)).writtenFrom;
    h.reviewed.length = 0;
    h.setReviewVerdict('apply');
    const res = await bundle.accept.acceptArtifact(project, r.draft.target, r.draft.artifact, { writeMode: 'revise' });
    assert.equal(res.relPath, 'chapters/002-客棧.txt');
    assert.equal(h.reviewed.length, 1);
    const text = await project.readChapterText(await project.getChapter(2));
    assert.ok(text.includes('她看了一眼他空著的手'));
    assert.equal((await project.getPlot(2)).writtenFrom, before);
  });
});

describe('修稿 · 完整性校驗（純函式）', () => {
  test('下限 = min(原稿, max(200, 0.6 × min(原稿, 每章字數)))', () => {
    const { revisionShortfall, countProseUnits } = bundle.revision;
    const src = filler(1000, 30);
    assert.equal(countProseUnits(src), 1000);
    assert.equal(revisionShortfall(src, filler(600, 31), 3000), undefined);
    assert.match(revisionShortfall(src, filler(599, 32), 3000), /599 \/ 1000 字，至少要 600 字/);
    // 每章字數更小時按它封頂：0.6 × 500 = 300。
    assert.equal(revisionShortfall(src, filler(300, 33), 500), undefined);
    // 下限不低於 200，除非原稿本身更短。
    assert.match(revisionShortfall(src, filler(199, 34), 100), /至少要 200 字/);
    assert.equal(revisionShortfall(filler(150, 35), filler(150, 36), 3000), undefined);
  });

  test('英文按詞、標點空白不算', () => {
    assert.equal(bundle.revision.countProseUnits('他說：“Hello world!”  好。'), 5);
  });
});
