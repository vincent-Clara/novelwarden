# Novelwarden 獨立 Web 程式設計

日期：2026-08-04
狀態：已評審通過

## 背景與目標

Novelwarden 當前是 VS Code 外掛，但核心能力（章節資料層、上下文預算構建、LLM 續寫/總結/角色提取、對話會話管理）並不真正依賴 VS Code。本設計把它改造為**雙形態共存**：

1. 保留 VS Code 外掛形態（現有使用者不丟失）；
2. 新增獨立程式形態：Bun 打包、啟動本地 Web 服務、瀏覽器裡操作，類似 opencode 的使用方式。

兩個形態共用同一套核心程式碼。

## 已確認的關鍵決策

| 決策點 | 結論 |
| --- | --- |
| 外掛去留 | 雙形態共存：共享 core，外掛與獨立程式兩個殼 |
| 工程模型 | 單工程目錄啟動（`novelforge [dir]`，一個目錄 = 一部小說） |
| 配置與金鑰 | 存使用者主目錄 `~/.novelforge/`，不進工程目錄 |
| 分發渠道 | 單可執行檔案（bun compile）+ npm/bun 包，兩者兼顧 |
| 章節編輯 | 獨立版不含編輯器，純對話形態；正文仍在使用者自己的編輯器裡改 |
| 網路範圍 | 僅本機（127.0.0.1），自動開瀏覽器，無認證 |
| 改造路線 | 方案 A：單倉庫分層，core + 兩個宿主殼，通過 Host 介面隔離宿主能力 |

## 總體架構

三層結構，仍在現倉庫：

```
src/
  core/                    # 零 vscode 依賴，純 TypeScript
    model/                 # project / session / providers / types / markdown（Uri → path）
    context/               # builder / tokenizer
    features/              # continueWriting / summarize / characters / style
    llm/                   # provider 介面 + openai / anthropic 實現 + registry
    controller.ts          # 現 chatController 的訊息語義處理，宿主無關
    protocol.ts            # InMessage / OutMessage 協議（renderHtml 移走）
    host.ts                # Host 介面定義
  vscode/                  # 外掛殼
    extension.ts           # 命令註冊，調 core 能力
    vscodeHost.ts          # Host 的 VS Code 實現（含 vscode-lm provider 註冊）
    chatViewProvider.ts
    chatPanel.ts
  standalone/              # 獨立殼
    cli.ts                 # 入口：解析引數、啟動服務、開瀏覽器
    server.ts              # Bun.serve：HTTP 靜態託管 + WebSocket
    fileHost.ts            # Host 的檔案實現（~/.novelforge/）
    html.ts                # Web 版 renderHtml
media/                     # view.css / view.js 原樣複用，新增 bridge.js
```

約束：`src/core/` 內不允許出現 `import 'vscode'`，由獨立的 tsconfig（不含 `@types/vscode`）硬校驗。

### 職責切分原則

現 `src/ui/chatController.ts` 混了兩類邏輯，按此切開：

- **訊息語義**（send / retry / accept / stop / session 管理 / 設定儲存 / 狀態推送）→ `core/controller.ts`，只依賴 `Host`；
- **宿主互動**（`vscode.commands.executeCommand` 分發、`showInputBox` 提問、開啟編輯器 tab）→ 經 `Host` 回呼由各殼實現。

## Host 介面

core 對宿主的唯一依賴面：

```ts
interface Host {
  config: ConfigStore;        // 讀/寫 novel.* 配置
  secrets: SecretStore;       // API Key get/set/delete/has
  input(opts): Promise<string | undefined>;                  // 替代 showInputBox
  confirm(message, actions): Promise<string | undefined>;    // 替代帶按鈕的 showInformationMessage
  pick(items, title): Promise<T | undefined>;                // 替代 showQuickPick
  progress<T>(title, fn: (signal: AbortSignal) => Promise<T>): Promise<T>; // 替代 withProgress + CancellationToken
  watch(dir, patterns, onChange): Disposable;                // 替代 FileSystemWatcher
  openFile(relPath): Promise<void>;
  toast(message, level): void;
}
```

要點：

- core 內取消 token 統一改為 `AbortSignal`；外掛殼在 `progress` 實現裡把 `CancellationToken` 橋接為 `AbortSignal`。
- `vscode-lm` provider 只在外掛殼註冊。配置中 kind 為 `vscode-lm` 的服務商在獨立版設定頁顯示為「僅 VS Code 可用」，不可選、不可發起請求。
- 檔案路徑在 core 內統一用字串相對路徑 + `path` 模組，`vscode.Uri` 只出現在外掛殼。

### 兩個實現

**`vscodeHost.ts`**：VS Code API 的薄封裝。`input/confirm/pick` 直接對映 `showInputBox` / `showInformationMessage` / `showQuickPick`；`openFile` 開啟編輯器 tab；config 橋接到 `~/.novelforge/config.json`（遷移後不再讀寫 settings.json）。

**`fileHost.ts`**：

- config：`~/.novelforge/config.json`，形狀沿用 `SettingsPayload`（providers / model / contextWindow / maxOutputTokens / temperature / recentChaptersFullText / prevChapterTailChars / summaryBatchSize / requestTimeoutMs）。
- secrets：`~/.novelforge/secrets.json`，許可權 600（Windows 僅當前使用者可讀），檔案頭註釋提醒勿提交。
- `input / confirm / pick`：經 WebSocket 下發 `prompt` 訊息，網頁彈 modal（複用現有 `providerModal` 的樣式），使用者提交後以新增的 `promptResult` InMessage 回傳。典型場景：初始化輸入作品名、缺 API Key 錄入、總結選章。
- `watch`：輕量檔案監聽（輪詢或等價機制），監聽 `chapters/**/*.md`、`.novelforge/**/*.md`、`.novelforge/project.json`，語義與現有 250ms 合併防抖一致。
- `openFile`：降級為 toast 顯示相對路徑。

