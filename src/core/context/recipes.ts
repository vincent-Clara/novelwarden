/**
 * 裝配配方：**每個階段帶什麼、優先順序多少**。
 *
 * 分階段裝配是這次重構裡最直接的質量與成本改動。改之前無論問什麼都裝同一套
 * （近三章原文 + 全部命中角色卡 + 全部摘要）：
 *
 * - **細綱階段被幾萬字原文塞滿，卻一個字都用不上**——它要的是大綱、前後章的
 *   細綱、角色此刻的狀態。這一層的 token 因此降一個數量級。
 * - **正文階段的文風指南排在 P1**，一段長對話（歷史封頂 30%）加上幾張角色卡
 *   就能把它擠掉。而它恰恰是「讀者感覺不到換人執筆」的唯一保障。
 *
 * 所以有幾處刻意的抬高，見下面的 ★。
 */
import { Capability, CreationStage, WriteMode } from '../model/pipeline';
import { ChainStep, LayerSpec } from './types';

/** 單條附件最多吃掉多少預算——使用者 @ 一個大檔案不該把前文全擠掉。 */
const ATTACHMENT_CAP = 0.35;
/*
 * 全部歷史對話最多吃掉多少預算：不寫在配方上，按上下文詳細度那一級的 `historyCap`
 * （預設 0.3，見 model/contextDetail.ts）。只有落定（細綱與設定）寫死在下面。
 */
/**
 * 落定（「落定細綱」，以及完善設定二期的「落定設定」）時歷史對話的封頂。
 *
 * `settle` 要沉澱的**就是那段對話**。按常規的 30% 裝，一段聊了十幾輪的討論會
 * 被由遠及近截掉開頭——而開頭往往正是定調子的地方（「這一章主角不能贏」）。
 * 抬到 60% 並把優先順序提到 0，是這條命令能不能成立的前提（第 22 條）。
 *
 * 不抬到 100%：大綱、前後章、角色卡仍然要帶，不然模型會把討論裡沒提到的
 * 既有設定重新發明一遍。
 */
const SETTLE_HISTORY_CAP = 0.6;

/**
 * 四張配方，一個階段一張。**順序即填充順序**：靠前的先拿預算，靠後的
 * 可能被降級或丟棄。
 *
 * 每張的前四層都一樣（系統提示 / 使用者輸入 / 引用 / 歷史）——那是「這一輪
 * 對話本身」，任何階段都不能少。差別從第五層開始。
 *
 * 架構、大綱、細綱三張按總計劃 §2.3 排（二期）：設定四件一律 P0，大綱帶故事結構指導，
 * 細綱帶大綱裡這幾章前後的條目與前序細綱一覽。正文那一張（三期）帶執行卡、後五章邊界與全域要求。
 *
 * 每張配方（含下面四張專用的）都在 P0 那一組的最後帶一層 `skill`：作者給這個階段綁的寫作技能
 * （移植自 AI-Novel-Writer 的階段 Skill）。不 force——作者事實先拿預算，技能再拿，放不下整份
 * 不帶並寫明原因。討論不帶，由層自己判（`model/writingSkill.ts` 的 `skillStageOf`）。
 *
 * 架構、大綱兩張另掛一層 `written`（已寫正文，拆書 A）：只有「從已寫正文整理」
 * （`BuildRequest.derive`）時才有內容，平時是空的。它排在本層產物之後、技能之前——整理時正文是
 * 這一次唯一的依據，比技能要緊。
 */
