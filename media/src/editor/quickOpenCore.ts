/**
 * 「轉到…」（Ctrl+P）的匹配與排序。**純函式、零 DOM**：面板（`quickOpen.ts`）只管畫與按鍵，
 * 認章號、打分、挑前幾條、切高亮都在這裡，單測見 `tests/unit/editor/quickOpenCore.test.js`。
 *
 * ## 打分（高的排前面，同分按型別 → 章號 → 索引裡的先後）
 *
 * | 檔 | 分 | 說明 |
 * |---|---|---|
 * | 章號直接命中 | 1000 | `12`、`第12章`、`第 12 章`、`第十二章`、`十二`、`一百零五`、`１２`（全形數字）都認（{@link parseChapterNo}） |
 * | 章號字首 | 550–590 | 只打阿拉伯數字時，`12` 也列出第 120–129 章（邊打邊縮小） |
 * | 名字子串 | 340–500 | 標題 / 角色名 / 設定標題 / 檔名裡有這幾個字（連著）。開頭就是、整個就是的再高一點 |
 * | 別名子串 | 比名字低 5 | 角色別名 |
 * | 名字模糊 | 140–200 | 這幾個字按先後順序都在（中間可以隔著別的字），隔得越少越高 |
 * | 別名模糊 | 比名字低 5 | |
 * | 路徑子串 | 65–100 | 兜底：檔名、卷目錄（`第一卷`）、整個相對路徑 |
 * | 路徑模糊 | 10–60 | |
 *
 * 中文按字（按碼位切，不按 UTF-16）；英文不分大小寫；查詢裡的空白不算。
 *
 * ## 效能
 *
 * 索引到了先 {@link buildCatalog} 一次（小寫、按字切好），之後每打一個字只是對每一條跑一遍子串 / 模糊
 * （名字幾個字、路徑幾十個字）。挑前幾條用定長的有序陣列插入（{@link QUICK_OPEN_LIMIT} 條），不給幾百章整個排序；
 * 面板也只畫這幾條。
 */
import type { QuickOpenDocKey, QuickOpenIndex } from '../protocol';

/** 一次最多列幾條。 */
export const QUICK_OPEN_LIMIT = 50;
/** 空輸入時「最近開啟的」最多列幾條。 */
export const RECENT_SHOWN = 8;
/** 空輸入時在「最近開啟的」後面再列前幾章。 */
export const LEAD_CHAPTERS = 10;
/** localStorage 裡最多記幾條最近開啟的。 */
export const RECENT_KEPT = 20;

export type QuickOpenKind = 'chapter' | 'character' | 'lore' | 'doc' | 'draft';

/** 同分時的先後：章節、角色、設定、文件、草稿。 */
const KIND_ORDER: Record<QuickOpenKind, number> = { chapter: 0, character: 1, lore: 2, doc: 3, draft: 4 };

/**
 * 架構三件與情節大綱算「架構」（工程頁「故事架構」那一組），敘事線一條線一項、名字是線名，標「敘事線」，
 * 其餘幾份叫「文件」。
 */
const DOC_BADGE: Record<QuickOpenDocKey, string> = {
  config: '架構',
  premise: '架構',
  world: '架構',
  outline: '架構',
  style: '檔案',
  threads: '敘事線',
  globalSummary: '檔案',
};

/** 面板上的一條。 */
export interface QuickOpenEntry {
  /** 身份：章節是 `chapter:<章號>`，其餘是 `file:<路徑>`。最近開啟的去重認它。 */
  key: string;
  kind: QuickOpenKind;
  /** 型別標記（「章」「角色」「設定」「架構」「文件」「草稿」）。 */
  badge: string;
  /** 主名稱：章節是標題（沒有標題時「第 N 章」），角色是名字，其餘是標題 / 檔名。 */
  name: string;
  /** 一行小字：「第 12 章 · 第一卷 · 3200 字」/「別名 阿昭 / 小林」/ 路徑。 */
  detail: string;
  /** 開啟的那個檔案：章節是正文（沒有正文時是細綱）。 */
  path: string;
  /** 認得出這一條的全部路徑（章節：正文與細綱），「最近開啟的」按它認、路徑兜底按它配。 */
  paths: string[];
  no?: number;
  chapterPath?: string;
  plotPath?: string;
  aliases: string[];
  /** `detail` 裡每個別名的起點（別名命中時在小字裡高亮）。 */
  aliasAt: number[];
  /** 「第 N 章」在 `detail` 裡的長度（章號命中時高亮它；它總在開頭）。 */
  noLabelLength: number;
  /** 在索引裡的先後（同分時最後一道比較）。 */
  order: number;
  /** 搜尋用：小寫、按碼位切好。章節的 `name` 只放標題（回落的「第 N 章」不參與名字匹配，章號另認）。 */
  search: { name: string[]; aliases: string[][]; paths: string[][] };
}

