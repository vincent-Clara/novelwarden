/**
 * 上下文詳細度：**每一次呼叫帶多少前文與設定。**
 *
 * 與 `thinking.ts` 同一個位置的東西——級別、介面上的說法、每一級的上限在資料層定義一次
 * （純資料 + 純函式、零 import，所以前端可以直接打包這一份）。裝配器的各層與後臺任務
 * 只經 {@link contextLimitsOf} 取上限，不再各自寫死常量。
 *
 * ## 為什麼是全域設定
 *
 * 它是成本偏好，不是某一輪的難度：批次寫章最費上下文，而批次不跟對話走。所以與
 * `trimModifiers` 一樣存在 `~/.novelwarden/config.json`，對話頁、工程頁批次、外部 agent
 * 三條路都經 `readConfig()` 拿到同一個值。調模型之前的確認框上可以只為這一次換一級
 * （`runtime/callScope.ts`，不寫回設定）：那之後 `readConfig()` 讀到的就是換過的那一級。
 *
 * ## 第 3 級就是從前的行為
 *
 * 「詳細」那一行逐項等於這個開關出現之前寫死的常量。從前另有一項「更早章的細綱最多帶最近幾章」
 * （`summaryChapters`），2026-10-21 情節大綱一章一條之後寫正文、寫大綱都不再帶更早幾十章的細綱，那一項刪了。
 * 2026-10-24 規劃時又收了兩樣（docs/design/plans/2026-10-24-planning-roster-plotlist.md）：前序細綱一覽從 100 章
 * 降到 30 章（`plotListMax`，大綱的中段另成 `outlineBriefMax`、數不變），角色圖譜只給近 20 章出場的帶身份
 * （`rosterRecent`，從前全員）。
 *
 * ## 不分級的東西
 *
 * - **後 5 章邊界**（`AHEAD_PLOTS`）：它是「不許提前寫」的邊界，`planWriting` 算「本章不出場」
 *   也用同一個視窗，兩邊必須一致。
 * - **本章已寫末尾**、**@ 引用**、**落定細綱時的歷史**：前兩樣是這一次任務本身，後一樣是
 *   `settle` 要沉澱的討論。
 * - **定稿、全文大綱、角色狀態、建卡、設定掃描**：輸入就是那一章本身，或按視窗分批——
 *   調低只會截掉要整理的東西、或多拆幾次呼叫，不會少花。
 *
 * 任何一級都不改呼叫次數（第 4 條）。
 */

export type ContextDetail = 1 | 2 | 3 | 4;

export const CONTEXT_DETAILS: ContextDetail[] = [1, 2, 3, 4];

/** 預設「詳細」：逐項等於這個開關出現之前的行為。 */
export const DEFAULT_CONTEXT_DETAIL: ContextDetail = 3;

/** 下拉框、裝配清單與日誌共用這一份說法，前端不另寫。 */
export const CONTEXT_DETAIL_LABEL: Record<ContextDetail, string> = {
  1: '精簡',
  2: '標準',
  3: '詳細',
  4: '完整',
};

export const CONTEXT_DETAIL_HINT: Record<ContextDetail, string> = {
  1: '只帶寫這一章必需的，最省 token；規劃時一章一行：大綱最近 30 章、細綱最近 10 章，更早的靠全文大綱',
  2: '近一章全文、少量原文片段，日常夠用',
  3: '近兩章全文、原文片段；規劃時一章一行：大綱最近 100 章、細綱最近 30 章（預設）',
  4: '近三章全文、更多片段；規劃時一章一行不封頂、角色圖譜全員，視窗能裝多少裝多少',
};

/**
 * 一級的全部上限。**扁平**：測試覆蓋某一項只是一層淺合併。
 *
 * 數字 0 = 不帶；`Infinity` = 不限（只在核心裡用，絕不經協議發給前端——
 * `JSON.stringify` 會把它變成 `null`）。
 */
