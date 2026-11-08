/**
 * 全書查詢（獨立版「編輯 → 全書查詢替換…」）：按範圍逐份讀盤、匹配，給出按檔案分組的結果。**只讀**，一個位元組都不寫；
 * 替換在 `features/bookReplace.ts`。一份檔案裡哪些字不搜、每一處的上下文在 `model/bookFind.ts`，匹配口徑是
 * `model/textFind.ts`（與內建編輯器的查詢條同一份）。
 *
 * ## 讀了哪些盤（每搜一次）
 *
 * 不建索引、不快取檔案內容：作者在編輯器裡存了一章，下一次搜到的就是新的。所以**每搜一次，範圍裡的每一份檔案讀一次**
 * （到了上限就停，後面的不讀）：
 *
 * - **正文 / 細綱**：先要一份章節 / 細綱列表（`NovelProject.listChapters()` / `listPlots()`，工程上快取著，每次
 *   `pushState` 都填上，作者開啟面板時幾乎總是熱的——熱的時候列表這一步**零讀盤**；冷的時候各遞迴掃一遍、每份讀一次），
 *   然後按章號逐份讀一次。三百章的正文約三百次讀盤，每份幾 KB，加起來幾十毫秒。
 * - **草稿**：遞迴列 `drafts/`（只列不讀），檔名像章節的按章號排，逐份讀一次；二進位制副檔名（與章節同一張黑名單）不讀。
 * - **角色卡 / 設定條目**：遞迴列各自的區（只認 `.md`，只列不讀），逐份讀一次。
 * - **其他創作檔案**：情節大綱、架構三件、文風指南、全文大綱六個固定路徑，有的讀一次；敘事線目錄這一層的各條線
 *   （只列不讀），逐份讀一次。
 * - 單份超過 2 MB（閘道器的大小上限）不讀，列進 `skipped`；讀不了（許可權、剛被刪）同樣。
 *
 * 前端在輸入停頓 300ms 之後才發請求，新的一次發出之前先叫停上一次（`cancelled`，在兩份檔案之間看一眼）。
 *
 * ## 上限
 *
 * 列滿 {@link BOOK_FIND_LIMIT} 處就停：這一份裡多出來的不列（`count` 照實說一共幾處），後面的檔案不再讀，`truncated`
 * 說停在哪一份上。替換也只作用於列出來的這些（預覽裡看過的才換），換完再搜一次接著換。
 *
 * ## 用的是磁碟上的內容（⚑）
 *
 * 編輯器裡開著、有未儲存修改的檔案，這裡搜的仍是磁碟上那一份——後端看不到編輯區，前端在結果上把那幾份標出來
 * （「未儲存：列的是磁碟上的」），替換時跳過它們。
 */
import * as path from 'node:path';
import { scoped } from '../runtime/logger';
import { NovelProject, listMarkdownDeep } from '../model/project';
import { NON_CHAPTER_EXTENSIONS, parseChapterFileName } from '../model/chapterFile';
import { exists } from '../model/fs';
import { BOOK_FIND_LIMIT, BOOK_FIND_SCOPES, BookFindScope, isBookFindScope } from '../model/bookFindScope';
import { describeHits, fileHits, replacementsAt } from '../model/bookFind';
import { compileSearch } from '../model/textFind';
import { Workspace, WsError, kindOfPath } from '../workspace';
import type { ArtifactKind } from '../workspace';
import { describeEditorFile } from './editorLabel';
import type { BookFindFile, BookFindQuery, BookFindResult, BookFindSkip } from '../protocol';

const log = scoped('全書查詢');

/** 一份要搜的檔案。 */
export interface BookTarget {
  path: string;
  scope: BookFindScope;
}

/** 閘道器的種類 → 全書查詢的範圍。不在任何一個範圍裡的（技能、`other`）是 undefined。 */
export function scopeOfKind(kind: ArtifactKind): BookFindScope | undefined {
  switch (kind) {
    case 'chapter':
    case 'plot':
    case 'draft':
    case 'character':
    case 'lore':
      return kind;
    case 'setting':
    case 'style':
    case 'threads':
    case 'globalSummary':
      return 'doc';
    default:
      return undefined;
  }
}

/** 結果上怎麼稱呼這份檔案：編輯器標籤上的短標記 + 麵包屑最後一段（「細綱 · 第 3 章 夜訪」「角色 · 林晚」「情節大綱」）。 */
export function bookFileLabel(project: NovelProject, rel: string): string {
  const label = describeEditorFile(project, rel);
  const leaf = label.crumbs[label.crumbs.length - 1]?.label ?? label.title;
  return label.tag ? `${label.tag} · ${leaf}` : leaf;
}

/**
 * 按範圍列出要搜的檔案，順序就是結果的順序：範圍按面板上的順序（正文、細綱、草稿、角色卡、設定、其他），
 * 正文 / 細綱 / 草稿按章號，角色卡、設定按路徑，其他按固定順序。只列，不讀內容（正文與細綱的列表借工程上的快取）。
 */
export async function listBookTargets(project: NovelProject, scopes: readonly BookFindScope[]): Promise<BookTarget[]> {
  const wanted = new Set(scopes.filter(isBookFindScope));
  const out: BookTarget[] = [];
  for (const scope of BOOK_FIND_SCOPES) {
    if (!wanted.has(scope)) {
      continue;
    }
    for (const rel of await pathsOf(project, scope)) {
      out.push({ path: rel, scope });
    }
  }
  return out;
}

