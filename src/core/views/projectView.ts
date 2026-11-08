import { traditionalLabel } from '../model/labels';
import { basename } from 'node:path';
import { buildCastIndex, describePlots } from './cast';
import { THIN_LORE_LABEL, buildLoreIndex, describeSpan, pendingChapters } from './lore';
import { loreBrief } from '../model/loreFile';
import { listActiveFailures } from '../runtime/errorLog';
import { scoped } from '../runtime/logger';
import { hasContent, stripH1 } from '../model/markdown';
import { BookConfig } from '../model/settingFile';
import { DEFAULT_PARAGRAPH_STYLE } from '../model/paragraphFormat';
import { BookFacts, BookStage, SETTING_DOCS, SETTING_DOC_LABEL, SettingDoc, chapterLabel, deriveBookNextStep, deriveBookStage } from '../model/pipeline';
import { NovelProject } from '../model/project';
import { PLOT_SECTION_KEYS, parsePlotFileName } from '../model/plotFile';
import { isOutlineFilled, outlineCoverage } from '../model/outlineFile';
import { describeStateThrough } from '../model/characterState';
import { buildBookFacts, buildPlotPipeline, buildPipelineIndex, chapterOfPlotNo } from './pipeline';
import { chapterIndexEntryOf } from './chapterIndex';
import { volumeOf } from './quickOpen';
import { buildThreadsView } from './threads';
import { threadsMarkOf } from '../model/threadFile';
import {
  ArchitectureRow,
  CastConflictView,
  CastEntry,
  CastSummary,
  LoreSummary,
  LoreThinEntry,
  LoreUnfiledEntry,
  PlotPipelineView,
  PlotSummaryView,
  ProjectDirNode,
  ProjectFileNode,
  ProjectNode,
  ProjectPlotNode,
  ProjectTree,
  IdeaDefaults,
  NextStepView,
  VolumeView,
} from '../protocol';

const log = scoped('角色卡');

/**
 * 每個工程上一次報過的衝突簽名。工程頁每次重新整理都會走到這裡，同一批衝突反覆打進日誌
 * 會把日誌頁淹掉——變了才說一次。按工程根分開：獨立版同時開著幾個工程時不互相頂掉。
 */
const lastConflictSignature = new Map<string, string>();

/**
 * 工程頁的資料來源。
 *
 * ## 「故事架構」與「章節」兩組
 *
 * - **故事架構**：小說配置 / 故事前提 / 角色圖譜 / 世界觀 / 設定清單 / 情節大綱六行，各帶
 *   「填過沒有」。它們是後面一切的上游，排在最前面。
 * - **章節**：一個章號一行（細綱號 = 章號）。一行同時報細綱與正文兩面：排過沒有、
 *   寫了多少、定稿沒有、上游變沒變。
 *
 * 角色 / 設定兩個區仍是任意深度的目錄樹：資料層給出扁平的檔案清單（含各級
 * 子目錄裡的），這裡按 relPath 折成層級。
 */
