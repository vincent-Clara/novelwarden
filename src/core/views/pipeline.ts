/**
 * 流水線的讀取聚合：把磁碟上散落的產物合成一份「這一章 / 這本書現在到哪一步了」。
 *
 * 與 [cast.ts](cast.ts) 同級、同類——那邊把定稿過的細綱反向聚合成出場索引，
 * 這邊把大綱 / 細綱 / 正文聚合成流水線狀態。判斷邏輯全在純函式
 * [model/pipeline.ts](../model/pipeline.ts) 裡，這裡只負責取數。
 *
 * ## 一條軸，細綱映象正文的路徑
 *
 * 一個章號一行。第 N 章的正文按檔名字首認（同號有兩份時取路徑排序第一份，並記一條 warn——
 * 不猜、不崩，讓作者在工程頁上看得見兩份）；它的細綱**按路徑配對**：正文在章節根下的相對路徑
 * 映象到 `summaries/` 下（`NovelProject.plotFor`）。還沒有正文的章只有細綱，按號認。
 *
 * ## 新鮮度鏈：把「變更影響」做成傳播，而不是一次模型呼叫
 *
 * ```
 * 細綱的梗概（大綱裡第 N 章那一條） ─hash─▶ 細綱 (frontmatter.upstreamHash，排細綱時記、定稿時重新整理)
 * 細綱七個小節                         ─hash─▶ 細綱 (frontmatter.writtenFrom，正文落盤時記、定稿時重新整理)
 * chapters/…/N-標題                    ─hash─▶ 細綱 (frontmatter.sourceHash，定稿反向更新時記)
 * ```
 *
 * 情節大綱是各章梗概的彙總：在大綱裡改了某一章那一條，排過的那一章細綱標髒；改了某一章的細綱（包括定稿之後再改），
 * 那一章的正文標髒；改了正文，定稿對不上了。**代價是零次模型呼叫、零幻覺、零 token。**
 *
 * 正文那一環的指紋記在**細綱**上而不是章節上：章節是作者的檔案，可以是 `.txt`、
 * 沒有 frontmatter（第 9 條）。架構 → 大綱那一環還沒有：改了設定四件，大綱不會掛 ⟳。
 */
import * as path from 'node:path';
import { scoped } from '../runtime/logger';
import { pad3, sanitizeFileName } from '../model/fs';
import { NovelProject } from '../model/project';
import { Plot, isPlotFilled, isPlotUpstreamStale, parsePlotFileName, plotContentHash } from '../model/plotFile';
import { BookConfig } from '../model/settingFile';
import { isOutlineFilled, outlineCoverage } from '../model/outlineFile';
import {
  BookFacts,
  ChapterGap,
  NextStepFacts,
  PipelineFacts,
  PipelineProgress,
  PlotStage,
  deriveProgress,
  deriveStage,
  emptyFacts,
  isFallbackChapterTitle,
  manuscriptRatio,
} from '../model/pipeline';
import { Chapter, CharacterCard, LoreEntry, ProjectManifest } from '../model/types';

const log = scoped('流水線');

/**
 * 每個工程上一次記進日誌的名單（按工程根目錄 + 哪一條）。
 *
 * 索引每次 `pushState` 都要建一趟，編輯器裡打幾個字就是好幾趟；名單沒變還照記，
 * 日誌頁就被同一行刷屏，別的線索被擠出緩衝。所以只在名單變了的時候記。
 */
const lastLogged = new Map<string, string>();

/** 這份名單與上一次記的不一樣（順手記下它）。空名單也記下：清掉之後再出現會重新記。 */
function changedSinceLastLog(project: NovelProject, what: string, list: string): boolean {
  const key = `${project.root}\n${what}`;
  if (list === (lastLogged.get(key) ?? '')) {
    return false;
  }
  lastLogged.set(key, list);
  return true;
}

export interface PlotPipeline {
  /** 章號。 */
  no: number;
  title: string;
  /** 這一章的細綱。**沒有細綱時 `relPath` 是它應該在的位置**（有正文就是正文的映象）。 */
  plot: {
    relPath: string;
    /** 有這份檔案。老工程裡只有正文的章為 false。 */
    exists: boolean;
    filled: boolean;
    /** 排過這一章之後，大綱裡這一章那一條改過。 */
    upstreamStale: boolean;
  };
  /** 同號的章節（正文）。 */
  chapter: {
    exists: boolean;
    /** 沒有正文時是空串。正文該落在哪要問 {@link chapterTargetOf}。 */
    relPath: string;
    words: number;
    /** 目標字數：細綱的 `targetWords`，沒寫就是 `config.md` 的每章字數。都沒有是 undefined。 */
    targetWords?: number;
    /** 寫完正文之後，這一章的細綱改過——正文可能已經與它對不上。 */
    upstreamStale: boolean;
  };
  /** 定稿：`exists` = 細綱定稿過（有 `sourceHash`），`stale` = 沒定稿過或定稿之後正文又改過。 */
  summary: { exists: boolean; stale: boolean };
  stage: PlotStage;
  progress: PipelineProgress;
}

