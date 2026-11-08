/**
 * 規劃時的角色圖譜（docs/design/plans/2026-10-24-planning-roster-plotlist.md）：大綱、細綱不再全員一人一段。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 拆細綱（第 3 級）：近 20 章出場的給一段，角色卡層整張帶的只點名，更早出場的與沒出場的只列名字；明細寫清各幾人 | 寫到八十章、四十幾張卡時全員一人一段上萬 token，詳細度調到哪一級都不少；第 2 條 |
 * | 「精簡」角色卡只帶要點（沒有人物關係）：不點名，照給一段；往前只看 10 章 | 點了名、卡裡又沒有關係，這一段就丟了 |
 * | 作者在明細裡取消了的角色卡：圖譜裡照給一段 | 不然這個人只剩名字 |
 * | 「完整」全員一段，與從前一樣 | 第 4 級不封頂 |
 * | 續寫大綱：區間前 20 章出場的給一段；作者這一次的話裡提到的有整張卡 | 大綱、細綱同一個帶法 |
 * | 剛開書（一份細綱都沒有）：全員一段 | 誰算活躍無從判斷，寧可多帶 |
 * | 批次拆細綱：這一批空殼的梗概裡提到的人給一段 | 這一次要排的那幾章算在「近幾章」裡 |
 * | 架構階段（世界觀）全員一段，不變 | 世界觀要照著所有人寫 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

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

/** 一份排過的細綱；`stub` 是隻有梗概的空殼。 */
function plotText(no, cast, synopsis = `林昭在第${no}章往下查。`, stub = false) {
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
    synopsis,
    ...(stub ? [] : ['', '## 出場人物', '', cast.join('、'), '', '## 關鍵事件', '', `- 第${no}章的事。`]),
    '',
  ].join('\n');
}

const card = (name, tag) =>
  `---\nname: ${name}\ntags: [${tag}]\n---\n\n# ${name}\n\n## 身份\n\n${name}的身份。\n\n## 人物關係\n\n${name}的關係。\n\n## 當前狀態\n\n${name}的狀態。\n`;

/** 第 1–60 章排過；周嬸只在第 10 章、老陳只在第 45 章、沈青在第 55–61 章出場；李叔、阿九一章都沒出場。 */
function castOf(no) {
  if (no === 10) return ['林昭', '周嬸'];
  if (no === 45) return ['林昭', '老陳'];
  if (no >= 55) return ['林昭', '沈青'];
  return ['林昭'];
}

const PLOT_ONE = { action: { stage: 'plot', capability: 'generate' }, target: { kind: 'plot', plotRelPath: PLOT(61) }, ask: '' };
const OUTLINE = { action: { stage: 'outline', capability: 'generate' }, target: { kind: 'outline' }, ask: '', range: { from: 62, to: 81 } };

let bundle;
before(() => {
  bundle = loadBundle({ host: './src/core/host.ts', project: './src/core/model/project.ts', builder: './src/core/context/builder.ts' });
  bundle.host.initHost(makeFakeHost().host);
});

async function withProject(fn, { plots = true, stubs = [] } = {}) {
  const t = await makeTempProject(bundle.project, { prefix: 'planningRoster', title: '圖譜' });
  try {
    t.write('.novelwarden/characters/林昭.md', card('林昭', '主角'));
    for (const name of ['沈青', '老陳', '周嬸', '李叔', '阿九']) {
      t.write(`.novelwarden/characters/${name}.md`, card(name, '配角'));
    }
    if (plots) {
      for (let no = 1; no <= 61; no++) {
        t.write(PLOT(no), plotText(no, castOf(no)));
      }
      for (const [no, synopsis] of stubs) {
        t.write(PLOT(no), plotText(no, [], synopsis, true));
      }
    }
    t.project.invalidate();
    return await fn((request, extra) => bundle.builder.buildContext(t.project, request, config(extra)));
  } finally {
    cleanup(t.dir);
  }
}

const roster = (built) => built.items.find((i) => i.id === 'roster');
/** 圖譜裡給了一段的人（名字那一行下面跟著「身份：」）。 */
const described = (item) => [...item.text.matchAll(/^- (\S+?)［/gm)].map((m) => m[1]);
/** 只列名字的那一行。 */
const namedLine = (item) => item.text.split('\n').find((l) => l.startsWith('其餘角色')) ?? '';
const cardedLine = (item) => item.text.split('\n').find((l) => l.startsWith('整張卡在下面')) ?? '';