export async function buildProjectTree(project: NovelProject): Promise<ProjectTree> {
  const styleGuidePath = project.relPath(project.stylePath);
  const outlinePath = project.relPath(project.outlinePath);
  const globalSummaryPath = project.relPath(project.globalSummaryPath);
  const threadsPath = project.relPath(project.threadsDir);
  const chaptersRoot = project.relPath(project.chaptersDir);
  const charactersRoot = project.relPath(project.charactersDir);
  const loreRoot = project.relPath(project.loreDir);

  if (!(await project.isInitialized())) {
    return {
      initialized: false,
      plotCount: 0,
      chapterCount: 0,
      totalWords: 0,
      staleCount: 0,
      summarizedCount: 0,
      architecture: [],
      plots: [],
      volumes: [],
      characters: [],
      lore: [],
      cast: [],
      castByCard: {},
      loreByEntry: {},
      loreUnfiled: [],
      loreThin: [],
      loreUnrecorded: 0,
      castConflicts: [],
      failures: {},
      chaptersRoot,
      charactersRoot,
      loreRoot,
      globalSummaryThrough: 0,
      styleGuidePath,
      globalSummaryPath,
      threadsPath,
      threads: { lines: [], current: 0, through: 0, watch: { lines: [], foreshadowing: [], unplanted: [] } },
      bookStage: 'setting',
      nextChapterNo: 1,
      book: { idea: '', configHasContent: false, plotFilledNos: [] },
      paragraphStyle: DEFAULT_PARAGRAPH_STYLE,
    };
  }

  const [characters, lore, characterDirs, loreDirs, draftPaths, pipelineIndex, threadBook, volumeNames] = await Promise.all([
    project.listCharacters(),
    project.listLore(),
    project.listFolders(project.charactersDir),
    project.listFolders(project.loreDir),
    // 一次遍歷拿到全部已存在的草稿，勝過每章一次 stat。
    project.listDraftPaths(),
    // 全書流水線索引：大綱、配置、manifest、細綱與章節都只讀一次攤給所有章。
    buildPipelineIndex(project),
    // 敘事線目錄一次讀完（一條線一個檔案）。
    project.readThreads(),
    // 分卷：章節根下的一級目錄，空卷也要（剛建、還沒放章的那一卷在頁簽上看得見）。
    project.listVolumes(),
  ]);
  // 章節列表、細綱列表、manifest 與大綱原文都用流水線那一趟讀到的同一份，
  // 不再單獨讀一次。
  const { rows, chapters, plots, manifest, outline } = pipelineIndex;
  const book = await buildBookFacts(project, pipelineIndex, { characters, lore });

  const plotsRoot = project.relPath(project.plotsDir);
  const plotRows: ProjectPlotNode[] = rows.map((p) => {
    const chapterPath = p.chapter.relPath;
    const draftPath = chapterPath ? (project.draftRelPathFor(chapterPath) ?? '') : '';
    return {
      // 章節條、上一章 / 下一章用的那幾個欄位與這裡同一個函式算（views/chapterIndex.ts）。
      ...chapterIndexEntryOf(p),
      // 一卷是章節根下的一級目錄：卷裡再分的子目錄（`第一卷/上`）算在這一卷裡。
      volume: (chapterPath ? volumeOf(chapterPath, chaptersRoot) : volumeOf(p.plot.relPath, plotsRoot)).split('/')[0],
      // 空章不算沒定稿：那不是「定稿舊了」，是還沒寫。
      stale: p.chapter.words > 0 && p.summary.stale,
      progress: p.progress,
      upstreamStale: p.plot.upstreamStale || p.chapter.upstreamStale,
      draftPath,
      hasDraft: draftPath !== '' && draftPaths.has(draftPath),
    };
  });

  const coverage = outlineCoverage(outline);
  // 角色圖譜、設定清單兩行報的是條數：它們沒有自己的檔案，「填過」看的就是那一組裡有沒有東西。
  // 設定清單在有正文的書上算填過（`isLoreListFilled`），一條都沒有時照實說 0 條；沒填過才說「待生成」。
  const counted: Partial<Record<SettingDoc, string>> = { characters: `${characters.length} 人`, lore: `${lore.length} 條` };
  const architecture: ArchitectureRow[] = [
    ...SETTING_DOCS.map((doc) => ({
      key: doc,
      label: SETTING_DOC_LABEL[doc],
      relPath: project.relPath(project.settingPath(doc)),
      filled: book.settings[doc],
      detail: doc === 'characters' || book.settings[doc] ? counted[doc] ?? '' : '待生成',
    })),
    {
      key: 'outline' as const,
      label: '情節大綱',
      relPath: outlinePath,
      filled: isOutlineFilled(outline),
      detail: isOutlineFilled(outline) ? `覆蓋到第 ${coverage} 章` : '待生成',
    },
  ];

  // 「狀態截至第 3 章」（四期，D15）：當前狀態寫到哪一章了，寫下一章前一眼看得出跟沒跟上。
  const characterLeaves = characters.map<ProjectFileNode>((card) => ({
    kind: 'file',
    label: card.name,
    relPath: card.relPath,
    detail: [
      ...card.tags,
      ...(card.aliases.length > 0 ? [`別名 ${card.aliases.join('/')}`] : []),
      ...(describeStateThrough(card.stateThrough) ? [describeStateThrough(card.stateThrough)] : []),
    ].join(' · '),
  }));

  // 設定行的副標題是一句話簡介（沒寫就是正文第一句，再沒有才是關鍵詞）：幾百條的名錄裡，
  // 一眼要看出它是什麼，關鍵詞幫不上這個忙。
  const loreLeaves = lore.map<ProjectFileNode>((entry) => ({
    kind: 'file',
    label: entry.title,
    relPath: entry.relPath,
    detail: loreBrief(entry) || entry.keywords.join('/'),
  }));

  // 設定名錄（views/lore.ts）：已建條目補出現章與待整合，未建條目單列一組；還沒寫的幾章要用、卻還是空的
  // 設定（待完善）也單列一組。
  const loreIndex = await buildLoreIndex(project, { plots, entries: lore, cards: characters }, { thin: true });
  const loreByEntry: Record<string, LoreSummary> = {};
  for (const record of loreIndex.known) {
    loreByEntry[record.entry.relPath] = {
      chapters: record.chapters,
      detail: describeSpan(record.chapters),
      updatedThrough: record.entry.updatedThrough ?? 0,
      pending: pendingChapters(record),
      keywords: record.entry.keywords,
    };
  }
  const loreUnfiled: LoreUnfiledEntry[] = loreIndex.unknown.map((item) => ({
    name: item.name,
    category: item.category,
    chapters: item.chapters,
    detail: `${item.chapters.length} 章 · 第 ${item.chapters[0]} 章起`,
  }));
  const loreThin: LoreThinEntry[] = loreIndex.thin.map((item) => ({
    name: item.name,
    category: item.category,
    ...(item.relPath ? { relPath: item.relPath } : {}),
    kind: item.kind,
    chapters: item.chapters,
    detail: `第 ${item.first} 章起要用 · ${THIN_LORE_LABEL[item.kind]}`,
    ...(item.authored ? { authored: true as const } : {}),
  }));

  // 出場人物索引：已建卡的補出場統計，未建卡的單列一組。
  // 與角色樹分開——那是檔案樹，這些人還沒有檔案。
  // 細綱複用流水線那一趟讀到的列表：同一次重新整理裡這已經是第三個要它的人了。
  const castIndex = await buildCastIndex(project, plots);
  const castByCard: Record<string, CastSummary> = {};
  for (const member of castIndex.known) {
    if (!member.card) {
      continue;
    }
    const updatedThrough = member.card.updatedThrough ?? 0;
    castByCard[member.card.relPath] = {
      plots: member.plots,
      detail: describePlots(member.plots),
      updatedThrough,
      // 上次更新之後又出場了幾章——角色行上的「有新內容可更新」提示吃這個數。
      pending: member.plots.filter((n) => n > updatedThrough).length,
    };
  }
  const cast: CastEntry[] = castIndex.unknown.map((member) => ({
    name: member.name,
    aliases: member.aliases,
    plots: member.plots,
    detail: describePlots(member.plots),
  }));

  const bySlug = new Map(characters.map((c) => [c.slug, c]));
  const castConflicts: CastConflictView[] = castIndex.conflicts.map((conflict) => ({
    name: conflict.name,
    kind: conflict.kind,
    cards: conflict.slugs
      .map((slug) => bySlug.get(slug))
      .filter((c): c is NonNullable<typeof c> => !!c)
      .map((c) => ({ name: c.name, relPath: c.relPath })),
  }));
  reportConflicts(project.root, castConflicts);

  // 定稿只算**有正文**的章：還沒寫的章無從定稿，算進來會讓頂部黃條報一個
  // 永遠清不掉的待辦數。
  const written = plotRows.filter((p) => p.chapterPath && p.wordCount > 0);
  const staleCount = written.filter((p) => p.stale).length;
  // 未解決的失敗記錄，一次查詢拿全部（按 relPath 索引，各區共用一張表）。
  // 庫不可用時是空物件——工程頁照常渲染，只是沒有感嘆號。
  const failures = await listActiveFailures(project);
  const bookStage = deriveBookStage(book);
  // 空狀態（W12）說的「下一步」：與對話頁主按鈕在全書那一檔給的同一步。
  const next = await bookStepView(bookStage, book, {
    config: () => pipelineIndex.config,
    plotPathOf: (no) => rows.find((r) => r.no === no)?.plot.relPath ?? project.plotPathOfNo(no),
  });
  // 「新章落這裡」與真正的落點同一個函式：接在最後一章之後的那一章落進哪個子目錄。
  const after = rows.reduce((max, r) => Math.max(max, r.no), 0) + 1;
  const landing = (await project.subdirForNewChapter(after)).split('/')[0];
  return {
    initialized: true,
    plotCount: plotRows.length,
    chapterCount: chapters.length,
    totalWords: plotRows.reduce((sum, p) => sum + p.wordCount, 0),
    staleCount,
    summarizedCount: written.length - staleCount,
    architecture,
    plots: plotRows,
    volumes: buildVolumes(volumeNames, plotRows, chaptersRoot, landing),
    characters: nest(charactersRoot, characterLeaves, characterDirs),
    lore: nest(loreRoot, loreLeaves, loreDirs),
    cast,
    castByCard,
    loreByEntry,
    loreUnfiled,
    loreThin,
    loreUnrecorded: loreIndex.unrecorded.length,
    castConflicts,
    failures,
    chaptersRoot,
    charactersRoot,
    loreRoot,
    globalSummaryThrough: manifest.globalSummaryThrough ?? 0,
    styleGuidePath,
    globalSummaryPath,
    threadsPath,
    // 「敘事線」頁籤：一條線一行。線上的實際事件都是定稿寫進來的：狀態按敘事線判到的那一章算（四期的水位，不超過定稿到），
    // 定稿了還沒判的章另說「⚠ 第 a–b 章還沒判」。
    threads: buildThreadsView(threadBook, finalizedThrough(rows), {
      mark: threadsMarkOf(manifest),
      finalized: finalizedNos(rows),
      // 「時間線」組一章一行要章名、正文與卷（2026-10-24 重做）。
      chapters: plotRows.map((p) => ({ no: p.no, title: p.title, chapterPath: p.chapterPath, volume: p.volume })),
    }),
    bookStage,
    nextChapterNo: book.nextChapterNo,
    ...(next ? { next } : {}),
    book: {
      ...ideaDefaultsOf(pipelineIndex.config, book.nextChapterNo - 1),
      outlineCoverage: coverage > 0 ? coverage : undefined,
      plotFilledNos: [...book.plotFilledNos],
    },
    paragraphStyle: pipelineIndex.config.paragraphStyle ?? DEFAULT_PARAGRAPH_STYLE,
  };
}

