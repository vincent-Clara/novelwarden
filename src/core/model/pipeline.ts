import { traditionalLabel } from './labels';
/**
 * 創作流水線的領域模型：`Stage × Capability × Target`。
 *
 * **純型別 + 純函式，零 I/O、零 import**（與 naming.ts / identity.ts / chapterFile.ts 同類），
 * 因此前端、裝配器、編排層、工程頁共用同一份定義，不會各寫一遍再慢慢跑偏。
 * 前端直接打包這個檔案（見 media/src/protocol.ts），所以這裡**一個 import 都不能有**。
 *
 * 三個正交維度：
 *
 * - **Stage**：我在哪一層（決定 AI 的身份、裝配配方、產物落到哪）
 * - **Capability**：我要它幹什麼（任何階段都能用，只是可用集合不同）
 * - **Target**：我在改哪一個具體產物
 *
 * ## 設定先行，一章一綱
 *
 * 展開的鏈（思路來自 AI-Novel-Writer，GPL-3.0，源自 AI_NovelGenerator）：
 *
 * ```
 * 一句話 ─▶ 架構：小說配置 → 故事前提 → 角色圖譜 → 世界觀 → 設定清單
 *        ─▶ 情節大綱（一章一條）
 *        ─▶ 細綱 summaries/…/NNN-标题.md（一章一份，每批 5 章；與正文相對路徑相同）
 *        ─▶ 正文 chapters/…/NNN-标题.md（直接落盤，可以按卷分子目錄）
 *        ─▶ 定稿（照正文反向更新同一份細綱）
 * ```
 *
 * **一條軸：細綱號 = 章號。** 細綱映象正文在章節根下的相對路徑（`chapters/第一卷/003-深处.txt` ↔
 * `summaries/第一卷/003-深处.md`），檔名字首就是章號。從前是兩條：規劃的單位是「劇情段」，一段寫完再由
 * 作者標斷點切成幾章，介面上的「劇情 N」是推匯出來的位次。那套跑出來的正文是
 * 梗概體的流水賬——細綱太虛、又沒有長度錨點，模型拿到一條抽象的因果鏈去「擴寫」。
 * 現在一章一份細綱、每章一個目標字數，卷、中轉站、拆章、位次統統刪掉。
 * 老工程磁碟上的 `volumes/`、`manuscripts/` 一個位元組都不動，程式碼只是不再讀它們。
 */

// ---------------------------------------------------------------- Stage

/**
 * 創作階段。四層，自上而下：這是個什麼故事 → 故事怎麼走 → 這一章發生什麼 →
 * 怎麼寫出來。
 *
 * `setting` 介面上叫「架構」而不叫「設定」：設定條目（`lore/`）在工程頁上一直
 * 叫「設定」，兩個東西撞名的話作者分不清點開的是哪一個。
 */
export type CreationStage = 'setting' | 'outline' | 'plot' | 'manuscript';

export const CREATION_STAGES: CreationStage[] = ['setting', 'outline', 'plot', 'manuscript'];

/** 階段的中文名。前端按鈕、日誌、確認框共用這一份，不在前端另寫。 */
export const STAGE_LABEL: Record<CreationStage, string> = {
  setting: '架構',
  outline: '大綱',
  plot: '細綱',
  manuscript: '正文',
};

/** 每個階段回答的那個問題。前端的流水線條用它做 tooltip。 */
export const STAGE_QUESTION: Record<CreationStage, string> = {
  setting: '這是個什麼故事？誰在裡面，世界怎麼運轉？',
  outline: '故事怎麼走？',
  plot: '這一章發生什麼？',
  manuscript: '怎麼把它寫出來？',
};

/**
 * AI 在該階段的身份。
 *
 * 這比提示詞技巧更要緊：同一句「這裡衝突太弱」，策劃會去動賣點與人設，
 * 大綱編輯會去動故事結構，劇情編劇會去調這一章的事件與鉤子，作者會去改措辭。
 * 不說清身份，四個階段會得到同一種泛泛而談的回答。
 */
export const STAGE_ROLE: Record<CreationStage, string> = {
  setting: '資深網文策劃編輯',
  outline: '資深長篇小說策劃編輯',
  plot: '劇情編劇',
  manuscript: '資深中文長篇小說作者',
};

export function isCreationStage(value: unknown): value is CreationStage {
  return typeof value === 'string' && (CREATION_STAGES as string[]).includes(value);
}

// ---------------------------------------------------------------- 架構的五件文件

/**
 * 架構層的五件文件，順序即生成順序：每一件都吃前面幾件的產出。
 *
 * `characters`（角色圖譜）與 `lore`（設定清單）沒有自己的檔案——它們就是 `characters/`、`lore/`
 * 下那一組角色卡、設定條目。另外三件各是一份檔案（見 model/settingFile.ts）。
 *
 * 設定清單排在世界觀之後（作者定案，設定名錄）：世界觀講整體怎麼運轉，清單把裡面點到的地點、勢力、
 * 體系、物品一樣一樣排出來，各建一條條目。
 */
export type SettingDoc = 'config' | 'premise' | 'characters' | 'world' | 'lore';

export const SETTING_DOCS: SettingDoc[] = ['config', 'premise', 'characters', 'world', 'lore'];

export const SETTING_DOC_LABEL: Record<SettingDoc, string> = {
  config: '小說配置',
  premise: '故事前提',
  characters: '角色圖譜',
  world: '世界觀',
  lore: '設定清單',
};

export function isSettingDoc(value: unknown): value is SettingDoc {
  return typeof value === 'string' && (SETTING_DOCS as string[]).includes(value);
}

/**
 * 設定清單填過沒有：至少有一條設定條目，**或者這本書已經有正文**（哪一章字數 > 0）。
 *
 * 後一半是給在寫的書的：它們沒排過清單，設定從定稿裡長出來、再從名錄建條目——不能因為架構多了
 * 一件，就把寫到第 80 章的書推回架構那一檔（第 20 條：主按鈕只推一個下一步，推的得是對的那個）。
 * 讀盤在 `NovelProject.settingFilled`，判據只在這裡寫一次。
 */
export function isLoreListFilled(entries: number, hasProse: boolean): boolean {
  return entries > 0 || hasProse;
}

// ---------------------------------------------------------------- Capability

/**
 * 通用能力。與階段正交——「討論」不是一個模式，而是四個能力之一。
 *
 * 留下來的每一個都有**提示詞之外**的結構差異：輸出契約、解析、裝配配方、
 * 採納流程，那才是值得作者顯式挑一下的東西。從前還有一個 `split`（大綱拆卷、
 * 卷拆劇情段），卷那一層刪掉之後它沒有落點了。
 *
 * `review`（審稿，五期）只掛在正文層：一次呼叫出一份逐條引證的報告，**只出報告、不寫檔案**
 * （D9、D22）。它不進主按鈕（第 20 條）——審稿是可選動作，由作者自己決定哪一章值得查一遍。
 */
export type Capability = 'discuss' | 'generate' | 'settle' | 'review';

export const CAPABILITIES: Capability[] = ['discuss', 'generate', 'settle', 'review'];

export const CAPABILITY_LABEL: Record<Capability, string> = {
  discuss: '討論',
  generate: '生成',
  settle: '落定',
  review: '審稿',
};

/** 按鈕的 tooltip。說清「點了會發生什麼」，尤其是會不會產出可採納的東西。 */
export const CAPABILITY_HINT: Record<Capability, string> = {
  discuss: '就當前產物提問，AI 只回答，不改動任何檔案',
  generate: '按你描述的走向產出本階段的產物，可採納寫入；目標已有內容時，你的話就是修改意見',
  settle: '把剛才討論出的結論整理成產物，可採納寫入',
  review:
    '逐條引原文挑出這一章的連續性、因果與角色狀態問題，並逐項核對細綱裡的關鍵事件；只出報告，不改檔案。' +
    '勾選之後可以按勾選的條目修稿',
};

export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITIES as string[]).includes(value);
}

/**
 * 能力在某個階段的**具體說法**。`CAPABILITY_LABEL` 是通用說法，日誌與確認框
 * 用它是對的；介面上有階段做上下文，說得具體些更好懂。
 */
const CAPABILITY_LABEL_IN: Partial<Record<CreationStage, Partial<Record<Capability, string>>>> = {
  // 架構那一層的 `settle` 只在設定目錄上有（{@link capabilitiesOn}），所以就叫「落定設定」。
  setting: { generate: '生成這份架構檔案', settle: '落定設定' },
  // 大綱那一層的「生成」只往後排一段（{@link outlineNextRange}），整份重排走工程頁「情節大綱」右鍵「重寫…」。
  outline: { generate: '續寫大綱' },
  plot: { generate: '寫細綱', settle: '落定細綱' },
  manuscript: { generate: '寫正文' },
};

/**
 * 單條設定（展開，完善設定 2026-10-19）這個目標上的說法。它在架構那一層（階段是 `setting`），做的事卻不是
 * 「生成這份架構文件」——所以按目標分，不按階段分；設定清單、世界觀等幾件的說法不動。
 */
const CAPABILITY_LABEL_ON_LORE: Partial<Record<Capability, string>> = { generate: '展開這條設定' };

/**
 * 某階段下某能力在按鈕上的說法。`target` 只在分得出單條設定時用得上（同一個階段，兩種說法），
 * 不給就按階段說。
 */
export function labelOf(stage: CreationStage, capability: Capability, target?: CreationTarget): string {
  if (target?.kind === 'lore') {
    return CAPABILITY_LABEL_ON_LORE[capability] ?? CAPABILITY_LABEL[capability];
  }
  return CAPABILITY_LABEL_IN[stage]?.[capability] ?? CAPABILITY_LABEL[capability];
}

/**
 * 每個階段合法的能力。**前端的命令面板經 `commandsFor` 讀它**，不在前端另寫一份。
 *
 * `settle` 只有兩處（第 22 條）：細綱（「先跟人聊、聊出結論再落檔案」），與架構那一層的**設定目錄**
 * （落定設定，完善設定二期：把討論裡定下來的設定寫成一批條目）。架構其餘幾件與大綱通常一次成型，
 * 正文是從細綱展開而不是從對話展開。設定目錄之外的架構文件不開 `settle`——按目標再篩一道在
 * {@link capabilitiesOn}，這張表只按階段。
 */
export const STAGE_CAPABILITIES: Record<CreationStage, Capability[]> = {
  setting: ['discuss', 'generate', 'settle'],
  outline: ['discuss', 'generate'],
  plot: ['discuss', 'settle', 'generate'],
  manuscript: ['discuss', 'generate', 'review'],
};

/**
 * 落定設定（完善設定二期）的目標：設定目錄本身。它在任何階段都能下（{@link commandsFor} 在每一層的命令面板
 * 末尾掛一條 `/落定設定`），這一輪臨時把目標換成這裡，落完回到原來的目標（controller/chat.ts）。
 *
 * 與設定清單是同一個目標，能力不同：清單是 `generate`（整批排一份），落定是 `settle`（照討論寫一批）。
 */
export const LORE_SETTLE_TARGET: CreationTarget = { kind: 'setting', doc: 'lore' };

/** 這一個動作是不是落定設定：架構那一層的 `settle` 只開在設定目錄上，所以只看動作就認得出。 */
export function isLoreSettle(action: { stage: CreationStage; capability: Capability }): boolean {
  return action.stage === 'setting' && action.capability === 'settle';
}

/** 目標是不是設定目錄（設定清單 / 落定設定落在這裡）。 */
function isLoreDir(target?: CreationTarget): boolean {
  return target?.kind === 'setting' && target.doc === 'lore';
}

/**
 * 這一層、這個目標上能用的能力：{@link STAGE_CAPABILITIES} 再按目標篩一道——架構那一層只有設定目錄有 `settle`
 * （小說配置、前提、角色圖譜、世界觀、單條設定都不開）。不給目標就當不是設定目錄。
 */
export function capabilitiesOn(stage: CreationStage, target?: CreationTarget): Capability[] {
  const all = STAGE_CAPABILITIES[stage] ?? [];
  return stage === 'setting' && !isLoreDir(target) ? all.filter((c) => c !== 'settle') : all;
}

