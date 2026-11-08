/**
 * 一塊編輯區。兩塊（正文 / 草稿）是這個工廠的兩個例項，各自持有自己的
 * 檔案表、衝突表與當前路徑（預覽還是編輯按檔案記），互相不讀對方的內部欄位——
 * 它們之間只通過 store.ts 的 `panes` 表與 `paneOwning()` 打交道。
 *
 * 儲存帶**內容 hash 樂觀鎖**：磁碟上的 hash 與編輯器基線不一致（作者在別處
 * 改過、或外掛寫入過）時儲存被拒，彈衝突條讓使用者在「用磁碟版本覆蓋編輯器」
 * 和「用編輯器內容強制儲存」之間選。只有明確點了「強制儲存」（頁內對話方塊裡再確認一次）
 * 才會發不帶 `baseHash` 的 saveFile。
 *
 * **不丟稿那幾樣不在這裡寫**：儲存本身（同一份只有一個在路上、狀態列的儲存狀態、磁碟上沒了先問）
 * 經 `saving.ts`，關標籤時的三選一經 `closing.ts`，對話方塊是 `dialog.ts`；這裡只認它們的幾個函式。
 * 磁碟上的改動由 `diskSync.ts` 收來，經 `applyDiskChange` / `markGone` 落到標籤上。
 *
 * **撤銷 / 重做是編輯器自己記的**（`history.ts`，每個檔案一份）：打字在 `input` 裡拿
 * `file.draft` 與 textarea 的當前值求差異記賬；程式改寫一律走 `applyEdit`；Ctrl+Z / Ctrl+Y /
 * Ctrl+Shift+Z 與 `beforeinput` 的 `historyUndo` / `historyRedo` 都攔下來走自己的，原生撤銷不用。
 * 輸入法組字期間不記，`compositionend` 之後整段記一步。
 *
 * **標籤**：名字與短標記來自後端（`OpenFile.label`），同名的加區分目錄（`tabLabels.ts`）；標籤條的滾動與
 * 「▾」在 `tabStrip.ts`，右鍵選單裡關閉類之後的那幾項（移到另一側、定位、複製路徑、重新開啟、固定）在
 * `tabMenu.ts`。**臨時標籤**（`OpenFile.preview`）的規矩都在 `upsertFile` / `slotFor` 與幾處轉正的地方。
 *
 * **Markdown 預覽按標籤記**（`OpenFile.markdownPreview`，方案 D3）：切走再切回來還是原來那樣，重新整理恢復也記著（⚑）。
 * 切換走 `setPreviewing`（工具欄「預覽 / 編輯」、`Ctrl+Shift+V`、查詢與體檢之類「先切回編輯」的地方）：編輯區視口
 * 頂上那一行與預覽裡對應的那一塊互相滾到一處（`previewSync.ts`）。`activate` 只是切標籤，不再順手切回編輯。
 *
 * **特殊標籤**（敘事線重做三期，`store.ts` 的 `SpecialTab`：「敘事線總覽」）：不對應檔案的標籤排在檔案標籤前面。切過去時
 * `activePath` 是 null——這一塊此刻沒有當前檔案，對當前檔案做事的模組都當沒開檔案；畫的東西由那個模組掛在 `.ed-stage` 上
 * （`show` / `hide`），這裡只管標籤、誰在顯示、重新整理恢復。切回一份檔案（`activate`、從別處開啟一份到這一塊）它就藏起來；
 * 關掉它回到切過去之前的那一份。
 */
import { setHidden } from '../dom';
import { onContextMenu, toast } from '../globals';
import { avoidSoftKeyboard } from '../touch';
import type { MenuItem } from '../globals';
import type { EditorFileView, EditorOpenIntent, InMessage } from '../protocol';
import { locateQuote } from '../protocol';
import {
  areaMenuItems,
  clampSelection,
  emitEditorChange,
  indentUnit,
  isImeComposing,
  runKeyHandlers,
} from './api';
import type { EditSource } from './api';
import { renderBreadcrumb } from './breadcrumb';
import { areaCopy, areaCut, areaPaste } from './clipboard';
import { requestClose } from './closing';
import { askDialog } from './dialog';
import { scrollToOffset } from './highlight';
import { EditHistory, diffText } from './history';
import type { TextChange, TextSelection } from './history';
import { indentLines, outdentLines } from './indent';
import { previewTabsEnabled } from './paragraphState';
import type { CarriedDraft, OpenFile, PaneId, PaneRefs } from './paneElements';
import { renderPreview } from './preview';
import { lineOfOffset, lineStarts } from './previewCore';
import { areaScrollForLine, areaTopLine, previewTopLine, scrollPreviewToLine } from './previewSync';
import {
  blockAutoSave,
  holdSave,
  isAutoSaving,
  isSaving,
  noteStatus,
  releaseSave,
  renderSaveState,
  requestSave,
  settleSave,
  unblockAutoSave,
} from './saving';
import {
  activePane,
  allOpenFiles,
  announceActive,
  forgetClosed,
  noteClosed,
  paneWithSpecial,
  pendingActive,
  pendingDrafts,
  persist,
  refreshOtherTabs,
  rememberView,
  schedulePersist,
  setActivePane,
  specialTabOf,
  syncDraftVisibility,
  takeView,
} from './store';
import type { ApplyEditOptions, Pane } from './store';
import { extraTabItems } from './tabMenu';
import { tabNames } from './tabLabels';
import type { TabName } from './tabLabels';
import { installNarrowTools } from './narrowTools';
import { createTabStrip, tabText } from './tabStrip';
import { shortcutLabel } from './shortcuts';
import { renderWordStatus } from './stats';

/** 哪些副檔名有 Markdown 可預覽。 */
const MARKDOWN_RE = /\.(md|markdown)$/i;
/**
 * 哪些用等寬字型。**預覽與等寬是兩件事**：章節可以是 .txt / 無副檔名，
 * 那時沒有 Markdown 可預覽（隱藏「預覽」按鈕），但它仍是正文，該用正文字型；
 * 只有 .json / .yml 這類結構化檔案才加 .mono。
 */
const CODE_RE = /\.(json|ya?ml)$/i;

/**
 * 哪些原生輸入算「打字」，可以與前後幾下併成一步撤銷。貼上、拖放、剪下各自一步；
 * 沒有 `inputType` 的（老瀏覽器、測試裡合成的事件）當打字。
 */
const TYPING_INPUT = new Set([
  'insertText',
  'deleteContentBackward',
  'deleteContentForward',
  'deleteWordBackward',
  'deleteWordForward',
]);

/**
 * textarea 的 value 會把 `\r\n` / `\r` 歸一成 `\n`。比較「編輯區裡顯示的是不是這一份」、
 * 算 `applyEdit` 的下標都得用同一個口徑——`file.draft` 剛從磁碟讀來時可能還帶著 `\r\n`。
 */
function viewText(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
}

