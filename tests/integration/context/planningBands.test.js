/**
 * 規劃時的前情分三段（docs/design/plans/2026-10-22-planning-context-bands.md）：續寫大綱、拆細綱不再隨章數漲。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 續寫大綱：最近 10 章整條，再往前一章一行最多 `outlineBriefMax` 章，更早的不逐章列 | 從前更早的一章不落地全列、還強制帶，七八百章撐爆視窗 |
 * | 明細說清更早的看全文大綱、全文大綱寫到哪、沒有全文大綱時照實說 | 第 2 條：不靜默截斷 |
 * | 全文大綱在大綱、細綱兩張配方里是 P1 | 遠段靠它接住 |
 * | 一章一行的那一段放不下從最老的丟起，條目標 degraded、寫明哪幾章沒帶 | 第 4 級不封頂也不會超長 |
 * | 拆細綱：大綱只帶這一批與前面還沒拆的空殼，前面拆過的交給前序細綱一覽 | 同一份細綱不帶兩遍 |
 * | 前序細綱一覽放不下從最老的丟起，不整份丟 | 同上 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

const N = 150;
const pad3 = (n) => String(n).padStart(3, '0');
const PLOT = (no) => `.novelwarden/summaries/${pad3(no)}-第${no}章.md`;

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

/** 拆過的細綱（有關鍵事件）；`stub` 是大綱排到了、還沒拆的空殼（只有梗概）。 */
function plotText(no, stub = false) {
  return [
    '---',
    `no: ${no}`,
    `title: 第${no}章`,
    '---',
    '',
    `# 第${no}章 第${no}章`,
    '',
    '## 梗概',
    '',
    `林昭在第${no}章查到第${no}條線索。`,
    ...(stub ? [] : ['', '## 關鍵事件', '', `- 林昭在第${no}章去井邊。`]),
    '',
  ].join('\n');
}

const OUTLINE = { action: { stage: 'outline', capability: 'generate' }, target: { kind: 'outline' }, ask: '', range: { from: 151, to: 170 } };
const BATCH = { action: { stage: 'plot', capability: 'generate' }, target: { kind: 'plot', plotRelPath: PLOT(151) }, ask: '', range: { from: 151, to: 155 } };

let bundle;
before(() => {
  bundle = loadBundle({ host: './src/core/host.ts', project: './src/core/model/project.ts', builder: './src/core/context/builder.ts' });
  bundle.host.initHost(makeFakeHost().host);
});

/**
 * 第 1–150 章拆過細綱（第 148 章是還沒拆的空殼），第 151–170 章是空殼；`summaryThrough` 給了就寫一份全文大綱、
 * 記它寫到第幾章。
 */
async function setup(summaryThrough) {
  const t = await makeTempProject(bundle.project, { prefix: 'planningBands', title: '分三段' });
  for (let no = 1; no <= 170; no++) {
    t.write(PLOT(no), plotText(no, no === 148 || no > N));
  }
  if (summaryThrough !== undefined) {
    t.write('.novelwarden/summaries/global.md', `# 全文大綱\n\n## 主線進展\n\n${'林昭一路追查令牌的來歷。'.repeat(20)}\n`);
    const manifest = JSON.parse(t.read('.novelwarden/project.json'));
    t.write('.novelwarden/project.json', JSON.stringify({ ...manifest, globalSummaryThrough: summaryThrough }, null, 2));
  }
  t.project.invalidate();
  return t;
}

async function withProject(summaryThrough, fn) {
  const t = await setup(summaryThrough);
  try {
    return await fn((request, extra) => bundle.builder.buildContext(t.project, request, config(extra)));
  } finally {
    cleanup(t.dir);
  }
}

const item = (built, id) => built.items.find((i) => i.id === id);

