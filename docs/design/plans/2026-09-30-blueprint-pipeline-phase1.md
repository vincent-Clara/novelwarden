# 一期：一章一綱的資料層與狀態機 Implementation Plan

> **接手須知：** 這份計劃面向新的 agent，假設你**沒有讀過**前面的對話。開工前必讀：
> 1. 根目錄 [AGENTS.md](../../../AGENTS.md)：26 條產品承諾，本期直接關係到第 1、2、3、8、9、18、20、21 條。
> 2. [總計劃](2026-09-30-blueprint-pipeline-roadmap.md) 的 §2（目標態）、§3.3 的 W1/W2、§4（D13–D24）。
> 3. [設計](../specs/2026-09-29-blueprint-pipeline-design.md) 的 D1–D3、D11。
> 4. 前置：零期已合入（`403a6ac`..`028faa6`）。
>
> 每個 Task 做完立刻 commit，commit 之間 `npm run typecheck` 必須零錯誤。

**Goal:** 把「大綱 → 卷 → 劇情段 → 中轉站 → 拆章」換成「架構 → 大綱 → 細綱（一章一份）→ 正文（直接落 `chapters/`）」的資料層、狀態機、協議與介面骨架。本期**不移植任何新提示詞**（那是二、三期），只保證：新鏈路的每一層都有落點、狀態機算得對、主按鈕指得準、工程還能跑。

**Architecture:** 自底向上。先加純函式的新格式（零消費者，單測先綠），再做一次大切換（狀態機 + 所有消費者 + 刪卷與中轉站），最後是前端骨架與夾具。

**Tech Stack:** TypeScript、`node:test`、jsdom（DOM 測試）、Bun（e2e）。不新增依賴。

## Global Constraints

- `src/core/` 零 `vscode` import；分層契約測試（corePurity / shellPurity / layerBoundary）全程要綠。
- 老工程磁碟上的 `volumes/`、`manuscripts/`、`scenes/`、老四節細綱**一個位元組都不動**：程式碼不讀它們（`kindOfPath` 判成 `other`），`guard.ts` 繼續把這幾個目錄列為受保護目錄。
- **解析一律不拋**（第 1 條）：老四節細綱讀進來就是「三節全空」，狀態機如實說「待寫細綱」，不崩。
- 本期結束時 `npm run typecheck` + `npm run test:node` + `npm run test:e2e` 全綠。
- 只刪與卷、段、中轉站、拆章直接相關的程式碼與測試，別的測試一條不許紅。

---

## 本期定下的模型（寫進程式碼註釋）

### 階段、能力、目標

```ts
type CreationStage = 'setting' | 'outline' | 'plot' | 'manuscript';
// 架構 / 大綱 / 細綱 / 正文
type Capability = 'discuss' | 'generate' | 'settle';          // 刪 split
type SettingDoc = 'config' | 'premise' | 'characters' | 'world';

type CreationTarget =
  | { kind: 'setting'; doc: SettingDoc }
  | { kind: 'outline' }
  | { kind: 'plot'; plotRelPath: string }
  | { kind: 'manuscript'; plotRelPath: string };
```

- `STAGE_CAPABILITIES`：setting / outline / manuscript 是 `[discuss, generate]`，plot 是 `[discuss, settle, generate]`。
- 老會話相容（`normalizeAction` / `normalizeTarget`）：
  - `volume` → `outline`，`scene` → `plot`；
  - `split` → `generate`；
  - `setting` 帶著認不出的 `doc` → `config`。
- 介面叫法：
  - 階段 `setting` 叫「架構」，避免和設定條目（lore，介面上叫「設定」）撞名；
  - 四件文件依次叫「小說配置 / 故事前提 / 角色圖譜 / 世界觀」。

### 單章狀態機

`PlotStage = 'plot' | 'manuscript' | 'finalize' | 'done'`，對應「待寫細綱 / 待寫正文 / 待定稿 / 已完成」。

