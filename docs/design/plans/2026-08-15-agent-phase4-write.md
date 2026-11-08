# 四期：寫工具 + 策略 + 工具流 UI Implementation Plan

> **已合入，本文是當時的記錄。** 分層此後調過一次：工具與工具契約從
> `core/agent/{tools/,registry.ts}` 獨立成 [`core/tools/`](../../../src/core/tools/README.md)，
> 下面提到的這些路徑已經不存在。當下的真相以模組 README 為準。

> **接手須知：** 這份計劃面向新的 agent，假設你**沒有讀過**前面的對話。開工前必讀：
> 1. 根目錄 [AGENTS.md](../../../AGENTS.md) —— **全部 23 條**。這一期給 agent 開寫許可權，每一條都在射程內
> 2. 設計依據 [docs/design/specs/2026-08-15-agent-architecture-design.md](../specs/2026-08-15-agent-architecture-design.md) 的 **L3 一節**
> 3. 前置：[零](2026-08-15-agent-phase0-provider-events.md)、[一](2026-08-15-agent-phase1-workspace.md)、[二](2026-08-15-agent-phase2-generation.md)、[三期](2026-08-15-agent-phase3-loop.md) 必須已經合入
>
> 每個 Task 按 `- [ ]` 逐步執行，做完立刻 commit。

**Goal:** 給 agent 加上 `write` / `edit` / `run` 三個工具，配上策略與確認閘門，讓它能完整跑一條「排劇情 → 拆場景 → 寫正文」。

**Architecture:** 這一期**不需要寫任何新的保護程式碼**——一期的 `guard.ts` 八條守衛已經全在寫入路徑上了。要做的是把它們**接到 agent 的確認流程上**：哪些動作自動、哪些要問、問的時候說什麼。

**Tech Stack:** TypeScript（`src/core/agent/`）+ `node:test` + `npm run typecheck`。不新增依賴。

## Global Constraints

- **覆蓋已有內容一律走 `reviewReplace`，任何策略模式下都不放開**（第 3、19 條）。這是產品承諾，不是偏好設定。
- **批次動作動手前必須報「預計呼叫 N 次」**（第 4 條）。併發不改變總次數，這個數在併發下也要對得上賬。
- **刪除一律進 `.trash/`**（第 6 條）。agent 的 `run` 裡**不給刪除動作**——見下。
- **失敗要留在出錯的東西身上**（第 16 條）：agent 寫盤失敗要 `recordFailure`，成功要 `clearFailures`。
- **不給 `bash`、不給工程根外的路徑、不給裸 `fs`**。
- 每個 Task 結束立刻 commit；字首 `feat(agent)`；中文正文。

---

## 提交節奏（6 個 commit）

| # | 字首 | 主題 |
|---|---|---|
| 1 | `feat` | `write` 工具（吃 draftId 與 content） |
| 2 | `feat` | `edit` 工具 |
| 3 | `feat` | `run` 工具（工程動作） |
| 4 | `feat` | 策略與確認閘門 |
| 5 | `feat` | 分檔池接入與 `supportsTools` 設定頁 |
| 6 | `feat` | 工具流 UI 完善與端到端驗證 |

---

### Task 1: `write` 工具

**Files:**
- Create: `src/core/agent/tools/write.ts`
- Modify: `src/core/agent/tools/index.ts`
- Create: `tests/integration/agent/writeTool.test.js`

```
引數：{
  path: string,
  draftId?: string,      // 與 content 二選一
  content?: string,
  mode?: 'create' | 'overwrite' | 'append'
}
返回：
  已寫入 .novelforge/plots/012-入宗.md（620 字）
  同時記下 upstreamHash（大綱指紋）
```

**實現就是一次 `ws.write`**（一期已經把渲染、記賬、伴生、審閱全做完了）：

