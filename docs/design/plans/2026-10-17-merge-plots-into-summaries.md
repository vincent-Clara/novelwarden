# 細綱改用摘要的設計，摘要不再單獨存一份

> **2026-10-18 更正**：下文「平鋪在 `summaries/` 根下、子目錄不認、按章號配對、去掉按章節路徑映象」是錯的，已改回細綱映象正文的相對路徑，見 [2026-10-18-summaries-mirror-chapter-paths.md](2026-10-18-summaries-mirror-chapter-paths.md)。

> 2026-10-17。單獨一件，**在 main 上直接開發**。起因：作者認為細綱 `plots/` 實際用處極小，照它寫不出高質量的章節；摘要的設計更完善。作者的原則是**相似的東西不保留兩份**。

**Goal:** 每章只有一份檔案，叫「**細綱**」，放在 `.novelforge/summaries/NNN-标题.md`，格式用現在摘要的那八節。
- 寫正文之前，它是計劃，正文照它寫。
- 正文寫完後由作者點「定稿」，**拿著細綱和正文，把細綱改成正文實際寫成的樣子**。

從此不再有一份單獨的「單章摘要」檔案。`plots/` 目錄不再讀。

## 作者定的（2026-10-17）

| # | 問題 | 定案 |
|---|---|---|
| 1 | 細綱和摘要留幾份 | **一份**，用摘要的格式、放在 `summaries/`，介面和文件**統一叫「細綱」** |
| 2 | 向後相容 | **不做**。老工程的 `plots/` 直接不認：判成 `other`，不讀、不顯示、不刪，目錄守衛照舊攔著 |
| 3 | 定稿做什麼 | **反向更新細綱**：拿細綱和正文，正文偏離的地方改成正文的樣子，正文沒寫到的改掉或刪掉，正文沒偏離的保留原措辭。這是修改，不是重寫。呼叫次數和現在一樣，原來「寫摘要」那一次就是它 |
| 4 | 定稿還是不是「寫完」的判據 | **是**。第 4、23 條不變：不自動跑，只有批次的「寫完即定稿」模式例外 |
| 5 | 章末鉤子 | **並進「看點」**，不單列。單列的鉤子沒用，反而會影響模型 |
| 6 | `role`（本章在結構裡的功能） | **去掉**。它只出現在細綱標題行，別的地方都不讀 |
| 7 | 定稿後又改了細綱 | **要有體現**：正文掛 ⟳，提醒正文可能沒跟上 |
| 8 | 認「這一章」用什麼 | **繼續按路徑認**。作者改了檔名，就算新章節。現有的 `resolvePlot` / `retargetPlot`（佔位路徑 `003.md` → 採納後變成 `003-雪夜.md`）保留 |
| 9 | 真實模型試跑 | 走本機 newapi（`OPENAI_BASE_URL`），模型用 `gemini-3-flash-lite` |

## 細綱檔案

路徑是 `.novelforge/summaries/NNN-标题.md`，細綱號 = 章號，**只認根目錄下數字開頭的 `.md`**；子目錄裡的判成 `other`。`summaries/global.md` 仍是全書摘要，不變。

程式碼裡的「細綱」繼續叫 `plot`（`plotFile.ts`、`plotRelPath`、`listPlots`……），**只是 `plotsDir` 指向 `summaries/`**，不做大規模改名。被刪掉的是「單章摘要」這一套：`PlotSummary`、`readSummary`、`writeSummary`、`summaryPathForChapter`、`summaryMirrorRelPath`、`markSummarized`、manifest 裡的 `summaryHash`、`handlers/summary.ts`，以及按章節路徑映象的規則。

```markdown
---
no: 12
title: 夜入青雲
targetWords: 3000
upstreamHash: …        # 生成計劃時，大綱裡管這一章那一節的指紋
writtenFrom: …         # 正文是照哪一版細綱寫的（內容指紋）。正文落盤時記，定稿時重新整理
sourceHash: …          # 定稿時正文的 contentHash。有它，就表示這份細綱反向更新過
cast: [林昭(阿昭), 沈氏]  # 定稿時記，機器讀的實際出場
status: done           # 可選：作者手工宣佈這一章完成
preflightOk: …         # 可選，不進內容指紋
factCheckOk: true      # 可選，不進內容指紋
generatedBy: novelwarden
---

# 第12章 夜入青雲

## 梗概
## 出場人物
## 時間地點
## 關鍵事件
## 看點
## 新增伏筆
## 狀態變更
## 連續性事實
```

