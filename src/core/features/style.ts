import { getHost } from '../host';
import { collect } from '../llm/collect';
import { StreamOptions } from '../llm/provider';
import { createModelPool } from '../llm/pool';
import { readConfig } from '../config';
import { contextLimitsOf } from '../model/contextDetail';
import { elapsed, scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { NovelProject } from '../model/project';
import { estimateTokens, takeHead } from '../context/tokenizer';
import { Workspace } from '../workspace';
import { pickPlotsByInput } from './pickPlots';
import { INCOMPLETE_RETRIES, STYLE_SYSTEM, collectComplete } from './stylePrompt';
import { describeCalls } from '../model/pipeline';
import { withCallChoice } from '../runtime/callScope';
import { askCall } from './askCall';

const log = scoped('文风');

/**
 * 從樣章提取文風指南，寫入 .novelwarden/style.md。
 * 挑完樣章先彈確認框報次數、挑模型；要覆蓋時那顆按鈕是「覆蓋」——style.md 常被作者手工調過。
 */
export async function extractStyle(project: NovelProject): Promise<void> {
  // 樣章取自**釋出章節**：文風是從成稿裡看出來的，而成稿在 chapters/。
  // 老工程（只有 chapters/、從沒用過本工具）因此天然可用。
  const written = (await project.listChapters()).filter((c) => c.wordCount > 0);
  if (written.length === 0) {
    log.warn('還沒有寫過正文，無法提取文風');
    getHost().toast('還沒有寫過正文，無法提取文風。');
    return;
  }

  // 預設勾前幾章當樣章（上下文詳細度，預設前兩章），使用者可改成寫得最順手的那幾章。
  const picked = await pickPlotsByInput(
    written.map((c) => ({ no: c.order, title: c.title, chapter: c })),
    '選取 1~3 章最能代表文風的樣章',
    '輸入章號，逗號分隔，如 1,2,3',
    written.slice(0, Math.min(3, contextLimitsOf(readConfig()).styleSamples)).map((c) => c.order)
  );
  if (!picked || picked.length === 0) {
    log.info('使用者取消了樣章選擇');
    return;
  }
  if (picked.length > 3) {
    log.warn(`選了 ${picked.length} 章，只取前 3 章`);
    getHost().toast('最多選 3 章，只取前 3 章。');
  }

  const samples = picked.slice(0, 3);
  const existing = await project.readStyleGuide();
  // 已有作者調過的文風指南時那顆按鈕是「覆蓋」，說清會蓋掉什麼。
  const overwrite = !!existing.trim() && !isTemplate(existing);
  const button = overwrite ? '覆蓋' : '開始提取';
  const answer = await askCall({
    message:
      `提取文風：讀第 ${samples.map((p) => p.no).join('、')} 章正文，歸納成文風指南寫進 style.md，` +
      `${describeCalls({ low: 1, high: 1, max: 1 + INCOMPLETE_RETRIES, why: `回答不完整時重問，最多再 ${INCOMPLETE_RETRIES} 次` })}。`,
    actions: [button],
    ...(overwrite ? { detail: '已存在文風指南，重新提取會覆蓋當前內容（可用 Git 或撤銷恢復）。' } : {}),
    tasks: ['extractStyle'],
    // 帶哪幾章上一步已經選定了，詳細度管不著這一次。
    contextDetail: false,
  });
  if (answer?.action !== button) {
    log.info(overwrite ? '使用者拒絕覆蓋已有文風指南' : '使用者取消了提取文風');
    return;
  }
  if (overwrite) {
    log.warn('使用者確認覆蓋已有文風指南', `原內容 ${existing.length} 字`);
  }

  return withCallChoice(answer.choice, async () => {
    const config = readConfig();
    // 只有一次呼叫，談不上併發；走池是為了拿到「首選失敗就換模型」。
    const pool = await createModelPool({ task: 'extractStyle', concurrent: false });
    if (!pool) {
      log.error('沒有可用的模型，提取中止');
      return;
    }
    log.info(
      `準備從 ${samples.length} 章樣章提取文風`,
      `章節 ${samples.map((p) => p.no).join('、')}｜模型 ${pool.label}`
    );

    await runTask(
      '提取文風指南',
      async ({ signal, report }) => {
        const startedAt = Date.now();
        report({ message: '讀取樣章', current: 0, total: 2 });
        const parts: string[] = [];
        for (const sample of samples) {
          parts.push(
            `【樣章：第${sample.no}章 ${sample.title}】\n${await project.readChapterText(sample.chapter)}`
          );
        }
        const joined = parts.join('\n\n');
        const budget = Math.max(
          3000,
          pool.primaryBudget.contextWindow - pool.primaryBudget.maxOutputTokens - 2000
        );
        const corpus = takeHead(joined, budget);
        if (corpus.length < joined.length) {
          log.warn(
            '樣章正文超出輸入預算，已截斷',
            `${joined.length} 字 → ${corpus.length} 字（預算 ${budget} token）。少選一章可讓歸納更完整。`
          );
        }
        log.debug('樣章已讀取', `${corpus.length} 字（約 ${estimateTokens(corpus)} token）`);

        report({ message: '分析文風特徵', current: 1, total: 2 });
        const options: StreamOptions = {
          maxOutputTokens: pool.primaryBudget.maxOutputTokens,
          temperature: 0.3,
          timeoutMs: config.requestTimeoutMs,
          signal,
        };
        const modelStart = Date.now();
        const raw = await pool.run('提取文風', (llm) =>
          collectComplete(
            STYLE_SYSTEM,
            () =>
              collect(
                llm.stream(
                  [
                    { role: 'system', content: STYLE_SYSTEM },
                    { role: 'user', content: corpus },
                  ],
                  options
                )
              ),
            {
              maxOut: options.maxOutputTokens,
              signal,
              onRetry: (attempt, reason) => log.warn(`回答不完整，重問（第 ${attempt}/${INCOMPLETE_RETRIES} 次）`, reason),
            }
          )
        );
        log.info('模型已返回', `${raw.length} 字，用時 ${elapsed(modelStart)}`);
        if (signal.aborted) {
          log.warn('提取被取消，未寫盤');
          return;
        }

        const relPath = await new Workspace(project).writeStyleGuide(raw);
        report({ message: '完成', current: 2, total: 2 });
        log.info('文風指南已寫入', `${relPath}｜總耗時 ${elapsed(startedAt)}`);
        getHost().toast('文風指南已生成，建議人工過一遍再用。');
        await getHost().openFile(project.relPath(project.stylePath));
      },
      { scope: '文风' }
    );
  });
}

function isTemplate(text: string): boolean {
  return text.includes('這份檔案會在每次續寫時注入 LLM');
}
