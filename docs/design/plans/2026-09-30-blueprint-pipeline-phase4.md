# 四期：定稿 + 證據 + 序列批次 Implementation Plan

> **接手須知：** 這份計劃面向新的 agent，假設你**沒有讀過**前面的對話。開工前必讀：
> 1. 根目錄 [AGENTS.md](../../../AGENTS.md)：本期直接關係到第 2、3、4、11、12、14、15、16、17、19、26 條。
> 2. [總計劃](2026-09-30-blueprint-pipeline-roadmap.md) 的 §1（#13–#15）、§2.1 摘要那一節、§2.3 正文那一行的 P2、§3.3 的 W8 / W9、§4（D10、D15、D17、D18、D23、D24）。
> 3. [三期計劃](2026-09-30-blueprint-pipeline-phase3.md) 的 §3（續寫鏈）與 §9（本期接手的那幾件）。
> 4. 上游原始碼：`~/workspace/AI-Novel-Writer`（GPL-3.0，源自 AI_NovelGenerator）。移植處在註釋裡註明出處。
>
> 每個 Task 做完立刻 commit，commit 之間 `npm run typecheck` 必須零錯誤。

**Goal:** 一章寫夠之後，主按鈕「定稿第 N 章」一次做完兩件事：生成摘要（六節 + 新的「連續性事實」，每條事實用 bigram 在正文裡確定性地找一句證據原文，零呼叫），再用一次呼叫更新本章出場角色卡的「當前狀態」——作者手改過這一節的卡不覆蓋、掛黃 ❗、給一個對比入口。寫後面的章時，正文層多一層 `evidence`：拿證據原句回到 `chapters/` 裡逐字定位，帶那一段前後各一段原文。工程頁的「批次寫章」改成嚴格序列：寫一章（帶續寫鏈）→ 落盤 →（寫完即定稿模式下）定稿 → 下一章，失敗即停、只在章與章之間停。任務進度挪到頁頭，所有頁籤都看得見，完成時給一個帶「開啟第 N 章」的提示。

**Architecture:** 純函式先行（連續性事實的解析 / 渲染 / 掛證據 / 定位原文、角色狀態歸屬、定稿與批次的呼叫次數、批次切分），再是定稿那一條功能鏈（摘要 → 角色狀態），然後是裝配的 `evidence` 層，再是批次寫章與任務登記處（可在章間停、完成提示），最後是前端兩件（W8、W9）與驗收。

**Tech Stack:** TypeScript、`node:test`、jsdom、Bun（e2e）。不新增依賴。

## Global Constraints

- `src/core/` 零 `vscode` import；分層契約測試全程要綠。
- **不靜默截斷**（第 2 條）：定稿時丟掉的事實、`evidence` 定位不到而降級的條目、「上一章還沒定稿」，一律進日誌或裝配明細。
- **不靜默覆蓋**（第 3 條、D15）：角色卡「當前狀態」只有在「自上次機器寫入之後沒人改過」時才由機器更新；改過的不寫、掛黃 ❗、給對比入口。機器寫這一節只動這一節與兩個 frontmatter 欄位，卡上其餘內容（包括作者自加的小節）一個字不碰。
- **動手之前寫明呼叫次數**（第 4 條、D16、D17）：定稿「預計 1–2 次」；批次寫章按上限報（一章最多 8 次，寫完即定稿再加 2 次）。
- **單章寫完不自動定稿**（D17）：只有批次的「寫完即定稿」模式裡才自動定稿。
- **批次不帶思考**（第 26 條）；**換人只在檔內**（第 12 條），而且**一章之內不換人**：續寫那幾輪用第一次呼叫成功的那個模型。
- 本期結束時 `npm run typecheck` + `npm run test:node` + `npm run test:e2e` 全綠。

---

## 本期定下的東西（寫進程式碼註釋）

### 1. 摘要的「連續性事實」（D18 的前半段）

- `SummarySections` 加第七節 `连续性事实`，六節不動（第 14 條依賴「出場人物」）。落盤格式（總計劃 §2.1）：
  ```markdown
  ## 連續性事實
  - 林昭左臂被青鱗劃傷，未愈 〔證據：「血順著左臂往下淌，他把袖子紮緊了」〕
  ```
