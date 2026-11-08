/**
 * `chapter` handler：正文。
 *
 * 正文直接落在 `chapters/` 裡（一章一綱，沒有中間層），上游指紋記在**這一章細綱**的
 * `writtenFrom` 上（正文落盤那一步調 `Workspace.recordWrittenFrom`），這裡不記賬。這一層管的是兩件
 * 伴生的事：
 *
 * 1. **草稿與細綱跟隨**（原 `fileOps.carryDraft`）：兩樣都按章節在 `chapters/` 之下的
 *    相對路徑映象（草稿在 `drafts/`，細綱在 `.novelwarden/summaries/`），章節路徑一變歸屬路徑就跟著變。
 *    不搬的話舊位置的東西成了孤兒，新位置又讀不到，**而介面上一切正常**。
 * 2. **manifest 同步**：章節列表與字數索引跟著重新整理。
 *
 * **刪章節不刪草稿**（AGENTS 第 10 條）——那是作者另寫的東西，刪正文不代表
 * 要連草稿一起丟。確認框裡會說一句，否則「刪了這一章」之後草稿還在，
 * 下次看見會以為鬧鬼。細綱同理不跟著刪：正文沒了，它退回這一章的計劃。所以 `onRemove`
 * 只重算 manifest，什麼伴生都不搬。
 *
 * 只有經閘道器的改名、移動才搬得動伴生：作者在外面直接給正文改名，細綱留在原處，那就是一章新的。
 *
 * 伴生的草稿、細綱搬過去之後，它們的歷史版本（`.novelwarden/history/` 下的快照目錄）也跟著挪（`history.ts` 的
 * `moveHistory`）；正文自己的快照由 `Workspace.move` 挪。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getHost } from '../../host';
import { scoped } from '../../runtime/logger';
import { NovelProject } from '../../model/project';
import { moveHistory } from '../history';
import { Handler, HandlerCtx } from './types';

const log = scoped('工作區');

export const chapterHandler: Handler = {
  /** 章節沒有上游指紋，只同步 manifest。 */
  async after(ctx: HandlerCtx) {
    await ctx.project.syncManifest();
    return [];
  },

  async companions(ctx: HandlerCtx, from: string, to: string) {
    // 目錄也要搬：移動 `chapters/卷一/` 時 `drafts/卷一/`、`summaries/卷一/` 都得跟著走。
    const isDir = ctx.path.kind === 'other';
    const side = [...(await carryDraft(ctx.project, from, to, isDir)), ...(await carryPlot(ctx.project, from, to, isDir))];
    await ctx.project.syncManifest();
    return side;
  },

  /**
   * 刪章節：**草稿不跟著刪**（第 10 條）。manifest 要重算——那一行沒了。
   */
  async onRemove(ctx: HandlerCtx) {
    await ctx.project.syncManifest();
    return [];
  },
};

/**
 * 章節改名/移動後，把它的草稿一併搬過去。
 *
 * 不搬的話草稿就成了孤兒：下次點「開啟草稿」會在新位置靜默新建一個空檔案，
 * 之前寫的東西還躺在舊路徑下，沒人告訴作者。
 *
 * 目標位置已有同名的東西時**不覆蓋**：兩份都留著，提示作者自己去合
 * （AGENTS 第 3 條）。章節被移出 `chapters/` 時新映象路徑推導不出，
 * 草稿留在原處——**要說出來**，不說的話作者會以為它跟著走了。
 */
export async function carryDraft(
  project: NovelProject,
  fromRel: string,
  toRel: string,
  isDir = false
): Promise<string[]> {
  return carryMirror(project.draftRelPathFor(fromRel), project.draftRelPathFor(toRel), '草稿', isDir, project);
}

/**
 * 章節改名/移動後，把它的細綱一併搬過去（細綱映象正文的相對路徑，`NovelProject.plotMirrorOf`）。
 *
 * 不搬的話這一章在工程頁上立刻變成「還沒有細綱」，排好的計劃與定稿的檔案都還躺在舊路徑下。
 * 規矩與草稿一樣：目標已有就不覆蓋、移出 `chapters/` 就留在原處，兩種都說出來。
 */
export async function carryPlot(
  project: NovelProject,
  fromRel: string,
  toRel: string,
  isDir = false
): Promise<string[]> {
  const side = await carryMirror(project.plotMirrorOf(fromRel, isDir), project.plotMirrorOf(toRel, isDir), '細綱', isDir, project);
  if (side.length > 0) {
    project.invalidate();
  }
  return side;
}

/** 草稿與細綱共用的搬法：`from` / `to` 是兩邊的映象路徑（推導不出時 undefined）。 */
async function carryMirror(
  from: string | undefined,
  to: string | undefined,
  what: string,
  isDir: boolean,
  project: NovelProject
): Promise<string[]> {
  if (!from) {
    return [];
  }
  const fromAbs = project.pathOf(from);
  if (!(await pathExists(fromAbs))) {
    return [];
  }
  if (!to) {
    log.warn(`章節被移出 chapters/，${what}留在原處`, `${what}仍在 ${from}`);
    return [`${what}留在 ${from}（新位置推導不出映象路徑）`];
  }
  if (from === to) {
    return [];
  }
  const toAbs = project.pathOf(to);
  if (await pathExists(toAbs)) {
    // **不覆蓋**：兩份都留著，提示作者自己去合（AGENTS 第 3 條）。
    // 只打日誌不夠——日誌要使用者主動去翻，而這一刻他正盯著工程頁。
    log.warn(`新位置已有${what}，舊${what}未動`, `目標 ${to}｜舊${what}仍在 ${from}`);
    getHost().toast(`新位置已有${what}${isDir ? '目錄' : ''}：${to}，舊${what}留在 ${from} 未動。`, 'error');
    return [`新位置已有${what} ${to}，舊${what}留在 ${from} 未動`];
  }
  await fs.mkdir(path.dirname(toAbs), { recursive: true });
  await fs.rename(fromAbs, toAbs);
  log.info(`${what}已跟隨移動`, `${from} → ${to}`);
  // 伴生搬家不經 `Workspace.move`，它們的快照在這裡跟上（絕不拋）。沒搬動的（目標已有、移出了 chapters/）快照也留在原處。
  return [`${what} ${from} → ${to}`, ...(await moveHistory(project, from, to))];
}

async function pathExists(abs: string): Promise<boolean> {
  try {
    await fs.stat(abs);
    return true;
  } catch {
    return false;
  }
}
