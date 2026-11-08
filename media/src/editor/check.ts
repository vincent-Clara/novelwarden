/**
 * 寫作體檢（獨立版內建編輯器，階段五）的裝配：正文裡標出禁用詞、敏感詞、超出上限的比喻詞與英文縮寫（高亮映象層的
 * `check` 圖層），狀態列一格「體檢 N」與它的面板，「檢視 → 體檢」那一組的編輯器一半。口徑在 `checkCore.ts`（純函式），
 * 面板在 `checkPanel.ts`。**不調模型**：只是按詞表在正文裡找字。
 *
 * ## 詞從哪來
 *
 * 後端推 `checkTerms`（`controller/check.ts`）：禁用詞與寫正文時寫完數的是同一份（`views/checkTerms.ts` 的
 * `readBannedTerms`，`generate.ts` 也調它），敏感詞表是 `.novelwarden/sensitive.txt` 解析好的結果。`style.md`、
 * `config.md`、敏感詞表變了才推。比喻詞與英文縮寫不隨書變，編輯器直接打包 core 那一份（`manuscriptCheck.ts`）。
 *
 * ## 只看正文
 *
 * 當前標籤是正文（`isProse`：後端給的 `kind` 是 `chapter` / `draft`，前端不拿路徑猜）才查；細綱、角色卡、敏感詞表
 * 本身都不查（狀態列那一格藏起來）。
 *
 * ## 與別的圖層同時開著
 *
 * 一層映象、幾個命名圖層（`highlight.ts`）：同一段字落在幾層裡時那一段 `<mark>` 帶上幾層的 class。`check` 這一層**只畫
 * 下劃線**（`text-decoration` 不佔排版，映象層與 textarea 照樣對得齊），敏感詞另加一層很淡的底色；查詢（`find`）畫的是
 * 底色，兩層疊在同一段字上時查詢的底色蓋過敏感詞的（`check.css` 的選擇器用 `:where()` 降一級），下劃線照畫；段落聚焦
 * （`focus`）管的是字色，與下劃線互不相干。
 *
 * ## 幾萬字的章節每敲一下也不卡
 *
 * 什麼時候重查、改了字之後畫著的那幾段怎麼跟上、輸入法組字中途不重查、兩萬字以上節流，都在 `liveLayer.ts`（名詞高亮
 * 也用它，兩層一個口徑）。這裡只說「哪份檔案查」（`isProse`）與「這份文字畫哪幾段」；查過的結果按「哪一份文字、
 * 哪一版詞表」快取在每份檔案上（`freshResult`）。
 */
import { el, setHidden } from '../dom';
import { toast } from '../globals';
import type { CheckTermsView, InMessage } from '../protocol';
import { onMessage } from '../vscodeApi';
import { isProse } from './api';
import type { OpenFile, Pane } from './api';
import {
  EMPTY_VOCAB,
  checkRanges,
  describeCounts,
  nextOccurrence,
  occurrenceAt,
  replaceAllEdit,
  runCheck,
} from './checkCore';
import type { CheckCategory, CheckEntry, CheckResult, CheckVocab } from './checkCore';
import { checkPanelAnchor, closeCheckPanel, refreshCheckPanel, toggleCheckPanel } from './checkPanel';
import type { CheckPanelData } from './checkPanel';
import { scrollToOffset, tooLargeToHighlight } from './highlight';
import { createLiveLayer, shownText } from './liveLayer';
import type { LiveLayer } from './liveLayer';
import { setStoredPrefs, storedPrefs } from './paragraphState';

/** 高亮映象層上的圖層名。 */
export const CHECK_LAYER = 'check';

// ---------------------------------------------------------------- 偏好

/** 「檢視 → 體檢」那兩個開關。按瀏覽器記在 `novelforge.editor.prefs` 的 `check` 裡。 */
interface CheckPrefs {
  /** 正文裡畫體檢高亮（預設開 ⚑）。 */
  highlight: boolean;
  /** 狀態列顯示「體檢」那一格（預設開 ⚑）。 */
  status: boolean;
}

let prefs: CheckPrefs = loadPrefs();

function loadPrefs(): CheckPrefs {
  const raw = storedPrefs().check as Partial<CheckPrefs> | undefined;
  const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  // 兩個都預設開，只認明明白白的 false。
  return { highlight: c.highlight !== false, status: c.status !== false };
}