/**
 * 切到某階段時預設高亮哪個能力。
 *
 * 一律是 `discuss`：預設動作不該是花錢產出一份要不要都不知道的產物。
 * 這是「不偷偷燒 token」在互動上的落法——使用者得主動點「生成」。
 */
export const DEFAULT_CAPABILITY: Record<CreationStage, Capability> = {
  setting: 'discuss',
  outline: 'discuss',
  plot: 'discuss',
  manuscript: 'discuss',
};

export interface CreationAction {
  stage: CreationStage;
  capability: Capability;
}

export function isValidAction(action: CreationAction): boolean {
  return (
    isCreationStage(action.stage) &&
    isCapability(action.capability) &&
    STAGE_CAPABILITIES[action.stage].includes(action.capability)
  );
}

/**
 * 刪掉的能力在老會話裡的落點：改寫並進了生成，其餘是討論的變體。
 * `split`（拆卷 / 拆段）**不對映**——它認不出，於是回落到預設的討論：
 * 開啟一個老會話不該替作者按下一個會花錢的按鈕。
 */
const LEGACY_CAPABILITY: Record<string, Capability> = {
  rewrite: 'generate',
  expand: 'discuss',
  critique: 'discuss',
  check: 'discuss',
};

/**
 * 刪掉的階段在老會話裡的落點。與 `normalizeTarget` 必須一致，否則老會話開啟時
 * stage 說一層、target 指另一層。
 *
 * - `scene`（細節層）落到 `plot`：那一層的會話記的是「這一幕該怎麼發生」。
 * - `volume`（卷綱）落到 `outline`：卷那一層刪掉了，離它最近的是情節大綱。
 */
const LEGACY_STAGE: Record<string, CreationStage> = {
  scene: 'plot',
  volume: 'outline',
};

/**
 * 容錯歸一：認不出的階段回落到 `manuscript`（老會話最可能是在續寫），
 * 認不出或該階段不支援的能力回落到該階段的預設能力。**絕不拋**。
 */
export function normalizeAction(raw: unknown): CreationAction {
  const o = (raw ?? {}) as { stage?: unknown; capability?: unknown };
  const rawStage = typeof o.stage === 'string' ? LEGACY_STAGE[o.stage] ?? o.stage : o.stage;
  const stage: CreationStage = isCreationStage(rawStage) ? rawStage : 'manuscript';
  const raw2 = typeof o.capability === 'string' ? LEGACY_CAPABILITY[o.capability] ?? o.capability : o.capability;
  const capability =
    isCapability(raw2) && STAGE_CAPABILITIES[stage].includes(raw2) ? raw2 : DEFAULT_CAPABILITY[stage];
  return { stage, capability };
}

// ---------------------------------------------------------------- 輸出形態

/**
 * 輸出形態。決定要不要解析成結構化產物、要不要問一次落盤。
 *
 * - `text`：自由作答，只出現在對話氣泡裡，不碰任何檔案。
 * - `artifact`：產出本階段的產物，可以採納落盤。
 * - `report`：審稿報告（五期）。有結構、要解析、要校驗引文，但**不是**可以落盤的東西——
 *   沒有落盤卡片，隨會話儲存（D22）。凡是按「不是討論就是產物」判斷的地方都得認它，
 *   否則一份審稿 JSON 會走到寫入卡上、被當成正文寫進章節。
 */
export type OutputKind = 'text' | 'artifact' | 'report';

export function outputKindOf(action: CreationAction): OutputKind {
  return action.capability === 'discuss' ? 'text' : action.capability === 'review' ? 'report' : 'artifact';
}

// ---------------------------------------------------------------- 命令表

/**
 * 一條可執行的命令。創作頁的 `/` 命令面板吃這一份。
 *
 * 在任何一個具體時刻，作者真正要按的只有一個（由狀態機算出來，見 `deriveNextStep`），
 * 其餘的是「偶爾要用」。偶爾要用的東西該收進命令面板，不該常駐佔地方。
 */
export interface StageCommand {
  capability: Capability;
  /** 按鈕/選單項上的說法，已按階段具體化。 */
  label: string;
  hint: string;
  /** `/` 面板的過濾鍵。中文標籤之外再給 ascii 別名，免得為了打一個命令切輸入法。 */
  keys: string[];
  /**
   * 這條命令不在當前這一層下：傳送時階段與目標換成這兩個（`/續寫大綱`、`/落定設定`，任何一層的面板裡都有）。
   * 缺席就是當前這一層、當前的目標。
   */
  stage?: CreationStage;
  target?: CreationTarget;
}

/** 各能力的 ascii 別名。全拼 + 拼音首字母，兩種都認。 */
const CAPABILITY_KEYS: Record<Capability, string[]> = {
  discuss: ['discuss', 'tl'],
  generate: ['generate', 'sc'],
  settle: ['settle', 'ld'],
  review: ['review', 'sg'],
};

/** 單條設定上「展開」多認兩個別名（`/展開` 的全拼與首字母）。 */
const CAPABILITY_KEYS_ON_LORE: Partial<Record<Capability, string[]>> = { generate: ['expand', 'zk'] };

/** `/落定設定` 多認兩個別名：首字母 `ldsd`，以及 `lore`（與 `/ld` 一起打時和落定細綱分得開）。 */
const LORE_SETTLE_KEYS = ['ldsd', 'lore'];

/** `/續寫大綱` 的別名：首字母 `xxdg`、`xx`，以及 `outline`。 */
const OUTLINE_CONTINUE_KEYS = ['xxdg', 'xx', 'outline'];

/** `/續寫大綱` 在別的層下時的目標：情節大綱。 */
export const OUTLINE_TARGET: CreationTarget = { kind: 'outline' };

/** 這一個動作是不是續寫情節大綱：大綱那一層只有這一種「生成」（主按鈕的「生成 / 續寫情節大綱」也是它）。 */
export function isOutlineContinue(action: { stage: CreationStage; capability: Capability }): boolean {
  return action.stage === 'outline' && action.capability === 'generate';
}

/**
 * 這個階段能下哪些命令。順序即面板裡的順序。
 *
 * **`discuss` 不進面板**：討論是預設動作——打字就是在討論，不需要一條命令。
 * 於是面板裡剩下的每一條都會花錢，除審稿外都產出可採納的產物（會問一次落盤；
 * 審稿只出報告），這正是它們值得顯式挑一下的原因。也因此命令都**不要求輸入**：輸入是可選的
 * 補充要求；`settle` 尤其不能要求輸入——它要沉澱的是已經發生過的對話。
 *
 * `target` 給了且是單條設定時，「生成」換成「展開這條設定」（`/展開`）；可用的能力按階段與目標算
 * （{@link capabilitiesOn}）。
 *
 * **`/落定設定` 每一層都有**（完善設定二期）：討論細綱、正文時聊定了的設定，當場就能落成條目，不必先切到
 * 設定目錄。它掛在末尾，帶著自己的階段與目標（{@link LORE_SETTLE_TARGET}）；目標本來就是設定目錄時它就是
 * 這一層自己的 `settle`，不重複掛。
 *
 * **`/續寫大綱` 也是每一層都有**（2026-10-24）：寫細綱、寫正文時發現大綱快不夠用了，不必先切回全書那一層。
 * 它排在 `/落定設定` 前面，帶著自己的階段與目標（{@link OUTLINE_TARGET}），跑完回到原來那一層；大綱那一層
 * 它就是這一層自己的「生成」。
 */
export function commandsFor(stage: CreationStage, target?: CreationTarget): StageCommand[] {
  const onLore = target?.kind === 'lore';
  const own = capabilitiesOn(stage, target)
    .filter((capability) => capability !== 'discuss')
    .map((capability) => ({
      capability,
      label: labelOf(stage, capability, target),
      hint: hintOf(stage, capability, target),
      keys: [
        ...CAPABILITY_KEYS[capability],
        ...((onLore && CAPABILITY_KEYS_ON_LORE[capability]) || []),
        ...(isLoreSettle({ stage, capability }) ? LORE_SETTLE_KEYS : []),
        ...(isOutlineContinue({ stage, capability }) ? OUTLINE_CONTINUE_KEYS : []),
      ],
    }));
  const continueOutline: StageCommand[] =
    stage === 'outline'
      ? []
      : [
          {
            capability: 'generate',
            label: labelOf('outline', 'generate'),
            hint: outlineContinueHint(true),
            keys: [...OUTLINE_CONTINUE_KEYS],
            stage: 'outline',
            target: OUTLINE_TARGET,
          },
        ];
  if (own.some((c) => isLoreSettle({ stage, capability: c.capability }))) {
    // 設定目錄上的落定設定是這一層自己的，照樣排在最後。
    return [
      ...own.filter((c) => !isLoreSettle({ stage, capability: c.capability })),
      ...continueOutline,
      ...own.filter((c) => isLoreSettle({ stage, capability: c.capability })),
    ];
  }
  return [
    ...own,
    ...continueOutline,
    {
      capability: 'settle',
      label: labelOf('setting', 'settle', LORE_SETTLE_TARGET),
      hint: hintOf('setting', 'settle', LORE_SETTLE_TARGET),
      keys: [...CAPABILITY_KEYS.settle, ...LORE_SETTLE_KEYS],
      stage: 'setting',
      target: LORE_SETTLE_TARGET,
    },
  ];
}

/**
 * 某階段下某能力的 tooltip。
 *
 * **細綱層的 `settle` / `generate`**：這兩條是同一層裡唯二產出同一種產物的命令，
 * 通用文案說不清它們的差別，而那個差別（以討論為準還是以你這句話為準）正是
 * 作者要選的東西。
 */
function hintOf(stage: CreationStage, capability: Capability, target?: CreationTarget): string {
  if (target?.kind === 'lore' && capability === 'generate') {
    return '照已排細綱裡要用到它的地方把這一條往前想細（含暗設），附幾條還沒定的問題；同步過的章裡寫過的不推翻，可採納寫入';
  }
  if (isLoreSettle({ stage, capability })) {
    return (
      '把剛才討論裡已經定下來的設定寫成一批條目（新建的、改已有的都在裡面），還沒定的列在卡片上；' +
      `已有的條目寫入前逐條對比。${describeCalls(LORE_SETTLE_CALLS)}`
    );
  }
  if (stage === 'plot') {
    if (capability === 'settle') {
      return `把剛才討論出的走向整理成這一章的細綱，以討論裡的結論為準。${describeCalls(PLOT_CALLS)}`;
    }
    if (capability === 'generate') {
      return `按你在輸入框裡描述的走向填成這一章的細綱。${describeCalls(PLOT_CALLS)}`;
    }
  }
  if (isOutlineContinue({ stage, capability })) {
    return outlineContinueHint(false);
  }
  return CAPABILITY_HINT[capability];
}

/** `/續寫大綱` 的 tooltip。`away`：從別的層下的，跑完回到那一層。 */
function outlineContinueHint(away: boolean): string {
  return (
    `從情節大綱排到的下一章起往後排 ${OUTLINE_BATCH} 章（不超過全書章數；還沒有大綱就從第 1 章排起），` +
    `輸入框裡有字就當這一段的要求，可採納寫入${away ? '，跑完回到這一層' : ''}；整份重排在工程頁「情節大綱」右鍵「重寫…」。` +
    describeCalls(ONE_CALL)
  );
}

/**
 * 某階段的某個能力對應的命令；不支援時 undefined。`target` 同 {@link commandsFor}。
 *
 * 只認**這一層、這個目標自己的**：別的層掛過來的 `/落定設定` 傳送時階段與目標已經換成設定目錄，在那裡它就是
 * 那一層自己的 `settle`；在細綱層問 `settle` 得到的是落定細綱，在小說配置上問 `settle` 什麼都沒有。
 */
export function commandOf(stage: CreationStage, capability: Capability, target?: CreationTarget): StageCommand | undefined {
  return commandsFor(stage, target).find((c) => c.capability === capability && !c.stage);
}

