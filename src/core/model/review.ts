import { traditionalLabel } from './labels';
/**
 * 審稿報告（五期）：一次呼叫出一份逐條引證的報告，本章細綱凍結成目標清單逐項核對。
 *
 * **純型別 + 純函式，零 import**（與 pipeline.ts 同類）：前端要拿同一份定位函式去編輯器裡
 * 選中引文（「點引文就在編輯器裡定位到那句」），報告卡上的標籤與預設勾選也得與後端同源。
 *
 * 移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）：
 *
 * - JSON 合同與長度上限：`review-chapter.command.ts`（RV:36-119）、`consistency_check`
 *   模板的 systemSuffix（PT:917-970）；
 * - 目標凍結與逐項核對：`shared/chapter-goal-review.ts`（`freezeChapterGoals` /
 *   `normalizeChapterGoalReview`，:24-115）；
 * - 修稿清單：`shared/human-confirmed-review.ts` 的 `renderHumanConfirmedReviewBrief`（:202-252）。
 *
 * ## 與上游不同的兩處（五期計劃 §3 ⚑）
 *
 * 1. **引文歸一化之後再找。** 上游只容忍多出一對引號——模型抄原文時改一個逗號、並一個空格，
 *    那一句就認不出了。這裡 NFKC、去掉全部空白與標點符號之後比。歸一後不到
 *    {@link MIN_QUOTE_CHARS} 個字的引文當「找不到」：兩三個字到處都能命中，證明不了什麼。
 * 2. **普通問題的引文找不到就丟掉。** 上游只校驗目標核對的引文，普通問題原樣留著。沒有原文
 *    撐著的「問題」多半是模型編的——留著，作者會照著去改一段根本不存在的話。丟了哪幾條
 *    留在報告裡（`dropped`），卡片上摺疊列出（第 2 條）。
 */

// ---------------------------------------------------------------- 型別

/** 可以修的兩檔。`pass`（這一維查過、沒問題）不是問題，單獨收著。 */
export type ReviewSeverity = 'error' | 'warning';

export const SEVERITY_LABEL: Record<ReviewSeverity, string> = {
  error: '嚴重',
  warning: '建議',
};

/**
 * 一條問題。`quote` 是正文裡找得到的那一句（模型給的原樣，不是歸一形）。
 *
 * 報告卡的編輯模式（五期補遺 §3）：`origin: 'author'` 是作者自己加的（引文可以空著）；`edited`
 * 是模型給的、作者改過的（改引文時找不到就保留原來那一句）。
 */
export interface ReviewIssue {
  id: string;
  category: string;
  severity: ReviewSeverity;
  quote: string;
  description: string;
  origin?: 'author';
  edited?: boolean;
}

/** 查過、沒發現問題的一維。只展示，不能勾。 */
export interface ReviewPass {
  category: string;
  description: string;
}

/** 因為引文站不住而丟掉的問題。卡片上摺疊列出——丟了什麼要看得見。 */
export interface DroppedIssue {
  category: string;
  severity: ReviewSeverity;
  description: string;
  quote?: string;
  why: string;
}

/**
 * 目標核對的三種結論。**「沒寫到」只能是 `unknown`**：`unmet` 要有正文證據（明確的延期、
 * 拒絕或相反結果），拿不出證據的一律降成待核實（上游 `chapter-goal-review.ts:50-52`）。
 */
export type GoalStatus = 'completed' | 'unmet' | 'unknown';

export const GOAL_STATUS_LABEL: Record<GoalStatus, string> = {
  completed: '已完成',
  unmet: '未完成',
  unknown: '待核實',
};

/**
 * 凍結的一專案標：本章細綱「關鍵事件」裡的一條（與上游一樣只凍結 keyEvents）。從前細綱單列的
 * 「章末鉤子」也凍結成最後一項；它並進「看點」之後，看點裡還有爽點，不是一件件到期的動作，不凍結。
 */
export interface FrozenGoal {
  id: string;
  text: string;
}

export interface ReviewGoal extends FrozenGoal {
  status: GoalStatus;
  /** 模型給的逐個子動作的判斷；降級時換成一句「請人工核實」。 */
  judgment: string;
  /** 找得到的引文。降級時清空。 */
  quotes: string[];
}

