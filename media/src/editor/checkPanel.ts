/**
 * 寫作體檢面板（獨立版內建編輯器）：點狀態列「體檢」那一格彈出來的小面板——按類別列出命中的詞與次數，點一個詞依次跳到
 * 它在正文裡的位置並選中；敏感詞寫了替換詞的給「替換本處」「本檔案全部替換」；底下是「編輯敏感詞表…」。資料由 `check.ts`
 * 現算現給（`data()`），動作也交回它，這裡只管畫、開、關。
 *
 * 開合照碼字統計面板（`statsPanel.ts`）的樣子：
 *
 * - **不是遮罩**：掛在 `body` 上、`position: fixed`，貼著點開它的那一格往上彈。點面板外面（捕獲階段的 `mousedown`）、
 *   按 Esc、再點一下那一格都收起；正文照樣能接著打字——開著時數字跟著變。
 * - **同一時刻只有一個**：從另一塊編輯區的狀態列點開，換成那一塊的當前檔案。
 * - 面板上的按鈕按下滑鼠不奪焦點（跳過去之後焦點在正文裡，選區看得見）。
 * - 使用者內容（詞、替換詞）一律 `textContent`，不拼 HTML。
 */
import { el } from '../dom';
import { CHECK_CATEGORIES, CHECK_LABEL } from './checkCore';
import type { CheckCategory, CheckEntry, CheckResult } from './checkCore';
import { HIGHLIGHT_LIMIT } from './highlight';

export interface CheckPanelData {
  /** 點開它的那一塊編輯區當前開著的是正文（章節或草稿）。 */
  prose: boolean;
  result?: CheckResult;
  /** 正文超過高亮上限（30 萬字）：不畫高亮，面板照樣數。 */
  tooLarge?: boolean;
  /** 體檢高亮開著沒有。 */
  highlight: boolean;
  /** 面板上點過的那個詞跳到了第幾處。 */
  cursor?: { category: CheckCategory; term: string; index: number };
  sensitivePath: string;
  sensitiveExists: boolean;
  sensitiveBad: { line: number; reason: string }[];
  /** 收到過後端的詞表沒有（沒有時禁用詞與敏感詞還沒法查）。 */
  received: boolean;
}

export interface CheckPanelActions {
  jump(entry: CheckEntry): void;
  replaceOne(entry: CheckEntry): void;
  replaceAll(entry: CheckEntry): void;
  editList(): void;
}

interface Open {
  panel: HTMLElement;
  anchor: HTMLElement;
  data: () => CheckPanelData;
  actions: CheckPanelActions;
}

let open: Open | undefined;

/** 開著沒有、是從哪一格點開的。 */
export function checkPanelAnchor(): HTMLElement | undefined {
  return open?.anchor;
}

/** 點那一格：開著（且是這一格開的）就收起，否則開 / 換成這一格的。 */
export function toggleCheckPanel(anchor: HTMLElement, data: () => CheckPanelData, actions: CheckPanelActions): void {
  if (open?.anchor === anchor) {
    closeCheckPanel();
    return;
  }
  closeCheckPanel();
  const panel = el('div', 'ed-check-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '寫作體檢');
  // 面板上的按鈕按下滑鼠不奪焦點：跳過去之後焦點在正文裡，選區看得見；接著點「替換本處」時選區還在。
  panel.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement | null)?.closest('button')) {
      e.preventDefault();
    }
  });
  document.body.appendChild(panel);
  open = { panel, anchor, data, actions };
  anchor.setAttribute('aria-expanded', 'true');
  render();
  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
}

export function closeCheckPanel(): void {
  if (!open) {
    return;
  }
  open.panel.remove();
  open.anchor.setAttribute('aria-expanded', 'false');
  open = undefined;
  document.removeEventListener('mousedown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', place);
}

/** 結果變了（打字、詞表更新、跳了一處）：開著就重畫。 */
export function refreshCheckPanel(): void {
  if (open) {
    render();
  }
}

function onOutside(e: MouseEvent): void {
  const target = e.target as Node | null;
  if (!open || (target && (open.panel.contains(target) || open.anchor.contains(target)))) {
    return;
  }
  closeCheckPanel();
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && open) {
    e.stopPropagation();
    closeCheckPanel();
  }
}

function button(cls: string, text: string, title: string, run: () => void): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  b.title = title;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    run();
  });
  return b;
}

/** 每一類的標題後面那一句：詞從哪來、算幾個問題。 */
function sectionNote(category: CheckCategory, d: CheckPanelData, r: CheckResult): string {
  switch (category) {
    case 'sensitive':
      return `來自敏感詞表（${d.sensitivePath}），英文不分大小寫`;
    case 'banned':
      return '文風指南的禁用詞表、小說配置「全域要求」裡禁止的詞、古代題材的現代說法——與寫正文時寫完數的是同一份';
    case 'simile':
      return `全章 ${r.similes.total} 次，超出上限 ${r.similes.over} 次（上限 ${r.similes.limit} 次）`;
    case 'acronym':
      return '故事的年代用不上這種說法的話，改成那個年代的人會說的話（都市、科幻裡的 CEO、AI 是正常的）';
  }
}

