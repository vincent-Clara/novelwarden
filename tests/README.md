# tests — 自動化測試

不依賴 VS Code、也不需要真實 API Key。執行器是 Node 自帶的 **`node:test`**（零新增依賴），
獨立版服務那一組由 **Bun** 跑同一套 `node:test` API。

```bash
npm test                 # typecheck + 全部
npm run test:unit        # 只跑快的（毫秒級）
npm run test:integration
npm run test:dom         # 會先構建 dist/media
npm run test:contract
npm run test:e2e         # 需要 Bun
npm run test:verbose     # 出問題時看 node 原樣輸出
```

單跑一個檔案或一條用例：

```bash
node --test tests/unit/model/markdown.test.js
node --test --test-name-pattern="stripH1" "tests/unit/**/*.test.js"
```

> **glob 必須帶引號**——`node --test <目錄>` 在當前 Node 版本會把目錄當成模組入口報
> `MODULE_NOT_FOUND`。引號讓 glob 交給 node 自己展開，PowerShell 與 sh 下行為一致。

## 輸出：只報失敗

四組 `node --test` 都走 `reporters/quiet.mjs`——**只吐失敗與一行總計**。全綠時輸出就一行：

```
✓ 通過 2197，2197 條，30.5s
```

有失敗時每條三行：位置、用例全名（含祖先套件）、期望與實際。

```
✗ tests/unit/model/markdown.test.js:84
  markdown.ts › H1 處理 › stripH1 去掉標題
  實際 "\n雨下了三天。"
  期望 "雨下了三天。"（strictEqual）
```

預設 reporter 每條失敗帶十幾行 YAML（`duration_ms`、`location`、完整 stack），全量跑一輪
接近 400 KB；換掉之後全綠 36 位元組，一條失敗也就百來位元組。**人往回翻不動、塞進 agent
上下文更是純浪費**，這是換掉它的唯一理由——判定邏輯一點沒動，退出碼照舊。

想看原樣輸出用 `npm run test:verbose`。三個開關按需加：

| 環境變數 | 作用 |
|---|---|
| `NF_TEST_LOGS=1` | 連帶列印失敗檔案裡的 `console` 輸出（預設丟棄） |
| `NF_TEST_STACK=1` | 每條失敗附一行倉庫內的呼叫位置 |
| `NF_TEST_MAX_FAILS=n` | 最多展開幾條，超出只計數（預設 25，`0` 表示不限） |

兩處刻意的取捨：**套件層的失敗不報**（`failureType: 'subtestsFailed'` 只是子用例失敗的回聲，
葉子那條已經報過），所以總計裡的失敗數是**葉子數**，與展開的條數對得上，不等於
`counts.failed`；**兩個長字串只報第一處分歧**的位置與前後文，不把兩份全文都印出來。

e2e 那組歸 Bun 管，`bun test` 沒有自定義 reporter 的介面——但它本來就只有一千多位元組，不用管。

## 按測試型別分目錄

| 目錄 | 跑什麼 | 依賴 |
|---|---|---|
| `unit/` | 純函式，零 I/O | 無 |
| `integration/` | 真臨時工程 + 假模型，跨模組編排 | 臨時目錄、SQLite |
| `dom/` | jsdom 跑 `dist/media/` 的前端產物 | jsdom、前端構建產物 |
| `e2e/` | 真 HTTP/WS 服務 | Bun |
| `contract/` | 架構不變式與夾具自洽 | 無 |

`helpers/` 放公共 harness，不是用例（不匹配 `*.test.js`，不會被收集）。

## 覆蓋範圍

每個測試檔案開頭的註釋寫了它測什麼、為什麼（多數帶一張「斷言 | 為什麼」表），這裡不再逐檔案列一遍。
測試按被測模組分子目錄（`unit/model/`、`integration/features/`、`dom/view/`……），找相關的測試按檔名找，
或 `grep -rl "关键字" tests/`。

## helpers/