判據（`written` = 同號章節存在且字數 > 0）：

| 條件 | 階段 |
|---|---|
| `!written && !plotFilled` | plot |
| `!written && plotFilled` | manuscript |
| `written`，摘要存在且不過期，或 `markedDone` | done |
| `written`，細綱在正文之後改過（`upstreamStale`） | manuscript（重寫） |
| `written`，字數不到目標的 80% | manuscript（接著寫） |
| 其餘 | finalize |

- 目標字數取細綱的 `targetWords`；沒有就取 `config.md` 的 `wordsPerChapter`；兩者都沒有時「有字就算寫夠」。
- `finalize` 的主按鈕是 `projectAction: 'finalizeChapter'`。**本期只做摘要**，四期再補角色狀態；按鈕文案本期寫「定稿（生成摘要）」。

### 全書狀態機（純函式，controller 只取數）

```ts
interface BookFacts {
  settings: Record<SettingDoc, boolean>;   // 各自有沒有實質內容
  outlineFilled: boolean;
  outlineCoverage: number;    // 大綱按章號區間覆蓋到第幾章；有內容但沒有區間標題時視為 Infinity
  totalChapters?: number;     // config.md
  nextChapterNo: number;      // 從第 1 章起連續有正文的最大章號 + 1
  nextPlotFilled: boolean;    // 那一章有沒有排好的細綱
}
type BookStage = 'setting' | 'outline' | 'plots' | 'writing' | 'complete';
```

按順序取第一個不滿足的：
1. 四件設定按 config → premise → characters → world 的順序，缺哪件推哪件；
2. 大綱缺失，或 `nextChapterNo > outlineCoverage` → 生成 / 續寫情節大綱，區間是 `[coverage+1, min(total, coverage+20)]`；
3. `!nextPlotFilled` → 拆細綱，區間是 `[N, min(N+4, coverage, total)]`；
4. 已經寫滿 `totalChapters` → complete，不給按鈕；
5. 否則進入第 N 章的單章狀態機。

`NextStepPlan` 新增 `range?: { from: number; to: number }`，本期只用來顯示和透傳。**本期的「拆細綱」一次只生成區間裡的第一章**；按區間一次出 5 章是二期的事。

### 一條軸

- 細綱 `plots/NNN-标题.md` 平鋪，不再按卷分子目錄；`plots/` 下子目錄裡的檔案判成 `other`。
- 細綱號 = 章號。第 N 章的細綱、正文、摘要按號互認，**只在 `views/pipeline.ts` 的一個函式里做**（`chapterOfPlotNo`）：同號的章節有多份時取路徑排序第一份，並記一條 warn。
- 正文落點：同號章節已存在就用它；否則是 `chapters/NNN-<细纲标题>.md`。解析落點要讀盤，所以是 async 的 `chapterTargetOf(project, plotRelPath)`（views/pipeline.ts），**不放進純函式 `pathOfTarget`**。

### 細綱格式（D3）

```markdown
---
no: 12
title: 夜入青雲
role: 小高潮
characters: [林昭, 沈青]
targetWords: 3000
upstreamHash: …
writtenFrom: …
status: done        # 可選，作者手工宣佈
generatedBy: novelwarden
---
# 第12章 夜入青雲
## 本章目的
## 關鍵事件
## 章末鉤子
```

- `isPlotFilled`：「關鍵事件」非空才算排過。
- `characters[]` 不進 `buildCastIndex`（D13）。
- **`writtenFrom`**：正文依據的細綱指紋，由正文落盤路徑（accept 與批次寫正文）寫進細綱自己的 frontmatter。
  - `upstreamStale` 的判據是 `writtenFrom && writtenFrom !== plotContentHash(plot)`。
  - 為什麼記在細綱這一側：章節可以是 `.txt`、沒有 frontmatter，而且是作者的檔案（第 9 條），只能記在細綱這邊。這和從前 `chapters:` 欄位是同一個理由。
  - 作者手寫的正文沒有 `writtenFrom`，所以永遠不會被標髒（第 18a 條）。
