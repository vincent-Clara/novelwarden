/**
 * 寫前衝突檢查的取數與呼叫（百章實驗覆盤）：本章細綱、前面定稿的連續性事實，調一次模型，校驗交回來的
 * 衝突。判斷規則、提示詞與校驗在 model/plotCheck.ts（純函式）。
 *
 * 只在批次寫章裡跑（features/pipelineBatch.ts，預檢之後、寫之前）：批次沒有人看著，細綱與既成事實
 * 對不上還往下寫，就是百章實驗裡死了的人再死一次。對話頁寫一章時作者就在場。
 *
 * 零呼叫的情形：細綱是空的、細綱上記了 `factCheckOk: true`、前面沒有定稿過的章、選不出相關的事實。
 *
 * 2026-10-25 起改成轉寫：比對的模型按格式寫，轉寫模型（「轉寫」那一檔，features/poolIO.ts 的 `poolTranscriber`）照抄成
 * `{"conflicts":[…]}`；只寫了「無矛盾」的不轉。
 */
import { readConfig } from '../config';
import { contextLimitsOf } from '../model/contextDetail';
import { collectText } from '../llm/collect';
import { StreamOptions } from '../llm/provider';
import { scoped } from '../runtime/logger';
import { NovelProject } from '../model/project';
import { isPlotFilled } from '../model/plotFile';
import {
  PLOT_CHECK_JSON_CONTRACT,
  PLOT_CHECK_SYSTEM,
  PlotConflict,
  looksLikePlotCheck,
  plotCheckUser,
  saysNoConflict,
  selectCheckFacts,
  verifyConflicts,
} from '../model/plotCheck';
import { ModelRunner } from './finalize';
import { jsonList } from './parse';
import { poolTranscriber } from './poolIO';
import { TranscribeCall, TranscribeSpec, transcribeJson } from './transcribe';

const log = scoped('流水線');

export interface PlotCheckOutcome {
  /** 實際調了幾次模型。 */
  calls: number;
  conflicts: PlotConflict[];
  /** 模型報了、但兩句原文對不上而丟掉的幾處。 */
  dropped: number;
  /** 沒查的原因（零呼叫）。 */
  skipped?: string;
}

/** 衝突檢查那一步的轉寫：合同、原來的解碼（`conflicts` 陣列），章號按對應關係填。 */
const PLOT_CHECK_TRANSCRIBE: TranscribeSpec<unknown[]> = {
  label: '寫前衝突檢查',
  contract: PLOT_CHECK_JSON_CONTRACT,
  decode: (json) => {
    const list = jsonList(json, 'conflicts');
    return list ? { ok: true, value: list } : { ok: false, message: '缺少 conflicts 陣列' };
  },
  mapped: ['chapter'],
  looksLike: looksLikePlotCheck,
};

/**
 * 比對第 `no` 章的細綱與前面定稿的事實。寫的那一次按格式寫，轉寫模型照抄成 JSON；轉寫不合格重轉 1 次（2026-10-25 起，
 * 替掉了從前「不是合格的 JSON 就帶提醒重來 1 次」——JSON 的毛病現在歸轉寫）。沒按格式寫、轉寫還不行就拋錯——
 * 呼叫方把它當成「這一步沒做成」記一句、照寫（檢查是額外的一道，不該因為它寫不了章）。
 *
 * `transcribe` 預設走「轉寫」那一檔（沒有可用模型時報錯，同樣當成沒做成）。
 */
export async function checkPlotAgainstFacts(
  project: NovelProject,
  no: number,
  runner: ModelRunner,
  signal?: AbortSignal,
  transcribe: TranscribeCall = poolTranscriber(signal ?? new AbortController().signal)
): Promise<PlotCheckOutcome> {
  const plot = await project.getPlot(no);
  if (!plot || !isPlotFilled(plot.sections)) {
    return { calls: 0, conflicts: [], dropped: 0, skipped: '這一章還沒有細綱' };
  }
  if (plot.factCheckOk) {
    return { calls: 0, conflicts: [], dropped: 0, skipped: '細綱上記了 factCheckOk，放行' };
  }
  const finalized = await project.finalizedFacts(no);
  const config = readConfig();
  const limits = contextLimitsOf(config);
  const facts = selectCheckFacts(
    finalized.map((f) => ({ no: f.no, title: f.title, statements: f.facts.map((x) => x.statement) })),
    plot.characters,
    { recent: limits.factsChapters, chars: limits.factsChars }
  );
  if (facts.length === 0) {
    return { calls: 0, conflicts: [], dropped: 0, skipped: '前面沒有同步過、留下連續性事實的章' };
  }

  const text = [plot.sections.梗概, plot.sections.关键事件, plot.sections.看点].filter((s) => s.trim()).join('\n\n');
  const user = plotCheckUser({ no, title: plot.title, text }, facts);
  const options: StreamOptions = {
    maxOutputTokens: runner.primaryBudget.maxOutputTokens,
    temperature: 0.2,
    timeoutMs: config.requestTimeoutMs,
    signal,
  };
  const messages = [
    { role: 'system' as const, content: PLOT_CHECK_SYSTEM },
    { role: 'user' as const, content: user },
  ];
  const raw = await runner.run(`第 ${no} 章 · 寫前衝突檢查`, (llm) => collectText(llm.stream(messages, options)));
  if (saysNoConflict(raw)) {
    return { calls: 1, conflicts: [], dropped: 0 };
  }
  const r = await transcribeJson(raw, PLOT_CHECK_TRANSCRIBE, (m, label) => transcribe(m, `第 ${no} 章 · ${label}`));
  const calls = 1 + r.calls;
  if (r.notes.length > 0) {
    log.info(`第 ${no} 章寫前衝突檢查：${r.notes.join('；')}`);
  }
  if (!r.ok) {
    const why = r.failed ? r.message : r.calls > 0 ? `轉寫沒成：${r.message}` : r.message;
    throw Object.assign(new Error(`寫前衝突檢查的輸出整理不出來（${why}）`), { calls });
  }
  const { conflicts, dropped } = verifyConflicts(r.value, text, facts);
  if (dropped > 0) {
    log.info(`第 ${no} 章寫前衝突檢查：${dropped} 處原文對不上，已丟棄`);
  }
  return { calls, conflicts, dropped };
}
