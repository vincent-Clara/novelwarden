/**
 * 產物解析：模型的一坨輸出 → 可以採納落盤的結構化產物。
 *
 * ## 為什麼要單獨一層
 *
 * `generate` / `settle` 兩個能力產出的是**要寫進檔案的東西**，不是聊天氣泡。
 * 寫進檔案就意味著解析失敗＝這一次生成白花錢，而且使用者看著一段像模像樣的回答
 * 卻等不來那張「寫入嗎」的卡片，只會以為是外掛壞了。
 *
 * 所以沿用定稿那一套**三層降級**（summarize.ts 的 parseSummaryResponse）：
 *
 * 1. **JSON**——提示詞要求的形狀。欄位缺失、型別不對、陣列/字串混用逐個兜住，
 *    不整體作廢。
 * 2. **Markdown 小節**——模型忽略 JSON 要求、改用 `## 關鍵事件` 時走這條。
 *    作者手改過的產物重新解析時也走這條。
 * 3. **全文塞進主欄位**——資訊密度低，但比讓這次生成徹底作廢強。
 *
 * ## 解析不落盤
 *
 * 這裡只把文字變成物件，**一個字都不寫磁碟**。落盤在 `generation/accept.ts`，
 * 且必須由使用者在那張許可權卡片上點了「寫入」才發生（AGENTS.md 第 3 / 19 條：
 * 不靜默覆蓋、產物落盤前必須過一遍人）。分開還有一個好處：產出先攤在氣泡裡
 * 給他看，他改兩個字再點寫入。
 *
 * ## 多步生成交來的是規範化結果
 *
 * 小說配置、角色圖譜、設定清單、細綱批次由生成鏈（generation/structured.ts）分幾次呼叫拼出來，
 * 交到氣泡裡的是**將要落盤的樣子**：配置是 `config.md` 全文、角色圖譜、設定清單與細綱批次是
 * 規範化的 JSON。這裡認那幾種形狀，也認模型第一次呼叫的原樣輸出（agent 那條路、
 * 老會話），並照舊三層降級。合同本身在 features/blueprint.ts、roster.ts、loreList.ts、novelConfig.ts。
 */
import { normalizeGender } from '../model/gender';
import { hasContent, parseMarkdown, pickSections } from '../model/markdown';
import { PLOT_SECTION_KEYS, PlotSections, emptyPlotSections } from '../model/plotFile';
import { LORE_BODY_KEYS, LoreLine, loreLinesFromJson, normalizeLoreName, splitLoreHidden } from '../model/loreFile';
import { PlanEntry, decodePlanEntries } from '../model/threadFile';
import {
  BookConfig,
  NARRATIVE_POVS,
  NarrativePov,
  PLOT_STRUCTURES,
  PlotStructure,
  SETTING_SECTION_KEYS,
  SettingFileDoc,
  parseBookConfig,
} from '../model/settingFile';
import { CHARACTER_SECTION_KEYS, CharacterSections } from '../model/types';
import { CreationAction, CreationTarget, SettingDoc } from '../model/pipeline';
import { BlueprintItem, decodeBlueprints, keyEventList } from './blueprint';
import { LoreDraft, parseLoreExpansion } from './loreExpand';
import { parseLoreSettle } from './loreSettle';
import { LoreListEntry, parseLoreList } from './loreList';
import { STYLE_DRAFT_HEADING, decodeNovelConfig } from './novelConfig';
import { extractJsonObject, stripCodeFence } from './parse';
import type { RosterEntry } from './roster';
import { toSectionText } from './summarize';

export type { RosterEntry, LoreListEntry, LoreDraft };

// ---------------------------------------------------------------- 產物形狀

/** 配置的 frontmatter 欄位。產物給了就用產物的，沒給就沿用磁碟那份。 */
export type ConfigFields = Partial<
  Pick<
    BookConfig,
    'genre' | 'subGenre' | 'audience' | 'structure' | 'pov' | 'totalChapters' | 'wordsPerChapter' | 'paragraphStyle'
  >
>;

