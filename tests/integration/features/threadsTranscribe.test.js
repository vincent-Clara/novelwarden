/**
 * 敘事線改成轉寫（2026-10-25，細綱試點之後推到全部結構化產物）：排線、認事件、歸併、當前進度四次都不再要模型直接出 JSON，
 * 按格式寫自然語言，由「轉寫」那一檔的模型照抄成原來那份 JSON（features/transcribe.ts 的 `transcribeJson`），解碼與校驗一行沒改。
 * 假模型兩個：幹活的是 big（劇情細綱檔、定稿檔都沒配，沿用預設模型），轉寫的是 small（快速檔）。
 *
 * | 用例組 | 釘的是什麼 |
 * |---|---|
 * | 排線 · 照抄收下 | 排 1 次、轉寫 1 次；轉寫只帶合同與原文、不帶書的上下文；落盤的線與伏筆（章號按對應關係填）；確認框報 2 次、轉寫單列 |
 * | 排線 · 改了字 | 轉寫改了原文的字不收，重轉一次、說清哪幾處 |
 * | 排線 · 轉寫呼叫失敗 | 照原來排線失敗的走法：掛紅 ❗、檔案不動；呼叫照實記賬 |
 * | 補記一章 · 三段都轉寫 | 認事件、當前進度各寫 1 次、轉寫 1 次；歸併寫的「無」（換了說法的「無需歸併」也算）不轉寫；證據照抄、對正文核過才記；新線、新伏筆、當前進度落盤 |
 * | 補記一章 · 認事件轉寫兩次不合格 | 照原來認事件沒成的走法：停在這一章、失敗掛在章節上、水位不動；寫 1 次 + 轉寫 2 次照實記賬 |
 * | 補記一章 · 什麼都沒認出 | 三節都寫「無」不轉寫，1 次；這一章照樣算判過，上一次的失敗清掉 |
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
/** 按模型引用注入異常（fakeProvider 的 behavior）：建 provider 時現讀。 */
const behavior = {};

const THREADS = '.novelwarden/threads';
const file = (name) => `${THREADS}/${name}.md`;
const names = () => (t.has(THREADS) ? require('fs').readdirSync(t.rel(THREADS)).sort() : []);
const pad3 = (n) => String(n).padStart(3, '0');
const CH = (no) => `chapters/${pad3(no)}-第${no}章.md`;
const PLOT = (no) => `.novelwarden/summaries/${pad3(no)}-第${no}章.md`;

const TRANSCRIBER = '格式轉寫員';
const PLAN_MARK = '只從作者給的小說配置、故事前提、角色圖譜與情節大綱裡排出這本書的敘事線';
const FIND_MARK = '你是小說定稿事實審查員';
const MERGE_MARK = '判斷它們是不是已有的某一條換了個說法';
const PROGRESS_MARK = '給每一條寫一兩句「當前進度」';

/** 幹活的那幾次各寫什麼（字串，或吃 messages 的函式）。 */
let writer = {};
/** 轉寫那幾次依次答什麼（同上）。 */
let copies = [];

const answer = (x, messages) => (typeof x === 'function' ? x(messages) : (x ?? '（沒有準備這一步）'));

function reply(messages) {
  const system = messages[0]?.content ?? '';
  if (system.includes(TRANSCRIBER)) {
    return answer(copies.shift(), messages);
  }
  if (system.includes(PLAN_MARK)) return answer(writer.plan, messages);
  if (system.includes(FIND_MARK)) return answer(writer.find, messages);
  if (system.includes(MERGE_MARK)) return answer(writer.merge, messages);
  if (system.includes(PROGRESS_MARK)) return answer(writer.progress, messages);
  return '（認不出這一步）';
}

const systemOf = (i) => fake.calls[i][0].content;
const userOf = (i) => fake.calls[i][fake.calls[i].length - 1].content;
const refOf = (i) => fake.calls[i].ref;
const lastUser = (messages) => messages[messages.length - 1].content;

/** 當前進度：寫的那一次給送來的每條線寫一段；轉寫那一次照原文一段一項搬。 */
const writeProgress = (messages) =>
  [...lastUser(messages).matchAll(/^【線】(.+)$/gm)].map((m) => `【線】${m[1]}\n當前進度：${m[1]}走到了這裡。`).join('\n\n');
