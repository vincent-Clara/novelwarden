import type { DirListing } from '../files/fileTree';
import type { CallPrompt } from '../model/callChoice';
import type { LogEntry } from '../runtime/logger';
import type { TaskOpen, TaskSnapshot } from '../runtime/progress';
import type { SkillSource, SkillStage } from '../model/writingSkill';
import type { ArtifactKind } from '../workspace/kind';
import type { QuickOpenIndex } from './quickOpen';
import type { CheckTermsView } from './check';
import type { NameIndex } from './nameIndex';
import type { ThreadsOverview } from './threadsOverview';
import type { TimelineOverview } from './timelineOverview';
import type { BookFindResult, BookReplaceSummary } from './bookFind';
import type { CheckpointDiffView, CheckpointView } from './checkpoints';
import type {
  EditorOpenIntent,
  EditorPane,
  SerializedAttachment,
  SettingsPayload,
  Tab,
} from './in';
import type {
  ChapterIndexEntry,
  PlotPipelineView,
  PlotSummaryView,
  NextStepView,
  ProjectTree,
  SerializedDigest,
  SerializedSession,
  SerializedTurn,
  SessionListItem,
  ViewState,
  WorkbenchView,
} from './views';

/** 擴充套件 → Webview */
export type OutMessage =
  | { type: 'init'; state: ViewState }
  | { type: 'state'; state: ViewState }
  | { type: 'tab'; tab: Tab }
  | { type: 'session'; session: SerializedSession }
  | { type: 'sessions'; list: SessionListItem[] }
  /**
   * 模型**自己說的話**的增量。前端追加到當前那一段文字上。
   *
   * 工具產出的正文不走這條（那是 `toolDelta`）：`generate` 內部那次呼叫會流出
   * 幾千字產物，從前它和這一條擠在同一條通道里，於是「我先看看工程結構」和
   * 一份 6104 字的大綱拼在同一個文字節點裡，誰也認不出邊界在哪。
   */
  | { type: 'delta'; turnId: string; text: string }
  /**
   * 某個工具產出的正文增量（目前只有 `generate`）。前端追加到那一次呼叫的卡片裡。
   *
   * 認 `callId` 而不認 turnId 就夠了那一半：一輪裡可能連著生成好幾份，各自
   * 一張卡。
   */
  | { type: 'toolDelta'; turnId: string; callId: string; text: string }
  | { type: 'reasoning'; turnId: string; text: string }
  /**
   * 寫正文的進度（W7）：第幾輪（0 = 第一次呼叫，k = 自動續寫第 k 輪）、這一章寫到多少字了、
   * 目標多少。流式期間約 300ms 一次。前端在流式氣泡頂上畫一條進度。
   */
  | { type: 'writeProgress'; turnId: string; round: number; words: number; target?: number }
  /**
   * 流式氣泡退回到這一份文字：正文續寫丟棄了一輪（被截斷又沒寫出東西），那一輪已經流進
   * 氣泡裡了，不退回去作者看著的是一段不會被寫入的文字。
   */
  | { type: 'streamReset'; turnId: string; text: string }
  /**
   * agent 要調一個工具了。前端在氣泡裡掛一條摺疊條。
   *
   * `argsText` 是模型填的引數（JSON 文字，已截斷）：展開那一條就能看到它這一步
   * 到底動的是哪個路徑、搜的是哪個詞。還沒有結果，所以這時只有引數。
   */
  | {
      type: 'toolCall';
      turnId: string;
      callId: string;
      name: string;
      title?: string;
      detail?: string;
      argsText?: string;
    }
  /**
   * 工具跑完了。`summary` 是那一行上的**展示摘要**（幾行、幾處命中）。
   *
   * `argsText` / `resultText` 是展開後才畫的明細，**都已截斷**——工具的完整
   * 返回值可能是幾萬字，直接攤在氣泡裡會把作者要看的那段回答擠出螢幕。
   * 引數在這裡再帶一遍，是因為前端拿到結果時會整條重建那一行。
   */
  | {
      type: 'toolResult';
      turnId: string;
      callId: string;
      name: string;
      ok: boolean;
      summary: string;
      elapsedMs: number;
      argsText?: string;
      resultText?: string;
    }
  /**
   * 要動手了，等作者點頭。**問在對話頁裡，不是一個蓋住整個視窗的模態框。**
   *
   * 全域模態框把作者從他正在看的東西上拽走：他要判斷的恰恰是「這一步動的是
   * 哪個檔案」，而那串上下文就在被蓋住的訊息流裡。所以這一條畫成**輸入框上方
   * 那一格里的一張卡片**——不跟著訊息流滾（迴圈正卡在這一問上，一張會滾出視野
   * 的卡片等於沒人看見），頁面照常能滾、能翻、能點別的。
   *
   * `turnId` / `callId` 仍然帶著：答完之後前端往那一輪的工具串（或產物正文
   * 下面）補一行「已跳過/已允許」當記錄。
   *
   * **兩種問法共用這一條**：外部 agent 的 `always` 動作動手前（`controller/mcp.ts`），以及
   * **產物落盤前那一句**（第 19 條，任何情況下都問）。兩種都只有兩顆按鈕
   * ——**叫停整輪不在這張卡上**，那是輸入框旁邊那顆「停止」；與「這一個
   * 檔案要不要動」是兩件事，混進閘門只會被誤當成「跳過」。
   *
   * `requestId` 是這次詢問的身份（不是 `callId`：同一次呼叫在重連後會重發
   * 同一條詢問，回答要認得出是哪一次）。按鈕上的字一律由後端給，前端不寫死
   * ——改一次文案兩邊就對不上。
   */
  | {
      type: 'gate';
      requestId: string;
      turnId: string;
      callId?: string;
      name: string;
      title: string;
      detail?: string;
      argsText?: string;
      proceed: string;
      skip: string;
      /**
       * 要作者特別留意的一句（畫成紅色塊）。目前只有正文重演：開頭與上一章結尾大段重合，
       * 這裡是重合的那一段原文。
       */
      danger?: string;
      /**
       * 給了就要點兩下才算同意：第一下把按鈕上的字換成它，第二下才發出去。按鈕文案兩段式，
       * 不疊彈窗（總計劃 §2.4）。
       */
      confirm?: string;
      /**
       * 給了就在按鈕上方多一格理由輸入框與第三顆按鈕（`label`），填了理由才能點；點了算同意，
       * 理由隨 `gateResult.remember` 帶回。目前只有一致性預檢用它：「記為刻意安排，照寫」
       * （五期補遺 §2）。
       */
      remember?: { label: string; placeholder: string };
    }
  /**
   * 那張卡片可以收了：作者在另一個檢視上答了，或者這一輪被取消/結束了。
   *
   * 兩個檢視（側邊欄與編輯器標籤頁）掛的是同一個 controller，只在被點的那
   * 一邊收卡片的話，另一邊會留著一張點了沒反應的卡。
   */
  | { type: 'gateDone'; requestId: string; verdict: 'proceed' | 'skip' | 'cancelled' }
  | { type: 'turnDone'; turn: SerializedTurn }
  | { type: 'context'; turnId: string; digest: SerializedDigest }
  /**
   * 回 `copyContext`：拼好的完整上下文（`model/session.ts` 的 `renderContextText`），或者為什麼
   * 拿不到。認不出的 `requestId` 前端靜默丟棄（另一個檢視點的）。
   */
  | { type: 'contextText'; requestId: string; text?: string; error?: string }
  | { type: 'busy'; value: boolean }
  | { type: 'attachments'; items: SerializedAttachment[] }
  | { type: 'project'; tree: ProjectTree }
  /**
   * 內建編輯器的章節索引（章節條、上一章 / 下一章）：一個章號一行，升序。**哪個頁籤都推**——工程樹只在
   * 「工程」頁籤開著時推，作者大多待在對話頁。隨 `init` 推一次，之後每次 `pushState` 都算（與 `state` 裡
   * 目標下拉那份同一趟流水線索引，不多讀盤），**內容變了才推**。
   */
  | { type: 'chapterIndex'; chapters: ChapterIndexEntry[] }
  /**
   * 內建編輯器「寫作體檢」的詞表（禁用詞與自定義敏感詞表，`protocol/check.ts`）。隨 `init` 推一次，之後每次
   * `pushState` 都現算，**內容變了才推**；只給有內建編輯器的宿主推。
   */
  | { type: 'checkTerms'; terms: CheckTermsView }
  | { type: 'summary'; summary: PlotSummaryView }
  /** 回 `requestQuickOpen`：「轉到…」面板要的索引。認不出的 `requestId` 前端靜默丟棄（另一個檢視要的）。 */
  | { type: 'quickOpenIndex'; requestId: string; index: QuickOpenIndex }
  /**
   * 回 `requestNameIndex`：「名詞補全」要的名詞表。`sig` 是這份表的指紋；與請求裡的 `have` 對得上時不帶 `index`
   * （前端手上那份就是最新的）。認不出的 `requestId` 前端靜默丟棄。
   */
  | { type: 'nameIndex'; requestId: string; sig: string; index?: NameIndex }
  /**
   * 回 `requestThreadsOverview`：編輯區「敘事線總覽」標籤要的矩陣（章 × 線，`protocol/threadsOverview.ts`）。認不出的
   * `requestId` 前端靜默丟棄（另一個檢視要的）。
   */
  | { type: 'threadsOverview'; requestId: string; overview: ThreadsOverview }
  /** 回 `requestTimelineOverview`：編輯區「時間線總覽」標籤要的資料（`protocol/timelineOverview.ts`）。認不出的 `requestId` 前端靜默丟棄。 */
  | { type: 'timelineOverview'; requestId: string; overview: TimelineOverview }
  | {
      type: 'pipeline';
      pipeline?: PlotPipelineView;
      next?: NextStepView;
      workbench: WorkbenchView;
    }
  | { type: 'settings'; settings: SettingsPayload; keys: Record<string, boolean>; ack?: 'saved' | 'rejected' }
  /**
   * 設定頁「技能」：技能庫與本工程的階段繫結。每次切到那一頁、裝卸綁之後重推（每次都重掃：作者可能
   * 剛手放了一份進來）。`installed`：剛裝好的那一份的 id，前端據此收起檢查結果。
   */
  | { type: 'skills'; view: SkillsView; installed?: string }
  /** 「檢查」的結果：給了 `inspection` 是檢查成了（不等於裝得了，見 `blockers`），給了 `error` 是沒檢查成。 */
  | { type: 'skillInspection'; url: string; inspection?: SkillInspectionView; error?: string }
  | { type: 'toast'; message: string; level: 'info' | 'error' }
  /** `preview` / `replace` 是開啟請求上帶的那兩個標記（`EditorOpenIntent`），原樣帶回。 */
  | ({ type: 'editorOpen'; file: EditorFileView; pane?: EditorPane } & EditorOpenIntent)
  | { type: 'editorSaved'; file: EditorFileView }
  | { type: 'editorConflict'; path: string; diskText: string; diskHash: string }
  | { type: 'editorError'; path: string; message: string }
  /**
   * `checkEditorFiles` 的回答：這份檔案在磁碟上與編輯器知道的那份不一樣了（定稿寫回細綱、批次寫章、
   * 外部 agent 的 `edit`、外部編輯器 / git 改了它），帶上磁碟上的新版。編輯器就地換掉沒改過的標籤、
   * 給改過的掛衝突條——**不切標籤、不搶焦點**（這正是它不復用 `editorOpen` 的原因）。
   */
  | { type: 'editorDiskChanged'; file: EditorFileView }
  /**
   * 磁碟上已經沒有這份檔案了（被刪、被改名）。兩處會發：`checkEditorFiles` 讀不到它；`saveFile` 帶了基線、
   * 檔案卻不在、又沒說 `recreate`（此時什麼都沒寫）。
   */
  | { type: 'editorDiskGone'; path: string }
  /**
   * 在編輯區裡選中這一句並滾到它（五期 W10：點審稿報告上的引文）。緊跟在那一份的 `editorOpen`
   * 之後推。定位按 model/review.ts 的 `locateQuote`（與引文校驗同一個歸一化）。
   */
  | { type: 'editorReveal'; path: string; quote: string }
  /**
   * 把編輯區裡這份檔案換成這段文字（`Pane.applyEdit`：一步撤銷，成為未儲存，不寫盤）。衝突條「對比合併」
   * 採納之後帶 `base`：樂觀鎖基線換成磁碟上那一份（衝突條隨之收起，之後照常 Ctrl+S，不必強制儲存）。
   * **只有發起的那個頁面認**（`requestId`）——回覆是廣播，同一個工程開著兩個視窗時，另一個視窗裡那一份不該被換掉。
   */
  | { type: 'editorReplace'; requestId: string; path: string; text: string; base?: { text: string; hash: string } }
  /**
   * 這份檔案的歷史版本（快照與存檔點裡的樣子混排，新的在前）。`unavailable`：不存歷史版本的原因（不是工程裡的
   * 創作產物、還不是小說工程……），這時 `entries` 是空的。
   */
  | { type: 'versions'; path: string; entries: VersionView[]; unavailable?: string }
  /** 回 `readVersion`：那一版的全文；讀不到時給 `error`。 */
  | { type: 'versionText'; requestId: string; path: string; id: string; text?: string; error?: string }
  /**
   * 存檔點列表（`protocol/checkpoints.ts`），新的在前。`unavailable`：存不了的原因（還不是小說工程），這時
   * `entries` 是空的。
   */
  | { type: 'checkpoints'; entries: CheckpointView[]; unavailable?: string }
  /** 回 `checkpointDiff`：這個存檔點跟現在比。存檔點不在了（被裁掉、清單壞了）給 `error`。 */
  | { type: 'checkpointDiff'; id: string; diff?: CheckpointDiffView; error?: string }
  /** 回 `bookFind`：全書查詢（或預覽替換）的結果。認不出的 `requestId` 前端靜默丟棄（另一個視窗要的、或已經叫停的）。 */
  | { type: 'bookFindResult'; requestId: string; result: BookFindResult }
  /** 回 `bookReplace`：替換了幾個檔案幾處、跳過了哪些與為什麼、指紋鏈怎麼處理的。之後緊跟一次 `pushState`。 */
  | { type: 'bookReplaceDone'; requestId: string; summary: BookReplaceSummary }
  | { type: 'dirListings'; listings: DirListing[] }
  | { type: 'filesOpDone'; op: 'rename' | 'move' | 'copy'; results: FileOpResult[] }
  | { type: 'tasks'; tasks: TaskSnapshot[] }
  /** 長任務說完了那一句（D24）：前端出一條提示，帶按鈕時點了開啟那一章。 */
  | { type: 'taskDone'; title: string; message: string; level: 'info' | 'error'; open?: TaskOpen }
  | { type: 'log'; entry: LogEntry }
  | { type: 'logs'; entries: LogEntry[] }
  | { type: 'logHistory'; entries: LogEntry[]; exhausted: boolean }
  | {
      type: 'prompt';
      requestId: string;
      /**
       * `merge`（五期 W11）：覆蓋審閱的段級 diff / 合併檢視。`current` / `proposed` 是兩個版本，
       * `mergeable` 為真時可以逐段挑、結果可以手改，回的是 `{"verdict":"apply"|"discard","merged"?}`
       * 的 JSON；為假時只讀，只有採納 / 放棄。`sides` 是兩欄的稱呼（預設「原文 / 新版」，按鈕上的字跟著變），
       * `applyLabel` 是採納那顆按鈕上的字（預設「寫入合併結果」）——衝突時的對比合併與歷史版本的對比
       * 不寫盤，是「放回編輯器」。
       *
       * `file`：選本機任意一個檔案（`Host.pickHostFile`）。`value` 是起始目錄，`options` 是允許的副檔名
       * （不帶點），回的是選中檔案的絕對路徑；取消回 undefined。
       *
       * `confirm` 的 `value` 是補充說明（`Host.confirm` 的 `detail`），多行；`actions` 是按鈕，一個一顆，回的是點的那顆上的字，
       * 取消回 undefined。帶 `call` 的是調模型之前的那一問（`Host.confirmCall`）：按鈕上面多兩個下拉框（模型、上下文詳細度），
       * 回答另帶 `promptResult.choice`。
       */
      kind: 'input' | 'confirm' | 'pick' | 'merge' | 'file';
      actions?: string[];
      call?: CallPrompt;
      title: string;
      message?: string;
      placeholder?: string;
      value?: string;
      password?: boolean;
      multiline?: boolean;
      options?: string[];
      current?: string;
      proposed?: string;
      mergeable?: boolean;
      sides?: { current: string; proposed: string };
      applyLabel?: string;
    }
  /**
   * 當前開啟的工作區。獨立版空視窗 `currentId` 為 null。
   * `recents` 給歡迎頁；沒有記憶時是空陣列。
   */
  | {
      type: 'workspaces';
      currentId: string | null;
      items: WorkspaceItem[];
      recents: WorkspaceRecent[];
      /** 設定「新視窗中開啟專案」。前端開啟工程時據此決定換掉本視窗的工程還是開新視窗。 */
      openInNewWindow?: boolean;
      /** 歡迎頁「新建一本書」的「放在」預設值：最近開啟的那本書所在的目錄，沒有就是家目錄。只有獨立版給。 */
      newProjectParent?: string;
    }
  /** 「新建一本書」建好了（`createProject` 的回答；沒建成只有一條 toast）。`importFrom` 是請求裡原樣帶回來的。 */
  | { type: 'projectCreated'; root: string; importFrom?: string }
  /** 「匯入寫好的書」挑好的那一本切得出幾章（`inspectBook` 的回答）。 */
  | ({ type: 'bookInspected' } & BookInspection)
  /** 本機一層目錄的列舉結果。失敗不另造訊息，原因寫在 `error`。 */
  | {
      type: 'hostDir';
      path: string;
      parent?: string;
      entries: HostDirEntry[];
      truncated: number;
      error?: string;
      roots?: boolean;
    };

