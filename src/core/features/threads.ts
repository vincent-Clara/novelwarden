import { traditionalLabel } from '../model/labels';
/**
 * 敘事線（2026-10-20 重做，設計見 docs/design/plans/2026-10-20-narrative-threads.md）：從情節大綱排出敘事線
 * （{@link generateThreads}、{@link planThreadsFromOutline}），定稿時認這一章在敘事線上發生了什麼（{@link recordThreads}）。
 *
 * ## 排線
 *
 * 移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）`narrative-thread-candidate-generator.ts`
 * 的 `generatePlanCandidates`。七期從細綱排；重做之後**從情節大綱排**：線是在大綱這一層排的，細綱反過來
 * 照著線排（二期拆細綱帶上敘事線）。輸入是小說配置（規模、一句話）、故事前提、角色圖譜（身份、關係、
 * 暗設——讀者還不知道的事）、情節大綱（截到 `threadPlanOutlineChars`）與已有的線和伏筆（叫它別重複）。
 *
 * - **只新建線**（一條線一個檔案 `threads/<線名>.md`，伏筆寫線上下），同名的跳過，已有的一個字不動——沒有東西
 *   會被吞，所以不走寫入卡（第 19 條的批次路徑）；作者不要哪條，刪掉那個檔案就是。
 * - 動手之前確認框寫明呼叫次數與用哪一檔（第 4 條，`THREAD_PLAN_CALLS`）。走「劇情細綱」檔（`plotOutline`）：排線和拆細綱
 *   是同一種活，在大綱與各章計劃之間排跨章的東西。不帶思考深度（第 26 條）。
 * - 2026-10-25 起改成轉寫：模型按格式寫（一條線一段「## 線名」），轉寫那一檔照抄成 JSON（排 1 次、轉寫 1 次，轉寫不合格重轉
 *   1 次）。排的那一次不重來：沒排成掛紅 ❗ 在敘事線目錄上（第 16 條），作者再點一次。
 *
 * 不進主按鈕（第 20 條只推一個下一步，設計稿 ⚑8）：入口是工程頁（七期那一行，第 8 個提交換成「敘事線」組
 * 標題旁的按鈕）與 agent 的 `extract threads`；批次拆細綱開跑時一條線都沒有，先排一次（features/pipelineBatch.ts）。
 *
 * ## 定稿時認事件、更新當前進度、歸併
 *
 * 認事件移植自同一個檔案的 `generateEventCandidates`。上游要作者在編輯器裡一條線一條線點「AI 識別定稿事件」再逐條
 * 確認；這裡是定稿的第三步，**自動做、直接寫**——與 D15 角色狀態同一個理由：批次「寫完即定稿」時沒人看，而事件只是在
 * 一條線的「進展」裡**追加**一行帶原文的記錄，不吞任何東西；證據逐字校驗（`verifyFinds`）就是那道閘。線是空的也認：
 * 正文裡長出來的線只能在這裡認出來（設計稿 ⚑6：定稿每章最少 2 次）。當前進度由機器維護、指紋守著（作者改過就不寫），
 * 照角色卡「當前狀態」的做法。詳見 {@link recordThreads}。
 *
 * 認事件、歸併、當前進度 2026-10-25 起也改成轉寫（{@link askTranscribed}）：模型按格式寫自然語言，轉寫那一檔照抄成原來那份
 * JSON，解碼與校驗（model/threadFile.ts 的 `verify…`）一行沒改。證據讓模型用「」引出原句，轉寫照抄，之後照舊逐字對正文核。
 */
