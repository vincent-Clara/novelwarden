/**
 * 成對符號自動補全（正文與 Markdown；json / yml 等不做）。
 *
 * 對：“” ‘’ 「」 『』 （） 《》 【】 〈〉。半形括號不做——正文裡它們多半是英文、公式或作者有意用的半形。
 *
 * ## 為什麼掛在 `onEditorChange` 上，而不是 keydown
 *
 * 中文標點幾乎都是輸入法打出來的：拼音輸入法裡按 `"`，有的直接上屏（一條 `insertText`），有的走一遍組字
 * （`compositionend` 才上屏），keydown 里根本看不到「“」這個字。所以只認 `onEditorChange` 裡**帶 `change`**
 * 的那一下（`typing` 或 `composition`）：使用者剛剛確實往編輯區裡放了什麼、替換掉了什麼，都在裡面。
 *
 * ## 四條
 *
 * 1. 敲出左半邊 → 在後面補右半邊，游標停在中間。補的那一下 `join: true` 並進那次輸入：一次撤銷兩個一起退。
 *    只在游標後面是行尾、空白或收尾的標點時補——後面緊跟著正文時補上去，作者還得回頭刪（⚑）。
 * 2. 有選區時敲左半邊 → 把選中的字包起來（`change.removed` 就是被替換掉的那段，輸入法上屏時也拿得到），
 *    之後選中被包的那段。
 * 3. 緊挨著一個**自動補上**的右半邊再敲同一個右半邊 → 跳過，不重複。中文輸入法常自己交替出 “ ”：
 *    補完 ” 之後作者照習慣再按一次 `"`，輸入法給的正是 ”，這一條把它吸收掉。
 * 4. 剛補完、中間還空著就退格刪左半邊 → 右半邊一起刪。
 *
 * 「自動補上的」按檔案記（每份開啟的檔案一張小表），每一處改動都把記著的位置跟著挪；改動碰到了那兩個字、
 * 撤銷 / 重做、開關關掉，記錄就作廢——寧可少跳過一次，也不刪錯字。
 */
import { isProse, onEditorChange } from './api';
import type { EditorEvent, OpenFile, Pane, TextChange } from './api';
import { MARKDOWN_RE } from './enter';
import { autoPairEnabled, onPrefsChange } from './paragraphState';

/** 左半邊 → 右半邊。 */
export const PAIRS: Readonly<Record<string, string>> = {
  '“': '”',
  '‘': '’',
  '「': '」',
  '『': '』',
  '（': '）',
  '《': '》',
  '【': '】',
  '〈': '〉',
};

const RIGHTS = new Set(Object.values(PAIRS));

/** 游標後面緊跟這些（或行尾、文末）時才補右半邊。 */
const CLOSE_BEFORE = /[\s，。、；：？！…—）」』”’》】〉,.;:?!)\]}]/;

/** 游標後面是 `next` 時補不補右半邊。 */
export function shouldAutoClose(next: string | undefined): boolean {
  return next === undefined || next === '' || CLOSE_BEFORE.test(next);
}

/** 一對自動補上的符號：兩個字各在哪（按這份檔案當下的文字算）。 */
export interface AutoPair {
  left: number;
  right: number;
  open: string;
  close: string;
}

/** 一份檔案最多記幾對。 */
const MAX_PAIRS = 32;

/**
 * 一處改動之後這一對挪到哪。改動碰到了左右兩個字之一就作廢（undefined）。
 * 純插入時插在某個字之前（含同一個位置）的把它往後推；刪除 / 替換時落在被刪那段之後的往前挪。
 */
export function mapPair(p: AutoPair, c: TextChange): AutoPair | undefined {
  const end = c.at + c.removed.length;
  const delta = c.inserted.length - c.removed.length;
  const hit = (pos: number) => c.removed.length > 0 && pos >= c.at && pos < end;
  if (hit(p.left) || hit(p.right)) {
    return undefined;
  }
  const from = c.removed.length === 0 ? c.at : end;
  const move = (pos: number) => (pos >= from ? pos + delta : pos);
  return { ...p, left: move(p.left), right: move(p.right) };
}

/** 哪些檔案做成對補全：正文（不論副檔名）與 Markdown。 */
function applies(file: OpenFile): boolean {
  return isProse(file) || MARKDOWN_RE.test(file.path);
}

let tracked = new WeakMap<OpenFile, AutoPair[]>();

function pairsOf(file: OpenFile): AutoPair[] {
  return tracked.get(file) ?? [];
}

function setPairs(file: OpenFile, pairs: (AutoPair | undefined)[]): void {
  const kept = pairs.filter((p): p is AutoPair => !!p).slice(-MAX_PAIRS);
  if (kept.length > 0) {
    tracked.set(file, kept);
  } else {
    tracked.delete(file);
  }
}

