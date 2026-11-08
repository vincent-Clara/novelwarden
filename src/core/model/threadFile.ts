import { traditionalLabel, canonicalLabel } from './labels';
/**
 * 敘事線（2026-10-20 重做，設計見 docs/design/plans/2026-10-20-narrative-threads.md）：**一條線一個檔案**
 * `.novelwarden/threads/<線名>.md`，掛不上線的伏筆單放 `threads/未归属的伏笔.md`。
 *
 * ```markdown
 * ---
 * kind: 感情線            # 主線 / 支線 / 感情線 / 人物線；認不出當支線
 * origin: 計劃            # 計劃 / 正文
 * plan: 3-40              # 計劃第幾章開、第幾章收；可以只寫開頭（3-）或不寫
 * progressThrough: 12     # 「當前進度」寫到第幾章
 * progressHash: …         # 機器最後一次寫「當前進度」時的指紋
 * generatedBy: novelwarden
 * ---
 *
 * # 林昭與沈青
 *
 * ## 意圖
 * ## 當前進度
 * ## 伏筆
 * - 玉佩的來歷：林昭的玉佩是沈家舊物（計劃第 3 章埋、第 18 章前收）
 * ## 進展
 * - 第 3 章 · 計劃 · 埋〈玉佩的來歷〉：打鬥中玉佩露出來
 * - 第 3 章 · 推進：兩人在鎮口初遇 〔證據：「她的劍停在他喉前三寸」〕
 * ```
 *
 * 七期那一份單檔案 `threads.md`（`threadsFile.ts`，已刪）把伏筆、懸念、線索混在一起，狀態只有一種演算法，
 * 也看不出一條線現在走到哪。這一版只收**劇情線**（四種種類，主線全書一條），伏筆掛線上下，
 * 關係變動是線上的一個事件；「當前進度」一兩句話說這條線現在走到哪，由機器維護、指紋守著。
 *
 * ## 四條約定
 *
 * - **檔名就是線名**（同名按 {@link threadKey} 歸一判）。{@link UNFILED_NAME} 是保留名。
 * - **狀態不落盤**（第 18 條同一個口徑）：進行中 / 已收束、斷了幾章、伏筆逾期，都從事件現算
 *   （{@link threadStateAt}、{@link foreshadowingOf}）。寫第 N 章時只看第 N 章之前的事件（{@link asOf}）。
 * - **外科式寫入**（第 3 條）：追加伏筆、追加事件、按章換計劃事件、按證據清掉一章的機器事件、換寫
 *   「當前進度」，都只動插入或刪掉的那幾行，作者寫的字、自加的小節、BOM 與換行符原樣。
 * - **怎麼手改都不崩**（第 1 條）：認不出的行原樣留著，不當伏筆、也不當事件。
 *
 * 純函式，無 I/O。讀目錄在 `model/project.ts` 的 `readThreads`，寫盤在閘道器（`workspace/index.ts`）。
 */
import { hash, sanitizeFileName } from './fs';
import {
  SECTION_PLACEHOLDER,
  asNumber,
  asString,
  hasContent,
  parseMarkdown,
  replaceSection,
  rewriteFrontmatter,
  stringifyFrontmatter,
} from './markdown';
import { indexText, normalizeQuote, quoteFound } from './review';
import { nearestSentence } from './continuity';
import type { ThreadWatch } from './pipeline';
import type { Timeline } from './timelineFile';

// ---------------------------------------------------------------- 型別

/** 種類（作者定的，2026-10-20 第 5 條）：定死四種，不分子線。 */
export type ThreadKind = '主线' | '支线' | '感情线' | '人物线';
export const THREAD_KINDS: readonly ThreadKind[] = ['主线', '支线', '感情线', '人物线'];

/** 這條線從哪來：排線排出來的，還是定稿時從正文裡認出來的。 */
export type ThreadOrigin = '计划' | '正文';

/** 線的事件：推進、關係（人物關係的變動）、收束（這條線走完了）、放棄。 */
export type LineEventType = '推进' | '关系' | '收束' | '放弃';
/** 伏筆的事件：埋、收、棄。 */
export type ForeshadowEventType = '埋' | '收' | '弃';
export type ThreadEventType = LineEventType | ForeshadowEventType;
export const LINE_EVENT_TYPES: readonly LineEventType[] = ['推进', '关系', '收束', '放弃'];
export const FORESHADOW_EVENT_TYPES: readonly ForeshadowEventType[] = ['埋', '收', '弃'];

/**
 * 「進展」裡的一行。`planned` 的是計劃事件（拆細綱寫進來的），其餘是實際事件（定稿寫進來的，
 * 必須帶證據；作者手寫的可以沒有）。
 */
export interface ThreadEvent {
  chapter: number;
  planned: boolean;
  type: ThreadEventType;
  /** 伏筆的事件掛的是哪一條伏筆（`〈名〉`）。 */
  foreshadowing?: string;
  what: string;
  /** 正文裡的一句原文。 */
  evidence?: string;
}

/** 「伏筆」裡的一行：`名：是什麼（計劃第 a 章埋、第 b 章前收）`，括號可缺。 */
export interface Foreshadowing {
  name: string;
  what: string;
  plant?: number;
  resolve?: number;
}

/** 一份敘事線檔案（一條線，或「未歸屬的伏筆」）都有的部分。 */
export interface ThreadFileBase {
  name: string;
  relPath: string;
  foreshadowing: Foreshadowing[];
  events: ThreadEvent[];
}

/** 一條線。 */
export interface Thread extends ThreadFileBase {
  kind: ThreadKind;
  origin: ThreadOrigin;
  /** 計劃第幾章開。 */
  from?: number;
  /** 計劃第幾章收。 */
  to?: number;
  intent: string;
  /** 當前進度：一兩句話說這條線現在走到哪了。 */
  progress: string;
  /** 「當前進度」寫到第幾章（機器寫時記）。 */
  progressThrough?: number;
  /** 機器最後一次寫「當前進度」時的指紋。 */
  progressHash?: string;
  /** 在目錄裡排第幾（0 起，按檔名）。同檔排序時按它。 */
  index: number;
}

/** 掛不上線的伏筆：與一條線同樣的「伏筆」「進展」兩節，沒有意圖、當前進度、種類。 */
export type UnfiledForeshadowing = ThreadFileBase;

/** `threads/` 目錄讀出來的全部。 */
export interface ThreadBook {
  threads: Thread[];
  unfiled: UnfiledForeshadowing;
  /**
   * 故事時間（`threads/时间线.md`，2026-10-24，model/timelineFile.ts）。`readThreads` 總會給（沒有這份檔案時 `exists` 為 false）；
   * 手搭的 ThreadBook（測試、純函式的呼叫方）可以不給，當沒有時間線。
   */
  timeline?: Timeline;
}

/** 狀態（現算，不落盤）。 */
export type ThreadStatus = '计划中' | '进行中' | '已收束' | '已放弃';
export type ForeshadowStatus = '计划' | '已埋' | '已收' | '已弃';

// ---------------------------------------------------------------- 常量

/** 「未歸屬的伏筆」的檔名（不含副檔名）。排線、定稿都不許用它當線名。 */
export const UNFILED_NAME = '未歸屬的伏筆';

/** 故事時間那份檔案的檔名（不含副檔名，model/timelineFile.ts）。也是保留名：排線、定稿都不許用它當線名。 */
export const TIMELINE_NAME = '時間線';

/** 既有工程的固定檔名；顯示名稱可以本地化，路徑不能跟著改。 */
export const UNFILED_FILENAME = '未归属的伏笔.md';
export const TIMELINE_FILENAME = '时间线.md';

/** 意圖最長多少字（排線寫，之後機器不改）。 */
export const INTENT_MAX = 200;
/** 當前進度最長多少字。 */
export const PROGRESS_MAX = 150;
/** 線名、伏筆名最長多少字：名字就是身份，太長的不收。 */
export const NAME_MAX = 30;

/**
 * 線「斷了」：進行中的線已經 K 章沒有實際事件。⚑ 主線 5 章，其餘 15 章，先寫死（設計稿 ⚑9；
 * 工程頁的 ⚠ 與寫前檢查的提醒共用）。
 */
export const STALL_CHAPTERS: Readonly<Record<ThreadKind, number>> = Object.freeze({
  主线: 5,
  支线: 15,
  感情线: 15,
  人物线: 15,
});

// ---------------------------------------------------------------- 認名字、種類與事件型別

/** 同名判據：審稿引文那一套歸一化（NFKC、去空白與標點）。線名、伏筆名都用它。 */
export function threadKey(name: string): string {
  return normalizeQuote(name);
}

export function isUnfiledName(name: string): boolean {
  return threadKey(traditionalLabel(name)) === threadKey(UNFILED_NAME);
}

/** 敘事線目錄裡的保留名：「未歸屬的伏筆」與「時間線」。 */
export function isReservedThreadName(name: string): boolean {
  return isUnfiledName(name) || threadKey(traditionalLabel(name)) === threadKey(TIMELINE_NAME);
}

/** 一條線落在哪個檔名上（不含目錄）。 */
export function threadFileName(name: string): string {
  return `${sanitizeFileName(name.trim())}.md`;
}

const KIND_ALIASES: [string, ThreadKind][] = [
  ['主线', '主线'],
  ['main', '主线'],
  ['支线', '支线'],
  ['副線', '支线'],
  ['side', '支线'],
  ['感情线', '感情线'],
  ['情感線', '感情线'],
  ['愛情線', '感情线'],
  ['感情', '感情线'],
  ['romance', '感情线'],
  ['人物线', '人物线'],
  ['成長線', '人物线'],
  ['人物', '人物线'],
  ['character', '人物线'],
];

/** 認種類（模型給的、作者寫的都走這一個）。認不出返回 undefined——讀檔案時當支線，排線時不收。 */
export function threadKindOf(text: string): ThreadKind | undefined {
  const t = (text ?? '').replace(/\s+/g, '').toLowerCase();
  return KIND_ALIASES.find(([alias]) => traditionalLabel(t) === traditionalLabel(alias))?.[1];
}

/**
 * 事件型別的幾種寫法。**整個詞對得上才算**（不按字首認）：「收」與「收束」是兩種，
 * 「第 3 章 收到密信」裡的「收到密信」不是一個型別。
 */
const TYPE_ALIASES: [string, ThreadEventType][] = [
  ['推进', '推进'],
  ['进展', '推进'],
  ['advance', '推进'],
  ['关系', '关系'],
  ['關係變動', '关系'],
  ['relation', '关系'],
  ['收束', '收束'],
  ['完結', '收束'],
  ['結束', '收束'],
  ['close', '收束'],
  ['放弃', '放弃'],
  ['作廢', '放弃'],
  ['abandon', '放弃'],
  ['埋', '埋'],
  ['埋下', '埋'],
  ['埋設', '埋'],
  ['plant', '埋'],
  ['收', '收'],
  ['回收', '收'],
  ['揭開', '收'],
  ['兌現', '收'],
  ['payoff', '收'],
  ['弃', '弃'],
  ['棄用', '弃'],
  ['drop', '弃'],
];

/** 認事件型別。認不出返回 undefined。 */
export function eventTypeOf(text: string): ThreadEventType | undefined {
  const t = (text ?? '').replace(/\s+/g, '').toLowerCase();
  return TYPE_ALIASES.find(([alias]) => traditionalLabel(t) === traditionalLabel(alias))?.[1];
}

