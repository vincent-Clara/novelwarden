/**
 * 查詢替換的**匹配口徑**：找全部匹配、逐處算替換文字、全部替換 / 只換挑出來的那幾處算出的新文字。
 *
 * **純函式、零 import**：內建編輯器的查詢替換條（`media/src/editor/findCore.ts` 原樣轉出這裡的函式，經
 * `media/src/protocol.ts` 打進瀏覽器產物）與全書查詢替換（後端 `views/bookFind.ts`、`features/bookReplace.ts`）
 * 共用這一份——同一個查詢串、同兩顆開關，在一份檔案裡找到的與在全書裡找到的必須是同一批，`$1` 也得展開成
 * 同一個樣子。從前它只在前端（`findCore.ts`），全書查詢要在後端讀盤，搬過來而不是另寫一套正則語義。
 *
 * 幾條口徑（單測釘在 `tests/unit/editor/findCore.test.js`）：
 *
 * - 位置一律是字串下標（與 `textarea.selectionStart` 同一套）。
 * - 預設**不區分大小寫**、**不按正則**。不按正則時查詢串原樣當字面量，替換串裡的 `$1` 也是字面量。
 * - 按正則時帶 `m`（`^` / `$` 認每一行的頭尾，按「段首兩個全形空格」這類找法才找得到），先試 `u`
 *   （生僻字那種代理對按一個字算），`u` 下語法不合法（比如多寫了一個 `\。`）再退回不帶 `u` 的；
 *   兩樣都編不過才算「正則寫錯了」——**絕不拋**。
 * - **零長度匹配跳過**（`^`、`\b`、`a*` 匹配到空串的那些位置不算一處）。
 * - 替換串的 `$1` / `$&` / `` $` `` / `$'` / `$$` / `$<名字>` 與 `String.prototype.replace` 同語義，
 *   而且是**逐處在全文裡算**的：前後文（後行斷言、`` $` ``）看的是整份文字，不是被切出來的那一小段。
 * - 跨行：正則裡寫了 `\n`（或 `[\s\S]`）就能跨行匹配，字面量裡有換行也照樣認；一處匹配的範圍就是它覆蓋的那幾行。
 */

export interface FindOptions {
  /** 區分大小寫。預設關。 */
  caseSensitive?: boolean;
  /** 按正則。預設關。 */
  regex?: boolean;
}

/** 一處匹配：`[start, end)`，`end > start`（零長度的不算）。 */
export interface FindMatch {
  start: number;
  end: number;
}

export interface FindResult {
  matches: FindMatch[];
  /** 匹配數到了上限、後面的沒數（介面寫「20000+」）。 */
  truncated: boolean;
  /** 正則寫錯了：瀏覽器給的原因（介面只說「正則寫錯了」，原因放在提示裡）。 */
  error?: string;
}

/** 全部替換要做的那一筆改動：把 `[start, end)` 換成 `text`，一共替換了 `count` 處。 */
export interface ReplaceAllEdit {
  start: number;
  end: number;
  text: string;
  count: number;
}

/** 只換挑出來的那幾處之後的結果（{@link replaceSelectedIn}）。 */
export interface SelectedReplace {
  /** 換完之後的整份文字。 */
  text: string;
  /** 換掉了的那幾處（原文裡的位置，按先後排）。 */
  replaced: FindMatch[];
  /** 對不上的那幾處：那個位置上已經不是一處匹配（文字變過、或與前一處重疊了），沒換。 */
  missed: FindMatch[];
}

/**
 * 最多數多少處。再多就不往下數了（介面寫「n+」）——一個 `.` 在三十萬字裡能匹配三十萬處，
 * 全記下來既費記憶體，高亮層也畫不動。全部替換不受這個限制（它不記位置，邊找邊拼）。
 */
export const MATCH_LIMIT = 20000;

export type CompiledSearch = { ok: true; re: RegExp } | { ok: false; error: string };

