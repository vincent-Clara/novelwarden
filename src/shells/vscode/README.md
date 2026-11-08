# vscode — VS Code 殼

擴充套件的入口與一切「只在 VS Code 裡存在」的東西：命令註冊、webview 宿主、VS Code Language Model API。
業務邏輯與頁面內容都不在這裡（見 [../README.md](../README.md) 的殼契約），這一層只做接線。

## 檔案

| 檔案 | 職責 |
|---|---|
| [extension.ts](extension.ts) | ★ `activate()`：註冊全部 `novel.*` 命令、「Novelwarden」輸出面板（core 日誌的 sink）、FileSystemWatcher（章節儲存 → 重新整理定稿狀態：正文改了，那一章的定稿就對不上了）、舊目錄 `.novelforge/` / `.novel/` → `.novelwarden/` 遷移詢問、無工作區時的佔位檢視。 |
| [vscodeHost.ts](vscodeHost.ts) | `Host` 的實現：彈窗/進度/檔案監聽接回原生 API。`openFile` 開在第一欄，`openBeside` 用 `ViewColumn.Beside` 讓草稿與正文並排。`confirmCall`（調模型之前的那一問）：原生模態框放不了下拉框，多一顆「換模型 / 詳細度…」，點了依次彈 QuickPick（Esc 是不改那一項），選完回到模態框；補充說明末尾寫著「按分檔」時各項活交給誰與「這一次：……」。 |
| [chatViewProvider.ts](chatViewProvider.ts) | 側邊欄宿主（`WebviewViewProvider`，檢視 id `novelForge.chat`）。實現 `ViewHost` 掛到 `ChatController`。 |
| [chatPanel.ts](chatPanel.ts) | 編輯器宿主（`WebviewPanel` 單例）。側邊欄太窄時用 ⧉ 開啟，兩邊是同一個會話。 |
| [webviewHtml.ts](webviewHtml.ts) | 兩個宿主共用的頁面模板：head / CSP / tabbar / 裝配順序。五個頁籤的 DOM 來自 [../shared/panes.ts](../shared/panes.ts)，**這裡沒有第二份**。它是純函式——`asset` 與 `cspSource` 由呼叫方給，全檔案零 vscode 依賴，因此 jsdom 能直接執行它拿真實頁面。 |
| [webview.ts](webview.ts) | webview 的接線：`localResourceRoots`（`media/` 與 `dist/media/` 兩處，少一條就一片 404）與 `asWebviewUri` 的拼裝。兩個宿主從前各寫了一份。 |
| [vscodeLmProvider.ts](vscodeLmProvider.ts) | `LlmProvider` 的 vscode-lm 實現（複用 Copilot 訂閱）。兩點特殊：system 提示併入首條 user 訊息；有硬性 `maxInputTokens` 配額，裝配器據此收緊預算。 |

## 關鍵設計

- **UI 全在 webview**：不用 TreeView 等原生控制元件，一套 HTML 同時供側邊欄與編輯器標籤頁使用。命令、選單、快捷鍵的宣告在根目錄 [package.json](../../../package.json)。
- **啟用條件**：`workspaceContains:.novelwarden/project.json`（含舊目錄 `.novelforge/`、`.novel/`），非小說工程不啟用。
- **側邊欄摺疊不丟狀態**：`retainContextWhenHidden: true`，否則草稿和流式內容會丟。
- **命令是兜底入口**：工程頁上常用的那幾件（初始化、新建細綱 / 角色卡 / 設定、定稿、照正文更新過期細綱（`Novel: 照正文更新所有過期細綱`）、提取角色卡 / 文風、生成設定……）都有一條 `novel.*` 命令（webview 只說「點了什麼」），命令面板也能直達。帶表單的批次動作（補齊架構、拆細綱、批次寫章）只在工程頁上。
- **輸出面板最先建**：`registerOutputChannel` 是 `activate` 的第一句。遷移、配置讀取這些在它之後才跑，但模組 import 期就可能打過日誌了——所以它會先把緩衝裡已有的補進面板，再掛 sink。面板裡的內容與網頁日誌頁是同一份，只是多一個能跟其他擴充套件並排看、能整段複製的入口（命令 `Novel: 顯示輸出面板日誌`）。
- **草稿與細綱開在旁邊一欄**：`openBeside` 用 `ViewColumn.Beside`，它是相對**當前活動編輯器**的。從側邊欄點過來時最後活動的文字編輯器通常就是正文（`openFile` 把它放在第一欄），草稿於是落到第二欄；若此刻活動的是 `ChatPanel` 那個 tab，草稿就開在它旁邊。夠用，沒去糾正。章節工作臺（W6，工程頁點章節行名）走的是同一對方法：core 的 `openChapter` 先 `openFile` 正文、再 `openBeside` 細綱（沒有就按模板建；上一次並排開的是草稿就開草稿），這個殼一行沒改。編輯器上方那條章節條只在獨立版有（這裡沒有內建編輯器），並排的兩個編輯器加側邊欄的主按鈕就是那一套。
- **監聽哪些檔案不由這裡決定**：`VsCodeHost.watch` 只負責機制（`createFileSystemWatcher` + `RelativePattern`），glob 清單來自 [../../core/watchPolicy.ts](../../core/watchPolicy.ts) 的 `watchGlobs`——獨立版用同一份策略的另一種形態（事件過濾）。章節能是什麼副檔名、草稿在哪，都是 core 的規則。
- **彈窗與清單一律走 Host**：這一層不再直接調 `window.showQuickPick` / `show*Message`。「更新哪個角色」那份清單（含「＋N 章待讀」的計算）在 [../../core/choices.ts](../../core/choices.ts)——它是業務知識，殼裡抄一份就會與工程頁上的同一行說明分叉。
- **兩處刻意留在殼裡的原生流程**：[quickContinue.ts](quickContinue.ts)（流式寫進一個 untitled 文件，是徹底的平臺專屬入口；寫的是全書狀態機的**下一可寫章**，接著那一章已寫的末尾往下寫，續寫丟棄過的那一輪與收尾的去重靠完成時整份替換文件）與 `NO_WORKSPACE_HTML`（無工作區時的宿主佔位檢視，不載入指令碼、CSP 收到最緊）。它們沒有第二個殼需要複用，也沒有業務判斷藏在裡面。

## 依賴關係

只依賴 [core/](../../core/README.md) 與 [shared/](../shared/panes.ts)。本層是唯一允許使用 webview / 命令 / 檢視 API 的地方，
**不許 import 另外兩個殼**（由 [tests/contract/shellPurity.test.js](../../../tests/contract/shellPurity.test.js) 守著）。
