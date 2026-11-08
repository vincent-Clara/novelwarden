/**
 * 編輯器自己管的撤銷 / 重做。**每個開啟的檔案一份**（掛在 `OpenFile.history` 上）：
 * 切標籤不丟，關掉標籤隨之丟棄，重新整理頁面不恢復。
 *
 * ## 為什麼不用瀏覽器原生的撤銷
 *
 * 一塊編輯區的所有標籤共用一個 `<textarea>`，切標籤時整份換 `value`，原生撤銷記錄隨之作廢；
 * Tab 縮排、貼上兜底、「還原」這類程式改寫也會把它截斷。原生撤銷在不同瀏覽器 / 桌面 WebView
 * 裡跨元素、跨程式改寫的行為各不相同，這臺機器上測不了，jsdom 裡也測不了。所以自己記：
 * 結果確定，jsdom 裡能測。原生的那一份一律不用——`Ctrl+Z`、`beforeinput` 的 `historyUndo`、
 * 標題欄「編輯 → 撤銷」都攔下來走這裡（見 `pane.ts`）。
 *
 * ## 記的是差異，不是快照
 *
 * 一步 = 一串 `TextChange`（起點、刪掉的文字、插入的文字）+ 改之前與改之後的選區。
 * 一章幾萬字，500 步整份快照就是幾十 MB；差異通常只有幾個字。
 *
 * ## 什麼時候併成一步
 *
 * 只有 `record(..., { merge: true })` 記下的（`pane.ts` 裡的連續打字 / 連續刪除）才可能並：
 * 與上一步同一類（都是插入，或都是刪除）、位置緊挨著、間隔不超過 `MERGE_WINDOW_MS`，
 * 且這一下不含換行——敲回車單獨成一步，回車之後打的字另起一步。貼上、拖放、輸入法上屏、
 * 程式改寫各自一步，前後都不併；撤銷 / 重做之後接著打字也另起一步。
 * `join: true` 是程式改寫用的：把這一處並進剛記下的那一步（例如成對符號補的後半個），
 * 撤銷時兩處一起退。
 *
 * ## 純邏輯
 *
 * 不碰 DOM、不讀時鐘以外的任何東西：文字由呼叫方傳進來，返回新的文字與選區，由呼叫方寫回編輯區。
 * 撤銷前會核對「這一步插入的文字確實還在那個位置」，對不上說明有改動繞過了記賬，整份歷史作廢
 * （寧可退不回去，也不拿錯位的差異把正文改亂）。
 */

/** 選區：`start` ≤ `end`，按 UTF-16 下標算（與 textarea 的 `selectionStart` / `selectionEnd` 同一套）。 */
export interface TextSelection {
  start: number;
  end: number;
}

/** 一處改動：在 `at` 處把 `removed` 換成 `inserted`。`at` 按這一處改動**之前**的文字算。 */
export interface TextChange {
  at: number;
  removed: string;
  inserted: string;
}

export interface RecordOptions {
  /** 這是一下打字 / 刪除，可以並進上一步（規則見檔案頭）。 */
  merge?: boolean;
  /** 並進剛記下的那一步（程式改寫用）。上一步不存在、或中間撤銷 / 重做過時照常另起一步。 */
  join?: boolean;
  /** 現在幾點（毫秒）。測試用；預設 `Date.now()`。 */
  now?: number;
}

/** 撤銷 / 重做的結果：整份新文字與該落的選區。 */
export interface HistoryResult {
  text: string;
  selection: TextSelection;
}

/** 連續打字隔多久不再並進同一步。 */
export const MERGE_WINDOW_MS = 1000;
/** 一個檔案最多記多少步，再多就丟最早的。 */
export const HISTORY_LIMIT = 500;

interface Entry {
  /** 這一步的編號：一個 `EditHistory` 裡每記一步加一，並進來的不換號。 */
  id: number;
  /** 按發生順序。撤銷時倒著退。 */
  changes: TextChange[];
  before: TextSelection;
  after: TextSelection;
}

/** 還開著、可以繼續往裡並的那一步打字。 */
interface Typing {
  entry: Entry;
  kind: 'insert' | 'delete';
  time: number;
}

export class EditHistory {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private typing: Typing | undefined;
  /** 剛記下的那一步；`join` 只往它裡面並。撤銷 / 重做後清掉。 */
  private last: Entry | undefined;
  private seq = 0;

  constructor(private readonly limit = HISTORY_LIMIT) {}

