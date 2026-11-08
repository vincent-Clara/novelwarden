/**
 * 獨立版標題欄「檔案 / 編輯 / 檢視 / 幫助」。沒有 `#wbMenubar` 就直接 return（外掛）。
 * 窄屏上這一排藏起來（narrow.css），標題欄右端的「⋯」先列這四個，點一個換成它的下拉、仍貼著「⋯」。
 *
 * 不復用右鍵選單引擎：缺懸停切選單和子選單。
 */
import { el as mk } from '../dom';
import { matchesShortcut, shortcutLabel } from '../editor/shortcuts';
import { commandEditor, queryEditor } from '../globals';
import { versionsMenuEntry } from './versionsMenu';
import { openCheckpoints } from './checkpoints';
import { quickOpenMenuEntry } from './quickOpenMenu';
import { bookFindMenuEntry } from './bookFindMenu';
import {
  closeFolder,
  hideAbout,
  hideWelcome,
  openRecent,
  requestImportBook,
  requestNewProject,
  requestOpenFile,
  requestOpenFolder,
  showAbout,
  showWelcome,
} from './welcome';
import { hasWorkspace, store, vscode } from './store';
import { placeNear, visibleArea } from './menuPlace';
import type { Placement } from './menuPlace';
import { lastPointerWasTouch, touchDevice, trackPointer } from '../touch';
import { paragraphMenuEntries } from './paragraphMenu';
import { shortcutsMenuEntry } from './shortcutsMenu';
import { viewMenuEntries } from './viewMenu';

type MenuAction = string;

export interface MenuEntry {
  label: string;
  action?: MenuAction;
  disabled?: boolean;
  kbd?: string;
  submenu?: SubEntry[];
  /** 可勾選的項：給了就在左邊畫 ✓（true）或留空（false）。 */
  checked?: boolean;
  /** 點了做什麼。給了就不走 `action` 那張表（功能模組自帶的項用它，不必往 `run` 里加分支）。 */
  run?: () => void;
  /** 懸停提示（置灰時說為什麼）。 */
  detail?: string;
  /** 點了換成另一個選單的下拉（窄屏「⋯」裡的檔案 / 編輯 / 檢視 / 幫助），貼著同一顆按鈕。 */
  menu?: string;
}

export interface SubEntry {
  label: string;
  detail?: string;
  action?: MenuAction;
  arg?: string;
  disabled?: boolean;
  checked?: boolean;
  run?: () => void;
}

let openKey: string | null = null;
let drop: HTMLElement | undefined;
let subDrop: HTMLElement | undefined;
/** 開著的下拉貼著的那顆按鈕（選單欄上的一個，或窄屏的「⋯」）。 */
let anchor: HTMLElement | undefined;

/** 窄屏「⋯」先列的那一層。 */
const MORE_KEY = 'more';

export function installMenubar(): void {
  const bar = document.getElementById('wbMenubar');
  if (!bar) {
    return;
  }
  trackPointer();

  // 點選單不搶焦點：「編輯」裡的撤銷 / 剪下 / 貼上作用於點選單之前游標所在的那個輸入框，
  // 按鈕在 mousedown 時把焦點拿走的話（Chromium 會），那幾項就一律置灰、也沒處可作用。
  bar.addEventListener('mousedown', keepFocus);

  bar.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>('.wb-menu-btn');
    if (!btn?.dataset.menu) {
      return;
    }
    e.stopPropagation();
    if (openKey === btn.dataset.menu) {
      closeMenubar();
      return;
    }
    openMenu(btn.dataset.menu, btn);
  });

  const more = document.getElementById('wbMoreBtn');
  more?.addEventListener('mousedown', keepFocus);
  more?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (openKey !== null && anchor === more) {
      closeMenubar();
      return;
    }
    openMenu(MORE_KEY, more);
  });

  // 已經開著一個選單時移到別的選單按鈕上就換過去。手指點別的按鈕之前補發的 mouseover 不算：
  // 不然先換過去、緊接著的 click 又看見「點的正是開著的那個」就把它關了——手指想換選單卻全關掉。
  bar.addEventListener('mouseover', (e) => {
    if (!openKey || lastPointerWasTouch()) {
      return;
    }
    const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>('.wb-menu-btn');
    if (!btn?.dataset.menu || btn.dataset.menu === openKey) {
      return;
    }
    openMenu(btn.dataset.menu, btn);
  });

  document.addEventListener('click', () => closeMenubar());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeMenubar();
      hideWelcome();
      hideAbout();
    }
    // 鍵登記在 editor/shortcuts.ts（Ctrl+N 在瀏覽器裡多半攔不住，那一條上寫著）。組字中途的是輸入法的。
    if (e.isComposing || e.keyCode === 229) {
      return;
    }
    if (matchesShortcut(e, 'openFolder')) {
      e.preventDefault();
      requestOpenFolder();
      closeMenubar();
    } else if (matchesShortcut(e, 'newFile')) {
      e.preventDefault();
      if (hasWorkspace()) {
        run('newFile');
      }
      closeMenubar();
    }
  });
}

