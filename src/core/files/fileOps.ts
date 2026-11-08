import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getHost } from '../host';
import { describeError, scoped } from '../runtime/logger';
import { isMarkdownPath, parseChapterFileName } from '../model/chapterFile';
import { exists, hash, readText, sanitizeFileName } from '../model/fs';
import { NovelProject } from '../model/project';
import { plannedFor } from '../model/threadFile';
import { kindOfPath, normalizeRel } from '../workspace/kind';
import { WsConflictError, WsError, isProtectedPath } from '../workspace/guard';
import { trashPathFor } from '../workspace';
import { Workspace } from '../workspace';

const log = scoped('檔案');

/**
 * 工程頁的類檔案操作：新建資料夾、重新命名、移動、刪除。
 *
 * 三條硬約束：
 *
 * 1. **不越界**：每個操作都鎖在它所屬的區（chapters/ 、characters/ 、lore/）裡。
 *    章節挪不進角色目錄，任何路徑也出不了工程根——`..` 一律拒絕。
 * 2. **不靜默覆蓋**：目標已存在就報錯退出，絕不覆蓋作者的檔案。
 * 3. **不真刪**：刪除是搬進 `.novelwarden/.trash/`，與會話刪除同一套做法。
 *
 * 章節改名/移動時，`drafts/` 裡對應的草稿與 `summaries/` 裡對應的細綱一併搬走（由閘道器的
 * chapter handler 做）——兩樣都不是可管理區，但位置都由章節路徑推導，章節動了就必須跟著動。
 *
 * **細綱走另一條路**（見下面的 `renamePlot` / `deletePlot`）：它映象正文的路徑，改名改的是標題——
 * 還沒有正文時檔名跟著標題、章號字首不動，有正文時檔名跟著正文不動，那不是「改個檔名」能表達的事。
 */

/** 三個可管理的區。每個區有自己的根目錄，操作不跨區。 */
export type Section = 'chapters' | 'characters' | 'lore';

export interface SectionInfo {
  section: Section;
  /** 該區根目錄的工作區相對路徑。 */
  root: string;
  /** 該區根目錄的絕對路徑。 */
  rootAbs: string;
  label: string;
}

export function sectionRoots(project: NovelProject): SectionInfo[] {
  return [
    { section: 'chapters', root: project.relPath(project.chaptersDir), rootAbs: project.chaptersDir, label: '章節' },
    {
      section: 'characters',
      root: project.relPath(project.charactersDir),
      rootAbs: project.charactersDir,
      label: '角色',
    },
    { section: 'lore', root: project.relPath(project.loreDir), rootAbs: project.loreDir, label: '设定' },
  ];
}

/** 某個相對路徑屬於哪個區。不在任何區裡（或越界）時返回 undefined。 */
export function sectionOf(project: NovelProject, relPath: string): SectionInfo | undefined {
  const normalized = normalizeRel(relPath);
  if (normalized === undefined) {
    return undefined;
  }
  return sectionRoots(project).find((s) => normalized === s.root || normalized.startsWith(`${s.root}/`));
}

/**
 * 「在這個目錄裡新建」的落點收斂：給定的目錄必須落在該區內，
 * 否則退回區根目錄。新建類流程都經這裡，`dir` 越界不會把檔案寫到工程外面去。
 */
export function resolveSectionDir(project: NovelProject, section: Section, dir?: string): string {
  const info = sectionRoots(project).find((s) => s.section === section)!;
  return resolveDirWithin(info, dir) ?? info.root;
}

/**
 * 把使用者/前端給來的相對路徑收斂為「工程內的、用正斜槓的」相對路徑。
 * 絕對路徑、`..` 逃逸、空路徑一律返回 undefined。
 *
 * 實現搬進了 `workspace/kind.ts`（閘道器的第一條守衛要用同一份口徑），
 * 這裡保留匯出名，呼叫方不動。
 */
export { normalizeRel };

/**
 * 工程的固定目錄：改名/搬走會讓工程結構散架（章節索引、草稿映象、
 * 後設資料與會話）。檔案頁的根範圍操作對這些路徑一律拒絕。
 *
 * 實現搬進了 `workspace/guard.ts`（守衛第 3 條），這裡保留匯出名。
 */
