# 細綱映象正文的相對路徑（更正 10-17 的平鋪）

> 2026-10-18。單獨一件，在 main 上直接開發。起因：作者在工程頁點分卷裡的章節，打不開細綱（也就是摘要）。

## 出了什麼事

10-17 合併細綱與摘要（[2026-10-17-merge-plots-into-summaries.md](2026-10-17-merge-plots-into-summaries.md)，8b70948）時，細綱的落點沿用了老 `plots/` 的平鋪：`summaries/NNN-标题.md`，只掃 `summaries/` 根下，按章號與正文配對，同時刪掉了「摘要按章節路徑映象」的規則（7bf8ada 為修同號章節互相覆蓋加的）。這一條寫在當時設計要點裡，**沒有列成 ⚑ 讓作者確認**。

後果：分卷的書（`chapters/第一卷/…`）原來的摘要在 `summaries/第一卷/…`，工程頁一份都認不出，點章節名只開正文；對話頁按 target 路徑直接讀（`readPlot` / `resolvePlot`），卻讀得到。兩邊看到的不是同一個東西。

## 作者定的（2026-10-18）

| # | 問題 | 定案 |
|---|---|---|
| 1 | 細綱放哪 | **映象正文在章節根下的相對路徑**，副檔名換成 `.md`：`chapters/第一卷/003-深处.txt` ↔ `summaries/第一卷/003-深处.md`。「無相對路徑是絕對錯的」 |
| 2 | 還沒寫正文的新一章放哪 | **跟上一章放同一個子目錄** |
| 3 | 工程頁裡給正文改名、移動 | 細綱**跟著走**（和草稿一樣） |
| 4 | 合併後定稿在根下多出來的平鋪副本 | 不管，不做向後相容 |

## 規則

- **路徑**：`NovelProject.plotPathForChapter`（正文 → 細綱）、`chapterPathForPlot`（細綱 → 照它寫出來的正文）、`plotMirrorOf`（檔案或整個卷目錄的映象）。正文不在章節根下時退回 `summaries/NNN.md`。
- **掃描與分類**：`listPlots` 遞迴掃 `summaries/`；`kindOfPath` 把各級子目錄裡數字開頭的 `.md` 判成 `plot`。根下的 `global.md` 仍是全書摘要。`parsePlotFileName` 的字首位數與章節一致（1–5 位）。
- **配對**（`NovelProject.plotFor`，`getPlot` / `resolvePlot` / 流水線索引 / 裝配器共用）：
  - 有正文的章：只認正文映象的那一份。作者在外面給正文改了名就是一章新的，舊細綱成了孤兒，不冒認。
  - 還沒有正文的章：按檔名的章號認（計劃）。
  - target 指著孤兒或佔位路徑時，`resolvePlot` 認這一章現在的那一份——對話頁與工程頁看到的必須是同一份。
- **新的一章**：既沒有正文也沒有細綱時，`subdirForNewChapter` 取章號比它小的裡面最大的那一章所在的子目錄（有正文看正文，只有細綱看細綱），`plotPathForNewChapter` / `plotPathOfNo` 據此給落點；`writePlot` 新建時先認呼叫方給的佔位路徑所在的子目錄。
- **寫正文**：`chapterTargetOf` 把正文落在細綱所在的子目錄，檔名沿用細綱的；細綱是還沒起名時建的 `030.md` 而標題已經有了，正文按標題起 `030-<标题>.md`，`Workspace.createChapterAt` 把細綱改名到新正文的映象。
- **寫細綱**（`writePlot`）：有正文就落在正文的映象上，改標題只改 frontmatter；還沒有正文就留在原來那份所在的子目錄，檔名跟著「章號 + 標題」。
- **定稿**（`finalizePlot`）：寫回正文映象的那一份，沒有就在映象位置新建，絕不在根下另建。
- **改名、移動、刪除**：
  - 正文改名、移動（單章或整個卷目錄）：`handlers/chapter.ts` 的 `carryPlot` 把細綱一併搬過去，規矩與草稿相同（目標已有就不動、toast 說出來；移出 `chapters/` 就留在原處）。對話頁目標指著那份細綱的跟著改。
  - 細綱改名（`fileOps.renamePlot`）改的是標題：沒有正文時檔名跟著標題，有正文時檔名不動。正文從不因為細綱改名而改名。
  - 刪正文不刪細綱：它退回這一章的計劃。
- **給模型的說明**（`list`、`generate` 工具與 MCP 說明）：細綱與正文相對路徑相同，正文可以分子目錄。工具文字裡不出現「卷」（`tests/contract/toolText.test.js`）。

## 刪掉的

`NovelProject.plotPathForNo`（按章號拼平鋪路徑）、`kind.ts` 的 `plotRelPathFor`、`views/pipeline.ts` 的 `firstByNo`（細綱按號取第一份）。

## 測試

- 新增 `tests/integration/files/plotFollow.test.js`：正文改名、移動、整卷搬時細綱跟著走，目標已有不覆蓋，刪正文不刪細綱，照細綱新寫正文時細綱跟著改名。
- `features/pipelineData.test.js` 末尾新增「細綱映象正文的相對路徑」：子目錄裡的細綱列得出、判成 plot、孤兒不冒認、`resolvePlot` 認現在那一份、定稿寫回映象、新一章跟上一章、同號兩個檔案各有各的細綱。
- `generation/chapterWorkbench.test.js`：卷目錄裡的章節，點名字時旁邊開啟 `summaries/` 同一個卷目錄裡的細綱（這次的迴歸）。
- 原來斷言「平鋪 / 子目錄不認 / 按章號配對」的用例按新規則改寫（kind、hashChain、fileOps、generateTool、selectPlot、creation）。
