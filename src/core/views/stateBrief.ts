/**
 * 狀態簡報：**外部 agent 與介面說同一套話**（第 20 條）。
 *
 * ```
 * # 當前工程
 * 《青雲志》· 已寫 99 章 · 31.2 萬字（計劃 300 章）
 * 當前目標：第 100 章（.novelwarden/summaries/100.md）
 * 狀態：待寫細綱
 * 下一步（由狀態機算出，不要另做判斷）：寫第 100 章細綱
 *   先把這一章要發生什麼定下來：梗概、出場人物、關鍵事件、看點。
 * 提醒：第 12、13 章的上游產物改過（⟳）
 * ```
 *
 * **判據一個都不在這裡重新實現**：`buildPipelineIndex` 取數、`deriveStage` /
 * `deriveNextStep` / `deriveBookStage` 判斷，與創作頁主按鈕吃的是同一份輸出。
 * 兩處各判各的，介面上就會出現「徽章說待寫細綱，agent 讓你寫正文」——而那種分叉
 * 沒有任何測試攔得住，只會讓作者不再相信介面。
 *
 * MCP server 把它貼在工具結果末尾，變了才貼（[mcp/server.ts](../mcp/server.ts)）。
 */
import type { NovelProject } from '../model/project';
import { basename } from 'node:path';
import {
  CreationTarget,
  NextStepPlan,
  PLOT_STAGE_LABEL,
  chapterLabel,
  deriveBookNextStep,
  deriveBookStage,
  deriveNextStep,
  describeTarget,
  plotOfTarget,
} from '../model/pipeline';
import { parsePlotFileName } from '../model/plotFile';
import { parseChapterFileName } from '../model/chapterFile';
import { BookFacts } from '../model/pipeline';
import { buildBookFacts, buildPipelineIndex, buildPlotPipeline, factsOf } from './pipeline';
import type { PipelineIndex, PlotPipeline } from './pipeline';

/** 「⟳ 上游改過」最多點名幾章，超了寫「等 N 章」。 */
export const STALE_LIST_LIMIT = 5;

/**
 * 拼一份「現在這本書走到哪了」。**只取數，判斷全在 `model/pipeline.ts`。**
 *
 * `target` 沒指向某一章（作者還在架構或大綱那一層）時報全書那一層的下一步——
 * 與創作頁主按鈕在那兩層顯示的是同一句話。選中的那一章做完了也轉去問全書，
 * 主按鈕與這裡於是一起落到下一個該寫的章上（controller/chat.ts 的 `pushPipeline`
 * 是同一條路）。
 *
 * 代價是一次 `buildPipelineIndex`，與工程頁重新整理同一趟活。MCP 每次工具呼叫之後
 * 都現算一份：作者可能正在另一個視窗裡改檔案——照著一份舊快照往下走，比多讀一次
 * 盤糟得多。
 */
export async function buildStateBrief(
  project: NovelProject,
  target?: CreationTarget
): Promise<string> {
  const index = await buildPipelineIndex(project);
  const { rows, chapters, manifest, config } = index;
  const facts = await buildBookFacts(project, index);

  const written = chapters.filter((c) => c.wordCount > 0);
  const words = written.reduce((sum, c) => sum + c.wordCount, 0);
  const lines: string[] = ['# 當前工程'];
  lines.push(
    `《${manifest.title || '未命名'}》· 已寫 ${written.length} 章 · ${formatWords(words)}` +
      (config.totalChapters ? `（計劃 ${config.totalChapters} 章）` : '')
  );

  const current = target ? await findPipeline(project, index, target) : undefined;
  if (current) {
    const where = current.plot.exists ? current.plot.relPath : current.chapter.relPath || current.plot.relPath;
    lines.push(`當前目標：${chapterLabel(current.no, current.title)}（${where}）`);
    lines.push(`狀態：${PLOT_STAGE_LABEL[current.stage]}`);
    const next = deriveNextStep(current.stage, factsOf(current));
    lines.push(
      ...(next
        ? describeNext(next, '')
        : describeNext(bookStep(index, facts), '全書都寫完了。需要改動的話作者會說。').map((l, i) =>
            i === 0 ? `這一章都做完了。${l}` : l
          ))
    );
  } else {
    lines.push(currentTargetLine(target));
    lines.push(...describeNext(bookStep(index, facts), '全書都寫完了。需要改動的話作者會說。'));
  }

  const stale = rows.filter((p) => p.plot.upstreamStale || p.chapter.upstreamStale);
  if (stale.length > 0) {
    const named = stale.slice(0, STALE_LIST_LIMIT).map((p) => `第 ${p.no} 章`).join('、');
    const rest = stale.length > STALE_LIST_LIMIT ? `等 ${stale.length} 章` : '';
    lines.push(`提醒：${named}${rest}的上游產物改過，現有內容可能已經對不上（⟳）`);
  }
  return lines.join('\n');
}

