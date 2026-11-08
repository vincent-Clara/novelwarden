# .vscode — 三個殼的啟動方式

按 `F5` 能起的東西。三個殼（[外掛](../src/shells/vscode/README.md) / [獨立 Web 版](../src/shells/standalone/README.md) /
[桌面 App](../src/shells/desktop/README.md)）各有入口，這裡把它們都擺成一條可點的配置，
省得每次回 README 抄命令。

## 有哪些

除錯下拉框裡按殼分組：

| 配置 | 起的是什麼 | 斷點 |
|---|---|---|
| **執行外掛（示例小說工作區）** | Extension Development Host，自動開啟 `sample-novel/` | ✅ TS 原始碼 |
| **執行外掛（自選工程目錄）** | 同上，但問你要開啟哪個目錄 | ✅ TS 原始碼 |
| **起獨立 Web 版（示例小說工作區）** | `npm run standalone -- sample-novel --verbose` | ❌ 見下 |
| **起獨立 Web 版（空視窗）** | `npm run standalone -- --verbose`（不帶工程目錄） | ❌ |
| **起獨立 Web 版（自選工程目錄）** | 同上，目錄來自輸入框 | ❌ |
| **獨立版 CLI：初始化工程（自選目錄）** | `novelwarden init`，終端問答 | ❌ |
| **跑單檔案可執行（dist/novelwarden）** | 先 `npm run dist`，再跑產物 | ❌ |
| **執行桌面 App（開發模式）** | `npm run app:dev`（Tauri，需 Rust 工具鏈） | ❌ Rust 那半邊見下 |

任務（`Ctrl+Shift+B` 或命令面板「執行任務」）也按殼分：`watch` 是預設構建任務（外掛殼用），
另有前端監聽、內嵌資源、編譯單檔案、編 sidecar、出安裝包，以及五檔測試。

## 只有外掛殼能打斷點，另兩個不能

這不是配置沒寫全，是三條不同的原因，寫清楚免得下次有人來"修"：

- **獨立版跑在 Bun 裡，js-debug 掛不上。** VS Code 的 JS 偵錯程式靠 `node:inspector`
  注入 bootloader，而 Bun 至今沒實現它（[oven-sh/bun#2445](https://github.com/oven-sh/bun/issues/2445)）。
  Bun 自己有一套 WebKit inspector 協議，但那需要它自家的偵錯程式擴充套件。所以這三條
  用的是 `node-terminal`：**它不假裝能除錯**，只是把命令跑在整合終端裡，好處是輸出裡的
  檔案路徑可點、`--verbose` 的日誌直接在眼前。要看服務內部發生了什麼，走網頁的「日誌」頁
  （比斷點還全，它記得住每次模型呼叫與檔案操作）。

- **單檔案可執行是編譯產物，本來就沒有原始碼可停。** 這一條的用途不是除錯，是驗證
  **內嵌資源齊不齊**——`bun build --compile` 出來的東西沒有外部資源可讀，
  某個前端產物漏進 `embed-media.js` 的 `built` 陣列時，只有跑它才會 404
  （`npm run standalone` 從磁碟讀，看不出來）。

- **桌面殼的 Rust 那半邊要 CodeLLDB，這裡刻意沒配。** `npm run app:dev` 由 Tauri CLI
  編譯並啟動 Rust 殼，想在 `src/main.rs` 上停就得讓偵錯程式去 attach 它編出來的
  可執行檔案，那是另一條鏈路（`vadimcn.vscode-lldb` + 手寫 `cargo` 構建配置）。
  而這層殼一共三百來行、只做"起 sidecar / 等就緒 / 導航 / 收屍"，
  它的排查依據是 `<应用日志目录>/sidecar.log`（失敗閃屏上的「檢視日誌」）。
  真要 Rust 斷點，裝 CodeLLDB 後自己加一條 `lldb` 配置，別把它寫進倉庫當預設路徑。
  視窗裡那張**頁面**是獨立版，網頁那半邊照舊用瀏覽器開發者工具（Tauri 視窗右鍵 → 檢查元素）。

## 幾個容易踩的點

- **外掛殼的 `${input:extensionRoot}` 必須給絕對路徑。** 那個引數是交給 VS Code
  「開啟資料夾」的，不經 [cli.ts](../src/shells/standalone/cli.ts) 的 `path.resolve`。
  獨立版「自選工程目錄」的 `${input:projectDir}` 反過來——相對路徑按倉庫根解析，因為 `parseArgs`
  會 resolve。空視窗那條不帶目錄。

- **獨立版走 `npm run standalone` 而不是直接 `bun run src/shells/standalone/main.ts`。**
  npm 指令碼里帶了 `embed-media` 那一步；少了它 `mediaAssets.ts` 根本不存在，頁面全 404。
  README 裡那行裸 `bun run` 是給已經編過一次的人看的。

- **改了 `media/src/` 要重啟獨立版服務。** 資源是啟動時從 `mediaAssets.ts` 讀進記憶體的，
  熱更新不了。改前端時用任務「前端：監聽構建」+ 重啟服務，或者乾脆在外掛殼裡改
  （webview 重新整理就行）。

- **`dist/` 整個不入庫**，所以第一次 clone 下來直接按 F5 會缺東西：外掛殼有
  `preLaunchTask` 兜著，單檔案那條有 `preLaunchTask` 兜著，獨立版靠 npm 指令碼兜著。
  桌面殼靠 `tauri.conf.json` 的 `beforeDevCommand` 兜著。四條都不需要你先手動編。

- **這個目錄已被 `.vscodeignore` 排除**，不會打進 `.vsix`。

## 推薦擴充套件

[extensions.json](extensions.json) 裡只有三個，全是桌面殼需要的：`rust-analyzer`、
`CodeLLDB`（要 Rust 斷點時才用得上）、`tauri-vscode`。只改 TS 的話一個都不用裝。
