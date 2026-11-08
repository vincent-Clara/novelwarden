/**
 * 工程頁「存檔點…」彈窗（2026-10-20，設計見 `docs/design/plans/2026-10-20-checkpoints.md`）：整本書存一版、看某個
 * 存檔點之後改了哪幾份、單份對比、整本或單份退回。後端一半在 `core/controller/checkpoints.ts`。
 *
 * 複用 `providerModal` 那一層遮罩（同 `form.ts`：外掛與獨立版都裝配了它），裡面兩頁：
 *
 * - **列表**：開啟就發 `listCheckpoints`，收 `checkpoints` 畫（新的在前）。頂上一格備註 +「存一個存檔點」（發
 *   `createCheckpoint`）；自動存的那幾行多一顆「留住…」，攤開一格備註發 `noteCheckpoint`（寫了備註就不會被自動裁掉）。
 * - **跟現在比**：一行的「跟現在比」發 `checkpointDiff`，收同一個 id 的 `checkpointDiff` 畫三組（改過的 / 之後刪掉的 /
 *   之後新建的）。「對比」關掉彈窗、經 `nf-version-diff-command` 在編輯區開「版本」的對比標籤，只在內建編輯器回答了
 *   `nf-version-diff-query` 時給（外掛形態沒有 editor.js），能力探測、不判斷是哪個殼。「退回這一份」「整本退回」點兩下才發 `restoreCheckpoint`：樂觀鎖是這一次
 *   比較裡每份的 `hashNow`（當時磁碟上沒有的給 `null`），編輯器裡沒儲存的那幾份經 `nf-dirty-query` 問內建編輯器
 *   （外掛形態沒人回答，是空的）。退回之後後端重推 `checkpoints` 與這個存檔點的 `checkpointDiff`，停在這一頁重畫。
 *
 * 前端只發訊息、什麼都不寫；關掉（× / Esc）就丟掉面板上的一切，下次開啟重新要。
 *
 * **誰佔著這一層遮罩**：與表單、獨立版 prompt、服務商彈窗一樣各自判斷「是不是我開的」——這裡認的是面板的根節點還在
 * 不在 `providerModalBody` 裡。別人中途佔了這一層（比如後端推來一條 prompt），根節點就被換掉了，面板當自己已經關了：
 * 之後到的 `checkpoints` / `checkpointDiff` 不再往這一層上畫，× / Esc 也不去藏別人的彈窗。
 */
import { clear, el as mk, maybeById, setHidden } from '../dom';
import { commandVersionDiff, queryDirtyPaths, queryVersionDiff } from '../globals';
import { KIND_LABEL } from '../editor/artifactKinds';
import type {
  CheckpointDiffEntry,
  CheckpointDiffView,
  CheckpointFileStatus,
  CheckpointView,
  OutMessage,
  RestoreCheckpointRequest,
} from '../protocol';
import { primaryBtn, secondaryBtn } from './buttons';
import { closeForm } from './form';
import { formatWords } from './format';
import { el } from './refs';
import { vscode } from './store';

type CheckpointsMessage = Extract<OutMessage, { type: 'checkpoints' }>;
type CheckpointDiffMessage = Extract<OutMessage, { type: 'checkpointDiff' }>;

const EMPTY_TEXT = '還沒有存檔點。批次寫章、全書替換這類批次動作之前會自動存一個；也可以現在存一個。';
const RESTORE_HINT = '退回之前會先自動存一個存檔點，退回也能撤回；編輯器裡沒儲存的檔案會跳過。';

/** 三組的先後與叫法。 */
const GROUPS: ReadonlyArray<[CheckpointFileStatus, string]> = [
  ['changed', '改過的'],
  ['deleted', '之後刪掉的'],
  ['added', '之後新建的'],
];

