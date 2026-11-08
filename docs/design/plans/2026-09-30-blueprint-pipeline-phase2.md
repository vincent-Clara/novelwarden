# 二期：架構 + 大綱 + 細綱批次的生成 Implementation Plan

> **接手須知：** 這份計劃面向新的 agent，假設你**沒有讀過**前面的對話。開工前必讀：
> 1. 根目錄 [AGENTS.md](../../../AGENTS.md)：本期直接關係到第 1、2、3、4、11、15、19、20、21、22 條。
> 2. [總計劃](2026-09-30-blueprint-pipeline-roadmap.md) 的 §1（#1–#8、#21）、§2.3、§3.3 的 W2–W5、§4（D16、D19–D21）。
> 3. [一期計劃](2026-09-30-blueprint-pipeline-phase1.md) 的「本期定下的模型」一節：本期在那套狀態機與檔案格式上長出生成能力，不改格式。
> 4. 上游原始碼：`~/workspace/AI-Novel-Writer`（GPL-3.0，源自 AI_NovelGenerator）。移植處在註釋裡註明出處（AGPL 與 GPLv3 可組合，總計劃 §8）。
>
> 每個 Task 做完立刻 commit，commit 之間 `npm run typecheck` 必須零錯誤。

**Goal:** 從一句話到前 5 章細綱，每一步都用從 AI-Novel-Writer 移植的提示詞與輸出合同生成；結構化產物不合格時按上游的修復鏈降級；工程頁有「一句話」「拆細綱」兩個彈窗和「補齊設定」批次動作。正文層的提示詞與自動續寫是三期的事，本期不動。

**Architecture:** 純函式先行（結構指導、大綱合併、批次規劃、三種結構化解碼），再是提示詞與裝配層，然後是把多次呼叫串起來的生成鏈（`generation/structured.ts`，單步與批次兩條路共用），最後是落盤、批次動作與前端。

**Tech Stack:** TypeScript、`node:test`、jsdom、Bun（e2e）。不新增依賴。

## Global Constraints

- `src/core/` 零 `vscode` import；分層契約測試全程要綠。
- **解析一律不拋**（第 1 條）。解碼函式要「報原因」時返回診斷物件，不拋異常；拋只發生在生成鏈裡，並且被 `generate` 兜成一條人話錯誤。
- **不靜默截斷**（第 2 條）：每一次降級（拆半重試、單章緊湊重建、語法修復、欄位級重寫、漏欄位）都寫進 Draft 的 `notes`，顯示在落盤卡片上並進日誌。
- **動手之前寫明呼叫次數**（第 4 條、D16）：見下文「呼叫次數」一節。確認框與主按鈕提示用同一個純函式算。
- **當場過人 / 批次只補空白**（第 19 條）：對話頁的每一次生成照舊只出一張落盤卡片；工程頁的「補齊設定」「批次拆細綱」跳過已有產物，不問、不覆蓋。
- 本期結束時 `npm run typecheck` + `npm run test:node` + `npm run test:e2e` 全綠。

---

## 本期定下的東西（寫進程式碼註釋）

### 1. 六種故事結構都帶章號區間（`model/structureGuide.ts`，新）

上游只給三幕、起承轉合、多線、自由四種算了區間，英雄之旅與節拍表只有一行佔位（`architecture-workflow.ts:238-241`）。這裡六種都按累計百分比切，一個分配函式：

- 三幕：20 / 75 / 100；起承轉合：25 / 50 / 75 / 100；
- 英雄之旅十二階段：平凡世界 5、冒險召喚 10、拒絕召喚 13、遇見導師 18、跨越門檻 25、考驗盟友敵人 40、接近洞穴 50、磨難 60、獎賞 70、歸途 80、復活 92、攜寶歸來 100；
- 節拍表十五拍：開場畫面 1、主題呈現 5、鋪墊 10、催化劑 12、猶豫 20、進入第二幕 22、B 故事 25、遊戲時間 50、中點 52、壞人逼近 72、一無所有 75、靈魂黑夜 80、進入第三幕 82、終局 98、終場畫面 100；
- 多線敘事：交匯點落在 25% / 50% / 75% 那幾章；自由結構：開篇前 12%、收尾後 12%。

