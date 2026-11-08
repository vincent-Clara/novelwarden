# 上下文詳細度（四級開關）

> 2026-10-15。單獨一件，**在 main 上直接開發**。起因：作者問「當前專案 LLM 呼叫情況，上下文一般多少」，查下來寫正文第一次呼叫的上下文隨書長一路漲——「更早章摘要」那一層（`context/layers/background.ts` 的 `plotSummary`）沒有章數上限，填到預算滿為止，128k 視窗大約第 80 章撞頂；其餘約 45 個「帶多少」的上限寫死在各層的常量裡，作者調不了。作者要一個開關：分四級，每升一級注入的上下文越多。

**Goal:** 設定頁「上下文管理」裡一個下拉框「上下文詳細度」（1 精簡 / 2 標準 / 3 詳細 / 4 完整）。它決定每一次呼叫帶多少前文與設定：寫作裝配（架構、大綱、細綱、正文、續寫、審稿、修稿）與幾項後臺任務（提取文風、提取角色、參考書學文風、排敘事線、定稿判線、寫前衝突檢查）。任何一級都不改呼叫次數。

## 作者拍板的四件（2026-10-15）

| # | 問題 | 定案 |
|---|---|---|
| A | 開關放哪 | **全域設定**（`~/.novelforge/config.json` 的 `contextDetail`），設定頁「上下文管理」。對話頁、工程頁批次、MCP 都按它裝——它是成本偏好，批次寫章正是最費上下文的地方 |
| B | 現在的裝配對應第幾級、預設哪級 | **現在 ≈ 第 3 級，預設 3**。第 3 級只多一條：更早章摘要封頂 60 章；第 4 級在現在基礎上再多帶；1、2 級逐級減 |
| C | 管哪些呼叫 | **連後臺任務一起分級**（只要是「帶多少材料」的上限；不分級的見下） |
| D | 「注入完整原文章數」「上一章結尾字數」兩個舊設定 | **併入級別，去掉兩個輸入框**；config.json 裡的舊值不再讀 |

## 級別表

第 3 級逐項等於這個開關出現之前寫死的常量（單測釘著）。

| 項 | 1 精簡 | 2 標準 | **3 詳細** | 4 完整 | 從前在哪 |
|---|---|---|---|---|---|
| 近章全文 | 0 | 1 | 2 | 3 | `config.recentChaptersFullText` |
| 上一章結尾 | 1000 | 1500 | 1500 | 2000 字 | `config.prevChapterTailChars` |
| 更早章摘要 | 5 | 20 | **60**（新） | 不限 | 無上限 |
| 定稿原文片段：全取 / 最多幾章 / 字數 | 不帶 | 3/6/3000 | 5/12/6000 | 8/20/10000 | `EVIDENCE_*` |
| 近章連續性事實（含寫前衝突檢查） | 6/1500 | 8/2000 | 12/3000 | 20/5000 | `RECENT_FACTS_*`、`PLOT_CHECK_*` |
| 敘事線 | 3/600 | 4/900 | 6/1200 | 8/1800 | `ACTIVE_THREAD_*` |
| 前序細綱一覽 | 30 | 50 | 100 | 不限 | `PLOT_LIST_MAX` |
| 細綱單章前 / 後幾章 | 1/1 | 2/1 | 3/1 | 5/2 | `PREV_PLOTS` / `NEXT_PLOTS` |
| 歷史封頂 | 15% | 20% | 30% | 40% | `HISTORY_CAP` |
| 角色卡只帶要點 | 是 | 否 | 否 | 否 | — |
| 挑出場角色看前幾章摘要 | 1 | 2 | 2 | 3 | `render.ts` 寫死 2 |
| 拆書補齊抽樣 | 3 | 4 | 5 | 8 | `SAMPLE_COUNT` |
| 提取文風預設勾前幾章 | 1 | 2 | 2 | 3 | `style.ts` 寫死 2 |
| 提取角色預設勾最近幾章 | 1 | 2 | 3 | 5 | `characters.ts` 寫死 3 |
| 參考書文風抽幾章 | 3 | 4 | 5 | 8 | `STYLE_SAMPLES` |
| 排敘事線：大綱字數 / 每行事件字數 | 4000/60 | 6000/90 | 8000/120 | 12000/200 | `OUTLINE_CHARS` / `PLOT_LINE_EVENTS` |
| 定稿判線最多幾條 | 6 | 9 | 12 | 16 | `THREAD_JUDGE_LIMIT` |

**不分級**：後 5 章邊界（`AHEAD_PLOTS`，生成層 `notYetOf` 用同一個視窗）、本章已寫末尾 1600 字、@ 引用 35%、`settle` 歷史 60%、單輪歷史 12%、整份帶的文件層；單章摘要、全書摘要、角色狀態、建卡、設定掃描（輸入就是那一章本身或按視窗分批）。

探查實測（`~/workspace/project-scripts/novelforge-context-detail/probe.js`：100 章假工程，每章約 3000 字、摘要約 700 字，沒有設定與文風；改動前的裝配器取 HEAD 匯出的一份，同一個工程各裝一次「寫第 N 章」的第一次呼叫，估算 token / 預算 119296）：