function openMenu(key: string, btn: HTMLElement): void {
  closeMenubar();
  openKey = key;
  anchor = btn;
  btn.classList.add('open');
  // 功能模組自帶的項接在後面（「編輯」裡段落那一組，見 paragraphMenu.ts）。
  drop = buildDrop([...entriesOf(key), ...(key === 'edit' ? paragraphMenuEntries() : [])]);
  document.body.appendChild(drop);
  // 整個落在可視區裡（窄屏上「幫助」的下拉從前伸出右邊，見 menuPlace.ts）。
  place(drop, placeNear(btn.getBoundingClientRect(), drop.offsetWidth, drop.offsetHeight, visibleArea(), 'below'));
}

function place(menu: HTMLElement, at: Placement): void {
  menu.style.left = `${Math.round(at.left)}px`;
  menu.style.top = `${Math.round(at.top)}px`;
  if (at.maxHeight !== undefined) {
    menu.style.maxHeight = `${Math.floor(at.maxHeight)}px`;
  }
}

function closeMenubar(): void {
  openKey = null;
  drop?.remove();
  drop = undefined;
  subDrop?.remove();
  subDrop = undefined;
  anchor?.classList.remove('open');
  anchor = undefined;
  for (const btn of document.querySelectorAll('.wb-menu-btn.open')) {
    btn.classList.remove('open');
  }
}

function entriesOf(key: string): MenuEntry[] {
  const ws = hasWorkspace();
  const editing = isEditing();
  const ed = queryEditor();
  // 手機、平板上沒用的幾項不列（touch.ts 的 touchDevice）。
  const desktop = !touchDevice();
  if (key === MORE_KEY) {
    return [
      { label: '檔案', menu: 'file' },
      { label: '編輯', menu: 'edit' },
      { label: '檢視', menu: 'view' },
      { label: '幫助', menu: 'help' },
    ];
  }
  if (key === 'file') {
    return [
      { label: '新建檔案', action: 'newFile', disabled: !ws, kbd: shortcutLabel('newFile') },
      { label: '新建一本書…', action: 'newProject' },
      { label: '匯入寫好的書（txt）…', action: 'importBook' },
      { label: 'sep' },
      { label: '開啟檔案…', action: 'openFile', disabled: !ws },
      quickOpenMenuEntry(),
      { label: '開啟資料夾…', action: 'openFolder', kbd: shortcutLabel('openFolder') },
      { label: '開啟最近開啟的', submenu: recentEntries() },
      { label: 'sep' },
      { label: '儲存', action: 'save', disabled: !ed.dirtyCurrent, kbd: shortcutLabel('save') },
      { label: '另存為…', action: 'saveAs', disabled: !ed.hasFile },
      versionsMenuEntry(),
      // 整本書的存檔點（工程頁工具欄上那顆 ⚑ 的同一個彈窗）：那顆只是個圖示，這裡給它一個名字。
      {
        label: '存檔點…',
        disabled: !ws,
        detail: '整本書存一版、看之後改了哪幾份，整本或單份退回去',
        run: () => openCheckpoints(),
      },
      { label: '全部儲存', action: 'saveAll', disabled: !ed.dirtyAny },
      { label: '自動儲存', checked: ed.autoSave, run: () => commandEditor('toggleAutoSave') },
      { label: 'sep' },
      { label: '關閉編輯器', action: 'closeEditor', disabled: !ed.hasFile },
      { label: '關閉資料夾', action: 'closeFolder', disabled: !ws },
      ...(desktop ? [{ label: 'sep' }, { label: '退出', action: 'quit' }] : []),
    ];
  }
  if (key === 'view') {
    // 「檢視」整個由 viewMenu.ts 給（一組一個函式，之後的階段往裡加）。
    return viewMenuEntries();
  }
  if (key === 'edit') {
    return [
      { label: '撤銷', action: 'undo', disabled: !editing, kbd: shortcutLabel('undo') },
      { label: '重做', action: 'redo', disabled: !editing, kbd: shortcutLabel('redo') },
      { label: 'sep' },
      { label: '剪下', action: 'cut', disabled: !editing, kbd: shortcutLabel('cut') },
      { label: '複製', action: 'copy', disabled: !editing, kbd: shortcutLabel('copy') },
      { label: '貼上', action: 'paste', disabled: !editing, kbd: shortcutLabel('paste') },
      { label: 'sep' },
      { label: '全選', action: 'selectAll', disabled: !editing, kbd: shortcutLabel('selectAll') },
      { label: 'sep' },
      { label: '查詢', action: 'find', disabled: !ws, kbd: shortcutLabel('find') },
      { label: '替換', action: 'replace', disabled: !ws, kbd: shortcutLabel('replace') },
      bookFindMenuEntry(),
    ];
  }
  return [
    { label: '歡迎頁面', action: 'welcome' },
    { label: '使用說明', action: 'readme' },
    shortcutsMenuEntry(),
    ...(desktop ? [{ label: '開啟日誌目錄', action: 'openLogDir' }] : []),
    { label: 'sep' },
    { label: '關於', action: 'about' },
  ];
}

