/**
 * 角色圖譜的兩段式解碼：先是一張**身份清單**（誰、什麼定位、在故事裡幹什麼、彼此什麼關係），
 * 再按清單每批 3 人補**詳情**，最後拼成一張張角色卡。
 *
 * **純函式、絕不拋**。兩段式與合同移植自 AI-Novel-Writer（GPL-3.0，源自
 * AI_NovelGenerator）的 `GenerateCharactersCommand`（`commands/architecture.command.ts:719-1647`）
 * 與 `prompt-language.ts` 的身份 / 詳情合同。
 *
 * ## 為什麼分兩步
 *
 * 一次要八個人的全部資料，輸出長到容易被截斷，而且人與人之間的關係在長輸出裡
 * 前後打架（A 說 B 是他師兄，B 說 A 是他仇人）。先凍結一張清單，關係只在清單裡
 * 寫一次、由程式碼生成到雙方的卡上；詳情那一步**不許**再寫關係，只補每個人自己的資料。
 *
 * ## 比上游寬鬆的地方
 *
 * 上游任何一處不合格都整份作廢。這裡只有「清單裡一個能用的人都沒有」才算失敗；
 * 人數不在 3–8、沒標主角、關係指向清單外的人、某人詳情缺了——都照收並寫進 `warnings`，
 * 落盤卡片上列出來。角色圖譜是一次一份、攤在卡片上給作者看的產物，
 * 作者看得見缺了什麼；作廢它只是讓他再花一輪錢。
 */
import { normalizeGender } from '../model/gender';
import { CHARACTER_DETAIL_LIMITS, CHARACTER_SECTION_KEYS, CharacterSections } from '../model/types';
import { roleLabel } from './blueprint';
import { parseJson, singleJsonObject } from './structuredJson';

/** 角色圖譜裡的一個人。落盤時變成一張角色卡。 */
export interface RosterEntry {
  name: string;
  /** 主角 / 盟友 / 對手……落進角色卡的 tags。 */
  role: string;
  aliases: string[];
  /** 落進角色卡 frontmatter 的 `gender`。 */
  gender?: string;
  sections: Partial<CharacterSections>;
}

/** 身份清單裡的一個人。 */
export interface IdentitySlot {
  slotId: string;
  name: string;
  /** 已換成中文說法（主角 / 反派 / 配角 / 次要）。 */
  role: string;
  /**
   * 性別放在清單這一步定：一班人馬男女怎麼配是排角色時的事，到了補詳情那一步再定，
   * 每批只看得見三個人。
   */
  gender?: string;
  /** 這個人在故事裡承擔什麼敘事職責。 */
  duty: string;
  relations: { target: string; relation: string }[];
}

export type ManifestDecode =
  | { ok: true; slots: IdentitySlot[]; warnings: string[] }
  | { ok: false; message: string };

/** 上游的四種定位。清單那一步要求模型只用這幾個英文值。 */
const ROLES = ['protagonist', 'antagonist', 'supporting', 'minor'];

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}

function objectOf(text: string): Record<string, unknown> | undefined {
  const whole = parseJson(text);
  if (whole && typeof whole === 'object' && !Array.isArray(whole)) {
    return whole as Record<string, unknown>;
  }
  const single = singleJsonObject(text);
  return single.ok ? single.value : undefined;
}

/**
 * 身份清單 `{"slots":[{slotId,name,role,narrativeDuty,relations:[{targetSlotId,relation}]}]}`。
 *
 * 重名的第二個丟掉、指向清單外或指向自己的關係丟掉，都記進 warnings。
 */
