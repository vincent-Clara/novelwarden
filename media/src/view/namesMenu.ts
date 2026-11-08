/**
 * 標題欄「檢視」選單裡「補全」那一組（獨立版）：「名詞補全」（與 `Alt+/` 同一件事）、「邊打邊彈名詞補全」與「名詞高亮」
 * 兩個開關。接在 `viewMenu.ts` 的 `GROUPS` 裡（一組一個函式）。
 *
 * 狀態問編輯器（`nf-names-query`：補全那兩項 `editor/names.ts` 回答，名詞高亮 `editor/nameMarks.ts` 回答），動作經
 * `nf-names-command` 交給它們——都是編輯器的偏好，按瀏覽器記（`novelforge.editor.prefs` 的 `nameAutoPopup` /
 * `nameHighlight`）。編輯器沒裝時整組置灰。
 */
import { isMacPlatform, shortcutLabel } from '../editor/shortcuts';
import { commandNames, queryNames } from '../globals';
import type { MenuEntry } from './menubar';

export function namesMenuEntries(): MenuEntry[] {
  const status = queryNames();
  // 快捷鍵（⚑ Alt+/）登記在 editor/shortcuts.ts，選單上的字從那張表取。
  const keyLabel = shortcutLabel('names');
  return [
    {
      label: '名詞補全',
      kbd: keyLabel,
      disabled: !status.available || !status.canTrigger,
      detail: status.canTrigger
        ? '在游標處列出角色名、別名、設定（地點、勢力、物品……）與名錄裡出現過的名字，按游標前已經打的幾個字篩。'
        : status.reason ?? '先在編輯區裡開啟一章正文、細綱、角色卡或設定。',
      run: () => commandNames('trigger'),
    },
    {
      label: '邊打邊彈名詞補全',
      checked: status.auto,
      disabled: !status.available,
      detail: `打出某個名字的開頭兩個字（還沒打完整）就彈出來；按 Tab 接受，回車照常換段，接著打別的字就收起。關著時只在按 ${keyLabel} 時彈。`,
      run: () => commandNames('toggleAuto'),
    },
    {
      label: '名詞高亮',
      checked: status.highlight,
      disabled: !status.available,
      detail:
        '正文、細綱、角色卡、設定這些檔案裡，角色名、設定名鋪一層淡底色，名錄裡出現過、還沒建條目的名字畫虛下劃線。' +
        `滑鼠停在上面看一句話簡介，${isMacPlatform() ? '⌘' : 'Ctrl'}+點選開啟它的角色卡或設定條目。`,
      run: () => commandNames('toggleHighlight'),
    },
  ];
}