/**
 * 「第 12 章《夜入青雲》」——一章在介面、日誌、上下文標籤裡的統一說法。
 *
 * **未命名的章只報序號。** 標題可能還沒定（`007.md`），`listChapters` 的標題回落鏈
 * 也會給出「第 7 章」；模板一套就成了「第 7 章《第 7 章》」——讀起來像出了 bug。
 * 判據就是「標題恰好等於那個回落值」，因為那正是「沒有標題」在資料裡的樣子。
 *
 * 細綱（`summaries/`）與正文（`chapters/`）說的是同一章，所以只有這一個說法。
 */
export function chapterLabel(order: number, title?: string): string {
  const named = title?.trim();
  return named && !isFallbackChapterTitle(order, named) ? `第 ${order} 章《${named}》` : `第 ${order} 章`;
}

/**
 * 這個標題就是「沒有標題」在資料裡的樣子。
 *
 * 無標題的章（`009.md`）在 `listChapters` 的回落鏈裡會拿到「第 9 章」——
 * 那不是作者起的名字，是沒有名字。凡是要拿標題去**造東西**的地方都得先問一句：
 * 拿它拼細綱檔名會得到 `009-第-9-章.md`，一個假標題就此進了磁碟。
 */
export function isFallbackChapterTitle(order: number, title?: string): boolean {
  return (title?.trim() ?? '') === `第 ${order} 章`;
}

/** {@link chapterLabel} 在細綱那一側的別名。輸出完全一致。 */
export const plotLabel = chapterLabel;

// ---------------------------------------------------------------- Target

/**
 * 當前在改哪個產物。
 *
 * 細綱與正文**一律用 `plotRelPath` 而不是章號**：號會撞（作者手改檔名時
 * `007-a.md` 與 `007-b.md` 並存是允許的），路徑不會。正文的落點由細綱號去認
 * 同號的章節——那一步要讀盤，不在這裡做（見 views/pipeline.ts 的 `chapterOfPlotNo`）。
 *
 * **單條設定（`lore`，完善設定 2026-10-19）**：展開一條設定條目，階段是 `setting`，照細綱的路子目標自己帶著
 * 檔案身份（`relPath`，條目在 `lore/` 下的工程相對路徑）。不復用 `{ kind: 'setting', doc: 'lore' }` 加一個
 * 路徑：凡是 `doc === 'lore'` 的分支都會走設定清單那條鏈，`targetKey` 會把單條和整批當成同一個目標，
 * 隨會話存下的草稿重開後會被當成整批清單採納。
 */
export type CreationTarget =
  | { kind: 'setting'; doc: SettingDoc }
  | { kind: 'outline' }
  | { kind: 'plot'; plotRelPath: string }
  | { kind: 'manuscript'; plotRelPath: string }
  | { kind: 'lore'; relPath: string };

/**
 * target 屬於哪個階段。兩者不是同一件事：target 是名詞，stage 是動詞的所在層。
 *
 * 只有單條設定不是恆等：它是架構那一層的東西（`setting`）。留著這個函式是因為呼叫點分屬兩條取數路徑，
 * 讀程式碼時能看出手裡拿的是名詞還是動詞。
 */
export function stageOfTarget(target: CreationTarget): CreationStage {
  return target.kind === 'lore' ? 'setting' : target.kind;
}

/** 該 target 歸屬的細綱路徑；架構與大綱都沒有歸屬章。 */
export function plotOfTarget(target: CreationTarget): string | undefined {
  return target.kind === 'plot' || target.kind === 'manuscript' ? target.plotRelPath : undefined;
}

/** 該 target 是哪一條設定條目（工程相對路徑）；不是單條設定時 undefined。 */
export function loreOfTarget(target: CreationTarget): string | undefined {
  return target.kind === 'lore' ? target.relPath : undefined;
}

/** 該 target 是架構的哪一件；不是架構時 undefined。 */
export function settingOfTarget(target: CreationTarget): SettingDoc | undefined {
  return target.kind === 'setting' ? target.doc : undefined;
}

/**
 * 穩定的字串鍵。會話分組、前端 dataset、失敗記錄都用它，
 * 避免各處自己拼一份格式不同的 id。
 */
export function targetKey(target: CreationTarget): string {
  switch (target.kind) {
    case 'setting':
      return `setting:${target.doc}`;
    case 'outline':
      return 'outline';
    case 'plot':
      return `plot:${target.plotRelPath}`;
    case 'manuscript':
      return `manuscript:${target.plotRelPath}`;
    case 'lore':
      return `lore:${target.relPath}`;
  }
}

export function isSameTarget(a: CreationTarget, b: CreationTarget): boolean {
  return targetKey(a) === targetKey(b);
}

/**
 * 人類可讀的位置描述，如「第 12 章《入宗風波》· 正文」「設定 · 天機閣」。
 *
 * 後端生成、前端直接顯示：文案只有一份，氣泡裡、歷史頁、日誌裡不會分叉。
 *
 * 單條設定的名字：呼叫方讀得到條目時傳 `info.title`（條目的標題），沒傳就取檔名（去掉 `.md`）——
 * 這裡零 I/O，而條目的檔名就是按標題起的（`slugify`），兩者通常一樣。
 */
export function describeTarget(
  target: CreationTarget,
  info?: { no?: number; title?: string }
): string {
  if (target.kind === 'setting') {
    return `故事架構 · ${SETTING_DOC_LABEL[target.doc]}`;
  }
  if (target.kind === 'outline') {
    return '情節大綱';
  }
  if (target.kind === 'lore') {
    return `設定 · ${info?.title?.trim() || loreStem(target.relPath)}`;
  }
  const head = info?.no !== undefined ? plotLabel(info.no, info.title) : target.plotRelPath;
  return target.kind === 'plot' ? `${head} · 細綱` : `${head} · 正文`;
}

/** 條目路徑的檔名（不含目錄與 `.md`）。這個檔案零 import，不用 `node:path`。 */
function loreStem(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  return base.replace(/\.(md|markdown)$/i, '') || relPath;
}

/**
 * 容錯歸一。認不出的一律回落到 `{ kind: 'outline' }`——它是唯一一個
 * 不依賴任何一章就一定存在的產物，因此是安全的落點。**絕不拋**：
 * 這條路上的輸入來自會話 JSON（作者可能手改過）與前端訊息。
 *
 * - 老會話裡的 `scene` 落到 `plot`：它記著的 `plotRelPath` 仍然有效。
 * - 老會話裡的 `volume` 落到 `outline`：卷那一層刪掉了。
 * - `setting` 帶著認不出的 `doc` 落到 `config`：那是架構的第一件。
 * - `lore`（單條設定）缺路徑也落到 `outline`，**不落到設定清單**：隨會話存下的展開草稿被認成整批清單，
 *   採納時會照清單那條路建一批條目。
 */
export function normalizeTarget(raw: unknown): CreationTarget {
  const o = (raw ?? {}) as Record<string, unknown>;
  const plotRelPath = typeof o.plotRelPath === 'string' ? o.plotRelPath.trim() : '';

  switch (o.kind) {
    case 'setting':
      return { kind: 'setting', doc: isSettingDoc(o.doc) ? o.doc : 'config' };
    case 'plot':
    // 刪掉的那一層：落回它所屬那一章的細綱層。
    case 'scene':
      return plotRelPath ? { kind: 'plot', plotRelPath } : { kind: 'outline' };
    case 'manuscript':
      return plotRelPath ? { kind: 'manuscript', plotRelPath } : { kind: 'outline' };
    case 'lore': {
      const relPath = typeof o.relPath === 'string' ? o.relPath.trim() : '';
      return relPath ? { kind: 'lore', relPath } : { kind: 'outline' };
    }
    default:
      return { kind: 'outline' };
  }
}

// ---------------------------------------------------------------- 單章流水線狀態

/**
 * 這一章當前該做哪一步。
 *
 * **全部由磁碟推導，不落盤**。存一個 `status: writing` 欄位的話，作者手刪
 * 半章正文之後它就在撒謊；而字數與 hash 永遠誠實。
 *
 * 從前在正文與定稿之間還有一檔 `split`（正文寫在中轉站，等作者標斷點拆成章）。
 * 一章一綱之後正文直接落 `chapters/`，這一檔沒有了。
 */
export type PlotStage = 'plot' | 'manuscript' | 'finalize' | 'done';

export const PLOT_STAGE_LABEL: Record<PlotStage, string> = {
  plot: '待寫細綱',
  manuscript: '待寫正文',
  finalize: '待同步',
  done: '已完成',
};

/**
 * 正文寫到目標字數的這個比例就算寫夠了。
 *
 * **為什麼要一個比例而不是「有字就算」**：寫了五百字就跳到「待定稿」會讓狀態機
 * 在最需要說話的時候閉嘴——作者要的恰恰是「這一章還沒寫夠，接著寫」。
 * **為什麼不是 1.0**：模型不會正好停在目標字數上，卡在 0.97 會讓「待寫正文」
 * 永遠消不掉。自動續寫（三期）用的也是這個比例。
 *
 * 判據只在這裡定義一次，`deriveStage` 與 `deriveProgress` 共用——兩處各寫
 * 一遍的話，介面上會出現「進度 100% 但徽章說待寫正文」。
 */
export const MANUSCRIPT_DONE_RATIO = 0.8;

/** 推導所需的全部事實。取數在 core/views/pipeline.ts，判斷在這裡，便於單測。 */
export interface PipelineFacts {
  /** 細綱有實質內容（「關鍵事件」非空，不是一份只有標題的骨架）。 */
  plotFilled: boolean;
  /** 同號章節的正文字數。 */
  words: number;
  /**
   * 這一章的目標字數：細綱的 `targetWords`，沒寫就是 `config.md` 的每章字數。
   *
   * **兩者都沒有就沒有閾值可比**，那時「有字就算寫夠」——不拿一個猜出來的數字
   * 騙人（比如「一章總得有三千字」）。
   */
  targetWords?: number;
  /**
   * 正文所依據的細綱已經變過：細綱 frontmatter 的 `writtenFrom` 與細綱當前內容的
   * 指紋對不上。**從沒記錄過（作者手寫的正文）就不算**，永不標髒（第 18a 條）。
   */
  upstreamStale: boolean;
  /** 同號的章節檔案存在。 */
  chapterExists: boolean;
  summaryExists: boolean;
  summaryStale: boolean;
  /**
   * 細綱 frontmatter 裡的 `status: done`——作者手工宣佈這一章過了。
   * **只允許向前覆蓋**：推導說 done 時不接受被標成未完成，
   * 否則會出現「檔案明明變了但介面說完成」。
   */
  markedDone: boolean;
}

export function emptyFacts(): PipelineFacts {
  return {
    plotFilled: false,
    words: 0,
    upstreamStale: false,
    chapterExists: false,
    summaryExists: false,
    summaryStale: true,
    markedDone: false,
  };
}

/**
 * 正文的完成度，0..1。判據只有一條，`deriveStage` 與 `deriveProgress` 共用。
 *
 * 目標字數缺席時退化成布林（有字就是 1）——見 `PipelineFacts.targetWords`。
 */
export function manuscriptRatio(f: Pick<PipelineFacts, 'words' | 'targetWords'>): number {
  if (f.words <= 0) {
    return 0;
  }
  if (!f.targetWords || f.targetWords <= 0) {
    return 1;
  }
  return Math.min(1, f.words / (f.targetWords * MANUSCRIPT_DONE_RATIO));
}

/**
 * 當前階段。
 *
 * **先看正文在不在**：沒有正文時，細綱排沒排過決定是寫細綱還是寫正文。
 * 有正文之後：
 *
 * 1. 定稿過（細綱記的 `sourceHash` 對得上正文）或作者宣佈過了 → 完成。**定稿過的章即使細綱後來
 *    改了也不拉回「待寫」**——那是作者已經認可的文字，介面只掛 ⟳ 提醒。定稿之後正文又改過的
 *    回到待定稿（第 23 條：對得上才算寫完），主按鈕就是重新定稿。
 * 2. 細綱在正文之後改過，或正文還沒寫夠 → 寫正文（重寫 / 接著寫）。
 * 3. 其餘 → 待定稿。
 *
 * 老工程裡只有正文、沒有細綱的章走的也是這條：它們有字，於是是「待定稿」或
 * 「已完成」，不會被倒回去要求補細綱。
 */