const mapAll = (pairs: AutoPair[], c: TextChange) => pairs.map((p) => mapPair(p, c));

export function installPairs(): void {
  /** 自己調 `applyEdit` 的那一下：它也會發 `edit`，記錄由這裡手動挪，不再走一遍。 */
  let applying = false;

  onPrefsChange(() => {
    if (!autoPairEnabled()) {
      tracked = new WeakMap();
    }
  });

  onEditorChange((ev) => {
    if (ev.type !== 'edit' || applying) {
      return;
    }
    handle(ev);
  });

  function apply(pane: Pane, start: number, end: number, text: string, sel: { start: number; end: number }): void {
    applying = true;
    try {
      pane.applyEdit(start, end, text, sel, { join: true });
    } finally {
      applying = false;
    }
  }

  function handle(ev: Extract<EditorEvent, { type: 'edit' }>): void {
    const { pane, file, source, change } = ev;
    if (!change) {
      // 撤銷 / 重做一次可能退好幾處，位置對不上了。組字中途也不帶 change，那時不動（上屏那一下才算）。
      if (source === 'undo' || source === 'redo') {
        tracked.delete(file);
      }
      return;
    }
    const pairs = pairsOf(file);
    const live =
      autoPairEnabled() &&
      applies(file) &&
      pane.activeFile() === file &&
      (source === 'typing' || source === 'composition');
    if (live && (skipClose(pane, file, change, pairs) || deletePair(pane, file, change, pairs) || open(pane, file, change, pairs, source))) {
      return;
    }
    if (pairs.length > 0) {
      setPairs(file, mapAll(pairs, change));
    }
  }

  /** 第 3 條：緊挨著自動補上的右半邊又敲了同一個右半邊。 */
  function skipClose(pane: Pane, file: OpenFile, c: TextChange, pairs: AutoPair[]): boolean {
    if (c.removed !== '' || c.inserted.length !== 1 || !RIGHTS.has(c.inserted)) {
      return false;
    }
    // 敲進去的字落在 c.at，原來那個自動補的右半邊被推到了 c.at + 1。
    const hit = pairs.find((p) => p.right === c.at && p.close === c.inserted && file.draft[c.at + 1] === p.close);
    if (!hit) {
      return false;
    }
    const others = mapAll(
      pairs.filter((p) => p !== hit),
      c
    ).filter((p): p is AutoPair => !!p);
    apply(pane, c.at + 1, c.at + 2, '', { start: c.at + 1, end: c.at + 1 });
    setPairs(file, mapAll(others, { at: c.at + 1, removed: hit.close, inserted: '' }));
    return true;
  }

  /** 第 4 條：中間還空著，退格刪了左半邊。 */
  function deletePair(pane: Pane, file: OpenFile, c: TextChange, pairs: AutoPair[]): boolean {
    if (c.inserted !== '' || c.removed.length !== 1 || !PAIRS[c.removed]) {
      return false;
    }
    // 左半邊刪掉之後，右半邊落在 c.at。
    const hit = pairs.find(
      (p) => p.left === c.at && p.right === c.at + 1 && p.open === c.removed && file.draft[c.at] === p.close
    );
    if (!hit) {
      return false;
    }
    const others = mapAll(
      pairs.filter((p) => p !== hit),
      c
    ).filter((p): p is AutoPair => !!p);
    apply(pane, c.at, c.at + 1, '', { start: c.at, end: c.at });
    setPairs(file, mapAll(others, { at: c.at, removed: hit.close, inserted: '' }));
    return true;
  }

  /** 第 1、2 條：敲出了左半邊（鍵盤一下一個字；輸入法上屏可能連著別的字，看最後一個）。 */
  function open(pane: Pane, file: OpenFile, c: TextChange, pairs: AutoPair[], source: string): boolean {
    const typed = c.inserted[c.inserted.length - 1];
    const close = typed ? PAIRS[typed] : undefined;
    if (!close || (c.inserted.length !== 1 && source !== 'composition')) {
      return false;
    }
    const pos = c.at + c.inserted.length;
    const moved = mapAll(pairs, c).filter((p): p is AutoPair => !!p);
    if (c.removed !== '' && c.inserted.length === 1) {
      // 有選區：包起來，選中被包的那段。
      const text = c.removed + close;
      apply(pane, pos, pos, text, { start: pos, end: pos + c.removed.length });
      setPairs(file, [
        ...mapAll(moved, { at: pos, removed: '', inserted: text }),
        { left: pos - 1, right: pos + c.removed.length, open: typed, close },
      ]);
      return true;
    }
    if (!shouldAutoClose(file.draft[pos])) {
      return false;
    }
    apply(pane, pos, pos, close, { start: pos, end: pos });
    setPairs(file, [
      ...mapAll(moved, { at: pos, removed: '', inserted: close }),
      { left: pos - 1, right: pos, open: typed, close },
    ]);
    return true;
  }
}
