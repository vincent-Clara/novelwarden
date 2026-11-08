/**
 * 故事時間（2026-10-24，docs/design/plans/2026-10-24-story-timeline.md；同日重做見 2026-10-24-story-timeline-rework.md）：同步時單獨
 * 一次認時間、寫進 `threads/时间线.md`；同步過、時間線裡還沒有的章「補推」；機器寫的行「重推」。真臨時工程 + 假模型。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 同步一章單獨一次認時間：輸入帶曆法與起點、前面幾章的時間、上一章的結尾、細綱記的時間地點；認事件那一次不再帶時間 | 重做「三」：推得不準的根因是看不到上一章停在哪 |
 * | 時間線按模板新建；章內幾跳加成歷時；正文寫明的日子收進〔文中〕；完成提示說時間 | 重做「一」「三」；第 2 條 |
 * | 重新同步：機器寫的行照新推的換，作者寫的不動（完成提示說「你定的，沒改」） | ⚑7；第 28 條 |
 * | 時間那一步沒成：敘事線照樣記下，黃 ❗ 掛在章節上（op timeline），次數照算；再成了清掉 | 第 16 條 |
 * | 從正文補記敘事線不再推時間 | 作者定的第 4 條 |
 * | 補推：同步過、正文沒再改過、時間線裡沒有（或還推不出）的章，不要求敘事線判過；不連號的斷開成兩批；帶上一章的結尾 | 作者定的第 4 條；第 4 條 |
 * | 補推：一批沒成就停，失敗掛在時間線檔案上，再點一次接著推、清掉失敗；模型漏了的說出來 | 第 2、16 條 |
 * | 重推：機器寫的行（依據還在也換）照新推的換，作者寫的不動；能只推一段；確認框說會換掉幾行、幾行不動 | 作者定的第 5 條；第 3、4 條 |
 * | 改時間：問一句（預填現在的值、認不出的不放行），寫下的就是作者定的；清空刪掉那一行；改起點先挑曆法再問起點，「填為起點」不問 | 作者定的第 2 條；0 次 |
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

const TIMELINE = '.novelwarden/threads/时间线.md';
const pad3 = (n) => String(n).padStart(3, '0');
const CH = (no) => `chapters/${pad3(no)}-第${no}章.md`;
const PLOT = (no) => `.novelwarden/summaries/${pad3(no)}-第${no}章.md`;
const text = (no) => `# 第${no}章\n\n第${no}章那天的清晨，林昭走進青崖鎮。\n\n兩日後的夜裡，沈氏翻開名冊。\n\n第${no}章的末尾，燈滅了。\n`;

const TIME_MARK = '你是小說的時間校對員';
const FIND_MARK = '你是小說定稿事實審查員';

/** 認時間那幾次：送來了哪幾章、使用者訊息。 */
const timeAsks = [];
/** 每一章答什麼（缺席 = 同一天、有依據）。 */
let timeOf = () => undefined;
/** 這些章所在的那一次答壞。 */
let brokenTime = new Set();
/** 這些章模型漏掉不給。 */
let skipTime = new Set();
/** 認事件那幾次的使用者訊息。 */
const findAsks = [];

function defaultTime(no) {
  return { chapter: no, days: 1, part: '清晨', evidence: `第${no}章那天的清晨，林昭走進青崖鎮。`, jumps: [{ days: 2, evidence: '兩日後的夜裡' }], endPart: '夜裡' };
}

function reply(messages) {
  const system = messages[0]?.content ?? '';
  const user = messages[messages.length - 1].content;
  if (system.includes(FIND_MARK)) {
    findAsks.push(user);
    return JSON.stringify({ events: [], newThreads: [], newForeshadowing: [] });
  }
  if (system.includes(TIME_MARK)) {
    const nos = [...user.matchAll(/【第(\d+)章 /g)].map((m) => Number(m[1]));
    timeAsks.push({ nos, user, system });
    if (nos.some((no) => brokenTime.has(no))) {
      return '今天不想判。';
    }
    return JSON.stringify({ times: nos.filter((no) => !skipTime.has(no)).map((no) => timeOf(no) ?? defaultTime(no)) });
  }
  if (system.includes('建立可檢索的章節檔案')) {
    const no = Number(/【第(\d+)章/.exec(user)?.[1] ?? 0);
    return JSON.stringify({ 梗概: `第 ${no} 章。`, 出场人物: [{ name: '林昭', aliases: [] }], 时间地点: '次日清晨，青崖鎮。', 关键事件: ['進鎮'], 状态变更: '', 连续性事实: [] });
  }
  return '（認不出這一步）';
}