```ts
const input = args.draftId
  ? { artifact: requireDraft(args.draftId).artifact }
  : { text: args.content };
const r = await ctx.workspace.write(args.path, input, {
  mode: args.mode ?? 'create',
  review: true,              // ★ 永遠 true，不接受引數
  what: describeForReview(kindOfPath(project, args.path)),
});
```

**五條硬約束：**

1. **`review` 永遠 `true`**，不作為工具引數暴露。模型不該有能力關掉審閱。
2. **`draftId` 找不到時 `error`，不靜默降級成寫空檔案。**
3. **`draftId` 的 draft 沒有 `artifact`（討論類產出）時 `error`**——一段批評意見不該被寫成一份細綱。
4. **使用者在審閱裡拒絕 → `{skipped}`，回給模型的文字要說清「作者沒有採納」**，讓它別原地重試。
5. **寫失敗 `recordFailure` 掛在對應細綱上，成功 `clearFailures`**（第 16 條）。

`mutating: true`。

- [ ] **Step 1: 寫失敗測試**

| 用例 | 斷言 |
|---|---|
| `write` + draftId 到空路徑 | 落盤，`upstreamHash` 記上 |
| `write` + draftId 到已有內容 + 假 Host 同意 | 覆蓋 |
| `write` + 假 Host 拒絕 | 磁碟一字未改，返回文字說「作者沒有採納」 |
| `write` + 不存在的 draftId | `error`，不寫 |
| `write` + 討論類 draft | `error`，不寫 |
| `write` 到受保護路徑 | `error`（guard 攔下） |
| `write` 到 `../` | `error` |
| 寫失敗 | errorLog 裡掛上一條 |

- [ ] **Step 2–5: 同上**

---

### Task 2: `edit` 工具

**Files:**
- Create: `src/core/agent/tools/edit.ts`
- Create: `tests/integration/agent/editTool.test.js`

```
引數：{ path: string, old: string, new: string, all?: boolean }
返回：已替換 1 處（.novelforge/plots/012-入宗.md）
```

**為什麼需要它**：改一個人名、修一句臺詞、調一個數字——用 `generate` 重寫整份產物是浪費，用 `write` 全文覆蓋則要求模型把整份內容重新吐一遍（既慢又容易漏）。

**四條硬約束：**

1. **`old` 不唯一且 `all !== true` 時報錯，不改**（與標準 edit 工具一致）。錯誤文字要說清命中了幾處。
2. **`old` 找不到時報錯**，並提示「先 `read` 確認當前內容」。
3. **仍然走 `ws.edit` → guard**：越界、保護路徑、大小上限照樣攔。
4. **編輯產物類檔案後照樣記賬**——`ws.edit` 內部走 handler 的 `after`，一期已經保證了。

**不做多處批次編輯**（`edits: [{old,new}]` 陣列）。一次一處，出錯時狀態清楚。

- [ ] **Step 1: 寫失敗測試**（唯一/不唯一/找不到/越界/記賬）
- [ ] **Step 2–5: 同上**

---

### Task 3: `run` 工具

**Files:**
- Create: `src/core/agent/tools/run.ts`
- Create: `tests/integration/agent/runTool.test.js`

```
引數：{ action: string, path?: string, range?: string }
返回：動作的結果描述
```

**動作白名單**（`ProjectAction` 的子集）：

| action | 底座 | 花錢？ | 備註 |
|---|---|---|---|
| `newPlot` | `actions.newPlotFlow` | 否 | 建一份空細綱骨架 |
| `split` | `features/splitChapter` | 否 | 中轉站正文按 `---` 拆成釋出章 |
| `summarize` | `features/summarize.summarizeChapter` | 是（1 次） | 單章摘要 |
| `syncSummaries` | 同上 | 是（N 次） | **要報預計次數** |
| `batchPlots` | `pipelineBatch.generatePlots` | 是（N 次） | **要報預計次數** |
| `batchScenes` | `pipelineBatch.breakdownScenes` | 是（N 次） | 同上 |
| `batchManuscripts` | `pipelineBatch.writeManuscripts` | 是（N 次） | 同上 |
| `updateCard` / `createCard` | `features/characterCard` | 是 | 同上 |
| `extractStyle` / `generateLore` | 對應 feature | 是 | 同上 |

