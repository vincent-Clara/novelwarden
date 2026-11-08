/**
 * 刪修飾：寫完正文之後的一輪「只許刪」修稿（續寫鏈最後一步，對話頁與批次寫章同一條）。
 *
 * - 用寫這一章的同一個模型，不經裝配器，只給刪減規矩與編好號的正文（`context/prompts.ts` 的
 *   `trimMessages`）。
 * - 逐段驗收（`model/trimProse.ts`）：加了字、動了對白、刪得太狠、改了段尾的段退回原文，其餘照用。
 * - 刪完不到八成就從刪得最多的段開始退回，主按鈕不會因為這一輪轉去推「接著寫」。
 * - **失敗不連累正文**：呼叫失敗、被截斷、一段都沒交回來，都保留刪之前那一版，記一條說明。
 * - 不流進氣泡：模型交回來的是帶編號的一段段文字，作者看著它只會以為正文寫壞了。氣泡裡先加
 *   一行「——刪修飾——」說明在幹什麼，完了退回成刪後的正文。
 */
import { CancelledError } from '../llm/provider';
import { countWords } from '../model/fs';
import { TRIM_MIN_CHARS, applyTrim, numberParagraphs, parseNumbered, trimParagraphs } from '../model/trimProse';
import { trimMessages } from '../context/prompts';
import { describeError } from '../runtime/logger';
import { ChainIO, Tally } from './structured';

/** 刪修飾用的溫度：刪減不需要發揮。 */
const TRIM_TEMPERATURE = 0.3;

export interface TrimResult {
  /** 刪完的正文；沒刪成時就是傳進來的那份。 */
  text: string;
  /** 真刪了字時才有：刪之前那一版（落盤前的合併檢視拿它與刪後那版逐段對照）。 */
  untrimmed?: string;
}

/**
 * 刪 `text` 裡的修飾。`floor` 是刪完之後 `text` 至少要剩多少字（呼叫方按目標字數的八成減去本章
 * 已有的算好）；缺席就不保底。
 */
export async function trimModifiers(
  io: ChainIO,
  t: Tally,
  text: string,
  opts: { floor?: number; signal?: AbortSignal } = {}
): Promise<TrimResult> {
  const source = text.trim();
  if (countWords(source) < TRIM_MIN_CHARS) {
    return { text };
  }
  const paragraphs = trimParagraphs(source);
  let output: string;
  try {
    const out = await t.call(io, trimMessages(numberParagraphs(paragraphs)), '刪修飾', {
      quiet: true,
      temperature: TRIM_TEMPERATURE,
    });
    if (out.stop === 'maxTokens') {
      io.reset?.(text);
      t.note('刪修飾被輸出上限截斷，沒有采用，正文保持刪之前的樣子');
      return { text };
    }
    output = out.text;
  } catch (err) {
    if (err instanceof CancelledError || opts.signal?.aborted) {
      throw err;
    }
    io.reset?.(text);
    t.note(`刪修飾呼叫失敗（${describeError(err)}），正文保持刪之前的樣子`);
    return { text };
  }

  const trimmed = applyTrim(paragraphs, parseNumbered(output, paragraphs.length), {
    floor: opts.floor,
    countWords,
  });
  const before = countWords(source);
  const after = countWords(trimmed.text);
  const rejected = [...trimmed.rejected].map(([why, n]) => `${why} ${n} 段`).join('、');
  if (trimmed.changed === 0) {
    io.reset?.(text);
    t.note(
      trimmed.restored > 0
        ? '刪修飾刪完不到目標的八成，刪改全部退回，正文保持原樣'
        : `刪修飾沒有刪掉什麼${rejected ? `（退回原文：${rejected}）` : ''}，正文保持原樣`
    );
    return { text };
  }
  io.reset?.(trimmed.text);
  t.note(
    `刪修飾：${paragraphs.length} 段裡刪了 ${trimmed.changed} 段，${before} → ${after} 字（刪掉 ${Math.round((100 * (before - after)) / before)}%）` +
      `${rejected ? `；退回原文：${rejected}` : ''}` +
      `${trimmed.restored > 0 ? `；刪完不到目標的八成，又退回刪得最多的 ${trimmed.restored} 段` : ''}`
  );
  return { text: trimmed.text, untrimmed: source };
}
