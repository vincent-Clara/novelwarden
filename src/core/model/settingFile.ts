/**
 * 架構層的三份文件：小說配置 `config.md`、故事前提 `premise.md`、世界觀 `world.md`。
 *
 * **純函式、零 I/O**，與 plotFile.ts / chapterFile.ts 同類；路徑在 model/project.ts，
 * 解析與渲染只在這裡定義一次。
 *
 * ## 為什麼要一層「架構」
 *
 * 從前沒有前置設定：角色卡與設定條目都是寫完正文之後從摘要裡反推的，等於拿模型
 * 上一次的發揮去約束它下一次的發揮。第一章動筆時沒有角色名單、沒有世界規則、
 * 沒有金手指的機制，人物和設定全靠邊寫邊編。
 *
 * 現在的順序是 **配置 → 前提 → 角色圖譜 → 世界觀 → 情節大綱**，每一步都吃上一步
 * 的產出（思路來自 AI-Novel-Writer，GPL-3.0，源自 AI_NovelGenerator）。角色圖譜
 * 沒有自己的檔案，它就是 `characters/` 下那一組角色卡；這裡只管另外三份。
 *
 * ## `config.md` 的兩個硬性規模引數
 *
 * `totalChapters` 與 `wordsPerChapter` 是整條鏈的長度錨點：大綱按總章數算章號
 * 區間，細綱沒寫 `targetWords` 時正文按每章字數判「寫夠沒有」。**兩者都可以不寫**
 * ——不寫就沒有這條錨點，狀態機會如實退化（「有字就算寫夠」），不拿一個猜出來的
 * 數字騙人。
 *
 * ## 文風不在這裡
 *
 * 文風的唯一出處是 `style.md`（D14）。配置裡再寫一份，作者就不知道該信哪一份。
 */
import {
  asNumber,
  asString,
  hasContent,
  parseMarkdown,
  pickSections,
  stringifyFrontmatter,
  stringifySections,
} from './markdown';
import { PARAGRAPH_STYLES, PARAGRAPH_STYLE_LABEL, ParagraphStyle } from './paragraphFormat';

/** 有自己檔案的三件。「角色圖譜」就是 `characters/` 目錄，「設定清單」就是 `lore/` 目錄。 */
export type SettingFileDoc = 'config' | 'premise' | 'world';

export const SETTING_FILE_DOCS: readonly SettingFileDoc[] = ['config', 'premise', 'world'];

/**
 * 小說配置的八節。順序即「讀它們的順序」：先是作者的那句話，再是展開後的梗概與讀者追讀的理由（核心賣點），
 * 然後是世界、金手指、主角，最後是跨章的規則與參考。
 *
 * 「全域要求」只寫**跨章**的規則（≤600 字、4–8 行），禁止逐章列大綱——那是
 * 大綱與細綱的活，寫在這裡會被每一章都讀一遍。
 */
export const CONFIG_SECTION_KEYS = [
  '一句话',
  '核心梗概',
  '核心卖点',
  '世界观要点',
  '金手指',
  '主角档案',
  '全局要求',
  '参考作品',
] as const;

/** 故事前提四節：一句話前提、衝突鏈、爽點迴圈（金手指怎樣一次次兌現爽點）、懸念骨架。 */
export const PREMISE_SECTION_KEYS = ['一句话前提', '核心冲突链', '爽点循环', '悬念骨架'] as const;

/** 世界觀三節：規則與它的漏洞、階層與資源、深層危機。 */
export const WORLD_SECTION_KEYS = ['规则与漏洞', '阶层与资源', '深层危机'] as const;

/**
 * 「全域要求」一節的合同：4–8 條跨章規則，總計不超過 600 字，不許逐章列大綱。
 * 來自 AI-Novel-Writer 的 `novel-config-expansion.ts`；提示詞與生成鏈的質檢共用。
 */
export const GUIDANCE_MAX_CHARS = 600;
export const GUIDANCE_MIN_RULES = 4;
export const GUIDANCE_MAX_RULES = 8;

export const SETTING_SECTION_KEYS: Record<SettingFileDoc, readonly string[]> = {
  config: CONFIG_SECTION_KEYS,
  premise: PREMISE_SECTION_KEYS,
  world: WORLD_SECTION_KEYS,
};

/**
 * 判「填過沒有」看哪幾節——任意一節有內容就算。
 *
 * 配置只看「核心梗概」：只寫了「一句話」的配置是作者剛把腦洞丟進來，還沒展開，
 * 主按鈕仍該是「生成小說配置」。前提看衝突鏈：那是它的主體，一句話前提只是標題。
 */
const FILLED_BY: Record<SettingFileDoc, readonly string[]> = {
  config: ['核心梗概'],
  premise: ['核心冲突链'],
  world: WORLD_SECTION_KEYS,
};

/** 文件標題行。渲染時寫，解析時忽略（身份由路徑決定）。 */
export const SETTING_DOC_HEADING: Record<SettingFileDoc, string> = {
  config: '小說配置',
  premise: '故事前提',
  world: '世界觀',
};

