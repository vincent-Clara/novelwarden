/**
 * 角色卡「當前狀態」一節歸誰（D15）。
 *
 * 定稿時機器要把本章出場的人的當前狀態更新到這一章——批次序列寫十章，不能每章彈一次
 * diff。可作者手改過的內容不能被靜默覆蓋（第 3 條）。兩頭都要，於是這一節的歸屬只看
 * 一件事：**自上次機器寫入之後，有沒有人改過它**。
 *
 * 機器每次寫這一節都在 frontmatter 記下它的指紋（`stateHash`）與寫到第幾章（`stateThrough`）。
 * 下次要寫時：
 *
 * - 這一節是空的（含佔位文字「（待補充）」）→ 機器的（沒有東西可吞）；
 * - 指紋對得上 → 機器的（沒人動過）；
 * - 其餘（改過、或者從沒記過指紋卻有內容）→ 作者的，不寫。
 *
 * 最後那半句與 AI-Novel-Writer 同一口徑（`finalize-chapter.command.ts:481-483`：非空而又不是
 * 機器派生的值一律保護）：手寫的卡、換軸之前的卡，寧可多問一句也不替作者改。
 */
import { hash } from './fs';
import { hasContent, replaceSection, rewriteFrontmatter, stringifyFrontmatter } from './markdown';
import { CharacterCard } from './types';

/** 「當前狀態」這一節的指紋。只看內容：首尾空白不算，佔位文字當空。 */
export function stateHashOf(text: string): string {
  return hash(hasContent(text) ? text.trim() : '');
}

/** 這一節現在歸機器（可以直接更新）還是歸作者（不寫，掛黃 ❗）。 */
export function stateOwnedByMachine(card: Pick<CharacterCard, 'sections' | 'stateHash'>): boolean {
  const text = card.sections.当前状态 ?? '';
  if (!hasContent(text)) {
    return true;
  }
  return !!card.stateHash && card.stateHash === stateHashOf(text);
}

/**
 * 機器寫完「當前狀態」之後蓋章：記指紋與寫到第幾章。建卡、採納「更新角色卡」、定稿
 * 那幾處都走它——少蓋一處，機器自己寫的東西下次就被當成作者的。
 */
export function stampState<T extends Pick<CharacterCard, 'sections'>>(
  card: T,
  through: number
): T & { stateThrough: number; stateHash: string } {
  return { ...card, stateThrough: through, stateHash: stateHashOf(card.sections.当前状态) };
}

/**
 * 在一張卡的原文上換掉「當前狀態」並蓋章，**其餘一個字不動**（作者自加的小節、排版都在）。
 * 手寫的卡可能沒有 frontmatter：那就在最前面補一段只有這兩個欄位的。
 */
export function patchCardState(raw: string, state: string, through: number): string {
  const body = replaceSection(raw, '当前状态', state);
  const fm = { stateThrough: through, stateHash: stateHashOf(state) };
  return rewriteFrontmatter(body, fm) ?? `${stringifyFrontmatter(fm)}\n\n${body.replace(/^﻿/, '')}`;
}

/**
 * 只把「寫到第幾章」往後推（這一章出場、狀態沒變）。指紋跟著這一節現在的內容重算——
 * 呼叫方保證這一節歸機器，重算的結果與原來的一樣。
 */
export function patchCardThrough(raw: string, state: string, through: number): string {
  const fm = { stateThrough: through, stateHash: stateHashOf(state) };
  return rewriteFrontmatter(raw, fm) ?? `${stringifyFrontmatter(fm)}\n\n${raw.replace(/^﻿/, '')}`;
}

/** 「狀態截至第 3 章」「開篇狀態」。角色行說明與裝配明細共用。 */
export function describeStateThrough(through: number | undefined): string {
  if (through === undefined) {
    return '';
  }
  return through <= 0 ? '開篇狀態' : `狀態截至第 ${through} 章`;
}
