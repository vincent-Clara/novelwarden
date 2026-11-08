/**
 * 名詞高亮與懸停浮窗（獨立版內建編輯器）。**不調模型**（第 4 條）：名詞表是後端讀盤給的那一份，認名字是找字。
 *
 * - **名詞圖層**：正文、草稿、細綱、角色卡、設定、情節大綱與敘事線（與名詞補全同一份白名單 `completionApplies`，看後端給
 *   的 `kind`）裡，角色名與設定名各鋪一層淡底色，設定名錄裡出現過、還沒建條目的名字畫虛下劃線（⚑）——高亮映象層的
 *   `names` 圖層。什麼時候重算、打字 / 輸入法組字 / 撤銷時畫著的那幾段怎麼跟上、兩萬字以上節流，與寫作體檢同一套
 *   （`liveLayer.ts`）；哪幾段是名字在 `namesCore.ts` 的 `nameRanges`（長的優先、一個字的不認、卡自己那一份裡不標它自己）。
 * - **懸停浮窗**：滑鼠在一個名字上停 {@link HOVER_DELAY_MS} 毫秒，貼著滑鼠彈一個小框：名字、型別（角色 / 設定的分類 /
 *   未建條目）、別名命中時寫「這裡寫的是……」、一句話簡介（卡或條目裡現成的那一句），底下一行說 Ctrl+點選能開啟什麼。
 *   映象層不接滑鼠，滑鼠底下是哪個名字靠 `highlight.ts` 的 `rangeAtPoint` 量映象，再按那一段的字認回表裡那一條。框本身
 *   `pointer-events: none`，不擋滑鼠；打字、滾動、按下滑鼠、移開、輸入法組字、換檔案就收起。按住滑鼠拖選區時不彈。
 * - **Ctrl+點選**（Mac 上 ⌘+點選，Mac 的 Ctrl+點選是右鍵）：在這一塊編輯區開啟它的角色卡或設定條目（`openEditor`，正常
 *   標籤，與「轉到…」一樣）；未建條目沒有檔案，說一句。按著 Ctrl 指著能開啟的名字時滑鼠變成手形。
 * - **右鍵一個名字**：選單最前面一項「開啟「林昭」的角色卡」（`api.ts` 的 `addAreaMenu`），未建條目不給。
 * - **觸屏**：手指沒有懸停，點一下之後補發的相容滑鼠事件也不當懸停（`touch.ts`）。**手指點在名字上**（游標照常落在那兒）
 *   就彈同一只浮窗，底下一顆「開啟角色卡 / 設定條目」（手指長按在正文裡走系統的選字選單，沒有我們那一項，見 view/menu.ts）；
 *   再點一下別處、打字、滾動、失焦就收。不做成點一下就開啟卡片（點正文是要放游標、要看的是這個名字本身）。
 *   軟鍵盤彈著（正在打字，body 掛 `kb-open`）時點名字不彈：那是在挪游標，浮窗只會蓋住底下兩行。
 *
 * 名詞表與補全是同一份（`names.ts` 管收發：帶指紋問、沒變只回指紋、磁碟上變過才算過期），這裡只在當前檔案歸這一層管時
 * 要，表換了整層重畫。開關在「檢視 → 名詞高亮」（預設開 ⚑，`novelforge.editor.prefs` 的 `nameHighlight`，只認明明白白
 * 的 `false`）；關著時不畫，也不彈浮窗（浮窗靠畫著的那一層認名字）。超過 30 萬字的檔案不畫（映象層的上限）。
 */
