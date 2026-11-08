import { traditionalLabel } from './labels';
import { canonicalLabel } from './labels';
/**
 * 敘事線裡的故事時間（2026-10-24，設計見 docs/design/plans/2026-10-24-story-timeline.md，同日重做見
 * docs/design/plans/2026-10-24-story-timeline-rework.md）：`threads/时间线.md` 一章一行，記這一章開頭比上一章結尾晚多久。
 *
 * ```markdown
 * ---
 * calendar: 簡單歷          # 簡單歷（每月 30 天、一年 12 個月）/ 公曆；缺席是簡單歷
 * start: 大衍三年三月初七     # 第 1 天是哪天；不填只顯示「第幾天」
 * generatedBy: novelwarden
 * ---
 *
 * # 時間線
 *
 * - 第 1 章：+0 天，傍晚 → 深夜〔依據：「連日大雨的第三天傍晚」〕
 * - 第 4 章：+1 天，清晨 → 夜裡，歷時 3 天〔依據：「次日清晨，雨停了」〕〔文中：八月十五（中秋），開頭後 2 天「今夜便是中秋」〕
 * - 第 7 章：回憶，約二十年前〔推測：整章是回憶〕
 * - 第 9 章：+?〔推不出：正文沒交代過了多久〕〔季節：冬「北風捲著碎雪」〕
 * - 第 12 章：八月十五，傍晚           ← 作者定的錨點
 * ```
 *
 * ## 幾條約定
 *
 * - **日期一律現算**（{@link computeTimeline}）：機器寫的是相對量；作者把哪一行改成日期或「第 N 天」，哪一行就是錨點，後面機器推的
 *   章跟著順延——檔案裡不寫推算出來的日期，改一個錨點不會留下一串過期的日期。狀態不落盤（第 18 條）。
 * - **正文寫明的日子當校準點**（重做）：〔文中〕是正文明寫的日期或節日，推算到那一章按它對齊，一路累加的誤差在那裡清零；優先順序是
 *   作者的錨點 > 〔文中〕 > 累加。〔季節〕只拿來對賬（{@link timelineIssues}）。
 * - **機器寫的行機器能換，作者的行不動**（{@link upsertTimelineEntry}、{@link isMachineEntry}）：帶〔依據〕〔推測〕〔推不出〕的是機器
 *   寫的，同步與重推（`refresh`）照新推的換，補推（`fill`）只填空；作者寫的一律不動（第 28 條）。
 * - **怎麼手改都不崩**（第 1 條）：認不出的行原樣留著，這一章當「沒推」算；認不出的〔文中〕〔季節〕當沒寫。
 * - 純函式、無 I/O：讀在 `model/project.ts` 的 `readThreads`，寫在閘道器（`Workspace.updateThread`）。
 */
import { asString, parseMarkdown } from './markdown';
import { QuoteIndex, indexText, normalizeQuote, quoteFound } from './review';
import { nearestSentence } from './continuity';
import { TIMELINE_NAME } from './threadFile';

export { TIMELINE_NAME };

/** 上下文裡那一條的標籤（context/layers/background.ts 登記、builder.ts 拿它單獨成一節）。 */
export const STORY_TIME_LABEL = '故事時間';

// ---------------------------------------------------------------- 型別

/** 曆法（作者定的）：簡單歷每月 30 天、一年 12 個月；公曆是真實的月份長短與閏年。不做農曆。 */
export type TimelineCalendar = '简单历' | '公历';
export const TIMELINE_CALENDARS: readonly TimelineCalendar[] = ['简单历', '公历'];

/** 一行的值。`delta` 的單位已經換成天。 */
export type TimelineValue =
  | { kind: 'delta'; days: number }
  | { kind: 'unknown' }
  | { kind: 'flashback'; ago: string }
  | { kind: 'day'; day: number }
  | { kind: 'date'; text: string };

/** 行尾的那一段：依據（原文）、推測（理由）、推不出（理由）。機器寫的行都帶它。 */
export type TimelineBasisKind = '依据' | '推测' | '推不出';
export const TIMELINE_BASIS_KINDS: readonly TimelineBasisKind[] = ['依据', '推测', '推不出'];

/** 四季（〔季節〕那一段，只拿來對賬）。 */
export type TimelineSeason = '春' | '夏' | '秋' | '冬';

/**
 * 〔文中：八月十五（中秋），開頭後 2 天「今夜便是中秋」〕（2026-10-24 重做）：正文明寫本章某一天是幾月幾日或哪個節日。推算時拿它對齊
 * （{@link computeTimeline}）。`date` 與 `festival` 至少有一個；只有節日的，推算時按曆法換成日子（{@link festivalDate}）。
 */
export interface TimelineDateMark {
  date?: string;
  festival?: string;
  /** 那一天在本章開頭之後第幾天（開頭當天是 0）。 */
  offset: number;
  /** 原文。 */
  quote?: string;
}

/** 〔季節：冬「北風捲著碎雪」〕：正文明寫或明擺著的季節。 */
export interface TimelineSeasonMark {
  season: TimelineSeason;
  quote?: string;
}

export interface TimelineEntry {
  chapter: number;
  value: TimelineValue;
  /** 本章開頭的時段（只顯示）。 */
  part?: string;
  /** 本章結尾的時段（只顯示；交給下一章判「當晚」「次日」用）。 */
  endPart?: string;
  /** 本章跨了幾天（1 = 同一天裡寫完）。 */
  span: number;
  basis?: { kind: TimelineBasisKind; text: string };
  dateMark?: TimelineDateMark;
  seasonMark?: TimelineSeasonMark;
}

/** 一份時間線（`threads/时间线.md`）。 */
export interface Timeline {
  relPath: string;
  /** 檔案在不在（不在時 entries 是空的）。 */
  exists: boolean;
  calendar: TimelineCalendar;
  /** frontmatter 裡 `start` 的原文（空串 = 沒填）。 */
  startText: string;
  /** 認出來的起點；沒填、認不出時缺席（只顯示第幾天）。 */
  start?: CalendarDate;
  /** 一章一行（同一章寫了兩行認第一行），按檔案裡的先後。 */
  entries: TimelineEntry[];
  /** 認不出的行：`第 N 章` 認得出、值認不出的那幾章（當「沒推」算）。 */
  bad: number[];
}

/** 檔案裡一行的樣子：`- 第 N 章：值，開頭時段 → 結尾時段，歷時 M 天〔依據：「原文」〕〔文中：…〕〔季節：…〕`。 */
const BULLET = /^\s*(?:[-*•·]|\d+[.)、])\s+/u;
const LINE_HEAD = /^第\s*(\d+)\s*章\s*[:：·・\s]\s*/u;
/**
 * 行尾一段的開頭：`〔依據：`、`〔推測：`、`〔推不出：`、`〔文中：`、`〔季節：`；括號寫成 `[]`、`【】`、`（）` 也認，「證據」當「依據」。
 * 幾段從後往前一段一段剝（{@link splitTails}），先後不限。
 */