import { readConfig } from '../config';
import { contextLimitsOf } from '../model/contextDetail';
import { getHost } from '../host';
import { collectText } from '../llm/collect';
import { ModelPool, createModelPool } from '../llm/pool';
import { CancelledError, StreamOptions } from '../llm/provider';
import { estimateTokens, takeHead } from '../context/tokenizer';
import { cardHidden, cardNote, clipLine } from '../context/layers/render';
import { clearFailures, recordFailure } from '../runtime/errorLog';
import { describeError, elapsed, scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { NovelProject } from '../model/project';
import { CHARACTER_DETAIL_LIMITS, Chapter, CharacterCard } from '../model/types';
import { LlmProvider } from '../llm/provider';
import { THREAD_PLAN_CALLS, describeCalls } from '../model/pipeline';
import { isOutlineFilled, outlineBriefs } from '../model/outlineFile';
import { withCallChoice } from '../runtime/callScope';
import { askCall } from './askCall';
import { hasContent } from '../model/markdown';
import { PREMISE_SECTION_KEYS } from '../model/settingFile';
import {
  CutForeshadowing,
  FoundEvent,
  FoundForeshadow,
  Foreshadowing,
  JudgedForeshadow,
  NewThread,
  SAME_THREAD,
  THREAD_PLAN_LIMIT,
  Thread as LineThread,
  ThreadEvent,
  ThreadFinds,
  ThreadKind,
  ThreadMerge,
  UNFILED_NAME,
  UNFILED_TEMPLATE,
  actualEvents,
  appendEvents,
  appendForeshadowing,
  applyMerges,
  asOf,
  completeFinds,
  cutForeshadowing,
  foreshadowNames,
  foreshadowToJudge,
  foreshadowingOf,
  isClosed,
  isForeshadowClosed,
  isForeshadowEvent,
  lastActiveChapter,
  openForeshadowing,
  parseThreadFile,
  pasteForeshadowing,
  patchProgress,
  plannedFor,
  progressOwnedByMachine,
  pruneChapterEvents,
  threadFileName,
  threadKey,
  threadStatus,
  threadsToJudge,
  verifyFinds,
  verifyMerges,
  verifyProgress,
  verifyThreadPlans,
} from '../model/threadFile';
import { Workspace } from '../workspace';
import { readTextIfExists } from '../model/fs';
import { extractJsonObject, jsonList, stripCodeFence, stripTrailingCommas } from './parse';
import { poolTranscriber } from './poolIO';
import { TranscribeCall, TranscribeSpec, transcribeJson } from './transcribe';
import {
  THREAD_FIND_SYSTEM,
  THREAD_MERGE_SYSTEM,
  THREAD_PROGRESS_SYSTEM,
  threadFindJsonContract,
  threadMergeJsonContract,
  threadPlanJsonContract,
  threadPlanSystem,
  threadProgressJsonContract,
} from './threadsPrompt';

const log = scoped('叙事线');

/** 失敗記錄的 op：排線失敗（掛在敘事線目錄上）、定稿時認敘事線沒成或只成了一半（掛在章節上）都記在它名下。 */
export const THREADS_OP = 'threads';

// ---------------------------------------------------------------- 排線

/** 已有的一條線在提示裡的樣子：名字、種類、區間、意圖，叫模型別重複。 */
function existingLine(t: LineThread): string {
  const range = t.from !== undefined || t.to !== undefined ? ` · 計劃第 ${t.from ?? '?'}–${t.to ?? '?'} 章` : '';
  return `- ${t.name}（${traditionalLabel(t.kind)}${range}）${t.intent ? `意圖：${clipLine(t.intent, 60)}` : ''}`;
}

/** {@link planThreadsFromOutline} 的結果。 */
export interface PlanThreadsOutcome {
  /** 實際調了幾次模型。 */
  calls: number;
  /** 新建的線（一條一個檔案）。 */
  added: NewThread[];
  /** 新建的線裡一共帶了幾條伏筆。 */
  foreshadowing: number;
  /** 同名跳過幾條。 */
  same: number;
  /** 不合格沒收幾條（線；見日誌）。 */
  bad: number;
  /** 沒排成的原因（失敗已經掛在敘事線目錄上）。 */
  error?: string;
  cancelled?: boolean;
}

/**
 * 從情節大綱排敘事線：工程頁按鈕、agent 的 `extract threads` 與批次拆細綱開跑前（一條線都沒有時）共用。**不彈框、
 * 不開任務、不拋**（取消單列）：確認與進度條歸呼叫方；失敗掛在敘事線目錄上（第 16 條）。只新建線，同名跳過（第 19 條）。
 * 情節大綱是空的返回 error，不調模型。
 */
export async function planThreadsFromOutline(
  project: NovelProject,
  pool: Pick<ModelPool, 'run' | 'primaryBudget'>,
  signal: AbortSignal,
  report: (p: { message: string; current?: number; total?: number }) => void = () => {}
): Promise<PlanThreadsOutcome> {
  const out: PlanThreadsOutcome = { calls: 0, added: [], foreshadowing: 0, same: 0, bad: 0 };
  const outline = (await project.readOutline()).trim();
  if (!isOutlineFilled(outline)) {
    return { ...out, error: '情節大綱還是空的' };
  }
  const book = await project.readThreads();
  const rel = project.relPath(project.threadsDir);
  const config = readConfig();
  const outlineChars = contextLimitsOf(config).threadPlanOutlineChars;

  report({ message: '讀取設定與大綱', current: 0, total: 2 });
  const bookConfig = await project.readBookConfig();
  const premise = await project.readSettingDoc('premise');
  const cards = await project.listCharacters();

  const parts: string[] = [];
  if (bookConfig.totalChapters || bookConfig.wordsPerChapter) {
    parts.push(
      `【全書規模】${bookConfig.totalChapters ? `共 ${bookConfig.totalChapters} 章` : ''}${
        bookConfig.wordsPerChapter ? `，每章約 ${bookConfig.wordsPerChapter} 字` : ''
      }`
    );
  }
  if (hasContent(bookConfig.sections.一句话)) {
    parts.push(`【一句話】\n${bookConfig.sections.一句话.trim()}`);
  }
  const premiseText = PREMISE_SECTION_KEYS.filter((k) => hasContent(premise.sections[k]))
    .map((k) => `## ${traditionalLabel(k)}\n${premise.sections[k].trim()}`)
    .join('\n\n');
  if (premiseText) {
    parts.push(`【故事前提】\n${premiseText}`);
  }
  // 角色圖譜：身份與關係，加上各人的「暗設」（讀者還不知道的事）——排伏筆最好的原料：伏筆管什麼時候、怎麼揭開，
  // 暗設管真相是什麼。排線是規劃，暗設整份帶（與裝配器在架構 / 大綱 / 細綱時同一個口徑，上限就是那一節的 120 字）。
  const roster = cards
    .map((c) => {
      const lines = [`- ${c.name}${hasContent(c.sections.身份) ? `（${clipLine(c.sections.身份, 60)}）` : ''}`];
      if (hasContent(c.sections.人物关系)) {
        lines.push(`  人物關係：${clipLine(c.sections.人物关系, 120)}`);
      }
      const hidden = cardHidden(c);
      if (hidden) {
        lines.push(`  暗設（讀者還不知道）：${clipLine(hidden, CHARACTER_DETAIL_LIMITS.暗设)}`);
      }
      return lines.join('\n');
    })
    .join('\n');
  if (roster) {
    parts.push(`【角色圖譜】\n${roster}`);
  }
  // 整份放得下帶整份；放不下每章只帶第一行（一章一條，第一行就是這一章的概要），還放不下才截。
  let outlineText = outline;
  if ([...outline].length > outlineChars) {
    outlineText = outlineBriefs(outline);
    log.warn('情節大綱太長，排敘事線時每章只帶了第一行', `${[...outline].length} 字 → ${[...outlineText].length} 字`);
  }
  const chars = [...outlineText];
  if (chars.length > outlineChars) {
    log.warn('情節大綱每章一行也放不下，排敘事線時只帶了前面一截', `${chars.length} 字 → ${outlineChars} 字`);
  }
  parts.push(`【情節大綱】\n${chars.length > outlineChars ? `${chars.slice(0, outlineChars).join('')}\n……（後面略）` : outlineText}`);
  const knownFore = foreshadowNames(book);
  if (book.threads.length > 0) {
    parts.push(`【已有的敘事線（不要重複）】\n${book.threads.map(existingLine).join('\n')}`);
  }
  if (knownFore.length > 0) {
    parts.push(`【已有的伏筆（不要重複）】\n${knownFore.join('、')}`);
  }
  parts.push('請按上面的格式寫。');
  const hasMain = book.threads.some((t) => t.kind === '主线');

  report({ message: '排線', current: 1, total: 2 });
  const startedAt = Date.now();
  let plans: NewThread[];
  let bad = 0;
  let sameInReply = 0;
  try {
    // 2026-10-25 起改成轉寫：一條線一段「## 線名」，轉寫那一檔照抄成原來的 {threads:[…]}（那一檔一個可用的都沒有就用這個池）。
    const asked = await askTranscribed(
      { run: (what, fn) => pool.run(what, fn), budget: pool.primaryBudget, signal, transcribe: poolTranscriber(signal, pool) },
      {
        label: '排敘事線',
        system: threadPlanSystem(bookConfig.totalChapters, hasMain),
        user: parts.join('\n\n'),
        temperature: 0.4,
        what: '敘事線',
        spec: planSpec(),
        tally: (n) => (out.calls += n),
      }
    );
    if (signal.aborted) {
      log.warn('排敘事線被取消，未寫盤');
      return { ...out, cancelled: true };
    }
    log.info('模型已返回', `呼叫 ${out.calls} 次，用時 ${elapsed(startedAt)}`);
    if (!asked.ok) {
      throw new Error(asked.error);
    }
    const list = asked.value;
    const verified = verifyThreadPlans(list, { threads: book.threads, foreshadowing: knownFore }, bookConfig.totalChapters);
    const notes = [
      ...verified.dropped.map((d) => `線 ${d.name}：${d.why}`),
      ...verified.foreshadowDropped.map((d) => `伏筆 ${d.name}：${d.why}`),
    ];
    if (notes.length > 0) {
      log.warn(`有 ${notes.length} 條沒收`, notes.join('\n'));
    }
    if (verified.plans.length === 0) {
      const why = verified.dropped.length > 0 ? `${verified.dropped.length} 條都不合格` : '一條都沒有';
      throw new Error(`模型排出的線${why}`);
    }
    plans = verified.plans;
    sameInReply = verified.dropped.filter((d) => d.why === SAME_THREAD).length;
    bad = verified.dropped.length - sameInReply;
  } catch (err) {
    if (err instanceof CancelledError || signal.aborted) {
      log.warn('排敘事線被取消，未寫盤');
      return { ...out, cancelled: true };
    }
    const reason = describeError(err);
    log.error(`排敘事線失敗：${reason}`, err);
    await recordFailure(project, {
      scope: '叙事线',
      targetKind: 'threads',
      targetKey: rel,
      severity: 'error',
      op: THREADS_OP,
      message: `排敘事線失敗：${reason}`,
      detail: `${rel}/ 沒有改動。可以再排一次。`,
    });
    return { ...out, error: reason };
  }

  // 寫之前重讀：這幾十秒裡作者可能在編輯器里加了線（同名的照樣跳過）。一條線一個新檔案，已有的一個位元組不動。
  const now = await project.readThreads();
  const known = new Set(now.threads.map((t) => threadKey(t.name)));
  let mainTaken = now.threads.some((t) => t.kind === '主线');
  const ws = new Workspace(project);
  for (const plan of plans) {
    if (known.has(threadKey(plan.name)) || (plan.kind === '主线' && mainTaken)) {
      out.same++;
      continue;
    }
    if (await ws.createThread(plan)) {
      out.added.push(plan);
      out.foreshadowing += plan.foreshadowing.length;
      known.add(threadKey(plan.name));
      mainTaken ||= plan.kind === '主线';
    } else {
      out.same++;
    }
  }
  await clearFailures(project, 'threads', rel, THREADS_OP);
  report({ message: '完成', current: 2, total: 2 });
  out.same += sameInReply;
  out.bad = bad;
  log.info(
    `排出 ${out.added.length} 條敘事線、${out.foreshadowing} 條伏筆`,
    out.added.map((p) => `${p.name}（${traditionalLabel(p.kind)}${p.from !== undefined ? ` · 第 ${p.from}–${p.to ?? '?'} 章` : ''}）`).join('\n')
  );
  return out;
}

/**
 * 工程頁「從大綱排出敘事線」與 agent 的 `extract threads`：先問一句（呼叫次數），再排。返回實際呼叫次數（取消、沒有
 * 情節大綱時是 0）。
 */
export async function generateThreads(project: NovelProject): Promise<number> {
  if (!isOutlineFilled(await project.readOutline())) {
    getHost().toast('情節大綱還是空的：先排出情節大綱，再從大綱排出敘事線。', 'error');
    return 0;
  }
  const { threads } = await project.readThreads();
  const rel = project.relPath(project.threadsDir);
  const hasMain = threads.some((t) => t.kind === '主线');
  const answer = await askCall({
    message: `要從情節大綱排出敘事線，${describeCalls(THREAD_PLAN_CALLS)}。現在排？`,
    actions: ['開始排'],
    detail:
      `一次最多排 ${THREAD_PLAN_LIMIT} 條（主線 / 支線 / 感情線 / 人物線，主線全書一條），伏筆寫線上下；一條線一個檔案，放在 ${rel}/ 裡，可以手改。` +
      (threads.length > 0
        ? `已有的 ${threads.length} 條不會改動，同名的跳過${hasMain ? '；主線已經有了，不再排主線' : ''}。`
        : ''),
    tasks: ['plotOutline', 'transcribe'],
    contextDetail: true,
  });
  if (answer?.action !== '開始排') {
    log.info('使用者取消了排敘事線');
    return 0;
  }
  return withCallChoice(answer.choice, async () => {
    const pool = await createModelPool({ task: 'plotOutline', concurrent: false });
    if (!pool) {
      log.error('沒有可用的模型，排敘事線中止');
      return 0;
    }

    let calls = 0;
    await runTask(
      '排敘事線',
      async ({ signal, report }) => {
        const r = await planThreadsFromOutline(project, pool, signal, report);
        calls = r.calls;
        if (r.cancelled) {
          return;
        }
        if (r.error) {
          getHost().toast(`敘事線沒排成（${r.error}）。`, 'error');
          return;
        }
        getHost().toast(describePlanned(r, rel));
        if (r.added.length > 0) {
          await getHost().openFile(`${rel}/${threadFileName(r.added[0].name)}`);
        }
      },
      { scope: '叙事线' }
    );
    return calls;
  });
}

/** 「排出 3 條敘事線、5 條伏筆（同名跳過 1 條），已寫進 .novelwarden/threads/。」 */
export function describePlanned(r: PlanThreadsOutcome, rel: string): string {
  const notes = [r.same > 0 ? `同名跳過 ${r.same} 條` : '', r.bad > 0 ? `${r.bad} 條不合格沒收（見日誌）` : ''].filter(Boolean);
  return r.added.length > 0
    ? `排出 ${r.added.length} 條敘事線、${r.foreshadowing} 條伏筆${notes.length > 0 ? `（${notes.join('，')}）` : ''}，已寫進 ${rel}/。`
    : `排出的線在 ${rel}/ 裡都已經有了，沒有改動。`;
}

// ---------------------------------------------------------------- 定稿第三步：認事件、當前進度、歸併

/** 失敗記錄的 op：定稿給一條線記了新進展，「當前進度」作者改過、沒覆蓋（掛在那條線的檔案上）。 */
export const PROGRESS_OP = 'threadProgress';

/** {@link recordThreads} 的結果。 */
export interface ThreadsOutcome {
  /** 調了幾次模型：認事件寫 1 次、轉寫 0–2 次，歸併、當前進度各 0–3 次（寫 1 次、轉寫 0–2 次）。 */
  calls: number;
  /** 記下的實際事件：落在哪條線上（缺席是「未歸屬的伏筆」）。 */
  recorded: FoundEvent[];
  /** 從正文裡認出、新建了檔案的線。 */
  newThreads: { name: string; kind: ThreadKind }[];
  /** 新登記的伏筆：掛在哪條線上（缺席是「未歸屬的伏筆」）。 */
  newForeshadowing: { name: string; line?: string }[];
  /** 新認出的、其實是已有的那一條（並進去了，不另建）。 */
  merged: ThreadMerge[];
  /** 當前進度換成了這一章的那幾條線。 */
  progressed: string[];
  /** 當前進度作者改過、沒有覆蓋的那幾條線（掛了黃 ❗）。 */
  guarded: string[];
  /** 送去寫當前進度、模型卻沒寫上的那幾條線（沒回這一條，或回的線名認不出；第 2 條：說出來）。 */
  unwritten: string[];
  /** 沒記的：證據找不到、認不出是哪一條…… */
  dropped: { what: string; why: string }[];
  /** 重新定稿時清掉的、證據已經不在正文裡的舊事件（設計稿 ⚑7）。 */
  pruned: number;
  /** 線與伏筆太多、這一次沒送去認的。 */
  skipped: string[];
  /** 從「未歸屬的伏筆」挪到線上的（這一章收了、棄了它，模型說它在那條線上；2026-10-24）。沒有就缺席。 */
  rehomed?: { name: string; line: string }[];
  /** 當前進度那一次沒成（認出來的照樣記下了）。 */
  progressError?: string;
  /** 歸併那一次沒成（新認出的照新的建了）。 */
  mergeError?: string;
}

export interface StepOpts {
  run: <T>(what: string, fn: (llm: LlmProvider) => Promise<T>) => Promise<T>;
  budget: { contextWindow: number; maxOutputTokens: number };
  signal?: AbortSignal;
  /**
   * 轉寫那一次怎麼調（2026-10-25 起敘事線幾次都是寫自然語言、再轉寫，{@link askTranscribed}）。缺席走「轉寫」那一檔
   * （features/poolIO.ts 的 `poolTranscriber`），那一檔一個可用的都沒有就用 `run` 那個。
   */
  transcribe?: TranscribeCall;
}

// ---------------------------------------------------------------- 轉寫（2026-10-25 起）

/** 敘事線那幾次裡的一次轉寫：{@link TranscribeSpec} 之外，原文全是「無」時交回什麼、原文寫了幾條轉寫卻一條沒有怎麼認。 */
interface ThreadSpec<T> extends TranscribeSpec<T> {
  /** 原文除了小標題全寫的「無」（什麼都沒認出、一條都不併）：直接交回它，不花轉寫那一次。缺席 = 照常轉寫。 */
  empty?: T;
  /** 原文裡寫了條目的樣子（「證據：」「## 線名」「【線】」「→」）。 */
  written?: RegExp;
  /** 解出來的有幾條：原文寫了（`written`）、轉寫出來一條都沒有，算轉寫不合格、重轉——不然整章認出來的悄悄丟了。 */
  items?(value: T): number;
}

/** 敘事線那幾次裡的一次：寫什麼、怎麼轉寫、呼叫怎麼記賬。 */
interface TranscribedStep<T> {
  /** 寫的那一次在日誌裡叫什麼（「第 3 章 · 敘事線」）。 */
  label: string;
  system: string;
  user: string;
  temperature: number;
  /** 沒成時那一句裡怎麼稱呼它：「模型返回的敘事線事件解析不出來」「敘事線事件轉寫不合格（……）」。 */
  what: string;
  spec: ThreadSpec<T>;
  /** 每調一次記一筆（寫 1 次、轉寫 0–2 次）：寫的那一次出錯往外拋時，那一次也已經記上了。 */
  tally(n: number): void;
}

/**
 * 原文裡「什麼都沒有」的一行：「無」「- 無」「（無）」「事件：無」，也認換了說法的「無需歸併。」「本章沒有新的事件」——
 * 一條都不併時模型未必只寫一個「無」，當成解不出來會掛一個白掛的黃 ❗。條目行總帶著「證據：「」」「→」「｜」，認不成「沒有」。
 */
const NONE_LINE = /^(?:[^:：「」]{1,8}[:：]\s*)?(?:本章|(?:这|這)一章)?[（(]?\s*(?:(?:无|無)|(?:没|沒)有|(?:暂|暫)(?:无|無)|都不)[^「」｜|→:：]{0,24}$/u;

/** 原文除了小標題全寫的「無」。 */
function nothingWritten(text: string): boolean {
  const lines = stripCodeFence(text)
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^[-*]\s*/, ''))
    .filter((l) => l && !l.startsWith('#'));
  return lines.length > 0 && lines.every((l) => NONE_LINE.test(l));
}

