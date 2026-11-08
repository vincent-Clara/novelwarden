import { traditionalLabel } from '../model/labels';
/**
 * Workspace —— 工程的**唯一讀寫閘道器**。
 *
 * ## 為什麼要有它
 *
 * 寫盤從前散在六處（`model/project.ts`、`features/creation.ts` 的
 * `acceptArtifact`、`files/fileOps.ts`、`files/fileEditing.ts`、
 * `files/projectFiles.ts`、拆章），**每處各帶一部分保護，誰也不認識誰**。
 * 既有落盤路徑揹著一批不變數，繞過任何一條都會安靜地損壞工程：
 *
 * - 細綱檔名由「章號 + 標題」決定，改標題要清掉舊檔名
 * - 寫細綱要記 `upstreamHash`、寫正文要在細綱上記 `writtenFrom`，漏了新鮮度鏈就斷
 * - 刪除一律進 `.trash/`；同名目標一律報錯退出
 *
 * 所以 `write` 不是「往這個路徑寫位元組」，而是「按這個路徑**應有的種類**寫一份
 * 合法產物」——種類判定（`kind.ts`）、守衛（`guard.ts`）、渲染/記賬/伴生
 * （`handlers/`）在這一層各做一次。
 *
 * ## 記賬下沉
 *
 * `upstreamHash` 從前**只在採納路徑上記**。作者在內建編輯器裡
 * 改一份細綱，指紋鏈就斷了——那一章從此再也不掛 ⟳。下沉到寫入路徑本身之後，
 * **誰寫都記**。
 *
 * ## 新程式碼不許繞過這裡
 *
 * 不要在別處 `fs.writeFile`。八條守衛（見 `guard.ts`）只在這條路上做，
 * 繞過去等於給自己開一個後門，而後門在介面上看不出來。
 */
import * as fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import { scoped } from '../runtime/logger';
import { decodeFileText } from '../model/importText';
import {
  countWords,
  exists,
  hash,
  pad3,
  readText,
  readTextIfExists,
  sanitizeFileName,
  writeText,
} from '../model/fs';
import { Chapter, SummaryCast } from '../model/types';
import { parseMarkdown, replaceSection, rewriteFrontmatter, stringifyFrontmatter } from '../model/markdown';
import { LoreLine, PLOT_LORE_KEY, renderLoreLines } from '../model/loreFile';
import {
  NewThread,
  ThreadsMark,
  advanceThreadsMark,
  renderThreadFile,
  replacePlannedEvents,
  threadFileName,
  threadsMarkOf,
} from '../model/threadFile';
import { setConfigParagraphStyle } from '../model/settingFile';
import type { ParagraphStyle } from '../model/paragraphFormat';
import { isMarkdownExt, isMarkdownPath, parseChapterFileName } from '../model/chapterFile';
import { isFallbackChapterTitle } from '../model/pipeline';
import { endsMidSentence } from '../model/manuscriptCheck';
import {
  NovelProject,
  WritableCharacterCard,
  WritableLoreEntry,
  renderCharacterCard,
  renderLoreEntry,
  trashPathFor,
} from '../model/project';
import {
  PlotSections,
  PreflightOk,
  WritablePlot,
  emptyPlotSections,
  parsePlotFile,
  plotFileName,
  renderPlotFile,
  renderPreflightOk,
} from '../model/plotFile';
import { isOutlineFilled, parseOutline, planOutlineSplit, renderOutlineDoc } from '../model/outlineFile';
import { Artifact } from '../features/artifact';
import {
  ArtifactKind,
  PathKind,
  kindOfPath,
  normalizeRel,
} from './kind';
import {
  MAX_EDITABLE_BYTES,
  WsConflictError,
  WsError,
  guardCopySource,
  guardCreate,
  guardMutate,
  guardRead,
  guardWrite,
  isInternalPath,
  reviewOverwrite,
} from './guard';
import { Handler, HandlerCtx, handlerFor } from './handlers';
import { renderFinalizedPlot } from './handlers/plot';
import { moveHistory, snapshotBeforeWrite, snapshotNow } from './history';
import { SearchOptions, SearchResult, search } from './search';

const log = scoped('工作區');

export interface WsEntry {
  name: string;
  rel: string;
  type: 'file' | 'dir';
  kind: ArtifactKind;
  /** 文字檔案給字數，其餘給位元組數。 */
  words?: number;
  bytes: number;
}

export interface WsFile {
  rel: string;
  text: string;
  hash: string;
  bytes: number;
  kind: ArtifactKind;
  /** 按 offset/limit 截過。**必須說出來**（AGENTS 第 2 條：不靜默截斷）。 */
  truncated?: { from: number; total: number };
}

export type WriteInput = { text: string } | { artifact: Artifact };

export interface WriteOptions {
  /** 預設 `create`（同名報錯）。 */
  mode?: 'create' | 'overwrite' | 'append';
  /**
   * 覆蓋前是否審閱。預設 true。
   *
   * **agent 路徑不允許傳 false**——「不靜默覆蓋」是產品承諾，不是偏好設定
   * （AGENTS 第 3 / 19 條）。留這個開關只給**已經有自己那道閘**的呼叫方：批次路徑（它跳過已有
   * 產物，根本走不到覆蓋）、內建編輯器（樂觀鎖）、`edit` 與 `setParagraphStyle`（改的就是作者點的那幾個字），
   * 以及功能層自己問過作者的覆蓋（更新角色卡 / 提取角色的審閱採納、批次更新時的「全部直接採納」、章節改名時
   * 同步正文的 `# 標題` 行）——同一件事不問第二次。傳了 false 照樣過守衛、照樣存歷史版本。
   */
  review?: boolean;
  /** 樂觀鎖基線。給了就比對，磁碟變過報衝突。 */
  baseHash?: string;
  /** 覆蓋審閱框裡顯示的名字，如「第 12 章的細綱」。 */
  what?: string;
  /**
   * 不跑寫後的記賬與伴生（`handler.after`），由呼叫方在一批寫完之後補上。**只給一次寫好幾章的呼叫方用**——
   * {@link Workspace.createChapters}（匯入原稿）與全書替換（`features/bookReplace.ts`）：章節的 after 只是重算
   * manifest，逐章重算是 O(n²) 次讀盤；**只對章節生效**，別的種類的 after 記的是指紋，不能延後。
   */
  deferAfter?: boolean;
}

export interface WriteResult {
  rel: string;
  skipped?: boolean;
  message: string;
  /** 這次寫入連帶做了什麼（記了哪個 hash、搬了哪個伴生目錄）。進日誌用。 */
  side?: string[];
}

export interface TextEdit {
  old: string;
  new: string;
  /** 命中多處時是否全替換。預設 false——不唯一就報錯，不猜作者要改哪一處。 */
  all?: boolean;
}

export class Workspace {
  constructor(private readonly project: NovelProject) {}

  // ---------------------------------------------------------------- list