export const STAGE_RECIPES: Record<CreationStage, LayerSpec[]> = {
  // ---------------------------------------------------------------- 架構
  // 策劃要看的是已經定下的那幾件：配置、前提、世界觀、已有的角色。**不看正文**
  // ——這一層在第一章之前，也不該被已經寫出來的東西帶著走。（從已寫正文整理時例外：
  // 那時正文就是要整理的東西，經 `written` 帶。）
  //
  // ★ `settingDocs` 與 `rosterDoc` 是 P0：架構幾件一件吃一件，前提要照著配置寫，
  //   世界觀要照著前提與角色寫，少了上一件，這一件就是憑空編的。角色圖譜一覽不強制
  //   ——老工程可能有幾十張卡，放不下時說一聲，完整的卡在 P1 還有一次機會。
  // `lore` P2（設定名錄）：只有設定清單與世界觀兩件用得上——清單要本書的分類表與已有條目
  //   （照用目錄、照抄名字），世界觀帶作者點名的那幾條；其餘幾件層裡自己跳過（layers/background.ts）。
  // ★ 單條設定（展開，完善設定 2026-10-19）掛在這一張上：`loreSelf` P0 force 是焦點（這一條現有的全部
  //   內容，含暗設）；`loreMaterial` P1 是已排細綱裡用到它的地方與定稿過的記錄，合計封頂；`lore` 在這個目標上
  //   挑相關的條目（同目錄的、關鍵詞命中的），去掉它自己。目標不是單條設定時這兩層什麼都不帶
  //   （layers/loreFocus.ts）。
  setting: [
    { layer: 'system', priority: 0, force: true },
    { layer: 'ask', priority: 0, force: true },
    { layer: 'attachments', priority: 0, cap: ATTACHMENT_CAP },
    { layer: 'settingDocs', priority: 0, force: true },
    { layer: 'rosterDoc', priority: 0 },
    { layer: 'written', priority: 0, force: true },
    { layer: 'loreSelf', priority: 0, force: true },
    { layer: 'skill', priority: 0 },
    { layer: 'history', priority: 1 },
    { layer: 'loreMaterial', priority: 1 },
    { layer: 'characters', priority: 1 },
    { layer: 'lore', priority: 2 },
  ],

  // ---------------------------------------------------------------- 大綱
  // 策劃編輯要看全域：架構四件 + 結構指導 + 現有大綱（按遠近帶）+ 全文大綱。**不看正文原文**——
  // 討論故事結構時讀三章原文既沒用又昂貴。**也不帶前面各章的細綱**（從前的 `plotSummary`，最多 60 章整份）：
  // 續寫到後面每一次都在為前面幾十章付錢，還會被那一大片概要帶著走（2026-10-21）；已經寫過的部分由全文大綱交代。
  //
  // ★ `structure` P0 force：大綱按總章數排結構拐點，沒有章號區間，模型會按它熟悉的
  //   篇幅去排，寫出來與總章數對不上。
  // ★ 現有大綱 P0 force：續寫第 21–40 章時它就是「已完成的字首」，少了它續出來的
  //   是另一本書。按遠近帶分三段：最近 10 章整條（強制），再往前一章一行、最多 `outlineBriefMax` 章（不強制），
  //   更早的交給全文大綱（layers/artifacts.ts 的 `outlineDoc`，2026-10-22）。
  // ★ `globalSummary` P1（從前 P2）：遠段不再逐章列，前情靠它接住，不能比角色卡先被擠掉。
  // 角色圖譜（大綱、細綱兩張同一個帶法，2026-10-24）：仍是 P0 force，但只給主角、近 `rosterRecent` 章出場的與這一次提到的
  // 一人一段，角色卡層整張帶的只點名，其餘只列名字（layers/artifacts.ts 的 `rosterDoc`）。從前全員一人一段，四十幾張卡就上萬 token。
  outline: [
    { layer: 'system', priority: 0, force: true },
    { layer: 'ask', priority: 0, force: true },
    { layer: 'attachments', priority: 0, cap: ATTACHMENT_CAP },
    { layer: 'settingDocs', priority: 0, force: true },
    { layer: 'rosterDoc', priority: 0, force: true },
    { layer: 'structure', priority: 0, force: true },
    { layer: 'outlineDoc', priority: 0, force: true },
    { layer: 'skill', priority: 0 },
    { layer: 'history', priority: 1 },
    { layer: 'globalSummary', priority: 1 },
    { layer: 'characters', priority: 1 },
    { layer: 'lore', priority: 2 },
  ],

  // ---------------------------------------------------------------- 細綱
  // 劇情編劇要看：設定四件、大綱裡這一次要拆的那幾條、前面排到哪（前序細綱一覽，更早的看全文大綱）、
  // 後面已經排好了什麼。**不看正文原文**：排細綱要的是走向，不是措辭。
  //
  // 單章與批次共用這一張：`plotSelf` / `plotPrev` 只在單章時出場，批次時由
  // `plotList` 全包（見 layers/artifacts.ts）。更早幾章不另帶一份：
  // 細綱與定稿是同一份檔案，`plotPrev` 與 `plotList` 已經帶了，同一份不帶兩遍——大綱也一樣，
  // 已經拆過的章它不再帶梗概（2026-10-22）。
  //
  // ★ `outlineDoc` P0 force：細綱是從大綱裡拆出來的，少了這幾章的條目就是憑空編。只帶這一次要拆的——批次那幾條與
  //   區間前還沒拆的空殼（單章時這一章的梗概在本章細綱裡），這幾章之後的不帶（layers/artifacts.ts）。
  // ★ `plotNext` 少了它，改中間某一章時模型不知道後面已經排好了什麼，收尾會與
  //   下一章的開頭撞車或斷裂——「轉折突兀」多半出在這裡。
  // ★ `recentFacts` P1：已定稿各章的連續性事實是既成歷史。全文大綱排在它後面，預算緊時先被擠掉，
  //   細綱就會排出與正文矛盾的事（死了的人再出場、已經炸掉的大陣再炸一次）。
  // ★ `threads` P1、緊跟 `recentFacts`（敘事線二期）：細綱照著線排——沒收束的線現在走到哪、這一批（這一章）裡該收的
  //   伏筆、原來的計劃（重拆時）。少了它，回收全靠運氣；計劃寫進線裡（細綱合同的 `threads` 欄位）也無從寫起。
  //   按區間挑（`focus.range`），線與伏筆各自按上下文詳細度封頂（layers/background.ts 的 `admitPlotThreads`）。
  // ★ `globalSummary` P1（從前 P2）：前序細綱一覽只列最近 `plotListMax` 章（預設 30，2026-10-24 從 100 降下來），更早的前情靠它。
  // 角色圖譜的帶法同大綱那一張。
  plot: [
    { layer: 'system', priority: 0, force: true },
    { layer: 'ask', priority: 0, force: true },
    { layer: 'attachments', priority: 0, cap: ATTACHMENT_CAP },
    { layer: 'plotSelf', priority: 0, force: true },
    { layer: 'settingDocs', priority: 0, force: true },
    { layer: 'rosterDoc', priority: 0, force: true },
    { layer: 'outlineDoc', priority: 0, force: true },
    { layer: 'skill', priority: 0 },
    { layer: 'history', priority: 1 },
    { layer: 'plotPrev', priority: 1 },
    { layer: 'plotList', priority: 1 },
    { layer: 'plotNext', priority: 1 },
    { layer: 'recentFacts', priority: 1 },
    { layer: 'threads', priority: 1 },
    { layer: 'globalSummary', priority: 1 },
    { layer: 'structure', priority: 1 },
    { layer: 'characters', priority: 2 },
    // 設定名錄（2026-10-18）：從 P3 提到 P2——排細綱時最該知道已有哪些地點、勢力、物品，
    // 不然新的一章會另起一個名字。幾百條也不怕：lore 層按上下文詳細度封頂，其餘只列一句話。
    { layer: 'lore', priority: 2 },
  ],

  // ---------------------------------------------------------------- 正文
  // 唯一保留全套裝配的階段。按總計劃 §2.3 排（三期），移植自 AI-Novel-Writer 的
  // `next_chapter_draft` 材料包（GD:431-660）。
  //
  // ★ 文風指南 P0 force：它決定讀者感不感覺到換人執筆，不該跟一段長對話搶預算。
  // ★ `plotSelf` P0 force：細綱**就是**寫正文的依據。少了它，模型手上只有文風與
  //   前文尾巴，會自己編一章出來。
  // ★ `guidance` P0 force：小說配置的「全域要求」是作者定下的跨章規矩，每一章都得守。
  // ★ `plotAhead` P0 force：後 5 章的細綱是**邊界**。沒有它，模型寫到鉤子時最順手的
  //   就是把下一章的事提前演掉。
  // ★ `chapterSoFar` P0 force：「接著寫」要從本章已寫的末尾往下接，少了它就是另起一章。
  // ★ `evidence` 排在 P2 的最前面（四期，D18）：定稿過的細綱是模型對正文的轉述，會走樣；證據所在的
  //   原文段落才是作者認可過的那一版。它比全文大綱、設定條目更接近「這裡到底寫了什麼」。
  // ★ `threads` P1（七期，敘事線重做後一條線一行：現在走到哪、本章計劃、沒收的伏筆）：
  //   敘事線是「計劃」，而且很短（≤1200 字）。它還帶著「第 b 章前不要揭開」——這一句擠掉了，
  //   模型照樣知道要揭開什麼，只是不知道還不能揭。
  // **不帶情節大綱，也不帶更早幾十章的細綱**（2026-10-21，從前的 `outlineSlice` 與 `plotSummary`，後者最多 60 章）：
  //   細綱已經是大綱這一章的展開；一大片概要會把正文帶成概要腔。前情只帶前幾章細綱（`plotPrev` P1，梗概 / 關鍵事件 /
  //   狀態變更，條數隨上下文詳細度，預設 3）、前兩章全文、連續性事實的原文片段與全文大綱。
  // 執行卡與篇幅合同不是層：由輸出契約拼在訊息最末（上游 GD:657 的順序）。
  manuscript: [
    { layer: 'system', priority: 0, force: true },
    { layer: 'ask', priority: 0, force: true },
    { layer: 'attachments', priority: 0, cap: ATTACHMENT_CAP },
    { layer: 'style', priority: 0, force: true },
    { layer: 'guidance', priority: 0, force: true },
    { layer: 'plotSelf', priority: 0, force: true },
    { layer: 'prevTail', priority: 0, force: true },
    { layer: 'plotAhead', priority: 0, force: true },
    { layer: 'chapterSoFar', priority: 0, force: true },
    { layer: 'revision', priority: 0, force: true },
    { layer: 'skill', priority: 0 },
    { layer: 'characters', priority: 1 },
    { layer: 'premiseWorld', priority: 1 },
    { layer: 'plotPrev', priority: 1 },
    { layer: 'threads', priority: 1 },
    { layer: 'history', priority: 1 },
    { layer: 'evidence', priority: 2 },
    { layer: 'globalSummary', priority: 2 },
    { layer: 'lore', priority: 2 },
    { layer: 'manuscriptFull', priority: 3 },
  ],
};

