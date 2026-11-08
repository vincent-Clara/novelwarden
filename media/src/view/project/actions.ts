/**
 * 工程頁發出去的那幾條訊息，以及三個可管理區各自的差異。
 */
import type { CharacterAction, ProjectAction } from '../../protocol';
import type { MenuItem } from '../../globals';
import { vscode } from '../store';

/**
 * `relPath` 是動作的作用物件（如要總結哪一章）；`dir` 給新建類動作指定落點
 * 目錄，預設落在該區的根目錄。`name` 只有 `newLore` 用：「出現過 · 未建條目」那一行
 * 新建時把名字帶過去，後端就不再彈框問標題（`dir` 那一層還沒有時後端會建）。
 */
export function projectAction(action: ProjectAction, relPath?: string, dir?: string, name?: string): void {
  vscode.postMessage({ type: 'projectAction', action, relPath, dir, name });
}

export function fileAction(action: 'rename' | 'move' | 'delete', relPath: string): void {
  vscode.postMessage({ type: 'fileAction', action, relPath });
}

/**
 * 角色卡動作。作用物件是一個**角色**（用名字標識），不是檔案——
 * 未建卡的人物根本沒有檔案，所以不能走 fileAction。
 */
export function characterAction(action: CharacterAction, name?: string, relPath?: string): void {
  // 批次動作（updateAllCards/rebuildAllCards）沒有具體角色，name 兜底空串。
  vscode.postMessage({ type: 'characterAction', action, name: name ?? '', relPath });
}

/** 開啟某章的草稿。傳的是**章節**路徑，草稿路徑由後端推導並按需建立。 */
export function openDraft(relPath: string): void {
  vscode.postMessage({ type: 'openDraft', path: relPath });
}

/**
 * 展開一條設定（完善設定，2026-10-19）：後端先問一句要求，再在對話頁把目標換成這一條、發一輪生成。
 * 已有條目給 `relPath`；「待完善」裡還沒有條目的給 `name` 與 `category`（後端先按分類建空條目）。
 */
export function expandLore(target: { relPath: string } | { name: string; category: string }): void {
  vscode.postMessage({ type: 'expandLore', ...target });
}

/**
 * 所有頁面都有的兜底選單：一個重新整理。
 *
 * **複用已有的 `projectAction: 'refresh'`**——後端那個分支只是 `pushState()`，
 * 會按當前頁籤推資料，天然適用於所有頁面，無需新增協議。
 */
export function baseMenuItems(): MenuItem[] {
  return [{ label: '重新整理', run: () => projectAction('refresh') }];
}

/**
 * 工程頁上兩個按目錄樹畫的區各自的差異：新建什麼、選單上怎麼稱呼、檔案行用什麼圖示。
 * 與 core/files/fileOps.ts 的 Section 對應；章節區在工程頁上是一個章號一行的平鋪列表，
 * 不走目錄樹，所以這裡沒有它。
 */
export interface Section {
  newAction: ProjectAction;
  newLabel: string;
  icon: string;
}

export const SECTIONS = {
  characters: { newAction: 'newCharacter', newLabel: '在此新建角色卡', icon: '👤' },
  lore: { newAction: 'newLore', newLabel: '在此新建設定', icon: '🌐' },
} as const satisfies Record<string, Section>;

/** 「在此新建 X / 在此新建資料夾」兩項，落點是 `dir`。 */
export function newItemsIn(section: Section, dir?: string): MenuItem[] {
  return [
    { label: section.newLabel, run: () => projectAction(section.newAction, undefined, dir) },
    { label: '在此新建資料夾', run: () => projectAction('newFolder', undefined, dir) },
  ];
}

/** 重新命名 / 移動 / 刪除——檔案與資料夾都是這三個。 */
export function entryItems(relPath: string): MenuItem[] {
  return [
    { label: '重新命名', run: () => fileAction('rename', relPath) },
    { label: '移動到…', run: () => fileAction('move', relPath) },
    { label: '刪除（移到回收站）', danger: true, run: () => fileAction('delete', relPath) },
  ];
}
