/**
 * 一套選單引擎，兩個入口：氣泡右上角的 ⋯ 按鈕（貼著按鈕絕對定位），
 * 以及任意位置的右鍵（掛在 body 上、跟著游標走）。
 *
 * 選單項由 `{ label, run, danger, disabled }` 描述，`{ sep: true }` 是分隔線。
 *
 * **右鍵一律接管**：全域監聽裡無條件 `preventDefault()`，輸入框 / 文字域 /
 * 內建編輯器裡也一樣，所以原生的複製/貼上選單不會出現。這是有意的取捨
 * （選單風格統一），代價是那幾處的編輯項要自己實現（見 editor/clipboard.ts）。
 * 外掛形態另需 webviewHtml.ts 裡 body 上的 `data-vscode-context`——
 * VS Code 給 webview 加的選單由宿主渲染，JS 的 preventDefault 壓不住。
 *
 * **接管要接得夠早、夠全**，否則原生選單會漏出來——觸控板雙指點選尤其容易
 * （它經過的事件序列與按實體右鍵並不完全一樣）。兩處防線：
 *
 * 1. `contextmenu` 掛在 **window 的捕獲階段**，也就是這個事件在頁面裡最早
 *    到得了的地方。掛在 document 的冒泡階段會被中途任何一處 `stopPropagation()`
 *    擋住，那時 `preventDefault()` 根本沒機會呼叫，原生選單就照常彈出來。
 * 2. `auxclick`（副鍵的「點選」）兜底：這一次手勢裡 `contextmenu` 壓根沒來過，
 *    就用它彈我們的選單，並把它自己的預設行為也擋掉。雙指點選在部分瀏覽器/
 *    驅動上走的就是這一路。落點沒動、又緊挨著剛彈過的那一次，則只擋不彈——
 *    那是同一次點選的尾巴。
 *
 * **不碰 `pointerdown` / `mousedown` 的預設行為**：按規範取消 `pointerdown`
 * 攔不住 `contextmenu`（`click` / `auxclick` / `contextmenu` 明確不在被壓制的
 * 相容事件之列），卻會順手把 `mousedown` 吃掉——於是文字域裡右鍵不再挪游標，
 * 選單裡的「貼上」會貼到上一次游標的位置去。得不到好處，只會壞事。
 *
 * 觸控長按的 callout 是另一路，JS 管不著，在 CSS 裡用
 * `-webkit-touch-callout: none` 關掉（見 css/view/base.css）。
 *
 * **例外：手指長按在能打字的框裡（正文區、輸入框）不接管**，交給系統的選字選單：我們的選單彈在手指底下，正好蓋住
 * 剛選中的字和選區兩頭的把手（手機上實測），系統那一條貼在選區上方、不擋把手，貼上也不用另外要剪貼簿許可權。
 * 滑鼠右鍵照舊是我們的選單。
 */
import { el as mk } from '../dom';
import type { ContextMenuRegistrar, MenuContext, MenuItem } from '../globals';
import { isTouchEvent, trackPointer } from '../touch';
import { placeAtPoint, visibleArea } from './menuPlace';

/** 能打字的框：手指長按在這裡面走系統的選字選單。 */
const EDITABLE = 'textarea, input, [contenteditable="true"], [contenteditable=""]';

/** 當前開啟的選單（同時只允許一個）。`btn` 有值即為 ⋯ 選單。 */
let openMenu: { btn: HTMLElement | null; menu: HTMLElement } | null = null;

export function closeMenu(): void {
  if (!openMenu) {
    return;
  }
  openMenu.menu.remove();
  openMenu.btn?.classList.remove('active');
  openMenu = null;
}

/** 由選單項陣列建出選單 DOM。兩個入口共用，差別只在掛到哪兒、怎麼定位。 */
export function buildMenuElement(items: MenuItem[], className: string): HTMLElement {
  const menu = mk('div', className);
  for (const item of items) {
    if (item.sep) {
      // 首尾與連續的分隔線都沒有意義（構建方按需拼接，這裡兜一下）。
      if (menu.lastElementChild && !menu.lastElementChild.classList.contains('menu-sep')) {
        menu.appendChild(mk('div', 'menu-sep'));
      }
      continue;
    }
    const b = mk('button', undefined, item.label);
    if (item.danger) {
      b.classList.add('danger');
    }
    if (item.disabled) {
      b.disabled = true;
    }
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (item.disabled) {
        return;
      }
      closeMenu();
      item.run?.();
    });
    menu.appendChild(b);
  }
  // 拼完後可能落下一條尾部分隔線。
  const tail = menu.lastElementChild;
  if (tail?.classList.contains('menu-sep')) {
    tail.remove();
  }
  return menu;
}

