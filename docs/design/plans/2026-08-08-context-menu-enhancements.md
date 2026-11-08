# 右鍵功能完善實施計劃



**Goal:** 給獨立版補齊三組右鍵/鍵盤能力：編輯器標籤頁與正文區選單、檔案頁剪下/複製/貼上/重新命名（含 Ctrl+X/C/V）、工程頁批次更新/重建全部角色卡。

**Architecture:** 新增 core 模組 `projectFiles.ts` 承擔工程根範圍的類檔案操作（與三區鎖定的 `fileOps.ts` 並列）；`characterCard.ts` 抽出可複用的單卡執行體並新增批次編排；前端三個 media 指令碼複用 view.js 的全域右鍵選單引擎（`__nfContextMenu`），編輯器標籤搬家走 `nf-files-moved` 自定義事件。

**Tech Stack:** TypeScript（core，零 vscode 依賴）+ 原生 JS（media/）+ esbuild 打包的離線冒煙測試（scripts/）+ jsdom（smoke-view.js）。

**Spec:** `docs/design/specs/2026-08-08-context-menu-enhancements-design.md`

**通用約定（每個任務都適用）：**
- shell 為 PowerShell，`&&` 用 `;` 代替；所有命令在倉庫根目錄執行。
- 改了 TS 必須過 `npm run typecheck`；改了 `src/core/**` 必須跑 `npm run smoke`。
- commit 字首 `feat/refactor/chore/docs`，中文正文可以。
- 本計劃的「測試」即各 `scripts/smoke-*.js` 斷言；沒有測試框架，TDD 流程 = 先寫斷言 → 跑、確認失敗 → 實現 → 跑、確認通過 → commit。

---

## 檔案結構

| 檔案 | 動作 | 職責 |
| --- | --- | --- |
| `src/core/protocol.ts` | 改 | FileAction 加 `paste`/`renameAny`，CharacterAction 加兩個批次動作，新 OutMessage `filesOpDone` |
| `src/core/fileOps.ts` | 改 | 匯出 `validateName`/`carryDraft`，重新命名拆出「根範圍放寬」變體，新增 `isProtectedPath` |
| `src/core/projectFiles.ts` | 新建 | 工程根範圍的 rename/move/copy，逐項結果 |
| `scripts/smoke-projectFiles.js` | 新建 | 上述操作的離線驗證 |
| `src/core/features/characterCard.ts` | 改 | 抽出單卡執行體，新增批次計劃與編排 |
| `scripts/smoke-characterCard.js` | 修改 | 批次計劃與批次流程斷言 |
| `src/core/controller.ts` | 改 | paste/renameAny/updateAllCards/rebuildAllCards 接線，派發 `filesOpDone` |
| `media/view.js` | 改 | 「角色」分組右鍵增加兩個批次項 |
| `media/explorer.js` | 改 | 剪貼簿、四個選單項、Ctrl+X/C/V、與編輯器聯動 |
| `media/editor.js` | 改 | 標籤選單、正文區選單、標籤搬家 |
| `media/standalone.css` | 改 | 剪下標記與行焦點樣式 |
| `scripts/smoke-view.js` | 改 | 以上三處的前端斷言 |
| `AGENTS.md` | 改 | 約束 #7 修訂、模組地圖 |
| `package.json` | 改 | smoke 鏈加 smoke-projectFiles.js |

---

### Task 1: 協議擴充套件（protocol.ts）

**Files:**
- Modify: `src/core/protocol.ts`

- [ ] **Step 1: 擴充套件訊息型別**

在 `src/core/protocol.ts` 中做四處修改：

1. `fileAction` 入訊息（約第 100 行）改為：

```ts
  /**
   * 類檔案操作。工程頁用 `relPath` 單數（rename/move/delete，鎖在三個區內）；
   * 檔案頁用 `renameAny`（根範圍重新命名）與 `paste`（`relPaths` 源列表 +
   * `op` 區分移動/複製 + `targetDir` 落點）。
   */
  | {
      type: 'fileAction';
      action: FileAction;
      relPath?: string;
      relPaths?: string[];
      op?: 'cut' | 'copy';
      targetDir?: string;
    }
```

2. `FileAction`（約第 156 行）改為：

```ts
/**
 * 類檔案操作。作用物件由 `relPath` / `relPaths` 給出，可以是檔案也可以是目錄。
 * `move` 另需 `targetDir`（工作區相對路徑，空串表示所屬區的根目錄）。
 *
 * - `rename` / `move` / `delete`：工程頁用，鎖在章節/角色/設定三個區內（fileOps.ts）。
 * - `renameAny` / `paste`：檔案頁用，範圍放寬到整個工程根（projectFiles.ts）。
 */
export type FileAction = 'rename' | 'renameAny' | 'move' | 'delete' | 'paste';
```

3. `CharacterAction`（約第 150 行）追加兩個批次動作並補註釋：

```ts
/**
 * 角色相關的動作。與 `projectAction` 分開是因為它們的作用物件是**角色**，
 * 而不是一個檔案或一個章節。
 *
 * - `updateCard` / `rebuildCard`：更新已有角色卡。前者增量、後者全量，`relPath` 指向那張卡。
 * - `createCard`：給摘要裡出現但還沒建卡的人物建卡。`name` 是摘要裡的名字。
 * - `updateAllCards` / `rebuildAllCards`：批次更新全部角色卡（增量 / 全量），
 *   不需要 name/relPath。
 */
export type CharacterAction =
  | 'updateCard'
  | 'rebuildCard'
  | 'createCard'
  | 'updateAllCards'
  | 'rebuildAllCards';
```

4. `OutMessage` 追加（放在 `dirListings` 之後），並在檔案內定義結果形狀：

```ts
  /**
   * 檔案頁類檔案操作（renameAny / paste）的逐項結果。
   * 前端據此 remap 開著的編輯器標籤，失敗項各自提示原因。
   */
  | { type: 'filesOpDone'; op: 'rename' | 'move' | 'copy'; results: FileOpResult[] }
```

```ts
/** 檔案操作的單項結果。失敗時保持原路徑並給出原因（toast 也會同時報）。 */
export interface FileOpResult {
  from: string;
  /** 操作成功後的新路徑；失敗時沒有。 */
  to?: string;
  ok: boolean;
  error?: string;
}
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck`
Expected: PASS（controller 還沒引用新變體，新增型別不會破壞任何現有程式碼）

- [ ] **Step 3: Commit**

```powershell
git add src/core/protocol.ts
git commit -m "feat: 協議增加檔案頁貼上/根範圍重新命名與批次角色卡動作"
```

---

### Task 2: fileOps.ts 匯出與根範圍重新命名

**Files:**
- Modify: `src/core/fileOps.ts`

現有 `renameEntry` 鎖在三個區內（`resolveTarget` 強制 section 歸屬）。檔案頁需要「工程根範圍」的重新命名：不限區，但保護固定目錄。拆出一個帶開關的內部實現，兩個入口各自呼叫；區內的行為必須**一字不差**地保持（smoke-fileops.js 是守門員）。

- [ ] **Step 1: 匯出兩個內部函式**

projectFiles.ts 與測試都要用到它們：

```ts
// 原 `function validateName(...)` 改為：
export function validateName(value: string): string | undefined {
```

```ts
// 原 `async function carryDraft(...)` 改為：
export async function carryDraft(
```

- [ ] **Step 2: 新增 isProtectedPath**

放在 `normalizeRel` 之後：

```ts
/**
 * 工程的固定目錄：改名/搬走會讓工程結構散架（章節索引、草稿映象、
 * 後設資料與會話）。檔案頁的根範圍操作對這些路徑一律拒絕。
 */
export function isProtectedPath(project: NovelProject, relPath: string): boolean {
  const rel = normalizeRel(relPath);
  if (!rel) {
    return true;
  }
  const fixed = [
    project.relPath(project.chaptersDir),
    project.relPath(project.draftsDir),
    '.novelforge',
    '.novelforge/characters',
    '.novelforge/lore',
    '.novelforge/.trash',
  ];
  return fixed.includes(rel);
}
```

- [ ] **Step 3: 拆重新命名實現**

把現有 `renameEntry` 的函式體整體挪進新的 `renameEntryImpl`，`renameEntry` 變薄殼，另加根範圍入口。唯一的語義差別在解析目標這一步：

```ts
export async function renameEntry(project: NovelProject, relPath: string): Promise<string | undefined> {
  return renameEntryImpl(project, relPath, true);
}

/**
 * 工程根範圍的重新命名（檔案頁用）。不再要求路徑在三個管理區內，
 * 但固定目錄受 isProtectedPath 保護；章節的序號字首/H1 同步與草稿跟隨
 * 在路徑確實位於章節區時照常生效。
 */
export async function renameEntryInRoot(project: NovelProject, relPath: string): Promise<string | undefined> {
  return renameEntryImpl(project, relPath, false);
}

async function renameEntryImpl(
  project: NovelProject,
  relPath: string,
  requireSection: boolean
): Promise<string | undefined> {
  const target = requireSection
    ? await resolveTarget(project, relPath)
    : await resolveTargetInRoot(project, relPath);
  if (!target) {
    return undefined;
  }
  // ……原函式體原樣保留，僅把兩處 `info.section` 改為 `target.info?.section`：
  //   if (!isDir && target.info?.section === 'chapters' && isMarkdownPath(rel)) { …H1 同步… }
  //   if (target.info?.section === 'chapters') { await carryDraft(…); await project.syncManifest(); }
}
```

- [ ] **Step 4: 新增 resolveTargetInRoot**

放在 `resolveTarget` 旁邊，結構對齊：

