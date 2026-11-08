import { traditionalLabel } from './labels';
/**
 * 一章的細綱（`.novelwarden/summaries/<與正文相同的相對路徑>.md`）的格式定義。
 *
 * **純函式、零 I/O**，與 chapterFile.ts / settingFile.ts 同類；
 * 路徑規則與讀寫在 model/project.ts，解析與渲染只在這裡定義一次。
 *
 * ## 一份細綱 = 一章，前後兩個階段是同一份檔案
 *
 * 細綱**映象正文在章節根下的相對路徑**，副檔名換成 `.md`：`chapters/第一卷/003-深处.txt` 的細綱是
 * `summaries/第一卷/003-深处.md`（與草稿同一套映象，規則在 `NovelProject.plotPathForChapter`）。
 * 檔名字首就是章號；還沒有正文的章，正文照細綱的路徑反推著落。
 *
 * - **寫正文之前它是計劃**：正文照它寫。
 * - **定稿之後它是檔案**：作者點「定稿」，模型拿著它與正文把它改成正文實際寫成的樣子
 *   （反向更新，features/summarize.ts）——正文寫偏的改掉、沒寫到的刪掉、一致的保留原措辭。
 *
 * 從前計劃（`plots/` 三節）與檔案（單章摘要）各存一份。作者的原則是相似的東西不留兩份，
 * 摘要那一套更完善，於是細綱換成了摘要的八節；`plots/` 不再讀（老工程裡那個目錄判成
 * `other`，一個位元組都不動）。敘事線重做二期又刪了「新增伏筆」一節，剩七節：伏筆並進了敘事線
 * （計劃寫進線裡，`model/threadFile.ts`），細綱裡不再有任何關於線的小節。
 *
 * ## 它可以寫具體場面
 *
 * 舊版明文禁止細綱寫畫面、動作、臺詞，只許寫抽象的因果鏈。那是讓模型去「擴寫」
 * 一條梗概，寫出來就是流水賬。現在「關鍵事件」按發生的順序一條一件事、合計 100–300 字，
 * 每條**可以寫具體場面**——誰在哪、對誰做了什麼、結果怎樣；它仍然不是正文（不寫成段的描寫
 * 與對白）。計劃與定稿都是一條一行的列表，定稿時才能逐條改，而不是把一整段重寫一遍。
 * 「看點」寫爽點，也寫章末吊著讀者的那一下（從前單列的「章末鉤子」並進了這裡）。
 *
 * ## frontmatter
 *
 * - `targetWords`：這一章寫多少字。沒寫就用 `config.md` 的每章字數。
 * - `upstreamHash`：排這份細綱（寫下其餘幾節）時**這一章梗概**的指紋（{@link plotSynopsisHash}）。梗概就是情節大綱裡
 *   這一章那一條（大綱是各章梗概的彙總，model/outlineFile.ts）：在大綱裡改了它、其餘幾節沒跟，這一章掛 ⟳（{@link isPlotUpstreamStale}）。
 * - `writtenFrom`：**正文據以寫成的細綱指紋**，正文落盤那一步記，定稿時刷成反向更新之後的指紋。
 *   記在細綱這一側，是因為章節是作者的檔案、可以是 `.txt`、沒有 frontmatter
 *   （第 9 條），這條鏈只能從這邊指過去。與當前內容指紋對不上 = 細綱在正文（或定稿）之後
 *   改過，正文掛 ⟳。從沒記過（作者手寫的正文）就永不標髒（第 18a 條）。
 * - `sourceHash`：定稿時正文的 `contentHash`。**有它就表示這份細綱反向更新過**；與正文現在的
 *   指紋對得上才算這一章寫完（第 23 條）。
 * - `cast`：定稿時記的**實際**出場，`林昭(阿昭)` 一項一人，給出場統計讀（第 14 條）。定稿之前
 *   「出場人物」一節寫的是**計劃**出場，只給裝配器挑角色卡、算「後幾章才出場的人」、做一致性預檢，
 *   **不進出場統計**——計劃與實際混在一起會汙染它（D13）。
 * - `status: done`：作者手工宣佈這一章過了。只允許向前覆蓋推導值。
 * - `preflightOk`：一致性預檢的**永久放行**（五期補遺 §2），一行一條「名字：理由」——作者說過
 *   「這一章裡他出場是刻意的安排（回憶、幻象……）」的那幾個人，寫這一章之前不再為他們亮卡。
 *   按章記：第 8 章是回憶，不代表第 12 章再排他也是。**重新生成這一章的細綱會丟掉它**（handlers/plot.ts
 *   的渲染不帶它）：重排過的出場是新的安排，要再問一次。改名、記賬、定稿都原樣留著。作者要撤銷就刪掉那一行。
 *   不進內容指紋（{@link PLOT_SECTION_KEYS} 之外的都不進），記下它不會讓正文變成「細綱改過」。
 * - `factCheckOk: true`：批次寫章寫前衝突檢查（features/plotCheck.ts）的放行。檢查說本章細綱與前面
 *   定稿的事實矛盾、作者看過認為是刻意安排時手寫這一行；與 `preflightOk` 一樣不進內容指紋。
 *
 * 老工程 `summaries/` 下的單章摘要（`001-楔子.md`、`第一卷/003-深处.md`）本來就是這幾節、本來就映象
 * 正文的路徑，帶著 `sourceHash` 與 `cast`，直接當成定稿過的細綱讀；它 frontmatter 裡的 `chapter:`
 * 不認，章號取檔名字首。
 *
 * ## 刪掉的「新增伏筆」（敘事線二期）
 *
 * 老細綱裡那一節當認不出的小節留在檔案裡，**不讀**（不進 `sections`、不進上下文、不進內容指紋），一個位元組不動
 * （第 1 條；設計稿「刪掉什麼、不相容什麼」）。⚑ 內容指紋因此變了（定案 A）：寫過正文的章都會掛一次 ⟳
 * （「細綱在寫正文之後改過」），重新定稿才消；⟳ 只是一個記號，不把章拉回「待寫」，不做遷移。
 *
 * ## 「設定」一節
 *
 * 七節之後另有一節「設定」（`Plot.lore`，從前是第九節，刪了「新增伏筆」之後成了第八節；程式碼裡的識別符號沒改），
 * 一行一個東西：`- 名〔分類〕：本章確立的定義或規則`（格式在 model/loreFile.ts）。寫之前是**計劃**用到、要引入的設定，
 * 定稿後是正文裡**實際**出現的。
 *
 * - **不進內容指紋**（{@link plotContentHash} 只算七節），與 frontmatter 的 `cast` 一樣當機器讀的旁註：
 *   給老章節補記設定時要往定稿過的細綱里加這一節，算進指紋會把這些章全掛上 ⟳；只改了「計劃用到
 *   哪些設定」也不值得把正文標成過期。
 * - **有沒有記過看標題在不在**：`lore` 為 undefined = 檔案裡沒有這一節（老細綱、還沒補記）；
 *   空陣列 = 記過、這一章沒有設定（落盤寫「（無）」）。
 *
 * ## 派生資料一律不寫進這份檔案
 *
 * 「這一章寫了幾個字」「寫到幾成」都是別處算得出來的東西，寫進來就會漂移。
 * 要看就現算（core/views/pipeline.ts）。
 */
