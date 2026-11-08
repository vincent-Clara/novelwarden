# 核心層結構整理 Implementation Plan



**Goal:** 把已經長出「一個檔案一件事」邊界的核心模組拆開，去掉跨 feature 複製的解析/I/O 小工具，並按職責收納 `src/core/` 根目錄；行為與對外 import 路徑（殼、前端協議）保持相容或一次性改乾淨。

**Architecture:** 先抽共享純函式（零行為變化），再按域拆大檔案（controller / layers / protocol / characterCard），最後才做目錄搬家。永遠不要同時存在 `foo.ts` 與 `foo/` 目錄。殼繼續從 `core/controller`、`core/protocol` 進口——這兩處改成目錄後靠 `index.ts` 頂住原路徑。

**Tech Stack:** TypeScript（`src/core/`，零 vscode 依賴）+ `node:test` + `npm run typecheck`。不新增依賴。

## Global Constraints

- 行為不變：解析降級、不靜默覆蓋、不靜默截斷、hash 口徑（含 `\r\n` 歸一）、章節不認副檔名，一條都不能改。
- `src/core/` 零 `vscode` import（`tests/contract/corePurity.test.js`）。
- 殼與殼之間不許互相 import；殼不寫業務邏輯。
- 改了 `src/core/**` 必須跑 `npm test`；改了任何 TS 必須過 `npm run typecheck`。
- 每個 Task 結束立刻 commit；字首 `refactor` / `chore` / `docs`；中文正文可以。
- 不要同時留下 `controller.ts` 和 `controller/`（`layers.ts` / `protocol.ts` 同理）。
- `project.ts` 在 Task 2–3 抽走自由函式後，**暫時保留 re-export**，等呼叫方改完再在同一 Task 末尾刪掉 re-export（測試改為從新模組 load）。
- 提示詞正文逐字搬遷，一個標點都不能改（角色卡篇幅上限是產品承諾）。

---

## 檔案結構（目標態）

```
src/core/
├── controller/          # 原 controller.ts
│   ├── index.ts         # ChatController + ViewHost + dispatch
│   ├── serialize.ts
│   ├── chat.ts
│   ├── session.ts
│   ├── project.ts
│   ├── files.ts
│   └── settings.ts
├── protocol/            # 原 protocol.ts
│   ├── index.ts         # 對外唯一入口（殼 / media 仍 from 'core/protocol'）
│   ├── in.ts
│   ├── out.ts
│   └── views.ts
├── context/layers/      # 原 context/layers.ts
│   ├── index.ts         # LAYERS 登錄檔 + 再匯出
│   ├── focus.ts
│   ├── assembly.ts      # Assembly / LayerFn / admit 實現所在處：仍由 builder 構造，這裡只放型別
│   ├── render.ts
│   ├── dialog.ts        # system / ask / attachments / history
│   ├── artifacts.ts     # outlineDoc / planSelf / planPrev / sceneSelf / sceneSiblings
│   └── background.ts    # style / globalSummary / characters / lore / prevTail / chapterFull / chapterSummary / revision
├── files/               # 原根上的檔案操作
│   ├── fileOps.ts
│   ├── projectFiles.ts
│   ├── fileEditing.ts
│   ├── fileTree.ts
│   └── attachments.ts
├── views/               # 讀聚合（不寫盤）
│   ├── projectView.ts
│   ├── pipeline.ts
│   ├── workbench.ts
│   └── cast.ts
├── runtime/             # 日誌 / 庫 / 進度 / 併發
│   ├── logger.ts
│   ├── db.ts
│   ├── errorLog.ts
│   ├── progress.ts
│   └── concurrency.ts
├── model/
│   ├── fs.ts            # 新增：hash / exists / readText / …
│   ├── castParse.ts     # 新增：renderCastEntry / parseCastEntry / castFromText
│   ├── naming.ts        # 從 core 根搬來
│   └── identity.ts      # 從 core 根搬來
└── features/
    ├── parse.ts         # 新增：stripCodeFence / extractJson* / unique*
    ├── characterCard.ts
    ├── characterCardParse.ts
    ├── characterCardPrompt.ts
    ├── summarizePrompt.ts
    ├── lorePrompt.ts
    ├── charactersPrompt.ts
    └── stylePrompt.ts
```

不動：`host.ts`、`config.ts`、`stores.ts`、`actions.ts`、`choices.ts`、`watchPolicy.ts`、`features/creation.ts` 的編排、三個殼的目錄佈局、`media/src/` 的模組切分。

---

## 提交節奏（12 個 commit）

