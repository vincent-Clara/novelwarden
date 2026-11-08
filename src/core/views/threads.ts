import { traditionalLabel } from '../model/labels';
import {
  THREAD_KINDS,
  ForeshadowState,
  Thread,
  ThreadBook,
  ThreadEvent,
  ThreadFileBase,
  ThreadsMark,
  describeChapterRuns,
  foreshadowingOf,
  isForeshadowClosed,
  isForeshadowEvent,
  isThreadsJudged,
  threadKey,
  threadStateAt,
  threadWatch,
  unjudgedChapters,
} from '../model/threadFile';
import { TimelineDay, computeTimeline } from '../model/timelineFile';
import { ThreadReminder, isFallbackChapterTitle, threadRemindersFor } from '../model/pipeline';
import type { Plot } from '../model/plotFile';
import { NovelProject } from '../model/project';
import {
  ThreadLineView,
  ThreadUnfiledView,
  ThreadsOverview,
  ThreadsOverviewCell,
  ThreadsOverviewChapter,
  ThreadsOverviewChapterState,
  ThreadsOverviewEvent,
  ThreadsOverviewForeshadow,
  ThreadsOverviewGroup,
  ThreadsOverviewLine,
  ThreadsOverviewSpan,
  ThreadsView,
  TimelineOverview,
} from '../protocol';
import { volumeOf } from './quickOpen';
import { TimelineProgress, buildTimelineMatrix, chapterDayLabels, timelineGroupOf } from './timeline';

/**
 * 敘事線一覽（敘事線重做第 8 個提交，設計見 docs/design/plans/2026-10-20-narrative-threads.md「七、工程頁」）：工程頁
 * 「敘事線」頁籤那一列——一條線一行，作者一眼看出各條線走到哪、哪條斷了、哪條伏筆該收了。
 *
 * - **純函式、不調模型、不落盤**（第 18 條：狀態一律從磁碟推導）。讀盤由呼叫方做：工程頁重新整理時 `projectView.ts`
 *   把它那一趟 `readThreads()` 讀到的整本交進來，同一次重新整理裡敘事線目錄每份只讀一次（`projectTreeReads` 釘著）。
 * - **「現在」是定稿到的最後一章**（定稿過的章裡章號最大的那一章）：線上的實際事件都是定稿寫進來的，拿「寫到第幾章」
 *   當現在的話，寫了沒定稿的那幾章會讓每條線都像斷了。
 * - **一行怎麼寫由這裡給**（與設定名錄、出場人物同一個道理：文案只有一份），前端只渲染、只加 ⚠。
 *
 * 和 `views/lore.ts`、`views/cast.ts` 並排；三期的「敘事線總覽」（章 × 線的時間軸，{@link buildThreadsOverview}）也從這裡出資料：
 * 一行的說法、排序與「現在」都與工程頁同一份。故事時間的「時間線」組與「時間線總覽」的資料在 `views/timeline.ts`（2026-10-24 挪出去），
 * 時間線總覽讀盤的那一半（{@link buildTimelineOverview}）和敘事線總覽共用讀章節的那一段，所以在這裡。
 *
 * 寫前檢查的兩類提醒（二期，{@link threadReminders}）也在這裡取數：工作臺、對話頁寫正文之前、批次寫章的確認框用它；
 * 前端批次寫章彈窗拿工程頁資料裡的 `watch` 自己算（同一個 `threadRemindersFor`）。
 *
 * ## 兩個「到哪」（四期）
 *
 * - **定稿到**（`current`）：定稿過、正文還在的章裡章號最大的那一章。總覽上那條豎線、列頭的顏色按它。
 * - **敘事線判到**（`through`）：`project.json` 的水位（從第 1 章起連續判過的，不超過定稿到）。⚑ 線的狀態——斷了幾章、伏筆逾期、
 *   過了計劃收束章——**按它算**：定稿了卻還沒判的章（拆書匯入、補齊整理出來的、補記停在半路的），線上本來就沒有事件，按定稿到算
 *   會讓每條線都像斷了、每條伏筆都像逾期。落後時工程頁另說「⚠ 第 a–b 章還沒判」，總覽上的偏差只算判過的章。
 */