/**
 * 一章的流水線狀態。`plot` 與 `chapter` 至少有一個在，都沒有時就是一份空殼
 * （「寫第 N 章細綱」）。
 *
 * `context` 由呼叫方傳入：批次構建（工程頁要為幾百章各算一份）時大綱、配置、章節列表只讀
 * 一次，否則每章都去讀一遍同樣的檔案。
 *
 * `entry` 上那個 `sections?: never` 是防呆：`Plot` 自己就有 `no`，另外兩個欄位
 * 又是可選的，所以**直接把一份 `Plot` 遞進來是編譯得過的**，代價是 plot 與
 * chapter 雙雙 undefined、整章按空事實推導——那種錯不會報錯，只會安靜地說謊。
 */
export async function buildPlotPipeline(
  project: NovelProject,
  entry: { no: number; plot?: Plot; chapter?: Chapter; sections?: never },
  context?: {
    config?: BookConfig;
    chapters?: Chapter[];
  }
): Promise<PlotPipeline> {
  const { no, plot } = entry;
  const config = context?.config ?? (await project.readBookConfig());
  const chapters = context?.chapters ?? (await project.listChapters());
  const chapter = entry.chapter ?? chapterOfPlotNo(chapters, no);

  // 上游是這一章的梗概（情節大綱裡這一章那一條）：在大綱裡改了、排過的細綱沒跟就掛 ⟳。
  // upstreamHash 為空 = 這份細綱是作者手寫的（或來自還沒記錄指紋的舊版本）——**不標髒**：手寫的東西沒有「上游」，
  // 拿一個憑空的過期標記去催作者重做，比不標更糟。只有梗概的空殼同理（沒有可跟的東西）。
  const plotStale = isPlotUpstreamStale(plot);
  // 同理：沒記過 writtenFrom（正文是作者自己寫的）不標髒——只有「記錄過一次、
  // 現在對不上」才說明細綱確實在正文（或定稿）之後改過（第 18a 條）。
  const chapterStale = !!chapter && !!plot?.writtenFrom && plot.writtenFrom !== plotContentHash(plot);
  // 定稿過 = 細綱上記著 sourceHash；對得上 = 定稿之後正文沒再改過（第 23 條）。
  const finalized = !!plot?.sourceHash;

  const targetWords = plot?.targetWords ?? config.wordsPerChapter;
  const facts: PipelineFacts = {
    ...emptyFacts(),
    plotFilled: !!plot && isPlotFilled(plot.sections),
    words: chapter?.wordCount ?? 0,
    targetWords,
    upstreamStale: chapterStale,
    chapterExists: !!chapter,
    summaryExists: finalized,
    summaryStale: !chapter || !finalized || plot!.sourceHash !== chapter.contentHash,
    markedDone: !!plot?.done,
  };

  return {
    no,
    title: plot?.title || (chapter && !isFallbackChapterTitle(no, chapter.title) ? chapter.title : ''),
    plot: {
      relPath:
        plot?.relPath ??
        (chapter ? project.plotPathForChapter(chapter.relPath) : await project.plotPathForNewChapter(no)),
      exists: !!plot,
      filled: facts.plotFilled,
      upstreamStale: plotStale,
    },
    chapter: {
      exists: !!chapter,
      relPath: chapter?.relPath ?? '',
      words: facts.words,
      targetWords,
      upstreamStale: chapterStale,
    },
    summary: { exists: facts.summaryExists, stale: facts.summaryStale },
    stage: deriveStage(facts),
    progress: deriveProgress(facts),
  };
}

export interface PipelineIndex {
  /** 每一個出現過的章號一行（細綱號 ∪ 章節號），升序。缺號的不補空行。 */
  rows: PlotPipeline[];
  /** 按章號索引。 */
  byNo: Map<number, PlotPipeline>;
  plots: Plot[];
  chapters: Chapter[];
  manifest: ProjectManifest;
  outline: string;
  config: BookConfig;
}