| # | 字首 | 主題 |
|---|---|---|
| 1 | `refactor` | 抽出 `features/parse.ts` |
| 2 | `refactor` | 抽出 `model/fs.ts` |
| 3 | `refactor` | 抽出 `model/castParse.ts` |
| 4 | `refactor` | 拆 `characterCard` 的解析與提示詞 |
| 5 | `refactor` | 其餘 feature 提示詞挪到旁路檔案 |
| 6 | `refactor` | `controller.ts` → `controller/` |
| 7 | `refactor` | `context/layers.ts` → `context/layers/` |
| 8 | `refactor` | `protocol.ts` → `protocol/`（barrel 保路徑） |
| 9 | `refactor` | `naming.ts` / `identity.ts` 遷入 `model/` |
| 10 | `refactor` | 檔案操作遷入 `core/files/` |
| 11 | `refactor` | 讀聚合遷入 `core/views/` |
| 12 | `refactor` | 執行時遷入 `core/runtime/` |

每個 Task 的 README / AGENTS.md 路徑更新跟在**該 Task 自己的 commit** 裡，不要攢到最後。

---

### Task 1: 抽出模型輸出解析小工具

**Files:**
- Create: `src/core/features/parse.ts`
- Create: `tests/unit/features/parse.test.js`
- Modify: `src/core/features/summarize.ts`（刪除 `extractJsonObject` / `stripCodeFence` 實現，改為從 `./parse` import；`toSectionText` 留在 summarize）
- Modify: `src/core/features/artifact.ts`（`extractJsonObject` / `stripCodeFence` 改從 `./parse`）
- Modify: `src/core/features/characters.ts`（刪 `extractJsonArray` / `unique` / `toStringArray`；`stripCodeFence` 改從 `./parse`）
- Modify: `src/core/features/characterCard.ts`（`stripCodeFence` 改從 `./parse`；`unique` / `unique2` / `toStringArray` 改用 parse；解析 JSON 物件改用 `extractJsonObject`）
- Modify: `src/core/features/lore.ts`（刪 `extractJson` / `unique` / `uniqueNumbers` / `stringArray`；`stripCodeFence` 改從 `./parse`）
- Modify: `src/core/features/style.ts`（`stripCodeFence` 改從 `./parse`）
- Modify: `src/core/features/README.md`（檔案表加 `parse.ts`）

**Interfaces:**
- Produces:

```ts
export function stripCodeFence(text: string): string;
export function extractJsonObject(text: string): string | undefined;
export function extractJsonArray(text: string): string | undefined;
export function extractJson(text: string): string | undefined;
export function unique(values: string[]): string[];
export function uniqueNumbers(values: number[]): number[];
export function stringArray(value: unknown): string[];
```

- `extractJsonObject`：第一個 `{` 到最後一個 `}`（摘要正文裡會有 `}`，取 lastIndexOf）。
- `extractJsonArray`：第一個 `[` 到最後一個 `]`。
- `extractJson`：`[` / `{` 裡更靠前的那個，配對用對應的 `]` / `}` 的 lastIndexOf。
- `unique`：trim + 去空 + Set。
- `uniqueNumbers`：Set + 升序。
- `stringArray`：陣列則濾 string；字串則按 `[,，、\n]` 切（lore 口徑，覆蓋 characters 的 `[,，、]`）。

- [ ] **Step 1: 寫失敗測試** `tests/unit/features/parse.test.js`

```js
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

describe('features/parse', () => {
  let p;
  before(() => { p = loadModule('src/core/features/parse.ts'); });

  test('stripCodeFence 剝掉 json fence', () => {
    assert.equal(p.stripCodeFence('```json\n{"a":1}\n```'), '{"a":1}');
  });
  test('stripCodeFence 無 fence 原樣 trim', () => {
    assert.equal(p.stripCodeFence('  hello  '), 'hello');
  });
  test('extractJsonObject 取最外層物件', () => {
    assert.equal(p.extractJsonObject('好的：{"梗概":"x}y"} 以上'), '{"梗概":"x}y"}');
  });
  test('extractJsonArray 取最外層陣列', () => {
    assert.equal(p.extractJsonArray('x [1,2] y'), '[1,2]');
  });
  test('extractJson 物件與陣列取更靠前的', () => {
    assert.equal(p.extractJson('{"a":1}'), '{"a":1}');
    assert.equal(p.extractJson('[1]{"a":1}'), '[1]');
  });
  test('unique / uniqueNumbers', () => {
    assert.deepEqual(p.unique(['a', '', 'a', ' b ']), ['a', 'b']);
    assert.deepEqual(p.uniqueNumbers([3, 1, 3, 2]), [1, 2, 3]);
  });
  test('stringArray 認陣列與頓號串', () => {
    assert.deepEqual(p.stringArray(['a', 1, 'b']), ['a', 'b']);
    assert.deepEqual(p.stringArray('林昭、沈氏'), ['林昭', '沈氏']);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

```
node --test "tests/unit/features/parse.test.js"
```

Expected: FAIL（模組不存在或匯出缺失）

- [ ] **Step 3: 實現 `parse.ts`，呼叫方改為 import，刪掉各檔案裡的副本**

`uniqueSlug` **先別動**（依賴 `exists`，Task 2 再收）。`toSectionText` 留在 `summarize.ts`（摘要小節專用）。`characterCard.ts` 的 `parseCardResponse` 裡內聯的 `{`…`}` 切片改成 `extractJsonObject`。

- [ ] **Step 4: 跑測試**

```
node --test "tests/unit/features/parse.test.js"
npm run typecheck
node --test "tests/unit/features/summarize.test.js" "tests/unit/features/characters.test.js"
```

Expected: PASS

- [ ] **Step 5: Commit**

```
git add src/core/features/parse.ts src/core/features/summarize.ts src/core/features/artifact.ts src/core/features/characters.ts src/core/features/characterCard.ts src/core/features/lore.ts src/core/features/style.ts src/core/features/README.md tests/unit/features/parse.test.js
git commit -m "$(cat <<'EOF'
refactor: 抽出模型輸出解析小工具

