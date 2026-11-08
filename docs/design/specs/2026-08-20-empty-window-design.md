# 空視窗啟動頁與標題欄選單設計

日期：2026-08-20
狀態：已評審通過

## 背景與目標

獨立版（含桌面殼）現在必須在啟動命令裡拿到工程目錄：CLI 不帶引數時把當前目錄當成工程，桌面殼在閃屏裡先選目錄再起 sidecar。沒有「未開啟資料夾」的狀態，標題欄也只是 logo + 工程名 + 主題按鈕。

目標：

1. **可以不帶工作區啟動**，編輯器區給出類似 VS Code 空視窗的 Get Started。
2. **頂部 `.wb-title` 改成 VS Code 風格選單欄**（File / Edit / Help）。
3. **開啟資料夾在同一程序裡熱換工作區**，不重啟服務。
4. **協議上預留多開工作區**，這一版視窗裡仍然只有 0 或 1 個工程。

本設計修訂 [2026-08-04 獨立 Web 程式設計](2026-08-04-standalone-web-app-design.md) 裡「單工程目錄啟動」那條：獨立版程序仍只服務本機一個作者，但工程目錄改為可空、可在執行時替換。外掛殼不動（VS Code 自己的空視窗與開啟資料夾繼續當工作區來源）。

## 已確認的關鍵決策

| 決策點 | 結論 |
| --- | --- |
| 範圍 | 獨立 Web + 桌面。外掛殼不改 |
| 空視窗外觀 | VS Code 空視窗：選單欄 + 活動欄仍在，編輯器區 Get Started；側欄對話/工程/檔案/歷史為空態；設定仍可用 |
| 上次工程 | 像 VS Code：上次關視窗時工程還開著就恢復；`關閉資料夾` 後再退出則進空視窗 |
| 選目錄 | 後端 `listHostDir` 列本機目錄，前端做遠端開發那種路徑框 + 列表，不彈系統對話方塊、不讓使用者手打整段路徑當唯一入口 |
| 開啟工程 | 同一程序熱換 `ChatController`，不重啟 sidecar |
| 多開 | Hub 按 id 掛多份執行時；這一版只實現 `replace`，`mode: 'add'` 回明確錯誤 |
| 選單深度 | VS Code 常用子集（見第 2 節表），不是 Selection / View / Go / Run / Terminal |
| 無工程檔案 | 不支援未命名檔案。新建檔案 / 開啟檔案在無工程時置灰；有工程時開啟檔案鎖在工程根內 |
| 桌面選單 | 去掉 Tauri 原生 File/Help，只留 HTML 選單 + 系統視窗按鈕 |
| 目錄列舉 | `listDir`（工程內）與 `listHostDir`（本機絕對路徑）分開，不合成一個 |

## 非目標

- 多視窗、`mode: 'add'` 的真正實現、無工程未命名檔案
- 自定義視窗最小化/最大化/關閉按鈕
- 工作區全文搜尋、查詢替換
- 改外掛空視窗或給 agent 開放 `listHostDir`
- 改 `getHost()` 全域單例、給每條現有 `InMessage` 加 `workspaceId`

---

## 1. 工作區生命週期與預留的多開面

### 1.1 分層

`ChatController` 仍然一對一綁一份 `NovelProject`。多開不進 core。

獨立版服務裡新增 **`WorkspaceHub`**（`src/shells/standalone/workspaceHub.ts`）：

```
id → BoundRuntime { controller, watchDisposable }
```

`id` 是 `fs.realpath` 之後的絕對路徑，同一目錄只存在一份。再開啟已開啟的路徑 = `activate`，不重建 controller。

現有創作 / 工程 / 檔案訊息打到**當前啟用**的那一份。沒有啟用項時 Hub 攔截並 toast「請先開啟資料夾」，不造假工程、不寫臨時目錄。

### 1.2 這一版的行為

Hub 裡最多一份。`開啟資料夾` 若已有工程：先處理未儲存 → 停生成 → `closeDatabase` → 停 watcher → 再繫結新路徑（替換，等同 VS Code 同視窗 Open Folder）。`關閉資料夾` 卸掉當前項，回到空視窗。

啟動時：

- CLI 帶了目錄 → 立刻繫結該目錄（覆蓋記憶）。
- 未帶目錄且 `window.json` 的 `lastOpen` 存在、目錄仍在 → 啟動時繫結，不閃歡迎頁。
- `lastOpen` 路徑已不在 → 清掉該欄位，進空視窗，不崩。
- 上次是關掉資料夾後退出（`lastOpen` 為 `null`）→ 空視窗。