/**
 * 在視口座標 (x, y) 處彈出選單。掛在 body 上、position: fixed——
 * 右鍵可能發生在任何容器裡（含內部滾動的工程頁），跟著容器走會被裁掉。
 * **整個落在可視區裡**（`menuPlace.ts` 的 `placeAtPoint`）：右 / 下放不下往左 / 往上翻，翻過去還放不下就平移貼邊，
 * 比可視區還高就壓 `max-height` 在選單裡滾——手機豎屏在下半屏長按，從前選單會被螢幕底邊截掉一截。
 */
function showContextMenu(items: MenuItem[], x: number, y: number): HTMLElement | undefined {
  closeMenu();
  if (items.length === 0) {
    return undefined;
  }

  const menu = buildMenuElement(items, 'ctx-menu');
  menu.style.left = '0px';
  menu.style.top = '0px';
  document.body.appendChild(menu);
  openMenu = { btn: null, menu };

  // jsdom 裡 offsetWidth 恆為 0，擺法自動退化為「貼游標」，不影響斷言。
  const place = placeAtPoint(x, y, menu.offsetWidth, menu.offsetHeight, visibleArea());
  menu.style.left = `${place.left}px`;
  menu.style.top = `${place.top}px`;
  if (place.maxHeight !== undefined) {
    menu.style.maxHeight = `${place.maxHeight}px`;
  }
  return menu;
}

/** 貼著某個按鈕彈出的 ⋯ 選單。掛在按鈕的容器裡，跟著氣泡一起滾。 */
export function toggleButtonMenu(btn: HTMLElement, items: MenuItem[]): void {
  // 再點一次同一個按鈕就是收起。
  if (openMenu?.btn === btn) {
    closeMenu();
    return;
  }
  closeMenu();
  // 掛到 body 上就得手算座標，還要跟著 .messages 滾動；貼在容器裡省這一層。
  const menu = buildMenuElement(items, 'msg-menu');
  btn.parentElement?.appendChild(menu);
  btn.classList.add('active');
  openMenu = { btn, menu };
}

/**
 * 「這個元素上右鍵給什麼選單」的登記表。
 *
 * 用 WeakMap 而不是在右鍵時按 relPath 反查最近一次收到的樹：選單項在構建
 * 那一行時就已經知道全部上下文（節點、所屬區、落點目錄），反查得把這些
 * 再拼一遍。行被重渲染丟棄後條目自動回收。
 */
const menuProviders = new WeakMap<Element, (at: MenuContext) => MenuItem[]>();

/** 給一個元素登記右鍵選單。`provide` 返回選單項陣列，右鍵那一刻才呼叫（帶著按在哪、是不是長按）。 */
export const onContextMenu: ContextMenuRegistrar = (node, provide) => {
  menuProviders.set(node, provide);
  return node;
};

/** 從事件目標往上找第一個登記過選單的祖先。 */
function resolveMenuItems(at: MenuContext): MenuItem[] | null {
  let node = at.target;
  for (; node; node = node.parentElement) {
    const provide = menuProviders.get(node);
    if (provide) {
      return provide(at);
    }
  }
  return null;
}

/**
 * 觸屏上長按彈的選單最前面的「看一眼」。懸停浮窗（工程頁的細綱、被截斷的說明、失敗原因）在手指下沒有入口——
 * 手指沒有「停在上面」這回事——這幾項就是它們的入口：各只浮窗登記一個，長按那一刻按按下去的地方給項（沒有就給空陣列）。
 * 滑鼠右鍵不給（滑鼠懸停就看得到，選單裡不重複）。
 */
type PeekProvider = (at: MenuContext) => MenuItem[];
const peekProviders: PeekProvider[] = [];

export function onTouchPeek(provide: PeekProvider): void {
  peekProviders.push(provide);
}

function peekItems(at: MenuContext): MenuItem[] {
  return at.touch ? peekProviders.flatMap((provide) => provide(at)) : [];
}

