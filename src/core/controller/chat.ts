import type { ChatController } from './index';
import { basename } from 'node:path';
import { Artifact, describeArtifact } from '../features/artifact';
import { loreFolderOf } from '../features/loreList';
import { describeOutlineRewrite, outlineRewritePlan, rewriteOutline } from '../features/outlineRewrite';
import { confirmDespiteGap } from '../features/chapterGap';
import { acceptArtifact as writeArtifact, plannedCards, plannedLore } from '../generation/accept';
import { describeThreadPlan } from '../features/threadPlan';
import { plannedLoreSettle } from '../generation/loreSettle';
import { Draft, generate, parseDraftArtifact } from '../generation/generate';
import { getHost } from '../host';
import { readConfig } from '../config';
import { askCall } from '../features/askCall';
import { withCallChoice } from '../runtime/callScope';
import { askGate, askGateNoted, cancelGates } from './gate';
import type { GateVerdict } from './gate';
import { scoped } from '../runtime/logger';
import {
  ChatSession,
  ChatTurn,
  deriveTitle,
  isBuiltinAgentTurn,
  makeTurnId,
  normalizeRange,
  nowIso,
  turnPreview,
} from '../model/session';
import {
  Capability,
  CreationStage,
  CreationTarget,
  DEFAULT_CAPABILITY,
  LORE_EXPAND_CALLS,
  LORE_SETTLE_TARGET,
  ONE_CALL,
  OUTLINE_TARGET,
  PLOT_BATCH,
  TRANSCRIBED_SETTINGS,
  WriteMode,
  capabilitiesOn,
  commandOf,
  describeWriteLength,
  deriveBookStage,
  deriveNextStep,
  describeCalls,
  describeTarget,
  isCreationStage,
  isLoreSettle,
  isOutlineContinue,
  isSameTarget,
  normalizeTarget,
  outlineContinuation,
  outputKindOf,
  plotOfTarget,
  settingCalls,
  stageOfTarget,
} from '../model/pipeline';
import { isSettingFilled } from '../model/settingFile';
import { createLoreLookup, loreThin, splitLoreHidden } from '../model/loreFile';
import { slugify, uniqueSlug } from '../model/fs';
import { loreEntryAt } from '../views/loreMaterial';
import { Workspace, normalizeRel } from '../workspace';
import { isOutlineFilled, outlineOverlaps } from '../model/outlineFile';
import {
  ChapterAction,
  NextStepView,
  SendPayload,
  SerializedArtifact,
} from '../protocol';
import { bookStepView, buildPlotPipelineView } from '../views/projectView';
import { buildBookFacts, buildPlotPipeline, chapterOfPlotNo } from '../views/pipeline';
import { buildWorkbench } from '../views/workbench';
import { Plot, isPlotFilled, parsePlotFileName } from '../model/plotFile';
import { parseChapterFileName } from '../model/chapterFile';
import { isPlotPath } from '../files/fileOps';
import { Chapter, LoreEntry } from '../model/types';
import {
  ReviewIssueEdit,
  applyReviewEdits,
  describePicks,
  normalizeReport,
  pickableIds,
  relocatePicks,
  renderReport,
  renderRevisionBrief,
} from '../model/review';
import { PREFLIGHT_SUGGESTION, describeExempted, describeRisks, describeThreadNotes, preflightChapter } from '../features/preflight';
import { clearFailures } from '../runtime/errorLog';
import { persist } from './persist';
import {
  factsOf,
  serializeDigest,
  serializeSession,
  serializeTurn,
  targetOf,
} from './serialize';

const log = scoped('面板');

/** 創作頁：傳送、採納、目標與流水線。欄位只給 controller/ 同包用。 */

/**
 * `extra`：後端自己發起的那幾種輪次要記在使用者輪上的東西（按審稿修稿的清單與寫法）。前端發的
 * `send` 不帶它——`SendPayload.writeMode` 只認「接著寫 / 重寫」，修稿只能從報告卡進來。
 */
export async function send(
  c: ChatController,
  payload: SendPayload,
  extra?: Pick<ChatTurn, 'writeMode' | 'command' | 'revise'>
): Promise<void> {
  // 佔位必須在**任何 await 之前**：下面 `await persist(c)` 會讓出事件迴圈，
  // 那一瞬間 currentAbort 還沒設，緊跟著進來的第二條請求照樣能過 busy 檢查，
  // 於是兩條都跑起來、燒兩份 token。本機磁碟快，第一條往往一路同步跑完，
  // 所以這個競態只在 CI（或慢盤）上現形。
  const lease = c.beginGeneration();
  if (!lease) {
    c.toast('已有一個生成任務在進行中。', 'error');
    return;
  }
  // 從這裡往下任何一條提前 return 都要還位，否則這個 controller 從此發不出
  // 第二條訊息。
  let handedOff = false;
  try {
    // 空輸入只擋「討論」（它不是命令，`commandOf` 查不到它）。
    //
    // 舊介面一律要求先寫點什麼才能傳送，而「落定細綱」「寫細綱」「寫正文」
    // 本來就不需要作者說任何話——該說的都在架構、大綱與細綱裡了。逼他先編一句
    // 「請生成」，那句話還會被當成要求裝進 prompt。
    //
    // 討論例外：它的全部內容就是作者那句話，沒有話就沒有討論。
    const command = commandOf(payload.stage, payload.capability, normalizeTarget(payload.target));
    if (!payload.text.trim() && !command) {
      c.toast('請先輸入內容。', 'error');
      return;
    }
    // `/落定設定`（完善設定二期）在任何一層都能下：這一輪臨時把目標換成設定目錄，落完回到原來的地方。要沉澱的是
    // 剛才的討論——一句都沒聊過、輸入框也空著，模型只能憑空編一批「定下來的設定」，不如不調。
    const settlingLore = isLoreSettle(payload) && isSameTarget(normalizeTarget(payload.target), LORE_SETTLE_TARGET);
    if (settlingLore && !payload.text.trim() && !c.current.turns.some((t) => t.content.trim())) {
      c.toast('落定設定要把剛才討論裡定下來的設定寫成條目，可這個對話裡還沒有討論。先聊幾句，或者在輸入框裡寫明要定下什麼。', 'error');
      return;
    }
    // `/續寫大綱`（2026-10-24）也在任何一層都能下，跑完同樣回到原來的地方。前端不知道大綱排到了第幾章，不帶區間：
    // 這裡按大綱現在排到哪算（與主按鈕同一份 `outlineNextRange`）；主按鈕帶著狀態機算好的區間來，照用。
    // 續不了（排滿了、要續的那一段已經有正文）就說一句，不調模型。
    const continuingOutline = isOutlineContinue(payload);
    let range = normalizeRange(payload.range);
    if (continuingOutline && !range) {
      const plan = outlineContinuation(await buildBookFacts(c.project));
      if ('blocked' in plan) {
        c.toast(plan.blocked, 'error');
        return;
      }
      range = plan.range;
    }

    const userTurn: ChatTurn = {
      id: makeTurnId(),
      role: 'user',
      content: payload.text.trim(),
      at: nowIso(),
      // 點命令時輸入框可以是空的，氣泡裡就只剩一片空白。記下這一輪下的是哪個
      // 命令，介面才說得出「剛才那一下是 /落定細綱」。「討論」是預設動作，不記。
      command: payload.capability === 'discuss' ? undefined : command?.label,
      attachments: c.pending.length > 0 ? [...c.pending] : undefined,
      excludedIds: payload.excludedIds.length > 0 ? payload.excludedIds : undefined,
      // 重來一輪時要原樣重跑，而那條路上前端給的是輸入框當下的引數。
      range,
      setup: normalizeSetup(payload.setup),
      writeMode: normalizeWriteMode(payload.writeMode),
      ...(settlingLore ? { settleLore: true } : {}),
      ...(continuingOutline ? { continueOutline: true } : {}),
      ...(extra ?? {}),
    };
    const away = awayOf(userTurn);
    const back = away && !atSpot(c, away) ? spotOf(c) : undefined;
    c.current.turns.push(userTurn);
    if (c.current.turns.length === 1) {
      c.current.title = deriveTitle(turnPreview(userTurn));
    }
    applyAction(c, payload);
    c.current.targetNo = payload.targetNo;
    c.pending = [];

    c.post({ type: 'turnDone', turn: serializeTurn(userTurn) });
    c.post({ type: 'attachments', items: [] });
    await persist(c);

    // 位子交給 runTurn，由它在 finally 裡還——這裡不能再還一次。
    handedOff = true;
    try {
      await runTurn(c, payload, userTurn, lease);
    } finally {
      if (away && back) {
        await returnTo(c, back, away);
      }
    }
  } finally {
    if (!handedOff) {
      lease.release();
    }
  }
}

