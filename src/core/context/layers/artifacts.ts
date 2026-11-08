import { traditionalLabel } from '../../model/labels';
import { CONTEXT_DETAIL_LABEL, takeLast } from '../../model/contextDetail';
import { plotLabel } from '../../model/pipeline';
import {
  OutlineEntry,
  outlineBrief,
  outlineToSplit,
  outlineWindow,
  renderOutlineEntry,
  renderOutlineWindow,
} from '../../model/outlineFile';
import { isPlotFilled, sectionLine } from '../../model/plotFile';
import {
  PLOT_STRUCTURE_LABEL,
  SETTING_DOC_HEADING,
  SETTING_FILE_DOCS,
  SETTING_SECTION_KEYS,
  SettingFileDoc,
} from '../../model/settingFile';
import { structureGuideText } from '../../model/structureGuide';
import { hasContent, stringifySections } from '../../model/markdown';
import { CharacterCard } from '../../model/types';
import { estimateTokens } from '../tokenizer';
import type { LayerSpec } from '../types';
import type { Assembly, LayerFn } from './assembly';
import {
  cardNote,
  clipLine,
  focusText,
  isLeadCard,
  isPlaceholder,
  matchesKeywords,
  renderPlot,
  renderPlotBrief,
  renderRosterLine,
  selectCharacters,
} from './render';

/*
 * 前序細綱一覽最多帶幾章：按上下文詳細度（`plotListMax`），預設 30（2026-10-24 從 100 降下來：更早的全文大綱已經交代，
 * 兩份各說一遍）。大綱階段只帶第一行的那一段另按 `outlineBriefMax` 封頂（預設 100），更早的看全文大綱。
 */

/** 批次模式下，一覽裡最後幾章寫得詳細些（帶看點）——下一批要緊接著它們往下排。 */
const PLOT_LIST_DETAILED = 3;

function span(from: number, to: number): string {
  return from === to ? `第 ${from} 章` : `第 ${from}–${to} 章`;
}

/**
 * 情節大綱，按遠近帶分三段（model/outlineFile.ts 的 `outlineWindow`，docs/design/plans/2026-10-22-planning-context-bands.md）：
 * 離這一次要寫的地方最近的 10 章帶整條（強制），再往前最多 `outlineBriefMax` 章只帶第一行（不強制，放不下從最老的丟起），
 * 更早的交給全文大綱——從前更早的一章不落地全列、還強制帶，寫到七八百章光這一層就能把視窗撐滿。
 *
 * - 大綱階段（續寫、重寫、討論）：區間之後已經排好的也只帶第一行，接得上（不強制，放不下從最遠的丟起）。
 * - 細綱階段：只帶這一次要拆的（{@link outlineToSplitDoc}）。
 *
 * 一條章標題都認不出（舊格式的區間分節、散文式大綱）就不帶，在明細裡說清（第 2 條）。
 */
