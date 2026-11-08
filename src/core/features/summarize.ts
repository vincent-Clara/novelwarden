import { traditionalLabel } from '../model/labels';
/**
 * 定稿第一步與全文大綱的編排。
 *
 * - `summarizeChapter`：照 `chapters/` 的正文反向更新這一章的細綱（正文映象的那一份）。手上有細綱就對照著改
 *   （`REFINE_SYSTEM`：以正文為準，一致的保留原措辭），細綱是空的就照正文從頭整理（`SUMMARY_SYSTEM`）。
 *   按八個小標題寫 1 次、轉寫成 JSON 再 1–2 次；轉寫沒成按小節讀原文，都讀不出來才紅 ❗、細綱不動
 *   （`SummarizeError` 帶著調了幾次）。落盤走 `Workspace.finalizePlot`：舊版先進回收站，七節整體替換。
 * - 連續性事實的證據在這裡掛：模型只給陳述，證據句用 bigram 在整章正文裡找（`model/continuity.ts`），找不到的丟掉。
 * - `syncSummaries`（工程頁「立即同步」）：先併發照正文更新細綱（`summarizeChapters`），再按章號序列走角色狀態與
 *   敘事線（`finalizeSteps.ts`）；中途取消時後兩步沒走到的章掛黃 ❗。
 * - `updateGlobalSummary`：舊摘要 + 之後定稿過的各章細綱，1 次出新版；批次寫章「寫完即定稿」落後
 *   `GLOBAL_SUMMARY_EVERY` 章調一次。`rebuildGlobalSummary` 收所有定稿過的細綱重建。
 *
 * 系統提示詞在 summarizePrompt.ts。
 */