/** 調一次模型、拿回原文。 */
async function askText(opts: StepOpts, label: string, system: string, user: string, temperature: number): Promise<string> {
  const options: StreamOptions = {
    maxOutputTokens: opts.budget.maxOutputTokens,
    temperature,
    timeoutMs: readConfig().requestTimeoutMs,
    signal: opts.signal,
  };
  return opts.run(label, (llm) =>
    collectText(
      llm.stream(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        options
      )
    )
  );
}

/** {@link StepOpts.transcribe} 缺席時的那一個：「轉寫」那一檔，退回 `run` 那個。一章裡幾次共用一個（池只建一次）。 */
function transcriberOf(opts: StepOpts): TranscribeCall {
  return opts.transcribe ?? poolTranscriber(opts.signal ?? new AbortController().signal, { run: opts.run, primaryBudget: opts.budget });
}

/**
 * 敘事線那幾次的一次（2026-10-25 起改成轉寫）：模型按格式寫自然語言，轉寫那一檔照抄成 JSON（features/transcribe.ts 的
 * `transcribeJson`：原文字身是 JSON 不轉、不像這一步不轉，改了字重轉一次），交回解出來的值。寫的那一次出錯照舊往外拋；
 * 沒解出來交回一句說清是哪種的話（轉寫呼叫失敗 / 轉寫不合格 / 原文就解析不出來），走法歸呼叫方——照這一步原來解析失敗的走法。
 */
