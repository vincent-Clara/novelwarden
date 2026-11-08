/**
 * 外觀與專注的取值表、上下限與校驗（純函式、零 DOM、零 import）。
 *
 * 這幾項都按瀏覽器記在 `novelforge.editor.prefs` 裡（與成對符號、自動儲存同一處，見 `paragraphState.ts`），
 * 作者會手改 localStorage、舊版本寫下的值也可能不認識——**讀回來的壞值一律回落預設、越界的夾進上下限**，
 * 口徑只在這裡寫一份（`tests/unit/editor/lookCore.test.js` 釘著）。`look.ts` 只管把結果寫成 CSS 變數，
 * `focus.ts` 只管開關。
 *
 * ## 排版引數怎麼落到頁面上
 *
 * 字型、字號、行距、版心寬度是一組 CSS 變數（`LOOK_VARS`），寫在 `<html>` 上；編輯區的 textarea、高亮映象層、
 * 預覽三處在 `css/standalone/look.css` 裡**共用同一條規則**讀它們——別給哪一處單寫一份，映象層與 textarea 排得
 * 不一樣，查詢高亮就對不齊了（`media/README.md`「映象層與 textarea 排版必須完全一致」）。
 */

/** 正文字型。只列字型族名，不打包字型檔案：作者機器上沒有的那幾個名字瀏覽器會跳過，落到最後的通用族上。 */
export type FontId = 'song' | 'hei' | 'kai' | 'fangsong' | 'system';

export interface FontChoice {
  id: FontId;
  label: string;
  /** `font-family` 的值。固定的一張表，不收作者輸入（寫進 CSS 變數的只會是這幾串）。 */
  stack: string;
}

/** 順序即面板上的順序。宋體是預設（與改造前編輯區的正文字型同一串）。 */
export const FONT_CHOICES: readonly FontChoice[] = [
  {
    id: 'song',
    label: '宋體（襯線）',
    stack: "'Noto Serif CJK SC', 'Source Han Serif SC', 'Songti SC', 'STSong', 'SimSun', Georgia, serif",
  },
  {
    id: 'hei',
    label: '黑體（無襯線）',
    stack:
      "'Noto Sans CJK SC', 'Source Han Sans SC', 'PingFang SC', 'Microsoft YaHei', 'Hiragino Sans GB', 'WenQuanYi Micro Hei', sans-serif",
  },
  {
    id: 'kai',
    label: '楷體',
    stack: "'LXGW WenKai', 'Kaiti SC', 'STKaiti', 'KaiTi', 'AR PL UKai CN', serif",
  },
  {
    id: 'fangsong',
    label: '仿宋',
    stack: "'FangSong', 'STFangsong', 'FangSong_GB2312', 'Fangsong SC', serif",
  },
  {
    id: 'system',
    label: '跟隨系統',
    stack: "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei UI', 'PingFang SC', sans-serif",
  },
];

/** 字號（px）。快捷鍵 Ctrl+= / Ctrl+- 一下一步。 */
export const FONT_SIZE = { min: 12, max: 32, step: 1, fallback: 15 } as const;
/** 行距（倍數）。空行分段時段與段之間那一行空行也跟著它變。 */
export const LINE_HEIGHT = { min: 1.3, max: 3, step: 0.05, fallback: 1.95 } as const;
/**
 * 版心寬度：一行最多幾個字（按全形字寬算），寬屏時那一欄居中。`0` 是「鋪滿」——預設，與改造前一樣。
 * `presets` 是面板下拉框裡的幾檔；手改成別的整數也認（夾進上下限）。
 */
export const MEASURE = { min: 20, max: 80, fallback: 0, presets: [0, 30, 35, 40, 45, 50, 60, 70] } as const;

export interface LookPrefs {
  fontFamily: FontId;
  /** px */
  fontSize: number;
  /** 倍數 */
  lineHeight: number;
  /** 一行最多幾個字；0 = 鋪滿 */
  measure: number;
}

export const DEFAULT_LOOK: Readonly<LookPrefs> = Object.freeze({
  fontFamily: 'song',
  fontSize: FONT_SIZE.fallback,
  lineHeight: LINE_HEIGHT.fallback,
  measure: MEASURE.fallback,
});

/** 偏好裡這幾項的鍵名（與成對符號、自動儲存平鋪在同一個物件裡）。 */
export const LOOK_KEYS: readonly (keyof LookPrefs)[] = ['fontFamily', 'fontSize', 'lineHeight', 'measure'];