分配規則：第 i 段的終點 = `max(上一段終點 + 1, round(total × p_i))`，同時給後面每段至少留一章。總章數少於段數時允許相鄰段共用一章（「第 3 章：催化劑 · 猶豫」）。`structureStagesIn(range)` 返回與本批區間相交的那幾段，大綱續寫時告訴模型「這 20 章落在哪幾段」。

### 2. 大綱按區間合併（`model/outlineFile.ts` 加 `mergeOutline`）

生成第 a–b 章的大綱時，模型只輸出這一段。落盤時：刪掉舊大綱裡**與 [a, b] 重疊**的區間節，把新的幾節插到第一個被刪節的位置（沒有被刪的就按章號插到合適位置）；區間之外的節、沒有區間標題的前言原樣保留。舊大綱沒寫過就直接用新的。結果走覆蓋審閱（舊大綱有內容時）。

### 3. 細綱批次（`model/pipeline.ts`）

- `BookFacts` 加 `plotFilledNos: number[]`。`deriveBookNextStep` 的「拆細綱」區間改成：從下一可寫章起**連續沒有細綱**的那幾章，最多 5 章，不超過大綱覆蓋與總章數。已經排好的章不會被圈進來（主按鈕那一批永遠是空白）。
- 純函式 `planPlotBatches({ from, to, filledNos, coverage, total })` → `{ chapters, skipped, batches: number[][], calls }`：區間內跳過已有細綱的章，剩下的按連續段切，每段再切成 ≤5 章一批。工程頁彈窗的實時說明與後端確認框都用它（第 4 條：只算一次）。

### 4. 呼叫次數（`model/pipeline.ts` 的 `CallEstimate`）

`NextStepPlan` 加 `calls?: { expected: number; max: number }`，前端在提示後面寫「預計 1 次呼叫，最多 15 次」。

| 步驟 | 預計 | 最多 | 為什麼 |
|---|---|---|---|
| 小說配置 | 1 | 3 | 截斷時整份重來 1 次；「全域要求」不合格時只重寫這一節 1 次 |
| 故事前提 / 世界觀 / 情節大綱 | 1 | 1 | 單份 Markdown，不重試 |
| 角色圖譜 | 2–4 | 16 | 身份清單 1 次（截斷再 1 次），詳情每批 3 人；截斷時拆半，另留 1 次語法修復 |
| 細綱一批 n 章 | 1 | 3n | 上游 `blueprint-batch-policy.ts`：拆半全樹 2n−1 + 每章一次緊湊重建 n + 一次語法修復 1 |

批次動作的確認框按批次加總報。

### 5. 結構化輸出的三種合同與降級

一律「JSON → 不合格就修 → 修不好就說」，**批次細綱 fail-closed，單份文件寬鬆**：單份文件攤在卡片上，作者看得見缺了什麼；批次裡沒人逐份過目，漏一章就會讓流水線從此撒謊。

**小說配置**（上游 `generate_global_config` + `buildNovelConfigJSONContract` + `novel-config-expansion.ts`）
- 模型面向的欄位沿用上游英文鍵（`coreOutline` / `worldSetting` / `goldenFinger` / `protagonistProfile` / `globalGuidance` / `writingStyle` / `referenceWorks` + 五個選擇欄位），解碼時對映到 `config.md` 的七節與 frontmatter；「一句話」一節就是作者的原話。
- 截斷（`stop: maxTokens`）→ 丟棄，整份重來 1 次；`globalGuidance` 不合格（>600 字、行數不在 4–8、逐章大綱行 ≥2）→ 只重寫這一節 1 次；仍不合格就原樣保留並寫進說明（上游這裡直接作廢，這裡改成寬鬆：卡片上看得見，寫進去也能手改）。
- 從「一句話」彈窗發起、而 `config.md` 已有內容時，照上游 `mergeExpandedNovelConfig`：長文字保留作者原文、生成的追加在後；型別 / 受眾 / 結構 / 視角作者寫過的不改。
- **`writingStyle` 寫進 `style.md`，只在它還空著時**（D14：文風唯一出處是 `style.md`；第 3 條：有內容就不動，並在卡片上說一句）。
- 規範化結果就是將要落盤的 `config.md` 全文（外加一節「文風」），氣泡裡看到的就是會寫下去的。