/** 一句話彈窗的預設值：`config.md` 裡已經寫了的那幾樣。 */
export function ideaDefaultsOf(config: BookConfig, writtenThrough = 0): IdeaDefaults {
  return {
    idea: config.sections.一句话 ?? '',
    totalChapters: config.totalChapters,
    wordsPerChapter: config.wordsPerChapter,
    configHasContent: Object.values(config.sections).some((v) => hasContent(v)),
    ...(writtenThrough > 0 ? { writtenThrough } : {}),
  };
}

/**
 * 全書那一檔的下一步（生成架構 / 情節大綱 / 拆細綱），補上落點與彈窗預設值。
 *
 * 對話頁的主按鈕（`controller/chat.ts` 的 `bookNextStep`）與工程頁的空狀態（W12）共用
 * 這一份，兩處說的是同一步、同一句話（第 20 條：只推一個下一步）。判據在純函式層
 * （`deriveBookNextStep`），這裡只補落點：
 *
 * - 架構、大綱兩檔：純函式自己給了 target；小說配置那一步還要一句話彈窗的預設值。
 * - 拆細綱那一檔：落在區間第一章的細綱上（已有空殼就用它，否則用它應該在的位置）。
 * - 在寫、寫完了：undefined——那時的下一步是單章狀態機的事。
 */
