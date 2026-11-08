/**
 * 生成：裝配上下文 → 調模型 → 解析產物 → 交出一份 Draft。
 *
 * ## 無狀態
 *
 * 這裡沒有類、沒有欄位、沒有「當前有沒有在生成」。併發控制是**排程**的
 * 責任，不是生成的責任——對話頁與 MCP 呼叫都由 `ChatController` 管
 * （同一時刻只許一個）。所以 `signal` 由呼叫方給，本模組只往下透傳。
 *
 * ## 一個字都不寫磁碟
 *
 * `generate` 產出的是 `Draft`：一份**尚未落盤**的產物。落盤在
 * `workspace/`，且只在使用者點了採納之後（AGENTS 第 19 條：產物落盤前必須
 * 過一遍人）。唯一的例外是失敗記賬（`recordFailure` / `clearFailures`），
 * 它寫的是痕跡庫不是內容（第 17 條）。
 *
 * ## 解析並進生成
 *
 * 從前的流程是「生成 → 前端拿到文字 → 後端再 parse 一次畫卡片 → 採納時
 * 第三次 parse」，中間那次純屬多餘。現在 `Draft` 出廠就帶 `artifact` 與
 * `summary`。**採納時仍然重新解析**——使用者可能在氣泡裡改過文字，
 * `draft.artifact` 只是生成那一刻的快照。
 *
 * ## 一件產物可能要調幾次
 *
 * 小說配置、角色圖譜、細綱批次要分幾次呼叫才拼得出來（截斷重來、兩段式、拆半重試），
 * 第一次流式呼叫之後接上 `structured.ts` 的那條鏈，後面幾次照樣流進同一個氣泡，
 * 最後氣泡換成規範化結果（將要落盤的樣子）。每一次降級記進 `Draft.notes`，
 * 落盤卡片上列出來（第 2 條）。
 */
import { BuildRequest, BuiltContext, buildContext } from '../context/builder';
import { StopSignal } from '../llm/provider';
import { describeUsage, recordUsage } from '../context/tokenizer';
import { mergeUsage, sumUsage } from '../llm/collect';
import { CancelledError, LlmProvider, StreamOptions, TokenUsage } from '../llm/provider';
import { buildProvider, resolveProvider } from '../llm/registry';
import { readBudgetFallback, readConfig } from '../config';
import { ThinkingDepth } from '../model/thinking';
import { CONTEXT_DETAIL_LABEL } from '../model/contextDetail';
import { clearFailures, recordFailure } from '../runtime/errorLog';
import { describeError, elapsed, scoped } from '../runtime/logger';
import { countWords } from '../model/fs';
import { NovelProject } from '../model/project';
import { NovelConfig } from '../model/types';
import { Plot, isPlotFilled, parsePlotFileName } from '../model/plotFile';
import { NotYet, dropMentioned, notYetOnStage } from '../model/manuscriptCheck';
import { readBannedTerms } from '../views/checkTerms';
import { AHEAD_PLOTS } from '../context/layers/focus';
import {
  CAPABILITY_LABEL,
  CreationAction,
  CreationTarget,
  STAGE_LABEL,
  WriteMode,
  describeTarget,
  isFallbackChapterTitle,
  loreOfTarget,
  outputKindOf,
  plotOfTarget,
} from '../model/pipeline';
import { previousEnding } from '../context/replay';
import { describeModelIssue, providerLabel, resolveModelRef } from '../model/providers';
import { Artifact, ChapterRange, describeArtifact, isArtifactEmpty, parseArtifact } from '../features/artifact';
import { cleanOutput } from '../features/creation';
import {
  CallOutcome,
  ChainError,
  ChainIO,
  ChainResult,
  chainOf,
  chaptersOf,
  completeBlueprints,
  completeConfig,
  completeLoreExpand,
  completeLoreSettle,
  completeLoreList,
  completePlot,
  completeRoster,
  singleShotNotes,
  TRANSCRIBE_TEMPERATURE,
} from './structured';
import { lazyTranscriber, transcribeWith } from '../features/poolIO';
import { LoreListKnown } from '../features/loreList';
import { LoreExpandKnown } from '../features/loreExpand';
import { LoreSettleKnown } from '../features/loreSettle';
import { buildLoreIndex } from '../views/lore';
import { loreEntryAt } from '../views/loreMaterial';
import { writingAim } from '../model/trimProse';
import { ManuscriptChainResult, WriteProgress, completeManuscript } from './continuation';
import { ReviewChainContext, completeReview } from './review';
import { completeRevision } from './revision';
import { ReviewReport, freezeGoals } from '../model/review';
import { basename } from 'node:path';

const log = scoped('創作');

