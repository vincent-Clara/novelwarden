/**
 * 寫前衝突檢查（百章實驗覆盤）：寫第 N 章之前，比對本章細綱與前面定稿留下的連續性事實，找**硬矛盾**。
 *
 * **純函式**：提示詞、選哪些事實、校驗模型交回來的衝突。取數與調模型在 features/plotCheck.ts。
 *
 * ## 為什麼要有它
 *
 * 一致性預檢（preflight.ts）零呼叫，只認一種矛盾：細綱排了已經死了的人。百章實驗裡更多的是別的：
 * 第 50、60、70 章各「徹底摧毀」一次同一座大陣，已經交出去的玉簡在下一章又從懷裡掏出來，境界寫了
 * 突破又退回去。這些只有讀得懂兩邊的模型才認得出，所以花一次呼叫。
 *
 * ## 只認能逐字對上的
 *
 * 模型說的每一處衝突都要帶兩句原文：細綱裡的那一句、事實裡的那一條。兩句都要在原文裡找得到
 * （審稿引文那一套歸一化：NFKC、去空白與標點），找不到的丟掉——這一步會讓批次寫章停下來，
 * 拿一條模型編出來的矛盾去攔作者，比漏掉一條更糟。
 *
 * 2026-10-25 起改成轉寫：比對的模型按格式寫（兩句原句用「」括出來），轉寫模型照抄成 JSON（{@link PLOT_CHECK_JSON_CONTRACT}）。
 */
import { normalizeQuote } from './review';
import { CONTEXT_DETAIL_LIMITS, DEFAULT_CONTEXT_DETAIL } from './contextDetail';

/*
 * 下面兩個與審稿的近章事實是同一組數，隨上下文詳細度變（`factsChapters` / `factsChars`）。
 * 這裡是預設那一級的值，給 {@link selectCheckFacts} 當預設引數。
 */
/** 衝突檢查最多帶幾章的近章事實。 */
export const PLOT_CHECK_RECENT = CONTEXT_DETAIL_LIMITS[DEFAULT_CONTEXT_DETAIL].factsChapters;
/** 事實一共帶多少字。 */
export const PLOT_CHECK_BUDGET_CHARS = CONTEXT_DETAIL_LIMITS[DEFAULT_CONTEXT_DETAIL].factsChars;
/** 引文歸一之後至少幾個字才算數：太短的「他」「玉簡」到處都對得上。 */
const MIN_QUOTE = 4;
/** 一次最多報幾處。 */
export const PLOT_CHECK_MAX = 5;

/** 交給檢查的一章定稿事實。 */
export interface CheckFacts {
  no: number;
  title?: string;
  statements: readonly string[];
}

/** 一處衝突：細綱裡哪一句、與第幾章的哪一條事實、為什麼矛盾。 */
export interface PlotConflict {
  plot: string;
  fact: string;
  chapter: number;
  why: string;
}

export const PLOT_CHECK_SYSTEM = [
  '你是長篇小說的連續性編輯。下面給你本章的細綱（計劃），和前面各章定稿之後留下的連續性事實（已經發生、不可更改的歷史）。',
  '找出細綱與事實之間的**硬矛盾**，只認這幾種：',
  '1. 事實裡已經死了、離場了的人，細綱又安排他出場行動（明說是回憶、幻象、託夢、屍體的不算）；',
  '2. 事實裡已經毀掉、用掉、交出去、丟了的東西，細綱又讓人拿著、用著；',
  '3. 事實裡已經發生過的終局級事件（大陣被毀、反派身死、秘境崩塌、某人突破到某一境界），細綱又讓它從頭再發生一次；',
  '4. 境界、身份、地點與事實相反且細綱沒有交代變化（事實說已經突破到三層，細綱說還在二層；事實說已經離開宗門，細綱說他一直在宗門裡）。',
  '風格、節奏、合不合理不歸你管；細綱比事實多出來的新東西不算矛盾；拿不準的不報。',
  '',
  '按下面的格式寫，不寫 JSON：',
  '- 沒有矛盾就只寫「無矛盾」三個字。',
  `- 有矛盾的，一處一段，最多 ${PLOT_CHECK_MAX} 處；每段以「### 矛盾 N」開頭，下面三行：「細綱：」後面是細綱裡的原句，「事實：」後面是事實裡的原句、括號裡寫它在第幾章，「為什麼：」後面一句話說清哪裡矛盾。`,
  '- 兩句原句都用「」括起來，必須逐字摘自下面給的原文，不拼接、不改寫。',
  '【格式示例】',
  '### 矛盾 1',
  '細綱：「細綱裡的原句」',
  '事實：「事實裡的原句」（第 N 章）',
  '為什麼：一句話說清哪裡矛盾',
].join('\n');

/**
 * 轉寫那一步的 JSON 合同（2026-10-25 起）：把上面那份按格式寫的結果搬成 `{"conflicts":[…]}`，形狀與 features/plotCheck.ts
 * 原來認的一致（`jsonList(raw, 'conflicts')` + {@link verifyConflicts}）。兩句原句照抄，之後照舊拿細綱與事實逐字核對。
 */
export const PLOT_CHECK_JSON_CONTRACT = [
  '【寫前衝突檢查 JSON 合同】',
  '只輸出 {"conflicts":[...]}，原文裡的一段「矛盾」是一項 {"plot":"…","fact":"…","chapter":N,"why":"…"}：',
  '- plot：「細綱：」後面「」裡的那一句，不帶「」；fact：「事實：」後面「」裡的那一句，不帶「」。',
  '- chapter：事實那一句後面括號裡的第幾章（數字），沒寫給 0；why：「為什麼：」後面那一句。',
  '- 原文寫「無矛盾」或一處都沒寫的：{"conflicts":[]}。',
  '- 文字一律從原文照抄：不改寫、不總結、不潤色，不補原文沒有的，也不刪原文寫了的；兩句原句一個字都不能改。chapter 按上面的對應關係填。',
  '只輸出一個可由 JSON.parse 讀取的 JSON 物件，不要解釋、Markdown 或程式碼圍欄。',
  '【JSON 形狀】{"conflicts":[{"plot":"…","fact":"…","chapter":10,"why":"…"}]}',
].join('\n');