### 1.3 預留的多開協議（這一版就落地形狀）

上行：

| 訊息 | 欄位 | 這一版 |
| --- | --- | --- |
| `openFolder` | `path: string; mode?: 'replace' \| 'add'` | 預設與 `'replace'` 實現；`'add'` toast「本版本只支援一個工作區」，磁碟不變 |
| `closeFolder` | `id?: string` | 省略則關當前 |
| `activateWorkspace` | `id: string` | 只有 0/1 項，呼叫等於確認當前項 |

下行（bind / unbind / 重新整理 / `ready` 都推）：

```ts
{ type: 'workspaces'; currentId: string | null; items: { id: string; root: string; name: string }[]; recents: { root: string; name: string }[] }
```

空視窗是 `{ currentId: null, items: [], recents }`。`recents` 來自 `window.json`，歡迎頁 Recent 列表吃它，不另造訊息。前端只憑 `currentId` 切歡迎頁/工作臺，不猜。

這些訊息由 Hub 在進入 `ChatController` 之前處理。外掛不會發。core 的 `dispatch` 給它們空分支，避免 `InMessage` 聯合型別漏網。

### 1.4 刻意不預留

- 不改 `getHost()`。`FileHost.root` 隨 bind/unbind 更換。真要 N 個同時開著時，再做成每份執行時一個 Host。
- 不做多根工作區（一個視窗裡幾個根目錄）。
- 不給每條 `send` / `saveFile` 加 `workspaceId`。多開後的路由是 `activate` 之後打到當前項，或下一期再加 Host-per-runtime。

### 1.5 記憶：`~/.novelforge/window.json`

```ts
{
  lastOpen: string | null; // 關掉資料夾後為 null；恢復啟動只看這個
  recents: { root: string; name: string; openedAt: number }[];
}
```

- 配置與金鑰仍在 `config.json` / `secrets.json`，本檔案只記視窗狀態。
- `recents` 在成功 `openFolder` 時 upsert，關掉資料夾不刪。上限 20 條，按 `openedAt` 新的在前。
- 桌面殼現有 `<app_config_dir>/shell.json` 的 `last_project`：若 `window.json` 還沒有 `lastOpen`，啟動時遷過去一次，然後不再當真相。獨立版與桌面共用 `window.json`。

設定不依賴工程，空視窗也能開啟設定頁。日誌庫跟工程走：沒開啟資料夾時日誌頁只有本程序記憶體記錄，`requestLogHistory` 回空列表且 `exhausted: true`。

---

## 2. 標題欄選單與空視窗歡迎頁

只改獨立版 `page.ts` 的 `.wb-title` 與獨立版 CSS。外掛沒有這條欄。前端用節點是否存在做能力探測，不寫殼名字分支。不新增前端產物（選單欄 / 歡迎頁 / 選擇器都進現有 `view.js`，探測不到節點就 return）。

### 2.1 標題欄佈局

從左到右，高度保持 38px，觀感貼 VS Code 自定義標題欄：

1. 應用圖示
2. **File / Edit / Help** 文字選單（不是大按鈕）
3. 視窗標題：空視窗 `Novelwarden`；有工程 `工程名 - Novelwarden`；有當前檔案再在前面加檔名
4. 右側仍是「顯示/隱藏編輯器」和主題

視窗最小化/最大化/關閉繼續用系統原生，不做假視窗按鈕。頁面標題和 `#wbProject` 只跟 `workspaces` 快照（外加當前編輯器檔名）走，不把工程名寫死在首屏 HTML 裡。

選單互動按 VS Code：點開一個，滑鼠移到隔壁就切過去；點外面或 Esc 收起；加速鍵寫在項右側；不可用項留著但置灰。`開啟最近開啟的` 是子選單。不做 Alt 快捷字母。不復用右鍵選單引擎（缺懸停切選單和子選單），單獨一個選單欄模組。

### 2.2 選單項與啟用

