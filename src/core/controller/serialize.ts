import { readConfig } from '../config';
import { BuiltContext, ContextItem } from '../context/builder';
import { Attachment, ChatSession, ChatTurn, contextMessagesOf, isBuiltinAgentTurn } from '../model/session';
import { NovelConfig } from '../model/types';
import { modelLabel, providerLabel } from '../model/providers';
import { DEFAULT_THINKING_DEPTH } from '../model/thinking';
import { defaultPicks, normalizeReport } from '../model/review';
import {
  CreationTarget,
} from '../model/pipeline';
import {
  NextStepPlan,
  SerializedAttachment,
  SerializedDigest,
  SerializedSession,
  SerializedTurn,
} from '../protocol';

/**
 * 流水線 → `deriveNextStep` 要的那幾個事實。
 *
 * 實現在 [views/pipeline.ts](../views/pipeline.ts)：狀態簡報（`views/stateBrief.ts`）
 * 也要用它。這裡保留轉發，同包的呼叫點不必改。
 */
export { factsOf } from '../views/pipeline';

/**
 * 下一步落在哪個具體產物上。
 *
 * 單章的下一步只說「細綱層 / 正文層」，拼成 target 要知道那一章細綱的路徑，
 * 而那是 I/O 層的事。全書級的下一步自己帶著 target（架構、大綱），這裡原樣用它。
 */
export function targetOf(step: NextStepPlan, plotRelPath: string): CreationTarget {
  if (step.target) {
    return step.target;
  }
  switch (step.stage) {
    case 'setting':
      return { kind: 'setting', doc: 'config' };
    case 'outline':
      return { kind: 'outline' };
    case 'plot':
      return { kind: 'plot', plotRelPath };
    case 'manuscript':
      return { kind: 'manuscript', plotRelPath };
  }
}

export function serializeSession(s: ChatSession): SerializedSession {
  return {
    id: s.id,
    title: s.title,
    target: s.target,
    stage: s.stage,
    capability: s.capability,
    targetNo: s.targetNo,
    // 前端只回顯，不猜預設值：缺席歸一成「不思考」這件事在後端做一次。
    thinking: s.thinking ?? DEFAULT_THINKING_DEPTH,
    turns: s.turns.map(serializeTurn),
  };
}

export function serializeTurn(t: ChatTurn): SerializedTurn {
  return {
    id: t.id,
    role: t.role,
    content: t.content,
    at: t.at,
    command: t.command,
    attachments: t.attachments?.map(serializeAttachment),
    context: t.context,
    ...(contextMessagesOf(t) ? { fullContext: true } : {}),
    acceptedTo: t.acceptedTo,
    interrupted: t.interrupted,
    error: t.error,
    reasoning: t.reasoning,
    artifact: t.artifact,
    ...reviewOf(t),
    ...(t.revise ? { revise: { items: t.revise.items } } : {}),
    segments: t.segments,
    ...(t.mcp ? { mcp: true } : {}),
    ...(isBuiltinAgentTurn(t) ? { builtinAgent: true } : {}),
  };
}

/**
 * 審稿那一輪的報告（五期）。會話檔案裡的那一份按容錯讀取重新歸一一次：作者可能手改過，
 * 報告卡照著一份壞掉的報告畫，點引文、修稿都會出錯。認不出就當這一輪沒有報告（氣泡裡
 * 仍有給人讀的那一份文字）。
 */
function reviewOf(t: ChatTurn): Pick<SerializedTurn, 'review'> {
  const report = t.review ? normalizeReport(t.review.report) : undefined;
  if (!t.review || !report) {
    return {};
  }
  return {
    review: {
      report,
      picks: defaultPicks(report),
      ...(t.review.notes?.length ? { notes: t.review.notes } : {}),
      ...(t.review.calls ? { calls: t.review.calls } : {}),
    },
  };
}

export function serializeAttachment(a: Attachment): SerializedAttachment {
  return { id: a.id, kind: a.kind, label: a.label, relPath: a.relPath, range: a.range, text: a.text };
}

export function serializeDigest(built: BuiltContext): SerializedDigest {
  return {
    usedTokens: built.usedTokens,
    budget: built.budget,
    clamped: built.budgetClampedByProvider,
    detail: built.detail,
    items: built.items.map(serializeItem),
  };
}

export function serializeItem(i: ContextItem) {
  return {
    id: i.id,
    label: i.label,
    kind: i.kind,
    priority: i.priority,
    tokens: i.tokens,
    status: i.status,
    note: i.note,
    source: i.source,
  };
}

export function describeProvider(config: NovelConfig = readConfig()): string {
  if (!config.active) {
    return config.model || '未選擇模型';
  }
  const { profile, model } = config.active;
  return `${providerLabel(profile)} · ${modelLabel(model)}`;
}