/**
 * 全書的流水線索引。一個章號一行，細綱**按路徑配對**（見檔案頭）。
 *
 * 大綱、配置、manifest 都只讀一次，攤給所有章——五百章工程逐章重讀
 * 這些檔案會把工程頁重新整理變成幾百次多餘的讀盤。細綱列表與 manifest 一併返回：
 * 工程樹與出場索引要的是同一批，讓它們接著用這一份。
 */
export async function buildPipelineIndex(project: NovelProject): Promise<PipelineIndex> {
  const startedAt = Date.now();
  const [plots, chapters, outline, manifest, config] = await Promise.all([
    project.listPlots(),
    project.listChapters(),
    project.readOutline(),
    project.readManifest(),
    project.readBookConfig(),
  ]);
  const context = { config, chapters };

  const duplicates = duplicateChapterNos(chapters).map((n) => `第 ${n} 章`).join('、');
  if (changedSinceLastLog(project, '撞號', duplicates) && duplicates) {
    log.warn('有幾個章號不止一個正文檔案，流水線只認路徑排序第一份', duplicates);
  }
  const nos = [...new Set([...plots.map((p) => p.no), ...chapters.map((c) => c.order)])].sort((a, b) => a - b);

  const rows: PlotPipeline[] = [];
  for (const no of nos) {
    rows.push(await buildPlotPipeline(project, { no, plot: project.plotFor(no, plots, chapters) }, context));
  }
  const byNo = new Map(rows.map((r) => [r.no, r]));

  const stale = rows.filter((p) => p.plot.upstreamStale || p.chapter.upstreamStale);
  const staleNos = stale.map((p) => `第 ${p.no} 章`).join('、');
  if (changedSinceLastLog(project, '上游變更', staleNos) && stale.length > 0) {
    // 上游變更是「作者需要知道但不會主動去翻」的那類事，進日誌才留得住。
    log.debug(`${stale.length} 章的上游產物有變更`, `${staleNos}｜耗時 ${Date.now() - startedAt}ms`);
  }
  return { rows, byNo, plots, chapters, manifest, outline, config };
}

/**
 * 第 N 章的正文：同號章節里路徑排序第一份。
 *
 * 同號有兩份時兩份都還在工程頁上（章節列表照常列出），只是流水線認第一份——
 * 作者看得見衝突，才能去改。它的細綱是這一份正文的映象（`NovelProject.plotFor`）。
 */
export function chapterOfPlotNo(chapters: Chapter[], no: number): Chapter | undefined {
  return chapters.find((c) => c.order === no);
}

/**
 * 第 N 章的正文該落在哪。**要讀盤**，所以不放進純函式 `pathOfTarget`。
 *
 * 同號章節已存在就用它（`exists: true`，落盤走追加）；否則**落在細綱所在的那個子目錄**
 * （`summaries/第二卷/010-雪夜.md` → `chapters/第二卷/010-雪夜.txt`），檔名沿用細綱的；細綱是
 * 還沒起名時建的純序號名（`030.md`）而標題已經有了，就按標題起 `030-<標題>.txt`，`plotRelPath`
 * 交給 `Workspace.createChapterAt` 把細綱改名到新正文的映象——兩邊從此按路徑認得出彼此。
 * 連細綱都沒有時跟上一章放在一起，`NNN-<標題>.txt`。正文一律出 `.txt`（2026-10-24 作者定的）。
 */
export async function chapterTargetOf(
  project: NovelProject,
  plotRelPath: string
): Promise<{ no: number; rel: string; exists: boolean; title: string; plotRelPath?: string }> {
  const no = parsePlotFileName(path.posix.basename(plotRelPath))?.no;
  if (no === undefined) {
    throw new Error(`認不出這份細綱的章號：${plotRelPath}`);
  }
  const existing = await project.getChapter(no);
  if (existing) {
    return { no, rel: existing.relPath, exists: true, title: existing.title };
  }
  const plot = await project.resolvePlot(plotRelPath);
  const title = plot?.title?.trim() ?? '';
  const stem = title ? sanitizeFileName(title) : '';
  const named = stem ? `${pad3(no)}-${stem}.txt` : `${pad3(no)}.txt`;
  const mirrored = plot ? project.chapterPathForPlot(plot.relPath) : undefined;
  if (plot && mirrored) {
    const keepName = !!parsePlotFileName(path.posix.basename(plot.relPath))?.stem.trim() || !stem;
    const rel = keepName ? mirrored : `${path.posix.dirname(mirrored)}/${named}`;
    return { no, rel, exists: false, title, plotRelPath: plot.relPath };
  }
  const dir = project.relPath(path.join(project.chaptersDir, await project.subdirForNewChapter(no)));
  return { no, rel: dir ? `${dir}/${named}` : named, exists: false, title };
}

