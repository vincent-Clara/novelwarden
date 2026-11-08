/**
 * `NovelProject`：資料訪問層，只讀——寫盤全在 `core/workspace/`（第 7 條）。
 *
 * - 新工程的腳手架：`scaffold` 建固定目錄、`createManifest` 寫 manifest（按設計不走閘道器）；空模板的落點與內容
 *   `newProjectTemplates` 是純資料，寫模板經閘道器的 `Workspace.initializeProject`。不放示例角色卡。
 * - 章節索引（manifest v1）、架構的讀取（`readBookConfig` / `readSettingDoc` / `settingFilled`）。
 * - 細綱按路徑配對（第 8 條）：`listPlots` 遞迴掃 `summaries/`；`plotPathForChapter` / `plotMirrorOf` 算正文的映象、
 *   `chapterPathForPlot` 反推；`plotOfChapter` / `plotFor` / `getPlot` 有正文只認映象那一份、沒有正文按章號認計劃，
 *   `resolvePlot` 不冒認別的正文的細綱。新一章落點 `subdirForNewChapter` / `plotPathOfNo`：跟上一章同一個子目錄，
 *   接在最後、又有一卷還空著時落進那一卷；分卷 `listVolumes` 是章節根下的一級目錄。
 * - 定稿的查詢：`finalizedPlotOf`（`sourceHash` 對得上正文才算），`staleChapters` / `finalizedFacts` 都從它取。
 * - 草稿按章節路徑映象、`nextPlotNo` / `nextChapterNo`、`.novelforge` / `.novel` → `.novelwarden` 的遷移檢測、
 *   各區目錄的遞迴掃描，以及回收站落點 `trashPathFor`（保留原相對路徑、同名加序號，第 6 條；放在這一層是因為
 *   `model/` 不能依賴閘道器）。
 */
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { readConfig } from '../config';
import {
  CHARACTER_SECTION_KEYS,
  Chapter,
  CharacterCard,
  CharacterSections,
  LoreEntry,
  MANIFEST_VERSION,
  NovelConfig,
  ProjectManifest,
} from './types';
import {
  asArray,
  asNumber,
  asNumberArray,
  asString,
  extractH1,
  parseMarkdown,
  pickSections,
  stringifyFrontmatter,
  stringifySections,
  stripH1,
} from './markdown';
import { isChapterFileName, isMarkdownExt, isMarkdownPath, parseChapterFileName } from './chapterFile';
import { Plot, isPlotFileName, parsePlotFile, parsePlotFileName, plotFileName } from './plotFile';
import { loreCategoryOfSlug } from './loreFile';
import { outlineEntriesOf, renderOutline, renderOutlineDoc } from './outlineFile';
import {
  BookConfig,
  SETTING_FILE_DOCS,
  SettingDocFile,
  SettingFileDoc,
  isSettingFilled,
  parseBookConfig,
  parseSettingDoc,
  settingTemplate,
} from './settingFile';
import { SettingDoc, isFallbackChapterTitle, isLoreListFilled } from './pipeline';
import { TIMELINE_FILENAME, ThreadBook, ThreadsMark, UNFILED_FILENAME, parseThreadFile, parseUnfiledFile, threadsMarkOf } from './threadFile';
import { parseTimelineFile } from './timelineFile';
import {
  countWords,
  exists,
  hash,
  isIgnoredDir,
  readText,
  readTextIfExists,
  sanitizeFileName,
  writeText,
} from './fs';
import { FinalizedFacts, parseContinuityFacts } from './continuity';
import { normalizeGender } from './gender';
import { SENSITIVE_FILE_NAME } from './sensitiveWords';

/**
 * 後設資料目錄名。新工程只建這一個。
 *
 * 改名（2026-11）之前的工程還在 `.novelforge/`（0.2.x）或 `.novel/`（0.1.x）裡：
 * 讀寫仍落在舊目錄，遷移要作者確認，**絕不在旁邊新建第二個後設資料目錄**。
 */
export const NOVEL_DIR = '.novelwarden';
/** 舊工程的後設資料目錄名，從新到舊。 */
export const LEGACY_NOVEL_DIRS = ['.novelforge', '.novel'] as const;
const MANIFEST_FILE = 'project.json';
/** 匯出全文的目錄名（工程根下）。 */
const EXPORT_DIR = '导出';

/** 遞迴掃描的深度上限。防禦性的：正常工程不會有這麼深的卷/冊巢狀。 */
const MAX_TREE_DEPTH = 8;

/**
 * 小說工程的資料訪問層。
 *
 * 約定：所有 read* 方法每次都讀盤（作者隨時可能在編輯器裡手改檔案），
 * 只有章節列表做了一層快取，由 FileSystemWatcher 主動失效。
 *
 * ## 一條軸，細綱映象正文的路徑
 *
 * 細綱（`summaries/` 下）**映象正文在章節根下的相對路徑**，副檔名換成 `.md`：
 * `chapters/第一卷/003-深处.txt` ↔ `summaries/第一卷/003-深处.md`，與草稿（`drafts/`）同一套映象。
 * 有正文的章**按路徑**認它的細綱（{@link plotPathForChapter}），定稿反向更新的也是這一份；
 * 還沒有正文的章只有細綱，按檔名的章號認，正文照它的路徑反推著落（{@link chapterPathForPlot}）。
 * 章號仍取檔名數字字首，介面上一律稱「第 N 章」。
 *
 * 從前規劃的單位是「劇情段」、釋出的單位是章，兩條軸之間隔著一箇中轉站（`manuscripts/`）；
 * 一章一綱之後那一層刪掉了。細綱從前另放在 `plots/`、定稿另寫一份單章摘要，兩份併成一份之後
 * `plots/` 也不讀了。老工程磁碟上的 `volumes/`、`manuscripts/`、`plots/` 一個位元組都不動，
 * 這裡只是不再讀它們。
 *
 * 架構層的三份文件（`config.md` / `premise.md` / `world.md`）與大綱、文風同級，
 * 格式定義在 model/settingFile.ts。
 *
 * 章節 / 角色 / 設定三個目錄都是**遞迴掃描**的：作者可以按卷、按陣營
 * 分子目錄整理。角色 / 設定只認 `.md`（那是外掛自己的資料格式）；章節
 * 則認「數字字首 + 非二進位制副檔名」的任意檔案（見 model/chapterFile.ts）。
 * 章節的順序始終由檔名的數字字首決定，與它在哪一層無關。
 */
export class NovelProject {
  private chapterCache: Chapter[] | undefined;
  private plotCache: Plot[] | undefined;

  /**
   * 正在進行的 `listChapters()` / `listPlots()`。
   *
   * 快取只在掃完之後才填得上，所以**併發**的兩個呼叫方都會看到空快取，
   * 各掃一遍全書。`buildProjectTree` 正是這樣：`Promise.all` 裡
   * `listChapters()` 與 `buildPipelineIndex()` 同時起跑，五百章工程於是
   * 把細綱讀了兩遍（流水線一遍、出場索引一遍）。記住這個在途的
   * promise，讓後來者搭同一班車。
   */
  private chapterScan: Promise<Chapter[]> | undefined;
  private plotScan: Promise<Plot[]> | undefined;

  /**
   * 快取的世代號。`invalidate()` 讓它 +1。
   *
   * 光把 `*Scan` 清空不夠：在途的那一輪**仍會跑完**，然後把變更之前的
   * 結果寫進快取，於是剛改過的東西又被舊資料蓋回去。掃描結束時比一下世代號，
   * 對不上就只把結果給等它的人，不落快取。兩條軸共用一個號：`invalidate()`
   * 本來就是「磁碟變過了」這一件事，分開記沒有意義。
   */
  private generation = 0;

  /** 解析出來的後設資料目錄名（見 {@link resolveNovelDirName}）。目錄不在了就重新解析。 */
  private novelDirCache: string | undefined;

  private constructor(public readonly root: string) {}

  /** 以某目錄為工程根開啟例項（不做初始化檢查）。 */
  static open(root: string): NovelProject {
    return new NovelProject(path.resolve(root));
  }

  // ---------------------------------------------------------------- 路徑

  get config(): NovelConfig {
    return readConfig();
  }

  get chaptersDir(): string {
    return path.join(this.root, this.config.chaptersDir);
  }

  /**
   * 草稿根目錄。與 chapters/ 平級的兄弟目錄，**不從 chaptersDir 派生**——
   * 作者把正文目錄改名成 `正文/` 時，草稿仍然落在 `drafts/` 下。
   */
  get draftsDir(): string {
    return path.join(this.root, this.config.draftsDir);
  }

