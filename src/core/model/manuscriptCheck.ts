/**
 * 寫完一章正文之後的幾項確定性檢查，以及續寫回退到哪裡（五期補遺 §1）。**純函式，零 I/O**。
 *
 * 都是三期真實模型首跑自查出來的：
 *
 * - **比喻詞超標**：規則「『彷彿』『猶如』『宛如』全章合計不超過 3 次」寫在系統提示裡，三章光「彷彿」
 *   就有 9 處。執行卡末尾重列一遍、續寫那一輪告訴它已經用了幾次，寫完再數一遍（{@link countSimiles}）。
 * - **後面幾章的人提前登場**：第 3 章續寫的結尾讓第 4 章才登場的沈秋出現在巷口。執行卡點名
 *   「本章不出場」的人（{@link notYetOnStage}），寫完查一遍（{@link findEarlyEntrances}）。
 * - **年代不符的現代術語**：民國背景的書裡冒出「PTSD」。正文裡的拉丁字母縮寫提示一句
 *   （{@link latinAcronyms}）——只提示：都市、科幻題材裡的 CEO、AI 是正常的。
 * - **續寫越過章末的收尾**：第一次呼叫已經收了尾、只是篇幅不夠時，續寫接在收尾後面必然越過它。
 *   這種情況先回退到結尾那一場之前（{@link rewindPoint}，見 generation/continuation.ts）。
 *
 * 零 import。內建編輯器的「寫作體檢」（`media/src/editor/checkCore.ts`）也打包這一份：編輯器裡標出來的禁用詞、
 * 比喻詞、拉丁縮寫與寫完一章之後數的是**同一個函式**——計數（{@link countBanned} / {@link countSimiles} /
 * {@link latinAcronyms}）都建在找位置的那兩個函式上（{@link locateTerms} / {@link latinAcronymRanges}），
 * 編輯器拿位置畫高亮，生成鏈拿個數寫說明，兩邊不會一個說三次、一個畫出四處。
 */

// ---------------------------------------------------------------- 找位置

/** 一個詞在一段文字裡出現在哪幾處（起點，按 `text` 的下標，升序）。 */
export interface TermHits {
  term: string;
  offsets: number[];
}

/**
 * 拉丁字母不分大小寫時的折法：半形大寫、全形大小寫一律折成半形小寫。**一個字換一個字**（長度不變），
 * 折過之後的下標與原文一一對應。只折拉丁字母——中文沒有大小寫，別的文字（希臘、西里爾……）不在這裡管。
 */
export function foldLatin(text: string): string {
  return (text ?? '').replace(/[A-ZＡ-Ｚａ-ｚ]/g, (ch) => {
    const code = ch.charCodeAt(0);
    if (code <= 0x5a) {
      return String.fromCharCode(code + 0x20);
    }
    // 全形 Ａ-Ｚ（FF21–FF3A）、ａ-ｚ（FF41–FF5A）→ 半形 a-z。
    return String.fromCharCode((code >= 0xff41 ? code - 0xff41 : code - 0xff21) + 0x61);
  });
}

/**
 * 這幾個詞各自出現在哪幾處。每個詞**各找各的**、從左往右、不重疊——與 `text.split(term).length - 1`
 * 數出來的是同一批（{@link countBanned} 就是這麼數的）；兩個詞疊在同一段字上（「資料」與「資料庫」）各算各的。
 *
 * 一趟掃完：按詞的第一個字建一張表，逐字只試以這個字開頭的那幾個詞——幾萬字的正文、上千個詞也只是一趟迴圈，
 * 不是「詞數 × 全文」。返回與 `terms` 一一對應（重複的詞各給一份同樣的結果，空串沒有命中）。
 *
 * `foldCase`：拉丁字母不分大小寫（{@link foldLatin}，全形當半形）。生成鏈的禁用詞不折（與從前的 `split` 一樣），
 * 內建編輯器的敏感詞表折。
 */
export function locateTerms(text: string, terms: readonly string[], opts: { foldCase?: boolean } = {}): TermHits[] {
  const fold = opts.foldCase ? foldLatin : (s: string) => s ?? '';
  const hay = fold(text ?? '');
  const found = new Map<string, number[]>();
  const byFirst = new Map<string, string[]>();
  for (const raw of terms) {
    const t = fold(raw ?? '');
    if (!t || found.has(t)) {
      continue;
    }
    found.set(t, []);
    const list = byFirst.get(t[0]);
    if (list) {
      list.push(t);
    } else {
      byFirst.set(t[0], [t]);
    }
  }
  if (found.size > 0) {
    /** 每個詞下一處最早能從哪裡起（上一處的末尾）：同一個詞不重疊。 */
    const next = new Map<string, number>();
    for (let i = 0; i < hay.length; i++) {
      const candidates = byFirst.get(hay[i]);
      if (!candidates) {
        continue;
      }
      for (const t of candidates) {
        if ((next.get(t) ?? 0) <= i && hay.startsWith(t, i)) {
          found.get(t)!.push(i);
          next.set(t, i + t.length);
        }
      }
    }
  }
  return terms.map((raw) => ({ term: raw, offsets: found.get(fold(raw ?? '')) ?? [] }));
}

