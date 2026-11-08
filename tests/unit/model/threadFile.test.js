/**
 * 敘事線新格式（2026-10-20 重做）：一條線一個檔案，解析、狀態現算、外科式寫入、當前進度的指紋。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 幾種手寫格式都認、認不出的行不崩、不當伏筆也不當事件 | 第 1 條：作者會手改 |
 * | 檔名就是線名，H1 只在對得上時用 | 設計稿：同名按 normalizeQuote 歸一判 |
 * | 種類認不出當支線；事件型別整個詞對得上才算 | 「收」與「收束」是兩種 |
 * | 狀態取章號最大的線事件，伏筆的事件不會把收了的線開啟 | 狀態不落盤，每次從事件現算 |
 * | asOf 只留之前的事件、寫到這一章或更晚的當前進度不用 | 不把後面的劇情透給前面 |
 * | 斷了：主線 5 章、其餘 15 章；過了計劃收束章算逾期 | 設計稿 ⚑9 |
 * | 追加 / 按章換 / 按證據清理只動那幾行，BOM、CRLF、作者的行原樣 | 第 3 條：作者寫的字一個都不動 |
 * | 當前進度：空的、指紋對得上的歸機器，改過的歸作者 | 照角色卡「當前狀態」（第 19 條的例外） |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const t = loadModule('src/core/model/threadFile.ts');

const REL = '.novelwarden/threads/林昭與沈青.md';

const FILE = [
  '---',
  'kind: 感情線',
  'origin: 計劃',
  'plan: 3-40',
  'progressThrough: 12',
  'progressHash: abc',
  'generatedBy: novelwarden',
  '---',
  '',
  '# 林昭與沈青',
  '',
  '## 意圖',
  '從互相猜忌到並肩，第 40 章前確定心意。',
  '',
  '## 當前進度',
  '第 12 章兩人在青崖鎮結盟，沈青仍瞞著自己是沈家遺孤。',
  '',
  '## 伏筆',
  '- 玉佩的來歷：林昭的玉佩是沈家舊物（計劃第 3 章埋、第 18 章前收）',
  '- 沈青的舊傷（計劃第 5 章埋）',
  '- （待補充）',
  '> 說明文字，不是伏筆。',
  '',
  '## 進展',
  '- 第 3 章 · 計劃 · 推進：兩人初遇，互相試探',
  '- 第 3 章 · 計劃 · 埋〈玉佩的來歷〉：打鬥中玉佩露出來',
  '- 第 3 章 · 推進：兩人在鎮口初遇，沈青出手試探 〔證據：「她的劍停在他喉前三寸」〕',
  '- 第 3 章 · 埋〈玉佩的來歷〉：玉佩第一次露面 〔證據：「他摸了摸懷裡那塊溫潤的玉佩」〕',
  '- 第 12 章 · 關係：林昭—沈青，猜忌 → 結盟 〔證據：「從今往後，你的仇就是我的仇」〕',
  '- 作者自己加的一行備註',
  '',
  '### 作者的小標題',
  '- 第 13 章：作者手寫的一筆，沒有型別也沒有證據',
  '',
  '## 作者自加的一節',
  '- 第 99 章 · 收束：這一節不是進展，不認',
  '',
].join('\n');

describe('threadFile.ts · 解析', () => {
  const th = t.parseThreadFile(FILE, REL, 2);

  test('frontmatter：種類、來源、計劃區間、當前進度寫到第幾章與指紋', () => {
    assert.equal(th.name, '林昭與沈青');
    assert.equal(th.relPath, REL);
    assert.equal(th.kind, '感情线');
    assert.equal(th.origin, '计划');
    assert.equal(th.from, 3);
    assert.equal(th.to, 40);
    assert.equal(th.progressThrough, 12);
    assert.equal(th.progressHash, 'abc');
    assert.equal(th.index, 2);
  });

  test('意圖與當前進度是整節文字', () => {
    assert.equal(th.intent, '從互相猜忌到並肩，第 40 章前確定心意。');
    assert.match(th.progress, /^第 12 章兩人在青崖鎮結盟/);
  });

  test('伏筆：括號裡的埋與收認成章號；佔位文字、引用行不算', () => {
    assert.deepEqual(th.foreshadowing, [
      { name: '玉佩的來歷', what: '林昭的玉佩是沈家舊物', plant: 3, resolve: 18 },
      { name: '沈青的舊傷', what: '', plant: 5 },
    ]);
  });

  test('進展：計劃與實際、伏筆名、證據都認；沒寫型別的當推進；別的節裡的不認', () => {
    assert.equal(th.events.length, 6);
    assert.deepEqual(th.events[0], { chapter: 3, planned: true, type: '推进', what: '兩人初遇，互相試探' });
    assert.deepEqual(th.events[1], {
      chapter: 3,
      planned: true,
      type: '埋',
      foreshadowing: '玉佩的來歷',
      what: '打鬥中玉佩露出來',
    });
    assert.deepEqual(th.events[3], {
      chapter: 3,
      planned: false,
      type: '埋',
      foreshadowing: '玉佩的來歷',
      what: '玉佩第一次露面',
      evidence: '他摸了摸懷裡那塊溫潤的玉佩',
    });
    assert.equal(th.events[4].type, '关系');
    assert.equal(th.events[4].what, '林昭—沈青，猜忌 → 結盟');
    assert.deepEqual(th.events[5], { chapter: 13, planned: false, type: '推进', what: '作者手寫的一筆，沒有型別也沒有證據' });
  });

  test('沒有 frontmatter、種類認不出：當支線、來源當計劃；名字取檔名', () => {
    const x = t.parseThreadFile('# 別的名字\n\n## 意圖\n隨便寫寫\n', '.novelwarden/threads/沈家舊案.md');
    assert.equal(x.name, '沈家舊案');
    assert.equal(x.kind, '支线');
    assert.equal(x.origin, '计划');
    assert.equal(x.from, undefined);
    assert.equal(x.intent, '隨便寫寫');
    const y = t.parseThreadFile('---\nkind: 奇怪的線\norigin: 正文\n---\n', '.novelwarden/threads/a.md');
    assert.equal(y.kind, '支线');
    assert.equal(y.origin, '正文');
  });

  test('H1 只在和檔名對得上時當名字（機器建檔案時名字裡的冒號被清洗掉了）', () => {
    const x = t.parseThreadFile('# 林昭: 復仇\n', '.novelwarden/threads/林昭-復仇.md');
    assert.equal(x.name, '林昭: 復仇');
    assert.equal(t.threadFileName('林昭: 復仇'), '林昭-復仇.md');
  });

  test('BOM、CRLF、空串、亂寫都不崩', () => {
    const crlf = `﻿${FILE.replace(/\n/g, '\r\n')}`;
    const x = t.parseThreadFile(crlf, REL);
    assert.equal(x.events.length, 6);
    assert.equal(x.foreshadowing.length, 2);
    assert.doesNotThrow(() => t.parseThreadFile('', REL));
    assert.doesNotThrow(() => t.parseThreadFile('---\n---\n## 進展\n- 第 x 章\n- 第 0 章 · 推進：零\n##\n', REL));
    assert.equal(t.parseThreadFile('## 進展\n- 第 0 章 · 推進：零\n', REL).events.length, 0);
  });

  test('未歸屬的伏筆：同樣的伏筆、進展兩節', () => {
    const u = t.parseUnfiledFile(
      `${t.UNFILED_TEMPLATE}`.replace('## 進展\n', '## 進展\n\n- 第 2 章 · 埋〈斷劍〉：斷劍落潭 〔證據：「劍落進了深潭」〕\n'),
      '.novelwarden/threads/未归属的伏笔.md'
    );
    assert.equal(u.name, '未歸屬的伏筆');
    assert.equal(u.events.length, 1);
    assert.equal(t.isUnfiledName(' 未歸屬的伏筆 '), true);
    assert.equal(t.isUnfiledName('林昭與沈青'), false);
  });
});

describe('threadFile.ts · 認名字、種類與事件型別', () => {
  test('種類四種與幾種別名，認不出是 undefined', () => {
    assert.equal(t.threadKindOf('主线'), '主线');
    assert.equal(t.threadKindOf(' 感情 線'), '感情线');
    assert.equal(t.threadKindOf('副線'), '支线');
    assert.equal(t.threadKindOf('成長線'), '人物线');
    assert.equal(t.threadKindOf('伏笔'), undefined);
  });

  test('事件型別整個詞對得上才算：收與收束是兩種', () => {
    assert.equal(t.eventTypeOf('收'), '收');
    assert.equal(t.eventTypeOf('收束'), '收束');
    assert.equal(t.eventTypeOf('回收'), '收');
    assert.equal(t.eventTypeOf('埋下'), '埋');
    assert.equal(t.eventTypeOf('收到密信'), undefined);
    assert.equal(t.parseEventLine('第 3 章 收到密信').type, '推进');
    assert.equal(t.parseEventLine('第 3 章 收到密信').what, '收到密信');
  });

  test('「計劃」後面接的不是型別：不是計劃事件', () => {
    const e = t.parseEventLine('第 3 章 計劃有變，兩人改道');
    assert.equal(e.planned, false);
    assert.equal(e.what, '計劃有變，兩人改道');
  });

  test('分隔符、括號寫法寬鬆認', () => {
    const e = t.parseEventLine('第3章-計劃-收<玉佩>: 揭開身世');
    assert.deepEqual(e, { chapter: 3, planned: true, type: '收', foreshadowing: '玉佩', what: '揭開身世' });
    const f = t.parseEventLine('第 5 章 · 推進：沈青受傷 [證據：“血從指縫裡滲出來”]');
    assert.equal(f.evidence, '血從指縫裡滲出來');
    assert.equal(f.what, '沈青受傷');
  });

  test('計劃區間：幾種寫法與寫回', () => {
    assert.deepEqual(t.parsePlan('3-40'), { from: 3, to: 40 });
    assert.deepEqual(t.parsePlan('第3–40章'), { from: 3, to: 40 });
    assert.deepEqual(t.parsePlan('40-3'), { from: 3, to: 40 });
    assert.deepEqual(t.parsePlan('3-'), { from: 3 });
    assert.deepEqual(t.parsePlan('-40'), { to: 40 });
    assert.deepEqual(t.parsePlan('待定'), {});
    assert.equal(t.planText(3, 40), '3-40');
    assert.equal(t.planText(3), '3-');
    assert.deepEqual(t.parsePlan(t.planText(undefined, 40)), { to: 40 });
    assert.equal(t.planText(), undefined);
  });
});

/** 只給狀態函式用的最小一條線。 */
function line(events, extra = {}) {
  return { name: '線', relPath: REL, kind: '支线', origin: '计划', intent: '', progress: '', foreshadowing: [], events, index: 0, ...extra };
}
const ev = (chapter, type, extra = {}) => ({ chapter, planned: false, type, what: '', ...extra });

