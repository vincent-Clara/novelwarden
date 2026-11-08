/**
 * 編輯區的公共介面：給編輯器裡的功能模組（縮排、回車自動縮排、成對標點、一鍵排版、
 * 查詢替換……）用。這些模組**只經這裡與 `Pane` 上的方法**碰編輯區，不去讀 `pane.ts` 的內部狀態。
 *
 * ## 三條硬規矩（`media/README.md`「內建編輯器的行為約束」同一份）
 *
 * 1. **程式改寫只走 `Pane.applyEdit`**。不許直接寫 `textarea.value`，也不要 `setRangeText` /
 *    `execCommand('insertText')`。繞過它的改動不進撤銷記錄（下一次 Ctrl+Z 核對不上，整份歷史作廢），
 *    髒標記、狀態列、標籤圓點、草稿持久化也都不會跟著更新。
 * 2. **keydown 先過 `isImeComposing(e)`**：輸入法組字時的 Tab、回車、Ctrl 組合鍵一律放行給輸入法。
 *    用 `addKeyHandler` 掛的處理函式已經替你過了這一道。
 * 3. **正文與否看 `isProse(file)`**：後端給的 `kind`（`chapter` / `draft`），前端不拿路徑或副檔名猜。
 *
 * ## 用法
 *
 * ```ts
 * import { activeEditor, addKeyHandler, indentUnit, onEditorChange } from './api';
 *
 * // 回車自動縮排：返回 true 表示這一下歸我處理（pane 替你 preventDefault，後面的處理函式不再收到）。
 * addKeyHandler((e, { pane, file, area }) => {
 *   if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return false;
 *   pane.applyEdit(area.selectionStart, area.selectionEnd, '\n' + indentUnit(file));
 *   return true;
 * });
 *
 * // 選單裡的「一鍵排版」：整份換掉也只記一步撤銷。
 * const ed = activeEditor();
 * if (ed) ed.pane.applyEdit(0, ed.area.value.length, layout(ed.area.value));
 *
 * // 查詢高亮：內容一變、換了檔案就重畫。
 * onEditorChange((ev) => redrawHighlights(ev.pane));
 * ```
 */
import type { MenuContext, MenuItem } from '../globals';
import type { TextChange, TextSelection } from './history';
import type { OpenFile } from './paneElements';
import { activePane, panes } from './store';
import type { Pane } from './store';

export type { TextChange, TextSelection } from './history';
export type { OpenFile } from './paneElements';
export type { ApplyEditOptions, Pane } from './store';

/** 一塊編輯區、它當前開著的檔案、它的 textarea。 */
export interface EditorContext {
  pane: Pane;
  file: OpenFile;
  /** 只讀它的 `value` / `selectionStart` / `selectionEnd`；要改內容走 `pane.applyEdit`。 */
  area: HTMLTextAreaElement;
}

/** 這一塊編輯區當前的檔案與 textarea。沒開檔案時 undefined。 */
export function editorOf(pane: Pane | undefined): EditorContext | undefined {
  const file = pane?.activeFile();
  return pane && file ? { pane, file, area: pane.area } : undefined;
}

/**
 * 當前啟用的那塊編輯區（最後被點 / 被聚焦的那一塊，`Ctrl+S` 儲存的就是它）+ 它當前的檔案 +
 * 它的 textarea。沒開檔案時 undefined。預覽模式下照樣返回（`applyEdit` 在預覽裡也能用，
 * 預覽會跟著重畫），要區分就看 `pane.isPreviewing()`。
 */
export function activeEditor(): EditorContext | undefined {
  return editorOf(activePane);
}

/**
 * 這份檔案是不是正文（章節或它的草稿）。看後端給的 `kind`；沒給（沒開啟工程、舊資料）當非正文。
 */
export function isProse(file: Pick<OpenFile, 'kind'> | undefined): boolean {
  return file?.kind === 'chapter' || file?.kind === 'draft';
}

/** 正文的一級縮排：兩個全形空格。 */
export const PROSE_INDENT = '　　';
/** 其餘檔案（角色卡、細綱、設定等 Markdown，以及 json / yml）的一級縮排：兩個半形空格。 */
export const PLAIN_INDENT = '  ';

/** 這份檔案的一級縮排。 */
export function indentUnit(file: Pick<OpenFile, 'kind'> | undefined): string {
  return isProse(file) ? PROSE_INDENT : PLAIN_INDENT;
}

/**
 * 這一下按鍵是不是輸入法組字中途（拼音還沒上屏）。是就什麼都別做，原樣放行給輸入法——
 * 組字時的回車是「把拼音當英文上屏」、Tab / 方向鍵是在候選詞之間挪，攔下來就把輸入法弄壞了。
 * `keyCode === 229` 是老版 Chrome / Safari 在組字時給的值（那時還沒有 `isComposing`）。
 */
export function isImeComposing(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229;
}

// ---------------------------------------------------------------- 按鍵

/**
 * 編輯區 keydown 的處理函式。返回 true 表示「這一下歸我」：pane 替你 `preventDefault()`，
 * 之後的處理函式與內建的 Tab 縮排都不再收到。
 */
export type KeyHandler = (e: KeyboardEvent, ctx: EditorContext) => boolean;

const keyHandlers: KeyHandler[] = [];