/** 一次生成的產出。**尚未落盤**，採納時才寫。 */
export interface Draft {
  id: string;
  action: CreationAction;
  target: CreationTarget;
  /** 模型原樣輸出（正文層已過 `cleanOutput`）。 */
  raw: string;
  /** 解析出的結構化產物。討論（唯一的 text 類能力）沒有。 */
  artifact?: Artifact;
  /** 一句話形狀描述，如「細綱 · 3/3 節」。有 artifact 才有。 */
  summary?: string;
  words: number;
  /** 推理模型的思考過程。**不是正文，採納時不取。** */
  reasoning?: string;
  createdAt: string;
  /**
   * 這一步覆蓋的章號區間：細綱批次（給了就是一批）與續寫的那一段大綱。採納時要它——
   * 細綱按批次解碼、大綱按區間合併。
   */
  range?: ChapterRange;
  /** 這一路上的降級與說明（截斷重來、拆半重試、漏欄位……）。落盤卡片上列出來。 */
  notes?: string[];
  /** 這一次一共調了幾次模型。 */
  calls?: number;
  /**
   * 正文的寫法（model/pipeline.ts 的 `WriteMode`）。**採納時按它落盤**：`continue` 追加、
   * 其餘在已有正文時覆蓋審閱。生成那一刻按磁碟定的，採納時不再猜。
   */
  writeMode?: WriteMode;
  /** 正文寫了多長：這一章寫完後的總字數、目標、這一次新寫的、續寫了幾輪、夠不夠八成。 */
  length?: DraftLength;
  /** 新稿開頭與上一章結尾重合的那一段原文（context/replay.ts）。卡片標紅、寫入要點兩下。 */
  replay?: string;
  /**
   * 刪修飾真刪了字時：刪之前那一版（與 `raw` 對應，只含這一次新寫的）。寫入卡片點了「寫入」之後，
   * 合併檢視拿它與氣泡裡那份逐段對照，作者可以把刪改退回原文。
   */
  untrimmed?: string;
  /**
   * 審稿報告（五期）。審稿那一輪**沒有 `artifact`**：報告不落盤，隨會話儲存（D22），
   * 作者在報告卡上勾選之後再發起修稿。
   */
  review?: ReviewReport;
}

export interface DraftLength {
  words: number;
  target?: number;
  added: number;
  rounds: number;
  /** 到了目標的八成（沒有目標時恆為 true：有字就算寫夠）。 */
  reached: boolean;
}

export interface GenerateHandlers {
  onDelta(delta: string, full: string): void;
  /** 推理模型的思考增量。正文之前可能先想很久，介面靠它給出反饋。 */
  onReasoning?(delta: string, full: string): void;
  onDone(full: string): void;
  onError(message: string): void;
  onCancelled(): void;
  /** 寫正文的進度：第幾輪、寫到多少字、目標多少。流式期間約 300ms 一次，每一輪開始時一次。 */
  onProgress?(p: WriteProgress): void;
  /** 氣泡退回到這一份（續寫丟棄一輪時）。 */
  onReset?(full: string): void;
}

export interface GenerateOptions {
  signal: AbortSignal;
  /**
   * 用哪個模型。預設用對話頁選定的那個（`config.active`）。
   *
   * **正文層永遠不許傳別的**（AGENTS 第 12 條：中途換人會讓文風斷掉）。
   * 這個引數給 agent 的 `generate` 工具讓非正文層走分檔池。
   */
  provider?: LlmProvider;
  /**
   * 裝配與輸出的 token 預算。預設用 `config` 裡那一份（對話頁選定模型的視窗）。
   *
   * **傳了 `provider` 就必須一起傳它**（AGENTS 第 13 條）：`config.contextWindow`
   * 跟著對話頁選定的模型走，拿 200k 寫作模型的視窗去給快速檔的 32k 模型裝配
   * 上下文會穩定超窗。分檔池的 `primaryBudget` 正是這一份。
   */
  budget?: { contextWindow: number; maxOutputTokens: number };
  /**
   * 讓模型想多深。預設不帶思考引數（服務商預設）。
   *
   * 對話頁把作者在會話裡選的那一檔遞進來；工程頁的批次任務不遞——第 12 條
   * 那條理由的同一面：那一檔模型是作者按成本挑的，替他把七十六章的摘要
   * 都升級成深思考，賬單上看不出是誰決定的。
   */
  thinking?: ThinkingDepth;
}

export interface GenerateResult {
  /** 失敗或模型引用無效時缺席。 */
  draft?: Draft;
  /** 裝配明細。裝配之前就失敗時缺席。 */
  built?: BuiltContext;
}

/** 只裝配上下文，不呼叫模型——面板裡的「預覽上下文」。 */
export async function previewContext(
  project: NovelProject,
  request: Omit<BuildRequest, 'providerMaxInputTokens'>
): Promise<BuiltContext> {
  const config = readConfig();
  let providerMaxInputTokens: number | undefined;
  // vscode-lm 有硬配額，預覽時也要按真實上限算，否則預覽與實際不符。
  if (config.active?.profile.kind === 'vscode-lm') {
    const provider = await resolveProvider();
    providerMaxInputTokens = await provider?.maxInputTokens();
  }
  return buildContext(project, { ...request, providerMaxInputTokens }, config);
}

/**
 * 把一次生成的輸出解析成產物。**不寫盤。**
 *
 * 討論（唯一的 text 類能力）沒有可採納的東西，返回 undefined；
 * 解析出來是空的也返回 undefined——寫一個空產物比不寫更糟，作者會以為存下了。
 */
