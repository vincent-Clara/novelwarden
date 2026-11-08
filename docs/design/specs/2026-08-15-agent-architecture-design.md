# Agent 架構改造設計

日期：2026-08-15
狀態：待評審

## 背景與目標

對話頁現在是 **chatbot + workflow** 的形態：作者在輸入框裡挑一個命令（討論 / 拓展 / 挑刺 / 生成大綱 / 重寫大綱 / 落定劇情 / 拆成場景 / 寫正文），後端按 `Stage × Capability` 裝配一次上下文、調一次模型、把結果攤在氣泡裡等他點「採納寫入」。每一次互動都是**一問一答的單步**。

這套東西的單步質量很好——分階段裝配（`context/recipes.ts`）、身份化提示詞（`context/prompts.ts`）、三層降級解析（`features/artifact.ts`）、零模型呼叫的新鮮度鏈與狀態機（`model/pipeline.ts`）都是調出來的。**本次改造一個字都不動它們。**

缺的是**多步**：

- 「把 12 到 18 章排一遍，注意跟第 9 章埋的伏筆對上」——現在要作者自己點七次，還要自己去翻第 9 章。
- 「這一章太平了，你看著辦」——現在得由作者先診斷出問題在劇情層還是場景層，再挑對應的命令。
- 「主角前面說過他沒去過北境嗎？」——現在只能靠作者手動 `@` 引用幾章原文，跨章對賬根本做不了。

目標：**把 AI 從「執行一條命令」改成「拿著工具達成一個目標」**，同時保住既有的全部產品承諾（AGENTS.md 的 23 條）。

**非目標**：不做一鍵成書、不做多 agent、不讓 agent 決定「下一步該做什麼」（那是狀態機的活）。

## 核心決策

| 決策點 | 結論 | 理由 |
| --- | --- | --- |
| agent 與既有單步命令的關係 | **並存**。命令仍然直通，不進 agent 迴圈 | 點「寫劇情」是確定性單步，多一次排程呼叫只是加錢加延遲 |
| 「下一步」由誰算 | **仍是 `deriveNextStep`**，agent 每回合免費讀到它 | 第 20 條：介面永遠只推薦一個下一步，且由狀態機算出來。兩處各判各的，介面上就會出現「徽章說待拆場景，agent 讓你寫正文」 |
| 工具座標系 | **一律用路徑**，不收 `stage` / `chapterNo` / `sceneNo` | 工程裡所有東西已經是普通 Markdown；層與目標能從路徑反推 |
| 工具數量 | **7 個通用工具**，不做每層一個的特化工具 | 模型見過 `read` / `write` / `edit` / `search` 千萬次，沒見過 `breakdown_scenes`。領域知識留在 `prompts.ts`，由 `generate` 內部那次呼叫自己帶著 |
| agent 上下文 | **薄**：只有狀態、路徑、字數、hash、工具結果摘要 | 生成產物（三千字正文）絕不回灌迴圈，否則每走一步重燒一遍 |
| 生成工具的上下文 | **厚**：照舊走 `buildContext` + `recipeFor` | 這是既有質量的來源，不能繞過 |
| 工具呼叫降級 | **不做**。模型不支援 tool calling 就當不了 agent | 使用者明確要求不考慮相容；文字協議兜底的解析失敗率會毀掉體驗 |
| 向後相容 | **不做**。`chatStream` 直接換成事件流 | 專案處於初期開發階段（.claude/CLAUDE.md） |
| 裸檔案系統訪問 | **不給**。沒有 `bash`，沒有工程根之外的路徑 | 既有落盤路徑揹著一堆不變數，見下 |

### 為什麼工具必須收路徑而不是章號

`Stage` 與 `CreationTarget` 都能從路徑反推：目錄決定層（`plots/` → plot，`scenes/X/` → scene，`manuscripts/` → manuscript，章節根 → chapter），檔名數字字首決定章號，場景號在檔名裡。這張對映表本來就散在四處（`files/fileOps.ts` 的 `sectionOf` / `isPlotPath`、`model/plotFile.ts` 的 `parsePlotFileName`、`model/chapterFile.ts` 的 `parseChapterFileName`、`project.ts` 的 `summaryPathForChapter`），收成一張表是這次重構的副產品。

