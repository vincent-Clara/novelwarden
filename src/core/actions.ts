/**
 * 工程級互動流程（初始化、新建一章、粘進現成的一章、新建一本書），命令面板與網頁共用。
 *
 * - 新建一章只落一個純序號名的空細綱，與上一章放在同一個子目錄，不問標題也不開啟；章號取細綱與 `chapters/`
 *   兩邊的最大號 +1。「建完去哪」由呼叫方決定。
 * - `newChapterFlow` 只留給「手裡已有一章現成的文字要粘進來」：先問章節名稱，正文與映象位置的空細綱一起建；
 *   這一章已經排好了細綱的，名字預填它的標題、正文落進它的子目錄。
 * - `createBookAt`（獨立版歡迎頁）在一個目錄下建以書名命名的資料夾（`model/bookDir.ts`）並初始化；同名資料夾
 *   空著就用、有東西或已是一本書就報錯。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { resolveSectionDir, validateName } from './files/fileOps';
import { getHost } from './host';
import { bookDirName } from './model/bookDir';
import { exists, pad3, sanitizeFileName } from './model/fs';
import { Plot, emptyPlotSections } from './model/plotFile';
import { isFallbackChapterTitle } from './model/pipeline';
import { LEGACY_NOVEL_DIRS, NOVEL_DIR, NovelProject } from './model/project';
import { describeError, scoped } from './runtime/logger';
import { Workspace } from './workspace';

const log = scoped('工程');

/**
 * 工程級互動流程的宿主無關實現。
 * 外掛命令面板與獨立版網頁共用這些流程，行為不分叉。
 */

/** 初始化工程：問作品名與作者。defaultTitle 由殼給定（外掛用工作區名，獨立版用目錄名）。 */
export async function initProjectFlow(project: NovelProject, defaultTitle: string): Promise<boolean> {
  if (await project.isInitialized()) {
    getHost().toast('當前目錄已經是小說工程。');
    return false;
  }
  const title = await getHost().input({
    title: '初始化小說工程（1/2）',
    prompt: '作品名',
    value: defaultTitle,
    validate: (v) => (v.trim() ? undefined : '不能為空'),
  });
  if (!title) {
    return false;
  }
  const author = await getHost().input({ title: '初始化小說工程（2/2）', prompt: '作者名（可留空）' });
  // 固定目錄與 manifest 在資料層，幾份空模板經閘道器寫（`mode: 'create'`，已有的不動），見 `Workspace.initializeProject`。
  await new Workspace(project).initializeProject({ title: title.trim(), author: (author ?? '').trim() });
  getHost().toast(`已初始化《${title.trim()}》。`);
  // **不追問「要不要新建第 1 章」**：新工程的第一步是生成小說配置，創作頁的
  // 主按鈕已經明寫著這件事（`deriveBookNextStep`）。這裡再彈一個問句等於給出
  // 第二個入口，而它通向的是一個還沒有架構可依據的空細綱。
  return true;
}

/**
 * 新建一本書（獨立版歡迎頁「新建一本書」「匯入寫好的書」，2026-10-24）：在 `parentDir` 下建一個以書名命名的資料夾
 * （{@link bookDirName}），初始化成小說工程，返回它的絕對路徑。**不開啟它**——開在這個視窗還是新視窗是殼的事。
 *
 * 結果與「開啟資料夾 → 初始化小說工程」一樣（同一份 `initializeProject`），只是一步到位：書名與作者在表單上一次填好，
 * 不再先在目錄選擇器裡建資料夾、再連彈兩個輸入框。同名資料夾已經在：空的就用它；已經是一本書、或者裡面有東西，
 * 一律報錯退出（話直接進 toast），不往作者別的資料夾裡鋪模板（第 3 條）——那種走「開啟資料夾」。
 */
export async function createBookAt(parentDir: string, meta: { title: string; author: string }): Promise<string> {
  const title = meta.title.trim();
  if (!title) {
    throw new Error('書名不能為空。');
  }
  if (!parentDir.trim()) {
    throw new Error('「放在」還空著：選一個放書的資料夾。');
  }
  const name = bookDirName(title);
  if (!name) {
    throw new Error(`「${title}」裡的字都不能當資料夾名，換一個書名。`);
  }
  const root = path.join(path.resolve(parentDir), name);
  let entries: string[] | undefined;
  try {
    entries = await fs.readdir(root);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOTDIR') {
      throw new Error(`${root} 是一個檔案，換個書名或位置。`);
    }
    if (code !== 'ENOENT') {
      throw new Error(`${root} 讀不了（${describeError(err)}）。`);
    }
  }
  if (entries?.some((name) => name === NOVEL_DIR || (LEGACY_NOVEL_DIRS as readonly string[]).includes(name))) {
    throw new Error(`${root} 已經是一本書了，用「開啟資料夾」開啟它。`);
  }
  if (entries && entries.length > 0) {
    throw new Error(`${root} 已經有了，裡面還有別的東西。換個書名或位置；要把它整個當成一本書，用「開啟資料夾」。`);
  }
  // 資料夾不另建：`initializeProject` 的頭一步 `scaffold` 遞迴建 `chapters/` 這幾個固定目錄，書的資料夾連同「放在」
  // 那一路不在的父目錄一併建出來（閘道器之外不多一處直接寫盤，第 7 條）。
  const project = NovelProject.open(root);
  await new Workspace(project).initializeProject({ title, author: meta.author.trim() });
  log.info(`新建了一本書《${title}》`, root);
  return root;
}