/** 一章細綱：七節，外加檔名要用的標題與目標字數。出場的人就寫在「出場人物」一節裡。 */
export interface PlotFields {
  sections: PlotSections;
  title?: string;
  targetWords?: number;
  /** 「設定」一節（計劃用到、要引入的設定）。沒帶就沿用磁碟那份（handlers/plot.ts）。 */
  lore?: LoreLine[];
  /**
   * 「設定」一節裡 `isNew` 的那幾行（本章首次引入、後面還會用到的新設定）：採納單章細綱時建空條目（完善設定 §3，
   * 同批次拆細綱的 `createPlannedLore`）。不寫進細綱檔案——那裡只有 `lore`。
   */
  newLore?: LoreLine[];
  /**
   * 這一章在敘事線上的計劃（細綱合同的 `threads`，敘事線二期）：寫入時整組換掉各條線裡這一章的計劃事件
   * （features/threadPlan.ts）。不寫進細綱檔案。undefined = 合同裡沒寫這個欄位（手寫的 Markdown、老會話的草稿）：不動原來的計劃。
   */
  threads?: PlanEntry[];
  /** `threads` 裡沒收的那幾條（型別不對、沒寫是哪條線……）：卡片上與寫入時的日誌裡說出來（第 2 條）。 */
  planNotes?: string[];
}

/**
 * 解析出來的產物。`kind` 與 `CreationTarget.kind` 不完全對應：架構層五件裡
 * 「角色圖譜」產出的是一組角色卡、「設定清單」產出的是一組設定條目（外加分類目錄），其餘三件是一份文件。
 */
export type Artifact =
  | {
      kind: 'settingDoc';
      doc: SettingFileDoc;
      sections: Record<string, string>;
      config?: ConfigFields;
      /** 配置草稿裡附帶的文風：只在 `style.md` 空著時寫過去（D14）。 */
      style?: string;
    }
  | { kind: 'characterRoster'; characters: RosterEntry[] }
  /** 設定清單：本書的分類目錄（落盤時建成 `lore/` 下的目錄，空的也建）與條目。 */
  | { kind: 'loreList'; categories: string[]; entries: LoreListEntry[] }
  /**
   * 一批要落盤的設定條目（完善設定，2026-10-19）。展開一條設定時第一項是目標條目（按 `relPath` 認），
   * 其餘是建議拆出來的子條目（建空條目）。`questions` 是還沒定、要作者拍板的問題：**只上卡片，不落盤**。
   *
   * `settle`：落定設定（二期）交來的一批——新建的與改已有的（帶 `relPath`）都在裡面，沒有「目標條目」與子條目之分，
   * 落盤走另一條路（generation/loreSettle.ts）。
   */
  | { kind: 'loreEntries'; entries: LoreDraft[]; questions: string[]; settle?: boolean }
  /** `range` 給了就只替換大綱裡落在這一段的那幾條（model/outlineFile.ts 的 `mergeOutline`）。 */
  | { kind: 'outlineDoc'; text: string; range?: ChapterRange }
  | ({ kind: 'plot' } & PlotFields)
  /** 一批細綱：一章一份，按章號升序，只含區間內的章。 */
  | { kind: 'plotBatch'; items: BlueprintItem[]; range: ChapterRange }
  | { kind: 'manuscript'; text: string };

/** 章號閉區間。 */
export interface ChapterRange {
  from: number;
  to: number;
}

/**
 * 按 action 解析。**絕不拋**：解析這一步出異常，使用者丟的是剛花掉的那次呼叫。
 * 實在認不出就退回一個「全文塞進主欄位」的產物，讓他至少能手工取用。
 *
 * 架構層要看 target 才分得清是哪一件（五件同屬一個階段）；其餘階段只看 action。單條設定（展開）也在架構層，
 * 按目標認，**不做全文兜底**：解析不了就是空的，沒有落盤卡片（{@link parseLoreExpansion}）。落定設定（二期）
 * 按能力認、排在設定清單（`doc === 'lore'`）之前——兩者目標相同，同樣不做全文兜底（{@link parseLoreSettle}）。
 *
 * `range` 只對兩層有意義：大綱（續寫的那一段，落盤時按區間合併）與細綱（**給了區間
 * 就是一批**，按批次合同嚴格解碼，不做全文兜底——見 {@link parsePlotStrict} 為什麼）。
 */
