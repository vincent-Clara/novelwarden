import { traditionalLabel } from '../../model/labels';
/**
 * `plot` handler：一章的細綱。
 *
 * 兩件事：
 *
 * 1. **渲染**：`Artifact{kind:'plot'}` → `renderPlotFile`。七個小節換新；
 *    **標題、目標字數、done、writtenFrom、定稿記的 sourceHash 與 cast 沿用磁碟那份**——
 *    「重寫細綱」改的是這一章怎麼走，不該順手把作者起的標題、定的字數、標的完成狀態抹掉；
 *    `writtenFrom` 是正文那一側記的賬，細綱重寫之後它對不上，正是「細綱在正文之後改過」的訊號
 *    （定稿過的章照樣只掛 ⟳，第 18 條）。**預檢的永久放行（`preflightOk`）刻意不沿用**：
 *    重排過的出場是新的安排，要再問一次（五期補遺 §2）。
 * 2. **記賬**：`upstreamHash` = 寫下去的這一份裡**梗概**的指紋（`plotSynopsisHash`；梗概就是情節大綱裡這一章那一條，
 *    大綱是各章梗概的彙總）。梗概空著就不記。誰寫都記——作者在內建編輯器裡改一份細綱，等於把細綱與大綱那一條對齊了；
 *    在彙總的大綱裡改梗概走的是閘道器的 `writeOutline`（外科式換掉那一節，不經這裡），指紋不動，排過細綱的章於是掛 ⟳。
 *
 * 複製出來的副本另有一條（`afterCopy`）：去掉定稿那一側的指紋，`upstreamHash` 不重記——副本是一份還沒寫、沒定稿的計劃。
 *
 * 另有定稿那一次寫入的渲染（{@link renderFinalizedPlot}）：它不走 `write`，由
 * `Workspace.finalizePlot` 調——反向更新的依據是正文；梗概照正文改了，記過的上游指紋跟著刷成新梗概的。
 *
 * ## 兩條不能碰的取捨
 *
 * - **手寫的產物永不標髒**（第 18a 條）：**沒有 frontmatter 的細綱不補
 *   `upstreamHash`**。它為空說明這份細綱不是這條鏈生出來的，拿一個憑空的過期標記
 *   去催作者重做，他會學會無視所有標記。
 * - **`plotContentHash` 只雜湊七個小節，不含 frontmatter**（第 18b 條）：
 *   `upstreamHash` / `writtenFrom` / `sourceHash` 自己就在 frontmatter 裡，算進去會讓「排一次細綱」
 *   立刻使這一章的正文過期。那個雜湊在 `model/plotFile.ts` 裡定義。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { readTextIfExists } from '../../model/fs';
import { parseMarkdown, rewriteFrontmatter } from '../../model/markdown';
import { NovelProject } from '../../model/project';
import {
  Plot,
  PlotSections,
  WritablePlot,
  parsePlotFile,
  parsePlotFileName,
  plotContentHash,
  plotSynopsisHash,
  renderPlotFile,
} from '../../model/plotFile';
import { SummaryCast } from '../../model/types';
import type { LoreLine } from '../../model/loreFile';
import { Handler, HandlerCtx } from './types';

export const plotHandler: Handler = {
  /**
   * 七個小節換新，其餘欄位按上面的規矩合併。
   *
   * 細綱檔案不存在時（拆細綱那一步新建）就用產物自己帶的標題與目標字數。
   */
  async render(ctx: HandlerCtx, artifact) {
    if (artifact.kind !== 'plot') {
      throw new Error(`「${ctx.rel}」不接 ${traditionalLabel(artifact.kind)} 產物`);
    }
    const current = await ctx.project.readPlot(ctx.rel);
    return renderPlotFile({
      no: current?.no ?? ctx.path.no ?? 0,
      title: current?.title || artifact.title || '',
      targetWords: current?.targetWords ?? artifact.targetWords,
      upstreamHash: plotSynopsisHash(artifact.sections.梗概),
      writtenFrom: current?.writtenFrom,
      sourceHash: current?.sourceHash,
      cast: current?.cast,
      done: current?.done ?? false,
      sections: artifact.sections,
      // 「設定」一節不在七節裡：產物帶了就換新（重排的計劃），沒帶就沿用磁碟那份。
      lore: artifact.lore ?? current?.lore,
    });
  },

  /**
   * 記賬：把寫下去的這一份梗概的指紋落進 frontmatter。
   *
   * `rewriteFrontmatter` 只改 `---` 之間那一段，**正文一個位元組不動**——
   * 作者可能加過自定義小節，整份重渲染會把它們悄悄抹平。
   * 沒有 frontmatter 時返回 undefined，那正是「手寫的產物」，不補。
   */
  async after(ctx: HandlerCtx, text: string) {
    return recordUpstream(ctx, text, plotSynopsisHash(parsePlotFile(text, ctx.rel).sections.梗概), '梗概指紋');
  },

  /**
   * 複製出來的一份細綱（檔案頁的「複製 → 貼上」，或整個分卷目錄複製一份）：**去掉定稿那一側的賬**，其餘一個字不動。
   *
   * - `writtenFrom` / `sourceHash` / `cast` 刪掉：它們說的是「有一份正文照這份寫成過、定稿時正文是這個指紋、實際出場
   *   這幾個人」——那是原件那一章的事。副本落在別的路徑上，映象的是另一章（或者還沒有正文），帶著它們會被當成
   *   定稿過的細綱：出場統計、設定名錄多數一章（第 14 條），映象位置上要是恰好有正文，還會被說成「定稿之後正文改過」
   *   或「細綱在正文之後改過」（第 18 條）。副本是一份還沒寫、沒定稿的計劃。
   * - `upstreamHash` **原樣留著，不重算**：內容一字沒變、章號沒變（檔名照抄）——原件掛著 ⟳ 的副本照樣掛著，
   *   不被複制順手刷成「新鮮」（`after` 會按此刻的梗概重記，所以複製不走它）。**章號變了**（閘道器直接複製成另一個檔名）
   *   就刪掉：那是另一章了。
   * - 作者自己定的（標題、目標字數、`status: done`、預檢與衝突檢查的放行）與七節、「設定」一節原樣留著。
   * - 沒有 frontmatter 的手寫細綱不補（第 18a 條）。
   */
  async afterCopy(ctx: HandlerCtx, from: string) {
    const abs = ctx.project.pathOf(ctx.rel);
    const raw = await readTextIfExists(abs).catch(() => undefined);
    if (raw === undefined) {
      return [];
    }
    const sameNo =
      parsePlotFileName(path.posix.basename(from))?.no === parsePlotFileName(path.posix.basename(ctx.rel))?.no;
    const patch: Record<string, undefined> = { writtenFrom: undefined, sourceHash: undefined, cast: undefined };
    if (!sameNo) {
      patch.upstreamHash = undefined;
    }
    // 一個要去掉的鍵都沒有（手寫的、沒寫過的計劃）就一個位元組不碰：`rewriteFrontmatter` 會把整段 frontmatter 重新排一遍。
    const keys = Object.keys(parseMarkdown(raw).frontmatter);
    const dropped = Object.keys(patch).filter((key) => keys.includes(key));
    if (dropped.length === 0) {
      return [];
    }
    const next = rewriteFrontmatter(raw, patch);
    if (next === undefined || next === raw) {
      return [];
    }
    await fs.writeFile(abs, next, 'utf8');
    ctx.project.invalidate();
    return [`細綱副本 ${ctx.rel} 去掉了 ${dropped.join(' / ')}（副本沒寫過、沒同步過）`];
  },
};

