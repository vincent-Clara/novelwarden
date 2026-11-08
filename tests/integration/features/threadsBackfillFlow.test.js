/**
 * ★ 敘事線重做四期驗收（設計稿「實施：逐期提交清單」四期第 4 個提交）。一本已經寫了 5 章、都定稿過、一條敘事線都沒有的書
 * （拆書匯入再補齊整理出來的、0.2.4 以前「立即同步」過的書都是這個樣子），經 controller 一路點下來（與工程頁那幾顆按鈕發的
 * 訊息一樣），假模型按指令碼應答：
 *
 *   工程頁「⚠ 第 1–5 章還沒判」→ 從正文補記（先排線 + 逐章認事件）→ 水位到第 5 章、不再提示 → 寫第 6 章、單章定稿 → 水位到第 6 章
 *   另一本：補記到第 3 章沒判成 → 水位停在第 2 章、失敗掛在第 3 章上、工程頁說「第 3–5 章還沒判」
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 補記之前：工程頁說「⚠ 第 1–5 章還沒判」、判到第 0 章；總覽上五列都標「還沒判」 | 定稿了、敘事線沒判的章看得出來 |
 * | 補記：確認框寫明章數與次數（排線 2 次 + 每章 2–6 次，含轉寫）；線檔案裡有帶證據的實際事件；水位到第 5 章；工程頁不再提示落後、總覽不再標 | 設計稿「九」；第 4 條 |
 * | 實際呼叫次數不超過確認框報的上限 | 第 4 條 |
 * | 再寫一章、單章定稿：水位推到第 6 章 | 定稿在連續時推水位 |
 * | 中途一章沒判成：已判的留著，水位停在它前面，失敗掛在那一章上（第 16 條），工程頁說剩下的幾章還沒判 | ⚑ 一章沒判成就停 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, TIME_MARK, timeReply } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');
const { outlineOf, writeOutline } = require('../../helpers/outline');

let bundle;
let h;
let fake;
const books = [];

const TITLES = ['停舟', '令牌', '夜訪', '井', '名冊', '渡口'];
const pad3 = (n) => String(n).padStart(3, '0');
const CH = (no) => `chapters/${pad3(no)}-${TITLES[no - 1]}.md`;
const PLOT = (no) => `.novelwarden/summaries/${pad3(no)}-${TITLES[no - 1]}.md`;
const THREADS = '.novelwarden/threads';
const MAIN = `${THREADS}/青崖舊案.md`;
const text = (no) => `# ${TITLES[no - 1]}\n\n林昭在第${no}章摸了摸懷裡的玉佩。\n\n沈氏在第${no}章翻開名冊，手指停在第${no}行。\n`;

/** 認事件那一次第幾章答壞（解析不出）。 */
let broken = new Set();

