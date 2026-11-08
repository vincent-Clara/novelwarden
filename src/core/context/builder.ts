/**
 * 上下文裝配器。
 *
 * 這裡只剩三件事：**算預算、按配方跑一遍層、把存活的條目拼成 messages**。
 * 「帶什麼」在 [recipes.ts](recipes.ts)，「怎麼取」在 [layers/](layers/index.ts)。
 *
 * 裝配順序即優先順序：配方靠前的層先拿預算，靠後的可能被降級或丟棄。
 * 任何裝不下的條目都會以 dropped/degraded 的形式留在 items 裡——
 * **絕不靜默丟棄**，作者需要知道這次沒帶上什麼。
 */
import { ChatMessage } from '../llm/provider';
import { contextLimitsOf, normalizeContextDetail } from '../model/contextDetail';
import { NovelProject } from '../model/project';
import { NovelConfig } from '../model/types';
import { STORY_TIME_LABEL } from '../model/timelineFile';
import { estimateTokens } from './tokenizer';
import { LAYERS, resolveFocus, type Assembly } from './layers';
import { promptFactsOf } from './layers/dialog';
import { PromptFacts, askHeading, buildOutputContract } from './prompts';
import { recipeFor } from './recipes';
import { BuildRequest, BuiltContext, ContextItem, ItemKind } from './types';
import { nextWritableChapterNo } from '../views/pipeline';

export * from './types';

const SAFETY_MARGIN = 512;

export async function buildContext(
  project: NovelProject,
  requested: BuildRequest,
  config: NovelConfig
): Promise<BuiltContext> {
  const request = await settingFromText(project, requested);
  const excluded = new Set(request.excludedIds ?? []);
  const items: ContextItem[] = [];

  const hardLimit = Math.min(
    config.contextWindow,
    request.providerMaxInputTokens ?? Number.POSITIVE_INFINITY
  );
  const budget = Math.max(1000, hardLimit - config.maxOutputTokens - SAFETY_MARGIN);
  const budgetClampedByProvider =
    request.providerMaxInputTokens !== undefined && request.providerMaxInputTokens < config.contextWindow;

  const recipe = recipeFor(request.action.stage, request.action.capability, request.step, request.writeMode);
  const detail = normalizeContextDetail(config.contextDetail);
  const limits = contextLimitsOf(config);
  const [focus, book] = await Promise.all([resolveFocus(project, request, recipe, limits), project.readBookConfig()]);

  const assembly: Assembly = {
    project,
    request,
    config,
    detail,
    limits,
    focus,
    book,
    budget,
    remaining: budget,
    items,
    excluded,

    /** 嘗試把一條內容放進預算。放不下就按 note 記為 dropped。 */
    admit(item, opts = {}) {
      if (excluded.has(item.id)) {
        const rejected: ContextItem = { ...item, text: '', tokens: 0, status: 'excluded', note: '已被手動排除' };
        items.push(rejected);
        return rejected;
      }
      const tokens = estimateTokens(item.text);
      if (!opts.force && tokens > assembly.remaining) {
        const dropped: ContextItem = {
          ...item,
          text: '',
          tokens: 0,
          status: 'dropped',
          note: `預算不足（需 ${tokens} token，剩 ${Math.max(0, assembly.remaining)}）`,
        };
        items.push(dropped);
        return dropped;
      }
      assembly.remaining -= tokens;
      const included: ContextItem = { ...item, tokens, status: 'included' };
      items.push(included);
      return included;
    },

    accept(item, tokens) {
      assembly.remaining -= tokens;
      items.push({ ...item, tokens });
    },

    reject(item, status, note) {
      items.push({ ...item, text: '', tokens: 0, status, note });
    },

    scratch: { evidence: new Map<number, ContextItem>() },
  };

  // 強制項可能已經吃掉全部預算，後續條目自然會被判 dropped——這是有意的：
  // 系統提示、使用者這句話、本層產物本來就比「早前第 3 章的細綱」重要。
  for (const spec of recipe) {
    await LAYERS[spec.layer](assembly, spec);
  }

  const messages = assembleMessages(items, request, promptFactsOf(assembly));
  const usedTokens = items.reduce((sum, i) => sum + i.tokens, 0);

  return { messages, items, usedTokens, budget, budgetClampedByProvider, detail };
}

// ---------------------------------------------------------------- 組裝

/**
 * 條目 → messages。
 *
 * 段落順序即「讀的順序」：背景知識在前，本層產物在中間，使用者這一輪的要求
 * 與輸出契約壓在最後——模型對末尾的指令最敏感，把「現在請你做什麼」放在
 * 十萬字前文之前，等於讓它讀完全書再回頭猜要幹嘛。
 */