export function parseDraftArtifact(
  action: CreationAction,
  raw: string,
  target?: CreationTarget,
  range?: ChapterRange
): Artifact | undefined {
  if (outputKindOf(action) !== 'artifact') {
    return undefined;
  }
  // 架構層要看 target 才分得清是哪一件（五件同屬一個階段）；細綱與大綱還要看區間。
  const artifact = parseArtifact(action, raw, target, range);
  return isArtifactEmpty(artifact) ? undefined : artifact;
}

/**
 * 作者在確認框上為這一次指定了模型（`pinnedModel`，runtime/callScope.ts；工程頁「重寫…」「展開…」走的是對話頁這條路）：
 * 預設的「對話頁選定的那個」換成它，視窗也換成它的（第 13 條）。引用無效時 `active` 缺席，照常報錯。
 */
function withPinnedModel(config: NovelConfig): NovelConfig {
  const ref = config.pinnedModel ?? config.model;
  const active = resolveModelRef(config.providers, ref);
  const fallback = readBudgetFallback();
  return {
    ...config,
    model: ref,
    active,
    contextWindow: active?.model.contextWindow ?? fallback.contextWindow,
    maxOutputTokens: active?.model.maxOutputTokens ?? fallback.maxOutputTokens,
  };
}

/**
 * 裝配 + 調模型 + 解析。**一個字都不寫磁碟。**
 *
 * 失敗時往 `errorLog` 記一條掛在目標細綱上，成功時清掉（第 16 條）。
 * 取消不算失敗——那是使用者自己點的。
 */
