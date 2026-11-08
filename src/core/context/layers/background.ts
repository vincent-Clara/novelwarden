import { traditionalLabel } from '../../model/labels';
import { isLoreSettle, loreOfTarget, plotLabel } from '../../model/pipeline';
import { describeStateThrough } from '../../model/characterState';
import { CONTEXT_DETAIL_LABEL, takeLast } from '../../model/contextDetail';
import { ContinuityFact, locateEvidence, parseContinuityFacts } from '../../model/continuity';
import { ContextThread, ThreadBook, fitThreads, manuscriptThreads, plotThreads, reviewForeshadowing } from '../../model/threadFile';
import { STORY_TIME_LABEL, timeContextText } from '../../model/timelineFile';
import { CharacterCard, LoreEntry } from '../../model/types';
import { LORE_ENTRY_LIMITS, LORE_SETTLE_LIMITS, createLoreLookup, loreMentionsIn } from '../../model/loreFile';
import { LoreFact, LoreRecord, buildLoreIndex } from '../../views/lore';
import { expansionMaterial, loreEntryAt } from '../../views/loreMaterial';
import { ContextItem } from '../types';
import { estimateTokens } from '../tokenizer';
import type { LayerFn } from './assembly';
import { ChapterRef, readChapterText, readPrevManuscript } from './focus';
import {
  LORE_HIDDEN_DROPPED_NOTE,
  cardHidden,
  continuationTail,
  essentialCardKeys,
  focusText,
  isPlaceholder,
  loreBodyFor,
  renderCharacter,
  renderLoreFull,
  renderLoreLine,
  renderPlotSections,
  selectCharacters,
  tailByChars,
} from './render';

export const style: LayerFn = async (a, spec) => {
  const text = await a.project.readStyleGuide();
  if (!text.trim()) {
    return;
  }
  a.admit(
    {
      id: 'style',
      kind: 'style',
      priority: spec.priority,
      label: '文風指南',
      source: a.project.relPath(a.project.stylePath),
      text,
    },
    { force: spec.force }
  );
};

export const globalSummary: LayerFn = async (a, spec) => {
  const summary = await a.project.readGlobalSummary();
  if (!summary.trim() || isPlaceholder(summary)) {
    return;
  }
  a.admit(
    {
      id: 'globalSummary',
      kind: 'globalSummary',
      priority: spec.priority,
      label: '全文大綱',
      source: a.project.relPath(a.project.globalSummaryPath),
      text: summary,
    },
    { force: spec.force }
  );
};

/**
 * 相關角色的卡（計劃出場、提到的、前幾章出場的、主角）。整張帶不下就只帶要點（{@link essentialCardKeys}），
 * 上下文詳細度「精簡」一律只帶要點。
 *
 * 「暗設」（敘事線重做：原「未收伏筆」，設計稿「六、角色卡」⚑ 定案 B）與設定條目的暗設同一個口徑（第 27 條，見下面
 * `lore` 層）：正文階段（寫、接著寫、重寫、討論正文，連同審稿與修稿——它們也是正文那一層）與續寫不帶，這張卡真有暗設
 * 被去掉才在明細裡注一句（第 2 條）；架構、大綱、細綱整份帶，標題寫「暗設（讀者還不知道）」（`render.ts` 的
 * `renderCharacter`）。
 */
export const characters: LayerFn = async (a, spec) => {
  const all = await a.project.listCharacters();
  const relevant = selectCharacters(all, a.request.ask, a.focus, a.limits.castSummaries);
  const writing = a.request.action.stage === 'manuscript' || a.request.step?.kind === 'continuation';
  const essentialLabel = essentialCardKeys(!writing).map(traditionalLabel).join('/');
  for (const { card, reason } of relevant) {
    const id = `character:${card.slug}`;
    const base = {
      id,
      kind: 'character' as const,
      priority: spec.priority,
      label: `角色 · ${card.name}`,
      source: card.relPath,
    };
    if (a.excluded.has(id)) {
      a.admit({ ...base, text: '' });
      continue;
    }
    // 「當前狀態」寫到第幾章（D23）：上一章沒定稿時，這裡說的是更早那一章結束時的樣子。
    const through = describeStateThrough(card.stateThrough);
    const why = through ? `${reason}；${through}` : reason;
    // 寫正文時這張卡真有暗設被去掉：注一句（沒有暗設的卡注了只是噪音）。
    const hidden = writing && cardHidden(card) ? `；${LORE_HIDDEN_DROPPED_NOTE}` : '';
    // 上下文詳細度「精簡」：一律只帶要點，不先試整張卡。
    if (!a.limits.essentialCards) {
      const fullText = renderCharacter(card, false, !writing);
      const fullTokens = estimateTokens(fullText);
      if (fullTokens <= a.remaining) {
        a.admit({ ...base, text: fullText, note: `${why}${hidden}` });
        continue;
      }
    }
    const essential = renderCharacter(card, true, !writing);
    const essentialTokens = estimateTokens(essential);
    if (essentialTokens <= a.remaining) {
      a.accept(
        {
          ...base,
          text: essential,
          status: 'degraded',
          note: a.limits.essentialCards
            ? `${why}；上下文詳細度「${CONTEXT_DETAIL_LABEL[a.detail]}」只帶${essentialLabel}${hidden}`
            : `${why}；預算不足，僅保留${essentialLabel}${hidden}`,
        },
        essentialTokens
      );
    } else {
      a.reject({ ...base, text: '' }, 'dropped', `${why}；預算不足`);
    }
  }
};

