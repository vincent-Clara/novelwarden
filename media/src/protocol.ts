/**
 * 前端與後端的唯一契約：直接從 core 的協議定義裡取型別。
 *
 * 改造前這是一句註釋約定（「改協議要同時改 view.js」），漏改只能靠手測發現；
 * 現在 `npm run typecheck` 會替我們盯著——後端往 `OutMessage` 里加一個分支、
 * 改一個欄位名，前端對不上就編譯不過。
 *
 * 全部走 `import type`：只有型別跨過這條邊界，一行執行時程式碼都不會被打包進來
 * （core 是 Node 側的，帶進瀏覽器會立刻炸）。
 */
export type {
  ArchitectureRow,
  ArtifactKind,
  BookInspection,
  BookView,
  IdeaDefaults,
  ThreadLineView,
  ThreadsView,
  ThreadUnfiledView,
  TimelineCalendarView,
  TimelineChapterView,
  TimelineGroupView,
  TimelineIssueView,
  TimelineSegmentView,
  CastConflictView,
  CastEntry,
  CastSummary,
  PlotPipelineView,
  PlotSummaryView,
  CharacterAction,
  DirListing,
  EditorFileView,
  EditorFileCheck,
  ChapterAction,
  ChapterIndexEntry,
  EditorCrumb,
  EditorFileLabel,
  EditorOpenIntent,
  EditorPane,
  FailureView,
  FileAction,
  FileOpResult,
  FsEntry,
  InMessage,
  LogEntry,
  LogLevel,
  LoreSummary,
  LoreThinEntry,
  LoreUnfiledEntry,
  NextStepView,
  OutMessage,
  ProjectAction,
  ProjectPlotNode,
  ProjectDirNode,
  ProjectFile,
  ProjectFileNode,
  ProjectNode,
  ProjectTree,
  VolumeView,
  SendPayload,
  SerializedArtifact,
  SerializedAttachment,
  SerializedDigest,
  SerializedModel,
  SerializedProvider,
  SerializedSegment,
  SerializedSession,
  SerializedToolCall,
  SerializedTurn,
  SessionListItem,
  SettingsPayload,
  SkillInspectionView,
  SkillRow,
  SkillsView,
  Tab,
  TaskSnapshot,
  VersionView,
  WorkspaceItem,
  WorkspaceRecent,
  ViewState,
  WorkbenchSection,
  WorkbenchView,
} from '../../src/core/protocol';

/** 全書查詢替換（`core/protocol/bookFind.ts`）。 */
export type {
  BookFindFile,
  BookFindHit,
  BookFindQuery,
  BookFindResult,
  BookFindScope,
  BookFindSkip,
  BookReplaceRequest,
  BookReplaceSkipReason,
  BookReplaceSummary,
} from '../../src/core/protocol';

/** 存檔點（`core/protocol/checkpoints.ts`）。 */
export type {
  CheckpointDiffEntry,
  CheckpointDiffView,
  CheckpointFileStatus,
  CheckpointView,
  RestoreCheckpointRequest,
} from '../../src/core/protocol';

/**
 * 全書查詢替換的範圍表與上限：面板上的勾選框寫著「角色卡」，後端搜的就得是角色卡那個區。`bookFindScope.ts` 是純資料、
 * 零 import，打進瀏覽器產物是安全的。
 */
export {
  BOOK_FIND_LIMIT,
  BOOK_FIND_SCOPES,
  BOOK_FIND_SCOPE_HINT,
  BOOK_FIND_SCOPE_LABEL,
  DEFAULT_BOOK_FIND_SCOPES,
  isBookFindScope,
} from '../../src/core/model/bookFindScope';

/** 新建一本書時資料夾叫什麼：表單上預覽的與後端真建的同一個名字。`bookDir.ts` 是純函式、零 import。 */
export { bookDirName } from '../../src/core/model/bookDir';

