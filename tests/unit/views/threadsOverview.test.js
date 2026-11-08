/**
 * 編輯區「敘事線總覽」的矩陣（`views/threads.ts` 的 `buildThreadsMatrix`，敘事線重做三期）：章 × 線。純函式，輸入是
 * `readThreads()` 讀出來的整本、有細綱或正文的那幾章、「現在」（定稿到的最後一章）。讀盤那一半在
 * tests/integration/views/threadsOverview.test.js。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 列：第 1 章到計劃或已寫的最後一章（事件、伏筆的埋與收、線的計劃區間都算），中間沒檔案的補 `none`、卷名沿用前一章 | 設計稿「八」：橫軸是章 |
 * | 提得太遠的截在上限、說原本到第幾章；有檔案的章永遠畫全 | 不靜默截斷 |
 * | 行：按種類分組（主線 → 支線 → 感情線 → 人物線）、組裡的先後同工程頁；一行的說法與工程頁那一行一字不差 | 文案只有一份 |
 * | 線的格子：線自己的事件，計劃與實際分開；伏筆的事件不在這裡 | ○ / ● / ◉ |
 * | 偏差：計劃了、那一章定稿了卻一條實際的都沒有；沒定稿的章不算 | 紅圈 |
 * | 伏筆的格子：埋 / 收 / 棄；計劃埋、計劃收沒發生的是偏差，提前了的不是 | 紅圈 |
 * | 伏筆連線：收了的實線、埋了沒收的虛線延到回收章（推遲了取晚的；逾期延到現在）、還沒埋的按計劃淡虛線 | 設計稿「八」與二期留的問題 |
 * | 「未歸屬的伏筆」：一條都沒有不給 | 同工程頁 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');

const { views, tf } = loadBundle({ views: './src/core/views/threads.ts', tf: './src/core/model/threadFile.ts' });

const DIR = '.novelwarden/threads';

/** 一條線：frontmatter + 伏筆 + 進展，經真解析器讀出來（與 `readThreads` 同一條路）。 */
function line(name, { kind = '支线', plan, intent = '', fores = [], events = [] } = {}, index = 0) {
  const raw = [
    '---',
    `kind: ${kind}`,
    ...(plan ? [`plan: ${plan}`] : []),
    '---',
    '',
    `# ${name}`,
    '',
    '## 意圖',
    '',
    intent,
    '',
    '## 伏筆',
    '',
    ...fores.map((f) => `- ${f}`),
    '',
    '## 進展',
    '',
    ...events.map((e) => `- ${e}`),
    '',
  ].join('\n');
  return tf.parseThreadFile(raw, `${DIR}/${name}.md`, index);
}

function unfiled(fores = [], events = []) {
  const raw = ['# 未歸屬的伏筆', '', '## 伏筆', '', ...fores.map((f) => `- ${f}`), '', '## 進展', '', ...events.map((e) => `- ${e}`), ''].join('\n');
  return tf.parseUnfiledFile(raw, `${DIR}/未归属的伏笔.md`);
}

/** 實際事件（帶證據）與計劃事件。 */
const ev = (no, type, what, fore) => `第 ${no} 章 · ${type}${fore ? `〈${fore}〉` : ''}：${what} 〔證據：「原文${no}」〕`;
const plan = (no, type, what, fore) => `第 ${no} 章 · 計劃 · ${type}${fore ? `〈${fore}〉` : ''}：${what}`;

/** 有細綱或正文的章：第 1–4 章定稿了，第 5 章寫了沒定稿，第 6 章只有細綱；第 3、4 章在第一卷裡。 */
function chapters() {
  const c = (no, state, volume = '') => ({
    no,
    title: `第${no}章標題`,
    volume,
    state,
    ...(state !== 'planned' ? { chapterPath: `chapters/${volume ? `${volume}/` : ''}00${no}.md` } : {}),
    plotPath: `.novelwarden/summaries/${volume ? `${volume}/` : ''}00${no}.md`,
  });
  return [c(1, 'finalized'), c(2, 'finalized'), c(3, 'finalized', '第一卷'), c(4, 'finalized', '第一卷'), c(5, 'written', '第一卷'), c(6, 'planned', '第一卷')];
}