import { el } from '../dom';
import { toast } from '../globals';
import type { MenuItem } from '../globals';
import type { InMessage } from '../protocol';
import { onMessage } from '../vscodeApi';
import { onEditorChange } from './api';
import type { OpenFile, Pane } from './api';
import { measureOffset, nextFrame, rangeAtPoint, tooLargeToHighlight } from './highlight';
import type { HighlightRange } from './highlight';
import { createLiveLayer } from './liveLayer';
import type { LiveLayer } from './liveLayer';
import { currentNameCatalog, onNameCatalog, refreshNameIndex } from './names';
import { buildNameMatcher, completionApplies, nameItemOf, nameRanges } from './namesCore';
import type { NameCatalog, NameItem, NameMatcher } from './namesCore';
import { onPrefsChange, setStoredPrefs, storedPrefs } from './paragraphState';
import { isTouchEvent, lastPointerWasTouch, trackPointer } from '../touch';
import { addAreaMenu } from './api';
import { isMacPlatform } from './shortcuts';
import { panes } from './store';

/** 高亮映象層上的圖層名。 */
export const NAMES_LAYER = 'names';
/** 滑鼠在一個名字上停多久才彈浮窗。 */
export const HOVER_DELAY_MS = 400;
/** 偏好裡那一項的鍵。 */
const PREF_KEY = 'nameHighlight';

// ---------------------------------------------------------------- 偏好

let enabled = readEnabled();

function readEnabled(): boolean {
  return storedPrefs()[PREF_KEY] !== false;
}

function setEnabled(on: boolean): void {
  if (enabled !== on) {
    setStoredPrefs({ [PREF_KEY]: on ? undefined : false });
  }
}

// ---------------------------------------------------------------- 認名字

let matcher: { catalog: NameCatalog; matcher: NameMatcher } | null = null;

/** 手上那份表切好的匹配表（表換了重切）。還沒有表時 null。 */
function currentMatcher(): NameMatcher | null {
  const catalog = currentNameCatalog();
  if (!catalog) {
    matcher = null;
    return null;
  }
  if (matcher?.catalog !== catalog) {
    matcher = { catalog, matcher: buildNameMatcher(catalog) };
  }
  return matcher.matcher;
}

/** 每份檔案上一次認出來的（哪一份文字、哪一張表），`render` 時文字沒變就不重找。 */
const found = new WeakMap<OpenFile, { draft: string; matcher: NameMatcher; ranges: HighlightRange[] }>();

function rangesOf(file: OpenFile, text: string): HighlightRange[] {
  if (!enabled || tooLargeToHighlight(text)) {
    return [];
  }
  const m = currentMatcher();
  if (!m) {
    // 還沒有表：要一份，到了整層重畫（onNameCatalog）。
    refreshNameIndex();
    return [];
  }
  const known = found.get(file);
  if (known && known.draft === file.draft && known.matcher === m) {
    return known.ranges;
  }
  const ranges = nameRanges(m, text, file.path).map(({ start, end, cls }) => ({ start, end, cls }));
  found.set(file, { draft: file.draft, matcher: m, ranges });
  return ranges;
}

let layer: LiveLayer | undefined;

/** 滑鼠底下那個名字：畫著的那一段與它在表裡的那一條。 */
function nameAt(pane: Pane, x: number, y: number): { range: HighlightRange; item: NameItem } | undefined {
  const m = currentMatcher();
  if (!enabled || !m || pane.isPreviewing()) {
    return undefined;
  }
  const range = rangeAtPoint(pane, NAMES_LAYER, x, y);
  const item = range && nameItemOf(m, pane.area.value.slice(range.start, range.end));
  return range && item ? { range, item } : undefined;
}

// ---------------------------------------------------------------- 浮窗

let tip: HTMLElement | null = null;
/** 浮窗正在說的（或等著要說的）是哪一塊的哪一段。 */
let current: { pane: Pane; start: number; end: number } | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

function modLabel(): string {
  return isMacPlatform() ? '⌘' : 'Ctrl';
}

function hideTip(): void {
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
  tappedTip = false;
  current = null;
  tip?.remove();
  tip = null;
}