  /**
   * 匯出全文的落點（`features/exportBook.ts`，2026-10-24）：工程根下的 `匯出/`，一本書一份 `<書名>.txt`。不是固定目錄，
   * 用到才建；不掃章節、不進「匯入原稿」的清單——匯出的那份是照章節現拼的副本。
   */
  get exportDir(): string {
    return path.join(this.root, EXPORT_DIR);
  }

  /**
   * 後設資料目錄（`.novelwarden/`，舊工程是 `.novelforge/` 或 `.novel/`）。
   *
   * 解析規則見 {@link resolveNovelDirName}：已存在的目錄優先，新名字只給還沒初始化的工程用。
   * 所有讀寫路徑（細綱、角色卡、設定、會話、回收站……）都從這裡派生，舊工程因此原地可讀寫。
   */
  get novelDir(): string {
    return path.join(this.root, this.resolveNovelDirName());
  }

  /** 這個工程的後設資料目錄用的是哪個名字（`.novelwarden` / `.novelforge` / `.novel`）。 */
  get novelDirName(): string {
    return this.resolveNovelDirName();
  }

  /**
   * 後設資料目錄名的解析：**已經存在的那個優先**，從新到舊。
   *
   * - 舊工程沒遷移：`.novelforge/`（0.2.x）或 `.novel/`（0.1.x）還在，讀寫就落在那兒，
   *   絕不在旁邊新建一個空的 `.novelwarden/`（第 3 條：不靜默覆蓋）。
   * - 一個都沒有：給新名字，初始化（`scaffold` / `createManifest`）才把它建出來。
   *
   * 解析結果快取在例項上，`invalidate()` 清掉（磁碟變過了）；沒有目錄時不快取，
   * 初始化建出目錄之後下一次就能認到。
   */
  private resolveNovelDirName(): string {
    if (this.novelDirCache !== undefined) {
      return this.novelDirCache;
    }
    for (const name of [NOVEL_DIR, ...LEGACY_NOVEL_DIRS]) {
      if (fsSync.existsSync(path.join(this.root, name))) {
        this.novelDirCache = name;
        return name;
      }
    }
    return NOVEL_DIR;
  }

  get manifestPath(): string {
    return path.join(this.novelDir, MANIFEST_FILE);
  }

  get stylePath(): string {
    return path.join(this.novelDir, 'style.md');
  }

  /**
   * 情節大綱的**身份**：磁碟上沒有這份檔案，大綱是各章細綱「梗概」的彙總（{@link readOutline}）；這個路徑給編輯器標籤、
   * MCP 的讀寫與 `@` 引用認它，閘道器接住它的讀寫（docs/design/plans/2026-10-22-outline-from-plots.md）。老工程磁碟上若還有
   * 一份 `outline.md`，不讀、不動。
   */
  get outlinePath(): string {
    return path.join(this.novelDir, 'outline.md');
  }

  /**
   * 敘事線（2026-10-20 重做）：一條線一個檔案 `threads/<線名>.md`，格式見 model/threadFile.ts。可選：沒有這個目錄
   * 就是還沒排過，初始化時不建。七期那一份 `threads.md` 不再認（判 `other`，不讀、不顯示、不刪）。
   */
  get threadsDir(): string {
    return path.join(this.novelDir, 'threads');
  }

  /** 掛不上哪一條線的伏筆（`threads/未归属的伏笔.md`）。保留名：排線、定稿都不許用它當線名。 */
  get unfiledPath(): string {
    return path.join(this.threadsDir, UNFILED_FILENAME);
  }

  /** 故事時間（`threads/时间线.md`，2026-10-24，格式見 model/timelineFile.ts）。也是保留名。同步時第一次推出時間才建。 */
  get timelinePath(): string {
    return path.join(this.threadsDir, TIMELINE_FILENAME);
  }

  /**
   * 本工程的寫作技能（`.novelwarden/skills/<名字>/SKILL.md`）。可選：作者手放進來的，
   * 初始化時不建。我的技能庫在工程外（`~/.novelwarden/skills/`），見 core/skills/。
   */
  get skillsDir(): string {
    return path.join(this.novelDir, 'skills');
  }

  /** 這個工程每個階段綁了哪份技能（`.novelwarden/skills.json`）。沒綁過就沒有這份檔案。 */
  get skillBindingsPath(): string {
    return path.join(this.novelDir, 'skills.json');
  }

  /**
   * 自定義敏感詞表（`.novelwarden/sensitive.txt`，格式見 `model/sensitiveWords.ts`）。可選：作者在內建編輯器裡點
   * 「編輯敏感詞表…」時才建。只給編輯器的寫作體檢用，不進生成鏈。
   */
  get sensitivePath(): string {
    return path.join(this.novelDir, SENSITIVE_FILE_NAME);
  }

  get charactersDir(): string {
    return path.join(this.novelDir, 'characters');
  }

  get loreDir(): string {
    return path.join(this.novelDir, 'lore');
  }

  /** `summaries/`：一章一份的細綱，外加全文大綱 `global.md`。 */
  get summariesDir(): string {
    return path.join(this.novelDir, 'summaries');
  }

  /**
   * 細綱（`.novelwarden/summaries/`）。一章一份，**映象正文的相對路徑**：`chapters/第一卷/012-夜入青云.md`
   * 的細綱是 `summaries/第一卷/012-夜入青云.md`。各級子目錄裡數字開頭的 `.md` 都是細綱，根下的
   * `global.md` 是全文大綱。老工程的 `plots/` 不再掃描——那些檔案一個位元組都不動。
   */
  get plotsDir(): string {
    return this.summariesDir;
  }

  /** 小說配置（`.novelwarden/config.md`）：型別、賣點、規模引數。 */
  get configPath(): string {
    return path.join(this.novelDir, 'config.md');
  }

  /** 故事前提（`.novelwarden/premise.md`）。 */
  get premisePath(): string {
    return path.join(this.novelDir, 'premise.md');
  }

  /** 世界觀（`.novelwarden/world.md`）。 */
  get worldPath(): string {
    return path.join(this.novelDir, 'world.md');
  }

  /** 架構文件的絕對路徑。角色圖譜、設定清單沒有自己的檔案，給的是角色目錄、設定目錄。 */
  settingPath(doc: SettingDoc): string {
    switch (doc) {
      case 'config':
        return this.configPath;
      case 'premise':
        return this.premisePath;
      case 'world':
        return this.worldPath;
      case 'characters':
        return this.charactersDir;
      case 'lore':
        return this.loreDir;
    }
  }

  get sessionsDir(): string {
    return path.join(this.novelDir, 'sessions');
  }

  /** 刪除的東西搬這裡，不真刪。落點（保留原相對路徑、同名加序號）見 {@link trashPathFor}，會話刪除也用它。 */
  get trashDir(): string {
    return path.join(this.novelDir, '.trash');
  }

  /**
   * 歷史版本（`.novelwarden/history/`）：閘道器覆蓋一份創作產物之前存下的舊內容，映象原檔案的相對路徑
   * （佈局與節流見 workspace/history.ts）。是閘道器自己存的副本，不是作者的檔案。
   */
  get historyDir(): string {
    return path.join(this.novelDir, 'history');
  }

  /**
   * 存檔點（`.novelwarden/checkpoints/`）：整本書在某一刻的樣子，按內容定址去重（佈局與保留見
   * workspace/checkpoints.ts）。Novelwarden 自己的內部檔案，介面上只經「存檔點」面板看。
   */
  get checkpointsDir(): string {
    return path.join(this.novelDir, 'checkpoints');
  }

  /** 舊工程的後設資料目錄（絕對路徑），從新到舊。只用於遷移檢測，讀寫都經 {@link novelDir}。 */
  get legacyNovelDirs(): string[] {
    return LEGACY_NOVEL_DIRS.map((name) => path.join(this.root, name));
  }

  get globalSummaryPath(): string {
    return path.join(this.summariesDir, 'global.md');
  }

  /** 正文在章節根下的那段相對路徑（正斜槓）。不在章節根下（配置被改壞等）時 undefined。 */
  private underChapters(chapterRelPath: string): string | undefined {
    const under = path.relative(this.chaptersDir, this.pathOf(chapterRelPath));
    if (!under || under.startsWith('..') || path.isAbsolute(under)) {
      return undefined;
    }
    return under.replace(/\\/g, '/');
  }

  /** 細綱在 `summaries/` 下的那段相對路徑（正斜槓）。不在 `summaries/` 下時 undefined。 */
  private underPlots(plotRelPath: string): string | undefined {
    const under = path.relative(this.plotsDir, this.pathOf(plotRelPath));
    if (!under || under.startsWith('..') || path.isAbsolute(under)) {
      return undefined;
    }
    return under.replace(/\\/g, '/');
  }

