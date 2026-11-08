# 五期：審稿 + 修稿 + 預檢 Implementation Plan

> **接手須知：** 這份計劃面向新的 agent，假設你**沒有讀過**前面的對話。開工前必讀：
> 1. 根目錄 [AGENTS.md](../../../AGENTS.md)：本期直接關係到第 1、2、3、4、11、12、16、19、20、26 條。
> 2. [總計劃](2026-09-30-blueprint-pipeline-roadmap.md) 的 §1（#16–#19）、§2.2（審稿不進主按鈕）、§2.3 審稿那一行、§3.3 的 W10 / W11、§4（D9、D22）。
> 3. [三期計劃](2026-09-30-blueprint-pipeline-phase3.md) §3（續寫鏈）、[四期計劃](2026-09-30-blueprint-pipeline-phase4.md) §2（角色「當前狀態」與 `stateThrough`）、§5（批次寫章）。
> 4. 上游原始碼：`~/workspace/AI-Novel-Writer`（GPL-3.0，源自 AI_NovelGenerator）。移植處在註釋裡註明出處。
>
> 每個 Task 做完立刻 commit，commit 之間 `npm run typecheck` 必須零錯誤。

**Goal:** 一章寫好之後，作者可以在正文層發 `/审稿`（或點章節條上的「審稿」）：一次呼叫出一份報告——每條問題都帶一句逐字引文，引文在正文裡找不到的條目直接丟掉；本章細綱的關鍵事件與章末鉤子凍結成一張目標清單，逐項判「已完成 / 未完成 / 待核實」，「沒寫到」只能判待核實。報告不落盤，隨會話儲存；報告卡上按嚴重度分組、點引文就在編輯器裡定位到那一句，作者勾選之後點「按勾選的 n 條修稿」——只把勾選的條目連同整章原文交給模型，要求最小改動，被截斷時最多續 3 次，寫完查一遍長度，覆蓋前走 diff。獨立版的覆蓋審閱從一個字數確認框換成段級 diff / 合併檢視：逐段「採用新版 / 保留原文」，結果可以手改，手改過的段不會被「採用」沖掉。寫第 N 章之前先做一次零呼叫的一致性預檢：細綱把一個角色卡上寫著已經死了的人排進了本章，就先在對話頁亮一張卡，作者可以「僅本次忽略」。

**Architecture:** 純函式先行（審稿報告的型別與校驗、目標凍結、引文歸一與定位、修稿清單渲染、預檢、段級 diff、呼叫次數），再是提示詞與三張配方（審稿 / 修稿 / 修稿續寫）及兩個新層，然後是兩條鏈（審稿鏈、修稿鏈）並把審稿從「寫正文」那幾條路里摘出來，再是 controller 與協議（報告存會話、按勾選修稿、預檢卡片、定位引文、覆蓋審閱可以交回合併結果），最後是前端兩件（W10、W11）與驗收。

**Tech Stack:** TypeScript、`node:test`、jsdom、Bun（e2e）。不新增依賴（段級 LCS 自己寫）。

## Global Constraints

- `src/core/` 零 `vscode` import；分層契約測試全程要綠。`model/review.ts`、`model/paragraphDiff.ts`、`model/preflight.ts` **零 import**（前端直接打包）。
- **審稿只出報告、不寫檔案**（D9、D22）：審稿那一輪沒有落盤卡片，報告作為 Draft 隨會話儲存。它**不進主按鈕**（第 20 條），只在正文層的命令面板與章節條上。
- **不靜默截斷**（第 2 條）：丟掉的問題（引文找不到）、降成待核實的目標、修稿時因正文改過而作廢的勾選項、修稿續寫的每一輪，一律寫進 Draft 的 `notes`，卡片與日誌裡看得見。
- **不靜默覆蓋**（第 3 條）：修稿落盤一律走覆蓋審閱；獨立版的合併檢視裡手改過的段，「採用新版 / 保留原文」與「全部採用」都不碰它。
- **動手之前寫明呼叫次數**（第 4 條）：審稿「預計 1 次，最多 3 次」；修稿「預計 1 次，最多 4 次」；預檢 0 次。
- **嚴格用作者選定的模型**（第 12 條、第 26 條）：審稿與修稿都是對話頁的單次生成，用選定的模型與會話的思考深度；工程頁批次任務仍不帶思考。
- 本期結束時 `npm run typecheck` + `npm run test:node` + `npm run test:e2e` 全綠。