/** 一份索引切好之後的樣子。 */
export interface QuickOpenCatalog {
  entries: QuickOpenEntry[];
  /** 路徑 → 那一條（章節的正文與細綱都指向同一章）。 */
  byPath: Map<string, QuickOpenEntry>;
  initialized: boolean;
}

/** 一條結果。 */
export interface QuickOpenHit {
  entry: QuickOpenEntry;
  score: number;
  /** 主名稱裡要高亮的字（碼位下標）。 */
  nameHits: number[];
  /** 這一條顯示的小字：一般是 `entry.detail`，按路徑命中時換成命中的那個路徑（讓人看得出為什麼列出來）。 */
  detail: string;
  /** 小字裡要高亮的字（碼位下標）。 */
  detailHits: number[];
  /** 空輸入時分的組。 */
  group?: 'recent' | 'chapters';
}

export interface QuickOpenResult {
  hits: QuickOpenHit[];
  /** 一共命中幾條（超過上限時比 `hits` 多）。 */
  total: number;
}

// ---------------------------------------------------------------- 索引 → 條目

const chars = (text: string): string[] => Array.from(text.toLowerCase());

/** 把後端給的索引切成面板上的條目。索引到了做一次，之後每打一個字只搜不切。 */
export function buildCatalog(index: QuickOpenIndex): QuickOpenCatalog {
  const entries: QuickOpenEntry[] = [];
  const add = (e: Omit<QuickOpenEntry, 'order' | 'search' | 'aliasAt' | 'noLabelLength' | 'aliases'> & {
    aliases?: string[];
    searchName?: string;
    aliasAt?: number[];
    noLabelLength?: number;
  }): void => {
    const aliases = e.aliases ?? [];
    entries.push({
      key: e.key,
      kind: e.kind,
      badge: e.badge,
      name: e.name,
      detail: e.detail,
      path: e.path,
      paths: e.paths,
      ...(e.no !== undefined ? { no: e.no } : {}),
      ...(e.chapterPath ? { chapterPath: e.chapterPath } : {}),
      ...(e.plotPath ? { plotPath: e.plotPath } : {}),
      aliases,
      aliasAt: e.aliasAt ?? [],
      noLabelLength: e.noLabelLength ?? 0,
      order: entries.length,
      search: {
        name: chars(e.searchName ?? e.name),
        aliases: aliases.map(chars),
        paths: e.paths.map(chars),
      },
    });
  };

  for (const ch of index.chapters ?? []) {
    const path = ch.chapterPath || ch.plotPath;
    if (!path) {
      continue;
    }
    const noLabel = `第 ${ch.no} 章`;
    const state = ch.chapterPath ? `${ch.words} 字` : '只有細綱';
    add({
      key: `chapter:${ch.no}`,
      kind: 'chapter',
      badge: '章',
      name: ch.title || noLabel,
      searchName: ch.title,
      detail: [noLabel, ch.volume, state].filter(Boolean).join(' · '),
      noLabelLength: Array.from(noLabel).length,
      path,
      paths: [ch.chapterPath, ch.plotPath].filter((p): p is string => !!p),
      no: ch.no,
      chapterPath: ch.chapterPath,
      plotPath: ch.plotPath,
    });
  }
  for (const c of index.characters ?? []) {
    const aliases = (c.aliases ?? []).filter((a) => a.trim() !== '');
    let detail = c.path;
    const aliasAt: number[] = [];
    if (aliases.length > 0) {
      detail = '別名 ';
      aliases.forEach((a, i) => {
        if (i > 0) {
          detail += ' / ';
        }
        aliasAt.push(Array.from(detail).length);
        detail += a;
      });
    }
    add({ key: `file:${c.path}`, kind: 'character', badge: '角色', name: c.name, detail, path: c.path, paths: [c.path], aliases, aliasAt });
  }
  for (const l of index.lore ?? []) {
    add({ key: `file:${l.path}`, kind: 'lore', badge: '設定', name: l.title, detail: l.path, path: l.path, paths: [l.path] });
  }
  for (const d of index.docs ?? []) {
    add({ key: `file:${d.path}`, kind: 'doc', badge: DOC_BADGE[d.key] ?? '檔案', name: d.label, detail: d.path, path: d.path, paths: [d.path] });
  }
  for (const d of index.drafts ?? []) {
    add({ key: `file:${d.path}`, kind: 'draft', badge: '草稿', name: d.name, detail: d.path, path: d.path, paths: [d.path] });
  }

  const byPath = new Map<string, QuickOpenEntry>();
  for (const entry of entries) {
    for (const p of entry.paths) {
      if (!byPath.has(p)) {
        byPath.set(p, entry);
      }
    }
  }
  return { entries, byPath, initialized: index.initialized !== false };
}