import * as path from 'node:path';
import { hash } from './fs';
import {
  asArray,
  asNumber,
  asString,
  hasContent,
  parseMarkdown,
  pickSections,
  stringifyFrontmatter,
  stringifySections,
} from './markdown';
import { castFromText, parseCast, parseCastEntry, renderCastEntry } from './castParse';
import { LoreLine, PLOT_LORE_KEY, parseLoreLines, renderLoreLines } from './loreFile';
import type { SummaryCast } from './types';

/**
 * 七節，照單章摘要原來的那八節去掉「新增伏筆」（敘事線二期：伏筆並進了敘事線）。順序即「讀它們的順序」：先知道這一章
 * 發生了什麼、誰在、在哪，再看落在哪些事件上，然後是吊著讀者的看點、人物變成了什麼樣，最後是後面各章必須保持一致的
 * 事實。判「排過沒有」只看「關鍵事件」，見 {@link isPlotFilled}。
 */
export const PLOT_SECTION_KEYS = [
  '梗概',
  '出场人物',
  '时间地点',
  '关键事件',
  '看点',
  '状态变更',
  '连续性事实',
] as const;

export type PlotSectionKey = (typeof PLOT_SECTION_KEYS)[number];

/**
 * 七節的內容。缺失的小節為空串。
 *
 * - 「看點」：讀者最爽、最想往下看的地方（爽點與章末吊著讀者的東西）。拆書整理架構與大綱時靠它提煉賣點。
 * - 「連續性事實」：後面各章必須保持一致的事實，一條一行，每條掛一句正文裡的證據原文（D18）：
 *   `- 林昭左臂被劃傷，未愈 〔證據：「血順著左臂往下淌」〕`。格式與解析在 model/continuity.ts。
 *   計劃時是空的（證據句要回原文定位，沒有正文就沒法定位），定稿時才生成；寫正文時不拿這一節
 *   當事實，而是拿證據原句回到那一章的正文裡取原文段落（`evidence` 層）。
 */
