/**
 * 一塊編輯區的型別，以及它那些 DOM 節點的引用。
 *
 * 兩塊編輯區（正文 / 草稿）是同一個 `createPane` 工廠的兩個例項：主區綁頁面上
 * 固定 id 的節點，草稿區在首次用到時克隆同樣的結構現造。把「哪些節點」這件事
 * 收在這裡，pane.ts 就只關心行為。
 */
import { byId, el, spacer } from '../dom';
import type { ArtifactKind, EditorFileLabel, EditorPane } from '../protocol';
import type { EditHistory } from './history';

/** 一塊編輯區裡所有需要操作的節點。 */
export interface PaneRefs {
  root: HTMLElement;
  tabs: HTMLElement;
  toolbar: HTMLElement;
  path: HTMLElement;
  saveBtn: HTMLButtonElement;
  revertBtn: HTMLButtonElement;
  previewBtn: HTMLButtonElement;
  plotBtn: HTMLButtonElement;
  draftBtn: HTMLButtonElement;
  externalBtn: HTMLButtonElement;
  area: HTMLTextAreaElement;
  preview: HTMLElement;
  welcome: HTMLElement;
  conflict: HTMLElement;
  conflictText: HTMLElement;
  conflictTake: HTMLButtonElement;
  conflictForce: HTMLButtonElement;
  statusWords: HTMLElement;
  statusPos: HTMLElement;
  statusSave: HTMLElement;
  statusFile: HTMLElement;
}

/**
 * 編輯器裡的一份檔案。
 *
 * `text` 是磁碟基線，`draft` 是編輯器裡的當前內容，兩者不等即為髒；
 * `hash` 是儲存時的樂觀鎖基線，磁碟上變了就報衝突而不是覆蓋。
 */
export interface OpenFile {
  path: string;
  name: string;
  text: string;
  hash: string;
  draft: string;
  /** 這份檔案是某章正文時，它草稿的路徑（後端給，前端不自己判斷什麼算章節）。 */
  draftPath?: string;
  /**
   * 這份檔案在工程裡是什麼（後端 `kindOfPath` 給的）。`chapter` / `draft` 是正文（`api.ts` 的
   * `isProse`），其餘是角色卡、細綱、設定等。後端沒給（沒開啟工程、舊資料）時當非正文。
   */
  kind?: ArtifactKind;
  /**
   * 標籤與工具欄上怎麼稱呼它（後端 `views/editorLabel.ts` 算的：型別短標記、去掉副檔名的名字、麵包屑）。
   * 沒給（沒開啟工程）時標籤寫檔名、工具欄寫原始路徑。
   */
  label?: EditorFileLabel;
  /**
   * 臨時標籤（單擊開啟的，名字斜體）：每塊編輯區最多一個，下一次單擊開啟別的檔案時它的位置被換掉。
   * 編輯、儲存、雙擊標籤、在工程頁 / 檔案頁雙擊那一行、「固定」，或被別的路子正常開啟一次，就轉正。
   * **有未儲存修改的標籤永遠不是臨時的**（一改就轉正），所以換掉它從來不會丟字。
   */
  preview?: boolean;
  /**
   * 這一份此刻在 Markdown 預覽裡（不是在編輯）。**每個標籤各記各的**：切走再切回來照舊，搬到另一塊、改名搬家、重新整理恢復
   * 都跟著（⚑ 重新整理也記）。只對 `.md` / `.markdown` 有意義。別和上面的 `preview`（臨時標籤）混了。
   */
  markdownPreview?: boolean;
  /** 在預覽裡時切走那一刻預覽的滾動位置，切回來放回去。 */
  previewScrollTop?: number;
  caret: number;
  scrollTop: number;
  /**
   * 這份檔案自己的撤銷歷史（`history.ts`）。切標籤不丟，關標籤隨檔案一起丟，重新整理不恢復；
   * 搬到另一塊編輯區 / 改名時跟著搬（見 `CarriedDraft`）。
   */
  history: EditHistory;
  /**
   * 磁碟上已經沒有這份了（被刪、被改名；`editorDiskGone`）。編輯器裡的內容還在；儲存時先問要不要在原路徑
   * 重建，自動儲存跳過它；磁碟上又出現了（核對磁碟時）就清掉。
   */
  gone?: boolean;
}

/** 衝突時暫存的磁碟版本，供「用磁碟版本覆蓋」使用。 */
export interface Conflict {
  text: string;
  hash: string;
}

/**
 * 從另一塊編輯區（或重新整理前的 localStorage）帶過來的未儲存內容。
 *
 * `moved` 表示檔案剛改名/搬家——那時 hash 基線必然變了，草稿照貼；
 * 其餘情況（重新整理恢復）仍要求磁碟沒變過，否則拿舊內容蓋新內容就是
 * 另一種靜默覆蓋。
 *
 * `history` / `historyText`：搬家時連撤銷歷史一起帶上（重新整理恢復沒有）。只有接上之後的內容與
 * 搬走時（`historyText`）一字不差才接——否則那份差異對不上位置。
 *
 * `preview`：搬走時是不是臨時標籤（重新整理恢復、改名搬家時照舊）。`markdownPreview`：搬走時是不是在 Markdown 預覽裡（同樣照舊）。
 *
 * `local`：標籤右鍵「移到另一側」——就在頁面裡從一塊搬到另一塊，接手的那一塊收到的檔案就是搬走時的
 * 基線（不經後端重讀），所以連衝突條、見過的磁碟新版、「磁碟上沒了」與游標位置一起接上。
 */
