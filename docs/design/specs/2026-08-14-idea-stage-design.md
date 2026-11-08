# 靈感層設計（腦洞 → 全書大綱）

日期：2026-08-14
狀態：待評審

## 背景與目標

專案定位從「為長篇小說做 LLM 上下文管理」改成**「把一個腦洞養成一本完整的書」**。定位一改，流水線的源頭就露出一個缺口：

現在的源頭是 `.novelforge/outline.md`。**在它之前的那一步——「這本書到底是個什麼東西」——不在工程裡**：作者只能在對話方塊裡打一段話，讓模型直接吐一份大綱。那段話不落盤、不可討論、不可挑刺、不可重做，下一次開對話就沒了；大綱寫歪了也回溯不到「當初我想的是什麼」。

本設計補上這一層：**靈感（idea）**，產物是 `.novelforge/idea.md`，與既有四層同構——同樣的 Stage × Capability × Target 三維模型、同樣的產物解析三層降級、同樣的採納才落盤、同樣的零模型呼叫新鮮度鏈。

流水線因此變成五層：

```
靈感      →  全書大綱  →  章節細綱  →  場景細節  →  正文
這是個什麼故事  故事講什麼   這章發生什麼   這幕長什麼樣   怎麼寫出來
```

**非目標**：不做「一鍵從腦洞生成整本書」。靈感層的價值在於把那句話**變成可反覆挑刺的產物**，而不是多一個自動化入口。

## 關鍵決策

| 決策點 | 結論 | 理由 |
| --- | --- | --- |
| 產物落點 | `.novelforge/idea.md`，單檔案，與 `outline.md` / `style.md` 同級 | 全書唯一一份，沒有映象路徑問題 |
| 檔案格式 | frontmatter + 固定小節（同細綱/場景卡） | 複用 `pickSections` / `stringifySections`，解析可三層降級 |
| 階段能力 | `discuss / expand / critique / check / generate / rewrite`，**無 `split`** | 靈感的下一層是一份大綱文件，不是一個清單；「展開成大綱」由大綱層的 `generate` 承擔，與 `scene` 層無 split 同理 |
| 新鮮度鏈 | `idea.md ──hash──▶ outline.md`，hash 記在 `project.json` | `outline.md` 是作者高頻手改的純 Markdown，給它加 frontmatter 會天天撞衝突；manifest 已經是「檔案自身放不下指紋」時的落點（正文的 `beatsHash` 就在那裡） |
| 靈感進不進正文上下文 | **不進**。只出現在 `idea` 與 `outline` 兩張配方里 | 立意已經沉澱進大綱與細綱，寫正文時再帶一遍是純浪費；這與「前三層不帶正文原文」是同一條取捨 |
| 老工程遷移 | 不自動生成、不強制補。沒有 `idea.md` 就是一張空卡 | 已經寫了七十章的人不需要被叫回去補一份「立意」 |
| 初始化 | `initialize()` 寫入 `IDEA_TEMPLATE`，但**不改**初始化問的那兩個問題（書名 / 作者） | 讓「先有個名字」變成動筆門檻是反的；名字可以最後再起 |

## A. 領域模型（`src/core/model/pipeline.ts`）

純型別 + 純函式層的改動，前端、裝配器、編排層共用這一份。

```ts
export type CreationStage = 'idea' | 'outline' | 'plan' | 'scene' | 'manuscript';
export const CREATION_STAGES = ['idea', 'outline', 'plan', 'scene', 'manuscript'];
```

配套的五張表各加一行：

| 表 | `idea` 的值 |
| --- | --- |
| `STAGE_LABEL` | `靈感` |
| `STAGE_QUESTION` | `這是個什麼故事？` |
| `STAGE_ROLE` | `選題策劃` |
| `STAGE_CAPABILITIES` | `['discuss','expand','critique','check','generate','rewrite']` |
| `DEFAULT_CAPABILITY` | `discuss`（與其餘四層一致：預設動作不花錢） |
| `CAPABILITY_LABEL_IN.idea` | `generate: '寫下這個腦洞'`、`rewrite: '重寫腦洞'` |

`CreationTarget` 加一支：

```ts
| { kind: 'idea' }
```

- `targetKey({kind:'idea'})` → `'idea'`
- `describeTarget` → `'靈感'`
- `chapterOfTarget` → `undefined`（與 `outline` 同）
- `normalizeTarget` 的兜底**仍是 `outline`**：它在任何工程裡都存在，改兜底會讓老會話的落點漂移

