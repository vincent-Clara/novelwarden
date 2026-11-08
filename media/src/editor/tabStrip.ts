/**
 * 標籤條：一行能橫著滾的標籤，末尾一顆「▾」。
 *
 * - **滾輪橫著滾**：標籤多了擠不下，標籤條本身沒有豎向可滾的東西，豎著撥滾輪就當橫著滾
 *   （觸控板的橫向撥動原樣認）。
 * - **當前那個自動滾進視野**：每次重畫標籤之後，啟用的那個不在視野裡就滾到剛好露出來。重畫之前的
 *   滾動位置先留住——整排換掉 DOM 那一下瀏覽器會把它歸零，不留的話點一下別的標籤整排就跳回開頭。
 * - **「▾」**：兩塊編輯區裡開著的全部檔案（按塊分組、標出哪個沒儲存、哪個是當前的；特殊標籤「敘事線總覽」排在每塊前面），點了切過去；
 *   底下是最近關掉的幾個，點了重新開啟。彈的是 view 的那個選單引擎（`showMenuAt`），與右鍵選單
 *   同一種樣子、同時只有一個。
 *
 * DOM 由這裡現造進每塊編輯區的 `.ed-tabs`（`page.ts` 與 `createPaneElements` 裡只有那個空容器）：
 * `.ed-tabs-list` 放標籤，`.ed-tabs-more` 是「▾」。
 */
import { el } from '../dom';
import { showMenuAt } from '../globals';
import type { MenuItem } from '../globals';
import { tabNames } from './tabLabels';
import type { TabName } from './tabLabels';
import type { PaneId } from './paneElements';
import { activePane, allOpenFiles, panes, recentClosed, reopenClosed, specialTabOf } from './store';

/** 兩塊編輯區在介面上的叫法。 */
export const PANE_LABEL: Record<PaneId, string> = { main: '左側', draft: '右側' };

export interface TabStrip {
  /** 放標籤的那一格（會橫著滾）。 */
  list: HTMLElement;
  /** 整排換掉標籤之前調：留住滾動位置。 */
  beforeRender(): number;
  /** 換完之後調：放回滾動位置，再把當前那個滾進視野。 */
  afterRender(scrollLeft: number, active: HTMLElement | null): void;
}

export function createTabStrip(container: HTMLElement): TabStrip {
  const list = el('div', 'ed-tabs-list');
  const more = el('button', 'ed-tabs-more', '▾');
  more.type = 'button';
  more.title = '開啟的檔案（兩塊編輯區）與最近關閉';
  container.replaceChildren(list, more);

  list.addEventListener(
    'wheel',
    (e) => {
      const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (!delta) {
        return;
      }
      // deltaMode：0 畫素、1 行、2 頁。
      const px = e.deltaMode === 1 ? delta * 16 : e.deltaMode === 2 ? delta * (list.clientWidth || 200) : delta;
      list.scrollLeft += px;
      e.preventDefault();
    },
    { passive: false }
  );

  /** 選單開著時再點「▾」：讓這一下點選冒到 document 上去收起它。 */
  let menu: HTMLElement | undefined;
  more.addEventListener('click', (e) => {
    if (menu?.isConnected) {
      menu = undefined;
      return;
    }
    e.stopPropagation();
    const rect = more.getBoundingClientRect();
    menu = showMenuAt(openFilesMenu(), rect.left, rect.bottom);
  });

  return {
    list,
    beforeRender: () => list.scrollLeft,
    afterRender(scrollLeft, active) {
      list.scrollLeft = scrollLeft;
      if (active) {
        scrollIntoView(list, active);
      }
    },
  };
}

/** 當前那個標籤不在視野裡就滾到剛好露出來（左邊藏著貼左、右邊藏著貼右）。 */
function scrollIntoView(list: HTMLElement, tab: HTMLElement): void {
  const left = tab.offsetLeft;
  const right = left + tab.offsetWidth;
  const width = list.clientWidth;
  if (left < list.scrollLeft) {
    list.scrollLeft = left;
  } else if (width > 0 && right > list.scrollLeft + width) {
    list.scrollLeft = right - width;
  }
}

/** 標籤上寫的那幾個字（「▾」列表、右鍵選單、對話方塊裡都這麼稱呼它）。 */
export function tabText(name: TabName): string {
  return `${name.tag ? `${name.tag} ` : ''}${name.title}${name.desc ? ` · ${name.desc}` : ''}`;
}

/** 「▾」列表：兩塊編輯區裡開著的檔案按塊分組，底下是最近關掉的幾個。 */
function openFilesMenu(): MenuItem[] {
  const names = tabNames(allOpenFiles());
  const items: MenuItem[] = [];
  const open = (['main', 'draft'] as const)
    .map((id) => panes[id])
    .filter((p) => !!p && (p.files.size > 0 || p.specials.length > 0));
  for (const pane of open) {
    items.push({ label: `${PANE_LABEL[pane!.id]}編輯區`, disabled: true });
    // 特殊標籤（敘事線總覽）排在前面，與標籤條上一樣。
    for (const id of pane!.specials) {
      const spec = specialTabOf(id);
      if (spec) {
        const current = pane === activePane && pane!.activeSpecial() === id;
        items.push({ label: `${current ? '› ' : '　 '}${spec.label().title}`, run: () => pane!.openSpecial(id) });
      }
    }
    for (const file of pane!.files.values()) {
      const dirty = file.draft !== file.text;
      const current = pane === activePane && pane!.activePath === file.path;
      const mark = dirty ? '● ' : current ? '› ' : '　 ';
      items.push({
        label: `${mark}${tabText(names.get(file.path)!)}${dirty ? '（未儲存）' : ''}`,
        // activate 自己會認下這一塊、廣播「正在編輯哪個檔案」。
        run: () => pane!.activate(file.path),
      });
    }
  }
  const closed = recentClosed();
  if (closed.length > 0) {
    items.push({ sep: true }, { label: '最近關閉', disabled: true });
    for (const entry of closed) {
      items.push({ label: `　 ${entry.title} · ${PANE_LABEL[entry.pane]}`, run: () => reopenClosed(entry) });
    }
  }
  return items;
}
