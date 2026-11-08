import { traditionalLabel } from '../../model/labels';
import { loreOfTarget, plotLabel } from '../../model/pipeline';
import { LoreThinKind, loreThin } from '../../model/loreFile';
import { LoreEntry } from '../../model/types';
import { MATERIAL_TOKENS, expansionMaterial, loreEntryAt } from '../../views/loreMaterial';
import { estimateTokens } from '../tokenizer';
import { ItemKind } from '../types';
import type { Assembly, LayerFn } from './assembly';
import { loreBodyFor } from './render';

/*
 * 單條設定（展開，完善設定 2026-10-19）的兩層。目標不是單條設定時什麼都不帶——設定階段那張配方照掛它們，
 * 由層自己判（同 `written`）。
 *
 * - `loreSelf`（P0 force）：焦點，這一條現有的全部內容。**含暗設**：展開要改的就是它，標明讀者還不知道。
 * - `loreMaterial`（P1）：兩樣原料（views/loreMaterial.ts 的 `expansionMaterial`）——已排（沒定稿）的細綱裡用到它
 *   的地方（展開是為這些情節服務的），與定稿過的記錄（同建條目、整合那一份，已經寫進正文的不能推翻）。兩樣合計
 *   照整合的 `MATERIAL_TOKENS` 封頂：兩邊都放不下時各佔一半，一邊用不完讓給另一邊；沒帶上的在明細裡說出來（第 2 條）。
 *
 * 相關條目、角色、配置 / 前提 / 世界觀照設定階段現有的層（`lore` 層在單條設定上挑相關的，見 background.ts）。
 */

const THIN_NOTE: Record<LoreThinKind, string> = {
  empty: '這一條還只有一句話：正文是空的',
  placeholder: '這一條還只有一句話：正文還是「新建設定」留下的佔位',
  untold: '這一條還只有一句話：三節都寫著「（未交代）」',
};

export const loreSelf: LayerFn = async (a, spec) => {
  const relPath = loreOfTarget(a.request.target);
  if (!relPath) {
    return;
  }
  const { entry, exists } = await loreEntryAt(a.project, relPath);
  const thin = exists ? loreThin(entry) : undefined;
  a.admit(
    {
      id: 'loreSelf',
      kind: 'loreSelf',
      priority: spec.priority,
      label: `設定 · ${entry.title}（這一條）`,
      source: relPath,
      text: renderSelf(entry, exists),
      note: !exists ? '還沒有這個檔案：寫入時按這個路徑新建' : thin ? THIN_NOTE[thin] : undefined,
    },
    { force: spec.force }
  );
};

/**
 * 這一條的全部內容：`【名〔分類〕】`、一句話、關鍵詞、正文。正文規劃時的樣子（`loreBodyFor`）：暗設挪到最後，
 * 標題換成「暗設（讀者還不知道）」。
 */
function renderSelf(entry: LoreEntry, exists: boolean): string {
  const head = `【${entry.title}${entry.category ? `〔${entry.category}〕` : ''}】`;
  const body = loreBodyFor(entry.body, true).text;
  return [
    head,
    `一句話：${entry.brief.trim() || '（還沒寫）'}`,
    `關鍵詞：${entry.keywords.length > 0 ? entry.keywords.join('、') : '（還沒有）'}`,
    body || (exists ? '（正文還是空的）' : '（還沒有這一條，這一次寫下的就是它的第一版）'),
  ].join('\n');
}

export const loreMaterial: LayerFn = async (a, spec) => {
  const relPath = loreOfTarget(a.request.target);
  if (!relPath) {
    return;
  }
  const entries = await a.project.listLore();
  const { entry } = await loreEntryAt(a.project, relPath, entries);
  const { uses, records } = await expansionMaterial(a.project, entry, { entries });
  const planLines = uses.map((u) => `- ${plotLabel(u.no, u.title)}（${traditionalLabel(u.where)}）：${u.text}`);
  const recordLines = records.map((f) => `- 第 ${f.no} 章：${f.text}`);

  // 兩邊合計封頂：都放不下時各佔一半，一邊用不完的讓給另一邊。
  const planNeed = tokensOf(planLines);
  const recordNeed = tokensOf(recordLines);
  const planBudget = Math.min(planNeed, Math.max(MATERIAL_TOKENS / 2, MATERIAL_TOKENS - recordNeed));
  const recordBudget = MATERIAL_TOKENS - planBudget;

  admitLines(a, spec.priority, {
    id: 'lorePlan',
    kind: 'lorePlan',
    label: `設定 · ${entry.title} · 已排細綱裡用到它（${uses.length} 處）`,
    lines: planLines,
    budget: planBudget,
    empty: '（已排的細綱裡還沒有點到它的地方。）',
    what: '已排細綱裡用到它的地方',
    nos: uses.map((u) => u.no),
  });
  admitLines(a, spec.priority, {
    id: 'loreRecord',
    kind: 'loreRecord',
    label: `設定 · ${entry.title} · 同步過的記錄（${records.length} 條）`,
    lines: recordLines,
    budget: recordBudget,
    empty: '（定稿過的章裡還沒有關於它的記錄。）',
    what: '同步過的記錄',
    nos: records.map((f) => f.no),
  });
};

/** 一行一 token 的換行也算上，與 `takeHead` 按整段估差不了幾個。 */
function tokensOf(lines: readonly string[]): number {
  return lines.reduce((sum, line) => sum + estimateTokens(line) + 1, 0);
}

/** 能放下前幾行（按章號升序，越早越先放）。 */
function fit(lines: readonly string[], budget: number): number {
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    used += estimateTokens(lines[i]) + 1;
    if (used > budget) {
      return i;
    }
  }
  return lines.length;
}

/**
 * 裝一樣原料：封頂之內整份帶；超了只帶前幾行、標降級並寫明帶到第幾章（第 2 條）；一行都沒有就帶一句「沒有」，
 * 讓模型知道是空的、不是忘了給。總預算放不下就丟、說出來。
 */
function admitLines(
  a: Assembly,
  priority: Parameters<Assembly['admit']>[0]['priority'],
  o: { id: string; kind: ItemKind; label: string; lines: string[]; budget: number; empty: string; what: string; nos: number[] }
): void {
  const base = { id: o.id, kind: o.kind, priority, label: o.label };
  if (a.excluded.has(o.id)) {
    a.admit({ ...base, text: '' });
    return;
  }
  if (o.lines.length === 0) {
    a.admit({ ...base, text: o.empty });
    return;
  }
  const kept = fit(o.lines, o.budget);
  if (kept === o.lines.length) {
    a.admit({ ...base, text: o.lines.join('\n') });
    return;
  }
  const why =
    `${o.what}共 ${o.lines.length} 行，計劃與同步記錄合計封頂 ${MATERIAL_TOKENS} token，` +
    (kept > 0 ? `只帶了前 ${kept} 行（到第 ${o.nos[kept - 1]} 章），第 ${o.nos[kept]} 章起的沒帶` : '一行都沒放下');
  if (kept === 0) {
    a.reject({ ...base, text: '' }, 'dropped', why);
    return;
  }
  const text = o.lines.slice(0, kept).join('\n');
  const tokens = estimateTokens(text);
  if (tokens > a.remaining) {
    a.reject({ ...base, text: '' }, 'dropped', `預算不足（需 ${tokens} token，剩 ${Math.max(0, a.remaining)}）`);
    return;
  }
  a.accept({ ...base, text, status: 'degraded', note: why }, tokens);
}
