/**
 * `/` 命令面板：當前階段能下的其它命令。
 *
 * ## 為什麼是命令而不是一排按鈕
 *
 * 改造前這裡是七個平鋪的能力按鈕（討論/擴充套件/挑刺/檢查/拆分/生成/改寫）。
 * 問題不是不好看，是**七個等重的按鈕看不出該點哪個**——而在任何一個具體
 * 時刻，作者真正要按的只有一個（狀態機算得出來，見 pipeline.ts 的下一步條），
 * 其餘六個是「偶爾要用」。偶爾要用的東西該收進命令面板。
 *
 * 而且那七個按鈕是**單選器**：點「生成」什麼都不發生，還得再輸入一句話
 * 才能傳送。挑一個命令與執行它之間隔著一次多餘的操作。
 *
 * ## 互動：命令就打在輸入框裡（Cursor / Claude Code 那一套）
 *
 * 從前面板是「輸入框上方另起一塊」，`/` 由 keydown 攔下來**不落進輸入框**，
 * 過濾串自己攢在模組變數裡。那等於在輸入框旁邊又造了一個隱形的輸入框：
 * 游標在哪、退格退的是誰，全靠這裡的狀態猜；輸入法（中文候選框）打的字更是
 * 一個都收不到。
 *
 * 現在改成：
 * - **`/` 就是輸入框裡的一個普通字元**，面板只是浮在它上方的候選列表；
 * - 過濾串**從輸入框的值算出來**（`slashQuery`），不再自己攢——中文、輸入法、
 *   退格、貼上、Ctrl+A 全都自動對；
 * - 面板只接管 ↑↓ / Enter / Tab / Esc 四種鍵，可列印字元一律放行給輸入框。
 *
 * 判據是「整個輸入框只有一個 `/詞`」（`/^\/\S*$/`）：`/` 在中文正文裡是普通
 * 字元（日期、比值、網址），只要後面跟了空格或前面有別的字，就不是在下命令。
 *
 * 命令表來自 core 的 `commandsFor(stage, target)`（零 import 的純函式，前端直接打包）。目標是單條設定時
 * 「生成」叫「展開這條設定」（`/展開`）。
 * 前端不自己維護一份——否則介面上會出現一個後端不認的命令，點了什麼都不發生。
 */
import { el as mk, clear, closestFrom } from '../dom';
import { commandsFor } from '../protocol';
import type { StageCommand } from '../protocol';
import { el } from './refs';
import { store } from './store';

/** 當前開啟的面板。同時只允許一個。 */
let panel: HTMLElement | null = null;
let onPick: (cmd: StageCommand) => void = () => {};
let items: StageCommand[] = [];
let active = 0;
/**
 * Esc 關過之後不該馬上彈回來。
 *
 * 輸入框裡那個 `/` 還在（它是使用者的字，我們不替他刪），而面板是由輸入框的值
 * 驅動的——不記一筆「他已經關過了」，下一次按鍵又會把它彈出來。
 */
let dismissed = false;

/**
 * 輸入框當下的命令查詢串；不在下命令時為 null。
 *
 * 整個值必須只有一個 `/詞`。這條判據同時管著「要不要開面板」與「挑中命令後
 * 要不要把這幾個字從輸入框裡抹掉」，所以只在這裡寫一次。
 */
export function slashQuery(value: string): string | null {
  const m = /^\/(\S*)$/.exec(value);
  return m ? m[1] : null;
}

export function bindCommandPick(fn: (cmd: StageCommand) => void): void {
  onPick = fn;
}

export function isCommandPaletteOpen(): boolean {
  return !!panel;
}

export function closeCommands(): void {
  panel?.remove();
  panel = null;
  active = 0;
  el.cmdBtn.classList.remove('active');
}

/**
 * 輸入框的值變了：該開就開、該關就關、開著就重畫。
 *
 * 由 composer 的 `input` 監聽轉進來。**面板的開合是輸入框內容的函式**，
 * 不是一串各自為政的 keydown 分支。
 */
export function syncCommandPalette(): void {
  const q = slashQuery(el.input.value);
  if (q === null) {
    // 已經不是在下命令了（刪掉了 `/`、或往後打了別的字）——順手把
    // 「關過了」這一筆也清掉，下次打 `/` 才還能彈。
    dismissed = false;
    closeCommands();
    return;
  }
  if (dismissed) {
    return;
  }
  if (panel) {
    redraw();
  } else {
    openCommands();
  }
}

/**
 * 「/ 命令」按鈕：開則關，關則開。
 *
 * 輸入框為空時順手把 `/` 打進去——按鈕和鍵盤走的是同一條路，介面上不該
 * 出現「點按鈕彈出來的面板」和「打 / 彈出來的面板」兩種東西。輸入框裡已經
 * 有別的字時**不動那些字**：他正寫著補充要求，挑個命令帶上就好。
 */
export function toggleCommands(): void {
  if (panel) {
    dismissed = true;
    closeCommands();
    return;
  }
  dismissed = false;
  if (el.input.value === '') {
    el.input.value = '/';
  }
  el.input.focus();
  openCommands();
}

