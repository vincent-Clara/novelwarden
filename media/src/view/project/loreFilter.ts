/**
 * 「設定」組標題旁的篩選框：設定幾百條時不用一層層翻目錄。
 *
 * **純前端**：篩選串記在 `treeState.loreView.filter`，不發給後端、不進推送；後端每次檔案變動
 * 都整棵重推樹，篩選照樣留著（同摺疊開合）。按標題、一句話（行副標題）與關鍵詞篩已建條目，
 * 按名字與分類篩「出現過 · 未建條目」與「待完善」，不分大小寫的子串匹配。
 *
 * 難點是**重畫會把輸入框換掉**：工程頁每次都整頁重建（`renderProject`），打一個字重畫一次，
 * 檔案監視推來的樹也隨時會重畫。所以：
 *
 * 1. 重畫前記下焦點與游標（`captureLoreFilterFocus`），重畫完放回新的輸入框上——不然每打一個字
 *    焦點就丟一次，旁邊儲存一章也會把正在打字的人踢出來。
 * 2. **輸入法組字期間不重畫**：組字中途換掉輸入框，打了一半的拼音就沒了。中途的 `input` 不算數，
 *    等 `compositionend` 再篩；這期間推來的樹只記下不畫（`renderProject` 先問 `loreFilterComposing`），
 *    組字結束那一下按最新的樹一起畫。
 */
import { el as mk, setHidden } from '../../dom';
import type { LoreUnfiledEntry, ProjectFile, ProjectTree } from '../../protocol';
import { loreView, openGroups } from './treeState';

/** 篩選框裡正在用輸入法組字。 */
let composing = false;

export function loreFilterComposing(): boolean {
  return composing;
}

function needle(): string {
  return loreView.filter.trim().toLowerCase();
}

function hits(q: string, ...texts: string[]): boolean {
  return texts.some((t) => t.toLowerCase().includes(q));
}

/**
 * 已建條目的匹配函式，交給 `renderNodes`。沒在篩選時給 undefined——那條路徑照舊按摺疊開合畫。
 * 關鍵詞不在行上（行上只有標題與一句話），從 `loreByEntry` 裡取。
 */
export function loreMatcher(tree: ProjectTree): ((f: ProjectFile) => boolean) | undefined {
  const q = needle();
  if (!q) {
    return undefined;
  }
  return (f) => hits(q, f.label, f.detail, ...(tree.loreByEntry[f.relPath]?.keywords ?? []));
}

/** 「出現過 · 未建條目」「待完善」裡按名字與分類匹配的那些（沒在篩選時原樣返回）。 */
export function filterUnfiled<T extends Pick<LoreUnfiledEntry, 'name' | 'category'>>(list: T[]): T[] {
  const q = needle();
  return q ? list.filter((u) => hits(q, u.name, u.category)) : list;
}

/**
 * 篩選框本身。`rerender` 是整頁重畫（index.ts 的 `rerenderProject`）。
 *
 * 不用 `type="search"`：Chromium 會再畫一個原生的清空叉，和我們自己的 × 疊成兩個；
 * 而 Firefox 又不畫——自己畫一個兩邊才一樣。
 */
export function buildLoreFilter(rerender: () => void): HTMLElement {
  const box = mk('span', 'lore-filter');
  const input = mk('input', 'lore-filter-input');
  input.type = 'text';
  input.placeholder = '篩選設定';
  input.title = '按標題、一句話、關鍵詞篩選設定；也篩下面的「出現過 · 未建條目」（Esc 清空）';
  input.spellcheck = false;
  input.value = loreView.filter;

  const clearBtn = mk('button', 'lore-filter-clear', '×');
  clearBtn.title = '清空篩選（Esc）';
  setHidden(clearBtn, loreView.filter === '');

  const apply = (value: string) => {
    if (value === loreView.filter) {
      return;
    }
    loreView.filter = value;
    // 組折著的時候打字等於什麼都看不見：開始篩就把它展開。
    if (value.trim()) {
      openGroups.lore = true;
    }
    rerender();
  };

  input.addEventListener('input', (e) => {
    if ((e as InputEvent).isComposing || composing) {
      return;
    }
    apply(input.value);
  });
  input.addEventListener('compositionstart', () => {
    composing = true;
  });
  input.addEventListener('compositionend', () => {
    composing = false;
    // 無條件重畫：組字期間推來的樹還沒畫（見檔案頭第 2 條）。之後瀏覽器若再補一發 input，
    // apply 看值沒變就不再畫第二遍。
    loreView.filter = input.value;
    if (input.value.trim()) {
      openGroups.lore = true;
    }
    rerender();
  });
  // 兜底：組字沒收尾就失焦（切頁籤之類）的瀏覽器不發 compositionend，標誌不清的話
  // 之後推來的樹永遠畫不出來。只在真的卡著組字時才重畫——平時失焦就重畫，會把作者正要點的那一行換掉。
  input.addEventListener('blur', () => {
    if (composing) {
      composing = false;
      rerender();
    }
  });

  input.addEventListener('keydown', (e) => {
    // 組字時的 Esc 是輸入法自己的（取消這次組字），放行。
    if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) {
      return;
    }
    if (input.value !== '' || loreView.filter !== '') {
      e.preventDefault();
      input.value = '';
      apply('');
    }
  });

  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    input.value = '';
    apply('');
    // 按下按鈕時焦點已經落在按鈕上，重畫前記不到輸入框，這裡直接放回去：清完多半接著打別的字。
    document.querySelector<HTMLInputElement>('#projectBody .lore-filter-input')?.focus({ preventScroll: true });
  });

  box.append(input, clearBtn);
  return box;
}

interface FilterFocus {
  start: number | null;
  end: number | null;
  direction: 'forward' | 'backward' | 'none' | null;
}

/** 重畫前：焦點在篩選框裡就記下游標。 */
export function captureLoreFilterFocus(): FilterFocus | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement) || !active.classList.contains('lore-filter-input')) {
    return null;
  }
  return { start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection };
}

/** 重畫後：把焦點與游標放回新的那個篩選框（這次重畫把篩選框撤掉了就算了）。 */
export function restoreLoreFilterFocus(saved: FilterFocus | null): void {
  if (!saved) {
    return;
  }
  const input = document.querySelector<HTMLInputElement>('#projectBody .lore-filter-input');
  if (!input) {
    return;
  }
  // preventScroll：焦點放回去不該把工程頁滾到標題欄那兒。
  input.focus({ preventScroll: true });
  if (saved.start !== null && saved.end !== null) {
    const max = input.value.length;
    input.setSelectionRange(Math.min(saved.start, max), Math.min(saved.end, max), saved.direction ?? undefined);
  }
}