interface Panel {
  root: HTMLElement;
  listView: HTMLElement;
  diffView: HTMLElement;
  note: HTMLInputElement;
  save: HTMLButtonElement;
  status: HTMLElement;
  list: HTMLElement;
  /** 列表；null 是還在讀。 */
  entries: CheckpointView[] | null;
  unavailable?: string;
  /** 發了 `createCheckpoint`、列表還沒回來。 */
  saving: boolean;
  /** 哪一個自動存檔點的「留住」那一格攤開著，與裡面寫到一半的字（列表重畫時放回去）。 */
  keeping: { id: string; text: string } | null;
  /** 正在看的那一個存檔點（跟現在比）；null 是在列表上。 */
  diffId: string | null;
  /** 比較結果；null 且沒有 `diffError` 是還在比。 */
  diff: CheckpointDiffView | null;
  diffError?: string;
  /** 發了 `restoreCheckpoint`、比較還沒重推回來。 */
  restoring: boolean;
  /** 「也把存檔點之後新建的 N 份搬進回收站」勾著沒有（預設不勾）。 */
  trashAdded: boolean;
}

let panel: Panel | null = null;

/** 點了一下、等第二下的那顆按鈕（兩段式，同全書替換）。點別處、重畫都退回第一段。 */
let armed: { key: string; btn: HTMLButtonElement; label: string } | null = null;

// ---------------------------------------------------------------- 開、關

/** 工程頁工具欄「存檔點…」。 */
export function openCheckpoints(): void {
  if (owns()) {
    panel!.note.focus();
    return;
  }
  // 表單開著（不該有：遮罩蓋著工具欄）就先關，不疊兩份。
  closeForm();
  panel = null;
  armed = null;
  const p = buildPanel();
  el.providerModalTitle.textContent = '存檔點';
  clear(el.providerModalBody);
  el.providerModalBody.appendChild(p.root);
  panel = p;
  renderList();
  setHidden(el.providerModal, false);
  p.note.focus();
  vscode.postMessage({ type: 'listCheckpoints' });
}

/** × / Esc：丟掉面板上的一切。這一層已經被別人佔了的話只丟自己的狀態，不去藏別人的彈窗。 */
export function closeCheckpoints(): void {
  if (!panel) {
    return;
  }
  const mine = owns();
  panel = null;
  armed = null;
  if (mine) {
    setHidden(el.providerModal, true);
    clear(el.providerModalBody);
  }
}

/** 遮罩還是不是這塊面板的（見檔案頭「誰佔著這一層遮罩」）。 */
function owns(): boolean {
  return (
    !!panel &&
    panel.root.isConnected &&
    el.providerModalBody.contains(panel.root) &&
    !el.providerModal.classList.contains('hidden')
  );
}

/**
 * 遮罩上的 × 與 Esc（點空白不關，同表單）。合併檢視（`#mergeModal`，後端推來的覆蓋審閱）蓋在上面時 Esc 不歸這裡——那一層自己沒有 Esc，
 * 這一下關掉的會是底下的面板。輸入法組字時的 Esc 是輸入法的。
 */
export function installCheckpoints(): void {
  el.providerModalClose.addEventListener('click', () => closeCheckpoints());
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !panel || e.isComposing || e.keyCode === 229) {
      return;
    }
    const merge = maybeById('mergeModal');
    if (merge && !merge.classList.contains('hidden')) {
      return;
    }
    closeCheckpoints();
  });
  // 兩段式按鈕：點在別處（哪兒都算）就退回第一段。捕獲階段，半路被 stopPropagation 的點選也算。
  document.addEventListener(
    'click',
    (e) => {
      if (armed && !(e.target instanceof Node && armed.btn.contains(e.target))) {
        disarm();
      }
    },
    true
  );
}

// ---------------------------------------------------------------- 收訊息

