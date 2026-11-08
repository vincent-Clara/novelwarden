import type {
  BookStage,
  Capability,
  WriteLength,
  CreationStage,
  CreationTarget,
  NextStepPlan,
  PipelineProgress,
  PlotStage,
  SettingDoc,
  ThreadWatch,
} from '../model/pipeline';
import type { ThinkingDepth } from '../model/thinking';
import type { ContextDetail } from '../model/contextDetail';
import type { ReviewReport } from '../model/review';
import type { ParagraphStyle } from '../model/paragraphFormat';
import type { LoreThinKind } from '../model/loreFile';
import type { ThreadKind, ThreadStatus } from '../model/threadFile';
import type { TimelineDayState } from '../model/timelineFile';
import type { SerializedAttachment } from './in';

export interface ViewState {
  initialized: boolean;
  /**
   * 創作頁目標下拉框裡的候選：**每個章號一行**（細綱號 = 章號）。
   *
   * `label` 由後端給（「第 12 章《夜訪》」），`relPath` 是這一章細綱的路徑
   * （還沒有細綱時是它應該在的位置）——選中它就是「進入這一章」。
   */
  plots: {
    no: number;
    label: string;
    title: string;
    wordCount: number;
    relPath: string;
  }[];
  nextNo: number;
  staleCount: number;
  model: string;
  modelLabel: string;
  modelIssue?: string;
  models: { ref: string; label: string; group: string }[];
  /** 設定頁上的上下文詳細度：工程頁批次表單上那個下拉框的預設（表單只為這一次換，不改它）。 */
  contextDetail: ContextDetail;
  contextWindow: number;
  maxOutputTokens: number;
  /**
   * 正文的分段格式（`config.md` 的 `paragraphStyle`，沒寫是 `blank`）。工程樹裡也有一份；這裡再帶一份，
   * 是因為工程樹只在「工程」頁籤開著時才推，而內建編輯器的回車、標題欄「段落格式」的勾在哪個頁籤都要用。
   */
  paragraphStyle: ParagraphStyle;
}

export interface ProjectTree {
  initialized: boolean;
  /** 章節組的行數（每個出現過的章號一行）。 */
  plotCount: number;
  /** 已經有正文檔案的章數。 */
  chapterCount: number;
  /** 已寫正文的總字數。 */
  totalWords: number;
  staleCount: number;
  summarizedCount: number;
  /** 「故事架構」組的六行：架構五件 + 情節大綱。 */
  architecture: ArchitectureRow[];
  /** 章節組的全部行，一個章號一行，升序。 */
  plots: ProjectPlotNode[];
  /**
   * 「章節」頁籤的分卷（2026-10-23）：`chapters/` 下的一級目錄，按卷裡最小的章號排，還空著的卷排在最後。
   * 有章直接放在章節根下時多一段「未分卷」（`name` 是空串），照章號排在它該在的位置。
   * 一卷都沒建是空陣列——頁籤照舊一章一行平鋪。
   */
  volumes: VolumeView[];
  characters: ProjectNode[];
  lore: ProjectNode[];
  cast: CastEntry[];
  castByCard: Record<string, CastSummary>;
  /** 設定名錄（views/lore.ts）：已建條目的出現章與待整合，按條目 relPath 索引。 */
  loreByEntry: Record<string, LoreSummary>;
  /** 定稿裡出現過、還沒有條目的名字，按出現章數降序。 */
  loreUnfiled: LoreUnfiledEntry[];
  /**
   * 待完善（完善設定，2026-10-19）：還沒寫的那幾章細綱「設定」一節點名、卻還沒有條目或條目還只有一句話的設定，
   * 按最早要用到的章升序。
   */
  loreThin: LoreThinEntry[];
  /** 定稿過、但還沒記過設定（細綱沒有「設定」一節）的章數。 */
  loreUnrecorded: number;
  failures: Record<string, FailureView[]>;
  castConflicts: CastConflictView[];
  /** 章節區根目錄（`chapters`）。「章節」組右鍵「新建卷…」建的卷目錄落在這裡。 */
  chaptersRoot: string;
  charactersRoot: string;
  loreRoot: string;
  globalSummaryThrough: number;
  styleGuidePath: string;
  globalSummaryPath: string;
  /** 敘事線目錄（`threads/`，一條線一個檔案）。排線失敗的紅 ❗ 掛在它上面（`failures` 按它索引）。 */
  threadsPath: string;
  /** 工程頁「敘事線」頁籤：一條線一行，最後是「未歸屬的伏筆」（`views/threads.ts`）。 */
  threads: ThreadsView;
  /** 全書走到哪一步（架構 / 大綱 / 細綱 / 在寫 / 寫完）。 */
  bookStage: BookStage;
  /** 下一個該寫的章（從第 1 章起連續有正文的最大章號 + 1）。只有這一行給「寫這一章」。 */
  nextChapterNo: number;
  /**
   * 全書那一檔的下一步（生成架構 / 情節大綱 / 拆細綱），與對話頁主按鈕在全書那一檔給的
   * 同一步。工程頁的空狀態寫「下一步：……」用它（W12）。在寫、寫完了時缺席。
   */
  next?: NextStepView;
  /** 一句話、拆細綱兩個彈窗的預設值（W4 / W5）。 */
  book: BookView;
  /** 正文的分段格式（`config.md` 的 `paragraphStyle`）。總是有值，沒寫是 `blank`。 */
  paragraphStyle: ParagraphStyle;
}

