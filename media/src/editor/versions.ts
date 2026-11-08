/**
 * 側欄「版本」頁（獨立版；DOM 在 `shells/shared/panes.ts` 的 `versionsPane`，外掛形態不裝配）：上面「全書改動」，下面編輯區
 * 當前那份檔案的時間線。點一行，編輯區裡馬上開對比標籤（`versionDiff.ts`），不經預覽、不彈窗。兩塊的標題點了收起 / 展開。
 *
 * - **全書改動**（像 VS Code 原始碼管理的「更改」）：跟一個存檔點比，之後全書改過、新建、刪掉的檔案，按種類分組
 *   （`artifactKinds.ts`）。預設跟最近一個**手動**存檔點比（自動的批次動作之前都存，太密，比出來常常只剩幾份），沒有手動的
 *   就跟最近那一個；下拉換別的，換過就一直是它（它被裁掉了才回到預設）。資料與存檔點彈窗同一對訊息：`listCheckpoints` →
 *   `checkpoints`、`checkpointDiff` → `checkpointDiff`（只認自己那個存檔點的；彈窗要的、退回之後後端重推的，是這個就照收）。
 *   這一頁顯示著時，後端每推一次 `state`（存檔、批次動作之後都推）停一下再比一次；後端按檔案的大小與修改時間記著算過的指紋，
 *   每次比不必整本重讀。點一份：存檔點裡那一份 ↔ 現在（沒開著的先開成臨時標籤）；之後新建的左邊是空的、刪掉的右邊是空的。
 *   **退回不在這裡**——那是直接寫盤的，留在存檔點彈窗裡；這裡只看、只在編輯區裡用回。
 *
 * 當前檔案的時間線：
 *
 * - **一條時間線，新的在前**：最上面「還沒儲存的改動」（編輯器裡那份與磁碟上的不一樣時才有，比的是磁碟上的 ↔ 編輯器裡的）；
 *   然後是快照（閘道器在每次覆蓋之前存的，`core/workspace/history.ts`）與這份檔案在各存檔點裡的樣子（◆ 手動、◇ 自動，帶備註；
 *   內容一樣的連著幾個只列最早那一個）混排。每行「3 分鐘前 · 14:32」、多少字、比現在多 / 少幾個字。
 * - **單擊 = 這一版 ↔ 現在**（現在 = 編輯器裡那一份，沒儲存的也算）。右鍵：跟現在比、跟後一版比（那一次改了什麼）、
 *   恢復整份到編輯區。對比標籤開著時，它比的那一行標成選中。
 * - **跟著編輯區當前的檔案走**：換了檔案就換列表；對比標籤、別的特殊標籤顯示著時（那一塊沒有當前檔案）留在原來那份上；
 *   那份檔案關掉了才清空。儲存之後（`hash` 變了）重拉——閘道器可能剛存了一版（自動儲存幾秒一次時攢一攢，一秒最多一次）。
 *   這一頁藏著時不拉，切過來時拉一次（存檔點可能剛存過）。
 * - **入口**：活動欄「版本」；編輯區工具欄「歷史」（每塊編輯區一顆，第一次重畫時插到「儲存」前面，與 `layout.ts` 的「排版」
 *   同一個做法）與標題欄「檔案 → 歷史版本…」（`view/versionsMenu.ts`，經 `nf-versions-query` / `nf-versions-command`）切到
 *   這一頁，窄屏上順手把編輯區翻下去。沒開檔案、沒開啟工程、還不是小說工程、檔案不是工程裡的創作產物（`kind` 是 `other`）時
 *   那兩處置灰，提示裡說為什麼——前端不拿路徑猜，後端也會再判一次（`versions.unavailable`）。
 * - 「＋」（現在存一版）把**磁碟上當前**那一份存一個快照（不是編輯器裡沒儲存的那份）。
 * - 存檔點彈窗裡的「對比」也開在這裡的對比標籤上（經 `nf-version-diff-query` / `nf-version-diff-command`）。
 */