function buildTip(item: NameItem, written: string, touch = false, open?: () => void): HTMLElement {
  const box = el('div', `nm-tip nm-${item.source}`);
  box.setAttribute('role', 'tooltip');
  const head = el('div', 'nm-head');
  head.append(el('span', 'nm-name', item.name), el('span', 'nm-badge', item.source === 'unfiled' ? `${item.badge} · 未建條目` : item.badge));
  box.appendChild(head);
  if (written.toLowerCase() !== item.name.toLowerCase()) {
    box.appendChild(el('div', 'nm-alias', `這裡寫的是「${written}」`));
  }
  box.appendChild(item.brief ? el('div', 'nm-brief', item.brief) : el('div', 'nm-brief nm-empty', '還沒有一句話簡介'));
  const what = item.source === 'character' ? '角色卡' : '設定條目';
  if (item.path && touch && open) {
    // 手指點出來的浮窗：底下是一顆按鈕。按下去不奪焦點——正文區一失焦浮窗就收了，點不到它。
    const btn = el('button', 'chip-btn nm-open', `開啟${what}`);
    btn.type = 'button';
    for (const type of ['pointerdown', 'mousedown'] as const) {
      btn.addEventListener(type, (e) => e.preventDefault());
    }
    btn.addEventListener('click', () => {
      hideTip();
      open();
    });
    box.classList.add('nm-touch');
    box.appendChild(btn);
    return box;
  }
  box.appendChild(el('div', 'nm-foot', item.path ? `${modLabel()}+點選開啟${what}` : '設定名錄裡出現過，還沒建條目'));
  return box;
}

/** 貼著滑鼠擺：滑鼠下面一點，靠近底邊翻到上面，橫向夾進視口。 */
function placeTip(box: HTMLElement, x: number, y: number): void {
  const gap = 18;
  const width = box.offsetWidth;
  const height = box.offsetHeight;
  const left = Math.max(4, Math.min(x - 12, window.innerWidth - width - 4));
  const below = y + gap;
  const top = below + height > window.innerHeight - 4 && y - gap - height >= 4 ? y - gap - height : below;
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
}

function showTip(pane: Pane, hit: { range: HighlightRange; item: NameItem }, x: number, y: number, touch = false): void {
  tip?.remove();
  const path = hit.item.path;
  const open = path ? () => post({ type: 'openEditor', path, pane: pane.id }) : undefined;
  tip = buildTip(hit.item, pane.area.value.slice(hit.range.start, hit.range.end), touch, open);
  document.body.appendChild(tip);
  placeTip(tip, x, y);
}

/** 手指點在一個名字上：游標照常落下，同時彈它的浮窗（觸屏沒有懸停）。點別處、打字、滾動、失焦照舊收起；正在打字時不彈。 */
function onTap(pane: Pane, e: MouseEvent): void {
  if (!isTouchEvent(e) || layer?.composing(pane)) {
    return;
  }
  const hit = nameAt(pane, e.clientX, e.clientY);
  hideTip();
  if (!hit || document.body.classList.contains('kb-open')) {
    return;
  }
  current = { pane, start: hit.range.start, end: hit.range.end };
  showTip(pane, hit, e.clientX, e.clientY, true);
  tappedTip = true;
}

/** 正開著的浮窗是手指點出來的（軟鍵盤彈出來、頁面變矮時要跟著那個名字挪）。 */
let tappedTip = false;

/**
 * 手指點出來的浮窗跟著名字挪：點一下正文，軟鍵盤隨即彈出來，頁面變矮、編輯區收起章節條與工具欄（narrow.css），名字挪了地方，
 * 浮窗還停在點下去的那個座標上（多半已經在鍵盤底下）。視窗尺寸變了就按那個名字現在的位置重擺，量不出來或滾出了編輯區就收起。
 */
function followTappedTip(): void {
  if (!tip || !tappedTip || !current) {
    return;
  }
  const { pane, start } = current;
  const area = pane.area;
  const rect = area.getBoundingClientRect();
  const pos = measureOffset(pane, start);
  if (!pos) {
    hideTip();
    return;
  }
  const top = rect.top + area.clientTop + pos.top - area.scrollTop;
  if (rect.height > 0 && (top + pos.height <= rect.top || top >= rect.bottom)) {
    hideTip();
    return;
  }
  placeTip(tip, rect.left + area.clientLeft + pos.left - area.scrollLeft + 12, top + pos.height / 2);
}