describe('threadFile.ts · 狀態現算', () => {
  test('沒有實際事件是計劃中（計劃事件不算）', () => {
    assert.equal(t.threadStatus(line([{ ...ev(3, '推进'), planned: true }])), '计划中');
  });

  test('章號最大的線事件定狀態，同章取寫在後面的', () => {
    assert.equal(t.threadStatus(line([ev(3, '推进'), ev(9, '收束'), ev(5, '关系')])), '已收束');
    assert.equal(t.threadStatus(line([ev(9, '收束'), ev(9, '推进')])), '进行中');
    assert.equal(t.threadStatus(line([ev(4, '放弃')])), '已放弃');
  });

  test('伏筆的事件不會把收了的線重新開啟，但說明這條線動過', () => {
    const x = line([ev(3, '推进'), ev(9, '收束'), ev(12, '收', { foreshadowing: '玉佩' })]);
    assert.equal(t.threadStatus(x), '已收束');
    assert.equal(t.lastActiveChapter(x), 12);
    assert.equal(t.threadStatus(line([ev(2, '埋', { foreshadowing: '玉佩' })])), '进行中');
  });

  test('asOf：只留之前的事件；當前進度寫到這一章或更晚就不用', () => {
    const x = line([ev(3, '推进'), ev(8, '推进')], { progress: '結盟了', progressThrough: 8 });
    const at8 = t.asOf(x, 8);
    assert.deepEqual(at8.events.map((e) => e.chapter), [3]);
    assert.equal(at8.progress, '');
    const at9 = t.asOf(x, 9);
    assert.equal(at9, x, '沒有要去掉的就原樣返回');
  });

  test('斷了：主線 5 章、其餘 15 章；不是進行中不算', () => {
    const main = line([ev(10, '推进')], { kind: '主线' });
    assert.deepEqual(t.threadStateAt(main, 14), { status: '进行中', lastActive: 10, gap: 4, stalled: false, overdue: false });
    assert.equal(t.threadStateAt(main, 15).stalled, true);
    assert.equal(t.threadStateAt(line([ev(10, '推进')]), 24).stalled, false);
    assert.equal(t.threadStateAt(line([ev(10, '推进')]), 25).stalled, true);
    assert.equal(t.threadStateAt(line([ev(10, '收束')]), 99).gap, undefined);
  });

  test('過了計劃收束章還沒收是逾期；收了的不算', () => {
    assert.equal(t.threadStateAt(line([], { to: 20 }), 21).overdue, true);
    assert.equal(t.threadStateAt(line([], { to: 20 }), 20).overdue, false);
    assert.equal(t.threadStateAt(line([ev(19, '收束')], { to: 20 }), 30).overdue, false);
  });

  test('伏筆：登記了的在前、只在事件裡出現的跟在後面；狀態、埋在第幾章、逾期', () => {
    const x = line(
      [ev(3, '埋', { foreshadowing: '玉佩' }), ev(9, '收', { foreshadowing: '玉 佩' }), ev(4, '埋', { foreshadowing: '斷劍' })],
      { foreshadowing: [{ name: '玉佩', what: '沈家舊物', plant: 3, resolve: 18 }, { name: '舊傷', what: '', resolve: 6 }] }
    );
    const list = t.foreshadowingOf(x, 10);
    assert.deepEqual(
      list.map((f) => [f.name, f.status, f.plantedAt, f.closedAt, f.overdue]),
      [
        ['玉佩', '已收', 3, 9, false],
        ['舊傷', '计划', undefined, undefined, true],
        ['斷劍', '已埋', 4, undefined, false],
      ]
    );
  });

  test('推遲算數：那一行寫的回收章、計劃裡收它的那一章、寫明的「推遲到第 N 章收」取晚的；那一行不動', () => {
    const fore = [{ name: '信物之謎', what: '', plant: 3, resolve: 14 }];
    const planted = ev(3, '埋', { foreshadowing: '信物之謎' });
    // 只有那一行：第 82 章逾期。
    const bare = t.foreshadowingOf(line([planted], { foreshadowing: fore }), 82)[0];
    assert.deepEqual([bare.resolve, bare.resolveBy, bare.overdue], [14, 14, true]);
    // 拆細綱寫了推遲（線上的一條計劃推進）：按第 90 章算，第 82 章不逾期；過了第 90 章照樣逾期。
    const delay = { ...ev(81, '推进', { what: '〈信物之謎〉推遲到第 90 章收：它擴成了主幹' }), planned: true };
    const x = line([planted, delay], { foreshadowing: fore });
    const f = t.foreshadowingOf(x, 82)[0];
    assert.deepEqual([f.resolve, f.resolveBy, f.overdue], [14, 90, false]);
    assert.equal(t.foreshadowingOf(x, 91)[0].overdue, true);
    // 計劃裡收它的那一章更晚，也按它算。
    const planClose = { ...ev(95, '收', { foreshadowing: '信物之謎' }), planned: true };
    assert.equal(t.foreshadowingOf(line([planted, delay, planClose], { foreshadowing: fore }), 92)[0].resolveBy, 95);
    // asOf 去掉了推遲那一條：把原樣那一份的事件傳進去才認得到。
    const at83 = t.asOf(x, 81);
    assert.equal(t.foreshadowingOf(at83, 82)[0].overdue, true);
    assert.equal(t.foreshadowingOf(at83, 82, x.events)[0].overdue, false);
  });

  test('推遲算數：寫正文、拆細綱、寫前提醒都不再催著收', () => {
    const delay = { ...ev(81, '推进', { what: '〈信物之謎〉推遲到第 90 章收' }), planned: true };
    const story = line([ev(3, '埋', { foreshadowing: '信物之謎' }), ev(80, '推进'), delay], {
      name: '主线',
      kind: '主线',
      foreshadowing: [{ name: '信物之謎', what: '', plant: 3, resolve: 14 }],
    });
    const book = { threads: [story], unfiled: { name: '未歸屬的伏筆', relPath: 'u', foreshadowing: [], events: [] } };
    // 寫第 83 章：「第 90 章前不要揭開」，不是「已過第 14 章，還沒收」。
    assert.match(t.manuscriptThreads(book, 83, '').map((c) => c.line).join('\n'), /信物之謎（第 90 章前不要揭開）/);
    // 拆第 86–88 章（推遲寫在更早那一批的計劃裡）：不在「本批要收」那一檔。
    assert.equal(t.plotThreads(book, { from: 86, to: 88 }).foreshadowing.find((c) => c.name === '信物之謎').why, '第 90 章前收，之前不要揭開');
    // 重拆推遲所在的第 81 章：那一章原來的計劃這一次整組換掉，不算。
    assert.equal(t.plotThreads(book, { from: 81, to: 85 }).foreshadowing.find((c) => c.name === '信物之謎').why, '已過第 14 章，還沒收');
    // 寫前提醒（threadRemindersFor 在 model/pipeline.ts，單測在 threadReminders.test.js）要的數按第 90 章算。
    assert.deepEqual(t.threadWatch(book, 83).foreshadowing, [{ name: '信物之謎', resolve: 90, planned: [] }]);
  });

  test('deferralOf：認伏筆名後面的「推遲到第 N 章收 / 埋」，不認到別的伏筆頭上', () => {
    assert.deepEqual(t.deferralOf('〈信物之謎〉推遲到第 90 章收', '信物之謎'), { chapter: 90, type: '收' });
    assert.deepEqual(t.deferralOf('信物之謎推遲至第９０章再揭開', '信物 之謎'), { chapter: 90, type: '收' });
    assert.deepEqual(t.deferralOf('〈阿婆的身份〉推遲到第 12 章埋', '阿婆的身份'), { chapter: 12, type: '埋' });
    assert.deepEqual(t.deferralOf('〈信物之謎〉推遲到第 90 章', '信物之謎'), { chapter: 90, type: '收' }, '沒寫動詞當收');
    assert.equal(t.deferralOf('〈信物之謎〉照常推進，〈血契的代價〉推遲到第 30 章收', '信物之謎'), undefined);
    assert.equal(t.deferralOf('〈血契的代價〉推遲到第 30 章收', '信物之謎'), undefined);
    assert.equal(t.deferralOf('信物之謎露了一角', '信物之謎'), undefined);
  });
});

describe('threadFile.ts · 渲染與新建', () => {
  test('事件一行與伏筆一行的寫法', () => {
    assert.equal(
      t.renderEventLine({ chapter: 3, planned: true, type: '埋', foreshadowing: '玉佩', what: '露出來' }),
      '第 3 章 · 計劃 · 埋〈玉佩〉：露出來'
    );
    assert.equal(
      t.renderEventLine({ chapter: 12, planned: false, type: '关系', what: '結盟', evidence: '你的仇就是我的仇' }),
      '第 12 章 · 關係：結盟 〔證據：「你的仇就是我的仇」〕'
    );
    assert.equal(t.renderForeshadowLine({ name: '玉佩', what: '舊物', plant: 3, resolve: 18 }), '玉佩：舊物（計劃第 3 章埋、第 18 章前收）');
    assert.equal(t.renderForeshadowLine({ name: '舊傷', what: '', resolve: 6 }), '舊傷（第 6 章前收）');
  });

  test('新建一條線：讀回來與寫進去的一樣', () => {
    const raw = t.renderThreadFile({
      name: '沈家舊案',
      kind: '支线',
      origin: '正文',
      from: 5,
      intent: '十年前那把火是誰放的。',
      foreshadowing: [{ name: '火摺子', what: '現場留下的火摺子', plant: 5, resolve: 20 }],
      events: [{ chapter: 5, planned: false, type: '推进', what: '舊案被提起', evidence: '十年前那場大火' }],
    });
    const x = t.parseThreadFile(raw, '.novelwarden/threads/沈家舊案.md');
    assert.equal(x.kind, '支线');
    assert.equal(x.origin, '正文');
    assert.equal(x.from, 5);
    assert.equal(x.to, undefined);
    assert.equal(x.intent, '十年前那把火是誰放的。');
    assert.equal(x.progress, '');
    assert.deepEqual(x.foreshadowing, [{ name: '火摺子', what: '現場留下的火摺子', plant: 5, resolve: 20 }]);
    assert.equal(x.events.length, 1);
    assert.equal(x.events[0].evidence, '十年前那場大火');
    assert.match(raw, /generatedBy: novelwarden/);
    assert.ok(raw.endsWith('\n') && !raw.endsWith('\n\n'));
  });
});

