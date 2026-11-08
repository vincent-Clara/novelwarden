import * as crypto from 'crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export function hash(text: string): string {
  return crypto.createHash('sha1').update(text.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);
}

/** 中文按字元計，英文按詞計，粗略但穩定。 */
export function countWords(text: string): number {
  const stripped = text.replace(/\s+/g, '');
  const cjk = (stripped.match(/[一-鿿㐀-䶿]/g) ?? []).length;
  const words = (text.match(/[A-Za-z0-9']+/g) ?? []).length;
  return cjk + words;
}

export function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

export function sanitizeFileName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/\s+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || '未命名'
  );
}

/** 從角色名生成 slug：ASCII 轉小寫連字元，中文保留。 */
export function slugify(name: string): string {
  return sanitizeFileName(name).toLowerCase() || 'unnamed';
}

export async function exists(absPath: string): Promise<boolean> {
  try {
    await fs.stat(absPath);
    return true;
  } catch {
    return false;
  }
}

export async function readText(absPath: string): Promise<string> {
  return fs.readFile(absPath, 'utf8');
}

/**
 * 讀一個**可能不存在**的檔案：讀不到就給 undefined，不拋。
 *
 * 取代 `exists()` + `readText()` 兩步走：那樣每個檔案要兩次系統呼叫（工程頁
 * 重新整理時每章的細綱與摘要各佔一次多餘的 stat），而且中間那一瞬檔案被刪掉的話
 * 仍然會拋——作者隨時在手改檔案，這條競態是真的會發生的。
 *
 * 「讀不到」包含三種：不存在（ENOENT）、路徑中間那一段不是目錄（ENOTDIR）、
 * 目標本身是個目錄（EISDIR）。對呼叫方它們是同一件事——**這一章沒有這份產物**，
 * 而作者手裡真的可能出現一個叫 `001-楔子.md` 的目錄。其餘錯誤（許可權、編碼）
 * 照常上拋：那些是呼叫方該知道的事，不該被悄悄當成「沒有」。
 */
export async function readTextIfExists(absPath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(absPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
      return undefined;
    }
    throw err;
  }
}

export async function writeText(absPath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, text, 'utf8');
}

/** 掃描時跳過的目錄名。 */
export function isIgnoredDir(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules';
}

/** 在某個區目錄下找一個沒被佔用的 slug。slug 可以帶子目錄字首。 */
export async function uniqueSlug(dirAbs: string, base: string): Promise<string> {
  let slug = base;
  let i = 2;
  while (await exists(path.join(dirAbs, `${slug}.md`))) {
    slug = `${base}-${i++}`;
  }
  return slug;
}
