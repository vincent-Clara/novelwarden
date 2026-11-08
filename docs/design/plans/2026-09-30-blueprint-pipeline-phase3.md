# 三期：正文生成 Implementation Plan

> **接手須知：** 這份計劃面向新的 agent，假設你**沒有讀過**前面的對話。開工前必讀：
> 1. 根目錄 [AGENTS.md](../../../AGENTS.md)：本期直接關係到第 1、2、3、4、11、12、16、19、20、26 條。
> 2. [總計劃](2026-09-30-blueprint-pipeline-roadmap.md) 的 §1（#9–#12）、§2.3 正文那一行、§2.4、§3.3 的 W6 / W7、§4（D6–D8、D16、D23）。
> 3. [二期計劃](2026-09-30-blueprint-pipeline-phase2.md) 的 §5–§7：本期的續寫鏈與二期的三條生成鏈長在同一處（`generation/`），單步與批次共用 `ChainIO`。
> 4. 上游原始碼：`~/workspace/AI-Novel-Writer`（GPL-3.0，源自 AI_NovelGenerator）。移植處在註釋裡註明出處。
>
> 每個 Task 做完立刻 commit，commit 之間 `npm run typecheck` 必須零錯誤。

**Goal:** 細綱排好之後，主按鈕「寫第 N 章」一次寫出一章能讀的正文：正文層按總計劃 §2.3 裝配（執行卡、後 5 章邊界、上一章結尾不許重演、去 AI 味禁令），不到目標字數的八成就自動續寫，寫完查一遍有沒有重演上一章結尾；落盤直接進 `chapters/`，已有正文時走覆蓋審閱，「接著寫」追加。前端能看見續寫到第幾輪、寫了多少字，章節行點開是正文與細綱並排的工作臺。本期結尾是**真實模型驗收關卡**。

**Architecture:** 純函式先行（呼叫次數、續寫拼接、重演檢測），再是提示詞與裝配層，然後是續寫鏈（`generation/continuation.ts`，與二期的三條鏈同一個 `ChainIO`），再是落盤三種寫法、協議與 controller，最後是前端兩件（W7、W6）與驗收。

**Tech Stack:** TypeScript、`node:test`、jsdom、Bun（e2e）。不新增依賴。

## Global Constraints

- `src/core/` 零 `vscode` import；分層契約測試全程要綠。
- **不靜默截斷**（第 2 條）：每一輪續寫、每一次丟棄與恢復、最後沒寫夠、重演命中，都寫進 Draft 的 `notes`，落盤卡片上列出來並進日誌。
- **不靜默覆蓋**（第 3 條）：章節已有正文時，除「接著寫」（追加）以外的寫入一律走覆蓋審閱。
- **動手之前寫明呼叫次數**（第 4 條、D16）：寫正文的每一種下一步都帶 `calls`，續寫的上限算在裡面。
- **已寫的不丟**（D6）：續寫到最後仍不到八成、最後一輪被截斷、重演命中，都**不作廢**——卡片照樣可以「寫入」，只是說清楚。唯一不出卡片的是「思考把輸出預算吃光、一個字正文都沒有」。
- **嚴格用作者選定的模型**（第 12 條）：續寫的每一輪都用第一次那個模型、同一檔思考深度（第 26 條）。
- **輸出上限一律取模型配置**，不搬上游寫死的 8192（總計劃 §1 #10）。
- 本期結束時 `npm run typecheck` + `npm run test:node` + `npm run test:e2e` 全綠。

---

## 本期定下的東西（寫進程式碼註釋）

### 1. 寫正文的三種寫法（`WriteMode`）

| 寫法 | 什麼時候 | 模型寫什麼 | 落盤 |
|---|---|---|---|
| `write` | 這一章還沒有正文 | 整章 | 新建 `chapters/NNN-标题.md`（空檔案就直接填） |
| `continue` | 主按鈕「接著寫」、工作臺「接著寫」 | 只寫新增的那一段，接在已有正文末尾 | **追加**，不審閱（不覆蓋任何東西） |
| `rewrite` | 主按鈕「重寫第 N 章」，或已有正文時在對話裡發「寫正文」 | 整章，上一版正文作底稿、作者那句話是修改意見 | **覆蓋**，寫入前審閱 diff，標題行沿用原檔案 |

