import type { LlmTask, ModelTier } from '../model/tiers';
import type { ThinkingDepth } from '../model/thinking';
import type { ContextDetail } from '../model/contextDetail';
import type { CallChoice } from '../model/callChoice';
import type { ReviewIssueEdit } from '../model/review';
import type {
  Capability,
  CreationStage,
  CreationTarget,
} from '../model/pipeline';
import type { SerializedProvider } from './out';
import type { SkillStage } from '../model/writingSkill';
import type { ParagraphStyle } from '../model/paragraphFormat';
import type { BookFindQuery, BookReplaceRequest } from './bookFind';
import type { RestoreCheckpointRequest } from './checkpoints';

export type Tab = 'chat' | 'project' | 'files' | 'versions' | 'history' | 'settings' | 'logs';

export interface SendPayload {
  text: string;
  stage: CreationStage;
  capability: Capability;
  target: CreationTarget;
  targetNo: number;
  /**
   * 這一步覆蓋的章號區間（主按鈕「拆細綱（第 6–10 章）」「續寫情節大綱（第 21–40 章）」
   * 帶過來的）。細綱給了區間就是一批（一次出幾章，最多 5 章），大綱按它只寫那一段。
   *
   * 從前這裡還有一個 `targetWords`（輸入框下面那個，預設 2000）。它和細綱裡的
   * `targetWords` 兩處都能寫，作者分不清哪個生效——現在只認細綱（W1）。
   */
  range?: { from: number; to: number };
  /**
   * 一句話彈窗帶過來的規模（W4）。給了就是「從一句話生成小說配置」：作者那句話寫進
   * 「一句話」一節，總章數與每章字數以這裡為準，`config.md` 已有內容時保留原文、追加生成。
   */
  setup?: { totalChapters: number; wordsPerChapter: number };
  /**
   * 寫正文的寫法（主按鈕「接著寫」「重寫第 N 章」、章節工作臺帶過來的）。`continue` 只寫新增的
   * 那一段並追加；其餘在這一章已有正文時整章重寫、覆蓋前審閱。不給就按磁碟定。
   */
  writeMode?: 'continue' | 'rewrite';
  attachments: SerializedAttachment[];
  excludedIds: string[];
}

export interface SerializedAttachment {
  id: string;
  kind: string;
  label: string;
  relPath?: string;
  range?: { start: number; end: number };
  text?: string;
}

export type EditorPane = 'main' | 'draft';

/**
 * 開啟檔案時前端帶上、後端在 `editorOpen` 裡**原樣帶回**的兩個標記。後端不看它們，內建編輯器據此決定
 * 新開一個標籤還是複用一個（`media/src/editor/pane.ts` 的 `upsertFile`）。外掛殼沒有內建編輯器，帶了也只是被忽略。
 */
export interface EditorOpenIntent {
  /**
   * 單擊開啟（工程頁 / 檔案頁的一行）：臨時標籤——每塊編輯區最多一個，下一次單擊開啟別的檔案時換掉它；
   * 在裡面編輯、儲存，或雙擊就轉正。不帶 = 正常標籤（落盤後自動開啟、點引文、「並排看細綱」、雙擊那一行）。
   */
  preview?: boolean;
  /** 沒改過就在原位置換掉這一份（上一章 / 下一章）：新的一份佔它的位置。改過了就另開一個標籤。 */
  replace?: string;
}

/** `checkEditorFiles` 的一項：編輯器裡開著的一份檔案，以及編輯器知道的它在磁碟上的 hash。 */
export interface EditorFileCheck {
  path: string;
  hash: string;
}

/** 章節工作臺工具條上的按鈕。`review` 是五期的審稿：只出報告，不寫檔案。 */
export type ChapterAction = 'write' | 'continue' | 'rewrite' | 'finalize' | 'review';

