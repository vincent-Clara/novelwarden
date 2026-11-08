/**
 * 內建編輯器「寫作體檢」要的那份詞表（`checkTerms` 訊息，型別在 `protocol/check.ts`），以及**這本書的禁用詞從
 * 哪幾份檔案、按什麼規則取**——寫正文的生成鏈（`generation/generate.ts` 的 `planWriting`）與編輯器的體檢都調
 * {@link readBannedTerms}，同一個函式、同一份輸入，編輯器裡標出來的與寫完一章之後數的不會是兩份詞表。
 *
 * 讀了哪些盤：`style.md`（一次）、`config.md`（呼叫方給了 `book` 就不讀——controller 構建 `ViewState` 時那趟
 * 流水線索引已經讀過）、`.novelwarden/sensitive.txt`（一次，沒有就是沒有）。controller 每次 `pushState` 都調，
 * 內容沒變就不推（`controller/check.ts`）。
 */
import { NovelProject } from '../model/project';
import { bannedTerms } from '../model/manuscriptCheck';
import { pickSections } from '../model/markdown';
import { readTextIfExists } from '../model/fs';
import { parseSensitiveWords } from '../model/sensitiveWords';
import type { BookConfig } from '../model/settingFile';
import type { CheckTermsView } from '../protocol/check';

/**
 * 這本書寫正文時不該用的詞（`model/manuscriptCheck.ts` 的 `bannedTerms`）：`style.md` 的「禁用詞表」一節、
 * 小說配置的「全域要求」、`config.md` 的型別與子型別。**生成鏈與編輯器的體檢都從這裡取**。
 */
export async function readBannedTerms(project: NovelProject, known: { book?: BookConfig } = {}): Promise<string[]> {
  const book = known.book ?? (await project.readBookConfig());
  return bannedTerms({
    styleBanList: pickSections(await project.readStyleGuide(), ['禁用词表']).禁用词表,
    guidance: book.sections.全局要求,
    genre: `${book.genre} ${book.subGenre}`,
  });
}

/** 編輯器的體檢詞表：禁用詞 + 自定義敏感詞表。讀不到的當沒有（第 1 條：絕不拋）。 */
export async function buildCheckTerms(project: NovelProject, known: { book?: BookConfig } = {}): Promise<CheckTermsView> {
  const banned = await readBannedTerms(project, known).catch(() => [] as string[]);
  const raw = await readTextIfExists(project.sensitivePath).catch(() => undefined);
  const list = parseSensitiveWords(raw);
  return {
    banned,
    sensitive: list.terms.map((t) => (t.replacement !== undefined ? { term: t.term, replacement: t.replacement } : { term: t.term })),
    sensitivePath: project.relPath(project.sensitivePath),
    sensitiveExists: raw !== undefined,
    sensitiveBad: list.bad.map((b) => ({ line: b.line, reason: b.reason })),
  };
}
