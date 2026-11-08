/**
 * 裝配器的公共型別。
 *
 * 單獨成檔案是為了打斷 `recipes.ts`（配方引用層名）與 `layers/`（層實現
 * 引用配方里的 cap/force）之間的迴圈引用——兩邊都只依賴這裡，誰也不依賴誰。
 */
import { ChatMessage } from '../llm/provider';
import type { ContextDetail } from '../model/contextDetail';
import { CreationAction, CreationTarget, WriteMode } from '../model/pipeline';
import type { FrozenGoal } from '../model/review';
import { Attachment, ChatTurn } from '../model/session';

/** 上下文條目在 prompt 中的分層，數字越小越先保證。 */
export type Priority = 0 | 1 | 2 | 3 | 4;

/**
 * 條目類別。**前端只用它做分組顯示**，不據此做邏輯判斷，
 * 所以這裡加一類不會牽動介面（`SerializedDigest.items[].kind` 是 string）。
 */
export type ItemKind =
  | 'system'
  /** 使用者這一輪說的話。正文階段它是劇情綱要，其餘階段是一句要求。 */
  | 'ask'
  | 'attachment'
  | 'history'
  /** 架構層的一份文件（小說配置 / 故事前提 / 世界觀 / 角色圖譜一覽）。 */
  | 'setting'
  /** 小說配置裡的「全域要求」：跨章的寫作規則，寫正文時單獨成段。 */
  | 'guidance'
  /** 故事結構指導（按總章數算好的章號區間）。是指令，不是產物。 */
  | 'guide'
  /** 前序細綱一覽：一章一行的目錄進度（細綱批次用）。 */
  | 'plotList'
  /** 後幾章的細綱：寫正文時的邊界——知道後面要發生什麼，才不會在這一章提前寫掉。 */
  | 'boundary'
  /** 本章已經寫好的正文末尾：「接著寫」與續寫那幾輪從這裡往下接。 */
  | 'chapterSoFar'
  /** 情節大綱原文。與 `ask` 分開：一個是產物，一個是這一輪的指令。 */
  | 'outlineDoc'
  /** 一章的細綱。 */
  | 'plot'
  | 'prevTail'
  | 'style'
  | 'globalSummary'
  | 'character'
  /** 前面某章的正文全文。 */
  | 'manuscriptFull'
  /** 寫正文時前幾章的細綱（`plotPrev` 在正文階段的條目）：前情，單列一節，不和本章細綱混在一起。 */
  | 'plotSummary'
  /** 前面某章的定稿原文片段：連續性事實的證據所在的那幾段（D18）。 */
  | 'evidence'
  /** 前面某章定稿留下的連續性事實（只有事實文字，不回原文取段落）。審稿對照用。 */
  | 'facts'
  /** 一條沒收束的敘事線（或審稿、拆細綱時一條沒收的伏筆，標籤是「伏筆 · 」），一行。 */
  | 'thread'
  /** 這一章的正文全文：審稿審的就是它。 */
  | 'chapterFull'
  | 'lore'
  /** 單條設定（展開，完善設定 2026-10-19）這一條現有的全部內容，含暗設。 */
  | 'loreSelf'
  /** 沒定稿的細綱裡用到這一條設定的地方（「設定」一節那一行、梗概與關鍵事件裡提到它的句子），帶章號。 */
  | 'lorePlan'
  /** 定稿過的細綱裡關於這一條設定的記錄（已經寫進正文的，不能推翻），帶章號。 */
  | 'loreRecord'
  | 'revision'
  /** 這一階段綁的寫作技能：補充的寫作方法，排在使用者訊息最前面。 */
  | 'skill'
  /** 已寫正文（拆書 A）：從作者已經寫成的章裡整理設定、大綱、細綱時要看的那幾章。 */
  | 'written';

export type ItemStatus = 'included' | 'degraded' | 'dropped' | 'excluded';

