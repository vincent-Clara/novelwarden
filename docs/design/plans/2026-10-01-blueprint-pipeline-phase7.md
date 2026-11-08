# 七期：敘事線 Implementation Plan

> **接手須知：** 這份計劃面向新的 agent，假設你**沒有讀過**前面的對話。開工前必讀：
> 1. 根目錄 [AGENTS.md](../../../AGENTS.md)：本期直接關係到第 1、2、3、4、11、12、16、17、19、20 條。
> 2. [總計劃](2026-09-30-blueprint-pipeline-roadmap.md) 的 §1 #22、§2.3（正文那一行）、§5 七期。
> 3. [四期計劃](2026-09-30-blueprint-pipeline-phase4.md) 的 §1（連續性事實）、§3（定稿）、§4（`evidence` 層）：敘事線的事件掛在定稿上，寫法照著 `evidence` 層。
> 4. 上游原始碼：`~/workspace/AI-Novel-Writer`（GPL-3.0，源自 AI_NovelGenerator），敘事線在 `src/shared/narrative-thread.ts`、`src/services/narrative-thread-candidate-generator.ts`、`electron/repositories/narrative-thread-repository.ts`、`generate-draft.command.ts:1452-1498`。移植處在註釋裡註明出處。
>
> 六期計劃裡標 ⚑ 的 4 處，作者 2026-10-01 已全部認可。本計劃新標 ⚑ 的照舊是自定、收尾時報給作者確認的。
>
> 每個 Task 做完立刻 commit，commit 之間 `npm run typecheck` 必須零錯誤。

**Goal:** 跨章的伏筆與線索有一個地方記：`.novelforge/threads.md`，每條線寫著型別、計劃在第幾章埋下、第幾章前回收、作者意圖，以及正文裡推進到哪一步（事件，每條帶一句逐字原文）。工程頁一個動作從細綱排出 3–8 條線（1 次呼叫）；定稿時多一步，判這一章推進了哪幾條（0–1 次呼叫，證據逐字校驗）；寫正文時挑最多 6 條和本章有關的線帶進上下文（≤1200 字），並寫明「沒到回收章不許提前揭開」。

**Architecture:** 純函式先行（檔案格式的解析與外科式追加、狀態推導、挑線、事件校驗），再是兩個調模型的動作（排線、定稿第三步），然後是裝配的 `threads` 層，最後是工程頁那一行、驗收與文件。

**Tech Stack:** TypeScript、`node:test`、jsdom、Bun（e2e）。不新增依賴。

## Global Constraints

- `src/core/` 零 `vscode` import；分層契約測試全程要綠。
- **容錯**（第 1 條）：`threads.md` 是作者的 Markdown，怎麼手改都不許崩。認不出的行原樣留著、不當成線也不當成事件。
- **機器只追加、不改寫**（第 3 條）：排線只在檔案末尾追加新線，定稿只在某條線的事件列表末尾追加事件行。作者寫的字（包括自加的行、改過的意圖、刪掉的事件）一個都不動，不整份重渲染。
- **不靜默截斷**（第 2 條）：挑線時因為 6 條 / 1200 字放不下的線、定稿時證據找不到而丟掉的事件，一律進明細或日誌與完成提示。
- **動手之前寫明呼叫次數**（第 4 條）：排線「預計 1 次」；定稿「預計 1–3 次」；批次寫章的上限跟著變。
- **SQLite 只放可丟棄的痕跡**（第 17 條）：敘事線是內容，只落 Markdown。
- 本期結束時 `npm run typecheck` + `npm run test:node` + `npm run test:e2e` 全綠。**不調真實模型**。

---

## 本期定下的東西

標 ⚑ 的是本期自定的取捨，收尾時報給作者。

### 1. 檔案格式（`model/threadsFile.ts`）

```markdown
# 叙事线

> 跨章的伏筆與線索。……（模板裡的說明，解析時忽略）

## 玉佩的來歷
- 型別：伏筆
- 計劃：第 2–8 章
- 意圖：林昭身上的玉佩是沈家舊物，第 8 章前揭開他的身世。
- 事件：
  - 第 3 章 · 埋下：「他摸了摸懷裡那塊溫潤的玉佩」——玉佩第一次露面
  - 第 5 章 · 推進：「沈青盯著那道雲紋看了很久」——沈青認出了紋樣
```

