/**
 * 跟著文字實時重算的高亮圖層共用的那一套：寫作體檢的 `check`（`check.ts`）與名詞高亮的 `names`（`nameMarks.ts`）。
 * 各層只說兩件事——這份檔案歸不歸它管（看後端給的 `kind`）、這份文字現在該畫哪幾段；什麼時候重算、改了字之後
 * 畫著的那幾段怎麼跟上、輸入法組字中途怎麼辦、長文字怎麼節流，都在這裡，兩層一個口徑。
 *
 * ## 幾萬字的章節每敲一下也不卡
 *
 * 1. 找詞由各層自己做（`locateTerms` 是一趟掃描，不是「詞數 × 全文」），各層按「查過的是哪一份文字」快取。
 * 2. 兩萬字以內（{@link LIVE_SYNC_LIMIT}）：改了字之後在**微任務**裡重算（`highlight.ts` 的同步訂閱先把各層平移完、
 *    壓在改動上的丟掉，之後才輪到這裡落新的一份；瀏覽器兩次繪製之間只畫一次）。更長的：至多每 300ms
 *    （{@link LIVE_RECHECK_MS}）重算一次（尾隨），其間已經畫著的那幾段跟著改動平移（`highlight.ts` 自己做），
 *    只是新冒出來的詞晚一點標出來。
 * 3. 重算的結果與映象層上此刻畫著的一模一樣（多數按鍵都是這樣）就不再畫一遍。
 * 4. **輸入法組字中途不重算**：拼音字母不該被當成英文詞，計數也不該跟著拼音跳；已經畫著的那幾段按組字前後的文字差
 *    挪到新位置（`diffChange`），不亂跳。上屏（`compositionend`）之後再算。撤銷 / 重做同樣先挪、再算。
 *
 * 映象層本身是各圖層共用的（`highlight.ts`，按行分塊、改一行只重排一行）；超過 30 萬字不畫，各層自己決定說不說。
 */
import { onEditorChange } from './api';
import type { OpenFile, Pane } from './api';
import { diffChange, sameRanges, shiftRanges } from './checkCore';
import { clearHighlights, setHighlights } from './highlight';
import type { HighlightRange } from './highlight';
import type { TextChange } from './history';
import { panes } from './store';

/** 這麼長以內的文字改了字就當場（微任務裡）重算；更長的節流。與碼字統計的 `SYNC_COUNT_LIMIT` 同一條線。 */
export const LIVE_SYNC_LIMIT = 20_000;
/** 長文字至多這麼久重算一次。 */
export const LIVE_RECHECK_MS = 300;

/** 編輯區裡顯示的那一份（textarea 把 `\r\n` 歸一成 `\n`，位置都按它算）。 */
export function shownText(file: OpenFile): string {
  return file.draft.includes('\r') ? file.draft.replace(/\r\n?/g, '\n') : file.draft;
}

export interface LiveLayerSpec {
  /** 高亮映象層上的圖層名。 */
  layer: string;
  /** 這份檔案歸不歸這一層管。不歸的不算、畫著的清掉。看後端給的 `kind`，前端不拿路徑猜。 */
  applies(file: OpenFile): boolean;
  /** 這份文字現在該畫的那幾段（只對歸它管的檔案調；不畫就給空陣列）。 */
  ranges(file: OpenFile, text: string): HighlightRange[];
  /** 每算完一次（含當前檔案不歸它管、什麼都不畫的時候）。 */
  checked?(pane: Pane): void;
  /** `render` 時檔案、種類、文字都沒變（儲存回執、切標籤條之類）。 */
  rendered?(pane: Pane): void;
}

export interface LiveLayer {
  /** 現在就按當前文字重算、重畫（不節流）。 */
  checkNow(pane: Pane): void;
  /** 兩塊編輯區都當場重算（詞表、偏好變了）。`force`：與畫著的一樣也重畫一遍。 */
  recheckAll(force?: boolean): void;
  /** 這塊編輯區正在輸入法組字。 */
  composing(pane: Pane): boolean;
}

