/**
 * 段落快捷鍵（所有檔案）。「段」= 一個邏輯行（編輯區裡的一行，自動折行不算斷開）；空白行被跳過。
 * 純函式只算「把哪一段換成什麼、之後選區落在哪」，由 {@link installLineKeys} 交給 `Pane.applyEdit`——
 * 每個操作一步撤銷。
 *
 * | 按鍵 | 做什麼 |
 * |---|---|
 * | `Alt+↑` / `Alt+↓` | 游標所在行（有選區就是碰到的那幾行，當成一塊）與上 / 下一個非空行交換，中間的空行原地不動，選區跟著走 |
 * | `Shift+Alt+↓` / `Shift+Alt+↑` | 在下 / 上方複製這幾行（正文按分段格式補段間隔）；向下複製時選區跟到新的那份上 |
 * | `Ctrl+Shift+K` | 刪掉這幾行（正文空行分段 / 縮排加空行下順帶刪一個相鄰的空行，不留下兩個連著的空行） |
 * | `Ctrl+Enter` | 在當前段下面另起一段（正文按分段格式，其餘沿用縮排） |
 *
 * Mac 上 `Ctrl` 也認 `Cmd`。「碰到」與 Tab 縮排同一個口徑：選區止於某一行的行首時，那一行不算。
 */
import { paragraphBreak, paragraphGap } from '../protocol';
import { addKeyHandler, isProse } from './api';
import type { OpenFile } from './api';
import type { TextSelection } from './history';
import { paragraphStyle } from './paragraphState';

/** 一次操作要做的替換，引數與 `Pane.applyEdit` 一一對應。 */
export interface LineEdit {
  start: number;
  end: number;
  text: string;
  selection: TextSelection;
}

interface Lines {
  lines: string[];
  /** 每一行在原文裡的起點。 */
  starts: number[];
}

function split(value: string): Lines {
  const lines = value.split('\n');
  const starts: number[] = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }
  return { lines, starts };
}

const isBlank = (s: string) => s.trim() === '';

/** 第幾行（從 0 起）。 */
function lineIndexOf(value: string, pos: number): number {
  let n = 0;
  for (let i = value.indexOf('\n'); i !== -1 && i < pos; i = value.indexOf('\n', i + 1)) {
    n++;
  }
  return n;
}

/** 選區碰到的那幾行：`[first, last]`（行號）。選區止於某一行的行首時那一行不算。 */
export function touchedLines(value: string, sel: TextSelection): { first: number; last: number } {
  const first = lineIndexOf(value, sel.start);
  const end = sel.end > sel.start && value[sel.end - 1] === '\n' ? sel.end - 1 : sel.end;
  return { first, last: Math.max(first, lineIndexOf(value, end)) };
}

const lengthWithBreaks = (lines: string[]) => lines.reduce((n, l) => n + l.length + 1, 0);

/**
 * 與上（`dir = -1`）/ 下（`dir = 1`）一個非空行交換。這幾行全是空行、或那一邊沒有非空行時 undefined。
 */
export function moveLines(value: string, sel: TextSelection, dir: 1 | -1): LineEdit | undefined {
  const { lines, starts } = split(value);
  const { first, last } = touchedLines(value, sel);
  const block = lines.slice(first, last + 1);
  if (block.every(isBlank)) {
    return undefined;
  }
  if (dir === 1) {
    let j = last + 1;
    while (j < lines.length && isBlank(lines[j])) {
      j++;
    }
    if (j >= lines.length) {
      return undefined;
    }
    const blanks = lines.slice(last + 1, j);
    const shift = lines[j].length + 1 + lengthWithBreaks(blanks);
    return {
      start: starts[first],
      end: starts[j] + lines[j].length,
      text: [lines[j], ...blanks, ...block].join('\n'),
      selection: { start: sel.start + shift, end: sel.end + shift },
    };
  }
  let i = first - 1;
  while (i >= 0 && isBlank(lines[i])) {
    i--;
  }
  if (i < 0) {
    return undefined;
  }
  const blanks = lines.slice(i + 1, first);
  const shift = lines[i].length + 1 + lengthWithBreaks(blanks);
  return {
    start: starts[i],
    end: starts[last] + lines[last].length,
    text: [...block, ...blanks, lines[i]].join('\n'),
    selection: { start: sel.start - shift, end: sel.end - shift },
  };
}

