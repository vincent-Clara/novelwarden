# core/features — 功能編排

面向使用者動作的編排層：每個檔案對應一類「點一下發生什麼」。負責組合資料層（model）、裝配器（context）與模型層（llm），並把結果以回呼形式交回宿主，不直接操作 UI。

## 檔案

| 檔案 | 職責 |
|---|---|
| [creation.ts](creation.ts) | 設定頁的連線測試（`testConnection`，嚴格用指定的模型）與兩個純文字工具 `cleanOutput`（只對正文層用）、`suggestTitle`。 |
| [artifact.ts](artifact.ts) | ★ 模型輸出 → 可採納的結構化產物（三層降級；細綱給了區間就按批次合同嚴格解碼）。 |
| [blueprint.ts](blueprint.ts) | 細綱批次（章節藍圖）的嚴格解碼與覆蓋檢查，含這一章在敘事線上的計劃 `threads`。 |
| [roster.ts](roster.ts) | 角色圖譜兩段式的解碼：身份清單 → 按凍結清單補詳情 → 拼成角色卡。 |
| [loreExpand.ts](loreExpand.ts) | 展開一條設定的解碼與截斷（明面三節合計 600、暗設 200、一句話 40）。 |
| [loreSettle.ts](loreSettle.ts) | 落定設定的解碼：一批條目照展開那一套截，最多 12 條。 |
| [loreList.ts](loreList.ts) | 設定清單（架構第五件）兩段式的解碼：清單 → 每 6 條補正文三節；呼叫次數 `loreListCalls()`。 |
| [novelConfig.ts](novelConfig.ts) | 小說配置的 JSON 合同、「全域要求」的質檢與規範化草稿。 |
| [structuredJson.ts](structuredJson.ts) | 結構化輸出的 JSON 小工具，含轉寫用的 `jsonValueOf` / `withoutNone` / `unfaithfulStrings`。 |
| [parse.ts](parse.ts) | 模型輸出解析小工具：剝程式碼圍欄、提取 JSON、字串與數字去重、字串陣列歸一。 |
| [pipelineBatch.ts](pipelineBatch.ts) | ★ 工程頁的三條批次動作（補齊架構、批次拆細綱、批次寫章），都嚴格序列、一件失敗就停、只補空白。 |
| [askCall.ts](askCall.ts) | ★ 調模型之前的那一問：確認框上模型與上下文詳細度兩個下拉框只在這裡拼（第 4 條）。 |
| [transcribe.ts](transcribe.ts) | ★ 轉寫的整條走法 `transcribeJson`：照抄 → 「無」換空 → 逐段核對出自原文 → 原來的解碼，不合格重轉一次。 |
| [poolIO.ts](poolIO.ts) | 工程頁任務那條路的 `ChainIO`（走分檔池、用幹活那個模型的視窗、不帶思考深度），以及轉寫的 `lazyTranscriber` / `transcribeWith`。 |
| [finalize.ts](finalize.ts) | ★ 定稿一章：照正文反向更新細綱 → 出場角色的當前狀態 → 敘事線 → 故事時間。 |
| [finalizeSteps.ts](finalizeSteps.ts) | 定稿的後幾步（角色狀態、敘事線 `judgeChapterThreads`）與 `ModelRunner`，單章定稿與「立即同步」共用。 |
| [threads.ts](threads.ts) | 敘事線：從情節大綱排線（`generateThreads`）與定稿時認事件 / 歸併 / 當前進度（`recordThreads`）。 |
| [threadsBackfill.ts](threadsBackfill.ts) | **從已寫正文補記敘事線**：`planThreadsBackfill` 算出水位之後要判的章（零呼叫），`runThreadsBackfill` 按章號序列補。 |
| [storyTime.ts](storyTime.ts) | **認時間**：同步一章時單獨推一次故事時間（`recordChapterTime`），補推、重推也走 `judgeTimes`。 |
| [timelineBackfill.ts](timelineBackfill.ts) | **補推、重推故事時間**：幾章一批，只動機器寫的行。 |
| [timelineEdit.ts](timelineEdit.ts) | **作者在工程頁改故事時間**（零呼叫）：改一行、改曆法與起點，經閘道器只改那一行、那兩個鍵。 |
| [threadPlan.ts](threadPlan.ts) | 敘事線的計劃事件隨細綱走：`writePlannedThreads` 整組換掉那幾章的計劃事件、新伏筆加線上下。 |
| [threadsPrompt.ts](threadsPrompt.ts) | 敘事線的四段系統提示（排線、認事件、當前進度、歸併），按格式寫、轉寫成 JSON。 |
| [plotCheck.ts](plotCheck.ts) | 寫前衝突檢查（只在批次寫章裡跑）：本章細綱比對前面的連續性事實，對不上就停在那一章前面。 |
| [preflight.ts](preflight.ts) | 一致性預檢的取數（零呼叫；判斷在 `model/preflight.ts`），對話頁寫第 N 章之前與批次寫章兩個入口。 |
| [characterState.ts](characterState.ts) | 定稿時更新本章出場角色的「當前狀態」：歸機器的卡只換那一節，作者改過的不寫、掛黃 ❗。 |
| [summarize.ts](summarize.ts) | 定稿第一步（`summarizeChapter`）、「立即同步」（`syncSummaries`）與全文大綱（`updateGlobalSummary` / `rebuildGlobalSummary`）。 |
| [summarizePrompt.ts](summarizePrompt.ts) | 定稿（照正文整理細綱）、階段大綱與全文大綱的系統提示，以及轉寫合同 `SUMMARY_JSON_CONTRACT`。 |
| [characters.ts](characters.ts) | 從選定的幾段正文批次提取 / 更新角色卡（劇作稱謂換成真名、同一批先去重）。 |
| [charactersPrompt.ts](charactersPrompt.ts) | 批次提取角色卡的系統提示（一個人物一份、十個小標題，不寫 JSON）與轉寫那一步的合同（`CHARACTER_JSON_CONTRACT`）。 |
| [lore.ts](lore.ts) | ★ 設定條目的四件維護：建條目、整合、按目錄整理、批次展開。 |
| [loreRecord.ts](loreRecord.ts) | 記設定：定稿時順手記進細綱「設定」一節（`checkLore` 校驗），以及單獨記一章 / 補記（`recordLore`）。 |
| [lorePrompt.ts](lorePrompt.ts) | 「設定」欄位說明（定稿與單獨記設定共用）與建條目、整合、按目錄整理的提示詞及轉寫合同；字數上限是第 27 條的錨點。 |
| [characterCard.ts](characterCard.ts) | ★ **單個角色**的檔案更新編排；解析在 characterCardParse.ts，提示詞在 characterCardPrompt.ts。 |
| [characterCardParse.ts](characterCardParse.ts) | 角色卡更新的 JSON 解析（`parseCardResponse`）與轉寫那一步的說明（`cardTranscribeSpec`：合同、解碼、性別按對應關係填）。 |
| [characterCardPrompt.ts](characterCardPrompt.ts) | 更新角色卡與定稿時更新當前狀態（`STATE_SYSTEM`）的系統提示，及各自的轉寫合同。 |
| [characterMaintenance.ts](characterMaintenance.ts) | ★ 兩條不調模型的整理動作：`cleanCharacterAliases` 刪非專屬別名、`mergeDuplicateCharacterCards` 合併重複卡；只改 frontmatter。 |
| [style.ts](style.ts) | 從樣章歸納文風指南寫入 `.novelwarden/style.md`。 |
| [stylePrompt.ts](stylePrompt.ts) | 文風提取與從參考書學寫法的系統提示（只學技法，不復述情節、不抄原句）。 |
| [bookText.ts](bookText.ts) | 拆書兩條路共用的取書：作者可挑本機任意位置的 txt（上限 64 MiB），agent 給的路徑只認工程裡的清單。 |
| [importManuscript.ts](importManuscript.ts) | ★ **匯入原稿**（拆書 A）：挑 txt → 切章 → 確認 → 一批建好章節，再問要不要從已寫正文補齊。 |
| [exportBook.ts](exportBook.ts) | **匯出全文**（零呼叫）：全部章節按章號拼成 `导出/<书名>.txt`。 |
| [derive.ts](derive.ts) | ★ **從已寫正文補齊**（拆書 A）：按 細綱 → 配置 → 前提 → 角色卡 → 世界觀 → 設定條目 → 全文大綱 的順序只補空白。 |
| [outlineRewrite.ts](outlineRewrite.ts) | **分段重寫情節大綱**：只重寫還沒寫正文的章，20 章一段，全部寫完一次審閱。 |
| [reference.ts](reference.ts) | **從參考書學寫法**（拆書 B）：學文風寫 `style.md`、學寫法寫成本工程的寫作技能；原文不進工程。 |
| [bookReplace.ts](bookReplace.ts) | ★ **全書替換**（零呼叫）：預覽裡勾著的幾處經閘道器逐份寫；未儲存的、hash 對不上的跳過，換之前先存一版歷史。 |
| [checkpoint.ts](checkpoint.ts) | 存檔點：批次動作之前自動存（`checkpointBefore`，絕不拋）與退回的編排（`restoreCheckpoint`）。 |
| [pickPlots.ts](pickPlots.ts) | 多章選擇：Host.pick 只支援單選，需要選幾章時改為輸入章號列表（如 `1,2,3`）。 |