| 寫到 | 改動前 | 1 精簡 | 2 標準 | 3 詳細 | 4 完整 |
|---|---|---|---|---|---|
| 第 10 章 | 19986 | 8674 | 16011 | 19986 | 23013 |
| 第 30 章 | 38624 | 8685 | 26638 | 38624 | 44198 |
| 第 64 章 | 68646 | 8685 | 26640 | 67765 | 74220 |
| 第 100 章 | 99217 | 7468 | 25423 | 66564 | 104791 |

第 10、30 章第 3 級與改動前 messages **逐字一致**；第 64 章起差在摘要封頂 60 章。第 100 章各級少的那一截是後 5 章邊界沒了（假工程只排到第 100 章）。

## 落在哪

| 模組 | 做了什麼 |
|---|---|
| `model/contextDetail.ts`（新） | 級別、說法、凍結的級別表、`normalizeContextDetail`、`contextLimitsOf`（唯一解析入口，疊上 `contextOverrides`）、`takeLast`、`describeContextDetail`。零 import，前端經 `media/src/protocol.ts` 打包 |
| `config.ts` / `model/types.ts` | `NovelConfig.contextDetail`（認不出回落 3，warn 一次）+ 只給程式碼與測試的 `contextOverrides`；`setContextLimitsOverride` 測試鉤子；兩個舊鍵進 `RETIRED_KEYS`，下次儲存清掉 |
| `context/builder.ts` / `layers/*` | `Assembly.detail` / `limits`；各層從 `a.limits` 取；摘要封頂之外合成一條 `plotSummary:beyond`；「精簡」一條 `evidence:off`；角色卡只帶要點；`BuiltContext.detail` |
| `features/style.ts` `characters.ts` `reference.ts` `threads.ts` `plotCheck.ts` | 從 `contextLimitsOf(readConfig())` 取預設取章、抽樣、排線與判線、衝突檢查的上限 |
| `model/threadsFile.ts` / `model/plotCheck.ts` | `threadsToJudge`、`selectCheckFacts` 收上限引數；原常量改成第 3 級的別名，給純函式當預設值 |
| 設定頁 / 協議 | `SettingsPayload.contextDetail`；`panes.ts` 換成下拉框 + 說明行；`settings/index.ts` 填選項、標髒、儲存；刪掉兩個數字輸入框 |
| 顯示 | 裝配清單標題行「· 詳細度：詳細」（`SerializedDigest.detail`，舊會話沒有就不說）；「上下文已裝配」日誌；批次寫章確認框 |
| 清理 | `package.json` 兩條 `novel.*` 宣告、`shells/vscode/migrate.ts` 兩個鍵、`sample-novel/.vscode/settings.json` 兩行 |

## 自定的取捨（⚑，收尾時報給作者）

1. ⚑ **封頂之外的摘要合成一條 dropped**（「第 1–N 章 · 摘要」），不一章一條：一百多章封在 5 章時，九十幾行「不帶」會把真正帶了什麼淹掉。
2. ⚑ **封頂按「最近幾章」數**：作者手動取消勾選的那一章照樣佔一個名額（不往前補）。
3. ⚑ **「精簡」不帶定稿原文片段時出一條 `evidence:off` 說明**；隨之，D23 那條「上一章還沒定稿」的說明在「精簡」下也不出（角色卡上的「狀態截至第 K 章」還在）。
4. ⚑ **原有的上限說明措辭不改**（「敘事線一次只帶 6 條」「定稿原文片段一共只帶 6000 字」），數字跟著級別；只有新加的說明寫出級別名。前序細綱一覽那條「只帶最近 N 章」後面加了「（上下文詳細度「X」）」。
5. ⚑ 下拉框裡第 3 級標「（預設）」；說明行寫這一級具體帶多少。
6. ⚑ 認不出的級別（手改 config.json 寫成 5、"3"）回落第 3 級，日誌 warn 一次。
7. ⚑ 批次寫章的確認框寫一行當前級別。
8. ⚑ **測試用單項覆蓋**（`contextOverrides` / `setContextLimitsOverride`）而不是從 config.json 讀一個隱藏鍵：作者能動的只有級別，舊的兩個數字不該換個名字又回來。
9. ⚑ **批次跑到一半改級別只部分生效**：寫章那條鏈開頭讀一次配置，寫前衝突檢查、定稿判線每次現讀——與 `requestTimeoutMs` 一樣。
10. ⚑ **摘要封頂對大綱、細綱階段同樣生效**（那兩張配方也有 `plotSummary`）：第 151 章往後排細綱，「詳細」只看最近 60 章的摘要 + 全書摘要。
11. ⚑ 視窗小的模型上「完整」不一定帶得更多：歷史 40% 與三章全文先佔預算，更靠後的層更早被擠掉（明細看得到）。
12. ⚑ 不做從舊值到級別的遷移（作者定的 D）：設定頁儲存過的人舊值都在檔案裡，分不清是不是手改的。

## 驗收

- typecheck 零錯誤；`test:node` 全過；e2e 全過。
- 新測試：`unit/model/contextDetail.test.js`（表、容錯、config 讀寫與清舊鍵）、`integration/context/contextDetail.test.js`（四級各裝一次）、`integration/features/contextDetailDefaults.test.js`（文風 / 角色預設取章）、`dom/view/contextDigest.test.js`（裝配清單寫級別）；`threadsFile` / `plotCheck` / `reference` / 設定頁 DOM 測試各補了按級別的用例。
- 沒調真實模型。