/** 重來一輪：丟掉舊回覆，用同一條使用者訊息重新生成。 */
export async function retry(c: ChatController, turnId: string, payload: SendPayload): Promise<void> {
  if (c.busy) {
    c.toast('已有一個生成任務在進行中。', 'error');
    return;
  }
  const idx = c.current.turns.findIndex((t) => t.id === turnId);
  if (idx === -1) {
    return;
  }
  const userTurn = c.current.turns[idx];
  if (userTurn.role !== 'user') {
    return;
  }
  // 丟掉這條使用者訊息之後的所有輪次——重來意味著從這裡分叉。
  c.current.turns.splice(idx + 1);
  c.post({ type: 'session', session: serializeSession(c.current) });
  // `/落定設定`、`/續寫大綱` 那一輪：會話早已回到原來的目標，照樣換過去、跑完再換回來（同 `send`）。
  const away = awayOf(userTurn);
  const back = away && !atSpot(c, away) ? spotOf(c) : undefined;
  if (away && back) {
    c.current.target = away.target;
    c.current.stage = away.stage;
    c.current.capability = away.capability;
  }
  try {
    await runTurn(c, { ...payload, text: userTurn.content }, userTurn);
  } finally {
    if (away && back) {
      await returnTo(c, back, away);
    }
  }
}

/** 會話停在哪：目標、階段、能力。跨層命令那一輪之前記下，跑完回到這裡。 */
type Spot = Pick<ChatSession, 'target' | 'stage' | 'capability'>;

function spotOf(c: ChatController): Spot {
  return { target: c.current.target, stage: c.current.stage, capability: c.current.capability };
}

function atSpot(c: ChatController, spot: Spot): boolean {
  return c.current.stage === spot.stage && c.current.capability === spot.capability && isSameTarget(c.current.target, spot.target);
}

/** 跨層命令這一輪要換到哪（`/落定設定` → 設定目錄，`/續寫大綱` → 情節大綱）。別的輪次就在會話停著的地方跑。 */
function awayOf(turn: Pick<ChatTurn, 'settleLore' | 'continueOutline'>): (Spot & { label: string }) | undefined {
  if (turn.settleLore) {
    return { target: LORE_SETTLE_TARGET, stage: 'setting', capability: 'settle', label: '落定設定' };
  }
  if (turn.continueOutline) {
    return { target: OUTLINE_TARGET, stage: 'outline', capability: 'generate', label: '續寫大綱' };
  }
  return undefined;
}

/**
 * 跨層命令那一輪完了（寫了、沒寫、出錯、被停）：回到之前停著的那個目標。這一輪期間作者已經另選了目標的
 * （生成跑完、落盤卡片還在等的那會兒，切目標不被擋）不動——那是他自己選的。
 */
async function returnTo(c: ChatController, back: Spot, away: Spot & { label: string }): Promise<void> {
  if (!atSpot(c, away)) {
    return;
  }
  c.current.target = back.target;
  c.current.stage = back.stage;
  c.current.capability = back.capability;
  log.info(`${away.label}完了，創作目標回到 ${await describeCurrentTarget(c)}`);
  await persist(c);
  c.post({ type: 'session', session: serializeSession(c.current) });
  await pushPipeline(c);
}

export async function runTurn(
  c: ChatController,
  payload: SendPayload,
  userTurn: ChatTurn,
  held?: ReturnType<ChatController['beginGeneration']>
): Promise<void> {
  // 上一輪那張還沒答的落盤卡片就此作廢：它掛在上一條氣泡上，點下去寫的是
  // 一份作者已經翻篇的產物。
  cancelGates(c);
  // 併發控制在 controller：生成那一層是無狀態的，「有沒有在跑」是排程的事。
  //
  // `send` 已經在它的第一行佔過位了（那裡必須早於任何 await，否則兩條請求
  // 會雙雙過檢）。它把位子傳進來，這裡就不再搶第二次——同一個 controller
  // 上搶不到，會把自己拒掉。retry 那條路沒有前置佔位，仍走這裡現搶。
  const lease = held ?? c.beginGeneration();
  if (!lease) {
    c.toast('已有一個生成任務在進行中。', 'error');
    return;
  }
  c.post({ type: 'busy', value: true });

  const assistantTurn: ChatTurn = {
    id: makeTurnId(),
    role: 'assistant',
    content: '',
    at: nowIso(),
  };
  // 先插一條空回覆，前端好掛流式內容。
  c.current.turns.push(assistantTurn);
  c.post({ type: 'turnDone', turn: serializeTurn(assistantTurn) });

  // 歷史是本輪之前的所有輪次（不含剛插入的兩條）。內建 agent 那幾輪即使沒說話也留著：
  // 歷史層要靠它認出前面那句是交給 agent 的指令，一起跳過。
  const history = c.current.turns.slice(0, -2).filter((t) => t.content.trim() || isBuiltinAgentTurn(t));

  const action = { stage: c.current.stage, capability: c.current.capability };
  const range = rangeFor(action, normalizeRange(payload.range) ?? userTurn.range);
  const setup = action.stage === 'setting' ? (normalizeSetup(payload.setup) ?? userTurn.setup) : undefined;
  // 修稿那一輪的寫法記在使用者輪上（前端的 payload 永遠不帶 revise）；重來一輪時照樣認得出來。
  const writeMode =
    action.stage === 'manuscript' && action.capability === 'generate'
      ? userTurn.writeMode === 'revise'
        ? 'revise'
        : (normalizeWriteMode(payload.writeMode) ?? userTurn.writeMode)
      : undefined;

  // 動手之前的兩道：修稿先按報告與此刻的正文拼好清單；寫一章之前先做一致性預檢（零呼叫）。
  // 任何一道攔下，這一輪就不調模型，回覆裡寫明為什麼停。
  const before = await beforeGenerate(c, { action, writeMode, userTurn, assistantTurn, signal: lease.signal });
  if (!before.go) {
    lease.release();
    c.post({ type: 'busy', value: false });
    if (before.error) {
      assistantTurn.error = before.error;
      c.toast(before.error, 'error');
    } else {
      assistantTurn.content = before.content ?? '';
      assistantTurn.interrupted = before.interrupted || undefined;
    }
    c.post({ type: 'turnDone', turn: serializeTurn(assistantTurn) });
    await persist(c);
    return;
  }

  let built;
  let draft: Draft | undefined;
  try {
    ({ built, draft } = await generate(
      c.project,
      {
        action,
        target: c.current.target,
        targetNo: range?.from ?? payload.targetNo,
        ask: userTurn.content,
        range,
        setup,
        writeMode,
        ...(before.reviseBrief ? { reviseBrief: before.reviseBrief } : {}),
        // 目標字數只有一處來源：細綱的 `targetWords`，沒寫就是配置的每章字數。
        // 從前輸入框下面還有一個（預設 2000），作者分不清哪個生效（W1）。
        targetWords: await targetWordsOf(c, c.current.target),
        excludedIds: userTurn.excludedIds,
        attachments: userTurn.attachments,
        history,
      },
      {
        onDelta: (delta) => c.post({ type: 'delta', turnId: assistantTurn.id, text: delta }),
        // 推理模型可能先思考幾十秒才開始吐正文。把思考也推給前端，
        // 否則那段時間氣泡是空的，看起來就像卡住、最後一次性蹦出來。
        onReasoning: (delta, full) => {
          assistantTurn.reasoning = full;
          c.post({ type: 'reasoning', turnId: assistantTurn.id, text: delta });
        },
        onDone: (full) => {
          assistantTurn.content = full;
        },
        onError: (message) => {
          assistantTurn.error = message;
        },
        onCancelled: () => {
          assistantTurn.interrupted = true;
        },
        // 寫正文時氣泡頂上那條進度（W7）：第幾輪、寫到多少字、目標多少。
        onProgress: (p) => c.post({ type: 'writeProgress', turnId: assistantTurn.id, ...p }),
        onReset: (full) => c.post({ type: 'streamReset', turnId: assistantTurn.id, text: full }),
      },
      // 作者在這個會話上選的那一檔。第 12 條的另一面：**只有對話頁選定的
      // 那個模型**吃它，工程頁的批次任務不吃。
      { signal: lease.signal, thinking: c.current.thinking }
    ));
  } finally {
    lease.release();
  }

  c.post({ type: 'busy', value: false });

  if (built) {
    assistantTurn.context = serializeDigest(built);
    // 發出去的那份原樣留下，「複製完整上下文」取它。隨會話落盤，不隨 turnDone 推（見 ChatTurn.contextMessages）。
    assistantTurn.contextMessages = built.messages.map(({ role, content }) => ({ role, content }));
    c.post({ type: 'context', turnId: assistantTurn.id, digest: assistantTurn.context });
  }
  // 修稿時重新定位清單的說明排在最前：「正文在審稿之後改過，兩條作廢」比續寫幾輪更要緊。
  if (draft && before.notes?.length) {
    draft.notes = [...before.notes, ...(draft.notes ?? [])];
  }
  // 審稿報告（D22）：不落盤，隨會話儲存——草稿表裡一份、這一輪上一份（報告卡照它畫）。
  // 沒有 artifact，所以下面那張落盤卡片不會出現。
  if (draft?.review) {
    c.drafts.put(draft, c.current.id);
    c.current.drafts = c.drafts.bySession(c.current.id);
    assistantTurn.review = {
      report: draft.review,
      ...(draft.notes?.length ? { notes: draft.notes } : {}),
      ...(draft.calls ? { calls: draft.calls } : {}),
    };
  }
  // 產出的是可落盤的東西時，把落點與形狀一起記下——卡片上要說清
  // 「新建 5 張角色卡，寫到哪」，而不是一句光禿禿的「確定嗎」。
  //
  // **不再重新解析一遍**：draft 出廠就帶 artifact 與 summary。從前這裡
  // 是三次解析裡多餘的那一次。
  if (draft?.artifact) {
    c.drafts.put(draft, c.current.id);
    c.current.drafts = c.drafts.bySession(c.current.id);
    const creates = await plannedCards(c.project, draft.artifact);
    const createsLore = await plannedLore(c.project, draft.artifact);
    const threadPlan = await describeThreadPlan(c.project, draft.target, draft.artifact);
    assistantTurn.artifact = {
      where: await whereOf(c, action, draft.target, draft.range),
      summary: draft.summary ?? describeArtifact(draft.artifact),
      overwrites: await targetHasContent(c, action, draft.target, draft.range, draft.writeMode),
      ...(creates.length > 0 ? { creates } : {}),
      ...(createsLore.length > 0 ? { createsLore } : {}),
      ...(threadPlan.length > 0 ? { threadPlan } : {}),
      ...(await settledOf(c, draft.artifact)),
      ...questionsOf(draft.artifact),
      ...(draft.notes?.length ? { notes: draft.notes } : {}),
      ...(draft.calls ? { calls: draft.calls } : {}),
      ...writingOf(draft),
    };
  }
  if (assistantTurn.error) {
    c.toast(assistantTurn.error, 'error');
  }
  c.post({ type: 'turnDone', turn: serializeTurn(assistantTurn) });
  await persist(c);
  // 這一輪可能把某一層的產物寫過——重新整理流水線條。
  await pushPipeline(c);

  // 第 19 條：產物落盤前必須過一遍人。**在這裡問，不是留一顆按鈕**——
  // 先推完 turnDone（氣泡定稿、可以就地改）再問，作者要改完再寫得來及。
  if (draft?.artifact && assistantTurn.artifact && !assistantTurn.error && !assistantTurn.interrupted) {
    const r = await askArtifact(c, {
      turnId: assistantTurn.id,
      draft,
      art: assistantTurn.artifact,
      // 氣泡裡當下那份：作者在卡片上點寫入之前可能剛改過（blur 時經
      // `editTurn` 落在這裡），改了的那份才是他要的。
      raw: () => assistantTurn.content,
    });
    if (r.relPath) {
      assistantTurn.acceptedTo = r.relPath;
    } else {
      // 沒寫成也要留痕：翻回來看得出這一輪產出過什麼、以及它沒落盤。
      assistantTurn.artifact = { ...assistantTurn.artifact, declined: true };
    }
    await persist(c);
    c.post({ type: 'turnDone', turn: serializeTurn(assistantTurn) });
  }
}

