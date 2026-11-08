/**
 * 內建編輯器的章節索引（`chapterIndex` 訊息）：章節條與上一章 / 下一章要的那幾個欄位。
 *
 * 與工程樹裡章節那一行（`ProjectPlotNode`）**由同一個函式算**——`projectView.ts` 在它上面再加定稿、
 * 草稿、⟳ 那幾項。兩處各寫一份的話，章節條上說的「待定稿 · 2980 / 3000 字」遲早會與工程頁對不上。
 *
 * 資料來自流水線索引（`buildPipelineIndex`）：controller 每次 `pushState` 構建 `ViewState` 時本來就要
 * 跑這一趟（目標下拉框），章節索引只是從同一份 rows 裡多投影幾個欄位，不多讀一次盤。
 */
import { chapterLabel } from '../model/pipeline';
import type { ChapterIndexEntry } from '../protocol';
import type { PlotPipeline } from './pipeline';

/** 一章的那一行。 */
export function chapterIndexEntryOf(p: PlotPipeline): ChapterIndexEntry {
  const chapterPath = p.chapter.relPath;
  return {
    no: p.no,
    label: chapterLabel(p.no, p.title),
    title: p.title,
    relPath: chapterPath || p.plot.relPath,
    plotPath: p.plot.relPath,
    plotExists: p.plot.exists,
    chapterPath,
    wordCount: p.chapter.words,
    targetWords: p.chapter.targetWords,
    stage: p.stage,
  };
}

/** 全書的章節索引，按章號升序（流水線索引本來就是升序）。 */
export function chapterIndexOf(rows: readonly PlotPipeline[]): ChapterIndexEntry[] {
  return rows.map(chapterIndexEntryOf);
}
