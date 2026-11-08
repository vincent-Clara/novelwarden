/**
 * 專注：專注模式、全屏、打字機滾動、段落聚焦。入口是標題欄「檢視 → 專注」那一組（選單那一半在
 * `view/lookMenu.ts`），狀態經 `nf-view-query` 回答、開關經 `nf-view-command` 交過來。三個開關記在
 * `novelforge.editor.prefs`（`focusMode` / `typewriter` / `paragraphFocus`，校驗在 `lookCore.ts`），全屏不記。
 *
 * - **專注模式**（快捷鍵 F8 ⚑，`Esc` 或再按一次退出）：`<body>` 掛 `nf-focus`，`css/standalone/focus.css` 藏起
 *   活動欄、側欄、標題欄裡選單以外的雜項、標籤條、工具欄、章節條，狀態列淡成一行（滑鼠移上去才看清；字數那一格照樣
 *   點得開碼字統計面板）。
 *   **衝突條、查詢條、「版本」的對比標籤照常顯示**——前者是「不丟稿」的提醒，後兩樣是作者自己開啟的。兩塊編輯區都開著時
 *   只專注當前那一塊（`activePane`，根節點掛 `ed-focused`），另一塊藏起來；當前那一塊換了（從別處開啟了另一塊裡的
 *   檔案）就跟過去。F8 選它的理由：瀏覽器與桌面 WebView 都不佔它，編輯器裡也沒用過；Typora 的專注模式也是 F8。
 *   `Esc` 只在別人都不接時退出：查詢條、「轉到…」、對話方塊、外觀面板、碼字統計面板、標題欄與右鍵選單先收。
 * - **全屏**：Fullscreen API，**能力探測**（`document.fullscreenEnabled` 且有 `requestFullscreen`），不支援時選單項置灰。
 *   全屏的是整個頁面（選單欄還在，退出不靠記快捷鍵）。F11 是瀏覽器自己的，不搶。
 * - **打字機滾動**（`typewriter.ts`）與**段落聚焦**（`paragraphFocus.ts`）各自一個模組，這裡只管開關。
 */
import { toast } from '../globals';
import type { FocusStatus } from '../globals';
import { isImeComposing, onEditorChange } from './api';
import { FOCUS_KEYS, normalizeFocus } from './lookCore';
import type { FocusPrefs } from './lookCore';
import { onPrefsChange, setStoredPrefs, storedPrefs } from './paragraphState';
import { installParagraphFocus } from './paragraphFocus';
import { revealEditor } from './shell';
import { matchesShortcut } from './shortcuts';
import { activePane, panes } from './store';
import { installTypewriter } from './typewriter';

let prefs: FocusPrefs = { focusMode: false, typewriter: false, paragraphFocus: false };

/** 三個開關當前的值。 */
export function focusPrefs(): FocusPrefs {
  return prefs;
}

function setFocusPref(key: keyof FocusPrefs, on: boolean): void {
  if (prefs[key] !== on) {
    setStoredPrefs({ [key]: on || undefined });
  }
}

// ---------------------------------------------------------------- 全屏

/** 頁面能不能全屏：能力探測，不看是哪個瀏覽器 / 哪個殼。 */
export function fullscreenSupported(): boolean {
  return document.fullscreenEnabled === true && typeof document.documentElement.requestFullscreen === 'function';
}

function isFullscreen(): boolean {
  return !!document.fullscreenElement;
}

function toggleFullscreen(): void {
  if (!fullscreenSupported()) {
    toast('這個瀏覽器（或視窗）不支援全屏。', true);
    return;
  }
  const done = isFullscreen() ? document.exitFullscreen() : document.documentElement.requestFullscreen();
  void Promise.resolve(done).catch(() => toast('沒能切換全屏（瀏覽器拒絕了）。', true));
}

// ---------------------------------------------------------------- 專注模式

/** 當前專注的那一塊掛 `ed-focused`；不在專注模式時誰都不掛。 */
function syncFocusedPane(): void {
  const on = prefs.focusMode;
  for (const pane of Object.values(panes)) {
    pane.root.classList.toggle('ed-focused', on && pane === activePane);
  }
}