/**
 * 工程頁「敘事線」頁籤（敘事線重做第 8 個提交，`views/threads.ts` 現算）：一條線一行，按主線 → 支線 → 感情線 →
 * 人物線、同種類按最近一次推進排；最後一行是「未歸屬的伏筆」。狀態一律按「現在」（`current`）算、不落盤（第 18 條）。
 */
export interface ThreadsView {
  /** 一條線一行，已經排好序。 */
  lines: ThreadLineView[];
  /** 「未歸屬的伏筆」那一行。檔案裡一條伏筆都沒有（或沒有這份檔案）時缺席。 */
  unfiled?: ThreadUnfiledView;
  /** 定稿到的最後一章（定稿過的章裡章號最大的；一章都沒定稿是 0）。 */
  current: number;
  /**
   * 敘事線判到第幾章（四期：`project.json` 的水位，從第 1 章起連續判過的，不超過 {@link current}）。線的狀態（斷了幾章、伏筆逾期、
   * 過了計劃收束章）按它算——定稿了還沒判的章上線裡本來就沒有事件；寫前提醒注「還沒記上」的那幾章也按它（前端批次寫章彈窗）。
   */
  through: number;
  /**
   * 定稿過、敘事線還沒判的章（四期）：工程頁「⚠ 第 31–60 章還沒判」（`text` 不帶 ⚠，前端加）與「從已寫正文補記」那一項。
   * 沒有落後時缺席。
   */
  lag?: { count: number; text: string };
  /**
   * 寫前檢查的敘事線提醒要的數（二期）：前端批次寫章彈窗拿它與要寫的那幾章算提醒（`threadRemindersFor`，與後端確認框同源）。
   * 按現在的樣子算（不 asOf）。
   */
  watch: ThreadWatch;
  /**
   * 「時間線」那一組（故事時間，2026-10-24；同日重做：從敘事線組裡的一行改成敘事線頁籤裡單獨一組，排在敘事線組前面）。
   * 時間線檔案不在、也沒有要補推的章時缺席。
   */
  timeline?: TimelineGroupView;
}

/**
 * 敘事線頁籤的「時間線」組（2026-10-24 重做，設計稿 docs/design/plans/2026-10-24-story-timeline-rework.md「五」）：標題、對賬一條一行、
 * 章按月（沒起點按卷、卷也沒有每 20 章）分段一章一行。文案都由後端給（`views/timeline.ts`），前端只渲染、只加 ⚠。同日「時間線總覽」
 * （docs/design/plans/2026-10-24-timeline-page.md）：曆法與起點那一行去掉（挪到組標題的懸停裡），點一章開啟總覽。
 */
export interface TimelineGroupView {
  /** `threads/时间线.md`（還沒有這份檔案時也給：補推會建它）。 */
  relPath: string;
  /** 檔案在不在。 */
  exists: boolean;
  /** 組標題後面那一串：`推到第 30 章 · 故事第 46 天（大衍三年四月十九 夜裡）`。 */
  label: string;
  /** 曆法與起點（組標題的懸停、右鍵「改曆法與起點」的預填）。 */
  calendar: TimelineCalendarView;
  /** ⚠ 一條一行（不帶 ⚠，前端加）：沒填起點（有建議時）、起點認不出、對賬、推不出、認不出、還沒推。 */
  issues: TimelineIssueView[];
  /** 章分段，按章號。 */
  segments: TimelineSegmentView[];
  /** 同步過、時間線裡還沒有（或還推不出）的章（「補推時間」那一項）。沒有時缺席。 */
  missing?: { count: number; text: string };
  /** 機器寫的行有幾行（「重推」那一項：0 時不給）。 */
  machine: number;
  /** 最後一章的章號（「從這一章起重推」到哪一章）。 */
  last: number;
}