  /**
   * 正文（檔案或目錄）→ 細綱那邊的映象（工作區相對路徑，正斜槓）。不在章節根下時 undefined。
   *
   * 檔案：副檔名換成 `.md`（{@link plotPathForChapter} 用的就是它）。
   * 目錄：原樣映象——搬 `chapters/卷一/` 時 `summaries/卷一/` 整棵跟著走（`handlers/chapter.ts` 的 `carryPlot`）。
   * 純計算，不碰磁碟。
   */
  plotMirrorOf(chapterRelPath: string, isDir = false): string | undefined {
    const under = this.underChapters(chapterRelPath);
    if (!under) {
      return undefined;
    }
    const parsed = path.posix.parse(under);
    const mirror = isDir ? under : path.posix.join(parsed.dir, `${parsed.name}.md`);
    return this.relPath(path.join(this.plotsDir, mirror));
  }

  /**
   * 正文 → 它的細綱落在哪（工作區相對路徑，正斜槓）。純計算，檔案可能並不存在。
   *
   * **映象正文在章節根下的相對路徑**，副檔名換成 `.md`（與草稿 {@link draftRelPathFor} 同一套）：
   *   `chapters/第一卷/003-深处.txt` → `.novelwarden/summaries/第一卷/003-深处.md`
   *   `chapters/001 序.txt`          → `.novelwarden/summaries/001 序.md`
   * 同號的兩個檔案（`001 序.txt` 與 `001 正文.txt`）於是各有各的細綱，互不覆蓋。
   * 正文不在章節根下（配置被改壞）時退回 `summaries/NNN.md`，絕不拋。
   */
  plotPathForChapter(chapterRelPath: string): string {
    const mirror = this.plotMirrorOf(chapterRelPath);
    if (mirror) {
      return mirror;
    }
    const order = parseChapterFileName(path.basename(chapterRelPath))?.order ?? 0;
    return this.relPath(path.join(this.plotsDir, plotFileName(order, '')));
  }

  /**
   * 細綱 → 照它寫出來的正文該叫什麼（{@link plotPathForChapter} 的逆運算，副檔名 `.txt`：正文一律出純文字，2026-10-24 作者定的）：
   *   `.novelwarden/summaries/第二卷/010-雪夜.md` → `chapters/第二卷/010-雪夜.txt`
   * 不在 `summaries/` 下的路徑給 undefined。純計算，不碰磁碟。
   */
  chapterPathForPlot(plotRelPath: string): string | undefined {
    const under = path.relative(this.plotsDir, this.pathOf(plotRelPath));
    if (!under || under.startsWith('..') || path.isAbsolute(under)) {
      return undefined;
    }
    const parsed = path.posix.parse(under.replace(/\\/g, '/'));
    return this.relPath(path.join(this.chaptersDir, parsed.dir, `${parsed.name}.txt`));
  }

  /**
   * 還沒有正文、也還沒有細綱的第 N 章落在哪個子目錄（相對章節根與 `summaries/` 的同一段，`''` = 根）：
   *
   * - **接在全書最後、又有一卷還空著**（作者右鍵「新建卷」剛建的，正文與細綱都還沒有）：落進空著的最後一卷
   *   （{@link listVolumes} 的順序）——新的一卷從這一章開始（2026-10-23 作者定：新建的預設放進最新一卷）。
   * - 否則**跟上一章放在一起**。上一章 = 章號比它小的裡面最大的那一章；它有正文看正文所在的子目錄，
   *   只有細綱看細綱所在的子目錄。前面一章都沒有就是根。
   *
   * 分卷的書寫到第二卷時，新排的細綱與新寫的正文於是都落進 `第二卷/`，不會掉回根下；
   * 補中間空著的章號時仍跟上一章，不會被拉進最新的一卷。
   */
  async subdirForNewChapter(no: number): Promise<string> {
    const [plots, chapters, volumes] = await Promise.all([this.listPlots(), this.listChapters(), this.listVolumes()]);
    let best: { no: number; dir: string } | undefined;
    let last = 0;
    const used = new Set<string>();
    const consider = (candidate: number, dir: string | undefined) => {
      last = Math.max(last, candidate);
      if (dir === undefined) {
        return;
      }
      used.add(dir.split('/')[0]);
      if (candidate < no && (!best || candidate > best.no)) {
        best = { no: candidate, dir };
      }
    };
    const written = new Set<number>();
    for (const chapter of chapters) {
      const under = this.underChapters(chapter.relPath);
      written.add(chapter.order);
      consider(chapter.order, under === undefined ? undefined : path.posix.dirname(under));
    }
    for (const plot of plots) {
      const under = this.underPlots(plot.relPath);
      if (!written.has(plot.no)) {
        // 正文在的章看正文：上一輪已經按正文算過了，細綱只補「還沒有正文」的那幾號。
        consider(plot.no, under === undefined ? undefined : path.posix.dirname(under));
      } else if (under !== undefined) {
        // 落點仍看正文，但細綱佔著的卷也不算空。
        used.add(under.split('/')[0]);
      }
    }
    const empty = no > last ? volumes.filter((v) => !used.has(v)) : [];
    if (empty.length > 0) {
      return empty[empty.length - 1];
    }
    const dir = best?.dir ?? '';
    return dir === '.' ? '' : dir;
  }

  /**
   * 還沒有正文、也還沒有細綱的第 N 章，細綱**應該**落在哪：與上一章同一個子目錄
   * （{@link subdirForNewChapter}），`NNN-标题.md`。純推導，檔案並不存在。
   *
   * **回落標題不進檔名**：沒有名字的章（`009.md`）在 `listChapters` 那邊會
   * 拿到「第 9 章」，那是「沒有標題」的樣子而不是標題——拼進去會得到
   * `009-第-9-章.md`，一個憑空的假名字。
   */
  async plotPathForNewChapter(no: number, title = ''): Promise<string> {
    const stem = isFallbackChapterTitle(no, title) ? '' : safeStem(title);
    const dir = await this.subdirForNewChapter(no);
    return this.relPath(path.join(this.plotsDir, dir, plotFileName(no, stem)));
  }

  /**
   * 第 N 章的細綱**應該**在哪：已有就是那一份；有正文就是正文的映象（{@link plotPathForChapter}）；
   * 兩樣都沒有就跟上一章放在一起（{@link plotPathForNewChapter}）。
   *
   * 給「這一章還沒有細綱」時找落點用：介面上要能選中它、切到細綱層去補規劃，那就需要一個
   * 穩定的落點路徑，而且它必須就是之後真正落盤的那一份。
   */
  async plotPathOfNo(no: number, title = ''): Promise<string> {
    const plot = await this.getPlot(no);
    if (plot) {
      return plot.relPath;
    }
    const chapter = await this.getChapter(no);
    return chapter ? this.plotPathForChapter(chapter.relPath) : this.plotPathForNewChapter(no, title);
  }

  /** 絕對路徑 → 工作區相對路徑（正斜槓）。 */
  relPath(absPath: string): string {
    return path.relative(this.root, absPath).replace(/\\/g, '/');
  }

  /** relPath 的逆運算。 */
  pathOf(relPath: string): string {
    return path.join(this.root, relPath);
  }

  /** 這個工程初始化過沒有：`novelDir` 下有沒有 `project.json`。舊目錄裡的工程同樣算初始化過。 */
  async isInitialized(): Promise<boolean> {
    return exists(this.manifestPath);
  }

  /** 只有舊目錄、沒有新目錄時為真——需要遷移。`.novelforge/`（0.2.x）與 `.novel/`（0.1.x）都算。 */
  async needsMigration(): Promise<boolean> {
    if (await exists(path.join(this.root, NOVEL_DIR))) {
      return false;
    }
    return (await this.legacyDirToMigrate()) !== undefined;
  }

  /** 該搬到 `.novelwarden/` 的那個舊目錄（從新到舊；只認有 manifest 的）。 */
  private async legacyDirToMigrate(): Promise<string | undefined> {
    for (const dir of this.legacyNovelDirs) {
      if (await exists(path.join(dir, MANIFEST_FILE))) {
        return dir;
      }
    }
    return undefined;
  }

  /**
   * 把舊目錄整體搬到 `.novelwarden/`（`.novelforge/` 優先，其次 `.novel/`）。
   * 用 rename 而非複製，避免留下兩份會各自漂移的後設資料。沒有可遷移的目錄、或新目錄
   * 已經存在（不能往已有的目錄上 rename）時什麼也不做——**絕不刪除、絕不合併**。
   */
  async migrateLegacyDir(): Promise<void> {
    if (fsSync.existsSync(path.join(this.root, NOVEL_DIR))) {
      return;
    }
    const from = await this.legacyDirToMigrate();
    if (!from) {
      return;
    }
    await fs.rename(from, path.join(this.root, NOVEL_DIR));
    this.novelDirCache = undefined;
    this.invalidate();
  }

