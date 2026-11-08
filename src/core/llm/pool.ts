import { readBudgetFallback, readConfig } from '../config';
import { describeError, scoped } from '../runtime/logger';
import { describeModelIssue, resolveModelRef } from '../model/providers';
import { describeTier, LlmTask, ModelTier, refsForTask, TASK_LABEL } from '../model/tiers';
import { buildProvider } from './registry';
import { CancelledError, LlmProvider } from './provider';

const log = scoped('模型池');

/**
 * 工程頁後臺任務的取模型入口。
 *
 * 取哪些模型由**任務的檔位**決定（見 model/tiers.ts）：呼叫量大而單次簡單的
 * 活走快速檔，一次定調的活走精標檔。檔位沒配模型時沿用「預設模型」清單，
 * 因此不配任何檔 = 與分檔之前行為一致。
 *
 * 拿到該檔的有序清單後，這裡把它變成兩種能力：
 *
 * - **隨機 fallback**：序列呼叫恆從第一個模型起；失敗了就在**其餘**模型裡
 *   隨機挑一個重試，最多 `fallbackAttempts` 次。單一模型 429 或抽風，
 *   不該讓一次「同步 76 章摘要」整批斷在第 30 章。
 * - **輪轉負載均衡**：併發呼叫按游標在列表裡輪轉，把請求攤到幾個服務商上，
 *   這正是併發跑得起來的前提（單個服務商的限流額度往往撐不住 3 路併發）。
 *
 * 兩條都**只在檔內**發生：快速檔失敗絕不升級到精標檔。跨檔換人等於繞過
 * 作者的成本決定去燒貴 token，而且從日誌上看不出來。作者在確認框上為這一次
 * 指定了模型（`pinnedModel`，見 runtime/callScope.ts）時池裡只有它，兩條都沒有。
 *
 * 只有工程頁任務走這裡。對話頁續寫不走——作者在下拉框裡選了哪個模型，
 * 就必須是哪個模型寫的正文，中途偷偷換人會讓文風斷掉。
 */
export interface ModelPool {
  /** 池裡真正可用的引用，按配置順序。至少一項。 */
  readonly refs: string[];
  readonly size: number;
  /** 給確認框與日誌用的一句話，如「快速檔：glm/glm-4-air 等 3 個模型」。 */
  readonly label: string;
  /** 這個池取自哪一檔。 */
  readonly tier: ModelTier;
  /** 首選模型的 provider，供「模型 X」這類展示用。 */
  readonly primary: LlmProvider;
  /**
   * 首選模型的 token 預算。
   *
   * **切批與截斷必須用它，不能用 `config.contextWindow`**——後者跟著對話頁
   * 選定的模型走，拿 200k 寫作模型的視窗去給 32k 的快速檔模型切批會穩定超窗。
   */
  readonly primaryBudget: { contextWindow: number; maxOutputTokens: number };
  /**
   * 跑一次帶 fallback 的呼叫。
   *
   * @param what 出錯時寫進日誌的物件描述，如「第 12 章」「角色卡「林昭」」。
   * @param fn   拿到 provider 與它的引用；同一個 fn 可能被換模型重跑，
   *             因此**必須是冪等的**（只讀上下文 + 調模型，別在裡面寫盤）。
   */
  run<T>(what: string, fn: (llm: LlmProvider, ref: string) => Promise<T>): Promise<T>;
}

export interface ModelPoolOptions {
  /** 這個池給哪個任務用，決定取哪一檔。 */
  task: LlmTask;
  /**
   * 是否按輪轉取起始模型。併發任務傳 true（負載均衡），
   * 序列任務傳 false（恆用首選，與「預設模型」的直覺一致）。
   */
  concurrent?: boolean;
}

/**
 * 按當前設定構造模型池。
 *
 * 返回 undefined 表示一個可用模型都沒有——呼叫方沿用既有的
 * 「沒有可用的模型，XX 中止」分支即可，不必新增錯誤路徑。
 *
 * 構造策略上有一條硬約束：**只有首選模型缺 Key 時才彈輸入框**。
 * 備選模型一律靜默構造，缺 Key / 環境不支援就剔除並 warn——
 * 一次點選連彈五個 API Key 輸入框，比沒有 fallback 更讓人惱火。
 */
export async function createModelPool(opts: ModelPoolOptions): Promise<ModelPool | undefined> {
  const config = readConfig();
  const picked = refsForTask(config, opts.task);
  const scope = `${TASK_LABEL[opts.task]}（${describeTier(picked)}）`;
  // 模型沒自帶視窗時的相容兜底。不能用 config.contextWindow：
  // 後者已被「當前模型」的覆蓋值遮住，那是對話頁選的模型的視窗。
  const fallbackBudget = readBudgetFallback();

  const entries: { ref: string; llm: LlmProvider; budget: ModelBudget }[] = [];
  const dropped: string[] = [];

  for (const [i, ref] of picked.refs.entries()) {
    const active = resolveModelRef(config.providers, ref);
    if (!active) {
      dropped.push(`${ref}（${describeModelIssue(config.providers, ref)}）`);
      continue;
    }
    // 首選照舊可以彈 Key 輸入框；其餘靜默。
    const llm = await buildProvider(active, { promptForKey: i === 0 });
    if (!llm) {
      dropped.push(`${ref}（未取得 API Key 或當前環境不支援）`);
      continue;
    }
    entries.push({
      ref: active.ref,
      llm,
      // 模型自帶的視窗優先，預設退回相容值——與 readConfig() 裡
      // 對「當前模型」的取值邏輯一致。
      budget: {
        contextWindow: active.model.contextWindow ?? fallbackBudget.contextWindow,
        maxOutputTokens: active.model.maxOutputTokens ?? fallbackBudget.maxOutputTokens,
      },
    });
  }

  if (dropped.length > 0) {
    // 「不靜默截斷」：池裡少了誰、為什麼少，必須說出來。
    log.warn(`${scope}：${dropped.length} 個模型不可用，已排除在外`, dropped.join('\n'));
  }
  if (entries.length === 0) {
    log.error(
      `${scope}：沒有一個可用的模型`,
      picked.refs.length === 0
        ? '設定頁的「預設模型」還是空的。'
        : `已配置：${picked.refs.join('、')}`
    );
    return undefined;
  }

  return new RoundRobinPool(entries, config.fallbackAttempts, opts.concurrent === true, picked.tier, {
    tierLabel: describeTier(picked),
  });
}