- `upstreamHash`：大綱裡**覆蓋本章的那一節**的指紋，找不到對應區間就用全書大綱的指紋。這樣改第 21–40 章那一節，不會讓第 1–20 章的細綱掛 ⟳。

### 設定文件與大綱區間

- `model/settingFile.ts`：四件文件的路徑、小節表、`isSettingFilled`、解析與渲染。
  - `config.md` 的 frontmatter 欄位見總計劃 §2.1，數字欄位用 `asNumber` 容錯。
  - `characters` 這一件沒有自己的檔案，「有沒有」看 `characters/` 下有沒有至少一張卡。
- `model/outlineFile.ts`：
  - `parseOutlineRanges(text)` 認 `## 第a–b章：標題` 與 `## 第N章：標題`（橫線接受 `-–—~～至到`，冒號接受中英文），返回 `{from, to, title, text}[]`；
  - `outlineCoverage(text)` 返回覆蓋到的最大章號；
  - `outlineSliceFor(text, no)` 返回覆蓋第 `no` 章的那一節。

---

## 提交節奏（7 個 commit）

| # | 字首 | 主題 |
|---|---|---|
| 1 | `feat` | 純函式新格式：`settingFile`、`outlineFile`，以及細綱 D3 格式的解析與渲染（新檔案 `blueprintFile.ts`，暫不接線） |
| 2 | `refactor` | **大切換 · 模型與閘道器**：`pipeline.ts` 新狀態機，`plotFile.ts` 換成 D3，刪 `volumeFile.ts`；`project.ts`、`types.ts`、`kind.ts`、handlers、`workspace/index.ts`；刪 `splitChapter.ts` |
| 3 | `refactor` | **大切換 · 裝配與生成**：context 各層與配方、`prompts.ts` 的過渡版契約、`artifact.ts`、`accept.ts`、`generate.ts`、`pipelineBatch.ts` |
| 4 | `refactor` | **大切換 · 檢視、協議、controller、工具、agent** |
| 5 | `refactor` | 前端骨架：W1 + W2（工程頁「故事架構」組 + 一軸章節列表，流水線條三格，刪掉目標字數輸入框） |
| 6 | `test` | sample-novel 重做 + 契約測試 |
| 7 | `docs` | 本期涉及的模組 README 同步（全量改寫留到六期） |

commit 2–4 之間**允許**測試紅，但 typecheck 必須過；commit 4 結束時 `test:node` 全綠。實在拆不開的話，2–4 合成一個 commit。

---

### Task 1：純函式新格式（commit 1）

**Files:**
- Create：`src/core/model/settingFile.ts`、`src/core/model/outlineFile.ts`
- Create：`tests/unit/model/settingFile.test.js`、`tests/unit/model/outlineFile.test.js`
- 細綱 D3 格式直接寫在 Task 2 的 `plotFile.ts` 裡；這裡先把 `outlineFile` 的區間解析做好，Task 2 就能直接用。

**測試要點：**
- 區間標題的各種寫法：`第1-20章`、`第1–20章`、`第 21 至 40 章`、`第7章`、全形冒號 / 半形冒號 / 沒有冒號；
- 不連續的區間、重疊的區間：以先出現的那一節為準，不拋；
- `config.md` frontmatter 寫壞時各欄位退化成 undefined；數字欄位是字串時轉成數字；
- `isSettingFilled` 不把佔位文字（`（待補充）`）當作內容。

### Task 2：模型與閘道器（commit 2）

