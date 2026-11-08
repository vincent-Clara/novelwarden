/**
 * 外觀面板（「檢視 → 外觀設定…」）：正文字型、字號、行距、版心寬度、主題。改了**當場生效**，「恢復預設」把排版
 * 那四項放回預設（主題另記在 `novelforge.theme`，不跟著變 ⚑）。
 *
 * 寫法與樣式照 `dialog.ts`：DOM 現造現拆、頁面模板裡沒有它，面板外觀複用 `css/view/modal.css` 那一套
 * （`.modal` / `.modal-head` / `.modal-body` / `.modal-foot`，按鈕 `.primary` / `.secondary`），焦點進面板、
 * 關掉之後回到開啟之前的地方，`Esc` 關。**與 `dialog.ts` 不同的一處**：它不是模態的——改字號要一邊改一邊看正文，
 * 所以外面那一層不是 `.modal-overlay`（別的模組拿「有沒有 `.modal-overlay` 開著」判斷有沒有彈窗，`Ctrl+P` 會因此
 * 不開），而是透明、不攔點選的 `.ed-look-overlay`（只有面板本身接得住），面板靠右上，正文照樣能點、能滾、能打字；
 * 也不算「有對話方塊開著」（不攔自動儲存）。同一時刻只有一個，再開啟只是把焦點放回來。
 *
 * 段間距不單列一項（⚑）：textarea 畫不出段與段之間的額外間距，映象層又必須與它排得一模一樣；空行分段時段間距
 * 就是那一行空行（跟著行距變），段首縮排的格式本來就不空行。面板上用一句話說清楚。
 */
import { el } from '../dom';
import { currentLook, onLookChange, resetLook, setLook } from './look';
import { FONT_CHOICES, FONT_SIZE, LINE_HEIGHT, MEASURE, measureLabel, normalizeFont } from './lookCore';
import { THEMES, THEME_LABEL, currentTheme, setTheme } from './shell';
import { shortcutLabel } from './shortcuts';
import type { Theme } from './shell';

interface Panel {
  overlay: HTMLElement;
  box: HTMLElement;
  focusFirst(): void;
}

let panel: Panel | undefined;

/** 面板開著沒有。 */
export function isLookPanelOpen(): boolean {
  return !!panel;
}

/** 開啟外觀面板（已經開著就把焦點放回去）。 */
export function openLookPanel(): void {
  if (panel) {
    panel.focusFirst();
    return;
  }
  panel = buildPanel();
}

/** 關掉外觀面板。 */
export function closeLookPanel(): void {
  panel?.overlay.remove();
  panel = undefined;
}

