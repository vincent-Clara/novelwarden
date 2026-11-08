/**
 * 全書查詢替換面板（`bookFind.ts`）的純函式：結果按範圍分組、勾選（哪幾處勾掉了）與計數、拼替換請求、狀態行與彙總的
 * 說法、按「行 + 列」認回編輯區裡的位置。**零 DOM**（單測直接跑：`tests/unit/editor/bookFindCore.test.js`）。
 */
import { BOOK_FIND_SCOPES, BOOK_FIND_SCOPE_LABEL } from '../protocol';
import type {
  BookFindFile,
  BookFindQuery,
  BookFindResult,
  BookFindScope,
  BookReplaceRequest,
  BookReplaceSummary,
} from '../protocol';

/** 一處的身份：檔案 + 位置。勾掉的那幾處按它記，結果重推（預覽重來一遍）時還認得出是哪幾處。 */
export function hitKey(path: string, hit: { start: number; end: number }): string {
  return `${path}\u0000${hit.start}:${hit.end}`;
}

/** 結果按範圍分組（面板上的組標題），組內順序原樣（後端已經按章號 / 路徑排好）。 */
export interface ScopeGroup {
  scope: BookFindScope;
  label: string;
  files: BookFindFile[];
  /** 這一組列出來的處數。 */
  hits: number;
}

export function groupByScope(files: readonly BookFindFile[]): ScopeGroup[] {
  const groups: ScopeGroup[] = [];
  for (const scope of BOOK_FIND_SCOPES) {
    const inScope = files.filter((f) => f.scope === scope);
    if (inScope.length > 0) {
      groups.push({ scope, label: BOOK_FIND_SCOPE_LABEL[scope], files: inScope, hits: inScope.reduce((n, f) => n + f.hits.length, 0) });
    }
  }
  return groups;
}

/** 一份檔案的勾選框：全勾、勾了一部分、一處都沒勾。 */
export function fileCheck(file: BookFindFile, excluded: ReadonlySet<string>): 'all' | 'some' | 'none' {
  const picked = file.hits.filter((h) => !excluded.has(hitKey(file.path, h))).length;
  return picked === 0 ? 'none' : picked === file.hits.length ? 'all' : 'some';
}

/** 勾著的有幾個檔案幾處。`blocked` 裡的檔案（編輯器裡有未儲存的修改，替換時會跳過）不算。 */
export function pickedCount(
  files: readonly BookFindFile[],
  excluded: ReadonlySet<string>,
  blocked: ReadonlySet<string> = new Set()
): { files: number; hits: number } {
  let fileCount = 0;
  let hits = 0;
  for (const file of files) {
    if (blocked.has(file.path)) {
      continue;
    }
    const n = file.hits.filter((h) => !excluded.has(hitKey(file.path, h))).length;
    if (n > 0) {
      fileCount++;
      hits += n;
    }
  }
  return { files: fileCount, hits };
}

/** 重推的結果裡已經沒有的那幾處，從「勾掉的」裡拿掉（免得越攢越多）。 */
export function pruneExcluded(excluded: ReadonlySet<string>, files: readonly BookFindFile[]): Set<string> {
  const present = new Set(files.flatMap((f) => f.hits.map((h) => hitKey(f.path, h))));
  return new Set([...excluded].filter((k) => present.has(k)));
}

/**
 * 「替換所選」的請求：預覽時的查詢條件 + 每份檔案預覽時的 hash + 勾著的那幾處。編輯器裡有未儲存修改的那幾份照樣帶上
 * （列在 `dirty` 裡），後端跳過它們、在彙總裡說出來——作者看得到「這幾份因為沒儲存沒有換」。
 */
export function buildReplaceRequest(
  query: BookFindQuery,
  result: BookFindResult,
  excluded: ReadonlySet<string>,
  dirty: readonly string[]
): BookReplaceRequest {
  const dirtySet = new Set(dirty);
  const files = result.files
    .map((f) => ({
      path: f.path,
      hash: f.hash,
      hits: f.hits
        .filter((h) => dirtySet.has(f.path) || !excluded.has(hitKey(f.path, h)))
        .map((h) => ({ start: h.start, end: h.end })),
    }))
    .filter((f) => f.hits.length > 0);
  return {
    query: query.query,
    caseSensitive: query.caseSensitive === true,
    regex: query.regex === true,
    replacement: query.replacement ?? '',
    scopes: [...query.scopes],
    files,
    dirty: [...dirtySet].filter((p) => files.some((f) => f.path === p)),
  };
}

/** 狀態行：「12 個檔案，34 處」；預覽時補上勾著幾處。 */
export function resultStatus(
  result: BookFindResult,
  picked?: { files: number; hits: number },
  blockedFiles = 0
): string {
  if (result.error) {
    return '正則寫錯了';
  }
  if (result.files.length === 0) {
    return result.scanned === 0 && result.skipped.length === 0 ? '沒有可搜的檔案' : '全書沒有找到';
  }
  const base = `${result.files.length} 個檔案，${result.listed} 處`;
  if (!picked) {
    return base;
  }
  const blocked = blockedFiles > 0 ? `；${blockedFiles} 個檔案有未儲存的修改，會跳過` : '';
  return `${base} · 勾著 ${picked.files} 個檔案 ${picked.hits} 處${blocked}`;
}

