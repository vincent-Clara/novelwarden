/**
 * Token 預算工具：計數 + 按預算擷取文字。
 *
 * 計數本身已經拆到 [tokenCounter.ts](tokenCounter.ts)（可替換實現 + 登錄檔）。
 * 本檔案只留兩樣東西：
 * - `estimateTokens` —— `countTokens` 的別名，全倉庫幾十處呼叫沿用這個名字；
 * - `takeHead` / `takeTail` —— 按預算截斷，永遠走**當前**計數器。
 *
 * 截斷函式刻意不接受計數器引數：預算判斷與截斷必須用同一套口徑，
 * 否則「估算說放得下、截斷按另一套係數切」會切出超預算的文字。
 */

import { charsForTokens, countTokens } from './tokenCounter';

export {
  activeTokenCounter,
  charsForTokens,
  countTokens,
  describeUsage,
  HeuristicTokenCounter,
  listTokenCounters,
  recordUsage,
  registerTokenCounter,
  resetTokenCounter,
  resetUsageStats,
  useTokenCounter,
  usageStats,
} from './tokenCounter';
export type { TokenCounter, TokenUsage, UsageStats } from './tokenCounter';

/**
 * 數一段文字的 token 數。
 *
 * 名字裡的「estimate」是歷史包袱：換上精確計數器後它返回的就是精確值。
 * 保留這個名字是因為呼叫點太多，且語義（「這段文字值多少預算」）沒變。
 */
export function estimateTokens(text: string): number {
  return countTokens(text);
}

/** 目標 token 數對應的大致字元數（按當前計數器反推），用於截斷文字。 */
export function tokensToChars(tokens: number): number {
  return charsForTokens(tokens);
}

/** 從尾部擷取不超過 maxTokens 的文字，並儘量從段落邊界開始。 */
export function takeTail(text: string, maxTokens: number): string {
  if (countTokens(text) <= maxTokens) {
    return text;
  }
  const chars = charsForTokens(maxTokens);
  let slice = text.slice(-chars);
  // 對齊到段落開頭，避免從半句話開始。
  const paragraphBreak = slice.indexOf('\n\n');
  if (paragraphBreak !== -1 && paragraphBreak < slice.length * 0.3) {
    slice = slice.slice(paragraphBreak + 2);
  }
  return slice.trimStart();
}

/** 從頭部擷取不超過 maxTokens 的文字，尾部加省略標記。 */
export function takeHead(text: string, maxTokens: number): string {
  if (countTokens(text) <= maxTokens) {
    return text;
  }
  const chars = charsForTokens(maxTokens);
  return `${text.slice(0, chars).trimEnd()}\n……（此處因上下文預算截斷）`;
}
