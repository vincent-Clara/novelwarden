/**
 * 高亮映象層：在編輯區的 textarea 背後疊一層映象 div，畫 `<mark>` 的底色。
 *
 * ## 為什麼要這一層
 *
 * textarea 裡畫不了高亮——它只有一份純文字和一段原生選區。查詢的「全部匹配 + 當前那一處」、
 * 往後的禁用詞、段落聚焦都要在字底下塗顏色，只能另起一層排得一模一樣的文字，在那一層上塗，
 * 再讓 textarea 透明地蓋在上面：
 *
 * - **映象在下、textarea 在上**。textarea 背景透明（底色由編輯區外框給），文字照常畫；映象裡的文字是
 *   透明的，只有 `<mark>` 的底色看得見。所以游標、選區、輸入法、點選、右鍵全是 textarea 自己的，
 *   映象 `pointer-events: none`，一點都不碰。
 * - **排得一模一樣**：字型、字號、行距、內邊距（含版心）與 textarea 讀同一組 CSS 變數（`css/standalone/look.css`
 *   裡那一條共用的規則，外觀面板改的就是它們）；每次渲染還從 textarea 的**計算樣式**抄字型、字號、行高、字距、內邊距、
 *   `white-space` / 斷行規則、`tab-size`（`.mono` 檔案換了字型也跟得上）；寬度取 textarea 的
 *   內容區（扣掉豎捲軸），滾動用 `transform` 跟著 textarea 平移。外觀一變由 `relayoutMirror` 當場重抄。
 * - **命名圖層**：查詢用 `find`，段落聚焦用 `focus`（那一層的 `<mark>` 不畫底色、用實色畫字），寫作體檢用 `check`，
 *   名詞高亮用 `names`，互相不覆蓋；同一段字落在幾層裡時，那一段的 `<mark>` 帶上這幾層的 class。
 *
 * ## 什麼時候重畫
 *
 * - `setHighlights` / `clearHighlights`：當場重畫。
 * - 內容變了（`onEditorChange` 的 `edit`）：各層的範圍先按這一處改動平移（壓在改動上的那幾處丟掉），
 *   下一幀重畫；呼叫方自己在下一幀重算了再 `setHighlights` 的話，那一幀只畫一次。
 * - 換了檔案（`render` 時當前路徑變了）：**所有圖層清空**——範圍是給上一個檔案算的。
 * - 切預覽 / 關標籤等（`render`）：當場按新狀態重畫（textarea 藏起來時映象跟著藏）。
 * - 尺寸變了（`ResizeObserver`；沒有就不管）：只重擺位置和寬度，文字留著讓瀏覽器自己重排。
 * - 文字超過 `HIGHLIGHT_LIMIT`（30 萬字元）不畫：整份文字排兩遍太費。呼叫方自己決定要不要說一句
 *   （查詢條會說）。
 *
 * ## 按行分塊，只換變了的那幾塊
 *
 * 映象裡一行（按 `\n` 切，行尾的 `\n` 留在這一行裡）一個 `<div>`，每塊記著「這一行的字 + 落在這一行的那幾段」。
 * 重畫時與上一次逐塊比，頭尾一樣的塊原樣留著，只換中間變了的那幾塊——打一個字只重建、重排一行。從前每次整份
 * `replaceChildren`，三萬字的章節、名詞高亮那樣幾百上千處標記時每敲一下要 20~30ms（實測，超過一幀），分塊之後
 * 不到 1ms，與章節長短基本無關。
 *
 * 分塊不改排版：`pre-wrap` 裡 `\n` 本來就是強制斷行，塊尾的那個 `\n` 不多出一行（與 textarea 一樣），空行就是隻有
 * 一個 `\n` 的塊；最後一行是空的（文字以 `\n` 結尾）時放一個零寬空格把它撐出來。`text-indent` 只給第一塊
 * （`highlight.css`）——textarea 裡它也只管第一行。塊的 `textContent` 連起來就是 textarea 的文字。
 *
 * ## 滑鼠底下是哪一段（`rangeAtPoint`）
 *
 * 映象 `pointer-events: none`，滑鼠事件全落在 textarea 上；瀏覽器按座標取字（`caretPositionFromPoint`）在 textarea
 * 上靠不住（Chromium 時有時無，WebKit 沒有）。所以反過來量映象：按縱向二分找到那一塊，再在塊裡量那幾個 `<mark>`。
 * 名詞浮窗用它（`nameMarks.ts`），只認畫著的圖層。
 *
 * ## 順帶：精確滾到某個字
 *
 * `scrollToOffset` 在一個看不見的映象裡，把這個字之前的文字和它所在那一行排出來，量這個字的縱向位置，
 * 再把 textarea 滾到讓它停在視口偏上三分之一處。從前審稿引文定位是按字元位置佔全文的比例估的，
 * 段落長短不一時能差出好幾屏。
 */
