/**
 * 面板的前端入口。外掛與獨立版共用同一份，差異全靠**能力探測**
 * （`#wbEditor` 在不在），不判斷環境字串。
 *
 * **前端無狀態**：一切資料來自 `ViewState` / `ProjectTree` 的全量推送，
 * webview 銷燬重建後一條 `ready` 就能完整恢復；展開/摺疊等純 UI 狀態
 * 留在前端各自的模組裡。
 *
 * 訊息契約是 [core/protocol](../../../src/core/protocol/index.ts) 的
 * `InMessage` / `OutMessage`，經 src/protocol.ts 引進來——改協議這邊
 * 對不上會直接編譯不過。
 */
import { el as mk } from '../dom';
import { installComposer, payload, renderChips, runNextStep, setPendingCommand } from './composer';
import { bindCommandPick } from './commands';
import { renderSessions } from './history';
import { appendLog, installLogs, prependLogHistory, renderLogs } from './logs';
import { installMenubar } from './menubar';
import { installMenus } from './menu';
import { installMobileNav } from './mobileNav';
import {
  bindPayload,
  buildContextDetails,
  buildGenCard,
  buildPendingToolRow,
  buildReasoningDetails,
  buildTextBlock,
  buildToolRow,
  bubbleOf,
  dropEmptyText,
  installMessages,
  lastSegment,
  onContextText,
  renderSession,
  scrollToBottom,
  segmentAnchor,
  toolStripOf,
  upsertTurn,
} from './messages';
import { settleGate, showGate } from './gate';
import { applySummary, installProject, invalidateSummaries, renderProject } from './project';
import { baseMenuItems } from './project/actions';
import { bindNextStepRunner, installNewSession, installRenamePlot, renderPipeline } from './pipeline';
import { renderWorkbench, installWorkbench } from './workbench';
import { installPrompt, renderPrompt } from './prompt';
import { installSettings, renderSettings } from './settings';
import { renderSkillInspection, renderSkills } from './settings/skills';
import { renderState, setBusy } from './state';
import { restoreDraft, store, vscode } from './store';
import { installTabs, isTabActive, showTab } from './tabs';
import { renderTasks } from './tasks';
import { countWords } from './format';
import { exposeToast, toast } from './toast';
import { installFolderPicker } from './folderPicker';
import { installForm } from './form';
import { installCheckpoints, renderCheckpointDiff, renderCheckpoints } from './checkpoints';
import { applyBookInspected, applyProjectCreated, applyWorkspaces, installWelcome } from './welcome';
import { onMessage } from '../vscodeApi';
import { openChapterMessage } from '../narrow';

restoreDraft();
exposeToast();
installMenus(baseMenuItems);
installTabs();
installComposer();
installMessages();
bindPayload(payload);
// 主按鈕走 composer 的傳送路徑（它管附件、草稿、busy）；`/` 面板挑中的命令
// 變成待執行 chip。兩條線都不在各自模組裡另起一套傳送邏輯。
bindNextStepRunner(runNextStep);
installNewSession();
installRenamePlot();
bindCommandPick(setPendingCommand);
installProject();
installForm();
installPrompt();
installCheckpoints();
installLogs();
installSettings();
installWorkbench();
installMenubar();
installMobileNav();
installWelcome();
installFolderPicker();

