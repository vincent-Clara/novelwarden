/**
 * 正文層的 `threads` 層（敘事線重做，設計稿「四」）：寫正文時帶沒收束、和本章有關的線，一條線一行——現在走到哪、本章計劃、
 * 沒收的伏筆；審稿只帶伏筆那一半。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 一條線一個條目，按要緊程度排：本章有計劃 / 細綱提到 → 主線 → 收束章就在附近 → 最近動過的 | 設計稿的挑法 |
 * | 一行寫現在走到哪（當前進度）、本章計劃、沒收的伏筆（該收的在前，沒到回收章的「第 b 章前不要揭開」） | 設計稿：這一層存在的另一半理由 |
 * | 計劃中、沒到開始那一章、細綱沒提的不帶；收束的不帶；還沒到埋的伏筆不提 | 帶進去等於提示模型提前寫 |
 * | 「未歸屬的伏筆」有該收的單獨一行 | 掛不上線的伏筆也要有人提醒 |
 * | 寫到第 N 章時按那時算：當前進度寫到這一章或更晚的不用，改用這一章之前的事件 | 不把後面的劇情透給前面 |
 * | 6 條以外的 dropped 寫原因、取消勾選的不佔名額 | 第 2 條：不靜默截斷 |
 * | 審稿只帶沒收的伏筆（換個標題）；續寫、修稿不帶 | 設計稿 ⚑5；它們各有各的配方 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

const WRITE = { stage: 'manuscript', capability: 'generate' };
const REVIEW = { stage: 'manuscript', capability: 'review' };

const config = () => ({
  providers: [{ id: 'p', kind: 'openai', baseUrl: 'https://x/v1', models: [{ name: 'm' }] }],
  model: 'p/m',
  contextWindow: 128000,
  maxOutputTokens: 4096,
  temperature: 0.8,
  chaptersDir: 'chapters',
  draftsDir: 'drafts',
  summaryBatchSize: 15,
  requestTimeoutMs: 300000,
});

const pad3 = (n) => String(n).padStart(3, '0');
const PLOT = (no) => `.novelwarden/summaries/${pad3(no)}-第${no}章.md`;

/** 一份還沒定稿的細綱（計劃）。 */
function plotText(no, events) {
  return [
    '---',
    `no: ${no}`,
    `title: 第${no}章`,
    'targetWords: 1200',
    '---',
    '',
    `# 第${no}章 第${no}章`,
    '',
    '## 梗概',
    '',
    '往下查。',
    '',
    '## 出場人物',
    '',
    '林昭',
    '',
    '## 關鍵事件',
    '',
    events,
    '',
    '## 看點',
    '',
    '- 井底有人。',
    '',
  ].join('\n');
}

/** 敘事線：一條線一個檔案。 */
const DIR = '.novelwarden/threads';
const thread = (kind, plan, { intent = '', fore = [], events = [] } = {}) =>
  [
    '---',
    `kind: ${kind}`,
    `plan: ${plan}`,
    '---',
    '',
    '## 意圖',
    intent,
    '',
    '## 伏筆',
    ...fore.map((f) => `- ${f}`),
    '',
    '## 進展',
    ...events.map((e) => `- ${e}`),
    '',
  ].join('\n');

let bundle;
let t;

/** 林昭與沈青：當前進度是機器寫到第 4 章的；第 5 章計劃推進；兩條伏筆，一條第 5 章該收、一條第 18 章才收。 */
function pairFile() {
  return bundle.threadFile.patchProgress(
    thread('感情线', '2-30', {
      intent: '從互相猜忌到並肩。',
      fore: ['玉佩的來歷：沈家舊物（計劃第 2 章埋、第 18 章前收）', '沈青的舊傷（第 5 章前收）'],
      events: [
        '第 3 章 · 推進：初遇 〔證據：「她的劍停在他喉前三寸」〕',
        '第 3 章 · 埋〈玉佩的來歷〉：玉佩露面 〔證據：「他摸了摸懷裡的玉佩」〕',
        '第 5 章 · 計劃 · 推進：沈青第一次替林昭擋刀',
      ],
    }),
    '兩人已結盟，沈青仍瞞著身份。',
    4
  );
}