**明確不給的**：`delete`（任何形式）、`rename` / `move`、`initProject`、`newChapter`。

- **刪除**：作者要刪東西會自己刪。給 agent 一個刪除工具，收益接近零而風險是丟內容——即使進 `.trash/`，作者也未必知道它刪過什麼。
- **改名/移動**：`move` 在 workspace 層有，但不暴露給 agent。改名會連帶搬走場景目錄與中轉站正文（第 7 條），一次誤操作的收拾成本遠高於收益。
- **`newChapter`**：正常路徑上釋出章節是**拆分**出來的（第 23 條），不該由 agent 直接建。

**批次動作的確認**（第 4 條的落點）：

既有的 `pipelineBatch` 已經自帶確認框（寫明「有 N 章還沒排劇情，需要呼叫 N 次模型」）。agent 呼叫時**這個框照彈**——不要為 agent 加一條繞過它的路。同時把預計次數記進 `budget.calls`。

**`run` 全部 `mutating: true`**，即使 `summarize` 這種只寫摘要的也算。

- [ ] **Step 1: 寫失敗測試**

| 用例 | 斷言 |
|---|---|
| `action: 'split'` | 中轉站正文拆成章，原件進 `.trash` |
| `action: 'delete'` | `error`：不在白名單 |
| `action: 'batchPlots'` + 假 Host 拒絕 | 一次模型都不調 |
| `action: 'batchPlots'` + 同意 | 預計次數記進 budget |
| 認不出的 action | `error` 裡列出可用動作 |

- [ ] **Step 2–5: 同上**

---

### Task 4: 策略與確認閘門

**Files:**
- Create: `src/core/agent/policy.ts`
- Modify: `src/core/agent/loop.ts`
- Modify: `src/core/config.ts`（加一項 `agentPolicy`）
- Modify: 設定頁（前端 + `SettingsPayload`）
- Create: `tests/unit/agent/policy.test.js`

| 模式 | `list`/`read`/`search` | `generate` | `write`/`edit` 新建 | `write`/`edit` 覆蓋 | `run` |
|---|---|---|---|---|---|
| 謹慎 | 自動 | 每次確認 | 確認 | **審閱** | 確認 |
| **預設** | 自動 | 預算內自動 | 確認 | **審閱** | 確認 |
| 放手 | 自動 | 預算內自動 | 自動 | **審閱** | 自動（批次動作自帶的確認框仍然彈） |

「覆蓋 → 審閱」那一列**三種模式完全一樣**，且不可配置。

```ts
export type AgentPolicy = 'careful' | 'default' | 'bold';

export interface Gate {
  /** 要不要在執行前問一句。 */
  confirm: boolean;
  /** 問什麼。要說清「會發生什麼」，不是「確定嗎」。 */
  message?: string;
  detail?: string;
}

export function gateFor(policy: AgentPolicy, tool: ToolDef, args: Record<string, unknown>): Gate;
```

**確認框的文案要說清後果**，不是「agent 想呼叫 write，允許嗎」：

```
Agent 要寫入「第 12 章的細綱」
.novelforge/plots/012-入宗.md（新建，620 字）
[寫入] [跳過這一步] [停止 agent]
```

三個選項，不是兩個：「跳過這一步」讓 agent 繼續跑別的，「停止」結束整輪。

**使用者拒絕時回給模型的文字要有資訊量**：「作者跳過了這一步（寫入 …）。不要重試同一個動作。」——否則它會原地重試。

- [ ] **Step 1: 寫失敗測試**（三種模式 × 五類工具的矩陣；覆蓋那一列三模式一致）
- [ ] **Step 2–5: 同上**

---

### Task 5: 分檔池接入與 `supportsTools`

