/**
 * 「帶 action 的工具」共用的那一套：動作表 → 一個 `ToolDef`。
 *
 * 工程動作按**它動的是什麼**分成幾個工具（流水線、定稿、角色卡、提煉、拆書、技能），每個工具
 * 一張動作表、只帶自己用得到的引數。分開的理由是引數：塞在一個工具裡時，模型面對的是一大把
 * 「只有某幾個動作認」的引數，記錯一個就白跑一趟；分開之後每個工具的 schema 就是它的全部用法。
 *
 * ## 這裡做的四件事
 *
 * 1. **引數對得上動作**：每個動作宣告它認哪幾個引數（`uses`）、哪幾個必填（`requires`）。
 *    給了它不認的引數當場報錯——模型以為自己傳了一個區間、其實被忽略，比多一次往返更糟。
 * 2. **故意不給的動作**（刪除、改名……）認出來單獨回一句為什麼，好過讓模型在可選動作裡猜。
 * 3. **意圖**：查詢類動作報 `auto`（不進對話頁），其餘報 `mutating`；裝、綁技能自己報 `always`。
 * 4. **記賬**：次數由 feature 自己算一次再報回來（彈窗寫著 7 次、賬上記 1 次，正是第 4 條要防的事）。
 *
 * 確認框全在 feature 自己那裡，這一層只轉發，**沒有為外部 agent 加任何一條繞過它的路**。
 */
import type { GateKind, ToolContext, ToolDef, ToolIntent, ToolResult } from '../types';
import { objectSchema, str } from '../schema';
import { text } from './naming';
import { describeError } from '../../runtime/logger';

/** 一次動作的結果：說給模型聽的一句話 + 這一下花了幾次模型呼叫。 */
export interface ActionResult {
  text: string;
  /** 報給呼叫方記賬的次數。0 = 一次模型都沒調（取消 / 無事可做 / 次數只在確認框裡）。 */
  calls: number;
}

export interface ActionSpec {
  /** 工具描述與錯誤提示裡的說法。 */
  label: string;
  /** 會不會調模型。只進工具描述，閘門由 feature 自己的確認框把。 */
  costly: boolean;
  /** 認哪幾個引數（`action` 之外）。沒列的給了就當場報錯。 */
  uses?: string[];
  /** 其中哪幾個必填，缺了當場報錯，不放它跑一趟空的。 */
  requires?: string[];
  /** 預設 `mutating`；查詢類報 `auto`。要說得更具體（裝、綁技能）就實現 `intent`。 */
  gate?: GateKind;
  intent?(args: Record<string, unknown>): ToolIntent;
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<ActionResult>;
}

export interface ActionToolDef {
  name: string;
  /** 一句話說這個工具管什麼。動作清單由這裡拼在後面。 */
  summary: string;
  /** 動作清單之後的補充說明（怎麼用才對）。 */
  usage?: string;
  /** `action` 之外的引數，扁平標量。 */
  params: Record<string, ReturnType<typeof str>>;
  actions: Record<string, ActionSpec>;
}

/**
 * 外部 agent 可能想幹、但**故意不給**的動作。哪個工具都一樣：那類操作由作者自己做。
 */
const REFUSED: Record<string, string> = {
  delete: '刪除',
  remove: '刪除',
  trash: '刪除',
  rename: '改名',
  move: '移動',
  initProject: '初始化工程',
  newChapter: '直接新建章節檔案',
  split: '拆分正文',
  uninstall: '解除安裝技能',
  uninstallSkill: '解除安裝技能',
  deleteSkill: '解除安裝技能',
};