describe('threadFile.ts · 外科式寫入', () => {
  test('追加伏筆：插在「伏筆」最後一行後面，同名（含事件裡出現過的）跳過，其餘位元組不動', () => {
    const { text, added } = t.appendForeshadowing(FILE, [
      { name: '玉 佩的來歷', what: '換個說法' },
      { name: '斷劍', what: '劍裡藏著字', resolve: 30 },
    ]);
    assert.deepEqual(added.map((f) => f.name), ['斷劍']);
    const lines = text.split('\n');
    const at = lines.indexOf('- 斷劍：劍裡藏著字（第 30 章前收）');
    assert.ok(at > 0);
    assert.equal(lines[at - 1], '> 說明文字，不是伏筆。');
    assert.equal(text.replace('- 斷劍：劍裡藏著字（第 30 章前收）\n', ''), FILE);
  });

  test('追加伏筆：沒有「伏筆」一節就在「進展」前面建；一條都沒加原樣返回', () => {
    const raw = '# 線\n\n## 意圖\n意圖\n\n## 進展\n- 第 1 章 · 推進：開頭\n';
    const { text } = t.appendForeshadowing(raw, [{ name: '玉佩', what: '' }]);
    assert.equal(text, '# 線\n\n## 意圖\n意圖\n\n## 伏筆\n\n- 玉佩\n\n## 進展\n- 第 1 章 · 推進：開頭\n');
    assert.equal(t.appendForeshadowing(raw, []).text, raw);
  });

  test('追加伏筆：空串（「未歸屬的伏筆」還不存在）也寫得出能讀回來的', () => {
    const { text } = t.appendForeshadowing(t.UNFILED_TEMPLATE, [{ name: '斷劍', what: '落潭' }]);
    assert.deepEqual(t.parseUnfiledFile(text, 'x').foreshadowing, [{ name: '斷劍', what: '落潭' }]);
    assert.match(text, /## 伏筆\n\n- 斷劍：落潭\n\n## 進展/);
  });

  test('追加實際事件：按章號插（同章計劃在前）、同一條不重複記、CRLF 與 BOM 原樣', () => {
    const crlf = `﻿${FILE.replace(/\n/g, '\r\n')}`;
    const fresh = { chapter: 5, planned: false, type: '推进', what: '沈青受傷', evidence: '血從指縫裡滲出來' };
    const again = { chapter: 3, planned: false, type: '推进', what: '換個說法', evidence: '她的劍停在他喉前三寸。' };
    const { text, added } = t.appendEvents(crlf, [fresh, again]);
    assert.deepEqual(added, [fresh]);
    assert.ok(text.startsWith('﻿---\r\n'));
    assert.ok(!/[^\r]\n/.test(text), '換行符都還是 CRLF');
    const lines = text.slice(1).split('\r\n');
    const at = lines.indexOf('- 第 5 章 · 推進：沈青受傷 〔證據：「血從指縫裡滲出來」〕');
    assert.match(lines[at + 1], /^- 第 12 章 · 關係/);
    assert.equal(text.replace('- 第 5 章 · 推進：沈青受傷 〔證據：「血從指縫裡滲出來」〕\r\n', ''), crlf);
  });

  test('追加實際事件：比已有的都晚就接在「進展」最後一行有字的後面；沒有「進展」就在末尾建', () => {
    const early = t.appendEvents(FILE, [{ chapter: 1, planned: false, type: '推进', what: '更早' }]).text;
    assert.equal(early, FILE.replace('## 進展\n', '## 進展\n- 第 1 章 · 推進：更早\n'), '插在第一條前面，不多出空行');
    const raw = '# 線\n\n## 進展\n\n- 第 1 章 · 推進：開頭\n\n## 作者的節\n隨筆\n';
    const { text } = t.appendEvents(raw, [{ chapter: 2, planned: false, type: '推进', what: '下一步' }]);
    assert.equal(text, '# 線\n\n## 進展\n\n- 第 1 章 · 推進：開頭\n- 第 2 章 · 推進：下一步\n\n## 作者的節\n隨筆\n');
    const bare = t.appendEvents('# 線\n', [{ chapter: 2, planned: false, type: '推进', what: '下一步' }]).text;
    assert.equal(bare, '# 線\n\n## 進展\n\n- 第 2 章 · 推進：下一步\n');
  });

  test('按章換計劃事件：只換這一章的計劃事件，插回原來的位置；實際事件與別的章不動', () => {
    const { text, removed } = t.replacePlannedEvents(FILE, 3, [{ type: '推进', what: '改了：兩人在雨裡初遇' }]);
    assert.equal(removed, 2);
    const x = t.parseThreadFile(text, REL);
    assert.deepEqual(
      x.events.filter((e) => e.planned).map((e) => e.what),
      ['改了：兩人在雨裡初遇']
    );
    assert.equal(x.events.filter((e) => !e.planned).length, 4);
    const lines = text.split('\n');
    assert.equal(lines[lines.indexOf('## 進展') + 1], '- 第 3 章 · 計劃 · 推進：改了：兩人在雨裡初遇');
  });

  test('按章換計劃事件：原來沒有的按章號插（排在同章實際事件前面）；給空的就是隻刪', () => {
    const { text } = t.replacePlannedEvents(FILE, 12, [{ type: '关系', what: '結盟' }]);
    const lines = text.split('\n');
    const at = lines.indexOf('- 第 12 章 · 計劃 · 關係：結盟');
    assert.match(lines[at + 1], /^- 第 12 章 · 關係：林昭—沈青/);
    const cleared = t.replacePlannedEvents(FILE, 3, []);
    assert.equal(cleared.removed, 2);
    assert.equal(t.parseThreadFile(cleared.text, REL).events.filter((e) => e.planned).length, 0);
    assert.equal(t.replacePlannedEvents(FILE, 7, []).text, FILE);
  });

  test('按證據清理：只刪這一章、證據已經不在正文裡的實際事件；沒證據的（作者手寫）與計劃事件不動', () => {
    const chapter3 = '她的劍停在他喉前三寸。兩人對視良久。';
    const { text, removed } = t.pruneChapterEvents(FILE, 3, chapter3);
    assert.deepEqual(removed.map((e) => e.type), ['埋']);
    assert.equal(text, FILE.replace('- 第 3 章 · 埋〈玉佩的來歷〉：玉佩第一次露面 〔證據：「他摸了摸懷裡那塊溫潤的玉佩」〕\n', ''));
    assert.equal(t.pruneChapterEvents(FILE, 13, '').text, FILE, '第 13 章那一筆沒有證據，是作者的');
  });
});

describe('threadFile.ts · 剪下、貼上一條伏筆（2026-10-24）', () => {
  const FROM = [
    '# 未歸屬的伏筆',
    '',
    '## 伏筆',
    '* 提燈人：院外提燈的人是誰（第 9 章前收）',
    '* 別的：不動',
    '',
    '## 進展',
    '* 第 2 章 · 埋〈提燈人〉：燈影 〔證據：「院外有燈」〕',
    '* 第 3 章 · 埋〈別的〉：x',
    '* 第 5 章 · 計劃 · 收〈提燈人〉：揭開',
    '',
  ].join('\r\n');
  const TO = ['# 線', '', '## 伏筆', '- 玉佩：舊物', '', '## 進展', '- 第 1 章 · 推進：開頭', '- 第 4 章 · 推進：中間', '- 第 6 章 · 推進：後來', ''].join('\n');

  test('剪：伏筆那一行與它的全部事件（計劃的、實際的），別的行與換行符不動；沒有它返回 undefined', () => {
    const r = t.cutForeshadowing(FROM, '提 燈人');
    assert.equal(r.text, ['# 未歸屬的伏筆', '', '## 伏筆', '* 別的：不動', '', '## 進展', '* 第 3 章 · 埋〈別的〉：x', ''].join('\r\n'));
    assert.equal(r.cut.row, '提燈人：院外提燈的人是誰（第 9 章前收）');
    assert.deepEqual(r.cut.events.map((x) => x.line), ['第 2 章 · 埋〈提燈人〉：燈影 〔證據：「院外有燈」〕', '第 5 章 · 計劃 · 收〈提燈人〉：揭開']);
    assert.equal(t.cutForeshadowing(FROM, '沒有這一條'), undefined);
  });

  test('貼：伏筆接在「伏筆」末尾，事件按章號插進「進展」，行原樣、換成這份的專案符號；讀回來狀態對', () => {
    const { cut } = t.cutForeshadowing(FROM, '提燈人');
    const out = t.pasteForeshadowing(TO, cut);
    assert.equal(
      out,
      [
        '# 線', '', '## 伏筆', '- 玉佩：舊物', '- 提燈人：院外提燈的人是誰（第 9 章前收）', '',
        '## 進展', '- 第 1 章 · 推進：開頭', '- 第 2 章 · 埋〈提燈人〉：燈影 〔證據：「院外有燈」〕', '- 第 4 章 · 推進：中間',
        '- 第 5 章 · 計劃 · 收〈提燈人〉：揭開', '- 第 6 章 · 推進：後來', '',
      ].join('\n')
    );
    const back = t.parseThreadFile(out, REL);
    assert.deepEqual(t.foreshadowingOf(back, 6).map((f) => [f.name, f.status]), [['玉佩', '计划'], ['提燈人', '已埋']]);
    // 已經有同名的那一行就不再貼（事件照貼）。
    assert.equal(t.pasteForeshadowing(out, { row: '提燈人：另一種說法', events: [] }), out);
  });
});

describe('threadFile.ts · 當前進度', () => {
  test('空的、指紋對得上的歸機器；改過的、沒記過指紋卻有內容的歸作者', () => {
    assert.equal(t.progressOwnedByMachine({ progress: '' }), true);
    assert.equal(t.progressOwnedByMachine({ progress: '（待補充）' }), true);
    assert.equal(t.progressOwnedByMachine({ progress: '結盟', progressHash: t.progressHashOf('結盟\n') }), true);
    assert.equal(t.progressOwnedByMachine({ progress: '結盟了', progressHash: t.progressHashOf('結盟') }), false);
    assert.equal(t.progressOwnedByMachine({ progress: '作者寫的' }), false);
  });

  test('換寫當前進度：只換這一節與兩個 frontmatter 欄位，讀回來指紋對得上', () => {
    const next = t.patchProgress(FILE, '第 15 章兩人反目。', 15);
    const x = t.parseThreadFile(next, REL);
    assert.equal(x.progress, '第 15 章兩人反目。');
    assert.equal(x.progressThrough, 15);
    assert.equal(t.progressOwnedByMachine(x), true);
    assert.equal(x.events.length, 6);
    assert.equal(
      next.replace(/progressThrough: 15\nprogressHash: \w+\n/, 'progressThrough: 12\nprogressHash: abc\n').replace('第 15 章兩人反目。', '第 12 章兩人在青崖鎮結盟，沈青仍瞞著自己是沈家遺孤。'),
      FILE.replace('## 當前進度\n第 12', '## 當前進度\n\n第 12')
    );
  });

  test('手寫的線沒有 frontmatter：補一段只有那兩個欄位的', () => {
    const next = t.patchProgress('# 線\n\n## 意圖\n寫寫\n', '剛開頭', 1);
    assert.match(next, /^---\nprogressThrough: 1\nprogressHash: \w+\n---\n\n# 線/);
    assert.equal(t.parseThreadFile(next, 'x/線.md').progress, '剛開頭');
  });
});

describe('threadFile.ts · 排線：校驗模型的輸出', () => {
  const existing = { threads: [{ name: '青雲舊案', kind: '主线' }], foreshadowing: ['火摺子'] };

  test('先逐條校驗再截：名字、種類、意圖、區間、重名、主線只能一條', () => {
    const { plans, dropped } = t.verifyThreadPlans(
      [
        { title: '青雲 舊案', kind: '主线', intent: '重名' },
        { title: '宗門大比', kind: '主线', intent: '主線已有' },
        { title: '斷劍之謎', kind: '懸念', intent: '種類不對' },
        { title: '執法堂', kind: '支线', from: 2, to: 30, intent: '越界' },
        { title: '倒過來', kind: '支线', from: 9, to: 3, intent: '區間反了' },
        { title: '', kind: '支线', intent: '沒名字' },
        { title: '未歸屬的伏筆', kind: '支线', intent: '保留名' },
        { title: '沒有意圖', kind: '支线' },
        { title: '林昭與沈青', type: '感情线', from: '3', to: 18, intent: '從猜忌到並肩。' },
        { title: '林昭的成長', kind: '人物线', intent: '從復仇到放下。' },
      ],
      existing,
      20
    );
    assert.deepEqual(plans.map((p) => [p.name, p.kind, p.origin, p.from, p.to]), [
      ['林昭與沈青', '感情线', '计划', 3, 18],
      ['林昭的成長', '人物线', '计划', undefined, undefined],
    ]);
    assert.deepEqual(dropped.map((d) => d.why), [
      t.SAME_THREAD,
      '主線全書只能有一條，已經有了',
      '種類不是主線 / 支線 / 感情線 / 人物線之一',
      '計劃區間不對（全書 20 章）',
      '計劃區間不對（全書 20 章）',
      '沒有名字',
      '「未歸屬的伏筆」是保留名',
      '意圖是空的',
    ]);
  });

  test('同一批裡第二條主線不收；一次最多 8 條', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ title: `線${i}`, kind: i < 2 ? '主线' : '支线', intent: '意图' }));
    const { plans, dropped } = t.verifyThreadPlans(many, { threads: [], foreshadowing: [] });
    assert.equal(plans.length, 8);
    assert.deepEqual(plans.filter((p) => p.kind === '主线').map((p) => p.name), ['線0']);
    assert.deepEqual(dropped.map((d) => d.why), ['主線全書只能有一條，已經有了', '一次最多排 8 條']);
  });

  test('伏筆：與全書已有的、同一批前面的重名跳過；章號不合理只去掉章號；一條線最多 5 條', () => {
    const fore = (title, extra = {}) => ({ title, what: `${title}是什麼`, ...extra });
    const { plans, foreshadowDropped } = t.verifyThreadPlans(
      [
        {
          title: '甲',
          kind: '支线',
          intent: '意图',
          foreshadowing: [fore('玉佩', { plant: 3, resolve: 18 }), fore('火 摺子'), fore('舊傷', { plant: 25, resolve: 2 }), fore('一'), fore('二'), fore('三'), fore('四')],
        },
        { title: '乙', kind: '支线', intent: '意图', foreshadowing: [fore('玉佩')] },
      ],
      existing,
      20
    );
    assert.deepEqual(plans[0].foreshadowing, [
      { name: '玉佩', what: '玉佩是什麼', plant: 3, resolve: 18 },
      { name: '舊傷', what: '舊傷是什麼', resolve: 2 },
      { name: '一', what: '一是什麼' },
      { name: '二', what: '二是什麼' },
      { name: '三', what: '三是什麼' },
    ]);
    assert.deepEqual(plans[1].foreshadowing, []);
    assert.deepEqual(foreshadowDropped.map((d) => [d.name, d.why]), [
      ['火 摺子', '同名的伏筆已經有了'],
      ['四', '一條線最多排 5 條伏筆'],
      ['玉佩', '同名的伏筆已經有了'],
    ]);
  });

  test('全書已有的伏筆名：各條線與未歸屬的，登記的與只在事件裡出現的都算', () => {
    const book = {
      threads: [line([ev(3, '埋', { foreshadowing: '斷劍' })], { foreshadowing: [{ name: '玉佩', what: '' }] })],
      unfiled: { name: '未歸屬的伏筆', relPath: 'x', foreshadowing: [{ name: '火摺子', what: '' }], events: [] },
    };
    assert.deepEqual(t.foreshadowNames(book), ['玉佩', '斷劍', '火摺子']);
  });
});

describe('threadFile.ts · 定稿：送哪些去認', () => {
  const pair = line([ev(3, '推进'), { ...ev(6, '推进'), planned: true }], {
    name: '林昭與沈青',
    kind: '感情线',
    index: 1,
    foreshadowing: [{ name: '玉佩', what: '舊物', resolve: 5 }, { name: '舊傷', what: '' }, { name: '名冊', what: '', plant: 9 }],
    progress: '結盟了',
    progressThrough: 6,
  });
  const main = line([ev(2, '推进')], { name: '主线', kind: '主线', index: 0 });
  const done = line([ev(2, '收束')], { name: '收了', index: 2 });
  const quiet = line([ev(5, '推进')], { name: '沈家舊案', index: 3, foreshadowing: [{ name: '火摺子', what: '', plant: 2 }] });
  const book = {
    threads: [main, pair, done, quiet],
    unfiled: {
      name: '未歸屬的伏筆',
      relPath: 'u',
      foreshadowing: [{ name: '提燈人', what: '' }],
      events: [ev(4, '埋', { foreshadowing: '提燈人' }), { ...ev(6, '埋', { foreshadowing: '斷劍' }), planned: true }],
    },
  };

  test('本章的計劃事件：各條線與未歸屬的都算，帶在哪條線上', () => {
    assert.deepEqual(t.plannedFor(book, 6).map((p) => [p.line, p.event.type, p.event.foreshadowing]), [
      ['林昭與沈青', '推进', undefined],
      [undefined, '埋', '斷劍'],
    ]);
  });

  test('線：本章有計劃的 → 細綱提到的 → 主線 → 最近動過的；收了的不送；超出的跳過；當前進度寫到這一章的不用', () => {
    const r = t.threadsToJudge(book, 6, '沈家舊案又被提起', 3);
    assert.deepEqual(r.judged.map((x) => x.name), ['林昭與沈青', '沈家舊案', '主线']);
    assert.equal(r.judged[0].progress, '', '當前進度寫到第 6 章，定稿第 6 章時不用');
    assert.equal(r.judged[0].events.length, 1, '第 6 章及以後的事件去掉');
    assert.deepEqual(t.threadsToJudge(book, 6, '', 1).skipped.map((x) => x.name), ['主线', '沈家舊案']);
  });

  // 只在本章計劃事件裡出現、還沒登記的（斷劍）不算「沒收的伏筆」：它在「本章計劃」那一節裡交給模型。
  test('伏筆：計劃到期卻沒埋的（到期早的在前）→ 已埋的 → 其餘；收了的不送；未歸屬的也在', () => {
    const r = t.foreshadowToJudge(book, 6, 10);
    assert.deepEqual(r.judged.map((f) => [f.name, f.line, f.status]), [
      ['火摺子', '沈家舊案', '计划'],
      ['玉佩', '林昭與沈青', '计划'],
      ['提燈人', undefined, '已埋'],
      ['舊傷', '林昭與沈青', '计划'],
      ['名冊', '林昭與沈青', '计划'],
    ]);
    assert.equal(t.foreshadowToJudge(book, 6, 2).skipped.length, 3);
  });

  // 試跑報告問題 4：沒收的伏筆第 7 章就超過 foreshadowJudge，「夥計的執念來源」計劃第 8 章埋，第 8 章恰好沒送去認——
  // 從前不看伏筆自己的計劃埋的章，沒埋的排線伏筆落在最末一檔，被模型自己登記的「已埋」擠了出去。
  test('伏筆：本章計劃埋或收的 → 計劃到期沒埋的 → 已埋沒收的（回收章近的在前、沒寫回收章的隨後）→ 其餘；上限照舊', () => {
    const grown = Array.from({ length: 6 }, (_, i) => ev(i + 1, '埋', { foreshadowing: `自登記${i + 1}` }));
    const big = {
      threads: [
        line(
          [...grown, ev(2, '埋', { foreshadowing: '名冊' }), ev(3, '埋', { foreshadowing: '舊傷' }), { ...ev(8, '收', { foreshadowing: '斷劍' }), planned: true }],
          {
            name: '主线',
            kind: '主线',
            index: 0,
            foreshadowing: [
              { name: '名冊', what: '', resolve: 30 },
              { name: '舊傷', what: '', resolve: 9 },
              { name: '斷劍', what: '', plant: 2, resolve: 8 },
              { name: '執念來源', what: '', plant: 8, resolve: 65 },
              { name: '溫情假象', what: '', plant: 1, resolve: 18 },
              { name: '後面才埋', what: '', plant: 20 },
            ],
          }
        ),
      ],
      unfiled: { name: '未歸屬的伏筆', relPath: 'u', foreshadowing: [], events: [] },
    };
    const r = t.foreshadowToJudge(big, 8, 6);
    assert.deepEqual(r.judged.map((f) => f.name), ['斷劍', '溫情假象', '執念來源', '舊傷', '名冊', '自登記6']);
    assert.deepEqual(r.skipped.map((f) => f.name), ['自登記5', '自登記4', '自登記3', '自登記2', '自登記1', '後面才埋']);
  });
});

