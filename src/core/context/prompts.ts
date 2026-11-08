import { traditionalLabel } from '../model/labels';
/**
 * 提示詞：**身份（Stage）× 任務（Capability）× 輸出契約**。
 *
 * 同一句「這裡衝突太弱」，四個階段該給出完全不同的回答：策劃去動賣點與人設，
 * 大綱編輯去動故事結構，劇情編劇去調這一章的事件與鉤子，作者去改措辭。
 * 不說清身份，四個階段會得到同一種泛泛而談的回答。
 *
 * 三段拼起來：
 *
 * 1. **身份**（來自 stage）：你是誰，這一層要解決什麼問題，不要越界去幹下一層的活
 * 2. **任務**（來自 capability）：這一次要你做什麼
 * 3. **輸出契約**（來自兩者）：產出什麼形狀的東西
 *
 * 輸出契約分兩類，由 `outputKindOf` 決定：
 *
 * - `text`：自由作答，**明確禁止直接改寫產物**。不寫這一條，模型會一邊回答
 *   一邊把整份劇情重寫一遍，而使用者根本不知道該採納哪一個。
 * - `artifact`：產出結構化的產物，可以採納落盤。
 *
 * ## 架構、大綱、細綱的契約移植自 AI-Novel-Writer
 *
 * 小說配置、故事前提、角色圖譜（兩步）、世界觀、情節大綱、細綱批次的任務與輸出合同
 * 移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）的
 * `src/services/prompt-templates.ts`（`generate_global_config` / `premise` /
 * `character_dynamics` / `world_building` / `synopsis` / `chapter_blueprint_chunk`）、
 * `prompt-language.ts`（角色身份 / 詳情合同）、`commands/architecture.command.ts`
 * （配置 JSON 合同、大綱分批指令）、`commands/directory.command.ts`（章節容量合同）與
 * `shared/blueprint-semantic-contract.ts`（藍圖合同）。每一段在下面註明出處。
 *
 * 上游的模板把「事實」用變數填進正文；這裡事實由裝配器分層給出（`# 故事架構`、
 * `# 情節大綱`、`# 前序細綱一覽`……），契約只保留任務、要求與格式，指向那幾節。
 *
 * 補上的兩處上游缺口：角色圖譜的設計原則（上游內建模板的這一段從來沒發出去，見
 * {@link rosterManifestContract}）；六種故事結構都帶章號區間（見 model/structureGuide.ts）。
 */
import type { ChatMessage } from '../llm/provider';
import {
  Capability,
  CreationAction,
  CreationStage,
  CreationTarget,
  LORE_LIST_MAX,
  LORE_LIST_MIN,
  ROSTER_MAX,
  ROSTER_MIN,
  STAGE_ROLE,
  WriteMode,
  isLoreSettle,
  outputKindOf,
} from '../model/pipeline';
import { BLUEPRINT_LIMITS, sectionItems } from '../model/plotFile';
import { NAME_MAX, PLAN_EVENT_LIMIT, UNFILED_NAME, planScope } from '../model/threadFile';
import { LORE_ENTRY_LIMITS, LORE_HIDDEN_MARK, LORE_LINE_LIMITS, LORE_LIST_BODY_MAX } from '../model/loreFile';
import {
  FrozenGoal,
  REVIEW_DESCRIPTION_MAX,
  REVIEW_ITEMS_MAX,
  REVIEW_QUOTE_MAX,
  REVIEW_SUMMARY_MAX,
  frozenGoalsList,
} from '../model/review';
import {
  BookConfig,
  GUIDANCE_MAX_CHARS,
  GUIDANCE_MAX_RULES,
  GUIDANCE_MIN_RULES,
  NARRATIVE_POV_LABEL,
  SETTING_DOC_HEADING,
  SETTING_SECTION_KEYS,
} from '../model/settingFile';
import { CHARACTER_DETAIL_LIMITS, NovelConfig } from '../model/types';
import { DIALOGUE_FLOOR, NotYet, SIMILE_LIMIT, SIMILE_WORDS } from '../model/manuscriptCheck';
import { transcribeMessages } from '../model/transcribe';
import { LORE_EXPAND_ETHOS, loreExpandContract } from './loreExpandPrompt';
import { LORE_SETTLE_ETHOS, LORE_SETTLE_TASK, loreSettleContract } from './loreSettlePrompt';
import type { ChainStep } from './types';

/**
 * 提示詞要知道的這一次的事實。裝配器（builder.ts 與 system 層）填好交過來。
 *
 * `book` 是磁碟上那份 `config.md`：規模（總章數、每章字數）、型別、視角都從它來。
 */
export interface PromptFacts {
  target?: CreationTarget;
  targetWords?: number;
  /** 這一步覆蓋的章號區間：大綱寫哪一段、細綱拆哪一批。 */
  range?: { from: number; to: number };
  /** 一句話彈窗帶過來的規模。給了就以它為準。 */
  setup?: { totalChapters: number; wordsPerChapter: number };
  /** 多步生成裡的哪一步（generation/structured.ts）。預設 = 第一步。 */
  step?: ChainStep;
  book?: BookConfig;
  /** 目標章的章號（單章細綱要寫「第 N 章」）。 */
  no?: number;
  /** 本章細綱裡執行卡要重列的那一項（寫正文時）：「關鍵事件」一節的原文（一條一行）。 */
  plot?: { keyEvents: string };
  /** 作者這一輪說的話：寫正文時它是「作者本章指導」，進執行卡。 */
  ask?: string;
  /** 寫正文的寫法（`continue` 時契約改成「只寫新增的那一段」）。 */
  writeMode?: WriteMode;
  /** 「接著寫」時這一章已經有多少字（算「還差多少」）。續寫那幾輪由 `step.written` 給。 */
  written?: number;
  /** 審稿時凍結的目標清單（審稿鏈交過來的那一份）。 */
  reviewGoals?: FrozenGoal[];
  /**
   * 寫正文時「本章不出場」的人：後五章細綱裡排了、本章與前面各章都沒排過的（五期補遺 §1.2）。
   * 裝配器從 focus 算好交過來（model/manuscriptCheck.ts 的 `notYetOnStage`）。
   */
  notYet?: NotYet[];
  /** 寫正文時不該用的詞（生成層算好、經 `BuildRequest.banned` 交過來）。 */
  banned?: string[];
  /** 從已寫正文整理（拆書 A）：作者已經寫到第 `through` 章。契約換成「照正文整理」的說法。 */
  derive?: { through: number };
}

/** 每個階段管什麼、**不管**什麼。後半句同樣要緊：越界是這套設計最主要的失敗方式。 */
const STAGE_DUTY: Record<CreationStage, string> = {
  setting:
    '你負責這部小說在動筆之前的架構：它是什麼型別、賣點和讀者的情緒痛點在哪、主角是誰、' +
    '金手指怎麼運作、世界按什麼規則運轉、主要人物之間是什麼關係。\n' +
    '後面的大綱、細綱、正文都從這裡展開，所以要具體、能落地——寫出來的每一條都要能被' +
    '後面的章節用上。你不排章節，也不寫正文。\n' +
    '**架構首先要回答「讀者為什麼追這本書」**：爽點是什麼、怎樣反覆兌現、靠什麼懸念吊著人往下翻。' +
    '讀完說不出這本書爽在哪的架構，寫得再全也是失敗的；情節經過是大綱的事，不要在這裡寫成劇情流水賬。',
  outline:
    '你負責整個故事的結構：主線走向、衝突的升級曲線、每個階段的高潮與轉折、伏筆的埋與收。\n' +
    '大綱**一章一條**（`## 第3章：火折逼退`）：第一行一句話寫這一章發生什麼、結果如何，下面最多再補兩句。' +
    '它是提綱，不是摘要：只寫事，不寫描寫與渲染。你不寫單章的細綱，也不寫正文——那是後面兩層的事。',
  // 從前這一層禁止寫畫面與動作、只許寫抽象的因果鏈。那是讓模型去「擴寫」一條梗概，
  // 寫出來是流水賬。現在一章一綱，關鍵事件可以寫到具體場面。
  plot:
    '你負責把這一章要發生什麼定下來：梗概、誰出場、在哪、落在哪幾個具體場面上的關鍵事件、' +
    '讀者最爽的那一下與把讀者拽進下一章的東西（看點）、埋下哪些伏筆、人物之後變成什麼樣。\n' +
    '**關鍵事件可以寫具體場面**——誰在哪、對誰做了什麼、結果怎樣；但它不是正文，' +
    '不寫成段的描寫與對白。每一章都要有實質推進，不要寫「繼續發展」這種空話。',
  manuscript:
    '你負責把已經定好的這一章寫成文學文字。發生什麼不由你決定——那在本章細綱裡已經定了。' +
    '**怎麼寫成可感的場面由你來定**：畫面、動作、對白、節奏。你要交出的是讀起來像小說的文字。\n' +
    '前文定稿留下的連續性事實是既成歷史：細綱與它衝突時（已經死了的人、已經毀掉或交出去的東西、' +
    '已經發生過的事），以事實為準，不照細綱重演。',
};

/**
 * 產出產物時的那一句做事原則。取自上游各模板的 `systemRole`：它們都在說同一件事——
 * **作者寫下的是權威事實**，你是在它上面展開，不是另起爐灶。
 */
const ETHOS = {
  config: '你擅長從簡短靈感中提煉完整、一致且可執行的小說配置。尊重作者事實，明確因果、角色選擇與代價，不輸出思考過程。',
  premise: '尊重作者事實，以清晰因果、角色主動選擇及其代價構建可持續發展的故事前提。',
  characters: '尊重作者事實，以具體慾望、選擇、關係張力與代價塑造角色。',
  world: '尊重作者事實，讓規則、資源與權力結構通過具體衝突推動故事。',
  lore: '尊重作者事實，把世界觀裡點到的東西一樣一樣立住：它是什麼、怎麼運轉、邊界與代價在哪，前後叫法一致。',
  outline: '尊重作者事實，以角色選擇、阻力、代價與因果升級組織完整情節。',
  plot: '將作者事實轉化為連續的具體事件、角色行動、阻力、轉折和章節鉤子，保持角色動機、因果鏈和長篇節奏一致，不輸出思考過程。',
} as const;

/** 每種能力要模型做什麼。與階段無關的那一半。 */
const CAPABILITY_TASK: Record<Capability, string> = {
  discuss: '作者要和你討論。他問什麼你答什麼：要建議給建議，要分析給分析，要判斷給判斷。',
  // 改寫不是獨立能力：上面已經給出這一層的現成產物時，作者那句話就是修改意見。
  generate:
    '作者已經描述了他想要的走向（見下面「我的要求」）。**按他說的產出**，不要另起爐灶改走向；' +
    '他沒說到的地方，順著已有設定與前後文補上，別停在半截。\n' +
    '上面已經給出這一層的現成產物時，作者的話就是對它的修改意見：在那一版的基礎上重做，' +
    '採納他的意見，同時保留上一版裡寫得好的部分。',
  // 這一條與 generate 的差別就是兩條路：一條從作者的描述出發，
  // 一條從剛發生過的討論出發。說不清「以哪邊為準」，模型會把兩者混著編。
  settle:
    '你和作者剛討論完這一章（完整對話就在上面）。把討論中**已經達成的結論**整理成產物。\n' +
    '以討論裡定下的為準：**不要塞進討論中被否掉的方案**，也不要臨時發明誰都沒提過的新走向。\n' +
    '討論中懸而未決的地方，按最接近的結論寫或留空，並在產物之外用一兩句話說明哪幾處還沒定——' +
    '那正是作者接下來要接著聊的東西。',
  // 審稿有自己的系統提示（`reviewSystemPrompt`），這一句只在認不出配方時兜底。
  review: '審閱這一章正文，只報告有正文證據的客觀問題，不改寫正文。',
};

function ethosOf(stage: CreationStage, target?: CreationTarget): string | undefined {
  if (stage === 'setting') {
    // 單條設定（展開）不是架構五件裡的哪一件：它有自己的一句（context/loreExpandPrompt.ts）。
    if (target?.kind === 'lore') {
      return LORE_EXPAND_ETHOS;
    }
    return ETHOS[target?.kind === 'setting' ? target.doc : 'config'];
  }
  return stage === 'outline' ? ETHOS.outline : stage === 'plot' ? ETHOS.plot : undefined;
}

/**
 * 系統提示詞。
 *
 * 正文階段的前五條硬性要求逐字保留——它們是這個專案跑了很久、調出來的東西
 * （不復述前情、不寫章節標題…），換個說法就等於重新試錯一遍。其餘移植自上游，見
 * {@link manuscriptSystemPrompt}。
 */
export function buildSystemPrompt(action: CreationAction, config: NovelConfig, facts: PromptFacts = {}): string {
  const { stage, capability } = action;

  if (stage === 'manuscript' && capability === 'review') {
    return REVIEW_SYSTEM_PROMPT;
  }
  if (stage === 'manuscript' && capability === 'generate' && facts.writeMode === 'revise') {
    return REVISE_SYSTEM_PROMPT;
  }
  if (stage === 'manuscript' && capability === 'generate') {
    return manuscriptSystemPrompt(config, facts);
  }

  const producing = outputKindOf(action) === 'artifact';
  // 落定設定（完善設定二期）有自己的一句原則與任務：`CAPABILITY_TASK.settle` 說的是「這一章」，還要模型在產物之外
  // 說明沒定的——與輸出格式打架（context/loreSettlePrompt.ts）。
  const settlingLore = isLoreSettle(action);
  const ethos = producing ? (settlingLore ? LORE_SETTLE_ETHOS : ethosOf(stage, facts.target)) : undefined;
  const lines = [
    `你是一位${STAGE_ROLE[stage]}，正在協助作者推進一部長篇中文小說。${ethos ?? ''}`,
    '',
    STAGE_DUTY[stage],
    '',
    settlingLore ? LORE_SETTLE_TASK : CAPABILITY_TASK[capability],
    ...(producing && facts.derive ? ['', deriveTask(facts.derive.through)] : []),
    '',
    '通用要求：',
    '1. 一切判斷建立在已給出的文風指南、設定、角色卡與前文之上，不要憑空發明設定。',
    '2. 發現作者的想法與既有設定衝突（人物性格、已收伏筆、時間線）時必須直說，並給出可行的調整方案。',
    '3. 具體，不要泛泛而談。能引用上面給出的原文就引用。',
    `4. ${ERA_RULE}`,
  ];

  if (!producing) {
    // 這一條是「討論型能力」的邊界。少了它，模型會一邊回答一邊把整份產物
    // 重寫一遍，而介面上那一版是不能採納的，使用者只會困惑。
    lines.push('5. **只回答，不要輸出改寫後的完整產物。** 需要落到檔案上的改動由作者另行發起。');
  }

  lines.push('', '語言：繁體中文。');
  return lines.join('\n');
}