// ---------------------------------------------------------------- 故事結構與視角

/**
 * 故事結構。大綱那一步按它算章號區間（三幕 20/55/25 等）。
 * 值是英文列舉（與 AI-Novel-Writer 的配置合同一致，便於移植提示詞），介面顯示中文。
 */
export const PLOT_STRUCTURES = [
  'three_act',
  'heros_journey',
  'save_the_cat',
  'kishotenketsu',
  'multi_thread',
  'freeform',
] as const;

export type PlotStructure = (typeof PLOT_STRUCTURES)[number];

export const PLOT_STRUCTURE_LABEL: Record<PlotStructure, string> = {
  three_act: '三幕結構',
  heros_journey: '英雄之旅',
  save_the_cat: '節拍表',
  kishotenketsu: '起承轉合',
  multi_thread: '多線敘事',
  freeform: '自由結構',
};

export const NARRATIVE_POVS = ['third_limited', 'first_person', 'third_omniscient', 'multi_pov'] as const;

export type NarrativePov = (typeof NARRATIVE_POVS)[number];

export const NARRATIVE_POV_LABEL: Record<NarrativePov, string> = {
  third_limited: '第三人稱限知',
  first_person: '第一人稱',
  third_omniscient: '第三人稱全知',
  multi_pov: '多視角',
};

/**
 * 列舉欄位的容錯取值：英文值、中文標籤都認，認不出就是 undefined（不猜）。
 * 作者手改 frontmatter 時寫「三幕結構」比寫 `three_act` 自然得多。
 */
function pickEnum<T extends string>(raw: string, values: readonly T[], labels: Record<T, string>): T | undefined {
  const s = raw.trim();
  if (!s) {
    return undefined;
  }
  const byValue = values.find((v) => v === s.toLowerCase());
  if (byValue) {
    return byValue;
  }
  return values.find((v) => labels[v] === s);
}

// ---------------------------------------------------------------- 小說配置

export type ConfigSectionKey = (typeof CONFIG_SECTION_KEYS)[number];

export interface BookConfig {
  relPath: string;
  /** 型別（玄幻 / 都市 / 懸疑……）。自由文字。 */
  genre: string;
  subGenre: string;
  /** 目標讀者（男頻 / 女頻 / 出版……）。自由文字。 */
  audience: string;
  structure?: PlotStructure;
  pov?: NarrativePov;
  /** 全書計劃多少章。大綱按它算章號區間。 */
  totalChapters?: number;
  /** 每章目標字數。細綱沒寫 `targetWords` 時正文按它判寫夠沒有。 */
  wordsPerChapter?: number;
  /**
   * 正文的分段格式（`model/paragraphFormat.ts`）：內建編輯器的回車、一鍵排版按它來。沒寫或寫壞了是缺席，
   * 用的地方按預設 `blank`（空行分段）。**會重寫 `config.md` 的路徑都要把它帶過去**，不許靜默丟掉。
   */
  paragraphStyle?: ParagraphStyle;
  sections: Record<ConfigSectionKey, string>;
  /** frontmatter 之外的正文全文。作者可能加了自定義小節，讀回來時保留。 */
  body: string;
}

export type WritableBookConfig = Omit<BookConfig, 'relPath' | 'body'>;

