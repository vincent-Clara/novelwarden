/**
 * 兩塊編輯區之間共享的那點東西：登記表、當前是哪一塊、待恢復的草稿，
 * 以及重新整理恢復用的 localStorage 讀寫。
 *
 * 單獨一層的理由是打破環：`pane.ts`（一塊編輯區的行為）要調 `persist()`、
 * 要認下自己是 activePane；而「有哪幾塊」這件事又得等 pane 造出來才知道。
 * 把狀態放這兒，方向就只剩 index → pane → store 一條。
 */
import { announceEditorActive, projectStorageKey } from '../globals';
import type { MenuItem } from '../globals';
import type { EditorFileView, EditorOpenIntent, InMessage } from '../protocol';
import type { TextSelection } from './history';
import type { CarriedDraft, OpenFile, PaneId } from './paneElements';

/** `Pane.applyEdit` 的選項。 */
export interface ApplyEditOptions {
  /**
   * 並進上一步撤銷，而不是另起一步——例如成對標點補上的後半個，撤銷時與前半個一起退。
   * 只往**剛記下的那一步**裡並：上一步不存在、或中間撤銷 / 重做過時照常另起一步。
   */
  join?: boolean;
  /**
   * 這一下是作者在名詞補全裡挑了一個名字（`names.ts`）：`edit` 事件的 `source` 報 `completion` 而不是 `program`，
   * 碼字統計據此當作者打的字算（⚑，見 `writingStats.ts`）。別的程式改寫不給。
   */
  source?: 'completion';
}