export function isForeshadowEvent(type: ThreadEventType): type is ForeshadowEventType {
  return (FORESHADOW_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * frontmatter 的 `plan`：`3-40`、`3–40`、`第3-40章`、`3-`（只寫開頭）、`-40`（只寫收束章）、`3`。
 * 認不出返回空物件。
 */
export function parsePlan(text: string): { from?: number; to?: number } {
  const s = (text ?? '').trim();
  // 只寫了收束章（`-40`）。
  const onlyTo = /^[-–—~～至到]+\s*(?:第\s*)?(\d+)/u.exec(s);
  if (onlyTo) {
    const b = Number(onlyTo[1]);
    return b > 0 ? { to: b } : {};
  }
  const m =/(\d+)\s*(?:章)?\s*(?:[-–—~～至到]+\s*(?:第\s*)?(\d+)?)?/u.exec(s);
  if (!m) {
    return {};
  }
  const a = Number(m[1]);
  const b = m[2] !== undefined ? Number(m[2]) : undefined;
  if (!(a > 0)) {
    return {};
  }
  if (b === undefined || !(b > 0)) {
    return { from: a };
  }
  return { from: Math.min(a, b), to: Math.max(a, b) };
}

/** 寫回 frontmatter 的 `plan`。兩頭都沒有時是 undefined（不寫這個鍵）。 */
export function planText(from?: number, to?: number): string | undefined {
  if (from === undefined && to === undefined) {
    return undefined;
  }
  return `${from ?? ''}-${to ?? ''}`;
}

// ---------------------------------------------------------------- 解析

const BULLET = /^\s*(?:[-*•·]|\d+[.)、])\s+/u;
const EVENT_HEAD = /^第\s*(\d+)\s*章/u;
const QUOTES: [string, string][] = [['「', '」'], ['『', '』'], ['“', '”'], ['"', '"'], ["'", "'"]];

function unquote(s: string): string {
  const t = s.trim();
  for (const [a, b] of QUOTES) {
    if (t.length >= 2 && t.startsWith(a) && t.endsWith(b)) {
      return t.slice(a.length, -b.length).trim();
    }
  }
  return t;
}

/** 行尾的證據：`〔證據：「原文」〕`，括號寫成 `[]`、`【】`、`（）` 也認。 */
const EVIDENCE_TAIL = /\s*[〔\[【（(]\s*(?:证|證)(?:据|據)\s*[:：]\s*([\s\S]*?)\s*[〕\]】）)]\s*$/u;

/**
 * `第 N 章 · [計劃 · ]型別[〈伏筆名〉]：一句話[ 〔證據：「原文」〕]`（專案符號已經去掉）。
 * 不是 `第 N 章` 開頭的返回 undefined。型別認不出時整截當「推進」的說明——作者記了一筆，說明這條線動過
 * （七期同一個口徑）。
 */
export function parseEventLine(line: string): ThreadEvent | undefined {
  const head = EVENT_HEAD.exec(line);
  if (!head) {
    return undefined;
  }
  const chapter = Number(head[1]);
  if (!(chapter > 0)) {
    return undefined;
  }
  const rest = line.slice(head[0].length).replace(/^[\s·・\-—|｜:：]+/u, '');
  let planned = false;
  let s = rest;
  if (/^(?:计划|計劃)/u.test(s)) {
    planned = true;
    s = s.slice(2).replace(/^[\s·・\-—|｜]+/u, '');
  }
  const token = /^([^\s〈<《:：·・（(〔\[【]+)/u.exec(s);
  const type = token ? eventTypeOf(token[1]) : undefined;
  if (!type) {
    // 「計劃」後面接的不是型別：「第 3 章 計劃有變……」不是一條計劃事件。
    return { chapter, planned: false, type: '推进', what: stripEvidence(rest).what, ...evidenceOf(rest) };
  }
  s = s.slice(token![0].length).replace(/^\s+/u, '');
  let foreshadowing: string | undefined;
  const fore = /^[〈<《]([^〉>》]*)[〉>》]/u.exec(s);
  if (fore) {
    foreshadowing = fore[1].trim() || undefined;
    s = s.slice(fore[0].length);
  }
  s = s.replace(/^[\s·・]*[:：]?\s*/u, '');
  const { what } = stripEvidence(s);
  return {
    chapter,
    planned,
    type,
    ...(foreshadowing ? { foreshadowing } : {}),
    what,
    ...evidenceOf(s),
  };
}

function stripEvidence(s: string): { what: string } {
  const m = EVIDENCE_TAIL.exec(s);
  return { what: (m ? s.slice(0, m.index) : s).trim() };
}

function evidenceOf(s: string): { evidence?: string } {
  const m = EVIDENCE_TAIL.exec(s);
  const evidence = m ? unquote(m[1]) : '';
  return evidence ? { evidence } : {};
}

/** `名：是什麼（計劃第 a 章埋、第 b 章前收）`（專案符號已經去掉）。沒有名字返回 undefined。 */
export function parseForeshadowLine(line: string): Foreshadowing | undefined {
  let s = line.trim();
  let plant: number | undefined;
  let resolve: number | undefined;
  const paren = /[（(]([^（()）]*)[)）]\s*$/u.exec(s);
  if (paren) {
    const p = /第?\s*(\d+)\s*章\s*(?:埋下|埋(?:设|設)|埋)/u.exec(paren[1]);
    const r = /第?\s*(\d+)\s*章\s*(?:之?前)?\s*(?:回收|揭(?:开|開)|收)/u.exec(paren[1]);
    if (p || r) {
      plant = p ? Number(p[1]) : undefined;
      resolve = r ? Number(r[1]) : undefined;
      s = s.slice(0, paren.index).trim();
    }
  }
  const colon = s.search(/[:：]/u);
  const name = (colon >= 0 ? s.slice(0, colon) : s).trim().replace(/^[〈<《「]\s*|\s*[〉>》」]$/gu, '');
  const what = colon >= 0 ? s.slice(colon + 1).trim() : '';
  if (!name || !hasContent(name)) {
    return undefined;
  }
  return {
    name,
    what,
    ...(plant !== undefined && plant > 0 ? { plant } : {}),
    ...(resolve !== undefined && resolve > 0 ? { resolve } : {}),
  };
}

/** 認得出的幾節。小節名按 `normalizeSectionKey` 寬鬆認。 */
type SectionId = 'intent' | 'progress' | 'foreshadowing' | 'events';
const SECTION_ALIASES: Record<string, SectionId> = {
  意图: 'intent',
  作者意图: 'intent',
  当前进度: 'progress',
  进度: 'progress',
  伏笔: 'foreshadowing',
  进展: 'events',
  事件: 'events',
};
const SECTION_TITLE: Record<SectionId, string> = {
  intent: '意图',
  progress: '当前进度',
  foreshadowing: '伏笔',
  events: '进展',
};

function normalizeSectionKey(s: string): string {
  return canonicalLabel(s.replace(/[\s·・、,，.。:：/-]/g, '').toLowerCase());
}

/** 一行是不是二級標題；是的話認它是哪一節（認不出是 null）。不是標題返回 undefined。 */
function sectionOfHeading(line: string): SectionId | null | undefined {
  const m = /^##(?!#)\s*(.*?)\s*#*\s*$/u.exec(line);
  if (!m) {
    return undefined;
  }
  return SECTION_ALIASES[normalizeSectionKey(m[1])] ?? null;
}

/** 檔名詞幹（不含目錄與 `.md`）。 */
function stemOf(relPath: string): string {
  const base = relPath.replace(/\\/g, '/').split('/').pop() ?? '';
  return base.replace(/\.(md|markdown)$/i, '');
}

interface ParsedBody {
  h1?: string;
  intent: string;
  progress: string;
  foreshadowing: Foreshadowing[];
  events: ThreadEvent[];
}

function parseBody(body: string): ParsedBody {
  const out: ParsedBody = { intent: '', progress: '', foreshadowing: [], events: [] };
  const text: Partial<Record<SectionId, string[]>> = {};
  let cur: SectionId | null = null;
  const seen = new Set<string>();
  for (const raw of body.split(/\r?\n/)) {
    const h1 = /^#(?!#)\s+(.+?)\s*$/u.exec(raw);
    if (h1) {
      out.h1 ??= h1[1].trim();
      cur = null;
      continue;
    }
    const heading = sectionOfHeading(raw);
    if (heading !== undefined) {
      cur = heading;
      continue;
    }
    if (/^#{3,}\s/u.test(raw) || cur === null) {
      continue;
    }
    if (cur === 'intent' || cur === 'progress') {
      (text[cur] ??= []).push(raw);
      continue;
    }
    const line = raw.replace(BULLET, '').trim();
    if (!line || line.startsWith('>') || !hasContent(line)) {
      continue;
    }
    if (cur === 'foreshadowing') {
      const f = parseForeshadowLine(line);
      if (f && !seen.has(threadKey(f.name))) {
        seen.add(threadKey(f.name));
        out.foreshadowing.push(f);
      }
    } else {
      const e = parseEventLine(line);
      if (e) {
        out.events.push(e);
      }
    }
  }
  const block = (id: 'intent' | 'progress'): string => {
    const t = (text[id] ?? []).join('\n').trim();
    return hasContent(t) ? t : '';
  };
  out.intent = block('intent');
  out.progress = block('progress');
  return out;
}

/**
 * 檔名是線名。H1 只在和檔名對得上時才當名字用：機器建檔案時名字裡的 `/`、`:` 被檔名清洗掉了，
 * H1 留著原樣；作者在外面改了檔名，H1 就過時了，信檔名。
 */
function nameOf(stem: string, h1: string | undefined): string {
  if (h1 && sanitizeFileName(h1) === stem) {
    return h1;
  }
  return stem;
}

/** 讀一條線（`threads/<線名>.md`）。怎麼手改都不拋（第 1 條）：認不出的種類當支線，認不出的行跳過。 */
export function parseThreadFile(raw: string, relPath: string, index = 0): Thread {
  const { frontmatter, body } = parseMarkdown(raw ?? '');
  const parsed = parseBody(body);
  const { from, to } = parsePlan(asString(frontmatter.plan));
  const progressThrough = asNumber(frontmatter.progressThrough);
  const progressHash = asString(frontmatter.progressHash);
  return {
    name: nameOf(stemOf(relPath), parsed.h1),
    relPath,
    kind: threadKindOf(asString(frontmatter.kind)) ?? '支线',
    origin: asString(frontmatter.origin).includes('正文') ? '正文' : '计划',
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    intent: parsed.intent,
    progress: parsed.progress,
    ...(progressThrough !== undefined && progressThrough >= 0 ? { progressThrough } : {}),
    ...(progressHash ? { progressHash } : {}),
    foreshadowing: parsed.foreshadowing,
    events: parsed.events,
    index,
  };
}

/** 讀「未歸屬的伏筆」。沒有這份檔案時傳空串。 */
export function parseUnfiledFile(raw: string, relPath: string): UnfiledForeshadowing {
  const parsed = parseBody(parseMarkdown(raw ?? '').body);
  return { name: UNFILED_NAME, relPath, foreshadowing: parsed.foreshadowing, events: parsed.events };
}

// ---------------------------------------------------------------- 狀態（現算）

/** 實際事件（定稿寫進來的、作者手寫的）。 */
export function actualEvents(file: ThreadFileBase): ThreadEvent[] {
  return file.events.filter((e) => !e.planned);
}

/** 計劃事件（拆細綱寫進來的）。 */
export function plannedEvents(file: ThreadFileBase): ThreadEvent[] {
  return file.events.filter((e) => e.planned);
}

/** 章號最大的那一條（同章取寫在後面的）。 */
function latest(events: readonly ThreadEvent[]): ThreadEvent | undefined {
  let best: ThreadEvent | undefined;
  for (const e of events) {
    if (!best || e.chapter >= best.chapter) {
      best = e;
    }
  }
  return best;
}

/**
 * 一條線的狀態：一條實際事件都沒有是「計劃中」；章號最大的那條**線的**實際事件（推進 / 關係 / 收束 / 放棄，
 * 同章取寫在後面的）是收束就「已收束」、放棄就「已放棄」，其餘「進行中」。伏筆的事件只說明這條線動過，
 * 不會把收了的線重新開啟。
 */
export function threadStatus(thread: ThreadFileBase): ThreadStatus {
  const actual = actualEvents(thread);
  if (actual.length === 0) {
    return '计划中';
  }
  const last = latest(actual.filter((e) => !isForeshadowEvent(e.type)));
  if (last?.type === '收束') {
    return '已收束';
  }
  if (last?.type === '放弃') {
    return '已放弃';
  }
  return '进行中';
}

/** 收束、放棄了的線不再帶進上下文、不再送去認事件。 */
export function isClosed(status: ThreadStatus): boolean {
  return status === '已收束' || status === '已放弃';
}

/** 最近一次實際事件在第幾章（線的、伏筆的都算：這條線動過）。沒有實際事件是 undefined。 */
export function lastActiveChapter(file: ThreadFileBase): number | undefined {
  return latest(actualEvents(file))?.chapter;
}

/**
 * 寫到第 `no` 章時這份檔案的樣子：只留第 `no` 章**之前**的事件；「當前進度」寫到第 `no` 章或更晚時
 * 也不用（那裡面已經有第 `no` 章自己的事）。重寫、重新定稿早前的章時，後面幾章記下的事在那一章看來還沒有
 * 發生——帶進去就是把後面的劇情透給前面（七期 `asOf` 同一個道理）。
 */
export function asOf<T extends ThreadFileBase>(file: T, no: number): T {
  const events = file.events.filter((e) => e.chapter < no);
  const t = file as T & Partial<Pick<Thread, 'progress' | 'progressThrough'>>;
  const stale = t.progressThrough !== undefined && t.progressThrough >= no && !!t.progress;
  if (events.length === file.events.length && !stale) {
    return file;
  }
  return { ...file, events, ...(stale ? { progress: '' } : {}) };
}

/** 一條線此刻的樣子（工程頁一行、寫前檢查、挑線共用）。 */
export interface ThreadState {
  status: ThreadStatus;
  /** 最近一次實際事件在第幾章。 */
  lastActive?: number;
  /** 進行中的線已經幾章沒有實際事件（`current − lastActive`）。不是進行中時缺席。 */
  gap?: number;
  /** 斷了：{@link gap} 到了 {@link STALL_CHAPTERS}。 */
  stalled: boolean;
  /** 過了計劃收束章還沒收束（計劃中、進行中的線才算）。 */
  overdue: boolean;
}

/** `current` 是「現在」：定稿到的最後一章（寫第 N 章時傳 N − 1，並先 {@link asOf}）。 */
export function threadStateAt(thread: Thread, current: number): ThreadState {
  const status = threadStatus(thread);
  const lastActive = lastActiveChapter(thread);
  const open = !isClosed(status);
  const gap = status === '进行中' && lastActive !== undefined ? Math.max(0, current - lastActive) : undefined;
  return {
    status,
    ...(lastActive !== undefined ? { lastActive } : {}),
    ...(gap !== undefined ? { gap } : {}),
    stalled: gap !== undefined && gap >= STALL_CHAPTERS[thread.kind],
    overdue: open && thread.to !== undefined && current > thread.to,
  };
}

/** 一條伏筆此刻的樣子。`plant`、`resolve` 是伏筆那一行寫的；推遲過的按 `plantBy`、`resolveBy` 算。 */
export interface ForeshadowState extends Foreshadowing {
  status: ForeshadowStatus;
  /** 實際埋在第幾章。 */
  plantedAt?: number;
  /** 實際收（或棄）在第幾章。 */
  closedAt?: number;
  /** 按第幾章前埋算（{@link dueOf}：那一行寫的、計劃裡埋它的那一章、寫明的「推遲到第 N 章埋」取晚的）。都沒寫時缺席。 */
  plantBy?: number;
  /** 按第幾章前收算（同上，收）。都沒寫時缺席。 */
  resolveBy?: number;
  /** 過了 {@link resolveBy} 還沒收、也沒棄。 */
  overdue: boolean;
}

const FORESHADOW_STATUS: Record<ForeshadowEventType, ForeshadowStatus> = { 埋: '已埋', 收: '已收', 弃: '已弃' };

/**
 * 推遲的寫法（拆細綱合同：給伏筆所在的線寫一條推進，「〈伏筆名〉推遲到第 N 章收」）。認的是歸一形（去空白與標點），
 * 動詞缺席當「收」。
 */
const DEFER_RE = /推(?:迟|遲)(?:到|至)?第?(\d+)章(?:再|才)?(埋下|埋(?:设|設)|埋|回收|收回|揭(?:开|開)|(?:兑|兌)(?:现|現)|收)?/u;
/** 伏筆名之後多遠以內的「推遲到第 N 章」算它的（同一句話裡還提到別的伏筆時，不認到後面那一條的頭上）。 */
const DEFER_NEAR = 4;

/** 一句話裡寫明的「〈伏筆名〉推遲到第 N 章收 / 埋」。沒寫、或推遲的不是這一條，返回 undefined。 */
export function deferralOf(what: string, name: string): { chapter: number; type: '埋' | '收' } | undefined {
  const key = threadKey(name);
  const text = normalizeQuote(what);
  const at = key ? text.indexOf(key) : -1;
  if (at < 0) {
    return undefined;
  }
  const m = DEFER_RE.exec(text.slice(at + key.length));
  const chapter = m ? Number(m[1]) : 0;
  return m && m.index <= DEFER_NEAR && chapter > 0 ? { chapter, type: m[2]?.startsWith('埋') ? '埋' : '收' } : undefined;
}

/**
 * 一條伏筆按第幾章前埋、第幾章前收算（⚑ 2026-10-24 作者定的，改了二期 ⚑6「推遲只是一句話」）：伏筆那一行寫的、計劃裡埋 / 收它的
 * 那一章、`events` 裡任何一條寫明的「〈伏筆名〉推遲到第 N 章收 / 埋」，**取晚的**。伏筆那一行機器照舊不改（第 28 條）。
 * 從原樣那一份的事件裡認：寫第 N 章時 {@link asOf} 去掉了這一章及以後的計劃，可那正是推遲到的地方。
 */
export function dueOf(f: Foreshadowing, events: readonly ThreadEvent[]): { plant?: number; resolve?: number } {
  const key = threadKey(f.name);
  let plant = f.plant;
  let resolve = f.resolve;
  const later = (a: number | undefined, b: number): number => (a === undefined || b > a ? b : a);
  for (const e of events) {
    if (e.planned && e.foreshadowing && threadKey(e.foreshadowing) === key) {
      if (e.type === '收') {
        resolve = later(resolve, e.chapter);
      } else if (e.type === '埋') {
        plant = later(plant, e.chapter);
      }
    }
    const d = e.what ? deferralOf(e.what, f.name) : undefined;
    if (d?.type === '收') {
      resolve = later(resolve, d.chapter);
    } else if (d) {
      plant = later(plant, d.chapter);
    }
  }
  return { ...(plant !== undefined ? { plant } : {}), ...(resolve !== undefined ? { resolve } : {}) };
}

/**
 * 這份檔案裡的伏筆，各自現在的狀態。「伏筆」一節寫了的在前（按寫的順序），只在事件裡出現過名字的
 * 跟在後面（作者只記了一筆事件、沒在「伏筆」裡登記，也算一條）。狀態取章號最大的那條實際的埋 / 收 / 棄。
 * `plans` 是認推遲用的事件（{@link dueOf}），預設是這份檔案自己的；傳進來的是 {@link asOf} 過的，就把原樣那一份的事件傳進來。
 */
export function foreshadowingOf(file: ThreadFileBase, current: number, plans: readonly ThreadEvent[] = file.events): ForeshadowState[] {
  const list: Foreshadowing[] = [...file.foreshadowing];
  const known = new Set(list.map((f) => threadKey(f.name)));
  for (const e of file.events) {
    if (e.foreshadowing && !known.has(threadKey(e.foreshadowing))) {
      known.add(threadKey(e.foreshadowing));
      list.push({ name: e.foreshadowing, what: '' });
    }
  }
  const actual = actualEvents(file).filter((e) => isForeshadowEvent(e.type) && e.foreshadowing);
  return list.map((f) => {
    const key = threadKey(f.name);
    const mine = actual.filter((e) => threadKey(e.foreshadowing!) === key);
    const last = latest(mine);
    const status = last ? FORESHADOW_STATUS[last.type as ForeshadowEventType] : '计划';
    const planted = mine.filter((e) => e.type === '埋');
    const plantedAt = planted.length > 0 ? Math.min(...planted.map((e) => e.chapter)) : undefined;
    const closedAt = status === '已收' || status === '已弃' ? last!.chapter : undefined;
    const by = dueOf(f, plans);
    return {
      ...f,
      status,
      ...(plantedAt !== undefined ? { plantedAt } : {}),
      ...(closedAt !== undefined ? { closedAt } : {}),
      ...(by.plant !== undefined ? { plantBy: by.plant } : {}),
      ...(by.resolve !== undefined ? { resolveBy: by.resolve } : {}),
      overdue: (status === '计划' || status === '已埋') && by.resolve !== undefined && current > by.resolve,
    };
  });
}

/** 收了、棄了的伏筆。 */
export function isForeshadowClosed(status: ForeshadowStatus): boolean {
  return status === '已收' || status === '已弃';
}

// ---------------------------------------------------------------- 渲染

/** `第 N 章 · [計劃 · ]型別[〈伏筆名〉]：一句話[ 〔證據：「原文」〕]`（不帶專案符號）。 */
export function renderEventLine(e: ThreadEvent): string {
  const fore = e.foreshadowing?.trim() ? `〈${e.foreshadowing.trim()}〉` : '';
  const what = e.what.replace(/\s+/g, ' ').trim();
  const evidence = e.evidence?.trim() ? ` 〔證據：「${e.evidence.replace(/\s+/g, ' ').trim()}」〕` : '';
  return `第 ${e.chapter} 章 · ${e.planned ? '計劃 · ' : ''}${traditionalLabel(e.type)}${fore}：${what}${evidence}`;
}

/** `名：是什麼（計劃第 a 章埋、第 b 章前收）`（不帶專案符號）。 */
export function renderForeshadowLine(f: Foreshadowing): string {
  const plan = [f.plant !== undefined ? `計劃第 ${f.plant} 章埋` : '', f.resolve !== undefined ? `第 ${f.resolve} 章前收` : '']
    .filter(Boolean)
    .join('、');
  const what = f.what.replace(/\s+/g, ' ').trim();
  return `${f.name.trim()}${what ? `：${what}` : ''}${plan ? `（${plan}）` : ''}`;
}

/** 新建一條線要的東西（排線、定稿認出新線）。 */
export interface NewThread {
  name: string;
  kind: ThreadKind;
  origin: ThreadOrigin;
  from?: number;
  to?: number;
  intent: string;
  foreshadowing: Foreshadowing[];
  /** 建線時一起記下的事件（定稿從正文認出的新線：認出它的那一條實際事件）。 */
  events?: ThreadEvent[];
}

/** 一條新線的整份檔案。 */
export function renderThreadFile(t: NewThread): string {
  const fm = stringifyFrontmatter({
    kind: t.kind,
    origin: t.origin,
    plan: planText(t.from, t.to),
    generatedBy: 'novelwarden',
  });
  return [
    fm,
    '',
    `# ${t.name.trim()}`,
    '',
    '## 意圖',
    '',
    t.intent.trim() || SECTION_PLACEHOLDER,
    '',
    '## 當前進度',
    '',
    SECTION_PLACEHOLDER,
    '',
    '## 伏筆',
    '',
    ...t.foreshadowing.map((f) => `- ${renderForeshadowLine(f)}`),
    ...(t.foreshadowing.length > 0 ? [''] : []),
    '## 進展',
    '',
    ...(t.events ?? []).map((e) => `- ${renderEventLine(e)}`),
  ]
    .join('\n')
    .replace(/\n*$/, '\n');
}

/** 「未歸屬的伏筆」還不存在時的檔案頭。解析時 `## ` 之前的東西一律忽略。 */
export const UNFILED_TEMPLATE = [
  `# ${UNFILED_NAME}`,
  '',
  '> 掛不上哪一條線的伏筆。把一行伏筆連同它的事件剪到某條線的檔案裡，就是掛上了。',
  '',
  '## 伏筆',
  '',
  '## 進展',
  '',
].join('\n');

// ---------------------------------------------------------------- 外科式寫入

interface Lines {
  bom: string;
  eol: string;
  lines: string[];
}

function splitLines(raw: string): Lines {
  const bom = raw.startsWith('﻿') ? '﻿' : '';
  const body = bom ? raw.slice(1) : raw;
  return { bom, eol: body.includes('\r\n') ? '\r\n' : '\n', lines: body.split(/\r?\n/) };
}

function joinLines(l: Lines): string {
  return l.bom + l.lines.join(l.eol);
}

/** frontmatter 之後第一行的下標（沒有 frontmatter 是 0）。 */
function bodyStart(lines: readonly string[]): number {
  if (lines[0]?.trim() !== '---') {
    return 0;
  }
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  return end > 0 ? end + 1 : 0;
}

/** 某一節的範圍：標題那一行、到下一個一級或二級標題之前（不含）。沒有這一節返回 undefined。 */
function findSection(lines: readonly string[], id: SectionId): { head: number; end: number } | undefined {
  const from = bodyStart(lines);
  for (let i = from; i < lines.length; i++) {
    if (sectionOfHeading(lines[i]) !== id) {
      continue;
    }
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^#{1,2}(?!#)\s/u.test(lines[j]) || /^##$/u.test(lines[j])) {
        end = j;
        break;
      }
    }
    return { head: i, end };
  }
  return undefined;
}

/** 這一節裡最後一行有字的下標；一行字都沒有返回標題那一行。 */
function lastFilled(lines: readonly string[], sec: { head: number; end: number }): number {
  for (let i = sec.end - 1; i > sec.head; i--) {
    if (lines[i].trim()) {
      return i;
    }
  }
  return sec.head;
}

/**
 * 確保有這一節，返回它的範圍。沒有就新建：`before` 那一節在就插在它前面，否則接在檔案末尾。
 */
function ensureSection(l: Lines, id: SectionId, before?: SectionId): { head: number; end: number } {
  const found = findSection(l.lines, id);
  if (found) {
    return found;
  }
  const next = before ? findSection(l.lines, before) : undefined;
  if (next) {
    l.lines.splice(next.head, 0, `## ${traditionalLabel(SECTION_TITLE[id])}`, '');
    return { head: next.head, end: next.head + 2 };
  }
  while (l.lines.length > 0 && !l.lines[l.lines.length - 1].trim()) {
    l.lines.pop();
  }
  if (l.lines.length > 0) {
    l.lines.push('');
  }
  const head = l.lines.length;
  l.lines.push(`## ${traditionalLabel(SECTION_TITLE[id])}`, '');
  return { head, end: l.lines.length };
}

/**
 * 在 `at` 這一行之後插入幾行。插在標題後面時與標題隔一個空行；插完如果緊接著就是下一節的標題，
 * 補一個空行隔開。
 */
function insertAfter(l: Lines, at: number, sec: { head: number }, rows: readonly string[]): void {
  const block = [...rows];
  let pos = at + 1;
  if (at === sec.head) {
    if (l.lines[pos] !== undefined && !l.lines[pos].trim()) {
      pos++;
    } else {
      block.unshift('');
    }
  }
  const next = l.lines[pos];
  if (next !== undefined && next.trim() && /^#/u.test(next)) {
    block.push('');
  }
  l.lines.splice(pos, 0, ...block);
}

/** 檔案末尾保證有一個換行（原來就有的不加）。 */
function finish(l: Lines): string {
  if (l.lines.length === 0 || l.lines[l.lines.length - 1] !== '') {
    l.lines.push('');
  }
  return joinLines(l);
}

/** 「進展」裡一行事件的樣子（專案符號沿用這一節裡已有的寫法，預設 `- `）。 */
function eventRow(l: Lines, sec: { head: number; end: number } | undefined, e: ThreadEvent): string {
  return `${bulletOf(l, sec)}${renderEventLine(e)}`;
}

function bulletOf(l: Lines, sec: { head: number; end: number } | undefined): string {
  if (sec) {
    for (let i = sec.head + 1; i < sec.end; i++) {
      const m = /^(\s*[-*•]\s+)/u.exec(l.lines[i]);
      if (m) {
        return m[1];
      }
    }
  }
  return '- ';
}

/** 「進展」裡各行認出的事件（認不出的是 undefined），帶行號。 */
function eventRows(l: Lines, sec: { head: number; end: number }): { i: number; e: ThreadEvent }[] {
  const out: { i: number; e: ThreadEvent }[] = [];
  for (let i = sec.head + 1; i < sec.end; i++) {
    const e = parseEventLine(l.lines[i].replace(BULLET, '').trim());
    if (e) {
      out.push({ i, e });
    }
  }
  return out;
}

/**
 * 把幾行事件插進「進展」：大體按章號排——插在第一條章號更大的事件前面（同一章裡計劃事件排在實際事件前面），
 * 沒有就接在這一節最後一行有字的後面。只插、不挪作者已有的行。`e` 是定位用的那一條。
 */
function insertEvents(l: Lines, sec: { head: number; end: number }, e: ThreadEvent, rows: readonly string[]): void {
  const before = eventRows(l, sec).find(
    (r) => r.e.chapter > e.chapter || (r.e.chapter === e.chapter && e.planned && !r.e.planned)
  );
  if (before) {
    l.lines.splice(before.i, 0, ...rows);
  } else {
    insertAfter(l, lastFilled(l.lines, sec), sec, rows);
  }
}

/**
 * 在「伏筆」一節末尾加幾條伏筆（這份檔案裡已經有同名的跳過）。沒有這一節就在「進展」前面建一節。
 * 返回新原文與實際加了哪幾條；一條都沒加時原文原樣返回。
 */
export function appendForeshadowing(raw: string, items: readonly Foreshadowing[]): { text: string; added: Foreshadowing[] } {
  const base = raw ?? '';
  const parsed = parseBody(parseMarkdown(base).body);
  const known = new Set(parsed.foreshadowing.map((f) => threadKey(f.name)));
  for (const e of parsed.events) {
    if (e.foreshadowing) {
      known.add(threadKey(e.foreshadowing));
    }
  }
  const added: Foreshadowing[] = [];
  for (const f of items) {
    const key = threadKey(f.name);
    if (!key || known.has(key)) {
      continue;
    }
    known.add(key);
    added.push(f);
  }
  if (added.length === 0) {
    return { text: base, added };
  }
  const l = splitLines(base);
  const sec = ensureSection(l, 'foreshadowing', 'events');
  const bullet = bulletOf(l, sec);
  insertAfter(l, lastFilled(l.lines, sec), sec, added.map((f) => `${bullet}${renderForeshadowLine(f)}`));
  return { text: finish(l), added };
}

/** 同一條事件（重新定稿同一章時不重複記）：同章、同型別、同一條伏筆、證據歸一後相同（沒有證據比說明）。 */
function sameEvent(a: ThreadEvent, b: ThreadEvent): boolean {
  return (
    a.chapter === b.chapter &&
    a.planned === b.planned &&
    a.type === b.type &&
    threadKey(a.foreshadowing ?? '') === threadKey(b.foreshadowing ?? '') &&
    (a.evidence || b.evidence
      ? normalizeQuote(a.evidence ?? '') === normalizeQuote(b.evidence ?? '')
      : normalizeQuote(a.what) === normalizeQuote(b.what))
  );
}

/**
 * 在「進展」里加幾條事件（定稿記實際事件用）：按章號插（見 `insertEvents`），已經有的同一條跳過。
 * 沒有「進展」就在檔案末尾建一節。返回新原文與實際加了哪幾條。
 */
export function appendEvents(raw: string, events: readonly ThreadEvent[]): { text: string; added: ThreadEvent[] } {
  const base = raw ?? '';
  const existing = parseBody(parseMarkdown(base).body).events;
  const added: ThreadEvent[] = [];
  for (const e of events) {
    if (existing.some((x) => sameEvent(x, e)) || added.some((x) => sameEvent(x, e))) {
      continue;
    }
    added.push(e);
  }
  if (added.length === 0) {
    return { text: base, added };
  }
  const l = splitLines(base);
  for (const e of added) {
    const sec = ensureSection(l, 'events');
    insertEvents(l, sec, e, [eventRow(l, sec, e)]);
  }
  return { text: finish(l), added };
}

/**
 * 按章換計劃事件（細綱隨寫隨換，設計稿「隨細綱走」）：刪掉「進展」裡第 `chapter` 章的全部計劃事件，
 * 換成 `events`（都當計劃事件寫）。原來有的插回第一條原來的位置，沒有的按章號插。別的章、實際事件、
 * 認不出的行一行不動。`events` 為空就是隻刪。返回新原文與刪掉了幾行。
 */
export function replacePlannedEvents(
  raw: string,
  chapter: number,
  events: readonly Omit<ThreadEvent, 'planned' | 'chapter' | 'evidence'>[]
): { text: string; removed: number } {
  const base = raw ?? '';
  const l = splitLines(base);
  const found = findSection(l.lines, 'events');
  const rows = found ? eventRows(l, found).filter((r) => r.e.planned && r.e.chapter === chapter) : [];
  const fresh: ThreadEvent[] = events.map((e) => ({ ...e, chapter, planned: true }));
  if (rows.length === 0 && fresh.length === 0) {
    return { text: base, removed: 0 };
  }
  const bullet = bulletOf(l, found);
  const firstAt = rows[0]?.i;
  for (const r of [...rows].reverse()) {
    l.lines.splice(r.i, 1);
  }
  if (fresh.length > 0) {
    const rendered = fresh.map((e) => `${bullet}${renderEventLine(e)}`);
    if (firstAt !== undefined) {
      // 插回第一條原來的那一行：原來怎麼排版的（標題後面有沒有空行）就還是怎麼排。
      l.lines.splice(firstAt, 0, ...rendered);
    } else {
      insertEvents(l, ensureSection(l, 'events'), fresh[0], rendered);
    }
  }
  return { text: finish(l), removed: rows.length };
}

/**
 * 重新定稿第 `chapter` 章時清掉那一章機器記的、**證據已經不在正文裡**的實際事件（設計稿 ⚑7）。帶證據的
 * 實際事件當機器記的（作者手寫的可以沒有證據，那些不動）；計劃事件不動。返回新原文與刪掉的事件。
 * 舊版由閘道器先存一版歷史（`Workspace.overwrite`）。
 */
export function pruneChapterEvents(raw: string, chapter: number, text: string): { text: string; removed: ThreadEvent[] } {
  const base = raw ?? '';
  const l = splitLines(base);
  const sec = findSection(l.lines, 'events');
  if (!sec) {
    return { text: base, removed: [] };
  }
  const index = indexText(text);
  const gone = eventRows(l, sec).filter(
    (r) => !r.e.planned && r.e.chapter === chapter && r.e.evidence && !quoteFound(index, r.e.evidence)
  );
  if (gone.length === 0) {
    return { text: base, removed: [] };
  }
  for (const r of [...gone].reverse()) {
    l.lines.splice(r.i, 1);
  }
  return { text: joinLines(l), removed: gone.map((r) => r.e) };
}

/** 從一份檔案裡剪下來的一條伏筆：「伏筆」裡它那一行、「進展」裡它的事件，都是原樣的行（去掉了專案符號）。 */
export interface CutForeshadowing {
  row?: string;
  events: { line: string; e: ThreadEvent }[];
}

/**
 * 把一條伏筆從這份檔案裡剪下來（2026-10-24：「未歸屬的伏筆」被收的時候，掛到模型說的那條線上）：「伏筆」裡它那一行、「進展」裡
 * 它的全部事件（計劃的、實際的）。別的行一行不動。這份檔案裡沒有它返回 undefined。
 */
export function cutForeshadowing(raw: string, name: string): { text: string; cut: CutForeshadowing } | undefined {
  const base = raw ?? '';
  const key = threadKey(name);
  const l = splitLines(base);
  const gone: number[] = [];
  let row: string | undefined;
  const fore = findSection(l.lines, 'foreshadowing');
  if (fore) {
    for (let i = fore.head + 1; i < fore.end; i++) {
      const line = l.lines[i].replace(BULLET, '').trim();
      const f = line ? parseForeshadowLine(line) : undefined;
      if (f && threadKey(f.name) === key) {
        row = line;
        gone.push(i);
        break;
      }
    }
  }
  const sec = findSection(l.lines, 'events');
  const events = sec
    ? eventRows(l, sec)
        .filter((r) => r.e.foreshadowing && threadKey(r.e.foreshadowing) === key)
        .map((r) => ({ i: r.i, line: l.lines[r.i].replace(BULLET, '').trim(), e: r.e }))
    : [];
  if (row === undefined && events.length === 0) {
    return undefined;
  }
  for (const i of [...gone, ...events.map((x) => x.i)].sort((a, b) => b - a)) {
    l.lines.splice(i, 1);
  }
  return { text: joinLines(l), cut: { ...(row !== undefined ? { row } : {}), events: events.map(({ line, e }) => ({ line, e })) } };
}

/**
 * 把剪下來的那一條貼進另一份檔案：伏筆那一行接在「伏筆」末尾（沒有這一節就在「進展」前面建），事件按章號插進「進展」——行原樣，
 * 只換成這份檔案的專案符號。這份檔案裡已經有同名的伏筆就不貼那一行（事件照貼）。
 */
export function pasteForeshadowing(raw: string, cut: CutForeshadowing): string {
  const l = splitLines(raw ?? '');
  if (cut.row !== undefined) {
    const f = parseForeshadowLine(cut.row);
    const known = parseBody(parseMarkdown(raw ?? '').body).foreshadowing.some((x) => f && threadKey(x.name) === threadKey(f.name));
    if (!known) {
      const sec = ensureSection(l, 'foreshadowing', 'events');
      insertAfter(l, lastFilled(l.lines, sec), sec, [`${bulletOf(l, sec)}${cut.row}`]);
    }
  }
  for (const { line, e } of cut.events) {
    const sec = ensureSection(l, 'events');
    insertEvents(l, sec, e, [`${bulletOf(l, sec)}${line}`]);
  }
  return finish(l);
}

// ---------------------------------------------------------------- 排線：校驗模型的輸出

/** 一次最多排幾條線（上游 `PLAN_CANDIDATE_LIMIT`；提示詞要的是 3–8 條）。 */
export const THREAD_PLAN_LIMIT = 8;
/** 排線時一條線最多帶幾條伏筆。 */
export const PLAN_FORESHADOW_LIMIT = 5;
/** 伏筆「是什麼」最長多少字。 */
export const FORESHADOW_WHAT_MAX = 100;

/** {@link verifyThreadPlans} 給重名那一條的原因。完成提示裡把它和「不合格」分開說。 */
export const SAME_THREAD = '同名的線已經有了';

/** 欄位可能是數字，也可能是「3」這樣的字串。 */
function intOf(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) ? n : undefined;
}

