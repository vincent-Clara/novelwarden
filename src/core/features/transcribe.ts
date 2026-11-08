/**
 * 轉寫的整條走法（2026-10-25 起）：幹活的模型按格式寫了一段自然語言（`source`），這裡交給「轉寫」那一檔照抄成 JSON，
 * 查過再交回解出來的值。每一步只給一份 {@link TranscribeSpec}（合同、解碼、哪些鍵按對應關係填），呼叫由呼叫方給
 * （對話頁那條路是 `ChainIO.transcribe`，工程頁任務是 features/poolIO.ts 的 `poolTranscriber`）。
 *
 * 1. 原文字身就是 JSON（模型沒照格式寫、老會話、測試裡的假模型）：**不轉**，按這一步的解碼直接判——與改之前逐字一樣。
 * 2. 原文連這一步的樣子都沒有（`looksLike`，比如「我不太確定」）：不轉，按不合格交回去，不花轉寫那一次。
 * 3. 轉寫：照抄成 JSON → 原文寫「無」的換成空的（`withoutNone`）→ **每段文字都得出自原文**（`unfaithfulStrings`，
 *    按對應關係填的鍵不比）→ 這一步的解碼。哪一關沒過就重轉，說清上次哪裡不對；預設重轉一次（`retries`）。
 * 4. 轉寫呼叫本身失敗（池裡同檔換完了人、閘道器報錯）不往外拋：交回 `failed`，寫好的原文不能跟著丟（對話頁留在氣泡裡，
 *    批次的照這一步原來解析失敗的走法）。作者點了停止照舊往外拋。
 *
 * 調了幾次、哪一次不合格都在結果裡（`calls`、`notes`），呼叫方記進自己的賬（第 2、4 條）。
 */
import type { ChatMessage, StopSignal } from '../llm/provider';
import { CancelledError } from '../llm/provider';
import { describeError } from '../runtime/logger';
import { transcribeMessages } from '../model/transcribe';
import { isRepairableJsonSyntax, jsonValueOf, unfaithfulStrings, withoutNone } from './structuredJson';

/** 轉寫一次的結果（與生成鏈的 `CallOutcome` 同形）。 */
export interface TranscribeOutcome {
  text: string;
  stop?: StopSignal;
}

/** 調一次轉寫模型。`label` 寫進氣泡與日誌。 */
export type TranscribeCall = (messages: ChatMessage[], label: string) => Promise<TranscribeOutcome>;

export interface TranscribeSpec<T> {
  /** 這一步叫什麼：氣泡與日誌裡那一行是「{label}轉寫成 JSON」，說明裡是「{label}轉寫不合格……」。 */
  label: string;
  /** 轉寫合同：JSON 形狀、每個欄位從原文哪裡取、詞怎麼對到程式碼。 */
  contract: string;
  /** 這一步原來的解碼與校驗（吃 JSON 文字）。不合格交回一句人話——重轉那一次原樣告訴轉寫模型。 */
  decode(json: string): { ok: true; value: T } | { ok: false; message: string };
  /** 按對應關係填、不比原文的鍵（type、role、章號……）。 */
  mapped?: readonly string[];
  /** 原文有沒有這一步的樣子。缺席 = 都轉。壞了語法的 JSON 一律轉（轉寫順帶把它理順）。 */
  looksLike?(source: string): boolean;
  /** 最多重轉幾次。預設 1。 */
  retries?: number;
}

export type TranscribeResult<T> =
  | {
      ok: true;
      value: T;
      /** 規範化的 JSON 文字（直接給的是原文字身）：要落進氣泡、日誌的就是它。 */
      json: string;
      /** 原文字身就是 JSON，沒有轉。 */
      direct: boolean;
      calls: number;
      notes: string[];
    }
  | {
      ok: false;
      message: string;
      /** 轉寫呼叫本身失敗了（不是轉得不合格）。 */
      failed: boolean;
      calls: number;
      notes: string[];
    };

export async function transcribeJson<T>(source: string, spec: TranscribeSpec<T>, call: TranscribeCall): Promise<TranscribeResult<T>> {
  const text = source.trim();
  const notes: string[] = [];
  if (jsonValueOf(text) !== undefined) {
    const d = spec.decode(text);
    return d.ok
      ? { ok: true, value: d.value, json: text, direct: true, calls: 0, notes }
      : { ok: false, message: d.message, failed: false, calls: 0, notes };
  }
  if (spec.looksLike && !isRepairableJsonSyntax(text) && !spec.looksLike(text)) {
    return { ok: false, message: '沒有按格式寫', failed: false, calls: 0, notes };
  }
  const mapped = new Set(spec.mapped ?? []);
  const retries = spec.retries ?? 1;
  let calls = 0;
  let feedback: string | undefined;
  for (let round = 0; round <= retries; round++) {
    let out: TranscribeOutcome;
    calls++;
    try {
      out = await call(transcribeMessages(spec.contract, text, feedback) as ChatMessage[], `${spec.label}轉寫成 JSON`);
    } catch (err) {
      if (err instanceof CancelledError) {
        throw err;
      }
      return { ok: false, message: `轉寫呼叫失敗（${describeError(err)}）`, failed: true, calls, notes };
    }
    const judged = judge(out, text, spec, mapped);
    if (judged.ok) {
      return { ok: true, value: judged.value, json: judged.json, direct: false, calls, notes };
    }
    feedback = judged.message;
    notes.push(round < retries ? `${spec.label}轉寫不合格（${feedback}），重轉一次` : `${spec.label}重轉仍不合格（${feedback}）`);
  }
  return { ok: false, message: feedback ?? '轉寫不合格', failed: false, calls, notes };
}

function judge<T>(
  out: TranscribeOutcome,
  source: string,
  spec: TranscribeSpec<T>,
  mapped: ReadonlySet<string>
): { ok: true; value: T; json: string } | { ok: false; message: string } {
  if (out.stop === 'maxTokens') {
    return { ok: false, message: '轉寫被輸出上限截斷' };
  }
  const raw = jsonValueOf(out.text);
  if (raw === undefined) {
    return { ok: false, message: '轉寫出來的不是一個完整的 JSON 物件' };
  }
  const value = withoutNone(raw);
  const off = unfaithfulStrings(source, value, mapped);
  if (off.length > 0) {
    return { ok: false, message: `這幾處不是原文裡的字：${off.map((s) => `「${s}」`).join('、')}` };
  }
  const json = JSON.stringify(value);
  const d = spec.decode(json);
  return d.ok ? { ok: true, value: d.value, json } : { ok: false, message: d.message };
}
