import { traditionalLabel } from '../model/labels';
/**
 * 小說配置的生成結果：JSON 合同 → `config.md` 的七節與 frontmatter，外加一段給
 * `style.md` 的文風。
 *
 * **純函式、絕不拋**。合同、「全域要求」質檢與「保留作者原文」的合併規則移植自
 * AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）：
 * `commands/architecture.command.ts` 的 `buildNovelConfigJSONContract` /
 * `decodeCompleteNovelConfig`，以及 `novel-config-expansion.ts`。
 *
 * ## 模型面向的鍵沿用上游的英文名
 *
 * `coreOutline`、`goldenFinger` 這些鍵是上游調過的提示詞的一部分，換成中文鍵就得
 * 重新試錯一遍。解碼時對映到 `config.md` 的八節；「一句話」是作者的原話，模型給的 `logline`
 * 只在作者沒寫時補上（從已寫正文補齊時就沒有作者的原話）。
 *
 * ## 比上游寬鬆
 *
 * 上游缺任何一個欄位、列舉寫錯一個都整份作廢。這裡缺的欄位記進 `missing`、認不出的
 * 列舉丟掉並記一條 warning，其餘照收：配置是一次一份、攤在落盤卡片上的產物，
 * 作者看得見缺了什麼，手補一節比再花一輪錢便宜。
 */
import { hasContent } from '../model/markdown';
import {
  BookConfig,
  CONFIG_SECTION_KEYS,
  GUIDANCE_MAX_CHARS,
  GUIDANCE_MAX_RULES,
  GUIDANCE_MIN_RULES,
  ConfigSectionKey,
  NARRATIVE_POVS,
  NarrativePov,
  PLOT_STRUCTURES,
  PlotStructure,
  WritableBookConfig,
  renderBookConfig,
} from '../model/settingFile';
import { parseJson, singleJsonObject } from './structuredJson';
import { toSectionText } from './summarize';

export { GUIDANCE_MAX_CHARS, GUIDANCE_MAX_RULES, GUIDANCE_MIN_RULES };

/** 「第 3 章」「第 1–20 章」「Chapter 5」開頭的一行——那是在逐章列大綱。 */
const CHAPTER_OUTLINE_LINE =
  /^(?:[-*+]\s*|\d+[.)、]\s*)?(?:第\s*[0-9一二三四五六七八九十百零〇两兩]+\s*(?:[-–—~～至到]\s*[0-9一二三四五六七八九十百零〇两兩]+\s*)?章|chapters?\s+\d+(?:\s*[-–—~]\s*\d+)?)/iu;

