/**
 * 一致性預檢（五期）：寫第 N 章之前，零呼叫地查一遍細綱有沒有把已經死了的人排進本章。
 *
 * **純函式，零 import**。取數（細綱、角色卡）在 features/preflight.ts。
 *
 * 移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）`shared/consistency-preflight.ts` 的
 * `findBlueprintContinuityRisks`（:84-119）那一條規則：終態角色又被排進當前藍圖。上游那句
 * 「Findings are evidence, never a writing prohibition」照用——這裡只亮一張卡，作者可以
 * 「僅本次忽略」照寫（回憶、幻象、託夢都是正當的安排）。
 *
 * ## 與上游不同的地方（五期計劃 §8 ⚑）
 *
 * - **讀角色卡的「當前狀態」**（總計劃 §1 #19），四期起這一節由定稿維護，寫著「截至第 K 章」這個人
 *   在哪、怎麼樣。**卡上判不出來再讀定稿事實**（{@link factTerminal}）：百章實驗裡 13 張卡有 8 張是寫完
 *   才建的，錢執事第 10 章的摘要已記下「屍骨無存」，第 26 章的細綱照樣排他出場，預檢沒攔——他沒有卡。
 * - **只信寫到本章之前的狀態**：`stateThrough ≥ N`（狀態已經更新到本章或更晚，重寫早前的章時
 *   常見）不判——那個「已死亡」說的可能正是本章或之後發生的事。沒記過 `stateThrough` 的手寫卡照判。
 * - **判定按分句、看句首**：上游只認「名字緊挨著死亡 / 身亡 / 犧牲 / 去世」四個詞，可卡上的
 *   狀態寫的是這個人自己，通常不帶名字，照搬一條都認不出。這裡一句以終態說法開頭（可帶主語與
 *   「已 / 已經 / 於第 k 章 / 被……」字首）才算——「險些喪命」「假死脫身」「為已死的師父報仇」
 *   開頭都不是終態，自然不算。寧可誤報一條讓作者點一下「僅本次忽略」，也別漏報。
 */

/** 預檢要知道的一張卡。 */
export interface PreflightCard {
  name: string;
  aliases: readonly string[];
  /** 「當前狀態」一節的原文。 */
  state: string;
  /** 這一節寫到第幾章（0 = 開篇狀態）。手寫的卡沒有。 */
  stateThrough?: number;
  relPath?: string;
}

/** 一處風險：誰、卡上那一節（或哪一章的定稿事實）怎麼寫的、寫到第幾章、是哪一句判出來的。 */
export interface PreflightRisk {
  name: string;
  /** 判出來的那段原文：卡上「當前狀態」一節，或那一條連續性事實。 */
  state: string;
  through?: number;
  clause: string;
  relPath?: string;
  /** 從哪兒判出來的。缺席等於 `card`。 */
  source?: 'card' | 'fact';
  /** `source: 'fact'` 時：那條事實是第幾章定稿留下的。 */
  chapter?: number;
}

/** 預檢要知道的一章定稿事實（只要事實原句）。 */
export interface PreflightFacts {
  no: number;
  relPath?: string;
  statements: readonly string[];
}

const NUM = '[0-9０-９一二三四五六七八九十百千兩]+';
/** 句首可以有的字首：已經、於第 k 章、被確認…… */
const LEAD =
  `(?:早已|已經|已|當場|最終|終於|不幸|被確認(?:為)?|被證實(?:為)?|確認|證實|` +
  `(?:(?:於|在)第?|第)\\s*${NUM}\\s*章(?:中|末|裡|時)?)*`;
