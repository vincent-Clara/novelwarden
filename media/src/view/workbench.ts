/**
 * 「當前產物」浮窗：**當前這一層的產物本身**。
 *
 * 這是設計文件 §11 裡那塊「當前工作區」。創作頁只有一條進度條和一堆對話氣泡時，
 * 作者看不見自己正在改的細綱寫了什麼，只能去開檔案。於是流水線在介面上
 * 只剩幾個百分比，像個進度報表，而不是一個工作臺。
 *
 * ## 為什麼從「釘在訊息流頂部」改成懸停浮窗
 *
 * 它原來是訊息流裡的一張 `position: sticky` 卡片：滾不出視野，代價是**永遠佔著
 * 訊息流最上面那一塊**，而且既關不掉也藏不起來——只能摺疊成一條標題欄，那條
 * 標題欄還在。側邊欄本來就只有三百來畫素寬，一份八小節的細綱能吃掉半屏對話。
 *
 * 現在它與工程頁那三隻浮窗（`project/summaryTip` `detailTip` `errorTip`）同一套
 * 路子：平時只在流水線條上留一個一行高的入口，滑鼠停上去（或點一下釘住）才浮
 * 出來，掛在 body 上 `position: fixed`，移開就收。**不佔版面，隨時夠得著。**
 *
 * 與那三隻共用 [tip.ts](tip.ts) 的定位，取捨也一致：內容是多行、要能滾動與選中
 * 複製（細綱裡的要點常要抄進對話），所以滑鼠必須進得來，收起要留寬限期——
 * 從入口挪到浮窗要跨過一道縫，那一兩幀滑鼠既不在入口上也不在浮窗上。
 *
 * 有一處與那三隻**不同**：它們的目標是工程頁裡會滾動的行，頁面一滾就得收；
 * 這個入口長在流水線條上，那一條不滾（`.pipeline` 是 `flex: 0 0 auto`），
 * 訊息流滾動時它一動不動，所以**不監聽 scroll**——照抄那條會讓「滾上去看前一
 * 輪對話，同時對著這一章的細綱」變得不可能，而那正是釘住要解決的情形。
 *
 * 內容全部由後端生成（[core/views/workbench.ts](../../../src/core/views/workbench.ts)），
 * 這裡只負責畫。正文層刻意只有細綱各節與字數，沒有全文：三千字塞進一隻浮窗
 * 既讀不下去，又把「這一層齊沒齊」這個真正要看的資訊埋掉了。
 */
import { el as mk, closestFrom, setHidden } from '../dom';
import type { WorkbenchView } from '../protocol';
import { el } from './refs';
import { openPath } from './store';
import { placeTip } from './tip';
import { lastPointerWasTouch } from '../touch';

/** 與另外三隻浮窗同一檔延遲：夠快，又不至於劃過時閃。 */
const HOVER_DELAY_MS = 300;
/** 收起的寬限期：夠滑鼠從入口跨到浮窗，又不至於讓它賴著不走。 */
const CLOSE_DELAY_MS = 200;

let current: WorkbenchView | null = null;

let tip: HTMLElement | null = null;
let hoverTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * 釘住：點一下入口就一直開著，直到再點一次 / Esc / 點別處。
 *
 * 懸停版夠用於「瞥一眼這一章要寫什麼」，但照著細綱往輸入框裡寫要求時滑鼠要回
 * 輸入框——那一刻浮窗必須留得住。所以點選是釘住，不是又一個懸停。
 */
let pinned = false;

/** 收到新的 `pipeline` 推送時呼叫。 */
export function renderWorkbench(view: WorkbenchView | null): void {
  current = view;
  redrawEntry();
  if (!current) {
    hideWorkbenchTip();
    return;
  }
  // 開著的浮窗就地換掉內容（不重建節點，免得閃）：切目標、採納產物都會重推。
  if (tip) {
    fill(tip, current);
    placeTip(el.workbench, tip);
  }
}

/**
 * 流水線條上那個入口：一行「當前產物 · 正文」，佔一行不到。
 *
 * 只寫這一層叫什麼（`layer`），不寫章名——章名在上面那行麵包屑上，從前入口上再寫一遍「正文 · 第 4 章《空匣》」，
 * 同一句話說兩次。前面也不再掛 ▤：獨立版標題欄「顯示 / 隱藏編輯器」是同一個圖示。完整標題在浮窗頭上。
 */
function redrawEntry(): void {
  const box = el.workbench;
  box.innerHTML = '';
  setHidden(box, !current);
  if (!current) {
    return;
  }

  box.appendChild(mk('span', 'wbt-entry-title', `當前產物 · ${current.layer}`));
  // 上游變過 / 這一層還是空的：入口上就得看得見，否則使用者沒有理由把它開啟。
  // 寫前提醒（完善設定三期）只是提個醒：換一個淡色的記號，不跟 ⟳ 搶。
  if (current.warning) {
    box.appendChild(mk('span', 'wbt-entry-mark', '⟳'));
  } else if (current.empty) {
    box.appendChild(mk('span', 'wbt-entry-mark is-empty', '○'));
  } else if (current.notice) {
    box.appendChild(mk('span', 'wbt-entry-mark is-notice', '◌'));
  }
  box.title = `${current.title}——懸停檢視這一層的產物，點選釘住`;
}