import { getHost } from '../host';
import { basename } from 'node:path';
import { collectText, mergeUsage } from '../llm/collect';
import { CancelledError, LlmProvider, StreamOptions, TokenUsage } from '../llm/provider';
import { ModelPool, createModelPool } from '../llm/pool';
import { resolveProvider } from '../llm/registry';
import { runPool } from '../runtime/concurrency';
import { clearFailures, recordFailure } from '../runtime/errorLog';
import { pickSections } from '../model/markdown';
import { readConfig } from '../config';
import { describeError, elapsed, formatDuration, scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { castFromText, parseCastEntry, pushCast, renderCastEntry } from '../model/castParse';
import { NovelProject } from '../model/project';
import { PLOT_SECTION_KEYS, Plot, PlotSectionKey, PlotSections, emptyPlotSections, parsePlotFileName } from '../model/plotFile';
import { CallChoice } from '../model/callChoice';
import { withCallChoice } from '../runtime/callScope';
import { askCall } from './askCall';
import { CallEstimate, FINALIZE_CALLS, describeCalls } from '../model/pipeline';
import { Chapter, SummaryCast } from '../model/types';
import { ContinuityFact, attachEvidence, parseContinuityFacts, renderContinuityFacts } from '../model/continuity';
import { sanitizeAliases } from '../model/naming';
import { LoreLine, PLOT_LORE_KEY, loreLinesFromJson, parseLoreLines, renderLoreLines } from '../model/loreFile';
import { checkLore, loreHint } from './loreRecord';
import { STATE_OP } from './characterState';
import { StateAndThreadsOutcome, updateStateAndThreads } from './finalizeSteps';
import { checkpointBefore } from './checkpoint';
import { describeUsage, estimateTokens, recordUsage, takeHead } from '../context/tokenizer';
import { extractJsonObject, stripCodeFence, stripTrailingCommas } from './parse';
import { GLOBAL_SYSTEM, REFINE_SYSTEM, STAGE_SYSTEM, SUMMARY_JSON_CONTRACT, SUMMARY_SYSTEM } from './summarizePrompt';
import { TranscribeCall, TranscribeSpec, transcribeJson } from './transcribe';
import { poolTranscriber } from './poolIO';
import { Workspace } from '../workspace';

const log = scoped('同步');
const globalLog = scoped('全文大綱');

/**
 * 定稿時模型交回來的結構化形態：七個小節 + 機器可讀的出場人物清單 + 「設定」一節（設定名錄）。
 *
 * 2026-10-25 起模型按八個小標題寫，轉寫模型照抄成這個形狀的 JSON（從前要模型直接出）。小節最終要渲染成人類可讀的 Markdown（作者會翻、
 * 會手改），`cast` 則是給程式用的——出場統計、角色卡的關聯都吃它。`lore` 是模型給的原樣，
 * 寫盤之前還要過一遍校驗（features/loreRecord.ts 的 `checkLore`）。
 */
export interface SummaryData {
  sections: PlotSections;
  cast: SummaryCast[];
  lore: LoreLine[];
}

/**
 * 定稿第一步寫好的那份細綱：落盤的七節與出場人物，外加連續性事實掛證據的結果——
 * 定稿（features/finalize.ts）要拿出場人物去更新角色狀態，丟了幾條事實要說出來。
 */
export interface SummaryOutcome extends SummaryData {
  relPath: string;
  /** 舊版細綱在回收站裡的位置。原來沒有細綱（拆書匯入、作者手寫的正文）時沒有。 */
  trashed?: string;
  /** 掛上了證據、寫進細綱的連續性事實。 */
  facts: ContinuityFact[];
  /** 正文裡找不到依據、丟掉的事實（D18，第 2 條：說出來）。 */
  dropped: string[];
  /** 這一步實際調了幾次模型：寫 1 次，轉寫 0–2 次（2026-10-25 起改成轉寫）。 */
  calls: number;
}

/**
 * 更新細綱沒成（模型的回答讀不出來）。帶著這一步已經調了幾次（寫 1 次，加上轉寫的），批次那邊照它記賬——
 * 請求發出去了錢就花了。
 */
export class SummarizeError extends Error {
  constructor(
    message: string,
    readonly calls: number
  ) {
    super(message);
    this.name = 'SummarizeError';
  }
}

/** 更新細綱沒成時這一步調了幾次：讀不出來的帶著實數，別的錯（網路、超時）是寫的那 1 次。 */
export function summarizeCallsOf(err: unknown): number {
  return err instanceof SummarizeError ? err.calls : 1;
}

/** 轉寫那一步的規格（2026-10-25 起改成轉寫）：形狀就是 {@link parseSummaryJson} 認的那一份，文字全部要出自原文。 */
const SUMMARY_TRANSCRIBE: TranscribeSpec<SummaryData> = {
  label: '細綱',
  contract: SUMMARY_JSON_CONTRACT,
  decode: (json) => {
    const data = parseSummaryJson(json);
    return data ? { ok: true, value: data } : { ok: false, message: '梗概與關鍵事件都是空的' };
  },
  // 連「梗概」「關鍵事件」都沒有的（「好的，這一章主要寫了……」）不花轉寫那一次，按讀不出來走。
  looksLike: (source) => /梗概|(?:关|關)(?:键|鍵)事件/.test(source),
};

/**
 * 模型的回答 → 八節（2026-10-25 起改成轉寫）：
 *
 * 1. 模型自己給了 JSON（沒照格式寫、老會話、測試裡的假模型）：照原來的解碼，不轉。
 * 2. 按小標題寫的：轉寫模型照抄成 JSON（`SUMMARY_JSON_CONTRACT`），查過每段文字都出自原文。
 * 3. 轉寫沒成（呼叫失敗、兩次都改了字）：照原來的第二層按小節讀原文（{@link parseSummaryResponse}）——原文就是按小節寫的，
 *    七節讀得出來，出場人物與設定從那兩節的文字裡認。說明裡寫清。
 *
 * 三樣都讀不出來交回空的七節，由呼叫方報失敗、細綱不動（同從前）。
 */
async function readSummary(
  raw: string,
  transcribe: TranscribeCall,
  no: number
): Promise<{ data: SummaryData; calls: number; notes: string[] }> {
  const direct = parseSummaryJson(stripCodeFence(raw));
  if (direct) {
    return { data: direct, calls: 0, notes: [] };
  }
  const r = await transcribeJson(raw, { ...SUMMARY_TRANSCRIBE, label: `第 ${no} 章細綱` }, transcribe);
  if (r.ok) {
    return { data: r.value, calls: r.calls, notes: r.notes };
  }
  const notes = [...r.notes];
  if (r.calls > 0) {
    notes.push(`第 ${no} 章細綱沒轉寫成（${r.message}），按小節讀了原文：出場人物與設定從那兩節的文字裡認`);
  }
  return { data: parseSummaryResponse(raw), calls: r.calls, notes };
}

/**
 * 照正文反向更新一章的細綱（定稿的第一步：寫 1 次，2026-10-25 起再由轉寫模型照抄成 JSON 1–2 次）。返回寫好的那一份；
 * 沒有模型、正文是空的時返回 undefined（已經說過原因）。
 *
 * 讀的是 `chapters/`：細綱定稿後描述的是寫出來的那一章。**手上有細綱就拿它與正文對照著改**
 * （`REFINE_SYSTEM`：以正文為準，一致的保留原措辭，寫偏的改、沒寫到的刪）——這是修改，不是重寫；
 * 細綱是空的（拆書匯入、作者手寫的正文）就照正文從頭整理（`SUMMARY_SYSTEM`）。老工程裡那些從沒
 * 經過本工具的章因此也能直接定稿，不需要任何遷移。
 *
 * 連續性事實（D18）的證據在這裡掛：模型只給事實陳述，證據句用 bigram 在**整章**正文裡找
 * （model/continuity.ts），不調模型。找不到依據的事實丟掉並記日誌。落盤前舊版細綱複製一份進
 * `.trash/`（`Workspace.finalizePlot`）。
 */
export async function summarizeChapter(
  project: NovelProject,
  chapter: Chapter,
  provider?: LlmProvider,
  signal?: AbortSignal,
  /**
   * 這次呼叫實際用的模型的視窗。批次入口從 `pool.primaryBudget` 傳進來——
   * 分檔後幹活的模型未必是對話頁選的那個，拿它的視窗切正文會超窗。
   * 單章入口（命令面板）不傳，退回全域配置。
   */
  budget?: { contextWindow: number; maxOutputTokens: number },
  /**
   * 轉寫那一次怎麼調（2026-10-25 起改成轉寫）。定稿、同步從外面傳一個進來，幾步共用同一個轉寫池；預設現建一個，
   * 轉寫那一檔一個可用的模型都沒有時用寫的這一個。
   */
  transcribe?: TranscribeCall
): Promise<SummaryOutcome | undefined> {
  const llm = provider ?? (await resolveProvider());
  if (!llm) {
    log.warn(`第 ${chapter.order} 章跳過：沒有可用的模型（未配置或未錄入 API Key）`);
    return undefined;
  }
  const config = readConfig();
  const window = budget ?? { contextWindow: config.contextWindow, maxOutputTokens: config.maxOutputTokens };
  const text = await project.readChapterText(chapter);
  if (!text.trim()) {
    log.warn(`第 ${chapter.order} 章《${chapter.title}》還沒有正文，跳過`);
    getHost().toast(`第 ${chapter.order} 章還沒有正文，沒有可同步的東西。`);
    return undefined;
  }

  // 單章正文通常遠小於視窗；極長的章按輸入預算截斷。
  const inputBudget = Math.max(2000, window.contextWindow - window.maxOutputTokens - 1500);
  const body = takeHead(text, inputBudget);
  if (body.length < text.length) {
    log.warn(
      `第 ${chapter.order} 章正文超出輸入預算，已截斷`,
      `原文 ${text.length} 字 → ${body.length} 字（預算 ${inputBudget} token）`
    );
  }

  const usage: TokenUsage = {};
  const options: StreamOptions = {
    maxOutputTokens: window.maxOutputTokens,
    temperature: 0.3, // 定稿要穩定、可復現，壓低溫度
    timeoutMs: config.requestTimeoutMs,
    signal,
  };

  // 手上那份細綱（計劃，或上一次定稿的檔案）：正文映象的那一份。一節都沒填就當沒有：照正文從頭整理。
  const plan = await project.plotOfChapter(chapter);
  const planText = plan ? renderPlanForPrompt(plan) : '';
  const system = planText ? REFINE_SYSTEM : SUMMARY_SYSTEM;

  const startedAt = Date.now();
  log.debug(
    `第 ${chapter.order} 章《${chapter.title}》請求模型`,
    `模型 ${llm.label}｜正文 ${body.length} 字（約 ${estimateTokens(body)} token）｜` +
      (planText ? `帶當前細綱 ${planText.length} 字` : '沒有細綱，照正文整理')
  );

  // 把已有角色卡的名字告訴模型：cast 裡的 name 要能跟角色卡對上，
  // 「林昭」和「昭公子」各寫一份會讓角色頁憑空多出一個人。設定同理：分類表與這一章提到的已有設定。
  const known = await knownNamesHint(project);
  const loreKnown = await loreHint(project, text, plan);
  const head = `第${chapter.order}章 ${chapter.title}`;
  const userPrompt = planText
    ? `${known}${loreKnown}請照下面這一章的正文，把它的當前細綱改成正文實際寫成的樣子。\n\n【${head} · 當前細綱】\n\n${planText}\n\n【${head} · 正文】\n\n${body}`
    : `${known}${loreKnown}請為下面這一章整理細綱。\n\n【${head}】\n\n${body}`;
  // 校準統計比的是「整個請求的輸入」，因此估算也要含系統提示詞，
  // 否則這條樣本會系統性地偏低，把 tokenCounter 的比值帶歪。
  const estimated = estimateTokens(system) + estimateTokens(userPrompt);

  const raw = await collectText(
    llm.stream(
      [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt },
      ],
      options
    ),
    { onUsage: (u) => mergeUsage(usage, u) }
  );

  const transcriber =
    transcribe ?? poolTranscriber(signal ?? new AbortController().signal, { run: (_what, fn) => fn(llm), primaryBudget: window });
  const read = await readSummary(raw, transcriber, chapter.order);
  const calls = 1 + read.calls;
  if (read.notes.length > 0) {
    log.warn(`第 ${chapter.order} 章細綱的轉寫不順`, read.notes.join('\n'));
  }
  const { sections, cast, lore: rawLore } = read.data;
  if (!sections.梗概.trim() && !sections.关键事件.trim()) {
    log.error(
      `第 ${chapter.order} 章同步解析失敗：模型返回既不是 JSON 也不符合小節格式`,
      `返回 ${raw.length} 字，開頭：${raw.slice(0, 300)}${read.calls > 0 ? `｜轉寫 ${read.calls} 次也沒成` : ''}`
    );
    // 也在這裡記一條，而不是隻靠 syncSummaries 的 onSettled：主按鈕「定稿」
    // 走的是單章路徑，那條異常會一路拋到命令外層，根本到不了批次編排裡。
    // 同一章 + 同一動作只留最新一條，兩條路徑都記也不會重複顯示。
    await recordFailure(project, {
      scope: '同步',
      targetKind: 'chapter',
      targetKey: chapter.relPath,
      severity: 'error',
      op: 'summarize',
      message: '同步失敗：模型返回無法解析',
      detail:
        `模型返回 ${raw.length} 字，沒有按八個小標題寫，也不是 JSON${read.calls > 0 ? '（轉寫也沒轉成）' : ''}。細綱沒有改動；` +
        '這一章的連續性事實與出場人物不會進入上下文。換個模型或稍後重試。',
    });
    throw new SummarizeError(`第 ${chapter.order} 章同步失敗，模型返回內容無法解析。`, calls);
  }
  // 連續性事實掛證據：在整章正文裡找（截給模型的那一份可能只有前半章）。人名給出場人物的
  // 名字與別名——事實裡提到誰，就先在提到他的句子裡找。
  const statements = parseContinuityFacts(sections.连续性事实).map((f) => f.statement);
  const { facts, dropped } = attachEvidence(
    statements,
    text,
    cast.flatMap((c) => [c.name, ...c.aliases])
  );
  sections.连续性事实 = renderContinuityFacts(facts);
  if (dropped.length > 0) {
    log.warn(
      `第 ${chapter.order} 章有 ${dropped.length} 條連續性事實在正文裡找不到依據，已丟棄`,
      dropped.map((d) => `- ${d}`).join('\n')
    );
  }
  // 「設定」一節：名字要逐字出現在正文裡、說明要找得到依據、人名不算（不調模型）。
  const lore = await checkLore(project, chapter, rawLore, text, cast.flatMap((c) => [c.name, ...c.aliases]));
  const { rel: relPath, trashed } = await new Workspace(project).finalizePlot(chapter, sections, cast, lore);
  // 這一章好了：把它掛著的舊感嘆號收掉（上次可能是超時/解析失敗）。
  await clearFailures(project, 'chapter', chapter.relPath, 'summarize');
  // 批次寫章停在這一章時掛在細綱上的黃 ❗（「寫進去了，但沒寫夠八成……沒有定稿」）：作者看過、定稿了，它就過時了
  // （定稿是人工閘口，第 23 條）。從前只有批次把這一章寫成才清，單章定稿、立即同步之後一直掛著（試跑報告第 11 條）。
  await clearFailures(project, 'plot', relPath, 'manuscript');
  // 批次同步一次要跑幾十章，是最燒 token 的動作之一；有實測用量就記一筆，
  // 供 tokenCounter 的校準統計使用。
  recordUsage('同步', estimated, usage);
  const usageNote = describeUsage(estimated, usage);
  log.info(
    `第 ${chapter.order} 章《${chapter.title}》細綱已照正文更新`,
    `${relPath}｜耗時 ${elapsed(startedAt)}｜返回 ${raw.length} 字｜` +
      `出場 ${cast.length} 人${cast.length > 0 ? `（${cast.map((c) => c.name).join('、')}）` : ''}` +
      `｜連續性事實 ${facts.length} 條｜設定 ${lore.length} 條` +
      `${trashed ? `｜舊版已放進回收站：${trashed}` : '｜原來沒有細綱，新建了一份'}` +
      `${read.calls > 0 ? `｜轉寫 ${read.calls} 次` : ''}` +
      `${usageNote ? `｜${usageNote}` : ''}`
  );
  return { relPath, trashed, sections, cast, lore, facts, dropped, calls };
}