describe('規劃時的角色圖譜：只給近期活躍的一段', () => {
  test('拆細綱第 3 級：老陳（第 45 章）給一段，主角與本章計劃出場的只點名，周嬸、李叔、阿九隻列名字', () =>
    withProject(async (build) => {
      const built = await build(PLOT_ONE);
      const r = roster(built);
      assert.equal(r.status, 'included');
      assert.equal(r.label, '角色圖譜（6 人）');
      assert.deepEqual(described(r), ['老陳']);
      assert.ok(r.text.includes('- 老陳［配角］\n  身份：老陳的身份。'), r.text);
      assert.equal(cardedLine(r), '整張卡在下面「相關角色設定」裡：林昭、沈青。');
      assert.ok(['周嬸', '李叔', '阿九'].every((n) => namedLine(r).includes(n)), namedLine(r));
      assert.match(namedLine(r), /^其餘角色（近 20 章沒出場，只列名字；再出場時照用這些名字）：/);
      assert.ok(!r.text.includes('周嬸的身份'), '只列名字的不帶身份');
      assert.match(
        r.note,
        /^1 人（主角、近 20 章出場的、這一次提到的）取身份、人物關係、當前狀態的開頭；整張卡在「相關角色設定」的 2 人只點名；其餘 3 人只列名字（上下文詳細度「詳細」）$/
      );
      // 點了名的兩張卡確實整張帶了。
      for (const name of ['林昭', '沈青']) {
        const c = built.items.find((i) => i.label === `角色 · ${name}`);
        assert.ok(c && c.status === 'included' && c.text.includes(`${name}的關係`), JSON.stringify(c));
      }
    }));

  test('「精簡」：只往前看 10 章（老陳只列名字）；角色卡只帶要點，不點名、照給一段', () =>
    withProject(async (build) => {
      const r = roster(await build(PLOT_ONE, { contextDetail: 1 }));
      assert.deepEqual(described(r).sort(), ['林昭', '沈青'].sort());
      assert.equal(cardedLine(r), '');
      assert.ok(namedLine(r).includes('老陳') && namedLine(r).startsWith('其餘角色（近 10 章沒出場'), namedLine(r));
    }));

  test('作者在明細裡取消了沈青的卡：圖譜裡照給沈青一段', () =>
    withProject(async (build) => {
      const id = (await build(PLOT_ONE)).items.find((i) => i.label === '角色 · 沈青').id;
      const r = roster(await build({ ...PLOT_ONE, excludedIds: [id] }));
      assert.ok(described(r).includes('沈青'), r.text);
      assert.equal(cardedLine(r), '整張卡在下面「相關角色設定」裡：林昭。');
    }));

  test('「完整」：全員一段，與從前一樣', () =>
    withProject(async (build) => {
      const r = roster(await build(PLOT_ONE, { contextDetail: 4 }));
      assert.equal(described(r).length, 6);
      assert.equal(namedLine(r), '');
      assert.equal(r.note, '每人只取身份、人物關係、當前狀態的開頭；完整角色卡在正文層才帶');
    }));

  test('批次拆細綱：這一批空殼的梗概裡提到周嬸，周嬸給一段', () =>
    withProject(
      async (build) => {
        const r = roster(
          await build({ action: { stage: 'plot', capability: 'generate' }, target: { kind: 'plot', plotRelPath: PLOT(62) }, ask: '', range: { from: 62, to: 64 } })
        );
        assert.ok(described(r).includes('周嬸'), r.text);
        assert.ok(namedLine(r).includes('李叔') && !namedLine(r).includes('周嬸'), namedLine(r));
      },
      { stubs: [[62, '林昭出鎮。'], [63, '周嬸回到鎮上。'], [64, '林昭回來。']] }
    ));
});

describe('續寫大綱與架構', () => {
  test('續寫第 62–81 章：區間前 20 章出場的沈青、老陳給一段；作者提到的阿九有整張卡、只點名', () =>
    withProject(async (build) => {
      const built = await build({ ...OUTLINE, ask: '讓阿九在這一卷回來' });
      const r = roster(built);
      assert.deepEqual(described(r).sort(), ['沈青', '老陳'].sort());
      assert.ok(cardedLine(r).includes('阿九') && cardedLine(r).includes('林昭'), cardedLine(r));
      assert.ok(namedLine(r).includes('周嬸') && namedLine(r).includes('李叔'), namedLine(r));
      assert.ok(built.items.some((i) => i.label === '角色 · 阿九' && i.status === 'included'));
    }));

  test('剛開書（一份細綱都沒有）：續寫第 1–20 章時全員一段', () =>
    withProject(
      async (build) => {
        const r = roster(await build({ ...OUTLINE, range: { from: 1, to: 20 } }));
        assert.equal(described(r).length, 6);
        assert.equal(namedLine(r), '');
      },
      { plots: false }
    ));

  test('架構階段（世界觀）全員一段，不變', () =>
    withProject(async (build) => {
      const r = roster(
        await build({ action: { stage: 'setting', capability: 'generate' }, target: { kind: 'setting', doc: 'world' }, ask: '' })
      );
      assert.equal(described(r).length, 6);
      assert.equal(r.note, '每人只取身份、人物關係、當前狀態的開頭；完整角色卡在正文層才帶');
    }));
});
