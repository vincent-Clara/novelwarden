/**
 * 全書替換（獨立版「編輯 → 全書查詢替換…」→「預覽替換」→「替換所選」）：把預覽裡勾著的那幾處，經閘道器逐份寫下去。
 * 查詢與預覽在 `views/bookFind.ts`（只讀），這裡只寫。
 *
 * ## 一份檔案怎麼寫（順序不能換）
 *
 * 1. **編輯器裡有未儲存修改的跳過**（前端隨請求帶來 `dirty`）：拿磁碟上的內容替換完寫下去，編輯區那份未儲存的修改要麼
 *    被衝突條攔住、要麼被作者一儲存就蓋掉替換——兩頭都不對。讓作者先儲存或放棄，再換一次。
 * 2. **樂觀鎖**：讀磁碟上此刻那一份，hash 與預覽時讀到的（`file.hash`）對不上就跳過——預覽之後它被改過，不拿預覽時的
 *    內容替換完蓋上去（第 3 條）。寫的時候再帶一次基線（`baseHash`），讀與寫之間又被改過，閘道器照樣拒。
 * 3. **勾著的那幾處在磁碟上那一份裡逐處核對**（與預覽同一個口徑：`model/bookFind.ts` 的 `fileHits`，護住的字不算），
 *    再用 `textFind.replaceSelectedIn` 只換這幾處——`$1` 在原文裡逐處展開。
 * 4. **先強制存一版歷史**（`snapshotNow`，跳過節流，與「恢復歷史版本前強制存一版」同一個做法）：存檔點（見下）存不下不擋替換，
 *    兜底的退路是每份檔案在「歷史」裡的替換前那一版。存不下（還不是小說工程、超過 2 MB、出錯）就**不換這一份**，說出來。
 * 5. **經閘道器寫**：`workspace.write`，`mode: 'overwrite'`、`review: false`（預覽本身就是審閱，第 19 條：落盤前人看過了，
 *    閘道器不再彈第二次覆蓋審閱）、帶 `baseHash`。守衛照過、種類的記賬照做（細綱照常記 `upstreamHash`）、覆蓋前的那一版
 *    閘道器自己也會再試著存（與剛存的一樣，不重複存）。章節的寫後記賬（重算 manifest）延到最後做一次（`deferAfter`）。
 *
 * 寫的順序按範圍：其他創作檔案 → 細綱 → 正文 → 草稿 → 角色卡 → 設定。情節大綱不單列：它是各章細綱梗概的彙總，
 * 沒有檔案，換細綱就換了它。
 *
 * 逐份寫之前（有要換的才）先存一個存檔點（`features/checkpoint.ts`）：整本退得回替換之前。
 *
 * ## 指紋鏈（第 18 條，⚑）
 *
 * 替換隻是換字，**不該改變任何一章的新鮮度判斷**——除了一種情況：同一次替換裡，一章的細綱與正文**都**改了（「把林晚全書
 * 改成林婉」），改之前這一環對得上，那麼改之後它們仍是同一次替換的兩頭，指紋跟著重新整理：
 *
 * - `writtenFrom`（正文據以寫成的細綱指紋）刷成替換之後的細綱指紋——不然幾百章的正文一起掛 ⟳，全是誤報；
 * - 定稿過的章，`sourceHash`（定稿時正文的指紋）刷成替換之後的正文指紋——不然幾百章一起退回「待定稿」，主按鈕推著作者
 *   把整本書重新定稿一遍（第 4、20 條）。
 *
 * 其餘照常、而且照實說出來（彙總裡列章）：**只改了細綱**、正文沒跟著改（正文不在範圍裡、沒有這個詞、被勾掉、未儲存跳過了）——
 * 正文掛 ⟳，那是對的：計劃變了，正文可能跟不上；**只改了正文**、細綱沒跟著改的定稿過的章——回到「待定稿」，定稿那份
 * 細綱還說著舊的。改之前就已經對不上的（本來就掛著 ⟳、本來就待定稿）不刷——那不是這次替換造成的。
 *
 * 細綱自己的上游（`upstreamHash`，這一章梗概的指紋——梗概就是大綱裡這一章那一條）同一個原則：閘道器寫細綱時總是記下此刻
 * 梗概的指紋（「誰寫都記」），這裡把它退回替換之前的判斷——本來掛著 ⟳ 的照舊掛（恢復原來那個指紋），本來沒記過的照舊不記
 * （第 18a 條：手寫的不進鏈）；本來對得上的，就是閘道器剛記的那一個（梗概與其餘幾節在同一份檔案裡一起換了，正好對上）。
 *
 * 角色卡「當前狀態」的 `stateHash`、設定條目的 `bodyHash` **不刷**（⚑）：替換就是作者的改動，下次定稿 / 整合時機器照規矩
 * 把它們當作「作者改過」——不直接覆蓋、先對比（第 19、27 條）。
 *
 * ## 不做的事
 *
 * 不改檔名、不搬檔案（角色卡的名字換了，`林晚.md` 還叫 `林晚.md`——認人看的是卡裡的名字與別名，彙總裡提一句）；
 * 跨檔案的一步撤銷不在這裡（整本退回走存檔點，每份檔案的歷史版本兜底）；派生資料（工程樹、出場索引、設定名錄）
 * 不在這裡算——它們都從磁碟現算，控制器替換完照常 `pushState`。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { scoped } from '../runtime/logger';
import { hash } from '../model/fs';
import { decodeFileText } from '../model/importText';
import { asArray, asString, extractH1, parseMarkdown } from '../model/markdown';
import { NovelProject } from '../model/project';
import { Plot, isPlotUpstreamStale, parsePlotFile, plotContentHash } from '../model/plotFile';
import { BookFindScope, isBookFindScope } from '../model/bookFindScope';
import { fileHits } from '../model/bookFind';
import { compileSearch, replaceSelectedIn } from '../model/textFind';
import { Workspace, kindOfPath, normalizeRel } from '../workspace';
import type { ArtifactKind } from '../workspace';
import { WsConflictError, WsError, guardRead } from '../workspace/guard';
import { snapshotNow } from '../workspace/history';
import { bookFileLabel, clip, scopeOfKind } from '../views/bookFind';
import { checkpointBefore } from './checkpoint';
import type {
  BookReplaceDone,
  BookReplaceRenamedCard,
  BookReplaceRequest,
  BookReplaceSkipReason,
  BookReplaceSkipped,
  BookReplaceSummary,
} from '../protocol';

const log = scoped('全書替換');

/** 核對過、算好了新內容、等著寫的一份。 */
interface Prepared {
  rel: string;
  label: string;
  kind: ArtifactKind;
  scope: BookFindScope;
  text: string;
  next: string;
  /** 閘道器樂觀鎖的基線：與 `guardWrite` 同一個讀法（按 UTF-8 讀出來的那一份）。 */
  lockHash: string;
  count: number;
}

