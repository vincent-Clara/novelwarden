/**
 * 模型分檔：把「哪個模型幹哪種活」變成配置。
 *
 * 工程頁的後臺任務在難度與呼叫量上差得很遠：
 *
 * - 「把 76 章正文各總結一遍」是 76 次呼叫，每次只看一章、輸出固定結構；
 * - 「把幾十份階段摘要合併成一份全文大綱」全書只調一次，卻要跨幾十萬字取捨主線。
 *
 * 兩者用同一個模型，作者只能在「貴而好」與「省而糙」之間二選一。分檔就是
 * 讓前者走便宜模型、後者走聰明模型：**簡單大量的活省錢，困難的活花錢**。
 *
 * 三檔各是一份**有序清單**，與 `config.models` 同構，因此模型池的既有能力
 * （序列恆用首選、失敗隨機換人、併發輪轉負載均衡）在檔內原樣保留。
 *
 * 兩條硬約束：
 *
 * 1. **空檔位繼承 `config.models`**。三檔都沒配時，每個任務取到的清單與分檔
 *    之前逐位元組一致——靜默把某些任務降級到便宜模型，等於替作者做了質量取捨。
 * 2. **對話頁續寫不在此列**。它嚴格用作者在下拉框裡選定的那個模型（`models[0]`），
 *    中途換人會讓文風斷掉。這裡的檔位只作用於工程頁的後臺任務。
 *
 * 唯一的例外是**轉寫**（`transcribe`，2026-10-25 起，細綱試點之後推到全部結構化產物）：幹活的模型按格式寫好自然語言
 * 之後，由它把原文照抄成程式要的 JSON（features/transcribe.ts）。它不寫內容，對話頁與工程頁都走它這一檔，作者在確認框上
 * 為這一次指定的模型也不管它（作者定的：固定的轉寫模型）。
 */

/** 三檔智慧水平。順序即由省到貴。 */
export type ModelTier = 'fast' | 'balanced' | 'quality';

export const MODEL_TIERS: ModelTier[] = ['fast', 'balanced', 'quality'];

/** 檔位的中文名。設定頁、確認框、日誌共用這一份，不在前端另寫。 */
export const TIER_LABEL: Record<ModelTier, string> = {
  fast: '快速檔',
  balanced: '均衡檔',
  quality: '精標檔',
};


/** 檔位說明，只給設定頁用。 */
export const TIER_HINT: Record<ModelTier, string> = {
  fast: '便宜、快，用於量大而單次簡單的活',
  balanced: '折中，用於量不小但質量也要緊的活',
  quality: '最聰明的模型，用於一次定調、錯了代價大的活',
};

/**
 * 會調模型的後臺任務。
 *
 * 粒度按「難度是否不同」切，而不是按功能切——`rebuildGlobalSummary` 一個功能
 * 裡的分批匯總與最終合併難度差一個數量級，因此拆成兩項；反過來，角色卡的
 * 單卡更新 / 批次更新 / 批次建卡乾的是同一件事，合成一項。
 */
export type LlmTask =
  | 'plotSummary'
  | 'globalSummaryStage'
  | 'globalSummaryMerge'
  | 'setting'
  | 'plotOutline'
  | 'manuscript'
  | 'review'
  | 'loreScan'
  | 'loreSynthesis'
  | 'characterCard'
  | 'extractCharacters'
  | 'extractStyle'
  | 'transcribe';

export const LLM_TASKS: LlmTask[] = [
  'plotSummary',
  'globalSummaryStage',
  'globalSummaryMerge',
  'setting',
  'plotOutline',
  'manuscript',
  'review',
  'loreScan',
  'loreSynthesis',
  'characterCard',
  'extractCharacters',
  'extractStyle',
  'transcribe',
];

/** 任務的中文名。確認框與日誌裡出現的就是它。 */
export const TASK_LABEL: Record<LlmTask, string> = {
  plotSummary: '同步 · 照正文更新細綱',
  globalSummaryStage: '全文大綱 · 分批匯總',
  globalSummaryMerge: '全文大綱 · 最終合併',
  setting: '故事架構',
  plotOutline: '劇情細綱',
  manuscript: '批次寫正文',
  review: '批次審稿',
  loreScan: '設定 · 記設定',
  loreSynthesis: '設定 · 建條目與整合',
  characterCard: '角色卡 · 更新 / 建卡',
  extractCharacters: '提取角色',
  extractStyle: '提取文風',
  transcribe: '轉寫 · 整理成 JSON',
};

