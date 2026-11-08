import { ActiveModel, ProviderProfile } from './providers';
import { LlmTask, ModelTier, TierModels } from './tiers';
import type { ContextDetail, ContextLimits } from './contextDetail';

/**
 * 章節：chapters/NNN-标题.txt（老工程也有 .md）中的一篇正文。
 *
 * **正文的唯一真相。** 生成的正文直接落在這裡（細綱是它在 `summaries/` 下的映象，相對路徑相同、副檔名 `.md`），
 * 定稿、角色卡、設定、文風都從這裡讀。
 */
export interface Chapter {
  /** 序號，來自檔名字首，決定順序。 */
  order: number;
  /** 標題，來自檔名（去掉序號字首與副檔名），若正文首行是 `# xxx` 則以正文為準。 */
  title: string;
  /** 相對工作區根目錄的路徑，例如 `chapters/001-楔子.md`。 */
  relPath: string;
  /** 正文字數（去掉空白後的字元數）。 */
  wordCount: number;
  /** 正文內容的 hash，與細綱的 `sourceHash` 比對：對不上就是定稿之後正文又改過。 */
  contentHash: string;
}

/** 定稿過的細綱裡的一位出場人物（frontmatter `cast` 的一項）。 */
export interface SummaryCast {
  /** 正式姓名（模型被要求沿用已有角色卡的名字）。 */
  name: string;
  /** 本章出現的別名/稱呼。 */
  aliases: string[];
}

/** 角色卡，存於 .novelwarden/characters/<slug>.md。 */
export interface CharacterCard {
  /** 檔名（不含副檔名）。 */
  slug: string;
  relPath: string;
  name: string;
  aliases: string[];
  tags: string[];
  /**
   * 性別（「男」「女」，非人之類的照原樣寫）。缺席 = 沒寫。
   *
   * 落在 frontmatter 而不是正文那七節裡：寫正文時模型只能拿名字猜性別，「陸清河」這種
   * 名字一猜就是男的。機器只在卡上沒寫時補，作者寫了的永遠不改。
   */
  gender?: string;
  /** 首次出場的章號。 */
  firstAppear?: number;
  /** 最後出場的章號。 */
  lastSeen?: number;
  /**
   * 該角色出場的全部章號（升序）。
   *
   * 由定稿過的細綱的 `cast` 反向聚合後寫回 frontmatter，**是快取而非真相**——
   * 真相始終是各章定稿過的細綱。落在卡裡是為了兩件事：不讀全部細綱就能在角色頁上
   * 顯示「出場 12 章」，以及日後按人物檢索。重新定稿後這裡會跟著更新。
   */
  appearsIn: number[];
  /**
   * 上次「更新角色卡」時讀到了第幾章。
   *
   * 增量更新的依據：只關聯這一章之後的出場章。undefined 表示從未更新過
   * （手寫的卡也是這個狀態），此時增量等於全量。
   */
  updatedThrough?: number;
  /**
   * 「當前狀態」一節寫到第幾章為止（D15）。0 = 開篇（角色圖譜建卡時寫的）。
   * 缺席 = 從沒被機器寫過。
   */
  stateThrough?: number;
  /**
   * 機器最後一次寫「當前狀態」時這一節的指紋（model/characterState.ts 的 `stateHashOf`）。
   * 與這一節現在的內容對不上，就說明作者改過——定稿時不覆蓋。
   */
  stateHash?: string;
  /** 除 frontmatter 外的正文全文。 */
  body: string;
  sections: CharacterSections;
}

export interface CharacterSections {
  身份: string;
  外貌: string;
  性格: string;
  语言习惯: string;
  人物关系: string;
  当前状态: string;
  /**
   * 此人讀者還不知道的事（身世、秘密、真實目的）——真相是什麼。敘事線重做（設計稿「六、角色卡」⚑ 定案 B）之前叫
   * 「未收伏筆」：伏筆並進了敘事線（「什麼時候、怎麼揭開」歸敘事線），這一節只管真相。與設定條目的「暗設」（第 27 條）
   * 同一個口徑：規劃時（架構 / 大綱 / 細綱）整份帶、標明讀者還不知道；寫正文、續寫、正文階段的 @ 引用都不帶。
   * 老卡裡的「未收伏筆」當認不出的小節，不讀。
   */
  暗设: string;
}