export interface ContextLimits {
  /** 寫正文第一次呼叫帶前幾章的正文全文（`manuscriptFull`）。 */
  readonly fullTextChapters: number;
  /** 上一章結尾原文帶多少字（`prevTail`）。 */
  readonly prevTailChars: number;
  /** 定稿原文片段：前幾章的連續性事實全取（`evidence`）。 */
  readonly evidenceRecent: number;
  /** 定稿原文片段：最多從幾章裡取。0 = 整層不帶。 */
  readonly evidenceChapters: number;
  /** 定稿原文片段：一共多少字。 */
  readonly evidenceChars: number;
  /** 近章連續性事實最多從幾章裡取（`recentFacts`，以及寫前衝突檢查）。 */
  readonly factsChapters: number;
  /** 近章連續性事實一共多少字。 */
  readonly factsChars: number;
  /** 寫正文時帶幾條敘事線（`threads`）。 */
  readonly threadCount: number;
  /** 敘事線一共多少字（只算各行）。 */
  readonly threadChars: number;
  /**
   * 拆細綱時帶幾條線（`plot` 配方的 `threads` 層，敘事線二期）。拆細綱是一批幾章一起排，要知道的線比寫一章多，
   * 另設一組，不與寫正文的 {@link threadCount} 共用。
   */
  readonly plotThreadCount: number;
  /** 拆細綱時帶幾條沒收的伏筆。 */
  readonly plotForeshadowCount: number;
  /** 拆細綱時線、伏筆各一共多少字（只算各行；兩樣各按這個數封頂）。 */
  readonly plotThreadChars: number;
  /**
   * 大綱階段一章一行最多帶幾章（`outlineDoc` 只帶第一行的那一段，中段）。更早的不逐章列，交給全文大綱（2026-10-22）。
   */
  readonly outlineBriefMax: number;
  /**
   * 細綱階段的前序細綱一覽（`plotList`）最多帶幾章，更早的交給全文大綱。從前與大綱的中段共用一個數（預設 100），
   * 寫到八十章時一覽與全文大綱把同一段前情各說一遍，2026-10-24 單獨一組、調小。
   */
  readonly plotListMax: number;
  /**
   * 規劃時（大綱、細綱）角色圖譜裡帶身份、關係、當前狀態的：近幾章出場的（與這一次提到的）。其餘只列名字；
   * `Infinity` = 全員都帶（2026-10-24）。
   */
  readonly rosterRecent: number;
  /** 細綱單章與寫正文：帶前幾章的細綱（`plotPrev`）。寫正文時這就是全部的前幾章細綱，更早的不帶。 */
  readonly prevPlots: number;
  /** 細綱單章：帶後幾章的細綱（`plotNext`）。 */
  readonly nextPlots: number;
  /** 對話歷史最多佔預算的幾成（落定細綱另有固定的 0.6）。 */
  readonly historyCap: number;
  /** 角色卡一律只帶要點：身份 / 當前狀態 / 暗設（寫正文時暗設不帶，`context/layers/render.ts` 的 `essentialCardKeys`）。 */
  readonly essentialCards: boolean;
  /** 挑出場角色時看前幾章定稿過的細綱的「出場人物」。 */
  readonly castSummaries: number;
  /** 從已寫正文補齊架構時均勻抽樣幾章（`written`）。 */
  readonly deriveSamples: number;
  /** 提取文風：預設勾前幾章當樣章（作者仍可改，最多 3 章）。 */
  readonly styleSamples: number;
  /** 提取角色：預設勾最近幾章。 */
  readonly characterChapters: number;
  /** 從參考書學寫法：文風抽樣幾章。 */
  readonly referenceSamples: number;
  /** 排敘事線：情節大綱最多帶多少字。 */
  readonly threadPlanOutlineChars: number;
  /** 定稿認敘事線：最多送幾條線去認。 */
  readonly threadJudge: number;
  /** 定稿認敘事線：最多送幾條伏筆去認（敘事線重做，伏筆並進了敘事線）。 */
  readonly foreshadowJudge: number;
  /** 設定：整條帶（正文 + 還沒整合的新事實）最多幾條（`lore`）。 */
  readonly loreFull: number;
  /** 設定：只帶一句話的最多幾條。 */
  readonly loreLines: number;
  /** 設定：整層一共多少字。 */
  readonly loreChars: number;
  /** 設定：整條帶時，水位之後還沒整合進條目的新事實跟幾行。 */
  readonly loreTail: number;
}

