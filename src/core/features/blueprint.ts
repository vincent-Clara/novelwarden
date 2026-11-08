/**
 * 細綱批次（章節藍圖）的解碼：`{"blueprints":[…]}` → 一章一份的規劃欄位。
 *
 * **純函式、絕不拋**。合同與校驗規則移植自 AI-Novel-Writer（GPL-3.0，源自
 * AI_NovelGenerator）的 `src/shared/blueprint-semantic-contract.ts` 與
 * `commands/directory.command.ts` 的 `decodeGeneratedBlueprints`。
 *
 * ## 嚴格，但只對「結構」嚴格
 *
 * 批次路徑上沒有人逐份過目（第 19 條的批次那一面），全文兜底會把模型的一句
 * 「我不太確定」變成一份「已規劃」的細綱。所以這裡**缺必填欄位、型別不對就報診斷**，
 * 由生成鏈決定拆半重試還是單章重建（generation/structured.ts）。
 *
 * 但**超長不算錯**：上游在 `value_too_long` 時同樣截斷後再收（`normalizeGeneratedBlueprintText`）。
 * 超了幾十個字就作廢整批、再花一次呼叫，不划算；截斷寫進 `warnings`，落到卡片上。
 *
 * ## 與細綱七節的對應
 *
 * `synopsis` → 梗概，`characters` → 出場人物（計劃），`timePlace` → 時間地點，`keyEvents` → 關鍵事件，
 * `highlights` → 看點（爽點與章末吊著讀者的東西，從前單列的章末鉤子並在這裡），`stateChange` → 狀態變更。
 * 連續性事實計劃時沒有（證據要回正文定位），定稿時才生成。
 * 上游的 `relationships` 不要（細綱裡沒有它的位置）；`newCharacters` 可選，寫入細綱時直接給新角色建卡（D19）。
 *
 * `threads`（敘事線二期，原來的 `foreshadowing` 換成它）不進細綱：這一章在哪條線上計劃發生什麼（推進、關係、收束、
 * 埋〈伏筆〉、收〈伏筆〉），寫入細綱時整組換掉各條線裡這一章的計劃事件（generation/accept.ts → features/threadPlan.ts）。
 * 細綱裡不再有任何關於線的小節（設計稿：同一樣東西只有一份）。
 *
 * `keyEvents` 是一條一件事的列表，與定稿時寫出來的「關鍵事件」同一個形狀（定稿才能逐條改，
 * 而不是把一整段重寫一遍）。給成一段字也認（老合同的形狀）：按換行與分號切成條。
 *
 * `title` / `synopsis` 必須非空、`keyEvents` 至少一條、`characters` 至少一個人；其餘幾個欄位可以是空的——
 * 過渡章不推進哪條線是常事，為一個空陣列作廢整批、再花一次呼叫不划算。寫成別的形狀（該是陣列給了一行字）
 * 照收，不報診斷。
 */
import { normalizeGender } from '../model/gender';
import { BLUEPRINT_LIMITS } from '../model/plotFile';
import { LoreLine, loreLinesFromJson } from '../model/loreFile';
import { PlanEntry, decodePlanEntries, planEntryJson } from '../model/threadFile';
import type { PlotFields } from './artifact';
import { parseJson, singleJsonObject } from './structuredJson';

/** 一章的藍圖。 */
export interface BlueprintItem {
  no: number;
  title: string;
  /** 梗概：這一章計劃發生什麼，寫清因果鏈。 */
  synopsis: string;
  /** 計劃出場的人。 */
  characters: string[];
  timePlace: string;
  /** 關鍵事件：按發生的順序一條一件事，至少一條。 */
  keyEvents: string[];
  /** 看點：一條一句。 */
  highlights: string[];
  stateChange: string;
  /**
   * 這一章在敘事線上的計劃（敘事線二期）：寫入時整組換掉各條線裡這一章的計劃事件。沒寫（老會話裡存著的草稿）是 undefined
   * ——寫入時不動這一章原來的計劃（第 1 條）。
   */
  threads?: PlanEntry[];
  /** 本章首次登場、後面還會出場的重要角色。名字一定在 `characters` 裡；性別建卡時落進卡上。 */
  newCharacters: { name: string; role: string; gender?: string }[];
  /**
   * 本章計劃用到或引入的設定（「設定」一節，設定名錄）。`isNew` 的是本章首次引入、後面還會用到的，
   * 隨細綱一起建空條目（同新角色建卡，D19）；`note` 一句話寫它是什麼。
   */
  settings: (LoreLine & { isNew: boolean })[];
}