/** 終態說法。刻意不收單字「死」：死守、死敵、死心、拼死都不是終態。 */
const TERMINAL =
  '(?:死亡|身亡|犧牲|去世|過世|亡故|病逝|病故|遇害|遇難|罹難|陣亡|戰死|喪生|喪命|殞命|殞身|斃命|氣絕|慘死|' +
  '死了|死去|死於|自盡|自刎|被?處決|被?斬首|被[^，。；,;！!？?]{0,12}?(?:殺|害|刺|毒|打|斬|砍|擊|射|燒|勒|吊|處|咬|砸|溺|捅)死|' +
  // 修真、玄幻的說法（百章實驗：「錢執事已被大陣吞噬，屍骨無存」沒被認出來）。
  '屍骨無存|魂飛魄散|形神俱滅|灰飛煙滅|身死道消|隕落|化作飛灰|化為飛灰|化作枯屍|化為枯屍|' +
  '再無(?:半點|一絲)?生息|沒了氣息|沒有了氣息|徹底沒了氣息)';
/** 「已死」「已經死」：單字「死」只在這兩種字首後面才算。 */
const BARE_DEAD = '(?:早已|已經|已)死(?![守戰敵士心罪期對磕撐扛咬拼])';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 這一節狀態說的是不是「這個人已經死了」。返回判出來的那一句（給作者看）；不是終態時 undefined。
 * `names` 是這個人的名字與別名：狀態裡偶爾會以名字開頭（「沈秋已於第五章身亡」）。
 */
export function terminalClause(state: string, names: readonly string[] = []): string | undefined {
  const subjects = ['他', '她', '其', '此人', '本人', ...names.filter((n) => n.trim().length > 0).map(escapeRe)];
  const subject = `(?:${subjects.join('|')})?`;
  // 終態說法後面跟著「的」是在修飾別的東西（「隕落的宗門」「死亡的陰影」），不是這個人死了。
  const re = new RegExp(`^${subject}\\s*${LEAD}\\s*(?:${TERMINAL}|${BARE_DEAD})(?![的之])`, 'u');
  for (const raw of (state ?? '').split(/[，,。；;！!？?\n（）()【】\[\]]/u)) {
    const clause = raw.replace(/^[\s\-*•·:：]+/u, '').trim();
    if (clause && re.test(clause)) {
      return clause;
    }
  }
  return undefined;
}

/**
 * 本章細綱 `characters[]` 裡的人已經死了 → 一條風險。先看卡上的「當前狀態」（按名字與別名認卡）；
 * 卡上沒判出來、或者這個人根本沒有卡，再看前面各章定稿留下的連續性事實（{@link factTerminal}）。
 * 一個人只報一條。
 */
export function findPreflightRisks(input: {
  no: number;
  planned: readonly string[];
  cards: readonly PreflightCard[];
  /** 本章之前定稿過的各章的連續性事實。沒卡的人、卡上狀態沒跟上的人，靠它認出來。 */
  facts?: readonly PreflightFacts[];
}): PreflightRisk[] {
  const out: PreflightRisk[] = [];
  const seen = new Set<string>();
  for (const raw of input.planned) {
    const name = raw.trim();
    if (!name) {
      continue;
    }
    const card = input.cards.find((c) => c.name === name || c.aliases.includes(name));
    const who = card?.name ?? name;
    if (seen.has(who)) {
      continue;
    }
    seen.add(who);
    const names = card ? [card.name, ...card.aliases] : [name];
    if (card && (card.stateThrough === undefined || card.stateThrough < input.no)) {
      const clause = terminalClause(card.state, names);
      if (clause) {
        out.push({
          name: card.name,
          state: card.state.trim(),
          ...(card.stateThrough !== undefined ? { through: card.stateThrough } : {}),
          clause,
          ...(card.relPath ? { relPath: card.relPath } : {}),
          source: 'card',
        });
        continue;
      }
    }
    const fact = input.facts ? factTerminal(names, input.facts, input.no) : undefined;
    if (fact) {
      out.push({
        name: who,
        state: fact.statement,
        clause: fact.clause,
        ...(fact.relPath ? { relPath: fact.relPath } : {}),
        source: 'fact',
        chapter: fact.chapter,
      });
    }
  }
  return out;
}

