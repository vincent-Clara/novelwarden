/**
 * 技能庫：三個來源的技能從哪讀、我的技能庫怎麼裝與卸。
 *
 * | 來源 | 在哪 | 誰往裡放 |
 * |---|---|---|
 * | 內建 | 倉庫裡的 [builtin/<名字>/](builtin/README.md)，構建時內嵌程序序 | 隨應用釋出，刪不掉 |
 * | 我的技能庫 | `~/.novelwarden/skills/<名字>/SKILL.md`，所有工程共用 | 設定頁「技能」或 agent 從 GitHub 裝；也可以手放 |
 * | 本工程 | `.novelwarden/skills/<名字>/SKILL.md`，跟著工程走、可進 Git | 作者手放 |
 *
 * 三個來源都是**常規的技能目錄**：`SKILL.md` 加上它引用的附帶檔案（`references/*.md` 這類）。
 * 讀一份技能就是讀 `SKILL.md`、再按引用把附帶檔案一層層讀進來（{@link collectSkillFiles}），
 * 交給 `inspectSkillMarkdown` 判相容、拼正文。目錄裡沒被引用的檔案不讀。
 *
 * **每次都讀盤**（與 `NovelProject` 的約定一樣）：作者隨時可能在編輯器裡改一份技能，下一次
 * 生成就該用改過的那份。一次裝配只讀繫結的那一份，不掃全庫。
 *
 * ## 容錯
 *
 * 一份讀不出來的技能不連累其餘的（上游同樣「單個無效不阻斷其餘」）；目錄不存在就是沒有；
 * 別的讀目錄錯誤記一條 warn、當作這個來源是空的——上游在這裡直接拋，於是工程裡一個讀不了的
 * `.vela/skills` 會讓該工程**每一個**工作流都起不來，哪怕一份技能都沒綁。
 *
 * **不跟連結**：符號連結的目錄與檔案一律跳過（上游 `app-data-controller.ts:285-309` 同樣只認
 * 真目錄），附帶檔案路徑上的每一段也是。我的技能庫在工程外，沒有 workspace 閘道器替它守邊界，
 * 這一條就是它的邊界。
 */