/** 一份細綱在替換之前的指紋鏈判斷（第 18 條）。 */
interface ChainBefore {
  plot: Plot;
  /** 映象它的那一章正文（有正文才有）。 */
  chapterRel?: string;
  chapterLabel?: string;
  /** 大綱 → 細綱：沒記過 / 對得上 / 對不上，以及原來記的那個。 */
  upstream: 'none' | 'fresh' | 'stale';
  /** 細綱 → 正文（`writtenFrom`）：有正文、記過、對得上。 */
  writtenFresh: boolean;
  /** 正文 → 定稿（`sourceHash`）：有正文、定稿過、對得上。 */
  sourceFresh: boolean;
}

const MESSAGE: Record<Exclude<BookReplaceSkipReason, 'noHistory' | 'error'>, string> = {
  dirty: '編輯器裡有未儲存的修改：先儲存（或放棄修改），再替換一次。',
  changed: '預覽之後這份檔案改過了（編輯器裡存過、或別處改過）：沒有拿預覽時的內容蓋上去，重新預覽一次。',
  gone: '磁碟上已經沒有這份檔案了（被刪或改了名）。',
  mismatch: '勾著的那幾處在這份檔案裡對不上了：重新預覽一次。',
  unchanged: '換完與原來一字不差，沒有寫。',
  outOfScope: '不在這次全書替換勾著的範圍裡，沒有動。',
};

