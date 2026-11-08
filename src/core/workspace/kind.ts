/**
 * 路徑 → 種類。**純函式、零 I/O、絕不拋。**
 *
 * 這是整個 workspace 閘道器的地基：`write` 不是「往這個路徑寫位元組」，而是
 * 「按這個路徑**應有的種類**寫一份合法產物」——種類判定、渲染、記賬、伴生
 * 搬遷、覆蓋審閱全在閘道器裡做一次。判定得先有一張表。
 *
 * ## 為什麼必須絕不拋
 *
 * 這個函式會被**前端傳上來的路徑**呼叫（檔案頁的右鍵選單、內建編輯器的
 * 儲存、日後 agent 的工具引數）。認不出、越界、空串一律 `{ kind: 'other' }`，
 * 越界時連 `rel` 都不給——呼叫方據此判「這條路徑根本不該碰」，而不是拿一個
 * 拋出來的異常去猜。
 *
 * ## 三條必須記住的取捨
 *
 * 1. **正文就是章節**。一章一綱之後正文直接落 `chapters/`，沒有中轉站了。章節路徑
 *    **不帶創作目標**：第 12 章的細綱是正文路徑在 `summaries/` 下的映象
 *    （`NovelProject.plotPathForChapter`），配對要讀盤，不在這裡做。
 * 2. **`chapter` 與 `other` 的邊界不看是不是 `.md`**（AGENTS 第 9 條：章節
 *    不認副檔名）。章節根之下 + 數字字首 + 副檔名不在二進位制黑名單 → `chapter`。
 *    角色 / 設定 / 細綱**不**跟著放寬，它們是外掛自己的資料格式。
 * 3. **規則各自只定義一次**：章節名規則在 `model/chapterFile.ts`，細綱名在
 *    `model/plotFile.ts`。這裡只 import，絕不復制一份正則出來。
 *
 * ## 老工程的 `volumes/`、`manuscripts/`、`scenes/`、`plots/` 現在是 `other`
 *
 * 卷、中轉站、場景三層都刪掉了（見 `model/pipeline.ts` 的檔案頭）；細綱從 `plots/` 搬進了
 * `summaries/`，與單章摘要併成一份（見 `model/plotFile.ts` 的檔案頭）。老工程磁碟上
 * 那幾個目錄**一個位元組都不動**——它們是作者的檔案——但程式碼裡徹底不認它們：判成
 * `other`，於是工程頁不顯示、裝配器不讀、閘道器按普通文字處理。`guard.ts` 的 `isProtectedPath`
 * 仍然把那幾個目錄列為受保護目錄，免得哪條檔案操作把它們整棵刪掉。
 */
import * as path from 'node:path';
import { NovelProject } from '../model/project';
import { CreationStage, CreationTarget, SettingDoc } from '../model/pipeline';
import { parseChapterFileName } from '../model/chapterFile';
import { parsePlotFileName } from '../model/plotFile';

export type ArtifactKind =
  | 'setting'
  | 'outline'
  | 'style'
  | 'globalSummary'
  /**
   * 敘事線（2026-10-20 重做）：`.novelwarden/threads/` 這一層的 `.md`，一條線一個檔案，外加「未歸屬的伏筆」。
   * 鏈外：沒有創作階段，由排線、定稿寫（model/threadFile.ts）。七期那一份 `threads.md` 判 `other`。
   */
  | 'threads'
  /** 寫作技能：本工程的 `.novelwarden/skills/**` 與階段繫結 `.novelwarden/skills.json`。 */
  | 'skill'
  /**
   * 自定義敏感詞表 `.novelwarden/sensitive.txt`（內建編輯器的寫作體檢用）。鏈外：沒有創作階段、不進裝配器、
   * 不記指紋；單列一種而不落 `other`，是為了它照樣存歷史版本（作者手維護的詞表，改壞了要找得回來）。
   */
  | 'sensitive'
  | 'plot'
  | 'chapter'
  | 'draft'
  | 'character'
  | 'lore'
  | 'other';

export interface PathKind {
  kind: ArtifactKind;
  /** 規範化後的相對路徑（正斜槓）。越界時是 undefined，此時 kind 恆為 'other'。 */
  rel?: string;
  /** 該路徑對應的創作層。非創作產物為 undefined。 */
  stage?: CreationStage;
  /** 該路徑對應的創作目標，供 generate 直接用。 */
  target?: CreationTarget;
  /** 序號。章節與細綱的都是章號。 */
  no?: number;
  /** 細綱的路徑（`plot` 種類才有）。 */
  plotRelPath?: string;
  /** 架構的哪一件（`setting` 種類才有）。 */
  doc?: SettingDoc;
}