---

## 本期定下的東西（寫進程式碼註釋）

標 ⚑ 的幾處是本期自定、**上游沒有或與上游不同**的產品決定，收尾時報給作者確認。

### 1. 審稿能力 `review`

- `Capability` 加 `review`，只掛在正文層：`STAGE_CAPABILITIES.manuscript = ['discuss', 'generate', 'review']`。命令面板裡是「審稿」（別名 `review` / `sg`），不要求輸入：作者寫了話就是「這次重點查什麼」（上游 `review_focus`）。
- 輸出形態加第三種 `report`（`outputKindOf`）：不是可以落盤的產物，也不是自由作答。凡是按「非 discuss 就是產物」判斷的地方（`chainOf`、`cleanOutput`、`parseDraftArtifact`、落盤卡片）都要認它——**否則一份審稿 JSON 會走到寫入卡上、被當成正文寫進章節**。
- 這一章還沒有正文時不審（toast 說明，不調模型）。
- 章節條（W6）加「審稿」按鈕，`ChapterAction` 加 `review`：切到這一章的正文層、按 `review` 發一輪。
- agent 的 `generate` 工具不開放 `review`（與 `settle` 同一個做法：報錯說明要作者在對話頁發起）。報告要作者勾選才修稿，agent 拿到一份報告做不了什麼；六期統一改工具時再定。

### 2. 審稿的裝配（總計劃 §2.3 審稿那一行）

| 層 | 優先順序 | 說明 |
|---|---|---|
| `system` | P0 | 移植 `consistency_check` 的 systemRole + 審查原則 + 檢查維度（PT:917-970） |
| `ask` | P0 | 作者要求重點檢查的維度（可空） |
| `chapterFull` ★ | P0 force | 待審的這一章正文全文（新層） |
| `plotSelf` | P0 force | 本章細綱：目標清單從它凍結 |
| `plotAhead` | P0 | 後 5 章細綱，小標題標「非既定歷史」（上游 `planningMaterial`，只用來判斷本章有沒有提前寫掉） |
| `characters` | P1 | 本章出場角色卡（細綱 `characters[]` + 主角），帶「狀態截至第 K 章」 |
| `premiseWorld` | P1 | 小說配置、故事前提、世界觀 |
| `guidance` | P1 | 全域要求 |
| `prevTail` | P1 | 上一章結尾（「前後章節串聯」那一維要對照它） |
| `recentFacts` ★ | P2 | 前幾章定稿留下的連續性事實（新層，只帶事實文字，不回原文取段落；最近 12 章、3000 字封頂，放不下的寫原因） |

上游審稿讀的是「已定稿歷史的連續性投影」（RV:121-154）；這裡對應的是四期摘要裡的「連續性事實」。不帶歷史對話——審稿判的是正文，不是聊天記錄。

### 3. 審稿報告（`model/review.ts`，純函式）

**JSON 合同**（移植 `consistency_check` 的 systemSuffix 與 `buildChapterGoalReviewPrompt`，`chapter-goal-review.ts:35-59`）：

```json
{"summary":"一句話總體評價",
 "items":[{"category":"劇情合理性","severity":"error","quote":"原文句子","description":"問題描述"},
          {"category":"角色狀態","severity":"pass","description":"未發現不一致"}],
 "goalReviews":[{"id":"g1","evidence":[{"quote":"正文逐字引文"}],"description":"逐個子動作的判斷","status":"completed|unmet|unknown"}]}
```