**`model/pipeline.ts`** 按上面的模型整份重寫：
- 保留 `chapterLabel`、`isFallbackChapterTitle`、`labelOf`、`commandsFor`、`describeTarget`、`targetKey`、`manuscriptRatio`；
- 刪 `volumeLabel`、`segmentLabel`、`segmentDisplayNo`、`volumeOfTarget`；
- 新增 `SETTING_DOCS`、`SETTING_DOC_LABEL`、`settingOfTarget`；
- `deriveBookStage` / `deriveBookNextStep` 換成新簽名，`deriveBookNextStep` 返回帶 `target` 與 `range` 的計劃：
  - `plots` 那一檔的 target 路徑由 controller 用 `plotPathForNo` 補；
  - `writing` 那一檔返回 undefined，controller 轉去問第 N 章的單章狀態機。

**`model/plotFile.ts`**：
- 換成 D3 格式；
- `Plot` 刪 `arc` 和 `chapters`，加 `role`、`characters`、`writtenFrom`；
- 渲染出的標題行是 `# 第N章 標題`；
- 檔名規則不變（三位數字首）。

**刪 `model/volumeFile.ts`**，同時刪 `chapterFile.ts` 裡的 `splitByMark` 等拆章函式。

**`model/project.ts`：**
- 刪 `volumesDir`、`plotsDirForVolume`、`plotsMirrorRelPathForVolume`、`manuscriptsDir`、`plotStem`、`manuscriptPathForPlot`、`manuscriptMirrorRelPath`、`listVolumes`、`readVolume`、`nextVolumeNo`、`listPlotsOfVolume`、`readManuscript`；
- `listPlots` 只掃 `plots/` 根目錄；
- 加 `configPath`、`premisePath`、`worldPath`，以及 `readSetting(doc)`、`readConfigDoc()`（返回解析好的 config）；
- `initialize` 不再建 `volumes/`、`manuscripts/`，改為寫入 config / premise / world 的模板；大綱模板去掉「分卷規劃」一節，換成區間示例；
- `nextPlotNo` **保持**「細綱號與章號裡最大的 +1」（工程頁「新建細綱」接在最後一章之後；給缺口補細綱走全書狀態機的「拆細綱」）。

**`model/types.ts`**：刪 `Manuscript`；`Chapter` 與 `ManifestChapter` 的註釋裡去掉中轉站。

**`workspace/kind.ts`：**
- `ArtifactKind` 刪 `volume`、`manuscript`，加 `setting`（同時帶上 `doc`）；
- `plots/` 下只認根目錄的檔案；
- `pathOfTarget`：setting 返回對應文件路徑；`characters` 那一件返回角色目錄；manuscript 拋錯，提示呼叫方改用 `chapterTargetOf`。

**handlers：**
- 刪 `volume.ts`、`manuscript.ts`；
- `plot.ts` 的上游指紋換成大綱切片的指紋（`outlineSliceFor`），刪掉伴生搬遷（沒有中轉站了）；
- 加 `setting.ts`：純文字加 frontmatter，不記賬；
- `types.ts` 刪 `appendSeparator` 的「拆分候選點」語義，預設只空一行。

**`workspace/index.ts`：**
- 刪 `writeVolume`、`deleteVolume`、`appendToManuscript`、`splitManuscript`；
- `writePlot` 去掉 `dir` 引數；
- 加 `recordWrittenFrom(plotRelPath)`：用 `rewriteFrontmatter` 只改細綱的 frontmatter。

**`workspace/guard.ts`**：受保護目錄表加上 `.novelforge/volumes`（原來漏了）。

**刪 `features/splitChapter.ts`** 及其呼叫點。

### Task 3：裝配與生成（commit 3）

- **`context/layers/`：**
  - `artifacts.ts` 刪卷的三層；`plotSelf` / `plotPrev` / `plotNext` 改讀 D3 三節；
  - `focus.ts` 按章號認，不再回落到中轉站，刪 `segmentsOfVolume`；
  - `render.ts`：新細綱的渲染；`selectCharacters` **優先**取本章細綱的 `characters[]`，其次才是原有判據（D13）。
- **`context/recipes.ts`：**
  - 刪 volume，加 setting（system、ask、config、已有的三件文件、歷史）；
  - 正文配方本期**不加新層**（三期做），只把資料來源從中轉站換到 `chapters/`。
