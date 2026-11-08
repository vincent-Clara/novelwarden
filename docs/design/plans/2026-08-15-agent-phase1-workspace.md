# 一期：workspace 讀寫閘道器 Implementation Plan

> **接手須知：** 這份計劃面向新的 agent，假設你**沒有讀過**前面的對話。開工前必讀：
> 1. 根目錄 [AGENTS.md](../../../AGENTS.md) —— 23 條產品承諾。本期直接關係到第 **3、6、7、8、9、10、18** 條
> 2. 設計依據 [docs/design/specs/2026-08-15-agent-architecture-design.md](../specs/2026-08-15-agent-architecture-design.md) 的 **L1 一節**
> 3. [src/core/README.md](../../../src/core/README.md) 的「已知約定」全段
> 4. 前置：[零期](2026-08-15-agent-phase0-provider-events.md) 必須已經合入
>
> 每個 Task 按 `- [ ]` 逐步執行，做完立刻 commit。

**Goal:** 把散在六處的檔案讀寫收斂成**唯一閘道器** `core/workspace/`，守衛在入口做一次，產物記賬下沉到寫入路徑本身。這一期結束時，「給 agent 一個 `write`」不再是一件危險的事。

**Architecture:** 自底向上三步：先抽**純函式**的路徑種類表（零 I/O，可單測），再抽**統一守衛**（把六處各自的檢查合併成一份），最後逐個把既有寫盤路徑改成經閘道器。**每一步都保證全量測試綠**——這一期一個新功能都沒有，任何一條測試變紅都意味著改錯了。

**Tech Stack:** TypeScript（`src/core/workspace/`，零 vscode 依賴）+ `node:test` + `npm run typecheck`。不新增依賴。

## Global Constraints

- **行為不變**（唯一例外見下）。`npm test` 全綠是本期的驗收標準。
- **唯一有意的行為變化**：`upstreamHash` / `beatsHash` 的記賬從「只在採納路徑上做」下沉到「誰寫都做」。這修掉一個既有缺陷——作者在內建編輯器裡改一份細綱，指紋鏈現在會斷（那一章從此不掛 ⟳）。要為它**補一條整合測試**。
- 守衛八條一條都不能少（見下面的守衛表）。**新程式碼不許繞過 `guard.ts` 直接 `fs.writeFile`。**
- `src/core/` 零 `vscode` import（`tests/contract/corePurity.test.js`）。
- 不要同時留下 `project.ts` 的舊寫方法與 `workspace` 的新方法。每個 Task 搬完就刪舊的。
- 每個 Task 結束立刻 commit；字首 `refactor` / `test` / `docs`；中文正文。

---

## 目標態檔案結構

```
src/core/workspace/
├── index.ts        Workspace 門面：list / read / write / edit / move / remove / search
├── kind.ts         ★ 路徑 → 種類（純函式，零 I/O，絕不拋）
├── guard.ts        ★ 統一入口守衛（八條）
├── search.ts       全文檢索（樸素掃描，零模型呼叫）
├── handlers/
│   ├── index.ts    種類 → handler 登錄檔
│   ├── plot.ts     解析/渲染/記 upstreamHash/伴生搬遷
│   ├── scene.ts    解析/渲染/記 upstreamHash/改標題清舊檔名
│   ├── manuscript.ts 追加/記 beatsHash
│   ├── chapter.ts  草稿跟隨/manifest 同步
│   ├── summary.ts  sourceHash
│   ├── doc.ts      outline / style / globalSummary / character / lore（純文字 + frontmatter）
│   └── plain.ts    other / draft（純文字，無記賬）
└── README.md
```

搬空之後：