## 創作的四層與兩條路

創作按 `Stage × Capability × Target` 展開（定義在 [../model/pipeline.ts](../model/pipeline.ts)）：架構 → 大綱 → 細綱 → 正文。同一層可以被討論（預設動作，挑刺、檢查設定都靠直接打字說），也可以被生成；細綱層另有一個 `settle`（落定細綱），把剛才那段討論裡**已經達成的結論**沉澱成細綱。改寫不是獨立能力：目標已有內容時的生成就是改寫，作者那句話就是修改意見。從前還有 `split`（大綱拆卷、卷拆劇情段）與拆章，卷那一層刪掉之後都沒了。

**創作編排本身已經不在本層了**——它是 [../generation/](../generation/README.md)：`generate.ts` 無狀態地裝配 → 調模型 → （需要時接 `structured.ts` 的生成鏈）→ 解析成 `Draft`，`accept.ts` 按產物分派到八條落盤路徑，`drafts.ts` 讓草稿活過一次重新整理。併發控制在 `controller/`（那是排程的責任）。本層留下的是 `artifact.ts`（解析）與 `pipelineBatch.ts`（工程頁批次）。

**生成與落盤是兩步**，這是這條路上最要緊的一條：

1. `generate()` 只把文字交回呼用方，**一個字都不寫盤**，產出一份帶 `artifact` 的 `Draft`；
2. `acceptArtifact()` 才寫，且只在使用者在那張落盤卡片上點了「寫入」之後（`controller/chat.ts` 的 `askArtifact`，產出的當下就問）——**落盤時拿氣泡裡當下的文字重新解析**（使用者可能改過），`draft.artifact` 只是生成那一刻的展示快照。

