/**
 * ★ 敘事線重做二期驗收（設計稿「實施：逐期提交清單」二期第 5 個提交）。從排好情節大綱、還沒有細綱也沒有敘事線的工程起，
 * 全程經 controller 發出（與工程頁那一顆按鈕、對話頁那一輪一樣），假模型按指令碼應答：
 *
 *   批次拆細綱第 1–5 章（一條線都沒有 → 先排線）→ 計劃寫進各條線 → 對話頁重拆第 3 章（寫入卡片列出、整組換掉）→ 寫前提醒
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 拆細綱的裝配裡有敘事線：這一批要收的伏筆標著「本批要收」，合同裡有【敘事線】那一條 | 設計稿「二」：細綱照著線排，回收不再靠運氣 |
 * | 模型把該收的安排在某一章收：計劃事件寫進了對的線（推進、埋、收），新伏筆登記在「未歸屬的伏筆」，認不出的線丟掉 | 計劃記在敘事線裡 |
 * | 細綱裡沒有任何關於線的小節（七節加「設定」一節） | 同一樣東西只有一份 |
 * | 重拆第 3 章：卡片上先列出來，換掉的是第 3 章的計劃，別的章一行不動 | 「隨細綱走」；第 19 條的例外先列出來；第 3 條 |
 * | 寫前提醒：第 3 章的計劃不再收玉佩，寫第 4 章時伏筆逾期出提醒（不攔）；名冊第 4 章前要收、第 4 章計劃裡收了，不提 | 設計稿「四、寫前檢查」 |
 * | 一共 3 次呼叫（排線 1、拆細綱 1、重拆 1），沒超過確認框報的上限 | 第 4 條：計劃寫進線裡 +0 次 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');
const { outlineOf, writeOutline } = require('../../helpers/outline');

let bundle;
let h;
let fake;
let t;
let project;
let controller;
let gates = [];

const THREADS = '.novelwarden/threads';
const MAIN = `${THREADS}/青崖舊案.md`;
const LEDGER = `${THREADS}/名冊之謎.md`;
const MASTER = `${THREADS}/師父的身份.md`;
const UNFILED = `${THREADS}/未归属的伏笔.md`;
const TITLES = ['停舟', '令牌', '夜訪', '井', '名冊'];
const PLOT = (no) => `.novelwarden/summaries/00${no}-${TITLES[no - 1]}.md`;

/** 拆細綱那一批、重拆第 3 章那一次各自的提示（使用者訊息）。 */
let batchPrompt = '';
let singlePrompt = '';

/** 第 1–5 章各自在敘事線上的計劃：第 3 章收玉佩（這一批要收的那一條），第 4 章收名冊那一頁，第 5 章埋一條掛不上線的新伏筆。 */
const PLANS = {
  1: [
    { line: '青崖舊案', type: '推进', what: '林昭帶著玉佩回鎮' },
    { line: '青崖舊案', type: '埋', foreshadowing: '玉佩的來歷', what: '玉佩第一次露面' },
  ],
  2: [
    { line: '名冊之謎', type: '推进', what: '名冊第一次出現' },
    { line: '', type: '埋', foreshadowing: '名冊少的一頁', what: '名冊被人撕掉了一頁' },
  ],
  3: [
    { line: '青崖舊案', type: '推进', what: '林昭查到火起那一夜' },
    { line: '', type: '收', foreshadowing: '玉佩的來歷', what: '沈氏認出玉佩上的雲紋' },
  ],
  4: [
    { line: '名冊之謎', type: '关系', what: '林昭與沈氏結盟' },
    { line: '名冊之謎', type: '收', foreshadowing: '名冊少的一頁', what: '那一頁在沈氏手裡' },
  ],
  5: [
    { line: '青崖舊案', type: '推进', what: '火起那一夜的人' },
    { line: '', type: '埋', foreshadowing: '斷劍', what: '井底有一把斷劍', resolve: 12 },
    { line: '瞎編的線', type: '推进', what: '認不出的線' },
  ],
};