function strOf(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
}

function cut(text: string, max: number): string {
  return [...text].slice(0, max).join('').trim();
}

/** 名字合不合格：1–{@link NAME_MAX} 字、不是保留名。合格返回空串。 */
function nameProblem(name: string): string {
  if (!name) {
    return '沒有名字';
  }
  if ([...name].length > NAME_MAX) {
    return `名字超過 ${NAME_MAX} 字`;
  }
  if (isReservedThreadName(name)) {
    return `「${isUnfiledName(name) ? UNFILED_NAME : TIMELINE_NAME}」是保留名`;
  }
  return '';
}

/** 全書已經有的伏筆名（各條線與「未歸屬的伏筆」裡登記的、只在事件裡出現過的都算）。排線、定稿認新伏筆時拿它去重。 */
export function foreshadowNames(book: ThreadBook): string[] {
  return [...book.threads, book.unfiled].flatMap((f) => foreshadowingOf(f, 0).map((x) => x.name));
}

/** 排線時沒收的一條（線或伏筆）與原因。 */
export interface PlanDrop {
  name: string;
  why: string;
}

/**
 * 排線時模型交回來的候選 → 能新建的線（設計稿「一、排線」）。
 *
 * **先逐條校驗、再取前 {@link THREAD_PLAN_LIMIT} 條**（七期修過的上游 #8：先截再校驗，前面幾條壞了，後面好的也跟著丟）：
 *
 * - 名字 1–30 字、不是「未歸屬的伏筆」，與已有的線、與同一批裡前面的重名就跳過（{@link SAME_THREAD}）；
 * - 種類必須是四種之一（認不出的不收：讀檔案時認不出當支線，那是容錯；排線時是模型沒照合同寫）；
 * - **全書只能有一條主線**：已經有了，或同一批裡前面已經排了一條，就不收；
 * - 意圖截到 {@link INTENT_MAX} 字，空的不收；計劃區間可以缺，給了就要 `1 ≤ from ≤ to`，知道總章數時不越界；
 * - 伏筆每條線最多 {@link PLAN_FORESHADOW_LIMIT} 條：名字同上，與全書已有的伏筆、同一批裡前面的重名跳過；
 *   「是什麼」截到 {@link FORESHADOW_WHAT_MAX} 字；埋 / 收的章號不合理的只去掉章號、伏筆照收。
 */