- 寫法由生成層按磁碟定（`resolveWriteMode`）：章節沒有正文 → `write`；請求明說 `continue` → `continue`；其餘 → `rewrite`。**從前已有正文時一律追加**——對話裡發「寫正文」寫出的是完整一章，追加上去就是兩章疊在一起；現在改成覆蓋審閱，與「生成即修改意見」的口徑一致（二期 `CAPABILITY_TASK.generate`）。
- `NextStepPlan` 加 `writeMode?: 'continue' | 'rewrite'`，主按鈕帶過去；`SendPayload`、`ChatTurn` 同名欄位（重來一輪原樣重跑）。
- agent 的 `generate` 工具不帶寫法，走同一條預設（有正文就覆蓋審閱）。

### 2. 目標字數

- 生成層對正文層兜底：請求沒給 `targetWords` 時取細綱的 `targetWords`，再取配置的每章字數（D6：必填，預設取配置）。agent 工具與快速續寫從此也有目標。
- 兩者都沒有時**不自動續寫**（只在被截斷時說一句）——「有字就算寫夠」（第 21 條那半句），不拿猜出來的數去續。

### 3. 續寫鏈（`generation/continuation.ts`，新）

移植自 `generate-draft.command.ts` 的 `extendDraftIfNeeded`（GD:930-1186）與 `bounded-completion.ts` 的拼接。

```
第一次呼叫（對話頁流式 / 批次由鏈自己調）
  → 截斷且新寫的正文 < 100 字：報錯（有思考時說「思考把輸出上限吃光了」，否則說「輸出上限太小」），不出卡片
  → 迴圈，最多 7 輪：
      該續寫 = 被截斷（stop: maxTokens）或 總字數 < 目標 × 80%
      stop: other（內容審查一類）→ 不續，說一句
      續寫一輪：最後 1600 字 + 本章細綱 + 執行卡 + 後 5 章邊界 + 文風 + 全域要求 + 出場角色
      新增部分去掉與已寫末尾的重疊（≥ 48 個非空白字元才算重疊），去掉整段重複（≥ 40 字）
      被截斷且只多了 < 300 字 → 丟棄這一輪，只給 1 次恢復機會（恢復那一輪開頭說清「上一輪已丟棄，直接推進下一件事」）
      恢復仍沒進展 → 停下，已寫的保留
      正常收尾但只多了 < 300 字 → 模型已經收尾，不再續
  → 最後仍被截斷：說一句「結尾可能停在半句」
  → 最後仍不到八成：說「未寫夠 x / y 字」，照樣出卡片
  → 重演檢測（§4），命中寫進說明並標在卡片上
```

- **比上游寬鬆的兩處**：上游恢復失敗、最後沒寫夠、被截斷收尾都整份作廢；這裡一律保留並說清（D6：已寫的內容不丟）。只有「一個字正文都沒有」才報錯。
- 呼叫次數：1 + 至多 7 輪 = **最多 8 次**（恢復那一輪算在 7 輪裡，與上游 `MAX_AUTO_CONTINUE_ROUNDS` 同一口徑）。
- 續寫每一輪的正文照樣流進同一個氣泡（輪與輪之間空一行，不插「——第 k 步——」那種分隔：讀起來得是一章）；丟棄那一輪時氣泡退回已保留的版本。
- 進度：每一輪開始、以及流式期間每 300ms 報一次 `{ round, words, target }`（`GenerateHandlers.onProgress`）。
- `continue` 寫法時「總字數」含已有正文，氣泡裡與 Draft 裡只有新寫的那一段。
- 鏈的結果多帶 `rounds`、`words`（這一章寫完後的總字數）、`added`、`short`、`replay`；這些進 Draft，卡片據此寫「2980 / 3000 字 · 已達標」或「未寫夠」。

### 4. 重演檢測（`context/replay.ts`，新，純函式）

移植自 `hasSubstantialPreviousChapterReuse`（GD:276-317）：上一章結尾（約 1000 字，按句界對齊，`chapter-materials.ts:88-97`）與新稿前 1200 字各自歸一（NFKC、小寫、去空白與標點），按 8 字 n-gram 標出新稿裡被覆蓋的位置，**連續覆蓋 ≥ 80 字**就算重演。返回 `{ hit, quote }`，`quote` 是新稿裡那一段的原文（帶標點，給作者看）。

