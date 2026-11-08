# 三期：agent 迴圈 + 只讀四件套 Implementation Plan

> **已合入，本文是當時的記錄。** 分層此後調過一次：工具與工具契約從
> `core/agent/{tools/,registry.ts}` 獨立成 [`core/tools/`](../../../src/core/tools/README.md)，
> 下面提到的這些路徑已經不存在。當下的真相以模組 README 為準。

> **接手須知：** 這份計劃面向新的 agent，假設你**沒有讀過**前面的對話。開工前必讀：
> 1. 根目錄 [AGENTS.md](../../../AGENTS.md) —— 尤其第 **2、4、11、12、19、20** 條
> 2. 設計依據 [docs/design/specs/2026-08-15-agent-architecture-design.md](../specs/2026-08-15-agent-architecture-design.md) 的 **L3 一節**
> 3. 前置：[零期](2026-08-15-agent-phase0-provider-events.md)、[一期](2026-08-15-agent-phase1-workspace.md)、[二期](2026-08-15-agent-phase2-generation.md) 必須已經合入
>
> 每個 Task 按 `- [ ]` 逐步執行，做完立刻 commit。

**Goal:** 讓 agent 跑起來——但**只給只讀工具與生成工具**。這一期結束時 agent 能查、能跨章對賬、能批評、能出草稿，**但一個字都寫不進磁碟**（落盤仍走現有的採納卡片）。

**Architecture:** 迴圈本身很短（約 300 行），因為工具體全是前三期成果的薄包裝。真正要小心的是三件事：**狀態注入**（讓 agent 與狀態機說同一套話）、**上下文壓縮**（agent 自己的歷史會漲）、**預算閘門**（第 4 條）。

**Tech Stack:** TypeScript（`src/core/agent/`）+ `node:test`。不新增依賴。

## Global Constraints

- **這一期 agent 不寫盤。** `write` / `edit` / `run` 三個工具**不註冊**，四期才加。
- **agent 不決定「下一步」**：每回合注入 `deriveNextStep` 的結論，agent 拿著它去執行（第 20 條）。
- **生成產物絕不回灌 agent 上下文**：`generate` 只回 `{draftId, kind, summary, words}`。
- **讀工具的返回值有硬上限，超了必須說明截斷了多少**（第 2 條）。
- **日誌不記 prompt / 正文全文，不出現 API Key**（第 11 條）。工具呼叫只記工具名與引數的**鍵名**，不記引數值——值裡可能有正文片段。
- **正文層的 `generate` 嚴格用對話頁選定的模型**，不走池不 fallback（第 12 條）。
- 每個 Task 結束立刻 commit；字首 `feat(agent)` / `test`；中文正文。

---

## 目標態檔案結構

```
src/core/agent/
├── loop.ts        對話迴圈
├── registry.ts    工具登錄檔 → ToolSpec[]
├── context.ts     ★ 狀態注入 + 工具結果壓縮
├── budget.ts      ★ 步數 / 呼叫次數 / token 上限 + 無進展檢測
├── tools/
│   ├── index.ts
│   ├── list.ts
│   ├── read.ts
│   ├── search.ts
│   └── generate.ts
└── README.md
```

## 提交節奏（6 個 commit）

| # | 字首 | 主題 |
|---|---|---|
| 1 | `feat` | 工具登錄檔與 JSON Schema |
| 2 | `feat` | 只讀三件套（list / read / search） |
| 3 | `feat` | `generate` 工具 |
| 4 | `feat` | 狀態注入與上下文壓縮 |
| 5 | `feat` | 預算閘門與無進展檢測 |
| 6 | `feat` | agent 迴圈 + 協議 + 前端工具流 |

---

### Task 1: 工具登錄檔與 JSON Schema

**Files:**
- Create: `src/core/agent/registry.ts`
- Create: `src/core/agent/tools/index.ts`
- Create: `tests/unit/agent/registry.test.js`

**Interfaces:**

```ts
export interface ToolContext {
  project: NovelProject;
  workspace: Workspace;
  drafts: DraftStore;
  signal: AbortSignal;
  /** 生成類工具用它記賬。 */
  budget: Budget;
  /** 工具想說點什麼給使用者看（進氣泡，不進 agent 上下文）。 */
  report(message: string): void;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;   // JSON Schema
  /** 會花錢。預算閘門與策略據此分類。 */
  costly?: boolean;
  /** 會寫盤。三期一個都沒有。 */
  mutating?: boolean;
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
}

export interface ToolResult {
  /** 回給模型看的文字。**必須簡短**——它會留在 agent 上下文裡。 */
  text: string;
  /** 給介面畫的結構化摘要，不進 agent 上下文。 */
  display?: { title: string; detail?: string };
  /** 出錯了。模型看得到，據此重試或換路。 */
  error?: string;
}

export function toolSpecs(defs: ToolDef[]): ToolSpec[];
```

