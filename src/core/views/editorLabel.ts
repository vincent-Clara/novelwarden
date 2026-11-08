import { traditionalLabel } from '../model/labels';
import { UNFILED_FILENAME, TIMELINE_FILENAME } from '../model/threadFile';
/**
 * 內建編輯器怎麼稱呼一份檔案：標籤上的型別短標記與名字、工具欄上的麵包屑。
 *
 * **純函式、零 I/O、絕不拋**——每次 `editorOpen` / `editorSaved` / `editorDiskChanged` 都要帶一份，
 * 輸入是前端傳上來的路徑。種類來自 `workspace/kind.ts` 的 `kindOfPath`（與閘道器同一張表），章號與標題
 * 來自章節 / 細綱的檔名規則（`model/chapterFile.ts` / `model/plotFile.ts`）——與 `kind`、`draftPath`
 * 同一條原則：這些規則只在後端，前端不拿路徑猜。
 *
 * 標題取**檔名**裡的那一段，不讀 H1：讀盤要花一趟，而標籤上要的只是「這是哪一份」。
 *
 * | 種類 | 短標記 | 標籤上的名字 | 麵包屑 |
 * |---|---|---|---|
 * | 正文 `chapters/第一卷/003-夜访.md` | （不帶） | 003-夜訪 | 正文 › 第一卷 › 第 3 章 夜訪 |
 * | 細綱 `.novelwarden/summaries/第一卷/003-夜访.md` | 細綱 | 003-夜訪 | 細綱 › 第一卷 › 第 3 章 夜訪 |
 * | 草稿 `drafts/003-夜访.md` | 草稿 | 003-夜訪 | 草稿 › 第 3 章 夜訪 |
 * | 角色 / 設定 | 角色 / 設定 | 林晚 | 角色 › 配角 › 林晚 |
 * | 架構三件、情節大綱 | （不帶） | 小說配置 / 情節大綱 | 故事架構 › 小說配置 |
 * | 文風指南、全文大綱、敘事線、敏感詞表 | （不帶） | 文風指南 / 全文大綱 / 敘事線 / 敏感詞表 | 文風與摘要 › 文風指南 |
 * | 寫作技能 | 技能 | 技能目錄名 | 技能 › 名字 |
 * | 其他 | （不帶） | 原檔名（副檔名留著） | 按目錄一段一段 |
 */
import * as path from 'node:path';
import { NovelProject } from '../model/project';
import { SETTING_DOC_LABEL } from '../model/pipeline';
import { parseChapterFileName } from '../model/chapterFile';
import { parsePlotFileName } from '../model/plotFile';
import { kindOfPath } from '../workspace/kind';
import type { EditorCrumb, EditorFileLabel } from '../protocol';

/** 區根那一段怎麼叫。 */
const AREA_LABEL = {
  chapter: '正文',
  plot: '細綱',
  draft: '草稿',
  character: '角色',
  lore: '設定',
  threads: '敘事線',
  skill: '技能',
} as const;

/**
 * 架構三件之外那幾份固定檔案的中文稱呼。**與「轉到…」的索引（`views/quickOpen.ts`）共用這一張表**，
 * 與工程頁那幾行的叫法一致——同一份檔案在標籤上、麵包屑上、Ctrl+P 的候選裡不許叫兩個名字。
 * 架構三件用 `SETTING_DOC_LABEL`（同樣三處共用）。
 */
export const FIXED_DOC_LABEL = {
  outline: '情節大綱',
  style: '文風指南',
  threads: '敘事線',
  globalSummary: '全文大綱',
  sensitive: '敏感詞表',
} as const;

/** 有中文稱呼的固定檔案歸在哪一組（與工程頁的分組同一個說法）。 */
const ARCHITECTURE = '故事架構';
const STYLE_GROUP = '文風與摘要';

export function describeEditorFile(project: NovelProject, relPath: string): EditorFileLabel {
  const info = kindOfPath(project, relPath);
  const rel = info.rel ?? normalizeSlashes(relPath);
  const base = path.posix.basename(rel);

  switch (info.kind) {
    case 'chapter':
      return inArea(project.relPath(project.chaptersDir), rel, '', AREA_LABEL.chapter, chapterLeaf(base));
    case 'plot':
      return inArea(project.relPath(project.plotsDir), rel, AREA_LABEL.plot, AREA_LABEL.plot, plotLeaf(base));
    case 'draft':
      // 草稿映象正文的路徑：檔名像章節的照樣寫「第 N 章 標題」。
      return inArea(project.relPath(project.draftsDir), rel, AREA_LABEL.draft, AREA_LABEL.draft, chapterLeaf(base));
    case 'character':
      return inArea(project.relPath(project.charactersDir), rel, AREA_LABEL.character, AREA_LABEL.character, plainLeaf(base));
    case 'lore':
      return inArea(project.relPath(project.loreDir), rel, AREA_LABEL.lore, AREA_LABEL.lore, plainLeaf(base));
    case 'setting':
      return fixed(rel, ARCHITECTURE, info.doc ? SETTING_DOC_LABEL[info.doc] : stem(base));
    case 'outline':
      return fixed(rel, ARCHITECTURE, FIXED_DOC_LABEL.outline);
    case 'style':
      return fixed(rel, STYLE_GROUP, FIXED_DOC_LABEL.style);
    case 'globalSummary':
      return fixed(rel, STYLE_GROUP, FIXED_DOC_LABEL.globalSummary);
    case 'threads':
      // 敘事線一條線一個檔案（`threads/<線名>.md`）：標籤上是線名，麵包屑「敘事線 › 線名」，短標記「敘事線」。
      return inArea(project.relPath(project.threadsDir), rel, AREA_LABEL.threads, AREA_LABEL.threads, threadLeaf(base));
    case 'sensitive':
      return fixed(rel, STYLE_GROUP, FIXED_DOC_LABEL.sensitive);
    case 'skill':
      return skillLabel(project, rel, base);
    default:
      return otherLabel(rel, base);
  }
}