function applyFocusMode(): void {
  document.body.classList.toggle('nf-focus', prefs.focusMode);
  syncFocusedPane();
  if (prefs.focusMode) {
    // 窄屏下編輯區是覆蓋層，得翻上來。
    revealEditor();
  }
}

function toggleFocusMode(): void {
  setFocusPref('focusMode', !prefs.focusMode);
}

/**
 * 剛進專注模式：焦點原本在被藏起來的地方（左邊的對話輸入框之類）時放進正文——不然游標落在一個看不見的框裡，
 * 打的字不知道去了哪兒。焦點本來就在這一塊裡（編輯區、查詢框）的不動。
 */
function keepFocusInside(): void {
  const pane = activePane;
  if (!pane?.activeFile() || pane.isPreviewing() || pane.root.contains(document.activeElement)) {
    return;
  }
  pane.area.focus();
}

function status(): FocusStatus {
  return {
    focusMode: prefs.focusMode,
    typewriter: prefs.typewriter,
    paragraphFocus: prefs.paragraphFocus,
    fullscreen: isFullscreen(),
    fullscreenSupported: fullscreenSupported(),
  };
}

export function installFocus(): void {
  prefs = normalizeFocus(storedPrefs());
  // 打字機滾動、段落聚焦各自訂閱編輯區的變化，問這裡開著沒有；開關變了叫它們 `refresh` 一下。
  const typewriter = installTypewriter(() => prefs.typewriter);
  const paragraph = installParagraphFocus(() => prefs.paragraphFocus);
  applyFocusMode();
  typewriter.refresh();
  paragraph.refresh();

  onPrefsChange(() => {
    const next = normalizeFocus(storedPrefs());
    const changed = FOCUS_KEYS.filter((k) => next[k] !== prefs[k]);
    if (changed.length === 0) {
      return;
    }
    prefs = next;
    if (changed.includes('focusMode')) {
      applyFocusMode();
      if (prefs.focusMode) {
        keepFocusInside();
      }
    }
    if (changed.includes('typewriter')) {
      typewriter.refresh();
    }
    if (changed.includes('paragraphFocus')) {
      paragraph.refresh();
    }
  });

  // 當前那一塊換了（從別處開啟了另一塊裡的檔案）：專注跟過去。
  onEditorChange((ev) => {
    if (ev.type === 'render' && prefs.focusMode) {
      syncFocusedPane();
    }
  });

  // 這一下 Esc 按下去的時候有沒有選單開著（標題欄的下拉、右鍵選單）：它們在 document 的冒泡階段收自己，
  // 比這裡先跑、也不 preventDefault，等輪到這裡選單已經沒了——所以在捕獲階段先記一筆。
  let menuWasOpen = false;
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') {
        menuWasOpen = !!document.querySelector('.wb-menu-drop, .ctx-menu');
      }
    },
    true
  );

  document.addEventListener('keydown', (e) => {
    if (isImeComposing(e)) {
      return;
    }
    // 專注模式的鍵（⚑ F8）登記在 shortcuts.ts。
    if (matchesShortcut(e, 'focusMode')) {
      e.preventDefault();
      toggleFocusMode();
      return;
    }
    // Esc 退出專注模式。別人已經接走的 Esc（查詢條收起、「轉到…」關掉、對話方塊取消、收選單）不算——那些先退；
    // 外觀面板、碼字統計面板在捕獲階段就吞掉了它，根本到不了這裡。
    if (
      e.key === 'Escape' &&
      prefs.focusMode &&
      !e.defaultPrevented &&
      !menuWasOpen &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !document.querySelector('.modal-overlay:not(.hidden)')
    ) {
      e.preventDefault();
      setFocusPref('focusMode', false);
    }
  });

  window.addEventListener('nf-view-query', (e) => {
    e.detail.focus = status();
  });

  window.addEventListener('nf-view-command', (e) => {
    switch (e.detail.name) {
      case 'toggleFocusMode':
        toggleFocusMode();
        break;
      case 'toggleFullscreen':
        toggleFullscreen();
        break;
      case 'toggleTypewriter':
        setFocusPref('typewriter', !prefs.typewriter);
        break;
      case 'toggleParagraphFocus':
        setFocusPref('paragraphFocus', !prefs.paragraphFocus);
        break;
    }
  });
}