/**
 * 設定（設定名錄，2026-10-18）。幾百條的書不能「命中就整條塞」：先排序，再分兩種形態裝，按上下文
 * 詳細度封頂，降級與丟棄都留在明細裡（第 2 條）。
 *
 * 順位：
 * - R0 本章細綱「設定」一節點名的（沒定稿是計劃，定稿過是實際）——整條；
 * - R1 關鍵詞命中：作者這次的話 + 本章細綱（接著寫時再加本章已寫的末尾）——整條；最長匹配，被別人更長的名字包住的不算
 *   （{@link loreMentionsIn}）；
 * - R2 前幾章（`castSummaries` 章）定稿細綱「設定」一節出現過的——一行；
 * - R3 只在大綱、細綱階段：其餘條目一行一條，讓規劃時照抄已有的名字，不另起一個。近幾章出現過的在前（{@link catalogOrder}）。
 *
 * 續寫那幾輪只要 R0、R1：前文那幾章的設定第一次呼叫已經帶過了。
 *
 * 整條 = 一句話 + 正文 + 尾巴（水位之後、本章之前定稿的章裡關於它的新事實，`loreTail` 行）：條目落後於
 * 正文時，模型照樣拿得到新的那幾句，不必每章定稿都調一次模型去改條目。整條超了 `loreFull`、超了
 * `loreChars` 或預算放不下就降成一行；一行也超了上限就丟。
 *
 * 「暗設」（完善設定，2026-10-19）：整條帶時，正文階段與續寫只帶明面、明細裡注一句（第 2 條）；規劃時整份帶，
 * 暗設那一節換成「暗設（讀者還不知道）」的標題（`render.ts` 的 `loreBodyFor`）。一行帶的一句話本來就跳過暗設。
 *
 * 架構那一層只有兩件用得上它：**設定清單**當規劃看（分類表 + 已有條目一行一條，清單要照用目錄、照抄
 * 名字）；世界觀不當規劃看，只帶作者點名的（已經寫了正文的書再加近幾章定稿裡出現過的一句話）。其餘幾件
 * （配置、前提、角色圖譜）一條都不帶——它們在設定之前。
 *
 * **單條設定（展開，完善設定 2026-10-19）**：這一條自己是焦點（`loreSelf` 層），這裡去掉它、只挑相關的——
 * 關鍵詞命中（來源在作者的話之外，再加上這一條的標題、關鍵詞、一句話與正文，以及已排細綱裡用到它的那幾句）
 * 整條帶；同一個分類目錄裡的一行帶。給分類表（建議拆出的子條目要歸類），不給 R2、R3。
 *
 * **落定設定（完善設定二期）**：目標是設定目錄，照設定清單那樣當規劃看（分類表 + 已有條目一行一條）；關鍵詞命中的
 * 來源再加上歷史那幾輪——討論裡提到的已有條目要合併，就得看得見原文，整條帶（含暗設）。整條的名額放寬到一次落定的
 * 上限（{@link LORE_SETTLE_LIMITS}），字數另加這麼多條的上限，不受上下文詳細度那一檔的整條名額限制；預算放不下照樣降級、
 * 寫進明細。
 */