/**
 * 正文續寫那幾輪的配方（generation/continuation.ts）。
 *
 * 上游續寫時把整個材料包再發一遍（GD:1036）。這裡只帶「接著寫」真正要看的：這一章要落實
 * 什麼（細綱）、不許寫到哪（邊界）、從哪接（已寫末尾）、怎麼寫（文風、全域要求）、誰在場
 * （出場角色）。前幾章細綱、前幾章全文這些第一次呼叫已經用過了，那一場怎麼開頭已經寫在
 * 已寫的正文裡——再發一遍只是讓每一輪都付一次全價。
 *
 * ★ `recentFacts` P1：近幾章定稿留下的連續性事實（≤3000 字）。百章實驗裡首輪常只寫到一半，
 *   續寫那幾輪寫出了一章的大半——它們一條前情都不帶時，已經死了的人在續寫裡又活過來。
 * ★ `lore` P2（設定名錄）：只帶本章細綱點名的與關鍵詞命中的（含本章已寫的末尾）。從前續寫一條設定
 *   都不帶，後半章裡的地點、法寶全憑模型記憶。
 */
const CONTINUATION_RECIPE: LayerSpec[] = [
  { layer: 'system', priority: 0, force: true },
  { layer: 'ask', priority: 0, force: true },
  { layer: 'style', priority: 0, force: true },
  { layer: 'guidance', priority: 0, force: true },
  { layer: 'plotSelf', priority: 0, force: true },
  { layer: 'plotAhead', priority: 0, force: true },
  { layer: 'chapterSoFar', priority: 0, force: true },
  { layer: 'skill', priority: 0 },
  { layer: 'characters', priority: 1 },
  { layer: 'recentFacts', priority: 1 },
  { layer: 'lore', priority: 2 },
];

