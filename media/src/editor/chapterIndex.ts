/**
 * 編輯器的章節索引：章節條與上一章 / 下一章都從這裡取「有哪幾章、各自的正文與細綱在哪、寫到哪一步」。
 *
 * 資料來自後端的 `chapterIndex` 訊息——**哪個頁籤都推**、內容變了才推（`controller/index.ts` 的
 * `pushChapterIndex`）。從前章節條只吃工程樹（`project` 訊息），而工程樹只在「工程」頁籤開著時才推：
 * 作者待在對話頁時條上的字數與狀態是舊的，從沒開啟過工程頁時乾脆沒有資料。
 *
 * 章節順序就是索引的順序：後端按章號升序排好（第 8 條：檔名數字字首決定順序，與目錄層級無關）。
 */
import type { ChapterIndexEntry } from '../protocol';
import { onMessage } from '../vscodeApi';

/** 一份檔案是某一章的哪一面。 */
export type ChapterSide = 'chapter' | 'plot';

export const SIDE_LABEL: Record<ChapterSide, string> = { chapter: '正文', plot: '細綱' };

let chapters: ChapterIndexEntry[] = [];
const listeners = new Set<() => void>();

/** 裝一次（`index.ts`）：收 `chapterIndex`，換工程時清空。 */
export function installChapterIndex(): void {
  onMessage((msg) => {
    if (msg.type === 'chapterIndex') {
      chapters = Array.isArray(msg.chapters) ? msg.chapters : [];
      notify();
    }
  });
  window.addEventListener('nf-workspace-reset', () => {
    chapters = [];
    notify();
  });
}

/** 全書的章節，按章號升序。 */
export function chapterIndex(): readonly ChapterIndexEntry[] {
  return chapters;
}

/** 章節索引變了時通知（章節條重畫）。 */
export function onChapterIndex(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  for (const fn of [...listeners]) {
    fn();
  }
}

/** 這個路徑是哪一章的正文或細綱（別的檔案——角色卡、大綱、草稿——不算）。 */
export function chapterAt(path: string): { entry: ChapterIndexEntry; side: ChapterSide; index: number } | undefined {
  const index = chapters.findIndex((c) => (c.chapterPath && c.chapterPath === path) || (c.plotExists && c.plotPath === path));
  if (index < 0) {
    return undefined;
  }
  const entry = chapters[index];
  return { entry, side: entry.chapterPath === path ? 'chapter' : 'plot', index };
}

/** 這一章這一面的檔案路徑；還沒有（沒寫正文、沒排細綱）時是空串。 */
export function pathOn(entry: ChapterIndexEntry, side: ChapterSide): string {
  return side === 'chapter' ? entry.chapterPath : entry.plotExists ? entry.plotPath : '';
}

export function flipSide(side: ChapterSide): ChapterSide {
  return side === 'chapter' ? 'plot' : 'chapter';
}
