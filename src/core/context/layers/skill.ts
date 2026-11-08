/**
 * `skill` 層：這一次裝配所屬階段綁的那份寫作技能（移植自 AI-Novel-Writer 的階段 Skill）。
 *
 * - **自己讀繫結**（與 `style` 層讀 `style.md` 一樣），不經 `BuildRequest` 傳：對話頁、agent 的
 *   `generate`、工程頁批次三條路都走 `buildContext`，於是三條路帶的是同一份。
 * - **整份帶或整份不帶，不截半截**：正文連同它引用的附帶檔案算一整塊，放不下就 dropped 並寫明需要
 *   多少、剩多少（第 2 條）。
 *   不 force——一份 64 KiB 的技能強塞進一個 32k 視窗的模型，擠掉的是作者事實。配方里排在
 *   P0 那一組的最後：作者事實先拿預算，技能再拿（上游那句「作者事實……始終優先」）。
 * - **綁了卻帶不上的說出來**：找不到、變得不相容、繫結檔案讀不懂，一律 dropped 帶原因，
 *   而不是像上游那樣讓整次生成起不來。
 * - 討論不帶（`skillStageOf`）。**從已寫正文整理（`derive`）也不帶**：那一次是把寫成的東西照實整理，
 *   不是規劃——一份「規劃」技能會讓模型把已經發生的事按技能的排法改一遍。
 * - **記一條日誌**：用了哪份、或者為什麼沒帶。工程頁批次不走 `logAssembly`、也沒有明細可看，上游
 *   每次工作流同樣記一句「本次 X 階段使用……」。續寫與修復那幾輪會反覆裝配，同一句五分鐘內只記一次。
 */
import { SKILL_SOURCE_LABEL, SKILL_STAGE_LABEL, renderSkillBlock, skillLabel, skillStageOf } from '../../model/writingSkill';
import { scoped } from '../../runtime/logger';
import { boundSkillFor } from '../../skills/bindings';
import { estimateTokens } from '../tokenizer';
import type { LayerFn } from './assembly';

const log = scoped('技能');

const QUIET_MS = 5 * 60 * 1000;
const lastSaid = new Map<string, number>();

/** 同一句話（連同說明）五分鐘內只說一次。 */
function sayOnce(level: 'info' | 'warn', message: string, detail?: string): void {
  const key = `${message}\n${detail ?? ''}`;
  const now = Date.now();
  if (now - (lastSaid.get(key) ?? 0) < QUIET_MS) {
    return;
  }
  lastSaid.set(key, now);
  log[level](message, detail);
}

export const skill: LayerFn = async (a, spec) => {
  const stage = skillStageOf(a.request.action, a.request.writeMode);
  if (!stage || a.request.derive) {
    return;
  }
  const bound = await boundSkillFor(a.project, stage);
  if (bound.status === 'none') {
    return;
  }
  const base = { id: 'skill', kind: 'skill' as const, priority: spec.priority };
  if (bound.status === 'problem') {
    sayOnce('warn', `「${SKILL_STAGE_LABEL[stage]}」階段綁的技能沒帶上`, bound.note);
    a.reject(
      {
        ...base,
        label: `技能 · ${SKILL_STAGE_LABEL[stage]}`,
        source: a.project.relPath(a.project.skillBindingsPath),
        text: '',
      },
      'dropped',
      bound.note
    );
    return;
  }
  const { inspection, source, relPath } = bound.skill;
  const label = skillLabel(inspection);
  const item = {
    ...base,
    label: `技能 · ${label}`,
    source: relPath,
    text: renderSkillBlock(label, inspection.body, inspection.attachments),
    note: `${SKILL_SOURCE_LABEL[source]} · 綁在「${SKILL_STAGE_LABEL[stage]}」階段`,
  };
  if (a.excluded.has(item.id)) {
    a.admit(item);
    return;
  }
  const tokens = estimateTokens(item.text);
  if (!spec.force && tokens > a.remaining) {
    const note = `${item.note}；預算不足（需 ${tokens} token，剩 ${Math.max(0, a.remaining)}），整份沒帶`;
    sayOnce('warn', `技能「${label}」放不下，這次沒帶`, note);
    a.reject(item, 'dropped', note);
    return;
  }
  sayOnce('info', `「${SKILL_STAGE_LABEL[stage]}」階段帶上技能「${label}」`, `${bound.skill.id}｜${tokens} token`);
  a.admit(item, { force: spec.force });
};
