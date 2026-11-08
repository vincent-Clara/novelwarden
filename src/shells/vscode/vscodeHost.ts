import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readConfig } from '../../core/config';
import { Disposable, Host, InputOptions, PickChoice } from '../../core/host';
import { CancelledError } from '../../core/llm/provider';
import { CallAnswer, CallChoice, CallPrompt, describeCallChoice, TIERED_LABEL } from '../../core/model/callChoice';
import { CONTEXT_DETAIL_HINT, CONTEXT_DETAIL_LABEL, CONTEXT_DETAILS, ContextDetail } from '../../core/model/contextDetail';
import { NovelProject } from '../../core/model/project';
import { locateQuote } from '../../core/model/review';
import { Attachment } from '../../core/model/session';
import { watchGlobs } from '../../core/watchPolicy';
import { selectionAttachment } from './attachments';
import { isOutlinePath, outlineUri } from './outlineFs';

/**
 * 外掛殼的 Host 實現：把 core 的窄介面一一接回 VS Code 原生 API，
 * 互動體驗與改造前保持一致。
 */
/** 調模型之前的確認框上多的那一顆按鈕（`confirmCall`）。 */
const ADJUST_CALL = '換模型 / 詳細度…';

export class VsCodeHost implements Host {
  readonly name = 'vscode' as const;
  readonly supportsVscodeLm = true;

  constructor(public readonly config: import('../../core/config').ConfigStore) {}

  async input(opts: InputOptions): Promise<string | undefined> {
    return vscode.window.showInputBox({
      title: opts.title,
      prompt: opts.prompt,
      value: opts.value,
      placeHolder: opts.placeHolder,
      password: opts.password,
      ignoreFocusOut: true,
      validateInput: opts.validate ? (v) => opts.validate!(v) : undefined,
    });
  }

  async confirm(
    message: string,
    actions: string[],
    opts?: { modal?: boolean; detail?: string }
  ): Promise<string | undefined> {
    return vscode.window.showInformationMessage(
      `Novelwarden：${message}`,
      { modal: opts?.modal ?? false, detail: opts?.detail },
      ...actions
    );
  }

  /**
   * 調模型之前的那一問。原生模態框放不了下拉框：多一顆「換模型 / 詳細度…」，點了依次彈 QuickPick（模型；這一次看
   * 詳細度時再選級別，Esc 是不改那一項），選完回到模態框。補充說明裡寫著「按分檔」時各項活交給誰與「這一次：……」。
   */
  async confirmCall(message: string, actions: string[], opts: { detail?: string; call: CallPrompt }): Promise<CallAnswer | undefined> {
    const { call } = opts;
    let choice: CallChoice = {
      ...(call.model ? { model: call.model } : {}),
      ...(call.contextDetail ? { contextDetail: call.contextDetail } : {}),
    };
    for (;;) {
      const detail = [opts.detail, choice.model ? '' : call.tiers.join('\n'), (call.fixed ?? []).join('\n'), `這一次：${describeCallChoice(choice)}`]
        .filter(Boolean)
        .join('\n\n');
      const picked = await vscode.window.showInformationMessage(
        `Novelwarden：${message}`,
        { modal: true, detail },
        ...actions,
        ADJUST_CALL
      );
      if (picked !== ADJUST_CALL) {
        return picked ? { action: picked, choice } : undefined;
      }
      choice = await this.adjustCall(call, choice);
    }
  }

  /** 「換模型 / 詳細度…」：兩個 QuickPick，當前選著的那一項標「當前」。 */
  private async adjustCall(call: CallPrompt, choice: CallChoice): Promise<CallChoice> {
    const current = (on: boolean) => (on ? '當前' : undefined);
    const model = await this.pick<string>(
      [
        { label: TIERED_LABEL, description: current(!choice.model), detail: '各項活按任務檔位走，失敗換同檔其餘模型', value: '' },
        ...call.models.map((m) => ({ label: m.ref, description: current(choice.model === m.ref), group: m.group, value: m.ref })),
      ],
      '這一次用哪個模型'
    );
    const next: CallChoice = { ...choice };
    if (model !== undefined) {
      delete next.model;
      if (model) {
        next.model = model;
      }
    }
    if (call.contextDetail) {
      const detail = await this.pick<ContextDetail>(
        CONTEXT_DETAILS.map((d) => ({
          label: `${d} · ${CONTEXT_DETAIL_LABEL[d]}`,
          description: current(next.contextDetail === d),
          detail: CONTEXT_DETAIL_HINT[d],
          value: d,
        })),
        '這一次帶多少上下文'
      );
      if (detail !== undefined) {
        next.contextDetail = detail;
      }
    }
    return next;
  }

