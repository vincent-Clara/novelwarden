/**
 * ★ 敘事線重做一期驗收（設計稿「實施：逐期提交清單」一期第 11 個提交；七期那一份驗收並進來了）。從排好前 5 章細綱的工程起，
 * 工程頁「從大綱排出」敘事線，作者改一條線的「當前進度」，再「批次寫章」第 1–3 章、寫完即定稿：
 *
 *   排線 → 寫第 1 章 → 定稿（細綱 + 認事件 + 當前進度）→ 寫第 2 章 → 定稿（+ 歸併）→ 寫第 3 章 → 定稿
 *
 * 經 controller 發出去（與工程頁那一顆按鈕、彈窗提交的訊息一樣），假模型按指令碼應答。寫正文那一次靠執行卡裡的
 * 「必需事件」認出是哪一章。沒有角色卡：角色狀態那一步不調，次數好數。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 敘事線目錄裡有排出的線（一條一個檔案，伏筆寫線上下） | 排線從情節大綱排 |
 * | 線檔案裡有帶證據的實際事件（推進、埋、收）；偽造證據的那條沒記 | 定稿第三步 a，證據逐字校驗是那道閘 |
 * | 機器維護的「當前進度」寫到最後動過的那一章、蓋了章 | 定稿第三步 b，作者一眼看出走到哪 |
 * | 正文裡新長出來的線建了新檔案（來源：正文）、掛不上線的伏筆進「未歸屬的伏筆」 | 線從計劃與正文兩頭來（作者定的第 2 條） |
 * | 作者手改過的「當前進度」沒被覆蓋、那條線上掛了黃 ❗；作者改的那一行原樣還在 | 第 19 條的例外：作者改過就不寫；第 3 條 |
 * | **第 3 章寫正文那一次的裝配裡**有線：現在走到哪、作者寫的進度照用、該收的伏筆；沒開始的那條不在 | 後一章讀得到前面的線 |
 * | 工程頁「敘事線」頁籤：一條線一行，主線在前，新認出的線也在，最後是「未歸屬的伏筆」 | 設計稿「七、工程頁」 |
 * | 實際呼叫次數 ≤ 兩個確認框報的上限之和 | 第 4 條 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, filler, TIME_MARK, timeReply } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');
const { outlineOf, writeOutline } = require('../../helpers/outline');

let bundle;
let h;
let fake;
let t;
let project;
let controller;

const TITLES = ['停舟', '令牌', '夜訪', '井', '名冊'];
const pad3 = (n) => String(n).padStart(3, '0');
const CH = (no) => `chapters/${pad3(no)}-${TITLES[no - 1]}.txt`;
const THREADS = '.novelwarden/threads';
const MAIN = `${THREADS}/青崖舊案.md`;
const LEDGER = `${THREADS}/名冊之謎.md`;
const GROWN = `${THREADS}/沈氏的來意.md`;
const UNFILED = `${THREADS}/未归属的伏笔.md`;
const AUTHOR_PROGRESS = '作者寫的：名冊在沈氏手裡，林昭還不知道。';
const AUTHOR_INTENT = '作者改過的：名冊上少了的那一頁在沈氏手裡。';

function chapterText(no) {
  return [
    filler(260, no * 10 + 1),
    `林昭在第${no}章摸了摸懷裡的玉佩。`,
    `沈氏在第${no}章翻開名冊，手指停在第${no}行。`,
    `沈氏在第${no}章敲了七下桌面。`,
    filler(260, no * 10 + 2),
  ].join('\n\n');
}

let ch3Prompt = '';
/** 每一章認事件那一次答什麼。第 1 章有一條偽造的證據；第 2 章從正文里長出一條線、一條掛不上線的伏筆。 */
const FINDS = {
  1: {
    events: [
      { line: '青崖舊案', type: '推进', evidence: '林昭在第1章摸了摸懷裡的玉佩。', what: '林昭帶著玉佩回鎮' },
      { line: '青崖舊案', type: '埋', foreshadowing: '玉佩的來歷', evidence: '林昭在第1章摸了摸懷裡的玉佩', what: '玉佩第一次露面' },
      { line: '名冊之謎', type: '推进', evidence: '名冊上被人撕掉了一頁', what: '正文裡沒有這一句' },
    ],
  },
  2: {
    events: [{ line: '名冊之謎', type: '推进', evidence: '沈氏在第2章翻開名冊', what: '名冊第一次出現' }],
    newThreads: [{ title: '沈氏的來意', kind: '人物线', intent: '沈氏為何盯上林昭。', evidence: '沈氏在第2章翻開名冊，手指停在第2行。' }],
    newForeshadowing: [{ title: '敲桌七下', what: '沈氏敲桌是暗號', evidence: '沈氏在第2章敲了七下桌面。' }],
  },
  3: {
    events: [
      { line: '青崖舊案', type: '推进', evidence: '林昭在第3章摸了摸懷裡的玉佩', what: '林昭查到火起的那一夜' },
      { line: '青崖舊案', type: '收', foreshadowing: '玉佩的來歷', evidence: '林昭在第3章摸了摸懷裡的玉佩。', what: '玉佩是沈家舊物' },
      { line: '沈氏的來意', type: '推进', evidence: '沈氏在第3章翻開名冊', what: '沈氏又翻名冊' },
    ],
  },
};