function setPref(key: keyof CheckPrefs, on: boolean): void {
  prefs = { ...prefs, [key]: on };
  // 同一個鍵裡還有段落、外觀、專注、統計那幾項：讀出整份、合上自己這一項再整份寫回（setStoredPrefs）。
  setStoredPrefs({ check: prefs });
  layer?.recheckAll(true);
}

// ---------------------------------------------------------------- 詞表

let vocab: CheckVocab = EMPTY_VOCAB;
/** 敏感詞表那幾樣說明（面板裡說）。還沒收到過 `checkTerms` 時 `received` 是 false。 */
let meta: Pick<CheckTermsView, 'sensitivePath' | 'sensitiveExists' | 'sensitiveBad'> & { received: boolean } = {
  sensitivePath: '.novelwarden/sensitive.txt',
  sensitiveExists: false,
  sensitiveBad: [],
  received: false,
};
/** 詞表每換一次加一：快取裡查過的結果按它作廢。 */
let vocabVersion = 0;

function takeTerms(terms: CheckTermsView): void {
  vocab = {
    banned: Array.isArray(terms?.banned) ? terms.banned.filter((t) => typeof t === 'string') : [],
    sensitive: Array.isArray(terms?.sensitive) ? terms.sensitive.filter((t) => t && typeof t.term === 'string') : [],
  };
  meta = {
    sensitivePath: typeof terms?.sensitivePath === 'string' ? terms.sensitivePath : meta.sensitivePath,
    sensitiveExists: !!terms?.sensitiveExists,
    sensitiveBad: Array.isArray(terms?.sensitiveBad) ? terms.sensitiveBad : [],
    received: true,
  };
  vocabVersion++;
  recheckAll();
}

// ---------------------------------------------------------------- 結果（帶快取）

const results = new WeakMap<OpenFile, { draft: string; version: number; result: CheckResult }>();

/** 這份檔案此刻的體檢結果（文字或詞表變了就重查）。 */
function freshResult(file: OpenFile): CheckResult {
  const known = results.get(file);
  if (known && known.draft === file.draft && known.version === vocabVersion) {
    return known.result;
  }
  const result = runCheck(shownText(file), vocab);
  results.set(file, { draft: file.draft, version: vocabVersion, result });
  return result;
}

/** 上一次查出來的（可能是幾百毫秒之前那一份文字的，節流中）；沒查過就現查。狀態列與面板只用它，不額外觸發重查。 */
function lastResult(file: OpenFile): CheckResult {
  const known = results.get(file);
  return known && known.version === vocabVersion ? known.result : freshResult(file);
}

/** 當前標籤是正文時給出它。 */
function proseOf(pane: Pane): OpenFile | undefined {
  const file = pane.activeFile();
  return file && isProse(file) ? file : undefined;
}

// ---------------------------------------------------------------- 重查（liveLayer.ts）

/** 跟著正文重查的那一套（`installCheck` 裡造）。 */
let layer: LiveLayer | undefined;

/** 現在就按當前文字重查、重畫（不節流），狀態列與面板跟著。 */
function checkNow(pane: Pane): void {
  layer?.checkNow(pane);
}

function recheckAll(): void {
  layer?.recheckAll();
}

// ---------------------------------------------------------------- 狀態列那一格

const cells = new Map<Pane, HTMLElement>();

function cellOf(pane: Pane): HTMLElement | undefined {
  const known = cells.get(pane);
  if (known?.isConnected) {
    return known;
  }
  const status = pane.root.querySelector<HTMLElement>('.ed-status');
  if (!status) {
    return undefined;
  }
  const cell = el('span', 'ed-check hidden');
  cell.setAttribute('role', 'button');
  cell.setAttribute('aria-expanded', 'false');
  cell.tabIndex = 0;
  // 緊跟字數那一格（`.spacer` 之前）。page.ts 與 createPaneElements 裡沒有它：兩塊編輯區都由這裡現造。
  status.insertBefore(cell, status.querySelector('.spacer'));
  // 按下滑鼠不奪編輯區的焦點（與碼字統計那一格一樣）。
  cell.addEventListener('mousedown', (e) => e.preventDefault());
  cell.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePanel(pane, cell);
  });
  cell.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      togglePanel(pane, cell);
    }
  });
  cells.set(pane, cell);
  return cell;
}