export function verifyThreadPlans(
  raw: readonly unknown[],
  existing: { threads: readonly Pick<Thread, 'name' | 'kind'>[]; foreshadowing: readonly string[] },
  totalChapters?: number
): { plans: NewThread[]; dropped: PlanDrop[]; foreshadowDropped: PlanDrop[] } {
  const seen = new Set(existing.threads.map((t) => threadKey(t.name)));
  let hasMain = existing.threads.some((t) => t.kind === '主线');
  const knownFore = new Set(existing.foreshadowing.map(threadKey));
  const plans: NewThread[] = [];
  const dropped: PlanDrop[] = [];
  const foreshadowDropped: PlanDrop[] = [];
  const inBook = (n: number | undefined): boolean => n !== undefined && n >= 1 && (!totalChapters || n <= totalChapters);
  for (const item of raw) {
    const o = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const name = strOf(o.title ?? o.name).replace(/^#+\s*/, '');
    const kind = threadKindOf(strOf(o.kind ?? o.type));
    const intent = cut(strOf(o.intent), INTENT_MAX);
    const from = intOf(o.from);
    const to = intOf(o.to);
    let why = nameProblem(name);
    if (!why && !kind) {
      why = '種類不是主線 / 支線 / 感情線 / 人物線之一';
    } else if (!why && !intent) {
      why = '意圖是空的';
    } else if (!why && ((o.from !== undefined && !inBook(from)) || (o.to !== undefined && !inBook(to)) || (from !== undefined && to !== undefined && to < from))) {
      why = totalChapters ? `計劃區間不對（全書 ${totalChapters} 章）` : '計劃區間不對';
    } else if (!why && seen.has(threadKey(name))) {
      why = SAME_THREAD;
    } else if (!why && kind === '主线' && hasMain) {
      why = '主線全書只能有一條，已經有了';
    }
    if (why) {
      dropped.push({ name: name || '（沒有名字）', why });
      continue;
    }
    seen.add(threadKey(name));
    if (plans.length >= THREAD_PLAN_LIMIT) {
      dropped.push({ name, why: `一次最多排 ${THREAD_PLAN_LIMIT} 條` });
      continue;
    }
    if (kind === '主线') {
      hasMain = true;
    }
    const foreshadowing: Foreshadowing[] = [];
    for (const f of Array.isArray(o.foreshadowing) ? o.foreshadowing : []) {
      const x = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
      const fname = strOf(x.title ?? x.name);
      const fwhy = nameProblem(fname) || (knownFore.has(threadKey(fname)) ? '同名的伏筆已經有了' : '');
      if (fwhy) {
        foreshadowDropped.push({ name: fname || '（沒有名字）', why: fwhy });
        continue;
      }
      if (foreshadowing.length >= PLAN_FORESHADOW_LIMIT) {
        foreshadowDropped.push({ name: fname, why: `一條線最多排 ${PLAN_FORESHADOW_LIMIT} 條伏筆` });
        continue;
      }
      knownFore.add(threadKey(fname));
      let plant = intOf(x.plant);
      let resolve = intOf(x.resolve);
      plant = inBook(plant) ? plant : undefined;
      resolve = inBook(resolve) && (plant === undefined || resolve! >= plant) ? resolve : undefined;
      foreshadowing.push({
        name: fname,
        what: cut(strOf(x.what), FORESHADOW_WHAT_MAX),
        ...(plant !== undefined ? { plant } : {}),
        ...(resolve !== undefined ? { resolve } : {}),
      });
    }
    plans.push({
      name,
      kind: kind!,
      origin: '计划',
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      intent,
      foreshadowing,
    });
  }
  return { plans, dropped, foreshadowDropped };
}

// ---------------------------------------------------------------- 定稿：送哪些去認、校驗認出來的東西

/** 定稿時一章最多記幾個事件（先校驗後截）。 */
export const FINALIZE_EVENT_LIMIT = 8;
/** 定稿時一章最多認出幾條新線。 */
export const FINALIZE_NEW_THREAD_LIMIT = 2;
/**
 * 定稿時一章最多認出幾條新伏筆。⚑ 試跑之後從 5 收到 3（2026-10-21）：模型報的新伏筆多半是章末危機、本章已經揭開的事、
 * 普通情節，一章就報了 4 條，沒收的伏筆第 7 章就超過了一次能認的條數，把排線排的伏筆擠了出去。
 */
export const FINALIZE_NEW_FORESHADOW_LIMIT = 3;
/** 證據最長多少字（上游 240）。 */
export const EVIDENCE_MAX = 240;
/** 事件那一句話最長多少字。 */
export const EVENT_WHAT_MAX = 100;

/** 送去認的一條伏筆：它是什麼、掛在哪條線上（缺席是「未歸屬的伏筆」）、寫到這一章時的狀態。 */
export interface JudgedForeshadow extends ForeshadowState {
  line?: string;
}

/** 這一章的計劃事件（各條線與「未歸屬的伏筆」裡第 `no` 章、帶「計劃 ·」的），帶它在哪條線上（缺席是未歸屬）。 */
export function plannedFor(book: ThreadBook, no: number): { line?: string; event: ThreadEvent }[] {
  return [
    ...book.threads.flatMap((t) => plannedEvents(t).filter((e) => e.chapter === no).map((event) => ({ line: t.name, event }))),
    ...plannedEvents(book.unfiled).filter((e) => e.chapter === no).map((event) => ({ event })),
  ];
}

/**
 * 定稿第 `no` 章時送哪幾條線去認（設計稿「三、a」）：寫到這一章時還沒收束的（{@link asOf}），按要緊排——本章有計劃事件的
 * → 本章細綱提到了名字的 → 主線 → 最近動過的（近的在前）→ 其餘按檔名；最多 `limit` 條（上下文詳細度 `threadJudge`）。
 * 返回的是 asOf 之後的樣子（不帶這一章及以後的事件、寫到這一章或更晚的當前進度）。
 */
export function threadsToJudge(
  book: ThreadBook,
  no: number,
  plotText: string,
  limit: number
): { judged: Thread[]; skipped: Thread[] } {
  const plan = new Set(plannedFor(book, no).map((p) => p.line && threadKey(p.line)));
  const plot = normalizeQuote(plotText);
  const open = book.threads.map((t) => asOf(t, no)).filter((t) => !isClosed(threadStatus(t)));
  const rank = (t: Thread): number => {
    const key = threadKey(t.name);
    if (plan.has(key)) {
      return 0;
    }
    if (key.length >= 2 && plot.includes(key)) {
      return 1;
    }
    return t.kind === '主线' ? 2 : 3;
  };
  const ordered = [...open].sort(
    (a, b) => rank(a) - rank(b) || (lastActiveChapter(b) ?? 0) - (lastActiveChapter(a) ?? 0) || a.index - b.index
  );
  const n = Math.max(0, limit);
  return { judged: ordered.slice(0, n), skipped: ordered.slice(n) };
}

/**
 * 寫到第 `no` 章時還沒收、也沒棄的伏筆（各條線與「未歸屬的伏筆」裡的都算，線收束了伏筆照樣可能還開著），帶掛在哪條線上、
 * 寫到這一章時的狀態。定稿送去認（{@link foreshadowToJudge}）與歸併的候選（c，{@link verifyMerges}）共用。
 */
export function openForeshadowing(book: ThreadBook, no: number): JudgedForeshadow[] {
  return [
    ...book.threads.flatMap((t) => foreshadowingOf(asOf(t, no), no - 1, t.events).map((f) => ({ ...f, line: t.name }))),
    ...foreshadowingOf(asOf(book.unfiled, no), no - 1, book.unfiled.events).map((f) => ({ ...f })),
  ].filter((f) => !isForeshadowClosed(f.status));
}

/**
 * 定稿第 `no` 章時送哪幾條伏筆去認：寫到這一章時還沒收、也沒棄的（{@link openForeshadowing}），按要緊排，最多 `limit` 條
 * （上下文詳細度 `foreshadowJudge`）：
 *
 * 1. **本章計劃埋或收的**（拆細綱寫進線裡的這一章的計劃事件）；
 * 2. **計劃已經到期、卻還沒埋的**：計劃埋的章 ≤ 本章（沒寫埋的章、只寫了回收章的，回收章 ≤ 本章也算），到期早的在前；
 * 3. **已埋沒收的**：計劃回收章近的在前（逾期的回收章更早，排得更前），沒寫回收章的排在後面、埋得近的在前；
 * 4. 其餘（計劃還沒到期的）。
 *
 * 試跑之後改的（2026-10-21）：從前只看計劃事件與回收章，不看伏筆自己的計劃埋的章——排線排的伏筆沒埋時落在最末一檔，
 * 被模型自己登記的一堆「已埋」擠出去，「夥計的執念來源」計劃第 8 章埋，第 8 章恰好沒送去認。
 */
export function foreshadowToJudge(
  book: ThreadBook,
  no: number,
  limit: number
): { judged: JudgedForeshadow[]; skipped: JudgedForeshadow[] } {
  const planned = new Set(
    plannedFor(book, no)
      .filter((p) => p.event.foreshadowing)
      .map((p) => threadKey(p.event.foreshadowing!))
  );
  /** 計劃到期的那一章：計劃埋的章，沒寫就是回收章（埋總在收之前）。推遲過的按推遲到的那一章。 */
  const dueAt = (f: JudgedForeshadow): number | undefined => f.plantBy ?? f.resolveBy;
  const rank = (f: JudgedForeshadow): number => {
    if (planned.has(threadKey(f.name))) {
      return 0;
    }
    if (f.status === '计划') {
      const due = dueAt(f);
      return due !== undefined && due <= no ? 1 : 3;
    }
    return 2;
  };
  /** 同一檔裡的先後：越小越前。 */
  const order = (f: JudgedForeshadow, r: number): number[] =>
    r === 1 ? [dueAt(f)!] : r === 2 ? [f.resolveBy ?? Number.POSITIVE_INFINITY, -(f.plantedAt ?? 0)] : [];
  const ordered = openForeshadowing(book, no)
    .map((f, i) => ({ f, i, r: rank(f) }))
    .sort((a, b) => {
      if (a.r !== b.r) {
        return a.r - b.r;
      }
      const x = order(a.f, a.r);
      const y = order(b.f, b.r);
      for (let k = 0; k < x.length; k++) {
        if (x[k] !== y[k]) {
          return x[k] < y[k] ? -1 : 1;
        }
      }
      return a.i - b.i;
    })
    .map((x) => x.f);
  const n = Math.max(0, limit);
  return { judged: ordered.slice(0, n), skipped: ordered.slice(n) };
}

/** 定稿認出的一條事件：落在哪條線上（缺席是「未歸屬的伏筆」）。 */
export interface FoundEvent {
  line?: string;
  event: ThreadEvent;
}

/** 定稿從正文裡認出的一條新線。 */
export interface FoundThread {
  name: string;
  kind: ThreadKind;
  intent: string;
  evidence: string;
}

/** 定稿從正文裡認出的一條新伏筆：掛在哪條線上（已有的或這一次新認出的；缺席是「未歸屬的伏筆」）。 */
export interface FoundForeshadow {
  name: string;
  what: string;
  line?: string;
  evidence: string;
}

/** 定稿第三步 a 認出來、校驗過的全部。 */
export interface ThreadFinds {
  events: FoundEvent[];
  newThreads: FoundThread[];
  newForeshadowing: FoundForeshadow[];
  /** 沒收的：哪一條、為什麼（第 2 條：說出來）。 */
  dropped: { what: string; why: string }[];
  /** 證據逐字找不到、換成了正文裡最接近的原句的（`from` 模型給的，`to` 換成的原文）。沒有就缺席。 */
  relocated?: { from: string; to: string }[];
  /**
   * 要從「未歸屬的伏筆」挪到線上的伏筆（2026-10-24）：這一章收了、棄了它，模型說它在送去認的哪一條線上。寫盤時整條剪過去
   * （`cutForeshadowing` / `pasteForeshadowing`），這一章的那條事件也落在那條線上。沒有就缺席。
   */
  rehomed?: { name: string; line: string }[];
}

function unquoteEvidence(v: unknown): string {
  return cut(unquote(strOf(v)), EVIDENCE_MAX);
}

/**
 * 定稿第三步 a 的輸出 → 能記的東西（設計稿「三、a」）。沿用七期 `verifyThreadEvents` 的口徑並擴到新線與新伏筆：
 *
 * - **證據**按審稿那套歸一化後至少 4 個字、在**整章**正文裡找得到（七期修過的上游 #11）；截到 {@link EVIDENCE_MAX} 字。
 *   逐字找不到的，在正文裡找最接近的一句（或連著的兩句），夠像（`NEAR_QUOTE_MIN`）就換成那一段原文收下（⚑ 復跑之後：
 *   丟掉的多半隻是把「他」換成了人名、兩句拼成一句）。還是沒有原文撐著的多半是編的，丟掉並說原因。
 * - **新線**：名字合格、種類是四種之一、與已有的線不重名；**主線已有就不收新主線**；一章最多 {@link FINALIZE_NEW_THREAD_LIMIT} 條。
 * - **新伏筆**：名字合格、與全書已有的伏筆不重名；`line` 認得出（已有的線、或這一次新認出的線）就掛上去，認不出的進
 *   「未歸屬的伏筆」；一章最多 {@link FINALIZE_NEW_FORESHADOW_LIMIT} 條。
 * - **事件**：型別認得出。線的事件（推進 / 關係 / 收束 / 放棄）的 `line` 要是送去認的線之一、或這一次新認出的線，掛不上的
 *   丟掉（關係變動掛不上就丟，設計稿）；伏筆的事件（埋 / 收 / 棄）跟著那條伏筆走——落在它所在的那條線或「未歸屬的伏筆」
 *   上；沒見過的伏筆被「埋」了，當它是一條新伏筆（照上一條掛）；沒見過的被「收」「棄」丟掉；**寫到這一章之前已經埋下的
 *   再「埋」一次丟掉**（試跑：同一條伏筆記了兩次「埋」）；**還沒埋下的被「收」「棄」丟掉**（復跑：「計劃」狀態的伏筆第 1 章
 *   就被「收」掉了）——之前埋過、或者這一章有它的「埋」才算埋下。同一條（同一處、同型別、同一條伏筆、證據歸一後相同）只記一次；
 *   一章最多 {@link FINALIZE_EVENT_LIMIT} 個（先校驗後截）。**「未歸屬的伏筆」被收、被棄**，`line` 又是送去認的線之一的，挪到那條線上
 *   （`rehomed`，2026-10-24：從前 `line` 一律不看，掛不上的伏筆收了也一直在未歸屬裡）。
 *
 * `judged` 是送去認的線（只有它們收線的事件）；`book` 用來認全書已有的線名與伏筆名。
 */
export function verifyFinds(
  raw: unknown,
  ctx: { chapter: number; text: string; judged: readonly Pick<Thread, 'name'>[]; book: ThreadBook }
): ThreadFinds {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const list = (v: unknown): Record<string, unknown>[] =>
    (Array.isArray(v) ? v : []).map((x) => (x && typeof x === 'object' ? x : {}) as Record<string, unknown>);
  const index = indexText(ctx.text);
  const evidenceWhy = (evidence: string): string =>
    quoteFound(index, evidence) ? '' : normalizeQuote(evidence).length < 4 ? '證據太短，認不出是哪一句' : '證據在正文裡找不到';
  const out: ThreadFinds = { events: [], newThreads: [], newForeshadowing: [], dropped: [] };
  /**
   * 證據逐字找不到時，換成正文裡最接近的那一句（或連著的兩句）原文（⚑ 復跑之後，model/continuity.ts 的 `nearestSentence`，
   * 照定稿掛連續性事實證據那一套）：復跑裡丟掉的 7 條多半隻是把「他」換成了人名、刪了幾個字、兩句拼成一句。夠像才換，
   * 不夠像照舊丟（`evidenceWhy`）。同一句只找一次；換過的哪幾條最後記在 `relocated` 裡（呼叫方寫日誌）。
   */
  const settled = new Map<string, string>();
  const relocatedFrom = new Map<string, string>();
  const settle = (evidence: string): string => {
    if (!evidence || quoteFound(index, evidence)) {
      return evidence;
    }
    let fixed = settled.get(evidence);
    if (fixed === undefined) {
      const near = nearestSentence(ctx.text, evidence, EVIDENCE_MAX);
      fixed = near ? near.sentence : evidence;
      settled.set(evidence, fixed);
      if (near) {
        relocatedFrom.set(fixed, evidence);
      }
    }
    return fixed;
  };

  const allThreads = new Map(ctx.book.threads.map((t) => [threadKey(t.name), t.name]));
  const judged = new Map(ctx.judged.map((t) => [threadKey(t.name), t.name]));
  /** 全書已有的伏筆：名字 → 掛在哪條線上（缺席是未歸屬）。 */
  const knownFore = new Map<string, { name: string; line?: string }>();
  for (const t of ctx.book.threads) {
    for (const f of foreshadowingOf(t, 0)) {
      knownFore.set(threadKey(f.name), { name: f.name, line: t.name });
    }
  }
  for (const f of foreshadowingOf(ctx.book.unfiled, 0)) {
    if (!knownFore.has(threadKey(f.name))) {
      knownFore.set(threadKey(f.name), { name: f.name });
    }
  }
  /** 寫到這一章之前已經埋下的伏筆埋在第幾章：再報一次「埋」不記（試跑報告第 11 條：同一條伏筆記了兩次「埋」）。 */
  const plantedBefore = new Map<string, number>();
  for (const f of [...ctx.book.threads, ctx.book.unfiled]) {
    for (const s of foreshadowingOf(asOf(f, ctx.chapter), 0)) {
      if (s.plantedAt !== undefined && !plantedBefore.has(threadKey(s.name))) {
        plantedBefore.set(threadKey(s.name), s.plantedAt);
      }
    }
  }

  // 新線先校驗：事件與新伏筆可能掛在它上面。
  let mainTaken = ctx.book.threads.some((t) => t.kind === '主线');
  const newLines = new Map<string, string>();
  for (const x of list(o.newThreads)) {
    const name = strOf(x.title ?? x.name);
    const kind = threadKindOf(strOf(x.kind ?? x.type));
    const evidence = settle(unquoteEvidence(x.evidence));
    let why = nameProblem(name);
    if (!why && allThreads.has(threadKey(name))) {
      why = '這條線已經有了';
    } else if (!why && newLines.has(threadKey(name))) {
      why = '同一章裡報了兩次';
    } else if (!why && !kind) {
      why = '種類不是主線 / 支線 / 感情線 / 人物線之一';
    } else if (!why && kind === '主线' && mainTaken) {
      why = '主線全書只能有一條，已經有了';
    } else if (!why) {
      why = evidenceWhy(evidence);
    }
    if (!why && out.newThreads.length >= FINALIZE_NEW_THREAD_LIMIT) {
      why = `一章最多認出 ${FINALIZE_NEW_THREAD_LIMIT} 條新線`;
    }
    if (why) {
      out.dropped.push({ what: `新線 ${name || '（沒有名字）'}`, why });
      continue;
    }
    mainTaken ||= kind === '主线';
    newLines.set(threadKey(name), name);
    out.newThreads.push({ name, kind: kind!, intent: cut(strOf(x.intent), INTENT_MAX), evidence });
  }
  /** `line` 認到哪條線上：已有的線、這一次新認出的線；認不出是 undefined。 */
  const lineOf = (v: unknown): string | undefined => {
    const key = threadKey(strOf(v));
    return key ? (allThreads.get(key) ?? newLines.get(key)) : undefined;
  };

  const newFore = new Map<string, FoundForeshadow>();
  const addForeshadow = (name: string, what: string, line: string | undefined, evidence: string): string => {
    let why = nameProblem(name);
    if (!why && (knownFore.has(threadKey(name)) || newFore.has(threadKey(name)))) {
      why = '這條伏筆已經有了';
    } else if (!why) {
      why = evidenceWhy(evidence);
    }
    if (!why && out.newForeshadowing.length >= FINALIZE_NEW_FORESHADOW_LIMIT) {
      why = `一章最多認出 ${FINALIZE_NEW_FORESHADOW_LIMIT} 條新伏筆`;
    }
    if (why) {
      return why;
    }
    const f: FoundForeshadow = { name, what: cut(what, FORESHADOW_WHAT_MAX), ...(line ? { line } : {}), evidence };
    newFore.set(threadKey(name), f);
    out.newForeshadowing.push(f);
    return '';
  };
  for (const x of list(o.newForeshadowing)) {
    const name = strOf(x.title ?? x.name);
    const why = addForeshadow(name, strOf(x.what), lineOf(x.line ?? x.thread), settle(unquoteEvidence(x.evidence)));
    if (why) {
      out.dropped.push({ what: `新伏筆 ${name || '（沒有名字）'}`, why });
    }
  }

  /**
   * 這一章埋下的伏筆（復跑之後，2026-10-21）：「收」「棄」要排在「埋」之後——之前埋過（{@link plantedBefore}），或者這一章
   * 有它的「埋」（模型這一次報的、證據找得到的「埋」；重新定稿時這一章已經記下的「埋」；這一章新認出的伏筆，補的那一條「埋」）。
   * 復跑：兩條排線排的伏筆第 1 章還是「計劃」就被報了「收」，照收了，從此再也不提醒「第 b 章前不要揭開」。
   */
  const plantedHere = new Set<string>(newFore.keys());
  for (const x of list(o.events)) {
    if (eventTypeOf(strOf(x.type)) === '埋' && strOf(x.foreshadowing) && !evidenceWhy(settle(unquoteEvidence(x.evidence)))) {
      plantedHere.add(threadKey(strOf(x.foreshadowing)));
    }
  }
  for (const f of [...ctx.book.threads, ctx.book.unfiled]) {
    for (const e of actualEvents(f)) {
      if (e.chapter === ctx.chapter && e.type === '埋' && e.foreshadowing) {
        plantedHere.add(threadKey(e.foreshadowing));
      }
    }
  }

  const accepted: FoundEvent[] = [];
  const rehomed = new Map<string, { name: string; line: string }>();
  for (const x of list(o.events)) {
    let moving: { name: string; line: string } | undefined;
    const lineName = strOf(x.line ?? x.thread);
    const type = eventTypeOf(strOf(x.type));
    const foreName = strOf(x.foreshadowing);
    const what = cut(strOf(x.what ?? x.reason), EVENT_WHAT_MAX);
    const evidence = settle(unquoteEvidence(x.evidence));
    const label = foreName ? `${lineName || '？'}〈${foreName}〉` : lineName || '（沒有寫是哪一條線）';
    let why = !type ? '事件型別認不出' : evidenceWhy(evidence);
    let found: FoundEvent | undefined;
    if (!why && isForeshadowEvent(type!)) {
      const key = threadKey(foreName);
      const known = knownFore.get(key) ?? newFore.get(key);
      if (!foreName) {
        why = '沒寫是哪一條伏筆';
      } else if (known && type === '埋' && plantedBefore.has(key)) {
        why = `這條伏筆第 ${plantedBefore.get(key)} 章已經埋下`;
      } else if (known && type !== '埋' && !plantedBefore.has(key) && !plantedHere.has(key)) {
        why = `這條伏筆還沒埋下，不能${traditionalLabel(type)}`;
      } else if (known) {
        // 未歸屬的被收、被棄，模型說了在哪條送去認的線上：挪過去（記下了才算，見下面）。
        const home = !known.line && type !== '埋' ? judged.get(threadKey(lineName)) : undefined;
        if (home && !rehomed.has(key)) {
          moving = { name: known.name, line: home };
        }
        found = { ...(known.line ? { line: known.line } : {}), event: { chapter: ctx.chapter, planned: false, type: type!, foreshadowing: known.name, what, evidence } };
      } else if (type === '埋') {
        // 沒見過的伏筆被埋下了：它就是一條新伏筆，照 `line` 掛。
        const line = lineOf(lineName);
        why = addForeshadow(foreName, what, line, evidence);
        if (!why) {
          found = { ...(line ? { line } : {}), event: { chapter: ctx.chapter, planned: false, type: '埋', foreshadowing: foreName, what, evidence } };
        }
      } else {
        why = '認不出是哪一條伏筆';
      }
    } else if (!why) {
      const key = threadKey(lineName);
      const line = judged.get(key) ?? newLines.get(key);
      if (line) {
        found = { line, event: { chapter: ctx.chapter, planned: false, type: type!, what, evidence } };
      } else {
        why = allThreads.has(key) ? '這條線已經收束，或這一次沒送去認' : '認不出是哪一條線';
      }
    }
    if (why || !found) {
      out.dropped.push({ what: label, why: why || '認不出' });
      continue;
    }
    const dup = accepted.some(
      (a) => threadKey(a.line ?? '') === threadKey(found!.line ?? '') && sameEvent(a.event, found!.event)
    );
    if (dup) {
      continue;
    }
    if (accepted.length >= FINALIZE_EVENT_LIMIT) {
      out.dropped.push({ what: label, why: `一章最多記 ${FINALIZE_EVENT_LIMIT} 個事件` });
      continue;
    }
    accepted.push(found);
    if (moving) {
      rehomed.set(threadKey(moving.name), moving);
    }
  }
  // 挪走的那幾條，這一章它們的事件（前後哪一條都算，「埋」「收」同一章報的也在）都落在挪去的那條線上。
  out.events = accepted.map((e) => {
    const home = e.event.foreshadowing ? rehomed.get(threadKey(e.event.foreshadowing)) : undefined;
    return home ? { ...e, line: home.line } : e;
  });
  if (rehomed.size > 0) {
    out.rehomed = [...rehomed.values()];
  }
  const used = new Set([...accepted.map((e) => e.event.evidence ?? ''), ...out.newThreads.map((t) => t.evidence), ...out.newForeshadowing.map((f) => f.evidence)]);
  const relocated = [...relocatedFrom].filter(([to]) => used.has(to)).map(([to, from]) => ({ from, to }));
  if (relocated.length > 0) {
    out.relocated = relocated;
  }
  return out;
}

/** 歸併：一條新線 / 新伏筆其實是已有的哪一條（c 的輸出校驗過之後）。 */
export interface ThreadMerge {
  kind: 'thread' | 'foreshadowing';
  from: string;
  into: string;
  /** 並進去了、這一章卻沒有另記什麼時，說清為什麼（完成提示照它說，不說「並進了」卻什麼都沒寫）。 */
  note?: string;
  /** 模型給的理由（只進日誌）。 */
  reason?: string;
}

/** 歸併理由最長多少字（只進日誌）。 */
const MERGE_REASON_MAX = 60;

/**
 * 兩個伏筆名有沒有一個相同的詞（去掉「的之與和及」之後的兩字詞，{@link wordGroups}）。歸併的一道程式檢查（⚑ 復跑之後）：名字就是
 * 身份，同一個謎底換個說法，名字裡多半還留著那個關鍵的詞（「紅姑的燈」→「紅姑的監視」、「祠堂地下祭壇」→「祠堂的隱秘」）；
 * 復跑裡並錯的兩次名字一個字都不沾（「紅姑的燈」→「大霧中的呼嘯聲」、「沈默的容器身份」→「屍斑的出現」）。
 */
export function namesShareWord(a: string, b: string): boolean {
  const own = new Set(wordGroups(a).flatMap(gramsOf));
  return wordGroups(b).flatMap(gramsOf).some((g) => own.has(g));
}

/**
 * 歸併（c）的輸出 → 認得出的幾條：`new` 是這一次新認出的線或伏筆的名字，`into` 是同一類裡已有的那一條（線並進線、伏筆並進
 * 伏筆）；一個新名字只並一次。認不出的丟掉——不併就是照新的建，什麼都不會丟。
 *
 * 伏筆只能並進寫到第 `chapter` 章時**還沒收、也沒棄**的那幾條（{@link openForeshadowing}，送給 c 的也只有這幾條）：並進收了的，
 * 這一章新露出來的東西就沒了著落（「埋」不會再記）。線不限：收束了的線又被正文接上，並進去就是它重新動了。
 *
 * **更保守**（⚑ 復跑之後：並了 2 次，2 次都錯，修復 3 以後並錯的「埋」會記到已有伏筆上）：
 * - 一律要模型給出理由（`reason`：兩條共同指向的那一個謎底），沒給的不併；
 * - 伏筆的兩個名字至少要有一個相同的詞（{@link namesShareWord}），一個字都不沾的不併。
 * 沒採納的寫進 `rejected`（呼叫方記日誌），照新的建。
 */
export function verifyMerges(
  raw: readonly unknown[],
  finds: ThreadFinds,
  book: ThreadBook,
  chapter: number,
  rejected: { what: string; why: string }[] = []
): ThreadMerge[] {
  const newThreads = new Map(finds.newThreads.map((t) => [threadKey(t.name), t.name]));
  const newFore = new Map(finds.newForeshadowing.map((f) => [threadKey(f.name), f.name]));
  const threads = new Map(book.threads.map((t) => [threadKey(t.name), t.name]));
  const fore = new Map(openForeshadowing(book, chapter).map((f) => [threadKey(f.name), f.name]));
  const out: ThreadMerge[] = [];
  const done = new Set<string>();
  for (const item of raw) {
    const x = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const from = threadKey(strOf(x.new ?? x.from));
    const into = threadKey(strOf(x.into ?? x.existing));
    const reason = cut(strOf(x.reason), MERGE_REASON_MAX);
    if (!from || done.has(from)) {
      continue;
    }
    let merge: ThreadMerge | undefined;
    if (newThreads.has(from) && threads.has(into)) {
      merge = { kind: 'thread', from: newThreads.get(from)!, into: threads.get(into)!, ...(reason ? { reason } : {}) };
    } else if (newFore.has(from) && fore.has(into)) {
      merge = { kind: 'foreshadowing', from: newFore.get(from)!, into: fore.get(into)!, ...(reason ? { reason } : {}) };
    }
    if (!merge) {
      continue;
    }
    const why = !reason
      ? '沒說為什麼是同一件事'
      : merge.kind === 'foreshadowing' && !namesShareWord(merge.from, merge.into)
        ? '兩個名字裡沒有一個相同的詞'
        : '';
    if (why) {
      rejected.push({ what: `〈${merge.from}〉→〈${merge.into}〉${reason ? `（${reason}）` : ''}`, why });
      continue;
    }
    out.push(merge);
    done.add(from);
  }
  return out;
}

/**
 * 補出來的「埋」插在同一條伏筆這一章的別的事件前面：同一章裡狀態取寫在後面的那條，「收」後面跟一條「埋」會把收了的
 * 算回「已埋」。這一章沒有它的別的事件就放在最後。
 */
function plantFirst(events: FoundEvent[], plant: FoundEvent): void {
  const key = threadKey(plant.event.foreshadowing ?? '');
  const at = events.findIndex((e) => threadKey(e.event.foreshadowing ?? '') === key);
  events.splice(at >= 0 ? at : events.length, 0, plant);
}

/**
 * 把歸併用上（第 `chapter` 章定稿）：並掉的新線不建，掛在它上面的事件、新伏筆改掛到已有的那條線；並掉的新伏筆不登記，它的
 * 事件改叫已有的那條伏筆、落到那條伏筆所在的線（或「未歸屬的伏筆」）上。返回新的一份（原來的不動）與帶上說明的歸併。
 *
 * **新伏筆的那一條「埋」掛到已有的那條伏筆上**（試跑：模型多半隻把新伏筆寫在 `newForeshadowing` 裡、不單列「埋」，隱含的
 * 那一條要等 {@link completeFinds} 補——並掉的已經不在新伏筆裡了，這一章的記錄整條沒了，完成提示卻照樣說「並進了」）：
 * - 已有的那條寫到這一章時還沒埋：這一章就是它埋下的一章，記一條「埋〈已有的〉」（證據、一句話用新伏筆的；模型單列了
 *   「埋」的，那一條改叫已有的名字），同一章只記一條；
 * - 已經埋過了（或已經收了、棄了）：**不再記第二條「埋」**，`note` 裡說清「第 N 章已經埋下，這一章不再記「埋」」——如實不記，
 *   不編一條別的事件出來（⚑）；模型給這條新伏筆報的別的事件（收、棄）照樣改名記下。
 * 並掉的新線這一章一個事件都沒帶過來（也沒有新伏筆掛在它上面）的，`note` 說「這一章沒有另記事件」：不替它編一條推進。
 */
export function applyMerges(
  finds: ThreadFinds,
  merges: readonly ThreadMerge[],
  book: ThreadBook,
  chapter: number
): { finds: ThreadFinds; merges: ThreadMerge[] } {
  if (merges.length === 0) {
    return { finds, merges: [] };
  }
  const lineInto = new Map(merges.filter((m) => m.kind === 'thread').map((m) => [threadKey(m.from), m.into]));
  const foreInto = new Map(merges.filter((m) => m.kind === 'foreshadowing').map((m) => [threadKey(m.from), m.into]));
  const ownerOf = new Map<string, string | undefined>();
  /** 寫到這一章之前已經不是「計劃」的伏筆：埋了（埋在第幾章）、收了、棄了。 */
  const before = new Map<string, ForeshadowState>();
  for (const file of [...book.threads, book.unfiled]) {
    const line = file === book.unfiled ? undefined : file.name;
    for (const f of foreshadowingOf(file, 0)) {
      if (!ownerOf.has(threadKey(f.name))) {
        ownerOf.set(threadKey(f.name), line);
      }
    }
    for (const f of foreshadowingOf(asOf(file, chapter), 0)) {
      if (f.status !== '计划' && !before.has(threadKey(f.name))) {
        before.set(threadKey(f.name), f);
      }
    }
  }
  const relink = (line: string | undefined): string | undefined => (line ? (lineInto.get(threadKey(line)) ?? line) : line);
  const plantedHere = (list: readonly FoundEvent[], name: string): boolean =>
    list.some((e) => e.event.type === '埋' && threadKey(e.event.foreshadowing ?? '') === threadKey(name));
  const events: FoundEvent[] = [];
  for (const e of finds.events) {
    const fore = e.event.foreshadowing;
    const into = fore ? foreInto.get(threadKey(fore)) : undefined;
    if (into) {
      // 已有的那條已經埋過、或這一章已經記了它的一條「埋」：不再記一條。
      if (e.event.type === '埋' && (before.has(threadKey(into)) || plantedHere(events, into))) {
        continue;
      }
      const line = ownerOf.get(threadKey(into));
      events.push({ ...(line ? { line } : {}), event: { ...e.event, foreshadowing: into } });
      continue;
    }
    const line = relink(e.line);
    events.push({ ...(line ? { line } : {}), event: e.event });
  }
  const out: ThreadMerge[] = [];
  for (const m of merges) {
    if (m.kind === 'foreshadowing') {
      const done = before.get(threadKey(m.into));
      if (done) {
        const when = done.plantedAt ?? done.closedAt;
        const what = done.status === '已埋' ? '埋下' : done.status === '已收' ? '收了' : '棄了';
        out.push({ ...m, note: `〈${m.into}〉${when !== undefined ? `第 ${when} 章` : ''}已經${what}，這一章不再記「埋」` });
        continue;
      }
      const f = finds.newForeshadowing.find((x) => threadKey(x.name) === threadKey(m.from));
      if (f && !plantedHere(events, m.into)) {
        const line = ownerOf.get(threadKey(m.into));
        plantFirst(events, {
          ...(line ? { line } : {}),
          event: { chapter, planned: false, type: '埋', foreshadowing: m.into, what: f.what || f.name, evidence: f.evidence },
        });
      }
      out.push({ ...m });
    } else {
      const carried =
        finds.events.some((e) => threadKey(e.line ?? '') === threadKey(m.from)) ||
        finds.newForeshadowing.some((f) => threadKey(f.line ?? '') === threadKey(m.from));
      out.push(carried ? { ...m } : { ...m, note: '這一章沒有另記事件' });
    }
  }
  const dedup: FoundEvent[] = [];
  for (const e of events) {
    if (!dedup.some((d) => threadKey(d.line ?? '') === threadKey(e.line ?? '') && sameEvent(d.event, e.event))) {
      dedup.push(e);
    }
  }
  return {
    finds: {
      events: dedup,
      newThreads: finds.newThreads.filter((t) => !lineInto.has(threadKey(t.name))),
      newForeshadowing: finds.newForeshadowing
        .filter((f) => !foreInto.has(threadKey(f.name)))
        .map((f) => {
          const line = relink(f.line);
          return { name: f.name, what: f.what, ...(line ? { line } : {}), evidence: f.evidence };
        }),
      dropped: finds.dropped,
      ...(finds.relocated ? { relocated: finds.relocated } : {}),
      ...(finds.rehomed ? { rehomed: finds.rehomed } : {}),
    },
    merges: out,
  };
}

/**
 * 補上隱含的那一條事件：新認出的線這一章一個事件都沒有，記一條「推進」（認出它的那一句就是證據）；新認出的伏筆這一章
 * 沒有「埋」，記一條「埋」（插在它這一章別的事件前面）。這樣狀態現算得出來（新線進行中、新伏筆已埋），不另記一份「從哪一章起」。
 * 要在 {@link applyMerges} 之後調：並掉的新伏筆那一條「埋」由 applyMerges 掛到已有的那條上。
 */
export function completeFinds(finds: ThreadFinds, chapter: number): ThreadFinds {
  const events = [...finds.events];
  for (const t of finds.newThreads) {
    if (!events.some((e) => threadKey(e.line ?? '') === threadKey(t.name))) {
      events.push({ line: t.name, event: { chapter, planned: false, type: '推进', what: '正文裡第一次出現', evidence: t.evidence } });
    }
  }
  for (const f of finds.newForeshadowing) {
    const planted = events.some((e) => e.event.type === '埋' && threadKey(e.event.foreshadowing ?? '') === threadKey(f.name));
    if (!planted) {
      plantFirst(events, {
        ...(f.line ? { line: f.line } : {}),
        event: { chapter, planned: false, type: '埋', foreshadowing: f.name, what: f.what, evidence: f.evidence },
      });
    }
  }
  return { ...finds, events };
}

/** 行首的標籤（`【線】`、`線名：`）與末尾的一段括號（`（主線）`、`(支線)`、`〈…〉`、`【…】`、`[…]`、`<…>`）。 */
const NAME_LABEL = /^\s*(?:【\s*(?:线|線)名?\s*】|(?:线|線)名?\s*[:：])\s*/u;
const NAME_TAIL = /\s*(?:（[^（）]*）|\([^()]*\)|〈[^〈〉]*〉|<[^<>]*>|【[^【】]*】|\[[^\[\]]*\])\s*$/u;

/**
 * 模型回線名時常帶的裝飾去掉之後的樣子（試跑：提示裡寫成「名字（種類）」，模型照抄「沈默的滅門復仇（主線）」）：
 * 行首的「【線】」「線名：」、前後的引號與書名號、末尾一段段的括號，剝到不再變為止。只拿來認名字，不寫進檔案。
 */
export function bareThreadName(raw: string): string {
  let s = (raw ?? '').trim().replace(NAME_LABEL, '');
  for (let prev = ''; prev !== s; ) {
    prev = s;
    s = unquote(s).replace(/^《(.*)》$/u, '$1').replace(NAME_TAIL, '').trim();
  }
  return s;
}

/**
 * 當前進度（b）的輸出：哪條線、新的當前進度（截到 {@link PROGRESS_MAX} 字）。名字認不出、空的丟掉。
 *
 * 名字認得寬（試跑 22 條只落盤 1 條，第 2 條：不靜默丟）：先按原樣比，對不上再去掉裝飾（{@link bareThreadName}）
 * 比，還對不上、末尾又正好是一個種類名（「名字 · 主線」歸一之後是「名字主線」）就去掉種類再比。送去的線之間
 * 原樣對得上的優先，所以一條線就叫「某某主線」也不會認錯。認不出的由呼叫方對著送去的那幾條說出來。
 */
export function verifyProgress(raw: readonly unknown[], lines: readonly string[]): { line: string; text: string }[] {
  const byKey = new Map(lines.map((n) => [threadKey(n), n]));
  const lineOf = (name: string): string | undefined => {
    const bare = threadKey(bareThreadName(name));
    const kind = THREAD_KINDS.find((k) => bare.length > k.length && (bare.endsWith(k) || bare.endsWith(traditionalLabel(k))));
    return byKey.get(threadKey(name)) ?? byKey.get(bare) ?? (kind ? byKey.get(bare.slice(0, -kind.length)) : undefined);
  };
  const out: { line: string; text: string }[] = [];
  for (const item of raw) {
    const x = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const line = lineOf(strOf(x.line ?? x.thread ?? x.name));
    const text = cut(strOf(x.text ?? x.progress ?? x['当前进度']), PROGRESS_MAX);
    if (line && text && !out.some((o) => o.line === line)) {
      out.push({ line, text });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 寫正文、審稿：帶哪幾條

/** 計劃收束章離這一章不超過幾章算「就在附近」（寫正文挑線）。 */
export const NEAR_CLOSE = 5;
/**
 * 寫正文時一條線最多列幾條沒收的伏筆。**本章細綱或本章計劃提到的不算在裡面**（復跑之後：主線這 4 個位置一直是同樣 4 條，
 * 當章細綱裡提到的「舊銅牌與銅錢的共鳴」沒列出來，正文當章就把它揭開了）——那幾條一律列出，只受這一層的總字數管。
 */
export const LINE_FORESHADOW_MAX = 4;
/**
 * 細綱提到一條伏筆的門檻（⚑ 復跑之後）：伏筆名去掉虛字之後的兩字詞，至少這麼多成出現在本章細綱（或本章計劃）裡，至少
 * 兩個、其中兩個在名字裡挨著（{@link mentionTest}）。「舊銅牌與銅錢的共鳴」對細綱裡的「銅牌與銅錢的共鳴契機」算提到，
 * 「阿婆的真實身份」對一句「阿婆」不算。
 */
export const MENTION_RATIO = 0.6;
/** 沒有回收章的伏筆寫正文時怎麼說（復跑之後：從前一律寫「不要提前揭開」，沒有回收章就沒有「提前」可言）。 */
const NO_RESOLVE_HINT = '還沒定哪一章收，細綱沒安排就別揭開';
/** 一行裡「現在」截到多長、最近事件與本章計劃每條截到多長：一條線不該一個人吃掉整層的字數（七期上游 #4）。 */
const LINE_NOW_MAX = 80;
const LINE_ITEM_MAX = 40;
const LINE_INTENT_MAX = 60;

/** 壓成一行、去掉句末的標點（一行裡幾段用「；」接，「。；」不好看），超長截斷。 */
function clip(text: string, max: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim().replace(/[。；;，,、\s]+$/u, '');
  return [...t].length > max ? `${[...t].slice(0, max).join('')}…` : t;
}

/** 一條要帶進上下文的東西（一條線、一條伏筆，或「未歸屬的伏筆」那一行）。 */
export interface ContextThread {
  /** 那份檔案的路徑：條目身份與來源都用它。 */
  relPath: string;
  name: string;
  /** 狀態：線的狀態、伏筆的狀態，「未歸屬的伏筆」那一行是「未歸屬」。 */
  status: string;
  /** 為什麼帶它（寫進明細）。 */
  why: string;
  /** 越小越靠前。 */
  rank: number;
  line: string;
  /** 這一行裡本章細綱或本章計劃提到的伏筆（寫正文）：這一行放不下時，明細裡點名說它們沒帶上（第 2 條）。 */
  mentioned?: string[];
}

/** 去掉「的之與和及」這幾個虛字、按標點與空白切開的幾段（同 continuity.ts 的 `textBigrams` 切法）。 */
function wordGroups(text: string): string[][] {
  const groups = (text ?? '').normalize('NFKC').toLocaleLowerCase().replace(/[的之与和及與]/gu, '').match(/[\p{L}\p{N}]+/gu) ?? [];
  return groups.map((g) => [...g]);
}

/** 一段裡挨著的兩字詞，按先後。 */
function gramsOf(chars: readonly string[]): string[] {
  return chars.length < 2 ? [] : chars.slice(0, -1).map((c, i) => c + chars[i + 1]);
}

/**
 * 認「本章細綱提到了這條伏筆」用的那一份：細綱全文與本章計劃（計劃事件的伏筆名與一句話，推遲的寫法也在裡面）。
 * 返回一個判斷函式：伏筆名去掉虛字之後的兩字詞，至少 {@link MENTION_RATIO} 出現在這一份裡，至少兩個，**而且有兩個在名字裡
 * 是挨著的**（名字裡有連著三個字出現在細綱裡）——不然「井底的秘密」會被一句「井底有人」加上別處的「秘密」湊出來。名字只有
 * 一個兩字詞的（「玉佩」）要整個出現。
 */
export function mentionTest(text: string): (name: string) => boolean {
  const grams = new Set(wordGroups(text).flatMap(gramsOf));
  const norm = normalizeQuote(text);
  return (name) => {
    const groups = wordGroups(name).map(gramsOf);
    const total = groups.reduce((n, g) => n + g.length, 0);
    if (total < 2) {
      const key = threadKey(name);
      return key.length >= 2 && norm.includes(key);
    }
    const hits = groups.map((g) => g.map((x) => grams.has(x)));
    const count = hits.reduce((n, h) => n + h.filter(Boolean).length, 0);
    const run = hits.some((h) => h.some((x, i) => x && h[i + 1]));
    return run && count >= 2 && count / total >= MENTION_RATIO;
  };
}

/** `本章計劃：推進——……；埋〈玉佩〉——……`。 */
function plannedText(events: readonly ThreadEvent[]): string {
  return events
    .map((e) => `${traditionalLabel(e.type)}${e.foreshadowing ? `〈${e.foreshadowing}〉` : ''}${e.what ? `——${clip(e.what, LINE_ITEM_MAX)}` : ''}`)
    .join('；');
}

/**
 * 一條沒收的伏筆寫正文時怎麼提醒（設計稿「四」：沒到回收章的一律寫「第 b 章前不要揭開」，這是這一層存在的另一半理由）。
 * 返回 `[排序, 說法]`；還沒到埋的時候（計劃中、本章也不埋）返回 undefined——提了等於叫模型提前埋。
 */
function foreshadowHint(f: ForeshadowState, no: number, planned: readonly ThreadEvent[]): [number, string] | undefined {
  const mine = planned.filter((e) => e.foreshadowing && threadKey(e.foreshadowing) === threadKey(f.name));
  if (mine.some((e) => e.type === '收') || f.resolveBy === no) {
    return [0, '本章計劃收'];
  }
  if (f.resolveBy !== undefined && f.resolveBy < no) {
    return [0, `已過第 ${f.resolveBy} 章，還沒收`];
  }
  if (mine.some((e) => e.type === '埋')) {
    return [1, f.resolveBy !== undefined ? `本章計劃埋，第 ${f.resolveBy} 章前不要揭開` : '本章計劃埋，不要當場揭開'];
  }
  if (f.status === '计划' && !(f.plantBy !== undefined && f.plantBy <= no)) {
    return undefined;
  }
  return [2, f.resolveBy !== undefined ? `第 ${f.resolveBy} 章前不要揭開` : NO_RESOLVE_HINT];
}

/**
 * 一份檔案裡寫第 `no` 章時要提的伏筆：`玉佩的來歷（第 18 章前不要揭開）`，該收的、逾期的在前。
 *
 * **本章細綱或本章計劃提到的一律列出**（`mentioned`，復跑之後），不佔 `max` 那幾個位置，排在同一檔的最前面；還沒到埋的、
 * 本來不提的，被提到了也列出來，寫「第 b 章前不要揭開」（細綱要碰它，正文最容易順手把它揭開）。其餘的最多 `max` 條。
 */
function foreshadowList(
  file: ThreadFileBase,
  no: number,
  planned: readonly ThreadEvent[],
  max: number,
  mentioned: (name: string) => boolean,
  plans: readonly ThreadEvent[]
): { text: string; due: boolean; mentioned: string[] } {
  const items = foreshadowingOf(file, no - 1, plans)
    .filter((f) => !isForeshadowClosed(f.status))
    .map((f) => {
      const forced = mentioned(f.name) || planned.some((e) => e.foreshadowing && threadKey(e.foreshadowing) === threadKey(f.name));
      const hint: [number, string] | undefined =
        foreshadowHint(f, no, planned) ?? (forced ? [2, f.resolveBy !== undefined ? `第 ${f.resolveBy} 章前不要揭開` : NO_RESOLVE_HINT] : undefined);
      return { f, hint, forced };
    })
    .filter((x): x is { f: ForeshadowState; hint: [number, string]; forced: boolean } => !!x.hint)
    .sort(
      (a, b) =>
        a.hint[0] - b.hint[0] || Number(b.forced) - Number(a.forced) || (a.f.resolveBy ?? Infinity) - (b.f.resolveBy ?? Infinity)
    );
  let rest = 0;
  const shown = items.filter((x) => x.forced || rest++ < max);
  return {
    text: shown.map((x) => `${x.f.name}（${x.hint[1]}）`).join('、'),
    due: items.some((x) => x.hint[0] === 0),
    mentioned: shown.filter((x) => x.forced).map((x) => x.f.name),
  };
}

/** 線最近兩條實際事件（寫正文的「最近」一欄）：**不取「埋」**（復跑之後：「埋」那一句寫的多半是伏筆的謎面，不是這條線走到哪）。 */
function recentText(t: ThreadFileBase): string {
  return actualEvents(t)
    .filter((e) => e.type !== '埋')
    .slice(-2)
    .map((e) => `第 ${e.chapter} 章${traditionalLabel(e.type)}${e.foreshadowing ? `〈${e.foreshadowing}〉` : ''}${e.what ? `：${clip(e.what, LINE_ITEM_MAX)}` : ''}`)
    .join('；');
}

/**
 * 寫第 `no` 章時哪幾條線算「有關」，按要緊程度排好（不截；設計稿「四、寫正文」）：
 *
 * 0. 本章有計劃事件的、本章細綱提到了名字的、本章細綱或計劃提到了它上面某條伏筆的；
 * 1. 主線；
 * 2. 計劃收束章就在附近（{@link NEAR_CLOSE} 章之內）或已經過了的、有伏筆該在本章收或已經逾期的（收束章近的在前）；
 * 3. 最近動過的（近的在前）；計劃中、本章已經在它的計劃區間裡的。
 *
 * 收束了、放棄了的不帶——**它上面有本章提到的伏筆除外**，那一行只列那幾條伏筆。**計劃中、還沒到開始那一章、本章也沒
 * 計劃、細綱也沒提的不帶**——帶進去等於提示模型提前開。「未歸屬的伏筆」有要提的就單獨一行（有該收的、本章有計劃或提到
 * 的排在第 2 檔，否則最後）。狀態、現在走到哪都按「寫到這一章時」算（{@link asOf}：當前進度寫到這一章或更晚的不用，改用
 * 這一章之前最近兩條實際事件，「埋」不算）。
 *
 * 伏筆每行最多 {@link LINE_FORESHADOW_MAX} 條（未歸屬的一行加倍），**本章細綱或本章計劃提到的不算在裡面、一律列出**（復跑之後）：
 * 一行變長了也只受這一層的總字數管，放不下時明細裡點名說那幾條沒帶上（`mentioned`）。
 */
export function manuscriptThreads(book: ThreadBook, no: number, plotText: string): ContextThread[] {
  const plot = normalizeQuote(plotText);
  // 「提到」認的是細綱全文與本章的計劃（各條線裡這一章的計劃事件：伏筆名、一句話，推遲的寫法也在一句話裡）。
  const mentioned = mentionTest(
    [plotText, ...plannedFor(book, no).map((p) => `${p.event.foreshadowing ?? ''}\n${p.event.what}`)].join('\n')
  );
  const out: (ContextThread & { tie: number; index: number })[] = [];
  for (const full of book.threads) {
    const t = asOf(full, no);
    const status = threadStatus(t);
    // 本章的計劃事件在 asOf 裡已經去掉了（只留之前的）：從原樣那一份取。
    const planned = plannedEvents(full).filter((e) => e.chapter === no);
    // 收束了的線不帶；它上面還開著、本章又提到的伏筆照列（復跑之後：本章細綱提到的伏筆一律列出），別的伏筆不列。
    const fores = foreshadowList(t, no, planned, isClosed(status) ? 0 : LINE_FORESHADOW_MAX, mentioned, full.events);
    if (isClosed(status)) {
      if (fores.mentioned.length > 0) {
        out.push({
          relPath: t.relPath,
          name: t.name,
          status,
          why: '本章細綱提到了它上面的伏筆',
          rank: 0,
          line: `- ${t.name}（${traditionalLabel(t.kind)} · ${traditionalLabel(status)}）沒收的伏筆：${fores.text}`,
          mentioned: fores.mentioned,
          tie: 0,
          index: t.index,
        });
      }
      continue;
    }
    const key = threadKey(t.name);
    const named = key.length >= 2 && plot.includes(key);
    const state = threadStateAt(t, no - 1);
    const near = t.to !== undefined && (t.to < no || t.to - no <= NEAR_CLOSE);
    let rank: number;
    let why: string;
    let tie = 0;
    if (planned.length > 0 || named || fores.mentioned.length > 0) {
      rank = 0;
      why = planned.length > 0 ? '本章有計劃' : named ? '本章細綱提到了它' : '本章細綱提到了它上面的伏筆';
    } else if (t.kind === '主线') {
      rank = 1;
      why = '主线';
    } else if (near || fores.due) {
      rank = 2;
      why = near ? (t.to! < no ? `已過計劃收束的第 ${t.to} 章` : `計劃第 ${t.to} 章收束，就在附近`) : '有伏筆該收了';
      tie = t.to ?? Number.MAX_SAFE_INTEGER;
    } else if (state.lastActive !== undefined) {
      rank = 3;
      why = `最近第 ${state.lastActive} 章動過`;
      tie = -state.lastActive;
    } else if (status === '计划中' && t.from !== undefined && t.from <= no) {
      rank = 3;
      why = '本章在它的計劃區間裡';
    } else {
      continue;
    }
    const recent = recentText(t);
    const now = t.progress
      ? `現在：${clip(t.progress, LINE_NOW_MAX)}`
      : recent
        ? `最近：${recent}`
        : t.intent
          ? `意圖：${clip(t.intent, LINE_INTENT_MAX)}`
          : '';
    const head = [traditionalLabel(t.kind), traditionalLabel(status), t.to !== undefined && t.to < no ? `已過計劃收束的第 ${t.to} 章` : t.to === no ? '計劃在本章收束' : '']
      .filter(Boolean)
      .join(' · ');
    const parts = [now, planned.length > 0 ? `本章計劃：${plannedText(planned)}` : '', fores.text ? `沒收的伏筆：${fores.text}` : ''].filter(Boolean);
    out.push({
      relPath: t.relPath,
      name: t.name,
      status,
      why,
      rank,
      line: `- ${t.name}（${head}）${parts.join('；')}`,
      ...(fores.mentioned.length > 0 ? { mentioned: fores.mentioned } : {}),
      tie,
      index: t.index,
    });
  }
  const unfiledPlanned = plannedEvents(book.unfiled).filter((e) => e.chapter === no);
  const loose = foreshadowList(asOf(book.unfiled, no), no, unfiledPlanned, LINE_FORESHADOW_MAX * 2, mentioned, book.unfiled.events);
  if (loose.text || unfiledPlanned.length > 0) {
    const parts = [loose.text, unfiledPlanned.length > 0 ? `本章計劃：${plannedText(unfiledPlanned)}` : ''].filter(Boolean);
    const urgent = loose.due || unfiledPlanned.length > 0 || loose.mentioned.length > 0;
    out.push({
      relPath: book.unfiled.relPath,
      name: UNFILED_NAME,
      status: '未歸屬',
      why: urgent ? '有伏筆該收了、本章有計劃或細綱提到了' : '掛不上線的伏筆',
      rank: urgent ? 2 : 4,
      line: `- ${UNFILED_NAME}：${parts.join('；')}`,
      ...(loose.mentioned.length > 0 ? { mentioned: loose.mentioned } : {}),
      tie: Number.MAX_SAFE_INTEGER,
      index: Number.MAX_SAFE_INTEGER,
    });
  }
  return out
    .sort((a, b) => a.rank - b.rank || a.tie - b.tie || a.index - b.index)
    .map(({ tie: _tie, index: _index, ...c }) => c);
}

/**
 * 審稿第 `no` 章時帶哪幾條伏筆（設計稿「四、審稿」⚑5：審稿提示詞裡兩條伏筆檢查從前的材料——角色卡「未收伏筆」、細綱
 * 「新增伏筆」——都並進了敘事線，這一期先帶伏筆部分）：寫到這一章時還沒收的，只提跟這一章有關的——計劃在本章或更早收的、
 * 本章計劃埋或收的、已經埋下的（沒到回收章就不該揭開）。還沒到埋的時候的不提。一條一行，該收的在前。
 */
export function reviewForeshadowing(book: ThreadBook, no: number): ContextThread[] {
  const files: { file: ThreadFileBase; line?: string }[] = [...book.threads.map((t) => ({ file: t, line: t.name })), { file: book.unfiled }];
  const out: (ContextThread & { tie: number })[] = [];
  for (const { file, line } of files) {
    const planned = plannedEvents(file).filter((e) => e.chapter === no);
    for (const f of foreshadowingOf(asOf(file, no), no - 1, file.events)) {
      if (isForeshadowClosed(f.status)) {
        continue;
      }
      const hint = foreshadowHint(f, no, planned);
      if (!hint) {
        continue;
      }
      const why = hint[1].replace('不要揭開', '不該揭開').replace('不要當場揭開', '不該當場揭開').replace('就別揭開', '就不該揭開');
      out.push({
        relPath: file.relPath,
        name: f.name,
        status: f.status,
        why,
        rank: hint[0],
        line: `- ${f.name}（掛在「${line ?? UNFILED_NAME}」· ${traditionalLabel(f.status)} · ${why}）${f.what ? `是什麼：${clip(f.what, LINE_INTENT_MAX)}` : ''}`,
        tie: f.resolveBy ?? Number.MAX_SAFE_INTEGER,
      });
    }
  }
  return out.sort((a, b) => a.rank - b.rank || a.tie - b.tie).map(({ tie: _tie, ...c }) => c);
}

// ---------------------------------------------------------------- 拆細綱：帶哪幾條

/** 拆細綱時一條線、一條伏筆最多列幾條這幾章原來的計劃（重拆時讓模型知道原來怎麼排的）。 */
const RANGE_PLAN_MAX = 4;

/**
 * 拆細綱的範圍怎麼稱呼：一章是「本章」，幾章一批是「本批」。`threads` 層的標記（「本批要收」）與細綱合同裡那條規矩
 * （context/prompts.ts）用同一個說法——合同叫模型認的就是這幾個字。
 */
export function planScope(range: { from: number; to: number }): '本章' | '本批' {
  return range.from === range.to ? '本章' : '本批';
}

/**
 * `第 13 章推進——……；第 14 章埋〈玉佩〉`，最多 {@link RANGE_PLAN_MAX} 條。`bare`：一條伏筆自己那一行，不再寫伏筆名與說明
 * （`第 7 章收`）。
 */
function rangePlanText(events: readonly ThreadEvent[], bare = false): string {
  const shown = events
    .slice(0, RANGE_PLAN_MAX)
    .map((e) =>
      bare
        ? `第 ${e.chapter} 章${traditionalLabel(e.type)}`
        : `第 ${e.chapter} 章${traditionalLabel(e.type)}${e.foreshadowing ? `〈${e.foreshadowing}〉` : ''}${e.what ? `——${clip(e.what, LINE_ITEM_MAX)}` : ''}`
    )
    .join('；');
  return events.length > RANGE_PLAN_MAX ? `${shown}……（共 ${events.length} 條）` : shown;
}

/** 一條線頭上的計劃區間：`計劃第 3–40 章` / `計劃第 3 章起` / `計劃第 40 章收束`；過了、落在這幾章裡的另說。都沒寫是空串。 */
function linePlanHead(t: Thread, range: { from: number; to: number }): string {
  if (t.to !== undefined && t.to < range.from) {
    return `已過計劃收束的第 ${t.to} 章`;
  }
  if (t.to !== undefined && t.to <= range.to) {
    return `計劃在第 ${t.to} 章收束`;
  }
  if (t.from !== undefined && t.to !== undefined) {
    return `計劃第 ${t.from}–${t.to} 章`;
  }
  if (t.from !== undefined) {
    return `計劃第 ${t.from} 章起`;
  }
  return t.to !== undefined ? `計劃第 ${t.to} 章收束` : '';
}

/**
 * 拆第 `range` 這幾章細綱時帶哪幾條（設計稿「二」：`plot` 配方的 `threads` 層，討論、落定也用這一張）。排好序、不截；
 * 線與伏筆分兩組，各自封頂（上下文詳細度 `plotThreadCount` / `plotForeshadowCount` / `plotThreadChars`）。都按「寫到區間
 * 第一章時」算（{@link asOf}）：重拆前面的章不帶後面幾章記下的事。
 *
 * **線**：全部沒收束的，一條一行——種類、狀態、計劃區間、意圖、現在走到哪（當前進度；寫到區間第一章或更晚的不用）、
 * 最近兩條實際事件、這幾章原來的計劃（重拆時讓模型知道原來怎麼排的）。排法：這幾章原來有計劃的 → 主線 → 進行中的
 * （最近動過的在前）→ 計劃中、這幾章已經在它的計劃區間裡的 → 還沒到開始那一章的（⚑ 也帶，寫明「還不到」：拆細綱要
 * 知道後面有這條線，才不會另起一條、也不會提前開）。
 *
 * **伏筆**：寫到區間第一章時還沒收、也沒棄的（線收束了，伏筆照樣可能開著），一條一行。排法（2026-10-25 重排）：
 * 1. 計劃在這幾章或更早收的（「本批要收」/「已過第 b 章，還沒收」，回收章早的在前；還沒埋的另說「還沒埋，先埋再收」）；
 * 2. 這幾章原來有計劃的；
 * 3. 計劃在這幾章或更早埋、還沒埋的（「本批要埋」/「計劃第 a 章埋，還沒埋」）——細綱合同與事後的 {@link unplannedDue} 認的
 *    就是這幾個字，從前與已埋的同一檔、排在它們後面，已埋的一多就被名額擠掉：模型看不見，事後照樣報漏排；
 * 4. `text`（這幾章的細綱、作者這一次的話）裡提到的已埋、沒定哪一章埋的；
 * 5. 已埋、定了回收章的：回收章近的在前；
 * 6. 已埋、沒定回收章的：最近動過的在前（從前埋得早的在前，寫到八十章，第 2 章埋下、作者暫時不收的開篇伏筆佔滿名額）；
 * 7. 還沒定哪一章埋的。
 *
 * **計劃在這幾章之後才埋的不帶**（提了等於叫模型提前埋）；還沒開始的線上沒定哪一章埋的也不帶。
 */
export function plotThreads(
  book: ThreadBook,
  range: { from: number; to: number },
  text = ''
): { lines: ContextThread[]; foreshadowing: ContextThread[] } {
  const { from, to } = range;
  const scope = planScope(range);
  const inRange = (e: ThreadEvent): boolean => e.planned && e.chapter >= from && e.chapter <= to;
  const lines: (ContextThread & { tie: number; index: number })[] = [];
  /** 還沒到開始那一章的線：它上面沒定哪一章埋的伏筆不帶。 */
  const later = new Set<string>();
  for (const full of book.threads) {
    const t = asOf(full, from);
    const status = threadStatus(t);
    if (isClosed(status)) {
      continue;
    }
    // 這幾章的計劃事件在 asOf 裡已經去掉了（只留之前的）：從原樣那一份取。
    const planned = full.events.filter(inRange);
    const linePlan = planned.filter((e) => !isForeshadowEvent(e.type));
    const lastActive = lastActiveChapter(t);
    const notYet = status === '计划中' && t.from !== undefined && t.from > to;
    if (notYet) {
      later.add(threadKey(t.name));
    }
    let rank: number;
    let why: string;
    let tie = 0;
    if (planned.length > 0) {
      rank = 0;
      why = `${traditionalLabel(scope)}原來有計劃`;
    } else if (t.kind === '主线') {
      rank = 1;
      why = '主线';
    } else if (status === '进行中') {
      rank = 2;
      why = `最近第 ${lastActive} 章動過`;
      tie = -(lastActive ?? 0);
    } else if (!notYet) {
      rank = 3;
      why = `${traditionalLabel(scope)}在它的計劃區間裡`;
      tie = t.from ?? 0;
    } else {
      rank = 4;
      why = `計劃第 ${t.from} 章起，${traditionalLabel(scope)}還不到`;
      tie = t.from!;
    }
    const recent = actualEvents(t)
      .slice(-2)
      .map((e) => `第 ${e.chapter} 章${traditionalLabel(e.type)}${e.foreshadowing ? `〈${e.foreshadowing}〉` : ''}${e.what ? `：${clip(e.what, LINE_ITEM_MAX)}` : ''}`)
      .join('；');
    const head = [traditionalLabel(t.kind), traditionalLabel(status), linePlanHead(t, range)].filter(Boolean).join(' · ');
    const parts = [
      t.intent ? `意圖：${clip(t.intent, LINE_INTENT_MAX)}` : '',
      t.progress ? `現在：${clip(t.progress, LINE_NOW_MAX)}` : '',
      recent ? `最近：${recent}` : '',
      linePlan.length > 0 ? `${traditionalLabel(scope)}原來的計劃：${rangePlanText(linePlan)}` : '',
      notYet ? `${traditionalLabel(scope)}還不到它開始的那一章，不要提前開` : '',
    ].filter(Boolean);
    lines.push({ relPath: t.relPath, name: t.name, status, why, rank, line: `- ${t.name}（${head}）${parts.join('；')}`, tie, index: t.index });
  }

  const fores: (ContextThread & { tie: number; order: number })[] = [];
  const mentioned = mentionTest(text);
  const files: { file: ThreadFileBase; line?: string }[] = [...book.threads.map((t) => ({ file: t, line: t.name })), { file: book.unfiled }];
  for (const { file, line } of files) {
    const planned = file.events.filter((e) => inRange(e) && e.foreshadowing);
    const notYet = !!line && later.has(threadKey(line));
    // 推遲認原樣那一份，這幾章原來的計劃除外（這一次整組換掉）。
    const plans = file.events.filter((e) => !inRange(e));
    const before = asOf(file, from);
    /** 每條伏筆最近一次實際動過（埋，或再埋一次）是第幾章。 */
    const touched = new Map<string, number>();
    for (const e of actualEvents(before)) {
      if (e.foreshadowing) {
        const key = threadKey(e.foreshadowing);
        touched.set(key, Math.max(touched.get(key) ?? 0, e.chapter));
      }
    }
    for (const f of foreshadowingOf(before, from - 1, plans)) {
      if (isForeshadowClosed(f.status)) {
        continue;
      }
      const mine = planned.filter((e) => threadKey(e.foreshadowing!) === threadKey(f.name));
      let rank: number;
      let hint: string;
      let tie = 0;
      let said = false;
      if (f.resolveBy !== undefined && f.resolveBy <= to) {
        rank = 0;
        hint = f.resolveBy < from ? `已過第 ${f.resolveBy} 章，還沒收` : scope === '本章' ? '本章要收' : `本批要收，最晚第 ${f.resolveBy} 章`;
        // 復跑之後：「收」要排在「埋」之後（resolvePlanEvents），還沒埋、前面也沒排過「埋」的說清楚，免得只排一條收、被丟掉。
        const plantedPlan = file.events.some(
          (e) => e.planned && e.type === '埋' && e.chapter < from && !!e.foreshadowing && threadKey(e.foreshadowing) === threadKey(f.name)
        );
        hint += f.status === '计划' && !plantedPlan ? '，還沒埋，先埋再收' : '';
        tie = f.resolveBy;
      } else if (mine.length > 0) {
        rank = 1;
        hint = f.resolveBy !== undefined ? `第 ${f.resolveBy} 章前收` : '還沒定哪一章收';
        tie = mine[0].chapter;
      } else if (f.status !== '已埋' && f.plantBy !== undefined && f.plantBy <= to) {
        rank = 2;
        // 復跑之後：在這幾章裡該埋的標「本批要埋」，過了還沒埋的標「還沒埋」——合同裡那條規矩認的就是這兩種說法。
        hint = `${f.plantBy < from ? `計劃第 ${f.plantBy} 章埋，還沒埋` : `${traditionalLabel(scope)}要埋，計劃第 ${f.plantBy} 章`}${f.resolveBy !== undefined ? `、第 ${f.resolveBy} 章前收` : ''}`;
        tie = f.plantBy;
      } else if (f.status === '已埋') {
        said = mentioned(f.name);
        hint = f.resolveBy !== undefined ? `第 ${f.resolveBy} 章前收，之前不要揭開` : '還沒定哪一章收，不要隨手揭開';
        rank = said ? 3 : f.resolveBy !== undefined ? 4 : 5;
        tie = said ? 0 : (f.resolveBy ?? -(touched.get(threadKey(f.name)) ?? f.plantedAt ?? 0));
      } else if (f.plantBy === undefined && !notYet) {
        said = mentioned(f.name);
        rank = said ? 3 : 6;
        hint = '還沒定哪一章埋';
      } else {
        // 計劃在這幾章之後才埋、或掛在還沒開始的線上：提了等於叫模型提前埋。
        continue;
      }
      const parts = [f.what ? `是什麼：${clip(f.what, LINE_INTENT_MAX)}` : '', mine.length > 0 ? `${traditionalLabel(scope)}原來的計劃：${rangePlanText(mine, true)}` : ''].filter(Boolean);
      fores.push({
        relPath: file.relPath,
        name: f.name,
        status: f.status,
        why: said ? `${hint}；${traditionalLabel(scope)}細綱或作者的話裡提到了` : hint,
        rank,
        line: `- ${f.name}（掛在「${line ?? UNFILED_NAME}」· ${traditionalLabel(f.status)} · ${hint}）${parts.join('；')}`,
        tie,
        order: fores.length,
      });
    }
  }
  return {
    lines: lines.sort((a, b) => a.rank - b.rank || a.tie - b.tie || a.index - b.index).map(({ tie: _tie, index: _index, ...c }) => c),
    foreshadowing: fores.sort((a, b) => a.rank - b.rank || a.tie - b.tie || a.order - b.order).map(({ tie: _tie, order: _order, ...c }) => c),
  };
}

/**
 * 按排好的順序取，最多 `count` 條、一共 `chars` 字（只算各行）。放不下的那條**跳過、接著試下一條**（七期修過的上游 `break`：
 * 一條長的擋住後面所有短的）。丟了的帶原因交給呼叫方寫進明細（第 2 條）。`what` 是明細裡怎麼稱呼（「敘事線」「伏筆」）。
 */
export function fitThreads<T extends { line: string }>(
  list: readonly T[],
  limits: { count: number; chars: number },
  what = '叙事线'
): { picked: T[]; dropped: (T & { note: string })[] } {
  const picked: T[] = [];
  const dropped: (T & { note: string })[] = [];
  let used = 0;
  for (const c of list) {
    const cost = c.line.length + (picked.length > 0 ? 1 : 0);
    if (picked.length >= limits.count) {
      dropped.push({ ...c, note: `${traditionalLabel(what)}一次只帶 ${limits.count} 條，排在後面的沒帶` });
    } else if (used + cost > limits.chars) {
      dropped.push({ ...c, note: `${traditionalLabel(what)}一共只帶 ${limits.chars} 字，放不下這一條` });
    } else {
      used += cost;
      picked.push(c);
    }
  }
  return { picked, dropped };
}

// ---------------------------------------------------------------- 拆細綱：計劃事件（二期）

/**
 * 細綱合同裡一章的 `threads` 一項（設計稿「二」）：這一章在哪條線上計劃發生什麼。`line` 是模型寫的線名，落盤時才認
 * （{@link resolvePlanEvents}）——解碼時手上沒有敘事線目錄。
 */
export interface PlanEntry {
  line: string;
  type: ThreadEventType;
  /** 埋 / 收的是哪一條伏筆。 */
  foreshadowing?: string;
  what: string;
  /** 埋一條新伏筆時：計劃第幾章前收。 */
  resolve?: number;
}

/** 一章最多寫幾條計劃（設計稿：一章最多 6 條）。 */
export const PLAN_EVENT_LIMIT = 6;

/**
 * 計劃裡能寫的型別：線的推進 / 關係 / 收束，伏筆的埋 / 收。⚑ 設計稿的合同只列了「推進|關係|埋|收」四種，這裡多認一個
 * 「收束」——一條線計劃在哪一章走完是排細綱時就定得下來的事，寫正文那一層會提醒「本章計劃：收束」。放棄、棄不是計劃
 * 出來的，不認。
 */
export const PLAN_EVENT_TYPES: readonly ThreadEventType[] = ['推进', '关系', '收束', '埋', '收'];

/**
 * 解碼一章的 `threads`（批次的 features/blueprint.ts 與單章的 features/artifact.ts 共用，第 22 條）。**寬鬆收、絕不拋**：
 * 一個可選欄位寫壞了不該作廢整章細綱。沒寫（undefined / null）返回 undefined——落盤時不動這一章原來的計劃（老會話裡存著
 * 的草稿沒有這個欄位，第 1 條）；寫成別的形狀當空的並說一句。
 *
 * 每項：型別要是 {@link PLAN_EVENT_TYPES} 之一；線的事件要寫 `line`，伏筆的事件要寫 `foreshadowing`（名字合格）；
 * 「是什麼」截到 {@link EVENT_WHAT_MAX} 字；`resolve` 只對埋有用、要比本章晚。同一條（同線、同型別、同一條伏筆）只留
 * 第一條；最多 {@link PLAN_EVENT_LIMIT} 條（先校驗後截）。沒收的寫進 `notes`（第 2 條：卡片與日誌裡說出來）。
 */
export function decodePlanEntries(raw: unknown, no: number): { entries?: PlanEntry[]; notes: string[] } {
  if (raw === undefined || raw === null) {
    return { notes: [] };
  }
  const where = no > 0 ? `第 ${no} 章的敘事線計劃` : '敘事線計劃';
  if (!Array.isArray(raw)) {
    return { entries: [], notes: [`${traditionalLabel(where)}（threads）不是列表，當沒有計劃`] };
  }
  const entries: PlanEntry[] = [];
  const notes: string[] = [];
  for (const item of raw) {
    const x = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const line = strOf(x.line ?? x.thread);
    const typeText = strOf(x.type);
    const type = eventTypeOf(typeText);
    const fore = strOf(x.foreshadowing);
    const label = `${line || '？'}${fore ? `〈${fore}〉` : ''} ${traditionalLabel(typeText) || '（沒寫型別）'}`;
    let why = '';
    if (!type || !PLAN_EVENT_TYPES.includes(type)) {
      why = '型別不是推進 / 關係 / 收束 / 埋 / 收之一';
    } else if (isForeshadowEvent(type) && !fore) {
      why = '沒寫是哪一條伏筆';
    } else if (isForeshadowEvent(type) && nameProblem(fore)) {
      why = `伏筆${nameProblem(fore)}`;
    } else if (!isForeshadowEvent(type) && !line) {
      why = '沒寫是哪一條線';
    }
    if (why) {
      notes.push(`${traditionalLabel(where)} ${label}：${why}，沒收`);
      continue;
    }
    const entry: PlanEntry = {
      line,
      type: type!,
      ...(isForeshadowEvent(type!) ? { foreshadowing: fore } : {}),
      what: cut(strOf(x.what ?? x.reason), EVENT_WHAT_MAX),
    };
    const resolve = intOf(x.resolve);
    if (type === '埋' && resolve !== undefined && resolve > no) {
      entry.resolve = resolve;
    }
    const same = entries.some(
      (e) =>
        e.type === entry.type &&
        threadKey(e.foreshadowing ?? '') === threadKey(entry.foreshadowing ?? '') &&
        (isForeshadowEvent(e.type) || threadKey(e.line) === threadKey(entry.line))
    );
    if (same) {
      continue;
    }
    if (entries.length >= PLAN_EVENT_LIMIT) {
      notes.push(`${traditionalLabel(where)} ${label}：一章最多寫 ${PLAN_EVENT_LIMIT} 條，沒收`);
      continue;
    }
    entries.push(entry);
  }
  return { entries, notes };
}

/** 計劃事件在細綱合同裡的樣子（`renderBlueprints` 寫回規範化輸出、作者在氣泡裡改了再寫入時原樣認得）。 */
export function planEntryJson(e: PlanEntry): Record<string, unknown> {
  return {
    line: e.line,
    type: e.type,
    ...(e.foreshadowing ? { foreshadowing: e.foreshadowing } : {}),
    what: e.what,
    ...(e.resolve !== undefined ? { resolve: e.resolve } : {}),
  };
}

/** 一章的計劃落到各條線上的樣子（{@link resolvePlanEvents}）。 */
export interface PlannedChapter {
  no: number;
  /** 要寫進去的計劃事件：落在哪條線上（缺席是「未歸屬的伏筆」）。 */
  events: FoundEvent[];
  /** 這一章新登記的伏筆（埋了一條沒見過的）：掛在哪條線上（缺席是「未歸屬的伏筆」）。 */
  newForeshadowing: { line?: string; foreshadowing: Foreshadowing }[];
  /** 沒寫進去的：哪一條、為什麼。 */
  dropped: { what: string; why: string }[];
  /** 這一章原來有幾條計劃事件（寫入時整組換掉）。 */
  replaced: number;
}

/**
 * 幾章的計劃 → 落到哪份檔案上（設計稿「誰能寫什麼」：計劃事件隨細綱走）。純函式，按章號先後走一遍：前面幾章新埋的伏筆，
 * 後面幾章收它認得出。都按「寫到這一章時」認線與伏筆的狀態（{@link asOf}）。
 *
 * - **線的事件**（推進 / 關係 / 收束）：`line` 認得出、寫到這一章時還沒收束的線才記；認不出的丟掉（設計稿：其餘丟掉並寫進
 *   卡片與日誌）。
 * - **伏筆的事件**（埋 / 收）跟著那條伏筆走，落在它所在的線或「未歸屬的伏筆」上，不看 `line`（同定稿 a，一期前半 ⚑7）。
 *   寫到這一章時已經收了、棄了的不記；已經埋下的再「埋」不記；**「收」要排在「埋」之後**（復跑之後）：寫到這一章時已經
 *   實際埋下，或者計劃裡更早的一章「埋」它（這一次不換掉的那幾章裡已有的計劃，或這一批前面幾章剛排的），不然丟掉。
 * - **沒見過的伏筆**：「埋」就是一條新伏筆——`line` 認得出、還沒收束就掛在那條線上，認不出進「未歸屬的伏筆」（設計稿），
 *   登記成 `名：是什麼（計劃第 N 章埋、第 b 章前收）`；「收」丟掉。名字與全書已有的、前面幾章剛埋的不重複。
 * - 同一份檔案裡同一條只記一次。
 */
export function resolvePlanEvents(
  book: ThreadBook,
  chapters: readonly { no: number; entries: readonly PlanEntry[] }[]
): PlannedChapter[] {
  const lines = new Map(book.threads.map((t) => [threadKey(t.name), t]));
  /** 全書已有的伏筆：名字 → 在哪份檔案（線名；缺席是未歸屬）。 */
  const owner = new Map<string, { name: string; line?: string }>();
  for (const t of book.threads) {
    for (const f of foreshadowingOf(t, 0)) {
      owner.set(threadKey(f.name), { name: f.name, line: t.name });
    }
  }
  for (const f of foreshadowingOf(book.unfiled, 0)) {
    if (!owner.has(threadKey(f.name))) {
      owner.set(threadKey(f.name), { name: f.name });
    }
  }
  const fileOf = (line: string | undefined): ThreadFileBase => (line ? lines.get(threadKey(line))! : book.unfiled);
  /**
   * 計劃裡最早哪一章「埋」它（復跑之後：計劃「收」要排在計劃「埋」或實際「埋」之後）。先認這一次不換掉的那幾章裡已有的
   * 計劃，這一批按章號走到哪、埋了哪條再加上。
   */
  const rewriting = new Set(chapters.map((c) => c.no));
  const plantPlanned = new Map<string, number>();
  const notePlant = (name: string, no: number): void => {
    const key = threadKey(name);
    plantPlanned.set(key, Math.min(plantPlanned.get(key) ?? Number.POSITIVE_INFINITY, no));
  };
  for (const f of [...book.threads, book.unfiled]) {
    for (const e of plannedEvents(f)) {
      if (e.type === '埋' && e.foreshadowing && !rewriting.has(e.chapter)) {
        notePlant(e.foreshadowing, e.chapter);
      }
    }
  }
  const out: PlannedChapter[] = [];
  for (const { no, entries } of [...chapters].sort((a, b) => a.no - b.no)) {
    const ch: PlannedChapter = { no, events: [], newForeshadowing: [], dropped: [], replaced: plannedFor(book, no).length };
    const openLine = (name: string): Thread | undefined => {
      const t = lines.get(threadKey(name));
      return t && !isClosed(threadStatus(asOf(t, no))) ? t : undefined;
    };
    const push = (line: string | undefined, event: ThreadEvent): void => {
      if (!ch.events.some((e) => threadKey(e.line ?? '') === threadKey(line ?? '') && sameEvent(e.event, event))) {
        ch.events.push({ ...(line ? { line } : {}), event });
      }
    };
    for (const p of entries) {
      const label = p.foreshadowing ? `${traditionalLabel(p.type)}〈${p.foreshadowing}〉` : `${p.line} ${traditionalLabel(p.type)}`;
      if (!isForeshadowEvent(p.type)) {
        const t = openLine(p.line);
        if (t) {
          push(t.name, { chapter: no, planned: true, type: p.type, what: p.what });
        } else {
          ch.dropped.push({ what: label, why: lines.has(threadKey(p.line)) ? '這條線已經收束了' : '認不出是哪一條線' });
        }
        continue;
      }
      const known = owner.get(threadKey(p.foreshadowing!));
      if (known) {
        const state = foreshadowingOf(asOf(fileOf(known.line), no), no - 1).find((f) => threadKey(f.name) === threadKey(known.name));
        const plantAt = plantPlanned.get(threadKey(known.name));
        if (state && isForeshadowClosed(state.status)) {
          ch.dropped.push({ what: label, why: `這條伏筆已經${state.status === '已收' ? '收' : '棄'}了` });
        } else if (p.type === '埋' && state?.status === '已埋') {
          ch.dropped.push({ what: label, why: `這條伏筆第 ${state.plantedAt} 章已經埋下了` });
        } else if (p.type === '收' && state?.status !== '已埋' && !(plantAt !== undefined && plantAt < no)) {
          ch.dropped.push({ what: label, why: '這條伏筆還沒埋，「收」要排在「埋」之後（先在更早的一章安排「埋」）' });
        } else {
          if (p.type === '埋') {
            notePlant(known.name, no);
          }
          push(known.line, { chapter: no, planned: true, type: p.type, foreshadowing: known.name, what: p.what });
        }
        continue;
      }
      if (p.type !== '埋') {
        ch.dropped.push({ what: label, why: '認不出是哪一條伏筆' });
        continue;
      }
      const line = p.line ? openLine(p.line)?.name : undefined;
      const foreshadowing: Foreshadowing = {
        name: p.foreshadowing!,
        what: cut(p.what, FORESHADOW_WHAT_MAX),
        plant: no,
        ...(p.resolve !== undefined ? { resolve: p.resolve } : {}),
      };
      owner.set(threadKey(foreshadowing.name), { name: foreshadowing.name, ...(line ? { line } : {}) });
      notePlant(foreshadowing.name, no);
      ch.newForeshadowing.push({ ...(line ? { line } : {}), foreshadowing });
      push(line, { chapter: no, planned: true, type: '埋', foreshadowing: foreshadowing.name, what: p.what });
    }
    out.push(ch);
  }
  return out;
}

/** 拆細綱之後，到期卻沒安排的一條伏筆（{@link unplannedDue}）。 */
export interface UnplannedDue {
  name: string;
  /** 掛在哪條線上（缺席是「未歸屬的伏筆」）。 */
  line?: string;
  /** 該埋（計劃埋的章到了、還沒埋）、該收（計劃回收章到了、還沒收），這一批都沒安排。 */
  need: ('埋' | '收')[];
  plant?: number;
  resolve?: number;
}

/**
 * 拆細綱的程式檢查（復跑之後，2026-10-21；模型只排「推進」，到期該埋的三條一條也沒排）：寫進去的這幾章（第 a–b 章）裡到期、
 * 卻沒安排的伏筆。**不調模型、不攔人**，列在寫入卡片的說明與日誌裡（features/threadPlan.ts）。都按寫到第 a 章時算（{@link asOf}）：
 *
 * - **該埋**：還是「計劃」、伏筆那一行寫的計劃埋的章 ≤ b（這幾章裡的，或者早就過了的）；
 * - **該收**：還沒收、也沒棄，計劃回收章 ≤ b。
 *
 * 算安排過的：這一批的計劃落到線上之後（{@link resolvePlanEvents}：沒埋就收的已經丟掉了）有它的「埋」/「收」；這一次不換掉的、
 * 第 a 章及以後的章裡原來就有它的計劃「埋」/「收」（一批裡跳過的已有細綱、單章重拆時後面幾章的計劃）；或者這一批哪一條
 * 計劃的 what 裡提到了它、寫明「推遲」（合同裡的推遲寫法：給它所在的線寫一條推進，「〈伏筆名〉推遲到第 N 章收」）。
 */
export function unplannedDue(book: ThreadBook, chapters: readonly { no: number; entries: readonly PlanEntry[] }[]): UnplannedDue[] {
  if (chapters.length === 0) {
    return [];
  }
  const nos = chapters.map((c) => c.no);
  const from = Math.min(...nos);
  const to = Math.max(...nos);
  const rewriting = new Set(nos);
  const arranged = { 埋: new Set<string>(), 收: new Set<string>() };
  for (const c of resolvePlanEvents(book, chapters)) {
    for (const { event } of c.events) {
      if ((event.type === '埋' || event.type === '收') && event.foreshadowing) {
        arranged[event.type].add(threadKey(event.foreshadowing));
      }
    }
  }
  for (const f of [...book.threads, book.unfiled]) {
    for (const e of plannedEvents(f)) {
      if ((e.type === '埋' || e.type === '收') && e.foreshadowing && e.chapter >= from && !rewriting.has(e.chapter)) {
        arranged[e.type].add(threadKey(e.foreshadowing));
      }
    }
  }
  const delays = chapters.flatMap((c) => c.entries.map((e) => e.what)).filter((w) => w.includes('推遲')).map(normalizeQuote);
  const delayed = (name: string): boolean => {
    const key = threadKey(name);
    return key.length > 0 && delays.some((w) => w.includes(key));
  };
  const out: UnplannedDue[] = [];
  const files: { file: ThreadFileBase; line?: string }[] = [...book.threads.map((t) => ({ file: t, line: t.name })), { file: book.unfiled }];
  for (const { file, line } of files) {
    // 推遲認原樣那一份，這一次換掉的那幾章原來的計劃除外（這一批的推遲在上面 `delayed` 裡認）。
    const plans = file.events.filter((e) => !rewriting.has(e.chapter));
    for (const f of foreshadowingOf(asOf(file, from), from - 1, plans)) {
      if (isForeshadowClosed(f.status) || delayed(f.name)) {
        continue;
      }
      const key = threadKey(f.name);
      const need: ('埋' | '收')[] = [];
      if (f.status === '计划' && f.plantBy !== undefined && f.plantBy <= to && !arranged.埋.has(key)) {
        need.push('埋');
      }
      if (f.resolveBy !== undefined && f.resolveBy <= to && !arranged.收.has(key)) {
        need.push('收');
      }
      if (need.length > 0) {
        out.push({
          name: f.name,
          ...(line ? { line } : {}),
          need,
          ...(f.plantBy !== undefined ? { plant: f.plantBy } : {}),
          ...(f.resolveBy !== undefined ? { resolve: f.resolveBy } : {}),
        });
      }
    }
  }
  return out;
}

/** `〈阿婆的真實身份〉（計劃第 5 章埋，還沒埋）`、`〈井底的秘密〉（第 13 章前收）`。 */
export function describeUnplannedDue(u: UnplannedDue): string {
  const parts = [
    u.need.includes('埋') ? `計劃第 ${u.plant} 章埋，還沒埋` : '',
    u.need.includes('收') ? `第 ${u.resolve} 章前收` : '',
  ].filter(Boolean);
  return `〈${u.name}〉（${parts.join('；')}）`;
}

// ---------------------------------------------------------------- 寫前檢查：兩類提醒要的數（二期）

/**
 * 寫前檢查的敘事線提醒要的數（設計稿「四、寫前檢查」；判斷在 model/pipeline.ts 的 `threadRemindersFor`，前端也打包那一份）。
 * `no` 給了就按「寫到第 `no` 章時」算（{@link asOf}：只看之前的實際事件、狀態）；不給就是現在的樣子（工程頁資料，前端批次
 * 寫章彈窗用）。計劃事件從原樣那一份取——要看的正是這一章及以後有沒有安排。
 *
 * - 線：進行中的才算（計劃中的還沒開始、收束了的不會斷），帶最近一次實際事件、`STALL_CHAPTERS` 的閾值、哪幾章有計劃事件
 *   （這條線的檔案裡任何一條計劃事件都算安排了：推進、關係、伏筆的埋與收都說明這一章要動它）。
 * - 伏筆：還沒收、也沒棄、寫了計劃回收章的（各條線與「未歸屬的伏筆」裡的都算，線收束了伏筆照樣可能開著），帶哪幾章計劃收它。
 * - 還沒埋的伏筆（復跑之後）：狀態還是「計劃」、伏筆那一行寫了計劃埋的章的，帶哪幾章計劃埋它。
 */
export function threadWatch(book: ThreadBook, no?: number): ThreadWatch {
  const at = <T extends ThreadFileBase>(f: T): T => (no === undefined ? f : asOf(f, no));
  const chapters = (events: readonly ThreadEvent[]): number[] => [...new Set(events.map((e) => e.chapter))].sort((a, b) => a - b);
  const lines: ThreadWatch['lines'] = [];
  for (const full of book.threads) {
    const t = at(full);
    const lastActive = lastActiveChapter(t);
    if (threadStatus(t) !== '进行中' || lastActive === undefined) {
      continue;
    }
    lines.push({ name: t.name, kind: t.kind, lastActive, stall: STALL_CHAPTERS[t.kind], planned: chapters(plannedEvents(full)) });
  }
  const foreshadowing: ThreadWatch['foreshadowing'] = [];
  const unplanted: ThreadWatch['unplanted'] = [];
  for (const file of [...book.threads, book.unfiled] as ThreadFileBase[]) {
    const plans = (type: ThreadEventType, name: string): number[] =>
      chapters(plannedEvents(file).filter((e) => e.type === type && e.foreshadowing && threadKey(e.foreshadowing) === threadKey(name)));
    for (const f of foreshadowingOf(at(file), 0, file.events)) {
      if (isForeshadowClosed(f.status)) {
        continue;
      }
      if (f.resolveBy !== undefined) {
        foreshadowing.push({ name: f.name, resolve: f.resolveBy, planned: plans('收', f.name) });
      }
      // 第三類（復跑之後）：計劃第 a 章埋、還沒埋。
      if (f.status === '计划' && f.plantBy !== undefined) {
        unplanted.push({ name: f.name, plant: f.plantBy, planned: plans('埋', f.name) });
      }
    }
  }
  return { lines, foreshadowing, unplanted };
}

// ---------------------------------------------------------------- 當前進度（機器維護、指紋守著）

/** 「當前進度」的指紋。只看內容：首尾空白不算，佔位文字當空（同角色卡 `stateHashOf`）。 */
export function progressHashOf(text: string): string {
  return hash(hasContent(text) ? text.trim() : '');
}

/**
 * 「當前進度」現在歸機器（可以直接寫）還是歸作者（不寫，掛黃 ❗）。照角色卡「當前狀態」的做法
 * （model/characterState.ts）：空的歸機器；記過指紋、而且對得上的歸機器；其餘（改過、或者從沒記過指紋卻有
 * 內容）歸作者。
 */
export function progressOwnedByMachine(thread: Pick<Thread, 'progress' | 'progressHash'>): boolean {
  if (!hasContent(thread.progress)) {
    return true;
  }
  return !!thread.progressHash && thread.progressHash === progressHashOf(thread.progress);
}

/**
 * 在一條線的原文上換掉「當前進度」並蓋章（`progressThrough` / `progressHash`），**其餘一個字不動**。
 * 手寫的線可能沒有 frontmatter：那就在最前面補一段只有這兩個欄位的。
 */
export function patchProgress(raw: string, progress: string, through: number): string {
  const body = replaceSection(raw ?? '', '当前进度', progress);
  const fm = { progressThrough: through, progressHash: progressHashOf(progress) };
  return rewriteFrontmatter(body, fm) ?? `${stringifyFrontmatter(fm)}\n\n${body.replace(/^﻿/, '')}`;
}

// ---------------------------------------------------------------- 水位：敘事線判到第幾章（四期）

/**
 * 敘事線判到哪（設計稿「九、補記已經寫了的書」）：`project.json` 的 `threadsThrough` 是**水位**——從第 1 章起連續判過的最後
 * 一章；`threadsJudged` 是水位之後另外判過的幾章（不連續的，單章定稿跳著定、中間一章沒判成時會有）。
 *
 * ⚑ **「判過」= 定稿第三步的 a（認事件）成了、認出來的落了盤**：b（當前進度）、c（歸併）沒成也算（a 記下的照樣算數，黃 ❗ 照樣
 * 掛在章節上），在 b 那裡取消了也算（事件已經線上裡了）；a 沒成、在落盤之前取消了不算。記在 `project.json`（同全文大綱的 `globalSummaryThrough`），不放 SQLite（第 17 條：那裡只放可丟的痕跡，
 * 丟了就得把幾十章重判一遍），也不放細綱的 frontmatter（定稿第一步整份重寫細綱，記號跟著一起沒了，還得另找一處帶過去）。
 */
export interface ThreadsMark {
  /** 水位：從第 1 章起連續判過的最後一章。一章都沒判過是 0。 */
  through: number;
  /** 水位之後另外判過的章：升序、不重複、都大於 `through + 1`。 */
  judged: number[];
}

/** 從 `project.json` 讀出來的兩項認成 {@link ThreadsMark}。手改壞了的（不是正整數、重複、落在水位以內）不認，不崩（第 1 條）。 */
export function threadsMarkOf(manifest: { threadsThrough?: unknown; threadsJudged?: unknown }): ThreadsMark {
  const whole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
  let through = whole(manifest.threadsThrough) ? manifest.threadsThrough : 0;
  const ahead = new Set(Array.isArray(manifest.threadsJudged) ? manifest.threadsJudged.filter(whole) : []);
  // 手改出來的「水位 + 1 也在 judged 裡」：順著推上去（與 advanceThreadsMark 同一個口徑）。
  while (ahead.has(through + 1)) {
    ahead.delete(through + 1);
    through++;
  }
  return { through, judged: [...ahead].filter((no) => no > through).sort((a, b) => a - b) };
}

/**
 * 判過第 `no` 章之後的水位：`no` 正好是水位 + 1 就往後推，並順著後面已經判過的章接著推；更靠後的記進 `judged`；水位以內的
 * （重新定稿早前的章）不變。單章定稿、立即同步、寫完即定稿、從已寫正文補記判完一章都走它。
 */
export function advanceThreadsMark(mark: ThreadsMark, no: number): ThreadsMark {
  if (!Number.isInteger(no) || no <= mark.through) {
    return mark;
  }
  if (no > mark.through + 1) {
    return mark.judged.includes(no) ? mark : { through: mark.through, judged: [...mark.judged, no].sort((a, b) => a - b) };
  }
  return threadsMarkOf({ threadsThrough: no, threadsJudged: mark.judged });
}

/** 第 `no` 章的敘事線判過沒有：在水位以內，或者水位之後另外判過。 */
export function isThreadsJudged(mark: ThreadsMark, no: number): boolean {
  return no <= mark.through || mark.judged.includes(no);
}

/** 定稿過、敘事線卻還沒判的章：`finalized`（定稿過的章號）裡沒判過的，升序。工程頁「⚠ 第 a–b 章還沒判」、補記都按它。 */
export function unjudgedChapters(mark: ThreadsMark, finalized: Iterable<number>): number[] {
  return [...new Set(finalized)].filter((no) => !isThreadsJudged(mark, no)).sort((a, b) => a - b);
}

/**
 * 章號連成段：`[3, 31, 32, …, 60]` →「第 3、31–60 章」。段太多時只列前 `max` 段，後面寫「等 N 章」（工程頁一行放得下）。
 * 空的給空串。
 */
export function describeChapterRuns(nos: readonly number[], max = 3): string {
  const sorted = [...new Set(nos)].sort((a, b) => a - b);
  const runs: [number, number][] = [];
  for (const no of sorted) {
    const last = runs[runs.length - 1];
    if (last && no === last[1] + 1) {
      last[1] = no;
    } else {
      runs.push([no, no]);
    }
  }
  if (runs.length === 0) {
    return '';
  }
  const text = runs
    .slice(0, max)
    .map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`))
    .join('、');
  return runs.length > max ? `第 ${text} 章等 ${sorted.length} 章` : `第 ${text} 章`;
}
