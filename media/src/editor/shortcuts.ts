/**
 * 快捷鍵的**唯一一張表**：每個鍵做什麼、歸哪一組、在哪兒管用。純資料加幾個純函式，零 DOM、零副作用——
 * 標題欄選單（view.js）也打包它：選單上那一格 `kbd` 的字、「幫助 → 快捷鍵一覽」面板（`shortcutsPanel.ts`）、
 * 各處提示裡寫的鍵，都從這裡取（`shortcutLabel` / `formatKeys`），不各寫一份。
 *
 * **新增快捷鍵必須登記在這裡**。各模組的按鍵處理照舊自己判斷按鍵（`find.ts`、`lines.ts`……），但
 * `tests/dom/standalone/shortcuts.test.js` 守著兩頭：表裡每一條都真的有人處理（照它的生效範圍擺好場面按一下，
 * 得被接走），反過來在正文裡、頁面上、對話輸入框裡把幾百種按法挨個按一遍，被接走的每一下都得在表裡查得到。
 * README「內建編輯器」那張快捷鍵表也由測試對著這張表核（`tests/unit/editor/shortcuts.test.js`）。
 *
 * ## 鍵怎麼寫
 *
 * `Mod+Shift+F` 這樣，最後一段是鍵，前面是修飾鍵：
 * - `Mod`：Windows / Linux 上的 Ctrl、Mac 上的 ⌘。編輯器裡認它的地方一律是 `e.ctrlKey || e.metaKey`。
 * - `Ctrl`：兩邊都是 Control 那顆（只有「重做」的 `Ctrl+Y` 這樣寫——Mac 上 ⌘Y 不是重做）。
 * - `Alt`（Mac 上 ⌥）、`Shift`。
 * - 鍵：字母、數字、標點照寫；`Up` / `Down` / `Left` / `Right`、`Enter`、`Tab`、`Escape`、`PageUp` / `PageDown`、
 *   `F1`…`F12`，加號寫 `Plus`。
 *
 * 顯示按平臺：Windows / Linux 寫 `Ctrl+Shift+F`，Mac 寫 `⇧⌘F`（修飾鍵順序 ⌃⌥⇧⌘，與系統選單一樣）。
 */

/** 分組，按面板與 README 裡從上到下的順序。 */
export const SHORTCUT_GROUPS = ['檔案與標籤', '編輯', '段落', '查詢替換', '名詞補全', '檢視', '面板與幫助', '檔案頁'] as const;
export type ShortcutGroup = (typeof SHORTCUT_GROUPS)[number];

/**
 * 在哪兒管用：
 * - `global`：哪裡都行，焦點在左邊的對話輸入框裡也認。
 * - `workbench`：編輯區裡或頁面上——焦點在對話輸入框這類別的輸入框裡時不攔，留給瀏覽器。
 * - `editor`：游標在編輯區的正文裡（`api.ts` 的 `addKeyHandler`，組字中途不收）。
 * - `context`：某個面板、浮層開著時，或某個頁面上（`where` 寫是哪兒）。
 */
export type ShortcutScope = 'global' | 'workbench' | 'editor' | 'context';

export interface Shortcut {
  id: string;
  /** 鍵（寫法見檔案頭）。幾種按法都算的列在一起，面板上用「 / 」隔開，選單上只寫第一種（Mac 上優先不用 Control 的那一種）。 */
  keys: readonly string[];
  /** 也認、但不必寫出來的按法（例如字號放大的 `Ctrl++`、小鍵盤的加號）。 */
  also?: readonly string[];
  /** 做什麼，一句話。 */
  label: string;
  group: ShortcutGroup;
  scope: ShortcutScope;
  /** 生效範圍的說法。`context` 必須給；別的預設按 `scope` 說（`scopeText`）。 */
  where?: string;
  /** 補一句：瀏覽器攔不住、只對哪些檔案…… */
  note?: string;
  /** 標題欄選單裡寫著這個鍵的那一項（`檔案 › 儲存`）。測試按它核對選單上的字。 */
  menu?: string;
  /** 瀏覽器自己做的（剪下、複製、貼上、全選）：列出來是為了選單與一覽，編輯器不攔。 */
  native?: boolean;
}

/** 瀏覽器攔不住、在瀏覽器裡會被拿去幹別的的說法（⚑ 鍵沒換，桌面版裡照樣管用）。 */
const BROWSER_TAKES = '瀏覽器多半攔不住';
/** 剪下、複製、貼上、全選是瀏覽器自己的，哪個輸入框裡都一樣。 */
const NATIVE_WHERE = '能打字的地方（瀏覽器自己的）';

