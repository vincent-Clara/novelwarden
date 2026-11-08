/**
 * 許可權詢問：**agent 動手之前那一句問在對話頁裡，不是一個蓋住視窗的模態框。**
 *
 * ## 為什麼不是模態框
 *
 * 作者要判斷的恰恰是「這一步動的是哪個檔案、寫的是什麼」，而那串上下文——
 * 前幾條工具呼叫、模型剛說的那段話——就在被模態框蓋住的訊息流裡。一個居中的
 * 「Agent 要寫入…，允許嗎」把他從要看的東西上拽走，還順手鎖住整個視窗：想
 * 先翻一眼那個檔案再決定都做不到。所以這一句改成**貼在輸入框上方的一張卡片**
 * （`media/src/view/gate.ts`），頁面照常能滾、能翻、能點別的。它也不掛在氣泡
 * 上——那樣會跟著內容滾出視野，而呼叫正卡在它上面等回答。
 *
 * ## 這一層只做「問」這件事
 *
 * 問不問、問什麼由呼叫方定（工具自報的 `ToolIntent`、落盤卡片的形狀），這裡把那一問
 * 變成一條協議訊息，等前端回話：
 *
 * ```
 * mcp.ts / chat.ts ──askGate──▶ gate ──▶ 輸入框上方那張卡片
 *                      ▲                       │
 *                      └───── gateResult ◀─────┘
 * ```
 *
 * **兩種問法共用這一條路**：
 *
 * | 誰在問 | 什麼時候 | 按鈕 |
 * |---|---|---|
 * | 外部 agent 的 `always` 動作（`controller/mcp.ts`） | 動手前 | 確認 / 跳過 |
 * | 產物落盤（第 19 條） | `generate` 一產出就問 | 確認 / 不採納 |
 *
 * 兩種都只有兩顆：**叫停整輪不在這張卡上**——那是輸入框旁邊那顆「停止」，
 * 與「這一個檔案要不要動」是兩件事，混進閘門只會被誤當成「跳過」。
 *
 * ## 三件必須做對的事
 *
 * 1. **兩個檢視同時收卡**——側邊欄與編輯器標籤頁掛同一個 controller，只在被
 *    點的那一邊收，另一邊會留一張點了沒反應的卡（`gateDone` 廣播）。
 * 2. **重連之後卡片還在**——前端無狀態，重新整理網頁/webview 重建後靠
 *    `resendFullState` 把還沒答的這幾條重推一遍；不重推的話呼叫就永遠停在
 *    一個沒人看得見的等待上。
 * 3. **取消要能解開等待**——作者點「停止」時呼叫正卡在這裡等回答，
 *    signal 一斷就按「停止」結算，不留一個永遠懸著的 Promise。
 */
import type { OutMessage } from '../protocol';
import type { ChatController } from './index';

/**
 * 一次詢問的結論。作者只點得到前兩個：**停止**是沒人回答（取消）時替他記下的那一筆，
 * 不是卡片上的一顆按鈕。
 */
export type GateVerdict = 'proceed' | 'skip' | 'stop';

/**
 * 兩顆按鈕上的預設字。**同意那顆不寫動詞**：「Agent 要寫入「第 12 章」」這句話就在
 * 按鈕上方，按鈕再說一遍是重複；每次換一個動詞的話，作者反而要先讀按鈕才敢點。
 */
export const PROCEED_ACTION = '確認';
export const SKIP_ACTION = '跳過';

type GateMessage = Extract<OutMessage, { type: 'gate' }>;

/**
 * 一次詢問能有的結論。**卡片上只有前兩顆按鈕**，`cancelled` 是沒人回答
 * （這一輪被取消、換了會話）時替作者記下的那一筆——它對呼叫方等於「停止」。
 */
export type GateSettlement = 'proceed' | 'skip' | 'cancelled';

/** 一次還沒答的詢問。`msg` 留著是為了重連時能原樣再推一遍。 */
export interface PendingGate {
  readonly msg: GateMessage;
  /**
   * 結算這一次詢問。**只有第一次算數**（作者點了，同時這一輪又被取消）。`remember` 是卡片帶
   * 理由輸入框時作者填的那一句（見 {@link GateAsk.remember}）。
   */
  settle(verdict: GateSettlement, remember?: string): void;
}

/**
 * 詢問 id。與 `makeTurnId` 同一套理由：同一毫秒裡連著問兩次也不能撞，
 * 而這個 id 是前端那張卡片的身份。
 */
let counter = 0;
function nextRequestId(): string {
  counter += 1;
  return `g${Date.now().toString(36)}-${counter.toString(36)}`;
}