export async function bookStepView(
  stage: BookStage,
  facts: BookFacts,
  at: { config(): BookConfig | Promise<BookConfig>; plotPathOf(no: number): string | Promise<string> }
): Promise<NextStepView | undefined> {
  const step = deriveBookNextStep(stage, facts);
  if (!step) {
    return undefined;
  }
  if (step.form === 'idea') {
    return { ...step, target: step.target!, formDefaults: ideaDefaultsOf(await at.config()) };
  }
  if (step.target) {
    return { ...step, target: step.target };
  }
  const no = step.range?.from ?? facts.nextChapterNo;
  return { ...step, target: { kind: 'plot', plotRelPath: await at.plotPathOf(no) }, no };
}

/**
 * 一章流水線的完整檢視（創作頁的流水線條）。
 *
 * 與 `buildPlotSummaryView` 同一套取捨：資料小、只在切目標時取一次，
 * 所以單獨一條訊息，不塞進每次檔案變動都全量重推的 `ProjectTree`。
 *
 * 傳的是**細綱路徑**（可能還不存在）或**章節路徑**，都認到同一章：章節路徑就是那一章、細綱是它的
 * 映象；細綱路徑按 `resolvePlot` 認這一章現在的那一份。
 * 兩邊都沒有時給一份空殼（「寫第 N 章細綱」）——作者可能剛把它改了名，
 * 介面該顯示「它還沒有」而不是崩掉。
 */
