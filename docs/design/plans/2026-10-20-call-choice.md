# 調模型之前的確認框：這一次用哪個模型、帶多少上下文

> 2026-10-20。作者問「能否在每個模型呼叫的確認彈窗中新增選項框：選擇模型和上下文詳細程度」。在 worktree `call-overrides` 裡開發，不考慮向後相容。

## 作者定的（2026-10-20）

| # | 問題 | 定案 |
|---|---|---|
| 1 | 模型下拉框列什麼 | 「按分檔」（預設）+ 所有配好的模型。選了某個模型，這一次的每一次呼叫都用它，**失敗不換人**（與對話頁同一條規矩） |
| 2 | 換了模型，確認框裡報的呼叫次數要不要重算 | **不重算**：次數本來就是估計，切批用的視窗也不跟著換 |
| 3 | 詳細度對這一次不起作用的框 | **不顯示**那個下拉框 |
| 4 | 範圍 | 只改已有的確認框和工程頁兩張批次表單（批次拆細綱、批次寫章）；本來沒有確認框的動作（對話頁傳送、主按鈕、單章定稿、提取角色……）不加彈窗；對話頁不加詳細度下拉框。**2026-10-23 作者追加**：工程頁上點了會調模型、從前不問的幾處都加（見下面「2026-10-23 追加」）；主按鈕、工作臺、對話頁傳送、MCP 照舊不問 |
| 5 | 獨立版確認框只認第一個按鈕（`FileHost.confirm`） | **修**，不調模型的多按鈕確認框一起修 |

## 實施狀態（2026-10-20）

做完了，在 worktree `call-overrides`（分支 `worktree-call-overrides`）。落在哪：

| 模組 | 做了什麼 |
|---|---|
| `model/callChoice.ts`（新） | `CallChoice` / `CallPrompt` / `CallAnswer`、`TIERED_LABEL`、`describeCallChoice`、`normalizeCallChoice`。只 import 零 import 的 `contextDetail.ts`，前端經 `media/src/protocol.ts` 打包 |
| `runtime/callScope.ts`（新） | `withCallChoice` / `currentCallChoice`（`AsyncLocalStorage.run`） |
| `config.ts` / `model/types.ts` | `readConfig()` 讀「這一次」：`contextDetail` 換掉、多 `pinnedModel`；`settingsContextDetail()` 不看「這一次」，給 `ViewState.contextDetail` 用（狀態推送可能就在一次任務的呼叫鏈上） |
| `model/tiers.ts` / `llm/pool.ts` | `refsForTask` 認 `pinnedModel`（`pinned: true`，說「這一次指定」）；池、`budgetForTask` 不用改 |
| `features/askCall.ts`（新） | 唯一的問法；19 處確認框換成它，確認之後的活跑在 `withCallChoice` 裡、重新 `readConfig()`；長的那幾段拆成「問 / 跑」兩個函式（`runPlotBatches`、`fillSettings`、`runWriteBatch`） |
| `host.ts` + 三個殼 | `Host.confirmCall`；獨立版 `prompt` 多 `actions` / `call`、`promptResult` 多 `choice`、`PromptHub` 交回整份回答；VS Code 多一顆「換模型 / 詳細度…」；命令列不問 |
| 協議 / controller | `projectAction.confirmed` → `call`；`ViewState.contextDetail` |
| 前端 | `view/callFields.ts`（新）、`form.ts` 的 `buildSelect`（認 `optgroup`）、`prompt.ts` 多按鈕 + 下拉框、兩張批次表單 |
| `skills/novelwarden-autopilot` | 驅動指令碼跟著協議改：確認框答第一顆按鈕上的字，批次帶 `call: {}` |

## 選擇掛在哪：呼叫鏈上的一層「這一次」

確認框之後的活跑在 `withCallChoice(choice, fn)`（`runtime/callScope.ts`，`AsyncLocalStorage`）裡。**`readConfig()` 是唯一讀它的地方**：

- `contextDetail` 換成作者選的那一級，於是裝配器、排敘事線、寫前衝突檢查、定稿判線……凡是經 `contextLimitsOf(readConfig())` 取上限的，一個不落都跟著變；
- 多一個 `pinnedModel`。`refsForTask` 看到它就只給這一個模型（`pinned: true`），模型池、`budgetForTask`、確認框與日誌的說法都從這裡取，不另開一條路。