function reply(messages) {
  const system = messages[0]?.content ?? '';
  const user = messages[messages.length - 1].content;
  if (system.includes('只從作者給的小說配置、故事前提、角色圖譜與情節大綱裡排出這本書的敘事線')) {
    return JSON.stringify({
      threads: [
        {
          title: '青崖舊案',
          kind: '主线',
          from: 1,
          to: 30,
          intent: '查清七年前那場火。',
          foreshadowing: [{ title: '玉佩的來歷', what: '玉佩是沈家舊物', plant: 1, resolve: 20 }],
        },
      ],
    });
  }
  const no = Number(/【第(\d+)章/.exec(user)?.[1] ?? 0);
  if (system.includes('建立可檢索的章節檔案')) {
    return JSON.stringify({
      梗概: `第 ${no} 章。`,
      出场人物: [{ name: '林昭', aliases: [] }, { name: '沈氏', aliases: [] }],
      时间地点: '青崖鎮。',
      关键事件: [`第 ${no} 章的事`],
      状态变更: '',
      连续性事实: [],
    });
  }
  if (system.includes('你是小說定稿事實審查員')) {
    if (broken.has(no)) {
      return '這一章沒什麼好說的。';
    }
    return JSON.stringify({
      events: [
        { line: '青崖舊案', type: '推进', what: `林昭第 ${no} 章又往前查`, evidence: `林昭在第${no}章摸了摸懷裡的玉佩。` },
        ...(no === 1 ? [{ line: '青崖舊案', type: '埋', foreshadowing: '玉佩的來歷', what: '玉佩第一次露面', evidence: '林昭在第1章摸了摸懷裡的玉佩' }] : []),
      ],
      newThreads: no === 2 ? [{ title: '名冊之謎', kind: '支线', intent: '名冊上少了一頁。', evidence: '沈氏在第2章翻開名冊，手指停在第2行。' }] : [],
      newForeshadowing: [],
    });
  }
  if (system.includes('判斷它們是不是已有的某一條換了個說法')) {
    return JSON.stringify({ merges: [] });
  }
  if (system.includes('給每一條寫一兩句「當前進度」')) {
    const lines = [...user.matchAll(/^【線】(.+)$/gm)].map((m) => m[1]);
    return JSON.stringify({ progress: lines.map((line) => ({ line, text: `第 ${no} 章：${line}走到了這裡。` })) });
  }
  // 故事時間（同步時單獨一次，2026-10-24 重做）：都緊接上一章。
  if ((messages[0]?.content ?? '').includes(TIME_MARK)) {
    return timeReply(messages);
  }
  return '（認不出這一步）';
}

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    controller: './src/core/controller/index.ts',
    pipelineModel: './src/core/model/pipeline.ts',
    threadFile: './src/core/model/threadFile.ts',
    projectView: './src/core/views/projectView.ts',
    threads: './src/core/views/threads.ts',
    errorLog: './src/core/runtime/errorLog.ts',
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
});

after(() => {
  for (const b of books) {
    b.controller.dispose();
    cleanup(b.t.dir, bundle?.db);
  }
});

/** 一本寫了第 1–5 章、都定稿過（細綱的 sourceHash 對得上正文）、有情節大綱、一條敘事線都沒有的書。 */
async function writtenBook(prefix) {
  const t = await makeTempProject(bundle.project, { prefix, title: '青崖記' });
  const project = t.project;
  writeOutline(t, outlineOf(20, { text: { 1: '林昭回鎮，一路查名冊與玉佩。' } }));
  for (let no = 1; no <= 5; no++) {
    t.write(CH(no), text(no));
  }
  project.invalidate();
  const chapters = await project.listChapters();
  for (let no = 1; no <= 5; no++) {
    const hash = chapters.find((c) => c.order === no).contentHash;
    t.write(
      PLOT(no),
      `---\nno: ${no}\ntitle: ${TITLES[no - 1]}\nsourceHash: ${hash}\ncast: [林昭, 沈氏]\n---\n\n# ${TITLES[no - 1]}\n\n## 梗概\n第 ${no} 章。\n\n## 出場人物\n林昭、沈氏\n`
    );
  }
  project.invalidate();
  const controller = new bundle.controller.ChatController(project);
  controller.attach({ kind: 'sidebar', post: () => {}, reveal() {} });
  const book = { t, project, controller };
  books.push(book);
  return book;
}

const treeOf = async (project) => {
  project.invalidate();
  return bundle.projectView.buildProjectTree(project);
};
const actualOf = (t, rel) =>
  bundle.threadFile
    .parseThreadFile(t.read(rel), rel)
    .events.filter((e) => !e.planned)
    .map((e) => [e.chapter, e.type, e.foreshadowing ?? '', e.evidence ?? '']);

