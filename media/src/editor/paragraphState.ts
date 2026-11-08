/**
 * 段落那幾個功能（回車、成對符號、段落快捷鍵、一鍵排版）共用的兩樣狀態：
 *
 * - **分段格式**：工程級設定（`config.md` 的 `paragraphStyle`），後端說了算。從 `init` / `state`
 *   （`ViewState.paragraphStyle`，哪個頁籤都會推）與 `project`（工程樹，只在「工程」頁籤開著時推）裡取，
 *   沒收到之前按預設 `blank`。前端不改它——切換走標題欄「編輯 → 段落格式」發 `setParagraphStyle`，
 *   後端寫完 `pushState`，新值隨下一條 `state` 回來。
 * - **編輯器偏好**：按瀏覽器記、不進工程的開關，存 localStorage `novelforge.editor.prefs`（不按工程分鍵：
 *   這是作者的手感，不是這本書的設定）。三項：成對符號自動補全（預設開）、自動儲存（預設關，見
 *   `autosave.ts`）、單擊開啟為臨時標籤（預設開，標題欄「檢視」選單，見 `viewPrefs.ts`）。localStorage
 *   不可寫（隱私模式、jsdom 的 about:blank）時照樣在記憶體裡生效，只是重新整理後回到預設。
 *   同一個物件裡還平鋪著別的模組記的幾項——外觀與專注（`look.ts` / `focus.ts`，校驗在 `lookCore.ts`）、碼字統計的
 *   `stats` 子物件（`stats.ts`）。這裡不認識它們，但**誰寫都是讀出整份、合上自己那幾項再整份寫回**
 *   （`storedPrefs` / `setStoredPrefs`），誰也不沖掉誰；讀回來的壞值由各自的模組逐項回落預設。
 */
import { DEFAULT_PARAGRAPH_STYLE, isParagraphStyle } from '../protocol';
import type { ParagraphStyle } from '../protocol';
import { onMessage } from '../vscodeApi';

export const PREFS_KEY = 'novelforge.editor.prefs';

interface EditorPrefs {
  autoPair: boolean;
  autoSave: boolean;
  previewTabs: boolean;
}

let style: ParagraphStyle = DEFAULT_PARAGRAPH_STYLE;
/**
 * 整份偏好在記憶體裡的那一份（含這裡不認識的那幾項）。localStorage 讀得到時每次讀都以它為準（別的模組、別的視窗
 * 可能剛寫過）；讀不了 / 寫不進時（`storageOk` 落成 false）以記憶體裡這一份為準，照樣生效。
 * 這兩個要在 `loadPrefs()` 之前宣告：它會讀它們。
 */
let stored: Record<string, unknown> = {};
let storageOk = true;
let prefs: EditorPrefs = loadPrefs();
const prefListeners = new Set<() => void>();

/** 當前工程的分段格式。 */
export function paragraphStyle(): ParagraphStyle {
  return style;
}

/** 成對符號自動補全開著沒有。 */
export function autoPairEnabled(): boolean {
  return prefs.autoPair;
}

export function setAutoPair(on: boolean): void {
  setPref('autoPair', on);
}

/** 自動儲存開著沒有（預設關）。 */
export function autoSaveEnabled(): boolean {
  return prefs.autoSave;
}

export function setAutoSave(on: boolean): void {
  setPref('autoSave', on);
}

/** 單擊開啟為臨時標籤（預設開）。 */
export function previewTabsEnabled(): boolean {
  return prefs.previewTabs;
}

export function setPreviewTabs(on: boolean): void {
  setPref('previewTabs', on);
}

function setPref(key: keyof EditorPrefs, on: boolean): void {
  if (prefs[key] === on) {
    return;
  }
  prefs = { ...prefs, [key]: on };
  savePrefs();
  notifyPrefs();
}

function notifyPrefs(): void {
  for (const fn of [...prefListeners]) {
    fn();
  }
}

/**
 * `novelforge.editor.prefs` 現存的那一整份（不是物件就當空物件）。往這個鍵裡記東西的模組都先讀它、合上自己那幾項
 * 再整份寫回（這裡的 `setPref` / `setStoredPrefs`、碼字統計的 `stats.ts`）。各項的值原樣給，由各自的模組校驗。
 */
export function storedPrefs(): Readonly<Record<string, unknown>> {
  if (!storageOk) {
    return stored;
  }
  let text: string | null;
  try {
    text = localStorage.getItem(PREFS_KEY);
  } catch {
    // 讀不了（隱私模式、about:blank）：以記憶體裡那一份為準。
    storageOk = false;
    return stored;
  }
  let raw: unknown = null;
  try {
    raw = JSON.parse(text || 'null');
  } catch {
    /* 寫壞了（不是 JSON）：當沒記過，各項回落預設；下一次寫把它整份換掉 */
  }
  stored = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return stored;
}

/**
 * 往同一處寫幾項（外觀、專注），與上面三項一起整份寫回、一起通知訂閱者。值給 `undefined` 就是刪掉這一項
 * （回到預設）。上面三項不經這裡改。
 */
export function setStoredPrefs(patch: Record<string, unknown>): void {
  writeAll({ ...storedPrefs(), ...patch, ...prefs });
  notifyPrefs();
}

/** 偏好變了時通知（成對符號關掉時要丟掉手上記著的那幾對；自動儲存開關要重新整理狀態列）。 */
export function onPrefsChange(fn: () => void): () => void {
  prefListeners.add(fn);
  return () => prefListeners.delete(fn);
}

/** 跟著後端推來的 `ViewState` / 工程樹更新分段格式。啟動時裝一次。 */
export function trackParagraphStyle(): void {
  onMessage((msg) => {
    if (msg.type === 'init' || msg.type === 'state') {
      take(msg.state.paragraphStyle);
    } else if (msg.type === 'project') {
      take(msg.tree.paragraphStyle);
    }
  });
}

/** 舊後端推來的沒有這個欄位：留著原來的值，不回落。 */
function take(value: unknown): void {
  if (isParagraphStyle(value)) {
    style = value;
  }
}

function loadPrefs(): EditorPrefs {
  const raw = storedPrefs() as Partial<Record<keyof EditorPrefs, unknown>>;
  // 自動儲存只認明明白白的 true：預設關，寫壞了也當關。臨時標籤與成對符號預設開，只認明明白白的 false。
  return { autoPair: raw.autoPair !== false, autoSave: raw.autoSave === true, previewTabs: raw.previewTabs !== false };
}

function savePrefs(): void {
  writeAll({ ...storedPrefs(), ...prefs });
}

/** 整份寫回（`undefined` 的項 JSON 裡自然沒有）。寫不進就只在記憶體裡生效，之後讀也只認記憶體裡那一份。 */
function writeAll(next: Record<string, unknown>): void {
  stored = next;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {
    storageOk = false;
  }
}
