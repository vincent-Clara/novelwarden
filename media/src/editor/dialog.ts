/**
 * 編輯器的頁內對話方塊：關標籤時問「儲存 / 不儲存 / 取消」、「還原」「用編輯器內容強制儲存」之前的確認、
 * 磁碟上沒了的檔案要不要在原路徑重建。編輯器裡**不再用 `window.confirm`**——它只有確定 / 取消兩顆、
 * 說不出「儲存」與「不儲存」的區別，還會把整個頁面（連同 WebSocket 的回執）卡住。`beforeunload` 那一問
 * 仍是瀏覽器原生的，頁面改不了。
 *
 * 外觀複用頁面上已有的彈窗那一套（`css/view/modal.css` 的 `.modal-overlay` / `.modal` / `.modal-head` /
 * `.modal-body` / `.modal-foot`，按鈕是 `.primary` / `.secondary` / `.danger`）。DOM 每次現造、關掉就拆，
 * 頁面模板裡沒有它。
 *
 * 鍵盤：焦點進對話方塊、預設落在主按鈕上；`Enter` 按下焦點所在的那顆（預設就是主按鈕），`Esc` 取消，
 * `Tab` / `Shift+Tab` 在幾顆按鈕之間繞、不出對話方塊。開著的時候 `Ctrl` / `Cmd` 組合鍵不往下傳——
 * 別在作者正決定要不要儲存的時候被 `Ctrl+S` / `Ctrl+W` 搶了先。關掉之後焦點回到開啟之前的地方。
 *
 * 同一時刻只開一個：後來的排隊，前一個答完才開。
 */
import { el } from '../dom';

export interface DialogButton<T extends string> {
  value: T;
  label: string;
  /** 主按鈕：`Enter` 的預設、開啟時焦點落在它上面。只該有一顆。 */
  primary?: boolean;
  /** 會丟東西的那一顆（放棄修改、覆蓋磁碟），畫成紅色。 */
  danger?: boolean;
}

export interface DialogSpec<T extends string> {
  title: string;
  message: string;
  /** 列在說明下面的幾項（批次關閉時是哪幾份）。`note` 跟在名字後面，`title` 是懸停提示。 */
  items?: { label: string; note?: string; title?: string }[];
  /** 列表下面再補一句（可選）。 */
  detail?: string;
  /** 從左到右擺；主按鈕放最右（離「確定」最近的那一側就是「繼續」）。 */
  buttons: DialogButton<T>[];
  /** `Esc` 回的值。 */
  cancel: T;
}

let open = 0;
let queue: Promise<unknown> = Promise.resolve();

/** 有對話方塊開著（或排著隊）。自動儲存據此先不動手——作者正在決定。 */
export function isDialogOpen(): boolean {
  return open > 0;
}

/** 開一個對話方塊，回作者按下的那顆按鈕的 `value`（`Esc` 回 `spec.cancel`）。沒有別的開著時當場就畫出來。 */
export function askDialog<T extends string>(spec: DialogSpec<T>): Promise<T> {
  open++;
  const run = open === 1 ? show(spec) : queue.then(() => show(spec));
  queue = run.catch(() => undefined);
  return run.finally(() => {
    open--;
  });
}

function show<T extends string>(spec: DialogSpec<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    const previous = document.activeElement as HTMLElement | null;
    const overlay = el('div', 'modal-overlay ed-dialog-overlay');
    const box = el('div', 'modal ed-dialog');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const titleId = `edDialogTitle${Date.now().toString(36)}`;
    const messageId = `${titleId}m`;
    box.setAttribute('aria-labelledby', titleId);
    box.setAttribute('aria-describedby', messageId);

    const head = el('div', 'modal-head');
    const title = el('span', 'modal-title', spec.title);
    title.id = titleId;
    head.appendChild(title);

    const body = el('div', 'modal-body');
    const message = el('p', 'ed-dialog-message', spec.message);
    message.id = messageId;
    body.appendChild(message);
    if (spec.items?.length) {
      const list = el('ul', 'ed-dialog-list');
      for (const item of spec.items) {
        const li = el('li', undefined, item.label);
        if (item.title) {
          li.title = item.title;
        }
        if (item.note) {
          li.appendChild(el('span', 'ed-dialog-note', item.note));
        }
        list.appendChild(li);
      }
      body.appendChild(list);
    }
    if (spec.detail) {
      body.appendChild(el('p', 'ed-dialog-detail hint', spec.detail));
    }

    const foot = el('div', 'modal-foot');
    const buttons = spec.buttons.map((b) => {
      const btn = el('button', b.danger ? 'danger' : b.primary ? 'primary' : 'secondary', b.label);
      btn.type = 'button';
      btn.dataset.value = b.value;
      btn.addEventListener('click', () => finish(b.value));
      foot.appendChild(btn);
      return btn;
    });
    body.appendChild(foot);
    box.append(head, body);
    overlay.appendChild(box);

    const primary = buttons[spec.buttons.findIndex((b) => b.primary)] ?? buttons[buttons.length - 1];

    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing || e.keyCode === 229) {
        return;
      }
      if (e.key === 'Escape') {
        stop(e);
        finish(spec.cancel);
      } else if (e.key === 'Enter') {
        stop(e);
        const focused = buttons.find((b) => b === document.activeElement) ?? primary;
        focused?.click();
      } else if (e.key === 'Tab') {
        stop(e);
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const step = e.shiftKey ? -1 : 1;
        const next = at < 0 ? primary : buttons[(at + step + buttons.length) % buttons.length];
        next?.focus();
      } else if (e.ctrlKey || e.metaKey) {
        stop(e);
      }
    };
    // 點到遮罩外面不算答（免得一失手關掉了還以為存了），焦點被點走了就拉回來。
    const keepFocus = (e: FocusEvent): void => {
      if (!box.contains(e.target as Node)) {
        primary?.focus();
      }
    };

    let done = false;
    function finish(value: T): void {
      if (done) {
        return;
      }
      done = true;
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', keepFocus, true);
      overlay.remove();
      if (previous?.isConnected) {
        previous.focus();
      }
      resolve(value);
    }

    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', keepFocus, true);
    document.body.appendChild(overlay);
    primary?.focus();
  });
}

function stop(e: Event): void {
  e.preventDefault();
  e.stopPropagation();
}