- 一個 `## ` 標題是一條線，標題就是線的名字（同名按審稿引文那套歸一化判，`model/review.ts` 的 `normalizeQuote`）。
- 「計劃：第 a–b 章」= 從第 a 章埋下、到第 b 章前回收（上游 `targetStartChapter` / `targetEndChapter`，UI 上叫「計劃埋設」「預計回收」）。容錯：`第2-8章`、`2~8`、`第 5 章`（a = b）都認；缺了就是沒有區間。
- 事件行：`第 N 章 · 型別：「證據」——理由`。型別四種：**埋下 / 推進 / 回收 / 放棄**（上游 `planted / progressing / resolved / abandoned`）。容錯：分隔符寫成 `-`、空格、半形冒號，引號換成別的，證據或理由缺了，都認；沒有章號的行不算事件（原樣留著）。事件行寫在 `- 事件：` 下面縮排，或直接寫成頂格的 `- 第 N 章 …` 都認。
- **狀態不落盤**（與流水線狀態同一個口徑）：取章號最大的那條事件的型別，同章取寫在後面的那條；沒有事件就是「計劃中」。狀態五種：計劃中 / 已埋下 / 推進中 / 已回收 / 已放棄。已回收、已放棄是「收了的」，不再帶進上下文、不再判事件。作者想放棄一條線：加一行 `第 N 章 · 放棄：——不寫了`，或者整條刪掉。
- 外科式寫入兩個純函式：`appendThreads(raw, threads)`（檔案末尾追加，檔案空或不存在時先寫模板頭）與 `appendEvents(raw, title, events)`（找到那條線，插在它最後一條事件後面；沒有 `- 事件：` 就補一行）。原檔案的換行符（CRLF）、BOM、其餘行原樣保留。

### 2. 排敘事線（`features/threads.ts` 的 `generateThreads`，新）

- ⚑ **是工程頁動作，不進主按鈕、不走寫入卡**。敘事線是可選的（第 20 條只推一個下一步，不能拿它擋路）；它只往檔案末尾**追加新線**、同名的跳過、已有的不改——這是第 19 條的批次路徑（只補空白、不問、不覆蓋），確認框寫明「預計 1 次呼叫」。入口：工程頁「文風與摘要」組的「敘事線」一行（行內按鈕 + 右鍵）、agent 的 `run generateThreads`（同一個確認框）。
- ⚑ 走「劇情細綱」檔（`plotOutline`）：排線和拆細綱是同一種活——在大綱與各章計劃之間排跨章的東西。不新增檔位（設定頁那張表不動）。
- 輸入（修上游 #10：上游只給**一章**藍圖、不給已有的線）：小說配置的規模與一句話、故事前提（「懸念骨架」就在這裡）、情節大綱、**全部已排細綱**（一行一章：章號、標題、本章目的、章末鉤子，關鍵事件截短）、已有的線（名字 + 區間，叫它別重複）。超出輸入預算時從細綱一覽的最後截，截了寫日誌。
- 提示詞移植上游 `narrative-thread-plan-candidate` 的系統提示（「只從章節藍圖提出可供作者確認的伏筆與敘事線索計劃，不得聲稱正文事件已經發生……優先提出 3–8 條真正有用的候選；不足 3 條時不要湊數」），輸出 `{"threads":[{"title","type","from","to","intent"}]}`。
- 校驗（修上游 #8：上游先截到 8 條再校驗，前面幾條壞了後面好的也丟）：先逐條校驗再取前 8 條。名字 1–30 字、型別 1–12 字、意圖 1–200 字；`1 ≤ from ≤ to`，配置裡有總章數時 `to ≤ 總章數`；名字與已有的線、與同一批裡前面的重名就跳過。一條都不合格 → 失敗，掛紅 ❗ 在「敘事線」那一行上（第 16 條）。
- 剝程式碼圍欄、寬鬆取 JSON（`features/parse.ts`），不做修復重試：1 次就是 1 次，壞了作者再點一次。
- 完成提示「排出 5 條敘事線（同名跳過 1 條），已追加到 threads.md」，並開啟檔案。