const copyProgress = (messages) => {
  const source = lastUser(messages).split('【原文】')[1] ?? '';
  return JSON.stringify({ progress: [...source.matchAll(/【線】(.+)\n當前進度：(.+)/g)].map((m) => ({ line: m[1].trim(), text: m[2].trim() })) });
};

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    threads: './src/core/features/threads.ts',
    backfill: './src/core/features/threadsBackfill.ts',
    threadFile: './src/core/model/threadFile.ts',
    errorLog: './src/core/runtime/errorLog.ts',
    db: './src/core/runtime/db.ts',
  });
  // 劇情細綱檔、定稿檔都沒配：沿用預設模型 big；轉寫那一檔（快速檔）配的是 small。
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'big', contextWindow: 100000 }, { name: 'small', contextWindow: 32000 }] }],
    models: ['p/big'],
    tierModels: { fast: ['p/small'] },
    taskTiers: { plotSummary: 'balanced' },
    concurrency: 1,
  };
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply,
    behavior,
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });
  t = await makeTempProject(bundle.project, { prefix: 'threads-transcribe', title: '青雲劍錄' });
  project = t.project;
  t.write(
    '.novelwarden/config.md',
    '---\ngenre: 玄幻\ntotalChapters: 20\nwordsPerChapter: 3000\n---\n# 設定\n\n## 一句話\n\n少年揹著舊案入宗。\n'
  );
  writeOutline(t, outlineOf(20, { text: { 1: '林昭揹著舊案入宗，與沈青從猜忌到並肩，查出當年放火的人。' } }));
  project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle?.db);
});

// ---------------------------------------------------------------- 排線

/** 排線的模型按格式寫出來的兩條線。 */
const PLAN_PROSE = [
  '## 林昭與沈青',
  '種類：感情線',
  '章節：第 3 章—第 18 章',
  '意圖：從互相猜忌到並肩。',
  '伏筆：',
  '- 玉佩的來歷：林昭的玉佩是沈家舊物（第 3 章埋，第 18 章前收）',
  '',
  '## 沈家舊案',
  '種類：主線',
  '章節：不定',
  '意圖：查清十年前那把火是誰放的。',
  '伏筆：無',
].join('\n');

/** 轉寫模型照抄出來的那一份。 */
const planCopy = (over = {}) =>
  JSON.stringify({
    threads: [
      {
        title: '林昭與沈青',
        kind: '感情线',
        from: 3,
        to: 18,
        intent: '從互相猜忌到並肩。',
        foreshadowing: [{ title: '玉佩的來歷', what: '林昭的玉佩是沈家舊物', plant: 3, resolve: 18 }],
        ...over,
      },
      { title: '沈家舊案', kind: '主线', intent: '查清十年前那把火是誰放的。', foreshadowing: [] },
    ],
  });

describe('排線 · 按格式寫，轉寫模型照抄成 JSON', () => {
  let returned;
  let confirm;

  before(async () => {
    t.remove(THREADS);
    project.invalidate();
    writer = { plan: PLAN_PROSE };
    copies = [planCopy()];
    fake.reset();
    h.expect('開始排');
    returned = await bundle.threads.generateThreads(project);
    confirm = h.confirms.at(-1);
  });

  test('排 1 次、轉寫 1 次：排的是劇情細綱檔（預設模型），轉寫的是轉寫那一檔', () => {
    assert.equal(fake.callCount(), 2);
    assert.equal(returned, 2);
    assert.ok(systemOf(0).includes(PLAN_MARK) && !systemOf(0).includes('只輸出一個 JSON 物件'), systemOf(0).slice(0, 300));
    assert.ok(userOf(0).endsWith('請按上面的格式寫。'), userOf(0).slice(-80));
    assert.deepEqual([refOf(0), refOf(1)], ['p/big', 'p/small']);
  });

  test('轉寫只帶合同與原文，不帶書的上下文', () => {
    assert.ok(systemOf(1).includes(TRANSCRIBER), systemOf(1));
    assert.ok(userOf(1).includes('【敘事線 JSON 合同】') && userOf(1).includes('【原文】\n## 林昭與沈青\n種類：感情線'), userOf(1));
    assert.ok(!userOf(1).includes('少年揹著舊案入宗'), userOf(1));
  });

  test('照抄的落了盤：種類、章號按對應關係填，伏筆掛線上下', async () => {
    assert.deepEqual(names(), ['林昭與沈青.md', '沈家舊案.md']);
    const { threads } = await project.readThreads();
    const by = Object.fromEntries(threads.map((x) => [x.name, x]));
    assert.deepEqual([by['林昭與沈青'].kind, by['林昭與沈青'].from, by['林昭與沈青'].to, by['林昭與沈青'].intent], ['感情线', 3, 18, '從互相猜忌到並肩。']);
    assert.deepEqual(by['林昭與沈青'].foreshadowing, [{ name: '玉佩的來歷', what: '林昭的玉佩是沈家舊物', plant: 3, resolve: 18 }]);
    assert.deepEqual([by['沈家舊案'].kind, by['沈家舊案'].foreshadowing], ['主线', []]);
  });

  test('確認框報排 1 次、轉寫 1 次，最多 3 次；轉寫單列一行、不跟這一次挑的模型', () => {
    assert.ok(confirm.message.includes('預計 2 次呼叫，最多 3 次'), confirm.message);
    assert.equal(confirm.call.fixed?.length, 1, JSON.stringify(confirm.call));
    assert.ok(confirm.call.fixed[0].includes('不跟這一次挑的模型'), confirm.call.fixed[0]);
  });
});

