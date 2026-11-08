import { ThinkingDepth } from '../model/thinking';

/** 一次請求的真實 token 用量。欄位缺席表示該服務商沒給這一項。 */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * provider 吐出的唯一原語。
 *
 * 思考（reasoning）與正文（text）分成兩種事件而不是兩個回呼：思考不該被
 * 寫入章節，但它可能先跑幾十秒才開始吐正文，介面在這期間必須有反饋。
 * usage 同理是一等公民——它是校準 tokenCounter 的唯一實測來源，沒有
 * 「呼叫方想不想聽」這回事。
 */
export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'usage'; usage: TokenUsage }
  /**
   * 上游自己報的收尾原因。**不是給介面看的**，是用來分清收尾與截斷（見 `StopSignal`）。
   */
  | { type: 'stop'; reason: StopSignal };

/**
 * 上游報的收尾原因，歸一成三檔。
 *
 * 用它的是需要分清「模型自己收了尾」與「被輸出上限截斷」的呼叫方：正文續寫鏈
 * （`generation/continuation.ts`）據 `maxTokens` 接著寫、據 `end` 判斷這一章已經
 * 收了尾；工程頁批次（`features/pipelineBatch.ts`）據 `maxTokens` 判斷
 * 結構化輸出是否被截斷。`undefined`（上游沒說）與 `other` 都不敢當成任何一種。
 */
export type StopSignal = 'end' | 'maxTokens' | 'other';

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string };

export interface StreamOptions {
  maxOutputTokens: number;
  temperature: number;
  /**
   * 空閒超時（毫秒）：多久沒收到資料才中止。
   * 流式還在吐字時不計時——整段請求可以遠長於這個值。
   */
  timeoutMs: number;
  /** 外部取消（使用者點「停止」）。超時仍由本模組內部處理。 */
  signal?: AbortSignal;
  /**
   * 這一輪讓模型想多深。缺席或 `off` = 不帶任何思考引數（服務商預設）。
   *
   * 只有作者選定的那個模型的呼叫帶它（對話頁單次生成）——工程頁
   * 的後臺批次任務不帶，理由與第 12 條同源：那一檔模型是作者按成本挑的，
   * 替他把每一章的摘要都升級成深思考，等於繞過他的成本決定。
   */
  thinking?: ThinkingDepth;
}

export interface LlmProvider {
  readonly id: 'openai' | 'anthropic' | 'vscode-lm';
  /** 展示給使用者的模型標識，例如 `deepseek-chat @ api.deepseek.com`。 */
  readonly label: string;
  /**
   * 該 provider 能接受的最大輸入 token。undefined 表示以使用者設定的
   * contextWindow 為準（自建 API 通常如此）。
   */
  maxInputTokens(): Promise<number | undefined>;
  /** 流式對話。逐個 yield 事件，文字用 `collect.ts` 的 collectText 收。 */
  stream(messages: ChatMessage[], options: StreamOptions): AsyncIterable<StreamEvent>;
}

/** 使用者主動取消時拋出，呼叫方據此靜默處理而非報錯。 */
export class CancelledError extends Error {
  constructor() {
    super('已取消');
    this.name = 'CancelledError';
  }
}

/** 服務商返回的錯誤，message 已整理成人話。 */
export class LlmError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface AbortHandle {
  signal: AbortSignal;
  /** 收到資料時呼叫，把空閒計時器撥回滿。dispose 之後是空操作。 */
  poke: () => void;
  /** 請求結束後必須呼叫，否則定時器會洩漏。 */
  dispose: () => void;
}

/**
 * 把外部取消訊號與空閒超時統一成一個 AbortSignal。
 *
 * `timeoutMs` 是「多久沒收到資料」而不是整段請求的上限——流式還在吐字
 * 時呼叫 poke() 重置計時器。返回的 dispose 必須在請求結束後呼叫。
 */
export function makeAbortSignal(options: {
  timeoutMs: number;
  signal?: AbortSignal;
}): AbortHandle {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const arm = () => {
    if (disposed || controller.signal.aborted) {
      return;
    }
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => controller.abort(new Error('timeout')), options.timeoutMs);
  };
  arm();

  const onAbort = () => controller.abort(options.signal?.reason ?? new CancelledError());
  if (options.signal) {
    if (options.signal.aborted) {
      onAbort();
    } else {
      options.signal.addEventListener('abort', onAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    poke: arm,
    dispose: () => {
      disposed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      options.signal?.removeEventListener('abort', onAbort);
    },
  };
}

/** 解析 SSE 響應體，逐條 yield `data:` 後的原始字串（已跳過 [DONE]）。 */
export async function* iterateSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  poke: () => void
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new CancelledError();
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      // 收到任意位元組都算「還在輸出」：心跳註釋、半截事件都算。
      poke();
      buffer += decoder.decode(value, { stream: true });

      // SSE 事件以空行分隔；一個事件裡可能有多行 data:。
      let sep: number;
      while ((sep = indexOfEventBoundary(buffer)) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^(\r?\n){2}/, '');
        const dataLines = rawEvent
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart());
        if (dataLines.length === 0) {
          continue;
        }
        const payload = dataLines.join('\n');
        if (payload === '[DONE]') {
          return;
        }
        yield payload;
      }
    }
  } finally {
    // 提前退出時釋放底層連線。
    void reader.cancel().catch(() => undefined);
  }
}

function indexOfEventBoundary(buffer: string): number {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1) {
    return crlf;
  }
  if (crlf === -1) {
    return lf;
  }
  return Math.min(lf, crlf);
}

/** 統一把 fetch/abort 拋出的異常翻譯成 CancelledError 或 LlmError。 */
export function normalizeError(err: unknown, signal: AbortSignal, providerLabel: string): Error {
  if (err instanceof CancelledError || (err as Error)?.name === 'CancelledError') {
    return new CancelledError();
  }
  if (signal.aborted) {
    const reason = signal.reason;
    if (reason instanceof CancelledError) {
      return new CancelledError();
    }
    return new LlmError(`${providerLabel} 請求超時。可在設定 novel.requestTimeoutMs 中調大。`, err);
  }
  if (err instanceof LlmError) {
    return err;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new LlmError(`${providerLabel} 請求失敗：${msg}`, err);
}
