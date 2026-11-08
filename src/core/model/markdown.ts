import { traditionalLabel } from './labels';

/**
 * 輕量 Markdown 結構工具：YAML frontmatter 與「## 小節」的解析/序列化。
 *
 * 這裡刻意不引入 yaml 依賴：frontmatter 只支援 `key: value` 與
 * `key: [a, b]` / `key:\n  - a\n  - b` 兩種陣列寫法，足夠角色卡使用，
 * 且解析失敗時退化為忽略該行而不是拋錯——作者手改檔案不該讓外掛崩掉。
 */

export interface ParsedMarkdown {
  frontmatter: Record<string, string | string[]>;
  body: string;
}

const FM_FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseMarkdown(text: string): ParsedMarkdown {
  const normalized = text.replace(/^﻿/, '');
  const match = FM_FENCE.exec(normalized);
  if (!match) {
    return { frontmatter: {}, body: normalized.trim() };
  }
  return {
    frontmatter: parseFrontmatter(match[1]),
    body: normalized.slice(match[0].length).trim(),
  };
}

function parseFrontmatter(raw: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  const lines = raw.split(/\r?\n/);
  let currentListKey: string | null = null;

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) {
      continue;
    }

    // 縮排的 `- item` 歸屬於上一個鍵。
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && currentListKey) {
      const arr = result[currentListKey];
      const value = stripQuotes(listItem[1].trim());
      if (Array.isArray(arr)) {
        arr.push(value);
      } else {
        result[currentListKey] = [value];
      }
      continue;
    }

    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) {
      continue;
    }
    const key = kv[1];
    const rawValue = kv[2].trim();

    if (rawValue === '') {
      // 可能是塊狀陣列的起始，先佔位為空陣列。
      result[key] = [];
      currentListKey = key;
      continue;
    }

    currentListKey = null;
    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      result[key] = rawValue
        .slice(1, -1)
        .split(',')
        .map((s) => stripQuotes(s.trim()))
        .filter((s) => s.length > 0);
    } else {
      result[key] = stripQuotes(rawValue);
    }
  }
  return result;
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

export function stringifyFrontmatter(data: Record<string, string | number | string[] | undefined>): string {
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((v) => quoteIfNeeded(v)).join(', ')}]`);
    } else if (typeof value === 'number') {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${quoteIfNeeded(value)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function quoteIfNeeded(value: string): string {
  return /[:#\[\]{},]|^\s|\s$/.test(value) ? JSON.stringify(value) : value;
}

/**
 * 只改 frontmatter，正文一個位元組都不動。
 *
 * 維護類動作（清理別名、合併重複角色卡）改的全是後設資料，但作者的正文可能
 * 被手工排過版、加過自定義小節。用 `renderCharacterCard` 整卡重渲染會把這些
 * 悄悄抹平——那是「不靜默覆蓋」的反面。所以這裡只重寫 `---` 之間那一段，
 * 後面的內容原樣接回去。
 *
 * `patch` 裡值為 `undefined` 的鍵表示**刪除**該欄位。原有欄位的順序保留，
 * 新欄位追加在末尾。沒有 frontmatter 的檔案返回 undefined（呼叫方跳過）。
 */
export function rewriteFrontmatter(
  text: string,
  patch: Record<string, string | number | string[] | undefined>
): string | undefined {
  // BOM 要原樣留著——它不屬於 frontmatter，抹掉等於偷偷改了檔案編碼。
  const bom = text.startsWith('﻿') ? '﻿' : '';
  const rest = bom ? text.slice(1) : text;
  const match = FM_FENCE.exec(rest);
  if (!match) {
    return undefined;
  }

  const current = parseFrontmatter(match[1]);
  const merged: Record<string, string | number | string[] | undefined> = {};
  for (const [key, value] of Object.entries(current)) {
    merged[key] = key in patch ? patch[key] : value;
  }
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in merged)) {
      merged[key] = value;
    }
  }

  const eol = rest.includes('\r\n') ? '\r\n' : '\n';
  const fence = stringifyFrontmatter(merged).split('\n').join(eol);
  return `${bom}${fence}${eol}${rest.slice(match[0].length)}`;
}

/**
 * 只換掉某一節（`## 小節名` 到下一個同級或更高階標題之前）的內容，其餘一個字不動。
 *
 * 與 {@link rewriteFrontmatter} 同一個理由：機器定稿時要改角色卡的「當前狀態」（D15），
 * 整卡重渲染會抹掉作者自加的小節與排版。小節名按 `pickSections` 同一套寬鬆規則認
 * （忽略空白與常見標點）；沒有這一節就追加在末尾。
 */