/** 只寫了「無矛盾」（或「無」「沒有矛盾」）：一處都沒有，不必轉寫。 */
export function saysNoConflict(source: string): boolean {
  return /^[#*\s]*(?:(?:无|無)|(?:没|沒)有)(?:硬)?(?:矛盾)?[。.！!]?[*\s]*$/u.test(source.trim());
}

/** 有沒有衝突檢查的樣子：提到矛盾、細綱、事實，或括了原句。連這都沒有的（「我不太確定」）不花轉寫那一次。 */
export function looksLikePlotCheck(source: string): boolean {
  return /矛盾|(?:细|細)(?:纲|綱)|事(?:实|實)|「/u.test(source);
}

/**
 * 選哪些事實：提到本章計劃出場的人的事實（不論多早），加上最近 `limits.recent` 章的全部事實；
 * 由近及遠、一共不超過 `limits.chars` 字（預設 {@link PLOT_CHECK_RECENT} 章、{@link PLOT_CHECK_BUDGET_CHARS} 字）。
 * 返回按章號升序。
 */
export function selectCheckFacts(
  chapters: readonly CheckFacts[],
  names: readonly string[],
  limits: { recent?: number; chars?: number } = {}
): CheckFacts[] {
  const keys = names.map((n) => n.trim()).filter((n) => n.length >= 2);
  const ordered = chapters.slice().sort((a, b) => b.no - a.no);
  const recent = new Set(ordered.slice(0, Math.max(0, limits.recent ?? PLOT_CHECK_RECENT)).map((c) => c.no));
  let budget = limits.chars ?? PLOT_CHECK_BUDGET_CHARS;
  const out: CheckFacts[] = [];
  for (const ch of ordered) {
    const picked: string[] = [];
    for (const s of ch.statements) {
      const text = s.trim();
      if (!text || (!recent.has(ch.no) && !keys.some((k) => text.includes(k)))) {
        continue;
      }
      if (text.length > budget) {
        budget = 0;
        break;
      }
      budget -= text.length;
      picked.push(text);
    }
    if (picked.length > 0) {
      out.push({ ...ch, statements: picked });
    }
    if (budget <= 0) {
      break;
    }
  }
  return out.sort((a, b) => a.no - b.no);
}

/** 交給模型的那一條使用者訊息。 */
export function plotCheckUser(plot: { no: number; title: string; text: string }, facts: readonly CheckFacts[]): string {
  const factBlock = facts
    .map((c) => `【第${c.no}章${c.title ? ` ${c.title}` : ''}】\n${c.statements.map((s) => `- ${s}`).join('\n')}`)
    .join('\n\n');
  return `# 前面各章定稿的連續性事實\n\n${factBlock}\n\n# 本章細綱（第${plot.no}章${plot.title ? ` ${plot.title}` : ''}）\n\n${plot.text}\n\n請按要求的格式寫。`;
}

/**
 * 校驗模型交回來的衝突：細綱那一句要在細綱原文裡找得到，事實那一句要對上某一條事實（包含或被包含，
 * 歸一之後比）。章號以對上的那一條為準（模型寫錯章號的也認）。對不上的計入 `dropped`。
 */
export function verifyConflicts(
  list: readonly unknown[],
  plotText: string,
  facts: readonly CheckFacts[]
): { conflicts: PlotConflict[]; dropped: number } {
  const plotNorm = normalizeQuote(plotText);
  const index = facts.flatMap((c) => c.statements.map((s) => ({ no: c.no, text: s, norm: normalizeQuote(s) })));
  const conflicts: PlotConflict[] = [];
  let dropped = 0;
  for (const item of list) {
    const o = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const plot = typeof o.plot === 'string' ? o.plot.trim() : '';
    const fact = typeof o.fact === 'string' ? o.fact.trim() : '';
    const why = typeof o.why === 'string' ? o.why.trim() : '';
    const p = normalizeQuote(plot);
    const f = normalizeQuote(fact);
    const hit = f.length >= MIN_QUOTE ? index.find((x) => x.norm.includes(f) || (x.norm.length >= MIN_QUOTE && f.includes(x.norm))) : undefined;
    if (p.length < MIN_QUOTE || !plotNorm.includes(p) || !hit || conflicts.length >= PLOT_CHECK_MAX) {
      dropped++;
      continue;
    }
    conflicts.push({ plot, fact: hit.text, chapter: hit.no, why: clip(why, 120) });
  }
  return { conflicts, dropped };
}

/** 「細綱『……』與第 10 章的定稿事實『……』矛盾：……」。日誌、失敗記錄與完成提示共用。 */
export function describeConflict(c: PlotConflict): string {
  return `細綱「${clip(c.plot, 40)}」與第 ${c.chapter} 章同步下來的事實「${clip(c.fact, 40)}」矛盾${c.why ? `：${c.why}` : ''}`;
}

/** 寫在失敗記錄與完成提示裡的那一句建議。 */
export const PLOT_CHECK_SUGGESTION = '改這一章的細綱；如果這本來就是刻意的安排，在這一章細綱的 frontmatter 里加一行 factCheckOk: true 放行。';

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return [...t].length > max ? `${[...t].slice(0, max).join('')}…` : t;
}