/**
 * 新建一章的細綱：**只建一份空骨架**，不問標題、不開啟它。返回相對路徑。
 *
 * 章號取細綱與 `chapters/` 兩邊的最大號 +1（`nextPlotNo`），與上一章落在同一個子目錄，有剛建的空卷就進最新的一卷
 * （分卷的書寫到第二卷時就在 `summaries/第二卷/`；寫正文時正文照它落進 `chapters/第二卷/`）。
 * 正常路徑上細綱是「拆細綱」一批一批生成的；這條留給作者想在末尾手工加一章。
 *
 * ## 為什麼不問標題
 *
 * 新建的那一刻還沒有標題可言：標題是排完細綱、知道這一章要發生什麼之後才
 * 定下來的東西。逼作者先編一個只會換來一個假標題，而它會進檔名、進介面說法、
 * 進上下文。所以先落成純序號名 `007.md`，等他想好了走「重新命名」（序號字首會保留）。
 *
 * ## 為什麼不開啟檔案
 *
 * 接下來該做的是排細綱，不是在一個空檔案裡發呆。「建完去哪」由呼叫方決定：
 * 面板走 `selectPlot`（狀態機把他送到「待寫細綱」），CLI 與命令面板只報一句路徑。
 */
export async function newPlotFlow(project: NovelProject): Promise<string> {
  const no = await project.nextPlotNo();
  const relPath = await new Workspace(project).writePlot({
    no,
    title: '',
    // 手工新建的細綱沒有上游——**upstreamHash 留空**，它才永遠不會掛 ⟳
    // （手寫的產物永不標髒）。
    upstreamHash: '',
    done: false,
    sections: emptyPlotSections(),
  });
  await project.syncManifest();
  getHost().toast(`已新建第 ${no} 章的細綱：${relPath}`);
  return relPath;
}

/**
 * 直接新建一個章節檔案：**先問章節名稱**，正文建出來的同時在它的映象位置配好細綱。不開啟它。
 * 返回正文的相對路徑；作者在輸入框上取消了就是 undefined，什麼都不建。
 *
 * `dir` 是落點目錄（工作區相對路徑，如 `chapters/第一卷`），越界時落在 chapters/ 根下；預設時與新排的細綱
 * 同一個規矩（`subdirForNewChapter`）：有剛建的空卷就進最新的一卷，否則跟上一章放在一起。
 * 序號是全書唯一的下一個——分卷只是收納，不重置編號。
 *
 * 正常路徑上的章節是寫正文時生成的，不是從這裡建的。這條留給「手裡已經有一章
 * 現成的文字，想直接粘進來」——所以建完不把作者送進創作頁，多半他接下來就是
 * 往裡粘正文。
 *
 * ## 名字
 *
 * 2026-10-23 作者要求建之前先問名字（從前不問、一律純序號名）。留空照舊落成純序號名 `007.txt`，以後走「重新命名」再起。
 * 細綱的標題與檔名用同一份清洗過的名字：改名時細綱的標題才認得出是跟著正文走的（`fileOps.retitleCarriedPlot`）。
 *
 * 正文是 `.txt`（2026-10-24 作者定的，所有新建正文一個口徑，見 `Workspace.createChapter`）：純文字不帶標題行，
 * 標題從檔名取；細綱照舊是 `.md`（外掛自己的格式，映象時換副檔名）。
 *
 * ## 細綱
 *
 * - 這一章還沒有細綱：建一份空骨架（與 {@link newPlotFlow} 同一份七節），標題就是這個名字。手工建的沒有上游，
 *   `upstreamHash` 留空、永不掛 ⟳；「關鍵事件」空著就還算空白，批次拆細綱、從已寫正文補齊照樣會填它。
 * - 這一章已經排好了細綱（拆細綱走在正文前面）：名字先填它的標題，`dir` 預設時正文落進它所在的子目錄，不另建——
 *   一章兩份細綱是錯的。名字改了，細綱跟著新正文改名、改標題（{@link attachPlot}）。
 * - 正文的映象位置已經有一份細綱（先前留下的）：認它，不蓋（第 3 條）。
 */