const THREADS = () => ({
  林昭與沈青: pairFile(),
  遠方的來信: thread('支线', '10-12', { intent: '信是誰寄的。' }),
  青崖鎮的大火: thread('主线', '1-40', { intent: '大火是誰放的。', events: ['第 1 章 · 推進：起火 〔證據：「火光沖天」〕'] }),
  後面才開的線: thread('支线', '9-20', { intent: '林昭的師父另有身份。' }),
  已經收了: thread('支线', '1-9', { events: ['第 2 章 · 收束：收了 〔證據：「x」〕'] }),
  斷了的線: thread('人物线', '1-30', { intent: '林昭學會放下。', events: ['第 2 章 · 推進：林昭第一次猶豫 〔證據：「他猶豫了」〕'] }),
  快收束的線: thread('支线', '1-7', { intent: '鎮上的怪事。', events: ['第 1 章 · 推進：怪事開頭 〔證據：「井裡有聲音」〕'] }),
});
const UNFILED = '# 未歸屬的伏筆\n\n## 伏筆\n- 提燈人：院外提燈的人（第 4 章前收）\n- 斷劍（計劃第 9 章埋）\n\n## 進展\n- 第 2 章 · 埋〈提燈人〉：有人提燈走過 〔證據：「提著燈」〕\n';

/** 把敘事線目錄換成這幾條（再加 `extra` 條進行中的支線）。 */
function writeThreads(extra = 0) {
  t.remove(DIR);
  for (const [name, text] of Object.entries(THREADS())) {
    t.write(`${DIR}/${name}.md`, text);
  }
  t.write(`${DIR}/未归属的伏笔.md`, UNFILED);
  for (let i = 0; i < extra; i++) {
    t.write(`${DIR}/區間內${i}.md`, thread('支线', '1-30', { events: [`第 4 章 · 推進：第${i}條 〔證據：「x」〕`] }));
  }
  t.project.invalidate();
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    builder: './src/core/context/builder.ts',
    threadFile: './src/core/model/threadFile.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost().host);
  t = await makeTempProject(bundle.project, { prefix: 'threadsLayer', title: '敘事線測試' });
  for (let no = 1; no <= 4; no++) {
    t.write(`chapters/${pad3(no)}-第${no}章.md`, `# 第${no}章\n\n第${no}章的正文。\n`);
  }
  // 第 5 章的細綱提到了「遠方的來信」：它沒到區間，但細綱提了就帶，而且排在最前那一檔。
  t.write(PLOT(5), plotText(5, '林昭收到了遠方的來信，信上沒有落款。'));
  t.write(PLOT(1), plotText(1, '林昭在雪夜裡出逃。'));
  writeThreads();
});

after(() => {
  if (t) cleanup(t.dir, bundle?.db);
});

function build(no, extra = {}) {
  return bundle.builder.buildContext(
    t.project,
    { action: WRITE, target: { kind: 'manuscript', plotRelPath: PLOT(no) }, ask: '', targetWords: 1200, ...extra },
    config()
  );
}

const threadItems = (b) => b.items.filter((i) => i.kind === 'thread');
const userOf = (b) => b.messages[b.messages.length - 1].content;

