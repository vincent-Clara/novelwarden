import type { ChatController } from './index';
import {
  deleteEntry,
  deletePlot,
  isPlotPath,
  moveEntry,
  renameEntry,
  renamePlot,
} from '../files/fileOps';
import { listDirs } from '../files/fileTree';
import { copyInto, moveInto, renameAny } from '../files/projectFiles';
import { getHost } from '../host';
import { scoped } from '../runtime/logger';
import { EditorOpenIntent, FileOpResult, InMessage } from '../protocol';
import { retargetPlot } from './chat';
import { Workspace } from '../workspace';
import { ensureChapterPlot } from '../actions';
import type { Chapter } from '../model/types';
import { parsePlotFileName } from '../model/plotFile';
import { parseChapterFileName } from '../model/chapterFile';
import { basename } from 'node:path';

const log = scoped('面板');

/** 檔案頁與草稿。欄位只給 controller/ 同包用。 */

/**
 * 列舉資源管理器要的目錄並廣播。
 *
 * 順帶把 `dirs` 記成新的關注集合——工程有變動時 `pushTabData` 會照著
 * 再推一遍。空陣列是合法輸入（前端把樹全摺疊了），此時只更新集合。
 */
export async function pushDirListings(
  c: ChatController,
  dirs: string[],
  ephemeral?: boolean
): Promise<void> {
  // 選擇器一次性列舉不能改掉資源管理器的關注集合，否則展開著的樹會被沖掉。
  if (!ephemeral) {
    c.watchedDirs = dirs;
  }
  if (dirs.length === 0) {
    return;
  }
  c.post({ type: 'dirListings', listings: await listDirs(c.project.root, dirs) });
}

/**
 * 開啟某章的草稿。首次點選按需建立，已存在原樣開啟（絕不覆蓋）。之後點開一章，旁邊並排開的換成草稿（`companion`）。
 *
 * **必須先在真實章節列表裡查到這一章**：這條路徑會寫盤，拿前端傳上來的
 * 任意相對路徑去拼 `drafts/<任意>` 就等於開了一個繞過區守衛的寫入口子。
 * 別為了省一次掃描把這一步最佳化掉。
 */
export async function openDraft(c: ChatController, chapterRelPath: string): Promise<void> {
  const chapter = await knownChapter(c, chapterRelPath);
  if (!chapter) {
    return;
  }
  const rel = await new Workspace(c.project).ensureDraft(chapter);
  log.info(`開啟第 ${chapter.order} 章的草稿`, rel);
  c.companion = 'draft';
  await openCompanion(rel);
  // 剛建出來的草稿要讓 hasDraft 立刻翻過來，選單文案跟著變。
  await c.pushState();
}

/**
 * 內建編輯器工具欄的「細綱」（2026-10-23）：並排開啟這一章的細綱，還沒有就按模板建一份（`ensureChapterPlot`）。
 * 之後點開一章，旁邊並排開的換回細綱（`companion`）。與 {@link openDraft} 同一個守法：先在真實章節列表裡查到這一章。
 */
export async function openPlot(c: ChatController, chapterRelPath: string): Promise<void> {
  const chapter = await knownChapter(c, chapterRelPath);
  if (!chapter) {
    return;
  }
  const plot = await ensureChapterPlot(c.project, new Workspace(c.project), chapter);
  if (!plot) {
    c.toast('這一章不在章節目錄下，推不出細綱該放在哪。', 'error');
    return;
  }
  log.info(`開啟第 ${chapter.order} 章的細綱`, plot.rel);
  c.companion = 'plot';
  await openCompanion(plot.rel);
  if (plot.created) {
    // 工程頁那一行的「開啟細綱」、浮窗都認 plotExists，剛建的要立刻翻過來。
    await c.pushState();
  }
}

/** 前端給的章節路徑 → 真實章節列表裡的那一章。找不到就說一句、重推一次（多半剛被改名或刪除）。 */
async function knownChapter(c: ChatController, chapterRelPath: string): Promise<Chapter | undefined> {
  const chapter = (await c.project.listChapters()).find((ch) => ch.relPath === chapterRelPath);
  if (!chapter) {
    log.warn(`找不到章節 ${chapterRelPath}，可能剛被改名或刪除`);
    c.toast('找不到這一章，可能剛被改名或刪除。', 'error');
    await c.pushState();
  }
  return chapter;
}