/** 畫這一塊的「體檢」那一格。不是正文、關掉了這一格時藏起來（面板開著就收起）。 */
function renderCell(pane: Pane): void {
  const cell = cellOf(pane);
  if (!cell) {
    return;
  }
  const file = proseOf(pane);
  if (!prefs.status || !file) {
    setHidden(cell, true);
    if (checkPanelAnchor() === cell) {
      closeCheckPanel();
    }
    return;
  }
  const result = lastResult(file);
  setHidden(cell, false);
  cell.textContent = result.total > 0 ? `體檢 ${result.total}` : '體檢 ✓';
  cell.classList.toggle('has-issues', result.total > 0);
  const tips = [
    result.total > 0 ? describeCounts(result) : '沒有發現敏感詞、禁用詞、超出上限的比喻詞與英文縮寫',
    '點一下看是哪幾個詞，點詞跳到它在正文裡的位置',
  ];
  if (!prefs.highlight) {
    tips.push('正文裡的體檢高亮關著（「檢視 → 體檢高亮」）');
  }
  cell.title = tips.join('\n');
}

// ---------------------------------------------------------------- 面板

/** 面板上點過的那個詞跳到了第幾處（「2/5」）。 */
let cursor: { path: string; category: CheckCategory; term: string; index: number } | undefined;

let post: (msg: InMessage) => void = () => {};

function togglePanel(pane: Pane, cell: HTMLElement): void {
  toggleCheckPanel(cell, () => panelData(pane), {
    jump: (entry) => jump(pane, entry),
    replaceOne: (entry) => replaceOne(pane, entry),
    replaceAll: (entry) => replaceAll(pane, entry),
    editList: () => editList(),
  });
}

function panelData(pane: Pane): CheckPanelData {
  const file = proseOf(pane);
  const base = {
    highlight: prefs.highlight,
    sensitivePath: meta.sensitivePath,
    sensitiveExists: meta.sensitiveExists,
    sensitiveBad: meta.sensitiveBad,
    received: meta.received,
  };
  if (!file) {
    return { ...base, prose: false };
  }
  const result = lastResult(file);
  return {
    ...base,
    prose: true,
    result,
    tooLarge: tooLargeToHighlight(shownText(file)),
    cursor: cursor && cursor.path === file.path ? cursor : undefined,
  };
}

/** 面板上的動作要的是此刻的位置：節流中（長正文）先當場重查一遍，再按類別與詞認回那一條。 */
function freshEntry(pane: Pane, entry: Pick<CheckEntry, 'category' | 'term'>): { file: OpenFile; entry?: CheckEntry } | undefined {
  const file = proseOf(pane);
  if (!file) {
    return undefined;
  }
  if (results.get(file)?.draft !== file.draft || layer?.composing(pane)) {
    checkNow(pane);
  }
  const result = freshResult(file);
  return { file, entry: result.entries.find((e) => e.category === entry.category && e.term === entry.term) };
}

/** 預覽裡先切回編輯（`setPreviewing(false)`：滾到預覽裡看著的那一處）。 */
function ensureEditing(pane: Pane): void {
  if (pane.isPreviewing()) {
    pane.setPreviewing(false);
  }
}

function select(pane: Pane, file: OpenFile, entry: CheckEntry, index: number): void {
  const area = pane.area;
  const start = entry.offsets[index];
  area.focus({ preventScroll: true });
  area.setSelectionRange(start, start + entry.length);
  scrollToOffset(pane, start, { onlyIfHidden: true });
  cursor = { path: file.path, category: entry.category, term: entry.term, index };
  refreshCheckPanel();
}

/** 點面板上的一個詞：跳到它的下一處並選中（到底了繞回第一處）。 */
function jump(pane: Pane, entry: CheckEntry): void {
  ensureEditing(pane);
  const got = freshEntry(pane, entry);
  if (!got) {
    return;
  }
  if (!got.entry) {
    toast(`「${entry.term}」已經不在正文裡了。`);
    refreshCheckPanel();
    return;
  }
  select(pane, got.file, got.entry, nextOccurrence(got.entry, pane.area.selectionStart, pane.area.selectionEnd));
}