- `model/project.ts` 只剩**領域查詢**（`listPlots` / `getPlot` / `nextPlotNo` / `listChapters` / `listScenes` / `readPlot` / `readScene` / `readManuscript` / `readSummary` / `syncManifest` / 路徑推導 getter…）與 `initialize`。寫方法（`writePlot` / `writeScene` / `deletePlot` / `appendToManuscript` / `splitManuscript` / `writeCharacter` / `writeLore` / `writeSummary` / `writeStyleGuide` / `writeGlobalSummary` / `createChapter` / `ensureDraft`）全部搬走。
- `files/fileOps.ts`、`files/projectFiles.ts`、`files/fileEditing.ts` 的**守衛部分**搬進 `guard.ts`，只留各自的互動流程（彈輸入框、拼 toast 文案）。
- `features/creation.ts` 的 `acceptArtifact` 六條分支變成六次 `workspace.write(path, {artifact})`。

## 提交節奏（8 個 commit）

| # | 字首 | 主題 |
|---|---|---|
| 1 | `refactor` | 抽出 `workspace/kind.ts`（純函式種類表） |
| 2 | `refactor` | 抽出 `workspace/guard.ts`（統一守衛） |
| 3 | `refactor` | `Workspace` 門面 + `plain` / `doc` handler |
| 4 | `refactor` | plot / scene handler，記賬下沉 |
| 5 | `refactor` | manuscript / chapter / summary handler |
| 6 | `refactor` | `acceptArtifact` 六條分支改走閘道器 |
| 7 | `refactor` | 檔案頁 / 內建編輯器 / fileOps 改走閘道器 |
| 8 | `feat` | `workspace/search.ts` |

---

### Task 1: 抽出 `workspace/kind.ts`

**Files:**
- Create: `src/core/workspace/kind.ts`
- Create: `tests/unit/workspace/kind.test.js`

這是整期的地基：**純函式、零 I/O、絕不拋**。判定邏輯現在散在四處，本 Task 把它們合成一處並**逐字保留口徑**：

| 現有判定 | 位置 | 搬進 `kind.ts` 後 |
|---|---|---|
| 章節檔名規則（數字字首 + 副檔名不在黑名單） | `model/chapterFile.ts` 的 `isChapterFileName` | **繼續 import 它**，不復制 |
| 細綱檔名 | `model/plotFile.ts` 的 `parsePlotFileName` | 繼續 import |
| 場景檔名 | `model/sceneFile.ts` 的 `parseSceneFileName` | 繼續 import |
| 區歸屬 | `files/fileOps.ts` 的 `sectionOf` | `kindOfPath` 內部用同一套字首比較 |
| `plots/` 路徑判定 | `files/fileOps.ts` 的 `isPlotPath` | 合進來，原處改為轉發 |

**Interfaces:**

```ts
export type ArtifactKind =
  | 'outline' | 'style' | 'globalSummary'
  | 'plot' | 'scene' | 'manuscript'
  | 'chapter' | 'summary' | 'draft'
  | 'character' | 'lore'
  | 'other';

export interface PathKind {
  kind: ArtifactKind;
  /** 規範化後的相對路徑（正斜槓）。越界時是 undefined，此時 kind 恆為 'other'。 */
  rel?: string;
  /** 該路徑對應的創作層。非創作產物為 undefined。 */
  stage?: CreationStage;
  /** 該路徑對應的創作目標，供 generate 直接用。 */
  target?: CreationTarget;
  no?: number;
  sceneNo?: number;
  /** scene / manuscript / summary 這類映象產物所屬的細綱路徑。 */
  plotRelPath?: string;
}

export function kindOfPath(project: NovelProject, relPath: string): PathKind;

/** 反過來：這個創作目標該落在哪個路徑。`acceptArtifact` 用它。 */
export function pathOfTarget(project: NovelProject, target: CreationTarget): string;
```

**三條必須寫進註釋的取捨：**

1. **`scene` 的 `plotRelPath` 要從映象目錄名反推**。`scenes/012-入宗/02-翻越侧峰.md` → 細綱是 `plots/012-入宗.md`。反推靠 `project.plotStem` 的逆運算；找不到對應細綱檔案時**仍然返回 `kind: 'scene'`**（檔案確實在那兒），只是 `plotRelPath` 指向那個應該存在的位置。
2. **`chapter` 與 `other` 的邊界**：章節根之下、數字字首、副檔名不在二進位制黑名單 → `chapter`；否則 `other`。**不看是不是 `.md`**（第 9 條：章節不認副檔名）。
3. **越界一律 `other` 且 `rel: undefined`**，不拋。這個函式會被前端傳上來的路徑呼叫。