export function parseArtifact(
  action: CreationAction,
  raw: string,
  target?: CreationTarget,
  range?: ChapterRange
): Artifact {
  const text = stripCodeFence(raw).trim();
  switch (action.stage) {
    case 'manuscript':
      return { kind: 'manuscript', text };
    case 'outline':
      // 大綱是 Markdown，沒有 JSON 可解——原樣收下。
      return range ? { kind: 'outlineDoc', text, range } : { kind: 'outlineDoc', text };
    case 'plot':
      if (range && action.capability === 'generate') {
        return { kind: 'plotBatch', items: parsePlotBatch(text, range), range };
      }
      return { kind: 'plot', ...(parsePlotStrict(text) ?? { sections: { ...emptyPlotSections(), 关键事件: text } }) };
    case 'setting': {
      if (action.capability === 'settle') {
        return { kind: 'loreEntries', settle: true, ...parseLoreSettle(text) };
      }
      if (target?.kind === 'lore') {
        return { kind: 'loreEntries', ...parseLoreExpansion(text, target.relPath) };
      }
      const doc: SettingDoc = target?.kind === 'setting' ? target.doc : 'config';
      if (doc === 'characters') {
        return { kind: 'characterRoster', characters: parseRoster(text) };
      }
      return doc === 'lore' ? { kind: 'loreList', ...parseLoreList(text) } : parseSettingArtifact(doc, text);
    }
  }
}

/** 產物是不是空的。空產物不必問「寫不寫」——寫下去只會得到一個空檔案。 */
export function isArtifactEmpty(artifact: Artifact): boolean {
  switch (artifact.kind) {
    case 'outlineDoc':
    case 'manuscript':
      return !artifact.text.trim();
    case 'settingDoc':
      return !Object.values(artifact.sections).some((v) => v.trim());
    case 'characterRoster':
      return artifact.characters.length === 0;
    case 'loreList':
      return artifact.entries.length === 0;
    case 'loreEntries':
      return artifact.entries.length === 0;
    case 'plot':
      return !Object.values(artifact.sections).some((v) => v.trim());
    case 'plotBatch':
      return artifact.items.length === 0;
  }
}

/** 一句話描述，給落盤卡片與氣泡末尾那一行用（「細綱 · 6/7 節」「角色圖譜 · 5 人」）。 */
export function describeArtifact(artifact: Artifact): string {
  switch (artifact.kind) {
    case 'settingDoc': {
      const keys = SETTING_SECTION_KEYS[artifact.doc];
      const filled = keys.filter((k) => artifact.sections[k]?.trim()).length;
      return `${SETTING_TITLE[artifact.doc]} · ${filled}/${keys.length} 節`;
    }
    case 'characterRoster':
      return `角色圖譜 · ${artifact.characters.length} 人`;
    case 'loreList':
      return `設定清單 · ${artifact.entries.length} 條 · ${artifact.categories.length} 個分類`;
    case 'loreEntries':
      return describeLoreEntries(artifact);
    case 'outlineDoc':
      return `情節大綱 · ${artifact.text.length} 字`;
    case 'plot': {
      const filled = Object.values(artifact.sections).filter((v) => v.trim()).length;
      return `細綱 · ${filled}/${PLOT_SECTION_KEYS.length} 節`;
    }
    case 'plotBatch': {
      const nos = artifact.items.map((b) => b.no);
      const span = nos.length > 1 ? `第 ${nos[0]}–${nos[nos.length - 1]} 章` : `第 ${nos[0]} 章`;
      const fresh = new Set(artifact.items.flatMap((b) => b.newCharacters.map((c) => c.name))).size;
      return `細綱 · ${span}（${nos.length} 章）${fresh > 0 ? ` · 新角色 ${fresh} 人` : ''}`;
    }
    case 'manuscript':
      return `正文 · ${artifact.text.length} 字`;
  }
}

/** 寫成「（未交代）」的節不算展開了。 */
const UNTOLD = /^[（(]\s*未交代\s*[)）]$/u;

