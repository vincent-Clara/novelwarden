/**
 * 工作臺外殼裡歸編輯器管的那幾件事：主題切換、兩條分隔條的寬度拖拽、
 * 窄屏下把編輯區翻上來。
 *
 * 都只在獨立版存在（外掛形態由 VS Code 自己負責這些），所以放在 editor 下面
 * 而不是共用層。
 */
import { byId } from '../dom';
import { narrowScreen } from '../narrow';

const THEME_KEY = 'novelforge.theme';
const WIDTH_KEY = 'novelforge.sideWidth';
const DRAFT_WIDTH_KEY = 'novelforge.draftWidth';

const DEFAULT_SIDE_WIDTH = 460;
const DEFAULT_DRAFT_WIDTH = 420;

export interface Shell {
  themeBtn: HTMLElement;
  side: HTMLElement;
  resizer: HTMLElement;
  editors: HTMLElement;
  draftResizer: HTMLElement;
}

export function collectShell(): Shell {
  return {
    themeBtn: byId('wbThemeBtn'),
    side: byId('wbSide'),
    resizer: byId('wbResizer'),
    editors: byId('wbEditors'),
    draftResizer: byId('wbDraftResizer'),
  };
}

// ---------------------------------------------------------------- 主題

/**
 * 三套主題：深色、淺色、護眼（米黃）。切換隻有這一條路——`<html data-theme>` 換值，`css/standalone/theme.css`
 * 裡每套一組變數；記在 localStorage `novelforge.theme`（從前就在那兒，不併進編輯器偏好）。標題欄那顆按鈕按
 * 深色 → 淺色 → 護眼 → 深色輪著換，外觀面板（`lookPanel.ts`）裡可以直接挑。護眼管整個介面，不只編輯區（⚑）：
 * 一半米黃一半深色，交界處更刺眼。
 */
export type Theme = 'dark' | 'light' | 'sepia';

export const THEMES: readonly Theme[] = ['dark', 'light', 'sepia'];

export const THEME_LABEL: Record<Theme, string> = { dark: '深色', light: '淺色', sepia: '護眼（米黃）' };

/** 按鈕上畫的是**下一套**的樣子（與從前「深色時畫 ☀」一致）。 */
const THEME_ICON: Record<Theme, string> = { dark: '☾', light: '☀', sepia: '◐' };

let themeBtn: HTMLElement | undefined;

function isTheme(value: unknown): value is Theme {
  return (THEMES as readonly unknown[]).includes(value);
}

function nextTheme(theme: Theme): Theme {
  return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
}

export function currentTheme(): Theme {
  const value = document.documentElement.dataset.theme;
  return isTheme(value) ? value : 'dark';
}

/**
 * `<meta name="theme-color">` 跟著換成標題欄的底色（標題欄與底欄同色）：手機瀏覽器的位址列、
 * Android 殼的系統欄都按它染（殼那邊見 `src/shells/android/…/MainActivity.java` 的 THEME_HOOK）。
 */
function syncThemeColor(): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  const color = getComputedStyle(document.documentElement).getPropertyValue('--nf-titlebar-background').trim();
  if (meta && color) {
    meta.content = color;
  }
}

/** 換主題並記下來。 */
export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  syncThemeColor();
  if (themeBtn) {
    const next = nextTheme(theme);
    themeBtn.textContent = THEME_ICON[next];
    themeBtn.title = `切換到${THEME_LABEL[next]}主題`;
  }
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* 存不下就只在本次會話生效 */
  }
}

export function initTheme(shell: Shell): void {
  themeBtn = shell.themeBtn;
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    /* 讀不到就跟隨系統 */
  }
  const prefersLight = window.matchMedia?.('(prefers-color-scheme: light)').matches;
  setTheme(isTheme(saved) ? saved : prefersLight ? 'light' : 'dark');

  shell.themeBtn.addEventListener('click', () => setTheme(nextTheme(currentTheme())));
}