**Files:**
- Modify: `src/core/model/tiers.ts`（加 `agent` 任務）
- Modify: `src/core/model/providers.ts`（`ModelEntry.supportsTools`）
- Modify: `src/core/agent/tools/generate.ts`（非正文層走池）
- Modify: 設定頁

#### `tiers.ts`

```ts
export type LlmTask = … | 'agent';
TASK_LABEL.agent = 'Agent 排程';
TASK_HINT.agent = '每一步都要調一次，只做決策不產文字；必須支援工具呼叫';
DEFAULT_TASK_TIERS.agent = 'balanced';
```

#### `generate` 工具的模型選擇（第 12 條的延伸）

| 層 | 用哪個模型 |
|---|---|
| `manuscript` | **對話頁選定的那個**，不走池、不 fallback。中途換人會讓文風斷掉 |
| `plot` | `plotOutline` 檔的池 |
| `scene` | `sceneBreakdown` 檔的池 |
| `outline` | 對話頁選定的那個（一次定調，且沒有對應檔位） |

#### `supportsTools`

`ModelEntry` 加 `supportsTools?: boolean`，設定頁每個模型一個核取方塊。**agent 的排程模型選擇器只列勾了的**；一個都沒勾時提示「還沒有標記為支援工具呼叫的模型」。

**不做自動探測**——探測要真發一次帶 tools 的請求，那是在使用者沒點任何東西的時候花錢。

- [ ] **Step 1: 寫失敗測試**（正文層不走池、非正文層走對應檔、選擇器過濾）
- [ ] **Step 2–5: 同上**

---

### Task 6: 工具流 UI 完善與端到端驗證

**Files:**
- Modify: `media/src/view/messages.ts`
- Modify: `src/shells/shared/panes.ts`
- Modify: `src/core/agent/README.md`
- Modify: `AGENTS.md`（模組地圖 + 可能要加一條行為約束）
- Create: `tests/dom/view/agentTools.test.js`

#### 介面要素

```
你：把第 12 章排一下劇情，注意第 9 章埋的伏筆

  🔧 read .novelforge/plots/012.md          38 行     0.1s
  🔧 search「伏筆」kinds=summary             3 處      0.3s
  🔧 read .novelforge/summaries/009-….md    22 行     0.1s
  ✨ generate 劇情 · 4/4 節                  620 字    12.4s
  📝 write .novelforge/plots/012-入宗.md     已寫入    0.2s

  已排好第 12 章的劇情，把第 9 章那處「北境舊識」的伏筆接在……
  ─────────────────────────────────
  5 步 · 1 次生成 · 約 1.8 萬 token
```

**四條介面約束：**

1. **每一步都看得見**（第 11 條）。摺疊是可以的，但預設展開——第一次用的人要能看懂 agent 幹了什麼。
2. **花銷要顯示**（第 4 條）：末尾那一行。
3. **停止按鈕全程可用**，停在工具邊界。
4. **失敗的步驟標紅並保留**，不要因為後面成功了就把失敗那步藏掉。

#### 端到端手動驗證（用真模型跑一遍）

| # | 輸入 | 預期 |
|---|---|---|
| 1 | 「第 9 章裡主角說過他沒去過北境嗎？」 | `search` + `read`，給出答案，**不寫盤** |
| 2 | 「第 12 章的劇情有什麼問題？」 | `read` + `generate(critique)`，**不寫盤** |
| 3 | 「把第 12 章的劇情排一下」 | `generate` + `write`（彈確認） |
| 4 | 「把第 12 章拆成場景，然後寫正文」 | `run(split)` 不對——應該是 `generate(split)` + `write` ×N，再 `generate(manuscript)` + `write(append)` |
| 5 | 「把 12 到 18 章都排一遍」 | 應該走 `run(batchPlots)`（自帶確認框寫明 7 次呼叫），而不是迴圈 7 次 `generate` |
| 6 | 中途點停止 | 停在工具邊界，已寫的保留，氣泡裡說清停在哪一步 |
| 7 | 對一份已有內容的細綱 `write` | 彈 diff/確認，拒絕後 agent 不原地重試 |