export { isProtectedPath };

// ---------------------------------------------------------------- 新建資料夾

/**
 * 在某個區裡新建資料夾。`parentRel` 預設為該區根目錄。
 * 返回新目錄的相對路徑；使用者取消或失敗返回 undefined。
 */
export async function newFolder(
  project: NovelProject,
  section: Section,
  parentRel?: string
): Promise<string | undefined> {
  const info = sectionRoots(project).find((s) => s.section === section)!;
  const parent = resolveDirWithin(info, parentRel) ?? info.root;
  // 章節根下的一級目錄就是一卷（2026-10-23）：「章節」頁籤右鍵「新建卷…」走這裡，說法換成卷。
  const volume = section === 'chapters' && parent === info.root;

  const name = await getHost().input({
    title: volume ? '新建卷' : '新建資料夾',
    prompt: volume ? `卷名（建在 ${parent}/ 下，接下來新建的章預設落進最新的一卷）` : `在 ${parent}/ 下新建資料夾`,
    placeHolder: volume ? '如「第二卷」' : '如「第一卷」',
    validate: (v) => validateName(v),
  });
  if (!name) {
    return undefined;
  }

  const rel = `${parent}/${sanitizeFileName(name)}`;
  // 經閘道器建（第 7 條）：落點過守衛——出不了工程根、建不進回收站 / 會話目錄 / 歷史版本；已有同名（目錄或檔案）就拒絕。
  try {
    await new Workspace(project).mkdir(rel);
  } catch (err) {
    const why = err instanceof WsError && err.code === 'exists' ? `已存在：${rel}` : describeWsError(err);
    log.warn(`新建資料夾被拒：${why}`, rel);
    getHost().toast(why, 'error');
    return undefined;
  }
  log.info(`已新建${volume ? '卷' : '資料夾'} ${rel}`);
  getHost().toast(volume ? `已新建卷 ${rel}，接下來新建的章預設落進這一卷` : `已新建資料夾 ${rel}`);
  return rel;
}

// ---------------------------------------------------------------- 細綱
//
// 細綱**不是**可管理區：它映象正文的相對路徑（`summaries/第一卷/003-深处.md` 跟著
// `chapters/第一卷/003-深处.txt`），還沒有正文時檔名由「章號 + 標題」決定。挪到別處它就與正文
// 對不上了，所以改名與刪除繞開 resolveTarget 那套區守衛，交給閘道器的領域寫入器做；也沒有
// 「移動到…」——搬正文時它自己跟著走（`handlers/chapter.ts` 的 `carryPlot`）。

/**
 * 這個路徑是不是一份細綱。工程頁的 rename/move/delete 據此分流。
 *
 * 判定在 `workspace/kind.ts` 的種類表裡，這裡只轉發。
 */
export function isPlotPath(project: NovelProject, relPath: string): boolean {
  return kindOfPath(project, relPath).kind === 'plot';
}

/**
 * 重新命名一份細綱：改的是**標題**，返回它（可能變了的）路徑。
 *
 * - **還沒有正文**：章號字首由 `writePlot` 保留，檔名跟著新標題走。手工新建的細綱是純序號名
 *   （`007.md`，標題要等細綱排完才定），所以這條路也是「給這一章起個名字」的第一次命名入口。
 * - **這一章已經有正文**：細綱映象正文的路徑，檔名跟著正文**不動**，只換細綱裡的標題。
 *   **正文不跟著改名**：那是作者的檔案，要改就在章節那一行上改（細綱會跟著正文搬過去）。
 */