```ts
/** 根範圍解析：路徑合法、不是固定目錄、存在即可（不要求在三區內）。 */
async function resolveTargetInRoot(project: NovelProject, relPath: string): Promise<ResolvedTarget | undefined> {
  const rel = normalizeRel(relPath);
  if (!rel) {
    log.warn(`操作被拒：路徑不合法`, `原始輸入 ${JSON.stringify(relPath)}`);
    getHost().toast('路徑不合法。', 'error');
    return undefined;
  }
  if (isProtectedPath(project, rel)) {
    log.warn(`操作被拒：${rel} 是工程的固定目錄`);
    getHost().toast(`「${rel}」是工程的固定目錄，不能改名或搬走。`, 'error');
    return undefined;
  }
  const abs = project.pathOf(rel);
  let isDir: boolean;
  try {
    isDir = (await fs.stat(abs)).isDirectory();
  } catch {
    log.warn(`操作被拒：找不到 ${rel}（可能剛被改名或刪除）`);
    getHost().toast(`找不到：${rel}`, 'error');
    return undefined;
  }
  // 區外路徑 info 為 undefined：下游用 `target.info?.section` 守衛。
  const info = sectionOf(project, rel);
  return { abs, rel, info: info as SectionInfo, isDir };
}
```

注意 `ResolvedTarget.info` 型別是 `SectionInfo`；區外時為 `undefined`，`as SectionInfo` 之後所有讀取處都經 `?.` 守衛（第 3 步已列明兩處）。

- [ ] **Step 5: 迴歸驗證**

Run: `npm run typecheck; node scripts/smoke-fileops.js`
Expected: typecheck PASS；smoke-fileops 全部通過（區內行為零變化）。

- [ ] **Step 6: Commit**

```powershell
git add src/core/fileOps.ts
git commit -m "refactor: fileOps 拆出根範圍重新命名變體並匯出共用守衛"
```

---

### Task 3: smoke-projectFiles.js（先寫失敗測試）

**Files:**
- Create: `scripts/smoke-projectFiles.js`
- Modify: `package.json`（smoke 鏈）

- [ ] **Step 1: 寫測試指令碼**

結構與 `smoke-fileops.js` 同款（loadBundle + 假宿主 + 臨時工程），完整內容：

```js
/**
 * 工程根範圍類檔案操作（檔案頁）的離線驗證：重新命名/移動/複製、
 * 固定目錄保護、同名拒絕、垃圾箱豁免、章節聯動。
 *
 * 用法：node scripts/smoke-projectFiles.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'novelforge-projfiles-'));

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function loadBundle(entries) {
  const source = Object.entries(entries)
    .map(([name, relPath]) => `export * as ${name} from '${relPath.replace(/\\/g, '/')}';`)
    .join('\n');
  const result = esbuild.buildSync({
    stdin: { contents: source, resolveDir: ROOT, sourcefile: 'bundle.ts', loader: 'ts' },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    external: ['vscode'],
  });
  const m = new Module('bundle.ts', null);
  m._compile(result.outputFiles[0].text, path.join(ROOT, 'bundle.ts'));
  return m.exports;
}

const bundle = loadBundle({
  host: './src/core/host.ts',
  project: './src/core/model/project.ts',
  fileOps: './src/core/fileOps.ts',
  projectFiles: './src/core/projectFiles.ts',
});

const hostMod = bundle.host;
const answers = [];
const toasts = [];
const fakeHost = {
  name: 'standalone',
  supportsVscodeLm: false,
  config: { read: () => ({}), write: async () => {} },
  input: async () => answers.shift(),
  confirm: async () => answers.shift(),
  pick: async () => answers.shift(),
  progress: async (_t, fn) => fn(new AbortController().signal, () => {}),
  watch: () => ({ dispose: () => {} }),
  openFile: async () => {},
  toast: (m, level) => toasts.push(`${level ?? 'info'}: ${m}`),
  selectionAttachment: async () => undefined,
};
hostMod.initHost(fakeHost);

function expect(...values) {
  answers.length = 0;
  toasts.length = 0;
  answers.push(...values);
}
function erred() {
  return toasts.some((t) => t.startsWith('error:'));
}

const projectMod = bundle.project;
const pf = bundle.projectFiles;

const rel = (...p) => path.join(WORK, ...p);
const write = (relPath, text) => {
  fs.mkdirSync(path.dirname(rel(relPath)), { recursive: true });
  fs.writeFileSync(rel(relPath), text, 'utf8');
};
const read = (relPath) => fs.readFileSync(rel(relPath), 'utf8');

async function main() {
  const project = projectMod.NovelProject.open(WORK);
  await project.initialize({ title: '檔案頁測試', author: '測試' });
  fs.rmSync(rel('.novelforge/characters/example-protagonist.md'), { force: true });
  fs.rmSync(rel('.novelforge/lore/example-setting.md'), { force: true });
  write('chapters/001-楔子.md', '# 楔子\n\n雨下了三天。\n');
  write('.novelforge/characters/林昭.md', '---\nname: 林昭\n---\n\n# 林昭\n');
  write('notes/备忘.txt', '隨便記的。\n');
  project.invalidate();

  console.log('\n== 根範圍重新命名 ==');
  {
    // 區外檔案（notes/）也能改名——這是檔案頁與工程頁的本質區別。
    expect('備忘改名');
    let r = await pf.renameAny(project, 'notes/备忘.txt');
    check('區外檔案可重新命名', r.ok && r.to === 'notes/备忘改名.txt', JSON.stringify(r));

    // 章節仍保留序號字首與 H1 同步。
    expect('新的標題');
    r = await pf.renameAny(project, 'chapters/001-楔子.md');
    check('章節保留序號字首', r.ok && r.to === 'chapters/001-新的标题.md', JSON.stringify(r));
    check('章節 H1 同步', read('chapters/001-新的标题.md').startsWith('# 新的標題'));

    // 固定目錄一律拒絕。
    for (const p of ['chapters', '.novelforge', 'drafts', '.novelforge/characters', '.novelforge/.trash']) {
      expect('隨便');
      r = await pf.renameAny(project, p);
      check(`固定目錄不能改名：${p}`, r.ok === false && erred());
    }

    expect('外面');
    r = await pf.renameAny(project, '../外面');
    check('越界路徑拒絕', r.ok === false && erred());

    expect('不存在');
    r = await pf.renameAny(project, 'notes/幽灵.txt');
    check('不存在的路徑拒絕', r.ok === false);
  }

  console.log('\n== 移動（剪下+貼上） ==');
  {
    fs.mkdirSync(rel('archive'), { recursive: true });

    // 區外自由移動。
    let results = await pf.moveInto(project, ['notes/备忘改名.txt'], 'archive');
    check('區外檔案可移動', results[0].ok && results[0].to === 'archive/备忘改名.txt', JSON.stringify(results));
    check('原位置已空', !fs.existsSync(rel('notes/备忘改名.txt')));

    // 多項貼上：一項撞名，其餘照常。
    write('archive/撞名.txt', '先來的。\n');
    write('notes/甲.txt', '甲。\n');
    write('notes/撞名.txt', '後來的。\n');
    project.invalidate();
    results = await pf.moveInto(project, ['notes/甲.txt', 'notes/撞名.txt'], 'archive');
    const okOne = results.find((x) => x.from === 'notes/甲.txt');
    const badOne = results.find((x) => x.from === 'notes/撞名.txt');
    check('撞名項拒絕且原因明確', badOne && !badOne.ok && badOne.error.includes('同名'), JSON.stringify(badOne));
    check('其餘項不受影響', okOne && okOne.ok && okOne.to === 'archive/甲.txt', JSON.stringify(okOne));
    check('撞名時兩份都還在',
      read('archive/撞名.txt').includes('先來的') && read('notes/撞名.txt').includes('後來的'));

    // 章節移進 chapters 子目錄：manifest 與草稿跟著走。
    fs.mkdirSync(rel('chapters/卷一'), { recursive: true });
    fs.mkdirSync(rel('drafts'), { recursive: true });
    write('drafts/001-新的标题.md', '# 草稿\n');
    project.invalidate();
    results = await pf.moveInto(project, ['chapters/001-新的标题.md'], 'chapters/卷一');
    check('章節可移入子目錄',
      results[0].ok && results[0].to === 'chapters/卷一/001-新的标题.md', JSON.stringify(results));
    check('草稿跟著搬', fs.existsSync(rel('drafts/卷一/001-新的标题.md')));
    project.invalidate();
    const manifest = await project.readManifest();
    check('manifest 記新路徑',
      manifest.chapters.find((c) => c.order === 1).file === 'chapters/卷一/001-新的标题.md');

    // 章節移出 chapters/：允許，但草稿留在原處（日誌會 warn，這裡只驗磁碟狀態）。
    results = await pf.moveInto(project, ['chapters/卷一/001-新的标题.md'], 'archive');
    check('章節可移出 chapters', results[0].ok && results[0].to === 'archive/001-新的标题.md', JSON.stringify(results));
    check('草稿留在原處', fs.existsSync(rel('drafts/卷一/001-新的标题.md')));

    // 固定目錄不能搬。
    results = await pf.moveInto(project, ['chapters'], 'archive');
    check('固定目錄不能移動', results[0].ok === false, JSON.stringify(results));

    // 資料夾不能進自己的子孫。
    results = await pf.moveInto(project, ['archive'], 'archive');
    check('資料夾不能貼上進自己', results[0].ok === false, JSON.stringify(results));

    // 垃圾箱裡的東西不搬。
    write('.novelforge/.trash/notes/旧物.txt', '刪掉的。\n');
    results = await pf.moveInto(project, ['.novelforge/.trash/notes/旧物.txt'], 'notes');
    check('回收站內容不能移動', results[0].ok === false, JSON.stringify(results));

    // 越界落點。
    results = await pf.moveInto(project, ['notes/甲.txt'], '../../外面');
    check('落點越界拒絕', results[0].ok === false && erred(), JSON.stringify(results));

    // 已在目標目錄裡。
    results = await pf.moveInto(project, ['archive/甲.txt'], 'archive');
    check('已在該目錄時拒絕', results[0].ok === false, JSON.stringify(results));
  }

  console.log('\n== 複製（複製+貼上） ==');
  {
    let results = await pf.copyInto(project, ['archive/撞名.txt'], 'notes');
    check('複製後原檔案還在', results[0].ok && fs.existsSync(rel('archive/撞名.txt')), JSON.stringify(results));
    check('複製出同名新檔案', read('notes/撞名.txt').includes('先來的'));

    // 落點目錄必須已存在——貼上不會憑空建目錄。
    results = await pf.copyInto(project, ['archive'], 'backup');
    check('落點目錄不存在時拒絕', results[0].ok === false, JSON.stringify(results));
    fs.mkdirSync(rel('backup'), { recursive: true });
    results = await pf.copyInto(project, ['archive'], 'backup');
    check('目錄遞迴複製', results[0].ok && fs.existsSync(rel('backup/archive/甲.txt')), JSON.stringify(results));

    // 複製撞名同樣拒絕。
    results = await pf.copyInto(project, ['notes/撞名.txt'], 'archive');
    check('複製撞名拒絕', results[0].ok === false && fs.existsSync(rel('archive/撞名.txt')), JSON.stringify(results));
  }

  fs.rmSync(WORK, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? '全部通過' : `${failures} 項失敗`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: 掛進 smoke 鏈**

`package.json` 的 `smoke` 指令碼里，在 `node scripts/smoke-fileops.js &&` 之後插入 `node scripts/smoke-projectFiles.js && `。

- [ ] **Step 3: 跑測試，確認失敗**

Run: `node scripts/smoke-projectFiles.js`
Expected: FAIL（esbuild 解析不到 `./src/core/projectFiles.ts`，模組尚不存在）

- [ ] **Step 4: Commit**

```powershell
git add scripts/smoke-projectFiles.js package.json
git commit -m "chore: 增加工程根範圍檔案操作的冒煙測試（暫失敗）"
```

---

### Task 4: projectFiles.ts 實現

**Files:**
- Create: `src/core/projectFiles.ts`

- [ ] **Step 1: 寫實現**

```ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { carryDraft, isProtectedPath, normalizeRel, renameEntryInRoot, sectionOf } from './fileOps';
import { getHost } from './host';
import { describeError, scoped } from './logger';
import { NovelProject, exists } from './model/project';
import { FileOpResult } from './protocol';