/** 寫好第 from–to 章，細綱記上 sourceHash（同步過）。 */
async function writeFinalized(from, to) {
  for (let no = from; no <= to; no++) {
    t.write(CH(no), text(no));
  }
  project.invalidate();
  const chapters = await project.listChapters();
  for (let no = from; no <= to; no++) {
    const hash = chapters.find((c) => c.order === no).contentHash;
    t.write(PLOT(no), `---\nno: ${no}\ntitle: 第${no}章\nsourceHash: ${hash}\n---\n\n# 第${no}章\n\n## 梗概\n第 ${no} 章。\n\n## 時間地點\n第 ${no} 章的次日清晨。\n`);
  }
  project.invalidate();
}

async function chapterNo(no) {
  project.invalidate();
  return (await project.listChapters()).find((c) => c.order === no);
}

const timelineOf = () => bundle.timeline.parseTimelineFile(t.read(TIMELINE), TIMELINE);
const failuresOf = async (rel) => (await bundle.errorLog.listActiveFailures(project))[rel] ?? [];

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    finalize: './src/core/features/finalize.ts',
    backfill: './src/core/features/threadsBackfill.ts',
    timeBackfill: './src/core/features/timelineBackfill.ts',
    timeEdit: './src/core/features/timelineEdit.ts',
    errorLog: './src/core/runtime/errorLog.ts',
    timeline: './src/core/model/timelineFile.ts',
    threadsPrompt: './src/core/features/threadsPrompt.ts',
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
    reply,
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });
  t = await makeTempProject(bundle.project, { prefix: 'story-timeline', title: '青崖記' });
  project = t.project;
  for (let no = 1; no <= 3; no++) {
    t.write(CH(no), text(no));
  }
  project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle?.db);
});