/**
 * 審稿（五期）：審稿編輯要看的是**這一章寫了什麼**與**它該對得上什麼**。按總計劃 §2.3 排，
 * 移植自 AI-Novel-Writer `review-chapter.command.ts` 的材料（RV:121-281）。
 *
 * ★ `chapterFull` / `plotSelf` P0 force：審的就是這一章；目標清單從細綱凍結，少了它無從核對。
 * ★ `plotAhead` P0（不強制）：後幾章的計劃標「非既定歷史」，只用來判斷本章有沒有提前寫掉
 *   （上游 `planningMaterial`）。
 * ★ `recentFacts` P2：前幾章定稿留下的連續性事實——上游審稿讀的「已定稿歷史」就是它。只帶事實
 *   文字，不像寫正文那樣回原文取段落：判一句話有沒有與前文矛盾，事實本身就夠了。
 * ★ `threads` P1（敘事線重做 ⚑5）：只帶伏筆那一半——沒收的、本章計劃埋或收的。提示詞裡兩條伏筆檢查從前的材料
 *   （角色卡「未收伏筆」、細綱「新增伏筆」）都並進了敘事線，不帶它那兩條就沒材料。整條線「計劃推進的寫到沒有」
 *   下一期再查。
 * 不帶歷史對話：審稿判的是正文，不是聊天記錄。不帶文風：文筆不在審查範圍裡。
 */
const REVIEW_RECIPE: LayerSpec[] = [
  { layer: 'system', priority: 0, force: true },
  { layer: 'ask', priority: 0, force: true },
  { layer: 'chapterFull', priority: 0, force: true },
  { layer: 'plotSelf', priority: 0, force: true },
  { layer: 'plotAhead', priority: 0 },
  { layer: 'skill', priority: 0 },
  { layer: 'characters', priority: 1 },
  { layer: 'premiseWorld', priority: 1 },
  { layer: 'guidance', priority: 1 },
  { layer: 'prevTail', priority: 1 },
  { layer: 'threads', priority: 1 },
  { layer: 'recentFacts', priority: 2 },
];