const log = scoped('檔案頁');

/**
 * 檔案頁（資源管理器）的類檔案操作：工程根範圍的重新命名、移動、複製。
 *
 * 與 fileOps.ts 的分工：那邊鎖在章節/角色/設定三個區裡，是工程頁的產品
 * 承諾；這邊面向整個工程根（含 `.novelforge/`），是檔案頁的磁碟視角。
 * 相同的約束仍然在：
 *
 * 1. **不出工程根**：`..` 逃逸與絕對路徑一律拒絕。
 * 2. **不靜默覆蓋**：目標同名逐項拒絕，其餘項繼續。
 * 3. **固定目錄不動**：chapters/、drafts/、.novelforge 及其關鍵子目錄受保護。
 * 4. **垃圾箱不搬**：`.novelforge/.trash/` 裡的內容不是操作物件。
 *
 * 章節聯動：源在 chapters/ 下的移動帶草稿跟隨與 manifest 同步；
 * 章節被移出 chapters/ 時草稿留在原映象路徑，只記日誌提醒。
 */

/** 工程根範圍的重新命名。逐項結果的形狀與 move/copy 對齊。 */
export async function renameAny(project: NovelProject, relPath: string): Promise<FileOpResult> {
  const from = normalizeRel(relPath) ?? relPath;
  const to = await renameEntryInRoot(project, relPath);
  return to ? { from, to, ok: true } : { from, ok: false };
}

/** 貼上（剪下變體）：把若干檔案/目錄移動到目標目錄。 */
export async function moveInto(
  project: NovelProject,
  sources: string[],
  targetDir: string
): Promise<FileOpResult[]> {
  return pasteAll(project, sources, targetDir, false);
}

/** 貼上（複製變體）：把若干檔案/目錄遞迴複製到目標目錄。 */
export async function copyInto(
  project: NovelProject,
  sources: string[],
  targetDir: string
): Promise<FileOpResult[]> {
  return pasteAll(project, sources, targetDir, true);
}

async function pasteAll(
  project: NovelProject,
  sources: string[],
  targetDir: string,
  copy: boolean
): Promise<FileOpResult[]> {
  // 空串落點 = 工程根目錄；normalizeRel 不收空串，單獨放行。
  const dest = targetDir.trim() === '' ? '' : normalizeRel(targetDir);
  if (dest === undefined) {
    log.warn(`貼上被拒：目標目錄不合法`, `原始輸入 ${JSON.stringify(targetDir)}`);
    getHost().toast('目標目錄不合法。', 'error');
    return sources.map((from) => ({ from, ok: false, error: '目標目錄不合法' }));
  }
  const destAbs = dest === '' ? project.root : project.pathOf(dest);
  let destIsDir = false;
  try {
    destIsDir = (await fs.stat(destAbs)).isDirectory();
  } catch {
    destIsDir = false;
  }
  if (!destIsDir) {
    log.warn(`貼上被拒：目標目錄不存在 ${dest || '（工程根）'}`);
    getHost().toast(`目標目錄不存在：${dest || '（工程根）'}`, 'error');
    return sources.map((from) => ({ from, ok: false, error: '目標目錄不存在' }));
  }

  const results: FileOpResult[] = [];
  let chaptersTouched = false;
  for (const source of sources) {
    const r = await pasteOne(project, source, dest, copy);
    if (r.ok && sectionOf(project, r.from)?.section === 'chapters') {
      chaptersTouched = true;
    }
    results.push(r);
  }

  // 移動章節改了路徑；複製進 chapters/ 的可能帶來新章節。兩種都重算 manifest。
  const chaptersRoot = project.relPath(project.chaptersDir);
  if (chaptersTouched || (copy && (dest === chaptersRoot || dest.startsWith(`${chaptersRoot}/`)))) {
    await project.syncManifest();
  }
  project.invalidate();

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    getHost().toast(`${failed.length} 項未${copy ? '複製' : '移動'}：${failed[0].error}`, 'error');
  } else {
    log.info(
      `${copy ? '已複製' : '已移動'} ${results.length} 項`,
      `落點 ${dest === '' ? '（工程根）' : dest}`
    );
    getHost().toast(`已${copy ? '複製' : '移動'} ${results.length} 項到 ${dest === '' ? '工程根目錄' : dest}。`);
  }
  return results;
}

async function pasteOne(
  project: NovelProject,
  relPath: string,
  dest: string,
  copy: boolean
): Promise<FileOpResult> {
  const rel = normalizeRel(relPath);
  if (!rel) {
    log.warn(`貼上被拒：路徑不合法`, `原始輸入 ${JSON.stringify(relPath)}`);
    return { from: relPath, ok: false, error: '路徑不合法' };
  }
  if (isProtectedPath(project, rel)) {
    log.warn(`貼上被拒：${rel} 是工程的固定目錄`);
    return { from: rel, ok: false, error: `「${rel}」是固定目錄` };
  }
  if (rel === '.novelforge/.trash' || rel.startsWith('.novelforge/.trash/')) {
    log.warn(`貼上被拒：${rel} 在回收站裡`);
    return { from: rel, ok: false, error: '回收站裡的內容不能操作' };
  }

  const abs = project.pathOf(rel);
  let isDir: boolean;
  try {
    isDir = (await fs.stat(abs)).isDirectory();
  } catch {
    log.warn(`貼上被拒：找不到 ${rel}`);
    return { from: rel, ok: false, error: `找不到 ${rel}` };
  }

  const name = path.basename(rel);
  const nextRel = dest === '' ? name : `${dest}/${name}`;
  if (nextRel === rel) {
    return { from: rel, ok: false, error: '已經在這個目錄裡' };
  }
  // 目錄不能搬進自己的子孫——那會把子樹從檔案系統上摘下來。
  if (isDir && (dest === rel || dest.startsWith(`${rel}/`))) {
    log.warn(`貼上被拒：不能把資料夾放進自己裡面`, `${rel} → ${dest}`);
    return { from: rel, ok: false, error: '不能放進它自己裡面' };
  }
  const nextAbs = project.pathOf(nextRel);
  if (await exists(nextAbs)) {
    log.warn(`貼上被拒：目標已有同名項 ${nextRel}`);
    return { from: rel, ok: false, error: `目標已有同名項 ${nextRel}` };
  }

  try {
    if (copy) {
      await fs.cp(abs, nextAbs, { recursive: true });
    } else {
      await fs.rename(abs, nextAbs);
    }
  } catch (err) {
    log.warn(`貼上失敗：${rel} → ${nextRel}`, describeError(err));
    return { from: rel, ok: false, error: describeError(err) };
  }

  if (!copy && sectionOf(project, rel)?.section === 'chapters') {
    // 章節移動：草稿跟隨。移出 chapters/ 時新映象路徑推導不出，草稿留在原處。
    const toDraft = project.draftRelPathFor(nextRel);
    if (toDraft) {
      await carryDraft(project, rel, nextRel, isDir);
    } else {
      const fromDraft = project.draftRelPathFor(rel);
      if (fromDraft && (await exists(project.pathOf(fromDraft)))) {
        log.warn(`章节被移出 chapters/，草稿留在原处`, `草稿仍在 ${fromDraft}`);
      }
    }
  }

  log.info(`${copy ? '已複製' : '已移動'}${isDir ? '資料夾' : ''}`, `${rel} → ${nextRel}`);
  return { from: rel, to: nextRel, ok: true };
}
```

注意：`describeError` 從 `./logger` 匯出（progress.ts 已在用）。實現前先確認該匯出存在；若不存在改用 `(err as Error)?.message ?? String(err)`。

- [ ] **Step 2: 跑測試確認通過**

Run: `node scripts/smoke-projectFiles.js`
Expected: 全部通過

- [ ] **Step 3: 迴歸**

Run: `npm run typecheck; node scripts/smoke-fileops.js; node scripts/check-core-purity.js`
Expected: 全部 PASS（projectFiles.ts 無 vscode 依賴）

- [ ] **Step 4: Commit**

```powershell
git add src/core/projectFiles.ts
git commit -m "feat: 檔案頁的工程根範圍重新命名/移動/複製"
```

---

### Task 5: controller 接線（fileAction）

**Files:**
- Modify: `src/core/controller.ts`

- [ ] **Step 1: 補 import**

controller.ts 頂部已 import fileOps 的三個函式，追加 projectFiles：

```ts
import { copyInto, moveInto, renameAny } from './projectFiles';
```

並在 protocol 的 import 列表里加上 `FileOpResult` 型別。

- [ ] **Step 2: 改訊息分發**

訊息 switch 裡（約第 294 行）：

```ts
      case 'fileAction':
        await this.fileAction(msg);
        return;
