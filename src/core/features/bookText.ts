/**
 * 拆書兩條路共用的取書：挑工程裡的哪一本 txt、讀出來、解碼（匯入原稿 features/importManuscript.ts、
 * 從參考書學寫法 features/reference.ts）。
 *
 * 作者親手點的入口可以選**本機任意一本**（`Host.pickHostFile`，沒有這個能力的宿主退回工程裡的清單）；
 * MCP 的 `book` 工具只認工程裡的相對路徑——外部 agent 不讀工程外的檔案。一整本書常常超過閘道器的 2 MiB
 * 編輯上限（第 7 條那一層是給編輯器與模型上下文的），這裡另有一道 {@link MAX_IMPORT_BYTES}：只讀、只解碼，
 * 不進編輯器，也不整份進上下文，更不寫回原處。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getHost } from '../host';
import { NovelProject } from '../model/project';
import { TextEncodingName, decodeTextBytes } from '../model/importText';
import { normalizeRel } from '../workspace/kind';
import { resolveInRoot } from '../workspace/guard';

/** 一整本最多多大。上游是 128 MB；三百萬字的中文 txt 也就十來 MB。 */
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

export interface BookText {
  /** 給作者看的路徑：工程裡的寫相對路徑，工程外的寫絕對路徑。 */
  shown: string;
  /** 書名：檔名去掉副檔名。 */
  title: string;
  text: string;
  encoding: TextEncodingName;
  bytes: number;
}

/**
 * 挑一本。返回工程內的相對路徑，或（作者在本機選的）絕對路徑，交給 {@link readBookText}。
 *
 * - 給了 `relPath`（MCP 的 `book` 工具）：只認工程裡能拆的 txt（`NovelProject.listImportableTexts`，
 *   章節檔案、草稿與隱藏目錄除外）——不讓它拿章節檔案或工程外的路徑來拆。
 * - 宿主能選本機檔案：直接開選擇器，從工程根起步。
 * - 否則從工程裡的 txt 挑；一本都沒有就說清楚該把 txt 放在哪，返回 undefined。
 */
export async function pickBookText(project: NovelProject, title: string, relPath?: string): Promise<string | undefined> {
  const host = getHost();
  if (relPath === undefined && host.pickHostFile) {
    return host.pickHostFile({ title, extensions: ['txt'], startDir: project.root });
  }
  const files = await project.listImportableTexts();
  if (relPath !== undefined) {
    const rel = normalizeRel(relPath);
    if (!rel || !files.some((f) => f.relPath === rel)) {
      throw new Error(`${relPath} 不是工程裡能拆的 txt：要是 .txt、在工程目錄裡（不在隱藏目錄裡），也不能是章節檔案。`);
    }
    return rel;
  }
  if (files.length === 0) {
    getHost().toast(
      `工程裡還沒有 txt。把整本 txt 放進工程目錄（不要放進隱藏目錄，也不要起數字開頭的名字放進 ${project.config.chaptersDir}/），再來一次。`,
      'error'
    );
    return undefined;
  }
  return getHost().pick(
    files.map((f) => ({
      label: path.posix.basename(f.relPath),
      description: path.posix.dirname(f.relPath) === '.' ? '工程根目錄' : path.posix.dirname(f.relPath),
      detail: formatBytes(f.bytes),
      value: f.relPath,
    })),
    title
  );
}

/**
 * 讀一本、解碼。`where` 是 {@link pickBookText} 給的：絕對路徑照讀，相對路徑過 `resolveInRoot`
 * （越界一律拒絕）。超過 {@link MAX_IMPORT_BYTES}、不是檔案、讀不到都拋（話直接進 toast）。
 */
export async function readBookText(project: NovelProject, where: string): Promise<BookText> {
  const abs = path.isAbsolute(where) ? path.resolve(where) : resolveInRoot(project.root, where);
  const inside = path.relative(project.root, abs);
  const shown = inside && !inside.startsWith('..') && !path.isAbsolute(inside) ? inside.split(path.sep).join('/') : abs;
  return readBookFile(abs, shown);
}

/**
 * 按絕對路徑讀一本、解碼，還沒有工程也能讀（歡迎頁「匯入寫好的書」先看切得出幾章，再建工程）。
 * 上限與報錯同 {@link readBookText}。
 */
export async function readBookFile(abs: string, shown = abs): Promise<BookText> {
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw new Error(`讀不到 ${shown}。`);
  }
  if (!stat.isFile()) {
    throw new Error(`${shown} 不是檔案。`);
  }
  if (stat.size > MAX_IMPORT_BYTES) {
    throw new Error(`${shown} 有 ${formatBytes(stat.size)}，超過 ${formatBytes(MAX_IMPORT_BYTES)}，不讀。`);
  }
  const { text, encoding } = decodeTextBytes(new Uint8Array(await fs.readFile(abs)));
  return { shown, title: path.basename(abs, path.extname(abs)), text, encoding, bytes: stat.size };
}

export function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** 「12.3 萬字」或「3200 字」。 */
export function formatWordCount(words: number): string {
  return words >= 10000 ? `${(words / 10000).toFixed(1)} 萬字` : `${words} 字`;
}