/**
 * 這一輪的回覆能不能採納，以及採納到哪裡。
 *
 * 兩條路進來：
 *
 * - **重開舊會話**這類拿不到 draft 的（單步生成路徑直接讀 `draft.artifact`）——
 *   那時按會話當下的 stage/capability/target 算；
 * - **agent 那條路**：draft 的 action 與 target 是它自己定的（agent 可能在
 *   作者選著第 12 章時去改了第 9 章），所以**必須以 draft 為準**，拿
 *   `c.current` 頂上會把落點說成另一章。
 *
 * 解析在這裡跑一遍只是為了**畫介面**（幾場？覆蓋誰？），真正落盤時
 * `acceptArtifact` 會拿氣泡裡當時的文字重新解析——使用者可能改過。
 */
export async function describeArtifactOf(
  c: ChatController,
  content: string,
  draft?: Pick<Draft, 'action' | 'target' | 'range' | 'notes' | 'calls' | 'writeMode' | 'length' | 'replay'>
): Promise<SerializedArtifact | undefined> {
  const action = draft?.action ?? { stage: c.current.stage, capability: c.current.capability };
  const target = draft?.target ?? c.current.target;
  if (outputKindOf(action) !== 'artifact' || !content.trim()) {
    return undefined;
  }
  const artifact = parseDraftArtifact(action, content, target, draft?.range);
  if (!artifact) {
    return undefined;
  }
  const creates = await plannedCards(c.project, artifact);
  const createsLore = await plannedLore(c.project, artifact);
  const threadPlan = await describeThreadPlan(c.project, target, artifact);
  return {
    where: await whereOf(c, action, target, draft?.range),
    summary: describeArtifact(artifact),
    overwrites: await targetHasContent(c, action, target, draft?.range, draft?.writeMode),
    ...(creates.length > 0 ? { creates } : {}),
    ...(createsLore.length > 0 ? { createsLore } : {}),
    ...(threadPlan.length > 0 ? { threadPlan } : {}),
    ...(await settledOf(c, artifact)),
    ...questionsOf(artifact),
    ...(draft?.notes?.length ? { notes: draft.notes } : {}),
    ...(draft?.calls ? { calls: draft.calls } : {}),
    ...(draft ? writingOf(draft) : {}),
  };
}

/**
 * 產物落到哪：卡片標題與氣泡末尾那一行。落定設定的目標是設定目錄，可它寫的不是設定清單——說成「設定名錄」。
 */
async function whereOf(
  c: ChatController,
  action: { stage: CreationStage; capability: Capability },
  target: CreationTarget,
  range?: { from: number; to: number }
): Promise<string> {
  return isLoreSettle(action) ? '設定名錄' : describeTargetOf(c, target, range);
}

/** 落定設定會更新的已有條目（按磁碟認，與落盤同一遍，generation/loreSettle.ts）。「會新建」那一半在 `plannedLore`。 */
async function settledOf(c: ChatController, artifact: Artifact): Promise<Partial<SerializedArtifact>> {
  if (artifact.kind !== 'loreEntries' || !artifact.settle) {
    return {};
  }
  const { updates } = await plannedLoreSettle(c.project, artifact.entries);
  return updates.length > 0 ? { updatesLore: updates } : {};
}

/** 展開一條設定、落定設定附的「還沒定的問題」：只上卡片（`SerializedArtifact.questions`），不落盤。 */
function questionsOf(artifact: Artifact): Partial<SerializedArtifact> {
  return artifact.kind === 'loreEntries' && artifact.questions.length > 0 ? { questions: [...artifact.questions] } : {};
}

/** 正文那幾樣要攤在卡片上的事：寫了多長、是不是追加、有沒有重演上一章結尾（W7）。 */
function writingOf(draft: Pick<Draft, 'length' | 'replay' | 'writeMode'>): Partial<SerializedArtifact> {
  return {
    ...(draft.length ? { length: draft.length } : {}),
    ...(draft.replay ? { replay: draft.replay } : {}),
    ...(draft.writeMode === 'continue' ? { append: true } : {}),
  };
}

/**
 * 這一輪請求真正帶下去的區間。只有兩處認它：細綱的「生成」（給了就是一批，
 * 對話頁一批最多 {@link PLOT_BATCH} 章——更長的區間走工程頁的批次拆細綱）與
 * 大綱的「生成」（只寫那一段）。落定細綱只落一章，討論不需要區間。
 */
function rangeFor(
  action: { stage: CreationStage; capability: Capability },
  range: { from: number; to: number } | undefined
): { from: number; to: number } | undefined {
  if (!range || action.capability !== 'generate') {
    return undefined;
  }
  if (action.stage === 'plot') {
    return { from: range.from, to: Math.min(range.to, range.from + PLOT_BATCH - 1) };
  }
  return action.stage === 'outline' ? range : undefined;
}

/** 前端給的寫法：只認「接著寫」「重寫」兩種，其餘當沒給（由磁碟定）。 */
function normalizeWriteMode(raw: unknown): 'continue' | 'rewrite' | undefined {
  return raw === 'continue' || raw === 'rewrite' ? raw : undefined;
}

/** 一句話彈窗的規模：兩個數都得是正整數，否則當沒給。 */
function normalizeSetup(raw: unknown): { totalChapters: number; wordsPerChapter: number } | undefined {
  const o = (raw ?? {}) as { totalChapters?: unknown; wordsPerChapter?: unknown };
  const total = typeof o.totalChapters === 'number' ? Math.floor(o.totalChapters) : NaN;
  const words = typeof o.wordsPerChapter === 'number' ? Math.floor(o.wordsPerChapter) : NaN;
  return total > 0 && words > 0 ? { totalChapters: total, wordsPerChapter: words } : undefined;
}