export async function generate(
  project: NovelProject,
  requested: Omit<BuildRequest, 'providerMaxInputTokens'>,
  handlers: GenerateHandlers,
  options: GenerateOptions
): Promise<GenerateResult> {
  let request = requested;
  // 幹活那個模型的視窗優先：換了 provider 卻拿對話頁那個模型的視窗切上下文，
  // 是第 13 條明確點名的錯法。
  const base = readConfig();
  const own = !options.provider && base.pinnedModel ? withPinnedModel(base) : base;
  const config = options.budget ? { ...own, ...options.budget } : own;
  let provider = options.provider;
  if (!provider) {
    if (!config.active) {
      const issue = describeModelIssue(config.providers, config.model);
      log.error(`模型引用無效：${issue}`, `當前引用 ${config.model || '（空）'}`);
      handlers.onError(issue);
      return {};
    }
    provider = await buildProvider(config.active);
    if (!provider) {
      log.error(`未配置「${providerLabel(config.active.profile)}」的 API Key`);
      handlers.onError(
        `未配置「${providerLabel(config.active.profile)}」的 API Key。可在設定頁錄入，或換一個已配置好的模型。`
      );
      return {};
    }
  }

  const startedAt = Date.now();
  const { stage, capability } = request.action;
  const what = `${STAGE_LABEL[stage]}·${CAPABILITY_LABEL[capability]}`;
  const where = await describe(project, request.target);
  log.info(
    `開始${what}：${where}`,
    `模型 ${provider.label}${request.targetWords ? `｜目標 ${request.targetWords} 字` : ''}` +
      `${request.attachments?.length ? `｜引用 ${request.attachments.length} 項` : ''}` +
      `${request.history?.length ? `｜歷史 ${request.history.length} 輪` : ''}`
  );

  // 寫正文：寫法、目標字數、上一版與上一章結尾都按磁碟定好了再裝配（三期計劃 §1–§2）。
  const writing = stage === 'manuscript' && capability === 'generate' ? await planWriting(project, request) : undefined;
  if (writing && request.writeMode === 'revise' && writing.mode !== 'revise') {
    log.warn('修稿時這一章已經沒有正文了', where);
    handlers.onError('這一章已經沒有正文了，沒法修稿。');
    return {};
  }
  // 審稿：這一章的正文與凍結的目標清單也在裝配之前定好（契約裡給模型的與鏈上校驗用的是同一份）。
  const reviewing = stage === 'manuscript' && capability === 'review' ? await planReview(project, request) : undefined;
  if (stage === 'manuscript' && capability === 'review') {
    if (!reviewing) {
      log.warn('這一章還沒有正文，沒法審稿', where);
      handlers.onError('這一章還沒有正文，沒法審稿。');
      return {};
    }
    request = { ...request, reviewGoals: [...reviewing.goals] };
    log.info(`審稿：${where}`, `正文 ${countWords(reviewing.text)} 字｜目標 ${reviewing.goals.length} 項`);
  }
  // 開著刪修飾時往多寫一點，刪完落在目標附近（修稿不刪修飾，原稿多長就多長）。
  const aim = writing && writing.mode !== 'revise' ? writingAim(writing.target, config.trimModifiers) : writing?.target;
  if (writing) {
    request = {
      ...request,
      writeMode: writing.mode,
      targetWords: aim,
      revision: writing.mode === 'revise' ? writing.revision : request.revision ?? writing.revision,
      // 執行卡後面「本章不出場」那一行與寫完查的是同一份（五期補遺 §1.2）。
      notYet: writing.notYet.map(({ name, no }) => ({ name, no })),
      // 【本章邊界】裡點名不許用的詞，與寫完數的同一份。
      ...(writing.banned.length > 0 ? { banned: writing.banned } : {}),
    };
    log.info(
      `寫法：${WRITE_MODE_LABEL[writing.mode]}`,
      `${writing.target ? `目標 ${writing.target} 字` : '沒有目標字數（不自動續寫）'}` +
        `${writing.existing ? `｜已有 ${countWords(writing.existing)} 字` : ''}`
    );
  }

  const providerMaxInputTokens = await provider.maxInputTokens();
  const buildStart = Date.now();
  const built = await buildContext(project, { ...request, providerMaxInputTokens }, config);
  logAssembly(built, buildStart);

  let reasoning = '';
  // 一次請求一份用量：同一次請求裡服務商分幾次回報（Anthropic 輸入/輸出分開給），按欄位合併；續寫、修復重試、
  // 刪修飾各是一次新的請求，各記各的，最後再加總（合到一份裡只會剩最後那次）。
  const usages: TokenUsage[] = [];
  const streamOptions: StreamOptions = {
    maxOutputTokens: config.maxOutputTokens,
    temperature: config.temperature,
    timeoutMs: config.requestTimeoutMs,
    signal: options.signal,
    ...(options.thinking ? { thinking: options.thinking } : {}),
  };

  let draft: Draft | undefined;
  let full = '';
  const streamOnce = async (
    messages: typeof built.messages,
    progress?: { round: number; base: number },
    opts: { quiet?: boolean; temperature?: number } = {}
  ): Promise<CallOutcome> => {
    let text = '';
    let stop: StopSignal | undefined;
    const usage: TokenUsage = {};
    usages.push(usage);
    let firstDeltaAt = 0;
    let reportedAt = 0;
    const report = () => {
      if (progress && handlers.onProgress) {
        reportedAt = Date.now();
        handlers.onProgress({ round: progress.round, words: progress.base + countWords(text), target: writing?.target });
      }
    };
    report();
    const options = opts.temperature === undefined ? streamOptions : { ...streamOptions, temperature: opts.temperature };
    for await (const ev of provider.stream(messages, options)) {
      if (ev.type === 'text') {
        if (!firstDeltaAt) {
          firstDeltaAt = Date.now();
          log.debug('首個分片已到達', `首字延遲 ${elapsed(startedAt, firstDeltaAt)}`);
        }
        text += ev.text;
        if (opts.quiet) {
          continue;
        }
        full += ev.text;
        handlers.onDelta(ev.text, full);
        // 數字隨流一起漲，但不必每個分片都數一遍：幾千個分片 × 幾千字是平方級的活。
        if (Date.now() - reportedAt >= PROGRESS_INTERVAL_MS) {
          report();
        }
      } else if (ev.type === 'reasoning') {
        reasoning += ev.text;
        handlers.onReasoning?.(ev.text, reasoning);
      } else if (ev.type === 'usage') {
        mergeUsage(usage, ev.usage);
      } else if (ev.type === 'stop') {
        stop = ev.reason;
      }
    }
    report();
    return { text, stop };
  };

  try {
    const first = await streamOnce(
      built.messages,
      writing ? { round: 0, base: countWords(writing.existing) } : undefined
    );
    const chain = chainOf(request);
    let result: ChainResult;
    let written: ManuscriptChainResult | undefined;
    let report: ReviewReport | undefined;
    if (chain) {
      const transcriber = lazyTranscriber();
      const io: ChainIO = {
        messages: built.messages,
        build: async (patch) => (await buildContext(project, { ...request, ...patch, providerMaxInputTokens }, config)).messages,
        call: async (messages, label, opts) => {
          // 後面幾次照樣流進同一個氣泡，前面一行說清這一次在補什麼（第 11 條：不悶著幹活）。
          // 正文續寫只空一行：讀起來得是同一章。
          const head = opts?.separator ?? `\n\n——${label}——\n\n`;
          full += head;
          handlers.onDelta(head, full);
          log.info(`${what}：${label}`);
          return streamOnce(messages, opts?.progress, { quiet: opts?.quiet, temperature: opts?.temperature });
        },
        // 轉寫（細綱試點）：不跟對話頁選的模型，走「轉寫」那一檔（model/tiers.ts）。氣泡裡只加一行，JSON 在鏈結束時整份換上去。
        transcribe: async (messages, label) => {
          const own = await transcriber();
          const head = `\n\n——${label}${own ? `（${own.label}）` : ''}——\n\n`;
          full += head;
          handlers.onDelta(head, full);
          if (!own) {
            log.warn(`${what}：${label}`, '轉寫那一檔沒有可用的模型，改用幹活那個模型轉寫');
            return streamOnce(messages, undefined, { quiet: true, temperature: TRANSCRIBE_TEMPERATURE });
          }
          log.info(`${what}：${label}`, `轉寫模型 ${own.label}`);
          const r = await transcribeWith(own, messages, label, config.requestTimeoutMs, options.signal);
          usages.push(r.usage);
          return { text: r.text, stop: r.stopReason };
        },
        reset: (text) => {
          full = text;
          handlers.onReset?.(full);
        },
      };
      if (chain === 'manuscript' && writing) {
        written = await completeManuscript(first, io, {
          mode: writing.mode,
          existing: writing.existing,
          target: writing.target,
          aim,
          prevEnding: writing.prevEnding,
          reasoned: !!reasoning,
          notYet: writing.notYet,
          banned: writing.banned,
          trim: config.trimModifiers,
          onProgress: handlers.onProgress,
          signal: options.signal,
        });
        result = written;
      } else if (chain === 'revision' && writing) {
        result = await completeRevision(first, io, {
          source: writing.revision?.previousDraft ?? '',
          wordsPerChapter: (await project.readBookConfig()).wordsPerChapter,
          onProgress: handlers.onProgress,
          signal: options.signal,
        });
      } else if (chain === 'review' && reviewing) {
        const reviewed = await completeReview(first, io, reviewing);
        report = reviewed.report;
        result = reviewed;
      } else {
        result = await runChain(project, chain, request, first, io);
      }
    } else {
      // 清理只對正文做：JSON 產物裡的 ``` 由 stripCodeFence 在解析時處理，
      // 在這裡剝會把「去掉開場白」那幾條正則用到 JSON 上，可能切壞結構。
      const raw = stage === 'manuscript' ? cleanOutput(first.text) : first.text.trim();
      result = { raw, notes: singleShotNotes(stage, raw, first.stop, request.range), calls: 1 };
    }

    const raw = result.raw;
    handlers.onDone(raw);
    const artifact = parseDraftArtifact(request.action, raw, request.target, request.range);
    draft = {
      id: makeDraftId(),
      action: request.action,
      target: request.target,
      raw,
      artifact,
      summary: artifact ? describeArtifact(artifact) : undefined,
      words: countWords(raw),
      reasoning: reasoning || undefined,
      createdAt: new Date().toISOString(),
      ...(request.range ? { range: request.range } : {}),
      ...(result.notes.length > 0 ? { notes: result.notes } : {}),
      calls: result.calls,
      ...(writing ? { writeMode: writing.mode } : {}),
      ...(report ? { review: report } : {}),
      ...(writing && written
        ? {
            length: {
              words: written.words,
              target: writing.target,
              added: written.added,
              rounds: written.rounds,
              reached: !written.short,
            },
            ...(written.replay ? { replay: written.replay } : {}),
            ...(written.untrimmed ? { untrimmed: written.untrimmed } : {}),
          }
        : {}),
    };
    if (result.notes.length > 0) {
      log.warn(`${what}：${result.notes.length} 處降級或說明`, result.notes.join('\n'));
    }
    // 有實測用量就記一筆：估算準不準，只有對著服務商的賬單才看得出來。
    recordUsages(built.usedTokens, usages);
    const usageNote = describeUsages(built.usedTokens, usages);
    log.info(
      `${what}完成`,
      `產出 ${full.length} 字，呼叫 ${result.calls} 次，用時 ${elapsed(startedAt)}` +
        `${reasoning ? `；另有思考 ${reasoning.length} 字` : ''}` +
        `${usageNote ? `；${usageNote}` : ''}`
    );
    await clearFailure(project, request.target);
  } catch (err) {
    if (err instanceof CancelledError || options.signal.aborted) {
      log.warn('生成被取消', `已產出內容，用時 ${elapsed(startedAt)}`);
      handlers.onCancelled();
    } else if (err instanceof ChainError) {
      // 鏈走不下去：已經收到的輸出留在氣泡裡（作者能拿去手改），不出落盤卡片。
      handlers.onDone(full.trim());
      // 請求都發出去了，用量照樣記。
      recordUsages(built.usedTokens, usages);
      const usageNote = describeUsages(built.usedTokens, usages);
      log.error(`${what}失敗：${err.message}`, [`呼叫 ${err.calls} 次`, ...(usageNote ? [usageNote] : []), ...err.notes].join('\n'));
      handlers.onError(err.message);
      await noteFailure(project, request.target, `${what}失敗：${err.message}`, `位置 ${where}；呼叫 ${err.calls} 次`);
    } else {
      log.error(`${what}失敗：${describeError(err)}`, err);
      handlers.onError(describeError(err));
      await noteFailure(project, request.target, `${what}失敗：${describeError(err)}`, `位置 ${where}`);
    }
  }

  return { draft, built };
}