export type PlotSections = Record<PlotSectionKey, string>;

/**
 * 模型排一章細綱時各欄位的長度上限（字）。提示詞裡的合同（context/prompts.ts）與
 * 解碼（features/blueprint.ts）共用這一份。
 *
 * 標題會變成檔名（`012-<標題>.md`），所以比上游（AI-Novel-Writer 的
 * `blueprint-semantic-contract.ts`，60 字）緊得多。關鍵事件是一條一件事的列表（與定稿時
 * 寫出來的一樣），合同要 3–6 條、合計 100–300 字；條數硬上限 8，總字數硬上限沿用上游的 1200。
 * 看點是一條一句的列表。
 */
export const BLUEPRINT_LIMITS = {
  title: 18,
  /** 梗概就是情節大綱裡這一章那一條：一句話，最多再補兩句。 */
  synopsis: 150,
  timePlace: 120,
  /** 關鍵事件所有條目加起來最多幾個字。 */
  keyEvents: 1200,
  /** 關鍵事件最多幾條。 */
  keyEventItems: 8,
  /** 看點最多幾條。 */
  listItems: 5,
  /** 看點每條最多幾個字。 */
  listItem: 120,
  stateChange: 400,
  characters: 12,
  name: 32,
} as const;

export interface Plot {
  /** 細綱檔案的工作區相對路徑（映象正文的相對路徑，見檔案頭）。 */
  relPath: string;
  /** 章號，來自檔名數字字首。**檔名是身份**，與釋出章節同一套規則。 */
  no: number;
  title: string;
  /**
   * 這一章出場的人（只有名字）。定稿過（有 `sourceHash`）取 `cast`——實際出場；沒定稿取
   * 「出場人物」一節——**計劃**出場，只給裝配器挑角色卡、預檢用（見檔案頭）。
   */
  characters: string[];
  /**
   * 結構化的出場人物：frontmatter 的 `cast`，沒有就從「出場人物」一節反解（手寫的老摘要）。
   * **只有定稿過的細綱**這一份才是實際出場，出場統計據此過濾（`sourceHash`）。
   */
  cast: SummaryCast[];
  /** 這一章預計寫多少字正文。 */
  targetWords?: number;
  /** 排這份細綱時梗概（情節大綱裡這一章那一條）的指紋。與現在的梗概對不上 = 大綱改了、細綱沒跟。 */
  upstreamHash: string;
  /** 正文據以寫成的細綱指紋。見檔案頭。 */
  writtenFrom: string;
  /** 定稿時正文的 contentHash。空串 = 從沒定稿過。見檔案頭。 */
  sourceHash: string;
  /** 作者手工宣佈這一章過了（frontmatter `status: done`）。只允許向前覆蓋推導值。 */
  done: boolean;
  /** 一致性預檢的永久放行（frontmatter `preflightOk`）。見檔案頭。 */
  preflightOk: PreflightOk[];
  /** 寫前衝突檢查的放行（frontmatter `factCheckOk: true`）。見檔案頭。 */
  factCheckOk?: boolean;
  sections: PlotSections;
  /**
   * 「設定」一節（見檔案頭）。undefined = 檔案裡沒有這一節（老細綱、還沒記過）；
   * 空陣列 = 記過、沒有設定。
   */
  lore?: LoreLine[];
  /** frontmatter 之外的正文全文。作者可能加了自定義小節，讀回來時保留。 */
  body: string;
}

/** 預檢永久放行的一條：誰、為什麼（作者沒寫理由時是空串）。 */
export interface PreflightOk {
  name: string;
  reason: string;
}

/**
 * 寫盤時需要的欄位（relPath / body 由呼叫方與渲染決定）。出場的人寫在「出場人物」一節裡，
 * `characters` 是讀回來時推出來的，不寫。`preflightOk` 不給就不寫（見檔案頭）。
 */
export type WritablePlot = Omit<
  Plot,
  'relPath' | 'body' | 'characters' | 'cast' | 'writtenFrom' | 'sourceHash' | 'preflightOk' | 'factCheckOk'