export interface WorkspaceItem {
  id: string;
  root: string;
  name: string;
}

export interface WorkspaceRecent {
  root: string;
  name: string;
}

/**
 * 歡迎頁「匯入寫好的書」挑好一本之後、建工程之前看的那一眼（`features/importManuscript.ts` 的 `inspectBookFile`）：
 * 切得出幾章、導進新工程是什麼樣。說明與「匯入原稿」確認框上的同一份。
 */
export interface BookInspection {
  path: string;
  /** 書名：檔名去掉副檔名，表單上「書名」的預設值。 */
  title: string;
  /** 認出幾章；0 就不能匯入，原因在 `error`。 */
  chapters: number;
  /** 「從《x》認出 N 章（…），匯入為第 1–N 章」。 */
  headline?: string;
  detail: string[];
  error?: string;
}

export interface HostDirEntry {
  name: string;
  kind: 'dir' | 'file';
  absPath: string;
}

/** 技能庫裡的一份寫作技能。 */
export interface SkillRow {
  /** `來源:名字`，繫結與解除安裝都認它。 */
  id: string;
  source: SkillSource;
  name: string;
  /** 顯示名（`display_name` → `name`）。 */
  label: string;
  description: string;
  version?: string;
  /** frontmatter 寫明的階段，沒寫就是按內容猜的。只是建議。 */
  suggestedStage: SkillStage;
  compatible: boolean;
  /** 不相容的原因，已經是給人看的話。 */
  reasons: string[];
  /** 注入的 UTF-8 位元組數：正文加附帶檔案。 */
  bytes: number;
  /** 一起帶的附帶檔案（技能目錄裡的相對路徑，`references/…` 這類）。 */
  files: string[];
  /** 本工程的技能在工程裡的路徑（點得開）。 */
  relPath?: string;
  /** 在本工程裡綁在哪幾個階段。 */
  boundTo: SkillStage[];
}