不把選擇一路當引數遞下去：確認框之後要讀配置的地方散在十幾個函式里（`planThreads`、`recordThreadEvents`、`plotCheck`、`createModelPool`……），漏掉一處就是「彈窗上寫著精簡、實際按詳細裝」。`AsyncLocalStorage` 獨立版的 `scopedHost.ts` 已經在用（Bun 認 `run`），同時跑的別的任務各在各的上下文裡，互不串。

規矩：

- **確認框之前讀的 `config` 不能帶進確認框之後**——作者的選擇在那之後才有。確認之後一律在 `withCallChoice` 裡重新 `readConfig()`。
- 選擇只管這一次，不寫回設定。巢狀的那一問（批次拆細綱拆完再問展開、批次寫章補建角色卡再問一次、重建全書摘要選「先同步細綱」）開啟時預設就是外面那一次的選擇。
- 選了「按分檔」= 不釘模型（外面釘了也解開）；沒顯示詳細度下拉框 = 沿用外面那一次或設定頁。
- 釘了模型也不帶思考深度（第 26 條不變）。

## 宿主：`Host.confirmCall`

（型別在 `model/callChoice.ts`，與 `contextDetail`、`thinking` 同一個位置：協議只 `import type`。）

```ts
confirmCall(message, actions, opts: { detail?: string; call: CallPrompt }): Promise<CallAnswer | undefined>
// CallPrompt = { models, model, tiers, contextDetail? }   CallAnswer = { action, choice: CallChoice }
```

`CallPrompt` 由 `features/askCall.ts` 的 `askCall()` 統一拼：模型清單（`listModelChoices`，與對話頁下拉框同一份）、開啟時選著哪個、「按分檔」時每項活交給誰（`describeTaskModels`，從前各處手抄進 `detail` 的那幾行收到這裡）、詳細度（`contextDetail: true` 的框才給）。

| 宿主 | 怎麼問 |
|---|---|
| 獨立版 / 桌面版 | 網頁彈窗：說明、補充說明，然後兩個下拉框（「按分檔」時下面列出各項活交給誰），**每個動作一顆按鈕** + 取消。`prompt` 訊息多 `actions` 與 `call`，`promptResult` 多 `choice`；確認框回的是按鈕上的字，取消回 `undefined`（不再是 `yes` / `no`） |
| VS Code | 原生模態框放不了下拉框：多一顆「換模型 / 詳細度…」，點了依次彈 QuickPick，選完回到模態框，補充說明末尾寫著「這一次：……」 |
| 命令列（只給 `novelforge init`） | 不問模型與詳細度；多個動作時編號選 |

## 工程頁兩張表單

「批次拆細綱」「批次寫章」加同樣兩個下拉框（選項來自 `ViewState.models` 與新加的 `ViewState.contextDetail`），提交時 `projectAction` 帶 `call: CallChoice`——**它取代了 `confirmed: true`**：帶了就是表單已經問過，後端不再彈第二個框。批次寫章要補建角色卡時照舊再問一次，預設是表單上的選擇。

## 哪些框帶下拉框

模型下拉框每個都有；詳細度只在這一次的上下文看它時出現（✓）。

| 確認框 | 任務（檔） | 詳細度 |
|---|---|---|
| 批次拆細綱（MCP 那條路；工程頁走表單） | plotOutline | ✓ |
| 補齊架構 | setting | ✓ |
| 批次寫章 | manuscript、plotSummary，按需 review / plotOutline / characterCard | ✓ |
| 從細綱排出敘事線 | plotOutline | ✓ |
| 批次展開設定 | setting | ✓ |
| 從已寫正文補齊 | setting、plotOutline、characterCard、loreSynthesis、plotSummary | ✓ |
| 立即同步 | plotSummary、characterCard | ✓（定稿判線的條數） |
| 章節右鍵「定稿」「重新定稿」（2026-10-23）：模型預設是對話頁那個，不是「按分檔」 | plotSummary、characterCard | ✓（同上） |
| 重建全文大綱 · 都定稿過時（2026-10-23） | globalSummaryStage、globalSummaryMerge | |
| 提取文風 · 第一次（2026-10-23，按鈕「開始提取」；已有內容時仍是「覆蓋」） | extractStyle | |
| 提取角色卡（2026-10-23，挑完章之後） | extractCharacters | |
| 重寫情節大綱（2026-10-23，問完要求之後） | plotOutline | ✓ |
| 重寫架構其餘幾件、展開設定（2026-10-23，問完要求之後；走對話頁，模型預設對話頁那個） | （無：對話頁那一個模型） | ✓ |
| 從參考書學寫法 | extractStyle | |
| 更新 / 重建所有角色卡、給全部人建卡、單卡更新 / 重建 / 建立 | characterCard | |
| 建設定條目、整合設定、按目錄整理 | loreSynthesis | |
| 記設定 / 補記設定 | loreScan | |
| 從已寫正文補齊 · 先整理細綱 | plotSummary | |
| 重建全書摘要（有沒定稿的章時才問） | globalSummaryStage、globalSummaryMerge | |
| 提取文風 · 覆蓋 style.md | extractStyle | |

