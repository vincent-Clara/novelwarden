/**
 * 定稿過的細綱裡的「連續性事實」：後面各章必須保持一致的事實，每條掛一句正文裡的證據原文（D18）。
 *
 * ```markdown
 * ## 連續性事實
 * - 林昭左臂被青鱗劃傷，未愈 〔證據：「血順著左臂往下淌，他把袖子紮緊了」〕
 * ```
 *
 * 兩頭都是**確定性**的，不調模型：
 *
 * - 定稿時（{@link attachEvidence}）：模型只給事實陳述，證據句用 bigram 在正文裡找。
 *   移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）`finalize-chapter.command.ts`
 *   的 `textBigrams` / `evidenceExcerpt` / `buildFinalizedContinuityFacts`（FC:161-230）。
 * - 寫正文時（{@link locateEvidence}）：拿證據原句回到那一章的正文裡逐字定位，取所在段落
 *   與前後各一段。移植自 `chapter-materials.ts` 的 `adjacentEvidencePassages`（CM:47-86）。
 *
 * 為什麼繞這一圈而不是直接把事實塞給模型：事實是模型對正文的**轉述**，轉述會走樣；
 * 原文段落才是作者認可過的那一版（上游 CM:225：「索引、摘要和 currentState 都不是作者事實」）。
 */

/** 一條連續性事實。`evidence` 是正文裡的一句原文；手改的細綱裡可能沒有。 */
export interface ContinuityFact {
  statement: string;
  evidence?: string;
}

/** 定稿過的一章留下的連續性事實（`NovelProject.finalizedFacts`）。 */
export interface FinalizedFacts {
  no: number;
  title: string;
  /** 細綱檔案的相對路徑。 */
  relPath: string;
  facts: ContinuityFact[];
}

/** 一章最多留幾條（上游 `CONTINUITY_FACT_LIMIT`）。 */
export const CONTINUITY_FACT_LIMIT = 12;
/** 一條事實最長多少字（上游 `CONTINUITY_STATEMENT_LIMIT`）。 */
const STATEMENT_LIMIT = 280;
/** 證據句最長多少字（上游 `CONTINUITY_EVIDENCE_LIMIT`）。 */
const EVIDENCE_LIMIT = 240;

// ---------------------------------------------------------------- 渲染與解析

/** `- 陳述 〔證據：「原文」〕`，沒有證據就只有陳述。 */
export function renderContinuityFacts(facts: readonly ContinuityFact[]): string {
  return facts
    .map((f) => `- ${f.statement.trim()}${f.evidence?.trim() ? ` 〔證據：「${f.evidence.trim()}」〕` : ''}`)
    .join('\n');
}

const EVIDENCE_TAIL = /\s*[〔\[【(（]\s*(?:证|證)(?:据|據)\s*[:：]\s*(.*?)\s*[〕\]】)）]\s*$/u;
const BULLET = /^\s*(?:[-*•·]|\d+[.)、])\s*/u;

/**
 * 讀回「連續性事實」這一節。作者會手改（第 1 條），這幾種寫法都認：`〔證據：…〕` 用了半形或
 * 別的括號、證據沒帶引號、整行沒寫 `- `。認不出證據的行照樣是一條事實，只是沒有證據——
 * 寫正文時降級成事實原句。空行與佔位文字（`（待補充）`）跳過。
 */
export function parseContinuityFacts(text: string): ContinuityFact[] {
  const out: ContinuityFact[] = [];
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.replace(BULLET, '').trim();
    if (!line || /^[（(]待(?:补|補)充[）)]$/.test(line)) {
      continue;
    }
    const m = EVIDENCE_TAIL.exec(line);
    const statement = (m ? line.slice(0, m.index) : line).trim();
    const evidence = m ? unquote(m[1]) : '';
    if (!statement) {
      continue;
    }
    out.push(evidence ? { statement, evidence } : { statement });
  }
  return out;
}

function unquote(s: string): string {
  const t = s.trim();
  const pairs: [string, string][] = [['「', '」'], ['“', '”'], ['"', '"'], ["'", "'"], ['『', '』']];
  for (const [a, b] of pairs) {
    if (t.length >= 2 && t.startsWith(a) && t.endsWith(b)) {
      return t.slice(a.length, -b.length).trim();
    }
  }
  return t;
}

// ---------------------------------------------------------------- 定稿：掛證據

