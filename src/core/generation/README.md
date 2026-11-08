# core/generation — 裝配 + 調模型 + 解析 + 落盤

創作的一次單步：**裝配上下文 → 調模型 → 解析成產物 → 當場問一句，作者點頭才落盤**。

從前這四件事擠在 `features/creation.ts` 的 `CreationSession` 一個類裡，外加第五件——「當前有沒有在生成」。落盤搬進 [`workspace/`](../workspace/README.md) 之後，剩下的應該是純函式，所以這一層**沒有類、沒有欄位、沒有單例**。

| 檔案 | 職責 |
|---|---|
| [generate.ts](generate.ts) | ★ **無狀態**：裝配 → 調模型 → 解析成 `Draft`；另有 `previewContext`（只裝配不調模型）與 `parseDraftArtifact`。 |
| [structured.ts](structured.ts) | ★ **生成鏈**：小說配置、角色圖譜、設定清單等結構化產物的「寫 → 轉寫」與失敗的走法。 |
| [continuation.ts](continuation.ts) | ★ **正文的續寫鏈**：截斷或不到八成就續（最多 7 輪），最後查一遍重演。見下文「寫一章正文」。 |
| [review.ts](review.ts) | ★ **審稿鏈**：按小標題寫、轉寫成 JSON，校驗引文、逐項核對凍結的目標。 |
| [trim.ts](trim.ts) | ★ **刪修飾**：續寫鏈最後一步，同一個模型、溫度 0.3、只許刪，逐段驗收不合格的退回。 |
| [revision.ts](revision.ts) | ★ **修稿鏈**（五期，移植自上游 `refine-from-review` + `refinement-completeness.ts`）：被截斷就接著寫，最多 3 輪；截斷三輪仍沒寫完、或明顯短於原稿，報錯不出卡片。 |
| [accept.ts](accept.ts) | ★ 落盤：按產物分派到八條落盤路徑（架構文件 / 角色圖譜 / 設定清單 / 設定條目 / 情節大綱 / 細綱 / 細綱批次 / 正文）。 |
| [loreSettle.ts](loreSettle.ts) | 落定設定的落盤：按磁碟再認一遍；新的直接建，已有的合併、先對比，水位不動。 |
| [drafts.ts](drafts.ts) | ★ `DraftStore`：還沒落盤的產物，記憶體按會話分桶 + 隨會話 JSON 落盤。 |

## 三條硬約束

### 1. 一個字都不寫磁碟（生成那一半）

`generate` 只把文字交回介面，`accept` 才寫，且只在使用者在那張落盤卡片上點了「寫入」之後（AGENTS 第 19 條）。中間那一步是使用者看著產物決定要不要的機會——少了它，「不靜默覆蓋」無從談起。

**那一問在產出的當下**（`controller/chat.ts` 的 `askArtifact` → `controller/gate.ts`），不是氣泡末尾一顆可以永遠不點的按鈕：拖著不點的話，「過一遍人」就成了一件可以無限拖延的事，而 agent 早接著往下做了。

唯一的例外是失敗記賬（`recordFailure` / `clearFailures`），它寫的是痕跡庫不是內容（第 17 條）。

### 2. `cleanOutput` 只對正文層做

正文由續寫鏈（`continuation.ts`）對每一輪的輸出各跑一遍 `cleanOutput`，其餘層 `full.trim()`。