stripCodeFence / 摳 JSON / unique 在摘要、角色、設定裡各寫一遍，artifact 還要繞道 import summarize。收到 features/parse.ts，行為口徑與原來逐位元組一致。
EOF
)"
```

---

### Task 2: 抽出 `model/fs.ts`

**Files:**
- Create: `src/core/model/fs.ts`
- Create: `tests/unit/model/fs.test.js`
- Modify: `src/core/model/project.ts`（刪實現；本 Task 結束時**不再** re-export 這些名字）
- Modify: 所有從 `model/project` import `hash` / `exists` / `readText` / `writeText` / `countWords` / `sanitizeFileName` / `slugify` / `pad3` / `isIgnoredDir` 的生產程式碼，改為從 `./fs` 或 `../model/fs`
- Modify: `src/core/features/characters.ts`、`characterCard.ts`、`lore.ts`：本地 `uniqueSlug` / `uniqueLoreSlug` 改為 `uniqueSlug(dirAbs, base)`
- Modify: `src/core/model/README.md`（檔案表加 `fs.ts`）
- Modify: 整合測試裡 `bundle.project.hash(...)` 改為從 fs 模組取（`tests/integration/features/pipelineData.test.js`）

**Interfaces:**
- Produces:

```ts
export function hash(text: string): string;           // sha1，\r\n → \n，截 16 hex
export function countWords(text: string): number;     // 中文按字、英文按詞
export function pad3(n: number): string;
export function sanitizeFileName(name: string): string;
export function slugify(name: string): string;
export async function exists(absPath: string): Promise<boolean>;
export async function readText(absPath: string): Promise<string>;
export async function writeText(absPath: string, text: string): Promise<void>;
export function isIgnoredDir(name: string): boolean;
export async function uniqueSlug(dirAbs: string, base: string): Promise<string>;
```

`uniqueSlug`：`base`、`base-2`、`base-3`… 直到 `${slug}.md` 不存在。`listFilesDeep` / `listMarkdownDeep` / `writeIfAbsent` / `baseName` **留在** `project.ts`（NovelProject 私有掃描）。

已知生產 import（全部改掉）：

| 檔案 | 現從 project 取的工具 |
|---|---|
| `context/layers.ts` | `exists`, `readText` |
| `db.ts` | `exists` |
| `pipeline.ts` | `hash` |
| `fileEditing.ts` | `hash` |
| `projectFiles.ts` | `exists` |
| `fileOps.ts` | `exists`, `readText`, `sanitizeFileName`, `writeText` |
| `workbench.ts` | `hash` |
| `features/creation.ts` | `exists`, `hash`, `readText`, `sanitizeFileName`, `writeText` |
| `features/pipelineBatch.ts` | `hash`, `sanitizeFileName` |
| `features/characters.ts` | `exists`, `readText`, `slugify`, `writeText` |
| `features/characterCard.ts` | `exists`, `readText`, `slugify`, `writeText` |
| `features/lore.ts` | `exists` 等 |
| `features/characterMaintenance.ts` | `readText`, `writeText` |

`NovelProject` 本身繼續從 `./fs` import 自己用。

- [ ] **Step 1: 寫失敗測試** `tests/unit/model/fs.test.js`

覆蓋：`hash` 對 `\r\n` 與 `\n` 相同；`countWords` 中英混合；`sanitizeFileName` 剝非法字元；`slugify` 小寫；`isIgnoredDir` 認 `.trash` 與 `node_modules`；`uniqueSlug` 用臨時目錄（`fs.mkdtemp`）驗證撞名加 `-2`。

- [ ] **Step 2: 跑測試確認失敗**

```
node --test "tests/unit/model/fs.test.js"
```

- [ ] **Step 3: 把 `project.ts` 裡「工具函式」段（約 1001–1105 行）原樣搬到 `fs.ts`，加上 `uniqueSlug`；更新全部生產 import；刪三處 feature 裡的 slug 副本**

實現必須從 `project.ts` **剪下**，不要重寫 hash 演算法。

- [ ] **Step 4: 跑測試**

```
npm run typecheck
node --test "tests/unit/model/fs.test.js" "tests/unit/model/project.test.js"
npm test
```

Expected: PASS。`project.test.js` 此刻仍只測 cast，不受影響。

- [ ] **Step 5: Commit**

```
git commit -m "$(cat <<'EOF'
refactor: 把磁碟小工具從 NovelProject 抽到 model/fs.ts

