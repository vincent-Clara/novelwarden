/**
 * 技能庫（core/skills/）：三個來源怎麼讀、從 GitHub 先檢查再安裝、解除安裝進回收站、階段繫結。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 內建 → 我的技能庫 → 本工程，身份是目錄名 | 同名可以各有一份，靠字首分開 |
 * | 內建是倉庫裡的常規技能目錄，沒被引用的檔案不進提示詞 | 內建不再寫死在 TS 裡 |
 * | 磁碟上與 GitHub 上的附帶檔案按引用讀進來；連結不跟；檢查後附帶檔案變了也不裝 | 三個來源同一套讀法 |
 * | 連結、名字不合法、沒有 SKILL.md 的目錄跳過 | 我的技能庫在工程外，這就是它的邊界 |
 * | 沒檢查過不裝；檢查後內容變了不裝；不相容不裝；同名不覆蓋 | 照搬上游的五道關（第 3 條） |
 * | 檢查不寫任何檔案 | 檢查只是看 |
 * | 解除安裝挪進回收站，不真刪 | 第 6 條的精神 |
 * | 綁之前要求技能存在且相容；繫結檔案讀不懂時拒絕改寫 | 不把讀不懂的那幾項悄悄沖掉 |
 * | 裝配器問的那一句：沒綁 / 帶不上的原因 / 那一份 | 綁了卻帶不上要說出來 |
 */
const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject, makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let home;
let skills;
let ws;
const realFetch = globalThis.fetch;

const skillMd = (name, body = '每一場都要有一個選擇。', extra = []) =>
  ['---', `name: ${name}`, `display_name: ${name} 的寫法`, 'description: 測試用', ...extra, '---', body, ''].join('\n');

/** 假的 GitHub：`files` 是 raw 地址 → 內容，`branches` 是 owner/repo → 預設分支。 */
function fakeGitHub(files, branches = {}) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    const api = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)$/.exec(url);
    if (api) {
      const branch = branches[`${api[1]}/${api[2]}`];
      return branch
        ? new Response(JSON.stringify({ default_branch: branch }), { status: 200 })
        : new Response('{}', { status: 404 });
    }
    return url in files ? new Response(files[url], { status: 200 }) : new Response('nope', { status: 404 });
  };
  return calls;
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    skills: './src/core/skills/index.ts',
    ws: './src/core/workspace/index.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost().host);
  skills = bundle.skills;
  t = await makeTempProject(bundle.project, { prefix: 'skillLib', title: '技能測試' });
  ws = new bundle.ws.Workspace(t.project);
  home = makeTempDir('skillHome');
  skills.setUserSkillsDir(home.rel('skills'));
});

after(() => {
  globalThis.fetch = realFetch;
  skills?.setUserSkillsDir(undefined);
  if (home) fs.rmSync(home.dir, { recursive: true, force: true });
  if (t) cleanup(t.dir, bundle?.db);
});

describe('三個來源', () => {
  before(() => {
    home.write('skills/scene-craft/SKILL.md', skillMd('scene-craft'));
    home.write('skills/no-file/README.md', 'x');
    home.write('skills/bad name/SKILL.md', skillMd('bad'));
    t.write('.novelwarden/skills/去AI味/SKILL.md', skillMd('anything-else', '少用「彷彿」。'));
    t.write('.novelwarden/skills/scene-craft/SKILL.md', skillMd('scene-craft', '工程裡的那一份。'));
    try {
      fs.symlinkSync(home.rel('skills/scene-craft'), home.rel('skills/linked'), 'dir');
    } catch {
      // Windows 上沒許可權建連結：這一條就只驗剩下的。
    }
  });

  test('內建 → 我的技能庫 → 本工程，各來源內按名字排', async () => {
    const ids = (await skills.listSkills(t.project)).map((s) => s.id);
    assert.deepEqual(ids, ['builtin:plain-prose', 'user:scene-craft', 'project:scene-craft', 'project:去AI味']);
  });

  test('身份是目錄名，frontmatter 的 name 只用來顯示', async () => {
    const own = await skills.loadSkill('project:去AI味', t.project);
    assert.deepEqual([own.name, own.inspection.name, own.inspection.body], ['去AI味', 'anything-else', '少用「彷彿」。']);
  });

  test('本工程的技能帶工程內路徑，我的技能庫的沒有', async () => {
    const [user, own] = await Promise.all([
      skills.loadSkill('user:scene-craft'),
      skills.loadSkill('project:scene-craft', t.project),
    ]);
    assert.deepEqual([user.relPath, own.relPath], [undefined, '.novelwarden/skills/scene-craft/SKILL.md']);
  });

  test('沒給工程就認不出本工程的技能', async () => {
    assert.equal(await skills.loadSkill('project:scene-craft'), undefined);
  });

  test('內建的都相容', async () => {
    const list = await skills.listSkills();
    assert.ok(list.filter((s) => s.source === 'builtin').every((s) => s.inspection.compatible));
  });

  test('去 AI 味建議綁在寫正文階段', async () => {
    const plain = await skills.loadSkill('builtin:plain-prose');
    assert.equal(plain.inspection.stage, 'drafting');
  });

  test('內建目錄裡沒被引用的檔案（上游的 LICENSE）不進提示詞', async () => {
    const dir = skills.BUILTIN_SKILL_DIRS['plain-prose'];
    assert.ok('LICENSE-fiction-humanizer-zh' in dir && 'LICENSE-humanizer-zh' in dir);
    assert.deepEqual((await skills.loadSkill('builtin:plain-prose')).inspection.attachments, []);
  });

  test('連結過去的目錄認不出', async () => {
    assert.equal(await skills.loadSkill('user:linked'), undefined);
  });
});