export const CHARACTER_SECTION_KEYS: (keyof CharacterSections)[] = [
  '身份',
  '外貌',
  '性格',
  '语言习惯',
  '人物关系',
  '当前状态',
  '暗设',
];

/** 角色卡的「暗設」那一節（{@link CharacterSections.暗設}）。 */
export const CHARACTER_HIDDEN_KEY = '暗设' satisfies keyof CharacterSections;

/**
 * 角色圖譜生成詳情時各節的字數上限（第 15 條：角色卡不能無限膨脹）。「人物關係」不在裡面：
 * 它由身份清單生成，不讓模型寫。提示詞（context/prompts.ts）與解碼（features/roster.ts）共用。
 */
export const CHARACTER_DETAIL_LIMITS: Record<Exclude<keyof CharacterSections, '人物关系'>, number> = {
  身份: 200,
  外貌: 120,
  性格: 120,
  语言习惯: 120,
  当前状态: 120,
  暗设: 120,
};

/**
 * 預算不足（或上下文詳細度「精簡」）時只留的角色卡小節。「暗設」寫正文時本來就不帶，規劃時它是排伏筆、守秘密
 * 最要緊的那一節，留著。
 */
export const CHARACTER_ESSENTIAL_KEYS: (keyof CharacterSections)[] = ['身份', '当前状态', '暗设'];

/**
 * 設定條目，存於 `.novelwarden/lore/<分類>/<名>.md`。格式與認法在 model/loreFile.ts。
 */
export interface LoreEntry {
  /** 去掉副檔名的相對路徑（`宗門/正道/青雲宗`）。 */
  slug: string;
  relPath: string;
  title: string;
  /** 別稱與觸發詞：認「同一個東西」、關鍵詞命中都用它。 */
  keywords: string[];
  /**
   * 一句話簡介（frontmatter `brief`）。沒寫是空串——名錄與上下文裡「一行帶」用
   * `loreBrief`（model/loreFile.ts）取，它會回落到正文第一句。
   */
  brief: string;
  /** 分類：所在目錄相對 `lore/` 的路徑（可多層），根目錄下是空串（未分類）。由路徑推出，不是欄位。 */
  category: string;
  /** 整合到第幾章（水位）。沒有 = 從沒整合過。 */
  updatedThrough?: number;
  /** 機器最後一次寫入正文時正文的指紋；與現在的正文對不上 = 作者改過。 */
  bodyHash?: string;
  body: string;
}

/** .novelwarden/project.json 的結構。 */
export interface ProjectManifest {
  /** 資料格式版本，便於日後遷移。 */
  version: number;
  title: string;
  author: string;
  /** 章節索引。 */
  chapters: ManifestChapter[];
  /** 上次重建全文大綱時，已覆蓋到的最大章號。 */
  globalSummaryThrough?: number;
  /**
   * 敘事線判到第幾章（水位，敘事線重做四期）：從第 1 章起連續判過的最後一章——定稿第三步的認事件成了就算判過。缺席是 0。
   * 認法與怎麼往後推見 model/threadFile.ts 的 `ThreadsMark`。
   */
  threadsThrough?: number;
  /** 水位之後另外判過的章（不連續的那幾章，升序）；水位推過去就從這裡拿掉。缺席是沒有。 */
  threadsJudged?: number[];
}

/**
 * manifest 裡的一章。
 *
 * 索引的是章節（`chapters/`）而不是細綱：這裡的欄位——字數、正文 hash——描述的全是正文。
 *
 * **只放可以重算的索引資訊**：真相在 `chapters/` 的檔案裡，這裡是為了「不必讀幾百個檔案
 * 就能畫出工程頁」。正文與細綱之間的指紋（`writtenFrom`、定稿的 `sourceHash`）**不在這裡**
 * ——它們記在細綱自己的 frontmatter 裡（見 model/plotFile.ts）。
 */