/** 排版那組 CSS 變數的名字。textarea、映象層、預覽在 `look.css` 裡讀同一組。 */
export const LOOK_VARS = {
  fontFamily: '--nf-ed-font-family',
  fontSize: '--nf-ed-font-size',
  lineHeight: '--nf-ed-line-height',
  measure: '--nf-ed-measure',
} as const;

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 按步長取整（避免 0.1 + 0.2 那種尾巴寫進偏好），再夾進上下限。 */
function snap(v: number, min: number, max: number, step: number): number {
  const stepped = Math.round(v / step) * step;
  const fixed = Number(stepped.toFixed(4));
  return Math.min(max, Math.max(min, fixed));
}

/** 字號：不是有限數字回落預設，越界夾進 12–32，取整到 1px。 */
export function clampFontSize(v: unknown): number {
  return isNumber(v) ? snap(v, FONT_SIZE.min, FONT_SIZE.max, FONT_SIZE.step) : FONT_SIZE.fallback;
}

/** 行距：不是有限數字回落預設，越界夾進 1.3–3，取整到 0.05。 */
export function clampLineHeight(v: unknown): number {
  return isNumber(v) ? snap(v, LINE_HEIGHT.min, LINE_HEIGHT.max, LINE_HEIGHT.step) : LINE_HEIGHT.fallback;
}

/** 版心：不是有限數字回落預設（鋪滿）；≤ 0 是鋪滿；其餘取整、夾進 20–80 字。 */
export function clampMeasure(v: unknown): number {
  if (!isNumber(v)) {
    return MEASURE.fallback;
  }
  if (v <= 0) {
    return 0;
  }
  return Math.min(MEASURE.max, Math.max(MEASURE.min, Math.round(v)));
}

/** 字型：認不出的回落宋體。 */
export function normalizeFont(v: unknown): FontId {
  return FONT_CHOICES.some((f) => f.id === v) ? (v as FontId) : DEFAULT_LOOK.fontFamily;
}

/** 從整份偏好（一個隨便什麼都可能的物件）裡讀出外觀那幾項，壞值逐項回落。 */
export function normalizeLook(raw: unknown): LookPrefs {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    fontFamily: normalizeFont(r.fontFamily),
    fontSize: clampFontSize(r.fontSize),
    lineHeight: clampLineHeight(r.lineHeight),
    measure: clampMeasure(r.measure),
  };
}

/** 兩份外觀一樣不一樣。 */
export function sameLook(a: LookPrefs, b: LookPrefs): boolean {
  return LOOK_KEYS.every((k) => a[k] === b[k]);
}

/** 放大 / 縮小一檔（到頭了原樣返回）。 */
export function stepFontSize(size: number, dir: 1 | -1): number {
  return clampFontSize(clampFontSize(size) + dir * FONT_SIZE.step);
}

export function fontStack(id: FontId): string {
  return (FONT_CHOICES.find((f) => f.id === id) ?? FONT_CHOICES[0]).stack;
}

/**
 * 寫到 `<html>` 上的那組變數。版心按 `em` 寫（全形字寬 = 字號），在用到它的元素上按那裡的字號解析——
 * textarea、映象層、預覽字號相同，算出來就相同。鋪滿寫 `100cqi`（整個編輯區寬），居中那一算式就落回最小內邊距。
 */
export function lookVars(look: LookPrefs): Record<string, string> {
  return {
    [LOOK_VARS.fontFamily]: fontStack(look.fontFamily),
    [LOOK_VARS.fontSize]: `${look.fontSize}px`,
    [LOOK_VARS.lineHeight]: String(look.lineHeight),
    [LOOK_VARS.measure]: look.measure > 0 ? `${look.measure}em` : '100cqi',
  };
}

/** 版心那一檔怎麼說（面板下拉框、選單提示）。 */
export function measureLabel(measure: number): string {
  return measure > 0 ? `一行最多 ${measure} 字` : '鋪滿';
}

// ---------------------------------------------------------------- 專注

/** 專注那三個開關（全屏不記：瀏覽器每次載入都從視窗模式開始，記了也恢復不了）。 */
export interface FocusPrefs {
  focusMode: boolean;
  typewriter: boolean;
  paragraphFocus: boolean;
}

export const FOCUS_KEYS: readonly (keyof FocusPrefs)[] = ['focusMode', 'typewriter', 'paragraphFocus'];

/** 三個開關預設都關，只認明明白白的 `true`（與自動儲存同一個口徑）。 */
export function normalizeFocus(raw: unknown): FocusPrefs {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    focusMode: r.focusMode === true,
    typewriter: r.typewriter === true,
    paragraphFocus: r.paragraphFocus === true,
  };
}
