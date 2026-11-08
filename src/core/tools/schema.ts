/**
 * 引數 schema 的寫法，以及守著它的那批校驗。
 *
 * ## 模型只看得見兩樣東西
 *
 * `description` 與 `parameters`。它決定「這一步該調哪個工具、引數怎麼填」時，
 * 手上就這些。所以這一層真正的活不是轉換格式（那是十行），而是**把描述與
 * schema 的寫法釘死**——描述會慢慢跑偏，schema 會慢慢長出巢狀，兩者都不會
 * 報錯，只會讓模型的呼叫成功率一點點掉下去。
 *
 * ## 描述怎麼寫：三條原則
 *
 * 1. **說清座標系**。工程裡的東西全是普通 Markdown，路徑就是它們的身份：
 *    架構與大綱在 `.novelwarden/` 根下，細綱一章一份放在 `.novelwarden/summaries/`（與正文同樣的相對路徑），
 *    正文在章節根（預設 `chapters/`）。不說清楚，模型會去猜一個不存在的路徑
 *    然後反覆重試。
 * 2. **說清限制**。「一次最多返回 400 行，超出會截斷並告訴你截了多少」——
 *    這既是第 2 條（不靜默截斷）的落點，也是讓模型知道「還有下一頁」的唯一
 *    途徑。
 * 3. **不寫領域知識**。「細綱的關鍵事件寫到什麼程度、看點怎麼留」那幾句在
 *    `context/prompts.ts` 裡，由 `generate` **內部那次呼叫**自己帶著。在工具
 *    描述裡再寫一遍，一是白燒 token（每一輪都要發），二是兩處遲早跑偏——
 *    而跑偏之後沒有任何測試會紅。
 *
 * ## 引數儘量扁平
 *
 * `{path, offset, limit}` 好過 `{target: {kind, chapterNo}}`。巢狀
 * 物件是模型最容易填錯的地方，而填錯的表現是一次白花的往返。所以
 * {@link validateToolDef} **直接拒絕巢狀物件屬性**，不是靠人記得。
 */
import type { ToolDef } from './types';

interface PropSchema {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description: string;
  items?: { type: 'string' | 'number' | 'integer' | 'boolean' };
  enum?: string[];
}

export function str(description: string, values?: string[]): PropSchema {
  return values ? { type: 'string', description, enum: values } : { type: 'string', description };
}

export function int(description: string): PropSchema {
  return { type: 'integer', description };
}

export function bool(description: string): PropSchema {
  return { type: 'boolean', description };
}

export function strArray(description: string): PropSchema {
  return { type: 'array', description, items: { type: 'string' } };
}

/**
 * 拼一個物件 schema。`required` 裡的鍵必須在 `props` 裡，否則
 * {@link validateToolDef} 會報出來。
 *
 * `additionalProperties: false` 是有意的：模型多塞一個欄位時我們希望**當場
 * 知道**，而不是安靜地忽略掉一個它以為自己傳了的引數。
 */
export function objectSchema(
  props: Record<string, PropSchema>,
  required: string[] = []
): Record<string, unknown> {
  return { type: 'object', properties: props, required, additionalProperties: false };
}

/**
 * 校驗一條定義。返回一句人話說明哪裡不對，沒問題時返回 undefined。
 *
 * 呼叫方（{@link ToolRegistry}）拿到說明就拋。這不是防禦性程式設計：這些 schema
 * 是我們自己寫的常量，跑一次就固定下來了。拋在註冊那一刻等於把「描述寫歪了」
 * 變成一條紅測試，而不是三個月後某次對話裡模型莫名其妙填錯引數。
 */