/** 草稿、細綱這類伴生檔案：宿主能並排就開在旁邊，不能就照常開啟。 */
async function openCompanion(rel: string): Promise<void> {
  const host = getHost();
  if (host.openBeside) {
    await host.openBeside(rel);
  } else {
    await host.openFile(rel);
  }
}

/**
 * 開啟一章：正文在主區，這一章的細綱並排在旁邊（W6 章節工作臺）。
 *
 * 從前點工程頁的行名只開一份（有正文開正文，否則開細綱），對照著看要再去右鍵開另一份。
 * **並排是宿主的能力，不是殼的名字**：有 `openBeside` 的（獨立版落在第二塊編輯區，VS Code
 * 落在 `ViewColumn.Beside`）兩份都開，沒有的只開正文——與 `openDraft` 同一個判法。
 * 還沒寫正文的章只開細綱；兩樣都沒有才說找不到。
 *
 * 細綱是**正文映象的那一份**（`summaries/` 下與正文相同的相對路徑）；給的是章節路徑時就認那個檔案，
 * 同號的正文有兩份也開得準。**有正文卻還沒有細綱**時按模板建一份再開（2026-10-23 作者定，`ensureChapterPlot`）。
 *
 * **旁邊開哪一份跟上一次走**（2026-10-23）：上一次並排開的是草稿（`c.companion`），就開這一章的草稿（沒有就建），
 * 不開細綱。
 *
 * `intent.preview`：工程頁單擊那一行的名字，兩份都開成臨時標籤（內建編輯器認，原樣帶回 `editorOpen`）。
 * `beside: false`：前端眼下沒有第二塊編輯區（窄屏），與宿主沒有 `openBeside` 一樣只開正文——並排的那份開進同一塊會頂掉正文的臨時標籤。
 */
export async function openChapter(c: ChatController, plotRelPath: string, intent?: EditorOpenIntent, beside = true): Promise<void> {
  const chapters = await c.project.listChapters();
  const direct = chapters.find((ch) => ch.relPath === plotRelPath);
  const no = direct?.order ?? chapterNoOf(plotRelPath);
  const chapter = direct ?? (no !== undefined ? chapters.find((ch) => ch.order === no) : undefined);
  const plot = chapter ? await c.project.plotOfChapter(chapter) : no !== undefined ? await c.project.getPlot(no) : undefined;
  const host = getHost();
  if (!plot && !chapter) {
    c.toast('這一章還沒有細綱也沒有正文。', 'error');
    return;
  }
  const open = intent?.preview ? { preview: true } : undefined;
  if (!chapter) {
    await host.openFile(plot!.relPath, open);
    return;
  }
  await host.openFile(chapter.relPath, open);
  if (!host.openBeside || !beside) {
    log.info(`開啟第 ${chapter.order} 章`, chapter.relPath);
    return;
  }
  const ws = new Workspace(c.project);
  let companion = plot?.relPath;
  // 剛建了東西就重推：工程頁那一行的 hasDraft / plotExists 要立刻翻過來。
  let refresh = false;
  if (c.companion === 'draft') {
    companion = await ws.ensureDraft(chapter);
    // 草稿可能是剛建的——與 openDraft 一樣每次都推。
    refresh = true;
  } else if (!companion) {
    const made = await ensureChapterPlot(c.project, ws, chapter);
    companion = made?.rel;
    refresh = !!made?.created;
  }
  if (companion) {
    await host.openBeside(companion, open);
  }
  log.info(`開啟第 ${chapter.order} 章`, `${chapter.relPath}${companion ? ` ｜ 並排 ${companion}` : ''}`);
  if (refresh) {
    await c.pushState();
  }
}

/**
 * 點審稿報告上的引文（五期 W10）：在編輯器裡開啟那一章、選中那一句。
 *
 * 宿主有 `revealText` 就交給它（獨立版選中內建編輯器裡那一段，外掛用 `revealRange`）；沒有就
 * 只開啟檔案，並把那一句寫進提示——作者自己 Ctrl+F 也找得到。能力探測，不判斷是哪個殼。
 */