/**
 * 目標核對完不完整：`complete` 每一項都有且只有一份判斷；`partial` 有漏項、重複或認不出的 id；
 * `none` 本章細綱裡沒有可核對的關鍵事件。**完整不等於全部完成。**
 */
export type GoalCoverage = 'complete' | 'partial' | 'none';

export interface ReviewReport {
  chapterNo: number;
  chapterTitle?: string;
  /** 審的是哪一份正文。點引文要開啟它，修稿要讀它。 */
  chapterRelPath: string;
  /** 審稿那一刻正文的指紋。修稿時對不上就重新定位每一條勾選項（{@link relocatePicks}）。 */
  chapterHash: string;
  summary: string;
  issues: ReviewIssue[];
  passes: ReviewPass[];
  goals: ReviewGoal[];
  coverage: GoalCoverage;
  dropped: DroppedIssue[];
}

// ---------------------------------------------------------------- 長度上限

/** 上游 RV:36-38：總評、每條說明、每句引文的上限（按字元數，不按位元組）。 */
export const REVIEW_SUMMARY_MAX = 120;
export const REVIEW_DESCRIPTION_MAX = 200;
export const REVIEW_QUOTE_MAX = 160;
/** 一份報告最多幾條（上游 1–10 條，含通過項）。 */
export const REVIEW_ITEMS_MAX = 10;
/** 引文歸一之後至少這麼多字才認（見檔案頭）。 */
export const MIN_QUOTE_CHARS = 4;

// ---------------------------------------------------------------- 目標凍結

/**
 * 本章細綱凍結成目標清單。關鍵事件**只按顯式的邊界切**：換行與分號（`；` `;`），行首的
 * 列表記號去掉，不按句號切、不改寫一個字（上游 `freezeChapterGoals` 同一條：
 * 「only explicit list boundaries are split; prose is not semantically rewritten」）。
 * 一整段寫成的關鍵事件就是一項，模型在判斷裡逐個列子動作。
 *
 * id 從 `g1` 起按順序編。
 */
export function freezeGoals(keyEvents: string): FrozenGoal[] {
  return (keyEvents ?? '')
    .split(/\r?\n|[；;]/u)
    .map((t) => t.replace(/^\s*(?:[-*•·]|\d+[.)、．])\s*/u, '').trim())
    .filter((t) => t && !isPlaceholder(t))
    .map((text, i) => ({ id: `g${i + 1}`, text }));
}

function isPlaceholder(text: string): boolean {
  return /^[（(]待(?:补|補)充[）)]$/u.test(text.trim());
}

/** 交給模型的凍結清單：一項一行「- g1：目標原文」（2026-10-25 起審稿寫自然語言，清單也不再是一段 JSON）。 */
export function frozenGoalsList(goals: readonly FrozenGoal[]): string {
  return goals.map((g) => `- ${g.id}：${g.text}`).join('\n');
}

// ---------------------------------------------------------------- 引文

/**
 * 一個字元的歸一形：NFKC、小寫、去掉空白與標點符號。**逐個碼點做**——定位時要把歸一形裡的
 * 位置對映回原文，整串 NFKC 之後就對不回去了。中文不受影響（NFKC 對漢字是恆等的）。
 */