> & {
  writtenFrom?: string;
  sourceHash?: string;
  cast?: SummaryCast[];
  preflightOk?: PreflightOk[];
  factCheckOk?: boolean;
};

/** `沈秋：回憶裡的一場` ↔ `{ name, reason }`。全形半形冒號都認；沒有冒號就整行是名字。 */
export function parsePreflightOk(lines: readonly string[]): PreflightOk[] {
  const out: PreflightOk[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const at = line.search(/[：:]/u);
    const name = (at >= 0 ? line.slice(0, at) : line).trim();
    if (name && !out.some((x) => x.name === name)) {
      out.push({ name, reason: at >= 0 ? line.slice(at + 1).trim() : '' });
    }
  }
  return out;
}

export function renderPreflightOk(entries: readonly PreflightOk[]): string[] {
  return entries.map((e) => (e.reason.trim() ? `${e.name}：${e.reason.trim()}` : e.name));
}

export interface PlotFileName {
  no: number;
  /** 去掉序號字首與副檔名後的詞幹，可能為空（如 `007.md`）。 */
  stem: string;
}

/** 細綱檔案只認 markdown 家族——它是外掛自己的資料格式，與角色卡一致。 */
const PLOT_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.markdown']);

/**
 * 檔名 → 章號與詞幹。不是 `.md`、或沒有數字字首，返回 undefined。
 *
 * 與 parseChapterFileName 一樣**先剝副檔名再匹配字首**：分隔符集合裡含 `.`，
 * 直接對整個檔名跑正則的話 `007.md` 會被吃成「第 007 章 + 詞幹 md」。
 * 字首位數也與章節一致（1–5 位）：細綱映象正文的檔名，正文認得出的號這裡必須也認得出。
 * `global.md`（全文大綱）沒有數字字首，天然不是細綱。
 */
export function parsePlotFileName(fileName: string): PlotFileName | undefined {
  const ext = path.extname(fileName).toLowerCase();
  if (!PLOT_EXTENSIONS.has(ext)) {
    return undefined;
  }
  const base = fileName.slice(0, fileName.length - ext.length);
  const m = /^(\d{1,5})[-_.\s]*(.*)$/.exec(base);
  if (!m) {
    return undefined;
  }
  const no = Number(m[1]);
  // 0 號章沒有意義，且會讓序號文案錯位。
  return no > 0 ? { no, stem: m[2] } : undefined;
}

export function isPlotFileName(fileName: string): boolean {
  return parsePlotFileName(fileName) !== undefined;
}

/**
 * 章號 + 標題 → 檔名。三位數字首，與釋出章節對齊——一本書幾百章是常態，
 * 兩位數不夠用。
 *
 * `sanitize` 由呼叫方（project.ts 的 sanitizeFileName）負責；這裡只管拼，
 * 保持零 I/O 與零跨層依賴。
 */
export function plotFileName(no: number, safeTitle: string): string {
  const prefix = String(Math.max(1, Math.trunc(no))).padStart(3, '0');
  return safeTitle ? `${prefix}-${safeTitle}.md` : `${prefix}.md`;
}

export function emptyPlotSections(): PlotSections {
  return {
    梗概: '',
    出场人物: '',
    时间地点: '',
    关键事件: '',
    看点: '',
    状态变更: '',
    连续性事实: '',
  };
}

/**
 * 這一章有沒有真的排過。
 *
 * 判據是**「關鍵事件」非空**，只有它。「梗概」一句話就能寫，拿它當判據的話
 * 只起了個頭的空殼會立刻顯示「已規劃」，緊接著的批次寫正文還會照著空殼往下寫。
 * 佔位文字（`（待補充）`）不算內容。
 */
export function isPlotFilled(sections: PlotSections): boolean {
  return hasContent(sections.关键事件);
}

/**
 * 空殼：只有梗概（情節大綱裡這一章那一條），別的幾節都空、沒記過設定、沒定稿過——大綱排到了，細綱還沒拆
 * （docs/design/plans/2026-10-22-outline-from-plots.md）。在彙總的大綱裡刪掉那一條時，只有空殼跟著進回收站。
 */
export function isPlotStub(plot: Pick<Plot, 'sections' | 'lore' | 'sourceHash'>): boolean {
  return (
    !plot.sourceHash &&
    !plot.lore?.length &&
    PLOT_SECTION_KEYS.every((key) => key === '梗概' || !hasContent(plot.sections[key]))
  );
}

