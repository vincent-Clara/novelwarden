# 空視窗啟動頁與標題欄選單 Implementation Plan

> **接手須知：** 這份計劃面向新的 agent，假設你**沒有讀過**前面的對話。開工前必讀：
> 1. 根目錄 [AGENTS.md](../../../AGENTS.md)
> 2. 設計依據 [docs/design/specs/2026-08-20-empty-window-design.md](../specs/2026-08-20-empty-window-design.md)（已評審）
> 3. [src/shells/README.md](../../../src/shells/README.md) 殼契約（能力探測、不許按殼名分支）
> 4. [media/README.md](../../../media/README.md) 前端約定
>
> 每個 Task 按 `- [ ]` 逐步執行，做完立刻 commit。在 **git worktree** 裡做，分支 `feat/empty-window`，不要在使用者的 `main` 工作區改程式碼。

**Goal:** 獨立版（含桌面）可以不帶工程目錄啟動；空視窗是 VS Code 式 Get Started + File/Edit/Help 選單欄；開啟資料夾在同一程序熱換工作區；協議預留 `mode: 'add'`。

**Architecture:** `ChatController` 仍一對一綁 `NovelProject`。獨立版 `WorkspaceHub` 持有 0 或 1 份執行時。本機目錄列舉在殼層 `hostFs.ts`，不進 core。記憶在 `~/.novelforge/window.json`。前端選單/歡迎頁/選擇器進現有 `view.js`，用節點探測跳過；不新增前端產物。

**Tech Stack:** 現有 TypeScript + `node:test` + Bun e2e + jsdom。不新增依賴。

**Spec:** `docs/design/specs/2026-08-20-empty-window-design.md`

## Global Constraints

- 外掛殼行為不變。`corePurity` / `shellPurity` / sample-novel hash 保持綠。
- 不按 `host.name` 分支。不給 agent 開放 `listHostDir`。
- `listDir`（工程內）與 `listHostDir`（本機絕對路徑）分開。
- 熱換順序：未儲存 → 停生成 → `closeDatabase` → 停 watcher → 再 open。反了會在 Windows 上撞 EBUSY。
- 驗證：改了 TS → `npm run typecheck`；改了 `src/core/**` → `npm test`；改了 `media/src/**` → `npm run test:dom`；改了獨立版服務 → `npm run test:e2e`（需 Bun）。
- 本環境是 bash（WSL）。命令在倉庫根執行。
- commit 字首 `feat` / `refactor` / `test` / `docs` / `chore`，中文正文。

## 提交節奏

| # | 字首 | 主題 |
|---|---|---|
| 1 | `feat` | 協議：工作區生命週期與 `hostDir` |
| 2 | `feat` | CLI `root` 可空 + `window.json` |
| 3 | `feat` | `hostFs` 本機列目錄 / 建資料夾 |
| 4 | `refactor` | 設定推送不依賴 `NovelProject` |
| 5 | `feat` | `FileHost.bind` + `WorkspaceHub` + `server` 熱換 |
| 6 | `test` | 空視窗 e2e |
| 7 | `feat` | 標題欄選單 + Get Started + `no-workspace` |
| 8 | `feat` | 目錄選擇器 UI 與選單動作 |
| 9 | `feat` | 桌面閃屏只負責起服務 |
| 10 | `docs` | README / 殼 README / F5 |

---

### Task 1: 協議擴充套件

**Files:**
- Modify: `src/core/protocol/in.ts`
- Modify: `src/core/protocol/out.ts`
- Modify: `src/core/controller/index.ts`（`dispatch` 空分支）

- [ ] **Step 1: 寫失敗測試不是必須** —— 型別加完 `npm run typecheck` 會紅，直到 `dispatch` 補上 case（若 tsconfig 對 switch 無 exhaustiveness 則不會紅，仍然要補空分支，避免將來加 `assertNever` 時漏）。

- [ ] **Step 2: 在 `in.ts` 的 `InMessage` 聯合上追加**（放在 `promptResult` 之前）：

```ts
  | { type: 'listHostDir'; path: string }
  | { type: 'createHostDir'; parent: string; name: string }
  | { type: 'openFolder'; path: string; mode?: 'replace' | 'add' }
  | { type: 'closeFolder'; id?: string }
  | { type: 'activateWorkspace'; id: string }
  | { type: 'openLogDir' }
```