/**
 * 「設定 · 天機閣 · 展開 3/3 節 + 暗設 · 拆出 2 條 · 還沒定的 3 問」；落定設定是「落定設定 · 4 條（改已有的 1 條）·
 * 還沒定的 2 問」（改不改已有的按氣泡裡帶沒帶路徑算，落盤時還會按磁碟再認一遍，卡片上那兩行以那一遍為準）。
 */
function describeLoreEntries(artifact: Extract<Artifact, { kind: 'loreEntries' }>): string {
  const [head, ...rest] = artifact.entries;
  const parts: string[] = [];
  if (artifact.settle) {
    const old = artifact.entries.filter((e) => e.relPath).length;
    parts.push(`落定設定 · ${artifact.entries.length} 條${old > 0 ? `（改已有的 ${old} 條）` : ''}`);
  } else if (head?.relPath) {
    const { visible, hidden } = splitLoreHidden(head.body);
    const filled = pickSections(visible, LORE_BODY_KEYS);
    const n = LORE_BODY_KEYS.filter((k) => hasContent(filled[k]) && !UNTOLD.test(filled[k].trim())).length;
    parts.push(`設定 · ${head.title} · 展開 ${n}/${LORE_BODY_KEYS.length} 節${hidden ? ' + 暗設' : ''}`);
  } else {
    parts.push(`設定 · ${artifact.entries.length} 條`);
  }
  if (!artifact.settle && head?.relPath && rest.length > 0) {
    parts.push(`拆出 ${rest.length} 條`);
  }
  if (artifact.questions.length > 0) {
    parts.push(`還沒定的 ${artifact.questions.length} 問`);
  }
  return parts.join(' · ');
}

const SETTING_TITLE: Record<SettingFileDoc, string> = {
  config: '小說配置',
  premise: '故事前提',
  world: '世界觀',
};

// ---------------------------------------------------------------- 細綱

/** JSON 裡七節的別名：藍圖合同用的是英文鍵。 */
const PLOT_KEY_ALIASES: Record<(typeof PLOT_SECTION_KEYS)[number], string[]> = {
  梗概: ['梗概', 'synopsis', 'summary'],
  出场人物: ['出场人物', 'characters', '出場角色', '人物'],
  时间地点: ['时间地点', 'timePlace', 'time_place'],
  关键事件: ['关键事件', 'keyEvents', 'key_events', 'events', '事件'],
  看点: ['看点', 'highlights'],
  状态变更: ['状态变更', 'stateChange', 'state_change'],
  连续性事实: ['连续性事实', 'continuityFacts'],
};

/**
 * 只走前兩層，**不做全文兜底**。解析不出結構就返回 undefined。
 *
 * 批次路徑（工程頁一次給幾十章寫細綱）必須用這個：那裡沒有人逐份過目，
 * 而全文兜底會把模型的一句「我不太確定這一章寫什麼」變成一份「已規劃」的
 * 細綱——流水線狀態從此開始撒謊，緊接著的批次寫正文會照著這份垃圾往下寫。
 *
 * 創作頁反過來走 {@link parseArtifact} 的兜底：那裡產物就攤在螢幕上，
 * 使用者看得見它是什麼，兜底至少留住了這次呼叫的錢。
 */