收路徑的三個好處：

1. **消掉翻譯層**。agent 說 `plots/012-入宗.md`，工具直接用，不必再把章號翻迴路徑。
2. **`read` / `search` / `edit` 三個通用工具立刻可用**，不需要為每層各寫一個。
3. **與「資料是普通 Markdown」的產品定位一致**。作者在檔案管理器裡看到的路徑，就是 agent 用的路徑。

### 為什麼不給裸 `write_file`

既有落盤路徑揹著一批不變數，繞過任何一條都會安靜地損壞工程：

- 細綱改名要連帶搬走場景目錄與中轉站正文（`carryPlotCompanions`），當普通檔案搬會把它們變成孤兒（第 7 條）
- 拆分要**先移號再落盤**（第 23 條），反過來會留下「章節已建但細綱還撞著號」的中間態
- 場景檔名由「場號 + 標題」決定，改標題要清掉舊檔名，否則同一場以兩個檔名並存
- 寫正文要記 `beatsHash`，寫細綱要記 `upstreamHash`（第 18 條），漏了新鮮度鏈就斷
- 刪除一律進 `.trash/`（第 6 條）；同名目標一律報錯退出（第 3 條）

所以 `write` 不是「往這個路徑寫位元組」，而是「按這個路徑**應有的種類**寫一份合法產物」——種類判定、渲染、記賬、伴生搬遷、覆蓋審閱全在工作區層裡做一次。

## 架構：四層，自下而上

```
core/llm/         L0  事件流 provider（含 tool calling）
core/workspace/   L1  唯一讀寫閘道器：路徑 → 種類 → 解析/渲染/記賬/授權
core/generation/  L2  裝配 + 調模型 + 產物解析（無狀態）
core/tools/       L3  工具：契約、登錄檔、novel/ 那七個（後來從 agent/ 獨立出來）
core/agent/       L3  排程：迴圈、狀態注入、預算、策略（與 tools/ 並列，只認 ToolInvoker）
```

依賴方向嚴格自下而上。L1 不認識 L2，L2 不認識 L3。

改造順序就是這個順序，**每層獨立交付，前三層零新功能**。

---

## L0 · 事件流 provider

### 現狀

```ts
chatStream(messages: ChatMessage[], options: ChatOptions): AsyncIterable<string>
```

只吐字串，`reasoning` 與 `usage` 走 options 上的回呼。`ChatMessage` 只有 `system | user | assistant` + `content`。三個 provider（OpenAI 相容 / Anthropic / vscode-lm）都沒有 tools。

### 目標態

一個原語，四種事件：

```ts
export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  /** 引數累積完整、JSON 解析成功之後才發一次。 */
  | { type: 'toolCall'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'usage'; usage: TokenUsage };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema，直接透傳給各家 API。 */
  parameters: Record<string, unknown>;
}

export type AgentMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface LlmProvider {
  readonly id: 'openai' | 'anthropic' | 'vscode-lm';
  readonly label: string;
  maxInputTokens(): Promise<number | undefined>;
  stream(messages: AgentMessage[], options: StreamOptions): AsyncIterable<StreamEvent>;
}

export interface StreamOptions extends ChatOptions {
  tools?: ToolSpec[];
  /** 'auto' | 'none' | 'required'。預設 auto。 */
  toolChoice?: ToolChoice;
}
```

`onReasoning` / `onUsage` 從 options 上**刪掉**——它們現在是事件流裡的一等公民。

### 既有 13 個呼叫點怎麼辦

`collectStream` 改成 `collectText`，簽名保持「傳一個流，拿一段文字」：

```ts
export async function collectText(
  stream: AsyncIterable<StreamEvent>,
  handlers?: { onDelta?(d: string, full: string): void;
               onReasoning?(d: string, full: string): void;
               onUsage?(u: TokenUsage): void }
): Promise<string>;
```

摘要、角色卡、設定、文風、批次流水線五個模組的呼叫形狀不變，只是把原來傳給 `chatStream` 的 `onReasoning` / `onUsage` 挪到 `collectText` 的第二參。**行為逐位元組不變**，`npm test` 全綠即算過。