const TAIL_OPEN = /[〔\[【（(]\s*(依(?:据|據)|(?:证|證)(?:据|據)|推(?:测|測)|推不出|文中|季(?:节|節))\s*[:：]?\s*/gu;
const TAIL_CLOSE = /[〕\]】）)]\s*$/u;
const QUOTES: [string, string][] = [['「', '」'], ['『', '』'], ['“', '”'], ['"', '"'], ["'", "'"]];
/** 段尾的原文：`…「原文」`。 */
const QUOTE_TAIL = /[「『“"]([^「『“"]*)[」』”"]\s*$/u;
/** 時段一格寫成 `開頭 → 結尾`（`->` 也認）；只知道結尾寫 `→ 夜裡`。 */
const PART_RANGE = /^(.*?)\s*(?:→|->|－>|—>|⟶)\s*(.+)$/u;

/** 一行最長的依據、理由（字）。 */
export const TIME_BASIS_MAX = 120;
/** 「多久以前」最長多少字。 */
const AGO_MAX = 20;
/** 差值與跨度的上限（天）：約十萬年，修仙跨幾百年也夠。 */
export const TIME_DAYS_MAX = 36_500_000;

function unquote(s: string): string {
  const t = s.trim();
  for (const [a, b] of QUOTES) {
    if (t.length >= 2 && t.startsWith(a) && t.endsWith(b)) {
      return t.slice(a.length, -b.length).trim();
    }
  }
  return t;
}

function cut(text: string, max: number): string {
  return [...text].slice(0, max).join('').trim();
}

// ---------------------------------------------------------------- 數字

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, '○': 0, 一: 1, 二: 2, 两: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_DIGIT_CHARS = '零一二三四五六七八九';

/** 全形數字換成半形。 */
function asciiDigits(s: string): string {
  return s.replace(/[０-９]/gu, (c) => String.fromCharCode(c.charCodeAt(0) - 0xff10 + 0x30));
}

/** 阿拉伯數字或漢字數字（讀法「一百零五」「廿一」「初七」，或逐位「二〇二六」）。認不出返回 undefined。 */
export function parseNumber(raw: string): number | undefined {
  const s = asciiDigits(raw.trim()).replace(/^初/u, '');
  if (!s) {
    return undefined;
  }
  if (/^\d+$/u.test(s)) {
    return Number(s);
  }
  if (s === '元') {
    return 1;
  }
  // 逐位寫的（「二〇二六」）：沒有十百千萬。
  if ([...s].length > 1 && [...s].every((c) => c in CN_DIGIT)) {
    return Number([...s].map((c) => CN_DIGIT[c]).join(''));
  }
  let total = 0;
  let section = 0;
  let num = -1;
  for (const c of s) {
    if (c in CN_DIGIT) {
      num = CN_DIGIT[c];
    } else if (c === '十' || c === '百' || c === '千') {
      section += (num < 0 ? 1 : num) * (c === '十' ? 10 : c === '百' ? 100 : 1000);
      num = -1;
    } else if ((c === '万' || c === '萬')) {
      total += (section + Math.max(num, 0)) * 10000;
      section = 0;
      num = -1;
    } else if (c === '廿' || c === '卅') {
      section += c === '廿' ? 20 : 30;
      num = -1;
    } else {
      return undefined;
    }
  }
  return total + section + Math.max(num, 0);
}

/** 漢字讀法（1 → 一，14 → 十四，105 → 一百零五，-3 → 負三）。 */
export function cnNumber(n: number): string {
  if (n < 0) {
    return `負${cnNumber(-n)}`;
  }
  if (n === 0) {
    return '零';
  }
  const under10000 = (v: number): string => {
    let s = '';
    let zero = false;
    for (const [unit, name] of [
      [1000, '千'],
      [100, '百'],
      [10, '十'],
      [1, ''],
    ] as const) {
      const d = Math.floor(v / unit) % 10;
      if (d === 0) {
        zero = s !== '';
        continue;
      }
      if (zero) {
        s += '零';
        zero = false;
      }
      s += CN_DIGIT_CHARS[d] + name;
    }
    return s;
  };
  let s: string;
  if (n >= 10000) {
    const high = Math.floor(n / 10000);
    const low = n % 10000;
    s = `${cnNumber(high)}萬${low === 0 ? '' : `${low < 1000 ? '零' : ''}${under10000(low)}`}`;
  } else {
    s = under10000(n);
  }
  return s.startsWith('一十') ? s.slice(1) : s;
}

/** 農曆式的日子：初一…初十、十一…十九、二十、廿一…廿九、三十。31 起寫讀法。 */
function tradDay(d: number): string {
  if (d >= 1 && d <= 10) {
    return `初${d === 10 ? '十' : CN_DIGIT_CHARS[d]}`;
  }
  if (d > 10 && d < 20) {
    return `十${CN_DIGIT_CHARS[d - 10]}`;
  }
  if (d === 20) {
    return '二十';
  }
  if (d > 20 && d < 30) {
    return `廿${CN_DIGIT_CHARS[d - 20]}`;
  }
  return cnNumber(d);
}

// ---------------------------------------------------------------- 曆法

/** 年、月、日的寫法：輸出照起點的樣子寫。 */
export interface DateStyle {
  /** 年號（「大衍」），沒有是空串。 */
  era: string;
  /** 起點寫沒寫年份。 */
  hasYear: boolean;
  year: 'num' | 'cn' | 'cnDigits';
  month: 'num' | 'cn' | 'trad';
  day: 'num' | 'cn' | 'trad' | 'iso' | 'slash';
}

/** 一個日子（年份沒寫時是 undefined）。 */
export interface CalendarDate {
  y?: number;
  m: number;
  d: number;
  style: DateStyle;
}

const DATE_CN = new RegExp(
  '^(?<era>.*?)' +
    '(?:(?<y>[0-9０-９〇零○一二两兩三四五六七八九十百千千万萬]+|元)\\s*年)?\\s*' +
    '(?<m>[0-9０-９]{1,2}|十[一二]|[一二两兩三四五六七八九十]|正|冬|腊|臘)\\s*月\\s*' +
    '(?:(?<d>初[一二三四五六七八九十]|[0-9０-９]{1,2}|[一二兩三四五六七八九十廿卅]{1,3})\\s*(?<suffix>[日号號])?)?$',
  'u'
);
const DATE_ISO = /^(?<y>\d{1,6})(?<sep>[-/.])(?<m>\d{1,2})\k<sep>(?<d>\d{1,2})$/u;

/** 認一個日子：`大衍三年三月初七`、`三月十四`、`2026年3月7日`、`2026-03-07`、`2026/3/7`。認不出返回 undefined。 */
export function parseDate(raw: string): CalendarDate | undefined {
  const s = asciiDigits(raw.trim()).replace(/\s+/gu, '');
  if (!s) {
    return undefined;
  }
  const iso = DATE_ISO.exec(s);
  if (iso?.groups) {
    const g = iso.groups;
    return {
      y: Number(g.y),
      m: Number(g.m),
      d: Number(g.d),
      style: { era: '', hasYear: true, year: 'num', month: 'num', day: g.sep === '-' ? 'iso' : 'slash' },
    };
  }
  const m = DATE_CN.exec(s);
  if (!m?.groups) {
    return undefined;
  }
  const g = m.groups;
  const era = (g.era ?? '').trim();
  if (era && !g.y) {
    // 「大衍三月」：年號後面沒有年，認不準，不認。
    return undefined;
  }
  const month = g.m === '正' ? 1 : g.m === '冬' ? 11 : g.m === '腊' || g.m === '臘' ? 12 : parseNumber(g.m);
  const day = g.d ? parseNumber(g.d) : 1;
  const year = g.y ? parseNumber(g.y) : undefined;
  if (month === undefined || day === undefined || (g.y && year === undefined)) {
    return undefined;
  }
  const monthStyle: DateStyle['month'] = /^[0-9]/u.test(g.m) ? 'num' : /^[正冬腊臘]$/u.test(g.m) ? 'trad' : 'cn';
  const dayStyle: DateStyle['day'] = !g.d
    ? monthStyle === 'num'
      ? 'num'
      : 'trad'
    : /^[0-9]/u.test(g.d)
      ? 'num'
      : g.suffix && !/^初|[廿卅]/u.test(g.d)
        ? 'cn'
        : 'trad';
  const yearStyle: DateStyle['year'] = !g.y || /^[0-9]/u.test(g.y) ? 'num' : /^[〇零○一二两三四五六七八九兩]{2,}$/u.test(g.y) ? 'cnDigits' : 'cn';
  return {
    ...(year !== undefined ? { y: year } : {}),
    m: month,
    d: day,
    style: { era, hasYear: year !== undefined, year: yearStyle, month: monthStyle, day: dayStyle },
  };
}

/** 公曆沒寫年份時內部用的年（平年）：只拿來算月份長短。 */
const GREGORIAN_YEARLESS = 2001;
const DAY_MS = 86_400_000;

/** 這一天在這個曆法下的序號（相鄰兩天差 1）。日期不存在（三月三十一、二月二十九）返回 undefined。 */
function ordinalOf(cal: TimelineCalendar, y: number, m: number, d: number): number | undefined {
  if (!(m >= 1 && m <= 12 && d >= 1)) {
    return undefined;
  }
  if (cal === '简单历') {
    return d > 30 ? undefined : (y * 12 + (m - 1)) * 30 + (d - 1);
  }
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    return undefined;
  }
  return Math.round(t / DAY_MS);
}