/** 狀態行下面那幾句說明：到了上限、有檔案沒搜。 */
export function resultNotes(result: BookFindResult): string[] {
  const notes: string[] = [];
  if (result.truncated) {
    notes.push(
      `只列了前 ${result.truncated.limit} 處：搜到「${result.truncated.at}」就停了，後面的檔案沒有搜。多打幾個字縮小範圍；` +
        '替換也只作用於列出來的這些，換完再搜一次接著換。'
    );
  }
  if (result.skipped.length > 0) {
    notes.push(`${result.skipped.length} 個檔案沒有搜：${result.skipped.map((s) => `${s.label}（${s.reason}）`).join('、')}`);
  }
  return notes;
}

/** 幾章的稱呼連起來：最多點五個名，多的說「等 N 個」。 */
export function listLabels(labels: readonly string[], max = 5): string {
  const shown = labels.slice(0, max).join('、');
  return labels.length > max ? `${shown} 等 ${labels.length} 個` : shown;
}

export interface SummaryLine {
  text: string;
  tone?: 'warn' | 'error';
}

/** 替換完的彙總：替換了幾個檔案幾處、歷史版本是退路、指紋鏈怎麼處理的、角色卡改名、跳過了哪些與為什麼。 */
export function summaryLines(s: BookReplaceSummary): SummaryLine[] {
  if (s.error) {
    return [{ text: s.error, tone: 'error' }];
  }
  const out: SummaryLine[] = [];
  out.push({ text: s.files > 0 ? `替換了 ${s.files} 個檔案、共 ${s.hits} 處。` : '一處都沒有替換。' });
  if (s.files > 0) {
    out.push({
      text:
        '每個改過的檔案都可以在「歷史」裡找回替換前那一版（開啟那份檔案，點工具欄上的「歷史」）。' +
        '跨檔案的替換沒有一步撤銷，歷史版本就是退路。',
    });
  }
  if (s.chainKept.length > 0) {
    out.push({ text: `${listLabels(s.chainKept)}：細綱與正文這次一起改了，指紋跟著重新整理——正文不掛 ⟳，同步過的也不退回「待同步」。` });
  }
  if (s.plotOnly.length > 0) {
    out.push({ text: `${listLabels(s.plotOnly)}：只改了細綱、正文沒跟著改，正文會掛 ⟳（可能跟不上細綱了）。`, tone: 'warn' });
  }
  if (s.bodyOnly.length > 0) {
    out.push({ text: `${listLabels(s.bodyOnly)}：只改了正文、細綱沒跟著改，回到「待同步」。`, tone: 'warn' });
  }
  for (const card of s.renamedCards) {
    out.push({
      text: card.nameChanged
        ? `${card.label}：卡裡的名字改成了「${card.name}」，檔名沒跟著改（認人看的是卡裡的名字與別名，不看檔名）；想改檔名，在工程頁右鍵「重新命名」。`
        : `${card.label}：別名改了（認人看的是卡裡的名字與別名）。`,
    });
  }
  if (s.skipped.length > 0) {
    out.push({ text: `跳過了 ${s.skipped.length} 個檔案：`, tone: 'warn' });
    for (const skip of s.skipped) {
      out.push({ text: `${skip.label}——${skip.message}`, tone: 'warn' });
    }
  }
  return out;
}

/**
 * 編輯區裡第 `line` 行（從 1 起）第 `col` 個字（從 0 起）的下標；行號超了給末尾，列超了夾到那一行末尾。
 * 後端按磁碟上那一份算的「行 + 列」，編輯區裡是 `\n` 換行（磁碟上的 `\r\n` 進 textarea 就成了 `\n`），按下標會差出幾格。
 */
export function offsetAt(text: string, line: number, col: number): number {
  let pos = 0;
  for (let i = 1; i < line; i++) {
    const nl = text.indexOf('\n', pos);
    if (nl === -1) {
      return text.length;
    }
    pos = nl + 1;
  }
  const nl = text.indexOf('\n', pos);
  const lineEnd = nl === -1 ? text.length : nl;
  return Math.min(pos + Math.max(0, col), lineEnd);
}

/** 兩次查詢條件是不是同一個（預覽之後又改了輸入框，就不是）。 */
export function sameQuery(a: BookFindQuery | null, b: BookFindQuery): boolean {
  return (
    !!a &&
    a.query === b.query &&
    !!a.caseSensitive === !!b.caseSensitive &&
    !!a.regex === !!b.regex &&
    (a.replacement ?? null) === (b.replacement ?? null) &&
    a.scopes.length === b.scopes.length &&
    a.scopes.every((s) => b.scopes.includes(s))
  );
}
