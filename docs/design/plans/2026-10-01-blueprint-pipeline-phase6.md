# 六期：收尾 Implementation Plan

> **接手須知：** 這份計劃面向新的 agent，假設你**沒有讀過**前面的對話。開工前必讀：
> 1. 根目錄 [AGENTS.md](../../../AGENTS.md)：本期要改寫其中第 4、7、8、14、18、19、20、21、22、23 條（編號不動），其餘各條照常守著。
> 2. [總計劃](2026-09-30-blueprint-pipeline-roadmap.md) 的 §2（目標態）、§3.3 的 W12 / W13、§4（D13–D24）、§5 六期、§6（受影響的承諾）。
> 3. 一到五期計劃與[五期補遺](2026-10-01-blueprint-pipeline-phase5b.md)：README 要寫的就是它們落下來的行為。
>
> 每個 Task 做完立刻 commit，commit 之間 `npm run typecheck` 必須零錯誤。

**Goal:** 把新鏈路收乾淨，讓文件、工具說明、介面文案與程式碼說同一件事。agent 的工具說明與動作跟上新鏈路（不再提卷、中轉站、拆分，補上「補齊故事架構」與批次寫章的區間和模式）；清掉舊鏈路留下的死程式碼；工程頁與幾處空頁面寫出「下一步：……」並給一顆能點的按鈕；README、AGENTS.md 與各模組 README 按新鏈路重寫。

**Architecture:** 先動程式碼（工具 → 死程式碼與舊文案 → W12），每一步都有測試釘住；再寫文件（AGENTS.md → 根 README → 模組 README），文件只描述程式碼此刻的樣子。

**Tech Stack:** TypeScript、`node:test`、jsdom、Bun（e2e）。不新增依賴。

## Global Constraints

- `src/core/` 零 `vscode` import；分層契約測試全程要綠。
- **文件以程式碼為準**。總計劃裡有三處與程式碼不一致，照程式碼寫：
  - 摘要檔案按**章節檔名**映象（`chapters/001-楔子.md` → `summaries/001-楔子.md`），不是 `summaries/NNN.md`；
  - 正文的上游指紋記在**細綱 frontmatter 的 `writtenFrom`**，不在 `project.json` 的 manifest；
  - 設定四件與情節大綱之間**還沒有**指紋：鏈是「大綱那一節 → 細綱 → 正文 → 摘要」。
- **不改產品行為**，除了下面「本期定下的東西」寫明的幾處。
- 本期結束時 `npm run typecheck` + `npm run test:node` + `npm run test:e2e` 全綠。

---

## 本期定下的東西

標 ⚑ 的是本期自定的取捨，收尾時報給作者。

### 1. agent 工具

**`generate`**
- `TIER_TASK` 加 `setting: 'setting'`：agent 生成架構四件走「故事架構」檔，與工程頁「補齊設定」同一個模型（與細綱走 `plotOutline` 檔同一個道理）。大綱、正文仍嚴格用對話頁選定的模型。
- ⚑ **仍不開放審稿**，`TIER_TASK` 不加 `review`。五期把這件事留到這一期定：報告要作者在報告卡上勾選之後才修稿，agent 拿到一份「2 嚴重 · 1 建議」做不了什麼，也不該替作者決定哪幾條算數；作者要審稿，對話頁 `/审稿` 或章節條上一顆按鈕就到。`review` 檔只給批次寫章的「寫完即審稿」用。
- 檔案頭那張「哪一層用哪個模型」的表按上面改。

**`run`**
- 新增 `completeSettings`：補齊故事架構（只補空白，確認框寫明缺哪幾件、呼叫幾次）。轉發 `features/pipelineBatch.ts` 的 `completeSettings`，一字不改。
- ⚑ `batchPlots` / `batchManuscripts` 收可選的 `from` / `to`（章號區間），`batchManuscripts` 另收 `mode`（`draft` 只寫正文 / `finalize` 寫完即定稿）與 `review`（寫完即審稿）。工程頁的兩個彈窗都能選區間和模式，agent 這條路只能「從下一可寫章起、只寫正文」，作者說「把第 5–8 章寫完並定稿」它就做不到。確認框照彈（不帶 `confirmed`），區間與模式寫在框裡，次數按 `planWriteBatch` 的上限報（第 4 條）。
- `REFUSED` 裡的 `split` **保留**（`runTool.test.js` 釘著）：拿著老提示詞來的模型要聽到「這是有意不給的」，聽到「認不出」它會換十個名字接著試。
- 描述裡的標籤按新鏈路改（「定稿」「補齊故事架構」「批次拆細綱」「批次寫章」）。