/**
 * 採納的落點上已經有東西了——按鈕文案據此改成「覆蓋…」。
 *
 * 只看**這一層自己的產物**，而且只認「填過」：一份只有佔位的模板說「會覆蓋」
 * 是嚇唬人。角色圖譜、設定清單永遠是 false——只建新卡 / 新條目（同名走各自的審閱）。正文看寫法：
 * 「接著寫」是追加，不覆蓋；其餘在這一章已有正文時是整章覆蓋。單條設定（展開）與落盤同一個判據
 * （generation/accept.ts 的 `acceptLoreEntries`）：明面正文是空的、是佔位、又沒有暗設才不算覆蓋。
 */
export async function targetHasContent(
  c: ChatController,
  action: { stage: CreationStage; capability: Capability } = {
    stage: c.current.stage,
    capability: c.current.capability,
  },
  target: CreationTarget = c.current.target,
  range?: { from: number; to: number },
  writeMode?: WriteMode
): Promise<boolean> {
  void action;
  // 帶區間時只看區間裡：續寫第 21–40 章的大綱不覆蓋前 20 章，一批細綱只覆蓋這幾章。
  if (range && target.kind === 'outline') {
    return outlineOverlaps(await c.project.readOutline(), range);
  }
  if (range && target.kind === 'plot') {
    const plots = await c.project.listChapterPlots();
    return plots.some((p) => p.no >= range.from && p.no <= range.to && isPlotFilled(p.sections));
  }
  switch (target.kind) {
    case 'setting': {
      if (target.doc === 'characters' || target.doc === 'lore') {
        return false;
      }
      const doc = await c.project.readSettingDoc(target.doc);
      return isSettingFilled(target.doc, doc.sections);
    }
    case 'outline':
      return isOutlineFilled(await c.project.readOutline());
    case 'plot': {
      const plot = await c.project.resolvePlot(target.plotRelPath);
      return !!plot && isPlotFilled(plot.sections);
    }
    case 'manuscript': {
      if (writeMode === 'continue') {
        return false;
      }
      const no = parsePlotFileName(basename(target.plotRelPath))?.no ?? (await c.project.resolvePlot(target.plotRelPath))?.no;
      const chapter = no !== undefined ? await c.project.getChapter(no) : undefined;
      return !!chapter && chapter.wordCount > 0;
    }
    case 'lore': {
      const { entry, exists } = await loreEntryAt(c.project, target.relPath);
      const thin = loreThin(entry);
      return exists && !((thin === 'empty' || thin === 'placeholder') && !splitLoreHidden(entry.body).hidden);
    }
  }
}

/**
 * 這一輪生成的目標字數：細綱的 `targetWords`，沒寫就是 `config.md` 的每章字數。
 * 只有細綱與正文兩層談得上「這一章寫多長」。
 */
async function targetWordsOf(c: ChatController, target: CreationTarget): Promise<number | undefined> {
  const relPath = plotOfTarget(target);
  if (!relPath) {
    return undefined;
  }
  const plot = await c.project.resolvePlot(relPath);
  return plot?.targetWords ?? (await c.project.readBookConfig()).wordsPerChapter;
}

/**
 * 產物落盤前那一句問，以及同意之後的落盤。**第 19 條的落點。**
 *
 * ## 為什麼是一張卡片，不是一顆按鈕
 *
 * 從前這裡是氣泡末尾那顆「採納寫入」：它可以拖到第二天再點，於是
 * 「產物落盤前必須過一遍人」在介面上是一顆**可以永遠不點的按鈕**——而
 * agent 早就接著往下做了，作者手上攢著三份沒落地的產物，誰也說不清哪份
 * 已經寫過。現在它和別的動手請求（寫檔案、改一段字）長一個樣、在同一個
 * 位置、**產出的當下就問**（[gate.ts](gate.ts)）。
 *
 * ## 不交給宿主的許可權配置
 *
 * 外部 agent 的宿主（Claude Code 之類）自己有一層「讓不讓調這個工具」的許可權，
 * 可以被設成全自動。這一問不在那一層：**任何情況下都問**（`controller/mcp.ts`
 * 產出草稿後照樣走這裡）。那是產品承諾（第 19 條），不是偏好設定。
 *
 * ## 落點從 draft 裡取，不由前端傳
 *
 * 前端猜不出一段討論該寫到哪一層。從前採納按鈕發的是 `store.session.target`
 * ——那是**當下**選中的目標，作者生成完切了一章再點採納，產物就寫到別的
 * 地方去了。
 *
 * `raw` 預設用 `draft.raw`（模型產出的原文）。單步創作那條路傳的是氣泡裡
 * 當下的文字：作者可以先在氣泡裡改完再點寫入，那份改動經 `editTurn` 已經
 * 落在 `turn.content` 上。
 *
 * 目標已有內容時，落盤那一步還會走 workspace 閘道器的覆蓋審閱（外掛開 diff）
 * ——那是另一層，與這一問無關，兩層都過了才真的改磁碟。
 */
export async function askArtifact(
  c: ChatController,
  ask: {
    turnId: string;
    draft: Draft;
    art: SerializedArtifact;
    /** 誰在要求寫。隻影響那句話的主語（「Agent 要把生成的產物…」）。 */
    byAgent?: boolean;
    callId?: string;
    /**
     * 要落盤的那份文字，**答完之後才取**（所以是個函式）：作者在卡片上點寫入
     * 之前可能剛在氣泡裡改過，取早了拿到的是他改之前那份。
     */
    raw?: () => string;
    /** 寫完要不要順手開啟它。單步創作開啟（作者正盯著這一份），agent 不開啟——它可能連著寫好幾份。 */
    open?: boolean;
    signal?: AbortSignal;
  }
): Promise<{ verdict: GateVerdict; relPath?: string; message: string }> {
  const { art, draft } = ask;
  const what = art.overwrites ? '覆蓋' : art.append ? '追加' : '寫入';
  const verdict = await askGate(
    c,
    {
      turnId: ask.turnId,
      callId: ask.callId,
      name: 'artifact',
      title: `${ask.byAgent ? 'Agent 要把生成的產物' : '把這份產物'}${what}到「${art.where}」`,
      detail: artifactDetail(art),
      skip: '不採納',
      // 重演上一章結尾：標紅、寫明重合的原句，寫入要點兩下（總計劃 §2.4）。不替作者拒收——
      // 有時重合的是一句刻意呼應的臺詞。
      ...(art.replay
        ? {
            danger: `開頭與上一章結尾大段重合，可能把上一章最後一場又演了一遍：\n「${clipQuote(art.replay)}」`,
            confirm: '確定仍要寫入',
          }
        : {}),
    },
    ask.signal
  );
  if (verdict !== 'proceed') {
    return { verdict, message: '作者沒有採納這份產物，磁碟上什麼都沒變。' };
  }

  // 氣泡裡當下那份優先（作者可能改過），空了退回生成時那份原文。
  const edited = ask.raw?.();
  let raw = edited?.trim() ? edited : draft.raw;
  if (!raw.trim()) {
    c.toast('內容是空的。', 'error');
    return { verdict, message: '內容是空的，沒有寫入任何檔案。' };
  }
  // 刪修飾刪過字：逐段對照刪之前那一版，作者可以把刪錯的退回原文。作者已經在氣泡裡改過就不問——
  // 合併檢視拿刪之前那版對著他改過的那份，標出來的改動裡混著他自己的字。
  const host = getHost();
  if (draft.untrimmed && host.mergeTexts && raw.trim() === draft.raw.trim()) {
    const picked = await host.mergeTexts('刪修飾：刪之前 ↔ 刪之後（可以逐段退回原文）', draft.untrimmed, raw);
    if (typeof picked === 'object') {
      raw = picked.merged;
    } else if (picked !== 'apply') {
      return { verdict, message: '作者在刪修飾的對照裡放棄了寫入，磁碟上什麼都沒變。' };
    }
  }
  // **重新解析一遍**而不是用 `draft.artifact`：作者可能在氣泡裡改過。
  const artifact = parseDraftArtifact(draft.action, raw, draft.target, draft.range);
  if (!artifact) {
    // 解析不出來時**不寫**。寫一個空產物比不寫更糟：作者會以為存下了。
    log.warn('產物解析不出內容，未寫入', `階段 ${draft.action.stage}·${draft.action.capability}`);
    c.toast('這段內容解析不出可採納的產物，沒有寫入任何檔案。', 'error');
    return { verdict, message: '這段內容解析不出可寫入的產物，沒有寫入任何檔案。' };
  }

  // 正文按生成那一刻定下的寫法落盤：「接著寫」追加，其餘在已有正文時覆蓋審閱。
  const result = await writeArtifact(c.project, draft.target, artifact, { writeMode: draft.writeMode });
  c.toast(result.message);
  if (result.skipped || !result.relPath) {
    return { verdict, message: result.message };
  }
  // 細綱落在佔位路徑（`summaries/003.md`）上時，檔案其實按標題落成了 `003-雪夜.md`。
  // 會話還指著佔位路徑的話，下一輪寫正文、再點一次寫細綱都會對著一份「不存在」的細綱
  // ——改成真實路徑。不走 setTarget：那會把能力重置、把頁籤切走。
  if (draft.target.kind === 'plot' && result.relPath !== draft.target.plotRelPath && isPlotPath(c.project, result.relPath)) {
    await retargetPlot(c, draft.target.plotRelPath, result.relPath);
  }
  if (ask.open !== false) {
    await getHost().openFile(result.relPath);
  }
  // pushState 連流水線條一起推。
  await c.pushState();
  return { verdict, relPath: result.relPath, message: result.message };
}