那幾條正則是為正文寫的（剝開場白、剝章節標題、剝結尾字數統計）。跑在 JSON 產物上會切壞結構——產物裡的 ``` 由 `features/parse.ts` 的 `stripCodeFence` 在**解析時**處理，不在這裡剝。

### 3. 落盤時重新解析，不用 `draft.artifact`

`Draft` 出廠就帶 `artifact` 與 `summary`（省掉了從前三次解析裡多餘的那次：生成時 → 後端畫卡片時 → 落盤時）。但**落盤走的是氣泡裡當下那份文字**：

```
draft.target → accept(project, target, parseArtifact(action, 氣泡裡的文字))
```

使用者可能在氣泡裡改過兩個字再點「寫入」（那份改動經 `editTurn` 已經落在 `turn.content` 上，所以那份文字**答完才取**——取早了拿到的是他改之前那版）。`draft.artifact` 只是生成那一刻的展示快照，`draft.raw` 只是兜底。

**`target` 從 draft 裡取，不由前端傳**——前端猜不出一段討論該寫到哪一層（第 19 條最後一句）。

## 併發控制不在這裡

「已有一個生成任務在進行中」是**排程**的責任：

- 對話頁 → `controller/index.ts` 的 `beginGeneration()` / `stopGeneration()`，`busy` 就是 `currentAbort !== undefined`（兩個獨立狀態遲早對不上，而對不上的表現是「停止按鈕點了沒反應」）
- MCP 呼叫 → 同一把鎖（`controller/mcp.ts`）

`generate` 只收一個 `signal` 往下透傳。

## Draft 為什麼要落盤

`generate` 產出的那份東西一個字都沒寫盤，而它至少要活到作者在落盤卡片上點頭那一刻；外部 agent 手裡的 `draftId` 還可能被它稍後用 `write draftId=…` 拿去寫。

- **存哪裡**：記憶體為主（`Map`，按會話分桶），隨會話 JSON 一起落盤（`.novelwarden/sessions/<id>.json`）
- **不進 SQLite**：第 17 條，庫只放可丟棄的痕跡。draft 是未落盤的內容，但它跟著會話走，會話本來就是 JSON
- **留多少**：一個會話 20 份（`MAX_DRAFTS_PER_SESSION`）。`draft.raw` 與 `ChatTurn.content` 是同一段文字，全留著等於把會話檔案寫兩遍
- **誰裝回記憶體**：`controller/session.ts` 的 `openSession`。換會話時 `dropBySession` 掉上一個，不然開一天面板會攢下幾十份沒人再看的正文
- **容錯**：認不出的草稿在 `model/session.ts` 的 `normalize()` 裡丟掉。氣泡上那份 `ChatTurn.artifact` 是**回放用的記錄**（產出過什麼、落到哪兒了 / 未採納），與草稿在不在無關——它不再驅動任何按鈕

## 一件產物可能要調幾次

小說配置、角色圖譜、設定清單、細綱批次由 `structured.ts` 的鏈拼出來。對話頁第一次呼叫是流式的，後面幾次照樣流進同一個氣泡（每步前面一行「——角色詳情（林昭、沈青）——」；轉寫只加這一行、輸出不流進來），鏈結束後氣泡換成**規範化結果**——將要落盤的樣子（配置是 `config.md` 全文，角色圖譜與細綱批次是規範化 JSON），作者改完再點寫入時按同一套解碼讀回來。

鏈走不下去（清單不合格、漏章、轉寫不成……）拋 `ChainError`：已經收到的輸出留在氣泡裡，報錯，不出卡片，失敗掛在那一章 / 那一件上。卡片上除了形狀，還列出會新建的角色卡、這一輪調了幾次模型、每一處降級（第 2 條）。

## 寫一章正文

寫正文也是一條鏈（`continuation.ts` 的 `completeManuscript`），與上面三條共用 `ChainIO`。

- **寫法**（`model/pipeline.ts` 的 `WriteMode`）由 `generate.ts` 的 `planWriting` 按磁碟定：這一章還沒有正文 → `write`；請求明說接著寫 → `continue`（只寫新增的那一段，裝配器帶本章已寫末尾）；其餘 → `rewrite`（整章，上一版正文經 `revision` 層作底稿）。從前已有正文時一律追加，對話裡發「寫正文」就會把一整章疊到已有的後面。
- **目標字數**：請求給的 → 細綱的 `targetWords` → 配置的每章字數（D6）。都沒有時不自動續寫。
- **續寫**：被截斷、或總字數（`continue` 含已有的）不到目標的八成就續；每一輪帶最後 1600 字、本章細綱、執行卡、後 5 章邊界、近幾章的連續性事實（裝配器的精簡配方），並告訴它已經用了幾次「彷彿 / 猶如 / 宛如」。輪與輪之間在氣泡裡只空一行；丟棄的那一輪經 `ChainIO.reset` 讓氣泡退回；流式期間約 300ms 報一次進度（`onProgress`，controller 轉成 `writeProgress`）。
- **收尾過早時先回退**（五期補遺 §1.1，上游沒有）：正常收尾（`stop: 'end'`）又不夠八成，說明這一章已經收了尾，往後接必然越過它、寫進下一章。續寫先切掉收尾那一場（`model/manuscriptCheck.ts` 的 `rewindPoint`：只按比例切最後約四分之一、最多 600 字，至少留一半），氣泡退回切點，契約說「收尾拿掉了，寫足後按本章細綱約定的結束狀態重新收尾」。一次寫一千字上下的模型一章要這樣走兩三輪，所以可以回退幾次，但每次只在上一輪新寫的那一段裡切；回退那一輪淨多不到 300 字、或者那一段短得沒法切就停，不往收尾後面接；回退那一輪沒寫成就把原結尾放回去。被截斷、閘道器不報收尾原因時照舊往後接。
- **停在半句上算截斷**：只信模型報的收尾原因不夠（百章實驗第 3 章停在「全身」兩個字上，字數過了八成，照樣定稿了）。每一次呼叫之後看結尾那個字（`model/manuscriptCheck.ts` 的 `endsMidSentence`），不是句末標點就按 `maxTokens` 處理：往後接、不回退，新寫的那半截直接接上、不空行（磁碟上「接著寫」的追加同理，見 `workspace/index.ts` 的 `appendText`）。寫完仍停在半句上時 `truncated` 為真，說明裡引出結尾，批次寫章據此停下。
- 「本章不出場」的名單由 `planWriting` 按磁碟給（`WritingPlan.notYet`）。
- **寫完查**（§1.2、§1.3、§1.5，外加百章實驗覆盤的禁用詞）：用到的禁用詞逐個計數記進說明（`planWriting` 給的 `banned`——取自 `views/checkTerms.ts` 的 `readBannedTerms`，內建編輯器的寫作體檢拿的是同一個函式、同一份輸入，作者在編輯器裡看到標出來的就是這裡數的）；比喻詞超上限、拉丁字母縮寫、後面幾章才登場的人寫進了這一次新寫的正文（`ManuscriptChainResult.early`）。只記說明、不改正文。
- **比上游寬鬆：已寫的不丟**。恢復那一輪仍沒進展、最後仍被截斷、最後仍不到八成、某一輪呼叫失敗，都保留已寫的並寫進說明，卡片照樣可以寫入。只有「截斷且正文不到 100 字」（思考把輸出預算吃光）報錯、不出卡片。作者自己點了停止照舊不出卡片。
- **重演**：續寫結束之後查一次（`continue` 不查），上一章結尾按磁碟現讀。命中不拒收：Draft 帶 `replay`，卡片標紅、寫入要點兩下。
- Draft 多帶 `writeMode`、`length`（總字數、目標、新寫多少、續寫幾輪、夠不夠八成）與 `replay`，隨會話落盤——重新整理之後再寫入，「接著寫」不會變成「覆蓋」。
- **批次寫章也走這一條**（四期，`features/pipelineBatch.ts`）：同一個 `planWriting`（已匯出）、同一個 `completeManuscript`，只是換一個走分檔池的 `ChainIO`——第一次呼叫失敗換同檔其餘，之後續寫那幾輪釘住第一次成功的那個模型（一章之內不換人）。批次沒有卡片：重演命中、提前登場、沒寫夠或結尾停在半句上的照樣落盤、掛黃 ❗、批次停下。寫完即審稿（五期補遺 §4）也用 `planReview` 與審稿鏈，呼叫走 `review` 檔、轉寫走「轉寫」那一檔。

## 審稿與修稿

五期。兩者都在正文層，所以最要緊的一條是**別讓審稿掉進寫正文的那幾條路**：`chainOf` 先認 `review`（按舊判據「正文層不是討論就走續寫鏈」，一份審稿 JSON 會被當成正文去續寫、去查重演），`parseDraftArtifact` 對 `report` 形態不解析——審稿那一輪的 Draft 帶 `review`、**沒有 `artifact`**，於是不會出落盤卡片。

- **審稿**：`planReview` 在裝配之前按磁碟讀好這一章的正文、指紋，並從細綱的關鍵事件凍結目標清單（`freezeGoals`），經 `BuildRequest.reviewGoals` 交給裝配器——契約裡給模型的與鏈上校驗用的是同一份。這一章還沒有正文就不調模型、報錯。
- **修稿**：寫法 `revise`。`planWriting` 按磁碟讀整章原文，與 controller 拼好的勾選清單（`BuildRequest.reviseBrief`）一起放進 `revision`；原稿的字數當進度條的目標（不據此續寫）。續寫只看截斷：修稿沒有「寫夠」這一說，原稿多長它就該多長。
- **與寫章相反：報錯就不出卡片**。寫章時那一版是新東西，半截也比沒有強；修稿是拿它**覆蓋**一章已經寫好的正文，截斷三輪仍沒寫完、或者不到原稿（封頂每章字數）的六成，覆蓋上去就是把作者的後半章弄丟了。已經收到的文字留在氣泡裡。

## 不在這裡寫裝配

`context/recipes.ts`、`context/prompts.ts`、`context/layers/`、`context/builder.ts`、`features/artifact.ts` 是裝配與解析的唯一一份。生成鏈重新裝配時也走 `buildContext`（換 `range` / `step` / `draftPlots`），不在這裡手拼 prompt；只有語法修復與「全域要求」欄位重寫兩條訊息不經裝配器——它們不需要上下文，給多了反而會讓模型「順手」補內容。

## 逐字保留的四件事

從 `CreationSession` 搬過來時一個字都沒改：

1. `logAssembly` 的日誌格式（token 數、降級/丟棄明細）——**絕不記 prompt 全文**，那是十萬字級的東西，一次就能把日誌緩衝擠空
2. `cleanOutput` 的呼叫位置（見上）
3. `recordUsage` / `describeUsage` 的呼叫位置——實測用量是校準 tokenCounter 的唯一來源
4. 失敗時 `recordFailure` 掛在**細綱**上、成功時 `clearFailures`（第 16 條）。取消不算失敗——那是使用者自己點的

## 依賴關係

依賴 `context/`（裝配）、`llm/`（provider）、`workspace/`（落盤）、`features/artifact.ts`（解析）、`model/`、`runtime/`。被 `controller/chat.ts`（對話頁）、`tools/novel/generate.ts`（agent）與 `shells/vscode/quickContinue.ts`（命令面板的快速續寫，落在下一可寫章）呼叫。**不認識 `agent/`**——依賴方向嚴格自下而上。