export interface ManifestChapter {
  /** 章節檔案的工作區相對路徑。 */
  file: string;
  order: number;
  title: string;
  wordCount: number;
  /** 這一章正文的 hash。 */
  contentHash: string;
}

/**
 * 資料格式版本。
 *
 * 1：`chapters` 索引發布章節。曾經短暫改成過 `plots`（流水線換軸到「劇情段」
 * 那一版），但那一版把創作單位與釋出單位拆成了兩套並存的編號，隨即被推翻——
 * 一份細綱對應一章，索引自然回到章節這一側。老 manifest 無論哪一版，
 * `syncManifest()` 每次都從磁碟重算，讀不出 `chapters` 就是空陣列。
 */
export const MANIFEST_VERSION = 1;

/** 從設定讀出的執行時配置。 */
export interface NovelConfig {
  /** 已配置的服務商（含各自的模型清單）。 */
  providers: ProviderProfile[];
  /**
   * 預設模型列表，按順序，第一個是首選。至少一項（配不出來時為空陣列）。
   *
   * 工程頁的後臺任務從這裡取模型：序列呼叫恆用第一個、失敗隨機換用其餘，
   * 併發呼叫在列表裡輪轉。對話頁續寫不走這套，嚴格用 `model`。
   */
  models: string[];
  /** 當前模型引用，形如 `glm/glm-4-plus`。恆等於 `models[0]`。 */
  model: string;
  /** 當前模型解析結果；引用無效時為 undefined。 */
  active?: ActiveModel;
  /**
   * 三檔（快速 / 均衡 / 精標）各自的模型清單。每檔都在，可能是空陣列——
   * 空 = 該檔的任務沿用 `models`。只作用於工程頁的後臺任務。
   */
  tierModels: TierModels;
  /** 任務 → 檔位的覆蓋，缺席的任務用 `DEFAULT_TASK_TIERS`。 */
  taskTiers: Partial<Record<LlmTask, ModelTier>>;
  /**
   * 作者在調模型之前的確認框上為這一次指定的模型（runtime/callScope.ts），不從 config.json 讀。
   * 有它時分檔池只用它、不換人（`refsForTask`）；對話頁那個模型（`model` / `active`）不受影響。
   */
  pinnedModel?: string;
  /** 當前模型的上下文視窗（模型配置優先，預設使用相容值）。 */
  contextWindow: number;
  maxOutputTokens: number;
  temperature: number;
  /**
   * 上下文詳細度（model/contextDetail.ts）：每一次呼叫帶多少前文與設定。各層與後臺任務
   * 經 `contextLimitsOf(config)` 取上限，不直接讀這個數。確認框上為這一次換過級別的，
   * 在那之後讀到的是換過的（runtime/callScope.ts）。
   */
  contextDetail: ContextDetail;
  /**
   * 單項覆蓋級別那一行，**只給程式碼與測試用**，不從 config.json 讀：作者能動的只有級別。
   * 缺席 = 原樣用級別那一行。
   */
  contextOverrides?: Partial<ContextLimits>;
  chaptersDir: string;
  /** 草稿根目錄（相對工作區根）。映象章節在 chaptersDir 之下的相對路徑。 */
  draftsDir: string;
  summaryBatchSize: number;
  /** 空閒超時（毫秒）：流式還在吐字時不計時，卡住這麼久沒資料才中止。 */
  requestTimeoutMs: number;
  /** 工程頁批次任務的併發請求數。1 表示序列。 */
  concurrency: number;
  /** 一次呼叫失敗後，換用列表裡其它模型重試的次數上限。0 表示不重試。 */
  fallbackAttempts: number;
  /**
   * 寫完正文之後跑一輪「只許刪」的刪修飾（generation/trim.ts），對話頁與批次寫章都跑，每章多調 1 次模型。
   */
  trimModifiers: boolean;
  /** 獨立版：已經開著工程時，開啟另一個工程用新的瀏覽器視窗，而不是換掉當前視窗裡的那個。 */
  openInNewWindow: boolean;
}