/**
 * 用詞貼合故事的年代（五期補遺 §1.5）。三期首跑：民國背景的書，角色圖譜裡模型寫了「嚴重的
 * PTSD」，一路帶進細綱與正文。架構、大綱、細綱、正文四個階段都帶這一條——越早的階段寫進去，
 * 後面每一層都照著抄。
 */
const ERA_RULE =
  '用詞貼合故事的年代與世界觀：古代、民國、架空世界不用現代醫學、心理學、網路與科技術語' +
  '（如 PTSD、抑鬱症、多巴胺、CPU），換成那個年代的人會說的話（如「驚悸」「心病」）。';

// ---------------------------------------------------------------- 從已寫正文整理（拆書 A）

/**
 * 系統提示裡那一句：這一次是整理，不是創作。上游（AI-Novel-Writer `infer_novel_config_with_vectors`、
 * `infer_blueprints_per_chapter`）的說法是「必須基於正文實際內容提取，不可臆造」「未能確定的填寫（待確認）」；
 * 這裡不讓模型寫「待確認」——後面的續寫會把這三個字當設定讀。
 */
function deriveTask(through: number): string {
  return (
    `這一次不是從零創作：作者已經寫到第 ${through} 章（見下面「已寫正文」），要你把已經寫成的東西整理成這一層的產物，` +
    '好讓後面的續寫接得上。**正文是權威事實**：照它整理，專有名詞一字不改，不美化、不改寫、不另起爐灶。'
  );
}

/** 契約開頭那一段：正文寫到的照抄，必填而正文沒寫到的順著走向補，不許把沒發生的事寫成發生過。 */
function deriveLead(facts: PromptFacts): string[] {
  if (!facts.derive) {
    return [];
  }
  return [
    `【從已寫正文整理（重要）】作者已經寫到第 ${facts.derive.through} 章，正文見上面「已寫正文」。`,
    '- 正文裡寫到的人物、關係、規則、事件、境界與伏筆以正文為準，專有名詞一字不改；',
    '- 這一件必填、正文還沒寫到的部分，順著正文已有的走向補上，不得與正文矛盾，也不要把沒發生的事寫成已經發生；',
    '- 不要寫「待確認」「未知」這類佔位——拿不準的地方按正文最可能的意思寫，寧可少寫。',
    '',
  ];
}

// ---------------------------------------------------------------- 正文

/**
 * 去 AI 味的禁令（D8）。移植自 `first_chapter_draft` / `next_chapter_draft` 的
 * 「AI 味反制」（PT:776-780、850-854），一字不改地寫進每一次寫正文的系統提示。
 */
export const ANTI_AI_RULES: readonly string[] = [
  '禁止段尾總結句（如「他知道，這一切才剛剛開始」「命運的齒輪開始轉動」）',
  // 上游只點名前三個；百章實驗裡模型改用「如同」，所以按 SIMILE_WORDS 全列。
  `${SIMILE_WORDS.map((w) => `「${w}」`).join('')}全章合計不超過 ${SIMILE_LIMIT} 次`,
  '對話必須區分角色語氣：不同角色的說話方式必須有辨識度',
  '禁止在結尾新增與正文無關的哲理感悟或旁白總結',
];

/** 這一次寫的是第 1 章：上游第 1 章與後續章各一套提示詞（PT:720-855）。 */
function isFirstChapter(facts: PromptFacts): boolean {
  return facts.no === 1;
}

/**
 * 寫正文的系統提示。移植自 `first_chapter_draft` / `next_chapter_draft` 的
 * `systemRole` 與 `systemSuffix`（PT:724、758-780、787、831-854）。
 *
 * 原有的六條硬性要求保留了前五條。第 6 條從前是「不要在結尾強行收束，留出繼續往下寫的
 * 餘地」——那是一段細綱拆成幾章寫時的規矩；一章一綱之後這一章就該停在細綱約定的結束狀態上，
 * 於是換成上游的「按約定的結束狀態收束」。
 *
 * 上游的「不可偏離的作者事實」在它那裡是把故事架構全文塞進系統提示；這裡事實由裝配器
 * 分層給出，系統提示只留那條規矩本身。
 */
function manuscriptSystemPrompt(config: NovelConfig, facts: PromptFacts): string {
  const first = isFirstChapter(facts);
  const words = facts.targetWords;
  const pov = facts.book?.pov ? NARRATIVE_POV_LABEL[facts.book.pov] : undefined;
  const rules = [
    '1. 嚴格貼合已給出的文風指南與上文語氣，讀者應當感覺不到換人執筆。',
    '2. 人物的性格、稱謂、說話習慣必須與角色設定一致，不得憑空改變人物關係或已確立的設定。',
    '3. 完整落實本章細綱裡的每一個關鍵事件，按順序推進，寫成有場景、有對白的成稿。',
    first
      ? '4. 不要用長篇大論介紹世界觀，設定只在情節需要時通過動作與對話帶出來。'
      : '4. 不要複述前情，不要寫「上回說到」，直接從上一章結尾的情境自然接續。',
    '5. 只輸出正文。不要輸出章節標題、小標題、分隔線、創作說明、字數統計或任何元資訊，也不要用 Markdown 符號（* 、# 之類）。',
    '6. 按本章細綱約定的結束狀態收束（看點裡寫的章末懸念落在結尾）；不在結尾做總結陳詞，不擅自新增高潮、突發變故或後續章節的事件。',
    `7. ${ERA_RULE}`,
    ...(words ? [`8. 篇幅約 ${words} 字，不必精確。`] : []),
  ];
  return [
    first
      ? '你是一位經驗豐富的中文長篇小說作者，正在為一部新作寫第一章。尊重作者事實，通過具體場景、動作和有區分度的對話推進因果，不輸出思考過程或元話術。'
      : '你是一位經驗豐富的中文長篇小說作者，正在為一部連載作品寫新的一章。保持長篇連續性，通過角色主動選擇、阻力和代價推進本章，不輸出思考過程或元話術。',
    '',
    '硬性要求：',
    ...rules,
    '',
    '【不可偏離的作者事實】',
    '故事架構、小說配置與角色卡裡作者明確寫下的設定是不可改寫的事實源：不得刪除、弱化、反轉或用型別慣例替換；本章暫不展開的事實也不得寫出相反的內容。',
    '',
    '【文風適用邊界】',
    '- 文風僅用於選擇表達方式，不是新增事實或事件要求，無需逐條強行兌現。',
    '- 作者明確的事實與要求、實際前文、本章關鍵因果和本章篇幅優先。不得用文風改寫這些內容，也不要只為兌現文風去增加場景、動作或事件。',
    '',
    '【格式】',
    '- 所有對話使用中文雙引號，不寫劇本式對白。',
    '- 段落與段落之間空一行，不要把多個段落擠成一大塊。',
    '- 一次寫不到目標字數時停在自然段落末尾，不要寫「繼續生成」「未完待續」之類的提示。',
    ...(pov ? [`- 敘事視角：${pov}。不寫視角人物不可能知道或看見的事。`] : []),
    '',
    '【AI 味反制——以下模式嚴禁出現】',
    ...ANTI_AI_RULES.map((r) => `- ${r}`),
    '',
    `敘事語言：繁體中文。溫度設定 ${config.temperature}，請在保持穩定的前提下讓文字有生氣。`,
  ].join('\n');
}

/**
 * 多讓人物開口。人類網文對白段約佔三成，novel-test 百章修仙只有 10–14%：交代、對峙、討價還價都由
 * 敘述者轉述，整章像旁白。寫正文三種情形（第 1 章、後續章、續寫那幾輪）都帶這一條。
 */
const DIALOGUE_RULE =
  '多讓人物開口：能用對白推進的場面就寫成對白——交代、試探、對峙、討價還價都讓人物自己說，不由敘述者轉述；帶對白的段落大約佔三成。';

/**
 * 寫正文的輸出契約：法則 + 篇幅合同 + 執行卡，**執行卡壓在最末**（上游 GD:657 的順序：
 * 模型對末尾的指令最敏感，「這一章要落實哪幾件事」得是它讀到的最後一件事）。
 *
 * 三種情形：
 * - 第 1 章：「黃金第一章」四條（PT:750-754）；
 * - 後續章：「連載更新核心法則」五條（PT:822-827）；
 * - 接著寫 / 續寫那幾輪：只寫新增的那一段（GD:1010-1018），恢復那一輪前面加一句（GD:999-1007）。
 */
function manuscriptContract(facts: PromptFacts): string {
  const words = facts.targetWords;
  const step = facts.step?.kind === 'continuation' ? facts.step : undefined;
  const continuing = !!step || facts.writeMode === 'continue';
  const lines: string[] = [];

  if (continuing) {
    const written = step?.written ?? facts.written;
    const remaining = step ? step.remaining : words && written !== undefined ? Math.max(0, words - written) : undefined;
    if (step?.recovery) {
      lines.push(
        '上一輪續寫達到輸出上限且沒有增加足夠的新正文，已被全部丟棄。',
        '這是本次任務唯一一次無進展恢復機會：請直接推進下一事件、動作或對話，禁止複述已寫末尾。',
        ''
      );
    }
    if (step?.rewound) {
      // 五期補遺 §1.1：上一輪已經收了尾、篇幅不夠，收尾那一段剛被拿掉。往收尾後面接只會
      // 越過它、寫進下一章；所以讓它從收尾之前接著寫，寫足之後重新收尾。
      lines.push(
        '上一輪寫到本章收尾時篇幅還不夠，收尾那一段已經拿掉了：上面「本章已寫正文」停在收尾之前。',
        '請從它的末尾接著寫，把本章細綱裡還沒寫足的事件寫足（場面、動作、對白、人物的反應），最後按本章細綱約定的結束狀態重新收尾。',
        ''
      );
    }
    lines.push(
      '請無縫續寫當前章節正文（已寫的部分見上面「本章已寫正文」）。',
      '',
      '【硬性要求】',
      '- 只輸出新增正文，不要複述已寫內容。',
      '- 從已寫正文末尾自然接下去，保持同一場景邏輯或合理轉場。',
      remaining !== undefined && remaining > 0
        ? `- 大約再寫 ${remaining} 字，不必精確；寫不完就停在自然段落末尾。`
        : '- 寫到本章細綱約定的結束狀態為止；如果一次寫不完，停在自然段落末尾。',
      '- 不要輸出標題、解釋、總結、Markdown、思考過程或「點我繼續」。',
      '- 避免重複已寫正文中的整句、整段、動作鏈和意象。',
      `- ${DIALOGUE_RULE}`,
      '- 不提前寫後續章節，只完成本章細綱允許的內容；寫到本章細綱約定的結束狀態就收住，不越過它去寫之後的事。'
    );
  } else if (isFirstChapter(facts)) {
    lines.push(
      '請開始創作這本小說的第一章（破冰章）。',
      '',
      '【網文「黃金第一章」創作法則】',
      '1. 開場即高能（黃金三秒）：絕不要用長篇大論介紹世界觀。起筆第一句必須直接切入一個動作、一次高壓審問、一場追殺或一個極具落差感的現場。',
      '2. 僅當本章細綱明確要求時才展現主角的金手指；不得為滿足通用套路擅自新增事件。',
      '3. 視角內推進：通過動作、感官、內心活動和符合當前視角的對話推動劇情；不得僅為展示資訊而讓角色公開說出只由其私下感知、尚未轉述的內容。',
      `4. ${DIALOGUE_RULE}`,
      '5. 落實全域要求，避開其中列出的寫作問題。'
    );
  } else {
    lines.push(
      '你正在連載寫作最新章節。',
      '',
      '【網文連載更新核心法則】',
      '1. 向前推進：前情提要、摘要和上一章結尾記錄的是已經發生的事；本章細綱與後續章節預告裡的事都還沒有發生。第一段必須從上一章的最終狀態之後推進本章的新事件；不得引用、摘要、回放或重演上一章結尾中的句子、動作和意象，也不要場景瞬移或突兀切換視角。',
      '2. 動作驅動：用人物的動作和對白推動劇情，不要寫「他們聊了很久」這種概述。',
      `3. 落實本章核心衝突：${words ? `用約 ${words} 字的篇幅，` : ''}踏踏實實地推演完本章目標，避免平淡流水賬。`,
      '4. 章節收束：僅落實本章細綱明確要求的懸念或結束狀態；未明確要求時自然斷章，不得擅自新增高潮、突發變故或後續事件。',
      `5. ${DIALOGUE_RULE}`,
      '6. 落實全域要求，避開其中列出的寫作問題；與上文的語氣、稱謂、時態保持一致。'
    );
  }

  // 篇幅只給一個大概：不給區間、不要它數字數——字數夠不夠由續寫鏈按磁碟數，模型的心思該花在場面上。
  if (words && !continuing) {
    lines.push(
      '',
      '【本章篇幅】',
      `約 ${words} 字，不必精確，也不用數字數：把本章細綱的事件逐個寫足、場面寫開就行。不要為湊字數增加無關內容。`
    );
  }

  const card = executionCard(facts);
  if (card) {
    lines.push('', card);
  }
  lines.push('', boundaryCard(facts));
  lines.push('', continuing ? '現在接著寫。只輸出新增的小說正文。' : '現在開始寫作。只輸出小說正文，不要輸出任何標題、序號、解釋、總結或「以下是」之類的話。');
  return lines.join('\n');
}

/**
 * 本章邊界（五期補遺 §1.2、§1.3）：排在執行卡後面、「現在開始寫作」前面——模型對末尾的指令最敏感。
 *
 * - **本章不出場**：後五章細綱裡才排到的人逐個點名。三期首跑時邊界只有「後續章節預告……絕對不要
 *   在本章提前寫出這些內容」一句原則，第 3 章的結尾照樣把第 4 章才登場的人寫了出來。
 * - **比喻詞上限**：系統提示裡那條規則在第一次呼叫裡重列一遍；續寫那幾輪換成「已經用了幾次、還能用
 *   幾次」——它看不到前面寫了什麼，不告訴它，每一輪都會當成從零開始。
 */