// ---------------------------------------------------------------- 拖拽調寬

/** 兩條分隔條共用一套指標拖拽：區別只在「拖到哪算多寬」。 */
function makeResizer(
  handle: HTMLElement,
  onDrag: (e: PointerEvent) => void,
  onCommit: () => void,
  onReset: () => void
): void {
  let dragging = false;
  const stop = () => {
    if (!dragging) {
      return;
    }
    dragging = false;
    handle.classList.remove('dragging');
    document.body.classList.remove('resizing');
    onCommit();
  };

  handle.addEventListener('pointerdown', (e) => {
    dragging = true;
    handle.classList.add('dragging');
    document.body.classList.add('resizing');
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (dragging) {
      onDrag(e);
    }
  });
  handle.addEventListener('pointerup', stop);
  handle.addEventListener('pointercancel', stop);
  handle.addEventListener('dblclick', onReset);
}

function readStoredNumber(key: string): number {
  try {
    return Number(localStorage.getItem(key)) || 0;
  } catch {
    return 0;
  }
}

function storeNumber(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* 存不下就只在本次會話生效 */
  }
}

export function initResizers(shell: Shell): void {
  let sideWidth = DEFAULT_SIDE_WIDTH;
  let draftWidth = DEFAULT_DRAFT_WIDTH;

  // 兩側都留出可用空間，別讓誰被拖沒。
  const setSideWidth = (px: number) => {
    sideWidth = Math.max(300, Math.min(px, Math.max(320, window.innerWidth - 360)));
    // 寫變數不寫 width：行內的 width 壓得過窄屏那條 `width: auto`，桌面上拖寬過的人把視窗縮窄（或分屏）時，
    // 側欄會頂著幾百畫素的寬度把整頁撐出橫向滾動。
    shell.side.style.setProperty('--nf-side-width', `${sideWidth}px`);
  };
  const setDraftWidth = (px: number) => {
    draftWidth = Math.max(240, Math.min(px, Math.max(260, window.innerWidth - 640)));
    shell.editors.style.setProperty('--nf-draft-width', `${draftWidth}px`);
  };

  const savedSide = readStoredNumber(WIDTH_KEY);
  if (savedSide) {
    setSideWidth(savedSide);
  }
  setDraftWidth(readStoredNumber(DRAFT_WIDTH_KEY) || DEFAULT_DRAFT_WIDTH);

  makeResizer(
    shell.resizer,
    (e) => {
      // 左邊還有一條 62px 的活動欄，拖拽位置要把它減掉。
      const bar = document.getElementById('tabbar');
      const offset = bar ? bar.getBoundingClientRect().right : 0;
      setSideWidth(e.clientX - offset);
    },
    () => storeNumber(WIDTH_KEY, sideWidth),
    () => setSideWidth(DEFAULT_SIDE_WIDTH)
  );

  makeResizer(
    shell.draftResizer,
    // 草稿區在分隔條右邊：往右拖是把它壓窄。
    (e) => setDraftWidth(shell.editors.getBoundingClientRect().right - e.clientX),
    () => storeNumber(DRAFT_WIDTH_KEY, draftWidth),
    () => setDraftWidth(DEFAULT_DRAFT_WIDTH)
  );
}

// ---------------------------------------------------------------- 窄屏

/** 窄屏：編輯區是蓋在側欄上的一層，底欄「正文」翻它上來（view/mobileNav.ts），草稿區不顯示。 */
export const isNarrow = narrowScreen;

/** 窄屏下編輯區是覆蓋層，開啟檔案時得把它翻上來。 */
export function revealEditor(): void {
  if (isNarrow()) {
    document.body.classList.add('editor-open');
  }
}

/** 窄屏下要看側欄（編輯區工具欄「歷史」切到「版本」頁）：把編輯區翻下去。 */
export function revealSide(): void {
  document.body.classList.remove('editor-open');
}