export { BLUEPRINT_LIMITS };

export interface BlueprintDiagnostic {
  code: 'not_json' | 'no_list' | 'missing_field' | 'invalid_type' | 'empty_value' | 'invalid_value';
  /** 出錯的位置，如 `blueprints[2].keyEvents`。緊湊重建時原樣告訴模型。 */
  path: string;
  /** 一句人話。 */
  message: string;
}

export type BlueprintDecode =
  | { ok: true; items: BlueprintItem[]; warnings: string[] }
  | { ok: false; diagnostic: BlueprintDiagnostic };

/** 上游角色定位列舉 → 角色卡 tags 裡的說法。中文原樣收。 */
const ROLE_LABEL: Record<string, string> = {
  protagonist: '主角',
  antagonist: '反派',
  supporting: '配角',
  minor: '次要',
};

export function roleLabel(role: string): string {
  const s = role.trim();
  return ROLE_LABEL[s.toLowerCase()] ?? s;
}

function pick(o: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(o, key)) {
      return o[key];
    }
  }
  return undefined;
}

function chars(s: string): number {
  return Array.from(s).length;
}

function clip(s: string, max: number): string {
  return Array.from(s).slice(0, max).join('');
}

/** 標題在標點處斷一次再截：模型很愛把一整句梗概當標題。 */
function clipTitle(s: string): string {
  const head = s.split(/[。！？；;\n]/)[0].trim() || s.trim();
  return chars(head) > BLUEPRINT_LIMITS.title ? clip(head, BLUEPRINT_LIMITS.title) : head;
}

/** 列表元素行首的編號與「-」：合同說了不要寫，模型照寫的也不少。 */
function stripMarker(s: string): string {
  return s.replace(/^\s*(?:[-*·•]|\d+[.、)])\s*/, '').trim();
}

/**
 * 關鍵事件給成了一段字 → 一條一項：按換行與分號（`；` `;`）切，去掉行首的列表記號。
 * 不按句號切——一條裡可以有好幾句。
 */
export function splitKeyEvents(text: string): string[] {
  return text.split(/\r?\n|[；;]/).map(stripMarker).filter(Boolean);
}

/**
 * 關鍵事件的原值 → 一條一項。陣列按元素收（某一條帶了換行就按行拆開：落盤後一行就是一條，
 * 拆開了讀回來才是同一份），一段字走 {@link splitKeyEvents}；都去掉行首的列表記號。
 * 形狀不對（數字、物件、元素不全是字串的陣列）返回 undefined。
 *
 * 批次（{@link decodeBlueprints}）與單章（features/artifact.ts 的 `parsePlotStrict`）共用這一份：
 * 兩個入口的輸出契約一致（第 22 條）。
 */
export function keyEventList(v: unknown): string[] | undefined {
  if (typeof v === 'string') {
    return splitKeyEvents(v);
  }
  if (Array.isArray(v) && v.every((x): x is string => typeof x === 'string')) {
    return v.flatMap((x) => x.split(/\r?\n/)).map(stripMarker).filter(Boolean);
  }
  return undefined;
}

/**
 * 解出藍圖清單。認 `{"blueprints":[…]}`，也認裸陣列；整段不是 JSON 時再試一次
 * 「唯一一個完整物件」（模型在 JSON 前後多說了兩句話）。
 */