- `items` 1–10 條，`severity` 只有 `error / warning / pass`；`quote` ≤ 160 字、`description` ≤ 200 字、`summary` ≤ 120 字（上游 RV:36-38），超長截斷並記一句。解析寬鬆（第 1 條）：認程式碼圍欄、認前後多餘的話（取第一個 `{` 到最後一個 `}`）、`critical / severe` 當 `error`、`minor / warn` 當 `warning`，單條壞了跳過那一條。
- **目標凍結**（`freezeGoals`，移植 `freezeChapterGoals`）：細綱「關鍵事件」按換行與 `；` 切開，一項一個 id（`g1`、`g2`…）。⚑ **章末鉤子單列最後一項**（「章末鉤子：……」）——D3 裡它是必填的，執行卡也重列它；上游只凍結 keyEvents。
- **引文校驗**（總計劃 §5 五期；⚑ **與上游不同的兩處**）：
  - 歸一化之後再找：NFKC、去掉全部空白與標點符號（`\p{P}\p{S}`）後，看正文的歸一形裡有沒有引文的歸一形。上游只容忍多一對引號，改一個逗號就認不出；模型抄原文時改標點、並空格是常態。歸一後不到 4 個字的引文一律當「找不到」（兩三個字到處都能命中，證明不了什麼）。
  - **普通問題的引文找不到就丟掉**（上游完全不校驗普通問題的引文）：沒有原文撐著的「問題」多半是模型編的，留著作者會照著去改一段根本不存在的話。丟了哪幾條寫進 notes，報告卡上摺疊列出。
  - 目標核對：`completed` / `unmet` 必須至少有一句找得到的引文；**任何一句找不到**，這一項整項降成「待核實」、判斷換成「這一項缺少可定位的正文證據，請人工核實」（上游同一口徑，`chapter-goal-review.ts:82-115`）。「沒寫到」只能是待核實：`unmet` 沒有證據就降級，於是模型沒法拿「正文裡沒提」去判未完成。
  - 漏了哪一項、多出認不出的 id、同一 id 出現兩次：那一項待核實，`coverage` 記 `partial`，報告卡上說「目標核對不完整」。細綱關鍵事件是空的：`coverage` 記 `none`，說「本章細綱沒有可核對的關鍵事件」。
- 報告帶 `chapterRelPath` 與 `chapterHash`（審稿時的正文指紋）。修稿時對不上就重新定位每一條勾選項的引文，找不到的作廢並說明。
- `renderReport(report)`：一份給人讀的 Markdown（氣泡正文與「複製」用它，不是那段 JSON）。

### 4. 審稿鏈（`generation/review.ts`）

移植 `ReviewChapterCommand` 的重試（RV:288-367）：

```
第一次呼叫（對話頁流式）
  → 被輸出上限截斷：丟棄，整份重來 1 次（截斷的那一半不可信，不續接）
  → 解不出來（不是 JSON、沒有 items 陣列、一條合格的都沒有）：丟棄，按合同重建 1 次
  → 仍不行：報錯，不出報告（「兩次都沒有產出合格的審稿 JSON…通常是被輸出上限截斷」）
  → 校驗引文、凍結目標、核對
```

- 呼叫次數 `REVIEW_CALLS = { low: 1, high: 1, max: 3 }`：「預計 1 次呼叫，最多 3 次（輸出被截斷或不合格時重來）」。
- Draft 帶 `review`（報告本體），沒有 `artifact`，不問落盤。

### 5. 修稿（按勾選的審稿意見）

- 新寫法 `WriteMode = 'revise'`：整章、最小改動、覆蓋前審閱。**只由報告卡發起**，不進主按鈕、不進章節條。
- `InMessage` 加 `reviseChapter { turnId, picks }`：報告所在那一輪 + 勾選的條目 id。後端取那一輪的報告，把勾選項渲染成清單（`renderRevisionBrief`，移植 `renderHumanConfirmedReviewBrief`，`human-confirmed-review.ts:202-252`）：
  ```
  【已確認納入本次修稿的審稿項】
  1. [劇情合理性 / 嚴重] ……
     相關原文：……
  2. [本章目標 / 未完成] 關鍵事件：…… —— 判斷：……
  ```
  勾了待核實項時前面加上游那句邊界（「作者納入待核實項不等於確認其為錯誤，不得據此編造缺失前史或事實……」）。