- **八節**照 `SUMMARY_SYSTEM` 的欄位原樣搬過來。原來細綱的「本章目的」並進「梗概」，「章末鉤子」並進「看點」。
- **排過沒有**（`isPlotFilled`）：仍然只看「關鍵事件」。
- **內容指紋**：八節全進，`preflightOk`、`factCheckOk`、`cast` 和標題不進。
- **出場人物**：定稿前，這一節寫的是**計劃出場**，只用來挑角色卡、算「後幾章才出場的人」、做一致性預檢，**不進出場統計**。定稿後改寫成實際出場，同時寫 frontmatter 的 `cast`。出場統計 `buildCastIndex` **只認有 `sourceHash` 的細綱**（第 14 條）。
- **連續性事實**：計劃時為空（證據句要回原文定位，沒有正文就沒法定位）。定稿時照現在的做法生成，證據逐字校驗。
- **老工程**：`summaries/` 根目錄下的舊摘要（`001-楔子.md` 這種）本來就是這八節，帶著 `sourceHash` 和 `cast`，會被直接當成定稿過的細綱讀進來。frontmatter 裡的 `chapter:` 忽略，章號取檔名字首。子目錄裡的舊摘要和 `plots/` 都不認。都不遷移，解析失敗就當空的處理，不崩（第 1 條）。

## 生命週期與指紋鏈

```
大綱那一節 ─(upstreamHash)─▶ 細綱 ─(writtenFrom)─▶ 正文 ─(sourceHash)─▶ 細綱（反向更新）
                                 ▲                                          │
                                 └──── 定稿時把 writtenFrom 刷成更新後的指紋 ─┘
```

| 磁碟上是什麼 | 階段 | 主按鈕 |
|---|---|---|
| 沒有細綱，或者「關鍵事件」是空的 | 待排 | 寫第 N 章細綱 |
| 細綱已填，沒有正文 | 待寫 | 寫第 N 章正文 |
| 有正文，不到 `targetWords` 的八成 | 在寫 | 接著寫 |
| 正文夠了，沒有 `sourceHash` | 待定稿 | 定稿第 N 章 |
| `sourceHash` 等於正文的 `contentHash`，或者手標了 `status: done` | 完成 | — |
| 定稿過，正文後來改了（`sourceHash` 對不上） | 待定稿 | 定稿第 N 章（也就是重新定稿） |

定稿過、後來又改了正文的章，回到「待定稿」，不算完成。這和原來的狀態機一樣：原來也是摘要過期就不算寫完（第 23 條）。我起草時在這一格寫過「完成 ⟳」，實現時按原狀態機改回來了。

髒標記規則：
- 細綱的 `upstreamHash` 和大綱對不上：細綱掛 ⟳（和現在一樣）。
- 細綱內容指紋和 `writtenFrom` 對不上：**正文掛 ⟳**。定稿時 `writtenFrom` 會重新整理，所以這條同時覆蓋兩種情況：正文寫完、定稿之前改了細綱；**定稿之後又改了細綱**（作者定案 7）。
- 定稿過的章即使上游改了，也不會被拉回待寫，只掛 ⟳（第 18 條不變）。
- 沒有記錄過指紋的不算髒（第 18a 條不變）。

## 定稿：反向更新細綱

呼叫次數不變：`FINALIZE_CALLS` 仍是 1–3 次，依次是更新細綱 1 次、角色當前狀態 0–1 次、判斷敘事線 0–1 次。

**提示詞**從 `SUMMARY_SYSTEM` 改出來。輸出仍是那八個欄位的 JSON，規則不變（出場人物、連續性事實、看點）。改動有三處：
- 輸入多給一份**當前細綱**：
  - 以正文為準；
  - 細綱裡和正文一致的內容，儘量保留原來的措辭和條目；
  - 正文寫偏的地方，改成正文的樣子；
  - 正文沒寫到的，刪掉；
  - 原計劃的伏筆正文裡沒埋，就從「新增伏筆」裡拿掉。
- 細綱是空的（拆書匯入、作者手寫正文），就照正文從頭整理，也就是現在的行為。
- 「看點」那一條照現在寫：爽點和章末吊著讀者的東西都寫進去。

**落盤**：
- 八節整體替換。
- frontmatter 裡保留：`no`、`title`、`targetWords`、`upstreamHash`、`status`、`preflightOk`、`factCheckOk`。
- 寫入：`sourceHash` = 正文的 contentHash，`writtenFrom` = 更新後的內容指紋，`cast`。
- 落盤前，把舊版細綱複製一份進 `.novelforge/.trash/`（同第 6 條的做法），任務日誌寫明「舊版已放進回收站」。