describe('同步一章：單獨一次認時間', () => {
  let outcome;
  before(async () => {
    fake.reset();
    timeAsks.length = 0;
    findAsks.length = 0;
    await bundle.finalize.finalizeChapter(project, await chapterNo(1));
    outcome = await bundle.finalize.finalizeChapter(project, await chapterNo(2));
  });

  test('認事件那一次不再帶時間：提示裡沒有「上一章的時間」，系統提示裡沒有 time', () => {
    assert.ok(findAsks.length >= 2);
    assert.ok(findAsks.every((u) => !u.includes('上一章的時間')), findAsks[1]);
    assert.ok(!bundle.threadsPrompt.THREAD_FIND_SYSTEM.includes('"time"'));
  });

  test('每章一次認時間；次數算在同步裡（細綱 1 + 認事件 1 + 故事時間 1）', () => {
    assert.deepEqual(timeAsks.map((a) => a.nos), [[1], [2]]);
    assert.equal(outcome.calls, 3);
  });

  test('輸入：曆法與起點、前面幾章的時間（帶結尾時段）、上一章的結尾、細綱記的時間地點；第 1 章說 days 寫 0', () => {
    assert.ok(timeAsks[0].user.includes('【曆法與起點】\n簡單歷（每月 30 天、一年 12 個月）；沒填起點，只按天數算。'), timeAsks[0].user);
    assert.ok(timeAsks[0].user.includes('【前面幾章的時間】（程式按時間線推算的，幫你接上）\n這是第 1 章：days 寫 0。'), timeAsks[0].user);
    const u = timeAsks[1].user;
    assert.ok(u.includes('第 1 章：第 1 天 清晨 → 第 3 天 夜裡（故事第 1–3 天）'), u);
    assert.ok(u.includes('【第 1 章的結尾】（上一章最後一段：本章開頭接著哪個時刻，看這裡）\n'), u);
    assert.ok(u.includes('第1章的末尾，燈滅了。'), u);
    assert.ok(u.includes('（細綱記的時間地點，只當提示，不是正文：次日清晨，青崖鎮。）'), u);
    assert.ok(u.includes('請給第 2 章各判一次時間'), u);
  });

  test('時間線按模板新建：章內一跳加成歷時、開頭與結尾時段；第一章的差值不算', () => {
    const raw = t.read(TIMELINE);
    assert.match(raw, /^---\ncalendar: 简单历\nstart: \n/);
    assert.ok(raw.includes('- 第 2 章：+1 天，清晨 → 夜裡，歷時 3 天〔依據：「第2章那天的清晨，林昭走進青崖鎮。」〕'), raw);
    const days = bundle.timeline.computeTimeline(timelineOf()).days;
    assert.deepEqual(days.map((d) => [d.chapter, d.start, d.end]), [
      [1, 1, 3],
      [2, 4, 6],
    ]);
  });

  test('完成提示說時間', () => {
    assert.ok(bundle.finalize.describeFinalize(2, outcome).includes('時間：+1 天，歷時 3 天（依據「第2章那天的清晨，林昭走進青崖鎮。」）'), bundle.finalize.describeFinalize(2, outcome));
  });

  test('重新同步：機器寫的行照新推的換（依據還在也換）；作者寫的不動，完成提示說「你定的」', async () => {
    timeOf = (no) => (no === 2 ? { chapter: 2, days: 5, evidence: '兩日後的夜裡' } : undefined);
    await bundle.finalize.finalizeChapter(project, await chapterNo(2));
    assert.ok(t.read(TIMELINE).includes('- 第 2 章：+5 天〔依據：「兩日後的夜裡」〕'), t.read(TIMELINE));
    t.write(TIMELINE, t.read(TIMELINE).replace('- 第 2 章：+5 天〔依據：「兩日後的夜裡」〕', '- 第 2 章：三月十四'));
    const before = t.read(TIMELINE);
    const again = await bundle.finalize.finalizeChapter(project, await chapterNo(2));
    assert.equal(t.read(TIMELINE), before);
    assert.ok(bundle.finalize.describeFinalize(2, again).includes('時間線裡這一章是你定的，沒改'), bundle.finalize.describeFinalize(2, again));
    timeOf = () => undefined;
  });

  test('正文寫明的日子收進〔文中〕，證據裡沒寫著的不收', async () => {
    timeOf = (no) =>
      no === 3
        ? { chapter: 3, days: 0, evidence: '第3章那天的清晨，林昭走進青崖鎮。', date: { date: '三月初九', evidence: '第3章那天的清晨，林昭走進青崖鎮。' } }
        : undefined;
    const o = await bundle.finalize.finalizeChapter(project, await chapterNo(3));
    assert.equal(o.time.entry.dateMark, undefined);
    timeOf = () => undefined;
  });

  test('時間那一步沒成：敘事線照樣記下，黃 ❗ 掛在章節上（op timeline），次數照算；再成了清掉', async () => {
    brokenTime = new Set([3]);
    const failed = await bundle.finalize.finalizeChapter(project, await chapterNo(3));
    assert.match(failed.timeError, /解析不出來/);
    assert.equal(failed.threadsError, undefined);
    assert.equal(failed.calls, 3);
    const [f] = await failuresOf(CH(3));
    assert.equal(f?.op, 'timeline');
    assert.equal(f.severity, 'warn');
    assert.ok(bundle.finalize.describeFinalize(3, failed).includes('故事時間沒推成'));
    brokenTime = new Set();
    await bundle.finalize.finalizeChapter(project, await chapterNo(3));
    assert.deepEqual(await failuresOf(CH(3)), []);
  });
});

describe('從正文補記敘事線不再推時間', () => {
  test('補記逐章認事件，一次認時間都不調', async () => {
    await writeFinalized(4, 5);
    timeAsks.length = 0;
    h.expect('開始補記');
    await bundle.backfill.backfillThreads(project);
    assert.equal(timeAsks.length, 0);
    assert.ok(!(h.toasts.at(-1) ?? '').includes('故事時間'), h.toasts.at(-1));
  });
});