function book() {
  const threads = [
    line(
      '林昭與沈青',
      {
        kind: '感情线',
        plan: '2-12',
        intent: '從互相猜忌到並肩',
        fores: ['玉佩的來歷：林昭的玉佩是沈家舊物（計劃第 2 章埋、第 4 章前收）', '沈青的舊傷：左臂的刀疤（計劃第 3 章埋、第 9 章前收）', '舊信（計劃第 7 章埋、第 10 章前收）'],
        events: [
          plan(2, '推进', '初遇'),
          ev(2, '推进', '鎮口初遇'),
          plan(2, '埋', '玉佩露面', '玉佩的來歷'),
          ev(2, '埋', '玉佩第一次露面', '玉佩的來歷'),
          plan(3, '推进', '結盟'),
          plan(3, '埋', '舊傷', '沈青的舊傷'),
          ev(4, '关系', '猜忌 → 結盟'),
          plan(4, '收', '認出雲紋', '玉佩的來歷'),
          ev(4, '收', '認出雲紋', '玉佩的來歷'),
          plan(5, '推进', '同行'),
          plan(6, '推进', '北上'),
          // 推遲了：伏筆那一行寫第 9 章前收，排細綱時推到第 10 章（二期 ⚑6：那一行不跟著改）。
          plan(10, '收', '揭開舊傷', '沈青的舊傷'),
        ],
      },
      0
    ),
    line('青崖舊案', { kind: '主线', plan: '1-', events: [ev(1, '推进', '回到青崖'), plan(3, '推进', '找到令牌'), ev(3, '推进', '找到令牌'), ev(3, '埋', '令牌背面的字', '令牌')] }, 1),
    line('守衛的選擇', { kind: '人物线', events: [ev(1, '推进', '放走林昭'), ev(2, '收束', '交出令牌')] }, 2),
    line('黑市', { kind: '支线', plan: '7-9' }, 3),
  ];
  return {
    threads,
    unfiled: unfiled(['斷劍：劍上刻著青崖二字（第 3 章前收）', '火摺子'], [ev(1, '埋', '斷劍出土', '斷劍'), ev(2, '弃', '扔進河裡', '火摺子')]),
  };
}

const lineOf = (m, name) => m.groups.flatMap((g) => g.lines).find((l) => l.name === name);
const foreOf = (l, name) => l.foreshadowing.find((f) => f.name === name);
const cellAt = (row, no) => row.cells.find((c) => c.chapter === no);