export interface GateAsk {
  /** 哪一輪在問。卡片本身在輸入框上方，這個 id 是給**答完那一行記錄**用的。 */
  turnId: string;
  /** 這一問對應的工具呼叫。產物落盤那一問來自單步創作時沒有。 */
  callId?: string;
  name: string;
  /** 已經帶著主語的那句話（「Agent 要寫入設定「北境」」）。前端照原樣畫。 */
  title: string;
  detail?: string;
  /** 模型這一次填的引數（已截斷的 JSON 文字）。卡片裡摺疊著，點開才看。 */
  argsText?: string;
  /** 同意那顆按鈕上的字。預設是「確認」。 */
  proceed?: string;
  /** 拒絕那顆按鈕上的字。預設是「跳過」。 */
  skip?: string;
  /** 紅色塊裡的那一句（見協議 `gate.danger`）。 */
  danger?: string;
  /** 給了就要點兩下才算同意，第二下按鈕上是這幾個字（見協議 `gate.confirm`）。 */
  confirm?: string;
  /** 給了就多一格理由輸入框與第三顆按鈕（見協議 `gate.remember`）。理由經 {@link askGateNoted} 拿回來。 */
  remember?: { label: string; placeholder: string };
}

/**
 * 在對話頁裡問一句，等作者點。
 *
 * 關掉頁面不算回答——那種情況下這條詢問會隨重連再推一遍。真正的「沒人回答」
 * 只有取消一種，按**停止**處理（他被問「要不要動你的磁碟」而沒有回答，不該
 * 替他答「繼續」）。
 */
export async function askGate(c: ChatController, ask: GateAsk, signal?: AbortSignal): Promise<GateVerdict> {
  return (await askGateNoted(c, ask, signal)).verdict;
}

/** 同 {@link askGate}，另把作者在理由輸入框裡填的那一句帶回來（卡片帶 `remember` 時才可能有）。 */
export function askGateNoted(
  c: ChatController,
  ask: GateAsk,
  signal?: AbortSignal
): Promise<{ verdict: GateVerdict; remember?: string }> {
  const requestId = nextRequestId();
  const msg: GateMessage = {
    type: 'gate',
    requestId,
    turnId: ask.turnId,
    callId: ask.callId,
    name: ask.name,
    title: ask.title,
    detail: ask.detail,
    argsText: ask.argsText,
    // 按鈕上的字都從後端來：與呼叫方判定用的是同一份常量，前端自己寫一遍的
    // 話，改了文案就對不上了。
    proceed: ask.proceed ?? PROCEED_ACTION,
    skip: ask.skip ?? SKIP_ACTION,
    ...(ask.danger ? { danger: ask.danger } : {}),
    ...(ask.confirm ? { confirm: ask.confirm } : {}),
    ...(ask.remember ? { remember: ask.remember } : {}),
  };

  return new Promise<{ verdict: GateVerdict; remember?: string }>((resolve) => {
    const onAbort = () => c.gates.get(requestId)?.settle('cancelled');
    const settle = (verdict: GateSettlement, remember?: string) => {
      // 先從表裡摘掉：這既是「只結算一次」的判據，也讓重連不再推它。
      if (!c.gates.delete(requestId)) {
        return;
      }
      signal?.removeEventListener('abort', onAbort);
      c.post({ type: 'gateDone', requestId, verdict });
      const note = verdict === 'proceed' && ask.remember && remember?.trim() ? remember.trim() : undefined;
      resolve({ verdict: verdict === 'cancelled' ? 'stop' : verdict, ...(note ? { remember: note } : {}) });
    };

    c.gates.set(requestId, { msg, settle });
    c.post(msg);

    // 沒有 signal 的（單步創作那條路：生成已經結束，鎖也放了）只能靠作者點，
    // 或者被 `cancelGates` 收掉——換會話、開下一輪時那張卡就作廢了。
    if (!signal) {
      return;
    }
    if (signal.aborted) {
      settle('cancelled');
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * 作者點了卡片上的某一顆按鈕。
 *
 * **認不出的 requestId 靜默丟棄**：重連之後前端可能還留著一張早就結束了的
 * 卡片（另一個檢視上答過了），為它報錯只會讓作者莫名其妙。
 */
export function resolveGate(c: ChatController, requestId: string, verdict: 'proceed' | 'skip', remember?: string): void {
  c.gates.get(requestId)?.settle(verdict, remember);
}

/**
 * 把還沒答的全收掉（按「取消」結算）。
 *
 * 單步創作那條路的落盤卡片沒有 signal——生成早結束了、鎖也放了。作者要是
 * 不理它、直接開了下一輪或換了會話，那張卡就不該再留著：它問的是上一條氣泡
 * 裡的東西，點下去寫的是一份作者早已翻篇的產物。
 */
export function cancelGates(c: ChatController): void {
  for (const gate of [...c.gates.values()]) {
    gate.settle('cancelled');
  }
}

/** 重連/重建時把還沒答的那幾張卡重新推一遍。前端無狀態，全靠這一下。 */
export function resendGates(c: ChatController): void {
  for (const gate of c.gates.values()) {
    c.post(gate.msg);
  }
}