function boundaryCard(facts: PromptFacts): string {
  const lines = ['【本章邊界】'];
  const notYet = facts.notYet ?? [];
  if (notYet.length > 0) {
    lines.push(
      `- 本章不出場：${notYet.map((p) => `${p.name}（第 ${p.no} 章才登場）`).join('、')}。後續章節裡才登場的人，本章不讓他們露面。`
    );
  }
  const words = SIMILE_WORDS.map((w) => `「${w}」`).join('');
  const step = facts.step?.kind === 'continuation' ? facts.step : undefined;
  if (step?.similes !== undefined) {
    const left = Math.max(0, SIMILE_LIMIT - step.similes);
    lines.push(
      `- 比喻詞：已寫部分用了 ${step.similes} 次${words}，續寫部分${left > 0 ? `最多再用 ${left} 次` : '一次也不許再用'}（全章合計不超過 ${SIMILE_LIMIT} 次）。`
    );
  } else {
    lines.push(`- 比喻詞：${words}全章合計不超過 ${SIMILE_LIMIT} 次。`);
  }
  if (step?.dialogue !== undefined && step.dialogue < DIALOGUE_FLOOR) {
    lines.push(
      `- 對白：已寫部分帶對白的段只佔 ${Math.round(step.dialogue * 100)}%，讀起來像旁白。接下來的場面多讓人物開口，對峙、交代、討價還價都寫成對白。`
    );
  }
  if (step?.banned?.length) {
    lines.push(`- 禁用詞：已寫部分用了${step.banned.map((b) => `「${b.term}」${b.count} 次`).join('、')}，續寫部分不許再用，換成這個故事裡的人會說的話。`);
  } else if (facts.banned?.length) {
    lines.push(`- 禁用詞：${facts.banned.map((t) => `「${t}」`).join('')}一個都不用，換成這個故事裡的人會說的話。`);
  }
  return lines.join('\n');
}

/**
 * 本章執行卡：把細綱裡「必須落實的事」在訊息最末原樣重列一遍。移植自 GD:645-656。
 *
 * 只列關鍵事件（與上游單章入口 `chapter-creation-parameters.ts:43-58` 一樣）：看點裡爽點與章末懸念
 * 混在一起，不是一件件到期的動作，本章細綱整份已經在上面。關鍵事件是一條一行的列表：只有一條就接在
 * 冒號後面，多條就按原來的順序縮排列在下面，一條一項地核對。
 */
function executionCard(facts: PromptFacts): string | undefined {
  const events = sectionItems(facts.plot?.keyEvents ?? '');
  const items: [string, string | undefined][] = [
    ['必需事件', events.length > 1 ? `\n${events.map((e) => `  - ${e}`).join('\n')}` : events[0]],
    ['作者本章指導', facts.ask?.trim()],
  ];
  const filled = items.filter(([, v]) => v?.trim());
  if (filled.length === 0) {
    return undefined;
  }
  return [
    '【本章執行卡（細綱原文重列）】',
    '以下各項是本章應落實的動作和收束，不是新增事實。請在輸出前核對各項已通過正文裡的動作或結果落實；後一項動作必須承接正文實際形成的物品持有、人物知情和計劃完成狀態。',
    ...filled.map(([k, v]) => `- ${traditionalLabel(k)}：${v!}`),
  ].join('\n');
}

// ---------------------------------------------------------------- 審稿

/**
 * 審稿的系統提示。移植自 AI-Novel-Writer `consistency_check` 模板的 systemRole、審查原則與檢查維度
 * （PT:917-970）。維度裡「前文」一詞換成這邊的裝配給的是什麼：前幾章的連續性事實與上一章結尾。
 *
 * 多了一段「事實的優先順序」：上游在每一段材料的標題上標「約束而非已發生事實」「非既定歷史」
 * （RV:269-281），這裡把同一件事說在一處——審稿最常見的誤判就是拿計劃當歷史、拿設定當正文。
 */
export const REVIEW_SYSTEM_PROMPT = [
  '你是一位嚴謹的小說審稿編輯，正在審閱一部長篇中文小說剛寫好的一章。依據文字證據檢查連續性、因果、角色狀態與設定衝突，區分客觀問題和主觀偏好。',
  '',
  '【審查原則】',
  '1. 舉證審查：只報告有明確文字證據的問題。每個問題必須逐字引用「待審正文」裡的具體句子。',
  '2. 寧缺毋濫：沒有問題的維度可以省略；如需明確已檢查，可以寫一條「通過」。不要湊數量。',
  '3. 只查一致性不評文筆：不報告風格偏好、文筆建議、創作建議。只報告可驗證的事實矛盾。',
  '4. 客觀可驗證：報出的每個問題必須能被第三方編輯複查確認。',
  '',
  '【檢查維度】',
  '1. 劇情連貫性：本章情節是否與前文（前幾章的連續性事實、上一章結尾）有矛盾？前後文是否自相矛盾？',
  '2. 劇情合理性：因果邏輯是否成立？人物動機是否合理？是否有常識性硬傷？',
  '3. 角色狀態：角色行為、能力、位置、情感是否與角色設定裡的當前狀態一致？',
  '4. 前後章節串聯：伏筆、懸念是否連貫？是否出現未交代前因的突兀情節？是否把後續章節計劃裡的事提前寫掉了？',
  '5. 伏筆完整性：對照「沒收的伏筆」，計劃在本章收的寫到沒有？沒到回收章的有沒有提前揭開？是否有與已知伏筆體系衝突的新增設定？',
  '',
  '【事實的優先順序】',
  '- 待審正文、前幾章的連續性事實、上一章結尾：已經發生的事。',
  '- 角色設定、故事架構、全域要求、本章細綱：作者定下的約束，不是已經發生的事。',
  '- 後續章節計劃：還沒有發生的事，只用來判斷本章有沒有提前寫掉，不是本章應當寫到的內容。',
  '- 沒收的伏筆：作者計劃的埋與收，以及已經埋下、還沒揭開的東西；沒到回收章的不該在本章揭開。',
  '',
  '只出審稿報告，不改寫正文，不輸出修改後的章節。語言：繁體中文。',
].join('\n');

/**
 * 審稿的輸出契約：報告格式 + 目標逐項核對。移植自 `consistency_check` 的 systemSuffix（PT:917-970）
 * 與 `buildChapterGoalReviewPrompt`（`chapter-goal-review.ts:35-59`），兩段原是分開拼的，這裡合成一份。
 *
 * 2026-10-25 起改成轉寫：按「總評」「問題」「目標核對」三個小標題寫，不寫 JSON；引文用「」括出來，轉寫模型照抄成
 * JSON（{@link reviewJsonContract}，generation/review.ts）。各條要求照原來的 JSON 合同搬過來，只把欄位名換成中文說法、
 * 列舉換成中文詞（嚴重 / 建議 / 通過，已完成 / 未完成 / 待核實）。
 *
 * 比上游多說了一句「引文在正文裡找不到的問題會被丟棄」：上游不校驗普通問題的引文，這裡校驗
 * （model/review.ts），先告訴模型規矩，比事後丟掉它編的那幾條划算。
 */
function reviewContract(facts: PromptFacts): string {
  const goals = facts.reviewGoals ?? [];
  const lines: string[] = [];
  if (facts.step?.kind === 'reviewRetry') {
    lines.push(
      facts.step.why === 'truncated'
        ? '上一輪審稿輸出因長度限制而中斷，已被丟棄，不得引用或續接。請從頭完成審稿任務，按下面的格式寫完整；說明寫精煉些。'
        : `上一輪審稿輸出未通過格式校驗（${facts.step.reason ?? '格式不對'}），已被丟棄，不得引用或續接。請按下面的格式重新完成原始審稿任務。`,
      ''
    );
  }
  lines.push(
    '【輸出格式】',
    '按「### 總評」「### 問題」「### 目標核對」三個小標題寫審稿報告，不寫 JSON。',
    `- 總評：一句話總體評價，不超過 ${REVIEW_SUMMARY_MAX} 字。`,
    `- 問題：一條一行、行首寫「- 」，共 1–${REVIEW_ITEMS_MAX} 條。每條先寫檢查維度，括號裡寫嚴重程度，冒號後寫說明；有引文的，最後寫「原文：」，把待審正文裡的那一句用「」括起來。`,
    '- 嚴重程度只寫這三個詞之一：嚴重＝嚴重矛盾，強烈建議修復；建議＝輕微不一致，酌情修復；通過＝該維度通過，無問題。',
    '- 不要求每個檢查維度單列一條，不得為覆蓋類別而湊「通過」，同一問題不得重複。',
    `- 引文必須逐字摘自「待審正文」裡的一句連續原文，不拼接、不改寫、不省略中間的字；每句引文不超過 ${REVIEW_QUOTE_MAX} 字，每條說明不超過 ${REVIEW_DESCRIPTION_MAX} 字。引文只在「通過」時可省略。**引文在正文裡找不到的問題會被丟棄。**`,
    ''
  );
  if (goals.length === 0) {
    lines.push('【本章目標逐項核對】本章細綱沒有可核對的關鍵事件：「### 目標核對」下面只寫「無」。', '');
  } else {
    lines.push(
      '【本章目標逐項核對｜凍結清單】',
      '在「### 目標核對」下逐項核對，不受「問題」條數的限制。凍結清單來自本章細綱的關鍵事件；按清單順序一項一行：先寫清單裡的編號（g1、g2……），括號裡寫結論，冒號後逐個列出目標原文中的每個當章子動作及其判斷，再彙總；最後寫「證據：」，把待審正文裡的原句一句一個「」括起來。不得刪項、改寫目標或自創編號。',
      '結論只寫這三個詞之一：已完成、未完成、待核實。依次判斷：',
      '1. 先按原意區分當章行動與背景/未來約束；僅當目標要求達成約定時，本章達成約定即可，不要求提前執行。背景、梗概裡的意圖、未來計劃不是已發生事實，也不自動變成到期行動。',
      '2. 當章到期行動有明確延期、拒絕或相反結果的正文證據 → 未完成。準備/承諾不能代替要求現在完成的行動；部分完成不等於整專案標完成。',
      '3. 全部到期動作有完成證據，或正文明確支援該項約束 → 已完成。',
      '4. 僅未提及、無法判斷或證據不足 → 待核實，不能以「沒寫到」斷言「沒發生」。例如要求歸還借書，正文只寫走進圖書館：應待核實，不能判未完成。',
      '最後彙總所有子動作：任一未完成 → 未完成；否則任一待核實 → 待核實；僅全部完成 → 已完成。不得用多數已完成掩蓋一個延期或不明子動作。',
      '已完成、未完成都須待審正文的逐字證據；待核實可以寫「證據：無」。不拼接或改寫引文，不引用計劃證明行動；引文存在不證明推斷成立。不檢查字數或強求背景細節。',
      '凍結清單：',
      frozenGoalsList(goals),
      ''
    );
  }
  lines.push(
    '只寫審稿報告本身：不要開場白、解釋或思考過程，不用程式碼圍欄，不寫 JSON。',
    '【格式示例】',
    '### 總評',
    '一句話總體評價',
    '### 問題',
    '- 劇情連貫性（通過）：未發現與前文矛盾',
    '- 劇情合理性（嚴重）：問題描述。原文：「待審正文裡的原句」',
    '- 角色狀態（建議）：輕微不一致說明。原文：「待審正文裡的原句」',
    '### 目標核對',
    goals.length === 0 ? '無' : `- ${goals[0].id}（已完成）：逐個子動作的判斷，再彙總。證據：「待審正文裡的原句」`
  );
  return lines.join('\n');
}

/**
 * 審稿轉寫那一步的 JSON 合同（2026-10-25 起）：把審稿模型按 {@link reviewContract} 寫的報告搬成原來那份
 * `{"summary","items","goalReviews"}`，形狀與 model/review.ts 的 `parseReviewJson` 認的一致。只說每個欄位從哪裡取、
 * 中文詞對到哪個程式碼，不說「審什麼」；引文照抄，之後照舊由 `verifyReview` 拿正文核對。
 */
export function reviewJsonContract(): string {
  return [
    '【審稿報告 JSON 合同】',
    '只輸出 {"summary":"…","items":[…],"goalReviews":[…]}：',
    '- summary：「總評」一節那一句。',
    '- items：「問題」一節，一條一項 {"category":"…","severity":"…","quote":"…","description":"…"}：category 是括號前面的檢查維度（沒寫給 ""）；severity 按括號裡的嚴重、建議、通過依次給 error、warning、pass；description 是冒號後面的說明，不含「原文：」那一段；quote 是「原文：」後面「」裡的那一句，不帶「」，沒寫原文的給 ""。',
    '- goalReviews：「目標核對」一節，一項一項 {"id":"…","status":"…","description":"…","evidence":["…"]}：id 是行首的編號（g1、g2……）；status 按括號裡的已完成、未完成、待核實依次給 completed、unmet、unknown；description 是冒號後面的判斷，不含「證據：」那一段；evidence 是「證據：」後面每一個「」裡的那一句，一句一項，不帶「」。',
    '- 寫「無」或沒有這一節的：文字給 ""，列表給 []。',
    '- 文字一律從原文照抄：不改寫、不總結、不潤色，不補原文沒有的，也不刪原文寫了的；引文（quote、evidence）一個字都不能改。category、severity、id、status 這幾樣按上面的對應關係填。',
    '只輸出一個可由 JSON.parse 讀取的 JSON 物件，不要解釋、Markdown 或程式碼圍欄。',
    '【JSON 形狀】{"summary":"…","items":[{"category":"劇情合理性","severity":"error","quote":"…","description":"…"},{"category":"劇情連貫性","severity":"pass","quote":"","description":"…"}],"goalReviews":[{"id":"g1","status":"completed","description":"…","evidence":["…"]}]}',
  ].join('\n');
}

// ---------------------------------------------------------------- 修稿

/**
 * 修稿的系統提示。移植自 AI-Novel-Writer `refine_from_review` 的 systemRole（PT:1023-1055）
 * 與它末尾的輸出要求。刻意**不帶**寫正文那一套（六條硬性要求、黃金第一章、去 AI 味禁令）：
 * 那些是在教它「寫一章」，修稿要的是「只改這幾處」，帶上只會誘導它順手重寫。
 */