/** 收 `checkpoints`：列表（存一個、寫備註、退回之後後端都重推它）。 */
export function renderCheckpoints(msg: CheckpointsMessage): void {
  if (!owns()) {
    panel = null;
    return;
  }
  const p = panel!;
  p.entries = msg.entries;
  p.unavailable = msg.unavailable;
  p.saving = false;
  if (p.keeping && !msg.entries.some((cp) => cp.id === p.keeping!.id && cp.auto)) {
    p.keeping = null;
  }
  renderList();
  if (p.diffId) {
    // 停在「跟現在比」那一頁：只換標題上的備註（寫備註之後它變了），比較結果等 `checkpointDiff`。
    const title = p.diffView.querySelector<HTMLElement>('.cp-diff-title');
    if (title) {
      title.textContent = diffTitle(p);
      title.title = title.textContent;
    }
  }
}

/** 收 `checkpointDiff`：只認正在看的那一個（返回列表之後才到的、另一個視窗要的都不認）。 */
export function renderCheckpointDiff(msg: CheckpointDiffMessage): void {
  if (!owns()) {
    panel = null;
    return;
  }
  const p = panel!;
  if (p.diffId !== msg.id) {
    return;
  }
  p.diff = msg.diff ?? null;
  p.diffError = msg.diff ? undefined : (msg.error ?? '沒比出來。');
  // 退回之後重推回來的：勾選框回到預設（不勾）——搬進回收站的那一下不該留到下一次。
  if (p.restoring) {
    p.trashAdded = false;
  }
  p.restoring = false;
  renderDiff();
}

// ---------------------------------------------------------------- 列表

function buildPanel(): Panel {
  const root = mk('div', 'cp-panel');
  const listView = mk('div', 'cp-list-view');
  const newRow = mk('div', 'cp-new');
  const note = mk('input', 'cp-note-input');
  note.type = 'text';
  note.placeholder = '備註（可以空著），比如：第一卷寫完';
  const save = primaryBtn('存一個存檔點', () => createOne());
  save.classList.add('cp-save');
  save.title = '把整本書現在的樣子存一份（章節、細綱、角色卡、設定、架構、草稿……）；同樣的內容只存一份，不佔多少地方';
  note.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      createOne();
    }
  });
  newRow.append(note, save);
  const status = mk('p', 'hint cp-status');
  const list = mk('div', 'cp-list');
  listView.append(newRow, status, list);
  const diffView = mk('div', 'cp-diff-view hidden');
  root.append(listView, diffView);
  return {
    root,
    listView,
    diffView,
    note,
    save,
    status,
    list,
    entries: null,
    saving: false,
    keeping: null,
    diffId: null,
    diff: null,
    restoring: false,
    trashAdded: false,
  };
}

function createOne(): void {
  const p = panel;
  if (!p || !owns() || p.saving || p.unavailable) {
    return;
  }
  p.saving = true;
  vscode.postMessage({ type: 'createCheckpoint', note: p.note.value.trim() });
  p.note.value = '';
  renderList();
}

function renderList(): void {
  const p = panel!;
  disarm();
  p.note.disabled = !!p.unavailable;
  p.save.disabled = !!p.unavailable || p.saving;
  const status = p.entries === null ? '正在讀…' : p.unavailable ? p.unavailable : p.saving ? '正在存…' : '';
  p.status.textContent = status;
  setHidden(p.status, !status);

  // 推來的列表可能正趕上作者在「留住」那一格里打字：重畫之後焦點放回去。
  const active = document.activeElement;
  const keepFocused = active instanceof HTMLInputElement && active.classList.contains('cp-keep-input') && p.list.contains(active);
  clear(p.list);
  if (p.entries === null || p.unavailable) {
    return;
  }
  if (p.entries.length === 0) {
    p.list.appendChild(mk('p', 'hint cp-empty', EMPTY_TEXT));
    return;
  }
  for (const cp of p.entries) {
    p.list.appendChild(buildRow(p, cp));
  }
  if (keepFocused) {
    const input = p.list.querySelector<HTMLInputElement>('.cp-keep-input');
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }
}