export async function buildPlotPipelineView(
  project: NovelProject,
  plotRelPath: string
): Promise<PlotPipelineView> {
  const chapters = await project.listChapters();
  const direct = chapters.find((c) => c.relPath === plotRelPath);
  const no = direct?.order ?? parsePlotFileName(basename(plotRelPath))?.no ?? 0;
  const plot = direct ? await project.plotOfChapter(direct) : await project.resolvePlot(plotRelPath);
  const p = await buildPlotPipeline(
    project,
    { no, plot, chapter: direct ?? chapterOfPlotNo(chapters, no) },
    { chapters }
  );
  return {
    plotRelPath: p.plot.relPath,
    no: p.no,
    title: p.title,
    outline: { covered: hasContent(plot?.sections.梗概), coverage: outlineCoverage(await project.readOutline()) },
    plot: p.plot,
    chapter: p.chapter,
    summary: p.summary,
    stage: p.stage,
    progress: p.progress,
  };
}

/**
 * 衝突進日誌。前端也會顯示一條，但日誌才是事後能翻的地方——
 * 「上週那批出場統計怎麼會錯」只有這裡答得上。
 */
function reportConflicts(root: string, conflicts: CastConflictView[]): void {
  const signature = conflicts.map((c) => `${traditionalLabel(c.kind)}:${c.name}:${c.cards.map((x) => x.relPath).join(',')}`).join('|');
  if (signature === (lastConflictSignature.get(root) ?? '')) {
    return;
  }
  lastConflictSignature.set(root, signature);
  if (conflicts.length === 0) {
    return;
  }
  log.warn(
    `${conflicts.length} 個稱呼被多張角色卡同時宣告，出場統計必然有一張是錯的`,
    conflicts
      .map(
        (c) =>
          `「${c.name}」← ${c.cards.map((x) => x.name).join(' / ')}` +
          `（${c.kind === 'name' ? '兩張卡的正式名一模一樣，多半是同一個人建了兩張卡' : '被多張卡當成自己的稱呼，出場統計只算給第一張'}）`
      )
      .join('；') + '｜可用角色分組右鍵的「查詢並合併重複角色卡」「清理別名」處理'
  );
}

/**
 * 單章細綱的浮窗檢視。工程頁滑鼠懸停在章節行上時按需取一次。
 *
 * 與 `buildProjectTree` 分開是有意的：細綱正文上千字，而那棵樹每次
 * 檔案變動都全量重推，把細綱塞進去等於每儲存一次正文就多推幾百 KB。
 *
 * 傳的是**細綱路徑或章節路徑**（工程頁那一行同時代表兩者），認到同一章；細綱是正文映象的那一份。
 *
 * 細綱不存在不是錯誤——那一章可以還沒排、只有作者手寫的正文。這時給 `exists: false`，
 * 讓前端說清「還沒有細綱」，而不是彈一個空浮窗或報錯。沒定稿的細綱是計劃（`finalized: false`），
 * 定稿過、正文後來又改過的標過期。
 */