/**
 * 「替換本處」：選區正好是這個詞的某一處才換（一步撤銷），換完選中下一處；不是的話這一下只選中下一處——看清楚了再按
 * 一下才換（與查詢替換的「替換」同一個規矩）。
 */
function replaceOne(pane: Pane, entry: CheckEntry): void {
  ensureEditing(pane);
  const got = freshEntry(pane, entry);
  const e = got?.entry;
  if (!got || !e?.replacement) {
    refreshCheckPanel();
    return;
  }
  const area = pane.area;
  const i = occurrenceAt(e, area.selectionStart, area.selectionEnd);
  if (i < 0) {
    select(pane, got.file, e, nextOccurrence(e, area.selectionStart, area.selectionEnd));
    return;
  }
  const start = e.offsets[i];
  const replacement = e.replacement;
  pane.applyEdit(start, start + e.length, replacement, { start, end: start + replacement.length });
  checkNow(pane);
  const next = freshEntry(pane, e);
  if (next?.entry) {
    const after = next.entry.offsets.findIndex((o) => o >= start + replacement.length);
    select(pane, next.file, next.entry, after >= 0 ? after : 0);
  } else {
    cursor = undefined;
    area.focus({ preventScroll: true });
    refreshCheckPanel();
  }
}

/** 「本檔案全部替換」：從第一處到最後一處一次 `applyEdit`，只記一步撤銷（與查詢替換的「全部替換」同一條路）。 */
function replaceAll(pane: Pane, entry: CheckEntry): void {
  ensureEditing(pane);
  const got = freshEntry(pane, entry);
  const e = got?.entry;
  if (!got || !e?.replacement) {
    refreshCheckPanel();
    return;
  }
  const edit = replaceAllEdit(pane.area.value, e, e.replacement);
  if (!edit) {
    return;
  }
  pane.applyEdit(edit.start, edit.end, edit.text);
  cursor = undefined;
  checkNow(pane);
  toast(`替換了 ${edit.count} 處：「${e.term}」→「${e.replacement}」（Ctrl+Z 一步退回）`);
}

/** 「編輯敏感詞表…」：後端沒有就新建一份模板，然後在編輯器裡開啟它。 */
function editList(): void {
  closeCheckPanel();
  if (document.body.classList.contains('no-workspace')) {
    toast('先開啟一個工程。', true);
    return;
  }
  post({ type: 'editSensitiveWords' });
}

// ---------------------------------------------------------------- 裝配

/** 裝一次（`index.ts`）。 */
export function installCheck(send: (msg: InMessage) => void): void {
  post = send;
  onMessage((msg) => {
    if (msg.type === 'checkTerms') {
      takeTerms(msg.terms);
    }
  });

  layer = createLiveLayer({
    layer: CHECK_LAYER,
    applies: isProse,
    ranges: (file, text) => {
      // 結果總要算（狀態列那一格與面板用），畫不畫看開關。
      const result = freshResult(file);
      return prefs.highlight && !tooLargeToHighlight(text) ? checkRanges(result) : [];
    },
    checked: (pane) => {
      renderCell(pane);
      refreshCheckPanel();
    },
    rendered: renderCell,
  });

  // 換了工程（或關掉了）：詞表作廢，等新工程的那一份；面板收起。
  window.addEventListener('nf-workspace-reset', () => {
    closeCheckPanel();
    cursor = undefined;
    takeTerms({ banned: [], sensitive: [], sensitivePath: meta.sensitivePath, sensitiveExists: false, sensitiveBad: [] });
    meta.received = false;
  });

  window.addEventListener('nf-check-query', (e) => {
    e.detail.available = true;
    e.detail.highlight = prefs.highlight;
    e.detail.status = prefs.status;
    e.detail.canEditList = !document.body.classList.contains('no-workspace');
  });

  window.addEventListener('nf-check-command', (e) => {
    switch (e.detail.name) {
      case 'toggleHighlight':
        setPref('highlight', !prefs.highlight);
        break;
      case 'toggleStatus':
        setPref('status', !prefs.status);
        break;
      case 'editList':
        editList();
        break;
    }
  });
}
