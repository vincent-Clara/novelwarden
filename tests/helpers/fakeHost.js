/**
 * 可程式設計的假宿主。
 *
 * `src/core/host.ts` 的 `Host` 是 core 對宿主的唯一依賴面，互動方法
 * （input / confirm / pick / reviewReplace）在測試裡按**佇列**取答案：
 * 排了什麼就答什麼，沒排隊就當使用者取消（返回 undefined）。
 *
 * 用法：
 *   const h = makeFakeHost();          // 基線：全部當使用者取消
 *   bundle.host.initHost(h.host);
 *   h.expect('確定');                   // 下一次 confirm 答「確定」
 *   ...
 *   assert.ok(!h.erred());             // 沒有 error 級 toast
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} [opts]
 * @param {'vscode'|'standalone'} [opts.name]
 * @param {boolean} [opts.supportsVscodeLm]
 * @param {object|(() => object)} [opts.settings] `config.read()` 的返回值
 * @param {object} [opts.overrides] 直接覆蓋 Host 上的任意方法
 */
function makeFakeHost(opts = {}) {
  const {
    name = 'standalone',
    supportsVscodeLm = false,
    settings,
    overrides = {},
  } = opts;

  /** 互動答案佇列：input / confirm / pick / reviewReplace 共用。 */
  const answers = [];
  /** 錄製器 */
  const toasts = [];
  const confirms = [];
  const picks = [];
  const inputs = [];
  const reviewed = [];
  const opened = [];
  const progressCalls = [];

  /** reviewReplace 的預設結論；用例可改成 'discard' / undefined。 */
  const state = { reviewVerdict: 'apply' };

  /** 併發觀察：同一時刻在跑的 reviewReplace 數與峰值。 */
  let reviewInFlight = 0;
  let reviewPeak = 0;
  /** reviewReplace 裡的人為延時，用來讓重入真的可觀察。 */
  let reviewDelayMs = 0;

  // 刪修飾預設開、每章多一次呼叫：假模型的回放指令碼都是按「寫 + 續寫」排的，這裡預設關掉，
  // 測刪修飾的用例自己傳 `trimModifiers: true`。
  const readSettings = () => ({
    trimModifiers: false,
    ...(typeof settings === 'function' ? settings() : settings ?? {}),
  });

  const host = {
    name,
    supportsVscodeLm,
    config: { read: readSettings, write: async () => {} },

    input: async (o) => {
      inputs.push(o);
      return answers.shift();
    },
    confirm: async (message, actions, o) => {
      confirms.push({ message, actions, detail: o && o.detail });
      return answers.shift();
    },
    // 調模型之前的那一問（Host.confirmCall）：與 confirm 共用答案佇列，錄進 `confirms`（多一個 `call`：兩個下拉框的
    // 選項與預設）。排的是字串 = 點那顆按鈕、下拉框不動（回的是開啟時的預設，同真宿主）；排 `{ action, choice }` =
    // 作者另挑了模型 / 詳細度。
    confirmCall: async (message, actions, o) => {
      confirms.push({ message, actions, detail: o.detail, call: o.call });
      const a = answers.shift();
      if (a === undefined) return undefined;
      if (typeof a !== 'string') return a;
      const { model, contextDetail } = o.call;
      return { action: a, choice: { ...(model ? { model } : {}), ...(contextDetail ? { contextDetail } : {}) } };
    },
    pick: async (choices, title) => {
      picks.push({ choices, title });
      return answers.shift();
    },
    progress: async (title, fn) => {
      const abort = new AbortController();
      return fn(abort.signal, (m) => progressCalls.push(`${title}｜${m}`));
    },
    watch: () => ({ dispose: () => {} }),
    openFile: async (p) => { opened.push(p); },
    toast: (m, level) => toasts.push(`${level ?? 'info'}: ${m}`),
    selectionAttachment: async () => undefined,
    // 回答可以是 'apply' / 'discard' / undefined，也可以是一個函式（按這一次的兩個版本算出回答，
    // 比如交回 `{ merged }`，測獨立版合併檢視那條路）。`opts.merge` 記下來：只有閘道器的覆蓋審閱請求合併。
    reviewReplace: async (n, current, proposed, relPath, opts) => {
      reviewInFlight++;
      reviewPeak = Math.max(reviewPeak, reviewInFlight);
      reviewed.push({ name: n, current, proposed, relPath, merge: !!opts?.merge });
      if (reviewDelayMs) await sleep(reviewDelayMs);
      reviewInFlight--;
      const v = state.reviewVerdict;
      return typeof v === 'function' ? v({ name: n, current, proposed, relPath, opts }) : v;
    },

    ...overrides,
  };

  return {
    host,
    answers, toasts, confirms, picks, inputs, reviewed, opened, progressCalls,

    /** 排隊下一批答案，同時清空上一輪的錄製。 */
    expect(...values) {
      answers.length = 0;
      toasts.length = 0;
      confirms.length = 0;
      picks.length = 0;
      inputs.length = 0;
      reviewed.length = 0;
      opened.length = 0;
      answers.push(...values);
    },
    /** 這一輪是否出現過 error 級 toast。 */
    erred() {
      return toasts.some((t) => t.startsWith('error:'));
    },
    setReviewVerdict(v) { state.reviewVerdict = v; },
    setReviewDelay(ms) { reviewDelayMs = ms; },
    reviewPeak: () => reviewPeak,
    resetPeaks() { reviewPeak = 0; reviewInFlight = 0; },
  };
}

module.exports = { makeFakeHost, sleep };
