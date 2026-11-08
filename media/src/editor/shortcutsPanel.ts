/**
 * 「幫助 → 快捷鍵一覽」與 `Ctrl+/`（⚑）：一個頁內面板，按分組列出 `shortcuts.ts` 那張表——鍵（按平臺寫，Mac 上 ⌘ / ⌥）、
 * 做什麼、在哪兒管用、補充說明（瀏覽器攔不住的那幾個寫在這裡），頂上一個篩選框。
 *
 * 寫法與樣式照 `dialog.ts`：DOM 現造現拆、頁面模板裡沒有它，外觀複用 `css/view/modal.css` 那一套（`.modal-overlay` /
 * `.modal` / `.modal-head` / `.modal-body`），焦點進篩選框、關掉之後回到開啟之前的地方。它是模態的（外面那一層是
 * `.modal-overlay`，`Ctrl+P` 之類開著時不開），但不是一問一答：不算 `isDialogOpen()`（不攔自動儲存），開著時別的
 * 快捷鍵照常（篩選框裡 `Ctrl+A` / `Ctrl+V` 要能用）。`Esc`、點外面那一層、×、再按一下 `Ctrl+/` 都關。
 *
 * 只在獨立版：它在 editor.js 裡，外掛形態沒有內建編輯器、也沒有標題欄，`editor/index.ts` 探測不到 `#wbEditor` 就整個不裝。
 */
import { el } from '../dom';
import { isImeComposing } from './api';
import {
  SHORTCUTS,
  filterShortcuts,
  formatKey,
  groupShortcuts,
  isMacPlatform,
  matchesShortcut,
  scopeText,
} from './shortcuts';
import type { Shortcut } from './shortcuts';

interface Panel {
  overlay: HTMLElement;
  input: HTMLInputElement;
}

let panel: Panel | undefined;

/**
 * 開啟（開著就把焦點放回篩選框）。別的彈窗（`.modal-overlay`：設定裡的服務商彈窗、表單、頁內對話方塊）開著時不開，
 * 返回 false。
 */
export function openShortcutsPanel(): boolean {
  if (panel) {
    panel.input.focus();
    return true;
  }
  if (document.querySelector('.modal-overlay:not(.hidden)')) {
    return false;
  }
  panel = buildPanel();
  return true;
}

function buildPanel(): Panel {
  const previous = document.activeElement as HTMLElement | null;
  const mac = isMacPlatform();

  const overlay = el('div', 'modal-overlay ed-keys-overlay');
  const box = el('div', 'modal ed-keys');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  const titleId = `edKeysTitle${Date.now().toString(36)}`;
  box.setAttribute('aria-labelledby', titleId);

  const head = el('div', 'modal-head');
  const title = el('span', 'modal-title', '快捷鍵一覽');
  title.id = titleId;
  const x = el('button', 'icon-btn ed-keys-x', '×');
  x.type = 'button';
  x.title = '關閉（Esc）';
  head.append(title, x);

  const body = el('div', 'modal-body');
  const input = el('input', 'ed-keys-filter');
  input.type = 'search';
  input.placeholder = mac ? '篩選：按鍵或說明，比如 ⌘F、查詢、預覽' : '篩選：按鍵或說明，比如 Ctrl+F、查詢、預覽';
  input.setAttribute('aria-label', '篩選快捷鍵');
  const list = el('div', 'ed-keys-list');
  const count = el('p', 'hint ed-keys-count');
  body.append(input, count, list);
  box.append(head, body);
  overlay.appendChild(box);

  const render = (): void => {
    const shown = filterShortcuts(SHORTCUTS, input.value);
    list.replaceChildren();
    if (shown.length === 0) {
      list.appendChild(el('p', 'ed-keys-empty', '沒有匹配的快捷鍵。'));
    }
    for (const { group, items } of groupShortcuts(shown)) {
      const section = el('section', 'ed-keys-group');
      section.appendChild(el('h3', 'ed-keys-group-title', group));
      const table = el('div', 'ed-keys-table');
      for (const s of items) {
        table.appendChild(row(s, mac));
      }
      section.appendChild(table);
      list.appendChild(section);
    }
    count.textContent = input.value.trim()
      ? `找到 ${shown.length} 個（一共 ${SHORTCUTS.length} 個）`
      : `一共 ${SHORTCUTS.length} 個。標著「瀏覽器多半攔不住」的，在瀏覽器裡會被瀏覽器拿去，桌面版裡管用。`;
  };
  render();
  // 組字中途不篩（拼音字母不算），上屏那一下再篩。
  input.addEventListener('input', (e) => {
    if (!(e as InputEvent).isComposing) {
      render();
    }
  });
  input.addEventListener('compositionend', render);

  const onKey = (e: KeyboardEvent): void => {
    if (isImeComposing(e)) {
      return;
    }
    // 開著時 Esc 只收這一個面板（不連帶退出專注模式、不收查詢條）；再按一下 Ctrl+/ 也是關。
    if (e.key === 'Escape' || matchesShortcut(e, 'shortcuts')) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  // 點外面那一層（不是面板本身）就關。
  const onDown = (e: MouseEvent): void => {
    if (e.target === overlay) {
      e.preventDefault();
      close();
    }
  };
  // Tab 不出面板：焦點被挪到外面去了就拉回篩選框。
  const keepFocus = (e: FocusEvent): void => {
    if (!box.contains(e.target as Node)) {
      input.focus();
    }
  };

  function close(): void {
    if (panel?.overlay !== overlay) {
      return;
    }
    panel = undefined;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('focusin', keepFocus, true);
    overlay.remove();
    if (previous?.isConnected) {
      previous.focus();
    }
  }

  x.addEventListener('click', close);
  overlay.addEventListener('mousedown', onDown);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('focusin', keepFocus, true);
  document.body.appendChild(overlay);
  input.focus();
  return { overlay, input };
}

/** 一行：鍵（幾種按法各一個 `<kbd>`）、做什麼（下面一行小字是補充說明）、在哪兒管用。 */
function row(s: Shortcut, mac: boolean): HTMLElement {
  const line = el('div', 'ed-keys-row');
  line.dataset.id = s.id;
  const keys = el('span', 'ed-keys-keys');
  s.keys.forEach((spec, i) => {
    if (i > 0) {
      keys.appendChild(el('span', 'ed-keys-or', ' / '));
    }
    keys.appendChild(el('kbd', undefined, formatKey(spec, mac)));
  });
  const what = el('span', 'ed-keys-label', s.label);
  if (s.note) {
    what.appendChild(el('span', 'hint ed-keys-note', s.note));
  }
  line.append(keys, what, el('span', 'ed-keys-where', scopeText(s)));
  return line;
}

let installed = false;

/** 裝上 `Ctrl+/` 與「幫助 → 快捷鍵一覽」的編輯器那一半。`editor/index.ts` 調一次。 */
export function installShortcutsPanel(): void {
  if (installed) {
    return;
  }
  installed = true;

  // 哪裡都認（對話輸入框裡也是：這個鍵在那裡沒有別的用處）；開著時由面板自己在捕獲階段接走、關掉。
  document.addEventListener('keydown', (e) => {
    if (isImeComposing(e) || !matchesShortcut(e, 'shortcuts')) {
      return;
    }
    if (openShortcutsPanel()) {
      e.preventDefault();
    }
  });

  window.addEventListener('nf-shortcuts-query', (e) => {
    e.detail.available = true;
  });
  window.addEventListener('nf-shortcuts-command', () => openShortcutsPanel());
}