- [ ] **Step 1: 寫失敗測試** `tests/unit/workspace/kind.test.js`

用例矩陣（至少這些）：

| 輸入 | 期望 kind | 期望其餘欄位 |
|---|---|---|
| `.novelforge/outline.md` | `outline` | `stage: 'outline'`, `target: {kind:'outline'}` |
| `.novelforge/plots/012-入宗.md` | `plot` | `no: 12`, `stage: 'plot'` |
| `.novelforge/plots/012.md`（無標題） | `plot` | `no: 12` |
| `.novelforge/scenes/012-入宗/02-翻越侧峰.md` | `scene` | `no: 12`, `sceneNo: 2`, `plotRelPath: '.novelforge/plots/012-入宗.md'` |
| `.novelforge/manuscripts/012-入宗.md` | `manuscript` | `no: 12` |
| `chapters/012-入宗.md` | `chapter` | `no: 12` |
| `chapters/012-楔子`（無副檔名） | `chapter` | `no: 12` |
| `chapters/第一卷/013-夜访.txt` | `chapter` | `no: 13`（層級只是收納，第 8 條） |
| `chapters/cover.png` | `other` | — |
| `chapters/说明.md`（無數字字首） | `other` | — |
| `.novelforge/summaries/012-入宗.md` | `summary` | `no: 12` |
| `.novelforge/characters/林昭.md` | `character` | — |
| `.novelforge/lore/青云宗.md` | `lore` | — |
| `drafts/012-入宗.md` | `draft` | — |
| `../etc/passwd` | `other` | `rel: undefined` |
| `/abs/path` | `other` | `rel: undefined` |
| `C:\Windows` | `other` | `rel: undefined` |
| `` （空串） | `other` | `rel: undefined` |

外加 `pathOfTarget` 的四支往返測試（`outline` / `plot` / `scene` / `manuscript`），斷言 `kindOfPath(pathOfTarget(t)).target` 與 `t` 相等。

- [ ] **Step 2: 跑測試確認失敗**

```bash
node --test "tests/unit/workspace/kind.test.js"
```

- [ ] **Step 3: 實現 `kind.ts`**
- [ ] **Step 4: 把 `files/fileOps.ts` 的 `isPlotPath` 改成轉發給 `kindOfPath`**（保留匯出名，呼叫方不動）
- [ ] **Step 5: 跑測試**

```bash
node --test "tests/unit/workspace/kind.test.js"
npm run typecheck
npm test
```

- [ ] **Step 6: Commit**

```bash
git commit -m "refactor(workspace): 抽出路徑種類表

細綱/場景/章節/摘要的路徑判定散在四處，各自認一半。收成 kindOfPath 一張表，純函式零 I/O 絕不拋——它會被前端傳上來的路徑呼叫。"
```

---

### Task 2: 抽出 `workspace/guard.ts`

**Files:**
- Create: `src/core/workspace/guard.ts`
- Create: `tests/unit/workspace/guard.test.js`

把六處各自的檢查合併成一份。**八條守衛，一條都不能少**：

| # | 守衛 | 現在在哪 | 觸發時怎麼辦 |
|---|---|---|---|
| 1 | 路徑規範化（拒絕絕對路徑、`..`、空串） | `fileOps.normalizeRel` | 拋 `WsError('越界')` |
| 2 | 工程根包含檢查 | `fileEditing.resolveInRoot` | 拋 `WsError('越界')` |
| 3 | 固定目錄保護（改名/刪除） | `fileOps.isProtectedPath` | 拋 `WsError('受保護')` |
| 4 | `.trash/` 內容不可操作 | `projectFiles` | 拋 `WsError('回收站')` |
| 5 | 讀取大小上限（2MB） | `fileEditing.MAX_EDITABLE_BYTES` | 拋 `WsError('過大')` |
| 6 | 同名不覆蓋（`mode: 'create'`） | `fileOps` / `projectFiles` 各一份 | 拋 `WsError('已存在')` |
| 7 | 覆蓋前審閱（`reviewReplace` 或確認框） | `creation.confirmOverwrite` | 使用者拒絕 → 返回 `{skipped: true}` |
| 8 | 內容 hash 樂觀鎖 | `fileEditing.saveFromEditor` | 拋 `WsConflictError(diskText, diskHash)` |