/**
 * 按勾選的審稿意見修稿（五期）。移植自 AI-Novel-Writer 的 `refine_from_review`（PT:1023-1055）：
 * 上游只給「審稿清單 + 待修稿全文 + 全域要求」。這裡多帶幾樣修得對要看的東西，但**不帶**寫正文
 * 那一套（大綱、前幾章細綱、近章全文）——修稿不是再寫一章。
 *
 * ★ `revision` P0 force：整章原文 + 勾選清單，這就是這一次的全部任務。
 * ★ `style` / `guidance` P0 force：改過的那幾句要與全章同一個聲音。
 * `plotSelf`（修「未完成的目標」要看細綱原話）、`prevTail`（修「接不上上一章」）、`plotAhead`
 * （別把後面幾章的事寫進來）、`evidence`（修連續性問題要看定稿原文）都不強制。
 */
const REVISE_RECIPE: LayerSpec[] = [
  { layer: 'system', priority: 0, force: true },
  { layer: 'ask', priority: 0, force: true },
  { layer: 'revision', priority: 0, force: true },
  { layer: 'style', priority: 0, force: true },
  { layer: 'guidance', priority: 0, force: true },
  { layer: 'skill', priority: 0 },
  { layer: 'plotSelf', priority: 1 },
  { layer: 'characters', priority: 1 },
  { layer: 'prevTail', priority: 1 },
  { layer: 'plotAhead', priority: 1 },
  { layer: 'evidence', priority: 2 },
];

/**
 * 修稿被截斷之後接著寫的那幾輪：原文與清單（`revision`）+ 已經修訂到哪（`chapterSoFar`）。
 * 上游續寫帶的是原始任務的頭尾各一截（`bounded-completion.ts:398-419`）；這裡原文整份帶著，
 * 模型才知道剩下那半章原來是怎麼寫的。
 */
const REVISE_CONTINUATION_RECIPE: LayerSpec[] = [
  { layer: 'system', priority: 0, force: true },
  { layer: 'style', priority: 0, force: true },
  { layer: 'guidance', priority: 0, force: true },
  { layer: 'revision', priority: 0, force: true },
  { layer: 'chapterSoFar', priority: 0, force: true },
  { layer: 'skill', priority: 0 },
];

/**
 * 取某階段的配方。
 *
 * `capability` 影響兩處：`settle` 要把歷史對話抬成 P0 並放寬封頂（做成「按能力微調既有配方」
 * 而不是再寫一張完整配方，是因為其餘十一層與 `generate` 一模一樣——複製一份，下次改劇情層的
 * 裝配策略就會漏掉一邊；不分階段，落定設定走的是架構那一張，同樣抬），落定設定再把 `lore` 提到歷史後面；
 * `review` 換成審稿那一張（它要的東西與寫正文幾乎不重合）。
 *
 * `step` 是續寫那幾輪時換成精簡配方（見 {@link CONTINUATION_RECIPE}）；`writeMode` 是修稿時
 * 換成修稿那兩張。
 */
export function recipeFor(stage: CreationStage, capability?: Capability, step?: ChainStep, writeMode?: WriteMode): LayerSpec[] {
  if (stage === 'manuscript' && capability === 'review') {
    return REVIEW_RECIPE;
  }
  if (stage === 'manuscript' && writeMode === 'revise') {
    return step?.kind === 'continuation' ? REVISE_CONTINUATION_RECIPE : REVISE_RECIPE;
  }
  if (stage === 'manuscript' && step?.kind === 'continuation') {
    return CONTINUATION_RECIPE;
  }
  const recipe = STAGE_RECIPES[stage] ?? STAGE_RECIPES.manuscript;
  if (capability !== 'settle') {
    return recipe;
  }
  const settled = recipe.map((spec) =>
    spec.layer === 'history' ? { ...spec, priority: 0 as const, cap: SETTLE_HISTORY_CAP } : spec
  );
  // 落定設定（完善設定二期）：討論裡提到的已有條目要合併，得看得見原文——`lore` 從 P2 的末尾提到歷史後面（P1），
  // 不讓角色卡先把預算拿走。
  if (stage !== 'setting') {
    return settled;
  }
  const lore = settled.find((spec) => spec.layer === 'lore');
  const rest = settled.filter((spec) => spec.layer !== 'lore');
  const at = rest.findIndex((spec) => spec.layer === 'history') + 1;
  return lore ? [...rest.slice(0, at), { ...lore, priority: 1 as const }, ...rest.slice(at)] : settled;
}
