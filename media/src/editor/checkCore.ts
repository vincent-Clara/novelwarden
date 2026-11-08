/**
 * 寫作體檢的口徑（獨立版內建編輯器，`check.ts` 裝配）。**純函式、零 DOM**，`tests/unit/editor/checkCore.test.js` 釘著。
 *
 * 四類，都只在正文（章節與草稿）上查：
 *
 * | 類別 | 詞從哪來 | 怎麼找 | 算幾個問題 |
 * |---|---|---|---|
 * | 禁用詞 | 後端推來的 `banned`（`style.md` 禁用詞表 + 全域要求裡禁止的詞 + 古代題材的現代說法） | `locateTerms`，**區分大小寫**——與寫完一章之後的 `countBanned` 同一個函式 | 每一處算一個 |
 * | 敏感詞 | 後端推來的 `sensitive`（`.novelwarden/sensitive.txt`） | `locateTerms` 的 `foldCase`：英文不分大小寫、全形當半形 | 每一處算一個 |
 * | 比喻詞 | `SIMILE_WORDS`（與生成鏈同一張表） | `locateTerms`（`countSimiles` 也建在它上面） | **全章超過 `SIMILE_LIMIT` 才算**，算超出的那幾個；沒超不高亮 |
 * | 英文縮寫 | 正文字身 | `latinAcronymRanges`（`latinAcronyms` 建在它上面） | 每一處算一個 |
 *
 * 同一段字可以同時落在幾類裡（禁用詞「能量」也寫進了敏感詞表），各算各的、各畫各的樣子；同一個詞出現幾次就有幾處。
 * 找位置的函式都在 core 的 `model/manuscriptCheck.ts`，這裡只按類別收攏、排順序、算替換。
 */
import { SIMILE_LIMIT, SIMILE_WORDS, latinAcronymRanges, locateTerms } from '../protocol';
import type { CheckSensitiveTerm } from '../protocol';
import type { TextChange } from './history';

export type CheckCategory = 'sensitive' | 'banned' | 'simile' | 'acronym';

/** 面板裡從上到下的順序：敏感詞（發不出去）→ 禁用詞 → 比喻詞 → 英文縮寫（只是提示）。 */
export const CHECK_CATEGORIES: readonly CheckCategory[] = ['sensitive', 'banned', 'simile', 'acronym'];

export const CHECK_LABEL: Record<CheckCategory, string> = {
  sensitive: '敏感詞',
  banned: '禁用詞',
  simile: '比喻詞',
  acronym: '英文縮寫',
};

/** 高亮映象層上各類的 class（顏色在 `css/standalone/check.css`）。 */
export const CHECK_CLASS: Record<CheckCategory, string> = {
  sensitive: 'ed-hl-chk-sensitive',
  banned: 'ed-hl-chk-banned',
  simile: 'ed-hl-chk-simile',
  acronym: 'ed-hl-chk-acronym',
};

/** 後端推來的那兩份詞（`checkTerms`）。 */
export interface CheckVocab {
  banned: readonly string[];
  sensitive: readonly CheckSensitiveTerm[];
}

export const EMPTY_VOCAB: CheckVocab = Object.freeze({ banned: [], sensitive: [] });

/** 一個詞在這一份正文裡的全部位置。 */
export interface CheckEntry {
  category: CheckCategory;
  /** 詞表裡的寫法（縮寫是折成半形的寫法）。 */
  term: string;
  /** 每一處的起點（`area.value` 的下標），升序。 */
  offsets: number[];
  /** 每一處多長（UTF-16 下標）。折大小寫一個字換一個字，所以各處一樣長。 */
  length: number;
  /** 敏感詞表裡寫了的替換詞。 */
  replacement?: string;
}

export interface CheckResult {
  /** 有命中的詞，按 {@link CHECK_CATEGORIES} 的類別順序，同一類裡次數多的在前、一樣多的按先出現的。 */
  entries: CheckEntry[];
  /** 比喻詞全章合計幾次、上限、超出幾次（沒超是 0）。 */
  similes: { total: number; limit: number; over: number };
  /** 每一類算幾個問題（比喻詞算超出的那幾個）。 */
  counts: Record<CheckCategory, number>;
  /** 一共幾個問題（狀態列「體檢 N」的 N）。 */
  total: number;
}