export async function renamePlot(project: NovelProject, relPath: string): Promise<string | undefined> {
  const plot = await project.readPlot(relPath);
  if (!plot) {
    log.warn(`重新命名被拒：找不到細綱 ${relPath}`);
    getHost().toast('找不到這份細綱，可能剛被改名或刪除。', 'error');
    return undefined;
  }
  const mirrored = (await project.listChapters()).some((c) => project.plotPathForChapter(c.relPath) === plot.relPath);

  const input = await getHost().input({
    title: `重新命名第 ${plot.no} 章的細綱`,
    prompt: mirrored
      ? `這一章已經有正文，細綱的檔名跟著正文不變，只改標題｜當前：${relPath}`
      : `章號字首會保留｜當前：${relPath}`,
    value: plot.title,
    validate: (v) => validateName(v),
  });
  if (input === undefined || input.trim() === plot.title) {
    return undefined;
  }

  // 走 workspace.writePlot 而不是 fs.rename：落點由它定（有正文就是正文的映象，否則由章號與
  // 標題共同決定），舊檔案由它清掉。
  const to = await new Workspace(project).writePlot({ ...plot, title: input.trim() });
  await project.syncManifest();
  project.invalidate();
  log.info(`已重新命名第 ${plot.no} 章的細綱`, `${relPath} → ${to}`);
  getHost().toast(to === relPath ? `已改標題：${input.trim()}` : `已重新命名：${to}`);
  return to;
}

/**
 * 刪一章的細綱：搬進 `.trash/`。**正文不受影響。** 它寫進敘事線裡的那一章的計劃事件一起刪（閘道器的 `deletePlot`，第 28 條
 * 「計劃事件隨細綱走」），確認框上先說有幾條（第 3 條：刪之前給一個判斷的機會）。
 */
export async function deletePlot(project: NovelProject, relPath: string): Promise<boolean> {
  const plot = await project.readPlot(relPath);
  if (!plot) {
    log.warn(`刪除被拒：找不到細綱 ${relPath}`);
    getHost().toast('找不到這份細綱，可能剛被改名或刪除。', 'error');
    return false;
  }
  const plans = plannedFor(await project.readThreads(), plot.no).length;

  const pick = await getHost().confirm(`刪除第 ${plot.no} 章的細綱${plot.title ? `《${plot.title}》` : ''}？`, ['刪除'], {
    modal: true,
    detail: [
      // 說出來免得作者以為正文也沒了。
      '這一章的正文不受影響。',
      ...(plans > 0 ? [`它寫進敘事線裡的 ${plans} 條計劃（第 ${plot.no} 章）一起刪掉，各條線改之前存一版歷史。`] : []),
      '會移到 .novelwarden/.trash/，可手動找回。',
    ].join('\n'),
  });
  if (pick !== '刪除') {
    log.info(`使用者取消了刪除 ${relPath}`);
    return false;
  }

  await new Workspace(project).deletePlot(relPath);
  await project.syncManifest();
  project.invalidate();
  log.info(`已移到回收站：第 ${plot.no} 章的細綱`, relPath);
  getHost().toast(`已移到回收站：${relPath}${plans > 0 ? `；敘事線裡第 ${plot.no} 章的計劃一起刪了` : ''}`);
  return true;
}

// ---------------------------------------------------------------- 重新命名

/**
 * 重新命名檔案或資料夾。改的是**磁碟上的名字**，不動檔案內容——
 * 例外是章節：正文的 `# 標題` 行（見下面 renamedBody 的說明）與跟著搬過去的細綱裡的標題（`retitleCarriedPlot`）。
 *
 * 章節檔案的 `NNN-` 序號字首由重新命名保留：序號決定全書順序，
 * 不該在改個標題時被順手改掉。
 */
export async function renameEntry(project: NovelProject, relPath: string): Promise<string | undefined> {
  return renameEntryImpl(project, relPath, true);
}

/**
 * 工程根範圍的重新命名（檔案頁用）。不再要求路徑在三個管理區內，
 * 但固定目錄受 isProtectedPath 保護；章節的序號字首/H1 同步與草稿跟隨
 * 在路徑確實位於章節區時照常生效。
 */
export async function renameEntryInRoot(project: NovelProject, relPath: string): Promise<string | undefined> {
  return renameEntryImpl(project, relPath, false);
}

