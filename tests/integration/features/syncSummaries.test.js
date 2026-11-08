/**
 * 工程頁黃條上的「立即同步」（`syncSummaries`）：把待定稿的章逐章定稿，三步與單章定稿同一套。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 確認框寫明三步與次數（每章 1–3 次） | 第 4 條：動手之前寫明預計呼叫次數 |
 * | 三章的細綱都記上 `sourceHash` | 第一步照舊：照正文更新細綱、算寫完 |
 * | 角色狀態與敘事線每章各走一次，按章號 1、2、3 的順序 | 從前同步只做第一步，章算定稿了、角色狀態與敘事線卻停在原地；這兩步要一章一章往後推，併發會搶寫同一張卡、同一條線 |
 * | 角色卡的「當前狀態」推到最後一章，敘事線記上事件 | 同步過的章與逐章定稿的章是同一個結果 |
 * | 返回實際呼叫次數 | MCP 的 `summary sync` 拿它記賬 |
 * | 第一步沒成的章不走後兩步，紅 ❗ 掛在那一章 | 細綱沒更新，角色狀態與敘事線沒有可依據的出場人物 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, TIME_MARK, timeReply } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let fake;
let t;
let project;

const CH = (no) => `chapters/00${no}-第${no}章.md`;
const PLOT = (no) => `.novelwarden/summaries/00${no}-第${no}章.md`;
const CARD = '.novelwarden/characters/林昭.md';
const THREADS = '.novelwarden/threads/玉佩的來歷.md';
const textOf = (no) => `林昭在第${no}章摸了摸懷裡的玉佩。\n\n沈氏在第${no}章翻開名冊。`;

/** 給了章號就讓那一章的定稿答壞（第一步失敗那一節）。 */
let brokenNo;

const STATE_MARK = '依據本章正文更新角色的「當前狀態」';
const THREAD_MARK = '你是小說定稿事實審查員';
const PROGRESS_MARK = '給每一條寫一兩句「當前進度」';

function reply(messages) {
  const system = messages[0]?.content ?? '';
  const user = messages[messages.length - 1].content;
  const no = Number(/【第(\d+)章/.exec(user)?.[1] ?? 0);
  if (system.includes('建立可檢索的章節檔案')) {
    if (no === brokenNo) {
      return '這不是 JSON';
    }
    return JSON.stringify({
      梗概: `第 ${no} 章。`,
      出场人物: [{ name: '林昭', aliases: [] }],
      时间地点: '青崖鎮。',
      关键事件: [`第 ${no} 章的事`],
      状态变更: '',
      连续性事实: [`沈氏在第${no}章翻開名冊`],
    });
  }
  if (system.includes(STATE_MARK)) {
    return JSON.stringify({ updates: [{ name: '林昭', 当前状态: `第 ${no} 章之後，玉佩還在懷裡` }] });
  }
  if (system.includes(THREAD_MARK)) {
    return JSON.stringify({
      events: [{ line: '玉佩的來歷', type: '推进', what: '玉佩又露面', evidence: `林昭在第${no}章摸了摸懷裡的玉佩` }],
      newThreads: [],
      newForeshadowing: [],
    });
  }
  if (system.includes(PROGRESS_MARK)) {
    return JSON.stringify({ progress: [{ line: '玉佩的來歷', text: `第 ${no} 章，玉佩還在林昭懷裡。` }] });
  }
  // 故事時間（同步時單獨一次，2026-10-24 重做）：都緊接上一章。
  if ((messages[0]?.content ?? '').includes(TIME_MARK)) {
    return timeReply(messages);
  }
  return '（認不出這一步）';
}

/** 角色狀態、敘事線這兩種呼叫各是第幾章，按發出去的先後排。 */
function stepOrder(mark) {
  return fake.calls
    .filter((messages) => (messages[0]?.content ?? '').includes(mark))
    .map((messages) => Number(/【第(\d+)章/.exec(messages[messages.length - 1].content)?.[1] ?? 0));
}