function fromOrdinal(cal: TimelineCalendar, o: number): { y: number; m: number; d: number } {
  if (cal === '简单历') {
    const y = Math.floor(o / 360);
    const rest = o - y * 360;
    return { y, m: Math.floor(rest / 30) + 1, d: (rest % 30) + 1 };
  }
  const t = new Date(o * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** 起點在這個曆法下的序號。沒寫年份的：簡單歷當第 1 年，公曆當一個平年。 */
function startOrdinal(cal: TimelineCalendar, start: CalendarDate): number | undefined {
  return ordinalOf(cal, start.y ?? (cal === '简单历' ? 1 : GREGORIAN_YEARLESS), start.m, start.d);
}

/** 一年幾天（`+N 年` 換成天、半年）。 */
function yearDays(cal: TimelineCalendar): number {
  return cal === '简单历' ? 360 : 365;
}

function yearText(y: number, style: DateStyle): string {
  if (style.year === 'num') {
    return String(y);
  }
  if (style.year === 'cnDigits' && y >= 0) {
    return [...String(y)].map((c) => '〇一二三四五六七八九'[Number(c)]).join('');
  }
  return y === 1 && style.era ? '元' : cnNumber(y);
}

function monthText(m: number, style: DateStyle): string {
  if (style.month === 'num') {
    return `${m}月`;
  }
  if (style.month === 'trad' && (m === 1 || m === 11 || m === 12)) {
    return m === 1 ? '正月' : m === 11 ? '冬月' : '臘月';
  }
  return `${cnNumber(m)}月`;
}

function dayText(d: number, style: DateStyle): string {
  switch (style.day) {
    case 'trad':
      return tradDay(d);
    case 'cn':
      return `${cnNumber(d)}日`;
    default:
      return `${d}日`;
  }
}

/** 起點沒寫年份時，跨年寫「次年」「第三年」「前一年」。 */
function yearOffsetText(k: number, style: DateStyle): string {
  if (k === 0) {
    return '';
  }
  const n = (v: number) => (style.month === 'num' ? String(v) : cnNumber(v));
  if (k === 1) {
    return '次年';
  }
  if (k > 1) {
    return `第${n(k + 1)}年`;
  }
  return k === -1 ? '前一年' : `${n(-k)}年前`;
}

/** 一天的幾種寫法。 */
export interface DayLabel {
  /** 全稱：`大衍三年三月十四`、`次年三月十四`、`2026年3月14日`；沒有起點是 `第 8 天`。 */
  full: string;
  /** 總覽那一格：`十四`、`14`；沒有起點是 `8`。 */
  short: string;
  /** 月份帶上那一段：`大衍三年三月`、`2026年3月`。沒有起點時缺席。 */
  month?: string;
  /** 只有月：`三月`、`3月`（月份帶上年份沒變時只寫它）。沒有起點時缺席。 */
  monthName?: string;
}

/** 故事第 `day` 天怎麼寫（第 1 天 = 起點）。 */
export function dayLabel(tl: Pick<Timeline, 'calendar' | 'start'>, day: number): DayLabel {
  const plain: DayLabel = { full: `第 ${day} 天`, short: String(day) };
  if (!tl.start) {
    return plain;
  }
  const base = startOrdinal(tl.calendar, tl.start);
  if (base === undefined) {
    return plain;
  }
  const ymd = fromOrdinal(tl.calendar, base + day - 1);
  const style = tl.start.style;
  return formatYmd(ymd, style, style.hasYear ? undefined : yearOffsetText(ymd.y - fromOrdinal(tl.calendar, base).y, style));
}

/**
 * 一個日子照 `style`（起點的寫法）寫出來。`yearPart` 是起點沒寫年份時的「次年」「第三年」（空串 = 起點那一年，只寫月日）；
 * 起點寫了年份時不傳，照年號與年份寫。
 */
function formatYmd(ymd: { y: number; m: number; d: number }, style: DateStyle, yearPart?: string): DayLabel & { month: string; monthName: string } {
  const { y, m, d } = ymd;
  if (style.day === 'iso' || style.day === 'slash') {
    const pad = (v: number) => (style.day === 'iso' ? String(v).padStart(2, '0') : String(v));
    const sep = style.day === 'iso' ? '-' : '/';
    return { full: `${y}${sep}${pad(m)}${sep}${pad(d)}`, short: String(d), month: `${y}${sep}${pad(m)}`, monthName: `${m}月` };
  }
  const year = yearPart ?? `${style.era}${yearText(y, style)}年`;
  const monthName = monthText(m, style);
  const month = `${year}${monthName}`;
  const short = style.day === 'trad' ? tradDay(d) : style.day === 'cn' ? cnNumber(d) : String(d);
  return { full: `${month}${dayText(d, style)}`, short, month, monthName };
}

/**
 * 錨點寫的日子是故事第幾天。沒寫年份的取 `after`（上一章結尾那一天）當天或之後最近的那一個。沒有起點、日子不存在、認不出時
 * 返回 undefined。
 */
export function dayOfDate(tl: Pick<Timeline, 'calendar' | 'start'>, text: string, after: number): number | undefined {
  const date = parseDate(text);
  if (!date || !tl.start) {
    return undefined;
  }
  const base = startOrdinal(tl.calendar, tl.start);
  if (base === undefined) {
    return undefined;
  }
  if (date.y !== undefined) {
    // 起點沒寫年份時，錨點寫的年份當「第幾年」（內部第 1 年就是起點那一年）。
    const o = ordinalOf(tl.calendar, date.y, date.m, date.d);
    return o === undefined ? undefined : o - base + 1;
  }
  const ref = fromOrdinal(tl.calendar, base + Math.max(after, 1) - 1);
  for (const y of [ref.y, ref.y + 1]) {
    const o = ordinalOf(tl.calendar, y, date.m, date.d);
    if (o !== undefined && o - base + 1 >= Math.max(after, 1)) {
      return o - base + 1;
    }
  }
  // 二月二十九：往後找到有它的那一年（公曆最多八年一遇）。
  for (let y = ref.y + 2; y <= ref.y + 8; y++) {
    const o = ordinalOf(tl.calendar, y, date.m, date.d);
    if (o !== undefined) {
      return o - base + 1;
    }
  }
  return undefined;
}

/**
 * 正文寫明的一天（〔文中〕）是故事第幾天：沒寫年份的取**離 `estimate`（按前文推下來的那一天）最近**的那一個（⚑1：不取「之後最近」，
 * 前文推多了幾天時那會跳到明年）；寫了年份的就是那一天。沒有起點、日子不存在時返回 undefined。
 */
export function dayNearest(tl: Pick<Timeline, 'calendar' | 'start'>, date: CalendarDate, estimate: number): number | undefined {
  if (!tl.start) {
    return undefined;
  }
  const base = startOrdinal(tl.calendar, tl.start);
  if (base === undefined) {
    return undefined;
  }
  if (date.y !== undefined && date.m > 0) {
    const o = ordinalOf(tl.calendar, date.y, date.m, date.d);
    return o === undefined ? undefined : o - base + 1;
  }
  const ref = fromOrdinal(tl.calendar, base + estimate - 1);
  // 候選：前後一年裡的這一天；只寫了日的（m 是 0），前後一個月裡的這一天。
  const candidates: { y: number; m: number }[] = [];
  if (date.m > 0) {
    for (let y = ref.y - 1; y <= ref.y + 1; y++) {
      candidates.push({ y, m: date.m });
    }
  } else {
    for (let k = -1; k <= 1; k++) {
      const i = ref.y * 12 + (ref.m - 1) + k;
      candidates.push({ y: Math.floor(i / 12), m: (((i % 12) + 12) % 12) + 1 });
    }
  }
  let best: number | undefined;
  for (const { y, m } of candidates) {
    const o = ordinalOf(tl.calendar, y, m, date.d);
    if (o === undefined) {
      continue;
    }
    const day = o - base + 1;
    // 一樣近時取後面那一個（故事多半往前走）。
    if (best === undefined || Math.abs(day - estimate) < Math.abs(best - estimate) || (Math.abs(day - estimate) === Math.abs(best - estimate) && day > best)) {
      best = day;
    }
  }
  return best;
}

/** 故事第 `day` 天是幾月（沒有起點時 undefined）。 */
export function monthOfDay(tl: Pick<Timeline, 'calendar' | 'start'>, day: number): number | undefined {
  const base = tl.start ? startOrdinal(tl.calendar, tl.start) : undefined;
  return base === undefined ? undefined : fromOrdinal(tl.calendar, base + day - 1).m;
}

// ---------------------------------------------------------------- 節日與季節（2026-10-24 重做）

/**
 * 節日換成哪一天（⚑4）：簡單歷按農曆口徑；公曆只認幾個公曆節日（農曆節日在公曆裡年年不同，換不出）。節氣（清明、冬至）年年漂，不換。
 */
const FESTIVALS: Record<TimelineCalendar, Record<string, [number, number]>> = {
  简单历: {
    春节: [1, 1],
    元日: [1, 1],
    元旦: [1, 1],
    新年: [1, 1],
    大年初一: [1, 1],
    元宵: [1, 15],
    上元: [1, 15],
    上巳: [3, 3],
    端午: [5, 5],
    端阳: [5, 5],
    七夕: [7, 7],
    乞巧: [7, 7],
    中元: [7, 15],
    盂兰盆: [7, 15],
    中秋: [8, 15],
    重阳: [9, 9],
    重九: [9, 9],
    下元: [10, 15],
    腊八: [12, 8],
    小年: [12, 23],
    除夕: [12, 30],
    大年夜: [12, 30],
    年三十: [12, 30],
  },
  公历: {
    元旦: [1, 1],
    新年: [1, 1],
    情人节: [2, 14],
    劳动节: [5, 1],
    五一: [5, 1],
    国庆: [10, 1],
    平安夜: [12, 24],
    圣诞: [12, 25],
  },
};

/** 節日名去掉「節」「夜」這類尾巴：`中秋節` → `中秋`。 */
function festivalKey(name: string): string {
  const s = name.trim().replace(/[「」『』“”"']/gu, '');
  return s.replace(/(?:(?:节|節)|節)$/u, '').replace(/^(中秋|元宵|七夕|除夕)夜$/u, '$1');
}

/** 節日是這個曆法裡的哪一天（月、日）。認不出、這個曆法裡換不出時 undefined。 */
export function festivalDate(cal: TimelineCalendar, name: string): { m: number; d: number } | undefined {
  const hit = FESTIVALS[cal][canonicalLabel(festivalKey(name))];
  return hit ? { m: hit[0], d: hit[1] } : undefined;
}

const DAY_ONLY = /^(初[一二三四五六七八九十]|[0-9０-９]{1,2}|[一二两三四五六七八九十廿卅兩]{1,3})\s*[日号號]?$/u;

/**
 * 〔文中〕的日期：認 {@link parseDate} 的幾種寫法，也認只寫了日的（「二十一日」「十五」，古典小說裡常見）——只寫日的 `m` 是 0，推算時取
 * 離推算最近的那個月裡的這一天（{@link dayNearest}）。
 */
export function parseMarkDate(raw: string): CalendarDate | undefined {
  const full = parseDate(raw);
  if (full) {
    return full;
  }
  const m = DAY_ONLY.exec(asciiDigits(raw.trim()).replace(/\s+/gu, ''));
  const d = m ? parseNumber(m[1]) : undefined;
  return d !== undefined && d >= 1 && d <= 31 ? { m: 0, d, style: { era: '', hasYear: false, year: 'num', month: 'cn', day: 'trad' } } : undefined;
}

/** 〔文中〕那一天：寫了日期的認日期，只寫了節日的按曆法換。認不出返回 undefined。 */
export function markDate(cal: TimelineCalendar, mark: TimelineDateMark): CalendarDate | undefined {
  if (mark.date) {
    const d = parseMarkDate(mark.date);
    if (d) {
      return d;
    }
  }
  const f = mark.festival ? festivalDate(cal, mark.festival) : undefined;
  return f ? { m: f.m, d: f.d, style: { era: '', hasYear: false, year: 'num', month: 'cn', day: 'trad' } } : undefined;
}

/** 〔文中〕那一段怎麼說：`八月十五（中秋）`、`中秋`。 */
export function describeDateMark(mark: TimelineDateMark): string {
  return mark.date ? `${mark.date}${mark.festival ? `（${mark.festival}）` : ''}` : (mark.festival ?? '');
}

const SEASONS: readonly TimelineSeason[] = ['春', '夏', '秋', '冬'];

/** 認季節：`春` / `春天` / `春季` / `冬日`……認不出返回 undefined。 */
export function parseSeason(raw: string): TimelineSeason | undefined {
  const m = /^\s*(春|夏|秋|冬)(?:天|季|日)?\s*$/u.exec(raw ?? '');
  return m ? (m[1] as TimelineSeason) : undefined;
}

/** 一個季節是哪幾個月：簡單歷按農曆口徑（正月到三月是春），公曆按 3–5 月是春。 */
function seasonMonths(cal: TimelineCalendar, season: TimelineSeason): number[] {
  const first = (cal === '简单历' ? 1 : 3) + SEASONS.indexOf(season) * 3;
  return [0, 1, 2].map((k) => ((first - 1 + k) % 12) + 1);
}

/** 這個月放不放得進這個季節：前後各寬一個月（季節交界處的「還冷」「已經熱了」都算）。 */
export function monthFitsSeason(cal: TimelineCalendar, month: number, season: TimelineSeason): boolean {
  const months = seasonMonths(cal, season);
  const wide = new Set([((months[0] + 10) % 12) + 1, ...months, (months[2] % 12) + 1]);
  return wide.has(month);
}

// ---------------------------------------------------------------- 解析

/** 認得出的時段（只顯示）：一個短詞。 */
const PART_WORDS =
  /^(?:凌晨|拂(?:晓|曉)|黎明|破(?:晓|曉)|清晨|早晨|早上|上午|晌午|中午|正午|午(?:后|後)|下午|傍晚|(?:黄|黃)昏|入夜|夜(?:里|裡)|夜(?:间|間)|晚上|夜晚|深夜|半夜|午夜|白天|夜|[一二三四五]更(?:天)?)$/u;

const UNIT_DAYS: Record<string, (cal: TimelineCalendar) => number> = {
  天: () => 1,
  日: () => 1,
  周: () => 7,
  星期: () => 7,
  礼拜: () => 7,
  月: () => 30,
  年: (cal) => yearDays(cal),
};

const RELATIVE = /^([+＋\-－−])\s*(\?|？|[0-9０-９]+|[〇零一二两三四五六七八九十百千万兩萬]+|半)\s*((?:个|個))?\s*(天|日|周|星期|(?:礼|禮)拜|月|年)?$/u;
const SAME_DAY = /^(?:同日|(?:当|當)日|(?:当|當)天|同一天|同天)$/u;
const NEXT_DAY = /^(?:次日|翌日|隔天|隔日|第二天|第二日)$/u;
const DAY_ANCHOR = /^(?:故事)?第\s*([0-9０-９]+)\s*天$/u;
const FLASHBACK = /^(?:回(?:忆|憶)|倒(?:叙|敘)|(?:闪|閃)回|追(?:忆|憶))\s*(.*)$/u;
const SPAN = /^(?:(?:历|歷)(?:时|時)|共|跨)\s*([0-9０-９]+|[〇零一二两三四五六七八九十百千万兩萬]+|半)\s*((?:个|個))?\s*(天|日|周|星期|月|年)$/u;

/**
 * 認一行的值（不含時段、歷時）。`cal` 用來把 `+N 年` 換成天。認不出返回 undefined。
 * 日期錨點在這裡只認形狀（能不能換成第幾天要看起點與上一章，推算時再算）。
 */
export function parseTimeValue(raw: string, cal: TimelineCalendar = '简单历'): TimelineValue | undefined {
  const s = raw.trim();
  if (!s) {
    return undefined;
  }
  if (SAME_DAY.test(s)) {
    return { kind: 'delta', days: 0 };
  }
  if (NEXT_DAY.test(s)) {
    return { kind: 'delta', days: 1 };
  }
  const rel = RELATIVE.exec(s);
  if (rel) {
    if (rel[2] === '?' || rel[2] === '？') {
      return { kind: 'unknown' };
    }
    const unit = UNIT_DAYS[rel[4] ?? '天'](cal);
    const n = rel[2] === '半' ? 0.5 : parseNumber(rel[2]);
    if (n === undefined) {
      return undefined;
    }
    const days = Math.round(n * unit) * (rel[1] === '+' || rel[1] === '＋' ? 1 : -1);
    return Math.abs(days) <= TIME_DAYS_MAX ? { kind: 'delta', days: days === 0 ? 0 : days } : undefined;
  }
  const anchor = DAY_ANCHOR.exec(s);
  if (anchor) {
    const day = Number(asciiDigits(anchor[1]));
    return day >= 1 ? { kind: 'day', day } : undefined;
  }
  const back = FLASHBACK.exec(s);
  if (back) {
    return { kind: 'flashback', ago: cut(back[1].replace(/^[\s，,、]+/u, ''), AGO_MAX) };
  }
  return parseDate(s) ? { kind: 'date', text: s } : undefined;
}

function spanOf(raw: string, cal: TimelineCalendar): number | undefined {
  const m = SPAN.exec(raw.trim());
  if (!m) {
    return undefined;
  }
  const n = m[1] === '半' ? 0.5 : parseNumber(m[1]);
  if (n === undefined) {
    return undefined;
  }
  const days = Math.round(n * UNIT_DAYS[m[3]](cal));
  return days >= 1 && days <= TIME_DAYS_MAX ? days : undefined;
}

/**
 * 從行尾往前一段一段剝下 `〔標籤：內容〕`（{@link TAIL_OPEN}）：每次找最後一個以已知標籤開頭、又一直到行尾才收口的那一段。
 * 認不出的括號（「（中秋）」這種）留在內容裡。返回剝剩的前半截與剝下來的幾段（從前往後）。
 */
function splitTails(text: string): { rest: string; tails: { label: string; body: string }[] } {
  let rest = text;
  const tails: { label: string; body: string }[] = [];
  for (;;) {
    const close = TAIL_CLOSE.exec(rest);
    if (!close) {
      break;
    }
    let last: RegExpExecArray | undefined;
    TAIL_OPEN.lastIndex = 0;
    for (let m = TAIL_OPEN.exec(rest); m; m = TAIL_OPEN.exec(rest)) {
      if (m.index + m[0].length <= close.index) {
        last = m;
      }
    }
    if (!last) {
      break;
    }
    tails.unshift({ label: last[1], body: rest.slice(last.index + last[0].length, close.index).trim() });
    rest = rest.slice(0, last.index).trimEnd();
  }
  return { rest, tails };
}

/** 一段的內容拆成「前面的字」與段尾的原文（`八月十五（中秋），開頭後 2 天「今夜便是中秋」`）。 */
function splitQuote(body: string): { head: string; quote?: string } {
  const m = QUOTE_TAIL.exec(body);
  if (!m) {
    return { head: body.trim() };
  }
  const quote = m[1].trim();
  return { head: body.slice(0, m.index).trim(), ...(quote ? { quote } : {}) };
}

/** 〔文中：…〕：`八月十五（中秋），開頭後 2 天「原文」`、`中秋「原文」`。日期與節日都認不出時 undefined。 */
function parseDateMark(body: string): TimelineDateMark | undefined {
  const { head, quote } = splitQuote(body);
  const parts = head
    .split(/[，,、；;]/u)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }
  const m = /^(.*?)\s*[（(]\s*([^（）()]+?)\s*[）)]\s*$/u.exec(parts[0]);
  const first = (m ? m[1] : parts[0]).trim();
  let date: string | undefined;
  let festival = m ? m[2].trim() : undefined;
  if (parseMarkDate(first)) {
    date = first;
  } else if (!festival && first) {
    festival = first;
  }
  if (!date && !(festival && (festivalDate('简单历', festival) || festivalDate('公历', festival)))) {
    return undefined;
  }
  let offset = 0;
  for (const p of parts.slice(1)) {
    const k = /^(?:(?:开|開)(?:头|頭)(?:后|後)|(?:开|開)(?:头|頭)之(?:后|後)|本章第)\s*([0-9０-９]+|[〇零一二两三四五六七八九十百千万兩萬]+)\s*天$/u.exec(p);
    const n = k ? parseNumber(k[1]) : undefined;
    if (n !== undefined) {
      // 「本章第 3 天」是開頭後 2 天。
      offset = /^本章第/u.test(p) ? Math.max(0, n - 1) : n;
    }
  }
  return { ...(date ? { date } : {}), ...(festival ? { festival } : {}), offset, ...(quote ? { quote } : {}) };
}

/** 〔季節：冬「原文」〕。 */
function parseSeasonMark(body: string): TimelineSeasonMark | undefined {
  const { head, quote } = splitQuote(body);
  const season = parseSeason(head);
  return season ? { season, ...(quote ? { quote } : {}) } : undefined;
}

/**
 * 認一行（專案符號已經去掉）。不是 `第 N 章` 開頭的返回 undefined；`第 N 章` 認得出、值認不出的返回 `{ chapter, bad: true }`。
 * 行尾的〔文中〕〔季節〕認不出就當沒寫（只是輔助，第 1 條）。
 */
export function parseTimelineLine(
  line: string,
  cal: TimelineCalendar = '简单历'
): { entry: TimelineEntry } | { chapter: number; bad: true } | undefined {
  const head = LINE_HEAD.exec(line);
  if (!head) {
    return undefined;
  }
  const chapter = Number(head[1]);
  if (!(chapter > 0)) {
    return undefined;
  }
  const { rest, tails } = splitTails(line.slice(head[0].length));
  let basis: TimelineEntry['basis'];
  let dateMark: TimelineDateMark | undefined;
  let seasonMark: TimelineSeasonMark | undefined;
  for (const tail of tails) {
    if (tail.label === '文中') {
      dateMark ??= parseDateMark(tail.body);
    } else if (canonicalLabel(tail.label) === '季节') {
      seasonMark ??= parseSeasonMark(tail.body);
    } else if (!basis) {
      const kind: TimelineBasisKind = canonicalLabel(tail.label) === '证据' ? '依据' : (canonicalLabel(tail.label) as TimelineBasisKind);
      basis = { kind, text: kind === '依据' ? unquote(tail.body) : tail.body.trim() };
    }
  }
  const parts = rest
    .split(/[，,、；;]/u)
    .map((p) => p.trim())
    .filter(Boolean);
  const value = parts.length > 0 ? parseTimeValue(parts[0], cal) : undefined;
  if (!value) {
    return { chapter, bad: true };
  }
  let part: string | undefined;
  let endPart: string | undefined;
  let span = 1;
  let ago = value.kind === 'flashback' ? value.ago : '';
  for (const p of parts.slice(1)) {
    const days = spanOf(p, cal);
    const range = PART_RANGE.exec(p);
    if (days !== undefined) {
      span = days;
    } else if (!part && !endPart && range && PART_WORDS.test(range[2].trim()) && (!range[1].trim() || PART_WORDS.test(range[1].trim()))) {
      part = range[1].trim() || undefined;
      endPart = range[2].trim();
    } else if (!part && PART_WORDS.test(p)) {
      part = p;
    } else if (value.kind === 'flashback' && !ago) {
      ago = cut(p, AGO_MAX);
    }
  }
  return {
    entry: {
      chapter,
      value: value.kind === 'flashback' ? { kind: 'flashback', ago } : value,
      ...(part ? { part } : {}),
      ...(endPart ? { endPart } : {}),
      span,
      ...(basis ? { basis } : {}),
      ...(dateMark ? { dateMark } : {}),
      ...(seasonMark ? { seasonMark } : {}),
    },
  };
}

function calendarOf(text: string): TimelineCalendar {
  return /公(?:历|曆)|(?:阳|陽)(?:历|曆)|西(?:历|曆)|gregorian/iu.test(text) ? '公历' : '简单历';
}

/** 讀時間線。沒有這份檔案時傳空串（`exists` 為 false）。怎麼手改都不拋（第 1 條）。 */
export function parseTimelineFile(raw: string, relPath: string): Timeline {
  const text = raw ?? '';
  const { frontmatter, body } = parseMarkdown(text);
  const calendar = calendarOf(asString(frontmatter.calendar));
  const startText = asString(frontmatter.start).trim();
  const start = startText ? parseDate(startText) : undefined;
  const entries: TimelineEntry[] = [];
  const bad: number[] = [];
  const seen = new Set<number>();
  for (const rawLine of body.split(/\r?\n/u)) {
    const line = rawLine.replace(BULLET, '').trim();
    const got = parseTimelineLine(line, calendar);
    if (!got) {
      continue;
    }
    const chapter = 'entry' in got ? got.entry.chapter : got.chapter;
    if (seen.has(chapter)) {
      continue;
    }
    seen.add(chapter);
    if ('entry' in got) {
      entries.push(got.entry);
    } else {
      bad.push(chapter);
    }
  }
  return {
    relPath,
    exists: text.trim() !== '',
    calendar,
    startText,
    ...(start && startOrdinal(calendar, start) !== undefined ? { start } : {}),
    entries,
    bad,
  };
}

/** 沒有這份檔案時的時間線（`readThreads` 給不出來時用）。 */
export function emptyTimeline(relPath: string): Timeline {
  return { relPath, exists: false, calendar: '简单历', startText: '', entries: [], bad: [] };
}

// ---------------------------------------------------------------- 推算（現算，不落盤）

/** 一章的樣子。`dated`：開頭照正文寫明的日期（〔文中〕）對齊過（2026-10-24 重做）。 */
export type TimelineDayState = 'evidence' | 'guess' | 'unknown' | 'missing' | 'anchor' | 'dated' | 'flashback' | 'bad';

export interface TimelineDay {
  chapter: number;
  state: TimelineDayState;
  /** 開頭是故事第幾天（回憶的章缺席）。 */
  start?: number;
  /** 結尾是第幾天（= 開頭 + 跨度 − 1）。 */
  end?: number;
  /** 比上一章結尾晚幾天（第一章、回憶缺席）。 */
  delta?: number;
  span: number;
  part?: string;
  endPart?: string;
  /** 回憶：大約多久以前。 */
  ago?: string;
  basis?: TimelineEntry['basis'];
  dateMark?: TimelineDateMark;
  seasonMark?: TimelineSeasonMark;
  /**
   * 照〔文中〕對齊過：按前文推下來是第幾天（`estimate`）、對齊差了幾天（`drift` = 開頭 − estimate）；`unknown`：這一行本來是 `+?`
   * （差幾天是預料之中的，對賬不報，⚑2）。
   */
  aligned?: { estimate: number; drift: number; unknown?: true };
  /**
   * 〔文中〕沒拿來對齊、又和這一章對不上：正文寫的是第幾天（`day`），為什麼沒對齊（`why`）——作者的錨點（`anchor`）、第 1 章就是
   * 起點（`start`），或者正文只寫了日、沒寫月（`dayOnly`：月份可能差出去，只對賬不對齊，試跑之後定的）。
   */
  conflict?: { day: number; why: 'anchor' | 'start' | 'dayOnly' };
}

export interface TimelineCalc {
  /** 第 1 章到檔案裡出現過的最大章號（`upTo` 截過的），一章一項。 */
  days: TimelineDay[];
  /** 檔案裡寫到第幾章（認得出、認不出的行都算）。沒有一行是 0。 */
  last: number;
  /** 故事裡過了幾天（走到的最遠那一天，一般就是最後一章的結尾）。一行都沒有是 0。 */
  elapsed: number;
}

/**
 * 從第 1 章往後推（設計稿「推算」）：沒有這一行的、`+?` 的、認不出的按緊接上一章（開頭 = 上一章結尾）算；錨點就是那一天；回憶
 * 不推進時間；第一章（第一個不是回憶的章）的相對值不算，開頭是第 1 天。`upTo` 只推到第幾章（寫第 N 章時傳 N − 1）。
 *
 * 2026-10-24 重做多一步（docs/design/plans/2026-10-24-story-timeline-rework.md「二」）：有〔文中〕、填了起點時，按正文寫明的那一天
 * 對齊（取離推算最近的那一個，⚑1），後面的章跟著順延——一路累加的誤差到這裡清零。作者的錨點與第 1 章（就是起點）不對齊，對不上只記下來。
 */
export function computeTimeline(tl: Timeline, upTo?: number): TimelineCalc {
  const byNo = new Map(tl.entries.map((e) => [e.chapter, e]));
  const bad = new Set(tl.bad);
  const fileLast = Math.max(0, ...tl.entries.map((e) => e.chapter), ...tl.bad);
  const last = upTo === undefined ? fileLast : Math.min(fileLast, upTo);
  const days: TimelineDay[] = [];
  let prevEnd = 0;
  let furthest = 0;
  let started = false;
  for (let no = 1; no <= last; no++) {
    const e = byNo.get(no);
    const marks = { ...(e?.dateMark ? { dateMark: e.dateMark } : {}), ...(e?.seasonMark ? { seasonMark: e.seasonMark } : {}) };
    if (e?.value.kind === 'flashback') {
      days.push({ chapter: no, state: 'flashback', span: e.span, ...(e.value.ago ? { ago: e.value.ago } : {}), ...(e.basis ? { basis: e.basis } : {}), ...marks });
      continue;
    }
    let start: number | undefined;
    let state: TimelineDayState;
    if (!e) {
      state = bad.has(no) ? 'bad' : 'missing';
    } else if (e.value.kind === 'day') {
      start = e.value.day;
      state = 'anchor';
    } else if (e.value.kind === 'date') {
      start = dayOfDate(tl, e.value.text, prevEnd);
      state = start === undefined ? 'bad' : 'anchor';
    } else if (e.value.kind === 'unknown') {
      state = 'unknown';
    } else {
      start = started ? prevEnd + e.value.days : 1;
      // 機器寫的帶依據或推測；沒有那一段的、或者值改了卻還掛著〔推不出〕的，是作者寫的。
      state = e.basis?.kind === '依据' ? 'evidence' : e.basis?.kind === '推测' ? 'guess' : 'anchor';
    }
    if (start === undefined) {
      start = started ? prevEnd : 1;
    }
    const span = e?.span ?? 1;
    let aligned: TimelineDay['aligned'];
    let conflict: TimelineDay['conflict'];
    const md = e?.dateMark ? markDate(tl.calendar, e.dateMark) : undefined;
    if (e?.dateMark && md && tl.start && state !== 'bad') {
      const offset = Math.max(0, Math.min(e.dateMark.offset, span - 1));
      const at = dayNearest(tl, md, start + offset);
      const why = state === 'anchor' ? 'anchor' : !started ? 'start' : md.m === 0 ? 'dayOnly' : undefined;
      if (at !== undefined && at - offset !== start) {
        if (why) {
          conflict = { day: at - offset, why };
        } else {
          aligned = { estimate: start, drift: at - offset - start, ...(state === 'unknown' ? { unknown: true as const } : {}) };
          start = at - offset;
        }
      }
      if (at !== undefined && !why) {
        state = 'dated';
      }
    }
    const end = start + span - 1;
    days.push({
      chapter: no,
      state,
      start,
      end,
      ...(started ? { delta: start - prevEnd } : {}),
      span,
      ...(e?.part ? { part: e.part } : {}),
      ...(e?.endPart ? { endPart: e.endPart } : {}),
      ...(e?.basis ? { basis: e.basis } : {}),
      ...marks,
      ...(aligned ? { aligned } : {}),
      ...(conflict !== undefined ? { conflict } : {}),
    });
    prevEnd = end;
    furthest = Math.max(furthest, end);
    started = true;
  }
  // 故事裡過了幾天：走到的最遠那一天（往回跳、照正文往回對齊的章不把它拉回去）。
  return { days, last, elapsed: started ? furthest : 0 };
}

// ---------------------------------------------------------------- 對賬（現算，0 次，2026-10-24 重做）

export type TimelineIssueKind = 'drift' | 'conflict' | 'season' | 'backward' | 'unknownRun';

/** 對賬裡的一條：只提醒、不攔，掛在工程頁「時間線」組與總覽上。 */
export interface TimelineIssue {
  kind: TimelineIssueKind;
  /** 哪一章（連著推不出的是第一章）。 */
  chapter: number;
  /** 連著推不出的最後一章。 */
  to?: number;
  text: string;
}

/** 文中日期偏差到幾天才進對賬（⚑3：差 1 天多半是「深夜算不算第二天」）。 */
export const TIME_DRIFT_WARN = 2;
/** 連著幾章推不出才報。 */
export const TIME_UNKNOWN_RUN = 3;
/** 一章跨了多久以上不查季節（跨了季節，查不出對錯）。 */
const SEASON_CHECK_MAX_SPAN = 90;

/**
 * 對賬（設計稿「二 · 對賬」）：文中日期對不上（對齊時差得多）、你定的和正文對不上、季節對不上、往回跳又沒標回憶、連著推不出。
 * 按章號排。日期、季節兩類要填了起點才查得了。
 */
export function timelineIssues(tl: Timeline, calc: TimelineCalc): TimelineIssue[] {
  const out: TimelineIssue[] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length >= TIME_UNKNOWN_RUN) {
      out.push({ kind: 'unknownRun', chapter: run[0], to: run[run.length - 1], text: `第 ${run[0]}–${run[run.length - 1]} 章連著推不出（都按緊接上一章算）` });
    }
    run = [];
  };
  for (const d of calc.days) {
    if (d.state === 'unknown') {
      run.push(d.chapter);
    } else if (d.state !== 'flashback') {
      flush();
    }
    if (d.start === undefined) {
      continue;
    }
    const mark = d.dateMark ? describeDateMark(d.dateMark) : '';
    if (d.aligned && !d.aligned.unknown && Math.abs(d.aligned.drift) >= TIME_DRIFT_WARN) {
      out.push({
        kind: 'drift',
        chapter: d.chapter,
        text: `第 ${d.chapter} 章：前面推下來是${dayLabel(tl, d.aligned.estimate).full}，正文寫${mark}（差 ${Math.abs(d.aligned.drift)} 天），已按正文對齊`,
      });
    }
    // 只寫了日的差 1 天不報（同對齊的偏差，⚑3）；作者的錨點、起點對不上一天也報。
    if (d.conflict && (d.conflict.why !== 'dayOnly' || Math.abs(d.conflict.day - d.start) >= TIME_DRIFT_WARN)) {
      const here = dayLabel(tl, d.start).full;
      out.push({
        kind: 'conflict',
        chapter: d.chapter,
        text:
          d.conflict.why === 'start'
            ? `第 ${d.chapter} 章：起點是${tl.startText}，正文寫${mark}`
            : d.conflict.why === 'anchor'
              ? `第 ${d.chapter} 章：你定的是${here}，正文寫${mark}`
              : `第 ${d.chapter} 章：推出來是${here}，正文寫${mark}（只寫了日，沒按它對齊）`,
      });
    }
    if (d.seasonMark && tl.start && d.end !== undefined && d.span <= SEASON_CHECK_MAX_SPAN) {
      let fits = false;
      for (let day = d.start; day <= d.end && !fits; day++) {
        const m = monthOfDay(tl, day);
        fits = m === undefined || monthFitsSeason(tl.calendar, m, d.seasonMark.season);
      }
      if (!fits) {
        const q = d.seasonMark.quote ?? '';
        const quote = q ? `（「${cut(q, 20)}${[...q].length > 20 ? '…' : ''}」）` : '';
        out.push({
          kind: 'season',
          chapter: d.chapter,
          text: `第 ${d.chapter} 章：推出來是${dayLabel(tl, d.start).monthName ?? dayLabel(tl, d.start).full}，正文說是${d.seasonMark.season}天${quote}`,
        });
      }
    }
    if ((d.state === 'evidence' || d.state === 'guess') && d.delta !== undefined && d.delta < 0) {
      out.push({ kind: 'backward', chapter: d.chapter, text: `第 ${d.chapter} 章：比上一章往回跳了 ${-d.delta} 天，又沒標回憶` });
    }
  }
  flush();
  return out.sort((a, b) => a.chapter - b.chapter);
}

/**
 * 起點建議（設計稿「二」）：沒有起點、正文裡出現過〔文中〕日期時，按第一次出現的那一處倒推第 1 章是哪天（照那個日期的寫法）。
 * 有起點、一處都沒有時 undefined。
 */
export function suggestStart(tl: Timeline, calc: TimelineCalc): { text: string; chapter: number; mark: string } | undefined {
  if (tl.start) {
    return undefined;
  }
  for (const d of calc.days) {
    if (!d.dateMark || d.start === undefined) {
      continue;
    }
    const md = markDate(tl.calendar, d.dateMark);
    // 只寫了日的推不出起點是幾月。
    const o = md && md.m > 0 ? ordinalOf(tl.calendar, md.y ?? (tl.calendar === '简单历' ? 1 : GREGORIAN_YEARLESS), md.m, md.d) : undefined;
    if (!md || o === undefined) {
      continue;
    }
    const offset = Math.max(0, Math.min(d.dateMark.offset, d.span - 1));
    const first = fromOrdinal(tl.calendar, o - (d.start + offset - 1));
    return { text: formatYmd(first, md.style, md.y === undefined ? '' : undefined).full, chapter: d.chapter, mark: describeDateMark(d.dateMark) };
  }
  return undefined;
}

// ---------------------------------------------------------------- 怎麼說

/** 一章開頭那一天的說法：`大衍三年三月十四 清晨`、`第 8 天 傍晚`。回憶寫 `回憶（約二十年前）`。 */
export function describeDay(tl: Pick<Timeline, 'calendar' | 'start'>, d: TimelineDay): string {
  if (d.state === 'flashback' || d.start === undefined) {
    return `回憶${d.ago ? `（${d.ago}）` : ''}`;
  }
  return `${dayLabel(tl, d.start).full}${d.part ? ` ${d.part}` : ''}`;
}

/** 一章從頭到尾：`三月十四 清晨 → 夜裡`、`三月十四 清晨 → 三月十六 夜裡`；同一天、沒有結尾時段的同 {@link describeDay}。 */
export function describeDayRange(tl: Pick<Timeline, 'calendar' | 'start'>, d: TimelineDay): string {
  const head = describeDay(tl, d);
  if (d.state === 'flashback' || d.start === undefined) {
    return head;
  }
  if (d.span > 1 && d.end !== undefined) {
    return `${head} → ${dayLabel(tl, d.end).full}${d.endPart ? ` ${d.endPart}` : ''}`;
  }
  return d.endPart ? `${head} → ${d.endPart}` : head;
}

/** 「故事裡過了 46 天」那個數怎麼說：一年以上另注約幾年（按曆法的一年）。 */
export function describeElapsed(tl: Pick<Timeline, 'calendar'>, days: number): string {
  const years = days / yearDays(tl.calendar);
  return years >= 1 ? `${days} 天（約 ${years >= 10 ? Math.round(years) : Math.round(years * 10) / 10} 年）` : `${days} 天`;
}

/** 比上一章晚多久的說法：`+2 天`、`同一天`、`往回 3 天`。 */
export function describeDelta(delta: number): string {
  return delta === 0 ? '同一天' : delta > 0 ? `+${delta} 天` : `往回 ${-delta} 天`;
}

/**
 * 寫第 `no` 章（或拆從第 `no` 章起的細綱）時，「上一章的時間」那一句：只看第 `no` 章之前的行（`asOf`）。往前找最近一個不是回憶的章；
 * 一行都沒有返回 undefined。`gap` 是那一章與第 `no` 章之間還沒記時間的章數。
 */
export function lastKnownBefore(tl: Timeline, no: number): { day: TimelineDay; gap: number } | undefined {
  const calc = computeTimeline(tl, no - 1);
  for (let i = calc.days.length - 1; i >= 0; i--) {
    const d = calc.days[i];
    if (d.state === 'flashback' || d.state === 'missing' || d.state === 'bad') {
      continue;
    }
    return { day: d, gap: no - 1 - d.chapter };
  }
  return undefined;
}

/** 認時間時「前面幾章的時間」最多列幾章。 */
export const RECENT_TIME_CHAPTERS = 5;

/**
 * 認時間（同步、補推、重推）交給模型的「前面幾章的時間」（2026-10-24 重做，設計稿「三 · 輸入」）：只看第 `no` 章之前的行，最近
 * {@link RECENT_TIME_CHAPTERS} 章一章一行，帶結尾時段（本章開頭接著哪個時刻）。第 1 章、前面一行都沒有各說一句。
 */
export function recentTimeNote(tl: Timeline, no: number, count = RECENT_TIME_CHAPTERS): string {
  if (no <= 1) {
    return '這是第 1 章：days 寫 0。';
  }
  const calc = computeTimeline(tl, no - 1);
  if (!calc.days.some((d) => d.state !== 'missing')) {
    return '前面的章還沒記時間：只按上一章的結尾與本章正文判，判不出寫 null。';
  }
  const from = Math.max(1, no - count);
  const lines: string[] = [];
  for (let c = from; c < no; c++) {
    const d = calc.days[c - 1];
    if (!d || d.state === 'missing') {
      lines.push(`第 ${c} 章：還沒記（按緊接上一章算）`);
    } else if (d.state === 'flashback') {
      lines.push(`第 ${c} 章：整章是回憶${d.ago ? `（${d.ago}）` : ''}，不推進時間`);
    } else if (d.state === 'bad') {
      lines.push(`第 ${c} 章：那一行認不出（按緊接上一章算）`);
    } else {
      const delta = d.delta !== undefined ? `，比上一章 ${describeDelta(d.delta)}` : '';
      const note = d.state === 'unknown' ? '，推不出、按緊接上一章算' : d.state === 'anchor' ? '，作者定的' : d.state === 'dated' ? '，正文寫明' : '';
      const days = d.span > 1 && d.end !== undefined ? `故事第 ${d.start}–${d.end} 天` : `故事第 ${d.start} 天`;
      lines.push(`第 ${c} 章：${describeDayRange(tl, d)}（${days}${delta}${note}）`);
    }
  }
  return lines.join('\n');
}

/** 這個月是哪個季節（不放寬，同 {@link monthFitsSeason} 的口徑）。 */
export function seasonOfMonth(cal: TimelineCalendar, month: number): TimelineSeason {
  return SEASONS.find((s) => seasonMonths(cal, s).includes(month)) ?? '春';
}

/** 一天不帶年份的短說法：`三月十二`、`3月12日`；沒有起點 `第 8 天`。 */
function shortDay(tl: Pick<Timeline, 'calendar' | 'start'>, day: number): string {
  const l = dayLabel(tl, day);
  if (!l.monthName || !tl.start) {
    return l.full;
  }
  return tl.start.style.day === 'num' || tl.start.style.day === 'iso' || tl.start.style.day === 'slash' ? `${l.monthName}${l.short}日` : `${l.monthName}${l.short}`;
}

/** 寫正文、拆細綱時「最近幾章」那一句最多帶幾章。 */
const CONTEXT_RECENT_CHAPTERS = 4;

/**
 * 寫正文、拆細綱時上下文裡「故事時間」那一段（2026-10-24，設計稿「三」；同日重做擴成幾行：結尾時段、眼下的季節、最近幾章的節奏）：
 * 只看第 `no` 章之前的行（拆細綱傳這一批的第一章）。前面一行能推出來的都沒有返回 undefined（什麼都不出）。
 *
 * ```
 * 上一章（第 11 章）：大衍三年三月十四 傍晚 → 深夜（故事第 8 天）。眼下是春天。
 * 最近幾章：第 8 章 三月十二（+1 天）；第 9 章 同一天；第 10 章 推不出；第 11 章 三月十四（+2 天）。
 * 本章的時間要接得上；本章細綱「時間地點」寫了的照它。
 * ```
 */
export function timeContextText(tl: Timeline, no: number, stage: 'write' | 'plot'): string | undefined {
  const last = lastKnownBefore(tl, no);
  if (!last) {
    return undefined;
  }
  const d = last.day;
  const when = describeDaySpan(tl, d);
  const gap = last.gap > 0 ? `（第 ${d.chapter + 1}${last.gap > 1 ? `–${no - 1}` : ''} 章的時間還沒記）` : '';
  const month = tl.start && d.end !== undefined ? monthOfDay(tl, d.end) : undefined;
  const season = month !== undefined ? `眼下是${seasonOfMonth(tl.calendar, month)}天。` : '';
  const calc = computeTimeline(tl, no - 1);
  const recent: string[] = [];
  for (let c = Math.max(1, no - CONTEXT_RECENT_CHAPTERS); c < no; c++) {
    const x = calc.days[c - 1];
    if (!x || x.state === 'missing' || x.state === 'bad') {
      recent.push(`第 ${c} 章 沒記`);
    } else if (x.state === 'flashback') {
      recent.push(`第 ${c} 章 回憶`);
    } else if (x.state === 'unknown') {
      recent.push(`第 ${c} 章 推不出`);
    } else if (x.delta === 0) {
      recent.push(`第 ${c} 章 同一天`);
    } else {
      recent.push(`第 ${c} 章 ${shortDay(tl, x.start!)}${x.delta !== undefined ? `（${describeDelta(x.delta)}）` : ''}`);
    }
  }
  const rhythm = recent.length > 1 ? `\n最近幾章：${recent.join('；')}。` : '';
  return stage === 'write'
    ? `${last.gap > 0 ? `已記到第 ${d.chapter} 章` : `上一章（第 ${d.chapter} 章）`}：${when}${gap}。${season}${rhythm}\n本章的時間要接得上；本章細綱「時間地點」寫了的照它。`
    : `已寫到第 ${d.chapter} 章：${when}${gap}。${season}${rhythm}\n細綱「時間地點」寫清每章比上一章晚多久（當天、次日、三天後……），不要和前面打架。`;
}

/** `大衍三年三月十四 清晨 → 夜裡（故事第 8 天）`，跨了幾天的另說結尾。 */
export function describeDaySpan(tl: Pick<Timeline, 'calendar' | 'start'>, d: TimelineDay): string {
  if (d.span > 1 && d.end !== undefined) {
    return `${describeDay(tl, d)}（故事第 ${d.start} 天）起，歷時 ${d.span} 天，到${dayLabel(tl, d.end).full}${d.endPart ? ` ${d.endPart}` : ''}（第 ${d.end} 天）`;
  }
  return `${describeDayRange(tl, d)}（故事第 ${d.start} 天）`;
}

// ---------------------------------------------------------------- 寫入

/** 新建時間線時的整份檔案。 */
export const TIMELINE_TEMPLATE = [
  '---',
  'calendar: 简单历',
  'start: ',
  'generatedBy: novelwarden',
  '---',
  '',
  `# ${TIMELINE_NAME}`,
  '',
  '> 一章一行，寫的是這一章開頭比上一章結尾晚多久；同步時由機器按正文推。日期在敘事線頁籤和總覽裡看。',
  '> 起點：在上面 start 後面寫第 1 章那一天（如「大衍三年三月初七」「2026-03-07」），不寫只顯示第幾天；calendar 寫「簡單歷」（每月 30 天）或「公曆」。',
  '> 行尾帶〔依據〕〔推測〕〔推不出〕的是機器寫的，同步、重推時照新推的換；要定死哪一章，把「+N 天」改成具體日期（「八月十五」）或「第 N 天」（阿拉伯數字），或者刪掉行尾那一段，後面的章跟著順延。',
  '> 〔文中〕是正文寫明的日期或節日，推算時照它對齊；〔季節〕只拿來對賬。',
  '',
].join('\n');

/** 值怎麼寫回檔案。 */
export function renderTimeValue(v: TimelineValue): string {
  switch (v.kind) {
    case 'delta':
      return `${v.days < 0 ? '-' : '+'}${Math.abs(v.days)} 天`;
    case 'unknown':
      return '+?';
    case 'flashback':
      return `回憶${v.ago ? `，${v.ago}` : ''}`;
    case 'day':
      return `第 ${v.day} 天`;
    default:
      return v.text;
  }
}

/** 〔文中：八月十五（中秋），開頭後 2 天「原文」〕。 */
function renderDateMark(m: TimelineDateMark): string {
  return `〔文中：${describeDateMark(m)}${m.offset > 0 ? `，開頭後 ${m.offset} 天` : ''}${m.quote ? `「${m.quote}」` : ''}〕`;
}

/**
 * 一行（不帶專案符號）：`第 4 章：+1 天，清晨 → 夜裡，歷時 2 天〔依據：「次日清晨，雨停了」〕〔文中：八月十五（中秋）「…」〕〔季節：秋「…」〕`。
 */
export function renderTimelineLine(e: TimelineEntry): string {
  const basis = e.basis ? `〔${traditionalLabel(e.basis.kind)}：${e.basis.kind === '依据' ? `「${e.basis.text}」` : e.basis.text}〕` : '';
  const part = e.endPart ? `，${e.part ? `${e.part} ` : ''}→ ${e.endPart}` : e.part ? `，${e.part}` : '';
  const season = e.seasonMark ? `〔季節：${e.seasonMark.season}${e.seasonMark.quote ? `「${e.seasonMark.quote}」` : ''}〕` : '';
  return `第 ${e.chapter} 章：${renderTimeValue(e.value)}${part}${e.span > 1 ? `，歷時 ${e.span} 天` : ''}${basis}${e.dateMark ? renderDateMark(e.dateMark) : ''}${season}`;
}

/** {@link upsertTimelineEntry} 做了什麼。 */
export type TimelineWrite = 'added' | 'replaced' | 'kept';

/**
 * 這一行是不是機器寫的（2026-10-24 重做，設計稿「三 · 寫盤」）：相對量、回憶帶〔依據〕〔推測〕，或者 `+?` 帶〔推不出〕。作者寫的日期、
 * 「第 N 天」、沒有行尾那一段的、改了值卻還掛著〔推不出〕的都是作者的。改了值又留著〔依據〕〔推測〕的分不出來，當機器寫的（⚑7，
 * 檔案開頭的說明寫著）。
 */
export function isMachineEntry(e: TimelineEntry): boolean {
  if (e.value.kind === 'unknown') {
    return e.basis?.kind === '推不出';
  }
  if (e.value.kind === 'delta' || e.value.kind === 'flashback') {
    return e.basis?.kind === '依据' || e.basis?.kind === '推测';
  }
  return false;
}

/**
 * 補推時機器該不該換掉已有的那一行（只填空，設計稿「誰能寫什麼」）：還是 `+?`〔推不出〕（作者沒動過）；或者〔依據〕那句原文已經不在
 * 正文裡了。其餘（作者寫的、改過的、〔推測〕的、依據還在的、認不出的）都不換。
 */
export function machineMayReplace(existing: TimelineEntry, chapterText: string): boolean {
  if (existing.value.kind === 'unknown' && existing.basis?.kind === '推不出') {
    return true;
  }
  if (existing.basis?.kind === '依据' && existing.basis.text) {
    return !quoteFound(indexText(chapterText), existing.basis.text);
  }
  return false;
}

/**
 * 寫入的口徑：`fill` 只填空（補推）；`refresh` 機器寫的行一律照新推的換（同步、重推，⚑7）。兩種都不碰作者的行與認不出的行。
 */
export type TimelineWriteMode = 'fill' | 'refresh';

/**
 * 把第 N 章的一行寫進時間線原文：還沒有這份檔案按模板新建；沒有這一章的行就按章號插到對的位置（專案符號沿用已有的寫法）；已有的
 * 按 `mode` 決定換不換（`fill`：{@link machineMayReplace}；`refresh`：{@link isMachineEntry}），其餘原樣。別的行、frontmatter、BOM 與
 * 換行符一個字不動。
 */
export function upsertTimelineEntry(
  raw: string,
  entry: TimelineEntry,
  chapterText: string,
  mode: TimelineWriteMode = 'fill'
): { text: string; action: TimelineWrite } {
  const source = raw && raw.trim() ? raw : TIMELINE_TEMPLATE;
  const bom = source.startsWith('﻿') ? '﻿' : '';
  const body = bom ? source.slice(1) : source;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.split(/\r?\n/u);
  let from = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    from = end > 0 ? end + 1 : 0;
  }
  const cal = calendarOf(asString(parseMarkdown(source).frontmatter.calendar));
  let bullet: string | undefined;
  let before = -1;
  let after = -1;
  for (let i = from; i < lines.length; i++) {
    const m = BULLET.exec(lines[i]);
    const got = parseTimelineLine(lines[i].replace(BULLET, '').trim(), cal);
    if (!got) {
      continue;
    }
    if (m && bullet === undefined) {
      bullet = m[0];
    }
    const chapter = 'entry' in got ? got.entry.chapter : got.chapter;
    if (chapter === entry.chapter) {
      const may = 'entry' in got && (mode === 'refresh' ? isMachineEntry(got.entry) : machineMayReplace(got.entry, chapterText));
      const row = `${m ? m[0] : ''}${renderTimelineLine(entry)}`;
      if (may && lines[i] !== row) {
        lines[i] = row;
        return { text: bom + lines.join(eol), action: 'replaced' };
      }
      return { text: raw, action: 'kept' };
    }
    if (chapter < entry.chapter) {
      before = i;
    } else if (after < 0) {
      after = i;
    }
  }
  const row = `${bullet ?? '- '}${renderTimelineLine(entry)}`;
  if (before >= 0) {
    lines.splice(before + 1, 0, row);
  } else if (after >= 0) {
    lines.splice(after, 0, row);
  } else {
    // 一行都還沒有：接在正文最後一行有字的後面（隔一個空行），檔案末尾留一個換行。
    let tail = lines.length - 1;
    while (tail >= from && !lines[tail].trim()) {
      tail--;
    }
    lines.splice(tail + 1, lines.length - tail - 1, '', row, '');
  }
  if (lines[lines.length - 1] !== '') {
    lines.push('');
  }
  return { text: bom + lines.join(eol), action: 'added' };
}