async function renameEntryImpl(
  project: NovelProject,
  relPath: string,
  requireSection: boolean
): Promise<string | undefined> {
  const target = requireSection
    ? await resolveTarget(project, relPath)
    : await resolveTargetInRoot(project, relPath);
  if (!target) {
    return undefined;
  }
  const { abs, rel, isDir } = target;

  const base = path.basename(rel);
  const ext = isDir ? '' : path.extname(base);
  const stem = isDir ? base : base.slice(0, base.length - ext.length);
  const isChapterFile = !isDir && target.info?.section === 'chapters';
  // 章節的序號字首單獨拆出來，讓使用者只編輯標題部分。
  const prefixMatch = isChapterFile ? /^(\d{1,5}[-_.\s]*)(.*)$/.exec(stem) : null;
  const prefix = prefixMatch ? prefixMatch[1] : '';
  const editable = prefixMatch ? prefixMatch[2] : stem;
  // 序號寫進對話方塊標題：「重新命名第 12 章」比「重新命名檔案」更認得出改的是誰。
  // 未命名的章節（純序號名 `007.md`）走的正是這條路，那時 editable 是空串，
  // 對話方塊等於「給這一章起個名字」——流水線新建之後的第一次命名。
  const order = isChapterFile ? parseChapterFileName(base)?.order : undefined;

  const input = await getHost().input({
    title: order !== undefined ? `重新命名第 ${order} 章` : isDir ? '重新命名資料夾' : '重新命名檔案',
    prompt: prefix ? `序號字首「${prefix}」會保留` : `當前：${rel}`,
    value: editable,
    validate: (v) => validateName(v),
  });
  if (input === undefined || input.trim() === editable) {
    return undefined;
  }

  const nextStem = sanitizeFileName(input);
  // 序號後面沒有分隔符（純序號名 `007.md`）時補一個 `-`，不然拼出來是
  // `007夜入青云.md`——解析得出來，但與外掛自己建章節的命名規矩不一致。
  const sep = prefix && nextStem && !/[-_.\s]$/.test(prefix) ? '-' : '';
  const nextRel = `${path.posix.dirname(rel)}/${prefix}${sep}${nextStem}${ext}`;
  if (nextRel === rel) {
    return undefined;
  }
  // 先改內容再改名：改名成功後內容一定是對的，反過來則可能留下半吊子狀態。
  // 用清洗後的 nextStem 而不是使用者原樣輸入，H1 才會繼續與檔名一致，
  // 下次改名時仍然認得出「這個 H1 是跟著檔名走的」。
  //
  // 只對 markdown 家族做：.txt 章節的標題本來就只取檔名，往裡寫一行 `# x`
  // 是憑空多出來的 markdown 痕跡；.json 章節則是直接寫壞檔案。
  //
  // 經閘道器寫（覆蓋之前舊內容先存一版歷史、大小守衛照過），不彈覆蓋審閱：新名字是作者剛在輸入框裡起的。
  // chapter handler 寫完只同步 manifest，**不碰這一章細綱上的 `writtenFrom`**——那一環只在生成落盤時由
  // `recordWrittenFrom` 記（與編輯器儲存正文同一條路），掛著 ⟳ 的章改個名照樣掛著（第 18 條）。
  //
  // 不留下「標題改了、檔名沒改」的半截（第 3 條），分三道：
  // 1. 寫標題之前先問閘道器搬不搬得成（`checkMove`：與 `move` 同一套守衛，外加細綱那一側不會撞——細綱要跟著正文改名，
  //    第 8 條），搬不成就什麼都不動、直接報錯；
  // 2. 閘道器拒寫標題（如正文超過 2 MB）就整個不改名；
  // 3. 寫完標題之後 `move` 仍然失敗（預檢與搬家之間別處剛建了同名檔案）：把正文改回原樣再報錯，改不回去就照實說。
  const ws = new Workspace(project);
  let titled: { body: string; updated: string } | undefined;
  if (!isDir && target.info?.section === 'chapters' && isMarkdownPath(rel)) {
    const body = await readText(abs);
    const updated = renamedBody(body, editable, nextStem);
    if (updated !== body) {
      try {
        await ws.checkMove(rel, nextRel, { plot: true });
        await ws.write(rel, { text: updated }, { mode: 'overwrite', review: false });
      } catch (err) {
        log.warn(`重新命名被拒：${describeWsError(err)}`, `${rel} → ${nextRel}`);
        getHost().toast(describeWsError(err), 'error');
        return undefined;
      }
      titled = { body, updated };
      log.debug(`正文裡的 # 標題跟著改名同步`, `「${editable}」→「${nextStem}」`);
    }
  }

  // 經閘道器搬：同名不覆蓋、固定目錄保護、草稿跟隨、manifest 同步都在那一層。
  // 正文的細綱由 `carryPlot` 跟著搬；搬完再把細綱裡的標題改成新名（`retitleCarriedPlot`），只認真跟過去的那一份。
  const plotFrom = isChapterFile ? project.plotMirrorOf(rel) : undefined;
  const hadPlot = !!plotFrom && (await exists(project.pathOf(plotFrom)));
  try {
    await ws.move(rel, nextRel);
  } catch (err) {
    const why = describeWsError(err);
    if (titled) {
      const notRestored = await restoreTitle(project, ws, rel, titled.body, titled.updated);
      if (notRestored) {
        log.error(`改名沒成，正文的標題行也沒能改回「# ${editable}」：${rel}`, `${rel} → ${nextRel}｜${why}｜沒改回去：${notRestored}`);
        getHost().toast(
          `改名沒成（${why}），${rel} 的標題行也沒能改回「# ${editable}」：${notRestored}。請開啟它看一眼第一行。`,
          'error'
        );
        return undefined;
      }
      log.warn(`重新命名被拒：${why}`, `${rel} → ${nextRel}｜正文的標題行已改回「# ${editable}」`);
    } else {
      log.warn(`重新命名被拒：${why}`, `${rel} → ${nextRel}`);
    }
    getHost().toast(why, 'error');
    return undefined;
  }
  log.info(`已重新命名${isDir ? '資料夾' : ''}`, `${rel} → ${nextRel}`);
  const plotNote = hadPlot ? await retitleCarriedPlot(project, ws, plotFrom!, nextRel, editable, nextStem) : '';
  getHost().toast(`已重新命名為 ${nextRel}${plotNote}`);
  return nextRel;
}