- 勾選時的正文與審稿時不一樣了（`chapterHash` 對不上）：逐條重新定位引文，找不到的那幾條作廢並寫進 notes；一條都不剩就不調模型、toast 說明。
- 發出去的那一輪：使用者氣泡是 `/按审稿修稿` + 勾選清單（`ChatTurn.revise`，重來一輪時原樣重跑）。
- **裝配**：修稿配方（§6）；`revision` 層帶**整章原文**（從前是 `takeTail(…, 3000)`：3000 token 的尾巴，長一點的章前半截直接沒了——這對「重寫」也是一處靜默截斷，一併修）。
- **契約**：移植 `refine_from_review`（PT:1023-1055）的修復原則四條 + 輸出要求（純文字、段間空行、不要開場白）。不帶寫正文那一套法則、篇幅合同與執行卡——那些是在教它「寫一章」，修稿要的是「只改這幾處」。
- **修稿鏈**（`generation/revision.ts`，移植 `bounded-completion.ts` 的 `append-visible-text` 與 `refinement-completeness.ts`）：
  ```
  第一次呼叫（流式）
    → 被輸出上限截斷就續寫，最多 3 輪（只看截斷，不看字數）：續寫那一輪帶原文、清單與已修訂的最後 1600 字
    → 續寫沒有增長：停
    → 最後仍被截斷：報錯（整章覆蓋一份半截的修訂稿比不寫更糟）
    → 完整性校驗：修訂稿字數 < min(原稿, max(200, 0.6 × min(原稿, 每章字數))) → 報錯
  ```
  ⚑ **兩種報錯都不出卡片**（與寫章的「已寫的不丟」相反）：寫章時那一版是新東西，半截也比沒有強；修稿是拿它**覆蓋**一章已經寫好的正文。已經收到的文字留在氣泡裡，作者可以自己取用。
- 呼叫次數 `REVISE_CALLS = { low: 1, high: 1, max: 4 }`：「預計 1 次呼叫，最多 4 次（被輸出上限截斷時接著寫，最多再續 3 輪）」。報告卡底部按鈕「按勾選的 n 條修稿」，提示寫這一句。
- 落盤：與 `rewrite` 一樣整章覆蓋、先審閱、沿用原標題行；**不記 `writtenFrom`**（修稿沒有照細綱重寫，細綱改過的 ⟳ 不能因為修了一次稿就消掉）。不跑重演檢測（開頭是原稿的開頭）。

### 6. 修稿的裝配

| 層 | 優先順序 | 說明 |
|---|---|---|
| `system` | P0 | 上游 systemRole（「只依據人工確認的審稿意見進行必要修改……」）+ 格式 |
| `ask` | P0 | 作者補充的修稿指導（報告卡上不填就是空） |
| `revision` | P0 force | 待修稿全文 + 勾選清單 |
| `style` / `guidance` | P0 force | 修完的那幾處要與全章同一個聲音 |
| `plotSelf` | P1 | 修「未完成的目標」要知道細綱原話 |
| `characters` | P1 | |
| `prevTail` | P1 | 修「接不上上一章」要看上一章結尾 |
| `plotAhead` | P1 | 修的時候別把後面幾章的事寫進來 |
| `evidence` | P2 | 修連續性問題要看定稿原文 |

續寫那幾輪一張精簡配方：system、style、guidance、revision、chapterSoFar（已修訂的末尾）。

### 7. 精修（總計劃 §1 #18）

「目標有內容時再生成，作者的話就是修改意見」在正文層就是 `rewrite`：本章細綱（`plotSelf`，P0 force）與執行卡一直都在，上游那個「ChapterInfo 傳空」的缺口在這裡不存在。本期只修一處：`revision` 層帶整章原文（§5）。補一條測試釘住「重寫時裝配裡有本章細綱與完整的上一版」。

### 8. 一致性預檢（`model/preflight.ts` + `features/preflight.ts`）