/** 一條上下文明細，供 Webview 展示與勾選。 */
export interface ContextItem {
  /** 穩定 id，Webview 用它回傳「取消勾選」。 */
  id: string;
  kind: ItemKind;
  priority: Priority;
  /** 展示名，如「第 12 章 · 原文」。 */
  label: string;
  /** 來原始檔相對路徑，可點選開啟。 */
  source?: string;
  /** 最終注入的文字；status 為 dropped/excluded 時為空。 */
  text: string;
  tokens: number;
  status: ItemStatus;
  /** 降級或丟棄的原因，直接展示給作者。 */
  note?: string;
}

// ---------------------------------------------------------------- 層與配方

/**
 * 可裝配的層。**配方從這裡選，層實現按這個名字註冊**，兩邊對不上編譯就報錯。
 *
 * 前四層是「這一輪對話本身」，任何階段都有；中間幾層是各階段的產物；
 * 後面是共享的背景知識。
 */
export type LayerId =
  | 'system'
  | 'ask'
  | 'attachments'
  | 'history'
  // 產物
  /** 架構層的三份文件，填過的才帶。 */
  | 'settingDocs'
  /** 小說配置的「全域要求」一節。寫正文時單獨帶、強制帶（上游每一章都帶它）。 */
  | 'guidance'
  /** 寫正文用的架構：小說配置（除全域要求）、故事前提、世界觀，一件一條。 */
  | 'premiseWorld'
  /**
   * 角色圖譜一覽：角色卡壓成一人一段（名字、定位、身份、人物關係、當前狀態）。架構階段全員；規劃時只給近期活躍的一段，
   * 其餘只列名字（`rosterRecent`）。
   */
  | 'rosterDoc'
  /**
   * 情節大綱。大綱階段按遠近帶分三段：最近 10 章整條，再往前一章一行（最多 `outlineBriefMax` 章），更早的看全文大綱；
   * 細綱階段只帶這一次要拆的（model/outlineFile.ts 的 `outlineWindow` / `outlineToSplit`）。
   */
  | 'outlineDoc'
  /** 故事結構指導（model/structureGuide.ts）。 */
  | 'structure'
  /** 前序細綱一覽（一章一行，最多 `plotListMax` 章，預設 30）。 */
  | 'plotList'
  | 'plotSelf'
  /** 前幾章的細綱原文（上文）。 */
  | 'plotPrev'
  /** 後一章的細綱原文（下文）。有了它，這一章的收尾才接得上已經排好的下一章。 */
  | 'plotNext'
  /** 後 5 章的細綱，一章一行：寫正文時的邊界（「禁止提前寫」）。 */
  | 'plotAhead'
  /** 本章已經寫好的正文末尾（「接著寫」與續寫那幾輪）。 */
  | 'chapterSoFar'
  // 背景
  | 'style'
  | 'globalSummary'
  | 'characters'
  | 'lore'
  | 'prevTail'
  | 'manuscriptFull'
  /** 前面各章的定稿原文片段：拿定稿過的細綱裡連續性事實的證據原句回到正文裡取的那幾段（D18）。 */
  | 'evidence'
  /** 前面各章定稿留下的連續性事實，只帶事實文字（審稿，五期）。 */
  | 'recentFacts'
  /**
   * 和本章有關、沒收束的敘事線，一條一行，預設 6 條、1200 字；審稿只帶沒收的伏筆（敘事線重做）。拆細綱（`plot` 配方，
   * 敘事線二期）按區間挑：線與沒收的伏筆各一組，預設 8 條線、14 條伏筆。
   */
  | 'threads'
  /** 目標章自己的正文全文（審稿，五期）。 */
  | 'chapterFull'
  | 'revision'
  /** 這一階段綁的寫作技能（`.novelwarden/skills.json`），整份帶或整份不帶。 */
  | 'skill'
  /** 已寫正文（拆書 A，`BuildRequest.derive`）：不是從正文整理時什麼都不帶。 */
  | 'written'
  /** 單條設定（展開）這一條現有的全部內容。目標不是單條設定時什麼都不帶。 */
  | 'loreSelf'
  /** 單條設定的原料：已排細綱裡用到它的地方 + 定稿過的記錄，合計封頂。目標不是單條設定時什麼都不帶。 */
  | 'loreMaterial';

