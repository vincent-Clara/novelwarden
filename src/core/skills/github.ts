/**
 * 從 GitHub 裝技能：**先檢查、再確認安裝**，兩步之間內容變了就不裝。
 *
 * 移植自 AI-Novel-Writer `electron/controllers/app-data-controller.ts:133-379`：
 *
 * 1. **檢查**（`inspectGitHubSkill`）：下載 `SKILL.md` 和它引用的附帶檔案（同一個分支、相對
 *    `SKILL.md` 所在的目錄，一份份下；`references/*.md` 這類）、讀 frontmatter、跑相容檢查、對整份
 *    清單算 sha256，把「這個地址檢查過、內容是這個 hash」記在程序裡。不寫任何檔案。
 * 2. **安裝**（`installGitHubSkill`）：沒檢查過的地址不裝；**重新下載一遍**，hash 與落點都要與
 *    檢查時一致，不相容的不裝，同名的不覆蓋，然後原樣寫進我的技能庫。
 *
 * 第二步重新下載、而不是拿第一步的內容去寫：作者點「確認安裝」時看到的是第一步的結果，
 * 中間隔了多久不知道；確認的必須就是寫進去的那一份。
 *
 * 兩條路共用這一張檢查表：設定頁檢查過的地址 agent 也裝得了，反之亦然（上游同樣如此）——
 * 兩邊裝之前都要作者點頭（設定頁的確認框 / `skills install` 的 `always` 閘門）。
 *
 * 與上游不同：檢查結果**帶正文**給作者看（上游裝之前看不到技能寫了什麼）；程序裡那張表
 * 有上限，最早的先丟。
 */
import { createHash } from 'node:crypto';
import {
  MAX_SKILL_BYTES,
  SkillInspection,
  describeIncompat,
  githubRawUrl,
  inspectSkillMarkdown,
  isSafeGitHubPath,
  isSafeRef,
  isSkillName,
  parseGitHubSkillUrl,
} from '../model/writingSkill';
import { scoped } from '../runtime/logger';
import { LoadedSkill, SkillFiles, collectSkillFiles, installUserSkill, loadSkill } from './library';

const log = scoped('技能');

const TIMEOUT_MS = 10_000;
const MAX_URL_LENGTH = 2048;
const USER_AGENT = 'novelwarden';
/** 檢查過、還沒裝的地址最多記多少個。 */
const MAX_PENDING = 32;

export interface RemoteSkill {
  sourceUrl: string;
  /** 真正下載的那個 raw 地址。 */
  resolvedUrl: string;
  sha256: string;
  inspection: SkillInspection;
  /**
   * 裝不了的原因（不相容、名字不合法、我的技能庫裡已經有同名的）。空 = 可以裝。
   * 檢查時就說清，作者不必點了「確認安裝」才知道裝不了。
   */
  blockers: string[];
}

const inspected = new Map<string, RemoteSkill>();

function checkUrl(url: unknown): string {
  if (typeof url !== 'string' || !url.trim() || url.length > MAX_URL_LENGTH) {
    throw new Error('GitHub 地址無效');
  }
  return url.trim();
}

/** 下載並檢查。**不改任何東西**——那張檢查表除外。 */
export async function inspectGitHubSkill(url: string, signal?: AbortSignal): Promise<RemoteSkill> {
  const sourceUrl = checkUrl(url);
  inspected.delete(sourceUrl);
  const { remote } = await fetchSkill(sourceUrl, signal);
  inspected.set(sourceUrl, remote);
  while (inspected.size > MAX_PENDING) {
    inspected.delete(inspected.keys().next().value as string);
  }
  log.info(
    `檢查了技能「${remote.inspection.name}」`,
    `${remote.resolvedUrl}｜${remote.inspection.bytes} 位元組｜${remote.blockers.length > 0 ? `裝不了：${remote.blockers.join('；')}` : '可以裝'}`
  );
  return remote;
}

/** 這個地址檢查過的結果。**零 I/O**：agent 的確認框要用它說清裝的是什麼。 */
export function inspectedGitHubSkill(url: string): RemoteSkill | undefined {
  return typeof url === 'string' ? inspected.get(url.trim()) : undefined;
}