**Interfaces:**

```ts
export class WsError extends Error {
  constructor(readonly code: WsErrorCode, message: string) { super(message); }
}
export type WsErrorCode =
  | 'outOfRoot' | 'protected' | 'inTrash' | 'tooLarge'
  | 'exists' | 'notFound' | 'notFile' | 'conflict';

export class WsConflictError extends WsError {
  constructor(readonly diskText: string, readonly diskHash: string) { … }
}

/** 讀之前過一遍：返回絕對路徑。 */
export async function guardRead(project: NovelProject, relPath: string): Promise<string>;

/** 寫之前過一遍。返回絕對路徑與「目標是否已存在」。 */
export async function guardWrite(
  project: NovelProject,
  relPath: string,
  opts: { mode: 'create' | 'overwrite' | 'append'; baseHash?: string }
): Promise<{ abs: string; existed: boolean; current?: string }>;

/** 改名/移動/刪除之前過一遍（多兩條：保護路徑、回收站）。 */
export async function guardMutate(project: NovelProject, relPath: string): Promise<string>;

/**
 * 覆蓋前審閱。有 reviewReplace 的宿主開 diff，沒有的彈確認框。
 * 逐字搬自 features/creation.ts 的 confirmOverwrite——那段文案是產品承諾的一部分。
 */
export async function reviewOverwrite(
  what: string, relPath: string, current: string, next: string
): Promise<boolean>;
```

**注意**：`reviewOverwrite` 裡的確認框文案（`「${what}」已經有內容了，用新版本覆蓋？`、`現有 N 字，新版 M 字`）**逐字搬**，不要改措辭。

- [ ] **Step 1: 寫失敗測試** `tests/unit/workspace/guard.test.js`

八條守衛各至少一條用例。第 7、8 條需要假 Host（`tests/helpers/` 裡已有類似的，照抄）。

- [ ] **Step 2: 跑測試確認失敗**
- [ ] **Step 3: 實現 `guard.ts`**
- [ ] **Step 4: 跑測試 + `npm test`**
- [ ] **Step 5: Commit**

---

### Task 3: `Workspace` 門面 + `plain` / `doc` handler

**Files:**
- Create: `src/core/workspace/index.ts`
- Create: `src/core/workspace/handlers/index.ts`
- Create: `src/core/workspace/handlers/plain.ts`
- Create: `src/core/workspace/handlers/doc.ts`
- Create: `tests/integration/workspace/basic.test.js`

**Interfaces:**