/**
 * 落盤卡片上那幾行字：形狀、會新建哪幾張角色卡（D19）、會不會先對比、調了幾次模型、
 * 這一路上的降級（第 2 條）。**動手之前全攤開**——寫完再說「順便建了三張卡」就晚了。
 */
function artifactDetail(art: SerializedArtifact): string {
  const lines = [art.summary];
  if (art.length) {
    lines.push(describeWriteLength(art.length, art.append));
  }
  if (art.creates?.length) {
    lines.push(`會新建角色卡：${art.creates.join('、')}`);
  }
  if (art.createsLore?.length) {
    lines.push(`會新建設定條目：${art.createsLore.join('、')}`);
  }
  // 敘事線的計劃隨細綱寫進各條線（敘事線二期）：寫進哪幾條、換掉原來的幾條、沒認出的，動手之前攤開。
  if (art.threadPlan?.length) {
    lines.push(...art.threadPlan);
  }
  // 落定設定（二期）：改已有條目的，寫過內容的寫入前逐條對比。
  if (art.updatesLore?.length) {
    lines.push(`會更新設定條目：${art.updatesLore.join('、')}（寫過內容的寫入前逐條對比）`);
  }
  // 展開一條設定、落定設定附的問題：只在這裡列，不寫進任何檔案；作者在對話裡答完再來一次。
  if (art.questions?.length) {
    lines.push(`還沒定的（不寫進檔案，在對話裡答完可以再來一次）：\n${art.questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`);
  }
  if (art.overwrites) {
    lines.push('那裡已經有內容了，寫入前會讓你先對比一遍。');
  }
  if (art.calls && art.calls > 1) {
    const rounds = art.length?.rounds ? `（續寫 ${art.length.rounds} 輪）` : '';
    lines.push(`這一輪一共調了 ${art.calls} 次模型${rounds}。`);
  }
  for (const note of art.notes ?? []) {
    lines.push(`· ${note}`);
  }
  return lines.join('\n');
}

/** 重演的那一段太長時只攤開頭：卡片上放不下一整段，作者認得出是哪一段就夠了。 */
function clipQuote(text: string, max = 120): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * 章節工作臺工具條上的按鈕（W6）：對這一章做一件事。
 *
 * 寫這一章 / 接著寫 / 重寫 **等於對這一章按下主按鈕**：切到它的正文層，按那種寫法發一輪
 * 生成（輸入框裡沒有話——該說的都在細綱裡）。生成照樣在對話頁流式輸出、照樣當場問寫不寫
 * （第 19 條），與主按鈕是同一條路，只是入口在編輯器上方。定稿走工程動作。
 */
export async function chapterAction(c: ChatController, plotRelPath: string, action: ChapterAction): Promise<void> {
  if (c.busy) {
    c.toast('已有一個生成任務在進行中。', 'error');
    return;
  }
  const entry = await resolvePlotTarget(c, plotRelPath);
  if (!entry) {
    c.toast('這一章不存在，可能剛被改名或刪除。', 'error');
    return;
  }
  if (action === 'finalize') {
    if (!entry.chapter) {
      c.toast('這一章還沒有正文，無法同步。', 'error');
      return;
    }
    await c.dispatch({ type: 'projectAction', action: 'finalizeChapter', relPath: entry.chapter.relPath });
    return;
  }
  if (action === 'review' && !(entry.chapter && entry.chapter.wordCount > 0)) {
    c.toast('這一章還沒有正文，沒法審稿。', 'error');
    return;
  }
  const target: CreationTarget = {
    kind: 'manuscript',
    plotRelPath: entry.plot?.relPath ?? (await c.project.plotPathOfNo(entry.no, entry.chapter?.title ?? '')),
  };
  await setTarget(c, target);
  await send(c, {
    text: '',
    stage: 'manuscript',
    // 審稿（五期）：與寫這一章同一條路，只是能力換成 review——只出報告，沒有落盤卡片。
    capability: action === 'review' ? 'review' : 'generate',
    target,
    targetNo: entry.no,
    attachments: [],
    excludedIds: [],
    ...(action === 'continue' || action === 'rewrite' ? { writeMode: action } : {}),
  });
}

/**
 * 工程頁「故事架構」那幾行右鍵「重寫…」：對那一件**直接發一輪生成**。
 *
 * 先問一句重寫要求——留空就是照上游重來一遍，寫了就是修改意見（生成層本來就這麼讀輸入）；
 * 再彈確認框報次數、挑這一次的模型與詳細度（features/askCall.ts）；哪一問取消都什麼都不做。
 * 生成照樣在對話頁流式輸出，覆蓋前照樣先對比（第 19 條）。
 * 「討論」走 `setTarget`：只進入這一層，不花錢。
 *
 * 情節大綱認得出章標題時不走對話頁：按 20 章一段重寫，寫完一次對比（features/outlineRewrite.ts）。
 */
export async function rewriteArchitecture(c: ChatController, target: CreationTarget): Promise<void> {
  if (target.kind !== 'setting' && target.kind !== 'outline') {
    return;
  }
  if (c.busy) {
    c.toast('已有一個生成任務在進行中。', 'error');
    return;
  }
  const where = describeTarget(target);
  if (!(await confirmDespiteGap(await c.project.listChapters(), `重寫${where}`))) {
    return;
  }
  // 有條目的大綱按段重寫（features/outlineRewrite.ts）：一次寫全書，後半段稀得像目錄。只重寫還沒寫正文的章。
  const plan = target.kind === 'outline' ? await outlineRewritePlan(c.project) : undefined;
  if (plan && plan.batches.length === 0) {
    c.toast(`情節大綱排到第 ${plan.end} 章，都已經寫了正文：寫過的章，大綱那一條是同步時照正文寫的，不重寫。要往後排，用主按鈕續寫大綱。`);
    return;
  }
  const ask = await getHost().input({
    title: `重寫${where}`,
    prompt: plan
      ? `這次要怎麼改？${describeOutlineRewrite(plan)}`
      : '這次要怎麼改？留空就照上游重新生成一遍。寫入前會先讓你對比。',
    placeHolder: '例如：主角的金手指換成……；節奏再快一點',
    multiline: true,
  });
  if (ask === undefined) {
    return;
  }
  if (plan) {
    const n = plan.batches.length;
    const answer = await askCall({
      message: `重寫${where}：${describeCalls({ low: n, high: n, max: n })}。`,
      actions: ['開始重寫'],
      detail: describeOutlineRewrite(plan),
      tasks: ['plotOutline'],
      contextDetail: true,
    });
    if (answer?.action !== '開始重寫') {
      return;
    }
    await withCallChoice(answer.choice, () => rewriteOutline(c.project, plan, ask.trim()));
    await c.pushState();
    return;
  }
  // 其餘幾件在對話頁生成：模型預設是對話頁那個（與不問時一樣），換了就只這一輪用它（generate 認 `pinnedModel`）。
  const answer = await askCall({
    message: `重寫${where}：在對話頁${ask.trim() ? '按你的要求' : '照上游'}重新生成一份，寫入前先讓你對比。${describeCalls(target.kind === 'setting' ? settingCalls(target.doc) : ONE_CALL)}。`,
    actions: ['開始重寫'],
    // 配置、角色圖譜、設定清單寫完由轉寫模型照抄成 JSON（2026-10-25 起），單列一行說清轉寫交給誰。
    tasks: target.kind === 'setting' && TRANSCRIBED_SETTINGS.includes(target.doc) ? ['transcribe'] : [],
    contextDetail: true,
    preset: { model: readConfig().model || undefined },
  });
  if (answer?.action !== '開始重寫') {
    return;
  }
  await withCallChoice(answer.choice, async () => {
    await setTarget(c, target);
    await send(c, {
      text: ask.trim(),
      stage: stageOfTarget(target),
      capability: 'generate',
      target,
      targetNo: c.current.targetNo ?? 1,
      attachments: [],
      excludedIds: [],
    });
  });
}

