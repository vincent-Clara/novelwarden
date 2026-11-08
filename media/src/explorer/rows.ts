/**
 * 樹上一行的建法，以及每行的右鍵選單。
 *
 * **樹是扁平渲染的**：`renderDir` 遞迴遍歷，但產出的是扁平的行陣列，
 * 層級靠 paddingLeft 縮排表達而非巢狀 DOM——摺疊只是重畫一遍，
 * 不必搬 DOM 子樹（與工程頁同一套取捨）。
 */
import { el } from '../dom';
import { onContextMenu } from '../globals';
import type { MenuItem } from '../globals';
import type { FsEntry } from '../protocol';
import {
  copyPath,
  openExternal,
  openInEditor,
  pasteInto,
  renameAny,
  setClipboard,
  toggleDir,
} from './actions';
import { isCut, listings, openDirs, parentOf, pending, state } from './state';

/** 每層縮排 14px，與工程頁一致。 */
const INDENT_STEP = 14;
const INDENT_BASE = 8;

/** 一個目錄展開後應有的全部行（含子目錄，遞迴展開）。 */
export function renderDir(relPath: string, depth: number): HTMLElement[] {
  const listing = listings.get(relPath);
  if (!listing) {
    return [hintRow(pending.has(relPath) ? '載入中…' : '（未載入）', depth)];
  }
  if (listing.error) {
    return [hintRow(listing.error, depth, true)];
  }
  if (listing.entries.length === 0) {
    return [hintRow('（空資料夾）', depth)];
  }

  const rows: HTMLElement[] = [];
  for (const entry of listing.entries) {
    if (entry.kind === 'dir') {
      rows.push(dirRow(entry, depth));
      if (openDirs.has(entry.relPath)) {
        rows.push(...renderDir(entry.relPath, depth + 1));
      }
    } else {
      rows.push(fileRow(entry, depth));
    }
  }
  if (listing.truncated) {
    // 不靜默截斷：讓作者知道這個目錄裡還有東西沒畫出來。
    rows.push(
      hintRow(
        `另有 ${listing.truncated - listing.entries.length} 項未列出（共 ${listing.truncated} 項）`,
        depth,
        true
      )
    );
  }
  return rows;
}

/** 一行的公共骨架：縮排 + 可聚焦（Ctrl+X/C/V 的作用物件）。`path` 給「定位」認行用。 */
function baseRow(depth: number, path?: string): HTMLDivElement {
  const row = el('div', 'fx-row');
  row.style.paddingLeft = `${INDENT_BASE + depth * INDENT_STEP}px`;
  row.tabIndex = 0;
  if (path !== undefined) {
    row.dataset.path = path;
    // 編輯器那邊點了「在檔案頁中定位」的那一行：標出來，直到下一次定位。
    row.classList.toggle('fx-revealed', state.revealed === path);
  }
  return row;
}

function dirRow(entry: FsEntry, depth: number): HTMLElement {
  const row = baseRow(depth, entry.relPath);
  row.classList.add('fx-dir');
  const open = openDirs.has(entry.relPath);

  row.appendChild(el('span', 'fx-caret', open ? '⌄' : '›'));
  row.appendChild(el('span', 'fx-icon', open ? '📂' : '📁'));
  row.appendChild(el('span', 'fx-name', entry.name));

  // 點開頭的目錄（.novelwarden / .vscode）壓暗一點，與 VS Code 一致：
  // 它們看得見、打得開，但不該跟正文搶注意力。
  if (entry.name.startsWith('.')) {
    row.classList.add('fx-dotted');
  }
  if (isCut(entry.relPath)) {
    row.classList.add('fx-cut');
  }

  row.addEventListener('focus', () => {
    state.selectedEntry = entry;
  });
  row.addEventListener('click', () => {
    state.selectedEntry = entry;
    toggleDir(entry.relPath);
  });

  onContextMenu(row, () => [
    ...clipboardItems(entry),
    { label: open ? '摺疊' : '展開', run: () => toggleDir(entry.relPath) },
    { label: '在系統中開啟', run: () => openExternal(entry.relPath) },
    { sep: true },
    { label: '複製相對路徑', run: () => copyPath(entry.relPath) },
  ]);
  return row;
}

