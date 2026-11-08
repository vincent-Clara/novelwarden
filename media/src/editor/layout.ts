/**
 * 一鍵排版與半形標點轉全形（只對正文）。排什麼樣由 core 的純函式說了算（`model/paragraphFormat.ts` 的
 * `layoutProse` / `fullWidthPunct`），這裡只管：處理哪一段、交給 `Pane.applyEdit`（一步撤銷）、游標落回哪、
 * 報一句改了幾處。
 *
 * - **範圍**：有選區只處理選區碰到的那幾行（排版時再收到首尾的非空行上，免得把選區邊上的段間隔吃掉），
 *   否則整份。
 * - **入口**：工具欄「排版」按鈕（只對正文顯示，挨著「預覽」）；標題欄「編輯 → 一鍵排版 / 半形標點轉全形」
 *   （`nf-paragraph-command`）。
 *
 * 「排版」按鈕不寫進 `page.ts` / `createPaneElements`：它只對正文出現，顯隱跟著當前檔案走，由這裡在每塊
 * 編輯區第一次重畫時插到「預覽」後面——兩塊編輯區（主區與草稿區）走同一條路，pane.ts 不必知道它。
 */
import { el } from '../dom';
import { toast } from '../globals';
import { fullWidthPunct, layoutProse } from '../protocol';
import { isProse, onEditorChange } from './api';
import type { EditorContext, Pane } from './api';
import type { TextSelection } from './history';
import { touchedLines } from './lines';
import { paragraphStyle } from './paragraphState';

/** 選區碰到的那幾行的範圍 `[from, to)`：第一行行首到最後一行行尾（不含換行）。 */
function lineSpan(value: string, sel: TextSelection): { from: number; to: number } {
  const { first, last } = touchedLines(value, sel);
  const lines = value.split('\n');
  let from = 0;
  for (let i = 0; i < first; i++) {
    from += lines[i].length + 1;
  }
  let to = from;
  for (let i = first; i <= last; i++) {
    to += lines[i].length + (i < last ? 1 : 0);
  }
  return { from, to };
}

/** 排版的範圍：選區碰到的那幾行，首尾的空行收掉。全是空行時 undefined。 */
export function layoutSpan(value: string, sel: TextSelection): { from: number; to: number } | undefined {
  const span = lineSpan(value, sel);
  const text = value.slice(span.from, span.to);
  const lead = /^\s*/.exec(text)![0];
  if (lead.length === text.length) {
    return undefined;
  }
  // 收到第一個非空行的行首、最後一個非空行的行尾。
  const from = span.from + (lead.lastIndexOf('\n') + 1);
  const trail = /\s*$/.exec(text)![0];
  const nl = trail.indexOf('\n');
  const to = span.to - (nl === -1 ? 0 : trail.length - nl);
  return { from, to };
}

/** 游標在第幾段（非空行，從 0 數）的第幾個字（去掉段首空白之後）。落在空行上算下一段的開頭。 */
function blockPosition(text: string, caret: number): { index: number; offset: number } {
  let index = 0;
  let pos = 0;
  for (const line of text.split('\n')) {
    const end = pos + line.length;
    if (line.trim() !== '') {
      if (caret <= end) {
        const lead = /^\s*/.exec(line)![0].length;
        return { index, offset: Math.max(0, Math.min(caret - pos - lead, line.trim().length)) };
      }
      index++;
    } else if (caret <= end) {
      return { index, offset: 0 };
    }
    pos = end + 1;
  }
  return { index, offset: 0 };
}

/** 第 `index` 段第 `offset` 個字在 `text` 裡的位置。段數不夠時落在文末。 */
function positionOfBlock(text: string, index: number, offset: number): number {
  let n = 0;
  let pos = 0;
  for (const line of text.split('\n')) {
    if (line.trim() !== '') {
      if (n === index) {
        const lead = /^\s*/.exec(line)![0].length;
        return pos + lead + Math.min(offset, line.trim().length);
      }
      n++;
    }
    pos += line.length + 1;
  }
  return text.length;
}