- 摘要的 JSON 契約加 `"連續性事實": ["…"]`：只寫正文明寫、後面各章必須保持一致的事實（傷勢、持有物、誰知道了什麼、身在何處、關係變化、生死），一條一句，最多 12 條（上游 `CONTINUITY_FACT_LIMIT`）。
- **證據用確定性方法找，不調模型**：移植 `finalize-chapter.command.ts` 的 `textBigrams` / `evidenceExcerpt` / `buildFinalizedContinuityFacts`（FC:161-230）。按句切正文，去掉事實裡的人名之後算 bigram，取命中最多且「有獨立支撐」的一句（≤240 字）。事實裡提到了出場人物時只在含那個人名的句子裡找。
- **找不到證據的事實丟棄**（與上游同）：沒有原文撐著的「事實」多半是模型編的，留著會被後面幾章當真。丟了幾條、是哪幾條，寫進日誌與定稿的 toast。
- 解析容錯（第 1 條）：作者手改的這一節，`〔證據：…〕` 缺了、括號寫成半形、整行沒有 `- ` 都認；認不出證據的行照樣是一條事實（只是沒有證據，寫正文時降級成事實原句）。

### 2. 角色卡「當前狀態」（D15）

- 角色卡 frontmatter 加 `stateThrough`（這一節更新到第幾章）與 `stateHash`（機器最後一次寫這一節時它的指紋）。
- **歸屬判據只有一條**（`model/characterState.ts` 的 `stateOwnedByMachine`）：這一節是空的，或者 `stateHash` 與這一節當前內容的指紋一致 → 機器可以寫；其餘（改過、或者從來沒記過指紋的非空內容）→ 作者的，不寫。與上游 `protectedValue` 同一口徑（FC:481-483：非空且不是機器派生的一律保護）。
- **機器寫這一節的地方都要記指紋**，否則它自己寫的東西下次也被當成作者的：角色圖譜建卡 / 覆蓋（`acceptRoster`，`stateThrough: 0` = 開篇）、「更新角色卡」採納後（`stateThrough` = 讀到的最後一章）、從正文提取角色建卡、定稿更新狀態。維護類動作（清理別名、合併）原樣帶著舊的兩個欄位，不重新蓋章。
- 寫入是**外科式**的：只替換 `## 當前狀態` 那一節的內容、改兩個 frontmatter 欄位（`rewriteFrontmatter` 同一個思路），不整卡重渲染——整卡渲染會抹掉作者自加的小節。
- 定稿那一次呼叫（移植 `update_character_cards`，PT:1116-1181，欄位收成一段文字）：輸入本章正文 + 本章摘要「出場人物」裡**已經建卡**的人（名字、身份一行、現在的當前狀態）；輸出 `{"updates":[{"name","當前狀態"}]}`，只列狀態變了的人，100 字以內。
  - 沒有一個出場的人有卡 → 不調，定稿就是 1 次。
  - 認不出的名字忽略並記日誌（上游直接報錯整批作廢；這裡一個名字認錯不該拖累其餘幾個人）。
  - 卡上的狀態已經更新到比第 N 章更晚的章（重新定稿早前的章）→ 不回退，記一句。
  - 作者的 → 不寫，**掛黃 ❗**（`targetKind: 'character'`，`op: 'cardState'`），說明裡帶上機器給出的那一版。角色行右鍵「對比第 N 章給出的狀態…」走覆蓋審閱（`reviewReplace`），採用就按機器寫入（記指紋、清 ❗），放棄就清 ❗、不寫。
  - 在本章出場、狀態沒變的人：機器的卡把 `stateThrough` 推到 N（狀態仍然成立到這一章）；作者的卡不動。
- 這一節在角色卡上的字數上限不變（第 15 條：120 字）。

### 3. 定稿（`features/finalize.ts`，新）