### 全書級流水線狀態（新增）

現有 `ChapterStage` / `deriveStage` 回答的是「這一章走到哪了」。靈感層不屬於任何一章，需要一個同構的全書級狀態機：

```ts
export type BookStage = 'idea' | 'outline' | 'chapters' | 'writing';

export interface BookFacts {
  ideaFilled: boolean;      // idea.md 有實質內容
  outlineFilled: boolean;   // outline.md 去掉模板佔位後有內容
  chapterCount: number;
  ideaStale: boolean;       // 大綱所依據的靈感已變（manifest.ideaHash 對不上）
}

export function deriveBookStage(f: BookFacts): BookStage;
export function deriveBookNextStep(stage: BookStage, f: BookFacts): NextStepPlan | undefined;
```

判據自上而下取第一個不滿足的：沒靈感 → 寫靈感；有靈感沒大綱 → 生成大綱；有大綱沒章節 → 拆成章節；有章節 → 交給既有的按章流水線（返回 `undefined`，創作頁照舊按當前章節給下一步）。

`ideaStale` 隻影響標記，不改變 `BookStage`——**改了靈感不等於大綱作廢**，只是提醒回頭看一眼（與 ⟳ 的既有語義一致）。

### 判據為什麼不落盤

與 `deriveStage` 同一條理由：狀態欄位會在作者手刪內容之後開始撒謊。`ideaFilled` / `outlineFilled` 每次從磁碟現算。

## B. 檔案格式（新增 `src/core/model/ideaFile.ts`）

與 `planFile.ts` / `sceneFile.ts` 同類：純函式、零 I/O、解析絕不拋。

```ts
export const IDEA_SECTION_KEYS = [
  '一句話',        // logline：一句話說清這本書是什麼
  '前提',          // 這個世界/情境哪裡不一樣，鉤子在哪
  '主角與慾望',    // 誰，他要什麼，為什麼現在
  '核心衝突與代價', // 擋在中間的是什麼，輸了會怎樣
  '結局設想',      // 想收在哪兒（可以只是一個方向）
  '基調與參照',    // 想寫成什麼味道，像哪幾本書
] as const;

export interface Idea {
  relPath: string;
  title: string;          // frontmatter.title，與 project.json 的書名同步顯示
  sections: IdeaSections;
  body: string;           // 小節之外作者自己加的內容，讀回來時保留
}

export function isIdeaFilled(s: IdeaSections): boolean;  // 一句話 或 核心衝突與代價 非空
export function parseIdeaFile(text: string, relPath: string): Idea;
export function renderIdeaFile(idea: WritableIdea): string;
```

`isIdeaFilled` 只認那兩節：只寫了「基調與參照」等於什麼都沒想清楚，流水線該停在 `idea`。佔位文字（`（待補充）`）不算內容——複用 `planFile.ts` 裡那個 `meaningful`，提取到 `markdown.ts` 共用。

模板（`IDEA_TEMPLATE`，寫在 `project.ts` 與其餘模板並列）：六個小節 + 每節一句括號提示，與 `OUTLINE_TEMPLATE` 的寫法一致。

### `project.ts` 的改動

- `get ideaPath()` → `.novelforge/idea.md`
- `readIdea()` / `writeIdea()`（與 `readOutline` / `writeOutline` 並列，缺檔案時返回空 `Idea` 而不是拋）
- `initialize()` 增加 `writeIfAbsent(this.ideaPath, IDEA_TEMPLATE)`
- `ProjectManifest` 增加兩個可選欄位：

```ts
ideaHash?: string;      // 生成/最後一次採納 outline.md 時 idea.md 的 hash
```

`MANIFEST_VERSION` 不動：新增可選欄位，老 manifest 讀進來就是 `undefined`，語義正好是「沒有依據、不標髒」。

## C. 新鮮度鏈

現有鏈條前面接一節：

```
idea.md    ──hash──▶ outline.md      (manifest.ideaHash)      ← 新增
outline.md ──hash──▶ plans/*.md      (frontmatter.upstreamHash)
plans/X.md ──hash──▶ scenes/X/*.md   (frontmatter.upstreamHash)
scenes/X/* ──hash──▶ chapters/X      (manifest.beatsHash)
chapters/X ──hash──▶ summaries/X.md  (frontmatter.sourceHash)
```