// ---------------------------------------------------------------- 浮窗

function scheduleShow(): void {
  if (tip || hoverTimer) {
    return;
  }
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    showWorkbenchTip();
  }, HOVER_DELAY_MS);
}

/** 滑鼠離開入口或浮窗：給一點寬限再收，好讓滑鼠能挪到浮窗上去。 */
function scheduleHide(): void {
  if (pinned) {
    return;
  }
  if (closeTimer) {
    clearTimeout(closeTimer);
  }
  closeTimer = setTimeout(() => {
    closeTimer = null;
    hideWorkbenchTip();
  }, CLOSE_DELAY_MS);
}

/** 滑鼠回到入口上或進了浮窗：撤銷待執行的收起。 */
function cancelScheduledHide(): void {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}

/** 立刻收起。Esc / 點別處 / 右鍵用這個，不給寬限。 */
export function hideWorkbenchTip(): void {
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  cancelScheduledHide();
  pinned = false;
  if (tip) {
    tip.remove();
    tip = null;
  }
  el.workbench.classList.remove('open');
}

function showWorkbenchTip(): void {
  if (!current || tip) {
    return;
  }
  const box = mk('div', 'workbench-tip');
  fill(box, current);
  // 滑鼠進了浮窗就別收——使用者正在讀，或者要滾動、選中複製。
  box.addEventListener('mouseenter', cancelScheduledHide);
  box.addEventListener('mouseleave', scheduleHide);
  document.body.appendChild(box);
  tip = box;
  el.workbench.classList.add('open');
  placeTip(el.workbench, box);
}

function fill(box: HTMLElement, view: WorkbenchView): void {
  box.innerHTML = '';
  box.appendChild(buildHead(view));

  if (view.warning) {
    // 上游變更在這裡是一句人話，不只是流水線條上那個 ⟳。作者正盯著這份
    // 產物看，此刻正是告訴他「它依據的東西已經改了」最有用的時機。
    box.appendChild(mk('div', 'wbt-warning', `⟳ ${view.warning}`));
  }
  if (view.notice) {
    // 寫前提醒（完善設定三期）：不是出了問題，零呼叫、不攔——淡色一句，與 ⟳ 分開。
    box.appendChild(mk('div', 'wbt-notice', `◌ ${view.notice}`));
  }
  if (view.empty) {
    box.appendChild(mk('div', 'wbt-empty', view.empty));
    return;
  }
  for (const section of view.sections) {
    const row = mk('div', 'wbt-row');
    row.appendChild(mk('span', 'wbt-key', section.key));
    row.appendChild(mk('span', 'wbt-text', section.text));
    box.appendChild(row);
  }
}

function buildHead(view: WorkbenchView): HTMLElement {
  const head = mk('div', 'wbt-head');
  head.appendChild(mk('span', 'wbt-title', view.title));
  head.appendChild(mk('span', 'spacer'));

  // 浮窗只攤要點（正文層甚至只攤統計）。要看全的、要改的，走「開啟」。
  if (view.relPath) {
    const open = mk('button', 'link wbt-open', '開啟');
    open.title = view.relPath;
    open.addEventListener('click', () => {
      openPath(view.relPath);
      hideWorkbenchTip();
    });
    head.appendChild(open);
  }

  const close = mk('button', 'icon-btn wbt-close', '×');
  close.title = '關閉（Esc）';
  close.addEventListener('click', hideWorkbenchTip);
  head.appendChild(close);
  return head;
}

export function installWorkbench(): void {
  // 手指點一下之後補發的相容滑鼠事件不是懸停（`touch.ts`）：觸屏上只認點，點一下就是釘住。
  el.workbench.addEventListener('mouseenter', () => {
    if (lastPointerWasTouch()) {
      return;
    }
    cancelScheduledHide();
    scheduleShow();
  });
  el.workbench.addEventListener('mouseleave', () => {
    if (!lastPointerWasTouch()) {
      scheduleHide();
    }
  });

  // 點一下釘住：照著細綱往輸入框裡寫要求時滑鼠要回輸入框，那一刻浮窗得留得住。
  // 再點一次收起——同一個入口，同一個鍵。
  el.workbench.addEventListener('click', (e) => {
    // 不讓這一下冒到 document 上被下面那條「點別處就收」當場撤銷。
    e.stopPropagation();
    if (tip && pinned) {
      hideWorkbenchTip();
      return;
    }
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    cancelScheduledHide();
    showWorkbenchTip();
    pinned = true;
  });

  // 釘住之後點別處就該收。浮窗裡點自己不算——裡面有「開啟」按鈕，還要能選字。
  document.addEventListener('click', (e) => {
    if (tip && pinned && !closestFrom(e.target, '.workbench-tip')) {
      hideWorkbenchTip();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideWorkbenchTip();
    }
  });

  // 右鍵選單也是 fixed 的，兩個疊在一起誰都讀不清。
  document.addEventListener('contextmenu', hideWorkbenchTip);
}