import type { Dirent, Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { homeDir } from '../stores';
import type { NovelProject } from '../model/project';
import {
  MAX_SKILL_ATTACHMENTS,
  MAX_SKILL_BYTES,
  SkillInspection,
  SkillSource,
  inspectSkillMarkdown,
  isSkillName,
  parseSkillId,
  skillId,
  skillReferences,
} from '../model/writingSkill';
import { scoped } from '../runtime/logger';
import { BUILTIN_SKILL_DIRS } from './builtin/embedded';

const log = scoped('技能');

const SKILL_FILE = 'SKILL.md';

/** 一份技能目錄裡的檔案：相對路徑（`/` 分隔）→ 文字。`SKILL.md` 本身也在裡面。 */
export type SkillFiles = Record<string, string>;

export interface LoadedSkill {
  /** `來源:名字`。 */
  id: string;
  source: SkillSource;
  /** id 裡的名字。使用者與工程技能就是目錄名。 */
  name: string;
  inspection: SkillInspection;
  /** 本工程技能在工程裡的相對路徑（明細與設定頁上點得開）。其餘來源沒有。 */
  relPath?: string;
  /** 磁碟上那份 `SKILL.md` 的絕對路徑。內建沒有。 */
  filePath?: string;
}

// ---------------------------------------------------------------- 我的技能庫在哪

let userDirOverride: string | undefined;

/** `~/.novelwarden/skills/`。 */
export function userSkillsDir(): string {
  return userDirOverride ?? path.join(homeDir(), 'skills');
}

/** 測試用：把「我的技能庫」指到臨時目錄。傳 undefined 復原。 */
export function setUserSkillsDir(dir: string | undefined): void {
  userDirOverride = dir;
}

/** 解除安裝的技能挪去哪：與技能庫同級的 `.trash/skills/`（預設即 `~/.novelwarden/.trash/skills/`）。 */
function userTrashDir(): string {
  return path.join(path.dirname(userSkillsDir()), '.trash', 'skills');
}

// ---------------------------------------------------------------- 讀

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * 從 `SKILL.md` 出發，按引用把附帶檔案一層層讀進來（附帶檔案裡再引用的也讀）。`read` 給相對路徑、
 * 迴文字，讀不到回 undefined——磁碟與 GitHub 各給一個。只讀能帶的（文字、在技能目錄裡），讀到
 * 上限（份數、位元組）就停：多出來的不讀，由 `inspectSkillMarkdown` 判「內容超過 64 KiB」。
 */
export async function collectSkillFiles(
  raw: string,
  read: (relPath: string) => Promise<string | undefined>
): Promise<SkillFiles> {
  const files: SkillFiles = { [SKILL_FILE]: raw };
  let bytes = utf8Bytes(raw);
  let count = 0;
  const queue = skillReferences(raw);
  while (queue.length > 0 && count <= MAX_SKILL_ATTACHMENTS && bytes <= MAX_SKILL_BYTES) {
    const ref = queue.shift()!;
    if (!ref.path || !ref.text || ref.path in files) {
      continue;
    }
    const text = await read(ref.path);
    if (text === undefined) {
      continue;
    }
    files[ref.path] = text;
    bytes += utf8Bytes(text);
    count++;
    queue.push(...skillReferences(text, ref.path));
  }
  return files;
}

/** 內建的不會變：讀一次留著。 */
let builtinCache: readonly LoadedSkill[] | undefined;

function builtins(): readonly LoadedSkill[] {
  builtinCache ??= Object.keys(BUILTIN_SKILL_DIRS)
    .sort()
    .map((name) => {
      const files = BUILTIN_SKILL_DIRS[name];
      return {
        id: skillId('builtin', name),
        source: 'builtin' as const,
        name,
        inspection: inspectSkillMarkdown(files[SKILL_FILE] ?? '', name, files),
      };
    });
  return builtinCache;
}

/** 全部技能：內建 → 我的技能庫 → 本工程（給了工程才掃）。各來源內按名字排。 */
export async function listSkills(project?: NovelProject): Promise<LoadedSkill[]> {
  const [user, own] = await Promise.all([
    scan(userSkillsDir(), 'user'),
    project ? scan(project.skillsDir, 'project', project) : Promise.resolve([]),
  ]);
  return [...builtins(), ...user, ...own];
}

/** 按 id 讀一份。找不到（沒有、讀不出、是連結、id 不合法）一律 undefined。 */
export async function loadSkill(id: string, project?: NovelProject): Promise<LoadedSkill | undefined> {
  const parsed = parseSkillId(id);
  if (!parsed) {
    return undefined;
  }
  if (parsed.source === 'builtin') {
    return builtins().find((s) => s.name === parsed.name);
  }
  if (parsed.source === 'project' && !project) {
    return undefined;
  }
  const root = parsed.source === 'user' ? userSkillsDir() : project!.skillsDir;
  return readOne(root, parsed.name, parsed.source, project);
}

async function scan(root: string, source: SkillSource, project?: NovelProject): Promise<LoadedSkill[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.warn(`讀不了技能目錄 ${root}，這個來源當作沒有技能`, String((err as Error)?.message ?? err));
    }
    return [];
  }
  const out: LoadedSkill[] = [];
  for (const entry of entries) {
    // Dirent 對符號連結報 isSymbolicLink、不報 isDirectory：連結在這裡就被跳過了。
    if (!entry.isDirectory()) {
      continue;
    }
    if (!isSkillName(entry.name)) {
      log.warn(
        `技能目錄「${entry.name}」的名字不合法，跳過`,
        '名字要以字母或數字開頭，只能含字母、數字、. _ -，最長 64 個字元。'
      );
      continue;
    }
    const skill = await readOne(root, entry.name, source, project);
    if (skill) {
      out.push(skill);
    }
  }
  // 按碼點排，不用 localeCompare：那個跟著系統區域走，中文名排在英文前還是後因機器而異。
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

async function readOne(
  root: string,
  name: string,
  source: SkillSource,
  project?: NovelProject
): Promise<LoadedSkill | undefined> {
  if (!isSkillName(name)) {
    return undefined;
  }
  const dir = path.join(root, name);
  const filePath = path.join(dir, SKILL_FILE);
  try {
    const [dirInfo, fileInfo] = await Promise.all([fs.lstat(dir), fs.lstat(filePath)]);
    if (!dirInfo.isDirectory() || !fileInfo.isFile()) {
      return undefined;
    }
    const raw = await fs.readFile(filePath, 'utf8');
    const files = await collectSkillFiles(raw, (rel) => readAttachment(dir, rel));
    return {
      id: skillId(source, name),
      source,
      name,
      inspection: inspectSkillMarkdown(raw, name, files),
      relPath: source === 'project' && project ? project.relPath(filePath) : undefined,
      filePath,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.warn(`讀不了技能 ${skillId(source, name)}`, String((err as Error)?.message ?? err));
    }
    return undefined;
  }
}