async function pathsOf(project: NovelProject, scope: BookFindScope): Promise<string[]> {
  switch (scope) {
    case 'chapter':
      return (await project.listChapters()).map((c) => c.relPath);
    case 'plot':
      return (await project.listPlots()).map((p) => p.relPath);
    case 'draft': {
      const rows = [...(await project.listDraftPaths())]
        .filter((rel) => !NON_CHAPTER_EXTENSIONS.has(path.posix.extname(rel).toLowerCase()))
        .map((rel) => ({ rel, no: parseChapterFileName(path.posix.basename(rel))?.order ?? Number.MAX_SAFE_INTEGER }));
      rows.sort((a, b) => a.no - b.no || a.rel.localeCompare(b.rel));
      return rows.map((r) => r.rel);
    }
    case 'character':
      return (await listMarkdownDeep(project.charactersDir)).map((abs) => project.relPath(abs));
    case 'lore':
      return (await listMarkdownDeep(project.loreDir)).map((abs) => project.relPath(abs));
    case 'doc': {
      // 情節大綱不在裡面：它是各章細綱梗概的彙總，沒有檔案——搜細綱就搜到了。
      const fixed = [project.configPath, project.premisePath, project.worldPath, project.stylePath];
      const present = await Promise.all([...fixed, project.globalSummaryPath].map((abs) => exists(abs)));
      return [
        ...fixed.filter((_, i) => present[i]).map((abs) => project.relPath(abs)),
        // 敘事線一條線一個檔案：排在文風後面、全文大綱前面（從前單檔案 `threads.md` 的位置）。
        ...(await project.listThreadPaths()),
        ...(present[fixed.length] ? [project.relPath(project.globalSummaryPath)] : []),
      ];
    }
  }
}

export interface SearchBookOptions {
  /** 叫停了沒有。在兩份檔案之間看一眼，叫停了就不再往下讀。 */
  cancelled?: () => boolean;
  /** 最多列多少處（測試用，預設 {@link BOOK_FIND_LIMIT}）。 */
  limit?: number;
}

/**
 * 搜一遍。叫停了返回 undefined（不回話——前端早就不等這一份了）。正則寫錯、查詢串為空、一個範圍都沒勾時不讀盤，
 * 照實返回（`error` / 空結果）。
 */
export async function searchBook(
  project: NovelProject,
  q: BookFindQuery,
  opts: SearchBookOptions = {}
): Promise<BookFindResult | undefined> {
  const empty: BookFindResult = { files: [], listed: 0, scanned: 0, skipped: [] };
  const query = typeof q.query === 'string' ? q.query : '';
  const findOpts = { caseSensitive: q.caseSensitive === true, regex: q.regex === true };
  const compiled = compileSearch(query, findOpts);
  if (!compiled) {
    return empty;
  }
  if (!compiled.ok) {
    return { ...empty, error: compiled.error };
  }
  const limit = opts.limit ?? BOOK_FIND_LIMIT;
  const preview = typeof q.replacement === 'string' ? q.replacement : undefined;
  const ws = new Workspace(project);
  const targets = await listBookTargets(project, Array.isArray(q.scopes) ? q.scopes : []);

  const files: BookFindFile[] = [];
  const skipped: BookFindSkip[] = [];
  let listed = 0;
  let scanned = 0;
  let truncated: BookFindResult['truncated'];
  const started = Date.now();

  for (const target of targets) {
    if (opts.cancelled?.()) {
      log.debug(`叫停了：「${clip(query)}」`, `讀了 ${scanned} / ${targets.length} 份`);
      return undefined;
    }
    let text: string;
    let hash: string;
    try {
      const file = await ws.read(target.path);
      text = file.text;
      hash = file.hash;
    } catch (err) {
      skipped.push({ path: target.path, label: bookFileLabel(project, target.path), reason: skipReason(err) });
      continue;
    }
    scanned++;
    const kind = kindOfPath(project, target.path).kind;
    const found = fileHits(text, kind, query, findOpts);
    if (found.matches.length === 0) {
      continue;
    }
    const room = limit - listed;
    if (room <= 0) {
      // 上一份正好把上限列滿：這一份有命中，說明後面還有——停在這裡，這一份不列。
      truncated = { limit, at: bookFileLabel(project, target.path) };
      break;
    }
    const shown = found.matches.slice(0, room);
    const lines = describeHits(text, shown);
    const after = preview !== undefined ? replacementsAt(text, shown, query, preview, findOpts) : undefined;
    files.push({
      path: target.path,
      scope: target.scope,
      label: bookFileLabel(project, target.path),
      hash,
      count: found.matches.length,
      hits: lines.map((h, i) => (after && after[i] !== undefined ? { ...h, replacement: after[i] } : h)),
    });
    listed += shown.length;
    if (found.matches.length > room) {
      truncated = { limit, at: bookFileLabel(project, target.path) };
      break;
    }
  }

  log.debug(
    `${preview !== undefined ? '預覽替換' : '全書查詢'}「${clip(query)}」`,
    `${files.length} 個檔案 ${listed} 處｜讀了 ${scanned} / ${targets.length} 份｜${Date.now() - started}ms${truncated ? `｜到上限停在 ${truncated.at}` : ''}`
  );
  return { files, listed, scanned, skipped, ...(truncated ? { truncated } : {}) };
}

function skipReason(err: unknown): string {
  if (err instanceof WsError) {
    if (err.code === 'tooLarge') {
      return '超過 2 MB，沒有搜';
    }
    if (err.code === 'notFound' || err.code === 'notFile') {
      return '剛才還在，讀的時候沒有了';
    }
  }
  return `讀不了：${err instanceof Error ? err.message : String(err)}`;
}

/** 日誌裡的查詢串（第 11 條：日誌裡不出現正文全文；查詢串本來就短，再截一下）。存檔點的備註截得更短（`max`）。 */
export function clip(text: string, max = 30): string {
  const one = text.replace(/\s+/g, ' ');
  return one.length > max ? `${one.slice(0, max)}…` : one;
}