// ---------------------------------------------------------------- 章號

const CN_DIGIT: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 贰: 2, 貳: 2, 两: 2, 兩: 2, 三: 3, 叁: 3, 叄: 3, 四: 4, 肆: 4,
  五: 5, 伍: 5, 六: 6, 陆: 6, 陸: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9,
};
const CN_UNIT: Record<string, number> = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000 };
const CN_NUMERAL = /^[零〇一壹二贰两三叁四肆五伍六陆七柒八捌九玖十拾百佰千仟万貳兩叄陸萬]+$/;

/**
 * 中文數字 → 數。認「十二」「二十」「一百零五」「一百一十二」「兩百」「一千零一」「三萬」這類常見寫法，
 * 也認逐位寫的「一〇五」「一二三」。認不出給 undefined。
 */
export function parseChineseNumber(text: string): number | undefined {
  if (!text || !CN_NUMERAL.test(text)) {
    return undefined;
  }
  const units = [...text].filter((c) => c in CN_UNIT || (c === '万' || c === '萬'));
  if (units.length === 0) {
    // 逐位寫：一〇五 = 105。只有一個字就是那個數。
    return Number([...text].map((c) => CN_DIGIT[c]).join(''));
  }
  let total = 0;
  let section = 0;
  let digit: number | undefined;
  for (const c of text) {
    if (c in CN_DIGIT) {
      digit = CN_DIGIT[c];
    } else if (c in CN_UNIT) {
      // 「十二」的十前面沒有數：當一。
      section += (digit ?? 1) * CN_UNIT[c];
      digit = undefined;
    } else {
      // 萬
      section += digit ?? 0;
      total += (section || 1) * 10000;
      section = 0;
      digit = undefined;
    }
  }
  return total + section + (digit ?? 0);
}

/**
 * 查詢是不是在找第幾章：`12`、`012`、`第12章`、`第 12 章`、`12章`、`第十二章`、`十二`、`第一百零五回`、全形的 `１２`。
 * 不是就給 undefined（`第一卷`、`12a`、`三叔` 都不是）。
 */
