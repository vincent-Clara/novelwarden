/**
 * 窄屏上編輯區頂上只留兩行：標籤條與章節條（樣式在 narrow.css）。
 *
 * - 工具欄那一行收起，它的按鈕挪進標籤條末尾的「⋯」，外加一項「補全名詞」（電腦上是 Alt+/）；
 *   「⋯」前面單留「↶」「↷」「儲存」三顆（手機鍵盤上沒有 Ctrl+Z / Ctrl+S，自動儲存預設關）。
 *   這三顆按下去不奪焦點：正在打字時點了，軟鍵盤不收、游標還在原處。
 * - 章節條底下那一排動作（寫這一章、接著寫……）收進條上的「操作 ▾」（`chapterBar.ts` 掛）。
 *
 * 選單項照著那幾顆按鈕現列：字、亮滅跟著按鈕走，點了就是點那顆按鈕——按鈕以後增減、改名不用改這裡。
 * 寬屏上這幾顆不顯示，工具欄照舊。
 */
import { el } from '../dom';
import { commandNames, showMenuAt } from '../globals';
import type { MenuItem } from '../globals';
import { touchDevice } from '../touch';
import { onEditorChange } from './api';
import type { PaneRefs } from './paneElements';
import type { Pane } from './store';

/** 一組按鈕列成選單：藏著的不列，置灰的照樣置灰。選單上要多寫幾個字（呼叫次數）的按鈕帶 `data-menu-label`。 */
export function menuFromButtons(buttons: Iterable<HTMLButtonElement>): MenuItem[] {
  const items: MenuItem[] = [];
  for (const b of buttons) {
    if (b.classList.contains('hidden') || b.hidden) {
      continue;
    }
    items.push({ label: b.dataset.menuLabel ?? b.textContent ?? '', disabled: b.disabled, run: () => b.click() });
  }
  return items;
}

/**
 * 在 `anchor` 底下彈選單；選單開著時再點它就收起（這一下點選冒到 document 上去收，與標籤條的「▾」一樣）。
 * 返回裝好監聽的按鈕。
 */
export function menuButton(anchor: HTMLButtonElement, items: () => MenuItem[]): HTMLButtonElement {
  let menu: HTMLElement | undefined;
  anchor.addEventListener('click', (e) => {
    if (menu?.isConnected) {
      menu = undefined;
      return;
    }
    e.stopPropagation();
    const rect = anchor.getBoundingClientRect();
    menu = showMenuAt(items(), rect.right, rect.bottom);
  });
  return anchor;
}

/** 按下去不奪焦點的按鈕（正在打字時點了，軟鍵盤不收）。 */
function keepFocus(btn: HTMLButtonElement): HTMLButtonElement {
  btn.type = 'button';
  for (const type of ['pointerdown', 'mousedown'] as const) {
    btn.addEventListener(type, (e) => e.preventDefault());
  }
  return btn;
}

/** 標籤條末尾的「↶」「↷」「儲存」與「⋯」。 */
export function installNarrowTools(refs: PaneRefs, pane: Pane): void {
  const undo = keepFocus(el('button', 'ed-tabs-icon ed-tabs-undo', '↶'));
  undo.title = '撤銷';
  undo.setAttribute('aria-label', '撤銷');
  undo.addEventListener('click', () => pane.undo());
  const redo = keepFocus(el('button', 'ed-tabs-icon ed-tabs-redo', '↷'));
  redo.title = '重做';
  redo.setAttribute('aria-label', '重做');
  redo.addEventListener('click', () => pane.redo());
  // 能不能撤銷看當前那份檔案自己的記錄：打字、撤銷、切檔案之後都對一次。
  const syncHistory = () => {
    const history = pane.activeFile()?.history;
    undo.disabled = !history?.canUndo;
    redo.disabled = !history?.canRedo;
  };
  onEditorChange((ev) => {
    if (ev.pane === pane) {
      syncHistory();
    }
  });

  const save = keepFocus(el('button', 'primary ed-tabs-save', '儲存'));
  save.addEventListener('click', () => refs.saveBtn.click());

  const tools = el('button', 'ed-tabs-tools', '⋯');
  tools.type = 'button';
  tools.title = '預覽、細綱、草稿、還原、歷史……';
  menuButton(tools, () => {
    // 「外部開啟」用的是服務端那臺機器上的程式，手機、平板上點了沒反應。
    const skip = new Set<HTMLElement>([refs.saveBtn, ...(touchDevice() ? [refs.externalBtn] : [])]);
    // 只認工具欄直屬的按鈕：麵包屑（.ed-path）裡的目錄段也是按鈕，點了是「在檔案頁中定位」。
    const buttons = menuFromButtons([...refs.toolbar.querySelectorAll<HTMLButtonElement>(':scope > button')].filter((b) => !skip.has(b)));
    // 補全名詞：放回游標、在游標處彈候選（與 Alt+/、「檢視 → 名詞補全」同一條路，不歸這一類檔案時它自己說一句）。
    return [...buttons, { sep: true }, { label: '補全名詞', run: () => commandNames('trigger') }];
  });

  // 跟著工具欄：沒有檔案（只開著敘事線總覽之類）時工具欄藏著，這幾顆也藏；「儲存」亮滅跟著工具欄上那顆。
  const sync = () => {
    const off = refs.toolbar.classList.contains('hidden');
    for (const btn of [undo, redo, save, tools]) {
      btn.classList.toggle('hidden', off);
    }
    save.disabled = refs.saveBtn.disabled;
    syncHistory();
  };
  new MutationObserver(sync).observe(refs.toolbar, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(sync).observe(refs.saveBtn, { attributes: true, attributeFilter: ['disabled'] });
  sync();
  refs.tabs.append(undo, redo, save, tools);
}
