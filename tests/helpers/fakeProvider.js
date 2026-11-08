/**
 * 假模型。
 *
 * 一律經 `registry.registerProviderFactory` 注入，並把服務商 `kind` 設成
 * `vscode-lm`：那是唯一一條走 factory 的路徑，於是**不必碰 SecretStore** 就能塞進
 * 假模型（其餘 kind 會去要 API Key，測試裡會卡在輸入框上）。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 一條應答可以是純字串（老用法），也可以是一個物件：
 *
 *   { text, stop?, reasoning?, chunks?, usage? }
 *
 * - `stop`：跟在正文之後發一條 `{ type: 'stop', reason }`（'end' / 'maxTokens' / 'other'）。
 *   續寫要靠它區分「模型說完了」與「被輸出上限截斷」。不給就不發，與真實 provider
 *   裡有的閘道器不報收尾原因一致。
 * - `reasoning`：先發一段思考，再發正文——測「思考把輸出預算吃光」要用。
 * - `chunks`：把正文切成幾片分別 yield，測流式拼接。
 * - `usage`：`{ inputTokens?, outputTokens? }`，照 Anthropic 的樣子分兩條發——正文之前一條只帶輸入、
 *   正文之後一條只帶輸出（同一次請求裡要按欄位合併，不能相加）。不給就不發，與不報用量的閘道器一致。
 */
function normalizeReply(item) {
  return typeof item === 'object' && item !== null ? item : { text: item ?? '' };
}

async function* emit(item) {
  const r = normalizeReply(item);
  if (r.usage?.inputTokens !== undefined) {
    yield { type: 'usage', usage: { inputTokens: r.usage.inputTokens } };
  }
  if (r.reasoning) {
    yield { type: 'reasoning', text: r.reasoning };
  }
  const text = r.text ?? '';
  const n = Math.max(1, r.chunks ?? 1);
  const size = Math.ceil(text.length / n) || 1;
  for (let i = 0; i < text.length; i += size) {
    yield { type: 'text', text: text.slice(i, i + size) };
  }
  if (!text.length && !r.reasoning) {
    yield { type: 'text', text: '' };
  }
  if (r.usage?.outputTokens !== undefined) {
    yield { type: 'usage', usage: { outputTokens: r.usage.outputTokens } };
  }
  if (r.stop) {
    yield { type: 'stop', reason: r.stop };
  }
}

/**
 * 造一段恰好 `n` 個字的中文正文，用來測字數門檻（「不到八成就續寫」）。
 * `seed` 讓不同輪的內容不重樣——重演檢測按 n-gram 認，重樣的填充會被當成重演。
 * 末尾帶一個句號（不計字數）：不收在句末標點上的正文會被當成停在半句上、自動續寫。
 */
function filler(n, seed = 0) {
  const pool = '天地玄黃宇宙洪荒日月盈昃辰宿列張寒來暑往秋收冬藏閏餘成歲律呂調陽雲騰致雨露結為霜金生麗水玉出昆岡劍號巨闕珠稱夜光果珍李柰菜重芥姜';
  // 線性同餘：確定性、不同 seed 出不同序列。按固定步長輪轉的話，不同 seed
  // 只是同一圈的不同起點，8-gram 大面積重合，會被重演檢測誤判。
  let x = (seed + 1) * 2654435761 >>> 0;
  let out = '';
  while (out.length < n) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out += pool[(x >>> 16) % pool.length];
  }
  return `${out}。`;
}

/**
 * @param {object} registry 載入的 `src/core/llm/registry.ts`
 * @param {object} [opts]
 * @param {Array<string|object>} [opts.replies] 應答佇列（每條的形狀見 `normalizeReply`）
 * @param {boolean} [opts.repeatLast] 佇列見底後重複最後一條（預設 false：改用 fallback）
 * @param {string|object} [opts.fallback] 佇列空時的應答
 * @param {(messages, index) => string|object} [opts.reply] 直接給一個函式，優先於 replies
 * @param {Record<string, 'unavailable'|'fail'|'cancel'>} [opts.behavior] 按模型引用注入異常
 * @param {number} [opts.delayMs] 每次呼叫的人為延時——不留延時的話併發與序列跑出來一樣
 * @param {object} [opts.errors] `{ LlmError, CancelledError }`，用到 behavior 時必須給
 */
function installFakeProvider(registry, opts = {}) {
  const {
    replies = [],
    repeatLast = false,
    fallback = '',
    reply,
    behavior = {},
    delayMs = 0,
    errors = {},
  } = opts;

  /** 每次呼叫的完整 messages，用來斷言「裝了什麼進上下文」「調了幾次」。 */
  const calls = [];
  const queue = [...replies];

  /** 併發觀察：同一時刻在跑的請求數與峰值。 */
  let inFlight = 0;
  let peak = 0;

  registry.registerProviderFactory((active) => {
    const spec = behavior[active && active.ref];
    if (spec === 'unavailable') return undefined;
    return {
      id: 'vscode-lm',
      label: (active && active.ref) || '假模型',
      maxInputTokens: async () => undefined,
      stream: async function* (messages) {
        calls.push(messages);
        if (active) calls[calls.length - 1].ref = active.ref;
        inFlight++;
        peak = Math.max(peak, inFlight);
        try {
          if (spec === 'fail') {
            throw new errors.LlmError(`${active.ref} 假裝 429 限流`);
          }
          if (spec === 'cancel') {
            throw new errors.CancelledError();
          }
          if (delayMs) await sleep(delayMs);
          if (reply) {
            yield* emit(reply(messages, calls.length - 1));
            return;
          }
          const next = repeatLast && queue.length <= 1 ? queue[0] : queue.shift();
          yield* emit(next ?? fallback);
        } finally {
          inFlight--;
        }
      },
    };
  });

  return {
    calls,
    /** 往佇列後面補應答。 */
    push: (...items) => queue.push(...items),
    /** 重排佇列。 */
    reset(items = []) {
      queue.length = 0;
      queue.push(...items);
      calls.length = 0;
      peak = 0;
    },
    peak: () => peak,
    callCount: () => calls.length,
  };
}

/**
 * 一份最小可用的設定：一個假服務商、一個模型。
 * `contextWindow` 調小可以逼出多批切分。
 */
function makeSettings(extra = {}) {
  return {
    providers: [{ id: 'fake', kind: 'vscode-lm', models: [{ name: 'm' }] }],
    models: ['fake/m'],
    contextWindow: 12000,
    maxOutputTokens: 500,
    concurrency: 1,
    ...extra,
  };
}

/** 認故事時間那一次的系統提示（features/timePrompt.ts 的開頭）：同步一章時單獨一次（2026-10-24 重做）。 */
const TIME_MARK = '你是小說的時間校對員';

/**
 * 認故事時間的最小應答：送來的每一章都「緊接上一章」（同一天、沒有依據）。不關心時間的測試在自己的應答裡接上它，
 * 同步就不會因為這一次答不上來掛黃 ❗。
 */
function timeReply(messages) {
  const user = messages[messages.length - 1]?.content ?? '';
  const nos = [...user.matchAll(/【第(\d+)章 /g)].map((m) => Number(m[1]));
  return JSON.stringify({ times: nos.map((chapter) => ({ chapter, days: 0, reason: '緊接上一章' })) });
}

module.exports = { installFakeProvider, makeSettings, sleep, filler, TIME_MARK, timeReply };
