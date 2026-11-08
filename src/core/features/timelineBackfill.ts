/**
 * 從正文補推、重推故事時間（2026-10-24，設計見 docs/design/plans/2026-10-24-story-timeline.md「二」，同日重做見
 * docs/design/plans/2026-10-24-story-timeline-rework.md「四」）：同步時單獨一次推的是那一章；這裡一批一批補上、重來。
 *
 * ```
 * 第 a–a+4 章（一批，最多 5 章，按字數切）→ 寫 1 次、轉寫 1–2 次（features/storyTime.ts 的 judgeTimes）→ 寫進 threads/时间线.md → 下一批 → ……
 * ```
 *
 * - **補推**（`fill`）：同步過、正文沒再改過、時間線裡還沒有這一行（或還是機器寫的 `+?`〔推不出〕）的章。重做之後**不再要求敘事線
 *   判過**（作者定的第 4 條）：時間和敘事線各算各的，「從正文補記敘事線」也不再順帶推時間。
 * - **重推**（`refresh`）：同步過、正文沒再改過、這一行不是作者寫的章（沒有的、機器寫的），可以只要一段（`range`）。機器寫的行照新推的換，
 *   作者寫的、認不出的一行不動（第 28 條）。v0.2.6 推壞的那些用它重來。
 * - **序列**：後一批要看前一批推出來的「前面幾章的時間」。
 * - **一批沒成就停**（同補記 ⚑10）：已寫的留著，失敗掛在時間線檔案上（第 16 條），再點一次從那一章接著；都成了才清。
 * - 走「定稿」檔（`plotSummary`）的池，同同步；轉寫（2026-10-25 起）走「轉寫」那一檔。不帶思考深度（第 26 條）。開跑前存存檔點。不給外部 agent（⚑8：MCP 的同步本來就推，這兩樣是
 *   工程頁上的維護動作）。
 *
 * 入口：工程頁「敘事線」頁籤「時間線」組——標題旁「補推時間」「重推」、右鍵一章「重推這一章」「從這一章起重推」。
 */