### 三家的分片累積（本層八成的工作量與八成的 bug）

| 服務商 | 工具呼叫怎麼來 | 坑 |
| --- | --- | --- |
| OpenAI 相容 | `delta.tool_calls[]`，每片帶 `index` / 可選 `id` / 可選 `function.name` / `function.arguments` 片段 | **按 `index` 累積，不是按 `id`**——`id` 只在第一片給。多個並行工具呼叫各佔一個 index |
| Anthropic | `content_block_start`（`content_block.type === 'tool_use'`，帶 `id` / `name`）+ `content_block_delta`（`delta.type === 'input_json_delta'`，帶 `partial_json`）+ `content_block_stop` | 引數是**逐字元拼出來的 JSON 串**，只有 `content_block_stop` 之後才完整。`tool_result` 要作為 `user` 訊息裡的 content block 回傳，不是獨立 role |
| vscode-lm | `sendRequest(msgs, { tools })`，響應流裡出現 `LanguageModelToolCallPart` | 引數已經是解析好的物件，不用累積。系統提示仍要並進首條 user |

三家共同的收斂點：**`args` 解析失敗不拋**，發一個 `toolCall` 但 `args: {}`，由 agent 層報「引數解析失敗」給模型看，讓它重試。拋異常會讓整輪對話炸掉。

### 模型能力標記

`ModelEntry` 加一個可選欄位：

```ts
/** 該模型支援工具呼叫，可以當 agent 的排程模型。 */
supportsTools?: boolean;
```

設定頁勾選。沒勾的模型在 agent 模型選擇器裡不出現。**不做自動探測**——探測要真發一次帶 tools 的請求，那是在使用者沒點任何東西的時候花錢。

---

## L1 · workspace：唯一讀寫閘道器

### 現狀：寫盤散在六處

| 位置 | 管什麼 | 帶哪些保護 |
| --- | --- | --- |
| `model/project.ts`（1501 行） | 所有產物的讀寫 | 路徑推導、frontmatter 渲染、伴生搬遷 |
| `features/creation.ts` 的 `acceptArtifact` | 六條採納落盤路徑 | `confirmOverwrite` / `reviewReplace`、記 `upstreamHash` / `beatsHash` |
| `files/fileOps.ts` | 三區類檔案操作 | 區界限、同名不覆蓋、`.trash` |
| `files/fileEditing.ts` | 內建編輯器讀寫 | 工程根包含、副檔名白名單、大小上限、內容 hash 樂觀鎖 |
| `files/projectFiles.ts` | 檔案頁的移動/複製/改名 | 工程根包含、`isProtectedPath`、同名不覆蓋 |
| `features/splitChapter.ts` | 拆分 | 先移號再落盤、伴生搬遷 |

每處各帶一部分保護，誰也不認識誰。**這就是為什麼現在不敢給 agent 一個 `write`。**

還有一個既有缺陷：**記賬只在「採納」路徑上做**。作者在內建編輯器裡改一份細綱，`upstreamHash` 不會更新，指紋鏈就斷了——那一章從此再也不掛 ⟳。

### 目標態

```
core/workspace/
  index.ts       對外 6 個方法：list / read / write / edit / move / remove
  kind.ts        路徑 → 種類（純函式，零 I/O）
  guard.ts       統一入口守衛：越界 / 區界限 / 保護路徑 / 大小 / 樂觀鎖
  handlers/      每種產物一個 handler：解析、渲染、記賬、伴生
```

#### 種類表（`kind.ts`）

```ts
export type ArtifactKind =
  | 'outline' | 'style' | 'globalSummary'   // 固定單檔案
  | 'plot' | 'scene' | 'manuscript'
  | 'chapter' | 'summary' | 'draft'
  | 'character' | 'lore'
  | 'other';                                 // 工程內其它純文字

export interface PathKind {
  kind: ArtifactKind;
  /** 該路徑對應的創作層，`other` 與非創作產物為 undefined。 */
  stage?: CreationStage;
  /** 該路徑對應的創作目標，供 generate 直接使用。 */
  target?: CreationTarget;
  no?: number;       // 章號
  sceneNo?: number;
}

export function kindOfPath(project: NovelProject, relPath: string): PathKind;
```

