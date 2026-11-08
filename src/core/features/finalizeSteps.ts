/**
 * 定稿的後三步：角色狀態、敘事線、故事時間（見 finalize.ts 頂上那張圖的第 2、3、4 步）。單章定稿（`finalizeChapter`）與
 * 工程頁黃條上的「立即同步」（summarize.ts 的 `syncSummaries`）共用這一份。
 *
 * 單放一個檔案是為了 summarize.ts 與 finalize.ts 不互相 import：定稿的第一步就是 summarize.ts 的
 * `summarizeChapter`，而同步更新完細綱之後要接著走這兩步。
 *
 * 兩步的失敗各算各的：細綱已經照正文更新好了，這兩步沒成只掛黃 ❗ 在章節上（第 16 條：部分完成），
 * 角色卡 / 敘事線停在上一次，下次重新定稿會再來一遍。敘事線那一步裡認事件沒成算整步沒成；認出來之後當前進度或歸併
 * 沒成，認出來的照樣記下，黃 ❗ 照樣掛在章節上（說清是哪一段）。取消照樣拋出去。
 *
 * 認事件成了，這一章的敘事線就算判過：推 `project.json` 裡的水位（敘事線重做四期，`recordThreads` 裡的 `noteThreadsJudged`）。
 * 單章定稿、立即同步、寫完即定稿都走這裡，水位在連續時跟著往後推；沒判成的那一章擋在水位前面，「從已寫正文補記」從那裡接著判。
 *
 * 故事時間（2026-10-24 重做）單獨一步、單獨一次（features/storyTime.ts 的 `recordChapterTime`），與敘事線各算各的：認事件沒成不擋它，
 * 它沒成只掛黃 ❗ 在章節上。用敘事線那一個模型（同是「定稿」檔）。
 *
 * 角色狀態與故事時間 2026-10-25 起改成轉寫（按格式寫自然語言，轉寫模型照抄成 JSON），轉寫呼叫由呼叫方給（`transcribe`），幾步共用。
 */
import { CancelledError, LlmProvider } from '../llm/provider';
import { clearFailures, recordFailure } from '../runtime/errorLog';
import { describeError, scoped } from '../runtime/logger';
import { NovelProject } from '../model/project';
import { Chapter, SummaryCast } from '../model/types';
import { STATE_OP, StateUpdateOutcome, stateCallsOf, updateCharacterStates } from './characterState';
import { THREADS_OP, ThreadsFindError, ThreadsOutcome, recordThreads } from './threads';
import { TimeResult, recordChapterTime } from './storyTime';
import { poolTranscriber } from './poolIO';
import { TranscribeCall } from './transcribe';

const log = scoped('同步');

/** 調模型的那一下：單個模型直接調，分檔池帶 fallback。`ModelPool` 本身就長這樣。 */
export interface ModelRunner {
  run<T>(what: string, fn: (llm: LlmProvider) => Promise<T>): Promise<T>;
  readonly primaryBudget: { contextWindow: number; maxOutputTokens: number };
}

export interface StateAndThreadsOutcome {
  /** 這三步實際調了幾次模型（寫 2–5 次：角色狀態 0–1、敘事線 1–3、故事時間 1；加上轉寫的）。 */
  calls: number;
  states?: StateUpdateOutcome;
  /** 角色狀態那一步沒成（細綱照樣算數）。 */
  stateError?: string;
  threads?: ThreadsOutcome;
  /** 敘事線那一步（認事件）沒成（細綱照樣算數）。 */
  threadsError?: string;
  /** 故事時間那一步寫成了什麼樣（模型漏了這一章是 `missing`）。 */
  time?: TimeResult;
  /** 故事時間那一步沒成（時間線沒動）。 */
  timeError?: string;
}

/**
 * 細綱照正文更新好之後：更新本章出場角色的當前狀態，再認這一章在敘事線上發生了什麼（認事件 / 當前進度 / 歸併），最後推這一章的故事時間。
 * `cast` 是第一步交回來的出場人物（定稿後的細綱為準，第 14 條）。
 */
export async function updateStateAndThreads(
  project: NovelProject,
  chapter: Chapter,
  cast: readonly SummaryCast[],
  opts: {
    state: ModelRunner;
    threads: ModelRunner;
    signal?: AbortSignal;
    onStep?(step: 'state' | 'threads' | 'time'): void;
    /** 轉寫那一次怎麼調（2026-10-25 起）。預設走「轉寫」那一檔，那一檔沒有可用的模型時用敘事線那一個。 */
    transcribe?: TranscribeCall;
  }
): Promise<StateAndThreadsOutcome> {
  const outcome: StateAndThreadsOutcome = { calls: 0 };
  const transcribe = opts.transcribe ?? poolTranscriber(opts.signal ?? new AbortController().signal, opts.threads);

  opts.onStep?.('state');
  try {
    outcome.states = await updateCharacterStates(project, chapter, cast, {
      run: (what, fn) => opts.state.run(what, fn),
      budget: opts.state.primaryBudget,
      signal: opts.signal,
      transcribe,
    });
    outcome.calls += outcome.states.calls;
    await clearFailures(project, 'chapter', chapter.relPath, STATE_OP);
  } catch (err) {
    if (err instanceof CancelledError || opts.signal?.aborted) {
      throw err;
    }
    // 請求發出去了錢就花了：失敗也記上（解析失敗、網路錯誤都是發出去之後的事；沒轉成的帶著寫與轉寫的實數）。
    outcome.calls += stateCallsOf(err);
    outcome.stateError = describeError(err);
    log.warn(`第 ${chapter.order} 章的角色狀態沒更新成：${outcome.stateError}`, err);
    await recordFailure(project, {
      scope: '同步',
      targetKind: 'chapter',
      targetKey: chapter.relPath,
      severity: 'warn',
      op: STATE_OP,
      message: `細綱已照正文更新，但角色狀態沒更新成：${outcome.stateError}`,
      detail: '角色卡的當前狀態停在上一次。重新同步這一章會再更新一遍。',
    });
  }

  opts.onStep?.('threads');
  const th = await judgeChapterThreads(project, chapter, opts.threads, { signal: opts.signal, from: 'finalize' });
  outcome.calls += th.calls;
  if (th.threads) {
    outcome.threads = th.threads;
  }
  if (th.threadsError) {
    outcome.threadsError = th.threadsError;
  }

  opts.onStep?.('time');
  const time = await recordChapterTime(project, chapter, opts.threads, { signal: opts.signal, transcribe });
  outcome.calls += time.calls;
  if (time.time) {
    outcome.time = time.time;
  }
  if (time.timeError) {
    outcome.timeError = time.timeError;
  }
  return outcome;
}

