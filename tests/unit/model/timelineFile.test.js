/**
 * 敘事線裡的故事時間（2026-10-24，docs/design/plans/2026-10-24-story-timeline.md）：`threads/时间线.md` 一章一行，日期現算。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 漢字數字兩種寫法都認、讀法寫得對 | 「大衍三年三月十四」「二〇二六年」「廿一」「初七」 |
 * | 起點幾種寫法都認，輸出照起點的樣子寫；簡單歷每月 30 天，公曆按真實月份 | 作者定的歷法 |
 * | 幾種值都認（+N 天 / 個月 / 年、同日、次日、+?、回憶、第 N 天、日期），認不出的行不崩、當「沒推」 | 第 1 條 |
 * | 推算：沒推、推不出按緊接上一章；錨點之後的章跟著順延；回憶不推進；第一章的差值不算 | 設計稿「推算」 |
 * | 只填空：沒有才寫、按章號插；作者的行、依據還在的行不動；`+?`〔推不出〕與依據沒了的才換 | 第 28 條：作者寫的字機器不動 |
 * | BOM、CRLF、專案符號原樣 | 第 3 條 |
 * | 模型的輸出：證據逐字校驗、找不到改推測，days 為 null 記推不出，離譜的不收 | 設計稿「一、同步時推」 |
 * | 「時間線」是保留名，排線不許用它當線名 | 同「未歸屬的伏筆」 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const t = loadModule('src/core/model/timelineFile.ts');
const th = loadModule('src/core/model/threadFile.ts');

const REL = '.novelwarden/threads/时间线.md';

function file(start, lines, calendar = '简单历') {
  return ['---', `calendar: ${calendar}`, `start: ${start}`, 'generatedBy: novelwarden', '---', '', '# 時間線', '', ...lines, ''].join('\n');
}

describe('數字', () => {
  test('漢字讀法、逐位寫法、農曆日子都認', () => {
    assert.equal(t.parseNumber('十四'), 14);
    assert.equal(t.parseNumber('廿一'), 21);
    assert.equal(t.parseNumber('初七'), 7);
    assert.equal(t.parseNumber('三十'), 30);
    assert.equal(t.parseNumber('一百零五'), 105);
    assert.equal(t.parseNumber('二〇二六'), 2026);
    assert.equal(t.parseNumber('兩萬三千'), 23000);
    assert.equal(t.parseNumber('１２'), 12);
    assert.equal(t.parseNumber('元'), 1);
    assert.equal(t.parseNumber('三天'), undefined);
  });

  test('讀法寫得對', () => {
    assert.equal(t.cnNumber(1), '一');
    assert.equal(t.cnNumber(10), '十');
    assert.equal(t.cnNumber(14), '十四');
    assert.equal(t.cnNumber(20), '二十');
    assert.equal(t.cnNumber(105), '一百零五');
    assert.equal(t.cnNumber(1010), '一千零一十');
    assert.equal(t.cnNumber(23000), '二萬三千');
  });
});

describe('曆法', () => {
  const simple = (start) => t.parseTimelineFile(file(start, []), REL);

  test('簡單歷：年號、漢字年月、農曆日子，照起點的寫法輸出', () => {
    const tl = simple('大衍三年三月初七');
    assert.deepEqual(t.dayLabel(tl, 1), { full: '大衍三年三月初七', short: '初七', month: '大衍三年三月', monthName: '三月' });
    assert.equal(t.dayLabel(tl, 8).full, '大衍三年三月十四');
    // 每月 30 天：三月初七往後 24 天是四月初一。
    assert.equal(t.dayLabel(tl, 25).full, '大衍三年四月初一');
    // 一年 360 天：跨年，年份往上加。
    assert.equal(t.dayLabel(tl, 361).full, '大衍四年三月初七');
  });

  test('簡單歷：起點沒寫年份時跨年寫「次年」「第三年」', () => {
    const tl = simple('三月初七');
    assert.equal(t.dayLabel(tl, 1).full, '三月初七');
    assert.equal(t.dayLabel(tl, 361).full, '次年三月初七');
    assert.equal(t.dayLabel(tl, 721).full, '第三年三月初七');
  });

  test('簡單歷：阿拉伯數字的起點輸出阿拉伯數字；正月、臘月照寫', () => {
    assert.equal(t.dayLabel(simple('3月7日'), 8).full, '3月14日');
    const trad = simple('臘月廿八');
    // 每月 30 天：廿八、廿九、三十，第 4 天是次年正月初一。
    assert.equal(t.dayLabel(trad, 4).full, '次年正月初一');
  });

  test('公曆：真實的月份長短與閏年，照起點的寫法', () => {
    const iso = t.parseTimelineFile(file('2024-02-28', [], '公历'), REL);
    assert.equal(iso.calendar, '公历');
    assert.equal(t.dayLabel(iso, 2).full, '2024-02-29');
    assert.equal(t.dayLabel(iso, 3).full, '2024-03-01');
    assert.equal(t.dayLabel(iso, 3).month, '2024-03');
    const cn = t.parseTimelineFile(file('2026年3月7日', [], '公历'), REL);
    assert.equal(t.dayLabel(cn, 26).full, '2026年4月1日');
  });

  test('沒填起點、起點認不出：只寫第幾天', () => {
    assert.deepEqual(t.dayLabel(simple(''), 46), { full: '第 46 天', short: '46' });
    const bad = simple('很久很久以前');
    assert.equal(bad.start, undefined);
    assert.equal(bad.startText, '很久很久以前');
    assert.equal(t.dayLabel(bad, 3).full, '第 3 天');
    // 簡單歷沒有三月三十一。
    assert.equal(simple('三月三十一').start, undefined);
  });
});

describe('解析', () => {
  test('幾種值都認，時段、歷時、依據各歸各的', () => {
    const tl = t.parseTimelineFile(
      file('三月初七', [
        '- 第 1 章：+0 天，傍晚〔依據：「連日大雨的第三天傍晚」〕',
        '- 第 2 章：同日，夜裡',
        '- 第 3 章：次日',
        '- 第 4 章：+1 天，清晨，歷時 2 天 [依據：「次日清晨，雨停了」]',
        '* 第 5 章：+3 個月',
        '- 第 6 章：+半年',
        '- 第 7 章：回憶，約二十年前〔依據：「那是二十年前的冬天」〕',
        '- 第 8 章：+?〔推不出：正文沒交代過了多久〕',
        '- 第 9 章：+0 天，上午〔推測：緊接上一章的審訊〕',
        '- 第 10 章：八月十五，傍晚',
        '- 第 11 章：第 200 天',
        '- 第 12 章：-2 天',
      ]),
      REL
    );
    const by = new Map(tl.entries.map((e) => [e.chapter, e]));
    assert.deepEqual(by.get(1), {
      chapter: 1,
      value: { kind: 'delta', days: 0 },
      part: '傍晚',
      span: 1,
      basis: { kind: '依据', text: '連日大雨的第三天傍晚' },
    });
    assert.deepEqual(by.get(2).value, { kind: 'delta', days: 0 });
    assert.equal(by.get(2).part, '夜裡');
    assert.deepEqual(by.get(3).value, { kind: 'delta', days: 1 });
    assert.equal(by.get(4).span, 2);
    assert.equal(by.get(4).basis.text, '次日清晨，雨停了');
    assert.deepEqual(by.get(5).value, { kind: 'delta', days: 90 });
    assert.deepEqual(by.get(6).value, { kind: 'delta', days: 180 });
    assert.deepEqual(by.get(7).value, { kind: 'flashback', ago: '約二十年前' });
    assert.deepEqual(by.get(8).value, { kind: 'unknown' });
    assert.equal(by.get(8).basis.kind, '推不出');
    assert.equal(by.get(9).basis.kind, '推测');
    assert.deepEqual(by.get(10).value, { kind: 'date', text: '八月十五' });
    assert.deepEqual(by.get(11).value, { kind: 'day', day: 200 });
    assert.deepEqual(by.get(12).value, { kind: 'delta', days: -2 });
    assert.deepEqual(tl.bad, []);
  });

  test('認不出的行不崩：值認不出的記一筆，不是「第 N 章」開頭的跳過；同一章兩行認第一行', () => {
    const tl = t.parseTimelineFile(
      file('', ['> 說明文字', '- 第 1 章：+0 天', '- 第 2 章：過了好一陣子', '- 隨手記一句', '- 第 1 章：+5 天', '## 別的小節']),
      REL
    );
    assert.deepEqual(tl.entries.map((e) => e.chapter), [1]);
    assert.deepEqual(tl.entries[0].value, { kind: 'delta', days: 0 });
    assert.deepEqual(tl.bad, [2]);
  });

  test('沒有檔案：exists 為 false、簡單歷、沒有起點', () => {
    const tl = t.parseTimelineFile('', REL);
    assert.equal(tl.exists, false);
    assert.equal(tl.calendar, '简单历');
    assert.deepEqual(tl.entries, []);
  });

  test('「時間線」是保留名：排線排出來叫這個名字的線不收', () => {
    assert.equal(th.isReservedThreadName('時間線'), true);
    assert.equal(th.isReservedThreadName('未歸屬的伏筆'), true);
    assert.equal(th.isReservedThreadName('林昭與沈青'), false);
    const v = th.verifyThreadPlans([{ title: '時間線', kind: '支线', intent: '…' }], { threads: [], foreshadowing: [] });
    assert.equal(v.plans.length, 0);
    assert.match(v.dropped[0].why, /保留名/);
  });
});

describe('推算', () => {
  const calc = (lines, start = '三月初七', upTo) => {
    const tl = t.parseTimelineFile(file(start, lines), REL);
    return { tl, r: t.computeTimeline(tl, upTo) };
  };

  test('相對量累加；沒推、推不出按緊接上一章；歷時推後結尾', () => {
    const { r } = calc([
      '- 第 1 章：+3 天〔依據：「第三天」〕',
      '- 第 2 章：+1 天，歷時 3 天〔依據：「次日」〕',
      '- 第 4 章：+?〔推不出：沒交代〕',
      '- 第 5 章：+2 天〔推測：趕路〕',
    ]);
    // 第一章的差值不算：開頭就是第 1 天。
    assert.deepEqual(
      r.days.map((d) => [d.chapter, d.state, d.start, d.end]),
      [
        [1, 'evidence', 1, 1],
        [2, 'evidence', 2, 4],
        [3, 'missing', 4, 4],
        [4, 'unknown', 4, 4],
        [5, 'guess', 6, 6],
      ]
    );
    assert.equal(r.days[1].delta, 1);
    assert.equal(r.elapsed, 6);
    assert.equal(r.last, 5);
  });

  test('錨點：作者定的那一天，後面機器推的跟著順延；沒寫年份取上一章結尾當天或之後最近的那一個', () => {
    const lines = ['- 第 1 章：+0 天〔依據：「起」〕', '- 第 2 章：+1 天〔依據：「次」〕', '- 第 3 章：八月十五', '- 第 4 章：+2 天〔依據：「兩日後」〕'];
    const { tl, r } = calc(lines);
    // 三月初七是第 1 天；八月十五 = 第 1 + (5 個月 × 30 + 8) = 第 159 天。
    assert.equal(r.days[2].state, 'anchor');
    assert.equal(r.days[2].start, 159);
    assert.equal(r.days[3].start, 161);
    assert.equal(t.dayLabel(tl, r.days[3].start).full, '八月十七');
    // 錨點在上一章之前（三月初一）：取下一年的那一天。
    const back = calc(['- 第 1 章：+0 天', '- 第 2 章：+10 天', '- 第 3 章：三月初一']).r;
    assert.equal(back.days[2].start, 355);
    assert.equal(t.dayLabel(calc([], '三月初七').tl, 355).full, '次年三月初一');
  });

  test('第 N 天的錨點不要起點；日期錨點沒有起點算不出，當認不出', () => {
    const { r } = calc(['- 第 1 章：+0 天', '- 第 2 章：第 30 天', '- 第 3 章：八月十五', '- 第 4 章：+1 天'], '');
    assert.equal(r.days[1].start, 30);
    assert.equal(r.days[2].state, 'bad');
    assert.equal(r.days[2].start, 30);
    assert.equal(r.days[3].start, 31);
  });

  test('回憶不推進時間；第一個不是回憶的章當第 1 天', () => {
    const { r } = calc(['- 第 1 章：回憶，約二十年前', '- 第 2 章：+5 天', '- 第 3 章：回憶', '- 第 4 章：+1 天']);
    assert.equal(r.days[0].state, 'flashback');
    assert.equal(r.days[0].start, undefined);
    assert.equal(r.days[0].ago, '約二十年前');
    assert.equal(r.days[1].start, 1);
    assert.equal(r.days[3].start, 2);
  });

  test('upTo：寫第 N 章時只看第 N 章之前的行', () => {
    const lines = ['- 第 1 章：+0 天', '- 第 2 章：+1 天', '- 第 3 章：+1 天'];
    const { tl, r } = calc(lines, '三月初七', 2);
    assert.equal(r.days.length, 2);
    assert.equal(r.elapsed, 2);
    const last = t.lastKnownBefore(tl, 3);
    assert.equal(last.day.chapter, 2);
    assert.equal(last.gap, 0);
    assert.equal(t.describeDaySpan(tl, last.day), '三月初八（故事第 2 天）');
    assert.equal(t.lastKnownBefore(tl, 1), undefined);
  });

  test('作者手寫的相對量（沒有那一段、或者改了值還掛著〔推不出〕）算作者定的', () => {
    const { r } = calc(['- 第 1 章：+0 天', '- 第 2 章：+3 個月', '- 第 3 章：+4 天〔推不出：沒交代〕']);
    assert.equal(r.days[1].state, 'anchor');
    assert.equal(r.days[2].state, 'anchor');
    assert.equal(r.days[2].start, 1 + 90 + 4);
  });
});

describe('寫入：只填空', () => {
  const entry = (chapter, days, basis) => ({ chapter, value: { kind: 'delta', days }, span: 1, ...(basis ? { basis } : {}) });

  test('還沒有檔案：按模板新建，寫下第一行', () => {
    const { text, action } = t.upsertTimelineEntry('', entry(1, 0, { kind: '依据', text: '那天傍晚' }), '那天傍晚，雨停了。');
    assert.equal(action, 'added');
    assert.match(text, /^---\ncalendar: 简单历\nstart: \n/);
    assert.match(text, /\n- 第 1 章：\+0 天〔依據：「那天傍晚」〕\n$/);
    const tl = t.parseTimelineFile(text, REL);
    assert.deepEqual(tl.entries.map((e) => e.chapter), [1]);
  });

  test('按章號插到對的位置，專案符號沿用已有的寫法', () => {
    const raw = file('', ['* 第 1 章：+0 天', '* 第 5 章：+1 天']);
    const { text, action } = t.upsertTimelineEntry(raw, entry(3, 2, { kind: '推测', text: '趕路' }), '');
    assert.equal(action, 'added');
    assert.match(text, /\* 第 1 章：\+0 天\n\* 第 3 章：\+2 天〔推測：趕路〕\n\* 第 5 章/);
    const before = t.upsertTimelineEntry(raw, entry(9, 1), '').text;
    assert.match(before, /\* 第 5 章：\+1 天\n\* 第 9 章：\+1 天\n$/);
  });

  test('作者寫的、依據還在正文裡的、推測的行不動', () => {
    const raw = file('', [
      '- 第 1 章：八月十五',
      '- 第 2 章：+2 天〔依據：「兩日後的清晨」〕',
      '- 第 3 章：+0 天〔推測：緊接上一章〕',
      '- 第 4 章：過了好一陣子',
    ]);
    for (const [no, text] of [
      [1, ''],
      [2, '兩日後的清晨，他們到了渡口。'],
      [3, ''],
      [4, ''],
    ]) {
      const r = t.upsertTimelineEntry(raw, entry(no, 9), text);
      assert.equal(r.action, 'kept', `第 ${no} 章`);
      assert.equal(r.text, raw);
    }
  });

  test('`+?`〔推不出〕與依據已經不在正文裡的行換掉，只換那一行', () => {
    const raw = file('', ['- 第 1 章：+?〔推不出：沒交代〕', '- 第 2 章：+2 天〔依據：「兩日後的清晨」〕']);
    const a = t.upsertTimelineEntry(raw, entry(1, 0, { kind: '依据', text: '當晚' }), '');
    assert.equal(a.action, 'replaced');
    assert.match(a.text, /- 第 1 章：\+0 天〔依據：「當晚」〕\n- 第 2 章：\+2 天/);
    const b = t.upsertTimelineEntry(raw, entry(2, 5, { kind: '依据', text: '五日後' }), '五日後，他們到了渡口。');
    assert.equal(b.action, 'replaced');
    assert.match(b.text, /- 第 2 章：\+5 天〔依據：「五日後」〕/);
    // 作者把 +? 填成了別的值、卻留著〔推不出〕：算作者的，不換。
    const filled = file('', ['- 第 1 章：+3 天〔推不出：沒交代〕']);
    assert.equal(t.upsertTimelineEntry(filled, entry(1, 0), '').action, 'kept');
  });

  test('BOM、CRLF 原樣', () => {
    const raw = `﻿${file('', ['- 第 1 章：+0 天']).replace(/\n/g, '\r\n')}`;
    const { text } = t.upsertTimelineEntry(raw, entry(2, 1), '');
    assert.ok(text.startsWith('﻿---\r\n'));
    assert.ok(!/[^\r]\n/.test(text));
    assert.match(text, /- 第 1 章：\+0 天\r\n- 第 2 章：\+1 天\r\n/);
  });

  test('寫回的一行再讀得出同樣的東西', () => {
    const e = { chapter: 4, value: { kind: 'flashback', ago: '約二十年前' }, span: 1, basis: { kind: '依据', text: '那年冬天' } };
    assert.equal(t.renderTimelineLine(e), '第 4 章：回憶，約二十年前〔依據：「那年冬天」〕');
    assert.deepEqual(t.parseTimelineLine(t.renderTimelineLine(e)).entry, e);
    const d = { chapter: 2, value: { kind: 'delta', days: -3 }, part: '清晨', span: 2, basis: { kind: '推测', text: '倒回去寫' } };
    assert.deepEqual(t.parseTimelineLine(t.renderTimelineLine(d)).entry, d);
  });
});

describe('模型的輸出', () => {
  const text = '次日清晨，雨停了。林昭推開窗，鎮口已經有人在等。';

  test('證據逐字找得到：記依據；時段、跨度照收', () => {
    const v = t.verifyTime({ days: 1, span: 2, part: '清晨', evidence: '次日清晨，雨停了' }, { chapter: 4, text });
    assert.deepEqual(v.entry, {
      chapter: 4,
      value: { kind: 'delta', days: 1 },
      part: '清晨',
      span: 2,
      basis: { kind: '依据', text: '次日清晨，雨停了' },
    });
    assert.deepEqual(v.notes, []);
  });

  test('證據找不到：換成最接近的原句；還找不到改記推測；那一句沒寫時間也改記推測（重做）', () => {
    const long = '次日清晨，連下了三天的雨終於停了。林昭推開窗，鎮口已經有人在等。';
    const near = t.verifyTime({ days: 1, evidence: '次日清晨，下了三天的雨終於停了' }, { chapter: 4, text: long });
    assert.equal(near.entry.basis.kind, '依据');
    assert.equal(near.entry.basis.text, '次日清晨，連下了三天的雨終於停了。');
    assert.equal(near.notes.length, 1);
    const scene = t.verifyTime({ days: 1, evidence: '林昭推開窗，鎮口已經有人在等。' }, { chapter: 4, text });
    assert.deepEqual(scene.entry.basis, { kind: '推测', text: '依據那一句沒寫時間' });
    const lost = t.verifyTime({ days: 1, evidence: '三個月之後的一個黃昏' }, { chapter: 4, text });
    assert.deepEqual(lost.entry.basis, { kind: '推测', text: '依據在正文裡找不到' });
  });

  test('沒給證據：推測（有理由寫理由，沒有寫緊接上一章）', () => {
    assert.deepEqual(t.verifyTime({ days: 0, reason: '接著上一章的打鬥' }, { chapter: 4, text }).entry.basis, {
      kind: '推测',
      text: '接著上一章的打鬥',
    });
    assert.deepEqual(t.verifyTime({ days: '0' }, { chapter: 4, text }).entry.basis, { kind: '推测', text: '緊接上一章' });
  });

  test('days 為 null、離譜：推不出；整章回憶：不推進；不是物件：不寫', () => {
    const unknown = t.verifyTime({ days: null, reason: '沒交代' }, { chapter: 4, text });
    assert.deepEqual(unknown.entry.value, { kind: 'unknown' });
    assert.deepEqual(unknown.entry.basis, { kind: '推不出', text: '沒交代' });
    const wild = t.verifyTime({ days: 9e9 }, { chapter: 4, text });
    assert.deepEqual(wild.entry.value, { kind: 'unknown' });
    assert.equal(wild.notes.length, 1);
    const back = t.verifyTime({ days: 3, flashback: '約二十年前' }, { chapter: 4, text });
    assert.deepEqual(back.entry.value, { kind: 'flashback', ago: '約二十年前' });
    assert.equal(t.verifyTime(undefined, { chapter: 4, text }), undefined);
    assert.equal(t.verifyTime([1], { chapter: 4, text }), undefined);
  });

  test('完成提示裡那一句', () => {
    assert.equal(
      t.describeTimeEntry({ chapter: 4, value: { kind: 'delta', days: 2 }, span: 1, basis: { kind: '依据', text: '兩日後' } }),
      '時間：+2 天（依據「兩日後」）'
    );
    assert.match(t.describeTimeEntry({ chapter: 4, value: { kind: 'unknown' }, span: 1 }), /推不出/);
  });
});