// ---------------------------------------------------------------- 內部

/**
 * 記下這次生成每一次請求的實測用量。估算只算了第一次請求的上下文（`built.usedTokens`），所以只有第一次拿來
 * 對估算偏差；後面續寫、修復重試、刪修飾的輸入是另一份，估算記 0——`recordUsage` 據此只加輸出、不進偏差樣本。
 */
function recordUsages(estimated: number, usages: readonly TokenUsage[]): void {
  usages.forEach((u, i) => recordUsage('創作', i === 0 ? estimated : 0, u));
}

/**
 * 「完成」那一行的用量：只有一次請求時照舊一句；多次時偏差仍拿第一次比，另報幾次請求的合計。有的請求沒回報
 * 用量（有的閘道器不給）時說出來，不把一部分的和當成全部。
 */
function describeUsages(estimated: number, usages: readonly TokenUsage[]): string | undefined {
  const first = describeUsage(estimated, usages[0] ?? {});
  if (usages.length < 2) {
    return first;
  }
  const reported = usages.filter((u) => u.inputTokens !== undefined || u.outputTokens !== undefined);
  if (reported.length === 0) {
    return first;
  }
  const total = sumUsage(reported);
  const parts = [
    total.inputTokens !== undefined ? `輸入 ${total.inputTokens}` : '',
    total.outputTokens !== undefined ? `輸出 ${total.outputTokens}` : '',
  ].filter(Boolean);
  const partial = reported.length < usages.length ? `（其中 ${reported.length} 次回報了用量）` : '';
  return `${first ? `第一次請求${first}；` : ''}${usages.length} 次請求合計${parts.join('、')} token${partial}`;
}