export function decodeBlueprints(text: string): BlueprintDecode {
  let data = parseJson(text);
  if (data === undefined) {
    const single = singleJsonObject(text);
    if (!single.ok) {
      return {
        ok: false,
        diagnostic: {
          code: 'not_json',
          path: '$',
          message: single.reason === 'truncated' ? '輸出的 JSON 沒有寫完' : '輸出不是一個完整的 JSON 物件',
        },
      };
    }
    data = single.value;
  }
  const list =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>).blueprints ?? (data as Record<string, unknown>).chapters
      : data;
  if (!Array.isArray(list)) {
    return { ok: false, diagnostic: { code: 'no_list', path: 'blueprints', message: '輸出裡沒有 blueprints 列表' } };
  }

  const items: BlueprintItem[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const path = `blueprints[${i}]`;
    const row = list[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return { ok: false, diagnostic: { code: 'invalid_type', path, message: `第 ${i + 1} 項不是物件` } };
    }
    const o = row as Record<string, unknown>;

    const rawNo = pick(o, ['chapterNumber', 'chapter_number', 'no', 'chapter']);
    const no = typeof rawNo === 'number' ? rawNo : typeof rawNo === 'string' ? Number(rawNo.trim()) : NaN;
    if (rawNo === undefined) {
      return { ok: false, diagnostic: { code: 'missing_field', path: `${path}.chapterNumber`, message: `第 ${i + 1} 項缺 chapterNumber` } };
    }
    if (!Number.isSafeInteger(no) || no < 1) {
      return { ok: false, diagnostic: { code: 'invalid_value', path: `${path}.chapterNumber`, message: `第 ${i + 1} 項的章號不是正整數` } };
    }

    const field = (name: string, keys: readonly string[], max: number): string | BlueprintDiagnostic => {
      const v = pick(o, keys);
      if (v === undefined) {
        return { code: 'missing_field', path: `${path}.${name}`, message: `第 ${no} 章缺 ${name}` };
      }
      if (typeof v !== 'string') {
        return { code: 'invalid_type', path: `${path}.${name}`, message: `第 ${no} 章的 ${name} 不是文字` };
      }
      const s = v.trim();
      if (!s) {
        return { code: 'empty_value', path: `${path}.${name}`, message: `第 ${no} 章的 ${name} 是空的` };
      }
      if (chars(s) > max) {
        warnings.push(`第 ${no} 章的 ${name} 超過 ${max} 字，已截斷`);
        return clip(s, max);
      }
      return s;
    };

    const fields = {
      title: field('title', ['title', '标题'], Number.MAX_SAFE_INTEGER),
      // 合同要的是一句話加最多兩句（≤150 字，它就是大綱裡這一章那一條）；多寫幾句不截——截在半句上比長一點更糟，翻倍才截。
      synopsis: field('synopsis', ['synopsis', '梗概'], BLUEPRINT_LIMITS.synopsis * 2),
    };
    for (const v of Object.values(fields)) {
      if (typeof v !== 'string') {
        return { ok: false, diagnostic: v };
      }
    }
    const f = fields as Record<keyof typeof fields, string>;

    const keyEvents = eventsField(o, path, no, warnings);
    if (!Array.isArray(keyEvents)) {
      return { ok: false, diagnostic: keyEvents };
    }

    /** 可以空著的一行字。給成陣列就拼起來；超長截斷並記一條。 */
    const loose = (name: string, keys: readonly string[], max: number): string => {
      const v = pick(o, keys);
      const s = (Array.isArray(v) ? v.filter((x) => typeof x === 'string').join('；') : typeof v === 'string' ? v : '').trim();
      if (chars(s) > max) {
        warnings.push(`第 ${no} 章的 ${name} 超過 ${max} 字，已截斷`);
        return clip(s, max);
      }
      return s;
    };
    /** 可以空著的一條一句的列表。給成一行字就當一條；條數、每條字數超了截斷並記一條。 */
    const listField = (name: string, keys: readonly string[]): string[] => {
      const v = pick(o, keys);
      const raw = (Array.isArray(v) ? v : typeof v === 'string' ? [v] : [])
        .filter((x): x is string => typeof x === 'string')
        .map(stripMarker)
        .filter(Boolean);
      if (raw.length > BLUEPRINT_LIMITS.listItems) {
        warnings.push(`第 ${no} 章的 ${name} 列了 ${raw.length} 條，只留前 ${BLUEPRINT_LIMITS.listItems} 條`);
        raw.length = BLUEPRINT_LIMITS.listItems;
      }
      return raw.map((x) => {
        if (chars(x) > BLUEPRINT_LIMITS.listItem) {
          warnings.push(`第 ${no} 章的 ${name} 有一條超過 ${BLUEPRINT_LIMITS.listItem} 字，已截斷`);
          return clip(x, BLUEPRINT_LIMITS.listItem);
        }
        return x;
      });
    };

    const rawCast = pick(o, ['characters', '出场人物', '出場角色']);
    if (!Array.isArray(rawCast)) {
      return {
        ok: false,
        diagnostic: {
          code: rawCast === undefined ? 'missing_field' : 'invalid_type',
          path: `${path}.characters`,
          message: `第 ${no} 章的 characters 不是名單`,
        },
      };
    }
    const cast = [...new Set(rawCast.filter((x): x is string => typeof x === 'string').map((x) => clip(x.trim(), BLUEPRINT_LIMITS.name)).filter(Boolean))];
    if (cast.length === 0) {
      return { ok: false, diagnostic: { code: 'empty_value', path: `${path}.characters`, message: `第 ${no} 章沒有列出場角色` } };
    }
    if (cast.length > BLUEPRINT_LIMITS.characters) {
      warnings.push(`第 ${no} 章列了 ${cast.length} 個出場角色，只留前 ${BLUEPRINT_LIMITS.characters} 個`);
      cast.length = BLUEPRINT_LIMITS.characters;
    }

    const newCharacters: BlueprintItem['newCharacters'] = [];
    const rawNew = pick(o, ['newCharacters', 'newCharacterCandidates', '新角色']);
    if (Array.isArray(rawNew)) {
      for (const entry of rawNew) {
        const e = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : undefined;
        const name = typeof e?.name === 'string' ? e.name.trim() : typeof entry === 'string' ? entry.trim() : '';
        if (!name) {
          continue;
        }
        // 合同要求名字逐字出現在 characters 裡：別名、簡稱會建出一張重複的卡。
        if (!cast.includes(name)) {
          warnings.push(`第 ${no} 章的新角色「${name}」不在出場名單裡，沒有建卡`);
          continue;
        }
        if (!newCharacters.some((c) => c.name === name)) {
          const gender = normalizeGender(e?.gender ?? e?.性别);
          newCharacters.push({ name, role: roleLabel(typeof e?.role === 'string' ? e.role : ''), ...(gender ? { gender } : {}) });
        }
      }
    }

    items.push({
      no,
      title: clipTitle(f.title),
      synopsis: f.synopsis,
      characters: cast,
      timePlace: loose('timePlace', ['timePlace', 'time_place', '时间地点'], BLUEPRINT_LIMITS.timePlace),
      keyEvents,
      highlights: listField('highlights', ['highlights', '看点']),
      stateChange: loose('stateChange', ['stateChange', 'state_change', '状态变更'], BLUEPRINT_LIMITS.stateChange),
      ...planOf(pick(o, ['threads', '叙事线']), no, warnings),
      newCharacters,
      settings: blueprintSettings(pick(o, ['settings', 'lore', '设定']), no, warnings),
    });
  }
  return { ok: true, items, warnings };
}

