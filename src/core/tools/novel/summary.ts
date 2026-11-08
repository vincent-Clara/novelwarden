/**
 * `summary` —— 定稿與全文大綱：給一章定稿、把沒定稿的章的細綱照正文補上、重建全文大綱。
 *
 * 定稿 = 反向更新細綱（照正文改那一章的細綱，帶連續性事實）+ 出場角色的當前狀態 + 這一章在敘事線上
 * 發生了什麼（認事件、當前進度、歸併；第 23 條：這條鏈上唯一的人工閘口）。與工程頁、章節工作臺上的「定稿」是同一個函式。
 */
import { str } from '../schema';
import { countedBy, defineActionTool, handed } from './actions';
import { chapterForSummary, rebuildGlobalSummary, syncSummaries } from '../../features/summarize';
import { describeFinalize, finalizeChapter } from '../../features/finalize';

export const summaryTool = defineActionTool({
  name: 'summary',
  summary: '同步與全文大綱。同步 = 照正文反向更新那一章的細綱，沒有正文的章同步不了。',

  params: {
    path: str('那一章的章節路徑或細綱路徑（按章號認到同一章）。'),
  },

  actions: {
    finalize: {
      label: '同步一章（照正文反向更新它的細綱與連續性事實，再更新出場角色的當前狀態、認這一章在敘事線上發生了什麼（帶原文證據記下事件、更新各條線的當前進度，正文裡新長出來的線也認出來）、推這一章的故事時間）',
      costly: true,
      uses: ['path'],
      requires: ['path'],
      async run(ctx, args) {
        const rel = String(args.path).trim();
        const chapter = await chapterForSummary(ctx.project, rel);
        if (!chapter) {
          throw new Error(`${rel} 這一章還沒有正文，沒有可同步的東西。同步是照正文改細綱，沒有正文就無從改起。`);
        }
        const outcome = await finalizeChapter(ctx.project, chapter, { signal: ctx.signal });
        return outcome
          ? { text: describeFinalize(chapter.order, outcome), calls: outcome.calls }
          : { text: `第 ${chapter.order} 章沒有同步（沒有可用的模型，或這一章是空的）。`, calls: 0 };
      },
    },
    sync: {
      label: '把所有沒同步、或同步後正文又改過的章逐章同步（照正文更新細綱，再更新出場角色的當前狀態、認每一章在敘事線上發生了什麼、推每一章的故事時間）',
      costly: true,
      async run(ctx) {
        return countedBy(await syncSummaries(ctx.project), '批次同步');
      },
    },
    rebuildGlobal: {
      label: '從同步過的各章細綱重建全文大綱',
      costly: true,
      async run(ctx) {
        await rebuildGlobalSummary(ctx.project);
        return handed('全文大綱重建');
      },
    },
  },
});
