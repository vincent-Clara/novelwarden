/**
 * 內建編輯器的「不丟稿」後端一半：衝突時的對比合併，與「版本」側欄的列、讀、現在存一版。
 *
 * 對比合併**不寫盤**：結果經 `editorReplace` 交回發起的那個頁面，前端用 `Pane.applyEdit` 換進編輯區（一步撤銷，成為
 * 未儲存），存不存由作者（第 3 條）。合併檢視是宿主的能力（`Host.mergeTexts`，獨立版有、外掛殼沒有）：沒有的宿主只回一句
 * 說明，不拋。
 *
 * 「版本」側欄的時間線是這份檔案的快照（閘道器在覆蓋之前存的，`workspace/history.ts`）與它在各存檔點裡的樣子
 * （`workspace/checkpoints.ts`）混排；這裡只讀。兩版之間怎麼不同、放回哪一處都是前端的事（`editor/versionDiff.ts`），
 * 後端只給全文。
 */
import * as path from 'node:path';
import type { ChatController } from './index';
import { getHost } from '../host';
import { decodeFileText } from '../model/importText';
import type { VersionView } from '../protocol';
import { describeError, scoped } from '../runtime/logger';
import { WsError } from '../workspace/guard';
import { checkpointVersionsOf, readCheckpoint, readCheckpointBytes } from '../workspace/checkpoints';
import { historyUnavailable, listSnapshots, readSnapshot, snapshotNow } from '../workspace/history';

/** 存檔點那幾行的 id 字首（後面是存檔點的 id）。快照的 id 是檔名，不會以它開頭。 */
export const CHECKPOINT_VERSION_PREFIX = 'cp:';

const log = scoped('歷史版本');

/**
 * 衝突條「對比合併…」：左邊磁碟上此刻的那一份、右邊編輯器裡的這一份（`text`），逐段挑。採納之後回
 * `editorReplace`，帶上磁碟那份當新的樂觀鎖基線——作者看過了磁碟上的改動，之後照常 Ctrl+S，不必強制儲存。
 * 放棄或關掉合併檢視：什麼都不回，編輯區與衝突條原樣。
 */
export async function mergeWithDisk(c: ChatController, rel: string, text: string, requestId: string): Promise<void> {
  const host = getHost();
  if (!host.mergeTexts) {
    c.toast('這裡沒有對比合併檢視：請用「用磁碟版本覆蓋編輯器」或「用編輯器內容強制儲存」。', 'error');
    return;
  }
  let disk: { text: string; hash: string };
  try {
    disk = await c.workspace.read(rel);
  } catch (err) {
    if (err instanceof WsError && err.code === 'notFound') {
      c.toast(`磁碟上已經沒有「${rel}」了，沒有可對比的：直接儲存會按編輯器裡的內容重新建出來。`, 'error');
      return;
    }
    throw err;
  }
  const verdict = await host.mergeTexts(`對比合併「${path.posix.basename(rel)}」：磁碟上的 ↔ 編輯器裡的`, disk.text, text, {
    sides: { before: '磁碟上的', after: '編輯器裡的' },
    applyLabel: '放回編輯器',
    message: `${rel}　·　放回之後仍是未儲存，照常 Ctrl+S 儲存即可（不必強制儲存）`,
  });
  const merged = typeof verdict === 'object' ? verdict.merged : verdict === 'apply' ? text : undefined;
  if (merged === undefined) {
    log.info(`放棄對比合併 ${rel}`);
    return;
  }
  log.info(`對比合併 ${rel}：放回編輯器`, `${merged.length} 字元，基線換成磁碟上的 ${disk.hash}`);
  // 磁碟上那一份（別處改過的）先存一版：放回去的合併結果一存檔就蓋掉它，而節流按「改動小」可能不存。
  await snapshotNow(c.project, rel);
  c.post({ type: 'editorReplace', requestId, path: rel, text: merged, base: { text: disk.text, hash: disk.hash } });
}

/**
 * 列出這份檔案的歷史版本：快照與它在各存檔點裡的樣子混排，新的在前。不存歷史版本的檔案照實說為什麼。
 * 存檔點讀不動（目錄壞了之類）只是少了那幾行，快照照樣列。
 */
export async function listVersions(c: ChatController, rel: string): Promise<void> {
  const unavailable = await historyUnavailable(c.project, rel);
  if (unavailable) {
    c.post({ type: 'versions', path: rel, entries: [], unavailable });
    return;
  }
  const entries: VersionView[] = await listSnapshots(c.project, rel);
  try {
    for (const v of await checkpointVersionsOf(c.project, rel)) {
      entries.push({
        id: `${CHECKPOINT_VERSION_PREFIX}${v.id}`,
        time: v.time,
        words: v.words,
        bytes: v.bytes,
        checkpoint: { note: v.note, auto: v.auto },
      });
    }
  } catch (err) {
    log.warn(`列 ${rel} 在存檔點裡的樣子失敗`, describeError(err));
  }
  entries.sort((a, b) => b.time - a.time);
  c.post({ type: 'versions', path: rel, entries });
}

/** 讀某一版的全文（快照，或存檔點裡的那一份），回給發起的那個頁面。 */
export async function readVersion(c: ChatController, rel: string, id: string, requestId: string): Promise<void> {
  try {
    const text = id.startsWith(CHECKPOINT_VERSION_PREFIX)
      ? decodeFileText(await readCheckpointBytes(c.project, await readCheckpoint(c.project, id.slice(CHECKPOINT_VERSION_PREFIX.length)), rel))
      : await readSnapshot(c.project, rel, id);
    c.post({ type: 'versionText', requestId, path: rel, id, text });
  } catch (err) {
    c.post({ type: 'versionText', requestId, path: rel, id, error: describeError(err) });
  }
}

/**
 * 「現在存一版」：把**磁碟上當前**這份存一個快照（跳過節流）。編輯器裡沒儲存的修改不在裡面——那一份要
 * 先儲存，儲存本身就會把被覆蓋的舊內容存一版。之後重推 `versions`。
 *
 * `quiet`：前端把一版（或一處）放回編輯區之前順手發的：放回去的內容一存檔（開著自動儲存時停筆兩秒就存）就蓋掉
 * 磁碟上這一份，而節流按「改動小」可能不存它。什麼提示都不彈——作者點的是「恢復」，不是「存一版」；存不下的原因已經記了 warn。
 */
export async function saveVersion(c: ChatController, rel: string, quiet = false): Promise<void> {
  const unavailable = await historyUnavailable(c.project, rel);
  if (unavailable) {
    if (!quiet) {
      c.toast(unavailable, 'error');
    }
    return;
  }
  const r = await snapshotNow(c.project, rel);
  if (quiet) {
    // 不說話；列表照樣重推（多了一版的話面板上跟著出現）。
  } else if (r.saved) {
    c.toast('已把磁碟上現在這一份存成一版（編輯器裡沒儲存的修改不在裡面）。');
  } else if (r.skipped === 'same') {
    c.toast('磁碟上這一份與最近一版一字不差，沒有重複存。');
  } else if (r.skipped === 'missing') {
    c.toast('磁碟上還沒有這份檔案（還沒儲存過），沒有可存的。', 'error');
  } else if (r.skipped === 'tooLarge') {
    c.toast('這份檔案超過 2 MB，不存歷史版本。', 'error');
  } else {
    c.toast(`沒能存下這一版：${r.error ?? '原因不明'}`, 'error');
  }
  await listVersions(c, rel);
}
