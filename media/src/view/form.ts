/**
 * 通用表單彈窗（W3）。一句話、拆細綱兩個彈窗都是它。
 *
 * 複用 `providerModal` 那一層遮罩：兩種形態（外掛 webview 與獨立版）都裝配了它
 * （`shells/shared/panes.ts`），於是這裡一份程式碼兩邊都能用——不必像獨立版的
 * `prompt.ts` 那樣只在瀏覽器裡出現。幾個彈窗不會同時出現：它們都只在作者點了
 * 某個按鈕之後才開啟。
 *
 * 表單只收值、算說明、交出去；**發什麼訊息由呼叫方決定**（forms.ts）。前端無狀態那條
 * 基本盤不變：提交之後彈窗就關，結果隨後端下一次推送回來。
 */
import { el as mk, setHidden } from '../dom';
import { primaryBtn, secondaryBtn } from './buttons';
import { el } from './refs';

export type FormField =
  | {
      kind: 'textarea';
      key: string;
      label: string;
      value?: string;
      placeholder?: string;
      rows?: number;
      /** 空著不許提交。 */
      required?: boolean;
    }
  /**
   * 一行字（新建一本書的書名、作者、放在哪）。單按 Enter 就提交。`browse` 在框右邊多一顆按鈕（「選…」開目錄選擇器），
   * 選好了用 `set` 填回框裡。
   */
  | {
      kind: 'text';
      key: string;
      label: string;
      value?: string;
      placeholder?: string;
      required?: boolean;
      browse?: { label: string; run(current: string, set: (value: string) => void): void };
    }
  | { kind: 'number'; key: string; label: string; value?: number; min?: number; max?: number; step?: number }
  /** 幾選一（批次寫章的模式、這一次用哪個模型）。值是字串。 */
  | { kind: 'select'; key: string; label: string; value?: string; options: SelectOption[] };

/** 下拉框的一項。`group` 相同的相鄰幾項收進一個 `optgroup`（模型按服務商分組，同對話頁）。 */
export interface SelectOption {
  value: string;
  label: string;
  group?: string;
}

/** 一個下拉框。表單與獨立版確認框（prompt.ts）共用：同一種下拉框只有一種畫法。 */
export function buildSelect(options: SelectOption[], value?: string): HTMLSelectElement {
  const sel = mk('select');
  let group: HTMLOptGroupElement | undefined;
  for (const o of options) {
    if (o.group && o.group !== group?.label) {
      group = mk('optgroup');
      group.label = o.group;
      sel.appendChild(group);
    } else if (!o.group) {
      group = undefined;
    }
    const opt = mk('option', undefined, o.label);
    opt.value = o.value;
    (group ?? sel).appendChild(opt);
  }
  sel.value = value ?? options[0]?.value ?? '';
  return sel;
}

export type FormValues = Record<string, string | number>;

export interface FormSpec {
  title: string;
  /** 欄位上方的一句說明。 */
  lead?: string;
  /** 說明下面再列幾行小字（匯入寫好的書：開頭幾章、丟掉了什麼）。 */
  details?: string[];
  fields: FormField[];
  /**
   * 實時說明：任何一個值變了就重算（全書字數、跳過幾章、呼叫幾次）。
   * `ok: false` 時提交鍵禁用——說明裡寫著為什麼。
   */
  note?: (values: FormValues) => { text: string; ok?: boolean };
  submitLabel: string;
  /**
   * 提交要點兩下（按鈕文案兩段式，不疊彈窗）：返回第二下的字，第一下只把提交鍵換成它；
   * 返回 undefined 就一下提交。任何一個值改了都退回第一段。批次寫章「寫完即定稿」用它（W9）。
   */
  confirm?: (values: FormValues) => string | undefined;
  onSubmit: (values: FormValues) => void;
}

/** 當前開著的那一個。關掉時置空，遮罩上的 × / Esc 都據此判斷該不該由這裡管。 */
let active: { close: () => void } | null = null;

export function isFormOpen(): boolean {
  return active !== null;
}

export function closeForm(): void {
  active?.close();
}