describe('補推：同步過、時間線裡沒有（或還推不出）的章', () => {
  before(async () => {
    // 第 6–9 章同步過，敘事線一章都沒判（補推不再要求判過）；第 8 章同步之後正文又改了；第 5 章是機器寫的 +?。
    await writeFinalized(6, 9);
    t.write(CH(8), `${text(8)}\n又加了一段。\n`);
    const raw = t.read(TIMELINE).replace(/- 第 5 章：[^\n]*\n/u, '');
    t.write(TIMELINE, `${raw.trimEnd()}\n- 第 5 章：+?〔推不出：沒說〕\n`);
    project.invalidate();
  });

  test('要推哪幾章：沒有的、機器寫的 +?；改過的列出來；不連號的斷開成兩批', async () => {
    const plan = await bundle.timeBackfill.planTimeline(project, 'fill');
    // 第 4 章那一行補記時沒推（補記不推時間了）。
    assert.deepEqual(plan.batches.map((b) => b.map((c) => c.order)), [[4, 5, 6, 7], [9]]);
    assert.deepEqual(plan.stale, [8]);
    // 一批寫 1 次、轉寫 1 次，轉寫不合格重轉 1 次（2026-10-25 起）。
    assert.deepEqual(plan.calls, { low: 4, high: 4, max: 6, why: '每批寫 1 次、轉寫模型照抄成 JSON 1 次；轉寫不合格重轉 1 次' });
  });

  test('按字數切批：一批最多 5 章，合計超過上限另起一批', () => {
    const ch = (order, wordCount) => ({ order, wordCount, title: '', relPath: '', contentHash: '' });
    const batches = bundle.timeBackfill.batchTimeChapters([ch(1, 9000), ch(2, 9000), ch(3, 9000), ch(4, 100), ch(5, 100), ch(6, 100), ch(7, 100), ch(8, 100), ch(9, 100)]);
    assert.deepEqual(batches.map((b) => b.map((c) => c.order)), [[1, 2], [3, 4, 5, 6, 7], [8, 9]]);
  });

  test('一批沒成：停下，失敗掛在時間線檔案上（紅 ❗），這一批一行都沒寫', async () => {
    brokenTime = new Set([4]);
    h.expect('開始補推');
    await bundle.timeBackfill.backfillTimeline(project);
    const c = h.confirms.at(-1);
    assert.match(c.message, /^從正文補推故事時間：第 4–7、9 章同步過/);
    assert.ok(c.message.includes('預計 4 次呼叫，最多 6 次'), c.message);
    assert.ok(c.detail.includes('第 8 章同步之後正文又改過'), c.detail);
    assert.ok(!('contextDetail' in c.call));
    const [f] = await failuresOf(TIMELINE);
    assert.equal(f?.severity, 'error');
    assert.equal(f.op, 'timelineBackfill');
    assert.ok(!t.read(TIMELINE).includes('第 4 章'));
  });

  test('再點一次：推完；第一批帶上一章（第 3 章）的結尾；模型漏了的說出來；失敗清掉', async () => {
    brokenTime = new Set();
    skipTime = new Set([7]);
    timeAsks.length = 0;
    h.expect('開始補推');
    await bundle.timeBackfill.backfillTimeline(project);
    assert.deepEqual(timeAsks.map((a) => a.nos), [[4, 5, 6, 7], [9]]);
    assert.ok(timeAsks[0].user.includes('【第 3 章的結尾】'), timeAsks[0].user);
    assert.ok(timeAsks[0].user.includes('請給第 4、5、6、7 章各判一次時間'), timeAsks[0].user);
    const tl = timelineOf();
    assert.deepEqual(tl.entries.map((e) => e.chapter).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 9]);
    assert.match(t.read(TIMELINE), /- 第 4 章：\+1 天[^\n]*\n- 第 5 章：\+1 天/);
    assert.deepEqual(await failuresOf(TIMELINE), []);
    const toast = h.toasts.at(-1);
    assert.ok(toast.includes('補推故事時間：推了 4 章（第 4–6、9 章）'), toast);
    assert.ok(toast.includes('模型漏了第 7 章'), toast);
    skipTime = new Set();
  });
});

describe('重推：機器寫的行照新推的換', () => {
  test('只推一段：確認框說會換掉幾行、你定的幾行不動；作者寫的不動，依據還在的機器行也換', async () => {
    timeOf = (no) => ({ chapter: no, days: 7, evidence: '兩日後的夜裡' });
    timeAsks.length = 0;
    h.expect('開始重推');
    await bundle.timeBackfill.refreshTimeline(project, { from: 1, to: 4 });
    const c = h.confirms.at(-1);
    assert.match(c.message, /^重推故事時間：第 1、3–4 章/);
    assert.ok(c.detail.includes('會換掉 3 行機器寫的'), c.detail);
    assert.ok(c.detail.includes('第 2 章是你定的，一個字不動'), c.detail);
    const raw = t.read(TIMELINE);
    assert.ok(raw.includes('- 第 2 章：三月十四'), raw);
    for (const no of [3, 4]) {
      assert.ok(raw.includes(`- 第 ${no} 章：+7 天〔依據：「兩日後的夜裡」〕`), raw);
    }
    // 不連號（第 2 章是你定的）：第 1 章單獨一批，第 3–4 章一批。
    assert.deepEqual(timeAsks.map((a) => a.nos), [[1], [3, 4]]);
    assert.ok(h.toasts.at(-1).includes('第 2 章是你定的，沒動'), h.toasts.at(-1));
    timeOf = () => undefined;
  });

  test('一段裡全是你定的：不調模型，說清為什麼', async () => {
    fake.reset();
    await bundle.timeBackfill.refreshTimeline(project, { from: 2, to: 2 });
    assert.equal(fake.callCount(), 0);
    assert.ok(h.toasts.at(-1).includes('第 2 章沒有可以重推時間的章：第 2 章是你定的（機器不動）'), h.toasts.at(-1));
  });
});