/** 安裝檢查過的那一份。見檔案頭的五道關。 */
export async function installGitHubSkill(url: string, signal?: AbortSignal): Promise<LoadedSkill> {
  const sourceUrl = checkUrl(url);
  const confirmed = inspected.get(sourceUrl);
  if (!confirmed) {
    throw new Error('請先檢查這份技能，再確認安裝。');
  }
  inspected.delete(sourceUrl);
  const { remote, files } = await fetchSkill(sourceUrl, signal);
  if (remote.sha256 !== confirmed.sha256 || remote.resolvedUrl !== confirmed.resolvedUrl) {
    throw new Error('這份技能在檢查之後變了，請重新檢查。');
  }
  if (remote.blockers.length > 0) {
    throw new Error(`裝不了：${remote.blockers.join('；')}`);
  }
  return installUserSkill(remote.inspection.name, files);
}

/** 整份技能的指紋：按路徑排好的「路徑 + 內容」，附帶檔案變了也算變了。 */
function manifestHash(files: SkillFiles): string {
  const hash = createHash('sha256');
  for (const rel of Object.keys(files).sort()) {
    hash.update(rel, 'utf8').update('\0').update(files[rel], 'utf8').update('\0');
  }
  return hash.digest('hex');
}

async function fetchSkill(sourceUrl: string, signal?: AbortSignal): Promise<{ remote: RemoteSkill; files: SkillFiles }> {
  const location = parseGitHubSkillUrl(sourceUrl);
  const timeout = (): AbortSignal =>
    signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);

  let ref = location.ref;
  if (!ref) {
    const repo = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repo)}`,
      {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT },
        redirect: 'error',
        signal: timeout(),
      }
    );
    if (!repo.ok) {
      throw new Error(`查不到這個 GitHub 倉庫（HTTP ${repo.status}）`);
    }
    const data = (await repo.json()) as { default_branch?: unknown };
    if (!isSafeRef(data.default_branch)) {
      throw new Error('GitHub 返回的預設分支名不受支援');
    }
    ref = data.default_branch;
  }

  const resolvedUrl = githubRawUrl(location.owner, location.repo, ref, location.path);
  const response = await fetch(resolvedUrl, {
    headers: { Accept: 'text/plain', 'User-Agent': USER_AGENT },
    redirect: 'error',
    signal: timeout(),
  });
  if (!response.ok) {
    throw new Error(`SKILL.md 下載失敗（HTTP ${response.status}）`);
  }
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_SKILL_BYTES) {
    throw new Error('SKILL.md 超過 64 KiB');
  }
  const raw = await response.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_SKILL_BYTES) {
    throw new Error('SKILL.md 超過 64 KiB');
  }

  // 附帶檔案：與 SKILL.md 同一個分支、相對它所在的目錄。404 當作沒有（引用了卻沒有，由相容檢查說）；
  // 別的失敗直接拋——那是網路或 GitHub 的問題，不該判成「這份技能不相容」。
  const baseDir = location.path.split('/').slice(0, -1);
  const fetched = await collectSkillFiles(raw, async (rel) => {
    const filePath = [...baseDir, ...rel.split('/')].join('/');
    if (!isSafeGitHubPath(filePath)) {
      return undefined;
    }
    const res = await fetch(githubRawUrl(location.owner, location.repo, ref!, filePath), {
      headers: { Accept: 'text/plain', 'User-Agent': USER_AGENT },
      redirect: 'error',
      signal: timeout(),
    });
    if (res.status === 404) {
      return undefined;
    }
    if (!res.ok) {
      throw new Error(`附帶檔案 ${rel} 下載失敗（HTTP ${res.status}）`);
    }
    if (Number(res.headers.get('content-length') ?? 0) > MAX_SKILL_BYTES) {
      throw new Error(`附帶檔案 ${rel} 超過 64 KiB`);
    }
    return res.text();
  });

  const inspection = inspectSkillMarkdown(raw, undefined, fetched);
  // 裝進去的就是會帶上的那幾份：SKILL.md 原樣，加上引用到的附帶檔案。
  const files: SkillFiles = { 'SKILL.md': raw };
  for (const a of inspection.attachments) {
    files[a.path] = fetched[a.path];
  }
  const blockers: string[] = [];
  if (!inspection.compatible) {
    blockers.push(`不是自包含的提示詞（${describeIncompat(inspection.reasons, inspection.unresolved)}）`);
  }
  if (!isSkillName(inspection.name)) {
    blockers.push(`frontmatter 裡的 name「${inspection.name}」不能當目錄名`);
  } else if (await loadSkill(`user:${inspection.name}`)) {
    blockers.push(`我的技能庫裡已經有「${inspection.name}」了，要換新版先解除安裝舊的`);
  }
  return {
    files,
    remote: {
      sourceUrl,
      resolvedUrl,
      sha256: manifestHash(files),
      inspection,
      blockers,
    },
  };
}