describe('threads 層 · 第 5 章', () => {
  let b;
  before(async () => {
    b = await build(5);
  });

  test('有關的線一條一個條目，按要緊程度排：本章有計劃 / 細綱提到 → 主線 → 收束章在附近、有伏筆該收 → 最近動過的', () => {
    assert.deepEqual(
      threadItems(b).map((i) => [i.label, i.status, i.note]),
      [
        ['敘事線 · 林昭與沈青', 'included', '進行中 · 本章有計劃'],
        ['敘事線 · 遠方的來信', 'included', '計劃中 · 本章細綱提到了它'],
        ['敘事線 · 青崖鎮的大火', 'included', '進行中 · 主線'],
        ['敘事線 · 快收束的線', 'included', '進行中 · 計劃第 7 章收束，就在附近'],
        ['敘事線 · 未歸屬的伏筆', 'included', '未歸屬 · 有伏筆該收了、本章有計劃或細綱提到了'],
        ['敘事線 · 斷了的線', 'included', '進行中 · 最近第 2 章動過'],
      ]
    );
  });

  test('來源是那條線自己的檔案，優先順序 P1', () => {
    const [pair] = threadItems(b);
    assert.equal(pair.source, '.novelwarden/threads/林昭與沈青.md');
    assert.equal(pair.priority, 1);
  });

  test('計劃中、還沒到開始那一章、細綱沒提的不帶；收束了的不帶', () => {
    const labels = threadItems(b).map((i) => i.label).join('|');
    assert.ok(!labels.includes('後面才開的線'), labels);
    assert.ok(!labels.includes('已經收了'), labels);
  });

  test('一行：現在走到哪、本章計劃、沒收的伏筆（該收的在前，沒到回收章的不要揭開）', () => {
    const [pair, letter, fire] = threadItems(b);
    assert.equal(
      pair.text,
      '- 林昭與沈青（感情線 · 進行中）現在：兩人已結盟，沈青仍瞞著身份；本章計劃：推進——沈青第一次替林昭擋刀；沒收的伏筆：沈青的舊傷（本章計劃收）、玉佩的來歷（第 18 章前不要揭開）'
    );
    assert.equal(letter.text, '- 遠方的來信（支線 · 計劃中）意圖：信是誰寄的');
    assert.equal(fire.text, '- 青崖鎮的大火（主線 · 進行中）最近：第 1 章推進：起火');
  });

  test('「未歸屬的伏筆」一行：逾期的提，還沒到埋的時候的不提', () => {
    const loose = threadItems(b).find((i) => i.label === '敘事線 · 未歸屬的伏筆');
    assert.equal(loose.text, '- 未歸屬的伏筆：提燈人（已過第 4 章，還沒收）');
  });

  test('訊息裡一節：一條一行，說清沒到回收章的伏筆不許提前揭開，排在前文正文與本章細綱之前', () => {
    const user = userOf(b);
    const at = user.indexOf('# 進行中的敘事線（只作提醒：以本章細綱為準，細綱沒寫到的線不要硬塞；沒到回收章的伏筆不許提前揭開）');
    assert.ok(at > 0, user.slice(0, 2000));
    const section = user.slice(at, user.indexOf('\n---\n', at));
    assert.equal(section.trim().split('\n\n').length, 2, '標題之後一條一行，中間不空行');
    assert.ok(section.indexOf('林昭與沈青') < section.indexOf('遠方的來信'), section);
    assert.ok(at < user.indexOf('# 前文正文'));
    assert.ok(at < user.indexOf('# 細綱'));
  });
});