onMessage((msg) => {
  switch (msg.type) {
    case 'init':
    case 'state':
      renderState(msg.state);
      break;

    case 'tab':
      showTab(msg.tab);
      break;

    case 'session':
      renderSession(msg.session);
      break;

    case 'sessions':
      renderSessions(msg.list);
      break;

    case 'project':
      // 後端推樹 = 磁碟上有東西變了（可能正是某一章的正文或細綱）。
      // 細綱快取一律作廢，寧可再取一次也不拿舊細綱糊弄人。摺疊資料夾走的是
      // rerenderProject()，不經這裡，快取留著。
      invalidateSummaries();
      renderProject(msg.tree);
      break;

    case 'summary':
      applySummary(msg.summary);
      break;

    case 'pipeline':
      renderPipeline(msg.pipeline, msg.next);
      renderWorkbench(msg.workbench);
      break;

    case 'attachments':
      store.attachments = msg.items;
      renderChips();
      break;

    case 'delta':
      store.streamingId = msg.turnId;
      appendText(msg.turnId, msg.text);
      break;

    case 'toolDelta':
      appendGenerated(msg.turnId, msg.callId, msg.text);
      break;

    case 'reasoning':
      appendReasoning(msg.turnId, msg.text);
      break;

    // ---- 寫正文：氣泡頂上的進度（W7），與丟棄一輪時的退回
    case 'writeProgress':
      showWriteProgress(msg.turnId, msg.round, msg.words, msg.target);
      break;

    case 'streamReset':
      resetStreamText(msg.turnId, msg.text);
      break;

    case 'toolCall':
      appendToolCall(msg.turnId, msg.callId, msg.name, msg.title ?? msg.name, msg.detail, msg.argsText);
      break;

    case 'toolResult':
      settleToolCall(msg.turnId, msg);
      break;

    // ---- 動手之前那一句問：卡片固定在輸入框上方，不彈全域模態框
    case 'gate':
      // 位置在 gate.ts 裡定：**不在訊息流裡**——迴圈正卡在這一問上，一張跟著
      // 內容滾出視野的卡片等於沒人看見。
      showGate(msg);
      // 順手把訊息流滾到底：作者要判斷的依據（它剛讀了什麼、剛生成了什麼）
      // 就在最後那幾行上。
      scrollToBottom();
      // 人在別的頁簽上時那一格看不見，而迴圈正卡在這裡等他——喊一聲。
      // 不替他切頁：他多半正是去工程頁翻那個檔案，好決定點不點頭。
      if (!isTabActive('chat')) {
        toast('有一件事在等你點頭，去對話頁看看。');
      }
      break;

    case 'gateDone':
      // 另一個檢視上答了，或者這一輪被取消了。兩處的卡片都要收。
      settleGate(msg.requestId, msg.verdict);
      break;

    case 'turnDone':
      // 生成開始時控制器先插一條空回覆，後續 delta 都掛在它上面。
      // 必須在這一刻就標成 streaming：否則氣泡會以「可編輯」建出來，
      // 使用者在生成途中的改動會被隨後的 delta 追加和收尾重建沖掉。
      // 收尾的那次 turnDone 帶著完整內容、busy 已為 false，於是解鎖。
      store.streamingId =
        store.busy && msg.turn.role === 'assistant' && !msg.turn.content && !msg.turn.error
          ? msg.turn.id
          : null;
      upsertTurn(msg.turn);
      break;

    case 'context': {
      const node = bubbleOf(msg.turnId);
      if (node && !node.querySelector('details.ctx')) {
        node.insertBefore(buildContextDetails(msg.digest), node.querySelector('.msg-actions'));
      }
      break;
    }

    case 'contextText':
      onContextText(msg);
      break;

    case 'busy':
      setBusy(msg.value);
      break;

    case 'settings':
      renderSettings(msg.settings, msg.keys, msg.ack);
      break;

    case 'skills':
      renderSkills(msg.view, msg.installed);
      break;

    case 'skillInspection':
      renderSkillInspection(msg.url, msg.inspection, msg.error);
      break;

    case 'tasks':
      renderTasks(msg.tasks);
      break;

    // 長任務說完了那一句（D24）：帶「開啟第 N 章」時點了就開那一章（W6 章節工作臺那一條）；
    // 批次審稿帶的是「開啟審稿報告」——開那個會話（五期補遺 §4）。
    case 'taskDone': {
      const open = msg.open;
      toast(
        msg.message,
        msg.level === 'error',
        open
          ? {
              label: open.label,
              run: () =>
                vscode.postMessage(
                  'sessionId' in open ? { type: 'openSession', id: open.sessionId } : openChapterMessage(open.plotRelPath)
                ),
            }
          : undefined
      );
      break;
    }

    case 'logs':
      renderLogs(msg.entries);
      break;

    case 'logHistory':
      prependLogHistory(msg.entries, msg.exhausted);
      break;

    case 'log':
      appendLog(msg.entry);
      break;

    case 'toast':
      toast(msg.message, msg.level === 'error');
      break;

    case 'prompt':
      renderPrompt(msg);
      break;

    // 工程頁「存檔點…」彈窗（view/checkpoints.ts）：沒開著時不認。
    case 'checkpoints':
      renderCheckpoints(msg);
      break;

    case 'checkpointDiff':
      renderCheckpointDiff(msg);
      break;

    case 'workspaces':
      applyWorkspaces(msg);
      break;

    // 歡迎頁「新建一本書」「匯入寫好的書」（view/welcome.ts）。
    case 'projectCreated':
      applyProjectCreated(msg);
      break;

    case 'bookInspected':
      applyBookInspected(msg);
      break;
  }
});