export function deriveStage(f: PipelineFacts): PlotStage {
  const written = f.chapterExists && f.words > 0;
  if (!written) {
    return f.plotFilled ? 'manuscript' : 'plot';
  }
  if (f.markedDone || (f.summaryExists && !f.summaryStale)) {
    return 'done';
  }
  if (f.upstreamStale || manuscriptRatio(f) < 1) {
    return 'manuscript';
  }
  return 'finalize';
}

export interface PipelineProgress {
  plot: number;
  manuscript: number;
  summary: number;
}

/**
 * 三段完成度，各自 0..1。工程頁的行與創作頁的流水線條直接渲染它。
 *
 * **每一段只報它自己**：沒有細綱就是 0，哪怕正文已經寫完（老工程的章就是這樣）。
 * 從前成品在就把前兩段一律填滿，那是因為「劇情段」與章不是一回事，成品的來源段
 * 常常找不到；一章一綱之後細綱就在同號那個位置，有沒有一眼看得到，不必替它圓。
 */
export function deriveProgress(f: PipelineFacts): PipelineProgress {
  return {
    plot: f.plotFilled ? 1 : 0,
    manuscript: f.chapterExists ? manuscriptRatio(f) : 0,
    summary: f.summaryExists && !f.summaryStale ? 1 : 0,
  };
}

// ---------------------------------------------------------------- 下一步

/**
 * 狀態機算出來的「現在該幹什麼」。創作頁的主按鈕吃這一份（第 20 條）。
 *
 * **與 `deriveStage` 共用同一套判據**，不另發明一套：那邊算出停在哪一層，
 * 這邊把那一層翻譯成一個具體動作。兩處如果各判各的，介面上就會出現
 * 「徽章說待寫正文，按鈕讓你去定稿」。
 */
export interface NextStepPlan {
  stage: CreationStage;
  capability: Capability;
  /** 主按鈕上的字，如「寫第 12 章」。 */
  label: string;
  /** 按鈕下面那句話：為什麼是這一步。 */
  hint: string;
  /**
   * 這一步不是一次模型對話，而是一個工程動作。
   *
   * - 定稿（`finalizeChapter`）：它是工程頁那條既有的「定稿」，不該假裝成一輪對話。
   * - 從已寫正文補齊（`deriveFromText`，拆書 A）：已經有正文、卻缺架構或大綱沒覆蓋到它們。那是十幾到
   *   幾百次呼叫的批次動作，次數在它自己的確認框裡報（要讀定稿過的細綱才算得準），所以這一步不帶 `calls`。
   * - 章號斷了一截（`chapterGap`）：不花錢，彈一個說明框——缺哪幾號、哪幾號重複、怎麼接上。
   */
  projectAction?: 'finalizeChapter' | 'deriveFromText' | 'chapterGap';
  /**
   * 這一步覆蓋的章號區間（閉區間）。大綱一次寫一段區間、細綱一批寫幾章，
   * 按鈕上的「第 21–40 章」與發給後端的範圍都讀它。
   */
  range?: { from: number; to: number };
  /**
   * 這一步落在哪個產物上。**全書層的下一步由純函式給出**（架構、大綱）；
   * 細綱那一檔要一個路徑，而路徑由檔名規則決定、純函式算不出，
   * 於是留空由呼叫方用 `plotPathOfNo` 補。單章的下一步也留空——落點就是那一章。
   */
  target?: CreationTarget;
  /**
   * 這一步要調幾次模型（第 4 條、D16）。主按鈕的提示後面寫出來，動手之前作者就知道。
   * 缺席 = 不是模型呼叫。寫正文那幾步的上限含自動續寫（{@link WRITE_CALLS}）。
   */
  calls?: CallEstimate;
  /**
   * 這一步要先填一張表再動手，而不是點了就跑。目前只有「生成小說配置」：
   * 一句話、總章數、每章字數得作者自己給（W4）。
   */
  form?: 'idea';
  /**
   * 寫正文那幾步怎麼寫（見 {@link WriteMode}）。「接著寫」是追加，「重寫第 N 章」是覆蓋——
   * 兩者按鈕上的字不同、落盤方式也不同，得隨這一步一起帶到後端。「寫第 N 章」不帶：
   * 那一章還沒有正文，寫法由磁碟自己定。修稿（`revise`）只由審稿報告卡發起，永遠不是下一步。
   */
  writeMode?: Exclude<WriteMode, 'write' | 'revise'>;
}

/**
 * 寫正文的三種寫法。**由生成層按磁碟定**（generation/generate.ts 的 `resolveWriteMode`）：
 *
 * | 寫法 | 什麼時候 | 模型寫什麼 | 落盤 |
 * |---|---|---|---|
 * | `write` | 這一章還沒有正文 | 整章 | 新建章節檔案 |
 * | `continue` | 「接著寫」 | 只寫新增的那一段 | 追加在末尾，不審閱（不覆蓋任何東西） |
 * | `rewrite` | 「重寫第 N 章」，或已有正文時在對話裡發「寫正文」 | 整章，上一版作底稿 | 覆蓋，寫入前審閱 |
 * | `revise` | 審稿報告卡上「按勾選的 n 條修稿」（五期） | 整章，**最小改動**，只改勾選的那幾處 | 覆蓋，寫入前審閱 |
 *
 * 從前已有正文時一律追加：對話裡發「寫正文」寫出的是完整一章，追加上去就是兩章疊在一起。
 * 現在只有明說「接著寫」才追加，其餘都當成「按修改意見重做這一章」——與其他各層
 * 「目標已有內容時再生成，作者的話就是修改意見」同一個口徑。
 *
 * `revise` 與 `rewrite` 的差別不在落盤（都是覆蓋審閱），在契約：重寫是「照細綱再寫一章」，
 * 帶著寫正文那一套法則與篇幅合同；修稿是「只改這幾處，其餘一字不動」，那套法則在這裡
 * 只會誘導它重寫。
 */
export type WriteMode = 'write' | 'continue' | 'rewrite' | 'revise';

export function isWriteMode(value: unknown): value is WriteMode {
  return value === 'write' || value === 'continue' || value === 'rewrite' || value === 'revise';
}

// ---------------------------------------------------------------- 呼叫次數

/**
 * 一步要調幾次模型：通常 `low`–`high` 次，出岔子時最多 `max` 次。
 *
 * 為什麼分三個數：結構化產物不合格時會自動修（拆半重試、緊湊重建、轉寫重轉），
 * 那幾次呼叫平時不發生，但作者得在動手之前知道上限在哪（第 4 條），
 * 而只報上限又會把「通常 1 次」的事說得像要調十五次。
 */
export interface CallEstimate {
  low: number;
  high: number;
  max: number;
  /** 上限為什麼比通常多（「沒寫夠時自動續寫……」）。加總時不帶——幾件事的原因拼不成一句話。 */
  why?: string;
}

/** 「預計 1 次呼叫，最多 15 次」。主按鈕提示、確認框、彈窗說明共用這一句。 */
export function describeCalls(c: CallEstimate): string {
  const head = c.low === c.high ? `預計 ${c.low} 次呼叫` : `預計 ${c.low}–${c.high} 次呼叫`;
  const tail = c.max > c.high ? `${head}，最多 ${c.max} 次` : head;
  return c.why ? `${tail}（${c.why}）` : tail;
}

/** 正文寫了多長：這一章寫完後的總字數、目標、這一次新寫的、續寫了幾輪、夠不夠八成。 */
export interface WriteLength {
  words: number;
  target?: number;
  added: number;
  rounds: number;
  /** 到了目標的八成（{@link MANUSCRIPT_DONE_RATIO}）。沒有目標時恆為 true：有字就算寫夠。 */
  reached: boolean;
}

/**
 * 「2980 / 3000 字 · 已達標」「1900 / 3000 字 · 未寫夠（不到目標的八成）」。落盤卡片與氣泡上的
 * 那一行共用這一句（W7）。接著寫時說清是追加：已有多少、新寫多少——作者要知道點下去之後
 * 這一章是多長。
 */
export function describeWriteLength(len: WriteLength, append?: boolean): string {
  const head = len.target ? `${len.words} / ${len.target} 字` : `${len.words} 字`;
  const verdict = len.target ? (len.reached ? ' · 已達標' : ' · 未寫夠（不到目標的八成）') : '';
  const extra = append ? `（已有 ${len.words - len.added} 字，這一次新寫 ${len.added} 字，追加在末尾）` : '';
  return `${head}${verdict}${extra}`;
}

/** 兩份估算加在一起（批次動作的確認框按件加總）。 */
export function addCalls(a: CallEstimate, b: CallEstimate): CallEstimate {
  return { low: a.low + b.low, high: a.high + b.high, max: a.max + b.max };
}

/** 一次就完的那種：前提、世界觀、大綱、定稿時更新細綱。 */
export const ONE_CALL: CallEstimate = { low: 1, high: 1, max: 1 };

/**
 * 正文自動續寫最多幾輪。移植自 AI-Novel-Writer（`generate-draft.command.ts` 的
 * `MAX_AUTO_CONTINUE_ROUNDS`）：「無進展恢復」那一輪也算在這 7 輪裡。
 */
export const MAX_CONTINUE_ROUNDS = 7;

/**
 * 寫一章正文：寫 1 次，設定裡開著「寫完正文刪修飾」（預設開）時再刪一次修飾；不到目標字數的八成、
 * 或被輸出上限截斷時自動續寫，最多再續 {@link MAX_CONTINUE_ROUNDS} 輪（D16：續寫算進呼叫次數，
 * 動手之前寫明）。開關在全域設定裡、這裡是純函式，所以按「1–2 次」報，原因裡說清那一次是什麼。
 */
export const WRITE_CALLS: CallEstimate = {
  low: 1,
  high: 2,
  max: 2 + MAX_CONTINUE_ROUNDS,
  why: `開著刪修飾時寫完再刪 1 次；沒寫夠時自動續寫，最多再續 ${MAX_CONTINUE_ROUNDS} 輪`,
};

/**
 * 寫一章之前比對細綱與前面定稿的連續性事實（`features/plotCheck.ts`）：前面沒有定稿過的章、或者細綱上
 * 記了 `factCheckOk` 時 0 次；比對 1 次、轉寫模型照抄成 JSON 1 次（2026-10-25 起；只寫了「無矛盾」的不轉），
 * 轉寫不合格重轉 1 次。
 */
export const PLOT_CHECK_CALLS: CallEstimate = {
  low: 0,
  high: 2,
  max: 3,
  why: '前面有同步過的章時，寫之前比對一次細綱與既成事實、轉寫模型照抄成 JSON 1 次（沒有矛盾不轉）；轉寫不合格重轉 1 次',
};

/**
 * 小說配置：寫 1 次、轉寫模型照抄成 JSON 1 次（2026-10-25 起改成轉寫）；輸出被截斷時整份重寫 1 次，轉寫不合格重轉 1 次，
 * 「全域要求」不合格時只重寫這一節 1 次（純文字，不轉寫）。與 AI-Novel-Writer 的 `GenerateConfigCommand` 同一套重試
 * （`architecture.command.ts:1033-1123`）。
 */
export const CONFIG_CALLS: CallEstimate = {
  low: 2,
  high: 2,
  max: 5,
  why: '寫 1 次、轉寫模型照抄成 JSON 1 次；被截斷時整份重寫 1 次，轉寫不合格重轉 1 次，「全域要求」不合格只重寫這一節 1 次',
};

