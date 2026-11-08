/**
 * 寫前檢查的敘事線提醒（敘事線二期，設計稿「四、寫前檢查」）：伏筆逾期、線斷了。零呼叫、**不攔人**——照「設定還只有一句話」
 * （`thinLoreFor`）那套做，不進 `risks`，顯示在四處：對話頁（預檢卡片的說明、寫章卡片的說明）、批次寫章的確認框、章節工作臺
 * （前端批次彈窗在 tests/dom/view/forms.test.js）。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 寫第 N 章按第 N − 1 章算：過了計劃回收章沒收、本章計劃裡也沒收的伏筆提；進行中的線斷了 K 章（主線 5、其餘 15）、本章計劃裡也沒推進的提 | 設計稿 ⚑9 |
 * | 本章計劃裡安排了收、推進的不提；收了的伏筆、沒開始的線不提 | 提醒的是「沒安排」 |
 * | 敘事線只記到定稿的那一章，中間沒定稿的章注一句「提醒可能不準」 | 實際事件都是定稿寫進來的 |
 * | 不進 risks：細綱排了死人照樣亮卡，提醒寫在卡片說明裡；沒有風險不亮卡，提醒進寫章卡片的說明 | 不攔人 |
 * | 工作臺正文目標上一句（還沒寫的章才提）；批次寫章確認框多一行（區間裡安排過的都算） | 四處顯示 |
 * | 一次模型都不調 | 第 4 條：寫前檢查零呼叫 |
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
let fake;
let project;
let controller;
let gates = [];
let gateAnswer = 'proceed';
let script = [];

const pad3 = (n) => String(n).padStart(3, '0');
const PLOT = (no) => `.novelwarden/summaries/${pad3(no)}-第${no}章.md`;
const CH = (no) => `chapters/${pad3(no)}-第${no}章.md`;
const DIR = '.novelwarden/threads';

/** 一份細綱：`sourceHash` 給了就是定稿過的。 */
function plotText(no, { cast = '林昭', sourceHash } = {}) {
  return [
    '---',
    `no: ${no}`,
    `title: 第${no}章`,
    'targetWords: 800',
    ...(sourceHash ? [`sourceHash: ${sourceHash}`] : []),
    '---',
    '',
    `# 第${no}章 第${no}章`,
    '',
    '## 梗概',
    '',
    `第 ${no} 章的梗概`,
    '',
    '## 出場人物',
    '',
    cast,
    '',
    '## 關鍵事件',
    '',
    `- 第 ${no} 章的事`,
    '',
  ].join('\n');
}

const MAIN = [
  '---',
  'kind: 主線',
  'plan: 1-40',
  '---',
  '',
  '## 意圖',
  '查清那場火。',
  '',
  '## 進展',
  '- 第 1 章 · 推進：起火 〔證據：「火光」〕',
  '',
].join('\n');
const PAIR = [
  '---',
  'kind: 感情線',
  'plan: 2-30',
  '---',
  '',
  '## 伏筆',
  '- 玉佩的來歷：沈家舊物（計劃第 2 章埋、第 5 章前收）',
  '- 舊傷（第 6 章前收）',
  '',
  '## 進展',
  '- 第 2 章 · 推進：初遇 〔證據：「初遇」〕',
  '- 第 2 章 · 埋〈玉佩的來歷〉：玉佩露面 〔證據：「玉佩」〕',
  '- 第 7 章 · 計劃 · 推進：擋刀',
  '- 第 7 章 · 計劃 · 收〈舊傷〉：舊傷復發',
  '',
].join('\n');
const UNFILED = '# 未歸屬的伏筆\n\n## 伏筆\n- 提燈人（第 3 章前收）\n\n## 進展\n- 第 2 章 · 埋〈提燈人〉：x 〔證據：「x」〕\n- 第 3 章 · 收〈提燈人〉：y 〔證據：「y」〕\n';