async function askTranscribed<T>(opts: StepOpts, step: TranscribedStep<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  step.tally(1);
  const raw = await askText(opts, step.label, step.system, step.user, step.temperature);
  const { spec } = step;
  if (spec.empty !== undefined && nothingWritten(raw)) {
    return { ok: true, value: spec.empty };
  }
  const written = !!spec.written?.test(raw);
  const decode: TranscribeSpec<T>['decode'] = (json) => {
    const d = spec.decode(json);
    return d.ok && written && spec.items && spec.items(d.value) === 0 ? { ok: false, message: '原文寫了，轉寫出來一條都沒有' } : d;
  };
  const r = await transcribeJson(raw, { ...spec, decode }, transcriberOf(opts));
  step.tally(r.calls);
  if (r.notes.length > 0) {
    log.warn(`${spec.label}轉寫不合格`, r.notes.join('\n'));
  }
  if (r.ok) {
    return { ok: true, value: r.value };
  }
  return {
    ok: false,
    error: r.failed
      ? `${step.what}轉寫沒成（${r.message}）`
      : r.calls > 0
        ? `${step.what}轉寫不合格（${r.message}）`
        : `模型返回的${step.what}解析不出來`,
  };
}

/** 吃 JSON 文字、交回一個物件：寬鬆取法（剝圍欄、取最外層物件、去多餘的逗號）。 */
function decodeObject(json: string): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  const text = extractJsonObject(stripCodeFence(json));
  try {
    const value: unknown = text ? JSON.parse(stripTrailingCommas(text)) : undefined;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return { ok: true, value: value as Record<string, unknown> };
    }
  } catch {
    // 落到下面那一句。
  }
  return { ok: false, message: '不是一個 JSON 物件' };
}

const listLength = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

/** 排線：一條線一段「## 線名」，種類、章號按對應關係填。 */
function planSpec(): ThreadSpec<unknown[]> {
  return {
    label: '排出的敘事線',
    contract: threadPlanJsonContract(),
    decode: (json) => {
      const list = jsonList(json, 'threads');
      return list ? { ok: true, value: list } : { ok: false, message: '沒有 threads 列表' };
    },
    mapped: ['kind', 'from', 'to', 'plant', 'resolve'],
    looksLike: (s) => /(?:种|種)(?:类|類)\s*[:：]/.test(s),
    written: /^#{1,3}\s*\S/m,
    items: (list) => list.length,
  };
}

/** 認事件：三節，一條一行「型別｜線名：發生了什麼。證據：「原句」」；型別、種類按對應關係填，證據照抄（之後照舊對正文核）。 */
function findSpec(no: number): ThreadSpec<Record<string, unknown>> {
  return {
    label: `第 ${no} 章的敘事線事件`,
    contract: threadFindJsonContract(),
    decode: decodeObject,
    mapped: ['type', 'kind'],
    looksLike: (s) => /(?:证|證)(?:据|據)\s*[:：]/.test(s) || /^#*\s*(?:事件|新(?:线|線)|新伏(?:笔|筆))\s*[:：]?\s*$/m.test(s),
    written: /(?:证|證)(?:据|據)\s*[:：]/,
    items: (o) => listLength(o.events) + listLength(o.newThreads) + listLength(o.newForeshadowing),
    empty: { events: [], newThreads: [], newForeshadowing: [] },
  };
}

/** 歸併：一條一行「新名字 → 已有名字：理由」，一條都不併寫「無」。 */
function mergeSpec(no: number): ThreadSpec<Record<string, unknown>> {
  return {
    label: `第 ${no} 章的敘事線歸併`,
    contract: threadMergeJsonContract(),
    decode: decodeObject,
    looksLike: (s) => /→|->/.test(s),
    written: /→|->/,
    items: (o) => listLength(o.merges),
    empty: { merges: [] },
  };
}

/** 當前進度：一條線一段「【線】線名」「當前進度：……」。 */
function progressSpec(no: number): ThreadSpec<Record<string, unknown>> {
  return {
    label: `第 ${no} 章的敘事線當前進度`,
    contract: threadProgressJsonContract(),
    decode: decodeObject,
    looksLike: (s) => s.includes('【線】'),
    written: /【(?:线|線)】/,
    items: (o) => listLength(o.progress),
  };
}

/** 認事件沒成（寫了、卻沒解出來）：帶上這一次實際調了幾次（寫 1 次、轉寫 0–2 次），呼叫方照實記賬（第 4 條）。 */
export class ThreadsFindError extends Error {
  constructor(
    message: string,
    readonly calls: number
  ) {
    super(message);
    this.name = 'ThreadsFindError';
  }
}

/** 送去認的一條線：名字、種類、狀態、區間、意圖、現在走到哪、最近一次實際事件（都按寫到這一章時算）。 */
function judgeLine(t: LineThread): string {
  const range = t.from !== undefined || t.to !== undefined ? `計劃第 ${t.from ?? '?'}–${t.to ?? '?'} 章` : '';
  const head = [traditionalLabel(t.kind), traditionalLabel(threadStatus(t)), range].filter(Boolean).join(' · ');
  const last = actualEvents(t).slice(-1)[0];
  return [
    `- ${t.name}（${head}）`,
    t.intent ? `意圖：${clipLine(t.intent, 80)}` : '',
    t.progress ? `；現在：${clipLine(t.progress, 80)}` : '',
    last ? `；最近：第 ${last.chapter} 章${traditionalLabel(last.type)}${last.foreshadowing ? `〈${last.foreshadowing}〉` : ''}：${clipLine(last.what, 40)}` : '',
  ].join('');
}

