/**
 * 小說編輯器的基本功：分段格式、回車自動縮排、成對符號、段落快捷鍵、一鍵排版。`index.ts` 啟動時調一次
 * {@link installParagraphTools}，各模組只經 `api.ts`（`addKeyHandler` / `onEditorChange` / `Pane.applyEdit`）
 * 碰編輯區，`pane.ts` 不知道它們的存在。
 *
 * | 模組 | 管什麼 |
 * |---|---|
 * | `paragraphState.ts` | 分段格式（後端推來的）與編輯器偏好（localStorage `novelforge.editor.prefs`） |
 * | `enter.ts` | 回車 / Shift+Enter：正文按分段格式另起一段，Markdown 接著寫列表，其餘沿用縮排 |
 * | `pairs.ts` | 成對符號自動補全（“” 「」 （） ……） |
 * | `lines.ts` | 段落快捷鍵：Alt+↑↓ 交換、Shift+Alt+↑↓ 複製、Ctrl+Shift+K 刪除、Ctrl+Enter 另起一段 |
 * | `layout.ts` | 一鍵排版、半形標點轉全形、工具欄「排版」按鈕 |
 *
 * 標題欄「編輯」選單（view.js 裡的 `view/paragraphMenu.ts`）經 `nf-paragraph-query` 問這裡的狀態、經
 * `nf-paragraph-command` 把動作交過來；切換分段格式不經這裡，選單直接發 `setParagraphStyle` 給後端。
 */
import { activeEditor, isProse } from './api';
import { installEnter } from './enter';
import { fullWidthIn, formatProseIn, installLayoutButton } from './layout';
import { installLineKeys } from './lines';
import { installPairs } from './pairs';
import { autoPairEnabled, setAutoPair, trackParagraphStyle } from './paragraphState';

export function installParagraphTools(): void {
  trackParagraphStyle();
  installEnter();
  installLineKeys();
  installPairs();
  installLayoutButton();

  window.addEventListener('nf-paragraph-query', (e) => {
    const ed = activeEditor();
    e.detail.prose = !!ed && isProse(ed.file);
    e.detail.autoPair = autoPairEnabled();
  });

  window.addEventListener('nf-paragraph-command', (e) => {
    const name = e.detail.name;
    if (name === 'toggleAutoPair') {
      setAutoPair(!autoPairEnabled());
      return;
    }
    const ed = activeEditor();
    if (!ed) {
      return;
    }
    if (name === 'formatProse') {
      formatProseIn(ed);
    } else if (name === 'fullWidthPunct') {
      fullWidthIn(ed);
    }
  });
}