- **判據**（移植 `findBlueprintContinuityRisks` 的那一條規則，`consistency-preflight.ts:84-119`）：本章細綱 `characters[]` 裡的人（按名字與別名認卡），卡上「當前狀態」寫著已經死了 → 一條警告。
- ⚑ **讀的是角色卡的「當前狀態」**（總計劃 §1 #19），不是上游的定稿事實投影。只信「寫到本章之前」的狀態：`stateThrough ≥ N`（狀態已經更新到本章或更晚——重寫早前的章時常見）不判；沒記過 `stateThrough` 的手寫卡照判。
- ⚑ **死亡判定**：按句讀分句，一句**以**終態說法開頭（可以帶主語、「已 / 已經 / 於第 k 章 / 被……」字首）才算：死亡、身亡、犧牲、去世、過世、亡故、病逝、遇害、陣亡、戰死、喪生、喪命、殞命、斃命、氣絕、慘死、死了、死去，以及「被……殺死 / 刺死 / 毒死 / 打死 / 害死」。前面有「假 / 詐 / 未 / 沒 / 險些 / 差點 / 幾乎 / 瀕臨 / 傳言 / 疑似 / 誤以為」的不算。上游只認「名字緊挨著死亡 / 身亡 / 犧牲 / 去世」四個詞，角色卡的狀態裡通常不寫自己的名字，照搬會一條都認不出。寧可誤報一條讓作者點一下「僅本次忽略」，也別漏報。
- 零呼叫。上游的那句「這是證據提示，不會阻止創作」照用：警告寫「沈秋的當前狀態（截至第 5 章）寫著『已死亡……』，本章細綱仍安排他出場」+「調整細綱，或者這是回憶、幻象等刻意安排」。
- **單章**（對話頁寫第 N 章 / 重寫，來自主按鈕、章節條或對話）：生成之前查一次，有警告就在對話頁亮一張卡（`askGate`，紅色塊列出警告），按鈕「僅本次忽略，照寫」/「先不寫」。點「先不寫」：不調模型，那一輪的回覆寫明為什麼停。接著寫、修稿不查（開頭已經寫下了）。
- ⚑ **批次寫章**：開跑之前把要寫的幾章一起查一遍，有警告就在確認框裡列出來，按鈕「僅本次忽略，照寫」；跑的中途新冒出來的（前面剛定稿的一章把某人寫死了，後面一章還排著他）→ 停在那一章前面，黃 ❗ 掛在那一章上，完成提示裡說清楚。批次沒有人看著，接著寫就是明知有矛盾還往下寫（四期「寫出來但不能往下接的也停」同一口徑）。
- 不做上游的「永久豁免」（儲存安排的理由）：本期只有「僅本次忽略」。

### 9. 覆蓋審閱交回合併結果（W11 的後端一半）

- `Host.reviewReplace(name, current, proposed, relPath?, opts?)` 加 `opts.merge`：給了就可以交回 `{ merged: string }`（作者在合併檢視裡挑過、改過的那一份）。`workspace/guard.ts` 的 `reviewOverwrite` 請求合併、返回 `{ ok, text? }`，`Workspace.write` 落合併後的那一份（記賬與伴生照常跑在最終文字上）。
- 其餘四個直接調 `reviewReplace` 的地方（角色卡、設定條目、角色狀態對比）不請求合併：獨立版給它們開只讀的 diff 檢視（採納 / 放棄），不再只是一個字數確認框。
- VS Code 殼照舊 `vscode.diff` + 採納 / 放棄（總計劃 W11），忽略 `merge`。

### 10. 段級 diff（`model/paragraphDiff.ts`，純函式）

- 按空行切段，段的比較鍵是去掉空白後的文字；兩邊段序列做 LCS，相鄰的改動併成一處（hunk）：`{ kind: 'same', text } | { kind: 'change', old: string[], new: string[] }`。
- 兩邊都超過 2000 段時不做 LCS，整份當一處改動（章節遠到不了這個數，這是防禦）。
- 上游 `ThreeWayMerge` 用的是按字頻相似度的全域對齊（能認出「一段拆成兩段」）；這裡用 LCS——修稿與重寫的改動多是整段增刪改，LCS 已經夠用，而且可以單測到每一步。

### 11. 定位引文（W10「點引文就在編輯器裡定位到那句」）

- `model/review.ts` 的 `locateQuote(text, quote)`：與引文校驗同一個歸一化，找到之後把歸一形裡的位置對映回原文的 `{ start, end }`。
- `InMessage` 加 `revealQuote { relPath, quote }`。`Host.revealText?(relPath, quote)`：獨立版開啟那一章、推 `editorReveal { path, quote }`，編輯區選中那一段並滾到它；VS Code 開啟文件、`selection` + `revealRange`。宿主沒有這一項能力時退回 `openFile` 並 toast 那一句（能力探測，不判斷是哪個殼）。