/**
 * 章節改名之後，跟著搬過去的細綱把標題也改成新名（`Workspace.retitlePlot`），返回接在提示後面的半句。
 *
 * 工程頁那一行先認細綱的標題，只搬檔案不改標題，改完名那一行還掛著舊名字。細綱的標題與正文的舊名不一樣時
 * 不動（作者在細綱上單獨起過）、說出來；細綱沒跟過來（新位置已有一份，`carryPlot` 已經報過）就什麼都不做。
 * 改標題失敗不算改名失敗：正文與細綱都已經搬好了，記一條 warn、照實說。
 */
async function retitleCarriedPlot(
  project: NovelProject,
  ws: Workspace,
  plotFrom: string,
  chapterTo: string,
  from: string,
  to: string
): Promise<string> {
  const plotTo = project.plotMirrorOf(chapterTo);
  if (!plotTo || plotTo === plotFrom || (await exists(project.pathOf(plotFrom))) || !(await exists(project.pathOf(plotTo)))) {
    return '';
  }
  try {
    const r = await ws.retitlePlot(plotTo, from, to);
    if (r === 'kept') {
      const title = (await project.readPlot(plotTo))?.title ?? '';
      log.info('細綱的標題是另起的，沒跟著正文改名', `${plotTo}｜「${title}」`);
      return `；細綱的標題「${title}」是另起的，沒跟著改`;
    }
    if (r === 'retitled') {
      log.info('細綱的標題跟著正文改名', `${plotTo}｜「${from}」→「${to}」`);
    }
    return '';
  } catch (err) {
    log.warn('細綱的標題沒能跟著改', `${plotTo}｜${describeWsError(err)}`);
    return `；細綱的標題沒能跟著改（${describeWsError(err)}）`;
  }
}

/**
 * 章節改名寫完 `# 標題` 行之後搬家沒成：把正文改回原樣（經閘道器，不彈審閱）。改回去了給 undefined，否則給一句原因。
 *
 * 只在正文還在原處、而且還是剛才寫下去的那一份時改：不在原處說明搬家其實已經把它搬走了，在原處寫等於憑空多出一章；
 * 內容變過說明這期間有人改過它，拿改名之前那一版蓋回去會吞掉那幾筆（第 3 條）——`baseHash` 樂觀鎖攔住。
 */
