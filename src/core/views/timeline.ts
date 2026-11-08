import { traditionalLabel } from '../model/labels';
import { THREAD_KINDS, ThreadBook, describeChapterRuns } from '../model/threadFile';
import {
  Timeline,
  TimelineCalc,
  TimelineDay,
  TimelineEntry,
  computeTimeline,
  dayLabel,
  describeDateMark,
  describeDay,
  describeDayRange,
  describeDelta,
  isMachineEntry,
  monthOfDay,
  renderTimeValue,
  seasonOfMonth,
  suggestStart,
  timelineIssues,
} from '../model/timelineFile';
import {
  TimelineChapterView,
  TimelineGroupView,
  TimelineOverview,
  TimelineOverviewCard,
  TimelineOverviewDay,
  TimelineOverviewEvent,
  TimelineOverviewThread,
  TimelineSegmentView,
} from '../protocol';

/**
 * 故事時間的兩處介面（2026-10-24；同日從 `views/threads.ts` 挪出來）：
 *
 * - 工程頁敘事線頁籤裡的「時間線」組（{@link timelineGroupOf}，設計稿 docs/design/plans/2026-10-24-story-timeline-rework.md「五」）：
 *   對賬一條一行，章按月分段一章一行；
 * - 編輯區的「時間線總覽」（{@link buildTimelineMatrix}，設計稿 docs/design/plans/2026-10-24-timeline-page.md）：豎著按故事日子排，
 *   一個日子一項、一章一張卡片，卡片上帶這一章在各條線上實際發生的事。
 *
 * **純函式、不調模型、不落盤**（第 18、28 條：日期、對賬一律現算）。讀盤由呼叫方做：工程頁是 `projectView.ts`，總覽是
 * `views/threads.ts` 的 `buildTimelineOverview`（和敘事線總覽共用讀章節那一半）。文案都在這裡（前端只渲染、只加 ⚠）。
 */

