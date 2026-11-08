/**
 * 編輯區「時間線總覽」的資料（`views/timeline.ts` 的 `buildTimelineMatrix`，2026-10-24，設計稿 docs/design/plans/2026-10-24-timeline-page.md）：
 * 豎著按故事日子排，一個日子一項、一章一張卡片。純函式，輸入是 `readThreads()` 讀出來的整本（帶時間線）與有細綱或正文的那幾章。
 * 讀盤那一半在 tests/integration/views/timelineOverview.test.js。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 一個日子一項，按故事日子從早到晚；同一天的幾章按章號；往回跳的章排到它那一天（⚑1） | 時間線看的是故事裡的先後，不是章號 |
 * | 軸上寫不帶年份的日子、小字第幾天；月份與季節（填了起點才有）；沒起點只寫第幾天 | 豎軸 + 月份分隔 |
 * | 卡片：時段（跨天的寫到哪天、幾天）、比上一章、依據；這一章在各條線上的實際事件（計劃的不給），沒有事件給梗概 | 作者定的第 2 條 |
 * | 線的顏色按種類與目錄裡的先後 8 色迴圈，「未歸屬的伏筆」灰（-1）；篩選下拉只列有實際事件的線 | ⚑4 |
 * | 回憶的章掛在閱讀順序上前一章那一天裡；前面沒有章的掛在第一天 | ⚑5 |
 * | 對賬報了的章：卡片上一條一行（去掉「第 N 章：」），`problem`；推不出、認不出也算 problem | 「只看有問題的」 |
 * | 標題欄：曆法、起點、推到哪；補推、重推、改起點要的數與工程頁那一組同一份 | 文案只有一份 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');

const { views, tf, tl } = loadBundle({
  views: './src/core/views/timeline.ts',
  tf: './src/core/model/threadFile.ts',
  tl: './src/core/model/timelineFile.ts',
});

const DIR = '.novelwarden/threads';
const REL = `${DIR}/时间线.md`;

const timeline = (lines, start = '三月初七') =>
  tl.parseTimelineFile(['---', 'calendar: 簡單歷', `start: ${start}`, '---', '', '# 時間線', '', ...lines, ''].join('\n'), REL);

function line(name, kind, events, index = 0) {
  const raw = ['---', `kind: ${kind}`, '---', '', `# ${name}`, '', '## 意圖', '', '', '## 伏筆', '', '', '## 進展', '', ...events.map((e) => `- ${e}`), ''].join('\n');
  return tf.parseThreadFile(raw, `${DIR}/${name}.md`, index);
}

function unfiled(events = []) {
  const raw = ['# 未歸屬的伏筆', '', '## 伏筆', '', '', '## 進展', '', ...events.map((e) => `- ${e}`), ''].join('\n');
  return tf.parseUnfiledFile(raw, `${DIR}/未归属的伏笔.md`);
}

const ev = (no, type, what, fore) => `第 ${no} 章 · ${type}${fore ? `〈${fore}〉` : ''}：${what} 〔證據：「原文${no}」〕`;
const plan = (no, type, what) => `第 ${no} 章 · 計劃 · ${type}：${what}`;

/** 有細綱或正文的章：都同步過；第 3 章細綱寫了梗概與時間地點。 */
function chapters(n = 6) {
  return Array.from({ length: n }, (_, i) => {
    const no = i + 1;
    return {
      no,
      title: `章${no}`,
      chapterPath: `chapters/00${no}.txt`,
      plotPath: `.novelwarden/summaries/00${no}.md`,
      synopsis: no === 3 ? '林昭夜探青崖鎮，撞見黑衣人。' : '',
      timePlace: no === 3 ? '次日夜裡，青崖鎮' : '',
      finalized: true,
    };
  });
}

function book(lines, threads, unfiledEvents = []) {
  return { threads, unfiled: unfiled(unfiledEvents), timeline: timeline(lines) };
}