/**
 * 每一級的上限。第 3 級逐項等於從前寫死的常量，只多三樣：設定從前命中就整條塞、不排序不封頂，幾百條的書
 * 會把視窗填滿，現在按 `lore*` 四項封頂（設定名錄，2026-10-18）；前序細綱一覽與角色圖譜（2026-10-24，見檔案頭）。
 */
export const CONTEXT_DETAIL_LIMITS: Readonly<Record<ContextDetail, ContextLimits>> = Object.freeze({
  1: Object.freeze({
    fullTextChapters: 0,
    prevTailChars: 1000,
    evidenceRecent: 0,
    evidenceChapters: 0,
    evidenceChars: 0,
    factsChapters: 6,
    factsChars: 1500,
    threadCount: 3,
    threadChars: 600,
    plotThreadCount: 4,
    plotForeshadowCount: 6,
    plotThreadChars: 800,
    outlineBriefMax: 30,
    plotListMax: 10,
    rosterRecent: 10,
    prevPlots: 1,
    nextPlots: 1,
    historyCap: 0.15,
    essentialCards: true,
    castSummaries: 1,
    deriveSamples: 3,
    styleSamples: 1,
    characterChapters: 1,
    referenceSamples: 3,
    threadPlanOutlineChars: 4000,
    threadJudge: 6,
    foreshadowJudge: 8,
    loreFull: 2,
    loreLines: 10,
    loreChars: 1500,
    loreTail: 1,
  }),
  2: Object.freeze({
    fullTextChapters: 1,
    prevTailChars: 1500,
    evidenceRecent: 3,
    evidenceChapters: 6,
    evidenceChars: 3000,
    factsChapters: 8,
    factsChars: 2000,
    threadCount: 4,
    threadChars: 900,
    plotThreadCount: 6,
    plotForeshadowCount: 10,
    plotThreadChars: 1200,
    outlineBriefMax: 50,
    plotListMax: 20,
    rosterRecent: 15,
    prevPlots: 2,
    nextPlots: 1,
    historyCap: 0.2,
    essentialCards: false,
    castSummaries: 2,
    deriveSamples: 4,
    styleSamples: 2,
    characterChapters: 2,
    referenceSamples: 4,
    threadPlanOutlineChars: 6000,
    threadJudge: 9,
    foreshadowJudge: 12,
    loreFull: 4,
    loreLines: 20,
    loreChars: 3000,
    loreTail: 2,
  }),
  3: Object.freeze({
    fullTextChapters: 2,
    prevTailChars: 1500,
    evidenceRecent: 5,
    evidenceChapters: 12,
    evidenceChars: 6000,
    factsChapters: 12,
    factsChars: 3000,
    threadCount: 6,
    threadChars: 1200,
    plotThreadCount: 8,
    plotForeshadowCount: 14,
    plotThreadChars: 1800,
    outlineBriefMax: 100,
    plotListMax: 30,
    rosterRecent: 20,
    prevPlots: 3,
    nextPlots: 1,
    historyCap: 0.3,
    essentialCards: false,
    castSummaries: 2,
    deriveSamples: 5,
    styleSamples: 2,
    characterChapters: 3,
    referenceSamples: 5,
    threadPlanOutlineChars: 8000,
    threadJudge: 12,
    foreshadowJudge: 16,
    loreFull: 6,
    loreLines: 40,
    loreChars: 5000,
    loreTail: 3,
  }),
  4: Object.freeze({
    fullTextChapters: 3,
    prevTailChars: 2000,
    evidenceRecent: 8,
    evidenceChapters: 20,
    evidenceChars: 10000,
    factsChapters: 20,
    factsChars: 5000,
    threadCount: 8,
    threadChars: 1800,
    plotThreadCount: 12,
    plotForeshadowCount: 20,
    plotThreadChars: 2600,
    outlineBriefMax: Infinity,
    plotListMax: Infinity,
    rosterRecent: Infinity,
    prevPlots: 5,
    nextPlots: 2,
    historyCap: 0.4,
    essentialCards: false,
    castSummaries: 3,
    deriveSamples: 8,
    styleSamples: 3,
    characterChapters: 5,
    referenceSamples: 8,
    threadPlanOutlineChars: 12000,
    threadJudge: 16,
    foreshadowJudge: 24,
    loreFull: 10,
    loreLines: 80,
    loreChars: 8000,
    loreTail: 5,
  }),
});