/**
 * 當前細綱 → 發給模型的那一段（`## 小節` 一節一段）。一節都沒填（只起了個頭的空殼）給空串——
 * 那時照正文從頭整理。連續性事實不給：那是上一次定稿從正文裡摘的，證據要回原文逐字校驗，
 * 這一次照樣從正文重新摘，把舊的給它只會讓它照抄已經對不上的句子。「設定」一節給：那是計劃用到的，
 * 要改成實際出現的。
 */
function renderPlanForPrompt(plan: Plot): string {
  const sections = PLOT_SECTION_KEYS.filter((key) => key !== '连续性事实' && plan.sections[key].trim()).map(
    (key) => `## ${traditionalLabel(key)}\n${plan.sections[key].trim()}`
  );
  if (sections.length === 0) {
    return '';
  }
  if (plan.lore?.length) {
    sections.push(`## ${traditionalLabel(PLOT_LORE_KEY)}\n${renderLoreLines(plan.lore)}`);
  }
  return sections.join('\n\n');
}

/**
 * 「已有角色卡」提示段。沒有角色卡時返回空串（不要為此多佔幾十 token）。
 *
 * 只給名字與別名，不給卡的內容——這裡要的是**統一命名**，不是讓模型
 * 照著角色卡複述劇情。角色卡本身在「更新角色卡」那條流程裡才完整注入。
 */
async function knownNamesHint(project: NovelProject): Promise<string> {
  const cards = await project.listCharacters();
  if (cards.length === 0) {
    return '';
  }
  const list = cards
    .map((c) => {
      const aliases = sanitizeAliases(c.aliases, c.name);
      return aliases.length > 0 ? `${c.name}（又稱 ${aliases.join('、')}）` : c.name;
    })
    .join('、');
  return `已有角色卡：${list}。出場人物中若出現這些人，姓名請與此處完全一致。\n\n`;
}


/**
 * 工程頁黃條上的「立即同步」：把所有沒定稿、或定稿之後正文又改過的章逐章定稿，帶進度，可取消。三步與單章定稿
 * 同一套（finalize.ts）：
 *
 * 1. 照正文更新細綱：各章之間無先後，按配置併發（`summarizeChapters`）；
 * 2. 角色狀態、敘事線（finalizeSteps.ts）：**按章號序列**——角色卡的「當前狀態」要一章一章往後推，
 *    敘事線事件按章追加，併發會兩章搶寫同一張卡、同一條線。第一步沒成的章不走這兩步。
 *
 * 從前只做第一步，章被標成已定稿、角色狀態與敘事線卻停在原地，而同步過的章不再「待定稿」，黃條也不會
 * 再提醒，只能逐章重新定稿去補。中途取消時，細綱已經更新、這兩步還沒走到的章掛黃 ❗（第 16 條：部分完成）。
 *
 * 返回**實際呼叫了幾次模型**（取消或無事可做時是 0）——MCP 的 `summary` 工具拿它記賬。
 */