/** Webview → 擴充套件 */
export type InMessage =
  | { type: 'ready' }
  | { type: 'switchTab'; tab: Tab }
  | { type: 'send'; payload: SendPayload }
  | { type: 'stop' }
  | { type: 'retry'; turnId: string; payload: SendPayload }
  | { type: 'setTarget'; target: CreationTarget }
  | { type: 'selectPlot'; plotRelPath: string }
  | { type: 'requestPipeline'; plotRelPath?: string }
  | { type: 'editTurn'; turnId: string; text: string }
  | { type: 'deleteTurn'; turnId: string }
  /**
   * 「複製完整上下文」：要這一輪發給模型的完整訊息（`ChatTurn.contextMessages`）。回的是
   * `contextText`，帶同一個 `requestId`——回覆是廣播，兩個檢視都收得到，只有點的那一邊認它。
   */
  | { type: 'copyContext'; turnId: string; requestId: string }
  | { type: 'openSession'; id: string }
  | { type: 'newSession' }
  | { type: 'deleteSession'; id: string }
  | { type: 'renameSession'; id: string }
  | { type: 'pickAttachment' }
  /**
   * 「加入選區」。有內建編輯器的頁面（獨立版）在那裡選著字時，前端直接把選區帶上來（`selection`，路徑是工作區相對路徑、
   * 行號 1-based 閉區間）——宿主取不到網頁裡的選區。不帶就交給宿主：外掛讀 VS Code 編輯器的選區，獨立版彈貼上框。
   */
  | { type: 'addSelection'; selection?: { relPath: string; text: string; start: number; end: number } }
  | { type: 'openFile'; path: string }
  /** `preview` / `replace` 見 {@link EditorOpenIntent}：後端原樣帶回 `editorOpen`。 */
  | { type: 'openEditor'; path: string; pane?: EditorPane; preview?: boolean; replace?: string }
  | { type: 'openDraft'; path: string }
  /**
   * 內建編輯器工具欄的「細綱」（2026-10-23）：並排開啟這一章的細綱，還沒有就按模板建一份。`path` 是**章節**路徑，
   * 與 `openDraft` 一樣由後端在真實章節列表裡認這一章、推出細綱的落點。
   */
  | { type: 'openPlot'; path: string }
  /**
   * 開啟一章（W6 章節工作臺）：正文在主區、這一章的細綱並排在旁邊（還沒有細綱就按模板建一份；上一次並排開的是
   * 草稿就開這一章的草稿）。宿主沒有「並排開啟」這一項能力時只開一份。收的是這一章的細綱路徑（還沒有細綱時是它
   * 應該在的位置）或章節路徑。
   * `preview`：工程頁單擊那一行的名字，兩份都開成臨時標籤（原樣帶回 `editorOpen`）。
   * `beside: false`：這個視窗眼下沒有第二塊編輯區（窄屏），只開正文、不併排開細綱或草稿。
   */
  | { type: 'openChapter'; plotRelPath: string; preview?: boolean; beside?: boolean }
  /**
   * 章節工作臺工具條上的按鈕：對這一章做一件事。`write` / `continue` / `rewrite` 等於對這一章
   * 按下主按鈕（切到它的正文層、按那種寫法發一輪生成），`finalize` 走定稿。
   */
  | { type: 'chapterAction'; plotRelPath: string; action: ChapterAction }
  /**
   * 工程頁「故事架構」那幾行右鍵「重寫…」：先問一句重寫要求（可留空），再對那一件發一輪生成。
   * 與 `setTarget` 分開——那條只是進入這一層（討論），不花錢。
   */
  | { type: 'rewriteArchitecture'; target: CreationTarget }
  /**
   * 工程頁設定條目、「待完善」那一行右鍵「展開…」（完善設定，2026-10-19）：先問一句要求（可留空），
   * 再把對話頁的目標換成這一條設定、發一輪生成（展開）——同 `rewriteArchitecture` 那條路。
   * `relPath` 是已有條目；還沒有條目時給 `name` 與 `category`（細綱「設定」一節裡的名字與分類），
   * 後端先按分類建空條目再展開。
   */
  | { type: 'expandLore'; relPath?: string; name?: string; category?: string }
  /**
   * 審稿報告卡底部「按勾選的 n 條修稿」（五期 W10）：報告在哪一輪、勾了哪幾條（條目 id）。
   * 後端按那一輪的報告拼清單、按磁碟上此刻的正文重新定位引文，發一輪修稿。
   */
  | { type: 'reviseChapter'; turnId: string; picks: string[] }
  /**
   * 報告卡編輯模式點了「儲存」（五期補遺 §3）：那一輪報告的整張問題表。模型給的不能刪（表裡漏了
   * 就原樣留著），作者加的不帶 `id`。後端校驗之後寫回那一輪、落盤、推回。
   */
  | { type: 'editReview'; turnId: string; issues: ReviewIssueEdit[] }
  /**
   * 點報告卡上的引文：在編輯器裡開啟那一章、選中那一句（五期 W10）。宿主沒有「定位」這一項
   * 能力時只開啟檔案，並提示那一句。
   */
  | { type: 'revealQuote'; relPath: string; quote: string }
  /**
   * 內建編輯器儲存。`baseHash` 是樂觀鎖基線（不帶 = 作者明確選了強制儲存）。帶了基線而磁碟上已經沒有這個
   * 檔案（被刪、被改名）時**不在原路徑重建**，回 `editorDiskGone`；作者答應重建之後才帶 `recreate: true` 再發一次。
   */
  | { type: 'saveFile'; path: string; text: string; baseHash?: string; recreate?: boolean }
  | { type: 'reloadFile'; path: string }
  /**
   * 內建編輯器核對磁碟：兩塊編輯區裡開啟著的每份檔案，帶編輯器知道的那份磁碟版本的 hash（已經標成
   * 「磁碟上沒了」的給空串）。後端只讀這幾份：對不上的回 `editorDiskChanged`，讀不到的回 `editorDiskGone`，
   * 對得上的不回。前端在每條 `state` 之後去抖、視窗重新拿到焦點 / 頁面重新可見時發。
   * **不復用 `editorOpen`**——那條會把標籤切成當前的、搶焦點。
   */
  | { type: 'checkEditorFiles'; files: EditorFileCheck[] }
  /**
   * 內建編輯器衝突條「對比合併…」：編輯器裡的這一份（`text`）與磁碟上此刻的那一份逐段挑（左邊磁碟上的、
   * 右邊編輯器裡的，`Host.mergeTexts`）。採納後回 `editorReplace`（帶 `base`：樂觀鎖基線換成磁碟那份）；
   * 放棄什麼都不回。宿主沒有合併檢視時只回一句說明。
   */
  | { type: 'mergeWithDisk'; path: string; text: string; requestId: string }
  /** 歷史版本（`workspace/history.ts`，連同這份檔案在各存檔點裡的樣子）：列出來，回 `versions`。 */
  | { type: 'listVersions'; path: string }
  /** 讀某一版的全文（快照，或 `cp:` 開頭的存檔點裡那一份），回 `versionText`（同一個 `requestId`）。 */
  | { type: 'readVersion'; path: string; id: string; requestId: string }
  /**
   * 「現在存一版」：把**磁碟上當前**這份強制存一個快照（編輯器裡沒儲存的修改不算），之後重推 `versions`。
   * `quiet`：「版本」側欄與對比標籤把一版（或一處）放回編輯區之前順手發的那一次——不說話（成了、一樣不重複存都不彈
   * 提示），只保證換進來的內容存下去之前，被它蓋掉的那一份已經在歷史裡（節流攔不住它）。
   */
  | { type: 'saveVersion'; path: string; quiet?: boolean }
  /**
   * 存檔點（工程頁「存檔點…」，`protocol/checkpoints.ts`）：列出來，回 `checkpoints`。
   */
  | { type: 'listCheckpoints' }
  /** 存一個手動存檔點（備註可以空），之後重推 `checkpoints`。 */
  | { type: 'createCheckpoint'; note: string }
  /** 給一個存檔點寫備註；自動的寫了備註就留住（變成手動，不再被裁掉）。之後重推 `checkpoints`。 */
  | { type: 'noteCheckpoint'; id: string; note: string }
  /** 這個存檔點跟現在比，回 `checkpointDiff`。 */
  | { type: 'checkpointDiff'; id: string }
  /** 退回（單份或整本，面板上點了兩下）。先存一個「退回之前」，逐份寫回，之後重推 `checkpoints` 與 `checkpointDiff`。 */
  | { type: 'restoreCheckpoint'; request: RestoreCheckpointRequest }
  /**
   * 全書查詢替換（獨立版「編輯 → 全書查詢替換…」，`protocol/bookFind.ts`）：按範圍逐份讀盤找，回 `bookFindResult`
   * （同一個 `requestId`）。帶 `query.replacement` 就是「預覽替換」：每一處多帶換成什麼、每份檔案帶讀到時的 hash。
   * 前端在輸入停頓之後才發，新的一次發出之前先 `cancelBookFind` 上一次（後端在兩份檔案之間看一眼，叫停了就不回話）。
   */
  | { type: 'bookFind'; requestId: string; query: BookFindQuery }
  | { type: 'cancelBookFind'; requestId: string }
  /**
   * 「替換所選」：預覽裡勾著的那幾處，經閘道器逐份寫（`review: false`，帶預覽時的 hash 當樂觀鎖，每份先強制存一版歷史；
   * `dirty` 裡的那幾份——編輯器裡有未儲存的修改——跳過）。回 `bookReplaceDone`（彙總）。
   */
  | { type: 'bookReplace'; requestId: string; request: BookReplaceRequest }
  | { type: 'listDir'; dirs: string[]; ephemeral?: boolean }
  | { type: 'openExternal'; path: string }
  | { type: 'requestSummary'; plotRelPath: string }
  /**
   * 「轉到…」（獨立版 Ctrl+P）開啟時要一份索引：章節、角色卡、設定、架構幾件與大綱 / 文風 / 敘事線 /
   * 全文大綱、草稿（`views/quickOpen.ts`）。回 `quickOpenIndex`，帶同一個 `requestId`——回覆是廣播，
   * 兩個檢視都收得到，只有發問的那一邊認它。按需要，不常駐推送。
   */
  | { type: 'requestQuickOpen'; requestId: string }
  /**
   * 內建編輯器「編輯敏感詞表…」（體檢面板、「檢視 → 體檢」）：`.novelwarden/sensitive.txt` 不在就經閘道器新建一份
   * 帶說明註釋的模板（`mode: 'create'`，同名不覆蓋），然後在編輯器裡開啟它。還不是小說工程時只說一句。
   */
  | { type: 'editSensitiveWords' }
  /**
   * 內建編輯器「名詞補全」要名詞表（角色卡的名字與別名、設定條目的標題與關鍵詞、名錄裡出現過還沒建條目的名字，
   * `views/nameIndex.ts`）。回 `nameIndex`，帶同一個 `requestId`（回覆是廣播，只有發問的那一邊認它）。`have` 是前端
   * 手上那一份的 `sig`：對得上就只回 `sig`、不帶表。按需要，不常駐推送。
   */
  | { type: 'requestNameIndex'; requestId: string; have?: string }
  /**
   * 內建編輯器「敘事線總覽」標籤（敘事線重做三期）要矩陣：章 × 線，線按種類分組、每條線下面是它的伏筆、最後是「未歸屬的
   * 伏筆」（`views/threads.ts` 的 `buildThreadsOverview`，純讀盤、不調模型）。回 `threadsOverview`，帶同一個 `requestId`
   * （回覆是廣播，只有發問的那一邊認它）。按需要，不常駐推送。
   */
  | { type: 'requestThreadsOverview'; requestId: string }
  /**
   * 內建編輯器「時間線總覽」標籤（2026-10-24）要資料：豎著按故事日子排、一章一張卡片（`views/threads.ts` 的 `buildTimelineOverview`，
   * 純讀盤、不調模型）。回 `timelineOverview`，帶同一個 `requestId`。按需要，不常駐推送。
   */
  | { type: 'requestTimelineOverview'; requestId: string }
  /**
   * `range` 只有「批次拆細綱」用：彈窗裡選的區間（W5）。`call` 表示彈窗已經把
   * 呼叫次數寫給作者看過了，帶著作者在彈窗上為這一次挑的模型與詳細度，後端不再彈第二個確認框
   * （彈窗與確認框算的是同一個 `planPlotBatches`，不疊彈窗）。「批次寫章」（W9）同樣帶 `range` / `call`，另帶
   * `mode`：只寫正文，還是寫完一章就定稿（`planWriteBatch`）；`review`：寫完一章先審一遍，
   * 報告放進一個新會話（五期補遺 §4）。
   */
  | {
      type: 'projectAction';
      action: ProjectAction;
      relPath?: string;
      dir?: string;
      range?: { from: number; to: number };
      call?: CallChoice;
      mode?: 'draft' | 'finalize';
      review?: boolean;
      /** `newLore`：預填的標題（「出現過 · 未建條目」那一行右鍵新建時帶上），給了就不再問；`buildLore`：建哪一條。 */
      name?: string;
      /** 「批次拆細綱」彈窗上「拆完展開本批新設定」選了「是」（完善設定三期）：拆完後端再問一次次數。 */
      expandLore?: boolean;
      /** `newChapter`：建完就開啟它（工程頁「章節」還空著時那顆「新建第 1 章」，2026-10-24）。 */
      open?: boolean;
      /**
       * `importManuscript`：歡迎頁「匯入寫好的書」在本機選的那本 txt 的絕對路徑。給了就不再彈選擇器、也不再問切分結果
       * ——表單上已經擺過同一份說明（`features/importManuscript.ts` 的 `inspectBookFile`）。
       */
      hostPath?: string;
    }
  | { type: 'characterAction'; action: CharacterAction; name: string; relPath?: string }
  | {
      type: 'fileAction';
      action: FileAction;
      relPath?: string;
      relPaths?: string[];
      op?: 'cut' | 'copy';
      targetDir?: string;
    }
  | { type: 'selectModel'; ref: string }
  /**
   * 換這個會話的思考深度。**跟著會話走**（見 model/session.ts），所以不是
   * 設定項：它與「這件事有多難」綁在一起，而那是每個會話各自的事。
   */
  | { type: 'setThinking'; depth: ThinkingDepth }
  | { type: 'saveSettings'; settings: SettingsPayload }
  | { type: 'setApiKey'; providerId: string }
  | { type: 'clearApiKey'; providerId: string }
  | { type: 'testConnection'; ref?: string; provider?: SerializedProvider }
  | { type: 'openNativeSettings' }
  | { type: 'cancelTask'; id: string }
  /**
   * 「寫完這一章就停」（W8）：批次寫章只在章與章之間停——正在寫的那一章照常寫完、落盤，
   * 然後收。與 `cancelTask`（中斷正在寫的）是兩回事。
   */
  | { type: 'stopAfterItem'; id: string }
  | { type: 'requestLogs' }
  | { type: 'requestLogHistory'; before?: string }
  | { type: 'clearLogs' }
  /**
   * 網頁彈窗的回答（獨立版的 `Host.input` / `confirm` / `confirmCall` / `pick`……）。確認框回的是點的那顆按鈕上的字，
   * 取消回 undefined；`confirmCall` 另帶作者為這一次挑的模型與詳細度（`choice`）。
   */
  | { type: 'promptResult'; requestId: string; value?: string; choice?: CallChoice }
  /**
   * 作者在對話頁那張許可權卡片上點了一顆按鈕（`gate` 的回答）。**只有兩個值**
   * ——叫停整輪走的是 `stop`，不在這張卡上。卡片帶 `remember` 時，點那第三顆按鈕也是
   * `proceed`，另帶上作者填的理由。
   *
   * 認不出的 `requestId` 靜默丟棄：重連之後前端可能還留著一張早就結束了的
   * 卡片，為它報錯只會讓作者莫名其妙。
   */
  | { type: 'gateResult'; requestId: string; verdict: 'proceed' | 'skip'; remember?: string }
  /**
   * 本機列一層目錄（絕對路徑）。獨立版空視窗選工程用；外掛不會發。
   * `path` 為空表示根層（Unix 的 `/`，Windows 的磁碟機代號列表）。
   */
  | { type: 'listHostDir'; path: string }
  | { type: 'createHostDir'; parent: string; name: string }
  /**
   * 歡迎頁「新建一本書」「匯入寫好的書」（2026-10-24）：在 `parent` 下建一個以書名命名的資料夾並初始化成工程
   * （`core/actions.ts` 的 `createBookAt`），成了回 `projectCreated`，前端再照常開啟它。`importFrom` 原樣帶回去：
   * 開啟之後接著把那本 txt 導進來。獨立版專屬，外掛不會發。
   */
  | { type: 'createProject'; parent: string; title: string; author: string; importFrom?: string }
  /** 歡迎頁「匯入寫好的書」挑好一本之後、建工程之前：看切得出幾章（回 `bookInspected`），不寫任何檔案。 */
  | { type: 'inspectBook'; path: string }
  | { type: 'openFolder'; path: string; mode?: 'replace' | 'add' }
  | { type: 'closeFolder'; id?: string }
  | { type: 'activateWorkspace'; id: string }
  /** 獨立版：這個視窗拿到了焦點。沒指定工程的 MCP 呼叫落到最近操作的視窗上。 */
  | { type: 'windowFocus' }
  | { type: 'openLogDir' }
  /** 有工程時經 workspace 寫檔案；已存在拒絕。`text` 預設為空。 */
  | { type: 'createFile'; relPath: string; text?: string }
  /** 開啟使用說明：工程內 README，否則倉庫根 README。 */
  | { type: 'openReadme' }
  // ---- 設定頁「技能」（寫作技能）。沒開啟工程時只有前四條有用：繫結跟著工程走。
  | { type: 'requestSkills' }
  /** 下載並檢查一份 GitHub 上的技能。不寫任何檔案。 */
  | { type: 'inspectSkill'; url: string }
  /** 裝檢查過的那一份。後端先彈確認框，再重新下載核對。 */
  | { type: 'installSkill'; url: string }
  /** 從我的技能庫解除安裝（挪進回收站）。只認 `user:` 的。 */
  | { type: 'uninstallSkill'; id: string }
  /** 本工程某個階段綁哪份；`id` 為 null 是不帶。 */
  | { type: 'bindSkill'; stage: SkillStage; id: string | null }
  /**
   * 內建編輯器「編輯 → 段落格式」：切換正文的分段格式。後端只改 `config.md` frontmatter 的
   * `paragraphStyle` 這一個鍵（`Workspace.setParagraphStyle`），然後 `pushState`。
   */
  | { type: 'setParagraphStyle'; style: ParagraphStyle };

