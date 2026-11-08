import { ConfigStore, initConfigFromHost } from './config';
import { NovelProject } from './model/project';
import { Attachment } from './model/session';
import { EditorFileCheck, EditorOpenIntent, EditorPane } from './protocol';
import type { CallAnswer, CallPrompt } from './model/callChoice';

/**
 * core 對宿主的唯一依賴面。VS Code 外掛與獨立 Web 服務各實現一份。
 * 所有互動類方法（input/confirm/pick）在獨立版裡經 WebSocket 變成網頁彈窗。
 */

export interface InputOptions {
  title?: string;
  prompt?: string;
  value?: string;
  placeHolder?: string;
  password?: boolean;
  /** 多行文字輸入（獨立版渲染 textarea）。 */
  multiline?: boolean;
  validate?: (value: string) => string | undefined;
}

export interface PickChoice<T = string> {
  label: string;
  description?: string;
  detail?: string;
  /** 分組標題，同組只出現一次。 */
  group?: string;
  value: T;
}

export interface Disposable { dispose(): void; }

export interface Host {
  /**
   * 殼的名字，**只用於日誌與診斷**。
   *
   * 禁止拿它做分支（`host.name === 'standalone' ? … : …`）：能力差異一律表達成
   * 「宿主有沒有這個方法」，或由殼在渲染頁面時決定產出什麼。按身份分支會腐爛——
   * 從前 buildState 裡就有一句這樣的判斷，用來決定設定頁那行儲存說明怎麼寫，
   * 後來兩個殼都換成了 FileConfigStore，外掛那半邊分支沒人想起來改，於是外掛
   * 形態長期顯示著一句已經不成立的話。這條約束由 tests/contract/shellPurity.test.js 守著。
   */
  readonly name: 'vscode' | 'standalone';
  /** 該宿主能否提供 vscode-lm（Copilot）模型。 */
  readonly supportsVscodeLm: boolean;
  /** 設定讀寫後端：外掛暫用 settings.json，獨立版用 ~/.novelwarden/config.json。 */
  readonly config: ConfigStore;

  input(opts: InputOptions): Promise<string | undefined>;
  /** 每個 action 都是一顆按鈕，返回使用者點選的那個文案；取消返回 undefined。 */
  confirm(message: string, actions: string[], opts?: { modal?: boolean; detail?: string }): Promise<string | undefined>;
  /**
   * 調模型之前的那一問：與 `confirm` 一樣的按鈕，另讓作者為這一次挑模型與上下文詳細度（`call` 是
   * 兩個下拉框的選項與預設）。返回點的按鈕與作者的選擇；取消返回 undefined。core 只經
   * `features/askCall.ts` 調它，挑完的活跑在 `withCallChoice` 裡（runtime/callScope.ts）。
   */
  confirmCall(message: string, actions: string[], opts: { detail?: string; call: CallPrompt }): Promise<CallAnswer | undefined>;
  pick<T>(choices: PickChoice<T>[], title: string): Promise<T | undefined>;
  /** 可取消的長任務。report 用於更新進度文案。 */
  progress<T>(title: string, fn: (signal: AbortSignal, report: (message: string) => void) => Promise<T>): Promise<T>;
  /** 監聽工程目錄變化（章節/後設資料）。onChange 的防抖由實現方負責。 */
  watch(project: NovelProject, onChange: () => void): Disposable;
  /**
   * 開啟某相對路徑檔案。獨立版降級為 toast 提示路徑。
   * `intent`（臨時標籤 / 原位換掉）只有內建編輯器認，原樣帶回 `editorOpen`；別的宿主不管它。
   */
  openFile(relPath: string, intent?: EditorOpenIntent): Promise<void>;
  toast(message: string, level?: 'info' | 'error'): void;