```ts
export interface WsEntry {
  name: string;
  rel: string;
  type: 'file' | 'dir';
  kind: ArtifactKind;
  /** 文字檔案給字數，其餘給位元組數。 */
  words?: number;
  bytes: number;
}

export interface WsFile {
  rel: string;
  text: string;
  hash: string;
  bytes: number;
  kind: ArtifactKind;
  /** 按 offset/limit 截過。**必須說出來**（第 2 條：不靜默截斷）。 */
  truncated?: { from: number; total: number };
}

export type WriteInput = { text: string } | { artifact: Artifact };

export interface WriteOptions {
  mode?: 'create' | 'overwrite' | 'append';
  /** 覆蓋前是否審閱。預設 true。**agent 路徑不允許傳 false。** */
  review?: boolean;
  baseHash?: string;
  /** 覆蓋審閱框裡顯示的名字，如「第 12 章的細綱」。 */
  what?: string;
}

export interface WriteResult {
  rel: string;
  skipped?: boolean;
  message: string;
  /** 這次寫入連帶做了什麼（記了哪個 hash、搬了哪個伴生目錄）。進日誌用。 */
  side?: string[];
}

export interface Handler {
  /** 把結構化產物渲染成該種類的檔案內容。 */
  render?(ctx: HandlerCtx, artifact: Artifact): Promise<string>;
  /** 寫入之後的記賬與伴生動作。 */
  after?(ctx: HandlerCtx, result: WriteResult): Promise<void>;
  /** 改名/移動時要連帶搬走什麼。 */
  companions?(ctx: HandlerCtx, from: string, to: string): Promise<void>;
}

export class Workspace {
  constructor(private readonly project: NovelProject) {}
  list(relDir?: string): Promise<WsEntry[]>;
  read(rel: string, opts?: { offset?: number; limit?: number }): Promise<WsFile>;
  write(rel: string, input: WriteInput, opts?: WriteOptions): Promise<WriteResult>;
  edit(rel: string, edits: { old: string; new: string; all?: boolean }[]): Promise<WriteResult>;
  move(from: string, to: string): Promise<WriteResult>;
  remove(rel: string): Promise<WriteResult>;
}
```

本 Task 只接兩個最簡單的 handler：

- `plain`（`other` / `draft`）：純文字進出，無記賬。
- `doc`（`outline` / `style` / `globalSummary` / `character` / `lore`）：純文字 + frontmatter，無上游指紋。

其餘種類先落到 `plain`，Task 4/5 逐個接上。

**`remove` 必須搬進 `.trash/` 並保留原相對路徑**（第 6 條），逐字複用 `project.trash` 的實現。

- [ ] **Step 1: 寫失敗測試** `tests/integration/workspace/basic.test.js`

用真臨時工程（`tests/helpers/` 裡有現成的 fixture 工具）。至少覆蓋：

| 用例 | 斷言 |
|---|---|
| `write` 新檔案 | 落盤，`mode: 'create'` |
| `write` 同名 + `mode: 'create'` | 拋 `WsError('exists')` |
| `write` 同名 + `mode: 'overwrite'` + 假 Host 同意 | 覆蓋 |
| `write` 同名 + `mode: 'overwrite'` + 假 Host 拒絕 | `{skipped: true}`，磁碟一字未改 |
| `write` + `baseHash` 對不上 | 拋 `WsConflictError` |
| `read` 超 offset/limit | `truncated` 欄位說明截了多少 |
| `remove` | 檔案進 `.trash/` 且保留原相對路徑 |
| `remove` 受保護路徑 | 拋 `WsError('protected')` |
| `edit` old 不唯一 + `all: false` | 拋，不改 |
| `list` 目錄 | 條目帶 `kind` |

- [ ] **Step 2: 跑測試確認失敗**
- [ ] **Step 3: 實現**
- [ ] **Step 4: 跑測試 + `npm test`**
- [ ] **Step 5: 寫 `src/core/workspace/README.md`**（八條守衛表 + 種類表 + 「新程式碼不許繞過 guard 直接 fs.writeFile」）
- [ ] **Step 6: Commit**

---

### Task 4: plot / scene handler，**記賬下沉**

**Files:**
- Create: `src/core/workspace/handlers/plot.ts`
- Create: `src/core/workspace/handlers/scene.ts`
- Modify: `src/core/model/project.ts`（刪 `writePlot` / `deletePlot` / `carryPlotCompanions` / `writeScene` / `deleteScene`）
- Modify: 所有呼叫上述方法的地方
- Create: `tests/integration/workspace/hashChain.test.js`

**這是本期唯一有意的行為變化。** 現在 `upstreamHash` 只在 `features/creation.ts` 的 `acceptPlot` / `acceptSceneList` / `acceptScene` 裡記；下沉之後，**任何一次 `workspace.write` 到 plot/scene 路徑都記**。

`plot` handler：