/** 一塊編輯區對外的樣子。createPane 的返回值實現它。 */
export interface Pane {
  readonly id: PaneId;
  /** 這塊區的根節點，供整塊顯示/隱藏。 */
  readonly root: HTMLElement;
  /**
   * 這塊區的 textarea（所有標籤共用一個，顯示的是當前檔案）。**只讀**它的 value 與選區；
   * 改內容一律走 `applyEdit`，直接寫 `value` 會繞過撤銷記賬與髒標記。
   */
  readonly area: HTMLTextAreaElement;
  readonly files: Map<string, OpenFile>;
  activePath: string | null;
  activeFile(): OpenFile | undefined;
  /** 當前這一份是不是在 Markdown 預覽裡（textarea 藏著，收不到按鍵）。每個標籤各記各的（`OpenFile.markdownPreview`）。 */
  isPreviewing(): boolean;
  /** 當前這一份有沒有 Markdown 可預覽（`.md` / `.markdown`）。 */
  canPreview(): boolean;
  /**
   * 當前這一份切到預覽 / 切回編輯，兩邊滾到同一處（編輯區視口頂上那一行 ↔ 預覽裡對應的那一塊，`previewSync.ts`）。
   * 要「先切回編輯」的地方（查詢、體檢、對比合併、點引文……）調 `setPreviewing(false)`——`activate` 只切標籤、不改預覽。
   * 沒開檔案、要預覽的不是 Markdown 時返回 false。`focus: false`：焦點不動（預設進正文區 / 預覽）。
   */
  setPreviewing(on: boolean, opts?: { focus?: boolean }): boolean;
  hasDirty(): boolean;
  snapshot(): PaneSnapshot;
  /**
   * 切到這份檔案（認下這一塊、焦點進正文區；這一份在預覽裡就照舊在預覽裡、焦點進預覽）。`focus: false`：只換這一塊顯示的
   * 那份，不搶「當前這一塊」與焦點。
   */
  activate(path: string, opts?: { focus?: boolean }): void;
  /** 關一個標籤。有未儲存的修改時先問「儲存 / 不儲存 / 取消」（`closing.ts`），所以可能過一會兒才關、或者不關。 */
  closeFile(path: string): void;
  /** 關掉這幾份，不再問（`closing.ts` 已經問過了）。不在這塊裡的跳過。 */
  discard(paths: string[]): void;
  /**
   * 不問不提示地移走一個檔案。用於「同一路徑被另一塊編輯區接管」——
   * 那不是關閉，是搬家：返回要帶過去的東西（未儲存內容與撤銷歷史）好讓新的一塊接上；
   * 沒開著這個檔案時返回 false。
   */
  closeSilently(path: string): CarriedDraft | false;
  /**
   * 「移到另一側」的搬出一半：不經後端，把這份檔案連同未儲存內容、撤銷歷史、衝突條、「磁碟上沒了」、
   * 游標一起交出來（`carried.local`），`view` 是它此刻的基線（不重讀磁碟）。沒開著時 undefined。
   */
  moveOut(path: string): { view: EditorFileView; carried: CarriedDraft } | undefined;
  /**
   * 收一份檔案（`editorOpen`，或「移到另一側」從另一塊搬來）。`intent` 是開啟請求上帶的那兩個標記，
   * 後端原樣帶回：`preview` 開成臨時標籤（換掉這一塊現有的臨時標籤），`replace` 沒改過就在原位置換掉那一份。
   */
  upsertFile(incoming: EditorFileView, carried?: CarriedDraft, intent?: EditorOpenIntent): void;
  /** 臨時標籤轉正（雙擊標籤、右鍵「固定」、關掉「單擊開啟為臨時標籤」）。不是臨時的什麼都不做。 */
  pin(path: string): void;
  /**
   * **編輯區裡唯一的程式改寫入口**（縮排、成對標點、一鍵排版、全部替換、剪下 / 貼上……都走它，
   * 不許直接寫 `textarea.value`）。作用於這塊區的**當前檔案**。
   *
   * - **範圍**：把 `[start, end)` 換成 `text`。位置按編輯區裡**當下顯示的文字**算，即
   *   `area.value` 的下標（與 `selectionStart` / `selectionEnd` 同一套）；越界的夾進去，
   *   `start > end` 時對調。整份替換就傳 `0, area.value.length`。`text` 裡的 `\r\n` / `\r`
   *   歸一成 `\n`（textarea 只認 `\n`）。
   * - **選區**：`selection` 是改完之後的選區，位置按**新文字**算；預設是游標落在插入文字末尾
   *   （`start + text.length`）。越界的夾進去。
   * - **撤銷**：一次呼叫記**一步**，不與前後的打字合併（`opts.join` 例外，見 `ApplyEditOptions`）。
   *   撤銷回到改之前的文字與改之前的選區，重做回到改之後的文字與 `selection`。
   * - **其餘**：同時更新 `file.draft`、髒標記、狀態列、標籤圓點、草稿持久化，清掉過期的衝突條，
   *   併發一條 `onEditorChange` 的 `edit`（`source: 'program'`；名詞補全給了 `opts.source` 時是 `completion`）。
   *   預覽模式下也能用，預覽跟著重畫。
   *
   * 返回內容是否真的變了：沒開檔案、或替換前後一字不差時返回 false（這時只設選區，不記撤銷）。
   */
  applyEdit(start: number, end: number, text: string, selection?: TextSelection, opts?: ApplyEditOptions): boolean;
  /** 撤銷當前檔案的一步。沒有可撤銷的返回 false。 */
  undo(): boolean;
  /** 重做當前檔案的一步。沒有可重做的返回 false。 */
  redo(): boolean;
  save(force: boolean): void;
  /** 儲存這一份（經 `saving.ts`：同一份同一時刻只有一個儲存在路上；磁碟上沒了的先問要不要重建）。 */
  savePath(path: string, force: boolean): void;
  /**
   * 切到這份檔案、選中這一句並滾到它（五期：點審稿報告上的引文）。定位按 `locateQuote`——與後端
   * 校驗引文同一個歸一化。找不到返回 false。
   */
  reveal(path: string, quote: string): boolean;
  applySaved(incoming: EditorFileView): void;
  applyConflict(path: string, diskText: string, diskHash: string): void;
  /**
   * 磁碟上這一份變了（`editorDiskChanged`；或別的視窗存了它，那條 `editorSaved` 不是這邊要的）。
   * 沒改過的標籤就地換成新內容（記一步撤銷、游標與滾動夾進新長度、正看著的在狀態列說一句），
   * 改過的一個字不動、掛衝突條、標籤上標出來。**不切標籤、不搶焦點。**
   */
  applyDiskChange(incoming: EditorFileView): void;
  /** 磁碟上已經沒有這一份了（`editorDiskGone`）：標籤標成已刪除，正在路上的那次儲存就此作罷。 */
  markGone(path: string): void;
  /**
   * 編輯器知道的這一份在磁碟上的 hash，核對磁碟時帶給後端：標成已刪除的給空串（磁碟上又出現了就會回話），
   * 見過一份還沒載入的磁碟新版就給那一份的（同一個新版不必再報一次），否則是儲存基線。
   */
  knownDiskHash(path: string): string;
  /** 重畫標籤與狀態列（儲存狀態變了，`saving.ts` 調）。 */
  refresh(): void;
  /**
   * 換掉這份檔案的樂觀鎖基線（`text` / `hash`，即「磁碟上是什麼」），並收起它的衝突條。編輯區裡的內容
   * 不動。衝突時「對比合併」採納之後用（`editor/replace.ts`）：作者看過了磁碟上的那一份，之後照常儲存。
   */
  rebase(path: string, text: string, hash: string): void;
  /** 這一塊開著的特殊標籤（不對應檔案，見 {@link SpecialTab}），按開啟的先後。 */
  readonly specials: readonly string[];
  /**
   * 正顯示著的特殊標籤。顯示它的時候這一塊**沒有當前檔案**（`activePath` 是 null、`activeFile()` 是 undefined）：
   * 儲存、查詢、體檢、歷史版本這些「對當前檔案做事」的都當這一塊沒開檔案，不會對著藏在後面的那一份動手。
   */
  activeSpecial(): string | null;
  /**
   * 開啟（已經開著就切到）一個特殊標籤。同一個特殊標籤同一時刻只在一塊裡：開在另一塊裡的先從那邊拿走（同「一個路徑只屬於
   * 一塊」）。`focus: false`：不認下「當前這一塊」；`background`：只把標籤放上標籤條、不切過去（重新整理恢復那些沒在顯示的）；
   * `restoring`：重新整理恢復時開啟的，不寫 localStorage（檔案還沒回來，這時寫下去會把它們從待恢復的清單裡沖掉）。
   */
  openSpecial(id: string, opts?: { focus?: boolean; background?: boolean; restoring?: boolean }): void;
  /**
   * 關掉一個特殊標籤；它正顯示著就回到切過去之前的那份檔案（還開著的話，否則最後一份）。`quiet`：換工程時一併關掉，
   * 不寫 localStorage、不廣播。
   */
  closeSpecial(id: string, opts?: { quiet?: boolean }): void;
}