- [ ] **Step 3: 在 `out.ts` 的 `OutMessage` 聯合上追加**：

```ts
  | {
      type: 'workspaces';
      currentId: string | null;
      items: { id: string; root: string; name: string }[];
    }
  | {
      type: 'hostDir';
      path: string;
      parent?: string;
      entries: { name: string; kind: 'dir' | 'file'; absPath: string }[];
      truncated: number;
      error?: string;
      roots?: boolean;
    }
```

可把 `WorkspaceItem` / `HostDirEntry` 抽成 exported interface，避免兩處手寫。

- [ ] **Step 4: `ChatController.dispatch` 給這六條上行各一個空 `return`**，註釋寫明：獨立版由 Hub 攔下，外掛不會發。不要 toast、不要當錯誤。

- [ ] **Step 5:** `npm run typecheck` 必須零錯誤。`npm test` 應仍全綠（外掛路徑不發這些訊息）。

- [ ] **Step 6: commit**

```
feat: 協議增加工作區生命週期與本機目錄列舉
```

---

### Task 2: CLI `root` 可空 + `window.json`

**Files:**
- Modify: `src/shells/standalone/cli.ts`
- Create: `src/shells/standalone/windowState.ts`
- Create: `tests/unit/shells/cli.test.js`
- Create: `tests/unit/shells/windowState.test.js`
- Modify: `src/shells/standalone/main.ts`（只改型別：允許 `root` 為 undefined；恢復邏輯留到 Task 5 與 server 一起接，避免 main 在 Hub 之前自己綁工程）

**`CliOptions.root`:** 改為 `string | undefined`。位置引數仍 `path.resolve`。不帶位置引數時 **不要** `path.resolve('.')`。`init` 子命令：沒有位置引數時 `root` 仍預設 `path.resolve('.')`（與現在 `novelforge init` 一致）。

實現提示：先掃一遍 argv 得到 `init` 與 `rest`，再決定預設值：

```ts
if (rest.length > 0) root = path.resolve(rest[0]);
else if (init) root = path.resolve('.');
else root = undefined;
```

**`windowState.ts`:** 讀寫函式收可選 `baseDir`，生產不傳則用 `homeDir()`（`src/core/stores.ts`）。測試傳入 `os.tmpdir()` 下的臨時目錄，**禁止寫真實 `~/.novelforge`**。

```ts
export interface WindowState {
  lastOpen: string | null;
  recents: { root: string; name: string; openedAt: number }[];
}

export function readWindowState(baseDir?: string): WindowState;
export function writeWindowState(state: WindowState, baseDir?: string): void;
/** 成功開啟工程：lastOpen = root，recents upsert，上限 20，openedAt 新的在前。 */
export function rememberOpen(root: string, baseDir?: string): WindowState;
/** 關閉資料夾：lastOpen = null，recents 不動。 */
export function rememberClosed(baseDir?: string): WindowState;
```

缺檔案 / JSON 壞掉：返回 `{ lastOpen: null, recents: [] }`，不拋。`lastOpen` 指向的目錄不存在時，`readWindowState` **不要**在讀時修改檔案；由 Hub 啟動時清（Task 5）。

- [ ] **Step 1: 先寫 `tests/unit/shells/cli.test.js`**，用 `loadModule('src/shells/standalone/cli.ts')`。斷言：
  - `[]` → `root === undefined`
  - `['sample-novel']` → `root` 是 resolve 後的絕對路徑
  - `['init']` → `init: true` 且 `root` 是 `path.resolve('.')`
  - `['init', '/tmp/book']` → 該絕對路徑
  - `--port` / `--no-open` / `--verbose` 與無 root 組合仍對

跑：`node --test "tests/unit/shells/cli.test.js"` —— 應失敗。

- [ ] **Step 2: 改 `cli.ts`，再跑同一條，應通過。**

- [ ] **Step 3: 寫 `windowState.test.js`**（臨時目錄）：預設狀態、rememberOpen upsert 與上限 20、rememberClosed 清 lastOpen 留 recents、壞 JSON 降級。先失敗再實現。