hash/exists/readText 被 fileEditing、db、fileOps 只為這幾個函式去 import project.ts。uniqueSlug 在角色卡與設定裡還複製了一份。收到 fs.ts 後呼叫方不再繞道資料層上帝類。
EOF
)"
```

---

### Task 3: 抽出 `model/castParse.ts`

**Files:**
- Create: `src/core/model/castParse.ts`
- Modify: `src/core/model/project.ts`（`renderCastEntry` / `parseCastEntry` / `castFromText` / 內部 `parseCast` / `isPlausibleName` / `SENTENCE_MARKERS` 搬走；`readSummary` 等改為從 `./castParse` import）
- Modify: `src/core/features/summarize.ts`（改為從 `../model/castParse` import `castFromText` / `parseCastEntry` / `renderCastEntry`）
- Modify: `tests/unit/model/project.test.js` → 改名為或改為 load `src/core/model/castParse.ts`（describe 標題跟著改）
- Modify: `src/core/model/README.md`（檔案表加 `castParse.ts`；「見 model/project.ts 的 castFromText」改指向新檔案）
- Modify: `src/core/features/README.md`（摘要降級第 3 條裡的路徑）

**Interfaces:**
- Produces: `renderCastEntry` / `parseCastEntry` / `castFromText` 簽名與現實現完全相同。
- `parseCast`（frontmatter 欄位 → `SummaryCast[] | undefined`）若僅 `project.ts` 的 `readSummary` 使用，可留在 `castParse.ts` 並 export，供 `project.ts` 呼叫。

- [ ] **Step 1: 把現有 `tests/unit/model/project.test.js` 的 load 路徑改成 `castParse.ts`，先跑一遍確認失敗**

```
node --test "tests/unit/model/project.test.js"
```

Expected: FAIL（還沒搬）

- [ ] **Step 2: 剪下實現到 `castParse.ts`，`project.ts` 從那裡 import 私有 `parseCast`**

`castFromText` 仍依賴 `../naming` 的 `sanitizeAliases`。

- [ ] **Step 3: 跑測試**

```
npm run typecheck
node --test "tests/unit/model/project.test.js"
node --test --test-name-pattern="cast" "tests/integration/features/**/*.test.js"
```

- [ ] **Step 4: Commit**

```
git commit -m "$(cat <<'EOF'
refactor: 出場人物解析從 NovelProject 抽到 castParse.ts

frontmatter 括號形式與小節文字反解是純函式，不該跟章節掃描焊在一個類裡。摘要讀寫仍走 NovelProject，解析口徑只有這一份。
EOF
)"
```

---

### Task 4: 拆 characterCard 的解析與提示詞

**Files:**
- Create: `src/core/features/characterCardParse.ts`（`parseCardResponse` + `ParsedCard` 型別）
- Create: `src/core/features/characterCardPrompt.ts`（`UPDATE_SYSTEM` 逐字搬遷）
- Modify: `src/core/features/characterCard.ts`（import 上述兩處；檔案應降到約 900 行以內的編排）
- Modify: `src/core/features/README.md`
- Test: 現有 `tests/unit/features/characters.test.js` 與 `tests/integration/features/characterCard.test.js`；若 unit 測的是 `parseCardResponse`，改為從 `characterCard.ts` 再匯出或直接 load parse 模組（**保持 `characterCard.ts` re-export `parseCardResponse`**，避免整合測試入口變了）

**Interfaces:**
- Produces: `export function parseCardResponse(raw: string): ParsedCard | undefined`
- Produces: `export const UPDATE_SYSTEM: string`（全文與現檔案 1112–1145 行逐字相同）
- `characterCard.ts` 繼續 `export { parseCardResponse } from './characterCardParse'`

- [ ] **Step 1: 先加一條 unit 測試 load `characterCardParse.ts`**，用現有角色卡 JSON 夾具（可從 `tests/integration/features/characterCard.test.js` 抄一條最小 JSON），斷言性格節有內容、泛稱 alias 被濾掉。跑、確認失敗。

- [ ] **Step 2: 剪下 `parseCardResponse` 與 `UPDATE_SYSTEM`，編排檔案改為 import**

- [ ] **Step 3:**

```
npm run typecheck
node --test "tests/unit/features/characters.test.js"
node --test "tests/integration/features/characterCard.test.js"
```

- [ ] **Step 4: Commit**

```
git commit -m "$(cat <<'EOF'
refactor: 角色卡更新的解析與提示詞從編排裡拆出