**工具描述怎麼寫**（這是本 Task 真正的活）：

模型只靠 `description` 與 `parameters` 決定怎麼用。三條原則：

1. **說清座標系**：「path 是工程內相對路徑，正斜槓。細綱在 `.novelforge/plots/`，場景在 `.novelforge/scenes/<细纲名>/`，中轉站正文在 `.novelforge/manuscripts/`，已釋出章節在 `chapters/`。」
2. **說清限制**：「一次最多返回 400 行，超出會截斷並告訴你截了多少。」
3. **不寫領域知識**：不要在工具描述裡寫「劇情不寫畫面天氣臺詞」——那在 `prompts.ts` 裡，由 `generate` 內部那次呼叫自己帶著。工具描述裡寫一遍只會浪費 token 且兩處會跑偏。

**引數 schema 儘量扁平**：`{path, offset, limit}` 好過 `{target: {kind, chapterNo, sceneNo}}`。巢狀物件是模型最容易填錯的地方。

- [ ] **Step 1: 寫失敗測試**（`toolSpecs` 產出的 schema 合法、名字不重、必填欄位標對）
- [ ] **Step 2–5: 同上**

---

### Task 2: 只讀三件套

**Files:**
- Create: `src/core/agent/tools/{list,read,search}.ts`
- Create: `tests/integration/agent/readTools.test.js`

三個都是 `Workspace` 的薄包裝（一期已經實現），**每個不超過 50 行**。這一期的活是把返回值**壓成模型讀得動的形狀**。

#### `list`

```
引數：{ path?: string }
返回（文字）：
  .novelforge/plots/  （42 項）
  001-楔子.md          620 字
  002-入宗.md          710 字
  …
  （還有 32 項未列出，用 path 引數進子目錄看）
```

**上限 60 項**，超了說明還有多少。

#### `read`

```
引數：{ path: string, offset?: number, limit?: number }
返回（文字）：檔案內容，帶行號
  末尾若截斷：（第 401–1203 行未讀，共 1203 行。用 offset 繼續讀）
```

**上限 400 行 / 20000 字元**，取先到的。

#### `search`

```
引數：{ pattern: string, path?: string, kinds?: string[], regex?: boolean }
返回（文字）：
  chapters/009-北境.md:142  「我從沒去過北境。」他說。
  chapters/031-旧事.md:88   北境的雪他見過三回。
  （命中 2 處，掃了 99 個檔案）
  ⚠ 因超上限丟棄 0 條
```

按章號升序（一期的 `search.ts` 已經這麼排了）。**`dropped > 0` 必須寫在返回文字裡**——第 2 條。

- [ ] **Step 1: 寫失敗測試**

| 用例 | 斷言 |
|---|---|
| `list` 超 60 項 | 返回文字裡有「還有 N 項未列出」 |
| `read` 超行數上限 | 有「第 X–Y 行未讀」 |
| `read` 越界路徑 | `error` 欄位有值，**不拋** |
| `read` 不存在的檔案 | `error` 欄位說清楚，模型能據此換路 |
| `search` 有丟棄 | 返回文字裡有 ⚠ |
| `search` 跨章命中 | 按章號升序 |
| 三個工具都不寫盤 | 跑完磁碟 mtime 不變 |

- [ ] **Step 2–5: 同上**

---

### Task 3: `generate` 工具

**Files:**
- Create: `src/core/agent/tools/generate.ts`
- Create: `tests/integration/agent/generateTool.test.js`

**這是「agent 只做上層排程，生成走工具」的落點。**

```
引數：{
  target: string,        // 路徑。決定層與目標
  capability: string,    // discuss|expand|critique|check|split|generate|settle|rewrite
  ask?: string,          // 補充要求，可空
  targetWords?: number
}
返回（文字）：
  已生成：劇情 · 4/4 節，620 字
  draftId: d-3f2a
  落點：.novelforge/plots/012-入宗.md（已有內容，採納時會先請作者審閱）
```

**內部流程**（全是二期成果的呼叫）：

```ts
const { stage, target: t } = kindOfPath(project, args.target);
const action = { stage, capability };
if (!isValidAction(action)) return { error: `${stage} 層不支援 ${capability}` };
const { draft } = await generate(project, { action, target: t, ask, targetWords, history: [] }, handlers, { signal, provider });
ctx.drafts.put(draft);
return { text: `已生成：${draft.summary}…`, display: {…} };
```

