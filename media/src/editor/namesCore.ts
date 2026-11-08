/**
 * 「名詞補全」的匹配與排序（角色名、地名……），外加「名詞高亮」在正文裡認名字。**純函式、零 DOM**：裝配（按鍵、
 * 彈出框、插入）在 `names.ts`，名詞圖層與懸停浮窗在 `nameMarks.ts`；從游標前取查詢詞、按開頭匹配、排序、邊打邊彈的
 * 判定、插入時替換哪一段、正文裡哪幾段是名字都在這裡，單測見 `tests/unit/editor/namesCore.test.js`。
 *
 * ## 查詢詞：中文沒有詞邊界
 *
 * 從游標往前取 1~{@link MAX_QUERY} 個字（碰到空白、標點就停），挑**能匹配上某個名字開頭的最長那段**
 * （{@link queryBefore}）：「他看見林」認「林」，「青雲」認「青雲」。什麼都匹配不上就是空查詢——手動按鍵時列全部。
 *
 * ## 匹配與排序（{@link matchNames}）
 *
 * - **只認開頭**：查詢詞是正名或某個別名（角色別名、設定關鍵詞）的開頭，不分大小寫。一個名詞只列一行：正名對得上就是
 *   正名，否則第一個對得上的別名（顯示「別名 → 正名」，插入的是那個別名）。拼音首字母不認——`/` 命令面板的拼音鍵是
 *   每條命令手寫的，沒有現成的漢字轉拼音表可複用（⚑）。
 * - **最近在本檔案出現的排前面**：游標（準確說是查詢詞開頭）往前 {@link RECENT_BEFORE} 字裡出現過的，越近越前；只在
 *   游標後面 {@link RECENT_AFTER} 字裡出現過的其次；都沒出現過的最後。同一檔裡角色 → 設定 → 未建條目，正名先於別名，
 *   短的先於長的，最後按表裡的先後。
 *
 * ## 邊打邊彈（{@link autoPopQuery}，⚑）
 *
 * 只認打字與輸入法上屏（帶 `change` 的那一下，組字中途不算）、剛插入了字、沒有選區；查詢詞至少
 * {@link AUTO_MIN_CHARS} 個字；**已經打完整了不彈**（查詢詞正好是某個名字或別名）；名字剩下那截已經在游標後面的不算。
 *
 * ## 名詞高亮：正文裡哪幾段是名字（{@link nameRanges}）
 *
 * 與補全同一張表、同一套叫法（正名與別名，不分大小寫），一趟掃完（`locateTerms`）。
 * - **長的優先、不重疊**：「林昭陽」不會被認成「林昭」加一個「陽」；同一處起頭的取最長的那個叫法。
 * - **一個字的叫法不認**（⚑）：「道」「氣」這樣的設定一標就是滿屏。後端給的別名本來就不收一個字的，這裡連正名一起擋。
 * - **英文叫法要整詞**：前後挨著字母或數字的不算（「Lin」不認「Linear」裡那一截）。中文沒有詞邊界，照認。
 * - **卡或條目自己那一份裡不標它自己**（⚑）：角色卡通篇是這個人的名字，標出來只是滿屏的底色。
 * - 兩條叫法撞了（角色的別名正好是某條設定的關鍵詞）：表裡排前面的那條算（角色 → 設定 → 未建條目）。
 */
import { foldLatin, locateTerms } from '../protocol';
import type { NameEntry, NameIndex, NameSource } from '../protocol';
import type { TextChange } from './history';

/** 從游標往前最多取幾個字當查詢詞。 */
export const MAX_QUERY = 4;
/** 邊打邊彈：查詢詞至少幾個字（⚑ 2：一個字時「林」「沈」這類常用字一打就彈，太吵）。 */
export const AUTO_MIN_CHARS = 2;
/** 彈出框一次最多列幾條。 */
export const NAME_LIST_LIMIT = 50;
/** 「最近在本檔案出現」往前看多少字。 */
export const RECENT_BEFORE = 20_000;
/** 往後看多少字（前面沒出現過、後面出現過的排在第二檔）。 */
export const RECENT_AFTER = 5_000;