function blueprint(no, threads) {
  return {
    chapterNumber: no,
    title: TITLES[no - 1],
    synopsis: `第 ${no} 章林昭接著查名冊。`,
    characters: ['林昭', '沈氏'],
    timePlace: '青崖鎮',
    keyEvents: [`第 ${no} 章林昭又往前查了一步。`],
    highlights: [`第 ${no} 章結尾：又一個人不見了。`],
    stateChange: '',
    threads,
  };
}

function reply(messages) {
  const system = messages[0]?.content ?? '';
  const user = messages[messages.length - 1].content;
  if (system.includes('只從作者給的小說配置、故事前提、角色圖譜與情節大綱裡排出這本書的敘事線')) {
    return JSON.stringify({
      threads: [
        {
          title: '青崖舊案',
          kind: '主线',
          from: 1,
          to: 30,
          intent: '查清七年前那場火。',
          foreshadowing: [{ title: '玉佩的來歷', what: '玉佩是沈家舊物', plant: 1, resolve: 3 }],
        },
        { title: '名冊之謎', kind: '支线', from: 2, to: 8, intent: '名冊上少了一頁。', foreshadowing: [{ title: '名冊少的一頁', what: '那一頁在沈氏手裡', plant: 2, resolve: 4 }] },
        { title: '師父的身份', kind: '支线', from: 10, to: 20, intent: '師父另有身份。' },
      ],
    });
  }
  if (user.includes('寫第 1–5 章的細綱：')) {
    batchPrompt = user;
    return JSON.stringify({ blueprints: [1, 2, 3, 4, 5].map((no) => blueprint(no, PLANS[no])) });
  }
  if (user.includes('寫第 3 章的細綱：')) {
    singlePrompt = user;
    // 重拆第 3 章：這一次沒安排收玉佩，只推進主線。
    return JSON.stringify({ blueprints: [blueprint(3, [{ line: '青崖舊案', type: '推进', what: '重拆之後：林昭先去了井邊' }])] });
  }
  return '（認不出這一步）';
}

const parse = (rel) => bundle.threadFile.parseThreadFile(t.read(rel), rel);
/** 一份檔案裡的計劃事件：`[章, 型別, 伏筆, 一句話]`。 */
const plans = (rel, text = t.read(rel)) =>
  (rel === UNFILED ? bundle.threadFile.parseUnfiledFile(text, rel) : bundle.threadFile.parseThreadFile(text, rel)).events
    .filter((e) => e.planned)
    .map((e) => [e.chapter, e.type, e.foreshadowing ?? '', e.what]);

