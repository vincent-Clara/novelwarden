/**
 * 工具層的契約。**這一份是 tools 與呼叫方之間唯一的約定**，兩邊都只認它。
 *
 * ## 工具不認識呼叫方
 *
 * 呼叫方是 MCP 那一頭（[controller/mcp.ts](../controller/mcp.ts)）。分工：
 *
 * | 誰 | 管什麼 |
 * |---|---|
 * | 工具 | 做那件事，回一段模型讀得動的文字；**報出自己花了幾次模型呼叫** |
 * | 呼叫方 | 上限、賬、閘門、迴圈。工具花了錢它記賬，工具要動磁碟它決定問不問 |
 *
 * 於是工具不認識「上限」這回事——它只會說「我調了 2 次模型」。誰在乎這個數字，
 * 誰自己去比對上限。
 *
 * ## 與 MCP 的對應
 *
 * 這套形狀是照著 MCP 的 `tools/list` + `tools/call` 擺的，端出去不必改工具體：
 *
 * | 這裡 | MCP |
 * |---|---|
 * | {@link ToolDef.name} / `description` / `parameters` | `tools/list` 的一條 |
 * | {@link ToolInvoker.invoke} → {@link ToolInvocation} | `tools/call` 的請求與結果 |
 * | {@link ToolDef.mutating} / `costly` | `destructiveHint` / `readOnlyHint` |
 * | {@link ToolIntent} | MCP 沒有對應物——**確認是宿主的事**，所以工具只描述意圖，不自己彈框 |
 *
 * 協議、傳輸、會話在 [mcp/](../mcp/README.md)。
 */
import type { NovelProject } from '../model/project';
import type { Workspace } from '../workspace';
import type { DraftStore } from '../generation/drafts';

/**
 * 對外的一條工具宣告：MCP `tools/list` 的一條就從它來（[mcp/server.ts](../mcp/server.ts)）。
 * `costly` / `mutating` 落成 MCP 的 `readOnlyHint` / `destructiveHint`。
 */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema object。 */
  parameters: Record<string, unknown>;
  costly?: boolean;
  mutating?: boolean;
}

// ---------------------------------------------------------------- 執行環境

/**
 * 工具夠得著的工程那一面。**由呼叫方繫結**（MCP 的每一次呼叫現綁當前工程與會話）。
 *
 * **沒有 `history`**：工具呼叫不是作者的討論，混進裝配器會被當成創作要求
 * （見 [novel/generate.ts](novel/generate.ts)）。
 */
export interface ToolEnv {
  project: NovelProject;
  workspace: Workspace;
  drafts: DraftStore;
  /** 草稿按會話分桶存：`write draftId=…` 與產出後那一問都靠它找回來。 */
  sessionId: string;
}

/**
 * 花錢記賬口。**工具只報數，不判斷觸沒觸頂**——上限是呼叫方的事。
 *
 * 為什麼是回呼而不是返回值：`generate` 在**發請求之前**就該記上這一筆，
 * 請求發出去錢就花了，中途拋異常也一樣。等函式返回再記，異常那條路上的錢
 * 就丟賬了。
 */
export interface UsageMeter {
  /** 記 n 次模型呼叫。 */
  record(calls: number): void;
}

/** 一次呼叫那一面：能不能停、說給誰聽、賬記到哪。 */
export interface ToolRun {
  signal: AbortSignal;
  /** 工具想說點什麼給使用者看（進氣泡，**不進模型上下文**）。 */
  report(message: string): void;
  /** 正文增量推給前端。同樣不進模型上下文。 */
  onDelta?(delta: string): void;
  usage: UsageMeter;
}

/** 工具體拿到的一切 = 環境 + 這一次呼叫。 */
export type ToolContext = ToolEnv & ToolRun;

// ---------------------------------------------------------------- 工具定義

/** 介面畫的那一行摘要，**不進模型上下文**。 */
export interface ToolDisplay {
  title: string;
  detail?: string;
}

export interface ToolResult {
  /**
   * 回給模型看的文字。**必須簡短**——它會留在呼叫方的上下文裡，每走一步
   * 重燒一遍。三千字正文塞回這裡，十步之後就是三萬字的重複賬單。
   */
  text: string;
  display?: ToolDisplay;
  /** 出錯了。**模型看得到**，據此重試或換路——所以要寫成它能照著改的話。 */
  error?: string;
  /** 這一次產出的草稿 id。呼叫方據此當場問一句「寫不寫」，不必去翻 store。 */
  draftIds?: string[];
}