export interface SkillsView {
  rows: SkillRow[];
  /** 本工程每個階段綁了哪份。**沒開啟工程時缺席**：繫結跟著工程走。 */
  bindings?: Partial<Record<SkillStage, string>>;
  /** 繫結檔案讀不懂的地方（`.novelwarden/skills.json`）。 */
  problems: string[];
  /** 我的技能庫在哪：手放技能的作者要知道往哪放。 */
  userDir: string;
}

/** 檢查一份 GitHub 上的技能得到的東西。**帶正文**：裝之前作者看得到它寫了什麼。 */
export interface SkillInspectionView {
  url: string;
  resolvedUrl: string;
  name: string;
  label: string;
  description: string;
  version?: string;
  suggestedStage: SkillStage;
  /** 注入的 UTF-8 位元組數：正文加附帶檔案。 */
  bytes: number;
  body: string;
  /** 引用到、會一起裝、一起帶的附帶檔案，帶全文：裝之前一樣看得到。 */
  attachments: { path: string; text: string }[];
  /** 裝不了的原因。空 = 可以裝。 */
  blockers: string[];
}

export interface SerializedProvider {
  id: string;
  label?: string;
  kind: 'openai' | 'anthropic' | 'vscode-lm';
  baseUrl?: string;
  models: SerializedModel[];
}