// ---------------------------------------------------------------- 比喻詞

/**
 * 去 AI 味禁令裡點名的比喻詞（context/prompts.ts 的 `ANTI_AI_RULES`）。百章實驗只數前三個，模型就改用
 * 「如同」——全書 287 次，比「彷彿」還多。
 */
export const SIMILE_WORDS = ['彷彿', '猶如', '宛如', '如同', '好似', '恍如', '宛若'] as const;
/** 全章合計上限。 */
export const SIMILE_LIMIT = 3;

/** 這幾個比喻詞各自出現在哪幾處（{@link locateTerms}）。內建編輯器的體檢拿它畫高亮。 */
export function locateSimiles(text: string): TermHits[] {
  return locateTerms(text, SIMILE_WORDS);
}

/** 這幾個比喻詞在這段文字裡一共出現幾次。 */
export function countSimiles(text: string): number {
  return locateSimiles(text).reduce((n, h) => n + h.offsets.length, 0);
}

/** 「彷彿 2 次、猶如 1 次」——說明裡用，0 次的不列。 */
export function describeSimiles(text: string): string {
  return locateSimiles(text)
    .filter((h) => h.offsets.length > 0)
    .map((h) => `「${h.term}」${h.offsets.length} 次`)
    .join('、');
}

/**
 * 對白段佔比低於這個數時，續寫那一輪提醒多讓人物開口，寫完記一條說明。人類網文三部 29–36%；
 * novel-test 百章修仙只有 10–14%，整章像旁白。
 */
export const DIALOGUE_FLOOR = 0.25;

/** 帶引號（“”或「」）的段佔全部段的比例。沒有段時為 1（不提醒）。 */
export function dialogueShare(text: string): number {
  const paragraphs = (text ?? '').split(/\n\s*\n/).filter((p) => p.trim());
  if (paragraphs.length === 0) {
    return 1;
  }
  return paragraphs.filter((p) => /[“「]/.test(p)).length / paragraphs.length;
}

// ---------------------------------------------------------------- 停在半句

/** 一句話能停在這些字上：句末標點、收引號與括號、省略號、破折號。 */
const SENTENCE_END = /[。！？!?…”’」』）)\]】—~～.]$/;

/**
 * 這段正文是不是停在半句上。閘道器不報收尾原因、或者報了「正常收尾」卻其實斷在半句（百章實驗
 * 第 3 章停在「他已經到了極限，全身」）時，只能看結尾的那個字。空文字不算。
 */
export function endsMidSentence(text: string): boolean {
  const t = (text ?? '').replace(/\s+$/u, '');
  return t.length > 0 && !SENTENCE_END.test(t);
}

// ---------------------------------------------------------------- 禁用詞

/**
 * 古代、修真一類題材裡不該出現的現代說法。百章實驗的全域要求寫著「嚴禁使用現代科學或心理學詞彙」，
 * 正文照樣寫了「能量」33 次、「神經」17 次、「頻率」16 次、「座標」10 次——規矩只靠模型自覺，沒人數。
 */
export const MODERN_TERMS = ['能量', '神經', '頻率', '座標', '邏輯', '資料', '分鐘', '秒鐘', '物理', '化學', '細胞', '程式', '效率', '訊號'] as const;

/** 認作古代、修真一類題材的說法（`config.md` 的 genre / subGenre）。 */
const ANCIENT_GENRE = /仙(?:侠|俠)|玄幻|修真|修仙|武(?:侠|俠)|奇幻|(?:历|歷)史|古言|古代|(?:宫|宮)(?:斗|鬥)|宅(?:斗|鬥)|洪荒|神(?:话|話)/;

