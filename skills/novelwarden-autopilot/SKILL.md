---
name: novelwarden-autopilot
description: 操作一個已經跑起來的 Novelwarden 獨立版服務（Bun，127.0.0.1 上的 /ws），從一句話把一本小說從頭生成到全部同步：小說配置 → 補齊架構 → 情節大綱 → 批次拆細綱 → 批次寫章（寫完即同步）。使用者說「通過本專案建立一本 xx 小說」「從頭生成一本書」「把這個工程寫完」「接著把剩下的章寫完」時用它。只操作、不審內容。
---

# Novelwarden 自動駕駛

使用者讓你**通過 Novelwarden 本身**生成一本書時，不要去調模型 API、也不要自己寫 Markdown 到工程裡。要做的是：像網頁前端那樣，經 WebSocket 給服務發訊息，讓它自己裝配上下文、調模型、落盤。

指令碼在本 skill 的 `scripts/` 目錄：

- `drv.mjs`：常駐的 WebSocket 驅動。斷線會自動重連。
- `nf.py`：每個階段一個子命令。

兩者之間只經一個**狀態目錄**交換檔案，之後用 `$STATE` 指代它：

| 檔案 | 內容 |
|---|---|
| `cmd.jsonl` | 待發的訊息 |
| `log.txt` | 收發摘要（warn/error 日誌、彈窗、toast、taskDone） |
| `pending.json` | 未答的彈窗與許可權卡片 |
| `tasks.json` | 工程頁長任務的進度 |
| `busy.json` | 對話頁是否在生成 |
| `last-<type>.json` | 最新的 pipeline / workspaces / settings 等快照 |

## 0. 準備

1. **找服務埠**：`netstat -ano | grep LISTEN | grep 127.0.0.1`，看 `bun.exe` 的 PID（`tasklist | grep -i bun`）對應哪個埠。也可以 `curl -s http://127.0.0.1:<port>/` 看到 `<!DOCTYPE html>`。服務埠被佔時會順延，不一定是固定值。
2. **起驅動**（後臺，`run_in_background: true`）：
   ```sh
   node <skill>/scripts/drv.mjs --port <port> --state D:/tmp/nfdrv
   ```
   之後所有 `nf.py` 都帶同一個 `--state`，或設 `NF_STATE`。
3. **看狀態**：`python <skill>/scripts/nf.py --state $STATE status`，確認三件事：
   - **開啟的工程是不是使用者給的那個目錄**。不是就 `send '{"type":"openFolder","path":"D:\\\\tmp\\\\xxx"}'`。
   - **模型**：使用者指定了模型就在每條命令上加 `--model <服务商>/<模型名>`，指令碼每階段先 `selectModel` 一次。`<模型名>` 必須在設定裡存在，看 `last-settings.json` 的 `providers`。
   - **工程頁任務用哪個模型**：設定裡 `tierModels` 三檔都空時，工程頁批次任務沿用 `models`（預設模型列表）。如果使用者要求「全程用某個模型」，而 `models` 或某一檔裡還有別的模型，先**問使用者**要不要改設定，不要自作主張改。
4. Windows 下中文輸出要設 `PYTHONIOENCODING=utf8`。

## 1. 流程（按順序，每步跑完再下一步）

```sh
NF="python <skill>/scripts/nf.py --state $STATE --model newapi/gemini-3-flash-lite"
$NF idea "一句話腦洞……" --chapters 100 --words 3000   # 小說配置（對話頁單步 + 寫入卡片）
$NF settings                                        # 工程頁「補齊架構」：前提 / 角色圖譜 / 世界觀
$NF outline                                         # 情節大綱，每段 20 章，續寫到覆蓋全書
$NF plots                                           # 工程頁「批次拆細綱」第 1–N 章
$NF write                                           # 批次寫章（寫完即同步），一直跑到全書寫完
```

- **耗時**：`write` 最久，gemini-flash 這一檔大約 1 分鐘一章，100 章要一個半小時左右。用 `run_in_background` 跑，重定向到 `$STATE/write.log`，每隔約 10 分鐘 `sleep` 一次看 `tail` 和 `ls chapters | wc -l`。
- **期間要和使用者同步進度**：寫到多少章了、遇到了什麼。

## 2. 每一步實際在做什麼（排障時要懂）

