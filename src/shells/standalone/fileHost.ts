import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ConfigStore } from '../../core/config';
import {
  checkEditorFiles,
  FileConflictError,
  FileEditError,
  FileGoneError,
  isEditablePath,
  readFileForEditor,
  writeFileFromEditor,
} from '../../core/files/fileEditing';
import { Disposable, Host, InputOptions, MergeTextsOptions, PickChoice, ReviewVerdict } from '../../core/host';
import { CallAnswer, CallPrompt, normalizeCallChoice } from '../../core/model/callChoice';
import { isChapterFileName } from '../../core/model/chapterFile';
import { NovelProject } from '../../core/model/project';
import { locateQuote } from '../../core/model/review';
import { Attachment } from '../../core/model/session';
import { EditorFileCheck, EditorFileView, EditorOpenIntent, EditorPane, OutMessage } from '../../core/protocol';
import { describeEditorFile } from '../../core/views/editorLabel';
import { shouldIgnoreChange } from '../../core/watchPolicy';
import { ArtifactKind, kindOfPath } from '../../core/workspace/kind';
import { PromptHub } from './promptHub';
import { openWithSystem } from './systemOpen';

/**
 * 獨立 Web 服務殼的 Host 實現。
 *
 * 互動（input/confirm/pick）經 WebSocket 變成網頁彈窗（PromptHub）；
 * 進度降級為 toast；檔案監聽用 fs.watch（失敗退化為輪詢）；
 * 「開啟檔案」交給網頁裡的內建編輯器，非文字檔案才回落到系統預設程式。
 */
export class FileHost implements Host {
  readonly name = 'standalone' as const;
  readonly supportsVscodeLm = false;
  readonly prompts: PromptHub;
  /**
   * 用來回答「這份檔案是不是某一章、它的草稿在哪」。
   * 只做純路徑推導，不快取章節列表——那份快取歸 controller 持有的例項管。
   */
  private project: NovelProject | undefined;
  /** 小說工程根目錄；openFile 據此解析相對路徑。空視窗時沒有。 */
  private root: string | undefined;

  constructor(
    public readonly config: ConfigStore,
    private readonly broadcastMsg: (msg: OutMessage) => void,
    root?: string
  ) {
    this.prompts = new PromptHub(broadcastMsg);
    if (root) {
      this.bind(root);
    }
  }

  /** 綁到一個工程目錄。熱換時由 WorkspaceHub 呼叫。 */
  bind(root: string): NovelProject {
    this.root = root;
    this.project = NovelProject.open(root);
    return this.project;
  }

  /** 卸掉當前工程。空視窗。 */
  unbind(): void {
    this.root = undefined;
    this.project = undefined;
  }

  async input(opts: InputOptions): Promise<string | undefined> {
    const { value } = await this.prompts.ask({
      kind: 'input',
      title: opts.title ?? '輸入',
      message: opts.prompt,
      placeholder: opts.placeHolder,
      value: opts.value,
      password: opts.password,
      multiline: opts.multiline,
    });
    if (value === undefined) {
      return undefined;
    }
    if (opts.validate) {
      const err = opts.validate(value);
      if (err) {
        this.toast(err, 'error');
        return this.input(opts);
      }
    }
    return value;
  }

  /** 網頁確認框：一個 action 一顆按鈕，回的是點的那顆上的字（標題取第一顆）。 */
  async confirm(message: string, actions: string[], opts?: { detail?: string }): Promise<string | undefined> {
    const { value } = await this.prompts.ask({ kind: 'confirm', title: actions[0] ?? '確認', message, value: opts?.detail, actions });
    return value !== undefined && actions.includes(value) ? value : undefined;
  }

  /** 同一個網頁確認框，按鈕上面多兩個下拉框（模型、上下文詳細度），回答另帶作者的選擇。 */
  async confirmCall(message: string, actions: string[], opts: { detail?: string; call: CallPrompt }): Promise<CallAnswer | undefined> {
    const { value, choice } = await this.prompts.ask({
      kind: 'confirm',
      title: actions[0] ?? '確認',
      message,
      value: opts.detail,
      actions,
      call: opts.call,
    });
    return value !== undefined && actions.includes(value) ? { action: value, choice: normalizeCallChoice(choice) ?? {} } : undefined;
  }

  async pick<T>(choices: PickChoice<T>[], title: string): Promise<T | undefined> {
    const labels = choices.map((c) => (c.description ? `${c.label}（${c.description}）` : c.label));
    const { value: picked } = await this.prompts.ask({ kind: 'pick', title, options: labels });
    if (!picked) {
      return undefined;
    }
    const idx = labels.indexOf(picked);
    return idx >= 0 ? choices[idx].value : undefined;
  }

