/**
 * 存檔點（工程頁「存檔點…」彈窗）的訊息負載。設計見 `docs/design/plans/2026-10-20-checkpoints.md`。
 *
 * - 列表：前端發 `listCheckpoints`，後端回 `checkpoints`（新的在前）。存一個（`createCheckpoint`）、寫備註並留住
 *   （`noteCheckpoint`）之後也重推它。
 * - 跟現在比：前端發 `checkpointDiff`，後端逐份比 sha，回 `checkpointDiff`。每份帶此刻磁碟上那一份的 hash（`hashNow`），
 *   退回時原樣帶回來當樂觀鎖。
 * - 退回：前端發 `restoreCheckpoint`（要退回哪幾份、要搬進回收站哪幾份、樂觀鎖、編輯器裡有未儲存修改的那幾份），
 *   後端先存一個「退回之前」、逐份寫回，toast 彙總，然後重推 `checkpoints` 與這個存檔點的 `checkpointDiff`。
 *
 * 儲存在 `workspace/checkpoints.ts`，退回的編排在 `features/checkpoint.ts`，訊息在 `controller/checkpoints.ts`。
 */
import type { ArtifactKind } from '../workspace/kind';

/** 列表裡的一個存檔點。 */
export interface CheckpointView {
  /** 清單的檔名去掉 `.json`（`2026-10-20_22-30-05+0800`），比、退回、寫備註時認它。 */
  id: string;
  /** 存下的那一刻（毫秒時間戳）。 */
  time: number;
  /** 手動的是作者寫的（可以空），自動的是機器寫的「批次寫章之前（第 12–20 章）」。 */
  note: string;
  /** 自動存的：只留最近 30 個；寫了備註就留住（變成手動）。 */
  auto: boolean;
  /** 存了幾份檔案。 */
  files: number;
  /** 其中幾章正文、正文一共多少字。 */
  chapters: number;
  chapterWords: number;
  /** 超過大小上限、沒存進去的那幾份（第 2 條：說出來）。 */
  skipped: string[];
}

/** 跟現在比，一份檔案的情形。 */
export type CheckpointFileStatus =
  /** 存檔點裡有、現在也有，內容不一樣。 */
  | 'changed'
  /** 存檔點裡有、現在沒有了（之後刪掉或搬走了）。 */
  | 'deleted'
  /** 現在有、存檔點裡沒有（之後新建或搬過來的）。 */
  | 'added';

export interface CheckpointDiffEntry {
  path: string;
  kind: ArtifactKind;
  status: CheckpointFileStatus;
  /** 存檔點裡那一份的字數（`added` 沒有）。 */
  wordsThen?: number;
  /** 磁碟上現在這一份的字數（`deleted` 沒有）。 */
  wordsNow?: number;
  /** 磁碟上現在這一份的 hash（閘道器樂觀鎖的口徑，`model/fs.ts` 的 `hash`）。`deleted` 沒有。 */
  hashNow?: string;
}

export interface CheckpointDiffView {
  id: string;
  /** 內容一模一樣的有幾份（不逐份列）。 */
  unchanged: number;
  /** 按路徑排；一模一樣的不在裡面。 */
  entries: CheckpointDiffEntry[];
}

/** 退回：要退回的、要搬進回收站的，都是 `checkpointDiff` 裡列過的。 */
export interface RestoreCheckpointRequest {
  id: string;
  /** 退回成存檔點裡那一份（`changed` / `deleted`）。 */
  paths: string[];
  /** 搬進回收站（`added`：存檔點之後新建的，作者勾了才有）。 */
  trash: string[];
  /**
   * 樂觀鎖：每份在面板上看到時的 hash（`hashNow`），`null` 表示當時磁碟上沒有它。對不上就跳過這一份——
   * 這期間別處又改過，不拿存檔點裡的舊稿蓋掉新改的。
   */
  expect: Record<string, string | null>;
  /** 編輯器裡開著、有未儲存修改的檔案：跳過（同全書替換）。 */
  dirty: string[];
}