export const REVISE_SYSTEM_PROMPT = [
  '你是一位嚴謹的小說編輯。只依據人工確認的審稿意見進行必要修改，保留作者事實、角色聲音和未被指出的有效內容。',
  '',
  '【格式】',
  '- 所有對話使用中文雙引號，不寫劇本式對白。',
  '- 段落與段落之間必須空一行，不要把多個段落擠成一大塊。',
  '- 只輸出修復後的正文。不要輸出章節標題、開場白、解釋、修改說明或任何 Markdown 符號。',
  '',
  '語言：繁體中文。',
].join('\n');

/**
 * 修稿的輸出契約。修復原則四條逐字移植自 `refine_from_review`（PT:1040-1044），第 2 條補了一句
 * 「清單沒指到的段落原樣保留」——上游的「不要進行審稿報告未提及的潤色」模型常讀成「可以少潤色」。
 * 第 5 條是這邊的：修的時候別跟細綱、角色卡、後幾章打架。
 *
 * 續寫那幾輪（被輸出上限截斷）換成「從已修訂的末尾接著輸出剩下的部分」，原則不變。
 */
function reviseContract(facts: PromptFacts): string {
  if (facts.step?.kind === 'continuation') {
    return [
      '上一輪修稿輸出因長度限制而中斷。請從上面「已修訂正文（末尾）」的最後一句之後，接著輸出修訂後的剩餘部分。',
      '',
      '【硬性要求】',
      '- 只輸出新增的修訂正文，不要複述已經輸出的部分，不要總結、解釋或 Markdown。',
      '- 剩餘部分按同樣的修復原則處理：清單指到的地方改，其餘照「待修稿原文」原樣保留。',
      '- 從已修訂正文末尾自然接下去，一直寫到全章結束。',
      '',
      '現在接著輸出。只輸出正文。',
    ].join('\n');
  }
  return [
    '請根據上面「已確認納入本次修稿的審稿項」，對「待修稿原文」進行**精準修復**。',
    '',
    '【修復原則】',
    '1. 只修復清單中明確指出的問題，一條一條逐項解決。',
    '2. 不要進行清單未提及的潤色或改寫：清單沒有指到的段落原樣保留，一字不改。',
    '3. 保持原文的風格、節奏和字數體量。',
    '4. 對每處修改保持最小變化原則——改得越少越好，只解決問題本身。',
    '5. 修改不得與本章細綱、角色設定和前文事實衝突，也不要寫進後續章節的事件。',
    '',
    '請直接輸出修復後的全文章節正文。強制要求純文字，嚴禁劇本式格式，【嚴禁】任何開場白、解釋文字。段落與段落之間必須保留一個空行作為分隔。',
  ].join('\n');
}

// ---------------------------------------------------------------- 規模與題材

/** 這本書的規模：一句話彈窗給的優先，其次是 `config.md`。兩者都沒有就是 undefined。 */
function scaleOf(facts: PromptFacts): { total?: number; words?: number } {
  return {
    total: facts.setup?.totalChapters ?? facts.book?.totalChapters,
    words: facts.setup?.wordsPerChapter ?? facts.book?.wordsPerChapter,
  };
}

function scaleLines(facts: PromptFacts, lead: string): string[] {
  const { total, words } = scaleOf(facts);
  if (!total && !words) {
    return [];
  }
  return [
    lead,
    ...(total ? [`- 計劃總章數：${total} 章`] : []),
    ...(words ? [`- 每章字數：${words} 字`] : []),
    ...(total && words ? [`- 全書總字數約：${total} × ${words} = ${total * words} 字`] : []),
  ];
}

function genreOf(facts: PromptFacts): string {
  return facts.book?.genre?.trim() || '（配置裡沒寫型別）';
}

function span(from: number, to: number): string {
  return from === to ? `第 ${from} 章` : `第 ${from}–${to} 章`;
}

// ---------------------------------------------------------------- 輸出契約

/**
 * 輸出契約：附在 user 訊息末尾的那段「現在請你產出什麼」。
 *
 * 結構化產物（2026-10-25 起）一律按格式寫自然語言，不要 JSON：轉寫那一檔的模型照抄成程式要的 JSON
 * （features/transcribe.ts；細綱見 {@link blueprintFormat}）。作者實測要模型直接出 JSON 寫出來的東西明顯更差，還容易
 * 因為少一個引號整批作廢。解析側照舊能降級——模型不聽話是常態，而解析失敗等於這一次生成白花錢。
 */
export function buildOutputContract(action: CreationAction, facts: PromptFacts = {}): string {
  if (outputKindOf(action) === 'text') {
    return '請直接回答上面的問題。若我要的是建議或分析，就給建議或分析，不必寫成小說正文。';
  }
  if (outputKindOf(action) === 'report') {
    return reviewContract(facts);
  }

  switch (action.stage) {
    case 'setting': {
      // 落定設定（完善設定二期）：目標就是設定目錄，但不是排設定清單——按能力認，排在 `doc === 'lore'` 之前。
      if (action.capability === 'settle') {
        return loreSettleContract();
      }
      // 單條設定（展開）有自己的合同，不落到「不是架構五件就當配置」那一支（context/loreExpandPrompt.ts）。
      if (facts.target?.kind === 'lore') {
        return loreExpandContract();
      }
      const doc = facts.target?.kind === 'setting' ? facts.target.doc : 'config';
      if (doc === 'config') {
        return configContract(facts);
      }
      if (doc === 'characters') {
        return facts.step?.kind === 'rosterDetails' ? rosterDetailContract(facts.step) : rosterManifestContract(facts);
      }
      if (doc === 'lore') {
        return facts.step?.kind === 'loreListDetails' ? loreDetailContract(facts.step) : loreManifestContract(facts);
      }
      return doc === 'premise' ? premiseContract(facts) : worldContract(facts);
    }
    case 'outline':
      return outlineContract(facts);
    case 'plot':
      return blueprintContract(facts);
    case 'manuscript':
      return facts.writeMode === 'revise' ? reviseContract(facts) : manuscriptContract(facts);
  }
}

/**
 * 小說配置。移植自 `generate_global_config`（PT:257-302）與
 * `buildNovelConfigJSONContract`（AC:612-632）。
 *
 * 「全域要求」會被後面每一章讀一遍——逐章大綱寫在這裡是最貴的越界，所以格式裡
 * 說了兩遍（任務裡一遍、格式裡一遍），生成鏈還會按 4–8 條 600 字的規矩驗一次。
 *
 * 2026-10-25 起改成轉寫：按小標題寫自然語言（{@link configFormat}），JSON 由轉寫模型照抄（{@link configJsonContract}）。
 * 小標題裡那八節與 `config.md` 同名：轉寫不成時解析那一層按小節讀，讀得出這幾節。
 */
function configContract(facts: PromptFacts): string {
  const authorHasConfig = !!facts.setup && !!facts.book && Object.values(facts.book.sections).some((v) => v.trim());
  // 從已寫正文整理時（拆書 A）任務換一套：賣點、型別、文風都照正文歸納，不按市場重新包裝。格式不變。
  const task = facts.derive
    ? [
        '基於上面「已寫正文」（各章節選與逐章的梗概、看點），歸納這部小說連貫、具體、能接著往下寫的全域設定。',
        '',
        ...deriveLead(facts),
        ...scaleLines(facts, '小說規模（重要！後續章節按此推進）：'),
        '',
        '【核心任務要求】',
        '1. 這是**提煉**，不是複述劇情：站在編輯的位置讀完這本書，說清它憑什麼讓讀者追下去。型別、受眾、賣點與金手指按正文實際的樣子歸納，不另編正文裡沒有的賣點；但正文裡反覆兌現的爽點要點名提煉出來。',
        '2. 「一句話賣點」與「核心賣點」是這一份配置的重點：一句話賣點抓住全書最抓人的反差與看點；核心賣點從正文裡（逐章「看點」是主要依據）找出讀者最爽、最想往下看的那幾樣（反覆出現的爽點套路、標誌性高光場面、主角人設的反差萌點、貫穿全書的懸念），每條落到正文裡的具體例子。',
        '3. 「核心梗概」按要求寫開局困境、核心目標、終極危機與爽點起伏，不要按章流水賬複述情節——逐段經過是情節大綱的事。',
        '4. 「主角檔案」「世界觀要點」只寫正文裡立得住的東西；世界觀要點寫這套世界怎樣製造衝突與爽點，不寫成設定百科。',
        '5. 職責分離：「全域要求」只寫跨章節長期有效的執行規則（從正文裡看得出的寫法、爽點兌現方式與禁忌），**不要逐章列大綱**、分配章節區間或複述核心梗概。',
        '6. 「文風」按正文實際的寫法歸納；故事結構與敘事視角按正文判斷。',
      ]
    : [
        '基於作者提供的一句話點子或初步構想（見上面「我的腦洞」或「我的要求」），擴充套件並補全這部小說連貫、具體且可持續推進的全域設定。',
        '',
        ...scaleLines(facts, '小說規模（重要！請嚴格根據此引數設計節奏）：'),
        '',
        '【核心任務要求】',
        '1. 深度挖掘商業價值：提取強烈的「爽點」「情緒痛點」，構建極具張力的起承轉合。',
        '2. 專業化設定：應用「角色圖譜」和「三維世界觀」理念，杜絕假大空，所有設定必須為推動情節和產生直接衝突服務。',
        '3. 契合市場：如果作者未指定基礎型別，請推斷一個最契合的爆火型別。',
        '4. 職責分離：「全域要求」只寫跨章節長期有效的執行規則，**不要逐章列大綱**、分配章節區間或複述核心梗概。',
        '5. 智慧推薦：根據型別和題材推薦最合適的故事結構和敘事視角。',
      ];
  return [
    ...task,
    ...(authorHasConfig
      ? [
          '',
          '【作者已有配置】',
          '上面「故事架構」裡的小說配置是作者的權威輸入：長文字只能在保留原文的基礎上補充，型別、受眾、結構與視角選擇不得改寫。',
        ]
      : []),
    '',
    configFormat(facts),
  ].join('\n');
}

/** 故事結構、敘事視角寫哪幾個詞（轉寫時按這個順序對到 `PLOT_STRUCTURES` / `NARRATIVE_POVS`）。 */
const CONFIG_STRUCTURE_WORDS = ['三幕結構', '英雄之旅', '節拍表', '起承轉合', '多線敘事', '自由結構'];
const CONFIG_POV_WORDS = ['第三人稱有限視角', '第一人稱', '第三人稱全知視角', '多視角輪換'];

/**
 * 小說配置的輸出格式（2026-10-25 起改成轉寫）：一節一個「## 小標題」，各節寫什麼照原來的 JSON 合同搬過來，只把欄位名
 * 換成小標題、英文列舉換成中文詞。規模是作者定的就不寫（原來合同裡「可以省略，寫了必須等於作者的」）。
 */
function configFormat(facts: PromptFacts): string {
  const { total, words } = scaleOf(facts);
  const scale =
    total && words
      ? []
      : [
          '## 規模',
          `計劃總章數與每章字數，如「100 章，每章 3000 字」；拿不準寫「無」${total ? `（總章數是作者定的 ${total} 章，照寫）` : ''}${words ? `（每章字數是作者定的 ${words} 字，照寫）` : ''}。`,
        ];
  return [
    '【小說配置格式】',
    '按下面的小標題逐節寫，一節以「## 小標題」開頭，小標題一字不改：',
    '## 型別',
    '主型別，從「玄幻、仙俠、都市、科幻、歷史、懸疑、遊戲、軍事、奇幻、武俠、現實、其他」裡挑一個。',
    '## 受眾',
    '從「男頻、女頻、通用、短篇」裡挑一個。',
    '## 細分型別',
    '細分子型別及核心標籤（如：末日廢土、苟道流、權謀、大女主逆襲）。',
    '## 故事結構',
    `從「${CONFIG_STRUCTURE_WORDS.join('、')}」裡挑一個，根據型別推薦最合適的；只寫這幾個字。`,
    '## 敘事視角',
    `從「${CONFIG_POV_WORDS.join('、')}」裡挑一個，根據型別推薦最合適的；只寫這幾個字。`,
    '## 一句話賣點',
    `30–50 字：主角的反差身份 + 憑什麼爽 + 最大的懸念或目標，讀者看完就想點開${facts.derive ? '' : '；作者已經寫了一句話時寫「無」'}。`,
    '## 核心梗概',
    '150–400 字，含：主角的致命危機/開局困境、必須完成的核心目標、終極大危機、主要爽點起伏；寫骨架，不按章複述情節。',
    '## 核心賣點',
    '3–5 條，一條一行、行首寫「- 」：讀者追讀的理由——核心爽點及其反覆兌現的方式、標誌性高光場面、主角人設反差、貫穿全書的懸念；每條寫具體，不寫「節奏緊湊」「爽點密集」這類空話。',
    '## 世界觀要點',
    '獨特的背景設定（物理維度、權力斷層、核心資源爭奪機制）。',
    '## 金手指',
    '核心賣點與金手指體系（獲取方式、具體功能、進階成長路徑、副作用/限制）。',
    '## 主角檔案',
    '主角人設檔案（極具反差的性格弱點、表面偽裝標籤、核心驅動力：物質目標+深層靈魂渴望）。',
    '## 全域要求',
    `${GUIDANCE_MIN_RULES}–${GUIDANCE_MAX_RULES} 條簡短、穩定、可執行的全域寫作規則，一條一行，總計不超過 ${GUIDANCE_MAX_CHARS} 字；禁止逐章列大綱、分配章節區間或複述核心梗概。`,
    '## 文風',
    '文風配置（不少於 100 字，涵蓋：敘述節奏快慢與場景切換頻率、描寫密度偏好、對話風格與口語化程度、用詞偏好古風/現代/專業術語、情感基調熱血/冷峻/詼諧/沉重、標誌性修辭手法與過渡技巧。請根據型別和受眾推薦最匹配的寫作風格）。',
    '## 參考作品',
    '可以寫「無」。',
    ...scale,
    '',
    `- 型別、受眾、細分型別、故事結構、敘事視角、核心梗概、核心賣點、世界觀要點、金手指、主角檔案、全域要求、文風這幾節必須寫，不能寫「無」${facts.derive ? '；從已寫正文整理時沒有作者寫的一句話，「一句話賣點」也必須寫' : ''}。`,
    `- 「全域要求」必須是 ${GUIDANCE_MIN_RULES}–${GUIDANCE_MAX_RULES} 條跨章節長期有效的簡短規則，總計不得超過 ${GUIDANCE_MAX_CHARS} 字；禁止逐章列大綱或分配章節區間。`,
    '- 故事結構、敘事視角只寫上面列出的詞之一，不寫近義詞、不加說明。',
    '- 只寫配置本身：不要開場白和解釋，不用程式碼圍欄，不寫 JSON。',
  ].join('\n');
}