export interface PaneSnapshot {
  open: { path: string; hash: string; draft?: string; preview?: boolean; markdownPreview?: boolean }[];
  /** 當前那份檔案。特殊標籤正顯示著時是切過去之前的那一份（關掉特殊標籤回到它）。 */
  active: string | null;
  /** 開著的特殊標籤（敘事線總覽，三期）。 */
  specials?: string[];
  /** 正顯示著的特殊標籤。 */
  special?: string;
}

// ---------------------------------------------------------------- 特殊標籤

/**
 * 編輯區裡**不對應檔案**的標籤（敘事線重做三期：「敘事線總覽」；之後有「時間線總覽」與「版本」的對比標籤）。編輯區原本
 * 只認檔案——標籤就是一份開啟的檔案、顯示的是 textarea——這是給它開的唯一一道口子：`pane.ts` 只認這個介面，不知道里面
 * 畫的是什麼；畫的東西掛在這一塊的 `.ed-stage` 上，蓋住正文區（模組自己現造、自己藏）。
 *
 * - 標籤排在檔案標籤前面，寫 `label().title`，沒有髒標記；點了切過去、× 與中鍵關掉、右鍵「關閉」加 `menu()` 給的幾項。
 * - 切過去時這一塊沒有當前檔案（見 `Pane.activeSpecial`）；切回一份檔案、或從別處開啟一份檔案到這一塊，它就藏起來。
 * - 重新整理記著（`PaneSnapshot.specials` / `special`），恢復時先於檔案開啟，陸續回來的檔案不把正顯示著的它換下去；`transient` 的不記。
 */
export interface SpecialTab {
  /** 穩定的 id，記進 localStorage。 */
  readonly id: string;
  /** 標籤上寫什麼、懸停看什麼。 */
  label(): { title: string; tip: string };
  /** 這一塊要顯示它：掛上覆蓋層（第一次現造）、露出來。每次重畫都會調，要便宜、可以重複調。 */
  show(pane: Pane): void;
  /** 這一塊不再顯示它（切到了一份檔案、關掉了、搬到了另一塊）。 */
  hide(pane: Pane): void;
  /** 標籤右鍵「關閉」之後的那幾項。 */
  menu?(pane: Pane): MenuItem[];
  /** 不進重新整理恢復（「版本」的對比標籤：看的是哪兩版只在這一頁裡記著，重新整理之後沒有可畫的）。 */
  readonly transient?: boolean;
}