/**
 * 曆法與起點（2026-10-24 時間線總覽：原來是「時間線」組的第一行、點了就改，作者嫌反人類——挪到組標題的懸停裡，改走右鍵）。
 * `text` 是 `簡單歷 · 起點 大衍三年三月初七（第 1 章那一天）`，`tip` 是曆法怎麼算。
 */
export interface TimelineCalendarView {
  text: string;
  tip: string;
  /** 改起點那一問的預填。 */
  calendarName: '简单历' | '公历';
  start: string;
  /** 沒起點、正文寫明過日子時：倒推出來的起點（右鍵「填為起點」）。 */
  suggestion?: { start: string; note: string };
}

/**
 * 對賬、計數的一條。`chapter` 給了的點了開啟時間線總覽、展開那一章。`start`：說的是起點（沒填、認不出；2026-10-24 曆法那一行去掉之後
 * 挪到這裡），右鍵給「改曆法與起點」與「填為起點」。
 */
export interface TimelineIssueView {
  text: string;
  chapter?: number;
  start?: true;
}

/** 一段：`大衍三年三月 · 第 1–12 章 · 14 天`。 */
export interface TimelineSegmentView {
  /** 摺疊狀態的鍵（前端按它記）。 */
  key: string;
  label: string;
  detail: string;
  chapters: TimelineChapterView[];
}

/** 一章一行：`● 第 13 章 夜襲 · 初一 清晨 → 夜裡 · +2 天 · 依據「兩日後的清晨」`。 */
export interface TimelineChapterView {
  no: number;
  title: string;
  /** 正文（右鍵「開啟這一章」；點這一行開啟的是時間線總覽）；還沒有正文時缺席。 */
  chapterPath?: string;
  state: TimelineDayState;
  /** 那一天：`十四 清晨 → 夜裡`，沒起點 `第 8 天 清晨`，回憶 `回憶（約二十年前）`，沒推 `還沒推`。 */
  when: string;
  /** 比上一章：`+2 天`、`同一天`、`往回 3 天`；第 1 章、回憶、沒推缺席。 */
  delta?: string;
  /** 行尾：`依據「…」`、`推測：…`、`推不出：…`、`正文寫明八月十五`、`你定的`。 */
  note: string;
  tip: string;
  /** 「改時間…」那一問的預填：這一行現在的值（`+2 天`、`八月十五`）；沒有這一行是空串。 */
  value: string;
  /** 這一行是機器寫的（「重推這一章」給不給）。 */
  machine: boolean;
  /** 對賬報了這一章。 */
  issue?: boolean;
}

/** 「敘事線」頁籤的一行：`林昭與沈青 · 感情線 · 進行中 · 最近第 12 章 · 2 條伏筆沒收`，有問題的另加幾個 ⚠。 */
export interface ThreadLineView {
  /** 線名（檔名就是線名）。 */
  name: string;
  /** 這條線的檔案。點這一行開啟它；當前進度作者改過的黃 ❗ 掛在它上面。 */
  relPath: string;
  kind: ThreadKind;
  status: ThreadStatus;
  /** 最近一次實際事件在第幾章。 */
  lastActive?: number;
  /** 名字後面那一串：種類 · 狀態 · 最近第 N 章（還沒推進過寫計劃區間）· 幾條伏筆沒收。 */
  detail: string;
  /** 有問題的（不帶 ⚠，前端加）：`斷了 15 章`、`1 條伏筆逾期`、`過了計劃收束的第 40 章`。 */
  warnings: string[];
  /** 滑鼠移上去看的：意圖與當前進度。 */
  tip: string;
}

/** 「未歸屬的伏筆 · N 條」那一行。 */
export interface ThreadUnfiledView {
  relPath: string;
  /** 一共幾條伏筆。 */
  total: number;
  /** `4 條`，有收了的另寫「幾條沒收」。 */
  detail: string;
  /** 同一條線那一行的 ⚠（只有「幾條伏筆逾期」）。 */
  warnings: string[];
}