**角色圖譜**（上游 `GenerateCharactersCommand` 兩段式 + `prompt-language.ts` 的身份 / 詳情合同）
- 第一步身份清單 `{"slots":[{slotId,name,role,narrativeDuty,relations:[{targetSlotId,relation}]}]}`：3–8 人、名字與 slotId 唯一、至少一個 protagonist、關係閉合不自指。不合格直接報錯（上游同樣作廢）；截斷重來 1 次。
- **補上上游沒發出去的設計原則**：上游內建模板的 `character_dynamics.content`（盟友 / 對手 / 灰色角色、避免臉譜化）從來沒進 prompt——`renderPromptTaskGuidance` 只發 `taskGuidance`，內建模板沒有這個欄位（AC:1347-1357）。這裡把它寫進第一步的任務。
- 第二步詳情每批 3 人，欄位直接對到角色卡七節：`身份 / 外貌 / 性格 / 语言习惯 / 当前状态 / 未收伏笔`，每節有字數上限（第 15 條）；「人物關係」由凍結清單生成，不讓模型寫。截斷拆半，另有 1 次語法修復。
- 規範化結果是 `{"characters":[…]}`（卡片的七節 + role + aliases）。

**細綱批次**（上游 `chapter_blueprint_chunk` + `blueprint-semantic-contract.ts` + `structured-batch-executor.ts` + `structured-syntax-repair.ts`）
- 合同 `{"blueprints":[{chapterNumber,title,role,purpose,keyEvents,characters,newCharacters?,suspenseHook}]}`，三個正文欄位對到 D3 的三節（本章目的 / 關鍵事件 / 章末鉤子）。不要上游的 `relationships`（D3 沒有它的位置）。
- 超長欄位截斷而不作廢（上游 `decodeGeneratedBlueprints` 同樣處理 `value_too_long`）。
- 降級鏈照搬 SBE：截斷且多章 → 對半拆；截斷且單章 → 單章緊湊重建（每章至多一次）；JSON 語法壞 → 一次語法修復，修復只許改標點與閉合（`preservesStructuredJsonEvidence`），改了事實就拒絕；解碼失敗多章拆半、單章緊湊重建；重複章、越界章 → 報錯；**漏章且沒有截斷證據 → 報錯，整批不寫**（fail-closed）。
- 拆出來的後一半要看得見前一半剛生成、還沒落盤的結果：裝配器的「前序細綱一覽」把它們接在磁碟上那些後面。
- 新角色（`newCharacters`）在細綱寫入時直接建卡（D19），卡片上列出會新建哪幾張；同名卡已有的不動。
- **單章**細綱（「寫第 N 章細綱」「落定細綱」）也用這份合同的單項形式（第 22 條：兩個入口契約一致），但解析寬鬆：藍圖 → 中文鍵 JSON → Markdown 小節 → 全文塞進關鍵事件，不走修復鏈。

### 6. 生成鏈（`generation/structured.ts`，新）

```ts
interface ChainIO {
  call(messages: AgentMessage[], label: string): Promise<{ text: string; stop?: StopSignal }>;
  build(patch: Partial<BuildRequest>): Promise<AgentMessage[]>;
  signal: AbortSignal;
}
completeConfig(first, io, ctx) / completeRoster(first, io) / completeBlueprints(first | undefined, io, chapters)
  → { raw, notes, calls, … }   // 失敗拋 ChainError（人話）
```

- 對話頁：`generate` 第一次流式呼叫之後，按產物種類接上對應的鏈；後續呼叫照樣流進同一個氣泡（每步前面一行「——第 2 步：角色詳情（第 1–3 人）——」），鏈結束後氣泡換成規範化結果。鏈失敗：氣泡保留已收到的全部輸出，報錯，不出卡片；失敗掛在那一章 / 那一件上（第 16 條）。
- 批次：同一套鏈，`call` 走分檔池的非流式呼叫。
- 鏈裡所有模型呼叫用同一個模型（對話頁用作者選的那一個，第 12 條）、同一檔思考深度（第 26 條：對話頁帶，批次不帶）。

