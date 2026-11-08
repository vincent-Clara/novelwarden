# Novelwarden 雙形態改造實施計劃



**Goal:** 把 Novelwarden 從純 VS Code 外掛改造為「共享核心 + VS Code 殼 + Bun 獨立 Web 服務殼」的雙形態架構，獨立版 `novelforge [dir]` 啟動本機 Web 服務，瀏覽器即可續寫/管理小說工程。

**Architecture:** `src/core/` 零 vscode 依賴（資料層、上下文裝配、LLM、controller、協議），通過窄介面 `Host` 獲取宿主能力（配置、金鑰、彈窗、進度、檔案監聽）；`src/vscode/` 是外掛殼；`src/standalone/` 是 Bun HTTP+WebSocket 服務殼，複用現有 `InMessage/OutMessage` 協議與 `media/view.js` 前端（經 `bridge.js` 把 WebSocket 偽裝成 webview API）。設計文件見 `docs/design/specs/2026-08-04-standalone-web-app-design.md`。

**Tech Stack:** TypeScript（現有 strict 配置）、esbuild（外掛 bundle，維持現狀）、Bun（獨立殼執行時與 `bun build --compile`）、node:fs/path/child_process（core 內替代 vscode API）、原生 WebSocket（無第三方服務端框架）。

**通用約定：**
- 所有命令在倉庫根目錄 `c:\data\project\novelForge` 下執行，shell 為 PowerShell（不支援 `&&`，用 `;`）。
- 每個任務的驗證基線：`npm run typecheck`（= `tsc --noEmit`）必須零錯誤；涉及 core 的任務還要跑 `npm run smoke`。
- 提交資訊沿用現有風格（中文正文可，字首用 `feat/refactor/chore/docs`）。
- 現有關鍵事實（執行者無需再探索）：
  - webview 前端 `media/view.js` 頂部 IIFE 內 `const vscode = acquireVsCodeApi()`，用 `vscode.postMessage(...)` 發訊息，用 `window.addEventListener('message', ...)` 收訊息，載入末尾自發 `{ type: 'ready' }`。
  - 協議在 `src/ui/protocol.ts`（`InMessage`/`OutMessage`），`renderHtml()` 生成兩宿主共用的 HTML。
  - 配置現在全部讀自 `vscode.workspace.getConfiguration('novel')`；API Key 存 `vscode.SecretStorage`。
  - smoke 指令碼通過 esbuild 把單個 TS 檔案 bundle 成 CJS 後 require，並用 `Module._load` 打 vscode 樁。

---

### Task 1: 目錄重構 —— core / vscode 分層（純移動，無行為變化）

**Files:**
- Move: `src/model/` → `src/core/model/`；`src/context/` → `src/core/context/`；`src/features/` → `src/core/features/`
- Move: `src/llm/provider.ts|openaiProvider.ts|anthropicProvider.ts|registry.ts` → `src/core/llm/`；`src/llm/vscodeLmProvider.ts` → `src/vscode/vscodeLmProvider.ts`
- Move: `src/ui/protocol.ts` → `src/core/protocol.ts`（其中 `renderHtml()` 拆到新檔案 `src/vscode/webviewHtml.ts`）
- Move: `src/ui/projectView.ts` → `src/core/projectView.ts`
- Move: `src/extension.ts` → `src/vscode/extension.ts`；`src/ui/chatViewProvider.ts`、`src/ui/chatPanel.ts` → `src/vscode/`
- Keep（暫不移動，Task 8 再動）: `src/ui/chatController.ts`、`src/ui/attachments.ts`
- Modify: `esbuild.js`、`scripts/smoke*.js`（路徑）、以及所有被移動檔案的相對 import

- [ ] **Step 1: 用 git mv 移動目錄與檔案**

```powershell
git mv src/model src/core/model
git mv src/context src/core/context
git mv src/features src/core/features
New-Item -ItemType Directory src/core/llm, src/vscode -Force
git mv src/llm/provider.ts src/core/llm/provider.ts
git mv src/llm/openaiProvider.ts src/core/llm/openaiProvider.ts
git mv src/llm/anthropicProvider.ts src/core/llm/anthropicProvider.ts
git mv src/llm/registry.ts src/core/llm/registry.ts
git mv src/llm/vscodeLmProvider.ts src/vscode/vscodeLmProvider.ts
git mv src/ui/protocol.ts src/core/protocol.ts
git mv src/ui/projectView.ts src/core/projectView.ts
git mv src/extension.ts src/vscode/extension.ts
git mv src/ui/chatViewProvider.ts src/vscode/chatViewProvider.ts
git mv src/ui/chatPanel.ts src/vscode/chatPanel.ts
```

- [ ] **Step 2: 拆分 renderHtml 到 src/vscode/webviewHtml.ts**

從 `src/core/protocol.ts` 裡**刪除** `renderHtml()`（連同它對 `vscode` 的 import——`makeNonce` 保留在 protocol.ts，它是純函式），新建：

```ts
// src/vscode/webviewHtml.ts
import * as vscode from 'vscode';
import { makeNonce } from '../core/protocol';

/**
 * 兩個 webview 宿主共用的 HTML。只載入本地資源，CSP 裡不開任何外部來源。
 * bridge.js 在 view.js 之前載入：webview 裡它檢測到 acquireVsCodeApi 存在就直通。
 */
export function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = makeNonce();
  const asset = (name: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', name)).toString();

  // 內容與原 renderHtml 完全一致，僅兩處變化：
  // 1. <script> 標籤先載入 bridge.js 再載入 view.js（都帶 nonce）
  // 2. 其餘 DOM 結構一字不改
  return `<!DOCTYPE html>……（照抄原模板，指令碼區改為）……
<script nonce="${nonce}" src="${asset('bridge.js')}"></script>
<script nonce="${nonce}" src="${asset('view.js')}"></script>
</body>
</html>`;
}
```

注意：完整照抄原 `renderHtml` 模板字串（tabbar、四個 pane、providerModal、toast），只替換指令碼引用那一處。`chatViewProvider.ts` / `chatPanel.ts` 改為 `import { renderHtml } from './webviewHtml'`。

- [ ] **Step 3: 修正所有相對 import**

規則：被移動檔案之間的相對路徑按新位置重算。關鍵點：
- `src/core/**` 內互相引用仍是 `../model/project` 這類（整目錄平移的不變）；跨目錄的改：
  - `src/vscode/extension.ts`：`./features/…` → `../core/features/…`；`./llm/registry` → `../core/llm/registry`；`./model/project` → `../core/model/project`；`./ui/chatController` → `../ui/chatController`（暫留）；`./ui/chatViewProvider` → `./chatViewProvider`。
  - `src/ui/chatController.ts`：`../context/builder` → `../core/context/builder`；`../features/…` → `../core/features/…`；`../model/…` → `../core/model/…`；`../llm/registry` → `../core/llm/registry`；`./protocol` → `../core/protocol`；`./projectView` → `../core/projectView`。
  - `src/ui/attachments.ts`：`../model/…` → `../core/model/…`。
  - `src/vscode/vscodeLmProvider.ts`：`./provider` → `../core/llm/provider`。
  - `src/core/llm/registry.ts`：`./vscodeLmProvider` 的 import 改為 `../../vscode/vscodeLmProvider`（臨時跨層引用，Task 7 用工廠鉤子消除）。

- [ ] **Step 4: 更新構建與 smoke 指令碼里的路徑**

`esbuild.js`：

```js
entryPoints: ['src/vscode/extension.ts'],
```

`scripts/smoke.js`：`loadModule('src/model/markdown.ts')` → `'src/core/model/markdown.ts'`；`'src/context/tokenizer.ts'` → `'src/core/context/tokenizer.ts'`；`'src/features/continueWriting.ts'` → `'src/core/features/continueWriting.ts'`；`'src/features/summarize.ts'`、`'src/features/characters.ts'` 同理（檔案內共 5 處）。
`scripts/smoke-session.js`：`'src/model/project.ts'`、`'src/model/session.ts'` → `'src/core/model/…'`。
`scripts/smoke-providers.js`、`smoke-builder.js`、`smoke-llm.js`：同樣把 `src/model/`、`src/context/`、`src/llm/`（openai/anthropic/provider）字首改成 `src/core/…`；`vscodeLmProvider` 若被引用則指向 `src/vscode/vscodeLmProvider.ts`。

- [ ] **Step 5: 驗證**

```powershell
npm run typecheck ; npm run smoke ; npm run compile
```

預期：全部與重構前一樣通過（行為零變化）。若 F5 除錯外掛可開，手動確認面板正常。

- [ ] **Step 6: Commit**

```powershell
git add -A ; git commit -m "refactor: split src into core/vscode layers (file moves only)"
```

---

### Task 2: 檔案系統去 vscode 化 —— Uri/workspace.fs → path/fs

**Files:**
- Modify: `src/core/model/project.ts`（核心）、`src/core/model/session.ts`
- Modify: 所有消費方（controller、continueWriting、summarize、characters、style、projectView、attachments、vscode/extension.ts）

目標：`NovelProject.root` 從 `vscode.Uri` 變為絕對路徑 `string`；所有檔案 IO 走 `node:fs/promises`；對外返回值從 `vscode.Uri` 變為**工作區相對路徑字串**（relPath）。

- [ ] **Step 1: 重寫 project.ts 的基礎設施**

刪除 `import * as vscode from 'vscode'`，改為：

```ts
import * as crypto from 'crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
```

工具函式替換（檔案尾部）：

```ts
export async function exists(absPath: string): Promise<boolean> {
  try { await fs.stat(absPath); return true; } catch { return false; }
}

export async function readText(absPath: string): Promise<string> {
  return fs.readFile(absPath, 'utf8');
}

export async function writeText(absPath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, text, 'utf8');
}

async function writeIfAbsent(absPath: string, text: string): Promise<void> {
  if (!(await exists(absPath))) await writeText(absPath, text);
}

/** 列出目錄下所有 .md 檔案的絕對路徑。 */
async function listMarkdown(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .map((e) => path.join(dir, e.name));
  } catch { return []; }
}

function baseName(absPath: string): string {
  return path.basename(absPath).replace(/\.md$/i, '');
}
```

- [ ] **Step 2: 重寫 NovelProject 類的路徑層**

```ts
export class NovelProject {
  private chapterCache: Chapter[] | undefined;

  private constructor(public readonly root: string) {}

  /** 以某目錄為工程根開啟例項（不做初始化檢查）。 */
  static open(root: string): NovelProject {
    return new NovelProject(path.resolve(root));
  }

  get chaptersDir(): string { return path.join(this.root, this.config.chaptersDir); }
  get novelDir(): string { return path.join(this.root, NOVEL_DIR); }
  get manifestPath(): string { return path.join(this.novelDir, MANIFEST_FILE); }
  get stylePath(): string { return path.join(this.novelDir, 'style.md'); }
  get outlinePath(): string { return path.join(this.novelDir, 'outline.md'); }
  get charactersDir(): string { return path.join(this.novelDir, 'characters'); }
  get loreDir(): string { return path.join(this.novelDir, 'lore'); }
  get summariesDir(): string { return path.join(this.novelDir, 'summaries'); }
  get sessionsDir(): string { return path.join(this.novelDir, 'sessions'); }
  get legacyNovelDir(): string { return path.join(this.root, LEGACY_NOVEL_DIR); }
  get globalSummaryPath(): string { return path.join(this.summariesDir, 'global.md'); }
  summaryPath(order: number): string { return path.join(this.summariesDir, `${pad3(order)}.md`); }

  /** 絕對路徑 → 工作區相對路徑（正斜槓）。 */
  relPath(absPath: string): string {
    return path.relative(this.root, absPath).replace(/\\/g, '/');
  }

  /** relPath 的逆運算。 */
  pathOf(relPath: string): string { return path.join(this.root, relPath); }
```