// 真實模型試跑之後補的（2026-10-24）：正文裡寫著「第二十二回」，模型照它填了 chapter 22。
describe('模型報的章號對不上：按先後認作送去的那一章', () => {
  test('單章同步：報成別的章號也寫進這一章', async () => {
    timeOf = (no) => ({ ...defaultTime(no), chapter: 22, days: 4 });
    const o = await bundle.finalize.finalizeChapter(project, await chapterNo(1));
    assert.equal(o.time.missing, undefined);
    assert.ok(t.read(TIMELINE).includes('- 第 1 章：+4 天'), t.read(TIMELINE));
    timeOf = () => undefined;
  });
});

describe('作者在介面上改：改時間、改曆法與起點（0 次）', () => {
  test('改時間：預填現在的值、校驗寫法；寫下的去掉行尾那一段，之後重推不動它', async () => {
    fake.reset();
    const before = timelineOf().entries.find((e) => e.chapter === 3);
    assert.ok(bundle.timeline.isMachineEntry(before));
    h.expect('+6 天，傍晚');
    await bundle.timeEdit.editTimelineEntry(project, 3);
    const ask = h.inputs.at(-1);
    assert.equal(ask.title, '第 3 章的時間');
    assert.equal(ask.value, bundle.timeline.renderTimeValue(before.value) + (before.part ? `，${before.part}` : ''));
    assert.match(ask.validate('過了好一陣'), /^認不出/);
    assert.equal(ask.validate('第 20 天'), undefined);
    const after = timelineOf().entries.find((e) => e.chapter === 3);
    assert.deepEqual(after.value, { kind: 'delta', days: 6 });
    assert.equal(after.part, '傍晚');
    assert.equal(after.basis, undefined);
    assert.ok(h.toasts.at(-1).includes('這一行是你定的'), h.toasts.at(-1));
    assert.equal(fake.callCount(), 0);
    // 重推第 3 章：你定的，不動。
    h.expect();
    await bundle.timeBackfill.refreshTimeline(project, { from: 3, to: 3 });
    assert.equal(fake.callCount(), 0);
    assert.deepEqual(timelineOf().entries.find((e) => e.chapter === 3).value, { kind: 'delta', days: 6 });
  });

  test('改時間：清空就是刪掉那一行；取消（沒答）什麼都不動', async () => {
    const before = t.read(TIMELINE);
    h.expect(undefined);
    await bundle.timeEdit.editTimelineEntry(project, 3);
    assert.equal(t.read(TIMELINE), before);
    h.expect('');
    await bundle.timeEdit.editTimelineEntry(project, 3);
    assert.ok(!timelineOf().entries.some((e) => e.chapter === 3));
    assert.ok(h.toasts.at(-1).includes('刪掉了'), h.toasts.at(-1));
  });

  test('改曆法與起點：先挑曆法、再問起點（校驗寫法）；「填為起點」直接填、不問', async () => {
    h.expect('公历', '2026-03-07');
    await bundle.timeEdit.setTimelineStart(project);
    assert.deepEqual(h.picks.at(-1).choices.map((c) => c.value), ['简单历', '公历']);
    assert.match(h.inputs.at(-1).validate('很久以前'), /^認不出/);
    let tl = timelineOf();
    assert.equal(tl.calendar, '公历');
    assert.equal(tl.startText, '2026-03-07');
    h.expect();
    await bundle.timeEdit.setTimelineStart(project, '2026-03-05');
    assert.equal(h.inputs.length + h.picks.length, 0);
    tl = timelineOf();
    assert.equal(tl.calendar, '公历');
    assert.equal(tl.startText, '2026-03-05');
  });
});