export const outlineDoc: LayerFn = async (a, spec) => {
  const outline = a.request.outlineDraft ?? (await a.project.readOutline());
  if (!outline.trim() || isPlaceholder(outline)) {
    return;
  }
  const no = a.focus.no;
  const range = a.request.range ?? (Number.isFinite(no) ? { from: no, to: no } : undefined);
  const planning = a.request.action.stage === 'outline';
  const source = a.project.relPath(a.project.outlinePath);
  const win = outlineWindow(outline, { range, after: planning, maxBefore: a.limits.outlineBriefMax });
  if (!win) {
    a.reject(
      { id: 'outlineDoc', kind: 'outlineDoc', priority: spec.priority, label: '情節大綱', source, text: '' },
      'dropped',
      '認不出「## 第N章：標題」這樣的章標題（區間分節是舊格式，不認），重寫大綱之後才帶'
    );
    return;
  }
  if (!planning && range) {
    await outlineToSplitDoc(a, spec, outline, range, source);
    return;
  }
  // 分段重寫：說清哪幾章是這次剛寫的新版、哪幾章是待重寫的舊版，免得模型照抄舊版。
  const rewriting = a.request.outlineDraft !== undefined && range;
  const start = a.request.outlineRewriteFrom ?? 1;
  const lead = rewriting
    ? `【重寫中】${range.from > start ? `${span(start, range.from - 1)}是這次剛重寫好的新版；` : ''}第 ${range.from} 章起是舊版，${span(range.from, range.to)}正是這一次要重寫的，舊版只作參考。

`
    : '';
  // 近段強制；中段由近及遠、區間之後由近及遠，各自放到預算用完為止（只算一行一行，段落開頭與空行忽略不計）。
  let room = a.remaining - estimateTokens(`${lead}${renderOutlineWindow({ before: [], near: win.near, later: [] })}`);
  const fit = (list: OutlineEntry[]): OutlineEntry[] => {
    const kept: OutlineEntry[] = [];
    for (const e of list) {
      const cost = estimateTokens(`- ${outlineBrief(e)}\n`);
      if (cost > room) {
        break;
      }
      room -= cost;
      kept.push(e);
    }
    return kept;
  };
  const before = fit([...win.before].reverse()).reverse();
  const later = fit(win.later);
  const cut = [...win.before.slice(0, win.before.length - before.length), ...win.later.slice(later.length)].map((e) => e.no);
  const brief = [...before, ...later].map((e) => e.no);
  const notes = [
    rewriting ? `分段重寫：第 ${range.from} 章以前是新版，以後是舊版` : '',
    brief.length > 0 ? `${spansOf(brief)}只帶第一行，${win.near.length > 0 ? `${spansOf(win.near.map((e) => e.no))}帶整條` : '其餘不帶'}` : '',
    win.folded.length > 0
      ? await foldedNote(
          a,
          `${spansOf(win.folded)}沒逐章列（一章一行最多 ${a.limits.outlineBriefMax} 章，上下文詳細度「${CONTEXT_DETAIL_LABEL[a.detail]}」）`,
          win.folded
        )
      : '',
    cut.length > 0 ? `預算不足，${spansOf(cut)}沒帶` : '',
  ].filter(Boolean);
  const item = {
    id: 'outlineDoc',
    kind: 'outlineDoc' as const,
    priority: spec.priority,
    label: rewriting ? '情節大綱（重寫中）' : '情節大綱',
    source,
    text: `${lead}${renderOutlineWindow({ before, near: win.near, later })}`,
    note: notes.length > 0 ? notes.join('；') : undefined,
  };
  if (cut.length > 0 && !a.excluded.has(item.id)) {
    a.accept({ ...item, status: 'degraded' }, estimateTokens(item.text));
    return;
  }
  a.admit(item, { force: spec.force });
};

/**
 * 拆細綱時的大綱：只帶這一次要拆的（`outlineToSplit`）——批次是區間裡那幾條，外加區間前面還沒拆的空殼；單章時這一章的
 * 梗概已經在本章細綱裡，只剩前面的空殼，一條都沒有就不出這一層。已經拆過的章前序細綱一覽（與單章時的前幾章細綱）
 * 帶了，從前這裡再帶一遍它們的梗概，同一份細綱進了兩次。
 */
async function outlineToSplitDoc(
  a: Assembly,
  spec: LayerSpec,
  outline: string,
  range: { from: number; to: number },
  source: string
): Promise<void> {
  const stubs = new Set(a.focus.previous.filter((c) => c.plot && !isPlotFilled(c.plot.sections)).map((c) => c.no));
  const entries = outlineToSplit(outline, range, { stubs, skip: a.request.range ? undefined : range.from });
  if (entries.length === 0) {
    return;
  }
  const early = entries.filter((e) => e.no < range.from).map((e) => e.no);
  a.admit(
    {
      id: 'outlineDoc',
      kind: 'outlineDoc',
      priority: spec.priority,
      label: '情節大綱',
      source,
      text: entries.map(renderOutlineEntry).join('\n\n'),
      note: [
        early.length > 0 ? `${spansOf(early)}還沒拆細綱，帶梗概` : '',
        `只帶這一次要拆的：已經拆過的章看前序細綱一覽，第 ${range.to} 章以後的不帶`,
      ]
        .filter(Boolean)
        .join('；'),
    },
    { force: spec.force }
  );
}