// 復跑報告問題 5：主線這 4 個位置一直是同樣 4 條，當章細綱裡提到的「舊銅牌與銅錢的共鳴」「照骨鏡的殘片」沒列出來，正文當章
// 就把它們揭開了。細綱或本章計劃提到的伏筆一律列出、不佔 4 條的名額；「最近」不取「埋」；沒有回收章的不硬寫「不要提前揭開」。
describe('threads 層 · 本章細綱提到的伏筆一律列出', () => {
  const MAIN = thread('主线', '1-40', {
    intent: '大火是誰放的。',
    fore: [
      '銅鈴的來歷：鈴是沈家的（第 20 章前收）',
      '舊賬本：賬上少了一筆（第 21 章前收）',
      '井底的秘密：井底藏著東西（第 22 章前收）',
      '老井的回聲：井裡有回聲',
      '師父的信：信裡有名單（第 24 章前收）',
      '照骨鏡的殘片：殘片能照出死人（第 25 章前收）',
      '無面鬼火的本質：鬼火是全鎮的怨念（計劃第 9 章埋、第 20 章前收）',
    ],
    events: [
      '第 1 章 · 推進：起火 〔證據：「火光沖天」〕',
      ...['銅鈴的來歷', '舊賬本', '井底的秘密', '老井的回聲', '師父的信', '照骨鏡的殘片'].map((n) => `第 1 章 · 埋〈${n}〉：露面 〔證據：「x」〕`),
    ],
  });
  const CLOSED = thread('支线', '1-9', {
    fore: ['沉船的秘密：船是被鑿沉的（第 30 章前收）', '沒提到的：不列（第 30 章前收）'],
    events: ['第 1 章 · 埋〈沉船的秘密〉：露面 〔證據：「x」〕', '第 1 章 · 埋〈沒提到的〉：露面 〔證據：「x」〕', '第 2 章 · 收束：收了 〔證據：「x」〕'],
  });
  const setUp = () => {
    t.remove(DIR);
    t.write(`${DIR}/青崖鎮的大火.md`, MAIN);
    t.write(`${DIR}/已經收了.md`, CLOSED);
    t.write(PLOT(6), plotText(6, '- 林昭在祠堂撿到照骨鏡殘片，想起師父的信\n- 遠處的無面鬼火又浮了起來\n- 沉船的秘密有了眉目'));
    t.project.invalidate();
  };
  const tearDown = () => {
    t.remove(PLOT(6));
    writeThreads();
  };

  test('提到的排在同一檔最前面、不佔 4 條名額；還沒到埋的被提到也列（第 b 章前不要揭開）；沒有回收章的換個說法；「最近」不取「埋」', async () => {
    setUp();
    const items = threadItems(await build(6));
    const fire = items.find((i) => i.label === '敘事線 · 青崖鎮的大火');
    assert.equal(
      fire.text,
      '- 青崖鎮的大火（主線 · 進行中）最近：第 1 章推進：起火；沒收的伏筆：無面鬼火的本質（第 20 章前不要揭開）、師父的信（第 24 章前不要揭開）、' +
        '照骨鏡的殘片（第 25 章前不要揭開）、銅鈴的來歷（第 20 章前不要揭開）、舊賬本（第 21 章前不要揭開）、井底的秘密（第 22 章前不要揭開）、' +
        '老井的回聲（還沒定哪一章收，細綱沒安排就別揭開）'
    );
    assert.equal(fire.note, '進行中 · 本章細綱提到了它上面的伏筆');
    // 收束了的線不帶，它上面本章提到的伏筆照列（只列提到的那幾條）。
    const closed = items.find((i) => i.label === '敘事線 · 已經收了');
    assert.equal(closed.text, '- 已經收了（支線 · 已收束）沒收的伏筆：沉船的秘密（第 30 章前不要揭開）');
    tearDown();
  });

  test('仍受這一層的總字數管：整行放不下時，明細裡點名說本章提到的那幾條沒帶上', async () => {
    setUp();
    const b = await bundle.builder.buildContext(
      t.project,
      { action: WRITE, target: { kind: 'manuscript', plotRelPath: PLOT(6) }, ask: '', targetWords: 1200 },
      { ...config(), contextOverrides: { threadChars: 80 } }
    );
    const fire = threadItems(b).find((i) => i.label === '敘事線 · 青崖鎮的大火');
    assert.equal(fire.status, 'dropped');
    assert.equal(
      fire.note,
      '敘事線一共只帶 80 字，放不下這一條（其中有本章細綱或計劃提到的伏筆：無面鬼火的本質、師父的信、照骨鏡的殘片，沒帶上）'
    );
    tearDown();
  });
});

describe('threads 層 · 名額與排除', () => {
  test('最多 6 條，排在後面的 dropped 並寫原因', async () => {
    writeThreads(3);
    const items = threadItems(await build(5));
    assert.equal(items.filter((i) => i.status === 'included').length, 6);
    const dropped = items.filter((i) => i.status === 'dropped');
    assert.equal(dropped.length, 3);
    assert.ok(dropped.every((i) => i.note === '敘事線一次只帶 6 條，排在後面的沒帶' && i.text === ''), JSON.stringify(dropped));
    writeThreads();
  });

  test('取消勾選的那條標 excluded，不佔名額', async () => {
    writeThreads(3);
    const first = threadItems(await build(5))[0];
    const items = threadItems(await build(5, { excludedIds: [first.id] }));
    assert.equal(items.find((i) => i.id === first.id)?.status, 'excluded');
    assert.equal(items.filter((i) => i.status === 'included').length, 6);
    assert.equal(items.filter((i) => i.status === 'dropped').length, 2);
    writeThreads();
  });
});

