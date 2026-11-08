import { InMessage, OutMessage } from '../../core/protocol';

type PromptRequest = Extract<OutMessage, { type: 'prompt' }>;
/** 前端的回答：`value`，確認框帶下拉框時另有 `choice`。 */
export type PromptReply = Pick<Extract<InMessage, { type: 'promptResult' }>, 'value' | 'choice'>;

/**
 * 管理未決的網頁彈窗：ask() 經廣播函式發一條 prompt 訊息，
 * 等前端回 promptResult 後 resolve。頁面全部斷開時統一按取消處理。
 */
export class PromptHub {
  private seq = 0;
  private pending = new Map<string, (reply: PromptReply) => void>();

  constructor(private readonly broadcast: (msg: OutMessage) => void) {}

  ask(req: Omit<PromptRequest, 'type' | 'requestId'>): Promise<PromptReply> {
    const requestId = `p${++this.seq}-${Date.now().toString(36)}`;
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve);
      this.broadcast({ type: 'prompt', requestId, ...req });
    });
  }

  resolve(requestId: string, reply: PromptReply): void {
    const done = this.pending.get(requestId);
    if (!done) {
      return;
    }
    this.pending.delete(requestId);
    done(reply);
  }

  /** WS 全部斷開時，未決彈窗一律按取消處理。 */
  cancelAll(): void {
    for (const done of this.pending.values()) {
      done({});
    }
    this.pending.clear();
  }
}
