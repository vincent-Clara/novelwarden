/**
 * 採納：把一份產物寫進磁碟。按產物種類分派到八條落盤路徑。
 *
 * ## 與生成分開的那一步
 *
 * `generate` 只把文字交回介面，一個字都不寫磁碟；這裡才寫，且只在使用者點了
 * 採納之後（AGENTS 第 19 條）。中間那一步是使用者看著產物決定要不要的機會——
 * 少了它，「不靜默覆蓋」無從談起。
 *
 * ## 守衛不在這裡
 *
 * 落盤一律經 `workspace/` 閘道器：越界、同名、大小、樂觀鎖、覆蓋審閱、
 * `.trash`、`upstreamHash` 記賬，全在那一層做一次。本模組只做**分派**與
 * **人話訊息**——每條路徑的「跳過了哪幾個人」「新建了哪一章」必須說出來，
 * 默默少建三張角色卡，作者要到寫到那裡才發現。
 */
import { scoped } from '../runtime/logger';
import { hash, sanitizeFileName, slugify, uniqueSlug } from '../model/fs';
import { NovelProject, emptyCharacterSections, renderCharacterCard, renderLoreEntry } from '../model/project';
import { isPlotFilled, parsePlotFileName, plotContentHash, plotSynopsisHash } from '../model/plotFile';
import {
  LoreLine,
  LoreLookup,
  cleanLoreKeywords,
  createLoreLookup,
  loreThin,
  normalizeLoreName,
  splitLoreHidden,
} from '../model/loreFile';
import { hasOutlineContent, isOutlineFilled, mergeOutline, outlineOverlaps } from '../model/outlineFile';
import { hasContent } from '../model/markdown';
import { stampState } from '../model/characterState';
import { keepGender } from '../model/gender';
import { CHARACTER_SECTION_KEYS, CharacterCard, CharacterSections, LoreEntry } from '../model/types';
import { CreationTarget, SETTING_DOC_LABEL, WriteMode, loreOfTarget, plotOfTarget } from '../model/pipeline';
import { Artifact, ChapterRange, LoreDraft, LoreListEntry, PlotFields, RosterEntry } from '../features/artifact';
import { BlueprintItem, blueprintToPlot } from '../features/blueprint';
import { unique } from '../features/parse';
import { describePlanWrite, writePlannedThreads } from '../features/threadPlan';
import { chapterTargetOf } from '../views/pipeline';
import { buildLoreIndex } from '../views/lore';
import { integrationWatermark, loreEntryAt } from '../views/loreMaterial';
import { Workspace, pathOfTarget } from '../workspace';
import { acceptSettledLore, plannedLoreSettle } from './loreSettle';

const log = scoped('創作');

/** 採納的結果。`relPath` 是落盤位置，`skipped` 表示使用者在審閱時放棄了。 */
export interface AcceptResult {
  relPath?: string;
  skipped?: boolean;
  /** 一句人話，直接進 toast。 */
  message: string;
  /** 順帶新建的設定空條目在哪（一批細綱的「設定」一節 `isNew`）：批次拆細綱「拆完展開本批新設定」按它接著展開。 */
  createdLore?: string[];
}

/**
 * `onlyBlank`：批次那條路（工程頁「補齊架構」）。第 19 條的批次那一面——不問、不覆蓋：
 * 作者寫過的節一個字不動，只填空著的節，也就不必彈審閱。
 */
export interface AcceptOptions {
  onlyBlank?: boolean;
  /**
   * 正文的寫法（Draft 上記著的那一份）。`continue` 追加；其餘在這一章已有正文時覆蓋、
   * 寫入前審閱。缺席（老會話裡的 Draft）按「有正文就覆蓋審閱」——寧可多問一句，
   * 也不把一整章疊到已有的後面。
   */
  writeMode?: WriteMode;
}

/**
 * 落盤之前就能說清的事：會新建哪幾張角色卡。寫入卡片上要列出來（D19），
 * 不能等寫完了才在 toast 裡說「順便建了三張卡」。
 */
export async function plannedCards(project: NovelProject, artifact: Artifact): Promise<string[]> {
  if (artifact.kind !== 'plotBatch' && artifact.kind !== 'characterRoster') {
    return [];
  }
  const taken = takenNames(await project.listCharacters());
  const names =
    artifact.kind === 'plotBatch'
      ? artifact.items.flatMap((b) => b.newCharacters.map((c) => c.name))
      : artifact.characters.map((c) => c.name);
  return [...new Set(names)].filter((name) => !taken.has(name) && !taken.has(sanitizeFileName(name)));
}

function takenNames(cards: CharacterCard[]): Set<string> {
  return new Set(cards.flatMap((c) => [c.name, ...c.aliases, c.slug]));
}

/**
 * 同 {@link plannedCards}：落盤時會新建哪幾條設定條目，寫入卡片上列出來（設定名錄）。
 *
 * - 細綱（批次與單章，完善設定 §3）：「設定」一節裡 `isNew` 的新設定建空條目。
 * - 展開一條設定：建議拆出來的子條目建空條目（完善設定 §1）。
 * - 設定清單：清單裡還沒有條目的那幾條（已有的走覆蓋審閱，不算新建）。
 *
 * 前兩種是同一條規矩（{@link createPlannedLore}）：名字或關鍵詞已被已有條目佔了的、是角色卡上的人的，不建。
 * 落定設定（二期）另有一套認法（generation/loreSettle.ts），這裡只取它「會新建」那一半。
 */