export async function buildPlotSummaryView(
  project: NovelProject,
  plotRelPath: string
): Promise<PlotSummaryView> {
  const chapters = await project.listChapters();
  const direct = chapters.find((c) => c.relPath === plotRelPath);
  const no = direct?.order ?? parsePlotFileName(basename(plotRelPath))?.no ?? 0;
  const chapter = direct ?? chapterOfPlotNo(chapters, no);
  const plot = chapter ? await project.plotOfChapter(chapter) : await project.getPlot(no);
  const title = plot?.title || chapter?.title || '';
  const label = chapterLabel(no, title);

  if (!plot) {
    return {
      no,
      title,
      label,
      exists: false,
      finalized: false,
      stale: false,
      relPath: '',
      sections: [],
      emptyHint: chapter
        ? '這一章還沒有細綱。右鍵「同步」可以照正文整理一份。'
        : '這一章還沒有細綱。',
    };
  }
  // 與 staleChapters() / buildProjectTree 同一套判據：以 sourceHash 為準。
  // 正文沒了（細綱成了孤兒）也算過期——浮窗裡那句提示總比預設「新鮮」誠實。
  const finalized = !!plot.sourceHash;
  const stale = finalized && (!chapter || plot.sourceHash !== chapter.contentHash);

  // 沒內容的小節（佔位文字讀回來就是空串）在浮窗裡是純噪聲，濾掉。
  const sections = PLOT_SECTION_KEYS.map((name) => ({ name: name as string, text: plot.sections[name].trim() })).filter(
    (s) => s.text !== ''
  );

  // 一個小節都沒認出來（作者手改細綱、把 `## 小節名` 全刪了改成大白話）時
  // 退回細綱全文，總比給一個空浮窗好。只在「一個小節標題都沒有」時才退：小節都在、
  // 只是內容全是佔位的，那就是一份貨真價實的空細綱，退回全文只會把八行「（待補充）」攤在浮窗裡。
  const body = stripH1(plot.body.trim()).trim();
  if (sections.length === 0 && !/^#{2,3}\s/m.test(body) && body !== '') {
    sections.push({ name: '細綱', text: body });
  }
  return { no, title, label, exists: true, finalized, stale, relPath: plot.relPath, sections };
}

/**
 * 「章節」頁籤的分卷（2026-10-23）。卷按卷裡最小的章號排——章號全書連續，卷的先後跟著章走；還空著的卷排在最後
 * （`listVolumes` 的順序），作者剛建的那一卷就在底下。直接放在章節根下的章是「未分卷」一段（`name` 為空），
 * 照它的章號排。只有細綱、`chapters/` 下還沒有那個目錄的卷（拆了細綱、正文還沒寫）也算一卷。
 *
 * 一卷都沒有（`chapters/` 下沒有目錄、章全在根下）就是空陣列，頁籤照舊平鋪。`landing` 是新章落進的那一卷。
 */
function buildVolumes(names: string[], rows: ProjectPlotNode[], chaptersRoot: string, landing: string): VolumeView[] {
  const spans = new Map<string, { from: number; to: number; words: number }>();
  for (const r of rows) {
    const span = spans.get(r.volume);
    if (span) {
      span.from = Math.min(span.from, r.no);
      span.to = Math.max(span.to, r.no);
      span.words += r.wordCount;
    } else {
      spans.set(r.volume, { from: r.no, to: r.no, words: r.wordCount });
    }
  }
  const filled = [...spans.keys()].sort((a, b) => spans.get(a)!.from - spans.get(b)!.from);
  const empty = names.filter((n) => !spans.has(n));
  if (empty.length === 0 && filled.every((n) => n === '')) {
    return [];
  }
  return [...filled, ...empty].map((name) => ({
    name,
    relPath: name ? `${chaptersRoot}/${name}` : chaptersRoot,
    ...(spans.has(name) ? { from: spans.get(name)!.from, to: spans.get(name)!.to } : {}),
    words: spans.get(name)?.words ?? 0,
    latest: name === landing,
  }));
}

/**
 * 把扁平的檔案清單按 relPath 折成目錄樹。
 *
 * `dirs` 是磁碟上實際存在的子目錄（含空目錄）——作者剛建好卷目錄還沒
 * 往裡寫東西時，樹上也該看得見，否則「新建資料夾」點完像是什麼都沒發生。
 *
 * 每層內目錄在前、檔案在後；章節每層內正序（第 1 章在上），
 * 角色/設定保持傳入順序（已按拼音排好）。
 */