/** 當前進度那一次送來了哪幾條線（作者改過的那條不該在裡面）。 */
const progressAsked = [];

function reply(messages) {
  const system = messages[0]?.content ?? '';
  const user = messages[messages.length - 1].content;
  if (system.includes('你是長篇小說的連續性編輯')) {
    return JSON.stringify({ conflicts: [] });
  }
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
        { title: '名冊之謎', kind: '支线', from: 2, to: 5, intent: '名冊上少了一頁。' },
        { title: '師父的身份', kind: '支线', from: 10, to: 20, intent: '師父另有身份。' },
      ],
    });
  }
  const no = Number(/【第(\d+)章/.exec(user)?.[1] ?? 0);
  if (system.includes('建立可檢索的章節檔案')) {
    return JSON.stringify({
      梗概: `第 ${no} 章。`,
      出场人物: [{ name: '林昭', aliases: [] }, { name: '沈氏', aliases: [] }],
      时间地点: '青崖鎮。',
      关键事件: [`第 ${no} 章的事`],
      状态变更: '',
      连续性事实: [`沈氏在第${no}章翻開了名冊`],
    });
  }
  if (system.includes('你是小說定稿事實審查員')) {
    return JSON.stringify({ events: [], newThreads: [], newForeshadowing: [], ...FINDS[no] });
  }
  if (system.includes('判斷它們是不是已有的某一條換了個說法')) {
    return JSON.stringify({ merges: [] });
  }
  if (system.includes('給每一條寫一兩句「當前進度」')) {
    // 線名照真模型的樣子帶著種類回（試跑：gemini-3-flash-lite 10 次裡 9 次回「名字（種類）」）：釘住「認不出就整條丟」的迴歸。
    const lines = [...user.matchAll(/^【線】(.+)\n種類：(.+)$/gm)].map((m) => ({ line: m[1], kind: m[2] }));
    progressAsked.push(...lines.map(({ line }) => `${no}:${line}`));
    return JSON.stringify({ progress: lines.map(({ line, kind }) => ({ line: `${line}（${kind}）`, text: `第 ${no} 章：${line}走到了這裡。` })) });
  }
  const card = /- 必需事件：第 (\d+) 章/.exec(user);
  if (card) {
    const n = Number(card[1]);
    if (n === 3) {
      ch3Prompt = user;
    }
    return { text: chapterText(n), stop: 'end' };
  }
  // 故事時間（同步時單獨一次，2026-10-24 重做）：都緊接上一章。
  if ((messages[0]?.content ?? '').includes(TIME_MARK)) {
    return timeReply(messages);
  }
  return '（認不出這一步）';
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    controller: './src/core/controller/index.ts',
    pipelineModel: './src/core/model/pipeline.ts',
    threadFile: './src/core/model/threadFile.ts',
    projectView: './src/core/views/projectView.ts',
    db: './src/core/runtime/db.ts',
    config: './src/core/config.ts',
  });
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
  // 近章全文 0 章、其餘照預設那一級：沒有哪一級是這個組合，只能單項覆蓋（作者那邊只有級別可選）。
  bundle.config.setContextLimitsOverride({ fullTextChapters: 0 });
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply,
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'threads-phase1', title: '青崖記' });
  project = t.project;
  t.write('.novelwarden/config.md', '---\ntotalChapters: 30\nwordsPerChapter: 600\n---\n\n# 小說配置\n\n## 核心梗概\n\n回鎮查案。\n');
  t.write('.novelwarden/premise.md', '# 故事前提\n\n## 一句話前提\n\n林昭回鎮，必須找出放火的人。\n\n## 懸念骨架\n\n玉佩與名冊。\n');
  t.write('.novelwarden/world.md', '# 世界觀\n\n## 規則與漏洞\n\n名冊決定誰算鎮上的人。\n');
  writeOutline(t, outlineOf(20, { text: { 1: '林昭進鎮，一路查名冊。' } }));
  const ws = new bundle.ws.Workspace(project);
  for (let no = 1; no <= 5; no++) {
    await ws.writePlot({
      no,
      title: TITLES[no - 1],
      targetWords: 600,
      upstreamHash: '',
      done: false,
      sections: {
        梗概: `第 ${no} 章林昭接著查名冊。`,
        出场人物: '林昭、沈氏',
        时间地点: '',
        关键事件: `第 ${no} 章林昭又往前查了一步。`,
        看点: `- 第 ${no} 章結尾：又一個人不見了。`,
        状态变更: '',
        连续性事实: '',
      },
    });
  }
  project.invalidate();

  controller = new bundle.controller.ChatController(project);
  controller.attach({ kind: 'sidebar', post: () => {}, reveal() {} });
  // 工程頁「從大綱排出」：後端彈確認框，作者點「開始排」。
  h.expect('開始排');
  await controller.handle({ type: 'projectAction', action: 'generateThreads' });
  // 作者看了一眼：改了一條線的意圖，又自己寫了它的「當前進度」。
  t.write(
    LEDGER,
    t
      .read(LEDGER)
      .replace('名冊上少了一頁。', AUTHOR_INTENT)
      .replace(/## 當前進度\n\n[^\n]*\n/, `## 當前進度\n\n${AUTHOR_PROGRESS}\n`)
  );
  project.invalidate();
  // 與工程頁彈窗提交的那一條一樣：彈窗已經報過呼叫次數，帶 call（作者在彈窗上沒改模型與詳細度）。
  await controller.handle({
    type: 'projectAction',
    action: 'writeManuscripts',
    range: { from: 1, to: 3 },
    mode: 'finalize',
    call: {},
  });
});