describe('排線 · 轉寫改了原文的字', () => {
  let returned;

  before(async () => {
    t.remove(THREADS);
    project.invalidate();
    writer = { plan: PLAN_PROSE };
    copies = [planCopy({ intent: '從猜忌走到並肩。' }), planCopy()];
    fake.reset();
    h.expect('開始排');
    returned = await bundle.threads.generateThreads(project);
  });

  test('不收，重轉一次、說清哪幾處不是原文裡的字；重轉照抄的收下', () => {
    assert.equal(fake.callCount(), 3);
    assert.equal(returned, 3);
    assert.ok(systemOf(2).includes(TRANSCRIBER));
    assert.ok(userOf(2).includes('【上次轉寫不合格】這幾處不是原文裡的字：「從猜忌走到並肩。」'), userOf(2).slice(0, 1200));
    assert.deepEqual(names(), ['林昭與沈青.md', '沈家舊案.md']);
  });
});

describe('排線 · 轉寫呼叫失敗', () => {
  let returned;

  before(async () => {
    t.remove(THREADS);
    project.invalidate();
    writer = { plan: PLAN_PROSE };
    copies = [];
    behavior['p/small'] = 'fail';
    fake.reset();
    h.expect('開始排');
    returned = await bundle.threads.generateThreads(project);
    delete behavior['p/small'];
  });

  test('照原來排線失敗的走法：掛紅 ❗、檔案不動；排的那一次與轉寫那一次都記賬', async () => {
    assert.equal(returned, 2);
    assert.deepEqual(names(), []);
    const [f] = (await bundle.errorLog.listActiveFailures(project))[THREADS] ?? [];
    assert.equal(f?.severity, 'error');
    assert.match(f.message, /^排敘事線失敗：敘事線轉寫沒成（轉寫呼叫失敗/);
    assert.ok(h.toasts.at(-1).includes('敘事線沒排成（敘事線轉寫沒成'), h.toasts.at(-1));
  });
});

// ---------------------------------------------------------------- 補記（定稿第三步：認事件、歸併、當前進度）

/** 已有的一條線：玉佩那條伏筆還沒埋。 */
const PAIR = [
  '---',
  'kind: 感情線',
  'plan: 1-18',
  '---',
  '',
  '# 林昭與沈青',
  '',
  '## 意圖',
  '從互相猜忌到並肩。',
  '',
  '## 伏筆',
  '- 玉佩的來歷：林昭的玉佩是沈家舊物（計劃第 1 章埋、第 18 章前收）',
  '',
].join('\n');

const TEXT = {
  1: [
    '# 第1章',
    '',
    '夜裡，沈青坐在廊下，把那塊玉佩翻過來，背面刻著一個小小的沈字。',
    '',
    '林昭看著她，忽然明白那塊玉佩原來是沈家的舊物。',
    '',
    '院外有人提著燈走過，腳步很輕。',
    '',
  ].join('\n'),
  2: '# 第2章\n\n林昭追到後院，只看見一盞燈。\n\n燈下沒有人。\n',
};

