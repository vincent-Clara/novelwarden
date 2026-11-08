/**
 * 匯入原稿（拆書 A 的前一半）：把作者自己寫好的一整本 txt 切成 `chapters/NNN-标题.txt`。**零呼叫。**
 *
 * 借鑑 AI-Novel-Writer 的「作者原稿匯入」（`import-workflow.ts:515-559`）：上游導進來直接當定稿，
 * 再逐章跑定稿後處理。這裡只落章節——細綱、角色卡、設定、大綱是「從已寫正文補齊」
 * （features/derive.ts）的事，要調模型，確認框得另外報次數（第 4 條）。匯入完問一句要不要接著補。
 *
 * - **接在已有章節之後**，章號按順序重編（原書的「第一百章」不保留——一條軸，第 8 條）。
 * - **不覆蓋**：`createChapter` 同名一律報錯（第 3 條），撞上就停在那一章，前面匯入的留著。
 * - 切的結果在確認框裡給作者看（開頭幾章、結尾一章、丟掉了什麼）；切得不對就改 txt 再來，不提供手調。
 * - 歡迎頁「匯入寫好的書」（2026-10-24）先 {@link inspectBookFile} 看切得出幾章，把同一份說明擺在表單上，作者點了
 *   「匯入」才建工程，建好再帶著那本書的絕對路徑（`hostPath`）來這裡——表單就是那一問，這裡不再問第二遍。
 */