/** 按產物種類接上對應的那條鏈（generation/structured.ts）。 */
async function runChain(
  project: NovelProject,
  chain: NonNullable<ReturnType<typeof chainOf>>,
  request: Omit<BuildRequest, 'providerMaxInputTokens'>,
  first: CallOutcome,
  io: ChainIO
): Promise<ChainResult> {
  switch (chain) {
    case 'config':
      return completeConfig(first, io, {
        existing: await project.readBookConfig(),
        // 只有一句話彈窗發起時，作者這句話才是「一句話」那一節本身；在對話裡說的
        // 「把金手指改狠一點」是修改意見，寫進「一句話」就錯了。
        idea: request.setup ? request.ask.trim() || undefined : undefined,
        setup: request.setup,
      });
    case 'roster':
      return completeRoster(first, io);
    case 'loreList':
      return completeLoreList(first, io, await loreListKnown(project));
    case 'loreExpand':
      return completeLoreExpand(first, io, await loreExpandKnown(project, request.target));
    case 'loreSettle':
      return completeLoreSettle(first, io, await loreSettleKnown(project));
    case 'blueprints':
      return completeBlueprints(first, io, chaptersOf(request.range!));
    case 'plot':
      return completePlot(first, io, await plotNoOf(project, request));
    case 'manuscript':
    case 'revision':
      // 正文那一條要的東西（寫法、已有正文、上一章結尾）在 `planWriting` 裡，走不到這裡。
      throw new Error('正文的續寫鏈缺了寫法。');
    case 'review':
      throw new Error('審稿鏈缺了待審的正文。');
  }
}

/**
 * 單章細綱是第幾章：細綱在磁碟上就按它認，還沒有就看檔名，再不行用請求裡的章號。轉寫合同要它（原文不寫章號時就是這一章）。
 */
async function plotNoOf(project: NovelProject, request: Omit<BuildRequest, 'providerMaxInputTokens'>): Promise<number | undefined> {
  const relPath = plotOfTarget(request.target);
  const plot = relPath ? await project.resolvePlot(relPath) : undefined;
  return plot?.no ?? (relPath ? parsePlotFileName(basename(relPath))?.no : undefined) ?? request.targetNo;
}

/**
 * 設定清單那條鏈要對照的：本書的目錄樹（照用、只補缺的）、已有條目（照抄名字）、角色卡上的人
 * （人不是設定）。對話頁與補齊架構（features/pipelineBatch.ts）共用。
 */
export async function loreListKnown(project: NovelProject): Promise<LoreListKnown> {
  const [categories, entries, cards] = await Promise.all([project.listLoreCategories(), project.listLore(), project.listCharacters()]);
  return { categories, entries, people: cards.flatMap((c) => [c.name, ...c.aliases]) };
}

/**
 * 展開一條設定那條鏈要對照的：這一條的標題、全部條目（子條目名字已有條目的不另建，別的條目的標題不進關鍵詞）、
 * 角色卡上的人（人不是設定）、名錄裡另記著的名字（不進關鍵詞，同建條目、整合）。對話頁與批次展開
 * （features/lore.ts 的 `expandLoreEntries`）共用。
 */
export async function loreExpandKnown(project: NovelProject, target: CreationTarget): Promise<LoreExpandKnown> {
  const [entries, cards] = await Promise.all([project.listLore(), project.listCharacters()]);
  const { entry } = await loreEntryAt(project, target.kind === 'lore' ? target.relPath : '', entries);
  const { unknown } = await buildLoreIndex(project, { entries, cards }, { pending: false });
  return {
    title: entry.title,
    entries,
    people: cards.flatMap((c) => [c.name, ...c.aliases]),
    recorded: unknown.map((u) => u.name),
  };
}

/**
 * 落定設定那條鏈要對照的：全部條目（認出改的是哪一條；別的條目的標題不進關鍵詞）、角色卡上的人（人不是設定）、
 * 名錄裡另記著的名字（不進關鍵詞）。
 */
async function loreSettleKnown(project: NovelProject): Promise<LoreSettleKnown> {
  const [entries, cards] = await Promise.all([project.listLore(), project.listCharacters()]);
  const { unknown } = await buildLoreIndex(project, { entries, cards }, { pending: false });
  return { entries, people: cards.flatMap((c) => [c.name, ...c.aliases]), recorded: unknown.map((u) => u.name) };
}

// ---------------------------------------------------------------- 寫正文

/** 流式期間多久報一次進度。 */
const PROGRESS_INTERVAL_MS = 300;

const WRITE_MODE_LABEL: Record<WriteMode, string> = {
  write: '新寫一章',
  continue: '接著寫（追加）',
  rewrite: '重寫（覆蓋前審閱）',
  revise: '按審稿意見修稿（覆蓋前審閱）',
};

