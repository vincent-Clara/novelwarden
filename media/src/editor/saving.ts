/**
 * 儲存這件事本身：一份檔案同一時刻只有一個儲存在路上、回執回來之前狀態列說什麼、存完要不要再存一次、
 * 磁碟上沒了的檔案怎麼問、自動儲存什麼時候不該動手。`pane.ts` 的「儲存」、關標籤時的「儲存」、
 * 自動儲存都經 {@link requestSave}。
 *
 * - **同一份同一時刻只有一個儲存在路上**。回執（`editorSaved` / `editorConflict` / `editorDiskGone` /
 *   `editorError`）回來之前又要存（又按了 Ctrl+S、自動儲存又到點了），只記一筆；回執是「存成了」而那一份
 *   還有沒存上的修改，再存一次。撞上衝突、出錯就不再接著存。
 * - **狀態列那一格**（{@link renderSaveState}）：「● 未儲存」→ 發出去「儲存中…」→ 回執到了「已儲存 14:32」
 *   （本次會話裡最後一次存成的時刻；這次會話還沒存過就只寫「已儲存」）；發出去 {@link SLOW_SAVE_MS} 還沒回音，
 *   說一句（斷線時訊息在 bridge 的 outbox 裡排著，連上才發）。**存成了不彈 toast**；衝突、出錯照樣彈（pane 彈）。
 *   自動儲存開著時旁邊掛一枚「自動儲存」。
 * - **磁碟上沒了的檔案**（`OpenFile.gone`）：手動儲存先問一句要不要在原路徑重建（{@link askDialog}），
 *   答應了才帶 `recreate`；絕不靜默在原路徑重建。自動儲存跳過它。
 * - **自動儲存的閘**（{@link autoSaveAllowed}）：撞過沖突（或核對磁碟時發現磁碟變了、而編輯器裡有修改）的那一份
 *   記下當時的基線，基線沒動之前（作者還沒在衝突條上選）不碰它；「還原」正等著磁碟版回來的那一份不碰；
 *   有對話方塊開著不碰。
 *
 * **回執誰來結**：pane 收到回執時調 {@link settleSave}——它得先看「這條是不是我要的」（別的視窗存了同一份，
 * 那條 `editorSaved` 也會廣播過來，那是磁碟變了，不是這邊存成了，見 `pane.applySaved`）。回執落到一份已經不開著
 * 的檔案上、沒有 pane 接的，這裡兜底結掉，免得它從此永遠「儲存中」、後面的儲存全排在它後頭。
 */
import { el } from '../dom';
import { touchDevice } from '../touch';
import { onMessage } from '../vscodeApi';
import { askDialog, isDialogOpen } from './dialog';
import type { OpenFile } from './paneElements';
import { autoSaveEnabled } from './paragraphState';
import { paneOwning, postToHost } from './store';
import type { Pane } from './store';

/** 發出去多久沒回音就在狀態列說一句。 */
export const SLOW_SAVE_MS = 10_000;
/** 狀態列上那句臨時的話（「磁碟上有新版本，已載入」）留多久。 */
export const NOTE_MS = 4_000;

export type SaveOutcome = 'saved' | 'conflict' | 'gone' | 'error' | 'skipped';

export interface SaveRequest {
  /** 「用編輯器內容強制儲存」：不帶 baseHash。 */
  force?: boolean;
  /** 磁碟上沒了，作者答應在原路徑重建。 */
  recreate?: boolean;
  /** 自動儲存發起的：過 {@link autoSaveAllowed} 那道閘，撞上衝突不切標籤。 */
  auto?: boolean;
}

interface Flight {
  auto: boolean;
  slow: boolean;
  timer: ReturnType<typeof setTimeout>;
}

interface Track {
  flight?: Flight;
  /** 在路上時又要存：回執是「存成了」再存一次。 */
  again?: SaveRequest;
  savedAt?: Date;
  note?: string;
  noteTimer?: ReturnType<typeof setTimeout>;
  /** 等這一份存完（含跟在後面的那一次）的人：關標籤。 */
  waiters: ((outcome: SaveOutcome) => void)[];
}