describe('時間線總覽 · 軸', () => {
  const LINES = [
    '- 第 1 章：+0 天，傍晚 → 深夜〔依據：「連日大雨的第三天傍晚」〕',
    '- 第 2 章：+0 天，深夜〔依據：「當夜」〕',
    '- 第 3 章：+5 天，清晨 → 夜裡，歷時 3 天〔依據：「五日後的清晨」〕',
    '- 第 4 章：回憶，約二十年前〔依據：「二十年前」〕',
    '- 第 5 章：+1 天〔推測：趕路〕',
  ];

  test('一個日子一項：同一天的幾章疊在一起；日子不帶年份、小字第幾天；月份與季節', () => {
    const m = views.buildTimelineMatrix(book(LINES, []), chapters(5));
    assert.deepEqual(
      m.days.map((d) => [d.day, d.label, d.sub, d.full, d.month, d.season, d.cards.map((c) => c.no)]),
      [
        [1, '三月初七', '第 1 天', '三月初七', '三月', '春', [1, 2]],
        // 第 4 章是回憶：掛在閱讀順序上前一章（第 3 章）那一天裡，跟在它後面。
        [6, '三月十二', '第 6 天', '三月十二', '三月', '春', [3, 4]],
        // 第 3 章歷時 3 天，到第 8 天；第 5 章 +1 天是第 9 天。
        [9, '三月十五', '第 9 天', '三月十五', '三月', '春', [5]],
      ]
    );
  });

  test('卡片：時段（跨天的寫到哪天、幾天）、比上一章、依據；回憶寫多久以前、標 flashback', () => {
    const m = views.buildTimelineMatrix(book(LINES, []), chapters(5));
    const cards = new Map(m.days.flatMap((d) => d.cards).map((c) => [c.no, c]));
    assert.deepEqual([cards.get(1).when, cards.get(1).delta, cards.get(1).note, cards.get(1).state], ['傍晚 → 深夜', undefined, '依據「連日大雨的第三天傍晚」', 'evidence']);
    assert.deepEqual([cards.get(2).when, cards.get(2).delta], ['深夜', '同一天']);
    assert.deepEqual([cards.get(3).when, cards.get(3).delta], ['清晨 → 三月十四 夜裡 · 3 天', '+5 天']);
    assert.deepEqual([cards.get(4).when, cards.get(4).flashback, cards.get(4).delta], ['回憶（約二十年前）', true, undefined]);
    assert.deepEqual([cards.get(5).when, cards.get(5).note, cards.get(5).state], ['', '推測：趕路', 'guess']);
    // 詳情：全稱、第幾天、歷時、依據；細綱的時間地點。
    assert.ok(cards.get(3).detail.includes('故事第 6 天，歷時 3 天，到三月十四；比上一章：+5 天'), cards.get(3).detail.join('\n'));
    assert.ok(cards.get(3).detail.includes('細綱寫的時間地點：次日夜裡，青崖鎮'), cards.get(3).detail.join('\n'));
    assert.equal(cards.get(1).chapterPath, 'chapters/001.txt');
    assert.equal(cards.get(1).plotPath, '.novelwarden/summaries/001.md');
    assert.equal(cards.get(1).machine, true);
  });

  test('往回跳的章排到它那一天（⚑1），對賬照舊報它：卡片上去掉「第 N 章：」，標 problem', () => {
    const m = views.buildTimelineMatrix(book(['- 第 1 章：+0 天〔依據：「起」〕', '- 第 2 章：+4 天〔依據：「四日後」〕', '- 第 3 章：-3 天〔依據：「三日前」〕'], []), chapters(3));
    assert.deepEqual(m.days.map((d) => [d.day, d.cards.map((c) => c.no)]), [[1, [1]], [2, [3]], [5, [2]]]);
    const back = m.days[1].cards[0];
    assert.deepEqual(back.issues, ['比上一章往回跳了 3 天，又沒標回憶']);
    assert.equal(back.problem, true);
    assert.equal(m.days[0].cards[0].problem, false);
  });

  test('沒起點：軸上只寫第幾天，沒有小字、月份與季節', () => {
    const bare = { threads: [], unfiled: unfiled(), timeline: timeline(LINES, '') };
    const m = views.buildTimelineMatrix(bare, chapters(5));
    assert.deepEqual(m.days.map((d) => [d.label, d.sub, d.month, d.season]), [
      ['第 1 天', undefined, undefined, undefined],
      ['第 6 天', undefined, undefined, undefined],
      ['第 9 天', undefined, undefined, undefined],
    ]);
    assert.equal(m.meta, '簡單歷 · 沒填起點 · 推到第 5 章 · 故事第 9 天');
  });

  test('第 1 章就是回憶：掛在第一天，排在最前面；推不出、認不出的照推算的位置放、標 problem', () => {
    const m = views.buildTimelineMatrix(book(['- 第 1 章：回憶', '- 第 2 章：+0 天〔依據：「起」〕', '- 第 3 章：+?〔推不出：沒交代〕', '- 第 4 章：過了好一陣'], []), chapters(4));
    assert.deepEqual(m.days.map((d) => [d.day, d.cards.map((c) => [c.no, c.state, c.problem])]), [
      [1, [[1, 'flashback', false], [2, 'evidence', false], [3, 'unknown', true], [4, 'bad', true]]],
    ]);
    assert.equal(m.days[0].cards[3].when, '那一行認不出');
  });

  test('整本只有回憶：給一個第 0 天，寫「回憶」', () => {
    const m = views.buildTimelineMatrix(book(['- 第 1 章：回憶'], []), chapters(1));
    assert.deepEqual(m.days.map((d) => [d.day, d.label, d.cards.map((c) => c.no)]), [[0, '回憶', [1]]]);
  });
});