- 只在續寫結束之後跑一次；`continue` 寫法不跑（這一章的開頭作者早就有了）。
- 上一章結尾按磁碟現讀，不取上下文裡那一份（那一份可能被整章全文取代、或被作者取消勾選）。
- 命中**不自動拒收**（總計劃 §2.4）：卡片標紅、寫明重合的原句，「寫入」要點兩下（按鈕文案兩段式，不疊彈窗）。上游命中就作廢；這裡交給作者判斷——有時重合的是一句刻意呼應的臺詞。

### 5. 正文層的裝配（`context/recipes.ts` + 新層）

| 層 | 優先順序 | 說明 |
|---|---|---|
| `system` | P0 | 移植的寫作系統提示 + D8 禁令（§6） |
| `ask` | P0 | 作者本章指導（也進執行卡） |
| `attachments` | P0 | 不變 |
| `style` | P0 | 不變 |
| `guidance` ★ | P0 | 小說配置的「全域要求」一節，單獨成段（上游每章都帶它） |
| `plotSelf` | P0 | 本章細綱 |
| `prevTail` | P0 | 上一章結尾，標題改成「只作邊界，不可重演」 |
| `plotAhead` ★ | P0 | 後 5 章細綱，一章一行（標題 + 關鍵事件），標「只為了解後面的發力點，絕對不要在本章提前寫出」 |
| `chapterSoFar` ★ | P0 | `continue` 寫法與續寫輪次：本章已寫正文的最後 1600 字 |
| `revision` | P0 | `rewrite` 寫法：上一版正文 + 修改意見 |
| `characters` | P1 | 本章出場（細綱 `characters[]`）+ 主角，不變 |
| `premiseWorld` ★ | P1 | 小說配置（除全域要求）、故事前提、世界觀，一件一條 |
| `outlineSlice` | P1 | 大綱裡本章所在那一節 |
| `history` | P1 | 不變 |
| `globalSummary` / `lore` | P2 | 不變（`evidence` 是四期的事） |
| `manuscriptFull` | P3 | 近 2 章全文，不變 |
| `plotSummary` | P4 | 不變 |

- 續寫輪次用一張精簡配方（`step.kind === 'continuation'`）：system、ask、style、guidance、plotSelf、plotAhead、chapterSoFar、characters。上游續寫時把整個材料包再發一遍（GD:1036）；這裡只帶「接著寫」真正要看的，其餘靠已寫的那 1600 字承接。
- 執行卡、篇幅合同放在訊息**最末**（上游 GD:657 的順序），由輸出契約拼。

### 6. 提示詞（`context/prompts.ts`）

移植自 `first_chapter_draft` / `next_chapter_draft`（PT:720-855），第 1 章與後續章各一套：

- **系統提示**：原有六條硬性要求保留前五條（它們與上游不衝突）；第 6 條「不要強行收束，留出繼續往下寫的餘地」改成「按細綱約定的結束狀態或章末鉤子收束」——那一條是一段細綱拆成幾章時的寫法，一章一綱之後這一章就該停在鉤子上。加上：不可偏離的作者事實、文風適用邊界、格式（雙引號、段間空行、寫不夠停在段末、不寫「繼續生成」）、敘事視角（配置裡寫了的話）、**D8 去 AI 味禁令四條**。
- **輸出契約**：第 1 章「黃金第一章」四條 / 後續章「連載更新法則」五條；篇幅合同（±20%）；執行卡（必需事件 = 關鍵事件、章節鉤子 = 章末鉤子、作者本章指導 = 這一輪的輸入）。**單章入口也帶章末鉤子**——上游單章入口漏了（`chapter-creation-parameters.ts:43-58` 不收 suspenseHook）。
- `continue` 寫法 / 續寫輪次的契約：「從已寫正文末尾無縫接下去，只輸出新增正文，儘量寫完剩餘約 R 字」+ 上游那六條硬性要求（GD:1012-1018）+ 執行卡；恢復輪前面加上游那句「上一輪已被丟棄……禁止複述已寫末尾」。
- 刪掉 builder 裡「目標字數：約 N 字（±15% 均可）」那一行，由篇幅合同代替（兩處寫兩個比例，作者與模型都分不清哪個算數）。

### 7. 呼叫次數

| 步驟 | 預計 | 最多 | 文案 |
|---|---|---|---|
| 寫第 N 章 / 接著寫 / 重寫第 N 章 | 1 | 8 | 「預計 1 次呼叫，最多 8 次（沒寫夠時自動續寫，最多再續 7 輪）」 |
| 定稿（生成摘要） | 1 | 1 | 不變（四期改成 2 次） |

