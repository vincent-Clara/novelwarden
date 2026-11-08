import { takeLast, type ContextLimits } from '../../model/contextDetail';
import { plotOfTarget, CreationTarget } from '../../model/pipeline';
import { Plot, isPlotFilled, parsePlotFileName } from '../../model/plotFile';
import { NovelProject } from '../../model/project';
import { Chapter } from '../../model/types';
import { BuildRequest, LayerId, LayerSpec } from '../types';
import { basename } from 'node:path';

/*
 * 寫/改某一章時前後各帶幾章**細綱**：按上下文詳細度（`prevPlots` / `nextPlots`，預設 3 / 1）。
 * 寫正文時前幾章細綱也走 `plotPrev`，更早的不帶（2026-10-21）。
 */
/**
 * 寫正文時往後看幾章的細綱（邊界）。移植自 AI-Novel-Writer 的「後續章節大綱預告」
 * （GD:464-466：`chapterNumber > N && chapterNumber <= N + 5`）——按章號算視窗，
 * 不是「後面排過的五章」：第 N+9 章的事離這一章太遠，寫進邊界只會讓模型分心。
 *
 * **不隨上下文詳細度變**：它是「不許提前寫」的邊界，生成層算「本章不出場」
 * （generation/generate.ts 的 `notYetOf`）用的也是這個視窗，兩邊必須一致。
 */
export const AHEAD_PLOTS = 5;

/**
 * 一章在裝配器眼裡的樣子：細綱與正文各有可能缺席。
 *
 * 必須兩邊都帶，否則老工程（只有 `chapters/`）裝配出來的上下文是空的——
 * 「前面發生了什麼」全靠 `chapter`，「這一章打算寫什麼」全靠 `plot`。
 */
export interface ChapterRef {
  no: number;
  title: string;
  /** 細綱。老工程裡那些從沒規劃過的章沒有。 */
  plot?: Plot;
  /** 正文。還沒寫的章沒有。 */
  chapter?: Chapter;
}

/** 一章正文的純文字（不含 `# 標題` 行）。 */
export interface ChapterText {
  relPath: string;
  text: string;
  wordCount: number;
  contentHash: string;
}

/** 這一次裝配圍繞哪個產物轉。 */
export interface Focus {
  target: CreationTarget;
  /** 目標章的細綱。尚未落盤時為 undefined（正要寫全書的下一章）。 */
  plot?: Plot;
  /** 「前文」的邊界章號。架構與大綱階段為 +∞，即全書都算前文。 */
  no: number;
  /**
   * 這一次覆蓋的章號區間：細綱批次是請求給的那一批，其餘落在某一章上的是 `{ from: no, to: no }`；不在哪一章上
   * （架構、大綱、單條設定）時缺席。拆細綱的 `threads` 層按它挑線（敘事線二期）——批次時 `plot` 是空的、`no` 只是
   * 區間第一章，只看 `no` 會把這一批後面幾章該收的伏筆漏掉。
   */
  range?: { from: number; to: number };
  /** 這一章之前的全部章，按章號升序。 */
  previous: ChapterRef[];
  /** 緊鄰的前幾章（`plotPrev` 用），按章號升序。 */
  prevPlots: ChapterRef[];
  /** 緊鄰的後一章（`plotNext` 用）。它已經排好時，本章的收尾要接得上它的開頭。 */
  nextPlots: ChapterRef[];
  /** 後 {@link AHEAD_PLOTS} 章裡排過細綱的（`plotAhead` 用），按章號升序。 */
  aheadPlots: ChapterRef[];
  /** 目標章自己的正文（「接著寫」要從它的末尾往下接）。還沒寫時缺席。 */
  chapter?: Chapter;
}