describe('threads 層 · 寫到第 N 章時按那時算', () => {
  // 重寫第 1 章：後面幾章才發生的事、寫到第 4 章的當前進度都不算；林昭與沈青第 2 章才開、第 1 章沒計劃，不帶。
  test('第 1 章：只帶那時已經開了的線，沒有「最近」與「現在」', async () => {
    const items = threadItems(await build(1));
    assert.deepEqual(items.map((i) => i.label), [
      '敘事線 · 青崖鎮的大火',
      '敘事線 · 斷了的線',
      '敘事線 · 快收束的線',
      '敘事線 · 已經收了',
    ]);
    assert.equal(items[0].text, '- 青崖鎮的大火（主線 · 計劃中）意圖：大火是誰放的');
    assert.ok(items.every((i) => !i.text.includes('最近') && !i.text.includes('現在')), JSON.stringify(items.map((i) => i.text)));
  });
});

describe('threads 層 · 什麼時候不帶、審稿帶什麼', () => {
  test('沒有敘事線：一條都不出', async () => {
    t.remove(DIR);
    t.project.invalidate();
    const b = await build(5);
    assert.deepEqual(threadItems(b), []);
    assert.ok(!userOf(b).includes('# 進行中的敘事線'));
    writeThreads();
  });

  test('續寫那幾輪不帶', async () => {
    const b = await build(5, { step: { kind: 'continuation', tail: '已寫的末尾', written: 600, remaining: 600, recovery: false } });
    assert.deepEqual(threadItems(b), []);
  });

  test('修稿不帶', async () => {
    const revise = await build(5, { writeMode: 'revise', revision: { previousDraft: '第5章的正文。', feedback: '改一處' } });
    assert.deepEqual(threadItems(revise), []);
  });

  // 設計稿 ⚑5：審稿提示詞裡兩條伏筆檢查的材料從前是角色卡「未收伏筆」與細綱「新增伏筆」，都並進了敘事線。
  test('審稿只帶沒收的伏筆：該收的在前，沒到回收章的「不該揭開」，換個標題', async () => {
    const review = await bundle.builder.buildContext(
      t.project,
      { action: REVIEW, target: { kind: 'manuscript', plotRelPath: PLOT(5) }, ask: '', reviewGoals: [] },
      config()
    );
    assert.deepEqual(
      threadItems(review).map((i) => i.text),
      [
        '- 提燈人（掛在「未歸屬的伏筆」· 已埋 · 已過第 4 章，還沒收）是什麼：院外提燈的人',
        '- 沈青的舊傷（掛在「林昭與沈青」· 計劃 · 本章計劃收）',
        '- 玉佩的來歷（掛在「林昭與沈青」· 已埋 · 第 18 章前不該揭開）是什麼：沈家舊物',
      ]
    );
    assert.ok(threadItems(review).every((i) => i.label.startsWith('伏筆 · ')));
    const user = userOf(review);
    assert.ok(user.includes('# 沒收的伏筆（審稿對照：計劃在本章收的寫到沒有；沒到回收章的有沒有提前揭開）'), user.slice(0, 1500));
    assert.ok(!user.includes('# 進行中的敘事線'));
  });
});