export interface LayerSpec {
  layer: LayerId;
  priority: Priority;
  /**
   * 該層最多吃掉預算的比例。只有本身可能無限大的層需要（附件、歷史）。
   * 不給則不單獨封頂，只受全域餘額約束——歷史例外：不給時按上下文詳細度那一級的
   * `historyCap`（layers/dialog.ts），只有落定細綱寫死 0.6。
   */
  cap?: number;
  /** 強制注入，不參與預算競爭（對應 admit 的 force）。 */
  force?: boolean;
}

// ---------------------------------------------------------------- 請求與結果

export interface BuildRequest {
  /** 這一次要 AI 幹什麼：哪一層的身份 + 什麼能力。決定提示詞與裝配配方。 */
  action: CreationAction;
  /** 在改哪一個產物。決定「本層產物」幾層取哪個檔案。 */
  target: CreationTarget;
  /** 使用者這一輪寫的內容。正文階段是劇情綱要，其餘階段是一句要求。 */
  ask: string;
  /**
   * 目標章的細綱**尚未落盤**時用它定位「前文」的邊界（要寫第 4 章，磁碟上只有 3 章）。
   * 細綱已經存在時以磁碟上的章號為準，這個欄位被忽略；情節大綱階段也忽略它。
   */
  targetNo?: number;
  /** 目標字數，寫進 prompt 指令。 */
  targetWords?: number;
  /**
   * 寫正文的寫法（model/pipeline.ts 的 `WriteMode`）。生成層按磁碟定好了再交過來：
   * `continue` 時裝配器帶上本章已寫正文的末尾、契約改成「只寫新增的那一段」；
   * `rewrite` 時上一版正文經 `revision` 帶進來。預設按 `write`。
   */
  writeMode?: WriteMode;
  /**
   * 這一步覆蓋的章號區間：大綱寫哪一段、細綱拆哪一批（**給了就是一批**）。
   * 前文的邊界取 `from`，後文從 `to` 之後算起。
   */
  range?: { from: number; to: number };
  /** 一句話彈窗帶過來的規模（總章數、每章字數）。給了就以它為準。 */
  setup?: { totalChapters: number; wordsPerChapter: number };
  /**
   * 這一次是**從已寫正文整理**（拆書 A，features/derive.ts）：作者已經寫到第 `through` 章，
   * 設定、大綱、細綱要從那些章裡整理出來，不是從零創作。裝配器帶上 `written` 層，契約換成
   * 「照正文整理」的說法。缺席就是平常的生成。
   */
  derive?: { through: number };
  /** 多步生成裡的哪一步（generation/structured.ts）。預設 = 第一步。 */
  step?: ChainStep;
  /**
   * 生成鏈裡已經過了校驗、還沒落盤的細綱（拆半重試時的前一半）。前序細綱一覽把它們
   * 接在磁碟上那些後面——不然後一半看不見前一半剛寫了什麼。
   */
  draftPlots?: DraftPlotLine[];
  /**
   * 分段重寫大綱時還沒落盤的那一份（features/outlineRewrite.ts）：前面幾段已經換成新版，
   * 後面的還是舊版。大綱兩層讀它而不讀磁碟——不然後一段看不見前一段剛改了什麼。
   */
  outlineDraft?: string;
  /** 分段重寫從第幾章起（之前寫過正文的那幾章不重寫）：說「哪幾章是這次剛寫好的新版」時用。缺席當第 1 章。 */
  outlineRewriteFrom?: number;
  /** 額外寫作指令，如「加強對白」。 */
  extraInstruction?: string;
  /**
   * 上一版正文 + 修改意見，用於「重寫」與「修稿」。**整章都帶**：修稿要求最小改動，
   * 模型手上只有後半章的話，前半章只能憑空重寫。修稿時 `feedback` 是勾選的審稿清單
   * （model/review.ts 的 `renderRevisionBrief`）。
   */
  revision?: { previousDraft: string; feedback: string };
  /**
   * 審稿時凍結的目標清單（model/review.ts 的 `freezeGoals`）。由審稿鏈在裝配之前凍結好交過來，
   * 契約裡給模型的與鏈上校驗用的必須是同一份——細綱在這幾秒裡被改了也不會對不上。
   */
  reviewGoals?: FrozenGoal[];
  /**
   * 修稿（`writeMode: 'revise'`）時勾選的審稿清單（`renderRevisionBrief` 的輸出）。生成層按磁碟
   * 讀好整章原文，與它一起放進 `revision`（generation/generate.ts 的 `planWriting`）。
   */
  reviseBrief?: string;
  /**
   * 寫正文時「本章不出場」的人（五期補遺 §1.2）。生成層按磁碟算好交過來（`planWriting`：帶角色卡上的
   * 稱呼，本章細綱自己提到的不算），與寫完查的那一份同源。缺席時裝配器按 focus 現算一份（只認名字）。
   */
  notYet?: { name: string; no: number }[];
  /** 寫正文時不該用的詞（生成層 `planWriting` 算好交過來）：執行卡後面的【本章邊界】裡點名。 */
  banned?: string[];
  /** 被使用者手動取消勾選的條目 id。 */
  excludedIds?: string[];
  /** provider 的硬性輸入上限，會與 contextWindow 取小。 */
  providerMaxInputTokens?: number;
  /** 使用者本輪 @ 進來的檔案 / 選區引用（Cursor 式）。 */
  attachments?: Attachment[];
  /** 本會話之前的對話輪次，按時間正序，不含本輪。 */
  history?: ChatTurn[];
}