export async function plannedLore(project: NovelProject, artifact: Artifact): Promise<string[]> {
  if (artifact.kind === 'loreEntries' && artifact.settle) {
    return (await plannedLoreSettle(project, artifact.entries)).creates;
  }
  const lines = newLoreLines(artifact);
  if (artifact.kind !== 'loreList' && lines.length === 0) {
    return [];
  }
  const [entries, cards] = await Promise.all([project.listLore(), project.listCharacters()]);
  const lookup = createLoreLookup(entries);
  const people = takenNames(cards);
  if (artifact.kind === 'loreList') {
    return artifact.entries.filter((e) => !existingLore(lookup, e) && !people.has(e.title)).map((e) => e.title);
  }
  return plannableLore(lines, lookup, people).map((l) => l.name);
}

/**
 * 產物裡要建空條目的那幾行：細綱批次與單章細綱是「設定」一節裡 `isNew` 的，展開是建議拆出來的子條目（沒有 `relPath`
 * 的那幾項，一句話當說明）。別的產物沒有。
 */
function newLoreLines(artifact: Artifact): LoreLine[] {
  switch (artifact.kind) {
    case 'plotBatch':
      return artifact.items.flatMap((b) => (b.settings ?? []).filter((s) => s.isNew));
    case 'plot':
      return artifact.newLore ?? [];
    case 'loreEntries':
      return artifact.entries.filter((e) => !e.relPath).map((e) => ({ name: e.title, category: e.category, note: e.brief }));
    default:
      return [];
  }
}