function render(): void {
  if (!open) {
    return;
  }
  const d = open.data();
  const actions = open.actions;
  const parts: HTMLElement[] = [];

  const head = el('div', 'ed-check-head');
  head.appendChild(el('span', 'ed-check-title', '寫作體檢'));
  const r = d.result;
  head.appendChild(
    el('span', 'ed-check-aside', !d.prose ? '' : r && r.total > 0 ? `${r.total} 個問題` : '沒有發現問題')
  );
  parts.push(head);

  if (!d.prose || !r) {
    parts.push(el('div', 'ed-check-note', '體檢只看正文（章節與草稿）。當前標籤不是正文。'));
  } else {
    for (const category of CHECK_CATEGORIES) {
      const entries = r.entries.filter((e) => e.category === category);
      if (entries.length === 0) {
        continue;
      }
      const sec = el('div', `ed-check-sec ed-check-sec-${category}`);
      const h = el('div', 'ed-check-sec-head');
      h.appendChild(el('span', `ed-check-swatch ed-check-swatch-${category}`));
      h.appendChild(el('span', 'ed-check-sec-label', CHECK_LABEL[category]));
      const count = category === 'simile' ? `超出 ${r.counts.simile}` : `${r.counts[category]} 處`;
      h.appendChild(el('span', 'ed-check-sec-count', count));
      sec.appendChild(h);
      sec.appendChild(el('div', 'ed-check-note', sectionNote(category, d, r)));
      const list = el('div', 'ed-check-list');
      for (const entry of entries) {
        list.appendChild(row(entry, d, actions));
      }
      sec.appendChild(list);
      parts.push(sec);
    }
    if (r.total === 0) {
      parts.push(el('div', 'ed-check-note', '沒有敏感詞、禁用詞、英文縮寫，比喻詞也沒超過上限。'));
    }
    // 比喻詞沒超：不高亮、不算問題，但說一句用了幾次，免得人以為沒數。
    if (r.similes.over === 0 && r.similes.total > 0) {
      parts.push(el('div', 'ed-check-note', `比喻詞全章 ${r.similes.total} 次，沒超過上限 ${r.similes.limit} 次（超過了才標出來）。`));
    }
    if (d.tooLarge) {
      parts.push(el('div', 'ed-check-note', `這份正文超過 ${HIGHLIGHT_LIMIT / 10000} 萬字，正文裡不畫高亮（這裡照樣數，點詞照樣跳）。`));
    } else if (!d.highlight) {
      parts.push(el('div', 'ed-check-note', '正文裡的體檢高亮關著（「檢視 → 體檢高亮」開啟）。'));
    }
  }

  // 敏感詞表那幾句 + 「編輯敏感詞表…」。
  const foot = el('div', 'ed-check-foot');
  const notes = el('div', 'ed-check-rule');
  if (!d.received) {
    notes.appendChild(el('div', undefined, '還沒收到這本書的禁用詞與敏感詞表（沒開啟工程，或者還在讀）。'));
  } else if (!d.sensitiveExists) {
    notes.appendChild(el('div', undefined, '還沒有敏感詞表：點「編輯敏感詞表…」建一份（一行一個詞，「詞 => 替換詞」給出替換）。'));
  }
  if (d.sensitiveBad.length > 0) {
    const lines = d.sensitiveBad.map((b) => b.line);
    const shown = lines.slice(0, 8).join('、') + (lines.length > 8 ? ` 等 ${lines.length} 行` : '');
    const bad = el('div', 'ed-check-bad', `敏感詞表第 ${shown} 行沒看懂，已跳過。`);
    bad.title = d.sensitiveBad.map((b) => `第 ${b.line} 行：${b.reason}`).join('\n');
    notes.appendChild(bad);
  }
  notes.appendChild(el('div', undefined, '體檢不調模型，只是按詞表在正文裡找字；不會替你改字。'));
  foot.append(
    notes,
    button('chip-btn ed-check-edit', '編輯敏感詞表…', `開啟 ${d.sensitivePath}（沒有就新建一份帶說明的模板）`, () => actions.editList())
  );
  parts.push(foot);

  open.panel.replaceChildren(...parts);
  place();
}

function row(entry: CheckEntry, d: CheckPanelData, actions: CheckPanelActions): HTMLElement {
  const line = el('div', 'ed-check-row');
  const n = entry.offsets.length;
  const at = d.cursor && d.cursor.category === entry.category && d.cursor.term === entry.term ? d.cursor.index : -1;
  const word = button(
    'ed-check-word',
    '',
    n > 1 ? `跳到下一處並選中（一共 ${n} 處，到底了從頭再來）` : '跳到這一處並選中',
    () => actions.jump(entry)
  );
  word.append(el('span', 'ed-check-term', entry.term), el('span', 'ed-check-times', at >= 0 ? `${at + 1}/${n}` : `×${n}`));
  line.appendChild(word);
  if (entry.replacement) {
    line.appendChild(el('span', 'ed-check-arrow', '→'));
    line.appendChild(el('span', 'ed-check-replacement', entry.replacement));
    line.appendChild(
      button(
        'chip-btn ed-check-replace-one',
        '替換本處',
        '選中的正是這個詞的某一處時換掉它（一步撤銷），接著選中下一處；沒選中時先跳過去選中',
        () => actions.replaceOne(entry)
      )
    );
    line.appendChild(
      button(
        'chip-btn ed-check-replace-all',
        '全部替換',
        `把這份檔案裡的 ${n} 處都換掉（只記一步撤銷，Ctrl+Z 一下退回）。不動別的檔案`,
        () => actions.replaceAll(entry)
      )
    );
  }
  return line;
}

/** 貼著那一格往上彈，左右夾進視口。 */
function place(): void {
  if (!open) {
    return;
  }
  const rect = open.anchor.getBoundingClientRect();
  const width = open.panel.offsetWidth || 360;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  open.panel.style.left = `${Math.round(left)}px`;
  open.panel.style.bottom = `${Math.round(Math.max(8, window.innerHeight - rect.top + 6))}px`;
}