async function restoreTitle(
  project: NovelProject,
  ws: Workspace,
  rel: string,
  original: string,
  written: string
): Promise<string | undefined> {
  if (!(await exists(project.pathOf(rel)))) {
    return `${rel} 已經不在原處`;
  }
  try {
    await ws.write(rel, { text: original }, { mode: 'overwrite', review: false, baseHash: hash(written) });
    return undefined;
  } catch (err) {
    return err instanceof WsConflictError ? `這期間它又被改過，沒有拿改名之前那一版蓋掉` : describeWsError(err);
  }
}

/**
 * 閘道器的拒絕 → 工程頁的一句人話。
 *
 * 逐字保留原來那幾條文案：`已存在同名項：X` 是作者最常撞見的一條，
 * 換了措辭他會以為是另一個毛病。
 */
function describeWsError(err: unknown): string {
  if (err instanceof WsError) {
    return err.code === 'exists' ? `已存在同名項：${err.message.replace(/^已存在：/, '')}` : err.message;
  }
  return describeError(err);
}

/**
 * 章節改名時同步正文裡的 `# 標題` 行——但**只在它與舊檔名一致時**。
 *
 * 兩者一致說明作者從沒單獨改過標題，把它們繼續保持同步是他要的；
 * 一旦不一致，那個 H1 就是作者手寫的東西，改名不該動它。
 */
export function renamedBody(body: string, oldTitle: string, newTitle: string): string {
  if (!oldTitle || oldTitle === newTitle) {
    return body;
  }
  const m = /^(\s*)#\s+(.+?)[ \t]*(\r?\n|$)/.exec(body);
  if (!m || m[2].trim() !== oldTitle.trim()) {
    return body;
  }
  return `${m[1]}# ${newTitle}${m[3]}${body.slice(m[0].length)}`;
}

// ---------------------------------------------------------------- 移動

/**
 * 把檔案或資料夾移到同區的另一個目錄下。
 * `targetDir` 預設時彈目錄選擇（含該區根目錄）。
 */
export async function moveEntry(
  project: NovelProject,
  relPath: string,
  targetDir?: string
): Promise<string | undefined> {
  const target = await resolveTarget(project, relPath);
  if (!target) {
    return undefined;
  }
  const { rel, info, isDir } = target;

  let destRel = targetDir === undefined ? undefined : resolveDirWithin(info, targetDir);
  if (targetDir !== undefined && destRel === undefined) {
    log.warn(`移動被拒：目標目錄不在「${info.label}」區裡`, `${rel} → ${targetDir}`);
    getHost().toast(`目標目錄不在「${info.label}」區裡：${targetDir}`, 'error');
    return undefined;
  }
  if (destRel === undefined) {
    destRel = await pickDestination(project, info, rel, isDir);
    if (destRel === undefined) {
      return undefined;
    }
  }

  const currentParent = path.posix.dirname(rel);
  if (destRel === currentParent) {
    getHost().toast('已經在這個目錄裡了。');
    return undefined;
  }
  // 目錄不能移進自己的子孫裡——那會把這棵子樹從檔案系統上摘下來。
  if (isDir && (destRel === rel || destRel.startsWith(`${rel}/`))) {
    log.warn(`移動被拒：不能把資料夾移進自己裡面`, `${rel} → ${destRel}`);
    getHost().toast('不能把資料夾移動到它自己裡面。', 'error');
    return undefined;
  }
  if (!(await exists(project.pathOf(destRel)))) {
    log.warn(`移動被拒：目標目錄不存在 ${destRel}`);
    getHost().toast(`目標目錄不存在：${destRel}`, 'error');
    return undefined;
  }

  const nextRel = `${destRel}/${path.basename(rel)}`;
  const nextAbs = project.pathOf(nextRel);
  if (await exists(nextAbs)) {
    log.warn(`移動被拒：目標目錄裡已有同名項 ${nextRel}`);
    getHost().toast(`目標目錄裡已有同名項：${nextRel}`, 'error');
    return undefined;
  }

  try {
    await new Workspace(project).move(rel, nextRel);
  } catch (err) {
    log.warn(`移動被拒：${describeWsError(err)}`, `${rel} → ${nextRel}`);
    getHost().toast(describeWsError(err), 'error');
    return undefined;
  }
  log.info(`已移動${isDir ? '資料夾' : ''}`, `${rel} → ${nextRel}`);
  getHost().toast(`已移動到 ${nextRel}`);
  return nextRel;
}