describe('磁碟上的附帶檔案', () => {
  before(() => {
    home.write('skills/with-refs/SKILL.md', skillMd('with-refs', '照 [模式](references/a.md) 寫，交稿前過 references/b.md。'));
    home.write('skills/with-refs/references/a.md', '模式 A，細節見 [這裡](deep/c.md)。');
    home.write('skills/with-refs/references/deep/c.md', '更細的');
    home.write('skills/with-refs/references/b.md', '清單');
    home.write('skills/with-refs/README.md', '不進提示詞');
    home.write('outside.md', '技能目錄外的');
    home.write('skills/linked-ref/SKILL.md', skillMd('linked-ref', '照 references/a.md 寫。'));
    fs.mkdirSync(home.rel('skills/linked-ref/references'), { recursive: true });
    try {
      fs.symlinkSync(home.rel('outside.md'), home.rel('skills/linked-ref/references/a.md'));
    } catch {
      // Windows 上沒許可權建連結：放一個打不開的東西代替，這一條照樣是「帶不上」。
      fs.mkdirSync(home.rel('skills/linked-ref/references/a.md'));
    }
  });

  after(() => {
    for (const name of ['with-refs', 'linked-ref']) {
      fs.rmSync(home.rel('skills', name), { recursive: true, force: true });
    }
  });

  test('按引用一層層讀進來，沒被引用的不讀', async () => {
    const s = await skills.loadSkill('user:with-refs');
    assert.deepEqual(
      s.inspection.attachments.map((a) => [a.path, a.text]),
      [
        ['references/a.md', '模式 A，細節見 [這裡](deep/c.md)。'],
        ['references/b.md', '清單'],
        ['references/deep/c.md', '更細的'],
      ]
    );
    assert.equal(s.inspection.compatible, true);
  });

  test('附帶檔案是連結：不跟，判帶不上', async () => {
    const s = await skills.loadSkill('user:linked-ref');
    assert.deepEqual([s.inspection.compatible, s.inspection.unresolved], [false, ['references/a.md']]);
  });
});