/** 排序：主線 → 支線 → 感情線 → 人物線。 */
const KIND_ORDER = new Map(THREAD_KINDS.map((k, i) => [k, i]));

/** 一行滑鼠移上去看的（意圖、當前進度）各截多少字。 */
const TIP_CHARS = 120;

/** 壓成一行、截到 `max` 個字（裝配器的 `clipLine` 同一個寫法；views 不依賴 context/）。 */
function clipLine(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s*\n+\s*/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

/** 定稿到第幾章、敘事線判到哪（四期）：工程頁與總覽從讀盤那一半交進來。「時間線」組要的同步過的章與各章章名也在這裡（`TimelineProgress`）。 */
export interface ThreadsProgress extends TimelineProgress {
  /** 敘事線的水位與水位之後另外判過的章（`project.json`）。 */
  mark: ThreadsMark;
}

/** 敘事線判到第幾章：水位，不超過定稿到（定稿之後又刪了細綱、正文的章不算）。 */
export function judgedThrough(mark: ThreadsMark, current: number): number {
  return Math.min(mark.through, current);
}

/**
 * 工程頁「敘事線」頁籤的資料。`current` 是「定稿到」的最後一章；`progress` 是敘事線判到哪（四期），缺席當定稿過的章都判過了
 * （判到 = 定稿到，沒有落後）。線的狀態按「判到」算（見上面「兩個『到哪』」）。
 *
 * 排序：種類（主線 → 支線 → 感情線 → 人物線）→ 最近一次推進（近的在前；一次都沒推進過的排在同種類最後，按計劃
 * 開始的章）→ 目錄裡的順序（檔名）。
 */
export function buildThreadsView(book: ThreadBook, current: number, progress?: ThreadsProgress): ThreadsView {
  const through = progress ? judgedThrough(progress.mark, current) : current;
  const lines = book.threads.map((t) => lineOf(t, through));
  const order = new Map(book.threads.map((t) => [t.relPath, t]));
  lines.sort((a, b) => compareLines(order.get(a.relPath)!, a, order.get(b.relPath)!, b));
  const unfiled = unfiledOf(book.unfiled, through);
  const behind = progress ? unjudgedChapters(progress.mark, progress.finalized) : [];
  const timeline = timelineGroupOf(book.timeline, progress);
  // 寫前提醒要的數（二期）：按現在的樣子算，前端批次寫章彈窗照它與要寫的那幾章算提醒（與後端確認框同一個函式）。
  return {
    lines,
    ...(unfiled ? { unfiled } : {}),
    current,
    through,
    ...(behind.length > 0 ? { lag: { count: behind.length, text: `${describeChapterRuns(behind)}還沒判` } } : {}),
    watch: threadWatch(book),
    ...(timeline ? { timeline } : {}),
  };
}

/**
 * 寫這幾章之前的敘事線提醒（二期，設計稿「四、寫前檢查」）：伏筆逾期、線斷了，零呼叫、不攔人。讀一遍敘事線目錄與章節，
 * 按第一章 `asOf`（寫第 N 章時按第 N − 1 章算，`threadRemindersFor`）。`through` 是敘事線判到第幾章（四期的水位，不超過定稿到；
 * 同工程頁的「敘事線判到」），說法裡拿它注一句還沒記上的那幾章（`unrecordedBefore`：沒定稿的，或定稿了還沒判的）。
 */
export async function threadReminders(project: NovelProject, nos: readonly number[]): Promise<{ reminders: ThreadReminder[]; through: number }> {
  if (nos.length === 0) {
    return { reminders: [], through: 0 };
  }
  const first = Math.min(...nos);
  const [book, plots, chapters, mark] = await Promise.all([
    project.readThreads(),
    project.listPlots(),
    project.listChapters(),
    project.readThreadsMark(),
  ]);
  const current = chapters.reduce((max, c) => (c.order > max && project.plotFor(c.order, plots, chapters)?.sourceHash ? c.order : max), 0);
  return { reminders: threadRemindersFor(threadWatch(book, first), nos), through: judgedThrough(mark, current) };
}

function compareLines(ta: Thread, a: ThreadLineView, tb: Thread, b: ThreadLineView): number {
  return (
    KIND_ORDER.get(a.kind)! - KIND_ORDER.get(b.kind)! ||
    (b.lastActive ?? -1) - (a.lastActive ?? -1) ||
    (ta.from ?? Infinity) - (tb.from ?? Infinity) ||
    ta.index - tb.index
  );
}

/** 一條線一行。 */
function lineOf(t: Thread, current: number): ThreadLineView {
  const state = threadStateAt(t, current);
  const fores = foreshadowingOf(t, current);
  const open = fores.filter((f) => !isForeshadowClosed(f.status)).length;
  const overdueFores = fores.filter((f) => f.overdue).length;
  const detail = [
    traditionalLabel(t.kind),
    traditionalLabel(state.status),
    state.lastActive !== undefined ? `最近第 ${state.lastActive} 章` : planOf(t),
    open > 0 ? `${open} 條伏筆沒收` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const warnings = [
    state.stalled ? `斷了 ${state.gap} 章` : '',
    overdueFores > 0 ? `${overdueFores} 條伏筆逾期` : '',
    state.overdue ? `過了計劃收束的第 ${t.to} 章` : '',
  ].filter(Boolean);
  const tip = [
    t.intent ? `意圖：${clipLine(t.intent, TIP_CHARS)}` : '',
    t.progress ? `當前進度${t.progressThrough !== undefined ? `（寫到第 ${t.progressThrough} 章）` : ''}：${clipLine(t.progress, TIP_CHARS)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    name: t.name,
    relPath: t.relPath,
    kind: t.kind,
    status: state.status,
    ...(state.lastActive !== undefined ? { lastActive: state.lastActive } : {}),
    detail,
    warnings,
    tip,
  };
}

/** 還沒推進過的線寫計劃區間：`計劃第 3–40 章`、`計劃第 3 章起`、`計劃第 40 章收`。都沒寫是空串。 */
function planOf(t: Thread): string {
  if (t.from !== undefined && t.to !== undefined) {
    return `計劃第 ${t.from}–${t.to} 章`;
  }
  if (t.from !== undefined) {
    return `計劃第 ${t.from} 章起`;
  }
  return t.to !== undefined ? `計劃第 ${t.to} 章收` : '';
}

/**
 * 「未歸屬的伏筆 · N 條」。一條伏筆都沒有（沒有這份檔案、或作者把它們都挪走了）時不畫這一行：點進去也是空的。
 * 只在事件裡出現過名字的也算一條（與 `foreshadowingOf` 同一個口徑）。
 */
function unfiledOf(file: ThreadFileBase, current: number): ThreadUnfiledView | undefined {
  const fores = foreshadowingOf(file, current);
  if (fores.length === 0) {
    return undefined;
  }
  const open = fores.filter((f) => !isForeshadowClosed(f.status)).length;
  const overdue = fores.filter((f) => f.overdue).length;
  return {
    relPath: file.relPath,
    total: fores.length,
    detail: `${fores.length} 條${open < fores.length ? ` · ${open} 條沒收` : ''}`,
    warnings: overdue > 0 ? [`${overdue} 條伏筆逾期`] : [],
  };
}

// ---------------------------------------------------------------- 敘事線總覽（三期）

/**
 * 總覽的列數上限：幾千章的書照樣畫得下（格子是稀疏的，一行只畫有事件的那幾章），再多就是計劃裡寫錯了章號
 * （`plan: 3-30000`）。有正文或細綱的章永遠畫全，只截計劃裡提得太遠的那一截。
 */
export const OVERVIEW_MAX_CHAPTERS = 5000;

/** 總覽裡一列的原料：有細綱或正文的那幾章（讀盤那一半給，{@link buildThreadsOverview}）。 */
export interface OverviewChapterInput {
  no: number;
  title: string;
  volume: string;
  state: Exclude<ThreadsOverviewChapterState, 'none'>;
  chapterPath?: string;
  plotPath?: string;
}

/**
 * 兩份總覽（敘事線總覽、時間線總覽）讀章節的那一半，同一個口徑：有細綱或正文的章（讀細綱、章節兩份列表，借快取），配上它的細綱。
 * 同號的正文有兩份時認路徑排序第一份（與流水線、「轉到…」同一個口徑）；細綱按路徑配對（`NovelProject.plotFor`）：有正文只認它映象的
 * 那一份，沒有正文按號認計劃。
 */
async function overviewChapters(project: NovelProject): Promise<{ input: OverviewChapterInput; plot?: Plot }[]> {
  const [plots, chapters] = await Promise.all([project.listPlots(), project.listChapters()]);
  const chaptersRoot = project.relPath(project.chaptersDir);
  const plotsRoot = project.relPath(project.plotsDir);
  const chapterOf = new Map<number, (typeof chapters)[number]>();
  for (const c of chapters) {
    if (!chapterOf.has(c.order)) {
      chapterOf.set(c.order, c);
    }
  }
  const nos = [...new Set([...chapterOf.keys(), ...plots.map((p) => p.no)])].sort((a, b) => a - b);
  return nos.map((no) => {
    const chapter = chapterOf.get(no);
    const plot = project.plotFor(no, plots, chapters);
    const title = plot?.title || (chapter && !isFallbackChapterTitle(no, chapter.title) ? chapter.title : '');
    const state: OverviewChapterInput['state'] =
      chapter && plot?.sourceHash ? 'finalized' : chapter && chapter.wordCount > 0 ? 'written' : 'planned';
    const input: OverviewChapterInput = {
      no,
      title,
      volume: chapter ? volumeOf(chapter.relPath, chaptersRoot) : plot ? volumeOf(plot.relPath, plotsRoot) : '',
      state,
      ...(chapter ? { chapterPath: chapter.relPath } : {}),
      ...(plot ? { plotPath: plot.relPath } : {}),
    };
    return { input, ...(plot ? { plot } : {}) };
  });
}

/**
 * 編輯區「敘事線總覽」標籤的資料（設計稿「八、敘事線總覽」）：讀一遍敘事線目錄與章節、細綱兩份列表（借快取）、`project.json` 裡
 * 敘事線判到哪，交給 {@link buildThreadsMatrix}。**純讀盤、不調模型、不落盤**（第 18、28 條：狀態一律從事件現算）。「定稿到」與
 * 「敘事線判到」都與工程頁「敘事線」頁籤同一個口徑：定稿過（細綱有 `sourceHash`）、正文還在的章裡章號最大的那一章；水位不超過它。
 *
 * 按需要（`requestThreadsOverview`），不進工程樹：工程樹每次檔案變動都全量重推，這份只在總覽開著時有用。
 */
export async function buildThreadsOverview(project: NovelProject): Promise<ThreadsOverview> {
  if (!(await project.isInitialized())) {
    return { initialized: false, chapters: [], current: 0, through: 0, volumes: false, groups: [] };
  }
  const [book, rows, mark] = await Promise.all([project.readThreads(), overviewChapters(project), project.readThreadsMark()]);
  const inputs = rows.map((r) => r.input);
  const current = inputs.reduce((max, c) => (c.state === 'finalized' && c.no > max ? c.no : max), 0);
  return { initialized: true, ...buildThreadsMatrix(book, inputs, current, { mark }) };
}

/**
 * 編輯區「時間線總覽」標籤的資料（2026-10-24，設計稿 docs/design/plans/2026-10-24-timeline-page.md）：讀時間線與敘事線（卡片上帶這一章
 * 在各條線上發生的事）、章節與細綱（章名、梗概、時間地點、同步過沒有），交給 `views/timeline.ts` 的 `buildTimelineMatrix`。
 * 純讀盤、不調模型、不落盤；按需要（`requestTimelineOverview`），不進工程樹（同敘事線總覽）。
 */
export async function buildTimelineOverview(project: NovelProject): Promise<TimelineOverview> {
  if (!(await project.isInitialized())) {
    return { initialized: false, relPath: '', exists: false, meta: '', tip: '', calendar: { name: '简单历', start: '' }, issues: [], threads: [], days: [], machine: 0, last: 0 };
  }
  const [book, rows] = await Promise.all([project.readThreads(), overviewChapters(project)]);
  const inputs = rows.map(({ input, plot }) => ({
    no: input.no,
    title: input.title,
    ...(input.chapterPath ? { chapterPath: input.chapterPath } : {}),
    ...(input.plotPath ? { plotPath: input.plotPath } : {}),
    synopsis: plot?.sections['梗概'] ?? '',
    timePlace: plot?.sections['时间地点'] ?? '',
    finalized: input.state === 'finalized',
  }));
  return { initialized: true, ...buildTimelineMatrix(book, inputs) };
}

/**
 * 總覽的矩陣（純函式）。`chapters` 是有細綱或正文的章，`current` 是「定稿到」的最後一章；`opts.mark` 是敘事線判到哪（四期，缺席
 * 當定稿過的章都判過了），`opts.limit` 是列數上限。
 *
 * - **列**：第 1 章到「計劃或已寫的最後一章」——有細綱或正文的章、任何事件（計劃的、實際的）、伏筆計劃埋與收的章、線的
 *   計劃區間裡最晚的那一章；中間沒有檔案的章補一列 `none`（卷名沿用前一章）。提得太遠的截在 {@link OVERVIEW_MAX_CHAPTERS}。
 * - **行**：線按種類分組（主線 → 支線 → 感情線 → 人物線），組裡的先後與工程頁一樣；每條線下面是它的伏筆（`foreshadowingOf`
 *   的順序：「伏筆」一節寫了的在前，只在事件裡出現過的跟在後面）；最後是「未歸屬的伏筆」（一條都沒有不給）。
 * - **線的格子**：線自己的事件（推進 / 關係 / 收束 / 放棄）；沒寫伏筆名的伏筆事件也放在這裡（沒有別的行可放）。
 * - **伏筆的格子**：這條伏筆的埋 / 收 / 棄；連線見 {@link spanOf}。
 * - **判過沒有**（四期）：定稿過、敘事線還沒判的列標 `unjudged`（列頭另一種樣子）；**偏差只算判過的章**——還沒判的章上線裡本來
 *   就沒有實際事件，算進去就是一片紅圈（拆書匯入、補齊整理出來的書）。線與伏筆的狀態（斷了、逾期、連線延到哪）按「敘事線判到」
 *   （水位，不超過定稿到）算，同工程頁。
 */
export function buildThreadsMatrix(
  book: ThreadBook,
  chapters: readonly OverviewChapterInput[],
  current: number,
  opts: { limit?: number; mark?: ThreadsMark } = {}
): Omit<ThreadsOverview, 'initialized'> {
  const limit = opts.limit ?? OVERVIEW_MAX_CHAPTERS;
  const mark = opts.mark ?? { through: current, judged: [] };
  const through = judgedThrough(mark, current);
  const files: ThreadFileBase[] = [...book.threads, book.unfiled];
  const fileMax = chapters.reduce((m, c) => Math.max(m, c.no), Math.max(0, current));
  const tl = book.timeline?.exists ? book.timeline : undefined;
  const calc = tl ? computeTimeline(tl) : undefined;
  const mentioned = [
    ...files.flatMap((f) => f.events.map((e) => e.chapter)),
    ...files.flatMap((f) => f.foreshadowing.flatMap((x) => [x.plant ?? 0, x.resolve ?? 0])),
    ...book.threads.flatMap((t) => [t.from ?? 0, t.to ?? 0]),
  ];
  const wanted = mentioned.reduce((m, n) => Math.max(m, n), fileMax);
  const last = Math.min(wanted, Math.max(limit, fileMax));

  const byNo = new Map(chapters.map((c) => [c.no, c]));
  // 這一章是哪天（列頭與格子的懸停帶一句；2026-10-24 時間線總覽：「時間線」一組與月份帶挪去時間線總覽了）。
  const times = tl && calc ? chapterDayLabels(tl, calc) : new Map<number, string>();
  const columns: ThreadsOverviewChapter[] = [];
  let volume = '';
  for (let no = 1; no <= last; no++) {
    const c = byNo.get(no);
    volume = c ? c.volume : volume;
    const unjudged = c?.state === 'finalized' && !isThreadsJudged(mark, no);
    const time = times.get(no);
    columns.push({
      ...(c ? { ...c, ...(unjudged ? { unjudged: true as const } : {}) } : { no, title: '', volume, state: 'none' as const }),
      ...(time ? { time } : {}),
    });
  }
  // 伏筆埋下至今多少天（懸停伏筆名看）：埋的那一章開頭到敘事線判到的那一章結尾。
  const dayOf = (no: number): TimelineDay | undefined => calc?.days[no - 1];
  // 拿來判偏差的章：定稿過、敘事線也判過（四期）。
  const finalized = new Set(columns.filter((c) => c.state === 'finalized' && !c.unjudged).map((c) => c.no));

  // 組裡的先後與工程頁同一個排法（`buildThreadsView`）：最近推進的在前，沒推進過的按計劃開始的章。
  const order = book.threads
    .map((t) => ({ t, view: lineOf(t, through) }))
    .sort((a, b) => compareLines(a.t, a.view, b.t, b.view));
  const groups: ThreadsOverviewGroup[] = [];
  for (const { t, view } of order) {
    const line: ThreadsOverviewLine = {
      name: t.name,
      relPath: t.relPath,
      kind: t.kind,
      status: view.status,
      ...(t.from !== undefined ? { from: t.from } : {}),
      ...(t.to !== undefined ? { to: t.to } : {}),
      detail: view.detail,
      warnings: view.warnings,
      tip: view.tip,
      cells: lineCells(t, finalized, last),
      foreshadowing: foreshadowRows(t, through, finalized, last, dayOf),
    };
    const group = groups.find((g) => g.kind === t.kind);
    if (group) {
      group.lines.push(line);
    } else {
      groups.push({ kind: t.kind, lines: [line] });
    }
  }
  const unfiled = foreshadowRows(book.unfiled, through, finalized, last, dayOf);
  return {
    chapters: columns,
    current,
    through,
    volumes: columns.some((c) => c.volume !== ''),
    groups,
    ...(unfiled.length > 0 ? { unfiled: { relPath: book.unfiled.relPath, foreshadowing: unfiled } } : {}),
    ...(wanted > last ? { clippedFrom: wanted } : {}),
  };
}

function overviewEvent(e: ThreadEvent): ThreadsOverviewEvent {
  return {
    type: e.type,
    ...(e.foreshadowing ? { foreshadowing: e.foreshadowing } : {}),
    what: e.what,
    ...(e.evidence ? { evidence: e.evidence } : {}),
  };
}

/** 按章把事件歸成格子（只給有事件的章，按章號升序；同一章裡照檔案裡寫的先後）。截掉 `last` 之後的。 */
function cellsOf(events: readonly ThreadEvent[], last: number): ThreadsOverviewCell[] {
  const by = new Map<number, ThreadsOverviewCell>();
  for (const e of events) {
    if (e.chapter > last) {
      continue;
    }
    let cell = by.get(e.chapter);
    if (!cell) {
      cell = { chapter: e.chapter, planned: [], actual: [], deviation: false };
      by.set(e.chapter, cell);
    }
    (e.planned ? cell.planned : cell.actual).push(overviewEvent(e));
  }
  return [...by.values()].sort((a, b) => a.chapter - b.chapter);
}

/**
 * 線那一行的格子：線自己的事件。偏差（⚑）= 這一章有計劃、那一章定稿了（四期：敘事線也判過了），卻**一條**實際的事件都沒有——
 * 計劃了推進與關係、只發生了推進的算發生了（畫 ◉，懸停看得到兩邊各是什麼）。伏筆的事件不算這條線動過：它們在伏筆那幾行。
 */
function lineCells(t: Thread, finalized: ReadonlySet<number>, last: number): ThreadsOverviewCell[] {
  const cells = cellsOf(
    t.events.filter((e) => !(isForeshadowEvent(e.type) && e.foreshadowing)),
    last
  );
  for (const cell of cells) {
    cell.deviation = cell.planned.length > 0 && cell.actual.length === 0 && finalized.has(cell.chapter);
  }
  return cells;
}

/**
 * 一份檔案（一條線，或「未歸屬的伏筆」）裡的伏筆，一條一行。偏差（⚑）：計劃在第 N 章埋的，第 N 章定稿了（四期：敘事線也判過了）、
 * 到第 N 章為止還沒埋（也沒收、沒棄）；計劃在第 N 章收的，第 N 章定稿了、到第 N 章為止還沒收（或棄）。提前埋了、提前收了的不算偏差。
 * `current` 是「敘事線判到」（逾期、連線延到哪按它）。
 */
function foreshadowRows(
  file: ThreadFileBase,
  current: number,
  finalized: ReadonlySet<number>,
  last: number,
  dayOf: (no: number) => TimelineDay | undefined = () => undefined
): ThreadsOverviewForeshadow[] {
  return foreshadowingOf(file, current).map((f) => {
    const key = threadKey(f.name);
    const mine = file.events.filter((e) => isForeshadowEvent(e.type) && e.foreshadowing && threadKey(e.foreshadowing) === key);
    const actual = mine.filter((e) => !e.planned);
    const plantedBy = (no: number) => actual.some((e) => e.type === '埋' && e.chapter <= no);
    const closedBy = (no: number) => actual.some((e) => e.type !== '埋' && e.chapter <= no);
    const cells = cellsOf(mine, last);
    for (const cell of cells) {
      if (!finalized.has(cell.chapter)) {
        continue;
      }
      const types = new Set(cell.planned.map((e) => e.type));
      const missedPlant = types.has('埋') && !plantedBy(cell.chapter) && !closedBy(cell.chapter);
      const missedClose = (types.has('收') || types.has('弃')) && !closedBy(cell.chapter);
      cell.deviation = missedPlant || missedClose;
    }
    const plannedChapters = (type: '埋' | '收') => mine.filter((e) => e.planned && e.type === type).map((e) => e.chapter);
    const span = spanOf(f, plannedChapters('埋'), plannedChapters('收'), current, last);
    return {
      name: f.name,
      what: f.what,
      status: f.status,
      ...(f.plant !== undefined ? { plant: f.plant } : {}),
      ...(f.resolve !== undefined ? { resolve: f.resolve } : {}),
      ...(f.resolveBy !== undefined ? { resolveBy: f.resolveBy } : {}),
      ...(f.plantedAt !== undefined ? { plantedAt: f.plantedAt } : {}),
      ...(f.closedAt !== undefined ? { closedAt: f.closedAt } : {}),
      overdue: f.overdue,
      ...(span ? { span } : {}),
      tip: foreshadowTip(f, plantedDays(f, current, dayOf)),
      cells,
    };
  });
}

/**
 * 伏筆一行上的連線（設計稿：埋 ● 到收 ◆ 之間連一條線，沒收的虛線延到計劃回收章）：
 *
 * - 收了、棄了：從埋的那一章實線連到收（棄）的那一章；
 * - 埋了沒收：虛線從埋的那一章延到計劃回收章——伏筆那一行寫的回收章、計劃裡收它的那一章、寫明的「推遲到第 N 章收」**取晚的**
 *   （`resolveBy`；⚑，二期留的那個問題：兩樣都畫，回收章那一格另有一道豎線，計劃的收畫空心 ◆）；逾期的延到「現在」；一樣都沒寫
 *   也延到「現在」（它還掛著）；
 * - 還沒埋：按計劃從埋的那一章（伏筆那一行寫的，沒寫取計劃裡埋它的那一章）到回收章畫一條淡虛線；缺一頭不畫。
 *
 * 超過最後一列的截到最後一列。
 */
function spanOf(
  f: ForeshadowState,
  plannedPlants: readonly number[],
  plannedResolves: readonly number[],
  current: number,
  last: number
): ThreadsOverviewSpan | undefined {
  const clip = (span: ThreadsOverviewSpan): ThreadsOverviewSpan | undefined =>
    span.from < Math.min(span.to, last) ? { ...span, to: Math.min(span.to, last) } : undefined;
  if (isForeshadowClosed(f.status) && f.closedAt !== undefined) {
    return clip({ from: f.plantedAt ?? f.closedAt, to: f.closedAt, kind: 'done' });
  }
  const ends = [
    ...(f.resolveBy !== undefined ? [f.resolveBy] : []),
    ...plannedResolves,
    ...(f.overdue ? [current] : []),
  ];
  if (f.plantedAt !== undefined) {
    return clip({ from: f.plantedAt, to: Math.max(f.plantedAt, ...(ends.length > 0 ? ends : [current])), kind: 'open' });
  }
  const from = f.plant ?? (plannedPlants.length > 0 ? Math.min(...plannedPlants) : undefined);
  if (from === undefined || ends.length === 0) {
    return undefined;
  }
  return clip({ from, to: Math.max(...ends), kind: 'planned' });
}

/** 埋下、還沒收的伏筆埋了多少天：埋的那一章開頭到 `current` 那一章結尾（時間線推得出兩頭才有）。 */
function plantedDays(f: ForeshadowState, current: number, dayOf: (no: number) => TimelineDay | undefined): number | undefined {
  if (f.status !== '已埋' || f.plantedAt === undefined) {
    return undefined;
  }
  const from = dayOf(f.plantedAt)?.start;
  const to = dayOf(current)?.end;
  return from !== undefined && to !== undefined && to >= from ? to - from : undefined;
}

/** 懸停伏筆名看的幾行：是什麼、計劃第幾章埋 / 第幾章前收（推遲過的另說推遲到哪）、現在怎樣（埋了多少天，時間線推得出時）。 */
function foreshadowTip(f: ForeshadowState, days?: number): string {
  const later = (written: number | undefined, by: number | undefined): string =>
    by !== undefined && by !== written ? `${written !== undefined ? '，' : ''}推遲到第 ${by} 章` : '';
  const plan = [
    f.plant !== undefined || f.plantBy !== undefined
      ? `${f.plant !== undefined ? `計劃第 ${f.plant} 章埋` : '计划'}${later(f.plant, f.plantBy)}${f.plant === undefined ? '埋' : ''}`
      : '',
    f.resolve !== undefined || f.resolveBy !== undefined
      ? `${f.resolve !== undefined ? `第 ${f.resolve} 章前收` : ''}${later(f.resolve, f.resolveBy)}${f.resolve === undefined ? '收' : ''}`
      : '',
  ]
    .filter(Boolean)
    .join('、');
  const state =
    f.status === '已收'
      ? `第 ${f.closedAt} 章收了`
      : f.status === '已弃'
        ? `第 ${f.closedAt} 章棄了`
        : f.status === '已埋'
          ? `第 ${f.plantedAt} 章埋下，還沒收${days !== undefined ? `（故事裡已經過了 ${days} 天）` : ''}`
          : '還沒埋';
  return [f.what, plan, `${state}${f.overdue ? `，過了第 ${f.resolveBy} 章（逾期）` : ''}`].filter(Boolean).join('\n');
}