export const lore: LayerFn = async (a, spec) => {
  const { stage } = a.request.action;
  const doc = a.request.target.kind === 'setting' ? a.request.target.doc : undefined;
  const selfPath = loreOfTarget(a.request.target);
  if (stage === 'setting' && doc !== 'lore' && doc !== 'world' && !selfPath) {
    return;
  }
  const listing = stage === 'setting' && doc === 'lore';
  const entries = await a.project.listLore();
  // 排設定清單時一條條目都沒有也要往下走：分類表（目錄，空的也算）照樣要給。展開一條時同理（子條目要歸類）。
  if (entries.length === 0 && !listing && !selfPath) {
    return;
  }
  const index = await buildLoreIndex(a.project, { entries });
  const records = new Map(index.known.map((r) => [r.entry.slug, r]));
  const lookup = createLoreLookup(entries);
  const continuation = a.request.step?.kind === 'continuation';
  const planning = listing || stage === 'outline' || stage === 'plot';
  const settling = listing && isLoreSettle(a.request.action);
  // 「暗設」的去留（完善設定，2026-10-19）：正文階段（寫、接著寫、重寫、討論正文）與續寫整條只帶明面，
  // 揭開靠那一章的細綱；其餘階段（設定 / 大綱 / 細綱，含展開一條設定）整條帶全部，暗設標明讀者還不知道。
  const writing = stage === 'manuscript' || continuation;

  // 規劃時新引入的設定要歸類：分類就是目錄、每本書自己的，空目錄也算，模型只能從這一行裡知道有哪些。
  if (planning || selfPath) {
    const categories = await a.project.listLoreCategories();
    if (categories.length > 0) {
      a.admit({
        id: 'lore:categories',
        kind: 'lore',
        priority: spec.priority,
        label: '設定 · 分類表',
        source: a.project.relPath(a.project.loreDir),
        text: `本書的設定分類：${categories.join('、')}（新設定的 category 從這裡挑）。`,
        note: '規劃時新設定要歸進哪一類',
      });
    }
  }

  const picked = new Map<string, { entry: LoreEntry; full: boolean; reason: string }>();
  const pick = (entry: LoreEntry, full: boolean, reason: string): void => {
    // 展開的那一條自己不在這裡帶：它是焦點，`loreSelf` 層整份帶著。
    if (!picked.has(entry.slug) && entry.relPath !== selfPath) {
      picked.set(entry.slug, { entry, full, reason });
    }
  };

  for (const line of a.focus.plot?.lore ?? []) {
    const entry = lookup.find(line.name);
    if (entry) {
      pick(entry, true, `本章細綱的設定裡有「${line.name}」`);
    }
  }
  // R1 裡也分先後：作者這次親口說的 → 本章細綱 → 本章已寫的末尾。整條名額有限，先給最確定要用的。
  // 展開一條時再加：這一條自己寫著什麼、已排細綱裡用到它的那幾句。
  const self = selfPath ? await loreEntryAt(a.project, selfPath, entries) : undefined;
  // 落定設定時再加歷史那幾輪（近的在前）：討論裡提到的已有條目要合併。
  const discussed = settling
    ? (a.request.history ?? [])
        .map((t) => t.content)
        .filter((text) => text.trim())
        .reverse()
    : [];
  const haystacks = [
    a.request.ask,
    ...discussed,
    focusText(a.focus),
    await chapterTailText(a),
    ...(self ? [selfText(self.entry), ...(await expansionMaterial(a.project, self.entry, { entries })).uses.map((u) => u.text)] : []),
  ];
  // 最長匹配（2026-10-25）：一個詞每一處都落在別人更長的名字裡就不算——「聖地秘境」裡的「秘境」不把上位概念整條帶進來。
  // 別人的名字再加名錄裡記著、還沒建條目的與本章細綱「設定」一節點的。展開一條時它自己不算別人的名字：上位概念照樣命中。
  const names = [...index.unknown.map((u) => u.name), ...(a.focus.plot?.lore ?? []).map((l) => l.name)];
  const candidates = selfPath ? entries.filter((e) => e.relPath !== selfPath) : entries;
  for (const haystack of haystacks) {
    for (const [entry, hit] of loreMentionsIn(haystack, candidates, names)) {
      pick(entry, true, discussed.includes(haystack) ? `討論裡提到「${hit}」` : `上下文中出現「${hit}」`);
    }
  }
  // 展開一條時同一個分類目錄裡的一行帶：拆子條目、寫規則時看得見旁邊已經有什麼。根目錄（未分類）不算一類。
  if (self?.entry.category) {
    for (const entry of entries) {
      if (entry.category === self.entry.category) {
        pick(entry, false, `與「${self.entry.title}」同在「${self.entry.category}」`);
      }
    }
  }
  let catalog = 0;
  if (!continuation && !self) {
    const recent = a.focus.previous.filter((r) => r.plot?.sourceHash && r.plot.lore).slice(-a.limits.castSummaries);
    for (const ref of recent.reverse()) {
      for (const line of ref.plot?.lore ?? []) {
        const entry = lookup.find(line.name);
        if (entry) {
          pick(entry, false, `第 ${ref.no} 章出現過`);
        }
      }
    }
    if (planning) {
      // 大綱、細綱：近幾章出現過的在前（`rosterRecent`，與規劃時的角色圖譜同一個「近幾章」）。排設定清單是盤點全部，照舊。
      const recentSize = a.limits.rosterRecent;
      const first = a.focus.range?.from ?? a.request.range?.from ?? (Number.isFinite(a.focus.no) ? a.focus.no : undefined);
      const to = first ?? index.known.reduce((max, r) => Math.max(max, r.chapters[r.chapters.length - 1] ?? 0), 0) + 1;
      const window = !listing && Number.isFinite(recentSize) ? { from: to - recentSize, to, size: recentSize } : undefined;
      const rest = catalogOrder(index.known.filter((r) => !picked.has(r.entry.slug)), window);
      for (const { record, reason } of rest) {
        pick(record.entry, false, reason);
        catalog++;
      }
    }
  }

  const level = `上下文詳細度「${CONTEXT_DETAIL_LABEL[a.detail]}」`;
  // 落定設定：討論裡提到的要整條看得見原文才合併得了，整條名額放寬到一次落定的上限，字數另加這麼多條的上限。
  const fullCap = settling ? Math.max(a.limits.loreFull, LORE_SETTLE_LIMITS.entries) : a.limits.loreFull;
  const charCap = settling
    ? a.limits.loreChars + LORE_SETTLE_LIMITS.entries * (LORE_ENTRY_LIMITS.body + LORE_ENTRY_LIMITS.暗设)
    : a.limits.loreChars;
  let fullCount = 0;
  let lineCount = 0;
  let chars = 0;
  /** R3 的一覽超了上限不逐條報（幾百條全是「沒帶」只會淹掉明細），最後併成一條。 */
  let catalogDropped = 0;
  let catalogWhy = '';
  for (const { entry, full, reason } of picked.values()) {
    const id = `lore:${entry.slug}`;
    const base = {
      id,
      kind: 'lore' as const,
      priority: spec.priority,
      label: `設定 · ${entry.title}`,
      source: entry.relPath,
    };
    if (a.excluded.has(id)) {
      a.admit({ ...base, text: '' });
      continue;
    }
    const spoiler = spoilerNote(entry, a.focus.no);
    const why = spoiler ? `${reason}；${spoiler}` : reason;

    let degraded = '';
    if (full) {
      const text = renderLoreFull(entry, loreTail(records.get(entry.slug), a.focus.no, a.limits.loreTail), !writing);
      if (fullCount >= fullCap) {
        degraded = `整條的已帶滿 ${fullCap} 條（${settling ? '一次落定的上限' : level}）`;
      } else if (chars + text.length > charCap) {
        degraded = `設定已帶 ${chars} 字，整條帶會超過 ${charCap} 字（${level}）`;
      } else if (estimateTokens(text) > a.remaining) {
        degraded = '預算不足';
      } else {
        // 這一條真有暗設被去掉才注：沒有暗設的條目注了只是噪音。
        const hidden = writing && loreBodyFor(entry.body, false).dropped;
        a.admit({ ...base, text, note: hidden ? `${why}；${LORE_HIDDEN_DROPPED_NOTE}` : why });
        fullCount++;
        chars += text.length;
        continue;
      }
    }

    const line = renderLoreLine(entry);
    const tokens = estimateTokens(line);
    const over =
      lineCount >= a.limits.loreLines
        ? `一句話的已帶滿 ${a.limits.loreLines} 條（${level}）`
        : chars + line.length > charCap
          ? `設定已帶滿 ${charCap} 字（${level}）`
          : tokens > a.remaining
            ? '預算不足'
            : '';
    if (over) {
      if (!full && reason.startsWith('已有設定')) {
        catalogDropped++;
        catalogWhy ||= over;
        continue;
      }
      a.reject({ ...base, text: '' }, 'dropped', `${why}；${over}`);
      continue;
    }
    if (degraded) {
      a.accept({ ...base, text: line, status: 'degraded', note: `${why}；${degraded}，只帶一句話` }, tokens);
    } else {
      a.admit({ ...base, text: line, note: why });
    }
    lineCount++;
    chars += line.length;
  }
  if (catalogDropped > 0) {
    a.reject(
      {
        id: 'lore:catalog',
        kind: 'lore',
        priority: spec.priority,
        label: `設定 · 其餘 ${catalogDropped} 條`,
        text: '',
      },
      'dropped',
      `規劃時的已有設定一覽共 ${catalog} 條，${catalogWhy}，其餘 ${catalogDropped} 條沒帶`
    );
  }
};

/** 展開一條設定時，這一條自己寫著的東西（標題、關鍵詞、一句話、正文含暗設）：關鍵詞命中也看它。 */
function selfText(entry: LoreEntry): string {
  return [entry.title, ...entry.keywords, entry.brief, entry.body].join('\n');
}

