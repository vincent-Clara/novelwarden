/**
 * 設定頁「技能」：列技能庫、從 GitHub 檢查與安裝、解除安裝（本工程的叫刪除）、本工程的階段繫結。
 *
 * 與 [settings.ts](settings.ts) 一樣**不依賴 controller**：獨立版沒開啟工程時由 WorkspaceHub
 * 直接調這幾個函式（`scope` 是空的），技能庫照樣能看、能裝、能卸；只有繫結要工程。
 *
 * 裝與卸在這裡先彈確認框（`Host.confirm`）——外部 agent 那條路由 `skills install` 的 `always` 閘門問，兩邊都問
 * 一次，不多不少。
 */
import * as path from 'node:path';
import { getHost } from '../host';
import type { NovelProject } from '../model/project';
import {
  SKILL_STAGE_LABEL,
  SkillStage,
  describeIncompat,
  isSkillStage,
  parseSkillId,
  skillLabel,
} from '../model/writingSkill';
import type { OutMessage, SkillRow, SkillsView } from '../protocol';
import { describeError, scoped } from '../runtime/logger';
import {
  LoadedSkill,
  inspectGitHubSkill,
  installGitHubSkill,
  listSkills,
  loadSkill,
  readSkillBindings,
  saveSkillBinding,
  unbindSkillEverywhere,
  uninstallUserSkill,
  userSkillsDir,
} from '../skills';
import type { Workspace } from '../workspace';

const log = scoped('技能');

export interface SkillsSink {
  post(message: OutMessage): void;
  toast(message: string, level?: 'info' | 'error'): void;
}

/** 有工程時兩樣都有；獨立版空視窗時都沒有。 */
export interface SkillsScope {
  project?: NovelProject;
  workspace?: Workspace;
}

export async function pushSkillsTo(sink: SkillsSink, scope: SkillsScope, installed?: string): Promise<void> {
  sink.post({ type: 'skills', view: await buildSkillsView(scope.project), installed });
}

async function buildSkillsView(project?: NovelProject): Promise<SkillsView> {
  const [skills, file] = await Promise.all([
    listSkills(project),
    project ? readSkillBindings(project) : Promise.resolve(undefined),
  ]);
  const bindings = file?.bindings;
  return {
    rows: skills.map((s) => rowOf(s, bindings ?? {})),
    bindings,
    problems: file?.problems.map((p) => p.text) ?? [],
    userDir: userSkillsDir(),
  };
}

function rowOf(s: LoadedSkill, bindings: Partial<Record<SkillStage, string>>): SkillRow {
  const i = s.inspection;
  return {
    id: s.id,
    source: s.source,
    name: s.name,
    label: skillLabel(i),
    description: i.description,
    version: i.version,
    suggestedStage: i.suggestedStage,
    compatible: i.compatible,
    reasons: i.compatible ? [] : [describeIncompat(i.reasons, i.unresolved)],
    bytes: i.bytes,
    files: i.attachments.map((a) => a.path),
    relPath: s.relPath,
    boundTo: (Object.keys(bindings) as SkillStage[]).filter((stage) => bindings[stage] === s.id),
  };
}

/** 檢查：下載來看，不寫任何檔案。結果（或錯誤）單獨回一條，前端拿它畫檢查卡。 */
export async function inspectSkillFrom(sink: SkillsSink, url: string): Promise<void> {
  try {
    const r = await inspectGitHubSkill(url);
    const i = r.inspection;
    sink.post({
      type: 'skillInspection',
      url,
      inspection: {
        url: r.sourceUrl,
        resolvedUrl: r.resolvedUrl,
        name: i.name,
        label: skillLabel(i),
        description: i.description,
        version: i.version,
        suggestedStage: i.suggestedStage,
        bytes: i.bytes,
        body: i.body,
        attachments: i.attachments.map((a) => ({ path: a.path, text: a.text })),
        blockers: r.blockers,
      },
    });
  } catch (err) {
    log.warn(`檢查技能失敗：${describeError(err)}`, url);
    sink.post({ type: 'skillInspection', url, error: describeError(err) });
  }
}

export async function installSkillFrom(sink: SkillsSink, scope: SkillsScope, url: string): Promise<void> {
  const choice = await getHost().confirm('把這份技能裝進我的技能庫？', ['安裝'], {
    modal: true,
    detail:
      `${url}\n會重新下載一遍，與剛才檢查的那一份核對一致才裝。` +
      '裝進去之後所有工程都看得見它，但要在「本工程的階段繫結」裡綁上才會用上。',
  });
  if (choice !== '安裝') {
    return;
  }
  try {
    const skill = await installGitHubSkill(url);
    sink.toast(`已裝進我的技能庫：${skillLabel(skill.inspection)}。綁到某個階段才會用上。`);
    await pushSkillsTo(sink, scope, skill.id);
  } catch (err) {
    log.error(`安裝技能失敗：${describeError(err)}`, url);
    sink.toast(`安裝失敗：${describeError(err)}`, 'error');
  }
}