  invalidate(): void {
    this.chapterCache = undefined;
    this.plotCache = undefined;
    // 後設資料目錄可能剛被初始化 / 遷移 / 改名（磁碟變過了）：下一次訪問重新解析。
    this.novelDirCache = undefined;
    // 在途的那一輪掃的是**變更之前**的磁碟狀態：不能再讓新呼叫方搭它的車，
    // 世代號 +1 也讓它掃完後不要回填快取（見 generation）。
    this.chapterScan = undefined;
    this.plotScan = undefined;
    this.generation++;
  }

  // ---------------------------------------------------------------- 初始化
  //
  // 新工程分三步，由閘道器的 `Workspace.initializeProject` 串起來：固定目錄（`scaffold`）→ 空模板（經閘道器 `write`，
  // `mode: 'create'`）→ manifest（`createManifest`）。這一層只留後設資料與腳手架——建目錄、寫 `project.json`——以及模板
  // 的落點與內容（純資料）；**寫模板不在這裡**：模板是作者的創作產物，寫盤只經閘道器（AGENTS 第 7 條），而 `model/`
  // 不能反過來依賴閘道器。

  /** 建固定目錄（已有的不動）。不寫任何檔案。 */
  async scaffold(): Promise<void> {
    for (const dir of [this.chaptersDir, this.charactersDir, this.loreDir, this.summariesDir, this.sessionsDir]) {
      await fs.mkdir(dir, { recursive: true });
    }
  }

  /**
   * 新工程的幾份空模板：架構三件、文風、全文大綱（情節大綱是各章細綱梗概的彙總，沒有檔案）。**只給落點（工作區相對路徑）與內容，不碰磁碟。**
   *
   * 架構三件是結構完整、全是佔位的空模板，`isSettingFilled` 為 false，主按鈕於是從「生成小說配置」開始。
   * **不放示例角色卡**：角色圖譜「有沒有」看 `characters/` 下有沒有卡，一張示例卡會讓新工程一出生就跳過「生成角色圖譜」
   * （卡的格式見 README）。示例設定條目同理（設定清單「有沒有」看 `lore/` 下有沒有條目），何況它的關鍵詞「設定」會被
   * 任何一句帶這兩個字的話命中、混進上下文。
   */
  newProjectTemplates(): { rel: string; text: string }[] {
    return [
      ...SETTING_FILE_DOCS.map((doc) => ({ rel: this.relPath(this.settingPath(doc)), text: settingTemplate(doc) })),
      { rel: this.relPath(this.stylePath), text: STYLE_TEMPLATE },
      { rel: this.relPath(this.globalSummaryPath), text: GLOBAL_SUMMARY_TEMPLATE },
    ];
  }

  /** 寫新工程的 manifest（`project.json`）並同步章節索引。有了它 `isInitialized` 才為真。 */
  async createManifest(meta: { title: string; author: string }): Promise<void> {
    this.invalidate();
    const manifest: ProjectManifest = {
      version: MANIFEST_VERSION,
      title: meta.title,
      author: meta.author,
      chapters: [],
    };
    await this.writeManifest(manifest);
    await this.syncManifest();
  }

  // ---------------------------------------------------------------- 章節（釋出區）

  /**
   * 遞迴掃描 chapters/ 下所有章節檔案，按序號排序。
   *
   * **章節是正文的唯一真相**：生成的正文直接落在這裡，定稿、角色卡、設定、
   * 文風全都從這裡讀。
   *
   * 「什麼算章節」由 model/chapterFile.ts 定義：數字字首 + 副檔名不在
   * 二進位制黑名單裡。`001-楔子.md`、`001-楔子.txt`、`001-楔子`（無副檔名）、
   * `004.json` 都算；`001-封面.png` 不算。
   *
   * 子目錄只是給作者分卷用的收納，不參與排序：`卷一/003-x.md` 與
   * `003-x.md` 是同一個「第 3 章」。序號重複時按路徑穩定排序，
   * 讓兩條都出現在樹上（作者能看見衝突，才能去改）。
   */
  async listChapters(): Promise<Chapter[]> {
    if (this.chapterCache) {
      return this.chapterCache;
    }
    // 已經有人在掃了就等它，別再掃一遍。invalidate() 會把這個控制代碼一起清掉，
    // 所以「掃到一半磁碟變了」的那一輪不會被後來者當成新鮮結果。
    if (this.chapterScan) {
      return this.chapterScan;
    }
    this.chapterScan = this.scanChapters();
    try {
      return await this.chapterScan;
    } finally {
      this.chapterScan = undefined;
    }
  }

  private async scanChapters(): Promise<Chapter[]> {
    const generation = this.generation;
    const chapters: Chapter[] = [];
    for (const abs of await listFilesDeep(this.chaptersDir, isChapterFileName, this.chapterSkipDirs())) {
      const parsed = parseChapterFileName(path.basename(abs));
      if (!parsed) {
        continue; // 容錯優先：accept 與 parse 用同一套規則，理論上到不了這裡
      }
      const raw = await readText(abs);
      const body = raw.trim();
      // 只有 markdown 家族才認 `# 標題`。.txt 正文裡一行「# 分隔」不是標題，
      // 認了它既會頂掉檔名標題，又會把那行留在正文裡。
      const markdown = isMarkdownExt(parsed.ext);
      const title =
        (markdown ? extractH1(body) : undefined) ?? (parsed.stem.trim() || `第 ${parsed.order} 章`);
      chapters.push({
        order: parsed.order,
        title,
        relPath: this.relPath(abs),
        wordCount: countWords(markdown ? stripH1(body) : body),
        // 雜湊的永遠是整份正文（含標題行）——定稿對不對得上靠它，口徑不能變。
        contentHash: hash(body),
      });
    }

    chapters.sort((a, b) => a.order - b.order || a.relPath.localeCompare(b.relPath));
    // 掃的過程中磁碟變過（invalidate 被呼叫）：結果照樣交給等它的人——那是他們
    // 請求時的狀態，不算錯——但不進快取，否則下一次讀會拿到已經過時的全書列表。
    if (generation === this.generation) {
      this.chapterCache = chapters;
    }
    return chapters;
  }

  /**
   * 掃章節時要跳過的目錄（絕對路徑）。
   *
   * `drafts/` 正常情況下是 `chapters/` 的兄弟，本來就掃不到；這裡是
   * `chaptersDir` 被配成 `.` 或空串時的唯一防線——那時草稿會落進章節根，
   * 每份草稿都會變成一章。匯出全文的 `匯出/` 同理（書名是數字開頭的，那份匯出就成了一章）。
   */
  private chapterSkipDirs(): ReadonlySet<string> {
    return new Set([this.draftsDir, this.exportDir]);
  }

  async getChapter(order: number): Promise<Chapter | undefined> {
    return (await this.listChapters()).find((c) => c.order === order);
  }

  /** 讀章節正文（markdown 家族會去掉 `# 標題` 行）。 */
  async readChapterText(chapter: Chapter): Promise<string> {
    const raw = (await readText(this.pathOf(chapter.relPath))).trim();
    return isMarkdownPath(chapter.relPath) ? stripH1(raw) : raw;
  }

  /** 讀章節原始內容（含標題行）。 */
  async readChapterRaw(chapter: Chapter): Promise<string> {
    return (await readText(this.pathOf(chapter.relPath))).trim();
  }

  /**
   * 工程裡能拿來拆的整本 txt（匯入原稿、從參考書學寫法）：`.txt`，**章節檔案、草稿與匯出的全文除外**，按路徑排序。
   * 隱藏目錄照例不掃（`.novelwarden/` 裡沒有作者要匯入的東西）。只列路徑與大小，不讀內容。
   */
  async listImportableTexts(): Promise<{ relPath: string; bytes: number }[]> {
    const chaptersRoot = path.resolve(this.chaptersDir);
    const isTxt = (name: string) => path.extname(name).toLowerCase() === '.txt';
    const out: { relPath: string; bytes: number }[] = [];
    for (const abs of await listFilesDeep(this.root, isTxt, new Set([this.draftsDir, this.exportDir]))) {
      const back = path.relative(chaptersRoot, abs);
      const inChapters = !back.startsWith('..') && !path.isAbsolute(back);
      if (inChapters && isChapterFileName(path.basename(abs))) {
        continue;
      }
      try {
        out.push({ relPath: this.relPath(abs), bytes: (await fs.stat(abs)).size });
      } catch {
        // 列完到 stat 之間被刪了：當沒有。
      }
    }
    return out;
  }

  /** 下一個可用章節序號。 */
  async nextChapterOrder(): Promise<number> {
    const chapters = await this.listChapters();
    return chapters.length === 0 ? 1 : Math.max(...chapters.map((c) => c.order)) + 1;
  }