characterCard.ts 同時堆著單卡/批次/切批/審閱/JSON 解析/系統提示。解析與控篇幅提示詞是另一條變更軸，拆到旁路檔案後編排只負責呼叫模型與寫盤。
EOF
)"
```

---

### Task 5: 其餘 feature 提示詞旁路

**Files:**
- Create: `src/core/features/summarizePrompt.ts`（`SUMMARY_SYSTEM` / `STAGE_SYSTEM` / `GLOBAL_SYSTEM`）
- Create: `src/core/features/lorePrompt.ts`（`LORE_EXTRACT_SYSTEM` / `LORE_SYNTHESIS_SYSTEM`）
- Create: `src/core/features/charactersPrompt.ts`（`CHARACTER_SYSTEM`）
- Create: `src/core/features/stylePrompt.ts`（`STYLE_SYSTEM`）
- Modify: 對應四個編排檔案改為 import
- Modify: `src/core/features/README.md` 檔案表

提示詞字串**逐字剪下**，不要重新排版。

- [ ] **Step 1: 剪下四個檔案的 `*_SYSTEM` 常量到旁路模組並改 import**（無新行為，現有 unit/integration 即迴歸網）

- [ ] **Step 2:**

```
npm run typecheck
node --test "tests/unit/features/summarize.test.js" "tests/unit/features/characters.test.js"
node --test "tests/integration/features/lore.test.js" "tests/integration/features/characterCard.test.js"
```

- [ ] **Step 3: Commit**

```
git commit -m "$(cat <<'EOF'
refactor: 把摘要/設定/提取/文風的系統提示詞挪到旁路檔案

編排檔案裡大段模板字串讓呼叫模型的控制流讀不下去。提示詞與流水線分開改，避免改一句「80 字以內」時還要在 800 行裡找常量。
EOF
)"
```

---

### Task 6: `controller.ts` → `controller/`

**Files:**
- Delete: `src/core/controller.ts`（與目錄不能並存）
- Create: `src/core/controller/index.ts`（`ChatController`、`ViewHost`、`describeProvider`、`dispatch` 的 switch、生命週期）
- Create: `src/core/controller/serialize.ts`（`serializeSession` / `serializeTurn` / `serializeAttachment` / `serializeDigest` / `serializeItem` / `factsOf` / `targetOf` / `describeProvider`）
- Create: `src/core/controller/session.ts`（`persist` / `newSession` / `openSession` / `deleteSession` / `renameSession`）
- Create: `src/core/controller/chat.ts`（`send` / `retry` / `runTurn` / `accept` / `acceptArtifact` / `setTarget` / `selectChapter` / `applyAction` / `describeArtifactOf` / `targetHasContent` / `restoreTarget` / `focusWithTarget` / `pushPipeline` / `outlineNextStep` / `describeCurrentTarget`）
- Create: `src/core/controller/project.ts`（`projectAction` / `characterAction` / `pickSection`）
- Create: `src/core/controller/files.ts`（`fileAction` / `openDraft` / `pushDirListings`）
- Create: `src/core/controller/settings.ts`（`saveSettings` / `selectModel` / `testConnection` / `pushSettings`）
- Modify: `src/core/README.md`、`src/README.md`、`AGENTS.md`、`src/core/features/README.md` 裡寫 `controller.ts` 的路徑改為 `controller/`
- 殼 import **不用改**：`from '../../core/controller'` 解析到 `controller/index.ts`

**Interfaces:**
- 對外仍是：

```ts
export interface ViewHost {
  post(message: OutMessage): void;
  reveal(): void;
}
export class ChatController {
  constructor(project: NovelProject);
  attach(host: ViewHost): void;
  detach(host: ViewHost): void;
  dispose(): void;
  handle(msg: InMessage): Promise<void>;
  resendFullState(): Promise<void>;
  pushState(): Promise<void>;
  addSelectionFromCommand(): Promise<boolean>;
  focusWithTarget(order: number): Promise<void>;
  showTab(tab: Tab): Promise<void>;
  newSessionFromCommand(): Promise<void>;
}
export function describeProvider(config?: NovelConfig): string;
```

- 同目錄模組通過把原 `private` 欄位改成**不寫 private**（或 `readonly` 公開給同包）共享狀態。檔案頭註釋寫清：「這些欄位只給 `controller/` 下的模組用，殼不要讀。」不要新造第二個 controller 類。
- `dispatch` 的 switch **留在 index.ts**，case 裡調拆出去的函式，例如 `await send(this, msg.payload)`。
- 拆出的函式簽名形態：`export async function send(c: ChatController, payload: SendPayload): Promise<void>`

- [ ] **Step 1: 先把 `serialize.ts` 和 `describeProvider` 搬出去**，`controller.ts` 改為 import。typecheck。這一步若更穩，可以先在仍叫 `controller.ts` 的檔案裡 import 旁路模組——但最終 commit 必須是目錄形態，所以本 Task 一次做到 `controller/index.ts`。

- [ ] **Step 2: 建 `controller/`，按上表剪下方法，刪除根上的 `controller.ts`**

注意 `describeProvider` 被殼或測試引用的話從 `controller/index.ts` re-export。

- [ ] **Step 3:**

```
npm run typecheck
npm test
```

Expected: PASS。契約測試掃的是 `src/core/**/*.ts`，新目錄自動覆蓋。

- [ ] **Step 4: Commit**

```
git commit -m "$(cat <<'EOF'
refactor: 按訊息域拆 ChatController

