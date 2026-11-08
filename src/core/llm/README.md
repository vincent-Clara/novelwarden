# core/llm — 模型接入層

把「呼叫大模型」抽象成統一的 `LlmProvider` 介面，上層（features / context）不關心具體協議。

## 檔案

| 檔案 | 職責 |
|---|---|
| [provider.ts](provider.ts) | `LlmProvider` 介面、`StreamEvent` / `ChatMessage` / `StopSignal` / `StreamOptions`、`CancelledError` / `LlmError`，以及 SSE 流的通用解析與取消/超時處理。 |
| [collect.ts](collect.ts) | ★ 把事件流收成一段文字：`collectText` / `collect` / `mergeUsage`。既有呼叫點只經這裡碰事件流。 |
| [openaiProvider.ts](openaiProvider.ts) | OpenAI 的 **Responses API**（`/responses`，Codex 那一套）。思考深度是 `reasoning.effort`；system 走 `instructions` 頂層欄位。**只認 `/chat/completions` 的服務商（DeepSeek / 智谱 / Kimi / 通义 / 本地 Ollama）在這條路上會 404**——見下面「兩條協議，兩個梯子」。 |
| [anthropicProvider.ts](anthropicProvider.ts) | Anthropic Messages API。注意 system 要單獨提取、相鄰同角色訊息要合併、首條必須是 user。思考深度有**兩代寫法**，由 provider 自己問出來（見下）。 |
| [registry.ts](registry.ts) | ★ 按「字首/模型名」引用構造 provider；API Key 按服務商 id 存 SecretStorage（含 0.1.x 按 kind 存的遷移）；連線測試。 |
| [pool.ts](pool.ts) | ★ 模型池：按**任務檔位**取模型，並把該檔的清單變成**輪轉負載均衡**（併發）與**隨機 fallback**（序列失敗後換模型重試）。另出 `budgetForTask()`——不構造 provider 的預算查詢。只給工程頁的後臺任務用。 |

> `vscode-lm`（Copilot）的實現在 [../../shells/vscode/vscodeLmProvider.ts](../../shells/vscode/vscodeLmProvider.ts)——它依賴 VS Code Language Model API，屬於宿主層，但由本層的 registry 統一分發。

## 關鍵設計

- **`StreamEvent` 是唯一原語**：`stream(messages, options): AsyncIterable<StreamEvent>`，四種事件 `text` / `reasoning` / `usage` / `stop`。取消經 `AbortSignal`，超時經 `timeoutMs`（**空閒超時**：流式還在吐字時重置，卡住這麼久沒資料才中止）。**沒有第二條路**——provider 總是全量發事件，不由「呼叫方想不想聽」決定發不發：usage 是校準 tokenCounter 的唯一實測來源，thinking 是「正文還沒開始吐」這段時間介面上唯一的反饋，都不該由呼叫方開關。要文字的呼叫點一律走 `collectText`，形狀仍是「傳一個流，拿一段文字」。
- **usage 按欄位合併**：同一次請求會回報多次（Anthropic 在 `message_start` 給輸入、`message_delta` 給輸出），所以 `mergeUsage` 是**後到的覆蓋同名欄位、缺席的欄位保留**。整份覆蓋會讓先到的輸入用量被後一條抹掉，估算/實測比值就廢了。
- **訊息只有 system / user / assistant 三種角色**（`ChatMessage`），內容都是純文字。本層不做工具呼叫：外部 agent 經 MCP（[../mcp](../mcp/README.md)）直接調我們的工具，模型側的 tool calling 與這一層無關。
- **錯誤說人話**：HTTP 401/404/429 等都在 provider 內整理成面向作者的中文提示後以 `LlmError` 拋出；使用者主動取消拋 `CancelledError`，呼叫方靜默處理。
- **API Key 按服務商 id 分開存**：同一種協議可以並存多個服務商（官方介面、路由型服務商、自建閘道器都可以是同一種 kind），各有各的 Key。`vscode-lm` 走 Copilot 授權，不需要 Key。
- **硬配額上報**：`maxInputTokens()` 返回 provider 的硬性輸入上限（vscode-lm 有配額），裝配器會與 `contextWindow` 取小。
- **思考深度只作用於作者選定的那個模型**：`StreamOptions.thinking` 由對話頁的單次生成帶上（作者在會話上選的那一檔），**工程頁的後臺批次任務一律不帶**。理由與第 12 條同源——那一檔模型是作者按成本挑的，替他把七十六章的定稿都升級成深思考，賬單上看不出是誰決定的。

