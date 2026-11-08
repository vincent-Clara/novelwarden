/**
 * 工程的階段繫結：`.novelwarden/skills.json` 裡記著每個階段綁了哪份技能。
 *
 * 繫結跟著**工程**走（上游同樣存在工程裡）：同一份技能在這本書裡綁在寫正文上，換一本書
 * 可能根本不想用。一個階段最多一份；同一份可以綁在幾個階段上。沒綁就什麼都不帶——
 * 內建技能也不自動綁。
 *
 * 寫盤走 `Workspace.writeSkillBindings`（第 7 條：工程裡的寫盤只經閘道器）。
 */
import type { NovelProject } from '../model/project';
import { readTextIfExists } from '../model/fs';
import {
  SKILL_STAGE_LABEL,
  SkillBindings,
  SkillStage,
  describeIncompat,
  isSkillStage,
  parseSkillBindings,
  renderSkillBindings,
  skillLabel,
} from '../model/writingSkill';
import type { Workspace } from '../workspace';
import { scoped } from '../runtime/logger';
import { LoadedSkill, loadSkill } from './library';

const log = scoped('技能');

export interface BindingsFile {
  bindings: SkillBindings;
  /** 讀不懂的地方（第 1 條：跳過、不拋；第 2 條：說出來）。 */
  problems: { stage?: string; text: string }[];
}

export async function readSkillBindings(project: NovelProject): Promise<BindingsFile> {
  const raw = (await readTextIfExists(project.skillBindingsPath)) ?? '';
  return parseSkillBindings(raw);
}

/** 這一個階段該帶的那份技能，或者帶不了的原因。 */
export type BoundSkill =
  | { status: 'none' }
  | { status: 'problem'; note: string }
  | { status: 'ok'; skill: LoadedSkill };

/**
 * 裝配器問的那一句：這個階段綁了什麼、帶不帶得上。
 *
 * 綁了卻帶不上（找不到、變得不相容、繫結檔案讀不懂）**不讓這次生成起不來**——上游是整個工作流
 * 拒絕啟動——而是這一次不帶，由裝配器在明細裡寫明原因（第 2 條）。
 */
export async function boundSkillFor(project: NovelProject, stage: SkillStage): Promise<BoundSkill> {
  const { bindings, problems } = await readSkillBindings(project);
  const id = bindings[stage];
  if (!id) {
    const relevant = problems.filter((p) => p.stage === undefined || p.stage === stage);
    if (relevant.length === 0) {
      return { status: 'none' };
    }
    return {
      status: 'problem',
      note: `技能繫結檔案讀不懂（${relevant.map((p) => p.text).join('；')}），這次沒帶技能`,
    };
  }
  const skill = await loadSkill(id, project);
  if (!skill) {
    return {
      status: 'problem',
      note: `繫結的技能 ${id} 找不到了（解除安裝了、改了名，或者 SKILL.md 讀不出來），這次沒帶`,
    };
  }
  if (!skill.inspection.compatible) {
    return {
      status: 'problem',
      note: `繫結的技能「${skillLabel(skill.inspection)}」現在不相容（${describeIncompat(skill.inspection.reasons, skill.inspection.unresolved)}），這次沒帶`,
    };
  }
  return { status: 'ok', skill };
}

/**
 * 繫結或解綁（`id` 為 null）一個階段。
 *
 * 綁之前要求這份技能**存在且相容**（上游只查 id 的格式，綁一份不存在的技能要等到下一次生成才
 * 發現）。繫結檔案讀不懂時拒絕改寫：重寫一遍會把讀不懂的那幾項悄悄沖掉（第 3 條），先讓作者
 * 自己修好或刪掉。
 */
export async function saveSkillBinding(
  project: NovelProject,
  workspace: Workspace,
  stage: SkillStage,
  id: string | null
): Promise<LoadedSkill | undefined> {
  if (!isSkillStage(stage)) {
    throw new Error(`認不出的階段「${String(stage)}」`);
  }
  let skill: LoadedSkill | undefined;
  if (id !== null) {
    skill = await loadSkill(id, project);
    if (!skill) {
      throw new Error(`找不到技能 ${id}`);
    }
    if (!skill.inspection.compatible) {
      throw new Error(`「${skillLabel(skill.inspection)}」不相容（${describeIncompat(skill.inspection.reasons, skill.inspection.unresolved)}），綁不上`);
    }
  }
  const { bindings, problems } = await readSkillBindings(project);
  if (problems.length > 0) {
    throw new Error(
      `${project.relPath(project.skillBindingsPath)} 有讀不懂的地方（${problems.map((p) => p.text).join('；')}），` +
        '先手動修好或刪掉它再綁。'
    );
  }
  if ((bindings[stage] ?? null) === id) {
    return skill;
  }
  const next: SkillBindings = { ...bindings };
  if (id === null) {
    delete next[stage];
  } else {
    next[stage] = id;
  }
  await workspace.writeSkillBindings(renderSkillBindings(next));
  log.info(
    id === null
      ? `「${SKILL_STAGE_LABEL[stage]}」階段不再帶技能`
      : `「${SKILL_STAGE_LABEL[stage]}」階段繫結技能「${skillLabel(skill!.inspection)}」`,
    id ?? undefined
  );
  return skill;
}

/** 把指向某份技能的繫結全部解掉（解除安裝之後用）。返回解掉了哪幾個階段。 */
export async function unbindSkillEverywhere(
  project: NovelProject,
  workspace: Workspace,
  id: string
): Promise<SkillStage[]> {
  const { bindings, problems } = await readSkillBindings(project);
  const stages = (Object.keys(bindings) as SkillStage[]).filter((s) => bindings[s] === id);
  if (stages.length === 0 || problems.length > 0) {
    return [];
  }
  const next: SkillBindings = { ...bindings };
  for (const s of stages) {
    delete next[s];
  }
  await workspace.writeSkillBindings(renderSkillBindings(next));
  return stages;
}