`CallEstimate` 加可選的 `why`，`describeCalls` 把它接在後面。卡片上寫「這一輪一共調了 3 次模型（續寫 2 輪）」。

### 8. 協議與會話

- `SendPayload.writeMode?`、`ChatTurn.writeMode?`、`NextStepPlan.writeMode?`。
- `OutMessage` 加 `writeProgress { turnId, round, words, target? }`（W7）與 `streamReset { turnId, text }`（丟棄那一輪時把氣泡退回去）。
- `SerializedArtifact` 加 `length?: { words, target?, added?, reached }`、`replay?: string`、`append?: boolean`。
- `gate` 訊息加 `danger?: string`（紅色塊）與 `confirm?: string`（「寫入」要點兩下時第二下的字）。
- `Draft` / `SessionDraft` 加 `writeMode`、`length`、`replay`。
- `InMessage` 加 `openChapter`、`chapterAction`（W6，見下文）。

### 9. 本期不做

- **批次寫正文接續寫鏈**：`features/pipelineBatch.ts` 的 `writeManuscripts` 四期整個重寫成嚴格序列（D10），那時一併接上續寫鏈與重演檢測（批次沒有人看卡片，命中要怎麼處理得和「失敗即停」一起定）。本期它照舊一章一次呼叫，只是自動吃到新的裝配與提示詞；確認框的呼叫次數照實說「一章 1 次，不自動續寫」。
- **`evidence` 層與定稿後的角色狀態**：四期。
- **續寫時帶上已寫正文裡新出場的角色**：續寫輪次的出場角色仍按細綱挑。

---

## 提交節奏（10 個 commit）

| # | 字首 | 主題 |
|---|---|---|
| 1 | `docs` | 本計劃 |
| 2 | `feat(model)` | 寫正文的呼叫次數與寫法、續寫拼接與重演檢測（純函式 + 單測） |
| 3 | `feat(context)` | 移植的正文提示詞、四個新層與正文 / 續寫兩張配方 |
| 4 | `feat(generation)` | 續寫鏈、`generate` 接鏈與進度、落盤的三種寫法 |
| 5 | `feat(controller)` | 協議與會話欄位、卡片上的字數與重演、主按鈕帶寫法、快速續寫 |
| 6 | `feat(media)` | W7：寫章進度條、寫入卡的字數、重演標紅與兩段式寫入 |
| 7 | `feat(media)` | W6：章節工作臺 |
| 8 | `test` | 三期驗收——跟著主按鈕寫完前 3 章，續寫與重演的八種情形 |
| 9 | `docs` | 本期動到的模組 README |
| 10 | — | 真實模型驗收：指令碼放 `~/workspace/project-scripts/novelforge-phase3-live/`，匯出放 `~/workspace/project-reports/`，**跑之前先找作者確認閘道器、模型與預計呼叫次數** |

---

### Task 2：純函式（commit 2）

- `model/pipeline.ts`：`MAX_CONTINUE_ROUNDS = 7`、`WRITE_CALLS`、`CallEstimate.why`、`describeCalls`；`deriveNextStep` 的三種寫正文都帶 `calls` 與 `writeMode`。
- Create `src/core/context/replay.ts`：`previousEnding(text)`、`detectReplay(prevEnding, draft)`。
- Create `src/core/generation/continuation.ts` 的純函式部分：`stripOverlap(existing, addition)`、`joinContinuation(existing, addition)`（去重疊 + 去整段重複 + 去「繼續生成」類提示行）、`shouldContinue(...)`。
- 測試：重演命中 / 不命中 / 太短不判 / 標點空白差異照樣命中 / `quote` 是原文；重疊去除（≥48 才算）、整段重複去除、提示行去除；呼叫次數與文案。

### Task 3：提示詞與裝配（commit 3）