import { onEditorChange } from './api';
import type { TextChange } from './history';
import type { Pane } from './store';

/** 一段要塗色的字：`[start, end)`（按 `area.value` 的下標），`cls` 是這一段 `<mark>` 的 class。 */
export interface HighlightRange {
  start: number;
  end: number;
  cls: string;
}

/** 超過這麼多字元就不畫（也不精確量位置，滾動退回按比例估）。 */
export const HIGHLIGHT_LIMIT = 300_000;

/** 這份文字大到不畫高亮了沒有。 */
export function tooLargeToHighlight(text: string): boolean {
  return text.length > HIGHLIGHT_LIMIT;
}

/** 從 textarea 抄到映象上的計算樣式：凡是影響文字怎麼排的都在這裡。 */
const COPIED_STYLES = [
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-variant',
  'font-stretch',
  'font-kerning',
  'font-feature-settings',
  'font-variation-settings',
  'font-optical-sizing',
  'font-synthesis',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'text-indent',
  'text-transform',
  'text-align',
  'text-rendering',
  'text-spacing-trim',
  'text-autospace',
  'tab-size',
  'white-space',
  'word-break',
  'overflow-wrap',
  'line-break',
  'hyphens',
  'direction',
  'unicode-bidi',
  'writing-mode',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  '-webkit-text-size-adjust',
] as const;

interface Mirror {
  pane: Pane;
  /** `.ed-mirror`：蓋在 textarea 內容區（不含捲軸）上的框，`overflow: hidden`。 */
  box: HTMLElement;
  /** `.ed-mirror-content`：文字與 `<mark>`，隨 textarea 的滾動平移。 */
  content: HTMLElement;
  /** 量位置用的那一份（看不見），第一次量的時候才造。 */
  probe?: { box: HTMLElement; content: HTMLElement };
  layers: Map<string, HighlightRange[]>;
  /** `content` 裡此刻的那幾塊，與它的子元素一一對應（見檔案頭「按行分塊」）。沒畫著時是空的。 */
  blocks: Block[];
  /** 圖層每變一次加一；與 `drawn` 對得上、文字也沒變時只重擺位置，不重建文字。 */
  version: number;
  /** 上一次畫出來的是哪一版圖層、哪一份文字。 */
  drawn?: { version: number; text: string };
  /** 這些圖層是給哪個檔案算的。當前路徑變了就整份作廢。 */
  path: string | null;
  frame?: number;
  shown: boolean;
}

/** 映象裡的一行。 */
interface Block {
  /** 這一行在全文裡的起點。 */
  start: number;
  /** 這一行的字，含行尾的 `\n`（最後一行沒有）。 */
  text: string;
  /** 落在這一行裡的那幾段，位置相對行首。 */
  marks: HighlightRange[];
  /** 字與那幾段拼成的指紋：與上一次的對得上就不重建。 */
  key: string;
  el?: HTMLElement;
}

const mirrors = new WeakMap<Pane, Mirror>();

// ---------------------------------------------------------------- 幀

/** 下一幀做。jsdom 沒有 rAF（測試裡），退回 16ms 的定時器。 */
export const nextFrame: (cb: () => void) => number =
  typeof requestAnimationFrame === 'function'
    ? (cb) => requestAnimationFrame(() => cb())
    : (cb) => window.setTimeout(cb, 16);

export const cancelFrame: (handle: number) => void =
  typeof cancelAnimationFrame === 'function'
    ? (handle) => cancelAnimationFrame(handle)
    : (handle) => window.clearTimeout(handle);

// ---------------------------------------------------------------- 對外

/** 換掉這塊編輯區某一層的高亮（當前檔案），當場重畫。空陣列等於清掉這一層。 */
export function setHighlights(pane: Pane, layer: string, ranges: HighlightRange[]): void {
  const m = ensureMirror(pane);
  if (m.path !== pane.activePath) {
    // 別的圖層還是給上一個檔案算的：一起作廢。
    m.layers.clear();
    m.path = pane.activePath;
  }
  if (ranges.length > 0) {
    m.layers.set(layer, ranges);
  } else {
    m.layers.delete(layer);
  }
  m.version++;
  render(m);
}