/**
 * 小說配置轉寫那一步的 JSON 合同（2026-10-25 起改成轉寫）：形狀就是 features/novelConfig.ts 的 `decodeNovelConfig` 認的那一份
 * （上游的英文鍵）。只說每個鍵從原文哪一節取、中文詞怎麼對到英文列舉。
 */
export function configJsonContract(): string {
  const pair = (words: readonly string[], codes: readonly string[]) => words.map((w, i) => `${w} → ${codes[i]}`).join('、');
  return [
    '【小說配置 JSON 合同】',
    '只輸出一個 JSON 物件，每個鍵取原文裡同名的那一節（整節照抄，保留換行與行首的「- 」）：',
    '- genre：「型別」；targetAudience：「受眾」；subGenre：「細分型別」；',
    '- logline：「一句話賣點」；coreOutline：「核心梗概」；sellingPoints：「核心賣點」；worldSetting：「世界觀要點」；goldenFinger：「金手指」；protagonistProfile：「主角檔案」；globalGuidance：「全域要求」；writingStyle：「文風」；referenceWorks：「參考作品」；',
    `- plotStructure：「故事結構」，按 ${pair(CONFIG_STRUCTURE_WORDS, ['three_act', 'heros_journey', 'save_the_cat', 'kishotenketsu', 'multi_thread', 'freeform'])} 給英文值；對不上的不給這個鍵；`,
    `- narrativePOV：「敘事視角」，按 ${pair(CONFIG_POV_WORDS, ['third_limited', 'first_person', 'third_omniscient', 'multi_pov'])} 給英文值；對不上的不給這個鍵；`,
    '- totalChapters、wordsPerChapter：「規模」一節裡的總章數與每章字數（數字）；沒有這一節或寫「無」就不給；',
    '- 每個值都是字串（數字除外），不寫成陣列或物件；寫「無」或沒有這一節的給 ""。',
    '- 文字一律從原文照抄：不改寫、不總結、不潤色，不補原文沒有的，也不刪原文寫了的；plotStructure、narrativePOV、totalChapters、wordsPerChapter 按上面的對應關係填。',
    '只輸出一個可由 JSON.parse 讀取的 JSON 物件，不要解釋、Markdown 或程式碼圍欄。',
    '【JSON 形狀】{"genre":"…","targetAudience":"…","subGenre":"…","plotStructure":"three_act","narrativePOV":"third_limited","logline":"…","coreOutline":"…","sellingPoints":"…","worldSetting":"…","goldenFinger":"…","protagonistProfile":"…","globalGuidance":"…","writingStyle":"…","referenceWorks":""}',
  ].join('\n');
}

/** 故事前提。移植自 `premise`（PT:309-378）。 */
function premiseContract(facts: PromptFacts): string {
  const { total, words } = scaleOf(facts);
  const keys = SETTING_SECTION_KEYS.premise;
  return [
    `請提煉本書的「${SETTING_DOC_HEADING.premise}」（Story Premise）。這是一本【${genreOf(facts)}】小說，依據是${facts.derive ? '上面的「已寫正文」，以及' : ''}上面「故事架構」裡的小說配置：核心梗概、世界觀要點、金手指、主角檔案、全域要求與參考作品。`,
    ...(total ? [`預期篇幅：約 ${total} 章${words ? `（每章 ${words} 字）` : ''}。`] : []),
    '',
    ...deriveLead(facts),
    '【生成任務】',
    '請生成一份 400–600 字的結構化故事前提，嚴格按以下四個小節輸出，小節名一字不改。小說配置裡已經寫過的（金手指機制、主角檔案）不要照抄，這裡要回答的是「這個故事憑什麼好看」：',
    '',
    `## ${keys[0]}`,
    '用 30–50 字寫出全書最抓人的一句：主角的反差身份 + 被逼入的處境 + 憑什麼翻盤/爽 + 最大的懸念或代價。要讓人讀完就想點開，不要寫成「當……必須……否則……」的套話。',
    '',
    `## ${keys[1]}`,
    '主角的初始困境（壓得越狠，後面越爽）→ 打破平衡的觸發事件 → 核心主線目標 → 主要阻礙勢力與他們卡住主角的方式。寫因果與對抗，不按章複述情節。（約 120 字）',
    '',
    `## ${keys[2]}`,
    '這本書的爽點怎麼一次次兌現：典型的「壓抑鋪墊 → 金手指/主角本事發揮 → 打臉、收穫或反轉」迴路長什麼樣（舉一個具體的例子）；爽點有哪幾種（打臉、逆襲、撿漏、收穫、扮豬吃虎、揭秘……挑這本書真有的）；隨著故事推進爽點怎樣升級、對手與賭注怎樣變大；金手指的限制/代價怎樣製造新的壓抑，讓下一次爆發更爽。（約 150 字）',
    '',
    `## ${keys[3]}`,
    '顯性衝突線（當前最大威脅、讀者眼前最想看到的那場對決）+ 隱藏主線（終極懸念、深層真相、會讓讀者回頭重看的反轉），寫清它們分別吊著讀者想知道什麼。（約 120 字）',
    '',
    '【要求】',
    '1. 爽點迴圈必須具體到這本書：寫得出「誰被誰看不起、主角用什麼手段、怎樣讓對方/圍觀者震驚」，不要寫「爽點密集」「節奏緊湊」這類空話。',
    '2. 必須體現主角基於設定的核心慾望或執念，以及它怎樣讓主角主動出手。',
    '3. 衝突鏈必須包含顯性敵人與深層危機兩個層次。',
    '4. 落實全域要求，避開其中列出的寫作問題；參考作品只借調性與節奏。',
    '5. 只輸出這四個小節，不要新增額外解釋。',
  ].join('\n');
}

/**
 * 角色圖譜第一步：身份清單。移植自 `character_dynamics`（PT:380-449）與
 * `prompt-language.ts` 的 `manifestSystem` / `manifestTask`。
 *
 * **補上上游的缺口**：上游內建模板的這段任務（主角的明暗兩面、「至少一位盟友 /
 * 一位對手」、避免臉譜化）寫在 `content` 裡，而兩段式命令只發 `taskGuidance`
 * （`renderPromptTaskGuidance`，AC:1347-1357），內建模板沒有這個欄位——
 * 這些設計原則從來沒進過 prompt。
 */
function rosterManifestContract(facts: PromptFacts): string {
  const { total } = scaleOf(facts);
  const genre = genreOf(facts);
  return [
    `請基於故事前提為本書塑造一個極具戲劇張力的核心角色圖譜。${total ? `預期篇幅約 ${total} 章。` : ''}`,
    '',
    '【生成任務】',
    `圍繞主角，根據小說篇幅設計合理數量的核心角色（短篇 3–4 人，中長篇 4–6 人，最多 ${ROSTER_MAX} 人）。角色切忌臉譜化。先在腦中完成以下角色設計，再以結構化名單輸出：`,
    '',
    '1. 【第一核心：主角】',
    '- 表面追求與終極渴望（根據檔案補全性格的明暗兩面）',
    '- 標誌性外貌特徵（衣著、氣質、獨特標誌等）',
    '- 金手指使用風格（基於金手指的具體機制，設計獨特的使用習慣或戰鬥/升級策略）',
    '- 靈魂軟肋與蛻變預期（角色弧光起始點 → 終點）',
    '',
    '2. 【核心角色陣營】',
    '為每位角色想清：姓名/代號、身份背景、標誌性外貌特徵、與主角的關係張力、暗藏秘密。',
    '角色設計原則（非固定模板，根據故事需要靈活配置）：',
    '- 至少 1 位與主角有深度羈絆的盟友/夥伴（互補而非附庸）',
    '- 至少 1 位與主角理念對立的競爭者/對手（有自己的正當動機）',
    '- 可選：1 位隱藏變數/灰色角色（立場不定，可能帶來反轉）',
    '- 可選：根據故事需要增加導師、陰謀家、勢力代言人等',
    '- 性別按人物與故事需要來定，別不假思索一律寫成男性（門派、軍營這類本就清一色的設定除外）',
    '',
    '3. 【核心矛盾交織網】',
    '想清所有角色如何因為世界觀下的生存壓力、資源爭奪或信念衝突產生不可避免的碰撞，寫進每個人的「敘事職責」與「關係」。',
    '',
    '【要求】',
    '1. 故事前提和主角檔案中的作者明確設定屬於權威事實，必須逐項保留，不得弱化、反轉或用題材慣例替換。',
    '2. 主角必須嚴格符合主角檔案基調，不可偏離。',
    `3. 所有角色的設計必須貼合「${genre}」型別的讀者期待。`,
    '4. 預設避免聖母、降智反派或純工具人（除非作者明確要求）。',
    '5. 上面「相關角色設定」裡已經有角色卡的人照樣列進清單，名字一字不改，他們卡上寫的是權威事實。',
    '',
    '這一步只規劃角色身份、敘事職責和角色間關係，不生成角色詳情。',
    '',
    '【身份清單格式】',
    `共 ${ROSTER_MIN}–${ROSTER_MAX} 人，一人一份，以「## 名字」開頭（名字不得重複），下面四行：`,
    '- 定位：主角、反派、配角、次要四選一，至少一個主角；',
    '- 性別：男或女（非人之類照實寫）；',
    '- 敘事職責：這個人在故事裡承擔什麼敘事職責；',
    '- 關係：與本清單裡其他人的關係，一條一行，寫成「與〈名字〉：……」，名字照抄清單裡那個人的，只寫本清單裡的人；沒有就寫「無」。',
    '只寫清單本身：不要開場白和解釋，不用程式碼圍欄，不寫 JSON。',
    '【格式示例】',
    '## 〈名字〉',
    '- 定位：主角',
    '- 性別：男',
    '- 敘事職責：……',
    '- 關係：',
    '  - 與〈名字〉：……',
  ].join('\n');
}

/**
 * 身份清單轉寫那一步的 JSON 合同（2026-10-25 起改成轉寫）：形狀是 features/roster.ts 的 `decodeManifest` 認的那一份。
 * 編號（slotId）程式要、寫清單的模型不必管：轉寫時拿名字當編號，關係指向對方的名字。
 */
export function rosterManifestJsonContract(): string {
  return [
    '【身份清單 JSON 合同】',
    '只輸出 {"slots":[...]}，原文裡一個「## 名字」是一項：',
    '- name：「## 」那一行的名字（不帶括號裡的說明）；slotId：與 name 相同；',
    '- role：「定位」，按主角、反派、配角、次要依次給 protagonist、antagonist、supporting、minor；gender：「性別」；narrativeDuty：「敘事職責」；',
    '- relations：「關係」一節，一條一項 {"targetSlotId":"對方的名字","relation":"……"}：targetSlotId 給對方在清單裡「## 」那一行的名字，relation 是冒號後面那一段；',
    '- 寫「無」或沒有這一節的：文字給 ""，列表給 []。',
    '- 文字一律從原文照抄：不改寫、不總結、不潤色，不補原文沒有的，也不刪原文寫了的；slotId、targetSlotId、role、gender 按上面的對應關係填。',
    '只輸出一個可由 JSON.parse 讀取的 JSON 物件，不要解釋、Markdown 或程式碼圍欄。',
    '【JSON 形狀】{"slots":[{"slotId":"…","name":"…","role":"protagonist","gender":"男","narrativeDuty":"…","relations":[{"targetSlotId":"…","relation":"…"}]}]}',
  ].join('\n');
}

/**
 * 角色圖譜第二步：按凍結清單每批補幾個人的詳情。移植自 `prompt-language.ts` 的
 * `detailSystem` / `detailContract` / `detailTask`，欄位直接對到角色卡的六節，
 * 每節都有字數上限（第 15 條：角色卡不能無限膨脹）。2026-10-25 起按小標題寫（{@link rosterDetailFormat}），
 * JSON 由轉寫模型照抄（{@link rosterDetailJsonContract}）。
 */
function rosterDetailContract(step: Extract<ChainStep, { kind: 'rosterDetails' }>): string {
  return [
    '【凍結身份與關係清單】',
    step.manifest,
    '',
    '【本批要寫詳情的人】',
    step.names.join('、'),
    ...(step.done ? ['', '【前幾批已經寫好詳情的人】（保持一致）', step.done] : []),
    '',
    '這一步只為清單裡指定的人補全緊湊資料，不規劃或改寫角色身份和關係。故事前提和主角檔案中的作者明確設定是權威事實；必須寫入相關角色詳情，不得遺漏、弱化、反轉或用題材慣例替換。',
    '',
    rosterDetailFormat(),
  ].join('\n');
}

/** 角色詳情的輸出格式（2026-10-25 起改成轉寫）：各節寫什麼照原來的 JSON 合同搬過來。 */
function rosterDetailFormat(): string {
  const L = CHARACTER_DETAIL_LIMITS;
  return [
    '【角色詳情格式】',
    '本批每人一份，以「## 名字」開頭（名字與凍結清單一字不差），下面依次是這七個「### 小標題」，一個都不能少，哪一節沒有內容就寫「無」：身份、外貌、性格、語言習慣、當前狀態、暗設、專屬稱呼。',
    `- 身份：出身背景、能力、核心動機與弧光（起點 → 終點），不超過 ${L.身份} 字；`,
    `- 外貌、性格、語言習慣：各不超過 ${L.外貌} 字，寫得出這個人與別人的不同；`,
    `- 當前狀態：第一章開始前此人在哪、處境如何、身上有什麼關鍵物品，不超過 ${L.当前状态} 字；`,
    `- 暗設：此人讀者還不知道的事（身世、秘密、真實目的），寫真相本身，不寫什麼時候揭開；規劃時用、寫正文時不帶。不超過 ${L.暗设} 字；沒有就寫「無」。`,
    '- 專屬稱呼：這個人的字號、外號、小名，用頓號隔開；不收「他」「師兄」「那個少年」這類泛稱；沒有就寫「無」。',
    '名字與定位以凍結清單為準，不改人。不寫人物關係——關係由凍結清單唯一生成。',
    '只寫這幾個人的資料：不要開場白和解釋，不用程式碼圍欄，不寫 JSON。',
    '【格式示例】',
    '## 〈名字〉',
    '### 身份',
    '……',
    '### 外貌',
    '……',
    '### 性格',
    '……',
    '### 語言習慣',
    '……',
    '### 當前狀態',
    '……',
    '### 暗設',
    '無',
    '### 專屬稱呼',
    '無',
  ].join('\n');
}