/**
 * 思考增量：氣泡裡沒有摺疊塊就建一個（預設收起），有就往裡追加。
 * **就地追加而不是重建節點**——重建會把使用者展開的狀態和滾動位置弄丟。
 */
function appendReasoning(turnId: string, text: string): void {
  const node = bubbleOf(turnId);
  if (!node) {
    return;
  }
  node.classList.add('streaming');

  let det = node.querySelector<HTMLDetailsElement>('details.reasoning');
  if (!det) {
    det = buildReasoningDetails('');
    // 排在**段區之前**：它是正文遲遲不來時的進度反饋，不是流水賬裡的一條。
    // 段區可能以工具條或 generate 卡開頭（不一定有正文塊），所以三樣一起找。
    node.insertBefore(det, node.querySelector('.msg-body, .tools, .gen') ?? segmentAnchor(node));
  }
  const box = det.querySelector<HTMLElement>('.reasoning-body');
  if (box) {
    box.textContent += text;
    const summary = det.querySelector('summary');
    if (summary) {
      summary.textContent = `思考過程 · ${countWords(box.textContent ?? '')} 字`;
    }
    // 展開著看的時候，讓它跟著滾到最新。
    if (det.open) {
      box.scrollTop = box.scrollHeight;
    }
  }
  scrollToBottom();
}

/**
 * 寫正文的進度：「第 2 輪 · 已寫 1860 / 目標 3000 字」+ 一條進度條（W7）。
 *
 * 掛在氣泡頂上、正文之前（與思考摺疊塊同一個位置）：正文在往下漲，進度得待在
 * 一眼看得到的地方。**就地更新**——重建節點會沖掉正在流的正文。收尾的 turnDone
 * 會整條重建氣泡，進度條隨之消失，那時落盤卡片上已經寫著最後的字數。
 */
function showWriteProgress(turnId: string, round: number, words: number, target?: number): void {
  const node = bubbleOf(turnId);
  if (!node) {
    return;
  }
  node.classList.add('streaming');
  let box = node.querySelector<HTMLElement>('.write-progress');
  if (!box) {
    const made = mk('div', 'write-progress');
    made.appendChild(mk('div', 'write-progress-label'));
    const bar = mk('div', 'write-progress-bar');
    bar.appendChild(mk('div', 'write-progress-fill'));
    made.appendChild(bar);
    node.insertBefore(made, node.querySelector('details.reasoning, .msg-body, .tools, .gen') ?? segmentAnchor(node));
    box = made;
  }
  const phase = round > 0 ? `續寫第 ${round} 輪` : '正在寫';
  const label = box.querySelector<HTMLElement>('.write-progress-label')!;
  label.textContent = target ? `${phase} · 已寫 ${words} / 目標 ${target} 字` : `${phase} · 已寫 ${words} 字`;
  const fill = box.querySelector<HTMLElement>('.write-progress-fill')!;
  fill.style.width = `${target ? Math.min(100, Math.round((words / target) * 100)) : 100}%`;
  // 到了八成就算寫夠（與後端 MANUSCRIPT_DONE_RATIO 同一個比例）：顏色換一檔。
  box.classList.toggle('reached', !!target && words >= target * 0.8);
  box.classList.toggle('indeterminate', !target);
}

/**
 * 氣泡裡的正文退回到這一份：續寫丟棄了一輪，那一輪已經流進來了。只動文字塊，
 * 進度條與思考摺疊塊不動。
 */
function resetStreamText(turnId: string, text: string): void {
  const node = bubbleOf(turnId);
  if (!node) {
    return;
  }
  const blocks = [...node.querySelectorAll<HTMLElement>('.msg-body[data-seg="text"]')];
  if (blocks.length === 0) {
    node.insertBefore(buildTextBlock(text), segmentAnchor(node));
    return;
  }
  blocks[0].textContent = text;
  for (const extra of blocks.slice(1)) {
    extra.remove();
  }
}

/**
 * 模型說的話又來了一段：追加到**最後那一塊文字**上，沒有就新開一塊。
 *
 * 「沒有就新開」正是交替：上一段是工具呼叫（或 generate 卡）時，這句話是新的
 * 一塊，接到前一塊上就等於把順序抹平——那是從前所有話擠進同一個文字節點的
 * 由來。就地追加而不重建氣泡：重建會沖掉正在流的內容。
 */