```

- [ ] **Step 3: 重寫 fileAction 方法**

整個替換現有 `private async fileAction(...)`（約第 919-933 行）：

```ts
  /**
   * 類檔案操作。工程頁的 rename/move/delete 走 core/fileOps（三區鎖定），
   * 檔案頁的 renameAny/paste 走 core/projectFiles（根範圍）。
   * 有逐項結果的動作額外推 filesOpDone，前端據此 remap 編輯器標籤。
   */
  private async fileAction(msg: Extract<InMessage, { type: 'fileAction' }>): Promise<void> {
    const { action, relPath, relPaths, op, targetDir } = msg;
    log.info(
      `檔案動作：${action}`,
      [relPath ?? '', relPaths ? relPaths.join('、') : '', targetDir !== undefined ? `目標目錄 ${targetDir || '（根）'}` : '']
        .filter(Boolean)
        .join('｜') || undefined
    );
    let results: FileOpResult[] | undefined;
    switch (action) {
      case 'rename':
        if (relPath) {
          await renameEntry(this.project, relPath);
        }
        break;
      case 'renameAny':
        if (relPath) {
          results = [await renameAny(this.project, relPath)];
        }
        break;
      case 'move':
        if (relPath) {
          await moveEntry(this.project, relPath, targetDir);
        }
        break;
      case 'delete':
        if (relPath) {
          await deleteEntry(this.project, relPath);
        }
        break;
      case 'paste':
        results =
          op === 'copy'
            ? await copyInto(this.project, relPaths ?? [], targetDir ?? '')
            : await moveInto(this.project, relPaths ?? [], targetDir ?? '');
        break;
    }
    if (results && results.length > 0) {
      this.post({
        type: 'filesOpDone',
        op: action === 'renameAny' ? 'rename' : op === 'copy' ? 'copy' : 'move',
        results,
      });
    }
    await this.pushState();
  }
```

- [ ] **Step 4: 驗證**

Run: `npm run typecheck; node scripts/smoke-fileops.js; node scripts/smoke-projectFiles.js`
Expected: PASS（smoke 不經過 controller，這裡主要保編譯與既有行為）

- [ ] **Step 5: Commit**

```powershell
git add src/core/controller.ts
git commit -m "feat: controller 接線檔案頁貼上與根範圍重新命名"
```

---

### Task 6: characterCard.ts 抽出單卡執行體（等價重構）

**Files:**
- Modify: `src/core/features/characterCard.ts`

批次編排要逐卡複用「分批分析 → 寫回」的執行體，但不能巢狀兩層 runTask（進度條會疊）。把現 `runUpdate` 裡 runTask 內部的迴圈體抽成 `runCardUpdate`，單卡流程行為**一字不差**（smoke-characterCard.js 是守門員）。

- [ ] **Step 1: 匯出批型別、抽執行體**

1. `interface Batch` 改為 `export interface Batch`（批次計劃要引用）。

2. 新增結果型別與執行體。把原 `runUpdate` 中 `await runTask(...)` 回呼裡從 `const startedAt` 到結尾的全部邏輯搬進 `runCardUpdate`，並做三處引數化：

```ts
/** 單卡執行的結果。batch 編排據此統計。 */
export interface CardUpdateOutcome {
  status: 'updated' | 'discarded' | 'failed' | 'cancelled';
  /** status 為 updated 時給出推進後的水位線。 */
  updatedThrough?: number;
}

/**
 * 單張卡的執行體：分批分析 → 合併 → 審閱/寫回。
 * 不自己開 runTask，進度經 ctx.report 交給外層（單卡與批次共用一條進度條）。
 * `batches` 由外層算好傳入——批次場景在總確認前已算過一次，不必重讀章節。
 */
async function runCardUpdate(
  project: NovelProject,
  card: CharacterCard,
  chapters: Chapter[],
  opts: {
    scope: UpdateScope;
    allAppearances: number[];
    batches: Batch[];
    skipReview?: boolean;
  },
  ctx: {
    signal: AbortSignal;
    report: (message: string, current?: number, total?: number) => void;
  }
): Promise<CardUpdateOutcome> {
  const startedAt = Date.now();
  const steps = opts.batches.length + 1;
  let sections: CharacterSections = { ...card.sections };
  let aliases = [...card.aliases];
  let tags = [...card.tags];
  const analyzed: number[] = [];
  const failed: number[] = [];

  for (let i = 0; i < opts.batches.length; i++) {
    if (ctx.signal.aborted) {
      log.warn(`更新被取消，已完成 ${i}/${opts.batches.length} 批`);
      return { status: 'cancelled' };
    }
    // 原 for 迴圈體從這裡起逐行搬入，只改兩處：
    //   report({ message, current: i, total: steps })  →  ctx.report(`分析 ${range}`, i, steps)
    //   其餘（analyzeBatch、失敗降級、analyzed/failed 記錄、逐批日誌）原樣。
  }

  if (ctx.signal.aborted) {
    log.warn('更新被取消（寫入前）');
    return { status: 'cancelled' };
  }

  if (analyzed.length === 0) {
    // 原「全部失敗」分支逐行搬入（log.error + toast 文案不變），末尾改為：
    return { status: 'failed' };
  }

  ctx.report('寫入角色卡', opts.batches.length, steps);
  // 原 appearances / firstFailure / updatedThrough / merged 計算逐行搬入，不改。

  const abs = project.pathOf(card.relPath);
  const proposedText = renderCharacterCard(merged);
  if (opts.skipReview) {
    await writeText(abs, proposedText);
    log.info(`已寫入角色卡「${card.name}」`, `${card.relPath}｜總耗時 ${elapsed(startedAt)}`);
  } else {
    const applied = await review(project, card, proposedText);
    if (!applied) {
      ctx.report('已放棄', steps, steps);
      return { status: 'discarded' };
    }
    log.info(
      `已更新角色卡「${card.name}」`,
      `${card.relPath}｜覆蓋至第 ${merged.updatedThrough} 章｜總耗時 ${elapsed(startedAt)}`
    );
  }
  ctx.report('完成', steps, steps);
  return { status: 'updated', updatedThrough: merged.updatedThrough };
}
```

搬遷要點（原邏輯逐條保留）：
- 水位線只推進到第一個失敗章節之前（原註釋保留）；
- 單批解析失敗不放棄整次更新（原註釋保留）；
- `report({ message, current, total })` 全部改寫為 `ctx.report(message, current, total)`。

3. `runUpdate` 改為薄編排：

```ts
async function runUpdate(
  project: NovelProject,
  card: CharacterCard,
  chapters: Chapter[],
  opts: { scope: UpdateScope; allAppearances: number[]; skipReview?: boolean }
): Promise<void> {
  const provider = await resolveProvider();
  if (!provider) {
    log.error('沒有可用的模型，更新中止');
    return;
  }
  const config = readConfig();
  const batches = await planBatches(project, chapters, config);
  if (batches.length === 0) {
    log.warn(`「${card.name}」的出場章節都是空的`);
    getHost().toast('這些章節都是空的，沒有可分析的內容。', 'error');
    return;
  }

  // ……原 willRead/skipped 統計與「預計呼叫模型 N 次」的 confirm 原樣保留……

  log.info(
    `開始${scopeLabel}「${card.name}」`,
    `${willRead} 章分 ${batches.length} 批｜章節 ${describeChapters(
      batches.flatMap((b) => b.chapters.map((c) => c.order))
    )}｜模型 ${provider.label}`
  );

  await runTask(
    `更新角色卡「${card.name}」`,
    async ({ signal, report }) => {
      const outcome = await runCardUpdate(
        project,
        card,
        chapters,
        { scope: opts.scope, allAppearances: opts.allAppearances, batches, skipReview: opts.skipReview },
        {
          signal,
          report: (message, current, total) => report({ message, current, total }),
        }
      );
      if (outcome.status === 'updated') {
        getHost().toast(`「${card.name}」已更新，覆蓋至第 ${outcome.updatedThrough} 章。`);
        await getHost().openFile(card.relPath);
      }
    },
    { scope: '角色卡' }
  );
}
```

- [ ] **Step 2: 迴歸**

Run: `npm run typecheck; node scripts/smoke-characterCard.js`
Expected: 全部通過（行為等價）。

- [ ] **Step 3: Commit**

```powershell
git add src/core/features/characterCard.ts
git commit -m "refactor: 角色卡更新抽出單卡執行體供批次複用"
```

---

### Task 7: smoke-characterCard.js 批次斷言（先寫失敗測試）

**Files:**
- Modify: `scripts/smoke-characterCard.js`

- [ ] **Step 1: 假宿主記錄 openFile**

在 fakeHost 定義之前加 `const opened = [];`，把 `openFile: async () => {},` 改為：

```js
  openFile: async (p) => opened.push(p),
```

`expect(...)` 裡追加 `opened.length = 0;`。並在「分批與『預計呼叫次數』」小節末尾追加一條現有行為斷言：

```js
    check('單卡更新後自動開啟該卡', opened.includes('.novelforge/characters/林昭.md'), JSON.stringify(opened));