| 選單 | 項 | 無工程 | 有工程 |
| --- | --- | --- | --- |
| File | 新建檔案 | 置灰 | 可用：問工程內相對路徑，經 `workspace` 閘道器寫空檔案；已存在則拒絕，不限章節/角色/設定三個區 |
| File | 新建工程 | 可用 | 可用 |
| File | 開啟檔案 | 置灰 | 可用：選擇器根鎖在當前工程，資料走現有 `listDir` |
| File | 開啟資料夾 | 可用 | 可用，`mode: 'replace'` |
| File | 最近開啟 ▶ | 可用（無記錄時子選單寫「沒有最近開啟的工程」） | 同左 |
| File | 儲存 / 另存為 / 全部儲存 | 置灰 | 有開啟且（儲存/全部儲存）有髒標籤才啟用；另存為問工程內新路徑，不覆蓋已有 |
| File | 關閉編輯器 | 置灰 | 有當前標籤才啟用 |
| File | 關閉資料夾 | 置灰 | 可用 |
| File | 退出 | 可用 | 一律 `window.close()`，**不**向服務發 quit（以免殺掉還開著網頁的 `novelforge`）。普通瀏覽器標籤通常關不掉，使用者關標籤即可；Tauri WebView 裡會關視窗。不按殼名字決定渲染 |
| Edit | 撤銷 / 重做 / 剪下 / 複製 / 貼上 / 全選 | 焦點在 input/textarea 才啟用 | 同左；走現有 `execCommand`，保住 textarea 撤銷棧 |
| Edit | 查詢 | 置灰 | 當前編輯器一條窄查詢條（下一個/上一個），不做工作區搜尋、不做替換 |
| Help | 歡迎頁面 | 可用（已在歡迎頁則無操作） | 在編輯器區開啟 Get Started，不關已開啟的檔案標籤；切迴檔案標籤即離開 |
| Help | 使用說明 | 見 2.2.1 | 同左 |
| Help | 開啟日誌目錄 | 可用：發 `openLogDir`。Hub 用 `openWithSystem` 開啟 `~/.novelforge/`（`window.json` / 配置所在目錄）。桌面失敗閃屏仍走 Tauri `open_logs`（sidecar.log 目錄），那是服務還沒起來時的入口 | 同左 |
| Help | 關於 | 前端彈層：產品名、版本（`standalonePage` 寫入 `data-version`，來自 `package.json`）、當前工程路徑（沒有則省略） | 同左 |

**使用說明（2.2.1）。** 有開啟的工程且工程根下有 `README.md`（或 `README.markdown`）→ 內建編輯器開啟。否則，若程序能解析到原始碼倉庫根的 `README.md`（從倉庫跑 `npm run standalone` 時可以）→ `openWithSystem` 開啟該絕對路徑，不經工程閘道器。單檔案可執行旁邊沒有這份檔案 → toast「找不到使用說明」。不 404，不編一套新文件頁。

桌面殼去掉 `build_menu` 註冊的原生 File/Help，避免疊兩層。關視窗用系統標題按鈕。失敗閃屏上的「檢視日誌」仍走 Tauri `open_logs`（那時還沒導航到 sidecar 頁面）。

### 2.3 兩種空態，不合併

`body` 用能力類（如 `no-workspace`），不判斷殼名。

**無工程（`currentId === null`）—— Get Started**

- 編輯器區：左列 Start（新建工程、開啟資料夾）+ Recent（名字 + 路徑，點一項即 `openFolder replace`）；右列一句產品說明和常用快捷鍵。沒有克隆 Git / 遠端連線。
- 對話 / 工程 / 檔案 / 歷史：短空態「開啟資料夾後即可使用」；對話輸入禁用。
- 設定可用。日誌頁僅記憶體日誌。

**有工程、沒開啟檔案**——繼續用現有 `ed-welcome`（「還沒有開啟檔案」）。Help → 歡迎頁面可以在有工程時蓋住編輯區顯示 Get Started，但不關標籤。

### 2.4 新建工程

先開啟第 3 節的目錄選擇器（選目錄）。若該目錄已是小說工程（存在 `.novelforge/project.json`）：toast 並 `openFolder replace`，不跑初始化。否則先繫結該目錄，再走現有 `initProjectFlow`（作品名 / 作者）。使用者取消初始化：目錄保持開啟，工程頁仍可點「初始化工程」。

---

## 3. 目錄選擇器與本機列舉

### 3.1 兩種列舉

| API | 路徑 | 用途 |
| --- | --- | --- |
| 現有 `listDir` | 工程內相對路徑 | 側欄檔案頁；有工程時的「開啟檔案」 |
| 新 `listHostDir` | 本機絕對路徑 | 「開啟資料夾」「新建工程」 |

`listHostDir` 只列一層、**不返回檔案內容**。寫盤仍只在開啟工程之後走 `workspace/` 閘道器（`createHostDir` 除外，見下）。實現放在獨立版殼（`src/shells/standalone/hostFs.ts`），不進 core，避免 agent 或外掛誤用。

隱藏名與資源管理器同一份：`node_modules`、`.git`。點開頭的目錄顯示。條目上限與截斷口徑與 `listDir` 相同（`MAX_DIR_ENTRIES`，把真實總數放進 `truncated`）。失敗不拋，結果帶 `error`。symlink 按 `stat` 後的目錄/檔案列出來；workspace `id` 用 `realpath`，避免同一目錄兩條。