import { readConfig } from '../config';
import { getHost } from '../host';
import { NovelProject } from '../model/project';
import type { BookInspection } from '../protocol';
import { ENCODING_LABEL, SplitChapter, SplitResult, splitChapters } from '../model/importText';
import { describeError, elapsed, scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { Workspace } from '../workspace';
import { BookText, formatWordCount, pickBookText, readBookFile, readBookText } from './bookText';
import { checkpointBefore } from './checkpoint';
import { deriveFromText } from './derive';

const log = scoped('匯入');

export interface ImportOutcome {
  /** 新建了幾章。 */
  imported: number;
  /** 接著「從已寫正文補齊」調了幾次模型（作者沒接著補就是 0）。 */
  calls: number;
}

const NONE: ImportOutcome = { imported: 0, calls: 0 };

export interface ImportOptions {
  /** MCP 的 `book` 工具給的工程內相對路徑：只認工程裡能拆的 txt（`pickBookText`）。 */
  path?: string;
  /**
   * 歡迎頁「匯入寫好的書」：作者在本機選的那本的絕對路徑。給了就不彈選擇器，也不再問切分結果——
   * 歡迎頁的表單上已經擺過同一份說明（{@link inspectBookFile}），作者點了「匯入」才走到這裡。
   */
  hostPath?: string;
}

/** 認不出章標題時說的話：確認框之前的 toast 與歡迎頁的表單同一句。 */
function noHeadingsText(title: string): string {
  return `《${title}》裡認不出章節標題。每章開頭要有單獨一行的標題，如「第一章 雪夜」「第12章」「楔子」，改好再匯入。`;
}

/** 認出幾章、匯入成第幾章、丟掉了什麼——確認框與歡迎頁的表單同一份。 */
function describeSplit(
  book: BookText,
  split: SplitResult,
  start: number,
  existing: number,
  chaptersDir: string
): { headline: string; detail: string[] } {
  const chapters = split.chapters;
  const end = start + chapters.length - 1;
  const words = chapters.reduce((s, c) => s + c.words, 0);
  const where = start === end ? `第 ${start} 章` : `第 ${start}–${end} 章`;
  return {
    headline: `從《${book.title}》認出 ${chapters.length} 章（${formatWordCount(words)}），匯入為${where}`,
    detail: [
      `檔案：${book.shown}（${ENCODING_LABEL[book.encoding]}）。`,
      `開頭：${chapters.slice(0, 3).map((c, i) => describe(start + i, c)).join('；')}${chapters.length > 3 ? '……' : ''}`,
      chapters.length > 3 ? `結尾：${describe(end, chapters[chapters.length - 1])}。` : '',
      split.preface.words > 0 ? `第一個章標題之前的 ${split.preface.words} 字（「${split.preface.head}」）不匯入。` : '',
      split.volumes.length > 0 ? `${split.volumes.length} 行卷標題（${split.volumes.slice(0, 2).join('、')}${split.volumes.length > 2 ? '……' : ''}）不算章，丟掉。` : '',
      split.empty.length > 0 ? `${split.empty.length} 個標題下面沒有正文（多半是目錄），跳過。` : '',
      existing > 0 ? `工程裡已經有 ${existing} 章，接在第 ${start - 1} 章之後。` : '',
      `每章新建一個 ${chaptersDir}/NNN-标题.txt，一段一行、去掉行首的空格；原 txt 不動。同名檔案已經在就停下，不覆蓋。`,
      '切得不對？改 txt 裡的章標題（每章開頭單獨一行，如「第一章 雪夜」）再匯入一次。',
    ].filter(Boolean),
  };
}

/** 歡迎頁「匯入寫好的書」挑好一本之後、建工程之前看一眼：切得出幾章、導進新工程是什麼樣。不寫任何檔案。 */
export async function inspectBookFile(abs: string): Promise<BookInspection> {
  let book: BookText;
  try {
    book = await readBookFile(abs);
  } catch (err) {
    return { path: abs, title: '', chapters: 0, detail: [], error: describeError(err) };
  }
  const split = splitChapters(book.text);
  if (split.chapters.length === 0) {
    return { path: abs, title: book.title, chapters: 0, detail: [], error: noHeadingsText(book.title) };
  }
  // 新工程：從第 1 章起，沒有已有的章；章節目錄取設定裡的（建工程時就用它）。
  const { headline, detail } = describeSplit(book, split, 1, 0, readConfig().chaptersDir);
  return { path: abs, title: book.title, chapters: split.chapters.length, headline, detail };
}

export async function importManuscript(project: NovelProject, opts: ImportOptions = {}): Promise<ImportOutcome> {
  const source = opts.hostPath ?? (await pickBookText(project, '匯入原稿：選一本 txt', opts.path));
  if (!source) {
    return NONE;
  }
  let book;
  try {
    book = await readBookText(project, source);
  } catch (err) {
    getHost().toast(describeError(err), 'error');
    return NONE;
  }
  const split = splitChapters(book.text);
  if (split.chapters.length === 0) {
    log.warn(`《${book.title}》裡認不出章節標題，沒有匯入`, book.shown);
    getHost().toast(noHeadingsText(book.title), 'error');
    return NONE;
  }

  const existing = await project.listChapters();
  const start = existing.length === 0 ? 1 : Math.max(...existing.map((c) => c.order)) + 1;
  const chapters = split.chapters;
  const { headline, detail } = describeSplit(book, split, start, existing.length, project.config.chaptersDir);
  if (opts.hostPath === undefined) {
    const pick = await getHost().confirm(`${headline}？這一步不呼叫模型。`, ['匯入'], {
      modal: true,
      detail: detail.join('\n'),
    });
    if (pick !== '匯入') {
      log.info('作者取消了匯入原稿');
      return NONE;
    }
  }

  const ws = new Workspace(project);
  let imported = 0;
  let stopped: string | undefined;
  await runTask(
    '匯入原稿',
    async ({ signal, report }) => {
      // 先存一個存檔點（features/checkpoint.ts）：一次建很多章，整本退得回去。
      await checkpointBefore(project, '匯入原稿之前');
      const startedAt = Date.now();
      report({ message: describe(start, chapters[0]), current: 0, total: chapters.length });
      try {
        // 一批建：每一章照樣過閘道器（同名報錯、大小上限），manifest 最後同步一次。
        await ws.createChapters(
          chapters.map((c, i) => ({ order: start + i, title: c.title, content: c.body })),
          {
            signal,
            onEach: (_rel, i) => {
              imported = i + 1;
              if (i + 1 < chapters.length) {
                report({ message: describe(start + i + 1, chapters[i + 1]), current: i + 1, total: chapters.length });
              }
            },
          }
        );
        if (imported < chapters.length) {
          stopped = `被取消，停在第 ${start + imported} 章前面`;
        }
      } catch (err) {
        stopped = `第 ${start + imported} 章沒寫進去（${describeError(err)}）`;
        log.error(`匯入原稿停在第 ${start + imported} 章`, describeError(err));
      }
      project.invalidate();
      report({ message: '收尾', current: chapters.length, total: chapters.length });
      log.info(`匯入原稿：《${book.title}》${imported}/${chapters.length} 章`, `${book.shown}｜用時 ${elapsed(startedAt)}`);
    },
    { scope: '匯入' }
  );

  const done = imported === 0 ? '' : imported === 1 ? `第 ${start} 章` : `第 ${start}–${start + imported - 1} 章`;
  if (stopped) {
    getHost().toast(`${done ? `已匯入${done}；` : ''}${stopped}。`, 'error');
    return { imported, calls: 0 };
  }
  // 還沒配模型（剛上手的多半如此）：補齊要調模型，問了也走不下去——說清先做什麼，不彈一個點了就報錯的框。
  if (!readConfig().active) {
    getHost().toast(
      `已匯入${done}。要照正文整理出細綱、角色卡、設定與劇情線，先到「設定」配一個模型，再點對話頁的主按鈕「從已寫正文補齊」。`
    );
    return { imported, calls: 0 };
  }
  const next = await getHost().confirm(
    `已匯入${done}。接著從已寫正文補齊細綱、角色卡、設定與情節大綱？`,
    ['接著補齊'],
    {
      modal: true,
      detail:
        '這一步要調模型：先報整理細綱要調幾次，細綱出來之後再報其餘幾樣，每一次都可以不同意。\n' +
        '也可以以後在工程頁「故事架構」那一組點「從已寫正文補齊」，或者點創作頁的主按鈕。',
    }
  );
  if (next !== '接著補齊') {
    return { imported, calls: 0 };
  }
  return { imported, calls: await deriveFromText(project) };
}

/** 「第 3 章《雪夜》（原文「第三章 雪夜」，3200 字）」。 */
function describe(no: number, c: SplitChapter): string {
  return `第 ${no} 章${c.title ? `《${c.title}》` : ''}（原文「${c.heading}」，${c.words} 字）`;
}