/**
 * 關鍵事件：一條一件事的列表，至少一條（{@link keyEventList}）。條數超過 `BLUEPRINT_LIMITS.keyEventItems`
 * 只留前面的，合計字數超過 `BLUEPRINT_LIMITS.keyEvents` 從超出的那一條起截掉；兩樣都記一條說明，不作廢。
 */
function eventsField(
  o: Record<string, unknown>,
  path: string,
  no: number,
  warnings: string[]
): string[] | BlueprintDiagnostic {
  const at = `${path}.keyEvents`;
  const v = pick(o, ['keyEvents', 'key_events', '关键事件']);
  if (v === undefined) {
    return { code: 'missing_field', path: at, message: `第 ${no} 章缺 keyEvents` };
  }
  const raw = keyEventList(v);
  if (!raw) {
    return { code: 'invalid_type', path: at, message: `第 ${no} 章的 keyEvents 不是一條一件事的文字列表` };
  }
  if (raw.length === 0) {
    return { code: 'empty_value', path: at, message: `第 ${no} 章的 keyEvents 是空的` };
  }

  const maxItems = BLUEPRINT_LIMITS.keyEventItems;
  if (raw.length > maxItems) {
    warnings.push(`第 ${no} 章的 keyEvents 列了 ${raw.length} 條，只留前 ${maxItems} 條`);
    raw.length = maxItems;
  }
  const maxChars = BLUEPRINT_LIMITS.keyEvents;
  if (raw.reduce((n, event) => n + chars(event), 0) <= maxChars) {
    return raw;
  }
  warnings.push(`第 ${no} 章的 keyEvents 超過 ${maxChars} 字，已截斷`);
  const out: string[] = [];
  let left = maxChars;
  for (const event of raw) {
    if (left <= 0) {
      break;
    }
    out.push(chars(event) > left ? clip(event, left) : event);
    left -= chars(event);
  }
  return out;
}

/** 解出來的章號與這一批該有的章號對不對得上。 */
export interface BlueprintCoverage {
  missing: number[];
  duplicate: number[];
  unexpected: number[];
}

