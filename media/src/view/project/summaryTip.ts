/**
 * 章節細綱的懸停浮窗。
 *
 * 細綱此前只能右鍵「開啟細綱」開一個編輯器標籤頁——想快速回憶「第 37 章講了什麼」
 * 代價太大。懸停浮窗把這件事變成不打斷寫作的一瞥。定稿過的細綱就是那一章寫成的樣子，
 * 沒定稿的是計劃，浮窗頭上標出來。
 *
 * 四條設計取捨：
 * - **細綱正文不進 `ProjectTree`**：那棵樹每次檔案變動都全量重推，兩百章
 *   每章上千字等於每儲存一次就推幾百 KB。改成懸停時按路徑單章去取。
 * - **前端快取、收到新樹即作廢**：同一章反覆掃過去只請求一次；正文或細綱一改
 *   （後端會重推樹）快取整體清掉，不會拿舊細綱糊弄人。
 * - **半秒延遲**：滑鼠從工具欄劃到某一行的路上會掃過好幾行，立刻彈會閃。
 * - **浮窗可以進得去**：細綱有七個小節、可能上千字，一瞥看不完。滑鼠移上去
 *   浮窗就一直留著（可滾動、可選中複製），移開才收。為此收起要延遲一點——
 *   從行挪到浮窗中間要跨過一道縫，那一兩幀滑鼠既不在行上也不在浮窗上，
 *   立刻收會讓浮窗永遠夠不著。
 *
 * 定位（掛 body、`position: fixed`、夾進視口）在 [../tip.ts](../tip.ts)，
 * 四隻浮窗共用一份。
 *
 * **觸屏**（手指沒有懸停）：手指點一下之後補發的那串相容滑鼠事件不當懸停（`touch.ts`）；入口是長按章節行彈的選單最前面
 * 那一項「細綱速覽」（`menu.ts` 的 `onTouchPeek`），彈出來的浮窗是釘住的——按在浮窗外面才收（`tip.ts` 的
 * `closeOnOutsidePress`）。點章節名照舊是開啟這一章，不改。
 */
import { el as mk, closestFrom } from '../../dom';
import type { MenuContext, MenuItem } from '../../globals';
import type { PlotSummaryView } from '../../protocol';
import { lastPointerWasTouch } from '../../touch';
import { onTouchPeek } from '../menu';
import { el } from '../refs';
import { vscode } from '../store';
import { closeOnOutsidePress, placeTip } from '../tip';

const HOVER_DELAY_MS = 450;
/** 收起的寬限期：夠滑鼠從行跨到浮窗，又不至於讓它賴著不走。 */
const CLOSE_DELAY_MS = 200;

/** 章節路徑 -> PlotSummaryView。收到新的樹時整體作廢。 */
const summaryCache = new Map<string, PlotSummaryView>();
/** 已經發出請求、還沒等到迴音的路徑，避免同一章連發好幾次。 */
const summaryPending = new Set<string>();

let hoverTimer: ReturnType<typeof setTimeout> | null = null;
/** 收起的寬限計時。與 hoverTimer 是兩件事，別合併。 */
let closeTimer: ReturnType<typeof setTimeout> | null = null;
/** 當前浮窗。`unpin` 有值說明是釘住的（觸屏的入口），收起時撤掉「按在外面就收」的監聽。 */
let hoverTip: { relPath: string; box: HTMLElement; unpin?: () => void } | null = null;
/** 正在等延遲的那一行（延遲到點時用它定位）。 */
let hoverRow: HTMLElement | null = null;

/** 收到 `project` 訊息時呼叫：那說明磁碟變過，快取一律作廢。 */
export function invalidateSummaries(): void {
  summaryCache.clear();
  summaryPending.clear();
}

/** 立刻收起。滾動 / Esc / 右鍵 / 重渲染用這個，不給寬限。 */
export function hideSummaryTip(): void {
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  cancelScheduledHide();
  hoverRow = null;
  if (hoverTip) {
    hoverTip.unpin?.();
    hoverTip.box.remove();
    hoverTip = null;
  }
}

/** 滑鼠離開行或浮窗：給一點寬限再收，好讓滑鼠能挪到浮窗上去。 */
function scheduleHide(): void {
  if (closeTimer) {
    clearTimeout(closeTimer);
  }
  closeTimer = setTimeout(() => {
    closeTimer = null;
    hideSummaryTip();
  }, CLOSE_DELAY_MS);
}

