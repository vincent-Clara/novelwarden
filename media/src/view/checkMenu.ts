/**
 * 標題欄「檢視」選單裡「體檢」那一組（獨立版）：正文裡的體檢高亮、狀態列「體檢」那一格兩個開關，外加「編輯敏感詞表…」。
 * 接在 `viewMenu.ts` 的 `GROUPS` 裡（一組一個函式）。
 *
 * 狀態問編輯器（`nf-check-query`，`editor/check.ts` 回答），開關與「編輯敏感詞表…」經 `nf-check-command` 交給它——
 * 那是編輯器的偏好，按瀏覽器記（`novelforge.editor.prefs` 的 `check`）。編輯器沒裝時整組置灰。
 */
import { commandCheck, queryCheck } from '../globals';
import type { MenuEntry } from './menubar';

export function checkMenuEntries(): MenuEntry[] {
  const status = queryCheck();
  return [
    {
      label: '體檢高亮',
      checked: status.highlight,
      disabled: !status.available,
      detail:
        '在正文（章節與草稿）裡標出敏感詞、禁用詞（文風指南的禁用詞表、全域要求裡禁止的詞、古代題材的現代說法）、' +
        '超出上限的比喻詞與英文縮寫。不調模型，也不會替你改字。',
      run: () => commandCheck('toggleHighlight'),
    },
    {
      label: '狀態列顯示體檢',
      checked: status.status,
      disabled: !status.available,
      detail: '狀態列上一格「體檢 N」：一共幾個問題，點開看是哪幾個詞、點詞跳過去。',
      run: () => commandCheck('toggleStatus'),
    },
    {
      label: '編輯敏感詞表…',
      disabled: !status.available || !status.canEditList,
      detail: status.canEditList
        ? '開啟這本書的敏感詞表（工程裡的 sensitive.txt，沒有就新建一份帶說明的模板）：一行一個詞，「詞 => 替換詞」給出替換。'
        : '先開啟一個工程。',
      run: () => commandCheck('editList'),
    },
  ];
}
