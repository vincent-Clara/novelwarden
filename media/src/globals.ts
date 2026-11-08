/**
 * 三個前端產物之間的全部交集。
 *
 * view / editor / explorer 各自獨立打包、各自監聽 message、各自 postMessage，
 * 唯一互通的就是這裡的東西。**別讓 explorer 直接去讀 editor 的內部狀態**
 * （那會把編輯器的私事變成兩個檔案之間的契約，而資源管理器在外掛形態裡
 * 根本不存在）。
 *
 * - `__nfToast`：view 出，editor / explorer 用。共用一條提示條，免得兩套互相蓋住。
 * - `__nfContextMenu`：view 出的右鍵選單登記函式。全域 `contextmenu` 監聽只在
 *   view 裡有一份，另起一套會兩層選單一起彈。
 * - 自定義事件：`nf-editor-active`、`nf-files-moved`，以及標題欄（view.js）
 *   與編輯器（editor.js）之間的 `nf-editor-query` / `nf-editor-command` /
 *   `nf-workspace-reset`，「編輯」選單段落那幾項的 `nf-paragraph-query` / `nf-paragraph-command`，
 *   「檔案 → 歷史版本…」的 `nf-versions-query` / `nf-versions-command`，「檔案 → 轉到…」的
 *   `nf-quickopen-query` / `nf-quickopen-command`，「編輯 → 全書查詢替換…」的 `nf-bookfind-query` / `nf-bookfind-command`，
 *   「檢視」選單的 `nf-view-query` / `nf-view-command`，「幫助 → 快捷鍵一覽」的 `nf-shortcuts-query` / `nf-shortcuts-command`，
 *   「檢視 → 統計」那一組的 `nf-stats-query` / `nf-stats-command`，「檢視 → 體檢」那一組的 `nf-check-query` /
 *   `nf-check-command`，「檢視 → 補全」那一組的 `nf-names-query` / `nf-names-command`，
 *   以及 `nf-reveal-in-files`（editor → explorer + view：在「檔案」頁定位到某個檔案或目錄）、`nf-show-versions`
 *   （editor → view：切到側欄「版本」頁）、存檔點彈窗「對比」在編輯區開對比標籤的 `nf-version-diff-query` /
 *   `nf-version-diff-command`，
 *   對話頁「加入選區」問內建編輯器選區的 `nf-selection-query`，工程頁「敘事線」頁籤開啟編輯區「敘事線總覽」的
 *   `nf-threads-query` / `nf-threads-command`（工程頁「時間線」組開啟「時間線總覽」的 `nf-timeline-query` / `nf-timeline-command` 同樣），工程頁「存檔點…」退回時問內建編輯器哪幾份沒儲存的
 *   `nf-dirty-query`。
 *   `nf-pick-folder` 給目錄選擇器攔歡迎頁的佔位 prompt。
 * - `__nfShowMenu`：view 出的「在某處彈一個選單」（編輯器標籤條末尾的「▾」用），與右鍵選單是同一個引擎。
 */

/** 選單項。`{ sep: true }` 是分隔線，其餘是可點的一條。 */
export type MenuItem = { sep: true } | MenuAction;