function normChar(ch: string): string {
  return ch.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

/** 一段文字的歸一形（引文校驗與定位共用這一個）。 */
export function normalizeQuote(text: string): string {
  let out = '';
  for (const ch of text ?? '') {
    out += normChar(ch);
  }
  return out;
}

/** 一份正文的歸一形與「歸一形第 k 個字在原文裡從哪開始、到哪結束」。 */
export interface QuoteIndex {
  norm: string;
  starts: number[];
  ends: number[];
}

export function indexText(text: string): QuoteIndex {
  let norm = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  for (const ch of text ?? '') {
    const n = normChar(ch);
    for (let k = 0; k < n.length; k++) {
      starts.push(i);
      ends.push(i + ch.length);
    }
    norm += n;
    i += ch.length;
  }
  return { norm, starts, ends };
}

/** 引文在這份正文裡找不找得到（歸一之後，至少 {@link MIN_QUOTE_CHARS} 個字）。 */
export function quoteFound(index: QuoteIndex, quote: string): boolean {
  const q = normalizeQuote(quote);
  return q.length >= MIN_QUOTE_CHARS && index.norm.includes(q);
}

/**
 * 引文在原文裡的位置 `{ start, end }`（UTF-16 下標，`end` 不含）。找不到是 undefined。
 * 編輯器選中它、VS Code 的 `revealRange` 都用這一份——與校驗同一個歸一化，
 * 報告裡說找得到的，點下去就一定定位得到。
 */
export function locateQuote(text: string, quote: string): { start: number; end: number } | undefined {
  const q = normalizeQuote(quote);
  if (q.length < MIN_QUOTE_CHARS) {
    return undefined;
  }
  const index = indexText(text);
  const at = index.norm.indexOf(q);
  if (at < 0) {
    return undefined;
  }
  return { start: index.starts[at], end: index.ends[at + q.length - 1] };
}

// ---------------------------------------------------------------- 解析

/** 模型交回來的一條，還沒校驗。 */
export interface RawReviewItem {
  category: string;
  severity: ReviewSeverity | 'pass';
  quote: string;
  description: string;
}

export interface RawGoalReview {
  id: string;
  status: string;
  description: string;
  quotes: string[];
}

export interface RawReview {
  summary: string;
  items: RawReviewItem[];
  /** 缺席 = 模型根本沒交目標核對（與交了一個空陣列不同：前者整張清單都待核實）。 */
  goalReviews?: RawGoalReview[];
  /** 解析時順手做的修整：截斷了幾處、跳過了幾條認不出的。 */
  warnings: string[];
}

/**
 * 讀審稿 JSON（2026-10-25 起是轉寫模型照抄出來的那份，generation/review.ts；模型自己給了 JSON、老會話也走這裡）。
 * **寬鬆**（第 1 條：模型不聽話是常態）：認程式碼圍欄、認前後多餘的話
 * （取第一個 `{` 到最後一個 `}`）、`critical / severe` 當嚴重、`minor / warn` 當建議，結論認中文詞，
 * 單條壞了跳過那一條。只有「根本不是 JSON 物件」或「沒有 items 陣列」才算不合格——
 * 那時審稿鏈先重轉、還不行再按格式重寫一次（generation/review.ts）。
 */
export function parseReviewJson(raw: string): { ok: true; value: RawReview } | { ok: false; reason: string } {
  const text = (raw ?? '').trim().replace(/^```(?:json)?[ \t]*\r?\n?/iu, '').replace(/\r?\n?```\s*$/u, '');
  const from = text.indexOf('{');
  const to = text.lastIndexOf('}');
  if (from < 0 || to <= from) {
    return { ok: false, reason: '輸出裡沒有 JSON 物件' };
  }
  let root: unknown;
  try {
    root = JSON.parse(text.slice(from, to + 1));
  } catch {
    return { ok: false, reason: 'JSON 解析失敗' };
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    return { ok: false, reason: '根不是一個物件' };
  }
  const o = root as Record<string, unknown>;
  if (!Array.isArray(o.items)) {
    return { ok: false, reason: '缺少 items 陣列' };
  }
  const warnings: string[] = [];
  let clipped = 0;
  const clip = (value: unknown, max: number): string => {
    const s = typeof value === 'string' ? value.trim() : '';
    const chars = Array.from(s);
    if (chars.length > max) {
      clipped++;
      return chars.slice(0, max).join('');
    }
    return s;
  };

  const items: RawReviewItem[] = [];
  let skipped = 0;
  for (const entry of o.items) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const severity = normalizeSeverity(e.severity);
    const description = clip(e.description, REVIEW_DESCRIPTION_MAX);
    if (!severity || !description) {
      skipped++;
      continue;
    }
    items.push({
      category: clip(e.category, 40) || '其他',
      severity,
      quote: clip(e.quote, REVIEW_QUOTE_MAX),
      description,
    });
  }
  if (skipped > 0) {
    warnings.push(`${skipped} 條認不出嚴重度或沒有說明，已跳過`);
  }

  let goalReviews: RawGoalReview[] | undefined;
  if (Array.isArray(o.goalReviews)) {
    goalReviews = o.goalReviews.map((entry) => {
      const g = (entry ?? {}) as Record<string, unknown>;
      const evidence = Array.isArray(g.evidence) ? g.evidence : [];
      return {
        id: typeof g.id === 'string' ? g.id.trim() : String(g.id ?? ''),
        status: normalizeStatus(g.status),
        description: clip(g.description, REVIEW_DESCRIPTION_MAX * 2),
        quotes: evidence
          .map((x) => (typeof x === 'string' ? x : (x as { quote?: unknown } | null)?.quote))
          .map((q) => clip(q, REVIEW_QUOTE_MAX))
          .filter(Boolean),
      };
    });
  }
  const summary = clip(o.summary, REVIEW_SUMMARY_MAX);
  if (clipped > 0) {
    warnings.push(`${clipped} 處超長的總評、說明或引文已按上限截斷`);
  }
  return { ok: true, value: { summary, items, ...(goalReviews ? { goalReviews } : {}), warnings } };
}