export type ProjectAction =
  | 'initProject'
  | 'refresh'
  | 'newPlot'
  | 'newChapter'
  | 'newCharacter'
  | 'newLore'
  | 'newFolder'
  | 'finalizeChapter'
  /** 工程頁章節右鍵「定稿」「重新定稿」：與 `finalizeChapter` 同一件事，先彈確認框挑這一次的模型與詳細度。 */
  | 'askFinalizeChapter'
  | 'syncSummaries'
  | 'rebuildGlobalSummary'
  | 'generatePlots'
  | 'completeSettings'
  | 'writeManuscripts'
  | 'extractCharacters'
  /**
   * 記設定（設定名錄）：給了 `relPath`（章節或細綱）就單獨記那一章，沒給就補記全部還沒記過設定的
   * 定稿章。動手前後端報呼叫次數。
   */
  | 'recordLore'
  /** 給「出現過 · 未建條目」建條目：給了 `name` 就建那一條，沒給就建出現過的全部。 */
  | 'buildLore'
  /** 把定稿裡的新內容並進條目：給了 `relPath`（條目）就整合那一條，沒給就是掛 ＋N 的全部。 */
  | 'integrateLore'
  /**
   * 「待完善」組標題右鍵「全部展開」（完善設定三期）：只寫空的、佔位的與機器寫的薄條目，作者寫過的跳過；還沒有條目的
   * 先建空條目。動手前後端報呼叫次數。
   */
  | 'expandLoreAll'
  /** 按目錄整理：模型出搬家清單，作者看過再搬（範圍由後端問）。 */
  | 'organizeLore'
  | 'extractStyle'
  | 'generateThreads'
  /**
   * 從已寫正文補記敘事線（敘事線重做四期）：水位之後、定稿到之前還沒判的章逐章走定稿第三步。動手前後端報章數與呼叫次數；
   * 一條線都沒有時先從情節大綱排一次（算在同一個確認框裡）。
   */
  | 'backfillThreads'
  /**
   * 從正文補推故事時間（2026-10-24，同日重做）：同步過、時間線裡還沒有（或還推不出）的章，幾章一批判每章比上一章晚幾天。動手前
   * 後端報章數與呼叫次數。
   */
  | 'backfillTimeline'
  /**
   * 重推故事時間（2026-10-24 重做）：同步過、這一行不是作者寫的章，機器寫的行照新推的換。`range` 缺席是全部（時間線組標題旁「重推」），
   * 右鍵一章「重推這一章」「從這一章起重推」帶區間。動手前後端報章數、會換掉幾行與呼叫次數。
   */
  | 'refreshTimeline'
  /** 時間線組右鍵一章「改時間…」（2026-10-24 重做，0 次）：`name` 是章號；後端問一句，照作者寫的改那一行。 */
  | 'editTimeline'
  /** 時間線組第一行（0 次）：改曆法與起點；`name` 給了就是「填為起點」——直接填那一天，不問。 */
  | 'setTimelineStart'
  /**
   * 工程頁敘事線一行右鍵「標為收束」「標為放棄」（2026-10-24）：`relPath` 是那條線的檔案。零呼叫，後端先問一句，在它最近一次
   * 有動靜的那一章追加一條作者事件（features/threads.ts 的 `markThreadEnded`）。
   */
  | 'closeThread'
  | 'abandonThread'
  /** 拆書 A：把工程裡的一本 txt 切成章節（零呼叫；後端彈框挑檔案、報切分結果）。 */
  | 'importManuscript'
  /** 匯出全文（2026-10-24，零呼叫）：全部章節拼成一份 txt，寫到工程根下的 `匯出/<書名>.txt`，已有就覆蓋。 */
  | 'exportBook'
  /** 拆書 A：從已寫正文補齊細綱、角色卡、架構、大綱（只補空白，兩次確認）。 */
  | 'deriveFromText'
  | 'chapterGap'
  /** 拆書 B：從工程裡的一本參考書學文風與寫法。 */
  | 'learnFromReference';

export type CharacterAction =
  | 'updateCard'
  | 'rebuildCard'
  | 'createCard'
  | 'updateAllCards'
  | 'rebuildAllCards'
  | 'createAllCards'
  | 'cleanAliases'
  | 'mergeDuplicates'
  /** 定稿時作者改過、沒被覆蓋的「當前狀態」：拿機器給的那一版做一次對比（D15）。 */
  | 'reviewState';

export type FileAction = 'rename' | 'renameAny' | 'move' | 'delete' | 'paste';

export interface SettingsPayload {
  providers: SerializedProvider[];
  models: string[];
  tierModels: Record<ModelTier, string[]>;
  taskTiers: Partial<Record<LlmTask, ModelTier>>;
  temperature: number;
  /** 上下文詳細度 1–4（model/contextDetail.ts）。 */
  contextDetail: ContextDetail;
  summaryBatchSize: number;
  requestTimeoutMs: number;
  concurrency: number;
  fallbackAttempts: number;
  /** 寫完正文刪修飾。 */
  trimModifiers: boolean;
  /** 新視窗中開啟專案（獨立版）。外掛的設定頁沒有這一項，不帶就保持原值。 */
  openInNewWindow?: boolean;
}