  /**
   * 「加入選區」：外掛取編輯器選區；獨立版彈貼上框。返回 undefined 表示放棄。
   * 獨立版內建編輯器裡選著字時前端直接把選區帶上來（`addSelection.selection`），不走這裡。
   */
  selectionAttachment(project: NovelProject): Promise<Attachment | undefined>;
  /** 「瀏覽工作區檔案」：外掛彈檔案對話方塊；獨立版提示輸入相對路徑。可選。 */
  browseFile?(project: NovelProject): Promise<string | undefined>;
  /**
   * 選本機任意一個檔案（拆書的 txt 不必先放進工程）：外掛彈 VS Code 的開啟對話方塊，獨立版開網頁裡的
   * 本機目錄選擇器。返回**絕對路徑**，作者取消返回 undefined。`extensions` 不帶點（如 `['txt']`）。
   * 只給作者親手點的入口用；MCP 那條路不走它——外部 agent 不讀工程外的檔案。可選。
   */
  pickHostFile?(opts: { title: string; extensions: string[]; startDir?: string }): Promise<string | undefined>;
  /**
   * 在宿主自己的編輯器裡開啟一個文字檔案。
   *
   * 獨立版實現為「讀檔案 → 廣播 editorOpen」，網頁裡開內建編輯器；
   * 外掛殼不實現——那邊 openFile 已經開的是 VS Code 真正的編輯器 tab，
   * controller 會自動回落到 openFile。
   *
   * `pane` 只有獨立版認：指明開在主區還是草稿區。`intent` 原樣帶回 `editorOpen`（見 `EditorOpenIntent`）。
   */
  openInEditor?(relPath: string, pane?: EditorPane, intent?: EditorOpenIntent): Promise<void>;
  /**
   * 「在旁邊開啟」：與當前正在編輯的檔案並列顯示。草稿走這一條。
   *
   * 外掛用 ViewColumn.Beside 開第二欄，獨立版開第二塊編輯區。
   * 宿主不實現時 controller 回落到 openFile（退化為普通開啟，不併列）。
   */
  openBeside?(relPath: string, intent?: EditorOpenIntent): Promise<void>;
  /**
   * 儲存內建編輯器的內容。只有提供 openInEditor 的宿主才需要實現。
   * 帶了 `baseHash`、磁碟上卻沒有這個檔案時不重建（回 `editorDiskGone`），`opts.recreate` 才重建。
   */
  saveFromEditor?(relPath: string, text: string, baseHash?: string, opts?: { recreate?: boolean }): Promise<void>;
  /**
   * 核對內建編輯器裡開著的幾份檔案在磁碟上變沒變（`checkEditorFiles`）：變了的推 `editorDiskChanged`，
   * 讀不到的推 `editorDiskGone`，沒變的不推。只有提供 openInEditor 的宿主才需要實現。
   */
  checkEditorFiles?(files: readonly EditorFileCheck[]): Promise<void>;
  /** 用系統預設程式開啟。獨立版用它實現編輯器裡的「在外部開啟」。 */
  openExternal?(relPath: string): Promise<void>;
  /**
   * 覆蓋前審閱：外掛開 diff 編輯器；獨立版開段級 diff / 合併檢視（五期 W11）。返回 undefined=取消。
   *
   * 起初只給角色卡用，後來 `workspace/guard.ts` 的 `reviewOverwrite` 把大綱、
   * 細綱、設定、正文的覆蓋也接了進來——所以 `name` 只是給人看的稱呼，定位現有檔案
   * 一律認 `relPath`（按名字找角色卡只是它缺席時的回落）。
   *
   * `opts.merge`：呼叫方收得下「作者挑過、改過的那一份」。給了的宿主**可以**交回 `{ merged }`
   * （獨立版的合併檢視）；不認它的宿主照舊只答採納 / 放棄（VS Code 的 diff 編輯器）。
   * 沒請求合併的呼叫方（角色卡、設定條目那幾處）永遠只拿到採納 / 放棄。
   */
  reviewReplace?(
    name: string,
    currentText: string,
    proposedText: string,
    relPath?: string,
    opts?: { merge?: boolean }
  ): Promise<ReviewVerdict>;
  /**
   * 兩份還沒落盤的文字逐段挑（刪修飾：刪之前 ↔ 刪之後）。與 `reviewReplace` 的差別是左邊不是磁碟上的
   * 檔案。交回 `{ merged }`（挑過）、`'apply'`（原樣用 `after`）、`'discard'` 或 undefined（放棄，不寫）。
   * 獨立版用合併檢視實現；VS Code 的 diff 編輯器左邊認的是磁碟檔案，不實現——呼叫方就直接用 `after`。
   *
   * `opts`（可選，不給就是從前的樣子）：兩欄叫什麼、採納那顆按鈕寫什麼、標題下面那一行（檔案路徑）。
   * 內建編輯器衝突時的「對比合併」（磁碟上的 ↔ 編輯器裡的）與歷史版本的「對比」（快照 ↔ 編輯器裡的）用它。
   */
  mergeTexts?(title: string, before: string, after: string, opts?: MergeTextsOptions): Promise<ReviewVerdict>;
  /**
   * 在編輯器裡開啟這份檔案並選中這一句（五期：點審稿報告上的引文）。找不到那一句時只開啟、
   * 返回 false。宿主不實現時 controller 退回 `openFile` 並提示那一句。
   */
  revealText?(relPath: string, quote: string): Promise<boolean>;
  /** 「在 VS Code 設定中開啟」，僅外掛實現。 */
  openNativeSettings?(): Promise<void>;
}

/** 覆蓋審閱的回答：採納新版、保留原樣、取消，或者作者在合併檢視裡挑過、改過的那一份。 */
export type ReviewVerdict = 'apply' | 'discard' | undefined | { merged: string };

/** `Host.mergeTexts` 的可選項。 */
export interface MergeTextsOptions {
  /** 兩欄的稱呼：左邊 `before`、右邊 `after`。預設「原文 / 新版」。 */
  sides?: { before: string; after: string };
  /** 採納那顆按鈕上的字。預設「寫入合併結果」。 */
  applyLabel?: string;
  /** 標題下面那一行（檔案路徑之類）。 */
  message?: string;
}

/**
 * 沒請求合併的呼叫方拿到的回答。宿主只在 `opts.merge` 時才可能交回 `{ merged }`；萬一交回了
 * （契約被破壞），當成取消——寧可這一次不寫，也不拿「新版全文」頂替作者挑過的那一份。
 */
export function plainVerdict(v: ReviewVerdict): 'apply' | 'discard' | undefined {
  return typeof v === 'object' ? undefined : v;
}

let current: Host | undefined;

export function initHost(host: Host): void {
  current = host;
  initConfigFromHost(host);
}

export function getHost(): Host {
  if (!current) {
    throw new Error('Host 尚未初始化');
  }
  return current;
}