const tracks = new Map<string, Track>();
/** 撞過沖突的那幾份 → 當時的基線 hash。基線變了（作者在衝突條上選過了）就自動失效。 */
const blocked = new Map<string, string>();
/** 「還原」等著磁碟版回來的那幾份：自動儲存別搶在前面把要丟掉的修改存下去。 */
const held = new Set<string>();
/** 正在問「要不要在原路徑重建」的那幾份：別疊第二個對話方塊。 */
const asking = new Set<string>();

function track(path: string): Track {
  let t = tracks.get(path);
  if (!t) {
    t = { waiters: [] };
    tracks.set(path, t);
  }
  return t;
}

/** 這一份有一個儲存在路上（還沒收到回執）。 */
export function isSaving(path: string): boolean {
  return !!tracks.get(path)?.flight;
}

/** 在路上的那一次是自動儲存發起的。 */
export function isAutoSaving(path: string): boolean {
  return !!tracks.get(path)?.flight?.auto;
}

/**
 * 存這一份。回一個在**這一份存完**時兌現的結果（在路上時又要存的，等跟在後面的那一次也完）：
 * `skipped` 是沒有要存的（沒改過、自動儲存的閘沒開、作者在「要不要重建」上點了取消）。
 */
export function requestSave(pane: Pane, path: string, req: SaveRequest = {}): Promise<SaveOutcome> {
  const file = pane.files.get(path);
  if (!file) {
    return Promise.resolve('skipped');
  }
  if (req.auto && !autoSaveAllowed(file)) {
    return Promise.resolve('skipped');
  }
  const dirty = file.draft !== file.text;
  if (file.gone && !req.recreate) {
    // 沒改過的不問（「全部儲存」掃到它時別彈框）；衝突條上點「強制儲存」（force）是明說要存編輯器裡這一份，照問。
    if (!dirty && !req.force) {
      return Promise.resolve('skipped');
    }
    return confirmRecreate(file).then((ok) => (ok ? requestSave(pane, path, { ...req, recreate: true }) : 'skipped'));
  }
  if (!dirty && !req.force && !req.recreate) {
    return Promise.resolve('skipped');
  }
  const t = track(path);
  const settled = new Promise<SaveOutcome>((resolve) => t.waiters.push(resolve));
  if (t.flight) {
    t.again = {
      force: !!(t.again?.force || req.force),
      recreate: !!(t.again?.recreate || req.recreate),
      auto: (t.again ? !!t.again.auto : true) && !!req.auto,
    };
  } else {
    send(file, t, req);
    pane.refresh();
  }
  return settled;
}

function send(file: OpenFile, t: Track, req: SaveRequest): void {
  const flight: Flight = {
    auto: !!req.auto,
    slow: false,
    timer: setTimeout(() => {
      flight.slow = true;
      paneOwning(file.path)?.refresh();
    }, SLOW_SAVE_MS),
  };
  t.flight = flight;
  clearNote(t);
  postToHost({
    type: 'saveFile',
    path: file.path,
    text: file.draft,
    // 重建一律帶著基線：期間原路徑又有人放了一份的話，樂觀鎖照樣攔下來。
    baseHash: req.force && !req.recreate ? undefined : file.hash,
    ...(req.recreate ? { recreate: true } : {}),
  });
}

/**
 * 這一份的儲存有了回執。pane 收到回執、認定是這邊那一次的之後調；不在路上就什麼都不做。
 * 存成了而在路上時又改過（或又點過儲存），接著再存一次——等著的人等到那一次完。
 */