  /** 網頁裡的本機目錄選擇器（`folderPicker.ts` 的選檔案模式）：只列目錄與這幾種副檔名，回絕對路徑。 */
  async pickHostFile(opts: { title: string; extensions: string[]; startDir?: string }): Promise<string | undefined> {
    const { value: picked } = await this.prompts.ask({
      kind: 'file',
      title: opts.title,
      value: opts.startDir ?? this.root,
      options: opts.extensions,
    });
    return picked || undefined;
  }

  /**
   * 長任務。**不再為每次進度彈 toast**——`core/runtime/progress.ts` 把同一份進度
   * 結構化推給了網頁，工程頁頂部有進度條與計時，逐條 toast 只會連著刷屏
   * 把別的提示蓋掉。這裡只負責給出 signal，以及把失敗原因報出來。
   *
   * 取消：網頁點進度條上的「停止」走 `cancelTask`，那邊直接 abort
   * `runTask` 自己的 controller，因此這裡不需要額外的取消入口。
   */
  async progress<T>(
    title: string,
    fn: (signal: AbortSignal, report: (message: string) => void) => Promise<T>
  ): Promise<T> {
    void title; // 展示名由 core/runtime/progress.ts 推給網頁，這裡用不上
    const abort = new AbortController();
    try {
      return await fn(abort.signal, () => undefined);
    } catch (err) {
      this.toast(err instanceof Error ? err.message : String(err), 'error');
      throw err;
    }
  }

  watch(project: NovelProject, onChange: () => void): Disposable {
    // 去抖：onChange 會觸發 pushState，那是一次全量重掃（每章讀盤算摘要新鮮度）。
    // 編輯器連續儲存、Git 切分支這類操作會連著扔出十幾個事件，逐個跑一遍沒必要。
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fire = (): void => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(onChange, 250);
    };