import { maybeById, el, setHidden } from '../dom';
import { onContextMenu, showVersionsTab } from '../globals';
import type { CheckpointFileDiffCommand, MenuItem } from '../globals';
import type { CheckpointDiffEntry, CheckpointDiffView, CheckpointView, InMessage, OutMessage, VersionView } from '../protocol';
import { onMessage } from '../vscodeApi';
import { activeEditor, onEditorChange } from './api';
import type { OpenFile, Pane } from './api';
import { autoSaveEnabled, onPrefsChange } from './paragraphState';
import { revealEditor, revealSide } from './shell';
import { paneOwning } from './store';
import { KIND_LABEL, KIND_ORDER } from './artifactKinds';
import { currentDiff, installVersionDiff, onDiffChange, openDiff, openFileDiff, restoreVersion } from './versionDiff';
import type { DiffRequest, VersionRef } from './versionDiff';
import { countWords } from './words';

type VersionsMessage = Extract<OutMessage, { type: 'versions' }>;

interface Side {
  root: HTMLElement;
  body: HTMLElement;
  foot: HTMLElement;
  save: HTMLButtonElement;
  refresh: HTMLButtonElement;
}

let post: (msg: InMessage) => void = () => {};
let side: Side | undefined;
/** 列著哪份檔案、拉列表時它的 hash（儲存之後 hash 變了就重拉）。 */
let target: string | null = null;
let targetHash: string | null = null;
/** undefined = 載入中。 */
let entries: VersionView[] | undefined;
let unavailable: string | undefined;
const buttons = new Map<Pane, HTMLButtonElement>();
/** 後端說過「還不是小說工程」（`ViewState.initialized === false`）。沒收到之前不攔，後端會再判一次。 */
let notProject = false;
let renderTimer: ReturnType<typeof setTimeout> | undefined;
/** 當前檔案那一塊收起來了。 */
let fileCollapsed = false;

/** 全書改動：跟哪個存檔點比、比出來什麼。 */
const book: {
  /** undefined = 還沒拉過。 */
  checkpoints?: CheckpointView[];
  unavailable?: string;
  /** 跟哪個比。 */
  base: string | null;
  /** 作者在下拉里挑過：一直是它，它沒了才回到預設。 */
  picked: boolean;
  /** 比的是 `base`；undefined = 比著呢。 */
  diff?: CheckpointDiffView;
  error?: string;
  collapsed: boolean;
} = { base: null, picked: false, collapsed: false };
/** 後端推了 `state` 之後停多久再比（連著存幾次只比一次）。 */
const BOOK_REFRESH_MS = 800;
let bookTimer: ReturnType<typeof setTimeout> | undefined;

// ---------------------------------------------------------------- 純函式

const pad = (n: number) => String(n).padStart(2, '0');