/** 一鍵排版（規則見 `layoutProse`）。 */
export function formatProseIn({ pane, file, area }: EditorContext): void {
  if (!isProse(file)) {
    toast('一鍵排版只對正文（章節與草稿）有用。', true);
    return;
  }
  const value = area.value;
  const sel = { start: area.selectionStart, end: area.selectionEnd };
  const style = paragraphStyle();
  if (sel.start !== sel.end) {
    const span = layoutSpan(value, sel);
    if (!span) {
      toast('選中的都是空行，沒有可排的。');
      return;
    }
    const old = value.slice(span.from, span.to);
    const res = layoutProse(old, style, { fragment: true });
    finish(res.text === old, res.changes, () =>
      pane.applyEdit(span.from, span.to, res.text, { start: span.from, end: span.from + res.text.length })
    );
    return;
  }
  const res = layoutProse(value, style);
  const at = blockPosition(value, sel.start);
  const caret = positionOfBlock(res.text, at.index, at.offset);
  finish(res.text === value, res.changes, () =>
    pane.applyEdit(0, value.length, res.text, { start: caret, end: caret })
  );
}

function finish(same: boolean, changes: number, apply: () => void): void {
  if (same) {
    toast('已經是這個格式了');
    return;
  }
  apply();
  toast(`排版完成，改了 ${Math.max(1, changes)} 處`);
}

/** 半形標點轉全形（規則見 `fullWidthPunct`）。 */
export function fullWidthIn({ pane, file, area }: EditorContext): void {
  if (!isProse(file)) {
    toast('半形標點轉全形只對正文（章節與草稿）有用。', true);
    return;
  }
  const value = area.value;
  const sel = { start: area.selectionStart, end: area.selectionEnd };
  const span = sel.start !== sel.end ? lineSpan(value, sel) : undefined;
  const res = fullWidthPunct(value, span ? { range: { start: span.from, end: span.to } } : {});
  if (res.changes === 0) {
    toast('沒有要轉的半形標點。');
    return;
  }
  /** 原文裡的位置挪到新文字裡：之前的每一處替換帶來的長短差都算上。 */
  const map = (p: number) =>
    p + res.edits.filter((e) => e.at + e.from.length <= p).reduce((n, e) => n + e.to.length - e.from.length, 0);
  const selection = span ? { start: map(span.from), end: map(span.to) } : { start: map(sel.start), end: map(sel.start) };
  pane.applyEdit(0, value.length, res.text, selection);
  toast(`半形標點轉全形：改了 ${res.changes} 處`);
}

/** 工具欄「排版」按鈕：每塊編輯區一顆，第一次重畫時插到「預覽」後面，只對正文顯示。 */
export function installLayoutButton(): void {
  const buttons = new WeakMap<Pane, HTMLButtonElement>();
  onEditorChange((ev) => {
    if (ev.type !== 'render') {
      return;
    }
    const pane = ev.pane;
    let btn = buttons.get(pane);
    if (!btn) {
      const toolbar = pane.root.querySelector<HTMLElement>('.ed-toolbar');
      if (!toolbar) {
        return;
      }
      btn = el('button', 'chip-btn ed-format-btn', '排版');
      btn.type = 'button';
      btn.title = '一鍵排版：按工程的分段格式重排正文（有選區只排選中的那幾行）';
      btn.addEventListener('click', () => {
        const file = pane.activeFile();
        if (file) {
          formatProseIn({ pane, file, area: pane.area });
        }
      });
      // 「預覽」緊跟在路徑後面（page.ts 與 createPaneElements 同一個順序）。
      const preview = toolbar.querySelector('.ed-path')?.nextElementSibling ?? null;
      toolbar.insertBefore(btn, preview ? preview.nextSibling : toolbar.firstChild);
      buttons.set(pane, btn);
    }
    btn.classList.toggle('hidden', !isProse(pane.activeFile()));
  });
}