/**
 * 把使用者/前端給來的相對路徑收斂為「工程內的、用正斜槓的」相對路徑。
 * 絕對路徑、`..` 逃逸、空路徑一律返回 undefined。
 *
 * 逐字搬自 `files/fileOps.ts` 的 `normalizeRel`——那是六處守衛裡最早的一份，
 * 口徑不能變。fileOps 現在轉發到這裡。
 */
export function normalizeRel(relPath: string): string | undefined {
  const trimmed = (relPath ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!trimmed || path.posix.isAbsolute(trimmed) || /^[A-Za-z]:/.test(trimmed)) {
    return undefined;
  }
  const resolved = path.posix.normalize(trimmed);
  if (resolved === '..' || resolved.startsWith('../') || resolved === '.') {
    return undefined;
  }
  return resolved;
}

/** 工程裡幾個固定目錄的工作區相對路徑。每次算一遍，不快取——chaptersDir 可配。 */
interface Dirs {
  chapters: string;
  drafts: string;
  plots: string;
  characters: string;
  lore: string;
  config: string;
  premise: string;
  world: string;
  outline: string;
  style: string;
  globalSummary: string;
  threads: string;
  skills: string;
  skillBindings: string;
  sensitive: string;
}

function dirsOf(project: NovelProject): Dirs {
  return {
    chapters: project.relPath(project.chaptersDir),
    drafts: project.relPath(project.draftsDir),
    plots: project.relPath(project.plotsDir),
    characters: project.relPath(project.charactersDir),
    lore: project.relPath(project.loreDir),
    config: project.relPath(project.configPath),
    premise: project.relPath(project.premisePath),
    world: project.relPath(project.worldPath),
    outline: project.relPath(project.outlinePath),
    style: project.relPath(project.stylePath),
    globalSummary: project.relPath(project.globalSummaryPath),
    threads: project.relPath(project.threadsDir),
    skills: project.relPath(project.skillsDir),
    skillBindings: project.relPath(project.skillBindingsPath),
    sensitive: project.relPath(project.sensitivePath),
  };
}

/** rel 落在 root 之下（含 root 本身）時返回它在 root 下的那段，否則 undefined。 */
function under(rel: string, root: string): string | undefined {
  if (!root) {
    // chaptersDir 被配成 `.` 時 root 是空串：整個工程根都算章節區。
    return rel;
  }
  if (rel === root) {
    return '';
  }
  return rel.startsWith(`${root}/`) ? rel.slice(root.length + 1) : undefined;
}

/** 只認 markdown 家族的那幾個區（角色 / 設定）共用。細綱的名字規則在 `model/plotFile.ts`。 */
function isMd(rel: string): boolean {
  const ext = path.posix.extname(rel).toLowerCase();
  return ext === '.md' || ext === '.markdown';
}

/**
 * 路徑 → 種類。**絕不拋。**
 *
 * 判定順序有講究：固定單檔案（架構三件 / outline / style / global.md）排在各自所屬
 * 目錄之前——`summaries/global.md` 是全文大綱，不是一份細綱。
 */