/**
 * 定稿反向更新之後的細綱全文。
 *
 * - **七節整體換成更新後的那一版**（作者自加的小節不留——舊版整份進了回收站）。
 * - frontmatter 保留 `no` / `title` / `targetWords` / `status` / `preflightOk` / `factCheckOk`：那些是作者定的，定稿不該動。
 * - `upstreamHash` 記過的刷成**新梗概**的指紋：梗概照正文改了（它也是大綱裡這一章那一條），這一份與自己的梗概是對齊的，
 *   不該一定稿就掛 ⟳；沒記過的（手寫的、空殼）照舊不記（第 18a 條）。
 * - 寫入 `sourceHash`（正文的 contentHash）與 `cast`（實際出場），並把 **`writtenFrom` 刷成更新之後的
 *   內容指紋**：不刷的話，定稿剛改完細綱，正文立刻掛 ⟳（「細綱在正文之後改過」）；刷了之後，作者
 *   定稿後再改細綱，正文才掛 ⟳，提醒它可能沒跟上（作者定案）。
 *
 * 還沒有細綱的章（拆書匯入、作者手寫的正文）落一份新的：標題取章節的（回落標題不算），其餘為空。
 * 指紋按**讀回來的樣子**算（佔位文字讀回來是空串），與流水線判髒時同一個口徑。
 */
export function renderFinalizedPlot(input: {
  rel: string;
  no: number;
  title: string;
  current?: Plot;
  sections: PlotSections;
  cast: SummaryCast[];
  sourceHash: string;
  lore?: LoreLine[];
}): string {
  const { current } = input;
  const plot: WritablePlot = {
    no: current?.no ?? input.no,
    title: current ? current.title : input.title,
    targetWords: current?.targetWords,
    upstreamHash: current?.upstreamHash ? plotSynopsisHash(input.sections.梗概) : '',
    done: current?.done ?? false,
    preflightOk: current?.preflightOk,
    factCheckOk: current?.factCheckOk,
    sourceHash: input.sourceHash,
    cast: input.cast,
    sections: input.sections,
    // 「設定」一節：定稿記下的實際出現；沒給（老呼叫）就沿用磁碟那份。
    lore: input.lore ?? current?.lore,
  };
  const writtenFrom = plotContentHash(parsePlotFile(renderPlotFile(plot), input.rel));
  return renderPlotFile({ ...plot, writtenFrom });
}

/**
 * 把上游指紋記進這份產物的 frontmatter。返回 `side` 說明（沒記就是空陣列）。
 *
 * **兩種情況不記**：
 * - 檔案沒有 frontmatter（作者手寫的）——補一個憑空的指紋等於憑空標髒
 * - 算出來的指紋是空串（梗概還空著）——同上
 */
async function recordUpstream(
  ctx: HandlerCtx,
  text: string,
  upstream: string,
  label: string
): Promise<string[]> {
  if (!upstream) {
    return [];
  }
  const next = rewriteFrontmatter(text, { upstreamHash: upstream });
  if (next === undefined) {
    // 手寫的產物：沒有 frontmatter，就沒有這條鏈。不給它補一個。
    return [];
  }
  if (next === text) {
    return [];
  }
  await fs.writeFile(ctx.project.pathOf(ctx.rel), next, 'utf8');
  ctx.project.invalidate();
  return [`記下${label} ${upstream}`];
}

/** 磁碟上那份細綱的解析結果；沒有就 undefined。零信任地讀，絕不拋。 */
export async function readPlotAt(project: NovelProject, rel: string) {
  try {
    const raw = await readTextIfExists(project.pathOf(rel));
    return raw === undefined ? undefined : parsePlotFile(raw, rel);
  } catch {
    return undefined;
  }
}
