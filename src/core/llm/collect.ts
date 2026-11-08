/**
 * 事件流的收集器。
 *
 * provider 吐的是 `StreamEvent`，而 13 個既有呼叫點要的只是一段文字。
 * 這裡把「傳一個流，拿一段文字」那個形狀保住，同時讓想聽 reasoning /
 * usage 的呼叫方各取所需——provider 總是全量發事件，聽不聽由呼叫方決定，
 * 而不是讓「呼叫方想不想聽」反過來決定 provider 發不發。
 */
import { StopSignal, StreamEvent, TokenUsage } from './provider';

export interface CollectHandlers {
  onDelta?(delta: string, full: string): void;
  onReasoning?(delta: string, full: string): void;
  onUsage?(usage: TokenUsage): void;
}

export interface CollectResult {
  text: string;
  reasoning: string;
  usage: TokenUsage;
  /** 上游報的收尾原因。`undefined` = 它沒說（有些相容實現壓根不發這一條）。 */
  stopReason?: StopSignal;
}

/**
 * 把一次請求回報的多份用量合成一份。
 *
 * 同一次請求會回呼多次（Anthropic 在 `message_start` 給輸入、
 * `message_delta` 給輸出），所以**按欄位合併、後到的覆蓋同名欄位、
 * 缺席的欄位保留**——整份覆蓋會讓先到的輸入用量被後一條抹掉。
 */
export function mergeUsage(target: TokenUsage, patch: TokenUsage): void {
  if (patch.inputTokens !== undefined) {
    target.inputTokens = patch.inputTokens;
  }
  if (patch.outputTokens !== undefined) {
    target.outputTokens = patch.outputTokens;
  }
}

/**
 * 幾次請求的用量加總（續寫、修復重試、刪修飾各是一次請求）。和 `mergeUsage` 是兩回事：同一次請求裡
 * 後到的覆蓋先到的，不同請求之間才相加。每個欄位只加回報了它的那幾次，一次都沒回報就仍是 undefined——
 * 不拿 0 冒充實測。
 */
export function sumUsage(list: readonly TokenUsage[]): TokenUsage {
  const total: TokenUsage = {};
  for (const u of list) {
    if (u.inputTokens !== undefined) {
      total.inputTokens = (total.inputTokens ?? 0) + u.inputTokens;
    }
    if (u.outputTokens !== undefined) {
      total.outputTokens = (total.outputTokens ?? 0) + u.outputTokens;
    }
  }
  return total;
}

/** 收全流，按欄位合併 usage。 */
export async function collect(
  stream: AsyncIterable<StreamEvent>,
  handlers?: CollectHandlers
): Promise<CollectResult> {
  let text = '';
  let reasoning = '';
  const usage: TokenUsage = {};
  let stopReason: StopSignal | undefined;

  for await (const ev of stream) {
    switch (ev.type) {
      case 'text':
        text += ev.text;
        handlers?.onDelta?.(ev.text, text);
        break;
      case 'reasoning':
        reasoning += ev.text;
        handlers?.onReasoning?.(ev.text, reasoning);
        break;
      case 'usage':
        mergeUsage(usage, ev.usage);
        handlers?.onUsage?.(ev.usage);
        break;
      case 'stop':
        stopReason = ev.reason;
        break;
    }
  }

  return { text, reasoning, usage, stopReason };
}

/** 只要文字那一份。既有的 13 個呼叫點用這個。 */
export async function collectText(
  stream: AsyncIterable<StreamEvent>,
  handlers?: CollectHandlers
): Promise<string> {
  return (await collect(stream, handlers)).text;
}