中間那一步是使用者看著產物決定要不要的機會——少了它，「不靜默覆蓋」無從談起。

`generation/`（創作頁，一次一份）與 `pipelineBatch.ts`（工程頁，一次幾十份）的失敗模型完全不同，所以是兩條路：

| | `generation/` | `pipelineBatch.ts` |
|---|---|---|
| 一次處理 | 一份產物 | 幾十章 |
| 覆蓋已有產物 | 走 `reviewReplace` 逐份審閱 | **一律跳過**——一次彈 63 個 diff 沒人看得完。補齊架構連一節都不覆蓋：作者寫過的節原樣留著（`onlyBlank`） |
| 解析失敗 | 單份文件全文兜底（產物攤在螢幕上，使用者看得見它是什麼）；細綱批次不兜底 | **不兜底**——沒人逐份過目，兜底會把「這次失敗了」變成「這一章已排好」，緊接著的批次寫章還會照著它寫出一整章 |
| 出錯 | 報錯，使用者重來 | 記進 errorLog 掛在那一行上，**就此停下**——後一件、後一批、後一章要吃前面的產出 |
| 寫出來但有問題（重演、沒寫夠） | 卡片上標出來，作者當場判斷 | 照樣落盤（錢已經花了，D6），不定稿，黃 ❗ 掛在那一章上，**停下**——接著往下寫等於踩著一個有問題的結尾 |