/** 送去認的一條伏筆。 */
function judgeForeshadow(f: JudgedForeshadow): string {
  const when = f.resolveBy !== undefined ? ` · 計劃第 ${f.resolveBy} 章前收` : '';
  return `- ${f.name}（掛在「${f.line ?? UNFILED_NAME}」· ${traditionalLabel(f.status)}${when}）${f.what ? `是什麼：${clipLine(f.what, 60)}` : ''}`;
}

/** 歸併（c）時已有的一條伏筆：掛在哪條線、狀態、是什麼——與新認出的那幾條同一個樣子，讓模型比的是事、不是名字。 */
function mergeCandidate(f: JudgedForeshadow): string {
  return `- ${f.name}（掛在「${f.line ?? UNFILED_NAME}」· ${traditionalLabel(f.status)}）是什麼：${f.what ? clipLine(f.what, 60) : '（沒寫）'}`;
}

/**
 * 定稿第三步（設計稿「三」）：敘事線寫 1–3 次，2026-10-25 起每次寫完轉寫 1 次（不合格重轉 1 次；原文全是「無」不轉）。
 *
 * ```
 * a. 認事件（1 次，線是空的也跑）：正文 + 沒收束的線 + 沒收的伏筆 + 本章計劃 → 實際事件、新線、新伏筆、關係變動
 *    （verifyFinds：證據逐字校驗）
 * c. 歸併（0–1 次）：a 報了新線 / 新伏筆、又有已有的可比 → 是不是已有的那一條換了個說法
 * 寫盤：清掉這一章證據已經不在正文裡的舊事件 → 新線建檔案、新伏筆與事件追加（只追加，第 19 條）
 *       → 這一章算判過，推 project.json 裡的水位（四期，{@link noteThreadsJudged}）
 * b. 當前進度（0–1 次）：本章有實際事件的那幾條線（作者改過的不送、掛黃 ❗）→ 各自的當前進度（指紋守著）
 * ```
 *
 * 歸併排在當前進度之前（⚑，設計稿把它列在 b 後面）：先定下事件落在哪條線上，當前進度才寫得到對的那幾條線。
 *
 * 本章計劃只讀各條線裡這一章的計劃事件（二期：拆細綱時隨細綱寫進線裡）。一期還把細綱的「新增伏筆」當作本章計劃要埋的
 * 伏筆一起交給模型，二期細綱刪了那一節，這一處跟著刪——老細綱裡留著的那一節當認不出的小節，不讀。
 *
 * `run` 決定怎麼調模型（同 `updateCharacterStates`）：單章入口直接用對話頁選定的那個，批次入口傳「定稿」檔
 * （`plotSummary`）的池；轉寫走「轉寫」那一檔（`opts.transcribe`，缺席見 {@link transcriberOf}）。a 呼叫失敗、轉寫沒成或解析不出來時
 * 拋錯（寫了卻沒解出來的是 {@link ThreadsFindError}，帶著實際調了幾次）——細綱已經更新好了，由呼叫方把失敗掛在章節上；b、c 失敗
 * （含轉寫沒成）只記在結果裡（a 記下的照樣算數），取消照樣拋出去。
 */
export async function recordThreads(project: NovelProject, chapter: Chapter, opts: StepOpts): Promise<ThreadsOutcome> {
  const out: ThreadsOutcome = {
    calls: 0,
    recorded: [],
    newThreads: [],
    newForeshadowing: [],
    merged: [],
    progressed: [],
    guarded: [],
    unwritten: [],
    dropped: [],
    pruned: 0,
    skipped: [],
  };
  const no = chapter.order;
  const book = await project.readThreads();
  const plot = await project.plotOfChapter(chapter);
  const limits = contextLimitsOf(readConfig());
  const plotText = plot ? [plot.title, ...Object.values(plot.sections)].join('\n') : chapter.title;
  const lines = threadsToJudge(book, no, plotText, limits.threadJudge);
  const fores = foreshadowToJudge(book, no, limits.foreshadowJudge);
  out.skipped = [...lines.skipped.map((t) => t.name), ...fores.skipped.map((f) => `〈${f.name}〉`)];
  if (out.skipped.length > 0) {
    log.warn(`第 ${no} 章同步：還沒收的線與伏筆超過一次能認的條數，有 ${out.skipped.length} 條沒送去`, out.skipped.join('、'));
  }

  // 本章計劃：各條線裡這一章的計劃事件（拆細綱時隨細綱寫進線裡）。
  const plan = plannedFor(book, no).map(
    (p) => `- ${p.line ?? UNFILED_NAME}：${traditionalLabel(p.event.type)}${p.event.foreshadowing ? `〈${p.event.foreshadowing}〉` : ''}——${p.event.what}`
  );
  const rest = [
    plan.length > 0 ? `【本章計劃（這一章本來要幹什麼，只幫你認；正文沒寫到的不要列）】\n${plan.join('\n')}` : '',
    `【還沒收束的敘事線】\n${lines.judged.map(judgeLine).join('\n') || '（還沒有）'}`,
    `【還沒收的伏筆】\n${fores.judged.map(judgeForeshadow).join('\n') || '（還沒有）'}`,
    '請按上面的格式寫。',
  ]
    .filter(Boolean)
    .join('\n\n');
  const text = await project.readChapterText(chapter);
  const inputBudget = Math.max(2000, opts.budget.contextWindow - opts.budget.maxOutputTokens - 1500 - estimateTokens(rest));
  const body = takeHead(text, inputBudget);
  if (body.length < text.length) {
    log.warn(`第 ${no} 章正文超出輸入預算，認敘事線時已截斷`, `${text.length} 字 → ${body.length} 字`);
  }

  // a. 認事件（2026-10-25 起按三節寫、再轉寫）。三次共用一個轉寫呼叫（「轉寫」那一檔的池只建一次）。
  const step: StepOpts = { ...opts, transcribe: transcriberOf(opts) };
  const tally = (n: number): void => {
    out.calls += n;
  };
  const asked = await askTranscribed(step, {
    label: `第 ${no} 章 · 敘事線`,
    system: THREAD_FIND_SYSTEM,
    user: `【第${no}章 ${chapter.title}】\n\n${body}\n\n${rest}`,
    temperature: 0.2,
    what: '敘事線事件',
    spec: findSpec(no),
    tally,
  });
  if (!asked.ok) {
    throw new ThreadsFindError(asked.error, out.calls);
  }
  const found = asked.value;
  // 證據對的是整章正文（不是截過的那一截）：截掉的後半章裡的原句同樣是正文。
  let finds = verifyFinds(found, { chapter: no, text, judged: lines.judged, book });
  out.dropped = [...finds.dropped];
  if (finds.relocated?.length) {
    log.info(
      `第 ${no} 章：${finds.relocated.length} 條證據不是逐字原文，換成了正文裡最接近的原句`,
      finds.relocated.map((r) => `「${r.from}」→「${r.to}」`).join('\n')
    );
  }

  // c. 歸併：新認出的線 / 伏筆，是不是已有的那一條換了個說法。兩邊都給「是什麼」與掛在哪條線（試跑：只給已有伏筆的名字，
  // 模型只能看字面，約一半並錯——「沈默臉上的屍斑」並進了「阿婆的屍斑右臂」）；伏筆的候選只有還沒收的那幾條。
  const openFore = openForeshadowing(book, no);
  if ((finds.newThreads.length > 0 && book.threads.length > 0) || (finds.newForeshadowing.length > 0 && openFore.length > 0)) {
    try {
      const user = [
        finds.newThreads.length > 0 ? `【新認出的敘事線】\n${finds.newThreads.map((t) => `- ${t.name}（${traditionalLabel(t.kind)}）${t.intent}`).join('\n')}` : '',
        finds.newThreads.length > 0
          ? `【已有的敘事線】\n${book.threads.map((t) => `- ${t.name}（${traditionalLabel(t.kind)} · ${traditionalLabel(threadStatus(asOf(t, no)))}）${clipLine(t.intent, 60)}`).join('\n')}`
          : '',
        finds.newForeshadowing.length > 0
          ? `【新認出的伏筆】\n${finds.newForeshadowing.map((f) => `- ${f.name}（掛在「${f.line ?? UNFILED_NAME}」）是什麼：${f.what || '（沒寫）'}`).join('\n')}`
          : '',
        finds.newForeshadowing.length > 0 ? `【已有的伏筆（還沒收的）】\n${openFore.map(mergeCandidate).join('\n')}` : '',
        '請按上面的格式寫。',
      ]
        .filter(Boolean)
        .join('\n\n');
      // 一條都不併（寫「無」）不轉寫；轉寫沒成照原來解析不出來的走法：記 mergeError，新認出的照新的建。
      const asked = await askTranscribed(step, {
        label: `第 ${no} 章 · 敘事線歸併`,
        system: THREAD_MERGE_SYSTEM,
        user,
        temperature: 0.1,
        what: '歸併結果',
        spec: mergeSpec(no),
        tally,
      });
      if (!asked.ok) {
        throw new Error(asked.error);
      }
      const merged = asked.value;
      // 復跑之後更保守：沒給理由的、伏筆名一個相同的詞都沒有的不併（照新的建），記一筆日誌。
      const rejected: { what: string; why: string }[] = [];
      const verified = verifyMerges(Array.isArray(merged.merges) ? merged.merges : [], finds, book, no, rejected);
      if (rejected.length > 0) {
        log.info(`第 ${no} 章：${rejected.length} 條歸併沒採納，照新的建`, rejected.map((r) => `${r.what}：${r.why}`).join('\n'));
      }
      // 新伏筆的那一條「埋」改掛到已有的那條上（已有的已經埋過就如實不記，說明寫在 note 裡），見 applyMerges。
      const applied = applyMerges(finds, verified, book, no);
      finds = applied.finds;
      out.merged = applied.merges;
      if (out.merged.length > 0) {
        log.info(
          `第 ${no} 章：${out.merged.length} 條新認出的並進了已有的`,
          out.merged.map((m) => `〈${m.from}〉→〈${m.into}〉${m.reason ? `：${m.reason}` : ''}${m.note ? `（${m.note}）` : ''}`).join('\n')
        );
      }
    } catch (err) {
      if (err instanceof CancelledError || opts.signal?.aborted) {
        throw err;
      }
      out.mergeError = describeError(err);
      log.warn(`第 ${no} 章的敘事線歸併沒成：${out.mergeError}（新認出的照新的建）`, err);
    }
  }
  finds = completeFinds(finds, no);

  await writeFinds(project, finds, no, text, out);
  // 認出來的落了盤，這一章就算判過（四期）：推水位。放在當前進度之前——那一次沒成、被取消，認出來的也已經線上裡了。
  await noteThreadsJudged(project, no);
  await updateProgress(project, chapter, out, step);

  log.info(
    `第 ${no} 章的敘事線已處理`,
    [
      describeThreads(out),
      out.dropped.length > 0 ? `沒記 ${out.dropped.map((d) => `${d.what}（${d.why}）`).join('、')}` : '',
    ]
      .filter(Boolean)
      .join('｜')
  );
  return out;
}