/**
 * 動手之前的意圖：**這一步是什麼性質、要問的話該怎麼說**。
 *
 * 工具自己報，而不是讓呼叫方按名字猜——猜的那一版長這樣：
 *
 * ```ts
 * switch (tool.name) { case 'write': …; case 'edit': … }
 * ```
 *
 * 加一個工具就要回來改一次，而且忘了改不會紅，只會在某一天靜默地少問一句。
 */
export interface ToolIntent {
  gate: GateKind;
  /**
   * **動詞短語**，呼叫方在前面加主語（「Agent 要」/「遠端要」）：
   * `為「第 12 章的細綱」調一次創作模型`。
   *
   * 不寫成「呼叫 write」——作者答不上來，他不知道 write 會寫到哪。
   */
  title: string;
  /** 展開說這一步會發生什麼。`edit` 的 old → new 兩段原文就寫在這裡。 */
  detail?: string;
}

/**
 * 這一步的性質。**五個值，怎麼處理在呼叫方**（[controller/mcp.ts](../controller/mcp.ts)：
 * `auto` 直接跑；`always` 動手前在對話頁問；其餘問不問交給宿主的許可權設定）。
 *
 * | 值 | 什麼樣的動作 | 為什麼單獨一檔 |
 * |---|---|---|
 * | `auto` | 查詢 | 不花錢不改東西，問一句只是讓人麻木 |
 * | `costly` | 花錢但不寫盤 | 謹慎模式下值得問，平時不必 |
 * | `mutating` | 寫盤 | 常規的「動手前問一句」 |
 * | `reviewed` | 寫盤，但**下游自己會請人過目** | 再問一句是純噪聲：diff 本身就是答案 |
 * | `always` | 寫盤，且**下游不過目** | 那一句確認就是它的 diff，任何模式都不能免 |
 *
 * `reviewed` 與 `always` 是**產品承諾**（AGENTS 第 3 / 19 / 25 條）落在型別上的
 * 形狀：覆蓋已有內容一律過一遍人，區別只在過的是 diff 還是確認框。
 */
export type GateKind = 'auto' | 'costly' | 'mutating' | 'reviewed' | 'always';

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema，原樣透傳給各家 API。 */
  parameters: Record<string, unknown>;
  /**
   * 會花錢。**只是一條事實**（對應 MCP 的註解），閘門怎麼判在 {@link intent}。
   */
  costly?: boolean;
  /**
   * 會寫盤。同上，只是事實。
   *
   * **它不是保護**：八條守衛與覆蓋前審閱在 `workspace/` 那一層，和這個標記無關。
   */
  mutating?: boolean;
  /**
   * 這一次呼叫的意圖。**零 I/O 純函式**——它算出來的名字要與隨後 diff 上的
   * 名字逐字一致，所以兩邊都走 `kindOfPath` 那條純路徑。
   *
   * 不實現時由 {@link ToolRegistry} 按 `costly` / `mutating` 兜一個通用的。
   */
  intent?(args: Record<string, unknown>, project?: NovelProject): ToolIntent;
  /**
   * 引數本身對不對（缺哪個、動作認不認），**零 I/O**，不對時回一句給模型的話。
   *
   * 由 {@link ToolRegistry} 在 `run` 之前調，MCP 執行端在拿鎖、問作者之前也調——
   * 引數本來就不對的呼叫，不該先在對話頁彈一張「改「」裡的一段文字」再報錯。
   * 不實現也照樣過一遍按 `parameters` 的通用校驗（`schema.ts` 的 `checkArgs`）。
   */
  check?(args: Record<string, unknown>): string | undefined;
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
}

// ---------------------------------------------------------------- 呼叫口

/** 一次呼叫的結果。**絕不拋**：出錯也是一條正常返回。 */
export interface ToolInvocation {
  ok: boolean;
  /** 回給模型的文字（出錯時就是那句錯誤說明）。 */
  text: string;
  error?: string;
  display?: ToolDisplay;
  draftIds: string[];
  elapsedMs: number;
}

/**
 * 呼叫方眼裡的工具集：清單、意圖、執行。
 */
export interface ToolInvoker {
  /** 發給模型的工具清單。順序即模型看到的順序。 */
  specs(): ToolSpec[];
  /** 已註冊的名字。用來跟模型說「可用的是：…」。 */
  names(): string[];
  /** 這一步的意圖。名字不認識時返回 undefined。 */
  intent(name: string, args: Record<string, unknown>): ToolIntent | undefined;
  /** 引數對不對：不對時回那句報錯，名字不認識或沒問題時 undefined。`invoke` 自己也會先過它。 */
  check(name: string, args: Record<string, unknown>): string | undefined;
  /** 執行。**絕不拋**，認不出名字也回一條能讓模型換路的結果。 */
  invoke(
    name: string,
    args: Record<string, unknown>,
    run: ToolRun
  ): Promise<ToolInvocation>;
}