  // 新建章節（createChapter）搬進了 `core/workspace/`：同名一律報錯退出、
  // 落盤後要 syncManifest，那些是閘道器的活。這一層只留領域查詢。

  // ---------------------------------------------------------------- 草稿

  /**
   * 章節 → 它草稿的工作區相對路徑（正斜槓）。
   *
   * 映象章節在**章節根之下**的那段相對路徑，檔名（含副檔名）原樣沿用：
   *   `chapters/卷一/003-夜访.md` → `drafts/卷一/003-夜访.md`
   *   `chapters/005-手记.txt`     → `drafts/005-手记.txt`
   * 章節不在章節根之下（配置被改壞等）時返回 undefined。
   *
   * 純計算，不碰磁碟——呼叫方常常只是想知道「草稿該在哪」，
   * 而不是「草稿在不在」。
   */
  draftRelPathFor(chapterRelPath: string): string | undefined {
    const under = path.relative(this.chaptersDir, this.pathOf(chapterRelPath));
    if (!under || under.startsWith('..') || path.isAbsolute(under)) {
      return undefined;
    }
    return this.relPath(path.join(this.draftsDir, under));
  }

  // 草稿的按需建立（ensureDraft）搬進了 `core/workspace/`：它是**寫盤**，
  // 而這一層只留領域查詢。路徑推導（draftRelPathFor）留在這裡——
  // 呼叫方常常只是想知道「草稿該在哪」，而不是「草稿在不在」。

  /**
   * 磁碟上已存在的草稿路徑集合（工作區相對路徑）。
   *
   * 走一次遞迴遍歷而不是每章一次 stat：工程頁每次重新整理都要為所有章節判斷
   * 「有沒有草稿」，五百章工程逐個 stat 會把 syscall 翻一倍。
   */
  async listDraftPaths(): Promise<Set<string>> {
    const files = await listFilesDeep(this.draftsDir, () => true);
    return new Set(files.map((abs) => this.relPath(abs)));
  }

  // ---------------------------------------------------------------- manifest

  async readManifest(): Promise<ProjectManifest> {
    try {
      const raw = await readText(this.manifestPath);
      const parsed = JSON.parse(raw) as Partial<ProjectManifest>;
      return {
        version: parsed.version ?? MANIFEST_VERSION,
        title: parsed.title ?? '未命名',
        author: parsed.author ?? '',
        // 讀不出就是空陣列。`syncManifest()` 每次都從磁碟重算，
        // 所以哪怕整份索引丟了，也只是這一次重新整理多讀幾個檔案。
        chapters: parsed.chapters ?? [],
        globalSummaryThrough: parsed.globalSummaryThrough,
        // 敘事線的水位（四期）：原樣帶著，`syncManifest` 重寫索引時才不會把它沖掉；認法在 `threadsMarkOf`（手改壞了不崩）。
        ...(parsed.threadsThrough !== undefined ? { threadsThrough: parsed.threadsThrough } : {}),
        ...(parsed.threadsJudged !== undefined ? { threadsJudged: parsed.threadsJudged } : {}),
      };
    } catch {
      return { version: MANIFEST_VERSION, title: '未命名', author: '', chapters: [] };
    }
  }