/** 一個禁用詞最長几個字：再長就是一句話，不是一個詞。 */
const BANNED_MAX_CHARS = 8;
/** 「這一句是在禁止什麼」的說法。 */
const BANNING = /禁|不得|不(?:许|許)|不(?:准|準)|不要|不用|不使用|避免|杜(?:绝|絕)|(?:别|別)用/;
/** 括起來的詞：「」、『』、“”、""。 */
const QUOTED = /[「『“"]([^」』”"\n]{1,16})[」』”"]/g;

/**
 * 這一本書寫正文時不該用的詞，三個來源，去重、按出現順序：
 *
 * - `style.md` 的「禁用詞表」一節裡括起來的詞（那一節整節都是禁令）；
 * - 小說配置「全域要求」裡**表禁止的那一個分句**裡括起來的詞——同一句後半句往往是「須用『驚悸』『心病』」，
 *   那是要用的詞，不能連著收進來；
 * - 題材是古代、修真一類時，內建的現代說法 {@link MODERN_TERMS}。
 */
export function bannedTerms(input: { styleBanList?: string; guidance?: string; genre?: string }): string[] {
  const out: string[] = [];
  const add = (term: string) => {
    const t = term.trim();
    if (t.length >= 2 && t.length <= BANNED_MAX_CHARS && !out.includes(t)) {
      out.push(t);
    }
  };
  for (const m of (input.styleBanList ?? '').matchAll(QUOTED)) {
    add(m[1]);
  }
  for (const clause of (input.guidance ?? '').split(/[，,。；;！!？?\n]/u)) {
    if (BANNING.test(clause)) {
      for (const m of clause.matchAll(QUOTED)) {
        add(m[1]);
      }
    }
  }
  if (ANCIENT_GENRE.test(input.genre ?? '')) {
    MODERN_TERMS.forEach(add);
  }
  return out;
}

/** 這段文字裡用到了哪幾個禁用詞、各幾次（0 次的不列），按出現次數從多到少。 */
export function countBanned(text: string, terms: readonly string[]): { term: string; count: number }[] {
  return locateTerms(text, terms)
    .map((h) => ({ term: h.term, count: h.offsets.length }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count);
}

/** 「『能量』3 次、『神經』1 次」。 */
export function describeBanned(list: readonly { term: string; count: number }[]): string {
  return list.map((x) => `「${x.term}」${x.count} 次`).join('、');
}

// ---------------------------------------------------------------- 拉丁字母縮寫

/**
 * 正文裡每一處連續兩個以上大寫拉丁字母組成的縮寫（PTSD、CPU、DNA……），按出現順序、不去重。
 * 全形字母先折成半形再找（一個字換一個字，`start` / `end` 仍是原文的下標）；`term` 是折過的寫法。
 */
export function latinAcronymRanges(text: string): { term: string; start: number; end: number }[] {
  const half = (text ?? '').replace(/[Ａ-Ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  const out: { term: string; start: number; end: number }[] = [];
  for (const m of half.matchAll(/(?<![A-Za-z])[A-Z]{2,}(?![A-Za-z])/g)) {
    out.push({ term: m[0], start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

/** 正文裡的拉丁字母縮寫（{@link latinAcronymRanges}），去重、按出現順序。 */
export function latinAcronyms(text: string): string[] {
  const seen: string[] = [];
  for (const r of latinAcronymRanges(text)) {
    if (!seen.includes(r.term)) {
      seen.push(r.term);
    }
  }
  return seen;
}

// ---------------------------------------------------------------- 提前登場

/** 一章細綱裡計劃出場的人。 */
export interface PlannedCast {
  no: number;
  characters: readonly string[];
}

/** 後面幾章才登場的一個人：名字與他第一次排進細綱的那一章。 */
export interface NotYet {
  name: string;
  no: number;
}

/**
 * 「本章不出場」的名單：後面幾章細綱裡排了、而本章與前面各章的細綱都沒排過的人，按第一次
 * 排進細綱的章號升序。前面排過的不算——他已經登場過了，本章提一句是正常的回顧。
 */
export function notYetOnStage(input: {
  self: readonly string[];
  previous: readonly PlannedCast[];
  ahead: readonly PlannedCast[];
}): NotYet[] {
  const known = new Set<string>();
  for (const name of input.self) {
    known.add(name.trim());
  }
  for (const p of input.previous) {
    for (const name of p.characters) {
      known.add(name.trim());
    }
  }
  const out: NotYet[] = [];
  for (const p of [...input.ahead].sort((a, b) => a.no - b.no)) {
    for (const raw of p.characters) {
      const name = raw.trim();
      if (name && !known.has(name) && !out.some((x) => x.name === name)) {
        out.push({ name, no: p.no });
      }
    }
  }
  return out;
}

/** 提前寫進本章的一個人：名字、按細綱第幾章才登場、第一次出現的那一句。 */
export interface EarlyEntrance extends NotYet {
  quote: string;
}

/**
 * 一個人在正文裡可能的幾種寫法：全名、括號裡外各一截（「鎮守人（陳道源）」→ 鎮守人、陳道源）、
 * 角色卡上的專屬稱呼。兩個字以上才算（單字到處都是）。
 */
export function namesOf(name: string, aliases: readonly string[] = []): string[] {
  const parts = name.split(/[（()）]/u).map((s) => s.trim());
  return [...new Set([name.trim(), ...parts, ...aliases.map((a) => a.trim())])].filter((n) => n.length >= 2);
}

/**
 * 本章細綱自己提到了的人不算「不出場」：細綱要他在本章被提起（鉤子裡一句警告、一段回憶），這時候
 * 再點名「本章不出場」只會和細綱打架，寫完查到他也不是越界。真實模型試跑裡第 3 章的鉤子就是
 * 「老客提醒他祠堂裡的陳老爺正在搜尋」，陳老爺是第 4 章才登場的鎮守人的別名。
 */
export function dropMentioned<T extends NotYet & { aliases?: readonly string[] }>(list: readonly T[], selfText: string): T[] {
  return list.filter((who) => !namesOf(who.name, who.aliases).some((n) => selfText.includes(n)));
}

/**
 * 名單裡的人（名字、括號裡外各一截或角色卡上的專屬稱呼）在這段正文裡出現了。`quote` 是第一次出現的
 * 那一句，長了截到 60 字。
 */
export function findEarlyEntrances(
  text: string,
  notYet: readonly (NotYet & { aliases?: readonly string[] })[]
): EarlyEntrance[] {
  const out: EarlyEntrance[] = [];
  for (const who of notYet) {
    const names = namesOf(who.name, who.aliases);
    let at = -1;
    for (const n of names) {
      const i = text.indexOf(n);
      if (i >= 0 && (at < 0 || i < at)) {
        at = i;
      }
    }
    if (at >= 0) {
      out.push({ name: who.name, no: who.no, quote: sentenceAround(text, at) });
    }
  }
  return out;
}

function sentenceAround(text: string, at: number): string {
  const stops = /[。！？!?\n]/u;
  let from = at;
  while (from > 0 && !stops.test(text[from - 1])) {
    from--;
  }
  let to = at;
  while (to < text.length && !stops.test(text[to])) {
    to++;
  }
  const s = text.slice(from, Math.min(text.length, to + 1)).trim();
  const chars = Array.from(s);
  return chars.length > 60 ? `${chars.slice(0, 60).join('')}…` : s;
}

// ---------------------------------------------------------------- 續寫回退

/** 切掉最後多少比例（按字數）…… */
const FALLBACK_CUT = 0.25;
/** ……最多切這麼多字：認不出收尾從哪起，切多了是白扔。 */
const FALLBACK_MAX_CHARS = 600;
/** 至少留下這麼多比例（按字數）：切多了等於重寫一章。 */
const MIN_KEEP = 0.5;

export interface Rewind {
  /** 留下的那一段（續寫從它的末尾接下去）。 */
  keep: string;
  /** 切掉的那一截（丟棄，不進正文）。 */
  cut: string;
  /** 切掉了幾段。 */
  paragraphs: number;
}

function paragraphsOf(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * 一章寫到收尾了、篇幅卻不夠時，回退到哪裡：從結尾那一場之前切開，後面的丟掉重寫。
 *
 * - 從末尾往前切，切到約 25%、最多 600 字為止；
 * - 至少切一段、至少留一半。只有一段時沒法切，返回 undefined——呼叫方自己決定怎麼辦。
 *
 * 從前細綱單列一節「章末鉤子」，這裡按它找與之最像的那幾段起切。鉤子並進「看點」之後（看點裡還有
 * 爽點，拿來找收尾那一場會切錯地方），只按比例切。
 */
export function rewindPoint(text: string): Rewind | undefined {
  const paras = paragraphsOf(text ?? '');
  if (paras.length < 2) {
    return undefined;
  }
  const total = paras.reduce((s, p) => s + p.length, 0);
  // 第 i 段之前一共多少字：切點在 i 時留下的就是它。
  const before = (i: number) => paras.slice(0, i).reduce((s, p) => s + p.length, 0);
  const allowed = (i: number) => i >= 1 && i < paras.length && before(i) >= total * MIN_KEEP;

  // 從末尾往前數，切夠四分之一（最多 600 字）為止。
  const want = Math.min(total * FALLBACK_CUT, FALLBACK_MAX_CHARS);
  let at = paras.length - 1;
  while (at > 1 && total - before(at) < want && allowed(at - 1)) {
    at--;
  }
  if (!allowed(at)) {
    return undefined;
  }
  return {
    keep: paras.slice(0, at).join('\n\n'),
    cut: paras.slice(at).join('\n\n'),
    paragraphs: paras.length - at,
  };
}