// 敘事線二期（設計稿「二」）：拆細綱的 `plot` 配方也帶 threads 層，按區間挑——批次時 `plot` 是空的、`no` 只是第一章，
// 只看第一章會把這一批後面幾章該收的伏筆漏掉。
describe('threads 層 · 拆細綱（按區間挑）', () => {
  const PLAN = { stage: 'plot', capability: 'generate' };
  const buildPlot = (range, extra = {}, cfg = {}) =>
    bundle.builder.buildContext(
      t.project,
      { action: PLAN, target: { kind: 'plot', plotRelPath: PLOT(range.from) }, ask: '', ...(range.to > range.from ? { range } : {}), ...extra },
      { ...config(), ...cfg }
    );

  test('批次第 5–9 章：線全帶（收束的不帶），這一批原來有計劃的在前、還沒到開始的在最後並寫明', async () => {
    const b = await buildPlot({ from: 5, to: 9 });
    const lines = threadItems(b).filter((i) => i.label.startsWith('敘事線 · '));
    assert.deepEqual(lines.map((i) => [i.label, i.note]), [
      ['敘事線 · 林昭與沈青', '進行中 · 本批原來有計劃'],
      ['敘事線 · 青崖鎮的大火', '進行中 · 主線'],
      ['敘事線 · 斷了的線', '進行中 · 最近第 2 章動過'],
      ['敘事線 · 快收束的線', '進行中 · 最近第 1 章動過'],
      ['敘事線 · 後面才開的線', '計劃中 · 本批在它的計劃區間裡'],
      ['敘事線 · 遠方的來信', '計劃中 · 計劃第 10 章起，本批還不到'],
    ]);
    assert.equal(
      lines[0].text,
      '- 林昭與沈青（感情線 · 進行中 · 計劃第 2–30 章）意圖：從互相猜忌到並肩；現在：兩人已結盟，沈青仍瞞著身份；最近：第 3 章推進：初遇；第 3 章埋〈玉佩的來歷〉：玉佩露面；本批原來的計劃：第 5 章推進——沈青第一次替林昭擋刀'
    );
    assert.equal(lines[3].text, '- 快收束的線（支線 · 進行中 · 計劃在第 7 章收束）意圖：鎮上的怪事；最近：第 1 章推進：怪事開頭');
    assert.equal(lines[5].text, '- 遠方的來信（支線 · 計劃中 · 計劃第 10–12 章）意圖：信是誰寄的；本批還不到它開始的那一章，不要提前開');
    assert.ok(lines.every((i) => i.priority === 1 && i.source.startsWith('.novelwarden/threads/')));
  });

  test('批次第 5–9 章：沒收的伏筆一條一個，這一批要收的、逾期的在前，這一批要埋的排在已埋的前面；第 9 章才埋的這一批也帶', async () => {
    const fores = threadItems(await buildPlot({ from: 5, to: 9 })).filter((i) => i.label.startsWith('伏筆 · '));
    assert.deepEqual(fores.map((i) => i.text), [
      '- 提燈人（掛在「未歸屬的伏筆」· 已埋 · 已過第 4 章，還沒收）是什麼：院外提燈的人',
      '- 沈青的舊傷（掛在「林昭與沈青」· 計劃 · 本批要收，最晚第 5 章，還沒埋，先埋再收）',
      '- 斷劍（掛在「未歸屬的伏筆」· 計劃 · 本批要埋，計劃第 9 章）',
      '- 玉佩的來歷（掛在「林昭與沈青」· 已埋 · 第 18 章前收，之前不要揭開）是什麼：沈家舊物',
    ]);
    assert.equal(fores[0].id, 'thread:.novelwarden/threads/未归属的伏笔.md#提燈人');
  });

  test('單章第 5 章：說「本章」，第 9 章才埋的不帶，第 7 章收束的線不算落在這一章', async () => {
    const items = threadItems(await buildPlot({ from: 5, to: 5 }));
    const texts = items.map((i) => i.text).join('\n');
    assert.ok(texts.includes('沈青的舊傷（掛在「林昭與沈青」· 計劃 · 本章要收，還沒埋，先埋再收）'), texts);
    assert.ok(texts.includes('本章原來的計劃：第 5 章推進'), texts);
    assert.ok(!texts.includes('斷劍'), texts);
    assert.ok(texts.includes('- 快收束的線（支線 · 進行中 · 計劃第 1–7 章）'), texts);
  });

  test('訊息裡一節：線在前、沒收的伏筆另起一段，排在連續性事實之後、前序細綱一覽與本章細綱之前', async () => {
    const user = userOf(await buildPlot({ from: 5, to: 9 }));
    const at = user.indexOf('# 敘事線（照著排：該推進的線推進、該收的伏筆安排在某一章收');
    assert.ok(at >= 0, user.slice(0, 1500));
    const section = user.slice(at, user.indexOf('\n---\n', at));
    assert.ok(section.indexOf('- 林昭與沈青') < section.indexOf('\n\n沒收的伏筆：\n- 提燈人'), section);
    assert.ok(!user.includes('# 進行中的敘事線'));
    const list = user.indexOf('# 前序細綱一覽');
    assert.ok(list < 0 || at < list);
  });

  test('線、伏筆各按上下文詳細度封頂，放不下的 dropped 寫原因；伏筆名額外的只列名字；取消勾選的不佔名額', async () => {
    const cfg = { contextOverrides: { plotThreadCount: 2, plotForeshadowCount: 1 } };
    const b = await buildPlot({ from: 5, to: 9 }, {}, cfg);
    const items = threadItems(b);
    const lines = items.filter((i) => i.label.startsWith('敘事線 · '));
    const fores = items.filter((i) => i.label.startsWith('伏筆 · ') && i.id !== 'thread:foreshadowing-rest');
    assert.equal(lines.filter((i) => i.status === 'included').length, 2);
    assert.ok(lines.filter((i) => i.status === 'dropped').every((i) => i.note === '敘事線一次只帶 2 條，排在後面的沒帶'));
    assert.deepEqual(fores.filter((i) => i.status === 'included').map((i) => i.label), ['伏筆 · 提燈人']);
    assert.deepEqual(fores.filter((i) => i.status === 'dropped').map((i) => i.note), [
      '伏筆一次只帶 1 條，排在後面的沒帶；名字列在「其餘沒收的伏筆」裡',
      '伏筆一次只帶 1 條，排在後面的沒帶；名字列在「其餘沒收的伏筆」裡',
      '伏筆一次只帶 1 條，排在後面的沒帶',
    ]);
    // 名額外的三條併成一行，最多列名額的兩倍（這裡 2 個），再多的連名字也不列，明細裡說清。
    const rest = items.find((i) => i.id === 'thread:foreshadowing-rest');
    assert.equal(rest.label, '伏筆 · 其餘 3 條（只列名字）');
    assert.equal(rest.text, '其餘沒收的伏筆（名額外，只列名字；細綱沒安排就別揭開，也別另起同名的）：沈青的舊傷、斷劍 等 3 條。');
    assert.equal(rest.note, '名額外的只列名字，最多 2 個，其餘 1 條連名字也沒列');
    const user = userOf(b);
    assert.ok(user.includes('沒收的伏筆：\n- 提燈人（掛在「未歸屬的伏筆」· 已埋 · 已過第 4 章，還沒收）是什麼：院外提燈的人\n其餘沒收的伏筆（'), user);
    const excluded = await buildPlot({ from: 5, to: 9 }, { excludedIds: [fores[0].id] }, cfg);
    const after = threadItems(excluded).filter((i) => i.label.startsWith('伏筆 · '));
    assert.equal(after.find((i) => i.id === fores[0].id).status, 'excluded');
    assert.deepEqual(after.filter((i) => i.status === 'included').map((i) => i.label), ['伏筆 · 沈青的舊傷', '伏筆 · 其餘 2 條（只列名字）']);
  });

  test('這幾章的細綱或作者這一次的話裡提到的已埋伏筆排到已埋的最前面，明細裡說清', async () => {
    const items = threadItems(await buildPlot({ from: 5, to: 9 }, { ask: '這一批讓玉佩的來歷再露一下面' }));
    const fores = items.filter((i) => i.label.startsWith('伏筆 · '));
    assert.equal(fores.find((i) => i.label === '伏筆 · 玉佩的來歷').note, '已埋 · 第 18 章前收，之前不要揭開；本批細綱或作者的話裡提到了');
  });

  test('討論細綱也帶（同一張配方）；沒有敘事線時一條都不出', async () => {
    const discuss = await bundle.builder.buildContext(
      t.project,
      { action: { stage: 'plot', capability: 'discuss' }, target: { kind: 'plot', plotRelPath: PLOT(5) }, ask: '這一章怎麼排？' },
      config()
    );
    assert.ok(threadItems(discuss).some((i) => i.label === '敘事線 · 林昭與沈青'));
    t.remove(DIR);
    t.project.invalidate();
    const b = await buildPlot({ from: 5, to: 9 });
    assert.deepEqual(threadItems(b), []);
    assert.ok(!userOf(b).includes('# 敘事線（'));
    writeThreads();
  });
});