- [ ] **Step 4:** `npm run typecheck`。`main.ts` 裡 `opts.root` 可能 undefined：`init` 分支仍要求 root（init 時永遠有）；非 init 分支暫時把 `startServer({ root: opts.root ?? placeholder })` **不要**用 placeholder。Task 5 才會讓 `startServer` 接受可選 root。本 Task 若 `main.ts` 因此編不過，給 `startServer` 的 `root` 先改成 `root?: string` 但行為仍是「undefined 就先不 `NovelProject.open`」——若這會把 Task 5 的一半提前，則本 Task **只改 cli + windowState + 測試**，`main.ts` 用 `opts.root!` 或 `opts.root ?? process.cwd()` 先不動，在 Task 5 再改。選後者：本 Task 不改 `server.ts`/`main.ts` 行為。

- [ ] **Step 5: commit**

```
feat: CLI 允許無工程目錄啟動，並記下 window.json
```

（CLI 解析已可空；真正無 root 起服務在 Task 5。）

---

### Task 3: `hostFs` 本機列目錄

**Files:**
- Create: `src/shells/standalone/hostFs.ts`
- Create: `tests/unit/shells/hostFs.test.js`

隱藏名 **import** `HIDDEN_DIR_NAMES` 與 `MAX_DIR_ENTRIES`（`src/core/files/fileTree.ts`），不要複製一份。失敗不拋，帶 `error`。不返回檔案內容（entries 只有 `name` / `kind` / `absPath`）。

```ts
export interface HostDirListing {
  path: string;
  parent?: string;
  entries: { name: string; kind: 'dir' | 'file'; absPath: string }[];
  truncated: number;
  error?: string;
  roots?: boolean;
}

export async function listHostDir(absPath: string): Promise<HostDirListing>;
export async function createHostDir(parent: string, name: string): Promise<HostDirListing>;
```

規則（與 spec 一致）：

- Unix：`''` 或 `'/'` → 列舉 `/`，無 `parent`。其它路徑 `parent` 為 `path.dirname`，根的 dirname 仍是 `/` 時不要設 parent（或與 path 相同則視為無 parent）。開啟選擇器的「預設落點」是前端的事，本函式只認傳入路徑。
- Windows：`''` → 磁碟機代號列表，`roots: true`，無 parent。磁碟機代號路徑（`C:\`）的 parent 不設（前端據此回到磁碟機代號層，再發 `path: ''`）。
- `createHostDir`：`name` 含 `/` `\` `..` 或為空 → 返回帶 error 的 listing，不 mkdir。已存在 → error，不覆蓋。成功則 `mkdir` 後 `listHostDir(parent)`。
- symlink：`stat` 後按目錄/檔案列入。
- 排序：目錄在前、檔案在後，名稱 `localeCompare(..., 'zh-Hans-CN', { numeric: true })`（與 `fileTree` 一致）。

- [ ] **Step 1: 測試用臨時目錄樹**（含子目錄、檔案、`.git`、`node_modules`、點開頭目錄）。斷言：隱藏兩個名字、點開頭可見、截斷欄位、不存在目錄有 error、`createHostDir` 拒絕 `..` 與同名、成功後能列到新目錄。Unix 上 `listHostDir('/')` 無 parent。

- [ ] **Step 2: 實現到測試綠。** `npm run typecheck`。

- [ ] **Step 3: commit**

```
feat: 獨立版本機目錄列舉與新建資料夾
```

---

### Task 4: 設定推送不依賴 `NovelProject`

**Files:**
- Modify: `src/core/controller/settings.ts`
- Modify: `src/core/controller/index.ts`（若只轉調則可能不用改）

把 `pushSettings` / `saveSettings` 裡拼 payload、寫盤的部分抽成：

```ts
export async function pushSettingsTo(
  post: (msg: OutMessage) => void,
  ack?: 'saved' | 'rejected'
): Promise<void>;