  async writeManifest(manifest: ProjectManifest): Promise<void> {
    await writeText(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  /**
   * 用磁碟上的實際章節重新整理 manifest 索引。返回重新整理後的 manifest。
   */
  async syncManifest(): Promise<ProjectManifest> {
    const manifest = await this.readManifest();
    manifest.chapters = (await this.listChapters()).map((chapter) => ({
      file: chapter.relPath,
      order: chapter.order,
      title: chapter.title,
      wordCount: chapter.wordCount,
      contentHash: chapter.contentHash,
    }));
    await this.writeManifest(manifest);
    return manifest;
  }

  /**
   * 這一章定稿過、而且對得上的那份細綱：正文映象的那份細綱的 `sourceHash` 等於正文現在的 `contentHash`。
   * 沒定稿過、或定稿之後正文又改過，都是 undefined。
   */
  async finalizedPlotOf(chapter: Chapter): Promise<Plot | undefined> {
    const plot = await this.plotOfChapter(chapter);
    return plot?.sourceHash && plot.sourceHash === chapter.contentHash ? plot : undefined;
  }

  /**
   * 該定稿還沒定稿的章：有正文，映象的那份細綱沒有對得上的 `sourceHash`（從沒定稿過，或定稿之後正文
   * 又改過）。以細綱 frontmatter 為準，不另記索引。
   *
   * **空章節不算**：那不是「定稿舊了」，是還沒寫。把它們混進來，批次定稿的確認框會報一個
   * 虛高的呼叫次數，而那幾次呼叫只會撞上「這一章是空的，跳過」。
   */
  async staleChapters(): Promise<Chapter[]> {
    const stale: Chapter[] = [];
    for (const chapter of await this.listChapters()) {
      if (chapter.wordCount > 0 && !(await this.finalizedPlotOf(chapter))) {
        stale.push(chapter);
      }
    }
    return stale;
  }

  /**
   * 第 `beforeNo` 章之前、**定稿過**的各章留下的連續性事實，按章號升序。定稿之後正文又改過、
   * 或從沒定稿過的章不收：拿一份過期的事實去判矛盾，判出來的可能正是作者改過的地方。沒有事實的章也不收。
   * 預檢、寫前衝突檢查與裝配器的 `recentFacts` 層共用這一份。
   */
  async finalizedFacts(beforeNo = Number.POSITIVE_INFINITY): Promise<FinalizedFacts[]> {
    const out: FinalizedFacts[] = [];
    const chapters = (await this.listChapters()).filter((c) => c.order < beforeNo && c.wordCount > 0);
    for (const chapter of chapters.sort((a, b) => a.order - b.order)) {
      const plot = await this.finalizedPlotOf(chapter);
      const facts = plot ? parseContinuityFacts(plot.sections.连续性事实) : [];
      if (plot && facts.length > 0) {
        out.push({ no: chapter.order, title: chapter.title, relPath: plot.relPath, facts });
      }
    }
    return out;
  }

  /**
   * 下一個可用**章號**。只看 `chapters/`。空工程給 1。
   */
  async nextChapterNo(): Promise<number> {
    const nos = (await this.listChapters()).map((c) => c.order);
    return nos.length === 0 ? 1 : Math.max(...nos) + 1;
  }

  // ---------------------------------------------------------------- 細綱

  /**
   * 列出全部細綱，按章號升序。
   *
   * 順序由**檔名的數字字首**決定，與章節同一套規則——作者重排順序的
   * 方式就是改檔名字首。號碼撞車（手改重名）時按路徑穩定排序，兩條都留在
   * 列表裡，讓作者看得見衝突。
   *
   * **`summaries/` 下各級子目錄都掃**：細綱映象正文的相對路徑，分卷的書細綱就在卷目錄裡。
   * 根下的 `global.md` 沒有數字字首，天然不在裡面。
   */
  async listPlots(): Promise<Plot[]> {
    if (this.plotCache) {
      return this.plotCache;
    }
    // 與 listChapters 同構：已經有人在掃了就搭它的車。工程頁重新整理時
    // 流水線索引與出場索引會同時要這份列表，各掃一遍等於把細綱讀兩遍。
    if (this.plotScan) {
      return this.plotScan;
    }
    this.plotScan = this.scanPlots();
    try {
      return await this.plotScan;
    } finally {
      this.plotScan = undefined;
    }
  }

  private async scanPlots(): Promise<Plot[]> {
    const generation = this.generation;
    const files = await listFilesDeep(this.plotsDir, isPlotFileName);
    const plots: Plot[] = [];
    for (const abs of files) {
      try {
        plots.push(parsePlotFile(await readText(abs), this.relPath(abs)));
      } catch {
        // 讀盤失敗（許可權、編碼）當作這一章沒有細綱。解析失敗在 parsePlotFile
        // 裡已經退化過一層了，能走到這裡的只有 I/O 異常。
      }
    }
    plots.sort((a, b) => a.no - b.no || a.relPath.localeCompare(b.relPath));
    // 掃的過程中磁碟變過：結果照樣交給等它的人（那是他們請求時的狀態），
    // 但不進快取——否則下一次讀會拿到已經過時的全書列表。
    if (generation === this.generation) {
      this.plotCache = plots;
    }
    return plots;
  }

  /** 讀一章的細綱。沒有不是錯誤——那個路徑可能剛被改名或刪除。 */
  async readPlot(plotRelPath: string): Promise<Plot | undefined> {
    const abs = this.pathOf(plotRelPath);
    try {
      // 直接讀、讀不到才當沒有：省掉一次 stat，也堵掉「查到了、讀之前被
      // 改名了」的競態——作者隨時在手改檔案，那條競態是真會發生的。
      const raw = await readTextIfExists(abs);
      return raw === undefined ? undefined : parsePlotFile(raw, plotRelPath);
    } catch {
      // 讀盤本身失敗（許可權、編碼）當作沒有這份細綱：解析失敗在 parsePlotFile
      // 裡已經退化過一層了，能走到這裡的只有 I/O 異常。
      return undefined;
    }
  }

  /**
   * 按 target 裡的細綱路徑找那一章的細綱。
   *
   * 路徑上那一份正是某一章正文的映象、或者這個號還沒有正文（只有計劃）時就是它；**否則按路徑裡的
   * 章號認這一章現在的那一份**（{@link getPlot}）。
   *
   * 主按鈕給的落點常常是純序號的佔位路徑（`summaries/003.md`——拆細綱那一刻標題還沒定），
   * 而採納時按產物帶的標題落成了 `003-雪夜.md`。之後凡是「按 target 找細綱」的地方
   * 都要認得它：只按路徑讀的話，流水線會說「這一章還沒有細綱」，再採納一次就繞過了
   * 覆蓋審閱（第 3 條）。反過來，路徑上躺著一份**不歸這一章**的細綱（作者在外面給正文改了名，
   * 舊的那份成了孤兒）也不冒認——對話頁與工程頁看到的必須是同一份。作者手裡的檔案路徑
   * （工程頁右鍵、編輯器）不走這裡，那是實打實的路徑。
   */
  async resolvePlot(plotRelPath: string): Promise<Plot | undefined> {
    const no = parsePlotFileNameOf(plotRelPath);
    if (no === undefined) {
      return undefined;
    }
    const [plots, chapters] = await Promise.all([this.listPlots(), this.listChapters()]);
    const rel = plotRelPath.replace(/\\/g, '/');
    const direct = plots.find((p) => p.relPath === rel);
    if (direct) {
      const sameNo = chapters.filter((c) => c.order === direct.no);
      if (sameNo.length === 0 || sameNo.some((c) => this.plotPathForChapter(c.relPath) === direct.relPath)) {
        return direct;
      }
    }
    return this.plotFor(no, plots, chapters);
  }

  /** 第 N 章的細綱（配對規則見 {@link plotFor}）。 */
  async getPlot(no: number): Promise<Plot | undefined> {
    const [plots, chapters] = await Promise.all([this.listPlots(), this.listChapters()]);
    return this.plotFor(no, plots, chapters);
  }

  /** 這一章正文的細綱：正文映象的那一份（{@link plotPathForChapter}）。還沒有就是 undefined。 */
  async plotOfChapter(chapter: Chapter): Promise<Plot | undefined> {
    const rel = this.plotPathForChapter(chapter.relPath);
    return (await this.listPlots()).find((p) => p.relPath === rel);
  }

  /**
   * 第 N 章的細綱，**按路徑配對**：
   *
   * - 有正文：只認正文映象的那一份。沒有就是沒有——作者在外面給正文改了名，那就是一章新的，
   *   舊的細綱不冒認（同號的正文有兩份時認路徑排序第一份，與流水線同一個口徑）。
   * - 還沒有正文：認同號的第一份（計劃），正文照它的路徑反推著落（{@link chapterPathForPlot}）。
   *
   * 手上已經有兩份列表的呼叫方（流水線索引、裝配器）直接用它，免得每章再讀一遍。
   */
  plotFor(no: number, plots: readonly Plot[], chapters: readonly Chapter[]): Plot | undefined {
    const chapter = chapters.find((c) => c.order === no);
    if (chapter) {
      const rel = this.plotPathForChapter(chapter.relPath);
      return plots.find((p) => p.relPath === rel);
    }
    return plots.find((p) => p.no === no);
  }

  /**
   * 每個章號認下的那一份細綱（{@link plotFor}），按章號升序。孤兒（作者在外面給正文改了名，舊細綱
   * 沒人認）不在裡面——敘事線、出場統計、拆細綱區間這些「一章一份」的地方都吃這一份，與工程頁
   * 一行一章的口徑一致。
   */
  pairPlots(plots: readonly Plot[], chapters: readonly Chapter[]): Plot[] {
    const nos = [...new Set(plots.map((p) => p.no))].sort((a, b) => a - b);
    return nos.map((no) => this.plotFor(no, plots, chapters)).filter((p): p is Plot => !!p);
  }

  /** {@link pairPlots} 的讀盤版。 */
  async listChapterPlots(): Promise<Plot[]> {
    const [plots, chapters] = await Promise.all([this.listPlots(), this.listChapters()]);
    return this.pairPlots(plots, chapters);
  }

  /**
   * 下一個可用章號。**跨細綱與 `chapters/` 取最大號再 +1。**
   *
   * 兩邊都要看：只看細綱的話，一個寫了 99 章、從沒用過本工具的老工程會
   * 從第 1 章開始規劃，直接撞上已有的章；只看 `chapters/` 的話，規劃了但還沒寫
   * 的章會被反覆重號。工程頁「新建細綱」用它。
   */
  async nextPlotNo(): Promise<number> {
    const [plots, chapters] = await Promise.all([this.listPlots(), this.listChapters()]);
    const nos = [...plots.map((p) => p.no), ...chapters.map((c) => c.order)];
    return nos.length === 0 ? 1 : Math.max(...nos) + 1;
  }

  // 細綱的寫入（writePlot / deletePlot）搬進了 `core/workspace/`：寫入要記
  // `upstreamHash`，刪除要進 `.trash/`——那些是閘道器的活，不是資料訪問的活。
  // 這一層只留領域查詢。

  // ---------------------------------------------------------------- 架構

  /** 讀小說配置。檔案不在就是一份全空的配置（欄位全部缺席），絕不拋。 */
  async readBookConfig(): Promise<BookConfig> {
    const raw = (await readTextIfExists(this.configPath).catch(() => undefined)) ?? '';
    return parseBookConfig(raw, this.relPath(this.configPath));
  }

  /** 讀前提 / 世界觀（配置也能讀，只取小節）。檔案不在就是全空的小節。 */
  async readSettingDoc(doc: SettingFileDoc): Promise<SettingDocFile> {
    const abs = this.settingPath(doc);
    const raw = (await readTextIfExists(abs).catch(() => undefined)) ?? '';
    return parseSettingDoc(doc, raw, this.relPath(abs));
  }

  /**
   * 架構五件各自填過沒有。全書狀態機的第一格讀它。
   *
   * 角色圖譜沒有自己的檔案，**至少有一張角色卡就算**——作者手寫的卡、從正文裡
   * 提取的卡都算數。設定清單同理（至少一條條目），另外**已經有正文的書一律算填過**
   * （`isLoreListFilled`）：在寫的書的設定從定稿裡長出來，不被推回架構。有正文時連目錄都不必掃。
   *
   * `known` 收呼叫方手上已經讀過的：工程頁一次重新整理裡配置、角色卡、設定條目與章節都已經讀過一遍，
   * 再讀一遍只是多幾次 I/O（`tests/integration/views/projectTreeReads.test.js` 盯著）。
   */
  async settingFilled(known?: {
    config?: BookConfig;
    characters?: CharacterCard[];
    lore?: readonly LoreEntry[];
    chapters?: readonly Chapter[];
  }): Promise<Record<SettingDoc, boolean>> {
    const [config, premise, world, characters, chapters] = await Promise.all([
      known?.config ? { sections: known.config.sections as Record<string, string> } : this.readSettingDoc('config'),
      this.readSettingDoc('premise'),
      this.readSettingDoc('world'),
      known?.characters ?? this.listCharacters(),
      known?.chapters ?? this.listChapters(),
    ]);
    const hasProse = chapters.some((c) => c.wordCount > 0);
    // 只要知道有沒有：不讀條目內容，列一下檔案就夠了。
    const entries = hasProse ? 0 : known?.lore ? known.lore.length : (await listMarkdownDeep(this.loreDir)).length;
    return {
      config: isSettingFilled('config', config.sections),
      premise: isSettingFilled('premise', premise.sections),
      world: isSettingFilled('world', world.sections),
      characters: characters.length > 0,
      lore: isLoreListFilled(entries, hasProse),
    };
  }

  // ---------------------------------------------------------------- 全文大綱 / 敘事線

  /**
   * 全文大綱（原全書摘要）的正文，去掉 H1。老檔案裡「已收伏筆 / 未收伏筆 / 人物關係變動」那三節當認不出的小節，
   * 不讀（敘事線重做：伏筆與關係的變動歸敘事線，同一樣東西只留一份）——檔案一個字不動，裝配與增量更新都看不見它們，
   * 下一次更新只寫「主線進展」。
   */
  async readGlobalSummary(): Promise<string> {
    if (!(await exists(this.globalSummaryPath))) {
      return '';
    }
    return dropRetiredGlobalSections(stripH1(parseMarkdown(await readText(this.globalSummaryPath)).body));
  }

  /**
   * 敘事線目錄裡的檔案（工作區相對路徑，只列不讀）：`threads/` 這一層的 `.md`，各條線按檔名排在前，
   * 「未歸屬的伏筆」「時間線」（有的話）排在最後。線不分子目錄，更深的不認（與 `kindOfPath` 同一個口徑）。
   */
  async listThreadPaths(): Promise<string[]> {
    let names: string[];
    try {
      const dirents = await fs.readdir(this.threadsDir, { withFileTypes: true });
      names = dirents.filter((d) => d.isFile() && isMarkdownPath(d.name)).map((d) => d.name);
    } catch {
      return [];
    }
    const special = [this.relPath(this.unfiledPath), this.relPath(this.timelinePath)];
    const rels = names
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true }))
      .map((name) => this.relPath(path.join(this.threadsDir, name)));
    return [...rels.filter((r) => !special.includes(r)), ...special.filter((r) => rels.includes(r))];
  }

  /**
   * 敘事線：一次把 `threads/` 讀完——各條線（按檔名排，`index` 是這個順序）、「未歸屬的伏筆」與故事時間（「時間線」）。沒有目錄、
   * 沒有那兩份保留檔案都當空的。解析失敗退化為認不出的行跳過，絕不拋（第 1 條）。
   */
  async readThreads(): Promise<ThreadBook> {
    const unfiledRel = this.relPath(this.unfiledPath);
    const timelineRel = this.relPath(this.timelinePath);
    const threads: ThreadBook['threads'] = [];
    let unfiledRaw = '';
    let timelineRaw = '';
    for (const rel of await this.listThreadPaths()) {
      const raw = await readText(this.pathOf(rel));
      if (rel === unfiledRel) {
        unfiledRaw = raw;
      } else if (rel === timelineRel) {
        timelineRaw = raw;
      } else {
        threads.push(parseThreadFile(raw, rel, threads.length));
      }
    }
    return { threads, unfiled: parseUnfiledFile(unfiledRaw, unfiledRel), timeline: parseTimelineFile(timelineRaw, timelineRel) };
  }

  /**
   * 敘事線判到哪（四期）：`project.json` 的水位 `threadsThrough` 與水位之後另外判過的 `threadsJudged`。手改壞了的不認（第 1 條）；
   * 沒有這兩項是一章都沒判過。推水位在閘道器（`Workspace.markThreadsJudged`）。
   */
  async readThreadsMark(): Promise<ThreadsMark> {
    return threadsMarkOf(await this.readManifest());
  }

  // ---------------------------------------------------------------- 角色 / 設定 / 文風

  async listCharacters(): Promise<CharacterCard[]> {
    const files = await listMarkdownDeep(this.charactersDir);
    const cards: CharacterCard[] = [];
    for (const abs of files) {
      const raw = await readText(abs);
      const { frontmatter, body } = parseMarkdown(raw);
      const slug = this.slugUnder(this.charactersDir, abs);
      cards.push({
        slug,
        relPath: this.relPath(abs),
        name: asString(frontmatter.name) || extractH1(body) || baseName(abs),
        aliases: asArray(frontmatter.aliases),
        tags: asArray(frontmatter.tags),
        gender: normalizeGender(frontmatter.gender),
        firstAppear: asNumber(frontmatter.firstAppear),
        lastSeen: asNumber(frontmatter.lastSeen),
        appearsIn: asNumberArray(frontmatter.appearsIn),
        updatedThrough: asNumber(frontmatter.updatedThrough),
        stateThrough: asNumber(frontmatter.stateThrough),
        stateHash: asString(frontmatter.stateHash) || undefined,
        body: stripH1(body),
        sections: pickSections<keyof CharacterSections>(body, CHARACTER_SECTION_KEYS) as CharacterSections,
      });
    }
    cards.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    return cards;
  }

  async listLore(): Promise<LoreEntry[]> {
    const files = await listMarkdownDeep(this.loreDir);
    const entries: LoreEntry[] = [];
    for (const abs of files) {
      const raw = await readText(abs);
      const { frontmatter, body } = parseMarkdown(raw);
      const slug = this.slugUnder(this.loreDir, abs);
      const updatedThrough = asNumber(frontmatter.updatedThrough);
      const bodyHash = asString(frontmatter.bodyHash);
      entries.push({
        slug,
        relPath: this.relPath(abs),
        title: asString(frontmatter.title) || extractH1(body) || baseName(abs),
        keywords: asArray(frontmatter.keywords),
        brief: asString(frontmatter.brief),
        category: loreCategoryOfSlug(slug),
        ...(updatedThrough !== undefined && updatedThrough >= 0 ? { updatedThrough } : {}),
        ...(bodyHash ? { bodyHash } : {}),
        body: stripH1(body),
      });
    }
    return entries;
  }

  /**
   * 本書的分類表：`lore/` 下的全部目錄（相對 `lore/`，可多層，空目錄也算）。每本書的分類不一樣，
   * 沒有固定表（model/loreFile.ts）。
   */
  async listLoreCategories(): Promise<string[]> {
    const root = this.relPath(this.loreDir);
    return (await this.listFolders(this.loreDir)).map((rel) => rel.slice(root.length + 1));
  }

  /**
   * 某個區目錄下的檔案標識：去掉副檔名的相對路徑（正斜槓）。
   * 根目錄下的檔案與改造前一致（就是檔名），子目錄裡的形如 `主角/林昭`——
   * 上下文明細裡的 `character:<slug>` 因此仍然唯一。
   */
  private slugUnder(dirAbs: string, fileAbs: string): string {
    return path.relative(dirAbs, fileAbs).replace(/\\/g, '/').replace(/\.md$/i, '');
  }

  /**
   * 遞迴列出某目錄下的全部子目錄（工作區相對路徑，正斜槓，已排序）。
   * 空目錄也在內——作者建好卷目錄還沒往裡寫，樹上也該看得見。
   */
  async listFolders(dirAbs: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > MAX_TREE_DEPTH) {
        return;
      }
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || isIgnoredDir(entry.name)) {
          continue;
        }
        const abs = path.join(dir, entry.name);
        out.push(this.relPath(abs));
        await walk(abs, depth + 1);
      }
    };
    await walk(dirAbs, 1);
    out.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    return out;
  }

  /**
   * 分卷（2026-10-23）：章節根下的一級目錄名，空的也在內（作者右鍵「新建卷」剛建好、還沒往裡放章）。
   * 按名字排（數字按大小：`第2卷` 在 `第10卷` 前面）。一卷就是一個目錄，卷裡還可以再分子目錄；
   * 細綱在 `summaries/` 下映象同一個目錄，卷只是收納——章號全書連續，不按卷重排。
   */
  async listVolumes(): Promise<string[]> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(this.chaptersDir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isDirectory() && !isIgnoredDir(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true }));
  }

  async readStyleGuide(): Promise<string> {
    if (!(await exists(this.stylePath))) {
      return '';
    }
    return stripH1(parseMarkdown(await readText(this.stylePath)).body);
  }

  /**
   * 文風指南還沒被作者動過：檔案不在、是空的，或者一字不差還是初始化寫的那份模板。
   *
   * 生成小說配置時模型會順帶給一段文風，只在這種時候才寫進 `style.md`（D14 + 第 3 條）。
   * 模板是外掛自己寫的通用建議，替換它不會吞掉作者的任何一個字；作者改過一個字，
   * 它就是作者的檔案了。
   */
  async styleGuideUntouched(): Promise<boolean> {
    const raw = (await readTextIfExists(this.stylePath).catch(() => undefined)) ?? '';
    return !raw.trim() || raw.replace(/\r\n/g, '\n').trim() === STYLE_TEMPLATE.trim();
  }

  /**
   * 情節大綱：各章細綱（每個章號認下的那一份）裡梗概非空的，一章一條拼起來（`## 第N章：標題` + 梗概）。沒有標題行與說明——
   * 裝配器、狀態機、排敘事線讀的都是這一份。給編輯器的整份見 {@link readOutlineDoc}。
   */
  async readOutline(): Promise<string> {
    return renderOutline(outlineEntriesOf(await this.listChapterPlots()));
  }

  /** 編輯器、覆蓋審閱、MCP 讀到的整份情節大綱：標題行、一段說明、一章一條。存檔時按章號拆回各章細綱（閘道器的 `writeOutline`）。 */
  async readOutlineDoc(): Promise<string> {
    return renderOutlineDoc(outlineEntriesOf(await this.listChapterPlots()));
  }
}