- **`context/prompts.ts`：**
  - 刪拆卷、拆段的職責與契約；
  - 加 setting 的**過渡版**職責與契約：按該文件的小節輸出 Markdown，二期換成移植的提示詞；
  - 細綱契約換成 D3 三節，並刪掉「不寫畫面」的禁令（第 21 條本期先改程式碼，文字六期再改）。
- **`features/artifact.ts`：**
  - 刪 `volumeList`、`plotSegment`、`parsePlotList`；
  - 加 `settingDoc` 產物（落點由 target 決定）；
  - `plot` 產物換成 D3 三節，外加 `role`、`characters`、`targetWords`、`title`。
- **`generation/accept.ts`**：五條分支變成 setting / outline / plot / manuscript 四條：
  - manuscript：`chapterTargetOf` → 章節不存在就 `createChapter`（標題行是 `# 標題`，與改名時同步標題的規則一致）；存在就 `append`，中間空一行。然後 `recordWrittenFrom`，再 `syncManifest`。
  - 覆蓋 / 重寫的語義留到三期定，本期保持從前「接著往下寫」的行為。
- **`generation/generate.ts`**：失敗掛在細綱路徑上（不變），正文落點換掉。
- **`features/pipelineBatch.ts`**：
  - `generatePlots`：給「有章號、沒有排好細綱」的章一章一次地補，不再按卷；
  - `writeManuscripts`：寫到 `chapters/`；併發先保持原樣，四期改成序列。
- **`model/tiers.ts`**：刪 volume 相關的任務說明。

### Task 4：檢視、協議、controller、工具、agent（commit 4）

- **`views/pipeline.ts`：**
  - `buildPlotPipeline` 按號合併細綱與章節；
  - `buildPipelineIndex` 返回 `rows`：1..max(細綱號, 章號) 的**每一個章號**一行，缺號的不補空行；
  - 刪 `segments`、`displayNo`、`consumed`、`chaptersOfSegment`；
  - 加 `buildBookFacts(project)`，供 controller 與 agent 共用（第 20 條：同一份事實）。
- **`views/projectView.ts`：**
  - `ProjectTree` 刪 `volumes`、`volumeCount`、`segmentCount`、`volumesRoot`；
  - 加 `architecture: ArchitectureRow[]`（五行：四件文件加情節大綱，每行帶 `filled`、`upstreamStale`、`detail`）和 `bookStage`；
  - `ProjectPlotNode` 刪 `kind`、`manuscriptPath`，一行就是一個章號。
- **`views/workbench.ts`**：setting / outline / plot / manuscript 四種浮窗；正文層的浮窗顯示本章細綱的三節加字數（順帶修掉 §3.1-7）。
- **`protocol/`：**
  - `views.ts`、`in.ts` 跟著改；
  - `ProjectAction` 刪 `newVolume`、`splitManuscript`，`summarizePlot` 改名 `finalizeChapter`；
  - `SendPayload` 刪 `targetWords`（W1），加可選的 `range`。
- **`controller/chat.ts`：**
  - `pushPipeline` 在單章狀態機返回 undefined 時，退回到全書下一步；
  - `bookNextStep` 改用 `buildBookFacts` + 純函式；
  - `selectPlot` 按號認章：給章節路徑時找同號細綱的**應在**路徑。
- **`controller/project.ts`**：`newPlot` 為下一個沒有細綱的章號建空殼；刪 `newVolume`、`splitManuscript`；`finalizeChapter` 本期走原來的 summarize。
- **`tools/novel/`：**
  - `generate` 接受章節路徑：按號解析出細綱，作為 manuscript target；描述文案同步；
  - `run` 刪 `split`；
  - `list`、`search`、`naming` 改文案和列舉。
