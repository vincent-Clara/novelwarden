# desktop — 桌面殼（Windows / Linux）

第三個殼。前兩個是 VS Code 外掛（[vscode](../vscode/README.md)）與獨立 Web 服務
（[standalone](../standalone/README.md)），這一個把**獨立 Web 服務原封不動地裝進一個桌面視窗**。

## 它是一層純殼

`core/` 與 `media/` 一行都沒有為它改過（除了它自己搬進 `src/shells/` 時那次改路徑）。殼只做三件事：

1. 起 sidecar —— 就是 `npm run dist` 那個單檔案可執行，只換了個檔名。**不傳工程路徑**
2. 等它就緒，把視窗從本地 `ui/splash.html` 導航到 `http://127.0.0.1:PORT/`
3. 退出時把 sidecar 收掉

上次開啟的工程由 sidecar 讀 `~/.novelwarden/window.json` 恢復，與瀏覽器裡跑 `novelwarden` 同一條路。開啟/關閉資料夾不 kill、不重啟 sidecar。舊桌面記憶 `<app_config_dir>/shell.json` 只在 `window.json` 還不存在時遷一次。

**所以桌面版沒有任何功能是"適配"出來的。** sidecar 是同一臺機器上的普通程序，
`fs.watch`、`bun:sqlite`、`openExternal` 喚起系統程式全部照舊工作。使用者看不到服務的存在，
但架構上它還在那兒——這也是 web 模式一行不改就能繼續跑的原因。

**這個目錄本身就是 Tauri 工程根**（`tauri.conf.json` 直接放在這裡，不再套一層 `src-tauri/`）。
`npm run app:dev` / `app:build` 會先 `cd` 進來再調 CLI——Tauri 認「cwd 或 cwd/src-tauri 下的
tauri.conf.json」，站在這裡是最穩的那條發現路徑。CI 裡對應的是 tauri-action 的
`projectPath: src/shells/desktop`。

這層殼之所以能這麼薄，是因為獨立版早就把需要的東西給齊了：`--no-open` 已有、
埠占用會自愈、[server.ts](../standalone/server.ts) 已經往 stdout 打了帶埠的 URL、
`isAllowedOrigin` 天然放行 `http://127.0.0.1:PORT` 的 webview。

## 檔案

| 檔案 | 作用 |
|---|---|
| [src/main.rs](src/main.rs) | 啟動編排、三個 `#[tauri::command]`、退出時收 sidecar。無原生 File/Help 選單 |
| [src/sidecar.rs](src/sidecar.rs) | sidecar 生命週期：預挑埠、spawn（只傳 `--no-open --port`）、等就緒、日誌落盤、kill |
| [src/project.rs](src/project.rs) | 把舊 `shell.json` 的 `last_project` 遷到 `~/.novelwarden/window.json`（只一次） |
| [ui/splash.html](ui/splash.html) + [ui/splash.js](ui/splash.js) | 啟動頁：啟動中 / 失敗（重試、檢視日誌）。不再選目錄 |
| [icons/source.svg](icons/source.svg) | app 圖示原始檔，改了重跑 `npx tauri icon icons/source.svg` |

sidecar 由 [scripts/build-sidecar.js](../../../scripts/build-sidecar.js) 產出到 `binaries/`（不入庫），
由 `tauri.conf.json` 的 `beforeDevCommand` / `beforeBuildCommand` 自動觸發。

## 用法

```bash
npm run app:dev      # 開發執行（會自動先編 sidecar）
npm run app:build    # 出安裝包
npm run sidecar      # 只編當前平臺的 sidecar
npm run sidecar:all  # 連 Windows 的一起編（Bun 交叉編譯）
```

前置：Rust 工具鏈（[rustup](https://rustup.rs)）。Linux 上還需要
`libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev patchelf`。

## 三條不能改的約定

1. **不再把工程路徑傳給 sidecar。** 恢復上次工程、開啟/關閉資料夾全在 sidecar 裡，
   與 `novelwarden` 空視窗同一條路。

2. **退出時必須 kill sidecar。** Windows 上的孤兒程序會佔著埠，還會佔著
   `.novelwarden/novelwarden.db`（[db.ts](../../core/runtime/db.ts) 裡記過這個 EBUSY 坑）。

3. **絕不開 `dangerousRemoteDomainIpcAccess`。** 導航到 `http://127.0.0.1:PORT` 之後
   頁面屬於遠端內容，[capabilities/default.json](capabilities/default.json) 刻意沒有
   `remote` 段，所以它拿不到任何 IPC 許可權。現有前端只用 WebSocket、不碰 Tauri API，
   本來也不需要。

## 已知坑

- **WSL2 裡跑 `npm run app:dev`**：WSLg 能顯示視窗，但 WebKitGTK 常需要
  `WEBKIT_DISABLE_COMPOSITING_MODE=1 npm run app:dev`。
- **Windows 安裝包不能在 Linux 上編**。sidecar 可以（Bun 交叉編譯），Rust 殼不行——
  用 [.github/workflows/app.yml](../../../.github/workflows/app.yml) 的 windows runner，或在
  Windows 上原生構建。
- **Bun 的 `--windows-*` 開關只在 Windows 上編譯時接受**，交叉編譯會直接報錯。
  build-sidecar.js 因此只在原生構建時加它們；少了也無妨，Tauri spawn sidecar 時本來
  就帶 `CREATE_NO_WINDOW`。
- **體積**：sidecar 單檔案 ~95 MB，NSIS 壓縮後約 35~45 MB，AppImage 約 100 MB。
  Tauri 的小體積優勢在純殼方案裡沒有——這是換來"零 core 改動"的代價。
- **未簽名**：Windows 首次執行會有 SmartScreen 警告。
- **啟動多一跳**：spawn + 起服務約 0.5~1.5 秒，splash 頁負責讓這段時間不難看。
- **「檢視 → 全屏」在 Windows 上不是真全屏**：頁面用的是標準 Fullscreen API（能力探測，
  不分是不是桌面殼）。Linux 的 WebKitGTK 自己會把視窗一起全屏；Windows 的 WebView2 只把元素
  撐滿 webview，視窗不變（標題欄、工作列都還在）。要真全屏得在 `main.rs` 裡經 `with_webview`
  拿到 WebView2，接 `ContainsFullScreenElementChanged`、按 `ContainsFullScreenElement` 調
  `window.set_fullscreen()`——頁面是遠端內容、拿不到 IPC（見上面第 3 條），前端做不了這件事。
  還沒做（這臺開發機上編不了 Windows 殼，沒法驗證）；在那之前 Windows 上用「最大化」加專注模式代替。

## 排查

sidecar 的全部 stdout / stderr 都落在 `<app_log_dir>/sidecar.log`（每次啟動截斷重來），
失敗閃屏上的「檢視日誌」開啟它所在的目錄。起不來的時候那是第一站。導航進頁面之後，
幫助 → 開啟日誌目錄開啟的是 `~/.novelwarden/`（配置與 window.json）。

注意這與網頁裡那個「日誌」頁是兩回事：那一頁是 sidecar 內部的業務日誌（還會進
SQLite），這個檔案是**殼看到的程序輸出**——服務壓根沒起來時，只有這裡有線索。
