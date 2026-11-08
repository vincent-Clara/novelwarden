import { traditionalLabel } from './labels';
/**
 * 全書查詢替換在**一份檔案**上的那幾件事：哪些字不搜不換（機器記的賬、解析器認的結構）、找出這份檔案裡的每一處、
 * 每一處那一行的上下文、預覽時每一處換成什麼。純函式、零 I/O——讀盤與按範圍列檔案在 `views/bookFind.ts`，
 * 寫盤在 `features/bookReplace.ts`。匹配口徑本身是 `textFind.ts`（與內建編輯器的查詢條同一份）。
 *
 * ## 哪些字不搜不換（⚑）
 *
 * 全書替換一次能改幾百份檔案，作者在預覽裡不可能逐行看清每一處落在哪。下面這幾樣**被換掉就會安靜地壞掉工程**，
 * 所以壓在它們上面的匹配一律不列、不換（單份檔案的查詢條照舊找得到，那是作者自己一處一處看著改）：
 *
 * 1. **frontmatter 裡除了「人寫的值」以外的一切**：`---` 兩條圍欄、每一行的鍵名，以及機器記的賬——指紋
 *    （`upstreamHash` / `writtenFrom` / `sourceHash` / `stateHash` / `bodyHash`，第 18 條的指紋鏈就記在這裡）、
 *    章號與字數（`no` / `targetWords` / `totalChapters` / `wordsPerChapter`）、水位與出場（`through` /
 *    `updatedThrough` / `stateThrough` / `firstAppear` / `lastSeen` / `appearsIn`）、狀態位（`status` /
 *    `factCheckOk` / `paragraphStyle` / `generatedBy`）。搜一個「3」換成「三」，不該順手把 `sourceHash` 裡的 3
 *    也換掉、讓幾百章悄悄退回待定稿。**名字、別名、標題、出場（`cast`）、關鍵詞、一句話這些人寫的值照常搜、照常換**——
 *    「把林晚全書改成林婉」要連角色卡的 `name`、細綱的 `cast` 一起改才改得乾淨。
 * 2. **解析器認的小節標題**：細綱的七節與「設定」一節、角色卡的七節、設定條目的三節與「暗設」（以它開頭的標題都算）、
 *    架構三件的各節、文風指南的「禁用詞表」——`## 關鍵事件` 被換成 `## 關鍵事情`，這一節就讀不出來了，
 *    那一章從「排過細綱」退回「待寫細綱」。
 *    標題行整行不搜。（情節大綱沒有檔案，是各章細綱梗概的彙總，搜細綱就搜到了。）
 *
 * 正文、草稿是作者的檔案，一個字都不護。
 */
import { CONFIG_SECTION_KEYS, PREMISE_SECTION_KEYS, WORLD_SECTION_KEYS } from './settingFile';
import { CHARACTER_SECTION_KEYS } from './types';
import { LORE_BODY_KEYS, LORE_HIDDEN_KEY, PLOT_LORE_KEY } from './loreFile';
import { PLOT_SECTION_KEYS } from './plotFile';
import { BOOK_FIND_CONTEXT } from './bookFindScope';
import { FindMatch, FindOptions, compileSearch, expandReplacement, findMatches } from './textFind';

/**
 * frontmatter 裡機器記的賬：這些鍵的值不搜不換（見檔案頭第 1 條）。別的鍵（`name` / `aliases` / `title` /
 * `cast` / `keywords` / `brief` / `tags` / `gender` / `genre` / `preflightOk`……，以及作者自己加的鍵）是人寫的值。
 */
export const MACHINE_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
  // 指紋（第 18 條）
  'upstreamHash',
  'writtenFrom',
  'sourceHash',
  'stateHash',
  'bodyHash',
  // 章號、字數、水位、出場
  'no',
  'targetWords',
  'totalChapters',
  'wordsPerChapter',
  'through',
  'updatedThrough',
  'stateThrough',
  'firstAppear',
  'lastSeen',
  'appearsIn',
  // 狀態位
  'status',
  'factCheckOk',
  'paragraphStyle',
  'generatedBy',
]);

/** 各種檔案裡解析器認的小節標題（見檔案頭第 2 條）。鍵是 `workspace/kind.ts` 的種類名。 */
const STRUCTURAL_HEADINGS: Record<string, readonly string[]> = {
  plot: [...PLOT_SECTION_KEYS, PLOT_LORE_KEY],
  character: CHARACTER_SECTION_KEYS,
  lore: LORE_BODY_KEYS,
  setting: [...CONFIG_SECTION_KEYS, ...PREMISE_SECTION_KEYS, ...WORLD_SECTION_KEYS],
  style: ['禁用词表'],
};