/**
 * 全書狀態機要的事實（`deriveBookStage` / `deriveBookNextStep`）。
 *
 * **只有這一份**：創作頁的主按鈕（controller/chat.ts）、工程頁的全書階段
 * （views/projectView.ts）與給外部 agent 的狀態簡報（views/stateBrief.ts）都吃它
 * ——各取各的，介面上的主按鈕就會與 agent 說的下一步分叉（第 20 條）。
 */
export async function buildBookFacts(
  project: NovelProject,
  index?: PipelineIndex,
  known?: { characters?: CharacterCard[]; lore?: readonly LoreEntry[] }
): Promise<BookFacts> {
  const built = index ?? (await buildPipelineIndex(project));
  // 配置與章節在索引裡已經讀過；角色卡、設定條目呼叫方手上有就用它的（工程頁重新整理時已經列過一遍）。
  const settings = await project.settingFilled({
    config: built.config,
    chapters: built.chapters,
    characters: known?.characters,
    lore: known?.lore,
  });
  const nextChapterNo = nextWritableChapterNo(built.chapters);
  const nextPlot = project.plotFor(nextChapterNo, built.plots, built.chapters);
  const gap = chapterGapOf(built.chapters);
  return {
    settings,
    outlineFilled: isOutlineFilled(built.outline),
    outlineCoverage: outlineCoverage(built.outline),
    totalChapters: built.config.totalChapters,
    nextChapterNo,
    ...(gap ? { gap } : {}),
    nextPlotFilled: !!nextPlot && isPlotFilled(nextPlot.sections),
    plotFilledNos: project.pairPlots(built.plots, built.chapters).filter((p) => isPlotFilled(p.sections)).map((p) => p.no),
  };
}

/**
 * 下一個該寫的章：從第 1 章起**連續**有正文（字數 > 0）的最大章號 + 1。
 *
 * 空檔案不算寫過：作者新建了一個空章節佔位，主按鈕仍該說「寫這一章」。
 */
export function nextWritableChapterNo(chapters: Chapter[]): number {
  const written = new Set(chapters.filter((c) => c.wordCount > 0).map((c) => c.order));
  let n = 1;
  while (written.has(n)) {
    n++;
  }
  return n;
}

/**
 * 已寫的正文中間斷了一截：第 {@link nextWritableChapterNo} 章沒有正文，後面卻還有。
 * 缺口後面一章正文都沒有時 undefined——那只是還沒寫到。
 */
export function chapterGapOf(chapters: Chapter[]): ChapterGap | undefined {
  const from = nextWritableChapterNo(chapters);
  const later = [...new Set(chapters.filter((c) => c.wordCount > 0 && c.order > from).map((c) => c.order))].sort((a, b) => a - b);
  if (later.length === 0) {
    return undefined;
  }
  return { from, to: later[0] - 1, later: later.length, last: later[later.length - 1] };
}

/** 有不止一個檔案的章號（升序）：工程只按檔名開頭的數字認章，同號的幾個檔案會搶同一章。 */
export function duplicateChapterNos(chapters: Chapter[]): number[] {
  const seen = new Map<number, number>();
  for (const c of chapters) {
    seen.set(c.order, (seen.get(c.order) ?? 0) + 1);
  }
  return [...seen].filter(([, n]) => n > 1).map(([no]) => no).sort((a, b) => a - b);
}

/**
 * 流水線 → `deriveNextStep` 要的那幾個事實。
 *
 * **只有一份**：創作頁的主按鈕與 agent 每回合的狀態注入都吃它。看著只是個欄位
 * 搬運，其實帶著一條判據——正文寫到幾成（`manuscriptRatio`，與 `deriveStage` 同源）。
 *
 * 引數寫成結構型別而不是 `PlotPipeline`：資料層的 `PlotPipeline` 與線上的
 * `PlotPipelineView` 在這幾個欄位上同形，兩處呼叫共用一份。
 */
export function factsOf(p: {
  no: number;
  chapter: { words: number; targetWords?: number; upstreamStale: boolean };
}): NextStepFacts {
  const { words, targetWords, upstreamStale } = p.chapter;
  return {
    no: p.no,
    words,
    ratio: manuscriptRatio({ words, targetWords }),
    upstreamStale,
  };
}