### 3.2 選擇器 UI

模態框，不是 `prompt` 輸入框。按 VS Code 遠端 Open Folder：

- 標題隨用途變
- 路徑輸入框：當前絕對路徑，回車跳轉；不合法則列表區顯示原因，不關框
- 列表：目錄在前、檔案在後；單擊目錄進入；`..` 回到 `parent`（檔案系統根沒有 `..`）
- Windows：路徑為空或從磁碟機代號再往上 → 列出磁碟機代號（`roots: true`）
- Unix：開啟選擇器時落在 `os.homedir()`；`..` 可上到 `/`。`path === ''` 與 `path === '/'` 都列舉 `/` 的直接子項，此時沒有 `..`
- 底部：新建資料夾、取消、確定
- 資料夾模式：確定 = 開啟**當前路徑**（不必再點進子目錄）
- 檔案模式：選中一個檔案後確定才啟用；根鎖在當前工程，請求走 `listDir`

### 3.3 `createHostDir`

僅選擇器「新建資料夾」：`{ parent: string; name: string }` → `mkdir`。同名已存在則報錯不覆蓋。`name` 含斜槓、反斜槓或 `..` 直接拒絕。不給 agent、不進工程檔案操作。

### 3.4 協議補遺

上行另增：

```ts
{ type: 'listHostDir'; path: string }           // '' = 根層
{ type: 'createHostDir'; parent: string; name: string }
{ type: 'openLogDir' }
{ type: 'openReadme' }
{ type: 'createFile'; relPath: string }         // 僅有工程；經 workspace 寫空檔案，已存在拒絕
```

下行：

```ts
{
  type: 'hostDir';
  path: string;
  parent?: string;
  entries: { name: string; kind: 'dir' | 'file'; absPath: string }[];
  truncated: number;
  error?: string;
  roots?: boolean;
}
```

失敗用已有 `toast`，不另造 `workspaceError`。`createHostDir` 成功後推一條該 `parent` 的 `hostDir`（列表重新整理）。

### 3.5 開啟 / 替換 / 關閉流程

1. 前端若有未儲存編輯器，先問（與關標籤同一套）；取消則不發訊息。
2. `openFolder` + `replace`：校驗路徑是存在的目錄 → dispose 舊執行時 → `NovelProject.open` → 新 controller、新 watcher、`FileHost.bind` → 寫 `window.json` → 推 `workspaces` → `resendFullState`。
3. 已在 Hub 裡的路徑：只啟用。
4. `closeFolder`：dispose → `lastOpen = null`（recents 保留）→ 推空 `workspaces`。前端清編輯器標籤、回到 Get Started。
5. 無啟用工作區時，創作/工程/檔案類訊息由 Hub 攔住。下列訊息在空視窗仍可用：`ready`、選擇器訊息、工作區生命週期、`openLogDir`、`openReadme`、`saveSettings` / `setApiKey` / `clearApiKey` / `testConnection` / `openNativeSettings`（獨立版無操作）、`switchTab`、日誌三條、`cancelTask`、`promptResult`。`createFile` 無工程時 toast「請先開啟資料夾」。

設定讀寫抽成不依賴 `NovelProject` 的函式（配置本就在 `~/.novelforge`）。獨立版無論有沒有工程，設定類訊息都走 Hub → 這些函式，避免空視窗去構造 controller。外掛殼仍走現有 `ChatController` 分支（那邊一定有工作區）。

### 3.6 空視窗的 `ready` / WS 重連

不髮帶假工程的 `init` / `project` / `session`。先發 `workspaces`（空）和 `settings`（讀 `config.json`），可附帶記憶體 `logs` 與空 `tasks`。

有工程時的 `ready` / WS `open`：先 `workspaces`，再現有 `resendFullState`。

---

## 4. CLI、桌面、熱換落點

### 4.1 CLI

`parseArgs`：`root` 改為 `string | undefined`。不帶位置引數時不再 `path.resolve('.')`。

| 命令 | 行為 |
| --- | --- |
| `novelforge` | 起服務、按第 1.2 節恢復或空視窗 |
| `novelforge [dir]` | 開啟該目錄 |
| `novelforge init [dir]` | 不變；`init` 仍要一個目錄，預設才是 `.` |
| `--port` / `--no-open` / `--verbose` | 不變 |

未初始化目錄仍只打提示、不阻止啟動（與現在一致）。F5 保留「示例小說工作區」，新增「空視窗」（不帶目錄）。README 去掉「預設當前目錄」。