export async function saveSettingsFrom(
  s: SettingsPayload,
  post: (msg: OutMessage) => void,
  afterSave?: () => Promise<void>  // 有工程時 controller 傳 () => c.pushState()
): Promise<void>;
```

`pushSettings(c)` 變成 `pushSettingsTo(c.post.bind(c), ack)`。`saveSettings(c, s)` 在成功後仍 `c.pushState()` + toast。行為與現在逐位元組一致。

空視窗的 Hub（Task 5）調 `pushSettingsTo(broadcast)`，`afterSave` 不傳。

- [ ] **Step 1: 抽出函式，舊包裝保留。`npm test` 全綠（設定相關整合測不能紅）。**

- [ ] **Step 2: commit**

```
refactor: 設定讀寫改為可在無工程時呼叫
```

---

### Task 5: FileHost.bind + WorkspaceHub + server 熱換

**Files:**
- Modify: `src/shells/standalone/fileHost.ts`
- Create: `src/shells/standalone/workspaceHub.ts`
- Modify: `src/shells/standalone/server.ts`
- Modify: `src/shells/standalone/main.ts`
- Create: `tests/unit/shells/workspaceHub.test.js`（能單測的部分：id 用 realpath、add 拒絕、同路徑啟用；需要臨時目錄 + 假 broadcast）

**FileHost：** `root` 改為可變。`bind(root: string)` 開啟 `NovelProject`、記下 root。`unbind()` 清空 root/project。`watch` 仍返回 Disposable，由 Hub 儲存。`openInEditor` 在 root 為空時發 `editorError`（或 no-op toast），不要 `resolve('.', rel)`。

**WorkspaceHub** 構造吃 `{ broadcast, host: FileHost }`。

```ts
open(absPath: string, mode?: 'replace' | 'add'): Promise<void>
close(id?: string): Promise<void>
activate(id: string): void
snapshot(): { currentId: string | null; items: { id: string; root: string; name: string }[] }
handle(msg: InMessage): Promise<boolean>  // true = 已處理，server 不要再交給 controller
```

`open`：

1. `realpath` + `stat` 必須是目錄，否則 toast，Hub 不變。
2. `mode === 'add'` 且已有當前項 → toast「本版本只支援一個工作區」，return。
3. 已有相同 id → activate，推 `workspaces`，return。
4. 已有不同項（replace）：`current.abort` 停生成 → `controller.dispose()`（內部 `closeDatabase`）→ `watchDisposable.dispose()` → 再綁新的。
5. `NovelProject.open` → `host.bind` → `new ChatController(project)` → `attach` 現有 ViewHost → `host.watch` → `rememberOpen` → 推 `workspaces` → `resendFullState`。
6. 中途失敗：能回舊工程則回；舊的已 dispose 則 `unbind` + 空 `workspaces` + toast。

`close`：dispose 當前 → `host.unbind` → `rememberClosed` → 推空 `workspaces`。沒有當前項則 no-op。

`handle` 吃掉：`listHostDir` / `createHostDir` / `openFolder` / `closeFolder` / `activateWorkspace` / `openLogDir` / `saveSettings` / `setApiKey` / `clearApiKey` / `testConnection` / `ready`（先推 `workspaces`；有啟用項再 `controller.resendFullState()`，沒有則 `pushSettingsTo` + 記憶體 logs + 空 tasks，**不發假 init**）。

`openLogDir`：`openWithSystem(homeDir())`。

`ready` 無工程：不要 `init` / `project` / `session`。

**server.ts：**

- `ServeOptions.root?: string`
- 不再在模組頂層 `NovelProject.open`。建 `FileHost`（root 可先空）、`initHost`、`WorkspaceHub`。
- 若 `opts.root` 有值 → `hub.open(opts.root)`。若無 → 讀 `readWindowState()`，`lastOpen` 存在且 `fs.existsSync` 是目錄則 `hub.open(lastOpen)`，否則清掉壞 `lastOpen`（`writeWindowState`）並保持空。
- WS `message`：`promptResult` → PromptHub；`hub.handle(msg)` 若 true 結束；否則 `hub.activeController()?.handle(msg)`，沒有則 toast「請先開啟資料夾」。
- WS `open`：與 `ready` 相同的補推（有工程 `workspaces`+`resendFullState`，無則空 `workspaces`+settings）。
- 頁面 `standalonePage()` **不要**再把工程名寫死；改為無參或只傳產品名。標題由前端跟 `workspaces` 更新（Task 7）。本 Task 可以暫時仍 `standalonePage(hub.snapshot().items[0]?.root)`，Task 7 再改頁面。優先本 Task 就改成不寫死，避免熱換後首屏 HTML 過期。
- 啟動日誌：無工程時打「未開啟工程」而不是一個假路徑。

**main.ts：** 非 init：`startServer({ root: opts.root, ... })`。無 root 時不要 `existsSync(project.json)` 那兩行提示（沒有目錄可查）。有 root 時保留「還不是小說工程」提示。

- [ ] **Step 1: Hub 單測**（臨時目錄當工程：至少建一個空目錄即可 `NovelProject.open`）。開啟、再 open 同一 realpath 不建立第二份、replace 會 dispose、add 不改變當前 id、close 後 snapshot 為空。

- [ ] **Step 2: 接線 server/main。`npm run typecheck`。現有 `npm run test:e2e` 必須仍綠**（它們傳 `root`）。

- [ ] **Step 3: commit**

```
feat: 獨立版用 WorkspaceHub 熱換工程目錄
```

---

### Task 6: 空視窗 e2e

**Files:**
- Modify: `tests/e2e/standalone/server.test.js`（**同一檔案末尾**加一節，不要新檔案，避免 bun test 並行把 `initHost` 單例打串）

新埠例如 `EMPTY_PORT = 3997`。`before` 裡 `startServer({ port: EMPTY_PORT })` **不傳 root**（或 `root: undefined`）。這一節必須放在 3999/3998 的 `after` 都跑完之後——現有結構是兩個 describe 順序執行，把空視窗做成**第三個** `describe('空視窗', ...)`。

斷言：

1. `ready` 後收到 `workspaces` 且 `currentId === null`，且在繫結前**沒有** `type === 'init'`（或 init 的 `state.initialized` 不得冒充某個工程——正確是根本沒有 init）。
2. `listHostDir { path: os.homedir() }` 回 `hostDir`，`entries` 是陣列，條目沒有正文。
3. `openFolder { path: sample-novel 絕對路徑 }` 後出現 `workspaces.currentId` 非空，且隨後有 `init` 或 `state`。
4. `closeFolder` 後 `currentId === null`。
5. `openFolder { mode: 'add' }` 在已開啟時不把 currentId 換成第二份（仍是那一個或 toast；以 snapshot 只有 1 項為準）。

- [ ] **Step 1: 寫斷言，跑 `npm run test:e2e`。** Task 5 已實現則應綠；若 ready 仍誤發 init，修 server。

- [ ] **Step 2: commit**

```
test: 獨立版空視窗開啟與關閉工程的 e2e
```

---

### Task 7: 標題欄、Get Started、`no-workspace`

**Files:**
- Modify: `src/shells/standalone/page.ts`（`.wb-title` 結構；`data-version`）
- Modify: `media/src/css/standalone/workbench.css`
- Create: `media/src/css/standalone/menubar.css`、`welcome.css`（或合併進 workbench.css，避免碎片也行）
- Modify: `media/src/css/standalone.css` 若有新 @import
- Create: `media/src/view/menubar.ts`
- Create: `media/src/view/welcome.ts`（或 `workspaceUi.ts` 同時管 body class 與歡迎頁）
- Modify: `media/src/view/index.ts`（收到 `workspaces` 時更新）
- Modify: `media/src/view/state.ts` / composer：無工程禁用輸入
- Modify: `tests/helpers/dom.js`：`standaloneBodyHtml()` 現傳 `standalonePage('/tmp/示例工程')`，改為 `standalonePage()` 仍能抽 body；選單節點必須在
- Create: `tests/dom/standalone/menubar.test.js`、`welcome.test.js`

**標題欄 DOM（VS Code 自定義標題欄）：**

```html
<header class="wb-title" id="wbTitle" data-version="0.1.0">
  <span class="wb-logo">…</span>
  <nav class="wb-menubar" id="wbMenubar">
    <button class="wb-menu-btn" data-menu="file">File</button>
    …
  </nav>
  <span class="wb-title-text" id="wbTitleText">Novelwarden</span>
  <span class="spacer"></span>
  <button class="icon-btn" id="wbEditorToggle" …>
  <button class="icon-btn" id="wbThemeBtn" …>