**`list` / `search` / `schema.ts` / `index.ts` 的說明與註釋**
- `list` 的固定位置換成：`.novelforge/config.md`、`premise.md`、`world.md`（架構）、`outline.md`（情節大綱）、`plots/<章号>-<标题>.md`（細綱，一章一份、不分子目錄）、章節根（預設 `chapters/`）、`summaries/`、`characters/`、`lore/`。
- `search` 的 `kinds` 說明按 `KINDS` 實際的值寫（`setting` 是配置 / 前提 / 世界觀三件），刪掉 `manuscript`、`volume`——現在模型填 `volume` 會被靜默丟掉、變成不限種類的搜尋。
- `schema.ts` 與 `agent/loop.ts` 裡「劇情不寫畫面、天氣、臺詞」那句與現在的細綱提示詞相反（關鍵事件可以寫具體場面），改掉。

**契約測試**（新增 `tests/contract/toolText.test.js`）：登錄檔裡每個工具的 `description` 與引數說明、`run` 的動作標籤裡，不許出現「卷」「中轉站」「劇情段」「拆分」「拆成章節」「volumes/」「manuscripts/」。這是模型每一輪都讀的文字，舊說法會讓它去找不存在的東西；其餘註釋與歷史說明不在這條測試裡（那裡大量合法地寫著「從前……」）。

### 2. 清死程式碼

舊鏈路的關鍵詞在程式碼裡已經沒有死分支：卷、中轉站、`split` 還剩的引用都是有意保留的（D11 的「老工程目錄不讀不刪」、舊會話歸一、守衛），並且有測試釘著。真正的死程式碼是下面幾處，名字裡不帶關鍵詞：

| 位置 | 是什麼 | 怎麼處理 |
|---|---|---|
| `workspace/handlers/types.ts` 的 `appendHead?()` / `appendSeparator?`，`workspace/index.ts` 的 `appendText` 裡對應的兩處判斷 | 唯一的實現者是刪掉的中轉站 handler（拆章用的 `---` 分隔符） | 刪鉤子，`appendText` 直接走預設 |
| `media/src/css/view/pipeline.css` 的 `.crumb-sep` | 生產它的「› 場景 N」麵包屑早沒了 | 刪 |
| 會話級 `targetWords`：`model/session.ts`、`controller/serialize.ts`、`protocol/views.ts` 的 `SerializedSession.targetWords` | 一期刪了輸入框（W1）之後只剩「從舊 JSON 讀出來再原樣寫回」，前端不讀 | 刪欄位；舊會話裡的這個鍵讀的時候忽略，下次儲存時自然消失 |
| `model/plotFile.ts` 的 `describePlot` | 沒有生產呼叫方，只有一條單測 | 刪函式與那條斷言 |
| `tests/integration/features/selectPlot.test.js` 調 `bundle.project.emptyPlotSections?.()`、寫 `arc` 與老四節 | 那個匯出不存在，`renderPlotFile` 也只寫三節，這些輸入不起作用 | 換成現行的三節 |

`LEGACY_CAPABILITY` / `LEGACY_STAGE`（總計劃點名的「LEGACY 相容表」）**保留**：舊會話裡存著 `volume`、`split`，開啟時要歸一，`session.test.js` 釘著。`guard.ts` 保護 `volumes/`、`manuscripts/`、`scenes/` 不被刪（D11）也保留，順手給 `guard.test.js` 補上 `volumes/` 那一條（現在漏測）。

### 3. 舊鏈路的文案與註釋

**作者看得見的**（這幾處是 bug，不只是措辭）：
- `package.json` 的 `novel.newPlot` 標題「Novel: 新建劇情段」→「Novel: 新建細綱」。
- `shells/vscode/extension.ts` 與 `features/lore.ts` 的提示「寫完正文先拆成章節，才能總結 / 生成設定」→ 按現在的判據說（「這一章還沒有正文」「還沒有寫過正文」）。

**註釋**：約 35 處還在講場景目錄、中轉站、拆分、劇情段、「寫劇情 / 落定劇情」「劇情 · 4/4 節」的註釋，按新鏈路改，逐處見調研清單（Task 3）。講「從前……、為什麼刪掉」的歷史說明保留——那是有意的。測試檔案頭與夾具裡同樣的舊說法一併改；夾具裡寫老四節細綱、但測的不是「老格式容錯」的那幾份換成三節。