/** 技能目錄裡的一份附帶檔案。路徑上任何一段是連結、不是普通檔案、讀不出來，都當沒有。 */
async function readAttachment(dir: string, rel: string): Promise<string | undefined> {
  let current = dir;
  try {
    for (const seg of rel.split('/')) {
      current = path.join(current, seg);
      if ((await fs.lstat(current)).isSymbolicLink()) {
        return undefined;
      }
    }
    if (!(await fs.lstat(current)).isFile()) {
      return undefined;
    }
    return await fs.readFile(current, 'utf8');
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- 我的技能庫：裝與卸

/**
 * 把一份技能（`SKILL.md` 加附帶檔案）原樣寫進我的技能庫。**同名的已經有了就報錯退出**，不覆蓋
 * （第 3 條；上游同樣拒絕同名重灌——要換新版先解除安裝舊的）。
 *
 * 相容與否、是不是檢查過的那一份，由呼叫方（[github.ts](github.ts)）把關；這裡只管落盤。
 */
export async function installUserSkill(name: string, files: SkillFiles): Promise<LoadedSkill> {
  if (!isSkillName(name)) {
    throw new Error(`技能名「${name}」不合法：要以字母或數字開頭，只能含字母、數字、. _ -，最長 64 個字元。`);
  }
  if (typeof files[SKILL_FILE] !== 'string') {
    throw new Error('沒有 SKILL.md，不裝。');
  }
  const rels = Object.keys(files);
  const bad = rels.find((rel) => rel.split('/').some((seg) => !seg || seg === '.' || seg === '..' || seg.includes('\\')));
  if (bad !== undefined) {
    throw new Error(`附帶檔案的路徑「${bad}」不合法，不裝。`);
  }
  const root = userSkillsDir();
  await fs.mkdir(root, { recursive: true });
  if ((await fs.lstat(root)).isSymbolicLink()) {
    throw new Error(`${root} 是一個連結，不往裡寫。`);
  }
  const dir = path.join(root, name);
  try {
    await fs.mkdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
      throw new Error(`我的技能庫裡已經有「${name}」了。要換新版，先解除安裝舊的。`);
    }
    throw err;
  }
  for (const rel of rels) {
    const target = path.join(dir, ...rel.split('/'));
    if (rel.includes('/')) {
      await fs.mkdir(path.dirname(target), { recursive: true });
    }
    await fs.writeFile(target, files[rel], { encoding: 'utf8', mode: 0o600 });
  }
  const skill = await readOne(root, name, 'user');
  if (!skill) {
    throw new Error(`「${name}」寫進去之後讀不回來。`);
  }
  log.info(`已裝進我的技能庫：${name}`, path.join(dir, SKILL_FILE));
  return skill;
}

/**
 * 從我的技能庫解除安裝：**整個目錄挪進回收站**（`.trash/skills/`，同名的加 `-2`），不真刪（第 6 條
 * 的精神；上游是 `rmSync`）。返回落點；本來就沒有時返回 undefined。
 */
export async function uninstallUserSkill(name: string): Promise<string | undefined> {
  if (!isSkillName(name)) {
    throw new Error(`技能名「${name}」不合法。`);
  }
  const dir = path.join(userSkillsDir(), name);
  let info: Stats;
  try {
    info = await fs.lstat(dir);
  } catch {
    return undefined;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${dir} 不是一個普通目錄，不動它。`);
  }
  const trash = userTrashDir();
  await fs.mkdir(trash, { recursive: true });
  let dest = path.join(trash, name);
  for (let i = 2; await present(dest); i++) {
    dest = path.join(trash, `${name}-${i}`);
  }
  await fs.rename(dir, dest);
  log.info(`已從我的技能庫解除安裝：${name}`, `挪到 ${dest}`);
  return dest;
}

async function present(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}