export async function replaceInBook(project: NovelProject, req: BookReplaceRequest): Promise<BookReplaceSummary> {
  const summary: BookReplaceSummary = {
    files: 0,
    hits: 0,
    replaced: [],
    skipped: [],
    chainKept: [],
    plotOnly: [],
    bodyOnly: [],
    renamedCards: [],
  };
  const query = typeof req.query === 'string' ? req.query : '';
  const replacement = typeof req.replacement === 'string' ? req.replacement : '';
  const opts = { caseSensitive: req.caseSensitive === true, regex: req.regex === true };
  const compiled = compileSearch(query, opts);
  if (!compiled) {
    return { ...summary, error: '查詢的內容是空的，沒有替換。' };
  }
  if (!compiled.ok) {
    return { ...summary, error: `正則寫錯了，沒有替換（${compiled.error}）。` };
  }
  const scopes = new Set((Array.isArray(req.scopes) ? req.scopes : []).filter(isBookFindScope));
  const dirty = new Set(
    (Array.isArray(req.dirty) ? req.dirty : []).map((p) => (typeof p === 'string' ? normalizeRel(p) : undefined)).filter(Boolean)
  );
  const skip = (rel: string, reason: BookReplaceSkipReason, message?: string) => {
    const s: BookReplaceSkipped = {
      path: rel,
      label: bookFileLabel(project, rel),
      reason,
      message: message ?? MESSAGE[reason as keyof typeof MESSAGE] ?? '',
    };
    summary.skipped.push(s);
  };

  // ---- 1. 逐份核對、算好新內容（只讀）
  project.invalidate();
  const prepared: Prepared[] = [];
  const seen = new Set<string>();
  for (const file of Array.isArray(req.files) ? req.files : []) {
    const rel = typeof file?.path === 'string' ? normalizeRel(file.path) : undefined;
    if (!rel || seen.has(rel)) {
      continue;
    }
    seen.add(rel);
    const picks = (Array.isArray(file.hits) ? file.hits : []).filter(
      (h) => Number.isInteger(h?.start) && Number.isInteger(h?.end) && h.end > h.start
    );
    if (picks.length === 0) {
      continue;
    }
    const kind = kindOfPath(project, rel).kind;
    const scope = scopeOfKind(kind);
    if (!scope || !scopes.has(scope)) {
      skip(rel, 'outOfScope');
      continue;
    }
    if (dirty.has(rel)) {
      skip(rel, 'dirty');
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(await guardRead(project, rel));
    } catch (err) {
      if (err instanceof WsError && (err.code === 'notFound' || err.code === 'notFile')) {
        skip(rel, 'gone');
      } else {
        skip(rel, 'error', `讀不了：${describe(err)}`);
      }
      continue;
    }
    const text = decodeFileText(bytes);
    if (hash(text) !== file.hash) {
      skip(rel, 'changed');
      continue;
    }
    const open = new Set(fileHits(text, kind, query, opts).matches.map((m) => `${m.start}:${m.end}`));
    if (!picks.every((h) => open.has(`${h.start}:${h.end}`))) {
      skip(rel, 'mismatch');
      continue;
    }
    const plan = replaceSelectedIn(text, picks, query, replacement, opts);
    if (!plan || plan.missed.length > 0) {
      skip(rel, 'mismatch');
      continue;
    }
    if (plan.text === text) {
      skip(rel, 'unchanged');
      continue;
    }
    prepared.push({
      rel,
      label: bookFileLabel(project, rel),
      kind,
      scope,
      text,
      next: plan.text,
      lockHash: hash(bytes.toString('utf8')),
      count: plan.replaced.length,
    });
  }

  // ---- 2. 替換之前的指紋鏈判斷（第 18 條）
  const chapters = await project.listChapters();
  const chapterByPlot = new Map<string, { rel: string; contentHash: string }>();
  for (const c of chapters) {
    const mirror = project.plotMirrorOf(c.relPath);
    if (mirror && !chapterByPlot.has(mirror)) {
      chapterByPlot.set(mirror, { rel: c.relPath, contentHash: c.contentHash });
    }
  }
  const chainBefore = new Map<string, ChainBefore>();
  for (const p of prepared.filter((x) => x.kind === 'plot')) {
    const plot = parsePlotFile(p.text, p.rel);
    const chapter = chapterByPlot.get(p.rel);
    chainBefore.set(p.rel, {
      plot,
      chapterRel: chapter?.rel,
      chapterLabel: chapter ? bookFileLabel(project, chapter.rel) : undefined,
      upstream: !plot.upstreamHash ? 'none' : isPlotUpstreamStale(plot) ? 'stale' : 'fresh',
      writtenFresh: !!chapter && !!plot.writtenFrom && plot.writtenFrom === plotContentHash(plot),
      sourceFresh: !!chapter && !!plot.sourceHash && plot.sourceHash === chapter.contentHash,
    });
  }
  // 要換的正文：替換之前它映象的那份細綱定稿過、對得上它沒有（細綱也在這一次裡的，上面已經算過；沒在的這裡讀一次）。
  // 寫完之後正文換了、細綱沒換（不在這一次裡，或者在、卻被跳過了）的，就是「只改了正文」。
  const contentHashOf = new Map(chapters.map((c) => [c.relPath, c.contentHash]));
  const finalizedBodies = new Map<string, { mirror: string; fresh: boolean }>();
  for (const p of prepared.filter((x) => x.kind === 'chapter')) {
    const mirror = project.plotMirrorOf(p.rel);
    if (!mirror) {
      continue;
    }
    const known = chainBefore.get(mirror);
    if (known) {
      finalizedBodies.set(p.rel, { mirror, fresh: known.sourceFresh });
      continue;
    }
    const plot = await project.readPlot(mirror);
    const bodyHash = contentHashOf.get(p.rel);
    finalizedBodies.set(p.rel, { mirror, fresh: !!plot?.sourceHash && !!bodyHash && plot.sourceHash === bodyHash });
  }

  // ---- 3. 逐份存一版歷史、經閘道器寫
  if (prepared.length > 0) {
    // 先存一個存檔點（features/checkpoint.ts）：一次改很多份，整本退得回去（每份的歷史版本照存）。
    await checkpointBefore(project, `全書替換之前（「${clip(query, 12)}」→「${clip(replacement, 12)}」，${prepared.length} 份）`);
  }
  const ws = new Workspace(project);
  const written = new Set<string>();
  let wroteChapter = false;
  for (const p of [...prepared].sort((a, b) => WRITE_RANK[a.scope] - WRITE_RANK[b.scope])) {
    const snap = await snapshotNow(project, p.rel);
    if (!snap.saved && snap.skipped !== 'same') {
      if (snap.skipped === 'missing') {
        skip(p.rel, 'gone');
      } else {
        skip(p.rel, 'noHistory', noHistoryMessage(snap.skipped, snap.error));
      }
      continue;
    }
    try {
      await ws.write(p.rel, { text: p.next }, {
        mode: 'overwrite',
        review: false,
        baseHash: p.lockHash,
        deferAfter: p.kind === 'chapter',
      });
    } catch (err) {
      if (err instanceof WsConflictError) {
        skip(p.rel, 'changed');
      } else if (err instanceof WsError && (err.code === 'notFound' || err.code === 'notFile')) {
        skip(p.rel, 'gone');
      } else {
        skip(p.rel, 'error', `沒寫成：${describe(err)}`);
      }
      continue;
    }
    written.add(p.rel);
    wroteChapter ||= p.kind === 'chapter';
    const done: BookReplaceDone = { path: p.rel, label: p.label, count: p.count };
    summary.replaced.push(done);
    summary.files++;
    summary.hits += p.count;
    if (p.kind === 'character') {
      const renamed = renamedCard(p);
      if (renamed) {
        summary.renamedCards.push(renamed);
      }
    }
  }
  if (wroteChapter) {
    // 章節的寫後記賬（重算 manifest）延到這裡做一次：逐章做是 O(n²) 次讀盤。
    await project.syncManifest();
  }

  // ---- 4. 指紋鏈收尾（第 18 條）
  project.invalidate();
  const chaptersAfter = new Map((await project.listChapters()).map((c) => [c.relPath, c.contentHash]));
  for (const [plotRel, before] of chainBefore) {
    if (!written.has(plotRel)) {
      continue;
    }
    const after = await project.readPlot(plotRel);
    if (!after) {
      continue;
    }
    const patch: { upstreamHash?: string; writtenFrom?: string; sourceHash?: string } = {};
    // 梗概 → 其餘幾節：退回替換之前的判斷（閘道器寫細綱時總是記下此刻梗概的指紋）。
    if (before.upstream === 'stale' && after.upstreamHash !== before.plot.upstreamHash) {
      patch.upstreamHash = before.plot.upstreamHash;
    } else if (before.upstream === 'none' && after.upstreamHash) {
      patch.upstreamHash = undefined;
    }
    if (before.chapterRel && written.has(before.chapterRel)) {
      // 細綱與正文這一次都改了：原本對得上的那一環刷成替換之後的。
      let kept = false;
      if (before.writtenFresh) {
        patch.writtenFrom = plotContentHash(after);
        kept = true;
      }
      const bodyHash = chaptersAfter.get(before.chapterRel);
      if (before.sourceFresh && bodyHash) {
        patch.sourceHash = bodyHash;
        kept = true;
      }
      if (kept && before.chapterLabel) {
        summary.chainKept.push(before.chapterLabel);
      }
    } else if (before.chapterRel && before.writtenFresh && before.chapterLabel) {
      summary.plotOnly.push(before.chapterLabel);
    }
    if (Object.keys(patch).length > 0) {
      await ws.restampPlotChain(plotRel, patch);
    }
  }
  for (const [chapterRel, { mirror, fresh }] of finalizedBodies) {
    if (fresh && written.has(chapterRel) && !written.has(mirror)) {
      summary.bodyOnly.push(bookFileLabel(project, chapterRel));
    }
  }
  log.info(
    `全書替換「${clip(query)}」→「${clip(replacement)}」`,
    [
      `${summary.files} 個檔案 ${summary.hits} 處`,
      summary.skipped.length ? `跳過 ${summary.skipped.length} 份：${summary.skipped.map((s) => `${s.path}（${s.reason}）`).join('、')}` : '',
      summary.chainKept.length ? `細綱與正文一起改了、指紋跟著重新整理：${summary.chainKept.join('、')}` : '',
      summary.plotOnly.length ? `只改了細綱（正文掛 ⟳）：${summary.plotOnly.join('、')}` : '',
      summary.bodyOnly.length ? `只改了正文（回到待同步）：${summary.bodyOnly.join('、')}` : '',
    ]
      .filter(Boolean)
      .join('｜')
  );
  return summary;
}

