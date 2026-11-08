/**
 * 工程頁任務那條路的 {@link ChainIO}。從 `pipelineBatch.ts` 挪出來單放：批次拆細綱要調
 * `lore.ts` 的批次展開，批次展開又要用它，放在任何一邊都會互相 import。
 */
import { readConfig } from '../config';
import { CollectResult, collect } from '../llm/collect';
import { ModelPool, createModelPool } from '../llm/pool';
import type { ChatMessage, LlmProvider } from '../llm/provider';
import { NovelProject } from '../model/project';
import { BuildRequest, buildContext } from '../context/builder';
import { CallOutcome, ChainIO } from '../generation/structured';
import { TRANSCRIBE_TEMPERATURE } from '../model/transcribe';
import { TranscribeCall } from './transcribe';
import { scoped } from '../runtime/logger';

const log = scoped('模型池');

/**
 * 批次那條路的 {@link ChainIO}：每次呼叫走分檔池（失敗換同檔其餘，第 12 條），
 * 裝配用幹活那個模型的視窗（第 13 條：`pool.primaryBudget`），不帶思考深度（第 26 條）。
 * 轉寫（細綱試點）走「轉寫」那一檔自己的池（{@link lazyTranscriber}）。
 */
export function poolIO(
  project: NovelProject,
  pool: ModelPool,
  config: ReturnType<typeof readConfig>,
  signal: AbortSignal,
  base: Omit<BuildRequest, 'providerMaxInputTokens'>
): { chain: ChainIO; calls: () => number } {
  let count = 0;
  const budgeted = { ...config, ...pool.primaryBudget };
  const transcriber = lazyTranscriber();
  const chain: ChainIO = {
    messages: [],
    build: async (patch) => (await buildContext(project, { ...base, ...patch }, budgeted)).messages,
    call: async (messages, label): Promise<CallOutcome> => {
      count++;
      const r = await pool.run(label, (llm) =>
        collect(
          llm.stream(messages, {
            maxOutputTokens: pool.primaryBudget.maxOutputTokens,
            temperature: config.temperature,
            timeoutMs: config.requestTimeoutMs,
            signal,
          })
        )
      );
      return { text: r.text, stop: r.stopReason };
    },
    transcribe: async (messages, label): Promise<CallOutcome> => {
      count++;
      const own = await transcriber();
      if (!own) {
        log.warn(`${label}：轉寫那一檔沒有可用的模型，改用幹活那個模型轉寫`);
      }
      const r = await transcribeWith(own ?? pool, messages, label, config.requestTimeoutMs, signal);
      return { text: r.text, stop: r.stopReason };
    },
  };
  return { chain, calls: () => count };
}

/**
 * 「轉寫」那一檔的池（2026-10-25 起；model/tiers.ts：不跟確認框上為這一次挑的模型，那一檔沒配就沿用預設模型），
 * 第一次用到時才建。建不出來（一個可用的模型都沒有）是 undefined，呼叫方退回幹活那個模型並說一聲。
 */
export function lazyTranscriber(): () => Promise<ModelPool | undefined> {
  let pool: Promise<ModelPool | undefined> | undefined;
  return () => (pool ??= createModelPool({ task: 'transcribe', concurrent: false }));
}

/** 轉寫退回用的那一個：模型池，或定稿時傳進來的單個模型（finalizeSteps.ts 的 `ModelRunner`）——轉寫只用到這兩樣。 */
export interface TranscribeFallback {
  run<T>(what: string, fn: (llm: LlmProvider) => Promise<T>): Promise<T>;
  readonly primaryBudget: ModelPool['primaryBudget'];
}

/**
 * 工程頁任務（定稿、敘事線、角色卡、設定……）的轉寫呼叫（features/transcribe.ts 的 `TranscribeCall`）：走「轉寫」那一檔，
 * 第一次用到時才建池。那一檔一個可用的模型都沒有時用 `fallback`（幹活那個池或模型）並說一聲；連它也沒有就報錯——
 * `transcribeJson` 把它當成轉寫呼叫失敗，寫好的原文照這一步原來解析失敗的走法處理。
 * `fallback` 只要能 `run`、有視窗就行（{@link TranscribeFallback}）：單章同步預設用對話頁那一個模型（features/finalize.ts 的
 * `singleModel`），不是池。
 */
export function poolTranscriber(signal: AbortSignal, fallback?: TranscribeFallback): TranscribeCall {
  const own = lazyTranscriber();
  const timeoutMs = readConfig().requestTimeoutMs;
  return async (messages, label) => {
    const pool = await own();
    if (!pool && !fallback) {
      throw new Error('轉寫那一檔沒有可用的模型');
    }
    if (!pool) {
      log.warn(`${label}：轉寫那一檔沒有可用的模型，改用幹活那個模型轉寫`);
    }
    const r = await transcribeWith(pool ?? fallback!, messages, label, timeoutMs, signal);
    return { text: r.text, stop: r.stopReason };
  };
}

/** 轉寫一次：照抄，溫度 0、不帶思考，輸出上限用轉寫模型自己的。失敗照池的規矩換同檔其餘。 */
export function transcribeWith(
  pool: TranscribeFallback,
  messages: ChatMessage[],
  label: string,
  timeoutMs: number,
  signal: AbortSignal
): Promise<CollectResult> {
  return pool.run(label, (llm) =>
    collect(
      llm.stream(messages, {
        maxOutputTokens: pool.primaryBudget.maxOutputTokens,
        temperature: TRANSCRIBE_TEMPERATURE,
        timeoutMs,
        signal,
      })
    )
  );
}
