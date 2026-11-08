/**
 * 窄屏（`../narrow.ts`）的導航：底欄的兩顆導航鍵與返回鍵。
 *
 * ## 底欄
 *
 * 活動欄在窄屏上是底欄，只露「對話 · 工程 · 正文 · 版本 · 更多」五顆（樣式在 narrow.css）：
 * - 「正文」：把編輯區那層翻上來（`body.editor-open`）。編輯區開著時它亮、側欄那一頁的頁籤不亮（樣式按這個類認）。
 * - 「更多」：彈一個選單列檔案 / 歷史 / 日誌 / 設定；正開著這幾頁之一時它亮，日誌有沒看過的錯誤時它也帶紅點。
 * 這兩顆沒有 `data-tab`（`data-nav`），頁籤切換（`tabs.ts`）不認它們，寬屏上不顯示。
 * 軟鍵盤彈著、正在打字時底欄讓出來（body 掛 `kb-open`）：鍵盤上面本來就只剩半屏。
 *
 * ## 返回鍵
 *
 * 手機上按返回，先一層層收：最上面的選單 / 彈窗 / 浮窗 → 編輯區那層 → 都收完了才離開頁面（瀏覽器）或彈殼的選單（Android）。
 * - 瀏覽器：開著幾層就在歷史裡壓幾條（`history.state.nfLayer` 記第幾層），按返回退一條、頁面收一層；
 *   不是按返回收掉的（點了外面、點了底欄）就自己退掉多出來的那幾條。只在窄屏上壓。
 *   Chromium 會跳過頁面在作者碰它之前壓的條目（返回鍵一下就離開了頁面），所以作者沒碰過頁面時不壓，碰過之後補上。
 * - Android 殼：返回鍵不經網頁歷史，殼先問 `window.nfBack()`——收掉了一層返回 true，沒什麼可收的返回 false、殼再彈自己的選單。
 */
import { closestFrom } from '../dom';
import type { MenuItem } from '../globals';
import type { Tab } from '../protocol';
import { narrowScreen as narrow } from '../narrow';
import { el } from './refs';
import { isTabActive, revealTab } from './tabs';

/** 「更多」裡的幾頁（窄屏底欄上不單獨露）。 */
const MORE_TABS: { tab: Tab; label: string }[] = [
  { tab: 'files', label: '檔案' },
  { tab: 'history', label: '歷史' },
  { tab: 'logs', label: '日誌' },
  { tab: 'settings', label: '設定' },
];

/**
 * 按返回能收的那幾樣，都是掛在 body 上或頁面裡常駐、靠 `.hidden` / `.open` 開關的。收的辦法是在它上面按一下 Esc
 * （各自都認 Esc，多半掛在 document 上），不認的再點一下外面。
 * - `LAYERS`：作者點開的彈窗、選單、面板——開著就在歷史裡算一層。
 * - `TIPS`：浮窗與補全框——一碰就出、一動就收（窄視窗的桌面上滑鼠劃過名字就出一個），不另壓歷史；按返回時開著就順手收掉。
 */
const LAYERS = [
  '.modal-overlay',
  '.ctx-menu',
  '.wb-menu-drop',
  '.msg-menu',
  '.qo-panel',
  '.ed-look-overlay',
  '.ed-check-panel',
  '.ed-stats-panel',
  '.nf-picker.open',
  '.nf-about.open',
].join(', ');

const TIPS = ['.summary-tip', '.failure-tip', '.detail-tip', '.workbench-tip', '.nm-tip', '.tov-tip', '.nc-box'].join(', ');

const ANY = `${LAYERS}, ${TIPS}`;

function editorOpen(): boolean {
  return document.body.classList.contains('editor-open');
}

/** 最上面那一層（DOM 裡靠後的蓋在靠前的上面）。藏著的不算。 */
function topOverlay(selector: string): HTMLElement | null {
  const shown = [...document.querySelectorAll<HTMLElement>(selector)].filter((n) => !n.closest('.hidden, [hidden]'));
  return shown[shown.length - 1] ?? null;
}

function isShown(node: HTMLElement): boolean {
  return node.isConnected && node.matches(ANY) && !node.closest('.hidden, [hidden]');
}

/** 收掉最上面一層；沒什麼可收的返回 false。 */
function closeTopLayer(): boolean {
  const overlay = topOverlay(ANY);
  if (overlay) {
    // 焦點在它裡面（彈窗裡的輸入框）就從焦點那兒按：有的只在自己的輸入框上認 Esc。不在就按在它身上，冒泡到 document。
    const focused = document.activeElement;
    const at = focused instanceof HTMLElement && overlay.contains(focused) ? focused : overlay;
    at.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    if (isShown(overlay)) {
      // 浮窗之類不認 Esc 的：點一下外面就收。
      document.body.click();
    }
    return true;
  }
  if (narrow() && editorOpen()) {
    document.body.classList.remove('editor-open');
    return true;
  }
  return false;
}

/** 這一刻該在歷史裡壓著幾層。寬屏上一層都不壓（編輯區常駐，返回鍵照瀏覽器原來的意思）。 */
function wantedDepth(): number {
  if (!narrow()) {
    return 0;
  }
  return (editorOpen() ? 1 : 0) + (topOverlay(LAYERS) ? 1 : 0);
}

function currentDepth(): number {
  const state = history.state as { nfLayer?: unknown } | null;
  return typeof state?.nfLayer === 'number' ? state.nfLayer : 0;
}

