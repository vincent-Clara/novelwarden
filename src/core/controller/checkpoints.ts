/**
 * 工程頁「存檔點…」彈窗與編輯器「版本」側欄「全書改動」的後端一半：列、存、寫備註、跟現在比、退回。儲存在
 * `workspace/checkpoints.ts`，退回的編排在 `features/checkpoint.ts`，設計見 `docs/design/plans/2026-10-20-checkpoints.md`。
 * 單份對比在內建編輯器的對比標籤裡（`media/src/editor/versionDiff.ts`，全文經 `readVersion` 的 `cp:` 取），這裡不管。
 */
import type { ChatController } from './index';
import { describeError, scoped } from '../runtime/logger';
import { activeTasks } from '../runtime/progress';
import type { CheckpointView, RestoreCheckpointRequest } from '../protocol/checkpoints';
import { NovelProject } from '../model/project';
import {
  CheckpointInfo,
  checkpointUnavailable,
  createCheckpoint,
  diffCheckpoint,
  listCheckpoints,
  noteCheckpoint,
} from '../workspace/checkpoints';
import { kindOfPath } from '../workspace/kind';
import { RESTORE_SKIP_TEXT, RestoreOutcome, describeCheckpoint, restoreCheckpoint } from '../features/checkpoint';

const log = scoped('存檔點');

/** 列出存檔點，回 `checkpoints`。 */
export async function pushCheckpoints(c: ChatController): Promise<void> {
  const unavailable = await checkpointUnavailable(c.project);
  c.post({
    type: 'checkpoints',
    entries: unavailable ? [] : (await listCheckpoints(c.project)).map((cp) => checkpointView(c.project, cp)),
    ...(unavailable ? { unavailable } : {}),
  });
}

export function checkpointView(project: NovelProject, cp: CheckpointInfo): CheckpointView {
  let chapters = 0;
  let chapterWords = 0;
  for (const [rel, f] of Object.entries(cp.files)) {
    if (kindOfPath(project, rel).kind === 'chapter') {
      chapters++;
      chapterWords += f.words;
    }
  }
  return {
    id: cp.id,
    time: cp.time,
    note: cp.note,
    auto: cp.auto,
    files: Object.keys(cp.files).length,
    chapters,
    chapterWords,
    skipped: cp.skipped,
  };
}

/** 「存一個存檔點」（手動）。之後重推列表。 */
export async function saveCheckpoint(c: ChatController, note: string): Promise<void> {
  const unavailable = await checkpointUnavailable(c.project);
  if (unavailable) {
    c.toast(unavailable, 'error');
    return;
  }
  try {
    const r = await createCheckpoint(c.project, { note: typeof note === 'string' ? note : '', auto: false });
    // 份數與內容數對不上很正常：同樣的內容（幾份空模板、以前的存檔點裡已經有的）只存一份。
    const shared =
      r.newObjects === 0 ? '（內容都與以前的存檔點共用，沒多佔地方）' : `（新存了 ${r.newObjects} 份內容，同樣的內容只存一份）`;
    const large = r.skipped.length > 0 ? `；${r.skipped.length} 份超過 2 MB 沒存：${clipList(r.skipped)}` : '';
    c.toast(`已存一個存檔點：${r.files} 份檔案${shared}${large}。`);
  } catch (err) {
    log.warn('存檔點沒存下', describeError(err));
    c.toast(`存檔點沒存下：${describeError(err)}`, 'error');
  }
  await pushCheckpoints(c);
}

/** 寫備註（自動的就此留住）。之後重推列表。 */
export async function setCheckpointNote(c: ChatController, id: string, note: string): Promise<void> {
  try {
    const cp = await noteCheckpoint(c.project, id, typeof note === 'string' ? note : '');
    c.toast(`存檔點 ${describeCheckpoint(cp)} 會一直留著，不會被自動裁掉。`);
  } catch (err) {
    c.toast(describeError(err), 'error');
  }
  await pushCheckpoints(c);
}

/** 跟現在比，回 `checkpointDiff`。 */
export async function pushCheckpointDiff(c: ChatController, id: string): Promise<void> {
  try {
    const d = await diffCheckpoint(c.project, id);
    c.post({ type: 'checkpointDiff', id, diff: { id, unchanged: d.unchanged, entries: d.entries } });
  } catch (err) {
    c.post({ type: 'checkpointDiff', id, error: describeError(err) });
  }
}

/** 退回（單份或整本）。之後 `pushState`、重推列表（多了「退回之前」那一個）與這個存檔點的比較。 */
export async function restoreCheckpointFor(c: ChatController, request: RestoreCheckpointRequest): Promise<void> {
  const req = request && typeof request === 'object' ? request : ({} as RestoreCheckpointRequest);
  const busy = c.busy || activeTasks(c.project.root).length > 0;
  const outcome = await restoreCheckpoint(c.project, req, { busy });
  if (outcome.refused) {
    c.toast(outcome.refused, 'error');
  } else {
    c.toast(describeOutcome(outcome), outcome.restored.length + outcome.trashed.length === 0 ? 'error' : 'info');
  }
  if (outcome.restored.length + outcome.trashed.length > 0) {
    await c.pushState();
  }
  await pushCheckpoints(c);
  if (typeof req.id === 'string') {
    await pushCheckpointDiff(c, req.id);
  }
}

/** 退回的彙總（toast）：退回幾份、搬進回收站幾份、跳過的逐份說為什麼（多了只列前幾份，其餘在日誌裡）。 */
export function describeOutcome(o: RestoreOutcome): string {
  const parts: string[] = [];
  if (o.restored.length + o.trashed.length === 0) {
    parts.push('一份都沒有退回');
  } else {
    parts.push(`已退回 ${o.restored.length} 份` + (o.trashed.length > 0 ? `，搬進回收站 ${o.trashed.length} 份` : ''));
  }
  if (o.skipped.length > 0) {
    const shown = o.skipped.slice(0, 3).map((s) => `${s.path}（${s.detail ?? RESTORE_SKIP_TEXT[s.reason]}）`);
    parts.push(`跳過 ${o.skipped.length} 份：${shown.join('；')}${o.skipped.length > 3 ? ' 等，明細在日誌裡' : ''}`);
    for (const s of o.skipped) {
      log.info(`退回時跳過 ${s.path}`, s.detail ?? RESTORE_SKIP_TEXT[s.reason]);
    }
  }
  if (o.before && o.restored.length + o.trashed.length > 0) {
    parts.push('退回之前的樣子存成了一個存檔點，想反悔可以再退回去');
  }
  return `${parts.join('。')}。`;
}

function clipList(paths: string[]): string {
  return paths.length > 3 ? `${paths.slice(0, 3).join('、')} 等` : paths.join('、');
}