### 3. 定稿第三步：本章推進了哪幾條線（`features/threads.ts` 的 `recordThreadEvents`）

```
定稿第 N 章
  1. 摘要（1 次）
  2. 角色狀態（0–1 次）
  3. 敘事線（0–1 次）：還沒收的線 → 判本章推進了哪幾條 → 證據逐字校驗 → 追加事件
```

- ⚑ **定稿時自動做、直接寫**（上游要作者在編輯器裡一條線一條線手動點「AI 識別定稿事件」再逐條確認）。理由與 D15 角色狀態同一個：批次「寫完即定稿」時沒人看，而事件只是**追加**一行帶原文的記錄，不吞任何東西；證據逐字校驗就是那道閘。這一條寫進第 19 條的例外清單。
- 一次呼叫判所有還沒收的線（上游一次只判一條）。送哪幾條：狀態不是已回收 / 已放棄的線，按 §4 的順序排，最多 12 條（多出的寫日誌）。一條都沒有（沒有 `threads.md`、或者都收了）→ 不調，這一步 0 次。
- 提示詞移植上游 `narrative-thread-event-candidate`（「你是小說定稿事實審查員……證據必須是正文中逐字出現、最多 240 字的短摘錄……最多 5 項」），改成多條線、中文型別：輸出 `{"events":[{"thread","type","evidence","reason"}]}`。
- 校驗（修上游 #11：上游只去空白，一個「。」也算逐字出現）：`thread` 認得出（同名歸一）；`type` 是四種之一；證據按審稿那套歸一化（NFKC、去空白與標點）後在本章正文裡找得到，且歸一後至少 4 個字（`MIN_QUOTE_CHARS`）；證據 ≤240 字、理由 ≤100 字（超了截）；最多 5 條。同一條線、同一章、證據歸一後相同的事件已經有了就不重複記（重新定稿同一章時）。
- 找不到證據、認不出線的事件**丟棄**（與連續性事實同一個理由：沒有原文撐著的多半是編的），丟了幾條寫進日誌和定稿的完成提示。
- 失敗（呼叫失敗、解析不出來）：摘要、角色狀態照樣算數，黃 ❗ 掛在章節上（`op: 'threads'`，與角色狀態那一步同一個做法）。
- ⚑ 用哪個模型：單章入口用對話頁選定的那個（與摘要同）；批次「寫完即定稿」走「單章摘要」檔（`plotSummary`）——它和摘要一樣是「讀一章、按合同摘出東西」，不新增檔位。
- `FINALIZE_CALLS` 改成 `{ low: 1, high: 3, max: 3 }`，說明「摘要 1 次；本章出場的人有角色卡時更新角色狀態 1 次；有還沒收的敘事線時判一次本章推進了哪幾條」。主按鈕、工作臺、右鍵、批次確認框都用它，批次寫章「寫完即定稿」的上限跟著從 10n 變成 11n。
- 任務條三步：摘要 → 角色狀態 → 敘事線（`total: 3`）。

### 4. 寫正文時帶哪幾條線（`threads` 層）

⚑ **挑線**（修上游 #2、#4、#6：上游按建立順序取前 6 條，一條超長的線會讓後面全部丟掉，第 1 章不帶）：