/** 設定頁那張表裡每行的補充說明：這活為什麼歸在這一檔。 */
export const TASK_HINT: Record<LlmTask, string> = {
  plotSummary: '一章一次呼叫，幾十上百次；輸入只有單章正文與它的細綱，輸出是固定結構。批次同步時認敘事線事件、更新當前進度、歸併也走這一檔',
  globalSummaryStage: '每批一次呼叫，批數多且各批獨立',
  globalSummaryMerge: '全書只調一次，要跨幾十萬字取捨主線',
  setting: '配置、前提、角色圖譜、世界觀各一次（角色圖譜分兩步）；全書只跑一次，後面每一章都吃它',
  plotOutline: '每批 5 章一次呼叫；要在大綱與前後章之間排出這幾章的關鍵事件與看點，寫歪了後面全歪。從情節大綱排敘事線也走這一檔',
  manuscript: '一章一次呼叫，是最燒 token 的活；文風與語氣全看它',
  review: '批次寫章「寫完即審稿」時一章一次；要逐字引正文、判細綱的每一項落實了沒有，判錯了作者會照著去改',
  loreScan: '單獨記一章、補記老章節時一章一次：讀正文，只記下出現了哪些設定（同步時順手記的那份不走這一檔）',
  loreSynthesis: '建條目、整合每條一次，要合併同步過的章裡的記錄且不能推翻作者寫的內容；按目錄整理也走這一檔',
  characterCard: '按出場章分批精煉，產物每次續寫都注入上下文',
  extractCharacters: '一次呼叫定「誰是誰」，判錯會汙染整個角色體系',
  extractStyle: '一次呼叫，產出的文風指南每次續寫都注入',
  transcribe:
    '幹活的模型按格式寫自然語言（細綱、同步、敘事線、角色卡、設定、審稿……），寫完由這一檔照抄成 JSON：只搬不寫，每段文字都得出自原文。每一步多一次呼叫；對話頁與工程頁都用它，確認框上為這一次換的模型不管它',
};

/**
 * 內建預設對映。
 *
 * 判據是「呼叫次數 × 單次難度」：次數多而單次簡單的歸快速檔，
 * 次數少而一次定調的歸精標檔。作者可在設定頁逐項改。
 *
 * 兩處需要解釋：
 *
 * - **細綱歸均衡檔**：它每批 5 章一次呼叫，量不算大，但決定這幾章講什麼、怎麼轉，
 *   **寫歪了那幾章的正文整篇跟著歪**，而正文是最貴的一項。這一格省下來的錢
 *   會在下一格翻倍還回去。
 * - **批次寫正文歸均衡檔**：它是量最大也最貴的一項，但正文的文風與語氣直接
 *   決定成品質量，壓到快速檔等於用便宜模型寫整本書。歸均衡是折中——真要
 *   省錢或真要質量，作者在設定頁改一格就行，而預設值不該替他做這個取捨。
 */
export const DEFAULT_TASK_TIERS: Record<LlmTask, ModelTier> = {
  plotSummary: 'fast',
  globalSummaryStage: 'fast',
  loreScan: 'fast',
  loreSynthesis: 'balanced',
  characterCard: 'balanced',
  setting: 'quality',
  plotOutline: 'balanced',
  manuscript: 'balanced',
  review: 'balanced',
  globalSummaryMerge: 'quality',
  extractCharacters: 'quality',
  extractStyle: 'quality',
  transcribe: 'fast',
};

/** 三檔的模型清單，歸一化後的完整形狀（每檔都在，可能是空陣列）。 */
export type TierModels = Record<ModelTier, string[]>;

export function isModelTier(value: unknown): value is ModelTier {
  return typeof value === 'string' && (MODEL_TIERS as string[]).includes(value);
}

export function isLlmTask(value: unknown): value is LlmTask {
  return typeof value === 'string' && (LLM_TASKS as string[]).includes(value);
}

/** 該任務歸在哪一檔：作者的覆蓋優先，否則用內建預設。 */
export function tierOf(config: TierConfig, task: LlmTask): ModelTier {
  const override = config.taskTiers?.[task];
  // 非法檔位名（手改配置檔案寫錯、舊版本留下的鍵）退回預設，不拋。
  return isModelTier(override) ? override : DEFAULT_TASK_TIERS[task];
}