  /**
   * 撤銷棧頂那一步的編號（並進去的不換號；沒有可撤銷的是 undefined）。碼字統計（`writingStats.ts` 的
   * `StepLedger`）按它認出撤銷 / 重做的是哪一步——撤銷自己打的字要減回去，撤銷一次貼上不該動碼字數。
   */
  get topId(): number | undefined {
    return this.undoStack[this.undoStack.length - 1]?.id;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** 撤銷棧有多少步（測試與診斷用）。 */
  get size(): number {
    return this.undoStack.length;
  }

  /** 記一處改動。`before` / `after` 是這處改動前後的選區。刪掉與插入相同（沒改）時什麼都不記。 */
  record(change: TextChange, before: TextSelection, after: TextSelection, opts: RecordOptions = {}): void {
    if (change.removed === change.inserted) {
      return;
    }
    const now = opts.now ?? Date.now();
    this.redoStack = [];
    const top = this.undoStack[this.undoStack.length - 1];

    if (opts.join && top && top === this.last) {
      top.changes.push({ ...change });
      top.after = { ...after };
      this.typing = undefined;
      return;
    }

    if (opts.merge && this.typing && this.typing.entry === top && this.mergeInto(this.typing, change, now)) {
      top.after = { ...after };
      this.typing.time = now;
      return;
    }

    const entry: Entry = { id: ++this.seq, changes: [{ ...change }], before: { ...before }, after: { ...after } };
    this.undoStack.push(entry);
    if (this.undoStack.length > this.limit) {
      this.undoStack.splice(0, this.undoStack.length - this.limit);
    }
    this.last = entry;
    const kind = opts.merge ? typingKind(change) : undefined;
    this.typing = kind ? { entry, kind, time: now } : undefined;
  }

  /** 撤銷一步。沒有可撤銷的、或歷史與 `text` 對不上（整份作廢）時返回 undefined。 */
  undo(text: string): HistoryResult | undefined {
    const entry = this.undoStack.pop();
    if (!entry) {
      return undefined;
    }
    let out = text;
    for (let i = entry.changes.length - 1; i >= 0; i--) {
      const c = entry.changes[i];
      if (out.slice(c.at, c.at + c.inserted.length) !== c.inserted) {
        this.clear();
        return undefined;
      }
      out = out.slice(0, c.at) + c.removed + out.slice(c.at + c.inserted.length);
    }
    this.redoStack.push(entry);
    this.typing = undefined;
    this.last = undefined;
    return { text: out, selection: { ...entry.before } };
  }

  /** 重做一步。沒有可重做的、或歷史與 `text` 對不上（整份作廢）時返回 undefined。 */
  redo(text: string): HistoryResult | undefined {
    const entry = this.redoStack.pop();
    if (!entry) {
      return undefined;
    }
    let out = text;
    for (const c of entry.changes) {
      if (out.slice(c.at, c.at + c.removed.length) !== c.removed) {
        this.clear();
        return undefined;
      }
      out = out.slice(0, c.at) + c.inserted + out.slice(c.at + c.removed.length);
    }
    this.undoStack.push(entry);
    this.typing = undefined;
    this.last = undefined;
    return { text: out, selection: { ...entry.after } };
  }

  /** 下一下打字不再並進上一步（游標被挪走、切了標籤之類）。 */
  seal(): void {
    this.typing = undefined;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.typing = undefined;
    this.last = undefined;
  }

  private mergeInto(typing: Typing, change: TextChange, now: number): boolean {
    if (now - typing.time > MERGE_WINDOW_MS || typing.entry.changes.length !== 1) {
      return false;
    }
    if (typingKind(change) !== typing.kind) {
      return false;
    }
    const prev = typing.entry.changes[0];
    if (typing.kind === 'insert') {
      // 只並純插入：接著上一步插入的末尾往下打。
      if (change.removed !== '' || change.at !== prev.at + prev.inserted.length) {
        return false;
      }
      prev.inserted += change.inserted;
      return true;
    }
    // 刪除：退格往前吃（這一處緊貼在上一處之前），或 Delete 往後吃（同一個位置）。
    if (change.at + change.removed.length === prev.at) {
      prev.at = change.at;
      prev.removed = change.removed + prev.removed;
      return true;
    }
    if (change.at === prev.at) {
      prev.removed += change.removed;
      return true;
    }
    return false;
  }
}

/**
 * 一下打字算哪一類。插入（含打字蓋掉選區的第一下）與刪除各算一類；帶換行的不算——
 * 回車、退格吃掉換行都單獨成一步，也不讓後面的字並進來。
 */
function typingKind(change: TextChange): 'insert' | 'delete' | undefined {
  if (change.inserted !== '') {
    return change.inserted.includes('\n') ? undefined : 'insert';
  }
  if (change.removed !== '') {
    return change.removed.includes('\n') ? undefined : 'delete';
  }
  return undefined;
}

/**
 * 兩份文字的差異：公共字首與公共字尾之間的那一段。相同時返回 undefined。
 *
 * `caret` 是改完之後的游標位置（可選）：打字與刪除時改動總是結束在游標處，拿它把有歧義的情形
 * 認對——在「aab」第一個 a 後面再打一個 a，單看前字尾會認成在第二個 a 後面插的。
 * 游標與前字尾對不上（例如程式改寫）時退回單看前字尾。不會把一個代理對（emoji 等）從中間切開。
 */
export function diffText(prev: string, next: string, caret?: number): TextChange | undefined {
  if (prev === next) {
    return undefined;
  }
  const max = Math.min(prev.length, next.length);

  let suffix = -1;
  if (caret !== undefined && caret >= 0 && caret <= next.length) {
    const s = next.length - caret;
    if (s <= prev.length && prev.endsWith(next.slice(caret))) {
      suffix = s;
    }
  }
  let prefix = 0;
  const prefixLimit = suffix >= 0 ? Math.min(prev.length, next.length) - suffix : max;
  while (prefix < prefixLimit && prev.charCodeAt(prefix) === next.charCodeAt(prefix)) {
    prefix++;
  }
  if (suffix < 0) {
    suffix = 0;
    while (
      suffix < max - prefix &&
      prev.charCodeAt(prev.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
    ) {
      suffix++;
    }
  }
  // 別把代理對切成兩半。
  if (prefix > 0 && isHighSurrogate(next.charCodeAt(prefix - 1))) {
    prefix--;
  }
  if (suffix > 0 && isLowSurrogate(next.charCodeAt(next.length - suffix))) {
    suffix--;
  }
  return {
    at: prefix,
    removed: prev.slice(prefix, prev.length - suffix),
    inserted: next.slice(prefix, next.length - suffix),
  };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