/** 不在某一章上時「當前目標」那一行：架構、大綱，或者一條設定（展開，完善設定 2026-10-19，帶上它的路徑）。 */
function currentTargetLine(target?: CreationTarget): string {
  switch (target?.kind) {
    case 'setting':
      return '當前目標：故事架構';
    case 'outline':
      return '當前目標：情節大綱';
    case 'lore':
      return `當前目標：${describeTarget(target)}（${target.relPath}）`;
    default:
      return '當前目標：還沒選定某一章';
  }
}

/**
 * 全書級的下一步：架構 / 大綱 / 拆細綱三檔由純函式直接給；「在寫」那一檔轉去問
 * 下一個該寫的章。與 controller/chat.ts 的 `bookNextStep` 同一條判據。
 */
function bookStep(index: PipelineIndex, facts: BookFacts): NextStepPlan | undefined {
  const stage = deriveBookStage(facts);
  const step = deriveBookNextStep(stage, facts);
  if (step || stage !== 'writing') {
    return step;
  }
  const chapter = index.byNo.get(facts.nextChapterNo);
  return chapter ? deriveNextStep(chapter.stage, factsOf(chapter)) : undefined;
}

/**
 * 「下一步」那兩行。**label 與 hint 逐字來自狀態機**，不在這裡改寫措辭——
 * 介面上的主按鈕寫著「寫第 12 章」，agent 卻說「去擴寫第 12 章」，作者會以為
 * 它們是兩件事。
 *
 * 狀態機不給下一步時**照實說**（第 20 條：做完了就不給下一步）。造一個假的
 * 出來，agent 會自作主張挑一章開始燒錢。
 */
function describeNext(next: { label: string; hint: string } | undefined, done: string): string[] {
  if (!next) {
    return [`下一步：${done}`];
  }
  return [`下一步（由狀態機算出，不要另做判斷）：${next.label}`, `  ${next.hint}`];
}

/**
 * target → 那一章的流水線。**按章號認**（細綱號 = 章號），與 `selectPlot` 同一條判據：
 * target 裡記的可能是一份還不存在的細綱（點了「拆細綱 / 寫第 N 章細綱」之後會話裡的
 * 就是這種），也可能是章節路徑。
 *
 * 索引裡只有「有細綱或正文檔案」的章號。**不在索引裡的章也要給一份空殼**——與
 * `buildPlotPipelineView` 同一條路：否則作者剛點了主按鈕、會話落在第 2 章那份還不存在的
 * 細綱上，介面說「寫第 2 章細綱」，agent 這裡卻說「還沒選定某一章」（第 20 條）。
 */
async function findPipeline(
  project: NovelProject,
  index: PipelineIndex,
  target: CreationTarget
): Promise<PlotPipeline | undefined> {
  const rel = plotOfTarget(target);
  if (!rel) {
    return undefined;
  }
  const no = parsePlotFileName(basename(rel))?.no ?? parseChapterFileName(basename(rel))?.order;
  if (no === undefined) {
    return undefined;
  }
  return (
    index.byNo.get(no) ??
    buildPlotPipeline(project, { no }, { config: index.config, chapters: index.chapters })
  );
}

function formatWords(words: number): string {
  return words >= 10000 ? `${(words / 10000).toFixed(1)} 萬字` : `${words} 字`;
}