/** {@link judgeChapterThreads} 的結果。 */
export interface ThreadsStep {
  /** 實際調了幾次模型（認事件沒成也算那 1 次：請求發出去了；寫了、轉寫沒成的連轉寫那幾次）。 */
  calls: number;
  threads?: ThreadsOutcome;
  /** 認事件沒成（敘事線沒動，這一章沒判過）。 */
  threadsError?: string;
}

/**
 * 敘事線走一章（定稿第三步，寫 1–3 次，2026-10-25 起每次寫完再轉寫 1–2 次）：認事件 → 歸併 → 當前進度（features/threads.ts 的 `recordThreads`）。認出來的落了盤，這一章
 * 就算判過、推水位（四期，在 `recordThreads` 裡）；當前進度、歸併沒成或有幾條線沒寫上，認出來的照樣記下，黃 ❗ 掛在章節上（部分完成）；認事件沒成，敘事線
 * 不動，黃 ❗ 掛在章節上（第 16 條）。整步都成了才清。取消照樣拋出去。
 *
 * 定稿（單章、立即同步、寫完即定稿，`from: 'finalize'`）與從已寫正文補記（`from: 'backfill'`，features/threadsBackfill.ts）共用這一份，
 * `from` 只換失敗的說法：定稿時細綱已經更新好了，補記時細綱本來就在、只差敘事線。
 */
export async function judgeChapterThreads(
  project: NovelProject,
  chapter: Chapter,
  runner: ModelRunner,
  opts: { signal?: AbortSignal; from: 'finalize' | 'backfill' }
): Promise<ThreadsStep> {
  try {
    const th = await recordThreads(project, chapter, {
      run: (what, fn) => runner.run(what, fn),
      budget: runner.primaryBudget,
      signal: opts.signal,
    });
    // 認出來了，但當前進度或歸併那一次沒成、或有幾條線的當前進度沒寫上：認出來的照樣記下了，黃 ❗ 照樣掛在章節上（部分完成）。
    const partial = [
      th.progressError ? `當前進度沒更新成（${th.progressError}）` : '',
      th.unwritten.length > 0 ? `${th.unwritten.length} 條線的當前進度沒寫上（${th.unwritten.join('、')}）` : '',
      th.mergeError ? `歸併沒判成（${th.mergeError}），新認出的照新的建了` : '',
    ].filter(Boolean);
    if (partial.length > 0) {
      await recordFailure(project, {
        scope: opts.from === 'finalize' ? '同步' : '叙事线',
        targetKind: 'chapter',
        targetKey: chapter.relPath,
        severity: 'warn',
        op: THREADS_OP,
        message: `敘事線記下了，但${partial.join('；')}`,
        detail: '重新同步這一章會再來一遍。',
      });
    } else {
      await clearFailures(project, 'chapter', chapter.relPath, THREADS_OP);
    }
    return { calls: th.calls, threads: th };
  } catch (err) {
    if (err instanceof CancelledError || opts.signal?.aborted) {
      throw err;
    }
    const threadsError = describeError(err);
    log.warn(`第 ${chapter.order} 章的敘事線沒認成：${threadsError}`, err);
    await recordFailure(
      project,
      opts.from === 'finalize'
        ? {
            scope: '同步',
            targetKind: 'chapter',
            targetKey: chapter.relPath,
            severity: 'warn',
            op: THREADS_OP,
            message: `細綱已照正文更新，但敘事線沒認成：${threadsError}`,
            detail: '敘事線沒有改動。重新同步這一章會再判一遍。',
          }
        : {
            scope: '叙事线',
            targetKind: 'chapter',
            targetKey: chapter.relPath,
            severity: 'warn',
            op: THREADS_OP,
            message: `從已寫正文補記敘事線沒成：${threadsError}`,
            detail: '敘事線沒有改動，水位停在這一章前面。在敘事線頁籤再點一次「從正文補記」，會從這一章接著判；重新同步這一章也會判。',
          }
    );
    // 請求發出去了錢就花了：認事件沒成也記一次；寫了、轉寫沒成的（2026-10-25 起）連轉寫那幾次照實記。
    return { calls: err instanceof ThreadsFindError ? err.calls : 1, threadsError };
  }
}
