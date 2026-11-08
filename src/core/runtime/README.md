# core/runtime — 可丟棄的執行時設施

日誌、進度、失敗標記、有界併發、SQLite——這些都不是內容，刪掉整個 `.novelwarden/novelwarden.db` 或清空記憶體緩衝，工程本身不受影響，只是丟一些「剛才發生了什麼」的痕跡（AGENTS 第 17 條）。

| 檔案 | 職責 |
|---|---|
| [logger.ts](logger.ts) | 環形緩衝 + sink 轉發；`redact` 脫敏、絕不記 prompt 全文、日誌壞了不帶崩正事 |
| [progress.ts](progress.ts) | `runTask`：長任務的宿主原生進度 + 推給前端的結構化進度（n/N）+ 日誌三件事一次做完。`pausable` 的任務多一個 `stopRequested()`（作者點了「寫完這一項就停」，只在項與項之間停，批次寫章用）；`finish(notice)` 是結束時的那一句（可帶「開啟第 N 章」），controller 訂閱 `onTaskFinished` 推 `taskDone`——給了它就不再另外 `toast` |
| [errorLog.ts](errorLog.ts) | 失敗記在目標身上（工程頁那一行的紅/黃標記），成功必須 `clearFailures` |
| [concurrency.ts](concurrency.ts) | `runPool`：有界併發，`current` 只在一項真正結束時才 +1 |
| [db.ts](db.ts) | 工程內 SQLite（`errors` / `logs` 兩張表），見下 |
| [callScope.ts](callScope.ts) | 「這一次」：作者在調模型之前的確認框上挑的模型與上下文詳細度（`model/callChoice.ts`）。`withCallChoice(choice, fn)` 用 `AsyncLocalStorage.run` 把它掛在這一次的呼叫鏈上，**`readConfig()` 是唯一讀它的地方**（詳細度換掉 `contextDetail`，模型成了 `pinnedModel`）；巢狀時模型整項替換、詳細度沒問就沿用外面那一次；同時跑的兩次互不串。不寫回設定 |

## SQLite 只放痕跡（AGENTS 第 17 條的落點）

內容的唯一真相永遠是 Markdown。庫裡只有失敗記錄與日誌歷史，刪掉 `novelwarden.db` 一個功能都不受影響。三條實現約束：

1. **兩個殼兩個驅動，沒有可選項**：Node（外掛 / Electron）用 `node:sqlite`，Bun（獨立版）用 `bun:sqlite`，彼此的執行時都沒有對方那個內建模組。
2. **模組名必須拼接後 `await import`**，不能寫成字面量——esbuild 的靜態分析會嘗試解析 `bun:sqlite` 並直接構建失敗；拼接讓它看不見,兩條構建路徑都不用配 external。
3. **語句用完必須顯式 finalize**：`bun:sqlite` 的語句持有底層控制代碼，不 finalize 就 `close()` 的話 Windows 上庫檔案仍被佔著（`fs.rmSync` 報 EBUSY，臨時工程清理不掉）；`node:sqlite` 沒有 `finalize`，靠 GC。所以對外只暴露 {@link SqlDatabase} 的 run/all/insertMany——內部「準備 → 執行 → 立刻 finalize」，呼叫方碰不到語句物件也就不可能忘。

**打不開就靜默降級，只 warn 一次**：庫鎖了、盤滿了、驅動缺了，正事（更新角色卡、寫正文）照常，只是這次的失敗記錄/日誌歷史留不下來——SQLite 是增強，不是新的失敗源。