兩條路共用同一個 `buildContext` 與同兩條生成鏈（`generation/structured.ts`、`generation/continuation.ts`），因此批次與單次產出的是同一個質量、同一套降級與續寫。

## 定稿走 JSON

定稿第一步（2026-10-25 起）要模型按八個小標題寫自然語言，轉寫模型照抄成 JSON：細綱的七個欄位（梗概 / 出場人物 / 時間地點 / 關鍵事件 / 看點 / 狀態變更 / 連續性事實；敘事線二期刪了「新增伏筆」——伏筆由定稿第三步認進敘事線）與「設定」，其中 `出場人物: [{name, aliases}]`、`連續性事實: [...]`。`parseSummaryResponse` 解析成 `SummaryData`。落盤是 `Workspace.finalizePlot`，寫回同一份細綱，仍是 Markdown（作者要翻、要手改）：結構化的出場人物額外寫進 frontmatter 的 `cast`；連續性事實掛上證據之後寫成最後一節（`- 陳述 〔證據：「原文」〕`，格式在 [../model/continuity.ts](../model/continuity.ts)）。

解析分**兩層**，兩層都不中就什麼都不收——能解析的一定要解析出來（解析失敗意味著這一章的連續性事實與出場人物進不了上下文），解析不了的一個字都不寫：

1. **JSON**：欄位缺失、型別不對（字串/陣列混用）都逐欄位兜住，不整體作廢；多出來的尾逗號（模型最常見的語法錯）先自己去掉再解析一次（`parse.ts` 的 `stripTrailingCommas`）。判據是「梗概或關鍵事件至少有一個非空」——模型偶爾吐出語法合法但不相干的 JSON，認下來會得到一份空細綱，比解析失敗更糟。
2. **Markdown 小節**：模型忽略 JSON 要求、照著細綱的樣子寫回來時走這條。

從前還有第三層「全文進梗概」。定稿寫回的就是這一章的細綱，那一層等於拿一段沒解析開的原文換掉作者的計劃、還記上 `sourceHash` 讓這一章看起來已經定稿（真實模型試跑撞上過：尾逗號讓 JSON 解析失敗，整段 JSON 進了梗概）。所以兩層都不中就報失敗、掛紅，細綱一個字不動。

只有第 1 條有結構化 `cast`，第 2 條從「出場人物」小節的文字反解（見 [../model/castParse.ts](../model/castParse.ts) 的 `castFromText`）。

## 兩條角色流程的分工

| | `characters.ts` · 提取角色 | `characterCard.ts` · 更新角色卡 |
|---|---|---|
| 面向 | 「剛寫完幾章，把新出現的人補上」 | 「這個人出場三十章了，把他的檔案重新過一遍」 |
| 作用物件 | 一批章裡的**所有**角色 | **一個**角色（另有按卡併發的批次版） |
| 章從哪來 | 作者手輸序號列表 | 出場索引（定稿過的細綱）自動給出該角色的出場章 |
| 上下文 | 一次裝完（超預算就截斷並 warn） | 按預算分批，逐批精煉同一張卡 |
| 入口 | 「角色」分組右鍵「提取/更新角色卡（挑幾章正文）…」 | 角色行右鍵；角色分組右鍵的批次更新；「未建卡」分組右鍵的「全部建卡」 |