function buildRow(p: Panel, cp: CheckpointView): HTMLElement {
  const row = mk('div', `cp-row${cp.auto ? ' is-auto' : ''}`);
  row.dataset.id = cp.id;

  const main = mk('div', 'cp-row-main');
  const head = mk('div', 'cp-row-head');
  const note = mk('span', `cp-note${cp.note ? '' : ' is-empty'}`, cp.note || '（沒寫備註）');
  note.title = cp.note;
  head.append(
    mk('span', 'cp-time', whenText(cp.time)),
    mk('span', `cp-badge ${cp.auto ? 'is-auto' : 'is-manual'}`, cp.auto ? '自動' : '手動'),
    note
  );
  const meta = mk('div', 'hint cp-row-meta', `正文 ${cp.chapters} 章 · ${formatWords(cp.chapterWords)} · ${cp.files} 份檔案`);
  if (cp.skipped.length > 0) {
    // 第 2 條：沒存進去的說出來。路徑掛在提示上。
    const skipped = mk('span', 'cp-skipped', `${cp.skipped.length} 份超過 2 MB 沒存`);
    skipped.title = cp.skipped.join('\n');
    meta.append(' · ', skipped);
  }
  main.append(head, meta);

  const actions = mk('div', 'cp-row-actions');
  const compare = secondaryBtn('跟現在比', () => openDiff(cp.id));
  compare.title = '看這個存檔點之後改了哪幾份、字數差多少；可以單份對比、退回';
  actions.appendChild(compare);
  if (cp.auto) {
    const keep = secondaryBtn('留住…', () => toggleKeep(cp));
    keep.title = '寫一句備註把它留住：寫了備註就不會被自動裁掉（自動存的只留最近 30 個）';
    actions.appendChild(keep);
  }
  row.append(main, actions);
  if (cp.auto && p.keeping?.id === cp.id) {
    row.appendChild(buildKeep(p, cp.id));
  }
  return row;
}

/** 「留住…」：攤開 / 收起那一格。預設填著原來那句備註（自動存的都有一句「批次寫章之前（第 12–20 章）」）。 */
function toggleKeep(cp: CheckpointView): void {
  const p = panel;
  if (!p) {
    return;
  }
  p.keeping = p.keeping?.id === cp.id ? null : { id: cp.id, text: cp.note };
  renderList();
  const input = p.list.querySelector<HTMLInputElement>('.cp-keep-input');
  input?.focus();
  input?.select();
}

function buildKeep(p: Panel, id: string): HTMLElement {
  const box = mk('div', 'cp-keep');
  const input = mk('input', 'cp-keep-input');
  input.type = 'text';
  input.placeholder = '寫一句備註（空著就留原來那句）';
  input.value = p.keeping?.text ?? '';
  input.addEventListener('input', () => {
    if (p.keeping?.id === id) {
      p.keeping.text = input.value;
    }
  });
  const submit = () => {
    if (panel !== p || !owns()) {
      return;
    }
    vscode.postMessage({ type: 'noteCheckpoint', id, note: input.value.trim() });
    p.keeping = null;
    renderList();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      submit();
    }
  });
  const ok = primaryBtn('留住', submit);
  ok.title = '寫了備註就不會被自動裁掉';
  box.append(input, ok);
  return box;
}

// ---------------------------------------------------------------- 跟現在比

function openDiff(id: string): void {
  const p = panel;
  if (!p || !owns()) {
    return;
  }
  p.diffId = id;
  p.diff = null;
  p.diffError = undefined;
  p.restoring = false;
  p.trashAdded = false;
  setHidden(p.listView, true);
  setHidden(p.diffView, false);
  renderDiff();
  vscode.postMessage({ type: 'checkpointDiff', id });
}

function backToList(): void {
  const p = panel;
  if (!p) {
    return;
  }
  disarm();
  p.diffId = null;
  p.diff = null;
  p.diffError = undefined;
  p.restoring = false;
  clear(p.diffView);
  setHidden(p.diffView, true);
  setHidden(p.listView, false);
}