一個 class 同時處理會話、採納、工程頁、檔案頁和設定，dispatch 還能讀，方法區已經讀不動。拆成 controller/ 下按域分的模組，對外仍是同一個 ChatController，雙開同步的那份狀態不拆開。
EOF
)"
```

---

### Task 7: `context/layers.ts` → `context/layers/`

**Files:**
- Delete: `src/core/context/layers.ts`
- Create: `src/core/context/layers/index.ts`（`export const LAYERS: Record<LayerId, LayerFn>` 組裝；再匯出 `resolveFocus` / `Focus` / `Assembly` / `LayerFn` / `tailByChars` / `isPlaceholder`）
- Create: `src/core/context/layers/focus.ts`（`Focus`、`resolveFocus`）
- Create: `src/core/context/layers/assembly.ts`（`Assembly`、`LayerFn` 型別；admit/accept/reject 的實現**仍在 builder.ts**——這裡只放型別。若 admit 實現目前寫在 layers.ts 裡作為閉包，保持「由 builder 注入」的現狀，不要把預算演算法搬進層檔案。）
- Create: `src/core/context/layers/render.ts`（`renderPlan` / `renderScene` / `renderSceneBrief` / `renderCharacter` / `resolveAttachment` / `chapterLabel` / `focusText` / `selectCharacters` / `matchesKeywords` / `tailByChars` / `isPlaceholder` / `ATTACHMENT_NOTE`）
- Create: `src/core/context/layers/dialog.ts`（`system` `ask` `attachments` `history`）
- Create: `src/core/context/layers/artifacts.ts`（產物五層）
- Create: `src/core/context/layers/background.ts`（背景與正文層）
- Modify: `src/core/context/builder.ts` 的 import 仍是 `from './layers'`（目錄 index）
- Modify: `src/core/context/README.md`

**Interfaces:**
- `builder.ts` 繼續：`import { LAYERS, resolveFocus, type Assembly } from './layers'`
- 每層檔案 export 具名 `LayerFn`，例如 `export const system: LayerFn = async (a, spec) => { ... }`
- `index.ts`：

```ts
export const LAYERS: Record<LayerId, LayerFn> = {
  system, ask, attachments, history,
  outlineDoc, planSelf, planPrev, sceneSelf, sceneSiblings,
  style, globalSummary, characters, lore, prevTail, chapterFull, chapterSummary, revision,
};
```

層函式內部邏輯剪下，不要改 `admit` / `reject` 的 note 文案（測試會盯明細）。

- [ ] **Step 1: 建目錄、剪下、刪 `layers.ts`**

- [ ] **Step 2:**

```
npm run typecheck
node --test "tests/integration/context/builder.test.js" "tests/unit/context/**/*.test.js"
```

- [ ] **Step 3: Commit**

```
git commit -m "$(cat <<'EOF'
refactor: 按層把裝配實現拆進 context/layers/