/** 「轉到…」（Ctrl+P）的索引（`core/protocol/quickOpen.ts`）。 */
export type {
  QuickOpenChapter,
  QuickOpenCharacter,
  QuickOpenDoc,
  QuickOpenDocKey,
  QuickOpenDraft,
  QuickOpenIndex,
  QuickOpenLore,
} from '../../src/core/protocol';

/** 「名詞補全」的名詞表（`core/protocol/nameIndex.ts`）。 */
export type { NameEntry, NameIndex, NameSource } from '../../src/core/protocol';

/** 編輯區「敘事線總覽」標籤的矩陣（`core/protocol/threadsOverview.ts`，敘事線重做三期）。 */
export type {
  ThreadsOverview,
  ThreadsOverviewChapter,
  ThreadsOverviewChapterState,
  ThreadsOverviewCell,
  ThreadsOverviewEvent,
  ThreadsOverviewForeshadow,
  ThreadsOverviewGroup,
  ThreadsOverviewLine,
  ThreadsOverviewSpan,
} from '../../src/core/protocol';

/** 編輯區「時間線總覽」標籤的資料（`core/protocol/timelineOverview.ts`，2026-10-24）。 */
export type {
  TimelineOverview,
  TimelineOverviewCard,
  TimelineOverviewDay,
  TimelineOverviewEvent,
  TimelineOverviewThread,
} from '../../src/core/protocol';

/**
 * 創作流水線的型別與那幾張對照表。
 *
 * 與 `tiers.ts` 同一套理由：**標籤、命令表、狀態機推薦必須與後端同源**。
 * 前端自己抄一份的話，介面上會出現一個後端不認的命令，點了什麼都不發生。
 * `model/pipeline.ts` 是純型別 + 純函式、**零 import**，打進瀏覽器產物是安全的。
 */
export {
  CAPABILITIES,
  CAPABILITY_HINT,
  CAPABILITY_LABEL,
  PLOT_STAGE_LABEL,
  CREATION_STAGES,
  DEFAULT_CAPABILITY,
  STAGE_CAPABILITIES,
  STAGE_LABEL,
  STAGE_QUESTION,
  chapterLabel,
  plotLabel,
  plotOfTarget,
  settingOfTarget,
  SETTING_DOCS,
  SETTING_DOC_LABEL,
  commandOf,
  commandsFor,
  labelOf,
  outputKindOf,
  targetKey,
  // 呼叫次數與批次切分：彈窗的實時說明與後端的確認框必須是同一個演算法（第 4 條）。
  CONFIG_CALLS,
  PLOT_BATCH,
  describeCalls,
  planPlotBatches,
  // 「2980 / 3000 字 · 已達標」：氣泡上那一行與落盤卡片是同一句（W7）。
  describeWriteLength,
  // 章節工作臺工具條的按鈕提示與主按鈕報同一個呼叫次數（W6、D16）。
  ONE_CALL,
  WRITE_CALLS,
  // 定稿與批次寫章（四期）：彈窗、章節條與後端確認框同源（第 4 條）。
  FINALIZE_CALLS,
  WRITE_BATCH_DEFAULT,
  WRITE_BATCH_MAX,
  planWriteBatch,
  // 審稿與修稿（五期）：章節條、報告卡上的呼叫次數與後端同一份。
  REVIEW_CALLS,
  REVISE_CALLS,
  // 設定名錄：建條目、整合這一條的右鍵選單與後端確認框同一個數。
  LORE_ENTRY_CALLS,
  // 寫 1 次、轉寫 1 次（2026-10-25 起改成轉寫）：「記設定」右鍵選單與後端確認框同一個數。
  TRANSCRIBED_CALLS,
  // 完善設定：展開一條的右鍵選單與後端問要求的那一句同一個數；單條設定目標的說法也同源。
  LORE_EXPAND_CALLS,
  // 完善設定三期：「全部展開」與後端確認框同一個數；寫前提醒在彈窗與確認框裡同一句。
  loreExpandCalls,
  describeThinLore,
  // 敘事線：排線、判一章的呼叫次數，敘事線頁簽上的按鈕提示與後端確認框同一個數（2026-10-25 起含轉寫）。
  THREAD_PLAN_CALLS,
  THREADS_JUDGE_CALLS,
  // 敘事線二期：寫前檢查的兩類提醒（伏筆逾期、線斷了），批次寫章彈窗與後端確認框同一個演算法、同一句。
  threadRemindersFor,
  describeThreadReminders,
  unrecordedBefore,
  describeTarget,
  loreOfTarget,
  // 續寫大綱（2026-10-24）：工程頁右鍵上的「續寫（第 a–b 章）」與後端真續的那一段是同一個演算法。
  OUTLINE_TARGET,
  outlineNextRange,
} from '../../src/core/model/pipeline';

