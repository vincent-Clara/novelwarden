/**
 * 敘事線的計劃事件隨細綱走（敘事線二期，設計稿「二」與「誰能寫什麼」）：細綱合同多一個 `threads` 欄位，細綱寫進去時，
 * 各條線裡那一章的計劃事件整組換掉（features/threadPlan.ts，經 generation/accept.ts 的單章與批次兩條路）。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 寫進去的是這一章的計劃：線的事件落在那條線上，伏筆的事件跟著伏筆走，沒見過的伏筆被埋了登記成新伏筆（掛不上進未歸屬） | 計劃記在敘事線裡，細綱裡不再有關於線的小節 |
 * | 這一章原來的計劃整組換掉，別的章、實際事件、作者寫的行一個字不動 | 第 3 條；設計稿「隨細綱走」 |
 * | 認不出是哪條線的丟掉，寫入卡片與完成提示裡說出來 | 第 2 條 |
 * | 寫入卡片上先列出來（會寫哪幾條、換掉原來的幾條） | 第 19 條的例外：同細綱帶出的新角色 |
 * | 合同裡沒寫 threads、作者在審閱裡放棄了、批次跳過已有的章：那一章的計劃不動 | 只在細綱真的寫進去之後才換 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let t;

const DIR = '.novelwarden/threads';
const PAIR = `${DIR}/林昭與沈青.md`;
const MAIN = `${DIR}/青崖舊案.md`;
const UNFILED = `${DIR}/未归属的伏笔.md`;
const PLOT = (no) => `.novelwarden/summaries/${String(no).padStart(3, '0')}-第${no}章.md`;

const PAIR_TEXT = [
  '---',
  'kind: 感情線',
  'plan: 2-30',
  '---',
  '',
  '# 林昭與沈青',
  '',
  '## 意圖',
  '從互相猜忌到並肩。',
  '',
  '## 伏筆',
  '- 玉佩的來歷：沈家舊物（計劃第 2 章埋、第 6 章前收）',
  '',
  '## 進展',
  '- 第 2 章 · 埋〈玉佩的來歷〉：玉佩露面 〔證據：「他摸了摸懷裡的玉佩」〕',
  '- 第 4 章 · 計劃 · 推進：舊的計劃，要被換掉',
  '- 作者手寫的一行備註',
  '- 第 5 章 · 計劃 · 推進：第 5 章的計劃，不動',
  '',
].join('\n');
const MAIN_TEXT = '---\nkind: 主線\nplan: 1-40\n---\n\n# 青崖舊案\n\n## 意圖\n查清那場火。\n\n## 進展\n- 第 1 章 · 推進：起火 〔證據：「火光沖天」〕\n';

/** 一份已經排過的細綱（關鍵事件有內容）。 */
function plotText(no) {
  return `---\nno: ${no}\ntitle: 第${no}章\ntargetWords: 1200\n---\n\n# 第${no}章 第${no}章\n\n## 梗概\n\n第${no}章的梗概\n\n## 關鍵事件\n\n- 第${no}章原來的事\n`;
}

/** 細綱合同的單項形式：`threads` 給了才帶。 */
function blueprint(no, threads) {
  return {
    chapterNumber: no,
    title: `第${no}章`,
    synopsis: `第 ${no} 章重排的梗概`,
    characters: ['林昭'],
    timePlace: '',
    keyEvents: [`第 ${no} 章重排的事`],
    highlights: [],
    stateChange: '',
    ...(threads ? { threads } : {}),
  };
}

const CH4_THREADS = [
  { line: '林昭與沈青', type: '关系', what: '兩人結盟' },
  { line: '', type: '收', foreshadowing: '玉佩的來歷', what: '沈青認出雲紋' },
  { line: '青崖舊案', type: '推进', what: '查到火起那一夜' },
  { line: '', type: '埋', foreshadowing: '斷劍', what: '潭底有一把斷劍', resolve: 9 },
  { line: '瞎編的線', type: '推进', what: '認不出' },
];

const PLAN = { stage: 'plot', capability: 'generate' };
const SETTLE = { stage: 'plot', capability: 'settle' };