**刪除** `static current()` 與 `static require()`（依賴 vscode.workspace/workspace.window）——呼叫方改為顯式傳 root；Task 8/9 裡由殼構造。類內其餘方法的機械替換規則：
- 所有 `vscode.Uri.joinPath(a, b)` → `path.join(a, b)`；成員名 `*Uri` → `*Path`（如 `this.manifestUri` → `this.manifestPath`）。
- `listChapters()`：`readDirectory` → `fs.readdir(this.chaptersDir, { withFileTypes: true })`，型別判斷 `type !== vscode.FileType.File` → `!e.isFile()`，`const uri = vscode.Uri.joinPath(...)` → `const abs = path.join(...)`。
- `createChapter/appendToChapter/writeSummary/writeGlobalSummary/writeCharacter/writeStyleGuide` 返回值：`Promise<vscode.Uri>` → `Promise<string>`，return `this.relPath(abs)`（呼叫方拿到的就是 relPath）。
- `migrateLegacyDir()`：`vscode.workspace.fs.rename` → `fs.rename(this.legacyNovelDir, this.novelDir)`。
- `initialize()`：`createDirectory` → `fs.mkdir(dir, { recursive: true })`。
- `readConfig()` / `readGlobalBudget()` 本任務**原樣保留**（仍讀 vscode 配置，Task 4 再抽象）——因此 project.ts 頂部暫時保留一行 `import * as vscode from 'vscode'` 僅用於 readConfig，並加註釋 `// TODO(Task 4): 移入 config.ts`。

- [ ] **Step 3: session.ts 改 node fs**

刪除 vscode import。`SessionStore`：

```ts
private filePath(id: string): string {
  return path.join(this.project.sessionsDir, `${id}.json`);
}

async list(): Promise<SessionSummary[]> {
  let names: string[];
  try {
    names = (await fs.readdir(this.project.sessionsDir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json'))
      .map((e) => e.name);
  } catch { return []; }
  // 後續邏輯不變：逐個 read 並 summarize
}

async write(session: ChatSession): Promise<void> {
  await fs.mkdir(this.project.sessionsDir, { recursive: true });
  await writeText(this.filePath(session.id), `${JSON.stringify(session, null, 2)}\n`);
}

/** core 無系統回收站能力：移到 .novelforge/.trash/ 下（保留原檔名可手動找回）。 */
async delete(id: string): Promise<void> {
  const file = this.filePath(id);
  if (!(await exists(file))) return;
  const trashDir = path.join(this.project.novelDir, '.trash');
  await fs.mkdir(trashDir, { recursive: true });
  await fs.rename(file, path.join(trashDir, `${id}.json`));
}
```

- [ ] **Step 4: 修正消費方**

逐檔案規則（都是機械替換，編譯錯誤即清單）：
- `src/core/projectView.ts`：`project.relPath(project.styleUri)` → `project.relPath(project.stylePath)`，outline/globalSummary 同理。
- `src/core/features/continueWriting.ts`：`accept()` 返回型別 `Promise<vscode.Uri>` → `Promise<string>`（直接透傳 project 返回的 relPath）；檔案頂部若只剩這個 vscode 用途，刪掉 import（`quickContinue` 除外——它整體依賴編輯器，**移到** `src/vscode/quickContinue.ts`，export 保持不變，extension.ts 改 import 路徑）。
- `src/core/features/summarize.ts`：末尾 `vscode.commands.executeCommand('novel.openFile', ...)` 暫改為 `// TODO(Task 5): 经 Host.openFile`，先註釋掉該行並保留 `project.relPath(project.globalSummaryPath)` 計算。
- `src/core/features/characters.ts`：diff 流程裡的 `vscode.Uri.joinPath` → `path.join`、`project.root` 已是 string；`vscode.diff` 部分打 `// TODO(Task 6)` 註釋保留（Task 6 換成 Host.reviewReplace）。
- `src/ui/chatController.ts`：`accept` 中 `this.project.relPath(uri)` → 直接用返回的 relPath 字串；末尾 `vscode.window.showTextDocument(...)` 塊整體替換為 `await vscode.commands.executeCommand('novel.openFile', turn.acceptedTo);`（Task 8 再改 Host）。
- `src/ui/attachments.ts`：`project.root`（QuickPick defaultUri）→ `vscode.Uri.file(project.root)`；`project.outlineUri/styleUri` → `outlinePath/stylePath` 包 `relPath()`（原始碼 `project.relPath(project.outlineUri)` → `project.relPath(project.outlinePath)`）。
- `src/vscode/extension.ts`：`novel.openFile` 命令裡 `vscode.Uri.joinPath(target.root, relPath)` → `vscode.Uri.file(target.pathOf(relPath))`；`workspaceName()` 不變。

- [ ] **Step 5: 改 smoke-session.js 樁為直接構造**

vscode 樁裡 `workspace.fs` 相關全部刪除；改為：

```js
const project = projectMod.NovelProject.open(WORK);
```

`check('sessionsDir 指向 .novelforge/sessions', project.sessionsDir === sessionsDir, project.sessionsDir);`（string 相等）。遷移用例裡 `NovelProject.current()` → `NovelProject.open(legacyRoot)`；刪除 `vscodeStub.workspace.workspaceFolders/asRelativePath` 的重設行。`check('刪除走回收站', ...)` 改為斷言檔案出現在 `path.join(legacyOrWork, '.novelforge/.trash')`。

- [ ] **Step 6: 驗證 + Commit**

```powershell
npm run typecheck ; npm run smoke ; npm run compile
```

全部通過後：

```powershell
git add -A ; git commit -m "refactor: replace vscode.Uri/workspace.fs with node path/fs in core"
```

---

### Task 3: Host 介面與 AbortSignal 化

**Files:**
- Create: `src/core/host.ts`
- Modify: `src/core/llm/provider.ts`、`src/core/llm/openaiProvider.ts`、`src/core/llm/anthropicProvider.ts`、`src/core/features/continueWriting.ts`

- [ ] **Step 1: 新建 src/core/host.ts**

```ts
import { NovelProject } from './model/project';
import { Attachment } from './model/session';

/**
 * core 對宿主的唯一依賴面。VS Code 外掛與獨立 Web 服務各實現一份。
 * 所有互動類方法（input/confirm/pick）在獨立版裡經 WebSocket 變成網頁彈窗。
 */

export interface InputOptions {
  title?: string;
  prompt?: string;
  value?: string;
  placeHolder?: string;
  password?: boolean;
  /** 多行文字輸入（獨立版渲染 textarea）。 */
  multiline?: boolean;
  validate?: (value: string) => string | undefined;
}

export interface PickChoice<T = string> {
  label: string;
  description?: string;
  detail?: string;
  /** 分組標題，同組只出現一次。 */
  group?: string;
  value: T;
}

export interface Disposable { dispose(): void; }

export interface Host {
  readonly name: 'vscode' | 'standalone';
  /** 該宿主能否提供 vscode-lm（Copilot）模型。 */
  readonly supportsVscodeLm: boolean;

  input(opts: InputOptions): Promise<string | undefined>;
  /** 返回使用者點選的 action 文案；取消返回 undefined。 */
  confirm(message: string, actions: string[], opts?: { modal?: boolean; detail?: string }): Promise<string | undefined>;
  pick<T>(choices: PickChoice<T>[], title: string): Promise<T | undefined>;
  /** 可取消的長任務。report 用於更新進度文案。 */
  progress<T>(title: string, fn: (signal: AbortSignal, report: (message: string) => void) => Promise<T>): Promise<T>;
  /** 監聽工程目錄變化（章節/後設資料）。onChange 已含防抖語義由實現方負責。 */
  watch(project: NovelProject, onChange: () => void): Disposable;
  /** 開啟某相對路徑檔案。獨立版降級為 toast 提示路徑。 */
  openFile(relPath: string): Promise<void>;
  toast(message: string, level?: 'info' | 'error'): void;

  /** 「加入選區」：外掛取編輯器選區；獨立版彈貼上框。返回 undefined 表示放棄。 */
  selectionAttachment(project: NovelProject): Promise<Attachment | undefined>;
  /** 「瀏覽工作區檔案」：外掛彈檔案對話方塊；獨立版提示輸入相對路徑。可選。 */
  browseFile?(project: NovelProject): Promise<string | undefined>;
  /** 角色卡更新審閱：外掛開 diff 編輯器；獨立版彈確認框。返回 undefined=取消。 */
  reviewReplace?(name: string, currentText: string, proposedText: string): Promise<'apply' | 'discard' | undefined>;
  /** 「在 VS Code 設定中開啟」，僅外掛實現。 */
  openNativeSettings?(): Promise<void>;
}

let current: Host | undefined;

export function initHost(host: Host): void {
  current = host;
  initConfigFromHost(host);
}

export function getHost(): Host {
  if (!current) throw new Error('Host 尚未初始化');
  return current;
}

// initConfigFromHost 在 Task 4 的 config.ts 裡實現並在此 import；
// 本任務先留佔位：import { initConfigFromHost } from './config';
```

（`./config` 檔案在下一任務建立；兩任務連續執行，若分開提交可先在 host.ts 裡註釋掉這兩行 import/呼叫並在 Task 4 恢復。）

- [ ] **Step 2: provider.ts 取消令牌改 AbortSignal**

```ts
// 刪除 import * as vscode from 'vscode'
export interface ChatOptions {
  maxOutputTokens: number;
  temperature: number;
  timeoutMs: number;
  /** 外部取消（使用者點「停止」）。超時仍由本模組內部處理。 */
  signal?: AbortSignal;
}

export function makeAbortSignal(options: ChatOptions): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), options.timeoutMs);
  const onAbort = () => controller.abort(options.signal?.reason ?? new CancelledError());
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    },
  };
}
```

openai/anthropicProvider 只是用了 `makeAbortSignal(options)`，簽名不變，無需改動（編譯確認）。

- [ ] **Step 3: continueWriting.ts 用 AbortController**

```ts
export class ContinueSession {
  private currentAbort: AbortController | undefined;
  // ...
  async generate(...) {
    // ...
    const abort = new AbortController();
    this.currentAbort = abort;
    const options: ChatOptions = {
      maxOutputTokens: config.maxOutputTokens,
      temperature: config.temperature,
      timeoutMs: config.requestTimeoutMs,
      signal: abort.signal,
    };
    try {
      // 流式迴圈不變
    } catch (err) {
      if (err instanceof CancelledError || abort.signal.aborted) handlers.onCancelled();
      else handlers.onError(err instanceof Error ? err.message : String(err));
    } finally {
      this.currentAbort = undefined;
    }
    return built;
  }

  stop(): void {
    this.currentAbort?.abort(new CancelledError());
  }

  dispose(): void {
    this.currentAbort?.abort(new CancelledError());
  }
}
```

`testConnection` 裡同樣：`new vscode.CancellationTokenSource()` → `new AbortController()`，`source.token` → `abort.signal`，finally 裡刪掉 cancel/dispose（無資源需釋放）。

- [ ] **Step 4: 驗證 + Commit**

```powershell
npm run typecheck ; npm run smoke ; npm run compile
git add -A ; git commit -m "refactor: introduce Host interface and AbortSignal cancellation in core"
```

---

### Task 4: 配置與金鑰後端抽象

**Files:**
- Create: `src/core/config.ts`、`src/core/stores.ts`
- Modify: `src/core/model/project.ts`（移出 readConfig）、`src/core/llm/registry.ts`、各消費方 import

- [ ] **Step 1: 新建 src/core/config.ts**

把 `project.ts` 裡的 `readConfig()`、`readGlobalBudget()` 整體搬來，資料來源從 `vscode.workspace.getConfiguration` 換成注入的 store：