/** 把字面量裡的正則元字元轉義掉。 */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把查詢串編成一個**新的**全域正則（每次呼叫一個新物件，`lastIndex` 不串）。
 * 空串返回 undefined；正則寫錯返回 `{ ok: false }`，絕不拋。
 */
export function compileSearch(query: string, opts: FindOptions = {}): CompiledSearch | undefined {
  if (!query) {
    return undefined;
  }
  const flags = opts.caseSensitive ? 'g' : 'gi';
  if (!opts.regex) {
    return { ok: true, re: new RegExp(escapeRegExp(query), `${flags}u`) };
  }
  try {
    return { ok: true, re: new RegExp(query, `${flags}mu`) };
  } catch {
    // `u` 下更嚴（多餘的轉義、孤立的 `{` 都算錯），退一步再試。
  }
  try {
    return { ok: true, re: new RegExp(query, `${flags}m`) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 零長度匹配之後往前挪一格；`u` 模式下不把代理對劈開。 */
function advance(text: string, index: number, unicode: boolean): number {
  if (unicode && index + 1 < text.length) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        return index + 2;
      }
    }
  }
  return index + 1;
}

/** 按順序給出全文裡每一處**非空**匹配（`re` 必須是全域的，會被改 `lastIndex`）。 */
function* eachMatch(text: string, re: RegExp): Generator<RegExpExecArray> {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex = advance(text, re.lastIndex, re.unicode);
      continue;
    }
    yield m;
  }
}

/** 找全部匹配。空查詢串給空結果；正則寫錯給 `error`，不拋。 */
export function findMatches(
  text: string,
  query: string,
  opts: FindOptions = {},
  limit = MATCH_LIMIT
): FindResult {
  const compiled = compileSearch(query, opts);
  if (!compiled) {
    return { matches: [], truncated: false };
  }
  if (!compiled.ok) {
    return { matches: [], truncated: false, error: compiled.error };
  }
  const matches: FindMatch[] = [];
  for (const m of eachMatch(text, compiled.re)) {
    if (matches.length >= limit) {
      return { matches, truncated: true };
    }
    matches.push({ start: m.index, end: m.index + m[0].length });
  }
  return { matches, truncated: false };
}

/**
 * 替換串展開（ECMAScript 的 GetSubstitution，與 `String.prototype.replace` 一字不差）：
 * `$$` → `$`，`$&` → 匹配到的字，`` $` `` / `$'` → 全文裡這一處之前 / 之後的字，
 * `$n` / `$nn` → 第 n 組（兩位數超過組數時按一位數加一個字面數字讀，`$0` 原樣），
 * `$<名字>` → 命名組（正則裡沒有命名組時原樣）。認不出的 `$` 原樣留著。
 */
export function expandReplacement(template: string, m: RegExpExecArray, text: string): string {
  if (!template.includes('$')) {
    return template;
  }
  const matched = m[0];
  const position = m.index;
  const captures = m.slice(1);
  const groups = m.groups;
  let out = '';
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch !== '$' || i + 1 >= template.length) {
      out += ch;
      i++;
      continue;
    }
    const next = template[i + 1];
    if (next === '$') {
      out += '$';
      i += 2;
    } else if (next === '&') {
      out += matched;
      i += 2;
    } else if (next === '`') {
      out += text.slice(0, position);
      i += 2;
    } else if (next === "'") {
      out += text.slice(Math.min(text.length, position + matched.length));
      i += 2;
    } else if (next >= '0' && next <= '9') {
      const d2 = template[i + 2];
      let digits = d2 !== undefined && d2 >= '0' && d2 <= '9' ? 2 : 1;
      let index = Number(template.slice(i + 1, i + 1 + digits));
      if (digits === 2 && index > captures.length) {
        digits = 1;
        index = Number(next);
      }
      out += index >= 1 && index <= captures.length
        ? captures[index - 1] ?? ''
        : template.slice(i, i + 1 + digits);
      i += 1 + digits;
    } else if (next === '<') {
      const close = groups ? template.indexOf('>', i + 2) : -1;
      if (!groups || close === -1) {
        out += '$<';
        i += 2;
      } else {
        out += groups[template.slice(i + 2, close)] ?? '';
        i = close + 1;
      }
    } else {
      out += '$';
      i++;
    }
  }
  return out;
}

