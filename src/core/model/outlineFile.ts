/**
 * 情節大綱**一章一條**：`## 第3章：火折逼退`，下面第一行一句話寫這一章發生什麼、結果如何，
 * 最多再補兩句（docs/design/plans/2026-10-21-outline-per-chapter.md）。
 *
 * **純函式、零 I/O、絕不拋。** 大綱是作者高頻手改的純 Markdown，這裡只**讀**它的結構：認不出來的
 * 標題與段落不算進任何一章。
 *
 * ## 它不是一份檔案，是各章細綱「梗概」的彙總
 *
 * 大綱一章一句，細綱裡本來就有「梗概」，同一件事存兩份（docs/design/plans/2026-10-22-outline-from-plots.md）。
 * 現在磁碟上沒有 `outline.md`：讀的時候把各章細綱的梗概拼成一章一條（{@link outlineEntriesOf}），存的時候按章號拆回
 * 各章細綱（{@link planOutlineSplit}）——只有梗概、別的幾節都空的細綱是「空殼」：大綱排到了，細綱還沒拆。
 * `.novelwarden/outline.md` 這個路徑仍是情節大綱的身份，閘道器（`workspace/`）接住它的讀寫。
 *
 * ## 為什麼一章一條
 *
 * 從前按「第 a–b 章」分節，一節 3–5 章拼成一段敘述式的摘要。章與章的分界留給細綱去猜，
 * 摘要腔順著大綱 → 細綱 → 正文一路往下傳；續寫時整份大綱進一次對話，越寫越胖。一章一條之後：
 *
 * 1. **按遠近帶**（{@link outlineWindow}）：最近 10 章帶整條，再往前一章只帶第一行、最多幾章隨上下文詳細度，更早的
 *    交給全文大綱——寫到幾百章也不隨章數漲。
 * 2. **續寫大綱**：總章數超過 20 時一次寫 20 章，細綱快追上時再續——判「追上沒有」要知道覆蓋到了第幾章。
 * 3. **續寫的那一段按章號合併**（{@link mergeOutline}）：寫第 21–40 章不該把作者手改過的前 20 章整份替換掉。
 *
 * ## 認哪些寫法
 *
 * `##` 或 `###` 開頭的 `第 N 章`，後面的冒號（中英文）可有可無。**只認阿拉伯數字**：「第一章」這種寫法
 * 要做中文數字解析，而提示詞一律要求阿拉伯數字。**區間標題（`第1–4章`、`第1章-第4章`）不認**——舊格式
 * 不相容：它結束上一條，自己那一節被忽略。
 */
import { takeLast } from './contextDetail';
import { hasContent } from './markdown';
import { Plot, isPlotStub, normalizeSynopsis } from './plotFile';

export interface OutlineEntry {
  no: number;
  /** 冒號後面那一段，可能為空。 */
  title: string;
  /** 這一條的正文（不含標題行，已 trim）。第一行是這一章的概要。 */
  text: string;
}

/**
 * 章標題（連同不認的區間標題一起認出來，好讓區間標題也能結束上一條）。「章」字可以在區間末尾
 * （`第1-20章`），也可以兩頭各一個（`第1章-第20章`），但至少得有一個——`## 第 3 節` 不是章標題。
 * 分組：1 級別、2 起、3 第一個「章」、4 止（有它就是區間）、5 第二個「章」、6 標題。
 */