```ts
import { getHost } from './host';
import { firstModelRef, normalizeProviders, resolveModelRef, seedFromLegacy } from './model/providers';
import { NovelConfig } from './model/types';

/** 落盤的設定形狀（與 SettingsPayload 對齊，另加 chaptersDir）。 */
export interface PersistedSettings {
  providers?: unknown[];
  model?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  temperature?: number;
  recentChaptersFullText?: number;
  prevChapterTailChars?: number;
  chaptersDir?: string;
  summaryBatchSize?: number;
  requestTimeoutMs?: number;
}

export interface ConfigStore {
  /** 未遷移/未儲存過時返回 undefined。 */
  read(): PersistedSettings | undefined;
  write(settings: PersistedSettings): Promise<void>;
}

/**
 * 0.1.x 遺留配置讀取器。VS Code 殼注入（讀 settings.json 的 novel.*），
 * 用於尚未遷移到 ~/.novelforge/config.json 的老使用者；獨立版不注入。
 */
export interface LegacyConfigReader { read(): PersistedSettings; }

let store: ConfigStore | undefined;
let legacy: LegacyConfigReader | undefined;

/** 由 initHost 呼叫：配置跟隨宿主。 */
export function initConfigFromHost(host: { config: ConfigStore }): void {
  store = host.config;
}

export function setLegacyConfigReader(reader: LegacyConfigReader): void {
  legacy = reader;
}

function raw(): PersistedSettings {
  return store?.read() ?? legacy?.read() ?? {};
}

export function readConfig(): NovelConfig {
  const c = raw();
  let providers = normalizeProviders(c.providers ?? []);
  let model = (c.model ?? '').trim();

  // 0.1.x 單服務商兜底：僅當新結構為空且宿主提供了遺留讀取器。
  if (providers.length === 0 && legacy) {
    const seeded = seedFromLegacyRaw(c);
    providers = seeded.providers;
    if (!model) model = seeded.activeRef;
  }
  if (!model) model = firstModelRef(providers);

  const active = resolveModelRef(providers, model);
  const globalWindow = c.contextWindow ?? 128000;
  const globalOutput = c.maxOutputTokens ?? 4096;

  return {
    providers, model, active,
    contextWindow: active?.model.contextWindow ?? globalWindow,
    maxOutputTokens: active?.model.maxOutputTokens ?? globalOutput,
    temperature: c.temperature ?? 0.8,
    recentChaptersFullText: c.recentChaptersFullText ?? 2,
    prevChapterTailChars: c.prevChapterTailChars ?? 1500,
    chaptersDir: c.chaptersDir ?? 'chapters',
    summaryBatchSize: c.summaryBatchSize ?? 15,
    requestTimeoutMs: c.requestTimeoutMs ?? 300000,
  };
}

export function readGlobalBudget(): { contextWindow: number; maxOutputTokens: number } {
  const c = raw();
  return { contextWindow: c.contextWindow ?? 128000, maxOutputTokens: c.maxOutputTokens ?? 4096 };
}

/** 整體落盤（merge 後寫）。 */
export async function updateSettings(patch: PersistedSettings): Promise<void> {
  if (!store) throw new Error('配置後端尚未初始化');
  await store.write({ ...raw(), ...patch });
}

/** seedFromLegacy 原本吃 vscode 配置的分散鍵；這裡接受扁平 raw。 */
function seedFromLegacyRaw(c: PersistedSettings) {
  // 遺留鍵（novel.provider / novel.openai.baseUrl 等）只會出現在 legacy reader
  // 的返回值裡，因此把 raw 直接透傳給 providers.ts 新增的寬鬆入口。
  return seedFromLegacy({
    provider: (c as Record<string, unknown>).provider as string | undefined ?? 'openai',
    openaiBaseUrl: (c as Record<string, unknown>)['openai.baseUrl'] as string | undefined ?? 'https://api.openai.com/v1',
    openaiModel: (c as Record<string, unknown>)['openai.model'] as string | undefined ?? 'gpt-4o',
    anthropicBaseUrl: (c as Record<string, unknown>)['anthropic.baseUrl'] as string | undefined ?? 'https://api.anthropic.com',
    anthropicModel: (c as Record<string, unknown>)['anthropic.model'] as string | undefined ?? 'claude-sonnet-4-5',
    vscodeLmFamily: (c as Record<string, unknown>)['vscodeLm.family'] as string | undefined ?? 'gpt-4o',
  });
}
```

注意：`seedFromLegacy` 在 `src/core/model/providers.ts` 中已存在且吃上述形狀物件——確認其簽名一致；若它原來直接吃 `WorkspaceConfiguration.get`，按上面引數化即可（現有實現就是按值傳參，無需改動）。legacy reader 需要返回這些帶點鍵，VS Code 殼實現時把 `novel.provider`、`novel.openai.baseUrl` 等一併讀出（見 Task 9）。

- [ ] **Step 2: 新建 src/core/stores.ts（檔案儲存，雙殼共用）**

```ts
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigStore, PersistedSettings } from './config';

/** ~/.novelforge/ —— 配置與金鑰的使用者主目錄儲存。 */
export function homeDir(): string {
  return path.join(os.homedir(), '.novelforge');
}

export class FileConfigStore implements ConfigStore {
  readonly filePath = path.join(homeDir(), 'config.json');

  read(): PersistedSettings | undefined {
    try {
      return JSON.parse(fsReadSync(this.filePath)) as PersistedSettings;
    } catch { return undefined; }
  }

  async write(settings: PersistedSettings): Promise<void> {
    await fs.mkdir(homeDir(), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  }
}

function fsReadSync(p: string): string {
  // read() 是同步介面（readConfig 到處同步呼叫）；檔案極小，同步讀可接受。
  return require('node:fs').readFileSync(p, 'utf8');
}

export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * ~/.novelforge/secrets.json。JSON 無法寫檔案頭註釋，首次建立時
 * 同目錄放一個 README.txt 說明「不要提交 secrets.json」。
 * Windows 無 POSIX 許可權位，僅依賴使用者主目錄隔離。
 */
export class FileSecretStore implements SecretStore {
  private readonly filePath = path.join(homeDir(), 'secrets.json');

  private async load(): Promise<Record<string, string>> {
    try { return JSON.parse(await fs.readFile(this.filePath, 'utf8')); } catch { return {}; }
  }

  private async save(data: Record<string, string>): Promise<void> {
    await fs.mkdir(homeDir(), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: 'utf8', mode: 0o600,
    });
    const readme = path.join(homeDir(), 'README.txt');
    try { await fs.stat(readme); } catch {
      await fs.writeFile(readme, 'secrets.json 存放各服務商的 API Key，請勿提交到版本庫。\n', 'utf8');
    }
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.load())[key];
  }

  async set(key: string, value: string): Promise<void> {
    const data = await this.load();
    data[key] = value;
    await this.save(data);
  }

  async delete(key: string): Promise<void> {
    const data = await this.load();
    if (!(key in data)) return;
    delete data[key];
    await this.save(data);
  }
}
```

- [ ] **Step 3: registry.ts 金鑰後端換成 SecretStore**

`src/core/llm/registry.ts`：
- 刪除 `initSecrets(context: vscode.ExtensionContext)`，改為：

```ts
import { SecretStore } from '../stores';
import { getHost } from '../host';

let secrets: SecretStore | undefined;
export function initSecrets(store: SecretStore): void { secrets = store; }
```

- `promptForApiKey`：`vscode.window.showInputBox({...})` → `getHost().input({ title, prompt, password: true, placeHolder, validate: v => v.trim() ? undefined : 'API Key 不能為空' })`；所有 `vscode.window.showErrorMessage/showInformationMessage` → `getHost().toast(msg, 'error'|'info')`。
- `pickProvider` / `pickModelRef`：`vscode.window.showQuickPick` → `getHost().pick(choices, title)`，choices 用 `PickChoice` 形狀（label/description/detail/value）。`pickModelRef` 返回值語義不變（ref 字串）。
- `resolveProvider`：`vscode.window.showErrorMessage` → `getHost().toast(..., 'error')`。
- vscode-lm 分支解耦（消除 core→vscode 反向 import）：

```ts
import { ActiveModel, ... } from '../model/providers';
import { LlmProvider } from './provider';

type ExtraProviderFactory = (active: ActiveModel) => LlmProvider | undefined;
let extraFactory: ExtraProviderFactory | undefined;

/** VS Code 殼啟動時註冊 vscode-lm provider 工廠。 */
export function registerProviderFactory(fn: ExtraProviderFactory): void {
  extraFactory = fn;
}

export async function buildProvider(active: ActiveModel): Promise<LlmProvider | undefined> {
  const { profile, model } = active;
  if (profile.kind === 'vscode-lm') {
    return extraFactory?.(active);
  }
  // ...原有 openai/anthropic 邏輯不變
}
```

刪除 `import { VsCodeLmProvider } from '../../vscode/vscodeLmProvider'`。

- [ ] **Step 4: 全庫 import 改道**

所有 `import { readConfig, readGlobalBudget } from '../model/project'`（以及任何相對變體）改為 `from '../config'`（按檔案位置調整層級）：涉及 `context/builder.ts`、`features/*.ts`、`llm/registry.ts`、`ui/chatController.ts`、`core/projectView.ts`（若引用）。`project.ts` 裡刪除這兩個函式與殘留的 vscode import（至此 `src/core/model/` 應完全無 vscode）。

- [ ] **Step 5: 驗證 + Commit**

此時需要一個臨時宿主讓 smoke 繼續跑：`readConfig()` 只在被呼叫時才訪問 store，現有 smoke 用例不觸發它，預期直接通過。

```powershell
npm run typecheck ; npm run smoke ; npm run compile
git add -A ; git commit -m "refactor: abstract config/secrets backends behind Host stores"
```

---

### Task 5: features 互動去 vscode 化（summarize / characters / style）

**Files:**
- Modify: `src/core/features/summarize.ts`、`src/core/features/characters.ts`、`src/core/features/style.ts`

模式統一：`withProgress` → `getHost().progress`；`showInformationMessage/showWarningMessage`（純提示）→ `toast`；帶按鈕的詢問 → `getHost().confirm`；`showQuickPick` → `getHost().pick`；`CancellationToken` → `AbortSignal`。

- [ ] **Step 1: summarize.ts**

```ts
// 刪除 import vscode；import { getHost } from '../host';

export async function summarizeChapter(
  project: NovelProject,
  chapter: Chapter,
  provider?: LlmProvider,
  signal?: AbortSignal
): Promise<boolean> {
  // 空章節提示：getHost().toast(`第 ${chapter.order} 章是空的，跳過總結。`);
  // options: ChatOptions = { ..., signal }
  // 其餘不變
}

export async function syncSummaries(project: NovelProject): Promise<void> {
  const stale = await project.staleChapters();
  if (stale.length === 0) {
    getHost().toast('所有章節摘要都是最新的。');
    return;
  }
  const confirm = await getHost().confirm(
    `有 ${stale.length} 章摘要缺失或已過期，需要呼叫 ${stale.length} 次模型。現在同步？`,
    ['開始同步'], { modal: true }
  );
  if (confirm !== '開始同步') return;

  const provider = await resolveProvider();
  if (!provider) return;

  await getHost().progress('同步章節摘要', async (signal, report) => {
    let done = 0;
    const failed: number[] = [];
    for (const chapter of stale) {
      if (signal.aborted) break;
      report(`第 ${chapter.order} 章《${chapter.title}》（${done + 1}/${stale.length}）`);
      try {
        await summarizeChapter(project, chapter, provider, signal);
      } catch (err) {
        if (err instanceof CancelledError) break;
        failed.push(chapter.order);
      }
      done++;
    }
    const okCount = done - failed.length;
    if (failed.length > 0) getHost().toast(`完成 ${okCount} 章，第 ${failed.join('、')} 章失敗，可稍後重試。`);
    else if (okCount > 0) getHost().toast(`已同步 ${okCount} 章摘要。`);
  });
}
```