export function parsePlotStrict(text: string): PlotFields | undefined {
  const outer = objectOf(text);
  // 單章也用批次合同的單項形式（第 22 條：生成與落定兩個入口契約一致），
  // 模型答的是 `{"blueprints":[{…}]}`——取裡面那一項。
  const wrapped = Array.isArray(outer?.blueprints) ? outer.blueprints[0] : undefined;
  const fromJson =
    wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped) ? (wrapped as Record<string, unknown>) : outer;
  if (fromJson) {
    const sections = emptyPlotSections();
    for (const key of PLOT_SECTION_KEYS) {
      sections[key] = toSectionText(pickAlias(fromJson, PLOT_KEY_ALIASES[key]));
    }
    // 出場人物是一行名單（「林昭、沈氏」），不是一條一行的列表——與藍圖落盤的樣子一致。
    const cast = strList(pickAlias(fromJson, PLOT_KEY_ALIASES.出场人物));
    if (cast.length > 0) {
      sections.出场人物 = cast.join('、');
    }
    // 關鍵事件一條一行，與批次同一套規矩：給成一段字也按換行與分號切成條。
    const events = keyEventList(pickAlias(fromJson, PLOT_KEY_ALIASES.关键事件));
    if (events) {
      sections.关键事件 = events.map((e) => `- ${e}`).join('\n');
    }
    // 語法合法但完全不相干的 JSON（`{"text":"..."}`）認下來會得到一份空細綱
    // **並且不再降級**，比解析失敗更糟。
    if (Object.values(sections).some((v) => v.trim())) {
      const settings = fromJson.settings ?? fromJson.设定;
      // 敘事線的計劃（二期）：與批次同一套解碼（第 22 條）；沒寫就不帶，寫入時不動原來的計劃。
      const plan = decodePlanEntries(fromJson.threads ?? fromJson.叙事线, num(fromJson.chapterNumber) ?? 0);
      return {
        sections,
        title: clipTitle(str(fromJson.title ?? fromJson.标题)),
        targetWords: num(fromJson.targetWords ?? fromJson.目标字数),
        // 「設定」一節：合同裡可選，沒寫就不帶（落盤時沿用磁碟那份）。`isNew` 的另記一份，採納時建空條目。
        ...(settings !== undefined ? { lore: loreLinesFromJson(settings), ...newLoreOf(settings) } : {}),
        ...(plan.entries ? { threads: plan.entries } : {}),
        ...(plan.notes.length > 0 ? { planNotes: plan.notes } : {}),
      };
    }
  }

  const picked = pickSections(text, PLOT_SECTION_KEYS) as PlotSections;
  return Object.values(picked).some((v) => v.trim()) ? { sections: { ...emptyPlotSections(), ...picked } } : undefined;
}

/**
 * 藍圖 `settings` 裡 `isNew` 的那幾行（寫法同批次的 `blueprintSettings`）：名字截長，同名只留第一行。
 * 一行都沒有就不帶這個欄位。
 */
function newLoreOf(raw: unknown): { newLore?: LoreLine[] } {
  if (!Array.isArray(raw)) {
    return {};
  }
  const flagged = new Set<string>();
  for (const item of raw) {
    const o = item && typeof item === 'object' ? (item as Record<string, unknown>) : undefined;
    if (o && (o.isNew === true || o.isNew === 'true' || o.新 === true)) {
      flagged.add(normalizeLoreName(str(o.name ?? o.title ?? o.名称 ?? o.名字)));
    }
  }
  const fresh = loreLinesFromJson(raw).filter((line) => flagged.has(normalizeLoreName(line.name)));
  return fresh.length > 0 ? { newLore: fresh } : {};
}

/**
 * 一批細綱：按批次合同嚴格解碼，只留區間內的章、同號只留第一份，按章號升序。
 *
 * 解不出來就是空的——採納時據此說「解析不出」，不寫任何東西。生成那一步的漏章、
 * 重複章由生成鏈當場報錯（fail-closed），走到這裡的是已經過了那一關的規範化結果，
 * 或者作者在氣泡裡改過的那一份。
 */
export function parsePlotBatch(text: string, range: ChapterRange): BlueprintItem[] {
  const decoded = decodeBlueprints(text);
  if (!decoded.ok) {
    return [];
  }
  const seen = new Set<number>();
  return decoded.items
    .filter((b) => b.no >= range.from && b.no <= range.to && !seen.has(b.no) && (seen.add(b.no), true))
    .sort((a, b) => a.no - b.no);
}

// ---------------------------------------------------------------- 架構

/** 各件兜底塞進哪一節：那一件的主體，也就是「填過沒有」看的那一節。 */
const SETTING_FALLBACK: Record<SettingFileDoc, string> = {
  config: '核心梗概',
  premise: '核心冲突链',
  world: '规则与漏洞',
};

/**
 * 小說配置 / 前提 / 世界觀：JSON 同名鍵 → Markdown 小節 → 全文塞進主體那一節。
 *
 * 配置另外認兩種形狀：生成鏈交來的規範化草稿（帶 frontmatter 的 `config.md` 全文，
 * 末尾可能有一節「文風」），以及上游合同的英文鍵 JSON（模型第一次呼叫的原樣輸出）。
 */