/** 一句話彈窗的預設值。主按鈕是「生成小說配置」時隨下一步一起給。 */
export interface IdeaDefaults {
  /** `config.md` 裡「一句話」那一節的原文。 */
  idea: string;
  totalChapters?: number;
  wordsPerChapter?: number;
  /** `config.md` 寫過任何一節：彈窗據此寫明「保留原文，追加生成」。 */
  configHasContent: boolean;
  /** 第 1 章起連續有正文寫到第幾章。有就是照已寫正文生成，那句話可以不寫。 */
  writtenThrough?: number;
}

/** 工程頁兩個彈窗要的全書事實。 */
export interface BookView extends IdeaDefaults {
  /** 大綱覆蓋到第幾章。還沒寫（或一條章標題都認不出）時缺席。 */
  outlineCoverage?: number;
  /** 排好細綱的章號：拆細綱彈窗據此算這一段要跳過幾章。 */
  plotFilledNos: number[];
}

/**
 * 「故事架構」組裡的一行。
 *
 * `key` 是架構五件之一或 `outline`（情節大綱）。角色圖譜、設定清單那兩行沒有自己的檔案，
 * `relPath` 給角色目錄 / 設定目錄；點它是跳到「角色」/「設定」那一組，不是開啟檔案。
 */
export interface ArchitectureRow {
  key: SettingDoc | 'outline';
  label: string;
  relPath: string;
  filled: boolean;
  /** 一句話副標題（「3 人」「24 條」「覆蓋到第 20 章」）。 */
  detail: string;
}

/**
 * 工程頁「章節」組裡的一行：**一個章號**。細綱號 = 章號，所以細綱與正文是同一行
 * 的兩面，各自有沒有、齊不齊都寫在這一行上。
 *
 * 一行一章、按章號排——順序恰恰是這一層最要緊的資訊。分了卷的書（`chapters/` 下有一級目錄）按卷分段畫
 * （{@link ProjectTree.volumes}），卷裡照舊按章號；卷裡更深的子目錄不體現在這裡（作者仍可以建，檔案操作照常）。
 */
export interface ProjectPlotNode {
  /** 章號。 */
  no: number;
  /** 介面上那一行的完整說法（「第 12 章《夜訪》」）。 */
  label: string;
  title: string;
  /** 這一章在哪一卷（{@link VolumeView.name}）：有正文看正文，否則看細綱。直接放在章節根下是空串。 */
  volume: string;
  /**
   * 這一行的**主路徑**：有正文就是正文，否則是細綱（還沒有細綱時是它應該在的位置）。
   * 它是這一章在協議上的身份——`selectPlot` / 重新命名 / 刪除都拿它去認那一章。
   */
  relPath: string;
  /** 細綱路徑。還沒有細綱時是它**應該**在的位置（切到細綱層、寫細綱都要一個落點）。 */
  plotPath: string;
  /** 細綱檔案在不在。「開啟細綱」只在它在的時候給。 */
  plotExists: boolean;
  /** 正文路徑。還沒有正文時是空串。 */
  chapterPath: string;
  wordCount: number;
  /** 目標字數（細綱的，或配置的每章字數）。都沒有是 undefined。 */
  targetWords?: number;
  /** 有正文卻還沒定稿，或定稿之後正文又改過（只對有正文的章有意義）。 */
  stale: boolean;
  stage: PlotStage;
  progress: PipelineProgress;
  /** 細綱或正文的上游變過（⟳）。 */
  upstreamStale: boolean;
  /** 有草稿檔案。只有正文才有草稿。 */
  hasDraft: boolean;
  draftPath: string;
}

/**
 * 「章節」頁簽上的一卷（2026-10-23）：`chapters/` 下的一個一級目錄，細綱在 `summaries/` 下映象同一個目錄。
 * 卷只是收納——章號全書連續，不按卷重排。
 */
export interface VolumeView {
  /** 卷名（目錄名）。直接放在章節根下的那幾章是空串，介面上叫「未分卷」。 */
  name: string;
  /** 卷目錄（`chapters/第二卷`）；「未分卷」是章節根。卷標題右鍵「在此卷新建章節檔案」的落點。 */
  relPath: string;
  /** 這一卷的第一章與最後一章（章號）。還空著的卷兩個都缺席。 */
  from?: number;
  to?: number;
  /** 這一卷已寫正文的字數。 */
  words: number;
  /** 接在最後新排的細綱、新建的章節檔案預設落進這一卷（`NovelProject.subdirForNewChapter`）。最多一卷是 true。 */
  latest: boolean;
}