- 候選：還沒收的線裡，滿足任一條的——本章細綱（標題、目的、關鍵事件、章末鉤子）提到了它的名字；本章在它的計劃區間裡；本章已經過了它的回收章；它已經埋下了（有事件）；本章出場的人（細綱 `characters[]`，≥2 字）出現在它的名字或意圖裡。**計劃中、還沒到埋下那一章、細綱也沒提到的線不帶**——帶進去等於提示模型提前埋。
- 排序：細綱提到的 → 本章在區間裡的（回收章近的在前）→ 已過回收章的 → 其餘已埋下的（最近一次推進近的在前）→ 只是人物對上的。同檔按檔案裡的順序。
- 最多 6 條、一共 1200 字（上游 `ACTIVE_THREAD_LIMIT` / `ACTIVE_THREAD_CHAR_LIMIT`）。每行的意圖截到 60 字、證據截到 40 字，一條線不可能一個人吃掉 1200 字；放不下的那條**跳過、接著試下一條**（上游是 `break`），丟的條目 `dropped` 並寫原因（第 2 條）。
- 第 1 章也帶：計劃在第 1 章埋下的線，寫第 1 章的人得知道。
- **狀態按「寫到這一章時」算**（`asOf`）：重寫、重新定稿第 N 章時只看第 N 章之前的事件——後面幾章記下的推進、回收在第 N 章看來還沒發生，帶進去就是把後面的劇情透給前面（與 `evidence` 層只取前面各章同一個道理）。定稿第三步送哪幾條線去判也按這個算。
- 一行長這樣：`- 玉佩的來歷（伏筆 · 已埋下 · 第 2 章埋、第 8 章前收；第 8 章之前不要揭開）意圖：……；最近：第 3 章「他摸了摸懷裡……」`。沒到回收章的線寫「第 b 章之前不要揭開」，本章就是回收章寫「計劃在本章前後回收，以本章細綱為準」，過了寫「已過計劃回收的第 b 章」。狀態用中文，不像上游那樣把英文列舉塞進中文提示詞（上游 #7）。
- 小節標題：`# 進行中的敘事線（只作提醒：以本章細綱為準，細綱沒寫到的線不要硬塞；沒到回收章的線不許提前揭開）`，排在「定稿原文片段」後面、「前文正文」前面。
- 配方：正文層 P1，排在 `outlineSlice` 後面（它和大綱那一節一樣是「計劃」，很短）。續寫、審稿、修稿不帶（續寫只帶「接著寫」真正要看的；審稿判的是正文與細綱）。
- 條目：一條線一個條目，`id` 為 `thread:<序號>`，`label`「敘事線 · 玉佩的來歷」，`note` 寫狀態、區間與為什麼帶它（「細綱提到」「本章在計劃區間內」……）。沒有 `threads.md`、或者沒有一條候選 → 這一層什麼都不出（沒有東西被截斷）。

### 5. 工程頁「敘事線」一行（W2 的延伸）

- 放在「文風與摘要」組（與全書摘要、文風指南同類：一份可選的固定檔案），不進「故事架構」組——那組的 x/5 是主鏈的五件，敘事線不擋路。
- 說明：沒有檔案或一條線都沒有時「未生成」，有了寫「5 條 · 3 條進行中 · 1 條已回收」，已過回收章還沒收的另加「· 1 條已過回收章」（以「下一可寫章 − 1」為當前章）。
- 行內按鈕：沒有線時「從細綱排出」，有了「從細綱補充」，都發 `projectAction('generateThreads')`（後端彈確認框）；還沒有細綱時不給按鈕，說明寫「拆出細綱之後可以從細綱排出」。右鍵：開啟、從細綱排出 / 補充敘事線。失敗的 ❗ 掛在這一行上。
- `ProjectTree` 加 `threadsPath` 與 `threads: { total, open, closed, overdue }`；`threads.md` 每次重新整理只讀一次（`projectTreeReads` 釘著）。

### 6. 周邊

- `workspace/kind.ts`：新種類 `threads`（固定單檔案，排在目錄判定之前，無 stage / target），`docHandler`；`Workspace.writeThreads(text)`。
- `runtime/errorLog.ts`：`FailureTargetKind` 加 `threads`。
- agent 工具：`run` 加 `generateThreads`；`list` 的固定位置加 `.novelforge/threads.md`；`search` 的 `KINDS` 加 `threads`；`naming.ts` 的審閱框說「敘事線」。
- `model/tiers.ts` 的 `TASK_HINT`：`plotOutline` 與 `plotSummary` 兩行補一句「排敘事線」「定稿時判敘事線」。

### 7. 本期不做

