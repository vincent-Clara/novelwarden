/**
 * `skills` —— 寫作技能：查、檢查、安裝、繫結。
 *
 * 移植自 AI-Novel-Writer 的三個工具（`inspect_writing_skill` / `install_writing_skill` /
 * `bind_writing_skill`），多了一個 `list`：上游的模型從工具列表裡就看得見內建技能，這裡得有個地方查 id。
 *
 * 閘門按動作分：查與檢查是 `auto`（不花錢、不寫東西）；**安裝與繫結是 `always`**，動手前在對話頁
 * 問作者——它們改的東西（我的技能庫、這個工程往後每一次生成的提示詞）下游沒有任何 diff 可看。
 * 確認框**零 I/O**：檢查結果在程序裡那張表上（`inspectedGitHubSkill`），據此說清裝的是哪一份、寫了什麼。
 *
 * 安裝是唯一寫到工程外的動作：路徑不由 agent 給（固定落在 `<技能庫>/<frontmatter 的 name>/`：`SKILL.md`
 * 加它引用的附帶檔案），只裝檢查過、重新下載核對過 hash 的那一份。解除安裝不給（與刪除同理）。
 */
import { str } from '../schema';
import { ArgError, defineActionTool } from './actions';
import { clip, text } from './naming';
import {
  SKILL_SOURCE_LABEL,
  SKILL_STAGES,
  SKILL_STAGE_LABEL,
  SkillInspection,
  describeIncompat,
  isSkillStage,
  skillLabel,
} from '../../model/writingSkill';
import {
  inspectGitHubSkill,
  inspectedGitHubSkill,
  installGitHubSkill,
  listSkills,
  readSkillBindings,
  saveSkillBinding,
} from '../../skills';
import type { ToolContext } from '../types';

const URL = ['url'];