```ts
// render: Artifact{kind:'plot'} → renderPlotFile，四個小節換新，
//         標題/幕/目標字數/done 沿用磁碟那份（「重寫劇情」不該抹掉作者起的標題）
// after:  upstreamHash = hash(await project.readOutline())
// companions: 改名時搬 scenes/<stem>/ 與 manuscripts/<stem>.md（原 carryPlotCompanions）
```

`scene` handler：

```ts
// render: Artifact{kind:'scene'} → renderSceneFile，
//         標題沿用磁碟那份（標題決定檔名，改寫一張卡不該順手改檔名）
//         status 由 isSceneReady(sections) 推，不靠呼叫方傳
// after:  upstreamHash = plotContentHash(plot)
// companions: 改標題時清掉舊檔名（原 writeScene 的行為）
```

**四條不能碰的既有取捨**（逐條在程式碼註釋裡保留原文）：

1. `plotContentHash` 只雜湊四個小節、不含 frontmatter（第 18b 條）
2. `beatsHashFor` 排除場景的 `status`（同上）
3. 手寫的產物永不標髒——`upstreamHash` 為空就是「不是這條鏈生出來的」（第 18a 條）
4. 刪細綱要連帶搬走場景目錄與中轉站正文，**但不碰 `chapters/` 與摘要**

- [ ] **Step 1: 寫失敗測試** `tests/integration/workspace/hashChain.test.js`

| 用例 | 斷言 |
|---|---|
| `write` 一份細綱 | frontmatter 裡有 `upstreamHash = hash(outline)` |
| **改大綱後再 `write` 細綱** | `upstreamHash` 跟著更新（**這是修的那個缺陷**） |
| **不經採納路徑直接 `write` 細綱文字** | 一樣記 `upstreamHash`（缺陷修復的核心斷言） |
| `write` 場景 | `upstreamHash = plotContentHash(plot)` |
| 把細綱標 `done` | 場景**不**標髒（雜湊不含 status） |
| 細綱改名 | 場景目錄與中轉站正文跟著搬 |
| 細綱改名到已存在的目標 | 不覆蓋，伴生不動 |
| 刪細綱 | 細綱/場景/中轉站進 `.trash`，`chapters/` 與摘要不動 |

- [ ] **Step 2: 跑測試確認失敗**
- [ ] **Step 3: 實現兩個 handler，從 `project.ts` 搬走五個方法**
- [ ] **Step 4: 改所有呼叫點**

```bash
grep -rn "writePlot\|deletePlot\|writeScene\|deleteScene" src/ tests/
```

- [ ] **Step 5: 跑測試 + `npm test`**
- [ ] **Step 6: Commit**

```bash
git commit -m "refactor(workspace): plot/scene handler，記賬下沉

upstreamHash 從前只在「採納」路徑上記，作者在內建編輯器裡改一份細綱，指紋鏈就斷了——那一章從此再也不掛 ⟳。下沉到寫入路徑本身，誰寫都記。"
```

---

### Task 5: manuscript / chapter / summary handler

**Files:**
- Create: `src/core/workspace/handlers/manuscript.ts`
- Create: `src/core/workspace/handlers/chapter.ts`
- Create: `src/core/workspace/handlers/summary.ts`
- Modify: `src/core/model/project.ts`（刪 `appendToManuscript` / `createChapter` / `writeSummary` / `markSummarized` / `ensureDraft` 的寫入部分）
- Modify: `src/core/features/splitChapter.ts`（改走閘道器）
- Modify: 呼叫點

`manuscript` handler：

- `mode: 'append'` 是**預設**（正文是追加不是覆蓋）
- 首次寫入建 frontmatter + `# 第N章… · 正文` 標題行
- 兩次追加之間插一行 `---`（預設拆分候選點，第 23 條）
- `after`：記 `beatsHash = await project.beatsHashFor(plotRelPath)`
- `contentHash` 只雜湊正文字身，不含 frontmatter 與標題行

`chapter` handler：

- 改名/移動時草稿跟隨（原 `fileOps.carryDraft`）
- 刪章節**不刪草稿**（第 10 條，確認框裡說明）
- `after`：`syncManifest`