// ---------------------------------------------------------------- 作者在介面上改（2026-10-24 重做，設計稿「五」）

/**
 * 「改時間…」那一問的字認不認得（寫法同檔案裡一行冒號後面那一截：`八月十五`、`第 20 天`、`+3 天`、`同日`、`回憶`，可以帶時段與歷時）。
 * 認得返回 undefined，認不出返回說給作者聽的一句。清空（刪掉這一行）也認。
 */
export function checkTimeInput(text: string, tl: Pick<Timeline, 'calendar' | 'start'>): string | undefined {
  const t = text.trim();
  if (!t) {
    return undefined;
  }
  const got = parseTimelineLine(`第 1 章：${t}`, tl.calendar);
  if (!got || !('entry' in got)) {
    return `認不出「${t}」：寫「八月十五」「第 20 天」「+3 天」「同日」「次日」「回憶」這幾種，可以帶時段（「八月十五，傍晚」）`;
  }
  if (got.entry.value.kind === 'date' && !tl.start) {
    return '還沒填起點，寫日期算不出是第幾天：先點時間線組第一行填起點，或者寫「第 N 天」「+N 天」';
  }
  return undefined;
}

/**
 * 把第 N 章那一行改成作者給的值（「改時間…」）：值換成作者寫的、**去掉行尾的〔依據〕〔推測〕〔推不出〕**（改過就是作者定的，機器不再動，
 * ⚑11），時段、歷時、〔文中〕〔季節〕沒另寫就照留；作者寫了時段、歷時的照作者的。清空 = 刪掉這一行（留給機器重推）。沒有這一行就按章號
 * 插進去；還沒有這份檔案按模板新建。別的行、frontmatter 一個字不動。字認不出返回 undefined（呼叫方先用 {@link checkTimeInput} 攔）。
 */