/** 按類別收攏、排順序。 */
function sortEntries(list: CheckEntry[]): CheckEntry[] {
  return list.sort(
    (a, b) =>
      CHECK_CATEGORIES.indexOf(a.category) - CHECK_CATEGORIES.indexOf(b.category) ||
      b.offsets.length - a.offsets.length ||
      a.offsets[0] - b.offsets[0]
  );
}

/** 體檢一份正文。 */
export function runCheck(text: string, vocab: CheckVocab = EMPTY_VOCAB): CheckResult {
  const entries: CheckEntry[] = [];
  const counts: Record<CheckCategory, number> = { sensitive: 0, banned: 0, simile: 0, acronym: 0 };

  const sensitive = vocab.sensitive ?? [];
  locateTerms(
    text,
    sensitive.map((s) => s.term),
    { foldCase: true }
  ).forEach((hit, i) => {
    if (hit.offsets.length > 0) {
      const replacement = sensitive[i].replacement;
      entries.push({
        category: 'sensitive',
        term: hit.term,
        offsets: hit.offsets,
        length: hit.term.length,
        ...(replacement ? { replacement } : {}),
      });
      counts.sensitive += hit.offsets.length;
    }
  });

  for (const hit of locateTerms(text, vocab.banned ?? [])) {
    if (hit.offsets.length > 0) {
      entries.push({ category: 'banned', term: hit.term, offsets: hit.offsets, length: hit.term.length });
      counts.banned += hit.offsets.length;
    }
  }

  const simileHits = locateTerms(text, SIMILE_WORDS).filter((h) => h.offsets.length > 0);
  const total = simileHits.reduce((n, h) => n + h.offsets.length, 0);
  const over = Math.max(0, total - SIMILE_LIMIT);
  if (over > 0) {
    for (const hit of simileHits) {
      entries.push({ category: 'simile', term: hit.term, offsets: hit.offsets, length: hit.term.length });
    }
    counts.simile = over;
  }

  const acronyms = new Map<string, CheckEntry>();
  for (const r of latinAcronymRanges(text)) {
    const known = acronyms.get(r.term);
    if (known) {
      known.offsets.push(r.start);
    } else {
      const entry: CheckEntry = { category: 'acronym', term: r.term, offsets: [r.start], length: r.end - r.start };
      acronyms.set(r.term, entry);
      entries.push(entry);
    }
    counts.acronym++;
  }

  return {
    entries: sortEntries(entries),
    similes: { total, limit: SIMILE_LIMIT, over },
    counts,
    total: counts.sensitive + counts.banned + counts.simile + counts.acronym,
  };
}

/** 一段要塗色的字（與 `highlight.ts` 的 `HighlightRange` 同一個形狀）。 */
export interface CheckRange {
  start: number;
  end: number;
  cls: string;
}

/** 畫到高亮映象層 `check` 圖層上的那幾段，按起點排。比喻詞沒超上限時 `runCheck` 根本不給它們。 */
export function checkRanges(result: CheckResult): CheckRange[] {
  const out: CheckRange[] = [];
  for (const e of result.entries) {
    for (const at of e.offsets) {
      out.push({ start: at, end: at + e.length, cls: CHECK_CLASS[e.category] });
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end || (a.cls < b.cls ? -1 : a.cls > b.cls ? 1 : 0));
}

/** 兩份範圍是不是一模一樣（一樣就不必再畫一遍）。 */
export function sameRanges(a: readonly CheckRange[], b: readonly CheckRange[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i].start !== b[i].start || a[i].end !== b[i].end || a[i].cls !== b[i].cls) {
      return false;
    }
  }
  return true;
}

/**
 * 一處改動之後各段跟著平移；壓在改動上的那幾段丟掉。**與 `highlight.ts` 平移圖層是同一條規則**——
 * 編輯器記著「映象層上此刻畫的是哪幾段」，與它對得上才知道要不要再畫一遍。
 */
