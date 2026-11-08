/**
 * 工程頁的前端狀態：摺疊開合與最近一次收到的樹。
 *
 * 展開/摺疊**完全留在前端**，不進後端也不進推送——切一下摺疊只需拿最近
 * 那份快照重畫（`rerenderProject`），不必往後端要一次資料。
 */
import type { ProjectTree } from '../../protocol';

/**
 * 頂層分組預設展開；資料夾預設摺疊——一進工程頁就攤開整棵樹反而看不清。
 * 放在模組級，重渲染後不會把使用者摺疊的東西又展開。
 *
 * `plots` 必須在這裡：它是流水線在工程頁上的落點，預設摺疊等於一進來
 * 什麼都看不見。分組 id 與 index.ts 裡 `buildGroup` 的第一個引數一一對應，
 * 漏一個不會報錯，只會靜默收起來。
 */
export const openGroups: Record<string, boolean> = {
  architecture: true,
  plots: true,
  characters: true,
  cast: true,
  lore: true,
  loreThin: true,
  loreUnfiled: true,
  meta: true,
  threads: true,
  timeline: true,
};

/** 展開著的資料夾（relPath 集合）。 */
export const openFolders = new Set<string>();

/**
 * 「章節」頁簽上**折起來的**卷（卷目錄的 relPath 集合）。與資料夾相反，卷預設展開：章節頁籤一進來就是要看章，
 * 卷都折著等於什麼都看不見。
 */
export const foldedVolumes = new Set<string>();

/**
 * 設定名錄的兩樣前端狀態，與摺疊開合同一個待遇：只在前端，不進後端，重推樹不清。
 *
 * - `filter`：「設定」組標題旁篩選框裡的字。檔案一變後端就整棵重推，篩選串要是跟著樹走，
 *   作者正篩著、旁邊儲存了一章，篩出來的東西就沒了。
 * - `showAllUnfiled`：「出現過 · 未建條目」點過「顯示全部」。同樣的理由：點開之後每次重推都縮回
 *   前 30 個，等於這顆按鈕白點。
 *
 * 用一個物件而不是兩個 `export let`：別的模組改不了匯入進來的 let 繫結。
 */
export const loreView = { filter: '', showAllUnfiled: false };

/**
 * 「時間線」組各段的摺疊（2026-10-24 重做）：最後一段預設展開、其餘預設收起（⚑9），作者點過的記在這裡——預設收起的點開了進 `open`，
 * 預設展開的（最後一段）折起來進 `closed`。同摺疊開合，只在前端。
 */
export const timelineFolds = { open: new Set<string>(), closed: new Set<string>() };

/** 最近一次收到的樹。摺疊時拿它重畫即可。 */
export let lastTree: ProjectTree | null = null;

export function setLastTree(tree: ProjectTree): void {
  lastTree = tree;
}

/** 每層縮排 14px，第 0 層與改造前的行保持同樣的左內邊距。 */
export function indentOf(depth: number): number {
  return 16 + depth * 14;
}