/**
 * 內建編輯器的章節索引裡的一行（`chapterIndex` 訊息）：工程樹那一行裡章節條與上一章 / 下一章要的那幾個欄位，
 * 由同一個函式算（`views/chapterIndex.ts`），兩處說法一字不差。
 */
export type ChapterIndexEntry = Pick<
  ProjectPlotNode,
  'no' | 'label' | 'title' | 'relPath' | 'plotPath' | 'plotExists' | 'chapterPath' | 'wordCount' | 'targetWords' | 'stage'
>;

/**
 * 角色 / 設定兩個區的樹節點。
 *
 * **沒有「章節節點」**：章節不在這棵樹裡——它與細綱合成了 `ProjectPlotNode`
 * 那一條扁平列表（見上）。這兩個區仍是任意深度的目錄樹。
 */
export type ProjectNode = ProjectDirNode | ProjectFileNode;

export interface ProjectDirNode {
  kind: 'dir';
  label: string;
  relPath: string;
  children: ProjectNode[];
  fileCount: number;
}

export interface ProjectFileNode extends ProjectFile {
  kind: 'file';
}

export interface PlotPipelineView {
  plotRelPath: string;
  /** 章號。 */
  no: number;
  title: string;
  /**
   * 情節大綱：這一章在不在裡面（大綱是各章細綱梗概的彙總，就是這一章的梗概寫了沒有），大綱排到第幾章（沒有是 0）。
   * 流水線條上「大綱」那一格畫它（2026-10-24）。
   */
  outline: { covered: boolean; coverage: number };
  plot: { relPath: string; exists: boolean; filled: boolean; upstreamStale: boolean };
  /** 同號的正文。 */
  chapter: {
    exists: boolean;
    relPath: string;
    words: number;
    /** 目標字數。都沒寫就 undefined，那時「有字就算寫夠」。 */
    targetWords?: number;
    /** 寫完正文之後，這一章的細綱改過。 */
    upstreamStale: boolean;
  };
  /** 定稿：`exists` = 細綱定稿過，`stale` = 沒定稿過或定稿之後正文又改過。 */
  summary: { exists: boolean; stale: boolean };
  stage: PlotStage;
  progress: PipelineProgress;
}

export interface NextStepView extends NextStepPlan {
  target: CreationTarget;
  no?: number;
  /** `form: 'idea'` 時一句話彈窗的預設值。 */
  formDefaults?: IdeaDefaults;
}

export interface WorkbenchSection {
  key: string;
  text: string;
}

export interface WorkbenchView {
  stage: CreationStage;
  /** 浮窗標題（「正文 · 第 4 章《空匣》」「架構 · 故事前提」）。 */
  title: string;
  /**
   * 這一層叫什麼（「正文」「細綱」「故事前提」「情節大綱」「設定條目」）。流水線條上的入口只寫它——
   * 章名、文件名已經在上面那行麵包屑上，入口再寫一遍就是同一句話說兩次。
   */
  layer: string;
  relPath: string;
  sections: WorkbenchSection[];
  warning?: string;
  /**
   * 不是出了問題、只是提個醒（完善設定三期 · 寫前提醒）：正文目標上「本章要用的 天機閣 還只有一句話」。零呼叫、不攔，
   * 不進主按鈕（第 20 條）。與 `warning`（上游變過，⟳）分開：兩件事長得一樣，作者就分不清哪個要緊。
   */
  notice?: string;
  empty?: string;
}

export interface ProjectFile {
  label: string;
  relPath: string;
  detail: string;
}

export interface CastEntry {
  name: string;
  aliases: string[];
  /** 出場章號。 */
  plots: number[];
  detail: string;
}

export interface CastSummary {
  /** 出場章號。 */
  plots: number[];
  detail: string;
  updatedThrough: number;
  pending: number;
}

/** 一條設定在定稿裡的出現與落後（工程頁設定行的副標題與 `＋N`）。 */
export interface LoreSummary {
  /** 定稿過的細綱「設定」一節點名它的章，升序。 */
  chapters: number[];
  /** `第 3–57 章 · 12 章`；一次都沒出現是空串。 */
  detail: string;
  updatedThrough: number;
  /** 水位之後還有幾章的新事實沒整合。 */
  pending: number;
  /** 關鍵詞（別稱）。行上不顯示，名錄篩選框按它也能找到。 */
  keywords: string[];
}

