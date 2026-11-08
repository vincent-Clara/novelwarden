# core/mcp — 把工具端給外部 agent

**多步的活交給外部 agent（Claude Code、Codex……），Novelwarden 只提供工具。**

本專案不自帶對話迴圈。上下文壓縮、多步規劃、許可權模式、各家服務商的 tool calling 相容——這些通用
agent 做得更好，自己再做一份只是更弱的重複。真正值錢的不在迴圈裡：創作質量來自分階段裝配
（`generate` 內部那次呼叫），工程動作的不變數在 `features/` 裡（`pipeline` / `summary` / `characters` 那幾個工具轉發過去）。

所以這一層只做一件事：把 [`tools/`](../tools/README.md) 那套工具經 MCP 端出去，外部 agent 自帶迴圈。

| 檔案 | 職責 |
|---|---|
| [server.ts](server.ts) | ★ 協議：`initialize` / `ping` / `tools/list` / `tools/call` / `notifications/cancelled`，會話，狀態簡報 |
| [http.ts](http.ts) | Streamable HTTP 傳輸：POST 回 JSON（`tools/call` 回 SSE 帶進度保活）、會話頭、DELETE、GET 405、Origin 校驗。只用標準 `Request` / `Response` |
| [instructions.ts](instructions.ts) | `initialize` 回給客戶端的使用說明（只說怎麼用工具，不寫領域知識） |
| [index.ts](index.ts) | `createNovelMcp(backend)`：工具清單 + 說明 + 傳輸，殼只給「當前工程的執行端」 |

執行端在 [controller/mcp.ts](../controller/mcp.ts)：一次呼叫落到一個工程上，落到哪個由殼決定（`backend(project)`）。

## 怎麼接

獨立版（含桌面版的 sidecar）啟動時在同一個埠上掛 `/mcp`，日誌裡會打一行：

```
MCP 已就緒：http://127.0.0.1:3000/mcp
    claude mcp add --transport http novelwarden http://127.0.0.1:3000/mcp
```

呼叫落在**最近操作的那個網頁視窗開著的工程**上；地址帶 `?project=<工程目錄>`（每次請求都看地址，不必重新 initialize）就落到那個工程，它必須在某個視窗裡開著。沒開啟工程時工具照樣列得出來，呼叫回一句「先開啟工程」。
VS Code 殼還沒接（要另起一個 HTTP 服務，等用得上再說）。

## 分層

```
外部 agent ──HTTP──▶ mcp/http.ts ──▶ mcp/server.ts ──McpBackend──▶ controller/mcp.ts ──▶ tools/（ToolRegistry）
                                       （只懂協議）                    （生成位、對話頁、兩問）
```

`mcp/` 只認 `tools/` 的契約（`ToolSpec`、`NOVEL_TOOLS`），**不認識 `Workspace` / `DraftStore` /
`ChatController`**；`tools/` 一行都不 import `mcp/` 與 `controller/`。兩條由
[tests/contract/layerBoundary.test.js](../../../tests/contract/layerBoundary.test.js) 守著。

## 四條約束

### 1. 產物不回灌

`generate` 的返回裡只有形狀與 `draftId`，**沒有正文**。正文照舊流進對話頁那個 MCP 氣泡裡的工具卡片
（`toolDelta`），外部 agent 看不到——它每走一步都重燒一遍上下文，三千字正文塞回去，十步之後就是
三萬字的重複賬單。要看內容，等落盤之後 `read`。

### 2. 落盤前當場過一遍人（第 19 條）

`generate` 一產出，執行端就在 Novelwarden 的對話頁裡問一句寫不寫（與單步創作同一張卡片），
**等作者答了才返回**，結論接在返回後面。這一問不交給宿主的許可權配置：宿主那一層管的是「讓不讓調這個
工具」，可以被設成全自動；這一問管的是「這份東西進不進磁碟」，任何情況下都在。

`always` 那一檔（`edit`、裝 / 綁技能、改技能檔案）同理：下游沒有 diff，動手前先在對話頁問。
覆蓋已有內容走 workspace 的覆蓋審閱，與這一層無關。

### 3. 狀態由狀態機給（第 20 條）

MCP 沒有「每回合往 system 裡注入」這個口子，於是狀態機給出的那份簡報
（[views/stateBrief.ts](../views/stateBrief.ts)）貼在工具結果末尾，**只在它變了的時候貼**：會話的第一次
呼叫必貼，之後與上一次貼出去的那份逐字比。仍然沒有 `status` 工具。

### 4. 與對話頁共用一把生成鎖

花錢或寫盤的呼叫佔的是與對話頁單步創作同一個生成位（兩條路都往對話頁裡流正文、掛卡片，同時跑會互相蓋）。
佔不到就當場回 `isError`（「正在跑另一個生成任務」），不排隊——排著的呼叫作者看不見，等它突然開始寫盤時他早就忘了這回事。佔到了就走 `runTask`：
進度條上看得見、能停；停止會中斷那一次呼叫。查詢（`list` / `read` / `search`、查技能）不佔鎖、不進對話頁。

## 長呼叫

寫一章可能跑幾分鐘，等作者點確認也算在裡面。客戶端兩道上限都會撞上：等響應頭（Claude Code 預設 60 秒，
報「The operation timed out.」）與等結果的空閒上限（HTTP 預設 5 分鐘，收到進度通知才重新計時）。
所以 `tools/call` 在客戶端收 `text/event-stream` 時回 SSE：響應頭當場回，跑的期間每 15 秒發一條
`notifications/progress`（請求沒帶 `progressToken` 就發 SSE 註釋），跑完把回覆當最後一個事件發出去。
其餘請求、以及只收 JSON 的客戶端，照舊回整份 JSON。
Bun 預設 10 秒空閒就斷連線，所以殼對 `/mcp` 的請求調 `server.timeout(req, 0)`。

取消有兩條路：客戶端發 `notifications/cancelled`，或者連線斷了——都會中斷那一次呼叫。