| 階段 | 發的訊息 | 落盤前要答什麼 |
|---|---|---|
| 小說配置 | `send`，payload 為 `stage:'setting'`、`target:{kind:'setting',doc:'config'}`、`setup:{totalChapters,wordsPerChapter}` | 一張 `gate`（`name:'artifact'`），答 `gateResult proceed` |
| 補齊架構 | `projectAction completeSettings` | 一個 `prompt kind:'confirm'`，答 `promptResult`，`value` 是第一顆按鈕上的字（`actions[0]`）；帶 `call` 的那一問不帶 `choice` 就是模型按分檔、詳細度照設定 |
| 情節大綱 | `send`，payload 為 `stage:'outline'`、`target:{kind:'outline'}`、`range:{from,to}` | `gate` |
| 拆細綱 | `projectAction generatePlots`，帶 `range`、`call:{}` | 無（帶 `call` 表示彈窗已經問過：呼叫次數已經報過，`{}` 是模型按分檔、詳細度照設定） |
| 批次寫章 | `projectAction writeManuscripts`，帶 `range`、`call:{}`、`mode:'finalize'`、`review:false` | 可能有一致性預檢的 `confirm`；要補建角色卡時還有一個帶 `call` 的 `confirm` |
| 接著寫 | `chapterAction`，帶 `plotRelPath:'.novelwarden/summaries/<与正文相同的相对路径>.md'`、`action:'continue'` | `gate` |
| 同步 | `projectAction finalizeChapter`，帶 `relPath:'chapters/NNN-….md'` | 無 |

協議的權威定義在倉庫的 `src/core/protocol/in.ts` / `out.ts`。主按鈕的下一步在 `last-pipeline.json` 的 `next` 裡；`nf.py next` 就是「按一下主按鈕」。

## 3. 已知的坑（都已寫進指令碼，改指令碼時別丟）

- **主按鈕不會提前續寫大綱**：大綱只寫第 1–20 章時，主按鈕會直接跳去拆細綱，要等寫到第 21 章才提示續寫。批次拆細綱受大綱覆蓋範圍限制，所以 `outline` 子命令一次把大綱續到全書。情節大綱沒有檔案，是各章細綱「梗概」的彙總：覆蓋到第幾章按 `summaries/` 下梗概非空的最大章號算。
- **批次寫章一次最多 10 章**（`WRITE_BATCH_MAX`），而且會在下面三種情況下提前停。停下的那一章**已落盤但沒同步**：
  - 後面章才登場的人提前出現在這一章。
  - 寫不到目標字數的八成。
  - 重演（開頭與上一章結尾大段重合）。

  `write` 的處理是：先找出沒同步的章；字數不到八成就按一次「接著寫」；然後單章同步；再從下一個缺口起下一批。**不同步就往下寫，後面章節拿不到它的連續性事實，前情也只是寫之前的計劃**。同步與否以服務端為準：正文映象到 `summaries/` 下的那份細綱（相對路徑相同、副檔名 `.md`，如 `summaries/第一卷/003-深处.md`）的 `sourceHash` 等於正文現在的 `contentHash` 才算同步——細綱拆好之後這份檔案就在，不能拿「檔案在不在」來判斷。
- **一致性預檢**：例如「某人已死亡，細綱仍安排出場」。指令碼會選「僅本次忽略，照寫」。這是內容問題，**要記下來寫進最後的報告**：在 `log.txt` 裡 grep `一致性預檢`。
- **服務重啟或本機閃退**：
  - 驅動會自動重連。服務端的批次任務不隨 WS 斷開而停，重連後 `tasks.json` 裡還能看到它。
  - 未答的彈窗在斷線時按取消處理。
  - 重啟 `write` 是安全的：它從磁碟推斷進度，已寫、已同步的都跳過。
  - 但服務重啟那一刻正在跑的「接著寫」可能丟了，那一章會按短稿被同步。事後用 `status` 加字數檢查詢出來：手動 `chapterAction continue`，答 `gate`，再 `finalizeChapter` 一次。
- **字數口徑**：指令碼按去掉空白、frontmatter 之後的字元數估算。服務自己的字數在 `.novelwarden/project.json` 的 `wordCount`，比指令碼算的略低。以服務為準的判定在 `taskDone` 訊息裡。
- **不要 `git add` 使用者的測試工程**。狀態目錄放在工程之外，比如 `D:/tmp/nfdrv`。

## 4. 收尾與報告

1. 收尾檢查：
   - `status`：未同步列表應為空，`next` 為 `None`（全書完成）。
   - 檢查一遍每章字數：最小值、最大值，以及有沒有低於八成的章。
2. 停掉後臺的 `drv.mjs`（TaskStop）。
3. 給使用者報告：
   - **結果**：章數、總字數、所用模型。
   - **逐步操作**：每個階段發了什麼、答了什麼、耗時多少。
   - **自動處理過的停頓**：哪幾章提前登場、哪幾章字數不夠被接著寫。
   - **跳過的一致性預檢原文**。
   - **中斷與恢復**的經過。
   - **指令碼與日誌的位置**。

   使用者說了「不用檢查內容」就不要讀正文去評價質量，但預檢報出的矛盾要如實轉述。