export async function syncSummaries(project: NovelProject): Promise<number> {
  log.info('開始檢查哪些章還沒同步');
  const scanStart = Date.now();
  const stale = await project.staleChapters();
  const total = (await project.listChapters()).length;
  log.info(
    `檢查完成：${total} 章中有 ${stale.length} 章沒同步或同步後正文改過`,
    `耗時 ${elapsed(scanStart)}${stale.length > 0 ? `｜待同步：${describeNos(stale)}` : ''}`
  );

  if (stale.length === 0) {
    getHost().toast('所有寫了正文的章都已同步，細綱與正文對得上。');
    return 0;
  }

  const lanes = Math.min(readConfig().concurrency, stale.length);
  const each = FINALIZE_CALLS;
  const calls: CallEstimate = { low: stale.length * each.low, high: stale.length * each.high, max: stale.length * each.max };
  const answer = await askCall({
    message: `有 ${stale.length} 章寫了正文還沒同步（或同步後正文又改過），逐章同步：照正文更新細綱、更新出場角色的當前狀態、認這一章在敘事線上發生了什麼、推這一章的故事時間。${describeCalls(calls)}。現在同步？`,
    actions: ['開始同步'],
    detail:
      `每章 ${each.low}–${each.high} 次（${each.why}）。\n` +
      (lanes > 1 ? `照正文更新細綱併發 ${lanes} 路；` : '照正文更新細綱逐章序列（併發數為 1）；') +
      '角色狀態、敘事線與故事時間按章號逐章序列（要一章一章往後推）。\n每章的舊版細綱先複製一份進 .novelwarden/.trash/。',
    tasks: ['plotSummary', 'characterCard', 'transcribe'],
    // 定稿認敘事線帶幾條線、幾條伏筆隨詳細度（`recordThreads`）。
    contextDetail: true,
  });
  if (answer?.action !== '開始同步') {
    log.info('使用者取消了同步');
    return 0;
  }

  return withCallChoice(answer.choice, async () => {
    const pool = await createModelPool({ task: 'plotSummary', concurrent: lanes > 1 });
    if (!pool) {
      log.error('沒有可用的模型，同步中止');
      return 0;
    }
    // 角色狀態走「角色卡」檔（與批次寫章「寫完即定稿」同一個分法），沒配就沿用定稿那一檔。
    const statePool = (await createModelPool({ task: 'characterCard', concurrent: false })) ?? pool;
    log.info(`使用模型 ${pool.label}`, lanes > 1 ? `併發 ${lanes} 路，輪轉負載均衡` : '序列');

    let used = 0;
    await runTask(
      '同步章節細綱',
      async ({ signal, report }) => {
        // 先存一個存檔點（features/checkpoint.ts）：逐章改細綱、角色卡與敘事線，整本退得回去。
        await checkpointBefore(project, `同步章節細綱之前（${stale.length} 章）`);
        const startedAt = Date.now();
        // 轉寫（2026-10-25 起）：幾章幾步共用一個轉寫池，第一次用到時才建；那一檔一個可用的模型都沒有時用定稿那一檔。
        const transcribe = poolTranscriber(signal, pool);
        const { ok: okCount, failed, updated, calls: summaryCalls } = await summarizeChapters(project, stale, { pool, lanes, signal, report, transcribe });
        used += summaryCalls;
        if (signal.aborted) {
          log.warn(`同步被取消，已更新 ${okCount} 章細綱，角色狀態與敘事線一章都沒走`);
          await markHalfDone(project, updated);
          return;
        }

        // 第二步：按章號序列（updated 已按章號排好）。
        const partial: number[] = [];
        const results: StateAndThreadsOutcome[] = [];
        for (let i = 0; i < updated.length; i++) {
          const { chapter, summary } = updated[i];
          report({ message: `角色狀態、敘事線與故事時間 · 第 ${chapter.order} 章《${chapter.title}》`, current: i, total: updated.length });
          try {
            const rest = await updateStateAndThreads(project, chapter, summary.cast, {
              state: statePool,
              threads: pool,
              signal,
              transcribe,
            });
            used += rest.calls;
            results.push(rest);
            if (rest.stateError || rest.threadsError || rest.timeError || rest.threads?.progressError || rest.threads?.mergeError) {
              partial.push(chapter.order);
            }
          } catch (err) {
            if (err instanceof CancelledError || signal.aborted) {
              log.warn(`同步被取消，停在第 ${chapter.order} 章的角色狀態與敘事線`);
              await markHalfDone(project, updated.slice(i));
              return;
            }
            throw err;
          }
        }

        report({ message: '收尾', current: updated.length, total: updated.length });
        const notes = [
          failed.length > 0 ? `第 ${failed.map((f) => f.no).join('、')} 章細綱沒更新成` : '',
          partial.length > 0 ? `第 ${partial.join('、')} 章的角色狀態、敘事線或故事時間沒更新成（掛了黃 ❗）` : '',
        ].filter(Boolean);
        if (notes.length > 0) {
          log.warn(
            `同步結束：${okCount} 章已同步，${notes.join('；')}`,
            failed.map((f) => `第 ${f.no} 章：${f.reason}`).join('\n')
          );
          getHost().toast(`${okCount} 章已同步；${notes.join('；')}；${describeSynced(results)}。可在日誌頁看原因。`);
        } else if (okCount > 0) {
          log.info(`同步結束：${okCount} 章全部同步`, `總耗時 ${elapsed(startedAt)}`);
          getHost().toast(`已同步 ${okCount} 章：細綱照正文更新；${describeSynced(results)}。`);
        }
      },
      { scope: '同步' }
    );
    return used;
  });
}

/**
 * 「立即同步」完成提示裡角色狀態與敘事線那半句，按實際結果說（從前一律說「跟到了這幾章」，一條線都沒有時也這麼說）：
 * 「林昭的當前狀態更新到了最後定稿的那一章；敘事線：記下 5 個事件，新認出 1 條線、2 條伏筆」，什麼都沒有就說
 * 「敘事線沒有新進展」。沒收的記錄、沒寫上的當前進度跟在後面（第 2 條；試跑：單章定稿說了，同步沒說）。
 */
export function describeSynced(results: readonly StateAndThreadsOutcome[]): string {
  const names = [...new Set(results.flatMap((r) => r.states?.updated ?? []))];
  const sum = (f: (r: StateAndThreadsOutcome) => number): number => results.reduce((n, r) => n + f(r), 0);
  const events = sum((r) => r.threads?.recorded.length ?? 0);
  const lines = sum((r) => r.threads?.newThreads.length ?? 0);
  const fores = sum((r) => r.threads?.newForeshadowing.length ?? 0);
  const dropped = sum((r) => r.threads?.dropped.length ?? 0);
  const unwritten = sum((r) => r.threads?.unwritten.length ?? 0);
  const found = [lines > 0 ? `${lines} 條線` : '', fores > 0 ? `${fores} 條伏筆` : ''].filter(Boolean).join('、');
  // 故事時間（2026-10-24 重做）：寫進時間線的（推不出記了 +? 的也算）、其中正文寫明瞭日子的、推不出的、你定的沒改的。
  const timed = results.filter((r) => r.time?.entry && !r.time.authored && r.time.action !== 'kept');
  const dated = timed.filter((r) => r.time?.entry?.dateMark).length;
  const unknown = timed.filter((r) => r.time?.entry?.value.kind === 'unknown').length;
  const timeText =
    timed.length > 0
      ? `故事時間：推了 ${timed.length} 章${[dated > 0 ? `${dated} 章正文寫明瞭日子` : '', unknown > 0 ? `${unknown} 章推不出（按緊接上一章算）` : ''].filter(Boolean).map((s) => `，${s}`).join('')}`
      : '';
  return [
    names.length > 0 ? `${names.join('、')}的當前狀態更新到了最後同步的那一章` : '',
    events > 0 ? `敘事線：記下 ${events} 個事件${found ? `，新認出 ${found}` : ''}` : '敘事線沒有新進展',
    timeText,
    dropped > 0 ? `另有 ${dropped} 條敘事線的記錄沒有收（見日誌）` : '',
    unwritten > 0 ? `${unwritten} 條線的當前進度沒寫上（見日誌）` : '',
  ]
    .filter(Boolean)
    .join('；');
}