/** 滑鼠回到行上或進了浮窗：撤銷待執行的收起。 */
function cancelScheduledHide(): void {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}

/** 懸停在某一行上：延遲後彈浮窗，資料沒有就先要一份。 */
function scheduleSummaryTip(row: HTMLElement): void {
  const relPath = row.dataset.plot;
  if (!relPath) {
    return;
  }
  // mouseover 在行內子元素之間移動時也會冒泡上來。已經為這一行開著浮窗、
  // 或已經在為它計時了，就什麼都別做——否則游標在行上微動一下就重置延遲，
  // 浮窗永遠彈不出來。
  if (hoverTip?.relPath === relPath || hoverRow === row) {
    return;
  }
  hideSummaryTip();
  hoverRow = row;
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    // 延遲期間行可能被重渲染丟棄，那就不彈了。
    if (!hoverRow?.isConnected) {
      return;
    }
    showSummaryTip(hoverRow, relPath);
    requestIfMissing(relPath);
  }, HOVER_DELAY_MS);
}

function requestIfMissing(relPath: string): void {
  if (!summaryCache.has(relPath) && !summaryPending.has(relPath)) {
    summaryPending.add(relPath);
    vscode.postMessage({ type: 'requestSummary', plotRelPath: relPath });
  }
}

/**
 * 觸屏的入口：長按章節行，選單最前面一項「細綱速覽」。點了把這一章的細綱釘在行旁邊，按在浮窗外面才收。
 * 按在別的地方（故事架構那幾行也帶 `.row-plot`，但沒有 `data-plot`）不給。
 */
function peekItems(at: MenuContext): MenuItem[] {
  const row = at.target?.closest<HTMLElement>('.row-plot[data-plot]');
  const relPath = row?.dataset.plot;
  if (!row || !relPath || !el.projectBody.contains(row)) {
    return [];
  }
  return [{ label: '細綱速覽', run: () => pinSummaryTip(row, relPath) }];
}

/** 釘住一隻細綱浮窗（觸屏）。 */
export function pinSummaryTip(row: HTMLElement, relPath: string): void {
  hideSummaryTip();
  if (!row.isConnected) {
    return;
  }
  showSummaryTip(row, relPath);
  if (hoverTip) {
    hoverTip.unpin = closeOnOutsidePress(hoverTip.box, hideSummaryTip);
  }
  requestIfMissing(relPath);
}

/** 建出浮窗並貼在行的下方/上方。資料還沒到就先顯示「讀取中」。 */
function showSummaryTip(row: HTMLElement, relPath: string): void {
  const box = mk('div', 'summary-tip');
  box.appendChild(buildBody(summaryCache.get(relPath)));
  // 滑鼠進了浮窗就別收——使用者正在讀，或者要滾動、選中複製。
  // 監聽掛在 box 上，box 每次都是新建的，收起時隨元素一起回收。
  box.addEventListener('mouseenter', cancelScheduledHide);
  box.addEventListener('mouseleave', () => {
    // 釘住的（觸屏）不跟滑鼠走：手指點進浮窗之後補發的相容滑鼠事件也會走到這兒。
    if (!hoverTip?.unpin) {
      scheduleHide();
    }
  });
  document.body.appendChild(box);
  hoverTip = { relPath, box };
  placeTip(row, box);
}

/** 浮窗內容。`view` 為 undefined 表示還在等後端。 */
function buildBody(view?: PlotSummaryView): DocumentFragment {
  const frag = document.createDocumentFragment();

  if (!view) {
    frag.appendChild(mk('div', 'hint', '讀取細綱…'));
    return frag;
  }

  const head = mk('div', 'summary-tip-head');
  // 說法由後端給（`chapterLabel`：「第 12 章《夜訪》」），前端不按 `no` 自己拼——
  // 標題取正文還是細綱那一側、沒有標題時怎麼說，只在後端定一次。
  head.appendChild(mk('span', 'summary-tip-title', view.label));
  // 計劃與過期都必須說出來：照著一份寫之前的計劃、或寫於三次修改之前的定稿做判斷，比沒有更糟。
  if (view.exists && !view.finalized) {
    head.appendChild(mk('span', 'summary-tip-stale', '計劃'));
  } else if (view.exists && view.stale) {
    head.appendChild(mk('span', 'summary-tip-stale', '已過期'));
  }
  frag.appendChild(head);

  if (!view.exists) {
    // 原因分兩種，後端給的那句話已經分好了：有正文的章可以右鍵定稿照正文整理一份，
    // 什麼都沒有的章就只說沒有。
    frag.appendChild(mk('div', 'hint', view.emptyHint ?? '還沒有細綱。'));
    return frag;
  }

  for (const section of view.sections) {
    frag.appendChild(mk('div', 'summary-tip-section', section.name));
    // textContent 而非 innerHTML：細綱是模型寫的，裡面可能有任何字元。
    frag.appendChild(mk('div', 'summary-tip-text', section.text));
  }
  if (view.sections.length === 0) {
    frag.appendChild(mk('div', 'hint', '細綱檔案是空的。'));
  }
  return frag;
}