const specialTabs = new Map<string, SpecialTab>();

/** 登記一種特殊標籤（模組裝的時候）。 */
export function registerSpecialTab(tab: SpecialTab): void {
  specialTabs.set(tab.id, tab);
}

export function specialTabOf(id: string): SpecialTab | undefined {
  return specialTabs.get(id);
}

/** 哪一塊開著這個特殊標籤。同一時刻至多一塊。 */
export function paneWithSpecial(id: string): Pane | undefined {
  return Object.values(panes).find((p) => p.specials.includes(id));
}

const STORE_KEY = 'novelforge.editor.v1';

/** path -> 待恢復的未儲存內容，等對應的 editorOpen 到達時消費。 */
export const pendingDrafts = new Map<string, CarriedDraft>();

/** paneId -> 恢復完成後應該啟用的 path。 */
export const pendingActive = new Map<PaneId, string | null>();

/** 已經造出來的編輯區。草稿區惰性建立，一開始只有主區。 */
export const panes: Partial<Record<PaneId, Pane>> = {};

/** 把新造的一塊登記進來。造與登記分開，createPane 就不必知道這張表。 */
export function registerPane(pane: Pane): Pane {
  panes[pane.id] = pane;
  return pane;
}

/** 由 index.ts 在啟動時裝上。 */
let post: (msg: InMessage) => void = () => {};
/** 草稿區沒有開啟的檔案時，連同那條分隔條一起收起來。 */
let draftResizer: HTMLElement | undefined;
/** 第二塊編輯區惰性建立：要往那裡搬東西的模組（「移到另一側」）經它拿，沒有就現造。 */
let makePane: (id: PaneId) => Pane = (id) => panes[id]!;

export function bindStore(deps: {
  post: (msg: InMessage) => void;
  draftResizer: HTMLElement;
  ensurePane?: (id: PaneId) => Pane;
}): void {
  post = deps.post;
  draftResizer = deps.draftResizer;
  if (deps.ensurePane) {
    makePane = deps.ensurePane;
  }
}

/** 另一塊編輯區。`create`：第二塊還沒造出來時現造（往那邊搬東西時）；否則沒有就是 undefined。 */
export function otherPane(pane: Pane, create = false): Pane | undefined {
  const id: PaneId = pane.id === 'main' ? 'draft' : 'main';
  return panes[id] ?? (create ? makePane(id) : undefined);
}

/** 兩塊編輯區裡開著的全部檔案（標籤上同名的要放在一起比，見 `tabLabels.ts`）。 */
export function allOpenFiles(): OpenFile[] {
  return Object.values(panes).flatMap((p) => [...p.files.values()]);
}

/**
 * 一塊的檔案開了 / 關了，另一塊的標籤可能要改寫法（同名的區分目錄）。開著的每一塊都重畫一遍標籤
 * （`Pane.refresh`：只畫標籤與狀態列，正文不動）。
 */
export function refreshOtherTabs(except: Pane): void {
  for (const pane of Object.values(panes)) {
    if (pane !== except) {
      pane.refresh();
    }
  }
}

// ---------------------------------------------------------------- 關掉之後的游標與滾動

/**
 * 關掉的（含被換掉的臨時標籤、搬去另一塊的）檔案最後的游標與滾動：這一頁裡再開啟它時放回去，不從頂上重新找。
 * 單擊瀏覽章節時臨時標籤一直在被換掉，回到看過的那一章應該還在原處。按路徑記、兩塊共用，不進 localStorage。
 */
export interface FileView {
  caret: number;
  scrollTop: number;
}

const VIEW_LIMIT = 100;
const closedViews = new Map<string, FileView>();

export function rememberView(path: string, view: FileView): void {
  closedViews.delete(path);
  closedViews.set(path, view);
  if (closedViews.size > VIEW_LIMIT) {
    closedViews.delete(closedViews.keys().next().value!);
  }
}

/** 取走這份檔案關掉時記下的游標與滾動（取一次就沒了：開著時由 `OpenFile` 自己記）。 */
export function takeView(path: string): FileView | undefined {
  const view = closedViews.get(path);
  closedViews.delete(path);
  return view;
}

