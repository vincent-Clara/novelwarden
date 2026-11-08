/**
 * `pipeline` —— 流水線上的批次動作：補齊架構、批次拆細綱、批次寫章，外加新建一章的細綱骨架。
 *
 * 這些動作揹著一批 agent 不該自己去執行的不變數：批次路徑**跳過已有產物**、用不帶全文兜底的
 * 嚴格解析（第 19 條）；正文落盤要在細綱上記 `writtenFrom`（第 18 條）。讓它拿 `write` 自己拼，
 * 等於把這些交給一個每次都可能記錯的東西。所以每個動作就是工程頁那顆按鈕背後的同一個函式，
 * 確認框（「有 N 章還沒排細綱，需要呼叫 N 次模型」）照彈（第 4 條）。
 */
import { bool, int, str } from '../schema';
import { ArgError, countedBy, defineActionTool, toInt } from './actions';
import { newPlotFlow } from '../../actions';
import { completeSettings, generatePlots, writeManuscripts } from '../../features/pipelineBatch';
import { PLOT_BATCH, WRITE_BATCH_DEFAULT, isWriteBatchMode } from '../../model/pipeline';

export const pipelineTool = defineActionTool({
  name: 'pipeline',
  summary:
    '流水線上的批次動作。它們揹著固定流程（只補空白不覆蓋已有產物、正文落盤在細綱上記指紋），' +
    '所以走這裡，不要自己用 write 拼。調模型的動作會先彈確認框告訴作者要呼叫幾次，他可以不同意。',
  usage:
    '**連續多章的同類工作用這裡**（batchPlots / batchManuscripts），比一章一章 generate 省錢，' +
    '而且有進度條、能停、失敗的會掛在那一章上。from / to 指定章號區間，只給 from 時按預設章數往後數。',

  params: {
    from: int('章號區間的起點。留空從下一個該寫的章起。'),
    to: int('章號區間的終點（含）。要給就同時給 from。'),
    mode: str('批次寫章的模式：draft=只寫正文（預設），finalize=每寫完一章就同步（照正文更新細綱 + 出場角色的當前狀態 + 敘事線）。', [
      'draft',
      'finalize',
    ]),
    review: bool('批次寫章時每寫完一章先審稿，報告放進一個新會話。預設 false。'),
  },

  actions: {
    completeSettings: {
      label: '補齊故事架構（小說配置 / 故事前提 / 角色圖譜 / 世界觀 / 設定清單，只補空白）',
      costly: true,
      async run(ctx) {
        return countedBy(await completeSettings(ctx.project), '補齊故事架構', '五件都已經有了，或者小說配置還沒有「一句話」可以展開');
      },
    },
    batchPlots: {
      label: `批次拆細綱（預設從下一個該寫的章起 ${PLOT_BATCH} 章；已有細綱的章跳過）`,
      costly: true,
      uses: ['from', 'to'],
      async run(ctx, args) {
        return countedBy(await generatePlots(ctx.project, { range: rangeOf(args, PLOT_BATCH) }), '批次拆細綱');
      },
    },
    batchManuscripts: {
      label: `批次寫章，一章一章序列寫（預設從下一個該寫的章起 ${WRITE_BATCH_DEFAULT} 章、只寫正文；已有正文的章跳過）`,
      costly: true,
      uses: ['from', 'to', 'mode', 'review'],
      intent(args) {
        const scope = [
          describeRange(args),
          args.mode === 'finalize' ? '寫完即同步' : '',
          args.review === true ? '寫完即審稿' : '',
        ]
          .filter(Boolean)
          .join('，');
        return {
          gate: 'mutating',
          title: '批次寫章',
          detail: [scope, '隨後還會告訴你預計呼叫幾次，那一步你也可以不同意。'].filter(Boolean).join('\n'),
        };
      },
      async run(ctx, args) {
        if (args.mode !== undefined && !isWriteBatchMode(args.mode)) {
          throw new ArgError('mode 只能是 draft（只寫正文）或 finalize（寫完即同步）。');
        }
        return countedBy(
          await writeManuscripts(ctx.project, {
            range: rangeOf(args, WRITE_BATCH_DEFAULT),
            mode: isWriteBatchMode(args.mode) ? args.mode : undefined,
            review: args.review === undefined ? undefined : args.review === true,
          }),
          '批次寫章'
        );
      },
    },
    newPlot: {
      label: '新建一章的細綱骨架（接在最後一章之後）',
      costly: false,
      async run(ctx) {
        const rel = await newPlotFlow(ctx.project);
        return { text: `已新建 ${rel}（空骨架，還沒有細綱內容）。`, calls: 0 };
      },
    },
  },
});

/**
 * 章號區間。不在這裡截到總章數、大綱覆蓋或批次上限——那些由 feature 自己按磁碟算，確認框裡
 * 寫著實際要處理哪幾章。
 */
function rangeOf(args: Record<string, unknown>, span: number): { from: number; to: number } | undefined {
  if (args.from === undefined && args.to === undefined) {
    return undefined;
  }
  const from = toInt(args.from);
  const to = toInt(args.to);
  if (from === undefined) {
    throw new ArgError(args.from === undefined ? '給了 to 就要同時給 from（章號區間的起點）。' : 'from / to 要填章號（正整數）。');
  }
  if (args.to !== undefined && to === undefined) {
    throw new ArgError('from / to 要填章號（正整數）。');
  }
  const end = to ?? from + span - 1;
  if (from < 1 || end < from) {
    throw new ArgError(`章號區間不對：第 ${from}–${end} 章。from 從 1 起，to 不能小於 from。`);
  }
  return { from, to: end };
}

function describeRange(args: Record<string, unknown>): string {
  const from = toInt(args.from);
  const to = toInt(args.to);
  if (from === undefined) {
    return '';
  }
  return to !== undefined && to !== from ? `第 ${from}–${to} 章` : `從第 ${from} 章起`;
}