describe('threads 層 · 故事時間（2026-10-24）', () => {
  const TIMELINE = `${DIR}/时间线.md`;
  const PLAN = { stage: 'plot', capability: 'generate' };
  const storyTime = (b) => threadItems(b).filter((i) => i.label === '故事時間');

  before(() => {
    t.write(
      TIMELINE,
      [
        '---',
        'calendar: 簡單歷',
        'start: 大衍三年三月初七',
        '---',
        '',
        '# 時間線',
        '',
        '- 第 1 章：+0 天，傍晚〔依據：「第1章的正文」〕',
        '- 第 2 章：+2 天〔推測：趕路〕',
        '- 第 3 章：回憶，約二十年前',
        '- 第 4 章：+1 天，歷時 2 天〔依據：「第4章的正文」〕',
        '',
      ].join('\n')
    );
    t.project.invalidate();
  });

  after(() => {
    t.remove(TIMELINE);
    t.project.invalidate();
  });

  test('寫第 5 章：上一章是哪天（回憶不推進時間，歷時推後結尾），一條、來源是時間線、不佔敘事線的名額', async () => {
    const b = await build(5);
    const [item] = storyTime(b);
    assert.equal(item.status, 'included');
    assert.equal(item.source, TIMELINE);
    assert.equal(item.priority, 1);
    assert.equal(
      item.text,
      [
        '上一章（第 4 章）：大衍三年三月初十（故事第 4 天）起，歷時 2 天，到大衍三年三月十一（第 5 天）。眼下是春天。',
        // 最近幾章的節奏（2026-10-24 重做）：回憶不推進時間。
        '最近幾章：第 1 章 三月初七；第 2 章 三月初九（+2 天）；第 3 章 回憶；第 4 章 三月初十（+1 天）。',
        '本章的時間要接得上；本章細綱「時間地點」寫了的照它。',
      ].join('\n')
    );
    // 敘事線照舊 6 條，故事時間不佔它們的名額。
    assert.equal(threadItems(b).filter((i) => i.label.startsWith('敘事線 · ') && i.status === 'included').length, 6);
  });

  test('訊息裡單獨成一節，排在敘事線那一節前面', async () => {
    const user = userOf(await build(5));
    const time = user.indexOf('# 故事時間（');
    const lines = user.indexOf('# 進行中的敘事線');
    assert.ok(time >= 0 && lines > time, user.slice(0, 400));
    assert.ok(user.includes('大衍三年三月初十'));
  });

  test('拆第 5–9 章：說已寫到哪一章、那一章是哪天，叫細綱寫清晚多久', async () => {
    const b = await bundle.builder.buildContext(
      t.project,
      { action: PLAN, target: { kind: 'plot', plotRelPath: PLOT(5) }, ask: '', range: { from: 5, to: 9 } },
      config()
    );
    const [item] = storyTime(b);
    assert.match(item.text, /^已寫到第 4 章：大衍三年三月初十（故事第 4 天）起，歷時 2 天/);
    assert.match(item.text, /眼下是春天。/);
    assert.match(item.text, /細綱「時間地點」寫清每章比上一章晚多久/);
  });

  test('審稿不帶；取消勾選就不進訊息', async () => {
    const review = await build(5, { action: REVIEW });
    assert.deepEqual(storyTime(review), []);
    const [item] = storyTime(await build(5));
    const excluded = await build(5, { excludedIds: [item.id] });
    assert.equal(storyTime(excluded)[0].status, 'excluded');
    assert.ok(!userOf(excluded).includes('# 故事時間（'));
  });

  test('寫第 1 章（之前一行都沒有）：不出', async () => {
    assert.deepEqual(storyTime(await build(1)), []);
  });
});