describe('時間線總覽 · 卡片上的事件', () => {
  const LINES = ['- 第 1 章：+0 天〔依據：「起」〕', '- 第 2 章：+1 天〔依據：「次日」〕', '- 第 3 章：+1 天〔依據：「又一日」〕'];
  const threads = () => [
    line('林昭與沈青', '感情线', [ev(1, '推进', '鎮口初遇'), plan(2, '推进', '結盟'), ev(2, '埋', '玉佩露面', '玉佩的來歷')], 1),
    line('名冊之謎', '主线', [ev(2, '推进', '拿到名冊')], 2),
    line('黑市', '支线', [plan(3, '推进', '進黑市')], 0),
  ];

  test('實際事件按線的先後（主線 → 支線 → 感情線 → 人物線，同種類按目錄）、帶顏色與證據；計劃的不給；沒事件的章給梗概', () => {
    const m = views.buildTimelineMatrix(book(LINES, threads(), [ev(2, '埋', '斷劍', '斷劍')]), chapters(3));
    const cards = m.days.flatMap((d) => d.cards);
    assert.deepEqual(cards[0].events, [{ thread: '林昭與沈青', color: 2, type: '推进', what: '鎮口初遇', evidence: '原文1' }]);
    assert.deepEqual(
      cards[1].events.map((e) => [e.thread, e.color, e.type, e.foreshadowing, e.what]),
      [
        ['名冊之謎', 0, '推进', undefined, '拿到名冊'],
        ['林昭與沈青', 2, '埋', '玉佩的來歷', '玉佩露面'],
        ['未歸屬的伏筆', -1, '埋', '斷劍', '斷劍'],
      ]
    );
    // 第 3 章只有計劃：沒有事件，給細綱的梗概。
    assert.deepEqual([cards[2].events, cards[2].synopsis], [[], '林昭夜探青崖鎮，撞見黑衣人。']);
    assert.equal(cards[1].synopsis, undefined);
  });

  test('篩選下拉的線：只列有實際事件的，顏色同卡片；「未歸屬的伏筆」排最後', () => {
    const m = views.buildTimelineMatrix(book(LINES, threads(), [ev(2, '埋', '斷劍', '斷劍')]), chapters(3));
    assert.deepEqual(m.threads, [
      { name: '名冊之謎', color: 0 },
      { name: '林昭與沈青', color: 2 },
      { name: '未歸屬的伏筆', color: -1 },
    ]);
    const quiet = views.buildTimelineMatrix(book(LINES, threads()), chapters(3));
    assert.ok(!quiet.threads.some((t) => t.name === '未歸屬的伏筆'));
  });

  test('顏色不迴圈：前 8 條線各一色，第 9 條起與「未歸屬的伏筆」一樣灰（-1）', () => {
    const many = Array.from({ length: 10 }, (_, i) => line(`線${i}`, '支线', [ev(1, '推进', `事${i}`)], i));
    const m = views.buildTimelineMatrix(book(LINES, many), chapters(3));
    assert.deepEqual(m.threads.map((t) => t.color), [0, 1, 2, 3, 4, 5, 6, 7, -1, -1]);
  });

  test('卡片帶結尾是第幾天（前端算「N 天后」）；回憶沒有', () => {
    const m = views.buildTimelineMatrix(book(['- 第 1 章：+0 天，歷時 3 天', '- 第 2 章：回憶'], []), chapters(2));
    assert.deepEqual(m.days[0].cards.map((c) => [c.no, c.end]), [[1, 3], [2, undefined]]);
  });
});