export function setTimelineValue(raw: string, chapter: number, text: string): { text: string; action: 'added' | 'replaced' | 'removed' | 'kept' } | undefined {
  const source = raw && raw.trim() ? raw : TIMELINE_TEMPLATE;
  const cal = calendarOf(asString(parseMarkdown(source).frontmatter.calendar));
  const wanted = text.trim();
  const typed = wanted ? parseTimelineLine(`第 ${chapter} 章：${wanted}`, cal) : undefined;
  if (wanted && (!typed || !('entry' in typed))) {
    return undefined;
  }
  const bom = source.startsWith('﻿') ? '﻿' : '';
  const body = bom ? source.slice(1) : source;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.split(/\r?\n/u);
  let from = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    from = end > 0 ? end + 1 : 0;
  }
  for (let i = from; i < lines.length; i++) {
    const m = BULLET.exec(lines[i]);
    const got = parseTimelineLine(lines[i].replace(BULLET, '').trim(), cal);
    if (!got || ('entry' in got ? got.entry.chapter : got.chapter) !== chapter) {
      continue;
    }
    if (!wanted) {
      lines.splice(i, 1);
      return { text: bom + lines.join(eol), action: 'removed' };
    }
    const old = 'entry' in got ? got.entry : undefined;
    const row = `${m ? m[0] : ''}${renderTimelineLine(merged(chapter, (typed as { entry: TimelineEntry }).entry, wanted, old))}`;
    if (row === lines[i]) {
      return { text: raw, action: 'kept' };
    }
    lines[i] = row;
    return { text: bom + lines.join(eol), action: 'replaced' };
  }
  if (!wanted) {
    return { text: raw, action: 'kept' };
  }
  const entry = merged(chapter, (typed as { entry: TimelineEntry }).entry, wanted, undefined);
  const r = upsertTimelineEntry(source, entry, '', 'fill');
  return { text: r.text, action: 'added' };
}