describe('threadFile.ts · 定稿：校驗認出來的東西', () => {
  const text = '夜裡，沈青把玉佩翻過來，背面刻著一個沈字。從今往後，他不再疑她。院外有人提著燈走過。';
  const pair = line([], { name: '林昭與沈青', kind: '感情线', foreshadowing: [{ name: '玉佩', what: '' }] });
  const book = {
    threads: [pair, line([], { name: '主线', kind: '主线' }), line([ev(1, '收束')], { name: '收了' })],
    unfiled: { name: '未歸屬的伏筆', relPath: 'u', foreshadowing: [{ name: '提燈人', what: '' }], events: [] },
  };
  const verify = (raw, judged = [pair]) => t.verifyFinds(raw, { chapter: 6, text, judged, book });

  test('事件：線的事件只認送去的線與新線；伏筆的事件跟著伏筆走；證據逐字找得到；同一條只記一次', () => {
    // 玉佩、提燈人在這一章之前都埋下了（還沒埋下的不能收，見下一條）。
    const planted = {
      threads: [{ ...pair, events: [ev(3, '埋', { foreshadowing: '玉佩' })] }, ...book.threads.slice(1)],
      unfiled: { ...book.unfiled, events: [ev(2, '埋', { foreshadowing: '提燈人' })] },
    };
    const r = t.verifyFinds({
      events: [
        { line: '林昭與沈青', type: '关系', what: '猜忌 → 信任', evidence: '從今往後，他不再疑她' },
        { line: '林昭與沈青', type: '关系', what: '重複', evidence: '從今往後他不再疑她。' },
        { line: '隨便寫的', type: '收', foreshadowing: '玉 佩', what: '揭開', evidence: '背面刻著一個沈字' },
        { type: '收', foreshadowing: '提燈人', what: '露面', evidence: '院外有人提著燈走過' },
        { line: '收了', type: '推进', what: 'x', evidence: '院外有人提著燈走過' },
        { line: '誰也不是', type: '推进', what: 'x', evidence: '院外有人提著燈走過' },
        { line: '林昭與沈青', type: '昇華', what: 'x', evidence: '院外有人提著燈走過' },
        { line: '林昭與沈青', type: '推进', what: 'x', evidence: '編出來的一句話' },
        { line: '林昭與沈青', type: '推进', what: 'x', evidence: '沈字' },
        { line: '林昭與沈青', type: '收', foreshadowing: '沒見過', what: 'x', evidence: '院外有人提著燈走過' },
        { line: '林昭與沈青', type: '收', what: 'x', evidence: '院外有人提著燈走過' },
      ],
    }, { chapter: 6, text, judged: [pair], book: planted });
    assert.deepEqual(r.events.map((e) => [e.line, e.event.type, e.event.foreshadowing]), [
      ['林昭與沈青', '关系', undefined],
      ['林昭與沈青', '收', '玉佩'],
      [undefined, '收', '提燈人'],
    ]);
    assert.deepEqual(r.dropped.map((d) => d.why), [
      '這條線已經收束，或這一次沒送去認',
      '認不出是哪一條線',
      '事件型別認不出',
      '證據在正文裡找不到',
      '證據太短，認不出是哪一句',
      '認不出是哪一條伏筆',
      '沒寫是哪一條伏筆',
    ]);
  });

  // 復跑報告問題 2：證據丟棄率 13%，多半是把「他」換成了人名、兩句拼成一句。⚑ 找最接近的原句，夠像就換成原句收下。
  test('證據逐字找不到：正文裡最接近的一句夠像就換成那一句原文收下（記在 relocated 裡），不夠像照舊丟', () => {
    const r = verify({
      events: [
        { line: '林昭與沈青', type: '关系', what: '猜忌 → 信任', evidence: '從今往後，林昭不再疑她' },
        { line: '林昭與沈青', type: '推进', what: '編的', evidence: '林昭決定明天一早就離開青崖鎮' },
      ],
      newThreads: [{ title: '提燈人的身份', kind: '人物线', evidence: '院外有個人提著燈走過' }],
    });
    assert.deepEqual(r.events.map((e) => [e.event.type, e.event.evidence]), [['关系', '從今往後，他不再疑她。']]);
    assert.deepEqual(r.newThreads.map((x) => x.evidence), ['院外有人提著燈走過。']);
    assert.deepEqual(r.dropped.map((d) => d.why), ['證據在正文裡找不到']);
    assert.deepEqual(r.relocated, [
      { from: '院外有個人提著燈走過', to: '院外有人提著燈走過。' },
      { from: '從今往後，林昭不再疑她', to: '從今往後，他不再疑她。' },
    ]);
    assert.equal(verify({ events: [{ line: '林昭與沈青', type: '推进', what: 'x', evidence: '從今往後，他不再疑她' }] }).relocated, undefined, '逐字找得到的不算換過');
  });

  // 復跑報告問題 1（rerun-repro.js 第 1 段）：排線排的伏筆第 1 章還是「計劃」，a 報了「收」，校驗照收，從此不再提醒「不要提前揭開」。
  test('還沒埋下的伏筆不能收、不能棄；之前埋過、這一章有它的「埋」（報的、已經記下的）、新認出的才算埋下', () => {
    const r = verify({
      events: [
        { line: '林昭與沈青', type: '收', foreshadowing: '玉佩', what: '揭開', evidence: '背面刻著一個沈字' },
        { type: '弃', foreshadowing: '提燈人', what: '作廢', evidence: '院外有人提著燈走過' },
      ],
    });
    assert.deepEqual(r.events, []);
    assert.deepEqual(r.dropped, [
      { what: '林昭與沈青〈玉佩〉', why: '這條伏筆還沒埋下，不能收' },
      { what: '？〈提燈人〉', why: '這條伏筆還沒埋下，不能棄' },
    ]);
    // 同一章先埋後收（報的順序不論）：兩條都記。
    const both = verify({
      events: [
        { line: '林昭與沈青', type: '收', foreshadowing: '玉佩', what: '揭開', evidence: '背面刻著一個沈字' },
        { line: '林昭與沈青', type: '埋', foreshadowing: '玉佩', what: '露面', evidence: '沈青把玉佩翻過來' },
      ],
    });
    assert.deepEqual(both.events.map((e) => e.event.type), ['收', '埋']);
    // 證據找不到的「埋」不算這一章埋下了。
    const fake = verify({
      events: [
        { line: '林昭與沈青', type: '埋', foreshadowing: '玉佩', what: '露面', evidence: '編出來的一句話' },
        { line: '林昭與沈青', type: '收', foreshadowing: '玉佩', what: '揭開', evidence: '背面刻著一個沈字' },
      ],
    });
    assert.deepEqual(fake.events, []);
    // 重新定稿這一章：這一章已經記下了它的「埋」。
    const again = t.verifyFinds(
      { events: [{ type: '收', foreshadowing: '提燈人', what: '揭開', evidence: '院外有人提著燈走過' }] },
      { chapter: 6, text, judged: [pair], book: { ...book, unfiled: { ...book.unfiled, events: [ev(6, '埋', { foreshadowing: '提燈人' })] } } }
    );
    assert.deepEqual(again.events.map((e) => [e.event.type, e.event.foreshadowing]), [['收', '提燈人']]);
    // 這一章新認出的伏筆會補一條「埋」：同一章收它照記。
    const fresh = verify({
      newForeshadowing: [{ title: '斷劍', what: '', evidence: '背面刻著一個沈字' }],
      events: [{ type: '收', foreshadowing: '斷劍', what: '揭開', evidence: '院外有人提著燈走過' }],
    });
    assert.deepEqual(fresh.events.map((e) => [e.event.type, e.event.foreshadowing]), [['收', '斷劍']]);
  });

  test('新線：種類四選一、不重名、主線已有不收、要有證據、一章最多 2 條；事件可以掛在新線上', () => {
    const r = verify({
      newThreads: [
        { title: '沈家舊案', kind: '支线', intent: '沈家的事', evidence: '背面刻著一個沈字' },
        { title: '林昭 與沈青', kind: '感情线', evidence: '背面刻著一個沈字' },
        { title: '另一條主線', kind: '主线', evidence: '背面刻著一個沈字' },
        { title: '奇怪的線', kind: '暗線', evidence: '背面刻著一個沈字' },
        { title: '沒證據', kind: '支线', evidence: '編出來的一句話' },
        { title: '提燈人的身份', kind: '人物线', evidence: '院外有人提著燈走過' },
        { title: '第三條', kind: '支线', evidence: '院外有人提著燈走過' },
      ],
      events: [{ line: '沈家舊案', type: '推进', what: '沈字露面', evidence: '背面刻著一個沈字' }],
    });
    assert.deepEqual(r.newThreads.map((x) => [x.name, x.kind]), [['沈家舊案', '支线'], ['提燈人的身份', '人物线']]);
    assert.deepEqual(r.dropped.map((d) => d.why), [
      '這條線已經有了',
      '主線全書只能有一條，已經有了',
      '種類不是主線 / 支線 / 感情線 / 人物線之一',
      '證據在正文裡找不到',
      '一章最多認出 2 條新線',
    ]);
    assert.deepEqual(r.events.map((e) => e.line), ['沈家舊案']);
  });

  test('新伏筆：掛得上線就掛（已有的或新認出的），掛不上進未歸屬；沒見過的被埋了也當新伏筆', () => {
    const r = verify({
      newThreads: [{ title: '沈家舊案', kind: '支线', evidence: '背面刻著一個沈字' }],
      newForeshadowing: [
        { title: '沈字', what: '玉佩背面的沈字', line: '沈家舊案', evidence: '背面刻著一個沈字' },
        { title: '斷劍', what: '', line: '沒有這條線', evidence: '院外有人提著燈走過' },
        { title: '玉佩', what: '重名', evidence: '院外有人提著燈走過' },
      ],
      events: [{ line: '林昭與沈青', type: '埋', foreshadowing: '那盞燈', what: '提燈', evidence: '院外有人提著燈走過' }],
    });
    assert.deepEqual(r.newForeshadowing.map((f) => [f.name, f.line]), [
      ['沈字', '沈家舊案'],
      ['斷劍', undefined],
      ['那盞燈', '林昭與沈青'],
    ]);
    assert.deepEqual(r.dropped.map((d) => [d.what, d.why]), [['新伏筆 玉佩', '這條伏筆已經有了']]);
  });

  // 2026-10-24：從前伏筆事件的 line 一律不看，掛不上線的伏筆收了也一直留在未歸屬裡。
  test('未歸屬的伏筆被收、被棄，line 是送去認的線：挪過去（rehomed），這一章它的事件都落在那條線上；別的情況不挪', () => {
    const planted = {
      threads: [{ ...pair, events: [ev(3, '埋', { foreshadowing: '玉佩' })] }, ...book.threads.slice(1)],
      unfiled: {
        ...book.unfiled,
        foreshadowing: [{ name: '提燈人', what: '' }, { name: '斷劍', what: '' }, { name: '名冊', what: '' }, { name: '舊信', what: '' }],
        events: [ev(2, '埋', { foreshadowing: '提燈人' }), ev(2, '埋', { foreshadowing: '斷劍' })],
      },
    };
    const r = t.verifyFinds(
      {
        events: [
          { line: '林昭與沈青', type: '收', foreshadowing: '提燈人', what: '露面', evidence: '院外有人提著燈走過' },
          { line: '沒送去的線', type: '收', foreshadowing: '斷劍', what: 'x', evidence: '背面刻著一個沈字' },
          // 同一章先埋又收：「埋」那一條也跟著落到線上。
          { type: '埋', foreshadowing: '名冊', what: 'x', evidence: '從今往後，他不再疑她' },
          { line: '林昭與沈青', type: '收', foreshadowing: '名冊', what: 'x', evidence: '從今往後，他不再疑她' },
          // 已經掛在線上的的不挪。
          { line: '主线', type: '收', foreshadowing: '玉佩', what: 'x', evidence: '背面刻著一個沈字' },
        ],
      },
      { chapter: 6, text, judged: [pair, book.threads[1]], book: planted }
    );
    assert.deepEqual(r.events.map((e) => [e.line, e.event.type, e.event.foreshadowing]), [
      ['林昭與沈青', '收', '提燈人'],
      [undefined, '收', '斷劍'],
      ['林昭與沈青', '埋', '名冊'],
      ['林昭與沈青', '收', '名冊'],
      ['林昭與沈青', '收', '玉佩'],
    ]);
    assert.deepEqual(r.rehomed, [
      { name: '提燈人', line: '林昭與沈青' },
      { name: '名冊', line: '林昭與沈青' },
    ]);
    assert.equal(verify({ events: [] }).rehomed, undefined);
  });

  // ⚑ 試跑之後從 5 收到 3：模型報的新伏筆多半是噪音，一章就報了 4 條。
  test('一章最多認出 3 條新伏筆（先校驗後截）：單列的「埋」報出來的沒見過的伏筆也算在裡面', () => {
    const r = verify({
      newForeshadowing: [
        { title: '沈字', what: '', evidence: '編出來的一句話' },
        { title: '一', what: '', evidence: '背面刻著一個沈字' },
        { title: '二', what: '', evidence: '從今往後，他不再疑她' },
        { title: '三', what: '', evidence: '院外有人提著燈走過' },
      ],
      events: [{ line: '林昭與沈青', type: '埋', foreshadowing: '四', what: '', evidence: '院外有人提著燈走過' }],
    });
    assert.deepEqual(r.newForeshadowing.map((f) => f.name), ['一', '二', '三']);
    assert.deepEqual(r.dropped.map((d) => d.why), ['證據在正文裡找不到', '一章最多認出 3 條新伏筆']);
  });

  test('一章最多 8 個事件（先校驗後截）；整份不是物件也不崩', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ line: '林昭與沈青', type: '推进', what: `第${i}件`, evidence: i === 0 ? '編出來的一句話' : text.slice(i, i + 6) }));
    const r = verify({ events: many });
    assert.equal(r.events.length, 8);
    assert.deepEqual(r.dropped.map((d) => d.why), ['證據在正文裡找不到', '一章最多記 8 個事件']);
    assert.deepEqual(verify(null), { events: [], newThreads: [], newForeshadowing: [], dropped: [] });
    assert.deepEqual(verify([1, 2]).events, []);
  });

  test('歸併：線並進線、伏筆並進伏筆，認不出的不併；用上之後事件改掛、不另建', () => {
    const finds = verify({
      newThreads: [{ title: '沈家的舊案', kind: '支线', evidence: '背面刻著一個沈字' }],
      newForeshadowing: [{ title: '那塊玉佩', what: '', line: '沈家的舊案', evidence: '背面刻著一個沈字' }],
      events: [
        { line: '沈家的舊案', type: '推进', what: '露面', evidence: '背面刻著一個沈字' },
        { line: '林昭與沈青', type: '收', foreshadowing: '那塊玉佩', what: '揭開', evidence: '院外有人提著燈走過' },
      ],
    });
    const merges = t.verifyMerges(
      [
        { new: '沈家的舊案', into: '主线', reason: '同一樁舊案' },
        { new: '沈家的舊案', into: '林昭與沈青', reason: '同一樁舊案' },
        { new: '那塊玉佩', into: '林昭與沈青', reason: '同一塊玉佩' },
        { new: '那塊玉佩', into: '玉佩', reason: '同一塊玉佩' },
        { new: '不存在', into: '主线', reason: '沒有這一條' },
      ],
      finds,
      book,
      6
    );
    assert.deepEqual(merges, [
      { kind: 'thread', from: '沈家的舊案', into: '主线', reason: '同一樁舊案' },
      { kind: 'foreshadowing', from: '那塊玉佩', into: '玉佩', reason: '同一塊玉佩' },
    ]);
    const applied = t.applyMerges(finds, merges, book, 6);
    assert.deepEqual(applied.finds.newThreads, []);
    assert.deepEqual(applied.finds.newForeshadowing, []);
    // 玉佩寫到第 6 章時還是「計劃」：這一章就是它埋下的一章，補的「埋」排在同一章的「收」前面。
    assert.deepEqual(applied.finds.events.map((e) => [e.line, e.event.type, e.event.foreshadowing, e.event.evidence]), [
      ['主线', '推进', undefined, '背面刻著一個沈字'],
      ['林昭與沈青', '埋', '玉佩', '背面刻著一個沈字'],
      ['林昭與沈青', '收', '玉佩', '院外有人提著燈走過'],
    ]);
    assert.deepEqual(applied.merges, merges, '都帶過來了事件，沒有說明');
  });

  // 試跑報告問題 2（repro.js 第 2 段）：新伏筆只寫在 newForeshadowing、沒單列「埋」，並進已有的以後這一章的記錄整條沒了。
  describe('歸併之後新伏筆的那一條「埋」掛到已有的那條上', () => {
    const raw = [
      '---',
      'kind: 主線',
      'plan: 1-100',
      '---',
      '',
      '# 沈默的滅門復仇',
      '',
      '## 伏筆',
      '',
      '- 焦黑羅盤的本質：羅盤是大火餘燼。（計劃第 1 章埋、第 95 章前收）',
      '- 祠堂的隱秘：祠堂裡藏著靈位。',
      '',
      '## 進展',
      '',
      '- 第 1 章 · 埋〈祠堂的隱秘〉：祠堂第一次露面 〔證據：「祠堂的門半掩著」〕',
      '',
    ].join('\n');
    const main = t.parseThreadFile(raw, '.novelwarden/threads/沈默的滅門復仇.md');
    const story = { threads: [main], unfiled: t.parseUnfiledFile('', '.novelwarden/threads/未归属的伏笔.md') };
    const body = '羅盤雖然漸漸平息了那種滾燙的烙鐵感，但餘溫依舊像碎炭一般留在皮肉裡。祠堂地下有一座祭壇。';
    const find = (newForeshadowing, events = []) =>
      t.verifyFinds({ events, newThreads: [], newForeshadowing }, { chapter: 2, text: body, judged: [main], book: story });
    const run = (finds, raw) => {
      const r = t.applyMerges(finds, t.verifyMerges(raw, finds, story, 2), story, 2);
      return { merges: r.merges, events: t.completeFinds(r.finds, 2).events };
    };
    const burn = { title: '羅盤使用後的灼燒侵蝕', what: '灼燒感侵蝕活人氣息', line: '沈默的滅門復仇', evidence: '餘溫依舊像碎炭一般留在皮肉裡' };

    test('已有的那條還沒埋：這一章記一條「埋〈已有的〉」，證據用新伏筆的；完成提示不另加說明', () => {
      const r = run(find([burn]), [{ new: '羅盤使用後的灼燒侵蝕', into: '焦黑羅盤的本質', reason: '都是羅盤的代價' }]);
      assert.deepEqual(r.events.map((e) => [e.line, e.event.type, e.event.foreshadowing, e.event.what, e.event.evidence]), [
        ['沈默的滅門復仇', '埋', '焦黑羅盤的本質', '灼燒感侵蝕活人氣息', '餘溫依舊像碎炭一般留在皮肉裡'],
      ]);
      assert.equal(r.merges[0].note, undefined);
    });

    test('模型單列了「埋〈新的〉」：改叫已有的名字，同一章只記一條', () => {
      const r = run(find([burn], [{ line: '沈默的滅門復仇', type: '埋', foreshadowing: '羅盤使用後的灼燒侵蝕', what: '羅盤發燙', evidence: '滾燙的烙鐵感' }]), [
        { new: '羅盤使用後的灼燒侵蝕', into: '焦黑羅盤的本質', reason: '都是羅盤的代價' },
      ]);
      assert.deepEqual(r.events.map((e) => [e.event.type, e.event.foreshadowing, e.event.evidence]), [['埋', '焦黑羅盤的本質', '滾燙的烙鐵感']]);
    });

    test('已有的那條第 1 章已經埋下：不再記第二條「埋」，說明寫在 note 裡（完成提示照它說）', () => {
      const altar = { title: '祠堂地下祭壇', what: '祠堂地下有祭壇', line: '沈默的滅門復仇', evidence: '祠堂地下有一座祭壇' };
      const r = run(find([altar], [{ line: '沈默的滅門復仇', type: '埋', foreshadowing: '祠堂地下祭壇', what: '祭壇', evidence: '祠堂地下有一座祭壇' }]), [
        { new: '祠堂地下祭壇', into: '祠堂的隱秘', reason: '祠堂底下藏的就是祭壇' },
      ]);
      assert.deepEqual(r.events, []);
      assert.equal(r.merges[0].note, '〈祠堂的隱秘〉第 1 章已經埋下，這一章不再記「埋」');
    });

    test('已經埋下的伏筆，模型直接再報一次「埋」：不記，說清第幾章已經埋下', () => {
      const finds = find([], [{ line: '沈默的滅門復仇', type: '埋', foreshadowing: '祠堂的隱秘', what: '又見祠堂', evidence: '祠堂地下有一座祭壇' }]);
      assert.deepEqual(finds.events, []);
      assert.deepEqual(finds.dropped.map((d) => [d.what, d.why]), [['沈默的滅門復仇〈祠堂的隱秘〉', '這條伏筆第 1 章已經埋下']]);
      // 重新定稿第 1 章：埋在第 1 章那一次不算「之前」，照收（同一條由去重擋住）。
      const again = t.verifyFinds(
        { events: [{ line: '沈默的滅門復仇', type: '埋', foreshadowing: '祠堂的隱秘', what: '祠堂', evidence: '祠堂地下有一座祭壇' }] },
        { chapter: 1, text: body, judged: [main], book: story }
      );
      assert.equal(again.events.length, 1);
    });

    test('伏筆只能並進還沒收的：並進收了的那條不認（照新的建），理由只進日誌', () => {
      const closed = t.parseThreadFile(raw.replace('\n## 進展\n', '\n## 進展\n\n- 第 1 章 · 收〈焦黑羅盤的本質〉：揭開 〔證據：「羅盤」〕'), main.relPath);
      const book2 = { threads: [closed], unfiled: story.unfiled };
      assert.deepEqual(t.openForeshadowing(book2, 2).map((f) => [f.name, f.status]), [['祠堂的隱秘', '已埋']]);
      const finds = find([burn]);
      assert.deepEqual(t.verifyMerges([{ new: '羅盤使用後的灼燒侵蝕', into: '焦黑羅盤的本質' }], finds, book2, 2), []);
      assert.deepEqual(t.verifyMerges([{ new: '羅盤使用後的灼燒侵蝕', into: '焦黑羅盤的本質', reason: '都是羅盤的事' }], finds, story, 2), [
        { kind: 'foreshadowing', from: '羅盤使用後的灼燒侵蝕', into: '焦黑羅盤的本質', reason: '都是羅盤的事' },
      ]);
    });

    // 復跑報告問題 4：並了 2 次、2 次都錯，理由都是「兩者均指……」；修復 3 以後並錯的「埋」會記到已有伏筆上。⚑ 更保守。
    test('歸併更保守：沒給理由的不併；兩個伏筆名一個相同的詞都沒有的不併（復跑裡並錯的兩次）；沒採納的說出來', () => {
      const threat = { title: '紅姑的燈', what: '紅姑的燈火逼近', line: '沈默的滅門復仇', evidence: '餘溫依舊像碎炭一般留在皮肉裡' };
      const vessel = { title: '沈默的容器身份', what: '沈默是容器', line: '沈默的滅門復仇', evidence: '祠堂地下有一座祭壇' };
      const finds = find([threat, vessel, burn]);
      const rejected = [];
      const merges = t.verifyMerges(
        [
          { new: '紅姑的燈', into: '焦黑羅盤的本質', reason: '兩者均指代廢墟外正在逼近的威脅性邪祟。' },
          { new: '沈默的容器身份', into: '祠堂的隱秘', reason: '兩者均指向沈默非活人且作為某種載體的本質。' },
          { new: '羅盤使用後的灼燒侵蝕', into: '焦黑羅盤的本質' },
        ],
        finds,
        story,
        2,
        rejected
      );
      assert.deepEqual(merges, []);
      assert.deepEqual(rejected.map((r) => r.why), ['兩個名字裡沒有一個相同的詞', '兩個名字裡沒有一個相同的詞', '沒說為什麼是同一件事']);
      assert.match(rejected[0].what, /^〈紅姑的燈〉→〈焦黑羅盤的本質〉（兩者均指代/);
      // 線不看名字（同一條劇情線換個名字很常見），照樣要理由。
      assert.equal(t.namesShareWord('紅姑的燈', '紅姑的監視'), true);
      assert.equal(t.namesShareWord('祠堂地下祭壇', '祠堂的隱秘'), true);
      assert.equal(t.namesShareWord('沈默的容器身份', '屍斑的出現'), false);
    });

    test('並掉的新線這一章沒帶來任何事件：note 說「這一章沒有另記事件」，不替它編一條推進', () => {
      const finds = t.verifyFinds(
        { newThreads: [{ title: '復仇之路', kind: '支线', intent: '換個說法', evidence: '餘溫依舊像碎炭一般留在皮肉裡' }] },
        { chapter: 2, text: body, judged: [main], book: story }
      );
      const r = t.applyMerges(finds, [{ kind: 'thread', from: '復仇之路', into: '沈默的滅門復仇' }], story, 2);
      assert.deepEqual(t.completeFinds(r.finds, 2).events, []);
      assert.equal(r.merges[0].note, '這一章沒有另記事件');
    });
  });

  test('補上隱含的那一條：新線沒有事件記一條推進，新伏筆沒有埋記一條埋', () => {
    const finds = verify({
      newThreads: [{ title: '沈家舊案', kind: '支线', evidence: '背面刻著一個沈字' }],
      newForeshadowing: [{ title: '那盞燈', what: '提燈', evidence: '院外有人提著燈走過' }],
    });
    const done = t.completeFinds(finds, 6);
    assert.deepEqual(done.events.map((e) => [e.line, e.event.type, e.event.foreshadowing, e.event.evidence]), [
      ['沈家舊案', '推进', undefined, '背面刻著一個沈字'],
      [undefined, '埋', '那盞燈', '院外有人提著燈走過'],
    ]);
  });

  test('當前進度：名字認得出、不是空的才收，截到 150 字，一條線一條', () => {
    const long = '長'.repeat(200);
    assert.deepEqual(
      t.verifyProgress(
        [{ line: '林昭 與沈青', text: '結盟了' }, { line: '林昭與沈青', text: '又一條' }, { line: '沒送去的', text: 'x' }, { line: '主线', text: '' }, { thread: '主线', progress: long }],
        ['林昭與沈青', '主线']
      ).map((x) => [x.line, [...x.text].length]),
      [
        ['林昭與沈青', 3],
        ['主线', 150],
      ]
    );
  });

  // 試跑（gemini-3-flash-lite）：提示裡寫成「名字（種類）」，10 次裡 9 次照抄回來，22 條只落盤 1 條。
  test('當前進度：模型回的線名帶了種類、括號、引號、【線】標籤也認得出；原樣對得上的優先', () => {
    const sent = ['沈默的滅門復仇', '沈默與沈懷山的博弈', '林昭與沈青', '舊案', '舊案主線', '玉佩'];
    const got = t.verifyProgress(
      [
        { line: '沈默的滅門復仇（主線）', text: '一' },
        { line: '沈默與沈懷山的博弈 (人物線)', text: '二' },
        { line: '「林昭與沈青」〈感情線〉', text: '三' },
        { line: '舊案主線', text: '四' },
        { line: '【線】《玉佩》', text: '五' },
      ],
      sent
    );
    assert.deepEqual(got.map((x) => [x.line, x.text]), [
      ['沈默的滅門復仇', '一'],
      ['沈默與沈懷山的博弈', '二'],
      ['林昭與沈青', '三'],
      ['舊案主線', '四'],
      ['玉佩', '五'],
    ]);
    // 只有「舊案」送去了：「舊案 · 主線」去掉末尾的種類認成它。
    assert.deepEqual(t.verifyProgress([{ line: '舊案 · 主線', text: '六' }], ['舊案']).map((x) => x.line), ['舊案']);
    assert.deepEqual(t.verifyProgress([{ line: '舊案的餘波（主線）', text: '七' }], ['舊案']), [], '去掉裝飾也對不上的不收');
    assert.equal(t.bareThreadName('【線】「沈默的滅門復仇」（主線）'), '沈默的滅門復仇');
  });
});

