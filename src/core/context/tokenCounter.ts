/**
 * Token 計數的**可替換實現**。
 *
 * 改造前這裡只有一個寫死的 `estimateTokens`：中文 ×1.5、拉丁 ÷4。它夠用，
 * 但每一處預算計算都直接調那個函式，想換一套更準的演算法（tiktoken、服務商的
 * count_tokens 介面、按模型分詞器區分）就得改遍全倉庫。
 *
 * 現在拆成三層：
 *
 * 1. `TokenCounter` —— 介面。一個計數器要能「數一段文字」與「反推字元數」
 *    （截斷需要後者），可選 `prepare()` 供需要載入 wasm / 詞表的實現用。
 * 2. 登錄檔 —— `registerTokenCounter` / `useTokenCounter`。宿主啟動時可以
 *    註冊更準的實現並切過去，core 裡其餘程式碼只認 `countTokens`。
 * 3. `HeuristicTokenCounter` —— 預設實現，就是原來那套係數，零依賴、同步、
 *    永不失敗。它是兜底：任何更準的實現載入失敗都退回它。
 *
 * 另有一條**校準迴路**：服務商返回真實用量時調 `recordUsage`，這裡記下
 * 「估算 / 實際」的比值。目前只用於日誌與統計展示，**不自動修正估算值**——
 * 估算必須是純函式，否則同一份上下文兩次裝配會得出不同的預算判斷，
 * 「不靜默截斷」的明細也就不可復現了。將來要做自適應計數器，`usageStats()`
 * 就是它的輸入。
 */

/** 一次真實請求的 token 用量，由服務商返回。欄位缺席表示該服務商沒給。 */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface TokenCounter {
  /** 穩定標識，登錄檔的鍵。 */
  readonly id: string;
  /** 展示名，出現在日誌與設定頁。 */
  readonly label: string;
  /**
   * 精度自述。`estimate` 表示只保證量級正確（預算裡另留安全餘量），
   * `exact` 表示與服務商的分詞結果一致。
   */
  readonly accuracy: 'estimate' | 'exact';
  /**
   * 需要非同步初始化時實現它（載入 wasm、拉取詞表）。登錄檔在切換時呼叫一次，
   * 失敗則保留當前計數器——**計數器壞掉不能讓寫作流程停下**。
   */
  prepare?(): Promise<void>;
  /** 數一段文字的 token 數。必須同步：裝配器的預算判斷是逐條同步做的。 */
  count(text: string): number;
  /**
   * 給定 token 預算，反推大致能放多少個字元。截斷用。
   * 寧可少給（截短一點），不能多給（超預算）。
   */
  charsFor(tokens: number): number;
}

/**
 * 預設實現：按字元類別加權。
 *
 * 不引入 tiktoken：一是體積大、需要 wasm，二是不同服務商分詞器本就不同，
 * 精確到個位沒有意義。這裡只要保證「不低估」，預算裡再留安全餘量即可。
 *
 * 經驗係數：
 * - 中日韓字元：約 1 字 ≈ 1.5 token（GPT 系分詞器對中文並不友好）
 * - 拉丁字母：約 4 字元 ≈ 1 token
 * - 其餘字元（標點、空白、數字）：約 3 字元 ≈ 1 token
 */
export class HeuristicTokenCounter implements TokenCounter {
  readonly id = 'heuristic';
  readonly label = '字元加權粗估';
  readonly accuracy = 'estimate' as const;

  constructor(
    private readonly weights: { cjk: number; latin: number; other: number } = {
      cjk: 1.5,
      latin: 1 / 4,
      other: 1 / 3,
    }
  ) {}

  count(text: string): number {
    if (!text) {
      return 0;
    }
    let cjk = 0;
    let latin = 0;
    let other = 0;

    for (const ch of text) {
      const code = ch.codePointAt(0)!;
      if (isCjk(code)) {
        cjk++;
      } else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
        latin++;
      } else {
        other++;
      }
    }

    return Math.ceil(cjk * this.weights.cjk + latin * this.weights.latin + other * this.weights.other);
  }

  /** 按中文為主反推——中文最「貴」，用它算出的字元數最保守。 */
  charsFor(tokens: number): number {
    return Math.floor(tokens / this.weights.cjk);
  }
}