/** 「出現過 · 未建條目」那一組的一行。 */
export interface LoreUnfiledEntry {
  name: string;
  /** 建議的分類（各章寫的多數票），沒寫過是空串。 */
  category: string;
  chapters: number[];
  /** `5 章 · 第 3 章起`。 */
  detail: string;
}

/**
 * 「待完善」那一組的一行（完善設定，2026-10-19）。右鍵「展開…」：有條目發 `expandLore` 帶 `relPath`，
 * 沒有條目帶 `name` 與 `category`（後端先按分類建空條目）。
 */
export interface LoreThinEntry {
  /** 有條目是條目的標題；沒有是細綱「設定」一節裡的寫法。 */
  name: string;
  /** 有條目是條目所在的目錄；沒有是各章「設定」一節寫的多數票。沒有是空串。 */
  category: string;
  /** 條目路徑；還沒有條目時缺席。 */
  relPath?: string;
  /** 還沒有條目 / 正文是空的 / 新建設定的佔位 / 三節全是「（未交代）」。 */
  kind: 'missing' | LoreThinKind;
  /** 要用到它的章，升序。 */
  chapters: number[];
  /** `第 12 章起要用 · 只有一句話`。 */
  detail: string;
  /** 條目裡有作者的字：「全部展開」跳過它（完善設定三期，`views/lore.ts` 的 `ThinLore.authored`）。 */
  authored?: true;
}

export interface FailureView {
  at: string;
  severity: 'error' | 'warn';
  message: string;
  detail?: string;
  /**
   * 哪個動作留下的（`summarize` / `cardState` …）。前端只拿它決定多給哪一項選單：角色卡上掛著
   * `cardState`（定稿時作者改過的當前狀態沒被覆蓋，D15）就多一項「對比…」。
   */
  op?: string;
}

export interface CastConflictView {
  name: string;
  kind: 'name' | 'alias';
  cards: { name: string; relPath: string }[];
}

/** 工程頁懸停在章節行上時那隻浮窗：這一章的細綱（計劃，或定稿過的檔案）。 */
export interface PlotSummaryView {
  no: number;
  title: string;
  /** 浮窗標題裡那一行（「第 12 章《夜訪》」）。由後端給，文案只有一份。 */
  label: string;
  /** 有這份細綱。 */
  exists: boolean;
  /** 定稿過（細綱照正文反向更新過）。沒有就是計劃。 */
  finalized: boolean;
  /** 定稿過、正文後來又改過。 */
  stale: boolean;
  relPath: string;
  sections: { name: string; text: string }[];
  /**
   * 沒有細綱時那句話。有正文是「右鍵定稿可以照正文整理一份」，沒有正文就只說沒有——
   * 對一章還沒寫的說「右鍵定稿」是在指一條走不通的路。
   */
  emptyHint?: string;
}

export interface SerializedSession {
  id: string;
  title: string;
  target: CreationTarget;
  stage: CreationStage;
  capability: Capability;
  targetNo?: number;
  /** 這個會話讓模型想多深。輸入框旁那個下拉框回顯它。 */
  thinking: ThinkingDepth;
  turns: SerializedTurn[];
}

export interface SerializedTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  at: string;
  command?: string;
  attachments?: SerializedAttachment[];
  context?: SerializedDigest;
  /**
   * 僅 assistant 輪：這一輪發給模型的完整訊息留在會話檔案裡，裝配清單上畫「複製完整上下文」。
   * 正文不隨這裡推（一輪幾萬字），點了再經 `copyContext` 要。
   */
  fullContext?: boolean;
  acceptedTo?: string;
  interrupted?: boolean;
  error?: string;
  reasoning?: string;
  artifact?: SerializedArtifact;
  /**
   * 僅 assistant 輪：審稿報告（五期 W10）。有它就畫報告卡，不畫那段可就地編輯的正文。
   * `picks` 是預設勾選的條目（model/review.ts 的 `defaultPicks`）——與後端同一個演算法，前端不另寫。
   */
  review?: { report: ReviewReport; picks: string[]; notes?: string[]; calls?: number };
  /** 僅 user 輪：按審稿修稿時勾選的那幾條（氣泡上 `/按審稿修稿` 下面一條一行）。 */
  revise?: { items: string[] };
  /**
   * 僅 assistant 輪：這一輪**按發生順序**排下來的段——它說的話與它做的事交替。
   *
   * 介面認的就是這一個欄位：有段就按段畫（文字塊 / 工具條 / generate 卡交替），
   * 沒有段就是一塊正文（單步創作那條路，沒有工具可交替）。
   */
  segments?: SerializedSegment[];
  /** 僅 assistant 輪：外部 agent 經 MCP 調工具留下的氣泡。 */
  mcp?: boolean;
  /** 僅 assistant 輪：已經移除的內建 agent 留下的舊輪次，只留著回看（`isBuiltinAgentTurn`）。 */
  builtinAgent?: boolean;
}

