/**
 * 已寫的正文中間斷了一截（`ChapterGap`）：主按鈕那一步的說明框，以及補齊、重寫大綱動手之前的那句提醒。
 *
 * 工程只按檔名開頭的數字認章號，「寫到第幾章」是從第 1 章起連續有正文的那一截。匯入的原稿換過編號、
 * 一章拆成兩個檔案時，後面幾十章明明寫了，補齊與大綱卻只認得缺口前面那一截。這裡不改檔名
 * （改名由作者自己做），只把缺哪幾號、哪幾號重複說清楚。
 */
import { getHost } from '../host';
import { ChapterGap } from '../model/pipeline';
import { NovelProject } from '../model/project';
import { Chapter } from '../model/types';
import { chapterGapOf, duplicateChapterNos } from '../views/pipeline';

/** 說明框裡每個重複章號最多列幾個檔名、最多列幾個章號。 */
const DUPLICATE_LIST_LIMIT = 8;

function range(from: number, to: number): string {
  return from === to ? `第 ${from} 章` : `第 ${from}–${to} 章`;
}

/** 「第 25–31 章沒有正文，後面還有 51 章已寫（寫到第 82 章）。」 */
export function describeGap(gap: ChapterGap): string {
  return `${range(gap.from, gap.to)}沒有正文，後面還有 ${gap.later} 章已寫（寫到第 ${gap.last} 章）。`;
}

/** 同號的幾個檔案，一號一行。 */
function describeDuplicates(chapters: Chapter[]): string[] {
  const nos = duplicateChapterNos(chapters);
  const lines = nos.slice(0, DUPLICATE_LIST_LIMIT).map((no) => {
    const names = chapters.filter((c) => c.order === no).map((c) => c.relPath.split('/').pop());
    return `  第 ${no} 章：${names.join('、')}`;
  });
  if (nos.length > DUPLICATE_LIST_LIMIT) {
    lines.push(`  ……還有 ${nos.length - DUPLICATE_LIST_LIMIT} 個章號`);
  }
  return lines;
}

/** 主按鈕「第 N–M 章缺正文…」：不花錢，彈一個說明框。沒有缺口（剛改好名）時照實說。 */
export async function explainChapterGap(project: NovelProject): Promise<void> {
  project.invalidate();
  const chapters = await project.listChapters();
  const gap = chapterGapOf(chapters);
  if (!gap) {
    getHost().toast('章號已經連上了。', 'info');
    return;
  }
  const duplicates = describeDuplicates(chapters);
  const detail = [
    `工程只按檔名開頭的數字認章號，從第 1 章起連續有正文才算寫到那裡。照現在的編號，從已寫正文補齊與情節大綱只認得${gap.from > 1 ? range(1, gap.from - 1) : '前面那一截'}，第 ${gap.to + 1} 章以後會被當成沒寫過。`,
    ...(duplicates.length > 0
      ? ['', '下面這些章號不止一個檔案，會搶同一章（作話、設定、備份之類不是正文的，挪出章節目錄）：', ...duplicates]
      : []),
    '',
    '接上的辦法：在工程頁把章節檔案按順序重新編號（改檔名開頭的數字，一章一個號）；或者確實缺了這幾章，就把它們補寫出來。',
  ].join('\n');
  await getHost().confirm(describeGap(gap), ['知道了'], { modal: true, detail });
}

/**
 * 補齊、重寫大綱動手之前：章號斷了一截就先問一句，這一次只照缺口前面那一截做。
 * 沒有缺口返回 true；作者不點「仍然繼續」返回 false。
 */
export async function confirmDespiteGap(chapters: Chapter[], what: string): Promise<boolean> {
  const gap = chapterGapOf(chapters);
  if (!gap) {
    return true;
  }
  const through = gap.from - 1;
  const basis = through > 0 ? `只照${range(1, through)}做` : '一章正文都照不上';
  const pick = await getHost().confirm(describeGap(gap), ['仍然繼續'], {
    modal: true,
    detail:
      `${what}這一次${basis}，第 ${gap.to + 1} 章以後會被當成沒寫過——多半是檔名開頭的章號沒接上。` +
      '先把章號接上再來更好（主按鈕上的說明框裡列著缺哪幾號、哪幾號重複）。',
  });
  return pick === '仍然繼續';
}
