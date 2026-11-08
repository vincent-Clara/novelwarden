import { traditionalLabel } from '../model/labels';
/**
 * 敘事線的計劃事件隨細綱走（敘事線二期，設計見 docs/design/plans/2026-10-20-narrative-threads.md「二」與「誰能寫什麼」）：
 * 第 N 章的細綱寫入時，各條線裡第 N 章的計劃事件**整組換掉**；埋了一條沒見過的伏筆，在它掛的那條線（掛不上就是
 * 「未歸屬的伏筆」）的「伏筆」末尾加一行。細綱裡不再有任何關於線的小節——計劃只記線上裡。
 *
 * - **寫入卡片上先列出來**（{@link describeThreadPlan}，第 19 條的例外清單：與「細綱帶出的新角色隨細綱一起建卡」同一類）；
 *   批次拆細綱沒有卡片，確認框就是那一問（同新角色建卡）。
 * - **只在細綱真的寫進去之後才換**：作者在覆蓋審閱裡放棄了的、批次裡跳過已有的，那一章的計劃一條不動
 *   （generation/accept.ts 只把寫進去的那幾章交過來）。合同裡沒寫 `threads`（老會話裡的草稿、手寫的 Markdown）也不動。
 * - **外科式**：都在寫之前那一刻重讀（`Workspace.updateThread`），只換那幾章的計劃事件、只在「伏筆」末尾加行
 *   （model/threadFile.ts 的 `replacePlannedEvents` / `appendForeshadowing`）；別的章、實際事件、作者寫的行一個字不動，
 *   舊版由閘道器存歷史。
 * - 認線、認伏筆在 model/threadFile.ts 的 `resolvePlanEvents`：線的事件認不出是哪條線就丟掉，伏筆的事件跟著伏筆走，沒見過的
 *   伏筆被埋了就登記成新伏筆，沒埋就「收」的丟掉。沒寫進去的在卡片與日誌裡說出來（第 2 條）。
 * - **到期卻沒安排的伏筆**（復跑之後，`unplannedDue`）：這幾章裡該埋、該收的伏筆，計劃裡既沒安排、也沒寫推遲的，列在卡片
 *   與日誌裡（批次拆細綱沒有卡片，完成提示說一句「見日誌」）。不調模型，也不攔人。
 *
 * 零呼叫：計劃是細綱合同裡順帶的一個欄位（設計稿「呼叫次數」：+0）。
 */
import { scoped } from '../runtime/logger';
import { NovelProject } from '../model/project';
import { CreationTarget, plotOfTarget } from '../model/pipeline';
import { parsePlotFileName } from '../model/plotFile';
import {
  Foreshadowing,
  PlanEntry,
  PlannedChapter,
  ThreadEvent,
  UNFILED_NAME,
  UNFILED_TEMPLATE,
  appendForeshadowing,
  describeUnplannedDue,
  isForeshadowEvent,
  replacePlannedEvents,
  resolvePlanEvents,
  threadKey,
  unplannedDue,
} from '../model/threadFile';
import { Workspace } from '../workspace';
import type { Artifact } from './artifact';

const log = scoped('叙事线');

/** 一章要寫進去的計劃（細綱合同裡那一章的 `threads`）。 */
export interface ChapterPlan {
  no: number;
  entries: readonly PlanEntry[];
}

/** {@link writePlannedThreads} 的結果。 */
export interface PlanWriteOutcome {
  /** 寫進去的計劃事件。 */
  written: number;
  /** 換掉的舊計劃事件。 */
  removed: number;
  /** 新登記的伏筆。 */
  newForeshadowing: string[];
  /** 沒寫進去的（解碼時就沒收的、認不出是哪條線的、線的檔案這幾秒裡沒了的）。 */
  dropped: string[];
  /** 這幾章裡到期、卻沒安排的伏筆（復跑之後的程式檢查，`unplannedDue`；不攔，只說出來）。 */
  unplanned: string[];
}

/** 落在哪條線上的鍵（缺席是「未歸屬的伏筆」，鍵是空串）。 */
const lineKey = (line: string | undefined): string => (line ? threadKey(line) : '');

/**
 * 把這幾章的計劃寫進各條線：每一章整組換掉、新伏筆登記線上下。`notes` 是解碼時就沒收的那幾條（一併記進結果與日誌）。
 * 不彈框、不拋（寫盤失敗照常拋給呼叫方——細綱已經寫進去了，由呼叫方說一句）。
 */
