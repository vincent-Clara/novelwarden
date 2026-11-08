/**
 * 設定頁「技能」刪本工程的技能（controller/skills.ts 的 uninstallSkillFrom，source=project）。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 作者點了「刪除」：整個技能目錄進 `.novelwarden/.trash/`，綁了它的階段解綁 | 不真刪；留著繫結會讓每次生成都報「找不到」 |
 * | 作者取消：目錄與繫結都不動 | 刪除要先問 |
 * | 內建技能攔下 | 內建的刪不掉 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject, makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

const SKILL = '---\nname: 玄天錄-寫法\ndisplay_name: 《玄天錄》的寫法\ndescription: 拆出來的寫法\nstage: planning\n---\n## 章節結構\n\n每章兩到三個場景。\n';

let bundle;
let h;
let home;
const projects = [];

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    skills: './src/core/skills/index.ts',
    ctl: './src/core/controller/skills.ts',
    db: './src/core/runtime/db.ts',
  });
  h = makeFakeHost();
  bundle.host.initHost(h.host);
  home = makeTempDir('skillsRemoveHome');
  bundle.skills.setUserSkillsDir(home.rel('skills'));
});

after(() => {
  bundle?.skills.setUserSkillsDir(undefined);
  if (home) fs.rmSync(home.dir, { recursive: true, force: true });
  for (const t of projects) cleanup(t.dir, bundle?.db);
});

async function fresh(prefix) {
  const t = await makeTempProject(bundle.project, { prefix, title: '刪技能' });
  projects.push(t);
  t.write('.novelwarden/skills/玄天錄-寫法/SKILL.md', SKILL);
  t.project.invalidate();
  const workspace = new bundle.ws.Workspace(t.project);
  await bundle.skills.saveSkillBinding(t.project, workspace, 'planning', 'project:玄天錄-寫法');
  const posts = [];
  const toasts = [];
  const sink = { post: (m) => posts.push(m), toast: (m, level) => toasts.push(`${level ?? 'info'}:${m}`) };
  return { t, scope: { project: t.project, workspace }, sink, posts, toasts };
}

describe('刪本工程的技能', () => {
  test('點了刪除：目錄進回收站，繫結解開，重推一份技能表', async () => {
    const { t, scope, sink, posts, toasts } = await fresh('skill-rm');
    h.expect('刪除');
    await bundle.ctl.uninstallSkillFrom(sink, scope, 'project:玄天錄-寫法');
    assert.ok(!t.has('.novelwarden/skills/玄天錄-寫法'));
    assert.match(t.read('.novelwarden/.trash/.novelwarden/skills/玄天錄-寫法/SKILL.md'), /每章兩到三個場景/);
    const { bindings } = await bundle.skills.readSkillBindings(t.project);
    assert.equal(bindings.planning, undefined);
    assert.match(h.confirms.at(-1).message, /刪掉本工程的技能「《玄天錄》的寫法」/);
    assert.ok(toasts.some((x) => x.startsWith('info:已刪除「《玄天錄》的寫法」') && x.includes('規劃')), toasts.join('|'));
    const view = posts.at(-1).view;
    assert.ok(!view.rows.some((r) => r.id === 'project:玄天錄-寫法'));
  });

  test('取消：目錄與繫結都不動', async () => {
    const { t, scope, sink } = await fresh('skill-keep');
    h.expect(undefined);
    await bundle.ctl.uninstallSkillFrom(sink, scope, 'project:玄天錄-寫法');
    assert.ok(t.has('.novelwarden/skills/玄天錄-寫法/SKILL.md'));
    const { bindings } = await bundle.skills.readSkillBindings(t.project);
    assert.equal(bindings.planning, 'project:玄天錄-寫法');
  });

  test('內建技能攔下', async () => {
    const { scope, sink, toasts } = await fresh('skill-builtin');
    const before = h.confirms.length;
    await bundle.ctl.uninstallSkillFrom(sink, scope, 'builtin:plain-prose');
    assert.equal(h.confirms.length, before);
    assert.ok(toasts.some((x) => x.startsWith('error:') && x.includes('內建技能刪不掉')), toasts.join('|'));
  });
});
