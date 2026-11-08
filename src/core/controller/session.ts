import type { ChatController } from './index';
import { getHost } from '../host';
import { THINKING_LABEL, ThinkingDepth, normalizeThinkingDepth } from '../model/thinking';
import { scoped } from '../runtime/logger';
import { serializeSession } from './serialize';
import { restoreTarget, pushPipeline } from './chat';
import { cancelGates } from './gate';
import { persist } from './persist';

const log = scoped('面板');

/** 會話落盤與會話列表操作。接收 ChatController，欄位只給 controller/ 同包用。 */

/**
 * 換這個會話的思考深度。
 *
 * 落在會話上而不是配置裡（見 model/session.ts）。**當場落盤**：作者選完
 * 「深思考」就去泡茶，回來發現面板重開後又變回不思考，是最容易讓人以為
 * 「這個開關沒用」的一種表現。
 */
export async function setThinking(c: ChatController, depth: ThinkingDepth): Promise<void> {
  const next = normalizeThinkingDepth(depth);
  if ((c.current.thinking ?? 'off') === next) {
    return;
  }
  c.current.thinking = next;
  log.info(`思考深度改為「${THINKING_LABEL[next]}」`, `會話 ${c.current.id}`);
  await persist(c);
  c.post({ type: 'session', session: serializeSession(c.current) });
}

export async function newSession(c: ChatController): Promise<void> {
  if (c.busy) {
    c.toast('正在生成，請先停止。', 'error');
    return;
  }
  await persist(c);
  // 換會話 = 上一條氣泡走出視野，掛在它上面那張還沒答的落盤卡片一併作廢。
  cancelGates(c);
  // 走掉的那個會話的草稿留在它自己的 JSON 裡，記憶體這份扔掉——不然開一天
  // 面板會攢下幾十份沒人再看的正文。
  c.drafts.dropBySession(c.current.id);
  c.current = c.store.create({
    target: c.current.target,
    stage: c.current.stage,
    targetNo: c.current.targetNo,
    thinking: c.current.thinking,
  });
  c.pending = [];
  c.tab = 'chat';
  c.post({ type: 'tab', tab: 'chat' });
  c.post({ type: 'session', session: serializeSession(c.current) });
  c.post({ type: 'attachments', items: [] });
}

export async function openSession(c: ChatController, id: string): Promise<void> {
  if (c.busy) {
    c.toast('正在生成，請先停止。', 'error');
    return;
  }
  const loaded = await c.store.read(id);
  if (!loaded) {
    c.toast('這個會話讀不出來，可能已被刪除或損壞。', 'error');
    await c.pushSessions();
    return;
  }
  await persist(c);
  cancelGates(c);
  await restoreTarget(c, loaded);
  c.drafts.dropBySession(c.current.id);
  c.current = loaded;
  // 把落盤的那批草稿裝回記憶體：`write draftId=…` 認的是它們，翻回一箇舊會話
  // 接著讓 agent 幹活時，那幾份草稿還得在。
  // （**落盤不再靠它**：寫不寫在產出的當下就問過了，氣泡上沒有採納按鈕。）
  c.drafts.load(loaded.id, loaded.drafts);
  c.pending = [];
  c.tab = 'chat';
  c.post({ type: 'tab', tab: 'chat' });
  c.post({ type: 'session', session: serializeSession(c.current) });
  c.post({ type: 'attachments', items: [] });
  await pushPipeline(c);
}

export async function deleteSession(c: ChatController, id: string): Promise<void> {
  const target = await c.store.read(id);
  const pick = await getHost().confirm(
    `刪除對話「${target?.title ?? id}」？`,
    ['刪除'],
    { modal: true, detail: '會移到 .novelwarden/.trash/，可手動找回。' }
  );
  if (pick !== '刪除') {
    return;
  }
  await c.store.delete(id);
  if (id === c.current.id) {
    c.current = c.store.create({
      target: c.current.target,
      stage: c.current.stage,
      targetNo: c.current.targetNo,
      thinking: c.current.thinking,
    });
    c.post({ type: 'session', session: serializeSession(c.current) });
  }
  await c.pushSessions();
}

export async function renameSession(c: ChatController, id: string): Promise<void> {
  const target = await c.store.read(id);
  if (!target) {
    return;
  }
  const title = await getHost().input({
    title: '重新命名對話',
    value: target.title,
    validate: (v) => (v.trim() ? undefined : '不能為空'),
  });
  if (!title) {
    return;
  }
  const updated = await c.store.rename(id, title);
  if (updated && id === c.current.id) {
    c.current.title = updated.title;
    c.post({ type: 'session', session: serializeSession(c.current) });
  }
  await c.pushSessions();
}