/**
 * R3 一覽的先後（2026-10-25）。給了 `window`（大綱、細綱：這一次要排的第一章往前數 `size` 章）：這幾章裡出現過的在前，
 * 按這幾章裡出現的章數、再按最近出現的那一章；沒出現過的在後，按全書出現章數。從前一律按全書出現章數，寫到八十章，開篇
 * 幾十章裡的高頻詞永遠排在最前面、佔滿一句話的名額。沒給（排設定清單、「完整」那一級）只按全書出現章數。
 * 穩定排序：一樣的保持 listLore 的順序（按路徑，也就是按分類）。
 */
function catalogOrder(
  records: readonly LoreRecord[],
  window?: { from: number; to: number; size: number }
): { record: LoreRecord; reason: string }[] {
  const rows = records.map((record) => {
    // `chapters` 是排好序的章號：這幾章裡的最後一個就是最近出現的那一章。
    const seen = window ? record.chapters.filter((no) => no >= window.from && no < window.to) : [];
    return { record, hits: seen.length, last: seen[seen.length - 1] ?? 0 };
  });
  rows.sort((x, y) => y.hits - x.hits || y.last - x.last || y.record.chapters.length - x.record.chapters.length);
  return rows.map(({ record, hits, last }) => {
    const n = record.chapters.length;
    const reason =
      hits > 0
        ? `已有設定（近 ${window!.size} 章出現 ${hits} 章，最近第 ${last} 章）`
        : n === 0
          ? '已有設定'
          : `已有設定（出現 ${n} 章${window ? `，近 ${window.size} 章沒出現` : ''}）`;
    return { record, reason };
  });
}

/** 接著寫時本章已寫的末尾（續寫那幾輪是 step 裡那一截）：關鍵詞命中也看它。 */
async function chapterTailText(a: Parameters<LayerFn>[0]): Promise<string> {
  const step = a.request.step?.kind === 'continuation' ? a.request.step : undefined;
  if (step) {
    return step.tail ?? '';
  }
  if (a.request.writeMode === 'continue' && a.focus.chapter) {
    return continuationTail(await a.project.readChapterText(a.focus.chapter));
  }
  return '';
}

/** 水位之後、本章之前定稿的章裡關於它的新事實，最近的 `max` 條。 */
function loreTail(record: LoreRecord | undefined, beforeNo: number, max: number): LoreFact[] {
  if (!record || max <= 0) {
    return [];
  }
  return takeLast(
    record.pending.filter((f) => f.no < beforeNo),
    max
  );
}

/**
 * 條目整合到的章不早於本章（回頭重寫前面的章時）：條目裡可能寫著之後才發生的事。同角色卡的
 * 「當前狀態寫到第幾章」。架構、大綱階段（`no` 是無窮大）不提。
 */
function spoilerNote(entry: LoreEntry, no: number): string {
  if (entry.updatedThrough === undefined || !Number.isFinite(no) || entry.updatedThrough < no) {
    return '';
  }
  return `條目整合到第 ${entry.updatedThrough} 章，可能含第 ${no} 章之後才發生的事`;
}

export const prevTail: LayerFn = async (a, spec) => {
  const prev = a.focus.previous[a.focus.previous.length - 1];
  // 「接著寫」不帶：這一章的開頭早就從上一章結尾接過了，要接的是本章已寫的末尾
  // （`chapterSoFar`）。兩個「從這裡接下去」擺在一起，模型會跳回上一章去。
  if (!prev || a.limits.prevTailChars <= 0 || a.request.writeMode === 'continue') {
    return;
  }
  const manuscript = await readPrevManuscript(a.project, a.focus);
  if (!manuscript?.text.trim()) {
    return;
  }
  a.scratch.prevTail = a.admit(
    {
      id: `prevTail:${prev.no}`,
      kind: 'prevTail',
      priority: spec.priority,
      label: `${plotLabel(prev.no, prev.title)} · 結尾原文`,
      source: manuscript.relPath,
      text: tailByChars(manuscript.text, a.limits.prevTailChars),
      note: '原文注入，保證語氣與場景銜接',
    },
    { force: spec.force }
  );
};

/**
 * 前面幾章的**正文全文**。只有正文階段帶（配方里只有那一張有這一層）。
 *
 * 放不下時降級為該章細綱，再放不下才丟棄——三檔都要留在明細裡說清原因
 * （AGENTS.md 第 2 條：不靜默截斷）。
 */
export const manuscriptFull: LayerFn = async (a, spec) => {
  const previous = a.focus.previous;
  const prev = previous[previous.length - 1];
  // 0 就是一章全文都不帶（`takeLast` 不踩 `slice(-0)` 等於 `slice(0)` 的坑）。
  const fullTextPlots = takeLast(previous, a.limits.fullTextChapters);

  for (const ref of [...fullTextPlots].reverse()) {
    const plot = ref;
    const id = `manuscriptFull:${plot.no}`;
    const label = plotLabel(plot.no, plot.title);
    const base = {
      id,
      kind: 'manuscriptFull' as const,
      priority: spec.priority,
      label: `${label} · 正文`,
      source: ref.chapter?.relPath ?? ref.plot?.relPath ?? '',
    };
    if (a.excluded.has(id)) {
      a.admit({ ...base, text: '' });
      continue;
    }

    const manuscript = await readChapterText(a.project, ref);
    if (!manuscript?.text.trim()) {
      // 只排了細綱、還沒寫正文——這不是錯誤，是這一章還沒到那一步。它在前幾章之內時
      // 細綱由 `plotPrev` 帶。
      continue;
    }
    const block = `【${label}】\n${manuscript.text}`;
    const tokens = estimateTokens(block);
    // 這一章的定稿原文片段（`evidence` 層先裝的）：整章進來了它就多餘了，那份預算可以退回來用。
    const ev = a.scratch.evidence.get(plot.no);
    const evTokens = ev && ev.status !== 'dropped' ? ev.tokens : 0;
    const tail = a.scratch.prevTail;
    if (tail && plot.no === prev?.no && tail.status === 'included') {
      if (tokens - tail.tokens - evTokens <= a.remaining) {
        releaseEvidence(a, ev);
        a.remaining += tail.tokens - tokens;
        tail.status = 'dropped';
        tail.note = '整章正文已完整注入，無需重複結尾片段';
        tail.tokens = 0;
        tail.text = '';
        a.items.push({
          ...base,
          source: manuscript.relPath,
          text: block,
          tokens,
          status: 'included',
          note: '含上一章結尾，續寫將從此處接續',
        });
        continue;
      }
    }

    if (tokens <= a.remaining + evTokens) {
      releaseEvidence(a, ev);
      a.accept({ ...base, source: manuscript.relPath, text: block, status: 'included' }, tokens);
      continue;
    }

    const outline = ref.plot ? renderPlotSections(ref.plot) : '';
    if (outline) {
      const planned = !ref.plot!.sourceHash;
      const outlineBlock = `【${label} · 細綱${planned ? '（計劃，沒定稿）' : ''}】\n${outline}`;
      const outlineTokens = estimateTokens(outlineBlock);
      if (outlineTokens <= a.remaining) {
        a.accept(
          {
            ...base,
            source: ref.plot!.relPath,
            text: outlineBlock,
            status: 'degraded',
            note: `正文需 ${tokens} token 放不下，已降級為細綱${planned ? '（還沒同步，是寫之前的計劃）' : ''}`,
          },
          outlineTokens
        );
        continue;
      }
    }
    a.reject(
      { ...base, text: '' },
      'dropped',
      outline ? '正文與細綱都放不下' : `正文需 ${tokens} token 放不下，且這一章沒有細綱`
    );
  }
};