| 模組 | 提供 |
|---|---|
| `load.js` | `loadModule(relPath)` / `loadBundle(entries)`——用 esbuild 把 **TS 原始碼** bundle 成 CJS 後 require，結果帶快取。**要用 Host 的模組必須打進同一個 bundle**：分開 bundle 會讓每份產物各帶一份 `host.ts` 的模組級狀態，`initHost` 只作用於其中一份 |
| `tmpProject.js` | `makeTempProject()`（與作者點「初始化」同一條路：`Workspace.initializeProject`，固定目錄 + 經閘道器寫空模板 + manifest；閘道器單獨 bundle 一份，工程例項仍由呼叫方的 `projectMod` 造）、`copyFixture()`（需要寫盤時複製 `sample-novel/`）、`rel/write/read/has/remove` |
| `fakeHost.js` | 可程式設計假宿主：input/confirm/pick/reviewReplace 按**佇列**取答案，沒排隊就當使用者取消；錄製 toasts/confirms/reviewed/opened，並能觀察 `reviewReplace` 的併發峰值。`reviewReplace` 的回答也可以是一個函式（按這一次的兩個版本算，比如交回 `{ merged }`），`reviewed` 裡記著這一次有沒有請求合併 |
| `fakeProvider.js` | 假模型，一律經 `registerProviderFactory` 且 `kind: 'vscode-lm'`——那是唯一不碰 SecretStore 的路徑（其餘 kind 會去要 API Key）。支援應答佇列、函式應答、按模型注入 `unavailable`/`fail`/`cancel`、併發峰值觀察；應答可以是 `{ text, stop, reasoning, chunks }`（測續寫要靠 `stop: 'maxTokens'`），`filler(n, seed)` 造恰好 n 字、不同 seed 之間無公共 8-gram 的正文 |
| `vscodeStub.js` | 四檔能力的 `vscode` 模組樁（`minimal`/`config`/`workspace`/`full`），`full` 帶真實檔案系統支撐的 `workspace.fs`。**返回 `restore()`，請掛到 `after()`** |
| `teardown.js` | `cleanup(dir, db)`——**先關庫再刪目錄**：SQLite 連線開著時 Windows 上刪不掉 `.novelwarden/novelwarden.db`，臨時工程會全留在 temp 裡 |
| `dom.js` | jsdom 掛載：從 `webviewHtml.ts` / `html.ts` 摳 `<body>`、`window.eval` 載入 `dist/media/*.js`、`acquireVsCodeApi` 樁與訊息泵、檢視資料的夾具工廠；`mirrorLayout` 這個補丁給高亮映象層一份可預期的假排版（量位置那一份映象裡標記的 `offsetTop` 按換行數 × 行高算、textarea 的視口高固定，尺寸在 `MIRROR_LAYOUT`），測「滾動按量出來的位置走」用；`fakeTimers` 把視窗裡的定時器換成手撥的（`window.__clock.tick(ms)`），測停筆 2 秒、10 秒沒回音、去抖不必真等；編輯器頁內對話方塊的 `dialog()` / `dialogButtons()` / `answer(label)`（點了按鈕再等 Promise 後續跑完）與 `flush()`；`sampleChapterIndex(plots)` 從工程樹樣本投影出 `chapterIndex` 訊息的那幾個欄位；`mount({ url })` 給頁面一個地址——預設的 `about:blank` 是不透明的源，`localStorage` 一碰就拋，要測「按工程記進 localStorage」時給 `http://localhost/?project=…`；`mount({ storage })` 在跑指令碼之前把這幾項寫進 localStorage（沒給 `url` 時掛在 `http://localhost/` 上），測重新整理恢復用；`mac` 讓 `navigator.platform` 是 `MacIntel`（快捷鍵按 ⌘ / ⌥ 寫）；`previewLayout` 給預覽一份假排版（帶 `data-line` 的一塊，頂 = 第幾行 × `PREVIEW_LAYOUT.line`、隨預覽的 `scrollTop` 上移，高 = 佔幾行 × 同一個數），測切換時滾動對應用；`narrow` 這個補丁給一份 `matchMedia`，只有 `max-width: 900px` 那條成立（窄屏上的行為，指令碼裝載時就要問） |
| `ws.js` | e2e 的 WebSocket 客戶端（收件箱 + `waitFor(match, label)` 超時） |
| `outline.js` | `outlineOf(to, { from, text, titles, heading })`：一章一條的情節大綱夾具（舊格式的區間分節不認了，要覆蓋到第 20 章就得有第 1–20 章各一條）；`text: { 1: '原句' }` 把被斷言引用的那句放進對應章。`writeOutline(t, text)`：情節大綱沒有檔案（各章細綱梗概的彙總），照一份大綱寫各章細綱——沒有細綱的建只有梗概的空殼（有正文落正文的映象），已有的只換「梗概」一節 |

## 約定

- **一條斷言一個 `test()`**，名字用中文寫清「驗的是什麼行為」——失敗時那一行就是報告。
- 用 `assert.equal` / `deepEqual` 而不是 `assert.ok(a === b)`：前者失敗時會列印實際值與期望值。
- 同一檔案內的用例**預設序列**，多步流程（建檔案 → 改名 → 斷言）照原樣寫即可。
- 每個檔案一個獨立程序，`Module._load` 打的 `vscode` 樁與 `host.ts` 的模組級狀態天然隔離。
- 臨時目錄一律走 `helpers/tmpProject.js`，收尾一律走 `helpers/teardown.js`——**碰過工程庫的必須傳 `db` 模組**。
- `sample-novel/` **只讀**（`contract/sampleNovel.test.js` 對它有 hash 斷言）；要寫盤的用 `copyFixture()`。

改動 `src/core/` 後務必跑一遍 `npm test`——這是 CI 之外唯一的迴歸防線。