- 採納大綱（`acceptOutline`）時把當前 `idea.md` 的 hash 寫進 `manifest.ideaHash`。
- `manifest.ideaHash` 存在且與當前 `idea.md` 對不上 → 大綱行/大綱麵包屑掛 ⟳。
- **`ideaHash` 不存在時不標髒**——手寫的大綱（以及所有老工程的大綱）永遠不掛 ⟳，與「手寫產物不掛 ⟳」的既有規則一致。
- 依然是零模型呼叫、零 token，只是多比對一個 hash。

**不做級聯**：改了靈感只標大綱，不順著往下把所有細綱一起標髒。⟳ 是「回頭看一眼」的提示，不是審計報告；一次改動點亮全書三百行 ⟳，作者會學會無視所有標記。

## D. 上下文裝配

### 新增層 `ideaDoc`（`src/core/context/layers/artifacts.ts`）

讀 `idea.md`，渲染成 `# 這本書是什麼` 段落。空檔案時不產出條目（而不是產出一個空段落）。

`ContextItemKind` 與 `LayerName` 各加 `'ideaDoc'`。

### 配方（`src/core/context/recipes.ts`）

```ts
idea: [
  { layer: 'system',      priority: 0, force: true },
  { layer: 'ask',         priority: 0, force: true },
  { layer: 'attachments', priority: 0, cap: ATTACHMENT_CAP },
  { layer: 'ideaDoc',     priority: 0, force: true },
  { layer: 'history',     priority: 1, cap: HISTORY_CAP },
  { layer: 'lore',        priority: 2 },
],
```

這一層**刻意貧瘠**：討論「這本書是個什麼故事」時，大綱、摘要、角色卡都還不存在，或者存在也沒用——真正的輸入是作者那句話和現有的靈感卡。`lore` 留著是為了一種真實情形：世界觀是先搭起來的，腦洞長在它上面。

`outline` 配方在 `outlineDoc` 之前插入：

```ts
{ layer: 'ideaDoc', priority: 0, force: true },
```

於是「從腦洞生成大綱」不需要作者再複述一遍立意——這正是這一層存在的意義。其餘三張配方一字不動。

## E. 提示詞（`src/core/context/prompts.ts`）

`STAGE_DUTY.idea`：

> 你負責幫作者把一個還很模糊的念頭想清楚：這個故事的鉤子在哪、主角要什麼、擋在中間的是什麼、輸了會付出什麼代價、大致收在哪兒。你不排幕、不分章、不寫場景——那是後面幾層的事。判斷一個故事成不成立，看的是「主角的慾望有沒有被真正阻擋」，不是「設定夠不夠炫」。

`buildOutputContract` 的 `idea` 分支（`generate` / `rewrite`）：要求只輸出 JSON，鍵即 `IDEA_SECTION_KEYS`，並補三條要求：

1. 「一句話」必須能讓人一句話之內明白這書是什麼，不要寫成宣傳語。
2. 「核心衝突與代價」要寫清失敗會失去什麼——沒有代價的衝突撐不起一本書。
3. 想不清楚的小節留空字串，不要為了填滿而編。

`critique` 在這一層最值錢，沿用通用的「只說問題和改法，不要順手替他改寫」，不額外定製。

`askHeading` 不動（靈感層用通用的 `# 我的要求`）。

## F. 產物解析與採納

`src/core/features/artifact.ts`：

```ts
| { kind: 'idea'; sections: IdeaSections }
```

- `parseArtifact`：`stage === 'idea'` → `parseIdeaSections(text)`，三層降級（JSON → `## 小節` → 全文塞進「一句話」）。
- `isArtifactEmpty` / `describeArtifact`（`灵感 · 4/6 节`）各加一支。
- 另出一個 `parseIdeaStrict`（只走前兩層，不做全文兜底），留給將來可能出現的批次路徑；創作頁用帶兜底的那個。

`src/core/features/creation.ts`：

- `acceptArtifact` 增加 `case 'idea': return this.acceptIdea(artifact.sections)`。
- `acceptIdea` 走 `confirmOverwrite`（已有內容時先對比再決定），與 `acceptOutline` 同形。
- `acceptOutline` 末尾增加一行：把當前 `idea.md` 的 hash 寫進 manifest。