export interface CarriedDraft {
  hash?: string;
  draft?: string;
  moved?: boolean;
  history?: EditHistory;
  historyText?: string;
  preview?: boolean;
  markdownPreview?: boolean;
  local?: boolean;
  gone?: boolean;
  conflict?: { text: string; hash: string; reopen?: boolean };
  diskSeen?: string;
  caret?: number;
  scrollTop?: number;
}

/** 從頁面上固定的 id 收集主區的節點引用。 */
export function mainRefs(root: HTMLElement): PaneRefs {
  return {
    root,
    tabs: byId('edTabs'),
    toolbar: byId('edToolbar'),
    path: byId('edPath'),
    saveBtn: byId('edSaveBtn'),
    revertBtn: byId('edRevertBtn'),
    previewBtn: byId('edPreviewBtn'),
    plotBtn: byId('edPlotBtn'),
    draftBtn: byId('edDraftBtn'),
    externalBtn: byId('edExternalBtn'),
    area: byId('edArea'),
    preview: byId('edPreview'),
    welcome: byId('edWelcome'),
    conflict: byId('edConflict'),
    conflictText: byId('edConflictText'),
    conflictTake: byId('edConflictTake'),
    conflictForce: byId('edConflictForce'),
    statusWords: byId('edStatusWords'),
    statusPos: byId('edStatusPos'),
    statusSave: byId('edStatusSave'),
    statusFile: byId('edStatusFile'),
  };
}

/**
 * 現造一塊編輯區的 DOM，結構與 html.ts 裡的主區一致。
 *
 * 草稿區的結構不寫進 html.ts：同一套四十行的 DOM 要在兩個地方對齊，
 * 遲早會分叉。這裡克隆一份，引用直接握在手裡——**不給 id**，省得與主區撞車。
 */
export function createPaneElements(welcomeText: string): PaneRefs {
  const root = el('section', 'wb-editor wb-editor-draft');
  const tabs = el('div', 'ed-tabs');

  const toolbar = el('div', 'ed-toolbar hidden');
  const path = el('span', 'ed-path');
  const previewBtn = el('button', 'chip-btn', '預覽');
  previewBtn.title = '預覽 Markdown';
  const plotBtn = el('button', 'chip-btn hidden', '細綱');
  plotBtn.title = '開啟這一章的細綱（並排；還沒有就按模板建一份）';
  const draftBtn = el('button', 'chip-btn hidden', '草稿');
  const revertBtn = el('button', 'chip-btn', '還原');
  revertBtn.title = '放棄修改，重新從磁碟讀取';
  const externalBtn = el('button', 'chip-btn ed-external-btn', '外部開啟');
  externalBtn.title = '用系統預設程式開啟';
  const saveBtn = el('button', 'primary', '儲存');
  saveBtn.title = '儲存（Ctrl+S）';
  toolbar.append(path, previewBtn, plotBtn, draftBtn, revertBtn, externalBtn, saveBtn);

  const conflict = el('div', 'ed-conflict hidden');
  const conflictText = el('span', 'ed-conflict-text');
  const conflictTake = el('button', 'chip-btn', '用磁碟版本覆蓋編輯器');
  const conflictForce = el('button', 'chip-btn', '用編輯器內容強制儲存');
  conflict.append(conflictText, conflictTake, conflictForce);

  // 查詢替換條不在這裡：兩塊編輯區都由 find.ts 第一次用到時現造（DOM 只在那裡生成一份）。
  const stage = el('div', 'ed-stage');
  const welcome = el('div', 'ed-welcome');
  welcome.appendChild(el('h2', undefined, welcomeText));
  const area = el('textarea', 'ed-area hidden');
  area.spellcheck = false;
  area.wrap = 'soft';
  const preview = el('div', 'ed-preview hidden');
  stage.append(welcome, area, preview);

  const status = el('div', 'ed-status');
  const statusFile = el('span');
  const statusWords = el('span');
  const statusPos = el('span');
  const statusSave = el('span', 'ed-save-state');
  status.append(statusFile, statusWords, spacer(), statusPos, statusSave);

  root.append(tabs, toolbar, conflict, stage, status);

  return {
    root, tabs, toolbar, path, saveBtn, revertBtn, previewBtn, plotBtn, draftBtn, externalBtn,
    area, preview, welcome, conflict, conflictText, conflictTake, conflictForce,
    statusWords, statusPos, statusSave, statusFile,
  };
}

/** pane 的 id 與協議裡的 `EditorPane` 是同一套取值。 */
export type PaneId = EditorPane;
