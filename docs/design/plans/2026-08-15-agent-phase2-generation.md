# 二期：generation 無狀態化 + Draft store Implementation Plan

> **接手須知：** 這份計劃面向新的 agent，假設你**沒有讀過**前面的對話。開工前必讀：
> 1. 根目錄 [AGENTS.md](../../../AGENTS.md) —— 尤其第 **19、20、22** 條
> 2. 設計依據 [docs/design/specs/2026-08-15-agent-architecture-design.md](../specs/2026-08-15-agent-architecture-design.md) 的 **L2 一節**
> 3. [src/core/features/README.md](../../../src/core/features/README.md) 的「創作的四層與兩條路」
> 4. 前置：[零期](2026-08-15-agent-phase0-provider-events.md)、[一期](2026-08-15-agent-phase1-workspace.md) 必須已經合入
>
> 每個 Task 按 `- [ ]` 逐步執行，做完立刻 commit。

**Goal:** 把 `CreationSession` 這個「同時管四件事」的類拆成**無狀態的生成函式** + **Draft store**。併發控制上移到呼叫方——那是排程的責任，不是生成的責任。

**Architecture:** `CreationSession` 現在管著：① 有沒有在生成（`currentAbort`）② 裝配上下文 ③ 解析產物 ④ 落盤（六條分支）。一期已經把 ④ 搬進 workspace 了。這一期把 ① 上移、②③ 變成純函式，產出一個可持久化的 `Draft`。

**Tech Stack:** TypeScript（`src/core/generation/`）+ `node:test` + `npm run typecheck`。不新增依賴。

## Global Constraints

- **行為不變**。`npm test` 全綠是驗收標準。
- **一處有意的行為變化**：重新整理網頁後，未採納的產物仍然可以採納（現在只有 `ChatTurn.artifact` 那份摘要活著，原文靠氣泡裡的文字重新解析——draft 落盤之後這條路更穩）。
- **不動** `context/recipes.ts`、`context/prompts.ts`、`context/layers/`、`context/builder.ts`、`features/artifact.ts`。這是設計文件裡最強調的一條：分階段裝配是既有質量的來源。
- 「已有一個生成任務在進行中」這句 toast 與它的行為**必須保留**，只是搬個地方。
- 每個 Task 結束立刻 commit；字首 `refactor` / `feat`；中文正文。

---

## 目標態檔案結構

```
src/core/generation/
├── generate.ts     ★ 無狀態：裝配 → 調模型 → 解析 → Draft
├── drafts.ts       ★ Draft store：記憶體 + 隨會話持久化
└── README.md

src/core/features/
└── creation.ts     ★ 瘦身：只剩 testConnection 與 cleanOutput/suggestTitle 等工具函式
                       （CreationSession 類整個消失）
```

`CreationSession` 的四個職責去向：

| 職責 | 現在 | 去向 |
|---|---|---|
| `currentAbort` 併發控制 | `CreationSession` 私有欄位 | `ChatController`（對話頁）與 `agent/loop.ts`（三期） |
| 裝配 + 調模型 | `generate()` | `generation/generate.ts`（無狀態函式，收 signal） |
| 解析 | `parse()` | 並進 `generate()`——產出的 `Draft` 自帶 `artifact` |
| 落盤 | `acceptArtifact()` 六條分支 | **一期已搬進 workspace** |
| `preview()` | `CreationSession` | `generation/generate.ts` 匯出 `previewContext()` |
| `testConnection()` | `CreationSession` | 留在 `features/creation.ts`（它跟創作沒關係，是設定頁的活） |

## 提交節奏（4 個 commit）

| # | 字首 | 主題 |
|---|---|---|
| 1 | `refactor` | 抽出 `generation/generate.ts`（無狀態） |
| 2 | `feat` | `generation/drafts.ts` Draft store |
| 3 | `refactor` | controller 接管併發控制，`CreationSession` 消失 |
| 4 | `refactor` | 採納路徑改吃 draftId |

---

### Task 1: 抽出 `generation/generate.ts`

**Files:**
- Create: `src/core/generation/generate.ts`
- Modify: `src/core/features/creation.ts`（`CreationSession.generate` / `preview` / `parse` 的實現搬走，類暫時保留並轉發）
- Create: `tests/integration/generation/generate.test.js`

**Interfaces:**