/** `refsForTask` 只需要配置裡的這幾項，收窄依賴便於單測。 */
export interface TierConfig {
  models: string[];
  tierModels: TierModels;
  taskTiers: Partial<Record<LlmTask, ModelTier>>;
  /** 作者在確認框上為這一次指定的模型（`readConfig()` 從呼叫鏈上取，見 runtime/callScope.ts）。 */
  pinnedModel?: string;
}

export interface TaskModels {
  tier: ModelTier;
  /** 該任務實際要用的引用清單，按順序。 */
  refs: string[];
  /** true 表示該檔沒配模型，這份清單是從「預設模型」繼承來的。 */
  inherited: boolean;
  /** true 表示作者為這一次指定了模型：清單隻有它一個，不按檔、不換人。 */
  pinned: boolean;
}

/**
 * 某個任務實際該用哪些模型。
 *
 * **確認框與日誌的文案必須從這裡取**，不能再列印 `config.models`——
 * 彈窗寫著一個模型、實際跑另一個，是「不偷偷燒 token」這條產品承諾的反面。
 *
 * 作者在確認框上指定了模型（`pinnedModel`）就只給它：選了誰就是誰，與對話頁同一條規矩。轉寫（`transcribe`）除外，
 * 它固定按檔走（見檔案頭）。
 */
export function refsForTask(config: TierConfig, task: LlmTask): TaskModels {
  const tier = tierOf(config, task);
  if (config.pinnedModel && task !== 'transcribe') {
    return { tier, refs: [config.pinnedModel], inherited: false, pinned: true };
  }
  const refs = config.tierModels[tier] ?? [];
  if (refs.length > 0) {
    return { tier, refs, inherited: false, pinned: false };
  }
  return { tier, refs: config.models, inherited: true, pinned: false };
}

/**
 * 儲存設定時寫進日誌的分檔摘要。
 *
 * 只報配過的檔與改過的歸屬：三檔全空時就是「未分檔」一句話，
 * 免得每次儲存都在日誌裡刷八行沒人改過的預設值。
 */
export function describeTierConfig(
  tierModels: TierModels,
  taskTiers: Partial<Record<LlmTask, ModelTier>>
): string {
  const configured = MODEL_TIERS.filter((t) => (tierModels[t] ?? []).length > 0).map(
    (t) => `${TIER_LABEL[t]} ${tierModels[t].join('、')}`
  );
  const overrides = Object.entries(taskTiers).filter(([task, tier]) => isLlmTask(task) && isModelTier(tier));
  if (configured.length === 0 && overrides.length === 0) {
    return '未分檔（全部任務用預設模型）';
  }
  const parts = [configured.length > 0 ? configured.join('／') : '三檔均未配置'];
  if (overrides.length > 0) {
    parts.push(
      `${overrides.length} 項任務改過歸屬（${overrides
        .map(([task, tier]) => `${TASK_LABEL[task as LlmTask]}→${TIER_LABEL[tier as ModelTier]}`)
        .join('、')}）`
    );
  }
  return parts.join('｜');
}

/** 給確認框和日誌用的一句話，如「快速檔（未配置，沿用預設模型）」「這一次指定」。 */
export function describeTier(picked: TaskModels): string {
  if (picked.pinned) {
    return '這一次指定';
  }
  return picked.inherited ? `${TIER_LABEL[picked.tier]}（未配置，沿用預設模型）` : TIER_LABEL[picked.tier];
}

/**
 * 確認框裡那一行「這活交給誰做」。
 *
 * 調模型之前的確認框（`features/askCall.ts`）在「按分檔」下面逐項列它，因為它們都要回答同一個問題，
 * 而**說錯的代價是使用者以為省了錢其實沒省**（或反過來）。所以檔位、實際模型清單、會不會換人、
 * 是不是繼承來的，四件事都寫在這裡。
 */
export function describeTaskModels(config: TierConfig, task: LlmTask): string {
  const picked = refsForTask(config, task);
  if (picked.refs.length === 0) {
    return `${TASK_LABEL[task]}：${TIER_LABEL[picked.tier]}（還沒有可用的模型）`;
  }
  const fallback = picked.refs.length > 1 ? '（失敗會自動換用同檔其餘模型重試）' : '';
  return `${TASK_LABEL[task]} → ${describeTier(picked)}：${picked.refs.join('、')}${fallback}`;
}