export async function writePlannedThreads(
  project: NovelProject,
  chapters: readonly ChapterPlan[],
  notes: readonly string[] = []
): Promise<PlanWriteOutcome> {
  const out: PlanWriteOutcome = { written: 0, removed: 0, newForeshadowing: [], dropped: [...notes], unplanned: [] };
  if (chapters.length > 0) {
    const book = await project.readThreads();
    const planned = resolvePlanEvents(book, chapters);
    out.dropped.push(...droppedOf(planned));
    out.unplanned = unplannedDue(book, chapters).map(describeUnplannedDue);
    const ws = new Workspace(project);
    const files: { rel: string; line?: string }[] = [
      ...book.threads.map((t) => ({ rel: t.relPath, line: t.name })),
      { rel: book.unfiled.relPath },
    ];
    for (const f of files) {
      const key = lineKey(f.line);
      const mine = (c: PlannedChapter): ThreadEvent[] => c.events.filter((e) => lineKey(e.line) === key).map((e) => e.event);
      const fores: Foreshadowing[] = planned.flatMap((c) =>
        c.newForeshadowing.filter((x) => lineKey(x.line) === key).map((x) => x.foreshadowing)
      );
      const fresh = planned.reduce((n, c) => n + mine(c).length, 0);
      let gone = false;
      let written = 0;
      let removed = 0;
      let added: Foreshadowing[] = [];
      await ws.updateThread(f.rel, (raw) => {
        const exists = !!raw.trim();
        if (!exists && (f.line || (fresh === 0 && fores.length === 0))) {
          // 線的檔案這幾秒裡沒了；「未歸屬的伏筆」沒有、也沒有要寫的，就不建。
          gone = !!f.line && fresh + fores.length > 0;
          return undefined;
        }
        // 先登記伏筆再寫事件：事件裡出現過的名字會被當成已經有了（appendForeshadowing 的去重口徑）。
        const withFore = appendForeshadowing(exists ? raw : UNFILED_TEMPLATE, fores);
        added = withFore.added;
        let text = withFore.text;
        for (const c of planned) {
          const events = mine(c).map(({ type, foreshadowing, what }) => ({ type, ...(foreshadowing ? { foreshadowing } : {}), what }));
          const r = replacePlannedEvents(text, c.no, events);
          text = r.text;
          removed += r.removed;
          written += events.length;
        }
        return text;
      });
      if (gone) {
        out.dropped.push(`${f.line} 上的 ${fresh + fores.length} 條（這條線的檔案找不到了，改了名或刪了）`);
      }
      out.written += written;
      out.removed += removed;
      out.newForeshadowing.push(...added.map((x) => x.name));
    }
  }
  const where = chapters.length === 1 ? `第 ${chapters[0].no} 章` : `${chapters.length} 章`;
  if (out.written + out.removed + out.newForeshadowing.length > 0) {
    log.info(
      `${where}的敘事線計劃已寫進各條線`,
      `寫進 ${out.written} 條，換掉原來的 ${out.removed} 條${out.newForeshadowing.length > 0 ? `，新伏筆 ${out.newForeshadowing.join('、')}` : ''}`
    );
  }
  if (out.dropped.length > 0) {
    log.warn(`${where}的敘事線計劃有 ${out.dropped.length} 條沒寫進去`, out.dropped.join('\n'));
  }
  if (out.unplanned.length > 0) {
    log.warn(`${where}裡到期的伏筆有 ${out.unplanned.length} 條沒安排（既沒埋 / 收，也沒寫推遲）`, out.unplanned.join('\n'));
  }
  return out;
}

/** 寫入之後 toast 裡那半句：「，敘事線記下 5 條計劃（換掉原來的 2 條），新伏筆：玉佩的來歷；1 條沒寫進敘事線（見日誌）」。 */
export function describePlanWrite(o: PlanWriteOutcome): string {
  const parts = [
    o.written > 0 || o.removed > 0 ? `敘事線記下 ${o.written} 條計劃${o.removed > 0 ? `（換掉原來的 ${o.removed} 條）` : ''}` : '',
    o.newForeshadowing.length > 0 ? `新伏筆：${o.newForeshadowing.join('、')}` : '',
    o.dropped.length > 0 ? `${o.dropped.length} 條計劃沒寫進敘事線（見日誌）` : '',
    o.unplanned.length > 0 ? `${o.unplanned.length} 條到期的伏筆沒安排（見日誌）` : '',
  ].filter(Boolean);
  return parts.length > 0 ? `，${parts.join('，')}` : '';
}

/** 沒寫進去的那幾條：`第 13 章 某線 推進（認不出是哪一條線）`。 */
function droppedOf(planned: readonly PlannedChapter[]): string[] {
  return planned.flatMap((c) => c.dropped.map((d) => `第 ${c.no} 章 ${d.what}（${d.why}）`));
}

/**
 * 產物裡要寫進敘事線的計劃：細綱批次是各章的 `threads`，單章細綱（生成、落定）是它那一份（章號按落點認，同
 * generation/accept.ts 的 `acceptPlot`）。合同裡沒寫 `threads` 的章不算。別的產物沒有。
 */