export const OUTLINE_HEADING =
  /^(#{2,3})\s*第\s*(\d{1,5})\s*(章)?\s*(?:[-–—~～至到]\s*(?:第\s*)?(\d{1,5})\s*)?(章)?\s*[:：]?\s*(.*?)\s*$/;

/** 任何 `#`–`###` 標題。一條到下一個**同級或更高階**的標題為止。 */
const ANY_HEADING = /^(#{1,3})\s+\S/;

/** 按遠近帶時，離當前位置多近的帶整條（{@link outlineWindow}）。 */
export const OUTLINE_NEAR = 10;

/** 只帶第一行時，那一行最多幾個字：提示詞要的是一句話，作者手寫的可能是一整段。 */
const BRIEF_MAX = 100;

type HeadingMatch = { level: number; no: number; range: boolean; title: string };

function matchHeading(line: string): HeadingMatch | undefined {
  const m = OUTLINE_HEADING.exec(line);
  if (!m || !(m[3] || m[5])) {
    return undefined;
  }
  const a = Number(m[2]);
  const b = m[4] !== undefined ? Number(m[4]) : a;
  if (!(a > 0 && b > 0)) {
    return undefined;
  }
  return { level: m[1].length, no: a, range: a !== b, title: m[6] ?? '' };
}

/**
 * 大綱切成塊：一章一條（標題行到下一個同級或更高階標題之前）與其餘部分。區間標題起一個 `other` 塊。
 * {@link parseOutline} 與 {@link mergeOutline} 共用這一套認法，合併時原樣拼回去。
 */
type OutlineBlock = { lines: string[] } & ({ kind: 'entry'; no: number; title: string } | { kind: 'other' });

function splitOutlineBlocks(text: string): OutlineBlock[] {
  const blocks: OutlineBlock[] = [];
  let current: OutlineBlock | undefined;
  let level = 0;
  for (const line of (text ?? '').replace(/^﻿/, '').split(/\r?\n/)) {
    const h = matchHeading(line);
    if (h && !h.range) {
      current = { kind: 'entry', no: h.no, title: h.title, lines: [line] };
      level = h.level;
      blocks.push(current);
      continue;
    }
    const any = ANY_HEADING.exec(line);
    if (current?.kind === 'entry' && any && any[1].length <= level) {
      current = undefined;
    }
    if (!current) {
      current = { kind: 'other', lines: [] };
      blocks.push(current);
    }
    current.lines.push(line);
  }
  return blocks;
}

/** 抽出全部條目，按出現順序。同一章出現兩次照收，取用時以先出現的為準。 */
export function parseOutline(text: string): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  for (const b of splitOutlineBlocks(text)) {
    if (b.kind === 'entry') {
      out.push({ no: b.no, title: b.title, text: b.lines.slice(1).join('\n').trim() });
    }
  }
  return out;
}

/** 按章號去重（先出現的為準）、升序。 */
function entriesByNo(text: string): OutlineEntry[] {
  const seen = new Map<number, OutlineEntry>();
  for (const e of parseOutline(text)) {
    if (!seen.has(e.no)) {
      seen.set(e.no, e);
    }
  }
  return [...seen.values()].sort((a, b) => a.no - b.no);
}

/** 區間標題（`## 第1–4章`）有幾個：舊格式不認，生成之後要說一聲。 */
export function outlineRangeHeadings(text: string): number {
  return (text ?? '').split(/\r?\n/).filter((line) => matchHeading(line)?.range).length;
}

/** 大綱寫過沒有：至少認得出一章。舊格式（區間標題）與沒有章標題的散文式大綱都算沒寫過。 */
export function isOutlineFilled(text: string): boolean {
  return parseOutline(text).length > 0;
}

/**
 * 檔案裡有沒有人寫的東西（不管認不認得出章標題）——整份換掉之前要不要先讓作者對比一遍（第 3 條）。
 *
 * 不能只看「有沒有字」：模板裡有一行 `>` 說明，老模板還有「（寫一句話概括全書。）」這類括號提示和一串
 * 空的 `1.` `-`——那些都是給人看的腳手架。所以只認**實質行**：不是空行、不是 `>` 引用、不是標題、
 * 不是空的列表項、也不是整行一對括號的提示文字。
 */
export function hasOutlineContent(text: string): boolean {
  for (const raw of (text ?? '').replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (
      !line ||
      line.startsWith('>') ||
      /^#{1,6}\s/.test(line) ||
      /^([-*+]|\d+[.、)）])\s*$/.test(line) ||
      /^[（(][^）)]*[）)]$/.test(line)
    ) {
      continue;
    }
    return true;
  }
  return false;
}

/** 大綱覆蓋到了第幾章：最大的章號；一條都認不出是 0。 */
export function outlineCoverage(text: string): number {
  return parseOutline(text).reduce((max, e) => Math.max(max, e.no), 0);
}

/** 第 `no` 章那一條；出現兩次取先出現的；沒有就 undefined。 */
export function outlineEntryFor(text: string, no: number): OutlineEntry | undefined {
  return parseOutline(text).find((e) => e.no === no);
}

/** 大綱裡有沒有落在 [from, to] 裡的條目——有，續寫這一段才談得上「覆蓋」。 */
export function outlineOverlaps(text: string, range: { from: number; to: number }): boolean {
  return parseOutline(text).some((e) => e.no >= range.from && e.no <= range.to);
}

// ---------------------------------------------------------------- 按遠近帶