- `context/prompts.ts`：寫作系統提示（第 1 章 / 後續章）、D8 禁令、黃金第一章 / 連載更新法則、篇幅合同、執行卡、接著寫與恢復的契約，各註明出處。
- `context/types.ts`：`BuildRequest.writeMode`、`ChainStep` 加 `continuation { tail, remaining?, recovery }`；新層 `guidance`、`premiseWorld`、`plotAhead`、`chapterSoFar`，新條目種類 `guidance`、`boundary`、`chapterSoFar`。
- `context/layers/`：四個新層；`prevTail` 的說法。
- `context/recipes.ts`：正文配方按 §5；續寫配方。
- `context/builder.ts`：新條目的小節標題與順序；刪「目標字數 ±15%」；上一章結尾的兩種說法都帶「不許重演」。
- 測試：配方層與優先順序；第 1 章與第 N 章的提示詞各有各的法則；執行卡在最後、帶章末鉤子與作者指導；後 5 章邊界只帶排過的、最多 5 章；全域要求單獨成段且不在 premiseWorld 裡重複；續寫配方不帶摘要與全文。

### Task 4：續寫鏈與落盤（commit 4）

- `generation/continuation.ts`：`completeManuscript(first, io, ctx)`（§3）。
- `generation/generate.ts`：正文層接鏈；目標字數兜底；`resolveWriteMode`；`onProgress`、`onReset`；Draft 的新欄位；正文層失敗照舊掛在細綱上。
- `generation/structured.ts`：`ChainIO.call` 可選 `separator`，`ChainIO.reset` 可選。
- `generation/accept.ts`：正文三種寫法（§1）；`AcceptOptions.writeMode`。
- 測試（整合）：一次寫夠、截斷續寫、不到八成續寫、低增長丟棄後恢復、恢復失敗保留、思考耗盡報錯、最終未寫夠照樣出 Draft、重演命中寫進說明、`continue` 只含新增、`rewrite` 覆蓋前審閱且保留標題行、`write` 新建。

### Task 5：controller 與協議（commit 5）

- `protocol/`、`model/session.ts`、`generation/drafts.ts`：§8 的欄位。
- `controller/chat.ts`：`writeMode` 進會話與生成請求；`writeProgress` / `streamReset` 轉發；卡片的 `length` / `replay` / `append`；`targetHasContent` 按寫法說「覆蓋」；`artifactDetail` 寫字數行與續寫輪數；重演命中時 gate 帶 `danger` 與 `confirm`。
- `features/pipelineBatch.ts`：確認框裡的呼叫次數照實說（§9）。
- `shells/vscode/quickContinue.ts`：落點改成全書狀態機的下一可寫章，帶目標字數；完成時整份替換文件（續寫丟棄過的那一輪不留在文件裡）。
- `tools/novel/generate.ts`：`targetWords` 的說明改成「留空取細綱 / 配置」。
- 測試：卡片欄位；重演 gate 帶 danger；主按鈕「接著寫」發出去的 writeMode。

### Task 6：W7（commit 6）

- `media/src/view/messages.ts`：流式氣泡頂上一條進度（「第 k 輪 · 已寫 x / 目標 y 字」+ 進度條），收 `writeProgress`；`streamReset` 替換氣泡文字。
- `media/src/view/gate.ts`：`danger` 畫成紅色塊；有 `confirm` 時「寫入」第一下改字、第二下才發。
- CSS 同步；`verify-css`。
- DOM 測試：進度條隨訊息更新；兩段式寫入只在第二下發 `gateResult`；沒有 danger 時一下就發。

### Task 7：W6 章節工作臺（commit 7）

見下文「W6」一節。

### Task 8：驗收用例（commit 8）

`tests/integration/generation/manuscriptChain.test.js`：假模型按指令碼應答，從二期驗收結束的狀態（前 5 章細綱）起，經 controller **跟著主按鈕**走「寫第 1 章 → 定稿 → 寫第 2 章 → 定稿 → 寫第 3 章」，斷言磁碟上的三章、主按鈕每一步落在哪、總呼叫次數；第 2 章那一次故意先截斷再續寫，第 3 章故意重演一段上一章結尾（卡片標紅，點兩下寫入）。另外八種情形各一條（§3 的每個分支 + 呼叫次數文案）。

### Task 9：README（commit 9）

只改本期動過、現在描述已經錯了的段落：context、generation、features、model、media、shells、tests。

### Task 10：真實模型驗收

