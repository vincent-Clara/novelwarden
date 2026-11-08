/**
 * Markdown 預覽的純函式（零 DOM）：把正文切成塊、記下每一塊是原始檔的第幾行到第幾行（`previewBlocks`），以及
 * 「編輯區裡第幾行」與「預覽裡多高」之間的換算（切預覽 / 切回編輯時兩邊滾到同一處，`preview.ts` 與
 * `previewSync.ts` 用）。`tests/unit/editor/previewCore.test.js` 釘著。
 *
 * 行號從 0 數、按 `\n` 切（textarea 裡的 `area.value` 也是這樣，`\r\n` 先歸一），`end` 不含。位置可以帶小數：
 * `12.5` 是第 12 行（從 0 數）往下半行——中文一段就是一行、一行能折成好幾屏，只認整行會差出一大截。
 */

/** 預覽裡的一塊（`<p>` / `<h1>` / `<pre>` / 一個 `<li>`……）對應原始檔的哪幾行。 */
interface Span {
  /** 第一行（從 0 數）。 */
  start: number;
  /** 最後一行的下一行。 */
  end: number;
}

export type PreviewBlock =
  | (Span & { kind: 'frontmatter'; text: string })
  | (Span & { kind: 'heading'; level: 1 | 2 | 3; text: string })
  | (Span & { kind: 'paragraph'; text: string })
  | (Span & { kind: 'code'; text: string })
  | (Span & { kind: 'hr' })
  | (Span & { kind: 'quote'; text: string })
  | (Span & { kind: 'list'; ordered: boolean; items: (Span & { text: string })[] });

/**
 * 正文切成塊（夠用的那一套：frontmatter、標題、段落、程式碼塊、分隔線、引用、列表）。缺的語法當段落原樣顯示。
 *
 * - frontmatter：第一行是 `---`、後面某一行正好是 `---`，這一段（連同兩條線）是一塊。
 * - 連著的幾行普通文字是一段（空行、標題、程式碼塊、分隔線、引用、列表項都會斷開它）；段首縮排的正文沒有空行，
 *   整章就是一段——那時滾動對應只能在這一大塊裡按行數比例擺。
 * - 程式碼塊從開頭那條 ``` 到收尾那條（沒收尾就到文末）。
 * - 引用一行一塊；列表是連著的同一種列表項，每一項一行。
 */
export function previewBlocks(source: string): PreviewBlock[] {
  const lines = source.split(/\r?\n/);
  const blocks: PreviewBlock[] = [];
  let i = 0;

  if (lines[0] !== undefined && lines[0].trim() === '---') {
    const close = lines.indexOf('---', 1);
    if (close > 0) {
      blocks.push({ kind: 'frontmatter', start: 0, end: close + 1, text: lines.slice(1, close).join('\n') });
      i = close + 1;
    }
  }

  let para: { start: number; lines: string[] } | undefined;
  const flush = (): void => {
    if (para) {
      blocks.push({ kind: 'paragraph', start: para.start, end: para.start + para.lines.length, text: para.lines.join('\n') });
      para = undefined;
    }
  };
  let list: Extract<PreviewBlock, { kind: 'list' }> | undefined;
  const endList = (): void => {
    list = undefined;
  };

  for (; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === '') {
      flush();
      endList();
      continue;
    }

    if (trimmed.startsWith('```')) {
      flush();
      endList();
      const start = i;
      const buf: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith('```'); i++) {
        buf.push(lines[i]);
      }
      blocks.push({ kind: 'code', start, end: Math.min(i + 1, lines.length), text: buf.join('\n') });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flush();
      endList();
      // h4 以下都當 h3 畫：預覽是給人快速掃一眼的，再細分層級沒有意義。
      const level = Math.min(heading[1].length, 3) as 1 | 2 | 3;
      blocks.push({ kind: 'heading', level, start: i, end: i + 1, text: heading[2] });
      continue;
    }

    if (/^([-*_])\1{2,}$/.test(trimmed.replace(/\s/g, ''))) {
      flush();
      endList();
      blocks.push({ kind: 'hr', start: i, end: i + 1 });
      continue;
    }

    if (trimmed.startsWith('>')) {
      flush();
      endList();
      blocks.push({ kind: 'quote', start: i, end: i + 1, text: trimmed.replace(/^>\s?/, '') });
      continue;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    const ordered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed);
    if (bullet || ordered) {
      flush();
      const isOrdered = !bullet;
      if (!list || list.ordered !== isOrdered) {
        list = { kind: 'list', ordered: isOrdered, start: i, end: i + 1, items: [] };
        blocks.push(list);
      }
      list.items.push({ start: i, end: i + 1, text: bullet ? bullet[1] : ordered![2] });
      list.end = i + 1;
      continue;
    }

    endList();
    if (!para) {
      para = { start: i, lines: [] };
    }
    para.lines.push(line);
  }
  flush();
  return blocks;
}