describe('敘事線重做四期驗收：一本已寫 5 章、沒有任何線的書——補記，再寫一章、單章定稿', () => {
  let book;
  let lagBefore;
  let overviewBefore;
  let confirm;
  let backfillCalls;

  before(async () => {
    book = await writtenBook('threads-phase4');
    const tree = await treeOf(book.project);
    lagBefore = { lag: tree.threads.lag, through: tree.threads.through, current: tree.threads.current };
    overviewBefore = await bundle.threads.buildThreadsOverview(book.project);
    broken = new Set();
    fake.reset();
    // 工程頁「從正文補記」：後端先彈確認框，作者點「開始補記」。
    h.expect('開始補記');
    await book.controller.handle({ type: 'projectAction', action: 'backfillThreads' });
    confirm = h.confirms.at(-1);
    backfillCalls = fake.callCount();
  });

  test('補記之前：工程頁說「第 1–5 章還沒判」、敘事線判到第 0 章；總覽五列都標「還沒判」', () => {
    assert.deepEqual(lagBefore, { lag: { count: 5, text: '第 1–5 章還沒判' }, through: 0, current: 5 });
    assert.equal(overviewBefore.through, 0);
    assert.deepEqual(overviewBefore.chapters.slice(0, 5).map((c) => [c.no, c.state, c.unjudged ?? false]), [1, 2, 3, 4, 5].map((no) => [no, 'finalized', true]));
    // 第 6–20 章是大綱排到了、只有梗概的空殼（大綱是各章細綱梗概的彙總）：計劃中，不算「還沒判」。
    assert.ok(overviewBefore.chapters.slice(5).every((c) => c.state === 'planned' && !c.unjudged), JSON.stringify(overviewBefore.chapters.slice(5)));
  });

  // 2026-10-25 起含轉寫：排線 2 次（最多 3）+ 5 章 × 2–6 次（最多 9）。
  test('確認框寫明章數與次數：先排線 2 次 + 5 章 × 2–6 次', () => {
    assert.match(confirm.message, /^從已寫正文補記敘事線：第 1–5 章同步過、敘事線還沒判/);
    assert.ok(
      confirm.message.includes('先從情節大綱排一次（排 1 次、轉寫 1 次）') && confirm.message.includes('預計 12–32 次呼叫，最多 48 次'),
      confirm.message
    );
    assert.deepEqual(confirm.actions, ['開始補記']);
  });

  test('線檔案裡有帶證據的實際事件：排出來的主線每章一條推進、第 1 章埋下玉佩；正文裡長出來的線也建了', () => {
    assert.deepEqual(actualOf(book.t, MAIN), [
      [1, '推进', '', '林昭在第1章摸了摸懷裡的玉佩。'],
      [1, '埋', '玉佩的來歷', '林昭在第1章摸了摸懷裡的玉佩'],
      [2, '推进', '', '林昭在第2章摸了摸懷裡的玉佩。'],
      [3, '推进', '', '林昭在第3章摸了摸懷裡的玉佩。'],
      [4, '推进', '', '林昭在第4章摸了摸懷裡的玉佩。'],
      [5, '推进', '', '林昭在第5章摸了摸懷裡的玉佩。'],
    ]);
    const main = bundle.threadFile.parseThreadFile(book.t.read(MAIN), MAIN);
    assert.equal(main.progressThrough, 5);
    const grown = bundle.threadFile.parseThreadFile(book.t.read(`${THREADS}/名冊之謎.md`), `${THREADS}/名冊之謎.md`);
    assert.equal(grown.origin, '正文');
    assert.deepEqual(grown.events.map((e) => e.chapter), [2]);
  });

  test('水位到第 5 章；工程頁不再提示落後，線按第 5 章算；總覽不再標「還沒判」', async () => {
    assert.deepEqual(await book.project.readThreadsMark(), { through: 5, judged: [] });
    assert.equal((await book.project.readManifest()).threadsThrough, 5);
    const tree = await treeOf(book.project);
    assert.equal(tree.threads.through, 5);
    assert.equal(tree.threads.lag, undefined);
    assert.equal(tree.threads.lines.find((l) => l.name === '青崖舊案').detail, '主線 · 進行中 · 最近第 5 章 · 1 條伏筆沒收');
    const overview = await bundle.threads.buildThreadsOverview(book.project);
    assert.equal(overview.through, 5);
    assert.ok(overview.chapters.every((c) => !c.unjudged), JSON.stringify(overview.chapters));
  });

  test('完成提示說清判了幾章、記了多少事件、新認出幾條線；跟上了定稿', () => {
    const toast = h.toasts.at(-1);
    assert.ok(toast.includes('敘事線補記：判了 5 章（第 1–5 章），記下 7 個事件，新認出 1 條線'), toast);
    assert.ok(toast.includes('敘事線判到第 5 章，跟上了同步'), toast);
  });

  test('實際呼叫次數不超過確認框報的上限', () => {
    const plan = bundle.pipelineModel.threadsBackfillCalls(5, true);
    assert.ok(backfillCalls <= plan.max, `${backfillCalls} > ${plan.max}`);
    // 排線 1；第 1 章認事件 + 當前進度；第 2 章認事件 + 歸併 + 當前進度；第 3–5 章各認事件 + 當前進度。
    assert.equal(backfillCalls, 1 + 2 + 3 + 3 * 2);
  });

  test('再寫一章、單章定稿：水位推到第 6 章，工程頁照樣不落後', async () => {
    book.t.write(CH(6), text(6));
    book.project.invalidate();
    h.expect();
    await book.controller.handle({ type: 'projectAction', action: 'finalizeChapter', relPath: CH(6) });
    assert.ok(h.toasts.some((x) => x.includes('第 6 章已同步')), h.toasts.join('|'));
    assert.deepEqual(await book.project.readThreadsMark(), { through: 6, judged: [] });
    assert.ok(actualOf(book.t, MAIN).some(([no, type]) => no === 6 && type === '推进'));
    const tree = await treeOf(book.project);
    assert.equal(tree.threads.current, 6);
    assert.equal(tree.threads.through, 6);
    assert.equal(tree.threads.lag, undefined);
  });
});