/** 壓成一行、截到 `max` 個字（同 `views/threads.ts` 的 `clipLine`）。 */
function clipLine(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s*\n+\s*/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

/** 工程頁交進來的章（時間線組一章一行要章名、正文路徑與卷）。 */
export interface TimelineChapterInput {
  no: number;
  title: string;
  /** 正文路徑（還沒有正文是空串）。 */
  chapterPath: string;
  /** 卷名（直接放在章節根下是空串）。 */
  volume: string;
}

/** 時間線組要的進度：同步過的章（「還沒推」從這裡面挑）、各章的章名與正文（`views/threads.ts` 的 `ThreadsProgress` 也是它）。 */
export interface TimelineProgress {
  /** 定稿過、正文還在的章號。 */
  finalized: readonly number[];
  /** 各章的章名、正文路徑與卷（一章一行用）。缺席時那幾樣空著。 */
  chapters?: readonly TimelineChapterInput[];
}

/** 時間線裡有沒有這一章的行（認得出、認不出的都算：認不出的是作者的，補推不碰）。 */
function hasTimeLine(tl: Timeline, no: number): boolean {
  return tl.entries.some((e) => e.chapter === no) || tl.bad.includes(no);
}

/** 「現在」：最後一章的結尾那一天與結尾時段（跨了幾天的說結尾那一天）。 */
function nowOf(tl: Timeline, d: TimelineDay): string {
  const day = d.end ?? d.start;
  if (day === undefined) {
    return describeDay(tl, d);
  }
  const part = d.endPart ?? (d.span > 1 ? undefined : d.part);
  return `${dayLabel(tl, day).full}${part ? ` ${part}` : ''}`;
}

/** 沒起點時每多少章一段（也沒有卷的時候）。 */
const TIMELINE_SEGMENT_CHAPTERS = 20;

/**
 * 「時間線」那一組：標題、對賬一條一行、章按月分段一章一行。檔案不在、也沒有要補推的章時不畫。`chapters` 給了才有章名、正文路徑與卷
 * （工程頁給；單測可以不給）。
 *
 * 曆法與起點原來是組裡第一行、點了就改（2026-10-24 時間線總覽：作者嫌反人類）：挪到 `calendar`（組標題的懸停），沒填起點有建議、
 * 起點認不出的各成一條 ⚠（`start: true`，右鍵改）。
 */
export function timelineGroupOf(tl: Timeline | undefined, progress?: TimelineProgress): TimelineGroupView | undefined {
  if (!tl) {
    return undefined;
  }
  const missing = progress
    ? [...progress.finalized].filter((no) => {
        const e = tl.entries.find((x) => x.chapter === no);
        return !hasTimeLine(tl, no) || (e?.value.kind === 'unknown' && isMachineEntry(e));
      })
    : [];
  missing.sort((a, b) => a - b);
  const blank = missing.filter((no) => !hasTimeLine(tl, no));
  if (!tl.exists && blank.length === 0) {
    return undefined;
  }
  const calc = computeTimeline(tl);
  const issues = timelineIssues(tl, calc);
  const flagged = new Set(issues.map((i) => i.chapter));
  const known = [...calc.days].reverse().find((d) => d.start !== undefined && d.state !== 'missing');
  const of = (state: TimelineDay['state']) => calc.days.filter((d) => d.state === state).map((d) => d.chapter);
  const unknown = of('unknown');
  const bad = of('bad');
  const blankText = blank.length > 0 ? `${describeChapterRuns(blank)}還沒推` : '';
  const suggestion = suggestStart(tl, calc);
  const byNo = new Map((progress?.chapters ?? []).map((c) => [c.no, c]));
  const entries = new Map(tl.entries.map((e) => [e.chapter, e]));

  const label = [
    calc.last > 0 ? `推到第 ${calc.last} 章` : '還沒有一章',
    known ? `故事第 ${known.end ?? known.start} 天${tl.start ? `（${nowOf(tl, known)}）` : ''}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const calendar: TimelineGroupView['calendar'] = {
    text: tl.start
      ? `${traditionalLabel(tl.calendar)} · 起點 ${tl.startText}（第 1 章那一天）`
      : tl.startText
        ? `${traditionalLabel(tl.calendar)} · 起點「${tl.startText}」認不出，先只顯示第幾天`
        : `${traditionalLabel(tl.calendar)} · 沒填起點，只顯示第幾天`,
    tip: [
      tl.calendar === '简单历' ? '簡單歷：每月 30 天、一年 12 個月，節日按農曆口徑（中秋是八月十五）。' : '公曆：真實的月份長短與閏年。',
      tl.start ? '' : '填了起點，日期才看得出來，正文寫明的日子才拿來對齊、季節才拿來對賬。',
      '右鍵改曆法與起點。',
    ]
      .filter(Boolean)
      .join('\n'),
    calendarName: tl.calendar,
    start: tl.startText,
    ...(suggestion ? { suggestion: { start: suggestion.text, note: `第 ${suggestion.chapter} 章寫了「${suggestion.mark}」` } } : {}),
  };

  const issueViews: TimelineGroupView['issues'] = [
    ...(suggestion ? [{ text: `沒填起點：第 ${suggestion.chapter} 章寫了「${suggestion.mark}」，第 1 章是${suggestion.text}（右鍵填為起點）`, start: true as const }] : []),
    ...(tl.startText && !tl.start ? [{ text: `起點「${tl.startText}」認不出，先只顯示第幾天（右鍵改曆法與起點）`, start: true as const }] : []),
    ...issues.map((i) => ({ text: i.text, chapter: i.chapter })),
    ...(unknown.length > 0 && !issues.some((i) => i.kind === 'unknownRun') ? [{ text: `${describeChapterRuns(unknown)}推不出（按緊接上一章算，右鍵那一章「改時間」）`, chapter: unknown[0] }] : []),
    ...(bad.length > 0 ? [{ text: `${describeChapterRuns(bad)}那一行認不出（按緊接上一章算）`, chapter: bad[0] }] : []),
    ...(blankText ? [{ text: `${blankText}：同步過，點標題旁的「補推時間」補上` }] : []),
  ];

  const rows: TimelineChapterView[] = calc.days.map((d) => chapterRowOf(tl, d, entries.get(d.chapter), byNo.get(d.chapter), flagged.has(d.chapter)));
  // 同步過、時間線裡還沒有、又寫在最後一行之後的章也列出來（「還沒推」）。
  for (const no of blank.filter((n) => n > calc.last)) {
    const c = byNo.get(no);
    rows.push({ no, title: c?.title ?? '', ...(c?.chapterPath ? { chapterPath: c.chapterPath } : {}), state: 'missing', when: '還沒推', note: '', tip: `第 ${no} 章還沒推`, value: '', machine: false });
  }
  rows.sort((a, b) => a.no - b.no);

  return {
    relPath: tl.relPath,
    exists: tl.exists,
    label,
    calendar,
    issues: issueViews,
    segments: segmentsOf(tl, calc, rows, byNo),
    ...(missing.length > 0 ? { missing: { count: missing.length, text: `${describeChapterRuns(missing)}還沒推出來` } } : {}),
    machine: tl.entries.filter(isMachineEntry).length,
    last: Math.max(calc.last, ...rows.map((r) => r.no), 0),
  };
}

/** 行尾那一段怎麼說：`正文寫明八月十五`、`你定的`、`依據「…」`、`推測：…`（截到 `max` 字）。 */
function noteOf(d: TimelineDay, max: number): string {
  return d.state === 'dated' && d.dateMark
    ? `正文寫明${describeDateMark(d.dateMark)}`
    : d.state === 'anchor'
      ? '你定的'
      : d.basis
        ? d.basis.kind === '依据'
          ? `依據「${clipLine(d.basis.text, max)}」`
          : `${traditionalLabel(d.basis.kind)}：${clipLine(d.basis.text, max)}`
        : '';
}

/** 一章一行。 */
function chapterRowOf(tl: Timeline, d: TimelineDay, e: TimelineEntry | undefined, c: TimelineChapterInput | undefined, issue: boolean): TimelineChapterView {
  const when = d.state === 'missing' ? '還沒推' : d.state === 'bad' ? '那一行認不出' : rowWhen(tl, d);
  return {
    no: d.chapter,
    title: c?.title ?? '',
    ...(c?.chapterPath ? { chapterPath: c.chapterPath } : {}),
    state: d.state,
    when,
    ...(d.delta !== undefined && d.state !== 'missing' && d.state !== 'bad' ? { delta: describeDelta(d.delta) } : {}),
    note: noteOf(d, 30),
    tip: dayTip(tl, d).join('\n'),
    value: e ? renderTimeValue(e.value) : '',
    machine: !!e && isMachineEntry(e),
    ...(issue ? { issue: true as const } : {}),
  };
}

/** 一天不帶年份：`三月十四`、`3月14日`（年份在段頭上）。沒起點是 `第 8 天`。 */
function dayNoYear(tl: Timeline, day: number): string {
  const l = dayLabel(tl, day);
  if (!l.month || !l.monthName) {
    return l.full;
  }
  return tl.start && (tl.start.style.day === 'iso' || tl.start.style.day === 'slash')
    ? `${l.monthName}${l.short}日`
    : l.full.slice(l.month.length - l.monthName.length);
}

/** 一行裡那一天：`三月十四 清晨 → 夜裡`、`三月十四 清晨 → 三月十六 夜裡`；沒起點 `第 8 天 清晨`；回憶 `回憶（約二十年前）`。 */
function rowWhen(tl: Timeline, d: TimelineDay): string {
  if (d.state === 'flashback' || d.start === undefined) {
    return describeDay(tl, d);
  }
  const head = `${dayNoYear(tl, d.start)}${d.part ? ` ${d.part}` : ''}`;
  if (d.span > 1 && d.end !== undefined) {
    return `${head} → ${dayNoYear(tl, d.end)}${d.endPart ? ` ${d.endPart}` : ''}`;
  }
  return d.endPart ? `${head} → ${d.endPart}` : head;
}

/**
 * 分段：填了起點按月（回憶、沒推的章跟著前一章的月），沒起點按卷，卷也沒有每 {@link TIMELINE_SEGMENT_CHAPTERS} 章一段。
 */
function segmentsOf(tl: Timeline, calc: TimelineCalc, rows: TimelineChapterView[], byNo: Map<number, TimelineChapterInput>): TimelineSegmentView[] {
  const days = new Map(calc.days.map((d) => [d.chapter, d]));
  const keyOf = (no: number, prev: string): string => {
    const d = days.get(no);
    if (tl.start) {
      return d?.start !== undefined && d.state !== 'flashback' && d.state !== 'missing' ? (dayLabel(tl, d.start).month ?? prev) : prev;
    }
    if ([...byNo.values()].some((c) => c.volume)) {
      return byNo.get(no)?.volume ?? prev;
    }
    const k = Math.floor((no - 1) / TIMELINE_SEGMENT_CHAPTERS);
    return `第 ${k * TIMELINE_SEGMENT_CHAPTERS + 1}–${(k + 1) * TIMELINE_SEGMENT_CHAPTERS} 章`;
  };
  const out: TimelineSegmentView[] = [];
  let prev = '';
  for (const row of rows) {
    const key = keyOf(row.no, prev) || prev;
    prev = key;
    const last = out[out.length - 1];
    if (last && last.key === `timeline:${key}`) {
      last.chapters.push(row);
    } else {
      out.push({ key: `timeline:${key}`, label: key || '未分卷', detail: '', chapters: [row] });
    }
  }
  for (const seg of out) {
    const nos = seg.chapters.map((c) => c.no);
    const ds = nos.map((n) => days.get(n)).filter((d): d is TimelineDay => d?.start !== undefined && d.state !== 'flashback' && d.state !== 'missing');
    const from = Math.min(...ds.map((d) => d.start!));
    const to = Math.max(...ds.map((d) => d.end ?? d.start!));
    const range = nos.length === 1 ? `第 ${nos[0]} 章` : `第 ${nos[0]}–${nos[nos.length - 1]} 章`;
    seg.detail = ds.length > 0 ? `${range} · ${tl.start ? `${to - from + 1} 天` : `故事第 ${from === to ? from : `${from}–${to}`} 天`}` : range;
  }
  return out;
}

/** 一章的懸停與詳情（工程頁那一行、總覽那一張卡片共用）：全稱、故事第幾天、比上一章晚多久、歷時、依據 / 推測、正文寫明的、對賬。 */
function dayTip(tl: Timeline, d: TimelineDay): string[] {
  const lines = [`第 ${d.chapter} 章 · ${describeDayRange(tl, d)}`];
  if (d.start !== undefined && d.state !== 'flashback') {
    const span = d.span > 1 && d.end !== undefined ? `，歷時 ${d.span} 天，到${dayLabel(tl, d.end).full}` : '';
    const delta = d.delta !== undefined ? `；比上一章：${describeDelta(d.delta)}` : '';
    lines.push(`故事第 ${d.start} 天${span}${delta}`);
  }
  if (d.basis) {
    lines.push(d.basis.kind === '依据' ? `依據：「${d.basis.text}」` : `${traditionalLabel(d.basis.kind)}：${d.basis.text}`);
  }
  if (d.dateMark) {
    lines.push(`正文寫明：${describeDateMark(d.dateMark)}${d.dateMark.offset > 0 ? `（開頭後 ${d.dateMark.offset} 天）` : ''}${d.dateMark.quote ? `「${d.dateMark.quote}」` : ''}`);
  }
  if (d.aligned && !d.aligned.unknown && d.aligned.drift !== 0) {
    lines.push(`前面推下來是${dayLabel(tl, d.aligned.estimate).full}，按正文對齊了（差 ${Math.abs(d.aligned.drift)} 天）`);
  }
  if (d.seasonMark) {
    lines.push(`季節：${d.seasonMark.season}${d.seasonMark.quote ? `「${d.seasonMark.quote}」` : ''}`);
  }
  if (TIME_STATE_NOTE[d.state]) {
    lines.push(TIME_STATE_NOTE[d.state]);
  }
  return lines;
}

const TIME_STATE_NOTE: Record<TimelineDay['state'], string> = {
  evidence: '',
  guess: '',
  unknown: '推不出，按緊接上一章算',
  missing: '時間線裡還沒有這一章，按緊接上一章算',
  anchor: '你定的',
  dated: '正文寫明瞭日子，按它對齊',
  flashback: '整章是回憶，不推進時間',
  bad: '這一行認不出，按緊接上一章算',
};

/**
 * 敘事線總覽列頭與格子懸停裡的「這一章是哪天」（2026-10-24 時間線總覽：總覽裡的「時間線」一組與月份帶去掉了，只留這一句）。
 * 時間線裡寫到的最後一章之後、沒推的章缺席。
 */
export function chapterDayLabels(tl: Timeline, calc: TimelineCalc): Map<number, string> {
  const out = new Map<number, string>();
  for (const d of calc.days) {
    if (d.state !== 'missing') {
      out.set(d.chapter, d.state === 'bad' ? '那一行認不出' : describeDay(tl, d));
    }
  }
  return out;
}

// ---------------------------------------------------------------- 時間線總覽（2026-10-24）

/** 總覽裡一章的原料（讀盤那一半給）：章名、正文與細綱、細綱的梗概與時間地點、同步過沒有。 */
export interface TimelinePageChapterInput {
  no: number;
  title: string;
  chapterPath?: string;
  plotPath?: string;
  /** 細綱的「梗概」「時間地點」（沒有細綱是空串）。 */
  synopsis: string;
  timePlace: string;
  /** 同步過（細綱有 `sourceHash`、正文還在）。 */
  finalized: boolean;
}

/**
 * 線的顏色幾種（前端 `--tlp-c0` 到 `--tlp-c7`，一套校驗過色盲區分度的分類色）：按線的先後各一色、**不迴圈**——第 9 條線起與「未歸屬的
 * 伏筆」一樣灰（迴圈的話兩條線撞色；名字總寫在標籤上，顏色只是幫著認）。
 */
const THREAD_COLORS = 8;
/** 卡片上的依據、推測截多少字（全文在詳情裡）。 */
const CARD_NOTE_CHARS = 60;
/** 梗概截多少字。 */
const CARD_SYNOPSIS_CHARS = 120;
const UNFILED_NAME = '未歸屬的伏筆';

/**
 * 卡片右上角：時段（同一天 `清晨 → 夜裡`；跨天 `清晨 → 三月十五 夜裡 · 3 天`），回憶 `回憶（約二十年前）`。日子在軸上，這裡不寫開頭那一天。
 */
function cardWhen(tl: Timeline, d: TimelineDay): string {
  if (d.state === 'flashback' || d.start === undefined) {
    return describeDay(tl, d);
  }
  if (d.span > 1 && d.end !== undefined) {
    return `${d.part ? `${d.part} ` : ''}→ ${dayNoYear(tl, d.end)}${d.endPart ? ` ${d.endPart}` : ''} · ${d.span} 天`;
  }
  return d.part && d.endPart ? `${d.part} → ${d.endPart}` : d.part ? d.part : d.endPart ? `→ ${d.endPart}` : '';
}

/** 對賬那一條去掉開頭的 `第 N 章：`（卡片上已經寫著是哪一章）。 */
function issueOnCard(text: string, no: number): string {
  return text.replace(new RegExp(`^第 ${no} 章[:：]\\s*`, 'u'), '');
}

/**
 * 時間線總覽（純函式）：`chapters` 是有細綱或正文的章（讀盤那一半給，{@link TimelinePageChapterInput}）。
 *
 * - **軸**：按故事日子從早到晚，一個日子一項（⚑1：不按章號——往回跳的章排到它那一天，對賬照舊報它）；同一天的幾章按章號。沒有章的
 *   日子不給，前端照相鄰兩項的日子畫「N 天后」（⚑2）。
 * - **回憶的章**（⚑5）：掛在閱讀順序上前一章那一天裡（卡片按章號排，它就跟在那一章後面）；前面一章都沒有的掛在第一天；一天都推不出
 *   （整本只有回憶）時給一個第 0 天。
 * - **卡片**：時段、比上一章、依據（截短）、這一章在各條線上**實際**發生的事（計劃的不給；線按種類與目錄裡的先後，顏色按這個先後
 *   前 8 條各一色、不迴圈，⚑4，第 9 條起與「未歸屬的伏筆」一樣灰），一條都沒有時給細綱的梗概；對賬報了的另列。
 * - 時間線寫到的最後一章之後、同步過還沒推的章不上軸（⚑6，`issues` 裡有一條「還沒推」）。
 */
export function buildTimelineMatrix(book: ThreadBook, chapters: readonly TimelinePageChapterInput[]): Omit<TimelineOverview, 'initialized'> {
  const tl = book.timeline;
  const finalized = chapters.filter((c) => c.finalized).map((c) => c.no);
  const group = tl ? timelineGroupOf(tl, { finalized, chapters: chapters.map((c) => ({ no: c.no, title: c.title, chapterPath: c.chapterPath ?? '', volume: '' })) }) : undefined;
  if (!tl || !group) {
    return { relPath: tl?.relPath ?? '', exists: false, meta: '', tip: '', calendar: { name: tl?.calendar ?? '简单历', start: tl?.startText ?? '' }, issues: [], threads: [], days: [], machine: 0, last: 0 };
  }
  const calc = computeTimeline(tl);
  const byNo = new Map(chapters.map((c) => [c.no, c]));
  const entries = new Map(tl.entries.map((e) => [e.chapter, e]));
  const issuesOf = new Map<number, string[]>();
  for (const i of timelineIssues(tl, calc)) {
    issuesOf.set(i.chapter, [...(issuesOf.get(i.chapter) ?? []), issueOnCard(i.text, i.chapter)]);
  }

  // 線的先後與顏色：種類（主線 → 支線 → 感情線 → 人物線），同種類按目錄裡的先後。
  const kindOrder = new Map(THREAD_KINDS.map((k, i) => [k, i]));
  const ordered = [...book.threads].sort((a, b) => (kindOrder.get(a.kind) ?? 0) - (kindOrder.get(b.kind) ?? 0) || a.index - b.index);
  const files = [...ordered.map((t, i) => ({ file: t, name: t.name, color: i < THREAD_COLORS ? i : -1 })), { file: book.unfiled, name: UNFILED_NAME, color: -1 }];
  const eventsOf = new Map<number, TimelineOverviewEvent[]>();
  const used = new Set<string>();
  for (const { file, name, color } of files) {
    for (const e of file.events) {
      if (e.planned) {
        continue;
      }
      used.add(name);
      eventsOf.set(e.chapter, [
        ...(eventsOf.get(e.chapter) ?? []),
        { thread: name, color, type: e.type, ...(e.foreshadowing ? { foreshadowing: e.foreshadowing } : {}), what: e.what, ...(e.evidence ? { evidence: e.evidence } : {}) },
      ]);
    }
  }
  const threads: TimelineOverviewThread[] = files.filter((f) => used.has(f.name)).map((f) => ({ name: f.name, color: f.color }));

  const cardOf = (d: TimelineDay): TimelineOverviewCard => {
    const c = byNo.get(d.chapter);
    const e = entries.get(d.chapter);
    const events = eventsOf.get(d.chapter) ?? [];
    const issues = issuesOf.get(d.chapter) ?? [];
    const synopsis = events.length === 0 && c?.synopsis ? clipLine(c.synopsis, CARD_SYNOPSIS_CHARS) : '';
    return {
      no: d.chapter,
      title: c?.title ?? '',
      state: d.state,
      when: d.state === 'missing' ? '還沒推' : d.state === 'bad' ? '那一行認不出' : cardWhen(tl, d),
      ...(d.delta !== undefined && d.state !== 'missing' && d.state !== 'bad' ? { delta: describeDelta(d.delta) } : {}),
      ...(d.end !== undefined ? { end: d.end } : {}),
      note: noteOf(d, CARD_NOTE_CHARS),
      events,
      ...(synopsis ? { synopsis } : {}),
      issues,
      detail: [...dayTip(tl, d), ...(c?.timePlace ? [`細綱寫的時間地點：${clipLine(c.timePlace, 200)}`] : [])],
      ...(d.state === 'flashback' ? { flashback: true as const } : {}),
      problem: issues.length > 0 || d.state === 'unknown' || d.state === 'bad' || d.state === 'missing',
      ...(c?.chapterPath ? { chapterPath: c.chapterPath } : {}),
      ...(c?.plotPath ? { plotPath: c.plotPath } : {}),
      machine: !!e && isMachineEntry(e),
    };
  };

  const byDay = new Map<number, TimelineOverviewCard[]>();
  const put = (day: number, card: TimelineOverviewCard) => byDay.set(day, [...(byDay.get(day) ?? []), card]);
  let lastDay: number | undefined;
  const early: TimelineOverviewCard[] = [];
  for (const d of calc.days) {
    if (d.state === 'flashback' || d.start === undefined) {
      if (lastDay === undefined) {
        early.push(cardOf(d));
      } else {
        put(lastDay, cardOf(d));
      }
      continue;
    }
    put(d.start, cardOf(d));
    lastDay = d.start;
  }
  if (early.length > 0) {
    const first = [...byDay.keys()].sort((a, b) => a - b)[0] ?? 0;
    for (const card of early) {
      put(first, card);
    }
  }

  const days: TimelineOverviewDay[] = [...byDay.keys()]
    .sort((a, b) => a - b)
    .map((day) => {
      const cards = byDay.get(day)!.sort((a, b) => a.no - b.no);
      if (day < 1) {
        return { day, label: '回憶', full: '推不出是哪天', cards };
      }
      const l = dayLabel(tl, day);
      const month = monthOfDay(tl, day);
      return {
        day,
        label: tl.start ? dayNoYear(tl, day) : l.full,
        ...(tl.start ? { sub: `第 ${day} 天` } : {}),
        full: l.full,
        ...(l.month ? { month: l.month } : {}),
        ...(month !== undefined ? { season: seasonOfMonth(tl.calendar, month) } : {}),
        cards,
      };
    });

  const calendarShort = tl.start ? `${traditionalLabel(tl.calendar)} · 起點 ${tl.startText}` : `${traditionalLabel(tl.calendar)} · 沒填起點`;
  return {
    relPath: group.relPath,
    exists: group.exists,
    meta: [calendarShort, group.label].filter(Boolean).join(' · '),
    tip: [group.calendar.text, group.calendar.tip].join('\n'),
    calendar: { name: tl.calendar, start: tl.startText, ...(group.calendar.suggestion ? { suggestion: group.calendar.suggestion } : {}) },
    issues: group.issues,
    threads,
    days,
    ...(group.missing ? { missing: group.missing } : {}),
    machine: group.machine,
    last: group.last,
  };
}