/**
 * 定稿一章（敘事線重做，設計稿「三」）：照正文反向更新細綱 1 次（連續性事實的證據用 bigram 找，不調模型），本章出場的人
 * 有角色卡時更新「當前狀態」1 次（D15、D17），敘事線 1–3 次——認事件每次都跑（線是空的也跑：正文裡長出來的線只能在這裡
 * 認出來，設計稿 ⚑6），本章有線動過時更新當前進度 1 次，認出了新線或新伏筆、又有已有的可比時歸併 1 次；故事時間 1 次
 * （2026-10-24 重做：從認事件裡拆出來單獨一次）。所以最少寫 3 次。
 *
 * 2026-10-25 起這幾次都改成轉寫：每寫完一次，轉寫模型照抄成 JSON 1 次（`low` / `high` 各翻一倍），轉寫不合格各重轉 1 次
 * （`max` 再加一份）。模型自己給了 JSON 的不轉，實際只會更少。
 */
export const FINALIZE_CALLS: CallEstimate = {
  low: 6,
  high: 12,
  max: 18,
  why: '照正文更新細綱 1 次；本章出場的人有角色卡時更新角色狀態 1 次；敘事線認事件 1 次，有線動過時更新當前進度 1 次，認出新線或新伏筆時歸併 1 次；故事時間 1 次——寫 3–6 次，每次寫完由轉寫模型照抄成 JSON 1 次（轉寫 3–6 次），轉寫不合格各重轉 1 次',
};

/**
 * 只照正文更新一章的細綱（定稿的第一步；「從已寫正文補齊」先整理細綱用它）：寫 1 次，轉寫模型照抄成 JSON 1 次（2026-10-25 起），
 * 轉寫不合格重轉 1 次。
 */
export const SUMMARIZE_CALLS: CallEstimate = {
  low: 2,
  high: 2,
  max: 3,
  why: '寫 1 次、轉寫模型照抄成 JSON 1 次；轉寫不合格重轉 1 次',
};

/**
 * 敘事線判一章（定稿第三步，敘事線重做四期「從已寫正文補記」按章走它）：認事件 1 次，有線動過時更新當前進度 1 次，認出新線或
 * 新伏筆時歸併 1 次。2026-10-25 起這幾次都改成轉寫：每寫一次，轉寫模型照抄成 JSON 1 次，不合格重轉 1 次（什麼都沒認出、
 * 一條都不併時寫的是「無」，不轉寫，只會更少）。
 */
export const THREADS_JUDGE_CALLS: CallEstimate = {
  low: 2,
  high: 6,
  max: 9,
  why: '認事件寫 1 次，有線動過時寫當前進度 1 次，認出新線或新伏筆時寫歸併 1 次；每寫一次轉寫模型照抄成 JSON 1 次，轉寫不合格重轉 1 次',
};

/**
 * 從情節大綱排敘事線（工程頁「從大綱排出」、批次拆細綱與補記在一條線都沒有時先排的那一次）：排 1 次、轉寫 1 次；
 * 轉寫不合格重轉 1 次（2026-10-25 起改成轉寫，從前 1 次）。
 */
export const THREAD_PLAN_CALLS: CallEstimate = { low: 2, high: 2, max: 3, why: '排 1 次、轉寫模型照抄成 JSON 1 次；轉寫不合格重轉 1 次' };

/** 從已寫正文補記 `n` 章敘事線：每章 {@link THREADS_JUDGE_CALLS}；一條線都沒有、先從情節大綱排一次時加 {@link THREAD_PLAN_CALLS}。 */
export function threadsBackfillCalls(n: number, planFirst: boolean): CallEstimate {
  const plan = planFirst ? THREAD_PLAN_CALLS : { low: 0, high: 0, max: 0 };
  return {
    low: n * THREADS_JUDGE_CALLS.low + plan.low,
    high: n * THREADS_JUDGE_CALLS.high + plan.high,
    max: n * THREADS_JUDGE_CALLS.max + plan.max,
  };
}

/**
 * 審一章：審 1 次、轉寫模型照抄成 JSON 1 次（2026-10-25 起）；輸出被截斷時整份重來 1 次（截斷的那一半不可信，不續接），
 * 沒按格式寫或轉寫沒成時按格式重寫 1 次，每一份原文轉寫不合格各重轉 1 次——審最多 3 次、轉寫最多 4 次。
 * 重試移植自 AI-Novel-Writer `review-chapter.command.ts`（RV:288-367）。
 */
export const REVIEW_CALLS: CallEstimate = {
  low: 2,
  high: 2,
  max: 7,
  why: '審 1 次、轉寫模型照抄成 JSON 1 次；被截斷或不合格時重來，審最多再 2 次，轉寫不合格各重轉 1 次',
};

/**
 * 按審稿意見修稿時，被輸出上限截斷最多再續幾輪。移植自 AI-Novel-Writer 的
 * `refine-from-review.command.ts`（`maxContinuations: 3`，`bounded-completion.ts:11`）。
 * 只看截斷，不看字數：修稿沒有「寫夠」這一說，原稿多長它就該多長。
 */
export const REVISE_CONTINUE_ROUNDS = 3;

/** 按勾選的審稿意見修一章：通常 1 次，被截斷時接著寫，最多再續 {@link REVISE_CONTINUE_ROUNDS} 輪。 */
export const REVISE_CALLS: CallEstimate = {
  low: 1,
  high: 1,
  max: 1 + REVISE_CONTINUE_ROUNDS,
  why: `被輸出上限截斷時接著寫，最多再續 ${REVISE_CONTINUE_ROUNDS} 輪`,
};

/**
 * 寫 1 次、轉寫 1 次的那種（2026-10-25 起改成轉寫）：幹活的模型按格式寫自然語言，轉寫模型照抄成 JSON，轉寫不合格重轉 1 次；
 * 還不行照這一步原來解析失敗的走法（跳過這一批、記失敗），不重寫。更新角色卡與建卡的一批、提取角色、記設定的一章、
 * 按目錄整理的一批都是這一份。
 */
export const TRANSCRIBED_CALLS: CallEstimate = {
  low: 2,
  high: 2,
  max: 3,
  why: '寫 1 次、轉寫模型照抄成 JSON 1 次；轉寫不合格重轉 1 次',
};

/** n 份各 {@link TRANSCRIBED_CALLS}：`each` 是「每批」「每章」那個說法（n 是 1 時不說）。 */
export function transcribedCalls(n: number, each: string): CallEstimate {
  const { low, high, max, why } = TRANSCRIBED_CALLS;
  return { low: n * low, high: n * high, max: n * max, why: `${n > 1 ? each : ''}${why}` };
}

/** 建條目、整合一條最多寫幾輪：交回來的整理不出來時這一條重寫一次。 */
export const LORE_ENTRY_ROUNDS = 2;

/**
 * 建一條設定條目、整合一條（`features/lore.ts`）：寫 1 次、轉寫 1 次（2026-10-25 起改成轉寫），轉寫不合格重轉 1 次；
 * 還整理不出來（沒照格式寫、重轉仍不合格）這一條重寫 1 次、再轉——從前整本重掃時解析不了的條目直接丟了，一次跑下來
 * 少了 7 條。所以上限是 {@link LORE_ENTRY_ROUNDS} 輪 × 3 次。
 */
export const LORE_ENTRY_CALLS: CallEstimate = {
  low: 2,
  high: 2,
  max: LORE_ENTRY_ROUNDS * 3,
  why: '寫 1 次、轉寫模型照抄成 JSON 1 次；轉寫不合格重轉 1 次，還整理不出來這一條重寫 1 次、再轉',
};

/** n 條設定各建（或整合）一次：{@link LORE_ENTRY_CALLS} 乘 n。 */
export function loreEntryCalls(n: number): CallEstimate {
  const { low, high, max, why } = LORE_ENTRY_CALLS;
  return { low: n * low, high: n * high, max: n * max, why };
}

/**
 * 展開一條設定（完善設定，2026-10-19）：寫 1 次、轉寫模型照抄成 JSON 1 次（2026-10-25 起改成轉寫），轉寫不合格重轉 1 次
 * （generation/structured.ts 的 `completeLoreExpand`）。截斷與轉寫不成都不重寫：沒有產物、不給寫入。
 * 右鍵選單、對話頁問要求的那一句與 MCP 報的都是這一份（第 4 條）。
 */
export const LORE_EXPAND_CALLS: CallEstimate = {
  low: 2,
  high: 2,
  max: 3,
  why: '寫 1 次、轉寫模型照抄成 JSON 1 次；轉寫不合格重轉 1 次',
};

/**
 * 落定設定（完善設定二期）：寫 1 次、轉寫 1 次，轉寫不合格重轉 1 次（generation/structured.ts 的 `completeLoreSettle`），
 * 同展開。截斷與轉寫不成都不重寫：沒有產物、不給寫入。命令面板上那一句報的是這一份（第 4 條）。
 */
export const LORE_SETTLE_CALLS: CallEstimate = LORE_EXPAND_CALLS;

/**
 * 批次展開一條（完善設定三期，`features/lore.ts` 的 `expandLoreEntries`）：同一條展開鏈，寫 1 次、轉寫 1 次——轉寫不合格
 * 重轉 1 次（同 {@link LORE_EXPAND_CALLS}）；沒轉成、也沒重轉過的（原文不成樣子、轉寫呼叫失敗），這一條重寫 1 次、再轉寫
 * 1 次（同 {@link LORE_ENTRY_CALLS}：批次沒有氣泡可看，留一段沒整理開的原文沒人收拾）。兩樣不疊加，上限 4 次；被輸出上限
 * 截斷不重寫。
 */
export const LORE_EXPAND_BATCH_CALLS: CallEstimate = {
  low: 2,
  high: 2,
  max: 4,
  why: '寫 1 次、轉寫 1 次；轉寫不合格重轉 1 次，或者整理不出來時這一條重寫、再轉寫 1 次，兩樣不疊加',
};

/** n 條設定各批次展開一次：{@link LORE_EXPAND_BATCH_CALLS} 乘 n。 */
export function loreExpandCalls(n: number): CallEstimate {
  const { low, high, max, why } = LORE_EXPAND_BATCH_CALLS;
  return { low: n * low, high: n * high, max: n * max, why };
}

/**
 * 寫前提醒（完善設定三期，零呼叫、不攔、不進主按鈕）：要寫的章細綱「設定」一節點名、卻還只有一句話的設定（「待完善」的口徑，
 * views/lore.ts 的 `thinLoreFor`）。工作臺正文目標（`本章`）與批次寫章的彈窗、確認框（`區間裡`）同一句；名字最多列 5 個。
 */
export function describeThinLore(scope: '本章' | '区间里', names: readonly string[]): string {
  const list = `${names.slice(0, 5).join('、')}${names.length > 5 ? ` 等 ${names.length} 條` : ''}`;
  return scope === '本章'
    ? `本章要用的 ${list} 還只有一句話，寫之前可以先展開（在工程頁「待完善」裡右鍵「展開…」）。`
    : `區間裡 ${names.length} 條要用到的設定還只有一句話（${list}），寫之前可以先在工程頁「待完善」裡展開；不展開也照寫。`;
}

/**
 * 寫前檢查的敘事線提醒要的數（敘事線二期，設計稿「四、寫前檢查」；復跑之後加了第三類）：由 model/threadFile.ts 的 `threadWatch` 從敘事線現算；
 * 前端批次寫章彈窗從工程頁資料裡拿同一份（`ThreadsView.watch`），與後端確認框同源。
 */
export interface ThreadWatch {
  /** 進行中的線：最近一次實際事件在第幾章、斷了的閾值（`STALL_CHAPTERS`：主線 5 章、其餘 15 章）、哪幾章有計劃事件。 */
  lines: { name: string; kind: string; lastActive: number; stall: number; planned: number[] }[];
  /** 還沒收、寫了計劃回收章的伏筆：計劃第幾章前收、哪幾章計劃收它。 */
  foreshadowing: { name: string; resolve: number; planned: number[] }[];
  /** 還沒埋（狀態「計劃」）、寫了計劃埋的章的伏筆：計劃第幾章埋、哪幾章計劃埋它（復跑之後加的第三類提醒）。 */
  unplanted: { name: string; plant: number; planned: number[] }[];
}