export function checkCoverage(items: readonly BlueprintItem[], expected: readonly number[]): BlueprintCoverage {
  const want = new Set(expected);
  const seen = new Set<number>();
  const duplicate = new Set<number>();
  const unexpected = new Set<number>();
  for (const item of items) {
    if (seen.has(item.no)) {
      duplicate.add(item.no);
    }
    seen.add(item.no);
    if (!want.has(item.no)) {
      unexpected.add(item.no);
    }
  }
  return {
    missing: expected.filter((no) => !seen.has(no)),
    duplicate: [...duplicate].sort((a, b) => a - b),
    unexpected: [...unexpected].sort((a, b) => a - b),
  };
}

/**
 * 一章藍圖 → 細綱的七節（落盤時用），外加「設定」一節。出場人物寫成「林昭、沈氏」一行，關鍵事件、
 * 看點一條一行（`- …`），與定稿寫出來的樣子一致；連續性事實計劃時是空的。`threads` 隨產物帶著，不進細綱。
 */
export function blueprintToPlot(item: BlueprintItem): PlotFields {
  return {
    sections: {
      梗概: item.synopsis,
      出场人物: item.characters.join('、'),
      时间地点: item.timePlace,
      关键事件: listText(item.keyEvents),
      看点: listText(item.highlights),
      状态变更: item.stateChange,
      连续性事实: '',
    },
    title: item.title,
    // 會話裡存著的老草稿沒有這個欄位（第 1 條）。
    lore: (item.settings ?? []).map(({ name, category, note }) => ({ name, category, note })),
    ...(item.threads ? { threads: item.threads } : {}),
  };
}

/** 一章的 `threads`（{@link decodePlanEntries}）：沒寫就不帶這個欄位；沒收的那幾條進 `warnings`（落到卡片上）。 */
function planOf(raw: unknown, no: number, warnings: string[]): Pick<BlueprintItem, 'threads'> {
  const { entries, notes } = decodePlanEntries(raw, no);
  warnings.push(...notes);
  return entries ? { threads: entries } : {};
}

/** 一章最多計劃幾條設定。 */
const BLUEPRINT_SETTINGS = 8;

/**
 * 藍圖的 `settings`（可選，寬鬆收）：寫法與定稿的「設定」欄位同一套（`loreLinesFromJson`），
 * 外加 `isNew`。不是陣列、沒寫都當沒有，不讓一個可選欄位拖垮整批；超出 8 條只留前 8 條並說明。
 */
function blueprintSettings(raw: unknown, no: number, warnings: string[]): BlueprintItem['settings'] {
  if (raw === undefined || raw === null) {
    return [];
  }
  const lines = loreLinesFromJson(raw);
  const flags = Array.isArray(raw) ? raw : [];
  const out = lines.map((line) => {
    const src = flags.find(
      (x) => x && typeof x === 'object' && (x as Record<string, unknown>).name === line.name
    ) as Record<string, unknown> | undefined;
    const isNew = src?.isNew === true || src?.isNew === 'true' || src?.新 === true;
    return { ...line, isNew };
  });
  if (out.length > BLUEPRINT_SETTINGS) {
    warnings.push(`第 ${no} 章列了 ${out.length} 條設定，只留前 ${BLUEPRINT_SETTINGS} 條`);
    out.length = BLUEPRINT_SETTINGS;
  }
  return out;
}

function listText(items: readonly string[]): string {
  return items.map((x) => `- ${x}`).join('\n');
}

/**
 * 規範化輸出：生成鏈最後交給氣泡、也是採納時重新解析的那一份。
 *
 * 用合同裡的英文鍵寫回去，而不是細綱檔案的樣子：作者在氣泡裡改了再點寫入時，
 * 走的是同一個 {@link decodeBlueprints}，形狀必須原樣認得。
 */
export function renderBlueprints(items: readonly BlueprintItem[]): string {
  const blueprints = items.map((b) => ({
    chapterNumber: b.no,
    title: b.title,
    synopsis: b.synopsis,
    characters: b.characters,
    timePlace: b.timePlace,
    keyEvents: b.keyEvents,
    highlights: b.highlights,
    stateChange: b.stateChange,
    ...(b.threads ? { threads: b.threads.map(planEntryJson) } : {}),
    ...(b.newCharacters.length > 0 ? { newCharacters: b.newCharacters } : {}),
    ...(b.settings?.length ? { settings: b.settings.map(({ name, category, isNew, note }) => ({ name, category, isNew, note })) } : {}),
  }));
  return JSON.stringify({ blueprints }, null, 2);
}