/**
 * 裝上全域監聽。**只能裝一次**——另起一套會兩層選單一起彈，所以
 * editor / explorer 都經 `window.__nfContextMenu` 複用這裡的登記表。
 *
 * `fallback` 是所有頁面都有的兜底選單（一個重新整理）。
 */
export function installMenus(fallback: () => MenuItem[]): void {
  trackPointer();
  window.__nfContextMenu = onContextMenu;
  // 編輯器標籤條末尾的「▾」：不是右鍵，但彈的是同一種選單（同時只有一個、點別處收起）。
  window.__nfShowMenu = showContextMenu;

  /** 副鍵（右鍵 / 觸控板雙指點選 / 長按）。主鍵與中鍵不接管。 */
  const isSecondary = (e: MouseEvent): boolean => e.button === 2;

  /**
   * 上一次彈選單的時刻與落點。一次右鍵在 Chromium 裡是
   * pointerdown → contextmenu → auxclick，後兩個都會落到這兒；`auxclick`
   * 據此認出「這是剛才那一下的尾巴」，不重複彈。
   *
   * 認的是**時刻 + 落點**而不是一個「這一次手勢裡彈過沒有」的布林量：那個量
   * 要靠某個事件來複位，而這裡的前提恰恰是**不知道哪些事件會來**（不同瀏覽器 /
   * 驅動發的序列不一樣）。復位的那一發沒來，布林量就永遠卡在 true，右鍵從此
   * 失靈。只看時刻也不夠：只發 auxclick 的環境裡，300ms 內在別處再點一下
   * 會被無聲吃掉。
   */
  let served = { at: 0, x: NaN, y: NaN };

  /** 同一次點選的尾巴：緊挨著、且落點沒動。 */
  const isSameClick = (e: MouseEvent): boolean =>
    Date.now() - served.at <= 300 && e.clientX === served.x && e.clientY === served.y;

  /** 在事件的落點彈出選單。`contextmenu` 與兜底的 `auxclick` 共用。 */
  const openAt = (e: MouseEvent): void => {
    served = { at: Date.now(), x: e.clientX, y: e.clientY };
    // 在已彈出的選單上右鍵：收起就好，不要再疊一層兜底選單。
    if (openMenu?.menu.contains(e.target as Node)) {
      closeMenu();
      return;
    }
    let { clientX: x, clientY: y } = e;
    // 鍵盤的「選單鍵」觸發時 clientX/Y 為 0，改用目標元素的位置，
    // 否則選單會跑到螢幕左上角。
    if (!x && !y && e.target instanceof Element) {
      const rect = e.target.getBoundingClientRect();
      x = rect.left;
      y = rect.bottom;
    }
    const at: MenuContext = { target: e.target instanceof Element ? e.target : null, x, y, touch: isTouchEvent(e) };
    const items = resolveMenuItems(at) ?? fallback();
    const peeks = peekItems(at);
    showContextMenu(peeks.length > 0 ? [...peeks, { sep: true }, ...items] : items, x, y);
  };

  // window 的捕獲階段：頁面裡最早的一站，誰都沒機會先把它攔掉。
  window.addEventListener(
    'contextmenu',
    (e) => {
      if (isTouchEvent(e) && e.target instanceof Element && e.target.closest(EDITABLE)) {
        // 手指長按在能打字的框裡：系統的選字選單（見檔案頭）。開著的選單照常收。
        closeMenu();
        return;
      }
      e.preventDefault();
      openAt(e);
    },
    true
  );

  // 兜底：雙指點選只發了 auxclick、沒發 contextmenu 的那些環境。
  window.addEventListener(
    'auxclick',
    (e) => {
      if (!isSecondary(e)) {
        return;
      }
      e.preventDefault();
      if (!isSameClick(e)) {
        openAt(e);
      }
    },
    true
  );

  // 點別處、按 Esc 都要收起選單。
  document.addEventListener('click', closeMenu);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeMenu();
    }
  });

  // 右鍵選單是 fixed 定位的，內容一滾它就和目標行脫節了，收起來。
  // **只收右鍵選單**：⋯ 選單掛在氣泡裡會跟著滾，而且流式輸出貼著底跟滾時
  // 每來一段都會 scrollToBottom()，一起收會讓它剛點開就消失。捕獲階段才
  // 收得到內部容器（.messages / .project-body）的滾動。
  document.addEventListener(
    'scroll',
    () => {
      if (openMenu && !openMenu.btn) {
        closeMenu();
      }
    },
    true
  );
}