export async function newChapterFlow(project: NovelProject, dir?: string): Promise<string | undefined> {
  const order = await project.nextChapterOrder();
  const plan = await project.getPlot(order);
  const input = await getHost().input({
    title: `新建第 ${order} 章`,
    prompt: plan
      ? `這一章已經有細綱，先填了它的標題｜留空就只用序號 ${pad3(order)}`
      : `章節名稱（同時建一份空細綱）｜留空就只用序號 ${pad3(order)}`,
    placeHolder: '如「夜入青雲」',
    value: plan?.title ?? '',
    validate: (v) => (v.trim() ? validateName(v) : undefined),
  });
  if (input === undefined) {
    return undefined;
  }
  const title = input.trim() ? sanitizeFileName(input) : '';
  const planned = plan ? project.chapterPathForPlot(plan.relPath) : undefined;
  // 沒給落點、也沒有排好的細綱：與新排的細綱同一個規矩——有剛建的空卷就進最新的一卷，否則跟上一章。
  const landing =
    dir ||
    (planned
      ? path.posix.dirname(planned)
      : project.relPath(path.join(project.chaptersDir, await project.subdirForNewChapter(order))));
  const target = resolveSectionDir(project, 'chapters', landing);
  const ws = new Workspace(project);
  const relPath = await ws.createChapter(order, title, '', target);
  const plotRel = await attachPlot(project, ws, relPath, order, title, plan);
  await project.syncManifest();
  getHost().toast(`已新建第 ${order} 章：${relPath}${plotRel ? `，細綱 ${plotRel}` : ''}`);
  return relPath;
}

/**
 * 給剛建的這一章配上細綱，返回它的路徑（配不上是 undefined）。規則見 {@link newChapterFlow}。
 *
 * 排好的那份挪到新正文的映象走閘道器的 `move`（位元組原樣、歷史版本跟著搬），標題走 `retitlePlot`（只改標題兩行）——
 * 都不整份重渲染，作者在細綱裡手加的東西一個字不丟。挪不過去（映象位置已有別的）就兩份都留著、說出來。
 */
async function attachPlot(
  project: NovelProject,
  ws: Workspace,
  chapterRel: string,
  no: number,
  title: string,
  plan: Plot | undefined
): Promise<string | undefined> {
  const mirror = project.plotMirrorOf(chapterRel);
  if (!mirror) {
    return undefined;
  }
  if (!plan) {
    const made = await ensureChapterPlot(project, ws, { relPath: chapterRel, order: no, title });
    if (made && !made.created) {
      log.info('新建章節：映象位置已經有細綱，認它、不另建', mirror);
    }
    return made?.rel;
  }
  let rel = plan.relPath;
  if (mirror !== rel) {
    try {
      await ws.move(rel, mirror);
      rel = mirror;
    } catch (err) {
      log.warn('新建章節：排好的細綱沒能挪到新正文的映象', `${rel} → ${mirror}｜${describeError(err)}`);
      getHost().toast(`第 ${no} 章排好的細綱 ${rel} 沒能跟著新正文改名（${describeError(err)}），兩份都留著。`, 'error');
      return undefined;
    }
  }
  if (title) {
    await ws.retitlePlot(rel, plan.title, title);
  }
  return rel;
}

/**
 * 這一章正文映象位置上的細綱：已經有就認它；沒有就按模板建一份空骨架（與 {@link newPlotFlow} 同一份七節，
 * 標題是這一章的名字，沒有名字的章留空）。返回路徑與是不是剛建的；正文不在章節根下、推不出映象時是 undefined。
 *
 * 新建章節檔案配細綱、工程頁點開一章（細綱並排）、內建編輯器工具欄的「細綱」（2026-10-23）都走這裡。
 */
export async function ensureChapterPlot(
  project: NovelProject,
  ws: Workspace,
  chapter: { relPath: string; order: number; title: string }
): Promise<{ rel: string; created: boolean } | undefined> {
  const mirror = project.plotMirrorOf(chapter.relPath);
  if (!mirror) {
    return undefined;
  }
  if (await exists(project.pathOf(mirror))) {
    return { rel: mirror, created: false };
  }
  // 「第 9 章」是 listChapters 給沒有名字的章的回落值，不是名字，不進細綱的標題與檔名。
  const title = isFallbackChapterTitle(chapter.order, chapter.title) ? '' : chapter.title;
  // 手工新建的細綱沒有上游——upstreamHash 留空，它才永遠不會掛 ⟳（手寫的產物永不標髒）。
  const rel = await ws.writePlot({ no: chapter.order, title, upstreamHash: '', done: false, sections: emptyPlotSections() });
  log.info(`按模板給第 ${chapter.order} 章建了細綱`, rel);
  return { rel, created: true };
}

/** 目錄名當預設作品名。 */
export function dirBaseName(project: NovelProject): string {
  return path.basename(project.root) || '我的小說';
}