### 7. 落盤（`generation/accept.ts`）

| 產物 | 落法 |
|---|---|
| 小說配置 | 整份寫 `config.md`（已有內容時審閱）；「文風」一節只在 `style.md` 空著時寫進去 |
| 前提 / 世界觀 | 不變 |
| 角色圖譜 | 每人一張卡；**同名卡走覆蓋審閱**（一張一審，總計劃二期條目）；新卡直接建 |
| 情節大綱 | 帶區間時按 §2 合併，再整份寫（有內容時審閱） |
| 細綱（單章） | 不變；新建時 `targetWords` 預設取配置的每章字數（D3：必填） |
| 細綱批次 | 逐章：已排過的審閱覆蓋，空殼直接填，沒有的新建；然後給 `newCharacters` 建卡 |

### 8. 協議與會話

- `SendPayload` 加 `setup?: { totalChapters; wordsPerChapter }`（一句話彈窗帶過來的規模）；`range` 不再只透傳。
- `ChatTurn` 記 `range` 與 `setup`，「重來一輪」據此原樣重跑。
- `Draft` / `SessionDraft` 加 `range`、`notes`、`calls`。
- `SerializedArtifact` 加 `creates?: string[]`（會新建的角色卡）與 `notes?: string[]`。
- `projectAction` 訊息加 `range?`；`ProjectAction` 加 `completeSettings`。
- `NextStepView` 加 `form?: 'idea'`（主按鈕開啟一句話彈窗而不是直接傳送）與 `formDefaults`；`ProjectTree` 加 `book`（彈窗預設值：一句話原文、總章數、每章字數、大綱覆蓋、配置有沒有內容）。
- `LlmTask` 加 `setting`（故事架構，預設精標檔：全書只跑一次，後面每一章都吃它）。

### 9. 本期不做

- 架構四件與大綱的 ⟳（上游變了的提醒）：要在每份文件裡記上游指紋，而大綱是作者高頻手改、沒有 frontmatter 的純 Markdown，留到之後與指紋鏈一起定。
- 大綱截斷後自動續寫（上游有斷點續寫）：截斷只寫進說明，下一步按鈕會因為覆蓋不到而再推「續寫情節大綱」。
- 單欄位生成的獨立入口（總計劃 §1 #2）：本期只在配置鏈內部用於「全域要求」重寫；作者要單獨重寫一節時，在對話裡對小說配置說「只改全域要求」即可（生成即修改意見）。

---

## 提交節奏（9 個 commit）

| # | 字首 | 主題 |
|---|---|---|
| 1 | `docs` | 本計劃 |
| 2 | `feat(model)` | 結構指導、大綱合併、批次規劃與呼叫次數（純函式 + 單測） |
| 3 | `feat(features)` | 三種結構化解碼與語法修復證據校驗（純函式 + 單測），`artifact.ts` 接上 |
| 4 | `feat(context)` | 移植的提示詞、四個新層與三張配方 |
| 5 | `feat(generation)` | 生成鏈、`generate` 接鏈、落盤分派、協議與會話欄位 |
| 6 | `feat(features)` | 批次拆細綱按批、補齊設定、`setting` 檔位、文風提取併入約束 |
| 7 | `feat(media)` | W3 表單彈窗、W4 一句話、W5 拆細綱、工具欄與主按鈕的呼叫次數 |
| 8 | `test` | 假模型跑通「一句話 → 第 1–5 章細綱」與三種降級 |
| 9 | `docs` | 本期動到的模組 README |

---

### Task 2：純函式（commit 2）

