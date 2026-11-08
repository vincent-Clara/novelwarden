/**
 * 從參考書學寫法（拆書 B）：放一本別人的書進工程，**只學怎麼寫**——
 *
 * - 文風 → `.novelwarden/style.md`（與「從正文提取文風」同一份提示詞，開頭那段換成「這是參考書」）；
 * - 結構與節奏 → 一份「規劃」階段的寫作技能 `.novelwarden/skills/<書名>-写法/SKILL.md`，寫完問綁不綁。
 *
 * 借鑑 AI-Novel-Writer 的「拆解文風與仿寫指南」（`analyze-style.command.ts`：5 章樣本、每章前 2000 字、
 * 3–6 條建議整段寫進 `writingStyle`）。**不借**它的另外兩步：原文進向量庫、反推原書的設定與藍圖後
 * 從第 1 章同人名同情節重寫（作者拍板：只學寫法；換皮重寫以後另說）。所以這裡原文一個字都不寫進工程，
 * 兩次呼叫的提示詞都帶「不復述情節、人名、地名」的任務邊界。
 *
 * 各 1 次呼叫，走「提取文風」那一檔（`extractStyle`），不帶思考深度（第 26 條）。
 */
import { readConfig } from '../config';
import { contextLimitsOf } from '../model/contextDetail';
import { getHost } from '../host';
import { collect } from '../llm/collect';
import { createModelPool } from '../llm/pool';
import { NovelProject } from '../model/project';
import {
  ENCODING_LABEL,
  SplitChapter,
  describeShape,
  evenSample,
  headOf,
  headTail,
  referenceSkillName,
  renderReferenceSkill,
  shapeStats,
  splitBySize,
  splitChapters,
  structureSample,
} from '../model/importText';
import { CallEstimate, describeCalls } from '../model/pipeline';
import { withCallChoice } from '../runtime/callScope';
import { askCall } from './askCall';
import { SKILL_STAGE_LABEL, describeIncompat, skillId, skillLabel } from '../model/writingSkill';
import { describeError, elapsed, scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { listSkills, loadSkill, readSkillBindings, saveSkillBinding } from '../skills';
import { estimateTokens, takeHead } from '../context/tokenizer';
import { Workspace } from '../workspace';
import { formatWordCount, pickBookText, readBookText } from './bookText';
import { INCOMPLETE_RETRIES, REFERENCE_SKILL_SYSTEM, REFERENCE_STYLE_SYSTEM, collectComplete } from './stylePrompt';

const log = scoped('學寫法');

export type ReferenceLearn = 'both' | 'style' | 'skill';

/** 文風每章看多少。看幾章按上下文詳細度（`referenceSamples`，預設 5 章）。 */
export const STYLE_HEAD = 2500;
/** 寫法看的那幾章：開頭與結尾各看多少（章末鉤子在結尾）。 */
export const SKILL_HEAD = 2500;
export const SKILL_TAIL = 800;

const LEARN_LABEL: Record<ReferenceLearn, string> = {
  both: '文風與寫法',
  style: '文風',
  skill: '寫法',
};

export interface ReferenceOutcome {
  calls: number;
  /** 寫好的文風指南、寫法技能（沒寫成就缺席）。 */
  style?: string;
  skill?: { id: string; relPath: string; bound: boolean };
}

export async function learnFromReference(
  project: NovelProject,
  opts: { path?: string; what?: ReferenceLearn } = {}
): Promise<ReferenceOutcome> {
  const where = await pickBookText(project, '從參考書學寫法：選一本 txt', opts.path);
  if (!where) {
    return { calls: 0 };
  }
  let book;
  try {
    book = await readBookText(project, where);
  } catch (err) {
    getHost().toast(describeError(err), 'error');
    return { calls: 0 };
  }
  let chapters: SplitChapter[] = splitChapters(book.text).chapters;
  const bySize = chapters.length === 0;
  if (bySize) {
    chapters = splitBySize(book.text);
  }
  if (chapters.length === 0) {
    getHost().toast(`《${book.title}》裡沒有正文。`, 'error');
    return { calls: 0 };
  }

  const what =
    opts.what ??
    (await getHost().pick<ReferenceLearn>(
      [
        { label: '兩樣都學', description: '文風寫進 style.md，結構與節奏寫成一份「規劃」階段的寫作技能', value: 'both' },
        { label: '只學文風', description: '視角、句式、遣詞、對白、描寫、修辭，寫進 style.md', value: 'style' },
        { label: '只學寫法', description: '章節結構、場景推進、鉤子、節奏與爽點，寫成「規劃」階段的寫作技能', value: 'skill' },
      ],
      `從《${book.title}》學什麼？`
    ));
  if (!what) {
    return { calls: 0 };
  }
  const doStyle = what !== 'skill';
  const doSkill = what !== 'style';
  // 抽哪幾章在確認框之前就定了（框裡寫著），所以那一問不給詳細度下拉框。
  const styleIdx = evenSample(chapters.length, contextLimitsOf(readConfig()).referenceSamples);
  const skillIdx = structureSample(chapters.length);
  const styleTouched = doStyle && !(await project.styleGuideUntouched());
  const taken = new Set((await listSkills(project)).filter((s) => s.source === 'project').map((s) => s.name));
  const skillName = referenceSkillName(book.title, taken);
  const skillRel = `${project.relPath(project.skillsDir)}/${skillName}/SKILL.md`;
  const n = (doStyle ? 1 : 0) + (doSkill ? 1 : 0);
  const estimate: CallEstimate = { low: n, high: n, max: n };
  const unit = bySize ? '段' : '章';
  const nos = (idx: number[]) => idx.map((i) => i + 1).join('、');

  const button = styleTouched ? '覆蓋 style.md 並開始' : '開始學';
  const answer = await askCall({
    message: `從《${book.title}》學${LEARN_LABEL[what]}，${describeCalls(estimate)}。現在開始？`,
    actions: [button],
    detail: [
      `檔案：${book.shown}（${ENCODING_LABEL[book.encoding]}）；${bySize ? `認不出章節標題，按約 3000 字一段切成 ${chapters.length} 段` : `認出 ${chapters.length} 章`}，共 ${formatWordCount(chapters.reduce((s, c) => s + c.words, 0))}。`,
      doStyle
        ? `文風：看第 ${nos(styleIdx)} ${unit}（首尾與中間均勻抽），各取開頭 ${STYLE_HEAD} 字，歸納成文風指南寫進 ${project.relPath(project.stylePath)}` +
          (styleTouched ? '——它已經有內容，會被覆蓋（可用 Git 或撤銷恢復）。' : '。')
        : '',
      doSkill
        ? `寫法：看第 ${nos(skillIdx)} ${unit}（開篇與全書 30% 處的連續幾${unit}），各取開頭 ${SKILL_HEAD} 字與結尾 ${SKILL_TAIL} 字，加上全書的篇幅統計，寫成寫作技能 ${skillRel}；寫完問你要不要綁到「${SKILL_STAGE_LABEL.planning}」階段。`
        : '',
      '只學怎麼寫：不復述它的情節、人名、地名與設定，原文不寫進工程的任何檔案。',
    ]
      .filter(Boolean)
      .join('\n'),
    tasks: ['extractStyle'],
    contextDetail: false,
  });
  if (answer?.action !== button) {
    log.info('作者取消了從參考書學寫法');
    return { calls: 0 };
  }
  return withCallChoice(answer.choice, async () => {
    const config = readConfig();
    const pool = await createModelPool({ task: 'extractStyle', concurrent: false });
    if (!pool) {
      log.error('沒有可用的模型，從參考書學寫法中止');
      return { calls: 0 };
    }

    const outcome: ReferenceOutcome = { calls: 0 };
    const failures: string[] = [];
    const budget = Math.max(3000, pool.primaryBudget.contextWindow - pool.primaryBudget.maxOutputTokens - 2000);
    const maxOut = pool.primaryBudget.maxOutputTokens;
    const ask = async (system: string, user: string, label: string, signal: AbortSignal): Promise<string> => {
      const corpus = takeHead(user, budget);
      if (corpus.length < user.length) {
        log.warn(`${label}的樣章超出輸入預算，已截斷`, `${user.length} 字 → ${corpus.length} 字（預算 ${budget} token）`);
      }
      log.debug(`${label}：樣章已備好`, `${corpus.length} 字（約 ${estimateTokens(corpus)} token）`);
      outcome.calls++;
      return pool.run(label, (llm) =>
        collectComplete(
          system,
          () =>
            collect(
              llm.stream(
                [
                  { role: 'system', content: system },
                  { role: 'user', content: corpus },
                ],
                { maxOutputTokens: maxOut, temperature: 0.3, timeoutMs: config.requestTimeoutMs, signal }
              )
            ),
          {
            maxOut,
            signal,
            onRetry: (attempt, reason) => {
              outcome.calls++;
              log.warn(`${label}：回答不完整，重問（第 ${attempt}/${INCOMPLETE_RETRIES} 次）`, reason);
            },
          }
        )
      );
    };

    const ws = new Workspace(project);
    await runTask(
      '從參考書學寫法',
      async ({ signal, report }) => {
        const startedAt = Date.now();
        let step = 0;
        if (doStyle) {
          report({ message: '學文風', current: step, total: n });
          try {
            const samples = styleIdx.map((i) => `【樣章：第 ${i + 1} ${unit}】\n${headOf(chapters[i].body, STYLE_HEAD)}`).join('\n\n');
            const text = await ask(REFERENCE_STYLE_SYSTEM, `以下是參考書的樣章。\n\n${samples}`, '學文風', signal);
            if (signal.aborted) {
              return;
            }
            if (!text) {
              throw new Error('模型返回的文風指南是空的');
            }
            outcome.style = await ws.writeStyleGuide(text);
            log.info('參考書的文風已寫進文風指南', outcome.style);
          } catch (err) {
            if (signal.aborted) {
              return;
            }
            failures.push(`文風沒學成（${describeError(err)}）`);
            log.error(`從《${book.title}》學文風失敗`, err);
          }
          step++;
        }
        if (doSkill) {
          report({ message: '學寫法', current: step, total: n });
          try {
            const samples = skillIdx
              .map((i) => `【樣章：第 ${i + 1} ${unit}｜${chapters[i].words} 字】\n${headTail(chapters[i].body, SKILL_HEAD, SKILL_TAIL)}`)
              .join('\n\n');
            const user = `# 參考書的篇幅統計（程式數的）\n\n${describeShape(shapeStats(chapters))}\n\n# 樣章\n\n${samples}`;
            const body = await ask(REFERENCE_SKILL_SYSTEM, user, '學寫法', signal);
            if (signal.aborted) {
              return;
            }
            if (!body) {
              throw new Error('模型返回的寫法是空的');
            }
            const raw = renderReferenceSkill({ name: skillName, bookTitle: book.title, body });
            await ws.write(skillRel, { text: raw }, { mode: 'create' });
            outcome.skill = { id: skillId('project', skillName), relPath: skillRel, bound: false };
            log.info(`參考書的寫法已寫成技能「${skillName}」`, skillRel);
          } catch (err) {
            if (signal.aborted) {
              return;
            }
            failures.push(`寫法沒學成（${describeError(err)}）`);
            log.error(`從《${book.title}》學寫法失敗`, err);
          }
        }
        report({ message: '收尾', current: n, total: n });
        log.info(`從《${book.title}》學寫法結束`, `呼叫 ${outcome.calls} 次，用時 ${elapsed(startedAt)}`);
      },
      { scope: '學寫法' }
    );

    const made = [outcome.style ? `文風寫進了 ${outcome.style}` : '', outcome.skill ? `寫法寫成了 ${outcome.skill.relPath}` : ''].filter(Boolean);
    if (failures.length > 0) {
      getHost().toast([...made, ...failures].join('；') + '。', 'error');
    } else if (made.length > 0 && !outcome.skill) {
      getHost().toast(`${made.join('；')}。建議人工過一遍再用。`);
    }
    if (outcome.skill) {
      outcome.skill.bound = await offerBinding(project, ws, outcome.skill.id, made);
    }
    if (outcome.style && !outcome.skill) {
      await getHost().openFile(project.relPath(project.stylePath));
    }
    return outcome;
  });
}

/** 寫好的寫法技能：問一句綁不綁到「規劃」階段；那個階段已經綁了別的就寫明會換掉。 */
async function offerBinding(project: NovelProject, ws: Workspace, id: string, made: string[]): Promise<boolean> {
  const skill = await loadSkill(id, project);
  if (!skill) {
    return false;
  }
  if (!skill.inspection.compatible) {
    getHost().toast(
      `${made.join('；')}。但它現在不相容（${describeIncompat(skill.inspection.reasons, skill.inspection.unresolved)}），綁不上——開啟改掉那幾處再到設定頁「技能」裡綁。`,
      'error'
    );
    return false;
  }
  const { bindings } = await readSkillBindings(project);
  const current = bindings.planning;
  const replacing = current && current !== id ? await loadSkill(current, project) : undefined;
  const label = skillLabel(skill.inspection);
  const pick = await getHost().confirm(
    `${made.join('；')}。把「${label}」綁到「${SKILL_STAGE_LABEL.planning}」階段嗎？`,
    ['綁到規劃'],
    {
      detail: [
        '綁上之後，本工程架構、情節大綱與細綱的每一次生成都會把它放在提示詞最前面（對話頁、agent、工程頁批次都帶）。',
        current ? `「${SKILL_STAGE_LABEL.planning}」現在綁的是「${replacing ? skillLabel(replacing.inspection) : current}」，會被換掉。` : '',
        '不綁也可以：以後在設定頁「技能」裡綁。建議先開啟看一遍。',
      ]
        .filter(Boolean)
        .join('\n'),
    }
  );
  if (pick !== '綁到規劃') {
    if (skill.relPath) {
      await getHost().openFile(skill.relPath);
    }
    return false;
  }
  try {
    await saveSkillBinding(project, ws, 'planning', id);
    getHost().toast(`已把「${label}」綁到「${SKILL_STAGE_LABEL.planning}」階段。`);
    return true;
  } catch (err) {
    getHost().toast(`沒綁上：${describeError(err)}`, 'error');
    return false;
  }
}
