/**
 * 獨立版的內建檔案編輯器。只在獨立版載入（外掛形態由 VS Code 自己的編輯器
 * 負責），因此這裡可以自由使用 localStorage、beforeunload 等 webview 裡
 * 不該用的能力。
 *
 * 與 view 完全解耦：各自監聽 window 的 message 事件、各自 postMessage，
 * 互不呼叫。唯一的交集是共用 #toast 與右鍵選單引擎（見 src/globals.ts）。
 *
 * **兩塊編輯區**：主區放正文，第二塊（`pane: 'draft'`）放草稿或並排開啟的細綱，左右並列。
 * **一個路徑同一時刻只屬於一塊**——editorSaved / editorConflict / editorError
 * 都只帶 path，靠這條不變數才認得出該送給誰（`paneOwning`）。破壞它會導致
 * 從錯的那塊儲存時用錯 baseHash，觸發假衝突。
 *
 * 協議：
 *   發 openEditor{path,pane,preview?,replace?} / openDraft{path} / saveFile / reloadFile / openExternal / checkEditorFiles
 *   收 editorOpen{file,pane,preview?,replace?} / editorSaved / editorConflict / editorError / editorDiskChanged / editorDiskGone
 *   / chapterIndex（章節索引，chapterIndex.ts）/ checkTerms（寫作體檢的詞表，check.ts）
 *   （核對磁碟那三條——checkEditorFiles / editorDiskChanged / editorDiskGone——由 diskSync.ts 收發）
 */
import { maybeById } from '../dom';
import { acquireApi, onMessage } from '../vscodeApi';
import { toast } from '../globals';
import { isImeComposing, paneForShortcut } from './api';
import { createPane } from './pane';
import { installBookFind } from './bookFind';
import { installChapterBar } from './chapterBar';
import { installCheck } from './check';
import { installChapterIndex } from './chapterIndex';
import { installChapterNav, takeQuietOpen } from './chapterNav';
import { installConflictMerge } from './conflictMerge';
import { installFind } from './find';
import { installFocus } from './focus';
import { installLook } from './look';
import { installNameMarks } from './nameMarks';
import { installNames } from './names';
import { installParagraphTools } from './paragraph';
import { installQuickOpen } from './quickOpen';
import { installEditorReplace } from './replace';
import { installSaveSafety } from './safety';
import { matchesShortcut } from './shortcuts';
import { installShortcutsPanel } from './shortcutsPanel';
import { installThreadsOverview } from './threadsOverview';
import { installTimelineOverview } from './timelineOverview';
import { installWritingStats } from './stats';
import { installVersions } from './versions';
import { installViewPrefs } from './viewPrefs';
import { createPaneElements, mainRefs } from './paneElements';
import type { CarriedDraft } from './paneElements';
import {
  collectShell,
  initResizers,
  initTheme,
  isNarrow,
  revealEditor,
} from './shell';
import {
  activePane,
  allOpenFiles,
  announceActive,
  bindStore,
  cancelScheduledPersist,
  clearClosed,
  paneOwning,
  panes,
  pendingActive,
  pendingDrafts,
  registerPane,
  rekeyStorage,
  restore,
  setActivePane,
  syncDraftVisibility,
} from './store';
import type { Pane } from './store';

const stage = maybeById('wbEditor');
// 外掛形態沒有這塊 DOM，直接退出。
if (stage) {
  start(stage);
}