- 上游的「沉寂提醒閾值」與沉寂 N 章的徽章：工程頁只報「已過回收章」幾條。
- 編輯、刪除單條事件的介面：就是 Markdown，作者直接改。
- 劇情樹（上游 ADR-0014）、配置變更的影響預覽。
- 拆完細綱自動排線：要調模型，不能不問（第 4 條）。
- 審稿時對照敘事線：五期審稿判的是正文與細綱，不擴。
- sample-novel 不加 `threads.md`（夾具的 hash 斷言與檔案計數不動）。

---

## 提交節奏（8 個 commit）

| # | 字首 | 主題 |
|---|---|---|
| 1 | `docs` | 本計劃 |
| 2 | `feat(model)` | 敘事線檔案：解析、外科式追加、狀態推導、挑線、事件校驗（純函式 + 單測） |
| 3 | `feat(features)` | 從細綱排敘事線：工程頁動作與 agent 的 `run generateThreads` |
| 4 | `feat(features)` | 定稿第三步：判本章推進了哪幾條敘事線，證據逐字校驗後追加事件 |
| 5 | `feat(context)` | `threads` 層：寫正文時帶最多 6 條有關的線，放不下的寫進明細 |
| 6 | `feat(media)` | 工程頁「敘事線」一行 |
| 7 | `test` | 七期驗收——排線、連寫 3 章並定稿，第 3 章的裝配裡有線與第 2 章的事件 |
| 8 | `docs` | README、AGENTS.md 與本期動到的模組 README |

---

### Task 2：純函式（commit 2）

- Create `src/core/model/threadsFile.ts`：`Thread`、`ThreadEvent`、`ThreadStatus`、`THREAD_EVENT_TYPES`、`THREADS_TEMPLATE`、`parseThreads`、`threadStatus`、`isClosed`、`appendThreads`、`appendEvents`、`renderThreadBlock`、`pickActiveThreads`、`renderThreadLine`、常量（`ACTIVE_THREAD_LIMIT = 6`、`ACTIVE_THREAD_CHARS = 1200`、`THREAD_PLAN_LIMIT = 8`、`THREAD_EVENT_LIMIT = 5`）。
- `model/project.ts`：`threadsPath`、`readThreads()`（沒有檔案返回空）。
- `model/pipeline.ts`：`FINALIZE_CALLS` 按 §3（本 Task 只改常量與說明，測試跟著改）。
- 測試 `tests/unit/model/threadsFile.test.js`：幾種手寫格式都認、認不出的行不崩；狀態取最大章號、同章取後寫的；追加線保留原文（CRLF、BOM、作者自加的行）；追加事件插對位置、沒有 `- 事件：` 時補；挑線的候選條件、排序、6 條與 1200 字、放不下跳過接著試；一行的截短。

### Task 3：排敘事線（commit 3）

- `workspace/kind.ts`、`handlers/index.ts`、`workspace/index.ts`（`writeThreads`）；`runtime/errorLog.ts`。
- Create `src/core/features/threadsPrompt.ts`（兩段系統提示，註明出處）與 `src/core/features/threads.ts` 的 `generateThreads(project)`、`parseThreadPlans`。
- `protocol/in.ts` 的 `ProjectAction` 加 `generateThreads`；`controller/project.ts` 分派；`tools/novel/run.ts` 加動作；`list.ts` / `search.ts` / `naming.ts` 的說明。
- 測試（整合）`tests/integration/features/threads.test.js`：確認框寫著 1 次與檔位；追加到檔案末尾、同名跳過、已有的不動；先校驗後取 8 條；區間越界的丟；一條都不合格掛紅 ❗ 且不寫檔案；沒有細綱時不調模型。`runTool.test.js`：`generateThreads` 轉發並記賬。

### Task 4：定稿第三步（commit 4）