export function createPane(
  id: PaneId,
  el: PaneRefs,
  post: (msg: InMessage) => void
): Pane {
  const files = new Map<string, OpenFile>();
  /**
   * 衝突時暫存的磁碟版本，供「用磁碟版本覆蓋」使用。
   * `reopen`：不是儲存撞上的，是已開啟的檔案被再次開啟（多半是剛落盤了新產物）
   * 而編輯器裡還有未儲存的修改——文案不能說「這次儲存已取消」。
   */
  const conflicts = new Map<string, { text: string; hash: string; reopen?: boolean }>();
  /**
   * 見過、但還沒載入編輯器的那份磁碟版本的 hash（儲存撞上衝突、再次開啟、核對磁碟時知道的）。
   * 衝突條會因為作者接著打字而收起，這一筆不跟著丟：核對磁碟時帶它，同一個新版不再報第二次。
   * 基線換了（載入了、存成了）就清掉。
   */
  const diskSeen = new Map<string, string>();
  /**
   * 作者點過「還原」、正在等後端回磁碟版的路徑。只有它們的 editorOpen 才允許
   * 沖掉未儲存的修改；其餘的 editorOpen 一律當成「再開啟一次」。
   */
  const reloading = new Set<string>();
  /** 開著的特殊標籤（`store.ts` 的 `SpecialTab`），按開啟的先後。 */
  const specials: string[] = [];
  /** 正顯示著的特殊標籤。不是 null 時 `activePath` 是 null。 */
  let shownSpecial: string | null = null;
  /** 切到特殊標籤之前的那份檔案：關掉特殊標籤時回到它（重新整理恢復時是存下來的那一份）。 */
  let specialReturn: string | null = null;
  /**
   * 正文區（或預覽）此刻顯示的是哪一份：它的游標與滾動活在 DOM 裡。`renderAll` 換成另一份時先把這一份的留住、再把那一份的
   * 放回去——切換不只經 `activate`（點標籤），工程頁 / 檔案頁 / 「轉到…」再點一份開著的、新開一份、關掉當前的露出旁邊那一份，
   * 都只改 `activePath` 再重畫。從前這些路上 textarea 沿用上一份的滾動偏移，滾動事件還把它記成了這一份的位置。
   */
  let shown: OpenFile | undefined;

  const pane: Pane = {
    id,
    root: el.root,
    area: el.area,
    files,
    activePath: null,
    activeFile,
    isPreviewing: () => previewing(activeFile()),
    canPreview: () => canPreview(activeFile()),
    setPreviewing,
    hasDirty,
    snapshot,
    activate,
    closeFile,
    discard,
    closeSilently,
    moveOut,
    upsertFile,
    pin,
    applyEdit,
    undo,
    redo,
    save,
    savePath,
    reveal,
    applySaved,
    applyConflict,
    applyDiskChange,
    markGone,
    knownDiskHash,
    refresh,
    rebase,
    specials,
    activeSpecial: () => shownSpecial,
    openSpecial,
    closeSpecial,
  };

  function activeFile(): OpenFile | undefined {
    return pane.activePath ? files.get(pane.activePath) : undefined;
  }

  /** 這份檔案有沒有 Markdown 可預覽（`.txt` / 無副檔名的章節沒有，隱藏「預覽」按鈕）。 */
  function canPreview(file: OpenFile | undefined): boolean {
    return !!file && MARKDOWN_RE.test(file.path);
  }

  /** 這份檔案此刻是不是在預覽裡（每個標籤各記各的）。 */
  function previewing(file: OpenFile | undefined): boolean {
    return !!file?.markdownPreview && canPreview(file);
  }

  function hasDirty(): boolean {
    return [...files.values()].some((f) => f.draft !== f.text);
  }

  function snapshot() {
    // 不進重新整理恢復的特殊標籤（對比標籤）不記；正顯示著的是它時照樣記切過去之前的那一份，重新整理後回到那份檔案。
    const kept = specials.filter((id) => !specialTabOf(id)?.transient);
    return {
      open: [...files.values()].map((f) => ({
        path: f.path,
        hash: f.hash,
        draft: f.draft === f.text ? undefined : f.draft,
        preview: f.preview || undefined,
        markdownPreview: f.markdownPreview || undefined,
      })),
      // 特殊標籤正顯示著：記切過去之前的那一份，重新整理之後關掉特殊標籤還回得去。
      active: shownSpecial ? (specialReturn && files.has(specialReturn) ? specialReturn : null) : pane.activePath,
      ...(kept.length > 0 ? { specials: kept } : {}),
      ...(shownSpecial && kept.includes(shownSpecial) ? { special: shownSpecial } : {}),
    };
  }

  // ---------------------------------------------------------------- 標籤

  /** 標籤條：橫著滾、當前那個滾進視野、末尾的「▾」（`tabStrip.ts`）。 */
  const strip = createTabStrip(el.tabs);
  // 窄屏上「▾」後面再掛「↶」「↷」「儲存」「⋯」，工具欄那一行收起（narrowTools.ts）。
  installNarrowTools(el, pane);

  /** 每份檔案在標籤上怎麼寫：兩塊編輯區開著的放在一起比，同名的加區分目錄。 */
  function currentNames(): Map<string, TabName> {
    const all = new Map(allOpenFiles().map((f) => [f.path, f]));
    for (const f of files.values()) {
      all.set(f.path, f);
    }
    return tabNames([...all.values()]);
  }

  function renderTabs(): void {
    const keep = strip.beforeRender();
    const names = currentNames();
    let active: HTMLElement | null = null;
    strip.list.replaceChildren();
    // 特殊標籤排在檔案標籤前面（⚑）：它是這一塊的一張「總表」，不隨開開關關的檔案挪位置。
    for (const id of specials) {
      const tab = buildSpecialTab(id);
      if (tab) {
        if (id === shownSpecial) {
          active = tab;
        }
        strip.list.appendChild(tab);
      }
    }
    for (const file of files.values()) {
      const tab = buildTab(file, names.get(file.path) ?? { tag: '', title: file.name, desc: '' });
      if (file.path === pane.activePath) {
        active = tab;
      }
      strip.list.appendChild(tab);
    }
    setHidden(el.tabs, files.size === 0 && specials.length === 0);
    strip.afterRender(keep, active);
  }

  /** 特殊標籤：沒有髒標記、沒有型別短標記；點了切過去，× 與中鍵關掉，右鍵「關閉」加它自己給的幾項。 */
  function buildSpecialTab(id: string): HTMLElement | undefined {
    const spec = specialTabOf(id);
    if (!spec) {
      return undefined;
    }
    const { title, tip } = spec.label();
    const tab = document.createElement('div');
    tab.className = 'ed-tab ed-tab-special';
    tab.classList.toggle('active', id === shownSpecial);
    tab.dataset.special = id;
    tab.title = tip;

    const name = document.createElement('span');
    name.className = 'ed-tab-name';
    name.textContent = title;
    tab.appendChild(name);

    const close = document.createElement('button');
    close.className = 'ed-tab-close';
    close.textContent = '×';
    close.title = '關閉';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeSpecial(id);
    });
    tab.appendChild(close);

    tab.addEventListener('click', () => openSpecial(id));
    tab.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeSpecial(id);
      }
    });
    onContextMenu(tab, () => [{ label: '關閉', run: () => closeSpecial(id) }, ...(spec.menu?.(pane) ?? [])]);
    return tab;
  }

  function openSpecial(id: string, opts?: { focus?: boolean; background?: boolean; restoring?: boolean }): void {
    if (!specialTabOf(id)) {
      return;
    }
    // 同一個特殊標籤同一時刻只在一塊裡：開在另一塊裡的先從那邊拿走。
    const elsewhere = paneWithSpecial(id);
    if (elsewhere && elsewhere !== pane) {
      elsewhere.closeSpecial(id, { quiet: true });
    }
    if (!specials.includes(id)) {
      specials.push(id);
    }
    if (!opts?.background && shownSpecial !== id) {
      // 切走前把游標位置留住、正在打的那一步收口（同切標籤）。
      stashCaret();
      activeFile()?.history.seal();
      if (pane.activePath) {
        specialReturn = pane.activePath;
      }
      pane.activePath = null;
      shownSpecial = id;
    }
    if (opts?.focus !== false && !opts?.background) {
      setActivePane(pane);
    }
    renderAll();
    announceActive();
    syncDraftVisibility();
    if (!opts?.restoring) {
      persist();
    }
  }

  function closeSpecial(id: string, opts?: { quiet?: boolean }): void {
    const i = specials.indexOf(id);
    if (i < 0) {
      return;
    }
    specials.splice(i, 1);
    specialTabOf(id)?.hide(pane);
    const wasShown = shownSpecial === id;
    if (wasShown) {
      shownSpecial = null;
    }
    const back = specialReturn && files.has(specialReturn) ? specialReturn : [...files.keys()].pop();
    if (wasShown && back && !opts?.quiet) {
      // 回到切過去之前的那一份：游標、滾動、預覽都照它切走時的樣子（`activate` 那一套）。
      specialReturn = null;
      activate(back);
      refreshOtherTabs(pane);
      syncDraftVisibility();
      return;
    }
    if (wasShown) {
      pane.activePath = back ?? null;
      specialReturn = null;
      // 檔案都關了、還開著別的特殊標籤：顯示最後那一個。
      if (!pane.activePath && specials.length > 0) {
        shownSpecial = specials[specials.length - 1];
      }
    }
    renderAll();
    if (!opts?.quiet) {
      announceActive();
      syncDraftVisibility();
      persist();
    }
  }

  /** 這一塊認下一份檔案噹噹前的：正顯示著的特殊標籤藏起來。 */
  function leaveSpecial(): void {
    if (shownSpecial) {
      shownSpecial = null;
      specialReturn = null;
    }
  }

  function buildTab(file: OpenFile, label: TabName): HTMLElement {
    const tab = document.createElement('div');
    tab.className = 'ed-tab';
    tab.classList.toggle('active', file.path === pane.activePath);
    tab.classList.toggle('dirty', file.draft !== file.text);
    // 臨時標籤：名字斜體，下一次單擊開啟別的檔案時這個位置被換掉。
    tab.classList.toggle('preview', !!file.preview);
    tab.dataset.path = file.path;
    tab.title = file.preview ? `${file.path}\n臨時標籤：編輯、儲存或雙擊就會固定下來` : file.path;

    const dot = document.createElement('span');
    dot.className = 'ed-tab-dirty';
    tab.appendChild(dot);

    // 型別短標記（細綱 / 草稿 / 角色……，後端給的）：同一章的正文、細綱、草稿一眼分得開。
    if (label.tag) {
      const tag = document.createElement('span');
      tag.className = 'ed-tab-tag';
      tag.textContent = label.tag;
      tab.appendChild(tag);
    }

    const name = document.createElement('span');
    name.className = 'ed-tab-name';
    name.textContent = label.title;
    tab.appendChild(name);

    // 仍然同名的（同一種、不同目錄）：後面淡一點寫區分它們的最短目錄。
    if (label.desc) {
      const desc = document.createElement('span');
      desc.className = 'ed-tab-desc';
      desc.textContent = label.desc;
      tab.appendChild(desc);
    }

    // 磁碟上被改了而編輯器裡的修改沒覆蓋、或磁碟上已經沒有這一份：標籤上掛一個醒目的「!」（不切過去）。
    const flag = conflicts.has(file.path)
      ? '磁碟上已被改動，編輯器裡的修改沒有覆蓋'
      : file.gone
        ? '磁碟上已經沒有這個檔案（被刪或改名）'
        : '';
    tab.classList.toggle('conflict', conflicts.has(file.path));
    tab.classList.toggle('gone', !!file.gone);
    if (flag) {
      const mark = document.createElement('span');
      mark.className = 'ed-tab-flag';
      mark.textContent = '!';
      mark.title = flag;
      tab.appendChild(mark);
      tab.title = `${tab.title}\n${flag}`;
    }

    const close = document.createElement('button');
    close.className = 'ed-tab-close';
    close.textContent = '×';
    close.title = '關閉';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeFile(file.path);
    });
    tab.appendChild(close);

    tab.addEventListener('click', (e) => {
      // 雙擊臨時標籤：轉正。點第一下 activate 就把整排標籤重畫了，第二下落在新的那個元素上——
      // 所以按這一下的點選次數認，不指望 dblclick 落在同一個元素上（下面那個 dblclick 是兜底）。
      if (e.detail >= 2 && file.preview) {
        file.preview = false;
      }
      activate(file.path);
    });
    tab.addEventListener('dblclick', () => pin(file.path));
    // 中鍵關閉，與瀏覽器/編輯器一致。
    tab.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeFile(file.path);
      }
    });
    onContextMenu(tab, () => tabMenuItems(file.path));
    return tab;
  }

  /**
   * 標籤右鍵選單：關閉當前/左側/右側/其它。
   * 批次關閉**合成一個對話方塊問一次**（幾份沒儲存就列出幾份），見 `closing.ts`。
   */
  function tabMenuItems(anchor: string): MenuItem[] {
    const order = [...files.keys()];
    const idx = order.indexOf(anchor);
    const left = order.slice(0, idx);
    const right = order.slice(idx + 1);
    const closeMany = (paths: string[]) => void requestClose(pane, paths);

    const items: MenuItem[] = [{ label: '關閉', run: () => closeFile(anchor) }];
    if (left.length > 0) {
      items.push({ label: `關閉左側（${left.length}）`, run: () => closeMany(left) });
    }
    if (right.length > 0) {
      items.push({ label: `關閉右側（${right.length}）`, run: () => closeMany(right) });
    }
    if (left.length + right.length > 0) {
      items.push({
        label: `關閉其它（${left.length + right.length}）`,
        run: () => closeMany([...left, ...right]),
      });
    }
    // 移到另一側、在檔案頁中定位、複製相對路徑、重新開啟剛關閉的、固定（tabMenu.ts）。
    return [...items, ...extraTabItems(pane, anchor)];
  }

  /** 臨時標籤轉正。 */
  function pin(path: string): void {
    const file = files.get(path);
    if (!file?.preview) {
      return;
    }
    file.preview = false;
    renderTabs();
    persist();
  }

  function activate(path: string, opts?: { focus?: boolean }): void {
    const file = files.get(path);
    if (!file) {
      return;
    }
    // 不搶焦點地切（上一章 / 下一章時另一塊裡配對的那一份）：不認下「當前這一塊」，焦點留在原處。
    const quiet = opts?.focus === false;
    // 切走前把游標位置留住，切回來還在原處；正在打的那一步也收口，切回來再打另起一步。
    stashCaret();
    activeFile()?.history.seal();
    leaveSpecial();
    pane.activePath = path;
    if (!quiet) {
      setActivePane(pane);
    }
    renderAll();
    announceActive();
    if (previewing(file)) {
      // 這一份切走時在預覽裡：照舊在預覽裡，滾到切走時的位置。
      el.preview.scrollTop = file.previewScrollTop ?? 0;
      if (!quiet) {
        el.preview.focus({ preventScroll: true });
      }
    } else {
      // 手機上切過來只是看：不把焦點放進正文區（一聚焦就彈軟鍵盤），點進正文才打字。
      if (!quiet && !avoidSoftKeyboard()) {
        el.area.focus();
      }
      if (file.caret !== undefined) {
        el.area.selectionStart = el.area.selectionEnd = Math.min(file.caret, el.area.value.length);
      }
      el.area.scrollTop = file.scrollTop || 0;
    }
    persist();
  }

  /** 切走之前把這一份的游標與滾動（在預覽裡就是預覽的滾動）留住。 */
  function stashCaret(): void {
    const file = activeFile();
    if (file) {
      stashView(file);
    }
  }

  /** 把正顯示著的這一份的游標與滾動從 DOM 讀回它身上。textarea / 預覽藏著時（特殊標籤蓋著）滾動讀出來是 0，不讀。 */
  function stashView(file: OpenFile): void {
    if (previewing(file)) {
      if (!el.preview.classList.contains('hidden')) {
        file.previewScrollTop = el.preview.scrollTop;
      }
      return;
    }
    file.caret = el.area.selectionStart;
    if (!el.area.classList.contains('hidden')) {
      file.scrollTop = el.area.scrollTop;
    }
  }

  /** 換上這一份之後把它的游標與滾動放回去（新開的是 0：從頂上開始，不沿用上一份的偏移）。先落游標、再滾。 */
  function restoreView(file: OpenFile): void {
    if (previewing(file)) {
      el.preview.scrollTop = file.previewScrollTop ?? 0;
      return;
    }
    const caret = Math.min(file.caret, el.area.value.length);
    el.area.setSelectionRange(caret, caret);
    el.area.scrollTop = file.scrollTop || 0;
  }

  /**
   * 當前這一份切到預覽 / 切回編輯（工具欄「預覽 / 編輯」、`Ctrl+Shift+V`，以及查詢、體檢、對比合併這些「先切回編輯」的地方）。
   * 兩邊滾到同一處：編輯區視口頂上那一行（帶小數，一段折成幾行時滾到一半就是一半）在預覽裡對應的那一塊停在頂上，反過來同理
   * （`previewSync.ts`）。切回編輯時游標留在原處——它要是不在視口裡了，就放到視口頂上那一行的行首（⚑），免得一打字又跳回去。
   * 沒有檔案、要預覽的不是 Markdown 時返回 false。`focus: false`：焦點不動（預設進正文區 / 預覽）。
   */
  function setPreviewing(on: boolean, opts?: { focus?: boolean }): boolean {
    const file = activeFile();
    if (!file || (on && !canPreview(file))) {
      return false;
    }
    if (previewing(file) === on) {
      return true;
    }
    const focus = opts?.focus !== false;
    const lineCount = lineStarts(el.area.value).length;
    if (on) {
      const pos = areaTopLine(pane);
      stashCaret();
      file.markdownPreview = true;
      renderAll();
      scrollPreviewToLine(el.preview, pos, lineCount);
      file.previewScrollTop = el.preview.scrollTop;
      if (focus) {
        el.preview.focus({ preventScroll: true });
      }
    } else {
      const pos = previewTopLine(el.preview, lineCount);
      file.previewScrollTop = el.preview.scrollTop;
      file.markdownPreview = false;
      renderAll();
      if (focus) {
        el.area.focus({ preventScroll: true });
      }
      const target = areaScrollForLine(pane, pos);
      const starts = lineStarts(el.area.value);
      const caretLine = lineOfOffset(starts, Math.min(file.caret, el.area.value.length));
      if (caretLine < Math.floor(target.top) || caretLine > target.bottom) {
        file.caret = starts[Math.min(starts.length - 1, Math.ceil(target.top - 1e-6))];
      }
      // 先落游標、再滾：落選區時瀏覽器可能自己把游標滾進視野。
      el.area.setSelectionRange(file.caret, file.caret);
      el.area.scrollTop = target.scrollTop;
      file.scrollTop = el.area.scrollTop;
    }
    persist();
    return true;
  }

  function closeFile(path: string): void {
    // 未儲存內容不能一點就沒：先問「儲存 / 不儲存 / 取消」，儲存的要等回執回來才關。
    void requestClose(pane, [path]);
  }

  function discard(paths: string[]): void {
    let dropped = false;
    const names = currentNames();
    for (const path of paths) {
      if (files.has(path)) {
        // 作者親手關的才進「最近關閉」（右鍵「重新開啟剛關閉的」、「▾」列表底下）。
        const name = names.get(path);
        noteClosed({ path, pane: pane.id, title: name ? tabText(name) : path });
        dropFile(path);
        dropped = true;
      }
    }
    if (!dropped) {
      return;
    }
    renderAll();
    syncDraftVisibility();
    persist();
    refreshOtherTabs(pane);
  }

  function closeSilently(path: string): CarriedDraft | false {
    const file = files.get(path);
    if (!file) {
      return false;
    }
    if (file === activeFile()) {
      stashCaret();
    }
    // 搬家不是關閉：未儲存內容與撤銷歷史都帶走，接手的那一塊接得上就接。衝突條、見過的磁碟新版、
    // 「磁碟上沒了」與游標只有頁面裡直接搬（`moveOut`，`local`）才接——經後端重讀來的那一份可能已經不是它們說的那一份。
    const carry: CarriedDraft = {
      history: file.history,
      historyText: file.draft,
      preview: !!file.preview,
      markdownPreview: !!file.markdownPreview,
      gone: !!file.gone,
      conflict: conflicts.get(path),
      diskSeen: diskSeen.get(path),
      caret: file.caret,
      scrollTop: file.scrollTop,
    };
    if (file.draft !== file.text) {
      carry.hash = file.hash;
      carry.draft = file.draft;
    }
    dropFile(path);
    renderAll();
    refreshOtherTabs(pane);
    return carry;
  }

  function moveOut(path: string): { view: EditorFileView; carried: CarriedDraft } | undefined {
    const file = files.get(path);
    if (!file) {
      return undefined;
    }
    // 接手的那一塊收到的就是這一份的基線（不經後端重讀），未儲存內容按 hash 對得上原樣接上。
    const view: EditorFileView = {
      path: file.path,
      name: file.name,
      text: file.text,
      hash: file.hash,
      bytes: file.text.length,
      draftPath: file.draftPath,
      kind: file.kind,
      label: file.label,
    };
    const carried = closeSilently(path);
    if (!carried) {
      return undefined;
    }
    syncDraftVisibility();
    persist();
    return { view, carried: { ...carried, hash: file.hash, local: true } };
  }

  /** 這一份要從這塊裡拿走了：游標與滾動記下來（正顯示著的先從 DOM 讀回來），這一頁裡再開啟它時放回去。 */
  function keepView(path: string): void {
    const file = files.get(path);
    if (!file) {
      return;
    }
    if (file === shown) {
      stashView(file);
    }
    rememberView(path, { caret: file.caret, scrollTop: file.scrollTop });
  }

  function dropFile(path: string): void {
    keepView(path);
    files.delete(path);
    conflicts.delete(path);
    diskSeen.delete(path);
    if (pane.activePath === path) {
      pane.activePath = [...files.keys()].pop() || null;
      // 檔案都關了、還開著特殊標籤：切到它（同關掉一個標籤之後顯示旁邊那一個）。
      if (!pane.activePath && !shownSpecial && specials.length > 0) {
        shownSpecial = specials[specials.length - 1];
      }
      announceActive();
    }
  }

  // ---------------------------------------------------------------- 渲染

  function renderAll(): void {
    const file = activeFile();
    // 換了一份（或沒了）：DOM 裡還是上一份，先把它的游標與滾動留住；換上之後在下面放回這一份的。
    const switched = file !== shown;
    if (switched && shown) {
      stashView(shown);
    }
    renderTabs();
    // 特殊標籤：正顯示著的那一個掛上、露出來，其餘藏起來（畫什麼由那個模組管）。
    for (const id of specials) {
      const spec = specialTabOf(id);
      if (id === shownSpecial) {
        spec?.show(pane);
      } else {
        spec?.hide(pane);
      }
    }

    const showing = previewing(file);
    setHidden(el.welcome, !!file || !!shownSpecial);
    setHidden(el.toolbar, !file);
    setHidden(el.area, !file || showing);
    setHidden(el.preview, !file || !showing);

    const conflict = file ? conflicts.get(file.path) : undefined;
    const gone = !!file?.gone && !conflict;
    setHidden(el.conflict, !conflict && !gone);
    // 磁碟上已經沒有這一份：沒有磁碟版本可載入。儲存（含衝突條上的強制儲存）會先問要不要在原路徑重建。
    setHidden(el.conflictTake, gone);
    if (gone && file) {
      el.conflictText.textContent =
        `磁碟上已經沒有「${file.name}」這個檔案（被刪或改名）。編輯器裡的內容還在；` +
        '要儲存的話，會先問你要不要在原路徑重建。';
    } else if (conflict && file) {
      el.conflictText.textContent = conflict.reopen
        ? `「${file.name}」在磁碟上已被改動（剛寫入了新內容，或在別處改過），編輯器裡還有未儲存的修改，沒有覆蓋。`
        : `「${file.name}」在磁碟上已被改動（可能是你在別處編輯，或外掛寫入了內容）。` +
          '為不覆蓋別人的修改，這次儲存已取消。';
    }

    if (!file) {
      renderWordStatus(el.statusWords, pane, undefined);
      el.statusPos.textContent = '';
      renderSaveState(el.statusSave, undefined);
      el.statusFile.textContent = '';
      el.plotBtn.classList.add('hidden');
      el.draftBtn.classList.add('hidden');
      shown = undefined;
      emitEditorChange({ type: 'render', pane });
      return;
    }

    // 麵包屑（後端給的稱呼），原始路徑在懸停提示上；目錄段點了在「檔案」頁定位。
    renderBreadcrumb(el.path, file);

    setHidden(el.previewBtn, !canPreview(file));
    el.previewBtn.textContent = showing ? '編輯' : '預覽';
    el.previewBtn.title = `${showing ? '回到編輯' : '預覽 Markdown'}（${shortcutLabel('preview')}）`;
    el.area.classList.toggle('mono', CODE_RE.test(file.path));
    // draftPath 由後端給出（它知道什麼算章節），前端不自己判斷。細綱與草稿一樣只對章節給。
    setHidden(el.plotBtn, !file.draftPath);
    setHidden(el.draftBtn, !file.draftPath);

    if (el.area.value !== viewText(file.draft)) {
      el.area.value = file.draft;
    }
    if (showing) {
      showPreview(file);
    }
    if (switched) {
      shown = file;
      restoreView(file);
    }

    const dirty = file.draft !== file.text;
    el.saveBtn.disabled = !dirty;
    el.revertBtn.disabled = !dirty;
    updateStatus();
    emitEditorChange({ type: 'render', pane });
  }

  /** 重畫預覽。滾動位置留著：儲存回執、磁碟上的新版進來都會重畫，不該把人彈回頂上。 */
  function showPreview(file: OpenFile): void {
    const top = el.preview.scrollTop;
    renderPreview(el.preview, file.draft, file.path, (path) =>
      // 在哪一塊預覽裡點的，就開在哪一塊。
      post({ type: 'openEditor', path, pane: pane.id })
    );
    el.preview.scrollTop = top;
  }

  function updateStatus(): void {
    const file = activeFile();
    if (!file) {
      return;
    }

    el.statusFile.textContent = file.name;
    // 字數那一格（全文 / 選中、距目標、本次 / 今日碼字，點開是碼字統計面板）歸 stats.ts。
    renderWordStatus(el.statusWords, pane, file);

    if (previewing(file)) {
      el.statusPos.textContent = '預覽';
    } else {
      const upto = el.area.value.slice(0, el.area.selectionStart);
      const line = upto.split('\n').length;
      const col = upto.length - upto.lastIndexOf('\n');
      el.statusPos.textContent = `行 ${line}，列 ${col}`;
    }

    // 「● 未儲存」→「儲存中…」→「已儲存 14:32」，自動儲存開著時旁邊掛一枚（saving.ts）。
    renderSaveState(el.statusSave, file);
  }

  /** 儲存狀態變了（saving.ts 調）：標籤與狀態列重畫，正文不動。 */
  function refresh(): void {
    renderTabs();
    updateStatus();
  }

  // ---------------------------------------------------------------- 編輯

  function currentSelection(): TextSelection {
    return { start: el.area.selectionStart, end: el.area.selectionEnd };
  }

  /**
   * 改動之前的選區。`beforeinput` 那一刻的選區最準（瀏覽器還沒動 textarea）；拿不到時
   * （老瀏覽器、測試裡合成的 `input`）照差異推：退格前游標在被刪那段的末尾，Delete 前在開頭，
   * 打字蓋掉選區時選中的就是被蓋掉的那段，純插入是游標停在起點。
   */
  let selectionBefore: TextSelection | undefined;
  /** 輸入法組字中：拼音還沒上屏，這期間的 `input` 只重新整理顯示，不記撤銷。 */
  let composing = false;
  /** 組字開始那一刻的內容與選區，`compositionend` 時整段算一步。 */
  let compositionBase: { text: string; selection: TextSelection } | undefined;

  function derivedBefore(change: TextChange, inputType: string | undefined): TextSelection {
    const end = change.at + change.removed.length;
    if (change.inserted === '') {
      const caret = inputType?.endsWith('Forward') ? change.at : end;
      return { start: caret, end: caret };
    }
    return { start: change.at, end };
  }

  /**
   * 內容變了之後的那一串收尾：衝突條過期、標籤圓點、按鈕、狀態列、草稿持久化、通知訂閱者。
   * 文字已經寫進 `file.draft`（當前檔案也已寫進 textarea）。
   */
  function afterContentChange(file: OpenFile, source: EditSource, change?: TextChange): void {
    // 內容一變，之前那次衝突提示就過期了（磁碟上沒了這件事不會因為打字就過期）。
    conflicts.delete(file.path);
    // 在臨時標籤裡改了東西：轉正。有未儲存修改的標籤永遠不會被換掉，靠的就是這一句。
    if (file.preview && file.draft !== file.text) {
      file.preview = false;
      schedulePersist();
    }
    renderTabs();
    if (file === activeFile()) {
      setHidden(el.conflict, !file.gone);
      const dirty = file.draft !== file.text;
      el.saveBtn.disabled = !dirty;
      el.revertBtn.disabled = !dirty;
      if (previewing(file)) {
        showPreview(file);
      }
      updateStatus();
    }
    schedulePersist();
    emitEditorChange({ type: 'edit', pane, file, source, change });
  }

  /** 把 `file.draft` 寫進 textarea 並落選區（當前檔案、不在預覽時）。保住滾動位置。 */
  function showDraft(file: OpenFile, selection: TextSelection): void {
    const sel = clampSelection(selection, viewText(file.draft).length);
    file.caret = sel.start;
    if (file !== activeFile() || previewing(file)) {
      return;
    }
    const top = el.area.scrollTop;
    if (el.area.value !== viewText(file.draft)) {
      el.area.value = file.draft;
    }
    el.area.scrollTop = top;
    el.area.setSelectionRange(sel.start, sel.end);
  }

  /** 記一步撤銷、換內容、寫回編輯區、收尾。打字以外的改動最後都落到這裡。 */
  function commitEdit(
    file: OpenFile,
    next: string,
    change: TextChange,
    before: TextSelection,
    after: TextSelection,
    source: EditSource,
    join?: boolean
  ): void {
    file.history.record(change, before, after, { join });
    file.draft = next;
    showDraft(file, after);
    afterContentChange(file, source, change);
  }

  /** 改動之前的選區：當前檔案取 textarea 的，否則取切走時留下的游標。 */
  function selectionOf(file: OpenFile): TextSelection {
    return file === activeFile() && !previewing(file)
      ? currentSelection()
      : { start: file.caret, end: file.caret };
  }

  function applyEdit(
    start: number,
    end: number,
    text: string,
    selection?: TextSelection,
    opts?: ApplyEditOptions
  ): boolean {
    const file = activeFile();
    if (!file) {
      return false;
    }
    const view = viewText(file.draft);
    const range = clampSelection({ start, end }, view.length);
    const inserted = viewText(text);
    const next = view.slice(0, range.start) + inserted + view.slice(range.end);
    const caret = range.start + inserted.length;
    const after = clampSelection(selection ?? { start: caret, end: caret }, next.length);
    if (next === view) {
      showDraft(file, after);
      return false;
    }
    // 磁碟上讀來的 `\r\n` 還沒被編輯區歸一過時，這一步連歸一一起記：撤銷回去仍是原樣。
    const change =
      view === file.draft
        ? trimChange(range.start, view.slice(range.start, range.end), inserted)
        : diffText(file.draft, next);
    if (!change) {
      return false;
    }
    commitEdit(file, next, change, selectionOf(file), after, opts?.source ?? 'program', opts?.join);
    return true;
  }

  /** 去掉替換前後相同的頭尾，只記真正變了的那一段。 */
  function trimChange(at: number, removed: string, inserted: string): TextChange | undefined {
    const d = diffText(removed, inserted);
    return d && { at: at + d.at, removed: d.removed, inserted: d.inserted };
  }

  /**
   * 整份換內容（「還原」、用磁碟版本覆蓋、未改過的檔案被再次開啟時換成磁碟新版）：也記一步，
   * 作者可以撤銷回去——那時它又是髒的，與磁碟不一致，邏輯自洽。游標儘量留在原處。
   */
  function replaceAll(file: OpenFile, next: string): void {
    const change = diffText(file.draft, next);
    if (!change) {
      return;
    }
    const before = selectionOf(file);
    commitEdit(file, next, change, before, clampSelection(before, viewText(next).length), 'program');
  }

  function undo(): boolean {
    return stepHistory('undo');
  }

  function redo(): boolean {
    return stepHistory('redo');
  }

  function stepHistory(dir: 'undo' | 'redo'): boolean {
    const file = activeFile();
    // 組字中途不動：組字開始時記下的那份底稿會對不上。
    if (!file || composing) {
      return false;
    }
    const result = dir === 'undo' ? file.history.undo(file.draft) : file.history.redo(file.draft);
    if (!result) {
      return false;
    }
    file.draft = result.text;
    showDraft(file, result.selection);
    afterContentChange(file, dir);
    return true;
  }

  el.area.addEventListener('beforeinput', (e) => {
    // 瀏覽器自己的撤銷 / 重做（右鍵選單、系統快捷鍵）也走編輯器的記錄。
    if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
      e.preventDefault();
      stepHistory(e.inputType === 'historyUndo' ? 'undo' : 'redo');
      return;
    }
    if (!composing) {
      selectionBefore = currentSelection();
    }
  });

  el.area.addEventListener('input', (e) => {
    const file = activeFile();
    if (!file) {
      return;
    }
    const next = el.area.value;
    if (composing || (e as InputEvent).isComposing) {
      // 組字中途：只重新整理顯示（字數、圓點），不記撤銷；底稿留到 compositionend。
      compositionBase ??= { text: file.draft, selection: selectionBefore ?? currentSelection() };
      if (next !== file.draft) {
        file.draft = next;
        afterContentChange(file, 'composition');
      }
      return;
    }
    const before = selectionBefore;
    selectionBefore = undefined;
    const change = diffText(file.draft, next, el.area.selectionEnd);
    if (!change) {
      return;
    }
    const inputType = (e as InputEvent).inputType || undefined;
    const typing = !inputType || TYPING_INPUT.has(inputType);
    file.history.record(change, before ?? derivedBefore(change, inputType), currentSelection(), { merge: typing });
    file.draft = next;
    afterContentChange(file, typing ? 'typing' : 'input', change);
  });

  el.area.addEventListener('compositionstart', () => {
    const file = activeFile();
    composing = true;
    compositionBase = file ? { text: file.draft, selection: currentSelection() } : undefined;
  });

  el.area.addEventListener('compositionend', () => {
    composing = false;
    const base = compositionBase;
    compositionBase = undefined;
    selectionBefore = undefined;
    const file = activeFile();
    if (!file || !base) {
      return;
    }
    // 上屏的那一整段算一步（取消組字時前後一樣，什麼都不記）。
    const next = el.area.value;
    const change = diffText(base.text, next, el.area.selectionEnd);
    if (change) {
      file.history.record(change, base.selection, currentSelection());
    }
    if (next !== file.draft) {
      file.draft = next;
      afterContentChange(file, 'composition', change);
    } else if (change) {
      emitEditorChange({ type: 'edit', pane, file, source: 'composition', change });
    }
  });

  for (const evt of ['keyup', 'click', 'select'] as const) {
    el.area.addEventListener(evt, updateStatus);
  }

  el.area.addEventListener('scroll', () => {
    const file = activeFile();
    if (file) {
      file.scrollTop = el.area.scrollTop;
    }
  });

  /** Ctrl/Cmd+Z 撤銷，Ctrl+Y 與 Ctrl/Cmd+Shift+Z 重做。認出來返回 true。 */
  function historyKey(e: KeyboardEvent): 'undo' | 'redo' | undefined {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) {
      return undefined;
    }
    const key = e.key.toLowerCase();
    if (key === 'z') {
      return e.shiftKey ? 'redo' : 'undo';
    }
    if (key === 'y' && e.ctrlKey && !e.shiftKey) {
      return 'redo';
    }
    return undefined;
  }

  el.area.addEventListener('keydown', (e) => {
    // 輸入法組字中途的按鍵一律放行：Tab、回車、Ctrl 組合鍵都是輸入法的。
    if (isImeComposing(e)) {
      return;
    }
    const file = activeFile();
    if (!file) {
      return;
    }
    const step = historyKey(e);
    if (step) {
      e.preventDefault();
      stepHistory(step);
      return;
    }
    if (runKeyHandlers(e, { pane, file, area: el.area })) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      handleTab(e.shiftKey);
    }
  });

  /**
   * Tab 在 textarea 裡預設是切焦點；寫作時更需要它縮排（規則見 `indent.ts`，單位見 `indentUnit`：
   * 正文兩個全形空格，其餘兩個半形空格）。沒有選區時在游標處插一級；有選區時給碰到的每一行
   * 行首加一級，**選中的字一個不刪**；Shift+Tab 去掉一級。一次按鍵一步撤銷。
   */
  function handleTab(shift: boolean): void {
    const file = activeFile();
    if (!file) {
      return;
    }
    const value = el.area.value;
    const sel = currentSelection();
    const unit = indentUnit(file);
    if (!shift && sel.start === sel.end) {
      applyEdit(sel.start, sel.end, unit);
      return;
    }
    const edit = shift ? outdentLines(value, sel) : indentLines(value, sel, unit);
    if (edit) {
      applyEdit(edit.start, edit.end, edit.text, edit.selection);
    }
  }

  // 標籤條空白處右鍵：以當前啟用標籤為準。
  onContextMenu(el.tabs, () => (pane.activePath ? tabMenuItems(pane.activePath) : []));

  // 正文區選單：預覽模式沒有可編輯內容，provider 返回空陣列即不彈。
  // 功能模組加的項（按在名字上：開啟它的卡或條目）排在最前面，見 api.ts 的 addAreaMenu。
  onContextMenu(el.area, (at) => {
    if (previewing(activeFile())) {
      return [];
    }
    const hasSel = el.area.selectionStart !== el.area.selectionEnd;
    const extra = areaMenuItems(pane, at);
    return [
      ...extra,
      ...(extra.length > 0 ? [{ sep: true } as const] : []),
      { label: '剪下', disabled: !hasSel, run: () => areaCut(pane) },
      { label: '複製', disabled: !hasSel, run: () => areaCopy(el.area) },
      { label: '貼上', run: () => void areaPaste(pane) },
      { sep: true },
      {
        label: '全選',
        run: () => {
          el.area.focus();
          el.area.select();
        },
      },
    ];
  });

  // 誰被點/被聚焦，誰就是「當前」這一塊——Ctrl+S 儲存的是它。
  // 換了一塊就等於換了「正在編輯的檔案」，資源管理器的高亮要跟著走。
  const claimFocus = () => {
    if (activePane !== pane) {
      setActivePane(pane);
      announceActive();
    }
  };
  el.root.addEventListener('focusin', claimFocus);
  el.root.addEventListener('pointerdown', claimFocus);

  // ---------------------------------------------------------------- 儲存

  function save(force: boolean): void {
    // 在臨時標籤上按了儲存（Ctrl+S、工具欄、「檔案 → 儲存」）：轉正，哪怕沒有可存的。
    if (pane.activePath) {
      pin(pane.activePath);
    }
    savePath(pane.activePath ?? '', force);
  }

  function savePath(path: string, force: boolean): void {
    // 經 saving.ts：同一份同一時刻只有一個儲存在路上，狀態列跟著走；磁碟上沒了的先問要不要重建。
    void requestSave(pane, path, { force });
  }

  /**
   * 選中引文那一句。按編輯區裡**當下**的文字找（可能有沒儲存的修改）；預覽模式先切回編輯。
   * 滾動用高亮映象層量出那一句的縱向位置（`highlight.ts` 的 `scrollToOffset`），停在視口偏上三分之一。
   */
  function reveal(path: string, quote: string): boolean {
    if (!files.has(path)) {
      return false;
    }
    if (pane.activePath !== path) {
      activate(path);
    }
    setPreviewing(false);
    const at = locateQuote(el.area.value, quote);
    if (!at) {
      return false;
    }
    el.area.focus();
    el.area.setSelectionRange(at.start, at.end);
    scrollToOffset(pane, at.start);
    stashCaret();
    return true;
  }

  function applySaved(incoming: EditorFileView): void {
    const file = files.get(incoming.path);
    if (!file) {
      settleSave(incoming.path, 'saved');
      return;
    }
    // 這邊沒有儲存在路上：是別的視窗存了同一份（回執是廣播的）。對這邊來說那是磁碟變了，不是存成了——
    // 照「磁碟上變了」處理。從前這裡直接把基線換成別人存的那一份，下一次儲存就把別人的改動蓋掉了。
    if (!isSaving(incoming.path)) {
      applyDiskChange(incoming);
      return;
    }
    file.text = incoming.text;
    file.hash = incoming.hash;
    file.gone = false;
    diskSeen.delete(file.path);
    // draftPath 後端每次都會帶回；萬一缺席也不要把已有的值沖掉，
    // 否則工具欄上的「草稿」按鈕會在首次儲存後消失。
    if (incoming.draftPath !== undefined) {
      file.draftPath = incoming.draftPath;
    }
    if (incoming.kind !== undefined) {
      file.kind = incoming.kind;
    }
    if (incoming.label !== undefined) {
      file.label = incoming.label;
    }
    conflicts.delete(file.path);
    renderAll();
    persist();
    // 存成了不彈 toast：狀態列寫「已儲存 14:32」。儲存期間又敲了字的仍是髒的，狀態列照實寫「未儲存」；
    // 在路上時又要存過的，settleSave 接著再存一次。
    settleSave(file.path, 'saved');
  }

  function applyConflict(path: string, diskText: string, diskHash: string): void {
    const file = files.get(path);
    if (!file) {
      settleSave(path, 'conflict');
      return;
    }
    if (!isSaving(path)) {
      // 不是這邊那一次（別的視窗的儲存撞了衝突，回執是廣播的）：只當它帶來了一份磁碟版本。
      applyDiskChange({ path, name: file.name, text: diskText, hash: diskHash, bytes: diskText.length });
      return;
    }
    const auto = isAutoSaving(path);
    conflicts.set(path, { text: diskText, hash: diskHash });
    diskSeen.set(path, diskHash);
    file.gone = false;
    // 撞上衝突：這一份不再自動儲存，直到作者在衝突條上選了（基線換了）。絕不替他強制儲存。
    blockAutoSave(path, file.hash);
    settleSave(path, 'conflict');
    // 手動儲存撞上的切過去給人看；自動儲存撞上的不切（作者可能正在別的標籤裡寫），標籤上掛著「!」。
    if (!auto && pane.activePath !== path) {
      activate(path);
    } else {
      renderAll();
    }
    toast(
      auto
        ? `「${file.name}」在磁碟上已被改過，這一份先不自動儲存了，編輯器裡的修改留著。`
        : '檔案已被外部修改，儲存已取消。',
      true
    );
  }

  function applyDiskChange(incoming: EditorFileView): void {
    const file = files.get(incoming.path);
    if (!file) {
      return;
    }
    const wasGone = !!file.gone;
    file.gone = false;
    if (incoming.draftPath !== undefined) {
      file.draftPath = incoming.draftPath;
    }
    if (incoming.kind !== undefined) {
      file.kind = incoming.kind;
    }
    if (incoming.label !== undefined) {
      file.label = incoming.label;
    }
    if (incoming.hash === file.hash) {
      // 磁碟上就是基線那一份（又出現了、或別處存回了同一份）：之前見過的新版與衝突都作廢。
      diskSeen.delete(file.path);
      conflicts.delete(file.path);
      renderAll();
      return;
    }
    if (!wasGone && incoming.hash === diskSeen.get(file.path)) {
      return; // 這一份新版已經知道了（衝突條收起了也一樣），不再報第二次。
    }
    if (file.draft === file.text) {
      // 沒改過：就地換成新內容。記一步撤銷（與「再次開啟時磁碟有新版」同一處理），不切標籤、不搶焦點，
      // 游標與滾動留在原處（夾進新長度）。
      file.text = incoming.text;
      file.hash = incoming.hash;
      diskSeen.delete(file.path);
      conflicts.delete(file.path);
      replaceAll(file, incoming.text);
      if (file === activeFile()) {
        noteStatus(file.path, '磁碟上有新版本，已載入');
      }
    } else if (viewText(incoming.text) === viewText(file.draft)) {
      // 磁碟上的正好就是編輯器裡這一份（別處存了同樣的字）：認下來，不算衝突。
      file.text = incoming.text;
      file.hash = incoming.hash;
      diskSeen.delete(file.path);
      conflicts.delete(file.path);
    } else {
      // 改過：編輯器裡的修改一個字不動，掛衝突條，標籤上標出來；自動儲存先停下（存了也是撞衝突）。
      conflicts.set(file.path, { text: incoming.text, hash: incoming.hash, reopen: true });
      diskSeen.set(file.path, incoming.hash);
      blockAutoSave(file.path, file.hash);
      toast(`「${file.name}」在磁碟上被改過，編輯器裡的修改留著、沒有覆蓋（標籤上標了「!」）。`, true);
    }
    renderAll();
    persist();
  }

  function markGone(path: string): void {
    const file = files.get(path);
    const saving = isSaving(path);
    settleSave(path, 'gone');
    if (!file) {
      return;
    }
    const fresh = !file.gone;
    file.gone = true;
    conflicts.delete(path);
    diskSeen.delete(path);
    if (saving) {
      toast(`「${file.name}」在磁碟上已經沒有了（被刪或改名），這次沒有儲存。再按一次儲存會先問你要不要在原路徑重建。`, true);
    } else if (fresh && file.draft !== file.text) {
      toast(`「${file.name}」在磁碟上已經沒有了（被刪或改名），編輯器裡的修改還在。`, true);
    }
    renderAll();
  }

  function knownDiskHash(path: string): string {
    const file = files.get(path);
    if (!file || file.gone) {
      return '';
    }
    return diskSeen.get(path) ?? file.hash;
  }

  /**
   * 「對比合併…」放回編輯器之後（`replace.ts`）：基線換成合併時讀到的磁碟那份，衝突就此解決——與衝突條上
   * 「用磁碟版本覆蓋」同一套收尾：衝突條收起、見過的磁碟新版（`diskSeen`）作廢（之後磁碟再變、哪怕變回那一份，
   * 核對時照樣報）、自動儲存的閘放開（之後照常停筆就存，帶的是新基線）。磁碟上讀得到才合併得了，所以也不再是「沒了」。
   */
  function rebase(path: string, text: string, hash: string): void {
    const file = files.get(path);
    if (!file) {
      return;
    }
    file.text = text;
    file.hash = hash;
    file.gone = false;
    diskSeen.delete(path);
    unblockAutoSave(path);
    conflicts.delete(path);
    renderAll();
    persist();
  }

  // 按鈕上寫的鍵按平臺（Mac 上 ⌘S），從快捷鍵表取；頁面模板裡那一句只是沒跑指令碼時的樣子。
  el.saveBtn.title = `儲存（${shortcutLabel('save')}）`;
  el.saveBtn.addEventListener('click', () => save(false));

  el.revertBtn.addEventListener('click', () => {
    const file = activeFile();
    if (!file) {
      return;
    }
    const reload = (): void => {
      reloading.add(file.path);
      // 磁碟版回來之前別讓自動儲存把要丟掉的修改存下去。
      holdSave(file.path);
      post({ type: 'reloadFile', path: file.path });
    };
    if (file.draft === file.text) {
      reload();
      return;
    }
    void askDialog({
      title: '還原',
      message: `放棄「${file.name}」的未儲存修改，重新從磁碟讀取？`,
      detail: '放棄之後還能按 Ctrl+Z 撤銷回來。',
      buttons: [
        { value: 'cancel', label: '取消' },
        { value: 'revert', label: '放棄修改', primary: true, danger: true },
      ],
      cancel: 'cancel',
    }).then((answer) => {
      if (answer === 'revert' && files.get(file.path) === file) {
        reload();
      }
    });
  });

  el.previewBtn.addEventListener('click', () => {
    setPreviewing(!previewing(activeFile()));
  });

  // 預覽能拿焦點（不進 Tab 順序）：切到預覽之後方向鍵、翻頁鍵滾的是它，再按一下 Ctrl+Shift+V 也認得出是這一塊。
  el.preview.tabIndex = -1;
  el.preview.addEventListener('scroll', () => {
    const file = activeFile();
    if (file && previewing(file)) {
      file.previewScrollTop = el.preview.scrollTop;
    }
  });

  el.externalBtn.addEventListener('click', () => {
    const file = activeFile();
    if (file) {
      post({ type: 'openExternal', path: file.path });
    }
  });

  el.plotBtn.addEventListener('click', () => {
    const file = activeFile();
    // 與「草稿」一樣傳**章節**路徑：細綱落在哪由後端推導，還沒有就按模板建一份。
    if (file) {
      post({ type: 'openPlot', path: file.path });
    }
  });

  el.draftBtn.addEventListener('click', () => {
    const file = activeFile();
    // 傳的是**章節**路徑：草稿路徑由後端推導，並在缺席時按需建立。
    if (file) {
      post({ type: 'openDraft', path: file.path });
    }
  });

  el.conflictTake.addEventListener('click', () => {
    const file = activeFile();
    const disk = file && conflicts.get(file.path);
    if (!file || !disk) {
      return;
    }
    file.text = disk.text;
    file.hash = disk.hash;
    diskSeen.delete(file.path);
    // 整份換內容也記一步：點錯了可以撤銷回編輯器裡原來那份。
    replaceAll(file, disk.text);
    conflicts.delete(file.path);
    renderAll();
    persist();
    toast('已載入磁碟上的版本。');
  });

  el.conflictForce.addEventListener('click', () => {
    const file = activeFile();
    if (!file) {
      return;
    }
    // 磁碟上已經沒有這一份：沒有「別人的改動」可丟，儲存那條路會問要不要在原路徑重建（重建照樣帶基線）。
    if (file.gone) {
      savePath(file.path, true);
      return;
    }
    void askDialog({
      title: '用編輯器內容強制儲存',
      message: `確定用編輯器裡的內容覆蓋磁碟上的「${file.name}」？磁碟上的改動會丟失。`,
      buttons: [
        { value: 'cancel', label: '取消' },
        { value: 'force', label: '覆蓋磁碟上的版本', primary: true, danger: true },
      ],
      cancel: 'cancel',
    }).then((answer) => {
      if (answer === 'force') {
        savePath(file.path, true);
      }
    });
  });

  // ---------------------------------------------------------------- 收檔案

  function upsertFile(incoming: EditorFileView, carried?: CarriedDraft, intent?: EditorOpenIntent): void {
    const existing = files.get(incoming.path);
    const pending = pendingDrafts.get(incoming.path);
    pendingDrafts.delete(incoming.path);
    // 單擊開啟（工程頁 / 檔案頁的一行）且開關開著：開成臨時標籤。
    const wantPreview = !!intent?.preview && previewTabsEnabled();

    if (existing) {
      // 已開啟。只有「還原」發起的那一次才沖掉未儲存的修改；其餘的（落盤後
      // 自動開啟、工程頁再點一次）碰上髒草稿就不動它——磁碟版變了就掛衝突條
      // 讓作者自己選，沒變就只是切過去。
      const reload = reloading.delete(incoming.path);
      if (reload) {
        releaseSave(incoming.path);
      }
      const dirty = existing.draft !== existing.text;
      if (reload || !dirty) {
        existing.text = incoming.text;
        existing.hash = incoming.hash;
        existing.gone = false;
        diskSeen.delete(incoming.path);
        // 「還原」也記一步撤銷：作者可以退回剛才沒儲存的那份。
        replaceAll(existing, incoming.text);
        conflicts.delete(incoming.path);
      } else if (incoming.hash !== existing.hash) {
        conflicts.set(incoming.path, { text: incoming.text, hash: incoming.hash, reopen: true });
        diskSeen.set(incoming.path, incoming.hash);
        existing.gone = false;
        blockAutoSave(incoming.path, existing.hash);
        toast(`「${existing.name}」在磁碟上已被改過，編輯器裡的未儲存修改保留著。`, true);
      }
      if (incoming.draftPath !== undefined) {
        existing.draftPath = incoming.draftPath;
      }
      if (incoming.kind !== undefined) {
        existing.kind = incoming.kind;
      }
      if (incoming.label !== undefined) {
        existing.label = incoming.label;
      }
      // 已經開著的被別的路子正常開啟了一次（落盤後自動開啟、點引文、雙擊那一行……）：臨時標籤就此轉正。
      // 單擊開啟一份已經開著的什麼都不改——不把一個固定的標籤降回臨時的。
      if (!intent?.preview) {
        existing.preview = false;
      }
      leaveSpecial();
      pane.activePath = incoming.path;
    } else {
      // 從另一塊搬來的（帶著草稿或撤銷歷史）優先；否則看重新整理前存下的草稿。
      const restore = carried && (carried.draft !== undefined || carried.history) ? carried : pending;
      const file = newFile(incoming, restore);
      if (restore?.local) {
        // 頁面裡直接搬過來的：衝突條與見過的磁碟新版照舊掛著（基線沒換，它們還作數）。
        if (restore.conflict) {
          conflicts.set(file.path, restore.conflict);
        }
        if (restore.diskSeen) {
          diskSeen.set(file.path, restore.diskSeen);
        }
      }
      file.preview = previewOf(file, carried, pending, wantPreview);
      insertFile(file, slotFor(file, intent));
      forgetClosed(file.path);
      claimActivePath(incoming.path, !!pending && !carried);
    }

    renderAll();
    announceActive();
    persist();
    refreshOtherTabs(pane);
  }

  /**
   * 新收進來的這一份是不是臨時標籤。有未儲存修改的一律不是；從另一塊經 `editorOpen` 搬來的保持原樣
   * （單擊開啟才保持臨時，別的路子開啟的轉正）；「移到另一側」搬來的轉正（作者明說要它在那邊）；重新整理恢復、
   * 改名搬家的照存下來的那樣（開關關了就不是）；其餘看這一次是不是單擊開啟的。
   */
  function previewOf(
    file: OpenFile,
    carried: CarriedDraft | undefined,
    pending: CarriedDraft | undefined,
    wantPreview: boolean
  ): boolean {
    if (file.draft !== file.text) {
      return false;
    }
    if (carried) {
      return !carried.local && !!carried.preview && wantPreview;
    }
    if (pending?.preview !== undefined) {
      return pending.preview && previewTabsEnabled();
    }
    return wantPreview;
  }

  /**
   * 新的一份佔誰的位置：
   * 1. `replace`（上一章 / 下一章）指著的那一份**沒改過**就在它的位置換掉（它是臨時的，新的一份接著是臨時的）；
   *    改過了就另開一個標籤。
   * 2. 新的一份是臨時標籤：這一塊已有的那個臨時標籤被換掉（它一改就轉正了，所以總是沒改過的；萬一改過，轉正、不換）。
   * 3. 都不是：開在最後。
   */
  function slotFor(file: OpenFile, intent: EditorOpenIntent | undefined): string | undefined {
    const target = intent?.replace;
    if (target && target !== file.path) {
      const old = files.get(target);
      if (old && old.draft === old.text) {
        if (old.preview && previewTabsEnabled() && file.draft === file.text) {
          file.preview = true;
        }
        return target;
      }
    }
    if (file.preview) {
      const old = [...files.values()].find((f) => f.preview && f.path !== file.path);
      if (old && old.draft === old.text) {
        return old.path;
      }
      if (old) {
        old.preview = false;
      }
    }
    return undefined;
  }

  /** 把新的一份放進標籤表：給了 `at` 就佔它的位置（它被換掉，不進「最近關閉」），否則排在最後。 */
  function insertFile(file: OpenFile, at: string | undefined): void {
    if (!at || !files.has(at)) {
      files.set(file.path, file);
      return;
    }
    keepView(at);
    const entries = [...files.entries()];
    files.clear();
    for (const [path, f] of entries) {
      if (path === at) {
        files.set(file.path, file);
      } else if (path !== file.path) {
        files.set(path, f);
      }
    }
    conflicts.delete(at);
    diskSeen.delete(at);
    if (pane.activePath === at) {
      pane.activePath = file.path;
    }
  }

  function newFile(incoming: EditorFileView, restore?: CarriedDraft): OpenFile {
    const file: OpenFile = {
      path: incoming.path,
      name: incoming.name,
      text: incoming.text,
      hash: incoming.hash,
      draft: incoming.text,
      draftPath: incoming.draftPath,
      kind: incoming.kind,
      label: incoming.label,
      caret: 0,
      scrollTop: 0,
      history: new EditHistory(),
    };
    if (restore?.draft !== undefined) {
      // 重新整理前的未儲存草稿（或從另一塊編輯區搬過來的）：僅當磁碟內容未變
      // （hash 一致）才貼回去，否則拿舊內容蓋新內容就是另一種靜默覆蓋。
      // moved 是例外——檔案剛改名/搬家，hash 基線必然變了，草稿照貼。
      if (restore.moved || restore.hash === incoming.hash) {
        file.draft = restore.draft;
      } else {
        toast(`「${file.name}」在離開期間被改過，已放棄未儲存的草稿。`, true);
      }
    }
    // 預覽還是編輯：搬家、重新整理恢復都照原樣（⚑ 重新整理恢復也記著）。
    if (restore?.markdownPreview) {
      file.markdownPreview = true;
    }
    // 搬家帶來的撤銷歷史：內容與搬走時一字不差才接上，否則那份差異對不上位置。
    if (restore?.history && restore.historyText === file.draft) {
      file.history = restore.history;
    }
    // 頁面裡直接搬過來的（「移到另一側」）：「磁碟上沒了」與游標、滾動位置也接上。
    if (restore?.local) {
      file.gone = !!restore.gone;
      file.caret = restore.caret ?? 0;
      file.scrollTop = restore.scrollTop ?? 0;
    }
    // 這一頁裡關掉過（或臨時標籤被換掉過）：回到關掉時的游標與滾動。內容變了的話夾進新長度（`restoreView`）。
    const seen = takeView(incoming.path);
    if (seen && !restore?.local) {
      file.caret = seen.caret;
      file.scrollTop = seen.scrollTop;
    }
    return file;
  }

  /**
   * 恢復階段按存下來的 active 定位，其餘情況新開的就是當前的。`restoring`：這一份是重新整理恢復回來的——特殊標籤正顯示著時
   * 不把它換下去（存下來的那一份記成「關掉特殊標籤時回到它」）；作者此刻從別處開啟的照常切過去。
   */
  function claimActivePath(path: string, restoring: boolean): void {
    const wanted = pendingActive.get(pane.id);
    if (shownSpecial && restoring) {
      if (wanted === path) {
        specialReturn = path;
        pendingActive.delete(pane.id);
      }
      return;
    }
    if (!wanted || wanted === path) {
      leaveSpecial();
      pane.activePath = path;
      if (wanted) {
        pendingActive.delete(pane.id);
      }
    } else if (!pane.activePath) {
      leaveSpecial();
      pane.activePath = path;
    }
  }

  renderAll();
  return pane;
}