function buildPanel(): Panel {
  const previous = document.activeElement as HTMLElement | null;
  const overlay = el('div', 'ed-look-overlay');
  const box = el('div', 'modal ed-look');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'false');
  const titleId = `edLookTitle${Date.now().toString(36)}`;
  box.setAttribute('aria-labelledby', titleId);

  const head = el('div', 'modal-head');
  const title = el('span', 'modal-title', '外觀');
  title.id = titleId;
  const x = el('button', 'icon-btn ed-look-x', '×');
  x.type = 'button';
  x.title = '關閉（Esc）';
  head.append(title, x);

  const body = el('div', 'modal-body');

  // ---- 正文字型
  const font = el('select', 'ed-look-font');
  for (const choice of FONT_CHOICES) {
    const opt = el('option', undefined, choice.label);
    opt.value = choice.id;
    // 下拉框裡每一項用它自己的字型寫（瀏覽器支援就看得出差別，不支援也無害）。
    opt.style.fontFamily = choice.stack;
    font.appendChild(opt);
  }
  font.addEventListener('change', () => setLook({ fontFamily: normalizeFont(font.value) }));

  // ---- 字號：− [15] px +
  const sizeDec = el('button', 'secondary ed-look-size-dec', '−');
  sizeDec.type = 'button';
  sizeDec.title = `縮小（編輯區裡 ${shortcutLabel('zoomOut')}）`;
  const size = el('input', 'ed-look-size');
  size.type = 'number';
  size.min = String(FONT_SIZE.min);
  size.max = String(FONT_SIZE.max);
  size.step = String(FONT_SIZE.step);
  const sizeInc = el('button', 'secondary ed-look-size-inc', '+');
  sizeInc.type = 'button';
  sizeInc.title = `放大（編輯區裡 ${shortcutLabel('zoomIn')}）`;
  sizeDec.addEventListener('click', () => setLook({ fontSize: currentLook().fontSize - FONT_SIZE.step }));
  sizeInc.addEventListener('click', () => setLook({ fontSize: currentLook().fontSize + FONT_SIZE.step }));
  // 打字時不跟（打「18」的那個「1」會被夾成 12）；按回車、離開輸入框時才認，認完寫回校驗後的值。清空了不算數。
  size.addEventListener('change', () => {
    const value = Number(size.value);
    if (size.value.trim() !== '' && Number.isFinite(value)) {
      setLook({ fontSize: value });
    }
    size.value = String(currentLook().fontSize);
  });
  const sizeRow = el('span', 'ed-look-inline');
  sizeRow.append(sizeDec, size, el('span', 'ed-look-unit', 'px'), sizeInc);

  // ---- 行距：滑塊 + 當前值
  const line = el('input', 'ed-look-line');
  line.type = 'range';
  line.min = String(LINE_HEIGHT.min);
  line.max = String(LINE_HEIGHT.max);
  line.step = String(LINE_HEIGHT.step);
  const lineValue = el('span', 'ed-look-unit ed-look-line-value');
  line.addEventListener('input', () => setLook({ lineHeight: Number(line.value) }));
  const lineRow = el('span', 'ed-look-inline');
  lineRow.append(line, lineValue);

  // ---- 版心寬度
  const measure = el('select', 'ed-look-measure');
  measure.addEventListener('change', () => setLook({ measure: Number(measure.value) }));

  // ---- 主題：三顆單選
  const themes = el('span', 'ed-look-inline ed-look-theme');
  themes.setAttribute('role', 'radiogroup');
  const themeName = `edLookTheme${Date.now().toString(36)}`;
  const themeInputs = THEMES.map((theme) => {
    const label = el('label', 'ed-look-choice');
    const input = el('input');
    input.type = 'radio';
    input.name = themeName;
    input.value = theme;
    input.addEventListener('change', () => {
      if (input.checked) {
        setTheme(theme as Theme);
      }
    });
    label.append(input, document.createTextNode(THEME_LABEL[theme]));
    themes.appendChild(label);
    return input;
  });

  body.append(
    row('正文字型', font),
    row('字號', sizeRow),
    row('行距', lineRow),
    row('版心寬度', measure, '寬屏時這一欄居中；「鋪滿」就是佔滿編輯區。'),
    el(
      'p',
      'hint ed-look-note',
      '段間距跟著分段格式走：空行分段時就是那一行空行（隨行距變），段首縮排不空行。'
    ),
    row('主題', themes, '護眼是米黃底色，整個介面一起換。')
  );

  const foot = el('div', 'modal-foot');
  const reset = el('button', 'secondary ed-look-reset', '恢復預設');
  reset.type = 'button';
  reset.title = '字型、字號、行距、版心回到預設（主題不變）';
  reset.addEventListener('click', () => resetLook());
  const close = el('button', 'primary ed-look-close', '關閉');
  close.type = 'button';
  foot.append(reset, el('span', 'spacer'), close);
  body.appendChild(foot);

  box.append(head, body);
  overlay.appendChild(box);

  const refresh = (): void => {
    const look = currentLook();
    font.value = look.fontFamily;
    if (document.activeElement !== size) {
      size.value = String(look.fontSize);
    }
    sizeDec.disabled = look.fontSize <= FONT_SIZE.min;
    sizeInc.disabled = look.fontSize >= FONT_SIZE.max;
    line.value = String(look.lineHeight);
    lineValue.textContent = look.lineHeight.toFixed(2);
    // 手改偏好寫了一個不在幾檔裡的寬度：也列出來，選中它。
    const values: number[] = [...MEASURE.presets];
    if (!values.includes(look.measure)) {
      values.push(look.measure);
      values.sort((a, b) => a - b);
    }
    measure.replaceChildren(
      ...values.map((v) => {
        const opt = el('option', undefined, measureLabel(v));
        opt.value = String(v);
        return opt;
      })
    );
    measure.value = String(look.measure);
    const theme = currentTheme();
    for (const input of themeInputs) {
      input.checked = input.value === theme;
    }
  };
  refresh();
  const unsubscribe = onLookChange(refresh);

  const onKey = (e: KeyboardEvent): void => {
    if (e.isComposing || e.keyCode === 229 || e.key !== 'Escape') {
      return;
    }
    // 面板開著時 Esc 只收面板（不連帶退出專注模式、不收查詢條）。
    e.preventDefault();
    e.stopPropagation();
    finish();
  };

  function finish(): void {
    document.removeEventListener('keydown', onKey, true);
    unsubscribe();
    closeLookPanel();
    if (previous?.isConnected) {
      previous.focus();
    }
  }

  x.addEventListener('click', finish);
  close.addEventListener('click', finish);
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
  font.focus();

  return { overlay, box, focusFirst: () => font.focus() };
}

/** 一行：左邊標籤，右邊控制元件，底下可選一行小字。控制元件沒有自己的 `<label>`，名字掛在 aria-label 上。 */
function row(label: string, control: HTMLElement, note?: string): HTMLElement {
  const wrap = el('div', 'ed-look-row');
  const name = el('span', 'ed-look-label', label);
  const right = el('div', 'ed-look-control');
  for (const field of control.matches('select, input') ? [control] : [...control.querySelectorAll('select, input:not([type="radio"])')]) {
    field.setAttribute('aria-label', label);
  }
  if (control.getAttribute('role') === 'radiogroup') {
    control.setAttribute('aria-label', label);
  }
  right.appendChild(control);
  if (note) {
    right.appendChild(el('span', 'hint ed-look-hint', note));
  }
  wrap.append(name, right);
  return wrap;
}