/** 作者寫的值並上原來那一行還用得著的幾樣（時段、歷時、〔文中〕〔季節〕）。行尾的依據一律去掉。 */
function merged(chapter: number, typed: TimelineEntry, text: string, old: TimelineEntry | undefined): TimelineEntry {
  const saidSpan = /(?:(?:历|歷)(?:时|時)|共|跨)\s*\S+\s*(?:天|日|周|星期|月|年)/u.test(text);
  return {
    chapter,
    value: typed.value,
    ...((typed.part ?? old?.part) ? { part: typed.part ?? old?.part } : {}),
    ...((typed.endPart ?? old?.endPart) ? { endPart: typed.endPart ?? old?.endPart } : {}),
    span: saidSpan ? typed.span : (old?.span ?? 1),
    ...((typed.dateMark ?? old?.dateMark) ? { dateMark: typed.dateMark ?? old?.dateMark } : {}),
    ...((typed.seasonMark ?? old?.seasonMark) ? { seasonMark: typed.seasonMark ?? old?.seasonMark } : {}),
  };
}

/**
 * 改 frontmatter 的 `calendar` 與 `start`（時間線組第一行「改曆法與起點」「填為起點」）：只換這兩個鍵那一行，沒有就加在收口的 `---`
 * 前面；還沒有這份檔案按模板新建。別的一個字不動。
 */