/**
 * 審稿報告（五期 W10）。標籤、能勾哪幾條、定位引文的歸一化都必須與後端同源：報告裡說找得到的
 * 引文，點下去就得在編輯器裡選得中。`review.ts` 是純型別 + 純函式、零 import，打進瀏覽器產物是安全的。
 */
export {
  AUTHOR_CATEGORY,
  GOAL_STATUS_LABEL,
  SEVERITY_LABEL,
  describeReport,
  locateQuote,
  pickableIds,
} from '../../src/core/model/review';
export type { ReviewGoal, ReviewIssue, ReviewIssueEdit, ReviewReport } from '../../src/core/model/review';

/**
 * 段級 diff（五期 W11）：獨立版的合併檢視按它對齊兩個版本、組合合併結果。純函式、零 import；
 * 演算法在 core 裡單測，前端不另寫一份。
 */
export { changeCount, diffParagraphs, joinMerge, sideText } from '../../src/core/model/paragraphDiff';
export type { MergeSegment } from '../../src/core/model/paragraphDiff';

/**
 * 查詢替換的匹配口徑（大小寫、正則、零長度、`$1`）。內建編輯器的查詢條（`editor/findCore.ts` 原樣轉出）與
 * 後端的全書查詢替換必須是同一份——同一個查詢串在一份檔案裡與在全書裡找到的得是同一批。`textFind.ts` 是純函式、
 * 零 import，打進瀏覽器產物是安全的。
 */
export {
  MATCH_LIMIT,
  compileSearch,
  escapeRegExp,
  expandReplacement,
  findMatches,
  replaceAllIn,
  replaceSelectedIn,
  replacementFor,
} from '../../src/core/model/textFind';
export type {
  CompiledSearch,
  FindMatch,
  FindOptions,
  FindResult,
  ReplaceAllEdit,
  SelectedReplace,
} from '../../src/core/model/textFind';
export type {
  BookStage,
  CallEstimate,
  PlotBatchPlan,
  WriteBatchMode,
  WriteBatchPlan,
  Capability,
  CreationAction,
  CreationStage,
  CreationTarget,
  NextStepPlan,
  PipelineProgress,
  PlotStage,
  SettingDoc,
  StageCommand,
} from '../../src/core/model/pipeline';

/**
 * 模型分檔的型別與那幾張對照表。
 *
 * 標籤（檔位名、任務名、內建預設對映）**必須與後端同源**：設定頁上寫著
 * 「定稿 → 快速檔」，跑起來卻是另一檔，作者就再也不信這張表了。
 * 所以這裡連值一起 import（不是 `import type`）——`tiers.ts` 是純資料 +
 * 純函式，沒有任何 Node 依賴，打進瀏覽器產物是安全的。
 */
export {
  DEFAULT_TASK_TIERS,
  LLM_TASKS,
  MODEL_TIERS,
  TASK_HINT,
  TASK_LABEL,
  TIER_HINT,
  TIER_LABEL,
} from '../../src/core/model/tiers';
export type { LlmTask, ModelTier } from '../../src/core/model/tiers';

/**
 * 思考深度的檔位與說法。與分檔同一套理由：下拉框上寫著「深思考」而後端
 * 按別的檔發請求，作者就再也不信這個開關了。`thinking.ts` 是純資料 +
 * 純函式、零 import，打進瀏覽器產物是安全的。
 */