/** 清掉這塊編輯區的某一層，當場重畫。 */
export function clearHighlights(pane: Pane, layer: string): void {
  const m = mirrors.get(pane);
  if (m?.layers.delete(layer)) {
    m.version++;
    render(m);
  }
}

/**
 * 排版變了（外觀面板改了字型、字號、行距、版心，`look.ts` 調）：當場按 textarea 新的計算樣式重抄一遍、重擺位置。
 * 尺寸沒變的時候 `ResizeObserver` 不會叫，換了字號卻必須重排。沒造過映象的什麼都不做。
 */
export function relayoutMirror(pane: Pane): void {
  const m = mirrors.get(pane);
  if (m) {
    render(m);
  }
}

/**
 * 一處改動之後，原來的某個位置挪到了哪裡：改動之前的不動，之後的跟著平移，落在被換掉的那一段裡的
 * 挪到改動的起點。
 */
export function mapOffset(pos: number, change: TextChange): number {
  const removedEnd = change.at + change.removed.length;
  if (pos <= change.at) {
    return pos;
  }
  if (pos >= removedEnd) {
    return pos + change.inserted.length - change.removed.length;
  }
  return change.at;
}

/**
 * 量某個字（`area.value` 的下標）在 textarea 內容裡的位置：`top` 從內容頂上（含上內邊距）算，`left` 從內容左邊
 * （含左內邊距與版心留白）算，`height` 是那一行的高。textarea 藏著、文字超過 `HIGHLIGHT_LIMIT` 時量不了，返回 undefined。
 * 打字機滾動用 `top`，名詞補全的彈出框（`names.ts`）用 `left` / `top` / `height` 貼著游標擺。
 */
export function measureOffset(pane: Pane, offset: number): { top: number; left: number; height: number } | undefined {
  const area = pane.area;
  const text = area.value;
  if (tooLargeToHighlight(text) || !areaVisible(pane)) {
    return undefined;
  }
  const m = ensureMirror(pane);
  m.probe ??= createProbe(area);
  const { box, content } = m.probe;
  copyStyles(area, content);
  placeBox(area, box, content);

  const at = Math.max(0, Math.min(text.length, Math.floor(offset)));
  const lineEnd = text.indexOf('\n', at);
  const tailEnd = lineEnd === -1 ? text.length : lineEnd;
  // 把這個字本身包進標記裡（不另插字元，斷行機會與原文一樣）；行尾 / 文末沒有字可包，放一個零寬空格。
  const marker = document.createElement('span');
  const code = at < tailEnd ? text.codePointAt(at) : undefined;
  marker.textContent = code === undefined ? '​' : String.fromCodePoint(code);
  const markerEnd = code === undefined ? at : at + marker.textContent.length;
  // 這一行剩下的字也排上：英文長詞會整個折到下一行，只排到這個字為止會量錯。
  content.replaceChildren(text.slice(0, at), marker, text.slice(markerEnd, tailEnd));
  const pos = { top: marker.offsetTop, left: marker.offsetLeft, height: marker.offsetHeight };
  content.replaceChildren();
  return pos;
}

/**
 * 把 textarea 滾到讓這個字停在視口偏上三分之一處（查詢跳轉、審稿引文定位都用它）。
 * `onlyIfHidden`：這個字已經整行在視口裡就不動（查詢連按「下一個」時視口不亂跳）。
 * 量不了（文字太大）時按字元位置佔全文的比例估。
 */
export function scrollToOffset(pane: Pane, offset: number, opts: { onlyIfHidden?: boolean } = {}): void {
  const area = pane.area;
  const measured = measureOffset(pane, offset);
  const top = measured
    ? measured.top
    : (Math.max(0, offset) / Math.max(1, area.value.length)) * area.scrollHeight;
  const height = measured?.height ?? 0;
  if (opts.onlyIfHidden && top >= area.scrollTop && top + height <= area.scrollTop + area.clientHeight) {
    return;
  }
  area.scrollTop = Math.max(0, top - area.clientHeight / 3);
  const m = mirrors.get(pane);
  if (m?.shown) {
    syncScroll(m);
  }
}

// ---------------------------------------------------------------- 映象