/**
 * 重寫時交給 `revision` 層的那句修改意見。作者這一輪說的話已經在「補充要求」與執行卡裡，
 * 這裡不再抄一遍。
 */
const REWRITE_FEEDBACK = '照本章細綱與上面的補充要求重寫這一章。上一版裡與細綱不衝突、寫得好的段落可以保留。';

export interface WritingPlan {
  mode: WriteMode;
  /** 目標字數。修稿時是原稿的字數：只給進度條用，不據此續寫。 */
  target?: number;
  /** `continue` 寫法下本章已有的正文；其餘是空串。 */
  existing: string;
  prevEnding?: string;
  revision?: { previousDraft: string; feedback: string };
  /**
   * 後面幾章才登場的人（帶角色卡上的專屬稱呼）：寫完查有沒有提前寫進來（§1.2）。與執行卡裡
   * 「本章不出場」那一行同一個函式、同一個視窗算的（context/layers/dialog.ts 的 `promptFactsOf`）。
   */
  notYet: (NotYet & { aliases: string[] })[];
  /** 這本書寫正文時不該用的詞（文風指南的禁用詞表、全域要求裡禁止的詞、古代題材的現代說法）：寫完數一遍。 */
  banned: string[];
}

/**
 * 寫法按磁碟定：這一章還沒有正文 → `write`；明說了接著寫 → `continue`；明說了修稿 → `revise`；
 * 其餘 → `rewrite`。
 *
 * 純函式單列出來：「對話裡發寫正文、這一章已經有正文」從前是追加，現在是覆蓋審閱——
 * 這條改動的判據只在這裡（見 model/pipeline.ts 的 `WriteMode`）。修稿要一章已有的正文，
 * 沒有正文時它不成立，呼叫方據此報錯（不會退成「新寫一章」）。
 */
export function resolveWriteMode(body: string, requested?: WriteMode): WriteMode {
  if (!body.trim()) {
    return 'write';
  }
  return requested === 'continue' || requested === 'revise' ? requested : 'rewrite';
}

/**
 * 寫正文之前要從磁碟知道的事。
 *
 * - **目標字數**：請求給了用請求的，否則細綱的 `targetWords`，再否則配置的每章字數（D6）。
 *   agent 工具與快速續寫不傳它，從此也有目標。
 * - **上一章結尾**：按磁碟現讀（重演檢測用），不取上下文裡那一份——那一份可能被整章全文
 *   取代、或被作者取消勾選。
 *
 * 批次寫章（features/pipelineBatch.ts）也走這一份：兩條路的寫法、目標與重演檢測必須同源。
 */
export async function planWriting(project: NovelProject, request: Omit<BuildRequest, 'providerMaxInputTokens'>): Promise<WritingPlan> {
  const relPath = plotOfTarget(request.target);
  const plot = relPath ? await project.resolvePlot(relPath) : undefined;
  const no = plot?.no ?? (relPath ? parsePlotFileName(basename(relPath))?.no : undefined) ?? request.targetNo;
  const book = await project.readBookConfig();
  const target = request.targetWords ?? plot?.targetWords ?? book.wordsPerChapter;
  // 與內建編輯器的寫作體檢同一個函式、同一份輸入（views/checkTerms.ts）：編輯器裡標出來的就是這裡寫完數的。
  const banned = await readBannedTerms(project, { book });
  const chapter = no ? await project.getChapter(no) : undefined;
  const body = chapter ? await project.readChapterText(chapter) : '';
  const mode = resolveWriteMode(body, request.writeMode);
  const prev = no && no > 1 ? await project.getChapter(no - 1) : undefined;
  const prevText = prev ? await project.readChapterText(prev) : '';
  if (mode === 'revise') {
    // 修稿的「上一版」就是磁碟上此刻這一章：清單是按它定位過的（controller 在發起前重新定位過）。
    return {
      mode,
      target: countWords(body),
      existing: '',
      prevEnding: prevText.trim() ? previousEnding(prevText) : undefined,
      revision: { previousDraft: body, feedback: request.reviseBrief?.trim() ?? '' },
      notYet: [],
      banned,
    };
  }
  return {
    mode,
    target: target && target > 0 ? target : undefined,
    existing: mode === 'continue' ? body : '',
    prevEnding: prevText.trim() ? previousEnding(prevText) : undefined,
    revision: mode === 'rewrite' ? { previousDraft: body, feedback: REWRITE_FEEDBACK } : undefined,
    notYet: no ? await notYetOf(project, no, plot) : [],
    banned,
  };
}

/**
 * 第 `no` 章「本章不出場」的人，帶角色卡上的專屬稱呼。視窗與裝配器的 `plotAhead` 一樣：後
 * {@link AHEAD_PLOTS} 章裡排過細綱的。本章細綱自己提到了的人不算（`dropMentioned`）。
 */