export interface MenuAction {
  sep?: false;
  label: string;
  /** 置灰的項（如「出場：第 1、2、3 章」那種純說明）可以不給。 */
  run?: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/**
 * 右鍵（觸屏上是長按）那一下：按在哪個元素上、視口座標、是不是手指長按（`touch.ts` 認的）。選單項多半用不著它，
 * 要按「按在哪個字上」給項的（編輯區裡的名字、敘事線總覽的格子）才看。
 */
export interface MenuContext {
  target: Element | null;
  x: number;
  y: number;
  touch: boolean;
}

/** 「這個元素上右鍵給什麼選單」的登記函式。`provide` 在右鍵那一刻才呼叫。 */
export type ContextMenuRegistrar = <T extends Element>(node: T, provide: (at: MenuContext) => MenuItem[]) => T;

/** 標題欄問編輯器「現在開著什麼、髒不髒」。沒人聽時全是空值。 */
export interface EditorStatus {
  hasFile: boolean;
  dirtyCurrent: boolean;
  dirtyAny: boolean;
  path: string | null;
  text: string;
  /** 焦點在內建編輯器的正文區裡。「編輯 → 撤銷 / 重做」這時交給編輯器自己的歷史。 */
  areaFocused: boolean;
  /** 自動儲存開著沒有（按瀏覽器記，預設關）。「檔案 → 自動儲存」據此打 ✓。 */
  autoSave: boolean;
}

/**
 * `undo` / `redo` 作用於當前那塊編輯區的當前檔案（編輯器自己記的歷史，不是瀏覽器原生的）；
 * `find` / `replace` 開啟那一塊的查詢條（`replace` 連替換行一起展開）；`toggleAutoSave` 開關自動儲存。
 */
export type EditorCommandName = 'save' | 'saveAll' | 'close' | 'find' | 'replace' | 'undo' | 'redo' | 'toggleAutoSave';

declare global {
  interface Window {
    __nfToast?: (message: string, isError?: boolean) => void;
    __nfContextMenu?: ContextMenuRegistrar;
    __nfShowMenu?: (items: MenuItem[], x: number, y: number) => HTMLElement | undefined;
  }

  interface WindowEventMap {
    'nf-editor-active': CustomEvent<{ path: string | null }>;
    'nf-files-moved': CustomEvent<{ from: string; to: string }>;
    'nf-pick-folder': CustomEvent<{ intent: 'open' | 'file' }>;
    'nf-editor-query': CustomEvent<EditorStatus>;
    'nf-editor-command': CustomEvent<{ name: EditorCommandName }>;
    'nf-workspace-reset': Event;
    'nf-paragraph-query': CustomEvent<ParagraphStatus>;
    'nf-paragraph-command': CustomEvent<{ name: ParagraphCommandName }>;
    'nf-versions-query': CustomEvent<VersionsStatus>;
    'nf-versions-command': CustomEvent<{ name: 'open' }>;
    'nf-quickopen-query': CustomEvent<QuickOpenStatus>;
    'nf-quickopen-command': CustomEvent<{ name: 'open' }>;
    'nf-bookfind-query': CustomEvent<BookFindStatus>;
    'nf-bookfind-command': CustomEvent<{ name: BookFindCommandName }>;
    'nf-view-query': CustomEvent<ViewPrefsStatus>;
    'nf-view-command': CustomEvent<{ name: ViewCommandName }>;
    'nf-stats-query': CustomEvent<StatsStatus>;
    'nf-stats-command': CustomEvent<{ name: StatsCommandName }>;
    'nf-check-query': CustomEvent<CheckStatus>;
    'nf-check-command': CustomEvent<{ name: CheckCommandName }>;
    'nf-names-query': CustomEvent<NamesStatus>;
    'nf-names-command': CustomEvent<{ name: NamesCommandName }>;
    'nf-shortcuts-query': CustomEvent<{ available: boolean }>;
    'nf-shortcuts-command': Event;
    'nf-reveal-in-files': CustomEvent<{ path: string; dir: boolean }>;
    'nf-show-versions': Event;
    'nf-version-diff-query': CustomEvent<{ available: boolean }>;
    'nf-version-diff-command': CustomEvent<CheckpointFileDiffCommand>;
    'nf-selection-query': CustomEvent<EditorSelection>;
    'nf-threads-query': CustomEvent<{ available: boolean }>;
    'nf-threads-command': CustomEvent<ThreadsOverviewCommand>;
    'nf-timeline-query': CustomEvent<{ available: boolean }>;
    'nf-timeline-command': CustomEvent<TimelineOverviewCommand>;
    'nf-dirty-query': CustomEvent<{ paths: string[] }>;
  }
}

/**
 * 提示條。view 還沒載入（或根本沒有）時靜默丟掉——
 * 提示不出來不該連帶把編輯器的主流程搞崩。
 */
export function toast(message: string, isError?: boolean): void {
  window.__nfToast?.(message, isError);
}

/**
 * 右鍵選單登記。取不到 view 的登記表時退化成「這個元素沒有選單」，
 * 全域監聽會給它兜底的「重新整理」。
 */
export const onContextMenu: ContextMenuRegistrar = (node, provide) =>
  (window.__nfContextMenu ?? ((n) => n))(node, provide);

/** 廣播「編輯器裡現在開著哪個檔案」。沒人聽時白髮一趟，代價可以忽略。 */
export function announceEditorActive(path: string | null): void {
  window.dispatchEvent(new CustomEvent('nf-editor-active', { detail: { path } }));
}

/** 廣播「某個檔案改名/搬家了」，編輯器據此把標籤連同未儲存草稿挪過去。 */
export function announceFileMoved(from: string, to: string): void {
  window.dispatchEvent(new CustomEvent('nf-files-moved', { detail: { from, to } }));
}

/** 問編輯器當前狀態。editor.js 沒裝時返回全空。 */
export function queryEditor(): EditorStatus {
  const status: EditorStatus = {
    hasFile: false,
    dirtyCurrent: false,
    dirtyAny: false,
    path: null,
    text: '',
    areaFocused: false,
    autoSave: false,
  };
  window.dispatchEvent(new CustomEvent('nf-editor-query', { detail: status }));
  return status;
}

export function commandEditor(name: EditorCommandName): void {
  window.dispatchEvent(new CustomEvent('nf-editor-command', { detail: { name } }));
}

/** 開啟/關閉資料夾前：有髒標籤就問一句。不確定則不往下走。 */
export function confirmProceedIfDirty(message = '有未儲存的修改，仍要繼續嗎？'): boolean {
  if (!queryEditor().dirtyAny) {
    return true;
  }
  return window.confirm(message);
}

/** 工作區換了或關掉：編輯器丟掉全部標籤。 */
export function resetEditor(): void {
  window.dispatchEvent(new Event('nf-workspace-reset'));
}

/** 這個視窗開的是哪個工程：獨立版網址上的 `?project=`。外掛與空視窗沒有。 */
export function windowProject(): string | null {
  try {
    return new URLSearchParams(location.search).get('project') || null;
  } catch {
    return null;
  }
}

/**
 * localStorage 的鍵按工程分開：獨立版幾個視窗各開一個工程時，標籤頁、展開的目錄、
 * 沒發出去的草稿不互相頂掉。沒有工程時就是原來那個鍵。
 */
export function projectStorageKey(base: string): string {
  const project = windowProject();
  return project ? `${base}@${project}` : base;
}

// ---------------------------------------------------------------- 「編輯」選單段落那幾項

/**
 * 標題欄「編輯」選單段落那幾項問編輯器的狀態（`editor/paragraph.ts` 回答）。與 `EditorStatus` 分開一份：
 * 那是儲存 / 撤銷那一組的，這一組只管正文排版。分段格式本身不在這裡——它是工程的設定，選單從
 * `ViewState.paragraphStyle` 讀。
 */
export interface ParagraphStatus {
  /** 當前那塊編輯區開著的是正文（章節或草稿）。「一鍵排版」「半形標點轉全形」只對正文亮。 */
  prose: boolean;
  /** 成對符號自動補全開著沒有（按瀏覽器記，預設開）。 */
  autoPair: boolean;
}

/** `toggleAutoPair` 開關成對符號；另兩個作用於當前那塊編輯區的當前檔案（有選區只改選中的那幾行）。 */
export type ParagraphCommandName = 'toggleAutoPair' | 'formatProse' | 'fullWidthPunct';

/** 問編輯器段落那幾項的狀態。editor.js 沒裝時全是關的（自動補全按預設算開）。 */
export function queryParagraph(): ParagraphStatus {
  const status: ParagraphStatus = { prose: false, autoPair: true };
  window.dispatchEvent(new CustomEvent('nf-paragraph-query', { detail: status }));
  return status;
}

export function commandParagraph(name: ParagraphCommandName): void {
  window.dispatchEvent(new CustomEvent('nf-paragraph-command', { detail: { name } }));
}

// ---------------------------------------------------------------- 「檔案」選單「歷史版本…」

/**
 * 標題欄「檔案 → 歷史版本…」問編輯器的狀態（`editor/versions.ts` 回答）：當前那塊編輯區開著的檔案存不存
 * 歷史版本，不存的話為什麼（選單項置灰時掛在提示上）。點了切到側欄「版本」頁（經 `nf-versions-command`）。
 */
export interface VersionsStatus {
  available: boolean;
  /** 不能用的原因（沒開檔案、沒開啟工程、不是創作產物……）。 */
  reason?: string;
}

/** 問編輯器「歷史版本」能不能用。editor.js 沒裝時不能用。 */
export function queryVersions(): VersionsStatus {
  const status: VersionsStatus = { available: false, reason: '沒有開啟的檔案' };
  window.dispatchEvent(new CustomEvent('nf-versions-query', { detail: status }));
  return status;
}

/** 看當前那塊編輯區那份檔案的歷史版本：切到側欄「版本」頁。 */
export function commandVersions(name: 'open'): void {
  window.dispatchEvent(new CustomEvent('nf-versions-command', { detail: { name } }));
}

/** 存檔點彈窗裡「對比」一份：那個存檔點裡的這一份 ↔ 現在，在編輯區的對比標籤裡看（`editor/versions.ts` 接）。 */
export interface CheckpointFileDiffCommand {
  path: string;
  /** 同 `CheckpointFileStatus`：改過的、之後刪掉的、之後新建的。 */
  status: 'changed' | 'deleted' | 'added';
  checkpoint: { id: string; time: number; note: string; auto: boolean };
}

/** 有沒有人畫得了對比標籤（只有裝了內建編輯器的獨立版、桌面版回答）。 */
export function queryVersionDiff(): boolean {
  const status = { available: false };
  window.dispatchEvent(new CustomEvent('nf-version-diff-query', { detail: status }));
  return status.available;
}

export function commandVersionDiff(cmd: CheckpointFileDiffCommand): void {
  window.dispatchEvent(new CustomEvent('nf-version-diff-command', { detail: cmd }));
}

/** 切到側欄「版本」頁（editor.js 發，view.js 的 `tabs.ts` 切；外掛形態沒有這一頁）。 */
export function showVersionsTab(): void {
  window.dispatchEvent(new Event('nf-show-versions'));
}

// ---------------------------------------------------------------- 「檔案」選單「轉到…」

/**
 * 標題欄「檔案 → 轉到…」問編輯器「轉到」面板能不能開（`editor/quickOpen.ts` 回答）：沒開啟工程時不能，
 * 原因掛在選單項的提示上。editor.js 沒裝（外掛形態，也就沒有標題欄）時沒人回答，當不能用。
 */
export interface QuickOpenStatus {
  available: boolean;
  reason?: string;
}

export function queryQuickOpen(): QuickOpenStatus {
  const status: QuickOpenStatus = { available: false, reason: '沒有內建編輯器' };
  window.dispatchEvent(new CustomEvent('nf-quickopen-query', { detail: status }));
  return status;
}

/** 開啟「轉到」面板（與 Ctrl+P 同一件事）。 */
export function commandQuickOpen(name: 'open'): void {
  window.dispatchEvent(new CustomEvent('nf-quickopen-command', { detail: { name } }));
}

// ---------------------------------------------------------------- 「編輯」選單「全書查詢替換…」

/**
 * 標題欄「編輯 → 全書查詢替換…」問編輯器那塊面板能不能開（`editor/bookFind.ts` 回答）：沒開啟工程時不能，原因掛在
 * 選單項的提示上。editor.js 沒裝（外掛形態，也就沒有標題欄）時沒人回答，當不能用。
 */
export interface BookFindStatus {
  available: boolean;
  reason?: string;
}

/** `open` 開啟面板、焦點進查詢框；`openReplace` 開啟面板、焦點進替換框。 */
export type BookFindCommandName = 'open' | 'openReplace';

export function queryBookFind(): BookFindStatus {
  const status: BookFindStatus = { available: false, reason: '沒有內建編輯器' };
  window.dispatchEvent(new CustomEvent('nf-bookfind-query', { detail: status }));
  return status;
}

/** 開啟全書查詢替換面板（與 Ctrl+Shift+F / Ctrl+Shift+H 同一件事）。 */
export function commandBookFind(name: BookFindCommandName): void {
  window.dispatchEvent(new CustomEvent('nf-bookfind-command', { detail: { name } }));
}

// ---------------------------------------------------------------- 「檢視」選單

/**
 * 標題欄「檢視」選單問編輯器的狀態（`editor/viewPrefs.ts` 回答）。之後的階段往「檢視」里加的項各自往這裡
 * 加一個欄位、往 `ViewCommandName` 加一個名字即可（選單那一半在 `view/viewMenu.ts`，一組一個函式）。
 */
export interface ViewPrefsStatus {
  /** 編輯器裝上了（外掛與空視窗沒有，那時這幾項置灰）。 */
  available: boolean;
  /** 單擊開啟為臨時標籤（按瀏覽器記，預設開）。 */
  previewTabs: boolean;
  /** 「外觀」那一組（`editor/look.ts` 回答；沒人回答就是 undefined，那組置灰）。 */
  look?: LookStatus;
  /** 「專注」那一組（`editor/focus.ts` 回答；沒人回答就是 undefined，那組置灰）。 */
  focus?: FocusStatus;
}

export type ViewCommandName = 'togglePreviewTabs' | LookCommandName | FocusCommandName;

/** 問編輯器「檢視」那幾項的狀態。editor.js 沒裝時不可用（開關按預設算）。 */
export function queryViewPrefs(): ViewPrefsStatus {
  const status: ViewPrefsStatus = { available: false, previewTabs: true };
  window.dispatchEvent(new CustomEvent('nf-view-query', { detail: status }));
  return status;
}

export function commandViewPrefs(name: ViewCommandName): void {
  window.dispatchEvent(new CustomEvent('nf-view-command', { detail: { name } }));
}

/** 「檢視 → 外觀」：正文字號（另幾項在外觀面板裡）。 */
export interface LookStatus {
  /** 當前字號（px）與預設字號。 */
  fontSize: number;
  defaultFontSize: number;
  /** 到上限 / 下限了沒有（「放大 / 縮小字號」據此置灰）。 */
  canZoomIn: boolean;
  canZoomOut: boolean;
}

/** `zoomIn` / `zoomOut` / `zoomReset` 字號放大、縮小、還原；`openLook` 開啟外觀面板。 */
export type LookCommandName = 'zoomIn' | 'zoomOut' | 'zoomReset' | 'openLook';

/** 「檢視 → 專注」：三個開關（記在 `novelforge.editor.prefs`）與全屏（不記）。 */
export interface FocusStatus {
  focusMode: boolean;
  typewriter: boolean;
  paragraphFocus: boolean;
  fullscreen: boolean;
  /** 頁面能不能全屏（Fullscreen API 的能力探測；不能就置灰）。 */
  fullscreenSupported: boolean;
}

export type FocusCommandName = 'toggleFocusMode' | 'toggleFullscreen' | 'toggleTypewriter' | 'toggleParagraphFocus';

// ---------------------------------------------------------------- 「檢視 → 統計」

/**
 * 「檢視」選單「統計」那一組問編輯器的狀態（`editor/stats.ts` 回答）：狀態列字數那一格除了全文 / 選中，還顯示
 * 哪幾項（按瀏覽器記在 `novelforge.editor.prefs` 的 `stats` 裡）。與 `ViewPrefsStatus` 分開一份：那是別的組的。
 */
export interface StatsStatus {
  /** 編輯器裝上了（外掛沒有，那時這一組置灰）。 */
  available: boolean;
  /** 正文顯示本章字數與目標的進度（預設開）。 */
  goal: boolean;
  /** 顯示本次碼字（預設關）。 */
  session: boolean;
  /** 顯示今日碼字（預設關）。 */
  today: boolean;
}

/** 三個開關，外加「重新開始計時」（本次碼字從現在起重新算）。 */
export type StatsCommandName = 'toggleGoal' | 'toggleSession' | 'toggleToday' | 'restart';

export function queryStats(): StatsStatus {
  const status: StatsStatus = { available: false, goal: true, session: false, today: false };
  window.dispatchEvent(new CustomEvent('nf-stats-query', { detail: status }));
  return status;
}

export function commandStats(name: StatsCommandName): void {
  window.dispatchEvent(new CustomEvent('nf-stats-command', { detail: { name } }));
}

// ---------------------------------------------------------------- 「檢視 → 體檢」

/**
 * 「檢視」選單「體檢」那一組問編輯器的狀態（`editor/check.ts` 回答）：正文裡畫不畫體檢高亮、狀態列顯示不顯示「體檢」
 * 那一格（按瀏覽器記在 `novelforge.editor.prefs` 的 `check` 裡），以及「編輯敏感詞表…」能不能點（沒開啟工程不能）。
 */
export interface CheckStatus {
  /** 編輯器裝上了（外掛沒有，那時這一組置灰）。 */
  available: boolean;
  /** 體檢高亮（預設開）。 */
  highlight: boolean;
  /** 狀態列「體檢」那一格（預設開）。 */
  status: boolean;
  /** 開啟著工程（「編輯敏感詞表…」要它）。 */
  canEditList: boolean;
}

/** 兩個開關，外加「編輯敏感詞表…」（沒有就新建一份模板，然後在編輯器裡開啟）。 */
export type CheckCommandName = 'toggleHighlight' | 'toggleStatus' | 'editList';

export function queryCheck(): CheckStatus {
  const status: CheckStatus = { available: false, highlight: true, status: true, canEditList: false };
  window.dispatchEvent(new CustomEvent('nf-check-query', { detail: status }));
  return status;
}

export function commandCheck(name: CheckCommandName): void {
  window.dispatchEvent(new CustomEvent('nf-check-command', { detail: { name } }));
}

// ---------------------------------------------------------------- 「檢視 → 補全」

/**
 * 「檢視」選單「補全」那一組問編輯器的狀態（`editor/names.ts` 回答）：邊打邊彈開著沒有（按瀏覽器記在
 * `novelforge.editor.prefs` 的 `nameAutoPopup`），當前那塊編輯區裡的檔案能不能補全。與 `ViewPrefsStatus` 分開一份。
 */
export interface NamesStatus {
  /** 編輯器裝上了（外掛沒有，那時這一組置灰）。 */
  available: boolean;
  /** 邊打邊彈名詞補全（預設關）。 */
  auto: boolean;
  /** 名詞高亮（預設開，`editor/nameMarks.ts` 回答）。 */
  highlight: boolean;
  /** 當前那塊編輯區開著的檔案能補全（正文、細綱、角色卡、設定……看後端給的 kind）。 */
  canTrigger: boolean;
  /** 不能補全的原因（選單項置灰時掛在提示上）。 */
  reason?: string;
}

/**
 * `toggleAuto` 開關邊打邊彈；`trigger` 在當前那塊編輯區的游標處彈出名詞補全（與快捷鍵同一件事）；`toggleHighlight`
 * 開關名詞高亮（`editor/nameMarks.ts` 接）。
 */
export type NamesCommandName = 'toggleAuto' | 'trigger' | 'toggleHighlight';

export function queryNames(): NamesStatus {
  const status: NamesStatus = { available: false, auto: false, highlight: false, canTrigger: false, reason: '沒有內建編輯器' };
  window.dispatchEvent(new CustomEvent('nf-names-query', { detail: status }));
  return status;
}

export function commandNames(name: NamesCommandName): void {
  window.dispatchEvent(new CustomEvent('nf-names-command', { detail: { name } }));
}

// ---------------------------------------------------------------- 「幫助 → 快捷鍵一覽」

/** 快捷鍵一覽面板能不能開（`editor/shortcutsPanel.ts` 回答）。editor.js 沒裝（外掛形態，也就沒有標題欄）時不能。 */
export function queryShortcuts(): boolean {
  const status = { available: false };
  window.dispatchEvent(new CustomEvent('nf-shortcuts-query', { detail: status }));
  return status.available;
}

/** 開啟快捷鍵一覽面板（與 `Ctrl+/` 同一件事；開著時再來一下就收起）。 */
export function commandShortcuts(): void {
  window.dispatchEvent(new Event('nf-shortcuts-command'));
}

// ---------------------------------------------------------------- 在「檔案」頁定位

/**
 * 在「檔案」頁定位到某個檔案或目錄（編輯器的麵包屑目錄段、標籤右鍵「在檔案頁中定位」）。資源管理器展開到它、
 * 高亮那一行；view 切到「檔案」頁。編輯器不碰資源管理器的狀態，資源管理器也不讀編輯器的。
 */
export function revealInFiles(path: string, dir = false): void {
  window.dispatchEvent(new CustomEvent('nf-reveal-in-files', { detail: { path, dir } }));
}

// ---------------------------------------------------------------- 在某處彈一個選單

/**
 * 在視口座標 (x, y) 彈一個選單（與右鍵選單同一個引擎、同一種樣子，同時只有一個；點別處 / Esc 收起）。
 * 返回選單節點，view 沒裝時返回 undefined。**呼叫方要 `stopPropagation()` 那一下點選**，否則它冒到
 * document 上就把剛彈出來的選單收掉了。
 */
export function showMenuAt(items: MenuItem[], x: number, y: number): HTMLElement | undefined {
  return window.__nfShowMenu?.(items, x, y);
}

// ---------------------------------------------------------------- 對話頁「加入選區」

/**
 * 內建編輯器當前那塊編輯區裡選中的文字（`editor/index.ts` 回答）。`relPath` 是工作區相對路徑，`start` / `end` 是
 * 1-based 閉區間的行號，`text` 已去掉首尾空白。
 */
export interface EditorSelection {
  relPath: string;
  text: string;
  start: number;
  end: number;
}

/**
 * 問內建編輯器的選區。沒選中、在 Markdown 預覽裡、或者根本沒有內建編輯器（外掛形態，editor.js 沒裝）時返回
 * undefined——對話頁就照舊發不帶選區的 `addSelection`，交給宿主（外掛讀 VS Code 編輯器的選區，獨立版彈貼上框）。
 */
export function querySelection(): EditorSelection | undefined {
  const sel: EditorSelection = { relPath: '', text: '', start: 0, end: 0 };
  window.dispatchEvent(new CustomEvent('nf-selection-query', { detail: sel }));
  return sel.relPath && sel.text ? sel : undefined;
}

// ---------------------------------------------------------------- 敘事線總覽（敘事線重做三期）

/**
 * 工程頁「敘事線」頁籤開啟編輯區裡的「敘事線總覽」（`editor/threadsOverview.ts`）。`focus`：開啟後定位到哪一行——一條線的
 * 檔案路徑，或「未歸屬的伏筆」那份檔案的路徑（右鍵「在總覽裡看」）。
 */
export interface ThreadsOverviewCommand {
  name: 'open';
  focus?: string;
}

/**
 * 有沒有地方畫敘事線總覽。**能力探測**：editor.js 裝上了才有人回答（它探測到 `#wbEditor` 才裝）；外掛形態沒有內建編輯器，
 * 沒人回答就是 false，工程頁上的「總覽」按鈕與「在總覽裡看」都不畫（AGENTS 架構要點：不判斷是哪個殼）。
 */
export function queryThreadsOverview(): boolean {
  const status = { available: false };
  window.dispatchEvent(new CustomEvent('nf-threads-query', { detail: status }));
  return status.available;
}

export function commandThreadsOverview(focus?: string): void {
  const detail: ThreadsOverviewCommand = { name: 'open', ...(focus ? { focus } : {}) };
  window.dispatchEvent(new CustomEvent('nf-threads-command', { detail }));
}

// ---------------------------------------------------------------- 時間線總覽（2026-10-24）

/**
 * 工程頁「時間線」組開啟編輯區裡的「時間線總覽」（`editor/timelineOverview.ts`）。`chapter`：開啟後展開哪一章、滾過去（點一章、
 * 點一條帶章號的 ⚠）。
 */
export interface TimelineOverviewCommand {
  name: 'open';
  chapter?: number;
}

/** 有沒有地方畫時間線總覽。**能力探測**（同 {@link queryThreadsOverview}）：外掛形態沒有內建編輯器，沒人回答就是 false。 */
export function queryTimelineOverview(): boolean {
  const status = { available: false };
  window.dispatchEvent(new CustomEvent('nf-timeline-query', { detail: status }));
  return status.available;
}

export function commandTimelineOverview(chapter?: number): void {
  const detail: TimelineOverviewCommand = { name: 'open', ...(chapter !== undefined ? { chapter } : {}) };
  window.dispatchEvent(new CustomEvent('nf-timeline-command', { detail }));
}

// ---------------------------------------------------------------- 工程頁「存檔點…」

/**
 * 內建編輯器裡開著、有未儲存修改的檔案（`editor/index.ts` 回答，與全書替換跳過的是同一批）。存檔點退回時隨請求帶上，
 * 後端跳過它們——不拿存檔點裡的舊稿去蓋編輯器裡還沒存下的字。沒有內建編輯器（外掛形態，editor.js 沒裝）時沒人回答，
 * 是空的：VS Code 自己的編輯器有它自己那一套。
 */
export function queryDirtyPaths(): string[] {
  const detail = { paths: [] as string[] };
  window.dispatchEvent(new CustomEvent('nf-dirty-query', { detail }));
  return detail.paths;
}