/** 這一章定稿過、而且定稿之後正文沒再改過（細綱的 `sourceHash` 對得上正文）。 */
function isFinalized(ref: ChapterRef): boolean {
  return !!ref.plot?.sourceHash && !!ref.chapter && ref.plot.sourceHash === ref.chapter.contentHash;
}

/**
 * 本章已經寫好的正文末尾（最後 1600 字）：「接著寫」與續寫那幾輪從這裡往下接。
 *
 * 兩個來處：續寫那幾輪由生成鏈把「已寫到哪」直接給過來（`step.tail`，含這一次剛寫、
 * 還沒落盤的部分）；「接著寫」的第一次呼叫讀磁碟上這一章的正文。**只帶末尾**——
 * 上游續寫也只帶 1600 字（GD:998）：接得上靠的是最後那一場，整章塞進去只是貴。
 */
export const chapterSoFar: LayerFn = async (a, spec) => {
  const step = a.request.step?.kind === 'continuation' ? a.request.step : undefined;
  let text = step?.tail ?? '';
  let written = step?.written ?? 0;
  let source: string | undefined;
  if (!step) {
    if (a.request.writeMode !== 'continue' || !a.focus.chapter) {
      return;
    }
    const body = await a.project.readChapterText(a.focus.chapter);
    text = continuationTail(body);
    written = a.focus.chapter.wordCount;
    source = a.focus.chapter.relPath;
  }
  if (!text.trim()) {
    return;
  }
  a.admit(
    {
      id: 'chapterSoFar',
      kind: 'chapterSoFar',
      priority: spec.priority,
      label:
        a.request.writeMode === 'revise'
          ? `已修訂正文 · 末尾（已輸出 ${written} 字）`
          : `本章已寫正文 · 末尾（全章已有 ${written} 字）`,
      source,
      text,
      note: '只帶最後一段，從這裡往下接',
    },
    { force: spec.force }
  );
};

/** 整章正文進來了：它的定稿原文片段改成 dropped、預算退回去（與上一章結尾片段同一個做法）。 */
function releaseEvidence(a: Parameters<LayerFn>[0], ev: ContextItem | undefined): void {
  if (!ev || ev.status === 'dropped' || ev.status === 'excluded') {
    return;
  }
  a.remaining += ev.tokens;
  ev.status = 'dropped';
  ev.note = '整章正文已完整注入，不再單獨帶片段';
  ev.tokens = 0;
  ev.text = '';
}

/**
 * 前面各章的**定稿原文片段**（D18）：拿定稿過的細綱裡每條連續性事實的證據原句回到那一章的正文裡
 * 逐字定位，取所在段落與前後各一段（model/continuity.ts 的 `locateEvidence`）。
 *
 * 移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）`chapter-materials.ts` 的
 * `assembleChapterMaterials`（CM:120-187）：寫正文時不拿細綱當事實，按證據回到定稿原文裡取段落。
 * 不搬它的定稿收據、來源 hash 與租約（總計劃 §1 #14）。
 *
 * 取多少按上下文詳細度（`evidenceRecent` / `evidenceChapters` / `evidenceChars`，預設 5 / 12 / 6000）：
 *
 * | 取哪幾章 | 取什麼 |
 * |---|---|
 * | 前 `evidenceRecent` 章 | 全部連續性事實 |
 * | 更早的章，一共不超過 `evidenceChapters` 章 | 只取提到本章角色的事實 |
 *
 * - 只認定稿之後正文沒再改過的章（細綱的 `sourceHash` 對得上正文）：正文改過的，證據句多半已經
 *   不在原處，事實本身也可能正是改掉的那一處。
 * - 由近及遠填，一共不超過 `evidenceChars` 字；放不下的章 dropped 並寫原因（第 2 條）。
 * - **定位不到**（作者手改過細綱裡的事實或證據句）的那幾條換成事實原句，條目標 degraded 並寫明幾條（第 2 條）。
 * - 上一章有正文卻還沒定稿（或定稿之後正文又改過）：明細裡多一條 dropped，說清沒有事實、角色狀態截至第幾章（D23）。
 *   不擋路——寫第 N 章不強制第 N−1 章已定稿——但不靜默。
 * - 「精簡」整層不帶：前面有寫好的章時出一條 dropped 說明，不一章一條。
 */
