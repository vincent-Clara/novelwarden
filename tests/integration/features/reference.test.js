/**
 * 從參考書學寫法（拆書 B，features/reference.ts）：只學怎麼寫——文風寫 `style.md`，結構與節奏寫成一份
 * 「規劃」階段的寫作技能，問綁不綁。原文一個字都不進工程。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 確認框報次數、抽哪幾章、寫到哪；style.md 有內容時按鈕寫明會覆蓋 | 第 3、4 條 |
 * | 文風那次用參考書那份提示詞（帶任務邊界），樣章是均勻抽的開頭 | 只學技法、不復述內容 |
 * | 寫法那次帶篇幅統計、看章節的頭尾 | 結構與鉤子要看結尾 |
 * | 技能寫成本工程的 `SKILL.md`、stage 是規劃、相容；作者點了才綁 | 第 25 條精神：改往後每次生成的提示詞要先問 |
 * | 原文不進工程 | 作者拍板：只學寫法 |
 * | 只學文風：1 次呼叫，不寫技能 | 選什麼做什麼 |
 * | 技能正文不相容：不綁，說清為什麼 | 綁上會讓裝配器每次都 dropped |
 * | 寫一半就停 / 撞上限：不寫盤 | 半份文風指南、半份技能會被當成完整的照做 |
 * | 宿主能選本機檔案：工程外的 txt 也能學；MCP 給的路徑仍只認工程裡的 | 作者點的入口不必先把書搬進工程；外部 agent 不讀工程外的檔案 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject, makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let fake;
let home;
/** 提示詞規定的小節一個不缺——缺了會被當成截斷攔下。 */
const sections = (heads, first) => heads.map((x, i) => `## ${x}\n\n${i === 0 ? first : '……'}`).join('\n\n');
const STYLE_HEADS = ['敘事視角', '句式節奏', '遣詞特徵', '對白風格', '描寫偏好', '修辭習慣', '禁用清單'];
const SKILL_HEADS = ['章節結構', '場景推進', '鉤子與懸念', '節奏與爽點', '資訊投放', '開篇寫法', '規劃時怎麼用'];
const STYLE_FULL = sections(STYLE_HEADS, '第三人稱限知。');
const SKILL_FULL = `${sections(SKILL_HEADS, '每章兩到三個場景，結尾停在未決的選擇上。')}\n\n- 每章至少一次局面變化。`;
let skillBody = SKILL_FULL;
let styleReply = STYLE_FULL;
/** 上下文詳細度：缺席 = 第 3 級（抽 5 章）。 */
let contextDetail;
const projects = [];

/** 一本 12 章的參考書：每章開頭寫明章號，結尾一句鉤子；裡面有專有名詞「玄天宗」。 */
const BOOK = Array.from({ length: 12 }, (_, i) => `第${i + 1}章 第${i + 1}個標題\n第${i + 1}章開頭，玄天宗的鐘響了。\n${'風吹過山崗。'.repeat(500)}\n第${i + 1}章結尾：門開了。`).join('\n');

function kindOf(messages) {
  const sys = messages[0]?.content ?? '';
  if (sys.includes('需要從一本**參考書**的樣章中歸納出一份「文風指南」')) return 'style';
  if (sys.includes('拆出它的「寫法」')) return 'skill';
  return '?';
}

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    reference: './src/core/features/reference.ts',
    skills: './src/core/skills/index.ts',
    db: './src/core/runtime/db.ts',
  });
  h = makeFakeHost({
    supportsVscodeLm: true,
    settings: () => ({
      providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
      models: ['p/m'],
      concurrency: 1,
      ...(contextDetail ? { contextDetail } : {}),
    }),
  });
  bundle.host.initHost(h.host);
  home = makeTempDir('referenceHome');
  bundle.skills.setUserSkillsDir(home.rel('skills'));
  fake = installFakeProvider(bundle.registry, {
    reply: (messages) => (kindOf(messages) === 'style' ? styleReply : skillBody),
  });
});

after(() => {
  bundle?.skills.setUserSkillsDir(undefined);
  if (home) fs.rmSync(home.dir, { recursive: true, force: true });
  for (const t of projects) cleanup(t.dir, bundle?.db);
});

