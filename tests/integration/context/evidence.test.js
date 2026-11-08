/**
 * 正文層的 `evidence` 層（四期，D18）：寫正文時不拿細綱當事實，拿定稿過的細綱裡連續性事實的
 * 證據原句回到前面各章的正文裡，帶那幾段原文。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 前 5 章的事實全取，更早的只取涉及本章角色的 | D18：近的都相關，遠的只有與本章的人有關的才相關 |
 * | 帶的是證據所在的那一段與前後各一段 | 原文才是作者認可的那一版 |
 * | 只認 sourceHash 對得上正文的細綱：定稿之後正文又改過的章不帶 | 證據句多半已不在原處，事實本身也可能正是改掉的那一處 |
 * | 定稿對得上、但某條證據定位不到的換成事實原句，標 degraded | 第 2 條：不靜默截斷 |
 * | 整章正文已經進來的章不再單獨帶片段 | 同一段原文帶兩遍只是貴 |
 * | 上一章沒定稿（或定稿之後正文又改過），明細裡說清 | D23：不擋路，但不靜默 |
 * | 一共 6000 字、最多 12 章，放不下的寫原因 | 上游 MATERIAL_BUDGET_CHARS；第 2 條 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

const WRITE = { stage: 'manuscript', capability: 'generate' };

const config = (extra = {}) => ({
  providers: [{ id: 'p', kind: 'openai', baseUrl: 'https://x/v1', models: [{ name: 'm' }] }],
  model: 'p/m',
  contextWindow: 128000,
  maxOutputTokens: 4096,
  temperature: 0.8,
  chaptersDir: 'chapters',
  draftsDir: 'drafts',
  summaryBatchSize: 15,
  requestTimeoutMs: 300000,
  ...extra,
});

const pad3 = (n) => String(n).padStart(3, '0');
const CH = (no) => `chapters/${pad3(no)}-第${no}章.md`;
const PLOT = (no) => `.novelwarden/summaries/${pad3(no)}-第${no}章.md`;

function chapterText(no, extra = '') {
  return [
    `# 第${no}章`,
    '',
    `第${no}章開頭，雨還在下。`,
    '',
    `林昭在第${no}章把第${no}塊令牌塞進懷裡。${extra}`,
    '',
    `沈氏在第${no}章鎖上了第${no}道門。`,
    '',
    `第${no}章結尾，風停了。`,
    '',
  ].join('\n');
}

/** 要寫的那一章的細綱（計劃）：計劃出場林昭。 */
function plotText(no) {
  return [
    '---',
    `no: ${no}`,
    `title: 第${no}章`,
    'targetWords: 1200',
    '---',
    '',
    `# 第${no}章 第${no}章`,
    '',
    '## 梗概',
    '',
    '往下查。',
    '',
    '## 出場人物',
    '',
    '林昭',
    '',
    '## 關鍵事件',
    '',
    '林昭去井邊。',
    '',
    '## 看點',
    '',
    '- 井底有人。',
    '',
  ].join('\n');
}

let bundle;
before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    builder: './src/core/context/builder.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost().host);
});

/** 建工程：第 1..n 章正文，`summarized` 裡的章寫定稿過的細綱（sourceHash 對得上），第 n+1 章排好細綱（計劃）。 */
async function setup(prefix, n, summarized, opts = {}) {
  const t = await makeTempProject(bundle.project, { prefix, title: '證據測試' });
  for (let no = 1; no <= n; no++) {
    t.write(CH(no), opts.text ? opts.text(no) : chapterText(no));
  }
  t.write(PLOT(n + 1), plotText(n + 1));
  t.write(
    '.novelwarden/characters/林昭.md',
    `---\nname: 林昭\naliases: [阿昭]\ntags: [主角]\nstateThrough: ${opts.stateThrough ?? 6}\n---\n\n# 林昭\n\n## 身份\n\n孤兒\n`
  );
  t.project.invalidate();
  const chapters = await t.project.listChapters();
  for (const no of summarized) {
    const ch = chapters.find((c) => c.order === no);
    const facts = opts.facts
      ? opts.facts(no)
      : [
          `- 林昭收起第${no}塊令牌 〔證據：「林昭在第${no}章把第${no}塊令牌塞進懷裡。」〕`,
          `- 沈氏鎖上第${no}道門 〔證據：「沈氏在第${no}章鎖上了第${no}道門。」〕`,
        ];
    t.write(
      PLOT(no),
      `---\nno: ${no}\ntitle: 第${no}章\nsourceHash: ${ch.contentHash}\ncast: [林昭, 沈氏]\n---\n\n# 第${no}章 第${no}章\n\n## 梗概\n\n第${no}章的事。\n\n## 出場人物\n\n林昭、沈氏\n\n## 連續性事實\n\n${facts.join('\n')}\n`
    );
  }
  t.project.invalidate();
  return t;
}

