import { AsyncLocalStorage } from 'node:async_hooks';
import { ConfigStore } from '../../core/config';
import { Disposable, Host, InputOptions, MergeTextsOptions, PickChoice, ReviewVerdict } from '../../core/host';
import { CallAnswer, CallPrompt } from '../../core/model/callChoice';
import { NovelProject } from '../../core/model/project';
import { Attachment } from '../../core/model/session';
import { EditorFileCheck, EditorOpenIntent, EditorPane } from '../../core/protocol';
import { FileHost } from './fileHost';

/**
 * 一次呼叫是替哪個視窗做的：彈窗、toast、開啟編輯器都該落到那幾個網頁上。
 * `owner` 是工程根，空視窗沒有。
 */
export interface WindowScope {
  host: FileHost;
  owner?: string;
}

const scopes = new AsyncLocalStorage<WindowScope>();

/** 在這個視窗的上下文裡跑 `fn`。它裡面（含所有 await 之後）的 `getHost()` 都落到 `scope.host`。 */
export function runInScope<T>(scope: WindowScope, fn: () => T): T {
  return scopes.run(scope, fn);
}

export function currentScope(): WindowScope | undefined {
  return scopes.getStore();
}

/**
 * 獨立版註冊給 core 的那個全域 Host。
 *
 * core 裡到處是 `getHost().toast(...)`、`getHost().confirm(...)`，而一個程序同時開著幾個工程、
 * 幾個視窗：這一層按呼叫所在的上下文（{@link runInScope}）轉給那個視窗自己的 `FileHost`。
 * 不在任何上下文裡（啟動期）就落到 `fallback`，它廣播給所有網頁。
 */
export class ScopedHost implements Host {
  readonly name = 'standalone' as const;
  readonly supportsVscodeLm = false;

  constructor(private readonly fallback: FileHost) {}

  get config(): ConfigStore {
    return this.fallback.config;
  }

  private get target(): FileHost {
    return currentScope()?.host ?? this.fallback;
  }

  input(opts: InputOptions): Promise<string | undefined> {
    return this.target.input(opts);
  }

  confirm(message: string, actions: string[], opts?: { modal?: boolean; detail?: string }): Promise<string | undefined> {
    return this.target.confirm(message, actions, opts);
  }

  confirmCall(message: string, actions: string[], opts: { detail?: string; call: CallPrompt }): Promise<CallAnswer | undefined> {
    return this.target.confirmCall(message, actions, opts);
  }

  pick<T>(choices: PickChoice<T>[], title: string): Promise<T | undefined> {
    return this.target.pick(choices, title);
  }

  progress<T>(title: string, fn: (signal: AbortSignal, report: (message: string) => void) => Promise<T>): Promise<T> {
    return this.target.progress(title, fn);
  }

  watch(project: NovelProject, onChange: () => void): Disposable {
    return this.target.watch(project, onChange);
  }

  openFile(relPath: string, intent?: EditorOpenIntent): Promise<void> {
    return this.target.openFile(relPath, intent);
  }

  toast(message: string, level?: 'info' | 'error'): void {
    this.target.toast(message, level);
  }

  selectionAttachment(project: NovelProject): Promise<Attachment | undefined> {
    return this.target.selectionAttachment(project);
  }

  browseFile(project: NovelProject): Promise<string | undefined> {
    return this.target.browseFile(project);
  }

  pickHostFile(opts: { title: string; extensions: string[]; startDir?: string }): Promise<string | undefined> {
    return this.target.pickHostFile(opts);
  }

  openInEditor(relPath: string, pane?: EditorPane, intent?: EditorOpenIntent): Promise<void> {
    return this.target.openInEditor(relPath, pane, intent);
  }

  openBeside(relPath: string, intent?: EditorOpenIntent): Promise<void> {
    return this.target.openBeside(relPath, intent);
  }

  saveFromEditor(relPath: string, text: string, baseHash?: string, opts?: { recreate?: boolean }): Promise<void> {
    return this.target.saveFromEditor(relPath, text, baseHash, opts);
  }

  checkEditorFiles(files: readonly EditorFileCheck[]): Promise<void> {
    return this.target.checkEditorFiles(files);
  }

  openExternal(relPath: string): Promise<void> {
    return this.target.openExternal(relPath);
  }

  reviewReplace(
    name: string,
    currentText: string,
    proposedText: string,
    relPath?: string,
    opts?: { merge?: boolean }
  ): Promise<ReviewVerdict> {
    return this.target.reviewReplace(name, currentText, proposedText, relPath, opts);
  }

  mergeTexts(title: string, before: string, after: string, opts?: MergeTextsOptions): Promise<ReviewVerdict> {
    return this.target.mergeTexts(title, before, after, opts);
  }

  revealText(relPath: string, quote: string): Promise<boolean> {
    return this.target.revealText(relPath, quote);
  }
}