export function validateToolDef(def: ToolDef, seen: ReadonlySet<string>): string | undefined {
  if (!/^[a-z][a-z0-9_]*$/.test(def.name ?? '')) {
    // 各家 API 對工具名的字符集要求不一，取交集最省心。
    return '名字只能是小寫字母、數字與下劃線，且以字母開頭';
  }
  if (seen.has(def.name)) {
    return '名字重複了——同名工具模型只認得出一個，另一個永遠調不到';
  }
  if (!def.description?.trim()) {
    return '沒有描述。模型只靠描述與引數決定怎麼用它';
  }

  const schema = def.parameters as { type?: unknown; properties?: unknown; required?: unknown };
  if (schema?.type !== 'object' || !isPlainObject(schema.properties)) {
    return 'parameters 必須是 `{ type: "object", properties: {…} }`';
  }
  const props = schema.properties as Record<string, unknown>;

  for (const [key, raw] of Object.entries(props)) {
    if (!isPlainObject(raw)) {
      return `引數 ${key} 的 schema 不是物件`;
    }
    // 這條路上的輸入可能是手寫的字面量 schema（測試裡就是），所以按最松的
    // 形狀讀，不套 PropSchema——校驗器自己不該假設被校驗的東西已經合法。
    const type = typeof raw.type === 'string' ? raw.type : '';
    const description = typeof raw.description === 'string' ? raw.description : '';
    const items = isPlainObject(raw.items) ? raw.items : undefined;

    if (!description.trim()) {
      return `引數 ${key} 沒有 description——模型看不出該填什麼`;
    }
    // 扁平：巢狀物件是模型最容易填錯的地方。
    if (type === 'object') {
      return `引數 ${key} 是巢狀物件。攤平成幾個標量引數（{path, offset, limit} 好過 {target:{…}}）`;
    }
    if (type === 'array' && items?.type === undefined) {
      return `引數 ${key} 是陣列但沒說元素型別`;
    }
    if (type === 'array' && items?.type === 'object') {
      return `引數 ${key} 是物件陣列。攤平它`;
    }
  }

  const required = schema.required ?? [];
  if (!Array.isArray(required)) {
    return 'required 必須是陣列';
  }
  for (const key of required) {
    if (!(key in props)) {
      return `required 裡的 ${String(key)} 不在 properties 裡`;
    }
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 按 `parameters` 校驗一次呼叫的入參：缺必填、型別不對、不在列舉裡、多塞了 schema 裡沒有的鍵。
 * 返回一句給模型的話，沒問題時 undefined。
 *
 * 只認 {@link objectSchema} 拼得出的那幾種形狀。空串不算缺——`edit` 的 `new` 就是靠空串表示刪掉，
 * 「不能為空」由各工具自己的 `check` 說。
 */
export function checkArgs(parameters: Record<string, unknown>, args: Record<string, unknown>): string | undefined {
  const props = (isPlainObject(parameters.properties) ? parameters.properties : {}) as Record<string, PropSchema>;
  const required = Array.isArray(parameters.required) ? (parameters.required as string[]) : [];

  const missing = required.filter((key) => args[key] === undefined || args[key] === null);
  if (missing.length > 0) {
    return `缺少引數：${missing.map((k) => `${k}（${props[k]?.description ?? ''}）`).join('；')}`;
  }
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) {
      continue;
    }
    const prop = props[key];
    if (!prop) {
      return `沒有 ${key} 這個引數。可用的是：${Object.keys(props).join(' / ')}。`;
    }
    const items = prop.items;
    if (!matchesType(prop.type, value) || (items && !(value as unknown[]).every((v) => matchesType(items.type, v)))) {
      return `${key} 應該是${TYPE_NAMES[prop.type]}${items ? `（元素是${TYPE_NAMES[items.type]}）` : ''}。`;
    }
    if (prop.enum && !prop.enum.includes(value as string)) {
      return `${key} 只能是：${prop.enum.join(' / ')}。`;
    }
  }
  return undefined;
}

const TYPE_NAMES: Record<PropSchema['type'], string> = {
  string: '字串',
  number: '數字',
  integer: '整數',
  boolean: 'true / false',
  array: '陣列',
};

function matchesType(type: PropSchema['type'], value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
  }
}