/** 作者碰過頁面沒有。沒有這個介面的環境當碰過。 */
function userActivated(): boolean {
  const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
  return activation ? activation.hasBeenActive : true;
}

/** 自己退掉多出來的條目時，那一下 popstate 不是作者按的返回。 */
let traversing = false;

/** 讓歷史裡壓著的層數跟上頁面上開著的層數。 */
function reconcile(): void {
  if (traversing) {
    return;
  }
  const have = currentDepth();
  const want = wantedDepth();
  if (want > have) {
    if (!userActivated()) {
      return;
    }
    for (let depth = have + 1; depth <= want; depth++) {
      history.pushState({ nfLayer: depth }, '');
    }
  } else if (want < have) {
    traversing = true;
    history.go(want - have);
  }
}

let scheduled = false;

/** 開關一層的那一下（點選、按鍵、後端推來的開啟檔案）跑完之後再對一次賬。 */
function schedule(): void {
  if (scheduled) {
    return;
  }
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    reconcile();
  }, 0);
}

function onPopState(): void {
  if (traversing) {
    traversing = false;
    reconcile();
    return;
  }
  // 作者按了返回：退到第幾層，就把那一層以上開著的都收掉（一次多半隻收一層；蓋在最上面的浮窗先收，不算一層）。
  const have = currentDepth();
  for (let guard = 0; guard < 6 && wantedDepth() > have; guard++) {
    if (!closeTopLayer()) {
      break;
    }
  }
  reconcile();
}

/** 能打字的框（焦點在它上面，手機上就彈軟鍵盤）。 */
const TYPING = 'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="number"], input[type="password"], input[type="url"], [contenteditable="true"]';

/** 同一個寬度下見過的最高的可視高度：當它是「沒有鍵盤」。轉屏（寬度變了）重新量。 */
let tallest = 0;
let measuredWidth = 0;

/**
 * 軟鍵盤彈著沒有。頁面宣告瞭 `interactive-widget=resizes-content`（Android 殼是 adjustResize），鍵盤一彈整頁變矮：
 * 比沒鍵盤時矮了 150px 以上、焦點又在能打字的框裡，就算彈著（位址列伸縮只差幾十畫素）。按返回收了鍵盤、焦點還在框裡，
 * 高度回來了就不算——底欄跟著回來。
 */
function trackKeyboard(): void {
  if (window.innerWidth !== measuredWidth) {
    measuredWidth = window.innerWidth;
    tallest = 0;
  }
  tallest = Math.max(tallest, window.innerHeight);
  const typing = !!document.activeElement?.matches(TYPING);
  document.body.classList.toggle('kb-open', narrow() && typing && window.innerHeight < tallest - 150);
}

function showMoreMenu(btn: HTMLElement): void {
  const logsDot = document.getElementById('logsErrorDot');
  const unseenErrors = !!logsDot && !logsDot.classList.contains('hidden');
  const items: MenuItem[] = MORE_TABS.filter(({ tab }) => document.getElementById(`pane-${tab}`)).map(({ tab, label }) => ({
    label: `${isTabActive(tab) && !editorOpen() ? '✓ ' : ''}${label}${tab === 'logs' && unseenErrors ? '（有新的錯誤）' : ''}`,
    run: () => revealTab(tab),
  }));
  const rect = btn.getBoundingClientRect();
  // 貼著按鈕上沿往上彈（下面沒地方，menuPlace 會翻上去）。
  window.__nfShowMenu?.(items, rect.right, rect.top);
}

export function installMobileNav(): void {
  // 只有獨立版有窄屏底欄與編輯區那層；外掛的 webview 不碰瀏覽器歷史。
  if (!document.getElementById('wbMenubar')) {
    return;
  }
  el.tabbar.addEventListener('click', (e) => {
    const btn = closestFrom<HTMLElement>(e.target, '.tab');
    const nav = btn?.dataset.nav;
    if (!btn || !nav) {
      return;
    }
    if (nav === 'editor') {
      document.body.classList.add('editor-open');
    } else if (nav === 'more') {
      // 選單掛在 body 上、document 的 click 會收掉它：這一下別冒上去。
      e.stopPropagation();
      showMoreMenu(btn);
    }
  });

  (window as Window & { nfBack?: () => boolean }).nfBack = () => {
    const closed = closeTopLayer();
    schedule();
    return closed;
  };

  window.addEventListener('popstate', onPopState);
  trackKeyboard();
  window.addEventListener('resize', () => {
    trackKeyboard();
    // 轉屏、拖窄視窗：過了窄屏的界，壓著的層數跟著變。
    schedule();
  });
  document.addEventListener('focusin', trackKeyboard);
  document.addEventListener('focusout', () => setTimeout(trackKeyboard, 0));
  // 開關一層的入口太多（點選、長按、快捷鍵、後端推來的開啟檔案），不一個個掛：作者點過之後、body 的類與直屬子節點變了之後
  // 都對一次賬（掛在 body 上的選單與面板、編輯區那層都在後兩樣裡；頁面裡常駐的彈窗靠點選那一下兜著）。打字不對賬。
  for (const type of ['click', 'contextmenu'] as const) {
    document.addEventListener(type, schedule, true);
  }
  new MutationObserver(schedule).observe(document.body, { attributes: true, attributeFilter: ['class'], childList: true });
}