export function openCommands(): void {
  closeCommands();
  if (commandsFor(store.session.stage, store.session.target).length === 0) {
    return;
  }

  panel = mk('div', 'cmd-panel');
  panel.setAttribute('role', 'listbox');
  // 掛在輸入框那一格里（它是 position: relative），面板從輸入框上沿往上浮。
  // 命令的字留在輸入框裡，候選浮在正上方——視線不用離開正在打字的地方。
  el.composerInput.appendChild(panel);
  el.cmdBtn.classList.add('active');
  redraw();

  // 點別處收起。延到下一拍再掛，否則「點按鈕開啟」這一次點選自己就把它關了。
  setTimeout(() => document.addEventListener('click', onDocClick), 0);
}

function onDocClick(e: MouseEvent): void {
  if (!panel) {
    document.removeEventListener('click', onDocClick);
    return;
  }
  if (!panel.contains(e.target as Node) && !closestFrom(e.target, '#cmdBtn')) {
    dismissed = true;
    closeCommands();
    document.removeEventListener('click', onDocClick);
  }
}

function redraw(): void {
  if (!panel) {
    return;
  }
  clear(panel);

  const filter = slashQuery(el.input.value) ?? '';
  items = matching(commandsFor(store.session.stage, store.session.target), filter);
  active = Math.min(active, Math.max(0, items.length - 1));

  const head = mk('div', 'cmd-head');
  head.appendChild(mk('span', 'cmd-head-title', '命令'));
  head.appendChild(mk('span', 'meta', items.length > 0 ? '↑↓ 選擇 · Enter 確認' : '沒有匹配的命令'));
  panel.appendChild(head);

  items.forEach((cmd, i) => {
    const row = mk('button', `cmd-item${i === active ? ' active' : ''}`);
    row.dataset.capability = cmd.capability;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', i === active ? 'true' : 'false');

    const line = mk('span', 'cmd-line');
    // 名字前面帶上斜槓：面板裡挑的和輸入框裡打的是同一樣東西。
    line.appendChild(mk('span', 'cmd-label', `/${cmd.label}`));
    // 面板裡的命令幾乎都會寫檔案（討論不是命令，打字就是）——每條都標出來：點了會花錢，
    // 而且會在磁碟上留下東西。**審稿是例外**：只出一份報告、不寫檔案（五期 D22），掛一樣的
    // 「寫檔案」會讓作者以為點了它正文就被改了。
    if (cmd.capability === 'review') {
      line.appendChild(mk('span', 'cmd-tag', '只出報告'));
    } else {
      row.classList.add('cmd-writes');
      line.appendChild(mk('span', 'cmd-tag', '寫檔案'));
    }
    row.appendChild(line);
    row.appendChild(mk('span', 'cmd-hint', cmd.hint));

    row.addEventListener('mouseenter', () => {
      if (active !== i) {
        active = i;
        redraw();
      }
    });
    row.addEventListener('click', () => pick(cmd));
    panel!.appendChild(row);
  });
}

/** 中文標籤、ascii 全拼、拼音首字母都認，大小寫不敏感。 */
function matching(all: StageCommand[], q: string): StageCommand[] {
  const needle = q.trim().toLowerCase();
  if (!needle) {
    return all;
  }
  return all.filter(
    (c) => c.label.includes(q.trim()) || c.keys.some((k) => k.startsWith(needle))
  );
}

function pick(cmd: StageCommand): void {
  // 命令那幾個字是用來挑命令的，不是要發給模型的話——挑完就收走，
  // 剩下的輸入框留給補充要求。輸入框裡本來就是別人的正文時（按鈕開的面板）
  // 一個字都不動。
  if (slashQuery(el.input.value) !== null) {
    el.input.value = '';
  }
  dismissed = false;
  closeCommands();
  document.removeEventListener('click', onDocClick);
  onPick(cmd);
}

/**
 * 面板開著時接管鍵盤。返回 true 表示這一下已被消費，輸入框不該再處理。
 *
 * 只認導航與確認那四種鍵：**可列印字元一律放行**給輸入框，過濾串由
 * `syncCommandPalette` 從輸入框的值重算。從前這裡自己攢過濾串，於是
 * 輸入法打的中文一個都收不到（composition 不發 keydown 的可列印鍵）。
 */
export function handleCommandKey(e: KeyboardEvent): boolean {
  if (!panel) {
    return false;
  }
  switch (e.key) {
    case 'Escape':
      dismissed = true;
      closeCommands();
      return true;
    case 'ArrowDown':
      active = items.length === 0 ? 0 : (active + 1) % items.length;
      redraw();
      return true;
    case 'ArrowUp':
      active = items.length === 0 ? 0 : (active - 1 + items.length) % items.length;
      redraw();
      return true;
    case 'Tab':
    case 'Enter':
      // 有候選就挑它；一個都沒匹配上時 Enter 不該悄悄發一條 `/xxx` 出去。
      if (items[active]) {
        pick(items[active]);
      }
      return true;
    default:
      return false;
  }
}

/** 面板與「/ 命令」按鈕在生成期間都該停手——兩者都會發起新的一輪。 */
export function setCommandsDisabled(disabled: boolean): void {
  el.cmdBtn.disabled = disabled;
  if (disabled) {
    closeCommands();
  }
}