export {
  DEFAULT_THINKING_DEPTH,
  THINKING_DEPTHS,
  THINKING_HINT,
  THINKING_LABEL,
  isThinkingDepth,
} from '../../src/core/model/thinking';
export type { ThinkingDepth } from '../../src/core/model/thinking';

/**
 * 上下文詳細度的級別、說法與每一級帶多少。同一套理由：下拉框上寫著「精簡」而後端按別的級別裝，
 * 作者就再也不信這個開關了。`contextDetail.ts` 是純資料 + 純函式、零 import，打進瀏覽器產物是安全的。
 */
export {
  CONTEXT_DETAILS,
  CONTEXT_DETAIL_HINT,
  CONTEXT_DETAIL_LABEL,
  DEFAULT_CONTEXT_DETAIL,
  describeContextDetail,
  isContextDetail,
  normalizeContextDetail,
} from '../../src/core/model/contextDetail';
export type { ContextDetail } from '../../src/core/model/contextDetail';

/**
 * 調模型之前的確認框（與工程頁批次表單）上那兩個下拉框：作者為這一次挑模型與詳細度。「按分檔」那一項的說法與後端、
 * VS Code 的 QuickPick 同一份。`callChoice.ts` 只 import 零 import 的 `contextDetail.ts`，打進瀏覽器產物是安全的。
 */
export { TIERED_LABEL } from '../../src/core/model/callChoice';
export type { CallChoice, CallPrompt } from '../../src/core/model/callChoice';

/**
 * 寫作技能的階段、來源與不相容原因的說法。與分檔同一套理由：設定頁上寫著「寫正文」而後端按
 * 別的階段帶，作者就再也不信這張表了。`writingSkill.ts` 零執行時 import，打進瀏覽器產物是安全的。
 */
export {
  SKILL_SOURCE_LABEL,
  SKILL_STAGES,
  SKILL_STAGE_LABEL,
  isSkillStage,
} from '../../src/core/model/writingSkill';
export type { SkillSource, SkillStage } from '../../src/core/model/writingSkill';

/**
 * 正文的分段格式與一鍵排版。回車插什麼、「一鍵排版」排成什麼樣、標題欄「段落格式」的說法、段落聚焦認哪一段，
 * 都必須與後端認的 `paragraphStyle` 同源。`paragraphFormat.ts` 是純函式、零 import，打進瀏覽器產物是安全的。
 */
export {
  DEFAULT_PARAGRAPH_STYLE,
  PARAGRAPH_STYLES,
  PARAGRAPH_STYLE_HINT,
  PARAGRAPH_STYLE_LABEL,
  fullWidthPunct,
  isHeadingLine,
  isParagraphStyle,
  isSceneBreakLine,
  layoutProse,
  paragraphBreak,
  paragraphGap,
  paragraphIndent,
} from '../../src/core/model/paragraphFormat';
export type { ParagraphStyle, PunctEdit } from '../../src/core/model/paragraphFormat';

/**
 * 寫作體檢（獨立版內建編輯器，`editor/check.ts`）：比喻詞表與上限、找詞的位置、拉丁縮寫——**與寫完一章之後數的是同一個
 * 函式**（生成鏈的 `countSimiles` / `countBanned` / `latinAcronyms` 都建在這幾個找位置的函式上）。禁用詞與敏感詞表由後端
 * 算好推來（`checkTerms`）。`manuscriptCheck.ts` 是純函式、零 import，打進瀏覽器產物是安全的。
 */
export {
  SIMILE_LIMIT,
  SIMILE_WORDS,
  foldLatin,
  latinAcronymRanges,
  locateTerms,
} from '../../src/core/model/manuscriptCheck';
export type { TermHits } from '../../src/core/model/manuscriptCheck';
export type { CheckSensitiveTerm, CheckTermsView } from '../../src/core/protocol';