/** 「10-20 22:30「第一卷寫完」 ↔ 現在」：說法同後端的 `describeCheckpoint`（toast 裡也這麼寫）。 */
function diffTitle(p: Panel): string {
  const cp = p.entries?.find((x) => x.id === p.diffId);
  const label = cp ? `${whenText(cp.time)}${cp.note ? `「${cp.note}」` : ''}` : (p.diffId ?? '');
  return `${label} ↔ 現在`;
}

function renderDiff(): void {
  const p = panel!;
  const view = p.diffView;
  disarm();
  clear(view);

  const head = mk('div', 'cp-diff-head');
  const back = secondaryBtn('← 返回列表', backToList);
  const title = mk('span', 'cp-diff-title', diffTitle(p));
  title.title = title.textContent ?? '';
  head.append(back, title);
  view.appendChild(head);

  if (p.diffError) {
    view.appendChild(mk('p', 'hint cp-status is-error', p.diffError));
    return;
  }
  const d = p.diff;
  if (!d) {
    view.appendChild(mk('p', 'hint cp-status', '正在比…'));
    return;
  }
  if (d.entries.length === 0) {
    view.appendChild(mk('p', 'hint cp-same', `跟現在一模一樣（${d.unchanged} 份），沒有可退回的。`));
    return;
  }
  if (p.restoring) {
    view.appendChild(mk('p', 'hint cp-status', '正在退回…'));
  }

  const byStatus = (s: CheckpointFileStatus) => d.entries.filter((e) => e.status === s);
  // 宿主有沒有合併檢視：只有獨立版的頁面放 `#mergeModal`（外掛用不上它，後端也沒有 `mergeTexts`）。
  const canCompare = queryVersionDiff();
  for (const [status, label] of GROUPS) {
    const files = byStatus(status);
    if (files.length === 0) {
      continue;
    }
    const group = mk('div', `cp-group is-${status}`);
    group.dataset.status = status;
    group.appendChild(mk('div', 'cp-group-head', `${label} · ${files.length} 份`));
    for (const entry of files) {
      group.appendChild(buildFile(p, d.id, entry, canCompare));
    }
    view.appendChild(group);
  }
  if (d.unchanged > 0) {
    view.appendChild(mk('p', 'hint cp-unchanged', `另有 ${d.unchanged} 份跟現在一模一樣，不列。`));
  }
  view.appendChild(buildFoot(p, d));
}

function buildFile(p: Panel, id: string, entry: CheckpointDiffEntry, canCompare: boolean): HTMLElement {
  const row = mk('div', 'cp-file');
  row.dataset.path = entry.path;
  const path = mk('span', 'cp-path', entry.path);
  path.title = entry.path;
  const actions = mk('span', 'cp-file-actions');
  if (entry.status !== 'added') {
    if (canCompare) {
      const compare = secondaryBtn('對比', () => {
        const cp = p.entries?.find((c) => c.id === id);
        if (owns() && cp) {
          // 關掉彈窗、在編輯區開對比標籤：用回一處、恢復整份都只進編輯區，存不存由作者。
          closeCheckpoints();
          commandVersionDiff({ path: entry.path, status: entry.status, checkpoint: { id, time: cp.time, note: cp.note, auto: cp.auto } });
        }
      });
      compare.classList.add('cp-compare');
      compare.title = '關掉這裡，在編輯區開對比標籤：存檔點裡的那一份 ↔ 現在這份；可以一處一處用回（只進編輯區，不寫盤）';
      compare.disabled = p.restoring;
      actions.appendChild(compare);
    }
    const restore = armable(
      `file:${entry.path}`,
      '退回這一份',
      () => '確定退回這一份？',
      () => restoreFiles([entry.path], []),
      'secondary cp-restore'
    );
    restore.title =
      entry.status === 'deleted'
        ? '點兩下：照存檔點裡的樣子把這一份建回來'
        : '點兩下：把這一份換回存檔點裡的樣子（被蓋掉的這一份先存一版歷史）';
    restore.disabled = p.restoring;
    actions.appendChild(restore);
  }
  row.append(path, mk('span', 'cp-kind', KIND_LABEL[entry.kind] ?? KIND_LABEL.other), mk('span', 'cp-words', wordsText(entry)), actions);
  return row;
}

