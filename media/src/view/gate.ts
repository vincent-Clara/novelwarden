/**
 * agent 動手之前那一句問，**固定在輸入框上方那一格**。
 *
 * ```
 * ┌──────────────────────────────────────────┐
 * │ 許可權請求                                  │
 * │ Agent 要把生成的產物覆蓋到「情節大綱」      │
 * │ 情節大綱 · 6104 字 · 那裡已經有內容了       │
 * │ ▸ 引數                                    │
 * │                        不採納       確認   │
 * └──────────────────────────────────────────┘
 * ┌ 大綱：故事講什麼？ ──────────────────────┐
 * ```
 *
 * **不是模態框**：作者要判斷的上下文（它剛讀了哪幾章、正要寫哪個檔案）就在
 * 訊息流裡，一個蓋住視窗的框會把這些全擋上，還順手鎖死介面——想先翻一眼那個
 * 檔案再決定都做不到。
 *
 * **也不是訊息流裡的一張卡片**：那是這一版之前的樣子。卡片掛在氣泡上就會跟著
 * 內容滾——agent 隨後還在說話、還在調工具，幾行之後那張卡就滾出視野了，而迴圈
 * 正卡在它上面等回答。作者看到的是一個「卡住不動」的介面，要往上翻才找得到原
 * 因。所以它改掛在輸入框上方：那裡不滾、離手最近，且與「要不要發這句話」是同
 * 一個位置上的同一類決定（Cursor / Claude Code 那一套）。
 *
 * **答完卡片就走，記錄留在訊息流裡**：緊跟著的那條工具條只會說「未執行」，而
 * 「因為我按了跳過」這件事得有地方講——於是往那一輪的工具串（或產物正文下面）
 * 補一行 `.gate-note`。這一輪結束時氣泡按會話重建，那一行自然消失（決定本身已
 * 經記在工具條上了）。
 *
 * **只有兩顆按鈕**：叫停整輪是輸入框旁邊那顆「停止」，不在這張卡上——它與
 * 「這一個檔案要不要動」是兩件事，擺進閘門只會被誤當成「跳過」，而兩者的後果
 * 差著一整輪。
 *
 * 兩顆按鈕上的字都由後端給（`gate` 訊息）：閘門上是「確認 / 跳過」，落盤那
 * 一問是「確認 / 不採納」，前端寫死一份的話，改了文案兩邊就對不上。
 */
import { el as mk, setHidden, spacer } from '../dom';
import type { OutMessage } from '../protocol';
import { bubbleOf, toolStripOf } from './messages';
import { el } from './refs';
import { vscode } from './store';

type GateMessage = Extract<OutMessage, { type: 'gate' }>;
type Verdict = 'proceed' | 'skip' | 'cancelled';

/** 結算之後那一行上的說法。取消是「這一輪停了」，不是作者答的。 */
const SETTLED: Record<Verdict, string> = {
  proceed: '已允許',
  skip: '已跳過',
  cancelled: '已取消，沒有執行',
};

/**
 * 推上來一條詢問：卡片進輸入框上方那一格。
 *
 * 重連時後端會把還沒答的這幾條原樣再推一遍，已經畫著的不再畫第二張。
 * **不挑氣泡**：認不出的 turnId 照樣畫——迴圈卡在這一問上，把卡片丟掉等於
 * 留一個沒人看得見的死等。
 */
export function showGate(msg: GateMessage): void {
  if (gateCardOf(msg.requestId)) {
    return;
  }
  el.gateDock.appendChild(buildGateCard(msg));
  syncDock();
}

/**
 * 這一問答完了：卡片撤下，訊息流裡補一行記錄。
 *
 * 三條路進這裡——作者點了這邊的按鈕、作者在另一個檢視上點了（後端廣播
 * `gateDone`）、這一輪被取消。**只有第一次算數**：答過之後格子裡已經沒有這張
 * 卡，後來的廣播就地靜默（認不出的 requestId 同理，重連之後前端可能還留著
 * 一條早就結束了的詢問）。
 *
 * @returns 這一下是不是真的結算了（false = 早就答過了，不必再發回後端）
 */
export function settleGate(requestId: string, verdict: Verdict): boolean {
  const card = gateCardOf(requestId);
  if (!card) {
    return false;
  }
  card.remove();
  syncDock();
  noteVerdict(card, verdict);
  return true;
}

// ---------------------------------------------------------------- 卡片