/**
 * 一段。文字是模型自己說的話，工具是它做的一件事。
 *
 * 工具那一段把呼叫**整個帶上**（而不是隻給一個 callId 讓前端去別處找）：
 * 前端照著陣列畫一遍就完了，不必再維護一張表。
 */
export type SerializedSegment =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; call: SerializedToolCall };

export interface SerializedToolCall {
  callId: string;
  name: string;
  title: string;
  ok: boolean;
  summary: string;
  elapsedMs: number;
  /** 模型填的引數（JSON 文字，已截斷）。摺疊條展開後畫。 */
  argsText?: string;
  /** 回給模型的那段文字（已截斷）。摺疊條展開後畫。 */
  resultText?: string;
  /**
   * 僅 `generate`：它這一次流出來的正文（已截斷）。氣泡裡畫成一張單獨的卡片
   * ——那是作者要讀的產物，不是一行流水賬。
   */
  output?: string;
}

/**
 * 這一輪產出過什麼、落到哪兒了。**只是回放用的記錄**——寫不寫盤在產出的
 * 當下就問過了（`gate`），氣泡上不再有任何能觸發寫入的按鈕。
 */
export interface SerializedArtifact {
  where: string;
  summary: string;
  overwrites: boolean;
  /** 作者當時沒同意寫。寫了的那一份記在 `acceptedTo` 上。 */
  declined?: boolean;
  /** 寫入時會新建的角色卡（D19：細綱裡的新角色直接建卡，卡片上先列出來）。 */
  creates?: string[];
  /** 寫入時會新建的設定空條目（設定名錄：細綱裡本章首次引入的設定，同 D19；展開一條設定時建議拆出的子條目）。 */
  createsLore?: string[];
  /**
   * 細綱寫入時會寫進敘事線的計劃（敘事線二期，同 D19：先列出來）：「敘事線計劃：林昭與沈青 推進；埋〈玉佩的來歷〉」，
   * 一批幾章時一章一行；認不出是哪條線、沒寫進去的另起一行。已經排好了的幾行字（features/threadPlan.ts 的 `describeThreadPlan`）。
   */
  threadPlan?: string[];
  /**
   * 落定設定（完善設定二期）會更新的已有條目（標題）。寫入前逐條對比——卡片上先列出來，作者知道會彈幾次對比。
   */
  updatesLore?: string[];
  /**
   * 展開一條設定時附的「還沒定的問題」（完善設定，2026-10-19）。**只上卡片，不寫進任何檔案**：
   * 作者在對話裡答完再展開一次。
   */
  questions?: string[];
  /** 生成這一路上的降級與說明（截斷重來、拆半重試、漏欄位……，第 2 條）。 */
  notes?: string[];
  /** 這一輪一共調了幾次模型。 */
  calls?: number;
  /** 正文寫了多長（W7）：這一章寫完後的總字數、目標、這一次新寫的、續寫了幾輪、夠不夠八成。 */
  length?: WriteLength;
  /** 正文開頭與上一章結尾重合的那一段原文（重演）。卡片標紅，寫入要點兩下。 */
  replay?: string;
  /** 正文是追加在這一章末尾（「接著寫」），不是整章寫入。 */
  append?: boolean;
}

export type { WriteLength };

export interface SerializedDigest {
  usedTokens: number;
  budget: number;
  clamped: boolean;
  /** 按哪一級上下文詳細度裝的（1–4）。舊會話沒有，前端不顯示。 */
  detail?: number;
  items: {
    id: string;
    label: string;
    kind: string;
    priority: number;
    tokens: number;
    status: string;
    note?: string;
    source?: string;
  }[];
}

export interface SessionListItem {
  id: string;
  title: string;
  updatedAt: string;
  turnCount: number;
  preview: string;
  active: boolean;
}
