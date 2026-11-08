/** 建按鈕的幾個小工具。設定頁、訊息氣泡、工程頁都在用。 */
import { el } from '../dom';

export function linkBtn(text: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'link', text);
  b.addEventListener('click', onClick);
  return b;
}

export function primaryBtn(text: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'primary', text);
  b.addEventListener('click', onClick);
  return b;
}

export function secondaryBtn(text: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'secondary', text);
  b.addEventListener('click', onClick);
  return b;
}

/** 卡片頭部用的小號按鈕。 */
export function smallBtn(text: string, onClick: () => void): HTMLButtonElement {
  const b = secondaryBtn(text, onClick);
  b.classList.add('small');
  return b;
}
