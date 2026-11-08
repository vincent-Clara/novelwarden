/**
 * 認時間（2026-10-24 重做，設計見 docs/design/plans/2026-10-24-story-timeline-rework.md「三」）：同步一章時單獨一次（{@link recordChapterTime}），
 * 補推、重推幾章一批（features/timelineBackfill.ts），都走 {@link judgeTimes}——同一份提示詞（`TIME_SYSTEM`）、同一份輸入。
 *
 * ```
 * 曆法與起點 + 前面幾章的時間（帶結尾時段）+ 上一章的結尾約 1000 字 + 這一章（幾章）的正文（太長截中間）+ 細綱記的時間地點
 *   ──▶ 寫 1 次（一章一節自然語言）──▶ 轉寫 1–2 次（2026-10-25 起）──▶ times[]：開頭晚幾天、章內幾跳、結尾時段、正文寫明的日子與季節
 *   ──▶ verifyTime（證據逐字）──▶ 寫進 threads/时间线.md（同步、重推 refresh：機器寫的行照新推的換；補推 fill：只填空；作者的行都不動）
 * ```
 *
 * - **和敘事線各算各的**：上一稿並在認事件那一次裡，作者用下來推得不準（模型看不到上一章停在哪個時刻、正文寫明的日子不收）。
 *   現在認事件沒成不擋它，它沒成也不擋敘事線：失敗掛黃 ❗ 在章節上（op {@link TIME_OP}，第 16 條），細綱、敘事線照樣算數。
 * - 走「定稿」檔，同敘事線那一步。不帶思考深度（第 26 條）。
 */
import { CancelledError, StreamOptions } from '../llm/provider';
import { collectText } from '../llm/collect';
import { readConfig } from '../config';
import { NovelProject } from '../model/project';
import { Chapter } from '../model/types';
import {
  Timeline,
  TimelineEntry,
  TimelineWrite,
  TimelineWriteMode,
  describeTimeEntry,
  emptyTimeline,
  isMachineEntry,
  recentTimeNote,
  upsertTimelineEntry,
  verifyTime,
} from '../model/timelineFile';
import { estimateTokens, tokensToChars } from '../context/tokenizer';
import { clearFailures, recordFailure } from '../runtime/errorLog';
import { describeError, scoped } from '../runtime/logger';
import { Workspace } from '../workspace';
import type { ModelRunner } from './finalizeSteps';
import type { StepOpts } from './threads';
import { extractJsonObject, stripCodeFence, stripTrailingCommas } from './parse';
import { TIME_JSON_CONTRACT, TIME_SYSTEM } from './timePrompt';
import { TranscribeCall, TranscribeSpec, transcribeJson } from './transcribe';
import { poolTranscriber } from './poolIO';

const log = scoped('故事時間');

/** 失敗記錄的 op：同步時這一章的時間沒推成（掛在章節上，黃 ❗）。 */
export const TIME_OP = 'timeline';
/** 上一章的結尾送多少字（本章開頭接著哪個時刻，看這裡）。 */
export const TIME_PREV_TAIL_CHARS = 1000;
/** 一章最多送多少字：太長的截中間、留頭尾（⚑6：時間的線索在開頭和結尾）。 */
export const TIME_CHAPTER_CHARS = 12000;
/** 截中間時開頭留幾成。 */
const HEAD_SHARE = 2 / 3;

/** 截中間、留頭尾：`max` 個字以內原樣，超了留前 2/3、後 1/3，中間說一句略去了多少字。 */
export function clipMiddle(text: string, max: number = TIME_CHAPTER_CHARS): string {
  const chars = [...text];
  if (chars.length <= max) {
    return text;
  }
  const head = Math.max(1, Math.round(max * HEAD_SHARE));
  const tail = Math.max(1, max - head);
  return `${chars.slice(0, head).join('').trimEnd()}\n\n……（中間略去 ${chars.length - head - tail} 字）……\n\n${chars.slice(-tail).join('').trimStart()}`;
}

/** 一段文字最後 `max` 個字，儘量從段落開頭起。 */
function tailOf(text: string, max: number): string {
  const chars = [...text.trim()];
  if (chars.length <= max) {
    return chars.join('');
  }
  const slice = chars.slice(-max).join('');
  const br = slice.indexOf('\n');
  return (br >= 0 && br < slice.length * 0.3 ? slice.slice(br + 1) : slice).trimStart();
}

/** 曆法與起點那一句。 */
function calendarNote(tl: Timeline): string {
  const cal = tl.calendar === '简单历' ? '簡單歷（每月 30 天、一年 12 個月）' : '公曆（真實的月份長短與閏年）';
  return `${cal}；${tl.start ? `第 1 章開頭是${tl.startText}。` : '沒填起點，只按天數算。'}`;
}