export function defineActionTool(def: ActionToolDef): ToolDef {
  const names = Object.keys(def.actions);
  const anyCostly = names.some((a) => def.actions[a].costly);

  const tool: ToolDef = {
    name: def.name,
    costly: anyCostly,
    mutating: names.some((a) => gateOf(def.actions[a]) !== 'auto'),

    intent(args): ToolIntent {
      const action = text(args.action);
      const spec = def.actions[action];
      if (spec?.intent) {
        return spec.intent(args);
      }
      const target = [text(args.path), text(args.name)].filter(Boolean).join(' ');
      return {
        gate: spec ? gateOf(spec) : 'mutating',
        title: spec ? spec.label : `執行 ${def.name} ${action}`,
        detail: [
          target,
          spec?.costly ? '要調模型的動作隨後還會告訴你預計呼叫幾次，那一步你也可以不同意。' : '',
        ]
          .filter(Boolean)
          .join('\n'),
      };
    },

    description:
      `${def.summary}可用的 action：` +
      names
        .map((a) => {
          const s = def.actions[a];
          const need = s.requires?.length ? `，要 ${s.requires.join(' / ')}` : '';
          return `${a}=${s.label}（${s.costly ? '調模型' : '不調模型'}${need}）`;
        })
        .join('；') +
      '。' +
      (def.usage ?? ''),

    parameters: objectSchema({ action: str('要執行哪個動作。', names), ...def.params }, ['action']),

    check(args) {
      const action = text(args.action);
      const spec = def.actions[action];
      if (!spec) {
        const why = REFUSED[action]
          ? `沒有${REFUSED[action]}這個動作，而且這是有意的——那類操作由作者自己做。`
          : action
            ? `認不出動作「${action}」。`
            : 'action 是必填的。';
        return `${why}${def.name} 可用的是：${names.join(' / ')}。`;
      }

      const uses = new Set(spec.uses ?? []);
      for (const key of Object.keys(args)) {
        if (key !== 'action' && args[key] !== undefined && !uses.has(key)) {
          const who = names.filter((a) => def.actions[a].uses?.includes(key));
          return `${action} 不認 ${key}${who.length > 0 ? `，只有 ${who.join(' / ')} 認` : ''}。`;
        }
      }
      const missing = (spec.requires ?? []).filter((key) => !text(args[key]) && typeof args[key] !== 'number');
      if (missing.length > 0) {
        return `${action} 需要引數：${missing.join('、')}。${describeParams(def, missing)}`;
      }
      return undefined;
    },

    async run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
      const issue = tool.check!(args);
      if (issue) {
        return { text: '', error: issue };
      }
      const action = text(args.action);
      const spec = def.actions[action];

      try {
        const r = await spec.run(ctx, args);
        ctx.usage.record(r.calls);
        if (r.calls > 0) {
          ctx.report(`${spec.label}：呼叫模型 ${r.calls} 次`);
        }
        return {
          text: r.text,
          display: { title: `${def.name} ${action}`, detail: r.calls > 0 ? `${r.calls} 次呼叫` : '未調模型' },
        };
      } catch (err) {
        if (err instanceof ArgError) {
          return { text: '', error: err.message };
        }
        return { text: '', error: `${spec.label}失敗：${describeError(err)}` };
      }
    },
  };
  return tool;
}

/** 查詢類動作自己報 `auto`；其餘一律 `mutating`（寧可多問，也不要有一條沒人想過的路）。 */
function gateOf(spec: ActionSpec): GateKind {
  return spec.gate ?? 'mutating';
}

function describeParams(def: ActionToolDef, keys: string[]): string {
  return keys.map((k) => `${k}：${def.params[k]?.description ?? ''}`).join(' ');
}

/** 引數值不對（區間倒了、階段寫錯）：當場回給模型，不算「執行失敗」。 */
export class ArgError extends Error {}

// ---------------------------------------------------------------- 回給模型的話

/**
 * feature 報回來的「計劃呼叫幾次」→ 一句話 + 記賬。
 *
 * **0 次要說清楚**：作者取消了，或者壓根沒有待處理的東西。不說的話模型會以為
 * 是自己引數填錯了，然後原地再發一遍。
 */
export function countedBy(calls: number, what: string, idle = '沒有待處理的章'): ActionResult {
  if (calls <= 0) {
    return {
      text:
        `${what}這一次沒有呼叫模型：要麼作者在確認框裡取消了，要麼${idle}。` +
        '不要重試同一個動作——先用 list 或 read 看看現在的狀態。',
      calls: 0,
    };
  }
  return { text: `${what}已執行，計劃呼叫模型 ${calls} 次。結果見工程頁與日誌。`, calls };
}

/**
 * 不報次數的那幾個 feature（結論都在確認框、提示條與日誌裡）：只說交出去了、去哪看結果。
 * 次數記 0——確認框裡寫的才是實數，這裡猜一個反倒是第 4 條要防的那種對不上。
 */
export function handed(what: string): ActionResult {
  return {
    text: `${what}已交給 Novelwarden 執行（確認框、結果與呼叫次數都在作者那邊的介面和日誌裡）。要知道改了什麼，用 read 看對應檔案。`,
    calls: 0,
  };
}

export function toInt(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : undefined;
}