```ts
export interface Draft {
  id: string;
  action: CreationAction;
  target: CreationTarget;
  /** 模型原樣輸出（正文層已過 cleanOutput）。 */
  raw: string;
  /** 解析出的結構化產物。text 類能力（discuss/critique/…）沒有。 */
  artifact?: Artifact;
  /** 一句話形狀描述，如「劇情 · 4/4 節」。 */
  summary?: string;
  words: number;
  /** 推理模型的思考過程。不是正文，採納時不取。 */
  reasoning?: string;
  createdAt: string;
}

export interface GenerateHandlers {
  onDelta(delta: string, full: string): void;
  onReasoning?(delta: string, full: string): void;
  onDone(full: string): void;
  onError(message: string): void;
  onCancelled(): void;
}

export interface GenerateOptions {
  signal: AbortSignal;
  /**
   * 用哪個模型。預設用對話頁選定的那個（config.active）。
   *
   * **正文層永遠不許傳別的**（AGENTS.md 第 12 條：中途換人會讓文風斷掉）。
   * 這個引數留給三期的 agent 讓非正文層走分檔池。
   */
  provider?: LlmProvider;
}

/** 裝配 + 調模型 + 解析。**一個字都不寫磁碟。** */
export async function generate(
  project: NovelProject,
  request: Omit<BuildRequest, 'providerMaxInputTokens'>,
  handlers: GenerateHandlers,
  options: GenerateOptions
): Promise<{ draft?: Draft; built?: BuiltContext }>;

/** 只裝配不調模型——面板的「預覽上下文」。 */
export async function previewContext(
  project: NovelProject,
  request: Omit<BuildRequest, 'providerMaxInputTokens'>
): Promise<BuiltContext>;
```

**逐字保留的四件事**（它們現在在 `features/creation.ts` 裡，搬過去時不要改）：

1. `logAssembly` 的日誌格式（token 數、降級/丟棄明細）——**絕不記 prompt 全文**
2. `cleanOutput` 只對正文層做（JSON 產物在這裡剝會切壞結構）
3. `recordUsage` / `describeUsage` 的呼叫位置（實測用量校準 tokenCounter）
4. 失敗時 `recordFailure` 掛在細綱上、成功時 `clearFailures`（第 16 條）

**一處結構變化**：`parse()` 從獨立方法並進 `generate()`。現在的流程是「生成 → 前端拿到文字 → 後端再 parse 一次畫卡片 → 採納時第三次 parse」，其中第二次是多餘的。`Draft` 生成時就帶上 `artifact` 與 `summary`。

**採納時仍然重新解析**——使用者可能在氣泡裡改過文字（這條註釋在 `chat.ts:192` 裡，保留）。

- [ ] **Step 1: 寫失敗測試** `tests/integration/generation/generate.test.js`

用假 provider（`tests/helpers/` 裡有）。至少覆蓋：

| 用例 | 斷言 |
|---|---|
| 劇情層 generate | `draft.artifact.kind === 'plot'`，`summary` 形如 `剧情 · N/4 节` |
| 正文層 generate | `raw` 過了 `cleanOutput`（開場白與章節標題被剝掉） |
| 討論類能力 | `draft.artifact` 是 undefined（沒有可採納的東西） |
| 模型拋錯 | `onError` 被呼叫，`errorLog` 裡掛上一條 |
| 成功 | `clearFailures` 被呼叫 |
| 取消 | `onCancelled` 被呼叫，不記失敗 |
| 裝配明細 | `built.items` 裡有降級/丟棄項時進 warn 日誌 |

- [ ] **Step 2: 跑測試確認失敗**
- [ ] **Step 3: 實現**，`CreationSession.generate` 改成轉發
- [ ] **Step 4: 跑測試 + `npm test`**
- [ ] **Step 5: Commit**

---

### Task 2: `generation/drafts.ts`

**Files:**
- Create: `src/core/generation/drafts.ts`
- Modify: `src/core/model/session.ts`（`ChatTurn.artifact` 換成 `draftId` + 展示欄位）
- Create: `tests/unit/generation/drafts.test.js`

**Interfaces:**

```ts
export interface DraftStore {
  put(draft: Draft): void;
  get(id: string): Draft | undefined;
  /** 會話切換/關閉時清掉該會話的草稿。 */
  dropBySession(sessionId: string): void;
}
```

**存哪裡**：記憶體為主（`Map`），**隨會話 JSON 一起落盤**（`.novelforge/sessions/<id>.json`）。理由與現在 `ChatTurn.artifact` 存進會話是同一條：重新整理網頁後採納按鈕還在，不然剛生成的四個場景就只剩一段誰也用不上的 JSON。

**不進 SQLite**（第 17 條：庫只放可丟棄的痕跡，內容的唯一真相是 Markdown。draft 是未落盤的內容，但它跟著會話走，會話本來就是 JSON）。

`ChatTurn` 的變化：

```ts
// 現在
artifact?: { where: string; summary: string; overwrites: boolean };
// 改成
draftId?: string;
/** 展示用，與 draft 一起持久化，重開面板不必重新解析。 */
artifact?: { where: string; summary: string; overwrites: boolean };
```

兩個欄位都留：`draftId` 是身份，`artifact` 是**展示快照**。這樣即使 draft 被清掉（會話很老了），氣泡上仍然看得出「這一輪產出過一份 4 場的場景清單」，只是採納按鈕收起來。