</header>
```

`data-version` 從 `package.json` 讀（page.ts 用 `createRequire` 或寫死再在構建裡替換——最簡單：`import pkg from '../../../package.json' assert` 可能礙 tsconfig，改為在 `page.ts` 頂部 `const VERSION = '0.1.0'` 並從 package.json 複製會漂。用 `readFileSync` 讀倉庫/cwd 的 package.json，失敗則 `'0.0.0'`。）

選單欄互動：點選開啟下拉；已開啟時 hover 隔壁切換；Esc / 點外面關閉。項可 `disabled`。子選單「最近開啟」。**本 Task 選單項可以先只有結構 + 開啟/關閉資料夾佔位 `data-action`，真正發訊息在 Task 8 接滿。** 但 File 開啟資料夾 / 關閉資料夾 / 最近開啟 與 Help 歡迎 / 關於 可以先接到 `welcome.ts` 已有的函式上，避免空按鈕。

Get Started：放在 `#wbEditor .ed-stage` 裡新節點 `#nfWelcome`（與 `#edWelcome` 並列）。無工程顯示 `#nfWelcome`，隱藏 `#edWelcome` 與 textarea。有工程無檔案：現有 `#edWelcome`。Help→歡迎：有工程時顯示 `#nfWelcome` 但不關標籤。

