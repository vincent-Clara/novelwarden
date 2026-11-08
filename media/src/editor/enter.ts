/**
 * 回車。純函式只算「把哪一段換成什麼、之後選區落在哪」，由 {@link installEnter} 掛的按鍵處理函式
 * 交給 `Pane.applyEdit`——一次回車一步撤銷。
 *
 * ## 正文（`isProse`：章節與草稿）
 *
 * 按工程的分段格式另起一段：空行分段插 `\n\n`，段首縮排插 `\n` + 兩個全形空格，縮排加空行插
 * `\n\n` + 兩個全形空格（`paragraphBreak`）。有選區先替換選區；游標後面緊跟的空白刪掉（新段開頭不留空格）。
 *
 * - 這一行只有空白 / 縮排：只換行、不加縮排，並清掉這一行的空白——連按回車不會堆出一串只有縮排的行。
 * - 游標在段首（或段首的縮排裡）：這一段整個往下推一行、格式原樣，游標仍停在這一段的字前面。
 * - 標題行（`#` 開頭）後面回車與段落一樣：插段分隔，下一行是正文的一段（縮排的格式就帶縮排）——與
 *   「一鍵排版」排出來的樣子一致（標題與第一段之間也是段間隔）。
 * - `Shift+Enter` 只插 `\n`：詩、信、短句排列用。
 *
 * ## 非正文
 *
 * - Markdown（`.md` / `.markdown`）：新行沿用這一行行首的空白；列表接著寫（`- ` / `* ` / `+ ` 照抄，
 *   `1. ` / `1) ` 遞增），在空的列表項上回車就去掉標記、結束列表（那一行變成空行，不再往下加一行）。
 * - json / yml / 其他：只沿用縮排。
 */
import type { ParagraphStyle } from '../protocol';
import { paragraphBreak } from '../protocol';
import { addKeyHandler, isProse } from './api';
import type { TextSelection } from './history';
import { paragraphStyle } from './paragraphState';

/** 一次回車要做的替換，引數與 `Pane.applyEdit` 一一對應。 */
export interface EnterEdit {
  start: number;
  end: number;
  text: string;
  selection: TextSelection;
}

/** 哪些檔案按 Markdown 處理（列表接續）。與 `pane.ts` 判「能不能預覽」是同一個口徑。 */
export const MARKDOWN_RE = /\.(md|markdown)$/i;

const caret = (at: number): TextSelection => ({ start: at, end: at });

/** `pos` 所在行的行首。 */
export function lineStartOf(value: string, pos: number): number {
  return pos <= 0 ? 0 : value.lastIndexOf('\n', pos - 1) + 1;
}

/** `pos` 所在行的行尾（不含換行）。 */
export function lineEndOf(value: string, pos: number): number {
  const nl = value.indexOf('\n', pos);
  return nl === -1 ? value.length : nl;
}

/** 行內空白：半形空格、製表符、全形空格、不換行空格。 */
const INLINE_SPACE = /^[ \t　 ]*/;

const isBlank = (s: string) => s.trim() === '';

/** 正文裡的回車（規則見檔案頭）。 */
export function proseEnter(value: string, sel: TextSelection, style: ParagraphStyle): EnterEdit {
  const lineStart = lineStartOf(value, sel.start);
  const lineEnd = lineEndOf(value, sel.end);
  const head = value.slice(lineStart, sel.start);
  const tail = value.slice(sel.end, lineEnd);
  if (isBlank(head) && isBlank(tail)) {
    // 這一行只有空白：只換行、不加縮排，順手清掉這一行的空白。
    return { start: lineStart, end: lineEnd, text: '\n', selection: caret(lineStart + 1) };
  }
  if (isBlank(head)) {
    // 游標在段首或段首的縮排裡：整段往下推一行，游標停在字前面。
    const line = head + tail;
    const lead = INLINE_SPACE.exec(line)![0].length;
    return { start: lineStart, end: lineEnd, text: `\n${line}`, selection: caret(lineStart + 1 + lead) };
  }
  const skip = INLINE_SPACE.exec(tail)![0].length;
  const br = paragraphBreak(style);
  return { start: sel.start, end: sel.end + skip, text: br, selection: caret(sel.start + br.length) };
}

const BULLET = /^([ \t]*)([-*+])([ \t]+)/;
const ORDERED = /^([ \t]*)(\d{1,9})([.)])([ \t]+)/;
/** 分隔線（`---`、`* * *`）不是列表項。 */
const RULE = /^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/;

/** Markdown 裡的回車：列表接著寫，空的列表項結束列表，其餘沿用縮排。 */
export function markdownEnter(value: string, sel: TextSelection): EnterEdit {
  const lineStart = lineStartOf(value, sel.start);
  const lineEnd = lineEndOf(value, sel.end);
  const head = value.slice(lineStart, sel.start);
  const tail = value.slice(sel.end, lineEnd);
  if (!RULE.test(head + tail)) {
    const ordered = ORDERED.exec(head);
    const bullet = ordered ? null : BULLET.exec(head);
    const m = ordered ?? bullet;
    if (m) {
      const rest = head.slice(m[0].length) + tail;
      if (isBlank(rest)) {
        // 空的列表項：去掉標記、結束列表。
        return { start: lineStart, end: lineEnd, text: '', selection: caret(lineStart) };
      }
      const marker = ordered
        ? `${ordered[1]}${Number(ordered[2]) + 1}${ordered[3]}${ordered[4]}`
        : `${bullet![1]}${bullet![2]}${bullet![3]}`;
      const text = `\n${marker}`;
      return { start: sel.start, end: sel.end, text, selection: caret(sel.start + text.length) };
    }
  }
  return plainEnter(value, sel);
}

/** 其餘檔案的回車：新行沿用這一行行首的空白（游標在縮排中間時只沿用游標前那一截）。 */
export function plainEnter(value: string, sel: TextSelection): EnterEdit {
  const head = value.slice(lineStartOf(value, sel.start), sel.start);
  const text = `\n${INLINE_SPACE.exec(head)![0]}`;
  return { start: sel.start, end: sel.end, text, selection: caret(sel.start + text.length) };
}

/** 掛回車的按鍵處理函式。`Ctrl/Cmd+Enter`（另起一段）在 `lines.ts`，這裡不接。 */
export function installEnter(): void {
  addKeyHandler((e, { pane, file, area }) => {
    if (e.key !== 'Enter' || e.altKey || e.ctrlKey || e.metaKey) {
      return false;
    }
    const sel = { start: area.selectionStart, end: area.selectionEnd };
    let edit: EnterEdit;
    if (isProse(file)) {
      edit = e.shiftKey
        ? { start: sel.start, end: sel.end, text: '\n', selection: caret(sel.start + 1) }
        : proseEnter(area.value, sel, paragraphStyle());
    } else if (e.shiftKey) {
      // 非正文的 Shift+Enter 交給瀏覽器（就是插一個換行）。
      return false;
    } else {
      edit = MARKDOWN_RE.test(file.path) ? markdownEnter(area.value, sel) : plainEnter(area.value, sel);
    }
    pane.applyEdit(edit.start, edit.end, edit.text, edit.selection);
    return true;
  });
}