**五條必須做對的事：**

1. **產物不回灌**。返回文字裡只有形狀與 draftId，**沒有正文**。三千字正文塞回迴圈，agent 每走一步重燒一遍。
2. **正文層用對話頁選定的模型**，不傳 `provider`（走預設）。非正文層可以走分檔池（`plotOutline` / `sceneBreakdown`）——但**這一期先全部走預設**，四期再接池。
3. **`history` 傳空陣列**。agent 的對話歷史與創作會話的歷史是兩回事，混進去會讓裝配器把 agent 的工具呼叫當成作者的討論。**唯一的例外是 `settle`**——它要沉澱的就是一段討論；這一期**不支援 `settle`**，返回 `error` 說明「落定劇情請在對話頁手動執行」。
4. **流式內容照舊推給前端**（`onDelta` → `delta` 訊息），作者看得見 agent 在寫什麼。
5. **`costly: true`**，每次呼叫記進 budget。

- [ ] **Step 1: 寫失敗測試**

| 用例 | 斷言 |
|---|---|
| 對 `plots/012.md` 調 `generate` | draft 落進 store，返回文字裡**沒有正文** |
| 對 `chapters/012.md` 調 `capability: 'split'` | `error`（manuscript 層不支援 split，`STAGE_CAPABILITIES` 說了算） |
| `capability: 'settle'` | `error`，說明去對話頁手動執行 |
| 認不出的路徑 | `error`，不拋 |
| 呼叫一次 | `budget.calls` +1 |
| 正文層 | 用的是 `config.active` 那個模型 |

- [ ] **Step 2–5: 同上**

---

### Task 4: 狀態注入與上下文壓縮

**Files:**
- Create: `src/core/agent/context.ts`
- Create: `tests/unit/agent/context.test.js`

#### 狀態注入

每回合把這段拼進 system 訊息（約 150 token）：

```
# 當前工程
《青雲志》· 已釋出 99 章 · 31.2 萬字
當前目標：第 100 章（.novelforge/plots/100.md）
本章狀態：待寫劇情
下一步（由狀態機算出，不要另做判斷）：寫劇情
提醒：全書大綱改過，第 12、13 章的細綱已過期（⟳）
```

**資料全從既有的只讀聚合取**：`buildPlotPipelineView` / `deriveNextStep` / `deriveBookStage`（`views/pipeline.ts` + `model/pipeline.ts`）。**不要重新實現任何判據**——兩處各判各的，介面上就會出現「徽章說待拆場景，agent 讓你寫正文」（第 20 條）。

「⟳ 提醒」**最多列 5 章**，超了寫「等 N 章」。

#### 上下文壓縮

agent 的訊息歷史會漲（工具結果累積）。策略：

1. **system 與最後 K 輪永不壓縮**（K 預設 6）。
2. 更早的 `tool` 訊息**只留第一行 + 一句「（結果已省略，需要可重新呼叫）」**。
3. 壓縮發生時**記一條 warn 日誌**說明省了幾條（第 2 條：不靜默截斷）。
4. 超過 token 上限仍然壓不下去時**停止迴圈並報告**，不要靜默丟使用者的原始要求。

```ts
export function buildAgentMessages(
  system: string,
  turns: AgentTurn[],
  budgetTokens: number
): { messages: AgentMessage[]; droppedCount: number };
```

- [ ] **Step 1: 寫失敗測試**

| 用例 | 斷言 |
|---|---|
| 狀態注入含 `deriveNextStep` 的 label | 與 `deriveNextStep` 直接呼叫的結果一字不差 |
| 老工程（99 章無細綱） | 狀態說「已釋出 99 章」，不說「待寫劇情」 |
| ⟳ 超 5 章 | 寫「等 N 章」 |
| 壓縮觸發 | 最後 6 輪完整，更早的 tool 結果只剩第一行 |
| 壓縮觸發 | 打了一條 warn |
| 壓不下去 | 返回訊號讓迴圈停下 |

- [ ] **Step 2–5: 同上**

---

### Task 5: 預算閘門與無進展檢測

**Files:**
- Create: `src/core/agent/budget.ts`
- Create: `tests/unit/agent/budget.test.js`

