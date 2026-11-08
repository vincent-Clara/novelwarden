# src — 原始碼總覽

兩層結構，依賴方向自上而下，反向不允許：

```
src/
├── core/        核心邏輯：資料、上下文裝配、功能編排、LLM 接入（見 core/README.md）
│   ├── model/       資料層：NovelProject、Markdown 解析、創作流水線領域模型、服務商配置、會話
│   ├── context/     ★ 分階段裝配（配方 × 層）+ 身份化提示詞 + token 粗估
│   ├── features/    創作（四層產物）/ 批次流水線 / 定稿與全文大綱 / 角色卡 / 設定 / 文風提取
│   ├── llm/         LlmProvider 介面與 OpenAI / Anthropic 實現
│   ├── tools/       ★ 工具層：契約 + 登錄檔 + novel/ 那十二個工具（不認識 mcp/）
│   ├── mcp/         ★ 把工具經 MCP 端給外部 agent（協議 + HTTP 傳輸）
│   ├── protocol/    webview ↔ 擴充套件訊息協議（前後端唯一契約；對外仍是 core/protocol）
│   ├── controller/  ★ ChatController：宿主無關的面板邏輯
│   ├── views/       ★ 只讀聚合：工程樹、I/O 流水線、工作區卡、出場人物索引
│   ├── runtime/     ★ 執行時設施：日誌、SQLite 痕跡庫、失敗記錄、長任務、併發
│   └── stores.ts    檔案後端的配置與金鑰儲存
└── shells/      三個宿主殼，並排放（見 shells/README.md 的殼契約）
    ├── shared/      兩個以上殼共用的頁面骨架（所有 pane 的 DOM 唯一來源）
    ├── vscode/      VS Code 殼：extension 入口、兩個 webview 宿主、vscode-lm
    ├── standalone/  獨立 Web 服務殼：Bun 服務 + WorkspaceHub（工程可空）+ 頁面裝配
    └── desktop/     桌面殼（Tauri，Rust）：把獨立版當 sidecar 裝進一個視窗
```

各模組詳見：

- [core/README.md](core/README.md)
- [core/model/README.md](core/model/README.md) · [core/context/README.md](core/context/README.md) · [core/features/README.md](core/features/README.md) · [core/llm/README.md](core/llm/README.md)
- [core/tools/README.md](core/tools/README.md) · [core/mcp/README.md](core/mcp/README.md) —— 「能做什麼」與「怎麼端給外部 agent」分成兩層的理由
- [shells/README.md](shells/README.md) —— 殼的契約（三件事該做、三件事不該做）
- [shells/vscode/README.md](shells/vscode/README.md) · [shells/standalone/README.md](shells/standalone/README.md) · [shells/desktop/README.md](shells/desktop/README.md)

`core/views/pipeline.ts` 是讀取磁碟產物的 I/O 聚合器；`core/model/pipeline.ts` 仍是零 I/O
的純領域模型與狀態機，不屬於 `views/`。

## 一條創作請求的完整鏈路

以「在細綱層點寫細綱」為例，四個階段走的是同一條路，差別只在配方與提示詞（正文層在第 5 步之後多一條續寫鏈，審稿與修稿各有一條自己的鏈，見 [core/generation/README.md](core/generation/README.md)）：

1. webview 前端（[media/src/view/](../media/src/view/)）發 `send` 訊息，帶上 `stage` / `capability` / `target` → 宿主（`shells/vscode/chatViewProvider` 或 `chatPanel`）轉給 `core/ChatController`。
2. `ChatController`（`controller/chat.ts` 的 `send`）校驗一遍這個能力在這個階段合不合法（對不上就回落到 `discuss` 並 warn），記進會話，交給 `core/generation/generate.ts` 的 `generate()`。
3. `generate()` 先經 `core/llm/registry` 拿到 provider，再調 `core/context/builder.buildContext()` 裝配上下文。
4. 裝配器按 `action.stage` 取一張配方（[core/context/recipes.ts](core/context/recipes.ts)），**只讀這一層用得上的檔案**，按優先順序填預算，產出 messages + 明細。系統提示由 `stage`（身份）× `capability`（任務）拼出。
5. provider 流式返回增量文字，經 `GenerateHandlers` 回到 `ChatController`，以 `OutMessage` 廣播給所有掛接的宿主。
6. 收尾時若這次的輸出形態是 `artifact`，後端算出「落點 + 形狀 + 會不會覆蓋」，**當場在對話裡問一句「寫不寫」**（`controller/gate.ts` 推一條 `gate`，前端畫成氣泡裡的一張許可權卡片，與外部 agent 動手前那一問同一副樣子）。
7. 使用者可以先在氣泡裡改，改完點「寫入」→ 後端**重新解析氣泡裡當下的文字**（經 `editTurn` 落在 `turn.content` 上），目標已有內容時再走 `reviewReplace`，兩層都過了才落盤；點「不採納」則一個字不寫，氣泡末尾記一行「未採納」。

全程 `core/runtime/logger.ts` 記下：階段·能力與目標產物、裝配用了多少 token / 哪幾項被降級丟棄、首字延遲、產出字數與總耗時、最終寫到哪個檔案。

## 一次批次同步細綱的鏈路

與上面那條並列，是「長任務」的樣板——新加批次功能照著這條接：

1. 前端在工程頁點「立即同步」發 `projectAction: 'syncSummaries'` → `ChatController` 調 `core/features/summarize.syncSummaries()`。
2. 先掃一遍哪些章寫了正文卻沒定稿、或定稿之後正文又改過（`NovelProject.staleChapters`），**記進日誌**（共幾章、待同步幾章、哪幾章），再彈確認框——不偷偷燒 token。
3. `core/runtime/progress.runTask('同步章节细纲', …)` 起任務。它一次做三件事：包住 `Host.progress` 拿到宿主原生進度與取消訊號；把 `report({ message, current, total })` 登記進任務表；開始/結束進日誌附耗時。
4. 任務表一變，`ChatController` 構造時掛的 `onTasksChanged` 就把 `tasks` 快照廣播給所有前端 → 頁頭的任務條動起來（所有頁籤都看得見）；任務說完那一句（`finish`）時推 `taskDone`，前端出一條帶「開啟第 N 章」的提示。
5. 逐章 `summarizeChapter`：照 `chapters/` 裡的正文更新這一章的細綱（`summaries/` 下與正文相對路徑相同的那一份；只做定稿的第一步，不動角色狀態與敘事線；舊版先複製一份進 `.novelwarden/.trash/`），每章一條 `info`（用時、平均速度、預計剩餘）。**失敗不中斷整批**，記 `error` 後繼續；`signal.aborted` 則停在當前章，已更新的細綱保留。
6. 每條日誌同時經 `addLogSink` 推成 `log` 訊息 → 日誌頁實時追加。

## 構建

入口由 [esbuild.js](../esbuild.js) 打包為 `dist/extension.js`（`main` 指向它）。TypeScript 配置在根目錄 [tsconfig.json](../tsconfig.json)，strict 全開。
