import type { ChatController } from './index';
import { nowIso } from '../model/session';

/** 落盤當前會話，並在需要時重新整理歷史列表。 */
export async function persist(c: ChatController): Promise<void> {
  // 空會話不落盤——歷史列表裡不該出現一堆沒說過話的佔位。
  if (c.current.turns.length === 0) {
    return;
  }
  c.current.updatedAt = nowIso();
  await c.store.write(c.current);
  if (c.tab === 'history') {
    await c.pushSessions();
  }
}