function ensureMirror(pane: Pane): Mirror {
  const existing = mirrors.get(pane);
  if (existing) {
    return existing;
  }
  const area = pane.area;
  const box = document.createElement('div');
  box.className = 'ed-mirror hidden';
  box.setAttribute('aria-hidden', 'true');
  const content = document.createElement('div');
  content.className = 'ed-mirror-content';
  box.appendChild(content);
  area.parentElement?.insertBefore(box, area);

  const m: Mirror = {
    pane,
    box,
    content,
    layers: new Map(),
    blocks: [],
    version: 0,
    path: pane.activePath,
    shown: false,
  };
  mirrors.set(pane, m);

  area.addEventListener('scroll', () => {
    if (m.shown) {
      syncScroll(m);
    }
  });
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      if (m.shown) {
        placeBox(area, m.box, m.content);
        syncScroll(m);
      }
    }).observe(area);
  }
  subscribe();
  return m;
}

function createProbe(area: HTMLTextAreaElement): { box: HTMLElement; content: HTMLElement } {
  const box = document.createElement('div');
  box.className = 'ed-mirror ed-mirror-probe';
  box.setAttribute('aria-hidden', 'true');
  const content = document.createElement('div');
  content.className = 'ed-mirror-content';
  box.appendChild(content);
  area.parentElement?.insertBefore(box, area);
  return { box, content };
}

let subscribed = false;

function subscribe(): void {
  if (subscribed) {
    return;
  }
  subscribed = true;
  onEditorChange((ev) => {
    const m = mirrors.get(ev.pane);
    if (!m) {
      return;
    }
    if (ev.type === 'render') {
      if (ev.pane.activePath !== m.path) {
        m.layers.clear();
        m.version++;
        m.path = ev.pane.activePath;
      }
      // 切預覽、換檔案這些：當場按新狀態畫（藏起來的那一下不能晚一幀，否則底色會疊在預覽上閃一下）。
      render(m);
      return;
    }
    if (ev.file !== ev.pane.activeFile() || m.layers.size === 0) {
      return;
    }
    if (ev.change) {
      for (const [layer, ranges] of m.layers) {
        m.layers.set(layer, shiftRanges(ranges, ev.change));
      }
      m.version++;
    }
    schedule(m);
  });
}

/** 一處改動之後各段跟著平移；壓在改動上的那幾段丟掉（呼叫方下一幀會重算）。 */
function shiftRanges(ranges: HighlightRange[], change: TextChange): HighlightRange[] {
  const removedEnd = change.at + change.removed.length;
  const delta = change.inserted.length - change.removed.length;
  const out: HighlightRange[] = [];
  for (const r of ranges) {
    if (r.end <= change.at) {
      out.push(r);
    } else if (r.start >= removedEnd) {
      out.push({ start: r.start + delta, end: r.end + delta, cls: r.cls });
    }
  }
  return out;
}

function schedule(m: Mirror): void {
  if (m.frame === undefined) {
    m.frame = nextFrame(() => {
      m.frame = undefined;
      render(m);
    });
  }
}

function areaVisible(pane: Pane): boolean {
  return !!pane.activeFile() && !pane.isPreviewing() && !pane.area.classList.contains('hidden');
}

function render(m: Mirror): void {
  if (m.frame !== undefined) {
    cancelFrame(m.frame);
    m.frame = undefined;
  }
  const area = m.pane.area;
  const text = area.value;
  const ranges = [...m.layers.values()].flat();
  if (ranges.length === 0 || !areaVisible(m.pane) || tooLargeToHighlight(text)) {
    if (m.shown || m.content.firstChild) {
      m.content.replaceChildren();
      m.box.classList.add('hidden');
      m.shown = false;
    }
    m.blocks = [];
    m.drawn = undefined;
    return;
  }
  m.box.classList.remove('hidden');
  m.shown = true;
  copyStyles(area, m.content);
  placeBox(area, m.box, m.content);
  // 存檔、切標籤條之類的重畫：圖層與文字都沒變，只重擺位置（字型換了也由上面抄樣式跟上）。
  if (m.drawn?.version !== m.version || m.drawn.text !== text) {
    patchBlocks(m, splitBlocks(text, ranges));
    m.drawn = { version: m.version, text };
  }
  syncScroll(m);
}

/**
 * 文字按行切成塊，每段高亮落到它跨過的那幾行裡（跨行的切成幾截，各帶同樣的 class）。
 * 最後一塊是空行（文字以 `\n` 結尾）時照樣給一塊，畫的時候放零寬空格撐高。
 */
