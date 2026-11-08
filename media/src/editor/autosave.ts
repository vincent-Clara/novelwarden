/**
 * 自動儲存。**預設關**：標題欄「檔案 → 自動儲存」（緊跟在「全部儲存」後面，開著打 ✓），記在 localStorage
 * `novelforge.editor.prefs`（按瀏覽器記，不進工程；`paragraphState.ts`）。開著時狀態列掛一枚「自動儲存」。
 *
 * 開著時三個時機，一律經 `saving.requestSave(…, { auto: true })`：
 *
 * - **停筆 {@link AUTOSAVE_IDLE_MS}**：存那一份。輸入法組字中途不算停筆（拼音還沒上屏），上屏之後重新計時。
 * - **切走一個標籤**：存剛離開的那一份。
 * - **視窗失去焦點 / 頁面藏起來**：存全部。
 *
 * 照樣帶 `baseHash` 樂觀鎖。撞上衝突的那一份**停止自動儲存**，直到衝突解決（作者在衝突條上選了，基線換了），
 * 絕不強制儲存；磁碟上沒了的不存；同一份同一時刻只有一個儲存在路上，期間又改了就等回執後再存一次；
 * 有對話方塊開著時先不動（作者正在決定，比如點了「還原」）。這幾道閘在 `saving.autoSaveAllowed`。
 *
 * 注意：正文一儲存，已經定稿的章就回到「待定稿」——自動儲存會讓這件事在停筆兩秒後就發生（README 寫著）。
 */
import { onEditorChange } from './api';
import { isDialogOpen } from './dialog';
import { autoSaveEnabled, onPrefsChange, setAutoSave } from './paragraphState';
import { requestSave } from './saving';
import { paneOwning, panes } from './store';

/** 停筆多久算停。 */
export const AUTOSAVE_IDLE_MS = 2000;

export function installAutoSave(): void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 正在組字的編輯區（compositionstart 到 compositionend 之間）。 */
  const composing = new Set<EventTarget>();
  /** 每塊編輯區上一次重畫時的當前檔案：變了就是切走了。 */
  const lastActive = new Map<string, string | null>();

  const cancel = (path: string): void => {
    clearTimeout(timers.get(path));
    timers.delete(path);
  };
  const schedule = (path: string): void => {
    cancel(path);
    timers.set(
      path,
      setTimeout(() => fire(path), AUTOSAVE_IDLE_MS)
    );
  };
  const fire = (path: string): void => {
    timers.delete(path);
    if (!autoSaveEnabled()) {
      return;
    }
    // 還在組字、或者有對話方塊開著：不算停筆，再等一輪。
    if (composing.size > 0 || isDialogOpen()) {
      schedule(path);
      return;
    }
    const pane = paneOwning(path);
    if (pane) {
      void requestSave(pane, path, { auto: true });
    }
  };
  // 停筆的計時不在這裡作廢：這一下要是被閘住了（有對話方塊開著），到點時還得再試一次；
  // 沒被閘住的存過之後就沒有修改了，到點時自然跳過。
  const saveAll = (): void => {
    if (!autoSaveEnabled()) {
      return;
    }
    for (const pane of Object.values(panes)) {
      for (const path of [...pane.files.keys()]) {
        void requestSave(pane, path, { auto: true });
      }
    }
  };

  const isEditorArea = (t: EventTarget | null): t is HTMLTextAreaElement =>
    t instanceof HTMLTextAreaElement && t.classList.contains('ed-area');
  document.addEventListener(
    'compositionstart',
    (e) => {
      if (isEditorArea(e.target)) {
        composing.add(e.target);
      }
    },
    true
  );
  document.addEventListener(
    'compositionend',
    (e) => {
      if (e.target) {
        composing.delete(e.target);
      }
    },
    true
  );

  onEditorChange((ev) => {
    if (ev.type === 'render') {
      const prev = lastActive.get(ev.pane.id);
      const now = ev.pane.activePath;
      lastActive.set(ev.pane.id, now);
      if (prev && prev !== now && autoSaveEnabled() && ev.pane.files.has(prev)) {
        void requestSave(ev.pane, prev, { auto: true });
      }
      return;
    }
    if (!autoSaveEnabled()) {
      return;
    }
    // 組字中途（拼音還沒上屏）那幾下不帶 change：還沒停筆，計時作廢，上屏那一下重新計。
    if (ev.source === 'composition' && !ev.change) {
      cancel(ev.file.path);
      return;
    }
    schedule(ev.file.path);
  });

  window.addEventListener('blur', saveAll);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      saveAll();
    }
  });

  // 標題欄「檔案 → 自動儲存」：問狀態、切開關（選單在 view.js 裡，經 nf-editor-query / nf-editor-command）。
  window.addEventListener('nf-editor-query', (e) => {
    e.detail.autoSave = autoSaveEnabled();
  });
  window.addEventListener('nf-editor-command', (e) => {
    if (e.detail.name === 'toggleAutoSave') {
      setAutoSave(!autoSaveEnabled());
    }
  });
  onPrefsChange(() => {
    if (!autoSaveEnabled()) {
      for (const path of [...timers.keys()]) {
        cancel(path);
      }
    }
    for (const pane of Object.values(panes)) {
      pane.refresh();
    }
  });
}