`body.no-workspace`：對話/工程/檔案/歷史短空態。composer 的 textarea `disabled`。設定頁仍可點。

前端 `store` 記下 `currentId` 與 `recents`（recents 需要下行：`workspaces` 不含 recents）。**補一條 OutMessage 或把 recents 放進 `workspaces`。** Spec 的 `workspaces` 只有 items。Recent 列表來自 `window.json`，Hub 在每次 `workspaces` 推送時**額外**帶 recents：

為免再改一輪協議，本 Task **把 recents 加進 `workspaces`**：

```ts
{ type: 'workspaces'; currentId; items; recents: { root: string; name: string }[] }
```

這是對 spec 的小修正（前端否則無法畫 Recent）。Task 1 若已合入，在此 Task 補欄位，e2e 斷言放寬為「有 recents 陣列」。**不要另造 `recents` 訊息。**

- [ ] **Step 1: 改協議 `workspaces` 加 `recents`，Hub 推送時帶上 `readWindowState().recents`。e2e 不因多欄位紅。**

- [ ] **Step 2: 改 page.ts + CSS。DOM 測試：standalone body 有 `#wbMenubar`、三個 `.wb-menu-btn`、`#nfWelcome`。**

- [ ] **Step 3: `menubar.ts` / `welcome.ts` 能力探測：沒有 `#wbMenubar` 直接 return（外掛）。`index.ts` 處理 `workspaces`：toggle `no-workspace`、更新標題、渲染 Recent。**

- [ ] **Step 4:** `npm run typecheck` && `npm run test:dom`。

- [ ] **Step 5: commit**

```
feat: 獨立版標題欄選單與空視窗歡迎頁
```

---

### Task 8: 目錄選擇器與選單動作

**Files:**
- Create: `media/src/view/folderPicker.ts`
- Create: `media/src/css/standalone/picker.css`（或併入 menubar.css）
- Modify: `media/src/view/menubar.ts`（填滿 spec 第 2.2 節表）
- Modify: `media/src/editor/`：查詢條（下一個/上一個，僅當前 textarea）
- Modify: `tests/dom/standalone/` 選擇器與選單啟用

選擇器：模態、路徑框、列表、`..`、確定=當前路徑（資料夾模式）、檔案模式鎖工程根並走 `listDir`（把 `dirListings` 轉成選擇器列表，absPath 用工程根拼接）。`listHostDir` / `hostDir` 驅動資料夾模式。新建資料夾發 `createHostDir`，用返回的 `hostDir` 重新整理。

未儲存確認：開啟/關閉資料夾前，若 editor 有 dirty，複用現有關標籤確認。

新建檔案：`input` 相對路徑 → 發一條需要後端寫空檔案的訊息。**不要新協議也能做**：有工程時 `saveFile` 對不存在路徑是否允許？`writeFileFromEditor` 走 workspace，通常要求檔案存在。應加 `createFile { relPath }` 或 Hub 在有工程時 `workspace.write` 空內容。為避免含糊：**新增 `InMessage` `{ type: 'createFile'; relPath: string }`**，Hub 有啟用工程才處理，經 `Workspace.write` 寫空字串，已存在 toast 拒絕。外掛 dispatch 空分支。這是 spec「經 workspace 閘道器寫空檔案」的落點。

另存為：問新相對路徑，讀當前編輯器文字 `saveFile` 到新路徑（若 saveFile 不能建立，則先 `createFile` 再 save）。以 `Workspace.write` 一次寫滿內容為準，可讓 `createFile` 收可選 `text`。

查詢：`#edFind` 窄條，Enter 下一個，Shift+Enter 上一個，高亮用 textarea 選區即可，不做工作區搜尋。

選單啟用表按 spec。Edit 項：焦點在 input/textarea 時啟用，走 `editor/clipboard.ts` 的 execCommand。

退出：`window.close()`。