/**
 * 以它開頭就算的小節標題：設定條目的「暗設」（完善設定，2026-10-19）。`## 暗設（未揭示）` 也認
 * （與 loreFile.ts 的 `splitLoreHidden` 同一個認法）——「暗設」兩個字被換掉，這一節就成了明面，寫正文時也帶進去。
 */
const STRUCTURAL_PREFIXES: Record<string, readonly string[]> = {
  lore: [LORE_HIDDEN_KEY],
};

/** 正文與草稿：作者的檔案，一個字都不護。 */
const PROSE_KINDS: ReadonlySet<string> = new Set(['chapter', 'draft']);

/** 與 `model/markdown.ts` 的 `FM_FENCE` 同一個認法（那邊認得出的 frontmatter，這裡才護）。 */
const FM_FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** 與 `markdown.ts` 的 `pickSections` 同一個歸一（忽略空白與常見標點），小節標題才認得一樣。 */
function normalizeKey(s: string): string {
  return traditionalLabel(s.replace(/[\s·・、,，.。:：/-]/g, '').toLowerCase());
}

interface Span {
  start: number;
  end: number;
}

/**
 * 這份檔案裡哪些字不搜不換：`fence` 是整段 frontmatter（含兩條圍欄），`open` 是其中人寫的值（可以搜）；
 * `blocked` 是 frontmatter 之外護住的幾段（小節標題行、大綱章標題的那一截）。
 */
export interface Protection {
  fence?: Span;
  open: Span[];
  blocked: Span[];
}

/** 這一份檔案（`kind` 是 `workspace/kind.ts` 的種類名）裡哪些字不搜不換。絕不拋。 */
export function protectionOf(text: string, kind: string): Protection {
  const out: Protection = { open: [], blocked: [] };
  if (PROSE_KINDS.has(kind)) {
    return out;
  }
  const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const fm = FM_FENCE.exec(text.slice(bom));
  let bodyStart = 0;
  if (fm) {
    out.fence = { start: bom, end: bom + fm[0].length };
    bodyStart = out.fence.end;
    const innerStart = bom + (fm[0].startsWith('---\r\n') ? 5 : 4);
    out.open = openValues(fm[1], innerStart);
  }
  const headings = STRUCTURAL_HEADINGS[kind];
  const keys = headings ? new Set(headings.map(normalizeKey)) : undefined;
  const prefixes = (STRUCTURAL_PREFIXES[kind] ?? []).map(normalizeKey);
  if (!keys) {
    return out;
  }
  for (const line of linesFrom(text, bodyStart)) {
    const heading = /^#{2,3}\s+(.+?)\s*$/.exec(line.text);
    const key = heading ? normalizeKey(heading[1].replace(/[:：]\s*$/, '')) : '';
    if (heading && (keys.has(key) || prefixes.some((p) => key.startsWith(p)))) {
      out.blocked.push({ start: line.start, end: line.start + line.text.length });
    }
  }
  return out;
}

/** frontmatter 裡人寫的那幾段值（鍵名、機器記的賬、圍欄不在裡面）。 */
function openValues(inner: string, offset: number): Span[] {
  const open: Span[] = [];
  let listKeyIsHuman = false;
  for (const line of linesFrom(inner, 0)) {
    const start = offset + line.start;
    const text = line.text;
    const item = /^(\s*-\s+)(.*)$/.exec(text);
    if (item) {
      if (listKeyIsHuman && item[2].trim()) {
        open.push({ start: start + item[1].length, end: start + item[1].length + item[2].length });
      }
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*)(\s*:\s*)(.*)$/.exec(text);
    if (!kv) {
      listKeyIsHuman = false;
      continue;
    }
    const human = !MACHINE_FRONTMATTER_KEYS.has(kv[1]);
    const value = kv[3];
    if (value.trim() === '') {
      listKeyIsHuman = human;
      continue;
    }
    listKeyIsHuman = false;
    if (human) {
      const valueStart = start + kv[1].length + kv[2].length;
      open.push({ start: valueStart, end: valueStart + value.length });
    }
  }
  return open;
}

/** 從 `from` 起一行一行（不含換行符，行尾的 `\r` 也去掉），帶每一行在全文裡的起點。 */
function linesFrom(text: string, from: number): { start: number; text: string }[] {
  const out: { start: number; text: string }[] = [];
  let pos = from;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const raw = text.slice(pos, end);
    out.push({ start: pos, text: raw.endsWith('\r') ? raw.slice(0, -1) : raw });
    if (nl === -1) {
      break;
    }
    pos = nl + 1;
  }
  return out;
}

/** 這一處能不能搜、能不能換：沒壓在護住的字上。 */
export function isOpen(p: Protection, m: FindMatch): boolean {
  if (p.fence && m.start < p.fence.end && m.end > p.fence.start) {
    // 壓在 frontmatter 上：必須整個落在某一個人寫的值裡。
    if (!p.open.some((s) => m.start >= s.start && m.end <= s.end)) {
      return false;
    }
  }
  return !p.blocked.some((s) => m.start < s.end && m.end > s.start);
}

