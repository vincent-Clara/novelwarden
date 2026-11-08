/**
 * 「時間線總覽」（獨立版內建編輯器裡的一個特殊標籤，2026-10-24，設計稿 docs/design/plans/2026-10-24-timeline-page.md）要的那份資料：
 * 豎著按故事日子排，一個日子一項，那一天的幾章一章一張卡片。
 *
 * 和「敘事線總覽」同一個做法：標籤顯示出來時前端發 `requestTimelineOverview`，後端回 `timelineOverview`（同一個 `requestId`）——
 * **按需要，不常駐推送**（只在總覽開著的時候有用，塞進每次檔案變動都全量重推的 `ProjectTree` 等於每儲存一次就白推一遍）。
 *
 * 構建見 `views/timeline.ts` 的 `buildTimelineMatrix`（純函式、不調模型、不落盤；日期與對賬現算，第 18、28 條），讀盤在
 * `views/threads.ts` 的 `buildTimelineOverview`；前端只畫（`media/src/editor/timelineOverview.ts`）。文案都由後端給。
 */
import type { ThreadEventType } from '../model/threadFile';
import type { TimelineDayState, TimelineSeason } from '../model/timelineFile';
import type { TimelineIssueView } from './views';

export interface TimelineOverview {
  /** 還不是小說工程（沒有 `.novelwarden/project.json`）時為 false，其餘都是空的。 */
  initialized: boolean;
  /** `threads/时间线.md`（還沒有這份檔案時也給：補推會建它）。 */
  relPath: string;
  /** 檔案在不在。 */
  exists: boolean;
  /** 標題欄後面那一串：`簡單歷 · 起點 大衍三年三月初七 · 推到第 30 章 · 故事第 46 天（大衍三年四月十九 夜裡）`。 */
  meta: string;
  /** 標題欄的懸停：曆法怎麼算、起點。 */
  tip: string;
  /** 「改曆法與起點」「填為起點」要的（同工程頁那一組）。 */
  calendar: { name: '简单历' | '公历'; start: string; suggestion?: { start: string; note: string } };
  /** ⚠ 一條一行（不帶 ⚠，前端加）：對賬、推不出、認不出、起點、還沒推。`chapter` 給了的點了展開那一章。 */
  issues: TimelineIssueView[];
  /** 篩選下拉里的線：有實際事件的線，按種類（主線 → 支線 → 感情線 → 人物線）與目錄裡的先後；「未歸屬的伏筆」排最後。顏色同卡片。 */
  threads: TimelineOverviewThread[];
  /** 軸：按故事日子從早到晚，一個日子一項（沒有章的日子不給）。 */
  days: TimelineOverviewDay[];
  /** 同步過、時間線裡還沒有（或還推不出）的章（右鍵「補推時間」）。沒有時缺席。 */
  missing?: { count: number; text: string };
  /** 機器寫的行有幾行（右鍵「重推」；0 時不給）。 */
  machine: number;
  /** 最後一章的章號（「從這一章起重推」到哪一章）。 */
  last: number;
}

/** 一條線：名字與顏色（0–7 按線的先後各一色、不迴圈；第 9 條線起與「未歸屬的伏筆」一樣是 -1，灰——名字總寫在標籤上）。 */
export interface TimelineOverviewThread {
  name: string;
  color: number;
}

/** 軸上的一個日子。 */
export interface TimelineOverviewDay {
  /** 故事第幾天（第 1 天 = 起點；只有回憶、一天都推不出時是 0）。 */
  day: number;
  /** 軸上寫的：`三月初七`、`3月7日`；沒起點 `第 8 天`。 */
  label: string;
  /** 下面一行小字：`第 1 天`（沒起點時缺席——大字就是它）。 */
  sub?: string;
  /** 懸停：`大衍三年三月初七`。 */
  full: string;
  /** 這一天在哪個月（填了起點才有）：`大衍三年三月`。月份變了，前端插一行分隔。 */
  month?: string;
  /** 那個月是什麼季節（同對賬的口徑：簡單歷正月到三月是春，公曆 3–5 月是春）。 */
  season?: TimelineSeason;
  /** 這一天開頭的章（按章號）；回憶的章跟在閱讀順序上前一章後面。 */
  cards: TimelineOverviewCard[];
}

/** 一章一張卡片。 */
export interface TimelineOverviewCard {
  no: number;
  title: string;
  state: TimelineDayState;
  /** 右上角那一截：`清晨 → 夜裡`、`清晨 → 三月十五 夜裡 · 3 天`、`回憶（約二十年前）`；同一天又沒寫時段是空串。 */
  when: string;
  /** 比上一章：`+2 天`、`同一天`、`往回 3 天`；第 1 章、回憶、沒推缺席。 */
  delta?: string;
  /** 結尾是故事第幾天（前端照它算「N 天后」：下一個日子比它晚 2 天以上才畫）。回憶缺席。 */
  end?: number;
  /** 依據「…」、推測：…、推不出：…、正文寫明八月十五、你定的、還沒推（截短；全文在 `detail`）。 */
  note: string;
  /** 這一章在各條線上實際發生的事（計劃的不給），按線的先後、同一條線裡照檔案裡的先後。 */
  events: TimelineOverviewEvent[];
  /** 一條事件都沒有時：細綱的梗概。 */
  synopsis?: string;
  /** 對賬報了這一章的幾條（卡片上紅字一條一行）。 */
  issues: string[];
  /** 展開之後的詳情（一條一行）：那一天的全稱、故事第幾天、比上一章、歷時、依據、正文寫明的、對齊、季節、細綱的時間地點。 */
  detail: string[];
  /** 整章是回憶：掛在閱讀順序上前一章那一天裡，縮排、虛線框。 */
  flashback?: true;
  /** 「只看有問題的」留它：對賬報了、推不出、認不出、還沒推。 */
  problem: boolean;
  /** 正文、細綱（右鍵開啟）；還沒有時缺席。 */
  chapterPath?: string;
  plotPath?: string;
  /** 這一行是機器寫的（右鍵「重推這一章」給不給）。 */
  machine: boolean;
}

/** 卡片上的一條事件。 */
export interface TimelineOverviewEvent {
  /** 線名；「未歸屬的伏筆」裡的寫「未歸屬的伏筆」。 */
  thread: string;
  /** 同 {@link TimelineOverviewThread.color}。 */
  color: number;
  type: ThreadEventType;
  /** 伏筆的事件掛的是哪一條。 */
  foreshadowing?: string;
  what: string;
  /** 正文裡的一句原文。 */
  evidence?: string;
}