function reset() {
  t.remove(DIR);
  t.write(PAIR, PAIR_TEXT);
  t.write(MAIN, MAIN_TEXT);
  for (const no of [4, 5, 6]) {
    t.write(PLOT(no), plotText(no));
  }
  t.remove(PLOT(7));
  t.project.invalidate();
  h.setReviewVerdict('apply');
}

/** 單章：照對話頁那條路解析、寫入。 */
async function acceptOne(no, threads, action = PLAN) {
  const target = { kind: 'plot', plotRelPath: PLOT(no) };
  const artifact = bundle.artifact.parseArtifact(action, JSON.stringify({ blueprints: [blueprint(no, threads)] }), target);
  return { artifact, target, result: await bundle.accept.acceptArtifact(t.project, target, artifact) };
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    accept: './src/core/generation/accept.ts',
    artifact: './src/core/features/artifact.ts',
    threadPlan: './src/core/features/threadPlan.ts',
    threadFile: './src/core/model/threadFile.ts',
    workspace: './src/core/workspace/index.ts',
    db: './src/core/runtime/db.ts',
    logger: './src/core/runtime/logger.ts',
    fileOps: './src/core/files/fileOps.ts',
    history: './src/core/workspace/history.ts',
  });
  h = makeFakeHost();
  bundle.host.initHost(h.host);
  t = await makeTempProject(bundle.project, { prefix: 'threadPlan', title: '計劃寫進線裡' });
});

after(() => {
  if (t) cleanup(t.dir, bundle?.db);
});

describe('單章細綱寫入：這一章的計劃寫進各條線', () => {
  let msg;
  before(async () => {
    reset();
    msg = (await acceptOne(4, CH4_THREADS)).result.message;
  });

  test('線的事件落在那條線上，伏筆的事件跟著伏筆走（line 寫空也落在它所在的線上）', () => {
    const pair = t.read(PAIR);
    assert.ok(pair.includes('- 第 4 章 · 計劃 · 關係：兩人結盟'), pair);
    assert.ok(pair.includes('- 第 4 章 · 計劃 · 收〈玉佩的來歷〉：沈青認出雲紋'), pair);
    assert.ok(t.read(MAIN).includes('- 第 4 章 · 計劃 · 推進：查到火起那一夜'), t.read(MAIN));
  });

  test('這一章原來的計劃整組換掉；別的章的計劃、實際事件、作者手寫的行一個字不動、位置不變', () => {
    const pair = t.read(PAIR);
    assert.ok(!pair.includes('舊的計劃，要被換掉'), pair);
    const lines = pair.split('\n');
    const at = (s) => lines.findIndex((l) => l.includes(s));
    assert.ok(at('第 2 章 · 埋〈玉佩的來歷〉') < at('第 4 章 · 計劃 · 關係'));
    assert.ok(at('第 4 章 · 計劃 · 收〈玉佩的來歷〉') < at('作者手寫的一行備註'));
    assert.ok(at('作者手寫的一行備註') < at('第 5 章 · 計劃 · 推進：第 5 章的計劃，不動'));
    assert.ok(pair.startsWith(PAIR_TEXT.slice(0, PAIR_TEXT.indexOf('## 進展'))), '進展之前一個字不動');
  });

  test('沒見過的伏筆被埋、掛不上線：進「未歸屬的伏筆」，登記成計劃第 4 章埋、第 9 章前收', () => {
    const loose = t.read(UNFILED);
    assert.ok(loose.includes('- 斷劍：潭底有一把斷劍（計劃第 4 章埋、第 9 章前收）'), loose);
    assert.ok(loose.includes('- 第 4 章 · 計劃 · 埋〈斷劍〉：潭底有一把斷劍'), loose);
    const book = bundle.threadFile.parseUnfiledFile(loose, UNFILED);
    assert.deepEqual(book.foreshadowing.map((f) => [f.name, f.plant, f.resolve]), [['斷劍', 4, 9]]);
  });

  test('完成提示說寫進幾條、換掉幾條、新伏筆、幾條沒寫進去', () => {
    assert.match(msg, /敘事線記下 4 條計劃（換掉原來的 1 條），新伏筆：斷劍，1 條計劃沒寫進敘事線（見日誌）/);
  });

  test('細綱裡沒有關於線的小節', () => {
    const plot = t.read(PLOT(4));
    assert.ok(!plot.includes('关系') && !plot.includes('斷劍'), plot);
  });
});

