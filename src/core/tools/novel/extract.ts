/**
 * `extract` —— 從已寫的東西里提煉：文風指南、敘事線。
 *
 * 都是工程頁上的按鈕背後的同一個函式。敘事線從情節大綱排，由機器**只追加**（第 19 條）：
 * 一條線一個新檔案（`.novelwarden/threads/`），同名跳過，作者寫的字一個都不動。從已寫正文補記敘事線（四期）同樣只追加：
 * 定稿過、敘事線還沒判的章逐章認事件（帶原文證據）、新線、新伏筆，當前進度作者改過的不寫。設定條目從前也在這裡（通讀全書生成），
 * 那一套刪了，換成 `lore` 工具（定稿時順手記、按名錄建條目與整合）。
 */
import { countedBy, defineActionTool } from './actions';
import { extractStyle } from '../../features/style';
import { generateThreads } from '../../features/threads';
import { backfillThreads } from '../../features/threadsBackfill';

export const extractTool = defineActionTool({
  name: 'extract',
  summary: '從已寫的正文或情節大綱裡提煉一份參考材料。',

  params: {},

  actions: {
    style: {
      label: '從已寫的正文裡提取文風指南（寫進 style.md，覆蓋前會先問作者）',
      costly: true,
      async run(ctx) {
        await extractStyle(ctx.project);
        return {
          text: '文風指南已交給 Novelwarden 執行（覆蓋前會先問作者）。要看結果用 read 讀 .novelwarden/style.md。',
          calls: 0,
        };
      },
    },
    threads: {
      label: '從情節大綱排出敘事線（劇情線，伏筆掛線上下；一條線一個檔案，寫進 .novelwarden/threads/；已有的不動、同名跳過）',
      costly: true,
      async run(ctx) {
        return countedBy(await generateThreads(ctx.project), '排敘事線', '情節大綱還是空的，沒有可排的');
      },
    },
    threadsFromText: {
      label:
        '從已寫正文補記敘事線：同步過、敘事線還沒判的章按章號逐章認這一章在敘事線上發生了什麼（每章寫 1–3 次、每次寫完轉寫 1 次；一條線都沒有時先從情節大綱排一次），只往 .novelwarden/threads/ 裡追加',
      costly: true,
      async run(ctx) {
        return countedBy(await backfillThreads(ctx.project), '補記敘事線', '沒有要補記的章（敘事線已經跟上同步進度，或還沒有同步過的章）');
      },
    },
  },
});