export function decodeManifest(text: string): ManifestDecode {
  const obj = objectOf(text);
  const rows = obj?.slots ?? obj?.characters ?? (Array.isArray(parseJson(text)) ? parseJson(text) : undefined);
  if (!Array.isArray(rows)) {
    return { ok: false, message: '身份清單不是 {"slots":[…]} 的形狀' };
  }
  const warnings: string[] = [];
  const slots: IdentitySlot[] = [];
  const raw: { slot: IdentitySlot; relations: unknown }[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const o = rows[i] && typeof rows[i] === 'object' ? (rows[i] as Record<string, unknown>) : undefined;
    const name = str(o?.name);
    if (!o || !name) {
      warnings.push(`身份清單第 ${i + 1} 項沒有名字，跳過`);
      continue;
    }
    if (names.has(name)) {
      warnings.push(`身份清單裡「${name}」出現了兩次，只收第一個`);
      continue;
    }
    let slotId = str(o.slotId) || String(i + 1);
    if (ids.has(slotId)) {
      slotId = `${slotId}#${i + 1}`;
    }
    const role = str(o.role).toLowerCase();
    if (!ROLES.includes(role)) {
      warnings.push(`「${name}」的定位「${str(o.role) || '（空）'}」認不出，按配角算`);
    }
    const slot: IdentitySlot = {
      slotId,
      name,
      role: roleLabel(ROLES.includes(role) ? role : 'supporting'),
      gender: normalizeGender(o.gender ?? o.性别),
      duty: str(o.narrativeDuty ?? o.duty),
      relations: [],
    };
    ids.add(slotId);
    names.add(name);
    slots.push(slot);
    raw.push({ slot, relations: o.relations });
  }
  if (slots.length === 0) {
    return { ok: false, message: '身份清單裡一個能用的人都沒有' };
  }

  const byId = new Map(slots.map((s) => [s.slotId, s]));
  for (const { slot, relations } of raw) {
    for (const r of Array.isArray(relations) ? relations : []) {
      const rel = r && typeof r === 'object' ? (r as Record<string, unknown>) : undefined;
      const target = byId.get(str(rel?.targetSlotId));
      const relation = str(rel?.relation);
      if (!target || target === slot || !relation) {
        warnings.push(`「${slot.name}」有一條關係指向清單外的人或指向自己，丟掉`);
        continue;
      }
      slot.relations.push({ target: target.name, relation });
    }
  }

  if (slots.length < 3 || slots.length > 8) {
    warnings.push(`身份清單有 ${slots.length} 人，合同要求 3–8 人`);
  }
  if (!slots.some((s) => s.role === '主角')) {
    warnings.push('身份清單裡沒有標出主角');
  }
  return { ok: true, slots, warnings };
}

/** 詳情那一步要寫的六節與各自的字數上限（第 15 條：角色卡不能無限膨脹）。 */
export const DETAIL_LIMITS = CHARACTER_DETAIL_LIMITS;

export const DETAIL_KEYS = Object.keys(DETAIL_LIMITS) as (keyof typeof DETAIL_LIMITS)[];

/** 一個人的詳情（不含關係——關係只來自清單）。 */
export interface CharacterDetail {
  slotId: string;
  aliases: string[];
  sections: Partial<CharacterSections>;
}

export type DetailsDecode =
  | { ok: true; items: CharacterDetail[]; warnings: string[] }
  | { ok: false; message: string };

/**
 * 一批詳情 `{"entries":[{slotId,name,role,身份,外貌,…}]}`。
 *
 * 只認這一批該有的 slotId；名字或定位與凍結清單對不上時以清單為準（清單是凍結的，
 * 詳情那一步不許改人）。整段解不出來才算失敗——交給生成鏈拆半重試。
 */