function attach() {
  controller.attach({
    kind: 'sidebar',
    post: (m) => {
      if (m.type === 'gate') {
        gates.push(m);
        const verdict = typeof gateAnswer === 'function' ? gateAnswer(m) : gateAnswer;
        void controller.handle({ type: 'gateResult', requestId: m.requestId, verdict });
      }
    },
    reveal() {},
  });
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    controller: './src/core/controller/index.ts',
    preflight: './src/core/features/preflight.ts',
    batch: './src/core/features/pipelineBatch.ts',
    workbench: './src/core/views/workbench.ts',
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
  t = await makeTempProject(bundle.project, { prefix: 'threadReminders', title: '寫前提醒' });
  project = t.project;
  // 第 1–5 章有正文，第 1–4 章定稿過（第 5 章寫了沒定稿）；第 6–8 章只排了細綱，第 7 章排了已經死了的沈秋。
  for (let no = 1; no <= 5; no++) {
    t.write(CH(no), `# 第${no}章\n\n第${no}章的正文。${filler(200, no)}\n`);
  }
  project.invalidate();
  const chapters = await project.listChapters();
  for (let no = 1; no <= 8; no++) {
    const hash = no <= 4 ? chapters.find((c) => c.order === no).contentHash : undefined;
    t.write(PLOT(no), plotText(no, { sourceHash: hash, ...(no === 7 ? { cast: '林昭、沈秋' } : {}) }));
  }
  t.write(
    '.novelwarden/characters/沈秋.md',
    ['---', 'name: 沈秋', 'stateThrough: 4', '---', '', '# 沈秋', '', '## 當前狀態', '', '已死亡（第 4 章被刺殺）', ''].join('\n')
  );
  t.write(`${DIR}/青崖舊案.md`, MAIN);
  t.write(`${DIR}/林昭與沈青.md`, PAIR);
  t.write(`${DIR}/未归属的伏笔.md`, UNFILED);
  // 第 1–4 章定稿時敘事線判過了：水位記在 project.json（四期）。「還沒記上」的那幾章按它注。
  await project.writeManifest({ ...(await project.readManifest()), threadsThrough: 4 });
  project.invalidate();
  controller = new bundle.controller.ChatController(project);
  attach();
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('預檢：敘事線的兩類提醒（不進 risks）', () => {
  test('第 8 章：玉佩、舊傷過了回收章沒收（舊傷第 7 章的計劃不算本章），主線斷了 6 章；敘事線記到第 4 章', async () => {
    const r = await bundle.preflight.preflightChapter(project, 8);
    assert.deepEqual(r.risks, []);
    assert.deepEqual(r.threads, [
      { kind: 'overdue', name: '玉佩的來歷', resolve: 5, at: 8 },
      // 舊傷那一行寫第 6 章前收，計劃排到了第 7 章：按晚的算（2026-10-24 推遲算數），第 8 章照樣過了。
      { kind: 'overdue', name: '舊傷', resolve: 7, at: 8 },
      { kind: 'stalled', name: '青崖舊案', lineKind: '主线', gap: 6, at: 8 },
    ]);
    assert.equal(r.threadsThrough, 4);
  });

  test('第 7 章：本章計劃裡收了舊傷、推進了感情線，不提；收了的伏筆不提；細綱排了死人照樣是風險', async () => {
    const r = await bundle.preflight.preflightChapter(project, 7);
    assert.deepEqual(r.risks.map((x) => x.name), ['沈秋']);
    assert.deepEqual(r.threads.map((x) => x.name), ['玉佩的來歷', '青崖舊案']);
  });

  test('說法：注一句中間沒定稿的章', async () => {
    const r = await bundle.preflight.preflightChapter(project, 6);
    assert.equal(
      bundle.preflight.describeThreadNotes('本章', r.threads, r.threadsThrough, 6),
      '敘事線提醒：伏筆〈玉佩的來歷〉計劃第 5 章前收，還沒收，本章計劃裡也沒安排收（第 5 章還沒同步或還沒補記，敘事線還沒記上，提醒可能不準）。只是提醒，照寫不攔。'
    );
  });
});

describe('章節工作臺：還沒寫的章上一句', () => {
  const wb = (no) => bundle.workbench.buildWorkbench(project, { kind: 'manuscript', plotRelPath: PLOT(no) });

  test('第 6 章還沒寫：正文目標上一句敘事線提醒', async () => {
    const card = await wb(6);
    assert.equal(
      card.notice,
      '敘事線提醒：伏筆〈玉佩的來歷〉計劃第 5 章前收，還沒收，本章計劃裡也沒安排收（第 5 章還沒同步或還沒補記，敘事線還沒記上，提醒可能不準）。只是提醒，照寫不攔。'
    );
  });

  test('已經寫了字的章不提', async () => {
    assert.equal((await wb(5)).notice, undefined);
  });
});

describe('批次寫章的確認框多一行（不攔）', () => {
  test('區間第 6–8 章：舊傷第 7 章安排了收，不提；玉佩寫到第 6 章就過了，主線寫到第 7 章就斷了', async () => {
    h.expect('僅本次忽略，照寫', undefined);
    const n = await bundle.batch.writeManuscripts(project, { range: { from: 6, to: 8 } });
    assert.equal(n, 0);
    // 先過一致性預檢那一問（第 7 章排了死人），再是批次寫章那一問。
    const c = h.confirms.find((x) => x.actions.includes('開始寫章'));
    assert.ok(c, JSON.stringify(h.confirms.map((x) => x.message)));
    assert.ok(
      c.detail.includes(
        '敘事線提醒：伏筆〈玉佩的來歷〉計劃第 5 章前收，寫到第 6 章還沒收，區間裡也沒安排收；〈青崖舊案〉（主線）寫到第 7 章就斷了 5 章，區間裡也沒安排推進（第 5 章還沒同步或還沒補記，敘事線還沒記上，提醒可能不準）。只是提醒，不攔。'
      ),
      c.detail
    );
    assert.deepEqual(c.actions, ['開始寫章']);
  });
});

describe('對話頁：預檢卡片與寫章卡片的說明', () => {
  test('有風險：預檢卡片的說明裡帶敘事線提醒；「先不寫」一次模型都不調', async () => {
    gates = [];
    script = ['不該被呼叫'];
    gateAnswer = 'skip';
    await controller.handle({ type: 'chapterAction', plotRelPath: PLOT(7), action: 'write' });
    gateAnswer = 'proceed';
    assert.equal(gates.length, 1);
    assert.equal(gates[0].name, 'preflight');
    assert.match(gates[0].detail, /敘事線提醒：伏筆〈玉佩的來歷〉計劃第 5 章前收，還沒收，本章計劃裡也沒安排收；〈青崖舊案〉（主線）已經 5 章沒有進展/);
    assert.equal(fake.calls.length, 0);
  });

  test('沒有風險：不亮預檢卡，提醒進寫章卡片的說明（照寫）', async () => {
    gates = [];
    script = [{ text: filler(700, 80), stop: 'end' }];
    await controller.handle({ type: 'chapterAction', plotRelPath: PLOT(8), action: 'write' });
    assert.ok(gates.every((g) => g.name !== 'preflight'), JSON.stringify(gates.map((g) => g.name)));
    const card = gates.find((g) => g.name === 'artifact');
    assert.ok(card, JSON.stringify(gates.map((g) => g.name)));
    assert.match(card.detail, /· 敘事線提醒：伏筆〈玉佩的來歷〉計劃第 5 章前收，還沒收，本章計劃裡也沒安排收；伏筆〈舊傷〉計劃第 7 章前收/);
    assert.equal(fake.calls.length, 1, '寫正文 1 次，提醒零呼叫');
  });
});

// 復跑報告問題 9：「阿婆的真實身份」計劃第 5 章埋，到第 15 章還是「計劃」，兩類提醒都不管。第三類：計劃埋了卻一直沒埋，
// 照現有兩類的做法——不攔人，預檢、工作臺、批次寫章的確認框、對話頁都顯示（前端批次彈窗在 tests/dom/view/forms.test.js）。
describe('第三類：計劃埋了卻一直沒埋', () => {
  const UNPLANTED = UNFILED.replace('- 提燈人（第 3 章前收）', '- 提燈人（第 3 章前收）\n- 阿婆的身份：阿婆當年在場（計劃第 3 章埋）\n- 井底的回聲（計劃第 7 章埋）');
  before(() => {
    t.write(`${DIR}/未归属的伏笔.md`, UNPLANTED);
    project.invalidate();
  });
  after(() => {
    t.write(`${DIR}/未归属的伏笔.md`, UNFILED);
    project.invalidate();
  });

  test('預檢：計劃第 3 章埋、寫第 6 章還沒埋的提；計劃第 7 章才埋的不提', async () => {
    const r = await bundle.preflight.preflightChapter(project, 6);
    assert.deepEqual(r.threads, [
      { kind: 'overdue', name: '玉佩的來歷', resolve: 5, at: 6 },
      { kind: 'unplanted', name: '阿婆的身份', plant: 3, at: 6 },
    ]);
  });

  test('工作臺與批次寫章的確認框同一句（不攔）', async () => {
    const card = await bundle.workbench.buildWorkbench(project, { kind: 'manuscript', plotRelPath: PLOT(6) });
    assert.match(card.notice, /伏筆〈阿婆的身份〉計劃第 3 章埋，還沒埋，本章計劃裡也沒安排埋/);
    h.expect('僅本次忽略，照寫', undefined);
    assert.equal(await bundle.batch.writeManuscripts(project, { range: { from: 6, to: 8 } }), 0);
    const c = h.confirms.find((x) => x.actions.includes('開始寫章'));
    // 第 8 章前面已經寫過了（跳過），區間是第 6–7 章：井底的回聲計劃第 7 章埋，寫第 7 章時還不算過。
    assert.match(c.detail, /伏筆〈阿婆的身份〉計劃第 3 章埋，寫到第 6 章還沒埋，區間裡也沒安排埋；〈青崖舊案〉/);
    assert.doesNotMatch(c.detail, /井底的回聲/);
  });

  test('對話頁：沒風險時進寫章卡片的說明（照寫）', async () => {
    gates = [];
    script = [{ text: filler(700, 81), stop: 'end' }];
    const before = fake.calls.length;
    await controller.handle({ type: 'chapterAction', plotRelPath: PLOT(6), action: 'write' });
    const card = gates.find((g) => g.name === 'artifact');
    assert.ok(card, JSON.stringify(gates.map((g) => g.name)));
    assert.match(card.detail, /伏筆〈阿婆的身份〉計劃第 3 章埋，還沒埋，本章計劃裡也沒安排埋/);
    assert.equal(fake.calls.length - before, 1, '提醒零呼叫');
  });
});
