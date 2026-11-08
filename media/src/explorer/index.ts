/**
 * 獨立版的資源管理器（側欄「檔案」頁）。外掛形態裡沒有這塊 DOM，本檔案直接
 * 退出——那邊由 VS Code 自己的資源管理器承擔，不必也不該再畫一棵。
 *
 * 與「工程」頁的區別：那邊是按語義整理過的檢視（章節按序號倒序、定稿狀態、
 * 角色別名），只看得見三個可管理區裡的檔案；這裡是磁碟上真實的目錄結構，
 * 一個都不藏——**包括 `.novelwarden/` 這類點開頭的目錄**，細綱、會話、
 * project.json 都在裡面，工程頁給不了入口。
 */
import { byId, maybeById } from '../dom';
import { announceFileMoved, onContextMenu, toast } from '../globals';
import { acquireApi, onMessage } from '../vscodeApi';
import { pasteInto, bind, refresh, requestDirs, setClipboard } from './actions';
import { renderDir } from './rows';
import {
  expandTo,
  listings,
  markAllPending,
  openDirs,
  parentOf,
  pending,
  persistOpen,
  restoreOpen,
  state,
} from './state';

const body = maybeById('filesBody');
// 外掛形態沒有這塊 DOM，直接退出。
if (body) {
  start(body);
}

function start(body: HTMLElement): void {
  const vscode = acquireApi();
  bind({ post: (msg) => vscode.postMessage(msg), render });

  /** 整棵樹重畫。滾動位置留住——重新整理/高亮變化不該把使用者拽回頂部。 */
  function render(): void {
    const scroll = body.scrollTop;
    body.innerHTML = '';
    for (const row of renderDir('', 0)) {
      body.appendChild(row);
    }
    body.scrollTop = scroll;
    // 剛定位的那一行畫出來了：滾到它（它所在的目錄可能要等下一次 dirListings 才有）。
    if (state.pendingScroll) {
      const row = [...body.querySelectorAll<HTMLElement>('.fx-row')].find((r) => r.dataset.path === state.pendingScroll);
      if (row) {
        state.pendingScroll = null;
        row.scrollIntoView?.({ block: 'nearest' });
      }
    }
  }

  /**
   * 編輯器那邊要在「檔案」頁定位到某個檔案或目錄（麵包屑的目錄段、標籤右鍵「在檔案頁中定位」）：
   * 展開到它（目錄連它自己一起展開）、標出那一行、畫出來就滾過去。切頁籤是 view 的事。
   */
  function reveal(path: string, dir: boolean): void {
    if (path) {
      expandTo(dir ? `${path}/_` : path);
    }
    state.revealed = path || null;
    state.pendingScroll = path || null;
    persistOpen();
    requestDirs();
    render();
  }

  function setActive(path: string | null): void {
    if (state.activeFile === path) {
      return;
    }
    state.activeFile = path || null;
    render();
  }

  // ---------------------------------------------------------------- 工具欄

  byId('filesRefresh').addEventListener('click', refresh);

  byId('filesCollapse').addEventListener('click', () => {
    openDirs.clear();
    openDirs.add('');
    persistOpen();
    requestDirs();
    render();
  });

  byId('filesReveal').addEventListener('click', () => {
    if (!state.activeFile) {
      toast('編輯器裡還沒有開啟檔案。');
      return;
    }
    expandTo(state.activeFile);
    persistOpen();
    requestDirs();
    render();
    // 展開的目錄可能還沒載入，行要等下一次 dirListings 才畫得出來；
    // 已經載入的則立刻滾過去。
    body.querySelector('.fx-row.active')?.scrollIntoView({ block: 'nearest' });
  });

  // ---------------------------------------- 空白區選單與剪貼簿快捷鍵

  // 樹裡的空白處（沒命中任何行）：給一條貼上到工程根。
  onContextMenu(body, () => [
    { label: '貼上到工程根目錄', disabled: !state.clipboard, run: () => pasteInto('') },
    { sep: true },
    { label: '重新整理', run: refresh },
  ]);

  // 快捷鍵只認「檔案」頁啟用、樹裡有選中行、**這一下按在樹上**（焦點在某一行上）。從前只看前兩樣：
  // 在檔案頁點開一個檔案之後焦點進了編輯區，那一行仍是「選中」的，於是編輯區裡的 Ctrl+C / X / V
  // 被這裡攔下來，複製的成了那個檔案、貼上的成了檔案貼上（鍵登記在 editor/shortcuts.ts 的「檔案頁」那一組）。
  document.addEventListener('keydown', (e) => {
    const entry = state.selectedEntry;
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || !entry) {
      return;
    }
    if (!(e.target instanceof Node) || !body.contains(e.target)) {
      return;
    }
    if (!maybeById('pane-files')?.classList.contains('active')) {
      return;
    }
    const key = e.key.toLowerCase();
    if (key === 'c') {
      e.preventDefault();
      setClipboard('copy', [entry.relPath]);
    } else if (key === 'x') {
      e.preventDefault();
      setClipboard('cut', [entry.relPath]);
    } else if (key === 'v') {
      e.preventDefault();
      pasteInto(entry.kind === 'dir' ? entry.relPath : parentOf(entry.relPath));
    }
  });

  // ---------------------------------------------------------------- 收訊息

  onMessage((msg) => {
    switch (msg.type) {
      case 'dirListings':
        for (const listing of msg.listings) {
          listings.set(listing.relPath, listing);
          pending.delete(listing.relPath);
        }
        render();
        break;

      case 'filesOpDone':
        // 剪下態清除（僅 move 成功時）；複製態保留——可以在別處再粘一次。
        if (msg.op === 'move' && state.clipboard?.op === 'cut') {
          state.clipboard = null;
        }
        // 改名/搬家的結果廣播給編輯器，讓它把標籤挪到新路徑。
        for (const r of msg.results) {
          if (r.ok && r.to && (msg.op === 'rename' || msg.op === 'move')) {
            announceFileMoved(r.from, r.to);
          }
        }
        markAllPending();
        requestDirs();
        render();
        break;

      // 「開啟檔案」不只來自這棵樹——工程頁點章節、模型採納寫入後都會開。
      // 跟著高亮，作者才看得出現在編輯的是哪一個。
      case 'editorOpen':
        setActive(msg.file.path);
        break;
    }
  });

  // editor.js 在切標籤頁/關標籤頁時廣播當前啟用的檔案，高亮跟著它走。
  window.addEventListener('nf-editor-active', (e) => setActive(e.detail.path));
  // 編輯器的麵包屑目錄段、標籤右鍵「在檔案頁中定位」。
  window.addEventListener('nf-reveal-in-files', (e) => reveal(e.detail.path, e.detail.dir));

  // ---------------------------------------------------------------- 啟動

  restoreOpen();
  // 首幀就要一份：切到「檔案」頁時樹已經在了，不必等一次往返才看見東西。
  requestDirs();
  render();
}