**純函式、零 I/O、絕不拋**——認不出一律 `{ kind: 'other' }`。

| 種類 | 判定 | 解析 / 渲染 | 上游指紋 | 伴生 |
| --- | --- | --- | --- | --- |
| `outline` / `style` / `globalSummary` | 固定路徑 | 純文字 | — | — |
| `plot` | `plots/` 下 + 數字字首 | `plotFile.ts` | 寫入記 `hash(outline)` | 改名連帶場景目錄 + 中轉站正文 |
| `scene` | `scenes/<plotStem>/` 下 | `sceneFile.ts` | 寫入記 `plotContentHash(plot)` | 改標題時清掉舊檔名 |
| `manuscript` | `manuscripts/` 下 | 正文 + frontmatter | 追加記 `beatsHash` | — |
| `chapter` | 章節根下 + 數字字首 + 副檔名不在黑名單 | `chapterFile.ts` | — | 改名/移動帶草稿 |
| `summary` | `summaries/` 映象 | `summarize.ts` 的解析 | `sourceHash` | — |
| `character` / `lore` | 各自區 + `.md` | frontmatter | — | — |
| `draft` | `drafts/` 下 | 純文字 | — | **永不自動進上下文**（第 10 條） |

#### 對外 API

```ts
export interface Workspace {
  list(relDir?: string): Promise<WsEntry[]>;
  read(relPath: string, opts?: { offset?: number; limit?: number }): Promise<WsFile>;
  write(relPath: string, input: WriteInput, opts?: WriteOptions): Promise<WriteResult>;
  edit(relPath: string, edits: TextEdit[]): Promise<WriteResult>;
  move(from: string, to: string): Promise<WriteResult>;
  remove(relPath: string): Promise<WriteResult>;
  search(pattern: string, opts?: SearchOptions): Promise<SearchHit[]>;
}

export type WriteInput =
  | { text: string }                    // 原樣寫（種類 handler 仍負責渲染與記賬）
  | { artifact: Artifact };             // 結構化產物，由 handler 渲染成該種類的檔案格式

export interface WriteOptions {
  mode?: 'create' | 'overwrite' | 'append';   // 預設 create（同名報錯）
  /** 覆蓋前是否走 reviewReplace。預設 true，**agent 路徑不允許傳 false**。 */
  review?: boolean;
  /** 樂觀鎖基線。給了就比對，磁碟變過報衝突。 */
  baseHash?: string;
}
```

**守衛在 `guard.ts` 裡做一次**，六個方法全過：

1. `normalizeRel` —— 絕對路徑、`..` 逃逸、空路徑一律拒
2. 工程根包含檢查
3. `isProtectedPath` —— 固定目錄不可改名/刪除
4. `.trash/` 內容不可操作
5. 大小上限（讀、寫各一個）
6. 同名不覆蓋（`mode: 'create'` 時）
7. 覆蓋走 `reviewReplace`（有則 diff，無則確認框）
8. 刪除搬進 `.trash/` 並保留原相對路徑

### 收益（不只是給 agent 用）

- **記賬下沉**：誰寫都記 `upstreamHash` / `beatsHash`，內建編輯器改細綱不再斷鏈
- **`project.ts` 瘦身**：只剩領域查詢（`listPlots` / `nextPlotNo` / `getPlot` / `listChapters` …），讀寫全搬走
- **四條路共用一套保護**：檔案頁、內建編輯器、批次流水線、agent
- **`kindOfPath` 消掉四處重複的路徑判定**

---

## L2 · generation：拆成無狀態

### 現狀

`CreationSession` 一個類同時管四件事：當前有沒有在生成（`currentAbort`）、裝配上下文、解析產物、落盤（`acceptArtifact` 的六條分支）。

落盤搬進 L1 之後，剩下的應該是純函式。

### 目標態

```
core/generation/
  generate.ts    裝配 → 調模型 → 解析 → 產出 Draft（無狀態，收 signal）
  drafts.ts      Draft store：記憶體 + 隨會話持久化
```