## 兩條協議，兩個梯子

**openai 這種 kind 走 Responses（`/responses`），anthropic 走 Messages，沒有第三條路。**
思考深度的落點只在這兩條協議上：老的 `/chat/completions` 裡「想多深」不是一個欄位（要麼
是模型名的一部分，要麼根本沒有），介面上那個下拉框就無處可去。兩條協議並存的代價是每個
欄位都要先判一次「現在是哪一條」，而設定頁也要讓作者先答一道他答不上來的題。

代價說清楚：**只認 `/chat/completions` 的服務商（DeepSeek、智谱、Kimi、通义、本地 Ollama）
在這條路上會 404**，404 的提示裡點了這件事，「新增服務商」的預設裡也不再擺它們（點了就
404 的按鈕比找不到更讓人惱火）。要用它們仍然可以手工新增一個自己那側的 `/responses` 閘道器。

思考深度是**一個檔位、兩套欄位**（檔位表在 [../model/thinking.ts](../model/thinking.ts)）：

| 檔 | OpenAI Responses | Anthropic Messages |
|---|---|---|
| 不思考 | 不帶 `reasoning` | 不帶 `thinking` / `output_config` |
| 淺 / 中 / 深 | `reasoning.effort: low/medium/high` | `output_config.effort: low/medium/high` |
| 極限 | `reasoning.effort: xhigh` | `output_config.effort: max` |

另外三條與它綁在一起：

- **思考開著時不帶 `temperature`**。兩家都要求它是預設值，帶上去就是 400。關著時照常帶——
  非推理模型上它仍然是有效的文風旋鈕。
- **上游拒了就換一種寫法，不把這一輪判死**。`effort` 的梯子上老模型缺頂上那兩檔；Anthropic
  更是有兩代寫法（自適應 `thinking: {type:'adaptive'}` + `output_config.effort`，以及 4.5 及
  更早唯一可用的手動預算 `thinking: {type:'enabled', budget_tokens}`，後者在 4.7 以後直接被
  拒）。兩個 provider 各自按「介面地址 + 模型」把結論記在記憶體裡（`QUIRKS`）：降一檔、換一代
  寫法、最後退到不帶思考欄位，每種模型一生只吃一次 400。**記在記憶體而不是配置裡**——這是上游
  的事實，不是作者的偏好，寫進設定頁只會多一個他答不上來的問題。
- **手動預算那條路上，預算必須小於 `max_tokens`**（思考 token 算在輸出上限裡，且下限是 1024）。
  所以 `thinkingBudget` 按輸出上限收緊，收不出 1024 就不帶思考欄位，而不是發一個必然 400 的請求。

### 收尾原因：`StopSignal`

兩家都把上游的收尾原因歸一成 `StopSignal`（`end` / `maxTokens` / `other`），以 `stop` 事件交上去。用它的是正文續寫鏈（[../generation/continuation.ts](../generation/continuation.ts)：`maxTokens` 往後接、`end` 說明這一章已經收了尾）與工程頁批次（[../features/pipelineBatch.ts](../features/pipelineBatch.ts)：判斷結構化輸出是否被截斷）。

- **上游不發就一個都不交**（`undefined` 意為「它沒說」）。補一個預設值等於替它編一句話，而續寫鏈會照著那句話決定回退還是往後接。
- Anthropic 的 `stop_reason` 在 `message_delta` 上；認不出的值（`pause_turn`、`refusal`……）一律 `other`。Responses 那條路上 `response.completed` 報 `end`，`response.incomplete` 按 `incomplete_details.reason` 報 `maxTokens` 或 `other`。

## 模型池的五條規矩

