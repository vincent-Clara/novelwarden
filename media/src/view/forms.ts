/**
 * 三個具體的彈窗：一句話（W4）、拆細綱（W5）與批次寫章（W9）。表單本身在 form.ts。
 *
 * 它們的「預計呼叫幾次」都來自 core 的純函式（`describeCalls` / `planPlotBatches` /
 * `planWriteBatch`），與後端確認框同源——彈窗寫著 3 次、實際調了 4 次，正是第 4 條要防的事。
 */
import {
  CONFIG_CALLS,
  DEFAULT_CONTEXT_DETAIL,
  PLOT_BATCH,
  WRITE_BATCH_DEFAULT,
  WRITE_BATCH_MAX,
  describeCalls,
  describeThinLore,
  describeThreadReminders,
  planPlotBatches,
  planWriteBatch,
  threadRemindersFor,
  unrecordedBefore,
} from '../protocol';
import type { WriteBatchMode } from '../protocol';
import type { IdeaDefaults, ProjectTree } from '../protocol';
import { callChoiceOf, callFields } from './callFields';
import { openForm } from './form';
import type { FormField, FormValues } from './form';
import { setBusy } from './state';
import { store, vscode } from './store';
import { showTab } from './tabs';

/** 一句話彈窗的預設規模（與後端「補齊架構」沒寫規模時的預設一致）。 */
const DEFAULT_TOTAL = 100;
const DEFAULT_WORDS = 3000;

/**
 * 批次表單末尾的兩個下拉框：這一次用哪個模型、帶多少上下文（預設按分檔、設定頁那一級）。提交時作為 `call` 帶給後端——
 * 帶了就是表單已經問過，後端不再彈第二個確認框。
 */
function batchCallFields(): FormField[] {
  return callFields(store.state?.models ?? [], store.state?.contextDetail ?? DEFAULT_CONTEXT_DETAIL);
}

/** 「30 萬字」「4.5 萬字」「8000 字」。 */
function totalWords(n: number): string {
  return n >= 10000 ? `${Number((n / 10000).toFixed(1))} 萬字` : `${n} 字`;
}

/**
 * 「從一句話生成小說配置」。
 *
 * 提交就是一次普通的創作傳送（架構層 · 生成 · 小說配置），外加 `setup`：規模以這裡為準，
 * 作者這句話寫進「一句話」那一節。`config.md` 已經寫過東西時明說「保留原文，追加生成」
 * ——後端就是這麼合的（generation/structured.ts 的 `completeConfig`）。
 *
 * 已經寫了正文（`writtenThrough`）時是「照已寫正文生成」：後端裝配時自動帶上已寫正文
 * （context/builder.ts 的 `settingFromText`），那句話變成可留空的補充要求。
 */
export function openIdeaForm(defaults?: IdeaDefaults): void {
  const written = defaults?.writtenThrough ?? 0;
  const keep = defaults?.configHasContent ? '小說配置裡已經寫了東西：保留原文，生成的追加在後；你選過的型別、結構、視角不改。' : '';
  openForm({
    title: written > 0 ? '照已寫正文生成小說配置' : '從一句話生成小說配置',
    lead:
      written > 0
        ? `已經寫了第 1–${written} 章：AI 照正文歸納型別、賣點、主角、金手指與跨章的全域要求，不另編正文裡沒有的設定。${keep}`
        : keep || '寫下你的腦洞，AI 把它展開成一份小說配置：型別、賣點、主角、金手指、跨章的全域要求。',
    fields: [
      {
        kind: 'textarea',
        key: 'idea',
        label: written > 0 ? '補充要求（可留空）' : '一句話 / 腦洞',
        value: defaults?.idea ?? '',
        rows: 5,
        required: written === 0,
        placeholder:
          written > 0
            ? '比如：賣點多寫主角的反差；後面打算轉向校園之外的大世界。'
            : '比如：一個從火裡活下來的人回到起火的地方，發現倖存者不止他一個。',
      },
      {
        kind: 'number',
        key: 'totalChapters',
        label: '總章數',
        // 已經寫了正文時與「從已寫正文補齊」問總章數的預設同一個演算法（model/importText.ts 的 defaultTotalChapters）。
        value: defaults?.totalChapters ?? Math.max(DEFAULT_TOTAL, Math.ceil((written * 2) / 50) * 50),
        min: Math.max(1, written),
        max: 5000,
      },
      {
        kind: 'number',
        key: 'wordsPerChapter',
        label: '每章字數',
        value: defaults?.wordsPerChapter ?? DEFAULT_WORDS,
        min: 200,
        max: 30000,
        step: 100,
      },
    ],
    note: (v) => ({
      // 原因（寫 1 次、轉寫 1 次……）太長，這一行只報數；主按鈕的提示裡有全句。
      text: `全書約 ${totalWords(Number(v.totalChapters) * Number(v.wordsPerChapter))} · ${describeCalls(CONFIG_CALLS).replace(/（.*）$/, '')} · Ctrl+Enter 提交`,
    }),
    submitLabel: '生成小說配置',
    onSubmit: (v) => {
      if (store.busy) {
        return;
      }
      showTab('chat');
      vscode.postMessage({ type: 'switchTab', tab: 'chat' });
      setBusy(true);
      vscode.postMessage({
        type: 'send',
        payload: {
          text: String(v.idea),
          stage: 'setting',
          capability: 'generate',
          target: { kind: 'setting', doc: 'config' },
          targetNo: 1,
          setup: { totalChapters: Number(v.totalChapters), wordsPerChapter: Number(v.wordsPerChapter) },
          attachments: [],
          excludedIds: [],
        },
      });
    },
  });
}