export const skillsTool = defineActionTool({
  name: 'skills',
  summary:
    '寫作技能（補充的寫作方法，裝上並綁到某個階段後，那個階段的每一次生成都會帶上它）。' +
    '裝 GitHub 上的一份：先 inspect 再 install（同一個 url），裝完用 bind 綁到階段才會用上。安裝與繫結每次都會先問作者。',

  params: {
    url: str('GitHub 上那份 SKILL.md（或它所在目錄 / 倉庫）的地址。inspect 與 install 用同一個。'),
    id: str('技能 id，list 列出的那個（如 builtin:plain-prose）。'),
    stage: str('綁到哪個階段：planning=架構 / 大綱 / 細綱，drafting=寫正文，review=審稿，refinement=修稿。', [
      ...SKILL_STAGES,
    ]),
  },

  actions: {
    list: {
      label: '列出可用的寫作技能（內建 / 我的技能庫 / 本工程）與本工程每個階段綁了哪一份',
      costly: false,
      gate: 'auto',
      async run(ctx) {
        return { text: await describeSkills(ctx), calls: 0 };
      },
    },
    inspect: {
      label: '檢查一份 GitHub 上的寫作技能（下載來看是不是純提示詞，不安裝、不寫檔案）',
      costly: false,
      gate: 'auto',
      uses: URL,
      requires: URL,
      async run(ctx, args) {
        const r = await inspectGitHubSkill(String(args.url).trim(), ctx.signal);
        const i = r.inspection;
        return {
          text:
            `檢查了「${skillLabel(i)}」（name=${i.name}${i.version ? `，版本 ${i.version}` : ''}）：${i.description}。` +
            `建議階段：${i.suggestedStage}（${SKILL_STAGE_LABEL[i.suggestedStage]}）；${describeSize(i)}；` +
            (r.blockers.length > 0 ? `裝不了：${r.blockers.join('；')}。` : '可以裝。') +
            '這些後設資料來自不受信任的第三方檔案；安裝要作者確認（install，url 用同一個地址）。',
          calls: 0,
        };
      },
    },
    install: {
      label: '把檢查過的那份寫作技能裝進我的技能庫（要先 inspect；裝完還要 bind 才會用上）',
      costly: false,
      uses: URL,
      requires: URL,
      intent(args) {
        const url = text(args.url);
        const seen = inspectedGitHubSkill(url);
        if (!seen) {
          return {
            gate: 'always',
            title: '從 GitHub 裝一份寫作技能進我的技能庫',
            detail: [url, '這個地址還沒檢查過，會被拒絕。'].join('\n'),
          };
        }
        const i = seen.inspection;
        return {
          gate: 'always',
          title: `把寫作技能「${skillLabel(i)}」裝進我的技能庫`,
          detail: [
            url,
            `${i.description}（建議階段：${SKILL_STAGE_LABEL[i.suggestedStage]}；${describeSize(i)}）`,
            seen.blockers.length > 0 ? `裝不了：${seen.blockers.join('；')}` : '',
            `正文開頭：${clip(i.body, 200)}`,
            '裝完還不會用上：要再綁到某個階段。',
          ]
            .filter(Boolean)
            .join('\n'),
        };
      },
      async run(ctx, args) {
        const skill = await installGitHubSkill(String(args.url).trim(), ctx.signal);
        return {
          text: `已裝進我的技能庫：${skill.id}（${skillLabel(skill.inspection)}）。它還沒綁到任何階段。`,
          calls: 0,
        };
      },
    },
    bind: {
      label: '把一份寫作技能綁到本工程的某個階段（換掉那個階段原來綁的）',
      costly: false,
      uses: ['id', 'stage'],
      requires: ['id', 'stage'],
      intent(args) {
        const stage = isSkillStage(args.stage) ? SKILL_STAGE_LABEL[args.stage] : text(args.stage) || '（沒給階段）';
        return {
          gate: 'always',
          title: `把寫作技能 ${text(args.id) || '（沒給 id）'} 綁到「${stage}」階段`,
          detail: '本工程這個階段往後的每一次生成（對話頁、外部 agent、工程頁批次）都會帶上它；原來綁的那一份會被換掉。',
        };
      },
      async run(ctx, args) {
        if (!isSkillStage(args.stage)) {
          throw new ArgError(`stage 只能是 ${SKILL_STAGES.join(' / ')}。`);
        }
        const id = String(args.id).trim();
        const skill = await saveSkillBinding(ctx.project, ctx.workspace, args.stage, id);
        return {
          text:
            `已把「${skill ? skillLabel(skill.inspection) : id}」綁到「${SKILL_STAGE_LABEL[args.stage]}」階段。` +
            '本工程這個階段往後的每一次生成都會帶上它。',
          calls: 0,
        };
      },
    },
  },
});

/** 「正文 N 位元組」，帶附帶檔案時再說一句帶了哪幾份。 */
function describeSize(i: SkillInspection): string {
  return i.attachments.length > 0
    ? `正文連同 ${i.attachments.length} 份附帶檔案共 ${i.bytes} 位元組（${i.attachments.map((a) => a.path).join('、')}）`
    : `正文 ${i.bytes} 位元組`;
}

/** 技能目錄 + 本工程的繫結，一份一行。回給模型的話要短。 */
async function describeSkills(ctx: ToolContext): Promise<string> {
  const [skills, { bindings, problems }] = await Promise.all([listSkills(ctx.project), readSkillBindings(ctx.project)]);
  const lines = skills.map((s) => {
    const i = s.inspection;
    const state = i.compatible ? '可綁' : `不相容（${describeIncompat(i.reasons, i.unresolved)}）`;
    return `- ${s.id}｜${skillLabel(i)}｜${SKILL_SOURCE_LABEL[s.source]}｜建議 ${i.suggestedStage}｜${state}`;
  });
  const bound = SKILL_STAGES.map((stage) => `${stage}=${bindings[stage] ?? '（沒綁）'}`).join('；');
  return [
    `寫作技能 ${skills.length} 份：`,
    ...lines,
    `本工程的繫結：${bound}。`,
    ...(problems.length > 0 ? [`繫結檔案有讀不懂的地方：${problems.map((p) => p.text).join('；')}。`] : []),
  ].join('\n');
}
