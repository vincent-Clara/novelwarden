/**
 * 全書查詢替換（獨立版內建編輯器「編輯 → 全書查詢替換…」）的訊息負載。
 *
 * - 查詢 / 預覽：前端發 `bookFind`（帶 requestId；停頓之後才發，上一次還在搜的先發 `cancelBookFind` 叫停），後端
 *   按範圍逐份讀盤、匹配，回 `bookFindResult`（同一個 requestId；回覆是廣播，只有發問的那一邊認）。帶
 *   `replacement` 就是「預覽替換」：每一處多帶一個換成什麼，每份檔案帶預覽時讀到的 hash（替換時的樂觀鎖基線）。
 * - 替換：前端發 `bookReplace`（預覽裡勾著的那幾處、每份檔案的基線、編輯器裡有未儲存修改的那幾份），後端經閘道器
 *   逐份寫，回 `bookReplaceDone`（彙總）。
 *
 * 搜尋在 `views/bookFind.ts`（讀了哪些盤寫在那裡），替換在 `features/bookReplace.ts`，口徑在 `model/bookFind.ts`
 * 與 `model/textFind.ts`。
 */
import type { BookFindScope } from '../model/bookFindScope';

export type { BookFindScope } from '../model/bookFindScope';

/** 找什麼、在哪找。 */
export interface BookFindQuery {
  query: string;
  caseSensitive?: boolean;
  regex?: boolean;
  /** 勾著的範圍。一個都沒有就什麼都不搜。 */
  scopes: BookFindScope[];
  /** 給了就是「預覽替換」：每一處帶上換成什麼（正則時 `$1` 按這一處在全文裡展開）。空串也算（換成空 = 刪掉）。 */
  replacement?: string;
}

/** 一處。 */
export interface BookFindHit {
  /** 磁碟上那一份（解碼之後）的下標，`[start, end)`。替換時原樣帶回來。 */
  start: number;
  end: number;
  /** 第幾行（從 1 起）與那一行裡的第幾個字（從 0 起）。點這一處時編輯器按它定位。 */
  line: number;
  col: number;
  /** 同一行裡命中前後的一截（截過的帶「…」）與命中的字（跨行畫成「↵」）。只給人看。 */
  before: string;
  text: string;
  after: string;
  /** 預覽：這一處換成什麼。對不上（極少見）時缺席。 */
  replacement?: string;
}

/** 一份檔案的命中。 */
export interface BookFindFile {
  path: string;
  scope: BookFindScope;
  /** 「第 3 章 夜訪」「細綱 · 第 3 章 夜訪」「角色 · 林晚」「情節大綱」——與編輯器標籤、麵包屑同一套叫法。 */
  label: string;
  /** 這一次讀到的那一份的 hash（與編輯器的樂觀鎖同一個演算法）。替換時帶回來：之後磁碟變過就跳過這一份。 */
  hash: string;
  /** 這份檔案裡一共幾處。比 `hits.length` 多 = 到了上限，後面的沒列。 */
  count: number;
  hits: BookFindHit[];
}

/** 沒搜的那一份與原因（超過 2 MB、讀不了）。 */
export interface BookFindSkip {
  path: string;
  label: string;
  reason: string;
}

export interface BookFindResult {
  /** 有命中的檔案，按範圍（正文、細綱、草稿、角色卡、設定、其他）、範圍裡按章號 / 名字排。 */
  files: BookFindFile[];
  /** 列出來的處數（各份 `hits` 加起來）。 */
  listed: number;
  /** 讀了幾份檔案。 */
  scanned: number;
  /** 到了上限就停（後面的檔案沒有讀）：上限是幾處，停在哪一份上。 */
  truncated?: { limit: number; at: string };
  skipped: BookFindSkip[];
  /** 正則寫錯了（瀏覽器給的原因），這時什麼都沒搜。 */
  error?: string;
}

/** 替換時一份檔案：預覽時的基線與勾著的那幾處（`start` / `end` 原樣取自預覽）。 */
export interface BookReplaceFileRequest {
  path: string;
  hash: string;
  hits: { start: number; end: number }[];
}

export interface BookReplaceRequest {
  query: string;
  caseSensitive?: boolean;
  regex?: boolean;
  replacement: string;
  /** 預覽時勾著的範圍（替換隻認落在這幾個範圍裡的檔案）。 */
  scopes: BookFindScope[];
  files: BookReplaceFileRequest[];
  /** 編輯器裡開著、有未儲存修改的那幾份：一律跳過（讓作者先儲存或放棄）。 */
  dirty: string[];
}

/**
 * 為什麼跳過：`dirty` 編輯器裡有未儲存的修改；`changed` 預覽之後磁碟上改過（不拿舊的蓋新的）；`gone` 磁碟上已經沒有了；
 * `mismatch` 勾著的那幾處在檔案裡對不上了；`unchanged` 換完與原來一字不差；`noHistory` 沒能先存一版歷史（這次替換的
 * 退路就是歷史版本，存不下就不換）；`outOfScope` 不在全書替換的範圍裡；`error` 寫的時候出錯。
 */
export type BookReplaceSkipReason =
  | 'dirty'
  | 'changed'
  | 'gone'
  | 'mismatch'
  | 'unchanged'
  | 'noHistory'
  | 'outOfScope'
  | 'error';

export interface BookReplaceDone {
  path: string;
  label: string;
  /** 換了幾處。 */
  count: number;
}

export interface BookReplaceSkipped {
  path: string;
  label: string;
  reason: BookReplaceSkipReason;
  /** 給人看的一句（為什麼、作者接著該怎麼做）。 */
  message: string;
}

/** 角色卡裡的名字或別名換了（檔名沒跟著改）。 */
export interface BookReplaceRenamedCard {
  path: string;
  label: string;
  /** 換完之後卡裡的名字（frontmatter 的 `name`，沒有就是 `# 標題`，再沒有是檔名）。 */
  name: string;
  /** 名字換了（false = 只換了別名）。 */
  nameChanged: boolean;
}

export interface BookReplaceSummary {
  /** 換了的檔案數與處數。 */
  files: number;
  hits: number;
  replaced: BookReplaceDone[];
  skipped: BookReplaceSkipped[];
  /**
   * 第 18 條（⚑）：這一次裡細綱與正文**都**改了、改之前指紋對得上的章（「第 3 章 夜訪」）——`writtenFrom`（與定稿過的
   * `sourceHash`）刷成替換之後的，不掛 ⟳、不退回待定稿。
   */
  chainKept: string[];
  /** 只改了細綱、正文沒跟著改的章：正文掛 ⟳（正文可能跟不上細綱了）。 */
  plotOnly: string[];
  /** 只改了正文、細綱沒跟著改的定稿過的章：回到「待定稿」。 */
  bodyOnly: string[];
  renamedCards: BookReplaceRenamedCard[];
  /** 整個請求沒法做（正則寫錯、查詢串為空）。 */
  error?: string;
}