function guidanceRules(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** 「全域要求」哪裡不合格；合格返回 undefined。 */
export function guidanceProblem(text: string): string | undefined {
  const rules = guidanceRules(text);
  const length = Array.from(text.trim()).length;
  const chapterLines = rules.filter((l) => CHAPTER_OUTLINE_LINE.test(l)).length;
  if (length > GUIDANCE_MAX_CHARS) {
    return `全域要求有 ${length} 字，超過 ${GUIDANCE_MAX_CHARS} 字`;
  }
  if (rules.length < GUIDANCE_MIN_RULES || rules.length > GUIDANCE_MAX_RULES) {
    return `全域要求有 ${rules.length} 條，合同要求 ${GUIDANCE_MIN_RULES}–${GUIDANCE_MAX_RULES} 條`;
  }
  if (chapterLines >= 2) {
    return '全域要求在逐章列大綱';
  }
  return undefined;
}

export function isGuidanceValid(text: string): boolean {
  return guidanceProblem(text) === undefined;
}

/** 模型那邊的鍵 → `config.md` 的小節。 */
const SECTION_OF: Record<string, ConfigSectionKey> = {
  logline: '一句话',
  coreOutline: '核心梗概',
  sellingPoints: '核心卖点',
  worldSetting: '世界观要点',
  goldenFinger: '金手指',
  protagonistProfile: '主角档案',
  globalGuidance: '全局要求',
  referenceWorks: '参考作品',
};

/** 必填的十個文字欄位（上游 `REQUIRED_CONFIG_TEXT_FIELDS` 的九個，外加核心賣點）。缺了記進 `missing`。 */
const REQUIRED = [
  'genre',
  'targetAudience',
  'subGenre',
  'coreOutline',
  'sellingPoints',
  'worldSetting',
  'goldenFinger',
  'protagonistProfile',
  'globalGuidance',
  'writingStyle',
] as const;

/** 模型產出的那一份，還沒和磁碟上的合併。 */
export interface GeneratedConfig {
  genre?: string;
  subGenre?: string;
  audience?: string;
  structure?: PlotStructure;
  pov?: NarrativePov;
  totalChapters?: number;
  wordsPerChapter?: number;
  sections: Partial<Record<ConfigSectionKey, string>>;
  /** 給 `style.md` 的文風。不進 `config.md`（D14）。 */
  writingStyle?: string;
}

export type ConfigDecode =
  | { ok: true; value: GeneratedConfig; missing: string[]; warnings: string[] }
  | { ok: false; reason: string };

function pickEnum<T extends string>(v: unknown, values: readonly T[]): T | undefined {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return values.find((x) => x === s);
}

function positive(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/**
 * 解碼模型給的配置 JSON。中文鍵（`核心梗概`）也認：模型偶爾會照著工程裡的檔案寫。
 * 整段不是 JSON 物件才算失敗。
 */
export function decodeNovelConfig(text: string): ConfigDecode {
  const whole = parseJson(text);
  let obj: Record<string, unknown> | undefined =
    whole && typeof whole === 'object' && !Array.isArray(whole) ? (whole as Record<string, unknown>) : undefined;
  if (!obj) {
    const single = singleJsonObject(text);
    if (!single.ok) {
      return { ok: false, reason: single.reason === 'truncated' ? '配置 JSON 沒有寫完' : '輸出不是一個 JSON 物件' };
    }
    obj = single.value;
  }

  const warnings: string[] = [];
  const sections: GeneratedConfig['sections'] = {};
  for (const [key, section] of Object.entries(SECTION_OF)) {
    const value = toSectionText(obj[key] ?? obj[section] ?? obj[traditionalLabel(section)]);
    if (value) {
      sections[section] = value;
    }
  }
  const text2 = (key: string, alias: string) => {
    const v = obj![key] ?? obj![alias] ?? obj![traditionalLabel(alias)];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  const structure = pickEnum<PlotStructure>(obj.plotStructure ?? obj.structure, PLOT_STRUCTURES);
  const pov = pickEnum<NarrativePov>(obj.narrativePOV ?? obj.pov, NARRATIVE_POVS);
  if ((obj.plotStructure ?? obj.structure) !== undefined && !structure) {
    warnings.push(`故事結構「${String(obj.plotStructure ?? obj.structure)}」不在六種結構裡，沒有采用`);
  }
  if ((obj.narrativePOV ?? obj.pov) !== undefined && !pov) {
    warnings.push(`敘事視角「${String(obj.narrativePOV ?? obj.pov)}」認不出，沒有采用`);
  }

  const value: GeneratedConfig = {
    genre: text2('genre', '类型'),
    subGenre: text2('subGenre', '子类型'),
    audience: text2('targetAudience', 'audience'),
    structure,
    pov,
    totalChapters: positive(obj.totalChapters),
    wordsPerChapter: positive(obj.wordsPerChapter),
    sections,
    writingStyle: toSectionText(obj.writingStyle ?? obj.文风 ?? obj['文風']) || undefined,
  };

  const present: Record<(typeof REQUIRED)[number], boolean> = {
    genre: !!value.genre,
    targetAudience: !!value.audience,
    subGenre: !!value.subGenre,
    coreOutline: !!sections.核心梗概,
    sellingPoints: !!sections.核心卖点,
    worldSetting: !!sections.世界观要点,
    goldenFinger: !!sections.金手指,
    protagonistProfile: !!sections.主角档案,
    globalGuidance: !!sections.全局要求,
    writingStyle: !!value.writingStyle,
  };
  const missing = REQUIRED.filter((k) => !present[k]);
  return { ok: true, value, missing, warnings };
}

/**
 * 作者寫過的長文字保留原文、生成的追加在後；生成的已經包含原文就用生成的
 * （上游 `preserveAuthorText`）。
 */
export function preserveAuthorText(existing: string | undefined, generated: string | undefined): string {
  const author = existing?.trim() ?? '';
  const fresh = generated?.trim() ?? '';
  if (!author) {
    return fresh;
  }
  if (!fresh || fresh.includes(author)) {
    return fresh || author;
  }
  return `${author}\n\n${fresh}`;
}

export interface MergeOptions {
  /** 作者這一次給的那句話（一句話彈窗裡的腦洞）。 */
  idea?: string;
  /** 作者定的規模。給了就以它為準——總章數與每章字數是作者的權威設定，模型改不得。 */
  setup?: { totalChapters: number; wordsPerChapter: number };
  /**
   * 「保留原文，追加生成」：從一句話彈窗發起、而 `config.md` 已經寫過東西時開。
   * 關著的時候（作者在對話裡說「重寫金手指」）生成的那一份就是修改後的版本，
   * 只有它漏掉的小節才沿用磁碟那份。
   */
  preserve: boolean;
}

/** 生成結果並進磁碟上那份，得到將要落盤的配置（上游 `mergeExpandedNovelConfig` 的規則）。 */
export function mergeWithAuthor(existing: BookConfig, generated: GeneratedConfig, opts: MergeOptions): WritableBookConfig {
  const sections = { ...existing.sections };
  for (const key of CONFIG_SECTION_KEYS) {
    const old = hasContent(existing.sections[key]) ? existing.sections[key] : '';
    // 一句話：作者這次給的 > 作者原來寫的 > 模型補的。
    const fresh = key === '一句话' ? opts.idea?.trim() || (old ? undefined : generated.sections[key]) : generated.sections[key];
    sections[key] = opts.preserve ? preserveAuthorText(old, fresh) : fresh?.trim() || old;
  }
  // 作者選過的型別 / 受眾 / 結構 / 視角：保留原文時一律不改；否則生成的優先。
  const choose = <T>(author: T | undefined, model: T | undefined): T | undefined =>
    opts.preserve ? (author || model) : (model || author);
  return {
    genre: choose(existing.genre, generated.genre) ?? '',
    subGenre: choose(existing.subGenre, generated.subGenre) ?? '',
    audience: choose(existing.audience, generated.audience) ?? '',
    structure: choose(existing.structure, generated.structure),
    pov: choose(existing.pov, generated.pov),
    totalChapters: opts.setup?.totalChapters ?? existing.totalChapters ?? generated.totalChapters,
    wordsPerChapter: opts.setup?.wordsPerChapter ?? existing.wordsPerChapter ?? generated.wordsPerChapter,
    // 分段格式是作者在編輯器裡切的，模型不生成它：磁碟上那份原樣帶過去，重寫配置不能把它丟了。
    paragraphStyle: existing.paragraphStyle,
    sections,
  };
}

/** 草稿裡那一節文風的標題。落盤時它不進 `config.md`，只在 `style.md` 空著時寫過去。 */
export const STYLE_DRAFT_HEADING = '文风';

/**
 * 規範化輸出：將要落盤的 `config.md` 全文，後面接一節「文風」。
 *
 * 氣泡裡看到的就是會寫下去的那一份；作者改完再點寫入，採納時按 `config.md` 的格式
 * 重新解析（artifact.ts）。
 */
export function renderConfigDraft(config: WritableBookConfig, style?: string): string {
  const doc = renderBookConfig(config).trimEnd();
  return style?.trim() ? `${doc}\n\n## ${STYLE_DRAFT_HEADING}\n\n${style.trim()}\n` : `${doc}\n`;
}