/** 寫的順序：其他創作檔案（大綱）在細綱之前，見檔案頭。按範圍寫成一張表——加了新範圍忘了排，編譯不過。 */
const WRITE_RANK: Record<BookFindScope, number> = { doc: 0, plot: 1, chapter: 2, draft: 3, character: 4, lore: 5 };

function noHistoryMessage(reason: string | undefined, error: string | undefined): string {
  if (reason === 'notTracked') {
    return '這個目錄還不是小說工程（沒有 .novelwarden/），存不了歷史版本——這次替換的退路就是歷史版本，所以沒有替換。';
  }
  if (reason === 'tooLarge') {
    return '超過 2 MB，存不了歷史版本——沒有替換。';
  }
  return `沒能先存一版歷史（${error ?? '原因不明'}）——這次替換的退路就是歷史版本，所以沒有替換。`;
}

/** 角色卡認人用的名字（與 `NovelProject.listCharacters` 同一個取法）與別名。 */
function cardIdentity(text: string, rel: string): { name: string; aliases: string[] } {
  const { frontmatter, body } = parseMarkdown(text);
  return {
    name: asString(frontmatter.name) || extractH1(body) || path.posix.basename(rel).replace(/\.md$/i, ''),
    aliases: asArray(frontmatter.aliases),
  };
}

/** 角色卡的名字或別名換了：彙總裡提一句檔名沒跟著改。 */
function renamedCard(p: Prepared): BookReplaceRenamedCard | undefined {
  const before = cardIdentity(p.text, p.rel);
  const after = cardIdentity(p.next, p.rel);
  const nameChanged = before.name !== after.name;
  if (!nameChanged && before.aliases.join('\n') === after.aliases.join('\n')) {
    return undefined;
  }
  return { path: p.rel, label: p.label, name: after.name, nameChanged };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