/** 拆完那一刻各份線檔案的原文（重拆之後比對別的章有沒有動）。 */
const before3 = {};
let batchConfirm;
let card;

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    controller: './src/core/controller/index.ts',
    threadFile: './src/core/model/threadFile.ts',
    plotFile: './src/core/model/plotFile.ts',
    preflight: './src/core/features/preflight.ts',
    workbench: './src/core/views/workbench.ts',
    db: './src/core/runtime/db.ts',
  });
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply,
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'threads-phase2', title: '青崖記' });
  project = t.project;
  t.write('.novelwarden/config.md', '---\ntotalChapters: 30\nwordsPerChapter: 600\n---\n\n# 小說配置\n\n## 核心梗概\n\n回鎮查案。\n');
  t.write('.novelwarden/premise.md', '# 故事前提\n\n## 一句話前提\n\n林昭回鎮，必須找出放火的人。\n');
  writeOutline(t, outlineOf(20, { text: { 1: '林昭進鎮，一路查名冊。' } }));
  project.invalidate();

  controller = new bundle.controller.ChatController(project);
  controller.attach({
    kind: 'sidebar',
    post: (m) => {
      if (m.type === 'gate') {
        gates.push(m);
        void controller.handle({ type: 'gateResult', requestId: m.requestId, verdict: 'proceed' });
      }
    },
    reveal() {},
  });

  // 工程頁「批次拆細綱」第 1–5 章：一條敘事線都沒有，確認框寫明先排一次，作者點「開始拆細綱」。
  h.expect('開始拆細綱');
  await controller.handle({ type: 'projectAction', action: 'generatePlots', range: { from: 1, to: 5 } });
  batchConfirm = h.confirms[0];
  for (const rel of [MAIN, LEDGER, MASTER, UNFILED]) {
    before3[rel] = t.read(rel);
  }

  // 對話頁重拆第 3 章：生成一輪，寫入卡片當場問，作者點「確認」。
  gates = [];
  await controller.handle({
    type: 'send',
    payload: {
      text: '第 3 章重排一下',
      stage: 'plot',
      capability: 'generate',
      target: { kind: 'plot', plotRelPath: PLOT(3) },
      targetNo: 3,
      attachments: [],
      excludedIds: [],
    },
  });
  card = gates.find((g) => g.name === 'artifact');
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('敘事線重做二期驗收：拆細綱帶線，計劃寫進線裡，重拆換掉那一章的計劃，寫前提醒', () => {
  test('一條線都沒有：先排了線（一條一個檔案，伏筆寫線上下），再拆第 1–5 章細綱', () => {
    assert.match(batchConfirm.detail, /還沒有一條敘事線：開拆之前先從情節大綱排一次/);
    assert.deepEqual(parse(MAIN).foreshadowing.map((f) => [f.name, f.plant, f.resolve]), [['玉佩的來歷', 1, 3]]);
    for (let no = 1; no <= 5; no++) {
      assert.ok(t.has(PLOT(no)), PLOT(no));
    }
  });

  test('拆細綱的裝配裡有敘事線：這一批要收的伏筆標著「本批要收」，合同裡有【敘事線】那一條', () => {
    assert.ok(batchPrompt.includes('# 敘事線（照著排'), batchPrompt.slice(0, 2000));
    assert.ok(batchPrompt.includes('- 玉佩的來歷（掛在「青崖舊案」· 計劃 · 本批要收，最晚第 3 章，還沒埋，先埋再收）是什麼：玉佩是沈家舊物'), batchPrompt);
    assert.ok(batchPrompt.includes('- 名冊少的一頁（掛在「名冊之謎」· 計劃 · 本批要收，最晚第 4 章，還沒埋，先埋再收）'), batchPrompt);
    assert.ok(batchPrompt.includes('- 師父的身份（支線 · 計劃中 · 計劃第 10–20 章）意圖：師父另有身份；本批還不到它開始的那一章，不要提前開'), batchPrompt);
    assert.ok(batchPrompt.includes('標著「本批要收」或「已過第 N 章，還沒收」的伏筆，必須安排在本批某一章「收」'), batchPrompt);
    assert.ok(!batchPrompt.includes('伏筆強制回收'));
  });

  test('計劃事件寫進了對的線：推進、埋、收按章排好；該收的伏筆安排在第 3、4 章收', () => {
    // 拆完那一刻（重拆第 3 章之前）的樣子。
    assert.deepEqual(plans(MAIN, before3[MAIN]), [
      [1, '推进', '', '林昭帶著玉佩回鎮'],
      [1, '埋', '玉佩的來歷', '玉佩第一次露面'],
      [3, '推进', '', '林昭查到火起那一夜'],
      [3, '收', '玉佩的來歷', '沈氏認出玉佩上的雲紋'],
      [5, '推进', '', '火起那一夜的人'],
    ]);
    // 伏筆的事件跟著伏筆走：第 2 章那一條 line 寫空，也落在名冊所在的這條線上。
    assert.deepEqual(plans(LEDGER), [
      [2, '推进', '', '名冊第一次出現'],
      [2, '埋', '名冊少的一頁', '名冊被人撕掉了一頁'],
      [4, '关系', '', '林昭與沈氏結盟'],
      [4, '收', '名冊少的一頁', '那一頁在沈氏手裡'],
    ]);
    assert.deepEqual(plans(MASTER), []);
  });

  test('掛不上線的新伏筆進「未歸屬的伏筆」並登記計劃第 5 章埋、第 12 章前收；認不出的線丟掉', () => {
    const loose = t.read(UNFILED);
    assert.ok(loose.includes('- 斷劍：井底有一把斷劍（計劃第 5 章埋、第 12 章前收）'), loose);
    assert.deepEqual(plans(UNFILED), [[5, '埋', '斷劍', '井底有一把斷劍']]);
    for (const rel of [MAIN, LEDGER, MASTER, UNFILED]) {
      assert.ok(!t.read(rel).includes('認不出的線'), rel);
    }
  });

  test('細綱裡沒有任何關於線的小節：七節加「設定」一節', () => {
    const plot = bundle.plotFile.parsePlotFile(t.read(PLOT(1)), PLOT(1));
    assert.deepEqual(Object.keys(plot.sections), [...bundle.plotFile.PLOT_SECTION_KEYS]);
    assert.ok(!/新增伏筆|玉佩第一次露面/.test(t.read(PLOT(1))), t.read(PLOT(1)));
  });

  test('重拆第 3 章：裝配裡說「本章要收」，寫入卡片上先列出會寫什麼、換掉原來的幾條', () => {
    assert.ok(singlePrompt.includes('- 玉佩的來歷（掛在「青崖舊案」· 計劃 · 本章要收）'), singlePrompt);
    assert.ok(card, JSON.stringify(gates.map((g) => g.name)));
    assert.ok(card.detail.includes('敘事線計劃：青崖舊案 推進（原來的 2 條整組換掉）'), card.detail);
  });

  test('重拆換掉的是第 3 章的計劃，別的章一行不動', () => {
    const main = t.read(MAIN);
    assert.ok(main.includes('- 第 3 章 · 計劃 · 推進：重拆之後：林昭先去了井邊'), main);
    assert.ok(!main.includes('第 3 章 · 計劃 · 收〈玉佩的來歷〉') && !main.includes('林昭查到火起那一夜'), main);
    const others = (text) => text.split('\n').filter((l) => !l.includes('第 3 章 · 計劃'));
    for (const rel of [MAIN, LEDGER, MASTER, UNFILED]) {
      assert.deepEqual(others(t.read(rel)), others(before3[rel]), rel);
    }
  });

  // 復跑之後加了第三類：名冊計劃第 2 章埋，第 1–3 章沒定稿、敘事線裡還沒有實際的「埋」，寫第 4 章時照提（說明裡注了可能不準）。
  test('寫前提醒：玉佩第 3 章前要收、計劃裡不再收它，寫第 4 章時提醒（不攔）；名冊第 4 章計劃裡收了，不提逾期，提還沒埋', async () => {
    const pre = await bundle.preflight.preflightChapter(project, 4);
    assert.deepEqual(pre.threads, [
      { kind: 'overdue', name: '玉佩的來歷', resolve: 3, at: 4 },
      { kind: 'unplanted', name: '名冊少的一頁', plant: 2, at: 4 },
    ]);
    const wb = await bundle.workbench.buildWorkbench(project, { kind: 'manuscript', plotRelPath: PLOT(4) });
    assert.ok(
      wb.notice.includes(
        '敘事線提醒：伏筆〈玉佩的來歷〉計劃第 3 章前收，還沒收，本章計劃裡也沒安排收；伏筆〈名冊少的一頁〉計劃第 2 章埋，還沒埋，本章計劃裡也沒安排埋（第 1–3 章還沒同步或還沒補記，敘事線還沒記上，提醒可能不準）。只是提醒，照寫不攔。'
      ),
      wb.notice
    );
  });

  test('一共 3 次呼叫（排線 1、拆細綱 1、重拆 1），沒超過確認框報的上限；計劃寫進線裡不多調', () => {
    assert.equal(fake.calls.length, 3);
    const max = Number(/最多 (\d+) 次/.exec(batchConfirm.message)?.[1]);
    assert.ok(max >= 2, batchConfirm.message);
  });
});