export const SHORTCUTS = [
  // ---------------------------------------------------------------- 檔案與標籤
  { id: 'quickOpen', keys: ['Mod+P'], label: '轉到一章或一個檔案（「轉到…」）', group: '檔案與標籤', scope: 'global', menu: '檔案 › 轉到…' },
  { id: 'save', keys: ['Mod+S'], label: '儲存當前這一份', group: '檔案與標籤', scope: 'global', menu: '檔案 › 儲存' },
  {
    id: 'closeTab',
    keys: ['Mod+W'],
    label: '關掉當前標籤（有沒儲存的修改先問）',
    group: '檔案與標籤',
    scope: 'global',
    note: `${BROWSER_TAKES}：在瀏覽器裡會關掉整個網頁（有沒儲存的內容時瀏覽器先問一句）；桌面版裡管用`,
  },
  {
    id: 'newFile',
    keys: ['Mod+N'],
    label: '新建檔案',
    group: '檔案與標籤',
    scope: 'global',
    note: `${BROWSER_TAKES}：在瀏覽器裡會開一個新視窗；桌面版裡管用`,
    menu: '檔案 › 新建檔案',
  },
  { id: 'openFolder', keys: ['Mod+O'], label: '開啟資料夾…', group: '檔案與標籤', scope: 'global', menu: '檔案 › 開啟資料夾…' },
  { id: 'prevChapter', keys: ['Alt+PageUp'], label: '上一章', group: '檔案與標籤', scope: 'workbench', note: '正開著某一章的正文或細綱時' },
  { id: 'nextChapter', keys: ['Alt+PageDown'], label: '下一章', group: '檔案與標籤', scope: 'workbench', note: '正開著某一章的正文或細綱時' },

  // ---------------------------------------------------------------- 編輯
  { id: 'undo', keys: ['Mod+Z'], label: '撤銷（每個檔案各記各的）', group: '編輯', scope: 'editor', menu: '編輯 › 撤銷' },
  { id: 'redo', keys: ['Ctrl+Y', 'Mod+Shift+Z'], label: '重做', group: '編輯', scope: 'editor', menu: '編輯 › 重做' },
  { id: 'cut', keys: ['Mod+X'], label: '剪下', group: '編輯', scope: 'editor', where: NATIVE_WHERE, native: true, menu: '編輯 › 剪下' },
  { id: 'copy', keys: ['Mod+C'], label: '複製', group: '編輯', scope: 'editor', where: NATIVE_WHERE, native: true, menu: '編輯 › 複製' },
  { id: 'paste', keys: ['Mod+V'], label: '貼上', group: '編輯', scope: 'editor', where: NATIVE_WHERE, native: true, menu: '編輯 › 貼上' },
  { id: 'selectAll', keys: ['Mod+A'], label: '全選', group: '編輯', scope: 'editor', where: NATIVE_WHERE, native: true, menu: '編輯 › 全選' },
  {
    id: 'indent',
    keys: ['Tab'],
    label: '縮排；選中幾行時每行行首加一級',
    group: '編輯',
    scope: 'editor',
    note: '正文一級是兩個全形空格，其餘檔案兩個半形空格',
  },
  { id: 'outdent', keys: ['Shift+Tab'], label: '去掉一級縮排', group: '編輯', scope: 'editor' },
  {
    id: 'newParagraph',
    keys: ['Enter'],
    label: '另起一段',
    group: '編輯',
    scope: 'editor',
    note: '正文按這本書的分段格式（空一行或段首縮排）；Markdown 列表接著往下寫',
  },
  { id: 'lineBreak', keys: ['Shift+Enter'], label: '只換行、不縮排', group: '編輯', scope: 'editor' },

  // ---------------------------------------------------------------- 段落
  { id: 'moveParagraph', keys: ['Alt+Up', 'Alt+Down'], label: '這一段與上 / 下一段對調', group: '段落', scope: 'editor' },
  { id: 'copyParagraph', keys: ['Shift+Alt+Down', 'Shift+Alt+Up'], label: '把這一段複製一份放在下面 / 上面', group: '段落', scope: 'editor' },
  { id: 'deleteParagraph', keys: ['Mod+Shift+K'], label: '刪掉這一段', group: '段落', scope: 'editor' },
  { id: 'paragraphBelow', keys: ['Mod+Enter'], label: '不管游標在哪，在這一段下面另起一段', group: '段落', scope: 'editor' },

  // ---------------------------------------------------------------- 查詢替換
  {
    id: 'find',
    keys: ['Mod+F'],
    label: '查詢（這一份檔案）',
    group: '查詢替換',
    scope: 'workbench',
    note: '焦點在左邊對話輸入框裡時還是瀏覽器自己的查詢',
    menu: '編輯 › 查詢',
  },
  { id: 'replace', keys: ['Mod+H'], label: '替換（這一份檔案）', group: '查詢替換', scope: 'workbench', menu: '編輯 › 替換' },
  { id: 'findNext', keys: ['F3'], label: '下一處', group: '查詢替換', scope: 'workbench' },
  { id: 'findPrev', keys: ['Shift+F3'], label: '上一處', group: '查詢替換', scope: 'workbench' },
  { id: 'findBoxNext', keys: ['Enter'], label: '下一處', group: '查詢替換', scope: 'context', where: '查詢條的查詢框裡' },
  { id: 'findBoxPrev', keys: ['Shift+Enter'], label: '上一處', group: '查詢替換', scope: 'context', where: '查詢條的查詢框裡' },
  { id: 'replaceBoxEnter', keys: ['Enter'], label: '替換當前這一處、跳到下一處', group: '查詢替換', scope: 'context', where: '查詢條的替換框裡' },
  { id: 'bookFind', keys: ['Mod+Shift+F'], label: '全書查詢', group: '查詢替換', scope: 'global', menu: '編輯 › 全書查詢替換…' },
  { id: 'bookReplace', keys: ['Mod+Shift+H'], label: '全書替換（游標進替換框）', group: '查詢替換', scope: 'global' },

  // ---------------------------------------------------------------- 名詞補全
  {
    id: 'names',
    keys: ['Alt+/'],
    label: '名詞補全：列出角色名、地名這些名字',
    group: '名詞補全',
    scope: 'editor',
    note: '只在正文、草稿、細綱、角色卡、設定、情節大綱、敘事線裡',
    menu: '檢視 › 名詞補全',
  },
  { id: 'namesPick', keys: ['Up', 'Down'], label: '選上一個 / 下一個名字', group: '名詞補全', scope: 'context', where: '補全框開著時' },
  {
    id: 'namesAccept',
    keys: ['Enter', 'Tab'],
    label: '插入選中的名字',
    group: '名詞補全',
    scope: 'context',
    where: '補全框開著時',
    note: '邊打邊彈出來的框只認 Tab，回車照常換段',
  },

  // ---------------------------------------------------------------- 檢視
  {
    id: 'preview',
    keys: ['Mod+Shift+V'],
    label: '預覽 / 編輯切換',
    group: '檢視',
    scope: 'workbench',
    note: '只對 Markdown（.md）檔案；別的檔案照常是貼上',
  },
  {
    id: 'zoomIn',
    keys: ['Mod+='],
    also: ['Mod+Plus'],
    label: '正文字號放大',
    group: '檢視',
    scope: 'editor',
    note: '游標不在正文裡時是瀏覽器自己的整頁縮放',
    menu: '檢視 › 放大字號',
  },
  { id: 'zoomOut', keys: ['Mod+-'], label: '正文字號縮小', group: '檢視', scope: 'editor', menu: '檢視 › 縮小字號' },
  { id: 'zoomReset', keys: ['Mod+0'], label: '正文字號還原', group: '檢視', scope: 'editor', menu: '檢視 › 還原字號' },
  { id: 'focusMode', keys: ['F8'], label: '專注模式：進去 / 出來', group: '檢視', scope: 'global', menu: '檢視 › 專注模式' },
  {
    id: 'focusExit',
    keys: ['Escape'],
    label: '退出專注模式',
    group: '檢視',
    scope: 'context',
    where: '專注模式裡',
    note: '查詢條、面板、選單開著時先收它們',
  },

  // ---------------------------------------------------------------- 面板與幫助
  { id: 'shortcuts', keys: ['Mod+/'], label: '快捷鍵一覽（就是這一張）', group: '面板與幫助', scope: 'global', menu: '幫助 › 快捷鍵一覽' },
  { id: 'quickOpenPick', keys: ['Up', 'Down'], label: '選上一條 / 下一條', group: '面板與幫助', scope: 'context', where: '「轉到…」面板裡' },
  { id: 'quickOpenOpen', keys: ['Enter'], label: '開啟選中的那一條', group: '面板與幫助', scope: 'context', where: '「轉到…」面板裡' },
  { id: 'quickOpenBeside', keys: ['Mod+Enter'], label: '開在右邊第二塊編輯區', group: '面板與幫助', scope: 'context', where: '「轉到…」面板裡' },
  {
    id: 'closePanel',
    keys: ['Escape'],
    label: '收起面板、彈窗或選單',
    group: '面板與幫助',
    scope: 'context',
    where: '面板、彈窗、選單開著時',
    note: '查詢條、全書查詢替換、補全框、碼字統計、體檢、外觀面板、對話方塊都是',
  },

  // ---------------------------------------------------------------- 檔案頁
  { id: 'filesCopy', keys: ['Mod+C'], label: '複製選中的檔案或資料夾', group: '檔案頁', scope: 'context', where: '「檔案」頁的樹上選中一行時' },
  { id: 'filesCut', keys: ['Mod+X'], label: '剪下選中的檔案或資料夾', group: '檔案頁', scope: 'context', where: '「檔案」頁的樹上選中一行時' },
  { id: 'filesPaste', keys: ['Mod+V'], label: '貼上到選中的資料夾', group: '檔案頁', scope: 'context', where: '「檔案」頁的樹上選中一行時' },
] as const satisfies readonly Shortcut[];