- Create `src/core/model/structureGuide.ts`：`structureStages(structure, total)`、`structureGuideText(structure, total, range?)`、`structureStagesIn`。
- `src/core/model/outlineFile.ts` 加 `mergeOutline(existing, incoming, range)`。
- `src/core/model/pipeline.ts`：`BookFacts.plotFilledNos`、拆細綱區間、`planPlotBatches`、`CallEstimate` 與各檔的 `calls`、`form: 'idea'`。`views/pipeline.ts` 的 `buildBookFacts` 補 `plotFilledNos`。
- 測試：六種結構在 20 / 30 / 100 / 1000 章下區間連續、覆蓋 1..total；總章數小於段數時不拋；合併的四種情形（空舊稿、替換中間一節、追加在後、保留前言）；批次規劃跳過已有、切連續段、≤5 一批；拆細綱區間在第 N+2 章已有細綱時收在 N+1。

### Task 3：解碼（commit 3）

- Create `src/core/features/structuredJson.ts`：`stripFence`、`isRepairableJsonSyntax`、`preservesJsonEvidence`（照搬上游的詞法證據比較）。
- Create `src/core/features/blueprint.ts`：`decodeBlueprints(text, chapters)` → `{ ok, items } | { ok: false, diagnostic }`，外加寬鬆版 `firstBlueprint(text)` 給單章用。
- Create `src/core/features/roster.ts`：`decodeManifest`、`decodeDetails(text, slots)`、`assembleRoster(slots, details)`。
- Create `src/core/features/novelConfig.ts`：`decodeNovelConfig`、`isGlobalGuidanceValid`、`preserveAuthorText`、`mergeWithAuthor`、`renderConfigDraft`（config.md 全文 + 「文風」節）。
- `features/artifact.ts`：`plotBatch` 產物；配置草稿帶 frontmatter 時按 `parseBookConfig` 讀；單章細綱先認藍圖單項。
- 測試：每種解碼的合格 / 缺欄位 / 超長截斷 / 圍欄 / 裸陣列；清單閉合、自指、重複名；修復證據：只補閉合括號通過、改了一個字不通過。

### Task 4：提示詞與裝配（commit 4）

- `context/prompts.ts`：
  - 配置、前提、角色（兩步）、世界觀、情節大綱、細綱批次 / 單章、語法修復、「全域要求」欄位重寫的職責、任務與輸出契約，各註明上游出處；
  - 系統提示改成可帶 `setup` / `range` / 鏈步驟的形式；
  - 細綱批次帶節奏規則（第 1–3 章在批內時帶黃金三章）與容量合同（上游 `blueprintCapacityGenerationContract`，目標字數取配置）。
- `context/types.ts`：`BuildRequest` 加 `range`、`setup`、`step`（角色詳情 / 緊湊重建）、`draftPlots`；新層 `rosterDoc`、`outlineSlice`、`plotList`、`structure`，新條目種類 `guide`。
- `context/layers/`：四個新層的實現；`focus` 認 `range`（前文邊界取 `from`，後文取 `to` 之後）。
- `context/recipes.ts`：按總計劃 §2.3 改架構、大綱、細綱三張。
- `context/builder.ts`：新條目的小節標題與順序；配置 / 細綱的輸出契約拿得到 `BookConfig`。
- 測試：三張配方的層與優先順序；提示詞裡設計原則、六種結構、黃金三章、容量合同都在；角色詳情那一步帶著凍結清單。

### Task 5：生成鏈與落盤（commit 5）

- Create `src/core/generation/structured.ts`（§6）。
- `generation/generate.ts`：記第一次呼叫的 `stop`；按產物種類接鏈；`Draft` 帶 `range` / `notes` / `calls`；鏈失敗時保留原文、報錯、記失敗。
- `generation/accept.ts`：§7 的落法。
- `controller/chat.ts`：`range` / `setup` 進會話與生成請求（對話頁批次鉗到 ≤5 章）；卡片的落點與說明寫區間、新建角色卡與降級說明；批次覆蓋判定。
- `model/session.ts`、`generation/drafts.ts`、`protocol/`：§8 的欄位。
- 測試（整合）：配置截斷重來、全域要求重寫、作者原文保留、文風進 `style.md`；角色兩步與同名審閱；細綱批次截斷拆半、缺欄位緊湊重建、語法修復、漏章 fail-closed（磁碟一個位元組不動）、新角色建卡；大綱按區間合併。

### Task 6：批次動作（commit 6）

