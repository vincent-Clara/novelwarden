/**
 * 切預覽 / 切回編輯時兩邊滾到同一處（`pane.ts` 的 `setPreviewing` 用）。換算是純函式（`previewCore.ts`），這裡只量：
 *
 * - **編輯區**：第 i 行的頂借高亮映象層量（`highlight.ts` 的 `measureOffset`，與打字機滾動、名詞補全同一個辦法，
 *   不另起測量 DOM），二分找視口頂上那一行，只量 log₂(行數) 次。中文一段就是一行、能折成好幾行，所以位置帶小數：
 *   滾到一段中間時，預覽裡也滾到那一段的中間。
 * - **預覽**：`renderPreview` 給每一塊記了 `data-line` / `data-line-end`，量這幾塊相對預覽內容頂上的位置。
 *
 * 量不了（文字超過 `HIGHLIGHT_LIMIT`、沒有排版——比如 jsdom）時退回按比例：位置 = 滾過的比例 × 行數。
 */
import { measureOffset } from './highlight';
import type { Pane } from './store';
import { lineAtY, lineStarts, previewYToSource, sourceToPreviewY, yOfLine } from './previewCore';
import type { BlockBox } from './previewCore';

/** 編輯區裡一行一行的頂（從第 0 行的頂算）。量過的記下來，一次切換裡不重量。量不了返回 undefined。 */
function areaTops(pane: Pane): { count: number; topOf: (i: number) => number } | undefined {
  const text = pane.area.value;
  const starts = lineStarts(text);
  const count = starts.length;
  const first = measureOffset(pane, 0);
  if (!first) {
    return undefined;
  }
  const cache = new Map<number, number>([[0, 0]]);
  let broken = false;
  const topOf = (i: number): number => {
    const hit = cache.get(i);
    if (hit !== undefined) {
      return hit;
    }
    let top: number;
    if (i >= count) {
      // 最後一行的底：最後一行的頂 + 它的行高（空的最後一行量的是零寬空格，行高照樣有）。
      const last = measureOffset(pane, starts[count - 1]);
      top = last ? last.top + last.height - first.top : 0;
    } else {
      const m = measureOffset(pane, starts[i]);
      top = m ? m.top - first.top : 0;
    }
    if (!Number.isFinite(top)) {
      broken = true;
      top = 0;
    }
    cache.set(i, top);
    return top;
  };
  // 沒有排版（每一行都量出 0）時只會把人帶到最後一行——當量不了。
  if (count > 1 && topOf(count) <= 0) {
    return undefined;
  }
  return broken ? undefined : { count, topOf };
}

/** 按比例：滾過的比例 × 行數。 */
function proportional(scrollTop: number, scrollHeight: number, clientHeight: number, count: number): number {
  const range = scrollHeight - clientHeight;
  return range > 0 ? (Math.max(0, scrollTop) / range) * count : 0;
}

/** 編輯區視口頂上是第幾行（帶小數）。 */
export function areaTopLine(pane: Pane): number {
  const area = pane.area;
  const tops = areaTops(pane);
  if (!tops) {
    return proportional(area.scrollTop, area.scrollHeight, area.clientHeight, lineStarts(area.value).length);
  }
  return lineAtY(tops.count, tops.topOf, area.scrollTop);
}

/**
 * 要讓第 `pos` 行（帶小數）停在編輯區視口頂上，`scrollTop` 該是多少，那時視口裡是從第幾行到第幾行（帶小數；量不了時
 * 按比例估）。只量不滾：呼叫方先落游標（看它還在不在視口裡），再滾——落選區時瀏覽器可能自己把游標滾進視野。
 */
export function areaScrollForLine(pane: Pane, pos: number): { scrollTop: number; top: number; bottom: number } {
  const area = pane.area;
  const tops = areaTops(pane);
  if (!tops) {
    const count = lineStarts(area.value).length;
    const range = area.scrollHeight - area.clientHeight;
    const scrollTop = range > 0 ? Math.round((pos / Math.max(1, count)) * range) : 0;
    const top = proportional(scrollTop, area.scrollHeight, area.clientHeight, count);
    const visible = area.scrollHeight > 0 ? (area.clientHeight / area.scrollHeight) * count : count;
    return { scrollTop, top, bottom: top + visible };
  }
  const scrollTop = Math.max(0, Math.round(yOfLine(tops.count, tops.topOf, pos)));
  return {
    scrollTop,
    top: lineAtY(tops.count, tops.topOf, scrollTop),
    bottom: lineAtY(tops.count, tops.topOf, scrollTop + area.clientHeight),
  };
}

/** 預覽裡每一塊的位置（相對預覽內容的最頂上）。全是 0（沒有排版）時返回空。 */
function previewBoxes(preview: HTMLElement): BlockBox[] {
  const base = preview.getBoundingClientRect().top - preview.scrollTop;
  const boxes: BlockBox[] = [];
  let any = false;
  for (const node of preview.querySelectorAll<HTMLElement>('[data-line]')) {
    const start = Number(node.dataset.line);
    const end = Number(node.dataset.lineEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      continue;
    }
    const rect = node.getBoundingClientRect();
    any ||= rect.height > 0;
    boxes.push({ start, end, top: rect.top - base, height: rect.height });
  }
  return any ? boxes : [];
}

/** 預覽視口頂上對著原始檔第幾行（帶小數）。 */
export function previewTopLine(preview: HTMLElement, lineCount: number): number {
  const boxes = previewBoxes(preview);
  if (boxes.length === 0) {
    return proportional(preview.scrollTop, preview.scrollHeight, preview.clientHeight, lineCount);
  }
  return previewYToSource(boxes, preview.scrollTop);
}

/** 把預覽滾到讓原始檔第 `pos` 行（帶小數）對應的那一處停在視口頂上。 */
export function scrollPreviewToLine(preview: HTMLElement, pos: number, lineCount: number): void {
  const boxes = previewBoxes(preview);
  if (boxes.length === 0) {
    const range = preview.scrollHeight - preview.clientHeight;
    preview.scrollTop = range > 0 ? Math.round((pos / Math.max(1, lineCount)) * range) : 0;
    return;
  }
  preview.scrollTop = Math.max(0, Math.round(sourceToPreviewY(boxes, pos)));
}