describe('敘事線重做四期驗收：補記到第 3 章沒判成——水位停在它前面', () => {
  let book;

  before(async () => {
    book = await writtenBook('threads-phase4-stop');
    broken = new Set([3]);
    fake.reset();
    h.expect('開始補記');
    await book.controller.handle({ type: 'projectAction', action: 'backfillThreads' });
  });

  test('已判的第 1、2 章留著，第 3 章起沒記；水位停在第 2 章', async () => {
    assert.deepEqual(
      actualOf(book.t, MAIN).map(([no]) => no),
      [1, 1, 2]
    );
    assert.deepEqual(await book.project.readThreadsMark(), { through: 2, judged: [] });
  });

  test('失敗掛在第 3 章上（第 16 條）；工程頁說「第 3–5 章還沒判」，提示說停在第 3 章', async () => {
    const failures = await bundle.errorLog.listActiveFailures(book.project);
    assert.ok((failures[CH(3)] ?? []).some((f) => f.op === 'threads' && f.severity === 'warn'), JSON.stringify(failures));
    const tree = await treeOf(book.project);
    assert.deepEqual(tree.threads.lag, { count: 3, text: '第 3–5 章還沒判' });
    assert.equal(tree.threads.through, 2);
    const toast = h.toasts.at(-1);
    assert.ok(toast.startsWith('error: ') && toast.includes('第 3 章沒判成') && toast.includes('敘事線判到第 2 章（同步到第 5 章）'), toast);
  });

  test('第 3 章單章重新定稿判成了：水位一章一章推到第 3 章（第 4、5 章仍待補記）', async () => {
    broken = new Set();
    h.expect();
    await book.controller.handle({ type: 'projectAction', action: 'finalizeChapter', relPath: CH(3) });
    assert.deepEqual(await book.project.readThreadsMark(), { through: 3, judged: [] });
    const tree = await treeOf(book.project);
    assert.deepEqual(tree.threads.lag, { count: 2, text: '第 4–5 章還沒判' });
    const failures = await bundle.errorLog.listActiveFailures(book.project);
    assert.equal(failures[CH(3)], undefined);
  });
});