- `features/pipelineBatch.ts`：`generatePlots(project, { range?, confirmed? })` 按 `planPlotBatches` 逐批序列、一批失敗即停；每批寫完再裝配下一批。`completeSettings(project)`：配置（只在有「一句話」可用時）→ 前提 → 角色（一張卡都沒有時）→ 世界觀，只補空白，確認框報次數。
- `model/tiers.ts`：`setting` 任務；`plotOutline` 的說明改成「每批 5 章一次呼叫」。
- `controller/project.ts`、`tools/novel/run.ts`：接上新簽名（agent 的 `run` 不帶區間，走確認框）。
- `features/stylePrompt.ts`：併入上游 `analyze_writing_style` 的任務邊界（只學技法、不復述情節 / 角色名 / 地名、不抄原句、不把樣本缺點當要求）。
- 測試：區間裡已有細綱的章跳過、一批失敗後面不跑、確認框的次數與計劃一致；補齊設定只補空白。

### Task 7：前端（commit 7）

- Create `media/src/view/form.ts`（W3）：通用表單彈窗，複用 `providerModal` 那層遮罩（兩形態都裝配了它）；欄位有多行文字、數字、章號區間；實時說明；Ctrl+Enter 提交、Esc 取消。
- W4「一句話」：主按鈕 `form: 'idea'` 時開啟；「故事架構」組小說配置那一行的右鍵「從一句話生成…」也開啟。腦洞、總章數（預設 100）、每章字數（預設 3000），實時顯示全書字數；配置已有內容時寫明「保留原文，追加生成」。提交後切到對話頁、發 `send`（帶 `setup`）。
- W5「拆細綱」：工程頁工具欄「拆細綱…」與章節組右鍵開啟；區間預設「下一可寫章起 5 章」；實時說明跳過幾章、分幾批、預計 / 最多幾次呼叫（同一個 `planPlotBatches`）；提交發 `projectAction: generatePlots` 帶 `range` 與已確認。
- 工具欄加「補齊設定」；故事架構組裡第一件沒填的那一行給「去生成」（與「去寫這一章」同一個道理）。
- 主按鈕提示後面寫呼叫次數。
- DOM 測試：彈窗的預設值、實時說明、提交發出的訊息；主按鈕 `form: 'idea'` 開啟彈窗而不直接傳送。

### Task 8：驗收用例（commit 8）

`tests/integration/generation/blueprintChain.test.js`：假模型按指令碼應答，經 controller 從空工程走「一句話 → 配置 → 前提 → 角色圖譜 → 世界觀 → 大綱第 1–20 章 → 第 1–5 章細綱」，每一步答卡片「寫入」，斷言磁碟上的檔案、主按鈕每一步落在哪、總呼叫次數。

### Task 9：README（commit 9）

只改本期動過、現在描述已經錯了的段落：context、generation、features、model、media、tests。

---

## 驗收

- `npm run typecheck`、`npm run test:node`、`npm run test:e2e` 全綠。
- 假模型跑通 Task 8 那條鏈；截斷、缺欄位、漏章三種降級各有測試。
- 獨立版新建空工程：主按鈕是「生成小說配置」，點了開啟一句話彈窗；工程頁工具欄有「補齊設定」「拆細綱…」。

## 給接手 agent 的提示詞

> 你在 `~/workspace/novelForge` 的 `refactor/blueprint-pipeline` 分支上做「二期：架構 + 大綱 + 細綱批次的生成」。先讀 `docs/design/plans/2026-09-30-blueprint-pipeline-phase2.md` 全文、根目錄 AGENTS.md、總計劃的 §1 與 §4，以及一期計劃的「本期定下的模型」。上游原始碼在 `~/workspace/AI-Novel-Writer`，移植的提示詞在註釋裡註明出處。按 Task 2→9 順序做，每個 Task 一個 commit（中文正文，結尾帶 Co-Authored-By 行），不要推送。每個 commit 前跑 `npm run typecheck`；Task 5、Task 8 結束時跑 `npm run test:node`，Task 9 結束時再跑 `npm run test:e2e`（Bun 在 `~/.bun/bin`）。遇到計劃裡沒寫到、又會改變產品行為的決定，停下來問。
