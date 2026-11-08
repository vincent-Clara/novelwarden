/**
 * 重寫情節大綱（工程頁「情節大綱」右鍵「重寫…」）：**按 {@link OUTLINE_BATCH} 章一段一段重寫**，
 * 不是一次把全書塞給模型——一次寫一百章，後半段會稀得像目錄（D20）。
 *
 * **只重寫還沒寫正文的章**：情節大綱是各章細綱「梗概」的彙總，寫過的章那一條由定稿照正文寫（就是實際寫成的樣子），
 * 不再讓模型照正文另整理一份（docs/design/plans/2026-10-22-outline-from-plots.md）。從前已寫的那一截照定稿過的細綱
 * 整理（`derive`），刪了。
 *
 * 作者寫的那句要求每一段都帶。每一段看得見前面幾段**剛寫好的新版**（`BuildRequest.outlineDraft`），
 * 區間之外還沒輪到的條目仍是舊版。全部寫完拼成一整份，**一次**審閱、一次寫入（第 3 條；寫入時按章號拆回各章細綱）；
 * 中途失敗時已經重寫的幾段照樣拿去審閱，沒輪到的條目保留舊版——花過的錢不白扔，寫不寫由作者定。
 * 取消就什麼都不寫。
 */
import { readConfig } from '../config';
import { getHost } from '../host';
import { CancelledError } from '../llm/provider';
import { createModelPool } from '../llm/pool';
import { NovelProject } from '../model/project';
import { mergeOutline, outlineCoverage } from '../model/outlineFile';
import { OUTLINE_BATCH } from '../model/pipeline';
import { describeTaskModels } from '../model/tiers';
import { describeError, scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { BuildRequest } from '../context/builder';
import { ChainError, singleShotNotes } from '../generation/structured';
import { acceptArtifact } from '../generation/accept';
import { nextWritableChapterNo } from '../views/pipeline';
import { isArtifactEmpty, parseArtifact } from './artifact';
import { poolIO } from './poolIO';

const log = scoped('重寫大綱');

export interface OutlineRewriteBatch {
  from: number;
  to: number;
}

export interface OutlineRewritePlan {
  /** 大綱現在覆蓋到第幾章：重寫到這裡。 */
  end: number;
  /** 從第 1 章起連續有正文寫到第幾章（0 = 一章都沒寫）：這一截不重寫。 */
  through: number;
  /** 空的 = 大綱排到的章都寫過了，沒有可重寫的。 */
  batches: OutlineRewriteBatch[];
}

/** 分段：還沒寫正文的那一截（第 through+1 章到第 end 章）按 {@link OUTLINE_BATCH} 章切。純函式。 */
export function planOutlineRewrite(end: number, through: number): OutlineRewritePlan {
  const batches: OutlineRewriteBatch[] = [];
  const cut = Math.min(Math.max(through, 0), end);
  for (let from = cut + 1; from <= end; from += OUTLINE_BATCH) {
    batches.push({ from, to: Math.min(end, from + OUTLINE_BATCH - 1) });
  }
  return { end, through: cut, batches };
}

/**
 * 大綱能不能分段重寫：要有條目、能說出覆蓋到第幾章。還沒有大綱（那是「生成」，主按鈕管）返回 undefined，
 * 呼叫方退回整篇一次生成。排到的章都寫過了，`batches` 是空的（呼叫方說一聲，不調模型）。
 */
export async function outlineRewritePlan(project: NovelProject): Promise<OutlineRewritePlan | undefined> {
  const end = outlineCoverage(await project.readOutline());
  if (!(end > 0)) {
    return undefined;
  }
  return planOutlineRewrite(end, nextWritableChapterNo(await project.listChapters()) - 1);
}

/** 問要求那一框裡的說明：分幾段、調幾次（第 4 條：動手之前寫明次數）。 */
export function describeOutlineRewrite(plan: OutlineRewritePlan): string {
  const from = plan.batches[0]?.from ?? plan.through + 1;
  const kept = plan.through > 0 ? `${span(1, plan.through)}已經寫了正文，那幾條是同步時照正文寫的，不動。` : '';
  return (
    `按 ${OUTLINE_BATCH} 章一段重寫${span(from, plan.end)}，呼叫 ${plan.batches.length} 次模型。${kept}` +
    '這句要求每一段都帶；留空就照上游重來一遍。全部寫完後先讓你對比再寫入。'
  );
}

/** 跑一遍。返回實際調了幾次模型。 */
export async function rewriteOutline(project: NovelProject, plan: OutlineRewritePlan, ask: string): Promise<number> {
  const config = readConfig();
  const pool = await createModelPool({ task: 'plotOutline', concurrent: false });
  if (!pool) {
    log.error('沒有可用的模型，重寫情節大綱中止');
    return 0;
  }
  log.info(`重寫情節大綱${span(plan.batches[0]?.from ?? 1, plan.end)}，${plan.batches.length} 段`, describeTaskModels(config, 'plotOutline'));
  let calls = 0;
  await runTask(
    '重寫情節大綱',
    async ({ signal, report }) => {
      let draft = await project.readOutline();
      let done = 0;
      let halt: string | undefined;
      for (const batch of plan.batches) {
        const range = { from: batch.from, to: batch.to };
        const label = `情節大綱（${span(batch.from, batch.to)}）`;
        report({ message: span(batch.from, batch.to), current: done, total: plan.batches.length });
        const request: Omit<BuildRequest, 'providerMaxInputTokens'> = {
          action: { stage: 'outline', capability: 'generate' },
          target: { kind: 'outline' },
          range,
          ask,
          outlineDraft: draft,
          outlineRewriteFrom: plan.batches[0].from,
        };
        const io = poolIO(project, pool, config, signal, request);
        try {
          const first = await io.chain.call(await io.chain.build({}), label);
          const notes = singleShotNotes('outline', first.text, first.stop, range);
          if (notes.length > 0) {
            log.warn(`${label}：${notes.length} 條說明`, notes.join('\n'));
          }
          const artifact = parseArtifact(request.action, first.text, request.target, range);
          if (artifact.kind !== 'outlineDoc' || isArtifactEmpty(artifact)) {
            throw new Error('模型返回的大綱是空的');
          }
          const reached = outlineCoverage(artifact.text);
          if (reached < batch.to) {
            throw new Error(`這一段只寫到第 ${reached} 章（要到第 ${batch.to} 章）`);
          }
          draft = mergeOutline(draft, artifact.text, range);
          calls += io.calls();
          done++;
        } catch (err) {
          calls += err instanceof ChainError ? err.calls : io.calls();
          if (err instanceof CancelledError || signal.aborted) {
            log.warn(`重寫情節大綱被取消，${done}/${plan.batches.length} 段已寫好，沒有寫入`);
            return;
          }
          halt = `${label}沒寫成（${describeError(err)}）`;
          log.error(`重寫情節大綱：${halt}`, err instanceof ChainError ? err.notes.join('\n') : err);
          break;
        }
      }
      report({ message: '對比', current: done, total: plan.batches.length });
      if (done === 0) {
        getHost().toast(`${halt}，大綱沒有改動。`, 'error');
        return;
      }
      const rewritten = span(plan.batches[0].from, plan.batches[done - 1].to);
      const r = await acceptArtifact(project, { kind: 'outline' }, { kind: 'outlineDoc', text: draft });
      if (r.skipped) {
        getHost().toast(`重寫的大綱沒有寫入（呼叫 ${calls} 次）。`);
        return;
      }
      if (halt) {
        getHost().toast(`已重寫${rewritten}的大綱，後面的保留舊版。${halt}。`, 'error');
        return;
      }
      getHost().toast(`情節大綱${span(plan.batches[0].from, plan.end)}已重寫（呼叫 ${calls} 次）。`);
    },
    { scope: '重寫大綱' }
  );
  return calls;
}

function span(from: number, to: number): string {
  return from === to ? `第 ${from} 章` : `第 ${from}–${to} 章`;
}