/**
 * 工程頁設定條目、「待完善」那一行右鍵「展開…」（完善設定，2026-10-19）：把對話頁的目標換成這一條設定，
 * **直接發一輪生成**（展開）。照 {@link rewriteArchitecture} 那條路：先問一句要求（留空就照已排的細綱去想；
 * 取消就什麼都不做），生成照樣在對話頁流式輸出、照樣當場問寫不寫，已經有內容的條目覆蓋前先對比（第 19、3 條）。
 * 問完要求再彈確認框：模型預設是會話選定的那個（第 12 條），可以為這一輪換一個（generate 認 `pinnedModel`）。
 *
 * 只給了名字（「待完善」裡還沒有條目的）：問完要求之後先在「設定」一節給的分類目錄下建一條空條目（同細綱帶出新設定），
 * 再展開它。名字已被已有條目（標題或關鍵詞）佔了就展開那一條；是角色卡上的人就報錯退出——人不是設定。
 */
export async function expandLore(c: ChatController, msg: { relPath?: string; name?: string; category?: string }): Promise<void> {
  if (c.busy) {
    c.toast('已有一個生成任務在進行中。', 'error');
    return;
  }
  const entries = await c.project.listLore();
  const rel = msg.relPath ? normalizeRel(msg.relPath) : undefined;
  const name = msg.name?.trim() ?? '';
  let entry = rel ? entries.find((e) => e.relPath === rel) : name ? createLoreLookup(entries).find(name) : undefined;
  if (rel && !entry) {
    c.toast('這條設定不在了，可能剛被改名或刪除。', 'error');
    return;
  }
  if (!entry && !name) {
    c.toast('沒說要展開哪一條設定。', 'error');
    return;
  }
  if (!entry) {
    const cards = await c.project.listCharacters();
    if (cards.some((card) => card.name === name || card.aliases.includes(name))) {
      c.toast(`「${name}」是角色卡上的人，人不是設定，沒法展開。`, 'error');
      return;
    }
  }
  const label = entry?.title ?? name;
  const ask = await getHost().input({
    title: `展開設定「${label}」`,
    prompt:
      `這次有什麼要求？留空就照已排的細綱去想。${describeCalls(LORE_EXPAND_CALLS)}。` +
      (entry ? '' : '還沒有這一條，會先建一條空條目。') +
      '寫入前卡片上會列出展開的內容、建議拆出的子條目與還沒定的問題；已經寫過內容的條目會先讓你對比。',
    placeHolder: '例如：閣規要嚴一些；暗設裡交代它和魔宗的舊賬',
    multiline: true,
  });
  if (ask === undefined) {
    return;
  }
  // 模型預設是對話頁那個（與不問時一樣），換了就只這一輪用它（generate 認 `pinnedModel`）。問在建空條目之前：取消不留空條目。
  const answer = await askCall({
    message: `展開設定「${label}」：在對話頁發一輪生成，${describeCalls(LORE_EXPAND_CALLS)}。${entry ? '' : '還沒有這一條，會先建一條空條目。'}`,
    actions: ['開始展開'],
    tasks: ['transcribe'],
    contextDetail: true,
    preset: { model: readConfig().model || undefined },
  });
  if (answer?.action !== '開始展開') {
    return;
  }
  await withCallChoice(answer.choice, () => expandLoreEntry(c, entry, name, msg.category, ask.trim()));
}

/** 問完之後：還沒有條目就先建空條目，再把對話頁的目標換成它、發一輪展開。 */
async function expandLoreEntry(
  c: ChatController,
  found: LoreEntry | undefined,
  name: string,
  category: string | undefined,
  ask: string
): Promise<void> {
  let entry = found;
  if (!entry) {
    const folder = loreFolderOf(category ?? '');
    const slug = await uniqueSlug(c.project.loreDir, `${folder ? `${folder}/` : ''}${slugify(name)}`);
    const created = await new Workspace(c.project).writeLore({ slug, title: name, keywords: [name], brief: '', body: '' });
    c.project.invalidate();
    log.info(`展開之前先建了空條目「${name}」`, created);
    entry = (await c.project.listLore()).find((e) => e.relPath === created);
    if (!entry) {
      c.toast(`沒建成「${name}」的條目。`, 'error');
      return;
    }
  }
  const target: CreationTarget = { kind: 'lore', relPath: entry.relPath };
  await setTarget(c, target);
  await send(c, {
    text: ask.trim(),
    stage: stageOfTarget(target),
    capability: 'generate',
    target,
    targetNo: c.current.targetNo ?? 1,
    attachments: [],
    excludedIds: [],
  });
}

/**
 * 審稿報告卡底部「按勾選的 n 條修稿」（五期 W10）。
 *
 * 發的是一輪正文層的生成，寫法 `revise`：使用者氣泡是 `/按審稿修稿` + 勾選的那幾條，清單在
 * 動手之前按此刻的正文重新拼（{@link planRevision}），修訂稿照樣當場問寫不寫、覆蓋前先對比
 * （第 19 條、第 3 條）。能勾的只有問題與沒完成的目標；認不出的 id 丟掉。
 */
export async function reviseChapter(c: ChatController, turnId: string, picks: readonly string[]): Promise<void> {
  if (c.busy) {
    c.toast('已有一個生成任務在進行中。', 'error');
    return;
  }
  const turn = c.current.turns.find((t) => t.id === turnId && t.role === 'assistant');
  const report = turn?.review ? normalizeReport(turn.review.report) : undefined;
  if (!report) {
    c.toast('找不到這份審稿報告，可能那一輪已經被刪掉了。', 'error');
    return;
  }
  const allowed = new Set(pickableIds(report));
  const chosen = [...new Set(picks)].filter((id) => allowed.has(id));
  if (chosen.length === 0) {
    c.toast('沒有勾選任何可以修的條目。', 'error');
    return;
  }
  const target: CreationTarget = {
    kind: 'manuscript',
    plotRelPath: await c.project.plotPathOfNo(report.chapterNo, report.chapterTitle ?? ''),
  };
  await setTarget(c, target);
  await send(
    c,
    { text: '', stage: 'manuscript', capability: 'generate', target, targetNo: report.chapterNo, attachments: [], excludedIds: [] },
    {
      writeMode: 'revise',
      command: '按審稿修稿',
      revise: { reviewTurnId: turnId, picks: chosen, items: describePicks(report, chosen) },
    }
  );
}

/**
 * 報告卡編輯模式點了「儲存」（五期補遺 §3）：把那張問題表合回那一輪的報告（`applyReviewEdits`：
 * 模型給的不能刪、作者加的接著編號、引文按正文校驗），氣泡正文換成新的文字版，落盤、推回。
 * 不調模型。引文按磁碟上此刻的正文找——審稿之後改過的話，作者對著的正是現在這一版。
 */
export async function editReview(c: ChatController, turnId: string, edits: readonly ReviewIssueEdit[]): Promise<void> {
  const turn = c.current.turns.find((t) => t.id === turnId && t.role === 'assistant');
  const report = turn?.review ? normalizeReport(turn.review.report) : undefined;
  if (!turn || !turn.review || !report) {
    c.toast('找不到這份審稿報告，可能那一輪已經被刪掉了。', 'error');
    return;
  }
  const chapter = await c.project.getChapter(report.chapterNo);
  const text = chapter ? await c.project.readChapterText(chapter) : '';
  const { report: next, notes } = applyReviewEdits(report, edits, text);
  turn.review = { ...turn.review, report: next };
  turn.content = renderReport(next);
  log.info(`編輯了第 ${report.chapterNo} 章的審稿報告`, notes.join('；') || `${next.issues.length} 條問題`);
  await persist(c);
  c.post({ type: 'turnDone', turn: serializeTurn(turn) });
  c.toast(notes.length > 0 ? `審稿報告已儲存。${notes.join('；')}。` : '審稿報告已儲存。');
}

/** {@link beforeGenerate} 的結論：放行（修稿時帶上拼好的清單），或者攔下並說明。 */
type BeforeGenerate =
  | { go: true; reviseBrief?: string; notes?: string[] }
  | { go: false; content?: string; error?: string; interrupted?: boolean };

/**
 * 調模型之前的兩道（五期）。
 *
 * - **修稿**：按那一輪的報告與磁碟上此刻的正文拼清單。正文在審稿之後改過（指紋對不上），
 *   逐條重新定位勾選的問題，引文已經不在的作廢並寫進說明；一條都不剩就不調模型。
 * - **一致性預檢**：寫一章（新寫或重寫）之前，零呼叫地查細綱有沒有把角色卡上已經死了的人排進
 *   本章。有就在對話頁亮一張卡：「僅本次忽略，照寫」/「先不寫」，或者填一句理由「記為刻意安排，
 *   照寫」——記進這一章細綱的 `preflightOk`，以後寫這一章不再為這幾個人亮卡（五期補遺 §2）。記過的
 *   不攔，寫章卡片的說明裡提一句。接著寫與修稿不查——開頭已經寫下了，這時候攔它沒有意義。
 * - **敘事線提醒**（敘事線二期）：伏筆逾期、線斷了，同一次預檢零呼叫地算出來，**不攔**——有風險要亮卡時寫在卡片說明裡，
 *   沒有風險就放進這一輪的說明（寫章卡片上「· 敘事線提醒：……」），日誌裡也記一筆。
 */