describe('threadFile.ts · 寫正文、審稿帶哪幾條', () => {
  const pair = line(
    [ev(3, '推进', { what: '初遇。' }), ev(3, '埋', { foreshadowing: '玉佩' }), { ...ev(5, '推进', { what: '擋刀' }), planned: true }, { ...ev(5, '埋', { foreshadowing: '斷劍', what: '斷劍落潭' }), planned: true }],
    {
      name: '林昭與沈青',
      kind: '感情线',
      relPath: 'p',
      index: 0,
      progress: '結盟了。',
      progressThrough: 4,
      foreshadowing: [{ name: '玉佩', what: '舊物', resolve: 18 }, { name: '斷劍', what: '' }, { name: '名冊', what: '', plant: 9 }],
    }
  );
  const later = line([], { name: '後面才開', relPath: 'l', index: 1, from: 9 });
  const book = { threads: [pair, later], unfiled: { name: '未歸屬的伏筆', relPath: 'u', foreshadowing: [], events: [] } };

  test('一行：現在（去掉句末標點）、本章計劃、沒收的伏筆（本章計劃埋的在前，還沒到埋的不提）', () => {
    const [c] = t.manuscriptThreads(book, 5, '');
    assert.equal(c.line, '- 林昭與沈青（感情線 · 進行中）現在：結盟了；本章計劃：推進——擋刀；埋〈斷劍〉——斷劍落潭；沒收的伏筆：斷劍（本章計劃埋，不要當場揭開）、玉佩（第 18 章前不要揭開）');
    assert.deepEqual([c.relPath, c.status, c.why, c.rank], ['p', '进行中', '本章有計劃', 0]);
  });

  test('計劃中、還沒到開始那一章的不帶；當前進度寫到這一章或更晚的不用，改用之前的事件', () => {
    assert.deepEqual(t.manuscriptThreads(book, 5, '').map((c) => c.name), ['林昭與沈青']);
    const [c] = t.manuscriptThreads(book, 4, '');
    // 「最近」不取「埋」（復跑之後：「埋」那一句寫的多半是伏筆的謎面，不是這條線走到哪）。
    assert.equal(c.line, '- 林昭與沈青（感情線 · 進行中）最近：第 3 章推進：初遇；沒收的伏筆：玉佩（第 18 章前不要揭開）');
  });

  test('放不下的跳過、接著試下一條；明細裡怎麼稱呼可換', () => {
    const list = [{ line: 'a'.repeat(5) }, { line: 'b'.repeat(20) }, { line: 'c'.repeat(3) }];
    const r = t.fitThreads(list, { count: 2, chars: 10 }, '伏笔');
    assert.deepEqual(r.picked.map((x) => x.line), ['aaaaa', 'ccc']);
    assert.deepEqual(r.dropped.map((x) => x.note), ['伏筆一共只帶 10 字，放不下這一條']);
    assert.deepEqual(t.fitThreads(list, { count: 1, chars: 100 }).dropped.map((x) => x.note), [
      '敘事線一次只帶 1 條，排在後面的沒帶',
      '敘事線一次只帶 1 條，排在後面的沒帶',
    ]);
  });

  // 復跑報告問題 5 的兩個例子：細綱寫「發現兩枚銅牌與銅錢的共鳴契機」，伏筆叫「舊銅牌與銅錢的共鳴」。⚑ 六成、連著三個字。
  test('細綱提沒提到一條伏筆：去掉虛字之後的兩字詞六成出現、有兩個挨著；名字只有兩個字的要整個出現', () => {
    const plot = t.mentionTest('沈默發現兩枚銅牌與銅錢的共鳴契機。他撿到照骨鏡殘片，驚醒了無面鬼火。阿婆遞來一碗水。井底有人。沉船的秘密。他摸出玉佩。');
    assert.deepEqual(
      ['舊銅牌與銅錢的共鳴', '照骨鏡的殘片', '無面鬼火的本質', '阿婆的真實身份', '井底的秘密', '玉佩', '佩劍', '名冊'].map((n) => [n, plot(n)]),
      [
        ['舊銅牌與銅錢的共鳴', true],
        ['照骨鏡的殘片', true],
        ['無面鬼火的本質', true],
        ['阿婆的真實身份', false],
        ['井底的秘密', false],
        ['玉佩', true],
        ['佩劍', false],
        ['名冊', false],
      ]
    );
  });

  test('本章細綱、本章計劃提到的伏筆一律列出，不佔每條線 4 條的名額；收束了的線只列提到的那幾條', () => {
    const many = ['甲', '乙', '丙', '丁', '戊'].map((x, i) => ({ name: `${x}號暗格`, what: '', resolve: 20 + i }));
    const fores = [...many, { name: '照骨鏡的殘片', what: '', resolve: 30 }, { name: '還遠的計劃', what: '', plant: 9, resolve: 40 }];
    const main = line([ev(1, '推进', { what: '起火' }), ...fores.slice(0, 6).map((f) => ev(1, '埋', { foreshadowing: f.name }))], {
      name: '主线',
      kind: '主线',
      relPath: 'm',
      foreshadowing: fores,
    });
    main.events.push({ ...ev(5, '推进', { what: '〈還遠的計劃〉推遲到第 12 章埋' }), planned: true });
    const closed = line([ev(1, '埋', { foreshadowing: '沉船' }), ev(2, '收束')], { name: '收了', relPath: 'c', index: 1, foreshadowing: [{ name: '沉船', what: '' }] });
    const b = { threads: [main, closed], unfiled: { name: '未歸屬的伏筆', relPath: 'u', foreshadowing: [], events: [] } };
    const rows = t.manuscriptThreads(b, 5, '他撿到照骨鏡殘片。沉船浮出水面。');
    const m = rows.find((r) => r.name === '主线');
    assert.equal(
      m.line,
      '- 主线（主線 · 進行中）最近：第 1 章推進：起火；本章計劃：推進——〈還遠的計劃〉推遲到第 12 章埋；沒收的伏筆：照骨鏡的殘片（第 30 章前不要揭開）、' +
        '還遠的計劃（第 40 章前不要揭開）、甲號暗格（第 20 章前不要揭開）、乙號暗格（第 21 章前不要揭開）、丙號暗格（第 22 章前不要揭開）、丁號暗格（第 23 章前不要揭開）'
    );
    assert.deepEqual(m.mentioned, ['照骨鏡的殘片', '還遠的計劃']);
    const c = rows.find((r) => r.name === '收了');
    // 沒有回收章的不硬寫「不要提前揭開」。
    assert.deepEqual([c.line, c.rank, c.why], ['- 收了（支線 · 已收束）沒收的伏筆：沉船（還沒定哪一章收，細綱沒安排就別揭開）', 0, '本章細綱提到了它上面的伏筆']);
    assert.ok(t.reviewForeshadowing(b, 5).some((r) => r.line === '- 沉船（掛在「收了」· 已埋 · 還沒定哪一章收，細綱沒安排就不該揭開）'));
    // 沒提到時：收束了的線不帶，計劃中、還沒到埋的不提，主線照舊最多 4 條。
    const bare = t.manuscriptThreads(b, 5, '');
    assert.deepEqual(bare.map((r) => r.name), ['主线']);
    assert.ok(!bare[0].line.includes('照骨鏡') && !bare[0].line.includes('戊號暗格'), bare[0].line);
  });

  test('審稿：只提跟這一章有關的伏筆，「不要揭開」換成「不該揭開」', () => {
    assert.deepEqual(t.reviewForeshadowing(book, 5).map((c) => c.line), [
      '- 斷劍（掛在「林昭與沈青」· 計劃 · 本章計劃埋，不該當場揭開）',
      '- 玉佩（掛在「林昭與沈青」· 已埋 · 第 18 章前不該揭開）是什麼：舊物',
    ]);
  });
});