/**
 * 解除安裝我的技能庫裡的、刪本工程的：整個目錄挪進回收站（不真刪）；本工程綁了它的階段一起解綁。
 * 內建的刪不掉。
 */
export async function uninstallSkillFrom(sink: SkillsSink, scope: SkillsScope, id: string): Promise<void> {
  const parsed = parseSkillId(id);
  if (parsed?.source === 'project') {
    await removeProjectSkill(sink, scope, id);
    return;
  }
  if (!parsed || parsed.source !== 'user') {
    sink.toast('內建技能刪不掉；不想用就在階段繫結裡換掉它。', 'error');
    return;
  }
  const skill = await loadSkill(id);
  const label = skill ? skillLabel(skill.inspection) : parsed.name;
  const choice = await getHost().confirm(`從我的技能庫解除安裝「${label}」？`, ['解除安裝'], {
    modal: true,
    detail:
      '整個目錄挪進技能庫的 .trash/skills/，不真刪。本工程綁了它的階段會一起解綁；' +
      '別的工程裡綁了它的，下次生成會在明細裡寫明「找不到」，然後不帶。',
  });
  if (choice !== '解除安裝') {
    return;
  }
  try {
    await uninstallUserSkill(parsed.name);
    const unbound =
      scope.project && scope.workspace ? await unbindSkillEverywhere(scope.project, scope.workspace, id) : [];
    sink.toast(
      unbound.length > 0
        ? `已解除安裝「${label}」，本工程的${unbound.map((s) => `「${SKILL_STAGE_LABEL[s]}」`).join('')}不再帶它。`
        : `已解除安裝「${label}」。`
    );
  } catch (err) {
    log.error(`解除安裝技能失敗：${describeError(err)}`, id);
    sink.toast(`解除安裝失敗：${describeError(err)}`, 'error');
  }
  await pushSkillsTo(sink, scope);
}

/** 刪本工程的技能：`.novelwarden/skills/<名字>/` 整個目錄經閘道器挪進回收站（舊工程是 `.novelforge/`）。 */
async function removeProjectSkill(sink: SkillsSink, scope: SkillsScope, id: string): Promise<void> {
  if (!scope.project || !scope.workspace) {
    sink.toast('本工程的技能跟著工程走：先開啟那個工程。', 'error');
    return;
  }
  const skill = await loadSkill(id, scope.project);
  if (!skill?.relPath) {
    sink.toast(`本工程裡找不到「${id}」。`, 'error');
    await pushSkillsTo(sink, scope);
    return;
  }
  const label = skillLabel(skill.inspection);
  const dir = path.posix.dirname(skill.relPath);
  const choice = await getHost().confirm(`刪掉本工程的技能「${label}」？`, ['刪除'], {
    modal: true,
    detail: `整個 ${dir}/ 挪進 ${scope.project.relPath(scope.project.trashDir)}/，可手動找回。綁了它的階段會一起解綁。`,
  });
  if (choice !== '刪除') {
    return;
  }
  try {
    const unbound = await unbindSkillEverywhere(scope.project, scope.workspace, id);
    await scope.workspace.remove(dir);
    sink.toast(
      unbound.length > 0
        ? `已刪除「${label}」，${unbound.map((s) => `「${SKILL_STAGE_LABEL[s]}」`).join('')}不再帶它。`
        : `已刪除「${label}」。`
    );
  } catch (err) {
    log.error(`刪除技能失敗：${describeError(err)}`, id);
    sink.toast(`刪除失敗：${describeError(err)}`, 'error');
  }
  await pushSkillsTo(sink, scope);
}

export async function bindSkillFrom(
  sink: SkillsSink,
  scope: SkillsScope,
  stage: SkillStage,
  id: string | null
): Promise<void> {
  if (!scope.project || !scope.workspace) {
    sink.toast('繫結跟著工程走：先開啟一個工程。', 'error');
    return;
  }
  if (!isSkillStage(stage)) {
    sink.toast(`認不出的階段「${String(stage)}」`, 'error');
    return;
  }
  try {
    await saveSkillBinding(scope.project, scope.workspace, stage, id);
  } catch (err) {
    log.error(`繫結技能失敗：${describeError(err)}`, `${stage} → ${id ?? '（不帶）'}`);
    sink.toast(`繫結失敗：${describeError(err)}`, 'error');
  }
  await pushSkillsTo(sink, scope);
}