`characterCard.ts` 的三條關鍵設計：

- **自動關聯出場章**：來自 [../views/cast.ts](../views/cast.ts) 的索引，作者不必再手輸章號。
- **分批時先說要調幾次**：主角可能出現在幾十章裡，一次裝不下就切批。動手前的確認框裡必須寫明「分 N 批」與預計呼叫次數（2026-10-25 起每批寫 1 次、轉寫 1 次）——這是「不偷偷燒 token」在本層的落法。後一批看得到前一批的產出，逐批精煉而非各寫各的。
- **提示詞是為「控篇幅」寫的**：同一個角色會被反覆呼叫，每批都往上堆的話角色卡會膨脹成一篇論文，而它每次續寫都要注入上下文。所以每一節都給了硬性字數上限，並明確「性格 / 語言習慣」優先（它們決定模型能不能把人寫像），外貌與人物關係從簡；「暗設」（讀者還不知道的事，原「未收伏筆」，≤120 字）只做減法——正文裡已經揭開的拿掉、寫進相應的節，沒揭開的一字不改，看不出來的秘密不編。

## 關鍵設計

- **回呼而非返回**：生成類操作通過 `GenerateHandlers`（onDelta / onDone / onError / onCancelled）彙報進度，UI 層決定怎麼展示流式內容。
- **長任務走 `runTask`，不直調 `Host.progress`**：本層除創作頁的單次生成（它在對話頁有流式氣泡）以外的批次活一律經 [../runtime/progress.ts](../runtime/progress.ts)。`report({ message, current, total })` 裡的 `total` 決定網頁上畫不畫進度條——同步過期細綱是 `stale.length`，重建全文大綱是「批數 + 合併那一步」，角色/文風是固定三步/兩步，設定生成是「逐章掃描 + 設定整合 + 寫入/審閱」，流水線批次是待處理的章數（補齊架構是缺的件數）。
- **一次改很多份的批次動作，動手之前先存一個存檔點**（[checkpoint.ts](checkpoint.ts) 的 `checkpointBefore`，設計見 [docs/design/plans/2026-10-20-checkpoints.md](../../../docs/design/plans/2026-10-20-checkpoints.md)「自動存檔點」）：十一處——批次寫章（含寫完即定稿）、補齊架構、批次拆細綱（`pipelineBatch.ts`）、全書替換（`bookReplace.ts`）、按目錄整理設定與批次展開設定（`lore.ts`）、匯入原稿、從已寫正文補齊、立即同步（`summarize.ts`）、從正文補記敘事線（`threadsBackfill.ts`；補齊裡接上的那一段算在補齊那一個裡，不另存）、補推 / 重推故事時間（`timelineBackfill.ts`）——作者點了「開始」之後、第一次寫盤之前各調一次，整本書退得回這一次之前。位置是 `runTask` 回呼的開頭（確認框取消、「沒有可用的模型」直接返回的都不留一個沒用的點）；按目錄整理在作者點了「照這樣整理」之後、搬之前；全書替換在逐份寫之前、有要換的才存。鉤子在本層，外部 agent 經 MCP 調同一個批次功能也一樣先存。批次寫章「邊寫邊拆」走的是 `runPlotBatch`、從已寫正文補齊的細綱那一步存過之後其餘幾樣，都不另存；其餘與最近一個一模一樣時也不另存。**絕不拋、不擋**：存不下只記一條 warn，批次動作照常跑（第 1 條；每份檔案覆蓋之前的歷史版本照存）。
- **無先後依賴的條目併發跑**：各章照正文更新細綱之間、角色卡之間、全文大綱的各階段批次之間都沒有依賴，一律經 [../runtime/concurrency.ts](../runtime/concurrency.ts) 的 `runPool`（併發量取 `config.concurrency`）。**有依賴的絕不併發**——同一張角色卡內部的分批必須序列，後一批要看到前一批的產出；全文大綱的 reduce 合併要等全部 map 到齊。併發下 `current` 只在項結束時 +1，`message` 報「已完成 n/N + 正在跑哪幾項」。
- **模型經 `llm/pool.ts` 取，並且要報出檔位**：建池時必須傳 `task`（如 `createModelPool({ task: 'plotSummary' })`），這樣才有分檔、「同檔失敗隨機換模型」與併發輪轉。唯一的例外是創作頁的單次生成（[../generation/generate.ts](../generation/README.md)）與設定頁的連線測試（`creation.ts`），兩者都必須用使用者選定的那個模型。同一個功能裡難度不同的階段要**各建一個池**——`rebuildGlobalSummary` 的分批匯總（`globalSummaryStage`）與最終合併（`globalSummaryMerge`）、`generateLore` 的逐章識別（`loreScan`）與條目整合（`loreSynthesis`）都是兩檔，序列時也不能圖省事複用同一個池（那會把後一階段悄悄降級到前一階段的檔）。流水線批次同理：`plotOutline`（均衡）與 `manuscript`（均衡）各建各的池；批次寫章的「寫完即定稿」再為定稿的兩步各建一個（`plotSummary`、`characterCard`）。
- **切批與預算用 `pool.primaryBudget`，不用 `config.contextWindow`**：後者是對話頁選定模型的視窗，分檔後與幹活的模型無關。確認框之前就要算的批數/片段數（它們就是「預計呼叫 N 次」那個數字）用 `budgetForTask(task)`，它不構造 provider，不會在使用者點確認前彈 Key 輸入框。
- **確認框裡的「模型」一行走 `describeTaskModels(config, task)`**：檔位、實際清單、會不會換人、是不是繼承預設模型，四件事一次說清。**不要再列印 `config.models`**——彈窗寫著一個模型、實際跑另一個，是「不偷偷燒 token」的反面。
- **每一步都留痕**：批次任務逐項打一條 `info`（含剛完成的項、用時、平均速度、預計剩餘），失敗項打 `error`；可以併發的（同步細綱、角色卡批次）**繼續跑完剩下的**、結束時彙總說明哪幾項失敗，流水線那三條就此停下並說清停在哪。日誌裡絕不出現 API Key（`logger.redact` 統一處理），也不記 prompt 全文。
- **模型輸出清洗**：LLM 常把正文包在 code fence 裡或加上「好的，以下是續寫」之類的前言，寫入前統一剝掉（`stripCodeFence` 等）。
- **人工確認優先**：凡是覆蓋作者可能手改過的檔案（角色卡、style.md），一律先經宿主審閱/彈窗確認。批次更新時分析是併發的，但審閱經 `concurrency.ts` 的 `serialize()` 排隊——同時彈三個 diff，使用者根本不知道自己在看誰。作者點了採納（或在批次確認框裡選了「全部直接採納」）之後經 `workspace.write` 寫回原檔案（`review: false`：不問第二次），覆蓋之前舊內容照樣進歷史版本（第 7 條：寫盤經閘道器）。
- **超預算截斷必須打 `warn`**：單章正文、角色提取的語料、文風樣文、階段摘要合併這四處都會按輸入預算 `takeHead`。截斷本身是對的，但作者選了五章卻只讀進兩章半時必須說出來——這是「不靜默截斷」在本層的落法。
- **互動全走 Host**：彈窗、進度、檔案開啟都經 `host.ts` 窄介面，本層零 `vscode` 依賴。
- **定稿與全文大綱溫度 0.3**：要穩定、可復現，不用使用者設的創作溫度。

## 依賴關係

依賴 `model/`、`context/`、`llm/`、`host.ts`。被 `vscode/extension.ts`（命令）與 `core/controller/`（對話面板）呼叫；外掛命令面板與獨立版網頁共用同一批流程。
