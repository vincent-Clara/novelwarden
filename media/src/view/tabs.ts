/**
 * 頁籤切換。
 *
 * 外掛形態是頂部一排文字頁籤，獨立版是左側豎排圖示活動欄——同一份 DOM，
 * 由 standalone.css 重排（見 media/README.md 的「兩形態隔離」）。
 */
import { closestFrom } from '../dom';
import type { Tab } from '../protocol';
import { avoidSoftKeyboard } from '../touch';
import { clearUnseenErrors } from './logs';
import { el } from './refs';
import { vscode } from './store';

export function showTab(tab: string): void {
  for (const btn of el.tabbar.querySelectorAll<HTMLElement>('.tab')) {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  }
  for (const pane of document.querySelectorAll('.pane')) {
    pane.classList.toggle('active', pane.id === `pane-${tab}`);
  }
  // 手機上不順手聚焦（一聚焦就彈軟鍵盤蓋住半屏，見 touch.ts 的 avoidSoftKeyboard）。
  if (tab === 'chat' && !avoidSoftKeyboard()) {
    el.input.focus();
  }
  if (tab === 'logs') {
    // 看過了就把紅點收掉。
    clearUnseenErrors();
  }
}

/**
 * 作者要看側欄的某一頁（點頁籤、「更多」裡挑一頁、編輯器裡「在檔案頁中定位」「歷史」）：切過去並告訴後端。
 * 窄屏上編輯區是蓋在側欄上的一層，先把它收下去（寬屏上這個類不起作用）。
 * 後端推來的 `tab` 不走這裡：斷線重連時它會把當前頁籤再推一遍，不該把作者正看著的編輯區收掉。
 */
export function revealTab(tab: Tab): void {
  document.body.classList.remove('editor-open');
  if (!isTabActive(tab)) {
    showTab(tab);
    vscode.postMessage({ type: 'switchTab', tab });
  }
}

/** 某個頁籤當前是不是啟用的。日誌紅點靠它判斷「使用者看沒看見」。 */
export function isTabActive(tab: string): boolean {
  return !!document.getElementById(`pane-${tab}`)?.classList.contains('active');
}

export function installTabs(): void {
  // 編輯器裡「在檔案頁中定位」、點麵包屑的目錄段：切到「檔案」頁（展開、高亮那一行是資源管理器自己的事）。
  // 外掛裡沒有這一頁，什麼都不做。
  window.addEventListener('nf-reveal-in-files', () => {
    if (document.getElementById('pane-files')) {
      revealTab('files');
    }
  });

  // 編輯器工具欄「歷史」、「檔案 → 歷史版本…」：切到「版本」頁（內容是 editor.js 畫的）。外掛裡沒有這一頁。
  window.addEventListener('nf-show-versions', () => {
    if (document.getElementById('pane-versions')) {
      revealTab('versions');
    }
  });

  // 窄屏底欄的「正文」「更多」沒有 data-tab，歸 mobileNav.ts。
  el.tabbar.addEventListener('click', (e) => {
    const btn = closestFrom<HTMLElement>(e.target, '.tab');
    if (!btn?.dataset.tab) {
      return;
    }
    document.body.classList.remove('editor-open');
    showTab(btn.dataset.tab);
    vscode.postMessage({ type: 'switchTab', tab: btn.dataset.tab as Tab });
  });
}