/**
 * 同步中途停下：細綱已經照正文更新（這幾章不再「待定稿」，黃條不會再提醒），角色狀態與敘事線還沒走到。
 * 掛黃 ❗ 在章節上，說清要重新定稿這一章才補得上（單章定稿成功時 `clearFailures` 會把它清掉）。
 */
async function markHalfDone(project: NovelProject, left: readonly { chapter: Chapter }[]): Promise<void> {
  for (const { chapter } of left) {
    await recordFailure(project, {
      scope: '同步',
      targetKind: 'chapter',
      targetKey: chapter.relPath,
      severity: 'warn',
      op: STATE_OP,
      message: '同步中途停了：細綱已照正文更新，角色狀態與敘事線還沒跟上',
      detail: '右鍵這一章「同步」重新同步一次，角色狀態與敘事線就補上了。',
    });
  }
}

/**
 * 併發照正文更新這幾章的細綱：`syncSummaries` 與「從已寫正文補齊」（features/derive.ts）共用。
 * **不彈框、不開任務**，確認與進度條歸呼叫方。失敗的掛在那一章上（第 16 條），按章號排好交回去；
 * 取消的不算失敗。更新成了的連同第一步的結果（出場人物）也按章號交回去，同步拿它接著走角色狀態與敘事線。
 */
export async function summarizeChapters(
  project: NovelProject,
  stale: readonly Chapter[],
  opts: {
    pool: ModelPool;
    lanes: number;
    signal: AbortSignal;
    report: (p: { message?: string; current?: number; total?: number }) => void;
    /** 轉寫那一次怎麼調（2026-10-25 起）。預設現建一個，轉寫那一檔沒有可用的模型時用 `pool`。 */
    transcribe?: TranscribeCall;
  }
): Promise<{
  ok: number;
  failed: { no: number; reason: string }[];
  updated: { chapter: Chapter; summary: SummaryOutcome }[];
  /** 實際調了幾次模型（寫的加轉寫的；沒成的也算發出去的那幾次）。 */
  calls: number;
}> {
  const { pool, lanes, signal, report } = opts;
  const transcribe = opts.transcribe ?? poolTranscriber(signal, pool);
  let calls = 0;
  const startedAt = Date.now();
  const failed: { no: number; reason: string }[] = [];
  const updated: { chapter: Chapter; summary: SummaryOutcome }[] = [];
  // 併發下「正在跑哪幾章」是變動的，用一個集合維護，報進度時現拼。
  const running = new Set<number>();
  let done = 0;
  let okCount = 0;
  report({ message: '準備中…', current: 0, total: stale.length });

  const describeRunning = (): string =>
    lanes > 1
      ? `已完成 ${done}/${stale.length} · ${running.size} 路進行中（第 ${[...running]
          .sort((a, b) => a - b)
          .join('、')} 章）`
      : '';

  await runPool(
    [...stale],
    lanes,
    (chapter) =>
      pool.run(`第 ${chapter.order} 章`, (llm) =>
        summarizeChapter(project, chapter, llm, signal, pool.primaryBudget, transcribe)
      ),
    {
      signal,
      onStart: (chapter) => {
        running.add(chapter.order);
        report({
          message: lanes > 1 ? describeRunning() : `第 ${chapter.order} 章《${chapter.title}》`,
          current: done,
          total: stale.length,
        });
      },
      onSettled: (result, chapter, _index, finished) => {
        running.delete(chapter.order);
        done = finished;
        if (result.status === 'fulfilled') {
          okCount++;
          // 空章、沒有可用的模型時第一步交回 undefined（已經說過原因），沒有可接著走的。
          if (result.value) {
            calls += result.value.calls;
            updated.push({ chapter, summary: result.value });
          }
        } else {
          const err = result.reason;
          if (!(err instanceof CancelledError || err?.name === 'CancelledError')) {
            // 請求發出去了錢就花了：讀不出來的帶著寫與轉寫的實數，別的錯算寫的那 1 次。
            calls += summarizeCallsOf(err);
            const reason = describeError(err);
            failed.push({ no: chapter.order, reason });
            log.error(`第 ${chapter.order} 章《${chapter.title}》失敗：${reason}`, err);
            // toast 裡只列得下章號，而它五秒就沒了。掛到那一行上，
            // 使用者第二天回來還能看出是哪幾章沒更新成。
            void recordFailure(project, {
              scope: '同步',
              targetKind: 'chapter',
              targetKey: chapter.relPath,
              severity: 'error',
              op: 'summarize',
              message: `細綱沒能照正文更新：${reason}`,
              detail: '這一章的連續性事實與出場人物不會進入上下文。可右鍵「同步」單獨重試。',
            });
          }
        }
        // 每章一條 info：一次跑幾十章，中途出問題時要看得出停在哪。
        const perItem = (Date.now() - startedAt) / done;
        log.info(
          `進度 ${done}/${stale.length}`,
          `剛完成第 ${chapter.order} 章；平均 ${formatDuration(perItem)}/章，` +
            `預計剩餘 ${formatDuration(perItem * (stale.length - done))}`
        );
        report({
          message: lanes > 1 ? describeRunning() : `第 ${chapter.order} 章《${chapter.title}》`,
          current: done,
          total: stale.length,
        });
      },
    }
  );
  // 完成順序是亂的，彙報前按章號排回來——「第 7、3、12 章失敗」沒法讀。
  failed.sort((a, b) => a.no - b.no);
  updated.sort((a, b) => a.chapter.order - b.chapter.order);
  return { ok: okCount, failed, updated, calls };
}

/**
 * 「細綱路徑或章節路徑」→ 那一章的成品。
 *
 * 定稿讀的是**正文**，而作者點過來的路徑可能是任意一側：工程頁那一行同時
 * 代表細綱與正文。先按路徑直接找，找不到再按檔名裡的章號找（細綱號 = 章號）——
 * 後者覆蓋「傳的是細綱、正文另有其名」這種正常情況。還沒有正文時返回
 * undefined，呼叫方據此說「這一章還沒有正文」。
 *
 * 放在這裡而不是各呼叫方各寫一份：工程頁、命令面板與 MCP 的 `summary` 工具
 * 都要問同一個問題，答案分叉了就會出現「工程頁定稿得了、agent 說找不到」。
 */
export async function chapterForSummary(
  project: NovelProject,
  relPath: string
): Promise<Chapter | undefined> {
  const chapters = await project.listChapters();
  const direct = chapters.find((ch) => ch.relPath === relPath);
  if (direct) {
    return direct;
  }
  // 細綱映象正文的路徑：映象對得上的那一章最準（同號的正文有兩份也認得出），對不上再按號認。
  const mirrored = chapters.find((ch) => project.plotPathForChapter(ch.relPath) === relPath);
  if (mirrored) {
    return mirrored;
  }
  const no = parsePlotFileName(basename(relPath))?.no;
  return no === undefined ? undefined : chapters.find((ch) => ch.order === no);
}

/** `1、2、3…（共 76 章）`——待辦列表太長時只列前幾個。 */
function describeNos(chapters: Chapter[]): string {
  const head = chapters.slice(0, 12).map((c) => c.order).join('、');
  return chapters.length > 12 ? `${head}…（共 ${chapters.length} 章）` : head;
}

/** {@link updateGlobalSummary} 的結果。 */
export interface GlobalSummaryUpdate {
  calls: number;
  /** 更新之後覆蓋到第幾章。 */
  through?: number;
  /** 沒更新的原因（零呼叫）。 */
  skipped?: string;
}

