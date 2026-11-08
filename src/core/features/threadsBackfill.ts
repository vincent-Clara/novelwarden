/**
 * 從已寫正文補記敘事線（敘事線重做四期，設計稿「九、補記已經寫了的書」）：拆書匯入的書、「從已寫正文補齊」整理出來的書、
 * 定稿時敘事線沒判成的章——定稿過了，線上卻沒有它們的事件。從 `project.json` 的水位（`threadsThrough`）之後、到最後一個定稿過的
 * 章，**按章號序列**逐章走定稿第三步（認事件 → 歸併 → 當前進度，每章寫 1–3 次、每次寫完轉寫 1 次，`THREADS_JUDGE_CALLS`；
 * finalizeSteps.ts 的 `judgeChapterThreads`）。
 *
 * ```
 * （一條線都沒有、有情節大綱：先排線，排 1 次、轉寫 1 次，沒排成不擋補記）
 * 第 a 章 → 認事件 / 歸併 / 當前進度 → 推水位 → 第 a+1 章 → …… → 定稿到的最後一章
 * ```
 *
 * - **序列**：後一章要看前一章剛記下的事件與新認出的線（同立即同步的後兩步、單獨補記設定）。
 * - **只判定稿過、正文沒再改過的章**（第 4 條：沒定稿、定稿後正文又改過的不偷偷補）：水位之後、定稿到之前這樣的章跳過，確認框裡
 *   列出來（先定稿，定稿時會一併判）；它們擋在水位前面，後面判過的記在 `threadsJudged`，定稿了它們水位就一口氣推過去。
 * - ⚑ **一章沒判成就停**（認事件沒成）：後一章要看前一章，系統性的失敗（模型掛了）也不會把幾十章白調一遍。已判的留著，水位停在
 *   沒判成的那一章前面，失敗掛在那一章上（第 16 條），再點一次從那一章接著判。當前進度、歸併沒成不停（認出來的照樣記下，黃 ❗）。
 * - ⚑ **還沒有一條線、有情節大綱時先排線**（照批次拆細綱「一條線都沒有先排一次」，設計稿 ⚑8）：排線算進同一個確認框（`THREAD_PLAN_CALLS`），
 *   沒排成不擋補記（線照樣能從正文裡認出來，完成提示說一句）。沒有情節大綱就不排：線全靠從正文裡認。
 * - 走「定稿」檔（`plotSummary`）的池，同立即同步、寫完即定稿；排線走「劇情細綱」檔（`plotOutline`）。不帶思考深度（第 26 條）。
 *
 * 入口：工程頁「敘事線」頁籤標題旁的「從正文補記」與右鍵（敘事線落後於定稿時才給）、agent 的 `extract threadsFromText`；
 * 「從已寫正文補齊」（features/derive.ts）在補完架構與情節大綱之後接上它（{@link planThreadsBackfill} + {@link runThreadsBackfill}，
 * 次數並進它的確認框）。
 */