function buildFoot(p: Panel, d: CheckpointDiffView): HTMLElement {
  const back = d.entries.filter((e) => e.status !== 'added').map((e) => e.path);
  const added = d.entries.filter((e) => e.status === 'added').map((e) => e.path);
  const count = () => back.length + (p.trashAdded ? added.length : 0);

  const foot = mk('div', 'cp-foot');
  const row = mk('div', 'cp-foot-row');
  if (added.length > 0) {
    const label = mk('label', 'cp-trash');
    const box = mk('input');
    box.type = 'checkbox';
    box.checked = p.trashAdded;
    box.addEventListener('change', () => {
      p.trashAdded = box.checked;
      sync();
    });
    label.title = '預設不動它們；勾上才搬（搬進工程回收站，不真刪）';
    label.append(box, `也把存檔點之後新建的 ${added.length} 份搬進回收站`);
    row.appendChild(label);
  }
  const whole = armable(
    'all',
    '整本退回',
    () => `確定整本退回（${count()} 份）`,
    () => restoreFiles(back, p.trashAdded ? added : []),
    'primary cp-restore-all'
  );
  whole.title = '點兩下：改過的、之後刪掉的都換回存檔點裡的樣子';
  const sync = () => {
    whole.disabled = p.restoring || count() === 0;
  };
  sync();
  row.appendChild(whole);
  foot.append(row, mk('p', 'hint cp-foot-hint', RESTORE_HINT));
  return foot;
}

/** 退回：樂觀鎖是這一次比較裡每份的 `hashNow`，當時磁碟上沒有的給 `null`。 */
function restoreFiles(paths: string[], trash: string[]): void {
  const p = panel;
  if (!p || !owns() || !p.diff || !p.diffId || p.restoring || paths.length + trash.length === 0) {
    return;
  }
  const byPath = new Map(p.diff.entries.map((e) => [e.path, e]));
  const expect: Record<string, string | null> = {};
  for (const path of [...paths, ...trash]) {
    expect[path] = byPath.get(path)?.hashNow ?? null;
  }
  const request: RestoreCheckpointRequest = { id: p.diffId, paths, trash, expect, dirty: queryDirtyPaths() };
  p.restoring = true;
  renderDiff();
  vscode.postMessage({ type: 'restoreCheckpoint', request });
}

// ---------------------------------------------------------------- 兩段式按鈕

/** 第一下只換字（`is-armed`，同表單的兩段式提交），第二下才 `run`。 */
function armable(
  key: string,
  label: string,
  armedLabel: () => string,
  run: () => void,
  className: string
): HTMLButtonElement {
  const btn = mk('button', className, label);
  btn.addEventListener('click', () => {
    if (armed?.btn === btn && armed.key === key) {
      disarm();
      run();
      return;
    }
    disarm();
    armed = { key, btn, label };
    btn.textContent = armedLabel();
    btn.classList.add('is-armed');
  });
  return btn;
}

function disarm(): void {
  if (armed) {
    armed.btn.textContent = armed.label;
    armed.btn.classList.remove('is-armed');
    armed = null;
  }
}

// ---------------------------------------------------------------- 說法

const pad = (n: number) => String(n).padStart(2, '0');

/** 存檔點的時刻：「10-20 22:30」，不是今年的帶上年份。 */
function whenText(time: number): string {
  const d = new Date(time);
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

/** 「3,011」：一份檔案的字數，千位加逗號（不折成萬字——兩個數要對得出差了多少）。 */
function digits(n: number | undefined): string {
  return String(Math.round(n ?? 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function wordsText(entry: CheckpointDiffEntry): string {
  if (entry.status === 'changed') {
    return `${digits(entry.wordsThen)} → ${digits(entry.wordsNow)} 字`;
  }
  return entry.status === 'deleted' ? `當時 ${digits(entry.wordsThen)} 字` : `現在 ${digits(entry.wordsNow)} 字`;
}