function fileRow(entry: FsEntry, depth: number): HTMLElement {
  const row = baseRow(depth, entry.relPath);
  row.classList.add('fx-file');
  if (entry.relPath === state.activeFile) {
    row.classList.add('active');
  }
  if (!entry.editable) {
    row.classList.add('fx-binary');
  }
  if (entry.name.startsWith('.')) {
    row.classList.add('fx-dotted');
  }
  if (isCut(entry.relPath)) {
    row.classList.add('fx-cut');
  }

  // 檔案行沒有摺疊箭頭，但要佔住同樣的寬度，名字才與同級目錄對齊。
  row.appendChild(el('span', 'fx-caret'));
  row.appendChild(el('span', 'fx-icon', iconFor(entry)));
  row.appendChild(el('span', 'fx-name', entry.name));
  row.appendChild(el('span', 'fx-size', formatBytes(entry.bytes)));

  row.title = `${entry.relPath}${entry.editable ? '' : '（不是文字檔案，將用系統預設程式開啟）'}`;

  row.addEventListener('focus', () => {
    state.selectedEntry = entry;
  });
  // 單擊開成臨時標籤（下一次單擊別的檔案換掉它）；雙擊（第二下點選）開成正常標籤，臨時的就此轉正。
  // 按這一下的點選次數認：第一下開啟之後整棵樹會因為高亮換了而重畫，dblclick 不一定落在同一個元素上。
  row.addEventListener('click', (e) => {
    state.selectedEntry = entry;
    openEntry(entry, e.detail < 2);
  });

  onContextMenu(row, () => [
    ...clipboardItems(entry),
    { label: entry.editable ? '開啟' : '開啟（外部程式）', run: () => openEntry(entry) },
    { label: '在系統中開啟', run: () => openExternal(entry.relPath) },
    { sep: true },
    { label: '複製相對路徑', run: () => copyPath(entry.relPath) },
  ]);
  return row;
}

function hintRow(text: string, depth: number, isError?: boolean): HTMLElement {
  const row = baseRow(depth);
  row.classList.add('fx-hint');
  if (isError) {
    row.classList.add('err');
  }
  row.textContent = text;
  return row;
}

/** 剪下/複製/貼上/重新命名四項。檔案與資料夾行共用。 */
function clipboardItems(entry: FsEntry): MenuItem[] {
  const dest = entry.kind === 'dir' ? entry.relPath : parentOf(entry.relPath);
  return [
    { label: '剪下', run: () => setClipboard('cut', [entry.relPath]) },
    { label: '複製', run: () => setClipboard('copy', [entry.relPath]) },
    { label: '貼上', disabled: !state.clipboard, run: () => pasteInto(dest) },
    { label: '重新命名', run: () => renameAny(entry.relPath) },
    { sep: true },
  ];
}

/**
 * 開啟一個條目。可編輯的進內建編輯器，其餘交系統預設程式——
 * 「能不能編輯」由後端算好（與 fileEditing.ts 同一份規則），
 * 前端不復刻副檔名白名單，也就不會去撞一個必然失敗的 openEditor。
 */
function openEntry(entry: FsEntry, preview = false): void {
  if (entry.editable) {
    openInEditor(entry.relPath, preview);
  } else {
    openExternal(entry.relPath);
  }
}

/** 按副檔名給個圖示。純裝飾，認不出就用通用的那個。 */
function iconFor(entry: FsEntry): string {
  const name = entry.name.toLowerCase();
  if (/\.(md|markdown)$/.test(name)) return '📝';
  if (/\.(json|ya?ml)$/.test(name)) return '⚙';
  if (/\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/.test(name)) return '🖼';
  if (/\.(zip|rar|7z|gz|tar)$/.test(name)) return '📦';
  if (!entry.editable) return '▪';
  return '📄';
}

function formatBytes(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