layers.ts 是一份層名到取數函式的目錄，八百行擠在一個 Record 裡改某一層要先翻配方。拆開後配方表仍是唯一策略入口，builder 的 import 路徑不變。
EOF
)"
```

---

### Task 8: `protocol.ts` → `protocol/`（barrel 保路徑）

**Files:**
- Delete: `src/core/protocol.ts`
- Create: `src/core/protocol/in.ts`（`Tab`、`SendPayload`、`SerializedAttachment`、`EditorPane`、`InMessage`、`ProjectAction`、`CharacterAction`、`FileAction`、`SettingsPayload`）
- Create: `src/core/protocol/out.ts`（`OutMessage`、`SerializedProvider`、`SerializedModel`、`FileOpResult`、`EditorFileView`）
- Create: `src/core/protocol/views.ts`（`ViewState`、`ProjectTree` / `ProjectNode*`、`ChapterPipelineView`、`WorkbenchView`、`Cast*`、`FailureView`、`SerializedSession` / `SerializedTurn` / `SerializedArtifact` / `SerializedDigest`、`SessionListItem`、`NextStepView` 等介面快照）
- Create: `src/core/protocol/index.ts`（re-export 上述全部 + 現有的 `export type { LogEntry, LogLevel } from '../logger'` 等轉出口 + `makeNonce`）
- `media/src/protocol.ts`、殼、`host.ts` 的 `from '.../core/protocol'` **不用改**
- Modify: `src/core/README.md`、`AGENTS.md` 提到 `protocol.ts` 的地方改為 `protocol/`（說明對外入口仍是 `core/protocol`）

**Interfaces:**
- `index.ts` 必須把現在 `protocol.ts` 匯出的每一個型別/函式再匯出。用 `export type { ... }` / `export { makeNonce }` 顯式列出，不要 `export *` 漏掉 `makeNonce`。
- 改完立刻 `npm run typecheck`（含 `media/tsconfig.json`）——前端對不上會在這裡紅。

- [ ] **Step 1: 按訊息方向切開，`index.ts` 顯式 re-export，刪除 `protocol.ts`**

- [ ] **Step 2:**

```
npm run typecheck
npm test
```

- [ ] **Step 3: Commit**

```
git commit -m "$(cat <<'EOF'
refactor: 協議型別按方向拆進 protocol/，對外入口不變

八百行協議檔案裡 InMessage、OutMessage 和工程頁快照纏在一起。拆開後 media 與殼仍從 core/protocol 進口，typecheck 繼續當契約網。
EOF
)"
```

---

### Task 9: `naming.ts` / `identity.ts` 遷入 `model/`

**Files:**
- Move: `src/core/naming.ts` → `src/core/model/naming.ts`
- Move: `src/core/identity.ts` → `src/core/model/identity.ts`
- Modify: 所有 import（`cast.ts`、`castParse.ts`、`characterCard.ts`、`characterMaintenance.ts`、`project.ts` 若仍引用 naming、測試）
- Modify: `src/core/README.md`、`src/core/model/README.md`、`AGENTS.md`（第 14 條路徑）

理由：二者與 `chapterFile.ts` 同類——純函式、零 I/O、領域規則。現在卻放在 core 根上。

- [ ] **Step 1: git mv + 改 import + 改文件**

- [ ] **Step 2:**

```
npm run typecheck
node --test "tests/integration/features/cast.test.js" "tests/unit/model/**/*.test.js"
```

- [ ] **Step 3: Commit**

```
git commit -m "$(cat <<'EOF'
refactor: 稱呼學與同一人聚類歸入 model/

naming/identity 與 chapterFile 一樣是純領域規則，放在 core 根上跟日誌、進度混在一起。搬進 model/ 後資料層的「誰是誰」規則就在一處。
EOF
)"
```

---

### Task 10: 檔案操作遷入 `core/files/`

**Files:**
- Move: `fileOps.ts` / `projectFiles.ts` / `fileEditing.ts` / `fileTree.ts` / `attachments.ts` → `src/core/files/`
- Modify: 全部 import（controller、殼、protocol 若 type-reexport `DirListing` 從 fileTree、standalone fileHost 等）
- Modify: `src/core/README.md`、`AGENTS.md` 約束 7 的路徑、`src/shells/README.md` 如有引用
- `protocol/index.ts` 裡 `export type { DirListing, FsEntry } from '../fileTree'` 改為 `from '../files/fileTree'`

**不要**在舊路徑留 stub re-export——一次改乾淨。

- [ ] **Step 1: git mv 五個檔案，ripgrep `from '\\./fileOps'|from '\\./fileTree'|from '\\./fileEditing'|from '\\./projectFiles'|from '\\./attachments'` 以及 `core/fileOps` 等殼路徑，全部更新**

- [ ] **Step 2:**

```
npm run typecheck
npm test
```

- [ ] **Step 3: Commit**

```
git commit -m "$(cat <<'EOF'
refactor: 工程檔案操作收到 core/files/