function isCjk(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // 中日韓統一表意文字
    (code >= 0x3400 && code <= 0x4dbf) || // 擴充套件 A
    (code >= 0xf900 && code <= 0xfaff) || // 相容表意文字
    (code >= 0x3040 && code <= 0x30ff) || // 假名
    (code >= 0xac00 && code <= 0xd7af) || // 諺文
    (code >= 0x3000 && code <= 0x303f) // 中日韓標點
  );
}

// ---------------------------------------------------------------- 登錄檔

const counters = new Map<string, TokenCounter>();
const fallback = new HeuristicTokenCounter();
let active: TokenCounter = fallback;

registerTokenCounter(fallback);

export function registerTokenCounter(counter: TokenCounter): void {
  counters.set(counter.id, counter);
}

export function listTokenCounters(): TokenCounter[] {
  return [...counters.values()];
}

export function activeTokenCounter(): TokenCounter {
  return active;
}

/**
 * 切換當前計數器。未註冊的 id 或 `prepare()` 拋錯都當作切換失敗：
 * 保持原計數器並返回 false，絕不讓寫作流程因為「數不了 token」停下。
 */
export async function useTokenCounter(id: string): Promise<boolean> {
  const next = counters.get(id);
  if (!next) {
    return false;
  }
  try {
    await next.prepare?.();
  } catch {
    return false;
  }
  active = next;
  return true;
}

/** 測試與宿主重啟用：退回預設實現。 */
export function resetTokenCounter(): void {
  active = fallback;
}

/** 數一段文字的 token 數（走當前計數器）。 */
export function countTokens(text: string): number {
  return active.count(text);
}

/** 目標 token 數對應的大致字元數（走當前計數器）。 */
export function charsForTokens(tokens: number): number {
  return Math.max(0, active.charsFor(tokens));
}

// ---------------------------------------------------------------- 校準統計

export interface UsageSample {
  /** 來源，如「續寫」「摘要」。 */
  scope: string;
  /** 發出請求前我們估的輸入 token。 */
  estimated: number;
  /** 服務商返回的真實輸入 token。 */
  actual: number;
}

export interface UsageStats {
  samples: number;
  /** 累計估算值 / 累計真實值。>1 表示我們高估（安全方向）。 */
  ratio: number;
  estimatedTotal: number;
  actualTotal: number;
  /** 服務商真實計費的輸出 token 累計。 */
  outputTotal: number;
}

const MAX_SAMPLES = 200;
const samples: UsageSample[] = [];
let outputTotal = 0;

/**
 * 記一次真實用量。
 *
 * 只在服務商確實返回了 usage 時呼叫（OpenAI 需要 `stream_options.include_usage`，
 * Anthropic 在 message_start / message_delta 裡給）。沒有 usage 的服務商
 * 什麼都不記——寧可樣本少，也不能拿估算值冒充實測把比值汙染掉。
 */
export function recordUsage(scope: string, estimated: number, usage: TokenUsage): void {
  if (usage.outputTokens !== undefined) {
    outputTotal += usage.outputTokens;
  }
  if (usage.inputTokens === undefined || usage.inputTokens <= 0 || estimated <= 0) {
    return;
  }
  samples.push({ scope, estimated, actual: usage.inputTokens });
  if (samples.length > MAX_SAMPLES) {
    samples.shift();
  }
}

export function usageStats(): UsageStats {
  const estimatedTotal = samples.reduce((sum, s) => sum + s.estimated, 0);
  const actualTotal = samples.reduce((sum, s) => sum + s.actual, 0);
  return {
    samples: samples.length,
    ratio: actualTotal > 0 ? estimatedTotal / actualTotal : 1,
    estimatedTotal,
    actualTotal,
    outputTotal,
  };
}

export function resetUsageStats(): void {
  samples.length = 0;
  outputTotal = 0;
}

/**
 * 一句話描述本次估算與實測的偏差，供日誌用。沒有實測資料時返回 undefined。
 * 用途是讓作者在日誌頁能看出「外掛報的 token 數靠不靠譜」。
 */
export function describeUsage(estimated: number, usage: TokenUsage): string | undefined {
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) {
    const delta = estimated > 0 ? Math.round(((estimated - usage.inputTokens) / usage.inputTokens) * 100) : 0;
    parts.push(
      `輸入實測 ${usage.inputTokens} token（估算 ${estimated}，偏差 ${delta > 0 ? '+' : ''}${delta}%）`
    );
  }
  if (usage.outputTokens !== undefined) {
    parts.push(`輸出 ${usage.outputTokens} token`);
  }
  return parts.length > 0 ? parts.join('；') : undefined;
}