⚑A **覆蓋前要不要先審閱**：定稿按鈕本身就是作者的確認，現在寫摘要也是直接落盤，所以我採用「直接寫、舊版進回收站」。如果你要先看一張段級 diff 卡片再落盤，告訴我。那要在對話頁加一張卡片，批次「寫完即定稿」照樣直接寫。

之後兩步不變：角色當前狀態、本章推進了哪幾條敘事線，都從更新後的細綱讀。

## 去掉章末鉤子之後

| 原來讀鉤子的地方 | 改成 |
|---|---|
| 篇幅不夠時，用鉤子在正文裡找收尾那一場再回退（`rewindPoint`，`model/manuscriptCheck.ts:320`） | 不給鉤子，走它現成的兜底：從末尾往前切約 25%，最多 600 字 |
| 審稿凍結目標（`freezeGoals`，`model/review.ts:138`） | 目標只取「關鍵事件」 |
| 寫正文時的執行卡（`context/prompts.ts:480`，來自 `layers/dialog.ts:26`） | 只列「關鍵事件」 |
| 細綱渲染、前序細綱一覽、衝突檢查、敘事線 | 讀「看點」，原來讀「本章目的」的地方改讀「梗概」 |

## 落在哪

| 模組 | 怎麼改 |
|---|---|
| `model/plotFile.ts` | 三節換成八節，frontmatter 合併成上面那一份，`characters` 改從「出場人物」一節（或 `cast`）讀；刪掉 `role`、`章末鉤子`、`本章目的`；`BLUEPRINT_LIMITS` 跟著改 |
| `model/types.ts` | 刪 `PlotSummary`；`SummarySections` 並進細綱的八節型別 |
| `model/project.ts` | `plotsDir` 改成 `summaries/`，只掃根目錄；刪單章摘要那一套（見上一節）；`staleChapters` / `finalizedFacts` 改讀細綱的 `sourceHash` 和連續性事實 |
| `model/pipeline.ts` | `PipelineFacts` 裡摘要相關的判據改讀細綱的 `sourceHash` / `status`；狀態機、階段名、次數估算不變 |
| `workspace/` | `kind.ts`：`plots/` 判成 `other`，`summaries/` 根目錄下數字開頭的判成 `plot`，`global.md` 不變；`handlers/summary.ts` 刪；`handlers/plot.ts` 加定稿寫入（重新整理 `sourceHash` / `writtenFrom` / `cast`，保留其餘 frontmatter，舊版進回收站）；刪 `writeSummary` |
| `views/` | `pipeline.ts` 的新鮮度改讀細綱；`cast.ts` 只認有 `sourceHash` 的；`summaryIndex.ts`、`projectView.ts` 的懸浮提示改顯示細綱 |
| `features/summarize.ts` + `summarizePrompt.ts` | 單章摘要改成反向更新細綱（帶上當前細綱）；拆書時批次整理（`syncSummaries`）照正文寫細綱；全書摘要（階段摘要 → `global.md`）的輸入改成定稿過的細綱 |
| `features/finalize.ts` | 第一步改調反向更新，後兩步讀更新後的細綱 |
| `features/blueprint.ts` + `context/prompts.ts` | 每批 5 章的 JSON 合同：`chapterNumber` / `title` / `synopsis`（梗概）/ `characters`（出場人物）/ `timePlace`（時間地點）/ `keyEvents`（關鍵事件）/ `highlights`（看點）/ `foreshadowing`（新增伏筆）/ `stateChange`（狀態變更）/ `newCharacters`（可選）。去掉 `role`、`purpose`、`suspenseHook`；`title` / `synopsis` 必須非空，`keyEvents` 至少一條（⚑B 定案後改成列表，見實施記錄）。欄位說明照 `SUMMARY_SYSTEM` 的寫法改成「計劃」口吻；容量合同、節奏規則、修復鏈不動 |
| `generation/` | `accept.ts` 寫新格式（`createPlannedCards` 保留，新角色卡的身份一節從「本章目的」改成「梗概」）；`generate.ts` 的 `planWriting` 不再給鉤子，`planReview` 只凍結關鍵事件 |
| `context/` | 渲染（`render.ts`）換成八節，「上文」帶梗概、關鍵事件、狀態變更，「下文」帶梗概、關鍵事件；**細綱配方去掉 `plotSummary`**（前幾章已經由 `plotPrev` 和 `plotList` 帶了，同一份檔案不再帶兩遍）；正文配方的 `plotSummary` 改讀更早幾章的細綱，沒定稿的標「計劃」，不再退化成「本章目的」；`evidence` / `recentFacts` 只認有 `sourceHash` 且對得上的 |
| `features/derive.ts` | 拆書補齊裡的「補細綱」一步**整個刪掉**：整理細綱那一步已經照正文寫出了細綱 |
| `features/` 其餘 | `threads.ts` / `preflight.ts` / `plotCheck.ts` / `characters.ts` / `characterCard.ts` / `pipelineBatch.ts`：改節名，語料只取定稿過的細綱 |
| `tools/` + `mcp/instructions.ts` | 路徑 `plots/` 改成 `summaries/`；`summary` 工具的說明改成「定稿 = 反向更新細綱」 |
| `media/` + `panes.ts` + `protocol/` | 介面上「單章摘要」的說法改成「細綱」（懸浮提示、定稿按鈕的說明）；「全書摘要」不改名 |

