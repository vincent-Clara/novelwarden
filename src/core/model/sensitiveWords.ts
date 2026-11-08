/**
 * 自定義敏感詞表（`.novelwarden/sensitive.txt`）：釋出平臺不讓出現的詞，作者自己維護。**純函式、絕不拋**
 * （第 1 條：作者會手改它，認不出的行跳過）；只 import 同樣零 import 的 `manuscriptCheck.ts`，前端也能打包。
 *
 * 現在**只給內建編輯器的「寫作體檢」用**（後端讀出來解析好，隨 `checkTerms` 推給編輯器，正文裡出現了就標出來，
 * 有替換詞的在體檢面板裡可以一鍵替換）——不進生成鏈、不進裝配器，模型看不到這份詞表。
 *
 * ## 格式（⚑）
 *
 * ```
 * # 井號開頭的行是註釋，空行不算
 * 某個詞
 * 某個詞 => 換成的詞
 * ```
 *
 * - 一行一個詞，前後的空白不算；詞中間可以有空格（英文片語）。
 * - `=>` 後面是建議的替換詞（左右空白不算）。只認半形的 `=>`，一行只能有一個。
 * - 英文不分大小寫，全形字母當半形（匹配在 `manuscriptCheck.ts` 的 `locateTerms`，`foldCase`）。
 * - 認不出的行跳過，不報錯：`=>` 前面沒有詞、後面沒有替換詞、一行兩個 `=>`、詞太長（超過 {@link SENSITIVE_TERM_MAX} 個字）、
 *   替換詞與原詞一字不差、與前面某一行是同一個詞（不分大小寫）。體檢面板裡提一句「第 N 行沒看懂」。
 *
 * 檔案不在 = 沒有敏感詞。第一次在編輯器裡點「編輯敏感詞表…」時經閘道器新建一份 {@link SENSITIVE_TEMPLATE}。
 */
import { foldLatin } from './manuscriptCheck';

/** 檔名（在 `.novelwarden/` 下）。 */
export const SENSITIVE_FILE_NAME = 'sensitive.txt';

/** 一個詞最多幾個字（碼位）：再長就是一句話了。 */
export const SENSITIVE_TERM_MAX = 32;

/** 詞表裡的一個詞。`line` 是它在檔案裡的第幾行（1 起）。 */
export interface SensitiveTerm {
  term: string;
  /** 建議的替換詞。沒寫就是隻標出來。 */
  replacement?: string;
  line: number;
}

/** 沒看懂、跳過的一行。 */
export interface SensitiveBadLine {
  line: number;
  /** 為什麼沒看懂（給人看的一句）。 */
  reason: string;
}

export interface SensitiveList {
  terms: SensitiveTerm[];
  bad: SensitiveBadLine[];
}

/** 解析詞表。不是字串（讀不到）當空的。 */
export function parseSensitiveWords(text: string | undefined): SensitiveList {
  const terms: SensitiveTerm[] = [];
  const bad: SensitiveBadLine[] = [];
  const seen = new Map<string, number>();
  const lines = typeof text === 'string' ? text.replace(/^﻿/, '').split(/\r?\n/) : [];
  lines.forEach((raw, i) => {
    const line = i + 1;
    const s = raw.trim();
    if (!s || s.startsWith('#')) {
      return;
    }
    const parts = s.split('=>');
    if (parts.length > 2) {
      bad.push({ line, reason: '一行只能有一個「=>」' });
      return;
    }
    const term = parts[0].trim();
    const replacement = parts.length === 2 ? parts[1].trim() : undefined;
    if (!term) {
      bad.push({ line, reason: '「=>」前面沒有詞' });
      return;
    }
    if (replacement === '') {
      bad.push({ line, reason: '「=>」後面沒有替換詞（不想替換就把「=>」刪掉）' });
      return;
    }
    if (Array.from(term).length > SENSITIVE_TERM_MAX) {
      bad.push({ line, reason: `太長了（一個詞最多 ${SENSITIVE_TERM_MAX} 個字）` });
      return;
    }
    if (replacement !== undefined && replacement === term) {
      bad.push({ line, reason: '替換詞與原詞一樣' });
      return;
    }
    const key = foldLatin(term);
    const first = seen.get(key);
    if (first !== undefined) {
      bad.push({ line, reason: `與第 ${first} 行是同一個詞（英文不分大小寫），只認第 ${first} 行` });
      return;
    }
    seen.set(key, line);
    terms.push(replacement !== undefined ? { term, replacement, line } : { term, line });
  });
  return { terms, bad };
}

/** 第一次「編輯敏感詞表…」時新建的那一份：全是註釋，一個詞都不生效。 */
export const SENSITIVE_TEMPLATE = [
  '# 敏感詞表：釋出平臺不讓出現的詞，自己維護，一行一個。',
  '#',
  '# 只用於內建編輯器的「體檢」：正文（章節與草稿）裡出現了就標出來、在狀態列「體檢」那一格里數出來，',
  '# 不會替你改字，也不會發給模型（寫正文時模型看不到這份詞表）。',
  '#',
  '# 寫法：',
  '#   某個詞                只標出來',
  '#   某個詞 => 換成的詞     標出來，體檢面板裡可以「替換本處」或「本檔案全部替換」',
  '#   # 開頭的行是註釋，空行不算',
  '# 英文不分大小寫（全形字母當半形）。認不出的行會跳過，體檢面板裡會說是第幾行。',
  '#',
  '# 例子（去掉行首的「# 」就生效）：',
  '# 某某平臺',
  '# 賭博 => 博戲',
  '',
].join('\n');