export const evidence: LayerFn = async (a, spec) => {
  const previous = a.focus.previous;
  if (previous.length === 0) {
    return;
  }
  const { evidenceRecent, evidenceChapters, evidenceChars } = a.limits;
  if (evidenceChapters <= 0 || evidenceChars <= 0) {
    if (previous.some((p) => p.chapter && p.chapter.wordCount > 0)) {
      a.reject(
        { id: 'evidence:off', kind: 'evidence', priority: spec.priority, label: '原文片段', text: '' },
        'dropped',
        `上下文詳細度「${CONTEXT_DETAIL_LABEL[a.detail]}」不帶原文片段`
      );
    }
    return;
  }
  const cards = await a.project.listCharacters();
  const names = namesOf(cards, a.focus.plot?.characters ?? []);
  const recentFrom = previous.length - evidenceRecent;
  const prev = previous[previous.length - 1];
  let budget = evidenceChars;
  let taken = 0;

  for (let i = previous.length - 1; i >= 0 && taken < evidenceChapters; i--) {
    const ref = previous[i];
    if (!ref.chapter || ref.chapter.wordCount <= 0) {
      continue;
    }
    const label = `${plotLabel(ref.no, ref.title)} · 原文片段`;
    const base = { id: `evidence:${ref.no}`, kind: 'evidence' as const, priority: spec.priority, label, source: ref.chapter.relPath };
    const finalized = isFinalized(ref);
    if (ref === prev && !finalized) {
      const through = latestState(cards, names);
      a.reject(
        { ...base, text: '' },
        'dropped',
        ref.plot?.sourceHash
          ? `第 ${ref.no} 章同步之後正文又改過：連續性事實不作數${through !== undefined ? `，角色狀態截至第 ${through} 章` : ''}`
          : `第 ${ref.no} 章還沒同步：沒有連續性事實${through !== undefined ? `，角色狀態截至第 ${through} 章` : ''}`
      );
      continue;
    }
    // 只認對得上的定稿：定稿之後正文改過的，證據句多半已經不在原處，事實本身也可能正是改掉的那一處。
    if (!finalized) {
      continue;
    }
    const all = parseContinuityFacts(ref.plot!.sections.连续性事实);
    const facts = i >= recentFrom ? all : all.filter((f) => names.some((n) => f.statement.includes(n)));
    if (facts.length === 0) {
      continue;
    }
    taken++;
    if (a.excluded.has(base.id)) {
      a.admit({ ...base, text: '' });
      continue;
    }
    const text = await a.project.readChapterText(ref.chapter);
    const { block, missing } = renderEvidence(ref.no, ref.title, text, facts);
    if (block.length > budget) {
      a.reject({ ...base, text: '' }, 'dropped', `原文片段一共只帶 ${evidenceChars} 字，更近的幾章已經用完了`);
      continue;
    }
    const notes = [i >= recentFrom ? `${facts.length} 條連續性事實` : `${facts.length} 條涉及本章角色的連續性事實`];
    const item = a.admit({ ...base, text: block, note: notes.join('；') });
    if (item.status === 'included') {
      budget -= block.length;
      if (missing > 0) {
        item.status = 'degraded';
        item.note = `${notes.join('；')}；${missing} 條證據在正文裡找不到（細綱裡的事實被手改過），換成事實原句`;
      }
      a.scratch.evidence.set(ref.no, item);
    }
  }
};

/**
 * 寫這一章時帶哪幾條**敘事線**（2026-10-20 重做，設計稿「四」）：沒收束的、和本章有關的那幾條，一條線一行——現在走到哪、
 * 本章計劃幹什麼、沒收的伏筆（沒到回收章的寫「第 b 章前不要揭開」）。審稿只帶伏筆那一半（⚑5）。
 *
 * 移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）`generate-draft.command.ts` 的
 * `readActiveNarrativeThreads`（GD:1452-1498）。挑哪幾條、怎麼排、一行怎麼寫都在
 * model/threadFile.ts（`manuscriptThreads` / `reviewForeshadowing`）；這一層只管登記：
 *
 * - 一條一個條目，按要緊程度排好（本章有計劃的在最前）；note 寫狀態與為什麼帶它，來源是那條線自己的檔案。
 * - 條數與字數按上下文詳細度（預設 6 條 / 1200 字；審稿按 `foreshadowJudge` 條），放不下的 dropped 並寫原因（第 2 條）。
 *   本章細綱或計劃提到的伏筆一律列在它那條線的一行裡（復跑之後，不佔每條線 4 條的名額），只受這裡的總字數管——那一行
 *   放不下時，原因裡點名說這幾條伏筆沒帶上。
 * - 作者在明細裡取消勾選的那條不佔名額，後面的補上來。
 * - 沒有敘事線、或者沒有一條有關的：什麼都不出（沒有東西被截斷）。
 * - 寫第 N 章一律按「寫到第 N 章時」算（`asOf`）：重寫前面的章時不帶後面的事。
 *
 * 拆細綱（`plot` 配方，敘事線二期）走另一套挑法，見 {@link admitPlotThreads}。
 */
export const threads: LayerFn = async (a, spec) => {
  if (!Number.isFinite(a.focus.no)) {
    return;
  }
  const book = await a.project.readThreads();
  const reviewing = a.request.action.capability === 'review';
  if (!reviewing) {
    admitStoryTime(a, spec, book);
  }
  if (a.request.action.stage === 'plot') {
    await admitPlotThreads(a, spec, book);
    return;
  }
  const plot = a.focus.plot;
  const plotText = plot ? [plot.title, ...Object.values(plot.sections)].join('\n') : '';
  const list = reviewing ? reviewForeshadowing(book, a.focus.no) : manuscriptThreads(book, a.focus.no, plotText);
  if (list.length === 0) {
    return;
  }
  const idOf = (c: ContextThread): string => `thread:${c.relPath}${reviewing ? `#${c.name}` : ''}`;
  const base = (c: ContextThread) => ({
    id: idOf(c),
    kind: 'thread' as const,
    priority: spec.priority,
    label: `${reviewing ? '伏筆' : '敘事線'} · ${c.name}`,
    source: c.relPath,
  });
  const limits = reviewing
    ? { count: a.limits.foreshadowJudge, chars: a.limits.threadChars }
    : { count: a.limits.threadCount, chars: a.limits.threadChars };
  const excluded = list.filter((c) => a.excluded.has(idOf(c)));
  const { picked, dropped } = fitThreads(
    list.filter((c) => !a.excluded.has(idOf(c))),
    limits,
    reviewing ? '伏筆' : '敘事線'
  );
  for (const c of picked) {
    a.admit({ ...base(c), text: c.line, note: `${traditionalLabel(c.status)} · ${traditionalLabel(c.why)}` });
  }
  for (const c of excluded) {
    a.admit({ ...base(c), text: '' });
  }
  for (const d of dropped) {
    // 本章細綱提到的伏筆一律列在那一行裡（復跑之後），整行放不下時點名說它們沒帶上（第 2 條）。
    const named = d.mentioned?.length ? `（其中有本章細綱或計劃提到的伏筆：${d.mentioned.join('、')}，沒帶上）` : '';
    a.reject({ ...base(d), text: '' }, 'dropped', `${d.note}${named}`);
  }
};

