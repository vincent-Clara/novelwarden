import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isProtectedPath, normalizeRel, renameEntryInRoot, sectionOf } from './fileOps';
import { isInTrash } from '../workspace/guard';
import { getHost } from '../host';
import { describeError, scoped } from '../runtime/logger';
import { exists } from '../model/fs';
import { NovelProject } from '../model/project';
import { Workspace } from '../workspace';
import { FileOpResult } from '../protocol';

const log = scoped('檔案頁');

/**
 * 檔案頁（資源管理器）的類檔案操作：工程根範圍的重新命名、移動、複製。
 *
 * 與 fileOps.ts 的分工：那邊鎖在章節/角色/設定三個區裡，是工程頁的產品
 * 承諾；這邊面向整個工程根（含 `.novelwarden/`，舊工程是 `.novelforge/`），是檔案頁的磁碟視角。
 * 相同的約束仍然在：
 *
 * 1. **不出工程根**：`..` 逃逸與絕對路徑一律拒絕。
 * 2. **不靜默覆蓋**：目標同名逐項拒絕，其餘項繼續。
 * 3. **固定目錄不動**：chapters/、drafts/、`.novelwarden/`（舊工程 `.novelforge/`）及其關鍵子目錄受保護。
 * 4. **垃圾箱不搬**：`.novelwarden/.trash/`（舊工程 `.novelforge/.trash/`）裡的內容不是操作物件（複製出來可以，見下）。
 *
 * 移動與複製都經閘道器（`Workspace.move` / `Workspace.copy`），守衛、伴生、manifest 同步都在那一層做一次：
 *
 * - **移動**：章節帶草稿與細綱跟隨、manifest 同步；章節被移出 chapters/ 時草稿留在原映象路徑，只記日誌提醒。
 * - **複製**：來源與落點都過守衛——複製不進回收站、會話目錄、歷史版本；會話檔案與工程庫複製不出來；回收站與
 *   歷史版本裡的東西**複製得出來**（讀得到就複製得出來，原件一字不動——在工程裡找回一份的入口）。沒有伴生：
 *   複製一章不帶草稿與細綱（副本是一章新的）；細綱副本去掉定稿那一側的指紋；複製進 chapters/ 的同步 manifest。
 */

/** 工程根範圍的重新命名。逐項結果的形狀與 move/copy 對齊。 */
export async function renameAny(project: NovelProject, relPath: string): Promise<FileOpResult> {
  const from = normalizeRel(relPath) ?? relPath;
  const to = await renameEntryInRoot(project, relPath);
  return to ? { from, to, ok: true } : { from, ok: false };
}

/** 貼上（剪下變體）：把若干檔案/目錄移動到目標目錄。 */
export async function moveInto(
  project: NovelProject,
  sources: string[],
  targetDir: string
): Promise<FileOpResult[]> {
  return pasteAll(project, sources, targetDir, false);
}

/** 貼上（複製變體）：把若干檔案/目錄遞迴複製到目標目錄。 */
export async function copyInto(
  project: NovelProject,
  sources: string[],
  targetDir: string
): Promise<FileOpResult[]> {
  return pasteAll(project, sources, targetDir, true);
}

async function pasteAll(
  project: NovelProject,
  sources: string[],
  targetDir: string,
  copy: boolean
): Promise<FileOpResult[]> {
  // 空串落點 = 工程根目錄；normalizeRel 不收空串，單獨放行。
  const dest = targetDir.trim() === '' ? '' : normalizeRel(targetDir);
  if (dest === undefined) {
    log.warn(`貼上被拒：目標目錄不合法`, `原始輸入 ${JSON.stringify(targetDir)}`);
    getHost().toast('目標目錄不合法。', 'error');
    return sources.map((from) => ({ from, ok: false, error: '目標目錄不合法' }));
  }
  const destAbs = dest === '' ? project.root : project.pathOf(dest);
  let destIsDir = false;
  try {
    destIsDir = (await fs.stat(destAbs)).isDirectory();
  } catch {
    destIsDir = false;
  }
  if (!destIsDir) {
    log.warn(`貼上被拒：目標目錄不存在 ${dest || '（工程根）'}`);
    getHost().toast(`目標目錄不存在：${dest || '（工程根）'}`, 'error');
    return sources.map((from) => ({ from, ok: false, error: '目標目錄不存在' }));
  }

  const results: FileOpResult[] = [];
  let chaptersTouched = false;
  for (const source of sources) {
    const r = await pasteOne(project, source, dest, copy);
    if (r.ok && sectionOf(project, r.from)?.section === 'chapters') {
      chaptersTouched = true;
    }
    results.push(r);
  }

  // 移動章節改了路徑：重算 manifest。複製進 chapters/ 的新章節由 `Workspace.copy` 自己同步過了。
  if (!copy && chaptersTouched) {
    await project.syncManifest();
  }
  project.invalidate();

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    getHost().toast(`${failed.length} 項未${copy ? '複製' : '移動'}：${failed[0].error}`, 'error');
  } else {
    log.info(
      `${copy ? '已複製' : '已移動'} ${results.length} 項`,
      `落點 ${dest === '' ? '（工程根）' : dest}`
    );
    getHost().toast(`已${copy ? '複製' : '移動'} ${results.length} 項到 ${dest === '' ? '工程根目錄' : dest}。`);
  }
  return results;
}