export interface SerializedModel {
  name: string;
  label?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface FileOpResult {
  from: string;
  to?: string;
  ok: boolean;
  error?: string;
}

/**
 * 一個歷史版本：快照（`workspace/history.ts` 的 `SnapshotInfo`），或這份檔案在某個存檔點裡的樣子（帶 `checkpoint`，
 * `workspace/checkpoints.ts` 的 `checkpointVersionsOf`）。`id` 讀它時認它：快照是快照的檔名，存檔點是 `cp:<存檔點 id>`；
 * `time` 對快照是這一版在磁碟上被覆蓋掉的那一刻，對存檔點是存下的那一刻（毫秒時間戳）。
 */
export interface VersionView {
  id: string;
  time: number;
  words: number;
  bytes: number;
  checkpoint?: { note: string; auto: boolean };
}

export interface EditorFileView {
  path: string;
  name: string;
  text: string;
  hash: string;
  bytes: number;
  draftPath?: string;
  /**
   * 這份檔案在工程裡是什麼（`kindOfPath` 算的）。內建編輯器據此分「正文」（`chapter` / `draft`）
   * 與其餘檔案——Tab 縮排用全形還是半形就看它。前端不自己拿路徑或副檔名去猜（與 `draftPath`
   * 同一條原則：後端才知道什麼算章節）。沒開啟工程時省略，前端當非正文。
   */
  kind?: ArtifactKind;
  /**
   * 標籤與工具欄上怎麼稱呼這份檔案（`views/editorLabel.ts`，按 `kindOfPath` 與章節 / 細綱的檔名規則算）。
   * 與 `kind`、`draftPath` 同一條原則：前端不拿路徑猜。沒開啟工程時省略，前端退回檔名與原始路徑。
   */
  label?: EditorFileLabel;
}

/** 內建編輯器工具欄麵包屑的一段。帶 `dir`（工程內相對路徑）的是目錄，點了在「檔案」頁定位到它。 */
export interface EditorCrumb {
  label: string;
  dir?: string;
}

/** 內建編輯器上這份檔案的稱呼。 */
export interface EditorFileLabel {
  /** 標籤上名字前面那一小格：細綱「細綱」、草稿「草稿」、角色「角色」……正文與有中文稱呼的固定檔案不帶（空串）。 */
  tag: string;
  /** 標籤上的名字：去掉副檔名的檔名；架構幾件、情節大綱這類固定檔案是中文稱呼；認不出的檔案是原檔名。 */
  title: string;
  /** 工具欄麵包屑：「細綱 › 第一卷 › 第 3 章 夜訪」「角色 › 林晚」。 */
  crumbs: EditorCrumb[];
}