/**
 * 「批次拆細綱」：選一段章號，已有細綱的章跳過。
 *
 * 預設是下一可寫章起 {@link PLOT_BATCH} 章，不越過大綱的覆蓋與總章數。實時說明寫出
 * 這一段要拆幾章、跳過幾章、分幾批、預計與最多呼叫幾次——提交時帶上 `call`（這一次的模型與詳細度），
 * 後端不再彈第二個確認框（不疊彈窗）。
 *
 * 「拆完展開本批新設定」（完善設定三期，預設「否」）：拆完把這一次順帶新建的設定空條目批次展開。新設定有幾條要拆完才知道，
 * 所以這裡不報那幾次，後端拆完再問一次（同批次寫章補建角色卡那一問，第 4 條）。
 */
export function openPlotBatchForm(tree: ProjectTree): void {
  const { book } = tree;
  const outlineFilled = tree.architecture.some((a) => a.key === 'outline' && a.filled);
  const cap = Math.min(book.outlineCoverage ?? Infinity, book.totalChapters ?? Infinity);
  const from = tree.nextChapterNo;
  const to = Math.max(from, Math.min(from + PLOT_BATCH - 1, cap));
  openForm({
    title: '批次拆細綱',
    lead: '從情節大綱裡把這一段章節拆成一章一份的細綱。已經排過細綱的章跳過，不會被改動；每批寫完就落盤，一批失敗就停。',
    fields: [
      { kind: 'number', key: 'from', label: '從第幾章', value: from, min: 1, max: 99999 },
      { kind: 'number', key: 'to', label: '到第幾章', value: to, min: 1, max: 99999 },
      {
        kind: 'select',
        key: 'expandLore',
        label: '拆完展開本批新設定',
        value: 'off',
        options: [
          { value: 'off', label: '否' },
          { value: 'on', label: '是（拆完再報次數、再問一次）' },
        ],
      },
      ...batchCallFields(),
    ],
    note: (v) => {
      const a = Number(v.from);
      const b = Number(v.to);
      if (!outlineFilled) {
        return { text: '情節大綱還沒寫。先生成大綱，細綱才有依據。', ok: false };
      }
      if (b < a) {
        return { text: '區間寫反了。', ok: false };
      }
      if (b > cap) {
        return {
          text: Number.isFinite(book.outlineCoverage ?? Infinity) && b > (book.outlineCoverage ?? Infinity)
            ? `情節大綱只覆蓋到第 ${book.outlineCoverage} 章，先續寫大綱。`
            : `全書只有 ${book.totalChapters} 章。`,
          ok: false,
        };
      }
      // 一條敘事線都還沒有：後端開拆之前先從情節大綱排一次（同一個 `planPlotBatches`，排 1 次、轉寫 1 次）。
      const planThreads = tree.threads.lines.length === 0;
      const plan = planPlotBatches({ from: a, to: b, filledNos: book.plotFilledNos, planThreads });
      if (plan.batches.length === 0) {
        return { text: '這一段都已經排過細綱了。', ok: false };
      }
      return {
        text:
          `要拆 ${plan.chapters.length} 章，分 ${plan.batches.length} 批（每批最多 ${PLOT_BATCH} 章）` +
          `${plan.skipped.length > 0 ? `，跳過已有細綱的 ${plan.skipped.length} 章` : ''}。` +
          `${describeCalls(plan.calls)}（每批寫 1 次、轉寫模型照抄成 JSON 1 次；被截斷或轉寫不成時自動拆小重試）。` +
          (planThreads ? '還沒有敘事線：開拆之前先從情節大綱排一次（排 1 次、轉寫 1 次，算在裡面）。' : '') +
          (v.expandLore === 'on'
            ? '拆完展開本批新設定：每條 1 次，有幾條要拆完才知道，到時再報次數、再問一次；不在這裡的數裡。'
            : ''),
      };
    },
    submitLabel: '開始拆細綱',
    onSubmit: (v) => {
      vscode.postMessage({
        type: 'projectAction',
        action: 'generatePlots',
        range: { from: Number(v.from), to: Number(v.to) },
        call: callChoiceOf(v),
        ...(v.expandLore === 'on' ? { expandLore: true } : {}),
      });
    },
  });
}