### 12. 本期不做

- ⚑ 批次寫章的「寫完即審稿」模式（四期計劃 §8 曾列在這一期）：審稿報告要作者逐條勾選才修稿，批次裡沒有人勾；只審不修的話，十章報告堆在一個任務裡沒有地方看。留給作者決定要不要、要的話報告放哪。
- 審稿報告裡併入預檢警告（上游 `mergeConsistencyFindingsIntoReview`）：上游並進去的引文是**前面某一章**的證據，預設勾選後會被當成本章原文交給修稿——這裡不跟。
- 預檢的永久豁免；報告卡上「新增人工問題」、編輯條目（上游 ReviewReport 的編輯模式）。
- agent 工具開放 `review`、`TIER_TASK` 加審稿檔：六期。

---

## 提交節奏（9 個 commit）

| # | 字首 | 主題 |
|---|---|---|
| 1 | `docs` | 本計劃 |
| 2 | `feat(model)` | 審稿報告與目標清單、引文歸一與定位、修稿清單、一致性預檢、段級 diff、審稿與修稿的呼叫次數（純函式 + 單測） |
| 3 | `feat(context)` | 審稿與修稿的提示詞、三張配方、本章全文與近章連續性事實兩層；`revision` 層帶整章原文 |
| 4 | `feat(generation)` | 審稿鏈與修稿鏈；審稿不再走寫正文的那幾條路 |
| 5 | `feat(controller)` | 報告隨會話儲存、按勾選修稿、預檢卡片與批次預檢、定位引文、覆蓋審閱交回合併結果 |
| 6 | `feat(media)` | W10 審稿報告卡、章節條「審稿」、點引文定位 |
| 7 | `feat(media)` | W11 獨立版 diff / 合併檢視 |
| 8 | `test` | 五期驗收——審一章、丟掉偽造引文、按勾選修稿、合併時手改的段不被沖掉、預檢攔下死人出場 |
| 9 | `docs` | 本期動到的模組 README |

真實模型冒煙（寫 1 章 + 審稿 + 修稿，約 3–10 次呼叫）按總計劃 §7 **要作者點頭才跑**，不在這 9 個 commit 裡。

---

### Task 2：純函式（commit 2）

- `model/pipeline.ts`：`Capability` 加 `review`（標籤、提示、別名、`STAGE_CAPABILITIES`）；`OutputKind` 加 `report`；`WriteMode` 加 `revise`（`NextStepPlan.writeMode` 不含它）；`REVIEW_CALLS`、`REVISE_CALLS`、`REVISE_CONTINUE_ROUNDS = 3`。
- Create `src/core/model/review.ts`：`ReviewReport` 等型別、`freezeGoals`、`normalizeQuote`、`locateQuote`、`parseReviewJson`、`verifyReview`、`renderReport`、`renderRevisionBrief`、`relocatePicks`、`defaultPicks`。
- Create `src/core/model/preflight.ts`：`isTerminalState`、`findPreflightRisks`、`describeRisk`。
- Create `src/core/model/paragraphDiff.ts`：`splitParagraphs`、`diffParagraphs`、`joinMerge`。
- 測試：命令表與能力集合；引文歸一（標點、空白、全半形）、太短不認、定位對映回原文；普通問題找不到就丟、目標任何一句找不到降待核實、unmet 無證據降級、漏項 / 重複 id 記 partial；鉤子單列；清單渲染與待核實邊界；預檢的判定正反例（假死、險些喪命、為已死的師父報仇都不算）、`stateThrough ≥ N` 不判；diff 的相同 / 增 / 刪 / 改、相鄰改動合併、合併結果拼接。

### Task 3：提示詞與裝配（commit 3）