// 草稿跟隨搬進了 `core/workspace/handlers/chapter.ts` 的 `carryDraft`：
// 章節改名/移動經閘道器走，伴生動作由 handler 做一次，不再在這裡各做一份。

async function pickDestination(
  project: NovelProject,
  info: SectionInfo,
  rel: string,
  isDir: boolean
): Promise<string | undefined> {
  const folders = await project.listFolders(info.rootAbs);
  const candidates = [info.root, ...folders].filter(
    // 自己和自己的子孫都不能當落點。
    (dir) => !(isDir && (dir === rel || dir.startsWith(`${rel}/`)))
  );
  const currentParent = path.posix.dirname(rel);
  return getHost().pick(
    candidates.map((dir) => ({
      label: dir === info.root ? `${info.label}（根目錄）` : dir.slice(info.root.length + 1),
      description: dir === currentParent ? '當前位置' : undefined,
      detail: dir,
      value: dir,
    })),
    `把「${path.basename(rel)}」移動到`
  );
}

// ---------------------------------------------------------------- 刪除

/**
 * 刪除檔案或資料夾：搬進 `.novelwarden/.trash/`，不真刪。
 * 目錄連同裡面的東西整體搬走，垃圾箱裡保留原來的相對路徑以便找回。
 */
export async function deleteEntry(project: NovelProject, relPath: string): Promise<boolean> {
  const target = await resolveTarget(project, relPath);
  if (!target) {
    return false;
  }
  const { rel, info, isDir } = target;

  const detail = isDir ? await describeFolder(project, rel) : undefined;
  // 草稿不跟著刪——那是作者另寫的東西，刪正文不代表要連草稿一起丟。
  // 但得說一句，否則「刪了這一章」之後草稿還在，下次看見會以為鬧鬼。
  const draftNote = await describeDraft(project, rel, info.section);
  const pick = await getHost().confirm(`刪除${isDir ? '資料夾' : ''}「${path.basename(rel)}」？`, ['刪除'], {
    modal: true,
    detail: [detail, draftNote, '會移到 .novelwarden/.trash/，可手動找回。'].filter(Boolean).join('\n'),
  });
  if (pick !== '刪除') {
    log.info(`使用者取消了刪除 ${rel}`);
    return false;
  }

  // 經閘道器刪：搬進 `.trash/` 並保留原相對路徑、章節還要 syncManifest，
  // 都在那一層。**草稿不跟著刪**（第 10 條）——上面的確認框已經說過了。
  try {
    await new Workspace(project).remove(rel);
  } catch (err) {
    log.warn(`刪除被拒：${describeWsError(err)}`, rel);
    getHost().toast(describeWsError(err), 'error');
    return false;
  }
  log.info(`已移到回收站：${rel}`, detail ?? '');
  getHost().toast(`已移到回收站：${rel}`);
  return true;
}

/** 有草稿時在確認框裡說一聲——它不會跟著刪。 */
async function describeDraft(project: NovelProject, rel: string, section: Section): Promise<string | undefined> {
  if (section !== 'chapters') {
    return undefined;
  }
  const draft = project.draftRelPathFor(rel);
  if (!draft || !(await exists(project.pathOf(draft)))) {
    return undefined;
  }
  return `草稿 ${draft} 不會一起刪除。`;
}

/** 刪資料夾前先說清楚裡面有多少東西——整棵子樹一起沒了不該是個意外。 */
async function describeFolder(project: NovelProject, rel: string): Promise<string> {
  const abs = project.pathOf(rel);
  let files = 0;
  let dirs = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8) {
      return;
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        dirs++;
        await walk(path.join(dir, entry.name), depth + 1);
      } else {
        files++;
      }
    }
  };
  await walk(abs, 1);
  if (files === 0 && dirs === 0) {
    return '這個資料夾是空的。';
  }
  return `裡面有 ${files} 個檔案${dirs > 0 ? `、${dirs} 個子資料夾` : ''}，會一併移走。`;
}