```
定稿第 N 章
  1. 摘要（1 次）：六節 + 連續性事實 → 掛證據（0 次）→ 落盤
  2. 角色狀態（0–1 次）：本章出場、已建卡的人 → 按歸屬寫或掛 ❗
```

- 呼叫次數 `FINALIZE_CALLS = { low: 1, high: 2, max: 2 }`：「預計 1–2 次呼叫」（出場的人都沒建卡時只有摘要那一次）。主按鈕「定稿第 N 章」、章節工作臺的「定稿」、工程頁右鍵共用這一個數。
- 摘要失敗 → 整個定稿失敗（紅 ❗ 掛在章節上，與現在一樣），不調第二次。角色狀態那一步失敗 → 摘要照樣算數，失敗掛黃 ❗ 在章節上（第 16 條：部分完成）。
- 單章入口（主按鈕、工作臺、右鍵、agent 的 `run summarize`）用對話頁選定的那個模型（與現在的「總結這一章」一致）；批次入口兩步各走各的檔：摘要 `plotSummary`、角色狀態 `characterCard`。
- 「同步所有過期摘要」仍然只生成摘要（它是補賬，不是定稿）；但摘要本身從此帶連續性事實。

### 4. `evidence` 層（D18 的後半段）

| 取哪幾章 | 取什麼 |
|---|---|
| 前 5 章（按章號） | 全部連續性事實 |
| 更早的章，最多湊滿 12 章 | 只取提到本章角色（細綱 `characters[]` 與他們的別名）的事實 |

- 每條事實拿證據原句回到那一章的正文裡**逐字**定位（空白歸一後 `includes`），取所在段落與前後各一段，相鄰視窗合併（移植 `adjacentEvidencePassages`，CM:65-86）。一章一條條目：`第 N 章 · 定稿原文`。
- **定位不到**（作者改過正文）→ 那一條換成事實原句，條目標 `degraded`，明細寫「k 條證據在正文裡找不到（正文改過），換成事實原句」。
- 總量封頂 6000 字（上游 `MATERIAL_BUDGET_CHARS`），由近及遠填，放不下的章 `dropped` 並寫原因；拼進訊息時按章號正序。
- 條目種類 `evidence`，小節標題「# 定稿原文片段（前情以這些原文為準；摘要、角色狀態與它有出入時信原文）」（上游 CM:223-227 的說法）。
- 與近 2 章全文（`manuscriptFull`）去重：某一章整章正文進來了，它的 `evidence` 條目改成 `dropped`，note「整章正文已完整注入」，預算退回去（與 `prevTail` 同一個做法）。
- 配方：正文層 P2，排在 `globalSummary` 前面；續寫配方不帶。
- **D23**：上一章有正文但還沒定稿（摘要缺失或過期）時，明細裡多一條 `dropped` 的「第 N−1 章 · 定稿原文」，note「第 N−1 章還沒定稿：沒有連續性事實，角色狀態截至第 K 章」。`characters` 層每張卡的 note 後面帶「當前狀態截至第 K 章」（`stateThrough` 缺席時不說）。

### 5. 批次寫章（`features/pipelineBatch.ts` 的 `writeManuscripts` 重寫，D10）

- 入參 `{ range, mode: 'draft' | 'finalize', confirmed }`。預設區間：下一可寫章起 3 章，一次最多 10 章（W9，上游 1–10 章）。
- 切分是純函式 `planWriteBatch`（`model/pipeline.ts`，前端彈窗與後端確認框同源）：區間裡**已有正文的章跳過**；遇到第一章**沒有細綱**的就在它前面收住（後面的章要接著它寫，跳過去寫不成）。呼叫次數 = 章數 ×（`WRITE_CALLS` + 寫完即定稿時 `FINALIZE_CALLS`），確認框按上限報。
- **嚴格序列**，不看併發設定：
  ```
  for 每一章：
    寫（續寫鏈，與對話頁同一個 completeManuscript；池裡的首選，失敗換同檔其餘；一章之內續寫那幾輪釘住同一個模型）
    → 新建 chapters/NNN-标题.md、記 writtenFrom
    → 寫完即定稿：定稿（§3）
    → 作者點過「寫完這一章就停」：停
  ```