```

- [ ] **Step 2: 新增批次小節**

在 `main()` 的最後一個小節之後、統計輸出之前插入。此時夾具狀態：林昭（updatedThrough 6，第 7、8 章是新出場）、幽靈（摘要裡沒出現）、客棧掌櫃（updatedThrough 3，無新章）：

```js
  console.log('\n== 批次更新所有角色卡 ==');
  {
    // ---- 增量：只挑有新出場的卡，動手前報總呼叫次數。
    project.invalidate();
    expect('逐張確認後開始');
    replies = [cardJson({ 當前狀態: '批次測試中' })];
    await cardMod.updateAllCharacterCards(project, 'incremental');

    const ask = confirms.find((c) => c.message.includes('預計呼叫模型'));
    check('批次動手前問過使用者', !!ask, JSON.stringify(confirms.map((c) => c.message)));
    check('確認框給出兩種採納方式',
      ask && ask.actions.includes('逐張確認後開始') && ask.actions.includes('全部直接採納並開始'),
      ask && JSON.stringify(ask.actions));
    check('預計呼叫次數與實際一致',
      ask && ask.message.includes(`預計呼叫模型 ${calls.length} 次`), ask && ask.message);
    check('跳過情況寫進明細',
      ask && ask.detail.includes('幽靈') && ask.detail.includes('客棧掌櫃'), ask && ask.detail);

    const corpus = calls.map((m) => m[1].content).join('\n');
    check('增量批次只讀新出場的章節', corpus.includes('第七') && !corpus.includes('楔子'), corpus.slice(0, 120));
    check('逐張確認模式走了 diff 審閱', reviewed.length === 1, String(reviewed.length));
    check('批次不自動開啟卡', opened.length === 0, JSON.stringify(opened));
    check('林昭的卡已更新', read('.novelforge/characters/林昭.md').includes('批次測試中'));

    // ---- 從頭重建：全部有出場的卡全量重讀，可整體直接採納。
    expect('全部直接採納並開始');
    replies = [cardJson({ 身份: '重建的身份' })];
    await cardMod.updateAllCharacterCards(project, 'full');

    const fullCorpus = calls.map((m) => m[1].content).join('\n');
    check('重建讀全部出場章節', fullCorpus.includes('楔子') && fullCorpus.includes('夜談'));
    check('直接採納模式不走審閱', reviewed.length === 0, String(reviewed.length));
    check('兩張卡都已重寫',
      read('.novelforge/characters/林昭.md').includes('重建的身份') &&
      read('.novelforge/characters/客栈掌柜.md').includes('重建的身份'));
    check('完成提示報數', toasts.some((t) => t.includes('已更新 2 張')), toasts.join(' | '));

    // ---- 取消：一次模型都不調。
    expect(undefined);
    replies = [cardJson()];
    await cardMod.updateAllCharacterCards(project, 'full');
    check('使用者取消則不調模型', calls.length === 0, String(calls.length));

    // ---- 無可更新：不彈確認框，直接說明。
    expect();
    await cardMod.updateAllCharacterCards(project, 'incremental');
    check('沒有新章節時不彈確認框', confirms.length === 0, JSON.stringify(confirms.map((c) => c.message)));
    check('沒有新章節時明說', toasts.some((t) => t.includes('沒有需要更新的角色卡')), toasts.join(' | '));
  }
```

注意最後一條「無可更新」依賴前兩步已把所有卡的 updatedThrough 推到最新；若執行順序調整需同步調整該依賴。

- [ ] **Step 3: 跑測試，確認失敗**

Run: `node scripts/smoke-characterCard.js`
Expected: FAIL（`updateAllCharacterCards` 尚不存在）

- [ ] **Step 4: Commit**

```powershell
git add scripts/smoke-characterCard.js
git commit -m "chore: 批次角色卡更新的冒煙斷言（暫失敗）"
```

---

### Task 8: characterCard.ts 批次計劃與編排

**Files:**
- Modify: `src/core/features/characterCard.ts`

- [ ] **Step 1: 批次計劃（純函式化，可測）**

放在 `updateCharacterCard` 之後：

```ts
/** 批次計劃裡的一張卡。 */
export interface CardUpdatePlan {
  card: CharacterCard;
  /** 本次要讀的出場章節序號。 */
  orders: number[];
  /** 預先算好的分批（總確認報呼叫次數用，執行時不重算）。 */
  batches: Batch[];
  /** 真正參與分析的章節數（空章節已剔除）。 */
  chapters: number;
}

export interface BatchUpdatePlan {
  plans: CardUpdatePlan[];
  skipped: { card: CharacterCard; reason: string }[];
}

/**
 * 批次計劃：列出全部角色卡，逐卡算出要讀哪些章、分幾批。
 * 增量模式只取 updatedThrough 之後的新出場；無新出場/未在摘要出現/
 * 出場章節已不在磁碟/正文全空的卡計入 skipped。匯出供總確認與冒煙測試。
 */
export async function planAllUpdates(project: NovelProject, scope: UpdateScope): Promise<BatchUpdatePlan> {
  const cards = await project.listCharacters();
  const index = await buildCastIndex(project);
  const config = readConfig();
  const allChapters = await project.listChapters();
  const result: BatchUpdatePlan = { plans: [], skipped: [] };

  for (const card of cards) {
    const all = appearancesOf(index, card);
    if (all.length === 0) {
      result.skipped.push({ card, reason: '未在摘要中出現' });
      continue;
    }
    const orders = scope === 'incremental' ? all.filter((o) => o > (card.updatedThrough ?? 0)) : all;
    if (orders.length === 0) {
      result.skipped.push({ card, reason: '沒有新的出場章節' });
      continue;
    }
    const chapters = allChapters.filter((c) => orders.includes(c.order));
    if (chapters.length === 0) {
      result.skipped.push({ card, reason: '出場章節已不在磁碟上' });
      continue;
    }
    const batches = await planBatches(project, chapters, config);
    if (batches.length === 0) {
      result.skipped.push({ card, reason: '章節正文都為空' });
      continue;
    }
    result.plans.push({
      card,
      orders,
      batches,
      chapters: batches.reduce((sum, b) => sum + b.chapters.length, 0),
    });
  }
  return result;
}
```

- [ ] **Step 2: 批次編排**

緊接其後：

```ts
/**
 * 批次更新全部角色卡——工程頁「角色」分組的右鍵動作。
 * incremental：每卡只讀上次更新後的新出場章節；full：每卡全量重讀。
 *
 * 「不偷偷燒 token」：總確認框先報清卡數、章數、批數（= 預計呼叫次數），
 * 並讓使用者選採納方式（逐張 diff 確認 / 全部直接採納）。
 */
export async function updateAllCharacterCards(project: NovelProject, scope: UpdateScope): Promise<void> {
  const provider = await resolveProvider();
  if (!provider) {
    log.error('沒有可用的模型，批次更新中止');
    return;
  }
  const { plans, skipped } = await planAllUpdates(project, scope);
  if (plans.length === 0) {
    log.info('沒有需要更新的角色卡', skipped.length > 0 ? `跳過 ${skipped.length} 張` : undefined);
    getHost().toast(
      `沒有需要更新的角色卡${skipped.length > 0 ? `（${skipped.length} 張被跳過）` : ''}。`
    );
    return;
  }

  const totalBatches = plans.reduce((sum, p) => sum + p.batches.length, 0);
  const totalChapters = plans.reduce((sum, p) => sum + p.chapters, 0);
  const label = scope === 'incremental' ? '更新' : '從頭重建';
  const pick = await getHost().confirm(
    `${label} ${plans.length} 張角色卡：共需通讀 ${totalChapters} 章，` +
      `分 ${totalBatches} 批，預計呼叫模型 ${totalBatches} 次。現在開始？`,
    ['逐張確認後開始', '全部直接採納並開始'],
    {
      modal: true,
      detail:
        skipped.length > 0
          ? `跳過 ${skipped.length} 張：${skipped.map((s) => `「${s.card.name}」（${s.reason}）`).join('、')}`
          : undefined,
    }
  );
  if (!pick) {
    log.info('使用者取消了批次更新');
    return;
  }
  const autoApply = pick === '全部直接採納並開始';

  log.info(
    `開始批次${label}角色卡`,
    `${plans.length} 張｜${totalChapters} 章分 ${totalBatches} 批｜模型 ${provider.label}｜` +
      (autoApply ? '全部直接採納' : '逐張確認')
  );

  await runTask(
    `批次${label}角色卡`,
    async ({ signal, report }) => {
      // 每張卡的步數（批數 + 寫入那一步），累加成總進度條的分母。
      const totalSteps = plans.reduce((sum, p) => sum + p.batches.length + 1, 0);
      let done = 0;
      let updated = 0;
      let failed = 0;
      let discarded = 0;

      for (let i = 0; i < plans.length; i++) {
        if (signal.aborted) {
          break;
        }
        const plan = plans[i];
        // 計劃是確認前算的，章節可能剛被改名/刪除——以當前磁碟為準再過濾一次。
        const chapters = (await project.listChapters()).filter((c) => plan.orders.includes(c.order));
        const outcome = await runCardUpdate(
          project,
          plan.card,
          chapters,
          { scope, allAppearances: plan.orders, batches: plan.batches, skipReview: autoApply },
          {
            signal,
            report: (message, current) =>
              report({
                message: `第 ${i + 1}/${plans.length} 张「${plan.card.name}」· ${message}`,
                current: done + (current ?? 0),
                total: totalSteps,
              }),
          }
        );
        done += plan.batches.length + 1;
        if (outcome.status === 'updated') updated++;
        else if (outcome.status === 'failed') failed++;
        else if (outcome.status === 'discarded') discarded++;
        else if (outcome.status === 'cancelled') break;
      }

      report({ message: '完成', current: totalSteps, total: totalSteps });
      const summary =
        `已更新 ${updated} 張` +
        (discarded > 0 ? `，放棄 ${discarded} 張` : '') +
        (failed > 0 ? `，失敗 ${failed} 張` : '') +
        (skipped.length > 0 ? `，跳過 ${skipped.length} 張` : '');
      log.info(`批次${label}角色卡結束`, summary);
      getHost().toast(`角色卡${label}完成：${summary}。`);
    },
    { scope: '角色卡' }
  );
}
```

注意：批次結束**不**呼叫 `openFile`（區別於單卡流程，避免連開幾十個標籤），路徑已進日誌。

- [ ] **Step 3: 跑測試確認通過**

Run: `node scripts/smoke-characterCard.js`
Expected: 全部通過（含新小節與既有小節）。

- [ ] **Step 4: Commit**

```powershell
git add src/core/features/characterCard.ts
git commit -m "feat: 批次更新/從頭重建所有角色卡"
```

---

### Task 9: controller 接線 + 工程頁「角色」分組選單

**Files:**
- Modify: `src/core/controller.ts`
- Modify: `media/view.js`
- Modify: `scripts/smoke-view.js`

- [ ] **Step 1: controller 補兩個 case**

`characterAction` 方法的 switch 裡（約第 941 行），import 先補 `updateAllCharacterCards`（來自 `./features/characterCard`），再加：

```ts
      case 'updateAllCards':
        await updateAllCharacterCards(this.project, 'incremental');
        break;
      case 'rebuildAllCards':
        await updateAllCharacterCards(this.project, 'full');
        break;