export function decodeDetails(text: string, batch: readonly IdentitySlot[]): DetailsDecode {
  const obj = objectOf(text);
  const rows = obj?.entries ?? obj?.characters;
  if (!Array.isArray(rows)) {
    return { ok: false, message: '角色詳情不是 {"entries":[…]} 的形狀' };
  }
  const warnings: string[] = [];
  const wanted = new Map(batch.map((s) => [s.slotId, s]));
  const byName = new Map(batch.map((s) => [s.name, s]));
  const items: CharacterDetail[] = [];
  for (const row of rows) {
    const o = row && typeof row === 'object' ? (row as Record<string, unknown>) : undefined;
    if (!o) {
      continue;
    }
    // 模型常把 slotId 寫丟，名字總還在。
    const slot = wanted.get(str(o.slotId)) ?? byName.get(str(o.name));
    if (!slot) {
      warnings.push(`詳情裡多出一個清單外的人「${str(o.name) || str(o.slotId)}」，丟掉`);
      continue;
    }
    if (items.some((d) => d.slotId === slot.slotId)) {
      continue;
    }
    const sections: Partial<CharacterSections> = {};
    for (const key of DETAIL_KEYS) {
      const value = toText(o[key]);
      if (!value) {
        continue;
      }
      const max = DETAIL_LIMITS[key];
      if (Array.from(value).length > max) {
        warnings.push(`「${slot.name}」的${key}超過 ${max} 字，已截斷`);
        sections[key] = Array.from(value).slice(0, max).join('');
      } else {
        sections[key] = value;
      }
    }
    const aliases = Array.isArray(o.aliases)
      ? o.aliases.map(str).filter((a) => a && a !== slot.name)
      : str(o.aliases).split(/[,，、]/).map((a) => a.trim()).filter((a) => a && a !== slot.name);
    items.push({ slotId: slot.slotId, aliases: [...new Set(aliases)], sections });
  }
  return { ok: true, items, warnings };
}

function toText(v: unknown): string {
  if (Array.isArray(v)) {
    return v.map(str).filter(Boolean).join('；');
  }
  return str(v);
}

/**
 * 清單 + 詳情 → 角色卡。
 *
 * 「人物關係」一節由清單生成：自己寫的那幾條，加上別人寫向自己、而自己沒寫回去的
 * （「A 眼中——……」），兩張卡上都看得見這段關係。「敘事職責」接在身份那一節最後。
 * 詳情缺席的人仍然建卡，身份那一節只有敘事職責，並記一條 warning。
 */
export function assembleRoster(
  slots: readonly IdentitySlot[],
  details: readonly CharacterDetail[]
): { entries: RosterEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  const bySlot = new Map(details.map((d) => [d.slotId, d]));
  const entries = slots.map((slot) => {
    const detail = bySlot.get(slot.slotId);
    if (!detail) {
      warnings.push(`「${slot.name}」的詳情沒有生成出來，只按身份清單建卡`);
    }
    const sections: Partial<CharacterSections> = { ...(detail?.sections ?? {}) };
    if (slot.duty) {
      sections.身份 = [sections.身份, `敘事職責：${slot.duty}`].filter(Boolean).join('\n');
    }
    const lines = slot.relations.map((r) => `- 與${r.target}：${r.relation}`);
    for (const other of slots) {
      if (other === slot || slot.relations.some((r) => r.target === other.name)) {
        continue;
      }
      for (const r of other.relations.filter((x) => x.target === slot.name)) {
        lines.push(`- 與${other.name}：${other.name}眼中——${r.relation}`);
      }
    }
    if (lines.length > 0) {
      sections.人物关系 = lines.join('\n');
    }
    return { name: slot.name, role: slot.role, aliases: detail?.aliases ?? [], gender: slot.gender, sections };
  });
  return { entries, warnings };
}

/**
 * 規範化輸出：`{"characters":[…]}`，鍵就是角色卡的七節（外加性別）。生成鏈最後交給氣泡的那一份，
 * 也是採納時重新解析的那一份（artifact.ts 的 `parseRoster` 認得它）。
 */
export function renderRoster(entries: readonly RosterEntry[]): string {
  const characters = entries.map((e) => {
    const row: Record<string, unknown> = { name: e.name, role: e.role };
    if (e.gender) {
      row.性别 = e.gender;
    }
    if (e.aliases.length > 0) {
      row.aliases = e.aliases;
    }
    for (const key of CHARACTER_SECTION_KEYS) {
      if (e.sections[key]?.trim()) {
        row[key] = e.sections[key];
      }
    }
    return row;
  });
  return JSON.stringify({ characters }, null, 2);
}