export function kindOfPath(project: NovelProject, relPath: string): PathKind {
  const rel = normalizeRel(relPath);
  if (rel === undefined) {
    return { kind: 'other' };
  }
  const d = dirsOf(project);

  // ---- 固定單檔案。必須排在目錄判定之前。
  for (const doc of ['config', 'premise', 'world'] as const) {
    if (rel === d[doc]) {
      return { kind: 'setting', rel, doc, stage: 'setting', target: { kind: 'setting', doc } };
    }
  }
  if (rel === d.outline) {
    return { kind: 'outline', rel, stage: 'outline', target: { kind: 'outline' } };
  }
  if (rel === d.style) {
    return { kind: 'style', rel };
  }
  if (rel === d.globalSummary) {
    return { kind: 'globalSummary', rel };
  }
  // 敘事線：`threads/` 這一層的 markdown，一條線一個檔案（線不分子目錄：更深的、目錄本身、別的副檔名都是 `other`）。
  // 沒有創作階段，由排線與定稿寫。七期的 `threads.md` 不在這個目錄裡，落到最後的 `other`（不相容，設計稿「刪掉什麼」）。
  const inThreads = under(rel, d.threads);
  if (inThreads !== undefined && inThreads) {
    return !inThreads.includes('/') && isMd(inThreads) ? { kind: 'threads', rel } : { kind: 'other', rel };
  }
  // 寫作技能：鏈外，沒有創作階段。裝配器只經 core/skills/ 讀繫結的那一份。
  if (rel === d.skillBindings || under(rel, d.skills) !== undefined) {
    return { kind: 'skill', rel };
  }
  // 敏感詞表：鏈外的固定檔案，與技能同類——沒有創作階段，裝配器不讀，只有內建編輯器的體檢讀它。
  if (rel === d.sensitive) {
    return { kind: 'sensitive', rel };
  }

  // ---- 細綱。`summaries/` 下各級子目錄裡數字開頭的 markdown 家族（映象正文的相對路徑）。
  // 根下的 `global.md` 上面已經判過；老工程的 `plots/` 落到最後的 other。
  const inPlots = under(rel, d.plots);
  if (inPlots !== undefined && inPlots) {
    const parsed = parsePlotFileName(path.posix.basename(inPlots));
    if (parsed) {
      return {
        kind: 'plot',
        rel,
        no: parsed.no,
        stage: 'plot',
        target: { kind: 'plot', plotRelPath: rel },
        plotRelPath: rel,
      };
    }
    return { kind: 'other', rel };
  }

  // ---- 角色 / 設定。遞迴掃描，只認 `.md`。
  const inCharacters = under(rel, d.characters);
  if (inCharacters !== undefined && inCharacters) {
    return { kind: isMd(inCharacters) ? 'character' : 'other', rel };
  }
  // 一條設定條目是架構那一層的一個目標（展開，完善設定 2026-10-19）：MCP 的 `generate` 給條目路徑就是展開它。
  // 設定目錄本身仍是設定清單（角色目錄本身同理是角色圖譜），那一條只在 `generate` 裡認（tools/novel/generate.ts 的 `settingDirPath`）。
  const inLore = under(rel, d.lore);
  if (inLore !== undefined && inLore) {
    return isMd(inLore)
      ? { kind: 'lore', rel, stage: 'setting', target: { kind: 'lore', relPath: rel } }
      : { kind: 'other', rel };
  }

  // ---- 草稿。判定必須排在章節之前：`chaptersDir` 被配成 `.` 時
  // `drafts/` 會落進章節區（`chapterSkipDirs` 是同一條防線）。
  const inDrafts = under(rel, d.drafts);
  if (inDrafts !== undefined && inDrafts) {
    return { kind: 'draft', rel };
  }

  // ---- 章節。數字字首 + 副檔名不在二進位制黑名單，**不看是不是 `.md`**。
  const inChapters = under(rel, d.chapters);
  if (inChapters !== undefined && inChapters) {
    // `.novelwarden/` 在 chaptersDir 配成 `.` 時會落進來，但它上面幾條已經
    // 各自攔過；剩下的 `.novelwarden/xxx` 不該被當成章節。
    const parsed = inChapters.startsWith('.') ? undefined : parseChapterFileName(path.posix.basename(inChapters));
    return parsed ? { kind: 'chapter', rel, no: parsed.order } : { kind: 'other', rel };
  }

  return { kind: 'other', rel };
}

/**
 * 反過來：這個創作目標該落在哪個路徑。`acceptArtifact` 用它。
 *
 * 與 `kindOfPath` 互為逆運算（見 tests/unit/workspace/kind.test.js 的往返用例）。
 *
 * **正文不在這裡**：它落在同號的章節上，而同號的章節在不在、叫什麼名字要讀盤才
 * 知道——這個函式是純的。正文的落點走 views/pipeline.ts 的 `chapterTargetOf`。
 * 角色圖譜給的是角色目錄、設定清單給的是設定目錄：它們是一組卡 / 一組條目，不是一個檔案。
 * 單條設定就是那一條條目自己的路徑。
 */
export function pathOfTarget(project: NovelProject, target: CreationTarget): string {
  switch (target.kind) {
    case 'setting':
      return project.relPath(project.settingPath(target.doc));
    case 'outline':
      return project.relPath(project.outlinePath);
    case 'plot':
      return target.plotRelPath;
    case 'lore':
      return target.relPath;
    case 'manuscript':
      throw new Error('正文的落點要按章號去認同號的章節，請改用 views/pipeline.ts 的 chapterTargetOf。');
  }
}

/**
 * 這個路徑是不是一份細綱。工程頁的 rename/move/delete 據此分流。
 *
 * `files/fileOps.ts` 的同名匯出轉發到這裡，呼叫方不必改。
 */
export function isPlotPath(project: NovelProject, relPath: string): boolean {
  return kindOfPath(project, relPath).kind === 'plot';
}