// ---------------------------------------------------------------- 回收站落點

/**
 * 刪掉的東西搬進回收站的哪裡（絕對路徑）：**保留原相對路徑**（`.trash/<rel>`），同名衝突時加序號
 * （`003-深处-2.md`），不覆蓋之前刪掉的東西（AGENTS 第 6 條）。只算落點、只讀（看一眼哪個名字沒被佔），不搬任何東西。
 *
 * 規則只有這一份：閘道器的 `remove` / `deletePlot` / 定稿前複製舊版（`core/workspace/` 重新匯出它），與會話刪除
 * （`session.ts`，會話是 Novelwarden 自己的內部檔案，閘道器拒寫 `sessions/`，所以會話不走閘道器、只共用這條落點規則）。
 * 放在資料層而不是閘道器裡：`model/` 不能反過來依賴 `workspace/`。
 */
export async function trashPathFor(project: Pick<NovelProject, 'trashDir'>, rel: string): Promise<string> {
  const base = path.join(project.trashDir, rel);
  if (!(await exists(base))) {
    return base;
  }
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!(await exists(candidate))) {
      return candidate;
    }
  }
}

// ---------------------------------------------------------------- 渲染模板

/**
 * 寫角色卡時的入參。
 *
 * `appearsIn` 可省：手工新建的空卡還沒有出場記錄，硬要呼叫方傳個 `[]`
 * 只是噪音。讀回來的 `CharacterCard.appearsIn` 則一定是陣列（缺席即空）。
 */
