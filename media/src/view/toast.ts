/**
 * 提示條。整個頁面只有一條——editor / explorer 經 `window.__nfToast` 複用它，
 * 免得兩套提示互相蓋住。
 */
import { setHidden } from '../dom';
import { el } from './refs';

/** 錯誤留久一點：那多半是要照著做點什麼的，一閃而過等於沒說。 */
const INFO_MS = 3500;
const ERROR_MS = 9000;

let timer: ReturnType<typeof setTimeout> | undefined;

/** 帶一個按鈕的提示（任務做完時的「開啟第 3 章」，D24）要多留一會兒：那是要點的。 */
const ACTION_MS = 12000;

/**
 * 出一條提示。`action` 給了就在提示條上多一顆按鈕，點了執行、提示收起。
 */
export function toast(message: string, isError?: boolean, action?: { label: string; run: () => void }): void {
  el.toast.textContent = message;
  el.toast.classList.toggle('error', !!isError);
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'link toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      setHidden(el.toast, true);
      action.run();
    });
    el.toast.appendChild(btn);
  }
  setHidden(el.toast, false);
  clearTimeout(timer);
  timer = setTimeout(() => setHidden(el.toast, true), action ? ACTION_MS : isError ? ERROR_MS : INFO_MS);
}

/** 裝到全域，供 editor / explorer 複用。 */
export function exposeToast(): void {
  window.__nfToast = toast;
}