/** 「第 3 章」或「第 3–7 章」。 */
function span(from: number, to: number): string {
  return from === to ? `第 ${from} 章` : `第 ${from}–${to} 章`;
}

/**
 * 「批次寫章」（W9）：選一段章號與模式，一章一章序列寫。
 *
 * 預設從下一可寫章起 {@link WRITE_BATCH_DEFAULT} 章，一次最多 {@link WRITE_BATCH_MAX} 章。實時說明
 * 寫出這一段要寫幾章、跳過幾章、在哪收住、呼叫次數上限——提交時帶上 `call`（這一次的模型與詳細度），後端不再彈
 * 第二個確認框（有角色卡要補建時除外，預設是這裡的選擇）。「寫完即定稿」「寫完即審稿」會自動多花那幾次呼叫（D17、五期補遺 §4），提交鍵要點兩下。
 * 要寫的幾章用到、卻還只有一句話的設定（工程樹上的「待完善」）在說明末尾提一句，不攔（完善設定三期 · 寫前提醒）。
 */
export function openWriteBatchForm(tree: ProjectTree): void {
  const writtenNos = tree.plots.filter((p) => p.chapterPath && p.wordCount > 0).map((p) => p.no);
  const plotFilledNos = tree.book.plotFilledNos;
  // 大綱覆蓋缺席就是還沒寫大綱（或一條章標題都認不出）。
  const outlineCoverage = Math.min(tree.book.outlineCoverage ?? 0, tree.book.totalChapters ?? Infinity);
  const from = tree.nextChapterNo;
  const plan = (v: FormValues) =>
    planWriteBatch({
      from: Number(v.from),
      to: Number(v.to),
      mode: v.mode === 'finalize' ? 'finalize' : 'draft',
      review: v.review === 'on',
      writtenNos,
      plotFilledNos,
      outlineCoverage,
      globalSummaryThrough: tree.globalSummaryThrough,
    });
  openForm({
    title: '批次寫章',
    lead:
      '從這一章起一章一章寫正文，後一章接著前一章的結尾寫。已經有正文的章跳過，不會被改動；' +
      '一章寫不出來就停；寫出來但開頭重演了上一章、把後面幾章的人提前寫了進來、或沒寫夠八成，也寫進去然後停下，等你看過再繼續。',
    fields: [
      { kind: 'number', key: 'from', label: '從第幾章', value: from, min: 1, max: 99999 },
      { kind: 'number', key: 'to', label: '到第幾章', value: from + WRITE_BATCH_DEFAULT - 1, min: 1, max: 99999 },
      {
        kind: 'select',
        key: 'mode',
        label: '模式',
        value: 'draft',
        options: [
          { value: 'draft', label: '只寫正文' },
          { value: 'finalize', label: '寫完即同步（每寫完一章就同步）' },
        ],
      },
      {
        kind: 'select',
        key: 'review',
        label: '審稿',
        value: 'off',
        options: [
          { value: 'off', label: '不審' },
          { value: 'on', label: '寫完即審稿（每寫完一章審一遍，報告放進一個新會話）' },
        ],
      },
      ...batchCallFields(),
    ],
    note: (v) => {
      const a = Number(v.from);
      const b = Number(v.to);
      if (b < a) {
        return { text: '區間寫反了。', ok: false };
      }
      if (b - a + 1 > WRITE_BATCH_MAX) {
        return { text: `一次最多寫 ${WRITE_BATCH_MAX} 章。`, ok: false };
      }
      const p = plan(v);
      if (p.chapters.length === 0) {
        return {
          text: p.stopAt !== undefined ? `第 ${p.stopAt} 章還沒有細綱，情節大綱也沒覆蓋到它。先續寫大綱。` : '這一段都已經寫過正文了。',
          ok: false,
        };
      }
      const first = p.chapters[0];
      const last = p.chapters[p.chapters.length - 1];
      // 寫前提醒（完善設定三期，零呼叫、不攔）：要寫的這幾章用到、卻還只有一句話的設定——就是「待完善」裡要用到它們的那幾條。
      const writing = new Set(p.chapters);
      const thin = (tree.loreThin ?? []).filter((t) => t.chapters.some((no) => writing.has(no)));
      // 敘事線提醒（二期，零呼叫、不攔）：區間裡寫到哪一章就過了回收章、斷了幾章，區間裡的計劃又都沒安排的。與後端確認框
      // 同一個 `threadRemindersFor`，資料是工程頁「敘事線」那一份（按現在算）；「還沒記上」的那幾章按敘事線判到哪（四期）。
      const threadNote = describeThreadReminders(
        '区间里',
        threadRemindersFor(tree.threads?.watch, p.chapters),
        unrecordedBefore(tree.threads?.through ?? tree.threads?.current ?? 0, first)
      );
      return {
        text:
          `要寫 ${p.chapters.length} 章（${span(first, last)}）` +
          `${p.skipped.length > 0 ? `，跳過已有正文的 ${p.skipped.length} 章` : ''}` +
          `${p.stopAt !== undefined ? `；第 ${p.stopAt} 章還沒有細綱、大綱也沒覆蓋到，寫到它前面為止` : ''}。` +
          (p.plotBatches.length > 0
            ? `${p.plotBatches.map((b) => span(b[0], b[b.length - 1])).join('、')}還沒有細綱，寫到時先拆（拆的時候看得見前面同步下來的事實）。`
            : '') +
          `${describeCalls(p.calls)}（沒寫夠時自動續寫、開著刪修飾時寫完再刪一次、每章寫前比對一次細綱與既成事實，比對與審稿的結果由轉寫模型照抄成 JSON，都算在上限裡）。` +
          (p.review ? '每寫完一章先審一遍，報告放進一個新會話「批次審稿」，在對話頁逐章勾選修稿；審出問題不停。' : '') +
          (p.mode === 'finalize'
            ? '每寫完一章就同步：照正文更新細綱與連續性事實，再更新出場角色的當前狀態、認這一章在敘事線上發生了什麼（帶原文證據記下事件、更新各條線的當前進度，正文裡新長出來的線也認出來）、推這一章的故事時間；同步的每一次寫完都由轉寫模型照抄成 JSON（算在上限裡）。'
            : '只寫正文，之後在主按鈕上逐章同步。') +
          (thin.length > 0 ? describeThinLore('区间里', thin.map((t) => t.name)) : '') +
          threadNote,
      };
    },
    submitLabel: '開始寫章',
    confirm: (v) => {
      const p = plan(v);
      const extra = [p.review ? '寫完即審稿' : '', p.mode === 'finalize' ? '寫完即同步' : ''].filter(Boolean).join('、');
      return extra ? `再點一下：${extra} ${p.chapters.length} 章` : undefined;
    },
    onSubmit: (v) => {
      const mode: WriteBatchMode = v.mode === 'finalize' ? 'finalize' : 'draft';
      vscode.postMessage({
        type: 'projectAction',
        action: 'writeManuscripts',
        range: { from: Number(v.from), to: Number(v.to) },
        mode,
        ...(v.review === 'on' ? { review: true } : {}),
        call: callChoiceOf(v),
      });
    },
  });
}