/** 一條只帶第一行：`第3章 火折逼退：沈默用火摺子逼退沈懷山，照骨鏡開始搜人。` */
export function outlineBrief(e: OutlineEntry): string {
  const first =
    e.text
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/^([-*+]|\d+[.、)）])\s+/, ''))
      .find(Boolean) ?? '';
  const chars = [...first];
  const line = chars.length > BRIEF_MAX ? `${chars.slice(0, BRIEF_MAX).join('')}…` : first;
  const head = `第${e.no}章${e.title ? ` ${e.title}` : ''}`;
  return line ? `${head}：${line}` : head;
}

/** 一條整條帶：標題行規範成 `## 第N章：標題`。 */
export function renderOutlineEntry(e: OutlineEntry): string {
  return `## 第${e.no}章${e.title ? `：${e.title}` : ''}${e.text ? `\n${e.text}` : ''}`;
}

/** 整份大綱每章只列第一行（排敘事線時整份放不下用它）。 */
export function outlineBriefs(text: string): string {
  return entriesByNo(text)
    .map((e) => `- ${outlineBrief(e)}`)
    .join('\n');
}

/** 「後面已經排好的」那一段的開頭。 */
const LATER_LEAD = '後面已經排好的（只列第一行）：';

export interface OutlineWindow {
  /** 近段：帶整條的，升序。 */
  near: OutlineEntry[];
  /** 中段：近段之前只帶第一行的，升序，已按 `maxBefore` 封頂。 */
  before: OutlineEntry[];
  /** 遠段：封頂之外更早的章號，升序。不逐章列，前情交給全文大綱。 */
  folded: number[];
  /** 區間之後已有的（`after` 時），升序，只帶第一行。 */
  later: OutlineEntry[];
}

/**
 * 按遠近帶大綱，分三段（docs/design/plans/2026-10-22-planning-context-bands.md）：離這一次要寫的地方最近的
 * {@link OUTLINE_NEAR} 章帶整條（近段），再往前最多 `maxBefore` 章只帶第一行（中段），更早的不逐章列（遠段，
 * 交給全文大綱）。從前更早的一章不落地全列，寫到幾百章光這一行一行就能把視窗撐滿。
 *
 * - 給了區間 [from, to]：第 from−10 章到第 to 章是近段；`after` 為真時 to 之後已有的也只帶第一行（續寫、
 *   重寫大綱：後面已經排好的要接得上）。
 * - 沒給區間（對話頁討論大綱）：最後 10 條是近段。
 * - `maxBefore` 預設不限；`Infinity` 也是不限，0 是中段一章都不帶。
 *
 * 一條都認不出返回 undefined。
 */
export function outlineWindow(
  text: string,
  opts: { range?: { from: number; to: number }; after?: boolean; maxBefore?: number } = {}
): OutlineWindow | undefined {
  const entries = entriesByNo(text);
  if (entries.length === 0) {
    return undefined;
  }
  const { range } = opts;
  const lastNo = entries[entries.length - 1].no;
  const nearFrom = range ? range.from - OUTLINE_NEAR : entries[Math.max(0, entries.length - OUTLINE_NEAR)].no;
  const nearTo = range ? range.to : lastNo;
  const earlier = entries.filter((e) => e.no < nearFrom);
  const before = takeLast(earlier, opts.maxBefore ?? Infinity);
  return {
    near: entries.filter((e) => e.no >= nearFrom && e.no <= nearTo),
    before,
    folded: earlier.slice(0, earlier.length - before.length).map((e) => e.no),
    later: opts.after ? entries.filter((e) => e.no > nearTo) : [],
  };
}