describe('寫入卡片上先列出來', () => {
  test('單章：寫哪幾條線、新伏筆進哪、換掉原來的幾條；認不出的另起一行', async () => {
    reset();
    const target = { kind: 'plot', plotRelPath: PLOT(4) };
    const artifact = bundle.artifact.parseArtifact(PLAN, JSON.stringify({ blueprints: [blueprint(4, CH4_THREADS)] }), target);
    const lines = await bundle.threadPlan.describeThreadPlan(t.project, target, artifact);
    assert.deepEqual(lines, [
      '敘事線計劃：林昭與沈青 關係；青崖舊案 推進；收〈玉佩的來歷〉；埋〈斷劍〉（新伏筆，進「未歸屬的伏筆」）（原來的 1 條整組換掉）',
      '沒寫進敘事線的：第 4 章 瞎編的線 推進（認不出是哪一條線）',
    ]);
    assert.ok(!t.has(UNFILED), '列出來不寫盤');
  });

  test('一批：一章一行；合同裡沒寫 threads 的產物沒有這幾行', async () => {
    reset();
    const range = { from: 6, to: 7 };
    const target = { kind: 'plot', plotRelPath: PLOT(6) };
    const raw = JSON.stringify({
      blueprints: [blueprint(6, [{ line: '青崖舊案', type: '推进', what: '六' }]), blueprint(7, [{ line: '林昭與沈青', type: '收束', what: '兩人分開' }])],
    });
    const artifact = bundle.artifact.parseArtifact(PLAN, raw, target, range);
    // 玉佩的來歷第 6 章前收，這一批沒安排：另起一行說出來（復跑之後的程式檢查）。
    assert.deepEqual(await bundle.threadPlan.describeThreadPlan(t.project, target, artifact), [
      '敘事線計劃：\n第 6 章：青崖舊案 推進\n第 7 章：林昭與沈青 收束',
      '到期卻沒安排的伏筆：〈玉佩的來歷〉（第 6 章前收）——這一批既沒安排、也沒寫推遲（照寫不攔，寫前檢查還會提醒）',
    ]);
    const bare = bundle.artifact.parseArtifact(PLAN, JSON.stringify({ blueprints: [blueprint(4)] }), { kind: 'plot', plotRelPath: PLOT(4) });
    assert.deepEqual(await bundle.threadPlan.describeThreadPlan(t.project, { kind: 'plot', plotRelPath: PLOT(4) }, bare), []);
  });
});

