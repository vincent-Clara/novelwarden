import * as path from 'node:path';
import { parseChapterFileName } from '../model/chapterFile';
import { exists } from '../model/fs';
import { SETTING_DOC_LABEL, isFallbackChapterTitle } from '../model/pipeline';
import { NovelProject } from '../model/project';
import { FIXED_DOC_LABEL, describeEditorFile } from './editorLabel';
import type {
  QuickOpenChapter,
  QuickOpenDoc,
  QuickOpenDocKey,
  QuickOpenDraft,
  QuickOpenIndex,
} from '../protocol';

/**
 * 「轉到…」（獨立版 Ctrl+P）的索引：章節、角色卡、設定條目、架構幾件與大綱 / 文風 / 敘事線 / 全文大綱、草稿。
 *
 * **按需要**：面板開啟時前端要一次（`requestQuickOpen`），不進每次檔案變動都重推的工程樹。匹配與排序在前端
 * （`media/src/editor/quickOpenCore.ts`），這裡只給一份平鋪的清單。
 *
 * ## 讀了哪些盤
 *
 * 幾百章的工程也要快，所以**不為索引多讀任何一章**，能借的快取都借：
 *
 * - **章節與細綱**：`NovelProject.listChapters()` / `listPlots()`。這兩份列表在工程上快取著（每次 `pushState`
 *   重算 `ViewState` 時就填上了，作者按 Ctrl+P 時幾乎總是熱的）——熱的時候這一步**零讀盤**；冷的時候各遞迴
 *   掃一遍 `chapters/` 與 `.novelwarden/summaries/`、每個檔案讀一次（與工程頁同一趟，之後的人搭這一班車）。
 * - **角色卡**：遞迴列 `.novelwarden/characters/`，每張卡讀一次（要 frontmatter 裡的名字與別名）。
 * - **設定條目**：遞迴列 `.novelwarden/lore/`，每條讀一次（要標題）。
 * - **草稿**：遞迴列 `drafts/`，**只列不讀**。
 * - **架構幾件與大綱 / 文風 / 敘事線 / 全文大綱**：七個固定路徑各 `stat` 一次，有檔案的才列。
 *
 * 不讀大綱、配置、manifest 的內容，也不算流水線狀態——「轉到」只要認得出是哪一章、在哪個檔案。
 */
export async function buildQuickOpenIndex(project: NovelProject): Promise<QuickOpenIndex> {
  if (!(await project.isInitialized())) {
    return { initialized: false, chapters: [], characters: [], lore: [], docs: [], drafts: [] };
  }
  const [chapters, plots, characters, lore, draftPaths, docs] = await Promise.all([
    project.listChapters(),
    project.listPlots(),
    project.listCharacters(),
    project.listLore(),
    project.listDraftPaths(),
    listDocs(project),
  ]);

  const chaptersRoot = project.relPath(project.chaptersDir);
  const plotsRoot = project.relPath(project.plotsDir);
  // 第一份正文按章號認（同號兩份取路徑排序第一份，與流水線同一個口徑）。按號建一張表，幾百章也不必每章掃一遍。
  const chapterOf = new Map<number, (typeof chapters)[number]>();
  for (const chapter of chapters) {
    if (!chapterOf.has(chapter.order)) {
      chapterOf.set(chapter.order, chapter);
    }
  }
  const nos = [...new Set([...chapterOf.keys(), ...plots.map((p) => p.no)])].sort((a, b) => a - b);
  const chapterRows: QuickOpenChapter[] = nos.map((no) => {
    const chapter = chapterOf.get(no);
    // 細綱按路徑配對（`NovelProject.plotFor`）：有正文只認它映象的那一份，沒有正文按號認計劃。
    const plot = project.plotFor(no, plots, chapters);
    const title = plot?.title || (chapter && !isFallbackChapterTitle(no, chapter.title) ? chapter.title : '');
    return {
      no,
      title,
      volume: chapter ? volumeOf(chapter.relPath, chaptersRoot) : plot ? volumeOf(plot.relPath, plotsRoot) : '',
      ...(chapter ? { chapterPath: chapter.relPath } : {}),
      ...(plot ? { plotPath: plot.relPath } : {}),
      words: chapter?.wordCount ?? 0,
    };
  });

  const drafts: QuickOpenDraft[] = [...draftPaths].sort((a, b) => a.localeCompare(b)).map((rel) => {
    const name = path.posix.basename(rel);
    const no = parseChapterFileName(name)?.order;
    return { path: rel, name, ...(no !== undefined ? { no } : {}) };
  });

  return {
    initialized: true,
    chapters: chapterRows,
    characters: characters.map((c) => ({ name: c.name, aliases: [...c.aliases], path: c.relPath })),
    lore: lore.map((e) => ({ title: e.title, path: e.relPath })),
    docs,
    drafts,
  };
}

/**
 * 架構三件、情節大綱、文風、敘事線、全文大綱：有檔案的才列，按這個順序（「故事架構」組在前）。情節大綱沒有檔案
 * （各章細綱梗概的彙總），總是列。敘事線一條線一個檔案
 * （`threads/<線名>.md`），一條一項，名字是線名（與編輯器標籤同一個叫法），型別標記由前端按 `key` 寫「敘事線」；
 * 「未歸屬的伏筆」排在各條線後面。
 */
async function listDocs(project: NovelProject): Promise<QuickOpenDoc[]> {
  const candidates: { key: QuickOpenDocKey; label: string; abs: string }[] = [
    { key: 'config', label: SETTING_DOC_LABEL.config, abs: project.configPath },
    { key: 'premise', label: SETTING_DOC_LABEL.premise, abs: project.premisePath },
    { key: 'world', label: SETTING_DOC_LABEL.world, abs: project.worldPath },
    // 稱呼與內建編輯器的標籤、麵包屑共用一張表（`views/editorLabel.ts`），同一份檔案不叫兩個名字。
    { key: 'outline', label: FIXED_DOC_LABEL.outline, abs: project.outlinePath },
    { key: 'style', label: FIXED_DOC_LABEL.style, abs: project.stylePath },
  ];
  const tail: { key: QuickOpenDocKey; label: string; abs: string }[] = [
    { key: 'globalSummary', label: FIXED_DOC_LABEL.globalSummary, abs: project.globalSummaryPath },
  ];
  const present = await Promise.all([...candidates, ...tail].map((c) => (c.key === 'outline' ? true : exists(c.abs))));
  const pick = (list: typeof candidates, offset: number): QuickOpenDoc[] =>
    list.filter((_, i) => present[offset + i]).map((c) => ({ key: c.key, label: c.label, path: project.relPath(c.abs) }));
  const threads: QuickOpenDoc[] = (await project.listThreadPaths()).map((rel) => ({
    key: 'threads',
    label: describeEditorFile(project, rel).title,
    path: rel,
  }));
  return [...pick(candidates, 0), ...threads, ...pick(tail, candidates.length)];
}

/**
 * 卷目錄：檔案在 `root` 下那段相對路徑的目錄部分（`第一卷`、`第一卷/上`），根下是空串。
 * `root` 是空串（章節根配成了工程根）時整個相對路徑都算。敘事線總覽的列頭（`threads.ts`）也用它標卷名。
 */
export function volumeOf(relPath: string, root: string): string {
  const under = root === '' ? relPath : relPath.startsWith(`${root}/`) ? relPath.slice(root.length + 1) : undefined;
  if (under === undefined) {
    return '';
  }
  const dir = path.posix.dirname(under);
  return dir === '.' ? '' : dir;
}