/** 拼成一段：中段一章一行 → 近段整條 → 「後面已經排好的」一章一行。哪一段空著就不出。 */
export function renderOutlineWindow(win: Pick<OutlineWindow, 'before' | 'near' | 'later'>): string {
  return [
    win.before.map((e) => `- ${outlineBrief(e)}`).join('\n'),
    win.near.map(renderOutlineEntry).join('\n\n'),
    win.later.length > 0 ? `${LATER_LEAD}\n${win.later.map((e) => `- ${outlineBrief(e)}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * 拆細綱時大綱帶哪幾條：**這一次要拆的**——區間裡的（空殼上的梗概就是這一次的上游），外加區間前面還沒拆的空殼
 * （`stubs`：沒有關鍵事件，前序細綱一覽不列它們）。已經拆過的章由前序細綱一覽與前幾章細綱帶，同一份細綱不帶兩遍；
 * 區間之後的不帶（後面的事別提前寫掉）。`skip`：單章時這一章的梗概已經在本章細綱裡。升序。
 */
export function outlineToSplit(
  text: string,
  range: { from: number; to: number },
  opts: { stubs: ReadonlySet<number>; skip?: number }
): OutlineEntry[] {
  return entriesByNo(text).filter(
    (e) => e.no !== opts.skip && ((e.no >= range.from && e.no <= range.to) || (e.no < range.from && opts.stubs.has(e.no)))
  );
}

// ---------------------------------------------------------------- 按章號合併

function blockText(b: OutlineBlock): string {
  return b.lines.join('\n').replace(/\s+$/, '');
}

/**
 * 把第 [from, to] 章新寫的那段大綱並進舊大綱。
 *
 * 大綱是一段一段續寫的：寫第 21–40 章時模型只輸出這一段，不該讓作者手改過的第 1–20 章被整份替換掉。規則：
 *
 * - 舊大綱一條都認不出（{@link isOutlineFilled}）→ 直接用新的（舊格式不相容；有內容時呼叫方先審閱）。
 * - 刪掉舊大綱裡**落在 [from, to] 裡**的條目，新的放在第一個被刪條目的位置；一條都沒刪就按章號插在
 *   前後兩條之間（找不到就接在最後）。
 * - 新產出裡落在區間外、舊大綱已經有的章**不並進來**：那是作者沒要它重寫的，不靜默換掉（第 3 條）。
 * - 區間之外的條目、認不出的標題與段落原樣保留。
 * - 新產出裡第一條之前的東西（多半是一行 `# 情節大綱`）在合併時丟掉——舊大綱已經有自己的開頭。
 *
 * 結果仍要走覆蓋審閱：合併規則再周全，也得讓作者看一眼 diff（第 3 條）。
 */
export function mergeOutline(existing: string, incoming: string, range: { from: number; to: number }): string {
  const fresh = (incoming ?? '').trim();
  if (!isOutlineFilled(existing)) {
    return `${fresh}\n`;
  }
  const inRange = (b: OutlineBlock) => b.kind === 'entry' && b.no >= range.from && b.no <= range.to;
  const blocks = splitOutlineBlocks(existing);
  const kept = blocks.filter((b) => !inRange(b));
  const keptNos = new Set(kept.flatMap((b) => (b.kind === 'entry' ? [b.no] : [])));

  const incomingBlocks = splitOutlineBlocks(fresh);
  const firstEntry = incomingBlocks.findIndex((b) => b.kind === 'entry');
  const insert = (firstEntry === -1 ? incomingBlocks : incomingBlocks.slice(firstEntry))
    .filter((b) => !(b.kind === 'entry' && !inRange(b) && keptNos.has(b.no)))
    .map(blockText)
    .join('\n\n')
    .trim();
  if (!insert) {
    return existing;
  }

  const first = blocks.findIndex(inRange);
  let at: number;
  if (first !== -1) {
    at = blocks.slice(0, first).filter((b) => !inRange(b)).length;
  } else {
    // 插在「後面那一條」之前；沒有後面的就緊跟「前面最後一條」——不跟在末尾的附註後面。
    const after = kept.findIndex((b) => b.kind === 'entry' && b.no > range.to);
    let before = -1;
    kept.forEach((b, i) => {
      if (b.kind === 'entry' && b.no < range.from) {
        before = i;
      }
    });
    at = after !== -1 ? after : before !== -1 ? before + 1 : kept.length;
  }

  const parts = [...kept.slice(0, at).map(blockText), insert, ...kept.slice(at).map(blockText)].filter((p) => p.trim());
  return `${parts.join('\n\n')}\n`;
}

// ---------------------------------------------------------------- 從細綱彙總

/** 彙總文件的標題行。編輯器開啟的那一份帶它，裝配器讀的（{@link outlineEntriesOf}）不帶。 */
export const OUTLINE_DOC_HEADING = '# 情節大綱';

/** 彙總文件開頭那段說明：給手改的作者看——存檔只認章標題與下面的梗概。 */
export const OUTLINE_DOC_NOTE =
  '> 一章一條，彙總自各章細綱的「梗概」。改了存檔就寫回那一章的細綱；新加的章建一份只有梗概的細綱，刪掉的空殼細綱進回收站。' +
  '只認「## 第N章：標題」與下面那幾句，別的文字不儲存。';

/**
 * 各章細綱（每個章號認下的那一份，`NovelProject.pairPlots`）→ 一章一條：章號、標題、梗概。梗概空著的不算——
 * 那一章大綱裡沒有。
 */
export function outlineEntriesOf(plots: readonly Pick<Plot, 'no' | 'title' | 'sections'>[]): OutlineEntry[] {
  return plots
    .filter((p) => hasContent(p.sections.梗概))
    .map((p) => ({ no: p.no, title: p.title, text: normalizeSynopsis(p.sections.梗概) }))
    .sort((a, b) => a.no - b.no);
}

/** 一章一條拼成大綱正文（不帶標題行與說明）。 */
export function renderOutline(entries: readonly OutlineEntry[]): string {
  return entries.map(renderOutlineEntry).join('\n\n');
}

/** 給編輯器、覆蓋審閱看的整份：標題行、說明、一章一條。 */
export function renderOutlineDoc(entries: readonly OutlineEntry[]): string {
  const body = renderOutline(entries);
  return `${OUTLINE_DOC_HEADING}\n\n${OUTLINE_DOC_NOTE}\n${body ? `\n${body}\n` : ''}`;
}

// ---------------------------------------------------------------- 按章號拆回各章細綱

/** 拆回去的一步。`update` 裡給了哪個欄位就是哪個變了。 */
export type OutlineSplitOp =
  | { op: 'create'; no: number; title: string; synopsis: string }
  | { op: 'update'; no: number; rel: string; title?: string; synopsis?: string }
  | { op: 'drop'; no: number; rel: string };

export interface OutlineSplitPlan {
  ops: OutlineSplitOp[];
  /** 大綱裡刪掉了、但已經排了細綱或寫了正文的章：不刪，說一聲。 */
  kept: number[];
  /** 只有章標題、下面沒寫一個字的章：沒地方存，說一聲。 */
  empty: number[];
}

/**
 * 存一份彙總文件時，按章號拆回各章細綱要做哪幾件事（落盤在 `Workspace.writeOutline`）。
 *
 * - 一條在、這一章有細綱：梗概或標題變了就改（標題空著 = 沿用細綱的標題）。
 * - 一條在、這一章沒有細綱：建一份空殼。
 * - 原來在大綱裡（梗概非空）、這一回沒有了：空殼（{@link isPlotStub}，且這一章還沒有正文）刪掉；
 *   排了細綱或寫了正文的不刪，記進 `kept`。
 * - 同一章寫了兩條取先出現的；章號只按標題裡寫的認，**不搬細綱**（把第 5 章改叫第 6 章，等於改第 6 章、刪第 5 章）。
 *
 * @param plots 每個章號認下的那一份細綱（`pairPlots`）
 * @param writtenNos 已經有正文的章號
 */
export function planOutlineSplit(text: string, plots: readonly Plot[], writtenNos: ReadonlySet<number>): OutlineSplitPlan {
  const byNo = new Map(plots.map((p) => [p.no, p]));
  const ops: OutlineSplitOp[] = [];
  const empty: number[] = [];
  const present = new Set<number>();
  for (const e of entriesByNo(text)) {
    const synopsis = normalizeSynopsis(e.text);
    if (!hasContent(synopsis)) {
      empty.push(e.no);
      continue;
    }
    present.add(e.no);
    const plot = byNo.get(e.no);
    if (!plot) {
      ops.push({ op: 'create', no: e.no, title: e.title, synopsis });
      continue;
    }
    const titleChanged = e.title !== '' && e.title !== plot.title;
    const synopsisChanged = synopsis !== normalizeSynopsis(plot.sections.梗概);
    if (titleChanged || synopsisChanged) {
      ops.push({
        op: 'update',
        no: e.no,
        rel: plot.relPath,
        ...(titleChanged ? { title: e.title } : {}),
        ...(synopsisChanged ? { synopsis } : {}),
      });
    }
  }
  const kept: number[] = [];
  for (const plot of plots) {
    if (present.has(plot.no) || !hasContent(plot.sections.梗概)) {
      continue;
    }
    if (isPlotStub(plot) && !writtenNos.has(plot.no)) {
      ops.push({ op: 'drop', no: plot.no, rel: plot.relPath });
    } else {
      kept.push(plot.no);
    }
  }
  return { ops, kept: kept.sort((a, b) => a - b), empty: empty.filter((no) => !byNo.get(no)?.sections.梗概.trim()) };
}