async function build(t, no, extra) {
  return bundle.builder.buildContext(
    t.project,
    { action: WRITE, target: { kind: 'manuscript', plotRelPath: PLOT(no) }, ask: '', targetWords: 1200 },
    config(extra)
  );
}

describe('evidence · 寫第 9 章（前 8 章寫過，第 8 章還沒定稿）', () => {
  let t;
  let b;
  let byId;

  before(async () => {
    t = await setup('evidence', 8, [1, 2, 3, 4, 5, 6, 7]);
    // 第 6 章定稿之後作者改了一句：細綱的 sourceHash 對不上正文了。
    t.write(CH(6), chapterText(6).replace('塞進懷裡', '揣進了懷裡'));
    // 第 5 章定稿對得上，但作者手改了細綱裡一條事實的證據句：這一條在正文裡定位不到。
    t.write(PLOT(5), t.read(PLOT(5)).replace('「林昭在第5章把第5塊令牌塞進懷裡。」', '「林昭在第5章把令牌揣好。」'));
    t.project.invalidate();
    b = await build(t, 9);
    byId = new Map(b.items.filter((i) => i.kind === 'evidence').map((i) => [i.id, i]));
  });
  after(() => cleanup(t.dir, bundle.db));

  test('前 5 章裡定過稿、對得上的都帶了；更早的也帶了（涉及本章角色林昭）', () => {
    for (const no of [1, 2, 3, 4, 5]) {
      assert.ok(['included', 'degraded'].includes(byId.get(`evidence:${no}`)?.status), `第 ${no} 章：${JSON.stringify(byId.get(`evidence:${no}`))}`);
    }
    assert.match(byId.get('evidence:5').note, /^2 條連續性事實/);
    assert.match(byId.get('evidence:3').note, /^1 條涉及本章角色的連續性事實/);
  });

  test('帶的是證據所在那一段與前後各一段', () => {
    const text = byId.get('evidence:4').text;
    assert.match(text, /林昭在第4章把第4塊令牌塞進懷裡/);
    assert.match(text, /第4章開頭/);
    assert.match(text, /第4章結尾/);
  });

  test('第 6 章定稿之後正文又改過：細綱的事實不作數，不帶它的片段', () => {
    assert.equal(byId.get('evidence:6'), undefined);
  });

  test('定稿對得上、但定位不到的那條換成事實原句，標 degraded 並寫明', () => {
    const e = byId.get('evidence:5');
    assert.equal(e.status, 'degraded');
    assert.match(e.note, /1 條證據在正文裡找不到.*換成事實原句/);
    assert.match(e.text, /- 林昭收起第5塊令牌/);
    assert.match(e.text, /沈氏在第5章鎖上了第5道門/);
  });

  test('第 7 章的整章正文進來了：它的片段不再單獨帶', () => {
    const e = byId.get('evidence:7');
    assert.equal(e.status, 'dropped');
    assert.match(e.note, /整章正文已完整注入/);
    assert.ok(b.items.some((i) => i.id === 'manuscriptFull:7' && i.status === 'included'));
  });

  test('D23：第 8 章還沒定稿，明細裡寫明，角色狀態截至第幾章', () => {
    const e = byId.get('evidence:8');
    assert.equal(e.status, 'dropped');
    assert.equal(e.note, '第 8 章還沒同步：沒有連續性事實，角色狀態截至第 6 章');
  });

  test('角色卡的說明帶「狀態截至第 K 章」', () => {
    const card = b.items.find((i) => i.id === 'character:林昭');
    assert.match(card.note, /狀態截至第 6 章/);
  });

  test('訊息裡一節，按章號正序', () => {
    const user = b.messages[b.messages.length - 1].content;
    const at = user.indexOf('# 定稿原文片段');
    assert.ok(at > 0);
    const section = user.slice(at, user.indexOf('\n---\n', at));
    assert.ok(section.indexOf('【第 1 章') < section.indexOf('【第 5 章'), section.slice(0, 400));
  });

  test('續寫那幾輪不帶這一層', async () => {
    const c = await bundle.builder.buildContext(
      t.project,
      {
        action: WRITE,
        target: { kind: 'manuscript', plotRelPath: PLOT(9) },
        ask: '',
        targetWords: 1200,
        step: { kind: 'continuation', tail: '已寫的末尾', written: 600, remaining: 600, recovery: false },
      },
      config()
    );
    assert.ok(!c.items.some((i) => i.kind === 'evidence'));
  });
});