// ---------------------------------------------------------------- 滾動對應

/** 預覽裡一塊（帶 `data-line` 的那幾樣）量出來的位置：`top` 從預覽內容的最頂上算，`height` 是它自己的高。 */
export interface BlockBox extends Span {
  top: number;
  height: number;
}

/** 夾進 `[lo, hi]`。 */
function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** `a` 到 `b` 之間按比例取一點（`span` 為 0 時取 `a`）。 */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp(t, 0, 1);
}

/**
 * 原始檔裡的位置（行，帶小數）→ 預覽裡的縱向位置。落在某一塊裡按它佔這一塊幾行的比例擺；落在兩塊之間的空行上，
 * 在上一塊的底與下一塊的頂之間按比例擺；在第一塊之前從 0 擺到它的頂，最後一塊之後就是它的底。`boxes` 按 `start` 排好、
 * 互不重疊（列表按項、不按整張列表）。
 */
export function sourceToPreviewY(boxes: readonly BlockBox[], pos: number): number {
  if (boxes.length === 0) {
    return 0;
  }
  const first = boxes[0];
  if (pos < first.start) {
    return lerp(0, first.top, first.start > 0 ? pos / first.start : 0);
  }
  for (let k = 0; k < boxes.length; k++) {
    const b = boxes[k];
    if (pos < b.end) {
      return pos >= b.start ? lerp(b.top, b.top + b.height, (pos - b.start) / Math.max(1, b.end - b.start)) : b.top;
    }
    const next = boxes[k + 1];
    if (next && pos < next.start) {
      return lerp(b.top + b.height, next.top, (pos - b.end) / Math.max(1, next.start - b.end));
    }
  }
  const last = boxes[boxes.length - 1];
  return last.top + last.height;
}

/** 預覽裡的縱向位置 → 原始檔裡的位置（行，帶小數）。`sourceToPreviewY` 反過來。 */
export function previewYToSource(boxes: readonly BlockBox[], y: number): number {
  if (boxes.length === 0) {
    return 0;
  }
  const first = boxes[0];
  if (y < first.top) {
    return lerp(0, first.start, first.top > 0 ? y / first.top : 0);
  }
  for (let k = 0; k < boxes.length; k++) {
    const b = boxes[k];
    const bottom = b.top + b.height;
    if (y < bottom) {
      return y >= b.top ? lerp(b.start, b.end, b.height > 0 ? (y - b.top) / b.height : 0) : b.start;
    }
    const next = boxes[k + 1];
    if (next && y < next.top) {
      return lerp(b.end, next.start, next.top > bottom ? (y - bottom) / (next.top - bottom) : 0);
    }
  }
  return boxes[boxes.length - 1].end;
}

/**
 * 編輯區：縱向位置 `y`（從第 0 行的頂算）落在第幾行（帶小數）。`topOf(i)` 是第 i 行的頂（`topOf(0)` 為 0，
 * `topOf(lineCount)` 是最後一行的底），按行單調不減。二分，只量 log₂(行數) 次——每量一次都要排一遍前面的文字。
 */
export function lineAtY(lineCount: number, topOf: (i: number) => number, y: number): number {
  if (lineCount <= 0) {
    return 0;
  }
  let lo = 0;
  let hi = lineCount - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (topOf(mid) <= y) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  const top = topOf(lo);
  const next = topOf(lo + 1);
  return lo + (next > top ? clamp((y - top) / (next - top), 0, 1) : 0);
}

/** 編輯區：第幾行（帶小數）的縱向位置。`lineAtY` 反過來。 */
export function yOfLine(lineCount: number, topOf: (i: number) => number, pos: number): number {
  if (lineCount <= 0) {
    return 0;
  }
  const p = clamp(pos, 0, lineCount);
  const i = Math.min(Math.floor(p), lineCount - 1);
  return lerp(topOf(i), topOf(i + 1), p - i);
}

/** 每一行開頭在文字裡的下標（`\n` 切）。 */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) {
    starts.push(at + 1);
  }
  return starts;
}

/** 下標落在第幾行（從 0 數）。 */
export function lineOfOffset(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}
