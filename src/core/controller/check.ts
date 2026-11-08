/**
 * 內建編輯器「寫作體檢」的後端一半：推詞表（`checkTerms`），以及「編輯敏感詞表…」。
 *
 * 兩件事都**不調模型**（第 4 條：體檢只是在正文裡按詞表找字）。
 *
 * - **推詞表**：`pushState` 每跑一次就現算一份（`views/checkTerms.ts`：`style.md` 的禁用詞表、小說配置、
 *   `.novelwarden/sensitive.txt`），與上一次推的一樣就不推——與 `chapterIndex` 同一個做法；新連上的前端不論變沒變
 *   都推一份。只給有內建編輯器的宿主推（`Host.openInEditor` 這個能力），外掛殼用不上，也就不為它多讀兩個檔案。
 * - **編輯敏感詞表…**：檔案不在就經閘道器新建一份帶說明註釋的模板（`workspace.write`，`mode: 'create'`：同名報錯、
 *   不覆蓋），然後在編輯器裡開啟它；作者儲存也走閘道器（編輯器那條路，樂觀鎖、存歷史版本）。
 *
 * 敏感詞表在指紋鏈之外：種類是 `sensitive`（`workspace/kind.ts`），沒有創作階段、不進裝配器、不記 `upstreamHash` /
 * `writtenFrom`，改了它不會讓任何一章掛 ⟳；新建是作者點的那一下（檔案本來不在，沒有可覆蓋的），儲存是編輯器的
 * 樂觀鎖，所以都不彈覆蓋審閱（第 3 條的那一問由這兩樣擔著）。
 */
import type { ChatController } from './index';
import { getHost } from '../host';
import { describeError, scoped } from '../runtime/logger';
import { exists } from '../model/fs';
import { SENSITIVE_TEMPLATE } from '../model/sensitiveWords';
import type { BookConfig } from '../model/settingFile';
import { buildCheckTerms } from '../views/checkTerms';
import { WsError } from '../workspace/guard';

const log = scoped('體檢');

/** 每個 controller 上一次推出去的詞表（JSON）。 */
const lastSig = new WeakMap<ChatController, string>();

/**
 * 推體檢詞表。內容與上一次推的一樣就不推；`force` 給新連上的前端。`book` 是呼叫方手上已經讀過的小說配置。
 * 失敗只記 warn，不拖垮呼叫它的 `pushState`。
 */
export async function pushCheckTerms(c: ChatController, opts: { force?: boolean; book?: BookConfig } = {}): Promise<void> {
  if (!getHost().openInEditor) {
    return;
  }
  try {
    const terms = await buildCheckTerms(c.project, { book: opts.book });
    const sig = JSON.stringify(terms);
    if (!opts.force && lastSig.get(c) === sig) {
      return;
    }
    lastSig.set(c, sig);
    c.post({ type: 'checkTerms', terms });
  } catch (err) {
    log.warn(`算體檢詞表失敗：${describeError(err)}`, err);
  }
}

/** 「編輯敏感詞表…」：沒有就新建模板，然後在編輯器裡開啟。 */
export async function editSensitiveWords(c: ChatController): Promise<void> {
  if (!(await c.project.isInitialized())) {
    c.toast('這個目錄還不是小說工程（沒有 .novelwarden/），沒有敏感詞表可編輯。', 'error');
    return;
  }
  const rel = c.project.relPath(c.project.sensitivePath);
  if (!(await exists(c.project.sensitivePath))) {
    try {
      await c.workspace.write(rel, { text: SENSITIVE_TEMPLATE }, { mode: 'create' });
      log.info(`新建了敏感詞表 ${rel}`, '全是註釋的模板，一個詞都還沒生效');
      await pushCheckTerms(c);
    } catch (err) {
      // 剛好在這一刻別處建了它：照樣開啟那一份，不蓋掉。
      if (!(err instanceof WsError && err.code === 'exists')) {
        throw err;
      }
    }
  }
  const host = getHost();
  await (host.openInEditor ? host.openInEditor(rel) : host.openFile(rel));
}
