/**
 * 路徑 → 說給作者聽的名字。**三個框共用一份**。
 *
 * 覆蓋審閱那個框（`workspace.write` 的 `what`）、動手前的確認框
 * （工具自報的 `intent`）、以及採納寫入那條路，說的是同一份東西——
 * 「第 12 章的細綱」。三處各寫各的話，作者就會在兩個框裡看到同一份東西的
 * 兩個名字，然後不確定它們是不是一回事。
 *
 * 措辭逐字沿用採納路徑（`generation/accept.ts`）。
 */
import { kindOfPath } from '../../workspace';
import type { PathKind } from '../../workspace';
import type { NovelProject } from '../../model/project';
import { SETTING_DOC_LABEL } from '../../model/pipeline';

/** 覆蓋審閱框上顯示的名字。 */
export function describeForReview(path: PathKind, rel: string): string {
  const no = path.no;
  switch (path.kind) {
    case 'setting':
      return path.doc ? SETTING_DOC_LABEL[path.doc] : '世界觀';
    case 'outline':
      return '情節大綱';
    case 'style':
      return '文風指南';
    case 'globalSummary':
      return '全文大綱';
    case 'threads':
      return `敘事線 ${rel}`;
    case 'skill':
      return rel.endsWith('skills.json') ? '技能的階段繫結' : `技能 ${rel}`;
    case 'sensitive':
      return '敏感詞表';
    case 'plot':
      return no === undefined ? '這一章的細綱' : `第 ${no} 章的細綱`;
    case 'chapter':
      return no === undefined ? '這一章' : `第 ${no} 章`;
    case 'character':
      return `角色卡 ${rel}`;
    case 'lore':
      return `設定 ${rel}`;
    case 'draft':
      return `草稿 ${rel}`;
    default:
      return rel;
  }
}

/**
 * 確認框上顯示的名字。**零 I/O**（`kindOfPath` 是純函式），所以確認框上的
 * 名字與隨後 diff 上的名字逐字一致。
 *
 * 拿不到 project（純單測）時退回路徑本身——名字變糙，但不會因為少一個引數
 * 就說不出這一步要動哪份東西。
 */
export function describePath(rel: string, project?: NovelProject): string {
  if (!rel) {
    return '（沒給路徑）';
  }
  return project ? describeForReview(kindOfPath(project, rel), rel) : rel;
}

/** 摘一段短的進確認框。整段正文攤在框裡沒人讀得完。 */
export function clip(value: string, max = 60): string {
  const one = value.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** 引數取字串，其餘一律當沒給。模型偶爾會塞個 null 進來。 */
export function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
