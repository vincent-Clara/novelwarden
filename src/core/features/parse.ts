/** 剝掉包住整段模型輸出的 Markdown 程式碼圍欄，並清理首尾空白。 */
export function stripCodeFence(text: string): string {
  const m = /^\s*```(?:\w+)?\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(text.trim());
  return (m ? m[1] : text).trim();
}

/** 從可能夾雜廢話的文字裡摳出最外層 JSON 物件。 */
export function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }
  return text.slice(start, end + 1);
}

/** 從可能夾雜廢話的文字裡摳出最外層 JSON 陣列。 */
export function extractJsonArray(text: string): string | undefined {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }
  return text.slice(start, end + 1);
}

/** 從文字中摳出最先出現的 JSON 物件或陣列。 */
export function extractJson(text: string): string | undefined {
  const arrayStart = text.indexOf('[');
  const objectStart = text.indexOf('{');
  const starts = [arrayStart, objectStart].filter((n) => n >= 0);
  if (starts.length === 0) {
    return undefined;
  }
  const start = Math.min(...starts);
  const end = text[start] === '[' ? text.lastIndexOf(']') : text.lastIndexOf('}');
  return end > start ? text.slice(start, end + 1) : undefined;
}

/**
 * 去掉 `]` / `}` 前面多出來的逗號（`["甲", "乙",]`）。模型最常見的 JSON 語法錯就是這一個，
 * 它不改任何值，可以放心地自己修，不必為它再調一次模型。字串裡的逗號不動。
 */
export function stripTrailingCommas(json: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (inString) {
      out += ch;
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
    } else if (ch === ',') {
      const rest = json.slice(i + 1).trimStart();
      if (rest.startsWith(']') || rest.startsWith('}')) {
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/**
 * 模型交回來的 JSON 裡取那一組：`{"threads":[…]}` / `{"events":[…]}` / `{"conflicts":[…]}`，也認上游的
 * `{"candidates":[…]}` 與直接一個陣列。解不出返回 undefined。
 *
 * 從前放在 features/threads.ts（七期排線與判事件用），寫前衝突檢查（features/plotCheck.ts）也借它；
 * 敘事線重做之後那一份要整個換掉，寬鬆取一組 JSON 這件事本來就屬於這裡。
 */
export function jsonList(raw: string, key: string): unknown[] | undefined {
  const text = stripCodeFence(raw);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    const inner = extractJson(text);
    try {
      value = inner ? JSON.parse(inner) : undefined;
    } catch {
      value = undefined;
    }
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const list = o[key] ?? o.candidates;
    return Array.isArray(list) ? list : undefined;
  }
  return undefined;
}

/** 清理字串並按首次出現順序去重。 */
export function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/** 數字去重並升序排列。 */
export function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/** 把模型常見的字串陣列或分隔字串歸一成字串陣列。 */
export function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}