/**
 * 細綱到了：填進快取，正開著的浮窗就地換掉內容（不重建，免得閃）。
 *
 * 細綱檔案的路徑與行的路徑常常不同（一個在 summaries/，一個在 chapters/），
 * 所以按**當前開著的那一章**回填——同一時刻只可能有一個浮窗。
 */
export function applySummary(view: PlotSummaryView): void {
  const relPath = hoverTip?.relPath;
  if (!relPath) {
    return;
  }
  summaryPending.delete(relPath);
  summaryCache.set(relPath, view);
  hoverTip!.box.innerHTML = '';
  hoverTip!.box.appendChild(buildBody(view));
  // 內容換了尺寸也變了，重新定位一次。
  const row = el.projectBody.querySelector<HTMLElement>(`.row-plot[data-plot="${cssEscape(relPath)}"]`);
  if (row) {
    placeTip(row, hoverTip!.box);
  }
}

/** 屬性選擇器裡的路徑要轉義（含 `/`、可能含引號）。 */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

export function installSummaryTip(): void {
  // 事件委託掛在 projectBody 上：樹每次重渲染都換掉全部行，
  // 逐行 addEventListener 會隨重渲染次數堆積。
  onTouchPeek(peekItems);

  el.projectBody.addEventListener('mouseover', (e) => {
    // 手指點一下之後補發的相容滑鼠事件不是懸停（`touch.ts`）；釘住的浮窗也不跟滑鼠走。
    if (lastPointerWasTouch() || hoverTip?.unpin) {
      return;
    }
    // 只認帶 data-plot 的章節行。「故事架構」那幾行為了與章節行同一個版式也帶
    // `.row-plot`，但它們沒有細綱可彈：認進來的話會撤銷收起卻不另開一隻，
    // 上一章的浮窗就一直掛著，指著一行滑鼠早已不在的地方。
    const row = closestFrom<HTMLElement>(e.target, '.row-plot[data-plot]');
    if (row) {
      // 回到行上就撤銷待執行的收起（從浮窗挪回行上時會走到這兒）。
      cancelScheduledHide();
      scheduleSummaryTip(row);
    } else if (hoverTip) {
      // 挪到了別的行/空白處：給寬限而不是立刻收——滑鼠要去浮窗的話，
      // 半路會先掃過行下方的那道縫。
      scheduleHide();
    } else if (hoverTimer) {
      hideSummaryTip();
    }
  });

  el.projectBody.addEventListener('mouseleave', () => {
    if (lastPointerWasTouch() || hoverTip?.unpin) {
      return;
    }
    // 往浮窗方向移出去也會觸發這裡，同樣給寬限。
    if (hoverTip) {
      scheduleHide();
    } else {
      hideSummaryTip();
    }
  });

  // 右鍵選單彈出來時浮窗該讓路，兩個都是 fixed 會疊在一起。
  el.projectBody.addEventListener('contextmenu', hideSummaryTip);

  // 浮窗是 fixed 的，頁面一滾就和目標行脫節（與右鍵選單同一個理由）。
  // 但**浮窗自己內部的滾動不算**——細綱有七個小節，滾動是要給使用者用的，
  // 一滾就把浮窗收掉等於這個捲軸形同虛設。捕獲階段才收得到內部容器
  // （.project-body）的滾動。
  document.addEventListener(
    'scroll',
    (e) => {
      if (!hoverTip?.box.contains(e.target as Node)) {
        hideSummaryTip();
      }
    },
    true
  );

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideSummaryTip();
    }
  });
}
