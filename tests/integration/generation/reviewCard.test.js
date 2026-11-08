/**
 * 審稿報告、按勾選修稿、一致性預檢、合併結果與定位引文（五期的 controller 一半）。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 審稿那一輪沒有落盤卡片；報告在這一輪上、在草稿表裡、在會話檔案裡 | D22：報告不落盤，隨會話儲存 |
 * | 章節條「審稿」發一輪審稿；沒有正文不發 | W6 的第五顆按鈕 |
 * | 修稿只把勾選的交給模型；使用者氣泡帶清單 | 作者沒勾的不該出現在模型眼前 |
 * | 正文改過之後，引文已經不在的勾選項作廢並寫進卡片說明 | 第 2 條 |
 * | 修稿當場問寫不寫，寫入前審閱；合併檢視交回的那一份落盤 | 第 19 條、第 3 條、W11 |
 * | 預檢：細綱排了死人，先亮一張卡；「先不寫」不調模型；「僅本次忽略」照寫 | 零呼叫、不擋路但不靜默 |
 * | 接著寫不預檢 | 開頭已經寫下了 |
 * | 定位引文：宿主有 revealText 就交給它，沒有就開啟檔案並提示那一句 | 能力探測，不判斷殼 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, filler } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let t;
let fake;
let project;
let controller;
let posted = [];
let gates = [];
let gateAnswer = 'proceed';
let script = [];

const P2 = '.novelwarden/summaries/002-客棧.md';
const P3 = '.novelwarden/summaries/003-夜访.md';
const P4 = '.novelwarden/summaries/004-井.md';

const CH2 = [
  '雨下了一整夜。林昭推開客棧的門，簷下的燈籠被風吹得直晃。',
  '沈氏在櫃檯後看著他，沒說話。她把那塊殘令收進了袖中。',
  filler(700, 7),
  '“你明天就走？”她問。林昭點了點頭，說：“天一亮就走。”',
].join('\n\n');

const REVIEW_JSON = JSON.stringify({
  summary: '一處硬傷',
  items: [
    { category: '劇情合理性', severity: 'error', quote: '她把那塊殘令收進了袖中', description: '殘令前文已經交出去了' },
    { category: '角色狀態', severity: 'warning', quote: '林昭點了點頭', description: '左臂有傷卻動作如常' },
    { category: '角色狀態', severity: 'warning', quote: '林昭拔劍指著她', description: '編的' },
  ],
  goalReviews: [
    { id: 'g1', status: 'completed', description: 'x', evidence: [{ quote: '林昭推開客棧的門' }] },
    { id: 'g2', status: 'unknown', description: '沒寫到', evidence: [] },
  ],
});

function attach() {
  controller.attach({
    kind: 'sidebar',
    post: (m) => {
      posted.push(m);
      if (m.type === 'gate') {
        gates.push(m);
        const verdict = typeof gateAnswer === 'function' ? gateAnswer(m) : gateAnswer;
        void controller.handle({ type: 'gateResult', requestId: m.requestId, verdict });
      }
    },
    reveal() {},
  });
}

function reset(replies = []) {
  script = [...replies];
  posted = [];
  gates = [];
  fake.calls.length = 0;
}

const toastsPosted = () => posted.filter((m) => m.type === 'toast').map((m) => m.message);
const turnsOf = () => posted.filter((m) => m.type === 'turnDone').map((m) => m.turn);
const lastAssistant = () => [...turnsOf()].reverse().find((x) => x.role === 'assistant');
const lastUserTurn = () => [...turnsOf()].reverse().find((x) => x.role === 'user');
const userPrompts = () => fake.calls.map((c) => c[c.length - 1].content);

async function reviewChapter2() {
  reset([{ text: REVIEW_JSON, stop: 'end' }]);
  await controller.handle({ type: 'chapterAction', plotRelPath: P2, action: 'review' });
  return lastAssistant();
}

/** 寫一份還沒定稿的細綱：計劃出場寫在「出場人物」一節裡，預檢照它查誰已經死了。 */
async function writePlot(ws, no, title, characters, extra = {}) {
  const empty = bundle.plotFile.emptyPlotSections();
  await ws.writePlot({
    no, title, targetWords: 800, upstreamHash: '', done: false,
    sections: {
      ...empty,
      梗概: `第 ${no} 章的梗概`,
      出场人物: characters.join('、'),
      关键事件: extra.events ?? `第 ${no} 章的關鍵事件`,
      看点: `- 第 ${no} 章的看點`,
    },
  });
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
    session: './src/core/model/session.ts',
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
    reply: () => script.shift() ?? '',
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'review-card', title: '青雲劍錄' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  await writePlot(ws, 1, '夜入青雲', ['林昭']);
  await writePlot(ws, 2, '客棧', ['林昭', '沈氏'], { events: '林昭回到客棧；林昭當晚離開青崖鎮' });
  await writePlot(ws, 3, '夜訪', ['林昭', '阿秋']);
  await writePlot(ws, 4, '井', ['林昭']);
  await ws.createChapter(1, '夜入青雲', filler(900, 1));
  await ws.createChapter(2, '客棧', CH2);
  await project.syncManifest();
  // 沈秋（別名阿秋）在角色卡上已經死了，第 3 章的細綱還排著他。
  const dir = path.join(t.dir, '.novelwarden/characters');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '沈秋.md'),
    ['---', 'name: 沈秋', 'aliases: [阿秋]', 'stateThrough: 2', '---', '', '# 沈秋', '', '## 當前狀態', '', '已死亡（第 2 章被刺殺）', ''].join('\n')
  );
  project.invalidate();

  controller = new bundle.controller.ChatController(project);
  attach();
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('審稿：章節條「審稿」發一輪', () => {
  let a;
  before(async () => {
    a = await reviewChapter2();
  });

  test('一次呼叫，沒有落盤卡片', () => {
    assert.equal(fake.calls.length, 1);
    assert.equal(gates.length, 0);
    assert.equal(a.artifact, undefined);
  });

  test('使用者氣泡是 /審稿', () => {
    assert.equal(lastUserTurn().command, '審稿');
  });

  test('報告在這一輪上：偽造引文的那條丟了，預設勾選是兩條問題', () => {
    assert.ok(a.review);
    assert.deepEqual(a.review.report.issues.map((i) => i.id), ['i1', 'i2']);
    assert.deepEqual(a.review.picks, ['i1', 'i2']);
    assert.match(a.review.notes.join(), /丟掉 1 條/);
    assert.equal(a.review.calls, 1);
  });

  test('氣泡正文是給人讀的報告', () => {
    assert.match(a.content, /^# 第 2 章《客棧》審稿/);
  });

  test('會話檔案裡存著報告，草稿表裡也有一份', async () => {
    const file = path.join(project.sessionsDir, `${controller.current.id}.json`);
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    const turn = json.turns.find((x) => x.id === a.id);
    assert.equal(turn.review.report.chapterNo, 2);
    assert.ok(json.drafts.some((d) => d.review && d.review.chapterNo === 2));
  });

  test('這一章沒有正文：不發', async () => {
    reset(['不該被呼叫']);
    await controller.handle({ type: 'chapterAction', plotRelPath: P3, action: 'review' });
    assert.equal(fake.calls.length, 0);
    assert.ok(toastsPosted().some((x) => /還沒有正文，沒法審稿/.test(x)), JSON.stringify(toastsPosted()));
  });
});

describe('按勾選修稿', () => {
  let reviewTurn;
  const REVISED = CH2.replace('她把那塊殘令收進了袖中。', '她看了一眼他空著的手，什麼也沒問。');

  before(async () => {
    reviewTurn = await reviewChapter2();
  });

  test('只把勾選的交給模型；使用者氣泡帶清單；當場問寫不寫，寫入前審閱', async () => {
    reset([{ text: REVISED, stop: 'end' }]);
    h.reviewed.length = 0;
    h.setReviewVerdict('apply');
    await controller.handle({ type: 'reviseChapter', turnId: reviewTurn.id, picks: ['i1', 'g1', 'nope'] });
    assert.equal(fake.calls.length, 1);
    const prompt = userPrompts()[0];
    assert.match(prompt, /殘令前文已經交出去了/);
    assert.doesNotMatch(prompt, /左臂有傷/);
    const user = lastUserTurn();
    assert.equal(user.command, '按審稿修稿');
    assert.deepEqual(user.revise.items, ['[嚴重] 劇情合理性：殘令前文已經交出去了']);
    assert.equal(gates.length, 1);
    assert.match(gates[0].detail, /按 1 條勾選的審稿意見修稿/);
    assert.equal(h.reviewed.length, 1);
    assert.equal(h.reviewed[0].merge, true);
    const text = await project.readChapterText(await project.getChapter(2));
    assert.ok(text.includes('她看了一眼他空著的手'));
  });

  test('正文在審稿之後改過：引文已經不在的那條作廢並寫進卡片說明', async () => {
    // 上一個用例已經把那一句改掉了；再按同一份報告勾 i1 + i2。
    reset([{ text: CH2.replace('林昭點了點頭', '林昭用右手託著左臂，點了點頭'), stop: 'end' }]);
    h.setReviewVerdict('discard');
    await controller.handle({ type: 'reviseChapter', turnId: reviewTurn.id, picks: ['i1', 'i2'] });
    assert.equal(fake.calls.length, 1);
    assert.doesNotMatch(userPrompts()[0], /殘令前文已經交出去了/);
    assert.match(userPrompts()[0], /左臂有傷卻動作如常/);
    assert.match(gates[0].detail, /正文在審稿之後改過/);
    assert.match(gates[0].detail, /1 條的引文已經不在正文裡了/);
  });

  test('勾選的都作廢了：不調模型', async () => {
    reset(['不該被呼叫']);
    await controller.handle({ type: 'reviseChapter', turnId: reviewTurn.id, picks: ['i1'] });
    assert.equal(fake.calls.length, 0);
    assert.match(lastAssistant().error, /都找不到了/);
  });

  test('合併檢視交回的那一份落盤', async () => {
    const fresh = await reviewChapter2();
    const now = await project.readChapterText(await project.getChapter(2));
    reset([{ text: now.replace('林昭推開客棧的門', '林昭推開客棧那扇舊門'), stop: 'end' }]);
    h.setReviewVerdict(({ proposed }) => ({ merged: `${proposed.trim()}\n\n作者在合併檢視裡加的一句。\n` }));
    // 這一章已經改過：第一條的引文不在了，重新審出來的報告裡只剩「左臂有傷」那一條（i1）。
    assert.deepEqual(fresh.review.report.issues.map((i) => i.description), ['左臂有傷卻動作如常']);
    await controller.handle({ type: 'reviseChapter', turnId: fresh.id, picks: ['i1'] });
    assert.equal(fake.calls.length, 1);
    const after = await project.readChapterText(await project.getChapter(2));
    assert.ok(after.includes('作者在合併檢視裡加的一句。'));
    h.setReviewVerdict('apply');
  });

  test('認不出的報告：不發', async () => {
    reset(['不該被呼叫']);
    await controller.handle({ type: 'reviseChapter', turnId: 'no-such-turn', picks: ['i1'] });
    assert.equal(fake.calls.length, 0);
    assert.ok(toastsPosted().some((x) => /找不到這份審稿報告/.test(x)));
  });
});

describe('一致性預檢', () => {
  test('細綱排了角色卡上已經死了的人：先亮一張卡，「先不寫」一次模型都不調', async () => {
    reset(['不該被呼叫']);
    gateAnswer = 'skip';
    await controller.handle({ type: 'chapterAction', plotRelPath: P3, action: 'write' });
    gateAnswer = 'proceed';
    assert.equal(fake.calls.length, 0);
    assert.equal(gates.length, 1);
    assert.equal(gates[0].name, 'preflight');
    assert.equal(gates[0].proceed, '僅本次忽略，照寫');
    assert.equal(gates[0].skip, '先不寫');
    assert.match(gates[0].danger, /沈秋的當前狀態（截至第 2 章）寫著「已死亡」/);
    assert.match(lastAssistant().content, /一致性預檢發現 1 處問題，這一次先不寫——沒有呼叫模型/);
  });

  test('「僅本次忽略」照寫', async () => {
    reset([{ text: filler(700, 40), stop: 'end' }]);
    await controller.handle({ type: 'chapterAction', plotRelPath: P3, action: 'write' });
    assert.equal(fake.calls.length, 1);
    assert.equal(gates[0].name, 'preflight');
    assert.equal(gates[1].name, 'artifact');
  });

  test('接著寫不預檢', async () => {
    reset([{ text: filler(300, 41), stop: 'end' }]);
    await controller.handle({ type: 'chapterAction', plotRelPath: P3, action: 'continue' });
    assert.ok(gates.every((g) => g.name !== 'preflight'));
  });

  test('沒排死人的章不亮卡', async () => {
    reset([{ text: filler(700, 42), stop: 'end' }]);
    await controller.handle({ type: 'chapterAction', plotRelPath: P4, action: 'write' });
    assert.ok(gates.every((g) => g.name !== 'preflight'));
  });
});

describe('定位引文', () => {
  test('宿主有 revealText：交給它', async () => {
    const seen = [];
    h.host.revealText = async (rel, quote) => {
      seen.push([rel, quote]);
      return true;
    };
    await controller.handle({ type: 'revealQuote', relPath: 'chapters/002-客棧.md', quote: '林昭推開' });
    assert.deepEqual(seen, [['chapters/002-客棧.md', '林昭推開']]);
    delete h.host.revealText;
  });

  test('找不到那一句：提示正文可能改過', async () => {
    h.host.revealText = async () => false;
    reset();
    await controller.handle({ type: 'revealQuote', relPath: 'chapters/002-客棧.md', quote: '根本沒有' });
    assert.ok(toastsPosted().some((x) => /找不到了（正文可能改過）/.test(x)));
    delete h.host.revealText;
  });

  test('宿主沒有 revealText：開啟檔案並提示那一句', async () => {
    h.opened.length = 0;
    reset();
    await controller.handle({ type: 'revealQuote', relPath: 'chapters/002-客棧.md', quote: '林昭推開客棧' });
    assert.deepEqual(h.opened, ['chapters/002-客棧.md'], JSON.stringify({ opened: h.opened, rt: typeof h.host.revealText }));
    assert.ok(toastsPosted().some((x) => /在編輯器裡找這一句：「林昭推開客棧」/.test(x)));
  });
});