/**
 * 第 `no` 章的敘事線判過了（認事件 a 成了，b、c 沒成也算）：推 `project.json` 裡的水位（四期，`Workspace.markThreadsJudged`）。
 * 單章定稿、立即同步、寫完即定稿（都經 finalizeSteps.ts）與從已寫正文補記判完一章都調它。**不拋**：水位寫不進去只記一筆日誌
 * ——事件已經落線上裡了，下次判這一章（重新定稿、補記）會再推一次。
 */
export async function noteThreadsJudged(project: NovelProject, no: number): Promise<void> {
  try {
    const mark = await new Workspace(project).markThreadsJudged(no);
    log.info(`第 ${no} 章的敘事線判過了`, `水位：第 ${mark.through} 章${mark.judged.length > 0 ? `｜水位之後另外判過：${mark.judged.join('、')}` : ''}`);
  } catch (err) {
    log.warn(`第 ${no} 章的敘事線判過了，水位卻沒記上（${describeError(err)}）`, err);
  }
}

/** 落在哪條線上的鍵（缺席是「未歸屬的伏筆」，鍵是空串）。 */
const lineKey = (line: string | undefined): string => (line ? threadKey(line) : '');

/**
 * 寫盤：清掉這一章證據已經不在正文裡的機器事件（⚑7）→ 新線一條一個新檔案 → 已有的線與「未歸屬的伏筆」追加新伏筆與
 * 事件。都在寫之前那一刻重讀（`updateThread`）：這幾十秒裡作者刪了哪條線，就記不上它、說出來。
 */