- **失敗即停**：寫不出來（呼叫失敗、思考吃光、空正文）或定稿的摘要失敗 → 停，紅 ❗ 掛在那一章上，已經寫好的留著。
- **寫出來但不能往下接的也停**（這一處是本期定的，上游直接作廢整章）：
  - 重演命中（開頭與上一章結尾大段重合）；
  - 最後仍不到目標的八成。
  這兩種都把已經寫出的正文**照樣落盤**（新章，沒有東西可吞；錢已經花了，D6），**不定稿**，黃 ❗ 掛在那一章上寫明原因，批次停下。對話頁那邊有卡片讓作者當場判斷；批次沒有人看，接著往下寫等於讓後面幾章踩在一個有問題的結尾上。
- 取消（「停止」）：正在寫的那一章不落盤（作者不要了），前面的留著。「寫完這一章就停」：這一章照常寫完、落盤、（定稿），然後停。
- 完成提示（D24）：「第 1–3 章已寫好（定稿 3 章）」，按鈕「開啟第 3 章」；停下時說清停在哪、為什麼。
- agent 的 `run batchManuscripts`：預設區間、只寫正文、先彈確認框，返回實際呼叫次數。

### 6. 任務登記處（`runtime/progress.ts`）與協議

- `runTask` 的選項加 `pausable`：`TaskContext.stopRequested()` 讀作者有沒有點「寫完這一章就停」。快照加 `pausable`、`stopping`。
- `TaskContext.finish(notice)`：任務結束時的那一句（`message`、`level`、可選 `open: { plotRelPath, label }`）。controller 訂閱後推 `taskDone`；前端出一條帶按鈕的提示，按鈕發 `openChapter`（W6 那一條）。給了 `finish` 的任務不再另外 `toast`（不重複）。
- `InMessage` 加 `stopAfterItem { id }`；`projectAction` 的批次引數加 `mode`。`OutMessage` 加 `taskDone`。

### 7. 呼叫次數

| 步驟 | 預計 | 最多 | 文案 |
|---|---|---|---|
| 定稿第 N 章 | 1–2 | 2 | 「預計 1–2 次呼叫（摘要 1 次，本章出場的人有角色卡時再更新一次角色狀態）」 |
| 批次寫章 n 章 · 只寫正文 | n | 8n | 按件加總 |
| 批次寫章 n 章 · 寫完即定稿 | 2n | 10n | 同上 |

### 8. 本期不做

- 預檢（已死亡的角色又被排進本章）：五期。它讀的正是本期維護起來的「當前狀態」。
- 批次裡「寫完即定稿」之外的第三種模式（寫完即審稿）：五期。
- 連續性事實的敘事線歸併（`threads.md`）：七期。
- 證據的來源 hash、定稿收據、專案租約：不搬（總計劃 §1 #14）。

---

## 提交節奏（8 個 commit）

| # | 字首 | 主題 |
|---|---|---|
| 1 | `docs` | 本計劃 |
| 2 | `feat(model)` | 連續性事實與證據、角色狀態歸屬、定稿與批次寫章的呼叫次數與切分（純函式 + 單測） |
| 3 | `feat(features)` | 定稿：摘要帶連續性事實與證據、一次呼叫更新出場角色的當前狀態、手改過的掛黃 ❗ 與對比入口 |
| 4 | `feat(context)` | `evidence` 層：定稿原文片段、定位不到降級、與近章全文去重、上一章未定稿寫進明細 |
| 5 | `feat(features)` | 批次寫章嚴格序列：續寫鏈、寫完即定稿、失敗即停、章間停下、完成提示 |
| 6 | `feat(media)` | W8 頁頭任務條與完成提示、W9 批次寫章彈窗、定稿按鈕與角色的「狀態截至第 K 章」 |
| 7 | `test` | 四期驗收——連寫 3 章，第 3 章看得到第 2 章更新過的角色狀態與證據原文；手改過的狀態不被覆蓋 |
| 8 | `docs` | 本期動到的模組 README |

