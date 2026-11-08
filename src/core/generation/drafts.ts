/**
 * Draft store：還沒落盤的產物存哪裡。
 *
 * ## 為什麼要有它
 *
 * `generate` 產出的 `Draft` 一個字都沒寫盤。它至少要活到作者在那張落盤卡片
 * 上點頭的那一刻（`controller/gate.ts`），而 agent 手裡的 draftId 還可能被
 * 它稍後用 `write draftId=…` 拿去寫。所以：記憶體為主（`Map`），**隨會話 JSON
 * 一起落盤**（`.novelwarden/sessions/<id>.json`）——翻回一箇舊會話接著讓 agent
 * 幹活時，那幾份草稿還得在。
 *
 * ## 不進 SQLite
 *
 * 第 17 條：庫只放可丟棄的痕跡，內容的唯一真相是 Markdown。draft 是未落盤的
 * 內容，但它跟著會話走，而會話本來就是 JSON。
 *
 * ## 容錯讀取不在這裡
 *
 * 會話檔案的容錯歸一化全在 `model/session.ts` 的 `normalize()`——`drafts`
 * 只是它的又一個欄位，沒道理單開一套。認不出的草稿在那裡就被丟掉了，
 * 裝進本store 的一律是已經歸一過的。
 */
import type { SessionDraft } from '../model/session';
import type { Draft } from './generate';

export type { Draft };

/**
 * 一個會話最多留幾份草稿。
 *
 * `draft.raw` 與 `ChatTurn.content` 是同一段文字，全留著等於把會話檔案
 * 寫兩遍——一場幾十輪的正文對話就是幾十萬字。留最近的若干份足夠：
 * 更早那些輪次寫不寫盤，早就當場問過了。
 */
export const MAX_DRAFTS_PER_SESSION = 20;

/**
 * 記憶體裡的草稿表。**一個 controller 一份**（會話之間不共享）。
 *
 * 按會話分桶而不是一張大表：會話關掉時要能整桶扔掉，而按 draftId 逐個刪
 * 需要先知道有哪些——那份名單隻有會話自己有。
 */
export class DraftStore {
  private readonly bySessionId = new Map<string, Draft[]>();
  private readonly byId = new Map<string, Draft>();

  /** 記一份新草稿。超出上限時丟最老的。 */
  put(draft: Draft, sessionId: string): void {
    const list = this.bySessionId.get(sessionId) ?? [];
    // 同 id 覆蓋：重來一輪時草稿也該跟著換掉那一份。
    const existing = list.findIndex((d) => d.id === draft.id);
    if (existing !== -1) {
      list.splice(existing, 1);
    }
    list.push(draft);
    while (list.length > MAX_DRAFTS_PER_SESSION) {
      const dropped = list.shift();
      if (dropped) {
        this.byId.delete(dropped.id);
      }
    }
    this.bySessionId.set(sessionId, list);
    this.byId.set(draft.id, draft);
  }

  get(id: string): Draft | undefined {
    return this.byId.get(id);
  }

  /** 某個會話的全部草稿，按產生順序。落盤時寫的就是這一份。 */
  bySession(sessionId: string): Draft[] {
    return [...(this.bySessionId.get(sessionId) ?? [])];
  }

  /** 會話切換/關閉時清掉該會話的草稿。 */
  dropBySession(sessionId: string): void {
    for (const draft of this.bySessionId.get(sessionId) ?? []) {
      this.byId.delete(draft.id);
    }
    this.bySessionId.delete(sessionId);
  }

  /**
   * 開啟會話時把落盤的那批裝回記憶體。整桶替換，不合併——
   * 同一個會話被重新開啟時，磁碟上那份就是全部真相。
   *
   * 收的是 `SessionDraft`（`artifact` 是不透明的）：資料層不認識 `Artifact`，
   * 而這份快照只用於畫卡片，採納時會拿氣泡裡當下的文字重新解析。
   */
  load(sessionId: string, list: SessionDraft[] | undefined): void {
    this.dropBySession(sessionId);
    for (const draft of list ?? []) {
      this.put(draft as Draft, sessionId);
    }
  }
}