/** 第 `no` 章：正文 + 同步過的細綱（sourceHash 對得上正文）。 */
async function finalized(no) {
  t.write(CH(no), TEXT[no]);
  project.invalidate();
  const hash = (await project.listChapters()).find((c) => c.order === no).contentHash;
  t.write(PLOT(no), `---\nno: ${no}\ntitle: 第${no}章\nsourceHash: ${hash}\n---\n\n# 第${no}章\n\n## 梗概\n第 ${no} 章。\n`);
  project.invalidate();
}

/** 認事件的模型按三節寫出來的第 1 章：證據用「」引出正文原句。 */
const FIND_PROSE = [
  '## 事件',
  '- 推進｜林昭與沈青：兩人夜談，林昭認出玉佩。證據：「林昭看著她，忽然明白那塊玉佩原來是沈家的舊物。」',
  '- 埋〈玉佩的來歷〉｜林昭與沈青：玉佩背面刻著沈字。證據：「把那塊玉佩翻過來，背面刻著一個小小的沈字」',
  '## 新線',
  '- 沈家舊案｜支線：沈家當年出了什麼事。證據：「背面刻著一個小小的沈字」',
  '## 新伏筆',
  '- 提燈人｜沈家舊案：院外提燈的人是誰。證據：「院外有人提著燈走過，腳步很輕。」',
].join('\n');

const FIND_COPY = JSON.stringify({
  events: [
    { line: '林昭與沈青', type: '推进', what: '兩人夜談，林昭認出玉佩。', evidence: '林昭看著她，忽然明白那塊玉佩原來是沈家的舊物。' },
    { line: '林昭與沈青', type: '埋', foreshadowing: '玉佩的來歷', what: '玉佩背面刻著沈字。', evidence: '把那塊玉佩翻過來，背面刻著一個小小的沈字' },
  ],
  newThreads: [{ title: '沈家舊案', kind: '支线', intent: '沈家當年出了什麼事。', evidence: '背面刻著一個小小的沈字' }],
  newForeshadowing: [{ title: '提燈人', line: '沈家舊案', what: '院外提燈的人是誰。', evidence: '院外有人提著燈走過，腳步很輕。' }],
});

describe('補記一章 · 認事件、歸併、當前進度都按格式寫，轉寫照抄', () => {
  let n;
  let confirm;

  before(async () => {
    t.remove(THREADS);
    t.write(file('林昭與沈青'), PAIR);
    await finalized(1);
    // 一條都不併：模型沒照「無」寫、換了個說法，也認得出來、不轉寫。
    writer = { find: FIND_PROSE, merge: '無需歸併。', progress: writeProgress };
    copies = [FIND_COPY, copyProgress];
    fake.reset();
    h.expect('開始補記');
    n = await bundle.backfill.backfillThreads(project);
    confirm = h.confirms.at(-1);
  });

  test('確認框：每章 2–6 次（含轉寫），轉寫單列一行', () => {
    assert.ok(confirm.message.includes('（每章 2–6 次）') && confirm.message.includes('預計 2–6 次呼叫，最多 9 次'), confirm.message);
    assert.ok(confirm.detail.includes('每寫一次轉寫模型照抄成 JSON 1 次'), confirm.detail);
    assert.equal(confirm.call.fixed?.length, 1, JSON.stringify(confirm.call));
  });

  test('認事件寫 1 次、轉寫 1 次；歸併寫的「無需歸併」不轉寫；當前進度寫 1 次、轉寫 1 次', () => {
    assert.equal(fake.callCount(), 5);
    assert.equal(n, 5);
    const steps = fake.calls.map((c) => c[0].content).map((s) =>
      s.includes(TRANSCRIBER) ? '轉寫' : s.includes(FIND_MARK) ? '認事件' : s.includes(MERGE_MARK) ? '歸併' : s.includes(PROGRESS_MARK) ? '当前进度' : '?'
    );
    assert.deepEqual(steps, ['認事件', '轉寫', '歸併', '当前进度', '轉寫']);
    assert.deepEqual(fake.calls.map((c) => c.ref), ['p/big', 'p/small', 'p/big', 'p/big', 'p/small']);
  });

  test('寫的那幾次不要 JSON；轉寫只帶合同與那一次的原文', () => {
    assert.ok(userOf(0).endsWith('請按上面的格式寫。') && userOf(2).endsWith('請按上面的格式寫。') && userOf(3).endsWith('請按上面的格式寫。'));
    assert.ok(userOf(1).includes('【敘事線事件 JSON 合同】') && userOf(1).includes(`【原文】\n${FIND_PROSE}`), userOf(1));
    // 原文裡只有引出來的那幾句正文：整章正文不進轉寫。
    assert.ok(!userOf(1).includes('【第1章'), userOf(1).slice(0, 600));
    assert.ok(userOf(4).includes('【當前進度 JSON 合同】') && userOf(4).includes('【線】林昭與沈青\n當前進度：林昭與沈青走到了這裡。'), userOf(4));
  });

  test('照抄的證據對正文核過才記；新線、新伏筆、當前進度落了盤；水位推到第 1 章', async () => {
    const pair = bundle.threadFile.parseThreadFile(t.read(file('林昭與沈青')), file('林昭與沈青'));
    assert.deepEqual(
      pair.events.map((e) => [e.chapter, e.type, e.foreshadowing ?? '', e.evidence]),
      [
        [1, '推进', '', '林昭看著她，忽然明白那塊玉佩原來是沈家的舊物。'],
        [1, '埋', '玉佩的來歷', '把那塊玉佩翻過來，背面刻著一個小小的沈字'],
      ]
    );
    assert.equal(pair.progress, '林昭與沈青走到了這裡。');
    const grown = bundle.threadFile.parseThreadFile(t.read(file('沈家舊案')), file('沈家舊案'));
    assert.deepEqual([grown.kind, grown.origin, grown.intent], ['支线', '正文', '沈家當年出了什麼事。']);
    assert.deepEqual(grown.foreshadowing.map((f) => f.name), ['提燈人']);
    assert.deepEqual(await project.readThreadsMark(), { through: 1, judged: [] });
  });
});