export type ShortcutId = (typeof SHORTCUTS)[number]['id'];

const BY_ID = new Map<string, Shortcut>(SHORTCUTS.map((s) => [s.id, s]));

/** 按 id 取一條。 */
export function shortcutById(id: ShortcutId): Shortcut {
  return BY_ID.get(id)!;
}

// ---------------------------------------------------------------- 解析

/** 一種按法拆開之後。`key` 是規範名（字母小寫、`Up`、`Enter`、`Plus`……）。 */
export interface KeyCombo {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

/** `Mod+Shift+F` → `{ mod, shift, key: 'f' }`。最後一段是鍵（`Mod++` 不這樣寫，加號寫 `Plus`）。 */
export function parseKey(spec: string): KeyCombo {
  const parts = spec.split('+');
  const key = parts.pop() ?? '';
  const mods = new Set(parts);
  return {
    mod: mods.has('Mod'),
    ctrl: mods.has('Ctrl'),
    alt: mods.has('Alt'),
    shift: mods.has('Shift'),
    key: key.length === 1 ? key.toLowerCase() : key,
  };
}

/** 一下按鍵裡與「是哪個鍵」有關的那幾樣（`KeyboardEvent` 本身就滿足）。 */
export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** 按著 Alt（Mac 上 ⌥）時 `key` 是打出來的那個特殊字元（⌥/ 是 `÷`），這幾個鍵改看 `code`。 */
const CODE_KEY: Record<string, string> = { Slash: '/', Minus: '-', Equal: '=', Comma: ',', Period: '.' };

function keyFromCode(code: string | undefined): string | undefined {
  if (!code) {
    return undefined;
  }
  const letter = /^Key([A-Z])$/.exec(code) ?? /^Digit(\d)$/.exec(code);
  return letter ? letter[1].toLowerCase() : CODE_KEY[code];
}

/** `KeyboardEvent.key` 換成表裡的規範名。 */
export function keyName(e: Pick<KeyLike, 'key' | 'code' | 'altKey'>): string {
  if (e.altKey) {
    const fromCode = keyFromCode(e.code);
    if (fromCode) {
      return fromCode;
    }
  }
  switch (e.key) {
    case 'ArrowUp':
      return 'Up';
    case 'ArrowDown':
      return 'Down';
    case 'ArrowLeft':
      return 'Left';
    case 'ArrowRight':
      return 'Right';
    case 'Esc':
      return 'Escape';
    case ' ':
      return 'Space';
    case '+':
      return 'Plus';
  }
  if (e.code === 'NumpadAdd') {
    return 'Plus';
  }
  return e.key.length === 1 ? e.key.toLowerCase() : e.key;
}

/**
 * 這一下是不是這種按法。`Mod` 認 Ctrl 或 ⌘（兩邊編輯器裡都這樣認），沒寫 `Mod` / `Ctrl` 的兩樣都不許按；
 * Alt、Shift 按寫的來（加號本身就是 Shift 打出來的，`Plus` 不看 Shift）。
 */
export function matchesKey(e: KeyLike, spec: string): boolean {
  const want = parseKey(spec);
  if (keyName(e) !== want.key) {
    return false;
  }
  const ctrlOrMeta = e.ctrlKey || e.metaKey;
  if (want.mod) {
    if (!ctrlOrMeta) {
      return false;
    }
  } else if (want.ctrl) {
    if (!e.ctrlKey || e.metaKey) {
      return false;
    }
  } else if (ctrlOrMeta) {
    return false;
  }
  if (e.altKey !== want.alt) {
    return false;
  }
  return want.key === 'Plus' || e.shiftKey === want.shift;
}

/** 這一下是不是這一條（`keys` 與 `also` 裡任一種按法）。 */
export function matchesShortcut(e: KeyLike, id: ShortcutId): boolean {
  const s = shortcutById(id);
  return [...s.keys, ...(s.also ?? [])].some((spec) => matchesKey(e, spec));
}

// ---------------------------------------------------------------- 顯示

/** 認不認作 Mac（顯示 ⌘ / ⌥）。看 `navigator`，拿不到就當不是。 */
export function isMacPlatform(
  nav: { platform?: string; userAgent?: string; userAgentData?: { platform?: string } } | undefined = typeof navigator ===
  'undefined'
    ? undefined
    : (navigator as { platform?: string; userAgent?: string; userAgentData?: { platform?: string } })
): boolean {
  const platform = nav?.userAgentData?.platform || nav?.platform || '';
  if (platform) {
    return /mac|iphone|ipad|ipod/i.test(platform);
  }
  return /Mac OS X|Macintosh/i.test(nav?.userAgent ?? '');
}

const KEY_TEXT: Record<string, string> = {
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Escape: 'Esc',
  Plus: '+',
  Space: '空格',
};

function keyText(key: string, mac: boolean): string {
  if (mac && key === 'Enter') {
    return '↩';
  }
  return KEY_TEXT[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

/** 一種按法怎麼寫：Windows / Linux `Ctrl+Shift+F`，Mac `⇧⌘F`。 */
export function formatKey(spec: string, mac: boolean): string {
  const k = parseKey(spec);
  if (mac) {
    return `${k.ctrl ? '⌃' : ''}${k.alt ? '⌥' : ''}${k.shift ? '⇧' : ''}${k.mod ? '⌘' : ''}${keyText(k.key, true)}`;
  }
  const parts: string[] = [];
  if (k.mod || k.ctrl) {
    parts.push('Ctrl');
  }
  if (k.shift) {
    parts.push('Shift');
  }
  if (k.alt) {
    parts.push('Alt');
  }
  parts.push(keyText(k.key, false));
  return parts.join('+');
}

/** 一條的全部按法，「 / 」隔開（面板與 README 裡那樣寫）。 */
export function formatKeys(s: Shortcut, mac: boolean): string {
  return s.keys.map((spec) => formatKey(spec, mac)).join(' / ');
}

/** 選單上寫哪一種：第一種；Mac 上優先不用 Control 的那一種（Mac 上重做寫 ⇧⌘Z，不寫 ⌃Y）。 */
export function primaryKey(s: Shortcut, mac: boolean): string {
  return (mac && s.keys.find((spec) => !parseKey(spec).ctrl)) || s.keys[0];
}

/** 選單與提示裡寫的那一個鍵（按當前平臺）。 */
export function shortcutLabel(id: ShortcutId, mac = isMacPlatform()): string {
  return formatKey(primaryKey(shortcutById(id), mac), mac);
}

const SCOPE_TEXT: Record<Exclude<ShortcutScope, 'context'>, string> = {
  global: '哪裡都行',
  workbench: '編輯區裡或頁面上',
  editor: '游標在編輯區裡',
};

/** 在哪兒管用，面板與 README 裡那一格。 */
export function scopeText(s: Shortcut): string {
  return s.where ?? (s.scope === 'context' ? '' : SCOPE_TEXT[s.scope]);
}

/** 篩選：做什麼、在哪兒、補充說明、分組、按法（兩種平臺的寫法都認），不分大小寫，空白隔開的幾段都得有。 */
export function filterShortcuts(list: readonly Shortcut[], query: string): Shortcut[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [...list];
  }
  return list.filter((s) => {
    const hay = [s.label, scopeText(s), s.note ?? '', s.group, formatKeys(s, false), formatKeys(s, true)].join('\n').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** 按分組排好（分組的順序是 `SHORTCUT_GROUPS`，組裡按表裡的順序），空的組不給。 */
export function groupShortcuts(list: readonly Shortcut[]): { group: ShortcutGroup; items: Shortcut[] }[] {
  return SHORTCUT_GROUPS.map((group) => ({ group, items: list.filter((s) => s.group === group) })).filter(
    (g) => g.items.length > 0
  );
}