/** 右鍵一個能開啟的名字：選單最前面給「開啟「林昭」的角色卡」。未建條目沒有檔案，不給。 */
function menuItems(pane: Pane, at: { x: number; y: number }): MenuItem[] {
  const hit = nameAt(pane, at.x, at.y);
  const path = hit?.item.path;
  if (!hit || !path) {
    return [];
  }
  const what = hit.item.source === 'character' ? '角色卡' : '設定條目';
  return [{ label: `開啟「${hit.item.name}」的${what}`, run: () => post({ type: 'openEditor', path, pane: pane.id }) }];
}

// ---------------------------------------------------------------- 滑鼠

/** 最近一次滑鼠在哪塊、哪兒（下一幀量）。 */
let pointer: { pane: Pane; x: number; y: number; mod: boolean; dragging: boolean } | null = null;
let frame: number | undefined;

function modHeld(e: MouseEvent | KeyboardEvent): boolean {
  return isMacPlatform() ? e.metaKey : e.ctrlKey;
}

function setLinkCursor(pane: Pane, on: boolean): void {
  pane.area.classList.toggle('nm-link', on);
}

/** 量滑鼠底下是不是名字：換了一個就重新計時，離開了就收起。 */
function probe(): void {
  frame = undefined;
  const p = pointer;
  if (!p) {
    return;
  }
  const hit = p.dragging || layer?.composing(p.pane) ? undefined : nameAt(p.pane, p.x, p.y);
  setLinkCursor(p.pane, !!hit?.item.path && p.mod);
  if (!hit) {
    if (current) {
      hideTip();
    }
    return;
  }
  if (current && current.pane === p.pane && current.start === hit.range.start && current.end === hit.range.end) {
    return;
  }
  hideTip();
  current = { pane: p.pane, start: hit.range.start, end: hit.range.end };
  const { x, y } = p;
  timer = setTimeout(() => {
    timer = undefined;
    // 停夠了：再認一次（這期間可能打了字、滾了），還是它才彈。
    const again = nameAt(p.pane, x, y);
    if (current && again && again.range.start === current.start && again.range.end === current.end) {
      showTip(p.pane, again, x, y);
    } else {
      hideTip();
    }
  }, HOVER_DELAY_MS);
}

function onMove(pane: Pane, e: MouseEvent): void {
  // 手指點一下之後補發的相容 mousemove 不是懸停（手指的浮窗走 onTap）。
  if (lastPointerWasTouch()) {
    return;
  }
  pointer = { pane, x: e.clientX, y: e.clientY, mod: modHeld(e), dragging: e.buttons !== 0 };
  if (frame === undefined) {
    frame = nextFrame(probe);
  }
}

/** Ctrl+點選（Mac 上 ⌘+點選）一個名字：開啟它的卡或條目。不是名字照常（放游標）。 */
function onDown(pane: Pane, e: MouseEvent): void {
  hideTip();
  if (e.button !== 0 || !modHeld(e)) {
    return;
  }
  const hit = nameAt(pane, e.clientX, e.clientY);
  if (!hit) {
    return;
  }
  e.preventDefault();
  setLinkCursor(pane, false);
  if (!hit.item.path) {
    toast(`「${hit.item.name}」還沒建條目（設定名錄裡出現過的名字）。`);
    return;
  }
  post({ type: 'openEditor', path: hit.item.path, pane: pane.id });
}

const hooked = new WeakSet<Pane>();