async function writeFinds(project: NovelProject, finds: ThreadFinds, no: number, text: string, out: ThreadsOutcome): Promise<void> {
  const ws = new Workspace(project);
  const events = new Map<string, FoundEvent[]>();
  for (const e of finds.events) {
    events.set(lineKey(e.line), [...(events.get(lineKey(e.line)) ?? []), e]);
  }
  const fores = new Map<string, FoundForeshadow[]>();
  for (const f of finds.newForeshadowing) {
    fores.set(lineKey(f.line), [...(fores.get(lineKey(f.line)) ?? []), f]);
  }
  const done = new Set<string>();
  const asForeshadowing = (list: FoundForeshadow[]): Foreshadowing[] => list.map((f) => ({ name: f.name, what: f.what }));

  for (const t of finds.newThreads) {
    const key = lineKey(t.name);
    done.add(key);
    const mine = events.get(key) ?? [];
    const myFores = fores.get(key) ?? [];
    const rel = await ws.createThread({
      name: t.name,
      kind: t.kind,
      origin: '正文',
      intent: t.intent,
      foreshadowing: asForeshadowing(myFores),
      events: mine.map((e) => e.event),
    });
    if (!rel) {
      out.dropped.push({ what: `新線 ${t.name}`, why: '同名的檔案已經有了' });
      continue;
    }
    out.newThreads.push({ name: t.name, kind: t.kind });
    out.newForeshadowing.push(...myFores.map((f) => ({ name: f.name, line: t.name })));
    out.recorded.push(...mine);
  }

  const now = await project.readThreads();
  const files: { rel: string; line?: string }[] = [
    ...now.threads.map((t) => ({ rel: t.relPath, line: t.name })),
    { rel: now.unfiled.relPath },
  ];
  // 從「未歸屬的伏筆」挪到線上的（2026-10-24）：先照它現在的樣子（清過這一章證據已經不在的舊事件）剪出要貼的行；線那邊貼上了，
  // 未歸屬那邊（最後寫）才剪掉——線的檔案這幾十秒裡沒了，就不剪，這條伏筆照舊留在未歸屬裡。
  const moves = new Map<string, { name: string; cut: CutForeshadowing }[]>();
  if (finds.rehomed?.length) {
    let rest = pruneChapterEvents((await readTextIfExists(project.pathOf(now.unfiled.relPath))) ?? '', no, text).text;
    for (const m of finds.rehomed) {
      const c = cutForeshadowing(rest, m.name);
      if (c) {
        rest = c.text;
        moves.set(lineKey(m.line), [...(moves.get(lineKey(m.line)) ?? []), { name: m.name, cut: c.cut }]);
      }
    }
  }
  const pasted: { name: string; line: string }[] = [];
  for (const f of files) {
    const key = lineKey(f.line);
    if (done.has(key)) {
      continue;
    }
    done.add(key);
    const mine = events.get(key) ?? [];
    const myFores = fores.get(key) ?? [];
    let added: ThreadEvent[] = [];
    let addedFore: Foreshadowing[] = [];
    let removed = 0;
    const incoming = moves.get(key) ?? [];
    const leaving = f.line ? [] : pasted.map((p) => p.name);
    let moved = false;
    await ws.updateThread(f.rel, (raw) => {
      const exists = !!raw.trim();
      if (!exists && (f.line || (mine.length === 0 && myFores.length === 0))) {
        // 線的檔案這幾十秒裡沒了；「未歸屬的伏筆」沒有、也沒有要寫的，就不建。
        return undefined;
      }
      const pruned = pruneChapterEvents(exists ? raw : UNFILED_TEMPLATE, no, text);
      removed = pruned.removed.length;
      let base = pruned.text;
      for (const m of incoming) {
        base = pasteForeshadowing(base, m.cut);
      }
      for (const name of leaving) {
        base = cutForeshadowing(base, name)?.text ?? base;
      }
      moved = true;
      const withFore = appendForeshadowing(base, asForeshadowing(myFores));
      addedFore = withFore.added;
      const withEvents = appendEvents(withFore.text, mine.map((e) => e.event));
      added = withEvents.added;
      return withEvents.text;
    });
    out.pruned += removed;
    out.newForeshadowing.push(...addedFore.map((x) => ({ name: x.name, ...(f.line ? { line: f.line } : {}) })));
    out.recorded.push(...mine.filter((e) => added.includes(e.event)));
    if (moved && f.line) {
      pasted.push(...incoming.map((m) => ({ name: m.name, line: f.line! })));
    }
  }
  if (pasted.length > 0) {
    out.rehomed = pasted;
    log.info(`第 ${no} 章：${pasted.length} 條未歸屬的伏筆挪到了線上`, pasted.map((p) => `〈${p.name}〉→〈${p.line}〉`).join('\n'));
  }
  // 落在一條已經找不到的線上的（這幾十秒裡作者刪了、改了名）：記不上，說出來。
  for (const [key, mine] of events) {
    if (!done.has(key)) {
      out.dropped.push(...mine.map((e) => ({ what: e.line ?? UNFILED_NAME, why: '這條線的檔案找不到了（改了名或刪了）' })));
    }
  }
  if (out.pruned > 0) {
    log.info(`第 ${no} 章重新同步：清掉 ${out.pruned} 條證據已經不在正文裡的舊事件（舊版存進了歷史版本）`);
  }
}

/** 當前進度那一次最多列幾個人。 */
const PROGRESS_PEOPLE_MAX = 12;

/**
 * 當前進度那一次的【人物】：寫了性別的角色卡裡，標著「主角」的，與名字或別名在送去的那幾條線裡出現過的（兩個字以上才認），
 * 一人一行「- 林昭（女；又稱 小昭）」，主角在前、最多 {@link PROGRESS_PEOPLE_MAX} 個。原來的進度裡只剩「他」、一個名字都沒有時，
 * 主角也在。
 */
export function progressPeople(cards: readonly CharacterCard[], text: string): string[] {
  const named = (c: CharacterCard): boolean => [c.name, ...c.aliases].some((n) => n.trim().length >= 2 && text.includes(n.trim()));
  const lead = (c: CharacterCard): boolean => c.tags.includes('主角');
  return cards
    .filter((c) => !!c.gender && (lead(c) || named(c)))
    .sort((a, b) => Number(lead(b)) - Number(lead(a)))
    .slice(0, PROGRESS_PEOPLE_MAX)
    .map((c) => `- ${c.name}${cardNote(c)}`);
}

/**
 * b. 當前進度：本章有實際事件的那幾條線，一次寫完。照角色卡「當前狀態」的做法（第 19 條的例外）：空的或指紋對得上才寫，
 * 作者改過的不送去、掛黃 ❗ 在那條線上；已經寫到更晚那一章的不回退（重新定稿早前的章時）。寫之前那一刻再認一遍歸屬。
 */
async function updateProgress(project: NovelProject, chapter: Chapter, out: ThreadsOutcome, opts: StepOpts): Promise<void> {
  const no = chapter.order;
  const touched = new Set(out.recorded.filter((e) => e.line).map((e) => lineKey(e.line)));
  if (touched.size === 0) {
    return;
  }
  const book = await project.readThreads();
  const ws = new Workspace(project);
  const send: LineThread[] = [];
  for (const t of book.threads) {
    if (!touched.has(lineKey(t.name)) || (t.progressThrough !== undefined && t.progressThrough > no)) {
      continue;
    }
    if (!progressOwnedByMachine(t)) {
      out.guarded.push(t.name);
      await recordFailure(project, {
        scope: '叙事线',
        targetKind: 'threads',
        targetKey: t.relPath,
        severity: 'warn',
        op: PROGRESS_OP,
        message: `第 ${no} 章同步時給這條線記了新進展，「當前進度」你改過，沒有覆蓋`,
        detail: '這一節你改過，就歸你寫了，機器不再覆蓋。想讓同步接著維護，把這一節清空，下次同步就會寫。',
      });
      continue;
    }
    send.push(t);
  }
  if (send.length === 0) {
    return;
  }
  const mine = (t: LineThread): string =>
    out.recorded
      .filter((e) => lineKey(e.line) === lineKey(t.name))
      .map((e) => `${traditionalLabel(e.event.type)}${e.event.foreshadowing ? `〈${e.event.foreshadowing}〉` : ''}：${e.event.what}`)
      .join('；');
  // 線名單獨一行（試跑：寫成「名字（種類）」，模型照抄回來、對不上，22 條只落盤 1 條），種類另起一行。
  const body = send
    .map((t) =>
      [`【線】${t.name}`, `種類：${traditionalLabel(t.kind)}`, `意圖：${t.intent || '（沒寫）'}`, `原來的當前進度：${t.progress || '（空）'}`, `這一章：${mine(t)}`].join('\n')
    )
    .join('\n\n');
  // 誰是男是女（2026-10-24）：這一次不帶正文，只有名字的模型預設寫「他」，原來的進度錯一次就一直錯下去。
  const people = progressPeople(await project.listCharacters().catch(() => []), body);
  const user =
    `【第${no}章 ${chapter.title}】\n\n` +
    (people.length > 0 ? `【人物】\n${people.join('\n')}\n\n` : '') +
    body +
    '\n\n請按上面的格式寫。';
  try {
    const asked = await askTranscribed(opts, {
      label: `第 ${no} 章 · 敘事線當前進度`,
      system: THREAD_PROGRESS_SYSTEM,
      user,
      temperature: 0.3,
      what: '当前进度',
      spec: progressSpec(no),
      tally: (n) => {
        out.calls += n;
      },
    });
    // 轉寫沒成照原來解析不出來的走法：記 progressError，認出來的照樣算數。
    if (!asked.ok) {
      throw new Error(asked.error);
    }
    const answer = asked.value;
    const list = Array.isArray(answer.progress) ? answer.progress : [];
    const items = verifyProgress(list, send.map((t) => t.name));
    // 送去了卻沒寫上的：說出來（第 2 條），日誌裡帶上模型回的線名，看得出是沒回還是名字對不上。
    out.unwritten = send.filter((t) => !items.some((i) => i.line === t.name)).map((t) => t.name);
    if (out.unwritten.length > 0) {
      const named = list.map((x) => (x && typeof x === 'object' ? String((x as Record<string, unknown>).line ?? '') : '')).filter(Boolean);
      log.warn(
        `第 ${no} 章：${out.unwritten.length} 條線的當前進度沒寫上（模型沒回，或回的線名認不出）`,
        `沒寫上的：${out.unwritten.join('、')}\n模型回的線名：${named.join('、') || '（沒有）'}`
      );
    }
    for (const item of items) {
      const t = send.find((x) => x.name === item.line)!;
      let mineNow = true;
      await ws.updateThread(t.relPath, (raw) => {
        // 這幾十秒裡作者改了這一節：照樣不覆蓋。
        if (!raw.trim() || !progressOwnedByMachine(parseThreadFile(raw, t.relPath))) {
          mineNow = false;
          return undefined;
        }
        return patchProgress(raw, item.text, no);
      });
      if (mineNow) {
        await clearFailures(project, 'threads', t.relPath, PROGRESS_OP);
        out.progressed.push(t.name);
      } else {
        out.guarded.push(t.name);
      }
    }
  } catch (err) {
    if (err instanceof CancelledError || opts.signal?.aborted) {
      throw err;
    }
    out.progressError = describeError(err);
    log.warn(`第 ${no} 章的敘事線當前進度沒更新成：${out.progressError}`, err);
  }
}