describe('續寫大綱：近段整條、中段一章一行、遠段交給全文大綱', () => {
  test('第 3 級：第 141–170 章整條（區間裡的空殼也在內），第 41–140 章一行，第 1–40 章不逐章列', () =>
    withProject(30, async (build) => {
      const doc = item(await build(OUTLINE), 'outlineDoc');
      assert.equal(doc.status, 'included');
      assert.ok(doc.text.includes('## 第141章：第141章\n林昭在第141章查到第141條線索。'), doc.text.slice(-400));
      assert.ok(doc.text.includes('- 第41章 第41章：林昭在第41章') && !doc.text.includes('第40章'), doc.text.slice(0, 300));
      assert.match(doc.note, /第 41–140 章只帶第一行，第 141–170 章帶整條/);
      assert.match(
        doc.note,
        /第 1–40 章沒逐章列（一章一行最多 100 章，上下文詳細度「詳細」），更早的看全文大綱；全文大綱只寫到第 30 章：第 31–40 章這次沒帶/
      );
    }));

  test('「精簡」一章一行只列 30 章；全文大綱寫到了就不另說', () =>
    withProject(200, async (build) => {
      const doc = item(await build(OUTLINE, { contextDetail: 1 }), 'outlineDoc');
      assert.ok(doc.text.includes('- 第111章') && !doc.text.includes('第110章'), doc.text.slice(0, 200));
      assert.match(doc.note, /第 1–110 章沒逐章列（一章一行最多 30 章，上下文詳細度「精簡」），更早的看全文大綱$/);
    }));

  test('沒有全文大綱：照實說這幾章這次沒帶', () =>
    withProject(undefined, async (build) => {
      assert.match(item(await build(OUTLINE), 'outlineDoc').note, /還沒有全文大綱：第 1–40 章這次沒帶/);
    }));

  test('全文大綱在大綱配方里是 P1', () =>
    withProject(30, async (build) => {
      const summary = item(await build(OUTLINE), 'globalSummary');
      assert.ok(summary && summary.status === 'included' && summary.priority === 1, JSON.stringify(summary));
    }));

  test('「完整」不封頂也不超長：一行一行放不下從最老的丟起，近段照樣整條', () =>
    withProject(30, async (build) => {
      const built = await build(OUTLINE, { contextDetail: 4, contextWindow: 9000 });
      const doc = item(built, 'outlineDoc');
      assert.equal(doc.status, 'degraded');
      assert.ok(doc.text.includes('## 第150章：第150章') && doc.text.includes('- 第140章'), doc.text.slice(-300));
      assert.ok(!doc.text.includes('- 第1章 '), doc.text.slice(0, 200));
      assert.match(doc.note, /預算不足，第 1–\d+ 章沒帶/);
      assert.ok(built.usedTokens <= built.budget, `${built.usedTokens} > ${built.budget}`);
    }));
});

describe('拆細綱：同一份細綱不帶兩遍', () => {
  test('大綱只帶這一批與前面還沒拆的空殼', () =>
    withProject(30, async (build) => {
      const doc = item(await build(BATCH), 'outlineDoc');
      assert.ok(doc.text.includes('## 第148章') && doc.text.includes('## 第151章') && doc.text.includes('## 第155章'), doc.text);
      assert.ok(!doc.text.includes('第147章') && !doc.text.includes('第150章') && !doc.text.includes('第156章'), doc.text);
      assert.match(doc.note, /第 148 章還沒拆細綱，帶梗概；只帶這一次要拆的/);
    }));

  test('前序細綱一覽封頂時說清更早的看全文大綱、全文大綱寫到哪；全文大綱 P1', () =>
    withProject(30, async (build) => {
      const built = await build(BATCH);
      const list = item(built, 'plotList');
      // 2026-10-24 一覽從 100 章降到 30 章；大綱的中段仍是 100（上面續寫大綱那幾條）。
      assert.equal(list.label, '前序細綱一覽（30 章）');
      assert.ok(!list.text.includes('第148章'), '空殼不進一覽');
      assert.match(list.note, /只帶最近 30 章（上下文詳細度「詳細」），更早的看全文大綱；全文大綱只寫到第 30 章：第 31–\d+ 章這次沒帶/);
      assert.equal(item(built, 'globalSummary').priority, 1);
    }));

  test('前序細綱一覽放不下從最老的丟起，最後幾章（帶看點的）留著', () =>
    withProject(30, async (build) => {
      const list = item(await build(BATCH, { contextDetail: 4, contextWindow: 9000 }), 'plotList');
      assert.equal(list.status, 'degraded');
      assert.ok(list.text.endsWith('第150章 第150章：林昭在第150章去井邊。'), list.text.slice(-200));
      assert.ok(!list.text.includes('第1章 '), list.text.slice(0, 200));
      assert.match(list.note, /預算不足，第 1–\d+ 章沒帶/);
    }));
});
