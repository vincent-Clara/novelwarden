/**
 * Tab / Shift+Tab 縮排。純函式：只算「把哪一段換成什麼、之後選區落在哪」，由 `pane.ts` 交給
 * `Pane.applyEdit` 執行——一次按鍵一步撤銷。縮排單位（正文兩個全形空格、其餘兩個半形空格）
 * 由呼叫方按 `api.ts` 的 `indentUnit(file)` 給。
 *
 * - **有選區**（哪怕只在一行裡選了幾個字）：**絕不刪選中的字**，給選區碰到的每一行行首加一級縮排
 *   （空行、只有空白的行跳過），之後選區仍覆蓋這幾行，起止位置隨插入量平移。
 * - **Shift+Tab**：選區碰到的每一行（沒有選區就是游標所在那一行）去掉行首一級縮排——認
 *   `　　`、單個 `　`、兩個半形空格、一個半形空格、`\t`，按這個順序試，每行最多去一級。
 * - 「碰到」：選區止於某一行的行首時（選整行時常見，游標落在下一行開頭），那一行不算。
 *
 * 沒有選區時的 Tab（在游標處插一級縮排）不經這裡，`pane.ts` 直接 `applyEdit(游標, 游標, 單位)`。
 */
import type { TextSelection } from './history';

/** 一次縮排 / 去縮排要做的替換，引數與 `Pane.applyEdit` 一一對應。 */
export interface IndentEdit {
  start: number;
  end: number;
  text: string;
  selection: TextSelection;
}

/** Shift+Tab 認的行首縮排，按先後試，每行最多去一級。 */
const OUTDENT_PREFIXES = ['　　', '　', '  ', ' ', '\t'];

/** 選區碰到的那幾行：`[from, to)`，`from` 是第一行行首，`to` 是最後一行行尾（不含換行）。 */
function touchedLines(value: string, sel: TextSelection): { from: number; to: number } {
  const from = sel.start === 0 ? 0 : value.lastIndexOf('\n', sel.start - 1) + 1;
  // 選區止於某一行的行首：那一行不算。
  const last = sel.end > sel.start && value[sel.end - 1] === '\n' ? sel.end - 1 : sel.end;
  const nl = value.indexOf('\n', last);
  return { from, to: nl === -1 ? value.length : nl };
}

/** 選區碰到的每一行行首加一級縮排。一行都沒加（全是空行）時返回 undefined。 */
export function indentLines(value: string, sel: TextSelection, unit: string): IndentEdit | undefined {
  const { from, to } = touchedLines(value, sel);
  /** 在舊文字裡哪些位置插了縮排。 */
  const inserts: number[] = [];
  let pos = from;
  const lines = value
    .slice(from, to)
    .split('\n')
    .map((line) => {
      const at = pos;
      pos += line.length + 1;
      if (line.trim() === '') {
        return line;
      }
      inserts.push(at);
      return unit + line;
    });
  if (inserts.length === 0) {
    return undefined;
  }
  // 插在某個位置之前的縮排才把它往後推：選區起點正好在行首時留在行首（新縮排算進選區）。
  const map = (p: number) => p + unit.length * inserts.filter((q) => q < p).length;
  return { start: from, end: to, text: lines.join('\n'), selection: { start: map(sel.start), end: map(sel.end) } };
}

/** 選區碰到的每一行（沒有選區就是游標所在行）去掉行首一級縮排。一處都沒去時返回 undefined。 */
export function outdentLines(value: string, sel: TextSelection): IndentEdit | undefined {
  const { from, to } = touchedLines(value, sel);
  /** 在舊文字裡去掉了哪幾段：`[at, at + len)`。 */
  const removals: { at: number; len: number }[] = [];
  let pos = from;
  const lines = value
    .slice(from, to)
    .split('\n')
    .map((line) => {
      const at = pos;
      pos += line.length + 1;
      const prefix = OUTDENT_PREFIXES.find((p) => line.startsWith(p));
      if (!prefix) {
        return line;
      }
      removals.push({ at, len: prefix.length });
      return line.slice(prefix.length);
    });
  if (removals.length === 0) {
    return undefined;
  }
  // 落在被刪那段之後的往前挪整段，落在那段中間的挪到那段的起點。
  const map = (p: number) =>
    p - removals.reduce((sum, r) => sum + Math.max(0, Math.min(p - r.at, r.len)), 0);
  return { start: from, end: to, text: lines.join('\n'), selection: { start: map(sel.start), end: map(sel.end) } };
}