- `features/threads.ts` 的 `recordThreadEvents(project, chapter, { run, budget, signal })`、`parseThreadEvents`。
- `features/finalize.ts`：第三步、`FinalizeOptions.threads`（runner）、`onStep('threads')`、`FinalizeOutcome.threads` / `threadsError`、`describeFinalize` 說事件與丟棄；`finalizeChapterTask` 三步進度。
- `features/pipelineBatch.ts`：寫完即定稿時第三步走 `plotSummary` 檔的池。
- 測試（整合）：有線時 3 次呼叫、事件追加到對的線下、證據找不到 / 太短 / 線認不出的丟棄並寫進提示；沒有線或都收了時不調；重新定稿不重複記；這一步失敗掛黃 ❗、摘要與角色狀態照樣在；`finalize.test.js`、`writeBatch.test.js`、`serialBatch.test.js`、`pipeline.test.js` 裡跟著變的次數。

### Task 5：`threads` 層（commit 5）

- `context/types.ts`：層 `threads`、條目種類 `thread`。`context/layers/` 新函式、`layers/index.ts` 註冊、`focus.ts` 若要讀細綱原文、`recipes.ts` 正文配方 P1、`builder.ts` 的小節。
- 測試 `tests/integration/context/threads.test.js`：候選與排序進了訊息、順序對；6 條與 1200 字的丟棄說明；計劃中且沒到區間的不帶；收了的不帶；沒有檔案時這一層為空；續寫、審稿、修稿不帶。

### Task 6：工程頁（commit 6）

- `views/projectView.ts`、`protocol/views.ts`；`media/src/view/project/groups.ts` 的 `buildMetaRows`。
- DOM 測試 `tests/dom/view/projectTree.test.js`：三種說明、兩種按鈕文字都發 `projectAction generateThreads`、沒有細綱時不給按鈕、右鍵選單；`projectTreeReads.test.js`：`threads.md` 只讀一次。

### Task 7：驗收用例（commit 7）

`tests/integration/features/threadsFlow.test.js`：從排好前 5 章細綱的工程起，工程頁「排敘事線」→ 「批次寫章」第 1–3 章、寫完即定稿，假模型按指令碼應答。斷言：

- `threads.md` 裡有排出的線，第 1、2 章定稿各給對的線追加了帶證據的事件，一條偽造證據的事件被丟棄；
- **第 3 章寫正文那一次的裝配裡**有「# 進行中的敘事線」，帶著第 2 章那條事件的證據，計劃中、沒到區間的那條不在裡面；
- 作者手改過的一行（意圖）在三次定稿之後原樣還在；
- 總呼叫次數 ≤ 確認框報的上限。

### Task 8：文件（commit 8）

- 根 README：目錄結構、工程頁「文風與摘要」組、定稿那幾段（三步與次數）、上下文裝配表（P1 加敘事線）、模型分檔表的說明。
- AGENTS.md：開頭的鏈路補「`threads.md`（敘事線，可選）」；第 4 條不動（沒寫死次數）；第 19 條例外清單加「定稿時把本章推進了哪幾條敘事線追加進 `threads.md`（只追加、證據逐字校驗）」。
- 模組 README：model、context（七期那張層表）、features、workspace（種類表）、tools、views、media、tests。

---

## 驗收

- `npm run typecheck`、`npm run test:node`、`npm run test:e2e` 全綠。
- Task 7 通過。
- 獨立版開啟一個排好細綱的工程：「文風與摘要」組有「敘事線 · 未生成」和「從細綱排出」；點了彈確認框寫著 1 次呼叫。

## 給接手 agent 的提示詞

> 你在 `~/workspace/novelForge` 的 `refactor/blueprint-pipeline` 分支上做「七期：敘事線」。先讀 `docs/design/plans/2026-10-01-blueprint-pipeline-phase7.md` 全文、根目錄 AGENTS.md、總計劃的 §1 #22 與 §2.3、四期計劃的 §1、§3、§4。上游原始碼在 `~/workspace/AI-Novel-Writer`，移植的提示詞在註釋裡註明出處。按 Task 2→8 順序做，每個 Task 一個 commit（中文正文，結尾帶 Co-Authored-By 行），不要推送。每個 commit 前跑 `npm run typecheck`；Task 4、Task 7 結束時跑 `npm run test:node`，Task 8 再跑 `npm run test:e2e`（Bun 在 `~/.bun/bin`）。這一期不調真實模型。遇到計劃裡沒寫到、又會改變產品行為的決定，停下來問。
