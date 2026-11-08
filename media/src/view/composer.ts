/**
 * 輸入區：附件標籤、待執行命令、傳送，以及那幾個下拉框的聯動。
 *
 * ## 三條傳送路徑，一個出口
 *
 * - **主按鈕**（狀態機算出的下一步）：點了就跑，輸入框可空
 * - **`/` 命令**：挑一個 → 變成一枚 chip → Enter/傳送時用它，確定性的單步
 * - **直接傳送**：不挑命令就是在當前階段討論（`discuss`）。多步的活交給外部 agent 經 MCP 來做
 *
 * 三條都走同一個 `send()`：附件、草稿、busy 只在一處管。
 */
import { el as mk, setHidden } from '../dom';
import { querySelection } from '../globals';
import {
  CAPABILITY_LABEL,
  DEFAULT_THINKING_DEPTH,
  commandOf,
  isThinkingDepth,
  plotOfTarget,
} from '../protocol';
import type {
  Capability,
  CreationStage,
  CreationTarget,
  NextStepView,
  SendPayload,
  StageCommand,
  ThinkingDepth,
} from '../protocol';
import {
  handleCommandKey,
  isCommandPaletteOpen,
  syncCommandPalette,
  toggleCommands,
} from './commands';
import { openIdeaForm } from './forms';
import { scrollToBottom } from './messages';
import { el } from './refs';
import { persistDraft, store, vscode, hasWorkspace } from './store';
import { setBusy } from './state';
import { toast } from './toast';

/**
 * 已挑好、尚未執行的命令。
 *
 * 只活到下一次傳送為止：命令是**一次性的選擇**，不是模式。挑了「挑刺」
 * 發出去之後，下一句話多半又是普通的討論——讓它粘住只會讓人誤發。
 *
 * `target`：命令自帶的目標（`/落定設定` 在哪一層都能下，目標是設定目錄）。缺席就是會話當下的目標。
 */
let pending: { stage: CreationStage; capability: Capability; label: string; target?: CreationTarget } | null = null;

/** 當前輸入框裡的那一套引數。傳送與「重新生成」共用。 */
export function payload(): SendPayload {
  return {
    text: el.input.value,
    // 階段/目標記在會話裡（後端是唯一真相，前端只是回顯它）。挑了命令就用命令的，
    // 否則就是在當前階段討論——每一層都有討論。後端還會再校驗一遍。
    stage: pending?.stage ?? store.session.stage,
    capability: pending?.capability ?? 'discuss',
    target: pending?.target ?? store.session.target,
    targetNo: Number(el.targetSelect.value) || 1,
    attachments: store.attachments,
    excludedIds: [...store.excluded],
  };
}

export function renderChips(): void {
  el.chips.innerHTML = '';
  for (const att of store.attachments) {
    const chip = mk('span', 'chip');

    const label = mk('span', 'chip-label', att.label);
    label.title = att.relPath || att.label;
    chip.appendChild(label);

    const x = mk('button', 'chip-x', '×');
    x.title = '移除';
    x.addEventListener('click', () => {
      store.attachments = store.attachments.filter((a) => a.id !== att.id);
      renderChips();
    });
    chip.appendChild(x);

    el.chips.appendChild(chip);
  }
}

// ---------------------------------------------------------------- 待執行命令

/** 挑中一個命令：變成輸入框上方的一枚 chip，等一次傳送。工程頁章節右鍵「重寫正文」也掛這一枚。 */
export function setPendingCommand(cmd: Pick<StageCommand, 'capability' | 'label' | 'stage' | 'target'>): void {
  // 別的層掛過來的命令（`/落定設定`）帶著自己的階段與目標；後端跑完那一輪再回到會話原來的目標。
  pending = {
    stage: cmd.stage ?? store.session.stage,
    capability: cmd.capability,
    label: cmd.label,
    ...(cmd.target ? { target: cmd.target } : {}),
  };
  renderPending();
  el.input.focus();
}

export function clearPendingCommand(): void {
  pending = null;
  renderPending();
}

function renderPending(): void {
  el.pendingCmd.innerHTML = '';
  setHidden(el.pendingCmd, !pending);
  if (!pending) {
    return;
  }
  const chip = mk('span', 'chip cmd-chip');
  chip.appendChild(mk('span', 'chip-label', `/${pending.label}`));
  const x = mk('button', 'chip-x', '×');
  x.title = '取消這個命令';
  x.setAttribute('aria-label', '取消這個命令');
  x.addEventListener('click', () => {
    clearPendingCommand();
    el.input.focus();
  });
  chip.appendChild(x);
  el.pendingCmd.appendChild(chip);
}

// ---------------------------------------------------------------- 傳送

function send(): void {
  if (store.busy || !hasWorkspace()) {
    return;
  }
  const p = payload();
  // 空輸入只擋「討論」——討論的全部內容就是你那句話，而它不是命令，
  // `commandOf` 查不到它。命令（寫細綱、寫正文）本來就不需要
  // 作者再說什麼。後端也有同一道判斷。
  if (!p.text.trim() && !commandOf(p.stage, p.capability, p.target)) {
    toast(`「${CAPABILITY_LABEL[p.capability]}」需要先說點什麼。`, true);
    el.input.focus();
    return;
  }
  setBusy(true);
  vscode.postMessage({ type: 'send', payload: p });
  el.input.value = '';
  store.attachments = [];
  clearPendingCommand();
  renderChips();
  persistDraft();
  scrollToBottom(true);
}