export type WritableCharacterCard = Omit<CharacterCard, 'relPath' | 'body' | 'appearsIn'> & {
  appearsIn?: number[];
};

/**
 * 寫設定條目時的入參。slug 可以帶子目錄字首（就是分類）。`brief` / `updatedThrough` / `bodyHash`
 * 沒給就不寫——改寫一條已有條目時由呼叫方把讀回來的原樣帶上。
 */
export type WritableLoreEntry = Omit<LoreEntry, 'relPath' | 'category' | 'brief'> & { brief?: string };

export function renderCharacterCard(card: WritableCharacterCard): string {
  const fm = stringifyFrontmatter({
    name: card.name,
    aliases: card.aliases,
    tags: card.tags,
    gender: card.gender,
    firstAppear: card.firstAppear,
    lastSeen: card.lastSeen,
    // 出場章節列表落在卡裡，角色頁不必讀全部細綱就能顯示「出場 12 章」，
    // 也方便作者/日後的檢索功能按人物找章節。
    appearsIn: card.appearsIn?.length ? card.appearsIn.map(String) : undefined,
    updatedThrough: card.updatedThrough,
    // 「當前狀態」歸誰（D15，model/characterState.ts）：原樣帶著走。維護類動作重寫整張卡時
    // 不重新蓋章——作者改過的那一節，換個別名不該讓它變成「機器寫的」。
    stateThrough: card.stateThrough,
    stateHash: card.stateHash,
  });
  const body = stringifySections(card.sections as unknown as Record<string, string>, CHARACTER_SECTION_KEYS, {
    keepEmpty: true,
  });
  return `${fm}\n\n# ${card.name}\n\n${body}\n`;
}

/** 將設定條目渲染成作者可繼續手改的普通 Markdown。 */
export function renderLoreEntry(entry: WritableLoreEntry): string {
  const fm = stringifyFrontmatter({
    title: entry.title,
    keywords: entry.keywords,
    brief: entry.brief?.trim() || undefined,
    updatedThrough: entry.updatedThrough,
    bodyHash: entry.bodyHash || undefined,
  });
  return `${fm}\n\n# ${entry.title}\n\n${entry.body.trim()}\n`;
}

export function emptyCharacterSections(): CharacterSections {
  return {
    身份: '',
    外貌: '',
    性格: '',
    语言习惯: '',
    人物关系: '',
    当前状态: '',
    暗设: '',
  };
}

// ---------------------------------------------------------------- 工具函式

/**
 * 遞迴列出目錄下滿足 `accept` 的檔案的絕對路徑（按路徑排序，保證穩定）。
 *
 * 隱藏目錄與 node_modules 一律跳過：`.trash/` 裡躺著剛刪掉的東西，
 * 再掃出來就等於沒刪。`skipDirs` 是額外要跳過的目錄絕對路徑。
 */
async function listFilesDeep(
  dir: string,
  accept: (fileName: string) => boolean,
  skipDirs?: ReadonlySet<string>
): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > MAX_TREE_DEPTH) {
      return;
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!isIgnoredDir(entry.name) && !skipDirs?.has(abs)) {
          await walk(abs, depth + 1);
        }
      } else if (entry.isFile() && accept(entry.name)) {
        out.push(abs);
      }
    }
  };
  await walk(dir, 1);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

/**
 * 只列 `.md`。角色 / 設定用這一條——那兩個區是外掛自己的資料格式
 * （frontmatter + 固定小節），不跟著章節一起放寬副檔名。只列路徑、不讀內容。名詞補全的表（`views/nameIndex.ts`）
 * 用同一條列檔案，好跟 `listCharacters` / `listLore` 認的是同一批；全書查詢也按它列角色卡與設定條目（`views/bookFind.ts`）。
 */
export async function listMarkdownDeep(dir: string): Promise<string[]> {
  return listFilesDeep(dir, (name) => name.toLowerCase().endsWith('.md'));
}

function baseName(absPath: string): string {
  return path.basename(absPath).replace(/\.md$/i, '');
}

/**
 * 標題 → 檔名詞幹。**空標題給空串，不給「未命名」**。
 *
 * `sanitizeFileName` 的兜底名是「未命名」，那是給「作者輸了一串全是非法
 * 字元的名字」用的。但細綱與場景都允許**沒有標題**——流水線新建出來的章
 * 就是純序號名 `030.md`（標題要等劇情排完才定得下來，見 actions.ts 的
 * `newPlotFlow`）。直接套 sanitize 會得到 `030-未命名.md`：那是個假標題，
 * 而且它會進檔名、進段落說法、進上下文，作者還得手動去掉。
 */
function safeStem(title: string): string {
  return title.trim() ? sanitizeFileName(title) : '';
}

/** 細綱路徑的檔名裡那個章號；認不出是 undefined。 */
function parsePlotFileNameOf(plotRelPath: string): number | undefined {
  return parsePlotFileName(path.basename(plotRelPath))?.no;
}

// ---------------------------------------------------------------- 初始化模板

const STYLE_TEMPLATE = `# 文風指南

> 這份檔案會在每次續寫時注入 LLM。可以手寫，也可以用命令「Novel: 提取文風指南」從已寫章節自動生成。

## 敘事視角

第三人稱限知視角，跟隨主角。

## 句式節奏

以短句為主，動作場面進一步壓縮句長；描寫段落可適當鋪陳。

## 對白比例

對白約佔三成，人物說話要有各自的口癖，不寫「他說道」以外的花哨提示語。

## 修辭偏好

剋制使用比喻，避免堆砌形容詞。

## 禁用詞表

- 不使用「不禁」「頓時」「彷彿整個世界」這類套話
- 不寫「總之」「綜上」等議論腔
`;

/**
 * 全文大綱（原全書摘要）的空模板：只有「主線進展」一節——已經寫完的部分，主線是怎麼走過來的。伏筆與關係的變動
 * 歸敘事線（`threads/`），往後的計劃是情節大綱。
 */
const GLOBAL_SUMMARY_TEMPLATE = `---
through: 0
generatedBy: novelwarden
---

# 全文大綱

## 主線進展

（尚未生成。寫完若干章後執行命令「Novel: 重建全文大綱」。）
`;

/** 全文大綱從前另有的三節（全書摘要時代）。老檔案裡留著，不讀（{@link NovelProject.readGlobalSummary}）。 */
const RETIRED_GLOBAL_SECTIONS = new Set(['已收伏笔', '未收伏笔', '人物关系变动', '已收伏筆', '未收伏筆', '人物關係變動']);

/**
 * 去掉 {@link RETIRED_GLOBAL_SECTIONS} 那三節：標題（`##` 或 `###`，只有一批時階段那一份直接落盤，是三級標題）
 * 到下一個同級或更高的標題為止。別的小節、作者自己加的，原樣留著。
 */
function dropRetiredGlobalSections(body: string): string {
  const out: string[] = [];
  let skipping = 0;
  for (const line of body.split(/\r?\n/)) {
    const h = /^(#{1,3})(?!#)\s*(.*?)\s*#*\s*$/u.exec(line);
    if (h && (!skipping || h[1].length <= skipping)) {
      const retired = h[1].length >= 2 && RETIRED_GLOBAL_SECTIONS.has(h[2].replace(/[\s·・、,，.。:：/-]/g, ''));
      skipping = retired ? h[1].length : 0;
    }
    if (!skipping) {
      out.push(line);
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