```ts
export interface BudgetLimits {
  /** 最多幾個回合（一個回合 = 一次模型呼叫 + 若干工具）。預設 20。 */
  steps: number;
  /** 最多幾次**花錢的**工具呼叫（generate）。預設 10。 */
  calls: number;
  /** 累計輸入+輸出 token 上限。預設 200_000。 */
  tokens: number;
}

export interface Budget {
  readonly limits: BudgetLimits;
  steps: number; calls: number; tokens: number;
  /** 觸頂了。迴圈據此停下並報告。 */
  exceeded(): { what: 'steps' | 'calls' | 'tokens'; message: string } | undefined;
  /** 記一次工具呼叫，同時做無進展檢測。 */
  recordTool(name: string, args: Record<string, unknown>): { stalled: boolean };
}
```

**無進展檢測**：連續兩次**同工具 + 同引數**（`JSON.stringify(args)` 相等）就 `stalled: true`。迴圈收到之後給模型一條 tool 結果說「你剛才用同樣的引數調過這個工具，結果一樣。換個思路或者結束。」，再來一次就直接停。

**這是最常見的燒錢方式**：模型卡在一個讀不到的路徑上反覆重試。

**預算觸頂時的行為**：**不靜默停**。給模型最後一次機會用 `finish` 說明「做到哪了、還差什麼」，再結束。

**使用者可見**：每次 `generate` 之後在氣泡裡顯示「已用 3/10 次生成，約 4.2 萬 token」（第 4 條）。

- [ ] **Step 1: 寫失敗測試**（三條上限各一、無進展檢測兩連與三連、觸頂後仍允許一次 finish）
- [ ] **Step 2–5: 同上**

---

### Task 6: agent 迴圈 + 協議 + 前端工具流

**Files:**
- Create: `src/core/agent/loop.ts`
- Create: `src/core/agent/README.md`
- Modify: `src/core/protocol/{in,out}.ts`
- Modify: `src/core/controller/chat.ts`
- Modify: `src/core/model/session.ts`（`ChatTurn` 加工具呼叫記錄）
- Modify: `media/src/view/messages.ts`（畫工具呼叫流）
- Modify: `src/shells/shared/panes.ts`（如果需要新按鈕）
- Create: `tests/integration/agent/loop.test.js`
- Create: `tests/dom/view/agentTurn.test.js`

#### 迴圈

```ts
export async function runAgent(opts: {
  project: NovelProject;
  workspace: Workspace;
  drafts: DraftStore;
  provider: LlmProvider;      // 必須支援工具呼叫
  ask: string;
  limits: BudgetLimits;
  signal: AbortSignal;
  on: AgentHandlers;
}): Promise<AgentOutcome>;
```

一個回合：

```
1. buildAgentMessages(system + 狀態注入, turns, budgetTokens)
2. provider.stream(messages, { tools: toolSpecs(READ_ONLY_TOOLS) })
3. 收流：text → onDelta 推氣泡；toolCall → 收集
4. 沒有 toolCall → 結束（模型給出了最終回答）
5. 有 toolCall → 逐個執行（budget.recordTool → tool.run），
   結果作為 role:'tool' 訊息追加，回到 1
6. budget.exceeded() → 最後一輪 toolChoice:'none' 讓它總結，然後停
```

**取消要停在工具邊界**：`signal.aborted` 時不再發起下一次模型呼叫，也不再執行下一個工具；**正在跑的 `generate` 靠它自己的 signal 停**。

**整個回合走 `runTask`**（第 11 條）：工程頁頂部有進度條、能看見、能停。

#### 協議

```ts
// out.ts
| { type: 'agentStep'; turnId: string; step: number; message: string }
| { type: 'toolCall'; turnId: string; callId: string; name: string; display?: {title, detail} }
| { type: 'toolResult'; turnId: string; callId: string; ok: boolean; summary: string; elapsedMs: number }
| { type: 'agentDone'; turnId: string; outcome: AgentOutcome }

// in.ts
| { type: 'sendAgent'; text: string; limits?: Partial<BudgetLimits> }
```

#### 會話記錄

`ChatTurn` 加：

```ts
/** 僅 assistant 輪：這一輪 agent 調了哪些工具。重開面板要能回放。 */
toolCalls?: { callId: string; name: string; title: string; ok: boolean; summary: string; elapsedMs: number }[];
```

**不存工具的完整返回值**——那可能是幾萬字。只存展示摘要。

#### 前端

對話頁加一個入口（**建議：輸入框旁一個「Agent」開關**，而不是新頁籤——它跟創作是同一件事，只是執行方式不同）。工具呼叫畫成氣泡裡的一串摺疊條：

```
🔧 search「北境」          2 處命中   0.3s
🔧 read chapters/009…     142 行     0.1s
✨ generate 劇情           620 字     12.4s   [採納寫入]
```