### 4. W12 空狀態寫出下一步（⚑ 按鈕做什麼）

- **下一步從狀態機來**（第 20 條）：`ProjectTree` 加 `next?: NextStepView`，就是對話頁主按鈕在「全書」那一檔會給的那一步。`controller/chat.ts` 的 `bookNextStep(c)` 只用到 `c.project`，搬到 `views/pipeline.ts` 改成 `bookNextStep(project)`（連同 `targetOf`，`controller/serialize.ts` 留轉發），`buildProjectTree` 與 `pushPipeline` 共用。前端不自己判斷「下一步是什麼」，文案用 `next.label`。
- ⚑ **空狀態的按鈕不直接花錢**：與「去生成」「去寫這一章」同一個口徑——點了是**進入那一層**（對話頁的主按鈕就是它）、**開啟彈窗**（一句話、拆細綱，彈窗上寫著呼叫次數）或**走自帶確認框的工程動作**；真正花錢的那一下仍在主按鈕或確認框上。全書只推一個下一步，所以空狀態說的就是主按鈕那一步，不另起一個。
- 落點：

| 位置 | 現在 | 改成 |
|---|---|---|
| 工程頁「章節」組為空 | 「還沒有章節。先把故事架構與情節大綱寫好，再拆出細綱。」，沒有按鈕 | 「下一步：{next.label}」+ 按鈕：設定那幾件 → 「去生成」（小說配置開一句話彈窗，其餘進入那一層）；情節大綱 → 「去生成」（進入大綱層）；拆細綱 → 「拆細綱…」（開拆細綱彈窗） |
| 工程頁「章節」組不空、但下一可寫章還沒有細綱那一行 | 沒有任何提示（「去寫這一章」掛不上） | 組末一行同樣的「下一步：拆細綱（第 a–b 章）」+「拆細綱…」 |
| 工程頁「角色」組為空 | 「還沒有角色卡。可執行「提取/更新角色卡」從正文抽取。」 | 全書下一步正是角色圖譜：「下一步：生成角色圖譜」+「去生成」（進入那一層）；已有正文（老工程）：說清可以從正文提取 +「提取角色卡…」（`extractCharacters`，自帶確認框）；否則只說清角色卡由角色圖譜一次建好、輪到它時故事架構那一組會給「去生成」，不給按鈕。**「下一步：」只用在全書那一步上**（第 20 條：只推一個），別處的空狀態不另起一個 |
| 工程頁「設定」組為空 | 「還沒有設定條目。keywords 命中綱要時會自動注入上下文。」 | 設定條目是可選的，不寫「下一步」：說清它是什麼、什麼時候用得上，按鈕「＋ 設定」（新建一條，不調模型）；已有正文時再給「從正文生成…」（`generateLore`，自帶確認框） |
| 對話頁、工作區還不是小說工程 | 頁尾一句「先執行「Novel: 初始化小說工程」」——那是 VS Code 的命令名，獨立版裡找不到 | 空白提示換成「下一步：把這個資料夾初始化成小說工程」+「初始化小說工程」（`projectAction('initProject')`） |
| 歷史頁沒有會話 | 「還沒有儲存的對話。發出第一條訊息後會自動儲存。」 | 加「去對話頁」按鈕（切頁籤） |
| 獨立版空視窗，側邊幾頁的遮罩 | 「開啟資料夾後即可使用」 | 加「開啟資料夾…」按鈕，與歡迎頁那顆同一個動作 |

- **不改的**：對話頁空會話的提示（主按鈕就在它下面）、主按鈕條「全書都寫完了」（沒有下一步可說）、工作區卡與摘要浮窗的空說明、編輯區「還沒有開啟檔案」（已經寫清去哪點）、文風與摘要組（固定行，不會空）。

### 5. 文件

