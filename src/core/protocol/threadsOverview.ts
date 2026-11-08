/**
 * 「敘事線總覽」（獨立版內建編輯器裡的一個特殊標籤，敘事線重做三期）要的那份矩陣：章 × 線的時間軸。
 *
 * 標籤開啟時前端發 `requestThreadsOverview`，後端回 `threadsOverview`（同一個 `requestId`）——**按需要，不常駐推送**
 * （同「轉到…」的 `requestQuickOpen`）：這份東西只在總覽開著的時候有用，塞進每次檔案變動都全量重推的 `ProjectTree`
 * 等於每儲存一次就白推一遍。總覽開著時收到 `state`（磁碟上變過）再要一次。
 *
 * 構建見 `views/threads.ts` 的 `buildThreadsOverview`（純讀盤、不調模型、不落盤；狀態現算，第 18、28 條），
 * 前端只畫（`media/src/editor/threadsOverview.ts`）。設計見 docs/design/plans/2026-10-20-narrative-threads.md「八」。
 */
import type { ForeshadowStatus, ThreadEventType, ThreadKind, ThreadStatus } from '../model/threadFile';

/**
 * 一章（一列）的定稿狀態：
 * - `finalized`：定稿過（細綱上記著 `sourceHash`）、正文還在——與工程頁「現在」同一個口徑，定稿之後正文又改過的也算；
 * - `written`：有正文、還沒定稿；
 * - `planned`：只有細綱；
 * - `none`：細綱、正文都沒有（計劃事件或伏筆的回收章落在這裡）。
 */
export type ThreadsOverviewChapterState = 'finalized' | 'written' | 'planned' | 'none';

/** 一列。第 1 章到「計劃或已寫的最後一章」，一章不缺。 */
export interface ThreadsOverviewChapter {
  no: number;
  /** 細綱的標題優先，其次正文的；回落標題（「第 9 章」）與沒有檔案的章給空串。 */
  title: string;
  /** 所在的卷目錄（`第一卷`、`第一卷/上`），根下是空串；細綱、正文都沒有的章沿用前一章的卷。 */
  volume: string;
  state: ThreadsOverviewChapterState;
  /**
   * 定稿過、敘事線卻還沒判（四期：在水位之後、也沒另外判過）——列頭另一種樣子；這一列上的計劃不算偏差（線裡本來就還沒有它的
   * 實際事件）。只有 `finalized` 的列會有。
   */
  unjudged?: true;
  /** 正文路徑。缺席 = 還沒有正文。 */
  chapterPath?: string;
  /** 細綱路徑（正文映象的那一份，或者還沒有正文時按號認的計劃）。缺席 = 還沒有細綱。 */
  plotPath?: string;
  /**
   * 這一章是哪天（2026-10-24，從時間線現算）：`大衍三年三月十四 清晨`、`第 46 天`、`回憶（約二十年前）`——列頭與格子的懸停帶一句。
   * 同日「時間線總覽」：總覽裡的「時間線」一組與月份帶挪去時間線總覽（`protocol/timelineOverview.ts`），這裡只留這一句。
   * 時間線裡寫到的最後一章之後、沒推的章缺席。
   */
  time?: string;
}

/** 格子裡的一條事件（懸停看）。 */
export interface ThreadsOverviewEvent {
  type: ThreadEventType;
  /** 伏筆的事件掛的是哪一條。 */
  foreshadowing?: string;
  what: string;
  /** 正文裡的一句原文（定稿記下的實際事件才有；作者手寫的可以沒有）。 */
  evidence?: string;
}

/** 一行在某一章的一格。**只給有事件的章**（稀疏）。 */
export interface ThreadsOverviewCell {
  chapter: number;
  /** 計劃事件（拆細綱寫進線裡的，`第 N 章 · 計劃 · ……`）。 */
  planned: ThreadsOverviewEvent[];
  /** 實際事件（定稿記下的、作者手寫的）。 */
  actual: ThreadsOverviewEvent[];
  /**
   * 偏差：計劃了、那一章也定稿了（四期：敘事線也判過了）卻沒發生（畫紅圈）。線那一行：這一章有計劃、卻一條實際的線事件都沒有；
   * 伏筆那一行：計劃在這一章埋（收）的，到這一章為止還沒埋（收、棄）。比的是**現在的**計劃：定稿之後又重拆了那一章，偏差跟著變。
   */
  deviation: boolean;
}