- `context/prompts.ts`：審稿的系統提示、審查原則、檢查維度、JSON 合同與目標清單（`reviewContract`）；重建那一次的附加指令；修稿的系統提示與契約、修稿續寫契約；`CAPABILITY_TASK.review`。
- `context/types.ts`：層 `chapterFull`、`recentFacts`；條目種類 `chapterFull`、`facts`；`BuildRequest.review`（凍結的目標清單）；`ChainStep` 加 `reviewRebuild`、`revisionContinuation`。
- `context/layers/`：兩個新層；`revision` 帶整章原文（修稿時再帶清單）；`plotAhead` 在審稿時換說法。
- `context/recipes.ts`：審稿、修稿、修稿續寫三張配方。`context/builder.ts`：小節標題與順序。
- 測試：三張配方的層與優先順序；審稿訊息裡有全文、細綱、目標清單 JSON、後續章節標「非既定歷史」、近章事實；修稿訊息裡有整章原文與清單、沒有執行卡與篇幅合同；重寫時 `revision` 是全文。

### Task 4：兩條鏈（commit 4）

- Create `src/core/generation/review.ts`：`completeReview(first, io, ctx)`（§4）。
- Create `src/core/generation/revision.ts`：`completeRevision(first, io, ctx)`、`assertCompleteRevision`（§5）。
- `generation/structured.ts`：`chainOf` 認 `review`、`revise`。`generation/generate.ts`：審稿不 `cleanOutput`、不解析成產物；`planWriting` 認 `revise`；Draft 帶 `review`。`generation/accept.ts`：`revise` 覆蓋審閱、不記 `writtenFrom`。
- 測試（整合）：審稿一次成功、截斷重來、不合格重建、兩次都不行報錯；偽造引文被丟；修稿一次成功、截斷續寫、續寫三輪仍截斷報錯、長度不夠報錯；審稿 Draft 沒有 artifact。

### Task 5：controller 與協議（commit 5）

- `protocol/`、`model/session.ts`、`generation/drafts.ts`：`SerializedTurn.review`、`ChatTurn.review` / `revise`、`SessionDraft.review`；`InMessage` 的 `reviseChapter`、`revealQuote`；`OutMessage` 的 `editorReveal`、`prompt.kind = 'merge'`；`ChapterAction` 加 `review`。
- `controller/chat.ts`：審稿輪次不問落盤、報告進會話；`reviseChapter`；`chapterAction('review')`；寫章之前的預檢卡片。
- `features/preflight.ts`；`features/pipelineBatch.ts`：開跑前預檢與中途停下。
- `host.ts`：`reviewReplace` 的 `opts.merge` 與 `{ merged }`、`revealText`。`workspace/guard.ts`、`workspace/index.ts`：落合併結果。兩個殼：`fileHost.reviewReplace` 走 `prompt kind: 'merge'`，`revealText`；`vscodeHost.revealText`。
- `tools/novel/generate.ts`：`review` 報錯說明。
- 測試（整合）：審稿輪次沒有 gate、會話裡存著報告、重開會話還在；按勾選修稿發出去的清單隻有勾選項；正文改過時作廢的條目寫進 notes；預檢卡片「先不寫」不調模型、「僅本次忽略」照寫；批次開跑前問一次、中途冒出來的停下掛黃 ❗；合併結果落盤；`revealQuote` 在有 / 沒有 `revealText` 的宿主上。

### Task 6：W10（commit 6）

- `media/src/view/review.ts`：報告卡——總評一行、目標核對（逐項已完成 / 未完成 / 待核實、引文、覆蓋說明）、問題按嚴重 / 建議分組、通過項摺疊、丟掉的條目摺疊；每條可勾選的前面一個勾（error / warning / 未完成預設勾，待核實預設不勾，通過與已完成不能勾）；點引文發 `revealQuote`；底部「按勾選的 n 條修稿」，提示裡寫呼叫次數，0 條時禁用。勾選狀態按 turnId 記在前端（氣泡重建時不丟）。
- `media/src/view/messages.ts`：有 `review` 的輪次畫報告卡；使用者氣泡畫 `/按审稿修稿` 與清單。
- `media/src/editor/chapterBar.ts`：「審稿」按鈕。`media/src/editor/`：收 `editorReveal`，選中那一段並滾過去。
- CSS 同步；`verify-css`。
- DOM 測試：分組與計數、預設勾選、勾選數進按鈕文案、點引文發 `revealQuote`、點修稿發 `reviseChapter` 且只帶勾選的 id；章節條「審稿」發 `chapterAction`；`editorReveal` 之後 textarea 的選區落在那一句上。