export function setTimelineHead(raw: string, head: { calendar?: TimelineCalendar; start?: string }): string {
  const source = raw && raw.trim() ? raw : TIMELINE_TEMPLATE;
  const bom = source.startsWith('﻿') ? '﻿' : '';
  const body = bom ? source.slice(1) : source;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.split(/\r?\n/u);
  if (lines[0]?.trim() !== '---' || lines.findIndex((l, i) => i > 0 && l.trim() === '---') < 0) {
    lines.unshift('---', '---');
  }
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  const set = (key: string, value: string) => {
    const at = lines.findIndex((l, i) => i > 0 && i < close && new RegExp(`^${key}\\s*:`, 'u').test(l));
    const row = `${key}: ${value}`;
    if (at > 0) {
      lines[at] = row;
    } else {
      lines.splice(lines.findIndex((l, i) => i > 0 && l.trim() === '---'), 0, row);
    }
  };
  if (head.calendar) {
    set('calendar', head.calendar);
  }
  if (head.start !== undefined) {
    set('start', head.start.trim());
  }
  return bom + lines.join(eol);
}

// ---------------------------------------------------------------- 模型的輸出

/** 模型報的一章的時間 → 一行（設計稿「一、同步時推」的校驗）。 */
export interface VerifiedTime {
  entry: TimelineEntry;
  /** 校驗時動過的地方（證據換成了最接近的原句、證據找不到改記推測……），只進日誌。 */
  notes: string[];
}