export function parseChapterNo(query: string): number | undefined {
  const q = query
    .replace(/\s+/g, '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const m = /^第?([0-9]+|[零〇一壹二贰两三叁四肆五伍六陆七柒八捌九玖十拾百佰千仟万貳兩叄陸萬]+)[章回节節]?$/.exec(q);
  if (!m) {
    return undefined;
  }
  const n = /^[0-9]+$/.test(m[1]) ? Number(m[1]) : parseChineseNumber(m[1]);
  return n !== undefined && Number.isSafeInteger(n) ? n : undefined;
}

// ---------------------------------------------------------------- 文字匹配

interface CharMatch {
  /** 連著的子串（true）還是按先後順序的模糊（false）。 */
  sub: boolean;
  /** 第一個字的位置。 */
  first: number;
  /** 模糊匹配時中間隔了幾個字（子串是 0）。 */
  gaps: number;
  hits: number[];
}

/** `q` 在 `text` 裡：先找連著的子串，找不到再按先後順序找每一個字。都是碼位陣列、已經小寫。 */
export function matchChars(text: readonly string[], q: readonly string[]): CharMatch | undefined {
  if (q.length === 0 || q.length > text.length) {
    return undefined;
  }
  outer: for (let i = 0; i + q.length <= text.length; i++) {
    for (let j = 0; j < q.length; j++) {
      if (text[i + j] !== q[j]) {
        continue outer;
      }
    }
    return { sub: true, first: i, gaps: 0, hits: q.map((_, j) => i + j) };
  }
  const hits: number[] = [];
  let at = 0;
  for (const c of q) {
    while (at < text.length && text[at] !== c) {
      at++;
    }
    if (at >= text.length) {
      return undefined;
    }
    hits.push(at++);
  }
  return { sub: false, first: hits[0], gaps: hits[hits.length - 1] - hits[0] + 1 - hits.length, hits };
}

/** 名字（標題、角色名、別名、檔名）這一檔的分。 */
function nameScore(m: CharMatch, textLength: number, qLength: number): number {
  if (m.sub) {
    return 400 + (m.first === 0 ? 50 : 0) + (textLength === qLength ? 50 : 0) - Math.min(m.first, 40) - Math.min(textLength - qLength, 40) * 0.5;
  }
  return 200 - Math.min(m.gaps, 40) - Math.min(m.first, 40) * 0.5;
}

/** 路徑兜底這一檔的分。命中落在檔名裡（最後一個 `/` 之後）的高一點。 */
function pathScore(m: CharMatch, text: readonly string[], qLength: number): number {
  const base = text.lastIndexOf('/') + 1;
  if (m.sub) {
    return 100 - (m.first >= base ? 0 : 10) - Math.min(text.length - qLength, 100) * 0.25;
  }
  return 60 - Math.min(m.gaps, 40) - Math.min(m.first, 40) * 0.25 - (m.first >= base ? 0 : 5);
}

/** 一條在這個查詢下的得分與高亮；不命中給 undefined。 */
function scoreEntry(entry: QuickOpenEntry, q: string[], no: number | undefined, digits: string | undefined): QuickOpenHit | undefined {
  let best: QuickOpenHit | undefined;
  const offer = (hit: QuickOpenHit): void => {
    if (!best || hit.score > best.score) {
      best = hit;
    }
  };
  const noHits = (): number[] => Array.from({ length: entry.noLabelLength }, (_, i) => i);

  if (entry.kind === 'chapter' && entry.no !== undefined) {
    if (no !== undefined && entry.no === no) {
      offer({ entry, score: 1000, nameHits: [], detail: entry.detail, detailHits: noHits() });
    } else if (digits !== undefined) {
      const s = String(entry.no);
      if (s.length > digits.length && s.startsWith(digits)) {
        offer({ entry, score: 600 - Math.min(s.length - digits.length, 5) * 10, nameHits: [], detail: entry.detail, detailHits: noHits() });
      }
    }
  }

  const name = matchChars(entry.search.name, q);
  if (name) {
    offer({ entry, score: nameScore(name, entry.search.name.length, q.length), nameHits: name.hits, detail: entry.detail, detailHits: [] });
  }
  entry.search.aliases.forEach((alias, i) => {
    const m = matchChars(alias, q);
    if (m) {
      const at = entry.aliasAt[i] ?? 0;
      offer({
        entry,
        score: nameScore(m, alias.length, q.length) - 5,
        nameHits: [],
        detail: entry.detail,
        detailHits: m.hits.map((h) => h + at),
      });
    }
  });
  // 名字與別名已經命中了就不必再看路徑：路徑那一檔的分高不過它們。
  if (!best || best.score < 100) {
    entry.search.paths.forEach((p, i) => {
      const m = matchChars(p, q);
      if (m) {
        offer({ entry, score: pathScore(m, p, q.length), nameHits: [], detail: entry.paths[i], detailHits: m.hits });
      }
    });
  }
  return best;
}

/** a 排在 b 前面時為負。 */
function compareHits(a: QuickOpenHit, b: QuickOpenHit): number {
  return (
    b.score - a.score ||
    KIND_ORDER[a.entry.kind] - KIND_ORDER[b.entry.kind] ||
    (a.entry.no ?? 0) - (b.entry.no ?? 0) ||
    a.entry.order - b.entry.order
  );
}

/** 往定長的有序陣列裡插一條（超出上限的那條擠掉）。 */
function insertTop(top: QuickOpenHit[], hit: QuickOpenHit, limit: number): void {
  if (top.length >= limit && compareHits(hit, top[top.length - 1]) >= 0) {
    return;
  }
  let lo = 0;
  let hi = top.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareHits(top[mid], hit) <= 0) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  top.splice(lo, 0, hit);
  if (top.length > limit) {
    top.pop();
  }
}