function normalizeSeverity(value: unknown): ReviewSeverity | 'pass' | undefined {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (s === 'error' || s === 'critical' || s === 'severe' || s === '严重') {
    return 'error';
  }
  if (s === 'warning' || s === 'warn' || s === 'minor' || s === '建议') {
    return 'warning';
  }
  if (s === 'pass' || s === 'ok' || s === '通过') {
    return 'pass';
  }
  return undefined;
}

/** 目標核對的結論：程式碼原樣（小寫），轉寫漏對的中文詞也認（報告卡上的說法，{@link GOAL_STATUS_LABEL}）。 */
function normalizeStatus(value: unknown): string {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const zh = (Object.keys(GOAL_STATUS_LABEL) as GoalStatus[]).find((k) => traditionalLabel(GOAL_STATUS_LABEL[k]) === traditionalLabel(s));
  return zh ?? s;
}

// ---------------------------------------------------------------- 校驗

/** 降級時那一項的判斷換成這一句（上游同一句的意思）。 */
export const GOAL_UNVERIFIED = '這一項缺少有效的逐項判斷或可定位的正文證據，請人工核實。';

/**
 * 校驗一份報告：普通問題的引文找不到就丟；目標逐項核對，站不住的降成待核實。返回報告與
 * 一路上的說明（進 Draft 的 notes，第 2 條）。
 *
 * 目標核對的規矩（上游 `normalizeChapterGoalReview`）：
 *
 * - 一專案標恰好一份判斷才算數；漏了、重複了 → 這一項待核實，覆蓋記 `partial`；
 * - 認不出的 id → 覆蓋記 `partial`（不算進任何一項）；
 * - `completed` / `unmet` 必須至少有一句找得到的引文；**任何一句找不到**，整項降成待核實、
 *   引文清空、判斷換成 {@link GOAL_UNVERIFIED}——剩下幾句找得到的也救不回它（上游測試 :101）。
 */
export function verifyReview(
  raw: RawReview,
  ctx: { text: string; goals: readonly FrozenGoal[]; chapterNo: number; chapterTitle?: string; chapterRelPath: string; chapterHash: string }
): { report: ReviewReport; notes: string[] } {
  const notes = [...raw.warnings];
  const index = indexText(ctx.text);
  const issues: ReviewIssue[] = [];
  const passes: ReviewPass[] = [];
  const dropped: DroppedIssue[] = [];

  let over = 0;
  for (const item of raw.items) {
    if (issues.length + passes.length >= REVIEW_ITEMS_MAX) {
      over++;
      continue;
    }
    if (item.severity === 'pass') {
      passes.push({ category: item.category, description: item.description });
      continue;
    }
    const base = { category: item.category, severity: item.severity, description: item.description };
    if (!item.quote) {
      dropped.push({ ...base, why: '沒有給引文' });
      continue;
    }
    if (!quoteFound(index, item.quote)) {
      dropped.push({
        ...base,
        quote: item.quote,
        why: normalizeQuote(item.quote).length < MIN_QUOTE_CHARS ? `引文太短（不到 ${MIN_QUOTE_CHARS} 個字），認不出是哪一句` : '引文在正文裡找不到',
      });
      continue;
    }
    issues.push({ id: `i${issues.length + 1}`, ...base, quote: item.quote });
  }
  if (over > 0) {
    notes.push(`報告超過 ${REVIEW_ITEMS_MAX} 條，後面 ${over} 條沒有收`);
  }
  if (dropped.length > 0) {
    notes.push(
      `丟掉 ${dropped.length} 條引文站不住的意見（${dropped.map((d) => `「${clipText(d.description, 24)}」${d.why}`).join('；')}）`
    );
  }

  const { goals, coverage, downgraded } = verifyGoals(raw.goalReviews, ctx.goals, index);
  if (coverage === 'none') {
    notes.push('本章細綱裡沒有可核對的關鍵事件，沒有做目標核對');
  } else if (coverage === 'partial') {
    notes.push('目標核對不完整：模型漏了、重複了或寫錯了某幾項的 id，那幾項按待核實處理');
  }
  if (downgraded > 0) {
    notes.push(`${downgraded} 專案標的判斷沒有可定位的正文證據，降成待核實`);
  }

  return {
    report: {
      chapterNo: ctx.chapterNo,
      ...(ctx.chapterTitle ? { chapterTitle: ctx.chapterTitle } : {}),
      chapterRelPath: ctx.chapterRelPath,
      chapterHash: ctx.chapterHash,
      summary: raw.summary,
      issues,
      passes,
      goals,
      coverage,
      dropped,
    },
    notes,
  };
}