/**
 * 一條提醒：伏筆逾期（寫到第 `at` 章時已經過了第 `resolve` 章）、伏筆計劃埋了卻一直沒埋（寫到第 `at` 章時已經過了計劃埋的
 * 第 `plant` 章），或線斷了（寫到第 `at` 章時已經 `gap` 章沒有實際事件）。
 */
export type ThreadReminder =
  | { kind: 'overdue'; name: string; resolve: number; at: number }
  | { kind: 'unplanted'; name: string; plant: number; at: number }
  | { kind: 'stalled'; name: string; lineKind: string; gap: number; at: number };

/**
 * 寫這幾章之前的三類提醒（零呼叫、不攔人，第 20 條不進主按鈕）。「現在」：寫第 N 章時按第 N − 1 章算（`watch` 按第一章
 * `asOf` 過）。
 *
 * - **伏筆逾期**：寫到某一章時已經過了計劃回收章、還沒收，這幾章的計劃裡也沒安排收它。
 * - **伏筆計劃埋了卻沒埋**（復跑之後加的：「阿婆的真實身份」計劃第 5 章埋，到第 15 章還是「計劃」，兩類提醒都不管）：計劃第
 *   a 章埋，寫第 N 章時 N > a、它還沒埋，這幾章的計劃裡也沒安排埋它。同一條已經報了逾期的不再報這一類。
 * - **線斷了**：進行中的線寫到某一章時已經 K 章沒有實際事件（K 見 `ThreadWatch.lines[].stall`），這幾章的計劃裡也沒推進它。
 *
 * 一章是「本章計劃裡也沒有」；一批幾章是「區間裡都沒有」（安排在區間裡哪一章都算安排過：排細綱時已經定了推遲到哪一章）。
 * 一條只報一次，`at` 是第一個對上的那一章。
 */
export function threadRemindersFor(watch: ThreadWatch | undefined, chapters: readonly number[]): ThreadReminder[] {
  const nos = [...chapters].sort((a, b) => a - b);
  if (!watch || nos.length === 0) {
    return [];
  }
  const first = nos[0];
  const last = nos[nos.length - 1];
  const planned = (list: readonly number[]): boolean => list.some((p) => p >= first && p <= last);
  const out: ThreadReminder[] = [];
  for (const f of watch.foreshadowing) {
    const at = nos.find((n) => n > f.resolve);
    if (at !== undefined && !planned(f.planned)) {
      out.push({ kind: 'overdue', name: f.name, resolve: f.resolve, at });
    }
  }
  // 老資料（工程頁那一份是前端從後端拿的，同一次構建，按理都有）缺這個欄位也不崩（第 1 條）。
  for (const f of watch.unplanted ?? []) {
    const at = nos.find((n) => n > f.plant);
    if (at !== undefined && !planned(f.planned) && !out.some((r) => r.kind === 'overdue' && r.name === f.name)) {
      out.push({ kind: 'unplanted', name: f.name, plant: f.plant, at });
    }
  }
  for (const l of watch.lines) {
    const at = nos.find((n) => n - 1 - l.lastActive >= l.stall);
    if (at !== undefined && !planned(l.planned)) {
      out.push({ kind: 'stalled', name: l.name, lineKind: l.kind, gap: at - 1 - l.lastActive, at });
    }
  }
  return out;
}

/**
 * 敘事線提醒的那一句：對話頁（卡片說明）、工作臺正文目標（`本章`）與批次寫章的彈窗、確認框（`區間裡`）同一句，各類最多列
 * 5 條。`unrecorded` 是還沒定稿的那幾章（敘事線只記定稿過的章，它們裡的推進與回收還沒記上，提醒可能不準）。沒有提醒是空串。
 */
export function describeThreadReminders(
  scope: '本章' | '区间里',
  reminders: readonly ThreadReminder[],
  unrecorded?: { from: number; to: number }
): string {
  if (reminders.length === 0) {
    return '';
  }
  const one = scope === '本章';
  const where = one ? '本章計劃裡' : '區間裡';
  const list = (items: string[]): string => `${items.slice(0, 5).join('；')}${items.length > 5 ? `；等 ${items.length} 條` : ''}`;
  const overdue = reminders.flatMap((r) =>
    r.kind === 'overdue' ? [`伏筆〈${r.name}〉計劃第 ${r.resolve} 章前收，${one ? '還沒收' : `寫到第 ${r.at} 章還沒收`}，${where}也沒安排收`] : []
  );
  const unplanted = reminders.flatMap((r) =>
    r.kind === 'unplanted' ? [`伏筆〈${r.name}〉計劃第 ${r.plant} 章埋，${one ? '還沒埋' : `寫到第 ${r.at} 章還沒埋`}，${where}也沒安排埋`] : []
  );
  const stalled = reminders.flatMap((r) =>
    r.kind === 'stalled'
      ? [`〈${r.name}〉（${traditionalLabel(r.lineKind)}）${one ? `已經 ${r.gap} 章沒有進展` : `寫到第 ${r.at} 章就斷了 ${r.gap} 章`}，${where}也沒安排推進`]
      : []
  );
  const gap = unrecorded
    ? `（第 ${unrecorded.from === unrecorded.to ? unrecorded.from : `${unrecorded.from}–${unrecorded.to}`} 章還沒同步或還沒補記，敘事線還沒記上，提醒可能不準）`
    : '';
  return `敘事線提醒：${[overdue, unplanted, stalled].filter((x) => x.length > 0).map(list).join('；')}${gap}。只是提醒，${one ? '照寫不攔' : '不攔'}。`;
}

/**
 * 敘事線只記到第 `through` 章（敘事線判到第幾章：四期的水位，不超過定稿到）、要寫的是第 `first` 章起：中間還沒記上的那幾章
 * （沒定稿的，或定稿了還沒判的）。沒有缺口是 undefined。提醒的說法裡注一句（{@link describeThreadReminders}）。
 */
export function unrecordedBefore(through: number, first: number): { from: number; to: number } | undefined {
  return through < first - 1 ? { from: through + 1, to: first - 1 } : undefined;
}

/** 角色圖譜的人數上下限與詳情每批幾人（上游 `architecture.command.ts:719-721`）。 */
export const ROSTER_MIN = 3;
export const ROSTER_MAX = 8;
export const ROSTER_DETAIL_BATCH = 3;

/**
 * 角色圖譜：身份清單 1 次 + 詳情每批 3 人，2026-10-25 起每一次寫完都由轉寫模型照抄成 JSON（各 1 次）。
 *
 * 上限：清單截斷重寫 1 次、轉寫不合格重轉 1 次（寫 2 + 轉寫 2）；詳情截斷或轉寫不成時逐批對半拆，n 人最壞是一棵滿二叉樹
 * （寫 2n − 批數 次，每次轉寫 1 次），詳情的轉寫全程再重轉 1 次。8 人時是 2 + 2 + 13 × 2 + 1 = 31。
 */
export function rosterCalls(): CallEstimate {
  const batches = (n: number) => Math.ceil(n / ROSTER_DETAIL_BATCH);
  const detailWrites = 2 * ROSTER_MAX - batches(ROSTER_MAX);
  return {
    low: 2 * (1 + batches(ROSTER_MIN)),
    high: 2 * (1 + batches(ROSTER_MAX)),
    max: 2 + 2 + detailWrites * 2 + 1,
    why: `身份清單寫 1 次、詳情每批 ${ROSTER_DETAIL_BATCH} 人寫 1 次，每次寫完轉寫模型照抄成 JSON 1 次；被截斷或轉寫不成時自動重來、拆小重試`,
  };
}

/** 設定清單的條數上下限與詳情每批幾條（設定名錄）。 */
export const LORE_LIST_MIN = 12;
export const LORE_LIST_MAX = 30;
export const LORE_LIST_DETAIL_BATCH = 6;

/**
 * 設定清單：清單 1 次 + 詳情每批 6 條，寫 1 + ⌈n/6⌉ 次；2026-10-25 起每一次寫完都由轉寫模型照抄成 JSON（各 1 次）。
 *
 * 低 6（12 條）/ 高 12（30 條）。上限照角色圖譜那樣算會是幾十次（30 條逐批對半拆到底），報給作者
 * 嚇人又不真實；這裡封頂 {@link LORE_LIST_CALLS_MAX}：清單截斷或整理不出來重寫 1 次、轉寫不合格重轉，詳情 5 批裡最多
 * 拆半幾批、重轉一次——再壞下去鏈就停（`completeLoreList` 按這個數剎車，轉寫的呼叫也算，第 4 條：說了上限就不越過）。
 */
export function loreListCalls(): CallEstimate {
  const batches = (n: number) => Math.ceil(n / LORE_LIST_DETAIL_BATCH);
  return {
    low: 2 * (1 + batches(LORE_LIST_MIN)),
    high: 2 * (1 + batches(LORE_LIST_MAX)),
    max: LORE_LIST_CALLS_MAX,
    why: `清單寫 1 次、詳情每批 ${LORE_LIST_DETAIL_BATCH} 條寫 1 次，每次寫完轉寫模型照抄成 JSON 1 次；被截斷或轉寫不成時自動重來、拆小重試，最多 ${LORE_LIST_CALLS_MAX} 次`,
  };
}

/**
 * 設定清單一共最多調幾次模型（寫與轉寫都算）。生成鏈到了這個數就不再拆半重試、不再重轉，沒出來的條目只按清單建。
 * 從前 12 次（全是寫）；改成轉寫後每一次寫都多一次轉寫，翻一倍。
 */
export const LORE_LIST_CALLS_MAX = 24;

/**
 * 架構裡寫完要由轉寫模型照抄成 JSON 的那幾件（2026-10-25 起）：配置、角色圖譜、設定清單。前提、世界觀本來就是小節，
 * 不轉寫。確認框據此單列「轉寫」那一行（`askCall` 的 `tasks`）。
 */
export const TRANSCRIBED_SETTINGS: readonly SettingDoc[] = ['config', 'characters', 'lore'];

/** 架構那一件要調幾次：主按鈕、補齊架構的確認框共用這一份。 */
export function settingCalls(doc: SettingDoc): CallEstimate {
  return doc === 'config' ? CONFIG_CALLS : doc === 'characters' ? rosterCalls() : doc === 'lore' ? loreListCalls() : ONE_CALL;
}

/**
 * 一批 n 章細綱（2026-10-25 細綱試點起多一步轉寫）：寫 1 次、轉寫模型照抄成 JSON 1 次。截斷或轉寫不出來時對半拆
 * （滿二叉樹 2n − 1 次）、每章至多一次緊湊重建（n 次），寫細綱的呼叫最多 3n − 1 次；每一次寫完轉寫一次、全程再重轉
 * 一次，轉寫最多 3n 次——上限 6n − 1。拆半與重建的式子同上遊 `blueprint-batch-policy.ts` 的 `planBlueprintGenerationCost`。
 */
export function blueprintCalls(n: number): CallEstimate {
  const k = Math.max(0, Math.floor(n));
  return k === 0
    ? { low: 0, high: 0, max: 0 }
    : { low: 2, high: 2, max: 6 * k - 1, why: '寫 1 次、轉寫模型照抄成 JSON 1 次；被截斷或轉寫不成時自動拆小重試' };
}

/** 單章細綱（寫第 N 章細綱、落定細綱）：寫 1 次、轉寫 1 次；轉寫不合格重轉 1 次。 */
export const PLOT_CALLS: CallEstimate = { low: 2, high: 2, max: 3, why: '寫 1 次、轉寫模型照抄成 JSON 1 次；轉寫不合格重轉 1 次' };

// ---------------------------------------------------------------- 細綱批次

/**
 * 工程頁「批次拆細綱」怎麼切：區間裡跳過已有細綱的章，剩下的按連續段切，
 * 每段再切成 ≤ {@link PLOT_BATCH} 章一批。
 *
 * **前端彈窗的實時說明與後端的確認框用的是這同一個函式**：兩邊各算一遍的話，
 * 彈窗寫著 3 次、實際調了 4 次，正是第 4 條要防的事。
 */