/**
 * 角色詳情轉寫那一步的 JSON 合同（2026-10-25 起改成轉寫）：形狀是 features/roster.ts 的 `decodeDetails` 認的那一份。
 * 不要 slotId：解碼按名字認人（凍結清單里名字唯一）。
 */
export function rosterDetailJsonContract(): string {
  return [
    '【角色詳情 JSON 合同】',
    '只輸出 {"entries":[...]}，原文裡一個「## 名字」是一項：',
    '- name：「## 」那一行的名字（不帶括號裡的說明）；',
    '- 身份、外貌、性格、語言習慣、當前狀態、暗設：原文裡同名的那一節，整節照抄（保留換行）；',
    '- aliases：「專屬稱呼」一節裡的稱呼，一個一項；',
    '- 寫「無」或沒有這一節的：文字給 ""，列表給 []。',
    '- 文字一律從原文照抄：不改寫、不總結、不潤色，不補原文沒有的，也不刪原文寫了的。',
    '只輸出一個可由 JSON.parse 讀取的 JSON 物件，不要解釋、Markdown 或程式碼圍欄。',
    '【JSON 形狀】{"entries":[{"name":"…","身份":"…","外貌":"…","性格":"…","语言习惯":"…","当前状态":"…","暗设":"","aliases":[]}]}',
  ].join('\n');
}

/** 世界觀。移植自 `world_building`（PT:451-507），三個維度對到 `world.md` 的三節。 */
function worldContract(facts: PromptFacts): string {
  const genre = genreOf(facts);
  const [rules, classes, crisis] = SETTING_SECTION_KEYS.world;
  return [
    `請將基礎設定轉化為能直接引發衝突的「劇情遊樂場」，輸出這部小說的「${SETTING_DOC_HEADING.world}」。`,
    '',
    ...deriveLead(facts),
    '【生成任務】',
    `請基於${facts.derive ? '「已寫正文」與' : ''}小說配置裡的世界觀要點，根據「${genre}」型別的特點，構建以下三個維度的世界觀設定。每個設定都必須「自帶衝突點」，能直接驅動情節、製造看點。用 Markdown 小節書寫，小節名一字不改；每節下面直接寫成段的設定，**不要把下面的提示抄成問題或列表標題**：`,
    '',
    `## ${rules}`,
    '寫清：本世界運轉的核心規則（根據型別可以是修煉體系、科技等級、社會制度、超自然法則、遊戲機制等）；有境界、等級或實力檔位的，寫明每一檔大致做得到、做不到什麼（例如能布幾階的陣、能以一敵幾），後面寫正文以此為上限；規則裡的漏洞與主角的金手指怎樣咬合，讓主角佔據別人沒有的非對稱優勢；這套規則怎樣天然製造「主角被低估 → 一出手全場震驚」的場面。',
    '',
    `## ${classes}`,
    '寫清：勢力/階層/陣營之間的對立——哪些是不可調和的死敵，哪些只是爭奪資源的對手、會互相利用也會臨時聯手；最稀缺的核心資源及其分配方式；主角處在哪一層、要從誰手裡搶、搶到之後能換來什麼——每一次爭奪都是一個可以寫成爽點的舞臺。',
    '',
    `## ${crisis}`,
    '寫清：世界背後的終極災變或最大謎團；流傳的禁忌、歷史謊言或被掩蓋的真相怎樣與主角的身世和命運交匯；這些謎團分幾層揭開，每一層揭開時會顛覆讀者此前的什麼認知。',
    '',
    '【要求】',
    `1. 所有設定必須圍繞「${genre}」題材的核心看點，不要寫無法融入正文的廢話設定，也不要寫成設定百科或劇情複述。`,
    '2. 金手指與世界規則的互動必須具體、可操作，避免泛泛而談。',
    '3. 嚴格遵循故事前提、主角檔案中的作者明確設定和全域要求；無需機械複述與世界無關的角色事實，但不得製造相反設定。',
    '4. 只輸出這三個小節，不要解釋你改了什麼。',
  ].join('\n');
}

/**
 * 設定清單第一步：分類目錄樹 + 清單（設定名錄，作者定案：進架構主鏈、排在世界觀之後；分類每本書自定）。
 *
 * 兩條最要緊的邊界寫進了任務裡：**世界觀講整體怎麼運轉，條目講某一個東西**——不然模型會把世界觀三節
 * 切成三條「條目」再抄一遍；**人不是設定**——人在角色圖譜裡，名錄裡混進人名，名錄與出場人物就是兩份
 * 真相。本書已有的分類表與條目由 `lore` 層帶進來（「相關世界觀設定」那一節），這裡要求照用、照抄名字。
 *
 * 2026-10-25 起改成轉寫：按小標題寫（「## 分類」「## 清單」），JSON 由轉寫模型照抄（{@link loreListJsonContract}）。
 */
function loreManifestContract(facts: PromptFacts): string {
  const genre = genreOf(facts);
  return [
    `請把上面「故事架構」裡世界觀（以及故事前提、小說配置）點到的東西排成這本【${genre}】小說的設定清單：地點、勢力、能力體系、關鍵物品、制度與概念，一樣一條。`,
    '',
    '【生成任務】',
    `1. 分類：按「${genre}」題材給這本書排一棵分類目錄樹——3–8 個一級分類（如仙俠書可以是「宗門 / 地域 / 功法 / 丹藥法寶 / 境界」，科幻書可以是「星球 / 艦船 / 組織 / 科技」），需要時帶二級，寫成「宗門/正道」。每一段都是能當資料夾名的短詞。`,
    '   上面「相關世界觀設定」裡列了本書已有的設定分類時：照用，只補缺的那幾個，不要換個說法另起一個。',
    `2. 清單：${LORE_LIST_MIN}–${LORE_LIST_MAX} 條，覆蓋世界觀與故事前提裡點到的地點、勢力、能力體系、關鍵物品、制度與概念，挑後面的章節一定會反覆用到的。`,
    '   - **世界觀講整體怎麼運轉，條目講某一個東西**：一條隻立一樣具體的東西，不要把世界觀整段切開重抄，也不要列「世界觀總覽」「力量體系概述」這種大而全的條目。',
    '   - **人不是設定**：人物都在角色圖譜裡，人名、外號、稱謂一律不列（門派、家族這類勢力可以列）。',
    '   - 上面「相關世界觀設定」裡已經有的條目，名字一字不改地照抄，不要換個叫法再列一條。',
    '',
    '【每一條寫清】',
    `- 名字：這樣東西在正文裡的叫法（≤ ${LORE_LINE_LIMITS.name} 字），不得重複；`,
    '- 分類：必須是上面排的分類裡的一項（可以是二級，如「宗門/正道」）；',
    '- 別稱：正文裡可能出現的別稱、簡稱（不含名字本身，不含人名），沒有就不寫；',
    `- 一句話：說清它是什麼（≤ ${LORE_ENTRY_LIMITS.brief} 字）。`,
    '',
    '這一步只排分類與清單，不寫條目正文。',
    '',
    '【設定清單格式】',
    '先寫「## 分類」，一行一個分類；再寫「## 清單」，一條一行，寫成「- 名字（分類；別稱：別稱、簡稱）：一句話」，沒有別稱就寫「- 名字（分類）：一句話」。',
    '只寫分類與清單：不要開場白和解釋，不用程式碼圍欄，不寫 JSON。',
    '【格式示例】',
    '## 分類',
    '- 宗門',
    '- 宗門/正道',
    '## 清單',
    '- 〈名字〉（〈分類〉；別稱：〈別稱〉、〈簡稱〉）：〈一句話〉',
    '- 〈名字〉（〈分類〉）：〈一句話〉',
  ].join('\n');
}

/** 設定清單轉寫那一步的 JSON 合同（2026-10-25 起改成轉寫）：形狀是 features/loreList.ts 的 `decodeLoreManifest` 認的那一份。 */
export function loreListJsonContract(): string {
  return [
    '【設定清單 JSON 合同】',
    '只輸出 {"categories":[...],"entries":[...]}：',
    '- categories：「分類」一節，一個分類一項（二級照寫成「宗門/正道」）；',
    '- entries：「清單」一節，一條一項 {"title":"…","category":"…","keywords":["…"],"brief":"…"}：title 是名字；category 是括號裡的分類；keywords 是「別稱：」後面那幾個，一個一項，沒寫給 []；brief 是冒號後面那一句。',
    '- 寫「無」或沒有這一節的：文字給 ""，列表給 []。',
    '- 文字一律從原文照抄：不改寫、不總結、不潤色，不補原文沒有的，也不刪原文寫了的。',
    '只輸出一個可由 JSON.parse 讀取的 JSON 物件，不要解釋、Markdown 或程式碼圍欄。',
    '【JSON 形狀】{"categories":["…"],"entries":[{"title":"…","category":"…","keywords":[],"brief":"…"}]}',
  ].join('\n');
}

/**
 * 設定清單第二步：按凍結的清單每批補幾條的正文。2026-10-25 起按小標題寫（{@link loreDetailFormat}），JSON 由轉寫模型照抄
 * （{@link loreDetailJsonContract}）。
 */
function loreDetailContract(step: Extract<ChainStep, { kind: 'loreListDetails' }>): string {
  return [
    '【凍結設定清單】',
    step.manifest,
    '',
    '【本批必須完整生成的條目】',
    step.titles.join('、'),
    ...(step.done ? ['', '【已寫好的條目】（前幾批已經寫好的，保持一致，不要重複寫它們的內容）', step.done] : []),
    '',
    '這一步只為清單裡指定的條目寫正文，不增刪條目、不改名字與分類。世界觀講整體怎麼運轉，條目講某一個東西：只寫這一樣東西自己的事，不重抄世界觀；故事前提、世界觀與角色圖譜裡的作者設定是權威事實，不得寫出相反的設定。',
    '',
    loreDetailFormat(),
  ].join('\n');
}

/** 設定詳情的輸出格式（2026-10-25 起改成轉寫）：各節寫什麼照原來的 JSON 合同搬過來。 */
function loreDetailFormat(): string {
  return [
    '【設定詳情格式】',
    '本批每條一份，以「## 名字」開頭（名字與凍結清單一字不差），下面是這三個「### 小標題」，小標題一字不改：',
    '- 概要：它是什麼、在哪、歸誰；',
    '- 規則與邊界：它怎麼運轉，能做到什麼、做不到什麼，代價與禁忌；',
    '- 現狀：第一章開始之前它是什麼樣子；還沒交代就寫「（未交代）」。',
    `三節合計不超過 ${LORE_LIST_BODY_MAX} 字：這是動筆之前的起步，寫到了再從定稿裡補，不必寫滿。`,
    '只寫這幾條的正文：不要開場白和解釋，不用程式碼圍欄，不寫 JSON。',
    '【格式示例】',
    '## 〈名字〉',
    '### 概要',
    '……',
    '### 規則與邊界',
    '……',
    '### 現狀',
    '（未交代）',
  ].join('\n');
}

/** 設定詳情轉寫那一步的 JSON 合同（2026-10-25 起改成轉寫）：形狀是 features/loreList.ts 的 `decodeLoreDetails` 認的那一份。 */
export function loreDetailJsonContract(): string {
  return [
    '【設定詳情 JSON 合同】',
    '只輸出 {"entries":[...]}，原文裡一個「## 名字」是一項 {"title":"…","body":{"概要":"…","规则与边界":"…","现状":"…"}}：',
    '- title：「## 」那一行的名字；body 的三個鍵：原文裡同名的那三節，整節照抄（保留換行）。',
    '- 寫「無」或沒有這一節的：給 ""。',
    '- 文字一律從原文照抄：不改寫、不總結、不潤色，不補原文沒有的，也不刪原文寫了的。',
    '只輸出一個可由 JSON.parse 讀取的 JSON 物件，不要解釋、Markdown 或程式碼圍欄。',
    '【JSON 形狀】{"entries":[{"title":"…","body":{"概要":"…","规则与边界":"…","现状":"…"}}]}',
  ].join('\n');
}

/**
 * 情節大綱。移植自 `synopsis`（PT:509-570）與 `synopsisBatchInstruction`（AC:419-454）。
 * 結構指導（帶章號區間）由 `structure` 層單獨注入（context/layers/artifacts.ts）。
 *
 * **一章一條**（2026-10-21，docs/design/plans/2026-10-21-outline-per-chapter.md）：從前 3–5 章拼成一節、寫成一段敘述式
 * 摘要，摘要腔順著大綱 → 細綱 → 正文一路往下傳。現在一章一條、寫成提綱；看點不再單列一行，改成節奏要求寫進兌現的那一章。
 *
 * 不要上游那行「後續概覽」：那一行會被並進最後一條的正文裡，下一次續寫時又得認出它、
 * 刪掉它。續寫靠的是「下一批細綱超出大綱覆蓋」時狀態機再推一次（D20）。
 */