describe('重拆、落定、審閱放棄、合同裡沒寫', () => {
  test('重拆一章給空的計劃：那一章的計劃全刪掉，別的章不動；之前登記的伏筆留著（只追加）', async () => {
    reset();
    await acceptOne(4, CH4_THREADS);
    const r = (await acceptOne(4, [])).result;
    assert.match(r.message, /敘事線記下 0 條計劃（換掉原來的 4 條）/);
    const pair = t.read(PAIR);
    assert.ok(!/第 4 章 · 計劃/.test(pair), pair);
    assert.ok(pair.includes('第 5 章 · 計劃 · 推進：第 5 章的計劃，不動'), pair);
    assert.ok(!/第 4 章 · 計劃/.test(t.read(MAIN)));
    const loose = t.read(UNFILED);
    assert.ok(loose.includes('- 斷劍：潭底有一把斷劍') && !loose.includes('第 4 章 · 計劃'), loose);
  });

  test('落定細綱（settle）同一份合同，同樣寫進線裡', async () => {
    reset();
    await acceptOne(5, [{ line: '青崖舊案', type: '推进', what: '討論定下的' }], SETTLE);
    assert.ok(t.read(MAIN).includes('- 第 5 章 · 計劃 · 推進：討論定下的'));
    assert.ok(!t.read(PAIR).includes('第 5 章的計劃，不動'), '第 5 章原來那條計劃換掉了');
  });

  test('合同裡沒寫 threads（手寫的 Markdown、老會話的草稿）：原來的計劃不動', async () => {
    reset();
    await acceptOne(4, undefined);
    assert.equal(t.read(PAIR), PAIR_TEXT);
  });

  test('作者在覆蓋審閱裡放棄了：細綱沒寫進去，計劃也不動', async () => {
    reset();
    h.setReviewVerdict('discard');
    const { result } = await acceptOne(4, CH4_THREADS);
    assert.equal(result.skipped, true);
    assert.equal(t.read(PAIR), PAIR_TEXT);
    assert.ok(!t.has(UNFILED));
    h.setReviewVerdict('apply');
  });

  test('批次只補空白：跳過已有細綱的那一章，它的計劃不動；新寫的那一章寫進去', async () => {
    reset();
    const ws = new bundle.workspace.Workspace(t.project);
    const items = bundle.artifact.parsePlotBatch(
      JSON.stringify({
        blueprints: [blueprint(6, [{ line: '青崖舊案', type: '推进', what: '第 6 章不該寫進去' }]), blueprint(7, [{ line: '青崖舊案', type: '推进', what: '第 7 章' }])],
      }),
      { from: 6, to: 7 }
    );
    const r = await bundle.accept.acceptPlotBatch(t.project, ws, items, { from: 6, to: 7 }, { onlyBlank: true });
    assert.match(r.message, /保留原樣的第 6 章/);
    assert.match(r.message, /敘事線記下 1 條計劃/);
    const main = t.read(MAIN);
    assert.ok(main.includes('- 第 7 章 · 計劃 · 推進：第 7 章') && !main.includes('第 6 章不該寫進去'), main);
  });
});

// 復跑報告問題 3：拆第 11–15 章只排了「推進」，到期該埋的三條伏筆一條也沒排。拆完不調模型地查一遍，到期卻沒安排的說出來。
describe('拆完查一遍：到期卻沒安排的伏筆', () => {
  const NAMEBOOK = [
    '---',
    'kind: 主線',
    'plan: 1-40',
    '---',
    '',
    '# 青崖舊案',
    '',
    '## 意圖',
    '查清那場火。',
    '',
    '## 伏筆',
    '- 名冊：少了一頁（計劃第 3 章埋、第 9 章前收）',
    '- 舊傷：左臂的疤（計劃第 8 章埋）',
    '',
    '## 進展',
    '- 第 1 章 · 推進：起火 〔證據：「火光沖天」〕',
    '',
  ].join('\n');

  test('單章：該埋的（計劃埋的章過了還沒埋）、該收的（回收章到了）沒安排，卡片另起一行、完成提示說一句、日誌記下', async () => {
    reset();
    t.write(MAIN, NAMEBOOK);
    t.project.invalidate();
    const target = { kind: 'plot', plotRelPath: PLOT(6) };
    const threads = [{ line: '青崖舊案', type: '推进', what: '只推進' }];
    const artifact = bundle.artifact.parseArtifact(PLAN, JSON.stringify({ blueprints: [blueprint(6, threads)] }), target);
    const lines = await bundle.threadPlan.describeThreadPlan(t.project, target, artifact);
    assert.equal(
      lines[lines.length - 1],
      '到期卻沒安排的伏筆：〈玉佩的來歷〉（第 6 章前收）、〈名冊〉（計劃第 3 章埋，還沒埋）——本章既沒安排、也沒寫推遲（照寫不攔，寫前檢查還會提醒）'
    );
    bundle.logger.clearLogs();
    const { result } = await acceptOne(6, threads);
    assert.match(result.message, /2 條到期的伏筆沒安排（見日誌）/);
    const logs = bundle.logger.recentLogs();
    assert.ok(logs.some((l) => l.message.includes('到期的伏筆有 2 條沒安排') && l.detail.includes('〈名冊〉')), JSON.stringify(logs));
  });

  test('安排了的、寫明推遲的，不算沒安排；舊傷計劃第 8 章埋，第 6 章還不到', async () => {
    reset();
    t.write(MAIN, NAMEBOOK);
    t.project.invalidate();
    const target = { kind: 'plot', plotRelPath: PLOT(6) };
    const threads = [
      { line: '', type: '收', foreshadowing: '玉佩的來歷', what: '認出雲紋' },
      { line: '青崖舊案', type: '推进', what: '〈名冊〉推遲到第 12 章埋，先查別的' },
    ];
    const artifact = bundle.artifact.parseArtifact(PLAN, JSON.stringify({ blueprints: [blueprint(6, threads)] }), target);
    const lines = await bundle.threadPlan.describeThreadPlan(t.project, target, artifact);
    assert.ok(!lines.some((l) => l.startsWith('到期卻沒安排的伏筆')), lines.join('\n'));
  });
});