export function shiftRanges(ranges: readonly CheckRange[], change: TextChange): CheckRange[] {
  const removedEnd = change.at + change.removed.length;
  const delta = change.inserted.length - change.removed.length;
  const out: CheckRange[] = [];
  for (const r of ranges) {
    if (r.end <= change.at) {
      out.push(r);
    } else if (r.start >= removedEnd) {
      out.push({ start: r.start + delta, end: r.end + delta, cls: r.cls });
    }
  }
  return out;
}

/**
 * 兩份文字差在哪一段（公共字首與字尾之外的那一段）。撤銷 / 重做、輸入法組字中途這些不帶改動的變化，靠它把已經
 * 畫著的那幾段挪到新位置——不重找，也不亂跳。一樣時 undefined。
 */
export function diffChange(before: string, after: string): TextChange | undefined {
  if (before === after) {
    return undefined;
  }
  const max = Math.min(before.length, after.length);
  let head = 0;
  while (head < max && before.charCodeAt(head) === after.charCodeAt(head)) {
    head++;
  }
  let tail = 0;
  while (
    tail < max - head &&
    before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)
  ) {
    tail++;
  }
  return { at: head, removed: before.slice(head, before.length - tail), inserted: after.slice(head, after.length - tail) };
}

/** 選區正好是這個詞的第幾處；不是任何一處時 -1。 */
export function occurrenceAt(entry: Pick<CheckEntry, 'offsets' | 'length'>, start: number, end: number): number {
  return end - start === entry.length ? entry.offsets.indexOf(start) : -1;
}

/**
 * 點一下這個詞要跳到第幾處：選區正好是第 k 處就跳到第 k+1 處；否則跳到游標之後（含游標處）的第一處；到底了繞回第一處。
 * 一處都沒有時 -1。
 */
export function nextOccurrence(entry: Pick<CheckEntry, 'offsets' | 'length'>, start: number, end: number): number {
  const n = entry.offsets.length;
  if (n === 0) {
    return -1;
  }
  const at = occurrenceAt(entry, start, end);
  if (at >= 0) {
    return (at + 1) % n;
  }
  const i = entry.offsets.findIndex((o) => o >= start);
  return i >= 0 ? i : 0;
}

/** 本檔案全部替換要改的那一段：從第一處到最後一處（編輯器拿它調一次 `applyEdit`，只記一步撤銷）。 */
export interface CheckReplaceEdit {
  start: number;
  end: number;
  text: string;
  count: number;
}

/**
 * 把這個詞的每一處都換成 `replacement`，算出「第一處到最後一處那一段」的新文字——與查詢替換的「全部替換」
 * （`findCore.replaceAllIn`）同一個形狀、同一條路（一次 `applyEdit`）。位置用體檢找出來的那幾處，高亮在哪就換哪。
 */
export function replaceAllEdit(
  text: string,
  entry: Pick<CheckEntry, 'offsets' | 'length'>,
  replacement: string
): CheckReplaceEdit | undefined {
  const offsets = [...entry.offsets].sort((a, b) => a - b);
  if (offsets.length === 0) {
    return undefined;
  }
  const parts: string[] = [];
  let last = offsets[0];
  for (const at of offsets) {
    if (at < last) {
      continue; // 疊在上一處裡面的（同一個詞不會，防一手壞資料）。
    }
    parts.push(text.slice(last, at), replacement);
    last = at + entry.length;
  }
  return { start: offsets[0], end: last, text: parts.join(''), count: parts.length / 2 };
}

/** 「體檢 3」那一格的懸停提示裡那一句：各類幾個。 */
export function describeCounts(result: CheckResult): string {
  const parts: string[] = [];
  for (const c of CHECK_CATEGORIES) {
    const n = result.counts[c];
    if (n > 0) {
      parts.push(c === 'simile' ? `比喻詞超出 ${n} 個` : `${CHECK_LABEL[c]} ${n} 處`);
    }
  }
  return parts.join(' · ');
}