- **`agent/context.ts`**：狀態簡報換成全書狀態加當前章，用 `buildBookFacts`。
- **`model/session.ts`**：老會話按上面的相容規則回落。
- **`shells/vscode/quickContinue.ts`**：manuscript target 改成按章號解析。

### Task 5：前端骨架（commit 5）

- **`media/src/view/pipeline.ts`**：
  - 麵包屑寫「第 N 章《標題》」或「故事架構 · 故事前提」；
  - 三格是「細綱 · 正文 · 定稿」；
  - 刪掉卷那一格。
- **`composer.ts`**：主按鈕發 `step.target` 與 `step.range`（修 §3.1-1）；刪 `#targetWords`。
- **`state.ts`**：目標下拉只列章號行，「新建細綱」落到下一個沒有細綱的章。
- **`project/index.ts`、`groups.ts`、`rows.ts`：**
  - 「故事架構」組五行，組標題寫 x/5，右鍵「開啟 / 生成（重寫）」；
  - 「章節」組一行一章：`第12章 夜入青云　纲● 文 2980/3000 定稿●`；
  - 刪卷組、劇情段、時間線分界線。
- **`panes.ts`**：刪過時文案（§3.1-10）和目標字數輸入框。
- **CSS**：刪卷與段的樣式，確認 `verify-css` 沒有意外改動。
- **DOM 測試**：
  - 重寫 `dom/view/creation.test.js`、`projectTree.test.js` 裡跟卷和段相關的組，以及 `tests/helpers/dom.js` 的 `sampleTree` / `pipelineView`；
  - 新增一條斷言：主按鈕發出的 `send` 帶的是 `step.target`。

### Task 6：sample-novel 與契約（commit 6）

- 3 章正文**不動**（否則要同步 contentHash 與 sourceHash）。
- 補 `config.md`（totalChapters 30、wordsPerChapter 400，和現有正文的長度對得上）、`premise.md`、`world.md`。
- `outline.md` 改成按區間分節；3 份細綱換成 D3 格式。
- `tests/contract/sampleNovel.test.js` 刪「中轉站為空」那一條，加「細綱號 = 章號」「config 能解析」兩條。

### Task 7：模組 README（commit 7）

只改本期動過、而且現在的描述已經**錯了**的段落：model、workspace、views、context、generation、features、media、tests。AGENTS.md 與根 README 的全量改寫留到六期，本期只在 AGENTS.md 頂部加一行「生成鏈路重構中，以總計劃為準」。

---

## 驗收

- `npm run typecheck`、`npm run test:node`、`npm run test:e2e` 全綠。
- 獨立版開啟 sample-novel：
  - 工程頁有「故事架構」組（5/5）和一軸的章節列表；
  - 主按鈕是「寫第 4 章細綱」一類（因為 sample 只寫了 3 章）；
  - 點了之後發出去的 target 是第 4 章的細綱路徑。
- 獨立版新建一個空工程：主按鈕是「生成小說配置」，點了之後流式輸出、出寫入卡、能落盤到 `config.md`（過渡版提示詞，內容好不好不算驗收項）。

## 給接手 agent 的提示詞

> 你在 `~/workspace/novelForge` 的 `refactor/blueprint-pipeline` 分支上做「一期：一章一綱的資料層與狀態機」。先讀 `docs/design/plans/2026-09-30-blueprint-pipeline-phase1.md` 全文、根目錄 AGENTS.md、`docs/design/plans/2026-09-30-blueprint-pipeline-roadmap.md` 的 §2 與 §4。按 Task 1→7 順序做，每個 Task 一個 commit（中文正文，結尾帶 Co-Authored-By 行），不要推送。每個 commit 前跑 `npm run typecheck`；Task 4 與 Task 7 結束時跑 `npm run test:node` 與 `npm run test:e2e`（Bun 在 `~/.bun/bin`）。老工程的 `volumes/`、`manuscripts/` 目錄在磁碟上一個位元組都不動。遇到計劃裡沒寫到、又會改變產品行為的決定，停下來問。