export interface SearchOptions {
  /** 最多列幾條（預設 {@link QUICK_OPEN_LIMIT}）。 */
  limit?: number;
  /** 最近開啟過的路徑，新的在前（空輸入時用）。 */
  recent?: readonly string[];
  /** 空輸入時最近開啟的最多列幾條（預設 {@link RECENT_SHOWN}）。 */
  recentShown?: number;
  /** 空輸入時再列前幾章（預設 {@link LEAD_CHAPTERS}）。 */
  leadChapters?: number;
}

/**
 * 搜一次。空輸入時列「最近開啟的」（按路徑認回條目，認不出的——刪了、不在索引裡——跳過，同一章的正文與
 * 細綱只算一條），後面接前幾章。
 */
export function searchQuickOpen(catalog: QuickOpenCatalog, query: string, opts: SearchOptions = {}): QuickOpenResult {
  const limit = Math.max(1, opts.limit ?? QUICK_OPEN_LIMIT);
  const q = chars(query.replace(/\s+/g, ''));
  if (q.length === 0) {
    return emptyQuery(catalog, opts, limit);
  }
  const no = parseChapterNo(query);
  const digits = /^[0-9]+$/.test(q.join('')) ? String(Number(q.join(''))) : undefined;
  const top: QuickOpenHit[] = [];
  let total = 0;
  for (const entry of catalog.entries) {
    const hit = scoreEntry(entry, q, no, digits);
    if (hit) {
      total++;
      insertTop(top, hit, limit);
    }
  }
  return { hits: top, total };
}

function emptyQuery(catalog: QuickOpenCatalog, opts: SearchOptions, limit: number): QuickOpenResult {
  const hits: QuickOpenHit[] = [];
  const seen = new Set<string>();
  const recentShown = opts.recentShown ?? RECENT_SHOWN;
  for (const path of opts.recent ?? []) {
    if (hits.length >= Math.min(recentShown, limit)) {
      break;
    }
    const entry = catalog.byPath.get(path);
    if (entry && !seen.has(entry.key)) {
      seen.add(entry.key);
      hits.push({ entry, score: 0, nameHits: [], detail: entry.detail, detailHits: [], group: 'recent' });
    }
  }
  let lead = opts.leadChapters ?? LEAD_CHAPTERS;
  for (const entry of catalog.entries) {
    if (lead <= 0 || hits.length >= limit) {
      break;
    }
    if (entry.kind === 'chapter' && !seen.has(entry.key)) {
      seen.add(entry.key);
      hits.push({ entry, score: 0, nameHits: [], detail: entry.detail, detailHits: [], group: 'chapters' });
      lead--;
    }
  }
  return { hits, total: hits.length };
}

// ---------------------------------------------------------------- 最近開啟的 / 高亮

/** 把剛開啟的路徑記到最前面（去重、只留 {@link RECENT_KEPT} 條）。 */
export function pushRecent(list: readonly string[], path: string, max = RECENT_KEPT): string[] {
  return [path, ...list.filter((p) => p !== path)].slice(0, max);
}

/** 按高亮的下標（碼位）把一段字切成幾截，連著的高亮併成一截。 */
export function highlightSegments(text: string, hits: readonly number[]): { text: string; hit: boolean }[] {
  const set = new Set(hits);
  const out: { text: string; hit: boolean }[] = [];
  Array.from(text).forEach((c, i) => {
    const hit = set.has(i);
    const last = out[out.length - 1];
    if (last && last.hit === hit) {
      last.text += c;
    } else {
      out.push({ text: c, hit });
    }
  });
  return out;
}