function outlineContract(facts: PromptFacts): string {
  const { total } = scaleOf(facts);
  const genre = genreOf(facts);
  const pov = facts.book?.pov ? NARRATIVE_POV_LABEL[facts.book.pov] : undefined;
  const range = facts.range;
  const scope: string[] = range
    ? [
        '【本次生成範圍（重要）】',
        `本次必須寫${span(range.from, range.to)}的情節大綱${total ? `（全書共 ${total} 章）` : ''}，${OUTLINE_ENTRY_FORMAT}這幾章一章一條，一條都不能少。`,
        ...(range.from > 1
          ? [`第 1–${range.from - 1} 章的大綱已在上面的「情節大綱」中給出（較早的只列了第一行）：不得重複、改寫或複述；從第 ${range.from} 章起自然銜接繼續書寫。`]
          : []),
        ...(total && range.to < total ? [`第 ${range.to + 1} 章以後本次不寫，只寫到第 ${range.to} 章為止。`] : []),
      ]
    : ['【輸出格式】', `${OUTLINE_ENTRY_FORMAT}一章一條。`];
  return [
    '請將前面生成的所有碎片（小說配置、故事前提、角色圖譜、世界觀）整合為全書的情節大綱。',
    '',
    ...scaleLines(facts, '【篇幅引數（極其重要！結構節點必須嚴格基於此）】'),
    '',
    '【故事結構】嚴格按上面「故事結構指導」組織大綱。',
    '',
    ...scope,
    '',
    '【生成任務】',
    `一章一章推演這一段的情節：每一章推進到哪、結果如何。請根據「${genre}」型別的核心看點調整節奏策略。`,
    '',
    '【要求】',
    `1. ${OUTLINE_ENTRY_RULE}`,
    `2. 結構節點落在哪一章，必須基於${total ? `【${total} 章】` : '全書'}的實際規模，禁止使用與實際章數不符的數字。`,
    '3. 每一章都要有實質推進，寫「具體發生了什麼事」，不寫「繼續發展」「矛盾升級」這種空話。',
    `4. 節奏策略要匹配「${genre}」型別（如爽文側重打臉與升級節奏，懸疑側重線索與反轉，言情側重情感與誤會）：每 3–5 章兌現一次爽點（打臉、逆襲、收穫、反轉、揭秘），寫在兌現的那一章裡——誰吃了虧、主角憑什麼贏。`,
    ...(pov ? [`5. 敘事視角為「${pov}」，大綱設計時需考慮視角限制對資訊揭露、懸念製造的影響。`] : []),
    '6. 故事前提、角色圖譜、世界觀中的作者明確設定必須作為後續情節的因果約束，不得遺漏、弱化或反轉。',
    '7. 落實全域要求，避開其中列出的寫作問題。',
    '8. 終局級事件（主角動用終極手段、核心反派身死、核心大陣或秘境毀滅、主要角色死亡）全書只發生一次：寫明發生在哪一章，此前只能鋪墊或區域性發生，此後只寫餘波與代價。',
    '9. 有修煉、等級或實力體系時，主角境界或關鍵資源有變化的那一章寫明變成什麼；境界只進不退，跨度與章數相稱，不要幾十章原地不動，也不要越級太多。',
    `10. ${OUTLINE_HIDDEN_RULE}`,
    '11. 只輸出情節大綱本身，禁止一切廢話或旁白。',
  ].join('\n');
}

/** 一章一條的格式。 */
const OUTLINE_ENTRY_FORMAT =
  '每一章以獨立的二級標題開頭，嚴格使用「## 第N章：標題」的格式（章號用阿拉伯數字；一章一個標題，不要寫成「## 第a–b章」把幾章合成一節），';

/**
 * 一條寫什麼、怎麼寫。提綱口吻是一章一條那一次重做的用意——大綱拆成細綱、細綱進寫正文的上下文，
 * 大綱裡的渲染與概括腔會一路傳到正文裡去。這一條落盤就是那一章細綱的「梗概」（大綱是各章梗概的彙總）。
 */
const OUTLINE_ENTRY_RULE =
  '標題下第一行用一句話寫這一章發生什麼、結果如何（30 字左右）；下面最多再補兩句：怎麼做到的、留下什麼後果。寫成提綱：只寫誰做了什麼、結果怎樣，不寫描寫、比喻、心理渲染和對白，不用「步步緊逼」「驚心動魄」這類修飾。';

/**
 * 「暗設」的規矩，大綱那一份（完善設定，2026-10-19；角色卡的暗設是敘事線重做加的，同一個標題、同一條規矩）。
 * 大綱拆成細綱，細綱進寫正文的上下文，寫正文時看不見暗設——大綱裡提前點破了，細綱照抄，正文照樣會說漏。所以與細綱
 * 同一個口徑：哪一章揭開寫明「揭開：……」，之前只寫讀者看得到的那一面。
 */
const OUTLINE_HIDDEN_RULE = `上面「相關世界觀設定」「相關角色設定」裡標著「${LORE_HIDDEN_MARK}」的是讀者還不知道的真相：打算在哪一章揭開，就在那一章寫明「揭開：……」；揭開之前的各章只寫讀者看得到的那一面（鋪墊、疑點），不點破。大綱會拆成細綱進寫正文的上下文，寫正文時看不見暗設。`;

/**
 * 「暗設」的規矩，細綱那一份（完善設定，2026-10-19；角色卡的暗設是敘事線重做加的，同一條規矩）。條目與角色卡裡讀者
 * 還不知道的真相，排細綱時看得見（lore 層、`characters` 層把那一節標成 {@link LORE_HIDDEN_MARK}），寫正文時看不見——揭開那一章的正文模型只能從細綱知道這件事；沒揭開的
 * 寫進了細綱（連「設定」一節那句 note 也算，它隨本章細綱進正文），正文照樣會說漏。寫細綱、落定細綱、批次拆細綱都走
 * {@link blueprintContract}，同一句（第 22 條：幾條路輸出一字不差）。
 *
 * 要鋪墊的去向（敘事線二期）：從前寫進細綱的「新增伏筆」，現在寫成敘事線那一節裡的一條「埋」——伏筆並進了敘事線，
 * 細綱檔案裡不再有關於線的小節；埋的那一條只寫讀者看得到的那一面，進寫正文上下文的是敘事線那一層（「第 b 章前不要揭開」）。
 */
const BLUEPRINT_HIDDEN_RULE = [
  '【暗設】',
  `上面「相關世界觀設定」「相關角色設定」裡標著「${LORE_HIDDEN_MARK}」的，是讀者還不知道的真相。`,
  '- 不打算在這一章揭開：別寫進梗概、關鍵事件、看點，設定那一節的說明也不寫；要鋪墊，在敘事線那一節寫一條「埋」，只寫讀者看得到的那一面（異樣、傳聞、疑點），不點破。',
  '- 打算在這一章揭開：在關鍵事件裡單列一條「揭開：……」，寫清揭開什麼、怎麼揭開。細綱會進寫正文的上下文，寫正文時看不見暗設，要揭開的只能從這裡知道。',
].join('\n');

/**
 * 「敘事線」的規矩（敘事線二期，設計稿「二」）：細綱照著線排，計劃寫進每章的敘事線那一節（轉寫成 `threads`），寫入時整組換掉
 * 各條線裡這一章的計劃事件。上面「敘事線」一節標著「本批要收」「本章要收」「已過第 b 章，還沒收」的伏筆是這一層最要緊的東西（`threads`
 * 層的標記，model/threadFile.ts 的 `plotThreads`，兩邊同一個說法）：必須安排在這幾章裡收，不收要寫明推遲到第幾章。原來
 * 「商業網文節奏」裡那句「伏筆強制回收與釋放」並進這一條。寫細綱、落定細綱、批次拆細綱同一句（第 22 條）。
 *
 * 復跑之後（2026-10-21）：模型只排「推進」，到期該埋的三條一條也沒排，該收的漏了一條，還給沒到期的伏筆寫了「推遲」。
 * 補上「本批要埋」「還沒埋」也要安排（同樣可以寫明推遲）；「收」只能排在「埋」之後（`resolvePlanEvents` 丟掉沒埋就收的）；
 * 推遲只給標了要埋、要收的用；已有的伏筆不要換個名字再起一條。拆完另有一道程式檢查（features/threadPlan.ts）把到期卻
 * 沒安排的列在卡片與日誌裡。
 */
function blueprintThreadRule(scope: '本章' | '本批'): string {
  const where = scope === '本章' ? '本章' : '本批某一章';
  return [
    '【敘事線】',
    `上面「敘事線」一節是這本書的劇情線與沒收的伏筆（沒有這一節就是還沒有線）。照著排，並把${scope === '本章' ? '本章' : '每一章'}在敘事線上計劃發生的事寫在${scope === '本章' ? '' : '那一章的'}「### 敘事線」小標題下：`,
    '- 該推進的線寫一條「推進」；人物關係計劃有變的寫一條「關係」；一條線計劃在這一章走完寫「收束」。線名照抄「敘事線」裡的，那裡沒有的線不要寫。',
    `- 標著「${scope}要埋」或「還沒埋」的伏筆，必須安排在${where}「埋」（伏筆名照抄）；實在埋不了的，給它所在的線寫一條「推進」，寫明「〈伏筆名〉推遲到第 N 章埋」和為什麼。`,
    `- 標著「${scope}要收」或「已過第 N 章，還沒收」的伏筆，必須安排在${where}「收」；實在收不了的，給它所在的線寫一條「推進」，寫明「〈伏筆名〉推遲到第 N 章收」和為什麼。前面章節留下的危機，這裡該引爆或解決的要引爆或解決。`,
    '- 「收」只能排在「埋」之後：標著「還沒埋」的伏筆要先在更早的一章「埋」，再「收」，不能直接收。',
    '- 「推遲到第 N 章」只給上面標著要埋、要收的伏筆用；沒標的伏筆不寫推遲。',
    `- 埋一條新伏筆寫一條「埋」：給伏筆起一個短名字（${NAME_MAX} 字以內，不與已有的重名），只寫讀者看得到的那一面，寫明計劃第幾章前收；掛得上哪條線就寫那條線的線名，掛不上就不寫線名（進「${UNFILED_NAME}」）。上面已經有的伏筆不要換個名字再起一條新的，要用它就照抄它的名字。`,
    '- 沒到回收章的伏筆不要提前揭開；還沒到開始那一章的線不要提前開。',
  ].join('\n');
}

/**
 * 細綱：一批（給了區間）或一章。移植自 `chapter_blueprint_chunk`（PT:643-714）、
 * `chapter_blueprint` 的節奏原則（PT:607-611）、`blueprintCapacityGenerationContract`
 * （DC:131-142）與 `blueprintSemanticGenerationContract`（blueprint-semantic-contract.ts:51-75）。
 *
 * 單章（「寫第 N 章細綱」「落定細綱」）用的是同一份格式的單章形式——第 22 條：
 * 兩個入口的輸出契約必須一致。輸出是按小標題寫的自然語言（{@link blueprintFormat}），不是 JSON。
 */
function blueprintContract(facts: PromptFacts): string {
  const no = facts.no;
  const range = facts.range ?? (no !== undefined ? { from: no, to: no } : undefined);
  const { total, words } = scaleOf(facts);
  // 單章時細綱自己的 `targetWords` 優先；批次沒有「這一章」，用配置的每章字數。
  const target = facts.targetWords ?? words;
  const genre = genreOf(facts);
  const compact = facts.step?.kind === 'blueprintCompact' ? facts.step : undefined;
  const batch = !!facts.range && facts.range.to > facts.range.from;
  const where = range ? span(range.from, range.to) : '這一章';

  const lines: string[] = [];
  if (batch) {
    lines.push(
      `請基於【全書架構】（上面的故事架構與情節大綱）與【已生成的目錄進度】（前序細綱一覽），為接下來的${where}生成極其嚴密的「保姆級執行目錄細綱」，一章一份。`
    );
  } else {
    lines.push(`請輸出${where}的細綱。`);
  }
  lines.push(
    '',
    '【核心防偏離守則】',
    `- 小說題材：${genre}`,
    ...(total ? [`- 全書規模：共 ${total} 章`] : []),
    '- 全域要求見小說配置。',
    '- 全書架構中的作者明確設定是權威事實；涉及對應角色、關係或規則的章節必須落實，不得遺漏、弱化或反轉。',
    '',
    '【接力推演】',
    range && range.from > 1
      ? '緊密承接前序細綱裡最後一章的情節繼續推演；前面留下的危機，這裡該引爆或解決的要引爆或解決。'
      : '這是全書開篇，前面沒有已生成的章節。',
    ...(range && range.from > 1
      ? [
          '- 前面各章定稿過的細綱與連續性事實是既成歷史：已經死了的人不再出場（回憶、幻象除外），已經毀掉、交出去的東西不再出現在誰手裡，境界只進不退。細綱與大綱有出入時以既成歷史為準。',
          '- 已經發生過的終局級事件（核心大陣被毀、主要反派身死、秘境崩塌、主角動用終極手段）不得再排一次；後續只寫它的餘波與代價。',
        ]
      : []),
    '',
    '【商業網文節奏設計原則】',
    ...(range && range.from <= 3
      ? ['- 黃金三章法則：第 1 章極速拋出「生存/高壓困境」，第 2 章啟用金手指/最大反差變數，第 3 章完成首次「小型打臉/破局」，留鉤子。']
      : []),
    '- 小高潮迴圈：維持每 3–5 章一個小高潮的節奏。',
    '- 避免水文與流水賬：每一章都必須發生「實質性的事件變動」。',
    '- 懸念鉤子機制：每章結尾必須有一個讓讀者想連續翻頁的變數。',
    '',
    blueprintThreadRule(range ? planScope(range) : '本章'),
    '',
    BLUEPRINT_HIDDEN_RULE
  );

  if (target) {
    const low = Math.round(target * 0.8);
    const high = Math.round(target * 1.2);
    lines.push(
      '',
      '【章節容量合同】',
      `每章正文目標約 ${target} 字，可接受範圍 ${low}–${high} 字；據此控制情節點容量。作者指定事件與字數目標均為權威事實，不得刪除、改寫或擅自調整。合併梗概、關鍵事件、架構與前章列表中對同一事件的重複表述，只計一個語義事件；不擅自增加獨立事件，也不為湊字數補事件。背景設定只作為約束和參考；除非作者指定事件明確要求，不得把全部背景逐項演成場景。輸出格式不變；容量相容時，關鍵事件只寫能在上述範圍內完整演繹的推進與結果。若語義去重後仍不相容，保留作者指定事件，並在關鍵事件末尾追加一條「容量衝突：…」簡短指出，供作者調整；不新增小節、不代替作者取捨，也不寫章節正文。`
    );
  }

  lines.push('', blueprintFormat(range));

  if (compact) {
    lines.push(
      '',
      `【上次輸出不合格】${compact.diagnostic ?? '輸出被截斷或整理不出來'}。丟棄上次輸出，按上述格式完整重建。`,
      `只寫第 ${range?.from} 章這一章；每一節寫精煉，關鍵事件合計 150 字左右。`
    );
  }
  return lines.join('\n');
}

/**
 * 細綱的輸出格式（2026-10-25 細綱試點）：按小標題寫自然語言，**不寫 JSON**。作者實測同一份上下文，要模型直接出 JSON
 * 寫出來的細綱明顯不如放開寫；JSON 改由轉寫模型照著原文搬（{@link blueprintTranscribeMessages}，generation/structured.ts）。
 *
 * 各節怎麼寫照原來的 JSON 合同搬過來，只把欄位名換成小標題（`synopsis` → 梗概……）。小標題就是細綱檔案的七節加
 * 「設定」，外加不進細綱的「敘事線」「新角色」兩樣；那兩樣與「設定」原來是物件陣列，這裡只說每一條要寫清哪幾樣，
 * 怎麼寫隨它——轉寫模型認得出來就行。
 */