`summary` handler：`sourceHash` 記的是**成品**的 `contentHash`。

**`splitChapter.ts` 的順序不能改**：先移號再落盤（第 23 條）。反過來的話，落盤後重編號失敗會留下「章節已建但細綱還撞著號」的中間態。

- [ ] **Step 1: 寫失敗測試**（擴充 `hashChain.test.js`，加一個 `tests/integration/workspace/split.test.js`）
- [ ] **Step 2–5: 同上**

---

### Task 6: `acceptArtifact` 六條分支改走閘道器

**Files:**
- Modify: `src/core/features/creation.ts`（`acceptArtifact` 及其六個私有方法、`confirmOverwrite` 刪掉）
- Modify: `tests/integration/features/*`（涉及採納的）

六條分支各變成一次 `workspace.write`：

| 分支 | 改成 |
|---|---|
| `acceptOutline` | `ws.write(outlinePath, {artifact}, {mode:'overwrite', what:'全書大綱'})` |
| `acceptPlotList` | 迴圈 `ws.write(plotPathForNo(no), {artifact}, {mode:'create'})`，**已存在的跳過並在 message 裡說出來** |
| `acceptPlot` | `ws.write(plot.relPath, {artifact}, {mode:'overwrite', what:'第 N 章的細綱'})` |
| `acceptSceneList` | 迴圈 `ws.write(scenePath, …, {mode:'create'})`，已存在的跳過 |
| `acceptScene` | `ws.write(scenePath, {artifact}, {mode:'overwrite', what:'第 N 章 · 場景 M'})` |
| `acceptManuscript` | `ws.write(manuscriptPath, {artifact}, {mode:'append'})` |

**「跳過已存在」的文案必須保留**（`，跳過已存在的第 3、5 章`）——默默少建三章，作者要到寫到那裡才發現。

`confirmOverwrite` 整個刪掉，它的實現已經在 `guard.reviewOverwrite` 裡。

- [ ] **Step 1–5: 同上**。這一步的驗收是既有的採納整合測試**一條都不改**還能全綠。

---

### Task 7: 檔案頁 / 內建編輯器 / fileOps 改走閘道器

**Files:**
- Modify: `src/core/files/fileEditing.ts`（`readFileForEditor` / `saveFromEditor` 改成 `ws.read` / `ws.write`，只留 `EditorFile` 的形狀轉換）
- Modify: `src/core/files/projectFiles.ts`（`renameAny` / `moveInto` / `copyInto` 改走 `ws.move`）
- Modify: `src/core/files/fileOps.ts`（`renameEntry` / `moveEntry` / `deleteEntry` 改走 `ws.move` / `ws.remove`，只留區界限判斷與互動流程）

**注意區界限**：`fileOps` 的三區約束（章節挪不進角色目錄）是**工程頁的產品承諾**，比 `guard` 的工程根約束更嚴。這一層保留在 `fileOps` 裡，先判區再調閘道器。

- [ ] **Step 1–5: 同上**。驗收是 `tests/integration/files/*` 與 `tests/dom/standalone/*` 全綠。

---

### Task 8: `workspace/search.ts`

**Files:**
- Create: `src/core/workspace/search.ts`
- Create: `tests/integration/workspace/search.test.js`

本期唯一的新程式碼。**零模型呼叫的樸素全文掃描**，三期的 `search` 工具吃它。

```ts
export interface SearchOptions {
  /** 限定目錄，預設全工程。 */
  path?: string;
  /** 限定種類，如 ['chapter','summary']。 */
  kinds?: ArtifactKind[];
  /** 正則還是字面量。預設字面量（作者搜的是人名地名，不是正則）。 */
  regex?: boolean;
  /** 每個檔案最多返回幾條命中。預設 5。 */
  perFile?: number;
  /** 總共最多返回幾條。預設 50。 */
  limit?: number;
  /** 命中行前後各帶幾行。預設 1。 */
  context?: number;
}

export interface SearchHit {
  rel: string;
  kind: ArtifactKind;
  no?: number;
  line: number;
  text: string;
  before?: string[];
  after?: string[];
}

export interface SearchResult {
  hits: SearchHit[];
  /** 掃了幾個檔案。 */
  scanned: number;
  /** 因為超上限被丟掉了幾條。**必須報出來**（第 2 條）。 */
  dropped: number;
}
```