/**
 * 哪些檔案補全：正文（章節、草稿）、細綱、角色卡、設定條目，外加情節大綱與敘事線（⚑）——作者會寫到名字的
 * Markdown。小說配置、故事前提、世界觀後端都給 `setting`，分不出哪份是配置，一律不補；敏感詞表（`sensitive`，
 * `.novelwarden/sensitive.txt`，寫作體檢讀它）、文風、全文大綱、技能、別的檔案不補。是白名單：以後新加的種類預設不補。
 * 看後端給的 `kind`，前端不拿路徑猜。
 */
const COMPLETION_KINDS: ReadonlySet<string> = new Set(['chapter', 'draft', 'plot', 'character', 'lore', 'outline', 'threads']);

export function completionApplies(kind: string | undefined): boolean {
  return !!kind && COMPLETION_KINDS.has(kind);
}

/** 同一檔裡的先後：角色、設定、未建條目。 */
const SOURCE_ORDER: Record<NameSource, number> = { character: 0, lore: 1, unfiled: 2 };

/** 一個叫法（正名或別名）。 */
export interface NameForm {
  text: string;
  /** 小寫，比較用。 */
  lower: string;
  alias: boolean;
}

/** 表裡的一條（切好的）。 */
export interface NameItem {
  /** 在表裡的先後。 */
  order: number;
  name: string;
  aliases: string[];
  source: NameSource;
  category: string;
  brief: string;
  path?: string;
  /** 型別那一格：角色卡寫「角色」，設定與未建條目寫分類，沒有分類寫「設定」。 */
  badge: string;
  /** 正名在前，別名按原來的先後。 */
  forms: NameForm[];
}

export interface NameCatalog {
  items: NameItem[];
  /** 小寫的前 1~{@link MAX_QUERY} 個字：有沒有哪個叫法這樣開頭（取查詢詞用）。 */
  prefixes: Set<string>;
  /** 小寫的完整叫法（判「打完整了」用）。 */
  exact: Set<string>;
  initialized: boolean;
}

/** 把後端給的表切好。表到了做一次，之後每打一個字只查不切。 */
export function buildNameCatalog(index: NameIndex | undefined): NameCatalog {
  const items: NameItem[] = [];
  const prefixes = new Set<string>();
  const exact = new Set<string>();
  for (const entry of index?.names ?? []) {
    const item = toItem(entry, items.length);
    if (!item) {
      continue;
    }
    items.push(item);
    for (const form of item.forms) {
      exact.add(form.lower);
      const cps = Array.from(form.lower);
      for (let k = 1; k <= Math.min(MAX_QUERY, cps.length); k++) {
        prefixes.add(cps.slice(0, k).join(''));
      }
    }
  }
  return { items, prefixes, exact, initialized: index?.initialized !== false };
}

function toItem(entry: NameEntry, order: number): NameItem | undefined {
  const name = (entry.name ?? '').trim();
  if (!name) {
    return undefined;
  }
  const seen = new Set<string>([name.toLowerCase()]);
  const forms: NameForm[] = [{ text: name, lower: name.toLowerCase(), alias: false }];
  for (const raw of entry.aliases ?? []) {
    const text = (raw ?? '').trim();
    const lower = text.toLowerCase();
    if (text && !seen.has(lower)) {
      seen.add(lower);
      forms.push({ text, lower, alias: true });
    }
  }
  const source: NameSource = entry.source === 'lore' || entry.source === 'unfiled' ? entry.source : 'character';
  const category = entry.category ?? '';
  return {
    order,
    name,
    aliases: forms.filter((f) => f.alias).map((f) => f.text),
    source,
    category,
    brief: entry.brief ?? '',
    ...(entry.path ? { path: entry.path } : {}),
    badge: source === 'character' ? '角色' : category || '設定',
    forms,
  };
}

// ---------------------------------------------------------------- 查詢詞

