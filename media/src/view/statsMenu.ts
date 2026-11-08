/**
 * 標題欄「檢視」選單裡「統計」那一組（獨立版）：狀態列字數那一格顯示哪幾項的開關，外加「重新開始計時」。
 * 接在 `viewMenu.ts` 的 `GROUPS` 裡（一組一個函式）。
 *
 * 狀態問編輯器（`nf-stats-query`，`editor/stats.ts` 回答），開關與重新開始計時經 `nf-stats-command` 交給它——
 * 那是編輯器的偏好，按瀏覽器記（`novelforge.editor.prefs` 的 `stats`）。編輯器沒裝時整組置灰。
 */
import { commandStats, queryStats } from '../globals';
import type { MenuEntry } from './menubar';

export function statsMenuEntries(): MenuEntry[] {
  const status = queryStats();
  return [
    {
      label: '統計',
      disabled: !status.available,
      detail: '內建編輯器狀態列上字數那一格除了全文 / 選中字數，還顯示哪幾項。點那一格看碼字統計。',
      submenu: [
        {
          label: '狀態列顯示距目標',
          checked: status.goal,
          detail: '開著某一章的正文時，顯示本章字數與目標（細綱的目標字數，沒寫就是小說配置的每章字數）還差多少。',
          run: () => commandStats('toggleGoal'),
        },
        {
          label: '狀態列顯示本次碼字',
          checked: status.session,
          detail: '從開啟這個頁面（或重新開始計時）起，你在編輯器裡親手打進去的淨字數。',
          run: () => commandStats('toggleSession'),
        },
        {
          label: '狀態列顯示今日碼字',
          checked: status.today,
          detail: '這個工程今天一共碼了多少字（同一個瀏覽器裡幾個視窗、重新整理前後都累計）。',
          run: () => commandStats('toggleToday'),
        },
      ],
    },
    {
      label: '重新開始計時',
      disabled: !status.available,
      detail: '「本次碼字」的字數與時長從現在起重新算；今日碼字不受影響。',
      run: () => commandStats('restart'),
    },
  ];
}