**AGENTS.md**
- 刪掉頂上「重構中」的橫幅；開頭四段（兩條軸、四環、卷、劇情段、中轉站）按新鏈路重寫：一句話 → 架構四件 → 情節大綱（按「第 a–b 章」分節）→ 細綱（一章一份，細綱號 = 章號）→ 正文直接落 `chapters/` → 定稿（摘要 + 連續性事實 + 角色當前狀態）；審稿是可選動作。
- 模組地圖、架構要點裡的舊說法（`volumeFile.ts`、`beatsHash`、「創作（四層產物）」），以及「加新產物要同改幾處」統一成一種說法：寫原始碼入口，再改三處（`build-media.js` 的 `JS_ENTRIES` / `CSS_ENTRIES`、`embed-media.js` 的 `built`、`page.ts` 的引用；外掛也要載入時再改 `webviewHtml.ts`）。`media/README.md`、`standalone/README.md` 同一句話。
- 規則逐條（**編號不動、不合併**）：
  - 第 4 條：呼叫次數寫在動手之前——主按鈕、卡片與確認框都報，自動續寫算上限；單章寫完不自動定稿（D17）。
  - 第 7 條：刪「`plots/`/`volumes/` 的改名刪除走專門方法以帶走中轉站正文」。
  - 第 8 條：**整條改寫**為「細綱號 = 章號，只有一條軸」：細綱與正文按章號配對，介面一律稱「第 N 章」；章節順序仍由檔名數字字首決定，與目錄層級無關。
  - 第 14 條：補 D13（細綱的 `characters[]` 是計劃出場，只給裝配器挑角色卡，不進 `buildCastIndex`）。
  - 第 18 條：鏈換成「大綱那一節 →（`upstreamHash`）細綱 →（細綱上的 `writtenFrom`）正文 →（`sourceHash`）摘要」；刪「拆分是唯一人工閘口」；定稿過的章只掛 ⟳、不被拉回。
  - 第 19 條：補上現行的幾種例外——補齊設定只補空白；細綱帶出的新角色直接建卡（D19）；定稿時機器維護的「當前狀態」直接更新、作者改過的不寫掛黃 ❗（D15）；批次寫章遇到重演、提前登場、沒寫夠也落盤但停。
  - 第 20 條：主按鈕來自 `deriveBookNextStep` 與 `deriveNextStep` 兩級；審稿不進主按鈕；`selectPlot` 現在按章號認（「絕不在兩條軸之間按號互認」那半句作廢）。
  - 第 21 條：細綱三節（本章目的 / 關鍵事件 / 章末鉤子），關鍵事件可以寫具體場面、不寫成正文，章末鉤子必填；寫夠沒有看 `targetWords`，缺席取小說配置的每章字數，再缺席有字就算。
  - 第 22 條：`generate` 有單章與每批 5 章兩種用法，與 `settle` 共用同一份細綱合同。
  - 第 23 條：**原位替換**為「定稿是這條鏈上唯一的人工閘口」：一章只有摘要新鮮才算完成；單章寫完不自動定稿，下一步按鈕給「定稿第 N 章」並寫明呼叫次數，只有批次的「寫完即定稿」模式裡自動定稿。
- 第 26 條等其餘各條不動。

**根 README**：開頭三段與「從腦洞到成書」、介面總表、工程頁（含長任務進度、資料夾與檔案操作）、對話怎麼用（流水線條、工作區卡、下一步、`/` 命令、直接打字就是 agent、落盤卡片，**補上**寫章進度與自動續寫、重演確認、一致性預檢、審稿報告卡與按勾選修稿、合併檢視、定稿）、目錄結構、角色卡格式（`stateThrough` / `stateHash`、「當前狀態」歸機器維護）、上下文是怎麼裝配的（四層 + 審稿 + 修稿）、命令表、摘要格式（七節，含連續性事實）與過期機制、模型分檔表（補「故事架構」「批次審稿」「Agent 排程」）、程式碼結構。「獨立版的角色卡更新只有確認框、沒有 diff」那句一併改掉（五期有了合併檢視）。

**模組 README**：`src/README.md`、`src/core/README.md`、`agent/README.md`（狀態簡報示例整段換成現在 `buildStateBrief` 的真實輸出）、`context/README.md`、`features/README.md`、`llm/README.md`（走池的不只工程頁任務）、`shells/vscode/README.md`、`shells/standalone/README.md`、`media/README.md`（卷組、`.row-volume`、幾處數字）、`tests/README.md`（`manuscripts/` 那句、任務錶行數、漏列的測試檔案）、`workspace/README.md`、`sample-novel/README.md` 與 `sample-novel/chapters/README.md`（整段在講中轉站與拆章）、`docs/design/README.md`（承諾條數、索引補上這條重構的 spec 與各期計劃）。

### 6. 本期不做