/**
 * 增量更新全文大綱：舊的那一份 + 它覆蓋到的那一章之後、定稿過的各章的細綱，**1 次呼叫**出新的一版。
 * 批次寫章「寫完即定稿」每落後 `GLOBAL_SUMMARY_EVERY` 章調一次（百章實驗裡全文大綱（那時叫全書摘要）從沒生成過——
 * 它只有作者手動點「重建」這一個入口）。還沒有舊的那一份時就從第 1 章起彙總；新章太多、一次放不下時
 * 只併入放得下的前面那幾章，`through` 停在那裡，下一次接著並。不彈框、不開任務；呼叫失敗拋錯。
 */
export async function updateGlobalSummary(
  project: NovelProject,
  runner: {
    run<T>(what: string, fn: (llm: LlmProvider) => Promise<T>): Promise<T>;
    readonly primaryBudget: { contextWindow: number; maxOutputTokens: number };
  },
  signal?: AbortSignal
): Promise<GlobalSummaryUpdate> {
  const manifest = await project.readManifest();
  const old = (await project.readGlobalSummary()).trim();
  const fresh = old && !/尚未生成/.test(old);
  const since = fresh ? manifest.globalSummaryThrough ?? 0 : 0;
  const units: { no: number; title: string; content: string }[] = [];
  for (const chapter of (await project.listChapters()).sort((a, b) => a.order - b.order)) {
    if (chapter.order <= since || chapter.wordCount <= 0) {
      continue;
    }
    const plot = await project.finalizedPlotOf(chapter);
    const content = plot ? plotDigest(plot) : '';
    // 一章沒定稿就停在它前面：全文大綱是按時間順序的主線，跳過一章就缺一塊。
    if (!content) {
      break;
    }
    units.push({ no: chapter.order, title: chapter.title, content });
  }
  if (units.length === 0) {
    return { calls: 0, skipped: `第 ${since} 章之後還沒有同步過的章` };
  }

  const budget = runner.primaryBudget;
  const inputBudget = Math.max(4000, budget.contextWindow - budget.maxOutputTokens - 2000) - estimateTokens(old);
  const blocks: string[] = [];
  let used = 0;
  let through = since;
  for (const u of units) {
    const block = `【第${u.no}章 ${u.title}】\n${u.content}`;
    const cost = estimateTokens(block);
    if (blocks.length > 0 && used + cost > inputBudget) {
      globalLog.warn('新同步的章太多，這一次只併入前面幾章', `併到第 ${through} 章，後面的下一次再並`);
      break;
    }
    blocks.push(block);
    used += cost;
    through = u.no;
  }
  const span = units[0].no === through ? `第 ${through} 章` : `第 ${units[0].no}–${through} 章`;
  const user = fresh
    ? `以下是目前的全文大綱（截至第 ${since} 章），以及之後${span}定稿過的逐章細綱。請在舊的全文大綱上併入這幾章，輸出一份新的全文大綱。\n\n# 目前的全文大綱\n\n${old}\n\n# 新定稿的逐章細綱\n\n${blocks.join('\n\n')}`
    : `以下是${span}定稿過的逐章細綱，請彙總成一份全文大綱。\n\n${blocks.join('\n\n')}`;
  const config = readConfig();
  const startedAt = Date.now();
  const text = await runner.run('更新全文大綱', (llm) =>
    collectText(
      llm.stream(
        [
          { role: 'system', content: GLOBAL_SYSTEM },
          { role: 'user', content: user },
        ],
        { maxOutputTokens: budget.maxOutputTokens, temperature: 0.3, timeoutMs: config.requestTimeoutMs, signal }
      )
    )
  );
  if (!text.trim()) {
    throw new Error('模型返回的全文大綱是空的');
  }
  await new Workspace(project).writeGlobalSummary(text.trim(), through);
  globalLog.info(`全文大綱已更新到第 ${through} 章`, `併入${span}｜${text.trim().length} 字｜用時 ${elapsed(startedAt)}`);
  return { calls: 1, through };
}

/**
 * 一份定稿過的細綱交給全文大綱的那一段：有內容的小節一節一段。沒內容是空串。
 * 連續性事實帶著證據原句，與全書主線無關，不給。
 */
function plotDigest(plot: Plot): string {
  return PLOT_SECTION_KEYS.filter((key) => key !== '连续性事实' && plot.sections[key].trim())
    .map((key) => `### ${traditionalLabel(key)}\n${plot.sections[key].trim()}`)
    .join('\n\n');
}

/**
 * 收集定稿過的細綱，交給全文大綱。定稿之後正文又改過的照樣收（重建之前已經問過要不要先同步），
 * 從沒定稿過的只是計劃，不進全文大綱（記進 `missing`）。
 */
async function collectDigests(
  project: NovelProject,
  chapters: Chapter[]
): Promise<{ units: { no: number; title: string; content: string }[]; missing: number[] }> {
  const units: { no: number; title: string; content: string }[] = [];
  const missing: number[] = [];
  for (const chapter of chapters) {
    const plot = await project.plotOfChapter(chapter);
    const content = plot?.sourceHash ? plotDigest(plot) : '';
    if (content) {
      units.push({ no: chapter.order, title: chapter.title, content });
    } else {
      missing.push(chapter.order);
    }
  }
  return { units, missing };
}

/**
 * map-reduce 重建全文大綱。
 *
 * 定稿過的各章細綱按 summaryBatchSize 分批 reduce 成階段摘要，再把階段摘要合併成
 * 一份全文大綱。這樣即便有幾百章，也不會一次性把所有細綱塞進視窗。
 */