/**
 * 掛一個編輯區 keydown 處理函式，兩塊編輯區共用。返回取消掛載的函式。
 *
 * 順序：輸入法組字中途的按鍵根本不會送來（`isImeComposing`）→ 撤銷 / 重做（`Ctrl+Z` / `Ctrl+Y` /
 * `Ctrl+Shift+Z`，不可覆蓋）→ 這裡掛的函式，按掛載順序 → 內建的 Tab / Shift+Tab 縮排
 * （想改 Tab 的行為就在這裡先接走）。預覽模式下 textarea 是藏著的，收不到按鍵。
 */
export function addKeyHandler(handler: KeyHandler): () => void {
  keyHandlers.push(handler);
  return () => {
    const i = keyHandlers.indexOf(handler);
    if (i >= 0) {
      keyHandlers.splice(i, 1);
    }
  };
}

/** pane.ts 用：依次交給掛上來的處理函式，有一個接走就停。 */
export function runKeyHandlers(e: KeyboardEvent, ctx: EditorContext): boolean {
  for (const handler of [...keyHandlers]) {
    if (handler(e, ctx)) {
      return true;
    }
  }
  return false;
}

/**
 * 正文區右鍵（觸屏上是長按）選單裡功能模組加的項：按在哪個字上給什麼（名詞高亮給「開啟林昭的角色卡」）。
 * 排在剪下 / 複製 / 貼上前面，中間隔一條線；沒有就給空陣列。返回取消掛載的函式。
 */
export type AreaMenuProvider = (pane: Pane, at: MenuContext) => MenuItem[];

const areaMenuProviders: AreaMenuProvider[] = [];

export function addAreaMenu(provide: AreaMenuProvider): () => void {
  areaMenuProviders.push(provide);
  return () => {
    const i = areaMenuProviders.indexOf(provide);
    if (i >= 0) {
      areaMenuProviders.splice(i, 1);
    }
  };
}

/** pane.ts 用：正文區那張選單最前面的幾項。 */
export function areaMenuItems(pane: Pane, at: MenuContext): MenuItem[] {
  return areaMenuProviders.flatMap((provide) => provide(pane, at));
}

/** 事件目標落在哪一塊編輯區裡（查詢條、預覽也算在那一塊裡）。 */
export function paneContaining(target: EventTarget | null): Pane | undefined {
  if (!(target instanceof Node)) {
    return undefined;
  }
  return Object.values(panes).find((p) => p.root.contains(target));
}

/** 別的輸入框（對話輸入框、下拉框、可編輯區）——編輯區之外的快捷鍵在那裡不該搶。 */
export function isTextField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/**
 * 「編輯區裡或頁面上」那一檔快捷鍵（`shortcuts.ts` 的 `workbench`：查詢、F3、預覽……）這一下該給哪塊編輯區：
 * 焦點在某塊裡就是那一塊；焦點在編輯區之外的輸入框 / 文字框（左側對話輸入框之類）時誰都不給，留給瀏覽器；
 * 其餘（焦點在頁面上、按鈕上）給當前那一塊。那一塊沒開檔案也不給。
 */
export function paneForShortcut(e: KeyboardEvent): Pane | undefined {
  const inside = paneContaining(e.target);
  const pane = inside ?? (isTextField(e.target) ? undefined : activePane);
  return pane?.activeFile() ? pane : undefined;
}

// ---------------------------------------------------------------- 變化通知

/**
 * 內容是怎麼變的：`typing` 連續打字 / 刪除，`input` 其餘的原生輸入（貼上、拖放、剪下），
 * `composition` 輸入法上屏，`program` 經 `applyEdit` 的程式改寫（含「還原」「用磁碟版本覆蓋」），
 * `completion` 作者在名詞補全裡挑了一個名字（也經 `applyEdit`，帶 `opts.source`；碼字統計當作者打的字算，
 * 見 `writingStats.ts`），`undo` / `redo` 撤銷與重做。
 */
export type EditSource = 'typing' | 'input' | 'composition' | 'program' | 'completion' | 'undo' | 'redo';

export type EditorEvent =
  /**
   * 某塊編輯區裡某份檔案的內容變了（已經寫進 `file.draft`，若是當前檔案也已寫進 textarea）。
   * `change` 是這一處改動（位置按改動之前的文字算）；撤銷 / 重做可能一次退好幾處，不給。
   * 輸入法組字中途（拼音還沒上屏）也會發 `source: 'composition'` 好讓顯示跟上，但**不帶 `change`**；
   * 上屏的那一下才帶——要對「使用者剛輸入了什麼」做反應（例如成對標點）的，只認帶 `change` 的。
   */
  | { type: 'edit'; pane: Pane; file: OpenFile; source: EditSource; change?: TextChange }
  /** 這塊編輯區重畫了：換了檔案、開 / 關了標籤、切了預覽、儲存回執到了……當前檔案取 `editorOf(pane)`。 */
  | { type: 'render'; pane: Pane };

const listeners = new Set<(ev: EditorEvent) => void>();

/** 訂閱編輯區的變化。返回取消訂閱的函式。 */
export function onEditorChange(fn: (ev: EditorEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** pane.ts 用。某個訂閱者炸了不連累編輯器本身與其他訂閱者。 */
export function emitEditorChange(ev: EditorEvent): void {
  for (const fn of [...listeners]) {
    try {
      fn(ev);
    } catch (err) {
      console.error(err);
    }
  }
}

/** 選區夾進 `[0, length]`，並保證 `start ≤ end`。 */
export function clampSelection(sel: TextSelection, length: number): TextSelection {
  const a = Math.max(0, Math.min(length, Math.floor(sel.start)));
  const b = Math.max(0, Math.min(length, Math.floor(sel.end)));
  return a <= b ? { start: a, end: b } : { start: b, end: a };
}