第 5 條是**提示詞調優的驗收點**：如果 agent 傾向於迴圈調 7 次 `generate` 而不是用 `run(batchPlots)`，要在 system 提示裡補一句「連續多章的同類工作用 `run` 的批次動作，比逐章 generate 省錢且有進度條」。

- [ ] **Step 1: dom 測試**
- [ ] **Step 2: 實現**
- [ ] **Step 3: `npm test`**
- [ ] **Step 4: 端到端手動驗證**（七條全過）
- [ ] **Step 5: 更新文件**

`AGENTS.md` 建議加一條行為約束（第 24 條）：

> **24. Agent 不越過既有的閘門**：agent 的寫入走的是與「採納寫入」同一條 `workspace.write`，覆蓋已有內容一律先審閱，批次動作照彈既有的確認框（含「預計呼叫 N 次」）。給 agent 一條繞過閘門的快路，等於把前面 23 條一次性作廢。agent 也不決定「下一步該做什麼」——那是 `deriveNextStep` 的輸出，每回合注入給它，它拿著去執行。

- [ ] **Step 6: Commit**

---

## 本期不做

- **不給刪除 / 改名 / 移動工具。**
- **不做多 agent / 子 agent。**
- **不做自動化整本書**：每一層的落盤仍然要人點（除非使用者顯式選了「放手」模式，而那時覆蓋仍然要審閱）。
- **不做 agent 的記憶/長期狀態**。每輪 agent 從當前工程狀態重新開始——狀態在磁碟上，不在 agent 腦子裡。

## 給接手 agent 的提示詞

> 你在 novelwarden 倉庫裡執行「四期：寫工具 + 策略 + 工具流 UI」。前置是零到三期，確認都已合入（`src/core/agent/` 存在且只讀四件套能跑，`npm test` 綠）。
>
> 先讀 **`AGENTS.md` 的全部 23 條**——這一期給 agent 開寫許可權，每一條都在射程內。再讀 `docs/design/specs/2026-08-15-agent-architecture-design.md` 的 L3 一節與 `src/core/workspace/README.md`（八條守衛）。
>
> **這一期不需要寫任何新的保護程式碼**：一期的 `guard.ts` 已經把八條守衛放在所有寫入路徑上了。你要做的是把它們接到 agent 的確認流程上——哪些自動、哪些要問、問的時候說什麼。**如果你發現自己在寫一段新的路徑檢查，說明你繞過了 workspace，停下來重想。**
>
> 按 `docs/design/plans/2026-08-15-agent-phase4-write.md` 的 6 個 Task 逐個做，每個 Task 做完立刻 commit（字首 `feat(agent)`，中文正文，**不要加 Co-Authored-By 或 Generated with 標記**）。
>
> 六件最容易做錯的事：
> 1. **`review` 永遠 `true`**，不作為工具引數暴露。模型不該有能力關掉審閱。
> 2. **覆蓋已有內容一律審閱，三種策略模式完全一樣**，不可配置。這是產品承諾不是偏好設定。
> 3. **批次動作照彈既有的確認框**（含「預計呼叫 N 次」），不要為 agent 加一條繞過它的路。
> 4. **不給刪除/改名/移動工具。** 收益接近零，一次誤操作的收拾成本極高。
> 5. **使用者拒絕時回給模型的文字要有資訊量**（「作者跳過了這一步，不要重試同一個動作」），否則它會原地重試燒錢。
> 6. **正文層的 `generate` 嚴格用對話頁選定的模型**，不走池不 fallback——換人會讓文風斷掉。
>
> Task 6 的七條端到端手動驗證要真的跑一遍。第 5 條（連續多章應該走 `run(batchPlots)` 而不是迴圈 `generate`）是提示詞調優的驗收點，跑不過就補 system 提示。