/**
 * 故事時間（2026-10-24，設計稿 docs/design/plans/2026-10-24-story-timeline.md「三」）：寫第 N 章時「上一章是哪天」、拆從第 a 章起的
 * 細綱時「已寫到的最後一章是哪天」，一條（id `timeline:<時間線檔案>`、標籤「故事時間」），按「寫到這一章時」算（只看之前的行）。
 * 不佔敘事線的條數與字數（一行幾十個字，不和線搶名額）；訊息裡單獨成一節（builder.ts）。審稿不帶。沒有時間線、或之前一行都推不出：
 * 什麼都不出。
 */
function admitStoryTime(a: Parameters<LayerFn>[0], spec: Parameters<LayerFn>[1], book: ThreadBook): void {
  if (!book.timeline?.exists) {
    return;
  }
  const plot = a.request.action.stage === 'plot';
  const first = plot ? (a.focus.range?.from ?? a.focus.no) : a.focus.no;
  const text = timeContextText(book.timeline, first, plot ? 'plot' : 'write');
  if (!text) {
    return;
  }
  const item = { id: `timeline:${book.timeline.relPath}`, kind: 'thread' as const, priority: spec.priority, label: STORY_TIME_LABEL, source: book.timeline.relPath };
  a.admit(a.excluded.has(item.id) ? { ...item, text: '' } : { ...item, text, note: '按時間線現算' });
}

/**
 * 拆細綱時的敘事線（敘事線二期，設計稿「二」）：細綱的 `plot` 配方（生成、討論、落定共用）P1、`recentFacts` 旁邊。
 * 挑法在 model/threadFile.ts 的 `plotThreads`，**按區間挑**（`focus.range`：批次是那一批，單章是那一章）：
 *
 * - 線一條一個條目（`thread:<那條線的檔案>`），伏筆一條一個條目（`thread:<所在檔案>#<伏筆名>`，與審稿同一個 id 寫法）；
 *   標籤分「敘事線 · 」「伏筆 · 」兩種，訊息裡同一節、伏筆另起一段（builder.ts）。
 * - 兩組各自封頂：線按 `plotThreadCount`、伏筆按 `plotForeshadowCount`，字數各按 `plotThreadChars`；放不下的 dropped 並寫
 *   原因（第 2 條）。伏筆另算一組，是因為「本批要收」的那幾條是這一層最要緊的東西，不該被幾條長的線擠掉。
 * - 伏筆名額外的（2026-10-25）：名字併成一行「其餘沒收的伏筆」，模型知道還有這幾條開著，細綱沒安排就不碰、也不另起同名的
 *   （與規劃時角色圖譜「其餘只列名字」一個道理）。最多列名額的兩倍，再多的連名字也不列，明細裡說清。
 * - 這幾章的細綱（拆細綱的空殼只有梗概，重拆是整份）與作者這一次的話裡提到的伏筆排在前面（`plotThreads` 的 `text`）。
 * - 取消勾選的不佔名額。沒有敘事線、或一條有關的都沒有：什麼都不出。
 */
async function admitPlotThreads(a: Parameters<LayerFn>[0], spec: Parameters<LayerFn>[1], book: ThreadBook): Promise<void> {
  const range = a.focus.range ?? { from: a.focus.no, to: a.focus.no };
  const plots = (await a.project.listPlots()).filter((p) => p.no >= range.from && p.no <= range.to);
  const text = [a.request.ask, ...plots.map((p) => [p.title, ...Object.values(p.sections)].join('\n'))].join('\n');
  const { lines, foreshadowing } = plotThreads(book, range, text);
  const groups: { list: ContextThread[]; what: '敘事線' | '伏筆'; count: number; idOf: (c: ContextThread) => string }[] = [
    { list: lines, what: '敘事線', count: a.limits.plotThreadCount, idOf: (c) => `thread:${c.relPath}` },
    { list: foreshadowing, what: '伏筆', count: a.limits.plotForeshadowCount, idOf: (c) => `thread:${c.relPath}#${c.name}` },
  ];
  for (const { list, what, count, idOf } of groups) {
    const base = (c: ContextThread) => ({
      id: idOf(c),
      kind: 'thread' as const,
      priority: spec.priority,
      label: `${what} · ${c.name}`,
      source: c.relPath,
    });
    const { picked, dropped } = fitThreads(
      list.filter((c) => !a.excluded.has(idOf(c))),
      { count, chars: a.limits.plotThreadChars },
      what
    );
    for (const c of picked) {
      a.admit({ ...base(c), text: c.line, note: `${traditionalLabel(c.status)} · ${traditionalLabel(c.why)}` });
    }
    for (const c of list.filter((x) => a.excluded.has(idOf(x)))) {
      a.admit({ ...base(c), text: '' });
    }
    const listed = new Set<string>();
    if (what === '伏筆' && dropped.length > 0 && count > 0) {
      const max = count * 2;
      const names = dropped.slice(0, max);
      const left = dropped.length - names.length;
      const item = a.admit({
        id: FORESHADOW_REST_ID,
        kind: 'thread',
        priority: spec.priority,
        label: `伏筆 · 其餘 ${dropped.length} 條（只列名字）`,
        text: `其餘沒收的伏筆（名額外，只列名字；細綱沒安排就別揭開，也別另起同名的）：${names.map((d) => d.name).join('、')}${left > 0 ? ` 等 ${dropped.length} 條` : ''}。`,
        note: left > 0 ? `名額外的只列名字，最多 ${max} 個，其餘 ${left} 條連名字也沒列` : '名額外的只列名字',
      });
      if (item.status === 'included') {
        names.forEach((d) => listed.add(idOf(d)));
      }
    }
    for (const d of dropped) {
      a.reject({ ...base(d), text: '' }, 'dropped', listed.has(idOf(d)) ? `${d.note}；名字列在「其餘沒收的伏筆」裡` : d.note);
    }
  }
}