interface PaneState {
  /** 下面幾樣是給哪個檔案記的。當前路徑變了就作廢（`highlight.ts` 換檔案時清掉所有圖層）。 */
  path: string | null;
  /** 映象層這一層上此刻畫著的那幾段（照 `highlight.ts` 的規則跟著改動平移）。 */
  painted: HighlightRange[];
  /** `painted` 對應的是哪一份文字。 */
  text: string;
  /** 映象層上那一份與 `painted` 對不上了（撤銷、組字中途、上屏：`highlight.ts` 沒平移或平移的不是這一份），下次必須重畫。 */
  dirty: boolean;
  /** 輸入法組字中。 */
  composing: boolean;
  /** 上一次算的時候當前檔案歸不歸這一層（儲存回執換了 `kind` 時據此重算）。 */
  applies: boolean;
  /** 長文字的節流。 */
  timer?: ReturnType<typeof setTimeout>;
  checkedAt: number;
}

export function createLiveLayer(spec: LiveLayerSpec): LiveLayer {
  const states = new Map<Pane, PaneState>();

  function stateOf(pane: Pane): PaneState {
    let st = states.get(pane);
    if (!st) {
      st = { path: pane.activePath, painted: [], text: '', dirty: false, composing: false, applies: false, checkedAt: 0 };
      states.set(pane, st);
    }
    return st;
  }

  function clearTimer(st: PaneState): void {
    if (st.timer !== undefined) {
      clearTimeout(st.timer);
      st.timer = undefined;
    }
  }

  /** 把 `want` 畫到這一層上（與此刻畫著的一樣、又沒弄髒就不畫）。 */
  function paint(pane: Pane, st: PaneState, want: HighlightRange[], text: string): void {
    st.text = text;
    if (!st.dirty && sameRanges(st.painted, want)) {
      return;
    }
    if (want.length > 0) {
      setHighlights(pane, spec.layer, want);
    } else {
      clearHighlights(pane, spec.layer);
    }
    st.painted = want;
    st.dirty = false;
  }

  function checkNow(pane: Pane): void {
    const st = stateOf(pane);
    clearTimer(st);
    st.checkedAt = Date.now();
    if (st.path !== pane.activePath) {
      resetFor(pane, st);
    }
    const file = pane.activeFile();
    st.applies = !!file && spec.applies(file);
    const text = file ? shownText(file) : '';
    paint(pane, st, file && st.applies ? spec.ranges(file, text) : [], text);
    spec.checked?.(pane);
  }

  /** 只把已經挪過位置的那幾段畫上去（組字中途、長文位元組流的空檔裡），不重算。 */
  function displayNow(pane: Pane): void {
    const st = stateOf(pane);
    if (st.dirty && st.path === pane.activePath) {
      paint(pane, st, st.painted, st.text);
    }
  }

  /** 換了檔案：映象層那邊已經（或馬上就會）清掉所有圖層。 */
  function resetFor(pane: Pane, st: PaneState): void {
    clearTimer(st);
    st.path = pane.activePath;
    st.painted = [];
    const file = pane.activeFile();
    st.text = file ? shownText(file) : '';
    st.dirty = false;
  }

  /** 同一輪裡攢著要做的：`check` 重算（蓋過 `display`）、`display` 只畫挪過位置的那幾段。 */
  const pending = new Map<Pane, 'check' | 'display'>();

  function soon(pane: Pane, kind: 'check' | 'display'): void {
    if (pending.size === 0) {
      queueMicrotask(() => {
        const list = [...pending];
        pending.clear();
        for (const [p, k] of list) {
          if (k === 'check') {
            checkNow(p);
          } else {
            displayNow(p);
          }
        }
      });
    }
    if (pending.get(pane) !== 'check') {
      pending.set(pane, kind);
    }
  }

  /** 改了字之後什麼時候重算（見檔案頭「幾萬字的章節每敲一下也不卡」）。 */
  function schedule(pane: Pane, st: PaneState, length: number): void {
    if (st.composing) {
      if (st.dirty) {
        soon(pane, 'display');
      }
      return;
    }
    if (length <= LIVE_SYNC_LIMIT) {
      soon(pane, 'check');
      return;
    }
    if (st.dirty) {
      soon(pane, 'display');
    }
    if (st.timer === undefined) {
      st.timer = setTimeout(
        () => {
          st.timer = undefined;
          checkNow(pane);
        },
        Math.max(0, st.checkedAt + LIVE_RECHECK_MS - Date.now())
      );
    }
  }

  /** 一處改動之後：先讓「此刻畫著的」跟上，再安排重算。 */
  function onEdit(pane: Pane, file: OpenFile, change: TextChange | undefined): void {
    const st = stateOf(pane);
    if (!spec.applies(file) && !st.applies && st.painted.length === 0) {
      // 不歸這一層管：什麼都沒畫，也不用算（幾 MB 的 json 每敲一下不必過這一趟）。
      return;
    }
    if (st.path !== pane.activePath) {
      resetFor(pane, st);
      schedule(pane, st, file.draft.length);
      return;
    }
    const after = shownText(file);
    if (
      change &&
      !st.composing &&
      st.text.length - change.removed.length + change.inserted.length === after.length &&
      st.text.slice(change.at, change.at + change.removed.length) === change.removed
    ) {
      // 與 highlight.ts 平移圖層同一條規則：它那一份與這裡記的仍然一樣，不必重畫。
      st.painted = shiftRanges(st.painted, change);
    } else {
      // 撤銷 / 重做、組字中途、上屏（改動是對著組字之前那一份算的）：按前後文字差挪，映象層那一份必須重畫。
      const d = diffChange(st.text, after);
      if (d) {
        st.painted = shiftRanges(st.painted, d);
      }
      st.dirty = true;
    }
    st.text = after;
    schedule(pane, st, after.length);
  }

  const hooked = new WeakSet<Pane>();

  function hook(pane: Pane): void {
    if (hooked.has(pane)) {
      return;
    }
    hooked.add(pane);
    pane.area.addEventListener('compositionstart', () => {
      stateOf(pane).composing = true;
    });
    // pane.ts 自己的 compositionend 先跑（它先掛），上屏那一下的 `edit` 已經發過了；這裡收尾、安排重算。
    pane.area.addEventListener('compositionend', () => {
      const st = stateOf(pane);
      st.composing = false;
      const file = pane.activeFile();
      if (file) {
        schedule(pane, st, file.draft.length);
      }
    });
  }

  onEditorChange((ev) => {
    if (ev.type === 'render') {
      const pane = ev.pane;
      hook(pane);
      const st = stateOf(pane);
      const file = pane.activeFile();
      if (st.path !== pane.activePath) {
        // 換了檔案、關了標籤：當場按新檔案畫（各層有快取的不重找）。
        resetFor(pane, st);
        checkNow(pane);
      } else if ((!!file && spec.applies(file)) !== st.applies) {
        // 同一個檔案換了 `kind`（儲存回執帶來的）：歸不歸這一層變了，重算。
        checkNow(pane);
      } else if (file && st.text !== shownText(file)) {
        // 同一個檔案、文字卻換了（沒改過的標籤被磁碟上的新版換掉）：先挪、再算。
        onEdit(pane, file, undefined);
      } else {
        spec.rendered?.(pane);
      }
      return;
    }
    if (ev.file === ev.pane.activeFile()) {
      onEdit(ev.pane, ev.file, ev.change);
    }
  });

  for (const pane of Object.values(panes)) {
    if (pane) {
      hook(pane);
    }
  }

  return {
    checkNow,
    recheckAll(force = false) {
      for (const pane of Object.values(panes)) {
        if (pane) {
          if (force) {
            stateOf(pane).dirty = true;
          }
          checkNow(pane);
        }
      }
    },
    composing: (pane) => stateOf(pane).composing,
  };
}