export async function planOfArtifact(
  project: NovelProject,
  target: CreationTarget,
  artifact: Artifact
): Promise<{ chapters: ChapterPlan[]; notes: string[] } | undefined> {
  if (artifact.kind === 'plotBatch') {
    const chapters = artifact.items.flatMap((b) => (b.threads ? [{ no: b.no, entries: b.threads }] : []));
    return chapters.length > 0 ? { chapters, notes: [] } : undefined;
  }
  if (artifact.kind !== 'plot' || !artifact.threads) {
    return undefined;
  }
  const rel = plotOfTarget(target);
  const no = rel ? ((await project.resolvePlot(rel))?.no ?? parsePlotFileName(rel.split('/').pop() ?? '')?.no) : undefined;
  return no ? { chapters: [{ no, entries: artifact.threads }], notes: artifact.planNotes ?? [] } : undefined;
}

/**
 * 寫入卡片上的那幾行（第 19 條的例外：先列出來）。照此刻磁碟上的敘事線認一遍（與寫入時同一個 `resolvePlanEvents`）：
 *
 * ```
 * 敘事線計劃：林昭與沈青 推進；埋〈玉佩的來歷〉（新伏筆，掛在「林昭與沈青」）（原來的 2 條整組換掉）
 * 沒寫進敘事線的：第 3 章 某線 推進（認不出是哪一條線）
 * 到期卻沒安排的伏筆：〈舊傷〉（第 5 章前收）——這一批既沒安排、也沒寫推遲（照寫不攔，寫前檢查還會提醒）
 * ```
 *
 * 一批幾章時一章一行。合同裡沒寫 `threads` 的產物沒有這幾行。最後一行是復跑之後加的程式檢查（`unplannedDue`，不調模型、
 * 不攔人）：模型只排「推進」、到期該埋該收的伏筆沒安排，作者在卡片上看得見，可以先改細綱再寫入。
 */
export async function describeThreadPlan(project: NovelProject, target: CreationTarget, artifact: Artifact): Promise<string[]> {
  const plan = await planOfArtifact(project, target, artifact);
  if (!plan) {
    return [];
  }
  const book = await project.readThreads();
  const planned = resolvePlanEvents(book, plan.chapters);
  const single = planned.length === 1;
  const rows = planned
    .filter((c) => c.events.length > 0 || c.replaced > 0)
    .map((c) => {
      const body =
        c.events.length > 0
          ? `${chapterPlanText(c)}${c.replaced > 0 ? `（原來的 ${c.replaced} 條整組換掉）` : ''}`
          : `沒有計劃（原來的 ${c.replaced} 條刪掉）`;
      return single ? body : `第 ${c.no} 章：${body}`;
    });
  const dropped = [...plan.notes, ...droppedOf(planned)];
  const unplanned = unplannedDue(book, plan.chapters).map(describeUnplannedDue);
  return [
    ...(rows.length > 0 ? [single ? `敘事線計劃：${rows[0]}` : `敘事線計劃：\n${rows.join('\n')}`] : []),
    ...(dropped.length > 0 ? [`沒寫進敘事線的：${dropped.join('；')}`] : []),
    ...(unplanned.length > 0
      ? [`到期卻沒安排的伏筆：${unplanned.join('、')}——${single ? '本章' : '這一批'}既沒安排、也沒寫推遲（照寫不攔，寫前檢查還會提醒）`]
      : []),
  ];
}

/** 一章的計劃：`林昭與沈青 推進、關係；埋〈玉佩的來歷〉（新伏筆，掛在「林昭與沈青」）；收〈舊傷〉`。 */
function chapterPlanText(c: PlannedChapter): string {
  const byLine = new Map<string, { line: string; types: string[] }>();
  const fores: string[] = [];
  const fresh = new Map(c.newForeshadowing.map((x) => [threadKey(x.foreshadowing.name), x.line]));
  for (const { line, event } of c.events) {
    if (isForeshadowEvent(event.type)) {
      const key = threadKey(event.foreshadowing ?? '');
      const note = fresh.has(key) ? `（新伏筆，${fresh.get(key) ? `掛在「${fresh.get(key)}」` : `進「${UNFILED_NAME}」`}）` : '';
      fores.push(`${traditionalLabel(event.type)}〈${event.foreshadowing}〉${note}`);
      continue;
    }
    const entry = byLine.get(lineKey(line)) ?? { line: line ?? UNFILED_NAME, types: [] };
    if (!entry.types.includes(event.type)) {
      entry.types.push(event.type);
    }
    byLine.set(lineKey(line), entry);
  }
  return [...[...byLine.values()].map((x) => `${x.line} ${x.types.map(traditionalLabel).join('、')}`), ...fores].join('；');
}