/** 拆細綱時名額外的伏筆只列名字的那一行（{@link admitPlotThreads}）。 */
const FORESHADOW_REST_ID = 'thread:foreshadowing-rest';

/** 一章的片段：定位得到的原文段落在前，定位不到的事實原句在後。 */
function renderEvidence(
  no: number,
  title: string,
  text: string,
  facts: ContinuityFact[]
): { block: string; missing: number } {
  const quoted = facts.filter((f) => f.evidence);
  const { passages, hits } = locateEvidence(text, quoted.map((f) => f.evidence!));
  const lost = [...facts.filter((f) => !f.evidence), ...quoted.filter((_, k) => !hits[k])];
  const parts = [...passages];
  if (lost.length > 0) {
    parts.push(`（下面幾條在正文裡找不到原句，只有事實本身）\n${lost.map((f) => `- ${f.statement}`).join('\n')}`);
  }
  return { block: `【${plotLabel(no, title)}】\n${parts.join('\n\n')}`, missing: lost.length };
}

/** 本章角色（細綱 `characters[]`）的名字與他們卡上的別名。更早的章按它挑事實。 */
function namesOf(cards: CharacterCard[], planned: readonly string[]): string[] {
  const out = new Set<string>();
  for (const name of planned) {
    out.add(name);
    const card = cards.find((c) => c.name === name || c.aliases.includes(name));
    if (card) {
      out.add(card.name);
      card.aliases.forEach((x) => out.add(x));
    }
  }
  return [...out].filter((n) => n.trim().length >= 2);
}

/** 本章角色裡最晚的「當前狀態寫到第幾章」。一個都沒記過時 undefined。 */
function latestState(cards: CharacterCard[], names: readonly string[]): number | undefined {
  const nos = cards
    .filter((c) => names.includes(c.name))
    .map((c) => c.stateThrough)
    .filter((n): n is number => n !== undefined);
  return nos.length > 0 ? Math.max(...nos) : undefined;
}

/**
 * 上一版正文與修改意見：「重寫」與「修稿」（五期）。
 *
 * **整章都帶。** 從前這裡是 `takeTail(…, 3000)`——3000 token 的尾巴，長一點的章前半截直接沒了，
 * 模型只能憑空重寫開頭，明細上還看不出少了什麼（第 2 條）。修稿要求「清單沒指到的地方一字不改」，
 * 手上沒有原文就無從談起。
 */
export const revision: LayerFn = async (a, spec) => {
  const value = a.request.revision;
  if (!value) {
    return;
  }
  const revise = a.request.writeMode === 'revise';
  a.admit(
    {
      id: 'revision',
      kind: 'revision',
      priority: spec.priority,
      label: revise ? '待修稿原文與勾選的審稿意見' : '上一版草稿與修改意見',
      text: revise
        ? `【待修稿原文】\n${value.previousDraft.trim()}\n\n${value.feedback.trim()}`
        : `【上一版草稿】\n${value.previousDraft.trim()}\n\n【修改意見】\n${value.feedback.trim()}`,
    },
    { force: spec.force }
  );
};

/**
 * 待審的這一章正文全文（審稿，五期）。審的就是它，P0 force；這一章還沒有正文時審稿在
 * 生成層就被攔下了（generation/generate.ts），走不到這裡。
 */
export const chapterFull: LayerFn = async (a, spec) => {
  const chapter = a.focus.chapter;
  if (!chapter) {
    return;
  }
  const text = await a.project.readChapterText(chapter);
  if (!text.trim()) {
    return;
  }
  a.admit(
    {
      id: `chapterFull:${a.focus.no}`,
      kind: 'chapterFull',
      priority: spec.priority,
      label: `${plotLabel(a.focus.no, chapter.title)} · 待審正文（${chapter.wordCount} 字）`,
      source: chapter.relPath,
      text: text.trim(),
    },
    { force: spec.force }
  );
};

/**
 * 前幾章定稿留下的連續性事實（審稿，五期）：由近及遠、一章一條，只帶事實文字。
 * 最多幾章、一共幾字按上下文詳細度（`factsChapters` / `factsChars`，預設 12 章 / 3000 字）。
 *
 * 上游審稿讀的是「已定稿歷史的連續性投影」——每一章的要點與事實（RV:121-154），明說它是
 * 「唯一已發生事實源」。這裡對應定稿過的細綱裡的「連續性事實」一節。沒定稿、或定稿之後正文又改過
 * 的章不帶並說清楚：拿一份過期的事實去判「本章與前文矛盾」，判出來的可能正是作者改過的地方。
 */
export const recentFacts: LayerFn = async (a, spec) => {
  const previous = a.focus.previous;
  const { factsChapters, factsChars } = a.limits;
  let budget = factsChars;
  let taken = 0;
  for (let i = previous.length - 1; i >= 0 && taken < factsChapters; i--) {
    const ref = previous[i];
    if (!ref.chapter || ref.chapter.wordCount <= 0) {
      continue;
    }
    taken++;
    const base = {
      id: `facts:${ref.no}`,
      kind: 'facts' as const,
      priority: spec.priority,
      label: `${plotLabel(ref.no, ref.title)} · 連續性事實`,
      source: ref.chapter.relPath,
    };
    if (!isFinalized(ref)) {
      a.reject(
        { ...base, text: '' },
        'dropped',
        ref.plot?.sourceHash ? '同步之後正文又改過，事實不作數' : '這一章還沒同步，沒有連續性事實'
      );
      continue;
    }
    const facts = parseContinuityFacts(ref.plot!.sections.连续性事实);
    if (facts.length === 0) {
      continue;
    }
    const block = `【${plotLabel(ref.no, ref.title)}】\n${facts.map((f) => `- ${f.statement}`).join('\n')}`;
    if (block.length > budget) {
      a.reject({ ...base, text: '' }, 'dropped', `連續性事實一共只帶 ${factsChars} 字，更近的幾章已經用完了`);
      continue;
    }
    const item = a.admit({ ...base, source: ref.plot!.relPath, text: block, note: `${facts.length} 條` });
    if (item.status === 'included') {
      budget -= block.length;
    }
  }
};