真實模型冒煙（前 1 章 + 定稿，約 3–5 次呼叫）按總計劃 §7 **要作者點頭才跑**，不在這 8 個 commit 裡。

---

### Task 2：純函式（commit 2）

- `model/types.ts`：`SummarySections.連續性事實`、`SUMMARY_SECTION_KEYS` 加一項；`CharacterCard.stateThrough` / `stateHash`。
- Create `src/core/model/continuity.ts`：`ContinuityFact`、`parseContinuityFacts`、`renderContinuityFacts`、`attachEvidence(statements, text, entities)`（bigram，返回 `{ facts, dropped }`）、`locateEvidence(text, quotes)`（段落視窗，返回 `{ passages, located }`）。
- Create `src/core/model/characterState.ts`：`stateHashOf`、`stateOwnedByMachine`、`stampState`。
- `model/markdown.ts`：`replaceSection(text, key, value)`（沒有這一節就追加在末尾）。
- `model/pipeline.ts`：`FINALIZE_CALLS`；`deriveNextStep` 的定稿那一檔改成「定稿第 N 章」；`WRITE_BATCH_DEFAULT = 3`、`WRITE_BATCH_MAX = 10`、`planWriteBatch`。
- `model/project.ts`：`listCharacters` 讀兩個新欄位，`renderCharacterCard` 寫它們；`emptySummarySections` 加一項。
- 測試：掛證據命中 / 人名過濾 / 找不到丟棄 / 上限 12 條；解析手改寫法；定位原文的視窗與合併；歸屬判據四種情形；`replaceSection` 保留其餘小節與 BOM；`planWriteBatch` 跳過已寫、遇到無細綱收住、上限 10、兩種模式的呼叫次數。

### Task 3：定稿（commit 3）

- `features/summarizePrompt.ts`：契約加「連續性事實」。`features/summarize.ts`：解析它、掛證據、落盤；`summarizeChapter` 返回 `SummaryData | undefined`。
- Create `src/core/features/characterState.ts`：`updateCharacterStates(project, chapter, cast, llm, …)`、`reviewCharacterState(project, relPath)`（對比入口）。
- Create `src/core/features/finalize.ts`：`finalizeChapter(project, chapter, opts)`，返回呼用次數與結果。
- 機器寫「當前狀態」的幾處蓋章：`generation/accept.ts` 的 `acceptRoster`，`features/characterCard.ts` 採納更新之後，`features/characters.ts` 建卡。
- `views/cast.ts` 匯出按名字認卡的那張表（`cardsForCast`）。
- `controller/project.ts` 的 `finalizeChapter` 走新函式；`characterAction` 加 `reviewState`；`tools/novel/run.ts` 的 `summarize` 走新函式並按實際次數記賬。
- 測試（整合）：摘要帶連續性事實與證據、找不到的丟了並記日誌；狀態更新寫進機器的卡、只動那一節；手改過的不寫 + 黃 ❗ + 對比後採用 / 放棄；沒人有卡時只調 1 次；不回退到更早的章；狀態那一步失敗時摘要照樣在。

### Task 4：evidence 層（commit 4）

- `context/types.ts`：層 `evidence`、條目種類 `evidence`；`Assembly.scratch.evidence`。
- `context/layers/background.ts`：`evidence` 層；`manuscriptFull` 去重；`characters` 的 note 帶狀態截至第幾章。
- `context/recipes.ts`、`context/builder.ts`：配方與小節。
- 測試：前 5 章全取、更早只取涉及本章角色、12 章上限、6000 字封頂的丟棄說明；定位不到降級；整章全文進來時去重；上一章未定稿的那一條明細。

### Task 5：批次寫章（commit 5）