function appendText(turnId: string, text: string): void {
  const node = bubbleOf(turnId);
  if (!node) {
    return;
  }
  node.classList.add('streaming');
  const blocks = node.querySelectorAll<HTMLElement>('.msg-body[data-seg="text"]');
  const last = blocks[blocks.length - 1];
  // 末尾那一塊才接得上；它後面已經排了工具條或卡片的話，得另開一塊。
  if (last && last === lastSegment(node)) {
    last.textContent += text;
  } else {
    const block = buildTextBlock(text);
    node.insertBefore(block, segmentAnchor(node));
  }
  scrollToBottom();
}

/**
 * `generate` 流出來的正文又來了一段：進它那一張卡。
 *
 * **卡內滾動，不動整條對話**：這幾千字正在往下漲，要是讓它把訊息流一路往下頂，
 * 作者連上面剛說的那句話都看不成了。
 */
function appendGenerated(turnId: string, callId: string, text: string): void {
  const body = bubbleOf(turnId)?.querySelector<HTMLElement>(`.gen[data-call="${callId}"] .gen-body`);
  if (!body) {
    return;
  }
  body.textContent += text;
  body.scrollTop = body.scrollHeight;
}

/**
 * 工具呼叫開始：在氣泡裡掛一條「進行中…」的行，或者給 generate 開一張卡。
 *
 * **就地追加而不是重建氣泡**：重建會把正在流的內容沖掉（文字塊是純文字節點，
 * delta 靠 `textContent +=` 追加）。
 */
function appendToolCall(
  turnId: string,
  callId: string,
  name: string,
  title: string,
  detail?: string,
  argsText?: string
): void {
  const node = bubbleOf(turnId);
  if (!node) {
    return;
  }
  // 一輪剛開始留的那塊空正文（給「它在想」留的位）到這裡就沒意義了。
  dropEmptyText(node);
  if (name === 'generate') {
    // 卡片當場就建：正文馬上要順著 `toolDelta` 流進來，晚一步就沒地方放。
    node.insertBefore(
      buildGenCard({ callId, name, title, ok: true, summary: '', elapsedMs: -1, argsText, output: '' }),
      segmentAnchor(node)
    );
    scrollToBottom();
    return;
  }
  const strip = toolStripOf(turnId);
  if (!strip) {
    return;
  }
  strip.appendChild(buildPendingToolRow(callId, title, detail, argsText));
  scrollToBottom();
}

/**
 * 工具跑完了：把那一行（或那張卡）換成帶耗時與結果摘要的最終形態。
 *
 * **展開狀態要跟過去**：作者點開這一條是想盯著它看，整條重建時把它合回去，
 * 等於每次有結果就把他剛翻開的東西合上。
 *
 * generate 那張卡還有一件事：**正文不能丟**。它是順著 `toolDelta` 一段段攢在
 * 卡裡的，而這條 `toolResult` 里根本沒有它——重建時得把卡裡當下那份帶過去。
 * （落盤的結論隨後還會重推一次同樣的 `toolResult`，那時同樣不能把正文抹掉。）
 */
function settleToolCall(
  turnId: string,
  result: {
    callId: string;
    name: string;
    ok: boolean;
    summary: string;
    elapsedMs: number;
    argsText?: string;
    resultText?: string;
  }
): void {
  const node = bubbleOf(turnId);
  const card = node?.querySelector<HTMLDetailsElement>(`.gen[data-call="${result.callId}"]`);
  if (card) {
    const title = card.querySelector('.gen-title')?.textContent ?? result.name;
    const output = card.querySelector('.gen-body')?.textContent ?? '';
    card.replaceWith(buildGenCard({ ...result, title, output, open: card.open }));
    scrollToBottom();
    return;
  }
  const row = node?.querySelector<HTMLElement>(`.tool-row[data-call="${result.callId}"]`);
  if (!row) {
    return;
  }
  const title = row.querySelector('.tool-title')?.textContent ?? result.name;
  const open = row instanceof HTMLDetailsElement && row.open;
  row.replaceWith(buildToolRow({ ...result, title, open }));
  scrollToBottom();
}

renderChips();
vscode.postMessage({ type: 'ready' });