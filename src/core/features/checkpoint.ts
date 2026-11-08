/**
 * 存檔點的兩件功能層的事（儲存在 `workspace/checkpoints.ts`，設計見 `docs/design/plans/2026-10-20-checkpoints.md`）：
 *
 * - {@link checkpointBefore}：批次動作之前自動存一個。十一處批次動作（批次寫章、補齊架構、批次拆細綱、全書替換、按目錄
 *   整理設定、批次展開設定、匯入原稿、從已寫正文補齊、立即同步、從正文補記敘事線、補推 / 重推故事時間）在作者點了「開始」、第一次寫盤之前調它。鉤子在功能層，
 *   外部 agent 經 MCP 調同一個批次功能也一樣先存。與最近一個存檔點一模一樣就不另存。**絕不拋**：存不下只記一條 warn，
 *   批次動作照常跑（第 1 條；每份檔案覆蓋之前照樣存歷史版本）。
 * - {@link restoreCheckpoint}：退回（單份或整本）的編排。面板上點了兩下「退回」就是那一問（第 3 條）。
 */
import { describeError, scoped } from '../runtime/logger';
import { hash } from '../model/fs';
import { NovelProject } from '../model/project';
import type { RestoreCheckpointRequest } from '../protocol/checkpoints';
import { Workspace, WsConflictError, WsError } from '../workspace';
import {
  CheckpointInfo,
  checkpointUnavailable,
  createCheckpoint,
  readCheckpoint,
  readCheckpointBytes,
} from '../workspace/checkpoints';
import { kindOfPath, normalizeRel } from '../workspace/kind';
import { readFile } from 'node:fs/promises';

const log = scoped('存檔點');

/**
 * 批次動作之前自動存一個存檔點，`note` 是給人看的那一句（「批次寫章之前（第 12–20 章）」）。返回存檔點的名字
 * （與最近一個一模一樣時是最近那一個）；還不是小說工程、存不下都給 undefined。絕不拋。
 */
export async function checkpointBefore(project: NovelProject, note: string): Promise<string | undefined> {
  try {
    if (await checkpointUnavailable(project)) {
      return undefined;
    }
    const r = await createCheckpoint(project, { note, auto: true });
    return r.id;
  } catch (err) {
    log.warn(`沒能先存一個存檔點（${note}），照常進行`, describeError(err));
    return undefined;
  }
}

/** 存檔點的說法：`10-20 22:30「第一卷寫完」`（沒備註就只有時間）。介面上、自動備註裡都用它。 */
export function describeCheckpoint(cp: Pick<CheckpointInfo, 'time' | 'note'>): string {
  const d = new Date(cp.time);
  const pad = (n: number) => String(n).padStart(2, '0');
  const when = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const note = cp.note.length > 20 ? `${cp.note.slice(0, 20)}…` : cp.note;
  return note ? `${when}「${note}」` : when;
}

export type RestoreSkipReason = 'dirty' | 'changed' | 'appeared' | 'notInCheckpoint' | 'inCheckpoint' | 'noBase' | 'unreadable' | 'failed';

export const RESTORE_SKIP_TEXT: Record<RestoreSkipReason, string> = {
  dirty: '編輯器裡有未儲存的修改：先儲存（或放棄修改），再退回一次',
  changed: '面板開啟之後別處又改過，沒拿存檔點裡的舊稿去蓋',
  appeared: '面板開啟之後又建出來了，沒動',
  notInCheckpoint: '存檔點裡沒有這一份',
  inCheckpoint: '這一份存檔點裡有，不是之後新建的，不搬進回收站',
  noBase: '面板上沒有它的記錄，沒動',
  unreadable: '存檔點裡這一份的內容讀不出來',
  failed: '寫不進去',
};

export interface RestoreOutcome {
  /** 沒退回的原因（有任務在跑、存檔點不在了、先存「退回之前」失敗）。給了它別的都是空的。 */
  refused?: string;
  /** 退回之前先存的那一個存檔點（與最近一個一模一樣時是最近那一個）。 */
  before?: string;
  restored: string[];
  trashed: string[];
  skipped: { path: string; reason: RestoreSkipReason; detail?: string }[];
}

/**
 * 退回：`paths` 裡的每一份寫回成存檔點裡的那一份，`trash` 裡的（存檔點之後新建的）搬進回收站。
 *
 * 1. 有任務在跑、或正在生成（`busy`），不退——一邊寫一邊退，結果誰也說不清。
 * 2. 先把要寫回的內容全部讀進來（存檔點裡的物件），再存「退回之前」：存的時候可能裁掉最舊的自動存檔點，要退回的
 *    恰好是它也不怕。
 * 3. 先存一個「退回到 … 之前」的自動存檔點——退回本身也能撤回。**存不下就不退回**（別處的自動存檔點存不下不擋事，
 *    唯獨這裡擋：沒有它，整本退回就收不回來了）。
 * 4. 逐份寫回（`Workspace.restoreBytes`：位元組原樣、守衛照過、覆蓋之前存一版歷史、不跑記賬）。編輯器裡有未儲存修改的
 *    跳過；樂觀鎖對不上（面板開啟之後別處改過、又建出來）跳過。搬進回收站的同樣帶樂觀鎖。
 * 5. 動過章節就同步一次 manifest。
 */