describe('threadFile.ts · 拆細綱帶哪幾條（二期）', () => {
  const plan = (chapter, type, extra = {}) => ({ ...ev(chapter, type, extra), planned: true });
  const pair = line(
    [ev(3, '推进', { what: '初遇。' }), ev(3, '埋', { foreshadowing: '玉佩' }), plan(6, '推进', { what: '擋刀' }), plan(7, '收', { foreshadowing: '舊傷' })],
    {
      name: '林昭與沈青',
      kind: '感情线',
      relPath: 'p',
      index: 0,
      from: 2,
      to: 30,
      intent: '從猜忌到並肩。',
      progress: '結盟了。',
      progressThrough: 4,
      foreshadowing: [
        { name: '玉佩', what: '舊物', resolve: 18 },
        { name: '舊傷', what: '', resolve: 7 },
        { name: '名冊', what: '', plant: 9 },
        { name: '令牌', what: '', plant: 5, resolve: 20 },
      ],
    }
  );
  const fire = line([ev(1, '推进', { what: '起火' })], { name: '大火', kind: '主线', relPath: 'f', index: 1, from: 1, to: 40 });
  const later = line([], { name: '後面才開', relPath: 'l', index: 2, from: 12, foreshadowing: [{ name: '師父的信', what: '' }] });
  const quiet = line([ev(2, '推进', { what: '猶豫' })], { name: '斷了的線', kind: '人物线', relPath: 'q', index: 3 });
  const closed = line([ev(2, '收束')], { name: '收了的線', relPath: 'c', index: 4, foreshadowing: [{ name: '收了線上沒收的', what: '', resolve: 4 }] });
  const unfiled = {
    name: '未歸屬的伏筆',
    relPath: 'u',
    foreshadowing: [{ name: '提燈人', what: '院外提燈的人', resolve: 4 }],
    events: [ev(2, '埋', { foreshadowing: '提燈人' })],
  };
  const book = { threads: [pair, fire, later, quiet, closed], unfiled };

  test('線：這幾章原來有計劃的 → 主線 → 進行中的 → 還沒到開始的（寫明還不到）；收束了的不帶', () => {
    const { lines } = t.plotThreads(book, { from: 5, to: 9 });
    assert.deepEqual(lines.map((c) => [c.name, c.why]), [
      ['林昭與沈青', '本批原來有計劃'],
      ['大火', '主线'],
      ['斷了的線', '最近第 2 章動過'],
      ['後面才開', '計劃第 12 章起，本批還不到'],
    ]);
    assert.equal(
      lines[0].line,
      '- 林昭與沈青（感情線 · 進行中 · 計劃第 2–30 章）意圖：從猜忌到並肩；現在：結盟了；最近：第 3 章推進：初遇；第 3 章埋〈玉佩〉；本批原來的計劃：第 6 章推進——擋刀'
    );
    assert.equal(lines[3].line, '- 後面才開（支線 · 計劃中 · 計劃第 12 章起）本批還不到它開始的那一章，不要提前開');
  });

  test('伏筆：這幾章或更早要收的在前（逾期的寫「已過」）→ 原來有計劃的 → 計劃在這幾章埋的 → 已埋的；之後才埋的不帶', () => {
    const { foreshadowing } = t.plotThreads(book, { from: 5, to: 9 });
    assert.deepEqual(foreshadowing.map((c) => c.line), [
      '- 收了線上沒收的（掛在「收了的線」· 計劃 · 已過第 4 章，還沒收，還沒埋，先埋再收）',
      '- 提燈人（掛在「未歸屬的伏筆」· 已埋 · 已過第 4 章，還沒收）是什麼：院外提燈的人',
      '- 舊傷（掛在「林昭與沈青」· 計劃 · 本批要收，最晚第 7 章，還沒埋，先埋再收）本批原來的計劃：第 7 章收',
      '- 令牌（掛在「林昭與沈青」· 計劃 · 本批要埋，計劃第 5 章、第 20 章前收）',
      '- 名冊（掛在「林昭與沈青」· 計劃 · 本批要埋，計劃第 9 章）',
      '- 玉佩（掛在「林昭與沈青」· 已埋 · 第 18 章前收，之前不要揭開）是什麼：舊物',
    ]);
    // 「後面才開」那條線還沒開始：它上面沒定哪一章埋的伏筆不提。
    assert.ok(!foreshadowing.some((c) => c.name === '師父的信'));
  });

  // 2026-10-25 外部報告：寫到第 83 章，第 2–4 章埋下、沒定回收章的開篇伏筆按「埋得早的在前」佔滿名額，
  // 「本批要埋」與同檔、排在它們後面，被擠掉之後 unplannedDue 照樣報漏排。
  test('寫到後面：本批要埋的排在所有已埋的前面；已埋的定了回收章的在前，沒定的最近動過的在前；這一次提到的提前', () => {
    const old = ['幻池倒影', '特招體檢', '空間裂縫', '舊日學徒', '湖底石碑', '街市傳聞'].map((name) => ({ name, what: '' }));
    const main = line(
      [
        ev(1, '推进'),
        ...old.map((f, i) => ev(2 + i, '埋', { foreshadowing: f.name })),
        ev(60, '埋', { foreshadowing: '中段伏筆' }),
        ev(80, '埋', { foreshadowing: '近期伏筆' }),
        ev(81, '埋', { foreshadowing: '幻池倒影' }),
      ],
      {
        name: '主线',
        kind: '主线',
        relPath: 'm',
        from: 1,
        foreshadowing: [
          ...old,
          { name: '中段伏筆', what: '', resolve: 120 },
          { name: '近期伏筆', what: '' },
          { name: '本批該埋的', what: '', plant: 84 },
          { name: '神秘來信', what: '' },
        ],
      }
    );
    const b = { threads: [main], unfiled: { name: '未歸屬的伏筆', relPath: 'u', foreshadowing: [], events: [] } };
    assert.deepEqual(t.plotThreads(b, { from: 83, to: 85 }).foreshadowing.map((c) => c.name), [
      '本批該埋的',
      '中段伏筆',
      // 第 81 章再埋過一次：算最近動過。
      '幻池倒影',
      '近期伏筆',
      '街市傳聞',
      '湖底石碑',
      '舊日學徒',
      '空間裂縫',
      '特招體檢',
      '神秘來信',
    ]);
    const said = t.plotThreads(b, { from: 83, to: 85 }, '第 84 章：主角在湖底石碑前收到神秘來信').foreshadowing;
    assert.deepEqual(said.slice(0, 3).map((c) => c.name), ['本批該埋的', '湖底石碑', '神秘來信']);
    assert.equal(said[1].why, '還沒定哪一章收，不要隨手揭開；本批細綱或作者的話裡提到了');
    // 提到了只改先後，交給模型的那一行不變。
    assert.equal(said[1].line, '- 湖底石碑（掛在「主线」· 已埋 · 還沒定哪一章收，不要隨手揭開）');
  });

  test('單章說「本章」；按區間第一章算：當前進度寫到那一章或更晚不用，之後的事件不算', () => {
    const { lines, foreshadowing } = t.plotThreads(book, { from: 3, to: 3 });
    assert.equal(lines[0].name, '大火');
    const p = lines.find((c) => c.name === '林昭與沈青');
    assert.equal(p.line, '- 林昭與沈青（感情線 · 計劃中 · 計劃第 2–30 章）意圖：從猜忌到並肩');
    assert.equal(p.why, '本批在它的計劃區間裡'.replace('本批', '本章'));
    // 第 7 章才收、本章沒計劃，也沒定哪一章埋：線已經到了計劃區間，照提，寫明還沒定。
    assert.equal(foreshadowing.find((c) => c.name === '舊傷').why, '還沒定哪一章埋');
    assert.ok(!foreshadowing.some((c) => c.name === '令牌'), '計劃第 5 章才埋');
    assert.equal(t.planScope({ from: 3, to: 3 }), '本章');
    assert.equal(t.planScope({ from: 3, to: 7 }), '本批');
  });
});