import { getHost } from '../host';
import { CancelledError } from '../llm/provider';
import { ModelPool, createModelPool } from '../llm/pool';
import { NovelProject } from '../model/project';
import { Chapter } from '../model/types';
import { CallEstimate, describeCalls } from '../model/pipeline';
import { describeChapterRuns } from '../model/threadFile';
import { TimelineEntry, TimelineWriteMode, isMachineEntry } from '../model/timelineFile';
import { withCallChoice } from '../runtime/callScope';
import { clearFailures, recordFailure } from '../runtime/errorLog';
import { describeError, elapsed, scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { askCall } from './askCall';
import { checkpointBefore } from './checkpoint';
import { TIME_CHAPTER_CHARS, judgeTimes, timeCallsOf } from './storyTime';
import { poolTranscriber } from './poolIO';
import { TranscribeCall } from './transcribe';

const log = scoped('故事時間');

/** 補推的任務名：前端看它在不在跑（media/src/view/project/threads.ts 一字不差）。 */
export const TIMELINE_BACKFILL_TASK = '從正文補推故事時間';
/** 重推的任務名（同上）。 */
export const TIMELINE_REFRESH_TASK = '重推故事時間';
/** 失敗記錄的 op：補推、重推一批沒成（掛在時間線檔案上）。 */
export const TIMELINE_BACKFILL_OP = 'timelineBackfill';
/** 一批最多幾章（⚑7）。 */
export const TIME_BATCH_CHAPTERS = 5;
/** 一批最多多少字的正文（按章的字數切批；確認框報的次數就按它算）。 */
export const TIME_BATCH_CHARS = 24000;

/** 推哪幾章（零呼叫，{@link planTimeline}）。 */
export interface TimelinePlan {
  mode: TimelineWriteMode;
  /** 要推的章，按章號切好批。 */
  batches: Chapter[][];
  /** 其中時間線裡已經有、會照新推的換掉的機器行（重推）。 */
  replacing: number[];
  /** 時間線裡是作者寫的、這一次不碰的章（重推；認不出的行也算作者的）。 */
  authored: number[];
  /** 時間線裡沒有（或要換）、這一次推不了的章：同步之後正文又改過。 */
  stale: number[];
  calls: CallEstimate;
}

/** 推 `batches` 批：一批寫 1 次、轉寫模型照抄成 JSON 1 次（2026-10-25 起），轉寫不合格重轉 1 次。 */
export function timelineBatchCalls(batches: number): CallEstimate {
  return { low: 2 * batches, high: 2 * batches, max: 3 * batches, why: '每批寫 1 次、轉寫模型照抄成 JSON 1 次；轉寫不合格重轉 1 次' };
}

/** 按章號切批：最多 {@link TIME_BATCH_CHAPTERS} 章、合計不超過 {@link TIME_BATCH_CHARS} 字（一章本身太長的單獨一批）；不連號的地方斷開。 */
export function batchTimeChapters(chapters: readonly Chapter[]): Chapter[][] {
  const batches: Chapter[][] = [];
  let cur: Chapter[] = [];
  let chars = 0;
  for (const c of chapters) {
    const size = Math.min(c.wordCount, TIME_CHAPTER_CHARS);
    const gap = cur.length > 0 && c.order !== cur[cur.length - 1].order + 1;
    if (cur.length > 0 && (gap || cur.length >= TIME_BATCH_CHAPTERS || chars + size > TIME_BATCH_CHARS)) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(c);
    chars += size;
  }
  if (cur.length > 0) {
    batches.push(cur);
  }
  return batches;
}

/**
 * 要推哪幾章。`fill`：沒有這一行、或還是機器寫的 `+?`〔推不出〕；`refresh`：沒有這一行、或是機器寫的（`range` 之內）。都只要同步過、
 * 正文沒再改過的章。同號的正文有兩份時認路徑排序第一份（與補記、總覽同一個口徑）。
 */
export async function planTimeline(
  project: NovelProject,
  mode: TimelineWriteMode,
  range: { from?: number; to?: number } = {}
): Promise<TimelinePlan> {
  const [all, book] = await Promise.all([project.listChapters(), project.readThreads()]);
  const timeline = book.timeline;
  const lines = new Map<number, TimelineEntry>((timeline?.entries ?? []).map((e) => [e.chapter, e]));
  const bad = new Set(timeline?.bad ?? []);
  const byNo = new Map<number, Chapter>();
  for (const c of all) {
    if (!byNo.has(c.order)) {
      byNo.set(c.order, c);
    }
  }
  const fresh: Chapter[] = [];
  const replacing: number[] = [];
  const authored: number[] = [];
  const stale: number[] = [];
  for (const no of [...byNo.keys()].sort((a, b) => a - b)) {
    if ((range.from !== undefined && no < range.from) || (range.to !== undefined && no > range.to)) {
      continue;
    }
    const chapter = byNo.get(no)!;
    const plot = await project.plotOfChapter(chapter);
    if (!plot?.sourceHash) {
      continue;
    }
    const line = lines.get(no);
    let wanted: boolean;
    if (bad.has(no) || (line && !isMachineEntry(line))) {
      wanted = false;
      if (mode === 'refresh') {
        authored.push(no);
      }
    } else if (!line) {
      wanted = true;
    } else {
      wanted = mode === 'refresh' || line.value.kind === 'unknown';
    }
    if (!wanted) {
      continue;
    }
    if (plot.sourceHash !== chapter.contentHash) {
      stale.push(no);
      continue;
    }
    fresh.push(chapter);
    if (line) {
      replacing.push(no);
    }
  }
  const batches = batchTimeChapters(fresh);
  return { mode, batches, replacing: mode === 'refresh' ? replacing : [], authored, stale, calls: timelineBatchCalls(batches.length) };
}

/** {@link runTimeline} 的結果。 */
export interface TimelineRunOutcome {
  calls: number;
  /** 寫進時間線的章（推出來了的、推不出記了 `+?` 的都算）。 */
  written: number[];
  /** 其中推不出的章（記了 `+?`）。 */
  unknown: number[];
  /** 其中正文寫明瞭日子的章。 */
  dated: number[];
  /** 模型漏了的章（這一批裡沒給它的那一項），再點一次會補。 */
  missed: number[];
  /** 停在這一批：呼叫沒成（失敗掛在時間線檔案上）。 */
  failed?: { from: number; reason: string };
  cancelled?: boolean;
  /** 停下時還沒走到的章。 */
  left: number[];
}

/** 按 {@link planTimeline} 的結果一批一批推。**不彈框、不開任務、不拋**（取消單列）：確認與進度條歸呼叫方。 */
export async function runTimeline(
  project: NovelProject,
  plan: TimelinePlan,
  opts: {
    pool: Pick<ModelPool, 'run' | 'primaryBudget'>;
    signal: AbortSignal;
    report: (p: { message?: string; current?: number; total?: number }) => void;
    /** 轉寫那一次怎麼調（2026-10-25 起）。預設走「轉寫」那一檔，那一檔沒有可用的模型時用 `pool`。 */
    transcribe?: TranscribeCall;
  }
): Promise<TimelineRunOutcome> {
  const { signal, report, pool } = opts;
  const transcribe = opts.transcribe ?? poolTranscriber(signal, pool);
  const out: TimelineRunOutcome = { calls: 0, written: [], unknown: [], dated: [], missed: [], left: [] };
  const rel = project.relPath(project.timelinePath);
  const verb = plan.mode === 'refresh' ? '重推' : '補推';
  const total = plan.batches.length;
  for (let i = 0; i < total; i++) {
    const batch = plan.batches[i];
    const rest = () => plan.batches.slice(i).flat().map((c) => c.order);
    if (signal.aborted) {
      out.cancelled = true;
      out.left = rest();
      break;
    }
    const where = describeChapterRuns(batch.map((c) => c.order));
    report({ message: where, current: i, total });
    try {
      // 「前面幾章的時間」按此刻盤上的時間線算：前一批剛寫進去的也算上（judgeTimes 裡讀）。
      const { results, calls } = await judgeTimes(project, batch, {
        run: (what, fn) => pool.run(what, fn),
        budget: pool.primaryBudget,
        signal,
        transcribe,
        mode: plan.mode,
        label: `${verb}時間 · ${where}`,
      });
      out.calls += calls;
      for (const r of results) {
        if (r.missing || !r.entry) {
          out.missed.push(r.chapter);
        } else if (r.action !== 'kept') {
          out.written.push(r.chapter);
          if (r.entry.value.kind === 'unknown' && !r.entry.dateMark) {
            out.unknown.push(r.chapter);
          }
          if (r.entry.dateMark) {
            out.dated.push(r.chapter);
          }
        }
      }
    } catch (err) {
      // 請求發出去了錢就花了：讀不出來的帶著寫與轉寫的實數，別的錯（取消、網路）算寫的那 1 次。
      out.calls += timeCallsOf(err);
      if (err instanceof CancelledError || signal.aborted) {
        out.cancelled = true;
        out.left = rest();
        break;
      }
      // 一批沒成就停：後一批要看這一批的結果，系統性的失敗也不白調後面幾十章。
      const reason = describeError(err);
      out.failed = { from: batch[0].order, reason };
      out.left = rest();
      log.warn(`${verb}故事時間停在${where}：${reason}`, err);
      await recordFailure(project, {
        scope: '叙事线',
        targetKind: 'threads',
        targetKey: rel,
        severity: 'error',
        op: TIMELINE_BACKFILL_OP,
        message: `${verb}故事時間停在第 ${batch[0].order} 章：${reason}`,
        detail: `已經推出來的留在時間線裡。在敘事線頁籤「時間線」組再點一次「${plan.mode === 'refresh' ? '重推' : '補推時間'}」，會從這一章接著推。`,
      });
      break;
    }
  }
  report({ message: '收尾', current: total, total });
  if (!out.failed && !out.cancelled) {
    await clearFailures(project, 'threads', rel, TIMELINE_BACKFILL_OP);
  }
  return out;
}

/**
 * 完成提示（第 2 條：說清楚）：「補推故事時間：推了 12 章（第 1–12 章），其中第 4 章正文寫明瞭日子，第 7、9 章推不出（按緊接上一章算，
 * 可以在時間線組裡改）」，模型漏了的、停在哪、跳過的跟在後面。
 */
export function describeTimelineRun(o: TimelineRunOutcome, plan: Pick<TimelinePlan, 'mode' | 'stale' | 'authored'>): string {
  const verb = plan.mode === 'refresh' ? '重推' : '補推';
  const parts = [
    `${verb}故事時間：${o.written.length > 0 ? `推了 ${o.written.length} 章（${describeChapterRuns(o.written)}）` : '一章都沒寫進去'}`,
    o.dated.length > 0 ? `其中${describeChapterRuns(o.dated)}正文寫明瞭日子，按它對齊` : '',
    o.unknown.length > 0 ? `${describeChapterRuns(o.unknown)}推不出，按緊接上一章算，可以在時間線組裡改` : '',
    o.missed.length > 0 ? `模型漏了${describeChapterRuns(o.missed)}，再點一次補上` : '',
    o.failed
      ? `第 ${o.failed.from} 章那一批沒成（${o.failed.reason}），停在那裡${o.left.length > 0 ? `，${describeChapterRuns(o.left)}沒推` : ''}；再點一次接著推`
      : o.cancelled && o.left.length > 0
        ? `取消了，${describeChapterRuns(o.left)}沒推`
        : '',
    plan.authored.length > 0 ? `${describeChapterRuns(plan.authored)}是你定的，沒動` : '',
    plan.stale.length > 0 ? `${describeChapterRuns(plan.stale)}同步之後正文又改過，沒推（同步時會一起推）` : '',
  ];
  return `${parts.filter(Boolean).join('；')}。`;
}

/** 工程頁「補推時間」：先問一句（章數與次數），再按批序列補推。返回實際呼叫次數。 */
export async function backfillTimeline(project: NovelProject): Promise<number> {
  return timelineAction(project, 'fill');
}

/**
 * 工程頁「重推」（2026-10-24 重做）：`range` 缺席是全部，右鍵一章「重推這一章」是 `{ from: n, to: n }`、「從這一章起重推」是第 n 章到
 * 時間線組裡的最後一章。
 * 先問一句（章數、會換掉幾行、你寫的幾行不動、次數），再按批序列重推。返回實際呼叫次數。
 */
export async function refreshTimeline(project: NovelProject, range: { from?: number; to?: number } = {}): Promise<number> {
  return timelineAction(project, 'refresh', range);
}

async function timelineAction(project: NovelProject, mode: TimelineWriteMode, range: { from?: number; to?: number } = {}): Promise<number> {
  const host = getHost();
  project.invalidate();
  const plan = await planTimeline(project, mode, range);
  const chapters = plan.batches.flat();
  const verb = mode === 'refresh' ? '重推' : '補推';
  const scope =
    range.from === undefined ? '' : range.to === range.from ? `第 ${range.from} 章` : range.to !== undefined ? `第 ${range.from}–${range.to} 章` : `第 ${range.from} 章起`;
  if (chapters.length === 0) {
    const why = [
      plan.authored.length > 0 ? `${describeChapterRuns(plan.authored)}是你定的（機器不動）` : '',
      plan.stale.length > 0 ? `${describeChapterRuns(plan.stale)}同步之後正文又改過（先同步，同步時會一起推）` : '',
    ].filter(Boolean);
    host.toast(
      why.length > 0
        ? `${scope}沒有可以${verb}時間的章：${why.join('；')}。`
        : mode === 'refresh'
          ? `${scope}沒有同步過的章可以重推。`
          : '同步過的章在時間線裡都有了，沒有要補推的。要重來，點「重推」。'
    );
    return 0;
  }
  const where = describeChapterRuns(chapters.map((c) => c.order));
  const rel = project.relPath(project.timelinePath);
  const action = mode === 'refresh' ? '開始重推' : '開始補推';
  const answer = await askCall({
    message:
      mode === 'refresh'
        ? `重推故事時間：${where}，按章號幾章一批重新判每章比上一章晚幾天、章裡跳了幾天、正文寫明的日子，${describeCalls(plan.calls)}。現在重推？`
        : `從正文補推故事時間：${where}同步過，時間線裡還沒有它們（或還推不出）。按章號幾章一批判每章比上一章晚幾天，${describeCalls(plan.calls)}。現在補推？`,
    actions: [action],
    detail: [
      `共 ${chapters.length} 章，分 ${plan.batches.length} 批（一批最多 ${TIME_BATCH_CHAPTERS} 章），按章號一批一批往後推（後一批要看前一批推出來的時間），可以隨時停下，已經推出來的留著；一批沒成就停在那裡，再點一次從那裡接著推。`,
      mode === 'refresh'
        ? `會換掉 ${plan.replacing.length} 行機器寫的（行尾帶〔依據〕〔推測〕〔推不出〕的）${plan.authored.length > 0 ? `；${describeChapterRuns(plan.authored)}是你定的，一個字不動` : ''}。你改過值、卻還留著行尾那一段的行分不出是你改的，也會被換——想保住就刪掉行尾那一段，或者在時間線組裡右鍵「改時間」。開跑前先存一個存檔點。`
        : `只往 ${rel} 裡填空：沒有的寫上，推不出的「+?」重推；你寫的行一個字不動。`,
      '日期按 start 現算，在敘事線頁籤與總覽裡看。',
      plan.stale.length > 0 ? `${describeChapterRuns(plan.stale)}同步之後正文又改過，這一次不推——先同步，同步時會一起推。` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    tasks: ['plotSummary', 'transcribe'],
    // 只送正文、前面幾章的時間與上一章的結尾，不看上下文詳細度。
    contextDetail: false,
  });
  if (answer?.action !== action) {
    log.info(`作者沒有開始${verb}故事時間`);
    return 0;
  }
  return withCallChoice(answer.choice, async () => {
    const pool = await createModelPool({ task: 'plotSummary', concurrent: false });
    if (!pool) {
      log.error(`沒有可用的模型，${verb}故事時間中止`);
      return 0;
    }
    log.info(`開始${verb}故事時間`, `${where}｜${plan.batches.length} 批｜${pool.label}`);
    let calls = 0;
    await runTask(
      mode === 'refresh' ? TIMELINE_REFRESH_TASK : TIMELINE_BACKFILL_TASK,
      async ({ signal, report }) => {
        await checkpointBefore(project, `${verb}故事時間之前（${where}）`);
        const startedAt = Date.now();
        const o = await runTimeline(project, plan, { pool, signal, report });
        calls = o.calls;
        const text = describeTimelineRun(o, plan);
        log.info(`${verb}故事時間結束`, `${text}｜呼叫 ${o.calls} 次，總耗時 ${elapsed(startedAt)}`);
        if (o.cancelled && o.written.length === 0) {
          return;
        }
        host.toast(text, o.failed ? 'error' : 'info');
      },
      { scope: '故事時間' }
    );
    return calls;
  });
}