```ts
export interface Draft {
  id: string;
  action: CreationAction;
  target: CreationTarget;
  /** 模型原樣輸出。使用者可能在氣泡裡改過，採納時以這份為準重新解析。 */
  raw: string;
  artifact?: Artifact;
  words: number;
  createdAt: string;
}

export async function generate(
  project: NovelProject,
  request: BuildRequest,
  handlers: GenerateHandlers,
  signal: AbortSignal
): Promise<Draft | undefined>;
```

併發控制（「已有一個生成任務在進行中」）上移到 controller 與 agent 迴圈——那是**排程**的責任，不是生成的責任。

Draft store 持久化的理由與現在 `ChatTurn.artifact` 存進會話是同一條：**重新整理網頁後採納按鈕還在**，不然剛生成的四個場景就只剩一段誰也用不上的 JSON。

### 一個字都不改的

`context/recipes.ts`、`context/prompts.ts`、`context/layers/`、`context/builder.ts`、`features/artifact.ts`。

分階段裝配那套東西是對的，agent 化不碰它。這是本次改造最值得強調的一點。

---

## L3 · agent

```
core/tools/                （當時在 core/agent/ 裡，後來獨立出來）
  types.ts       契約：ToolDef / ToolIntent / ToolInvoker
  schema.ts      引數 schema 的寫法與校驗
  registry.ts    登錄檔 → ToolSpec[]，外加執行與兜異常
  novel/         7 個工具，全是 L1/L2 的薄包裝
core/agent/
  loop.ts        對話迴圈（只認 ToolInvoker）
  policy.ts      哪些工具要確認（按工具自報的 gate 查表）
  budget.ts      步數 / 呼叫次數 / token 上限 + 無進展檢測
  context.ts     狀態注入 + 工具結果壓縮
```

### 工具集：7 個

| 工具 | 引數 | 返回 | 底座 |
| --- | --- | --- | --- |
| `list` | `path?` | 條目名、型別、字數/大小 | `Workspace.list` |
| `read` | `path`, `offset?`, `limit?` | 文字 + `truncated` | `Workspace.read` |
| `search` | `pattern`, `path?`, `glob?` | 命中行 + 路徑 + 前後文 | `Workspace.search` |
| `generate` | `target`(路徑), `capability`, `ask?`, `targetWords?` | `{draftId, kind, summary, words}` | `generation.generate` |
| `write` | `path`, `content?` \| `draftId?`, `mode?` | 寫入結果 | `Workspace.write` |
| `edit` | `path`, `old`, `new`, `all?` | 替換處數 | `Workspace.edit` |
| `run` | `action`, `args?` | 動作結果 | 既有 `ProjectAction` 分派 |

前三個 + `edit` 是標準四件套，任何支援工具呼叫的模型都見過。剩下三個：

**`generate`** —— 「agent 只做上層排程，實際生成通過工具呼叫 LLM」的落點。內部：`kindOfPath(target)` → `stage` → `recipeFor(stage, capability)` 裝配厚上下文 → 調模型 → `parseArtifact` → 存 Draft。`capability` 直接用現有那個 8 值列舉（`discuss` / `expand` / `critique` / `check` / `split` / `generate` / `settle` / `rewrite`），不新增概念。

**產出不回灌 agent 上下文**——只回 `{draftId, kind: 'plot', summary: '剧情 · 4/4 节', words: 620}`，正文照舊流進氣泡給作者看。要看內容讓它顯式 `read` 那份 draft。

**`write`** —— 接 `content` 或 `draftId` 二選一。給 `draftId` 時由 L1 的 handler 渲染成該路徑應有的格式、記上游指紋、跑覆蓋審閱。等價於使用者點「採納寫入」。

**`run`** —— 零模型呼叫或整包的工程動作，enum 就是現有的 `ProjectAction` 子集：`split` / `summarize` / `batchPlots` / `batchScenes` / `batchManuscripts` / `updateCard` / `createCard` / `extractStyle` / `generateLore` / `newPlot` / `newChapter`。這些揹著 agent 不該知道的不變數，必須是一個口子而不是讓它拿 `write` 自己拼。

### 沒有 `status` 工具

流水線狀態**每回合自動注入** agent 的 system 訊息，約 150 token，不花一次往返：

