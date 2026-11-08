/**
 * 段級 diff（五期 W11）：覆蓋審閱與修稿的合併檢視按段對齊兩個版本，逐處「採用新版 / 保留原文」。
 *
 * **純函式，零 import**：前端的合併檢視直接打包它，單測直接跑它（總計劃 §8：「diff 檢視自己寫
 * 有 bug」的緩解就是這裡每一步都能單測）。
 *
 * ## 為什麼是 LCS
 *
 * AI-Novel-Writer 的 `ThreeWayMerge.tsx` 用按字頻相似度的全域對齊（能認出「一段拆成兩段」）。
 * 這裡用段序列上的最長公共子序列：修稿與重寫的改動多是整段的增、刪、改，LCS 已經夠用，
 * 而且結果是確定的、好解釋的——「這幾段兩邊一字不差，中間這幾段是改動」。
 *
 * 段的比較鍵是去掉全部空白之後的文字：只差一個換行、一個空格的兩段當成同一段，
 * 不值得讓作者為它點一次「採用」。
 */

/** 合併檢視裡的一截：兩邊一樣的一段（或連著的幾段），或者一處改動。 */
export type MergeSegment =
  | { kind: 'same'; paragraphs: string[] }
  | { kind: 'change'; old: string[]; new: string[] };

/**
 * 兩邊段數的乘積超過這個數的平方時不做 LCS，整份當一處改動（表是 n × m 的）。
 * 章節遠到不了這個數，這是防禦。
 */
export const DIFF_MAX_PARAGRAPHS = 1500;

/**
 * 按空行切段。段內的單個換行保留（詩、信件、對白裡的分行是作者的排版）；首尾空白去掉；
 * 空段丟掉。frontmatter（`---` 夾著的那一塊）中間沒有空行，自然是一段。
 */
export function splitParagraphs(text: string): string[] {
  return (text ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n(?:[ \t　]*\n)+/)
    // 只去掉開頭的整行空白：首行的縮排（「　　」）是作者的排版，留著。
    .map((p) => p.replace(/^(?:[ \t　]*\n)+/, '').replace(/\s+$/, ''))
    .filter((p) => p.trim().length > 0);
}

function keyOf(p: string): string {
  return p.replace(/\s+/g, '');
}

/**
 * 兩個版本的段級差異。相同的段連成一截 `same`，相鄰的增刪改併成一處 `change`
 * （一段改寫 = 刪一段 + 加一段，挨在一起就是一處）。
 */
export function diffParagraphs(before: string, after: string): MergeSegment[] {
  const a = splitParagraphs(before);
  const b = splitParagraphs(after);
  if (a.length * b.length > DIFF_MAX_PARAGRAPHS * DIFF_MAX_PARAGRAPHS) {
    return [{ kind: 'change', old: a, new: b }];
  }
  const ka = a.map(keyOf);
  const kb = b.map(keyOf);
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = a[i..] 與 b[j..] 的 LCS 長度；一維陣列按行存。
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = ka[i] === kb[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }

  const out: MergeSegment[] = [];
  const same = (p: string) => {
    const last = out[out.length - 1];
    if (last?.kind === 'same') {
      last.paragraphs.push(p);
    } else {
      out.push({ kind: 'same', paragraphs: [p] });
    }
  };
  const change = (side: 'old' | 'new', p: string) => {
    const last = out[out.length - 1];
    if (last?.kind === 'change') {
      last[side].push(p);
    } else {
      out.push(side === 'old' ? { kind: 'change', old: [p], new: [] } : { kind: 'change', old: [], new: [p] });
    }
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ka[i] === kb[j]) {
      // 相同的段取新版那一份：兩邊只差空白時，新版的排版是要寫下去的那一份。
      same(b[j]);
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
      change('old', a[i++]);
    } else {
      change('new', b[j++]);
    }
  }
  while (i < n) {
    change('old', a[i++]);
  }
  while (j < m) {
    change('new', b[j++]);
  }
  return out;
}

/** 一共幾處改動。合併檢視頂上「已處理 k / n 處」的 n。 */
export function changeCount(segments: readonly MergeSegment[]): number {
  return segments.filter((s) => s.kind === 'change').length;
}

/** 一處改動「採用新版」「保留原文」時結果格里的那一份文字。 */
export function sideText(segment: Extract<MergeSegment, { kind: 'change' }>, side: 'old' | 'new'): string {
  return segment[side].join('\n\n');
}

/**
 * 拼出合併結果。`results[k]` 是第 k 截（下標與 `segments` 對齊）結果格里的文字：沒給就用新版。
 * 結果格可以是空的（這一處整段刪掉）。段與段之間一個空行，檔案末尾一個換行。
 */
export function joinMerge(segments: readonly MergeSegment[], results: Readonly<Record<number, string>> = {}): string {
  const pieces: string[] = [];
  segments.forEach((s, k) => {
    const text = s.kind === 'same' ? s.paragraphs.join('\n\n') : results[k] ?? sideText(s, 'new');
    if (text.trim()) {
      pieces.push(text.replace(/^\n+|\s+$/g, ''));
    }
  });
  return pieces.length > 0 ? `${pieces.join('\n\n')}\n` : '';
}