**「採納寫入」按鈕**仍然是現有那個（吃 draftId），三期不變。

- [ ] **Step 1: 寫失敗測試** `tests/integration/agent/loop.test.js`

用假 provider（指令碼化的事件序列）。至少覆蓋：

| 用例 | 斷言 |
|---|---|
| 模型直接回答不調工具 | 一個回合結束 |
| 模型調 `read` 再回答 | 兩個回合，tool 訊息形狀正確 |
| 模型連續兩次同工具同引數 | 收到 stalled 提示 |
| 三次 | 迴圈停下 |
| 預算觸頂 | 最後一輪 `toolChoice: 'none'`，有總結 |
| 取消 | 停在工具邊界，已產出的 draft 保留 |
| 工具拋異常 | 變成 `error` 回給模型，迴圈繼續 |
| 全程 | 日誌裡沒有 prompt 全文、沒有引數值 |

- [ ] **Step 2: 跑測試確認失敗**
- [ ] **Step 3: 實現**
- [ ] **Step 4: dom 測試**（工具呼叫流渲染）
- [ ] **Step 5: `npm test` + F5 手動驗證**

手動驗證指令碼（用一個真模型）：
1. 「第 9 章裡主角說過他沒去過北境嗎？」→ 應該看到 `search` + `read`，然後給出答案
2. 「第 12 章的劇情有什麼問題？」→ 應該 `read` 細綱後 `generate(capability:'critique')`
3. 「把第 12 章的劇情排一下」→ 應該 `generate(capability:'generate')` 並給出採納按鈕

- [ ] **Step 6: 寫 `src/core/agent/README.md`** + 更新 `src/core/README.md`、`AGENTS.md` 的模組地圖
- [ ] **Step 7: Commit**

---

## 本期不做

- **不給寫工具**（`write` / `edit` / `run`）。四期。
- **不做策略模式**（謹慎/預設/放手）。四期——這一期沒有寫盤，沒有可確認的東西。
- **不做 `supportsTools` 的設定頁 UI**。可以先在 `ModelEntry` 上加欄位並手改配置檔案；UI 四期一起做。
- **不接分檔池**。`generate` 全走對話頁選定的模型。

## 給接手 agent 的提示詞

> 你在 novelwarden 倉庫裡執行「三期：agent 迴圈 + 只讀四件套」。前置是零、一、二期，確認都已合入（`src/core/workspace/` 與 `src/core/generation/` 都在，`npm test` 綠）。
>
> 先讀 `AGENTS.md` 的第 2、4、11、12、19、20 條與 `docs/design/specs/2026-08-15-agent-architecture-design.md` 的 L3 一節。然後讀 `src/core/model/pipeline.ts`（狀態機，你要注入它的結論而不是重新判斷）、`src/core/workspace/index.ts`、`src/core/generation/generate.ts`。
>
> 這一期 agent **一個字都不寫磁碟**——只註冊 `list` / `read` / `search` / `generate` 四個工具，落盤仍走現有的採納卡片。這是有意的：寫許可權等四期，那時前三期的保護已經全部就位。
>
> 按 `docs/design/plans/2026-08-15-agent-phase3-loop.md` 的 6 個 Task 逐個做，每個 Task 做完立刻 commit（字首 `feat(agent)`，中文正文，**不要加 Co-Authored-By 或 Generated with 標記**）。
>
> 六件最容易做錯的事：
> 1. **不要讓 agent 自己判斷「下一步」**。每回合注入 `deriveNextStep` 的結論，它拿著去執行。兩處各判各的，介面上就會出現「徽章說待拆場景，agent 讓你寫正文」。
> 2. **生成產物絕不回灌 agent 上下文**。`generate` 只回 draftId 與形狀摘要，正文流給前端氣泡。三千字正文塞回迴圈，每走一步重燒一遍。
> 3. **工具描述裡不寫領域知識**。「劇情不寫畫面天氣臺詞」在 `context/prompts.ts` 裡，由 `generate` 內部那次呼叫自己帶著。工具描述裡寫一遍會讓兩處慢慢跑偏。
> 4. **日誌不記引數值**——值裡可能有正文片段。只記工具名與引數的鍵名。
> 5. **`generate` 的 `history` 傳空陣列**。agent 的工具呼叫不是作者的討論，混進裝配器會把它當成創作要求。
> 6. **無進展檢測**：連續兩次同工具同引數就提示，三次就停。這是最常見的燒錢方式。
>
> 引數 schema 儘量扁平（`{path, offset, limit}` 好過巢狀物件）——巢狀是模型最容易填錯的地方。