async function writeChapters(nos) {
  for (const no of nos) {
    t.write(CH(no), `# 第${no}章\n\n${textOf(no)}\n`);
  }
  project.invalidate();
  await project.syncManifest();
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    summarize: './src/core/features/summarize.ts',
    plotFile: './src/core/model/plotFile.ts',
    threadFile: './src/core/model/threadFile.ts',
    db: './src/core/runtime/db.ts',
    errorLog: './src/core/runtime/errorLog.ts',
  });
  // 併發 2 路：第一步照樣併發，後兩步也得按章號排好。
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 2,
  };
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply,
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });
  t = await makeTempProject(bundle.project, { prefix: 'syncSummaries', title: '定稿測試' });
  project = t.project;
  // 林昭的卡從沒蓋過章、當前狀態空著：歸機器寫。
  t.write(CARD, '---\nname: 林昭\n---\n\n# 林昭\n\n## 身份\n\n回鎮的人\n\n## 當前狀態\n\n');
  t.write(
    THREADS,
    bundle.threadFile.renderThreadFile({ name: '玉佩的來歷', kind: '支线', origin: '计划', from: 1, to: 9, intent: '玉佩是沈家舊物。', foreshadowing: [] })
  );
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('同步：三章逐章定稿，角色狀態與敘事線按章號走', () => {
  let used;

  before(async () => {
    await writeChapters([1, 2, 3]);
    fake.reset();
    h.expect('開始同步');
    used = await bundle.summarize.syncSummaries(project);
  });

  test('確認框寫明四步與次數', () => {
    const { message, detail } = h.confirms.at(-1);
    assert.ok(message.startsWith('有 3 章寫了正文還沒同步'), message);
    assert.ok(message.includes('更新出場角色的當前狀態、認這一章在敘事線上發生了什麼、推這一章的故事時間'), message);
    assert.ok(message.includes('預計 18–36 次呼叫，最多 54 次'), message);
    assert.ok(detail.includes('角色狀態、敘事線與故事時間按章號逐章序列'), detail);
  });

  test('三章的細綱都記上了正文的指紋', async () => {
    project.invalidate();
    for (const chapter of await project.listChapters()) {
      const plot = await project.readPlot(PLOT(chapter.order));
      assert.equal(plot.sourceHash, chapter.contentHash, `第 ${chapter.order} 章`);
    }
  });

  test('角色狀態與敘事線每章各一次，按章號順序', () => {
    assert.deepEqual(stepOrder(STATE_MARK), [1, 2, 3]);
    assert.deepEqual(stepOrder(THREAD_MARK), [1, 2, 3]);
  });

  test('角色卡的當前狀態推到了第 3 章', () => {
    const text = t.read(CARD);
    assert.ok(text.includes('第 3 章之後，玉佩還在懷裡'), text);
    assert.ok(/stateThrough: 3/.test(text), text);
  });

  test('那條線按章記上了三條事件，當前進度推到了第 3 章', () => {
    const thread = bundle.threadFile.parseThreadFile(t.read(THREADS), THREADS);
    assert.deepEqual(thread.events.map((e) => e.chapter), [1, 2, 3]);
    assert.equal(thread.progress, '第 3 章，玉佩還在林昭懷裡。');
    assert.equal(thread.progressThrough, 3);
  });

  test('返回實際呼叫次數：3 章 ×（細綱、角色狀態、認敘事線、當前進度、故事時間）', () => {
    assert.equal(used, 15);
    assert.equal(fake.calls.length, 15);
  });

  // 敘事線重做：按實際結果說，不再一律說「跟到了這幾章」。
  test('完成提示按實際結果說角色狀態與敘事線', () => {
    const done = h.toasts.map((m) => String(m.message ?? m)).find((m) => m.includes('已同步 3 章'));
    assert.ok(done, JSON.stringify(h.toasts));
    assert.ok(done.includes('林昭的當前狀態更新到了最後同步的那一章') && done.includes('敘事線：記下 3 個事件'), done);
    assert.ok(done.includes('故事時間：推了 3 章'), done);
    assert.ok(!done.includes('跟到了這幾章'), done);
  });

  // 試跑：單章定稿說了沒收的那幾條，「立即同步」的提示沒說（第 2 條）。
  test('完成提示也說沒收的敘事線記錄與沒寫上的當前進度', () => {
    const th = (o) => ({ recorded: [], newThreads: [], newForeshadowing: [], dropped: [], unwritten: [], ...o });
    const said = bundle.summarize.describeSynced([
      { calls: 3, threads: th({ recorded: [{}, {}], dropped: [{ what: 'a', why: '證據在正文裡找不到' }], unwritten: ['主线'] }) },
      { calls: 2, threads: th({ dropped: [{ what: 'b', why: '認不出是哪一條線' }] }) },
    ]);
    assert.equal(said, '敘事線：記下 2 個事件；另有 2 條敘事線的記錄沒有收（見日誌）；1 條線的當前進度沒寫上（見日誌）');
  });
});

describe('同步：第一步沒成的章不走後兩步', () => {
  let used;

  before(async () => {
    // 改了第 4、5 章的正文：這兩章待定稿，前三章已經對得上。
    await writeChapters([4, 5]);
    brokenNo = 4;
    fake.reset();
    h.expect('開始同步');
    used = await bundle.summarize.syncSummaries(project);
    brokenNo = undefined;
  });

  test('只有第 5 章走了角色狀態與敘事線', () => {
    assert.deepEqual(stepOrder(STATE_MARK), [5]);
    assert.deepEqual(stepOrder(THREAD_MARK), [5]);
  });

  test('第 4 章掛紅 ❗，細綱沒記指紋', async () => {
    const failures = (await bundle.errorLog.listActiveFailures(project))[CH(4)] ?? [];
    assert.ok(failures.some((f) => f.severity === 'error' && f.op === 'summarize'), JSON.stringify(failures));
    assert.ok(!(await project.readPlot(PLOT(4)))?.sourceHash);
  });

  test('失敗的那一次也算錢：2 次更新細綱 + 第 5 章的 4 次', () => {
    assert.equal(used, 6);
  });

  test('收尾提示說出哪一章細綱沒更新成', () => {
    assert.ok(h.toasts.some((m) => String(m.message ?? m).includes('第 4 章細綱沒更新成')), JSON.stringify(h.toasts));
  });
});