export function settleSave(path: string, outcome: Exclude<SaveOutcome, 'skipped'>): void {
  const t = tracks.get(path);
  if (!t?.flight) {
    return;
  }
  clearTimeout(t.flight.timer);
  t.flight = undefined;
  const again = t.again;
  t.again = undefined;
  const pane = paneOwning(path);
  const file = pane?.files.get(path);
  if (outcome === 'saved') {
    t.savedAt = new Date();
    if (again && pane && file && (file.draft !== file.text || again.force) && !(again.auto && !autoSaveAllowed(file))) {
      send(file, t, again);
      pane.refresh();
      return;
    }
  }
  for (const resolve of t.waiters.splice(0)) {
    resolve(outcome);
  }
  pane?.refresh();
}

// ---------------------------------------------------------------- 自動儲存的閘

/** 撞上衝突（或磁碟變了而編輯器裡有修改）：基線還是 `baseHash` 的時候，自動儲存不碰這一份。 */
export function blockAutoSave(path: string, baseHash: string): void {
  blocked.set(path, baseHash);
}

/**
 * 衝突解決了（衝突條上「對比合併…」放回編輯器，`Pane.rebase`）：這一份的自動儲存放開。基線換了本來也會讓
 * {@link autoSaveAllowed} 自己失效，但磁碟那份正好又變回了撞衝突時的基線的話，hash 一樣，閘就一直關著。
 */
export function unblockAutoSave(path: string): void {
  blocked.delete(path);
}

/** 這一份的自動儲存停著（磁碟上沒了，或撞過沖突還沒選）。狀態列據此寫「自動儲存已暫停」。 */
export function autoSavePaused(file: OpenFile): boolean {
  return !!file.gone || blocked.get(file.path) === file.hash;
}

/** 「還原」發出去了：磁碟版回來之前別自動儲存它。 */
export function holdSave(path: string): void {
  held.add(path);
}

export function releaseSave(path: string): void {
  held.delete(path);
}

/** 自動儲存現在能不能動這一份：開著、有修改、沒被閘住、沒有對話方塊開著。 */
export function autoSaveAllowed(file: OpenFile): boolean {
  if (!autoSaveEnabled() || file.gone || held.has(file.path) || isDialogOpen()) {
    return false;
  }
  const base = blocked.get(file.path);
  if (base !== undefined) {
    if (base === file.hash) {
      return false;
    }
    blocked.delete(file.path);
  }
  return file.draft !== file.text;
}

// ---------------------------------------------------------------- 狀態列

/** 狀態列那一格臨時說一句（「磁碟上有新版本，已載入」），{@link NOTE_MS} 後退回儲存狀態。呼叫方自己 refresh。 */
export function noteStatus(path: string, text: string): void {
  const t = track(path);
  clearNote(t);
  t.note = text;
  t.noteTimer = setTimeout(() => {
    t.note = undefined;
    t.noteTimer = undefined;
    paneOwning(path)?.refresh();
  }, NOTE_MS);
}

function clearNote(t: Track): void {
  clearTimeout(t.noteTimer);
  t.note = undefined;
  t.noteTimer = undefined;
}

/**
 * 畫狀態列的儲存狀態那一格（`cell` 是 `.ed-save-state`），自動儲存開著時在它前面掛一枚 `.ed-autosave`。
 * 沒開檔案時傳 undefined：清空。
 */
export function renderSaveState(cell: HTMLElement, file: OpenFile | undefined): void {
  const t = file && tracks.get(file.path);
  let text = '';
  let tone: '' | 'dirty' | 'busy' | 'slow' = '';
  let title = '';
  if (file) {
    if (t?.flight?.slow) {
      text = '還沒收到迴音，連上後會自動發出';
      tone = 'slow';
      title =
        `儲存請求發出 ${SLOW_SAVE_MS / 1000} 秒還沒有回執。連線斷了的話，它在頁面裡排著隊，連上之後自動發出；` +
        '編輯器裡的內容一直都在。';
    } else if (t?.flight) {
      text = '儲存中…';
      tone = 'busy';
    } else if (t?.note) {
      text = t.note;
    } else if (file.draft !== file.text) {
      // 手機、平板上多半沒有鍵盤，不提快捷鍵（儲存在標籤條上那一顆）。
      text = touchDevice() ? '● 未儲存' : '● 未儲存（Ctrl+S）';
      tone = 'dirty';
    } else {
      text = t?.savedAt ? `已儲存 ${clock(t.savedAt)}` : '已儲存';
    }
  }
  cell.textContent = text;
  cell.title = title;
  cell.classList.toggle('dirty', tone === 'dirty');
  cell.classList.toggle('busy', tone === 'busy');
  cell.classList.toggle('slow', tone === 'slow');
  renderAutoFlag(cell, file);
}