// ---------------------------------------------------------------- 最近關閉

/** 最近關掉的標籤，**按塊記**（最新的在最後）。只記作者親手關的（關標籤、關閉其它……），搬家、換掉臨時標籤不算。 */
export interface ClosedTab {
  path: string;
  pane: PaneId;
  /** 關掉那一刻標籤上寫的名字（「▾」列表與右鍵選單上說「重新開啟 003-夜訪」）。 */
  title: string;
}

const CLOSED_LIMIT = 20;
const closedTabs: ClosedTab[] = [];

export function noteClosed(entry: ClosedTab): void {
  forgetClosed(entry.path);
  closedTabs.push(entry);
  if (closedTabs.length > CLOSED_LIMIT) {
    closedTabs.shift();
  }
}

/** 又開著了（不論從哪條路）：從最近關閉裡拿掉。 */
export function forgetClosed(path: string): void {
  const i = closedTabs.findIndex((c) => c.path === path);
  if (i >= 0) {
    closedTabs.splice(i, 1);
  }
}

/** 這一塊最近關掉的那一個。 */
export function lastClosed(pane: PaneId): ClosedTab | undefined {
  for (let i = closedTabs.length - 1; i >= 0; i--) {
    if (closedTabs[i].pane === pane) {
      return closedTabs[i];
    }
  }
  return undefined;
}

/** 最近關掉的幾個，新的在前。 */
export function recentClosed(limit = 8): ClosedTab[] {
  return closedTabs.slice(-limit).reverse();
}

/** 重新開啟：開回它原來那一塊（正常標籤）。 */
export function reopenClosed(entry: ClosedTab): void {
  forgetClosed(entry.path);
  post({ type: 'openEditor', path: entry.path, pane: entry.pane });
}

/** 換工程：上一個工程關掉的那些不再有意義。 */
export function clearClosed(): void {
  closedTabs.length = 0;
}

/** 發一條訊息給後端（不在某一塊編輯區裡的模組用：儲存、核對磁碟）。 */
export function postToHost(msg: InMessage): void {
  post(msg);
}

/** 當前這一塊——Ctrl+S / Ctrl+W 作用於它。 */
export let activePane: Pane;

export function setActivePane(pane: Pane): void {
  activePane = pane;
}

/**
 * 廣播「現在編輯的是哪個檔案」。資源管理器據此高亮那一行。
 *
 * `activePane` 每次易主都要跟一句，否則高亮會停在上一個檔案上。
 */
export function announceActive(): void {
  const file = activePane?.activeFile();
  announceEditorActive(file ? file.path : null);
}

/** 哪一塊編輯區持有這個路徑。單 pane 擁有權保證結果唯一。 */
export function paneOwning(path: string): Pane | undefined {
  for (const pane of Object.values(panes)) {
    if (pane.files.has(path)) {
      return pane;
    }
  }
  return undefined;
}

/** 草稿區裡沒有開啟的檔案（也沒有特殊標籤）時整塊收起來，連同那條分隔條。 */
export function syncDraftVisibility(): void {
  const draft = panes.draft;
  const open = !!draft && (draft.files.size > 0 || draft.specials.length > 0);
  draft?.root.classList.toggle('hidden', !open);
  draftResizer?.classList.toggle('hidden', !open);
}

// ---------------------------------------------------------------- 持久化

/**
 * 重新整理頁面不該丟掉未儲存的修改——瀏覽器裡 F5 太容易按到。
 * 存的是草稿與基線 hash，重連後重新拉一次檔案再比對。
 */
export function persist(): void {
  try {
    const data = {
      v: 2,
      panes: Object.fromEntries(
        Object.entries(panes).map(([id, pane]) => [id, pane.snapshot()])
      ),
      activePane: activePane?.id,
    };
    localStorage.setItem(projectStorageKey(STORE_KEY), JSON.stringify(data));
  } catch {
    /* 隱私模式下 localStorage 可能不可寫，丟了也不影響主流程 */
  }
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;

/** 敲字時每次都寫 localStorage 太浪費，攢一下。 */
export function schedulePersist(): void {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, 400);
}

