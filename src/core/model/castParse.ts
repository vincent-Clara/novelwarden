import { resolveRoleLabelName, sanitizeAliases } from './naming';
import { SummaryCast } from './types';

/**
 * `林昭(阿昭、昭兒)` ←→ `{ name: '林昭', aliases: ['阿昭', '昭兒'] }`。
 *
 * 用括號而不是巢狀 YAML：本專案的 frontmatter 解析器（model/markdown.ts）
 * 刻意只支援字串與字串陣列，為了一個欄位引入真正的 YAML 依賴不值得。
 * 括號形式作者也能一眼看懂、直接手改。
 */
export function renderCastEntry(entry: SummaryCast): string {
  const aliases = entry.aliases.filter((a) => a.trim() && a.trim() !== entry.name);
  return aliases.length > 0 ? `${entry.name}(${aliases.join('、')})` : entry.name;
}

export function parseCastEntry(raw: string): SummaryCast | undefined {
  const text = raw.trim();
  if (!text) {
    return undefined;
  }
  // 全形括號也認——作者手改時很可能打出中文括號。
  const m = /^(.*?)[（(]([^）)]*)[）)]\s*$/.exec(text);
  if (!m) {
    return { name: text, aliases: [] };
  }
  const name = m[1].trim();
  if (!name) {
    return { name: text, aliases: [] };
  }
  return {
    name,
    aliases: m[2]
      .split(/[、,，/]/)
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/**
 * frontmatter 的 `cast` 欄位 → 結構化清單。
 * 欄位**缺席**返回 undefined（呼叫方據此決定回退解析小節文字）；
 * 欄位存在但為空陣列返回 `[]`——那是「這一章確實沒人出場」，不該回退。
 */
export function parseCast(v: string | string[] | undefined): SummaryCast[] | undefined {
  if (v === undefined) {
    return undefined;
  }
  const list = Array.isArray(v) ? v : [v];
  const out: SummaryCast[] = [];
  for (const raw of list) {
    pushCast(out, parseCastEntry(raw));
  }
  return out;
}

/**
 * 一條出場人物落進清單。正式名是劇作稱謂的（`主角(林昭)`，model/naming.ts）換成真名，換不出來的
 * （光一個 `反派`）丟掉——它不是一個人；換完撞上前面已有的同一個人，別名並過去。別名不在這裡過濾，
 * 呼叫方各自過泛稱關。老細綱 frontmatter 裡已經寫下的 `主角(林昭)` 讀出來也就是林昭。
 */
export function pushCast(out: SummaryCast[], entry: SummaryCast | undefined): void {
  if (!entry?.name) {
    return;
  }
  const resolved = resolveRoleLabelName(entry.name, entry.aliases);
  if (!resolved) {
    return;
  }
  const same = out.find((c) => c.name === resolved.name);
  if (!same) {
    out.push({ name: resolved.name, aliases: resolved.aliases });
    return;
  }
  for (const alias of resolved.aliases) {
    if (alias !== same.name && !same.aliases.includes(alias)) {
      same.aliases.push(alias);
    }
  }
}

/**
 * 從「出場人物」小節的文字回退解析，如 `林昭、沈氏、客棧掌櫃`。
 *
 * 用於老工程留下的摘要與作者手寫的細綱——這些檔案沒有 cast 欄位，
 * 但角色頁上不該因此憑空少一批人。允許列表寫法（`- 林昭`）與頓號分隔混用。
 *
 * 難點在於模型有時把這一節寫成句子（「本章沒有新人物出場，只有林昭獨坐」）。
 * 那種東西按標點切開會得到一串假人名，全都會跑到角色頁的「未建卡」組裡。
 * 兩條判據擋住它：**長度**（中文人名/稱呼極少超過 8 字）與**句子特徵詞**
 * （人名裡不會有「的」「了」「沒」這類虛詞）。寧可漏掉一兩個長稱呼，
 * 也不能讓角色頁塞滿句子碎片——漏掉的那個重新定稿就有了（定稿走
 * 結構化 cast，根本不經過這裡）。
 */
export function castFromText(text: string): SummaryCast[] {
  const out: SummaryCast[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const cleaned = line.replace(/^\s*[-*·]\s*/, '').trim();
    if (!cleaned) {
      continue;
    }
    for (const part of cleaned.split(/[、,，;；]/)) {
      const entry = parseCastEntry(part);
      if (!entry?.name || !isPlausibleName(entry.name)) {
        continue;
      }
      if (!seen.has(entry.name)) {
        seen.add(entry.name);
        // 別名同樣要過泛稱關：這條回退路徑產出的 cast 與 JSON 路徑的一樣，
        // 會被 identity.ts 拿去判斷「誰是誰」。
        pushCast(out, { name: entry.name, aliases: sanitizeAliases(entry.aliases, entry.name) });
      }
    }
  }
  return out;
}

/** 人名/稱呼裡不會出現的虛詞。命中即判定為句子碎片。 */
const SENTENCE_MARKERS = /[的了是在不没有和与也都而被把从向对为及则却就还很沒與從對為則卻還]/;

function isPlausibleName(name: string): boolean {
  if (name.length === 0 || name.length > 8) {
    return false;
  }
  // 「無」「暫無」這類佔位不是人名。
  if (/^((?:无|無)|(?:暂|暫)(?:无|無)|(?:没|沒)有|未知|none|n\/a)$/i.test(name)) {
    return false;
  }
  return !SENTENCE_MARKERS.test(name);
}
