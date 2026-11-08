import { STAGE_ROLE } from '../../model/pipeline';
import { notYetOnStage } from '../../model/manuscriptCheck';
import { isBuiltinAgentTurn } from '../../model/session';
import { PromptFacts, buildSystemPrompt } from '../prompts';
import { estimateTokens, takeHead, takeTail } from '../tokenizer';
import { ContextItem } from '../types';
import type { Assembly, LayerFn } from './assembly';
import { ATTACHMENT_NOTE, LORE_HIDDEN_DROPPED_NOTE, hiddenTextIn, loreBodyFor, resolveAttachment } from './render';

/**
 * 這一次裝配交給提示詞的事實。系統提示（這裡）與輸出契約（builder.ts）必須拿同一份，
 * 不然一個說「寫第 6–10 章」，另一個說「寫這一章」。
 */
export function promptFactsOf(a: Pick<Assembly, 'request' | 'book' | 'focus'>): PromptFacts {
  const r = a.request;
  const plot = a.focus.plot;
  const drafting = r.action.stage === 'manuscript' && r.action.capability === 'generate' && r.writeMode !== 'revise';
  return {
    target: r.target,
    targetWords: r.targetWords,
    range: r.range,
    setup: r.setup,
    step: r.step,
    book: a.book,
    no: Number.isFinite(a.focus.no) ? a.focus.no : undefined,
    plot: plot ? { keyEvents: plot.sections.关键事件 } : undefined,
    ask: r.ask,
    writeMode: r.writeMode,
    written: r.writeMode === 'continue' ? a.focus.chapter?.wordCount : undefined,
    reviewGoals: r.reviewGoals,
    ...(r.derive ? { derive: r.derive } : {}),
    // 「本章不出場」（五期補遺 §1.2）：生成層交過來的那一份優先（與寫完查的同源）；沒給就按 focus 現算。
    ...(drafting
      ? {
          ...(r.banned?.length ? { banned: r.banned } : {}),
          notYet: r.notYet ?? notYetOnStage({
            self: plot?.characters ?? [],
            previous: a.focus.previous.map((c) => ({ no: c.no, characters: c.plot?.characters ?? [] })),
            ahead: a.focus.aheadPlots.map((c) => ({ no: c.no, characters: c.plot?.characters ?? [] })),
          }),
        }
      : {}),
  };
}

/** 歷史裡單條訊息的上限，超出取結尾（越靠後越相關）。 */
const HISTORY_TURN_CAP_RATIO = 0.12;

export const system: LayerFn = async (a, spec) => {
  a.admit(
    {
      id: 'system',
      kind: 'system',
      priority: spec.priority,
      label: `系統提示 · ${STAGE_ROLE[a.request.action.stage]}`,
      text: buildSystemPrompt(a.request.action, a.config, promptFactsOf(a)),
    },
    { force: spec.force }
  );
};

export const ask: LayerFn = async (a, spec) => {
  const { stage, capability } = a.request.action;
  const isDraftOrder = stage === 'manuscript' && capability === 'generate';
  const label =
    capability === 'review'
      ? '要求重點檢查的方面'
      : isDraftOrder && a.request.writeMode === 'revise'
        ? '修稿的補充要求'
        : isDraftOrder
          ? '這一章的補充要求'
          : '我的要求';
  a.admit(
    {
      id: 'ask',
      kind: 'ask',
      priority: spec.priority,
      label,
      text: a.request.ask.trim(),
    },
    { force: spec.force }
  );
};

export const attachments: LayerFn = async (a, spec) => {
  const attachmentCap = Math.floor(a.budget * (spec.cap ?? 1));
  // 正文階段作者 @ 引用一條設定或一張角色卡：同 lore 層、`characters` 層，暗設不帶、明細裡注一句（完善設定，2026-10-19；
  // 角色卡的暗設是敘事線重做加的）。要讓正文知道，就寫進這一章細綱。別的階段、別的種類照舊整份帶。
  const manuscript = a.request.action.stage === 'manuscript';
  for (const att of a.request.attachments ?? []) {
    const id = `attachment:${att.id}`;
    const base = {
      id,
      kind: 'attachment' as const,
      priority: spec.priority,
      label: att.label,
      source: att.relPath,
    };
    if (a.excluded.has(id)) {
      a.admit({ ...base, text: '' });
      continue;
    }
    let body = await resolveAttachment(a.project, att);
    if (!body.trim()) {
      a.reject({ ...base, text: '' }, 'dropped', '內容為空或檔案已不存在');
      continue;
    }
    let hiddenNote = '';
    if (manuscript && (att.kind === 'lore' || att.kind === 'character')) {
      // 角色卡的「暗設」空著（「（待補充）」、角色圖譜寫的「無」）時只是去掉一個空標題，不注。
      const noted = att.kind === 'lore' || !!hiddenTextIn(body);
      const split = loreBodyFor(body, false);
      if (split.dropped) {
        body = split.text;
        hiddenNote = noted ? `；${LORE_HIDDEN_DROPPED_NOTE}` : '';
      }
    }

    const raw = `【引用 · ${att.label}】\n${body}`;
    const rawTokens = estimateTokens(raw);
    const cap = Math.min(attachmentCap, Math.max(0, a.remaining));
    if (rawTokens <= cap) {
      a.accept({ ...base, text: raw, status: 'included', note: `${ATTACHMENT_NOTE[att.kind]}${hiddenNote}` }, rawTokens);
      continue;
    }
    if (cap < 200) {
      a.reject(
        { ...base, text: '' },
        'dropped',
        `預算不足（需 ${rawTokens} token，剩 ${Math.max(0, a.remaining)}）`
      );
      continue;
    }
    const clipped = `【引用 · ${att.label}】\n${takeHead(body, cap - 40)}`;
    const clippedTokens = estimateTokens(clipped);
    a.accept(
      {
        ...base,
        text: clipped,
        status: 'degraded',
        note: `原文需 ${rawTokens} token，已截斷至 ${clippedTokens}${hiddenNote}`,
      },
      clippedTokens
    );
  }
};