describe('threadFile.ts · 拆細綱：計劃落到哪份檔案上（二期）', () => {
  const plan = (chapter, type, extra = {}) => ({ ...ev(chapter, type, extra), planned: true });
  const pair = line([ev(3, '推进'), ev(3, '埋', { foreshadowing: '玉佩' }), plan(6, '推进', { what: '舊的計劃' })], {
    name: '林昭與沈青',
    relPath: 'p',
    index: 0,
    foreshadowing: [{ name: '玉佩', what: '舊物', resolve: 18 }, { name: '舊傷', what: '' }],
  });
  const closed = line([ev(2, '收束')], { name: '收了的線', relPath: 'c', index: 1, foreshadowing: [{ name: '收了的伏筆', what: '' }] });
  closed.events.push(ev(2, '收', { foreshadowing: '收了的伏筆' }));
  const unfiled = {
    name: '未歸屬的伏筆',
    relPath: 'u',
    foreshadowing: [{ name: '提燈人', what: '' }],
    events: [ev(2, '埋', { foreshadowing: '提燈人' }), plan(6, '收', { foreshadowing: '提燈人' })],
  };
  const book = { threads: [pair, closed], unfiled };
  const entry = (line, type, extra = {}) => ({ line, type, what: '', ...extra });

  test('線的事件：認得出、沒收束的線才記；認不出的、收束了的丟掉並說原因', () => {
    const [c] = t.resolvePlanEvents(book, [
      { no: 6, entries: [entry('林昭 與 沈青', '推进', { what: '擋刀' }), entry('沒有這條線', '关系'), entry('收了的線', '推进')] },
    ]);
    assert.deepEqual(c.events, [{ line: '林昭與沈青', event: { chapter: 6, planned: true, type: '推进', what: '擋刀' } }]);
    assert.deepEqual(c.dropped, [
      { what: '沒有這條線 關係', why: '認不出是哪一條線' },
      { what: '收了的線 推進', why: '這條線已經收束了' },
    ]);
    // 第 6 章原來有兩條計劃（線上一條、未歸屬裡一條）：寫入時整組換掉。
    assert.equal(c.replaced, 2);
  });

  test('伏筆的事件跟著伏筆走（不看 line）；收了的不記，已經埋下的再埋不記；沒見過的被收丟掉', () => {
    const [c] = t.resolvePlanEvents(book, [
      {
        no: 6,
        entries: [
          entry('別的線', '收', { foreshadowing: '提燈人' }),
          entry('', '收', { foreshadowing: '玉佩' }),
          entry('', '收', { foreshadowing: '收了的伏筆' }),
          entry('', '埋', { foreshadowing: '玉佩' }),
          entry('', '收', { foreshadowing: '沒見過' }),
        ],
      },
    ]);
    assert.deepEqual(
      c.events.map((e) => [e.line, e.event.type, e.event.foreshadowing]),
      [
        [undefined, '收', '提燈人'],
        ['林昭與沈青', '收', '玉佩'],
      ]
    );
    assert.deepEqual(c.dropped.map((d) => d.why), ['這條伏筆已經收了', '這條伏筆第 3 章已經埋下了', '認不出是哪一條伏筆']);
  });

  test('沒見過的伏筆被埋：掛在認得出的線上，認不出進未歸屬；登記成「計劃第 N 章埋、第 b 章前收」；後面幾章收它認得出', () => {
    const [a, b] = t.resolvePlanEvents(book, [
      { no: 8, entries: [entry('林昭與沈青', '收', { foreshadowing: '斷劍' })] },
      {
        no: 7,
        entries: [
          entry('林昭與沈青', '埋', { foreshadowing: '斷劍', what: '斷劍落潭', resolve: 9 }),
          entry('瞎寫的線', '埋', { foreshadowing: '名冊', what: '名冊少一頁' }),
        ],
      },
    ]);
    // 按章號先後走：第 7 章先埋，第 8 章才收得到。
    assert.deepEqual([a.no, b.no], [7, 8]);
    assert.deepEqual(a.newForeshadowing, [
      { line: '林昭與沈青', foreshadowing: { name: '斷劍', what: '斷劍落潭', plant: 7, resolve: 9 } },
      { foreshadowing: { name: '名冊', what: '名冊少一頁', plant: 7 } },
    ]);
    assert.deepEqual(a.events.map((e) => [e.line, e.event.type, e.event.foreshadowing]), [
      ['林昭與沈青', '埋', '斷劍'],
      [undefined, '埋', '名冊'],
    ]);
    assert.deepEqual(b.events, [{ line: '林昭與沈青', event: { chapter: 8, planned: true, type: '收', foreshadowing: '斷劍', what: '' } }]);
    assert.equal(a.replaced, 0);
  });

  // 復跑報告問題 1：拆細綱照寫了「沒埋就收」（未歸屬的伏筆裡〈無面鬼火的實體凝聚〉第 15 章計劃收，從沒埋過）。
  test('計劃「收」要排在「埋」之後：實際埋過、或者更早的一章計劃埋它（已有的、這一批前面幾章的）才記', () => {
    const fresh = {
      ...book,
      threads: [
        {
          ...pair,
          foreshadowing: [...pair.foreshadowing, { name: '名冊', what: '', plant: 5 }, { name: '令牌', what: '' }, { name: '斷劍', what: '' }],
          events: [...pair.events, plan(5, '埋', { foreshadowing: '令牌' }), plan(9, '埋', { foreshadowing: '斷劍' })],
        },
        closed,
      ],
    };
    const [c7, c8] = t.resolvePlanEvents(fresh, [
      {
        no: 7,
        entries: [
          entry('', '收', { foreshadowing: '舊傷' }),
          entry('', '收', { foreshadowing: '名冊' }),
          entry('', '收', { foreshadowing: '令牌' }),
          entry('', '收', { foreshadowing: '斷劍' }),
          entry('', '埋', { foreshadowing: '名冊' }),
        ],
      },
      { no: 8, entries: [entry('', '收', { foreshadowing: '名冊' })] },
    ]);
    // 舊傷從沒埋過、也沒有計劃埋；名冊「計劃第 5 章埋」只是伏筆那一行寫的，不算安排過；斷劍計劃第 9 章才埋；同一章先埋後收也不算。
    assert.deepEqual(c7.events.map((e) => [e.event.type, e.event.foreshadowing]), [['收', '令牌'], ['埋', '名冊']]);
    assert.deepEqual(c7.dropped.map((d) => d.what), ['收〈舊傷〉', '收〈名冊〉', '收〈斷劍〉']);
    assert.match(c7.dropped[0].why, /還沒埋，「收」要排在「埋」之後/);
    // 第 7 章剛排了「埋〈名冊〉」，第 8 章收得到。
    assert.deepEqual(c8.events.map((e) => [e.event.type, e.event.foreshadowing]), [['收', '名冊']]);
    // 這一次要換掉的那一章裡原來的「埋」不算：第 5 章重拆、沒再埋令牌，第 7 章就收不了。
    const [, r7] = t.resolvePlanEvents(fresh, [
      { no: 5, entries: [] },
      { no: 7, entries: [entry('', '收', { foreshadowing: '令牌' })] },
    ]);
    assert.deepEqual(r7.events, []);
  });

  test('解碼：沒寫是 undefined、寫成別的形狀當空的；逐條校驗；規範化的形狀原樣', () => {
    assert.deepEqual(t.decodePlanEntries(undefined, 3), { notes: [] });
    assert.deepEqual(t.decodePlanEntries('亂寫', 3).entries, []);
    const r = t.decodePlanEntries([{ line: '甲', type: '埋', foreshadowing: '未歸屬的伏筆' }, { line: '甲', type: '埋', foreshadowing: '玉佩', resolve: 2 }], 3);
    assert.deepEqual(r.entries, [{ line: '甲', type: '埋', foreshadowing: '玉佩', what: '' }], '回收章不比本章晚的不要');
    assert.match(r.notes[0], /伏筆「未歸屬的伏筆」是保留名/);
    assert.deepEqual(t.planEntryJson({ line: '', type: '埋', foreshadowing: '玉佩', what: 'x', resolve: 9 }), {
      line: '',
      type: '埋',
      foreshadowing: '玉佩',
      what: 'x',
      resolve: 9,
    });
  });
});