**四條實現約束：**

1. **跳過 `.trash/` 與二進位制**（走 `kindOfPath`，`other` 且副檔名在黑名單裡的不讀）。
2. **單檔案讀入有上限**（複用 `MAX_EDITABLE_BYTES`），超了跳過並計入 `dropped`。
3. **`dropped > 0` 時必須在返回值裡說出來**，三期的工具會把它轉述給模型。
4. **預設按章號排序**，不按檔案系統順序——作者問「他前面說過嗎」，時間線順序才有意義。

- [ ] **Step 1: 寫失敗測試**

| 用例 | 斷言 |
|---|---|
| 搜一個只在第 9 章出現的詞 | 命中一條，`no: 9` |
| 跨多章命中 | 按章號升序 |
| 超 `limit` | `dropped > 0` |
| `.trash/` 裡的內容 | 不命中 |
| `kinds: ['summary']` | 只搜摘要 |
| 正則模式 | 生效 |
| 壞正則 | 不拋，降級成字面量並在結果裡說明 |

- [ ] **Step 2–5: 同上**

---

## 本期不做

- **不接 agent**。這一期結束時 `workspace` 還沒有任何 agent 呼叫方。
- **不改 `context/`**。裝配器讀檔案走的是 `project.read*`（查詢），不受影響。
- **不改協議與前端**。
- **不動 `pipelineBatch.ts` 的批次邏輯**（它的落盤會跟著 handler 走，但「只補不改」的策略不變）。

## 給接手 agent 的提示詞

> 你在 novelwarden 倉庫裡執行「一期：workspace 讀寫閘道器」。前置是零期（事件流 provider），確認它已經合入。
>
> 先讀 `AGENTS.md`（尤其第 3、6、7、8、9、10、18 條）、`src/core/README.md` 的「已知約定」全段、以及 `docs/design/specs/2026-08-15-agent-architecture-design.md` 的 L1 一節。然後讀這六個檔案，它們是你要收斂的物件：
> `src/core/model/project.ts`、`src/core/features/creation.ts`、`src/core/files/{fileOps,fileEditing,projectFiles}.ts`、`src/core/features/splitChapter.ts`。
>
> 這一期**只有一個有意的行為變化**：`upstreamHash` / `beatsHash` 的記賬從「只在採納路徑上做」下沉到「誰寫都做」——它修掉一個既有缺陷（作者在內建編輯器裡改細綱，指紋鏈會斷）。除此之外任何一條測試變紅都意味著你改錯了。
>
> 按 `docs/design/plans/2026-08-15-agent-phase1-workspace.md` 的 8 個 Task 逐個做，每個 Task 做完立刻 commit（字首 `refactor(workspace)`，中文正文，**不要加 Co-Authored-By 或 Generated with 標記**）。
>
> 五件最容易做錯的事：
> 1. **守衛八條一條都不能少**（Task 2 的表）。少一條就是給 agent 開了一個後門。
> 2. **`plotContentHash` 只雜湊四個小節，`beatsHashFor` 排除 `status`**。把 frontmatter 或 status 算進去，會讓「排一次劇情」立刻使全部場景過期。
> 3. **手寫的產物永不標髒**：`upstreamHash` 為空 = 不是這條鏈生出來的，不要給它補一個。
> 4. **拆分是先移號再落盤**，順序反了會留下中間態。
> 5. **刪細綱連帶搬場景與中轉站，但不碰 `chapters/` 與摘要**。
>
> `project.ts` 有 1501 行，不要試圖一次讀完再動手——按 Task 順序，每次只看你這一步要搬的那幾個方法。
