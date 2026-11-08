/**
 * 獨立版的彈窗（僅獨立版）。
 *
 * 外掛形態裡 `host.input/confirm/pick` 走 VS Code 原生的 QuickPick / InputBox；
 * 瀏覽器裡沒有那些，後端改推一條 `prompt`，由這裡變成一個 modal，
 * 使用者提交後回 `promptResult`。
 *
 * 複用 providerModal 的遮罩層，body 換成臨時內容——兩個彈窗不會同時出現
 * （這條訊息只在使用者觸發某個動作後到達），共用一層省一套樣式。
 */
import { el as mk, setHidden } from '../dom';
import type { CallChoice, OutMessage } from '../protocol';
import { primaryBtn, secondaryBtn } from './buttons';
import { buildCallPicker } from './callFields';
import { openHostFilePicker } from './folderPicker';
import { renderMerge } from './merge';
import { el } from './refs';
import { vscode } from './store';

type PromptMessage = Extract<OutMessage, { type: 'prompt' }>;

/** 開著的那個彈窗的「取消」。遮罩上的 ×、Esc 都走它；不是這裡開的就是 undefined。 */
let cancelActive: (() => void) | undefined;

export function renderPrompt(msg: PromptMessage): void {
  // 覆蓋審閱（五期 W11）有它自己的一整塊：兩個版本並排、逐段挑，塞不進這個小彈窗。
  if (msg.kind === 'merge') {
    renderMerge(msg);
    return;
  }
  // 選本機檔案：要逐層翻目錄，用的是「開啟資料夾」那個選擇器，不是這個小彈窗。
  if (msg.kind === 'file') {
    openHostFilePicker(msg.requestId, msg.title, msg.value ?? '', msg.options ?? []);
    return;
  }
  const body = el.providerModalBody;
  el.providerModalTitle.textContent = msg.title;
  body.innerHTML = '';

  const reply = (value?: string, choice?: CallChoice) => {
    if (cancelActive !== cancel) {
      return;
    }
    cancelActive = undefined;
    setHidden(el.providerModal, true);
    body.innerHTML = '';
    vscode.postMessage({ type: 'promptResult', requestId: msg.requestId, value, ...(choice ? { choice } : {}) });
  };
  // 與「取消」按鈕同一個回答：undefined。
  const cancel = () => reply(undefined);
  cancelActive = cancel;

  if (msg.message) {
    body.appendChild(mk('p', 'hint', msg.message));
  }

  if (msg.kind === 'confirm') {
    // 補充說明（Host.confirm 的 detail）：要調幾次、看哪幾章、會覆蓋什麼——作者點按鈕前要看得見。
    for (const line of (msg.value ?? '').split('\n').filter((l) => l.trim())) {
      body.appendChild(mk('p', 'hint prompt-detail', line));
    }
    // 調模型之前的那一問（Host.confirmCall）：按鈕上面多兩個下拉框，回答帶上作者的選擇。
    const picker = msg.call ? buildCallPicker(msg.call) : undefined;
    if (picker) {
      body.appendChild(picker.element);
    }
    // 一個 action 一顆按鈕（第一顆是主按鈕），回的是按鈕上的字。
    const actions = msg.actions?.length ? msg.actions : ['確定'];
    body.appendChild(
      actionRow(
        ...actions.map((a, i) => (i === 0 ? primaryBtn : secondaryBtn)(a, () => reply(a, picker?.choice()))),
        secondaryBtn('取消', cancel)
      )
    );
  } else if (msg.kind === 'pick') {
    body.appendChild(buildPickList(msg.options ?? [], reply));
    body.appendChild(actionRow(secondaryBtn('取消', () => reply(undefined))));
  } else {
    const input = buildInput(msg, reply);
    body.appendChild(input);
    body.appendChild(
      actionRow(primaryBtn('確定', () => reply(input.value)), secondaryBtn('取消', () => reply(undefined)))
    );
    input.focus();
  }

  setHidden(el.providerModal, false);
}

/**
 * 遮罩上的 ×、Esc（點空白不關）：彈窗是這裡開的才由這裡關，並且照「取消」回後端——
 * 只把遮罩藏起來的話，後端那一頭的 confirm / pick 會一直等著。服務商彈窗與表單各有自己的一套。
 */
export function installPrompt(): void {
  el.providerModalClose.addEventListener('click', () => cancelActive?.());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      cancelActive?.();
    }
  });
}

function buildPickList(options: string[], reply: (value?: string) => void): HTMLElement {
  const list = mk('div', 'picklist');
  for (const opt of options) {
    const btn = mk('button', 'pick-item', opt);
    btn.addEventListener('click', () => reply(opt));
    list.appendChild(btn);
  }
  return list;
}

function buildInput(
  msg: PromptMessage,
  reply: (value?: string) => void
): HTMLInputElement | HTMLTextAreaElement {
  const input = msg.multiline ? mk('textarea') : mk('input');
  if (input instanceof HTMLTextAreaElement) {
    input.rows = 6;
  } else if (msg.password) {
    input.type = 'password';
  }
  input.placeholder = msg.placeholder ?? '';
  input.value = msg.value ?? '';
  input.style.width = '100%';

  // 掛在 HTMLElement 上而不是那個聯合型別：兩種元素的 keydown 事件對映
  // 各是各的，聯合之後 TS 只認得回最寬的 Event。
  (input as HTMLElement).addEventListener('keydown', (e) => {
    const key = (e as KeyboardEvent).key;
    // 多行輸入裡 Enter 是換行，不能拿去提交。
    if (key === 'Enter' && !msg.multiline) {
      e.preventDefault();
      reply(input.value);
    }
    if (key === 'Escape') {
      reply(undefined);
    }
  });
  return input;
}

function actionRow(...buttons: HTMLElement[]): HTMLElement {
  const row = mk('div', 'actions');
  row.append(...buttons);
  return row;
}
