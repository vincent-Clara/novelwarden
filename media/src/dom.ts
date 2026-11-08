/**
 * 建 DOM 的小工具。三個前端產物共用。
 *
 * 全部走 createElement + textContent，**從不拼 HTML 字串**：
 * 頁面上顯示的東西大半是模型寫的或作者寫的（摘要、正文、檔名），
 * 裡面出現 `<script>` 也只該是普通文字。
 */

/**
 * 造一個元素。`text` 一律經 textContent 落下去。
 *
 * ```ts
 * el('span', 'meta', '3 章');
 * el('button', 'primary');
 * ```
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

/** 撐開剩餘空間的佔位符。工具欄、訊息頭部裡到處在用。 */
export function spacer(): HTMLSpanElement {
  return el('span', 'spacer');
}

/**
 * 按 id 取一個必然存在的節點。取不到就拋——那說明 html.ts 與這裡對不上，
 * 靜默返回 null 只會讓錯誤在幾十行之後以「讀 null 的屬性」的面目出現。
 */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`頁面上找不到 #${id}——html 模板與前端程式碼不同步`);
  }
  return node as T;
}

/**
 * 按 id 取一個**可能不存在**的節點。
 *
 * 兩個殼的 DOM 不完全一樣：獨立版有活動欄徽標、內建編輯器、資源管理器，
 * 外掛形態沒有。用它探測能力，而不是判斷環境字串。
 */
export function maybeById<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

/** `classList.toggle` 的 hidden 版，夠短才不會有人圖省事去寫 style.display。 */
export function setHidden(node: Element, hidden: boolean): void {
  node.classList.toggle('hidden', hidden);
}

/** 清空一個容器。重渲染前都要走一次。 */
export function clear(node: Element): void {
  node.innerHTML = '';
}

/** 事件目標向上找最近的匹配元素。`e.target` 是 EventTarget，得先窄化。 */
export function closestFrom<T extends Element = HTMLElement>(
  target: EventTarget | null,
  selector: string
): T | null {
  return target instanceof Element ? target.closest<T>(selector) : null;
}