describe('敘事線總覽 · 列', () => {
  test('第 1 章到計劃或已寫的最後一章，一章不缺；沒檔案的章補 none、卷名沿用前一章', () => {
    const m = views.buildThreadsMatrix(book(), chapters(), 4);
    // 伏筆「舊信」計劃第 10 章前收、線「林昭與沈青」計劃第 12 章收束：都是計劃，列畫到第 12 章。
    assert.deepEqual(m.chapters.map((c) => c.no), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.deepEqual(m.chapters.map((c) => c.state), ['finalized', 'finalized', 'finalized', 'finalized', 'written', 'planned', 'none', 'none', 'none', 'none', 'none', 'none']);
    assert.equal(m.chapters[2].volume, '第一卷');
    assert.equal(m.chapters[0].volume, '');
    assert.equal(m.chapters[9].volume, '第一卷', '沒檔案的章沿用前一章的卷');
    assert.equal(m.chapters[6].title, '');
    assert.equal(m.chapters[0].chapterPath, 'chapters/001.md');
    assert.equal(m.chapters[5].chapterPath, undefined);
    assert.equal(m.volumes, true);
    assert.equal(m.current, 4);
    assert.equal(m.clippedFrom, undefined);
  });

  test('沒有分卷：volumes 是 false；一條線、一章都沒有：空的', () => {
    const flat = chapters().map((c) => ({ ...c, volume: '' }));
    assert.equal(views.buildThreadsMatrix(book(), flat, 4).volumes, false);
    const empty = views.buildThreadsMatrix({ threads: [], unfiled: unfiled() }, [], 0);
    assert.deepEqual(empty, { chapters: [], current: 0, through: 0, volumes: false, groups: [] });
  });

  test('計劃裡提得太遠（手誤）：截在上限、說原本到第幾章；有檔案的章照樣畫全', () => {
    const b = { threads: [line('黑市', { plan: '2-30000' })], unfiled: unfiled() };
    const m = views.buildThreadsMatrix(b, chapters(), 4, { limit: 50 });
    assert.equal(m.chapters.length, 50);
    assert.equal(m.clippedFrom, 30000);
    const many = Array.from({ length: 60 }, (_, i) => ({ no: i + 1, title: '', volume: '', state: 'planned', plotPath: `p/${i + 1}.md` }));
    assert.equal(views.buildThreadsMatrix(b, many, 0, { limit: 50 }).chapters.length, 60, '有細綱的章不截');
  });
});

describe('敘事線總覽 · 行', () => {
  test('按種類分組：主線 → 支線 → 感情線 → 人物線；組裡的先後、一行的說法與工程頁一樣', () => {
    const b = book();
    const m = views.buildThreadsMatrix(b, chapters(), 4);
    assert.deepEqual(m.groups.map((g) => g.kind), ['主线', '支线', '感情线', '人物线']);
    assert.deepEqual(m.groups.map((g) => g.lines.map((l) => l.name)), [['青崖舊案'], ['黑市'], ['林昭與沈青'], ['守衛的選擇']]);
    const pane = views.buildThreadsView(b, 4);
    for (const l of pane.lines) {
      const row = lineOf(m, l.name);
      assert.equal(row.detail, l.detail);
      assert.deepEqual(row.warnings, l.warnings);
      assert.equal(row.tip, l.tip);
      assert.equal(row.status, l.status);
      assert.equal(row.relPath, l.relPath);
    }
    assert.equal(lineOf(m, '林昭與沈青').from, 2);
    assert.equal(lineOf(m, '林昭與沈青').to, 12);
    assert.equal(lineOf(m, '青崖舊案').to, undefined);
  });

  test('每條線下面是它的伏筆：「伏筆」一節寫了的在前，只在事件裡出現過的跟在後面', () => {
    const m = views.buildThreadsMatrix(book(), chapters(), 4);
    assert.deepEqual(lineOf(m, '林昭與沈青').foreshadowing.map((f) => f.name), ['玉佩的來歷', '沈青的舊傷', '舊信']);
    assert.deepEqual(lineOf(m, '青崖舊案').foreshadowing.map((f) => f.name), ['令牌']);
    assert.deepEqual(lineOf(m, '黑市').foreshadowing, []);
  });

  test('「未歸屬的伏筆」在最後；一條都沒有不給', () => {
    const m = views.buildThreadsMatrix(book(), chapters(), 4);
    assert.equal(m.unfiled.relPath, `${DIR}/未归属的伏笔.md`);
    assert.deepEqual(m.unfiled.foreshadowing.map((f) => f.name), ['斷劍', '火摺子']);
    const b = book();
    b.unfiled = unfiled();
    assert.equal(views.buildThreadsMatrix(b, chapters(), 4).unfiled, undefined);
  });
});

describe('敘事線總覽 · 線的格子', () => {
  test('只給有事件的章；計劃與實際分開；伏筆的事件不線上這一行', () => {
    const pair = lineOf(views.buildThreadsMatrix(book(), chapters(), 4), '林昭與沈青');
    assert.deepEqual(pair.cells.map((c) => c.chapter), [2, 3, 4, 5, 6]);
    const two = cellAt(pair, 2);
    assert.deepEqual(two.planned, [{ type: '推进', what: '初遇' }]);
    assert.deepEqual(two.actual, [{ type: '推进', what: '鎮口初遇', evidence: '原文2' }]);
    // 第 2 章的埋〈玉佩的來歷〉在伏筆那一行。
    assert.ok(pair.cells.every((c) => [...c.planned, ...c.actual].every((e) => !e.foreshadowing)));
  });

  test('四種：只有計劃 / 只有實際 / 計劃也發生了 / 計劃了、定稿了卻沒發生（偏差）', () => {
    const pair = lineOf(views.buildThreadsMatrix(book(), chapters(), 4), '林昭與沈青');
    // 第 2 章：計劃推進、也推進了。
    assert.equal(cellAt(pair, 2).deviation, false);
    // 第 3 章：計劃結盟，第 3 章定稿了卻一條實際的都沒有——偏差。
    assert.deepEqual(cellAt(pair, 3).actual, []);
    assert.equal(cellAt(pair, 3).deviation, true);
    // 第 4 章：只有實際（關係）。
    assert.deepEqual(cellAt(pair, 4).planned, []);
    assert.equal(cellAt(pair, 4).deviation, false);
    // 第 5 章寫了沒定稿、第 6 章只有細綱：只有計劃，不是偏差。
    assert.equal(cellAt(pair, 5).deviation, false);
    assert.equal(cellAt(pair, 6).deviation, false);
  });

  test('偏差比的是「那一章定稿了沒有」，不是「現在」：現在挪到第 6 章，沒定稿的第 5 章照樣不算', () => {
    const pair = lineOf(views.buildThreadsMatrix(book(), chapters(), 6), '林昭與沈青');
    assert.equal(cellAt(pair, 5).deviation, false);
  });

  // 四期：定稿到第 4 章、敘事線只判到第 2 章——第 3、4 章定稿了還沒判，列頭另標，上面的計劃不算偏差；狀態按第 2 章算。
  test('敘事線落後於定稿：還沒判的列標 unjudged、計劃不算偏差；判到第幾章另給；逾期按判到的那一章算', () => {
    const m = views.buildThreadsMatrix(book(), chapters(), 4, { mark: { through: 2, judged: [] } });
    assert.equal(m.current, 4);
    assert.equal(m.through, 2);
    assert.deepEqual(
      m.chapters.slice(0, 5).map((c) => [c.no, c.state, !!c.unjudged]),
      [[1, 'finalized', false], [2, 'finalized', false], [3, 'finalized', true], [4, 'finalized', true], [5, 'written', false]]
    );
    const pair = lineOf(m, '林昭與沈青');
    assert.equal(cellAt(pair, 3).deviation, false, '第 3 章還沒判，計劃結盟不算偏差');
    assert.equal(cellAt(foreOf(pair, '沈青的舊傷'), 3).deviation, false);
    // 「斷劍」第 3 章前收：按定稿到（第 4 章）算是逾期，按判到（第 2 章）算還沒到。
    assert.equal(foreOf(m.unfiled, '斷劍').overdue, false);
    assert.equal(foreOf(views.buildThreadsMatrix(book(), chapters(), 4).unfiled, '斷劍').overdue, true);
    // 水位之後另外判過的那一章照算偏差、不標還沒判。
    const sparse = views.buildThreadsMatrix(book(), chapters(), 4, { mark: { through: 1, judged: [3] } });
    assert.equal(sparse.chapters[2].unjudged, undefined);
    assert.equal(cellAt(lineOf(sparse, '林昭與沈青'), 3).deviation, true);
    assert.equal(sparse.chapters[1].unjudged, true);
  });
});

describe('敘事線總覽 · 伏筆的格子與連線', () => {
  test('收了的：埋 ● 到收 ◆ 實線；計劃埋、計劃收都發生了，不是偏差', () => {
    const jade = foreOf(lineOf(views.buildThreadsMatrix(book(), chapters(), 4), '林昭與沈青'), '玉佩的來歷');
    assert.equal(jade.status, '已收');
    assert.equal(jade.plantedAt, 2);
    assert.equal(jade.closedAt, 4);
    assert.deepEqual(jade.span, { from: 2, to: 4, kind: 'done' });
    assert.deepEqual(jade.cells.map((c) => c.chapter), [2, 4]);
    assert.deepEqual(cellAt(jade, 4).actual, [{ type: '收', foreshadowing: '玉佩的來歷', what: '認出雲紋', evidence: '原文4' }]);
    assert.ok(jade.cells.every((c) => !c.deviation));
    assert.equal(jade.overdue, false);
    assert.match(jade.tip, /林昭的玉佩是沈家舊物/);
    assert.match(jade.tip, /計劃第 2 章埋、第 4 章前收/);
    assert.match(jade.tip, /第 4 章收了/);
  });

  test('計劃第 3 章埋、第 3 章定稿了卻沒埋：偏差；還沒埋，按計劃畫淡虛線到回收章（推遲的收更晚，取晚的）', () => {
    const scar = foreOf(lineOf(views.buildThreadsMatrix(book(), chapters(), 4), '林昭與沈青'), '沈青的舊傷');
    assert.equal(scar.status, '计划');
    assert.equal(cellAt(scar, 3).deviation, true);
    assert.deepEqual(cellAt(scar, 3).planned, [{ type: '埋', foreshadowing: '沈青的舊傷', what: '舊傷' }]);
    // 計劃第 10 章收（還沒到，第 10 章也沒定稿）：不是偏差。
    assert.equal(cellAt(scar, 10).deviation, false);
    // 伏筆那一行寫第 9 章前收，計劃裡推到第 10 章收：取晚的第 10 章。
    assert.deepEqual(scar.span, { from: 3, to: 10, kind: 'planned' });
    assert.match(scar.tip, /還沒埋/);
  });

  test('埋了沒收：虛線從埋的那一章延到回收章；沒寫回收章的延到現在', () => {
    const m = views.buildThreadsMatrix(book(), chapters(), 4);
    // 「斷劍」第 1 章埋、第 3 章前收、現在第 4 章：逾期，虛線延到現在。
    const sword = foreOf(m.unfiled, '斷劍');
    assert.equal(sword.overdue, true);
    assert.deepEqual(sword.span, { from: 1, to: 4, kind: 'open' });
    assert.match(sword.tip, /過了第 3 章（逾期）/);
    // 「令牌」第 3 章埋、什麼都沒寫：延到現在第 4 章。
    const token = foreOf(lineOf(m, '青崖舊案'), '令牌');
    assert.deepEqual(token.span, { from: 3, to: 4, kind: 'open' });
    assert.equal(token.overdue, false);
  });

  test('棄了的：只有棄那一格、沒埋過不連線', () => {
    const fire = foreOf(views.buildThreadsMatrix(book(), chapters(), 4).unfiled, '火摺子');
    assert.equal(fire.status, '已弃');
    assert.equal(fire.closedAt, 2);
    assert.equal(fire.span, undefined);
    assert.deepEqual(cellAt(fire, 2).actual.map((e) => e.type), ['弃']);
  });

  test('只寫了計劃（伏筆那一行），一條事件都沒有：沒有格子，有淡虛線', () => {
    const letter = foreOf(lineOf(views.buildThreadsMatrix(book(), chapters(), 4), '林昭與沈青'), '舊信');
    assert.deepEqual(letter.cells, []);
    assert.deepEqual(letter.span, { from: 7, to: 10, kind: 'planned' });
  });

  test('提前埋了的不算偏差；計劃收、到那一章還沒收的才算', () => {
    const b = {
      threads: [
        line('支線甲', {
          fores: ['密信'],
          events: [ev(1, '埋', '密信露面', '密信'), plan(2, '埋', '再提密信', '密信'), plan(3, '收', '拆開密信', '密信')],
        }),
      ],
      unfiled: unfiled(),
    };
    const row = foreOf(lineOf(views.buildThreadsMatrix(b, chapters(), 4), '支線甲'), '密信');
    assert.equal(cellAt(row, 2).deviation, false, '第 1 章已經埋了');
    assert.equal(cellAt(row, 3).deviation, true, '第 3 章該收沒收');
  });
});

// 故事時間（2026-10-24）：伏筆埋了多少天。同日「時間線總覽」：「時間線」一組與月份帶挪去時間線總覽（tests/unit/views/timeline.test.js），
// 這裡每列只留一句「這一章是哪天」（懸停用）。
describe('總覽 · 故事時間', () => {
  const tl = loadBundle({ tl: './src/core/model/timelineFile.ts' }).tl;
  const timeline = (lines, start = '三月初七') =>
    tl.parseTimelineFile(['---', 'calendar: 簡單歷', `start: ${start}`, '---', '', '# 時間線', '', ...lines, ''].join('\n'), `${DIR}/时间线.md`);
  const LINES = [
    '- 第 1 章：+0 天，傍晚〔依據：「起」〕',
    '- 第 2 章：+2 天〔推測：趕路〕',
    '- 第 3 章：+1 天〔依據：「次日」〕',
    '- 第 4 章：+5 天，歷時 2 天',
  ];

  test('每列一句「這一章是哪天」；不再給 timeline（沒有「時間線」一組與月份帶）；回憶、沒起點照寫', () => {
    const m = views.buildThreadsMatrix({ ...book(), timeline: timeline([...LINES, '- 第 5 章：回憶，約二十年前']) }, chapters(), 4);
    assert.equal(m.timeline, undefined);
    assert.deepEqual(
      m.chapters.slice(0, 6).map((c) => c.time),
      ['三月初七 傍晚', '三月初九', '三月初十', '三月十五', '回憶（約二十年前）', undefined]
    );
    const bare = views.buildThreadsMatrix({ ...book(), timeline: timeline(LINES, '') }, chapters(), 4);
    assert.deepEqual(bare.chapters.slice(0, 4).map((c) => c.time), ['第 1 天 傍晚', '第 3 天', '第 4 天', '第 9 天']);
    // 沒有時間線：列上沒有 time。
    assert.ok(views.buildThreadsMatrix(book(), chapters(), 4).chapters.every((c) => !c.time));
  });

  test('時間線寫到更後面的章：列不跟著加（總覽只畫線與伏筆用得到的章）', () => {
    const m = views.buildThreadsMatrix({ ...book(), timeline: timeline([...LINES, '- 第 14 章：+1 天']) }, chapters(), 4);
    assert.ok(m.chapters.length < 14, String(m.chapters.length));
  });

  test('埋了沒收的伏筆：懸停說故事裡過了幾天（埋的那一章開頭到敘事線判到的那一章結尾）', () => {
    const m = views.buildThreadsMatrix({ ...book(), timeline: timeline(LINES) }, chapters(), 4);
    const token = foreOf(lineOf(m, '青崖舊案'), '令牌');
    assert.ok(token.tip.includes('第 3 章埋下，還沒收（故事裡已經過了 6 天）'), token.tip);
  });
});