export interface PlotBatchPlan {
  from: number;
  to: number;
  /** 這次要寫的章（區間裡還沒有細綱的）。 */
  chapters: number[];
  /** 已經有細綱、這次跳過的章。 */
  skipped: number[];
  /** 切好的批：每批章號連續、不超過 {@link PLOT_BATCH} 章。 */
  batches: number[][];
  calls: CallEstimate;
}

export function planPlotBatches(input: {
  from: number;
  to: number;
  filledNos: readonly number[];
  /** 一條敘事線都還沒有：開拆之前先從情節大綱排一次（設計稿 ⚑8，加 {@link THREAD_PLAN_CALLS}）。 */
  planThreads?: boolean;
}): PlotBatchPlan {
  const from = Math.max(1, Math.floor(Math.min(input.from, input.to)));
  const to = Math.max(from, Math.floor(Math.max(input.from, input.to)));
  const filled = new Set(input.filledNos);
  const chapters: number[] = [];
  const skipped: number[] = [];
  const batches: number[][] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length > 0) {
      batches.push(run);
      run = [];
    }
  };
  for (let no = from; no <= to; no++) {
    if (filled.has(no)) {
      skipped.push(no);
      flush();
      continue;
    }
    chapters.push(no);
    run.push(no);
    if (run.length === PLOT_BATCH) {
      flush();
    }
  }
  flush();
  // 一條敘事線都還沒有時，開拆之前先從情節大綱排一次（排 1 次、轉寫 1 次，沒有要拆的就不排）。
  const threads = batches.length > 0 && input.planThreads === true ? THREAD_PLAN_CALLS : { low: 0, high: 0, max: 0 };
  const calls = batches.map((b) => blueprintCalls(b.length)).reduce(addCalls, threads);
  return { from, to, chapters, skipped, batches, calls };
}

// ---------------------------------------------------------------- 批次寫章

/**
 * 批次寫章「寫完即定稿」時，全文大綱落後這麼多章就增量更新一次（1 次呼叫：舊的那一份 + 之後各章定稿過的細綱）。
 * 百章實驗裡全文大綱從沒生成過：它要作者手動點「重建」。
 */
export const GLOBAL_SUMMARY_EVERY = 10;

/** 批次寫章預設寫幾章（W9）。 */
export const WRITE_BATCH_DEFAULT = 3;
/** 批次寫章一次最多幾章（W9，上游 `batch-chapter-workflow.ts` 的 1–10 章）。 */
export const WRITE_BATCH_MAX = 10;

/**
 * 批次寫章的兩種模式：`draft` 只寫正文；`finalize` 寫完一章就定稿，再寫下一章（D17：
 * 自動定稿只在這裡）。
 */
export type WriteBatchMode = 'draft' | 'finalize';

export function isWriteBatchMode(value: unknown): value is WriteBatchMode {
  return value === 'draft' || value === 'finalize';
}

/**
 * 批次寫章怎麼切。**前端彈窗的實時說明與後端的確認框用的是這同一個函式**（第 4 條）。
 */
export interface WriteBatchPlan {
  from: number;
  to: number;
  mode: WriteBatchMode;
  /** 寫完一章先審一遍（五期補遺 §4）：報告進一個新會話，審出問題不停。 */
  review: boolean;
  /** 這次要寫的章，按章號升序、嚴格序列。 */
  chapters: number[];
  /** 已經有正文、這次跳過的章（批次只補空白，第 19 條）。 */
  skipped: number[];
  /**
   * 這次要寫、但還沒有細綱的章，按連續段每 {@link PLOT_BATCH} 章切成批：寫到每批的第一章時先拆這一批。
   */
  plotBatches: number[][];
  /** 寫完即定稿時，在哪幾章定稿之後更新一次全文大綱（{@link GLOBAL_SUMMARY_EVERY}）。 */
  globalSummaryAt: number[];
  /**
   * 區間裡第一章沒有細綱、又超出情節大綱覆蓋的章號：批次在它前面收住。後面的章要接著它的結尾寫，
   * 跳過它去寫只會寫出一段接不上的正文。
   */
  stopAt?: number;
  calls: CallEstimate;
}

/**
 * 區間裡已有正文的章跳過；最多 {@link WRITE_BATCH_MAX} 章（超出的部分不寫，呼叫方據此報錯或截短）。
 *
 * **邊寫邊拆細綱**：沒有細綱、但在情節大綱覆蓋之內（`outlineCoverage`）的章照樣排進來，寫到它時先拆
 * 這一批（`plotBatches`，連續的空白章每 {@link PLOT_BATCH} 章一批）——拆的時候前面各章已經寫完、定稿，
 * 細綱看得見既成事實。百章實驗一次拆完一百章細綱再寫，第 10 章寫死的人第 26 章的細綱照排。超出大綱
 * 覆蓋的第一章在它前面收住（`stopAt`）：沒有大綱，細綱就是憑空編。
 *
 * 呼叫次數按件加總：一章 {@link WRITE_CALLS} + 寫前比對 {@link PLOT_CHECK_CALLS}，寫完即審稿再加
 * {@link REVIEW_CALLS}，寫完即定稿再加 {@link FINALIZE_CALLS}；每批細綱 {@link blueprintCalls}。
 */
export function planWriteBatch(input: {
  from: number;
  to: number;
  mode: WriteBatchMode;
  review?: boolean;
  writtenNos: readonly number[];
  plotFilledNos: readonly number[];
  /** 情節大綱覆蓋到第幾章（`outlineCoverage`）。缺席等於 0：沒細綱的章一律收住。 */
  outlineCoverage?: number;
  /** 全文大綱覆蓋到第幾章（寫完即定稿時據此排更新全文大綱的那幾次）。缺席等於 0。 */
  globalSummaryThrough?: number;
}): WriteBatchPlan {
  const from = Math.max(1, Math.floor(Math.min(input.from, input.to)));
  const to = Math.max(from, Math.floor(Math.max(input.from, input.to)));
  const written = new Set(input.writtenNos);
  const filled = new Set(input.plotFilledNos);
  const coverage = input.outlineCoverage ?? 0;
  const chapters: number[] = [];
  const skipped: number[] = [];
  const plotBatches: number[][] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length > 0) {
      plotBatches.push(run);
      run = [];
    }
  };
  let stopAt: number | undefined;
  for (let no = from; no <= to; no++) {
    if (written.has(no)) {
      skipped.push(no);
      flush();
      continue;
    }
    if (chapters.length === WRITE_BATCH_MAX) {
      break;
    }
    if (!filled.has(no)) {
      if (no > coverage) {
        stopAt = no;
        break;
      }
      run.push(no);
      if (run.length === PLOT_BATCH) {
        flush();
      }
    } else {
      flush();
    }
    chapters.push(no);
  }
  flush();
  const review = input.review === true;
  const each = [WRITE_CALLS, PLOT_CHECK_CALLS, ...(review ? [REVIEW_CALLS] : []), ...(input.mode === 'finalize' ? [FINALIZE_CALLS] : [])].reduce(addCalls);
  const writing = chapters.reduce<CallEstimate>((sum) => addCalls(sum, each), { low: 0, high: 0, max: 0 });
  // 寫完即定稿：全文大綱落後 {@link GLOBAL_SUMMARY_EVERY} 章就在那一章定稿之後更新一次。
  const globalSummaryAt: number[] = [];
  if (input.mode === 'finalize') {
    let through = input.globalSummaryThrough ?? 0;
    for (const no of chapters) {
      if (no - through >= GLOBAL_SUMMARY_EVERY) {
        globalSummaryAt.push(no);
        through = no;
      }
    }
  }
  const calls = [
    ...plotBatches.map((b) => blueprintCalls(b.length)),
    ...globalSummaryAt.map(() => ONE_CALL),
  ].reduce(addCalls, writing);
  return {
    from,
    to,
    mode: input.mode,
    review,
    chapters,
    skipped,
    plotBatches,
    globalSummaryAt,
    ...(stopAt !== undefined ? { stopAt } : {}),
    calls,
  };
}

/** 推導單章下一步所需的事實。 */
export interface NextStepFacts {
  /** 章號。按鈕上要說「寫第 12 章」。 */
  no: number;
  /** 正文字數。0 = 還沒開始寫。 */
  words: number;
  /** 正文寫到目標字數的比例，`manuscriptRatio` 算出來的那一份。 */
  ratio: number;
  /** 細綱在正文寫完之後改過。 */
  upstreamStale: boolean;
}

export function deriveNextStep(stage: PlotStage, f: NextStepFacts): NextStepPlan | undefined {
  switch (stage) {
    case 'plot':
      return {
        stage: 'plot',
        capability: 'generate',
        label: `寫第 ${f.no} 章細綱`,
        hint: '先把這一章要發生什麼定下來：梗概、出場人物、關鍵事件、看點。',
        calls: PLOT_CALLS,
      };

    case 'manuscript':
      // 細綱改過而正文沒跟上：要的是拿新細綱重做一版，不是往後接著寫。
      if (f.upstreamStale && f.words > 0) {
        return {
          stage: 'manuscript',
          capability: 'generate',
          label: `重寫第 ${f.no} 章`,
          hint: '細綱改過，現有正文可能已經與它對不上。照新細綱重寫，寫入前會讓你先對比。',
          writeMode: 'rewrite',
          calls: WRITE_CALLS,
        };
      }
      // 寫過一部分但還沒寫夠：說清是「接著寫」而不是「重新寫一遍」——
      // 落盤走的是追加，作者點下去不會丟掉前面那幾千字。
      if (f.words > 0) {
        return {
          stage: 'manuscript',
          capability: 'generate',
          label: '接著寫',
          hint: `第 ${f.no} 章寫了 ${f.words} 字，還沒寫夠（約 ${Math.round(f.ratio * 100)}%）。` +
            '接著往下寫，新寫的會追加在末尾。',
          writeMode: 'continue',
          calls: WRITE_CALLS,
        };
      }
      return {
        stage: 'manuscript',
        capability: 'generate',
        label: `寫第 ${f.no} 章`,
        hint: '細綱已經定好了，這一步把它寫成小說。',
        calls: WRITE_CALLS,
      };

    case 'finalize':
      return {
        // 停在正文層：定稿讀的是正文，作者點開看的也是那份正文。
        stage: 'manuscript',
        capability: 'generate',
        projectAction: 'finalizeChapter',
        label: `同步第 ${f.no} 章`,
        hint:
          '正文寫夠了。同步會照正文更新這一章的細綱與連續性事實，把本章出場角色的當前狀態更新到這一章，' +
          '再認這一章在敘事線上發生了什麼——' +
          '後面幾百章靠它們記住這裡發生過什麼。',
        calls: FINALIZE_CALLS,
      };

    // 都做完了就不催這一章——呼叫方會轉去問全書的下一步（下一章）。
    case 'done':
      return undefined;
  }
}

// ---------------------------------------------------------------- 全書狀態

/** 情節大綱一次寫多少章。一次寫一百章的大綱，後半段會稀得像目錄（D20）。 */
export const OUTLINE_BATCH = 20;

/** 細綱一批寫幾章。一批裡有前後因果，又不至於長到後幾章潦草。 */
export const PLOT_BATCH = 5;

/**
 * 整本書走到哪一步。與 `PlotStage` 同構，只是粒度是全書。
 *
 * `writing` 的意思是「全書層沒有要做的了，去做第 N 章」——那一章該做什麼由
 * 單章狀態機說（`deriveNextStep`）。
 */
export type BookStage = 'setting' | 'outline' | 'plots' | 'writing' | 'complete';