/**
 * 完成提示裡敘事線那一句（設計稿：一定說敘事線）：「敘事線：林昭與沈青推進、關係；埋〈玉佩的來歷〉；新認出 1 條線〈沈家舊案〉
 * （支線）」；什麼都沒認出就說「敘事線沒有新進展」。當前進度、沒記的、清掉的舊記錄、沒成的那一步跟在後面（第 2 條）。
 */
export function describeThreads(o: ThreadsOutcome): string {
  const fresh = new Set(o.newThreads.map((t) => lineKey(t.name)));
  const byLine = new Map<string, { line: string; types: string[] }>();
  const fores: string[] = [];
  for (const e of o.recorded) {
    if (isForeshadowEvent(e.event.type)) {
      const s = `${traditionalLabel(e.event.type)}〈${e.event.foreshadowing}〉`;
      if (!fores.includes(s)) {
        fores.push(s);
      }
    } else if (e.line && !fresh.has(lineKey(e.line))) {
      const entry = byLine.get(lineKey(e.line)) ?? { line: e.line, types: [] };
      if (!entry.types.includes(e.event.type)) {
        entry.types.push(e.event.type);
      }
      byLine.set(lineKey(e.line), entry);
    }
  }
  const news = [
    ...[...byLine.values()].map((x) => `${x.line}${x.types.map(traditionalLabel).join('、')}`),
    ...fores,
    o.newThreads.length > 0 ? `新認出 ${o.newThreads.length} 條線${o.newThreads.map((t) => `〈${t.name}〉（${traditionalLabel(t.kind)}）`).join('')}` : '',
    ...o.merged.map((m) => `〈${m.from}〉並進了〈${m.into}〉${m.note ? `（${m.note}）` : ''}`),
    ...(o.rehomed ?? []).map((m) => `〈${m.name}〉從未歸屬挪到了〈${m.line}〉`),
  ].filter(Boolean);
  const whys = [...new Set(o.dropped.map((d) => d.why))];
  const extra = [
    o.progressed.length > 0 ? `${o.progressed.join('、')}的當前進度更新到這一章` : '',
    o.guarded.length > 0 ? `${o.guarded.join('、')}的當前進度你改過，沒有覆蓋（線上掛了黃 ❗）` : '',
    o.unwritten.length > 0 ? `${o.unwritten.length} 條線的當前進度沒寫上（${o.unwritten.join('、')}：模型沒回，或回的線名認不出）` : '',
    o.dropped.length > 0 ? `另有 ${o.dropped.length} 條敘事線的記錄沒有收（${whys.join('；')}）` : '',
    o.pruned > 0 ? `清掉 ${o.pruned} 條證據已經不在正文裡的舊記錄` : '',
    o.progressError ? `敘事線的當前進度沒更新成（${o.progressError}）` : '',
    o.mergeError ? `敘事線的歸併沒判成（${o.mergeError}），新認出的照新的建了` : '',
  ].filter(Boolean);
  return [news.length > 0 ? `敘事線：${news.join('；')}` : '敘事線沒有新進展', ...extra].join('；');
}

// ---------------------------------------------------------------- 作者標收束 / 放棄

/** 作者在工程頁上能給一條線標的兩種結局。 */
export type ThreadEnding = '收束' | '放弃';

/**
 * 工程頁敘事線一行右鍵「標為收束」「標為放棄」（2026-10-24 作者定的）：同步漏報了收束，這條線就一直「進行中」、掛著「斷了 N 章」——
 * 認事件只列本章有動靜的線，後面幾十章都不會再補報。零呼叫，先問一句；在這條線最近一次實際事件那一章**追加**一條作者事件
 * （不帶證據：重新同步那一章不會清掉它，見 `pruneChapterEvents`；同章寫在最後，狀態取它）。還沒有實際事件的線只能放棄，記在
 * 敘事線判到的那一章。掛在它下面還沒收的伏筆不動（照樣提醒，要收要棄在檔案裡記）。
 */
export async function markThreadEnded(project: NovelProject, relPath: string, type: ThreadEnding): Promise<void> {
  const host = getHost();
  const t = (await project.readThreads()).threads.find((x) => x.relPath === relPath);
  if (!t) {
    host.toast('找不到這條線的檔案，可能剛被改名或刪掉了。', 'error');
    return;
  }
  const status = threadStatus(t);
  if (isClosed(status)) {
    host.toast(`〈${t.name}〉已經是「${traditionalLabel(status)}」了。`);
    return;
  }
  const last = lastActiveChapter(t);
  if (last === undefined && type === '收束') {
    host.toast(`〈${t.name}〉還沒有發生過任何事，標不了收束；不打算寫了就標為放棄。`, 'error');
    return;
  }
  const chapter = last ?? Math.max(1, (await project.readThreadsMark()).through);
  const open = foreshadowingOf(t, chapter).filter((f) => !isForeshadowClosed(f.status)).length;
  const verb = `標為${traditionalLabel(type)}`;
  const picked = await host.confirm(`把〈${t.name}〉${verb}？`, [verb], {
    modal: true,
    detail: [
      `在第 ${chapter} 章${last !== undefined ? '（它最近一次有動靜的那一章）' : '（敘事線判到的那一章）'}記一條「${traditionalLabel(type)}」，不調模型。`,
      '之後它不再算斷了、不再送去同步認事件，寫正文與拆細綱也不再帶它。',
      open > 0 ? `掛在它下面還有 ${open} 條伏筆沒收，這裡不動，要收要棄在檔案裡記。` : '',
      '想撤銷，開啟這條線的檔案刪掉那一行。',
    ]
      .filter(Boolean)
      .join('\n'),
  });
  if (picked !== verb) {
    return;
  }
  const event: ThreadEvent = { chapter, planned: false, type, what: `作者${verb}` };
  let added = false;
  await new Workspace(project).updateThread(relPath, (raw) => {
    if (!raw.trim()) {
      return undefined;
    }
    const r = appendEvents(raw, [event]);
    added = r.added.length > 0;
    return r.text;
  });
  if (added) {
    log.info(`〈${t.name}〉作者${verb}`, `記在第 ${chapter} 章`);
    host.toast(`〈${t.name}〉已${verb}（記在第 ${chapter} 章）。`);
  } else {
    host.toast(`〈${t.name}〉沒記上：這條線的檔案沒了，或那一章已經有一樣的一條。`, 'error');
  }
}