- `runtime/progress.ts`：`pausable`、`stopRequested`、`finish`、`requestStop`、`onTaskFinished`。
- `protocol/`：`stopAfterItem`、`taskDone`、`projectAction.mode`。`controller/`：轉發。
- `generation/generate.ts`：匯出 `planWriting`（批次要同一份「寫法、目標、上一章結尾」）。
- `features/pipelineBatch.ts`：`writeManuscripts` 按 §5 重寫。
- `tools/novel/run.ts`：`batchManuscripts` 的說明與記賬。
- 測試（整合）：只寫正文連寫 3 章；寫完即定稿；已有正文跳過；無細綱收住；中間一章失敗即停；重演 / 未寫夠落盤後停並掛黃 ❗；寫完這一章就停；取消時這一章不落盤；續寫那幾輪不換模型；完成提示帶「開啟第 N 章」。

### Task 6：前端（commit 6）

- `shells/shared/panes.ts`：`#taskList` 挪出工程頁，新 `taskBar()` 由兩個殼放在頁頭（外掛在標籤欄下、獨立版在側欄頂上）。
- `media/src/view/tasks.ts`：「寫完這一章就停」；`taskDone` 出帶按鈕的提示（`toast.ts` 支援一個動作按鈕）。
- `media/src/view/forms.ts`：W9 批次寫章彈窗（區間、模式；「寫完即定稿」的提交鍵兩段式，`form.ts` 加 `confirm`）。工程頁工具欄加「批次寫章…」，章節組右鍵換成它。
- 定稿按鈕的呼叫次數（章節條、右鍵）；角色行說明帶「狀態截至第 K 章」、右鍵「對比第 N 章給出的狀態…」。
- CSS 同步；`verify-css`。
- DOM 測試：任務條在對話頁也看得見；「寫完這一章就停」發 `stopAfterItem`；完成提示的按鈕發 `openChapter`；彈窗的實時說明與呼叫次數、上限 10、兩段式提交只在第二下發訊息。

### Task 7：驗收用例（commit 7）

`tests/integration/features/serialBatch.test.js`：從排好前 5 章細綱的工程起，工程頁「批次寫章」第 1–3 章、寫完即定稿，假模型按指令碼應答。斷言：

- 磁碟上三章正文與三份摘要，摘要裡有連續性事實且每條帶證據；
- 第 2 章定稿后角色卡的當前狀態換成了第 2 章給出的那一版，`stateThrough: 2`；
- **第 3 章寫正文那一次的裝配裡**：角色卡是第 2 章更新過的狀態，`evidence` 裡有第 2 章證據所在的那一段原文；
- 作者在第 1 章之後手改過一張卡的當前狀態：第 2、3 章定稿都沒覆蓋它，卡上掛黃 ❗；
- 總呼叫次數與確認框報的上限對得上（實際 ≤ 上限）。

### Task 8：README（commit 8）

只改本期動過、現在描述已經錯了的段落：model、context、features、runtime、generation、protocol、media、shells、tests。

---

## 驗收

- `npm run typecheck`、`npm run test:node`、`npm run test:e2e` 全綠。
- Task 7 通過。
- 獨立版開啟一個排好細綱的工程：工程頁「批次寫章…」彈窗寫著區間、模式與呼叫上限；跑起來切到對話頁也看得見進度條與「寫完這一章就停」；跑完有「開啟第 3 章」。

## 給接手 agent 的提示詞

> 你在 `~/workspace/novelForge` 的 `refactor/blueprint-pipeline` 分支上做「四期：定稿 + 證據 + 序列批次」。先讀 `docs/design/plans/2026-09-30-blueprint-pipeline-phase4.md` 全文、根目錄 AGENTS.md、總計劃的 §1（#13–#15）、§2.3、§3.3 的 W8 / W9 與 §4，以及三期計劃的 §3、§9。上游原始碼在 `~/workspace/AI-Novel-Writer`，移植的演算法與提示詞在註釋裡註明出處。按 Task 2→8 順序做，每個 Task 一個 commit（中文正文，結尾帶 Co-Authored-By 行），不要推送。每個 commit 前跑 `npm run typecheck`；Task 3、Task 5、Task 7 結束時跑 `npm run test:node`，Task 8 結束時再跑 `npm run test:e2e`（Bun 在 `~/.bun/bin`）。真實模型冒煙要花錢，跑之前必須先找作者確認。遇到計劃裡沒寫到、又會改變產品行為的決定，停下來問。