describe('從 GitHub 檢查與安裝', () => {
  const RAW = 'https://raw.githubusercontent.com/o/r/main/SKILL.md';
  const URL = 'https://github.com/o/r';

  beforeEach(() => {
    fs.rmSync(home.rel('skills/remote-skill'), { recursive: true, force: true });
  });

  test('倉庫首頁：先問預設分支，再下載 raw', async () => {
    const calls = fakeGitHub({ [RAW]: skillMd('remote-skill') }, { 'o/r': 'main' });
    const r = await skills.inspectGitHubSkill(URL);
    assert.deepEqual(calls, ['https://api.github.com/repos/o/r', RAW]);
    assert.deepEqual([r.resolvedUrl, r.inspection.name, r.blockers], [RAW, 'remote-skill', []]);
  });

  test('檢查不寫任何檔案', async () => {
    fakeGitHub({ [RAW]: skillMd('remote-skill') }, { 'o/r': 'main' });
    await skills.inspectGitHubSkill(URL);
    assert.ok(!fs.existsSync(home.rel('skills/remote-skill')));
  });

  test('檢查過的那一份裝得進來，原樣落盤', async () => {
    const raw = skillMd('remote-skill');
    fakeGitHub({ [RAW]: raw }, { 'o/r': 'main' });
    await skills.inspectGitHubSkill(URL);
    const s = await skills.installGitHubSkill(URL);
    assert.equal(s.id, 'user:remote-skill');
    assert.equal(fs.readFileSync(home.rel('skills/remote-skill/SKILL.md'), 'utf8'), raw);
  });

  test('沒檢查過不裝', async () => {
    fakeGitHub({ [RAW]: skillMd('remote-skill') }, { 'o/r': 'main' });
    await assert.rejects(skills.installGitHubSkill('https://github.com/o/r/tree/main'), /請先檢查/);
  });

  test('檢查之後內容變了不裝', async () => {
    const files = { [RAW]: skillMd('remote-skill') };
    fakeGitHub(files, { 'o/r': 'main' });
    await skills.inspectGitHubSkill(URL);
    files[RAW] = skillMd('remote-skill', '換了一段。');
    await assert.rejects(skills.installGitHubSkill(URL), /檢查之後變了/);
    assert.ok(!fs.existsSync(home.rel('skills/remote-skill')));
  });

  test('不相容的：檢查時就說裝不了，裝也裝不進來', async () => {
    fakeGitHub({ [RAW]: skillMd('remote-skill', '寫完執行 scripts/lint.sh。') }, { 'o/r': 'main' });
    const r = await skills.inspectGitHubSkill(URL);
    assert.ok(r.blockers[0].includes('依賴指令碼'), r.blockers.join('|'));
    await assert.rejects(skills.installGitHubSkill(URL), /裝不了/);
  });

  test('同名的已經裝了：說清要先解除安裝舊的，不覆蓋', async () => {
    home.write('skills/remote-skill/SKILL.md', '舊的');
    fakeGitHub({ [RAW]: skillMd('remote-skill') }, { 'o/r': 'main' });
    const r = await skills.inspectGitHubSkill(URL);
    assert.ok(r.blockers[0].includes('先解除安裝舊的'), r.blockers.join('|'));
    await assert.rejects(skills.installGitHubSkill(URL));
    assert.equal(fs.readFileSync(home.rel('skills/remote-skill/SKILL.md'), 'utf8'), '舊的');
  });

  test('超過 64 KiB 的不收', async () => {
    fakeGitHub({ [RAW]: skillMd('remote-skill', '字'.repeat(23000)) }, { 'o/r': 'main' });
    await assert.rejects(skills.inspectGitHubSkill(URL), /64 KiB/);
  });

  test('下載失敗說出 HTTP 狀態', async () => {
    fakeGitHub({}, { 'o/r': 'main' });
    await assert.rejects(skills.inspectGitHubSkill(URL), /HTTP 404/);
  });

  test('引用到的附帶檔案一份份下下來，裝進去是整棵目錄', async () => {
    const REF = 'https://raw.githubusercontent.com/o/r/main/skills/x/references/a.md';
    const raw = skillMd('remote-skill', '照 references/a.md 寫。');
    const calls = fakeGitHub(
      { 'https://raw.githubusercontent.com/o/r/main/skills/x/SKILL.md': raw, [REF]: '附帶的' },
      { 'o/r': 'main' }
    );
    const url = 'https://github.com/o/r/tree/main/skills/x';
    const r = await skills.inspectGitHubSkill(url);
    assert.ok(calls.includes(REF));
    assert.deepEqual([r.blockers, r.inspection.attachments.map((a) => a.path)], [[], ['references/a.md']]);
    await skills.installGitHubSkill(url);
    assert.equal(fs.readFileSync(home.rel('skills/remote-skill/SKILL.md'), 'utf8'), raw);
    assert.equal(fs.readFileSync(home.rel('skills/remote-skill/references/a.md'), 'utf8'), '附帶的');
  });

  test('引用的附帶檔案下不到：檢查時說帶不上哪一份', async () => {
    fakeGitHub({ [RAW]: skillMd('remote-skill', '照 references/gone.md 寫。') }, { 'o/r': 'main' });
    const r = await skills.inspectGitHubSkill(URL);
    assert.ok(r.blockers[0].includes('帶不上：references/gone.md'), r.blockers.join('|'));
  });

  test('檢查之後附帶檔案變了：不裝', async () => {
    const REF = 'https://raw.githubusercontent.com/o/r/main/references/a.md';
    const files = { [RAW]: skillMd('remote-skill', '照 references/a.md 寫。'), [REF]: '舊的' };
    fakeGitHub(files, { 'o/r': 'main' });
    await skills.inspectGitHubSkill(URL);
    files[REF] = '新的';
    await assert.rejects(skills.installGitHubSkill(URL), /檢查之後變了/);
    assert.ok(!fs.existsSync(home.rel('skills/remote-skill')));
  });

  test('確認框要的檢查結果不用聯網就拿得到', async () => {
    fakeGitHub({ [RAW]: skillMd('remote-skill') }, { 'o/r': 'main' });
    await skills.inspectGitHubSkill(URL);
    assert.equal(skills.inspectedGitHubSkill(URL).inspection.name, 'remote-skill');
  });
});