export function parseSettingArtifact(doc: SettingFileDoc, text: string): Extract<Artifact, { kind: 'settingDoc' }> {
  if (doc === 'config') {
    const special = parseConfigDraft(text);
    if (special) {
      return special;
    }
  }
  const keys = SETTING_SECTION_KEYS[doc];
  const obj = objectOf(text);
  const sections: Record<string, string> = Object.fromEntries(keys.map((k) => [k, '']));
  let config: ConfigFields | undefined;

  if (obj) {
    for (const key of keys) {
      sections[key] = toSectionText(obj[key]);
    }
    if (doc === 'config') {
      config = {
        genre: str(obj.genre ?? obj.类型) || undefined,
        subGenre: str(obj.subGenre ?? obj.子类型) || undefined,
        audience: str(obj.audience ?? obj.targetAudience ?? obj.受众) || undefined,
        structure: pickEnum<PlotStructure>(obj.structure ?? obj.plotStructure, PLOT_STRUCTURES),
        pov: pickEnum<NarrativePov>(obj.pov ?? obj.narrativePOV, NARRATIVE_POVS),
        totalChapters: num(obj.totalChapters ?? obj.总章数),
        wordsPerChapter: num(obj.wordsPerChapter ?? obj.每章字数),
      };
    }
  }
  if (!Object.values(sections).some((v) => v.trim())) {
    const picked = pickSections(text, keys);
    for (const key of keys) {
      sections[key] = picked[key] ?? '';
    }
  }
  if (!Object.values(sections).some((v) => v.trim()) && text.trim()) {
    sections[SETTING_FALLBACK[doc]] = text.trim();
  }
  return { kind: 'settingDoc', doc, sections, config };
}

/**
 * 配置的兩種特殊形狀（見 {@link parseSettingArtifact}）。都認不出返回 undefined，
 * 回到通用的三層降級。
 */
function parseConfigDraft(text: string): Extract<Artifact, { kind: 'settingDoc' }> | undefined {
  const pickConfig = (c: ConfigFields & { genre?: string; subGenre?: string; audience?: string }): ConfigFields => ({
    genre: c.genre || undefined,
    subGenre: c.subGenre || undefined,
    audience: c.audience || undefined,
    structure: c.structure,
    pov: c.pov,
    totalChapters: c.totalChapters,
    wordsPerChapter: c.wordsPerChapter,
    // 草稿是 `config.md` 全文，frontmatter 裡帶著作者的分段格式（mergeWithAuthor 從磁碟那份抄來的）。
    paragraphStyle: c.paragraphStyle,
  });

  if (/^---\s*\r?\n/.test(text)) {
    const book = parseBookConfig(text, '');
    const style = pickSections(parseMarkdown(text).body, [STYLE_DRAFT_HEADING])[STYLE_DRAFT_HEADING].trim();
    return {
      kind: 'settingDoc',
      doc: 'config',
      sections: { ...book.sections },
      config: pickConfig(book),
      ...(style ? { style } : {}),
    };
  }

  const decoded = decodeNovelConfig(text);
  if (!decoded.ok || !Object.values(decoded.value.sections).some((v) => v?.trim())) {
    return undefined;
  }
  const { value } = decoded;
  const sections: Record<string, string> = Object.fromEntries(SETTING_SECTION_KEYS.config.map((k) => [k, '']));
  for (const [k, v] of Object.entries(value.sections)) {
    sections[k] = v ?? '';
  }
  return {
    kind: 'settingDoc',
    doc: 'config',
    sections,
    config: pickConfig(value),
    ...(value.writingStyle ? { style: value.writingStyle } : {}),
  };
}

/**
 * 角色圖譜：`{characters:[{name, role, 身份, 性格, …}]}` → 裸陣列 → 每個 `## 名字` 一人。
 *
 * Markdown 那一層把整節內容當作「身份」：模型不按 JSON 答時，能留住的就是
 * 「這個人是誰」這一段。名字相同的只收第一個。
 */