  /**
   * 列一個目錄的直接子項（不遞迴）。預設列工程根。
   *
   * **不拋**：越界、不存在、讀不動都給空陣列。這是常駐介面的取數路徑，
   * 作者在別處刪掉一個正展開的目錄時整頁不該跟著炸。
   */
  async list(relDir?: string): Promise<WsEntry[]> {
    const rel = (relDir ?? '').trim() === '' ? '' : normalizeRel(relDir!);
    if (rel === undefined) {
      return [];
    }
    const abs = rel === '' ? this.project.root : this.project.pathOf(rel);

    let dirents: import('node:fs').Dirent[];
    try {
      dirents = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return [];
    }

    const out: WsEntry[] = [];
    for (const dirent of dirents) {
      const childRel = rel === '' ? dirent.name : `${rel}/${dirent.name}`;
      if (isInternalPath(this.project, childRel)) {
        continue;
      }
      const childAbs = path.join(abs, dirent.name);
      let isDir = dirent.isDirectory();
      let bytes = 0;
      try {
        const stat = await fs.stat(childAbs);
        isDir = stat.isDirectory();
        bytes = stat.isFile() ? stat.size : 0;
      } catch {
        if (!isDir && !dirent.isFile()) {
          continue;
        }
      }
      const kind = kindOfPath(this.project, childRel).kind;
      out.push({
        name: dirent.name,
        rel: childRel,
        type: isDir ? 'dir' : 'file',
        kind: isDir ? 'other' : kind,
        // 大檔案不為了報個字數去整份讀盤——那是全量遍歷時的幾百次多餘 I/O。
        words: !isDir && bytes <= MAX_EDITABLE_BYTES ? await wordsOf(childAbs) : undefined,
        bytes,
      });
    }
    out.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true })));
    return out;
  }

  // ---------------------------------------------------------------- read

  /**
   * 讀一份檔案。
   *
   * `offset` / `limit` 按**行**切。截過必須在 `truncated` 裡說出來——
   * 三期的 agent 工具會把它轉述給模型，模型不知道自己只看了一半的話，
   * 會拿著半份正文去下結論。
   */
  async read(rel: string, opts?: { offset?: number; limit?: number }): Promise<WsFile> {
    let full: string;
    let normalized: string;
    if (this.isOutline(rel)) {
      // 情節大綱沒有檔案：各章細綱梗概的彙總（磁碟上殘留的老 `outline.md` 不讀）。
      normalized = normalizeRel(rel)!;
      full = await this.project.readOutlineDoc();
    } else {
      const abs = await guardRead(this.project, rel);
      normalized = normalizeRel(rel)!;
      full = decodeFileText(await fs.readFile(abs));
    }
    const kind = kindOfPath(this.project, normalized).kind;

    const offset = Math.max(0, Math.trunc(opts?.offset ?? 0));
    const limit = opts?.limit === undefined ? undefined : Math.max(0, Math.trunc(opts.limit));
    if (offset === 0 && limit === undefined) {
      return {
        rel: normalized,
        text: full,
        hash: hash(full),
        bytes: Buffer.byteLength(full, 'utf8'),
        kind,
      };
    }

    const lines = full.split(/\r?\n/);
    const sliced = lines.slice(offset, limit === undefined ? undefined : offset + limit);
    const text = sliced.join('\n');
    const truncated = sliced.length < lines.length ? { from: offset, total: lines.length } : undefined;
    return {
      rel: normalized,
      text,
      // hash 恆是**整份檔案**的 hash：它是樂觀鎖基線，按半份算就永遠對不上。
      hash: hash(full),
      bytes: Buffer.byteLength(text, 'utf8'),
      kind,
      truncated,
    };
  }

  // ---------------------------------------------------------------- write

  /**
   * 寫一份產物。
   *
   * 五步，順序不能換：
   *
   * 1. `kindOfPath` 判種類 → 取 handler
   * 2. handler 定最終落點（場景的檔名由磁碟上那份的標題決定）
   * 3. `guardWrite` 過八條守衛（越界 / 回收站 / 大小 / 同名 / 樂觀鎖）
   * 4. 覆蓋前審閱（`mode: 'overwrite'` 且目標已有不同內容時）
   * 5. 落盤 → handler 記賬與伴生
   */
  async write(rel: string, input: WriteInput, opts: WriteOptions = {}): Promise<WriteResult> {
    const mode = opts.mode ?? 'create';
    const normalized = normalizeRel(rel);
    if (normalized === undefined) {
      throw new WsError('outOfRoot', `路徑超出工程目錄：${rel}`);
    }

    if (this.isOutline(normalized)) {
      return this.writeOutline(input, { ...opts, mode });
    }

    const artifact = 'artifact' in input ? input.artifact : undefined;
    let ctx = this.ctxOf(normalized);
    const handler = handlerFor(ctx.path.kind);

    // 步驟 2：落點最終由 handler 說了算。場景的檔名帶標題，標題在磁碟上。
    if (handler.resolve) {
      const resolved = await handler.resolve(ctx, artifact);
      if (resolved !== normalized) {
        ctx = this.ctxOf(resolved);
      }
    }
    const target = ctx.rel;

    let text = artifact ? await this.render(handler, ctx, artifact) : (input as { text: string }).text;

    const guarded = await guardWrite(this.project, target, {
      mode,
      baseHash: opts.baseHash,
      text: mode === 'append' ? undefined : text,
    });

    // 步驟 4：覆蓋前審閱。**append 不走這一條**——追加不覆蓋任何東西。
    // 獨立版的合併檢視可能交回作者挑過的那一份：寫它，記賬與伴生照常跑在最終文字上。
    if (mode === 'overwrite' && guarded.existed && opts.review !== false) {
      const review = await reviewOverwrite(opts.what ?? target, target, guarded.current ?? '', text);
      if (!review.ok) {
        return { rel: target, skipped: true, message: `沒有改動 ${target}。` };
      }
      text = review.text ?? text;
    }

    const final = mode === 'append' ? appendText(guarded, text, ctx.path.kind === 'chapter') : text;
    if (guarded.existed) {
      // 覆蓋（含追加）之前先把磁碟上的舊內容存一版（history.ts：只管創作產物、有節流）。絕不拋——存不下也照常寫盤。
      await snapshotBeforeWrite(this.project, target, final);
    }
    await writeText(guarded.abs, final);
    this.project.invalidate();

    const side = handler.after && !(opts.deferAfter && ctx.path.kind === 'chapter') ? await handler.after(ctx, final) : [];
    if (side.length > 0) {
      log.debug(`寫入 ${target} 時連帶`, side.join('｜'));
    }
    return { rel: target, message: `已寫入 ${target}`, side };
  }

  // ---------------------------------------------------------------- edit

  /**
   * 定點替換。
   *
   * **要麼全成要麼全不成**：多條編輯裡有一條對不上就整批不落盤。半截狀態
   * （前兩條改了、第三條沒改）比報錯難收拾得多——作者看不出改到哪了。
   *
   * `old` 命中多處且沒給 `all` 時報錯，不猜他要改哪一處。
   */
  async edit(rel: string, edits: TextEdit[]): Promise<WriteResult> {
    let text: string;
    if (this.isOutline(rel)) {
      text = await this.project.readOutlineDoc();
    } else {
      text = await readText(await guardRead(this.project, rel));
    }
    const normalized = normalizeRel(rel)!;
    let replaced = 0;

    for (const edit of edits) {
      const count = countOccurrences(text, edit.old);
      if (count === 0) {
        throw new WsError('notFound', `找不到要替換的內容：${clip(edit.old)}`);
      }
      if (count > 1 && !edit.all) {
        throw new WsError(
          'notUnique',
          `「${clip(edit.old)}」在 ${normalized} 裡出現 ${count} 處，沒有指定 all 就不猜改哪一處。`
        );
      }
      text = edit.all ? text.split(edit.old).join(edit.new) : text.replace(edit.old, edit.new);
      replaced += edit.all ? count : 1;
    }

    // 走 write 而不是直接落盤：記賬與伴生對 edit 一樣要做（作者在編輯器裡
    // 改一份細綱，指紋鏈現在會斷——這一期修的正是它）。
    // review: false 是安全的：edit 本來就是「在這份內容上改幾個字」，
    // 拿它和自己 diff 一遍沒有意義。
    const r = await this.write(normalized, { text }, { mode: 'overwrite', review: false });
    return { ...r, message: `已替換 ${replaced} 處：${normalized}` };
  }

  // ---------------------------------------------------------------- move

  /**
   * 改名/移動。**目標已存在一律拒絕**（第 3 條：不靜默覆蓋）。
   *
   * 伴生搬遷交給 handler：章節帶走草稿與細綱（兩樣都映象正文的路徑，正文一搬就得跟著走）。
   * 歷史版本也跟著走（`history.ts` 的 `moveHistory`）：搬的這一份（或整個目錄）的快照目錄挪到新路徑下，伴生的草稿、
   * 細綱各自的快照由 handler 那邊跟著挪。搬快照失敗只記 warn，不擋搬家。
   */
  async move(from: string, to: string): Promise<WriteResult> {
    const { fromAbs, fromRel, toRel } = await this.guardMove(from, to);

    const ctx = this.ctxOf(fromRel);
    // 目錄不進種類表（`chapters/第一卷` 沒有數字字首），但草稿映象跟著**整棵
    // 子樹**走——移動 `chapters/卷一/` 時 `drafts/卷一/` 得跟著。所以落在
    // 章節根之下的目錄也按章節處理。
    const handler = handlerFor(
      ctx.path.kind === 'other' && this.project.draftRelPathFor(fromRel) ? 'chapter' : ctx.path.kind
    );

    await fs.mkdir(path.dirname(this.project.pathOf(toRel)), { recursive: true });
    await fs.rename(fromAbs, this.project.pathOf(toRel));
    this.project.invalidate();

    // 主檔案已經搬過去了：快照先跟上（絕不拋），伴生那一步出了錯也不會把它們落在舊路徑下。
    const history = await moveHistory(this.project, fromRel, toRel);
    const side = [...history, ...(handler.companions ? await handler.companions(ctx, fromRel, toRel) : [])];
    if (side.length > 0) {
      log.info(`${fromRel} → ${toRel} 時連帶`, side.join('｜'));
    }
    return { rel: toRel, message: `已移動到 ${toRel}`, side };
  }

  /**
   * 搬家之前的預檢，**只讀、不碰磁碟上的任何東西**：與 {@link move} 同一套守衛——來源在、不是固定目錄 / 內部檔案 /
   * 回收站裡的東西；落點在工程內、不在回收站、沒有同名。能搬就正常返回，搬不成拋 `WsError`（與 `move` 拋的同一種）。
   *
   * `plot: true` 再多查一樣：這是一章正文，它映象的細綱在、新路徑映象的位置上卻已經有東西。`move` 遇到這種情況照樣搬
   * 正文，細綱留在原處、說一句（第 7 條：目標已有就不動）；但**先改了正文的 `# 標題` 行再搬家**的呼叫方（`files/fileOps.ts`
   * 的章節改名）要把它當成搬不成——寫標題之前就停下，什麼都不動（第 3 條），不然標題與檔名換了，細綱卻留在舊路徑上。
   *
   * 預檢過了不等於一定搬得成（預檢與搬家之間別處可能剛建了同名檔案）：呼叫方仍要接住 `move` 的失敗。
   */
  async checkMove(from: string, to: string, opts: { plot?: boolean } = {}): Promise<void> {
    const { fromRel, toRel } = await this.guardMove(from, to);
    if (!opts.plot || this.ctxOf(fromRel).path.kind !== 'chapter') {
      return;
    }
    const mine = this.project.plotMirrorOf(fromRel);
    const next = this.project.plotMirrorOf(toRel);
    if (!mine || !next || mine === next) {
      return;
    }
    if ((await exists(this.project.pathOf(mine))) && (await exists(this.project.pathOf(next)))) {
      throw new WsError('exists', `已存在：${next}（新名字對應的細綱位置上已經有一份，這一章的細綱 ${mine} 跟不過去）`);
    }
  }

  /**
   * `move` 與 `checkMove` 共用的守衛。來源過「改名 / 刪除」那一套（固定目錄、內部檔案、回收站、存在），落點過寫入那一套：
   * 把一份細綱搬成 `.novelwarden/plots` 本身，或者搬進回收站裝作刪掉，都不該放行；同名一律拒絕（第 3 條）。
   */
  private async guardMove(from: string, to: string): Promise<{ fromAbs: string; fromRel: string; toRel: string }> {
    const fromAbs = await guardMutate(this.project, from);
    const fromRel = normalizeRel(from)!;
    const toRel = normalizeRel(to);
    if (toRel === undefined) {
      throw new WsError('outOfRoot', `路徑超出工程目錄：${to}`);
    }
    await guardWrite(this.project, toRel, { mode: 'create' });
    return { fromAbs, fromRel, toRel };
  }

  // ---------------------------------------------------------------- remove

  /**
   * 刪除：**搬進 `.novelwarden/.trash/` 並保留原相對路徑**，不真刪
   * （AGENTS 第 6 條）。同名衝突時加序號，不覆蓋之前刪掉的東西。
   */
  async remove(rel: string): Promise<WriteResult> {
    const abs = await guardMutate(this.project, rel);
    const normalized = normalizeRel(rel)!;
    const ctx = this.ctxOf(normalized);
    const handler = handlerFor(ctx.path.kind);

    // 伴生先處理（有的 handler 刪除時要連帶搬東西或重算索引），主檔案刪完再做的話，
    // 中途失敗會留下一堆孤兒。
    const side = handler.onRemove ? await handler.onRemove(ctx, normalized) : [];

    const dest = await trashPathFor(this.project, normalized);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(abs, dest);
    this.project.invalidate();

    log.info(`已移到回收站：${normalized}`, `落點 ${this.project.relPath(dest)}`);
    return { rel: normalized, message: `已移到回收站：${normalized}`, side };
  }

  // ---------------------------------------------------------------- copy

  /**
   * 複製一份檔案或一整個目錄（檔案頁的「複製 → 貼上」）。**目標已有就拒絕**：不加序號、不覆蓋（第 3 條）。
   *
   * 守衛兩頭都過：
   *
   * - **來源**（`guardCopySource`）：在工程內、存在、不是固定目錄、不是內部檔案（會話、工程庫）、不是符號連結。
   *   回收站與歷史版本裡的東西**複製得出來**——複製只讀來源，讀得到就複製得出來，原件一個位元組不動。
   * - **落點**（`guardCreate`）：在工程內、不在回收站 / 會話目錄 / 歷史版本裡、沒有同名；目錄不能複製進它自己裡面。
   *   複製目錄時先把整棵樹列出來、**逐個檔案**過一遍，全過了才動手，守衛攔下一份就整個不復制。
   *
   * 位元組原樣複製（`COPYFILE_EXCL`：競態裡也絕不蓋掉別處剛建的檔案）：GBK 的章節、圖片都不轉碼。沒有大小上限——與 `move`
   * 一樣，複製不把內容讀進編輯器或模型。目錄裡的符號連結不跟進去，跳過並在 `side` 裡說出來（鏈到工程外的東西不該被抄進來）。
   *
   * 拷完按**副本**的種類補賬（handler 的 `afterCopy`）：細綱副本去掉定稿那一側的指紋（`handlers/plot.ts`，第 18 條）；
   * 複製進 `chapters/` 的章節最後統一同步一次 manifest，像新建一樣。**沒有伴生**：複製一章不帶草稿、也不帶細綱——副本是
   * 一章新的（第 8 條：細綱按路徑認，舊細綱不冒認），草稿是作者對原章的筆記，跟著複製會變成兩份各自漂移的東西。
   * 沒覆蓋任何東西，所以不存歷史版本；原件的歷史也不抄過去。
   */
  async copy(from: string, to: string): Promise<WriteResult> {
    const source = await guardCopySource(this.project, from);
    const toRel = normalizeRel(to);
    if (toRel === undefined) {
      throw new WsError('outOfRoot', `路徑超出工程目錄：${to}`);
    }
    if (source.isDir && toRel.startsWith(`${source.rel}/`)) {
      throw new WsError('intoSelf', `不能把「${source.rel}」複製進它自己裡面：${toRel}`);
    }
    await guardCreate(this.project, toRel);

    const plan = source.isDir
      ? await copyPlanOf(this.project, source.rel, toRel)
      : { dirs: [], files: [{ from: source.rel, to: toRel }], skipped: [] };
    for (const rel of [...plan.dirs, ...plan.files.map((f) => f.to)]) {
      await guardCreate(this.project, rel);
    }

    if (!source.isDir) {
      await fs.mkdir(path.dirname(this.project.pathOf(toRel)), { recursive: true });
    }
    for (const dir of plan.dirs) {
      await fs.mkdir(this.project.pathOf(dir), { recursive: true });
    }
    for (const file of plan.files) {
      await fs.copyFile(this.project.pathOf(file.from), this.project.pathOf(file.to), fsConstants.COPYFILE_EXCL);
    }
    this.project.invalidate();

    const side = plan.skipped.map((rel) => `${rel} 是符號連結，沒複製`);
    let chapters = false;
    for (const file of plan.files) {
      const ctx = this.ctxOf(file.to);
      if (ctx.path.kind === 'chapter') {
        chapters = true;
        continue;
      }
      const handler = handlerFor(ctx.path.kind);
      if (handler.afterCopy) {
        side.push(...(await handler.afterCopy(ctx, file.from)));
      }
    }
    if (chapters) {
      await this.project.syncManifest();
    }
    // 與 move 同一個口徑：有連帶的事才記一條（去掉了哪份細綱的指紋、跳過了哪個連結）。
    if (side.length > 0) {
      log.info(`${source.rel} → ${toRel} 複製時連帶`, side.join('｜'));
    }
    return { rel: toRel, message: `已複製到 ${toRel}`, side };
  }

  // ---------------------------------------------------------------- mkdir

  /**
   * 建一個目錄，可以一次建幾層（`宗門/正道`）。工程頁 / 檔案頁的「新建資料夾」走它。
   *
   * 守衛與複製的落點同一套（`guardCreate`）：在工程內、不在回收站 / 會話目錄 / 歷史版本裡；落點上已經有東西（目錄或檔案）
   * 報 `exists`、什麼都不動（第 3 條）。只建目錄，不寫任何檔案，所以沒有種類、沒有記賬。
   */
  async mkdir(rel: string): Promise<WriteResult> {
    const abs = await guardCreate(this.project, rel);
    const normalized = normalizeRel(rel)!;
    await fs.mkdir(abs, { recursive: true });
    this.project.invalidate();
    return { rel: normalized, message: `已新建資料夾 ${normalized}` };
  }

  // ---------------------------------------------------------------- restoreBytes

  /**
   * 把一份檔案寫回成存檔點裡的那一份（`features/checkpoint.ts` 的退回），**位元組原樣**。
   *
   * 與 `write` 不同的地方都是有意的：
   *
   * - **不跑 handler**（不渲染、不定落點、不記賬）：退回要的是當時那一份一個位元組不差——細綱 frontmatter 裡的
   *   `upstreamHash` / `writtenFrom` / `sourceHash` 一起回到當時，不按大綱此刻的指紋重記（第 18 條：整本退回之後
   *   就是當時那條鏈）。章節的 manifest 由呼叫方在一批寫完之後同步一次（同 `deferAfter`）。
   * - **不彈覆蓋審閱**：面板上點了兩下「退回」就是那一問（第 3 條），樂觀鎖擋住這期間別處的改動。
   *
   * 守衛照過：越界、寫不進去的三處（內部檔案 / 回收站 / 歷史版本）、大小上限、樂觀鎖——`absent: true` 表示作者看到時
   * 磁碟上沒有這一份，這期間又被建出來就報 `exists`；給了 `baseHash` 就比對，磁碟變過報衝突。覆蓋之前照樣給舊內容存
   * 一版歷史（跳過節流：退回是一次大改，被蓋掉的那一份得在「歷史」面板裡找得到）。父目錄不在就補齊（存檔點之後整個
   * 卷目錄被刪了）。
   */
  async restoreBytes(rel: string, bytes: Buffer, opts: { baseHash?: string; absent?: boolean } = {}): Promise<WriteResult> {
    const normalized = normalizeRel(rel);
    if (normalized === undefined) {
      throw new WsError('outOfRoot', `路徑超出工程目錄：${rel}`);
    }
    if (bytes.length > MAX_EDITABLE_BYTES) {
      throw new WsError('tooLarge', `內容超過大小上限，未寫入：${normalized}`);
    }
    const guarded = await guardWrite(this.project, normalized, {
      mode: opts.absent ? 'create' : 'overwrite',
      baseHash: opts.baseHash,
    });
    if (guarded.existed) {
      await snapshotNow(this.project, normalized);
    }
    await fs.mkdir(path.dirname(guarded.abs), { recursive: true });
    await fs.writeFile(guarded.abs, bytes);
    this.project.invalidate();
    return { rel: normalized, message: `已退回 ${normalized}` };
  }

  // ---------------------------------------------------------------- search

  /**
   * 全文檢索。**零模型呼叫的樸素掃描**，實現在 `search.ts`。
   *
   * 跳過 `.trash/` 與二進位制、單檔案讀入有上限、超上限的條數在 `dropped` 裡
   * 報出來、預設按章號排序——作者問「他前面說過嗎」，時間線順序才有意義。
   */
  async search(pattern: string, opts?: SearchOptions): Promise<SearchResult> {
    return search(this.project, pattern, opts);
  }

  // ---------------------------------------------------------------- 領域寫入器
  //
  // 上面那幾個方法收的是**路徑**。下面這幾個收的是**領域物件**（一份細綱、
  // 一章正文），因為它們的落點由內容決定：細綱的檔名是「章號 + 標題」，
  // 改標題就是改檔名。呼叫方手裡只有物件，讓它自己去拼路徑等於把命名規則
  // 複製一份出去。
  //
  // 它們仍然經同一套 handler 記賬與伴生，只是路徑由這一層算出來。

  // ---------------------------------------------------------------- 情節大綱

  /** 這個路徑是不是情節大綱（沒有檔案，讀寫由這一層接住）。越界、認不出的都不是。 */
  isOutline(rel: string): boolean {
    const normalized = normalizeRel(rel);
    return normalized !== undefined && kindOfPath(this.project, normalized).kind === 'outline';
  }

  /**
   * 寫情節大綱：**按章號拆回各章細綱**（docs/design/plans/2026-10-22-outline-from-plots.md）。磁碟上沒有 `outline.md`，
   * 大綱是各章細綱「梗概」的彙總（`NovelProject.readOutlineDoc`）。
   *
   * 守衛、樂觀鎖、覆蓋審閱都在**整份彙總**上做，與寫一份檔案同一個口徑：越界由 `write` 先攔；超過大小上限拒；`create` 時
   * 大綱已經有條目報同名；給了 `baseHash` 就比此刻彙總出來的那一份，對不上拋 `WsConflictError`（內建編輯器拿它出衝突條）；
   * 覆蓋之前審閱（現有 ↔ 新版，作者在合併檢視裡挑過的寫挑過的那份）。產物（生成的大綱）先規範成一章一條再審閱——
   * 審閱框裡看到的就是會寫下去的樣子。
   *
   * 拆的規矩在 `model/outlineFile.ts` 的 `planOutlineSplit`，落盤一章一份：
   *
   * - 改梗概：只換「梗概」一節（外科式，別的節與 frontmatter 一個字不動，先存一版歷史）——上游指紋不動，
   *   排過細綱的章因此掛 ⟳（第 18 條）；
   * - 改標題：經 {@link writePlot}（還沒有正文時檔名跟著改，與工程頁的改名同一條路）；
   * - 新的一章：建一份只有梗概的細綱（空殼），不記上游指紋；
   * - 刪掉的空殼進回收站（{@link deletePlot}）；排了細綱或寫了正文的不刪，說一聲。
   *
   * 一章寫不成（落點上已經有別的檔案）不擋別的章，在返回的說明裡列出來。
   */
  async writeOutline(input: WriteInput, opts: WriteOptions = {}): Promise<WriteResult> {
    const mode = opts.mode ?? 'create';
    const rel = this.project.relPath(this.project.outlinePath);
    const current = await this.project.readOutlineDoc();
    let text: string;
    if ('artifact' in input) {
      if (input.artifact.kind !== 'outlineDoc') {
        throw new Error(`「${rel}」不接 ${traditionalLabel(input.artifact.kind)} 產物`);
      }
      text = renderOutlineDoc(parseOutline(input.artifact.text).map((e) => ({ ...e, text: e.text.trim() })));
    } else {
      text = mode === 'append' ? `${current.trimEnd()}\n\n${input.text}` : input.text;
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_EDITABLE_BYTES) {
      throw new WsError('tooLarge', '內容超過大小上限，未寫入。');
    }
    const filled = isOutlineFilled(current);
    if (mode === 'create' && filled) {
      throw new WsError('exists', `已存在：${rel}`);
    }
    // 一條章標題都認不出（舊格式的區間分節、散文式）卻要整份換掉：照拆的規矩會把大綱排到的空殼全刪掉。不寫，說清楚。
    if (filled && !isOutlineFilled(text)) {
      throw new Error('新的情節大綱裡認不出「## 第N章：標題」這樣的章標題，沒有寫入（照它拆，大綱排到的章會全被刪掉）。要刪某幾章，在大綱裡刪掉那幾條再儲存。');
    }
    if (opts.baseHash && hash(current) !== opts.baseHash) {
      log.warn(`寫入被拒：${rel} 在別處被改過`, '情節大綱是各章梗概的彙總，期間有細綱改過。已把現在的版本交回呼用方，未覆蓋。');
      throw new WsConflictError(current, hash(current));
    }
    if (mode === 'overwrite' && filled && opts.review !== false) {
      const review = await reviewOverwrite(opts.what ?? '情節大綱', rel, current, text);
      if (!review.ok) {
        return { rel, skipped: true, message: `沒有改動 ${rel}。` };
      }
      text = review.text ?? text;
    }

    const [plots, chapters] = await Promise.all([this.project.listChapterPlots(), this.project.listChapters()]);
    const plan = planOutlineSplit(text, plots, new Set(chapters.map((c) => c.order)));
    const done = { created: [] as number[], synopsis: [] as number[], title: [] as number[], dropped: [] as number[] };
    const failed: string[] = [];
    for (const op of plan.ops) {
      try {
        if (op.op === 'create') {
          await this.writePlot({ no: op.no, title: op.title, upstreamHash: '', done: false, sections: { ...emptyPlotSections(), 梗概: op.synopsis } });
          done.created.push(op.no);
        } else if (op.op === 'drop') {
          if (await this.deletePlot(op.rel)) {
            done.dropped.push(op.no);
          }
        } else if (op.title !== undefined) {
          const plot = await this.project.readPlot(op.rel);
          if (!plot) {
            throw new WsError('notFound', `找不到 ${op.rel}`);
          }
          await this.writePlot({ ...plot, title: op.title, sections: { ...plot.sections, 梗概: op.synopsis ?? plot.sections.梗概 } }, op.rel);
          done.title.push(op.no);
          if (op.synopsis !== undefined) {
            done.synopsis.push(op.no);
          }
        } else if (op.synopsis !== undefined) {
          await this.patchPlotSynopsis(op.rel, op.synopsis);
          done.synopsis.push(op.no);
        }
      } catch (err) {
        failed.push(`第 ${op.no} 章：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (done.created.length > 0) {
      // 新章可能落在了還沒有正文的卷目錄裡：章節索引不用動，但細綱列表要重讀。
      this.project.invalidate();
    }

    const side = [
      done.created.length ? `新建第 ${nos(done.created)} 章的細綱（只有梗概）` : '',
      done.synopsis.length ? `改了第 ${nos(done.synopsis)} 章的梗概` : '',
      done.title.length ? `改了第 ${nos(done.title)} 章的標題` : '',
      done.dropped.length ? `第 ${nos(done.dropped)} 章只有梗概的細綱進了回收站` : '',
      plan.kept.length ? `第 ${nos(plan.kept)} 章已經排了細綱或寫了正文，大綱裡刪掉那一條沒刪它（要刪去工程頁刪細綱）` : '',
      plan.empty.length ? `第 ${nos(plan.empty)} 章只有標題、沒寫梗概，沒儲存` : '',
      ...failed.map((f) => `沒寫成：${f}`),
    ].filter(Boolean);
    if (side.length > 0) {
      log.info('寫回情節大綱', side.join('｜'));
    }
    const changed = done.created.length + done.synopsis.length + done.title.length + done.dropped.length;
    return {
      rel,
      message: changed > 0 ? `已寫回情節大綱：${side.join('；')}` : side.length > 0 ? `情節大綱沒有改動：${side.join('；')}` : '情節大綱沒有改動。',
      side,
    };
  }

  /**
   * 只換一章細綱的「梗概」一節（在彙總的大綱裡改了這一章那一條）：外科式，別的節、作者加的小節與 frontmatter 一個字不動，
   * 上游指紋也不動（排過細綱的章於是掛 ⟳，第 18 條）。改之前存一版歷史。返回是否寫了。
   */
  async patchPlotSynopsis(plotRelPath: string, synopsis: string): Promise<boolean> {
    const raw = await readTextIfExists(this.project.pathOf(plotRelPath)).catch(() => undefined);
    if (raw === undefined) {
      return false;
    }
    const next = replaceSection(raw, '梗概', synopsis);
    if (next === raw) {
      return false;
    }
    await this.overwrite(plotRelPath, next);
    this.project.invalidate();
    return true;
  }

  /**
   * 寫一章的細綱，返回工作區相對路徑。
   *
   * 落點（細綱映象正文的相對路徑，見 model/project.ts 的 `plotPathForChapter`）：
   *
   * - **這一章已經有正文**：正文的映象。檔名跟著正文走，改標題只改 frontmatter 裡那個標題。
   * - **還沒有正文、已有細綱**：留在那一份所在的子目錄，檔名按「章號 + 標題」重拼——改標題會改
   *   檔名，改章號也會。
   * - **都沒有**：`at`（呼叫方給的落點，如主按鈕的佔位路徑 `summaries/第二卷/003.md`）所在的子目錄；
   *   沒給就跟上一章放在一起（`plotPathForNewChapter`）。
   *
   * 舊檔案必須刪掉，否則 `007-入宗.md` 與 `007-入宗风波.md` 並存會變成同一章的兩份細綱。
   * 「舊檔案是哪一份」有兩種問法：
   *
   * - **改標題**（章號沒變）：按 `plot.no` 就找得到，這是絕大多數呼叫。
   * - **改章號**：新號上根本沒有舊檔案，必須由呼叫方把原路徑經 `fromRelPath`
   *   傳進來。不傳的話舊檔案會留在原地成為孤兒。
   *
   * **`upstreamHash` 以呼叫方給的為準**，不在這裡補：手工新建的細綱傳的就是空串，
   * 它才永遠不會掛 ⟳。
   *
   * @param fromRelPath 改章號時傳原細綱路徑；改標題或新建時不必傳。
   * @param at 新建時呼叫方想要的落點（只取它的子目錄）；不是細綱路徑就不認。
   */
  async writePlot(plot: WritablePlot, fromRelPath?: string, at?: string): Promise<string> {
    // 換號時新號上是空的，只有呼叫方知道原來那份在哪。
    const previous = fromRelPath
      ? await this.project.readPlot(fromRelPath)
      : await this.project.getPlot(plot.no);
    const rel = await this.plotRelPathOf(plot, previous?.relPath, at);
    // 落點上已經有一份**別的**細綱（不是這一章要替換的那份）：不靜默蓋掉它（第 3 條）。
    // 手改檔名撞了號、或兩章起了同一個標題都會走到這裡。
    if (rel !== previous?.relPath && (await readTextIfExists(this.project.pathOf(rel)).catch(() => undefined)) !== undefined) {
      throw new WsError('exists', `已經有一份細綱叫 ${rel}，沒有覆蓋它。`);
    }

    const text = renderPlotFile(plot);
    if (previous) {
      // 換掉的是這一章原來那份（改標題、改章號時它在舊路徑上），舊內容先存一版。
      await snapshotBeforeWrite(this.project, previous.relPath, text);
    }
    await writeText(this.project.pathOf(rel), text);

    if (previous && previous.relPath !== rel) {
      await fs.unlink(this.project.pathOf(previous.relPath)).catch(() => undefined);
      // 改標題（還沒有正文）、改章號都換了檔名：這一份的快照（連同剛存的那一版）跟著搬到新路徑下，絕不拋。
      await moveHistory(this.project, previous.relPath, rel);
    }
    // 細綱列表有快取，寫完不失效的話下一次讀到的還是寫之前那份——新建的章
    // 不出現在工程頁上，改過標題的章還掛著舊名字。
    this.project.invalidate();
    return rel;
  }

  /** {@link writePlot} 的落點。規則見那裡。 */
  private async plotRelPathOf(plot: WritablePlot, previousRel?: string, at?: string): Promise<string> {
    const chapter = await this.project.getChapter(plot.no);
    if (chapter) {
      return this.project.plotPathForChapter(chapter.relPath);
    }
    const anchor = previousRel ?? (at && kindOfPath(this.project, at).kind === 'plot' ? normalizeRel(at) : undefined);
    const dir = anchor
      ? path.posix.dirname(anchor)
      : this.project.relPath(path.join(this.project.plotsDir, await this.project.subdirForNewChapter(plot.no)));
    return `${dir}/${plotFileName(plot.no, safeStem(plot.title))}`;
  }

  /**
   * 刪一章的細綱：搬進 `.trash/`，不真刪（AGENTS 第 6 條）。返回是否確實刪掉了。
   *
   * **不碰 `chapters/`**：那是已經寫出來的正文。刪掉細綱只是放棄這一章的規劃稿
   * （定稿過的話連同檔案），不該順手把正文一起帶走。
   *
   * 落點與 `remove`、`finalizePlot` 同一套（`trashPathFor`：保留原相對路徑，同名加序號）——定稿時
   * 複製進回收站的那一版舊計劃，不能被這一次刪除蓋掉。
   *
   * **它寫進敘事線裡的計劃事件一起刪**（復跑之後，第 28 條「計劃事件隨細綱走」）：各條線與「未歸屬的伏筆」裡這一章的
   * 計劃事件整組刪掉（{@link dropPlannedThreadEvents}，寫之前存一版歷史），實際事件、別的章、作者寫的行不動。從前只刪細綱，
   * 那一章的計劃一直留線上裡，重拆時被當成「原來的計劃」交給模型，寫前提醒也把它算成「安排過」。同一章還有另一份細綱
   * （作者手裡兩份同號的）時不刪——計劃還算那一份的。
   */
  async deletePlot(plotRelPath: string): Promise<boolean> {
    const plot = await this.project.readPlot(plotRelPath);
    if (!plot) {
      return false;
    }
    const dest = await trashPathFor(this.project, plotRelPath);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(this.project.pathOf(plotRelPath), dest);
    this.project.invalidate();
    if (!(await this.project.getPlot(plot.no))) {
      await this.dropPlannedThreadEvents(plot.no);
    }
    return true;
  }

  /**
   * 刪掉各條線與「未歸屬的伏筆」裡第 `no` 章的計劃事件（刪一章細綱時，見 {@link deletePlot}）：外科式（`replacePlannedEvents`），
   * 只動那幾行，每份改了的先存一版歷史。返回刪掉了幾條。
   */
  async dropPlannedThreadEvents(no: number): Promise<number> {
    const book = await this.project.readThreads();
    let removed = 0;
    for (const rel of [...book.threads.map((t) => t.relPath), book.unfiled.relPath]) {
      await this.updateThread(rel, (raw) => {
        if (!raw.trim()) {
          return undefined;
        }
        const r = replacePlannedEvents(raw, no, []);
        removed += r.removed;
        return r.removed > 0 ? r.text : undefined;
      });
    }
    if (removed > 0) {
      log.info(`第 ${no} 章的細綱刪了：敘事線裡那一章的 ${removed} 條計劃一起刪掉（舊版存進了歷史版本）`);
    }
    return removed;
  }

  /**
   * 正文改了名，細綱裡的標題跟著改：frontmatter 的 `title` 與 `# 第N章 標題` 那一行。返回改了（`retitled`）、
   * 沒動作者起的標題（`kept`）、本來就一樣（`same`）。
   *
   * 細綱檔案已經由 `carryPlot` 跟著正文搬到了新映象，可工程頁那一行先認細綱的標題——不改的話檔名是新的、
   * 顯示的還是舊名字。只在細綱的標題還是正文的舊名（或空著）時改：不一樣說明作者在細綱上單獨起過標題
   * （{@link writePlot} 有正文時改名只改標題），機器不動它。
   *
   * 只改那兩行，其餘一個位元組不動（作者手加的小節、排版都留著），不整份重渲染；改之前存一版歷史。標題不進內容指紋
   * （`plotContentHash`），改了不掛 ⟳。細綱沒有 frontmatter 時標題本來就取檔名，不補 frontmatter（與
   * {@link recordWrittenFrom} 同一個規矩），只換標題行。
   */
  async retitlePlot(plotRelPath: string, from: string, to: string): Promise<'retitled' | 'kept' | 'same'> {
    const abs = this.project.pathOf(plotRelPath);
    const raw = await readTextIfExists(abs).catch(() => undefined);
    const old = from.trim();
    const title = to.trim();
    if (raw === undefined || !title) {
      return 'same';
    }
    const fmTitle = parseMarkdown(raw).frontmatter.title;
    const current = typeof fmTitle === 'string' ? fmTitle.trim() : '';
    if (current && current !== old) {
      return current === title ? 'same' : 'kept';
    }
    const fenced = current === title ? raw : (rewriteFrontmatter(raw, { title }) ?? raw);
    const next = fenced.replace(PLOT_TITLE_LINE, (line, head: string, sep: string, was: string) =>
      was.trim() === old ? `${head}${sep || ' '}${title}` : line
    );
    if (next === raw) {
      return 'same';
    }
    await snapshotBeforeWrite(this.project, plotRelPath, next);
    await writeText(abs, next);
    this.project.invalidate();
    return 'retitled';
  }

  /**
   * 在細綱上記下「正文據以寫成的細綱指紋」（`writtenFrom`）。正文落盤那一步調它。
   *
   * 為什麼記在細綱這一側：章節是作者的檔案，可以是 `.txt`、沒有 frontmatter
   * （第 9 條），這條鏈只能從細綱指過去（見 model/plotFile.ts 的檔案頭）。
   * `rewriteFrontmatter` 只改 `---` 之間那一段，正文一個位元組不動；細綱沒有
   * frontmatter（作者手寫的）就不補——那份細綱不在這條鏈上。
   *
   * 返回是否確實記上了。
   */
  async recordWrittenFrom(plotRelPath: string, plotHash: string): Promise<boolean> {
    const abs = this.project.pathOf(plotRelPath);
    const raw = await readTextIfExists(abs).catch(() => undefined);
    if (raw === undefined || !plotHash) {
      return false;
    }
    const next = rewriteFrontmatter(raw, { writtenFrom: plotHash });
    if (next === undefined || next === raw) {
      return next !== undefined;
    }
    await fs.writeFile(abs, next, 'utf8');
    this.project.invalidate();
    return true;
  }

  /**
   * 一致性預檢的永久放行（五期補遺 §2）：把「這幾個人在這一章出場是刻意的安排」記進這一章細綱的
   * frontmatter（`preflightOk`，一行「名字：理由」）。同名的換成新理由，其餘原樣留著。
   *
   * 與 {@link recordWrittenFrom} 同一種寫法：只改 `---` 之間那一段。細綱沒有 frontmatter（作者
   * 手寫的）就不補——補一段 frontmatter 等於把它拉進指紋鏈（handlers/plot.ts 的第 18a 條）。
   * 返回是否確實記上了。
   */
  async recordPreflightOk(plotRelPath: string, entries: readonly PreflightOk[]): Promise<boolean> {
    const abs = this.project.pathOf(plotRelPath);
    const raw = await readTextIfExists(abs).catch(() => undefined);
    if (raw === undefined || entries.length === 0) {
      return false;
    }
    const current = parsePlotFile(raw, plotRelPath).preflightOk;
    const merged = [...current.filter((e) => !entries.some((n) => n.name === e.name)), ...entries];
    const next = rewriteFrontmatter(raw, { preflightOk: renderPreflightOk(merged) });
    if (next === undefined) {
      return false;
    }
    if (next !== raw) {
      await fs.writeFile(abs, next, 'utf8');
      this.project.invalidate();
    }
    return true;
  }

  /**
   * 全書替換收尾時給細綱的指紋鏈補賬（`features/bookReplace.ts`，第 18 條）：只改 frontmatter 裡給出的那幾個
   * 指紋鍵——`upstreamHash` / `writtenFrom` / `sourceHash`，值為 undefined 就是刪掉這個鍵——正文一個位元組不動。
   * 與 {@link recordWrittenFrom} 同一種寫法：只改 `---` 之間那一段、不存歷史版本（不吞任何內容）、沒有 frontmatter
   * 的手寫細綱不補。不是細綱路徑就不動。返回是否改了。
   */
  async restampPlotChain(
    plotRelPath: string,
    patch: { upstreamHash?: string; writtenFrom?: string; sourceHash?: string }
  ): Promise<boolean> {
    const rel = normalizeRel(plotRelPath);
    if (rel === undefined || kindOfPath(this.project, rel).kind !== 'plot') {
      return false;
    }
    const allowed: Record<string, string | undefined> = {};
    for (const key of ['upstreamHash', 'writtenFrom', 'sourceHash'] as const) {
      if (key in patch) {
        allowed[key] = patch[key] || undefined;
      }
    }
    const abs = this.project.pathOf(rel);
    const raw = await readTextIfExists(abs).catch(() => undefined);
    if (raw === undefined || Object.keys(allowed).length === 0) {
      return false;
    }
    const next = rewriteFrontmatter(raw, allowed);
    if (next === undefined || next === raw) {
      return false;
    }
    await fs.writeFile(abs, next, 'utf8');
    this.project.invalidate();
    return true;
  }

  /**
   * 單獨記設定（設定名錄）：只換掉這一章細綱的「設定」一節，沒有就加在末尾，另外七節與 frontmatter
   * 一個字不動（`replaceSection`）。「設定」一節不進內容指紋，所以這樣補記不會讓正文掛 ⟳。返回是否寫了。
   */
  async patchPlotLore(plotRelPath: string, lines: readonly LoreLine[]): Promise<boolean> {
    const abs = this.project.pathOf(plotRelPath);
    const raw = await readTextIfExists(abs).catch(() => undefined);
    if (raw === undefined) {
      return false;
    }
    const next = replaceSection(raw, PLOT_LORE_KEY, renderLoreLines(lines));
    if (next !== raw) {
      await fs.writeFile(abs, next, 'utf8');
      this.project.invalidate();
    }
    return true;
  }

  /**
   * 新建章節檔案，返回工作區相對路徑。
   *
   * `dir` 是工作區相對的落點目錄（如 `chapters/第一卷`），預設落在 chapters/ 根下。
   * `ext` 預設 `.txt`：正文一律出純文字（2026-10-24 作者定的，從前是 `.md`）；掃描時認任意副檔名。
   * 非 markdown 家族不寫標題行。
   *
   * **`title` 留空是合法的**，落成純序號名 `001.txt`（細綱還沒起標題的章就是
   * 這個樣子，標題等作者自己改）。
   *
   * 標題行寫的是**清洗後**的詞幹而不是原樣 `title`：兩者一致，改名時
   * `renamedBody` 才認得出「這個 H1 是跟著檔名走的」。無標題時乾脆不寫
   * 標題行——憑空塞一行 `# ` 是同一個毛病。
   */
  async createChapter(
    order: number,
    title: string,
    content = '',
    dir?: string,
    ext = '.txt'
  ): Promise<string> {
    const { rel, text } = this.chapterFileOf(order, title, content, dir, ext);

    // 走 write：同名一律報錯退出（第 3 條），manifest 由 chapter handler 同步。
    await this.write(rel, { text }, { mode: 'create' });
    return rel;
  }

  /**
   * 在給定路徑新建一章，返回那個路徑。正文照細綱寫出來時用：落點由 views/pipeline.ts 的
   * `chapterTargetOf` 給（細綱所在的子目錄）。標題行取檔名裡的詞幹，與 {@link createChapter} 同一個規矩。
   *
   * `plotRelPath` 是這一章照著寫的細綱。它的路徑與新正文的映象對不上（細綱是還沒起名時建的
   * `030.md`，正文按標題落成了 `030-雪夜.txt`）就把細綱改名過去——細綱映象正文的路徑，不改的話
   * 正文一落盤，這一章就「沒有細綱」了。映象位置已有別的檔案時不動（不靜默覆蓋），記一條 warn。
   */
  async createChapterAt(rel: string, content = '', plotRelPath?: string): Promise<string> {
    const parsed = parseChapterFileName(path.posix.basename(rel));
    const stem = parsed?.stem.trim() ?? '';
    const text = parsed && isMarkdownExt(parsed.ext) && stem ? `# ${stem}\n\n${content.trim()}\n` : `${content.trim()}\n`;
    await this.write(rel, { text }, { mode: 'create' });

    const mirror = this.project.plotMirrorOf(rel);
    if (plotRelPath && mirror && mirror !== plotRelPath) {
      try {
        await this.move(plotRelPath, mirror);
        log.info('細綱跟著新正文改名', `${plotRelPath} → ${mirror}`);
      } catch (err) {
        log.warn('細綱沒能改名到新正文的映象，這一章暫時認不出細綱', `${plotRelPath} → ${mirror}｜${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return rel;
  }

  /**
   * 一次新建好幾章（匯入原稿，features/importManuscript.ts）。每一章與 {@link createChapter} 走同一條
   * `write`（同名報錯退出、大小上限一樣不少），只是 manifest **最後同步一次**——chapter handler 每寫一章
   * 就重掃全部章節，幾百章逐章同步是 O(n²) 次讀盤（三百章十幾秒）。
   *
   * 一章寫不進去就拋（前面寫好的留著，manifest 照樣同步）；`signal` 取消了就停在下一章前面。
   * `onEach` 每寫好一章報一次。
   */
  async createChapters(
    items: readonly { order: number; title: string; content: string }[],
    opts: { signal?: AbortSignal; onEach?: (rel: string, index: number) => void } = {}
  ): Promise<string[]> {
    const out: string[] = [];
    try {
      for (let i = 0; i < items.length && !opts.signal?.aborted; i++) {
        const { rel, text } = this.chapterFileOf(items[i].order, items[i].title, items[i].content);
        await this.write(rel, { text }, { mode: 'create', deferAfter: true });
        out.push(rel);
        opts.onEach?.(rel, i);
      }
    } finally {
      if (out.length > 0) {
        await this.project.syncManifest();
      }
    }
    return out;
  }

  /** 新建章節的落點與內容（標題行規則見 {@link createChapter}）。 */
  private chapterFileOf(order: number, title: string, content: string, dir?: string, ext = '.txt'): { rel: string; text: string } {
    const stem = safeStem(title);
    const fileName = stem ? `${pad3(order)}-${stem}${ext}` : `${pad3(order)}${ext}`;
    const parent = dir ? normalizeRel(dir) : this.project.relPath(this.project.chaptersDir);
    const rel = parent ? `${parent}/${fileName}` : fileName;
    const text = isMarkdownExt(ext) && stem ? `# ${stem}\n\n${content.trim()}\n` : `${content.trim()}\n`;
    return { rel, text };
  }

  /**
   * 按需建立草稿，返回它的工作區相對路徑。
   *
   * **已存在就原樣返回，絕不覆蓋**——第二次點「開啟草稿」不能把上次寫的
   * 東西抹掉。這是「不靜默覆蓋」在草稿上的落法。
   */
  async ensureDraft(chapter: Chapter): Promise<string> {
    const rel = this.project.draftRelPathFor(chapter.relPath);
    if (!rel) {
      throw new Error(
        `這一章不在 ${this.project.config.chaptersDir}/ 下，無法建草稿：${chapter.relPath}`
      );
    }
    const abs = this.project.pathOf(rel);
    if ((await readTextIfExists(abs)) === undefined) {
      // markdown 家族給一行標題好認；其餘（.txt / 無副檔名 / .json）留空檔案，
      // 往裡塞 markdown 語法只會礙事。
      await writeText(abs, isMarkdownPath(rel) ? `# ${chapter.title} · 草稿\n\n` : '');
    }
    return rel;
  }

  /**
   * 匯出全文（`features/exportBook.ts`，2026-10-24）：整份寫到 `rel`，已有就直接覆蓋，返回規範化後的路徑。
   *
   * 與 {@link write} 不一樣的地方都因為它是**照章節現拼出來的副本**，不是作者的產物：
   * - **不過 2MB 上限**：一本書動輒幾 MB（百萬字約 3MB），這份檔案也不進編輯器、不進上下文；
   * - **不審閱、不存歷史**：每次匯出整份重拼，蓋掉的只是上一次匯出（作者選的「重複匯出直接覆蓋」）；
   * - **不跑 handler**：落在 `匯出/`，不在任何一條鏈上，沒有記賬與伴生。
   *
   * 越界、內部檔案、回收站、歷史版本照常攔（`guardWrite`）。
   */
  async writeExport(rel: string, text: string): Promise<string> {
    const normalized = normalizeRel(rel);
    if (normalized === undefined) {
      throw new WsError('outOfRoot', `路徑超出工程目錄：${rel}`);
    }
    const guarded = await guardWrite(this.project, normalized, { mode: 'overwrite' });
    await writeText(guarded.abs, text);
    return normalized;
  }

  /**
   * 定稿：把反向更新過的細綱寫回**這一章正文映象的那一份**（還沒有就在映象位置新建一份）。返回落點，
   * 以及舊版在回收站裡的位置（原來沒有細綱時沒有）。
   *
   * 渲染規矩在 `handlers/plot.ts` 的 `renderFinalizedPlot`：七節整體替換，作者定的 frontmatter 留著，
   * `sourceHash` 記正文的 `contentHash`（指紋鏈的最後一環），`writtenFrom` 刷成更新之後的指紋。
   *
   * **舊版先複製一份進 `.trash/`**（保留原相對路徑，同名加序號，與第 6 條同一個落點）：定稿按鈕本身就是
   * 作者的確認，所以直接寫；但改的是一份作者可能逐字推敲過的計劃，舊的那一版要找得回來。
   */
  async finalizePlot(
    chapter: Chapter,
    sections: PlotSections,
    cast: SummaryCast[],
    lore?: LoreLine[]
  ): Promise<{ rel: string; trashed?: string }> {
    const current = await this.project.plotOfChapter(chapter);
    const title = isFallbackChapterTitle(chapter.order, chapter.title) ? '' : chapter.title;
    const rel = this.project.plotPathForChapter(chapter.relPath);
    const text = renderFinalizedPlot({
      rel,
      no: chapter.order,
      title,
      current,
      sections,
      cast,
      sourceHash: chapter.contentHash,
      lore,
    });

    let trashed: string | undefined;
    if (current) {
      const dest = await trashPathFor(this.project, current.relPath);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(this.project.pathOf(current.relPath), dest);
      trashed = this.project.relPath(dest);
    }
    // 回收站那一份照舊（永不裁剪，定稿完成提示裡說的就是它）；歷史版本裡再存一版，編輯器的「歷史」面板裡
    // 找得到、對比得了——七節整體換掉，節流攔不住它。
    await snapshotBeforeWrite(this.project, rel, text);
    await writeText(this.project.pathOf(rel), text);
    this.project.invalidate();
    return { rel, trashed };
  }

  /**
   * 寫一張角色卡。slug 可以帶子目錄字首（如 `主角/林昭`），中間目錄自動補齊。
   *
   * 角色卡**不在生產鏈上**：它是橫切的記憶，被裝配進 prompt，但不由某一層
   * 產物「生出來」，所以沒有上游指紋要記。
   */
  async writeCharacter(card: WritableCharacterCard): Promise<string> {
    const rel = `${this.project.relPath(this.project.charactersDir)}/${card.slug}.md`;
    await this.overwrite(rel, renderCharacterCard(card));
    return rel;
  }

  /** 寫一條設定。與角色卡同類：鏈外的橫切知識，無上游指紋。 */
  async writeLore(entry: WritableLoreEntry): Promise<string> {
    const rel = `${this.project.relPath(this.project.loreDir)}/${entry.slug}.md`;
    await this.overwrite(rel, renderLoreEntry(entry));
    return rel;
  }

  /**
   * 在設定區裡建分類目錄（`宗門/正道` 這樣的相對 `lore/` 的路徑，可多層）。設定清單落盤時用：分類就是
   * 目錄，空的也建，作者看得到這本書的分類表。已有的不動；每一段過一遍檔名清洗，`.` 開頭的段不要，
   * 出不了 `lore/`（第 7 條）。返回新建了哪幾個。
   */
  async ensureLoreFolders(categories: readonly string[]): Promise<string[]> {
    const root = this.project.loreDir;
    const created: string[] = [];
    for (const category of categories) {
      const parts = category
        .split('/')
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('.'))
        .map(sanitizeFileName);
      const abs = path.join(root, ...parts);
      const inside = path.relative(root, abs);
      if (parts.length === 0 || !inside || inside.startsWith('..') || path.isAbsolute(inside) || (await exists(abs))) {
        continue;
      }
      await fs.mkdir(abs, { recursive: true });
      created.push(parts.join('/'));
    }
    if (created.length > 0) {
      this.project.invalidate();
    }
    return created;
  }

  /** 寫文風指南。同樣在鏈外——它約束怎麼寫，不由任何一層產物生出來。 */
  async writeStyleGuide(content: string): Promise<string> {
    const rel = this.project.relPath(this.project.stylePath);
    await this.overwrite(rel, `# 文風指南\n\n${content.trim()}\n`);
    return rel;
  }

  /**
   * 寫全文大綱，並把水位線記進 manifest。
   *
   * 它的上游是全部定稿過的細綱，但那是一次顯式的重建動作（`through` 水位線），
   * 不是 hash 傳播——所以沒有 `upstreamHash`。
   */
  async writeGlobalSummary(content: string, through: number): Promise<string> {
    const rel = this.project.relPath(this.project.globalSummaryPath);
    const fm = stringifyFrontmatter({ through, generatedBy: 'novelwarden' });
    await this.overwrite(rel, `${fm}\n\n# 全文大綱\n\n${content.trim()}\n`);
    const manifest = await this.project.readManifest();
    manifest.globalSummaryThrough = through;
    await this.project.writeManifest(manifest);
    return rel;
  }

  /**
   * 第 `no` 章的敘事線判過了（定稿第三步的認事件成了）：推 `project.json` 裡的水位（敘事線重做四期，`advanceThreadsMark`）——
   * 正好是水位 + 1 就往後推、順著後面已經判過的接著推；更靠後的記進 `threadsJudged`；水位以內的不動、不寫盤。
   * 單章定稿、立即同步、寫完即定稿與從已寫正文補記都在判完一章之後調它（features/threads.ts 的 `noteThreadsJudged`）。
   * 同全文大綱的水位：manifest 是鏈外的索引，沒有上游指紋。返回推過之後的樣子。
   */
  async markThreadsJudged(no: number): Promise<ThreadsMark> {
    const manifest = await this.project.readManifest();
    const before = threadsMarkOf(manifest);
    const after = advanceThreadsMark(before, no);
    if (after === before) {
      return before;
    }
    manifest.threadsThrough = after.through;
    if (after.judged.length > 0) {
      manifest.threadsJudged = after.judged;
    } else {
      delete manifest.threadsJudged;
    }
    await this.project.writeManifest(manifest);
    return after;
  }

  /**
   * 新建一條敘事線（排線、定稿時從正文認出新線）：`threads/<線名>.md`。**同名跳過**——這個檔案已經在了（作者建的、
   * 這幾十秒裡別處建的）就一個位元組不動，返回 undefined（第 19 條：機器只追加，已有的線不改）。名字歸一後撞上
   * 已有的線（「玉佩 的來歷」與「玉佩的來歷」）由呼叫方先判，這裡只看檔名。鏈外檔案，沒有上游指紋。
   */
  async createThread(thread: NewThread): Promise<string | undefined> {
    const rel = `${this.project.relPath(this.project.threadsDir)}/${threadFileName(thread.name)}`;
    if (await exists(this.project.pathOf(rel))) {
      return undefined;
    }
    try {
      await this.write(rel, { text: renderThreadFile(thread) }, { mode: 'create' });
    } catch (err) {
      // 剛查過不在、寫的時候卻有了：與已有的一樣，不動它。
      if (err instanceof WsError && (err.code === 'exists' || err.code === 'notFile')) {
        return undefined;
      }
      throw err;
    }
    return rel;
  }

  /**
   * 改寫一份敘事線檔案（一條線，或「未歸屬的伏筆」）：讀**此刻**磁碟上的原文（還沒有這份檔案當空串）→ `edit`
   * 給出新原文 → 寫回（覆蓋之前存一版歷史）。`edit` 返回 undefined 或原樣返回就不寫。
   *
   * 為什麼不讓呼叫方先讀好再交一份全文進來：排線、定稿那一次呼叫要幾十秒，這期間作者可能正在編輯器裡改這份
   * 檔案。在寫之前那一刻重讀、只在上面外科式地改（model/threadFile.ts），作者那幾十秒裡的改動才不會被一份
   * 舊的全文沖掉（第 3 條）。只認敘事線目錄裡的檔案（種類不是 `threads` 的拒寫）。
   */
  async updateThread(rel: string, edit: (raw: string) => string | undefined): Promise<string | undefined> {
    const normalized = normalizeRel(rel);
    if (normalized === undefined || kindOfPath(this.project, normalized).kind !== 'threads') {
      throw new WsError('protected', `「${rel}」不是敘事線目錄裡的檔案`);
    }
    const raw = (await readTextIfExists(this.project.pathOf(normalized))) ?? '';
    const next = edit(raw);
    if (next === undefined || next === raw) {
      return undefined;
    }
    await this.overwrite(normalized, next);
    return normalized;
  }

  /**
   * 寫技能的階段繫結（`.novelwarden/skills.json`）。鏈外的小檔案，由設定頁「技能」與
   * 外部 agent 的 `skills bind` 改寫——兩條路在動手前都已經問過作者，這裡不再彈覆蓋審閱：
   * 每換一次下拉框就彈一個 JSON 的 diff 只是噪聲。內容由 `renderSkillBindings` 產出。
   */
  async writeSkillBindings(text: string): Promise<string> {
    const rel = this.project.relPath(this.project.skillBindingsPath);
    await this.overwrite(rel, text);
    return rel;
  }

  /**
   * 切換正文的分段格式（內建編輯器「編輯 → 段落格式」）：**只改 `config.md` frontmatter 的
   * `paragraphStyle` 這一行**，正文一個位元組不動（`setConfigParagraphStyle`）。沒有 `config.md` 時新建一份
   * 只有這一段 frontmatter 的——它沒有任何小節，「小說配置」照舊算沒填，主按鈕不變。
   *
   * 走 `write` 這一條閘道器（越界、大小這些守衛照過），不彈覆蓋審閱：改的只是作者自己在選單裡點的那一個鍵，
   * 沒有內容會被吞掉。帶上讀到時的 hash 當樂觀鎖——讀與寫之間作者在編輯器裡存過，就報衝突、不覆蓋。
   * 返回寫到的相對路徑；已經是這個值時不寫，返回 undefined。
   */
  async setParagraphStyle(style: ParagraphStyle): Promise<string | undefined> {
    const rel = this.project.relPath(this.project.configPath);
    // 讀不到（不存在）當空串；許可權之類的錯誤照常上拋——吞掉它會拿一份最小的配置蓋掉作者那份。
    const raw = await readTextIfExists(this.project.configPath);
    const next = setConfigParagraphStyle(raw ?? '', style);
    if (raw !== undefined && next === raw) {
      return undefined;
    }
    await this.write(
      rel,
      { text: next },
      { mode: 'overwrite', review: false, baseHash: raw === undefined ? undefined : hash(raw) }
    );
    return rel;
  }

  // ---------------------------------------------------------------- 新工程

  /**
   * 初始化一個新工程（`actions.ts` 的 `initProjectFlow`：外掛命令、網頁按鈕、CLI 共用）：固定目錄 → 空模板 → manifest。
   * 返回新建了哪幾份模板。
   *
   * **分層**：建固定目錄、寫 manifest 是後設資料與腳手架，留在 `model/project.ts`（`scaffold` / `createManifest`，按設計不走
   * 閘道器）；幾份模板的落點與內容也在那裡定義（`newProjectTemplates`，純資料）；**寫模板經這裡的 `write`**——`model/`
   * 不能反過來依賴閘道器。
   *
   * 每份模板 `mode: 'create'`，**落點上已經有東西（檔案或目錄）就一個位元組不動**——與從前 `writeIfAbsent` 同一個口徑：在一個
   * 已經寫了一部分的資料夾裡初始化，作者的配置、文風原樣留著（情節大綱是各章細綱梗概的彙總，不建檔案）。經閘道器不多出別的動作：
   *
   * - 不彈審閱（只有 `overwrite` 才問）、不存歷史版本（沒覆蓋任何東西）；
   * - 不碰指紋鏈（第 18 條）：這幾份的種類是 setting / style / globalSummary，它們的 handler 都不記賬；沒有一份
   *   細綱被寫，已有的細綱不會被補上 `upstreamHash`，也就沒有東西因此掛 ⟳；
   * - 不刷日誌：`write` 只在有伴生時記一條 debug，這幾種沒有伴生。
   *
   * manifest 最後寫：`isInitialized` 看的是它。模板寫到一半失敗（磁碟滿、沒許可權）時工程不算建好，作者再點一次就補齊。
   */
  async initializeProject(meta: { title: string; author: string }): Promise<string[]> {
    await this.project.scaffold();
    const created: string[] = [];
    for (const { rel, text } of this.project.newProjectTemplates()) {
      if (await exists(this.project.pathOf(rel))) {
        continue;
      }
      try {
        await this.write(rel, { text }, { mode: 'create' });
        created.push(rel);
      } catch (err) {
        // 剛查過不在、寫的時候卻有了（別處剛建）：與已有的一樣，不動它。
        if (err instanceof WsError && (err.code === 'exists' || err.code === 'notFile')) {
          continue;
        }
        throw err;
      }
    }
    await this.project.createManifest(meta);
    return created;
  }

  // ---------------------------------------------------------------- 內部

  /**
   * 領域寫入器的落盤：目標已有內容就先存一版歷史（history.ts，絕不拋），再整份寫下去。
   * 只改 frontmatter 一個鍵的記賬（`recordWrittenFrom` / `recordPreflightOk`）不走這裡——它們不吞任何內容。
   */
  private async overwrite(rel: string, text: string): Promise<void> {
    await snapshotBeforeWrite(this.project, rel, text);
    await writeText(this.project.pathOf(rel), text);
  }

  private ctxOf(rel: string): HandlerCtx {
    const path: PathKind = kindOfPath(this.project, rel);
    return { project: this.project, rel, path };
  }

  private async render(handler: Handler, ctx: HandlerCtx, artifact: Artifact): Promise<string> {
    if (!handler.render) {
      throw new Error(`「${ctx.rel}」不接結構化產物`);
    }
    return handler.render(ctx, artifact);
  }
}

/** 出現次數。用 split 而不是全域正則：`old` 是字面量，不該被當正則解釋。 */
function countOccurrences(text: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  return text.split(needle).length - 1;
}

function clip(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 30 ? `${one.slice(0, 30)}…` : one;
}

/**
 * 追加時拼出最終內容：接在已有內容後面空一行；檔案還不存在就是這一段本身。
 *
 * 從前 handler 能給「首次追加帶的頭」與「兩段之間的分隔符」——那是中轉站正文用的
 * （拆章的 `---` 斷點）。中轉站刪掉之後再沒有種類要它們，鉤子一併刪了。
 *
 * **正文停在半句上時直接接上**：被截斷的那一章「接著寫」，新寫的是那半句的後半截，中間空一行
 * 就把一句話斷成兩段（百章實驗第 57 章）。只對章節這麼做——別的檔案結尾沒有標點是常事。
 */
function appendText(guarded: { existed: boolean; current?: string }, text: string, prose = false): string {
  if (!guarded.existed) {
    return `${text.trim()}\n`;
  }
  const existing = (guarded.current ?? '').replace(/\s+$/, '');
  const glue = prose && endsMidSentence(existing) ? '' : '\n\n';
  return `${existing}${glue}${text.trim()}\n`;
}

/**
 * 垃圾箱落點：保留原相對路徑，同名衝突時加序號，不覆蓋之前刪掉的東西。實現下沉在資料層（`model/project.ts`），
 * 會話刪除（`model/session.ts`）也用這一份——`model/` 不能反過來依賴閘道器。這裡重新匯出，呼叫方不動。
 */
export { trashPathFor };

/** 章號列成「3、5–7、12」：連著的併成一段。 */
function nos(list: readonly number[]): string {
  const sorted = [...new Set(list)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) {
      j++;
    }
    parts.push(j === i ? `${sorted[i]}` : `${sorted[i]}–${sorted[j]}`);
    i = j + 1;
  }
  return parts.join('、');
}

/**
 * 複製一個目錄要建哪些目錄、拷哪些檔案（工作區相對路徑，父目錄在前）。符號連結不跟進去，記進 `skipped`；
 * 別的特殊檔案（管道、套接字）不認，直接略過。
 */
async function copyPlanOf(
  project: NovelProject,
  fromRel: string,
  toRel: string
): Promise<{ dirs: string[]; files: { from: string; to: string }[]; skipped: string[] }> {
  const plan = { dirs: [toRel], files: [] as { from: string; to: string }[], skipped: [] as string[] };
  const walk = async (from: string, to: string): Promise<void> => {
    for (const dirent of await fs.readdir(project.pathOf(from), { withFileTypes: true })) {
      const childFrom = `${from}/${dirent.name}`;
      const childTo = `${to}/${dirent.name}`;
      if (dirent.isSymbolicLink()) {
        plan.skipped.push(childFrom);
      } else if (dirent.isDirectory()) {
        plan.dirs.push(childTo);
        await walk(childFrom, childTo);
      } else if (dirent.isFile()) {
        plan.files.push({ from: childFrom, to: childTo });
      }
    }
  };
  await walk(fromRel, toRel);
  return plan;
}

async function wordsOf(abs: string): Promise<number | undefined> {
  try {
    return countWords(decodeFileText(await fs.readFile(abs)));
  } catch {
    // 二進位制/許可權問題：不給字數，也不因此讓整次列舉失敗。
    return undefined;
  }
}

/**
 * 標題 → 檔名詞幹。**空標題給空串，不給「未命名」**。
 *
 * `sanitizeFileName` 的兜底名是「未命名」，那是給「作者輸了一串全是非法
 * 字元的名字」用的。但細綱與場景都允許**沒有標題**——流水線新建出來的章
 * 就是純序號名 `030.md`（標題要等劇情排完才定得下來）。直接套 sanitize 會
 * 得到 `030-未命名.md`：那是個假標題，而且它會進檔名、進段落說法、進
 * 上下文，作者還得手動去掉。
 */
function safeStem(title: string): string {
  return title.trim() ? sanitizeFileName(title) : '';
}

/** 細綱的標題行 `# 第N章 標題`（`renderPlotFile` 寫的樣子，也認 `：` 分隔與沒有標題的 `# 第N章`）。CRLF 的 `\r` 不吃進來。 */
const PLOT_TITLE_LINE = /^(#[ \t]+第[ \t]*\d+[ \t]*章)([：:][ \t]*|[ \t]+|)(.*?)[ \t]*(?=\r?$)/m;

export { WsError, WsConflictError, MAX_EDITABLE_BYTES } from './guard';
export type { WsErrorCode } from './guard';
export { kindOfPath, normalizeRel, pathOfTarget } from './kind';
export type { ArtifactKind, PathKind } from './kind';
// 檢索既是 `Workspace` 上的一個方法，也直接匯出：三期的 agent 工具手裡只有
// 一個 `NovelProject`，不必為了搜一次而先造一個門面。
export { search } from './search';
export type { SearchHit, SearchOptions, SearchResult } from './search';
