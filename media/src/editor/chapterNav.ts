/**
 * 上一章 / 下一章（章節條上的「‹ 上一章」「下一章 ›」，快捷鍵 Alt+PageUp / Alt+PageDown，⚑）。
 *
 * - **順序按章號**（章節索引的順序，第 8 條）。到頭了章節條上的按鈕禁用、快捷鍵說一句。
 * - **哪一面跟哪一面**：當前標籤是正文就換成相鄰那一章的正文，是細綱就換成相鄰那一章的細綱。
 * - **沒改過就在原位置換掉，改過就另開一個標籤**：開啟請求帶 `replace`（後端原樣帶回），編輯區收到時再看一眼
 *   那一份還是不是沒改過（`pane.ts` 的 `slotFor`）。
 * - **配對的那一份跟著走**：另一塊編輯區正開著這一章的配對檔案（正文 ↔ 細綱）時，同樣換成相鄰那一章的配對檔案，
 *   規矩一樣；它不搶焦點（`quietOpen`）——作者的游標留在他按鍵的那一塊。
 * - **相鄰那一章還沒有這一面**（沒寫正文、沒排細綱）：照實說一句，不開一個不存在的檔案。
 *
 * 快捷鍵的取捨（⚑）：瀏覽器保留了 Ctrl+PageUp/PageDown（切瀏覽器標籤頁）、Alt+←/→（前進後退），編輯器自己的
 * Alt+↑/↓、Shift+Alt+↑/↓ 是段落快捷鍵；Alt+PageUp/PageDown 這幾處都沒佔，「翻頁」的意思也對得上「翻一章」。
 */
import { toast } from '../globals';
import type { ChapterIndexEntry, InMessage } from '../protocol';
import { isImeComposing } from './api';
import { SIDE_LABEL, chapterAt, chapterIndex, flipSide, pathOn } from './chapterIndex';
import type { ChapterSide } from './chapterIndex';
import type { Pane } from './store';
import { activePane, otherPane, paneOwning } from './store';

let post: (msg: InMessage) => void = () => {};

/** 配對那一份的開啟請求：它到了不搶「當前是哪一塊」（`index.ts` 收 `editorOpen` 時問）。 */
const quiet = new Set<string>();

export function takeQuietOpen(pane: string, path: string): boolean {
  return quiet.delete(`${pane}:${path}`);
}

/** 當前檔案是哪一章的哪一面，前後各是哪一章。不是某一章的正文或細綱時 undefined。 */
export function neighborsOf(path: string | null | undefined):
  | { entry: ChapterIndexEntry; side: ChapterSide; prev?: ChapterIndexEntry; next?: ChapterIndexEntry }
  | undefined {
  const at = path ? chapterAt(path) : undefined;
  if (!at) {
    return undefined;
  }
  const list = chapterIndex();
  return { entry: at.entry, side: at.side, prev: list[at.index - 1], next: list[at.index + 1] };
}

/** 往前（-1）或往後（1）一章。 */
export function goChapter(step: -1 | 1): void {
  const pane = activePane;
  const file = pane?.activeFile();
  const around = neighborsOf(file?.path);
  if (!pane || !file || !around) {
    return;
  }
  const next = step < 0 ? around.prev : around.next;
  if (!next) {
    toast(step < 0 ? '已經是第一章了。' : '已經是最後一章了。');
    return;
  }
  const target = pathOn(next, around.side);
  if (!target) {
    toast(`${next.label}還沒有${SIDE_LABEL[around.side]}。`);
    return;
  }

  // 配對的那一份先發：它不搶焦點，這一塊的那一份後到也好、先到也好，當前的都是這一塊。
  const other = otherPane(pane);
  const pairSide = flipSide(around.side);
  const pair = pathOn(around.entry, pairSide);
  let note = '';
  if (other && pair && other.files.has(pair)) {
    const pairTarget = pathOn(next, pairSide);
    if (pairTarget) {
      open(other, pair, pairTarget, true);
    } else {
      note = `${next.label}還沒有${SIDE_LABEL[pairSide]}，旁邊那一份沒換。`;
    }
  }
  open(pane, file.path, target, false);
  if (note) {
    toast(note);
  }
}

/** 在這一塊裡從 `from` 換到 `to`：已經開著就切過去，否則請後端開啟（沒改過就原位換掉）。 */
function open(pane: Pane, from: string, to: string, background: boolean): void {
  if (paneOwning(to) === pane) {
    pane.activate(to, { focus: !background });
    return;
  }
  const old = pane.files.get(from);
  const clean = !!old && old.draft === old.text;
  if (background) {
    quiet.add(`${pane.id}:${to}`);
  }
  post({ type: 'openEditor', path: to, pane: pane.id, ...(clean ? { replace: from } : {}) });
}

/** 裝快捷鍵。焦點在編輯器之外的輸入框（對話輸入框之類）裡不攔。 */
export function installChapterNav(postMessage: (msg: InMessage) => void): void {
  post = postMessage;
  document.addEventListener('keydown', (e) => {
    if (isImeComposing(e) || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) {
      return;
    }
    if (e.key !== 'PageUp' && e.key !== 'PageDown') {
      return;
    }
    const focus = document.activeElement;
    const inEditor = !!focus?.closest?.('.wb-editors');
    const typing = focus instanceof HTMLInputElement || focus instanceof HTMLTextAreaElement || (focus as HTMLElement | null)?.isContentEditable;
    if (typing && !inEditor) {
      return;
    }
    if (!neighborsOf(activePane?.activeFile()?.path)) {
      return;
    }
    e.preventDefault();
    goChapter(e.key === 'PageUp' ? -1 : 1);
  });
}