- **W13 點選數驗收、獨立版從一句話手動走到第 3 章（單步、批次各一遍）、桌面殼能起來**：作者 2026-10-01 說本機做不到的暫時不管。前兩項要真實模型呼叫（約 40–45 次）；桌面殼要 Rust 工具鏈與圖形介面，本機都沒有。
- 五期補遺試跑剩下的三個質量問題（第 3 章鉤子後多餘的過場、段尾總結句、修稿刪多與錯別字）：作者說後面再說。
- 設定四件 → 大綱的指紋（讓改了世界觀的大綱掛 ⟳）：是新功能，不是收尾。

---

## 提交節奏（8 個 commit）

| # | 字首 | 主題 |
|---|---|---|
| 1 | `docs` | 本計劃 |
| 2 | `refactor(tools)` | agent 工具跟上新鏈路：架構走故事架構檔、`run` 補齊架構與批次的區間和模式、說明不再提卷與中轉站 |
| 3 | `chore` | 清掉舊鏈路的死程式碼，作者看得見的舊提示與註釋按新鏈路改 |
| 4 | `feat(media)` | W12 空狀態寫出下一步 |
| 5 | `docs` | AGENTS.md 按新鏈路改寫 |
| 6 | `docs` | 根 README 按新鏈路改寫 |
| 7 | `docs` | 模組 README、示例工程說明同步 |
| 8 | `test` | 六期驗收：全量 typecheck / node / e2e（只在有修補時才有這個 commit） |

---

### Task 2：agent 工具（commit 2）

- `tools/novel/generate.ts`：`TIER_TASK.setting = 'setting'`；檔案頭的表；`review` 那條報錯與說明保留，註釋改成「六期定了不開放」並寫理由。
- `tools/novel/run.ts`：`completeSettings`；引數 `from`、`to`（`int`）、`mode`（`str`，列舉 `draft` / `finalize`）、`review`（`bool`）；`batchPlots` 把區間傳給 `generatePlots({ range })`，`batchManuscripts` 傳 `writeManuscripts({ range, mode, review })`；只給了 `from` 時 `to` 按各自預設補（拆細綱 5 章、寫章 3 章）；`from > to` 當場報錯。刪 `REFUSED.split`。描述裡寫清「區間與模式只對 batchPlots / batchManuscripts 有意義」。
- `tools/novel/list.ts`、`search.ts`、`schema.ts`、`index.ts`、`agent/loop.ts`：說明與註釋。
- 測試：
  - `tests/integration/tools/generateTiers.test.js`：架構層走 `setting` 檔的池、檔位沒配時退回對話頁的模型；大綱、正文仍不走池。
  - `tests/integration/tools/runTool.test.js`：`completeSettings` 轉發且次數記賬；`batchManuscripts` 帶 `from/to/mode/review` 時確認框裡寫著區間與模式、次數按上限；`from > to` 報錯不調模型；`split` 現在走「認不出」。
  - `tests/contract/toolText.test.js`（新增）：§1 那條。

### Task 3：死程式碼與舊文案（commit 3）

- §2 表裡五處。
- §3 作者看得見的三處；外加一處五期留下的：`/` 命令面板給每條命令都掛「寫檔案」，`/审稿` 只出報告，改掛「只出報告」。以及調研清單裡的註釋（`shells/vscode/extension.ts`、`controller/files.ts`、`controller/index.ts`、`controller/chat.ts`、`controller/agent.ts`、`features/characters.ts`、`features/summarize.ts`、`files/fileOps.ts`、`model/session.ts`、`model/tiers.ts`、`generation/generate.ts`、`workspace/index.ts`、`workspace/guard.ts`、`workspace/handlers/{types,chapter,doc}.ts`、`media/src/view/{commands,messages}.ts`、`media/src/view/project/{groups,summaryTip}.ts`、`media/src/css/view/{summary-tip,pipeline,messages}.css`）。`handlers/chapter.ts` 檔案頭「所以這裡沒有 `onRemove`」與下面的實現矛盾，一併改。
- 測試檔案頭與夾具：`tokenizer`、`selectPlot`、`characterCard`、`lore`、`drafts`、`chapters`、`listCache`、`choices`、`cast`、`readTools`、`unit/generation/drafts`、`e2e/standalone/server`。
- `tests/integration/workspace/guard.test.js` 補 `volumes/` 的保護。
- 跑 `npm run test:node`。

### Task 4：W12（commit 4）

