import {
  THINKING_LABEL,
  ThinkingDepth,
  downgradeDepth,
  outputRoomTooSmall,
  responsesEffort,
} from '../model/thinking';
import { scoped } from '../runtime/logger';
import {
  ChatMessage,
  LlmError,
  LlmProvider,
  StreamEvent,
  StreamOptions,
  iterateSse,
  makeAbortSignal,
  normalizeError,
} from './provider';

const log = scoped('模型');

/**
 * OpenAI 的 **Responses API**（`/responses`）流式實現——Codex 走的那一套。
 *
 * ## 為什麼不是 /chat/completions
 *
 * 思考深度（`reasoning.effort`）只在這條協議上。老的 `/chat/completions` 裡
 * 推理檔位是模型名的一部分或者乾脆沒有，介面上給作者一個「想多深」的下拉框
 * 就無處落地。既然這個功能是本層存在的理由，openai 這種 kind 一律走
 * `/responses`，不再保留兩條協議——兩條並存意味著每個欄位都要判一次「現在是
 * 哪一條」，而作者在設定頁也要先答一道自己答不上來的題。
 *
 * **代價說清楚**：只認 `/chat/completions` 的服務商（DeepSeek、智谱、Kimi、
 * 通义、本地 Ollama 等）在這條路上會 404。它們的落點是配一個自己那側的
 * 相容閘道器，或者用 Anthropic 那種 kind。404 的提示裡點了這件事。
 */
export class OpenAiProvider implements LlmProvider {
  readonly id = 'openai' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey: string
  ) {}

  get label(): string {
    return `${this.model} @ ${hostOf(this.baseUrl)}`;
  }

  async maxInputTokens(): Promise<number | undefined> {
    return undefined; // 以使用者設定的 contextWindow 為準
  }

  async *stream(messages: ChatMessage[], options: StreamOptions): AsyncIterable<StreamEvent> {
    const { signal, dispose, poke } = makeAbortSignal(options);
    try {
      const { instructions, input } = toResponsesInput(messages);
      const quirk = quirksOf(this.baseUrl, this.model);
      let stream: ReadableStream<Uint8Array> | undefined;
      // 上游拒了某個欄位就拿掉它再發（見 negotiate）——**不是重試同一個請求**，
      // 所以次數上限只有三次，且每次的請求體都比上一次少一個欄位。
      for (let attempt = 0; ; attempt += 1) {
        const sent = buildBody(this.model, instructions, input, options, quirk);
        const response = await fetch(`${this.baseUrl}/responses`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(sent),
          signal,
        });
        if (response.ok && response.body) {
          stream = response.body;
          break;
        }
        // 響應體只讀一次：欄位協商要看它，報錯也要看它。
        const detail = await readBody(response);
        // 只為**這一次真帶了**的欄位做協商：沒帶 reasoning 卻按「它不認 effort」
        // 降一檔，等於把一個真正的錯誤推遲兩個來回才報出來。
        if (attempt < 2 && negotiate(response.status, detail, sent, quirk, this.label)) {
          continue;
        }
        throw new LlmError(describeHttpBody(response.status, detail, this.label));
      }
      poke();

      for await (const payload of iterateSse(stream, signal, poke)) {
        let event: ResponsesEvent;
        try {
          event = JSON.parse(payload) as ResponsesEvent;
        } catch {
          continue; // 心跳或非 JSON 行，跳過
        }
        for (const ev of readResponsesEvent(event, this.label)) {
          yield ev;
        }
      }
    } catch (err) {
      throw normalizeError(err, signal, this.label);
    } finally {
      dispose();
    }
  }
}

// ---------------------------------------------------------------- 請求體

/** 上游明確拒過的欄位。同一個模型只吃一次虧，之後每次請求都不再帶它。 */
interface Quirks {
  /** 拒收 `temperature`（推理模型一律如此）。 */
  noTemperature: boolean;
  /** 認得的最高檔。作者選了更高的檔就按這個發。 */
  maxDepth: ThinkingDepth;
  /** 「輸出上限太小」那句話已經說過了。同一個模型只說一次。 */
  warnedRoom: boolean;
}

/**
 * 每個「介面地址 + 模型」一份。
 *
 * 記在記憶體裡而不是配置裡：這是**上游的事實**（這個模型認不認 xhigh），不是
 * 作者的偏好，寫進設定頁只會多一個他答不上來的問題。程序重啟後重新學一遍，
 * 代價是一次 400。
 */