export interface FileHits {
  /** 這份檔案裡可以搜、可以換的每一處，按先後。 */
  matches: FindMatch[];
  /** 匹配數到了 `textFind` 的上限（兩萬處），後面的沒數。 */
  truncated: boolean;
  /** 正則寫錯了（這時 `matches` 是空的）。 */
  error?: string;
}

/** 一份檔案裡的每一處：`textFind.findMatches` 的口徑，去掉壓在護住的字上的那些。 */
export function fileHits(text: string, kind: string, query: string, opts: FindOptions = {}): FileHits {
  const found = findMatches(text, query, opts);
  if (found.error) {
    return { matches: [], truncated: false, error: found.error };
  }
  if (found.matches.length === 0) {
    return { matches: [], truncated: false };
  }
  const p = protectionOf(text, kind);
  return { matches: found.matches.filter((m) => isOpen(p, m)), truncated: found.truncated };
}

/** 結果列表上的一處：位置、第幾行、那一行裡命中前後的一截。 */
export interface HitLine {
  start: number;
  end: number;
  /** 第幾行（從 1 起）。 */
  line: number;
  /** 這一處在那一行裡的第幾個字（從 0 起）。編輯器按「行 + 列」定位，不按下標——磁碟上的 `\r\n` 到了編輯區裡是 `\n`。 */
  col: number;
  /** 同一行裡命中之前的一截（截過的話開頭是「…」）。 */
  before: string;
  /** 命中的字（跨行的話換行畫成「↵」；太長中間截掉）。 */
  text: string;
  /** 同一行裡命中之後的一截（截過的話結尾是「…」）。 */
  after: string;
}

/** 命中的字最多顯示幾個（跨行的正則一下能吞幾百字）。 */
const HIT_TEXT_MAX = 80;

/** 給按先後排好的幾處配上行號與那一行的上下文。 */
export function describeHits(text: string, matches: readonly FindMatch[]): HitLine[] {
  const out: HitLine[] = [];
  let line = 1;
  let scanned = 0;
  let lineStart = 0;
  for (const m of matches) {
    for (let i = text.indexOf('\n', scanned); i !== -1 && i < m.start; i = text.indexOf('\n', i + 1)) {
      line++;
      lineStart = i + 1;
    }
    scanned = Math.max(scanned, m.start);
    const nl = text.indexOf('\n', m.end);
    let lineEnd = nl === -1 ? text.length : nl;
    if (lineEnd > m.end && text[lineEnd - 1] === '\r') {
      lineEnd--;
    }
    const from = Math.max(lineStart, m.start - BOOK_FIND_CONTEXT.before);
    const to = Math.min(lineEnd, m.end + BOOK_FIND_CONTEXT.after);
    out.push({
      start: m.start,
      end: m.end,
      line,
      col: m.start - lineStart,
      before: `${from > lineStart ? '…' : ''}${text.slice(from, m.start)}`,
      text: showHit(text.slice(m.start, m.end)),
      after: `${text.slice(m.end, to).replace(/\r$/, '')}${to < lineEnd ? '…' : ''}`,
    });
  }
  return out;
}

/** 命中的字給人看的樣子：換行畫成「↵」，太長的中間截掉。 */
export function showHit(raw: string): string {
  const flat = raw.replace(/\r?\n/g, '↵');
  if (flat.length <= HIT_TEXT_MAX) {
    return flat;
  }
  const half = Math.floor((HIT_TEXT_MAX - 1) / 2);
  return `${flat.slice(0, half)}…${flat.slice(flat.length - half)}`;
}

/**
 * 預覽：每一處換成什麼（與 `textFind.replaceSelectedIn` 同一個演算法——在原文裡、在這一處自己的位置上重新匹配一次，
 * 正則時照 `String.prototype.replace` 的規矩展開 `$1`）。對不上的那一處給 undefined。
 */
export function replacementsAt(
  text: string,
  matches: readonly FindMatch[],
  query: string,
  replacement: string,
  opts: FindOptions = {}
): (string | undefined)[] {
  if (!opts.regex) {
    return matches.map(() => replacement);
  }
  const compiled = compileSearch(query, opts);
  if (!compiled?.ok) {
    return matches.map(() => undefined);
  }
  const re = new RegExp(compiled.re.source, `${compiled.re.flags.replace('g', '')}y`);
  return matches.map((at) => {
    re.lastIndex = at.start;
    const m = re.exec(text);
    return m && m[0].length === at.end - at.start ? expandReplacement(replacement, m, text) : undefined;
  });
}