after(() => {
  controller?.dispose();
  bundle?.config.setContextLimitsOverride(undefined);
  if (t) cleanup(t.dir, bundle?.db);
});

describe('敘事線重做一期驗收：排線，再批次寫章第 1–3 章、寫完即定稿', () => {
  const parse = (rel) => bundle.threadFile.parseThreadFile(t.read(rel), rel);
  const actual = (rel) => parse(rel).events.filter((e) => !e.planned).map((e) => [e.chapter, e.type, e.foreshadowing ?? '', e.evidence ?? '']);

  test('敘事線目錄裡有排出的三條線（一條一個檔案，伏筆寫線上下），三章都寫了', () => {
    for (const rel of [MAIN, LEDGER, `${THREADS}/師父的身份.md`]) {
      assert.ok(t.has(rel), rel);
    }
    assert.equal(parse(MAIN).kind, '主线');
    assert.deepEqual(parse(MAIN).foreshadowing.map((f) => [f.name, f.plant, f.resolve]), [['玉佩的來歷', 1, 3]]);
    assert.ok(t.has(CH(3)) && !t.has(CH(4)));
  });

  test('線檔案裡有帶證據的實際事件：推進、埋、收；偽造證據的那條沒記', () => {
    assert.deepEqual(actual(MAIN), [
      [1, '推进', '', '林昭在第1章摸了摸懷裡的玉佩。'],
      [1, '埋', '玉佩的來歷', '林昭在第1章摸了摸懷裡的玉佩'],
      [3, '推进', '', '林昭在第3章摸了摸懷裡的玉佩'],
      [3, '收', '玉佩的來歷', '林昭在第3章摸了摸懷裡的玉佩。'],
    ]);
    assert.deepEqual(actual(LEDGER), [[2, '推进', '', '沈氏在第2章翻開名冊']]);
    assert.ok(!t.read(LEDGER).includes('名冊上被人撕掉了一頁'));
    assert.deepEqual(actual(`${THREADS}/師父的身份.md`), []);
  });

  test('機器維護的當前進度寫到最後動過的那一章、蓋了章', () => {
    const main = parse(MAIN);
    assert.equal(main.progress, '第 3 章：青崖舊案走到了這裡。');
    assert.equal(main.progressThrough, 3);
    assert.ok(bundle.threadFile.progressOwnedByMachine(main));
  });

  test('正文裡新長出來的線建了新檔案（來源：正文），掛不上線的伏筆進「未歸屬的伏筆」', () => {
    const grown = parse(GROWN);
    assert.equal(grown.kind, '人物线');
    assert.equal(grown.origin, '正文');
    assert.deepEqual(actual(GROWN).map(([no, type]) => [no, type]), [[2, '推进'], [3, '推进']]);
    assert.equal(grown.progressThrough, 3);
    const unfiled = bundle.threadFile.parseUnfiledFile(t.read(UNFILED), UNFILED);
    assert.deepEqual(unfiled.foreshadowing.map((f) => f.name), ['敲桌七下']);
    assert.deepEqual(unfiled.events.map((e) => [e.chapter, e.type, e.foreshadowing]), [[2, '埋', '敲桌七下']]);
  });

  test('作者手改過的當前進度沒被覆蓋、沒送去寫，那條線上掛了黃 ❗；作者改的意圖原樣還在', async () => {
    const ledger = parse(LEDGER);
    assert.equal(ledger.progress, AUTHOR_PROGRESS);
    assert.ok(t.read(LEDGER).includes(AUTHOR_INTENT));
    assert.ok(!progressAsked.some((x) => x.endsWith(':名冊之謎')), progressAsked.join('、'));
    project.invalidate();
    const tree = await bundle.projectView.buildProjectTree(project);
    const marks = tree.failures[LEDGER] ?? [];
    assert.ok(marks.some((f) => f.severity === 'warn' && f.op === 'threadProgress' && f.message.includes('第 2 章')), JSON.stringify(marks));
    assert.equal(tree.failures[MAIN], undefined);
  });

  test('第 3 章寫正文時：裝配裡有線——現在走到哪、作者寫的進度照用、該收的伏筆；沒開始的那條不在', () => {
    const at = ch3Prompt.indexOf('# 進行中的敘事線');
    assert.ok(at > 0, ch3Prompt.slice(0, 2000));
    const section = ch3Prompt.slice(at, ch3Prompt.indexOf('\n---\n', at));
    assert.match(section, /- 青崖舊案（主線 · 進行中[^）]*）現在：第 1 章：青崖舊案走到了這裡/);
    assert.match(section, /玉佩的來歷/);
    assert.ok(section.includes(`- 名冊之謎（支線 · 進行中`) && section.includes(AUTHOR_PROGRESS.replace(/。$/, '')), section);
    assert.ok(section.includes('沈氏的來意'), section);
    assert.ok(!section.includes('師父的身份'), section);
  });

  test('工程頁「敘事線」頁籤：一條線一行，主線在前、新認出的線也在，最後是「未歸屬的伏筆」', async () => {
    project.invalidate();
    const tree = await bundle.projectView.buildProjectTree(project);
    assert.equal(tree.threads.current, 3);
    // 寫完即定稿每判完一章就推水位（四期）：敘事線判到第 3 章，不落後。
    assert.equal(tree.threads.through, 3);
    assert.equal(tree.threads.lag, undefined);
    assert.equal((await project.readManifest()).threadsThrough, 3);
    assert.deepEqual(
      tree.threads.lines.map((l) => [l.name, l.detail]),
      [
        ['青崖舊案', '主線 · 進行中 · 最近第 3 章'],
        ['名冊之謎', '支線 · 進行中 · 最近第 2 章'],
        ['師父的身份', '支線 · 計劃中 · 計劃第 10–20 章'],
        ['沈氏的來意', '人物線 · 進行中 · 最近第 3 章'],
      ]
    );
    assert.equal(tree.threads.lines[0].relPath, MAIN);
    assert.deepEqual(tree.threads.unfiled, { relPath: UNFILED, total: 1, detail: '1 條', warnings: [] });
  });

  test('實際呼叫次數沒超過兩個確認框報的上限（排線 1 次 + 批次寫章的最多幾次）', () => {
    const plan = bundle.pipelineModel.planWriteBatch({ from: 1, to: 3, mode: 'finalize', writtenNos: [], plotFilledNos: [1, 2, 3, 4, 5] });
    assert.ok(fake.callCount() <= 1 + plan.calls.max, `${fake.callCount()} > 1 + ${plan.calls.max}`);
    // 排線 1；一章寫一次、定稿更新細綱一次、認敘事線一次、當前進度一次（每章都有線動過）、故事時間一次；第 2 章認出新東西多一次歸併；
    // 第 2、3 章寫前各比對一次。
    assert.equal(fake.callCount(), 1 + 3 * 5 + 1 + 2);
  });
});