/** 多步生成裡除第一步之外的那幾步。 */
export type ChainStep =
  /** 角色圖譜第二步：按凍結的身份清單補這幾個人的詳情。`done` 是前幾批已經寫好的人（名字）。 */
  | { kind: 'rosterDetails'; manifest: string; names: string[]; done: string }
  /** 設定清單第二步：按凍結的清單補這幾條的正文。`done` 是前幾批已經寫好的條目（名字與一句話）。 */
  | { kind: 'loreListDetails'; manifest: string; titles: string[]; done: string }
  /** 細綱批次裡某一章的緊湊重建：上一次截斷或解不出來，只重做這一章。 */
  | { kind: 'blueprintCompact'; diagnostic?: string }
  /**
   * 正文的續寫那幾輪（generation/continuation.ts）。`tail` 是已寫正文的最後 1600 字，
   * `written` 是這一章到此為止的總字數，`remaining` 是離目標還差多少字（沒有目標時缺席）。
   * `recovery`：上一輪被截斷又沒寫出新東西、已經丟掉了，這是唯一一次恢復機會。
   * `rewound`：上一輪已經按鉤子收了尾、篇幅不夠，收尾那一段剛被拿掉（五期補遺 §1.1），這一輪要
   * 寫足之後重新落到鉤子上。`similes`：已寫部分用了幾次「彷彿 / 猶如 / 宛如」（§1.3）。
   */
  | {
      kind: 'continuation';
      tail: string;
      written: number;
      remaining?: number;
      recovery: boolean;
      rewound?: boolean;
      similes?: number;
      /** 已寫部分對白段的佔比（0–1）。低於 `DIALOGUE_FLOOR` 時這一輪提醒多讓人物開口。 */
      dialogue?: number;
      /** 已寫部分用到的禁用詞與次數：續寫那一輪要換掉。 */
      banned?: { term: string; count: number }[];
    }
  /**
   * 審稿的重來一次（generation/review.ts）：上一次被截斷（`truncated`），或解不出合格的 JSON
   * （`invalid`，`reason` 說為什麼）。上一次的輸出不可信，不許續接。
   */
  | { kind: 'reviewRetry'; why: 'truncated' | 'invalid'; reason?: string };

/**
 * 一章已經排好、還沒落盤的細綱，給前序細綱一覽用。`keyEvents` / `highlights` 是「關鍵事件」「看點」
 * 兩節落盤後的樣子（一條一行）。
 */
export interface DraftPlotLine {
  no: number;
  title: string;
  keyEvents: string;
  highlights: string;
}

export interface BuiltContext {
  messages: ChatMessage[];
  items: ContextItem[];
  /** 實際使用的輸入 token 估算值。 */
  usedTokens: number;
  /** 輸入預算上限。 */
  budget: number;
  /** 上限是否被 provider 配額壓低。 */
  budgetClampedByProvider: boolean;
  /** 這一次按哪一級上下文詳細度裝的（裝配清單與日誌點名用）。 */
  detail: ContextDetail;
}
