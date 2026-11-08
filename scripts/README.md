# scripts — 構建與診斷工具

這裡只放構建與診斷指令碼。**自動化測試在 [`tests/`](../tests/README.md)**（`npm test`）。

| 指令碼 | 用途 |
|---|---|
| [build-media.js](build-media.js) | 把 `media/src/` 下的前端原始碼（TS + CSS 片段）用 esbuild 打包成 `dist/media/` 的四個 `.js` 與兩個 `.css`（IIFE，classic script；`dist/` 整個不入庫）。`compile` / `watch` / `embed-media` / `typecheck` / `test:dom` 前都會跑到。**加新產物**要在 `JS_ENTRIES` / `CSS_ENTRIES` 里加一條；在已有產物內部拆模組不必動它。 |
| [embed-media.js](embed-media.js) | 把前端資源 base64 內嵌成 `src/shells/standalone/mediaAssets.ts`（生成檔案，已 gitignore），供 `bun build --compile` 的單檔案可執行使用；**順帶寫進 `PRODUCT_VERSION`**（倉庫根 `package.json` 的版本號，「關於」顯示它——單檔案旁邊沒有 `package.json`，執行時去讀只能讀到 0.0.0）。`.js` / `.css` 從 `dist/media/` 取（構建產物），`icon.svg` 從 `media/` 取（倉庫靜態檔案）。會先跑一次 `build-media`，所以內嵌的永遠不是過期產物。`typecheck` / `test:e2e` / `dist` 前會自動跑。**新增產物後要把它加進這裡的 `built` 陣列。** |
| [embed-skills.js](embed-skills.js) | 把內建寫作技能（`src/core/skills/builtin/<名字>/`，常規的技能目錄）的全部檔案內嵌成 `src/core/skills/builtin/embedded.ts`（生成檔案，已 gitignore），core 從那裡讀——三個殼的產物都是單檔案，執行時讀不到倉庫裡的目錄。換行收成 `\n`、只收 UTF-8 文字；內容沒變不寫、要寫先寫臨時檔案再 rename（node 測試多程序併發調它）。`embed-media` 開頭、`esbuild.js`（compile / watch / package）與 `tests/helpers/load.js` 各調一次，所以 typecheck、測試、各種構建都不用手跑。 |
| [build-sidecar.js](build-sidecar.js) | 把獨立版編譯成**帶 target triple 字尾**的單檔案可執行，落到 `src/shells/desktop/binaries/`，供桌面殼（Tauri）當 sidecar 打包。與 `npm run dist` 同源同產物，只有檔名和落點不同——Tauri 的 `externalBin` 認「同名 + `-<triple>`」這個約定。用法 `npm run sidecar`（當前平臺）/ `npm run sidecar:all`（連 Windows 一起，Bun 交叉編譯）。由 `tauri.conf.json` 的 `beforeDevCommand` / `beforeBuildCommand` 自動觸發，一般不必手動跑。**加平臺**要在 `TARGETS` 里加一行，同時給 CI 的 matrix 加一臺 runner（sidecar 能交叉編譯，Rust 殼不能）。 |
| [build-android-server.js](build-android-server.js) | 把獨立版用 esbuild 打成**node 跑的單檔案**（`server.cjs`，`ws` 一起打進去），給 Android 殼當內建服務端——手機上沒有 Bun，別的出單檔案的路（`bun build --compile`）走不通。先跑 `embed-media`。用法 `node scripts/build-android-server.js <输出文件>`，由 `src/shells/android/scripts/build.sh` 調；`tests/integration/shells/nodeServer.test.js` 也調它的 `bundleServer`（前端資源用佔位，免得並行的測試撞上重建中的 `dist/media`）。 |
| [verify-css.js](verify-css.js) | 比對兩份 CSS 是否等價：規則集合一條不多一條不少，且「同選擇器 + 同屬性」的相對順序沒被改變（那才影響層疊）。拆分或重排 `media/src/css/` 的片段後拿它對著舊產物驗一遍。用法 `node scripts/verify-css.js <旧> <新>`。 |
| [diag-stream.js](diag-stream.js) | 診斷用：對著真實服務商跑一次流式請求，把分塊與解析結果打出來。需要真實 API Key，不進任何自動化流程。 |

> `check-core-purity.js` 已遷去 [`tests/contract/corePurity.test.js`](../tests/contract/corePurity.test.js)——它是一條架構斷言，屬於測試。
> 十九個 `smoke-*.js` 已遷去 `tests/`，按測試型別分目錄，見 [tests/README.md](../tests/README.md)。