    // 優先 fs.watch（recursive）；不支援時退化為 1s 輪詢。
    // 「哪些改動值得重新整理」由 core 的 watchPolicy 說，這裡只管機制。
    try {
      const watcher = fs.watch(project.root, { recursive: true }, (_event, filename) => {
        if (shouldIgnoreChange(String(filename ?? ''))) {
          return;
        }
        fire();
      });
      return {
        dispose: () => {
          if (timer) {
            clearTimeout(timer);
          }
          watcher.close();
        },
      };
    } catch {
      const timer2 = setInterval(() => {
        // 輪詢兜底：目錄可訪問就觸發一次重新整理（pushState 內部會合併）。
        void fsp.stat(project.novelDir).then(onChange, () => undefined);
      }, 1000);
      return { dispose: () => clearInterval(timer2) };
    }
  }

  /**
   * 「開啟檔案」。文字檔案進網頁的內建編輯器，其餘（圖片等）交系統預設程式。
   *
   * 這裡刻意讓 openFile 也走編輯器：controller 裡「採納寫入後開啟」
   * 「點章節名」「點上下文條目」全都調它，改這一處，三處都對。
   */
  async openFile(relPath: string, intent?: EditorOpenIntent): Promise<void> {
    if (isEditablePath(relPath)) {
      await this.openInEditor(relPath, undefined, intent);
      return;
    }
    await this.openExternal(relPath);
  }

  /**
   * 讀一份快照廣播給前端，網頁裡開標籤頁。失敗只報錯，不拋給 controller。
   * `intent`（臨時標籤 / 原位換掉）後端不看，原樣帶回 `editorOpen`，由內建編輯器決定新開還是複用。
   */
  async openInEditor(relPath: string, pane?: EditorPane, intent?: EditorOpenIntent): Promise<void> {
    if (!this.root) {
      this.broadcastMsg({ type: 'editorError', path: relPath, message: '請先開啟資料夾' });
      return;
    }
    try {
      const file = await readFileForEditor(this.root, relPath);
      this.broadcastMsg({
        type: 'editorOpen',
        file: this.viewOf(file),
        pane,
        ...(intent?.preview ? { preview: true } : {}),
        ...(intent?.replace ? { replace: intent.replace } : {}),
      });
    } catch (err) {
      if (err instanceof FileEditError) {
        this.broadcastMsg({ type: 'editorError', path: relPath, message: err.message });
        return;
      }
      throw err;
    }
  }

  /** 「在旁邊開啟」= 開在第二塊編輯區（草稿區）。 */
  async openBeside(relPath: string, intent?: EditorOpenIntent): Promise<void> {
    if (!isEditablePath(relPath)) {
      await this.openExternal(relPath);
      return;
    }
    await this.openInEditor(relPath, 'draft', intent);
  }

  /**
   * 推給內建編輯器的那一份：磁碟上讀來的內容，加上後端才說得清的三樣——草稿在哪（`draftPath`）、
   * 是什麼（`kind`）、怎麼稱呼（`label`：標籤上的短標記與名字、工具欄的麵包屑）。`editorOpen` /
   * `editorSaved` / `editorDiskChanged` 三處同一個形狀，漏一處前端就會在儲存一次之後忘掉。
   */
  private viewOf(file: EditorFileView): EditorFileView {
    return {
      ...file,
      draftPath: this.draftPathOf(file.path),
      kind: this.kindOf(file.path),
      ...(this.project ? { label: describeEditorFile(this.project, file.path) } : {}),
    };
  }

  /**
   * 這份檔案是章節正文時，給出它草稿的相對路徑；否則 undefined。
   *
   * 「在章節根之下」由 draftRelPathFor 判定，「檔名像章節」由
   * isChapterFileName 判定——兩半都複用現成的，不在這裡寫第三份規則。
   */
  private draftPathOf(rel: string): string | undefined {
    if (!this.project) {
      return undefined;
    }
    const draft = this.project.draftRelPathFor(rel);
    if (!draft || draft === rel) {
      return undefined;
    }
    return isChapterFileName(path.basename(rel)) ? draft : undefined;
  }

  /**
   * 這份檔案在工程裡是什麼（`kindOfPath`，與閘道器同一張表）。前端據此分「正文」與其餘檔案
   * （Tab 縮排全形還是半形），不自己拿路徑猜。沒開啟工程時 undefined，前端當非正文。
   */
  private kindOf(rel: string): ArtifactKind | undefined {
    return this.project ? kindOfPath(this.project, rel).kind : undefined;
  }

  /**
   * 儲存編輯器內容。衝突不覆蓋，改為把磁碟版本回給前端讓使用者取捨；帶了基線而檔案已經不在時
   * 也不重建（`FileGoneError` → `editorDiskGone`），作者答應了才帶 `recreate` 再來。
   */
  async saveFromEditor(relPath: string, text: string, baseHash?: string, opts?: { recreate?: boolean }): Promise<void> {
    if (!this.root) {
      this.broadcastMsg({ type: 'editorError', path: relPath, message: '請先開啟資料夾' });
      return;
    }
    try {
      const file = await writeFileFromEditor(this.root, relPath, text, baseHash, opts);
      // draftPath、kind 與 label 要一併帶回：前端的儲存分支只更新 text/hash，
      // 這裡漏掉 draftPath 的話工具欄上的「草稿」按鈕會在首次儲存後消失。
      this.broadcastMsg({ type: 'editorSaved', file: this.viewOf(file) });
    } catch (err) {
      if (err instanceof FileGoneError) {
        this.broadcastMsg({ type: 'editorDiskGone', path: relPath });
        return;
      }
      if (err instanceof FileConflictError) {
        this.broadcastMsg({
          type: 'editorConflict',
          path: relPath,
          diskText: err.diskText,
          diskHash: err.diskHash,
        });
        return;
      }
      if (err instanceof FileEditError) {
        this.broadcastMsg({ type: 'editorError', path: relPath, message: err.message });
        return;
      }
      throw err;
    }
  }

  /**
   * 核對編輯器裡開著的幾份檔案（`checkEditorFiles`）。變了的推 `editorDiskChanged`（帶 draftPath / kind，
   * 與 editorOpen 同一個形狀），讀不到的推 `editorDiskGone`，沒變的什麼都不推。
   */
  async checkEditorFiles(files: readonly EditorFileCheck[]): Promise<void> {
    if (!this.root) {
      return;
    }
    const report = await checkEditorFiles(this.root, files);
    for (const file of report.changed) {
      this.broadcastMsg({ type: 'editorDiskChanged', file: this.viewOf(file) });
    }
    for (const gone of report.gone) {
      this.broadcastMsg({ type: 'editorDiskGone', path: gone });
    }
  }

  /** 用系統預設程式開啟（使用者自己的編輯器 / 圖片檢視器）。 */
  async openExternal(relPath: string): Promise<void> {
    try {
      if (!this.root) {
        this.toast('請先開啟資料夾', 'error');
        return;
      }
      openWithSystem(path.resolve(this.root, relPath));
      this.toast(`已用系統程式開啟：${relPath}`);
    } catch {
      this.toast(`無法開啟：${relPath}，請手動開啟。`);
    }
  }

  toast(message: string, level: 'info' | 'error' = 'info'): void {
    this.broadcastMsg({ type: 'toast', message, level });
  }

  async selectionAttachment(project: NovelProject): Promise<Attachment | undefined> {
    void project;
    // 內建編輯器裡選著字時前端已經把選區帶上來了（controller 不會走到這裡）；走到這裡是沒選中，彈貼上框，存快照。
    const text = await this.input({
      title: '加入選區',
      prompt: '貼上要引用的原文',
      multiline: true,
      placeHolder: '在編輯器裡複製後貼上到這裡',
      validate: (v) => (v.trim() ? undefined : '不能為空'),
    });
    if (text === undefined) {
      return undefined;
    }
    return {
      id: `paste-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'selection',
      label: '貼上的選區',
      text,
    };
  }

  async browseFile(project: NovelProject): Promise<string | undefined> {
    const rel = await this.input({
      title: '引用檔案',
      prompt: '輸入工程內的相對路徑（如 chapters/003.md）',
      validate: (v) => {
        const abs = project.pathOf(v.trim());
        if (!fs.existsSync(abs)) {
          return '檔案不存在';
        }
        return undefined;
      },
    });
    return rel?.trim();
  }

  /**
   * 覆蓋前審閱：網頁上開段級 diff / 合併檢視（五期 W11，`media/src/view/merge.ts`）。
   *
   * 呼叫方請求了合併（`opts.merge`，閘道器的覆蓋審閱）：作者可以逐段「採用新版 / 保留原文」、
   * 在結果格里手改，交回來的是挑過的那一份。沒請求的（角色卡、設定條目那幾處）只讀，
   * 只有採納 / 放棄——它們收不下一份作者拼出來的文字。
   *
   * `name` 是呼叫方給的稱呼，可能是角色卡、設定、大綱、細綱或正文——從前這裡寫死成
   * 「將更新角色卡」，覆蓋大綱時也這麼說。
   */
  async reviewReplace(
    name: string,
    currentText: string,
    proposedText: string,
    relPath?: string,
    opts?: { merge?: boolean }
  ): Promise<ReviewVerdict> {
    const { value } = await this.prompts.ask({
      kind: 'merge',
      title: `對比「${name}」：現有 ↔ 新版`,
      message: relPath,
      current: currentText,
      proposed: proposedText,
      mergeable: !!opts?.merge,
    });
    return parseMergeReply(value, !!opts?.merge);
  }

  async mergeTexts(title: string, before: string, after: string, opts?: MergeTextsOptions): Promise<ReviewVerdict> {
    const { value } = await this.prompts.ask({
      kind: 'merge',
      title,
      message: opts?.message,
      current: before,
      proposed: after,
      mergeable: true,
      sides: opts?.sides && { current: opts.sides.before, proposed: opts.sides.after },
      applyLabel: opts?.applyLabel,
    });
    return parseMergeReply(value, true);
  }

  /**
   * 點審稿報告上的引文（五期）：內建編輯器裡開啟那一章，再推一條 `editorReveal` 讓它選中那一句。
   * 找不到那一句（正文改過）時只開啟、返回 false。
   */
  async revealText(relPath: string, quote: string): Promise<boolean> {
    if (!this.root) {
      this.broadcastMsg({ type: 'editorError', path: relPath, message: '請先開啟資料夾' });
      return false;
    }
    await this.openInEditor(relPath);
    let text = '';
    try {
      text = (await readFileForEditor(this.root, relPath)).text;
    } catch {
      return false;
    }
    if (!locateQuote(text, quote)) {
      return false;
    }
    this.broadcastMsg({ type: 'editorReveal', path: relPath, quote });
    return true;
  }

  // standalone 沒有 openNativeSettings：前端已隱藏按鈕，此處不提供。
}

/**
 * 合併檢視的回答（協議 `prompt kind: 'merge'`）：`{"verdict":"apply"|"discard","merged"?}` 的 JSON。
 * 認不出、或者沒回答（關掉了），當取消——寧可這一次不寫。只讀模式下交回來的 `merged` 不認。
 */
export function parseMergeReply(value: string | undefined, mergeable: boolean): ReviewVerdict {
  if (value === undefined) {
    return undefined;
  }
  let o: { verdict?: unknown; merged?: unknown };
  try {
    o = JSON.parse(value) as typeof o;
  } catch {
    return undefined;
  }
  if (o.verdict === 'discard') {
    return 'discard';
  }
  if (o.verdict !== 'apply') {
    return undefined;
  }
  return mergeable && typeof o.merged === 'string' ? { merged: o.merged } : 'apply';
}