```

- [ ] **Step 2: view.js 的 buildGroup 支援附加選單項**

`buildGroup` 裡的選單登記（約第 1387-1394 行）改為：

```js
    if (opts.section) {
      // 登記在整個分組上：標題欄、分組內的空白、空提示行都能右鍵新建。
      onContextMenu(box, () => [
        ...(opts.extraItems ? opts.extraItems() : []),
        ...newItemsIn(opts.section, opts.root),
        { sep: true },
        ...baseMenuItems(),
      ]);
    }
```

- [ ] **Step 3: 角色分組掛上兩個批次項**

`renderProject` 裡構建角色分組處（約第 1147 行）：

```js
    el.projectBody.appendChild(
      buildGroup('characters', '角色', countLabel(tree.characters, '人'), {
        section: SECTIONS.characters,
        root: tree.charactersRoot,
        extraItems: () => [
          { label: '更新所有角色卡', run: () => characterAction('updateAllCards') },
          { label: '從頭重建所有角色卡', run: () => characterAction('rebuildAllCards') },
          { sep: true },
        ],
        build: () =>
          tree.characters.length === 0
            ? [emptyRow('還沒有角色卡。可執行「提取/更新角色卡」從正文抽取。')]
            : renderNodes(tree.characters, 0, SECTIONS.characters, tree),
      })
    );
```

`characterAction` 幫助函式（約第 1098 行）把 name 兜底為空串，批次動作不必傳名字：

```js
  function characterAction(action, name, relPath) {
    vscode.postMessage({ type: 'characterAction', action, name: name ?? '', relPath });
  }
```

- [ ] **Step 4: smoke-view.js 斷言**

在「工程頁的右鍵選單」小節末尾（`closeAnyMenu(ui);` 之前）插入：

```js
  // ---- 角色分組：批次更新/重建。
  const charHead = [...ui.doc.querySelectorAll('#projectBody .group-head')]
    .find((n) => n.querySelector('.group-name').textContent === '角色');
  const charItems = itemsOf(rightClick(charHead));
  check('角色分組選單含批次項',
    charItems.includes('更新所有角色卡') && charItems.includes('從頭重建所有角色卡'),
    JSON.stringify(charItems));
  check('角色分組選單仍含新建項', charItems.includes('在此新建角色卡'), JSON.stringify(charItems));
  pick(rightClick(charHead), '更新所有角色卡');
  const upAll = last('characterAction');
  check('「更新所有角色卡」發 updateAllCards',
    upAll && upAll.action === 'updateAllCards', JSON.stringify(upAll));
  pick(rightClick(charHead), '從頭重建所有角色卡');
  const reAll = last('characterAction');
  check('「從頭重建」發 rebuildAllCards',
    reAll && reAll.action === 'rebuildAllCards', JSON.stringify(reAll));
```

- [ ] **Step 5: 驗證**

Run: `npm run typecheck; node scripts/smoke-view.js`
Expected: 全部通過

- [ ] **Step 6: Commit**

```powershell
git add src/core/controller.ts media/view.js scripts/smoke-view.js
git commit -m "feat: 工程頁角色分組增加批次更新/重建入口"
```

---

### Task 10: explorer.js 剪貼簿、選單、快捷鍵與聯動

**Files:**
- Modify: `media/explorer.js`
- Modify: `media/standalone.css`
- Modify: `scripts/smoke-view.js`

- [ ] **Step 1: explorer.js 剪貼簿狀態與工具函式**

在 `let activeFile = null;` 之後插入：

```js
  /**
   * 檔案剪貼簿：剪下/複製只是登記，真正的磁碟動作只有「貼上」一次。
   * 同時把相對路徑以純文字寫進系統剪貼簿（僅外送，不讀回）——
   * 在別處貼上得到的是路徑字串。
   */
  let clipboard = null; // { op: 'cut' | 'copy', paths: string[] }

  /** 當前選中行（點選或鍵盤焦點到達的行）。Ctrl+X/C/V 作用在它上面。 */
  let selectedEntry = null;

  function parentOf(relPath) {
    const i = relPath.lastIndexOf('/');
    return i === -1 ? '' : relPath.slice(0, i);
  }

  function setClipboard(op, paths) {
    clipboard = { op, paths };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(paths.join('\n')).catch(() => {});
    }
    toast(`${op === 'cut' ? '已剪下' : '已複製'} ${paths.length} 項`);
    render();
  }

  function pasteInto(destDir) {
    if (!clipboard) return;
    vscode.postMessage({
      type: 'fileAction',
      action: 'paste',
      op: clipboard.op,
      relPaths: clipboard.paths,
      targetDir: destDir,
    });
  }

  /** 剪下/複製/貼上/重新命名四項。檔案與資料夾行共用。 */
  function clipboardItems(entry) {
    const dest = entry.kind === 'dir' ? entry.relPath : parentOf(entry.relPath);
    return [
      { label: '剪下', run: () => setClipboard('cut', [entry.relPath]) },
      { label: '複製', run: () => setClipboard('copy', [entry.relPath]) },
      { label: '貼上', disabled: !clipboard, run: () => pasteInto(dest) },
      {
        label: '重新命名',
        run: () => vscode.postMessage({ type: 'fileAction', action: 'renameAny', relPath: entry.relPath }),
      },
      { sep: true },
    ];
  }
```

- [ ] **Step 2: 行渲染掛鉤**

`baseRow(depth)` 末尾（return 之前）加焦點支援：

```js
    row.tabIndex = 0;
    return row;
```

（原來的 `return row;` 保留在它後面。）

`dirRow` 與 `fileRow` 裡各加兩處：

```js
    // 剪下源壓暗，與 VS Code 一致。
    if (clipboard && clipboard.op === 'cut' && clipboard.paths.includes(entry.relPath)) {
      row.classList.add('fx-cut');
    }
    row.addEventListener('focus', () => { selectedEntry = entry; });
```

並把兩個函式里現有 `onContextMenu(row, () => [` 的選單陣列前面拼上 `...clipboardItems(entry),`——即檔案行選單變為：

```js
    onContextMenu(row, () => [
      ...clipboardItems(entry),
      {
        label: entry.editable ? '開啟' : '開啟（外部程式）',
        run: () => openEntry(entry),
      },
      { label: '在系統中開啟', run: () => vscode.postMessage({ type: 'openExternal', path: entry.relPath }) },
      { sep: true },
      { label: '複製相對路徑', run: () => copyPath(entry.relPath) },
    ]);
```

目錄行同理（`clipboardItems(entry),` 之後接原有的 摺疊/展開、在系統中開啟、複製相對路徑）。

兩處 `row.addEventListener('click', ...)` 改為先記選中再執行原邏輯：

```js
    row.addEventListener('click', () => {
      selectedEntry = entry;
      toggleDir(entry.relPath); // 目錄行；檔案行是 openEntry(entry)
    });
```

- [ ] **Step 3: 空白處右鍵可貼上到工程根**

在「工具欄」小節之前插入：

```js
  // 樹裡的空白處（沒命中任何行）：給一條貼上到工程根。
  onContextMenu(body, () => [
    { label: '貼上到工程根目錄', disabled: !clipboard, run: () => pasteInto('') },
    { sep: true },
    {
      label: '重新整理',
      run: () => {
        for (const dir of openDirs) pending.add(dir);
        requestDirs();
      },
    },
  ]);
```

- [ ] **Step 4: Ctrl+X/C/V**

同處繼續插入：

```js
  // 快捷鍵只認「檔案」頁啟用且樹裡有選中行——編輯器裡的文字
  // Ctrl+C/V 走不到這裡（焦點不在樹上），互不干擾。
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || !selectedEntry) return;
    const pane = document.getElementById('pane-files');
    if (!pane || !pane.classList.contains('active')) return;
    const key = e.key.toLowerCase();
    if (key === 'c') {
      e.preventDefault();
      setClipboard('copy', [selectedEntry.relPath]);
    } else if (key === 'x') {
      e.preventDefault();
      setClipboard('cut', [selectedEntry.relPath]);
    } else if (key === 'v') {
      e.preventDefault();
      const dest = selectedEntry.kind === 'dir' ? selectedEntry.relPath : parentOf(selectedEntry.relPath);
      pasteInto(dest);
    }
  });