## AGENTS.md 要改的條款

只改文字，編號不動：
- 開頭幾段的鏈條改成「`outline.md` ──▶ `summaries/NNN-标题.md`（細綱）──▶ `chapters/` ──▶ 定稿反向更新同一份細綱」；`plots/` 加進「程式碼裡不認」的舊目錄。
- 第 8 條：去掉「摘要跟著章節檔名映象」。
- 第 14 條：出場人物只認定稿過的細綱。
- 第 18 條：改成新的指紋鏈。
- 第 21 條：八節、看點、出場人物是計劃。
- 第 23 條：「摘要新鮮」改成「細綱定稿過且對得上」。
- 其餘提到「摘要」的地方逐條核對。

模組 README 全部同步。`docs/design/` 下的歷史文件不改。

## 樣例工程與測試

- `sample-novel/`：
  - 刪掉 `plots/`；
  - `summaries/001–003` 改成新格式：併入原細綱的 `targetWords` 和 `upstreamHash`，重新算 `writtenFrom`；
  - 再加一份 `004` 的計劃細綱（沒有正文），用來覆蓋「待寫」這條路徑。
- `tests/contract/sampleNovel.test.js` 改成斷言新的指紋鏈。
- 測試按模組跟著改。新增：
  - 舊摘要當成定稿過的細綱讀進來；
  - `plots/` 判成 `other`；
  - 出場統計只認定稿過的；
  - 定稿後改細綱，正文掛 ⟳；
  - 定稿保留 frontmatter，舊版進回收站。
- 驗收：`npm test` 全過，`npm run test:e2e` 能跑就跑；再用真實模型跑一遍「排 3 章細綱 → 寫正文 → 定稿」。

## 實施順序

1. 核心：格式、資料層、閘道器、狀態機、裝配、生成合同、定稿、各功能，單測和整合測試同步改。
2. 介面、工具、MCP、文件、樣例工程，dom、e2e、contract 測試同步改。
3. 真實模型試跑。

全部做完、測試全過才提交；推送另報。

## 實施記錄（2026-10-17）

驗收：`npm run typecheck` 零錯誤，`npm run test:node` 全過（改動前 4632 條，改動後 4796 條）。e2e 需要 Bun，本機沒裝，沒跑（`tests/e2e/standalone/server.test.js` 只對照程式碼改了）。

**和上面設計不一樣的地方**

- 定稿過、後來又改了正文：**回到待定稿**，不是「完成 ⟳」。上面的表格已經改過來了。
- `rewindPoint` 不再收鉤子引數，按鉤子找收尾那一段的邏輯刪掉了，只剩按比例切。審稿凍結的目標去掉了 `kind`，只剩關鍵事件。寫正文提示詞裡的「章末鉤子」改成了「本章細綱約定的結束狀態」。
- 拆書刪掉「補細綱」那一步之後，細綱階段的整條補齊鏈路（`deriveBlueprintContract`、`written` 層的細綱分支、`runPlotBatch` 的 derive 引數）都沒人用了，一併刪除。拆書整理出來的細綱不記 `targetWords`。
- 排細綱合同裡的「看點」原本還有一句「每章都要有一條章末的鉤子」，是從舊的 `suspenseHook` 必填項搬過來的，與定案 5 衝突，已刪。看點的說法跟摘要的提示詞保持一致：「過渡章沒有爽點就只寫鉤子」。
- 實現過程中發現並修了一處原有 bug：`Workspace.deletePlot` 移進回收站時不加序號，而且吞掉錯誤，會覆蓋定稿時剛複製進去的舊版。現在和其他刪除動作一樣走 `trashPathFor`。
- **定稿解析不了就不寫**（試跑撞上的）：第二次試跑裡，第 1 章定稿時模型返回的 JSON 多了一個尾逗號。原有的三層解析裡，最後一層「全文塞進梗概」把整段 JSON 原文寫進了梗概，其餘七節寫成佔位，還記上了 `sourceHash`。結果細綱被毀，這一章卻顯示已定稿。現在改成：先自己去掉尾逗號再解析一次（`parse.ts` 的 `stripTrailingCommas`），去掉第三層；兩層都解析不出來，就走原有的失敗分支（報錯、掛紅、細綱不動、不記定稿）。
- 排敘事線（`planThreads`）仍然讀全部細綱，包括還沒定稿的計劃，因為計劃本來就是它的原料。出場統計和角色卡語料只認定稿過的。
- `skills/novelwarden-autopilot/scripts/nf.py` 原來寫死了 `plots/`，還用「`summaries/` 下有沒有同名檔案」判斷定稿，都改了：路徑換成 `summaries/`，定稿看 frontmatter 裡有沒有 `sourceHash`。