/**
 * 認時間的輸入（設計稿「三 · 輸入」）：曆法與起點、前面幾章的時間（只看第一章之前的行）、上一章的結尾、這幾章的正文與細綱記的
 * 時間地點。`budgetTokens` 是正文能用多少（幾章平分，放不下的截中間）。
 */
export async function buildTimeInput(
  project: NovelProject,
  chapters: readonly Chapter[],
  texts: readonly string[],
  timeline: Timeline,
  budgetTokens: number
): Promise<string> {
  const first = chapters[0];
  const parts = [`【曆法與起點】\n${calendarNote(timeline)}`, `【前面幾章的時間】（程式按時間線推算的，幫你接上）\n${recentTimeNote(timeline, first.order)}`];
  if (first.order > 1) {
    const prev = await project.getChapter(first.order - 1);
    const prevText = prev ? (await project.readChapterText(prev)).trim() : '';
    if (prevText) {
      parts.push(`【第 ${first.order - 1} 章的結尾】（上一章最後一段：本章開頭接著哪個時刻，看這裡）\n${tailOf(prevText, TIME_PREV_TAIL_CHARS)}`);
    }
  }
  const fixed = estimateTokens(parts.join('\n\n'));
  const per = Math.max(500, Math.floor((budgetTokens - fixed) / chapters.length));
  const perChars = Math.min(TIME_CHAPTER_CHARS, tokensToChars(per));
  for (let k = 0; k < chapters.length; k++) {
    const c = chapters[k];
    const plot = await project.plotOfChapter(c);
    const timePlace = plot?.sections.时间地点?.replace(/\s+/gu, ' ').trim();
    const body = clipMiddle(texts[k], perChars);
    if (body.length < texts[k].length) {
      log.info(`第 ${c.order} 章正文較長，認時間時截了中間`, `${[...texts[k]].length} 字 → 約 ${perChars} 字（留頭尾）`);
    }
    parts.push(`【第${c.order}章 ${c.title}】\n${timePlace ? `（細綱記的時間地點，只當提示，不是正文：${timePlace}）\n` : ''}\n${body}`);
  }
  parts.push(`請給第 ${chapters.map((c) => c.order).join('、')} 章各判一次時間，按要求的格式寫。`);
  return parts.join('\n\n');
}

/** 一章的結果。 */
export interface TimeResult {
  chapter: number;
  /** 寫進去的那一行（推不出記 `+?` 的也算）。模型沒給這一章時缺席。 */
  entry?: TimelineEntry;
  action?: TimelineWrite;
  /** 沒寫：時間線裡這一章是作者寫的（`kept` 的一種）。 */
  authored?: true;
  /** 模型沒給這一章。 */
  missing?: true;
}

/** 一行時間寫進時間線。寫之前那一刻重讀（`updateThread`），覆蓋前存歷史版本（閘道器）。返回寫成了什麼樣。 */
export async function writeTimeEntry(
  project: NovelProject,
  entry: TimelineEntry,
  chapterText: string,
  mode: TimelineWriteMode = 'fill'
): Promise<TimelineWrite> {
  let action: TimelineWrite = 'kept';
  await new Workspace(project).updateThread(project.relPath(project.timelinePath), (raw) => {
    const r = upsertTimelineEntry(raw, entry, chapterText, mode);
    action = r.action;
    return r.action === 'kept' ? undefined : r.text;
  });
  return action;
}

/**
 * 認時間沒成（呼叫沒成之外的：模型的回答讀不出來、轉寫沒成）。帶著這一次已經調了幾次（寫 1 次，加上轉寫的），呼叫方照它記賬。
 */
export class TimeJudgeError extends Error {
  constructor(
    message: string,
    readonly calls: number
  ) {
    super(message);
    this.name = 'TimeJudgeError';
  }
}

/** 認時間沒成時調了幾次：讀不出來的帶著實數，別的錯（網路、超時）是寫的那 1 次。 */
export function timeCallsOf(err: unknown): number {
  return err instanceof TimeJudgeError ? err.calls : 1;
}

/** 認時間那一次怎麼調：`StepOpts`，再加轉寫那一次（2026-10-25 起）。預設走「轉寫」那一檔，那一檔沒有可用的模型時用 `run` 那一個。 */
export type TimeStepOpts = StepOpts & { transcribe?: TranscribeCall };

/**
 * 認時間轉寫那一步的規格（2026-10-25 起改成轉寫）：形狀是 `{"times":[…]}`（老的單章 `{"time":{…}}` 也認）。章號、天數、
 * 時段詞、回憶多久以前按對應關係填，不比原文；依據、理由、寫明的日子與季節都要出自原文（`verifyTime` 再回正文逐字找一遍）。
 */
