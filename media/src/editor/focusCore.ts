/**
 * 專注那幾樣的純函式（零 DOM）：段落聚焦認「游標在哪一段」、打字機滾動算「該滾到哪」。
 * 按鍵、圖層、滾動本身在 `paragraphFocus.ts` / `typewriter.ts`；口徑在這裡，`tests/unit/editor/focusCore.test.js` 釘著。
 */
import type { ParagraphStyle } from '../protocol';
import { isHeadingLine, isSceneBreakLine } from '../protocol';

export interface TextRange {
  start: number;
  end: number;
}

/** 行首的縮排：半形空格、製表符、全形空格、不換行空格。 */
const LEADING_INDENT = /^[ \t　 ]/;

const isBlank = (line: string): boolean => line.trim() === '';
/** 標題行與場景分隔行自成一段（與一鍵排版同一個認法）。 */
const isSolo = (line: string): boolean => isHeadingLine(line) || isSceneBreakLine(line);

/**
 * 游標所在的那一段：從這一段第一行的行首到最後一行的行尾（不含換行），位置按 `text` 的下標。
 *
 * 分段按工程的分段格式（`paragraphStyle`）認，與回車插什麼同一套：
 *
 * - **空行分段**（`blank`）：空行隔開的一整塊是一段；塊裡不空行的換行（Shift+Enter 打的）還在這一段裡。
 * - **段首縮排**（`indent`）：行首有縮排的那一行另起一段；行首沒縮排、緊跟在一行字後面的是上一段的續行
 *   （Shift+Enter 打的）。空行也隔開段落。
 * - **縮排加空行**（`both`）：兩樣都算——空行隔開，塊裡行首有縮排的那一行也另起一段。
 *
 * 三種格式下標題行（`#`）與場景分隔行（`* * *`、`※`……）都自成一段。游標落在空行上時，那一段就是這一行本身
 * （新起的一段還沒有字，其餘的都淡下去）。
 */
export function paragraphRangeAt(text: string, caret: number, style: ParagraphStyle): TextRange {
  const lines = text.split('\n');
  const starts: number[] = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }
  const pos = Math.max(0, Math.min(text.length, Math.floor(caret)));
  let idx = 0;
  while (idx + 1 < lines.length && starts[idx + 1] <= pos) {
    idx++;
  }
  const lineRange = (first: number, last: number): TextRange => ({
    start: starts[first],
    end: starts[last] + lines[last].length,
  });
  if (isBlank(lines[idx])) {
    return lineRange(idx, idx);
  }
  const indentStarts = style !== 'blank';
  /** 第 i 行（不空）是不是一段的第一行。 */
  const opens = (i: number): boolean =>
    i === 0 ||
    isBlank(lines[i - 1]) ||
    isSolo(lines[i - 1]) ||
    isSolo(lines[i]) ||
    (indentStarts && LEADING_INDENT.test(lines[i]));

  let first = idx;
  while (!opens(first)) {
    first--;
  }
  let last = idx;
  while (last + 1 < lines.length && !isBlank(lines[last + 1]) && !opens(last + 1)) {
    last++;
  }
  return lineRange(first, last);
}

/**
 * 打字機滾動：讓游標那一行的中線落在視口中間，返回該把 `scrollTop` 設成多少；已經在中間（差不到 1px）時
 * 返回 undefined，不動。`caretTop` 從內容頂上（含上內邊距）量，`caretHeight` 是那一行的行高。
 * 滾不到負數；滾不到底由瀏覽器自己夾（打字機滾動開著時編輯區底下多墊了半屏，最後一行也能滾到中間）。
 */
export function typewriterScrollTop(
  caretTop: number,
  caretHeight: number,
  viewport: number,
  scrollTop: number
): number | undefined {
  const target = Math.max(0, Math.round(caretTop + caretHeight / 2 - viewport / 2));
  return Math.abs(target - scrollTop) >= 1 ? target : undefined;
}