function recentEntries(): SubEntry[] {
  if (store.recents.length === 0) {
    return [{ label: '沒有最近開啟的工程', disabled: true }];
  }
  return store.recents.map((r) => ({
    label: r.name,
    detail: r.root,
    action: 'recent',
    arg: r.root,
  }));
}

function buildDrop(entries: MenuEntry[], submenu = false): HTMLElement {
  const menu = mk('div', submenu ? 'wb-menu-drop submenu' : 'wb-menu-drop');
  for (const entry of entries) {
    if (entry.label === 'sep') {
      menu.appendChild(mk('div', 'wb-menu-sep'));
      continue;
    }
    const btn = mk('button', 'wb-menu-item');
    btn.type = 'button';
    if (entry.disabled) {
      btn.disabled = true;
    }
    if (entry.detail) {
      btn.title = entry.detail;
    }
    addCheck(btn, entry.checked);
    btn.appendChild(mk('span', 'wb-menu-label', entry.label));
    if (entry.kbd) {
      btn.appendChild(mk('span', 'wb-menu-kbd', entry.kbd));
    } else if (entry.submenu || entry.menu) {
      btn.appendChild(mk('span', 'wb-menu-arrow', '›'));
    }
    if (entry.menu) {
      const key = entry.menu;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (anchor) {
          openMenu(key, anchor);
        }
      });
    } else if (entry.submenu) {
      // 置灰的子選單不展開（「段落格式」在沒開工程時就是這樣）。
      // 手指點之前補發的 mouseenter 不展開：窄屏上子選單會貼邊蓋住手指底下這一點，緊跟著的 click 就落到子選單的某一項上
      // （Android 實機上點「開啟最近開啟的」直接開啟了最近的第一本書）。手指靠下面的 click 展開。
      btn.addEventListener('mouseenter', () => {
        if (lastPointerWasTouch()) {
          return;
        }
        if (entry.disabled) {
          hideSubmenu();
        } else {
          showSubmenu(btn, entry.submenu!);
        }
      });
      // 點一下也展開：手指沒有「移上去」。
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!entry.disabled) {
          showSubmenu(btn, entry.submenu!);
        }
      });
    } else {
      btn.addEventListener('mouseenter', () => hideSubmenu());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (entry.disabled || (!entry.action && !entry.run)) {
          return;
        }
        if (entry.run) {
          entry.run();
        } else {
          run(entry.action!);
        }
        closeMenubar();
      });
    }
    menu.appendChild(btn);
  }
  menu.addEventListener('click', (e) => e.stopPropagation());
  menu.addEventListener('mousedown', keepFocus);
  return menu;
}

/** 可勾選的項在左邊距裡畫一個 ✓（沒勾時留空位），不擠動標籤，與不可勾選的項對齊。 */
function addCheck(btn: HTMLElement, checked: boolean | undefined): void {
  if (checked === undefined) {
    return;
  }
  btn.classList.add('checkable');
  btn.setAttribute('role', 'menuitemcheckbox');
  btn.setAttribute('aria-checked', String(checked));
  btn.appendChild(mk('span', 'wb-menu-check', checked ? '✓' : ''));
}