/**
 * 梗概的指紋——細綱的上游（`upstreamHash`）。梗概空著給空串：沒有上游就不記、不標髒（第 18a 條）。
 * 換行與行尾空白不算改動。
 */
export function plotSynopsisHash(synopsis: string | undefined): string {
  const text = normalizeSynopsis(synopsis ?? '');
  return hasContent(text) ? hash(text) : '';
}

/** 梗概比較前的歸一：換行統一、行尾空白去掉、首尾空行去掉。 */
export function normalizeSynopsis(text: string): string {
  return (text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .trim();
}

/**
 * 大綱改了、細綱沒跟：記過上游指紋、這一章排過細綱（「關鍵事件」非空——空殼沒有可跟的東西）、梗概現在的指紋對不上。
 * 沒記過（作者手寫的）永不標髒（第 18a 條）。
 */
export function isPlotUpstreamStale(plot: Pick<Plot, 'upstreamHash' | 'sections'> | undefined): boolean {
  if (!plot?.upstreamHash || !isPlotFilled(plot.sections)) {
    return false;
  }
  const current = plotSynopsisHash(plot.sections.梗概);
  return current !== '' && current !== plot.upstreamHash;
}

/** 行首的列表記號：`- ` `* ` `· ` `• ` `1.` `1、` `1)`。 */
const LIST_MARKER = /^\s*(?:[-*·•]|\d+[.、)．])\s*/u;

/**
 * 一條一行的那幾節（關鍵事件、看點）→ 一條一項：按行切，去掉行首的列表記號，
 * 空行與佔位文字（`（待補充）`）不算。**只按換行切**——一條裡本來就可以有分號；
 * 作者手寫成一整段的就是一項。
 */
export function sectionItems(text: string): string[] {
  return (text ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(LIST_MARKER, '').trim())
    .filter((line) => hasContent(line));
}

/**
 * 一條一行的那幾節壓成一行，條與條之間用「；」接。給一章一行的一覽用（前序細綱一覽、
 * 寫正文的邊界、排敘事線）：直接把換行換成空格會得到「- 甲 - 乙」。
 */
export function sectionLine(text: string): string {
  return sectionItems(text).join('；');
}

/**
 * 細綱的內容指紋——**這一章正文的上游**。
 *
 * 只雜湊**七個小節**，不含 frontmatter：`upstreamHash` / `writtenFrom` / `sourceHash` / `cast`
 * 自己就在 frontmatter 裡，把它算進去會讓「排一次細綱」「定稿一次」立刻使剛寫好的正文過期。
 * 同理不含 `status`、`preflightOk`、`factCheckOk` 與標題——作者把這一章標成 done、記一條預檢放行、
 * 改個標題，都不該讓它的正文標髒。「設定」一節也不進；老細綱裡認不出的「新增伏筆」也不進（見檔案頭）。
 */
export function plotContentHash(plot: Pick<Plot, 'sections'>): string {
  return hash(PLOT_SECTION_KEYS.map((key) => plot.sections[key]).join('\n---\n'));
}

/**
 * 「出場人物」一節 → 計劃出場的名字。按頓號、逗號、斜槓、分號、換行切開，去掉列表符號，
 * `林昭(阿昭)` 只取名字。括號裡的斜槓不切（那是別名的分隔）。
 *
 * 與 `castFromText` 不同，這裡**不按長度與虛詞過濾**：那兩條是為了擋住模型把定稿的這一節
 * 寫成句子，計劃裡的名單是作者與排細綱的模型寫的，「沈從文」這種名字不該因為帶個「從」就漏掉。
 */
export function plannedNames(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cleaned = line.replace(/^\s*(?:[-*·•]|\d+[.、)])\s*/, '').trim();
    if (!hasContent(cleaned)) {
      continue;
    }
    for (const part of splitOutsideBrackets(cleaned)) {
      const name = parseCastEntry(part)?.name.trim().slice(0, BLUEPRINT_LIMITS.name);
      if (name && !/^((?:无|無)|(?:暂|暫)(?:无|無)|(?:没|沒)有|未知)$/.test(name) && !out.includes(name)) {
        out.push(name);
      }
    }
  }
  return out;
}