### Task 7：W11（commit 7）

- `shells/shared/panes.ts`：合併檢視的骨架（遮罩層、標題、進度、兩顆整體按鈕、正文區、底部兩顆）。
- `media/src/view/merge.ts`：收 `prompt kind: 'merge'`——相同的段一行帶過，每一處改動左右兩欄（原文 / 新版）+ 下面一格可編輯的結果（預設是新版）+「採用新版 / 保留原文」；手改過的那一格標「已手改」，兩顆按鈕與「全部採用新版 / 全部保留原文」都不動它，另給「撤銷手改」；頂上「已處理 k / n 處」；底部「寫入合併結果 / 放棄」。只讀模式（不請求合併的呼叫方）只有「採納 / 放棄」。一處都沒動過就交回 `apply`（原樣用新版，不經段拼接）。
- CSS 同步；`verify-css`。
- DOM 測試：改動的處數與相同段；採用 / 保留改結果；**手改過的段點「採用新版」「全部採用新版」都不被沖掉**；進度計數；交回的是合併結果；只讀模式沒有逐段按鈕。

### Task 8：驗收用例（commit 8）

`tests/integration/features/reviewRevise.test.js`：從寫好第 1–2 章（第 2 章已定稿）的工程起，假模型按指令碼應答。

- `/审稿` 第 2 章：報告裡 3 條問題，其中一條引文是編的 → 報告只剩 2 條、notes 寫著丟了哪條；目標清單 4 項（3 條關鍵事件 + 章末鉤子），一項 `unmet` 沒給引文 → 待核實；會話檔案裡存著報告；沒有彈落盤卡片；呼叫 1 次。
- 勾選 1 條問題 + 1 項未完成 → `reviseChapter`：發出去的那一次裡有整章原文與只含這兩條的清單；假模型先截斷一次再續完 → 呼叫 2 次；覆蓋審閱拿到的是修訂稿；宿主交回合併結果時磁碟上是合併結果。
- 修訂稿不到原稿六成 → 報錯，磁碟不變。
- 第 3 章細綱排著角色卡上已經死了的人：主按鈕寫第 3 章先亮預檢卡，「先不寫」一次模型都不調；再按一次選「僅本次忽略」照寫。

### Task 9：README（commit 9）

只改本期動過、現在描述已經錯了的段落：model、context、generation、controller / core、protocol、features、shells、media、tests。

---

## 驗收

- `npm run typecheck`、`npm run test:node`、`npm run test:e2e` 全綠。
- Task 8 通過。
- 獨立版開啟一個寫好兩章的工程：章節條有「審稿」；報告卡按嚴重度分組、點引文編輯區選中那一句；勾兩條點修稿，寫入前是合併檢視，手改一段再點「全部採用新版」那一段不變。

## 給接手 agent 的提示詞

> 你在 `~/workspace/novelForge` 的 `refactor/blueprint-pipeline` 分支上做「五期：審稿 + 修稿 + 預檢」。先讀 `docs/design/plans/2026-09-30-blueprint-pipeline-phase5.md` 全文、根目錄 AGENTS.md、總計劃的 §1（#16–#19）、§2.3、§3.3 的 W10 / W11 與 §4，以及三期計劃 §3、四期計劃 §2 / §5。上游原始碼在 `~/workspace/AI-Novel-Writer`，移植的演算法與提示詞在註釋裡註明出處。按 Task 2→9 順序做，每個 Task 一個 commit（中文正文，結尾帶 Co-Authored-By 行），不要推送。每個 commit 前跑 `npm run typecheck`；Task 4、Task 5、Task 8 結束時跑 `npm run test:node`，Task 9 結束時再跑 `npm run test:e2e`（Bun 在 `~/.bun/bin`）。真實模型冒煙要花錢，跑之前必須先找作者確認。遇到計劃裡沒寫到、又會改變產品行為的決定，停下來問。