function verifyGoals(
  reviews: RawGoalReview[] | undefined,
  frozen: readonly FrozenGoal[],
  index: QuoteIndex
): { goals: ReviewGoal[]; coverage: GoalCoverage; downgraded: number } {
  if (frozen.length === 0) {
    return { goals: [], coverage: 'none', downgraded: 0 };
  }
  const candidates = reviews ?? [];
  let partial = !reviews || candidates.some((r) => !frozen.some((g) => g.id === r.id));
  let downgraded = 0;
  const goals = frozen.map((goal): ReviewGoal => {
    const matches = candidates.filter((r) => r.id === goal.id);
    const unverified: ReviewGoal = { ...goal, status: 'unknown', judgment: GOAL_UNVERIFIED, quotes: [] };
    if (matches.length !== 1) {
      partial = true;
      return unverified;
    }
    const m = matches[0];
    const status = m.status === 'completed' || m.status === 'unmet' || m.status === 'unknown' ? m.status : undefined;
    if (!status || !m.description) {
      partial = true;
      return unverified;
    }
    const allFound = m.quotes.every((q) => quoteFound(index, q));
    if (!allFound || (status !== 'unknown' && m.quotes.length === 0)) {
      if (status !== 'unknown') {
        downgraded++;
      }
      return unverified;
    }
    return { ...goal, status, judgment: m.description, quotes: m.quotes };
  });
  return { goals, coverage: partial ? 'partial' : 'complete', downgraded };
}