const QUIRKS = new Map<string, Quirks>();

function quirksOf(baseUrl: string, model: string): Quirks {
  const key = `${baseUrl}|${model}`;
  let q = QUIRKS.get(key);
  if (!q) {
    q = { noTemperature: false, maxDepth: 'max', warnedRoom: false };
    QUIRKS.set(key, q);
  }
  return q;
}

function buildBody(
  model: string,
  instructions: string,
  input: unknown[],
  options: StreamOptions,
  quirk: Quirks
): Record<string, unknown> {
  const depth = capDepth(options.thinking, quirk.maxDepth);
  const effort = responsesEffort(depth);
  warnRoom(depth, options.maxOutputTokens, quirk, model);
  return {
    model,
    input,
    ...(instructions ? { instructions } : {}),
    max_output_tokens: options.maxOutputTokens,
    stream: true,
    // 不讓上游存這次對話：歷史由本地會話檔案負責，服務端再存一份只是
    // 多一個副本。
    store: false,
    ...(effort
      ? {
          // summary: 'auto' 才會有 reasoning_summary 的增量——介面上那段
          // 「正在思考」靠它，沒有它作者只能對著空氣等幾十秒。
          reasoning: { effort, summary: 'auto' },
        }
      : {}),
    // 推理模型拒收 temperature。思考開著時一律不帶（它必然是推理模型），
    // 關著時帶上——非推理模型上它仍然是有效的文風旋鈕。
    ...(effort || quirk.noTemperature ? {} : { temperature: options.temperature }),
  };
}

/**
 * 思考的 token 算在輸出上限裡：上限太小，模型想完就沒額度說話了。
 * 說一次就夠——每輪都刷會把日誌頁淹掉，而作者能改的地方只有一個。
 */
function warnRoom(depth: ThinkingDepth, maxOutputTokens: number, quirk: Quirks, model: string): void {
  if (quirk.warnedRoom || !outputRoomTooSmall(depth, maxOutputTokens)) {
    return;
  }
  quirk.warnedRoom = true;
  log.warn(
    `${model} 開著「${THINKING_LABEL[depth]}」，但輸出上限只有 ${maxOutputTokens} token`,
    '思考的 token 算在輸出上限裡，回答可能被擠短。可在設定頁把這個模型的「輸出上限」調大。'
  );
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
 * 400 了：是我們帶了它不認的欄位，還是真出錯了？
 *
 * 返回 true 表示「已經把那個欄位記下來了，換一份請求體再發一次」。其餘情況
 * 返回 false，由呼叫方按 HTTP 錯誤報出來。**只認 400**：401/404/429 與欄位
 * 無關，改請求體再發只是白等一次。
 */
function negotiate(
  status: number,
  body: string,
  sent: Record<string, unknown>,
  quirk: Quirks,
  label: string
): boolean {
  if (status !== 400) {
    return false;
  }
  const detail = body.toLowerCase();
  if ('temperature' in sent && detail.includes('temperature') && !quirk.noTemperature) {
    quirk.noTemperature = true;
    return true;
  }
  // 「不認這個 effort 值」：新梯子上的 xhigh 老模型沒有。降一檔再試，
  // 一路降到不帶 reasoning 為止——降級過的檔位會記住，不會每輪都撞一次。
  if (
    'reasoning' in sent &&
    (detail.includes('effort') || detail.includes('reasoning')) &&
    quirk.maxDepth !== 'off'
  ) {
    quirk.maxDepth = downgradeDepth(quirk.maxDepth);
    log.warn(
      `${label} 不認這一檔思考深度，降到「${THINKING_LABEL[quirk.maxDepth]}」再發一次`,
      detail.slice(0, 200)
    );
    return true;
  }
  return false;
}


// ---------------------------------------------------------------- 訊息轉換

/**
 * `ChatMessage[]` → Responses 的 `instructions` + `input[]`。
 *
 * 與 chat/completions 不同的一處：**system 走 `instructions` 頂層欄位**，
 * 不再是 input 裡的一條訊息。
 */
export function toResponsesInput(messages: ChatMessage[]): {
  instructions: string;
  input: unknown[];
} {
  const systems: string[] = [];
  const input: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systems.push(m.content);
    } else if (m.role === 'assistant') {
      if (m.content) {
        input.push({ role: 'assistant', content: m.content });
      }
    } else {
      input.push({ role: 'user', content: m.content });
    }
  }
  return { instructions: systems.join('\n\n'), input };
}

