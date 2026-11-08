/**
 * 匯出全文（2026-10-24）：把全部章節按章號拼成一份純文字，寫到工程根下的 `匯出/<書名>.txt`。**零呼叫。**
 *
 * 作者定的三條：
 * - **寫進工程目錄**，不彈另存為、不走瀏覽器下載——三個形態一個樣；重複匯出直接覆蓋（`Workspace.writeExport`）。
 * - **章標題寫成「第一章 楔子」**（漢字章號，網文 txt 最常見的寫法）；沒起名的章只寫「第一章」。
 *   標題本身已經是「第…章」開頭的（匯入的原稿常這樣起名）照原樣，不再套一層。
 * - 分了卷的書，進一卷之前單起一行卷名（卷 = 章節根下的一級目錄，更深的子目錄只是收納、不出行）。
 *
 * 開頭一行書名（`《書名》`，manifest 裡的作品名，沒有就用目錄名），有作者名再起一行。正文照磁碟上的原樣（markdown
 * 正文去掉 `# 標題` 行），沒有正文的章不放進去、在提示裡說一句。讀的是磁碟：編輯器裡沒儲存的改動不在裡面。
 */
import * as path from 'node:path';
import { getHost } from '../host';
import { countWords, sanitizeFileName } from '../model/fs';
import { isFallbackChapterTitle } from '../model/pipeline';
import { NovelProject } from '../model/project';
import { cnNumber } from '../model/timelineFile';
import { Chapter } from '../model/types';
import { scoped } from '../runtime/logger';
import { Workspace } from '../workspace';
import { formatWordCount } from './bookText';

const log = scoped('匯出');

/** 標題已經帶著章號（「第一章 楔子」「第12回」）：照原樣當標題行。 */
const NUMBERED_TITLE = /^第\s*[0-9０-９〇零一二两三四五六七八九十百千万兩萬]+\s*[章回节卷節]/u;

/** 「第一章 楔子」；沒起名的章只有「第一章」。 */
export function exportHeading(chapter: Pick<Chapter, 'order' | 'title'>): string {
  const title = isFallbackChapterTitle(chapter.order, chapter.title) ? '' : chapter.title.trim();
  if (NUMBERED_TITLE.test(title)) {
    return title;
  }
  const no = `第${cnNumber(chapter.order)}章`;
  return title ? `${no} ${title}` : no;
}

/** 這一章所在的卷（章節根下的一級目錄名）；直接放在章節根下的是 `''`。 */
function volumeOf(project: NovelProject, chapter: Chapter): string {
  const under = path.relative(project.chaptersDir, project.pathOf(chapter.relPath)).replace(/\\/g, '/');
  const parts = under.split('/');
  return parts.length > 1 && parts[0] !== '..' ? parts[0] : '';
}

/** 書名：manifest 裡的作品名，沒有（或還是預設的「未命名」）就用目錄名。 */
function bookTitleOf(project: NovelProject, manifestTitle: string): string {
  const title = manifestTitle.trim();
  return title && title !== '未命名' ? title : path.basename(project.root) || '未命名';
}

export interface ExportResult {
  /** 寫到哪了（工作區相對路徑）。 */
  rel: string;
  /** 放進去幾章。 */
  chapters: number;
  /** 沒有正文、沒放進去的章數。 */
  skipped: number;
}

/** 工程頁章節組右鍵「匯出全文（txt）」。沒有章節、全是空章時只提示，不寫檔案。 */
export async function exportBookText(project: NovelProject): Promise<ExportResult | undefined> {
  project.invalidate();
  const chapters = await project.listChapters();
  if (chapters.length === 0) {
    getHost().toast('還沒有章節，沒有可匯出的。', 'error');
    return undefined;
  }

  const manifest = await project.readManifest();
  const title = bookTitleOf(project, manifest.title);
  const blocks: string[] = [`《${title}》`];
  if (manifest.author.trim()) {
    blocks[0] += `\n作者：${manifest.author.trim()}`;
  }

  let volume = '';
  let exported = 0;
  let skipped = 0;
  let words = 0;
  for (const chapter of chapters) {
    const body = (await project.readChapterText(chapter)).replace(/\r\n?/g, '\n').trim();
    if (!body) {
      skipped++;
      continue;
    }
    const v = volumeOf(project, chapter);
    if (v && v !== volume) {
      blocks.push(v);
    }
    volume = v;
    blocks.push(`${exportHeading(chapter)}\n\n${body}`);
    exported++;
    words += countWords(body);
  }
  if (exported === 0) {
    getHost().toast(`${chapters.length} 章都還沒有正文，沒有可匯出的。`, 'error');
    return undefined;
  }

  const rel = await new Workspace(project).writeExport(
    `${project.relPath(project.exportDir)}/${sanitizeFileName(title)}.txt`,
    `${blocks.join('\n\n')}\n`
  );
  log.info(`匯出全文 ${exported} 章`, `${rel}｜${formatWordCount(words)}${skipped > 0 ? `｜跳過 ${skipped} 章空章` : ''}`);
  getHost().toast(
    `已匯出全文：${rel}（${exported} 章，${formatWordCount(words)}）${skipped > 0 ? `；${skipped} 章沒有正文，沒放進去` : ''}`
  );
  return { rel, chapters: exported, skipped };
}