// 垃圾箱落點的計算（trashPathFor）在資料層（`model/project.ts`），由 `core/workspace/` 重新匯出：刪除一律經閘道器、
// 會話刪除也用它，「保留原相對路徑、同名加序號」這條規則只該有一份。
export { trashPathFor };

// ---------------------------------------------------------------- 內部工具

interface ResolvedTarget {
  abs: string;
  rel: string;
  info: SectionInfo;
  isDir: boolean;
}

/** 解析操作物件：必須存在、必須在某個區裡、且不能是區的根目錄本身。 */
async function resolveTarget(project: NovelProject, relPath: string): Promise<ResolvedTarget | undefined> {
  const rel = normalizeRel(relPath);
  if (!rel) {
    log.warn(`操作被拒：路徑不合法`, `原始輸入 ${JSON.stringify(relPath)}`);
    getHost().toast('路徑不合法。', 'error');
    return undefined;
  }
  const info = sectionOf(project, rel);
  if (!info) {
    log.warn(`操作被拒：${rel} 不在章節/角色/設定三個區裡`);
    getHost().toast('只能操作章節、角色、設定目錄裡的內容。', 'error');
    return undefined;
  }
  if (rel === info.root) {
    log.warn(`操作被拒：${rel} 是「${info.label}」區的固定根目錄`);
    getHost().toast(`「${info.label}」是工程的固定目錄，不能重新命名或刪除。`, 'error');
    return undefined;
  }

  const abs = project.pathOf(rel);
  let isDir: boolean;
  try {
    isDir = (await fs.stat(abs)).isDirectory();
  } catch {
    log.warn(`操作被拒：找不到 ${rel}（可能剛被改名或刪除）`);
    getHost().toast(`找不到：${rel}`, 'error');
    return undefined;
  }
  return { abs, rel, info, isDir };
}

/** 根範圍解析：路徑合法、不是固定目錄、存在即可（不要求在三區內）。 */
async function resolveTargetInRoot(project: NovelProject, relPath: string): Promise<ResolvedTarget | undefined> {
  const rel = normalizeRel(relPath);
  if (!rel) {
    log.warn(`操作被拒：路徑不合法`, `原始輸入 ${JSON.stringify(relPath)}`);
    getHost().toast('路徑不合法。', 'error');
    return undefined;
  }
  if (isProtectedPath(project, rel)) {
    log.warn(`操作被拒：${rel} 是工程的固定目錄`);
    getHost().toast(`「${rel}」是工程的固定目錄，不能改名或搬走。`, 'error');
    return undefined;
  }
  const abs = project.pathOf(rel);
  let isDir: boolean;
  try {
    isDir = (await fs.stat(abs)).isDirectory();
  } catch {
    log.warn(`操作被拒：找不到 ${rel}（可能剛被改名或刪除）`);
    getHost().toast(`找不到：${rel}`, 'error');
    return undefined;
  }
  // 區外路徑 info 為 undefined：下游用 `target.info?.section` 守衛。
  const info = sectionOf(project, rel);
  return { abs, rel, info: info as SectionInfo, isDir };
}

/** 把一個「目錄相對路徑」收斂到某個區內；不在區裡返回 undefined。 */
function resolveDirWithin(info: SectionInfo, dirRel?: string): string | undefined {
  if (dirRel === undefined || dirRel.trim() === '') {
    return info.root;
  }
  const rel = normalizeRel(dirRel);
  if (!rel) {
    return undefined;
  }
  return rel === info.root || rel.startsWith(`${info.root}/`) ? rel : undefined;
}

export function validateName(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return '不能為空';
  }
  if (/[\\/]/.test(trimmed)) {
    return '名字裡不能有斜槓';
  }
  if (trimmed === '.' || trimmed === '..') {
    return '這個名字不能用';
  }
  // sanitizeFileName 會把非法字元全刪掉，只剩兜底名——那等於使用者什麼也沒輸入。
  if (/^[\\/:*?"<>|\s]+$/.test(trimmed)) {
    return '名字裡的字元都不能用於檔名';
  }
  return undefined;
}