/**
 * 歷史對話。
 *
 * **已經寫入的那一輪不再帶**（五期補遺 §1.4）：同一個會話跟著主按鈕一路走，配置、前提、角色圖譜、
 * 大綱、細綱、前幾章正文都留在歷史裡，寫第 3 章時又整份裝一遍。它們早就落盤了，專門的層按磁碟帶
 * （設定、大綱切片、本章細綱、上一章結尾、前文全文、證據），而作者落盤之後可能手改過——歷史裡的
 * 還是改之前那一版。發起那一輪的命令（使用者輪，帶 `command`）一起跳過：要求已經落在產物裡了。
 * 討論（沒有 `command`）與沒寫入的產物（作者點了不採納，那份只在歷史裡有）照舊帶。
 *
 * **已經移除的內建 agent 跑的那幾輪也不帶**，交給它的那句指令一起跳過：它說的是「我先讀第 3 章」
 * 這類排程過程，不是與作者的討論，混進來模型會以為自己剛才在讀檔案、調工具。跳過的都記在
 * 明細裡（第 2 條）。
 */
export const history: LayerFn = async (a, spec) => {
  const turns = a.request.history ?? [];
  if (turns.length === 0) {
    return;
  }
  // 配方沒寫封頂就按上下文詳細度那一級（預設 0.3）；落定細綱在配方上寫死 0.6。
  const historyCap = Math.floor(a.budget * (spec.cap ?? a.limits.historyCap));
  const turnCap = Math.floor(a.budget * HISTORY_TURN_CAP_RATIO);
  let historyRemaining = Math.min(historyCap, Math.max(0, a.remaining));

  // 已寫入的那一輪 → 落點；發起它的命令輪 → 同一個落點。
  const landed = new Map<string, string>();
  turns.forEach((turn, i) => {
    if (turn.role === 'assistant' && turn.acceptedTo) {
      landed.set(turn.id, turn.acceptedTo);
      const asked = turns[i - 1];
      if (asked && asked.role === 'user' && asked.command) {
        landed.set(asked.id, turn.acceptedTo);
      }
    }
  });

  // 內建 agent 跑的那一輪 → 不帶；交給它的那句指令（緊挨在前面、沒有 `command` 的使用者輪）一起不帶。
  const byAgent = new Map<string, string>();
  turns.forEach((turn, i) => {
    if (isBuiltinAgentTurn(turn)) {
      byAgent.set(turn.id, '已經移除的內建 agent 跑的一輪，只留著回看，不隨歷史帶');
      const asked = turns[i - 1];
      if (asked && asked.role === 'user' && !asked.command) {
        byAgent.set(asked.id, '這一句是交給已經移除的內建 agent 的指令，不隨歷史帶');
      }
    }
  });

  const kept: ContextItem[] = [];
  const skipped: ContextItem[] = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    const id = `history:${turn.id}`;
    const base = {
      id,
      kind: 'history' as const,
      priority: spec.priority,
      label: `${turn.role === 'user' ? '我' : '模型'} · 第 ${i + 1} 輪`,
    };

    const agentNote = a.excluded.has(id) ? undefined : byAgent.get(turn.id);
    if (agentNote) {
      skipped.push({ ...base, text: '', tokens: 0, status: 'dropped', note: agentNote });
      continue;
    }
    if (a.excluded.has(id) || !turn.content.trim()) {
      skipped.push({
        ...base,
        text: '',
        tokens: 0,
        status: a.excluded.has(id) ? 'excluded' : 'dropped',
        note: a.excluded.has(id) ? '已被手動排除' : '空訊息',
      });
      continue;
    }
    const to = landed.get(turn.id);
    if (to) {
      skipped.push({
        ...base,
        text: '',
        tokens: 0,
        status: 'dropped',
        note:
          turn.role === 'assistant'
            ? `已寫入「${to}」，以磁碟上那一份為準，不再隨歷史帶`
            : `這一輪的產物已寫入「${to}」，要求已經落在產物裡`,
      });
      continue;
    }

    const content = takeTail(turn.content, turnCap);
    const tokens = estimateTokens(content);
    if (tokens > historyRemaining) {
      skipped.push({
        ...base,
        text: '',
        tokens: 0,
        status: 'dropped',
        note: '歷史對話預算已滿，更早的輪次不再注入',
      });
      continue;
    }
    historyRemaining -= tokens;
    a.remaining -= tokens;
    kept.push({
      ...base,
      text: content,
      tokens,
      status: content.length < turn.content.length ? 'degraded' : 'included',
      note: content.length < turn.content.length ? '過長，僅注入結尾部分' : undefined,
    });
  }
  a.items.push(...kept.reverse(), ...skipped.reverse());
};