/**
 * 在下（`dir = 1`）/ 上（`dir = -1`）方複製這幾行，兩份之間隔著 `gap`（`\n`，或正文空一行的 `\n\n`）。
 * 兩個方向寫出來的字一樣，只是選區落在哪一份上不同（向下落在新的那份，向上留在上面那份）。
 * 這幾行全是空行時 undefined。
 */
export function duplicateLines(value: string, sel: TextSelection, dir: 1 | -1, gap: string): LineEdit | undefined {
  const { lines, starts } = split(value);
  const { first, last } = touchedLines(value, sel);
  const block = lines.slice(first, last + 1);
  if (block.every(isBlank)) {
    return undefined;
  }
  const at = starts[last] + lines[last].length;
  const text = gap + block.join('\n');
  const shift = dir === 1 ? text.length : 0;
  return { start: at, end: at, text, selection: { start: sel.start + shift, end: sel.end + shift } };
}

/**
 * 刪掉這幾行。`collapseBlank`（正文空行分段 / 縮排加空行）時順帶刪一個相鄰的空行：兩邊都是空行時刪後面那個，
 * 刪的是第一段時刪後面那個空行，刪的是最後一段時刪前面那個——不留下兩個連著的空行，也不在文首文末留空行。
 * 游標落在原來那幾行之後的那一行行首。
 */
export function deleteLines(value: string, sel: TextSelection, collapseBlank: boolean): LineEdit {
  const { lines } = split(value);
  const { first, last } = touchedLines(value, sel);
  const remove = new Set<number>();
  for (let i = first; i <= last; i++) {
    remove.add(i);
  }
  if (collapseBlank) {
    const prevBlank = first > 0 && isBlank(lines[first - 1]);
    const nextBlank = last + 1 < lines.length && isBlank(lines[last + 1]);
    if (nextBlank && (prevBlank || first === 0)) {
      remove.add(last + 1);
    } else if (prevBlank && last + 1 >= lines.length) {
      remove.add(first - 1);
    }
  }
  const kept = lines.filter((_, i) => !remove.has(i));
  const firstRemoved = Math.min(...remove);
  const landing = Math.max(0, Math.min(firstRemoved, kept.length - 1));
  const caret = lengthWithBreaks(kept.slice(0, landing));
  return { start: 0, end: value.length, text: kept.join('\n'), selection: { start: caret, end: caret } };
}

/** 在選區碰到的最後一行下面另起一段：行尾插 `insert`，游標落在插入之後。 */
export function paragraphBelow(value: string, sel: TextSelection, insert: (line: string) => string): LineEdit {
  const { lines, starts } = split(value);
  const { last } = touchedLines(value, sel);
  const at = starts[last] + lines[last].length;
  const text = insert(lines[last]);
  return { start: at, end: at, text, selection: { start: at + text.length, end: at + text.length } };
}

/** 正文按分段格式、其餘按 `\n` 隔開複製出來的那一份。 */
function gapFor(file: OpenFile): string {
  return isProse(file) ? paragraphGap(paragraphStyle()) : '\n';
}

/** 掛段落快捷鍵。 */
export function installLineKeys(): void {
  addKeyHandler((e, { pane, file, area }) => {
    const mod = e.ctrlKey || e.metaKey;
    const value = area.value;
    const sel = { start: area.selectionStart, end: area.selectionEnd };
    let edit: LineEdit | undefined;
    if (e.altKey && !mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      edit = e.shiftKey ? duplicateLines(value, sel, dir, gapFor(file)) : moveLines(value, sel, dir);
    } else if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
      edit = deleteLines(value, sel, isProse(file) && paragraphStyle() !== 'indent');
    } else if (mod && !e.shiftKey && !e.altKey && e.key === 'Enter') {
      const prose = isProse(file);
      const style = paragraphStyle();
      edit = paragraphBelow(value, sel, (line) =>
        prose ? paragraphBreak(style) : `\n${/^[ \t　 ]*/.exec(line)![0]}`
      );
    } else {
      return false;
    }
    // 沒得可做（到頂 / 到底、全是空行）也接下這一下：瀏覽器對這幾個組合鍵的預設動作在編輯區裡沒有用。
    if (edit) {
      pane.applyEdit(edit.start, edit.end, edit.text, edit.selection);
    }
    return true;
  });
}