interface ModelBudget {
  contextWindow: number;
  maxOutputTokens: number;
}

/**
 * 某個任務的 token 預算，**不構造 provider**（因此不會彈 API Key 輸入框）。
 *
 * 給「確認框之前就要算的東西」用：設定生成要先按預算把章節切成掃描片段、
 * 更新角色卡要先分批，兩者算出的數量正是確認框裡那句「預計呼叫模型 N 次」。
 * 這些必須用**幹活的那個模型**的視窗來算，否則用 200k 寫作模型的視窗給
 * 32k 的快速檔模型切批，跑起來必然超窗。
 *
 * 取該檔第一個**解析得出**的模型。它與 `pool.primaryBudget` 只在一種情況下
 * 不同：首選解析得出但缺 Key 且使用者拒絕錄入，池會把它剔掉換下一個。那時
 * 批數已經算定並原樣傳給執行體，「預計呼叫 N 次」仍然對得上賬，只是可能
 * 多幾條截斷 warn。
 */
export function budgetForTask(task: LlmTask): ModelBudget {
  const config = readConfig();
  const fallbackBudget = readBudgetFallback();
  for (const ref of refsForTask(config, task).refs) {
    const active = resolveModelRef(config.providers, ref);
    if (active) {
      return {
        contextWindow: active.model.contextWindow ?? fallbackBudget.contextWindow,
        maxOutputTokens: active.model.maxOutputTokens ?? fallbackBudget.maxOutputTokens,
      };
    }
  }
  // 一個都解析不出：照舊返回相容值，後續建池時會報「沒有可用的模型」。
  return fallbackBudget;
}

class RoundRobinPool implements ModelPool {
  private cursor = 0;

  constructor(
    private readonly entries: { ref: string; llm: LlmProvider; budget: ModelBudget }[],
    private readonly fallbackAttempts: number,
    private readonly concurrent: boolean,
    readonly tier: ModelTier,
    private readonly labels: { tierLabel: string }
  ) {}

  get refs(): string[] {
    return this.entries.map((e) => e.ref);
  }

  get size(): number {
    return this.entries.length;
  }

  get label(): string {
    const [first, ...rest] = this.entries;
    const models = rest.length === 0 ? first.ref : `${first.ref} 等 ${this.entries.length} 個模型`;
    return `${this.labels.tierLabel}：${models}`;
  }

  get primary(): LlmProvider {
    return this.entries[0].llm;
  }

  /**
   * 首選模型的視窗。
   *
   * 取首選而非全池最小值：fallback 是小機率路徑，為它把每一批都切小，
   * 等於讓常態下的每次呼叫都少讀幾章正文。備選模型視窗更小時，超出的部分
   * 由 provider 報錯後換人兜住。
   */
  get primaryBudget(): ModelBudget {
    return this.entries[0].budget;
  }

  async run<T>(what: string, fn: (llm: LlmProvider, ref: string) => Promise<T>): Promise<T> {
    // 起始模型：併發輪轉，序列恆取首選。
    const startIndex = this.concurrent ? this.cursor++ % this.entries.length : 0;
    const tried = new Set<number>();
    let index = startIndex;
    // 只有一個模型時換誰都是它自己，重試只是白燒一次 token。
    const maxRetries = this.entries.length > 1 ? this.fallbackAttempts : 0;

    for (let attempt = 0; ; attempt++) {
      tried.add(index);
      const entry = this.entries[index];
      try {
        return await fn(entry.llm, entry.ref);
      } catch (err) {
        // 使用者點了停止：立刻上拋，換模型重試只會讓「停止」看起來失靈。
        if (err instanceof CancelledError || (err as Error)?.name === 'CancelledError') {
          throw err;
        }
        const nextIndex = this.pickFallback(tried);
        if (attempt >= maxRetries || nextIndex === undefined) {
          throw err;
        }
        log.warn(
          `${what}：${entry.ref} 失敗，改用 ${this.entries[nextIndex].ref} 重試（第 ${attempt + 1}/${maxRetries} 次）`,
          describeError(err)
        );
        index = nextIndex;
      }
    }
  }

  /** 從沒試過的模型裡隨機挑一個。全試過了返回 undefined。 */
  private pickFallback(tried: Set<number>): number | undefined {
    const candidates = this.entries.map((_, i) => i).filter((i) => !tried.has(i));
    if (candidates.length === 0) {
      return undefined;
    }
    return candidates[Math.floor(Math.random() * candidates.length)];
  }
}
