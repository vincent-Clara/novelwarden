/**
 * 結構化輸出的 JSON 小工具：整段或「唯一一個完整物件」取 JSON、認出「看起來是 JSON 卻解析不了」的輸出，以及轉寫
 * （2026-10-25 起，features/transcribe.ts）要的兩樣：原文寫「無」的換空、轉寫的每段文字都得出自原文。
 *
 * **純函式、絕不拋**。「唯一一個完整物件」移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）的
 * `commands/architecture.command.ts` 的 `extractSingleCompleteJsonObject`。從前這裡還有語法修復的證據校驗（修過的那份只許
 * 改標點）；語法修復整個換成了轉寫——轉寫順帶把語法理順，「只許照抄」由 `unfaithfulStrings` 查。
 */
import { stripCodeFence } from './parse';

/**
 * 輸出看起來是 JSON（剝掉圍欄後以 `{` 或 `[` 開頭）卻解析不了：轉寫照樣轉它（順帶理順語法），不按「不像這一步的輸出」
 * 跳過（features/transcribe.ts）。
 */
export function isRepairableJsonSyntax(content: string): boolean {
  const candidate = stripCodeFence(content);
  if (!/^[{[]/.test(candidate)) {
    return false;
  }
  try {
    JSON.parse(candidate);
    return false;
  } catch {
    return true;
  }
}

/** 解析整段輸出（剝掉圍欄）。失敗返回 undefined。 */
export function parseJson(content: string): unknown {
  try {
    return JSON.parse(stripCodeFence(content));
  } catch {
    return undefined;
  }
}

/** 從 `start` 那個 `{` 起，找到與它配對的 `}`；字串裡的括號不算。找不到返回 undefined。 */
function completeObjectEnd(source: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return i;
      }
      if (depth < 0) {
        return undefined;
      }
    }
  }
  return undefined;
}

export type SingleObjectResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: 'none' | 'truncated' | 'multiple' };

/**
 * 輸出裡**唯一一個**完整的頂層 JSON 物件。
 *
 * 比「第一個 `{` 到最後一個 `}`」嚴：模型先吐一個示例物件、再吐真正的那個時，
 * 寬鬆的摳法會把兩者連成一段非法 JSON，或者更糟——拿到那個示例。有兩個完整物件
 * 就說不清哪個是答案，報 `multiple`；最後一個沒閉合，報 `truncated`。
 */
export function singleJsonObject(content: string): SingleObjectResult {
  const source = stripCodeFence(content);
  const found: Record<string, unknown>[] = [];
  let from = 0;
  while (from < source.length) {
    const start = source.indexOf('{', from);
    if (start === -1) {
      break;
    }
    const end = completeObjectEnd(source, start);
    if (end === undefined) {
      return found.length > 0 ? { ok: true, value: found[0] } : { ok: false, reason: 'truncated' };
    }
    try {
      const value: unknown = JSON.parse(source.slice(start, end + 1));
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        found.push(value as Record<string, unknown>);
      }
    } catch {
      // 壞掉的片段不修也不收，接著往後找。
    }
    from = end + 1;
  }
  if (found.length === 1) {
    return { ok: true, value: found[0] };
  }
  return { ok: false, reason: found.length > 1 ? 'multiple' : 'none' };
}

// ---------------------------------------------------------------- 轉寫（2026-10-25 細綱試點）

/** 整段是 JSON 就取它，否則取「唯一一個完整物件」（{@link singleJsonObject}）；都不是返回 undefined。 */
export function jsonValueOf(content: string): unknown {
  const whole = parseJson(content);
  if (whole !== undefined) {
    return whole;
  }
  const single = singleJsonObject(content);
  return single.ok ? single.value : undefined;
}

/** 原文裡「哪一節沒有內容就寫『無』」，轉寫模型偶爾照抄成 `"無"`：文字換成空的，列表裡的去掉。 */
const NONE = /^[（(]?\s*(?:无|無)\s*[)）]?[。.]?$/u;

export function withoutNone(value: unknown): unknown {
  if (typeof value === 'string') {
    return NONE.test(value.trim()) ? '' : value;
  }
  if (Array.isArray(value)) {
    return value.filter((x) => !(typeof x === 'string' && NONE.test(x.trim()))).map(withoutNone);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutNone(v)]));
  }
  return value;
}

/** 比對用的樣子：去掉空白、標點與符號。 */
function bare(s: string): string {
  return s.replace(/[\s\p{P}\p{S}]/gu, '');
}

/** 原文是一段壞了語法的 JSON 時，裡面的 `\n`、`\"`、`一` 還是轉義的樣子；還原了再比，不然多出一個 `n`。 */
function unescapeJson(s: string): string {
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\[nrtbf]/g, ' ')
    .replace(/\\(["\\/])/g, '$1');
}

/**
 * 轉寫有沒有照抄：JSON 裡每一段文字都得在原文裡找得到，交回找不到的那幾段（最多 `limit` 段，截到 30 字，給說明與
 * 重轉那一次用）。
 *
 * 比對之前兩邊都去掉空白、標點與符號：去掉行首的「-」、把兩行併成一條、拆成兩條、換個引號都不算改；改了一個字、
 * 補了原文沒有的一句就找不到。`skip` 裡那幾個鍵的值是按對應關係填的（章號、推進 / 埋、主角 / 反派……），不比；
 * 陣列裡的文字跟著陣列所在的鍵。
 */
export function unfaithfulStrings(source: string, value: unknown, skip: ReadonlySet<string>, limit = 3): string[] {
  const hay = bare(unescapeJson(source));
  const off: string[] = [];
  const walk = (v: unknown, key: string | undefined): void => {
    if (off.length >= limit || (key !== undefined && skip.has(key))) {
      return;
    }
    if (typeof v === 'string') {
      const needle = bare(v);
      if (needle && !hay.includes(needle)) {
        off.push(Array.from(v.trim()).length > 30 ? `${Array.from(v.trim()).slice(0, 30).join('')}…` : v.trim());
      }
    } else if (Array.isArray(v)) {
      v.forEach((x) => walk(x, key));
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        walk(x, k);
      }
    }
  };
  walk(value, undefined);
  return off;
}
