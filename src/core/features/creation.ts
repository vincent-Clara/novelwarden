/**
 * 設定頁的連線測試 + 兩個輸出小工具。
 *
 * 這個檔案從前是 `CreationSession`——一個類同時管四件事：有沒有在生成、
 * 裝配上下文、解析產物、落盤（六條分支）。四件事各自搬走之後它就沒了：
 *
 * | 從前的職責 | 現在在哪 |
 * |---|---|
 * | `currentAbort` 併發控制 | `controller/index.ts`（那是**排程**的責任） |
 * | 裝配 + 調模型 + 解析 | `generation/generate.ts`（無狀態，收 signal） |
 * | `acceptArtifact` 六條分支 | `generation/accept.ts`（守衛在 `workspace/`） |
 * | `preview()` | `generation/generate.ts` 的 `previewContext` |
 *
 * 留在這裡的三樣東西都跟創作編排沒關係：`testConnection` 是設定頁的活，
 * `cleanOutput` / `suggestTitle` 是純文字工具（前者還被 `pipelineBatch.ts`
 * 用著）。
 */
import { buildProvider } from '../llm/registry';
import { readConfig } from '../config';
import { describeError, elapsed, scoped } from '../runtime/logger';
import { sanitizeFileName } from '../model/fs';
import {
  describeModelIssue,
  ProviderProfile,
  providerLabel,
  resolveModelRef,
  withDraftProvider,
} from '../model/providers';

const log = scoped('創作');

/**
 * 發一個最小請求驗證配置能不能用。
 * 設定頁的「測試連線」——比讓使用者先寫半章再發現 Key 填錯好得多。
 *
 * **嚴格用指定的那個模型**，不走分檔池、不 fallback（第 12 條）：測的就是
 * 「這一個能不能用」，換成別的答案毫無意義。
 *
 * @param ref 要測的模型引用；留空則測當前選中的。
 * @param draft 設定頁螢幕上那份尚未儲存的服務商配置。給了就以它為準——
 *   「新加的模型必須先儲存才能測」對使用者毫無道理，而且儲存一份沒驗過的
 *   配置正是測試想要避免的事。
 */
export async function testConnection(
  ref?: string,
  draft?: ProviderProfile
): Promise<{ ok: boolean; message: string }> {
  const config = readConfig();
  // 草稿只補充、不替換：其餘服務商仍用已儲存的，這樣 ref 指向別家時照樣能解析。
  const providers = withDraftProvider(config.providers, draft);
  const active = ref ? resolveModelRef(providers, ref) : config.active;
  if (!active) {
    return { ok: false, message: describeModelIssue(providers, ref ?? config.model) };
  }
  const provider = await buildProvider(active);
  if (!provider) {
    return {
      ok: false,
      message: `未配置「${providerLabel(active.profile)}」的 API Key，已取消測試。`,
    };
  }
  log.info(`測試連線 ${active.ref}`, provider.label);
  const startedAt = Date.now();
  const abort = new AbortController();
  try {
    let reply = '';
    for await (const ev of provider.stream(
      [{ role: 'user', content: '回覆兩個字：收到' }],
      { maxOutputTokens: active.model.maxOutputTokens ?? config.maxOutputTokens, temperature: 0, timeoutMs: 30000, signal: abort.signal }
    )) {
      if (ev.type !== 'text') {
        continue;
      }
      reply += ev.text;
      // 拿到任何內容就算通了，不必等它說完。
      if (reply.trim().length >= 2) {
        break;
      }
    }
    if (reply.trim()) {
      log.info(`${active.ref} 連線正常`, `回覆「${reply.trim().slice(0, 20)}」，用時 ${elapsed(startedAt)}`);
      return { ok: true, message: `${active.ref} 連線正常：${provider.label} 回覆「${reply.trim().slice(0, 20)}」` };
    }
    log.warn(`${active.ref} 連線成功但沒有返回內容`, `用時 ${elapsed(startedAt)}，檢查模型名是否正確`);
    return { ok: false, message: `${active.ref} 連線成功但沒有返回內容，檢查模型名是否正確。` };
  } catch (err) {
    log.error(`${active.ref} 連線失敗：${describeError(err)}`, err);
    return { ok: false, message: `${active.ref}：${describeError(err)}` };
  }
}

// ---------------------------------------------------------------- 輸出清理

/**
 * 清理模型輸出裡常見的贅餘：包裹的程式碼塊、開場白、被要求不寫卻仍寫出的標題。
 * 只做保守清理，不改動正文字身。
 *
 * **只對正文層用**。在 JSON 產物上跑這幾條正則會切壞結構——產物裡的
 * ``` 由 `parse.ts` 的 `stripCodeFence` 在解析時處理。
 */
export function cleanOutput(text: string): string {
  let out = text.trim();

  const fence = /^```(?:\w+)?\r?\n([\s\S]*?)\r?\n?```$/.exec(out);
  if (fence) {
    out = fence[1].trim();
  }

  // 開頭的「好的，以下是……」之類
  out = out.replace(/^(好的|(?:没|沒)(?:问|問)(?:题|題)|明白了)[^\n]{0,40}[:：]\s*\r?\n+/, '');
  out = out.replace(/^(以下是|下面是)[^\n]{0,40}[:：]?\s*\r?\n+/, '');

  // 開頭的章節標題行（我們在 prompt 裡禁止了，但模型常忍不住）
  out = out.replace(/^#{1,6}\s*第?\s*[\d一二三四五六七八九十百]+\s*章[^\n]*\r?\n+/, '');
  out = out.replace(/^第\s*[\d一二三四五六七八九十百]+\s*章[ 　]*[^\n]{0,20}\r?\n+/, '');

  // 結尾的字數統計/創作說明
  out = out.replace(/\r?\n+[（(]?\s*(本章|全文|以上)?\s*((?:约|約)|共)?\s*\d+\s*字\s*[)）]?\s*$/, '');
  out = out.replace(/\r?\n+[-—]{3,}[\s\S]*$/, (m) => (m.length < 200 ? '' : m));

  return out.trim();
}

/** 給新章節起個預設標題：優先用綱要首句。 */
export function suggestTitle(outline: string, order: number): string {
  const firstLine = outline
    .split(/\r?\n/)
    .map((s) => s.replace(/^[\s\-*\d.、)]+/, '').trim())
    .find((s) => s.length > 0);
  if (!firstLine) {
    return `第${order}章`;
  }
  const clipped = firstLine.split(/[。！？；,，.!?;]/)[0].trim().slice(0, 18);
  return sanitizeFileName(clipped) || `第${order}章`;
}