export async function restoreCheckpoint(
  project: NovelProject,
  req: RestoreCheckpointRequest,
  opts: { busy: boolean }
): Promise<RestoreOutcome> {
  const out: RestoreOutcome = { restored: [], trashed: [], skipped: [] };
  if (opts.busy) {
    return { ...out, refused: '有任務在跑（或正在生成）：等它跑完、或先停下，再退回。' };
  }
  let cp: CheckpointInfo;
  try {
    cp = await readCheckpoint(project, req.id);
  } catch (err) {
    return { ...out, refused: describeError(err) };
  }

  const dirty = new Set(listOf(req.dirty).map(normalizeRel).filter((p): p is string => !!p));
  const expect = req.expect && typeof req.expect === 'object' ? req.expect : {};
  const skip = (path: string, reason: RestoreSkipReason, detail?: string) => out.skipped.push({ path, reason, ...(detail ? { detail } : {}) });

  // 先把要寫回的內容讀進來。
  const toWrite: { rel: string; bytes: Buffer }[] = [];
  for (const rel of unique(listOf(req.paths))) {
    if (!cp.files[rel]) {
      skip(rel, 'notInCheckpoint');
      continue;
    }
    try {
      toWrite.push({ rel, bytes: await readCheckpointBytes(project, cp, rel) });
    } catch (err) {
      skip(rel, 'unreadable', describeError(err));
    }
  }
  const toTrash: string[] = [];
  for (const rel of unique(listOf(req.trash))) {
    if (cp.files[rel]) {
      skip(rel, 'inCheckpoint');
    } else {
      toTrash.push(rel);
    }
  }
  if (toWrite.length === 0 && toTrash.length === 0) {
    return out;
  }

  try {
    out.before = (await createCheckpoint(project, { note: `退回到${describeCheckpoint(cp)}之前`, auto: true })).id;
  } catch (err) {
    log.warn(`沒能先存一個「退回之前」的存檔點，沒有退回`, describeError(err));
    return { ...out, refused: `沒能先存一個「退回之前」的存檔點，沒有退回：${describeError(err)}` };
  }

  const ws = new Workspace(project);
  let chapters = false;
  for (const { rel, bytes } of toWrite) {
    if (dirty.has(rel)) {
      skip(rel, 'dirty');
      continue;
    }
    const base = expect[rel];
    if (base === undefined) {
      skip(rel, 'noBase');
      continue;
    }
    try {
      await ws.restoreBytes(rel, bytes, base === null ? { absent: true } : { baseHash: base });
      out.restored.push(rel);
      chapters ||= kindOfPath(project, rel).kind === 'chapter';
    } catch (err) {
      if (err instanceof WsConflictError) {
        skip(rel, 'changed');
      } else if (err instanceof WsError && err.code === 'exists') {
        skip(rel, 'appeared');
      } else {
        skip(rel, 'failed', describeError(err));
      }
    }
  }
  for (const rel of toTrash) {
    if (dirty.has(rel)) {
      skip(rel, 'dirty');
      continue;
    }
    const base = expect[rel];
    if (typeof base !== 'string') {
      skip(rel, 'noBase');
      continue;
    }
    let current: string;
    try {
      current = await readFile(project.pathOf(rel), 'utf8');
    } catch {
      continue; // 已經沒了：本來就是要它不在。
    }
    if (hash(current) !== base) {
      skip(rel, 'changed');
      continue;
    }
    try {
      await ws.remove(rel);
      out.trashed.push(rel);
      chapters ||= kindOfPath(project, rel).kind === 'chapter';
    } catch (err) {
      skip(rel, 'failed', describeError(err));
    }
  }
  if (chapters) {
    await project.syncManifest().catch((err) => log.warn('退回之後同步章節清單失敗', describeError(err)));
  }
  log.info(
    `退回到存檔點 ${cp.id}`,
    `退回 ${out.restored.length} 份｜搬進回收站 ${out.trashed.length} 份｜跳過 ${out.skipped.length} 份｜退回之前存在 ${out.before}`
  );
  return out;
}

function listOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** 規範化、去重；越界的丟掉。 */
function unique(paths: string[]): string[] {
  return [...new Set(paths.map(normalizeRel).filter((p): p is string => !!p))];
}