// ---------------------------------------------------------------- 事件解析

/** Responses 流裡的一條事件。欄位按 `type` 各取所需，認不出的型別一律忽略。 */
export interface ResponsesEvent {
  type?: string;
  delta?: string;
  response?: {
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string };
    /** `completed` / `incomplete` / ……。有的閘道器在 `response.completed` 裡也寫 `incomplete`。 */
    status?: string;
    /** 只在 `response.incomplete` 上：`max_output_tokens` / `content_filter`。 */
    incomplete_details?: { reason?: string };
  };
  message?: string;
  error?: { message?: string };
}

/**
 * 一條事件 → 若干 `StreamEvent`。
 *
 * **認不出的型別一律忽略**：這條協議的事件種類有二十來個（item 的增刪、
 * 各種 `.done`、註解、內容部分的開合），我們只關心其中幾類。為未知型別報錯
 * 會讓上游加一個新事件就炸掉整輪生成。
 */
export function readResponsesEvent(event: ResponsesEvent, label: string): StreamEvent[] {
  const out: StreamEvent[] = [];
  switch (event.type) {
    case 'response.output_text.delta':
      if (event.delta) {
        out.push({ type: 'text', text: event.delta });
      }
      return out;
    // 思考的兩種流法：給人看的摘要（summary: 'auto' 才有），以及少數模型
    // 直接吐的推理正文。兩者都不是正文，走 reasoning 事件給介面。
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta':
      if (event.delta) {
        out.push({ type: 'reasoning', text: event.delta });
      }
      return out;
    case 'response.completed':
    case 'response.incomplete': {
      const usage = event.response?.usage;
      if (usage) {
        out.push({
          type: 'usage',
          usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
        });
      }
      // `completed` 也要報 `end`：正文續寫鏈（generation/continuation.ts）要分清「模型自己收了尾」
      // 與「閘道器沒說」——前者說明這一章已經收了尾，不夠八成時先回退再寫（五期補遺 §1.1），
      // 後者不敢回退。
      if (event.type === 'response.incomplete' || event.response?.status === 'incomplete') {
        const reason = event.response?.incomplete_details?.reason;
        out.push({ type: 'stop', reason: reason === 'max_output_tokens' ? 'maxTokens' : 'other' });
      } else {
        out.push({ type: 'stop', reason: 'end' });
      }
      return out;
    }
    case 'response.failed':
      throw new LlmError(`${label} 返回錯誤：${event.response?.error?.message ?? '未知錯誤'}`);
    case 'error':
      throw new LlmError(`${label} 返回錯誤：${event.error?.message ?? event.message ?? '未知錯誤'}`);
    default:
      return out;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export async function describeHttpError(response: Response, label: string): Promise<string> {
  return describeHttpBody(response.status, await readBody(response), label);
}

/** 響應體讀一次就沒了，所以讀它的地方只有這一個。讀不出來當空字串。 */
export async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/** 已經讀出來的響應體 → 一句人話。兩家 provider 共用。 */
export function describeHttpBody(
  status: number,
  body: string,
  label: string,
  /**
   * 這一家打的是哪個介面。404 那句提示要指名道姓——兩條協議共用這個函式，
   * 而對著 Anthropic 那條路說「沒有 /responses 介面」會把人往反方向帶。
   */
  endpoint = '/responses'
): string {
  let detail = body;
  try {
    const json = JSON.parse(body) as { error?: { message?: string }; message?: string };
    detail = json.error?.message ?? json.message ?? body;
  } catch {
    /* 不是 JSON 就原樣用 */
  }
  detail = detail.slice(0, 400);

  const hint =
    status === 401 || status === 403
      ? '（API Key 可能無效，可在設定頁重新錄入該服務商的 Key）'
      : status === 404
        ? `（介面地址或模型名可能填錯了；也可能是這個服務商沒有 ${endpoint} 介面——` +
          '只認 /chat/completions 的服務商請配它自己那側的相容閘道器）'
        : status === 429
          ? '（觸發限流，稍後再試）'
          : '';

  return `${label} 返回 HTTP ${status}${hint}${detail ? `：${detail}` : ''}`;
}