function start(stage: HTMLElement): void {
  const vscode = acquireApi();
  const post = vscode.postMessage.bind(vscode);
  const shell = collectShell();
  // ensurePane：「移到另一側」往第二塊搬東西時，它還沒造出來就現造。
  bindStore({ post, draftResizer: shell.draftResizer, ensurePane: (id) => (id === 'draft' ? ensureDraftPane() : panes.main!) });
  // 名詞補全（Alt+/ 與邊打邊彈，names.ts）。要在段落工具之前裝：候選框開著時回車 / Tab 先歸它，按鍵處理按掛的先後跑。
  installNames(post);
  // 回車、成對符號、段落快捷鍵、一鍵排版。要在造編輯區之前裝：「排版」按鈕掛在第一次重畫上。
  installParagraphTools();
  // 不丟稿：磁碟改動同步到已開的標籤、儲存狀態、自動儲存（safety.ts）。
  installSaveSafety();
  // 不丟稿：衝突條的「對比合併…」與它用的 editorReplace、側欄「版本」頁與對比標籤（工具欄「歷史」同樣掛在第一次重畫上；
  // 對比標籤是特殊標籤，要在 restore() 之前登記）。
  installEditorReplace();
  installConflictMerge(post);
  installVersions(post);

  setActivePane(registerPane(createPane('main', mainRefs(stage), post)));
  // 章節索引（後端 chapterIndex，哪個頁籤都推）→ 章節條與上一章 / 下一章（Alt+PageUp / Alt+PageDown）。
  installChapterIndex();
  installChapterNav(post);
  // 正開著某一章的正文或細綱時，主區頂上那一條（W6 章節工作臺）。
  installChapterBar(stage, post);
  // 標題欄「檢視」選單的編輯器那一半（單擊開啟為臨時標籤）。
  installViewPrefs();
  // 碼字統計：狀態列字數那一格（選中、距目標、本次 / 今日碼字）與它的面板、「檢視 → 統計」。
  installWritingStats();
  // 查詢替換（Ctrl+F / Ctrl+H / F3、「編輯」選單的查詢 / 替換）。
  installFind();
  // 寫作體檢：正文裡的 check 圖層、狀態列「體檢」那一格與它的面板、「檢視 → 體檢」、「編輯敏感詞表…」。
  installCheck(post);
  // 名詞高亮：names 圖層、懸停浮窗、Ctrl+點選開啟卡或條目、「檢視 → 名詞高亮」。名詞表的收發歸 installNames。
  installNameMarks(post);

  /**
   * 第二塊編輯區惰性建立：沒用過的人不該多出一塊空編輯區。它放草稿，也放點開一章時
   * 並排開啟的那一份細綱（W6）。
   */
  function ensureDraftPane(): Pane {
    if (!panes.draft) {
      const refs = createPaneElements('這一塊放草稿或細綱');
      shell.editors.appendChild(refs.root);
      registerPane(createPane('draft', refs, post));
    }
    syncDraftVisibility();
    return panes.draft!;
  }

  // ---------------------------------------------------------------- 全域快捷鍵

  // 鍵都登記在 shortcuts.ts（新增快捷鍵先登記在那張表裡，tests/dom/standalone/shortcuts.test.js 兩頭核對）。
  document.addEventListener('keydown', (e) => {
    // 輸入法組字中途的 Ctrl 組合鍵是輸入法的，放行。
    if (isImeComposing(e)) {
      return;
    }
    if (matchesShortcut(e, 'save')) {
      // 瀏覽器的「儲存網頁」在這裡毫無意義，一律攔掉。
      e.preventDefault();
      if (activePane.activeFile()) {
        activePane.save(false);
      }
    } else if (matchesShortcut(e, 'closeTab') && (activePane.activeFile() || activePane.activeSpecial())) {
      // Chrome 不允許攔 Ctrl+W（表裡那一條寫著），能攔到（桌面版）就順手關標籤頁。正顯示著特殊標籤（敘事線總覽）時關它。
      e.preventDefault();
      closeCurrentTab();
    } else if (matchesShortcut(e, 'preview')) {
      // 預覽 / 編輯（⚑ Ctrl+Shift+V，與 VS Code 的「開啟預覽」同一個鍵）：只對 Markdown 檔案攔，
      // 別的檔案（.txt 章節之類）照常是瀏覽器的「貼上為純文字」；焦點在對話輸入框裡不攔。
      const pane = paneForShortcut(e);
      if (pane?.canPreview()) {
        e.preventDefault();
        pane.setPreviewing(!pane.isPreviewing());
      }
    }
  });

  window.addEventListener('nf-editor-query', (e) => {
    const file = activePane?.activeFile();
    e.detail.hasFile = !!file;
    e.detail.dirtyCurrent = !!file && file.draft !== file.text;
    e.detail.dirtyAny = Object.values(panes).some((p) => p.hasDirty());
    e.detail.path = file?.path ?? null;
    e.detail.text = file?.draft ?? '';
    // 焦點在哪塊編輯區的正文區裡：標題欄「編輯 → 撤銷 / 重做」據此交給編輯器自己的歷史。
    e.detail.areaFocused = Object.values(panes).some((p) => p.area === document.activeElement);
  });

  // 工程頁「存檔點…」退回時跳過這幾份（view.js 經 `queryDirtyPaths` 問）：兩塊編輯區裡開著、有未儲存修改的，
  // 與全書替換的 `dirtyPaths()`、關標籤時的 `isDirty` 同一個判法。
  window.addEventListener('nf-dirty-query', (e) => {
    for (const file of allOpenFiles()) {
      if (file.draft !== file.text) {
        e.detail.paths.push(file.path);
      }
    }
  });

  // 對話頁「加入選區」：當前那塊編輯區裡選中的文字。預覽裡的 textarea 藏著，它的選區作者看不見，不算。
  window.addEventListener('nf-selection-query', (e) => {
    const file = activePane?.activeFile();
    if (!file || activePane.isPreviewing()) {
      return;
    }
    const { value, selectionStart, selectionEnd } = activePane.area;
    const raw = value.slice(selectionStart, selectionEnd);
    const text = raw.trim();
    if (!text) {
      return;
    }
    // 行號按去掉首尾空白之後的那一段算：多選了一個換行不該讓範圍多出一行。
    const from = selectionStart + (raw.length - raw.trimStart().length);
    const last = selectionEnd - (raw.length - raw.trimEnd().length) - 1;
    const lineOf = (offset: number) => value.slice(0, offset).split('\n').length;
    e.detail.relPath = file.path;
    e.detail.text = text;
    e.detail.start = lineOf(from);
    e.detail.end = lineOf(last);
  });

  window.addEventListener('nf-editor-command', (e) => {
    const name = e.detail.name;
    if (name === 'save') {
      activePane.save(false);
    } else if (name === 'saveAll') {
      for (const pane of Object.values(panes)) {
        for (const file of pane.files.values()) {
          pane.savePath(file.path, false);
        }
      }
    } else if (name === 'close') {
      closeCurrentTab();
    } else if (name === 'undo') {
      activePane.undo();
    } else if (name === 'redo') {
      activePane.redo();
    }
  });

  /** 關當前這一塊正顯示著的標籤：一份檔案（先問儲存），或一個特殊標籤（敘事線總覽）。 */
  function closeCurrentTab(): void {
    const special = activePane.activeSpecial();
    if (special) {
      activePane.closeSpecial(special);
    } else if (activePane.activePath) {
      activePane.closeFile(activePane.activePath);
    }
  }

  window.addEventListener('nf-workspace-reset', () => {
    // 不寫 localStorage：標籤頁按工程分開記（projectStorageKey），上一個工程的那份留著下次回來用，
    // 而此刻網址已經換成了新工程，這裡寫下去會把新工程那份衝成空的。
    cancelScheduledPersist();
    pendingDrafts.clear();
    pendingActive.clear();
    clearClosed();
    for (const pane of Object.values(panes)) {
      // 特殊標籤（敘事線總覽）畫的是上一個工程的東西，一併關掉（不寫 localStorage）。
      for (const id of [...pane.specials]) {
        pane.closeSpecial(id, { quiet: true });
      }
      for (const path of [...pane.files.keys()]) {
        pane.closeSilently(path);
      }
    }
    announceActive();
    syncDraftVisibility();
    // 換來的那個工程上次開著的標籤頁接著開。關掉工程時 restore 自己會跳過。
    restore();
  });

  window.addEventListener('beforeunload', (e) => {
    // 帶未儲存內容離開頁面要先問一句。兩塊都掃。
    if (Object.values(panes).some((p) => p.hasDirty())) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ---------------------------------------------------------------- 標籤搬家

  /**
   * explorer 在 rename/move 成功後廣播的搬家事件：把舊標籤連同未儲存草稿
   * 整體挪到新路徑。
   *
   * 走 `moved` 標記繞開 hash 相等檢查——改名後檔案的 hash 基線必然變化，
   * 但草稿本身沒有理由丟。
   */
  window.addEventListener('nf-files-moved', (event) => {
    const { from, to } = event.detail;
    if (!from || !to) {
      return;
    }
    const pane = paneOwning(from);
    const file = pane?.files.get(from);
    if (!pane || !file) {
      return;
    }
    // 臨時標籤改了名還是臨時的（單擊開啟、沒動過它）。
    const carry: CarriedDraft = {
      history: file.history,
      historyText: file.draft,
      preview: !!file.preview,
      markdownPreview: !!file.markdownPreview,
    };
    if (file.draft !== file.text) {
      Object.assign(carry, { hash: file.hash, draft: file.draft, moved: true });
    }
    pane.closeSilently(from);
    rekeyStorage(from, to);
    // 撤銷歷史也跟著搬：新路徑的那份檔案到了、內容對得上就接上。
    pendingDrafts.set(to, carry);
    pendingActive.set(pane.id, to);
    post({ type: 'openEditor', path: to, pane: pane.id });
  });

  // ---------------------------------------------------------------- 收訊息

  onMessage((msg) => {
    switch (msg.type) {
      case 'editorOpen': {
        // 窄屏上第二塊不顯示（只有一層覆蓋）：要並排開的細綱、草稿開在主區，成了另一個標籤。
        const target = msg.pane === 'draft' && !isNarrow() ? ensureDraftPane() : panes.main!;
        // 一個路徑同一時刻只屬於一塊編輯區。已經開在另一塊裡的，連同未儲存的
        // 內容一起搬過來，不留兩份各自漂移的副本。
        let carried: CarriedDraft | undefined;
        for (const pane of Object.values(panes)) {
          if (pane !== target) {
            const moved = pane.closeSilently(msg.file.path);
            if (moved) {
              carried = moved;
            }
          }
        }
        // 先認下當前這一塊，再收檔案：upsertFile 末尾會廣播「正在編輯哪個
        // 檔案」，那句讀的是 activePane，順序反了會報出上一塊的檔案。上一章 / 下一章時另一塊裡配對的
        // 那一份不認（不搶焦點）。
        if (!takeQuietOpen(target.id, msg.file.path)) {
          setActivePane(target);
        }
        // 臨時標籤 / 原位換掉：開啟請求上帶的標記，後端原樣帶回。
        target.upsertFile(msg.file, carried, { preview: msg.preview, replace: msg.replace });
        syncDraftVisibility();
        revealEditor();
        break;
      }

      case 'editorSaved':
        (paneOwning(msg.file.path) ?? panes.main!).applySaved(msg.file);
        break;

      case 'editorConflict':
        paneOwning(msg.path)?.applyConflict(msg.path, msg.diskText, msg.diskHash);
        break;

      // 點審稿報告上的引文（五期）：後端先推了那一份的 editorOpen，這裡選中那一句。
      case 'editorReveal': {
        const pane = paneOwning(msg.path);
        if (pane) {
          setActivePane(pane);
          if (!pane.reveal(msg.path, msg.quote)) {
            toast('這一句在編輯區裡找不到了（可能有沒儲存的修改）。', true);
          }
        }
        break;
      }

      case 'editorError':
        toast(msg.message, true);
        // 恢復時檔案可能已被刪/改名，別讓它卡在待恢復列表裡。
        pendingDrafts.delete(msg.path);
        break;
    }
  });

  // 「轉到…」（Ctrl+P）。要在上面那個 onMessage 之後裝：editorOpen 先讓編輯區收下檔案，它才找得到該把焦點放進哪一塊。
  installQuickOpen(post);
  // 全書查詢替換（Ctrl+Shift+F、「編輯 → 全書查詢替換…」）。同一個理由：點了一處要等那份檔案的 editorOpen 先進編輯區。
  installBookFind(post);
  // 「檢視」選單的「外觀」與「專注」兩組（look.ts / focus.ts）。專注要在查詢之後裝：編輯區裡的 Esc 先收查詢條，
  // 查詢條關著時才退出專注模式（document 上的 keydown 按掛的先後跑，它看 defaultPrevented）。
  installLook();
  installFocus();
  // 「幫助 → 快捷鍵一覽」與 Ctrl+/（⚑）：按分組列出 shortcuts.ts 那張表、可以篩選。
  installShortcutsPanel();
  // 「敘事線總覽」「時間線總覽」兩個特殊標籤（敘事線重做三期；2026-10-24）：要在 restore() 之前登記，重新整理時才認得出存下來的標籤。
  installThreadsOverview(post);
  installTimelineOverview(post);

  // ---------------------------------------------------------------- 啟動

  initTheme(shell);
  initResizers(shell);
  syncDraftVisibility();
  restore();
}