/** 在某個區裡的檔案：區根一段（可點）、中間各級目錄（可點）、最後是這份檔案。 */
function inArea(
  root: string,
  rel: string,
  tag: string,
  areaLabel: string,
  leaf: { title: string; crumb: string }
): EditorFileLabel {
  const under = root && rel.startsWith(`${root}/`) ? rel.slice(root.length + 1) : rel;
  const dirs = under.split('/').slice(0, -1);
  const crumbs: EditorCrumb[] = [{ label: areaLabel, dir: root }];
  let cur = root;
  for (const dir of dirs) {
    cur = cur ? `${cur}/${dir}` : dir;
    crumbs.push({ label: dir, dir: cur });
  }
  crumbs.push({ label: leaf.crumb });
  return { tag, title: leaf.title, crumbs };
}

/** 固定的單檔案：組名一段（點了定位到它所在的目錄）+ 中文稱呼。 */
function fixed(rel: string, group: string, title: string): EditorFileLabel {
  return { tag: '', title, crumbs: [{ label: group, dir: parentOf(rel) }, { label: title }] };
}

function skillLabel(project: NovelProject, rel: string, base: string): EditorFileLabel {
  const root = project.relPath(project.skillsDir);
  if (!root || !rel.startsWith(`${root}/`)) {
    // 階段繫結那一份（`.novelwarden/skills.json`）。
    return { tag: AREA_LABEL.skill, title: '技能繫結', crumbs: [{ label: AREA_LABEL.skill, dir: root }, { label: '技能繫結' }] };
  }
  // `skills/<名字>/SKILL.md` 叫那個名字；技能目錄裡別的檔案叫自己的檔名。
  const parts = rel.slice(root.length + 1).split('/');
  const title = parts.length === 2 && /^skill\.md$/i.test(parts[1]) ? parts[0] : stem(base);
  return inArea(root, rel, AREA_LABEL.skill, AREA_LABEL.skill, { title, crumb: title });
}

/** 認不出的檔案：原檔名（副檔名留著——`project.json` 去掉副檔名就認不出了），目錄一段一段。 */
function otherLabel(rel: string, base: string): EditorFileLabel {
  const parts = rel.split('/').filter(Boolean);
  const crumbs: EditorCrumb[] = [];
  let cur = '';
  for (const dir of parts.slice(0, -1)) {
    cur = cur ? `${cur}/${dir}` : dir;
    crumbs.push({ label: dir, dir: cur });
  }
  crumbs.push({ label: base || rel });
  return { tag: '', title: base || rel, crumbs };
}

/** 章節（與映象它的草稿）：標籤上是去掉副檔名的檔名，麵包屑上是「第 N 章 標題」。 */
function chapterLeaf(base: string): { title: string; crumb: string } {
  const parsed = parseChapterFileName(base);
  return parsed ? { title: stem(base), crumb: chapterCrumb(parsed.order, parsed.stem) } : plainLeaf(base);
}

function plotLeaf(base: string): { title: string; crumb: string } {
  const parsed = parsePlotFileName(base);
  return parsed ? { title: stem(base), crumb: chapterCrumb(parsed.no, parsed.stem) } : plainLeaf(base);
}

/** 只翻譯兩個固定保留檔案的顯示名稱，不翻譯作者自訂的線名。 */
function threadLeaf(base: string): { title: string; crumb: string } {
  const leaf = plainLeaf(base);
  return base === UNFILED_FILENAME || base === TIMELINE_FILENAME
    ? { title: traditionalLabel(leaf.title), crumb: traditionalLabel(leaf.crumb) }
    : leaf;
}

function plainLeaf(base: string): { title: string; crumb: string } {
  const title = stem(base);
  return { title, crumb: title };
}

/** 「第 3 章 夜訪」；檔名裡沒有標題時就是「第 3 章」。 */
function chapterCrumb(no: number, title: string): string {
  const named = title.trim();
  return named ? `第 ${no} 章 ${named}` : `第 ${no} 章`;
}

/** 去掉副檔名。只有副檔名的（`.gitignore`）原樣留著。 */
function stem(base: string): string {
  const ext = path.posix.extname(base);
  return ext && ext !== base ? base.slice(0, -ext.length) : base;
}

function parentOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
}

function normalizeSlashes(rel: string): string {
  return (rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
}