// 復跑報告問題 8：刪掉第 13–15 章細綱之後，各條線裡還留著這三章的計劃，重拆時被當成「原來的計劃」交給模型（那時沈懷山
// 已經死了）；不重拆的話寫前提醒也把它算成「安排過」。計劃事件隨細綱走（第 28 條）：刪細綱時一起刪。
describe('刪一章細綱：它寫進線裡的計劃一起刪', () => {
  test('那一章的計劃整組刪掉（各條線與未歸屬的都刪），別的章、實際事件、作者手寫的行不動；改之前存一版歷史', async () => {
    reset();
    await acceptOne(4, CH4_THREADS);
    assert.ok(t.read(PAIR).includes('第 4 章 · 計劃'));
    assert.ok(t.read(UNFILED).includes('第 4 章 · 計劃 · 埋〈斷劍〉'));
    const ws = new bundle.workspace.Workspace(t.project);
    assert.equal(await ws.deletePlot(PLOT(4)), true);
    const pair = t.read(PAIR);
    assert.ok(!/第 4 章 · 計劃/.test(pair), pair);
    assert.ok(pair.includes('- 第 2 章 · 埋〈玉佩的來歷〉：玉佩露面') && pair.includes('作者手寫的一行備註'), pair);
    assert.ok(pair.includes('第 5 章 · 計劃 · 推進：第 5 章的計劃，不動'), pair);
    assert.ok(!/第 4 章 · 計劃/.test(t.read(MAIN)), t.read(MAIN));
    // 登記過的伏筆留著（只追加）；計劃事件刪了。
    const loose = t.read(UNFILED);
    assert.ok(loose.includes('- 斷劍：潭底有一把斷劍') && !loose.includes('第 4 章 · 計劃'), loose);
    const history = await bundle.history.listSnapshots(t.project, PAIR);
    assert.ok(history.length > 0, '改之前存了一版歷史');
  });

  test('確認框上先說有幾條；取消就什麼都不動', async () => {
    reset();
    await acceptOne(4, CH4_THREADS);
    const before = t.read(PAIR);
    h.expect(undefined);
    assert.equal(await bundle.fileOps.deletePlot(t.project, PLOT(4)), false);
    assert.equal(t.read(PAIR), before);
    assert.match(h.confirms[h.confirms.length - 1].detail, /它寫進敘事線裡的 4 條計劃（第 4 章）一起刪掉/);
    h.expect('刪除');
    assert.equal(await bundle.fileOps.deletePlot(t.project, PLOT(4)), true);
    assert.ok(!/第 4 章 · 計劃/.test(t.read(PAIR)));
  });

  test('沒有計劃的章：確認框不提敘事線，線一個字不動', async () => {
    reset();
    const before = t.read(MAIN);
    h.expect('刪除');
    assert.equal(await bundle.fileOps.deletePlot(t.project, PLOT(6)), true);
    assert.doesNotMatch(h.confirms[h.confirms.length - 1].detail, /敘事線/);
    assert.equal(t.read(MAIN), before);
  });
});