**真實模型試跑**（gemini-3-flash-lite，同一句腦洞，從空工程跟著主按鈕寫 3 章，每章定稿。報告在 `~/workspace/project-reports/novelForge-细纲改用摘要格式-真实模型对照-gemini-3-flash-lite-20261017.md`，指令碼在 `~/workspace/project-scripts/novelforge-merge-plots/`）

| | 改動前 | 改動後 |
|---|---|---|
| 請求數 / 用時 | 21 次 / 3.6 分鐘 | 22 次 / 2.7 分鐘 |
| 三章字數 | 2538 / 2944 / 2735 | 2950 / 3068 / 2526 |
| 後面章節的人提前登場 | 1 次（第 3 章） | 0 |
| 報錯 | 無 | 無 |

- 改動後第 2、3 章的對話**沒有引號**，程式的「對白段佔比」檢查報 2% 和 0%。追查結果：
  - 引號是第一次生成時就沒寫，後面的續寫和回退都沒有刪它。
  - 舊流程寫第 2 章的第一次生成也是 0 個引號，是後來「接著寫」時才有的。
  - 把寫第 2 章的那份訊息原樣重放：新流程第一輪重放 2 次都正常；第二輪重放 4 次，引號分別是 0、2、4、0 個。舊流程重放 4 次，分別是 12、2、16、4 個。
  - 結論：gemini-3-flash-lite 在這套提示詞下本來就會漏引號，第 3 章則是照著上下文裡第 2 章的整章正文學來的。新流程這組樣本偏低，但兩邊是不同的故事，樣本又少，不能斷定是新格式造成的。這個問題原來就有，不在這次改動範圍內。
- 定稿基本是**重寫了措辭**，內容保住了。計劃裡的二字組，定稿後在「梗概」裡只剩 16%–30%，在「關鍵事件」裡只剩 6%–25%。但第 3 章攔截、拆穿、結盟、透露鴻門宴這幾件事都還在。主要原因是兩邊格式不同：計劃的「關鍵事件」是一整段 100–300 字的場面描寫，定稿用的是摘要的格式，一條一句的列表。見 ⚑B。

**三處取捨（2026-10-17 作者說「按推薦的來」）**

| # | 問題 | 定案 |
|---|---|---|
| ⚑A | 定稿覆蓋細綱前要不要先審閱 | **不審閱**：直接寫，舊版進回收站 |
| ⚑B | 計劃的「關鍵事件」要不要也改成一條一句的列表，和摘要一致 | **改了**。`keyEvents` 改成字串陣列，一條一件事、按發生順序，合同要求 3–6 條、合計 100–300 字，每條仍然可以寫到具體場面。最多收 8 條（`BLUEPRINT_LIMITS.keyEventItems`），合計超過 1200 字從超出那一條起截掉。模型給成一段字時，按換行和分號拆開照收。執行卡在多於一條時逐條列出；只能一行的地方（前序細綱一覽、後續章節邊界、排敘事線）用「；」接起來 |
| ⚑C | 排細綱的節奏規則裡還有「懸念鉤子機制：每章結尾必須有一個讓讀者想連續翻頁的變數」，黃金三章那條也寫了「留鉤子」（`context/prompts.ts` 的 `blueprintContract`） | **沒動**。這條當時沒給推薦，所以維持原樣。如果作者認為它也會帶偏模型，再刪 |

已知的小毛病：`freezeGoals` 除了按行切，還按「；」切，一條關鍵事件裡要是帶分號，審稿時會變成兩專案標。這條沒改。