fileOps、projectFiles、fileEditing、fileTree、attachments 都是「路徑守衛 + 讀寫」，卻和日誌、流水線快照平鋪在 core 根上。收到 files/ 後三區鎖定與根範圍操作仍然分檔案，只是終於能當一組找。
EOF
)"
```

---

### Task 11: 讀聚合遷入 `core/views/`

**Files:**
- Move: `projectView.ts` / `pipeline.ts`（**I/O 那份**，不是 `model/pipeline.ts`） / `workbench.ts` / `cast.ts` → `src/core/views/`
- Modify: 全部 import（controller、features/characterCard 的 `buildCastIndex`、creation 的 `planContentHash` 若在 pipeline.ts）
- Modify: README / AGENTS.md。特別寫清：`model/pipeline.ts` 仍是純領域模型，**不要**搬進 views。

- [ ] **Step 1: git mv + 改 import。 ripgrep 時把 `core/model/pipeline` 與 `core/pipeline` 分開看，只動後者。**

- [ ] **Step 2:**

```
npm run typecheck
npm test
```

- [ ] **Step 3: Commit**

```
git commit -m "$(cat <<'EOF'
refactor: 工程頁/流水線/工作區/出場索引收到 core/views/

這四個模組都是「從磁碟聚合成介面快照」，一個字都不寫盤。與 model/pipeline.ts 的純函式狀態機分開目錄，避免再出現改徽章卻翻到取數檔案的情況。
EOF
)"
```

---

### Task 12: 執行時遷入 `core/runtime/`

**Files:**
- Move: `logger.ts` / `db.ts` / `errorLog.ts` / `progress.ts` / `concurrency.ts` → `src/core/runtime/`
- Modify: **幾乎所有 core 檔案**以及殼裡 `scoped` / `runTask` 的 import
- Modify: `protocol/index.ts` 的 `export type { LogEntry, LogLevel } from '../logger'` → `from '../runtime/logger'`（TaskSnapshot 同理）
- Modify: `src/core/README.md`、`AGENTS.md` 約束 11/16/17 的路徑
- 注意 `logger.ts` 與 `db.ts` 的反向 import 約定：`installLogPersistence` 仍只由 db 調 logger 的 sink，logger **繼續零依賴 db**（搬目錄不改這個方向）

- [ ] **Step 1: git mv + 全倉庫改 import。優先用 ripgrep 列清單再改，漏一處 typecheck 會紅。**

- [ ] **Step 2:**

```
npm run typecheck
npm test
```

Expected: 全綠。這是最後一次搬家，路徑引用應全部落在目標態。

- [ ] **Step 3: Commit**

```
git commit -m "$(cat <<'EOF'
refactor: 日誌/庫/進度/併發收到 core/runtime/

這些模組是宿主無關的執行時設施，不是小說領域模型。從 core 根挪走之後根上只剩 host/config/actions 這類真正的入口膠水，失敗記錄與日誌仍不進 Markdown。
EOF
)"
```

---

## 每個 Task 的驗證口令

```
npm run typecheck
```

改了 `src/core/**` 再加：

```
npm test
```

單測加速（Task 1–5 夠用）：

```
node --test --test-name-pattern="關鍵字" "tests/unit/**/*.test.js"
```

glob 必須帶引號。

---

## 明確不做

- 不拆 `NovelProject` 類本身（路徑推導 + 各區 read/write 仍是一個門面；只抽走了與例項無關的自由函式）。
- 不合併 `fileOps` 與 `projectFiles`（三區 vs 根範圍是產品承諾）。
- 不合併兩份 `pipeline`（純函式 vs 讀盤聚合）。
- 不改 `media/src/view/` 的模組切分。
- 不把 feature 提示詞搬進 `context/prompts.ts`（那份是 Stage × Capability；後臺任務提示詞跟編排走）。
- 不在舊路徑留永久 stub（除 Task 6–8 用 `index.ts` 頂住**本來就是目錄入口**的 `core/controller` 與 `core/protocol`）。

---

## Spec coverage

| 上次審查項 | Task |
|---|---|
| ChatController 1605 行 | 6 |
| NovelProject 自由函式 / cast 解析 | 2, 3 |
| characterCard 提示詞+解析 | 4 |
| 跨 feature 的 JSON/unique/slug | 1, 2 |
| layers.ts 847 行 | 7 |
| protocol.ts 832 行 | 8 |
| core 根目錄過平 | 9–12 |
| naming/identity 與 chapterFile 分層不一致 | 9 |
| model/README 仍寫依賴 vscode / `ui/` | 3 或 9 改 README 時刪掉那句，改為「只依賴 Node API 與 core 內更底層模組」 |
| 其餘 feature 大段提示詞 | 5 |