## 獨立程式執行時

### CLI

```
novelforge [dir]        # 在 dir（預設當前目錄）啟動服務；目錄無 .novelforge/ 時提示是否初始化
novelforge init [dir]   # 互動式初始化小說工程（複用 core 的 initialize 邏輯）
  --port <n>            # 埠，預設自動選空閒埠
  --no-open             # 不自動開瀏覽器
```

### 服務（server.ts，Bun.serve）

- `GET /`：渲染 HTML（`html.ts`，複用 protocol 裡的頁面骨架；CSP 換成普通 Web 策略：同源 + nonce）。
- `GET /media/*`：靜態託管 `view.css` / `view.js` / `bridge.js` / `icon.svg`。
- `WS /ws`：收到的 JSON 按 `InMessage` 分發給 core controller；controller 的 `OutMessage` 原樣廣播。單使用者本機場景不做多會話隔離；多個 WS 連線共享同一 controller 例項（多開標籤頁內容同步）。
- Ctrl+C 退出；`SIGINT` 時把進行中的會話落盤。

### 前端橋接（media/bridge.js，新增的唯一前端檔案）

- 檢測執行環境：存在 `acquireVsCodeApi` 則用之（外掛殼），否則建立 `WebSocket('/ws')`。
- 對外暴露與 webview 相同的形狀：`postMessage(msg)` 與 `message` 事件。`view.js` 主體不改，僅有兩處小適配：「加入選區」在非 VS Code 環境改彈貼上 modal；WS 斷線重連條由 bridge.js 注入 DOM 並驅動重連。
- WS 斷線時頁面頂部顯示重連條；重連成功後重新發 `ready` 拉全量狀態（現有 `init` 訊息天然支援）。

### 協議增量

在現有 `InMessage` / `OutMessage` 上新增：

- `OutMessage`：`{ type: 'prompt'; promptId; kind: 'input' | 'confirm' | 'pick'; title?; message?; options?; placeholder?; password? }`
- `InMessage`：`{ type: 'promptResult'; promptId; value?: string; cancelled: boolean }`
- 外掛殼不消費這兩條訊息（彈窗直接走 VS Code 原生 UI）。

### 功能降級與適配（獨立版）

| 外掛能力 | 獨立版行為 |
| --- | --- |
| 「加入選區」 | 開啟貼上文字 modal，貼上內容作為 text 型別附件加入（複用現有 attachments 機制，core 不改） |
| `openFile` | toast 顯示相對路徑；外部編輯器改動由檔案監聽自動感知重新整理 |
| `vscode-lm` 服務商 | 設定頁顯示「僅 VS Code 可用」，不可選 |
| 「在 VS Code 設定中開啟」按鈕 | 隱藏（設定已統一在 `~/.novelforge/config.json`） |

## 配置與金鑰遷移

一次性、有提示：

- 外掛殼新版首次啟動：讀當前 VS Code `settings.json` 的 `novel.*` 與 SecretStorage 裡的 Key → 寫入 `~/.novelforge/config.json` / `secrets.json` → 提示「已遷移，VS Code 設定中的舊項不再使用」。
- 舊配置項在 `package.json` 標記 deprecated，保留一個版本週期的讀取兜底（`~/.novelforge/config.json` 不存在時才回落讀 settings.json）。
- 遷移後兩個殼讀寫同一份 `~/.novelforge/config.json`，不再需要「工作區 vs 全域」的 ConfigurationTarget 邏輯。
- 工程內 `.novelforge/project.json` 清單不動——作品資料隨工程走。
- API Key 舊鍵遷移沿用 registry 裡現有的 legacy key 邏輯，只是儲存後端從 SecretStorage 換為 `secrets.json`。

## 構建與釋出

- **外掛殼**：維持現有 esbuild 流程，入口改為 `src/vscode/extension.ts` → `dist/extension.js`，`vsce package` 不受影響。
- **獨立殼**：`bun build src/standalone/cli.ts --compile` 產出單檔案可執行（`novelforge.exe` / `novelforge`）；`media/` 資源通過 bun compile 的 asset 機制內嵌，分發即單檔案。
- **npm 包**：同一 bun 構建產物 + `bin: { "novelforge": ... }`；`bun install -g novelwarden-cli` 或 `bunx novelwarden-cli` 可用。
- README 給出兩條安裝路：GitHub Release 下載可執行檔案（推薦）與 bun 安裝。
- CI 釋出流水線不在本次範圍；先保證本地 `npm run build:standalone` 可復現兩條產物。

## 測試

- **型別校驗**：tsconfig 拆兩份——core + standalone 一份（不含 `@types/vscode`，硬校驗零 vscode 依賴），外掛殼一份。
- **smoke**：現有 5 個 smoke 指令碼改為引用 core 構建產物繼續跑（主要覆蓋 model / llm / builder / session）。
- **新增 `smoke-server.js`**：起服務 → fetch `/` 斷言 HTML → WS 連線斷言收到 `init` 訊息 → 發一條 `saveSettings` 斷言回執。
- **手工驗收**：`novelforge sample-novel` 後在瀏覽器裡走一遍對話 / 工程 / 歷史 / 設定頁。

## 範圍外（明確不做）

- 獨立版內建章節/檔案編輯器（首版純對話）。
- 多工程樞紐 / 工程管理首頁。
- 區域網訪問與認證。
- CI 自動釋出流水線。
- 終端 TUI（opencode 的 TUI 形態不在本次範圍）。