/** 選單按鈕與選單項上按下滑鼠時不奪走焦點（只攔預設動作，click 照常觸發）。 */
function keepFocus(e: MouseEvent): void {
  if ((e.target as HTMLElement | null)?.closest('.wb-menu-btn, .wb-menu-item')) {
    e.preventDefault();
  }
}

function showSubmenu(anchor: HTMLElement, entries: SubEntry[]): void {
  hideSubmenu();
  anchor.classList.add('open');
  subDrop = mk('div', 'wb-menu-drop submenu');
  for (const entry of entries) {
    const btn = mk('button', 'wb-menu-item');
    btn.type = 'button';
    if (entry.disabled) {
      btn.disabled = true;
    }
    addCheck(btn, entry.checked);
    const label = mk('span', 'wb-menu-label', entry.label);
    btn.appendChild(label);
    if (entry.detail) {
      btn.title = entry.detail;
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (entry.disabled) {
        return;
      }
      if (entry.run) {
        entry.run();
      } else if (entry.action === 'recent' && entry.arg) {
        openRecent(entry.arg);
      }
      closeMenubar();
    });
    subDrop.appendChild(btn);
  }
  subDrop.addEventListener('mousedown', keepFocus);
  document.body.appendChild(subDrop);
  // 父選單項右邊、頂對齊；右邊放不下翻到左邊，再不行就貼邊蓋住一點父選單（窄屏上從前直接伸出螢幕）。
  place(subDrop, placeNear(anchor.getBoundingClientRect(), subDrop.offsetWidth, subDrop.offsetHeight, visibleArea(), 'side'));
}

function hideSubmenu(): void {
  drop?.querySelectorAll('.wb-menu-item.open').forEach((n) => n.classList.remove('open'));
  subDrop?.remove();
  subDrop = undefined;
}

function run(action: MenuAction): void {
  switch (action) {
    case 'newFile':
      newFile();
      return;
    case 'newProject':
      requestNewProject();
      return;
    case 'importBook':
      requestImportBook();
      return;
    case 'openFile':
      requestOpenFile();
      return;
    case 'openFolder':
      requestOpenFolder();
      return;
    case 'save':
      commandEditor('save');
      return;
    case 'saveAs':
      saveAs();
      return;
    case 'saveAll':
      commandEditor('saveAll');
      return;
    case 'closeEditor':
      commandEditor('close');
      return;
    case 'closeFolder':
      closeFolder();
      return;
    case 'quit':
      window.close();
      return;
    case 'undo':
    case 'redo':
      // 焦點在內建編輯器的正文區：撤銷 / 重做是編輯器自己記的（每個檔案一份），不走瀏覽器原生的。
      if (queryEditor().areaFocused) {
        commandEditor(action === 'undo' ? 'undo' : 'redo');
        return;
      }
      document.execCommand(action);
      return;
    case 'cut':
    case 'copy':
    case 'paste':
    case 'selectAll':
      document.execCommand(action === 'selectAll' ? 'selectAll' : action);
      return;
    case 'find':
      commandEditor('find');
      return;
    case 'replace':
      commandEditor('replace');
      return;
    case 'welcome':
      showWelcome();
      return;
    case 'readme':
      vscode.postMessage({ type: 'openReadme' });
      return;
    case 'openLogDir':
      vscode.postMessage({ type: 'openLogDir' });
      return;
    case 'about':
      showAbout();
      return;
    default:
      return;
  }
}

function newFile(): void {
  if (!hasWorkspace()) {
    return;
  }
  const rel = window.prompt('工程內相對路徑（已存在則拒絕）', '');
  if (rel?.trim()) {
    vscode.postMessage({ type: 'createFile', relPath: rel.trim() });
  }
}

function saveAs(): void {
  const ed = queryEditor();
  if (!ed.hasFile) {
    return;
  }
  const rel = window.prompt('另存為（工程內相對路徑，不覆蓋已有）', '');
  if (!rel?.trim()) {
    return;
  }
  vscode.postMessage({ type: 'createFile', relPath: rel.trim(), text: ed.text });
}

function isEditing(): boolean {
  const node = document.activeElement;
  return node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement;
}
