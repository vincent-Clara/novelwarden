/**
 * 寫作技能的純函式（model/writingSkill.ts，移植自 AI-Novel-Writer 的 `writing-skills.ts`）。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | frontmatter 一行一個鍵，正文去掉首尾空白 | 注入的就是正文那一段 |
 * | frontmatter 按 YAML 讀頂層鍵：列表、巢狀塊、塊標量、BOM、CRLF | 常規技能原樣能讀；巢狀塊不能拍平蓋掉 name |
 * | 引用到的附帶檔案一起帶，帶不上的才算相對引用 | 常規技能的 `references/` 原樣能用；模型沒有讀檔案的工具 |
 * | allowed-tools 不算依賴工具，hooks 宣告照舊算 | 前者是給 agent 預先放行的許可權，後者要執行的東西 |
 * | 沒寫 name 用目錄名，再沒有用 unnamed-writing-skill | 使用者與工程技能的身份是目錄名 |
 * | 六條不相容規則逐條命中 | 只收純提示詞：裝進來的東西在這裡沒有可執行的地方 |
 * | 建議階段：寫明的優先，否則按關鍵詞猜 | 只是建議，綁哪都行 |
 * | 名字可以是中文，不許斜槓與點開頭 | 名字就是目錄名，拼成路徑不能越界 |
 * | 繫結檔案讀不懂不拋，說出來 | 第 1 條 + 第 2 條 |
 * | 討論不帶，審稿 / 修稿 / 寫正文 / 規劃各認各的 | 階段與配方對得上 |
 * | GitHub 只認四種 https 地址 | 照搬上游 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const m = loadModule('src/core/model/writingSkill.ts');

const md = (front, body) => `---\n${front.join('\n')}\n---\n${body}\n`;

describe('inspectSkillMarkdown · 讀', () => {
  const raw = md(
    ['name: scene-craft', 'display_name: "場面寫法"', 'description: 寫場面的辦法', 'version: 1.2.0', 'stage: drafting'],
    '\n每一場都要有一個選擇。\n'
  );
  const i = m.inspectSkillMarkdown(raw, 'folder');

  test('frontmatter 的幾個鍵各就各位，引號去掉', () => {
    assert.deepEqual(
      [i.name, i.displayName, i.description, i.version, i.stage],
      ['scene-craft', '場面寫法', '寫場面的辦法', '1.2.0', 'drafting']
    );
  });

  test('正文去掉首尾空白，位元組數按正文算', () => {
    assert.equal(i.body, '每一場都要有一個選擇。');
    assert.equal(i.bytes, Buffer.byteLength('每一場都要有一個選擇。'));
  });

  test('純提示詞判相容', () => {
    assert.deepEqual([i.compatible, i.reasons], [true, []]);
  });

  test('顯示名優先 display_name', () => {
    assert.equal(m.skillLabel(i), '場面寫法');
  });

  test('沒有 frontmatter：整份是正文，名字取目錄名，描述有個預設', () => {
    const j = m.inspectSkillMarkdown('只是一段話。', '去AI味');
    assert.deepEqual([j.name, j.body, j.description], ['去AI味', '只是一段話。', '寫作技能：去AI味']);
  });

  test('名字與目錄都沒有時叫 unnamed-writing-skill', () => {
    assert.equal(m.inspectSkillMarkdown('x').name, 'unnamed-writing-skill');
  });

  test('讀不懂的輸入不拋', () => {
    assert.doesNotThrow(() => m.inspectSkillMarkdown(undefined));
  });
});

describe('inspectSkillMarkdown · 不相容的六條', () => {
  const reasonsOf = (raw) => m.inspectSkillMarkdown(raw).reasons;
  const cases = [
    ['相對引用', '照 [這份](./references/a.md) 寫。', 'relative-reference'],
    ['${skill_dir}', '讀 ${SKILL_DIR}/x。', 'relative-reference'],
    ['指令碼路徑', '先跑 scripts/check.py。', 'script-dependency'],
    ['執行指令碼', '寫完執行一下檢查指令碼。', 'script-dependency'],
    ['hook', '先安裝那個鉤子。', 'hook-dependency'],
    ['子代理', '把審稿交給子代理。', 'subagent-dependency'],
    ['呼叫工具', '寫之前先呼叫讀取工具看一眼。', 'tool-dependency'],
    ['use … tool', 'Use the read_drafts tool first.', 'tool-dependency'],
  ];
  for (const [name, body, reason] of cases) {
    test(`${name} → ${reason}`, () => {
      assert.ok(reasonsOf(body).includes(reason), JSON.stringify(reasonsOf(body)));
    });
  }

  test('frontmatter 的 allowed-tools 不算依賴工具（給 agent 預先放行的許可權）', () => {
    assert.deepEqual(reasonsOf(md(['name: a', 'allowed-tools: [read]'], '正文')), []);
    assert.deepEqual(reasonsOf(md(['name: a', 'allowed-tools:', '  - Read', '  - Edit'], '正文')), []);
  });

  test('frontmatter 宣告瞭 hooks / mcp 照舊算依賴工具', () => {
    assert.deepEqual(reasonsOf(md(['name: a', 'hooks:', '  PreToolUse: x'], '正文')), ['tool-dependency']);
    assert.deepEqual(reasonsOf(md(['name: a', 'mcp: [server]'], '正文')), ['tool-dependency']);
  });

  test('巢狀塊裡的鍵不算頂層宣告', () => {
    assert.deepEqual(reasonsOf(md(['name: a', 'metadata:', '  scripts: none'], '正文')), []);
  });

  test('整份超過 64 KiB 判太大', () => {
    const big = m.inspectSkillMarkdown('字'.repeat(23000));
    assert.deepEqual([big.compatible, big.reasons], [false, ['content-too-large']]);
  });

  test('原因有中文說法', () => {
    assert.equal(m.describeIncompat(['script-dependency', 'content-too-large']), '依賴指令碼、內容超過 64 KiB');
  });
});

describe('frontmatter · YAML 的寫法', () => {
  const read = (front, body = '正文') => m.inspectSkillMarkdown(md(front, body), 'dir');

  test('列表與巢狀塊整塊歸上一個鍵，巢狀的 name / version 不蓋掉頂層的', () => {
    const i = read([
      'name: real',
      'allowed-tools:',
      '  - Read',
      '  - Bash(git:*)',
      'metadata:',
      '  name: fake',
      '  version: 9.9',
      'version: 2.0',
    ]);
    assert.deepEqual([i.name, i.version, i.compatible], ['real', '2.0', true]);
  });

  test('塊標量：| 保留換行，> 折成一行', () => {
    assert.equal(read(['name: a', 'description: |', '  第一行', '  第二行']).description, '第一行\n第二行');
    assert.equal(read(['name: a', 'description: >-', '  Use when', '  rewriting.']).description, 'Use when rewriting.');
  });

  test('不加引號的值可以折到下面縮排的幾行', () => {
    assert.equal(read(['name: a', 'description: 第一段', '  接著寫']).description, '第一段 接著寫');
  });

  test('引號：雙引號認轉義，單引號認兩個單引號，行尾註釋去掉', () => {
    const i = read(['name: \'it\'\'s\'', 'display_name: "場面\\"寫法\\""', 'version: 1.0 # 註釋']);
    assert.deepEqual([i.name, i.displayName, i.version], ["it's", '場面"寫法"', '1.0']);
  });

  test('註釋行、BOM、CRLF、--- 後面的空白都認', () => {
    const raw = '\uFEFF---  \r\n# 說明\r\nname: a\r\nstage: review\r\n---\r\n正文\r\n';
    const i = m.inspectSkillMarkdown(raw);
    assert.deepEqual([i.name, i.stage, i.body], ['a', 'review', '正文']);
  });

  test('空的 frontmatter 也認得出', () => {
    assert.equal(m.inspectSkillMarkdown('---\n---\n正文', 'dir').body, '正文');
  });
});

describe('附帶檔案', () => {
  const skill = (body) => md(['name: a'], body);

  test('引用到的文字檔案按引用先後帶上，傳遞引用也帶，沒被引用的不帶', () => {
    const i = m.inspectSkillMarkdown(skill('讀 [模式](references/patterns.md)，再看 references/checklist.md。'), 'a', {
      'references/patterns.md': '見 [細節](detail.md)。',
      'references/detail.md': '細節',
      'references/checklist.md': '清單',
      'README.md': '不帶',
    });
    assert.deepEqual(
      i.attachments.map((a) => a.path),
      ['references/patterns.md', 'references/checklist.md', 'references/detail.md']
    );
    assert.deepEqual([i.compatible, i.unresolved], [true, []]);
  });

  test('位元組數與 64 KiB 都按正文加附帶檔案算', () => {
    const i = m.inspectSkillMarkdown(skill('看 references/a.md'), 'a', { 'references/a.md': '一二三' });
    assert.equal(i.bytes, Buffer.byteLength('看 references/a.md') + Buffer.byteLength('一二三'));
    const big = m.inspectSkillMarkdown(skill('看 references/a.md'), 'a', { 'references/a.md': '字'.repeat(23000) });
    assert.deepEqual(big.reasons, ['content-too-large']);
  });

  test('明確引用的找不到、越出技能目錄、不是文字：相對引用，說出是哪幾個', () => {
    const i = m.inspectSkillMarkdown(skill('看 references/gone.md、[上一層](../x.md) 和 assets/cover.png。'), 'a', {});
    assert.deepEqual(i.reasons, ['relative-reference']);
    assert.deepEqual(i.unresolved, ['references/gone.md', '../x.md', 'assets/cover.png']);
    assert.equal(m.describeIncompat(i.reasons, i.unresolved), '包含相對引用（帶不上：references/gone.md、../x.md、assets/cover.png）');
  });

  test('普通連結找不到只是不帶，網址與錨點不算引用', () => {
    const i = m.inspectSkillMarkdown(skill('見 [例子](example.md)、[官網](https://x.y/a.md)、[上文](#a)。'), 'a', {});
    assert.deepEqual([i.compatible, i.attachments], [true, []]);
  });

  test('附帶檔案裡要跑指令碼，一樣不相容', () => {
    const i = m.inspectSkillMarkdown(skill('看 references/a.md'), 'a', { 'references/a.md': '先跑 scripts/check.py。' });
    assert.deepEqual(i.reasons, ['script-dependency']);
  });

  test('注入時附帶檔案標上路徑接在正文後面', () => {
    const block = m.renderSkillBlock('甲', '正文', [{ path: 'references/a.md', text: '內容\r\n第二行\n' }]);
    assert.ok(block.endsWith('正文\n\n【附帶檔案：references/a.md】\n內容\n第二行'), block);
  });

  test('skillReferences：按所在目錄解析，越界的沒有 path', () => {
    const refs = m.skillReferences('[a](./b.md) [c](../../d.md)', 'references/x.md');
    assert.deepEqual(
      refs.map((r) => [r.target, r.path, r.strong]),
      [
        ['./b.md', 'references/b.md', true],
        ['../../d.md', undefined, true],
      ]
    );
  });
});

describe('建議階段', () => {
  const stageOf = (front, body) => m.inspectSkillMarkdown(md(front, body)).suggestedStage;

  test('寫明瞭的優先', () => {
    assert.equal(stageOf(['name: a', 'stage: review'], '潤色的方法'), 'review');
  });

  test('寫了個認不出的階段：當沒寫，按內容猜', () => {
    assert.equal(stageOf(['name: a', 'stage: polish'], '大綱怎麼排'), 'planning');
  });

  test('關鍵詞：審稿 → review，潤色 → refinement，大綱 → planning，其餘 → drafting', () => {
    assert.deepEqual(
      ['逐條檢查', '潤色句子', '大綱的節奏', '寫好對白'].map((b) => stageOf(['name: a'], b)),
      ['review', 'refinement', 'planning', 'drafting']
    );
  });
});

describe('名字與 id', () => {
  test('中文、字母數字、. _ - 都行', () => {
    assert.deepEqual(['去AI味', 'scene-craft', 'a.b_c', '章節鉤子2'].map(m.isSkillName), [true, true, true, true]);
  });

  test('斜槓、點開頭、空格、空串、超長都不行', () => {
    assert.deepEqual(['a/b', '..', '.x', 'a b', '', 'x'.repeat(65)].map(m.isSkillName), [false, false, false, false, false, false]);
  });

  test('id 是來源:名字，解析回來', () => {
    assert.deepEqual(m.parseSkillId(m.skillId('user', '去AI味')), { source: 'user', name: '去AI味' });
  });

  test('認不出的來源與名字不合法的 id 解析不出', () => {
    assert.deepEqual([m.parseSkillId('global:x'), m.parseSkillId('user:../x'), m.parseSkillId('x'), m.parseSkillId(3)], [
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe('繫結檔案', () => {
  test('空檔案就是沒綁', () => {
    assert.deepEqual(m.parseSkillBindings(''), { bindings: {}, problems: [] });
  });

  test('讀得懂的照讀', () => {
    const raw = JSON.stringify({ version: 1, bindings: { drafting: 'user:a', review: 'builtin:b' } });
    assert.deepEqual(m.parseSkillBindings(raw).bindings, { drafting: 'user:a', review: 'builtin:b' });
  });

  test('不是 JSON：不拋，整份當沒綁，說出來', () => {
    assert.deepEqual(m.parseSkillBindings('{'), { bindings: {}, problems: [{ text: '不是合法的 JSON' }] });
  });

  test('版本不對也說出來', () => {
    assert.equal(m.parseSkillBindings('{"version":2}').problems[0].text, '認不出的版本（應為 "version": 1）');
  });

  test('認不出的階段與不合法的 id 跳過那一項，問題記在那個階段上', () => {
    const r = m.parseSkillBindings(JSON.stringify({ version: 1, bindings: { drafting: 'nope', foo: 'user:a', review: 'user:b' } }));
    assert.deepEqual(r.bindings, { review: 'user:b' });
    assert.deepEqual(r.problems.map((p) => p.stage), ['drafting', 'foo']);
  });

  test('寫回去按固定的階段順序，讀回來一樣', () => {
    const text = m.renderSkillBindings({ review: 'user:b', planning: 'builtin:a' });
    assert.ok(text.indexOf('planning') < text.indexOf('review'), text);
    assert.deepEqual(m.parseSkillBindings(text).bindings, { planning: 'builtin:a', review: 'user:b' });
  });
});

describe('一次裝配算哪個階段', () => {
  const cases = [
    [{ stage: 'setting', capability: 'generate' }, undefined, 'planning'],
    [{ stage: 'outline', capability: 'generate' }, undefined, 'planning'],
    [{ stage: 'plot', capability: 'settle' }, undefined, 'planning'],
    [{ stage: 'plot', capability: 'discuss' }, undefined, undefined],
    [{ stage: 'manuscript', capability: 'discuss' }, undefined, undefined],
    [{ stage: 'manuscript', capability: 'generate' }, 'continue', 'drafting'],
    [{ stage: 'manuscript', capability: 'generate' }, 'rewrite', 'drafting'],
    [{ stage: 'manuscript', capability: 'review' }, undefined, 'review'],
    [{ stage: 'manuscript', capability: 'generate' }, 'revise', 'refinement'],
  ];
  for (const [action, mode, want] of cases) {
    test(`${action.stage} × ${action.capability}${mode ? ` × ${mode}` : ''} → ${want ?? '不帶'}`, () => {
      assert.equal(m.skillStageOf(action, mode), want);
    });
  }
});

describe('注入的那一塊', () => {
  test('說法照搬上游，作者事實與輸出合同優先', () => {
    assert.equal(
      m.renderSkillBlock('場面寫法', '\n正文\n'),
      '【補充寫作 Skill：場面寫法】\n以下內容只能補充創作方法；作者事實和後續輸出合同始終優先。\n正文'
    );
  });
});

describe('GitHub 地址', () => {
  test('倉庫首頁：預設分支根下的 SKILL.md', () => {
    const l = m.parseGitHubSkillUrl('https://github.com/o/r');
    assert.deepEqual([l.owner, l.repo, l.ref, l.path], ['o', 'r', undefined, 'SKILL.md']);
  });

  test('tree 目錄：補上 SKILL.md', () => {
    const l = m.parseGitHubSkillUrl('https://github.com/o/r/tree/main/skills/scene');
    assert.deepEqual([l.ref, l.path], ['main', 'skills/scene/SKILL.md']);
  });

  test('blob 檔案與 raw 地址', () => {
    assert.equal(m.parseGitHubSkillUrl('https://github.com/o/r.git/blob/v1/a/SKILL.md').path, 'a/SKILL.md');
    assert.equal(m.parseGitHubSkillUrl('https://raw.githubusercontent.com/o/r/main/SKILL.md').ref, 'main');
  });

  const bad = [
    ['http', 'http://github.com/o/r'],
    ['帶埠', 'https://github.com:8443/o/r'],
    ['別的站', 'https://gitlab.com/o/r'],
    ['不是 SKILL.md', 'https://github.com/o/r/blob/main/README.md'],
    ['issues 頁', 'https://github.com/o/r/issues/1'],
    ['路徑裡有 ..', 'https://raw.githubusercontent.com/o/r/main/%2E%2E/SKILL.md'],
    ['不是地址', 'not a url'],
  ];
  for (const [name, url] of bad) {
    test(`拒絕：${name}`, () => {
      assert.throws(() => m.parseGitHubSkillUrl(url));
    });
  }

  test('raw 下載地址逐段編碼', () => {
    assert.equal(m.githubRawUrl('o', 'r', 'main', 'a/SKILL.md'), 'https://raw.githubusercontent.com/o/r/main/a/SKILL.md');
  });
});