export async function rebuildGlobalSummary(project: NovelProject): Promise<void> {
  const chapters = await project.listChapters();
  if (chapters.length === 0) {
    globalLog.warn('還沒有章節，無法重建全文大綱');
    getHost().toast('還沒有章節。');
    return;
  }

  const stale = await project.staleChapters();
  /** 作者在確認框上挑的；一章定稿過的細綱都沒有、沒問時是設定。 */
  let choice: CallChoice = {};
  if (stale.length > 0) {
    globalLog.warn(`有 ${stale.length} 章沒同步或同步後正文改過`, `待同步：${describeNos(stale)}`);
    const answer = await askCall({
      message: `有 ${stale.length} 章的細綱還沒照正文更新（沒同步，或同步後正文又改過），直接重建會缺這些章的資訊。`,
      actions: ['先同步細綱', '仍然重建'],
      detail: '先同步細綱：同步那一步還會再問一次次數，預設跟著這裡的選擇。',
      tasks: ['globalSummaryStage', 'globalSummaryMerge'],
      contextDetail: false,
    });
    if (!answer) {
      globalLog.info('使用者取消了重建');
      return;
    }
    globalLog.info(`使用者選擇「${answer.action}」`);
    choice = answer.choice;
    if (answer.action === '先同步細綱') {
      await withCallChoice(choice, () => syncSummaries(project));
    }
  } else {
    // 都定稿過也先報次數（第 4 條）。一章都收不到時不問，下面照常說清。
    const { units } = await collectDigests(project, chapters);
    if (units.length > 0) {
      const batches = Math.ceil(units.length / Math.max(3, readConfig().summaryBatchSize));
      const calls = batches + (batches > 1 ? 1 : 0);
      const answer = await askCall({
        message: `重建全文大綱：${units.length} 章同步過的細綱分 ${batches} 批歸納${batches > 1 ? '，再合併成一份' : ''}，覆蓋現在的全文大綱。${describeCalls({ low: calls, high: calls, max: calls })}。`,
        actions: ['重建'],
        tasks: ['globalSummaryStage', 'globalSummaryMerge'],
        contextDetail: false,
      });
      if (answer?.action !== '重建') {
        globalLog.info('使用者取消了重建');
        return;
      }
      choice = answer.choice;
    }
  }

  return withCallChoice(choice, async () => {
    const config = readConfig();
    const { units, missing } = await collectDigests(project, chapters);
    if (units.length === 0) {
      globalLog.error('沒有任何同步過的章，重建中止');
      getHost().toast('還沒有任何一章同步過：先同步（工程頁黃條上的「立即同步」，或章節右鍵「同步」）。');
      return;
    }
    if (missing.length > 0) {
      // 「不靜默截斷」：少了哪幾章必須說出來，否則全文大綱憑空缺一塊。
      globalLog.warn(
        `${missing.length} 章沒同步過，不會進入全文大綱`,
        `缺失章：${missing.slice(0, 20).join('、')}${missing.length > 20 ? `…（共 ${missing.length} 章）` : ''}`
      );
    }

    const batches = chunk(units, Math.max(3, config.summaryBatchSize));
    const lanes = Math.min(config.concurrency, batches.length);
    // 兩個池，兩檔：分批匯總是幾十次「把 15 章細綱壓成一段」的體力活，
    // 最終合併全書只做一次卻要跨幾十萬字取捨主線。這正是分檔最大的收益點。
    const stagePool = await createModelPool({ task: 'globalSummaryStage', concurrent: lanes > 1 });
    if (!stagePool) {
      globalLog.error('沒有可用的模型，重建中止');
      return;
    }
    // 只有一批時根本不合併，不必為此構造第二個池（也不必彈它的 Key 輸入框）。
    const mergePool =
      batches.length > 1 ? await createModelPool({ task: 'globalSummaryMerge', concurrent: false }) : stagePool;
    if (!mergePool) {
      globalLog.error('沒有可用的模型，重建中止');
      return;
    }
    globalLog.info(
      `準備重建：${units.length} 章細綱分 ${batches.length} 批`,
      `分批匯總 ${stagePool.label}｜最終合併 ${mergePool.label}｜每批 ${Math.max(3, config.summaryBatchSize)} 章｜` +
        (lanes > 1 ? `彙總階段併發 ${lanes} 路` : '彙總階段序列')
    );

    await runTask(
      '重建全文大綱',
      async ({ signal, report }) => {
        const startedAt = Date.now();
        const options: StreamOptions = {
          maxOutputTokens: stagePool.primaryBudget.maxOutputTokens,
          temperature: 0.3,
          timeoutMs: config.requestTimeoutMs,
          signal,
        };

        // 合併那一步也算一格進度，否則最後一批跑完進度條會停在 100% 乾等。
        const steps = batches.length + (batches.length > 1 ? 1 : 0);

        // ---- map：每批 reduce 成階段摘要 ----
        // 各批彼此獨立（只有最後的合併才要全部到齊），因此按配置併發。
        // runPool 的結果按 index 對齊，階段小節的先後不會因完成順序而亂。
        let mapped = 0;
        const rangeOf = (batch: typeof batches[number]): string =>
          `第 ${batch[0].no} - ${batch[batch.length - 1].no} 章`;

        const results = await runPool(
          batches,
          lanes,
          async (batch) => {
            const range = rangeOf(batch);
            const joined = batch.map((u) => `【第${u.no}章 ${u.title}】\n${u.content}`).join('\n\n');
            const each = Date.now();
            globalLog.debug(`彙總 ${range}`, `${batch.length} 章細綱，約 ${estimateTokens(joined)} token`);
            const text = await stagePool.run(range, (llm) =>
              collectText(
                llm.stream(
                  [
                    { role: 'system', content: STAGE_SYSTEM },
                    { role: 'user', content: `以下是${range}定稿過的逐章細綱，請彙總成階段大綱（只寫主線進展）。\n\n${joined}` },
                  ],
                  options
                )
              )
            );
            globalLog.info(`階段摘要完成（${range}）`, `產出 ${text.trim().length} 字，用時 ${elapsed(each)}`);
            return `## ${range}\n\n${text.trim()}`;
          },
          {
            signal,
            onStart: (batch) => report({ message: `彙總 ${rangeOf(batch)}`, current: mapped, total: steps }),
            onSettled: (_result, _batch, _index, finished) => {
              mapped = finished;
              report({ current: mapped, total: steps });
            },
          }
        );

        if (signal.aborted) {
          globalLog.warn(`重建被取消，已彙總 ${mapped}/${batches.length} 批`);
          return;
        }

        // 「不靜默截斷」：某一批失敗時全文大綱會憑空缺一塊，必須說出來。
        const stageSummaries: string[] = [];
        const lost: string[] = [];
        for (const [i, r] of results.entries()) {
          if (r.status === 'fulfilled') {
            stageSummaries.push(r.value);
          } else {
            lost.push(`${rangeOf(batches[i])}：${describeError(r.reason)}`);
          }
        }
        if (lost.length > 0) {
          globalLog.error(`${lost.length} 批匯總失敗，這幾章不會進入全文大綱`, lost.join('\n'));
          getHost().toast(`${lost.length} 批匯總失敗，全文大綱會缺這幾章，詳見日誌頁。`, 'error');
        }
        if (stageSummaries.length === 0) {
          globalLog.error('所有批次都彙總失敗，全文大綱未改動');
          return;
        }

        // ---- reduce：階段摘要合併成全文大綱 ----
        let finalText: string;
        if (stageSummaries.length === 1) {
          finalText = stageSummaries[0].replace(/^## .*\n+/, '');
          globalLog.debug('只有一批，直接用階段摘要作為全文大綱');
        } else {
          report({ message: '合併為全文大綱', current: batches.length, total: steps });
          const combined = stageSummaries.join('\n\n');
          // 合併這一步用**精標檔**的視窗：它和分批匯總很可能不是同一個模型。
          const mergeBudget = mergePool.primaryBudget;
          const inputBudget = Math.max(4000, mergeBudget.contextWindow - mergeBudget.maxOutputTokens - 2000);
          const clipped = takeHead(combined, inputBudget);
          if (clipped.length < combined.length) {
            globalLog.warn(
              '階段摘要總量超出輸入預算，合併時已截斷',
              `${combined.length} 字 → ${clipped.length} 字（預算 ${inputBudget} token）。` +
                '可把「全文大綱批大小」調大以減少批數。'
            );
          }
          const mergeStart = Date.now();
          globalLog.debug(`合併 ${stageSummaries.length} 份階段摘要`, `約 ${estimateTokens(clipped)} token`);
          finalText = await mergePool.run('合併全文大綱', (llm) =>
            collectText(
              llm.stream(
                [
                  { role: 'system', content: GLOBAL_SYSTEM },
                  {
                    role: 'user',
                    content: `以下是各階段大綱，請合併成一份全文大綱。\n\n${clipped}`,
                  },
                ],
                { ...options, maxOutputTokens: mergeBudget.maxOutputTokens }
              )
            )
          );
          globalLog.info('階段摘要已合併', `產出 ${finalText.trim().length} 字，用時 ${elapsed(mergeStart)}`);
        }

        const through = units[units.length - 1].no;
        const relPath = await new Workspace(project).writeGlobalSummary(finalText.trim(), through);
        report({ message: '完成', current: steps, total: steps });
        globalLog.info(
          `全文大綱已重建，覆蓋至第 ${through} 章`,
          `${relPath}｜${finalText.trim().length} 字（約 ${estimateTokens(finalText)} token）｜總耗時 ${elapsed(startedAt)}`
        );
        getHost().toast(`全文大綱已重建，覆蓋至第 ${through} 章（約 ${estimateTokens(finalText)} token）。`);
        await getHost().openFile(project.relPath(project.globalSummaryPath));
      },
      { scope: '全文大綱' }
    );
  });
}

// ---------------------------------------------------------------- 解析

/**
 * 從模型返回中解析出定稿後的七節。
 *
 * 兩層，解析不出來就什麼都不收：
 *
 * 1. **JSON**（模型自己給的、老會話）。欄位缺失、型別不對、陣列/字串混用
 *    都逐欄位兜住，不整體作廢；多出來的尾逗號自己去掉再解析一次。
 * 2. **Markdown 小節**。2026-10-25 起提示詞就要模型按小標題寫、由轉寫模型照抄成 JSON（`readSummary`）；
 *    轉寫沒成時按這一層讀原文。
 *
 * 從前還有第三層「全文塞進梗概」。那時寫壞的是一份單獨的摘要；現在定稿寫回的就是這一章的
 * 細綱，全文塞進梗概等於拿一段沒解析開的 JSON 換掉作者的計劃，還記上 `sourceHash` 讓這一章
 * 看起來已經定稿。所以兩層都不中就返回空的七節，由 {@link summarizeChapter} 報失敗、細綱不動。
 *
 * `cast` 只在 JSON 路徑上有結構化來源；其餘路徑從「出場人物」小節的文字反解。
 */
export function parseSummaryResponse(raw: string): SummaryData {
  const cleaned = stripCodeFence(raw);

  const fromJson = parseSummaryJson(cleaned);
  if (fromJson) {
    return fromJson;
  }

  const sections = parseSummarySections(cleaned);
  return {
    sections,
    cast: castFromText(sections.出场人物),
    lore: parseLoreLines(pickSections(cleaned, [PLOT_LORE_KEY])[PLOT_LORE_KEY]),
  };
}

/**
 * JSON 路徑。返回 undefined 表示「這不是我們要的 JSON」，由呼叫方降級。
 *
 * 判據是**梗概或關鍵事件至少有一個非空**：模型有時會吐出一個語法合法但
 * 完全不相干的 JSON（比如把正文包成 `{"text": "..."}`），那種東西認下來
 * 會得到一份空細綱並且不再降級，比解析失敗更糟。
 */
function parseSummaryJson(text: string): SummaryData | undefined {
  const jsonText = extractJsonObject(text);
  if (!jsonText) {
    return undefined;
  }
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    try {
      data = JSON.parse(stripTrailingCommas(jsonText));
    } catch {
      return undefined;
    }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return undefined;
  }
  const obj = data as Record<string, unknown>;

  const sections = emptyPlotSections();
  for (const key of PLOT_SECTION_KEYS) {
    sections[key] = toSectionText(obj[key]);
  }
  if (!sections.梗概.trim() && !sections.关键事件.trim()) {
    return undefined;
  }

  const cast = parseCastField(obj.出场人物 ?? obj.cast);
  // 「出場人物」小節是給人看的，從結構化 cast 渲染回來，保證兩者一致。
  // 模型如果把這一節寫成了別的文字，以 cast 為準——它才是後續功能吃的那份。
  if (cast.length > 0) {
    sections.出场人物 = cast.map(renderCastEntry).join('、');
  }
  return { sections, cast, lore: loreLinesFromJson(obj[PLOT_LORE_KEY] ?? obj.settings) };
}

