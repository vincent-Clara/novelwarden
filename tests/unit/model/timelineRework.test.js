/**
 * 故事時間重做（2026-10-24，docs/design/plans/2026-10-24-story-timeline-rework.md）：一行多了結尾時段、〔文中〕〔季節〕；推算時按正文寫明的
 * 日子對齊；對賬；起點建議；同步、重推時機器寫的行照新推的換；認時間的新輸出。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 結尾時段、〔文中〕〔季節〕幾種寫法都認，幾段先後不限；寫回再讀得出同樣的東西；老寫法照認 | 設計稿「一」；第 1 條 |
 * | 有起點時按〔文中〕對齊、後面順延；取離推算最近的那一個；`+?` 遇上它記「正文寫明」；作者錨點與第 1 章不對齊 | 設計稿「二」，⚑1、⚑2 |
 * | 節日按曆法換日子：簡單歷按農曆口徑，公曆只認公曆節日 | ⚑4 |
 * | 對賬：偏差 ≥ 2 天、你定的對不上、季節對不上、往回跳、連著推不出 | 設計稿「二 · 對賬」 |
 * | 起點建議：沒起點時按第一次正文寫明的日子倒推 | 設計稿「二」 |
 * | 機器寫的行：refresh 換、fill 只填空；作者的行兩種都不動 | ⚑7；第 28 條 |
 * | 認時間的新輸出：jumps 相加成歷時、證據找不到的一跳不算；〔文中〕證據裡要寫著這一天；〔季節〕證據要在正文裡 | 設計稿「三 · 校驗」 |
 * | 「前面幾章的時間」帶結尾時段 | 設計稿「三 · 輸入」 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const t = loadModule('src/core/model/timelineFile.ts');

const REL = '.novelwarden/threads/时间线.md';

function file(start, lines, calendar = '简单历') {
  return ['---', `calendar: ${calendar}`, `start: ${start}`, 'generatedBy: novelwarden', '---', '', '# 時間線', '', ...lines, ''].join('\n');
}
const tlOf = (start, lines, calendar) => t.parseTimelineFile(file(start, lines, calendar), REL);
const entry = (line, cal) => t.parseTimelineLine(line, cal).entry;

describe('一行的新寫法', () => {
  test('開頭 → 結尾時段；只知道結尾；歷時與時段各歸各的', () => {
    const e = entry('第 4 章：+1 天，清晨 → 夜裡，歷時 3 天〔依據：「次日清晨」〕');
    assert.equal(e.part, '清晨');
    assert.equal(e.endPart, '夜裡');
    assert.equal(e.span, 3);
    assert.deepEqual(e.basis, { kind: '依据', text: '次日清晨' });
    const only = entry('第 5 章：+0 天，→ 深夜〔推測：緊接上一章〕');
    assert.equal(only.part, undefined);
    assert.equal(only.endPart, '深夜');
    assert.equal(entry('第 6 章：同日，傍晚->三更').endPart, '三更');
  });

  test('〔文中〕：日期、節日、開頭後幾天、原文；只寫節日也認；認不出的當沒寫', () => {
    const e = entry('第 4 章：+1 天〔依據：「次日」〕〔文中：八月十五（中秋），開頭後 2 天「今夜便是中秋」〕');
    assert.deepEqual(e.dateMark, { date: '八月十五', festival: '中秋', offset: 2, quote: '今夜便是中秋' });
    assert.deepEqual(e.basis, { kind: '依据', text: '次日' });
    assert.deepEqual(entry('第 4 章：+?〔文中：除夕「守歲」〕').dateMark, { festival: '除夕', offset: 0, quote: '守歲' });
    assert.deepEqual(entry('第 4 章：+1 天〔文中：三月初七，本章第 3 天〕').dateMark, { date: '三月初七', offset: 2 });
    // 認不出的〔文中〕：當沒寫，這一行照樣認得出。
    const odd = entry('第 4 章：+1 天〔文中：某個好日子〕');
    assert.equal(odd.dateMark, undefined);
    assert.deepEqual(odd.value, { kind: 'delta', days: 1 });
  });

  test('〔季節〕；幾段先後不限；括號寫成【】也認', () => {
    const e = entry('第 9 章：+30 天〔季節：冬「北風捲著碎雪」〕〔依據：「一月後」〕');
    assert.deepEqual(e.seasonMark, { season: '冬', quote: '北風捲著碎雪' });
    assert.deepEqual(e.basis, { kind: '依据', text: '一月後' });
    assert.deepEqual(entry('第 9 章：+30 天【季節：冬天】').seasonMark, { season: '冬' });
  });

  test('理由裡帶括號的不當成一段；回憶後面的「多久以前」照舊', () => {
    const e = entry('第 7 章：+0 天〔推測：緊接上一章（打鬥沒完）〕');
    assert.deepEqual(e.basis, { kind: '推测', text: '緊接上一章（打鬥沒完）' });
    const back = entry('第 7 章：回憶，約二十年前〔推測：整章是回憶〕');
    assert.deepEqual(back.value, { kind: 'flashback', ago: '約二十年前' });
  });

  test('寫回再讀得出同樣的東西（新的三樣都在）', () => {
    const e = {
      chapter: 12,
      value: { kind: 'delta', days: 1 },
      part: '清晨',
      endPart: '夜裡',
      span: 3,
      basis: { kind: '依据', text: '次日清晨' },
      dateMark: { date: '八月十五', festival: '中秋', offset: 2, quote: '今夜便是中秋' },
      seasonMark: { season: '秋', quote: '桂花開了' },
    };
    const line = t.renderTimelineLine(e);
    assert.equal(line, '第 12 章：+1 天，清晨 → 夜裡，歷時 3 天〔依據：「次日清晨」〕〔文中：八月十五（中秋），開頭後 2 天「今夜便是中秋」〕〔季節：秋「桂花開了」〕');
    assert.deepEqual(entry(line), e);
    assert.equal(t.renderTimelineLine({ chapter: 3, value: { kind: 'unknown' }, endPart: '深夜', span: 1 }), '第 3 章：+?，→ 深夜');
  });
});

describe('節日與季節', () => {
  test('簡單歷按農曆口徑；公曆只認公曆節日；「節」「夜」去掉再認', () => {
    assert.deepEqual(t.festivalDate('简单历', '中秋節'), { m: 8, d: 15 });
    assert.deepEqual(t.festivalDate('简单历', '除夕夜'), { m: 12, d: 30 });
    assert.deepEqual(t.festivalDate('简单历', '元旦'), { m: 1, d: 1 });
    assert.equal(t.festivalDate('公历', '中秋'), undefined);
    assert.deepEqual(t.festivalDate('公历', '聖誕節'), { m: 12, d: 25 });
    assert.equal(t.festivalDate('简单历', '清明'), undefined);
  });

  test('季節前後各寬一個月；簡單歷正月到三月是春，公曆 3–5 月是春', () => {
    assert.equal(t.monthFitsSeason('简单历', 1, '春'), true);
    assert.equal(t.monthFitsSeason('简单历', 12, '春'), true);
    assert.equal(t.monthFitsSeason('简单历', 5, '春'), false);
    assert.equal(t.monthFitsSeason('简单历', 5, '冬'), false);
    assert.equal(t.monthFitsSeason('公历', 1, '冬'), true);
    assert.equal(t.monthFitsSeason('公历', 7, '冬'), false);
    assert.equal(t.monthFitsSeason('公历', 3, '冬'), true);
    assert.equal(t.parseSeason('冬季'), '冬');
    assert.equal(t.parseSeason('初冬'), undefined);
  });
});

describe('推算：按正文寫明的日子對齊', () => {
  test('有起點：按〔文中〕對齊，後面的章跟著順延；偏差記下來', () => {
    const tl = tlOf('三月初一', [
      '- 第 1 章：+0 天〔依據：「起」〕',
      '- 第 2 章：+3 天〔依據：「三日後」〕',
      // 前面推下來是三月十四（第 14 天），正文寫三月十七：按正文對齊，差 3 天。
      '- 第 3 章：+10 天〔依據：「十日後」〕〔文中：三月十七「三月十七這天」〕',
      '- 第 4 章：+1 天〔依據：「次日」〕',
    ]);
    const { days } = t.computeTimeline(tl);
    assert.equal(days[2].state, 'dated');
    assert.equal(days[2].start, 17);
    assert.deepEqual(days[2].aligned, { estimate: 14, drift: 3 });
    assert.equal(days[2].delta, 13);
    assert.equal(days[3].start, 18);
    assert.equal(t.dayLabel(tl, days[3].start).full, '三月十八');
  });

  test('沒寫年份的取離推算最近的那一個（推多了幾天不跳到明年）；開頭後幾天算進去', () => {
    const tl = tlOf('八月初一', [
      '- 第 1 章：+0 天〔依據：「起」〕',
      // 推下來是八月二十（第 20 天），正文說開頭後 1 天是中秋：中秋是第 15 天，這一章開頭是第 14 天（往回挪 6 天，不是挪到明年）。
      '- 第 2 章：+19 天，歷時 2 天〔依據：「十九日後」〕〔文中：中秋，開頭後 1 天「中秋」〕',
    ]);
    const d = t.computeTimeline(tl).days[1];
    assert.equal(d.start, 14);
    assert.deepEqual(d.aligned, { estimate: 20, drift: -6 });
  });

  test('正文寫明的就是推出來的那一天：記「正文寫明」，沒有偏差', () => {
    const tl = tlOf('三月初一', ['- 第 1 章：+0 天〔依據：「起」〕', '- 第 2 章：+2 天〔依據：「兩日後」〕〔文中：三月初三「三月初三」〕']);
    const d = t.computeTimeline(tl).days[1];
    assert.equal(d.state, 'dated');
    assert.equal(d.aligned, undefined);
  });

  test('`+?` 遇上〔文中〕：記「正文寫明」，偏差標成預料之中', () => {
    const tl = tlOf('三月初一', ['- 第 1 章：+0 天〔依據：「起」〕', '- 第 2 章：+?〔推不出：沒說〕〔文中：三月二十「三月二十」〕']);
    const d = t.computeTimeline(tl).days[1];
    assert.equal(d.state, 'dated');
    assert.equal(d.start, 20);
    assert.deepEqual(d.aligned, { estimate: 1, drift: 19, unknown: true });
  });

  test('作者的錨點、第 1 章（就是起點）不對齊，對不上只記下來；沒有起點不對齊', () => {
    const tl = tlOf('三月初一', [
      '- 第 1 章：+0 天〔依據：「起」〕〔文中：三月初三「三月初三」〕',
      '- 第 2 章：三月初十〔文中：三月十二「三月十二」〕',
    ]);
    const { days } = t.computeTimeline(tl);
    assert.equal(days[0].start, 1);
    assert.deepEqual(days[0].conflict, { day: 3, why: 'start' });
    assert.equal(days[1].state, 'anchor');
    assert.equal(days[1].start, 10);
    assert.deepEqual(days[1].conflict, { day: 12, why: 'anchor' });
    const none = tlOf('', ['- 第 1 章：+0 天〔依據：「起」〕', '- 第 2 章：+2 天〔依據：「兩日後」〕〔文中：三月二十「三月二十」〕']);
    const d = t.computeTimeline(none).days[1];
    assert.equal(d.state, 'evidence');
    assert.equal(d.start, 3);
  });

  test('公曆裡農曆節日換不出日子：不對齊', () => {
    const tl = tlOf('2026-09-01', ['- 第 1 章：+0 天〔依據：「起」〕', '- 第 2 章：+3 天〔依據：「三日後」〕〔文中：中秋「中秋」〕'], '公历');
    const d = t.computeTimeline(tl).days[1];
    assert.equal(d.state, 'evidence');
    assert.equal(d.start, 4);
  });
});

describe('對賬', () => {
  const issues = (tl) => t.timelineIssues(tl, t.computeTimeline(tl));

  test('偏差 ≥ 2 天才報（差 1 天不報）；推不出遇上〔文中〕不報', () => {
    const tl = tlOf('三月初一', [
      '- 第 1 章：+0 天〔依據：「起」〕',
      '- 第 2 章：+1 天〔依據：「次日」〕〔文中：三月初三「三月初三」〕',
      '- 第 3 章：+10 天〔依據：「十日後」〕〔文中：三月十七「三月十七」〕',
      '- 第 4 章：+?〔推不出：沒說〕〔文中：三月二十五「三月二十五」〕',
    ]);
    const list = issues(tl);
    assert.deepEqual(
      list.map((i) => [i.kind, i.chapter]),
      [['drift', 3]]
    );
    assert.equal(list[0].text, '第 3 章：前面推下來是三月十三，正文寫三月十七（差 4 天），已按正文對齊');
  });

  test('你定的、起點和正文對不上', () => {
    const tl = tlOf('三月初一', ['- 第 1 章：+0 天〔依據：「起」〕〔文中：三月初三「三月初三」〕', '- 第 2 章：三月初十〔文中：三月十二「三月十二」〕']);
    assert.deepEqual(
      issues(tl).map((i) => i.text),
      ['第 1 章：起點是三月初一，正文寫三月初三', '第 2 章：你定的是三月初十，正文寫三月十二']
    );
  });

  test('季節對不上（前後寬一個月）；往回跳又沒標回憶；連著三章推不出', () => {
    const tl = tlOf('五月初一', [
      '- 第 1 章：+0 天〔依據：「起」〕〔季節：冬「大雪」〕',
      '- 第 2 章：+1 天〔依據：「次日」〕〔季節：夏「蟬鳴」〕',
      '- 第 3 章：-3 天〔依據：「三日前」〕',
      '- 第 4 章：+?〔推不出：沒說〕',
      '- 第 5 章：+?〔推不出：沒說〕',
      '- 第 6 章：回憶〔推測：整章是回憶〕',
      '- 第 7 章：+?〔推不出：沒說〕',
      '- 第 8 章：+1 天〔依據：「次日」〕',
    ]);
    assert.deepEqual(
      issues(tl).map((i) => [i.kind, i.chapter, i.text]),
      [
        ['season', 1, '第 1 章：推出來是五月，正文說是冬天（「大雪」）'],
        ['backward', 3, '第 3 章：比上一章往回跳了 3 天，又沒標回憶'],
        // 回憶夾在中間不斷開連著推不出的那一段。
        ['unknownRun', 4, '第 4–7 章連著推不出（都按緊接上一章算）'],
      ]
    );
  });

  test('沒起點：日期、季節兩類不查', () => {
    const tl = tlOf('', ['- 第 1 章：+0 天〔依據：「起」〕〔季節：冬「大雪」〕']);
    assert.deepEqual(issues(tl), []);
  });
});

describe('起點建議', () => {
  test('沒起點：按第一次正文寫明的日子倒推第 1 章是哪天，照那個日期的寫法', () => {
    const tl = tlOf('', [
      '- 第 1 章：+0 天〔依據：「起」〕',
      '- 第 2 章：+2 天〔依據：「兩日後」〕',
      '- 第 3 章：+0 天，歷時 3 天〔依據：「當晚」〕〔文中：三月初七，開頭後 1 天「三月初七」〕',
    ]);
    // 第 3 章開頭是第 3 天，開頭後 1 天（第 4 天）是三月初七 → 第 1 天是三月初四。
    assert.deepEqual(t.suggestStart(tl, t.computeTimeline(tl)), { text: '三月初四', chapter: 3, mark: '三月初七' });
    const festival = tlOf('', ['- 第 1 章：+0 天〔依據：「起」〕', '- 第 2 章：+3 天〔依據：「三日後」〕〔文中：中秋「中秋」〕']);
    assert.equal(t.suggestStart(festival, t.computeTimeline(festival)).text, '八月十二');
    const iso = tlOf('', ['- 第 1 章：+0 天〔依據：「起」〕〔文中：2026-03-07「3月7日」〕'], '公历');
    assert.equal(t.suggestStart(iso, t.computeTimeline(iso)).text, '2026-03-07');
  });

  test('有起點、沒有〔文中〕：不建議', () => {
    const has = tlOf('三月初一', ['- 第 1 章：+0 天〔文中：三月初三「三月初三」〕']);
    assert.equal(t.suggestStart(has, t.computeTimeline(has)), undefined);
    const none = tlOf('', ['- 第 1 章：+0 天〔依據：「起」〕']);
    assert.equal(t.suggestStart(none, t.computeTimeline(none)), undefined);
  });
});

describe('寫入：機器寫的行', () => {
  const chapter = '第4章正文。次日清晨，雨停了。';
  const fresh = { chapter: 4, value: { kind: 'delta', days: 2 }, span: 1, basis: { kind: '依据', text: '次日清晨，雨停了' } };

  test('認得出誰寫的：帶〔依據〕〔推測〕的相對量與回憶、帶〔推不出〕的 +? 是機器的；其餘是作者的', () => {
    const is = (line) => t.isMachineEntry(entry(line));
    assert.equal(is('第 4 章：+1 天〔依據：「次日」〕'), true);
    assert.equal(is('第 4 章：+1 天〔推測：緊接上一章〕'), true);
    assert.equal(is('第 4 章：回憶〔推測：整章是回憶〕'), true);
    assert.equal(is('第 4 章：+?〔推不出：沒說〕'), true);
    assert.equal(is('第 4 章：+3 天'), false);
    assert.equal(is('第 4 章：+3 天〔推不出：沒說〕'), false);
    assert.equal(is('第 4 章：八月十五〔依據：「中秋」〕'), false);
    assert.equal(is('第 4 章：第 20 天'), false);
    assert.equal(is('第 4 章：回憶'), false);
  });

  test('refresh：機器寫的行照新推的換（依據還在也換）；作者的行、認不出的行不動；一樣的不算換', () => {
    const raw = file('', ['- 第 3 章：+1 天', '- 第 4 章：+1 天〔依據：「次日清晨，雨停了」〕', '- 第 5 章：怎麼也認不出']);
    const out = t.upsertTimelineEntry(raw, fresh, chapter, 'refresh');
    assert.equal(out.action, 'replaced');
    assert.ok(out.text.includes('- 第 4 章：+2 天〔依據：「次日清晨，雨停了」〕'), out.text);
    assert.ok(out.text.includes('- 第 3 章：+1 天\n'));
    assert.equal(t.upsertTimelineEntry(out.text, fresh, chapter, 'refresh').action, 'kept');
    assert.equal(t.upsertTimelineEntry(raw, { ...fresh, chapter: 3 }, chapter, 'refresh').action, 'kept');
    assert.equal(t.upsertTimelineEntry(raw, { ...fresh, chapter: 5 }, chapter, 'refresh').action, 'kept');
  });

  test('fill：依據還在的機器行不動（只填空，同上一稿）', () => {
    const raw = file('', ['- 第 4 章：+1 天〔依據：「次日清晨，雨停了」〕']);
    assert.equal(t.upsertTimelineEntry(raw, fresh, chapter, 'fill').action, 'kept');
    assert.equal(t.upsertTimelineEntry(raw, fresh, chapter).action, 'kept');
  });
});

describe('認時間的新輸出', () => {
  const text = '次日清晨，雨停了。\n\n兩日後的夜裡，林昭出了城。\n\n滿院桂花開了，今夜便是中秋。';
  const ctx = { chapter: 12, text };

  test('jumps 相加成歷時；證據找不到的一跳不算、記一筆；結尾時段照收', () => {
    const v = t.verifyTime(
      {
        days: 1,
        part: '清晨',
        evidence: '次日清晨，雨停了。',
        jumps: [{ days: 2, evidence: '兩日後的夜裡' }, { days: 5, evidence: '五日後' }, { days: -1, evidence: '兩日後的夜裡' }],
        endPart: '夜裡',
      },
      ctx
    );
    assert.equal(v.entry.span, 3);
    assert.equal(v.entry.endPart, '夜裡');
    assert.equal(v.entry.part, '清晨');
    assert.equal(v.notes.length, 2);
    assert.ok(v.notes.some((n) => n.includes('五日後')));
  });

  test('沒給 jumps 認老的 span', () => {
    assert.equal(t.verifyTime({ days: 1, span: 4, evidence: '次日清晨' }, ctx).entry.span, 4);
  });

  test('〔文中〕：證據在正文裡、裡面寫著這個節日或日期才收；offset 夾在歷時之內', () => {
    const ok = t.verifyTime({ days: 1, evidence: '次日清晨', date: { date: '八月十五', festival: '中秋', offset: 9, evidence: '今夜便是中秋' } }, ctx);
    assert.deepEqual(ok.entry.dateMark, { date: '八月十五', festival: '中秋', offset: 0, quote: '今夜便是中秋' });
    // 證據裡沒寫這一天（編的）：不收。
    const made = t.verifyTime({ days: 1, evidence: '次日清晨', date: { date: '八月十五', evidence: '兩日後的夜裡' } }, ctx);
    assert.equal(made.entry.dateMark, undefined);
    assert.ok(made.notes.some((n) => n.includes('沒寫著')));
    // 證據不在正文裡：不收。
    assert.equal(t.verifyTime({ days: 1, date: { festival: '中秋', evidence: '中秋月圓，賓客滿堂' } }, ctx).entry.dateMark, undefined);
    // 只給節日：簡單歷裡收；公曆裡換不出日子，不收。
    assert.deepEqual(t.verifyTime({ days: 1, date: { festival: '中秋', evidence: '今夜便是中秋' } }, ctx).entry.dateMark, { festival: '中秋', offset: 0, quote: '今夜便是中秋' });
    assert.equal(t.verifyTime({ days: 1, date: { festival: '中秋', evidence: '今夜便是中秋' } }, { ...ctx, calendar: '公历' }).entry.dateMark, undefined);
  });

  test('〔季節〕：春夏秋冬之一、證據在正文裡才收；回憶不收〔文中〕', () => {
    assert.deepEqual(t.verifyTime({ days: 0, season: { season: '秋天', evidence: '滿院桂花開了' } }, ctx).entry.seasonMark, { season: '秋', quote: '滿院桂花開了' });
    assert.equal(t.verifyTime({ days: 0, season: { season: '秋', evidence: '落葉滿地' } }, ctx).entry.seasonMark, undefined);
    const back = t.verifyTime({ flashback: '約二十年前', date: { festival: '中秋', evidence: '今夜便是中秋' } }, ctx);
    assert.equal(back.entry.dateMark, undefined);
    // 機器寫的回憶一定帶行尾那一段：好認出是機器寫的。
    assert.deepEqual(back.entry.basis, { kind: '推测', text: '整章是回憶' });
    assert.equal(t.isMachineEntry(back.entry), true);
  });

  test('完成提示說正文寫明的日子', () => {
    const v = t.verifyTime({ days: 1, evidence: '次日清晨', date: { date: '八月十五', festival: '中秋', evidence: '今夜便是中秋' } }, ctx);
    assert.equal(t.describeTimeEntry(v.entry), '時間：+1 天（依據「次日清晨」）；正文寫明八月十五（中秋），按它對齊');
  });
});

describe('前面幾章的時間', () => {
  test('最近幾章一章一行：帶結尾時段、比上一章晚多少；沒記、推不出、回憶各說一句', () => {
    const tl = tlOf('三月初一', [
      '- 第 1 章：+0 天，清晨 → 夜裡〔依據：「起」〕',
      '- 第 3 章：+?〔推不出：沒說〕',
      '- 第 4 章：回憶〔推測：整章是回憶〕',
      '- 第 5 章：+2 天，傍晚，歷時 2 天〔依據：「兩日後」〕',
    ]);
    assert.equal(
      t.recentTimeNote(tl, 6),
      [
        '第 1 章：三月初一 清晨 → 夜裡（故事第 1 天）',
        '第 2 章：還沒記（按緊接上一章算）',
        '第 3 章：三月初一（故事第 1 天，比上一章 同一天，推不出、按緊接上一章算）',
        '第 4 章：整章是回憶，不推進時間',
        '第 5 章：三月初三 傍晚 → 三月初四（故事第 3–4 天，比上一章 +2 天）',
      ].join('\n')
    );
    assert.equal(t.recentTimeNote(tl, 1), '這是第 1 章：days 寫 0。');
    assert.ok(t.recentTimeNote(tlOf('', []), 4).startsWith('前面的章還沒記時間'));
  });
});

// 真實模型試跑之後補的（2026-10-24，設計稿「實施狀態」）。
describe('試跑之後：依據要寫著時間、只寫日的日子、同一個時段不寫兩遍', () => {
  test('依據那一句沒寫時間（本章第一句充數）：改記推測；章內一跳的依據沒寫時間：這一跳不算', () => {
    assert.equal(t.mentionsTime('夜色在濃重的霧氣裡被一點點選碎'), true);
    assert.equal(t.mentionsTime('至二十一日，就賈母內院中搭了家常小巧戲臺'), true);
    assert.equal(t.mentionsTime('次日便先送過衣服玩物禮去'), true);
    assert.equal(t.mentionsTime('過了三天，他才回來'), true);
    assert.equal(t.mentionsTime('濃霧壓在青羊鎮的殘垣斷壁上，散發著一股化不開的焦臭。'), false);
    assert.equal(t.mentionsTime('山道盡頭，濃霧如被潑了陳年墨汁，粘稠得化不開。'), false);
    const text = '濃霧壓在青羊鎮的殘垣斷壁上。\n\n他喘了口氣，又往前走。';
    const v = t.verifyTime({ days: 0, evidence: '濃霧壓在青羊鎮的殘垣斷壁上', jumps: [{ days: 2, evidence: '他喘了口氣，又往前走' }] }, { chapter: 2, text });
    assert.deepEqual(v.entry.basis, { kind: '推测', text: '依據那一句沒寫時間' });
    assert.equal(v.entry.span, 1);
  });

  test('開頭、結尾同一個時段（同一天裡）：只寫開頭', () => {
    const text = '夜裡，林昭出了城。';
    assert.equal(t.verifyTime({ days: 0, part: '夜裡', endPart: '夜裡', evidence: '夜裡，林昭出了城' }, { chapter: 2, text }).entry.endPart, undefined);
    assert.equal(t.verifyTime({ days: 0, part: '夜裡', endPart: '清晨', evidence: '夜裡，林昭出了城' }, { chapter: 2, text }).entry.endPart, '清晨');
  });

  test('只寫了日的〔文中〕：認、寫回；不對齊、只對賬（月份可能差出去）；證據裡要寫著這一天，原文寫著月日的照原文；不拿來建議起點', () => {
    assert.deepEqual(entry('第 3 章：+1 天〔文中：二十一日「至二十一日」〕').dateMark, { date: '二十一日', offset: 0, quote: '至二十一日' });
    assert.deepEqual(t.parseMarkDate('二十一日'), { m: 0, d: 21, style: { era: '', hasYear: false, year: 'num', month: 'cn', day: 'trad' } });
    // 推下來是正月十八（第 18 天），正文寫「二十一日」：不對齊，對賬說一句（離推算最近的是正月二十一，第 21 天）。
    const tl = tlOf('正月初一', ['- 第 1 章：+0 天〔依據：「起」〕', '- 第 2 章：+17 天〔依據：「十七日後」〕〔文中：二十一日「至二十一日」〕']);
    const calc = t.computeTimeline(tl);
    const d = calc.days[1];
    assert.equal(d.start, 18);
    assert.equal(d.state, 'evidence');
    assert.deepEqual(d.conflict, { day: 21, why: 'dayOnly' });
    assert.deepEqual(t.timelineIssues(tl, calc).map((i) => i.text), ['第 2 章：推出來是正月十八，正文寫二十一日（只寫了日，沒按它對齊）']);
    const text = '次日便先送過衣服玩物禮去。至二十一日，就賈母內院中搭了家常小巧戲臺。';
    const v = t.verifyTime({ days: 0, evidence: '次日便先送過衣服玩物禮去', date: { date: '二十一日', evidence: '至二十一日，就賈母內院中搭了家常小巧戲臺' } }, { chapter: 1, text });
    assert.equal(v.entry.dateMark.date, '二十一日');
    assert.equal(t.verifyTime({ days: 0, date: { date: '二十二日', evidence: '至二十一日，就賈母內院中搭了家常小巧戲臺' } }, { chapter: 1, text }).entry.dateMark, undefined);
    // 原文寫著「四月二十六日」，模型只報了「二十六日」：照原文收。
    const full = t.verifyTime({ days: 1, date: { date: '二十六日', evidence: '至次日乃是四月二十六日' } }, { chapter: 6, text: '至次日乃是四月二十六日，原來這日未時交芒種節。' });
    assert.equal(full.entry.dateMark.date, '四月二十六日');
    const none = tlOf('', ['- 第 1 章：+0 天〔依據：「起」〕〔文中：二十一日「至二十一日」〕']);
    assert.equal(t.suggestStart(none, t.computeTimeline(none)), undefined);
  });
});

describe('試跑之後：依據抄的是細綱', () => {
  test('送去的「細綱記的時間地點」被當成依據抄回來：記推測，說清是照細綱', () => {
    const v = t.verifyTime({ days: 0, evidence: '夜色初降，青羊鎮廢墟' }, { chapter: 1, text: '濃霧壓在鎮上。', hint: '夜色初降，青羊鎮廢墟，沈家老宅斷壁後。' });
    assert.deepEqual(v.entry.basis, { kind: '推测', text: '照細綱：夜色初降，青羊鎮廢墟，沈家老宅斷壁後。' });
  });
});

describe('試跑之後：寫法與繁體', () => {
  test('「初三日」按農曆的樣子寫（不寫成「一日」）；繁體的時間線索也認；往回對齊不把「過了幾天」拉成負數', () => {
    const tl = tlOf('五月初三日', ['- 第 1 章：+0 天〔依據：「起」〕', '- 第 2 章：+28 天〔依據：「二十八日後」〕']);
    assert.equal(t.dayLabel(tl, 29).full, '六月初一');
    assert.equal(t.mentionsTime('我怎麼就忘了你兩三個月'), true);
    assert.equal(t.mentionsTime('至次日天明，方才起來'), true);
    const back = tlOf('三月初一', ['- 第 1 章：+0 天，歷時 5 天〔依據：「起」〕', '- 第 2 章：+0 天〔依據：「當天」〕〔文中：二月二十五「二月二十五」〕']);
    const calc = t.computeTimeline(back);
    assert.equal(calc.days[1].start, -5);
    assert.equal(calc.elapsed, 5);
  });
});

describe('作者在介面上改（「改時間…」「改曆法與起點」）', () => {
  const raw = file('三月初七', [
    '- 第 1 章：+0 天，傍晚 → 深夜〔依據：「起」〕',
    '- 第 2 章：+1 天，歷時 2 天〔依據：「次日」〕〔文中：三月初九「三月初九」〕',
    '- 第 4 章：怎麼也認不出',
  ]);

  test('認得的寫法、清空都放行；認不出的、沒起點寫日期的說清', () => {
    const tl = t.parseTimelineFile(raw, REL);
    assert.equal(t.checkTimeInput('八月十五，傍晚', tl), undefined);
    assert.equal(t.checkTimeInput('第 20 天', tl), undefined);
    assert.equal(t.checkTimeInput('+3 天', tl), undefined);
    assert.equal(t.checkTimeInput('', tl), undefined);
    assert.match(t.checkTimeInput('過了好一陣', tl), /^認不出「過了好一陣」/);
    assert.match(t.checkTimeInput('八月十五', { calendar: '简单历' }), /^還沒填起點/);
  });

  test('改一行：值換成作者寫的、行尾的依據去掉（就是作者定的），時段、歷時、〔文中〕照留；作者寫了時段的照作者的', () => {
    const out = t.setTimelineValue(raw, 2, '+3 天');
    assert.equal(out.action, 'replaced');
    assert.ok(out.text.includes('- 第 2 章：+3 天，歷時 2 天〔文中：三月初九「三月初九」〕\n'), out.text);
    const e = t.parseTimelineFile(out.text, REL).entries.find((x) => x.chapter === 2);
    assert.equal(t.isMachineEntry(e), false);
    const withPart = t.setTimelineValue(raw, 1, '八月十五，清晨');
    assert.ok(withPart.text.includes('- 第 1 章：八月十五，清晨 → 深夜\n'), withPart.text);
    // 別的行一個字不動。
    assert.ok(withPart.text.includes('- 第 4 章：怎麼也認不出'));
    assert.ok(withPart.text.startsWith('---\ncalendar: 简单历\nstart: 三月初七\n'));
  });

  test('認不出的那一行也能改；沒有這一行按章號插進去；清空就是刪掉；認不出的字不寫', () => {
    assert.ok(t.setTimelineValue(raw, 4, '同日').text.includes('- 第 4 章：+0 天\n'));
    const added = t.setTimelineValue(raw, 3, '第 9 天');
    assert.equal(added.action, 'added');
    assert.match(added.text, /- 第 2 章：[^\n]*\n- 第 3 章：第 9 天\n- 第 4 章/);
    const removed = t.setTimelineValue(raw, 1, '');
    assert.equal(removed.action, 'removed');
    assert.ok(!removed.text.includes('第 1 章'));
    assert.equal(t.setTimelineValue(raw, 9, '').action, 'kept');
    assert.equal(t.setTimelineValue(raw, 2, '過了好一陣'), undefined);
    // 還沒有這份檔案：按模板新建。
    assert.ok(t.setTimelineValue('', 1, '三月初七').text.includes('# 時間線'));
  });

  test('改曆法與起點：只換那兩個鍵；沒有就加；還沒有檔案按模板新建', () => {
    const out = t.setTimelineHead(raw, { calendar: '公历', start: '2026-03-07' });
    assert.ok(out.startsWith('---\ncalendar: 公历\nstart: 2026-03-07\ngeneratedBy: novelwarden\n---\n'), out);
    assert.ok(out.includes('- 第 4 章：怎麼也認不出'));
    const bare = t.setTimelineHead('---\ngeneratedBy: x\n---\n\n# 時間線\n', { start: '三月初五' });
    assert.ok(bare.startsWith('---\ngeneratedBy: x\nstart: 三月初五\n---\n'), bare);
    assert.match(t.setTimelineHead('', { start: '三月初五' }), /^---\ncalendar: 简单历\nstart: 三月初五\n/);
    assert.equal(t.parseTimelineFile(t.setTimelineHead(raw, { start: '' }), REL).startText, '');
  });
});