async function notYetOf(project: NovelProject, no: number, plot: Plot | undefined): Promise<(NotYet & { aliases: string[] })[]> {
  const plots = await project.listChapterPlots();
  const list = notYetOnStage({
    self: plot?.characters ?? [],
    previous: plots.filter((p) => p.no < no),
    ahead: plots.filter((p) => p.no > no && p.no <= no + AHEAD_PLOTS && isPlotFilled(p.sections)),
  });
  if (list.length === 0) {
    return [];
  }
  const cards = await project.listCharacters();
  const withAliases = list.map((who) => ({ ...who, aliases: cards.find((c) => c.name === who.name)?.aliases ?? [] }));
  return dropMentioned(withAliases, plot ? Object.values(plot.sections).join('\n') : '');
}

/**
 * 審稿之前要從磁碟知道的事：這一章的正文（去掉標題行）與指紋、凍結的目標清單。
 * 這一章還沒有正文時 undefined——沒有東西可審。
 */
export async function planReview(
  project: NovelProject,
  request: Omit<BuildRequest, 'providerMaxInputTokens'>
): Promise<ReviewChainContext | undefined> {
  const relPath = plotOfTarget(request.target);
  const plot = relPath ? await project.resolvePlot(relPath) : undefined;
  const no = plot?.no ?? (relPath ? parsePlotFileName(basename(relPath))?.no : undefined) ?? request.targetNo;
  const chapter = no ? await project.getChapter(no) : undefined;
  const text = chapter ? await project.readChapterText(chapter) : '';
  if (!chapter || !no || !text.trim()) {
    return undefined;
  }
  return {
    text,
    goals: plot ? freezeGoals(plot.sections.关键事件) : [],
    chapterNo: no,
    chapterTitle: plot?.title || (isFallbackChapterTitle(no, chapter.title) ? undefined : chapter.title),
    chapterRelPath: chapter.relPath,
    chapterHash: chapter.contentHash,
  };
}

/**
 * Draft id。
 *
 * 與 `makeTurnId` 同一套理由：它是會話檔案裡的外來鍵，同一毫秒內連開兩份
 * （agent 一輪裡生成兩次）必須保證不撞。
 */
let draftCounter = 0;
export function makeDraftId(): string {
  draftCounter += 1;
  return `d${Date.now().toString(36)}-${draftCounter.toString(36)}`;
}

/** 目標的人話描述，日誌與失敗記錄共用。 */
async function describe(project: NovelProject, target: CreationTarget): Promise<string> {
  const relPath = plotOfTarget(target);
  if (!relPath) {
    return describeTarget(target);
  }
  const plot = await project.resolvePlot(relPath);
  return describeTarget(target, { no: plot?.no, title: plot?.title });
}

/**
 * 失敗掛在**細綱**上（工程頁那一行）；展開一條設定失敗掛在那一條設定上（第 16 條，同整合）。
 * 大綱沒有歸屬行，只進日誌。
 */
async function noteFailure(
  project: NovelProject,
  target: CreationTarget,
  message: string,
  detail: string
): Promise<void> {
  const owner = failureOwnerOf(target);
  if (!owner) {
    return;
  }
  await recordFailure(project, {
    scope: '創作',
    targetKind: owner.kind,
    targetKey: owner.key,
    severity: 'error',
    op: 'creation',
    message,
    detail,
  });
}

async function clearFailure(project: NovelProject, target: CreationTarget): Promise<void> {
  const owner = failureOwnerOf(target);
  if (owner) {
    await clearFailures(project, owner.kind, owner.key, 'creation');
  }
}

function failureOwnerOf(target: CreationTarget): { kind: 'plot' | 'lore'; key: string } | undefined {
  const plot = plotOfTarget(target);
  if (plot) {
    return { kind: 'plot', key: plot };
  }
  const lore = loreOfTarget(target);
  return lore ? { kind: 'lore', key: lore } : undefined;
}

/**
 * 把這次裝配的結果寫進日誌。
 *
 * 只記條目名與 token 數，**絕不記 prompt 全文**——那是十萬字級的東西，
 * 一次就能把整個日誌緩衝擠空。降級/丟棄的條目單列一段，對應
 * 「不靜默截斷」那條承諾：介面上的明細摺疊著，日誌裡得看得見。
 */
function logAssembly(built: BuiltContext, startedAtMs: number): void {
  const kept = built.items.filter((i) => i.status === 'included' || i.status === 'degraded');
  const lost = built.items.filter((i) => i.status === 'dropped' || i.status === 'degraded');
  const percent = built.budget > 0 ? Math.round((built.usedTokens / built.budget) * 100) : 0;

  log.info(
    `上下文已裝配：${built.usedTokens}/${built.budget} token（${percent}%），${kept.length} 項`,
    `${built.messages.length} 條訊息，用時 ${elapsed(startedAtMs)}｜上下文詳細度 ${CONTEXT_DETAIL_LABEL[built.detail]}` +
      `${built.budgetClampedByProvider ? '｜預算被服務商配額壓低' : ''}`
  );
  if (lost.length > 0) {
    log.warn(
      `${lost.length} 項被降級或丟棄`,
      lost.map((i) => `${statusLabel(i.status)} ${i.label}${i.note ? `——${i.note}` : ''}`).join('\n')
    );
  }
}

function statusLabel(status: string): string {
  return status === 'degraded' ? '[降級]' : status === 'dropped' ? '[丟棄]' : `[${status}]`;
}
