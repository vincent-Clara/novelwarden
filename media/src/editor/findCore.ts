/**
 * 查詢替換條的純函式：在匹配表裡定位（下一處、上一處、離游標最近的、正好是選區的那一處）、選區預填進查詢框。
 *
 * **零 DOM 依賴**（單測直接跑：`tests/unit/editor/findCore.test.js`）；查詢條的介面與按鍵在 `find.ts`。
 *
 * **匹配口徑不在這裡**：找全部匹配、`$1` 展開、全部替換在 core 的 `model/textFind.ts`（純函式、零 import，經
 * `../protocol` 打進瀏覽器產物），這裡原樣轉出——全書查詢替換在後端讀盤，用的是同一份，同一個查詢串、同兩顆
 * 開關在一份檔案裡與在全書裡找到的是同一批（大小寫、正則的 `m` / `u`、零長度跳過、`$1` 的語義見那個檔案頭）。
 */
import type { FindMatch } from '../protocol';

export {
  MATCH_LIMIT,
  compileSearch,
  escapeRegExp,
  expandReplacement,
  findMatches,
  replaceAllIn,
  replaceSelectedIn,
  replacementFor,
} from '../protocol';
export type { CompiledSearch, FindMatch, FindOptions, FindResult, ReplaceAllEdit, SelectedReplace } from '../protocol';

/** 選區預填進查詢框的上限：比這長、或跨了行，就不預填。 */
export const SEED_MAX = 80;

// ---------------------------------------------------------------- 在匹配表裡定位

/** 第一處 `start >= pos` 的下標（二分）；都在 pos 之前時返回 `matches.length`。 */
function lowerBound(matches: FindMatch[], pos: number): number {
  let lo = 0;
  let hi = matches.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (matches[mid].start < pos) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** 從 pos 往後最近的一處（`start >= pos`），後面沒有就繞回第一處。沒有匹配返回 -1。 */
export function matchAfter(matches: FindMatch[], pos: number): number {
  if (matches.length === 0) {
    return -1;
  }
  const i = lowerBound(matches, pos);
  return i < matches.length ? i : 0;
}

/** pos 之前最近的一處（`start < pos`），前面沒有就繞回最後一處。沒有匹配返回 -1。 */
export function matchBefore(matches: FindMatch[], pos: number): number {
  if (matches.length === 0) {
    return -1;
  }
  const i = lowerBound(matches, pos) - 1;
  return i >= 0 ? i : matches.length - 1;
}

/** 離 pos 最近、不在它前面的那一處；都在前面就取最後一處（文字變了之後讓「當前第幾處」留在原處附近）。 */
export function nearestMatch(matches: FindMatch[], pos: number): number {
  if (matches.length === 0) {
    return -1;
  }
  return Math.min(lowerBound(matches, pos), matches.length - 1);
}

/** 正好是 `[start, end)` 的那一處的下標，沒有返回 -1（「替換」只在選區正好是一處匹配時才換）。 */
export function matchAt(matches: FindMatch[], start: number, end: number): number {
  const i = lowerBound(matches, start);
  return i < matches.length && matches[i].start === start && matches[i].end === end ? i : -1;
}

/** 選區能不能預填進查詢框：非空、不跨行、不超過 `SEED_MAX` 個字。能就返回那幾個字。 */
export function seedFromSelection(text: string, start: number, end: number): string | undefined {
  if (end <= start || end - start > SEED_MAX) {
    return undefined;
  }
  const picked = text.slice(start, end);
  return picked.includes('\n') ? undefined : picked;
}