export function openForm(spec: FormSpec): void {
  closeForm();
  const body = el.providerModalBody;
  el.providerModalTitle.textContent = spec.title;
  body.innerHTML = '';

  const form = mk('div', 'nf-form');
  if (spec.lead) {
    form.appendChild(mk('p', 'hint form-lead', spec.lead));
  }
  if (spec.details?.length) {
    const list = mk('ul', 'hint form-details');
    for (const line of spec.details) {
      list.appendChild(mk('li', undefined, line));
    }
    form.appendChild(list);
  }

  const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>();
  const grid = mk('div', 'grid');
  for (const f of spec.fields) {
    const label = mk('label', 'field');
    label.appendChild(mk('span', undefined, f.label));
    let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (f.kind === 'select') {
      input = buildSelect(f.options, f.value);
      grid.appendChild(label);
    } else if (f.kind === 'text') {
      const line = mk('input');
      line.type = 'text';
      line.placeholder = f.placeholder ?? '';
      line.value = f.value ?? '';
      line.spellcheck = false;
      input = line;
      // 一行字也佔滿一整行（路徑常常很長）；帶「選…」時框與按鈕並排。
      if (f.browse) {
        const row = mk('div', 'field-row');
        row.appendChild(line);
        const browse = f.browse;
        const btn = mk('button', 'chip-btn', browse.label);
        btn.type = 'button';
        btn.addEventListener('click', () =>
          browse.run(line.value, (v) => {
            line.value = v;
            line.dispatchEvent(new Event('input', { bubbles: true }));
          })
        );
        row.appendChild(btn);
        label.appendChild(row);
      }
      form.appendChild(label);
    } else if (f.kind === 'textarea') {
      const ta = mk('textarea');
      ta.rows = f.rows ?? 4;
      ta.placeholder = f.placeholder ?? '';
      ta.value = f.value ?? '';
      input = ta;
      // 多行文字佔滿一整行，數字框並排放在下面。
      form.appendChild(label);
    } else {
      const num = mk('input');
      num.type = 'number';
      if (f.min !== undefined) num.min = String(f.min);
      if (f.max !== undefined) num.max = String(f.max);
      if (f.step !== undefined) num.step = String(f.step);
      num.value = f.value !== undefined ? String(f.value) : '';
      input = num;
      grid.appendChild(label);
    }
    input.dataset.key = f.key;
    if (!input.parentElement) {
      label.appendChild(input);
    }
    inputs.set(f.key, input);
  }
  if (grid.childElementCount > 0) {
    form.appendChild(grid);
  }

  const note = mk('p', 'hint form-note');
  form.appendChild(note);

  const values = (): FormValues => {
    const out: FormValues = {};
    for (const f of spec.fields) {
      const raw = inputs.get(f.key)!.value;
      out[f.key] = f.kind === 'number' ? Math.floor(Number(raw)) : raw.trim();
    }
    return out;
  };
  const missing = (v: FormValues): string | undefined => {
    for (const f of spec.fields) {
      if ((f.kind === 'textarea' || f.kind === 'text') && f.required && !String(v[f.key]).trim()) {
        return `「${f.label}」還空著。`;
      }
      if (f.kind === 'number') {
        const n = Number(v[f.key]);
        if (!Number.isFinite(n) || (f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) {
          return `「${f.label}」要在 ${f.min ?? '—'}–${f.max ?? '—'} 之間。`;
        }
      }
    }
    return undefined;
  };

  /** 兩段式提交：第一下之後記著第二下的字（{@link FormSpec.confirm}）。 */
  let armed = false;
  const submit = primaryBtn(spec.submitLabel, () => trySubmit());
  const cancel = secondaryBtn('取消', () => close());
  const foot = mk('div', 'modal-foot');
  foot.append(cancel, submit);
  form.appendChild(foot);

  const refresh = (): boolean => {
    const v = values();
    const bad = missing(v);
    const computed = bad ? { text: bad, ok: false } : (spec.note?.(v) ?? { text: '', ok: true });
    note.textContent = computed.text;
    note.classList.toggle('is-error', computed.ok === false);
    submit.disabled = computed.ok === false;
    return computed.ok !== false;
  };
  const trySubmit = () => {
    if (!refresh()) {
      return;
    }
    const v = values();
    const second = spec.confirm?.(v);
    if (second && !armed) {
      armed = true;
      submit.textContent = second;
      submit.classList.add('is-armed');
      return;
    }
    close();
    spec.onSubmit(v);
  };
  const disarm = () => {
    if (armed) {
      armed = false;
      submit.textContent = spec.submitLabel;
      submit.classList.remove('is-armed');
    }
  };
  const close = () => {
    if (active !== handle) {
      return;
    }
    active = null;
    setHidden(el.providerModal, true);
    body.innerHTML = '';
  };
  const handle = { close };

  form.addEventListener('input', () => {
    disarm();
    refresh();
  });
  form.addEventListener('change', () => {
    disarm();
    refresh();
  });
  form.addEventListener('keydown', (e) => {
    // Ctrl/⌘+Enter 提交：多行文字裡單按 Enter 是換行。一行字的框裡單按 Enter 就提交（輸入法還在組字時那一下是選字）。
    const inLine = (e.target as HTMLElement | null)?.matches?.('input[type="text"]') === true;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || (inLine && !e.isComposing))) {
      e.preventDefault();
      trySubmit();
    }
  });

  body.appendChild(form);
  active = handle;
  refresh();
  setHidden(el.providerModal, false);
  (inputs.values().next().value as HTMLElement | undefined)?.focus();
}

/**
 * 遮罩上的 × 與 Esc：只在表單開著時由這裡關（點空白不關，免得誤觸丟了填到一半的內容）。服務商彈窗有它自己的一套
 * （settings/providerModal.ts），兩邊各自判斷「是不是我開的」，互不干擾。
 */
export function installForm(): void {
  el.providerModalClose.addEventListener('click', () => closeForm());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isFormOpen()) {
      closeForm();
    }
  });
}