export function splitBlocks(text: string, ranges: readonly HighlightRange[]): Block[] {
  const blocks: Block[] = [];
  for (let pos = 0; ; ) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl + 1;
    blocks.push({ start: pos, text: text.slice(pos, end), marks: [], key: '' });
    if (nl === -1) {
      break;
    }
    pos = end;
  }
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end || (a.cls < b.cls ? -1 : a.cls > b.cls ? 1 : 0));
  for (const r of sorted) {
    const start = Math.max(0, Math.min(text.length, r.start));
    const end = Math.max(0, Math.min(text.length, r.end));
    if (end <= start) {
      continue;
    }
    // 起點落在哪一塊：按塊的起點二分。
    let lo = 0;
    let hi = blocks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (blocks[mid].start <= start) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    for (let i = lo; i < blocks.length && blocks[i].start < end; i++) {
      const b = blocks[i];
      const s = Math.max(start, b.start) - b.start;
      const e = Math.min(end, b.start + b.text.length) - b.start;
      if (e > s) {
        b.marks.push({ start: s, end: e, cls: r.cls });
      }
    }
  }
  for (const b of blocks) {
    b.key = b.marks.length === 0 ? b.text : `${b.text}\u0000${b.marks.map((r) => `${r.start},${r.end},${r.cls}`).join(';')}`;
  }
  return blocks;
}

/** 與上一次逐塊比：頭尾對得上的塊原樣留著（只更新起點），中間那一截換成新造的。 */
function patchBlocks(m: Mirror, next: Block[]): void {
  const old = m.blocks;
  let head = 0;
  while (head < old.length && head < next.length && old[head].key === next[head].key) {
    head++;
  }
  let tail = 0;
  while (
    tail < old.length - head &&
    tail < next.length - head &&
    old[old.length - 1 - tail].key === next[next.length - 1 - tail].key
  ) {
    tail++;
  }
  for (let i = head; i < old.length - tail; i++) {
    old[i].el?.remove();
  }
  const frag = document.createDocumentFragment();
  for (let i = 0; i < next.length; i++) {
    if (i < head) {
      next[i].el = old[i].el;
    } else if (i >= next.length - tail) {
      next[i].el = old[old.length - (next.length - i)].el;
    } else {
      const el = blockElement(next[i]);
      next[i].el = el;
      frag.appendChild(el);
    }
  }
  // 留著的塊萬一被別人動過（不該發生）：對不上就整份重來，不在錯的 DOM 上接著補。
  if (m.content.childElementCount !== head + tail) {
    m.content.replaceChildren();
    for (const b of next) {
      b.el = blockElement(b);
      frag.appendChild(b.el);
    }
    m.content.appendChild(frag);
  } else {
    m.content.insertBefore(frag, tail > 0 ? (old[old.length - tail].el ?? null) : null);
  }
  m.blocks = next;
}

function blockElement(b: Block): HTMLElement {
  const div = document.createElement('div');
  if (b.text === '') {
    div.textContent = '​';
  } else {
    div.appendChild(buildContent(b.text, b.marks));
  }
  return div;
}

/**
 * 滑鼠底下（`clientX` / `clientY`，視口座標）是 `layer` 這一層的哪一段。映象沒畫著、沒指著這一層的字時 undefined。
 * 先按縱向二分找到那一行的塊，再在塊裡量那幾個 `<mark>`（`getClientRects`，折行的標記每一截都量）。
 */
export function rangeAtPoint(pane: Pane, layer: string, clientX: number, clientY: number): HighlightRange | undefined {
  const m = mirrors.get(pane);
  const ranges = m?.layers.get(layer);
  if (!m?.shown || !ranges?.length || m.blocks.length === 0) {
    return undefined;
  }
  const box = m.box.getBoundingClientRect();
  if (clientX < box.left || clientX >= box.right || clientY < box.top || clientY >= box.bottom) {
    return undefined;
  }
  // 第一塊底邊在滑鼠下面的那一塊。
  let lo = 0;
  let hi = m.blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((m.blocks[mid].el?.getBoundingClientRect().bottom ?? 0) <= clientY) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const block = m.blocks[lo];
  if (!block?.el || block.marks.length === 0) {
    return undefined;
  }
  const classes = new Set(ranges.map((r) => r.cls));
  let offset = block.start;
  for (const node of Array.from(block.el.childNodes)) {
    const length = node.textContent?.length ?? 0;
    if (node instanceof HTMLElement && node.tagName === 'MARK' && Array.from(node.classList).some((c) => classes.has(c))) {
      for (const rect of Array.from(node.getClientRects())) {
        if (clientX >= rect.left && clientX < rect.right && clientY >= rect.top && clientY < rect.bottom) {
          const at = offset;
          return ranges.find((r) => r.start <= at && at < r.end);
        }
      }
    }
    offset += length;
  }
  return undefined;
}