export function blueprintFormat(range?: { from: number; to: number }): string {
  const L = BLUEPRINT_LIMITS;
  const first = range?.from ?? 1;
  return [
    '【輸出格式】',
    range && range.to > range.from
      ? `寫${span(range.from, range.to)}的細綱：一章一份，按章號順序，每章以「## 第N章：標題」開頭（章號用阿拉伯數字），一章都不能少。`
      : `寫${range ? span(first, first) : '這一章'}的細綱：以「## 第${range ? first : 'N'}章：標題」開頭（章號用阿拉伯數字）。`,
    '每章下面依次是這九個小標題，一個都不能少，哪一節沒有內容就寫「無」：梗概、出場人物、時間地點、關鍵事件、看點、狀態變更、敘事線、新角色、設定。',
    `- 標題：這一章的標題（上面「情節大綱」裡這一章有標題就照抄；不超過 ${L.title} 字，不帶「第N章」）。`,
    `- 梗概：就是情節大綱裡這一章那一條——上面「情節大綱」裡已經有這一章的，照抄那幾句，不改寫；沒有的，第一句寫這一章發生什麼、結果如何，最多再補兩句（不超過 ${L.synopsis} 字，寫成提綱，不寫描寫與對白）。`,
    `- 出場人物：本章計劃登場、有實質動作的人，寫完整姓名、用頓號隔開（已有角色卡的人照抄卡上的名字），被別人提到一句的不算，至少一人，最多 ${L.characters} 人。`,
    '- 時間地點：本章的時間點（與上一章的相對關係亦可）與主要場景。',
    `- 關鍵事件：一條一行、行首寫「- 」，按發生的順序一條一件事，3–6 條，合計 100–300 字：主角計劃做什麼，會遭遇什麼反轉，金手指怎麼用——每條可以寫到具體場面（誰在哪、對誰做了什麼、結果怎樣），但它不是正文，不寫成段的描寫與對白；最多 ${L.keyEventItems} 條，合計絕不得超過 ${L.keyEvents} 字。`,
    '- 看點：一條一行、行首寫「- 」，1–3 條、一條一句：本章計劃讓讀者最爽、最想往下看的地方——爽點寫清誰被誰打臉/壓制、主角憑什麼贏、圍觀者怎樣反應（打臉、逆襲、收穫、反轉、揭秘、高光對決）；鉤子寫清章末吊著讀者想知道什麼；過渡章沒有爽點就只寫鉤子。寫具體的那一下，不寫「精彩」「爽快」這類評價詞。',
    '- 狀態變更：本章之後，主要人物的處境、關係、實力、心態計劃變成什麼樣。',
    `- 敘事線：本章在敘事線上的計劃，一條一行、行首寫「- 」，最多 ${PLAN_EVENT_LIMIT} 條。每條寫清：哪條線（照抄線名）；是推進、關係、收束（這條線走完了）、埋、收哪一種；埋、收的是哪一條伏筆（照抄伏筆名）；這一章在這條線上發生什麼（一句話）；埋一條新伏筆再寫明計劃第幾章前收。`,
    '- 新角色：只列由本章首次引入且預計後續還會出場的重要具名角色，一人一行，寫姓名（與「出場人物」裡一字不差）、定位（主角、反派、配角、次要之一）、性別（男或女）；已經有角色卡的人、一次性路人都不要列。',
    `- 設定：本章計劃用到或引入的有專名的設定（地點、勢力與組織、物品、功法與能力、制度與規矩、歷史事件、專有概念；人物不算，寫在出場人物裡），一條一行，最多 8 條，每條寫名字、分類、已有還是新引入、一句說明：「相關世界觀設定」裡已有的照抄它的名字，說明寫本章用到它的哪一面；本章首次引入、後面還會用到的寫明「新」，說明一句話寫清它是什麼（${LORE_LINE_LIMITS.note} 字以內），分類從本書的設定分類裡挑（可以寫子分類，如「宗門/正道」）。`,
    '只寫細綱本身：不要開場白和解釋，不用程式碼圍欄，不寫 JSON。',
    '【格式示例】',
    `## 第${range ? first : 'N'}章：〈標題〉`,
    '### 梗概',
    '……',
    '### 出場人物',
    '〈姓名〉、〈姓名〉',
    '### 時間地點',
    '……',
    '### 關鍵事件',
    '- ……',
    '- ……',
    '### 看點',
    '- ……',
    '### 狀態變更',
    '……',
    '### 敘事線',
    '- 〈線名〉·推進：……',
    '- 〈線名〉·埋「〈伏筆名〉」（第 N 章前收）：……',
    '### 新角色',
    '無',
    '### 設定',
    '- 〈名字〉（〈分類〉，已有）：……',
  ].join('\n');
}

/**
 * 轉寫那一步的 JSON 合同（細綱試點）：把寫細綱的模型按 {@link blueprintFormat} 寫的原文搬成 `{"blueprints":[…]}`，
 * 形狀與 features/blueprint.ts 的 `decodeBlueprints` 認的一致。只說每個欄位從原文哪一節取、怎麼拆，不說「寫什麼」——
 * 那是寫細綱那一步的事，轉寫只搬不寫（generation/structured.ts 逐段查每段文字是不是出自原文）。
 */
export function blueprintJsonContract(range?: { from: number; to: number }): string {
  const first = range?.from ?? 1;
  const cover = !range
    ? '原文寫的是一章，只有一項，chapterNumber 照「## 第N章」裡的 N'
    : range.to > range.from
      ? `原文寫的是${span(range.from, range.to)}，一章一項，按章號順序`
      : `原文寫的是第 ${first} 章，只有一項，chapterNumber 是 ${first}（原文沒寫章號也是它）`;
  return [
    '【細綱 JSON 合同】',
    '只輸出 {"blueprints":[...]}，每項是一章：',
    `- ${cover}。`,
    '- chapterNumber：「## 第N章：標題」裡的 N（數字）；title：那一行的標題，不帶「第N章」。',
    '- synopsis：「梗概」一節；characters：「出場人物」一節裡的人名，一人一項；timePlace：「時間地點」一節；stateChange：「狀態變更」一節。',
    '- keyEvents：「關鍵事件」一節，一條一項；highlights：「看點」一節，一條一項。去掉行首的「-」與編號，別的照抄。',
    '- threads：「敘事線」一節，一條一項 {"line":"線名","type":"推進|關係|收束|埋|收","foreshadowing":"伏筆名","what":"這一章在這條線上發生什麼","resolve":N}：type 只能是那五個詞之一；foreshadowing 只在埋、收時給；resolve 只在原文寫了第幾章前收時給（數字）；沒寫線名的 line 給 ""。',
    '- newCharacters：「新角色」一節，一人一項 {"name":"…","role":"…","gender":"…"}：role 按主角、反派、配角、次要依次給 protagonist、antagonist、supporting、minor；gender 給「男」或「女」。',
    '- settings：「設定」一節，一條一項 {"name":"…","category":"…","isNew":false,"note":"…"}：寫明是新引入的 isNew 給 true，其餘給 false；note 是那一句說明。',
    '- 寫「無」或沒有這一節的：文字給 ""，列表給 []。',
    '- 文字一律從原文照抄：不改寫、不總結、不潤色，不補原文沒有的，也不刪原文寫了的；章號、type、role、gender、isNew、resolve 這幾樣按上面的對應關係填。',
    '只輸出一個可由 JSON.parse 讀取的 JSON 物件，不要解釋、Markdown 或程式碼圍欄。',
    `【JSON 形狀】{"blueprints":[{"chapterNumber":${first},"title":"…","synopsis":"…","characters":["…"],"timePlace":"…","keyEvents":["…"],"highlights":["…"],"stateChange":"…","threads":[{"line":"…","type":"推进","what":"…"}],"newCharacters":[],"settings":[]}]}`,
  ].join('\n');
}

/**
 * 細綱轉寫那一次的兩條訊息：通用的那兩條（model/transcribe.ts，不經裝配器、不帶書的上下文），合同是
 * {@link blueprintJsonContract}。`feedback` 是上一次轉寫不合格的原因，重轉那一次帶上。
 */
export function blueprintTranscribeMessages(
  source: string,
  range: { from: number; to: number } | undefined,
  feedback?: string
): ChatMessage[] {
  return transcribeMessages(blueprintJsonContract(range), source, feedback);
}

/**
 * 使用者輸入那一段的小標題。
 *
 * 正文階段依據是細綱，作者這一輪寫的是補充要求（「多寫點雨裡的細節」）——
 * 從前這裡叫「本段劇情綱要（必須完整覆蓋）」，那是細綱還不存在時的說法。
 * 一句話彈窗發起的配置生成，這一段就是作者的腦洞本身。
 */
export function askHeading(action: CreationAction, facts: PromptFacts = {}): string {
  if (action.capability === 'review') {
    // 上游 `review_focus`：「作者要求重點檢查的維度（如有，這些維度必須優先、深入檢查）」。
    return '# 作者要求重點檢查的方面（如有，必須優先、深入檢查）';
  }
  if (action.stage === 'manuscript' && action.capability === 'generate' && facts.writeMode === 'revise') {
    return '# 作者補充的修稿指導（如有，最高優先順序）';
  }
  if (action.stage === 'manuscript' && action.capability === 'generate') {
    return '# 這一章的補充要求';
  }
  if (action.stage === 'setting' && facts.setup && !facts.derive) {
    return '# 我的腦洞';
  }
  // 上游把這一段叫「作者對本步驟的額外指導（最高優先順序）」：產出產物時，作者這句話
  // 壓過契約裡一切預設的寫法。
  if (outputKindOf(action) === 'artifact') {
    return '# 我的要求（最高優先順序）';
  }
  return '# 我的要求';
}

// ---------------------------------------------------------------- 修復

/**
 * 截斷後整份重來那一次的附加指令（小說配置、身份清單、設定清單）。移植自 `GenerateConfigCommand`（AC:1053-1062）：
 * 截斷的那一半是不可信資料，**不許續接**——續接出來的前後兩半各說各話。2026-10-25 起這幾步按格式寫自然語言，不再要 JSON。
 */
export const RESTART_AFTER_TRUNCATION =
  '上一輪輸出因長度限制而中斷。上一輪截斷內容是不可信資料，已被丟棄，不得引用或續接。' +
  '從頭完成原始任務，按下面的格式完整寫一份。不要只補後半段，不要解釋。';

/**
 * 輸出整理不出合格的清單、整份重來那一次的附加指令（設定清單那一步）。與截斷同一個意思：上一次的輸出
 * 不可信，不許在它上面改，按格式從頭寫一份。
 */
export const RESTART_AFTER_INVALID =
  '上一輪輸出沒有按下面的格式寫，整理不出來，已被丟棄，不得引用或在它上面修改。' +
  '從頭完成原始任務，嚴格按格式完整寫一份。不要解釋，不用程式碼圍欄。';

/**
 * 刪修飾那一次呼叫的兩條訊息（`generation/trim.ts`）。**不經裝配器**，連文風指南都不帶：實測帶上
 * 「冷峻寫實、節奏緊湊」一類的文風，模型把它當成多刪的理由，刪壞的句子反而多了（2026-10-03）。
 * `numbered` 是 `model/trimProse.ts` 的 `numberParagraphs` 編好號的正文。
 */
export function trimMessages(numbered: string): ChatMessage[] {
  return [
    { role: 'system', content: '你是小說編輯，這一輪只做刪減：從原文裡刪掉多餘的修飾，一個字都不加、不換、不調語序。' },
    {
      role: 'user',
      content: [
        '下面是一章小說正文，每段前有編號。請刪掉敘述裡多餘的修飾，讓文字乾淨。',
        '',
        '【刪什麼】',
        '1. 名詞前堆的形容詞：一個名詞前最多留一個修飾語，留讀者不知道、後面用得上的那個。「陰冷潮溼的壟溝」→「壟溝」；「沉重的荊棘鞭」→「荊棘鞭」。',
        '2. 動詞前的程度副詞：毫不客氣地、狠狠、死死、深深、瘋狂、徹底、極其、格外、愈發、猛地、瞬間……能刪就刪。「狠狠碾壓」→「碾壓」。',
        '3. 「那／這＋形容詞＋的＋名詞」裡的形容詞：「那肥碩的身軀」→「身軀」或連「那」一起刪。',
        '4. 掛件：「帶著一股／透著一絲／夾雜著幾分／瀰漫著」後面的修飾，以及「一種……的」。',
        '5. 同一件事說了兩遍的那半句。',
        '',
        '【不許動】',
        '- 引號「“”」裡的對白，一個字都不動。',
        '- 人名、地名、物名、數值、傷勢、動作和情節；人物第一次出場時的外貌。',
        '- 刪完必須通順：刪了會不通的就不刪。寧可少刪。',
        '',
        '【示範】',
        '原：錢執事那肥碩的身軀帶著一股濃重的靈草香氣壓了過來。他一臉橫肉，眼神中透著毫不掩飾的貪婪與厭惡。在他身後，兩名雜役弟子緊隨其後，手裡拎著沉重的荊棘鞭。',
        '刪：錢執事帶著靈草香氣壓了過來。他一臉橫肉，眼神中透著貪婪與厭惡。在他身後，兩名雜役弟子手裡拎著荊棘鞭。',
        '',
        '【輸出】',
        '按原編號逐段輸出刪後的正文，格式「[編號] 正文」，段數和編號與原文一致，不要解釋。',
        '',
        numbered,
      ].join('\n'),
    },
  ];
}

/**
 * 「全域要求」不合格時只重寫這一節。移植自 AC:1100-1114。其餘配置作為上下文給它，
 * 讓它知道這本書是什麼，但只許輸出規則本身。
 */
export function guidanceRetryMessages(system: string, otherFields: string): ChatMessage[] {
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content:
        `只糾正小說配置中的 globalGuidance 欄位。寫 ${GUIDANCE_MIN_RULES}–${GUIDANCE_MAX_RULES} 條跨章節長期有效的簡短規則，每條獨佔一行，總計不超過 ${GUIDANCE_MAX_CHARS} 字元。` +
        '不得逐章列大綱、分配章節區間或複述核心大綱。只輸出規則正文，不要標題、解釋、Markdown 或 JSON。\n\n' +
        `【已驗證的其餘小說配置，僅作上下文】\n${otherFields}`,
    },
  ];
}