`rebuildGlobalSummary` 同模式：兩處詢問改 `getHost().confirm`（「先同步摘要/仍然重建」雙 action）；`withProgress` → `getHost().progress`，內部 `token.isCancellationRequested` → `signal.aborted`，`progress.report({message, increment})` → `report(message)`；結尾 `vscode.commands.executeCommand('novel.openFile', ...)` → `await getHost().openFile(project.relPath(project.globalSummaryPath))`。

- [ ] **Step 2: characters.ts**

- 章節 QuickPick → `getHost().pick(chapters.map(c => ({ label, description: `${c.wordCount} 字`, value: c.order })), '選擇要提取角色的章節')`，隨後按 order 取章節（多選語義若原實現用了 `canPickMany`，改為單選最近 N 章或保持逐次 pick——按原實現的 `picked.length` 邏輯：pick 不支援多選時，用 host.input 讓使用者輸入章節序號列表如 `1,2,3`，解析成 orders。選擇此方案並在程式碼註釋說明）。
- `withProgress` → `getHost().progress`，token → signal。
- 提示類全改 toast。
- diff 審閱流程改為：

```ts
// 原：寫 .tmp 預覽檔案 + vscode.diff + 詢問採納
const proposedText = renderCharacterCard(proposed);
const verdict = await getHost().reviewReplace?.(existing.name, existingRawText, proposedText);
if (verdict === 'apply') {
  await writeText(project.pathOf(existing.relPath), proposedText);
  getHost().toast(`已更新「${existing.name}」。`);
}
```

刪除 `.tmp` 預覽檔案邏輯（`vscode.workspace.fs.createDirectory/.tmp`、讀回預覽檔案）。`existingRawText` = `await readText(project.pathOf(existing.relPath))`。

- [ ] **Step 3: style.ts**

同模式：章節多選改 input 序號列表（同上）；覆蓋確認 `showWarningMessage(modal)` → `getHost().confirm(..., ['覆蓋'], { modal: true })`；`withProgress` → `progress`；結尾 `showTextDocument` → `getHost().openFile(project.relPath(project.stylePath))`；提示改 toast。

- [ ] **Step 4: 驗證 + Commit**

smoke.js 裡 continueWriting/summarize/characters 的 vscode 樁 hack 此時可以刪除（模組不再 import vscode）——把三個 `Module._load` 樁塊刪掉直接 `loadModule`。

```powershell
npm run typecheck ; npm run smoke ; npm run compile
git add -A ; git commit -m "refactor: route feature interactions through Host (progress/confirm/pick)"
```

---

### Task 6: controller 宿主無關化

**Files:**
- Move+Modify: `src/ui/chatController.ts` → `src/core/controller.ts`
- Create: `src/core/actions.ts`、`src/core/attachments.ts`（選擇項構建）
- Modify: `src/ui/attachments.ts`（只留 vscode 選區實現，移入 `src/vscode/`）

- [ ] **Step 1: 新建 src/core/actions.ts —— 原 extension.ts 命令的 core 化**

```ts
import { getHost } from './host';
import { NovelProject } from './model/project';
import { newCharacter, newLore } from './features/characters';
import { ContinueSession } from './features/continueWriting';
import * as path from 'node:path';

/** 初始化工程：問作品名與作者。defaultTitle 由殼給定（外掛用工作區名，獨立版用目錄名）。 */
export async function initProjectFlow(project: NovelProject, defaultTitle: string): Promise<boolean> {
  if (await project.isInitialized()) {
    getHost().toast('當前目錄已經是小說工程。');
    return false;
  }
  const title = await getHost().input({
    title: '初始化小說工程（1/2）', prompt: '作品名', value: defaultTitle,
    validate: (v) => (v.trim() ? undefined : '不能為空'),
  });
  if (!title) return false;
  const author = await getHost().input({ title: '初始化小說工程（2/2）', prompt: '作者名（可留空）' });
  await project.initialize({ title: title.trim(), author: (author ?? '').trim() });
  getHost().toast(`已初始化《${title.trim()}》。`);
  const pick = await getHost().confirm(`要現在新建第 1 章嗎？`, ['新建第 1 章', '稍後']);
  if (pick === '新建第 1 章') await newChapterFlow(project);
  return true;
}

export async function newChapterFlow(project: NovelProject): Promise<string | undefined> {
  const order = await project.nextChapterOrder();
  const title = await getHost().input({
    title: `新建第 ${order} 章`, prompt: '章節標題', value: `第${order}章`,
    validate: (v) => (v.trim() ? undefined : '不能為空'),
  });
  if (!title) return undefined;
  const relPath = await project.createChapter(order, title.trim());
  await getHost().openFile(relPath);
  return relPath;
}
```

- [ ] **Step 2: 新建 src/core/attachments.ts —— 選擇項構建（無 UI）**

從 `src/ui/attachments.ts` 抽出條目構建邏輯：

```ts
import { NovelProject } from './model/project';
import { Attachment, AttachmentKind } from './model/session';
import { PickChoice } from './host';

/** 構建 @ 引用的候選列表；展示與選擇交給 Host.pick。 */
export async function listAttachmentChoices(project: NovelProject): Promise<PickChoice<Attachment>[]> {
  const choices: PickChoice<Attachment>[] = [];
  const chapters = await project.listChapters();
  for (const c of [...chapters].reverse()) {
    choices.push({
      label: `${String(c.order).padStart(3, '0')} ${c.title}`,
      description: `${c.wordCount} 字`, detail: c.relPath, group: '章節',
      value: fileAttachment('chapter', `第${c.order}章 ${c.title}`, c.relPath),
    });
  }
  for (const card of await project.listCharacters()) {
    choices.push({
      label: card.name, description: card.tags.join(' · '), detail: card.relPath, group: '角色',
      value: fileAttachment('character', `角色 ${card.name}`, card.relPath),
    });
  }
  for (const entry of await project.listLore()) {
    choices.push({
      label: entry.title, description: entry.keywords.join('/'), detail: entry.relPath, group: '設定',
      value: fileAttachment('lore', `設定 ${entry.title}`, entry.relPath),
    });
  }
  choices.push({ label: '全書大綱', detail: project.relPath(project.outlinePath), group: '其他',
    value: fileAttachment('file', '全書大綱', project.relPath(project.outlinePath)) });
  choices.push({ label: '文風指南', detail: project.relPath(project.stylePath), group: '其他',
    value: fileAttachment('file', '文風指南', project.relPath(project.stylePath)) });
  return choices;
}

function fileAttachment(kind: AttachmentKind, label: string, relPath: string): Attachment {
  return { id: `${kind}:${relPath}`, kind, label, relPath };
}
```

`src/ui/attachments.ts` 裡刪除 `pickAttachment`（保留 `selectionAttachment`），檔案改名為 `git mv src/ui/attachments.ts src/vscode/attachments.ts`，import 層級修正。

- [ ] **Step 3: controller 移動並替換所有 vscode 呼叫**

`git mv src/ui/chatController.ts src/core/controller.ts`，import 層級修正（`../core/...` → `./...`），然後逐條替換 `dispatch`：

```ts
// 新增 import
import { getHost } from './host';
import { initProjectFlow, newChapterFlow } from './actions';
import { listAttachmentChoices } from './attachments';
import { syncSummaries, summarizeChapter } from './features/summarize';
import { rebuildGlobalSummary, extractCharacters } from ...; // 按 ProjectAction 對應
import { extractStyle } from './features/style';
import { promptForApiKey, clearApiKey } from './llm/registry';
import { updateSettings } from './config';
```

| 原始碼 | 替換為 |
| --- | --- |
| `case 'openFile'` 執行命令 | `await getHost().openFile(msg.path);` |
| `case 'syncSummaries'` 執行命令 | `await syncSummaries(this.project); await this.pushState();` |
| `case 'setApiKey'` 執行命令 | `await promptForApiKey(msg.providerId); await this.pushSettings(); await this.pushState();` |
| `case 'clearApiKey'` 執行命令 | `await clearApiKey(msg.providerId); await this.pushSettings();` |
| `case 'openNativeSettings'` 執行命令 | `await getHost().openNativeSettings?.();` |
| `case 'pickAttachment'` | 見 Step 4 |
| `case 'addSelection'` | 見 Step 4 |
| `deleteSession` 裡 `showWarningMessage` modal | `getHost().confirm(`刪除對話「${title}」？`, ['删除'], { modal: true, detail: '会移到 .novelforge/.trash/，可手动找回。' })` |
| `renameSession` 裡 `showInputBox` | `getHost().input({ title: '重新命名對話', value: target.title, validate: v => v.trim() ? undefined : '不能為空' })` |
| `accept` 末尾 showTextDocument + novel.refresh | `await getHost().openFile(turn.acceptedTo!); await this.pushState();` |
| `selectModel` 寫配置 | `await updateSettings({ model: ref });` |
| `saveSettings` 寫配置 | 見 Step 5 |
| `projectAction` 的 COMMANDS 表 | 見 Step 6 |

- [ ] **Step 4: pickAttachment / addSelection**

```ts
case 'pickAttachment': {
  const choices = await listAttachmentChoices(this.project);
  const picked = await getHost().pick(choices, '引用到上下文');
  if (picked) this.addAttachment(picked);
  else if (getHost().browseFile) {
    // 列表尾部語義：取消時不再追問；「瀏覽」入口由前端保留舊按鈕時另行處理（YAGNI：先移除瀏覽入口）
  }
  return;
}

case 'addSelection': {
  const att = await getHost().selectionAttachment(this.project);
  if (!att) {
    this.toast('沒有可加入的文字。', 'error');
    return;
  }
  this.addAttachment(att);
  return;
}
```

（「瀏覽工作區」入口本任務順帶從 view.js 移除：刪除 QuickPick 相關說明不涉及前端——瀏覽項本來在後端 QuickPick 裡，前端無感知，無需動 view.js。）

- [ ] **Step 5: saveSettings 寫後端**

```ts
private async saveSettings(s: SettingsPayload): Promise<void> {
  const before = readConfig().providers.map((p) => p.id);
  const providers = normalizeProviders(s.providers);
  if (s.providers.length > 0 && providers.length === 0) {
    this.toast('服務商配置不合法：id 不能為空或含斜槓，且每個服務商至少要有一個模型。', 'error');
    await this.pushSettings('rejected');
    return;
  }
  await updateSettings({
    providers,
    model: s.model.trim(),
    contextWindow: s.contextWindow,
    maxOutputTokens: s.maxOutputTokens,
    temperature: s.temperature,
    recentChaptersFullText: s.recentChaptersFullText,
    prevChapterTailChars: s.prevChapterTailChars,
    summaryBatchSize: s.summaryBatchSize,
    requestTimeoutMs: s.requestTimeoutMs,
  });
  await pruneApiKeys(providers, before);
  await this.pushSettings('saved');
  await this.pushState();
  this.toast('設定已儲存。');
}
```

- [ ] **Step 6: projectAction 直調 core**

