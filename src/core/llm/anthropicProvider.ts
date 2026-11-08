import {
  THINKING_LABEL,
  ThinkingDepth,
  anthropicEffort,
  downgradeDepth,
  outputRoomTooSmall,
  thinkingBudget,
} from '../model/thinking';
import { scoped } from '../runtime/logger';
import { describeHttpBody, hostOf, readBody } from './openaiProvider';
import {
  ChatMessage,
  LlmError,
  LlmProvider,
  StopSignal,
  StreamEvent,
  StreamOptions,
  iterateSse,
  makeAbortSignal,
  normalizeError,
} from './provider';

const log = scoped('模型');

/**
 * Anthropic Messages API 流式實現。system 走頂層欄位，不混在 messages 裡。
 *
 * ## 思考深度：一個梯子，兩種寫法
 *
 * Anthropic 自己換過一次思考的開關方式，而**兩代寫法在對方的模型上都是 400**：
 *
 * - **自適應**（4.7 / Opus 5 及以後，也是 4.6 上推薦的）：
 *   `thinking: {type:'adaptive', display:'summarized'}` + `output_config: {effort}`；
 * - **手動預算**（4.5 及更早唯一可用的）：`thinking: {type:'enabled', budget_tokens}`，
 *   4.6 上已棄用、4.7 以後直接拒。
 *
 * 作者的設定頁裡只有一個模型名，指望他知道自家模型屬於哪一代是不合理的，所以
 * 這裡**問出來**：先按自適應發，被拒了就換手動，再被拒就不帶思考欄位，結論按
 * 「介面地址 + 模型」記在記憶體裡（見 QUIRKS）。代價是每個模型一生一次 400，
 * 換來的是「換個模型名就不能思考了」這件事不會發生。
 */