/**
 * 遠段不逐章列、交給全文大綱：`head` 說清按哪一級封的頂，後面接全文大綱接不接得住——沒有、或沒寫到那裡時照實說
 * （第 2 條）。不自動更新全文大綱（第 4 條）。
 */
async function foldedNote(a: Assembly, head: string, folded: number[]): Promise<string> {
  const summary = await a.project.readGlobalSummary();
  if (!summary.trim() || isPlaceholder(summary)) {
    return `${head}，還沒有全文大綱：${spansOf(folded)}這次沒帶`;
  }
  const upTo = folded[folded.length - 1];
  const through = (await a.project.readManifest()).globalSummaryThrough ?? 0;
  return through > 0 && through < upTo
    ? `${head}，更早的看全文大綱；全文大綱只寫到第 ${through} 章：${span(Math.max(through + 1, folded[0]), upTo)}這次沒帶`
    : `${head}，更早的看全文大綱`;
}

/** `[1,2,3,7,8]` → 「第 1–3 章、第 7–8 章」。 */
function spansOf(nos: number[]): string {
  const runs: [number, number][] = [];
  for (const n of nos) {
    const last = runs[runs.length - 1];
    if (last && n === last[1] + 1) {
      last[1] = n;
    } else {
      runs.push([n, n]);
    }
  }
  return runs.map(([from, to]) => span(from, to)).join('、');
}

/**
 * 架構層的三份文件（小說配置 / 故事前提 / 世界觀），填過的才帶。
 *
 * 一件一條：作者在明細裡能單獨取消某一件（比如重寫前提時不想讓舊前提帶偏模型）。
 * 正在生成的那一件也照帶——目標已有內容時再生成，那一版就是修改的底稿。
 */
export const settingDocs: LayerFn = async (a, spec) => {
  await admitSettingDocs(a, spec);
};

/**
 * 寫正文用的架構：小說配置（**除全域要求**）、故事前提、世界觀，一件一條。
 *
 * 與 `settingDocs` 同一份取數，只少一節：「全域要求」由 `guidance` 層單獨強制帶（P0），
 * 這裡再帶一遍就是同一段規則出現兩次。整層是 P1——寫一章正文時，本章細綱、上一章結尾
 * 與文風比架構的全文要緊，放不下時讓它先讓。
 */
export const premiseWorld: LayerFn = async (a, spec) => {
  await admitSettingDocs(a, spec, { config: [GUIDANCE_KEY] });
};

/** 「全域要求」那一節的小節名。 */
const GUIDANCE_KEY = '全局要求';

async function admitSettingDocs(a: Assembly, spec: LayerSpec, omit: Partial<Record<SettingFileDoc, string[]>> = {}): Promise<void> {
  for (const doc of SETTING_FILE_DOCS) {
    const parsed = await a.project.readSettingDoc(doc);
    const keys = SETTING_SECTION_KEYS[doc].filter((k) => !(omit[doc] ?? []).includes(k));
    const body = stringifySections(parsed.sections, keys);
    if (!body.trim()) {
      continue;
    }
    a.admit(
      {
        id: `setting:${doc}`,
        kind: 'setting',
        priority: spec.priority,
        label: SETTING_DOC_HEADING[doc],
        source: parsed.relPath,
        text: `【${SETTING_DOC_HEADING[doc]}】\n${body}`,
        note: omit[doc]?.length ? `不含${omit[doc]!.map((k) => `「${traditionalLabel(k)}」`).join('')}（單獨帶）` : undefined,
      },
      { force: spec.force }
    );
  }
}

/**
 * 小說配置裡的「全域要求」：跨章有效的寫作規則（「不寫上帝視角」「每章結尾留一個未決的問題」）。
 *
 * 上游每一章正文都帶它（`next_chapter_draft` 的 `global_guidance`，PT:827），而且是作者
 * 定下的規矩——寫正文時強制帶、單獨成段，不和架構的其餘幾節一起排隊。
 */
