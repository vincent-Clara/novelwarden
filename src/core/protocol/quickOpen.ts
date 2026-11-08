/**
 * 「轉到…」（獨立版內建編輯器的 Ctrl+P 快速開啟）要的那份索引。
 *
 * 面板開啟時前端發 `requestQuickOpen`，後端回 `quickOpenIndex`（同一個 `requestId`）——**按需要，不常駐推送**：
 * 這份東西只在作者按下 Ctrl+P 的那一刻有用，塞進每次檔案變動都全量重推的 `ProjectTree` / `ViewState`
 * 等於每儲存一次就白推一遍。面板開著時工程變了不重新整理，下次開啟再要一份。
 *
 * 構建見 `views/quickOpen.ts`（讀了哪些盤寫在那裡），匹配與排序是前端的純函式（`media/src/editor/quickOpenCore.ts`）。
 */

/** 一章（細綱號 = 章號，一個章號一條，與工程頁的章節列表同一個口徑）。 */
export interface QuickOpenChapter {
  no: number;
  /** 細綱的標題優先，其次正文的（「第 9 章」這種回落標題不算標題，給空串）。 */
  title: string;
  /** 所在的卷目錄：正文（沒有正文時是細綱）在章節根下的那段子目錄，`第一卷`、`第一卷/上`；根下是空串。 */
  volume: string;
  /** 正文路徑。缺席 = 還沒有正文。 */
  chapterPath?: string;
  /** 細綱路徑（正文映象的那一份，或者還沒有正文時按號認的計劃）。缺席 = 還沒有細綱。 */
  plotPath?: string;
  /** 正文字數（中文按字、英文按詞，與工程頁同一個數）。沒有正文是 0。 */
  words: number;
}

export interface QuickOpenCharacter {
  name: string;
  aliases: string[];
  path: string;
}

export interface QuickOpenLore {
  title: string;
  path: string;
}

/** 架構三件、情節大綱、文風、敘事線（一條線一項）、全文大綱。 */
export type QuickOpenDocKey = 'config' | 'premise' | 'world' | 'outline' | 'style' | 'threads' | 'globalSummary';

export interface QuickOpenDoc {
  key: QuickOpenDocKey;
  /** 「小說配置」「情節大綱」……由後端給，前端只渲染。 */
  label: string;
  path: string;
}

export interface QuickOpenDraft {
  path: string;
  /** 檔名。 */
  name: string;
  /** 檔名裡的章號（草稿映象正文的路徑，檔名與正文同名）。認不出時缺席。 */
  no?: number;
}

export interface QuickOpenIndex {
  /** 還不是小說工程（沒有 `.novelwarden/project.json`）時為 false，其餘列表都是空的。 */
  initialized: boolean;
  /** 按章號升序。 */
  chapters: QuickOpenChapter[];
  characters: QuickOpenCharacter[];
  lore: QuickOpenLore[];
  /** 只列磁碟上有這份檔案的。 */
  docs: QuickOpenDoc[];
  drafts: QuickOpenDraft[];
}
