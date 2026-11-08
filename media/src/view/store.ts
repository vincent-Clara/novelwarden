/**
 * 對話頁的執行時狀態，以及輸入框草稿的存取。
 *
 * **前端無狀態**是這套介面的基本盤：一切資料來自 `ViewState` / `ProjectTree`
 * 的全量推送，webview 銷燬重建後一條 `ready` 就能完整恢復。這裡留下的只是
 * 純 UI 的東西——沒發出去的草稿、正在流式接收的是哪一條。
 */
import { DEFAULT_THINKING_DEPTH } from '../protocol';
import type { SerializedAttachment, SerializedSession, ViewState } from '../protocol';
import { acquireApi } from '../vscodeApi';
import { el } from './refs';

/** 側邊欄摺疊再展開時不丟草稿，網頁重新整理同理（獨立版落 localStorage）。 */
interface PersistedDraft {
  draft: string;
}

export const vscode = acquireApi<PersistedDraft>();

export const store: {
  state: ViewState | null;
  session: SerializedSession;
  attachments: SerializedAttachment[];
  busy: boolean;
  /** 正在流式接收的那條訊息 id。 */
  streamingId: string | null;
  /** turnId -> 該輪被取消勾選的上下文條目 id 集合。 */
  excluded: Set<string>;
  /**
   * 當前工作區 id。`null` 是獨立版空視窗；`undefined` 是還沒收到
   * `workspaces`（外掛永遠不會發這條，當成「有工程」）。
   */
  currentId: string | null | undefined;
  recents: { root: string; name: string }[];
  /** 設定「新視窗中開啟專案」（獨立版，隨 `workspaces` 推來）。 */
  openInNewWindow: boolean;
  /** 「新建一本書」的「放在」預設值（獨立版，隨 `workspaces` 推來）。 */
  newProjectParent?: string;
} = {
  state: null,
  // 會話的初值與後端 `SessionStore.create()` 對齊：情節大綱 · 討論。
  // 它一定會被第一條 `session` 訊息覆蓋，這裡只是讓首幀有東西可畫。
  session: {
    id: '',
    title: '',
    target: { kind: 'outline' },
    stage: 'outline',
    capability: 'discuss',
    thinking: DEFAULT_THINKING_DEPTH,
    turns: [],
  },
  attachments: [],
  busy: false,
  streamingId: null,
  excluded: new Set(),
  currentId: undefined,
  recents: [],
  openInNewWindow: true,
};

/** 獨立版空視窗為 false；外掛與已開啟的工程為 true。 */
export function hasWorkspace(): boolean {
  return store.currentId !== null;
}

export function restoreDraft(): void {
  const saved = vscode.getState();
  if (!saved) {
    return;
  }
  el.input.value = saved.draft || '';
}

export function persistDraft(): void {
  vscode.setState({ draft: el.input.value });
}

/**
 * 「開啟某個檔案」。獨立版有內建編輯器，走 openEditor 在右側開標籤頁；
 * 外掛裡沒有這塊 DOM，仍走 openFile 開 VS Code 的編輯器 tab。
 *
 * 用能力探測而不是判斷環境字串——`#wbEditor` 在不在，就是唯一的判據。
 */
const hasBuiltInEditor = !!document.getElementById('wbEditor');

export function openPath(path: string, opts?: { preview?: boolean }): void {
  if (!path) {
    return;
  }
  // 單擊工程頁的一行：內建編輯器裡開成臨時標籤（`preview`，後端原樣帶回，編輯器的開關關著時當正常標籤）。
  // 外掛那邊 openFile 開的是 VS Code 自己的編輯器，它有自己的預覽規矩，不帶這個標記。
  vscode.postMessage(
    hasBuiltInEditor
      ? { type: 'openEditor', path, ...(opts?.preview ? { preview: true } : {}) }
      : { type: 'openFile', path }
  );
}