/** 一段文字的 bigram 集合（只看字母與數字，標點與空白切開）。model/manuscriptCheck.ts 找鉤子落在哪一段也用它。 */
export function textBigrams(value: string): Set<string> {
  const groups = value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(
    groups.flatMap((group) => {
      const chars = [...group];
      return chars.length < 2 ? chars : chars.slice(0, -1).map((c, i) => c + chars[i + 1]);
    })
  );
}

function sentencesOf(content: string): string[] {
  return content
    .split(/(?<=[。！？.!?])|\n+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 給一條事實在正文裡找一句證據。找不到返回空串。
 *
 * 事實裡提到了出場人物時先只在含那個人名的句子裡找，而且算 bigram 之前先把人名去掉——
 * 不然「林昭」兩個字就能讓任何一句提到林昭的話「命中」。命中還要**有獨立支撐**：要麼
 * 事實的 bigram 全中，要麼命中的 bigram 在事實裡不是挨著的（挨著的只是同一個詞）。
 *
 * **比上游多一步**：含人名的句子裡找不到時，再在全部句子裡按「沒有人名」的門檻（至少兩處
 * 命中）找一遍。中文正文裡人名出現一次之後多半就換成「他」「她」了——上游只在含人名的句子
 * 裡找，「血順著左臂往下淌」這種最該當證據的句子反而永遠找不到。
 */
function evidenceExcerpt(content: string, statement: string, entities: readonly string[]): string {
  const sentences = sentencesOf(content);
  const factEntities = entities.filter((e) => statement.includes(e));
  const withoutEntities = [...factEntities]
    .sort((a, b) => b.length - a.length)
    .reduce((text, e) => text.split(e).join(' '), statement);
  const signalList = [...textBigrams(withoutEntities)];
  const best = (candidates: string[], minimum: number): string | undefined =>
    candidates
      .map((sentence) => {
        const own = textBigrams(sentence);
        const matched = signalList.map((sig, i) => (own.has(sig) ? i : -1)).filter((i) => i >= 0);
        const independent = matched.some((index, k) => k > 0 && index - matched[k - 1] > 1);
        return {
          sentence,
          score: matched.length,
          supported: signalList.length > 0 && (matched.length === signalList.length || independent),
        };
      })
      .sort((a, b) => b.score - a.score)
      .find((c) => c.score >= minimum && c.supported)?.sentence;
  const hit =
    factEntities.length > 0
      ? (best(sentences.filter((s) => factEntities.some((e) => s.includes(e))), 1) ?? best(sentences, 2))
      : best(sentences, 2);
  return (hit ?? '').slice(0, EVIDENCE_LIMIT).trim();
}

/**
 * 定稿時給每條事實掛證據。**找不到證據的事實丟掉**（與上游同）：沒有原文撐著的「事實」
 * 多半是模型編的，留在細綱裡會被後面幾章當真。丟了哪幾條交給呼叫方寫進日誌（第 2 條）。
 *
 * `entities` 是本章出場人物的名字與別名（定稿時模型給的「出場人物」）。
 */
export function attachEvidence(
  statements: readonly string[],
  content: string,
  entities: readonly string[] = []
): { facts: ContinuityFact[]; dropped: string[] } {
  const names = [...new Set(entities.map((e) => e.trim()).filter((e) => e.length >= 2))].slice(0, 8);
  const facts: ContinuityFact[] = [];
  const dropped: string[] = [];
  for (const raw of statements) {
    const statement = raw.replace(BULLET, '').trim().slice(0, STATEMENT_LIMIT);
    if (!statement) {
      continue;
    }
    const evidence = evidenceExcerpt(content, statement, names);
    if (!evidence) {
      dropped.push(statement);
      continue;
    }
    if (facts.length < CONTINUITY_FACT_LIMIT) {
      facts.push({ statement, evidence });
    } else {
      dropped.push(statement);
    }
  }
  return { facts, dropped };
}

// ---------------------------------------------------------------- 引文逐字找不到時：找最接近的原句

/**
 * 最接近的原句要多像才收（⚑ 復跑之後，敘事線定稿 a 的證據）：引文與那一句（或連著的兩句）的兩字詞按 Dice 係數算，
 * `2 × 共有 ÷ (兩邊之和)`。復跑裡逐字找不到的 7 條：代詞換人名、刪了幾個字、兩句拼成一句的在 0.71–0.94，意譯、編的在 0.4
 * 以下，取 0.6。
 */
export const NEAR_QUOTE_MIN = 0.6;
/** 太短的引文不找近似的（歸一之後不到這麼多字）：幾個字的近似句到處都有。 */
export const NEAR_QUOTE_MIN_CHARS = 10;

/** 兩字詞，按出現次數（同 {@link textBigrams} 的切法，但不去重：Dice 要數次數）。 */
function bigramCounts(value: string): { counts: Map<string, number>; total: number } {
  const counts = new Map<string, number>();
  let total = 0;
  for (const group of value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const chars = [...group];
    const grams = chars.length < 2 ? chars : chars.slice(0, -1).map((c, i) => c + chars[i + 1]);
    for (const g of grams) {
      counts.set(g, (counts.get(g) ?? 0) + 1);
      total++;
    }
  }
  return { counts, total };
}

/** 句子：句末標點（連同緊跟著的右引號）與換行處切開。比 {@link sentencesOf} 多認一層引號：「“你怕火。”沈默說」切在引號後面。 */
function quoteSentences(content: string): string[] {
  return content
    .split(/(?<=[。！？!?])(?![”」』"'’])|(?<=[。！？!?][”」』"'’])|\n+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 引文逐字找不到時，正文裡最接近的一句（或連著的兩句，模型常把兩句拼成一句）：兩字詞的 Dice 係數最高、而且到了
 * {@link NEAR_QUOTE_MIN} 的那一段原文；引文太短（{@link NEAR_QUOTE_MIN_CHARS}）、或者都不夠像時 undefined。超過 `maxChars`
 * 的那一段不要（證據有長度上限，截了就不是一句完整的話）。
 *
 * 照定稿掛連續性事實證據那一套（{@link attachEvidence}：模型的話 → 用 bigram 在正文裡找原句）。敘事線定稿 a 的證據是模型
 * 「照抄」的原文，復跑裡逐字找不到的 7 條多半隻是把「他」換成了人名、刪了幾個字、兩句拼成一句（model/threadFile.ts 的
 * `verifyFinds`）：找得到夠像的原句就換成原句收下，不夠像照舊丟。
 */
export function nearestSentence(content: string, quote: string, maxChars = EVIDENCE_LIMIT): { sentence: string; score: number } | undefined {
  const q = bigramCounts(quote);
  const plain = (quote.match(/[\p{L}\p{N}]/gu) ?? []).length;
  if (plain < NEAR_QUOTE_MIN_CHARS || q.total === 0) {
    return undefined;
  }
  const sentences = quoteSentences(content);
  let best: { sentence: string; score: number } | undefined;
  for (let i = 0; i < sentences.length; i++) {
    for (const span of [1, 2]) {
      if (i + span > sentences.length) {
        continue;
      }
      const sentence = sentences.slice(i, i + span).join('');
      if ([...sentence].length > maxChars) {
        continue;
      }
      const s = bigramCounts(sentence);
      let shared = 0;
      for (const [g, n] of q.counts) {
        shared += Math.min(n, s.counts.get(g) ?? 0);
      }
      const score = (2 * shared) / (q.total + s.total);
      if (!best || score > best.score) {
        best = { sentence, score };
      }
    }
  }
  return best && best.score >= NEAR_QUOTE_MIN ? best : undefined;
}

// ---------------------------------------------------------------- 寫正文：定位原文

function paragraphsOf(content: string): string[] {
  return content
    .split(/\r?\n\s*\r?\n/u)
    .map((p) => p.trim())
    .filter(Boolean);
}

const squash = (s: string): string => s.replace(/\s+/g, '');

/**
 * 拿證據原句回到正文裡逐字定位（空白不計），取命中那一段與前後各一段，相鄰的視窗合併。
 *
 * `hits[i]` 說第 i 句找沒找到——找不到多半是作者改過正文，呼叫方把那一條降級成事實原句
 * 並寫進明細（D18、第 2 條）。
 */
export function locateEvidence(
  content: string,
  quotes: readonly string[]
): { passages: string[]; hits: boolean[] } {
  const paragraphs = paragraphsOf(content);
  const squashed = paragraphs.map(squash);
  const windows: [number, number][] = [];
  const hits = quotes.map((quote) => {
    const q = squash(quote);
    if (!q) {
      return false;
    }
    const index = squashed.findIndex((p) => p.includes(q));
    if (index < 0) {
      return false;
    }
    windows.push([Math.max(0, index - 1), Math.min(paragraphs.length - 1, index + 1)]);
    return true;
  });
  const merged: [number, number][] = [];
  for (const w of windows.sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (!last || w[0] > last[1] + 1) {
      merged.push([w[0], w[1]]);
    } else {
      last[1] = Math.max(last[1], w[1]);
    }
  }
  return { passages: merged.map(([a, b]) => paragraphs.slice(a, b + 1).join('\n\n')), hits };
}