export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey: string
  ) {}

  get label(): string {
    return `${this.model} @ ${hostOf(this.baseUrl)}`;
  }

  async maxInputTokens(): Promise<number | undefined> {
    return undefined;
  }

  async *stream(messages: ChatMessage[], options: StreamOptions): AsyncIterable<StreamEvent> {
    const { signal, dispose, poke } = makeAbortSignal(options);
    try {
      const system = messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');
      const msgs = toAnthropicMessages(messages);
      const quirk = quirksOf(this.baseUrl, this.model);
      let stream: ReadableStream<Uint8Array> | undefined;

      // 上游拒了某個思考欄位就換一種寫法再發（見 negotiate）——**不是重試同一個
      // 請求**：每一次的請求體都與上一次不同，最多三次就退到不帶思考欄位。
      for (let attempt = 0; ; attempt += 1) {
        const plan = thinkingPlan(options, quirk, this.model);
        const response = await fetch(`${this.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: this.model,
            system: system || undefined,
            messages: msgs,
            max_tokens: options.maxOutputTokens,
            // 思考開著時不帶 temperature：兩代寫法都要求它是預設值。
            ...(plan ? {} : { temperature: options.temperature }),
            ...(plan?.mode === 'adaptive'
              ? {
                  // display: 'summarized' 才有 thinking_delta——新模型預設是
                  // 'omitted'（只給簽名），那樣介面上「正在思考」是一片空白。
                  thinking: { type: 'adaptive', display: 'summarized' },
                  output_config: { effort: plan.effort },
                }
              : {}),
            ...(plan?.mode === 'manual'
              ? { thinking: { type: 'enabled', budget_tokens: plan.budgetTokens } }
              : {}),
            stream: true,
          }),
          signal,
        });

        if (response.ok && response.body) {
          stream = response.body;
          break;
        }
        // 響應體只讀一次：欄位協商要看它，報錯也要看它。
        const detail = await readBody(response);
        // 這一次壓根沒帶思考欄位的話，上游那句抱怨與我們無關——換寫法再發
        // 只是白等一次，而真正的錯誤會被推遲兩個來回才報出來。
        if (plan && attempt < 2 && negotiate(response.status, detail, quirk, this.label)) {
          continue;
        }
        throw new LlmError(describeHttpBody(response.status, detail, this.label, '/v1/messages'));
      }
      poke();

      for await (const payload of iterateSse(stream, signal, poke)) {
        let event: AnthropicEvent;
        try {
          event = JSON.parse(payload) as AnthropicEvent;
        } catch {
          continue;
        }
        if (event.type === 'error') {
          throw new LlmError(`${this.label} 返回錯誤：${event.error?.message ?? '未知錯誤'}`);
        }
        // 用量分兩處給：message_start 帶輸入，message_delta 帶輸出累計值。
        // 兩條都發出去，呼叫方按欄位合併。
        const usage = event.type === 'message_start' ? event.message?.usage : event.usage;
        if (usage) {
          yield {
            type: 'usage',
            usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
          };
        }
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
          yield { type: 'text', text: event.delta.text };
        }
        // 擴充套件思考（thinking blocks）同樣不是正文，走單獨的事件給介面展示。
        if (
          event.type === 'content_block_delta' &&
          event.delta?.type === 'thinking_delta' &&
          event.delta.thinking
        ) {
          yield { type: 'reasoning', text: event.delta.thinking };
        }
        // 收尾原因在 `message_delta` 上，**排在所有內容塊之後**。
        if (event.type === 'message_delta' && event.delta?.stop_reason) {
          yield { type: 'stop', reason: stopSignalOf(event.delta.stop_reason) };
        }
      }
    } catch (err) {
      throw normalizeError(err, signal, this.label);
    } finally {
      dispose();
    }
  }
}

/**
 * Anthropic 的 `stop_reason` → 歸一的三檔。
 *
 * 認不出的一律 `other`：這個欄位上游還在加值（`pause_turn`、`refusal`），
 * 報錯會讓續寫鏈因為一個不認識的字串就斷掉。
 */
function stopSignalOf(reason: string): StopSignal {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end';
    case 'max_tokens':
      return 'maxTokens';
    default:
      return 'other';
  }
}

// ---------------------------------------------------------------- 思考寫法協商

/** 上游對這個模型接受哪一種思考寫法。`none` = 它根本不支援思考控制。 */
type ThinkingMode = 'adaptive' | 'manual' | 'none';

interface Quirks {
  mode: ThinkingMode;
  /** 認得的最高檔。作者選了更高的檔就按這個發。 */
  maxDepth: ThinkingDepth;
  /** 「輸出上限太小」那句話已經說過了。同一個模型只說一次。 */
  warnedRoom: boolean;
}

/**
 * 每個「介面地址 + 模型」一份，記在記憶體裡。
 *
 * 這是**上游的事實**（這個模型屬於哪一代思考寫法），不是作者的偏好，寫進
 * 設定頁只會多一個他答不上來的問題。程序重啟後重新問一遍，代價是一次 400。
 */
const QUIRKS = new Map<string, Quirks>();

function quirksOf(baseUrl: string, model: string): Quirks {
  const key = `${baseUrl}|${model}`;
  let q = QUIRKS.get(key);
  if (!q) {
    q = { mode: 'adaptive', maxDepth: 'max', warnedRoom: false };
    QUIRKS.set(key, q);
  }
  return q;
}

/** 這一次請求要帶的思考欄位。`undefined` = 不帶（作者關了，或上游不支援）。 */
interface ThinkingPlan {
  mode: 'adaptive' | 'manual';
  effort?: string;
  budgetTokens?: number;
}

function thinkingPlan(
  options: StreamOptions,
  quirk: Quirks,
  model: string
): ThinkingPlan | undefined {
  const depth = capDepth(options.thinking, quirk.maxDepth);
  if (depth === 'off' || quirk.mode === 'none') {
    return undefined;
  }
  // 思考的 token 算在輸出上限裡：上限太小，模型想完就沒額度說話了。
  // 說一次就夠——每輪都刷會把日誌頁淹掉，而作者能改的地方只有一個。
  if (!quirk.warnedRoom && outputRoomTooSmall(depth, options.maxOutputTokens)) {
    quirk.warnedRoom = true;
    log.warn(
      `${model} 開著「${THINKING_LABEL[depth]}」，但輸出上限只有 ${options.maxOutputTokens} token`,
      '思考的 token 算在輸出上限裡，回答可能被擠短。可在設定頁把這個模型的「輸出上限」調大。'
    );
  }
  if (quirk.mode === 'adaptive') {
    return { mode: 'adaptive', effort: anthropicEffort(depth) };
  }
  const budgetTokens = thinkingBudget(depth, options.maxOutputTokens);
  // 輸出上限太小，預算連 1024 都留不出來（API 的硬下限）——這種情況下
  // 不帶思考欄位，而不是發一個必然 400 的請求。
  return budgetTokens ? { mode: 'manual', budgetTokens } : undefined;
}

function capDepth(depth: ThinkingDepth | undefined, max: ThinkingDepth): ThinkingDepth {
  let d = depth ?? 'off';
  const order: ThinkingDepth[] = ['off', 'low', 'medium', 'high', 'max'];
  while (order.indexOf(d) > order.indexOf(max)) {
    d = downgradeDepth(d);
  }
  return d;
}

/**
 * 400 了：是這一代思考寫法這個模型不認，還是真出錯了？
 *
 * 認出「與思考有關」就把寫法退一步（自適應 → 手動預算 → 不帶），記下來再發
 * 一次。其餘情況返回 false，由呼叫方報 HTTP 錯誤。**只認 400**：401/404/429
 * 與請求體無關，換寫法再發只是白等一次。
 */
function negotiate(status: number, body: string, quirk: Quirks, label: string): boolean {
  if (status !== 400 || quirk.mode === 'none') {
    return false;
  }
  const detail = body.toLowerCase();
  // 「這個 effort 值不認」：先降檔，一路降到底才換寫法——effort 的梯子上
  // 老模型缺的是頂上那兩檔，不是整套。
  if (detail.includes('effort') && quirk.maxDepth !== 'low') {
    quirk.maxDepth = downgradeDepth(quirk.maxDepth);
    log.warn(
      `${label} 不認這一檔思考深度，降到「${THINKING_LABEL[quirk.maxDepth]}」再發一次`,
      detail.slice(0, 200)
    );
    return true;
  }
  if (!detail.includes('thinking') && !detail.includes('effort') && !detail.includes('output_config')) {
    return false;
  }
  quirk.mode = quirk.mode === 'adaptive' ? 'manual' : 'none';
  log.warn(
    quirk.mode === 'manual'
      ? `${label} 不支援自適應思考，改用手動思考預算再發一次`
      : `${label} 不支援思考控制，這一輪不帶思考欄位`,
    detail.slice(0, 200)
  );
  return true;
}

// ---------------------------------------------------------------- 事件

export interface AnthropicEvent {
  type: string;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    /** 只在 `message_delta` 上：`end_turn` / `max_tokens` / … */
    stop_reason?: string;
  };
  message?: { usage?: AnthropicUsage };
  usage?: AnthropicUsage;
  error?: { message?: string };
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface AnthropicMessage {
  role: string;
  content: string;
}

/**
 * `ChatMessage[]` → Anthropic 的 `messages[]`。
 *
 * Anthropic 要求 user/assistant 嚴格交替且首條是 user，相鄰同角色併成一條；
 * system 由頂層欄位帶走，這裡直接跳過。
 */
export function toAnthropicMessages(messages: ChatMessage[]): unknown[] {
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      continue;
    }
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content += `\n\n${m.content}`;
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  if (out.length > 0 && out[0].role !== 'user') {
    out.unshift({ role: 'user', content: '（繼續）' });
  }
  return out;
}