模型分為**三檔**（快速 / 均衡 / 精標，見 [../model/tiers.ts](../model/tiers.ts)），每檔各是一份有序清單。`createModelPool({ task })` 按任務所屬的檔取清單，把它變成一個能換人的池，但**只有工程頁的後臺任務**（補齊架構、批次拆細綱、批次寫章與寫完即審稿 / 定稿、同步細綱、全文大綱、角色卡、設定、文風、角色提取）以及經 MCP 接入的外部 agent 調生成工具時（只取首選，見 [../tools/novel/generate.ts](../tools/novel/generate.ts)）走它——對話頁的單次生成（寫正文、審稿、修稿……）與連線測試必須嚴格用使用者選定的那個模型，中途換人會讓文風斷掉。

唯一的例外是**轉寫**（`transcribe`，2026-10-25 起，細綱試點之後推到全部結構化產物）：幹活的模型按格式寫自然語言，寫完由「轉寫」那一檔照抄成 JSON（[../features/transcribe.ts](../features/transcribe.ts)）。它不寫內容，所以對話頁也走它的池（[../features/poolIO.ts](../features/poolIO.ts) 的 `lazyTranscriber`，用到時才建；工程頁任務用 `poolTranscriber`），`refsForTask` 也不給它換成確認框上釘的模型（作者定的：固定的轉寫模型）。那一檔沒配照第 1 條沿用預設模型；一個可用的模型都沒有時退回幹活那個模型轉寫，日誌裡說一聲。預設歸快速檔，溫度 0、不帶思考。

1. **空檔位沿用「預設模型」**：某一檔沒配模型，歸在該檔的任務就用 `config.models`。三檔都不配 = 不分檔，行為與分檔之前逐位元組一致。這條是硬約束——靜默把某些任務降級到便宜模型，等於替作者做了質量取捨。
2. **起始模型看場景**：併發任務（`concurrent: true`）按游標輪轉，把請求攤到幾個服務商上；序列任務恆取該檔的 `refs[0]`，與「檔內第一個是首選」的直覺一致。
3. **fallback 是換人，不是重試，而且不跨檔**：失敗後從**同檔裡沒試過的**模型裡隨機挑一個，最多 `config.fallbackAttempts` 次；同一個模型不會被試兩遍，檔裡只有一個模型時乾脆不重試，檔內換完了就上拋——**絕不去別的檔撈人**。快速檔失敗自動升級到精標檔，等於繞過作者的成本決定去燒貴 token，而且從日誌上看不出來。`CancelledError` 立刻上拋——使用者點了停止還接著換模型，會讓「停止」看起來失靈。作者在調模型之前的確認框上為這一次指定了模型（`config.pinnedModel`，見 [../runtime/callScope.ts](../runtime/callScope.ts)）時，`refsForTask` 只給它：池裡只有一個模型，不換人，預算也是它的（第 5 條照舊成立）。
4. **只有該檔首選能彈 Key 輸入框**：備選模型一律 `buildProvider(active, { promptForKey: false })`，缺 Key / 環境不支援就剔除並 `warn`。一次點選連彈五個 API Key 輸入框，比沒有 fallback 更讓人惱火。
5. **預算跟著幹活的模型走**：`pool.primaryBudget` 是該檔**首選模型**的視窗與輸出上限（模型自帶的優先，預設退回內建相容值）。features 切批、截斷一律讀它，不能讀 `config.contextWindow`——後者是**對話頁選定模型**的視窗，拿 200k 的寫作模型的視窗去給 32k 的快速檔模型切批會穩定超窗。取首選而非全池最小值：fallback 是小機率路徑，為它把每一批都切小等於讓常態下每次呼叫都少讀幾段。

確認框之前就要算的東西（設定生成的掃描片段數、角色卡的批數——它們就是「預計呼叫 N 次」那個數字）用 `budgetForTask(task)`：它只解析引用、不構造 provider，因此不會在使用者點確認之前彈出 API Key 輸入框。

## 依賴關係

依賴 `model/`（讀配置、解析模型引用）。被 `features/` 使用；`initSecrets` 由 `vscode/extension.ts` 在啟用時呼叫以注入 SecretStorage。