function assembleMessages(
  items: ContextItem[],
  request: BuildRequest,
  facts: PromptFacts
): ChatMessage[] {
  const live = items.filter((i) => (i.status === 'included' || i.status === 'degraded') && i.text.trim());
  const pick = (kind: ItemKind): ContextItem[] => live.filter((i) => i.kind === kind);
  const join = (list: ContextItem[]): string => list.map((i) => i.text.trim()).join('\n\n');

  const { stage, capability } = request.action;
  /** 正文出稿：只有這一種情況才談「接下去寫」「目標字數」。 */
  const writing = stage === 'manuscript' && capability === 'generate';
  /** 審稿（五期）：幾段材料的標題要說清哪些是已經發生的事、哪些不是。 */
  const reviewing = capability === 'review';
  /** 按審稿意見修稿（五期）。 */
  const revising = writing && request.writeMode === 'revise';

  const messages: ChatMessage[] = [];
  const system = pick('system')[0];
  if (system) {
    messages.push({ role: 'system', content: system.text });
  }

  // 歷史對話作為真正的多輪訊息發出，而不是塞進一段文字裡——
  // 模型對 role 交替的理解遠好於「以下是我們之前的對話」。
  const historyById = new Map((request.history ?? []).map((t) => [`history:${t.id}`, t]));
  for (const item of pick('history')) {
    const turn = historyById.get(item.id);
    if (turn) {
      messages.push({ role: turn.role, content: item.text });
    }
  }

  const sections: string[] = [];
  const section = (heading: string, list: ContextItem[]): void => {
    if (list.length > 0) {
      sections.push(`${heading}\n\n${join(list)}`);
    }
  };

  // 寫作技能排在最前面（上游 `base-command.ts:63` 同樣拼在第一條使用者訊息的開頭）：它是補充的
  // 寫作方法，自帶一句「作者事實和後續輸出合同始終優先」，後面的每一節都比它說了算。
  const skillBlock = pick('skill')[0];
  if (skillBlock) {
    sections.push(skillBlock.text.trim());
  }

  section('# 文風指南（務必貼合）', pick('style'));
  section('# 全域要求（每一章都要遵守）', pick('guidance'));
  section('# 故事架構', pick('setting'));
  section('# 全文大綱', pick('globalSummary'));
  section('# 情節大綱', pick('outlineDoc'));
  section('# 故事結構指導', pick('guide'));
  section('# 相關角色設定', pick('character'));
  // 設定（設定名錄）：整條帶的在前、空行隔開；只帶一句話的併成一張清單跟在後面，一行一條。
  const loreItems = pick('lore');
  const loreLines = loreItems.filter((i) => i.text.trimStart().startsWith('- '));
  const loreFull = loreItems.filter((i) => !loreLines.includes(i));
  if (loreItems.length > 0) {
    const parts = [
      join(loreFull),
      loreLines.length > 0
        ? `其餘相關設定（只列一句話；提到它們時沿用這些名字）：\n${loreLines.map((i) => i.text.trim()).join('\n')}`
        : '',
    ].filter(Boolean);
    sections.push(`# 相關世界觀設定\n\n${parts.join('\n\n')}`);
  }
  // 細綱與正文都由遠及近排列，讀起來是正序的時間線。寫正文時只帶前幾章（`plotPrev`），不再帶更早幾十章。
  section('# 前幾章細綱（前情，不要在本章重演；標「計劃」的還沒定稿，不一定是正文寫成的樣子）', pick('plotSummary'));
  // 證據原文排在細綱後面、前文正文前面：讀的時候是「細綱這麼說 → 原文是這樣寫的 → 緊挨著的那幾章」。
  // 說法移植自上游 chapter-materials.ts:223-227（「索引、摘要和 currentState 都不是作者事實」）。
  section(
    '# 定稿原文片段（前情以這些原文為準；細綱、角色狀態與它有出入時信原文）',
    pick('evidence').slice().sort(byNoAsc)
  );
  // 審稿對照的前情：上游標的是「已確認定稿歷史｜唯一已發生事實源」（RV:212-227）。
  section('# 前幾章的連續性事實（已定稿，已經發生的事）', pick('facts').slice().sort(byNoAsc));

  // 敘事線（敘事線重做）：一條一行，按要緊程度排（層裡排好了，不按章號）。排在前情後面、前文正文前面：
  // 讀的時候是「前面發生了什麼 → 哪幾條線還開著 → 緊挨著的那幾章」。說法的後半句是這一層存在的
  // 另一半理由——模型知道第 18 章要揭開什麼，寫第 3 章時最順手的就是提前揭開。審稿只帶伏筆那一半，換個說法。
  // 拆細綱（敘事線二期）：線在前、沒收的伏筆另起一段（標籤是「伏筆 · 」的那幾條），標題說清這一節是拿來照著排的。
  // 故事時間（2026-10-24）：敘事線那一層登記的一條，單獨成一節、放在敘事線前面——日期是從時間線現算的，模型照著接、不用自己算。
  const storyTime = pick('thread').filter((i) => i.label === STORY_TIME_LABEL);
  if (storyTime.length > 0) {
    sections.push(`# 故事時間（日期由前文推算，照著接，不要和前面打架）\n\n${storyTime.map((i) => i.text.trim()).join('\n')}`);
  }
  const threadLines = pick('thread').filter((i) => i.label !== STORY_TIME_LABEL);
  if (threadLines.length > 0 && stage === 'plot') {
    const lines = threadLines.filter((i) => !i.label.startsWith('伏筆 · '));
    const fores = threadLines.filter((i) => i.label.startsWith('伏筆 · '));
    sections.push(
      [
        '# 敘事線（照著排：該推進的線推進、該收的伏筆安排在某一章收；沒到回收章的不要提前揭開，還沒到開始那一章的線不要提前開）',
        lines.length > 0 ? lines.map((i) => i.text.trim()).join('\n') : '',
        fores.length > 0 ? `沒收的伏筆：\n${fores.map((i) => i.text.trim()).join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n')
    );
  } else if (threadLines.length > 0) {
    sections.push(
      `${
        reviewing
          ? '# 沒收的伏筆（審稿對照：計劃在本章收的寫到沒有；沒到回收章的有沒有提前揭開）'
          : '# 進行中的敘事線（只作提醒：以本章細綱為準，細綱沒寫到的線不要硬塞；沒到回收章的伏筆不許提前揭開）'
      }\n\n${threadLines.map((i) => i.text.trim()).join('\n')}`
    );
  }

  const fullText = pick('manuscriptFull').slice().sort(byNoAsc);
  section('# 前文正文', fullText);

  const prevTail = pick('prevTail')[0];
  if (prevTail) {
    // 「不可重演」：上游的說法是「只作邊界，不可重演」（PT:810）。模型拿到上一章結尾之後
    // 最常見的失敗不是接不上，是從那裡把最後一場重新演一遍（context/replay.ts 寫完再查一次）。
    sections.push(
      writing && !revising
        ? `# 上一章結尾原文（只作邊界，不可重演）\n\n這是上一章已經寫完的結尾。本章從它的最終狀態之後無縫接下去，不要重寫、摘要或回放這一段。\n\n${prevTail.text}`
        : `# 上一章結尾原文\n\n${prevTail.text}`
    );
  } else if (writing && fullText.length > 0 && items.some((i) => i.kind === 'prevTail' && i.status === 'dropped')) {
    // 結尾片段被整章正文取代時，仍要點明接續位置。**只在確實被取代時說**：上一章
    // 根本沒有正文（只排了細綱）時這裡沒有結尾片段可言，最後一份全文是更早的某一章，
    // 說「從它的結尾接下去」等於讓模型跳過中間那一章的事件。
    const last = fullText[fullText.length - 1];
    sections.push(
      `你要從上面「${last.label.replace(' · 正文', '')}」結尾的最終狀態之後無縫接下去，不要重演它的結尾。`
    );
  }

  // 從已寫正文整理（拆書 A）：要整理的東西本身。排在前序細綱一覽與本層產物之前、緊挨著指令——
  // 讀的時候是「已經寫成了這些 → 已經整理到哪 → 現在把這幾章整理出來」。層裡按裝進去的順序排
  // （設定那一組先節選、後全書梗概），不按章號重排。
  section('# 已寫正文（作者已經寫成的權威事實：這一次是從中整理，不是創作）', pick('written'));

  // 已經排好的目錄進度：細綱批次要緊接著它的最後一章往下排。
  section('# 前序細綱一覽（已生成的目錄進度）', pick('plotList'));

  // 單條設定（展開，完善設定 2026-10-19）：定稿記錄 → 已排細綱 → 這一條本身，緊挨著指令。讀的時候是
  // 「已經寫進正文的（不能推翻）→ 接下來要它做什麼 → 它現在寫到哪了」。
  section('# 定稿過的記錄（已經寫進正文的事實，不能推翻）', pick('loreRecord'));
  section('# 已排細綱裡用到它的地方（計劃，還沒寫成正文；這一條要撐得住這些情節）', pick('lorePlan'));
  section('# 當前這一條設定（現有內容；作者寫過的只補、只細化，不刪）', pick('loreSelf'));

  // 本層產物緊挨著指令：這一章的細綱才是這一輪真正要動的東西。
  section('# 細綱', pick('plot'));

  // 寫正文的邊界：後面幾章要發生的事。緊跟在本章細綱後面，讀的時候就是「這一章寫到這為止」。
  // 審稿時同一份東西換個說法（上游 `planningMaterial` 的「當前及未來藍圖/計劃｜非既定歷史」）。
  section(
    reviewing
      ? '# 後續章節計劃（非既定歷史：這些事還沒有發生，只用來判斷本章有沒有提前寫掉）'
      : '# 後續章節預告（僅供瞭解後續劇情發力點，絕對不要在本章提前寫出這些內容）',
    pick('boundary')
  );

  // 審的就是它：緊挨著契約，引文從這裡逐字摘。
  section('# 待審正文', pick('chapterFull'));

  // 「接著寫」從這裡往下接：離指令最近，接的是哪一句一眼看得到。
  section(
    revising ? '# 已修訂正文（末尾，從這裡接著輸出）' : '# 本章已寫正文（末尾，你要從這裡接著寫）',
    pick('chapterSoFar')
  );

  // 使用者 @ 的引用也緊挨著他的指令放——他多半正是要針對這些內容提要求。
  section('# 我引用的內容（請針對這些內容作答）', pick('attachment'));

  const askText = pick('ask')[0]?.text ?? request.ask;
  const requirements: string[] = [
    `${askHeading(request.action, facts)}\n\n${askText.trim() || '（沒有額外要求，按上面的設定與契約來。）'}`,
  ];
  if (request.extraInstruction?.trim()) {
    requirements.push(`額外要求：${request.extraInstruction.trim()}`);
  }
  sections.push(requirements.join('\n\n'));

  const revision = pick('revision')[0];
  if (revision) {
    // 修稿不說「重寫」：它要的是清單指到的那幾處改掉、其餘一字不動（契約裡說清）。
    sections.push(
      revising
        ? `# 待修稿原文與審稿意見\n\n${revision.text}`
        : `# 修訂要求\n\n${revision.text}\n\n請基於上一版重寫，採納修改意見，保留其中寫得好的部分。`
    );
  }

  // target 也要給：架構層五件同屬一個階段，契約要看是哪一件。寫正文時目標字數也在契約裡
  // （篇幅合同 ±20%），從前這裡另有一行「約 N 字（±15%）」，兩個比例作者與模型都分不清哪個算數。
  sections.push(buildOutputContract(request.action, facts));

  messages.push({ role: 'user', content: sections.join('\n\n---\n\n') });
  return messages;
}

function byNoAsc(a: ContextItem, b: ContextItem): number {
  return noOf(a) - noOf(b);
}

function noOf(item: ContextItem): number {
  const m = /:(\d+)$/.exec(item.id);
  return m ? Number(m[1]) : 0;
}

/**
 * 已經寫了正文的書，生成架構幾件一律照正文整理（`derive`）：憑一句話編出來的設定與已寫的章對不上，
 * 後面每一章卻都要讀它。從已寫正文補齊自己帶著 `derive`，這裡補上補齊架構、對話頁與 MCP 的單件生成。
 * 角色圖譜除外：已寫正文的書照定稿過的細綱建卡（features/characterCard.ts），不走身份清單那條鏈。
 * 設定清單同理：有正文的書這一件本來就算填過（`isLoreListFilled`），設定從定稿里長、從名錄建條目；
 * 作者硬要重排一份時照新書的清單鏈走，不另編一套「照正文整理」的合同。
 * 單條設定（展開）也不走這條：它的原料本來就是定稿過的記錄（`loreMaterial` 層），合同是往前想，不是照正文整理。
 */
async function settingFromText(project: NovelProject, request: BuildRequest): Promise<BuildRequest> {
  const { action, target } = request;
  const chained = target.kind !== 'setting' || target.doc === 'characters' || target.doc === 'lore';
  if (request.derive || action.stage !== 'setting' || action.capability !== 'generate' || chained) {
    return request;
  }
  const through = nextWritableChapterNo(await project.listChapters()) - 1;
  return through > 0 ? { ...request, derive: { through } } : request;
}
