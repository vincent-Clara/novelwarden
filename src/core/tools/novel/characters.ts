/**
 * `characters` —— 角色卡：提取、建卡、增量更新 / 重寫、清理別名、合併重複、對比「當前狀態」。
 *
 * 每個動作都是工程頁角色卡那幾顆按鈕背後的同一個函式，確認框、提示條都在 feature 自己那裡。
 * 這幾個 feature 不報呼叫次數，回給模型的只有一句「交出去了」（`handed`），次數以確認框為準。
 *
 * 出場人物的唯一真相是定稿過的細綱（第 14 條）：建卡認的是定稿裡出場、還沒有卡的人，`name` 要與
 * 細綱裡的寫法一致。
 */
import { str } from '../schema';
import { defineActionTool, handed } from './actions';
import {
  createCardForCast,
  createCardsForAllCast,
  updateAllCharacterCards,
  updateCharacterCard,
} from '../../features/characterCard';
import { cleanCharacterAliases, mergeDuplicateCharacterCards } from '../../features/characterMaintenance';
import { reviewCharacterState } from '../../features/characterState';
import { extractCharacters } from '../../features/characters';

const CARD = ['path'];

export const charactersTool = defineActionTool({
  name: 'characters',
  summary: '角色卡。出場人物以各章同步過的細綱為準：先同步（summary finalize）再建卡、更新卡。',

  params: {
    path: str('那張角色卡的工程內相對路徑。'),
    name: str('出場人物的名字，與細綱裡的寫法一致。'),
  },

  actions: {
    extract: {
      label: '通讀已寫正文，提取主要角色寫成角色卡',
      costly: true,
      async run(ctx) {
        await extractCharacters(ctx.project);
        return handed('提取角色');
      },
    },
    create: {
      label: '給一位還沒有卡的出場人物建卡',
      costly: true,
      uses: ['name'],
      requires: ['name'],
      async run(ctx, args) {
        const name = String(args.name).trim();
        await createCardForCast(ctx.project, name);
        return handed(`「${name}」建卡`);
      },
    },
    createAll: {
      label: '給同步過的章裡所有還沒有卡的出場人物建卡',
      costly: true,
      async run(ctx) {
        await createCardsForAllCast(ctx.project);
        return handed('批次建卡');
      },
    },
    update: {
      label: '按新出場的章增量更新一張角色卡',
      costly: true,
      uses: CARD,
      requires: CARD,
      async run(ctx, args) {
        await updateCharacterCard(ctx.project, String(args.path).trim(), 'incremental');
        return handed(`角色卡 ${args.path} 增量更新`);
      },
    },
    rebuild: {
      label: '按全部出場章重寫一張角色卡',
      costly: true,
      uses: CARD,
      requires: CARD,
      async run(ctx, args) {
        await updateCharacterCard(ctx.project, String(args.path).trim(), 'full');
        return handed(`角色卡 ${args.path} 重寫`);
      },
    },
    updateAll: {
      label: '把所有角色卡按新出場的章增量更新一遍',
      costly: true,
      async run(ctx) {
        await updateAllCharacterCards(ctx.project, 'incremental');
        return handed('全部角色卡增量更新');
      },
    },
    rebuildAll: {
      label: '按全部出場章重寫所有角色卡',
      costly: true,
      async run(ctx) {
        await updateAllCharacterCards(ctx.project, 'full');
        return handed('全部角色卡重寫');
      },
    },
    cleanAliases: {
      label: '清理角色卡別名裡的泛稱與別人的名字（只改 aliases，正文不動）',
      costly: false,
      async run(ctx) {
        await cleanCharacterAliases(ctx.project);
        return handed('別名清理');
      },
    },
    mergeDuplicates: {
      label: '找出指向同一個人的重複角色卡並合併（合併哪幾組由作者確認）',
      costly: false,
      async run(ctx) {
        await mergeDuplicateCharacterCards(ctx.project);
        return handed('重複角色卡合併');
      },
    },
    reviewState: {
      label: '同步時作者改過、機器沒覆蓋的那張卡的「當前狀態」：拿出機器那一版請作者對比決定換不換',
      costly: false,
      uses: CARD,
      requires: CARD,
      async run(ctx, args) {
        await reviewCharacterState(ctx.project, String(args.path).trim());
        return handed(`角色卡 ${args.path} 的當前狀態對比`);
      },
    },
  },
});