/** 「3 分鐘前 · 14:32」「昨天 · 10-17 21:05」「400 天前 · 2025-03-02 08:00」那種說法。 */
export function describeWhen(time: number, now = Date.now()): string {
  const d = new Date(time);
  const n = new Date(now);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(n) - startOf(d)) / 86_400_000);
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  let rel: string;
  if (days <= 0) {
    rel = minutes < 1 ? '剛剛' : minutes < 60 ? `${minutes} 分鐘前` : `${Math.floor(minutes / 60)} 小時前`;
  } else {
    rel = days === 1 ? '昨天' : `${days} 天前`;
  }
  const abs = days <= 0 ? hm : d.getFullYear() === n.getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}-${md} ${hm}`;
  return `${rel} · ${abs}`;
}

/** 「比現在多 120 字」「比現在少 3 字」「與現在字數相同」。 */
export function describeDelta(words: number, current: number): string {
  const delta = words - current;
  return delta === 0 ? '與現在字數相同' : delta > 0 ? `比現在多 ${delta} 字` : `比現在少 ${-delta} 字`;
}

/** 這份檔案存不存歷史版本；不存給原因。與後端 `historyUnavailable` 同一套說法（後端照樣再判一次）。 */
export function unavailableReason(file: Pick<OpenFile, 'kind'> | undefined): string | undefined {
  if (!file) {
    return '沒有開啟的檔案。';
  }
  if (file.kind === undefined) {
    return '沒開啟工程，不存歷史版本。';
  }
  if (notProject) {
    return '這個目錄還不是小說工程（沒有工程後設資料目錄），不存歷史版本。';
  }
  if (file.kind === 'other') {
    return '這份檔案不是工程裡的創作產物（章節、草稿、細綱、角色卡、設定、架構、大綱、文風、敘事線……），不存歷史版本。';
  }
  return undefined;
}

/** 一行在標題、對比標籤上怎麼稱呼：「3 分鐘前 · 14:32 的快照」「存檔點「第一卷完」（10-20 22:30）」。 */
export function versionLabel(entry: VersionView, now = Date.now()): string {
  const when = describeWhen(entry.time, now);
  if (!entry.checkpoint) {
    return `${when} 的快照`;
  }
  const kind = entry.checkpoint.auto ? '自動存檔點' : '存檔點';
  return entry.checkpoint.note ? `${kind}「${entry.checkpoint.note}」（${when}）` : `${kind}（${when}）`;
}

/** 一個存檔點在對比標籤上怎麼稱呼（同時間線上存檔點那幾行）。 */
export function checkpointLabel(cp: Pick<CheckpointView, 'time' | 'note' | 'auto'>, now = Date.now()): string {
  return versionLabel({ id: '', time: cp.time, words: 0, bytes: 0, checkpoint: { note: cp.note, auto: cp.auto } }, now);
}

/** 全書改動跟哪個存檔點比的預設：最近一個手動的，沒有就最近那一個（`list` 新的在前）。 */
export function defaultBase(list: readonly Pick<CheckpointView, 'id' | 'auto'>[]): string | null {
  return (list.find((cp) => !cp.auto) ?? list[0])?.id ?? null;
}

/** 檔名去掉副檔名（全書改動裡那些多半沒開著，沒有後端給的稱呼）。 */
function baseName(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

// ---------------------------------------------------------------- 側欄

/** 標籤上的那個稱呼（後端給的，章節去掉了副檔名）；沒給就是檔名。 */
function nameOf(file: OpenFile): string {
  return file.label?.title ?? file.name;
}

const NOTE =
  '每次覆蓋儲存之前，磁碟上的舊內容先存成一版（10 分鐘內的零星小改併成一版，每份檔案留最近 50 版）；◆ ◇ 是存檔點裡的這一份。' +
  '點一行在編輯區對比；用回、恢復都只換編輯區裡的內容，存不存由你。';
/** 自動儲存開著時多說的那一句（`autosave.ts`：停筆 2 秒就存）。 */
const AUTOSAVE_NOTE = '自動儲存開著：放回編輯區的內容停筆 2 秒就會寫回磁碟——被它蓋掉的那一版會先存進這裡，可以再恢復回來。';

function visible(): boolean {
  return !!side && side.root.classList.contains('active');
}

/** 正看著的那份檔案（在哪塊編輯區裡都行）。 */
function targetFile(): OpenFile | undefined {
  return target ? paneOwning(target)?.files.get(target) : undefined;
}

/** 按當前檔案重拉列表（藏著就只記一筆）。 */
function load(): void {
  const file = targetFile();
  targetHash = file?.hash ?? null;
  unavailable = unavailableReason(file);
  // 藏著不拉：切過來時（MutationObserver）再拉。
  if (!visible()) {
    return;
  }
  entries = undefined;
  if (file && !unavailable) {
    post({ type: 'listVersions', path: file.path });
  }
  render();
}

/** 換看哪份檔案：編輯區當前的那一份（沒有當前檔案時留在原來那份上，那份關掉了才清空）。 */
function follow(): void {
  const file = activeEditor()?.file;
  const next = file ? file.path : target && paneOwning(target) ? target : null;
  if (next !== target) {
    target = next;
    entries = undefined;
    load();
  } else if (file && file.hash !== targetHash && !unavailable) {
    // 儲存過（或換了基線）：閘道器可能剛存了一版，重拉。
    targetHash = file.hash;
    relist();
  } else if (visible()) {
    render();
  }
}

function render(): void {
  if (!side) {
    return;
  }
  const file = targetFile();
  side.foot.textContent = autoSaveEnabled() ? `${NOTE}${AUTOSAVE_NOTE}` : NOTE;
  setHidden(side.foot, !file || !!unavailable);
  side.save.disabled = !file || !!unavailable;
  side.body.replaceChildren(bookSection(), fileSection(file));
}

/** 一塊的標題：點了收起 / 展開。 */
function sectionHead(title: string, count: string, collapsed: boolean, toggle: () => void, tip = ''): HTMLElement {
  const head = el('button', 'vs-section-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', String(!collapsed));
  head.appendChild(el('span', 'vs-caret', collapsed ? '▸' : '▾'));
  head.appendChild(el('span', 'vs-section-title', title));
  if (count) {
    head.appendChild(el('span', 'vs-count', count));
  }
  head.title = tip || title;
  head.addEventListener('click', () => {
    toggle();
    render();
  });
  return head;
}

// ---------------------------------------------------------------- 全書改動

function bookSection(): HTMLElement {
  const box = el('section', 'vs-section vs-book');
  const count = book.diff ? String(book.diff.entries.length) : '';
  box.appendChild(
    sectionHead('全書改動', count, book.collapsed, () => (book.collapsed = !book.collapsed), '跟一個存檔點比，之後全書改過、新建、刪掉的檔案')
  );
  if (book.collapsed) {
    return box;
  }
  if (book.unavailable) {
    box.appendChild(el('p', 'vs-empty', book.unavailable));
    return box;
  }
  if (!book.checkpoints) {
    box.appendChild(el('p', 'vs-empty', '載入中…'));
    return box;
  }
  if (book.checkpoints.length === 0) {
    box.appendChild(el('p', 'vs-empty', '還沒有存檔點。存一個之後，這裡列出它之後全書改過的檔案。'));
    const save = el('button', 'chip-btn vs-book-save', '現在存一個存檔點');
    save.type = 'button';
    save.addEventListener('click', () => post({ type: 'createCheckpoint', note: '' }));
    box.appendChild(save);
    return box;
  }
  box.appendChild(baseRow(book.checkpoints));
  if (book.error) {
    box.appendChild(el('p', 'vs-empty error', book.error));
    return box;
  }
  if (!book.diff) {
    box.appendChild(el('p', 'vs-empty', '比著呢…'));
    return box;
  }
  if (book.diff.entries.length === 0) {
    box.appendChild(el('p', 'vs-empty', '跟這個存檔點比，全書一字沒動。'));
    return box;
  }
  const cp = book.checkpoints.find((c) => c.id === book.base);
  const shown = currentDiff();
  for (const kind of KIND_ORDER) {
    const group = book.diff.entries.filter((e) => e.kind === kind);
    if (group.length === 0) {
      continue;
    }
    box.appendChild(el('div', 'vs-group', `${KIND_LABEL[kind]} ${group.length}`));
    for (const entry of group) {
      box.appendChild(bookRow(entry, cp, shown));
    }
  }
  return box;
}

/** 「跟 [下拉] 比」：新的在前，◆ 手動、◇ 自動。 */
function baseRow(list: CheckpointView[]): HTMLElement {
  const row = el('label', 'vs-base');
  row.appendChild(el('span', undefined, '跟'));
  const select = el('select', 'vs-base-select');
  const now = Date.now();
  for (const cp of list) {
    const text = `${cp.auto ? '◇' : '◆'} ${cp.note || (cp.auto ? '自動存檔點' : '存檔點')} · ${describeWhen(cp.time, now)}`;
    const option = el('option', undefined, text);
    option.value = cp.id;
    option.selected = cp.id === book.base;
    select.appendChild(option);
  }
  select.addEventListener('change', () => {
    book.base = select.value;
    book.picked = true;
    book.diff = undefined;
    book.error = undefined;
    post({ type: 'checkpointDiff', id: select.value });
    render();
  });
  row.append(select, el('span', undefined, '比'));
  return row;
}

const STATUS_MARK: Record<CheckpointDiffEntry['status'], string> = { changed: '改', added: '新', deleted: '刪' };

function bookRow(entry: CheckpointDiffEntry, cp: CheckpointView | undefined, shown: DiffRequest | undefined): HTMLElement {
  const item = el('button', `vs-row vs-change vs-${entry.status}`);
  item.type = 'button';
  item.dataset.path = entry.path;
  const left = cp && entry.status !== 'added' ? { id: `cp:${cp.id}`, label: checkpointLabel(cp) } : ('empty' as const);
  const right = entry.status === 'deleted' ? ('empty' as const) : ('now' as const);
  const selected =
    shown?.path === entry.path && (typeof shown.left === 'string' ? shown.left === left : typeof left !== 'string' && shown.left.id === left.id);
  item.classList.toggle('selected', !!selected);
  const line = el('span', 'vs-when');
  line.append(el('span', 'vs-status', STATUS_MARK[entry.status]), document.createTextNode(baseName(entry.path)));
  item.appendChild(line);
  item.appendChild(el('span', 'vs-meta', bookMeta(entry)));
  item.title = entry.path;
  item.addEventListener('click', () => {
    openFileDiff({ path: entry.path, name: baseName(entry.path), left, right });
    revealEditor();
  });
  return item;
}

function bookMeta(entry: CheckpointDiffEntry): string {
  if (entry.status === 'added') {
    return `之後新建的 · ${entry.wordsNow ?? 0} 字`;
  }
  if (entry.status === 'deleted') {
    return `之後刪掉了 · 原來 ${entry.wordsThen ?? 0} 字`;
  }
  const delta = (entry.wordsNow ?? 0) - (entry.wordsThen ?? 0);
  return delta === 0 ? '字數沒變' : delta > 0 ? `多了 ${delta} 字` : `少了 ${-delta} 字`;
}

/** 拉存檔點列表（列表到了再比）。藏著不拉。 */
function refreshBook(): void {
  clearTimeout(bookTimer);
  if (visible()) {
    post({ type: 'listCheckpoints' });
  }
}

function onCheckpoints(msg: Extract<OutMessage, { type: 'checkpoints' }>): void {
  book.checkpoints = msg.entries;
  book.unavailable = msg.unavailable;
  const keep = book.picked && msg.entries.some((cp) => cp.id === book.base);
  const base = keep ? book.base : defaultBase(msg.entries);
  if (!keep) {
    book.picked = false;
  }
  if (base !== book.base) {
    book.base = base;
    book.diff = undefined;
    book.error = undefined;
  }
  if (base && visible()) {
    post({ type: 'checkpointDiff', id: base });
  }
  if (!base) {
    book.diff = undefined;
  }
  render();
}

function onCheckpointDiff(msg: Extract<OutMessage, { type: 'checkpointDiff' }>): void {
  if (msg.id !== book.base) {
    return;
  }
  book.diff = msg.diff;
  book.error = msg.diff ? undefined : (msg.error ?? '沒比出來。');
  render();
}

/** 存檔點彈窗裡「對比」一份：開在對比標籤上。 */
function openCheckpointFile(cmd: CheckpointFileDiffCommand): void {
  const label = checkpointLabel(cmd.checkpoint);
  openFileDiff({
    path: cmd.path,
    name: baseName(cmd.path),
    left: cmd.status === 'added' ? 'empty' : { id: `cp:${cmd.checkpoint.id}`, label },
    right: cmd.status === 'deleted' ? 'empty' : 'now',
  });
  revealEditor();
}

// ---------------------------------------------------------------- 當前檔案

function fileSection(file: OpenFile | undefined): HTMLElement {
  const box = el('section', 'vs-section vs-timeline');
  const head = sectionHead(file ? nameOf(file) : '當前檔案', '', fileCollapsed, () => (fileCollapsed = !fileCollapsed), file?.path);
  head.classList.add('vs-file');
  box.appendChild(head);
  if (fileCollapsed) {
    return box;
  }
  if (!file) {
    box.appendChild(el('p', 'vs-empty', '沒有開啟的檔案。在編輯區開啟一份稿子，這裡列出它存下的各版。'));
    return box;
  }
  if (unavailable) {
    box.appendChild(el('p', 'vs-empty', unavailable));
    return box;
  }
  const shown = currentDiff();
  if (file.draft !== file.text) {
    box.appendChild(unsavedRow(file, shown));
  }
  if (!entries) {
    box.appendChild(el('p', 'vs-empty', '載入中…'));
    return box;
  }
  if (entries.length === 0) {
    box.appendChild(
      el(
        'p',
        'vs-empty',
        '還沒有存下的版本。第一次覆蓋儲存這份檔案時（編輯器裡儲存、重寫、修稿、同步……），磁碟上的舊內容會先存成一版；' +
          '也可以點上面的「＋」把磁碟上現在這一份先存下來。存檔點裡有它的話，也列在這裡。'
      )
    );
    return box;
  }
  const current = countWords(file.draft);
  const now = Date.now();
  entries.forEach((entry, i) => box.appendChild(row(file, entry, i, current, now, shown)));
  return box;
}

function unsavedRow(file: OpenFile, shown: DiffRequest | undefined): HTMLElement {
  const item = el('button', 'vs-row vs-unsaved');
  item.type = 'button';
  item.classList.toggle('selected', shown?.path === file.path && shown.left === 'disk');
  item.appendChild(el('span', 'vs-when', '● 還沒儲存的改動'));
  item.appendChild(el('span', 'vs-meta', describeDelta(countWords(file.draft), countWords(file.text)).replace('現在', '磁碟上')));
  item.title = '磁碟上的（上次儲存的）↔ 編輯器裡的';
  item.addEventListener('click', () => {
    openDiff({ path: file.path, name: nameOf(file), left: 'disk', right: 'now' });
    revealEditor();
  });
  return item;
}

function row(file: OpenFile, entry: VersionView, index: number, current: number, now: number, shown: DiffRequest | undefined): HTMLElement {
  const item = el('button', entry.checkpoint ? 'vs-row vs-checkpoint' : 'vs-row');
  item.type = 'button';
  item.dataset.id = entry.id;
  const selected = shown?.path === file.path && typeof shown.left !== 'string' && shown.left.id === entry.id;
  item.classList.toggle('selected', selected);
  const when = el('span', 'vs-when', describeWhen(entry.time, now));
  if (entry.checkpoint) {
    when.prepend(el('span', 'vs-mark', entry.checkpoint.auto ? '◇ ' : '◆ '));
  }
  item.appendChild(when);
  item.appendChild(el('span', 'vs-meta', `${entry.words} 字 · ${describeDelta(entry.words, current)}`));
  if (entry.checkpoint) {
    item.appendChild(el('span', 'vs-note', entry.checkpoint.note || (entry.checkpoint.auto ? '自動存檔點' : '存檔點')));
  }
  item.title = entry.checkpoint
    ? `${versionLabel(entry, now)}裡的這一份`
    : `這一版在 ${new Date(entry.time).toLocaleString()} 被覆蓋掉之前在磁碟上`;
  const ref = (): VersionRef => ({ id: entry.id, label: versionLabel(entry, Date.now()) });
  item.addEventListener('click', () => {
    openDiff({ path: file.path, name: nameOf(file), left: ref(), right: 'now' });
    revealEditor();
  });
  onContextMenu(item, () => rowMenu(file, index, ref));
  return item;
}

function rowMenu(file: OpenFile, index: number, ref: () => VersionRef): MenuItem[] {
  const newer = index > 0 ? entries?.[index - 1] : undefined;
  return [
    {
      label: '跟現在比',
      run: () => {
        openDiff({ path: file.path, name: nameOf(file), left: ref(), right: 'now' });
        revealEditor();
      },
    },
    {
      // 最新的那一版，後面一版就是現在。
      label: '跟後一版比（那一次改了什麼）',
      run: () => {
        const right = newer ? { id: newer.id, label: versionLabel(newer) } : ('now' as const);
        openDiff({ path: file.path, name: nameOf(file), left: ref(), right });
        revealEditor();
      },
    },
    { sep: true },
    { label: '恢復整份到編輯區', run: () => void restoreVersion(file.path, ref()) },
  ];
}

/** 儲存之後重拉列表：離上一次不到一秒就挪到一秒之後（只發最後那一次）。 */
const RELIST_GAP_MS = 1000;
let relistLast = 0;
let relistTimer: ReturnType<typeof setTimeout> | undefined;

function relist(): void {
  clearTimeout(relistTimer);
  if (!visible()) {
    return;
  }
  const send = () => {
    relistTimer = undefined;
    relistLast = Date.now();
    if (target && !unavailable && visible()) {
      post({ type: 'listVersions', path: target });
    }
  };
  const wait = relistLast + RELIST_GAP_MS - Date.now();
  if (wait <= 0) {
    send();
  } else {
    relistTimer = setTimeout(send, wait);
  }
}

function onVersions(msg: VersionsMessage): void {
  if (msg.path !== target) {
    return;
  }
  entries = msg.entries;
  unavailable = msg.unavailable;
  render();
}

// ---------------------------------------------------------------- 工具欄「歷史」

/** 切到「版本」頁看這一塊的那份檔案（窄屏上順手把編輯區翻下去）。 */
function showFor(pane: Pane | undefined): void {
  const file = pane?.activeFile();
  if (file && file.path !== target) {
    target = file.path;
    entries = undefined;
  }
  showVersionsTab();
  revealSide();
  load();
}

/** 每塊編輯區一顆，第一次重畫時插到「儲存」前面。 */
function syncButton(pane: Pane): void {
  let btn = buttons.get(pane);
  if (!btn) {
    const toolbar = pane.root.querySelector<HTMLElement>('.ed-toolbar');
    if (!toolbar) {
      return;
    }
    btn = el('button', 'chip-btn ed-versions-btn', '歷史');
    btn.type = 'button';
    btn.addEventListener('click', () => showFor(pane));
    toolbar.insertBefore(btn, toolbar.querySelector('button.primary'));
    buttons.set(pane, btn);
  }
  const reason = unavailableReason(pane.activeFile());
  btn.disabled = !!reason;
  btn.title = reason ?? '歷史版本：在側欄「版本」頁列出這份檔案存下的各版，點一行在編輯區對比';
}

// ---------------------------------------------------------------- 裝

export function installVersions(postMessage: (msg: InMessage) => void): void {
  post = postMessage;
  installVersionDiff(postMessage);

  const root = maybeById('pane-versions');
  if (root) {
    side = {
      root,
      body: maybeById('versionsBody')!,
      foot: maybeById('versionsFoot')!,
      save: maybeById('versionsSave') as HTMLButtonElement,
      refresh: maybeById('versionsRefresh') as HTMLButtonElement,
    };
    side.save.addEventListener('click', () => {
      if (target) {
        post({ type: 'saveVersion', path: target });
      }
    });
    side.refresh.addEventListener('click', () => {
      load();
      refreshBook();
    });
    // 切到這一頁（活動欄、工具欄「歷史」）：拉一次——藏著時換過檔案、儲存過，存檔點也可能剛存過。
    new MutationObserver(() => {
      if (visible()) {
        load();
        refreshBook();
      }
    }).observe(root, { attributes: true, attributeFilter: ['class'] });
    render();
  }

  onEditorChange((ev) => {
    if (ev.type === 'render') {
      syncButton(ev.pane);
      follow();
      return;
    }
    // 打字：「還沒儲存的改動」那一行有沒有、「比現在多 / 少幾個字」跟著變，攢一下再畫。
    if (ev.file.path === target && visible()) {
      clearTimeout(renderTimer);
      renderTimer = setTimeout(render, 300);
    }
  });
  onDiffChange(() => {
    if (visible()) {
      render();
    }
  });

  onMessage((msg) => {
    if (msg.type === 'versions') {
      onVersions(msg);
    } else if (msg.type === 'checkpoints') {
      onCheckpoints(msg);
    } else if (msg.type === 'checkpointDiff') {
      onCheckpointDiff(msg);
    } else if (msg.type === 'init' || msg.type === 'state') {
      // 磁碟上可能變過（存檔、批次動作、退回）：顯示著就停一下再比一次全書。
      if (visible()) {
        clearTimeout(bookTimer);
        bookTimer = setTimeout(refreshBook, BOOK_REFRESH_MS);
      }
      const was = notProject;
      notProject = msg.state.initialized === false;
      if (was !== notProject) {
        for (const pane of [...buttons.keys()]) {
          syncButton(pane);
        }
        load();
      }
    }
  });

  // 「檔案 → 自動儲存」切了：底下那句說明跟著變。
  onPrefsChange(() => {
    if (visible()) {
      render();
    }
  });

  window.addEventListener('nf-versions-query', (e) => {
    const reason = unavailableReason(activeEditor()?.file);
    e.detail.available = !reason;
    e.detail.reason = reason;
  });

  window.addEventListener('nf-versions-command', (e) => {
    const ed = activeEditor();
    if (e.detail.name === 'open' && ed && !unavailableReason(ed.file)) {
      showFor(ed.pane);
    }
  });

  // 存檔點彈窗裡的「對比」：只有這裡畫得了對比標籤（外掛形態沒有 editor.js，沒人回答，按鈕就不給）。
  window.addEventListener('nf-version-diff-query', (e) => {
    e.detail.available = true;
  });
  window.addEventListener('nf-version-diff-command', (e) => openCheckpointFile(e.detail));

  window.addEventListener('nf-workspace-reset', () => {
    target = null;
    targetHash = null;
    entries = undefined;
    unavailable = undefined;
    clearTimeout(bookTimer);
    Object.assign(book, { checkpoints: undefined, unavailable: undefined, base: null, picked: false, diff: undefined, error: undefined });
    render();
  });
}
