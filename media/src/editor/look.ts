/**
 * 外觀：正文字型、字號、行距、版心寬度（取值與校驗在 `lookCore.ts`），護眼主題（與深 / 淺同一個機制，
 * 在 `shell.ts`）。入口是標題欄「檢視 → 外觀」那一組（選單那一半在 `view/lookMenu.ts`）與外觀面板（`lookPanel.ts`）。
 *
 * - **記在哪**：`novelforge.editor.prefs`，與成對符號、自動儲存同一處（`paragraphState.ts` 的
 *   `storedPrefs` / `setStoredPrefs`）；主題照舊記在 `novelforge.theme`。
 * - **怎麼生效**：一組 CSS 變數寫在 `<html>` 上（`lookVars`）。textarea、高亮映象層、預覽在 `css/standalone/look.css`
 *   裡讀同一組變數——**這裡不往哪個元素上單寫字號**，映象層要與 textarea 排得一模一樣，變數是唯一的那一份。
 *   映象層每次重畫仍從 textarea 的計算樣式抄一遍（`highlight.ts`），兩道保險。變數一變，這裡讓每塊編輯區的
 *   映象層當場重抄、重擺（`relayoutMirror`：尺寸沒變時 `ResizeObserver` 不會叫，換了字號卻必須重排）。
 * - **字號快捷鍵**：`Ctrl+=`（或 `Ctrl++`）放大、`Ctrl+-` 縮小、`Ctrl+0` 還原，**只在焦點在編輯區（正文的
 *   textarea）裡時攔**——掛在 `addKeyHandler` 上，輸入法組字中途的不收。焦點在別處時瀏覽器照常縮放整頁。
 */
import { toast } from '../globals';
import type { LookStatus } from '../globals';
import { addKeyHandler } from './api';
import { relayoutMirror } from './highlight';
import { openLookPanel } from './lookPanel';
import {
  DEFAULT_LOOK,
  FONT_SIZE,
  LOOK_KEYS,
  lookVars,
  normalizeLook,
  sameLook,
  stepFontSize,
} from './lookCore';
import type { LookPrefs } from './lookCore';
import { onPrefsChange, setStoredPrefs, storedPrefs } from './paragraphState';
import { panes } from './store';

let look: LookPrefs = { ...DEFAULT_LOOK };
const listeners = new Set<() => void>();

/** 當前的外觀（已校驗）。 */
export function currentLook(): LookPrefs {
  return look;
}

/** 改幾項（逐項校驗之後記下來、當場生效）。 */
export function setLook(patch: Partial<LookPrefs>): void {
  const next = normalizeLook({ ...look, ...patch });
  if (sameLook(next, look)) {
    return;
  }
  setStoredPrefs(Object.fromEntries(LOOK_KEYS.map((k) => [k, next[k]])));
}

/** 恢復預設：從偏好裡刪掉這幾項（以後預設改了也跟著走），不碰主題。 */
export function resetLook(): void {
  setStoredPrefs(Object.fromEntries(LOOK_KEYS.map((k) => [k, undefined])));
}

/** 外觀變了時通知（面板據此重新整理顯示）。 */
export function onLookChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 字號放大 / 縮小一檔；到頭了說一句。 */
export function zoom(dir: 1 | -1): void {
  const size = stepFontSize(look.fontSize, dir);
  if (size === look.fontSize) {
    toast(dir > 0 ? `字號已經是最大（${size}px）` : `字號已經是最小（${size}px）`);
    return;
  }
  setLook({ fontSize: size });
  toast(`字號 ${size}px`);
}

export function zoomReset(): void {
  if (look.fontSize !== DEFAULT_LOOK.fontSize) {
    setLook({ fontSize: DEFAULT_LOOK.fontSize });
  }
  toast(`字號 ${DEFAULT_LOOK.fontSize}px（預設）`);
}

/** 把這組變數寫到 `<html>` 上。 */
function applyVars(): void {
  const style = document.documentElement.style;
  for (const [name, value] of Object.entries(lookVars(look))) {
    style.setProperty(name, value);
  }
}

/** 偏好變了（這裡改的，或別處——只認外觀這幾項）：重算、寫變數、讓各塊編輯區按新排版重畫。 */
function sync(): void {
  const next = normalizeLook(storedPrefs());
  if (sameLook(next, look)) {
    return;
  }
  look = next;
  applyVars();
  for (const pane of Object.values(panes)) {
    relayoutMirror(pane);
  }
  for (const fn of [...listeners]) {
    fn();
  }
}

/**
 * 這一下是哪個字號快捷鍵。按 `key` 認（各種鍵盤佈局上瀏覽器自己的頁面縮放也是按它認的），小鍵盤的 + − 0 另按
 * `code` 認；不按主鍵盤的物理位置認——德語、法語佈局上那幾個位置是別的字（`ß`、`)`），不該被當成縮放。
 */
function zoomKey(e: KeyboardEvent): 1 | -1 | 0 | undefined {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) {
    return undefined;
  }
  if (e.key === '=' || e.key === '+' || e.code === 'NumpadAdd') {
    return 1;
  }
  if (e.key === '-' || e.code === 'NumpadSubtract') {
    return -1;
  }
  if ((e.key === '0' && !e.shiftKey) || e.code === 'Numpad0') {
    return 0;
  }
  return undefined;
}

function status(): LookStatus {
  return {
    fontSize: look.fontSize,
    defaultFontSize: DEFAULT_LOOK.fontSize,
    canZoomIn: look.fontSize < FONT_SIZE.max,
    canZoomOut: look.fontSize > FONT_SIZE.min,
  };
}

export function installLook(): void {
  look = normalizeLook(storedPrefs());
  applyVars();
  onPrefsChange(sync);

  // 只在編輯區裡攔：`addKeyHandler` 只收 textarea 的 keydown（組字中途的不收），焦點在別處時瀏覽器照常縮放。
  addKeyHandler((e) => {
    const dir = zoomKey(e);
    if (dir === undefined) {
      return false;
    }
    if (dir === 0) {
      zoomReset();
    } else {
      zoom(dir);
    }
    return true;
  });

  window.addEventListener('nf-view-query', (e) => {
    e.detail.look = status();
  });

  window.addEventListener('nf-view-command', (e) => {
    switch (e.detail.name) {
      case 'zoomIn':
        zoom(1);
        break;
      case 'zoomOut':
        zoom(-1);
        break;
      case 'zoomReset':
        zoomReset();
        break;
      case 'openLook':
        openLookPanel();
        break;
    }
  });
}