async function beforeGenerate(
  c: ChatController,
  ctx: {
    action: { stage: CreationStage; capability: Capability };
    writeMode?: WriteMode;
    userTurn: ChatTurn;
    assistantTurn: ChatTurn;
    signal: AbortSignal;
  }
): Promise<BeforeGenerate> {
  if (ctx.action.stage !== 'manuscript' || ctx.action.capability !== 'generate') {
    return { go: true };
  }
  if (ctx.writeMode === 'revise') {
    return planRevision(c, ctx.userTurn);
  }
  if (ctx.writeMode === 'continue') {
    return { go: true };
  }
  const relPath = plotOfTarget(c.current.target);
  const no =
    (relPath ? (await c.project.resolvePlot(relPath))?.no ?? parsePlotFileName(basename(relPath))?.no : undefined) ??
    c.current.targetNo;
  const pre = no ? await preflightChapter(c.project, no) : undefined;
  const { risks, exempted, plotRelPath: plotRel } = pre ?? { risks: [], exempted: [], plotRelPath: undefined };
  const notes = exempted.map(describeExempted);
  const threadNote = pre && no ? describeThreadNotes('本章', pre.threads, pre.threadsThrough, no) : '';
  if (threadNote) {
    log.info(`寫第 ${no} 章之前的敘事線提醒：${pre!.threads.length} 條（不攔）`, threadNote);
    notes.push(threadNote);
  }
  // 批次寫章在這一章前面停下時掛過一個黃 ❗：這一次查過了（沒問題，或作者說僅本次忽略）就收掉。
  if (!no || risks.length === 0) {
    if (plotRel) {
      await clearFailures(c.project, 'plot', plotRel, 'preflight');
    }
    return { go: true, ...(notes.length > 0 ? { notes } : {}) };
  }
  const lines = describeRisks(no, risks);
  log.warn(`寫第 ${no} 章之前的一致性預檢：${risks.length} 處`, lines.join('\n'));
  const answer = await askGateNoted(
    c,
    {
      turnId: ctx.assistantTurn.id,
      name: 'preflight',
      title: `寫第 ${no} 章之前的一致性預檢：${risks.length} 處要留意`,
      detail: `${PREFLIGHT_SUGGESTION}\n${threadNote ? `${threadNote}\n` : ''}這一步沒有呼叫模型。`,
      danger: lines.join('\n'),
      proceed: '僅本次忽略，照寫',
      skip: '先不寫',
      ...(plotRel
        ? {
            remember: {
              label: '記為刻意安排，照寫',
              placeholder: '為什麼這是刻意的安排（如：回憶裡的一場）。記進這一章的細綱，以後寫這一章不再為這幾個人提醒',
            },
          }
        : {}),
    },
    ctx.signal
  );
  if (answer.verdict === 'proceed') {
    if (answer.remember && plotRel) {
      const ok = await c.workspace.recordPreflightOk(plotRel, risks.map((r) => ({ name: r.name, reason: answer.remember! })));
      const who = risks.map((r) => r.name).join('、');
      log.info(`一致性預檢：作者把${who}記為第 ${no} 章的刻意安排`, answer.remember);
      notes.unshift(
        ok
          ? `一致性預檢：${who}在第 ${no} 章出場已記為刻意安排（${answer.remember}），寫進了這一章細綱的 preflightOk，以後寫這一章不再提醒`
          : `一致性預檢：這一章細綱是手寫的（沒有 frontmatter），沒能記下「${answer.remember}」；這一次照寫`
      );
    } else {
      log.info(`一致性預檢：作者選擇僅本次忽略，照寫第 ${no} 章`);
    }
    if (plotRel) {
      await clearFailures(c.project, 'plot', plotRel, 'preflight');
    }
    return { go: true, ...(notes.length > 0 ? { notes } : {}) };
  }
  return {
    go: false,
    interrupted: answer.verdict === 'stop',
    content: [
      `一致性預檢發現 ${risks.length} 處問題，這一次先不寫——沒有呼叫模型。`,
      '',
      ...lines.map((l) => `- ${l}`),
      '',
      '改好細綱的出場角色或角色卡之後再寫；如果這本來就是回憶、幻象一類的刻意安排，再點一次寫這一章，選「僅本次忽略，照寫」或「記為刻意安排，照寫」。',
    ].join('\n'),
  };
}

/** 修稿那一輪的清單。見 {@link beforeGenerate}。 */
async function planRevision(c: ChatController, userTurn: ChatTurn): Promise<BeforeGenerate> {
  const r = userTurn.revise;
  const reviewTurn = r ? c.current.turns.find((t) => t.id === r.reviewTurnId) : undefined;
  const report = reviewTurn?.review ? normalizeReport(reviewTurn.review.report) : undefined;
  if (!r || !report) {
    return { go: false, error: '找不到這一輪修稿依據的那份審稿報告（可能已經被刪掉了），沒法按它修稿。' };
  }
  const chapter = await c.project.getChapter(report.chapterNo);
  const text = chapter ? await c.project.readChapterText(chapter) : '';
  if (!chapter || !text.trim()) {
    return { go: false, error: `第 ${report.chapterNo} 章已經沒有正文了，沒法修稿。` };
  }
  const notes: string[] = [];
  let picks = r.picks;
  if (chapter.contentHash !== report.chapterHash) {
    const { kept, lost } = relocatePicks(report, picks, text);
    picks = kept;
    notes.push('正文在審稿之後改過，勾選的條目已按現在的正文重新定位');
    if (lost.length > 0) {
      notes.push(
        `${lost.length} 條的引文已經不在正文裡了，沒有交給模型：${lost.map((i) => `「${clipQuote(i.description, 24)}」`).join('、')}`
      );
    }
  }
  const brief = renderRevisionBrief(report, picks);
  if (!brief) {
    return { go: false, error: '勾選的條目在現在的正文裡都找不到了，沒有可以修的。正文改過的話，重新審一遍這一章。' };
  }
  notes.unshift(`按 ${picks.length} 條勾選的審稿意見修稿`);
  log.info(`按審稿修第 ${report.chapterNo} 章`, notes.join('；'));
  return { go: true, reviseBrief: brief, notes };
}

/**
 * 切換當前在改哪個產物。
 *
 * 階段跟著 target 走，能力回落到該階段的預設值（一律 discuss）——
 * 從「正文·生成」切到劇情還留著「生成」，等於點一下就花錢重寫一章的細綱。
 */
export async function setTarget(c: ChatController, target: CreationTarget): Promise<void> {
  if (c.busy) {
    c.toast('正在生成，請先停止。', 'error');
    return;
  }
  c.current.target = target;
  c.current.stage = stageOfTarget(target);
  c.current.capability = DEFAULT_CAPABILITY[c.current.stage];
  // 把章號同步過來：裝配器在細綱尚未落盤時靠它定位前文邊界，而這裡正好知道答案。
  const relPath = plotOfTarget(target);
  if (relPath) {
    const no = parsePlotFileName(basename(relPath))?.no;
    if (no !== undefined) {
      c.current.targetNo = no;
    }
  }
  log.info(`創作目標切到 ${await describeCurrentTarget(c)}`);
  c.tab = 'chat';
  c.post({ type: 'tab', tab: 'chat' });
  c.post({ type: 'session', session: serializeSession(c.current) });
  await pushPipeline(c);
}

/**
 * 進入某一章：**由狀態機決定落在哪一層**。
 *
 * 這是「選中一章 = 進入它當前該做的那一步」的實現：還沒排細綱就落細綱層，
 * 細綱排好了就落正文層。判斷必須在後端：前端手上只有當前那一章的 pipeline。
 *
 * **收的是「哪一章」**，介面上幾個入口給的路徑形狀各不相同——細綱路徑（可能還
 * 不存在，下拉框與老工程的章給的就是 `plotPathOfNo` 算出來的位置）或章節路徑。
 * `resolvePlotTarget` 把它們認到同一章：章節路徑就是那一章，細綱按路徑配對（細綱映象正文的路徑）。
 */
export async function selectPlot(c: ChatController, plotRelPath: string): Promise<void> {
  const entry = await resolvePlotTarget(c, plotRelPath);
  if (!entry) {
    c.toast('這一章不存在，可能剛被改名或刪除。', 'error');
    return;
  }
  const pipeline = await buildPlotPipeline(c.project, entry);
  const next = deriveNextStep(pipeline.stage, factsOf(pipeline));
  // 細綱還沒有時落點用它**應該**在的位置（有正文就是正文的映象）：選中它就是
  // 「去給這一章補規劃」，裝配器與工作區卡都能如實退化成空殼。
  const target = pipeline.plot.relPath;

  // 全做完了（next 為空）就停在正文——那是這一章的終點，也是最可能
  // 要回頭改的一層。
  await setTarget(c, next ? targetOf(next, target) : { kind: 'manuscript', plotRelPath: target });
}