/** 編好的全域正則 → 只在給定位置試的粘性版本（前後文仍是整份文字）。 */
function stickyOf(re: RegExp): RegExp {
  return new RegExp(re.source, `${re.flags.replace('g', '')}y`);
}

/**
 * 這一處要換成什麼。不按正則時就是替換串本身（`$` 是字面量）；按正則時在**全文**裡從這一處重新匹配一次，
 * 照 `String.prototype.replace` 的規矩展開 `$1` 這些。這一處已經對不上（文字剛變過）、或正則寫錯時返回 undefined。
 */
export function replacementFor(
  text: string,
  at: FindMatch,
  query: string,
  replacement: string,
  opts: FindOptions = {}
): string | undefined {
  const compiled = compileSearch(query, opts);
  if (!compiled?.ok) {
    return undefined;
  }
  // 粘性（y）且不全域：只在 at.start 這一個位置試，前後文仍是整份文字。
  const re = stickyOf(compiled.re);
  re.lastIndex = at.start;
  const m = re.exec(text);
  if (!m || m[0].length !== at.end - at.start) {
    return undefined;
  }
  return opts.regex ? expandReplacement(replacement, m, text) : replacement;
}

/**
 * 全部替換：算出**從第一處到最後一處的那一段**換成什麼（編輯器拿它調一次 `applyEdit`，只記一步撤銷）。
 * 一處都沒有、查詢串為空或正則寫錯時返回 undefined。
 */
export function replaceAllIn(
  text: string,
  query: string,
  replacement: string,
  opts: FindOptions = {}
): ReplaceAllEdit | undefined {
  const compiled = compileSearch(query, opts);
  if (!compiled?.ok) {
    return undefined;
  }
  let start = -1;
  let last = 0;
  let count = 0;
  const parts: string[] = [];
  for (const m of eachMatch(text, compiled.re)) {
    if (start < 0) {
      start = m.index;
      last = m.index;
    }
    parts.push(text.slice(last, m.index), opts.regex ? expandReplacement(replacement, m, text) : replacement);
    last = m.index + m[0].length;
    count++;
  }
  return count > 0 ? { start, end: last, text: parts.join(''), count } : undefined;
}

/**
 * **只換挑出來的那幾處**（全書替換：作者在預覽裡勾掉了幾處）。每一處都在**原文**裡、在它自己的位置上重新匹配一次
 * （與 {@link replacementFor} 同一個辦法：`$1`、`` $` ``、後行斷言看的都是整份原文），對得上才換；對不上的
 * （那個位置上已經不是一處匹配、或與前一處重疊）記進 `missed`、原樣留著。挑出來的順序無所謂，按位置排。
 * 查詢串為空或正則寫錯時返回 undefined。
 */
export function replaceSelectedIn(
  text: string,
  picks: readonly FindMatch[],
  query: string,
  replacement: string,
  opts: FindOptions = {}
): SelectedReplace | undefined {
  const compiled = compileSearch(query, opts);
  if (!compiled?.ok) {
    return undefined;
  }
  const re = stickyOf(compiled.re);
  const sorted = [...picks].sort((a, b) => a.start - b.start || a.end - b.end);
  const replaced: FindMatch[] = [];
  const missed: FindMatch[] = [];
  const parts: string[] = [];
  let last = 0;
  for (const pick of sorted) {
    if (pick.start < last || pick.end <= pick.start) {
      missed.push(pick);
      continue;
    }
    re.lastIndex = pick.start;
    const m = re.exec(text);
    if (!m || m.index !== pick.start || m[0].length !== pick.end - pick.start) {
      missed.push(pick);
      continue;
    }
    parts.push(text.slice(last, pick.start), opts.regex ? expandReplacement(replacement, m, text) : replacement);
    last = pick.end;
    replaced.push(pick);
  }
  parts.push(text.slice(last));
  return { text: parts.join(''), replaced, missed };
}
