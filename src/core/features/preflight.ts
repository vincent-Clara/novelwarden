/**
 * 一致性預檢的取數（五期）：本章細綱排了誰、他們的卡上「當前狀態」怎麼寫的、前面定稿過的章留下了
 * 哪些連續性事實。判斷在 model/preflight.ts（純函式）。
 *
 * 零呼叫：只讀細綱（本章的計劃與前面各章的定稿）與角色卡。兩個入口：對話頁寫第 N 章之前（controller/chat.ts，亮一張卡，
 * 可以「僅本次忽略」或「記為刻意安排」）；工程頁批次寫章開跑之前與每一章之前（features/pipelineBatch.ts）。
 *
 * 細綱裡記下的永久放行（`preflightOk`，五期補遺 §2）在這裡分出去：兩個入口都只為剩下的那些停。
 *
 * 敘事線的兩類提醒（二期，設計稿「四、寫前檢查」）：伏筆逾期、線斷了。照「設定還只有一句話」（`thinLoreFor`）那套做，
 * **不進 `risks`**（那是要攔人的），另放一個欄位，說明裡提一句、照寫不攔。取數在 views/threads.ts 的 `threadReminders`。
 */
import { NovelProject } from '../model/project';
import { PreflightRisk, describeRisk, findPreflightRisks, splitExempt } from '../model/preflight';
import { ThreadReminder, describeThreadReminders, unrecordedBefore } from '../model/pipeline';
import { threadReminders } from '../views/threads';

export { describeExempted, describeRisk, PREFLIGHT_SUGGESTION } from '../model/preflight';
export type { PreflightRisk } from '../model/preflight';

export interface PreflightResult {
  /** 要作者留意的（沒有被永久放行的）。 */
  risks: PreflightRisk[];
  /** 細綱裡記過永久放行的：不攔，只在說明裡提一句。 */
  exempted: { risk: PreflightRisk; reason: string }[];
  /** 這一章細綱的路徑（記永久放行要寫它）。沒有細綱時缺席。 */
  plotRelPath?: string;
  /** 敘事線的提醒（二期）：伏筆逾期、線斷了。不攔（不進 `risks`），說明裡提一句（{@link describeThreadNotes}）。 */
  threads: ThreadReminder[];
  /** 敘事線記到第幾章（定稿到的最後一章）：與這一章之間還有沒定稿的章時，提醒可能不準，說法裡注一句。 */
  threadsThrough: number;
}

/**
 * 第 `no` 章的預檢。這一章沒有細綱、細綱裡沒排人，風險都是空的——沒有可比的東西；敘事線的提醒照算（它看的是敘事線，
 * 不看這一章排了誰）。
 */
export async function preflightChapter(project: NovelProject, no: number): Promise<PreflightResult> {
  const plot = await project.getPlot(no);
  const { reminders: threads, through: threadsThrough } = await threadReminders(project, [no]);
  if (!plot || plot.characters.length === 0) {
    return { risks: [], exempted: [], ...(plot ? { plotRelPath: plot.relPath } : {}), threads, threadsThrough };
  }
  const [cards, finalized] = await Promise.all([project.listCharacters(), project.finalizedFacts(no)]);
  const all = findPreflightRisks({
    no,
    planned: plot.characters,
    cards: cards.map((c) => ({
      name: c.name,
      aliases: c.aliases,
      state: c.sections.当前状态 ?? '',
      stateThrough: c.stateThrough,
      relPath: c.relPath,
    })),
    facts: finalized.map((f) => ({ no: f.no, relPath: f.relPath, statements: f.facts.map((x) => x.statement) })),
  });
  return { ...splitExempt(all, plot.preflightOk), plotRelPath: plot.relPath, threads, threadsThrough };
}

/**
 * 敘事線提醒那一句（對話頁的卡片與說明、工作臺、批次寫章的確認框同一句，`describeThreadReminders`）：第 `first` 章起寫，
 * 敘事線記到第 `through` 章。沒有提醒是空串。
 */
export function describeThreadNotes(
  scope: '本章' | '区间里',
  reminders: readonly ThreadReminder[],
  through: number,
  first: number
): string {
  return describeThreadReminders(scope, reminders, unrecordedBefore(through, first));
}

/** 一處風險的身份：同一章、同一個人。批次裡「開跑前問過、作者說僅本次忽略」的那幾處按它認。 */
export function riskKey(no: number, risk: PreflightRisk): string {
  return `${no}:${risk.name}`;
}

/** 卡片、確認框、日誌裡的那幾行：「第 3 章：沈秋的當前狀態……」。 */
export function describeRisks(no: number, risks: readonly PreflightRisk[], withChapter = false): string[] {
  return risks.map((r) => `${withChapter ? `第 ${no} 章：` : ''}${describeRisk(r)}`);
}