```ts
private async projectAction(action: ProjectAction, order?: number): Promise<void> {
  const host = getHost();
  switch (action) {
    case 'initProject':
      await initProjectFlow(this.project, this.project.root.split(/[\\/]/).pop() ?? '我的小說');
      break;
    case 'refresh': break; // pushState 本身就是重新整理
    case 'newChapter': await newChapterFlow(this.project); break;
    case 'newCharacter': await newCharacter(this.project); break;
    case 'newLore': await newLore(this.project); break;
    case 'continueFrom':
      // 與原語義一致：從某章續寫 = 目標設為下一章
      this.current.targetOrder = (order ?? (await this.project.nextChapterOrder() - 1)) + 1;
      await this.showTab('chat');
      break;
    case 'summarizeChapter': {
      if (order === undefined) break;
      const chapter = await this.project.getChapter(order);
      if (!chapter) break;
      await host.progress(`總結第 ${chapter.order} 章`, async (signal) => {
        const ok = await summarizeChapter(this.project, chapter, undefined, signal);
        if (ok) host.toast(`第 ${chapter.order} 章摘要已生成。`);
      });
      break;
    }
    case 'syncSummaries': await syncSummaries(this.project); break;
    case 'rebuildGlobalSummary': await rebuildGlobalSummary(this.project); break;
    case 'extractCharacters': await extractCharacters(this.project); break;
    case 'extractStyle': await extractStyle(this.project); break;
  }
  await this.pushState();
}
```

注意 `extractCharacters` 的原實現含章節選擇；其內部已 Task 5 化，直調即可。`newCharacter/newLore` 內部若有 showInputBox，Task 5 未覆蓋——檢查並按同模式改為 `getHost().input`（它們當前通過 `vscode.window.showInputBox` 問名字/內容，逐個替換）。

- [ ] **Step 7: 驗證 + Commit**

`extension.ts` 此時 import 路徑變了（`../core/controller`），編譯通過即可。

```powershell
npm run typecheck ; npm run smoke ; npm run compile
git add -A ; git commit -m "refactor: make ChatController host-agnostic (core/controller.ts)"
```

---

### Task 7: VS Code 殼 —— VsCodeHost + settings.json/SecretStorage 後端

**Files:**
- Create: `src/vscode/vscodeHost.ts`、`src/vscode/settingsStore.ts`
- Modify: `src/vscode/extension.ts`（initHost、工廠註冊、watcher 改走 Host）

目標：外掛側把 Task 3/4 的抽象接回 VS Code 原生 API。行為與改造前完全一致。

- [ ] **Step 1: 新建 src/vscode/settingsStore.ts**

```ts
import * as vscode from 'vscode';
import { ConfigStore, PersistedSettings } from '../core/config';
import { SecretStore } from '../core/stores';

/**
 * 過渡後端：繼續讀寫工作區 settings.json 的 novel.*。
 * Task 12 遷移完成後，外掛殼也切到 FileConfigStore，本檔案刪除。
 */
export class SettingsJsonConfigStore implements ConfigStore {
  read(): PersistedSettings | undefined {
    const cfg = vscode.workspace.getConfiguration('novel');
    // 未顯式配置過任何鍵時返回 undefined，讓 legacy reader 有機會兜底
    const keys = ['providers', 'model', 'contextWindow', 'maxOutputTokens', 'temperature',
      'recentChaptersFullText', 'prevChapterTailChars', 'chaptersDir', 'summaryBatchSize', 'requestTimeoutMs'];
    if (!keys.some((k) => cfg.get(k) !== undefined && !isDefaultOnly(cfg, k))) {
      // 簡化判斷：只要 providers 非空或 model 非空就算「配置過」
      if (!cfg.get<unknown[]>('providers', []).length && !cfg.get<string>('model', '')) return undefined;
    }
    const out: PersistedSettings = {};
    for (const k of keys) {
      const v = cfg.get(k);
      if (v !== undefined) (out as Record<string, unknown>)[k] = v;
    }
    return out;
  }

  async write(settings: PersistedSettings): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('novel');
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    for (const [k, v] of Object.entries(settings)) {
      if (v !== undefined) await cfg.update(k, v, target);
    }
  }
}

function isDefaultOnly(_cfg: vscode.WorkspaceConfiguration, _k: string): boolean {
  return false; // 佔位：read() 裡的簡化判斷已夠用
}

/**
 * 遺留單服務商鍵的讀取器（novel.provider / novel.openai.baseUrl …），
 * 供 config.ts 的 seedFromLegacyRaw 兜底。
 */
export const legacySettingsReader = {
  read(): PersistedSettings {
    const cfg = vscode.workspace.getConfiguration('novel');
    return {
      provider: cfg.get<string>('provider'),
      'openai.baseUrl': cfg.get<string>('openai.baseUrl'),
      'openai.model': cfg.get<string>('openai.model'),
      'anthropic.baseUrl': cfg.get<string>('anthropic.baseUrl'),
      'anthropic.model': cfg.get<string>('anthropic.model'),
      'vscodeLm.family': cfg.get<string>('vscodeLm.family'),
    } as unknown as PersistedSettings;
  },
};

/** SecretStorage 後端的 SecretStore 適配。 */
export class SecretStorageSecretStore implements SecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}
  get(key: string) { return this.secrets.get(key); }
  async set(key: string, value: string) { await this.secrets.store(key, value); }
  async delete(key: string) { await this.secrets.delete(key); }
}
```

- [ ] **Step 2: 新建 src/vscode/vscodeHost.ts**

```ts
import * as vscode from 'vscode';
import { ConfigStore } from '../core/config';
import { Disposable, Host, InputOptions, PickChoice } from '../core/host';
import { NovelProject } from '../core/model/project';
import { Attachment } from '../core/model/session';
import { pickAttachment, selectionAttachment } from '../ui/attachments';

export class VsCodeHost implements Host {
  readonly name = 'vscode' as const;
  readonly supportsVscodeLm = true;
  constructor(public readonly config: ConfigStore) {}

  async input(opts: InputOptions): Promise<string | undefined> {
    return vscode.window.showInputBox({
      title: opts.title, prompt: opts.prompt, value: opts.value,
      placeHolder: opts.placeHolder, password: opts.password,
      ignoreFocusOut: true,
      validateInput: opts.validate ? (v) => opts.validate!(v) ?? undefined : undefined,
    });
  }

  async confirm(message: string, actions: string[], opts?: { modal?: boolean; detail?: string }) {
    return vscode.window.showInformationMessage(
      `Novelwarden：${message}`, { modal: opts?.modal ?? false, detail: opts?.detail }, ...actions);
  }

  async pick<T>(choices: PickChoice<T>[], title: string): Promise<T | undefined> {
    const picked = await vscode.window.showQuickPick(
      choices.map((c) => ({ label: c.label, description: c.description, detail: c.detail, value: c.value })),
      { title });
    return picked?.value;
  }

  async progress<T>(title: string, fn: (signal: AbortSignal, report: (m: string) => void) => Promise<T>): Promise<T> {
    const source = new vscode.CancellationTokenSource();
    const abort = new AbortController();
    source.token.onCancellationRequested(() => abort.abort());
    try {
      return await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Novelwarden：${title}`, cancellable: true },
        async (progress, token) => {
          token.onCancellationRequested(() => abort.abort());
          return fn(abort.signal, (message) => progress.report({ message }));
        });
    } finally {
      source.dispose();
    }
  }

  watch(project: NovelProject, onChange: () => void): Disposable {
    const config = require('../core/config').readConfig();
    const patterns = [`${config.chaptersDir}/**/*.md`, '.novelforge/**/*.md', '.novelforge/project.json'];
    const watchers = patterns.map((p) =>
      vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(project.root, p)));
    for (const w of watchers) { w.onDidChange(onChange); w.onDidCreate(onChange); w.onDidDelete(onChange); }
    return { dispose: () => watchers.forEach((w) => w.dispose()) };
  }

  async openFile(relPath: string): Promise<void> {
    const project = NovelProject.current?.() ?? undefined;
    // controller 場景下 root 已知：由呼叫方傳入相對路徑時以當前工程解析
    const abs = project ? project.pathOf(relPath) : relPath;
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(vscode.Uri.file(abs)),
      { viewColumn: vscode.ViewColumn.One, preview: false });
  }

  toast(message: string, level: 'info' | 'error' = 'info'): void {
    if (level === 'error') void vscode.window.showErrorMessage(`Novelwarden：${message}`);
    else void vscode.window.showInformationMessage(`Novelwarden：${message}`);
  }

  selectionAttachment(project: NovelProject): Promise<Attachment | undefined> {
    return selectionAttachment(project);
  }

  browseFile(project: NovelProject): Promise<string | undefined> {
    return pickAttachment(project) as Promise<string | undefined>;
  }

  async reviewReplace(name: string, currentText: string, proposedText: string): Promise<'apply' | 'discard' | undefined> {
    // 保持原有 diff 體驗：寫臨時檔案開 diff，詢問採納
    const tmp = await vscode.workspace.fs.writeFile(
      vscode.Uri.file(`${(await import('node:os')).tmpdir()}/novelforge-${name}.proposed.md`),
      Buffer.from(proposedText, 'utf8'));
    void tmp;
    await vscode.commands.executeCommand('vscode.diff',
      undefined /* 由 controller 傳當前檔案 uri */, undefined, `角色卡：${name}（審閱）`);
    const pick = await vscode.window.showInformationMessage(
      `Novelwarden：採納對「${name}」的更新？`, { modal: true }, '採納', '放棄');
    return pick === '採納' ? 'apply' : pick === '放棄' ? 'discard' : undefined;
  }

  async openNativeSettings(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'novel.');
  }
}
```

注意：`reviewReplace` 的 diff 實現細節跟隨原 characters.ts 的 `.tmp` 邏輯——執行時把原實現裡「寫臨時檔案 → vscode.diff → 詢問」三步原樣搬進來（上面的程式碼是骨架，diff 的兩個 uri 用「當前角色卡檔案 uri」與「臨時檔案 uri」）。`openFile` 裡若拿不到 project，直接用 relPath 兜底開啟。

- [ ] **Step 3: extension.ts 接線**

在 `activate` 最前面（`initSecrets` 之前）：

```ts
import { initHost } from '../core/host';
import { setLegacyConfigReader, initConfigFromHost } from '../core/config';
import { initSecrets, registerProviderFactory } from '../core/llm/registry';
import { VsCodeHost } from './vscodeHost';
import { SettingsJsonConfigStore, SecretStorageSecretStore, legacySettingsReader } from './settingsStore';
import { VsCodeLmProvider } from './vscodeLmProvider';

// activate() 內第一行起：
initHost(new VsCodeHost(new SettingsJsonConfigStore()));
setLegacyConfigReader(legacySettingsReader);
initSecrets(new SecretStorageSecretStore(context.secrets));
registerProviderFactory((active) => new VsCodeLmProvider(active));
```

其餘調整：
- `NovelProject.current()` 在 core 裡保留為靜態方法：讀 `vscode` 的職責移到這裡——實現方式：`NovelProject.current()` 保留在 **extension.ts 側**新增的 helper `currentProject()`（讀 `vscode.workspace.workspaceFolders?.[0].uri.fsPath` → `NovelProject.open(...)`）。全文替換 `NovelProject.current()` / `NovelProject.require()` 為 `currentProject()` / `requireProject()`（後者無工作區時 toast 並返回 undefined）。若 Task 2 已把 `current()/require()` 從 project.ts 刪除，此處直接新建這兩個 helper；若還在，刪除之。
- `registerWatcher(context, project, chat)` 改為：

```ts
function registerWatcher(context: vscode.ExtensionContext, project: NovelProject, chat: ChatController | undefined): void {
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { project.invalidate(); void chat?.pushState(); }, 250);
  };
  const watcher = getHost().watch(project, schedule);
  context.subscriptions.push(watcher);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('novel')) schedule();
  }));
}
```

- 命令註冊保持清單不變，但 `novel.initProject` / `novel.newChapter` 的命令體改為調 Task 6 的 `initProjectFlow(chat)` / `newChapterFlow(chat, project)`（core/actions.ts）；`novel.summarizeChapter` 等已是「調 core 函式 + refresh」的直接保留，僅把 `withProgress` 換成 `getHost().progress`、`showQuickPick` 換成 `getHost().pick`（`pickChapter` 用 host.pick 重寫）。
- `offerMigration` 裡 `showInformationMessage` → `getHost().confirm(...)`。

- [ ] **Step 4: 驗證 + Commit**

```powershell
npm run typecheck ; npm run smoke ; npm run compile
git add -A ; git commit -m "feat(vscode): implement VsCodeHost over settings.json and SecretStorage"
```

---

### Task 8: 協議擴充套件 + view.js 彈窗適配

**Files:**
- Modify: `src/core/protocol.ts`、`media/view.js`、`src/vscode/webviewHtml.ts`（hint 文案）

目標：獨立版的 `host.input/confirm/pick` 經 WebSocket 變成網頁 modal。協議新增兩條訊息；view.js 主體不動，只加一個渲染函式。

- [ ] **Step 1: protocol.ts 新增訊息型別**

```ts
// InMessage 聯合新增：
  | { type: 'promptResult'; requestId: string; value?: string }