function nest(root: string, leaves: ProjectNode[], dirs: string[]): ProjectNode[] {
  const dirNodes = new Map<string, ProjectDirNode>();

  /** 建出某個目錄及其所有祖先，返回它。relPath 為 root 時返回 undefined（根不是節點）。 */
  const ensureDir = (relPath: string): ProjectDirNode | undefined => {
    if (relPath === root || !relPath.startsWith(`${root}/`)) {
      return undefined;
    }
    const existing = dirNodes.get(relPath);
    if (existing) {
      return existing;
    }
    const node: ProjectDirNode = {
      kind: 'dir',
      label: relPath.slice(relPath.lastIndexOf('/') + 1),
      relPath,
      children: [],
      fileCount: 0,
    };
    dirNodes.set(relPath, node);
    return node;
  };

  for (const dir of dirs) {
    ensureDir(dir);
  }
  // 葉子所在目錄可能不在 dirs 裡（listFolders 與檔案掃描各讀一次盤，
  // 中間目錄被刪掉時會對不上）——按需補出來，不讓檔案憑空消失。
  for (const leaf of leaves) {
    const parent = leaf.relPath.slice(0, leaf.relPath.lastIndexOf('/'));
    for (const ancestor of ancestorsOf(parent, root)) {
      ensureDir(ancestor);
    }
  }

  const topLevel: ProjectNode[] = [];
  const attach = (node: ProjectNode, parentPath: string): void => {
    const parent = dirNodes.get(parentPath);
    if (parent) {
      parent.children.push(node);
    } else {
      topLevel.push(node);
    }
  };

  // 先掛目錄（淺的在前，保證父目錄已建好），再掛檔案。
  for (const relPath of [...dirNodes.keys()].sort(byDepthThenName)) {
    const node = dirNodes.get(relPath)!;
    attach(node, relPath.slice(0, relPath.lastIndexOf('/')));
  }
  for (const leaf of leaves) {
    attach(leaf, leaf.relPath.slice(0, leaf.relPath.lastIndexOf('/')));
  }

  // 每層排序 + 統計子樹檔案數。
  const finish = (nodes: ProjectNode[]): number => {
    nodes.sort(compareNodes);
    let count = 0;
    for (const node of nodes) {
      if (node.kind === 'dir') {
        node.fileCount = finish(node.children);
        count += node.fileCount;
      } else {
        count += 1;
      }
    }
    return count;
  };
  finish(topLevel);
  return topLevel;
}

/** `a/b/c` 在 root=`a` 下的祖先鏈：`a/b`、`a/b/c`。 */
function ancestorsOf(dir: string, root: string): string[] {
  if (dir === root || !dir.startsWith(`${root}/`)) {
    return [];
  }
  const out: string[] = [];
  const segments = dir.slice(root.length + 1).split('/');
  let current = root;
  for (const segment of segments) {
    current = `${current}/${segment}`;
    out.push(current);
  }
  return out;
}

function byDepthThenName(a: string, b: string): number {
  return a.split('/').length - b.split('/').length || a.localeCompare(b, 'zh-Hans-CN');
}

/**
 * 每層內目錄在前、檔案在後。
 *
 * 目錄按名稱排；角色/設定的檔案保持傳入順序（已按拼音排好）。
 * 章節不走這裡——它是單獨的一條扁平列表（`ProjectPlotNode`），按章號排。
 */
function compareNodes(a: ProjectNode, b: ProjectNode): number {
  if (a.kind === 'dir' && b.kind !== 'dir') {
    return -1;
  }
  if (a.kind !== 'dir' && b.kind === 'dir') {
    return 1;
  }
  if (a.kind === 'dir' && b.kind === 'dir') {
    return a.label.localeCompare(b.label, 'zh-Hans-CN');
  }
  return 0;
}

/**
 * 定稿到的最後一章：定稿過（細綱上記著 `sourceHash`）、正文還在的章裡章號最大的那一章；一章都沒有是 0。
 * 定稿之後正文又改過的也算——那一章的敘事線事件是定稿那一次記下的，還在線上。
 */
function finalizedThrough(rows: readonly { no: number; summary: { exists: boolean }; chapter: { exists: boolean } }[]): number {
  return Math.max(0, ...finalizedNos(rows));
}

/** 定稿過、正文還在的章號（同 {@link finalizedThrough} 的口徑）：敘事線「還沒判」的那幾章從這裡面挑（四期）。 */
function finalizedNos(rows: readonly { no: number; summary: { exists: boolean }; chapter: { exists: boolean } }[]): number[] {
  return rows.filter((r) => r.summary.exists && r.chapter.exists).map((r) => r.no);
}