  async pick<T>(choices: PickChoice<T>[], title: string): Promise<T | undefined> {
    const items: (vscode.QuickPickItem & { value: T })[] = [];
    let group = '';
    for (const c of choices) {
      // 同組只插一次分隔條，還原原 QuickPick 的分組觀感。
      if (c.group && c.group !== group) {
        group = c.group;
        items.push({ label: group, kind: vscode.QuickPickItemKind.Separator, value: undefined as T });
      }
      items.push({ label: c.label, description: c.description, detail: c.detail, value: c.value });
    }
    const picked = await vscode.window.showQuickPick(items, { title, matchOnDetail: true });
    return picked?.value;
  }

  async progress<T>(
    title: string,
    fn: (signal: AbortSignal, report: (message: string) => void) => Promise<T>
  ): Promise<T> {
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      async (progress, token) => {
        const abort = new AbortController();
        const sub = token.onCancellationRequested(() => abort.abort(new CancelledError()));
        try {
          return await fn(abort.signal, (message) => progress.report({ message }));
        } finally {
          sub.dispose();
        }
      }
    );
  }

  /** 機制是 VS Code 的 FileSystemWatcher；看哪些東西由 core 的 watchPolicy 說。 */
  watch(project: NovelProject, onChange: () => void): Disposable {
    const watchers = watchGlobs(readConfig()).map((p) =>
      vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(project.root, p))
    );
    for (const w of watchers) {
      w.onDidChange(onChange);
      w.onDidCreate(onChange);
      w.onDidDelete(onChange);
    }
    return { dispose: () => watchers.forEach((w) => w.dispose()) };
  }

  async openFile(relPath: string): Promise<void> {
    await this.show(relPath, vscode.ViewColumn.One);
  }

  /**
   * 「在旁邊開啟」：草稿開在正文旁邊一欄，兩邊同屏對照。
   *
   * `Beside` 是相對**當前活動編輯器**的。從側邊欄點過來時最後活動的文字
   * 編輯器通常就是正文（openFile 把它放在第一欄），草稿於是落到第二欄；
   * 若此刻活動的是對話面板那個 tab，草稿就開在它旁邊。夠用，不去糾正。
   */
  async openBeside(relPath: string): Promise<void> {
    await this.show(relPath, vscode.ViewColumn.Beside);
  }

  /**
   * 點審稿報告上的引文（五期）：開啟那一章、選中那一句、滾到它。定位用 core 的 `locateQuote`——
   * 與引文校驗同一個歸一化，報告裡說找得到的，這裡就選得中。
   */
  async revealText(relPath: string, quote: string): Promise<boolean> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const abs = root ? path.join(root, relPath) : relPath;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const at = locateQuote(doc.getText(), quote);
    if (!at) {
      return false;
    }
    const range = new vscode.Range(doc.positionAt(at.start), doc.positionAt(at.end));
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    return true;
  }

  private async show(relPath: string, viewColumn: vscode.ViewColumn): Promise<void> {
    // relPath 相對當前工作區根（與 currentProject() 的口徑一致）。
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const abs = root ? path.join(root, relPath) : relPath;
    // 情節大綱沒有檔案（各章細綱梗概的彙總）：開在虛擬檔案系統上（outlineFs.ts）。
    const uri = root && isOutlinePath(root, relPath) ? outlineUri(root) : vscode.Uri.file(abs);
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(uri),
      { viewColumn, preview: false }
    );
  }

  toast(message: string, level: 'info' | 'error' = 'info'): void {
    if (level === 'error') {
      void vscode.window.showErrorMessage(`Novelwarden：${message}`);
    } else {
      void vscode.window.showInformationMessage(`Novelwarden：${message}`);
    }
  }

  async selectionAttachment(project: NovelProject): Promise<Attachment | undefined> {
    return selectionAttachment(project);
  }

  async browseFile(project: NovelProject): Promise<string | undefined> {
    const uris = await vscode.window.showOpenDialog({
      title: '選擇要引用的檔案',
      canSelectMany: false,
      defaultUri: vscode.Uri.file(project.root),
      openLabel: '引用',
    });
    const uri = uris?.[0];
    return uri ? project.relPath(uri.fsPath) : undefined;
  }

  async pickHostFile(opts: { title: string; extensions: string[]; startDir?: string }): Promise<string | undefined> {
    const uris = await vscode.window.showOpenDialog({
      title: opts.title,
      canSelectMany: false,
      defaultUri: opts.startDir ? vscode.Uri.file(opts.startDir) : undefined,
      filters: { 文本: opts.extensions },
      openLabel: '選這一本',
    });
    return uris?.[0]?.fsPath;
  }

  /**
   * `opts.merge` 在這裡不認：VS Code 的 diff 編輯器本身就能看清改了什麼，逐段挑是獨立版合併檢視
   * 的事（總計劃 W11：VS Code 殼繼續用 `vscode.diff`）。永遠只答採納 / 放棄。
   */
  async reviewReplace(
    name: string,
    currentText: string,
    proposedText: string,
    relPath?: string,
    opts?: { merge?: boolean }
  ): Promise<'apply' | 'discard' | undefined> {
    void opts;
    // 保持原有 diff 體驗：當前檔案 ↔ 臨時建議檔案。untitled 文件不支援 diff 儲存，
    // 故建議內容先寫真實臨時檔案。
    void currentText; // 左側用磁碟上的現有檔案，無需內容
    // 臨時檔名取落點的檔名：`name` 是給人看的稱呼（「設定「…」」「第 12 章 · 劇情」），
    // 裡面可能有斜槓。
    const stem = (relPath ? path.basename(relPath, path.extname(relPath)) : name).replace(/[\\/:*?"<>|]/g, '_');
    const previewAbs = path.join(os.tmpdir(), `novelwarden-${Date.now()}-${stem}.proposed.md`);
    // 定位現有檔案認 relPath；只有老呼叫方沒給時才按名字找角色卡。從前一律按名字找，
    // 覆蓋大綱、細綱時左側是一片空白。
    const currentAbs = relPath ? this.absOf(relPath) : await this.findCharacterFile(name);
    await fs.writeFile(previewAbs, proposedText, 'utf8');

    try {
      await vscode.commands.executeCommand(
        'vscode.diff',
        currentAbs ? vscode.Uri.file(currentAbs) : vscode.Uri.parse('untitled:現有內容'),
        vscode.Uri.file(previewAbs),
        `${name}：現有 ↔ 建議`,
        { preview: true }
      );
      const pick = await vscode.window.showInformationMessage(
        `Novelwarden：是否採納對「${name}」的更新？`,
        { modal: true },
        '採納',
        '放棄'
      );
      return pick === '採納' ? 'apply' : pick === '放棄' ? 'discard' : undefined;
    } finally {
      try {
        await fs.rm(previewAbs, { force: true });
      } catch {
        /* 臨時檔案刪不掉不影響主流程 */
      }
    }
  }

  async openNativeSettings(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'novel.');
  }

  /** 工程相對路徑 → 絕對路徑（diff 左側）。沒開啟工作區返回 undefined。 */
  private absOf(relPath: string): string | undefined {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root ? path.join(root, relPath) : undefined;
  }

  /** 按角色名找到現有卡的絕對路徑（diff 左側）。找不到返回 undefined。 */
  private async findCharacterFile(name: string): Promise<string | undefined> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return undefined;
    }
    const project = NovelProject.open(root);
    const cards = await project.listCharacters();
    const card = cards.find((c) => c.name === name || c.aliases.includes(name));
    return card ? project.pathOf(card.relPath) : undefined;
  }
}