function renderAutoFlag(cell: HTMLElement, file: OpenFile | undefined): void {
  let flag = cell.parentElement?.querySelector<HTMLElement>('.ed-autosave') ?? null;
  if (!file || !autoSaveEnabled()) {
    flag?.remove();
    return;
  }
  if (!flag) {
    flag = el('span', 'ed-autosave');
    cell.before(flag);
  }
  const paused = autoSavePaused(file);
  flag.textContent = paused ? '自動儲存已暫停' : '自動儲存';
  flag.classList.toggle('paused', paused);
  flag.title = !paused
    ? '自動儲存開著：停筆 2 秒、切換標籤、切走視窗時儲存。在「檔案」選單裡關掉。'
    : file.gone
      ? '磁碟上已經沒有這個檔案，自動儲存不會替你在原路徑重建。要儲存就按 Ctrl+S，會先問你。'
      : '這一份在磁碟上被別處改過，自動儲存先停下。在衝突條上選一個（衝突條收起了就按 Ctrl+S 再看），之後接著自動儲存。';
}

function clock(at: Date): string {
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- 磁碟上沒了

async function confirmRecreate(file: OpenFile): Promise<boolean> {
  if (asking.has(file.path)) {
    return false;
  }
  asking.add(file.path);
  try {
    const answer = await askDialog({
      title: '磁碟上已經沒有這個檔案',
      message: `「${file.name}」在磁碟上已經沒有了（被刪了，或者改了名）。要把編輯器裡的內容在原路徑重新存一份嗎？`,
      detail: `原路徑：${file.path}。如果是在別處改了名，新名字那邊已經有一份，在這裡重建會多出一份。`,
      buttons: [
        { value: 'cancel', label: '取消' },
        { value: 'recreate', label: '在原路徑重建', primary: true },
      ],
      cancel: 'cancel',
    });
    return answer === 'recreate';
  } finally {
    asking.delete(file.path);
  }
}

// ---------------------------------------------------------------- 兜底

/**
 * 啟動時裝一次。回執落到一份已經不開著的檔案上（沒有 pane 接）時在這裡結掉；`editorError` 一律在這裡結
 * （pane 不接它：index.ts 彈 toast），順帶放開「還原」的那道閘（磁碟版回不來了）。
 */
export function installSaving(): void {
  onMessage((msg) => {
    if (msg.type === 'editorError') {
      releaseSave(msg.path);
      settleSave(msg.path, 'error');
      return;
    }
    const path =
      msg.type === 'editorSaved'
        ? msg.file.path
        : msg.type === 'editorConflict' || msg.type === 'editorDiskGone'
          ? msg.path
          : undefined;
    if (path !== undefined && !paneOwning(path)) {
      settleSave(path, msg.type === 'editorSaved' ? 'saved' : msg.type === 'editorConflict' ? 'conflict' : 'gone');
    }
  });

  // 換了工程（或關掉了）：上一個工程那邊還在路上的儲存，回執永遠到不了這個視窗了。不清掉的話，新工程裡
  // 同名的那一份會一直排在它後頭、狀態列一直「儲存中」。
  window.addEventListener('nf-workspace-reset', () => {
    for (const t of tracks.values()) {
      if (t.flight) {
        clearTimeout(t.flight.timer);
      }
      clearNote(t);
      for (const resolve of t.waiters.splice(0)) {
        resolve('error');
      }
    }
    tracks.clear();
    blocked.clear();
    held.clear();
  });
}