```

- [ ] **Step 5: 收 filesOpDone、廣播搬家事件**

`window.addEventListener('message', ...)` 裡 `dirListings` 分支之後加：

```js
    // 檔案操作完成：剪下態清除（僅 move 成功時），改名/搬家的結果廣播給
    // 編輯器 remap 標籤。複製態保留——可以在別處再粘一次。
    if (msg.type === 'filesOpDone') {
      if (msg.op === 'move' && clipboard && clipboard.op === 'cut') clipboard = null;
      for (const r of msg.results) {
        if (r.ok && r.to && (msg.op === 'rename' || msg.op === 'move')) {
          window.dispatchEvent(new CustomEvent('nf-files-moved', { detail: { from: r.from, to: r.to } }));
        }
      }
      // 不清空 pending：已有結果的目錄保持顯示，只標記待重新整理，避免閃「載入中」。
      for (const dir of openDirs) pending.add(dir);
      requestDirs();
      render();
      return;
    }
```

- [ ] **Step 6: standalone.css 樣式**

檔案末尾追加：

```css
/* 檔案頁：剪下源壓暗；行可聚焦（Ctrl+X/C/V 的作用物件）。 */
.fx-row.fx-cut { opacity: 0.55; }
.fx-row:focus { outline: 1px solid rgba(128, 128, 128, 0.6); outline-offset: -1px; }
```

- [ ] **Step 7: smoke-view.js 斷言**

檔案末尾（最後一個 explorer 小節之後）新增小節。`mountExplorer()` 已同時裝載 view.js + editor.js + explorer.js：

```js
console.log('\n== 檔案頁：剪貼簿與右鍵選單 ==');
{
  const ui = mountExplorer();
  const written = [];
  ui.window.navigator.clipboard = { writeText: (t) => { written.push(t); return Promise.resolve(); } };
  ui.doc.getElementById('pane-files').classList.add('active');
  const rightClick = (node) => {
    node.dispatchEvent(new ui.window.MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 60 }));
    return ui.doc.querySelector('.ctx-menu');
  };
  const itemsOf = (menu) => [...menu.querySelectorAll('button')].map((b) => b.textContent);
  const btn = (menu, label) => [...menu.querySelectorAll('button')].find((b) => b.textContent === label);
  const clickEl = (node) => node.dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
  const last = (type) => [...ui.sent].reverse().find((m) => m.type === type);

  ui.post({ type: 'dirListings', listings: [ui.listing('', { '子目錄': 'dir', 'a.md': 'file' })] });
  const fileRow = ui.rows().find((r) => r.textContent.includes('a.md'));
  const dirRow = ui.rows().find((r) => r.textContent.includes('子目錄'));

  const fileItems = itemsOf(rightClick(fileRow));
  check('檔案行選單含剪下/複製/貼上/重新命名',
    ['剪下', '複製', '貼上', '重新命名'].every((l) => fileItems.includes(l)), JSON.stringify(fileItems));
  check('沒有剪貼簿時貼上置灰', btn(rightClick(fileRow), '貼上').disabled);
  closeAnyMenu(ui);

  // 複製：內部登記 + 路徑外送系統剪貼簿。
  clickEl(btn(rightClick(fileRow), '複製'));
  check('複製把路徑寫進系統剪貼簿', written.includes('a.md'), JSON.stringify(written));
  check('貼上變為可用', !btn(rightClick(fileRow), '貼上').disabled);
  closeAnyMenu(ui);

  // 在資料夾行上貼上：落點是該資料夾。
  clickEl(btn(rightClick(dirRow), '貼上'));
  const pasteMsg = last('fileAction');
  check('貼上發 fileAction',
    pasteMsg && pasteMsg.action === 'paste' && pasteMsg.op === 'copy' &&
    pasteMsg.relPaths.join(',') === 'a.md' && pasteMsg.targetDir === '子目錄',
    JSON.stringify(pasteMsg));

  // 複製態在貼上後保留（可再粘）；重新命名走 renameAny。
  check('複製態貼上後保留', !btn(rightClick(fileRow), '貼上').disabled);
  clickEl(btn(rightClick(fileRow), '重新命名'));
  const ren = last('fileAction');
  check('重新命名發 renameAny', ren && ren.action === 'renameAny' && ren.relPath === 'a.md', JSON.stringify(ren));

  // 剪下 + move 完成後清除剪下態。
  clickEl(btn(rightClick(fileRow), '剪下'));
  check('剪下後行帶 fx-cut 標記',
    ui.rows().some((r) => r.classList.contains('fx-cut')));
  ui.post({ type: 'filesOpDone', op: 'move', results: [{ from: 'a.md', to: '子目录/a.md', ok: true }] });
  check('move 完成後剪下態清除', btn(rightClick(dirRow), '貼上').disabled);
  closeAnyMenu(ui);

  // 快捷鍵：焦點行上 Ctrl+C。
  ui.post({ type: 'dirListings', listings: [ui.listing('', { 'b.md': 'file' })] });
  const bRow = ui.rows().find((r) => r.textContent.includes('b.md'));
  bRow.dispatchEvent(new ui.window.FocusEvent('focus', { bubbles: true }));
  ui.doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }));
  check('Ctrl+C 複製焦點行', written.includes('b.md'), JSON.stringify(written));
}
```

注意：`FocusEvent` 在 jsdom 中可用；explorer 的 focus 監聽不帶 preventDefault 需求。若 jsdom 版本對 `FocusEvent` 構造報錯，退化為 `new ui.window.Event('focus', { bubbles: true })`。

- [ ] **Step 8: 驗證**

Run: `node scripts/smoke-view.js`
Expected: 全部通過

- [ ] **Step 9: Commit**

```powershell
git add media/explorer.js media/standalone.css scripts/smoke-view.js
git commit -m "feat: 檔案頁剪下/複製/貼上/重新命名與 Ctrl+X/C/V"
```

---

### Task 11: editor.js 標籤選單、正文區選單、標籤搬家

**Files:**
- Modify: `media/editor.js`
- Modify: `scripts/smoke-view.js`

- [ ] **Step 1: 選單引擎引用**

`const toast = ...` 之後插入：

```js
  // view.js 的右鍵選單登記表。獨立版裡 view.js 先載入，必有；兜底成
  // 「不登記」只是讓選單缺席，不影響編輯主流程。
  const onCtx = window.__nfContextMenu || ((node) => node);
```

- [ ] **Step 2: 標籤頁右鍵選單**

`createPane` 的 `renderTabs` 裡，`tab.addEventListener('auxclick', ...)` 之後插入：

```js
        onCtx(tab, () => tabMenuItems(file.path));
```

`renderTabs` 函式之後新增：

```js
    /**
     * 標籤右鍵選單：關閉當前/左側/右側/其它。
     * 批次關閉**逐個確認**：每個髒標籤各問一次，取消哪個跳過哪個、繼續其餘。
     */
    function tabMenuItems(anchor) {
      const order = [...files.keys()];
      const idx = order.indexOf(anchor);
      const left = order.slice(0, idx);
      const right = order.slice(idx + 1);
      const closeMany = (paths) => {
        for (const p of paths) closeFile(p);
      };
      const items = [{ label: '關閉', run: () => closeFile(anchor) }];
      if (left.length > 0) items.push({ label: `關閉左側（${left.length}）`, run: () => closeMany(left) });
      if (right.length > 0) items.push({ label: `關閉右側（${right.length}）`, run: () => closeMany(right) });
      if (left.length + right.length > 0) {
        items.push({ label: `關閉其它（${left.length + right.length}）`, run: () => closeMany([...left, ...right]) });
      }
      return items;
    }
```

標籤條空白處（右鍵時以當前啟用標籤為準）——在 `createPane` 內、`renderTabs` 登記之外的任意位置（比如 `el.area` 監聽器附近）加一次：

```js
    onCtx(el.tabs, () => (pane.activePath ? tabMenuItems(pane.activePath) : []));
```

- [ ] **Step 3: 正文區右鍵選單**

`createPane` 內（與上一步相鄰處）：

```js
    // 正文區選單：預覽模式沒有可編輯內容，provider 返回空陣列即不彈。
    onCtx(el.area, () => {
      if (pane.previewMode) return [];
      const hasSel = el.area.selectionStart !== el.area.selectionEnd;
      return [
        { label: '剪下', disabled: !hasSel, run: () => areaCut() },
        { label: '複製', disabled: !hasSel, run: () => areaCopy() },
        { label: '貼上', run: () => areaPaste() },
        { sep: true },
        { label: '全選', run: () => { el.area.focus(); el.area.select(); } },
      ];
    });
```

編輯動作放在 createPane 工廠**外部**（與 countWords 等並列的模組級函式，textarea 由呼叫者傳入）：

```js
  /**
   * 正文區的剪下/複製/貼上。優先 execCommand——它保留 textarea 的
   * 原生撤銷棧；Clipboard API 作為讀剪貼簿的正路（貼上）與兜底（複製）。
   */
  function areaCopy(area) {
    area.focus();
    if (document.execCommand && document.execCommand('copy')) return;
    const text = area.value.slice(area.selectionStart, area.selectionEnd);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => toast('複製失敗，請手動選中複製。', true));
    } else {
      toast('當前環境不支援剪貼簿。', true);
    }
  }

  function areaCut(area) {
    area.focus();
    if (document.execCommand && document.execCommand('cut')) return;
    // 兜底：先複製再手動刪選區。
    areaCopy(area);
    const s = area.selectionStart;
    const e = area.selectionEnd;
    area.value = area.value.slice(0, s) + area.value.slice(e);
    area.selectionStart = area.selectionEnd = s;
    area.dispatchEvent(new Event('input'));
  }

  async function areaPaste(area) {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      toast('當前環境不支援剪貼簿讀取。', true);
      return;
    }
    let text;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      toast('貼上失敗：瀏覽器未授權剪貼簿讀取。', true);
      return;
    }
    area.focus();
    // insertText 保留撤銷棧；不支援時退回手動拼接（丟撤銷，但能貼上）。
    if (document.execCommand && document.execCommand('insertText', false, text)) return;
    const s = area.selectionStart;
    const e = area.selectionEnd;
    area.value = area.value.slice(0, s) + text + area.value.slice(e);
    area.selectionStart = area.selectionEnd = s + text.length;
    area.dispatchEvent(new Event('input'));
  }
