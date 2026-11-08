/**
 * 拆書的純函式（model/importText.ts）：解碼、認標題、切章、抽樣、寫法技能的名字。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 沒有 BOM、又不是合法 UTF-8 的按 GB18030 解 | 中文 txt 小說一大半是 GBK |
 * | 「第三回合」「第二節課」不是標題，「第三回 夜奔」是 | 回 / 節在正文裡太常見 |
 * | 以句號收尾、超長的行不是標題 | 正文裡「第一章寫完那天」這種行 |
 * | 卷標題丟掉、目錄裡那串空標題跳過、第一個標題前的簡介不匯入 | 不能憑空多出幾十個空章 |
 * | 一個標題都認不出時章為空 | 呼叫方據此拒絕匯入，不把整本當一章 |
 * | 技能名只含字母數字與 `._-`，撞名加字尾 | 與 isSkillName 同一條規則，寫盤不越界 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const m = loadModule('src/core/model/importText.ts');
const skills = loadModule('src/core/model/writingSkill.ts');

describe('importText · 解碼', () => {
  test('UTF-8 照讀、BOM 去掉、換行統一', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from('第一章 雪夜\r\n正文\r\n')]);
    const r = m.decodeTextBytes(bytes);
    assert.equal(r.encoding, 'utf-8');
    assert.equal(r.text, '第一章 雪夜\n正文\n');
  });

  test('不是合法 UTF-8 的按 GB18030 解', () => {
    // 「你好」的 GBK 編碼
    const r = m.decodeTextBytes(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]));
    assert.equal(r.encoding, 'gb18030');
    assert.equal(r.text, '你好');
  });

  test('UTF-16 認 BOM', () => {
    const body = Buffer.from('楔子', 'utf16le');
    const r = m.decodeTextBytes(new Uint8Array([0xff, 0xfe, ...body]));
    assert.equal(r.encoding, 'utf-16le');
    assert.equal(r.text, '楔子');
  });

  test('decodeFileText：UTF-8 原樣（換行不動），GBK 解成中文', () => {
    assert.equal(m.decodeFileText(Buffer.from('第一行\r\n第二行', 'utf8')), '第一行\r\n第二行');
    assert.equal(m.decodeFileText(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3, 0x0d, 0x0a])), '你好\n');
  });
});

describe('importText · 認標題', () => {
  const chapter = (line) => m.classifyHeading(line);

  test('第X章：中文與阿拉伯數字、帶不帶分隔符、帶 # 都認', () => {
    assert.deepEqual(chapter('第一章 風起青萍'), { kind: 'chapter', title: '風起青萍' });
    assert.deepEqual(chapter('第12章：雪夜'), { kind: 'chapter', title: '雪夜' });
    assert.deepEqual(chapter('　　第一百零三章 夜奔'), { kind: 'chapter', title: '夜奔' });
    assert.deepEqual(chapter('## 第 3 章 舊賬'), { kind: 'chapter', title: '舊賬' });
    assert.deepEqual(chapter('第一章'), { kind: 'chapter', title: '' });
    assert.deepEqual(chapter('Chapter 7: The Snow'), { kind: 'chapter', title: 'The Snow' });
  });

  test('回 / 節要跟分隔符或行尾', () => {
    assert.deepEqual(chapter('第三回 夜奔'), { kind: 'chapter', title: '夜奔' });
    assert.deepEqual(chapter('第二節'), { kind: 'chapter', title: '' });
    assert.equal(chapter('第三回合他輸了'), undefined);
    assert.equal(chapter('第二節課下課'), undefined);
  });

  test('序章、楔子、番外算章，標題照原樣', () => {
    assert.deepEqual(chapter('楔子'), { kind: 'chapter', title: '楔子' });
    assert.deepEqual(chapter('番外篇 舊事'), { kind: 'chapter', title: '番外篇 舊事' });
  });

  test('卷標題認出來但不算章', () => {
    assert.equal(chapter('第一卷 少年遊').kind, 'volume');
    assert.equal(chapter('第二部').kind, 'volume');
  });

  test('句末標點收尾、超長的行是正文', () => {
    assert.equal(chapter('第一章寫完的那天，他去了城外。'), undefined);
    assert.equal(chapter(`第一章${'很'.repeat(60)}`), undefined);
    assert.equal(chapter('他說：「第一章」'), undefined);
  });
});

describe('importText · 切章', () => {
  const book = [
    '青雲劍錄',
    '作者：某某',
    '簡介：少年入宗。',
    '',
    '目錄',
    '第一章 入宗',
    '第二章 雪夜',
    '',
    '第一卷 少年遊',
    '第一章 入宗',
    '　　林昭站在山門前。',
    '',
    '　　“你來晚了。”沈青說。',
    '第二章 雪夜',
    '雪下了一夜。',
    '第二卷 江湖遠',
    '第三章',
    '天亮了。',
  ].join('\n');

  test('按標題切；正文一段一行、去掉行首全形空格', () => {
    const r = m.splitChapters(book);
    assert.deepEqual(
      r.chapters.map((c) => [c.title, c.heading]),
      [
        ['入宗', '第一章 入宗'],
        ['雪夜', '第二章 雪夜'],
        ['', '第三章'],
      ]
    );
    assert.equal(r.chapters[0].body, '林昭站在山門前。\n\n“你來晚了。”沈青說。');
    assert.ok(r.chapters[0].words > 0);
  });

  test('簡介不匯入、卷標題與目錄裡的空標題都記下來', () => {
    const r = m.splitChapters(book);
    assert.ok(r.preface.words > 0);
    assert.match(r.preface.head, /青雲劍錄/);
    assert.deepEqual(r.volumes, ['第一卷 少年遊', '第二卷 江湖遠']);
    assert.deepEqual(r.empty, ['第一章 入宗', '第二章 雪夜']);
  });

  test('一個標題都認不出：章為空，整本都算簡介', () => {
    const r = m.splitChapters('從前有座山。\n山裡有座廟。');
    assert.equal(r.chapters.length, 0);
    assert.ok(r.preface.words > 0);
  });

  test('沒有標題的書按字數切段', () => {
    const text = Array.from({ length: 10 }, (_, i) => `第${i}段${'字'.repeat(1000)}。`).join('\n');
    const parts = m.splitBySize(text, 3000);
    assert.ok(parts.length >= 3 && parts.length <= 4, String(parts.length));
    assert.equal(parts[0].title, '第 1 段');
    assert.ok(parts.every((p) => p.words > 0));
  });
});

describe('importText · 抽樣、節選與統計', () => {
  test('均勻抽樣首尾必在、不重複', () => {
    assert.deepEqual(m.evenSample(100, 5), [0, 25, 50, 74, 99]);
    assert.deepEqual(m.evenSample(3, 5), [0, 1, 2]);
    assert.deepEqual(m.evenSample(0, 5), []);
  });

  test('看結構：開頭三章 + 30% 處連續三章', () => {
    assert.deepEqual(m.structureSample(100), [0, 1, 2, 30, 31, 32]);
    assert.deepEqual(m.structureSample(4), [0, 1, 2, 3]);
  });

  test('頭尾節選寫明中間省略了幾個字', () => {
    const text = '甲'.repeat(10) + '乙'.repeat(10) + '丙'.repeat(10);
    assert.equal(m.headTail(text, 10, 10), `${'甲'.repeat(10)}\n\n（中略 10 字）\n\n${'丙'.repeat(10)}`);
    assert.equal(m.headTail('短', 10, 10), '短');
    assert.match(m.headOf(text, 5), /（後略 25 字）$/);
  });

  test('篇幅統計：平均、中位數、對白佔比', () => {
    const s = m.shapeStats([
      { body: '“走。”他說。\n\n雪很大。', words: 1000 },
      { body: '天亮了。', words: 3000 },
      { body: '「好。」', words: 2000 },
    ]);
    assert.equal(s.chapters, 3);
    assert.equal(s.avgWords, 2000);
    assert.equal(s.medianWords, 2000);
    assert.equal(s.dialoguePercent, 50);
  });

  test('規模預設：平均字數取整到百，總章數兩倍取整到 50', () => {
    assert.equal(m.roundedAverageWords([2960, 3040, 0]), 3000);
    assert.equal(m.roundedAverageWords([]), undefined);
    assert.equal(m.defaultTotalChapters(30), 100);
    assert.equal(m.defaultTotalChapters(120), 250);
  });
});

describe('importText · 寫法技能', () => {
  test('名字合規、撞名加字尾', () => {
    const name = m.referenceSkillName('詭秘之主 (精校版)', new Set());
    assert.equal(name, '詭秘之主-精校版-寫法');
    assert.ok(skills.isSkillName(name));
    assert.equal(m.referenceSkillName('詭秘之主 (精校版)', new Set([name])), `${name}-2`);
    assert.equal(m.referenceSkillName('###', new Set()), '參考書-寫法');
    assert.ok(skills.isSkillName(m.referenceSkillName('長'.repeat(100), new Set())));
  });

  test('渲染出來的 SKILL.md 讀得回來、階段是規劃、是相容的', () => {
    const raw = m.renderReferenceSkill({ name: '青雲劍錄-寫法', bookTitle: '青雲劍錄', body: '## 章節結構\n\n每章兩到三個場景。' });
    const i = skills.inspectSkillMarkdown(raw, '青雲劍錄-寫法');
    assert.equal(i.name, '青雲劍錄-寫法');
    assert.equal(i.displayName, '《青雲劍錄》的寫法');
    assert.equal(i.stage, 'planning');
    assert.equal(i.compatible, true);
    assert.match(i.body, /每章兩到三個場景/);
  });
});