import { getHost } from '../host';
import { CancelledError } from '../llm/provider';
import { ModelPool, createModelPool } from '../llm/pool';
import { NovelProject } from '../model/project';
import { Chapter } from '../model/types';
import { CallEstimate, THREADS_JUDGE_CALLS, describeCalls, threadsBackfillCalls } from '../model/pipeline';
import { isOutlineFilled } from '../model/outlineFile';
import { describeChapterRuns, isThreadsJudged } from '../model/threadFile';
import { withCallChoice } from '../runtime/callScope';
import { elapsed, scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { askCall } from './askCall';
import { checkpointBefore } from './checkpoint';
import { judgeChapterThreads } from './finalizeSteps';
import { PlanThreadsOutcome, ThreadsOutcome, describePlanned, planThreadsFromOutline } from './threads';

const log = scoped('叙事线');

/** 補記的任務名：前端看它在不在跑（media/src/view/project/threads.ts 一字不差）。 */
export const BACKFILL_TASK = '從已寫正文補記敘事線';

/** 補記要判哪幾章（零呼叫，{@link planThreadsBackfill}）。 */
export interface ThreadsBackfillPlan {
  /** 要判的章：水位之後、定稿到之前，定稿過、正文沒再改過、還沒判過的，按章號。 */
  chapters: Chapter[];
  /** 水位之後、定稿到之前，這一次判不了的章（沒定稿、定稿之後正文又改過），按章號。 */
  skipped: { no: number; why: string }[];
  /** 一條線都沒有、有（或這一次會有）情節大綱：先排線（加 `THREAD_PLAN_CALLS`）。 */
  planFirst: boolean;
  /** 開始之前的水位。 */
  through: number;
  /** 定稿到的最後一章。 */
  current: number;
  calls: CallEstimate;
}

/**
 * 補記要判哪幾章。一條線都沒有、有情節大綱（各章細綱梗概的彙總）時先排線。
 * `upTo`：只看到第幾章為止（補齊只管第 1–N 章）。同號的正文有兩份時認路徑排序第一份（與流水線、總覽同一個口徑）。
 */
export async function planThreadsBackfill(
  project: NovelProject,
  opts: { upTo?: number } = {}
): Promise<ThreadsBackfillPlan> {
  const [all, mark, book] = await Promise.all([project.listChapters(), project.readThreadsMark(), project.readThreads()]);
  const byNo = new Map<number, Chapter>();
  for (const c of all) {
    if (!byNo.has(c.order)) {
      byNo.set(c.order, c);
    }
  }
  const nos = [...byNo.keys()].filter((no) => opts.upTo === undefined || no <= opts.upTo).sort((a, b) => a - b);
  const fresh: Chapter[] = [];
  const stale: number[] = [];
  const unfinalized: number[] = [];
  let current = 0;
  for (const no of nos) {
    const chapter = byNo.get(no)!;
    const plot = await project.plotOfChapter(chapter);
    if (!plot?.sourceHash) {
      if (chapter.wordCount > 0) {
        unfinalized.push(no);
      }
      continue;
    }
    current = no;
    if (isThreadsJudged(mark, no)) {
      continue;
    }
    if (plot.sourceHash === chapter.contentHash) {
      fresh.push(chapter);
    } else {
      stale.push(no);
    }
  }
  const skipped = [
    ...stale.map((no) => ({ no, why: '同步之後正文又改過' })),
    // 沒定稿的只說水位之後、定稿到之前的：定稿到之後的是還沒走到定稿那一步，不歸補記管。
    ...unfinalized.filter((no) => no > mark.through && no < current).map((no) => ({ no, why: '還沒同步' })),
  ].sort((a, b) => a.no - b.no);
  const outlineReady = isOutlineFilled(await project.readOutline());
  const planFirst = fresh.length > 0 && book.threads.length === 0 && outlineReady;
  return { chapters: fresh, skipped, planFirst, through: mark.through, current, calls: threadsBackfillCalls(fresh.length, planFirst) };
}

/** {@link runThreadsBackfill} 的結果。 */
export interface ThreadsBackfillOutcome {
  /** 實際調了幾次模型（含先排線那一次）。 */
  calls: number;
  /** 判過的章，按章號。 */
  judged: number[];
  /** 判過的那幾章各自認出了什麼（與 `judged` 一一對應）。 */
  results: ThreadsOutcome[];
  /** 先排線的結果（沒排就缺席）。 */
  planned?: PlanThreadsOutcome;
  /** 停在這一章：認事件沒成（失敗掛在那一章上）。 */
  failed?: { no: number; reason: string };
  /** 停下時還沒走到的章（沒判成的那一章之後的、取消時剩下的）。 */
  left: number[];
  cancelled?: boolean;
  /** 認出來了、當前進度或歸併沒成的章（掛了黃 ❗）。 */
  partial: number[];
  /** 跑完之後的水位。 */
  through: number;
}

/**
 * 按 {@link planThreadsBackfill} 的結果補記。**不彈框、不開任務、不拋**（取消單列）：確認與進度條歸呼叫方。`pool` 判事件
 * （「定稿」檔），`planPool` 先排線（「劇情細綱」檔，缺席用 `pool`）。
 */
export async function runThreadsBackfill(
  project: NovelProject,
  plan: ThreadsBackfillPlan,
  opts: {
    pool: Pick<ModelPool, 'run' | 'primaryBudget'>;
    planPool?: Pick<ModelPool, 'run' | 'primaryBudget'>;
    signal: AbortSignal;
    report: (p: { message?: string; current?: number; total?: number }) => void;
  }
): Promise<ThreadsBackfillOutcome> {
  const { signal, report } = opts;
  const out: ThreadsBackfillOutcome = { calls: 0, judged: [], results: [], left: [], partial: [], through: plan.through };
  const total = plan.chapters.length;
  if (plan.planFirst) {
    // 一條線都沒有：先從情節大綱排一次（沒排成不擋補記，失敗掛在敘事線目錄上，完成提示裡說一句）。
    report({ message: '先從情節大綱排敘事線', current: 0, total });
    const planned = await planThreadsFromOutline(project, opts.planPool ?? opts.pool, signal);
    out.calls += planned.calls;
    out.planned = planned;
    if (planned.cancelled) {
      out.cancelled = true;
      out.left = plan.chapters.map((c) => c.order);
      return out;
    }
  }
  for (let i = 0; i < total; i++) {
    const chapter = plan.chapters[i];
    if (signal.aborted) {
      out.cancelled = true;
      out.left = plan.chapters.slice(i).map((c) => c.order);
      break;
    }
    report({ message: `第 ${chapter.order} 章《${chapter.title}》`, current: i, total });
    try {
      const step = await judgeChapterThreads(project, chapter, opts.pool, { signal, from: 'backfill' });
      out.calls += step.calls;
      if (step.threadsError || !step.threads) {
        // 一章沒判成就停（⚑）：後一章要看前一章，系統性的失敗也不白調後面幾十章。失敗已經掛在這一章上。
        out.failed = { no: chapter.order, reason: step.threadsError ?? '沒有結果' };
        out.left = plan.chapters.slice(i + 1).map((c) => c.order);
        break;
      }
      out.judged.push(chapter.order);
      out.results.push(step.threads);
      const th = step.threads;
      if (th.progressError || th.mergeError || th.unwritten.length > 0) {
        out.partial.push(chapter.order);
      }
    } catch (err) {
      if (err instanceof CancelledError || signal.aborted) {
        out.cancelled = true;
        out.left = plan.chapters.slice(i).map((c) => c.order);
        break;
      }
      throw err;
    }
  }
  report({ message: '收尾', current: total, total });
  out.through = (await project.readThreadsMark()).through;
  return out;
}

/**
 * 補記的完成提示（第 2 條：說清楚）：「敘事線補記：判了 5 章（第 1–5 章），記下 12 個事件，新認出 2 條線、3 條伏筆；敘事線判到第
 * 5 章」，先排線的、沒判成停在哪一章、後面幾章沒判、跳過的、沒收的記錄、沒寫上的當前進度跟在後面。
 */
export function describeBackfill(o: ThreadsBackfillOutcome, plan: Pick<ThreadsBackfillPlan, 'skipped' | 'current'>, rel: string): string {
  const sum = (f: (r: ThreadsOutcome) => number): number => o.results.reduce((n, r) => n + f(r), 0);
  const events = sum((r) => r.recorded.length);
  const lines = sum((r) => r.newThreads.length);
  const fores = sum((r) => r.newForeshadowing.length);
  const dropped = sum((r) => r.dropped.length);
  const unwritten = sum((r) => r.unwritten.length);
  const found = [lines > 0 ? `${lines} 條線` : '', fores > 0 ? `${fores} 條伏筆` : ''].filter(Boolean).join('、');
  const head =
    o.judged.length > 0
      ? `判了 ${o.judged.length} 章（${describeChapterRuns(o.judged)}），${events > 0 ? `記下 ${events} 個事件` : '沒有記下事件'}${found ? `，新認出 ${found}` : ''}`
      : '一章都沒判';
  const planned = o.planned
    ? o.planned.error
      ? `先從情節大綱排線沒排成（${o.planned.error}）`
      : o.planned.cancelled
        ? ''
        : `先從情節大綱${describePlanned(o.planned, rel).replace(/。$/, '')}`
    : '';
  const stop = o.failed
    ? `第 ${o.failed.no} 章沒判成（${o.failed.reason}），停在那裡${o.left.length > 0 ? `，後面 ${o.left.length} 章沒判` : ''}；再點一次「從正文補記」從第 ${o.failed.no} 章接著判`
    : o.cancelled && o.left.length > 0
      ? `取消了，${describeChapterRuns(o.left)}沒判`
      : '';
  const parts = [
    planned,
    `敘事線補記：${head}`,
    stop,
    plan.skipped.length > 0 ? `${describeChapterRuns(plan.skipped.map((s) => s.no))}沒判（${[...new Set(plan.skipped.map((s) => s.why))].join('、')}；先同步，同步時會一併判）` : '',
    o.partial.length > 0 ? `${describeChapterRuns(o.partial)}的當前進度或歸併沒成（掛了黃 ❗）` : '',
    dropped > 0 ? `另有 ${dropped} 條敘事線的記錄沒有收（見日誌）` : '',
    unwritten > 0 ? `${unwritten} 條線的當前進度沒寫上（見日誌）` : '',
    o.through >= plan.current ? `敘事線判到第 ${o.through} 章，跟上了同步進度` : `敘事線判到第 ${o.through} 章（同步到第 ${plan.current} 章）`,
  ];
  return `${parts.filter(Boolean).join('；')}。`;
}

/**
 * 工程頁「從正文補記」與 agent 的 `extract threadsFromText`：先問一句（章數與次數），再按章序列補記。返回實際呼叫次數（取消、沒有
 * 要補的章時是 0）。
 */
export async function backfillThreads(project: NovelProject): Promise<number> {
  const host = getHost();
  project.invalidate();
  const plan = await planThreadsBackfill(project);
  if (plan.chapters.length === 0) {
    host.toast(
      plan.skipped.length > 0
        ? `沒有可以補記的章：${describeChapterRuns(plan.skipped.map((s) => s.no))}${[...new Set(plan.skipped.map((s) => s.why))].join('或')}——先同步，同步時會一併判敘事線。`
        : plan.current === 0
          ? '還沒有同步過的章：敘事線是同步時判的，先同步。'
          : `敘事線已經判到第 ${plan.through} 章、跟上了同步進度，沒有要補記的。要重判哪一章，重新同步那一章。`
    );
    return 0;
  }
  const n = plan.chapters.length;
  const where = describeChapterRuns(plan.chapters.map((c) => c.order));
  const rel = project.relPath(project.threadsDir);
  const answer = await askCall({
    message:
      `從已寫正文補記敘事線：${where}同步過、敘事線還沒判，逐章認這一章在敘事線上發生了什麼（每章 ${THREADS_JUDGE_CALLS.low}–${THREADS_JUDGE_CALLS.high} 次）` +
      `${plan.planFirst ? '；還沒有一條敘事線，先從情節大綱排一次（排 1 次、轉寫 1 次）' : ''}，${describeCalls(plan.calls)}。現在補記？`,
    actions: ['開始補記'],
    detail: [
      `共 ${n} 章，按章號一章一章往後判（後一章要看前一章記下的事件與新認出的線），可以隨時停下，已經判過的留著；一章沒判成就停在那裡，再點一次從那一章接著判。`,
      `每章：${THREADS_JUDGE_CALLS.why}。只往 ${rel}/ 裡追加帶原文證據的事件、正文裡認出的新線與新伏筆；當前進度由機器維護，你改過的不寫；已有的一個字不動。`,
      plan.planFirst ? '還沒有一條敘事線：先從情節大綱排一次（排 1 次、轉寫 1 次，算在上面的數裡；沒排成不擋補記，線照樣能從正文裡認出來）。' : '',
      plan.skipped.length > 0
        ? `${plan.skipped.map((s) => `第 ${s.no} 章${s.why}`).slice(0, 8).join('、')}${plan.skipped.length > 8 ? ` 等 ${plan.skipped.length} 章` : ''}，這一次不判——先同步，同步時會一併判。`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
    tasks: plan.planFirst ? ['plotOutline', 'plotSummary', 'transcribe'] : ['plotSummary', 'transcribe'],
    // 認事件帶幾條線、幾條伏筆隨詳細度（`recordThreads`）。
    contextDetail: true,
  });
  if (answer?.action !== '開始補記') {
    log.info('作者沒有開始從已寫正文補記敘事線');
    return 0;
  }
  return withCallChoice(answer.choice, async () => {
    const pool = await createModelPool({ task: 'plotSummary', concurrent: false });
    if (!pool) {
      log.error('沒有可用的模型，從已寫正文補記敘事線中止');
      return 0;
    }
    const planPool = plan.planFirst ? ((await createModelPool({ task: 'plotOutline', concurrent: false })) ?? pool) : undefined;
    log.info('開始從已寫正文補記敘事線', `${where}｜${pool.label}`);
    let calls = 0;
    await runTask(
      BACKFILL_TASK,
      async ({ signal, report }) => {
        // 先存一個存檔點（features/checkpoint.ts）：逐章往各條線裡追加事件、改寫當前進度，整本退得回去。
        await checkpointBefore(project, `從正文補記敘事線之前（${where}）`);
        const startedAt = Date.now();
        const o = await runThreadsBackfill(project, plan, { pool, planPool, signal, report });
        calls = o.calls;
        const text = describeBackfill(o, plan, rel);
        log.info('從已寫正文補記敘事線結束', `${text}｜呼叫 ${o.calls} 次，總耗時 ${elapsed(startedAt)}`);
        if (o.cancelled && o.judged.length === 0) {
          return;
        }
        host.toast(text, o.failed ? 'error' : 'info');
      },
      { scope: '叙事线' }
    );
    return calls;
  });
}
