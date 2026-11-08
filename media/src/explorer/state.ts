/**
 * 資源管理器的全部可變狀態，以及 localStorage 的讀寫。
 *
 * 單獨拎出來的理由：rows.ts 建行時要讀展開集合、剪貼簿、當前高亮，
 * index.ts 收訊息時要寫它們——把狀態攤在模組作用域裡，兩邊就都不必
 * 互相 import 對方的內部欄位。
 */
import { projectStorageKey } from '../globals';
import type { DirListing, FsEntry } from '../protocol';

const OPEN_KEY = 'novelforge.files.open';

/** 剪貼簿：剪下/複製只是登記，真正的磁碟動作只有「貼上」一次。 */
export interface Clipboard {
  op: 'cut' | 'copy';
  paths: string[];
}

/**
 * 展開著的目錄（工程內相對路徑，空串是工程根）。
 *
 * 工程根永遠在集合裡：它就是這棵樹本身，摺疊它等於把整頁清空。
 */
export const openDirs = new Set<string>(['']);

/** relPath -> DirListing。後端整批替換，這裡也整批更新。 */
export const listings = new Map<string, DirListing>();

/** 已經請求過、還沒等到回應的目錄：畫一行「載入中…」而不是空白。 */
export const pending = new Set<string>();

/** 可變的那幾項。放在一個物件裡，跨模組讀寫才拿得到最新值。 */
export const state: {
  /** 編輯器裡當前啟用的檔案路徑，樹上高亮它。 */
  activeFile: string | null;
  clipboard: Clipboard | null;
  /** 當前選中行（點選或鍵盤焦點到達的行）。Ctrl+X/C/V 作用在它上面。 */
  selectedEntry: FsEntry | null;
  /** 編輯器那邊「在檔案頁中定位」的那一個（檔案或目錄），那一行標出來。 */
  revealed: string | null;
  /** 定位了、但那一行還沒畫出來（它所在的目錄還在載入）：畫出來那一次滾過去。 */
  pendingScroll: string | null;
} = {
  activeFile: null,
  clipboard: null,
  selectedEntry: null,
  revealed: null,
  pendingScroll: null,
};

export function parentOf(relPath: string): string {
  const i = relPath.lastIndexOf('/');
  return i === -1 ? '' : relPath.slice(0, i);
}

/** 這一項是不是剪下的源（行要壓暗）。 */
export function isCut(relPath: string): boolean {
  return state.clipboard?.op === 'cut' && state.clipboard.paths.includes(relPath);
}

/**
 * 摺疊一個目錄時，連同它的子目錄一起收起來：再展開時它們不該憑空還開著，
 * 後端那邊也不必繼續為看不見的目錄讀盤。
 */
export function collapse(relPath: string): void {
  openDirs.delete(relPath);
  for (const dir of [...openDirs]) {
    if (dir.startsWith(`${relPath}/`)) {
      openDirs.delete(dir);
    }
  }
}

/** 展開到某個路徑（含其全部祖先目錄）。「定位當前檔案」與外部跳轉用。 */
export function expandTo(relPath: string): void {
  const parts = relPath.split('/');
  let cur = '';
  // 最後一段是檔案本身，不進展開集合。
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur ? `${cur}/${parts[i]}` : parts[i];
    openDirs.add(cur);
  }
}

/** 把已有結果標記為待重新整理，但不清空——清了會閃一下白。 */
export function markAllPending(): void {
  for (const dir of openDirs) {
    pending.add(dir);
  }
}

export function persistOpen(): void {
  try {
    localStorage.setItem(projectStorageKey(OPEN_KEY), JSON.stringify([...openDirs]));
  } catch {
    /* 隱私模式下寫不進去，退化為僅本次會話保留 */
  }
}

export function restoreOpen(): void {
  let saved: unknown;
  try {
    saved = JSON.parse(localStorage.getItem(projectStorageKey(OPEN_KEY)) || 'null');
  } catch {
    return;
  }
  if (!Array.isArray(saved)) {
    return;
  }
  for (const dir of saved) {
    if (typeof dir === 'string') {
      openDirs.add(dir);
    }
  }
}