describe('時間線總覽 · 標題欄與動作', () => {
  test('標題欄：曆法、起點、推到哪；懸停是曆法怎麼算；補推、重推、起點建議與工程頁那一組同一份', () => {
    const t = timeline(['- 第 1 章：+0 天〔依據：「起」〕', '- 第 2 章：+2 天〔依據：「兩日後」〕〔文中：三月初七「三月初七」〕'], '');
    const m = views.buildTimelineMatrix({ threads: [], unfiled: unfiled(), timeline: t }, chapters(4));
    assert.equal(m.relPath, REL);
    assert.equal(m.exists, true);
    assert.equal(m.meta, '簡單歷 · 沒填起點 · 推到第 2 章 · 故事第 3 天');
    assert.ok(m.tip.startsWith('簡單歷 · 沒填起點，只顯示第幾天\n簡單歷：每月 30 天'), m.tip);
    assert.deepEqual(m.calendar, { name: '简单历', start: '', suggestion: { start: '三月初五', note: '第 2 章寫了「三月初七」' } });
    assert.deepEqual(m.issues.map((i) => i.text), ['沒填起點：第 2 章寫了「三月初七」，第 1 章是三月初五（右鍵填為起點）', '第 3–4 章還沒推：同步過，點標題旁的「補推時間」補上']);
    assert.deepEqual(m.missing, { count: 2, text: '第 3–4 章還沒推出來' });
    assert.equal(m.machine, 2);
    assert.equal(m.last, 4);
    // 還沒推的章（時間線寫到的最後一章之後）不上軸（⚑6）。
    assert.deepEqual(m.days.flatMap((d) => d.cards.map((c) => c.no)), [1, 2]);
  });

  test('沒有時間線檔案、也沒有要補推的：exists 為 false，什麼都沒有', () => {
    const m = views.buildTimelineMatrix({ threads: [], unfiled: unfiled(), timeline: tl.emptyTimeline(REL) }, chapters(2).map((c) => ({ ...c, finalized: false })));
    assert.deepEqual([m.exists, m.days, m.issues, m.relPath], [false, [], [], REL]);
    // 手搭的整本沒有時間線：一樣。
    assert.equal(views.buildTimelineMatrix({ threads: [], unfiled: unfiled() }, []).exists, false);
  });
});