/** 換工程時：攢著的那一次不寫了——它記的是上一個工程的標籤頁，寫下去會落到新工程的鍵上。 */
export function cancelScheduledPersist(): void {
  clearTimeout(persistTimer);
  persistTimer = undefined;
}

/**
 * 重新整理後重開上次的標籤頁。
 *
 * 這裡只發 `openEditor`、把草稿記進 `pendingDrafts`；真正貼回去由
 * `upsertFile` 在檔案到達時做，並且要比對 hash——磁碟變過就丟棄草稿，
 * 不拿舊內容蓋新內容。
 */
export function restore(): void {
  if (document.body.classList.contains('no-workspace')) {
    return;
  }
  let saved: unknown;
  try {
    saved = JSON.parse(localStorage.getItem(projectStorageKey(STORE_KEY)) || 'null');
  } catch {
    return;
  }
  if (!saved || typeof saved !== 'object') {
    return;
  }
  const raw = saved as { open?: unknown; active?: unknown; panes?: unknown };
  type StoredPane = { open?: unknown; active?: unknown; specials?: unknown; special?: unknown };

  // v1 只有一塊編輯區，形狀是 { open, active }——老使用者的標籤頁不該在
  // 升級後憑空消失，按主區讀進來。
  const stored: Record<string, StoredPane> = Array.isArray(raw.open)
    ? { main: { open: raw.open, active: raw.active } }
    : ((raw.panes as Record<string, StoredPane>) ?? {});

  for (const paneId of ['main', 'draft'] as const) {
    const data = stored[paneId];
    // 特殊標籤（敘事線總覽）：認得出的才開、同一個只開一次（記壞了的、改過名的不認，至多少一個標籤，不崩）。
    const specials = Array.isArray(data?.specials)
      ? (data!.specials as unknown[]).filter(
          (id): id is string => typeof id === 'string' && !!specialTabOf(id) && !paneWithSpecial(id)
        )
      : [];
    const hasFiles = !!data && Array.isArray(data.open) && data.open.length > 0;
    if (!data || (!hasFiles && specials.length === 0)) {
      continue;
    }
    // 先開特殊標籤：正顯示著的那一個先切過去，之後陸續回來的檔案不把它換下去（`claimActivePath`）。
    const shown = typeof data.special === 'string' && specials.includes(data.special) ? data.special : undefined;
    if (specials.length > 0) {
      const pane = makePane(paneId);
      for (const id of specials) {
        pane.openSpecial(id, { focus: false, restoring: true, background: id !== shown });
      }
    }
    if (!hasFiles) {
      continue;
    }
    pendingActive.set(paneId, typeof data.active === 'string' ? data.active : null);
    for (const item of data.open as { path?: unknown; hash?: unknown; draft?: unknown; preview?: unknown; markdownPreview?: unknown }[]) {
      if (!item || typeof item.path !== 'string') {
        continue;
      }
      // 臨時標籤記著（⚑）：重新整理前斜體的那一個，重新整理後還是它。在預覽裡的也照舊在預覽裡（⚑）。
      // 兩個標記都只記在前端，不隨開啟請求發出去。
      pendingDrafts.set(item.path, {
        hash: typeof item.hash === 'string' ? item.hash : undefined,
        draft: typeof item.draft === 'string' ? item.draft : undefined,
        preview: item.preview === true,
        markdownPreview: item.markdownPreview === true,
      });
      post({ type: 'openEditor', path: item.path, pane: paneId });
    }
  }
}

/**
 * 檔案改名/搬家後，把 localStorage 裡的舊路徑條目改寫成新路徑，草稿不丟。
 * 讀不下/寫不進都無所謂，最壞退化為丟一次重新整理恢復。
 */
export function rekeyStorage(from: string, to: string): void {
  try {
    const data = JSON.parse(localStorage.getItem(projectStorageKey(STORE_KEY)) || 'null');
    if (!data?.panes) {
      return;
    }
    for (const paneData of Object.values(data.panes) as { open?: unknown; active?: unknown }[]) {
      if (Array.isArray(paneData?.open)) {
        for (const item of paneData.open as { path?: string }[]) {
          if (item?.path === from) {
            item.path = to;
          }
        }
      }
      if (paneData?.active === from) {
        paneData.active = to;
      }
    }
    localStorage.setItem(projectStorageKey(STORE_KEY), JSON.stringify(data));
  } catch {
    /* 同上 */
  }
}