/**
 * 定稿事實裡判終態：**這個人做主語的最近一條事實說了算**。由近及遠找以名字開頭（後面不跟「的」）的
 * 那一句，從它起到這條事實結尾判終態——後面的分句沿用同一個主語（「錢執事已被大陣吞噬，屍骨無存」）。
 * 最近那條說他還在活動（假死、復活、託夢裡現身之後又寫了他在做事），就不算。
 */
export function factTerminal(
  names: readonly string[],
  chapters: readonly PreflightFacts[],
  beforeNo: number
): { clause: string; statement: string; chapter: number; relPath?: string } | undefined {
  const keys = names.map((n) => n.trim()).filter((n) => n.length >= 2);
  if (keys.length === 0) {
    return undefined;
  }
  const ordered = chapters.filter((c) => c.no < beforeNo).slice().sort((a, b) => b.no - a.no);
  for (const ch of ordered) {
    for (const statement of [...ch.statements].reverse()) {
      const start = subjectStart(statement, keys);
      if (start === undefined) {
        continue;
      }
      const clause = terminalClause(statement.slice(start), keys);
      return clause ? { clause, statement: statement.trim(), chapter: ch.no, ...(ch.relPath ? { relPath: ch.relPath } : {}) } : undefined;
    }
  }
  return undefined;
}

/** 名字在哪個分句的句首做主語（後面不跟「的」）。沒有就 undefined。 */
function subjectStart(statement: string, names: readonly string[]): number | undefined {
  const re = /[，,。；;！!？?\n（）()【】[\]]/gu;
  const starts = [0];
  for (const m of statement.matchAll(re)) {
    starts.push((m.index ?? 0) + 1);
  }
  for (const at of starts) {
    const rest = statement.slice(at).replace(/^[\s\-*•·:：]+/u, '');
    const offset = statement.length - at - rest.length;
    for (const n of names) {
      if (rest.startsWith(n) && !rest.slice(n.length).startsWith('的')) {
        return at + offset;
      }
    }
  }
  return undefined;
}

/** 「沈秋的當前狀態（截至第 5 章）寫著『已死亡』，本章細綱仍安排他出場。」卡片與日誌共用。 */
export function describeRisk(r: PreflightRisk): string {
  if (r.source === 'fact') {
    return `${r.name}在第 ${r.chapter} 章同步下來的事實裡寫著「${r.clause}」，本章細綱仍安排這個人出場`;
  }
  const when = r.through === undefined ? '' : r.through <= 0 ? '（開篇狀態）' : `（截至第 ${r.through} 章）`;
  return `${r.name}的當前狀態${when}寫著「${r.clause}」，本章細綱仍安排這個人出場`;
}

/**
 * 按細綱裡記下的永久放行（`preflightOk`，五期補遺 §2）分開：作者說過「這一章裡他出場是刻意的」那幾個人
 * 不再算風險，單獨列出來（寫章卡片的說明裡說一句「按你記下的安排放行」）。按卡上的名字認。
 */
export function splitExempt(
  risks: readonly PreflightRisk[],
  exempt: readonly { name: string; reason: string }[]
): { risks: PreflightRisk[]; exempted: { risk: PreflightRisk; reason: string }[] } {
  const out: PreflightRisk[] = [];
  const exempted: { risk: PreflightRisk; reason: string }[] = [];
  for (const risk of risks) {
    const hit = exempt.find((e) => e.name === risk.name);
    if (hit) {
      exempted.push({ risk, reason: hit.reason });
    } else {
      out.push(risk);
    }
  }
  return { risks: out, exempted };
}

/** 「沈秋：按你記下的安排放行（回憶裡的一場）」。 */
export function describeExempted(e: { risk: PreflightRisk; reason: string }): string {
  return `一致性預檢：${e.risk.name}按你記下的安排放行（${e.reason || '沒寫理由'}）。要撤銷，刪掉這一章細綱 preflightOk 裡那一行`;
}

/** 卡片上跟在警告後面的那一句建議（上游 suggestion 的說法）。 */
export const PREFLIGHT_SUGGESTION = '調整細綱的出場角色，或者這本來就是回憶、幻象、託夢一類的刻意安排——那就僅本次忽略，照寫。';