/** 按配方只讀用得上的檔案。前後帶幾章細綱按 `limits`（上下文詳細度）。 */
export async function resolveFocus(
  project: NovelProject,
  request: BuildRequest,
  recipe: LayerSpec[],
  limits: Pick<ContextLimits, 'prevPlots' | 'nextPlots'>
): Promise<Focus> {
  const wants = (id: LayerId): boolean => recipe.some((s) => s.layer === id);
  const target = request.target;
  const [plots, chapters] = await Promise.all([project.listPlots(), project.listChapters()]);

  // 一個章號一條：正文按號認，細綱按路徑配對（正文映象的那一份；還沒有正文的按號認計劃），
  // 與 views/pipeline.ts 同一條規則（`NovelProject.plotFor`）。老工程只有正文，新規劃的章只有細綱，
  // 正常走完流水線的章兩邊都有。
  const nos = [...new Set([...chapters.map((c) => c.order), ...plots.map((p) => p.no)])];
  const all: ChapterRef[] = nos
    .map((n) => {
      const chapter = chapters.find((c) => c.order === n);
      const plot = project.plotFor(n, plots, chapters);
      // 細綱的標題優先：它是作者在流水線裡給的那個名字。
      return { no: n, title: plot?.title || chapter?.title || '', ...(plot ? { plot } : {}), ...(chapter ? { chapter } : {}) };
    })
    .sort((a, b) => a.no - b.no);

  const plotRelPath = plotOfTarget(target);
  // 按這一章現在的那一份認（`NovelProject.resolvePlot`）：主按鈕給的落點可能是純序號的佔位路徑，
  // 而細綱已經按標題落成了 `003-雪夜.md`——認不出的話，寫正文時本章細綱那一層（P0 force）就空著。
  const plot = plotRelPath ? await project.resolvePlot(plotRelPath) : undefined;

  // 細綱批次（給了區間）：前文的邊界是區間第一章，後文從區間最後一章之後算起——
  // 區間裡那幾章正是這一次要寫的，既不是前文也不是後文。
  const range = target.kind === 'plot' ? request.range : undefined;
  // 架構、大綱與單條設定（展開）都不在哪一章上：全書都算前文。單條設定不能落到下面按 `targetNo` 定位那一支——
  // 對話頁發生成時總帶著一個章號，拿它當邊界，定稿記錄與相關設定就只看得到那一章之前的。
  const no =
    target.kind === 'outline' || target.kind === 'setting' || target.kind === 'lore'
      ? Number.POSITIVE_INFINITY
      : (range?.from ??
        plot?.no ??
        // 細綱還沒落盤時按路徑裡的章號定位——老工程選中某一章、拆細綱給下一章
        // 找落點都是這條路。
        (plotRelPath ? parsePlotFileName(basename(plotRelPath))?.no : undefined) ??
        request.targetNo ??
        Number.POSITIVE_INFINITY);
  const previous = all.filter((c) => c.no < no);
  // 後文只在這一章確實有定位時才有意義：`no` 是 +∞ 時「後面」是空的。
  const last = range?.to ?? no;
  const following = Number.isFinite(last) ? all.filter((c) => c.no > last) : [];

  return {
    target,
    plot,
    no,
    ...(Number.isFinite(no) ? { range: range ?? { from: no, to: no } } : {}),
    previous,
    // 「上文」只在有細綱時才有內容可帶（那一層渲染的是細綱的小節）。
    prevPlots: wants('plotPrev') ? takeLast(previous.filter((c) => c.plot), limits.prevPlots) : [],
    nextPlots: wants('plotNext') ? following.filter((c) => c.plot).slice(0, Math.max(0, limits.nextPlots)) : [],
    aheadPlots: wants('plotAhead')
      ? following.filter((c) => c.no <= last + AHEAD_PLOTS && c.plot && isPlotFilled(c.plot.sections))
      : [],
    chapter: Number.isFinite(no) ? all.find((c) => c.no === no)?.chapter : undefined,
  };
}

/**
 * 某一章的正文。沒寫過（或是空檔案）就是 undefined。
 *
 * 一章一綱之後正文只在 `chapters/` 一處——從前還要回落到中轉站 `manuscripts/`。
 */
export async function readChapterText(
  project: NovelProject,
  ref: ChapterRef
): Promise<ChapterText | undefined> {
  if (!ref.chapter) {
    return undefined;
  }
  const text = await project.readChapterText(ref.chapter);
  return text.trim()
    ? {
        relPath: ref.chapter.relPath,
        text,
        wordCount: ref.chapter.wordCount,
        contentHash: ref.chapter.contentHash,
      }
    : undefined;
}

/**
 * 前一章的正文。寫正文時要從它的結尾無縫接下去。
 *
 * 單獨一個函式而不是塞進 `Focus`：`prevTail` 與 `manuscriptFull` 兩層都要讀
 * 正文，而多數裝配（討論、排細綱）一份都不讀——放進 focus 等於每次裝配
 * 都多讀幾個幾千字的檔案。
 */
export async function readPrevManuscript(
  project: NovelProject,
  focus: Focus
): Promise<ChapterText | undefined> {
  const prev = focus.previous[focus.previous.length - 1];
  return prev ? readChapterText(project, prev) : undefined;
}