/**
 * 一行的字切成段：沒有高亮的是文字節點，有的是 `<mark class="ed-hl 各層的 cls">`。幾層疊在一起的那一段
 * 帶上全部的 class。掃一遍邊界，O(n log n)。行尾的 `\n` 不另補零寬空格——末尾的空行是單獨一塊（`blockElement`）。
 */
function buildContent(text: string, ranges: HighlightRange[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  const events: { at: number; open: boolean; cls: string }[] = [];
  for (const r of ranges) {
    const start = Math.max(0, Math.min(text.length, r.start));
    const end = Math.max(0, Math.min(text.length, r.end));
    if (end > start) {
      events.push({ at: start, open: true, cls: r.cls }, { at: end, open: false, cls: r.cls });
    }
  }
  // 同一位置先收後開，相鄰兩段不會粘成一個 mark。
  events.sort((a, b) => a.at - b.at || Number(a.open) - Number(b.open));

  const active = new Map<string, number>();
  let pos = 0;
  const emit = (end: number) => {
    if (end <= pos) {
      return;
    }
    const piece = text.slice(pos, end);
    if (active.size === 0) {
      frag.appendChild(document.createTextNode(piece));
    } else {
      const mark = document.createElement('mark');
      mark.className = `ed-hl ${[...active.keys()].join(' ')}`;
      mark.textContent = piece;
      frag.appendChild(mark);
    }
    pos = end;
  };
  for (const ev of events) {
    emit(ev.at);
    const n = (active.get(ev.cls) ?? 0) + (ev.open ? 1 : -1);
    if (n > 0) {
      active.set(ev.cls, n);
    } else {
      active.delete(ev.cls);
    }
  }
  emit(text.length);
  return frag;
}

/** 只在值變了時才寫：寫同樣的值也可能讓瀏覽器把這一層的樣式標髒、整份重排，分塊就白做了。 */
function setStyle(target: HTMLElement, prop: string, value: string): void {
  if (target.style.getPropertyValue(prop) !== value) {
    target.style.setProperty(prop, value);
  }
}

function copyStyles(area: HTMLTextAreaElement, target: HTMLElement): void {
  const cs = getComputedStyle(area);
  for (const prop of COPIED_STYLES) {
    const value = cs.getPropertyValue(prop);
    if (value) {
      setStyle(target, prop, value);
    } else if (target.style.getPropertyValue(prop)) {
      target.style.removeProperty(prop);
    }
  }
}

/**
 * 把映象框擺到 textarea 的內容區上：左上角對齊它的邊框以內，寬度扣掉豎捲軸。
 * 寬度用 `getBoundingClientRect` 的小數值，整數的 `clientWidth` 在小數寬度的佈局裡會差半個畫素，
 * 正好卡在行尾的那個字就會折得不一樣。
 */
function placeBox(area: HTMLTextAreaElement, box: HTMLElement, content: HTMLElement): void {
  const parent = area.parentElement;
  const rect = area.getBoundingClientRect();
  const parentRect = parent?.getBoundingClientRect();
  const scrollbar = Math.max(0, area.offsetWidth - area.clientWidth - area.clientLeft * 2);
  const width = Math.max(0, rect.width - area.clientLeft * 2 - scrollbar);
  const height = Math.max(0, area.clientHeight);
  setStyle(box, 'left', `${rect.left - (parentRect?.left ?? 0) - (parent?.clientLeft ?? 0) + area.clientLeft}px`);
  setStyle(box, 'top', `${rect.top - (parentRect?.top ?? 0) - (parent?.clientTop ?? 0) + area.clientTop}px`);
  setStyle(box, 'width', `${width}px`);
  setStyle(box, 'height', `${height}px`);
  setStyle(content, 'width', `${width}px`);
}

function syncScroll(m: Mirror): void {
  const area = m.pane.area;
  m.content.style.transform = `translate(${-area.scrollLeft}px, ${-area.scrollTop}px)`;
}