export const guidance: LayerFn = async (a, spec) => {
  const parsed = await a.project.readSettingDoc('config');
  const text = parsed.sections[GUIDANCE_KEY]?.trim() ?? '';
  if (!hasContent(text)) {
    return;
  }
  a.admit(
    {
      id: 'guidance',
      kind: 'guidance',
      priority: spec.priority,
      label: '全局要求',
      source: parsed.relPath,
      text,
    },
    { force: spec.force }
  );
};

/**
 * 角色圖譜一覽：角色卡壓成一人一段（名字、定位、身份、人物關係、當前狀態）。
 *
 * 架構的後幾件、大綱、細綱批次都要知道「這本書裡有誰、彼此什麼關係」，但用不著每個人的
 * 外貌與語言習慣——那是寫正文時的事（正文層帶的是完整角色卡）。每段截短寫在明細裡。
 *
 * 架構階段全員一人一段：幾件一件吃一件，世界觀、設定清單要照著所有人寫。規劃時（大綱、細綱，2026-10-24）
 * 只給近期活躍的一段，其餘只列名字（{@link splitPlanningRoster}）——寫到八十章、四十幾張卡時，全員一人一段就上萬
 * token，大半是早就退場的人，而上下文詳細度調到哪一級都不少一個字。
 */
export const rosterDoc: LayerFn = async (a, spec) => {
  const cards = await a.project.listCharacters();
  if (cards.length === 0) {
    return;
  }
  const { stage } = a.request.action;
  const split = stage === 'outline' || stage === 'plot' ? await splitPlanningRoster(a, cards) : undefined;
  const base = {
    id: 'roster',
    kind: 'setting' as const,
    priority: spec.priority,
    label: `角色圖譜（${cards.length} 人）`,
    source: a.project.relPath(a.project.charactersDir),
  };
  if (!split) {
    a.admit(
      {
        ...base,
        text: `【角色圖譜】\n${cards.map(renderRosterLine).join('\n')}`,
        note: '每人只取身份、人物關係、當前狀態的開頭；完整角色卡在正文層才帶',
      },
      { force: spec.force }
    );
    return;
  }
  const { full, carded, named } = split;
  const recent = a.limits.rosterRecent;
  const text = [
    '【角色圖譜】',
    ...full.map(renderRosterLine),
    carded.length > 0 ? `整張卡在下面「相關角色設定」裡：${carded.map((c) => c.name).join('、')}。` : '',
    named.length > 0
      ? `其餘角色（近 ${recent} 章沒出場，只列名字；再出場時照用這些名字）：${named.map((c) => `${c.name}${cardNote(c)}`).join('、')}。`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  const note = [
    full.length > 0 ? `${full.length} 人（主角、近 ${recent} 章出場的、這一次提到的）取身份、人物關係、當前狀態的開頭` : '',
    carded.length > 0 ? `整張卡在「相關角色設定」的 ${carded.length} 人只點名` : '',
    named.length > 0 ? `其餘 ${named.length} 人只列名字` : '',
  ]
    .filter(Boolean)
    .join('；');
  a.admit({ ...base, text, note: `${note}（上下文詳細度「${CONTEXT_DETAIL_LABEL[a.detail]}」）` }, { force: spec.force });
};

/**
 * 規劃時角色圖譜怎麼分三撥：
 *
 * - **一段**（身份、關係、當前狀態的開頭）：主角，近 `rosterRecent` 章的細綱裡出場或在梗概裡提到的（往前數這麼多章，
 *   連同這一次要排的那幾章——拆細綱的空殼、重寫大綱的舊版），以及作者這一次的話裡提到的。
 * - **只點名**：角色卡層（`characters`，同一份 `selectCharacters`）整張帶的那幾個人，一段再帶一遍就重複了。「精簡」那一級
 *   角色卡只帶要點、沒有人物關係，不點名、照給一段；作者在明細裡取消了的那張卡也照給一段。
 * - **只列名字**：其餘的人。名字還在，模型排到他們時照用、不另起一個。
 *
 * 返回 undefined 時全員一段（與架構階段一樣）：「完整」那一級；或者往前數這麼多章都沒有細綱可看（剛開書、老工程只有正文）——
 * 那時誰算活躍無從判斷，寧可多帶。
 */
async function splitPlanningRoster(
  a: Assembly,
  cards: CharacterCard[]
): Promise<{ full: CharacterCard[]; carded: CharacterCard[]; named: CharacterCard[] } | undefined> {
  const recent = a.limits.rosterRecent;
  if (!Number.isFinite(recent)) {
    return undefined;
  }
  const plots = await a.project.listPlots();
  // 這一次落在哪幾章：拆細綱是那一批（單章就是這一章），續寫、重寫大綱是給的區間，討論大綱時接在已有的最後一章後面。
  const last = plots.reduce((max, p) => Math.max(max, p.no), 0);
  const range = a.focus.range ?? a.request.range ?? { from: last + 1, to: last + 1 };
  const seen = plots
    .filter((p) => p.no >= range.from - recent && p.no <= range.to)
    .map((p) => [...p.characters, p.sections.出场人物 ?? '', p.sections.梗概 ?? ''].join('\n'))
    .filter((t) => t.trim());
  if (seen.length === 0) {
    return undefined;
  }
  const haystacks = [a.request.ask, focusText(a.focus), ...seen];
  const carded = a.limits.essentialCards
    ? []
    : selectCharacters(cards, a.request.ask, a.focus, a.limits.castSummaries)
        .map((h) => h.card)
        .filter((c) => !a.excluded.has(`character:${c.slug}`));
  const deferred = new Set(carded.map((c) => c.slug));
  const full: CharacterCard[] = [];
  const named: CharacterCard[] = [];
  for (const card of cards) {
    if (deferred.has(card.slug)) {
      continue;
    }
    const names = [card.name, ...card.aliases];
    const active = isLeadCard(card) || haystacks.some((h) => matchesKeywords(h, names));
    (active ? full : named).push(card);
  }
  // 一個都沒省下來就是全員一段：說法與架構階段一樣，不另報。
  return carded.length === 0 && named.length === 0 ? undefined : { full, carded, named };
}

/**
 * 故事結構指導：按總章數算好的章號區間（model/structureGuide.ts）。
 *
 * 大綱層要它排結構拐點；細綱層要它知道這一批落在結構的哪一段。沒寫總章數就算不出
 * 區間——不帶，並在明細裡說清是為什麼。
 */
export const structure: LayerFn = async (a, spec) => {
  const total = a.request.setup?.totalChapters ?? a.book.totalChapters;
  const base = {
    id: 'structure',
    kind: 'guide' as const,
    priority: spec.priority,
    label: `故事結構指導 · ${PLOT_STRUCTURE_LABEL[a.book.structure ?? 'three_act']}`,
    source: a.book.relPath || undefined,
  };
  if (!total) {
    a.reject({ ...base, text: '' }, 'dropped', '小說配置裡沒寫總章數，算不出章號區間');
    return;
  }
  a.admit({ ...base, text: structureGuideText(a.book.structure, total, a.request.range) }, { force: spec.force });
};

/**
 * 前序細綱一覽：一章一行的目錄進度（上游 `chapter_blueprint_chunk` 的 chapter_list）。
 *
 * - **單章**時，緊挨著的前幾章由 `plotPrev` 詳細帶，這裡只列更早的那些；
 * - **批次**時 `plotPrev` 不出場，這裡全包：更早的一章一行，最後幾章帶上看點（爽點與章末
 *   吊著讀者的東西）——下一批要緊接著它們往下排。生成鏈裡剛排好、還沒落盤的那幾章（`draftPlots`，
 *   拆半重試時的前一半）接在最後。
 * - 最多 `plotListMax` 章，更早的看全文大綱（明細裡說清它寫到哪）；預算不夠時從最老的丟起，不整份丟
 *   （第 4 級不封頂，幾百章的書照樣帶得出最近那一截）。
 */
export const plotList: LayerFn = async (a, spec) => {
  const batch = !!a.request.range;
  const skip = new Set(batch ? [] : a.focus.prevPlots.map((c) => c.no));
  const disk = a.focus.previous
    .filter((c) => c.plot && isPlotFilled(c.plot.sections) && !skip.has(c.no))
    .map((c) => ({
      no: c.no,
      title: c.plot!.title || c.title,
      keyEvents: c.plot!.sections.关键事件,
      highlights: c.plot!.sections.看点,
      draft: false,
    }));
  const drafts = (a.request.draftPlots ?? []).map((d) => ({ ...d, draft: true }));
  const all = [...disk, ...drafts];
  const rows = takeLast(all, a.limits.plotListMax);
  if (rows.length === 0) {
    return;
  }
  const detailedFrom = batch ? rows.length - PLOT_LIST_DETAILED : rows.length;
  // 關鍵事件、看點都是一條一行的列表：一章一行時條與條之間用「；」接。
  const lines = rows.map((r, i) => {
    const head = `第${r.no}章 ${r.title || '（未命名）'}${r.draft ? '（剛排好，還沒寫入檔案）' : ''}`;
    const events = sectionLine(r.keyEvents);
    const highlights = sectionLine(r.highlights);
    return i >= detailedFrom
      ? `${head}：${clipLine(events, 400)}${highlights ? `｜看點：${clipLine(highlights, 120)}` : ''}`
      : `${head}：${clipLine(events, 120)}`;
  });
  // 由近及遠放到預算用完為止；強制帶時整份帶。
  let kept = rows.length;
  if (!spec.force) {
    let room = a.remaining;
    kept = 0;
    while (kept < lines.length) {
      const cost = estimateTokens(`${lines[lines.length - 1 - kept]}\n`);
      if (cost > room) {
        break;
      }
      room -= cost;
      kept++;
    }
  }
  // 一行都放不下：整份交給 admit 判 dropped，寫明需要多少、剩多少。
  const trimmed = kept > 0 && kept < rows.length;
  const shown = trimmed ? rows.slice(rows.length - kept) : rows;
  const folded = all.slice(0, all.length - rows.length).map((r) => r.no);
  const notes = [
    folded.length > 0
      ? await foldedNote(a, `只帶最近 ${a.limits.plotListMax} 章（上下文詳細度「${CONTEXT_DETAIL_LABEL[a.detail]}」）`, folded)
      : '',
    trimmed ? `預算不足，${spansOf(rows.slice(0, rows.length - kept).map((r) => r.no))}沒帶` : '',
  ].filter(Boolean);
  const item = {
    id: 'plotList',
    kind: 'plotList' as const,
    priority: spec.priority,
    label: `前序細綱一覽（${shown.length} 章）`,
    text: lines.slice(lines.length - shown.length).join('\n'),
    note: notes.length > 0 ? notes.join('；') : undefined,
  };
  if (trimmed && !a.excluded.has(item.id)) {
    a.accept({ ...item, status: 'degraded' }, estimateTokens(item.text));
    return;
  }
  a.admit(item, { force: spec.force });
};

export const plotSelf: LayerFn = async (a, spec) => {
  const plot = a.focus.plot;
  // 批次（給了區間）沒有「本章」：區間第一章那份多半是個空殼，帶上只會讓模型以為只寫它。
  if (!plot || a.request.range) {
    return;
  }
  a.admit(
    {
      id: `plot:${plot.relPath}`,
      kind: 'plot',
      priority: spec.priority,
      label: `${plotLabel(plot.no, plot.title)} · 細綱`,
      source: plot.relPath,
      text: renderPlot(plot),
    },
    { force: spec.force }
  );
};

/**
 * 前幾章的細綱（上文）。
 *
 * 帶梗概、關鍵事件與狀態變更（`renderPlotBrief`）：梗概說「林昭進了宗門」，關鍵事件說「他是靠
 * 那半枚令牌被破例放進去的」，狀態變更說他此刻落在什麼處境——接著往下排的人三樣都要。
 * 更早的章由前序細綱一覽一章一行帶。
 *
 * `focus.prevPlots` 已經濾掉沒有細綱的章（老工程裡那些），所以這裡的
 * `c.plot` 一定在。
 *
 * 寫正文時（2026-10-21）這是唯一帶的前幾章細綱：更早幾十章的細綱不再帶。條目記成 `plotSummary`，
 * 在「前幾章細綱」單列一節——和本章細綱混在「細綱」一節裡，模型分不清哪份是這一章要寫的。還沒定稿的
 * 塊頭標「計劃」（模型才不會把計劃當成已經發生的事）；定稿之後正文又改過的在明細裡打 ⚠。
 */
export const plotPrev: LayerFn = async (a, spec) => {
  // 批次時由前序細綱一覽全包（見 `plotList`）。
  if (a.request.range) {
    return;
  }
  const writing = a.request.action.stage === 'manuscript';
  for (const { plot, chapter } of a.focus.prevPlots) {
    if (!plot) {
      continue;
    }
    const planned = writing && !plot.sourceHash;
    // 定稿的上游是正文，直接比它的 hash——不必再讀一遍正文。
    const drifted = writing && !!plot.sourceHash && !!chapter && plot.sourceHash !== chapter.contentHash;
    a.admit({
      id: `plot:${plot.relPath}`,
      kind: writing ? 'plotSummary' : 'plot',
      priority: spec.priority,
      label: `${plotLabel(plot.no, plot.title)} · 細綱（上文）`,
      source: plot.relPath,
      text: renderPlotBrief(plot, '上文', planned ? '計劃' : undefined),
      note: planned ? '還沒同步：帶的是寫之前的計劃' : drifted ? '⚠ 同步之後正文又改過，這份細綱可能沒跟上' : undefined,
    });
  }
};

/**
 * 後一章的細綱（下文）。
 *
 * 只在它已經排過的時候才有——多數時候是在往後寫，這一層就是空的。但改中間
 * 某一章時它是關鍵：不知道後面已經定了什麼，模型會把收尾寫到一個下一章接不上
 * 的局面，讀起來就是「轉折突兀」。
 */
export const plotNext: LayerFn = async (a, spec) => {
  for (const { plot } of a.focus.nextPlots) {
    if (!plot) {
      continue;
    }
    a.admit({
      id: `plot:${plot.relPath}`,
      kind: 'plot',
      priority: spec.priority,
      label: `${plotLabel(plot.no, plot.title)} · 細綱（下文）`,
      source: plot.relPath,
      text: renderPlotBrief(plot, '下文'),
    });
  }
};

/** 邊界裡每一章的關鍵事件截到多長：夠看出「那一章要發生什麼」，又不至於把它寫成第二份細綱。 */
const AHEAD_EVENT_CHARS = 300;

/**
 * 後 5 章的細綱，一章一行：寫正文時的**邊界**。移植自 AI-Novel-Writer 的「後續章節大綱
 * 預告（僅供瞭解後續劇情發力點，請絕對不要在本章提前寫出後續內容！）」（PT:744、816；
 * 取數 GD:456-474）。
 *
 * 不帶它，模型寫到這一章的鉤子時手上沒有「後面要發生什麼」，最順手的做法就是把下一章
 * 的事提前演掉——下一章於是無事可寫。P0：這一層管的是整條流水線的節奏，不是錦上添花。
 *
 * 只帶排過細綱的章（空殼裡沒有可當邊界的事），按章號視窗取（focus.ts 的 `AHEAD_PLOTS`）。
 */
export const plotAhead: LayerFn = async (a, spec) => {
  const ahead = a.focus.aheadPlots;
  if (ahead.length === 0) {
    return;
  }
  const lines = ahead.map(({ no, plot }) => {
    const title = plot!.title ? ` ${plot!.title}` : '';
    return `第${no}章${title}：${clipLine(sectionLine(plot!.sections.关键事件), AHEAD_EVENT_CHARS)}`;
  });
  const first = ahead[0].no;
  const last = ahead[ahead.length - 1].no;
  a.admit(
    {
      id: `plotAhead:${first}-${last}`,
      kind: 'boundary',
      priority: spec.priority,
      label: `後續章節細綱 · ${span(first, last)}（邊界）`,
      text: lines.join('\n'),
      note: '只為讓模型知道後面要發生什麼、不在本章提前寫掉',
    },
    { force: spec.force }
  );
};