/**
 * 前端給的路徑 → 這一章（細綱與正文各自可能缺席）。兩邊都沒有才算「不存在」。
 *
 * - 章節路徑：就是那一章，細綱是它的映象（同號的正文有兩份時也認得準是哪一份）。
 * - 細綱路徑（`summaries/` 下）：按 `resolvePlot` 認這一章現在的那一份細綱，正文是它映象回去的那一章。
 *   `readPlot` 是純解析，餵它一個章節檔案也會**解析成功**，所以只有認得出是細綱的路徑才當細綱讀。
 * - 其餘（還不存在的細綱路徑）按檔名裡的號認。
 */
async function resolvePlotTarget(
  c: ChatController,
  relPath: string
): Promise<{ no: number; plot?: Plot; chapter?: Chapter } | undefined> {
  const chapters = await c.project.listChapters();

  const direct = chapters.find((ch) => ch.relPath === relPath);
  if (direct) {
    return { no: direct.order, plot: await c.project.plotOfChapter(direct), chapter: direct };
  }
  const no = parsePlotFileName(basename(relPath))?.no ?? parseChapterFileName(basename(relPath))?.order;
  if (no === undefined || no <= 0) {
    return undefined;
  }
  const plot = isPlotPath(c.project, relPath) ? await c.project.resolvePlot(relPath) : await c.project.getPlot(no);
  const chapter =
    (plot && chapters.find((ch) => ch.order === no && c.project.plotPathForChapter(ch.relPath) === plot.relPath)) ??
    chapterOfPlotNo(chapters, no);
  return plot || chapter ? { no, plot, chapter } : undefined;
}

/**
 * 細綱改名後，把當前會話的目標指到新路徑。
 *
 * 少了這一步，`current.target.plotRelPath` 還指著舊路徑，創作頁會拿到一份
 * 「這一章找不到」的空殼 pipeline——徽章回落成「待寫細綱」、進度全歸零、
 * 工作區卡說這一章不存在。而作者剛做的只是給它起個名字。
 *
 * **不走 `setTarget`**：那會把 capability 重置成 discuss、把頁籤切到創作頁。
 * 改個名不該讓他剛挑好的命令消失，也不該把他從工程頁拽走。
 */
export async function retargetPlot(
  c: ChatController,
  fromRel: string,
  toRel: string
): Promise<void> {
  const current = plotOfTarget(c.current.target);
  if (!current || fromRel === toRel || current !== fromRel) {
    return;
  }
  c.current.target = { ...c.current.target, plotRelPath: toRel } as CreationTarget;
  log.info(`創作目標跟隨改名`, `${current} → ${toRel}`);
  c.post({ type: 'session', session: serializeSession(c.current) });
  await pushPipeline(c);
}

/**
 * 把這一輪請求裡的 stage/capability/target 記進會話。
 *
 * 前端每次傳送都帶全量（它才知道使用者點了哪個按鈕），後端**校驗一遍**：
 * 階段認不出、或該階段（在這個目標上）不支援這個能力時回落，絕不照單全收——那會讓
 * `STAGE_CAPABILITIES` 這張表形同虛設。
 */
export function applyAction(c: ChatController, payload: SendPayload): void {
  const stage = isCreationStage(payload.stage) ? payload.stage : c.current.stage;
  // 按這一層、這個目標算：架構那一層只有設定目錄有 `settle`（落定設定）。
  const capability: Capability = capabilitiesOn(stage, normalizeTarget(payload.target)).includes(payload.capability)
    ? payload.capability
    : DEFAULT_CAPABILITY[stage];
  if (capability !== payload.capability) {
    log.warn(
      `「${payload.capability}」不是${stage}階段的能力，已回落到${capability}`,
      '前端的按鈕組與 STAGE_CAPABILITIES 對不上了'
    );
  }
  c.current.stage = stage;
  c.current.capability = capability;
  c.current.target = normalizeTarget(payload.target);
}

/** 當前目標的人話描述。日誌、落盤卡片、麵包屑共用。 */
export async function describeCurrentTarget(c: ChatController): Promise<string> {
  return describeTargetOf(c, c.current.target);
}

/**
 * 任意 target 的人話描述。
 *
 * 與 `describeCurrentTarget` 分開是因為 agent 那條路上的落點由 draft 決定，
 * 未必是作者當下選中的那一章——拿 `c.current` 頂上會把落點說成另一章。
 */
export async function describeTargetOf(
  c: ChatController,
  target: CreationTarget,
  range?: { from: number; to: number }
): Promise<string> {
  // 一批細綱 / 續寫的那一段大綱：落點是一段章號，不是某一章。
  if (range && (target.kind === 'plot' || target.kind === 'outline')) {
    const span = range.from === range.to ? `第 ${range.from} 章` : `第 ${range.from}–${range.to} 章`;
    return target.kind === 'plot' ? `${span} · 細綱` : `情節大綱 · ${span}`;
  }
  // 單條設定報條目的標題（檔名與標題偶爾不一樣：同名時 `uniqueSlug` 會加字尾）。
  if (target.kind === 'lore') {
    return describeTarget(target, { title: (await loreEntryAt(c.project, target.relPath)).entry.title });
  }
  const relPath = plotOfTarget(target);
  if (!relPath) {
    return describeTarget(target);
  }
  const plot = await c.project.resolvePlot(relPath);
  return describeTarget(target, { no: plot?.no ?? parsePlotFileName(basename(relPath))?.no, title: plot?.title });
}

/**
 * 推一份創作頁的現場：流水線 + 工作區卡 + 下一步。
 *
 * 架構與大綱兩層沒有「這一章」，下一步問全書狀態機。選中一章時問那一章的；
 * **那一章做完了就轉去問全書**——主按鈕於是自然落到下一個該寫的章上，
 * 而不是一段做完就沉默（從前 `done` 之後沒有按鈕，作者得自己去找下一段）。
 */
export async function pushPipeline(c: ChatController): Promise<void> {
  const target = c.current.target;
  const relPath = plotOfTarget(target);
  const workbench = await buildWorkbench(c.project, target);

  if (!relPath) {
    c.post({ type: 'pipeline', workbench, next: await bookNextStep(c) });
    return;
  }
  const pipeline = await buildPlotPipelineView(c.project, relPath);
  const step = deriveNextStep(pipeline.stage, factsOf(pipeline));
  c.post({
    type: 'pipeline',
    pipeline,
    workbench,
    next: step
      ? { ...step, target: targetOf(step, pipeline.plot.relPath), no: pipeline.no }
      : await bookNextStep(c),
  });
}

/**
 * 全書級的下一步。
 *
 * 判據在純函式層（`deriveBookStage` / `deriveBookNextStep`），這裡只取數：
 *
 * - 架構、大綱、拆細綱三檔：`bookStepView` 補上落點（工程頁的空狀態用的是同一份）。
 * - 在寫那一檔：轉去問**下一個該寫的章**的單章狀態機，主按鈕就是「寫第 N 章」一類。
 * - 寫完了：不給按鈕。
 */
export async function bookNextStep(c: ChatController): Promise<NextStepView | undefined> {
  const facts = await buildBookFacts(c.project);
  const stage = deriveBookStage(facts);
  const step = await bookStepView(stage, facts, {
    config: () => c.project.readBookConfig(),
    plotPathOf: (no) => c.project.plotPathOfNo(no),
  });
  if (step || stage !== 'writing') {
    return step;
  }
  const no = facts.nextChapterNo;
  const chapters = await c.project.listChapters();
  const plot = await c.project.getPlot(no);
  const pipeline = await buildPlotPipeline(c.project, { no, plot, chapter: chapterOfPlotNo(chapters, no) }, { chapters });
  const chapterStep = deriveNextStep(pipeline.stage, factsOf(pipeline));
  return chapterStep
    ? { ...chapterStep, target: targetOf(chapterStep, pipeline.plot.relPath), no }
    : undefined;
}

/**
 * 開啟舊會話時把 target 補齊。
 *
 * `normalize` 是純函式，查不了磁碟，所以只記得 `targetNo` 的會話會一律落到
 * 情節大綱。這裡手上能讀盤，把它還原成「正文 · 第 N 章」。
 */
export async function restoreTarget(c: ChatController, session: ChatSession): Promise<void> {
  if (session.target.kind !== 'outline' || session.targetNo === undefined) {
    return;
  }
  const plot = await c.project.getPlot(session.targetNo);
  if (plot) {
    session.target = { kind: 'manuscript', plotRelPath: plot.relPath };
    session.stage = 'manuscript';
    session.capability = DEFAULT_CAPABILITY.manuscript;
  }
}