export function replaceSection(text: string, key: string, value: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const want = normalizeKey(key);
  const start = lines.findIndex((line) => {
    const m = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    return !!m && normalizeKey(m[2].replace(/[:：]\s*$/, '')) === want;
  });
  const content = value.trim() || SECTION_PLACEHOLDER;
  if (start === -1) {
    const head = text.replace(/\s+$/, '');
    return `${head}${eol}${eol}## ${traditionalLabel(key)}${eol}${eol}${content.split('\n').join(eol)}${eol}`;
  }
  const level = /^(#{2,3})/.exec(lines[start])![1].length;
  let end = start + 1;
  while (end < lines.length) {
    const h = /^(#{1,3})\s+/.exec(lines[end]);
    if (h && h[1].length <= level) {
      break;
    }
    end++;
  }
  const replaced = [lines[start], '', ...content.split('\n'), ...(end < lines.length ? [''] : [])];
  const out = [...lines.slice(0, start), ...replaced, ...lines.slice(end)];
  const joined = out.join(eol);
  return end < lines.length ? joined : `${joined.replace(/\s+$/, '')}${eol}`;
}

// ---------------------------------------------------------------- frontmatter 取值
//
// 解析器只產出 `string | string[]`（見 parseFrontmatter），而呼叫方要的是
// 字串/陣列/數字。這四個轉換函式放在這裡而不是各資料模組裡，是因為
// **作者會手改 frontmatter**：`targetWords: 三千`、`characters: 林昭`
// （本該是陣列）這類寫法必須在同一個地方按同一套規則兜住，否則角色卡認
// 一種、場景卡認另一種，同樣的手改在兩處表現不同。

/** 取字串；陣列取首項；缺席為空串。 */
export function asString(v: string | string[] | undefined): string {
  if (Array.isArray(v)) {
    return v[0] ?? '';
  }
  return v ?? '';
}

/** 取字串陣列；寫成 `a、b` 的單行也拆開——作者常常忘了寫方括號。 */
export function asArray(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) {
    return v.filter((s) => s.trim().length > 0);
  }
  if (typeof v === 'string' && v.trim()) {
    return v
      .split(/[,，、]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/** 取數字；解析不出（空、`三千`、`待定`）返回 undefined 而不是 NaN。 */
export function asNumber(v: string | string[] | undefined): number | undefined {
  const s = asString(v);
  if (!s) {
    return undefined;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** frontmatter 裡的數字陣列（如 `appearsIn: [1, 3, 7]`）。去重並升序。 */
export function asNumberArray(v: string | string[] | undefined): number[] {
  const out = new Set<number>();
  for (const s of asArray(v)) {
    const n = Number(s.trim());
    if (Number.isInteger(n) && n > 0) {
      out.add(n);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * 把正文按 `## 小節名` 切開。返回小節名 → 內容（不含標題行，已 trim）。
 * `##` 之前的前言內容放在 key `''` 下。
 */
export function splitSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = body.split(/\r?\n/);
  let current = '';
  let buffer: string[] = [];

  const flush = () => {
    const content = buffer.join('\n').trim();
    if (current !== '' || content !== '') {
      const existing = sections.get(current);
      sections.set(current, existing ? `${existing}\n${content}` : content);
    }
    buffer = [];
  };

  for (const line of lines) {
    const heading = /^#{2,3}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      current = heading[1].replace(/[:：]\s*$/, '').trim();
    } else {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * 按給定鍵順序抽取小節，缺失的填空串。
 * 小節名匹配時忽略空白與常見標點差異（如「語言習慣」/「語言 習慣」）。
 */
export function pickSections<K extends string>(body: string, keys: readonly K[]): Record<K, string> {
  const found = splitSections(body);
  const normalizedIndex = new Map<string, string>();
  for (const [name, content] of found) {
    normalizedIndex.set(normalizeKey(name), content);
  }

  const result = {} as Record<K, string>;
  for (const key of keys) {
    result[key] = normalizedIndex.get(normalizeKey(key)) ?? '';
  }
  return result;
}

function normalizeKey(s: string): string {
  return traditionalLabel(s.replace(/[\s·・、,，.。:：/-]/g, '').toLowerCase());
}

/**
 * 空小節的佔位文字。
 *
 * `keepEmpty` 寫出的摘要裡，沒內容的小節仍會留一個 `## 小節名` + 這行字——
 * 檔案結構保持完整，作者手改時知道該往哪填。讀回來的一側要認得它：
 * 展示摘要時六個小節全是「（待補充）」不如乾脆不顯示。
 */
export const SECTION_PLACEHOLDER = '（待補充）';

/**
 * 這一節有沒有實質內容：空白與佔位文字（`（待補充）`，全形半形括號都認）不算。
 *
 * 「排過沒有」「填過沒有」這類判斷全靠它——模板裡帶著佔位的空殼被當成
 * 「已完成」的話，流水線狀態從此撒謊。從前 plotFile / volumeFile 各有一份
 * 同樣的私有函式，新文件格式一律用這一份。
 */
export function hasContent(text: string | undefined): boolean {
  const t = (text ?? '').trim();
  return t !== '' && !['（待补充）', '(待补充)', '（待補充）', '(待補充)'].includes(t);
}

/** 把小節 Record 序列化回 `## 小節名` 形式，跳過空小節。 */
export function stringifySections(
  sections: Record<string, string>,
  keys: readonly string[],
  opts: { keepEmpty?: boolean } = {}
): string {
  const parts: string[] = [];
  for (const key of keys) {
    const value = (sections[key] ?? '').trim();
    if (!value && !opts.keepEmpty) {
      continue;
    }
    parts.push(`## ${traditionalLabel(key)}\n\n${value || SECTION_PLACEHOLDER}`);
  }
  return parts.join('\n\n');
}

/**
 * 取正文**首行**的 `# 標題`，首行不是標題則返回 undefined。
 *
 * 刻意只看首行，與 stripH1 互為逆運算。早先這裡帶 `m` 標誌掃全文，
 * 於是正文中段任何一行 `# xxx` 都會被當成標題——但 stripH1 只剝開頭那行，
 * 結果是標題取自正文中段、那行卻還留在正文裡。章節可以是 .txt 之後，
 * 「正文裡出現一行以 # 開頭的字」不再是稀罕事，這個不對稱必須堵上。
 */
export function extractH1(body: string): string | undefined {
  const m = /^#[ \t]+(.+?)[ \t]*(?:\r?\n|$)/.exec(body);
  return m ? m[1].trim() : undefined;
}

/** 去掉正文開頭的 `# 標題` 行，返回純正文。 */
export function stripH1(body: string): string {
  return body.replace(/^#\s+.+?(\r?\n|$)/, '').trim();
}