async function fresh(prefix) {
  const t = await makeTempProject(bundle.project, { prefix, title: '學寫法測試' });
  projects.push(t);
  t.write('參考/玄天錄.txt', BOOK);
  t.project.invalidate();
  fake.reset();
  return t;
}

/** 工程裡所有檔案的內容拼起來（不含參考書本身）：看原文有沒有漏進來。 */
function allProjectText(t) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (!abs.endsWith('玄天錄.txt') && !abs.endsWith('.db')) out.push(fs.readFileSync(abs, 'utf8'));
    }
  };
  walk(t.dir);
  return out.join('\n');
}

describe('從參考書學寫法 · 兩樣都學', () => {
  let t;
  let r;
  before(async () => {
    t = await fresh('ref-both');
    // 選書 → 兩樣都學 → 開始 → 綁到規劃
    h.expect('參考/玄天錄.txt', 'both', '開始學', '綁到規劃');
    r = await bundle.reference.learnFromReference(t.project);
  });

  test('確認框報次數、抽哪幾章、寫到哪', () => {
    const c = h.confirms[0];
    assert.equal(c.message, '從《玄天錄》學文風與寫法，預計 2 次呼叫。現在開始？');
    assert.deepEqual(c.actions, ['開始學']);
    assert.match(c.detail, /認出 12 章/);
    assert.match(c.detail, /看第 1、4、7、9、12 章（首尾與中間均勻抽）/);
    assert.match(c.detail, /看第 1、2、3、4、5、6 章（開篇與全書 30% 處/);
    assert.match(c.detail, /\.novelwarden\/skills\/玄天錄-寫法\/SKILL\.md/);
    assert.match(c.detail, /原文不寫進工程的任何檔案/);
  });

  test('兩次呼叫：文風帶任務邊界、寫法帶篇幅統計與章節結尾', () => {
    assert.equal(r.calls, 2);
    assert.deepEqual(fake.calls.map(kindOf), ['style', 'skill']);
    const [style, skill] = fake.calls;
    assert.match(style[0].content, /禁止複述樣章的具體情節、角色名、地點名/);
    assert.match(style[1].content, /【樣章：第 1 章】\n第1章開頭/);
    assert.match(style[1].content, /（後略 \d+ 字）/);
    assert.match(skill[0].content, /不要提到工具、指令碼、檔案或附件/);
    assert.match(skill[1].content, /# 參考書的篇幅統計（程式數的）/);
    assert.match(skill[1].content, /全書 12 章/);
    assert.match(skill[1].content, /第3章結尾：門開了/);
  });

  test('文風寫進 style.md', () => {
    assert.equal(r.style, '.novelwarden/style.md');
    assert.match(t.read('.novelwarden/style.md'), /第三人稱限知/);
  });

  test('寫法寫成本工程的技能：stage 是規劃、相容；作者點了才綁', async () => {
    assert.deepEqual(r.skill, { id: 'project:玄天錄-寫法', relPath: '.novelwarden/skills/玄天錄-寫法/SKILL.md', bound: true });
    const raw = t.read('.novelwarden/skills/玄天錄-寫法/SKILL.md');
    assert.match(raw, /^---\nname: 玄天錄-寫法\ndisplay_name: 《玄天錄》的寫法\n/);
    assert.match(raw, /stage: planning/);
    assert.match(raw, /每章兩到三個場景/);
    const skill = await bundle.skills.loadSkill('project:玄天錄-寫法', t.project);
    assert.equal(skill.inspection.compatible, true);
    const { bindings } = await bundle.skills.readSkillBindings(t.project);
    assert.equal(bindings.planning, 'project:玄天錄-寫法');
    assert.match(h.confirms[1].message, /把「《玄天錄》的寫法」綁到「規劃（架構 \/ 大綱 \/ 細綱）」階段嗎？/);
  });

  test('原文不進工程', () => {
    const all = allProjectText(t);
    assert.ok(!all.includes('玄天宗的鐘響了'));
    assert.ok(!all.includes('風吹過山崗。風吹過山崗。'));
  });
});

describe('從參考書學寫法 · 邊角', () => {
  test('只學文風：1 次呼叫，不寫技能；style.md 有內容時按鈕寫明會覆蓋', async () => {
    const t = await fresh('ref-style');
    t.write('.novelwarden/style.md', '# 文風指南\n\n作者自己調過的文風。\n');
    t.project.invalidate();
    h.expect('參考/玄天錄.txt', 'style', '覆蓋 style.md 並開始');
    const r = await bundle.reference.learnFromReference(t.project);
    assert.deepEqual(h.confirms[0].actions, ['覆蓋 style.md 並開始']);
    assert.match(h.confirms[0].detail, /它已經有內容，會被覆蓋/);
    assert.equal(r.calls, 1);
    assert.equal(r.skill, undefined);
    assert.match(t.read('.novelwarden/style.md'), /第三人稱限知/);
    assert.ok(!t.has('.novelwarden/skills'));
  });

  test('文風抽幾章按上下文詳細度：「精簡」3 章、「完整」8 章', async () => {
    const shown = async (detail) => {
      contextDetail = detail;
      const t = await fresh(`ref-detail-${detail}`);
      h.expect('參考/玄天錄.txt', 'style', undefined);
      await bundle.reference.learnFromReference(t.project);
      contextDetail = undefined;
      const m = /文風：看第 ([\d、]+) 章/.exec(h.confirms[0].detail);
      assert.ok(m, h.confirms[0].detail);
      return m[1].split('、').length;
    };
    assert.equal(await shown(1), 3);
    assert.equal(await shown(4), 8);
    assert.equal(fake.callCount(), 0);
  });

  test('作者在確認框取消：一次都不調、什麼都不寫', async () => {
    const t = await fresh('ref-cancel');
    h.expect('參考/玄天錄.txt', 'both', undefined);
    const r = await bundle.reference.learnFromReference(t.project);
    assert.equal(r.calls, 0);
    assert.equal(fake.callCount(), 0);
    assert.ok(!t.has('.novelwarden/skills'));
  });

  test('同名技能已在：加字尾，不覆蓋', async () => {
    const t = await fresh('ref-taken');
    t.write('.novelwarden/skills/玄天錄-寫法/SKILL.md', '---\nname: 玄天錄-寫法\n---\n作者的舊版。\n');
    t.project.invalidate();
    h.expect('參考/玄天錄.txt', 'skill', '開始學', undefined);
    const r = await bundle.reference.learnFromReference(t.project);
    assert.equal(r.skill.id, 'project:玄天錄-寫法-2');
    assert.equal(r.skill.bound, false);
    assert.match(t.read('.novelwarden/skills/玄天錄-寫法/SKILL.md'), /作者的舊版/);
  });

  test('技能正文不相容：不問繫結，說清為什麼', async () => {
    const t = await fresh('ref-incompat');
    const saved = skillBody;
    skillBody = sections(SKILL_HEADS, '每次規劃前先呼叫 outline 工具檢查結構。');
    try {
      h.expect('參考/玄天錄.txt', 'skill', '開始學');
      const r = await bundle.reference.learnFromReference(t.project);
      assert.equal(r.skill.bound, false);
      assert.equal(h.confirms.length, 1);
      assert.ok(h.toasts.some((x) => x.startsWith('error:') && x.includes('不相容')), h.toasts.join('|'));
    } finally {
      skillBody = saved;
    }
  });

  test('寫法每次都寫到一半就停：重問用完後不寫技能、不問繫結，報出缺了哪幾節；文風照常寫', async () => {
    const t = await fresh('ref-cut');
    skillBody = '## 章節結構\n\n- **結尾停靠**：\n  1. 視覺峰值\n  2. 規則';
    try {
      h.expect('參考/玄天錄.txt', 'both', '開始學');
      const r = await bundle.reference.learnFromReference(t.project);
      // 文風 1 次 + 寫法 1 次再重問 2 次
      assert.equal(r.calls, 4);
      assert.equal(fake.callCount(), 4);
      assert.equal(r.skill, undefined);
      assert.equal(r.style, '.novelwarden/style.md');
      assert.ok(!t.has('.novelwarden/skills'));
      assert.equal(h.confirms.length, 1);
      assert.ok(
        h.toasts.some((x) => x.startsWith('error:') && x.includes('寫法沒學成') && x.includes('缺了「場景推進」')),
        h.toasts.join('|')
      );
    } finally {
      skillBody = SKILL_FULL;
    }
  });

  test('上游報撞到輸出上限：小節齊全也不寫 style.md', async () => {
    const t = await fresh('ref-maxtokens');
    t.write('.novelwarden/style.md', '# 文風指南\n\n作者自己調過的文風。\n');
    t.project.invalidate();
    styleReply = { text: STYLE_FULL, stop: 'maxTokens' };
    try {
      h.expect('參考/玄天錄.txt', 'style', '覆蓋 style.md 並開始');
      const r = await bundle.reference.learnFromReference(t.project);
      assert.equal(r.style, undefined);
      assert.match(t.read('.novelwarden/style.md'), /作者自己調過的文風/);
      assert.ok(h.toasts.some((x) => x.startsWith('error:') && x.includes('輸出上限')), h.toasts.join('|'));
    } finally {
      styleReply = STYLE_FULL;
    }
  });

  test('宿主能選本機檔案：工程外的 txt 照樣能學，確認框寫絕對路徑，原文不進工程', async () => {
    const t = await fresh('ref-host');
    const outside = makeTempDir('referenceBook');
    fs.writeFileSync(outside.rel('外面的書.txt'), BOOK);
    const asked = [];
    h.host.pickHostFile = async (opts) => {
      asked.push(opts);
      return outside.rel('外面的書.txt');
    };
    try {
      h.expect('style', '開始學');
      const r = await bundle.reference.learnFromReference(t.project);
      assert.equal(asked.length, 1);
      assert.deepEqual(asked[0].extensions, ['txt']);
      assert.equal(asked[0].startDir, t.project.root);
      assert.equal(r.calls, 1);
      assert.equal(h.confirms[0].message, '從《外面的書》學文風，預計 1 次呼叫。現在開始？');
      assert.ok(h.confirms[0].detail.includes(`檔案：${outside.rel('外面的書.txt')}`), h.confirms[0].detail);
      assert.ok(!allProjectText(t).includes('玄天宗的鐘響了'));
    } finally {
      delete h.host.pickHostFile;
      fs.rmSync(outside.dir, { recursive: true, force: true });
    }
  });

  test('作者在本機選擇器裡取消：一次都不調', async () => {
    const t = await fresh('ref-host-cancel');
    h.host.pickHostFile = async () => undefined;
    const before = h.confirms.length;
    try {
      const r = await bundle.reference.learnFromReference(t.project);
      assert.equal(r.calls, 0);
      assert.equal(h.confirms.length, before);
    } finally {
      delete h.host.pickHostFile;
    }
  });

  test('MCP 給的路徑只認工程裡的：工程外的絕對路徑拒絕，不彈選擇器', async () => {
    const t = await fresh('ref-mcp-abs');
    const outside = makeTempDir('referenceMcp');
    fs.writeFileSync(outside.rel('外面的書.txt'), BOOK);
    let opened = false;
    h.host.pickHostFile = async () => {
      opened = true;
      return undefined;
    };
    try {
      await assert.rejects(bundle.reference.learnFromReference(t.project, { path: outside.rel('外面的書.txt') }), /不是工程裡能拆的 txt/);
      assert.equal(opened, false);
    } finally {
      delete h.host.pickHostFile;
      fs.rmSync(outside.dir, { recursive: true, force: true });
    }
  });

  test('認不出章節標題的書按字數切段', async () => {
    const t = await fresh('ref-bysize');
    t.write('參考/散文.txt', Array.from({ length: 6 }, (_, i) => `第${i}段${'字'.repeat(3000)}。`).join('\n'));
    t.project.invalidate();
    h.expect('參考/散文.txt', 'style', '開始學');
    await bundle.reference.learnFromReference(t.project);
    assert.match(h.confirms[0].detail, /認不出章節標題，按約 3000 字一段切成 6 段/);
    assert.match(h.confirms[0].detail, /段（首尾與中間均勻抽）/);
  });
});