/** 名字裡會出現的字：文字、數字、附加符號，外加外文名裡的間隔號與連字元、撇號。 */
const NAME_CHAR = /^[\p{L}\p{N}\p{M}·・•‧'’-]$/u;

export function isNameChar(ch: string): boolean {
  return NAME_CHAR.test(ch);
}

/** 一段文字的查詢詞與它在全文裡的起點（`area.value` 的下標）。`query` 是空串時 `start` 就是游標。 */
export interface NameQuery {
  query: string;
  start: number;
}

/** 游標前那幾個名字裡會出現的字（至多 `max` 個，按碼位），碰到別的就停。 */
function charsBefore(text: string, caret: number, max: number): string[] {
  const out: string[] = [];
  let pos = Math.max(0, Math.min(caret, text.length));
  while (out.length < max && pos > 0) {
    let width = 1;
    const low = text.charCodeAt(pos - 1);
    if (low >= 0xdc00 && low <= 0xdfff && pos >= 2) {
      const high = text.charCodeAt(pos - 2);
      if (high >= 0xd800 && high <= 0xdbff) {
        width = 2;
      }
    }
    const ch = text.slice(pos - width, pos);
    if (!isNameChar(ch)) {
      break;
    }
    out.unshift(ch);
    pos -= width;
  }
  return out;
}

/**
 * 從游標往前取 1~{@link MAX_QUERY} 個字，挑能匹配上某個名字（或別名）開頭的最長那段；一段都匹配不上給空查詢。
 */
export function queryBefore(catalog: NameCatalog, text: string, caret: number): NameQuery {
  const at = Math.max(0, Math.min(caret, text.length));
  const chars = charsBefore(text, at, MAX_QUERY);
  for (let k = chars.length; k >= 1; k--) {
    const query = chars.slice(chars.length - k).join('');
    if (catalog.prefixes.has(query.toLowerCase())) {
      return { query, start: at - query.length };
    }
  }
  return { query: '', start: at };
}

/** `start` 到游標那一段還是不是一個查詢詞（全是名字裡的字）。手動彈出之後接著打字時用：碰到空白、標點就收起。 */
export function queryBetween(text: string, start: number, caret: number): string | undefined {
  if (caret < start || start < 0 || caret > text.length) {
    return undefined;
  }
  const query = text.slice(start, caret);
  for (const ch of query) {
    if (!isNameChar(ch)) {
      return undefined;
    }
  }
  return query;
}

// ---------------------------------------------------------------- 匹配與排序

/** 彈出框裡的一行。 */
export interface NameCandidate {
  item: NameItem;
  /** 顯示並插入的那個叫法：正名對得上就是正名，否則第一個對得上的別名。空查詢時是正名。 */
  form: string;
  viaAlias: boolean;
  /** `form` 裡要高亮的字（碼位下標）：查詢詞那幾個。 */
  hits: number[];
  /** 0：查詢詞之前出現過；1：只在游標後面出現過；2：都沒出現過。 */
  rank: number;
  /** 同一檔裡的遠近：越大越近。 */
  near: number;
}

export interface MatchOptions {
  /** 當前檔案的全部文字與查詢詞的起點、游標（算「最近出現」用）。 */
  text: string;
  start: number;
  caret: number;
  /** 最多列幾條（預設 {@link NAME_LIST_LIMIT}）。 */
  limit?: number;
  /**
   * 只要還沒打完的（邊打邊彈）：叫法比查詢詞長、剩下那截不在游標後面。正好是查詢詞的那個叫法不列，
   * 那一個名詞還有別的叫法對得上的照樣列。
   */
  unfinished?: boolean;
}

export interface MatchResult {
  items: NameCandidate[];
  /** 一共對上幾條（超過上限時比 `items` 多）。 */
  total: number;
}

/** 按開頭匹配、排序。空查詢列全部（手動按鍵時）。 */
export function matchNames(catalog: NameCatalog, query: string, opts: MatchOptions): MatchResult {
  const lower = query.toLowerCase();
  const qLen = Array.from(query).length;
  const after = opts.unfinished ? opts.text.slice(opts.caret, opts.caret + 64).toLowerCase() : '';
  const fits = (form: NameForm): boolean =>
    form.lower.startsWith(lower) &&
    (!opts.unfinished || (form.lower.length > lower.length && !after.startsWith(form.lower.slice(lower.length))));

  const found: NameCandidate[] = [];
  for (const item of catalog.items) {
    const form = item.forms.find(fits);
    if (form) {
      found.push({
        item,
        form: form.text,
        viaAlias: form.alias,
        hits: Array.from({ length: qLen }, (_, i) => i),
        rank: 2,
        near: 0,
      });
    }
  }

  // 「最近出現」：查詢詞開頭之前那一段（不含正在打的這幾個字）與游標之後那一段，各小寫一次。
  const before = opts.text.slice(Math.max(0, opts.start - RECENT_BEFORE), Math.max(0, opts.start)).toLowerCase();
  const later = opts.text.slice(opts.caret, opts.caret + RECENT_AFTER).toLowerCase();
  for (const c of found) {
    let last = -1;
    let first = Infinity;
    for (const form of c.item.forms) {
      last = Math.max(last, before.lastIndexOf(form.lower));
      const at = later.indexOf(form.lower);
      if (at >= 0) {
        first = Math.min(first, at);
      }
    }
    if (last >= 0) {
      c.rank = 0;
      c.near = last;
    } else if (first !== Infinity) {
      c.rank = 1;
      c.near = -first;
    }
  }

  found.sort(compareCandidates);
  const limit = Math.max(1, opts.limit ?? NAME_LIST_LIMIT);
  return { items: found.slice(0, limit), total: found.length };
}

function compareCandidates(a: NameCandidate, b: NameCandidate): number {
  return (
    a.rank - b.rank ||
    b.near - a.near ||
    SOURCE_ORDER[a.item.source] - SOURCE_ORDER[b.item.source] ||
    Number(a.viaAlias) - Number(b.viaAlias) ||
    Array.from(a.form).length - Array.from(b.form).length ||
    a.item.order - b.item.order
  );
}

// ---------------------------------------------------------------- 邊打邊彈

/** 內容變化那一下（`onEditorChange` 的 `edit`）裡判定要用的幾樣。 */
export interface AutoPopInput {
  /** `typing` / `composition` / `program` / …（`api.ts` 的 `EditSource`）。 */
  source: string;
  /** 這一處改動；組字中途沒有。 */
  change?: TextChange;
  /** 改動之後的全文與選區。 */
  text: string;
  selectionStart: number;
  selectionEnd: number;
  /** 輸入法正在組字。 */
  composing?: boolean;
}

/**
 * 游標前這幾個字該不該彈（不看是怎麼打出來的）：查詢詞至少 {@link AUTO_MIN_CHARS} 個字、不是哪個叫法的全稱、
 * 還有沒打完的叫法。該彈給查詢詞，不該彈給 undefined。邊打邊彈開著時，彈出框還開著、作者退格了也用它重判。
 */
export function autoQueryAt(catalog: NameCatalog, text: string, caret: number): NameQuery | undefined {
  const q = queryBefore(catalog, text, caret);
  if (Array.from(q.query).length < AUTO_MIN_CHARS || catalog.exact.has(q.query.toLowerCase())) {
    return undefined;
  }
  const open = matchNames(catalog, q.query, { text, start: q.start, caret, limit: 1, unfinished: true });
  return open.total > 0 ? q : undefined;
}

/**
 * 邊打邊彈：這一下改動之後要不要彈。只認打字與輸入法上屏（帶 `change`）、剛插入了字、游標就在插進來的字後面、
 * 沒有選區；組字中途、刪字、貼上、程式改寫、撤銷一律不彈。
 */
export function autoPopQuery(catalog: NameCatalog, ev: AutoPopInput): NameQuery | undefined {
  if (ev.composing || (ev.source !== 'typing' && ev.source !== 'composition')) {
    return undefined;
  }
  const c = ev.change;
  if (!c || c.inserted === '' || ev.selectionStart !== ev.selectionEnd || ev.selectionEnd !== c.at + c.inserted.length) {
    return undefined;
  }
  return autoQueryAt(catalog, ev.text, ev.selectionEnd);
}

// ---------------------------------------------------------------- 插入

/** 接受一條時換掉哪一段、換成什麼、游標落在哪。 */
export interface NameInsertion {
  start: number;
  end: number;
  text: string;
  caret: number;
}

/**
 * 換掉作者已經打的那幾個字（查詢詞，從 `start` 到游標；有選區時連選中的一起），補成整個叫法；游標落在名字後面。
 * 游標後面的字一個不動。
 */
export function insertionFor(start: number, selectionStart: number, selectionEnd: number, form: string): NameInsertion {
  const from = Math.min(start, selectionStart);
  const end = Math.max(selectionStart, selectionEnd);
  return { start: from, end, text: form, caret: from + form.length };
}

// ---------------------------------------------------------------- 名詞高亮

/** 名詞圖層上各來源的 class（顏色在 `css/standalone/names.css`）：角色、設定條目畫淡底色，未建條目畫虛下劃線。 */
export const NAME_MARK_CLASS: Readonly<Record<NameSource, string>> = {
  character: 'ed-hl-name-character',
  lore: 'ed-hl-name-lore',
  unfiled: 'ed-hl-name-unfiled',
};

/** 正文裡認名字用的那張表。表到了做一次，之後每次重算只查不建。 */
export interface NameMatcher {
  /** 要找的叫法（原樣，`locateTerms` 折大小寫去找）。 */
  terms: string[];
  /** 折過大小寫的叫法 → 哪一條（撞了的取表裡排前面的）。 */
  byForm: Map<string, NameItem>;
}

/** 一段名字。 */
export interface NameRange {
  start: number;
  end: number;
  cls: string;
  item: NameItem;
}

const LATIN_WORD = /[A-Za-z0-9\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A]/;

export function buildNameMatcher(catalog: NameCatalog): NameMatcher {
  const terms: string[] = [];
  const byForm = new Map<string, NameItem>();
  for (const item of catalog.items) {
    for (const form of item.forms) {
      const key = foldLatin(form.text);
      if (Array.from(key).length < 2 || byForm.has(key)) {
        continue;
      }
      byForm.set(key, item);
      terms.push(form.text);
    }
  }
  return { terms, byForm };
}

/** 這一段字是表裡哪一條的叫法（懸停時按映象層上那一段的字認回去）。 */
export function nameItemOf(matcher: NameMatcher, text: string): NameItem | undefined {
  return matcher.byForm.get(foldLatin(text));
}

/** 英文叫法前後挨著字母、數字就不是這個名字。 */
function wholeWord(text: string, start: number, end: number): boolean {
  if (LATIN_WORD.test(text[start]) && start > 0 && LATIN_WORD.test(text[start - 1])) {
    return false;
  }
  return !(LATIN_WORD.test(text[end - 1]) && end < text.length && LATIN_WORD.test(text[end]));
}

/**
 * 正文裡哪幾段是名字（見檔案頭「名詞高亮」）。`selfPath`：正在看的這份檔案——是某張卡或某個條目自己時，不標它自己。
 * 按位置排好、互不重疊。
 */
export function nameRanges(matcher: NameMatcher, text: string, selfPath?: string): NameRange[] {
  if (matcher.terms.length === 0 || !text) {
    return [];
  }
  const all: NameRange[] = [];
  for (const hit of locateTerms(text, matcher.terms, { foldCase: true })) {
    const item = matcher.byForm.get(foldLatin(hit.term));
    if (!item || (selfPath && item.path === selfPath)) {
      continue;
    }
    for (const at of hit.offsets) {
      const end = at + hit.term.length;
      if (wholeWord(text, at, end)) {
        all.push({ start: at, end, cls: NAME_MARK_CLASS[item.source], item });
      }
    }
  }
  all.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: NameRange[] = [];
  let edge = 0;
  for (const r of all) {
    if (r.start >= edge) {
      out.push(r);
      edge = r.end;
    }
  }
  return out;
}
