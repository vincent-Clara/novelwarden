/**
 * handler 的共享形狀。
 *
 * 一個 handler 回答三個問題：
 *
 * 1. **渲染**：結構化產物（`Artifact`）該變成這個種類的什麼檔案內容。
 * 2. **記賬**：寫完之後要把哪個上游指紋落進 frontmatter。
 * 3. **伴生**：改名/移動時要連帶搬走什麼。
 *
 * 三件事都可選。`plain` 三件都不做，`plot` 只做前兩件（細綱改名不帶走別的東西），`chapter` 做伴生
 * （草稿與細綱都映象正文的路徑，跟著正文搬）。
 */
import { NovelProject } from '../../model/project';
import { Artifact } from '../../features/artifact';
import { PathKind } from '../kind';

export interface HandlerCtx {
  project: NovelProject;
  /** 這次寫入的目標路徑（工作區相對，正斜槓）。 */
  rel: string;
  /** `kindOfPath` 的結果。種類與章號都在裡面。 */
  path: PathKind;
}

export interface HandlerWriteResult {
  rel: string;
  skipped?: boolean;
  message: string;
  /**
   * 這次寫入連帶做了什麼（記了哪個 hash、搬了哪個伴生目錄）。進日誌用。
   * **不靜默**：閘道器替呼叫方做的事必須說得出來。
   */
  side?: string[];
}

export interface Handler {
  /** 把結構化產物渲染成該種類的檔案內容。渲染需要讀盤（沿用磁碟那份的標題等）。 */
  render?(ctx: HandlerCtx, artifact: Artifact): Promise<string>;
  /**
   * 落盤位置的最終裁決。
   *
   * 給「檔名要讀盤才算得出來」的種類用：呼叫方給的路徑只是一個佔位，
   * 真正的落點由 handler 說了算。不實現就用呼叫方給的路徑。
   */
  resolve?(ctx: HandlerCtx, artifact?: Artifact): Promise<string>;
  /** 寫入之後的記賬與伴生動作。返回補進 `side` 的說明。 */
  after?(ctx: HandlerCtx, text: string): Promise<string[]>;
  /** 改名/移動時要連帶搬走什麼。返回補進 `side` 的說明。 */
  companions?(ctx: HandlerCtx, from: string, to: string): Promise<string[]>;
  /**
   * 複製出一份之後（`Workspace.copy`，位元組原樣拷過來）要補的賬。`ctx` 是副本，`from` 是原件的路徑。
   * 返回補進 `side` 的說明。**複製沒有伴生**：草稿、細綱都不跟著複製（副本是新的一份，見 `Workspace.copy`）。
   * 章節不實現它——複製進來的章節由 `copy` 在最後統一同步一次 manifest（與 `deferAfter` 同一個理由）。
   */
  afterCopy?(ctx: HandlerCtx, from: string): Promise<string[]>;
  /** 刪除時要連帶搬走什麼。返回補進 `side` 的說明。 */
  onRemove?(ctx: HandlerCtx, rel: string): Promise<string[]>;
}