```

選單登記處的三個 run 相應改為 `() => areaCut(el.area)` / `() => areaCopy(el.area)` / `() => areaPaste(el.area)`。

- [ ] **Step 4: 標籤搬家（改名/移動後不丟草稿）**

模組級（`window.addEventListener('message', ...)` 之前）：

```js
  /**
   * explorer.js 在 rename/move 成功後廣播的搬家事件：把舊標籤連同
   * 未儲存草稿整體挪到新路徑。
   *
   * 走 pendingDrafts 的 `moved` 標記繞開 hash 相等檢查——改名後
   * 檔案的 hash 基線必然變化，但草稿本身沒有理由丟。
   */
  window.addEventListener('nf-files-moved', (event) => {
    const from = event.detail && event.detail.from;
    const to = event.detail && event.detail.to;
    if (!from || !to) return;
    const pane = paneOwning(from);
    if (!pane) return;
    const file = pane.files.get(from);
    const carry = file.draft !== file.text ? { hash: file.hash, draft: file.draft, moved: true } : undefined;
    pane.closeSilently(from);
    rekeyStorage(from, to);
    if (carry) pendingDrafts.set(to, carry);
    pendingActive.set(pane.id, to);
    vscode.postMessage({ type: 'openEditor', path: to, pane: pane.id });
  });

  /** 重新整理恢復用的 localStorage 裡，舊路徑條目改寫成新路徑，草稿不丟。 */
  function rekeyStorage(from, to) {
    try {
      const data = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (!data || !data.panes) return;
      for (const paneData of Object.values(data.panes)) {
        if (!paneData || !Array.isArray(paneData.open)) continue;
        for (const item of paneData.open) {
          if (item && item.path === from) item.path = to;
        }
        if (paneData.active === from) paneData.active = to;
      }
      localStorage.setItem(STORE_KEY, JSON.stringify(data));
    } catch {
      /* 讀不下/寫不進都無所謂，最壞退化為丟一次重新整理恢復 */
    }
  }
```

`upsertFile` 裡的草稿恢復判斷加 `moved` 豁免（約第 470 行）：

```js
        if (restore && restore.draft !== undefined) {
          // moved：檔案剛改名/搬家，hash 基線必然變了，草稿照貼；
          // 其餘情況（重新整理恢復）仍要求磁碟沒變過。
          if (restore.moved || restore.hash === incoming.hash) {
            file.draft = restore.draft;
          } else {
            toast(`「${file.name}」在離開期間被改過，已放棄未儲存的草稿。`, true);
          }
        }
```

- [ ] **Step 5: smoke-view.js 斷言**

用 `mountExplorer()`（三指令碼齊備）。新增小節：

```js
console.log('\n== 內建編輯器：右鍵選單與標籤搬家 ==');
{
  const ui = mountExplorer();
  const rightClick = (node) => {
    node.dispatchEvent(new ui.window.MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 60 }));
    return ui.doc.querySelector('.ctx-menu');
  };
  const itemsOf = (menu) => [...menu.querySelectorAll('button')].map((b) => b.textContent);
  const btn = (menu, label) => [...menu.querySelectorAll('button')].find((b) => b.textContent === label);
  const clickEl = (node) => node.dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
  const tabs = () => [...ui.doc.querySelectorAll('.ed-tab')];

  ui.post({ type: 'editorOpen', file: ui.file('a.md', '甲的內容') });
  ui.post({ type: 'editorOpen', file: ui.file('b.md', '乙的內容') });
  check('開啟了兩個標籤', tabs().length === 2, String(tabs().length));

  // ---- 標籤選單
  const tabMenu = rightClick(tabs()[0]);
  check('標籤選單四項齊全',
    itemsOf(tabMenu).some((l) => l === '關閉') &&
    itemsOf(tabMenu).some((l) => l.startsWith('關閉右側')) &&
    itemsOf(tabMenu).some((l) => l.startsWith('關閉其它')),
    JSON.stringify(itemsOf(tabMenu)));
  clickEl(btn(rightClick(tabs()[0]), itemsOf(rightClick(tabs()[0])).find((l) => l.startsWith('關閉其它'))));
  check('關閉其它後只剩一個標籤', tabs().length === 1, String(tabs().length));
  closeAnyMenu(ui);

  // ---- 正文區選單
  const area = ui.doc.getElementById('edArea');
  const areaMenu = rightClick(area);
  check('正文區選單含剪下/複製/貼上/全選',
    ['剪下', '複製', '貼上', '全選'].every((l) => itemsOf(areaMenu).includes(l)),
    JSON.stringify(itemsOf(areaMenu)));
  check('無選中時剪下/複製置灰',
    btn(areaMenu, '剪下').disabled && btn(areaMenu, '複製').disabled);
  clickEl(btn(rightClick(area), '全選'));
  check('全選選中全文', area.selectionStart === 0 && area.selectionEnd === area.value.length,
    `${area.selectionStart}-${area.selectionEnd}/${area.value.length}`);
  closeAnyMenu(ui);

  // ---- 標籤搬家：未儲存草稿原樣帶走
  area.value = '甲的內容，改了一半';
  area.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  ui.window.dispatchEvent(new ui.window.CustomEvent('nf-files-moved', { detail: { from: 'a.md', to: 'sub/a.md' } }));
  const reopen = [...ui.sent].reverse().find((m) => m.type === 'openEditor' && m.path === 'sub/a.md');
  check('搬家後請求開啟新路徑', !!reopen && reopen.pane === 'main', JSON.stringify(reopen));
  // hash 變了也沒關係：moved 標記豁免基線檢查。
  ui.post({ type: 'editorOpen', file: Object.assign(ui.file('sub/a.md', '甲的內容'), { hash: 'h-other' }) });
  check('搬家後只剩一個標籤且是新路徑', tabs().length === 1 && tabs()[0].textContent.includes('a'),
    tabs().map((t) => t.textContent).join(','));
  check('未儲存草稿跟著搬', ui.doc.getElementById('edArea').value === '甲的內容，改了一半',
    ui.doc.getElementById('edArea').value);
  check('草稿仍是髒標記', tabs()[0].classList.contains('dirty'));
}
```

- [ ] **Step 6: 驗證**

Run: `node scripts/smoke-view.js`
Expected: 全部通過

- [ ] **Step 7: Commit**

```powershell
git add media/editor.js scripts/smoke-view.js
git commit -m "feat: 編輯器標籤右鍵選單、正文區剪下複製貼上與標籤搬家"
```

---

### Task 12: AGENTS.md 約束脩訂 + 全量驗證

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: 修訂行為約束 #7**

`AGENTS.md` 「必須遵守的行為約束」第 7 條改為：

```markdown
7. **檔案訪問不越界**：工程頁的類檔案操作鎖在章節/角色/設定三個區內（`core/fileOps.ts` 的 `normalizeRel` / `sectionOf`）；獨立版的讀寫另有一層——路徑落在工程根內、大小上限、以及「純文字副檔名白名單 ∪ 章節檔名規則」，全在 `fileEditing.ts` 裡兜住。獨立版「檔案」頁的寫入口只經 `core/projectFiles.ts`（重新命名/移動/複製鎖在工程根內、`chapters/`、`drafts/`、`.novelforge` 等固定目錄受保護、同名絕不覆蓋、`.trash` 內容不可操作），目錄列舉（`core/fileTree.ts`）仍只讀。服務無鑑權（只綁 127.0.0.1），別在別處繞過這幾處直接讀寫。
```

- [ ] **Step 2: 模組地圖補一行**

「模組地圖」表裡 `src/core/` 行的職責描述末尾追加「工程根範圍檔案操作 projectFiles.ts」，即：

```markdown
| `src/core/` | 核心邏輯層入口（含協議 protocol.ts、工程頁快照 projectView.ts、出場人物索引 cast.ts、資源管理器目錄列舉 fileTree.ts、類檔案操作 fileOps.ts、工程根範圍檔案操作 projectFiles.ts、日誌 logger.ts、長任務 progress.ts） | [src/core/README.md](src/core/README.md) |
```

若 `src/core/README.md` 內有檔案清單，同步把 projectFiles.ts 補進去（一行的事）。

- [ ] **Step 3: 全量驗證**

Run: `npm test`
Expected: typecheck 零錯誤、check-core-purity 通過、全部十二個冒煙測試通過（含新增 smoke-projectFiles）。

- [ ] **Step 4: 手動驗證清單**

起獨立版：`npm run standalone`，瀏覽器開啟後逐項過：

1. 編輯器：開兩三個檔案 → 標籤右鍵四項齊全，關閉其它時髒標籤逐個確認；正文區右鍵剪下/複製/貼上/全選可用，Ctrl+Z 能撤銷貼上。
2. 檔案頁：檔案/資料夾右鍵四項齊全；Ctrl+C 後行尾 toast；資料夾上貼上落點正確；改名一個開著的檔案，編輯器標籤跟到新路徑且未儲存內容不丟。
3. 工程頁：角色分組右鍵兩個批次項；「更新所有」彈總確認（卡數/章數/次數/跳過明細），逐張確認與全部直接採納各跑一遍。
4. 外掛形態 F5：工程頁角色分組選單同樣出現（view.js 雙形態共享），點選走 VS Code 的彈窗。

- [ ] **Step 5: Commit**

```powershell
git add AGENTS.md src/core/README.md
git commit -m "docs: 修訂約束 #7，檔案頁寫入口收斂到 projectFiles"
```

---

## 收尾

全部任務完成後：

1. `npm test` 最後一次全綠確認。
2. `git log --oneline` 過一遍提交序列，確認每個 commit 獨立可回滾。
3. 若手動驗證發現問題，回到對應 Task 修復並重跑該任務的驗證命令。