export interface BookFacts {
  /**
   * 架構五件各自填過沒有（角色圖譜 = 至少有一張角色卡；設定清單 = 至少有一條設定條目，或者已經有正文，
   * 見 {@link isLoreListFilled}）。
   */
  settings: Record<SettingDoc, boolean>;
  /** 情節大綱寫過：至少認得出一章（舊格式的區間分節不認）。 */
  outlineFilled: boolean;
  /** 情節大綱覆蓋到第幾章（model/outlineFile.ts 的 `outlineCoverage`）：最大的章號，沒寫過是 0。 */
  outlineCoverage: number;
  /** `config.md` 的總章數。沒寫就沒有「寫完了」這一說。 */
  totalChapters?: number;
  /**
   * 下一個該寫的章：從第 1 章起**連續**有正文的最大章號 + 1。
   *
   * 連續才算：第 1、2、5 章有正文時，下一個該寫的是第 3 章——跳著寫是作者的
   * 自由，但主按鈕只推一個，推的應該是那個缺口。
   */
  nextChapterNo: number;
  /**
   * 第 {@link nextChapterNo} 章之後還有正文：中間斷了一截（見 {@link ChapterGap}）。
   * 只在缺口後面確實有已寫的章時才有。
   */
  gap?: ChapterGap;
  /** 那一章有排好的細綱。 */
  nextPlotFilled: boolean;
  /**
   * 排好細綱的全部章號。拆細綱的區間要在第一份已有細綱之前收住：主按鈕那一批
   * 永遠是空白的章，不會把作者排過的章圈進來再問一遍要不要覆蓋。
   */
  plotFilledNos: readonly number[];
}

/**
 * 已寫的正文中間斷了一截：第 from–to 章沒有正文，後面卻還有 `later` 章寫到第 `last` 章。
 *
 * 多半不是真沒寫，是檔名開頭的章號沒接上（匯入的原稿換過編號、一章拆成兩個檔案）。
 * 照「連續寫到第 from−1 章」往下排，大綱與補齊會把缺口後面那幾十章當成沒寫過、從架構重新編。
 */
export interface ChapterGap {
  from: number;
  to: number;
  /** 缺口之後有正文的章數。 */
  later: number;
  /** 有正文的最大章號。 */
  last: number;
}

/**
 * 判據自上而下取第一個不滿足的：
 *
 * 1. 架構五件缺哪件 → 按順序生成（每一件都吃前面幾件）；
 * 2. 寫滿了總章數 → 完成；
 * 3. 大綱缺失，或下一章已經超出大綱的覆蓋 → 生成 / 續寫大綱；
 * 4. 下一章沒有細綱 → 拆細綱；
 * 5. 否則 → 去寫那一章。
 *
 * 老工程（有幾十章正文、從沒有過架構）會被推回第 1 條：新鏈路寫正文要讀前提、角色與世界觀，
 * 沒有它們上下文就是空的。**下一步換成「從已寫正文補齊」**（拆書 A，`deriveBookNextStep`）——
 * 從前（D11）推的是「生成小說配置」，那會憑一句話編出一套與已寫正文無關的設定。
 */
export function deriveBookStage(f: BookFacts): BookStage {
  if (SETTING_DOCS.some((doc) => !f.settings[doc])) {
    return 'setting';
  }
  if (f.totalChapters && f.nextChapterNo > f.totalChapters) {
    return 'complete';
  }
  if (!f.outlineFilled || f.nextChapterNo > f.outlineCoverage) {
    return 'outline';
  }
  if (!f.nextPlotFilled) {
    return 'plots';
  }
  return 'writing';
}

/** 架構五件各自那句「為什麼是這一步」。 */
const SETTING_HINT: Record<SettingDoc, string> = {
  config: '先把這個腦洞展開成一份小說配置：型別、賣點、主角、金手指，以及全書寫多少章、每章多少字。',
  premise: '從配置裡提煉故事前提：一句話前提、核心衝突鏈、爽點迴圈、懸念骨架。',
  characters: '按前提排出角色圖譜：主角、盟友、對手，以及他們之間的關係。',
  world: '把世界觀立起來：規則與它的漏洞、階層與資源、深層危機。',
  lore: '把世界觀裡點到的地點、勢力、能力體系、關鍵物品排成一份設定清單，每樣建一條設定條目。',
};

/** 「第 3 章」或「第 3–7 章」。 */
function rangeText(from: number, to: number): string {
  return from === to ? `第 ${from} 章` : `第 ${from}–${to} 章`;
}

/**
 * 全書級的下一步。`writing` 與 `complete` 返回 undefined：前者交給第 N 章的單章
 * 狀態機，後者就是沒有下一步。
 *
 * `plots` 那一檔的 target 留空，由呼叫方補上第 N 章細綱的路徑（見 `NextStepPlan.target`）。
 *
 * **已經寫過正文的章不再往前規劃**：第 1 章起連續有正文（`nextChapterNo > 1`）時，缺架構、或大綱還沒覆蓋到
 * 已寫的章，下一步是「從已寫正文補齊」——照著寫成的東西整理，而不是從一句話、從結構指導重新編一遍。
 * 已寫的正文中間斷了一截（`gap`）時，這兩檔都先推「把章號接上」，見 `gapStep`。
 */
export function deriveBookNextStep(stage: BookStage, f: BookFacts): NextStepPlan | undefined {
  switch (stage) {
    case 'setting': {
      const doc = SETTING_DOCS.find((d) => !f.settings[d]) ?? 'config';
      if (f.gap) {
        return gapStep(f.gap, { kind: 'setting', doc });
      }
      if (f.nextChapterNo > 1) {
        return deriveStep(f, `還缺${SETTING_DOC_LABEL[doc]}`, { kind: 'setting', doc });
      }
      return {
        stage: 'setting',
        capability: 'generate',
        label: `生成${SETTING_DOC_LABEL[doc]}`,
        hint: SETTING_HINT[doc],
        target: { kind: 'setting', doc },
        calls: settingCalls(doc),
        // 配置要作者先給一句話和規模，點了是開啟表單而不是直接傳送。
        ...(doc === 'config' ? { form: 'idea' as const } : {}),
      };
    }

    case 'outline': {
      if (f.gap) {
        return gapStep(f.gap, { kind: 'outline' });
      }
      const { from, to } = outlineNextRange(f);
      // 情節大綱是各章細綱梗概的彙總：寫過的章沒有細綱，大綱裡就沒有它們那一條——補齊先給它們整理細綱（帶梗概）。
      if (from < f.nextChapterNo) {
        return deriveStep(
          f,
          from === 1 ? '還沒有細綱，情節大綱（各章細綱梗概的彙總）也就是空的' : `${rangeText(from, f.nextChapterNo - 1)}還沒有細綱，情節大綱只覆蓋到第 ${from - 1} 章`,
          { kind: 'outline' }
        );
      }
      const verb = f.outlineFilled ? '續寫' : '生成';
      return {
        stage: 'outline',
        capability: 'generate',
        label: `${verb}情節大綱（${rangeText(from, to)}）`,
        hint: f.outlineFilled
          ? `大綱只覆蓋到第 ${f.outlineCoverage} 章，接下來要寫的第 ${f.nextChapterNo} 章還沒有著落。`
          : '按故事結構把全書的走向排出來，一章一條。一次寫一段，後面的等寫到了再續。',
        target: { kind: 'outline' },
        range: { from, to },
        calls: ONE_CALL,
      };
    }

    case 'plots': {
      const from = f.nextChapterNo;
      const cap = Math.min(from + PLOT_BATCH - 1, f.totalChapters ?? Infinity, f.outlineCoverage);
      // 連續的空白章，遇到第一份已有細綱就收住（見 `BookFacts.plotFilledNos`）。
      const filled = new Set(f.plotFilledNos);
      let to = from;
      while (to + 1 <= cap && !filled.has(to + 1)) {
        to++;
      }
      return {
        stage: 'plot',
        capability: 'generate',
        label: `拆細綱（${rangeText(from, to)}）`,
        hint: '從情節大綱裡把接下來幾章拆成一章一份的細綱：梗概、出場人物、關鍵事件、看點。',
        range: { from, to },
        calls: blueprintCalls(to - from + 1),
      };
    }

    case 'writing':
    case 'complete':
      return undefined;
  }
}

/**
 * 續寫情節大綱接著排哪幾章：從大綱排到的下一章起，一次 {@link OUTLINE_BATCH} 章，不超過總章數；還沒有大綱從第 1 章起。
 * 主按鈕（全書那一檔的 `outline`）、`/續寫大綱` 與工程頁的「續寫大綱」都按這一份排。
 */
export function outlineNextRange(
  f: Pick<BookFacts, 'outlineFilled' | 'outlineCoverage' | 'totalChapters'>
): { from: number; to: number } {
  const from = f.outlineFilled ? f.outlineCoverage + 1 : 1;
  return { from, to: Math.max(from, Math.min(from + OUTLINE_BATCH - 1, f.totalChapters ?? Infinity)) };
}

/**
 * 作者自己點的續寫大綱（`/續寫大綱`、工程頁右鍵）：續哪幾章，續不了時說為什麼。
 *
 * 主按鈕推到續寫那一步時狀態機已經保證續得了；作者自己點的可能在任何時候，兩種情況不調模型：
 *
 * - 大綱已經排到全書最後一章——沒有可續的；
 * - 要續的那一段裡已經有寫過的正文（大綱沒覆蓋到已寫的章，或已寫的正文中間斷了一截）——寫過的章該照正文整理細綱
 *   （「從已寫正文補齊」），不是往前編一條計劃（同主按鈕的 `deriveStep`）。
 */
export function outlineContinuation(f: BookFacts): { range: { from: number; to: number } } | { blocked: string } {
  const range = outlineNextRange(f);
  if (f.totalChapters && range.from > f.totalChapters) {
    return {
      blocked: `情節大綱已經排到第 ${f.outlineCoverage} 章，全書共 ${f.totalChapters} 章，沒有可續的了。要往後加章，先在小說配置裡把總章數改大。`,
    };
  }
  const lastWritten = f.gap?.last ?? f.nextChapterNo - 1;
  if (range.from <= lastWritten) {
    return {
      blocked:
        `${range.from === 1 ? '還沒有情節大綱' : `情節大綱只排到第 ${range.from - 1} 章`}，` +
        `可${rangeText(range.from, lastWritten)}裡已經有正文。寫過的章該照正文整理細綱（梗概就是大綱那一條），` +
        '不是往前編：先在工程頁「故事架構」右鍵「從已寫正文補齊…」，再續寫。',
    };
  }
  return { range };
}

/**
 * 「從已寫正文補齊」那一步（拆書 A）。不帶 `calls`：次數要讀定稿過的細綱才算得準，由 features/derive.ts 的
 * 確認框在動手之前報（第 4 條）——點主按鈕本身不花錢。
 */
function deriveStep(f: BookFacts, missing: string, target: CreationTarget): NextStepPlan {
  const through = f.nextChapterNo - 1;
  return {
    stage: target.kind === 'outline' ? 'outline' : 'setting',
    capability: 'generate',
    label: '從已寫正文補齊…',
    hint:
      `已經寫了${rangeText(1, through)}，${missing}。照已寫正文把細綱（梗概就是情節大綱那一條）、角色卡與架構整理出來（只補空白），` +
      '再接著往下寫；動手之前會先列出要調幾次模型。',
    target,
    projectAction: 'deriveFromText',
  };
}

/**
 * 正文中間斷了一截（{@link ChapterGap}）時，架構與大綱那兩檔換成這一步：先把章號接上。
 *
 * 照「寫到第 from−1 章」去補齊或續寫大綱，缺口後面那幾十章都會被當成沒寫過——補齊只整理前一截，
 * 續寫從架構重新編。所以不推花錢的那一步，推的是一個說明框（缺哪幾號、哪幾號重複、怎麼接上）。
 */
function gapStep(gap: ChapterGap, target: CreationTarget): NextStepPlan {
  return {
    stage: target.kind === 'outline' ? 'outline' : 'setting',
    capability: 'generate',
    label: `${rangeText(gap.from, gap.to)}缺正文…`,
    hint:
      `後面還有 ${gap.later} 章已寫（寫到第 ${gap.last} 章），中間這一截沒有正文，多半是檔名開頭的章號沒接上。` +
      `不接上的話，補齊與大綱只認得${gap.from > 1 ? rangeText(1, gap.from - 1) : '前面'}，後面那些會被當成沒寫過。` +
      '先把章號接上（改檔名開頭的數字），或者把這幾章補寫出來。',
    target,
    projectAction: 'chapterGap',
  };
}