function buildGateCard(msg: GateMessage): HTMLElement {
  const card = mk('div', 'gate');
  card.dataset.gate = msg.requestId;
  // 答完要往哪條氣泡上補那一行記錄。卡片已經不在訊息流裡，只能自己記著。
  card.dataset.turn = msg.turnId;
  if (msg.callId) {
    card.dataset.call = msg.callId;
  }
  card.dataset.what = msg.title;

  // 頭一行只有一個淡淡的名分。堆了兩張以上時右邊補「1 / 2」——一格里疊著
  // 好幾張時，作者得知道自己在答哪一張。
  const head = mk('div', 'gate-head');
  head.appendChild(mk('span', 'gate-kind', '許可權請求'));
  head.appendChild(spacer());
  head.appendChild(mk('span', 'gate-count'));
  card.appendChild(head);

  card.appendChild(mk('div', 'gate-title', msg.title));

  // 寫到哪、寫多少——「Agent 想呼叫 write，允許嗎」作者答不上來，
  // 這一行才是他做判斷的依據。
  if (msg.detail) {
    card.appendChild(mk('div', 'gate-detail', msg.detail));
  }
  // 要作者特別留意的那一句（正文開頭重演了上一章結尾）：紅色塊，排在明細後面、按鈕前面。
  if (msg.danger) {
    card.classList.add('gate-warn');
    card.appendChild(mk('div', 'gate-danger', msg.danger));
  }
  if (msg.argsText) {
    const det = mk('details', 'gate-args');
    det.appendChild(mk('summary', undefined, '引數'));
    det.appendChild(mk('pre', 'tool-detail-text', msg.argsText));
    card.appendChild(det);
  }

  const answer = (verdict: 'proceed' | 'skip', remember?: string) => {
    // 先就地撤卡：慢一點的後端回話之前，作者不該能把兩顆都點一遍。
    if (settleGate(msg.requestId, verdict)) {
      vscode.postMessage({ type: 'gateResult', requestId: msg.requestId, verdict, ...(remember ? { remember } : {}) });
    }
  };

  // 「記為刻意安排，照寫」（一致性預檢，五期補遺 §2）：一格理由 + 一顆按鈕，填了理由才能點。
  // 排在兩顆主按鈕上面——它是「同意」的一種，但要多做一件事（把理由記進細綱），不該挨著
  // 「照寫」讓作者順手點錯。
  if (msg.remember) {
    const row = mk('div', 'gate-remember');
    const input = mk('input', 'gate-remember-input');
    input.type = 'text';
    input.placeholder = msg.remember.placeholder;
    const save = gateBtn(msg.remember.label, 'secondary gate-remember-btn', () => {
      const reason = input.value.trim();
      if (reason) {
        answer('proceed', reason);
      }
    });
    save.disabled = true;
    input.addEventListener('input', () => {
      save.disabled = !input.value.trim();
    });
    row.appendChild(input);
    row.appendChild(save);
    card.appendChild(row);
  }

  // 同意貼最右（離「傳送」最近的那一側就是「繼續」），拒絕挨著它壓成次級按鈕。
  // 兩顆一樣重的話，作者會下意識點左邊那顆——而這一下是「動我的磁碟」。
  const actions = mk('div', 'gate-actions');
  actions.appendChild(spacer());
  actions.appendChild(gateBtn(msg.skip, 'secondary', () => answer('skip')));
  const proceed = gateBtn(msg.proceed, 'primary', () => {
    // 兩段式（總計劃 §2.4）：第一下只把字換成「確定仍要寫入」，第二下才發出去。
    // 不疊一個確認彈窗——作者要判斷的依據就在這張卡上，彈窗會把它蓋住。
    if (msg.confirm && !proceed.classList.contains('armed')) {
      proceed.classList.add('armed');
      proceed.textContent = msg.confirm;
      return;
    }
    answer('proceed');
  });
  actions.appendChild(proceed);
  card.appendChild(actions);
  return card;
}

function gateBtn(text: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = mk('button', className, text);
  b.addEventListener('click', onClick);
  return b;
}

/** 按 requestId 找那張還沒答的卡。 */
function gateCardOf(requestId: string): HTMLElement | null {
  return el.gateDock.querySelector<HTMLElement>(`.gate[data-gate="${requestId}"]`);
}

/** 空了就整格收起來（免得輸入框上方常年多一道邊）；順手重編「第幾張」。 */
function syncDock(): void {
  const cards = [...el.gateDock.querySelectorAll<HTMLElement>('.gate')];
  setHidden(el.gateDock, cards.length === 0);
  cards.forEach((card, i) => {
    const count = card.querySelector('.gate-count');
    if (count) {
      count.textContent = cards.length > 1 ? `${i + 1} / ${cards.length}` : '';
    }
  });
}

/**
 * 往訊息流裡補一行「答了什麼」。
 *
 * 掛哪兒和從前那張卡片一個規矩：帶 `callId` 的是某一次工具呼叫的事，排進工具
 * 串（問了、答了、然後做了什麼，讀起來是一條線）；不帶的是單步創作產出之後那
 * 一問，掛在正文**下面**——那份產物就是作者做判斷的依據。
 *
 * 氣泡可能已經不在了（換了會話、這一輪重建過）：那就不補，沒有記錄也好過往
 * 別人的氣泡上亂插一行。
 */
function noteVerdict(card: HTMLElement, verdict: Verdict): void {
  const turnId = card.dataset.turn;
  if (!turnId) {
    return;
  }
  const host = card.dataset.call ? toolStripOf(turnId) : bubbleOf(turnId);
  if (!host) {
    return;
  }
  const note = mk('div', `gate-note${verdict === 'proceed' ? '' : ' declined'}`);
  note.dataset.gateNote = card.dataset.gate ?? '';
  note.appendChild(mk('span', 'gate-note-icon', verdict === 'proceed' ? '✓' : '⊘'));
  const what = card.dataset.what;
  note.appendChild(mk('span', 'gate-note-text', what ? `${SETTLED[verdict]}：${what}` : SETTLED[verdict]));
  if (card.dataset.call) {
    host.appendChild(note);
  } else {
    // 末尾那一行（複製/落點）之後沒有意義，插在它前面。
    host.insertBefore(note, host.querySelector('.msg-actions'));
  }
}