/** 伏筆那一行上的連線（從第 `from` 章的中間畫到第 `to` 章的中間）。 */
export interface ThreadsOverviewSpan {
  from: number;
  to: number;
  /**
   * - `done`：埋了也收了（或棄了），實線連到收（棄）的那一章；
   * - `open`：埋了還沒收，虛線延到計劃回收章（伏筆那一行寫的與計劃裡收它的那一章取晚的；逾期的延到現在；都沒寫也延到現在）；
   * - `planned`：還沒埋，按計劃從埋的那一章到回收章畫一條淡的虛線。
   */
  kind: 'done' | 'open' | 'planned';
}

/** 一條伏筆一行（縮排在它所在的線下面，或在「未歸屬的伏筆」下面）。 */
export interface ThreadsOverviewForeshadow {
  name: string;
  what: string;
  status: ForeshadowStatus;
  /** 伏筆那一行寫的計劃：第幾章埋、第幾章前收。 */
  plant?: number;
  resolve?: number;
  /** 按第幾章前收算（推遲過的比 {@link resolve} 晚：計劃裡收它的那一章、寫明的「推遲到第 N 章收」取晚的）。 */
  resolveBy?: number;
  /** 實際埋在第幾章、收（棄）在第幾章。 */
  plantedAt?: number;
  closedAt?: number;
  /** 過了 {@link resolveBy} 還沒收、也沒棄（按「現在」算）。 */
  overdue: boolean;
  span?: ThreadsOverviewSpan;
  /** 懸停伏筆名看的幾行：是什麼、計劃、現在怎樣。 */
  tip: string;
  cells: ThreadsOverviewCell[];
}

/** 一條線一行，下面跟著它的伏筆。 */
export interface ThreadsOverviewLine {
  name: string;
  relPath: string;
  kind: ThreadKind;
  status: ThreadStatus;
  /** 計劃區間（frontmatter 的 `plan`），畫一條淡底。 */
  from?: number;
  to?: number;
  /** 與工程頁那一行同一份（`views/threads.ts` 的 `lineOf`）：`感情線 · 進行中 · 最近第 12 章 · 2 條伏筆沒收`。 */
  detail: string;
  /** 斷了幾章、幾條伏筆逾期、過了計劃收束的第幾章。 */
  warnings: string[];
  /** 意圖與當前進度（懸停線名看）。 */
  tip: string;
  /** 線自己的事件（推進 / 關係 / 收束 / 放棄）；伏筆的事件在伏筆那幾行。 */
  cells: ThreadsOverviewCell[];
  foreshadowing: ThreadsOverviewForeshadow[];
}

/** 按種類分組：主線 → 支線 → 感情線 → 人物線，沒有線的種類不給。 */
export interface ThreadsOverviewGroup {
  kind: ThreadKind;
  lines: ThreadsOverviewLine[];
}

export interface ThreadsOverview {
  /** 還不是小說工程（沒有 `.novelwarden/project.json`）時為 false，其餘都是空的。 */
  initialized: boolean;
  /** 第 1 章起一章一列。 */
  chapters: ThreadsOverviewChapter[];
  /** 定稿到的最後一章（豎線畫在它右邊），與工程頁「敘事線」頁籤同一個數。一章都沒定稿是 0。 */
  current: number;
  /**
   * 敘事線判到第幾章（四期：水位，不超過 {@link current}），與工程頁同一個數。落後於定稿時另畫一條豎線；線與伏筆的狀態（逾期、
   * 斷了、連線延到哪）按它算。
   */
  through: number;
  /** 分卷的書（有一章在卷目錄裡）：列頭上多一行卷名。 */
  volumes: boolean;
  groups: ThreadsOverviewGroup[];
  /** 「未歸屬的伏筆」。一條伏筆都沒有時缺席。 */
  unfiled?: { relPath: string; foreshadowing: ThreadsOverviewForeshadow[] };
  /**
   * 計劃裡提到的章號太遠（多半是手誤，`plan: 3-30000`）、列數被截在上限（`views/threads.ts` 的 `OVERVIEW_MAX_CHAPTERS`）時，
   * 原本要畫到第幾章。截掉的那幾章上的事件不畫，介面上照實說一句（第 2 條的精神：不靜默截斷）。
   */
  clippedFrom?: number;
}