/**
 * `出场人物` 欄位 → 結構化清單。模型的寫法五花八門，都收：
 * - `["林昭", "沈氏"]`
 * - `[{ "name": "林昭", "aliases": ["阿昭"] }]`
 * - `"林昭、沈氏"`
 */
function parseCastField(v: unknown): SummaryCast[] {
  const out: SummaryCast[] = [];
  // 正式名是「主角」「反派」這類劇作稱謂的換成真名、換不出來的丟掉（model/castParse.ts）。
  const push = (entry: SummaryCast | undefined) => pushCast(out, entry);

  if (typeof v === 'string') {
    return castFromText(v);
  }
  if (!Array.isArray(v)) {
    return out;
  }
  for (const item of v) {
    if (typeof item === 'string') {
      push(parseCastEntry(item));
      continue;
    }
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const obj = item as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    if (!name) {
      continue;
    }
    const aliases = Array.isArray(obj.aliases)
      ? obj.aliases.filter((a): a is string => typeof a === 'string').map((a) => a.trim()).filter(Boolean)
      : typeof obj.aliases === 'string'
        ? obj.aliases.split(/[、,，/]/).map((a) => a.trim()).filter(Boolean)
        : [];
    // 泛稱在這裡就擋住，不落進細綱 frontmatter：`姐姐`/`她`/`少女` 是好幾個
    // 角色的共同稱呼，而 cast 的別名是 model/identity.ts 判斷「誰是誰」的依據。
    push({ name, aliases: sanitizeAliases(aliases, name) });
  }
  return out;
}

/**
 * JSON 裡的小節值：字串直接用，陣列渲染成無序列表（關鍵事件常是陣列）。
 *
 * 剝圍欄與摳 JSON 物件在 [parse.ts](parse.ts)（`stripCodeFence` / `extractJsonObject`）：
 * 模型輸出的容錯解析在這個專案裡就這一套，定稿、細綱、角色卡吃的是同一批壞習慣
 * （該給字串給了陣列、該給陣列給了頓號分隔的一行）。各寫一份必然慢慢跑偏。
 */
export function toSectionText(v: unknown): string {
  if (typeof v === 'string') {
    return v.trim();
  }
  if (Array.isArray(v)) {
    return v
      .map((item) => {
        if (typeof item === 'string') {
          return item.trim();
        }
        // `[{ "事件": "..." }]` 這種也別丟，取第一個字串值。
        if (typeof item === 'object' && item !== null) {
          const first = Object.values(item as Record<string, unknown>).find((x) => typeof x === 'string');
          return typeof first === 'string' ? first.trim() : '';
        }
        return '';
      })
      .filter(Boolean)
      .map((line) => (/^[-*·]/.test(line) ? line : `- ${line}`))
      .join('\n');
  }
  if (typeof v === 'number' || typeof v === 'boolean') {
    return String(v);
  }
  return '';
}

/** 從 Markdown 抽出七個固定小節（PLOT_SECTION_KEYS）。允許模型多寫、少寫，缺的留空。 */
function parseSummarySections(cleaned: string): PlotSections {
  const picked = pickSections<PlotSectionKey>(cleaned, PLOT_SECTION_KEYS);
  const sections = { ...emptyPlotSections(), ...picked };

  // 模型偶爾不帶 `##`，改用 `梗概：xxx` 的行內寫法，這裡兜底一次。
  if (!sections.梗概.trim() && !sections.关键事件.trim()) {
    for (const key of PLOT_SECTION_KEYS) {
      const re = new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?(?:${key}|${traditionalLabel(key)})(?:\\*\\*)?\\s*[:：]\\s*(.+)$`, 'm');
      const m = re.exec(cleaned);
      if (m) {
        sections[key] = m[1].trim();
      }
    }
  }
  return sections;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}
