/**
 * 工具欄上的路徑：麵包屑「細綱 › 第一卷 › 第 3 章 夜訪」。
 *
 * 稱呼由後端算（`EditorFileView.label.crumbs`，`views/editorLabel.ts`），前端不拿路徑猜。原始相對路徑掛在
 * 懸停提示上。帶 `dir` 的段是目錄：點了在「檔案」頁定位到它（`nf-reveal-in-files`，資源管理器自己展開、
 * view 切頁籤——編輯器不碰它們的狀態）。
 *
 * **章節那一段的標題優先取章節索引**（`chapterIndex.ts`，後端的 `chapterIndex` 訊息）：`editorLabel` 是純函式、
 * 不讀盤，只能拿檔名裡的那一段；而有正文的章改了標題，檔名是不動的（第 7 條）——那時章節條、「轉到…」、
 * 工程頁說的都是新標題，麵包屑不該還寫舊的。索引裡沒有這一份（還沒收到、不是正文或細綱）時照後端給的寫；
 * 索引變了重畫一遍。標籤上仍寫檔名（它說的是這個檔案）。
 *
 * 太長時**前面的段先省略**，最後一段（這份檔案）最後才讓：從前用 `direction: rtl` 做左側省略，
 * `.novelwarden/…` 開頭的路徑會把那個點號排到末尾去。
 *
 * 後端沒給稱呼（沒開啟工程）時只寫原始路徑，一段，不能點。
 */
import { el } from '../dom';
import { revealInFiles } from '../globals';
import type { EditorCrumb } from '../protocol';
import { chapterAt, onChapterIndex } from './chapterIndex';
import type { OpenFile } from './paneElements';

/** 畫過麵包屑的那幾格（兩塊編輯區各一格）與當時那份檔案：章節索引變了重畫。 */
const shown = new Map<HTMLElement, OpenFile>();

onChapterIndex(() => {
  for (const [target, file] of shown) {
    if (target.isConnected) {
      renderBreadcrumb(target, file);
    }
  }
});

export function renderBreadcrumb(target: HTMLElement, file: OpenFile): void {
  shown.set(target, file);
  target.replaceChildren();
  target.title = file.path;
  const crumbs = file.label?.crumbs ?? [{ label: file.path }];
  crumbs.forEach((crumb, i) => {
    if (i > 0) {
      target.appendChild(el('span', 'ed-crumb-sep', '›'));
    }
    const last = i === crumbs.length - 1;
    if (crumb.dir !== undefined && !last) {
      const dir = crumb.dir;
      const btn = el('button', 'ed-crumb ed-crumb-dir', crumb.label);
      btn.type = 'button';
      btn.title = `在「檔案」頁定位到 ${dir || '工程根目錄'}`;
      btn.addEventListener('click', () => revealInFiles(dir, true));
      target.appendChild(btn);
    } else {
      target.appendChild(el('span', last ? 'ed-crumb ed-crumb-file' : 'ed-crumb', last ? leafOf(file, crumb) : crumb.label));
    }
  });
}

/** 最後一段：這份檔案是某一章的正文或細綱、索引裡有標題時寫「第 N 章 標題」，否則照後端給的。 */
function leafOf(file: OpenFile, crumb: EditorCrumb): string {
  if (!file.label) {
    return crumb.label;
  }
  const at = chapterAt(file.path);
  const title = at?.entry.title.trim();
  return at && title ? `第 ${at.entry.no} 章 ${title}` : crumb.label;
}