async function pasteOne(
  project: NovelProject,
  relPath: string,
  dest: string,
  copy: boolean
): Promise<FileOpResult> {
  const rel = normalizeRel(relPath);
  if (!rel) {
    log.warn(`貼上被拒：路徑不合法`, `原始輸入 ${JSON.stringify(relPath)}`);
    return { from: relPath, ok: false, error: '路徑不合法' };
  }
  if (isProtectedPath(project, rel)) {
    log.warn(`貼上被拒：${rel} 是工程的固定目錄`);
    return { from: rel, ok: false, error: `「${rel}」是固定目錄` };
  }
  // 回收站裡的東西搬不出來（那是改回收站）；**複製得出來**——閘道器的複製只讀來源（`guardCopySource`）。
  if (!copy && isInTrash(project, rel)) {
    log.warn(`貼上被拒：${rel} 在回收站裡`);
    return { from: rel, ok: false, error: '回收站裡的內容不能操作' };
  }

  const abs = project.pathOf(rel);
  let isDir: boolean;
  try {
    isDir = (await fs.stat(abs)).isDirectory();
  } catch {
    log.warn(`貼上被拒：找不到 ${rel}`);
    return { from: rel, ok: false, error: `找不到 ${rel}` };
  }

  const name = path.basename(rel);
  const nextRel = dest === '' ? name : `${dest}/${name}`;
  if (nextRel === rel) {
    return { from: rel, ok: false, error: '已經在這個目錄裡' };
  }
  // 目錄不能搬進自己的子孫——那會把子樹從檔案系統上摘下來。
  if (isDir && (dest === rel || dest.startsWith(`${rel}/`))) {
    log.warn(`貼上被拒：不能把資料夾放進自己裡面`, `${rel} → ${dest}`);
    return { from: rel, ok: false, error: '不能放進它自己裡面' };
  }
  const nextAbs = project.pathOf(nextRel);
  if (await exists(nextAbs)) {
    log.warn(`貼上被拒：目標已有同名項 ${nextRel}`);
    return { from: rel, ok: false, error: `目標已有同名項 ${nextRel}` };
  }

  try {
    const ws = new Workspace(project);
    if (copy) {
      // 經閘道器複製：來源與落點都過守衛（複製不進回收站 / 會話目錄 / 歷史版本，會話與工程庫複製不出來），
      // 目錄逐個檔案過；位元組原樣；細綱副本去掉定稿那一側的指紋，複製進 chapters/ 的同步 manifest。
      // **複製沒有伴生**：複製一章不該順手把草稿、細綱也複製一份——草稿是作者對原章寫的筆記，細綱是原章的計劃與
      // 檔案，跟著副本走會變成兩份各自漂移的東西（副本是一章新的，第 8 條）。
      await ws.copy(rel, nextRel);
    } else {
      // 經閘道器搬：草稿跟隨、manifest 同步、章節被移出 chapters/ 時的提示
      // 都在 chapter handler 裡做一次。
      await ws.move(rel, nextRel);
    }
  } catch (err) {
    log.warn(`貼上失敗：${rel} → ${nextRel}`, describeError(err));
    return { from: rel, ok: false, error: describeError(err) };
  }

  log.info(`${copy ? '已複製' : '已移動'}${isDir ? '資料夾' : ''}`, `${rel} → ${nextRel}`);
  return { from: rel, to: nextRel, ok: true };
}