describe('補記一章 · 認事件轉寫兩次都改了證據', () => {
  let n;

  before(async () => {
    await finalized(2);
    const bad = JSON.stringify({
      events: [{ line: '林昭與沈青', type: '推进', what: '林昭追到後院。', evidence: '林昭追到了後院，只看見一盞燈。' }],
      newThreads: [],
      newForeshadowing: [],
    });
    writer = { find: ['## 事件', '- 推進｜林昭與沈青：林昭追到後院。證據：「林昭追到後院，只看見一盞燈。」', '## 新線', '無', '## 新伏筆', '無'].join('\n') };
    copies = [bad, bad];
    fake.reset();
    h.expect('開始補記');
    n = await bundle.backfill.backfillThreads(project);
  });

  test('寫 1 次、轉寫 2 次（重轉那一次說清哪幾處），照實記賬', () => {
    assert.equal(fake.callCount(), 3);
    assert.equal(n, 3);
    assert.ok(userOf(2).includes('【上次轉寫不合格】這幾處不是原文裡的字：「林昭追到了後院，只看見一盞燈。」'), userOf(2).slice(0, 1200));
  });

  test('照原來認事件沒成的走法：停在這一章、失敗掛在章節上，敘事線不動、水位不動', async () => {
    const [f] = (await bundle.errorLog.listActiveFailures(project))[CH(2)] ?? [];
    assert.equal(f?.severity, 'warn');
    assert.match(f.message, /^從已寫正文補記敘事線沒成：敘事線事件轉寫不合格（這幾處不是原文裡的字：「林昭追到了後院/);
    const pair = bundle.threadFile.parseThreadFile(t.read(file('林昭與沈青')), file('林昭與沈青'));
    assert.ok(pair.events.every((e) => e.chapter === 1), JSON.stringify(pair.events));
    assert.deepEqual(await project.readThreadsMark(), { through: 1, judged: [] });
    assert.ok(h.toasts.at(-1).includes('第 2 章沒判成（敘事線事件轉寫不合格'), h.toasts.at(-1));
  });
});

describe('補記一章 · 三節都寫「無」', () => {
  let n;

  before(async () => {
    writer = { find: '## 事件\n無\n\n## 新線\n無\n\n## 新伏筆\n無' };
    copies = [];
    fake.reset();
    h.expect('開始補記');
    n = await bundle.backfill.backfillThreads(project);
  });

  test('不轉寫：1 次；這一章照樣算判過，上一次掛的失敗清掉', async () => {
    assert.equal(fake.callCount(), 1);
    assert.equal(n, 1);
    assert.deepEqual(await project.readThreadsMark(), { through: 2, judged: [] });
    assert.deepEqual((await bundle.errorLog.listActiveFailures(project))[CH(2)] ?? [], []);
  });
});