不帶下拉框、照舊是普通確認框的：確認框之前的那一問（缺章提醒「仍然繼續」、批次寫章的一致性預檢、角色卡「只讀新增 / 重讀全部」、設定「整理範圍」、匯入原稿「接著補齊」）——後面緊跟著帶下拉框的那一個；以及所有調完模型才問的（採納、覆蓋審閱……）。

## 自定的取捨（⚑，收尾時報給作者）

1. ⚑ 巢狀的那一問預設取外面那一次的選擇（見上）。
2. ⚑ 模型清單是所有服務商的所有模型（與對話頁下拉框同一份），不只是分檔裡配的那幾個。
3. ⚑ 「按分檔」那幾行只在選著「按分檔」時顯示；VS Code 模態框裡兩樣都寫在補充說明裡。
4. ⚑ 釘了模型，這一次裡新建的池用它的視窗切批、截斷（已經算好的批數不重算，同 #2）。
5. ⚑ 獨立版確認框的標題仍是第一顆按鈕上的字。
6. ⚑ 模型下拉框按服務商分組，同對話頁（表單引擎的下拉框原來不認 `optgroup`，這次補上）。
7. ⚑ 從參考書學寫法、提取文風（覆蓋 style.md 那一問）**不給詳細度下拉框**：抽哪幾章在確認框之前就定了、框裡寫著看第幾章，換級別要麼不起作用、要麼讓框裡那句話對不上。
8. ⚑ 從已寫正文補齊的兩問（先整理細綱 → 其餘幾樣）不是巢狀，但第二問預設跟著第一問的選擇（同一件事的兩步）。
9. ⚑ 重建全書摘要只有在有沒定稿的章時才問（「先同步細綱 / 仍然重建」）；沒問時照設定跑，不為它新加一問（作者定案 #4）。選「先同步細綱」時同步那一問預設跟著這裡。
10. ⚑ 獨立版確認框取消回 `undefined`（從前回 `no`）；沒給 `actions` 的老訊息畫一顆「確定」。
11. ⚑ 命令列（`novelforge init`）的確認框：一個動作問 y/N，幾個動作編號選。

## 2026-10-23 追加：工程頁上從前不問的幾處

作者要求工程頁上點了會調模型、從前不彈確認框的都加上。落在哪：

| 入口 | 改法 |
|---|---|
| 章節右鍵「定稿」「重新定稿」 | 新動作 `askFinalizeChapter` → `features/finalize.ts` 的 `askFinalizeChapterTask`：問完在 `withCallChoice` 裡建模型池（`plotSummary` / `characterCard`）再走 `finalizeChapterTask`。按鈕字隨選單（定稿過、正文沒再改的是「重新定稿」） |
| 重建全文大綱 | 都定稿過時也問（從前只有有沒定稿的章時才問，⚑9 作廢）；報批數與次數，一章定稿過的都沒有時不問 |
| 提取文風 | 第一次也問，按鈕「開始提取」；已有內容時仍是「覆蓋」 |
| 提取角色卡 | 挑完章之後問 |
| 架構「重寫…」 | 問完要求之後問；情節大綱按段重寫走 `plotOutline` 檔，其餘幾件在對話頁生成 |
| 設定「展開…」 | 問完要求之後、建空條目之前問（取消不留空條目） |

對話頁那條路（重寫架構其餘幾件、展開設定）本來只認對話頁的模型：`generate()` 沒傳 `provider` 時認 `pinnedModel`（`withPinnedModel`，視窗也換成它的），於是確認框上換的模型只管這一輪。

自定的（⚑，待作者看）：

12. ⚑ 本來就用對話頁那個模型的幾處（章節右鍵定稿、重寫架構其餘幾件、展開設定），模型下拉框預設選著對話頁那個，不是「按分檔」——直接點與從前一樣。
13. ⚑ 對話頁那條路上選「按分檔」等於用對話頁那個模型（那條路沒有檔位），下拉框下面也不列分檔。
14. ⚑ 要先填東西的（提取文風、提取角色卡挑章號，重寫、展開寫要求）先填、後彈確認框，兩問各取消都什麼都不做。
