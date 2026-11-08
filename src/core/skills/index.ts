/**
 * 寫作技能（Skill）：按創作階段綁一份補充寫作方法，生成時拼進提示詞。
 * 詳見 [README.md](README.md)；純函式部分在 [model/writingSkill.ts](../model/writingSkill.ts)。
 */
export { BUILTIN_SKILL_DIRS } from './builtin/embedded';
export {
  installUserSkill,
  listSkills,
  loadSkill,
  setUserSkillsDir,
  uninstallUserSkill,
  userSkillsDir,
} from './library';
export type { LoadedSkill, SkillFiles } from './library';
export { inspectGitHubSkill, inspectedGitHubSkill, installGitHubSkill } from './github';
export type { RemoteSkill } from './github';
export { boundSkillFor, readSkillBindings, saveSkillBinding, unbindSkillEverywhere } from './bindings';
export type { BindingsFile, BoundSkill } from './bindings';