- `views/pipeline.ts`：`bookNextStep(project)`、`targetOf`；`controller/chat.ts`、`controller/serialize.ts` 改呼叫 / 留轉發。
- `protocol/views.ts`：`ProjectTree.next?: NextStepView`；`views/projectView.ts` 填上。
- `media/src/view/project/rows.ts`：`nextRow(step, tree)`——「下一步：……」+ 一顆 `chip-btn`，按 §4 的規則決定按鈕做什麼；`emptyRow` 照舊給不帶按鈕的說明用。`index.ts` 的章節、角色、設定三組按 §4 接上。
- `media/src/view/state.ts` / `messages.ts`：未初始化時的空白提示與按鈕。`media/src/view/history.ts`：「去對話頁」。`media/src/view/welcome.ts`：遮罩上的「開啟資料夾…」。
- CSS 同步（`scripts/verify-css.js` 是拆 CSS 時比對新舊兩份用的，這裡用不上；`npm run media` 構建通過即可）。
- 測試：
  - `tests/integration/views/projectTreeReads.test.js`：空工程的 `next` 是「生成小說配置」（帶一句話彈窗的預設值）；架構齊了、沒大綱是「生成情節大綱」；有大綱沒細綱是「拆細綱（第 1–5 章）」；與 `pushPipeline` 推給對話頁的全書下一步逐字一致。
  - `tests/dom/view/projectTree.test.js`：章節組為空時三種 `next` 各自的文案與按鈕（配置開一句話彈窗、其餘發 `setTarget`、拆細綱開彈窗），**都不發 `send`**；章節不空但缺下一章細綱時組末那一行；角色組兩種空法；設定組的「＋ 設定」發 `newLore`。原來「前三組的行裡只有『去生成』『去寫這一章』兩種按鈕」那條斷言照舊成立（下一步那一行不是 `.row`）。
  - `tests/dom/view/creation.test.js`：未初始化時的提示與「初始化小說工程」發 `projectAction`。
  - `tests/dom/view/history.test.js`（沒有就新建）：空列表的按鈕切到對話頁。
  - `tests/dom/standalone/welcome.test.js`：遮罩上的按鈕與歡迎頁那顆發同一條訊息。
- 跑 `npm run test:node`。

### Task 5：AGENTS.md（commit 5）

按 §5 改。改完 grep 一遍全倉庫「第 N 條」的引用（`grep -rn "第 8 條\|第 23 條" src media tests`），引用處說的意思與新條文對不上的，改引用處的措辭。

### Task 6：根 README（commit 6）

按 §5 改。每一段寫之前先去程式碼裡核對，不照總計劃抄（Global Constraints 那三處）。按鈕、命令、徽章的文字逐字取自程式碼（`model/pipeline.ts` 的標籤、`shells/shared/panes.ts`、`media/src/view/project/`）。

### Task 7：模組 README（commit 7）

按 §5 的清單改，只改現在說錯了的段落。

### Task 8：驗收

`npm run typecheck`、`npm run test:node`、`npm run test:e2e`。有修補才 commit。

---

## 驗收

- `npm run typecheck`、`npm run test:node`、`npm run test:e2e` 全綠。
- `grep -rn "中转站\|剧情段\|拆成章节\|卷纲" README.md AGENTS.md` 只剩講歷史的句子（「從前……已經刪掉」）。
- 獨立版開啟一個空工程：工程頁「章節」組寫著「下一步：生成小說配置」，點「去生成」開一句話彈窗；開啟 sample-novel：章節組末尾是「下一步：拆細綱（第 4–8 章）」一類的提示。

## 給接手 agent 的提示詞

> 你在 `~/workspace/novelForge` 的 `refactor/blueprint-pipeline` 分支上做「六期：收尾」。先讀 `docs/design/plans/2026-10-01-blueprint-pipeline-phase6.md` 全文、根目錄 AGENTS.md、總計劃的 §2、§3.3（W12）、§4、§5 六期與 §6。按 Task 2→8 順序做，每個 Task 一個 commit（中文正文，結尾帶 Co-Authored-By 行），不要推送。每個 commit 前跑 `npm run typecheck`；Task 3、Task 4 結束時跑 `npm run test:node`，Task 8 再跑 `npm run test:e2e`（Bun 在 `~/.bun/bin`）。寫文件時以程式碼為準，不照總計劃抄。這一期不調真實模型。遇到計劃裡沒寫到、又會改變產品行為的決定，停下來問。