// 復跑報告問題 3：第 11–15 章拆出來 12 條全是「推進」，到期該埋的 3 條一條也沒排；補充實驗裡該收的漏了 1 條、也沒寫推遲。
describe('threadFile.ts · 拆細綱：到期卻沒安排的伏筆（復跑之後）', () => {
  const plan = (chapter, type, extra = {}) => ({ ...ev(chapter, type, extra), planned: true });
  const main = line([ev(1, '推进'), ev(4, '埋', { foreshadowing: '井底的秘密' }), plan(14, '收', { foreshadowing: '鎮子底下的骨頭' })], {
    name: '滅門復仇',
    kind: '主线',
    relPath: 'm',
    foreshadowing: [
      { name: '阿婆的真實身份', what: '', plant: 5, resolve: 18 },
      { name: '無面鬼火的本質', what: '', plant: 9, resolve: 20 },
      { name: '井底的秘密', what: '', resolve: 13 },
      { name: '照骨鏡的殘片', what: '', resolve: 15 },
      { name: '鎮子底下的骨頭', what: '', resolve: 12 },
      { name: '還遠著的', what: '', plant: 30, resolve: 40 },
    ],
  });
  main.events.push(ev(8, '埋', { foreshadowing: '鎮子底下的骨頭' }));
  const body = line([ev(1, '推进')], { name: '死僵化', kind: '人物线', relPath: 'b', index: 1, foreshadowing: [{ name: '屍斑的出現', what: '', plant: 12, resolve: 19 }] });
  const book = { threads: [main, body], unfiled: { name: '未歸屬的伏筆', relPath: 'u', foreshadowing: [], events: [] } };
  const entry = (lineName, type, extra = {}) => ({ line: lineName, type, what: '', ...extra });
  const batch = (entriesOf) => [11, 12, 13, 15].map((no) => ({ no, entries: entriesOf(no) }));

  test('只排了推進：到期該埋的（這幾章裡的、早就過了的）、該收的都列出來；第 14 章原來的計劃算安排過；還遠的不算', () => {
    const due = t.unplannedDue(book, batch(() => [entry('滅門復仇', '推进')]));
    assert.deepEqual(due.map((u) => [u.name, u.line, u.need]), [
      ['阿婆的真實身份', '滅門復仇', ['埋']],
      ['無面鬼火的本質', '滅門復仇', ['埋']],
      ['井底的秘密', '滅門復仇', ['收']],
      ['照骨鏡的殘片', '滅門復仇', ['收']],
      ['屍斑的出現', '死僵化', ['埋']],
    ]);
    assert.deepEqual(due.map(t.describeUnplannedDue), [
      '〈阿婆的真實身份〉（計劃第 5 章埋，還沒埋）',
      '〈無面鬼火的本質〉（計劃第 9 章埋，還沒埋）',
      '〈井底的秘密〉（第 13 章前收）',
      '〈照骨鏡的殘片〉（第 15 章前收）',
      '〈屍斑的出現〉（計劃第 12 章埋，還沒埋）',
    ]);
  });

  test('安排了的、寫明推遲的不算；沒埋就收的被丟掉，照樣算沒安排', () => {
    const due = t.unplannedDue(
      book,
      batch((no) =>
        no === 11
          ? [entry('', '埋', { foreshadowing: '阿婆的真實身份' }), entry('', '收', { foreshadowing: '照骨鏡的殘片' }), entry('', '收', { foreshadowing: '井底的秘密' })]
          : no === 12
            ? [entry('滅門復仇', '推进', { what: '〈無面鬼火的本質〉推遲到第 22 章埋：先收拾紅姑' }), entry('', '埋', { foreshadowing: '屍斑的出現' })]
            : []
      )
    );
    // 照骨鏡的殘片從沒埋過：第 11 章的「收」被丟掉，還是沒安排。
    assert.deepEqual(due.map((u) => [u.name, u.need]), [['照骨鏡的殘片', ['收']]]);
    assert.deepEqual(t.unplannedDue(book, []), []);
  });

  test('拆細綱那一層：回收章到了、還沒埋的說「先埋再收」，前面排過「埋」的不說；該埋的說「本批要埋」', () => {
    const { foreshadowing } = t.plotThreads(
      { ...book, threads: [{ ...main, events: [...main.events, plan(10, '埋', { foreshadowing: '照骨鏡的殘片' })] }, body] },
      { from: 11, to: 15 }
    );
    const hint = (name) => foreshadowing.find((c) => c.name === name).why;
    assert.equal(hint('井底的秘密'), '本批要收，最晚第 13 章');
    assert.equal(hint('照骨鏡的殘片'), '本批要收，最晚第 15 章');
    assert.equal(hint('阿婆的真實身份'), '計劃第 5 章埋，還沒埋、第 18 章前收');
    assert.equal(hint('屍斑的出現'), '本批要埋，計劃第 12 章、第 19 章前收');
    assert.equal(t.plotThreads(book, { from: 11, to: 15 }).foreshadowing.find((c) => c.name === '照骨鏡的殘片').why, '本批要收，最晚第 15 章，還沒埋，先埋再收');
  });
});

describe('threadFile.ts · 寫前檢查要的數（二期）', () => {
  const plan = (chapter, type, extra = {}) => ({ ...ev(chapter, type, extra), planned: true });
  const main = line([ev(1, '推进'), ev(6, '推进'), plan(8, '关系')], { name: '青崖舊案', kind: '主线', relPath: 'm', index: 0, foreshadowing: [{ name: '玉佩', what: '', resolve: 5 }, { name: '名冊', what: '' }] });
  main.events.push(plan(9, '收', { foreshadowing: '玉佩' }));
  const later = line([], { name: '還沒開始', relPath: 'l', index: 1 });
  const closed = line([ev(2, '收束')], { name: '收了', relPath: 'c', index: 2, foreshadowing: [{ name: '收了線上的', what: '', resolve: 4 }] });
  const unfiled = { name: '未歸屬的伏筆', relPath: 'u', foreshadowing: [{ name: '提燈人', what: '', resolve: 3 }], events: [ev(2, '收', { foreshadowing: '提燈人' })] };
  const book = { threads: [main, later, closed], unfiled };

  test('線只算進行中的（帶閾值與有計劃事件的章）；伏筆只算沒收、寫了回收章的（帶計劃收它的章）', () => {
    // 玉佩那一行寫第 5 章前收，計劃排到了第 9 章收：按晚的算（2026-10-24 推遲算數）。
    assert.deepEqual(t.threadWatch(book), {
      lines: [{ name: '青崖舊案', kind: '主线', lastActive: 6, stall: 5, planned: [8, 9] }],
      foreshadowing: [
        { name: '玉佩', resolve: 9, planned: [9] },
        { name: '收了線上的', resolve: 4, planned: [] },
      ],
      unplanted: [],
    });
  });

  // 復跑之後的第三類提醒要的數：還是「計劃」、寫了計劃埋的章的伏筆，帶哪幾章計劃埋它；埋了的、收了的不算。
  test('還沒埋的伏筆：狀態「計劃」、寫了計劃埋的章（帶計劃埋它的章）；按寫到第 N 章時算', () => {
    const story = line([ev(1, '推进'), ev(6, '埋', { foreshadowing: '名冊' }), plan(12, '埋', { foreshadowing: '影子' })], {
      name: '主线',
      kind: '主线',
      relPath: 'm',
      foreshadowing: [
        { name: '阿婆的身份', what: '', plant: 5, resolve: 18 },
        { name: '名冊', what: '', plant: 3 },
        { name: '影子', what: '', plant: 10 },
        { name: '沒寫埋的章', what: '' },
      ],
    });
    const b = { threads: [story], unfiled: { name: '未歸屬的伏筆', relPath: 'u', foreshadowing: [], events: [] } };
    // 影子那一行寫第 10 章埋，計劃排到了第 12 章：按晚的算（2026-10-24 推遲算數）。
    assert.deepEqual(t.threadWatch(b).unplanted, [
      { name: '阿婆的身份', plant: 5, planned: [] },
      { name: '影子', plant: 12, planned: [12] },
    ]);
    // 寫第 6 章時名冊還沒埋（第 6 章那一次不算之前）。
    assert.deepEqual(t.threadWatch(b, 6).unplanted.map((f) => f.name), ['阿婆的身份', '名冊', '影子']);
  });

  test('按寫到第 N 章時算：之後的實際事件不算，計劃照原樣', () => {
    assert.deepEqual(t.threadWatch(book, 5).lines, [{ name: '青崖舊案', kind: '主线', lastActive: 1, stall: 5, planned: [8, 9] }]);
    // 寫第 2 章時「收了」那條線還沒收束，可它只有收束那一個事件（第 2 章）——那時還是計劃中，不算進行中。
    assert.deepEqual(t.threadWatch(book, 2).lines.map((l) => l.name), ['青崖舊案']);
  });
});

// 四期：敘事線判到哪（project.json 的水位 threadsThrough 與水位之後另外判過的 threadsJudged）。
describe('水位：敘事線判到第幾章（四期）', () => {
  test('認 project.json 的兩項：手改壞了的不認、不崩；水位 + 1 也在 judged 裡就順著推上去', () => {
    assert.deepEqual(t.threadsMarkOf({}), { through: 0, judged: [] });
    assert.deepEqual(t.threadsMarkOf({ threadsThrough: 5, threadsJudged: [9, 7, 7] }), { through: 5, judged: [7, 9] });
    assert.deepEqual(t.threadsMarkOf({ threadsThrough: '5', threadsJudged: 'x' }), { through: 0, judged: [] });
    assert.deepEqual(t.threadsMarkOf({ threadsThrough: -3, threadsJudged: [0, 1.5, 2, 3, 8] }), { through: 0, judged: [2, 3, 8] });
    assert.deepEqual(t.threadsMarkOf({ threadsThrough: 4, threadsJudged: [2, 5, 6, 9] }), { through: 6, judged: [9] });
  });

  test('判過一章：正好是水位 + 1 就推，並順著後面已經判過的接著推；更靠後的記下；水位以內的不變（同一個物件）', () => {
    let m = { through: 0, judged: [] };
    m = t.advanceThreadsMark(m, 1);
    assert.deepEqual(m, { through: 1, judged: [] });
    m = t.advanceThreadsMark(m, 4);
    m = t.advanceThreadsMark(m, 3);
    assert.deepEqual(m, { through: 1, judged: [3, 4] });
    assert.equal(t.advanceThreadsMark(m, 4), m, '已經記下的不重記');
    assert.equal(t.advanceThreadsMark(m, 1), m, '重新定稿水位以內的章不動');
    m = t.advanceThreadsMark(m, 2);
    assert.deepEqual(m, { through: 4, judged: [] });
    assert.equal(t.advanceThreadsMark(m, 2.5), m);
  });

  test('判過沒有、定稿了還沒判的章；章號連成段', () => {
    const m = { through: 3, judged: [6] };
    assert.deepEqual([1, 3, 4, 6, 7].map((no) => t.isThreadsJudged(m, no)), [true, true, false, true, false]);
    assert.deepEqual(t.unjudgedChapters(m, [7, 1, 2, 4, 5, 6, 4]), [4, 5, 7]);
    assert.equal(t.describeChapterRuns([4, 5, 7]), '第 4–5、7 章');
    assert.equal(t.describeChapterRuns([31, 32, 33, 3]), '第 3、31–33 章');
    assert.equal(t.describeChapterRuns([1, 3, 5, 7, 8]), '第 1、3、5 章等 5 章');
    assert.equal(t.describeChapterRuns([]), '');
  });
});