function clipText(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

// ---------------------------------------------------------------- 勾選

/**
 * 報告卡上預設勾哪幾條：嚴重與建議全勾，**未完成**的目標也勾（它們要補的正是細綱裡定下的事）；
 * 待核實預設不勾（證據不足不代表有問題，W10）；通過與已完成沒有可勾的東西。
 *
 * ⚑ 上游連未完成的目標也預設不勾（ReviewReport.tsx:301-325）；總計劃 W10 只說「待核實預設不勾」。
 */
export function defaultPicks(report: ReviewReport): string[] {
  return [...report.issues.map((i) => i.id), ...report.goals.filter((g) => g.status === 'unmet').map((g) => g.id)];
}

/** 能勾的條目：全部問題，加上未完成與待核實的目標。 */
export function pickableIds(report: ReviewReport): string[] {
  return [...report.issues.map((i) => i.id), ...report.goals.filter((g) => g.status !== 'completed').map((g) => g.id)];
}

/**
 * 修稿之前正文又被改過（指紋對不上）：逐條重新定位勾選的問題。找不到的那幾條作廢——
 * 拿一句已經不在正文裡的原文去讓模型「改這裡」，它只能憑空編一處出來改。
 * 目標不受影響：它們來自細綱，不來自正文。
 */
export function relocatePicks(
  report: ReviewReport,
  picks: readonly string[],
  text: string
): { kept: string[]; lost: ReviewIssue[] } {
  const index = indexText(text);
  const kept: string[] = [];
  const lost: ReviewIssue[] = [];
  for (const id of picks) {
    const issue = report.issues.find((i) => i.id === id);
    // 沒有引文的（作者加的）沒什麼可重新定位的，照舊交給模型。
    if (issue && issue.quote && !quoteFound(index, issue.quote)) {
      lost.push(issue);
      continue;
    }
    if (issue || report.goals.some((g) => g.id === id && g.status !== 'completed')) {
      kept.push(id);
    }
  }
  return { kept, lost };
}

/**
 * 交給修稿那一次的清單：**只有勾選的**，按報告裡的順序。移植自
 * `renderHumanConfirmedReviewBrief`：原始報告與總評不發——作者沒勾的那些不該出現在模型眼前。
 * 勾了待核實項時前面加上游那句邊界，免得模型把「證據不足」當成「確認有錯」去補一段前史。
 */
export function renderRevisionBrief(report: ReviewReport, picks: readonly string[]): string {
  const chosen = new Set(picks);
  const lines: string[] = [];
  let n = 0;
  for (const issue of report.issues) {
    if (chosen.has(issue.id)) {
      n++;
      // 作者加的分類預設就是「作者補充」，那時不必再標一遍。
      const tag = issue.origin === 'author' && issue.category !== AUTHOR_CATEGORY ? ' · 作者補充' : '';
      const quote = issue.quote ? `\n   相關原文：${issue.quote}` : '';
      lines.push(`${n}. [${issue.category} / ${SEVERITY_LABEL[issue.severity]}${tag}] ${issue.description}${quote}`);
    }
  }
  for (const goal of report.goals) {
    if (chosen.has(goal.id) && goal.status !== 'completed') {
      n++;
      const head = `關鍵事件：${goal.text}`;
      const quote = goal.quotes.length > 0 ? `\n   相關原文：${goal.quotes.join(' / ')}` : '';
      lines.push(`${n}. [本章目標 / ${GOAL_STATUS_LABEL[goal.status]}] ${head}\n   判斷：${goal.judgment}${quote}`);
    }
  }
  if (lines.length === 0) {
    return '';
  }
  const sections: string[] = [];
  if (report.goals.some((g) => chosen.has(g.id) && g.status === 'unknown')) {
    sections.push(
      '【待核實項處理邊界】作者納入待核實項不等於確認其為錯誤。不得據此編造缺失前史或事實；僅按作者已有指導及正文證據處理，證據不足時保留不確定性。'
    );
  }
  sections.push(['【已確認納入本次修稿的審稿項】', ...lines].join('\n'));
  return sections.join('\n\n');
}

/** 使用者氣泡上那幾行（`/按審稿修稿` 下面）：一條一行，不帶引文。 */
export function describePicks(report: ReviewReport, picks: readonly string[]): string[] {
  const chosen = new Set(picks);
  return [
    ...report.issues.filter((i) => chosen.has(i.id)).map((i) => `[${SEVERITY_LABEL[i.severity]}] ${i.category}：${i.description}`),
    ...report.goals
      .filter((g) => chosen.has(g.id) && g.status !== 'completed')
      .map((g) => `[${GOAL_STATUS_LABEL[g.status]}] 關鍵事件：${g.text}`),
  ];
}

// ---------------------------------------------------------------- 編輯（五期補遺 §3）

/** 報告卡編輯模式交回來的一條。`id` 缺席或認不出 = 作者新加的。 */
export interface ReviewIssueEdit {
  id?: string;
  category: string;
  severity: ReviewSeverity;
  description: string;
  quote?: string;
}

/** 作者加的條目預設的分類。 */
export const AUTHOR_CATEGORY = '作者補充';

/**
 * 把報告卡上編輯過的問題表合回報告。移植上游 `ReviewReport.tsx` 的編輯模式（:462-503），幾處不同：
 *
 * - **模型給的不能刪**：表裡漏了它就原樣留著（不想修就別勾，上游同樣只給「忽略」）；改過任何一項
 *   標 `edited`。說明改成空的不算數，保留原來那句。
 * - **作者加的**（`id` 缺席或認不出）：編號接著 `a1`、`a2`… 往下，標 `origin: 'author'`，分類空著就是
 *   「作者補充」，說明空的整條丟掉；表裡漏了已有的作者條目 = 刪掉它。
 * - **引文按審稿時同一個歸一化去正文裡找**：作者加的找不到就清空（沒有原文撐著的引文交給修稿只會
 *   讓它憑空找地方改）；模型條目改出來的找不到就保留原來那一句。都寫進說明（第 2 條）。
 * - 長度按審稿合同的上限截斷。順序：模型的在前（原來的順序），作者加的跟在後面（表裡的順序）。
 */
export function applyReviewEdits(
  report: ReviewReport,
  edits: readonly ReviewIssueEdit[],
  text: string
): { report: ReviewReport; notes: string[] } {
  const notes: string[] = [];
  const index = indexText(text);
  const cut = (s: unknown, max: number) => Array.from(typeof s === 'string' ? s.trim() : '').slice(0, max).join('');
  const sev = (v: unknown): ReviewSeverity => (v === 'error' ? 'error' : 'warning');
  const byId = new Map(report.issues.map((i) => [i.id, i]));
  const used = new Set<string>();

  const model: ReviewIssue[] = [];
  for (const issue of report.issues.filter((i) => i.origin !== 'author')) {
    const e = edits.find((x) => x.id === issue.id);
    used.add(issue.id);
    if (!e) {
      model.push(issue);
      continue;
    }
    const description = cut(e.description, REVIEW_DESCRIPTION_MAX) || issue.description;
    if (!cut(e.description, REVIEW_DESCRIPTION_MAX)) {
      notes.push(`「${clipText(issue.description, 24)}」的說明不能是空的，保留原來那句`);
    }
    let quote = cut(e.quote, REVIEW_QUOTE_MAX);
    if (quote !== issue.quote && quote && !quoteFound(index, quote)) {
      notes.push(`「${clipText(description, 24)}」改過的引文在正文裡找不到，保留原來那一句`);
      quote = issue.quote;
    }
    const next: ReviewIssue = {
      ...issue,
      category: cut(e.category, 40) || issue.category,
      severity: sev(e.severity),
      description,
      quote,
    };
    const changed =
      next.category !== issue.category || next.severity !== issue.severity || next.description !== issue.description || next.quote !== issue.quote;
    model.push(changed || issue.edited ? { ...next, edited: true } : issue);
  }

  // 作者加的：已有的按 id 認，新加的接著編號。
  let n = report.issues.reduce((max, i) => Math.max(max, Number(/^a(\d+)$/.exec(i.id)?.[1] ?? 0)), 0);
  const authored: ReviewIssue[] = [];
  let removed = 0;
  for (const old of report.issues.filter((i) => i.origin === 'author')) {
    if (!edits.some((x) => x.id === old.id)) {
      removed++;
    }
  }
  let blank = 0;
  for (const e of edits) {
    if (e.id && used.has(e.id)) {
      continue;
    }
    const existing = e.id ? byId.get(e.id) : undefined;
    if (existing && existing.origin !== 'author') {
      continue;
    }
    const description = cut(e.description, REVIEW_DESCRIPTION_MAX);
    if (!description) {
      blank++;
      continue;
    }
    let quote = cut(e.quote, REVIEW_QUOTE_MAX);
    if (quote && !quoteFound(index, quote)) {
      notes.push(`「${clipText(description, 24)}」的引文在正文裡找不到，按沒有引文處理`);
      quote = '';
    }
    const id = existing?.id ?? `a${++n}`;
    used.add(id);
    authored.push({
      id,
      category: cut(e.category, 40) || AUTHOR_CATEGORY,
      severity: sev(e.severity),
      quote,
      description,
      origin: 'author',
    });
  }
  if (blank > 0) {
    notes.push(`${blank} 條新加的問題沒寫說明，沒有收`);
  }
  if (removed > 0) {
    notes.push(`刪掉了 ${removed} 條作者加的問題`);
  }
  return { report: { ...report, issues: [...model, ...authored] }, notes };
}

// ---------------------------------------------------------------- 渲染

/**
 * 給人讀的一份（氣泡正文、「複製」取它）。報告卡畫的是結構，這一份是它的文字版——
 * 氣泡裡擺一段 JSON，作者複製出來也沒法用。
 */
export function renderReport(report: ReviewReport): string {
  const head = `第 ${report.chapterNo} 章${report.chapterTitle ? `《${report.chapterTitle}》` : ''}審稿`;
  const lines: string[] = [`# ${head}`];
  if (report.summary) {
    lines.push('', report.summary);
  }
  for (const sev of ['error', 'warning'] as const) {
    const list = report.issues.filter((i) => i.severity === sev);
    if (list.length > 0) {
      lines.push('', `## ${SEVERITY_LABEL[sev]}（${list.length}）`);
      for (const i of list) {
        const tag = i.origin === 'author' ? '（作者補充）' : i.edited ? '（已改）' : '';
        lines.push(`- [${i.category}] ${i.description}${tag}`);
        if (i.quote) {
          lines.push(`  > ${i.quote}`);
        }
      }
    }
  }
  if (report.goals.length > 0) {
    lines.push('', '## 本章目標');
    for (const g of report.goals) {
      lines.push(`- ${GOAL_STATUS_LABEL[g.status]}｜關鍵事件：${g.text}`, `  ${g.judgment}`);
      for (const q of g.quotes) {
        lines.push(`  > ${q}`);
      }
    }
  }
  if (report.passes.length > 0) {
    lines.push('', '## 通過');
    for (const p of report.passes) {
      lines.push(`- [${p.category}] ${p.description}`);
    }
  }
  if (report.dropped.length > 0) {
    lines.push('', `## 丟掉的意見（${report.dropped.length}，引文站不住）`);
    for (const d of report.dropped) {
      lines.push(`- [${d.category}] ${d.description}（${d.why}）`);
    }
  }
  return lines.join('\n');
}

/** 「2 嚴重 · 1 建議 · 目標 3/4 已完成」——報告卡頂上與日誌裡的那一句。 */
export function describeReport(report: ReviewReport): string {
  const errors = report.issues.filter((i) => i.severity === 'error').length;
  const warnings = report.issues.length - errors;
  const parts = [`${errors} 嚴重`, `${warnings} 建議`];
  if (report.goals.length > 0) {
    const done = report.goals.filter((g) => g.status === 'completed').length;
    const pending = report.goals.filter((g) => g.status === 'unknown').length;
    parts.push(`目標 ${done}/${report.goals.length} 已完成${pending > 0 ? `（${pending} 項待核實）` : ''}`);
  }
  return parts.join(' · ');
}

// ---------------------------------------------------------------- 容錯讀取

/**
 * 會話檔案裡那份報告的容錯讀取（第 1 條：會話 JSON 作者可能手改過）。認不出章號或正文路徑
 * 就整份不要——報告卡上點引文、按勾選修稿都要靠這兩樣；其餘欄位壞了按空補。
 */
export function normalizeReport(raw: unknown): ReviewReport | undefined {
  const o = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const list = (v: unknown) => (Array.isArray(v) ? v : []).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
  const chapterNo = typeof o.chapterNo === 'number' && o.chapterNo > 0 ? Math.floor(o.chapterNo) : 0;
  const chapterRelPath = str(o.chapterRelPath);
  if (!chapterNo || !chapterRelPath) {
    return undefined;
  }
  const severity = (v: unknown): ReviewSeverity => (v === 'error' ? 'error' : 'warning');
  const status = (v: unknown): GoalStatus => (v === 'completed' || v === 'unmet' ? v : 'unknown');
  const coverage: GoalCoverage = o.coverage === 'complete' || o.coverage === 'none' ? o.coverage : 'partial';
  return {
    chapterNo,
    ...(str(o.chapterTitle) ? { chapterTitle: str(o.chapterTitle) } : {}),
    chapterRelPath,
    chapterHash: str(o.chapterHash),
    summary: str(o.summary),
    issues: list(o.issues)
      // 沒有引文的只認作者加的與作者改過的：模型交回的條目引文是校驗過的，缺了就是檔案壞了。
      .filter((i) => str(i.id) && (str(i.quote) || i.origin === 'author' || i.edited === true))
      .map((i) => ({
        id: str(i.id),
        category: str(i.category) || '其他',
        severity: severity(i.severity),
        quote: str(i.quote),
        description: str(i.description),
        ...(i.origin === 'author' ? { origin: 'author' as const } : {}),
        ...(i.edited === true ? { edited: true } : {}),
      })),
    passes: list(o.passes).map((p) => ({ category: str(p.category) || '其他', description: str(p.description) })),
    goals: list(o.goals)
      .filter((g) => str(g.id))
      .map((g) => ({
        id: str(g.id),
        text: str(g.text),
        status: status(g.status),
        judgment: str(g.judgment),
        quotes: (Array.isArray(g.quotes) ? g.quotes : []).filter((q): q is string => typeof q === 'string'),
      })),
    coverage,
    dropped: list(o.dropped).map((d) => ({
      category: str(d.category) || '其他',
      severity: severity(d.severity),
      description: str(d.description),
      ...(str(d.quote) ? { quote: str(d.quote) } : {}),
      why: str(d.why),
    })),
  };
}