```
《青雲志》· 已釋出 99 章 · 31.2 萬字
當前目標：第 100 章（.novelforge/plots/100.md）
本章狀態：待寫劇情
下一步（狀態機）：寫劇情
提醒：全書大綱改過，第 12、13 章的細綱已過期（⟳）
```

這同時把第 20 條釘死了：agent 看到的「下一步」與介面主按鈕是同一個 `deriveNextStep` 的輸出，**不可能分叉**。

### 閘門

| 承諾 | 落法 |
| --- | --- |
| 第 4 條 不偷偷燒 token | `budget.ts` 硬上限：步數 / 模型呼叫次數 / 累計 token。每次 `generate` / `run(batch*)` 在介面上顯示這一步花了多少。批次動作照舊先報「預計呼叫 N 次」 |
| 第 3 / 19 條 不靜默覆蓋 | `write` 到已有內容一律走 `reviewReplace`，**任何策略模式下都不放開** |
| 第 11 條 不悶著幹活 | 每個工具呼叫在氣泡裡畫出來（名字、關鍵引數、耗時、結果摘要）；長回合走 `runTask`，工程頁能看進度、能停 |
| 第 12 條 換人只在檔內 | `generate` 打到正文層時嚴格用對話頁選定的那個模型，**不走池、不 fallback**——換人會讓文風斷掉 |
| 第 2 條 不靜默截斷 | 所有讀工具的返回值有硬上限，超了必須在返回值裡寫明截斷了多少；agent 上下文壓縮丟棄條目也要留痕 |

### 策略（`policy.ts`）

| 模式 | `list`/`read`/`search` | `generate` | `write`/`edit`/`run` |
| --- | --- | --- | --- |
| 謹慎 | 自動 | 每次確認 | 每次確認 |
| **預設** | 自動 | 預算內自動 | 確認 |
| 放手 | 自動 | 預算內自動 | 新建自動，**覆蓋仍確認** |

「覆蓋仍確認」在任何模式下都不放開——那是產品承諾，不是偏好設定。

### 無進展檢測

連續兩次呼叫**同工具 + 同引數**就停下來報告。模型卡在一個讀不到的路徑上反覆重試是最常見的燒錢方式。

---

## 分期

| 期 | 內容 | 交付物 | 新功能 |
| --- | --- | --- | --- |
| **零** | L0 事件流 provider（三家）+ `collectText` 適配 13 個呼叫點 | `npm test` 全綠 | 無 |
| **一** | L1 workspace 閘道器，六處寫盤收斂，記賬下沉 | `project.ts` 瘦身；內建編輯器改細綱不再斷鏈 | 無（有一處缺陷修復） |
| **二** | L2 拆無狀態 + Draft store | 重新整理網頁後採納按鈕仍在 | 無 |
| **三** | L3 骨架 + 只讀四件套（`list`/`read`/`search`/`generate`）+ 狀態注入 | agent 能查、能跨章對賬、能批評、能出草稿 | ★ 跨章一致性對賬 |
| **四** | `write`/`edit`/`run` + policy + budget + 工具流 UI | agent 能完整跑「排劇情 → 拆場景 → 寫正文」 | ★ 多步自主執行 |

**零到二期一個新功能都沒有，全是重構。** 但它們把「能不能安全地給 agent 一個 write」這個問題徹底解決掉了——三期的 agent 迴圈因此只有 300 行左右，四期加寫許可權不需要新的保護程式碼。

三期那四個只讀工具是純增量、零風險：跨章一致性對賬（「他前面說過沒去過北境嗎」）現在只能靠作者手動 `@`，`search` 一上來就解決了。

## 明確不做

- **不做 `bash` / 任意檔案系統訪問。** 工作區之外不存在。
- **不做多 agent / 子 agent。** 一本小說的創作沒有可並行的獨立子任務。
- **不讓 agent 決定「下一步」。** 那是 `deriveNextStep` 的活，agent 拿著它去執行。
- **不做自動化整本書。** 每一層的落盤仍然要人點。
- **不做工具呼叫的文字協議兜底。** 不支援 tool calling 的模型就不出現在 agent 模型選擇器裡。
- **不動 `recipes.ts` / `prompts.ts` / `layers/` / `artifact.ts`。** 分階段裝配是既有質量的來源。