export function parseRoster(text: string): RosterEntry[] {
  const out: RosterEntry[] = [];
  const seen = new Set<string>();
  const push = (entry: RosterEntry) => {
    if (entry.name && !seen.has(entry.name)) {
      seen.add(entry.name);
      out.push(entry);
    }
  };

  const rows = listOf(text, 'characters', 'roster', '角色', '人物');
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) {
      continue;
    }
    const o = row as Record<string, unknown>;
    const sections: Partial<CharacterSections> = {};
    for (const key of CHARACTER_SECTION_KEYS) {
      const value = toSectionText(o[key]);
      if (value) {
        sections[key] = value;
      }
    }
    if (!sections.身份) {
      const identity = str(o.identity ?? o.profile ?? o.description ?? o.简介);
      if (identity) {
        sections.身份 = identity;
      }
    }
    push({
      name: clipTitle(str(o.name ?? o.姓名 ?? o.名字)),
      role: str(o.role ?? o.定位 ?? o.角色定位),
      aliases: strList(o.aliases ?? o.别名),
      gender: normalizeGender(o.性别 ?? o.gender),
      sections,
    });
  }
  if (out.length > 0) {
    return out;
  }

  // Markdown：每個 `## 名字` 一節。
  const lines = text.split(/\r?\n/);
  let current: { name: string; buf: string[] } | undefined;
  const flush = () => {
    if (current) {
      const body = current.buf.join('\n').trim();
      push({ name: clipTitle(current.name), role: '', aliases: [], sections: body ? { 身份: body } : {} });
    }
  };
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      current = { name: m[1].replace(/[（(].*$/, '').trim(), buf: [] };
    } else {
      current?.buf.push(line);
    }
  }
  flush();
  return out;
}

// ---------------------------------------------------------------- 取值工具

/** 最外層 JSON 物件。不是物件（陣列、純文字）返回 undefined。 */
function objectOf(text: string): Record<string, unknown> | undefined {
  const json = extractJsonObject(text);
  if (!json) {
    return undefined;
  }
  try {
    const data: unknown = JSON.parse(json);
    return typeof data === 'object' && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 清單：`{characters:[…]}` → `[…]` 裸陣列。
 *
 * 模型漏掉外層鍵是每天都會遇到的事；鍵名認不出時取第一個陣列值——
 * `{"角色列表":[…]}` 這種也別丟。
 */
function listOf(text: string, ...keys: string[]): unknown[] {
  // 整段就是一個陣列時先認陣列：只有一個人的裸陣列 `[{"name":"林昭","aliases":[…]}]`
  // 裡，「第一個 `{` 到最後一個 `}`」恰好是那個人自己——當成外層物件去取陣列鍵，
  // 取到的是他的 aliases，名單就成了空的。
  if (text.trimStart().startsWith('[')) {
    const bare = bareArray(text);
    if (bare) {
      return bare;
    }
  }
  const obj = objectOf(text);
  if (obj) {
    for (const key of keys) {
      if (Array.isArray(obj[key])) {
        return obj[key] as unknown[];
      }
    }
    const firstArray = Object.values(obj).find((v) => Array.isArray(v));
    if (Array.isArray(firstArray)) {
      return firstArray;
    }
  }
  return bareArray(text) ?? [];
}

function bareArray(text: string): unknown[] | undefined {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) {
    return undefined;
  }
  try {
    const data: unknown = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(data) ? data : undefined;
  } catch {
    return undefined;
  }
}

function pickAlias(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (obj[key] !== undefined) {
      return obj[key];
    }
  }
  return undefined;
}

function pickEnum<T extends string>(v: unknown, values: readonly T[]): T | undefined {
  const s = str(v).toLowerCase();
  return values.find((x) => x === s);
}

/**
 * 標題長度收口。
 *
 * 標題會變成檔名（`012-<標題>.md`），而模型很愛把一整句梗概當標題。
 * 在標點處斷一次再截斷，比硬切 18 個字讀起來像個標題。
 */
function clipTitle(text: string): string {
  const head = text.split(/[。！？；;\n]/)[0].trim() || text.trim();
  return head.length > 18 ? head.slice(0, 18) : head;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
}

/** 字串陣列；寫成 `a、b` 的一個字串也拆開。 */
function strList(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map(str).filter(Boolean);
  }
  const s = str(v);
  return s ? s.split(/[,，、]/).map((x) => x.trim()).filter(Boolean) : [];
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}