/** 按頂層的分隔符切開：括號裡的 `、` `/` 是別名分隔，不切。 */
function splitOutsideBrackets(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(' || ch === '（') {
      depth++;
    } else if ((ch === ')' || ch === '）') && depth > 0) {
      depth--;
    }
    if (depth === 0 && /[、,，/;；]/.test(ch)) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/**
 * 解析細綱檔案。**絕不拋**：作者會手改，frontmatter 寫壞、小節改名、
 * 整份檔案被換成大白話都只該退化為「解析出來的少一點」。
 *
 * `no` 以檔名為準而不是 frontmatter 的 `no`：檔名是身份（作者重排順序的方式
 * 就是改檔名字首），frontmatter 裡那份只是給人看的；老摘要的 `chapter:` 不認。
 * 佔位文字讀回來是空串，免得「（待補充）」被當成內容送進 prompt。
 */
export function parsePlotFile(text: string, relPath: string): Plot {
  const { frontmatter, body } = parseMarkdown(text);
  const raw = pickSections<PlotSectionKey>(body, PLOT_SECTION_KEYS) as PlotSections;
  const sections = emptyPlotSections();
  for (const key of PLOT_SECTION_KEYS) {
    sections[key] = hasContent(raw[key]) ? raw[key] : '';
  }
  const fromName = parsePlotFileName(path.basename(relPath));
  const sourceHash = asString(frontmatter.sourceHash);
  // frontmatter 的 cast 是結構化真相；沒有它（作者手寫的老摘要）就從「出場人物」小節反解。
  const cast = parseCast(frontmatter.cast) ?? castFromText(sections.出场人物);
  const lore = LORE_HEADING.test(body)
    ? parseLoreLines(pickSections(body, [PLOT_LORE_KEY])[PLOT_LORE_KEY])
    : undefined;
  return {
    relPath,
    no: fromName?.no ?? asNumber(frontmatter.no) ?? 0,
    title: asString(frontmatter.title) || (fromName?.stem ?? ''),
    characters: sourceHash ? cast.map((c) => c.name) : plannedNames(sections.出场人物),
    cast,
    targetWords: positive(asNumber(frontmatter.targetWords)),
    upstreamHash: asString(frontmatter.upstreamHash),
    writtenFrom: asString(frontmatter.writtenFrom),
    sourceHash,
    done: asString(frontmatter.status).toLowerCase() === 'done',
    preflightOk: parsePreflightOk(asArray(frontmatter.preflightOk)),
    ...(asString(frontmatter.factCheckOk).toLowerCase() === 'true' ? { factCheckOk: true } : {}),
    sections,
    ...(lore ? { lore } : {}),
    body,
  };
}

/** 「設定」一節的標題行（`##` 或 `###`，前後空白不計）。 */
const LORE_HEADING = new RegExp(`^#{2,3}[ \\t]*(?:${PLOT_LORE_KEY}|${traditionalLabel(PLOT_LORE_KEY)})[ \\t]*$`, 'm');

/** 渲染成落盤的 Markdown。空小節保留佔位，作者手改時知道該往哪填。 */
export function renderPlotFile(plot: WritablePlot): string {
  const fm = stringifyFrontmatter({
    no: plot.no,
    title: plot.title,
    targetWords: plot.targetWords,
    upstreamHash: plot.upstreamHash || undefined,
    writtenFrom: plot.writtenFrom || undefined,
    sourceHash: plot.sourceHash || undefined,
    // 機器可讀的實際出場，只在定稿時寫。別名跟在名字後的括號裡：`林昭(阿昭)`——
    // frontmatter 解析器只認字串陣列，不要為此引入巢狀 YAML。
    cast: plot.sourceHash && plot.cast ? plot.cast.map(renderCastEntry) : undefined,
    status: plot.done ? 'done' : undefined,
    preflightOk: plot.preflightOk?.length ? renderPreflightOk(plot.preflightOk) : undefined,
    factCheckOk: plot.factCheckOk ? 'true' : undefined,
    generatedBy: 'novelwarden',
  });
  const body = stringifySections(plot.sections as unknown as Record<string, string>, PLOT_SECTION_KEYS, {
    keepEmpty: true,
  });
  const lore = plot.lore ? `\n\n## ${traditionalLabel(PLOT_LORE_KEY)}\n\n${renderLoreLines(plot.lore)}` : '';
  const heading = `# 第${plot.no}章${plot.title ? ` ${plot.title}` : ''}`;
  return `${fm}\n\n${heading}\n\n${body}${lore}\n`;
}

function positive(n: number | undefined): number | undefined {
  return n !== undefined && n > 0 ? n : undefined;
}