function timeSpec(chapters: readonly Chapter[]): TranscribeSpec<Record<string, unknown>> {
  const first = chapters[0].order;
  const last = chapters[chapters.length - 1].order;
  return {
    label: `第 ${first === last ? first : `${first}–${last}`} 章故事時間`,
    contract: TIME_JSON_CONTRACT,
    decode: (json) => {
      const value = parseTimeAnswer(json);
      return value && (Array.isArray(value.times) || (value.time && typeof value.time === 'object'))
        ? { ok: true, value }
        : { ok: false, message: '沒有 times 這一項' };
    },
    mapped: ['chapter', 'days', 'offset', 'part', 'endPart', 'flashback'],
    // 連一個「第N章」、一項都沒有的（「今天不想判。」）不花轉寫那一次，按讀不出來走。
    looksLike: (source) => source.includes('開頭晚幾天') || chapters.some((c) => source.includes(`第${c.order}章`)),
  };
}

/** 原來的解碼：剝圍欄、摳物件、去尾逗號，是物件就收。 */
function parseTimeAnswer(raw: string): Record<string, unknown> | undefined {
  const json = extractJsonObject(stripCodeFence(raw));
  try {
    const value: unknown = json ? JSON.parse(stripTrailingCommas(json)) : undefined;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 調一次模型認時間，取回 `{"times":[…]}`（2026-10-25 起改成轉寫）：模型自己給了 JSON（老會話、測試裡的假模型）照原來的解碼、
 * 不轉；按格式寫的交給轉寫模型照抄。讀不出來、轉寫沒成拋 {@link TimeJudgeError}（帶著調了幾次）；呼叫本身沒成照樣往外拋。
 */
async function askTimes(
  opts: TimeStepOpts,
  chapters: readonly Chapter[],
  label: string,
  user: string
): Promise<{ answer: Record<string, unknown>; calls: number }> {
  const options: StreamOptions = {
    maxOutputTokens: opts.budget.maxOutputTokens,
    temperature: 0.2,
    timeoutMs: readConfig().requestTimeoutMs,
    signal: opts.signal,
  };
  const raw = await opts.run(label, (llm) =>
    collectText(
      llm.stream(
        [
          { role: 'system', content: TIME_SYSTEM },
          { role: 'user', content: user },
        ],
        options
      )
    )
  );
  const direct = parseTimeAnswer(raw);
  if (direct) {
    return { answer: direct, calls: 1 };
  }
  const transcribe =
    opts.transcribe ?? poolTranscriber(opts.signal ?? new AbortController().signal, { run: opts.run, primaryBudget: opts.budget });
  const r = await transcribeJson(raw, timeSpec(chapters), transcribe);
  if (r.notes.length > 0) {
    log.warn(`${label}：轉寫不順`, r.notes.join('\n'));
  }
  if (!r.ok) {
    throw new TimeJudgeError(`模型返回的故事時間解析不出來（${r.calls > 0 ? `轉寫沒成：${r.message}` : r.message}）`, 1 + r.calls);
  }
  return { answer: r.value, calls: 1 + r.calls };
}

/**
 * 判這幾章（按章號連續，寫一次、轉寫一到兩次）：讀此刻盤上的時間線當「前面幾章的時間」，調模型，逐章校驗、按 `mode` 寫盤。
 * 呼叫沒成、解析不出來拋錯（取消照樣拋；讀不出來的是 {@link TimeJudgeError}，帶著調了幾次）；模型漏了的章記 `missing`。
 * 交回各章的結果與實際調了幾次。
 */
export async function judgeTimes(
  project: NovelProject,
  chapters: readonly Chapter[],
  opts: TimeStepOpts & { mode: TimelineWriteMode; label: string }
): Promise<{ results: TimeResult[]; calls: number }> {
  const timeline = (await project.readThreads()).timeline ?? emptyTimeline(project.relPath(project.timelinePath));
  const texts = await Promise.all(chapters.map((c) => project.readChapterText(c)));
  const hints = await Promise.all(chapters.map(async (c) => (await project.plotOfChapter(c))?.sections.时间地点?.replace(/\s+/gu, ' ').trim() || undefined));
  const budget = Math.max(2000, opts.budget.contextWindow - opts.budget.maxOutputTokens - estimateTokens(TIME_SYSTEM) - 500);
  const user = await buildTimeInput(project, chapters, texts, timeline, budget);
  const { answer, calls } = await askTimes(opts, chapters, opts.label, user);
  // 老的單章形狀（`{"time":{…}}`）、模型把一項直接攤在最外層的，也認。
  const list = Array.isArray(answer.times) ? answer.times : answer.time ? [{ chapter: chapters[0].order, ...(answer.time as object) }] : [];
  const wanted = new Set(chapters.map((c) => c.order));
  const byNo = new Map<number, unknown>();
  const strays: unknown[] = [];
  for (const item of list) {
    const no = item && typeof item === 'object' ? Number((item as Record<string, unknown>).chapter) : NaN;
    if (wanted.has(no) && !byNo.has(no)) {
      byNo.set(no, item);
    } else if (item && typeof item === 'object') {
      strays.push(item);
    }
  }
  // 章號對不上的按先後補給還沒著落的章（試跑：正文裡寫著「第二十二回」，模型照它填了 22）。
  for (const c of chapters) {
    if (!byNo.has(c.order) && strays.length > 0) {
      const item = strays.shift() as Record<string, unknown>;
      log.info(`第 ${c.order} 章：模型報的章號是 ${String(item.chapter)}，按先後認作這一章`);
      byNo.set(c.order, item);
    }
  }
  const existing = new Map(timeline.entries.map((e) => [e.chapter, e]));
  const out: TimeResult[] = [];
  for (let k = 0; k < chapters.length; k++) {
    const c = chapters[k];
    const verified = verifyTime(byNo.get(c.order), { chapter: c.order, text: texts[k], calendar: timeline.calendar, ...(hints[k] ? { hint: hints[k] } : {}) });
    if (!verified) {
      log.warn(`第 ${c.order} 章：模型沒給這一章的時間，時間線裡這一章沒動`);
      out.push({ chapter: c.order, missing: true });
      continue;
    }
    if (verified.notes.length > 0) {
      log.info(`第 ${c.order} 章的時間：校驗時改過`, verified.notes.join('\n'));
    }
    const action = await writeTimeEntry(project, verified.entry, texts[k], opts.mode);
    const before = existing.get(c.order);
    const authored = action === 'kept' && (timeline.bad.includes(c.order) || (before !== undefined && !isMachineEntry(before)));
    out.push({ chapter: c.order, entry: verified.entry, action, ...(authored ? { authored: true as const } : {}) });
  }
  return { results: out, calls };
}

/** {@link recordChapterTime} 的結果。 */
export interface TimeStep {
  /** 實際調了幾次模型（寫 1 次加上轉寫的；沒成也算發出去的那幾次）。 */
  calls: number;
  time?: TimeResult;
  /** 沒推成（時間線沒動）。 */
  timeError?: string;
}

/**
 * 同步一章時的「故事時間」那一步（單章定稿、立即同步、寫完即定稿都經 finalizeSteps.ts）：寫 1 次、轉寫 1–2 次，機器寫的行照新推的換
 * （⚑7），作者的行不動。**不拋**（取消照樣拋出去）：沒成掛黃 ❗ 在章節上，成了清掉。
 */
export async function recordChapterTime(
  project: NovelProject,
  chapter: Chapter,
  runner: ModelRunner,
  opts: { signal?: AbortSignal; transcribe?: TranscribeCall } = {}
): Promise<TimeStep> {
  try {
    const { results, calls } = await judgeTimes(project, [chapter], {
      run: (what, fn) => runner.run(what, fn),
      budget: runner.primaryBudget,
      signal: opts.signal,
      transcribe: opts.transcribe,
      mode: 'refresh',
      label: `第 ${chapter.order} 章 · 故事時間`,
    });
    await clearFailures(project, 'chapter', chapter.relPath, TIME_OP);
    return { calls, time: results[0] };
  } catch (err) {
    if (err instanceof CancelledError || opts.signal?.aborted) {
      throw err;
    }
    const timeError = describeError(err);
    log.warn(`第 ${chapter.order} 章的故事時間沒推成：${timeError}`, err);
    await recordFailure(project, {
      scope: '同步',
      targetKind: 'chapter',
      targetKey: chapter.relPath,
      severity: 'warn',
      op: TIME_OP,
      message: `細綱已照正文更新，但故事時間沒推成：${timeError}`,
      detail: '時間線裡這一章沒動。重新同步這一章會再推一次；也可以在敘事線頁籤「時間線」組裡右鍵這一章「重推這一章」。',
    });
    return { calls: timeCallsOf(err), timeError };
  }
}

/** 完成提示裡時間那一句（單章同步、立即同步的彙總）。沒有就是空串。 */
export function describeTimeOutcome(o: Pick<TimeStep, 'time' | 'timeError'>): string {
  if (o.timeError) {
    return `故事時間沒推成（${o.timeError}）`;
  }
  const t = o.time;
  if (!t) {
    return '';
  }
  if (t.missing || !t.entry) {
    return '模型沒給這一章的時間（可以在敘事線頁籤的「時間線」組裡重推這一章）';
  }
  return t.authored ? '時間線裡這一章是你定的，沒改' : describeTimeEntry(t.entry);
}