export function isContextDetail(value: unknown): value is ContextDetail {
  return typeof value === 'number' && (CONTEXT_DETAILS as number[]).includes(value);
}

/** 容錯讀取：認不出（缺席、越界、小數、字串）一律回落預設，絕不拋。 */
export function normalizeContextDetail(value: unknown): ContextDetail {
  return isContextDetail(value) ? value : DEFAULT_CONTEXT_DETAIL;
}

/**
 * 取這一份配置的上限：級別那一行，再疊上 `contextOverrides`。
 *
 * **唯一的解析入口**。引數只要求這兩個欄位，測試裡手寫的半截配置（沒有 `contextDetail`）
 * 照樣拿到預設那一行。`contextOverrides` 只給程式碼與測試用，不從 config.json 讀——
 * 作者能動的只有級別（見 config.ts）。
 */
export function contextLimitsOf(config: {
  readonly contextDetail?: unknown;
  readonly contextOverrides?: Partial<ContextLimits>;
}): ContextLimits {
  const row = CONTEXT_DETAIL_LIMITS[normalizeContextDetail(config.contextDetail)];
  return config.contextOverrides ? { ...row, ...config.contextOverrides } : row;
}

/**
 * 取最後 n 個。n ≤ 0 是空，`Infinity` 是全部。
 *
 * 不直接寫 `slice(-n)`：n 為 0 時 `slice(-0)` 等於 `slice(0)`，「一章都不帶」會變成整份都帶
 * （四期修過一次「注入完整原文章數設成 0」就是這個坑）。
 */
export function takeLast<T>(list: readonly T[], n: number): T[] {
  if (!(n > 0)) {
    return [];
  }
  return Number.isFinite(n) ? list.slice(-n) : list.slice();
}

/** 設定頁說明行：這一級具體帶多少。 */
export function describeContextDetail(detail: ContextDetail): string {
  const l = CONTEXT_DETAIL_LIMITS[detail];
  const n = (v: number, unit: string): string => (v === Infinity ? '不限' : v <= 0 ? '不帶' : `${v} ${unit}`);
  return [
    `近章全文 ${n(l.fullTextChapters, '章')}`,
    `上一章結尾 ${n(l.prevTailChars, '字')}`,
    `前幾章細綱 ${n(l.prevPlots, '章')}`,
    `大綱一章一行 ${n(l.outlineBriefMax, '章')}`,
    `細綱一覽 ${n(l.plotListMax, '章')}`,
    `角色圖譜 ${l.rosterRecent === Infinity ? '全員' : `近 ${l.rosterRecent} 章出場的`}`,
    `原文片段 ${l.evidenceChapters <= 0 ? '不帶' : `${l.evidenceChapters} 章內 ${l.evidenceChars} 字`}`,
    `敘事線 ${l.threadCount} 條`,
    `對話歷史 ${Math.round(l.historyCap * 100)}%`,
    ...(l.essentialCards ? ['角色卡只帶要點'] : []),
  ].join(' · ');
}