describe('解除安裝', () => {
  test('整個目錄挪進與技能庫同級的 .trash/skills/', async () => {
    home.write('skills/to-remove/SKILL.md', skillMd('to-remove'));
    const dest = await skills.uninstallUserSkill('to-remove');
    assert.equal(dest, home.rel('.trash', 'skills', 'to-remove'));
    assert.ok(!fs.existsSync(home.rel('skills/to-remove')) && fs.existsSync(path.join(dest, 'SKILL.md')));
  });

  test('回收站裡已經有同名的：加 -2，不蓋掉', async () => {
    home.write('skills/to-remove/SKILL.md', skillMd('to-remove'));
    const dest = await skills.uninstallUserSkill('to-remove');
    assert.equal(path.basename(dest), 'to-remove-2');
  });

  test('本來就沒有：什麼都不做', async () => {
    assert.equal(await skills.uninstallUserSkill('never-was'), undefined);
  });
});

describe('階段繫結', () => {
  const bindingsText = () => t.read('.novelwarden/skills.json');

  test('綁上一份：寫進 .novelwarden/skills.json', async () => {
    await skills.saveSkillBinding(t.project, ws, 'drafting', 'builtin:plain-prose');
    assert.deepEqual(JSON.parse(bindingsText()), { version: 1, bindings: { drafting: 'builtin:plain-prose' } });
  });

  test('裝配器問得到那一份', async () => {
    const r = await skills.boundSkillFor(t.project, 'drafting');
    assert.deepEqual([r.status, r.skill.id], ['ok', 'builtin:plain-prose']);
  });

  test('沒綁的階段：none', async () => {
    assert.equal((await skills.boundSkillFor(t.project, 'review')).status, 'none');
  });

  test('不存在的技能綁不上', async () => {
    await assert.rejects(skills.saveSkillBinding(t.project, ws, 'review', 'user:never-was'), /找不到技能/);
  });

  test('不相容的技能綁不上', async () => {
    t.write('.novelwarden/skills/needs-tool/SKILL.md', skillMd('needs-tool', '先呼叫檢索工具。'));
    await assert.rejects(skills.saveSkillBinding(t.project, ws, 'review', 'project:needs-tool'), /不相容/);
  });

  test('解綁：那一項刪掉', async () => {
    await skills.saveSkillBinding(t.project, ws, 'drafting', null);
    assert.deepEqual(JSON.parse(bindingsText()).bindings, {});
  });

  test('綁著的技能後來不見了：說找不到，不拋', async () => {
    t.write('.novelwarden/skills.json', JSON.stringify({ version: 1, bindings: { review: 'user:gone' } }));
    const r = await skills.boundSkillFor(t.project, 'review');
    assert.equal(r.status, 'problem');
    assert.ok(r.note.includes('user:gone') && r.note.includes('找不到了'), r.note);
  });

  test('綁著的技能後來變得不相容：說不相容', async () => {
    t.write('.novelwarden/skills.json', JSON.stringify({ version: 1, bindings: { review: 'project:needs-tool' } }));
    const r = await skills.boundSkillFor(t.project, 'review');
    assert.ok(r.status === 'problem' && r.note.includes('不相容'), JSON.stringify(r));
  });

  test('繫結檔案讀不懂：裝配器說讀不懂；改繫結拒絕改寫', async () => {
    t.write('.novelwarden/skills.json', '{ 壞了');
    const r = await skills.boundSkillFor(t.project, 'planning');
    assert.ok(r.status === 'problem' && r.note.includes('讀不懂'), JSON.stringify(r));
    await assert.rejects(skills.saveSkillBinding(t.project, ws, 'planning', 'builtin:plain-prose'), /先手動修好或刪掉/);
    assert.equal(bindingsText(), '{ 壞了');
  });

  test('只有別的階段那一項讀不懂：這個階段照常', async () => {
    t.write('.novelwarden/skills.json', JSON.stringify({ version: 1, bindings: { review: 3, drafting: 'builtin:plain-prose' } }));
    assert.equal((await skills.boundSkillFor(t.project, 'drafting')).status, 'ok');
    assert.equal((await skills.boundSkillFor(t.project, 'planning')).status, 'none');
  });

  test('解除安裝之後把指向它的繫結一起解掉', async () => {
    t.write('.novelwarden/skills.json', JSON.stringify({ version: 1, bindings: { review: 'user:x', drafting: 'user:x', planning: 'builtin:plain-prose' } }));
    const stages = await skills.unbindSkillEverywhere(t.project, ws, 'user:x');
    assert.deepEqual(stages.sort(), ['drafting', 'review']);
    assert.deepEqual(JSON.parse(bindingsText()).bindings, { planning: 'builtin:plain-prose' });
  });
});