使用說明：按 spec 2.2.1。需要 Hub 處理 `{ type: 'openReadme' }` 或前端自己 `openEditor('README.md')` 若工程裡有。無工程發 `openReadme`，Hub 找倉庫根 README（從 `import.meta.dir` 上溯找 `package.json`+`README.md`），有則 `openWithSystem`，沒有 toast。**加 `openReadme` 空視窗訊息**，與 `openLogDir` 同類。

關於：前端彈層讀 `#wbTitle[data-version]` 與當前工程路徑。

- [ ] **Step 1: 協議補 `createFile` / `openReadme`，controller 空分支，Hub 實現。**

- [ ] **Step 2: 選擇器 DOM 測試：發 hostDir → 列出名字；點目錄發出新的 listHostDir；確定發出 openFolder。**

- [ ] **Step 3: 選單動作接到 post()。`npm run typecheck` && `npm run test:dom` && `npm run test:e2e`。**

- [ ] **Step 4: commit**

```
feat: 遠端風目錄選擇器與 File/Edit/Help 動作
```

---

### Task 9: 桌面殼

**Files:**
- Modify: `src/shells/desktop/src/main.rs`
- Modify: `src/shells/desktop/src/sidecar.rs`（`start` 不再收 `root`，args 只有 `--no-open --port`）
- Modify: `src/shells/desktop/src/project.rs`（啟動時把 `shell.json` 的 `last_project` 遷到 sidecar 會讀的 `window.json` **做不到**：window.json 在使用者 home 的 `.novelforge`，Rust 可以寫 `dirs::home_dir()/.novelforge/window.json`。遷一次：若 window.json 無 lastOpen 且 shell.json 有 last_project 且目錄存在，寫入 lastOpen。）
- Modify: `src/shells/desktop/ui/splash.html`、`splash.js`：刪除 picking 態與選目錄按鈕；failed 只留重試/檢視日誌
- 去掉 `build_menu` 的 File/Help，或 `menu(None)` / 空選單，避免與 HTML 選單重複。保留系統視窗按鈕。

`launch` 不再 `choose_then_launch`。`setup` 直接 `sidecar::start(app)`。`select_project` 命令可刪。失敗 retry 只再起 sidecar，不傳路徑。

- [ ] **Step 1: 改 Rust 與 splash，保證能編**（本機有 Rust 則 `cargo check --manifest-path src/shells/desktop/Cargo.toml`）。沒有工具鏈就只改原始碼，不假裝編過。

- [ ] **Step 2: commit**

```
feat: 桌面殼無工程路徑起 sidecar，閃屏不再選目錄
```

---

### Task 10: 文件與 F5

**Files:**
- `README.md`：去掉「預設當前目錄」；寫明 `novelforge` 空視窗、`novelforge [dir]` 開啟
- `src/shells/standalone/README.md`、`src/shells/desktop/README.md`：熱換、閃屏只 starting/failed、不再傳工程路徑
- `.vscode/launch.json` + `.vscode/README.md`：新增「起獨立 Web 版（空視窗）」
- `AGENTS.md` 模組地圖如有新檔案可補一行 workspaceHub/hostFs
- `src/shells/standalone/page.ts` 註釋

- [ ] **Step 1: 改文件。**

- [ ] **Step 2: commit**

```
docs: 獨立版可空視窗啟動的使用說明
```

---

## 完成定義

- `novelforge` 不帶目錄能開啟網頁，見 Get Started，File 能開啟資料夾。
- `novelforge sample-novel` 行為與現在一致（直接進工程）。
- 關閉資料夾回到歡迎頁；再啟動不自動開啟。
- 開啟資料夾不重啟服務（桌面不 kill sidecar）。
- `mode: 'add'` toast 且仍只有一個工作區。
- 外掛、`npm test`、sample-novel hash 綠。
- 桌面無原生 File/Help 重複選單。

## 給接手 agent 的提示詞

```
按 docs/design/plans/2026-08-20-empty-window.md 在 git worktree 裡實施，分支 feat/empty-window。
先讀 docs/design/specs/2026-08-20-empty-window-design.md 與 AGENTS.md。
從 Task 1 做到 Task 10，每個 Task 測過再 commit。不要在使用者的 main 工作區改程式碼。
不要給 agent 開放 listHostDir，不要改外掛空視窗，不要把 listDir 與 listHostDir 合成一個。
```