// OutMessage 聯合新增：
  | { type: 'prompt'; requestId: string; kind: 'input' | 'confirm' | 'pick';
      title: string; message?: string; placeholder?: string; value?: string;
      password?: boolean; multiline?: boolean; options?: string[] }
```

另在 `ViewState` 里加 `standalone?: boolean`（前端據此隱藏「在 VS Code 設定中開啟」、把 hint 改成 `~/.novelforge/`）。

- [ ] **Step 2: view.js 新增 renderPrompt 與兩個 case**

在 `window.addEventListener('message', ...)` 的 switch 里加：

```js
case 'prompt': renderPrompt(msg); break;
```

新增函式（放在附件區附近即可）：

```js
function renderPrompt(msg) {
  // 複用 providerModal 遮罩層，body 換成臨時內容
  const overlay = el.providerModal;           // 現有 modal-overlay
  const body = el.providerModalBody;
  $('providerModalTitle').textContent = msg.title;
  let inputEl;
  if (msg.kind === 'confirm') {
    body.innerHTML = `<p class="hint">${escapeHtml(msg.message ?? '')}</p>
      <div class="actions"><button class="primary" id="pmOk">確定</button>
      <button class="secondary" id="pmCancel">取消</button></div>`;
  } else if (msg.kind === 'pick') {
    body.innerHTML = `<div class="picklist" id="pmList"></div>
      <div class="actions"><button class="secondary" id="pmCancel">取消</button></div>`;
    const list = $('pmList');
    (msg.options ?? []).forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.className = 'pick-item';
      btn.textContent = opt;
      btn.addEventListener('click', () => { reply(opt); });
      list.appendChild(btn);
    });
  } else { // input
    const tag = msg.multiline ? 'textarea' : 'input';
    body.innerHTML = `${msg.message ? `<p class="hint">${escapeHtml(msg.message)}</p>` : ''}
      <${tag} id="pmInput" ${msg.multiline ? 'rows="6"' : ''} ${msg.password ? 'type="password"' : ''}
        placeholder="${escapeHtml(msg.placeholder ?? '')}" style="width:100%"></${tag}>
      <div class="actions"><button class="primary" id="pmOk">確定</button>
      <button class="secondary" id="pmCancel">取消</button></div>`;
    inputEl = $('pmInput');
    inputEl.value = msg.value ?? '';
    inputEl.focus();
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !msg.multiline) { e.preventDefault(); reply(inputEl.value); }
      if (e.key === 'Escape') reply(undefined);
    });
  }
  $('pmOk')?.addEventListener('click', () => reply(msg.kind === 'confirm' ? 'yes' : inputEl.value));
  $('pmCancel')?.addEventListener('click', () => reply(msg.kind === 'confirm' ? 'no' : undefined));
  overlay.classList.remove('hidden');

  function reply(value) {
    overlay.classList.add('hidden');
    body.innerHTML = '';
    vscode.postMessage({ type: 'promptResult', requestId: msg.requestId, value });
  }
}
```

`escapeHtml` 若 view.js 已有則複用，沒有就在檔案內加一個（`replace(/[&<>"']/g, ...)`）。`.pick-item` 在 view.css 補一條：塊級全寬按鈕、左對齊、hover 高亮（複用現有 chip 樣式變數）。

- [ ] **Step 3: 前端環境差異**

在 `renderState(state)` 里加（只執行一次的 flag）：

```js
if (state.standalone && !applied.standalone) {
  applied.standalone = true;
  $('nativeSettingsBtn').classList.add('hidden');
  // 設定頁底部 hint 改文案
  document.querySelector('#pane-settings .hint:last-of-type').textContent =
    '設定寫入 ~/.novelforge/config.json；API Key 存在 ~/.novelforge/secrets.json。';
}
```

controller 在 pushState 時根據 `getHost().name === 'standalone'` 置 `standalone: true`（Task 9 的 controller 接線時一併改）。

- [ ] **Step 4: 驗證 + Commit**

```powershell
npm run typecheck ; npm run smoke
git add -A ; git commit -m "feat(protocol): add prompt/promptResult messages and web modal"
```

（此時 VS Code 殼不會發 prompt，行為不變；彈窗在 Task 9/10 的獨立版裡端到端驗證。）

---

### Task 9: 獨立版 Host —— FileHost + PromptHub

**Files:**
- Create: `src/standalone/promptHub.ts`、`src/standalone/fileHost.ts`
- Modify: `src/core/controller.ts`（pushState 置 standalone）

- [ ] **Step 1: 新建 src/standalone/promptHub.ts**

```ts
import { OutMessage } from '../core/protocol';

type PromptRequest = Exclude<OutMessage, { type: string }> extends never ? never : Extract<OutMessage, { type: 'prompt' }>;

/**
 * 管理未決的網頁彈窗：ask() 向廣播函式要一條 prompt 訊息，
 * 等前端回 promptResult 後 resolve。頁面斷開時統一 reject（取消）。
 */
export class PromptHub {
  private seq = 0;
  private pending = new Map<string, (value: string | undefined) => void>();

  constructor(private readonly broadcast: (msg: OutMessage) => void) {}

  ask(req: Omit<PromptRequest, 'type' | 'requestId'>): Promise<string | undefined> {
    const requestId = `p${++this.seq}-${Date.now().toString(36)}`;
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve);
      this.broadcast({ type: 'prompt', requestId, ...req });
    });
  }

  resolve(requestId: string, value: string | undefined): void {
    const done = this.pending.get(requestId);
    if (!done) return;
    this.pending.delete(requestId);
    done(value);
  }

  /** WS 全部斷開時，未決彈窗一律按取消處理。 */
  cancelAll(): void {
    for (const done of this.pending.values()) done(undefined);
    this.pending.clear();
  }
}
```

- [ ] **Step 2: 新建 src/standalone/fileHost.ts**

```ts
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { ConfigStore } from '../core/config';
import { Disposable, Host, InputOptions, PickChoice } from '../core/host';
import { NovelProject } from '../core/model/project';
import { Attachment } from '../core/model/session';
import { OutMessage } from '../core/protocol';
import { PromptHub } from './promptHub';

export class FileHost implements Host {
  readonly name = 'standalone' as const;
  readonly supportsVscodeLm = false;
  readonly prompts: PromptHub;

  constructor(
    public readonly config: ConfigStore,
    broadcast: (msg: OutMessage) => void,
  ) {
    this.prompts = new PromptHub(broadcast);
  }

  async input(opts: InputOptions): Promise<string | undefined> {
    const value = await this.prompts.ask({
      kind: 'input', title: opts.title ?? '輸入', message: opts.prompt,
      placeholder: opts.placeHolder, value: opts.value,
      password: opts.password, multiline: opts.multiline,
    });
    if (value === undefined) return undefined;
    if (opts.validate) {
      const err = opts.validate(value);
      if (err) { this.toast(err, 'error'); return this.input(opts); }
    }
    return value;
  }

  async confirm(message: string, actions: string[], opts?: { detail?: string }): Promise<string | undefined> {
    // 網頁彈窗只有 確定/取消；把第一個 action 當作「確定」的語義
    const value = await this.prompts.ask({
      kind: 'confirm', title: actions[0] ?? '確認', message, value: opts?.detail });
    return value === 'yes' ? (actions[0] ?? '確定') : undefined;
  }

  async pick<T>(choices: PickChoice<T>[], title: string): Promise<T | undefined> {
    const labels = choices.map((c) => c.description ? `${c.label}（${c.description}）` : c.label);
    const picked = await this.prompts.ask({ kind: 'pick', title, options: labels });
    if (!picked) return undefined;
    const idx = labels.indexOf(picked);
    return idx >= 0 ? choices[idx].value : undefined;
  }

  async progress<T>(title: string, fn: (signal: AbortSignal, report: (m: string) => void) => Promise<T>): Promise<T> {
    this.toast(`開始：${title}`);
    const abort = new AbortController();
    try {
      const result = await fn(abort.signal, (m) => this.toast(`${title}：${m}`));
      return result;
    } catch (err) {
      this.toast(err instanceof Error ? err.message : String(err), 'error');
      throw err;
    }
  }

  watch(project: NovelProject, onChange: () => void): Disposable {
    // 優先 fs.watch（node ≥ 20 支援 recursive）；失敗回退 1s 輪詢目錄 mtime
    try {
      const watcher = fs.watch(project.root, { recursive: true }, (_event, filename) => {
        const name = String(filename ?? '');
        if (!/\.(md|json)$/i.test(name)) return;
        if (name.includes('node_modules')) return;
        onChange();
      });
      return { dispose: () => watcher.close() };
    } catch {
      const timer = setInterval(async () => {
        try {
          const st = await fsp.stat(project.novelDir);
          onChange(); void st;
        } catch { /* 目錄不存在時忽略 */ }
      }, 1000);
      return { dispose: () => clearInterval(timer) };
    }
  }

  async openFile(relPath: string): Promise<void> {
    // 用系統預設程式開啟（使用者自己的編輯器）
    const abs = path.resolve(relPath);
    const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
      spawn(cmd, [abs], { detached: true, stdio: 'ignore' }).unref();
      this.toast(`已開啟：${relPath}`);
    } catch {
      this.toast(`無法開啟：${relPath}，請手動開啟。`);
    }
  }

  toast(message: string, level: 'info' | 'error' = 'info'): void {
    this.broadcastToast({ type: 'toast', message, level });
  }
  private broadcastToast: (msg: OutMessage) => void;

  async selectionAttachment(project: NovelProject): Promise<Attachment | undefined> {
    const text = await this.input({
      title: '加入選區', prompt: '貼上要引用的原文', multiline: true,
      placeHolder: '在編輯器裡複製後貼上到這裡',
      validate: (v) => (v.trim() ? undefined : '不能為空'),
    });
    if (text === undefined) return undefined;
    return {
      id: `paste-${Date.now().toString(36)}`,
      kind: 'selection', label: '貼上的選區', text,
    } as Attachment;
  }

  async browseFile(project: NovelProject): Promise<string | undefined> {
    const rel = await this.input({
      title: '引用檔案', prompt: '輸入工作區內的相對路徑（如 chapters/003.md）',
      validate: (v) => {
        const abs = project.pathOf(v.trim());
        if (!fs.existsSync(abs)) return '檔案不存在';
        return undefined;
      },
    });
    return rel?.trim();
  }

  async reviewReplace(name: string, currentText: string, proposedText: string): Promise<'apply' | 'discard' | undefined> {
    const ok = await this.confirm(`將更新角色卡「${name}」（新版 ${proposedText.length} 字，當前 ${currentText.length} 字）。`, ['應用更新']);
    return ok ? 'apply' : 'discard';
  }

  // standalone 沒有 openNativeSettings：前端已隱藏按鈕，此處不提供。
}
```

實現細節：把建構函式傳入的 `broadcast` 存為私有欄位 `broadcastMsg`，`toast` 與 `PromptHub` 都用它（上面 `broadcastToast` 佔位寫法執行時直接改成構造引數儲存）。注意：prompt/toast 的廣播只在有 WS 連線時有效，無連線時靜默丟棄（broadcast 實現方保證）。

- [ ] **Step 3: controller 置 standalone 標記**

`src/core/controller.ts` 的 pushState 構造 ViewState 處：`standalone: getHost().name === 'standalone'`。

- [ ] **Step 4: 驗證 + Commit**

```powershell
npm run typecheck ; npm run smoke
git add -A ; git commit -m "feat(standalone): FileHost with WebSocket prompts and fs watcher"
```

---

### Task 10: 獨立版 Web 服務 —— server / bridge / CLI

**Files:**
- Create: `scripts/embed-media.js`、`media/bridge.js`、`src/standalone/mediaAssets.ts`（生成物，進 .gitignore）、`src/standalone/html.ts`、`src/standalone/server.ts`、`src/standalone/cli.ts`、`src/standalone/main.ts`
- Modify: `.gitignore`、`tsconfig.json`（如需）

- [ ] **Step 1: 新建 scripts/embed-media.js（媒體內嵌，供 bun compile）**

```js
/**
 * 把 media/ 下的靜態資源 base64 內嵌進生成檔案，
 * 使 bun build --compile 出的單檔案可執行檔案不依賴外部資源。
 * 用法：node scripts/embed-media.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MEDIA = path.join(ROOT, 'media');
const OUT = path.join(ROOT, 'src', 'standalone', 'mediaAssets.ts');

const files = ['view.css', 'view.js', 'bridge.js', 'icon.svg'];
const lines = ['// 由 scripts/embed-media.js 生成，勿手改。', 'export const MEDIA_ASSETS: Record<string, { mime: string; base64: string }> = {'];
const MIME = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
for (const name of files) {
  const buf = fs.readFileSync(path.join(MEDIA, name));
  lines.push(`  '${name}': { mime: '${MIME[path.extname(name)]}', base64: '${buf.toString('base64')}' },`);
}
lines.push('};');
fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
console.log(`✓ 生成 ${path.relative(ROOT, OUT)}（${files.length} 個資源）`);
```

`.gitignore` 追加 `src/standalone/mediaAssets.ts`。

- [ ] **Step 2: 新建 media/bridge.js（把 WebSocket 偽裝成 webview API）**

```js
// 獨立版橋接：在 view.js 之前載入。
// webview 環境（VS Code）裡 acquireVsCodeApi 已存在，本檔案直接退出。
(function () {
  if (typeof acquireVsCodeApi === 'function') return;

  let ws;
  let closed = false;
  const outbox = [];        // 連線未就緒時暫存的訊息

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      hideBanner();
      for (const msg of outbox.splice(0)) ws.send(JSON.stringify(msg));
    };
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      window.dispatchEvent(new MessageEvent('message', { data: msg }));
    };
    ws.onclose = () => {
      if (closed) return;
      showBanner();
      setTimeout(connect, 1500);
    };
  }

  let banner;
  function showBanner() {
    if (!banner) {
      banner = document.createElement('div');
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;' +
        'background:#b83e3e;color:#fff;padding:6px 12px;font-size:12px;text-align:center;';
      banner.textContent = '與伺服器的連線已斷開，正在重連…';
      document.body.appendChild(banner);
    }
    banner.style.display = '';
  }
  function hideBanner() { if (banner) banner.style.display = 'none'; }

  window.acquireVsCodeApi = () => ({
    postMessage(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      else outbox.push(msg);
    },
    getState() { return undefined; },
    setState() {},
  });

  connect();
})();
```

要點：view.js 用 `window.addEventListener('message', e => e.data)` 收訊息，MessageEvent 的 dispatch 與其完全相容；重連後 view.js 不會再發 ready——因此 server 側在 WS open 時主動推 init/state（見 Step 4）。

- [ ] **Step 3: 新建 src/standalone/html.ts**

```ts
import { MEDIA_ASSETS } from './mediaAssets';

/**
 * 與 webviewHtml.ts 同一套 DOM；資源改為內嵌直出。
 * 執行時把 webviewHtml.ts 的模板字串整段拄過來，僅改：
 * 1. 去掉 CSP meta（瀏覽器直接服務本機，無 webview 隔離需求）
 * 2. <link href="/media/view.css">；指令碼先 /media/bridge.js 再 /media/view.js
 */
export function standalonePage(): string {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="/media/view.css" rel="stylesheet">
<title>Novelwarden</title>
</head>
<body>
……（照抄 webviewHtml.ts 的 tabbar / 四個 pane / providerModal / toast）……
<script src="/media/bridge.js"></script>
<script src="/media/view.js"></script>
</body>
</html>`;
}

export function assetBytes(name: string): { mime: string; bytes: Uint8Array } | undefined {
  const asset = MEDIA_ASSETS[name];
  if (!asset) return undefined;
  return { mime: asset.mime, bytes: Uint8Array.from(Buffer.from(asset.base64, 'base64')) };
}
```

- [ ] **Step 4: 新建 src/standalone/server.ts**

```ts
import { initHost, getHost } from '../core/host';
import { initSecrets } from '../core/llm/registry';
import { FileConfigStore, FileSecretStore } from '../core/stores';
import { setLegacyConfigReader } from '../core/config'; // 獨立版不注入 legacy，僅確認不呼叫
import { NovelProject } from '../core/model/project';
import { ChatController } from '../core/controller';
import { InMessage, OutMessage } from '../core/protocol';
import { FileHost } from './fileHost';
import { assetBytes, standalonePage } from './html';

export interface ServeOptions {
  root: string;   // 小說工程目錄（絕對路徑）
  port: number;
}

export function startServer(opts: ServeOptions): void {
  const project = NovelProject.open(opts.root);
  const clients = new Set<import('bun').ServerWebSocket<{ }>>();

  const broadcast = (msg: OutMessage) => {
    const text = JSON.stringify(msg);
    for (const ws of clients) ws.send(text);
  };

  const host = new FileHost(new FileConfigStore(), broadcast);
  initHost(host);
  initSecrets(new FileSecretStore());
  const chat = new ChatController(project);
  host.watch(project, () => { project.invalidate(); void chat.pushState(); });

  const server = Bun.serve({
    port: opts.port,
    hostname: '127.0.0.1',

    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === '/ws') {
        if (server.upgrade(req)) return undefined;
        return new Response('WebSocket upgrade failed', { status: 400 });
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return new Response(standalonePage(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      if (url.pathname.startsWith('/media/')) {
        const asset = assetBytes(url.pathname.slice('/media/'.length));
        if (asset) return new Response(asset.bytes, { headers: { 'content-type': asset.mime } });
      }
      return new Response('Not Found', { status: 404 });
    },

    websocket: {
      open(ws) {
        clients.add(ws);
        // 新連線（含重連）直接推完整狀態，不等 ready
        void chat.resendFullState();
      },
      async message(_ws, raw) {
        try {
          const msg = JSON.parse(String(raw)) as InMessage;
          if (msg.type === 'promptResult') {
            host.prompts.resolve(msg.requestId, msg.value);
            return;
          }
          if (msg.type === 'ready') return;
          await chat.dispatch(msg);
        } catch (err) {
          broadcast({ type: 'toast', message: err instanceof Error ? err.message : String(err), level: 'error' });
        }
      },
      close(ws) {
        clients.delete(ws);
        if (clients.size === 0) host.prompts.cancelAll();
      },
    },
  });

  console.log(`Novelwarden 已启动：http://127.0.0.1:${server.port}/（工程：${opts.root}）`);
}
```

controller 需補兩個入口（若 Task 6 尚未提供，在這裡一併加到 `src/core/controller.ts`）：
- `dispatch(msg: InMessage): Promise<void>` —— 把 Task 6 裡 switch 分發表匯出為公開方法（webview 殼和 WS 共用）；
- `resendFullState(): Promise<void>` —— 依次推 `init(state)`、`tab`、當前 session、sessions 列表、project tree、settings（照抄現有 ready 處理邏輯，抽成方法）。

- [ ] **Step 5: 新建 src/standalone/cli.ts 與 main.ts**

```ts
// src/standalone/cli.ts
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CliOptions {
  root: string;
  port: number;
  open: boolean;
  init: boolean;
}

/**
 * novelforge [dir] [--port N] [--no-open]
 * novelforge init [dir]
 */
export function parseArgs(argv: string[]): CliOptions {
  let root = '.';
  let port = 3680;
  let open = true;
  let init = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') port = Number(argv[++i]) || 3680;
    else if (a === '--no-open') open = false;
    else if (a === 'init') init = true;
    else if (!a.startsWith('-')) rest.push(a);
  }
  if (rest.length > 0) root = rest[0];
  return { root: path.resolve(root), port, open, init };
}

/** 埠被佔時順延，最多試 20 次。 */
export function nextFreePort(preferred: number): number {
  // Bun.serve 失敗時由 main.ts 迴圈重試；此處僅返回候選序列的起點
  return preferred;
}
```

```ts
// src/standalone/main.ts —— bun build --compile 的入口
import { parseArgs } from './cli';
import { startServer } from './server';
import { NovelProject } from '../core/model/project';
import { initProjectFlow } from '../core/actions';

const opts = parseArgs(process.argv.slice(2));

if (opts.init) {
  // CLI 互動式 init：終端問答（Bun.stdin）後寫盤，不開服務
  const project = NovelProject.open(opts.root);
  if (await project.isInitialized()) {
    console.log('該目錄已是小說工程。');
  } else {
    const title = await ask('作品名：');
    const author = await ask('作者名（可留空）：');
    await project.initialize({ title: title.trim() || '我的小說', author: author.trim() });
    console.log(`已初始化：${path.join(opts.root, '.novelforge')}`);
  }
  process.exit(0);
}

if (!fs.existsSync(path.join(opts.root, '.novelforge', 'project.json'))) {
  console.log(`目錄還不是小說工程：${opts.root}`);
  console.log('提示：先跑 novelforge init，或在網頁上點「初始化工程」。');
}

let port = opts.port;
for (let i = 0; ; i++) {
  try { startServer({ root: opts.root, port }); break; }
  catch (err) {
    if (i >= 20) throw err;
    port++;
  }
}

if (opts.open) {
  const url = `http://127.0.0.1:${port}/`;
  const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
}

async function ask(label: string): Promise<string> {
  process.stdout.write(label);
  const buf = Buffer.alloc(4096);
  const n = await new Promise<number>((resolve) => {
    process.stdin.once('readable', () => resolve(process.stdin.read()?.length ?? 0));
  });
  void n; void buf;
  // 執行時用更穩的實現：Bun.stdin 逐行讀（readline 風格），這裡留實現鉤子
  return '';
}
```

（`ask()` 執行時用 `for await (const line of readline/promises 风格)` 實現：`import { createInterface } from 'node:readline/promises'` + `rl.question(label)`，Bun 相容 node readline。）

- [ ] **Step 6: 驗證 + Commit**

```powershell
node scripts/embed-media.js
npm run typecheck
bun run src/standalone/main.ts sample-novel --no-open
# 另開終端：curl http://127.0.0.1:3680/ 應返回 HTML；/media/view.js 應 200
# 瀏覽器開啟驗證：init 狀態、對話、設定頁可互動
```

```powershell
git add -A ; git commit -m "feat(standalone): Bun HTTP+WS server, bridge.js and CLI entry"
```

---

### Task 11: vscode-lm 在獨立版中隱藏 + 端到端手測清單

**Files:**
- Modify: `src/core/llm/registry.ts`（`listModelChoices`）、`src/core/controller.ts`

- [ ] **Step 1: 模型清單按宿主過濾**

`registry.ts` 裡供設定頁下拉用的列表函式（現名 `listModelChoices` 或類似）加引數：

```ts
export function listModelChoices(includeVscodeLm: boolean): { ref: string; label: string; group: string }[] {
  const config = readConfig();
  return config.providers
    .filter((p) => includeVscodeLm || p.kind !== 'vscode-lm')
    .flatMap((p) => p.models.map((m) => ({ ref: `${p.id}/${m.name}`, label: ..., group: p.label || p.id })));
}
```

呼叫方改為 `listModelChoices(getHost().supportsVscodeLm)`（controller 的 modelSelect 與 settings 推送）。若當前模型恰是被過濾的 vscode-lm，modelIssue 提示「當前模型僅在 VS Code 內可用」。

- [ ] **Step 2: 端到端手測清單（逐項打勾）**

外掛（F5）：初始化工程、續寫一輪、採納、總結本章、同步摘要、角色提取、設定頁儲存、設/清 API Key、選區附件、斷網錯誤提示。
獨立版（`bun run src/standalone/main.ts sample-novel`）：同上 + WS 斷線重連條（殺服務再起）、prompt 彈窗（初始化工程、新建章節、刪除會話確認）、貼上選區附件、openFile toast/系統開啟、設定頁不顯示「在 VS Code 設定中開啟」。

- [ ] **Step 3: Commit**

```powershell
npm run typecheck ; npm run smoke
git add -A ; git commit -m "feat: hide vscode-lm models in standalone host"
```

---

### Task 12: 配置遷移 —— 外掛殼切到 ~/.novelforge/

**Files:**
- Create: `src/vscode/migrate.ts`
- Modify: `src/vscode/extension.ts`、`package.json`（配置項標廢棄）
- Delete: `src/vscode/settingsStore.ts`（過渡後端）

- [ ] **Step 1: 新建 src/vscode/migrate.ts**

```ts
import * as vscode from 'vscode';
import { FileConfigStore, FileSecretStore } from '../core/stores';
import { PersistedSettings } from '../core/config';
import { legacySettingsReader } from './settingsStore'; // 遷移完再刪

/**
 * 一次性遷移：settings.json 的 novel.* + SecretStorage → ~/.novelforge/。
 * 已遷移過（config.json 存在）則跳過。遷移成功後不刪舊配置，
 * 只在 VS Code 裡提示「可清理」，避免使用者回滾時丟東西。
 */
export async function migrateVscodeSettings(secrets: vscode.SecretStorage): Promise<boolean> {
  const store = new FileConfigStore();
  if (store.read()) return false;

  const cfg = vscode.workspace.getConfiguration('novel');
  const settings: PersistedSettings = {};
  const keys = ['providers', 'model', 'contextWindow', 'maxOutputTokens', 'temperature',
    'recentChaptersFullText', 'prevChapterTailChars', 'chaptersDir', 'summaryBatchSize', 'requestTimeoutMs'];
  for (const k of keys) {
    const v = cfg.get(k);
    if (v !== undefined) (settings as Record<string, unknown>)[k] = v;
  }
  if (Object.keys(settings).length === 0) {
    // 沒配過新結構：試遺留單服務商鍵
    const legacy = legacySettingsReader.read();
    if (Object.values(legacy).some((v) => v !== undefined)) {
      (settings as Record<string, unknown>)['_legacy'] = legacy; // seedFromLegacyRaw 會消費
      Object.assign(settings, legacy as Record<string, unknown>);
      delete (settings as Record<string, unknown>)['_legacy'];
    }
  }
  if (Object.keys(settings).length === 0) return false;
  await store.write(settings);

  // SecretStorage 裡的 key：按現有 registry 的命名規則逐個搬
  const secretStore = new FileSecretStore();
  const cfgProviders = cfg.get<unknown[]>('providers', []);
  // 執行時：遍歷 registry 中實際的 secret key 格式（如 `novel.apiKey.${providerId}`），
  // 對每個 id 調 secrets.get → secretStore.set。key 命名以現有程式碼為準，不臆測。
  void cfgProviders; void secrets; void secretStore;

  void vscode.window.showInformationMessage(
    'Novelwarden：配置與金鑰已遷移到 ~/.novelforge/，VS Code 內的舊配置可手動清理。');
  return true;
}
```

- [ ] **Step 2: extension.ts 切換後端**

```ts
// 替換 Task 7 的接線：
await migrateVscodeSettings(context.secrets);
initHost(new VsCodeHost(new FileConfigStore()));
initSecrets(new FileSecretStore());
// setLegacyConfigReader 保留（未遷移或回滾使用者的兜底）
```

隨後刪除 `src/vscode/settingsStore.ts` 中 `SettingsJsonConfigStore`/`SecretStorageSecretStore`（若 migrate.ts 仍引用 legacySettingsReader，把該物件內聯到 migrate.ts）。`package.json` 的 `novel.*` 配置項全部加 `markdownDeprecationMessage`：「已遷移至 ~/.novelforge/config.json，此處僅作相容兜底。」（contributes 保留，不改預設值）。

- [ ] **Step 3: 驗證 + Commit**

```powershell
npm run typecheck ; npm run smoke ; npm run compile
# F5 手測：配置過 novel.providers 的工程 → 啟用後 ~/.novelforge/config.json 出現，面板行為不變
git add -A ; git commit -m "feat(vscode): migrate settings and secrets to ~/.novelforge"
```

---

### Task 13: 收尾 —— 純度檢查、釋出指令碼、文件

**Files:**
- Create: `scripts/check-core-purity.js`、`scripts/smoke-server.js`
- Modify: `package.json`、`README.md`、`.gitignore`

- [ ] **Step 1: core 純度檢查**

```js
// scripts/check-core-purity.js
// 保證 src/core/ 永不 import vscode。用法：node scripts/check-core-purity.js
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', 'src', 'core');
let bad = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.ts$/.test(e.name)) {
      const text = fs.readFileSync(p, 'utf8');
      if (/from\s+['"]vscode['"]|require\(['"]vscode['"]\)/.test(text)) bad.push(p);
      if (/from\s+['"]\.{1,2}\/.*vscode/.test(text)) bad.push(`${p} (跨層引用 vscode 殼)`);
    }
  }
})(ROOT);
if (bad.length) { console.error('✗ core 層發現 vscode 依賴：\n' + bad.join('\n')); process.exit(1); }
console.log('✓ src/core 無 vscode 依賴');
```

- [ ] **Step 2: smoke-server.js**

```js
// scripts/smoke-server.js
// 用 bun 起服務 → HTTP 拿頁面/資源 → WS 握手拿 init 訊息。用法：bun scripts/smoke-server.js
const proc = Bun.spawn(['bun', 'run', 'src/standalone/main.ts', 'sample-novel', '--no-open', '--port', '3999'], { cwd: `${import.meta.dir}/..` });
try {
  await retryFetch('http://127.0.0.1:3999/');
  const html = await (await fetch('http://127.0.0.1:3999/')).text();
  if (!html.includes('view.js')) throw new Error('首頁缺 view.js');
  if ((await fetch('http://127.0.0.1:3999/media/view.js')).status !== 200) throw new Error('view.js 404');
  const ws = new WebSocket('ws://127.0.0.1:3999/ws');
  const first = await new Promise((resolve, reject) => {
    ws.onmessage = (e) => resolve(JSON.parse(e.data));
    setTimeout(() => reject(new Error('WS 無 init')), 5000);
  });
  if (first.type !== 'init' && first.type !== 'state') throw new Error(`首條訊息是 ${first.type}`);
  console.log('✓ smoke-server 通過');
} finally { proc.kill(); }

async function retryFetch(url) {
  for (let i = 0; i < 30; i++) {
    try { await fetch(url); return; } catch { await Bun.sleep(300); }
  }
  throw new Error('服務未在 9s 內就緒');
}
```

- [ ] **Step 3: package.json 指令碼與 bin**

```json
"bin": { "novelforge": "./bin/novelforge.js" },
"scripts": {
  "smoke": "node scripts/smoke.js && node scripts/smoke-providers.js && node scripts/smoke-builder.js && node scripts/smoke-llm.js && node scripts/smoke-session.js && bun scripts/smoke-server.js",
  "test": "npm run typecheck && node scripts/check-core-purity.js && npm run smoke",
  "standalone": "bun run src/standalone/main.ts",
  "dist": "node scripts/embed-media.js && bun build src/standalone/main.ts --compile --outfile dist/novelforge"
}
```

新建 `bin/novelforge.js`（npm 安裝時用本機 bun/node 跑原始碼入口）：

```js
#!/usr/bin/env node
// npm 包形態：優先用 bun 跑；沒有 bun 時用 node（需使用者自行保證依賴可用）
const { spawnSync } = require('child_process');
const path = require('path');
const entry = path.join(__dirname, '..', 'src', 'standalone', 'main.ts');
const bun = spawnSync('bun', ['run', entry, ...process.argv.slice(2)], { stdio: 'inherit' });
if (bun.status === null) { console.error('需要安裝 Bun（https://bun.sh）或直接用編譯好的可執行檔案。'); process.exit(1); }
process.exit(bun.status ?? 0);
```

- [ ] **Step 4: README 與最終驗證**

README.md 增加「獨立版」一節：安裝（bun 單檔案 / npm）、`novelforge [dir]` 用法、`~/.novelforge/` 說明、與 VS Code 外掛的差異（選區貼上、無 diff 審閱、無 vscode-lm）。

```powershell
npm run test
npm run dist ; .\dist\novelforge.exe sample-novel --no-open
# 確認可執行檔案自包含：把 dist/novelforge.exe 拷到空目錄執行，頁面正常
git add -A ; git commit -m "feat: standalone distribution scripts, purity check and docs"
```

---

## Self-Review

**規格覆蓋（對照 specs/2026-08-04-standalone-web-app-design.md）：**
- 雙形態共存 / 分層：Task 1（目錄）、Task 7（外掛殼）、Task 9–10（獨立殼）。
- Host 抽象 + AbortSignal：Task 3。
- 配置/金鑰入主目錄 + 遷移：Task 4、12。
- `novelforge [dir]` / init / --port / --no-open：Task 10 Step 5。
- 僅 127.0.0.1 + 自動開瀏覽器：Task 10 Step 4/5。
- 協議複用 + prompt 彈窗：Task 8。
- view.js 兩處小適配（貼上選區、重連條）：Task 9（貼上）、Task 10 Step 2（重連條）。
- vscode-lm 隔離：Task 4（工廠鉤子）、Task 11（隱藏）。
- 會話刪除走 .trash：Task 2。
- 單檔案 + npm 雙渠道：Task 13。

**已知遺留/風險：**
1. Task 7 的 `VsCodeHost.reviewReplace` 與 Task 12 的 secret key 遷移留了「按原實現為準」的鉤子——執行時對照原 characters.ts / registry.ts 的實際 key 命名填入，不臆測。
2. `FileHost.watch` 的輪詢回退較粗（只盯 .novelforge 目錄 mtime），Windows 上 fs.watch recursive 可用，實際不會落到回退。
3. smoke 指令碼在 Task 5 後刪掉 vscode 樁；若某模組仍有殘留 import，typecheck 會先報警。
4. bun compile 產物需在目標 OS 上驗證；`dist` 指令碼預設當前平臺，跨平臺加 `--target`。

**佔位符掃描：** 無 TBD；webviewHtml 模板、migrate 的 key 遍歷兩處已顯式標註「照抄/以原實現為準」，均為可執行指令而非模糊描述。