- 先實測閘道器地址、key、兩個候選模型能不能調（只調 `/v1/models` 與一次最小請求），**然後找作者確認**：用哪個模型、預計呼叫次數（配置 1–3、前提 1、角色 2–4、世界觀 1、大綱 1、細綱 1、正文每章 1–8、定稿每章 1：共約 15–25 次）。
- 指令碼用 `tests/helpers/load.js` 的 `loadBundle` 直接跑原始碼，經 controller 跟著主按鈕走「一句話 → 前 3 章」，每張卡片答「寫入」，產物匯出成一份 Markdown（三章正文 + 細綱 + 呼叫與降級記錄）發給作者。
- **作者讀得下去才進四期**；讀不下去就在本期裡調提示詞和配方。

---

## W6：章節工作臺（Task 7）

**點章節行 = 正文與細綱並排開啟。** 從前點行名只開一份（有正文開正文，否則開細綱），對照著看要自己再去右鍵「開啟細綱」。

- **協議**：`InMessage` 加 `openChapter { plotRelPath }` 與 `chapterAction { plotRelPath, action: 'write' | 'continue' | 'rewrite' | 'finalize' }`。
- **後端**（`controller/files.ts`）`openChapter`：
  - 正文在就 `host.openFile(正文)`，細綱在就再 `host.openBeside(細綱)`；
  - 宿主沒有 `openBeside`（能力探測，與 `openDraft` 同一個判法）時只開一份；
  - 還沒有正文時只開細綱（主區）。
  - 獨立版的 `openBeside` 落在第二塊編輯區（從前只放草稿的那塊）；VS Code 的落在 `ViewColumn.Beside`。**兩個殼都不用改**。
- **後端** `chapterAction`：`finalize` 走既有的 `finalizeChapter`；其餘三種等於「對這一章按下主按鈕」——切到這一章的正文層，按對應寫法發一輪生成（`writeMode`）。
- **前端**：
  - 工程頁章節行的行名點選改發 `openChapter`（右鍵裡單獨的「開啟正文」「開啟細綱」保留）。
  - 獨立版編輯區頂上一條**章節條**（`media/src/editor/chapterBar.ts`，新）：主區當前那份檔案是某一章的正文或細綱時出現，寫「第 3 章《夜訪》 · 待寫正文 · 1860 / 3000 字」，按鈕「寫這一章 / 接著寫 / 重寫 / 定稿」按這一章的狀態亮滅，按鈕提示裡寫呼叫次數；另一份沒開著時給「並排看細綱」「並排看正文」。資料取自後端推來的工程樹（`project` 訊息），不新增推送。
  - 第二塊編輯區的空白提示從「這一塊用來放草稿」改成「這一塊放草稿或細綱」。
  - VS Code 殼沒有內建編輯器，不畫章節條——並排的兩個編輯器加側邊欄的主按鈕就是那一套。
- 審稿按鈕是五期的事，本期不放。
- DOM 測試：行名點選發 `openChapter`；章節條隨活動檔案出現與消失、按鈕按狀態亮滅、點選發 `chapterAction`；整合測試：`openChapter` 在有 / 沒有 `openBeside` 的宿主上各開幾份。

---

## 驗收

- `npm run typecheck`、`npm run test:node`、`npm run test:e2e` 全綠。
- 假模型跑通 Task 8；續寫與重演的八種情形各有測試。
- 獨立版開啟一個排好細綱的工程：主按鈕「寫第 1 章」提示寫著「預計 1 次呼叫，最多 8 次」；寫的時候氣泡頂上有進度；寫入卡寫著字數；點章節行是正文與細綱並排。
- 真實模型跑出前 3 章，作者讀過。

## 給接手 agent 的提示詞

> 你在 `~/workspace/novelForge` 的 `refactor/blueprint-pipeline` 分支上做「三期：正文生成」。先讀 `docs/design/plans/2026-09-30-blueprint-pipeline-phase3.md` 全文、根目錄 AGENTS.md、總計劃的 §1、§2.3、§2.4 與 §4，以及二期計劃的 §5–§7。上游原始碼在 `~/workspace/AI-Novel-Writer`，移植的提示詞在註釋裡註明出處。按 Task 2→9 順序做，每個 Task 一個 commit（中文正文，結尾帶 Co-Authored-By 行），不要推送。每個 commit 前跑 `npm run typecheck`；Task 4、Task 8 結束時跑 `npm run test:node`，Task 9 結束時再跑 `npm run test:e2e`（Bun 在 `~/.bun/bin`）。Task 10 要花錢，跑之前必須先找作者確認。遇到計劃裡沒寫到、又會改變產品行為的決定，停下來問。
