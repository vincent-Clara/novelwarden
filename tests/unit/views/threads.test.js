/**
 * 工程頁「敘事線」頁籤的資料（`views/threads.ts`，敘事線重做第 8 個提交）：一條線一行怎麼寫、怎麼排，「未歸屬的伏筆」
 * 那一行。純函式，輸入是 `readThreads()` 讀出來的整本與「現在」（定稿到的最後一章）。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 主線 → 支線 → 感情線 → 人物線；同種類最近推進的在前，沒推進過的排最後、按計劃開始的章 | 設計稿「七、工程頁」 |
 * | 一行寫種類 · 狀態 · 最近第 N 章 · 幾條伏筆沒收；沒推進過寫計劃區間 | 一眼看出走到哪 |
 * | ⚠ 斷了幾章（主線 5 章 / 其餘 15 章）、幾條伏筆逾期、過了計劃收束的第幾章 | 哪條要管一管 |
 * | 收束了的線不報斷、不報過了收束章 | 走完了的線不是問題 |
 * | 狀態按「現在」算：現在往前挪，⚠ 跟著變 | 狀態不落盤（第 18 條） |
 * | 「未歸屬的伏筆」一條都沒有不給這一行 | 點進去也是空的 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');

const { views, tf } = loadBundle({ views: './src/core/views/threads.ts', tf: './src/core/model/threadFile.ts' });

const DIR = '.novelwarden/threads';

/** 一條線：frontmatter + 伏筆 + 進展，經真解析器讀出來（與 `readThreads` 同一條路）。 */
function line(name, { kind = '支线', plan, intent = '', progress = '', fores = [], events = [] } = {}, index = 0) {
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
    '## 當前進度',
    '',
    progress,
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

const ev = (no, type, what, fore) => `第 ${no} 章 · ${type}${fore ? `〈${fore}〉` : ''}：${what} 〔證據：「原文${no}」〕`;

function book() {
  const threads = [
    line('林昭與沈青', {
      kind: '感情线',
      plan: '3-20',
      intent: '從互相猜忌到並肩',
      progress: '兩人在青崖鎮結盟',
      fores: ['玉佩的來歷：林昭的玉佩是沈家舊物（計劃第 3 章埋、第 8 章前收）', '沈青的舊傷'],
      events: [ev(3, '推进', '初遇'), ev(3, '埋', '玉佩露面', '玉佩的來歷'), ev(5, '关系', '結盟')],
    }, 0),
    line('李叔的舊賬', { kind: '支线', plan: '12-30' }, 1),
    line('青崖舊案', { kind: '主线', plan: '1-60', events: [ev(1, '推进', '回到青崖'), ev(4, '推进', '找到令牌')] }, 2),
    line('守衛的選擇', { kind: '人物线', plan: '2-6', events: [ev(2, '推进', '放走林昭'), ev(6, '收束', '交出令牌')] }, 3),
    line('黑市', { kind: '支线', events: [ev(9, '推进', '開市')] }, 4),
    line('沈家血書', { kind: '支线', plan: '5-' }, 5),
  ];
  return { threads, unfiled: unfiled(['斷劍：劍上刻著青崖二字（第 6 章前收）', '火摺子'], [ev(2, '埋', '斷劍出土', '斷劍')]) };
}

describe('敘事線頁籤 · 一條線一行', () => {
  test('主線 → 支線 → 感情線 → 人物線；同種類最近推進的在前，沒推進過的按計劃開始的章排在最後', () => {
    const v = views.buildThreadsView(book(), 10);
    assert.deepEqual(
      v.lines.map((l) => l.name),
      ['青崖舊案', '黑市', '沈家血書', '李叔的舊賬', '林昭與沈青', '守衛的選擇']
    );
    assert.equal(v.current, 10);
  });

  test('一行：種類 · 狀態 · 最近第 N 章 · 幾條伏筆沒收', () => {
    const v = views.buildThreadsView(book(), 10);
    const pair = v.lines.find((l) => l.name === '林昭與沈青');
    assert.equal(pair.detail, '感情線 · 進行中 · 最近第 5 章 · 2 條伏筆沒收');
    assert.equal(pair.relPath, `${DIR}/林昭與沈青.md`);
    assert.equal(pair.kind, '感情线');
    assert.equal(pair.status, '进行中');
    assert.equal(pair.lastActive, 5);
    assert.ok(pair.tip.includes('意圖：從互相猜忌到並肩') && pair.tip.includes('當前進度：兩人在青崖鎮結盟'), pair.tip);
  });

  test('還沒推進過的寫計劃區間：兩頭都有、只寫開頭、都沒寫', () => {
    const v = views.buildThreadsView(book(), 10);
    const detail = (name) => v.lines.find((l) => l.name === name).detail;
    assert.equal(detail('李叔的舊賬'), '支線 · 計劃中 · 計劃第 12–30 章');
    assert.equal(detail('沈家血書'), '支線 · 計劃中 · 計劃第 5 章起');
  });

  test('⚠：斷了幾章、幾條伏筆逾期、過了計劃收束的第幾章', () => {
    const v = views.buildThreadsView(book(), 22);
    const warn = (name) => v.lines.find((l) => l.name === name).warnings;
    // 感情線 15 章沒動算斷；玉佩第 8 章前該收、還沒收；計劃第 20 章收束、現在第 22 章。
    assert.deepEqual(warn('林昭與沈青'), ['斷了 17 章', '1 條伏筆逾期', '過了計劃收束的第 20 章']);
    // 主線 5 章沒動就算斷。
    assert.deepEqual(warn('青崖舊案'), ['斷了 18 章']);
    // 計劃中的線不算斷；計劃第 30 章收，還沒到。
    assert.deepEqual(warn('李叔的舊賬'), []);
  });

  test('收束了的線不報斷、不報過了收束章，打「已收束」', () => {
    const v = views.buildThreadsView(book(), 40);
    const done = v.lines.find((l) => l.name === '守衛的選擇');
    assert.equal(done.status, '已收束');
    assert.equal(done.detail, '人物線 · 已收束 · 最近第 6 章');
    assert.deepEqual(done.warnings, []);
  });

  test('狀態按「現在」算：現在往前挪，⚠ 跟著變', () => {
    const early = views.buildThreadsView(book(), 6);
    assert.deepEqual(early.lines.find((l) => l.name === '林昭與沈青').warnings, []);
    assert.deepEqual(early.lines.find((l) => l.name === '青崖舊案').warnings, []);
    const later = views.buildThreadsView(book(), 9);
    assert.deepEqual(later.lines.find((l) => l.name === '青崖舊案').warnings, ['斷了 5 章']);
    assert.deepEqual(later.lines.find((l) => l.name === '林昭與沈青').warnings, ['1 條伏筆逾期']);
  });

  // 四期：定稿到第 9 章、敘事線只判到第 6 章（第 7–9 章定稿了還沒判，第 8 章另外判過）——狀態按判到的那一章算，另說哪幾章還沒判。
  test('敘事線落後於定稿：狀態按判到的那一章算，⚠ 不跟著定稿到走；另說「第 a–b 章還沒判」', () => {
    const v = views.buildThreadsView(book(), 9, { mark: { through: 6, judged: [8] }, finalized: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
    assert.equal(v.current, 9);
    assert.equal(v.through, 6);
    assert.deepEqual(v.lag, { count: 2, text: '第 7、9 章還沒判' });
    assert.deepEqual(v.lines.find((l) => l.name === '青崖舊案').warnings, [], '按第 6 章算沒斷');
    assert.deepEqual(v.lines.find((l) => l.name === '林昭與沈青').warnings, [], '按第 6 章算沒逾期');
    // 水位比定稿到還靠後（定稿之後又刪了幾章）：判到不超過定稿到；沒有落後就不給 lag。
    const ahead = views.buildThreadsView(book(), 9, { mark: { through: 12, judged: [] }, finalized: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
    assert.equal(ahead.through, 9);
    assert.equal(ahead.lag, undefined);
    assert.deepEqual(ahead.lines.find((l) => l.name === '青崖舊案').warnings, ['斷了 5 章']);
  });

  test('一條線都沒有：空列表', () => {
    const v = views.buildThreadsView({ threads: [], unfiled: unfiled() }, 3);
    assert.deepEqual(v, { lines: [], current: 3, through: 3, watch: { lines: [], foreshadowing: [], unplanted: [] } });
  });

  // 敘事線二期：寫前檢查要的數也從這裡出（前端批次寫章彈窗拿它算提醒），按現在的樣子算。
  test('寫前檢查要的數：進行中的線與沒收、寫了回收章的伏筆', () => {
    const v = views.buildThreadsView(book(), 9);
    assert.ok(v.watch.lines.some((l) => l.name === '青崖舊案' && l.kind === '主线' && l.stall === 5), JSON.stringify(v.watch));
    assert.ok(v.watch.foreshadowing.every((f) => Number.isInteger(f.resolve)), JSON.stringify(v.watch));
  });
});

describe('敘事線頁籤 · 未歸屬的伏筆', () => {
  test('「N 條」，有收了的另寫幾條沒收；逾期的報 ⚠', () => {
    const b = book();
    b.unfiled = unfiled(['斷劍：劍上刻著青崖二字（第 6 章前收）', '火摺子', '舊信'], [ev(2, '埋', '斷劍出土', '斷劍'), ev(4, '收', '燒了', '舊信')]);
    const v = views.buildThreadsView(b, 10);
    assert.deepEqual(v.unfiled, {
      relPath: `${DIR}/未归属的伏笔.md`,
      total: 3,
      detail: '3 條 · 2 條沒收',
      warnings: ['1 條伏筆逾期'],
    });
  });

  test('只在事件裡出現過名字的也算一條', () => {
    const v = views.buildThreadsView({ threads: [], unfiled: unfiled([], [ev(2, '埋', '有人跟蹤', '黑衣人')]) }, 3);
    assert.equal(v.unfiled.total, 1);
    assert.equal(v.unfiled.detail, '1 條');
  });

  test('一條都沒有（沒有這份檔案、或都挪走了）不給這一行', () => {
    assert.equal(views.buildThreadsView({ threads: [], unfiled: unfiled() }, 3).unfiled, undefined);
    assert.equal(views.buildThreadsView({ threads: [], unfiled: tf.parseUnfiledFile('', `${DIR}/未归属的伏笔.md`) }, 3).unfiled, undefined);
  });
});

// 故事時間（2026-10-24；同日重做：從敘事線組裡的一行改成單獨一組）。
describe('敘事線頁籤 · 時間線一組', () => {
  const tl = loadBundle({ tl: './src/core/model/timelineFile.ts' }).tl;
  const REL = '.novelwarden/threads/时间线.md';
  const timeline = (lines, start = '三月初七') =>
    tl.parseTimelineFile(['---', 'calendar: 簡單歷', `start: ${start}`, '---', '', '# 時間線', '', ...lines, ''].join('\n'), REL);
  const chapters = (n) => Array.from({ length: n }, (_, i) => ({ no: i + 1, title: `第${i + 1}章`, chapterPath: `chapters/00${i + 1}.md`, volume: '' }));
  const progress = (through, finalized, n = 0) => ({ mark: { through, judged: [] }, finalized, ...(n ? { chapters: chapters(n) } : {}) });
  const unfiled = { name: '未歸屬的伏筆', relPath: '', foreshadowing: [], events: [] };

  test('標題：推到第幾章、故事第幾天（現在是哪天、結尾時段）；曆法與起點（標題的懸停）；機器寫的幾行、要補推的', () => {
    const t = timeline([
      '- 第 1 章：+0 天，傍晚〔依據：「起」〕',
      '- 第 2 章：+?〔推不出：沒交代〕',
      '- 第 3 章：過了好一陣',
      '- 第 4 章：八月十五',
      '- 第 5 章：+3 天，清晨 → 夜裡，歷時 2 天〔依據：「三日後」〕',
    ]);
    const v = views.buildThreadsView({ threads: [], unfiled, timeline: t }, 8, progress(7, [1, 2, 3, 4, 5, 6, 7, 8], 8)).timeline;
    assert.equal(v.relPath, REL);
    assert.equal(v.exists, true);
    // 八月十五是第 159 天；第 5 章 +3 天、歷時 2 天：第 162–163 天，八月十八到十九。
    assert.equal(v.label, '推到第 5 章 · 故事第 163 天（八月十九 夜裡）');
    assert.equal(v.calendar.text, '簡單歷 · 起點 三月初七（第 1 章那一天）');
    assert.ok(v.calendar.tip.endsWith('右鍵改曆法與起點。'), v.calendar.tip);
    assert.equal(v.calendar.start, '三月初七');
    assert.equal(v.machine, 3);
    // 要補推的：沒有那一行的（第 6–8 章）與機器寫的 +?（第 2 章）。
    assert.deepEqual(v.missing, { count: 4, text: '第 2、6–8 章還沒推出來' });
    // 推不出、認不出的帶上第一章（點了在總覽裡展開它）；還沒推的不帶。
    assert.deepEqual(v.issues, [
      { text: '第 2 章推不出（按緊接上一章算，右鍵那一章「改時間」）', chapter: 2 },
      { text: '第 3 章那一行認不出（按緊接上一章算）', chapter: 3 },
      { text: '第 6–8 章還沒推：同步過，點標題旁的「補推時間」補上' },
    ]);
    assert.equal(v.last, 8);
  });

  test('章按月分段，一章一行：那一天不帶年份、比上一章、依據；你定的、認不出、還沒推的各有說法', () => {
    const t = timeline([
      '- 第 1 章：+0 天，傍晚〔依據：「起」〕',
      '- 第 2 章：+?〔推不出：沒交代〕',
      '- 第 3 章：過了好一陣',
      '- 第 4 章：八月十五',
      '- 第 5 章：+3 天，清晨 → 夜裡，歷時 2 天〔依據：「三日後」〕',
    ]);
    const v = views.buildThreadsView({ threads: [], unfiled, timeline: t }, 6, progress(6, [1, 2, 3, 4, 5, 6], 6)).timeline;
    assert.deepEqual(v.segments.map((s) => [s.label, s.detail, s.chapters.map((c) => c.no)]), [
      ['三月', '第 1–3 章 · 1 天', [1, 2, 3]],
      ['八月', '第 4–6 章 · 5 天', [4, 5, 6]],
    ]);
    const [c1, c2, c3] = v.segments[0].chapters;
    assert.deepEqual([c1.title, c1.chapterPath, c1.state, c1.when, c1.delta, c1.note, c1.value, c1.machine], ['第1章', 'chapters/001.md', 'evidence', '三月初七 傍晚', undefined, '依據「起」', '+0 天', true]);
    assert.deepEqual([c2.state, c2.when, c2.delta, c2.note, c2.value], ['unknown', '三月初七', '同一天', '推不出：沒交代', '+?']);
    assert.deepEqual([c3.state, c3.when, c3.value, c3.machine], ['bad', '那一行認不出', '', false]);
    const [c4, c5, c6] = v.segments[1].chapters;
    assert.deepEqual([c4.state, c4.when, c4.note, c4.value, c4.machine], ['anchor', '八月十五', '你定的', '八月十五', false]);
    assert.deepEqual([c5.when, c5.delta], ['八月十八 清晨 → 八月十九 夜裡', '+3 天']);
    assert.deepEqual([c6.state, c6.when, c6.value], ['missing', '還沒推', '']);
  });

  test('對賬報了的章標出來；沒起點、正文寫明過日子：起點建議是第一條 ⚠（右鍵填為起點）；沒起點沒有卷時每 20 章一段', () => {
    const t = timeline(['- 第 1 章：+0 天〔依據：「起」〕', '- 第 2 章：+2 天〔依據：「兩日後」〕〔文中：三月初七「三月初七」〕'], '');
    const v = views.buildThreadsView({ threads: [], unfiled, timeline: t }, 2, progress(2, [1, 2])).timeline;
    assert.equal(v.calendar.text, '簡單歷 · 沒填起點，只顯示第幾天');
    assert.deepEqual(v.calendar.suggestion, { start: '三月初五', note: '第 2 章寫了「三月初七」' });
    assert.deepEqual(v.issues[0], { text: '沒填起點：第 2 章寫了「三月初七」，第 1 章是三月初五（右鍵填為起點）', start: true });
    assert.deepEqual(v.segments.map((s) => [s.label, s.detail]), [['第 1–20 章', '第 1–2 章 · 故事第 1–3 天']]);
    const flagged = views.buildThreadsView(
      { threads: [], unfiled, timeline: timeline(['- 第 1 章：+0 天〔依據：「起」〕', '- 第 2 章：+10 天〔依據：「十日後」〕〔文中：三月二十五「三月二十五」〕']) },
      2,
      progress(2, [1, 2])
    ).timeline;
    assert.equal(flagged.segments[0].chapters[1].issue, true);
    assert.equal(flagged.segments[0].chapters[1].state, 'dated');
    assert.equal(flagged.segments[0].chapters[1].note, '正文寫明三月二十五');
    assert.ok(flagged.issues[0].text.startsWith('第 2 章：前面推下來是三月十七，正文寫三月二十五'), flagged.issues[0].text);
    assert.equal(flagged.issues[0].chapter, 2);
  });

  test('沒有檔案、也沒有要補推的：不畫；沒有檔案、有要補推的：畫，exists 為 false、章行寫「還沒推」', () => {
    const empty = tl.emptyTimeline(REL);
    const base = { threads: [], unfiled, timeline: empty };
    assert.equal(views.buildThreadsView(base, 0, progress(0, [])).timeline, undefined);
    // 敘事線一章都沒判也算（補推不再要求判過）。
    const v = views.buildThreadsView(base, 3, progress(0, [1, 2, 3], 3)).timeline;
    assert.equal(v.exists, false);
    assert.equal(v.label, '還沒有一章');
    assert.deepEqual(v.missing, { count: 3, text: '第 1–3 章還沒推出來' });
    assert.deepEqual(v.segments.flatMap((s) => s.chapters.map((c) => [c.no, c.when])), [[1, '還沒推'], [2, '還沒推'], [3, '還沒推']]);
  });

  test('起點認不出：標題的懸停與一條 ⚠ 各說一句，只顯示第幾天', () => {
    const v = views.buildThreadsView({ threads: [], unfiled, timeline: timeline(['- 第 1 章：+0 天', '- 第 2 章：+4 天'], '很久以前') }, 2, progress(2, [1, 2])).timeline;
    assert.equal(v.calendar.text, '簡單歷 · 起點「很久以前」認不出，先只顯示第幾天');
    assert.deepEqual(v.issues[0], { text: '起點「很久以前」認不出，先只顯示第幾天（右鍵改曆法與起點）', start: true });
    assert.equal(v.label, '推到第 2 章 · 故事第 5 天');
  });
});

