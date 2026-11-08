/**
 * `lore` —— 設定名錄：記設定、建條目、整合（設定名錄，2026-10-18）。
 *
 * 每個動作都是工程頁設定組那幾項右鍵選單背後的同一個函式，確認框（含呼叫次數）與對比都在
 * feature 自己那裡。這幾個 feature 不報呼叫次數，回給模型的只有一句「交出去了」（`handed`），次數以
 * 確認框為準。
 *
 * **沒有「按目錄整理」**：它會搬檔案，而移動是第 25 條明確不給外部 agent 的——作者在工程頁自己點。
 *
 * 設定出現在哪幾章的唯一真相是定稿過的細綱「設定」一節：先定稿（summary finalize，會順手記設定），再建條目、整合。
 */
import { str } from '../schema';
import { defineActionTool, handed } from './actions';
import { buildLoreEntries, integrateLore } from '../../features/lore';
import { recordLore } from '../../features/loreRecord';

export const loreTool = defineActionTool({
  name: 'lore',
  summary: '設定條目（地點、勢力、物品、概念……）。出現在哪幾章以各章同步過的細綱為準：先同步再建條目、整合。',

  params: {
    path: str('章節路徑（record），或設定條目的工程內相對路徑（integrate）。'),
    name: str('名錄裡還沒有條目的設定名字，與細綱裡的寫法一致。'),
  },

  actions: {
    record: {
      label: '記設定：給了 path 就單獨記那一章（只換細綱的「設定」一節），沒給就補記所有同步過、還沒記過設定的章',
      costly: true,
      uses: ['path'],
      async run(ctx, args) {
        const path = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : undefined;
        await recordLore(ctx.project, path);
        return handed(path ? `${path} 記設定` : '補記設定');
      },
    },
    build: {
      label: '給同步過的章裡出現過、還沒有條目的設定建條目；給了 name 就建那一條，沒給就建出現 2 章以上的全部',
      costly: true,
      uses: ['name'],
      async run(ctx, args) {
        const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : undefined;
        await buildLoreEntries(ctx.project, name ? [name] : undefined);
        return handed(name ? `「${name}」建條目` : '批次建條目');
      },
    },
    integrate: {
      label: '把同步過的章裡的新內容並進設定條目；給了 path 就整合那一條，沒給就是有新內容的全部',
      costly: true,
      uses: ['path'],
      async run(ctx, args) {
        const path = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : undefined;
        await integrateLore(ctx.project, path ? [path] : undefined);
        return handed(path ? `設定 ${path} 整合` : '整合設定');
      },
    },
  },
});