## G. 檢視與協議

| 位置 | 改動 |
| --- | --- |
| `core/views/pipeline.ts` | 新增 `buildBookPipeline(project): BookPipeline`（取 `BookFacts` → `deriveBookStage` / `deriveBookNextStep`） |
| `core/views/workbench.ts` | `target.kind === 'idea'` 時給出靈感卡：標題「靈感」，攤開六個小節（全書唯一一份，內容短，可以全攤）；空態文案「這本書還只是一個念頭。先把它說清楚，大綱從它展開。」 |
| `core/views/projectView.ts` | 「文風與摘要」分組頂部增加**靈感**一行（與全書大綱同類：固定檔案，不可改名/刪除） |
| `core/protocol/views.ts` | `ProjectView` 增加 `ideaPath`；流水線檢視增加 `bookStage` 與 `ideaStale` |
| `core/files/attachments.ts` | `@` 引用候選增加 `idea.md`（與 `outline.md` / `style.md` 並列） |

## H. 前端

- **麵包屑**：最左端多一格 `靈感`，點了切到靈感層。鏈條變成 `靈感 › 全書大綱 › 第 12 章《…》 › 場景 2`。大綱那一格在 `ideaStale` 時掛 ⟳。
- **主按鈕（下一步）**：當前沒選章節時讀 `bookStage`——「寫下這個腦洞 → 生成全書大綱 → 拆成章節」。**新工程第一次開啟創作頁，主按鈕是「寫下這個腦洞」而不是一片空白**，這是這次改動對新使用者最直接的收益。
- **`/` 命令面板**：`commandsFor('idea')` 自動產出六條，前端零改動。
- **工程頁**：靈感行右鍵給「開啟 / 討論這個腦洞 / 重寫」，無「刪除」。
- 階段徽章、進度條等按 `CREATION_STAGES` 遍歷的地方自動多一格；需要檢查前端是否有寫死四層的地方（`media/src/view/creation/*` 的流水線條）。

## I. 測試

| 檔 | 用例 |
| --- | --- |
| `unit` | `ideaFile` 解析/渲染往返、壞 frontmatter 不拋、`isIdeaFilled` 的佔位判定；`deriveBookStage` / `deriveBookNextStep` 全狀態覆蓋；`STAGE_CAPABILITIES.idea` 不含 `split`；`normalizeTarget('idea')` 與老會話兜底不變；`parseIdeaSections` 三層降級 |
| `integration` | 採納靈感產物落盤（含覆蓋確認）；採納大綱寫入 `manifest.ideaHash`；改 `idea.md` 後大綱標髒、老工程（無 `ideaHash`）不標髒；`idea` / `outline` 兩張配方的裝配明細 |
| `dom` | 麵包屑五格與點選切層；新工程空態的主按鈕文案；工程頁靈感行的右鍵選單 |
| `contract` | 無新增約束；`sample-novel/` 增加一份 `idea.md` 並確認 hash 斷言不受影響 |

## J. 分期

| 期 | 內容 | 可獨立交付 |
| --- | --- | --- |
| **一** | 領域模型 + `ideaFile.ts` + `project.ts` 讀寫與模板 + 解析/採納 + 提示詞 + 兩張配方 | 能在創作頁選「靈感」層討論並生成產物，寫盤可用 |
| **二** | `BookStage` 全書狀態機 + 主按鈕 + 麵包屑 + 工程頁那一行 | 新工程有明確的第一步 |
| **三** | `ideaHash` 新鮮度鏈與 ⟳ | 改了腦洞能看見大綱需要回頭 |

一期是主體（八成工作量集中在模型層與解析層，且全部有既有同構實現可抄）；二三期各自小而獨立，可以分開評審。

## K. 明確不做

- **不做「一鍵成書」**：靈感 → 大綱 → 拆章 → 批次細綱這條鏈每一步都要作者點。
- **不把靈感注入正文上下文**：寫第 80 章時帶上一份立意宣言，只會擠掉真正有用的前文。
- **不做靈感的多版本管理**（同時養三個腦洞、A/B 對比）。真要比，`idea.md` 是普通 Markdown，Git 分支比任何內建版本機制都好用。
- **不自動為老工程反推靈感**（讀全書摘要倒推一份立意）。看起來聰明，實際是拿模型編一段作者從沒想過的話，然後把它掛在流水線源頭。