**容錯**：`normalize()` 讀到認不出的 `draftId` 一律丟棄（會話檔案可能被手改）。

- [ ] **Step 1: 寫失敗測試**（`put` / `get` / `dropBySession` / 會話往返序列化 / 壞 draftId 不拋）
- [ ] **Step 2–4: 同上**
- [ ] **Step 5: Commit**

---

### Task 3: controller 接管併發控制，`CreationSession` 消失

**Files:**
- Modify: `src/core/controller/index.ts`（`session: CreationSession` 換成 `drafts: DraftStore` + `currentAbort`）
- Modify: `src/core/controller/chat.ts`（`c.session.generate(...)` 改成 `generate(c.project, ..., {signal})`）
- Delete: `src/core/features/creation.ts` 裡的 `CreationSession` 類
- Modify: `src/core/features/creation.ts`（只留 `testConnection` / `cleanOutput` / `suggestTitle`）

**併發控制搬到 controller**：

```ts
// ChatController
private currentAbort?: AbortController;
get isGenerating(): boolean { return this.currentAbort !== undefined; }
stopGeneration(): void { this.currentAbort?.abort(new CancelledError()); }
```

`c.busy` 與 `currentAbort` 現在是兩個獨立狀態（前者給前端畫忙碌標記，後者控真正的取消），**合成一個**：`busy` 就是 `currentAbort !== undefined`。

**「已有一個生成任務在進行中」這句 toast 保留**，判據從 `session.isGenerating` 改成 `this.isGenerating`。

- [ ] **Step 1: 改 controller**
- [ ] **Step 2: 刪 `CreationSession`**
- [ ] **Step 3: `npm test` + `npm run typecheck`**
- [ ] **Step 4: 更新 `src/core/features/README.md` 與 `src/core/README.md`**（`creation.ts` 那一行改成新的職責；加 `generation/` 一行）
- [ ] **Step 5: Commit**

---

### Task 4: 採納路徑改吃 draftId

**Files:**
- Modify: `src/core/protocol/in.ts`（`acceptArtifact` 訊息加 `draftId`）
- Modify: `src/core/controller/chat.ts`（`acceptArtifact`）
- Modify: `media/src/view/messages.ts`（採納按鈕帶上 draftId）
- Modify: `tests/dom/view/*`（如有斷言採納按鈕的）

```ts
// 現在
| { type: 'acceptArtifact'; turnId: string; target: CreationTarget; text: string }
// 改成
| { type: 'acceptArtifact'; turnId: string; draftId: string; text: string }
```

`target` 從 draft 裡取，不再由前端傳——**前端猜不出一段討論該寫到哪一層**（第 19 條最後一句）。

採納流程：

```
draftId → draft.target → pathOfTarget(target) → ws.write(path, {artifact: parseArtifact(action, text)})
```

**`text` 引數保留**：使用者可能在氣泡裡改過，採納時以氣泡裡當下那份為準重新解析。`draft.raw` 只是兜底。

- [ ] **Step 1–5: 同上**。驗收是既有的採納整合測試與 dom 測試全綠。

---

## 本期不做

- **不接 agent**。
- **不改裝配器與提示詞**。
- **不改 draft 的介面呈現**（採納卡片長什麼樣不變）。

## 給接手 agent 的提示詞

> 你在 novelwarden 倉庫裡執行「二期：generation 無狀態化 + Draft store」。前置是零期與一期，確認都已合入（`src/core/workspace/` 存在且 `npm test` 綠）。
>
> 先讀 `AGENTS.md` 的第 19、20、22 條、`src/core/features/README.md` 的「創作的四層與兩條路」、以及 `docs/design/specs/2026-08-15-agent-architecture-design.md` 的 L2 一節。然後讀 `src/core/features/creation.ts` 與 `src/core/controller/chat.ts`。
>
> 這一期是純重構，`npm test` 全綠是驗收標準。**絕對不要改** `context/recipes.ts`、`context/prompts.ts`、`context/layers/`、`context/builder.ts`、`features/artifact.ts`——分階段裝配是這個專案既有質量的來源，agent 化不碰它。
>
> 按 `docs/design/plans/2026-08-15-agent-phase2-generation.md` 的 4 個 Task 逐個做，每個 Task 做完立刻 commit（中文正文，**不要加 Co-Authored-By 或 Generated with 標記**）。
>
> 三件最容易做錯的事：
> 1. **`cleanOutput` 只對正文層做**。在 JSON 產物上跑那幾條正則會切壞結構。
> 2. **採納時要重新解析氣泡裡當下的文字**，不能直接用 `draft.artifact`——使用者可能改過。
> 3. **`target` 從 draft 裡取，不由前端傳**。前端猜不出一段討論該寫到哪一層。