function hook(pane: Pane): void {
  if (hooked.has(pane)) {
    return;
  }
  hooked.add(pane);
  const area = pane.area;
  area.addEventListener('mousemove', (e) => onMove(pane, e));
  area.addEventListener('mousedown', (e) => onDown(pane, e));
  area.addEventListener('click', (e) => onTap(pane, e));
  area.addEventListener('mouseleave', () => {
    pointer = null;
    setLinkCursor(pane, false);
    // 手指點出來的浮窗不跟滑鼠走：點完之後補發的相容 mouseleave 不收它（點別處、打字、滾動照舊收）。
    if (!lastPointerWasTouch()) {
      hideTip();
    }
  });
  // 右鍵（長按）彈選單時也收：兩樣都是 fixed 的，疊在一起誰都讀不清。
  for (const type of ['keydown', 'scroll', 'wheel', 'compositionstart', 'blur', 'contextmenu'] as const) {
    area.addEventListener(type, (e) => {
      // 光按下修飾鍵不算（按住 Ctrl 正是要點它）。
      if (e instanceof KeyboardEvent && ['Control', 'Meta', 'Shift', 'Alt'].includes(e.key)) {
        return;
      }
      if (current?.pane === pane) {
        hideTip();
      }
    });
  }
}

/** 按下 / 鬆開 Ctrl（⌘）時滑鼠沒動：手形跟著變。 */
function onModKey(e: KeyboardEvent): void {
  const p = pointer;
  if (!p || (e.key !== 'Control' && e.key !== 'Meta')) {
    return;
  }
  const mod = modHeld(e);
  if (mod !== p.mod) {
    p.mod = mod;
    if (frame === undefined) {
      frame = nextFrame(probe);
    }
  }
}

// ---------------------------------------------------------------- 裝配

let post: (msg: InMessage) => void = () => {};

/** 當前正對著一份歸這一層管的檔案（要不要問名詞表）。 */
function wantsIndex(): boolean {
  return (
    enabled &&
    Object.values(panes).some((pane) => {
      const file = pane?.activeFile();
      return !!file && completionApplies(file.kind);
    })
  );
}

/** 裝一次（`index.ts`，在 `installNames` 之後：名詞表的收發歸它）。 */
export function installNameMarks(send: (msg: InMessage) => void): void {
  post = send;
  trackPointer();
  addAreaMenu(menuItems);
  layer = createLiveLayer({
    layer: NAMES_LAYER,
    applies: (file) => completionApplies(file.kind),
    ranges: rangesOf,
  });

  onEditorChange((ev) => {
    if (ev.type === 'render') {
      hook(ev.pane);
      if (current?.pane === ev.pane) {
        hideTip();
      }
      const file = ev.pane.activeFile();
      if (enabled && file && completionApplies(file.kind)) {
        refreshNameIndex();
      }
    } else if (current?.pane === ev.pane) {
      hideTip();
    }
  });
  for (const pane of Object.values(panes)) {
    if (pane) {
      hook(pane);
    }
  }
  document.addEventListener('keydown', onModKey, true);
  document.addEventListener('keyup', onModKey, true);
  window.addEventListener('blur', hideTip);
  // 軟鍵盤彈出 / 收起：頁面變矮又變高，手指點出來的浮窗跟著名字挪（下一幀，等新排版落定）。
  window.addEventListener('resize', () => nextFrame(followTappedTip));

  // 表換了（到了新的一份、換工程作廢）：整層按新表重畫。
  onNameCatalog(() => {
    hideTip();
    layer?.recheckAll();
  });

  // 磁碟上變過（names.ts 先記一筆過期）：正對著要畫的檔案就再問一次，沒變的話後端只回指紋。
  onMessage((msg) => {
    if (msg.type === 'state' && wantsIndex()) {
      queueMicrotask(refreshNameIndex);
    }
  });

  onPrefsChange(() => {
    const next = readEnabled();
    if (next === enabled) {
      return;
    }
    enabled = next;
    hideTip();
    for (const pane of Object.values(panes)) {
      if (pane) {
        setLinkCursor(pane, false);
      }
    }
    layer?.recheckAll(true);
  });

  window.addEventListener('nf-names-query', (e) => {
    e.detail.highlight = enabled;
  });

  window.addEventListener('nf-names-command', (e) => {
    if (e.detail.name === 'toggleHighlight') {
      setEnabled(!enabled);
    }
  });
}