/** 真會建的那幾行：同名（歸一後）只留第一行；名字或關鍵詞已被已有條目佔了的、是角色卡上的人的不建。 */
function plannableLore(lines: readonly LoreLine[], lookup: LoreLookup, people: ReadonlySet<string>): LoreLine[] {
  const seen = new Set<string>();
  return lines.filter((l) => {
    const key = normalizeLoreName(l.name);
    if (!key || seen.has(key) || lookup.find(l.name) || people.has(l.name)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** 設定清單裡的一條認不認得出已有條目：先按名字，再按它的關鍵詞（與名錄同一張表，`createLoreLookup`）。 */
function existingLore(lookup: LoreLookup, entry: Pick<LoreListEntry, 'title' | 'keywords'>): LoreEntry | undefined {
  return lookup.find(entry.title) ?? entry.keywords.map((k) => lookup.find(k)).find((e) => !!e);
}

/**
 * 採納產物，寫進磁碟。
 *
 * **每一條覆蓋已有內容的路徑都走閘道器的覆蓋審閱。** 例外都不覆蓋任何東西：
 * 正文追加（往後加）與新建角色卡 / 設定條目（同名已存在的跳過或走各自的審閱）。
 */
export async function acceptArtifact(
  project: NovelProject,
  target: CreationTarget,
  artifact: Artifact,
  opts: AcceptOptions = {}
): Promise<AcceptResult> {
  const ws = new Workspace(project);
  switch (artifact.kind) {
    case 'settingDoc':
      return acceptSettingDoc(project, ws, artifact, opts);
    case 'characterRoster':
      return acceptRoster(project, ws, artifact.characters);
    case 'loreList':
      return acceptLoreList(project, ws, artifact, opts);
    case 'loreEntries':
      // 落定設定（二期）是一批、沒有目標條目，走自己的那條路（generation/loreSettle.ts）。
      return artifact.settle ? acceptSettledLore(project, ws, artifact.entries) : acceptLoreEntries(project, ws, target, artifact.entries);
    case 'outlineDoc':
      return acceptOutline(project, ws, artifact.text, artifact.range);
    case 'plot':
      return acceptPlot(project, ws, target, artifact);
    case 'manuscript':
      return acceptManuscript(project, ws, target, artifact.text, opts.writeMode);
    case 'plotBatch':
      return acceptPlotBatch(project, ws, artifact.items, artifact.range);
  }
}

/**
 * 小說配置 / 前提 / 世界觀：整份替換，覆蓋前審閱。配置的 frontmatter 由 handler 合併。
 *
 * **磁碟上那份一節內容都沒有時不審閱**：新工程裡躺著的是初始化寫的空模板（全是佔位），
 * 拿它跟產物 diff 一遍只是讓作者多點一次；而作者哪怕只填了一節，照舊先問。
 * 配置的 frontmatter（總章數、每章字數）不受影響——handler 沒給就沿用磁碟那份。
 */
async function acceptSettingDoc(
  project: NovelProject,
  ws: Workspace,
  artifact: Extract<Artifact, { kind: 'settingDoc' }>,
  opts: AcceptOptions
): Promise<AcceptResult> {
  const rel = pathOfTarget(project, { kind: 'setting', doc: artifact.doc });
  const what = SETTING_DOC_LABEL[artifact.doc];
  const current = await project.readSettingDoc(artifact.doc);
  const blank = !Object.values(current.sections).some((v) => v.trim());
  let art = artifact;
  // 批次只補空白：作者寫過的節原樣留著。配置不在這裡合——生成鏈已經按「保留原文，
  // 追加生成」合過了（generation/structured.ts 的 completeConfig）。
  if (opts.onlyBlank && artifact.doc !== 'config') {
    const sections = { ...artifact.sections };
    for (const [key, value] of Object.entries(current.sections)) {
      if (hasContent(value)) {
        sections[key] = value;
      }
    }
    art = { ...artifact, sections };
  }
  const r = await ws.write(rel, { artifact: art }, { mode: 'overwrite', what, review: !blank && !opts.onlyBlank });
  if (r.skipped) {
    return { skipped: true, message: `沒有改動${what}。` };
  }
  log.info(`${what}已寫入`, rel);
  const styleNote = artifact.style ? await acceptStyle(project, ws, artifact.style) : '';
  return { relPath: rel, message: `已寫入 ${rel}${styleNote}` };
}

/**
 * 配置草稿裡附帶的文風：**只在 `style.md` 還沒被動過時寫進去**（D14：文風的唯一出處
 * 是 `style.md`；第 3 條：作者寫過的一個字都不覆蓋）。沒寫進去也要說一句——
 * 作者看著卡片上那段文風，會以為它已經生效了。
 */
async function acceptStyle(project: NovelProject, ws: Workspace, style: string): Promise<string> {
  if (!(await project.styleGuideUntouched())) {
    log.info('文風指南已有作者的內容，配置裡附帶的文風沒有寫進去');
    return '；style.md 已有內容，附帶的文風沒有寫進去';
  }
  const rel = await ws.writeStyleGuide(style);
  log.info('配置附帶的文風已寫入文風指南', rel);
  return `；文風寫進了 ${rel}`;
}

/**
 * 角色圖譜：每人一張角色卡。
 *
 * - **沒有卡的人**直接建：新卡沒有作者寫過的內容可覆蓋，不走審閱（與「給未建卡的
 *   人物新建角色卡」同一口徑）。
 * - **同名（或別名撞上）已經有卡的**走覆蓋審閱，一張一審：作者可能已經把那張卡改得
 *   很細，重新生成一次圖譜不該靜默抹掉它（第 3 條）。新圖譜裡空著的節沿用舊卡；
 *   出場統計、別名這些卡上的記賬原樣保留。
 *
 * 建了幾張、覆蓋了幾張、保留了哪幾張，必須說出來。
 */
async function acceptRoster(project: NovelProject, ws: Workspace, entries: RosterEntry[]): Promise<AcceptResult> {
  const cards = await project.listCharacters();
  const taken = takenNames(cards);
  const created: string[] = [];
  const replaced: string[] = [];
  const kept: string[] = [];
  // 一張卡只處理一次：圖譜裡「林昭」與「阿昭」撞上的是同一張卡，第二次拿著寫之前的
  // 舊內容再合併一遍，會把第一次剛換上的那一版又改回去。
  const handled = new Set<string>();

  for (const entry of entries) {
    const slug = sanitizeFileName(entry.name);
    const existing = cards.find((c) => c.name === entry.name || c.aliases.includes(entry.name) || c.slug === slug);
    if (existing && handled.has(existing.relPath)) {
      continue;
    }
    if (existing) {
      handled.add(existing.relPath);
      const sections = mergeSections(existing.sections, entry.sections);
      const merged = {
        ...existing,
        aliases: [...new Set([...existing.aliases, ...entry.aliases])],
        tags: existing.tags.length > 0 ? existing.tags : entry.role ? [entry.role] : [],
        gender: keepGender(existing.gender, entry.gender),
        sections,
      };
      // 新圖譜給了「當前狀態」就是機器寫的開篇狀態（D15）：蓋章，定稿時才認得出它歸機器。
      // 沒給就沿用舊卡那一節，連同舊卡的章。
      const text = renderCharacterCard(hasContent(entry.sections.当前状态) ? stampState(merged, 0) : merged);
      const r = await ws.write(existing.relPath, { text }, { mode: 'overwrite', what: `角色卡「${existing.name}」` });
      (r.skipped ? kept : replaced).push(existing.name);
      continue;
    }
    if (taken.has(entry.name) || taken.has(slug)) {
      kept.push(entry.name);
      continue;
    }
    taken.add(entry.name);
    taken.add(slug);
    // 圖譜寫的「當前狀態」是開篇狀態（`stateThrough: 0`），蓋章歸機器（D15）。
    await ws.writeCharacter(
      stampState(
        {
          slug,
          name: entry.name,
          aliases: entry.aliases,
          tags: entry.role ? [entry.role] : [],
          gender: entry.gender,
          sections: { ...emptyCharacterSections(), ...entry.sections },
        },
        0
      )
    );
    created.push(entry.name);
  }

  const parts = [
    created.length > 0 ? `新建 ${created.length} 張角色卡` : '',
    replaced.length > 0 ? `覆蓋 ${replaced.join('、')}` : '',
    kept.length > 0 ? `保留原樣的 ${kept.join('、')}` : '',
  ].filter(Boolean);
  log.info('角色圖譜已落盤', parts.join('；') || '（沒有改動）');
  const first = created[0] ?? replaced[0];
  const rel = first ? cards.find((c) => c.name === first)?.relPath ?? `${project.relPath(project.charactersDir)}/${sanitizeFileName(first)}.md` : undefined;
  return created.length + replaced.length === 0
    ? { skipped: true, message: `沒有改動角色卡${kept.length > 0 ? `（保留原樣的 ${kept.join('、')}）` : ''}。` }
    : { relPath: rel, message: `${parts.join('，')}。` };
}

/** 新的一版裡有內容的節換新，空著的節沿用舊卡。 */
function mergeSections(old: CharacterSections, fresh: Partial<CharacterSections>): CharacterSections {
  const out = { ...old };
  for (const key of CHARACTER_SECTION_KEYS) {
    if (hasContent(fresh[key])) {
      out[key] = fresh[key]!.trim();
    }
  }
  return out;
}

/**
 * 設定清單：先建分類目錄（空的也建——分類就是目錄，作者看得到這本書的分類表），再一條一條落。
 *
 * - **還沒有條目的**直接建在 `lore/<分類>/`：新檔案不覆蓋任何東西，不走審閱（同 `acceptRoster` 建新卡）。
 *   正文是機器寫的，記下 `bodyHash`；水位 `updatedThrough: 0`——這是動筆之前排的，一章都還沒整合過。
 * - **名字（或關鍵詞）撞上已有條目的**走覆蓋審閱，一條一審（第 3 條）：關鍵詞並起來、一句話新的優先、
 *   正文新的沒寫出來就沿用舊的。正文換了新的，水位回到 0（新正文沒整合過任何一章，之前並進去的事實
 *   下次整合時再並一遍），指紋記新正文的。
 * - 批次補齊（`onlyBlank`）只建新的，撞上已有的一律不動、不問（第 19 條批次那一面）。
 *
 * 建了幾條、覆蓋了幾條、保留了哪幾條、建了哪幾個目錄，必須說出來。
 */
async function acceptLoreList(
  project: NovelProject,
  ws: Workspace,
  artifact: Extract<Artifact, { kind: 'loreList' }>,
  opts: AcceptOptions
): Promise<AcceptResult> {
  const folders = await ws.ensureLoreFolders(artifact.categories);
  const [entries, cards] = await Promise.all([project.listLore(), project.listCharacters()]);
  const lookup = createLoreLookup(entries);
  const people = takenNames(cards);
  const created: string[] = [];
  const replaced: string[] = [];
  const kept: string[] = [];
  // 一條只處理一次：清單裡兩條撞上同一個已有條目時，第二次會拿著寫之前的舊內容再合併一遍。
  const handled = new Set<string>();
  const fresh = new Set<string>();
  let first: string | undefined;
  // 模型給的關鍵詞過一遍：人名、別的條目（已有的、清單裡同一批的）的標題、名錄裡另記著的名字都不要
  // （model/loreFile.ts）。動筆之前名錄是空的；寫到一半再排清單時，定稿裡記下的名字不能被一條吞掉。
  const others = {
    titles: [...entries.map((e) => e.title), ...artifact.entries.map((e) => e.title)],
    people: cards.flatMap((c) => [c.name, ...c.aliases]),
    recorded: (await buildLoreIndex(project, { entries, cards }, { pending: false })).unknown.map((u) => u.name),
  };

  for (const entry of artifact.entries) {
    const key = normalizeLoreName(entry.title);
    if (!key || fresh.has(key)) {
      continue;
    }
    if (people.has(entry.title)) {
      log.info(`設定清單裡的「${entry.title}」是角色卡上的人，不建條目`);
      continue;
    }
    const existing = existingLore(lookup, entry);
    if (existing) {
      if (handled.has(existing.relPath)) {
        continue;
      }
      handled.add(existing.relPath);
      if (opts.onlyBlank) {
        kept.push(existing.title);
        continue;
      }
      const body = entry.body.trim();
      const text = renderLoreEntry({
        slug: existing.slug,
        title: existing.title,
        keywords: unique([...existing.keywords, ...cleanLoreKeywords(existing.title, entry.keywords, others)]),
        brief: entry.brief || existing.brief,
        ...(body
          ? { body, updatedThrough: 0, bodyHash: hash(body) }
          : { body: existing.body, updatedThrough: existing.updatedThrough, bodyHash: existing.bodyHash }),
      });
      const r = await ws.write(existing.relPath, { text }, { mode: 'overwrite', what: `設定「${existing.title}」` });
      (r.skipped ? kept : replaced).push(existing.title);
      first ??= r.skipped ? undefined : existing.relPath;
      continue;
    }
    fresh.add(key);
    const slug = await uniqueSlug(project.loreDir, `${entry.category ? `${entry.category}/` : ''}${slugify(entry.title)}`);
    const rel = await ws.writeLore({
      slug,
      title: entry.title,
      keywords: [entry.title, ...cleanLoreKeywords(entry.title, entry.keywords, others)],
      brief: entry.brief,
      body: entry.body,
      updatedThrough: 0,
      bodyHash: hash(entry.body.trim()),
    });
    created.push(entry.title);
    first ??= rel;
  }
  project.invalidate();

  const parts = [
    created.length > 0 ? `新建 ${created.length} 條設定條目` : '',
    replaced.length > 0 ? `覆蓋 ${replaced.join('、')}` : '',
    kept.length > 0 ? `保留原樣的 ${kept.join('、')}` : '',
    folders.length > 0 ? `新建分類目錄 ${folders.join('、')}` : '',
  ].filter(Boolean);
  log.info('設定清單已落盤', parts.join('；') || '（沒有改動）');
  return created.length + replaced.length + folders.length === 0
    ? { skipped: true, message: `沒有改動設定條目${kept.length > 0 ? `（保留原樣的 ${kept.join('、')}）` : ''}。` }
    : { relPath: first ?? project.relPath(project.loreDir), message: `${parts.join('，')}。` };
}

/**
 * 情節大綱：帶區間（續寫的那一段）時**只替換落在這一段裡的那幾條**，其餘原樣保留
 * （model/outlineFile.ts 的 `mergeOutline`）；不帶區間整篇替換。
 *
 * 大綱是各章細綱「梗概」的彙總，沒有檔案：合併好的整份交給閘道器（`Workspace.writeOutline`），由它按章號拆回各章細綱——
 * 改梗概、新章建只有梗概的細綱、刪掉的空殼進回收站（docs/design/plans/2026-10-22-outline-from-plots.md）。
 *
 * 審閱只在真的要換掉東西時彈：整篇替換一份有內容的大綱，或者續寫的這一段與已有的條目重疊。
 * 純續寫（第 21–40 章接在第 20 章後面）一個字都不吞，不必讓作者對比一遍。
 */
async function acceptOutline(
  project: NovelProject,
  ws: Workspace,
  text: string,
  range?: ChapterRange
): Promise<AcceptResult> {
  const rel = project.relPath(project.outlinePath);
  const existing = await project.readOutline();
  const next = range ? mergeOutline(existing, text, range) : text;
  const replacing = range && isOutlineFilled(existing) ? outlineOverlaps(existing, range) : hasOutlineContent(existing);
  const r = await ws.write(rel, { artifact: { kind: 'outlineDoc', text: next } }, {
    mode: 'overwrite',
    what: '情節大綱',
    review: replacing,
  });
  if (r.skipped) {
    return { skipped: true, message: '沒有改動大綱。' };
  }
  log.info('情節大綱已更新', `${next.length} 字${range ? `｜併入第 ${range.from}–${range.to} 章那一段` : ''}`);
  return { relPath: rel, message: r.message };
}

/**
 * 一章的細綱。
 *
 * - **已有這份檔案**：整份替換、覆蓋前審閱。渲染與記 `upstreamHash` 都在閘道器的
 *   plot handler 裡——三個小節換新，標題 / 目標字數 / done 沿用磁碟那份。
 * - **還沒有**（拆細綱給下一章找的落點、或老工程裡只有正文的章）：按章號與產物
 *   帶的標題新建。檔名裡的標題要等這一刻才定得下來，所以落點可能不是 target 上
 *   那個純序號的佔位路徑。
 */
async function acceptPlot(
  project: NovelProject,
  ws: Workspace,
  target: CreationTarget,
  fields: PlotFields & { kind: 'plot' }
): Promise<AcceptResult> {
  const relPath = plotOfTarget(target);
  if (!relPath) {
    throw new Error('這份細綱不屬於任何章。');
  }
  // 按章號認：佔位路徑（`summaries/003.md`）上採納過一次之後，檔案已經落成
  // `003-雪夜.md`，再採納要覆蓋它並先審閱，而不是當成新的再寫一份。
  const existing = await project.resolvePlot(relPath);
  if (existing) {
    const r = await ws.write(existing.relPath, { artifact: fields }, {
      mode: 'overwrite',
      what: `第 ${existing.no} 章的細綱`,
    });
    if (r.skipped) {
      return { skipped: true, message: '沒有改動這一章。' };
    }
    const lore = await createPlannedLore(project, ws, fields.newLore ?? []);
    const plan = await planThreads(project, existing.no, fields);
    log.info(`第 ${existing.no} 章的細綱已寫入`, existing.relPath);
    return { relPath: existing.relPath, message: `已寫入 ${existing.relPath}${loreNote(lore)}${plan}` };
  }

  const no = parsePlotFileName(relPath.split('/').pop() ?? '')?.no;
  if (!no) {
    throw new Error(`認不出這份細綱的章號：${relPath}`);
  }
  // 落點由閘道器定（有正文就是正文的映象）；target 上的佔位路徑只拿來定子目錄。
  const rel = await ws.writePlot(
    {
      no,
      title: fields.title ?? '',
      // D3：目標字數必填。藍圖合同裡沒有它，預設取配置的每章字數。
      targetWords: fields.targetWords ?? (await project.readBookConfig()).wordsPerChapter,
      upstreamHash: plotSynopsisHash(fields.sections.梗概),
      done: false,
      sections: fields.sections,
      lore: fields.lore,
    },
    undefined,
    relPath
  );
  const lore = await createPlannedLore(project, ws, fields.newLore ?? []);
  const plan = await planThreads(project, no, fields);
  log.info(`第 ${no} 章的細綱已新建`, rel);
  return { relPath: rel, message: `已新建 ${rel}${loreNote(lore)}${plan}` };
}

/** 單章細綱順帶建了空條目時，toast 裡那半句。 */
function loreNote(created: readonly string[]): string {
  return created.length > 0 ? `，新建設定條目：${created.join('、')}` : '';
}

/**
 * 單章細綱（生成、落定）寫進去之後：把它在敘事線上的計劃寫進各條線，整組換掉這一章原來的計劃（敘事線二期，
 * features/threadPlan.ts）。合同裡沒寫 `threads` 的不動。返回 toast 裡那半句。
 */
async function planThreads(project: NovelProject, no: number, fields: PlotFields): Promise<string> {
  if (!fields.threads) {
    return '';
  }
  return describePlanWrite(await writePlannedThreads(project, [{ no, entries: fields.threads }], fields.planNotes));
}

/**
 * 一批細綱：一章一份，逐章落。
 *
 * - **已經排過的章**（關鍵事件有內容）走覆蓋審閱，一章一審：主按鈕那一批永遠是空白的章
 *   （model/pipeline.ts 的拆細綱區間），走到這裡說明作者在這之間自己排了——不靜默蓋掉。
 * - **空殼**（有檔案、關鍵事件空著，多半是續寫大綱時建的只有梗概的那一份）直接填，並按產物的標題改名
 *   （`004.md` → `004-雪夜.md`）。**梗概沿用空殼的**：它是情節大綱裡這一章那一條，是這一批的上游，不讓模型順手改寫
 *   （docs/design/plans/2026-10-22-outline-from-plots.md）；空殼沒寫梗概才用產物的。
 * - **沒有檔案**的新建。目標字數預設取配置的每章字數（D3）。
 *
 * 然後給藍圖裡的新角色建卡（D19，同名已有的不動），再把**真寫進去的那幾章**在敘事線上的計劃寫進各條線（敘事線二期，
 * 整組換掉那幾章原來的計劃；作者在審閱裡放棄的、批次跳過的章不動）。批次那條路（features/pipelineBatch.ts）
 * 也走這裡——它只給空白的章，於是一張審閱都不會彈。
 */
export async function acceptPlotBatch(
  project: NovelProject,
  ws: Workspace,
  items: BlueprintItem[],
  range: ChapterRange,
  opts: { onlyBlank?: boolean } = {}
): Promise<AcceptResult> {
  const book = await project.readBookConfig();
  const written: string[] = [];
  const kept: number[] = [];
  /** 真寫進去的那幾章：敘事線的計劃只換它們的。 */
  const done = new Set<number>();
  for (const item of items) {
    const fields = blueprintToPlot(item);
    const existing = await project.getPlot(item.no);
    // 批次那條路只補空白（第 19 條）：跑的這幾十秒裡作者自己排了這一章，就不動它，也不問。
    if (existing && isPlotFilled(existing.sections) && opts.onlyBlank) {
      kept.push(item.no);
      continue;
    }
    if (existing && isPlotFilled(existing.sections)) {
      const r = await ws.write(existing.relPath, { artifact: { kind: 'plot', ...fields } }, {
        mode: 'overwrite',
        what: `第 ${item.no} 章的細綱`,
      });
      if (r.skipped) {
        kept.push(item.no);
      } else {
        written.push(r.rel);
        done.add(item.no);
      }
      continue;
    }
    done.add(item.no);
    const sections = hasContent(existing?.sections.梗概)
      ? { ...fields.sections, 梗概: existing!.sections.梗概 }
      : fields.sections;
    written.push(
      await ws.writePlot(
        {
          no: item.no,
          title: existing?.title || fields.title || '',
          targetWords: existing?.targetWords ?? book.wordsPerChapter,
          upstreamHash: plotSynopsisHash(sections.梗概),
          writtenFrom: existing?.writtenFrom,
          sourceHash: existing?.sourceHash,
          cast: existing?.cast,
          done: existing?.done ?? false,
          sections,
          lore: fields.lore ?? existing?.lore,
        },
        existing?.relPath
      )
    );
  }
  const cards = await createPlannedCards(project, ws, items);
  const created = await createPlannedLoreAt(
    project,
    ws,
    items.flatMap((b) => (b.settings ?? []).filter((s) => s.isNew))
  );
  const lore = created.map((c) => c.name);
  const plans = items.flatMap((b) => (done.has(b.no) && b.threads ? [{ no: b.no, entries: b.threads }] : []));
  const plan = plans.length > 0 ? describePlanWrite(await writePlannedThreads(project, plans)).replace(/^，/, '') : '';

  const where = range.from === range.to ? `第 ${range.from} 章` : `第 ${range.from}–${range.to} 章`;
  const parts = [
    `已寫入${where}的細綱 ${written.length} 份`,
    kept.length > 0 ? `保留原樣的第 ${kept.join('、')} 章` : '',
    cards.length > 0 ? `新建角色卡：${cards.join('、')}` : '',
    lore.length > 0 ? `新建設定條目：${lore.join('、')}` : '',
    plan,
  ].filter(Boolean);
  log.info(`${where}的細綱已落盤`, parts.join('；'));
  const createdLore = created.length > 0 ? { createdLore: created.map((c) => c.relPath) } : {};
  return written.length === 0 && cards.length === 0 && lore.length === 0
    ? { skipped: true, message: `沒有改動${where}的細綱。` }
    : { relPath: written[0], message: `${parts.join('，')}。`, ...createdLore };
}

/**
 * 藍圖裡新登場、後面還會出場的人：直接建卡（D19）。同名（或別名撞上）已有的不動。
 *
 * 卡上只寫得出這麼多：定位、在哪一章登場、那一章的梗概。其餘等寫到了、定稿過，
 * 再從正文裡更新——細綱裡的「計劃出場」不進出場統計（D13），這裡也不寫 `firstAppear`。
 */
async function createPlannedCards(project: NovelProject, ws: Workspace, items: BlueprintItem[]): Promise<string[]> {
  const taken = takenNames(await project.listCharacters());
  const created: string[] = [];
  for (const item of items) {
    for (const c of item.newCharacters) {
      const slug = sanitizeFileName(c.name);
      if (taken.has(c.name) || taken.has(slug)) {
        continue;
      }
      taken.add(c.name);
      taken.add(slug);
      await ws.writeCharacter({
        slug,
        name: c.name,
        aliases: [],
        tags: c.role ? [c.role] : [],
        gender: c.gender,
        sections: {
          ...emptyCharacterSections(),
          身份: `第 ${item.no} 章《${item.title}》登場${c.role ? `的${c.role}` : ''}。那一章：${item.synopsis}`,
        },
      });
      created.push(c.name);
    }
  }
  if (created.length > 0) {
    log.info(`細綱裡的新角色已建卡：${created.join('、')}`);
  }
  return created;
}

/**
 * 細綱裡本章首次引入、後面還會用到的設定（批次與單章都是「設定」一節裡 `isNew` 的那幾行），以及展開一條設定時建議
 * 拆出來的子條目：直接建一條空條目（設定名錄，同 D19 新角色建卡；第 19 條的例外）。名字或關鍵詞已被已有條目
 * 佔了的不動，是角色卡上的人的不建（{@link plannableLore}，卡片上列的是同一份）。
 *
 * 條目上只寫得出這麼多：標題、所在目錄（就是分類，不存在就建）、一句話（「設定」一節的說明 / 子條目的一句話）。
 * 正文留空，等寫到了、定稿過，再從名錄裡「整合」——或者在工程頁右鍵「展開」。
 */
async function createPlannedLore(project: NovelProject, ws: Workspace, lines: readonly LoreLine[]): Promise<string[]> {
  return (await createPlannedLoreAt(project, ws, lines)).map((c) => c.name);
}

/**
 * 同 {@link createPlannedLore}，交回建在哪：批次拆細綱「拆完展開本批新設定」與批次展開拆出來的子條目要按路徑接著認
 * （完善設定三期）。
 */
export async function createPlannedLoreAt(
  project: NovelProject,
  ws: Workspace,
  lines: readonly LoreLine[]
): Promise<{ name: string; relPath: string }[]> {
  if (lines.length === 0) {
    return [];
  }
  const [entries, cards] = await Promise.all([project.listLore(), project.listCharacters()]);
  const created: { name: string; relPath: string }[] = [];
  for (const s of plannableLore(lines, createLoreLookup(entries), takenNames(cards))) {
    const base = `${s.category ? `${s.category}/` : ''}${slugify(s.name)}`;
    const slug = await uniqueSlug(project.loreDir, base);
    const relPath = await ws.writeLore({ slug, title: s.name, keywords: [s.name], brief: s.note, body: '' });
    created.push({ name: s.name, relPath });
  }
  if (created.length > 0) {
    project.invalidate();
    log.info(`新設定已建空條目：${created.map((c) => c.name).join('、')}`);
  }
  return created;
}

/**
 * 展開一條設定（完善設定，2026-10-19）。`entries` 裡按 `relPath` 認出目標條目（展開不改名），其餘是建議拆出來的
 * 子條目。還沒定的問題（`questions`）不在這裡——它只上卡片，不寫進任何檔案。
 *
 * 目標條目：
 * - 正文整份換成展開後的（暗設是第四節 `## 暗設`）；關鍵詞只增不減（新給的過一遍人名、別的條目的標題——含這一次
 *   拆出去的子條目——與名錄裡另記著的名字）；一句話新的優先。
 * - 記作機器寫的：`bodyHash` = 新正文的指紋（作者定案 4：正文寫偏了以正文為準，整合可以直接改）；水位同整合
 *   （`integrationWatermark`）——展開喂的定稿記錄就是整合會喂的那一份，寫完 `＋N` 也就收了。
 * - **明面正文是空的、是佔位，又沒有暗設**才直接寫（沒有東西可吞）；其餘走覆蓋審閱（第 3 條）。三節都寫著
 *   「（未交代）」的也先對比：那可能是作者手寫的。
 * - 檔案還不在（MCP 給了一條新路徑、展開期間被刪了）：按這個路徑新建，標題取檔名；名字已被別的條目佔了、
 *   是角色卡上的人的不建。
 *
 * 子條目：建空條目（{@link createPlannedLore}，與細綱帶出新設定同一條規矩）。作者在覆蓋審閱裡放棄了這一條的
 * 展開時，拆出來的子條目也不建——它們是這一次展開的一部分。
 */
async function acceptLoreEntries(
  project: NovelProject,
  ws: Workspace,
  target: CreationTarget,
  drafts: readonly LoreDraft[]
): Promise<AcceptResult> {
  const relPath = loreOfTarget(target);
  const main = relPath ? drafts.find((d) => d.relPath === relPath) : undefined;
  if (!relPath || !main) {
    return { skipped: true, message: '這份產物裡沒有要展開的那一條設定，沒有寫入任何檔案。' };
  }
  const children = drafts.filter((d) => d !== main && !d.relPath);
  const [entries, cards] = await Promise.all([project.listLore(), project.listCharacters()]);
  const { entry, exists } = await loreEntryAt(project, relPath, entries);
  const people = cards.flatMap((c) => [c.name, ...c.aliases]);
  if (!exists) {
    const owner = createLoreLookup(entries).find(entry.title);
    if (owner || takenNames(cards).has(entry.title)) {
      const why = owner ? `已經有條目了（${owner.relPath}）` : '是角色卡上的人';
      log.warn(`展開的設定「${entry.title}」沒有新建：${why}`, relPath);
      return { skipped: true, message: `「${entry.title}」${why}，沒有新建 ${relPath}。` };
    }
  }

  const fresh = cleanLoreKeywords(entry.title, main.keywords, {
    titles: [...entries.filter((e) => e.relPath !== relPath).map((e) => e.title), ...children.map((c) => c.title)],
    people,
    recorded: (await buildLoreIndex(project, { entries, cards }, { pending: false })).unknown.map((u) => u.name),
  });
  const body = main.body.trim();
  const text = renderLoreEntry({
    slug: entry.slug,
    title: entry.title,
    keywords: unique([...(exists ? entry.keywords : [entry.title]), ...fresh]),
    brief: main.brief || entry.brief,
    body,
    // 只往前推不往回退：條目早就整合到了更後面（之後前面某章正文又改過、水位停在了那裡），不能把它拉回去，
    // 不然已經並進條目的那些章又掛上 ＋N。
    updatedThrough: Math.max(exists ? entry.updatedThrough ?? 0 : 0, await integrationWatermark(project)),
    bodyHash: hash(body),
  });
  const thin = exists ? loreThin(entry) : 'empty';
  const direct = (thin === 'empty' || thin === 'placeholder') && !splitLoreHidden(entry.body).hidden;
  const what = `設定「${entry.title}」`;
  const r = exists
    ? await ws.write(relPath, { text }, { mode: 'overwrite', what, review: !direct })
    : await ws.write(relPath, { text }, { mode: 'create', what });
  if (r.skipped) {
    log.info(`沒有採納${what}的展開`, children.length > 0 ? `拆出來的 ${children.length} 條也沒建` : relPath);
    return {
      skipped: true,
      message: `沒有改動${what}${children.length > 0 ? `（拆出來的 ${children.map((c) => c.title).join('、')} 也沒建）` : ''}。`,
    };
  }
  const created = await createPlannedLore(
    project,
    ws,
    children.map((c) => ({ name: c.title, category: c.category, note: c.brief }))
  );
  project.invalidate();
  log.info(
    `已展開${what}`,
    `${relPath}｜正文 ${body.length} 字｜${direct ? '原來只有一句話，直接寫' : '對比後採納'}` +
      `${created.length > 0 ? `｜新建子條目 ${created.join('、')}` : ''}`
  );
  return {
    relPath,
    message: `已展開${what}${created.length > 0 ? `，新建設定條目：${created.join('、')}` : ''}。`,
  };
}

/**
 * 正文：落在**同號的章節**上。三種寫法（model/pipeline.ts 的 `WriteMode`）：
 *
 * - 章節還沒有：在細綱所在的子目錄新建（`chapterTargetOf`；同名一律報錯，見閘道器），細綱檔名與
 *   新正文對不上時跟著改名，保證細綱仍是正文的映象。
 * - 章節在、但一個字正文都沒有（只有標題行）：直接填，不審閱——沒有東西可吞。
 * - `continue`：**追加**在末尾，不審閱（不覆蓋任何東西）。
 * - 其餘（`write` / `rewrite`，以及老會話裡沒記寫法的）：**覆蓋**，寫入前審閱 diff
 *   （第 3 條）。標題行沿用原檔案——那是作者起的名字，模型寫的正文裡沒有它。
 *
 * 落盤之後在細綱上記 `writtenFrom`（正文據以寫成的細綱指紋）。少了這一步，
 * 這一章會永遠顯示「正文與細綱對不上」或永遠不顯示，兩種都是錯的。
 * 作者在審閱時放棄了就什麼都不記。**修稿（`revise`）也不記**：它沒有照細綱重寫，只改了
 * 審稿指出的那幾處——細綱改過的 ⟳ 不能因為修了一次稿就消掉。
 */
async function acceptManuscript(
  project: NovelProject,
  ws: Workspace,
  target: CreationTarget,
  text: string,
  mode?: WriteMode
): Promise<AcceptResult> {
  const plotRelPath = plotOfTarget(target);
  if (!plotRelPath) {
    throw new Error('這段正文不屬於任何章。');
  }
  const dest = await chapterTargetOf(project, plotRelPath);
  let rel: string;
  let how: string;
  if (!dest.exists) {
    rel = await ws.createChapterAt(dest.rel, text, dest.plotRelPath);
    how = '新建';
  } else {
    const chapter = await project.getChapter(dest.no);
    const body = chapter ? await project.readChapterText(chapter) : '';
    const raw = chapter ? await project.readChapterRaw(chapter) : '';
    if (body.trim() && mode === 'continue') {
      rel = (await ws.write(dest.rel, { text }, { mode: 'append' })).rel;
      how = '追加';
    } else {
      const r = await ws.write(dest.rel, { text: withHeading(raw, body, text) }, {
        mode: 'overwrite',
        what: `第 ${dest.no} 章的正文`,
        review: !!body.trim(),
      });
      if (r.skipped) {
        return { skipped: true, message: `沒有改動第 ${dest.no} 章。` };
      }
      rel = r.rel;
      how = body.trim() ? '覆蓋' : '寫入';
    }
  }

  const plot = mode === 'revise' ? undefined : await project.resolvePlot(plotRelPath);
  if (plot) {
    await ws.recordWrittenFrom(plot.relPath, plotContentHash(plot));
  }
  await project.syncManifest();

  log.info(`已${how}第 ${dest.no} 章：${text.length} 字`, `${rel}｜同步過的話要重新同步`);
  return { relPath: rel, message: how === '追加' ? `已追加到 ${rel}` : `已寫入 ${rel}` };
}

/**
 * 覆蓋一章時保留原檔案的標題行（`# 標題`）。
 *
 * `raw` 是整個檔案、`body` 是去掉標題行之後的正文：兩者一樣就說明原檔案沒有標題行
 * （`.txt`、或作者刪了），那就原樣只寫正文，不憑空補一行。
 */
function withHeading(raw: string, body: string, text: string): string {
  const head = raw.trim() !== body.trim() ? /^[^\n]*\n?/.exec(raw.trimStart())?.[0].trim() : undefined;
  return head ? `${head}\n\n${text.trim()}\n` : `${text.trim()}\n`;
}