/** 只接受正整數；`0`、負數、小數、`三千` 一律當沒寫。 */
function positiveInt(v: string | string[] | undefined): number | undefined {
  const n = asNumber(v);
  return n !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * 按小節表抽取，**佔位文字讀回來就是空串**。
 *
 * 渲染時空小節寫成 `（待補充）`（作者手改時知道該往哪填），讀回來要認得它：
 * 不然這行字會被當成內容一路送進 prompt，模型讀到的是「金手指：（待補充）」。
 */
function pickFilled<K extends string>(body: string, keys: readonly K[]): Record<K, string> {
  const raw = pickSections<K>(body, keys);
  for (const key of keys) {
    if (!hasContent(raw[key])) {
      raw[key] = '';
    }
  }
  return raw;
}

/** 解析 `config.md`。**絕不拋**：frontmatter 寫壞只讓對應欄位退化成缺席。 */
export function parseBookConfig(text: string, relPath: string): BookConfig {
  const { frontmatter, body } = parseMarkdown(text);
  return {
    relPath,
    genre: asString(frontmatter.genre).trim(),
    subGenre: asString(frontmatter.subGenre).trim(),
    audience: asString(frontmatter.audience).trim(),
    structure: pickEnum(asString(frontmatter.structure), PLOT_STRUCTURES, PLOT_STRUCTURE_LABEL),
    pov: pickEnum(asString(frontmatter.pov), NARRATIVE_POVS, NARRATIVE_POV_LABEL),
    totalChapters: positiveInt(frontmatter.totalChapters),
    wordsPerChapter: positiveInt(frontmatter.wordsPerChapter),
    paragraphStyle: pickEnum(asString(frontmatter.paragraphStyle), PARAGRAPH_STYLES, PARAGRAPH_STYLE_LABEL),
    sections: pickFilled<ConfigSectionKey>(body, CONFIG_SECTION_KEYS),
    body,
  };
}

/**
 * 渲染成落盤的 Markdown。空小節保留佔位，作者手改時知道該往哪填。
 *
 * 字串欄位是空串時**也寫出這一行**（`genre: `）：這份檔案是給人填的表，
 * 空著的鍵正好告訴作者「這裡可以寫」。數字與列舉（含 `paragraphStyle`）缺席就不寫。
 */
export function renderBookConfig(config: WritableBookConfig): string {
  const fm = stringifyFrontmatter({
    genre: config.genre,
    subGenre: config.subGenre,
    audience: config.audience,
    structure: config.structure,
    pov: config.pov,
    totalChapters: config.totalChapters,
    wordsPerChapter: config.wordsPerChapter,
    paragraphStyle: config.paragraphStyle,
    generatedBy: 'novelwarden',
  });
  const body = stringifySections(config.sections, CONFIG_SECTION_KEYS, { keepEmpty: true });
  return `${fm}\n\n# ${SETTING_DOC_HEADING.config}\n\n${body}\n`;
}

/**
 * 只改 `config.md` frontmatter 裡 `paragraphStyle` 這一行（切換分段格式用），**別的位元組一個不動**——
 * 不經 `renderBookConfig` 整份重渲染：作者手排的小節、註釋、鍵的順序與寫法都原樣留著。
 *
 * - frontmatter 裡已有這一行：只換它的值。
 * - 有 frontmatter 但沒有這一行：加在收尾的 `---` 之前。
 * - 沒有 frontmatter（作者手寫的、或檔案根本不存在傳了空串）：最前面補一段只有這一行的 frontmatter。
 *   這不加任何小節，「小說配置」照舊算沒填（`isSettingFilled` 只看「核心梗概」）。
 *
 * BOM 與換行符（`\r\n` / `\n`）原樣留著。
 */
export function setConfigParagraphStyle(text: string, style: ParagraphStyle): string {
  const bom = text.startsWith('﻿') ? '﻿' : '';
  const rest = bom ? text.slice(1) : text;
  const eol = rest.includes('\r\n') ? '\r\n' : '\n';
  const line = `paragraphStyle: ${style}`;
  // 與 markdown.ts 的 `parseMarkdown` 同一個認法：解析認得出的 frontmatter，這裡才去改它。
  const fence = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(rest);
  if (!fence) {
    return `${bom}---${eol}${line}${eol}---${eol}${rest}`;
  }
  const bodyStart = rest.indexOf('\n') + 1;
  const body = fence[1];
  const existing = /^paragraphStyle[ \t]*:.*$/m.exec(body);
  if (existing) {
    const at = bodyStart + existing.index;
    return bom + rest.slice(0, at) + line + rest.slice(at + existing[0].length);
  }
  const bodyEnd = bodyStart + body.length;
  return bom + rest.slice(0, bodyEnd) + eol + line + rest.slice(bodyEnd);
}

// ---------------------------------------------------------------- 前提 / 世界觀

export interface SettingDocFile {
  doc: SettingFileDoc;
  relPath: string;
  sections: Record<string, string>;
  body: string;
}

/**
 * 解析任意一份架構文件，按它自己的小節表抽取。**絕不拋**。
 *
 * 配置也能走這條路（只取小節，不管 frontmatter）——判「填過沒有」時用得上。
 */
export function parseSettingDoc(doc: SettingFileDoc, text: string, relPath: string): SettingDocFile {
  const { body } = parseMarkdown(text);
  return { doc, relPath, sections: pickFilled(body, SETTING_SECTION_KEYS[doc]), body };
}

/** 渲染前提或世界觀。配置有 frontmatter 欄位，走 {@link renderBookConfig}。 */
export function renderSettingDoc(doc: Exclude<SettingFileDoc, 'config'>, sections: Record<string, string>): string {
  const fm = stringifyFrontmatter({ generatedBy: 'novelwarden' });
  const body = stringifySections(sections, SETTING_SECTION_KEYS[doc], { keepEmpty: true });
  return `${fm}\n\n# ${SETTING_DOC_HEADING[doc]}\n\n${body}\n`;
}

/** 這份文件填過沒有。判據見 `FILLED_BY`；佔位文字不算內容。 */
export function isSettingFilled(doc: SettingFileDoc, sections: Record<string, string>): boolean {
  return FILLED_BY[doc].some((key) => hasContent(sections[key]));
}

/** 初始化工程時寫入的空模板：結構完整、全是佔位，`isSettingFilled` 為 false。 */
export function settingTemplate(doc: SettingFileDoc): string {
  if (doc === 'config') {
    return renderBookConfig({
      genre: '',
      subGenre: '',
      audience: '',
      sections: Object.fromEntries(CONFIG_SECTION_KEYS.map((k) => [k, ''])) as Record<ConfigSectionKey, string>,
    });
  }
  return renderSettingDoc(doc, {});
}
