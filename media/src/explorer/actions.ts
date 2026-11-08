/**
 * 發給後端的那幾條訊息，以及剪貼簿動作。
 *
 * 單獨一層的理由：rows.ts（建選單項）與 index.ts（工具欄、快捷鍵）都要用，
 * 而它們之間不該互相 import。
 *
 * `bind` 是這一層與渲染之間唯一的接縫：改剪貼簿、展開目錄之後要重畫一遍樹，
 * 但 render 住在 index.ts 裡，直接 import 會繞成一個環。由 index.ts 啟動時
 * 把它遞進來，方向就只有一條。
 */
import { toast } from '../globals';
import type { InMessage } from '../protocol';
import { collapse, listings, markAllPending, openDirs, pending, persistOpen, state } from './state';

let post: (msg: InMessage) => void = () => {};
let repaint: () => void = () => {};

export function bind(deps: { post: (msg: InMessage) => void; render: () => void }): void {
  post = deps.post;
  repaint = deps.render;
}

/**
 * 把當前展開集合整個報給後端。摺疊也走這條——少一條「取消關注」的訊息；
 * 後端據此記住該關注哪些目錄，工程有變動時原樣重推。
 */
export function requestDirs(): void {
  const dirs = [...openDirs];
  for (const dir of dirs) {
    if (!listings.has(dir)) {
      pending.add(dir);
    }
  }
  post({ type: 'listDir', dirs });
}

/** 展開/摺疊一個目錄。 */
export function toggleDir(relPath: string): void {
  if (openDirs.has(relPath)) {
    collapse(relPath);
  } else {
    openDirs.add(relPath);
  }
  persistOpen();
  // 先請求再畫：requestDirs 會把沒資料的目錄記進 pending，順序反了
  // 剛展開的那一層會顯示「（未載入）」而不是「載入中…」。
  requestDirs();
  repaint();
}

/** 讓後端重新讀一遍盤。已有結果保持顯示，只標記待重新整理，避免閃「載入中」。 */
export function refresh(): void {
  markAllPending();
  requestDirs();
}

export function setClipboard(op: 'cut' | 'copy', paths: string[]): void {
  state.clipboard = { op, paths };
  // 相對路徑同時以純文字寫進系統剪貼簿（僅外送，不讀回）：
  // 在別處貼上得到的是路徑字串。
  void navigator.clipboard?.writeText?.(paths.join('\n')).catch(() => {});
  toast(`${op === 'cut' ? '已剪下' : '已複製'} ${paths.length} 項`);
  repaint();
}

export function pasteInto(destDir: string): void {
  const clipboard = state.clipboard;
  if (!clipboard) {
    return;
  }
  post({
    type: 'fileAction',
    action: 'paste',
    op: clipboard.op,
    relPaths: clipboard.paths,
    targetDir: destDir,
  });
}

export function renameAny(relPath: string): void {
  post({ type: 'fileAction', action: 'renameAny', relPath });
}

export function openExternal(path: string): void {
  post({ type: 'openExternal', path });
}

/** 開啟進內建編輯器。`preview`：單擊那一行開成臨時標籤（後端原樣帶回，編輯器的開關關著時當正常標籤）。 */
export function openInEditor(path: string, preview = false): void {
  post({ type: 'openEditor', path, ...(preview ? { preview: true } : {}) });
}

export function copyPath(relPath: string): void {
  if (!navigator.clipboard?.writeText) {
    toast('當前環境不支援剪貼簿。', true);
    return;
  }
  navigator.clipboard.writeText(relPath).then(
    () => toast(`已複製：${relPath}`),
    () => toast('複製失敗，請手動選中。', true)
  );
}