describe('evidence · 上一章定稿之後正文又改過', () => {
  let t;
  let b;
  before(async () => {
    t = await setup('evidence-stale-prev', 8, [1, 2, 3, 4, 5, 6, 7, 8]);
    t.write(CH(8), chapterText(8, '他回頭看了一眼。'));
    t.project.invalidate();
    b = await build(t, 9);
  });
  after(() => cleanup(t.dir, bundle.db));

  test('D23：明細裡寫明事實不作數，角色狀態截至第幾章', () => {
    const e = b.items.find((i) => i.id === 'evidence:8');
    assert.equal(e.status, 'dropped');
    assert.equal(e.note, '第 8 章同步之後正文又改過：連續性事實不作數，角色狀態截至第 6 章');
  });
});

describe('evidence · 更早的章只取涉及本章角色的事實', () => {
  let t;
  let b;
  before(async () => {
    t = await setup('evidence-names', 8, [1, 2, 3, 4, 5, 6, 7, 8], {
      facts: (no) => (no <= 3 ? [`- 沈氏鎖上第${no}道門 〔證據：「沈氏在第${no}章鎖上了第${no}道門。」〕`] : [`- 林昭收起第${no}塊令牌 〔證據：「林昭在第${no}章把第${no}塊令牌塞進懷裡。」〕`]),
    });
    b = await build(t, 9, { contextOverrides: { fullTextChapters: 0 } });
  });
  after(() => cleanup(t.dir, bundle.db));

  test('第 1–3 章的事實只關於沈氏：不帶；第 4–8 章全帶', () => {
    const nos = b.items.filter((i) => i.kind === 'evidence' && i.status === 'included').map((i) => Number(i.id.split(':')[1]));
    assert.deepEqual(nos.sort((x, y) => x - y), [4, 5, 6, 7, 8]);
  });

  // 順手修掉的老問題：`slice(-0)` 等於 `slice(0)`，設成 0 反而把前面每一章都整章塞進來。
  test('「注入完整原文章數」設成 0：一章全文都不帶', () => {
    assert.deepEqual(b.items.filter((i) => i.kind === 'manuscriptFull'), []);
  });
});

describe('evidence · 一共 6000 字、最多 12 章', () => {
  test('放不下的章 dropped，寫明是封頂了', async () => {
    const long = '長'.repeat(700);
    const t = await setup('evidence-cap', 8, [1, 2, 3, 4, 5, 6, 7, 8], {
      text: (no) => chapterText(no).replace('開頭，雨還在下。', `開頭，${long}`).replace('結尾，風停了。', `結尾，${long}`),
    });
    const b = await build(t, 9, { contextOverrides: { fullTextChapters: 0 } });
    const ev = b.items.filter((i) => i.kind === 'evidence');
    const kept = ev.filter((i) => i.status === 'included');
    assert.ok(kept.length >= 2 && kept.length < 8, JSON.stringify(ev.map((i) => [i.id, i.status])));
    assert.ok(kept.reduce((sum, i) => sum + i.text.length, 0) <= 6000);
    const dropped = ev.filter((i) => i.status === 'dropped');
    assert.ok(dropped.length > 0);
    assert.match(dropped[0].note, /一共只帶 6000 字/);
    cleanup(t.dir, bundle.db);
  });

  test('最多從 12 章裡取', async () => {
    const t = await setup('evidence-twelve', 19, Array.from({ length: 19 }, (_, i) => i + 1));
    const b = await build(t, 20, { contextOverrides: { fullTextChapters: 0 } });
    const nos = b.items.filter((i) => i.kind === 'evidence' && i.status === 'included').map((i) => Number(i.id.split(':')[1]));
    assert.equal(nos.length, 12);
    assert.equal(Math.min(...nos), 8);
    cleanup(t.dir, bundle.db);
  });
});