function intOf(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(asciiDigits(v.trim()).replace(/^＋/u, '+')) : NaN;
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

function strOf(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
}

/**
 * 一句裡寫沒寫著時間（設計稿「三 · 校驗」，試跑之後加的）：時段與天色（夜、晨、黃昏、天亮）、過了多久（三日、半月、一年）、日子（次日、
 * 昨夜、明兒、三月初七、二十一日）、季節、節令。只寫場面、動作的句子當不得時間的依據——模型常拿本章第一句充數。
 */
const TIME_HINT = new RegExp(
  [
    '[夜晨曉曉晝晝午昏晚宵暮]',
    '天[光色亮明黑邊邊]|日[頭頭光子]|月[光色亮]|太陽|太陽|朝陽|朝陽|夕陽|夕陽|旭日',
    '[一二兩兩三四五六七八九十百千幾幾數數半0-9０-９]+\\s*[個個]?\\s*(?:天|日|夜|晚|月|年|載|載|旬|周|週|星期|時辰|時辰|更)',
    '[春夏秋冬]|節|節',
    '次日|翌日|隔[天日]|[昨今明當當那這這同][天日晚夜早兒兒朝]',
    '[正臘冬]月|[一二三四五六七八九十]+月|初[一二三四五六七八九十]|[十廿卅二三]?[十]?[一二三四五六七八九十][日號]',
  ].join('|'),
  'u'
);

/** 這一句能不能當時間的依據。 */
export function mentionsTime(sentence: string): boolean {
  return TIME_HINT.test(sentence);
}

/** 正文裡找一句：逐字找得到原樣返回；找不到換最接近的一句（夠長時）；都不行返回 undefined。`changed` 說有沒有換。 */
function locateEvidence(index: QuoteIndex, text: string, quote: string): { quote: string; changed: boolean } | undefined {
  if (!quote) {
    return undefined;
  }
  if (quoteFound(index, quote)) {
    return { quote, changed: false };
  }
  const near = normalizeQuote(quote).length >= 4 ? nearestSentence(text, quote, TIME_BASIS_MAX) : undefined;
  return near ? { quote: near.sentence, changed: true } : undefined;
}

/** 一句裡寫日期的地方（不錨頭尾）：`八月十五`、`臘月廿三日`、`3月7日`。 */
const DATE_IN_TEXT =
  /(?:[0-9０-９〇零○一二两三四五六七八九十百千万兩萬]+\s*年\s*)?(?:[0-9０-９]{1,2}|十[一二]|[一二两三四五六七八九十兩]|正|冬|(?:腊|臘)|臘)\s*月\s*(?:初[一二三四五六七八九十]|[0-9０-９]{1,2}|[一二两三四五六七八九十廿卅兩]{1,3})\s*[日号號]?/gu;

/** 原文裡寫沒寫著這一天（防編，設計稿「三 · 校驗」）：寫著這個節日，或者有一處日期與它同月同日。 */
function quoteMentionsDate(quote: string, date: CalendarDate | undefined, festival: string | undefined): boolean {
  if (festival && quote.includes(festivalKey(festival))) {
    return true;
  }
  if (!date) {
    return false;
  }
  for (const m of quote.matchAll(DATE_IN_TEXT)) {
    const d = parseDate(m[0]);
    if (d && d.m === date.m && d.d === date.d) {
      return true;
    }
  }
  if (date.m === 0) {
    for (const m of quote.matchAll(DAY_IN_TEXT)) {
      if (parseNumber(m[1]) === date.d) {
        return true;
      }
    }
  }
  return false;
}

/** 一句裡只寫了日的地方：`二十一日`、`初三`、`十五那天`。 */
const DAY_IN_TEXT = /(初[一二三四五六七八九十]|[0-9０-９]{1,2}|[一二两三四五六七八九十廿卅兩]{1,3})\s*(?:[日号號]|那[天日])/gu;

/**
 * 校驗模型給的一章的時間（認時間的 `times` 裡的一項，2026-10-24 重做；老的認事件 `time` 也認）。`raw` 不是物件返回 undefined（模型
 * 沒給：不寫這一行）。
 *
 * - `days` 是整數、絕對值不超過 {@link TIME_DAYS_MAX}；`null`、缺席、認不出 → `+?`〔推不出〕。
 * - `jumps`：本章裡往後跳的每一處，天數 0 起、證據逐字（找不到換最接近的原句，還找不到這一跳不算）；歷時 = 1 + 各處天數。沒給 `jumps`
 *   時認老的 `span`。`part`、`endPart` 只收認得出的短詞。
 * - `flashback` 有字 → 整章回憶（不推進時間），機器寫的回憶一定帶行尾那一段（沒依據就〔推測：整章是回憶〕），好認出是機器寫的。
 * - `evidence` 照敘事線事件的口徑逐字校驗：找不到就換成正文裡最接近的一句，還找不到丟掉證據、改記〔推測〕。沒給證據給了理由 →
 *   〔推測：理由〕；都沒給 → 〔推測：緊接上一章〕。
 * - `date`（〔文中〕）：證據要在正文裡，而且證據裡寫著這個日期或這個節日；日期認不出、節日在這個曆法裡換不出日子的不收；`offset` 夾在
 *   0 到歷時 − 1。`season`（〔季節〕）：春夏秋冬之一，證據要在正文裡。
 */
export function verifyTime(
  raw: unknown,
  ctx: { chapter: number; text: string; calendar?: TimelineCalendar; hint?: string }
): VerifiedTime | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const cal = ctx.calendar ?? '简单历';
  const o = raw as Record<string, unknown>;
  const notes: string[] = [];
  const index = indexText(ctx.text);
  const reason = cut(strOf(o.reason ?? o.why ?? o.note), TIME_BASIS_MAX);
  const partOf = (v: unknown): string | undefined => {
    const s = strOf(v);
    return PART_WORDS.test(s) ? s : undefined;
  };
  const part = partOf(o.part ?? o.timeOfDay);
  const endPart = partOf(o.endPart ?? o.end);
  const agoRaw = cut(strOf(o.flashback), AGO_MAX);
  const flashback = o.flashback === true || (agoRaw !== '' && !/^(?:否|(?:无|無)|(?:没|沒)有|false|no)$/iu.test(agoRaw));
  const ago = /^(?:是|true|yes)$/iu.test(agoRaw) ? '' : agoRaw;

  // 歷時：jumps 各處相加（模型不估 span）；沒給 jumps 時認老的 span。
  let span = 1;
  if (Array.isArray(o.jumps)) {
    for (const j of o.jumps) {
      if (!j || typeof j !== 'object') {
        continue;
      }
      const jo = j as Record<string, unknown>;
      const days = intOf(jo.days);
      if (days === undefined || days < 0 || days > TIME_DAYS_MAX) {
        notes.push(`章內一跳的天數認不出：${strOf(jo.days) || '（空）'}`);
        continue;
      }
      const ev = cut(unquote(strOf(jo.evidence)), TIME_BASIS_MAX);
      const found = locateEvidence(index, ctx.text, ev);
      if (!found) {
        notes.push(`章內一跳（${days} 天）的依據在正文裡找不到，不算：「${ev}」`);
        continue;
      }
      if (days > 0 && !mentionsTime(found.quote)) {
        notes.push(`章內一跳（${days} 天）的依據那一句沒寫時間，不算：「${found.quote}」`);
        continue;
      }
      span = Math.min(TIME_DAYS_MAX, span + days);
    }
  } else {
    const spanRaw = intOf(o.span);
    span = spanRaw !== undefined && spanRaw >= 1 && spanRaw <= TIME_DAYS_MAX ? spanRaw : 1;
  }

  let evidence = cut(unquote(strOf(o.evidence)), TIME_BASIS_MAX);
  let hinted: string | undefined;
  if (evidence) {
    const found = locateEvidence(index, ctx.text, evidence);
    if (found?.changed) {
      notes.push(`時間的依據不是逐字原文，換成了最接近的原句：「${evidence}」→「${found.quote}」`);
    } else if (!found && ctx.hint && normalizeQuote(ctx.hint).includes(normalizeQuote(evidence))) {
      // 試跑：送去的「細綱記的時間地點」被當成依據抄了回來。照細綱判的，記推測、說清是照細綱。
      notes.push(`時間的依據抄的是細綱：「${evidence}」`);
      hinted = `照細綱：${cut(ctx.hint, 26)}`;
    } else if (!found) {
      notes.push(`時間的依據在正文裡找不到：「${evidence}」`);
    }
    evidence = found?.quote ?? '';
    if (evidence && !mentionsTime(evidence)) {
      notes.push(`時間的依據那一句沒寫時間，改記推測：「${evidence}」`);
      evidence = '';
    }
  }
  const rawDays = o.days === null || o.days === undefined || strOf(o.days) === '?' ? undefined : intOf(o.days);
  const days = rawDays !== undefined && Math.abs(rawDays) <= TIME_DAYS_MAX ? rawDays : undefined;
  if (rawDays !== undefined && days === undefined) {
    notes.push(`時間差 ${rawDays} 天太離譜，當推不出`);
  }

  let value: TimelineValue;
  let basis: TimelineEntry['basis'];
  if (flashback) {
    value = { kind: 'flashback', ago };
    basis = evidence ? { kind: '依据', text: evidence } : { kind: '推测', text: reason || '整章是回憶' };
  } else if (days === undefined) {
    value = { kind: 'unknown' };
    basis = { kind: '推不出', text: reason || '正文沒交代過了多久' };
  } else {
    value = { kind: 'delta', days };
    basis = evidence
      ? { kind: '依据', text: evidence }
      : {
          kind: '推测',
          text:
            reason ||
            hinted ||
            (notes.some((n) => n.startsWith('時間的依據那一句沒寫時間'))
              ? '依據那一句沒寫時間'
              : notes.some((n) => n.startsWith('時間的依據'))
                ? '依據在正文裡找不到'
                : '緊接上一章'),
        };
  }
  if (flashback) {
    span = 1;
  }
  // 同一天裡開頭、結尾是同一個時段：只寫一個（試跑裡「夜裡 → 夜裡」）。
  const end = endPart && !(span === 1 && endPart === part) ? endPart : undefined;
  const dateMark = flashback ? undefined : verifyDateMark(o.date, { cal, text: ctx.text, index, span, notes });
  const seasonMark = verifySeasonMark(o.season, { text: ctx.text, index, notes });
  return {
    entry: {
      chapter: ctx.chapter,
      value,
      ...(part && !flashback ? { part } : {}),
      ...(end && !flashback ? { endPart: end } : {}),
      span,
      ...(basis ? { basis } : {}),
      ...(dateMark ? { dateMark } : {}),
      ...(seasonMark ? { seasonMark } : {}),
    },
    notes,
  };
}

/** 〔文中〕：模型給的 `date`（`{ date, festival, offset, evidence }`）。不合格的不收，原因進 `notes`。 */
function verifyDateMark(
  raw: unknown,
  ctx: { cal: TimelineCalendar; text: string; index: QuoteIndex; span: number; notes: string[] }
): TimelineDateMark | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const dateText = cut(strOf(o.date), AGO_MAX);
  const festival = cut(strOf(o.festival), AGO_MAX) || undefined;
  const date = dateText ? parseMarkDate(dateText) : undefined;
  if (!date && !(festival && festivalDate(ctx.cal, festival))) {
    if (dateText || festival) {
      ctx.notes.push(
        `正文寫明的日子認不出，不收：${dateText || festival}${festival && !dateText && (festivalDate('简单历', festival) || festivalDate('公历', festival)) ? `（${ctx.cal}裡換不出這個節日的日子）` : ''}`
      );
    }
    return undefined;
  }
  const ev = cut(unquote(strOf(o.evidence)), TIME_BASIS_MAX);
  const found = locateEvidence(ctx.index, ctx.text, ev);
  if (!found) {
    ctx.notes.push(`正文寫明的日子「${dateText || festival}」的依據在正文裡找不到，不收：「${ev}」`);
    return undefined;
  }
  if (!quoteMentionsDate(found.quote, date, festival)) {
    ctx.notes.push(`正文寫明的日子「${dateText || festival}」在依據那一句裡沒寫著，不收：「${found.quote}」`);
    return undefined;
  }
  // 模型只寫了日、原文裡寫著月和日的，按原文的寫（試跑：「次日乃是四月二十六日」報成了「二十六日」）。
  let full = dateText;
  if (date && date.m === 0) {
    for (const m of found.quote.matchAll(DATE_IN_TEXT)) {
      const d = parseDate(m[0]);
      if (d && d.d === date.d) {
        full = m[0].replace(/\s+/gu, '').replace(/[号號]$/u, '日');
        ctx.notes.push(`正文寫明的日子只報了「${dateText}」，照原文寫成「${full}」`);
        break;
      }
    }
  }
  const offsetRaw = intOf(o.offset);
  const offset = Math.max(0, Math.min(offsetRaw ?? 0, ctx.span - 1));
  return { ...(date ? { date: full } : {}), ...(festival ? { festival } : {}), offset, quote: found.quote };
}

/** 〔季節〕：模型給的 `season`（`{ season, evidence }`）。 */
function verifySeasonMark(raw: unknown, ctx: { text: string; index: QuoteIndex; notes: string[] }): TimelineSeasonMark | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const season = parseSeason(strOf(o.season));
  if (!season) {
    return undefined;
  }
  const ev = cut(unquote(strOf(o.evidence)), TIME_BASIS_MAX);
  const found = locateEvidence(ctx.index, ctx.text, ev);
  if (!found) {
    ctx.notes.push(`季節「${season}」的依據在正文裡找不到，不收：「${ev}」`);
    return undefined;
  }
  return { season, quote: found.quote };
}

/**
 * 完成提示裡時間那一句：`時間：+2 天（依據「兩日後」）`、`時間推不出（按緊接上一章算）`；正文寫明瞭日子的另說一句
 * （「正文寫明八月十五（中秋），按它對齊」）。
 */
export function describeTimeEntry(e: TimelineEntry): string {
  const dated = e.dateMark ? `；正文寫明${describeDateMark(e.dateMark)}，按它對齊` : '';
  switch (e.value.kind) {
    case 'unknown':
      return dated ? `時間：比上一章晚多久推不出${dated}` : '時間推不出（按緊接上一章算，可以在時間線裡改）';
    case 'flashback':
      return `時間：整章是回憶${e.value.ago ? `（${e.value.ago}）` : ''}，不推進時間`;
    case 'delta': {
      const how = describeDelta(e.value.days).replace('同一天', '與上一章同一天');
      const why = e.basis?.kind === '依据' ? `（依據「${cut(e.basis.text, 20)}」）` : e.basis?.kind === '推测' ? `（推測：${e.basis.text}）` : '';
      return `時間：${how}${e.span > 1 ? `，歷時 ${e.span} 天` : ''}${why}${dated}`;
    }
    default:
      return `時間：${renderTimeValue(e.value)}`;
  }
}