/**
 * 執行狀態機算出的下一步。
 *
 * 工程動作（「定稿」）不是一輪對話，走 projectAction；其餘都當成一次帶
 * stage/capability/target 的普通傳送。
 *
 * **target 用狀態機給的那個**（`step.target`），不用會話當下的：全書層的下一步
 * 常常落在另一份產物上（會話停在大綱，下一步是「拆細綱（第 1–5 章）」、落點是
 * 第 1 章的細綱）。從前這裡只覆蓋了 stage 與 capability，target 仍是會話那份，
 * 於是按鈕上寫著一件事、落盤時寫到了另一處（§3.1-1）。
 */
export function runNextStep(step: NextStepView): void {
  if (store.busy || !hasWorkspace()) {
    return;
  }
  // 「生成小說配置」要作者先給一句話與規模：開啟表單，提交時才傳送（W4）。
  if (step.form === 'idea') {
    openIdeaForm(step.formDefaults);
    return;
  }
  if (step.projectAction) {
    // 落點由後端隨 next 一起給（target 裡就是那一章的路徑）。會話裡的
    // targetNo 可能還沒同步（舊會話、剛改過名），而工程動作拿不到物件
    // 會靜默什麼都不做。
    const relPath = plotOfTarget(step.target);
    vscode.postMessage({ type: 'projectAction', action: step.projectAction, relPath });
    return;
  }
  setBusy(true);
  vscode.postMessage({
    type: 'send',
    payload: {
      ...payload(),
      stage: step.stage,
      capability: step.capability,
      target: step.target,
      targetNo: step.no ?? step.range?.from ?? (Number(el.targetSelect.value) || 1),
      range: step.range,
      // 「接著寫」追加、「重寫第 N 章」覆蓋審閱：寫法隨這一步走（後端按它落盤）。
      writeMode: step.writeMode,
    },
  });
  el.input.value = '';
  store.attachments = [];
  clearPendingCommand();
  renderChips();
  persistDraft();
  scrollToBottom(true);
}

/** 下拉框的值是字串；認不出一律當「不思考」，與後端的容錯讀取同規矩。 */
function asDepth(value: string): ThinkingDepth {
  return isThinkingDepth(value) ? value : DEFAULT_THINKING_DEPTH;
}

export function installComposer(): void {
  el.sendBtn.addEventListener('click', send);
  el.stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  el.atBtn.addEventListener('click', () => vscode.postMessage({ type: 'pickAttachment' }));
  // 內建編輯器（獨立版）裡選著字就直接帶上：宿主取不到網頁裡的選區，只會彈貼上框。沒選中、或者沒有內建編輯器（外掛）
  // 時照舊交給宿主——外掛讀 VS Code 編輯器的選區，獨立版彈貼上框。
  el.selBtn.addEventListener('click', () => {
    const selection = querySelection();
    vscode.postMessage(selection ? { type: 'addSelection', selection } : { type: 'addSelection' });
  });
  el.cmdBtn.addEventListener('click', toggleCommands);

  // 面板的開合是**輸入框內容的函式**（見 commands.ts）：打 `/` 就開、刪掉
  // 就關、往後打字就過濾。掛在 input 而不是 keydown 上，輸入法打的中文
  // （composition 結束才落值）才收得到。
  el.input.addEventListener('input', () => {
    persistDraft();
    syncCommandPalette();
  });
  // 目標下拉框換了一章 → **進入那一章當前該做的那一步**（由後端的狀態機判定）。
  el.targetSelect.addEventListener('change', () => {
    const relPath = el.targetSelect.selectedOptions[0]?.dataset.rel;
    if (relPath) {
      vscode.postMessage({ type: 'selectPlot', plotRelPath: relPath });
      return;
    }
    // 沒有 relPath 說明選的是「情節大綱」那一項：回到全書那一層，
    // 主按鈕會是全書的下一步（生成架構 / 大綱 / 拆細綱 / 寫下一章）。
    vscode.postMessage({ type: 'setTarget', target: { kind: 'outline' } });
  });
  el.modelSelect.addEventListener('change', () =>
    vscode.postMessage({ type: 'selectModel', ref: el.modelSelect.value })
  );
  // 思考深度落在會話上（後端當場落盤），所以這裡只發意圖、不改本地狀態——
  // 值由回來的那條 session 訊息回填（前端無狀態那條基本盤）。
  el.thinkSelect.addEventListener('change', () =>
    vscode.postMessage({ type: 'setThinking', depth: asDepth(el.thinkSelect.value) })
  );

  el.input.addEventListener('keydown', (e) => {
    // 面板開著時導航鍵歸它（↑↓ 選、Enter/Tab 確認、Esc 收起）。
    // 可列印字元一律放行——過濾串由上面那個 input 監聽從輸入框的值重算。
    if (isCommandPaletteOpen() && handleCommandKey(e)) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
      return;
    }
    // 輸入 @ 直接開啟引用選擇器，跟 Cursor 一致。
    if (e.key === '@') {
      e.preventDefault();
      vscode.postMessage({ type: 'pickAttachment' });
    }
    // `/` 不再在這裡攔：它就打進輸入框，面板由 input 監聽按值喚出。
    // 從前攔下來自己攢過濾串，等於在輸入框旁邊又造了一個隱形輸入框。
  });
}