export async function revealQuote(c: ChatController, relPath: string, quote: string): Promise<void> {
  const host = getHost();
  const clip = quote.replace(/\s+/g, ' ').trim().slice(0, 40);
  if (host.revealText) {
    const found = await host.revealText(relPath, quote);
    if (!found) {
      c.toast(`這一句在現在的正文裡找不到了（正文可能改過）：「${clip}」`, 'error');
    }
    return;
  }
  await host.openFile(relPath);
  c.toast(`在編輯器裡找這一句：「${clip}」`);
}

/** 細綱路徑或章節路徑 → 章號（細綱號 = 章號）。 */
function chapterNoOf(relPath: string): number | undefined {
  const name = basename(relPath);
  return parsePlotFileName(name)?.no ?? parseChapterFileName(name)?.order;
}

/**
 * 類檔案操作。工程頁的 rename/move/delete 走 core/files/fileOps（三區鎖定），
 * 檔案頁的 renameAny/paste 走 core/files/projectFiles（根範圍）。
 * 有逐項結果的動作額外推 filesOpDone，前端據此 remap 編輯器標籤。
 *
 * **細綱單獨分流**：它映象正文的路徑，改名只改標題（有正文時檔名跟著正文不動，沒有時由章號與
 * 標題共同決定），而 `summaries/` 根本不是三個可管理區之一，照走 fileOps 會被
 * 區守衛直接拒掉（新建出來的細綱是純序號名，第一次命名走的正是這條路）。
 */
export async function fileAction(
  c: ChatController,
  msg: Extract<InMessage, { type: 'fileAction' }>
): Promise<void> {
  const { action, relPath, relPaths, op, targetDir } = msg;
  log.info(
    `檔案動作：${action}`,
    [relPath ?? '', relPaths ? relPaths.join('、') : '', targetDir !== undefined ? `目標目錄 ${targetDir || '（根）'}` : '']
      .filter(Boolean)
      .join('｜') || undefined
  );
  let results: FileOpResult[] | undefined;
  // 改名/移動過的路徑。當前創作目標正指著其中某一條時要跟著走，否則創作頁
  // 會拿到一份「這一章找不到」的空殼。
  const moved: { from: string; to: string }[] = [];
  const isPlot = !!relPath && isPlotPath(c.project, relPath);
  switch (action) {
    case 'rename':
      if (relPath) {
        // 兩條路：細綱的檔名由章號與標題決定，其餘是普通檔案。
        const to = isPlot ? await renamePlot(c.project, relPath) : await renameEntry(c.project, relPath);
        if (to) {
          moved.push({ from: relPath, to });
        }
      }
      break;
    case 'renameAny':
      if (relPath) {
        results = [await renameAny(c.project, relPath)];
      }
      break;
    case 'move':
      // 細綱沒有「移動到…」：它映象正文的路徑，單挪它就與正文對不上了（搬正文時它自己跟著走）。
      // 前端不給這一項，這裡兜一層。
      if (relPath && !isPlot) {
        const to = await moveEntry(c.project, relPath, targetDir);
        if (to) {
          moved.push({ from: relPath, to });
        }
      }
      break;
    case 'delete':
      if (relPath) {
        await (isPlot ? deletePlot(c.project, relPath) : deleteEntry(c.project, relPath));
      }
      break;
    case 'paste':
      results =
        op === 'copy'
          ? await copyInto(c.project, relPaths ?? [], targetDir ?? '')
          : await moveInto(c.project, relPaths ?? [], targetDir ?? '');
      break;
  }
  // 複製不動原路徑，目標照舊指著原來那一章，不必跟。
  if (results && op !== 'copy') {
    for (const r of results) {
      if (r.ok && r.to) {
        moved.push({ from: r.from, to: r.to });
      }
    }
  }
  for (const m of moved) {
    await retargetPlot(c, m.from, m.to);
    // 搬的是正文時細綱跟著搬了（handlers/chapter.ts 的 carryPlot）：目標指著那份細綱的也跟上。
    const fromPlot = c.project.plotMirrorOf(m.from);
    const toPlot = c.project.plotMirrorOf(m.to);
    if (fromPlot && toPlot) {
      await retargetPlot(c, fromPlot, toPlot);
    }
  }
  if (results && results.length > 0) {
    c.post({
      type: 'filesOpDone',
      op: action === 'renameAny' ? 'rename' : op === 'copy' ? 'copy' : 'move',
      results,
    });
  }
  await c.pushState();
}