### 4.2 桌面

sidecar **不再接收工程路徑**，引數只有 `--no-open --port`。恢復上次工程由 sidecar 讀 `window.json`，與瀏覽器裡跑 `novelforge` 同一條路。開啟/關閉資料夾不 kill、不重啟 sidecar。

閃屏只剩：

- `starting`：正在啟動
- `failed`：起失敗了（重試 / 檢視日誌）

刪除 `picking` 態、選目錄按鈕、以及「開啟其他工程就重啟 sidecar」的選單路徑。`setup` 裡直接 `launch`（無 root）。`shell.json` 只做一次遷到 `window.json` 的橋，遷完可不再寫 `last_project`。

約定仍成立：退出必須 kill sidecar；不開 `dangerousRemoteDomainIpcAccess`。傳給 sidecar 的工程路徑這條約定改為「不再傳工程路徑」。

### 4.3 熱換實現要點

- `startServer({ root?: string; port; verbose? })`：有 `root` 則立刻 `hub.open`（給 CLI 與現有 e2e）。
- `FileHost` 增加 `bind(root)` / `unbind()`：換工程與 watcher；`PromptHub` 和廣播一直活著。`initHost` 仍只調一次。
- 替換順序不可顛倒：未儲存 → 停生成 → `closeDatabase` → 停 watcher → `open`。反了會在 Windows 上撞庫檔案 EBUSY。
- 開啟失敗：能回舊工程則回；舊的已經 dispose 完則落到空視窗並 toast 原因。列目錄失敗寫在 `hostDir.error`，框不關。
- 日誌仍 `redact`，`listHostDir` 只記路徑與條目數，不記檔案內容。

### 4.4 訊息路由（獨立版 `server.ts`）

```
promptResult                → PromptHub
listHostDir / createHostDir
openFolder / closeFolder
activateWorkspace
openLogDir                  → WorkspaceHub（始終）
saveSettings / setApiKey /
clearApiKey / testConnection
ready（先 workspaces）      → Hub；有啟用項再轉 controller.resendFullState
其餘 InMessage              → hub.active()?.handle；沒有則 toast
```

---

## 5. 測試

| 層 | 內容 |
| --- | --- |
| 單元 | `parseArgs` 無引數時 `root` 為 `undefined`，帶 dir 仍 resolve；`hostFs`：缺目錄、截斷、拒絕 `..`、同名不覆蓋、不返回內容；Hub：開啟、替換會 dispose、`add` 報錯、同路徑只啟用、`realpath` 去重、關閉後 `lastOpen` 為空 |
| e2e（Bun） | 無 `root` 起服務 → `ready` 得到空 `workspaces`、沒有假 `init`；`listHostDir`；開啟 `sample-novel` 後有 `init`/`project`；再 `closeFolder` 回到空。現有帶 `root` 的用例繼續傳 `root` |
| DOM | 選單欄結構與置灰；`no-workspace` 時 Get Started；選擇器進入子目錄 / `..` / 確定當前路徑 |
| 契約 | `corePurity` / `shellPurity`、sample-novel hash、外掛行為不改 |
| 桌面 | 無自動測。手測：無記憶進歡迎頁；有記憶不閃歡迎頁；失敗態仍能看日誌；HTML 選單存在且無原生 File/Help 重複 |

`startServer` 的 `initHost` 仍是模組級單例，e2e 裡無 root 的服務與帶 root 的服務仍須按檔案順序跑完，不能並行起兩份還指望 Host 不串。

---

## 6. 主要改動檔案（供計劃拆任務，不是實施步驟）

- 協議：`src/core/protocol/in.ts`、`out.ts`；`ChatController.dispatch` 空分支
- 獨立版：`cli.ts`、`main.ts`、`server.ts`、`fileHost.ts`、`page.ts`、新 `workspaceHub.ts`、`hostFs.ts`、`windowState.ts`
- 前端：`media/src/view/` 下選單欄 / 歡迎頁 / 選擇器；`media/src/css/standalone/`
- 桌面：`src/main.rs`、`sidecar.rs`、`project.rs`、`ui/splash.html`、`splash.js`
- 文件：`README.md`、`src/shells/standalone/README.md`、`src/shells/desktop/README.md`、`.vscode/README.md`、`launch.json`
- 測試：`tests/unit/`、`tests/e2e/standalone/`、`tests/dom/standalone/`

設定相關的純函式從 `controller/settings.ts` 抽出時，外掛路徑保持行為逐位元組不變（仍由 controller 呼叫同一份函式）。
