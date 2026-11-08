/**
 * 審稿報告（五期）：引文要找得到、目標逐項核對、只把勾選的交給修稿。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 改了標點、並了空格的引文照樣認 | 模型抄原文時改標點是常態（⚑ 上游只容忍多一對引號） |
 * | 太短的引文不認 | 兩三個字到處都能命中，證明不了什麼 |
 * | 定位對映回原文的位置 | 點引文要在編輯器裡選中那一句 |
 * | 普通問題的引文找不到就丟 | 沒有原文撐著的問題多半是編的（⚑ 上游不校驗） |
 * | 目標任何一句引文找不到 → 整項待核實 | 上游同一口徑 |
 * | 「未完成」沒有證據 → 待核實 | 「沒寫到」只能是待核實（總計劃 §5） |
 * | 漏項、重複、認不出的 id → 覆蓋不完整 | 完整不等於全部完成，但不完整要說出來 |
 * | 只凍結關鍵事件 | 章末鉤子並進了「看點」，看點不是一件件到期的動作 |
 * | 清單隻有勾選項；勾了待核實要帶邊界 | 作者沒勾的不該出現在模型眼前 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const r = loadModule('src/core/model/review.ts');

const TEXT = [
  '雨下了一整夜。林昭推開客棧的門，簷下的燈籠被風吹得直晃。',
  '沈氏在櫃檯後看著他，沒說話。她把那塊殘令收進了袖中。',
  '“你明天就走？”她問。林昭點了點頭，說：“天一亮就走。”',
].join('\n\n');

const CTX = { text: TEXT, chapterNo: 2, chapterTitle: '客棧', chapterRelPath: 'chapters/002-客棧.md', chapterHash: 'h' };

describe('review.ts · 目標凍結', () => {
  test('按換行與分號切，去掉列表記號', () => {
    const goals = r.freezeGoals('- 林昭回到客棧；沈氏收下殘令\n2. 林昭決定北上');
    assert.deepEqual(
      goals.map((g) => [g.id, g.text]),
      [
        ['g1', '林昭回到客棧'],
        ['g2', '沈氏收下殘令'],
        ['g3', '林昭決定北上'],
      ]
    );
  });

  test('一整段寫成的關鍵事件就是一項，不按句號切', () => {
    const goals = r.freezeGoals('林昭回到客棧。沈氏收下殘令。');
    assert.equal(goals.length, 1);
    assert.equal(goals[0].text, '林昭回到客棧。沈氏收下殘令。');
  });

  // 計劃與定稿的關鍵事件都是一條一行的列表（⚑B）：一條一項，順序不變。
  test('細綱落盤的樣子（一條一行）一條凍結成一項', () => {
    const goals = r.freezeGoals('- 林昭隨年輕守衛趕到鎮西舊宅，木匣空著。\n- 兩人回鎮口當面問李叔。\n- 李叔說出持牌的人七年前都在那場火裡。');
    assert.deepEqual(
      goals.map((g) => g.text),
      ['林昭隨年輕守衛趕到鎮西舊宅，木匣空著。', '兩人回鎮口當面問李叔。', '李叔說出持牌的人七年前都在那場火裡。']
    );
  });

  test('佔位與空的不算', () => {
    assert.deepEqual(r.freezeGoals('（待補充）'), []);
    assert.deepEqual(r.freezeGoals(''), []);
  });

  // 2026-10-25 起審稿寫自然語言，清單也是一項一行。
  test('交給模型的清單隻有 id 與目標原文，一項一行', () => {
    assert.equal(r.frozenGoalsList(r.freezeGoals('甲；乙')), '- g1：甲\n- g2：乙');
  });
});

describe('review.ts · 引文', () => {
  const index = r.indexText(TEXT);

  test('逐字的引文找得到', () => {
    assert.equal(r.quoteFound(index, '她把那塊殘令收進了袖中。'), true);
  });

  test('改了標點、並了空格、全形半形不同都照樣認', () => {
    assert.equal(r.quoteFound(index, '她把那塊殘令，收進了袖中'), true);
    assert.equal(r.quoteFound(index, '"你明天就走?"她問'), true);
    assert.equal(r.quoteFound(index, '林昭推開 客棧的門'), true);
  });

  test('改了字、拼接兩句都認不出', () => {
    assert.equal(r.quoteFound(index, '她把那枚殘令收進了袖中'), false);
    assert.equal(r.quoteFound(index, '雨下了一整夜。她把那塊殘令收進了袖中'), false);
  });

  test('歸一後不到 4 個字的不認', () => {
    assert.equal(r.quoteFound(index, '林昭，'), false);
    assert.equal(r.quoteFound(index, '沈氏在櫃'), true);
  });

  test('定位對映回原文：從引文第一個字到最後一個字', () => {
    const at = r.locateQuote(TEXT, '你明天就走?”她問');
    assert.ok(at);
    assert.equal(TEXT.slice(at.start, at.end), '你明天就走？”她問');
  });

  test('找不到時 undefined', () => {
    assert.equal(r.locateQuote(TEXT, '根本沒有這一句話'), undefined);
  });
});

describe('review.ts · 解析', () => {
  test('認程式碼圍欄與前後多餘的話', () => {
    const p = r.parseReviewJson('好的，審稿結果如下：\n```json\n{"summary":"還行","items":[{"category":"角色狀態","severity":"pass","description":"一致"}]}\n```');
    assert.equal(p.ok, true);
    assert.equal(p.value.summary, '還行');
    assert.equal(p.value.items[0].severity, 'pass');
  });

  test('嚴重度的近義寫法照收，認不出的那一條跳過並記一句', () => {
    const p = r.parseReviewJson(JSON.stringify({
      summary: '',
      items: [
        { category: 'a', severity: 'critical', quote: 'x', description: 'd1' },
        { category: 'b', severity: 'minor', quote: 'y', description: 'd2' },
        { category: 'c', severity: '??', quote: 'z', description: 'd3' },
      ],
    }));
    assert.deepEqual(p.value.items.map((i) => i.severity), ['error', 'warning']);
    assert.match(p.value.warnings.join(), /1 條認不出/);
  });

  test('超長的截斷並說明', () => {
    const p = r.parseReviewJson(JSON.stringify({ summary: '長'.repeat(200), items: [] }));
    assert.equal(Array.from(p.value.summary).length, r.REVIEW_SUMMARY_MAX);
    assert.match(p.value.warnings.join(), /截斷/);
  });

  test('不是 JSON、沒有 items 陣列都不合格', () => {
    assert.equal(r.parseReviewJson('這一章寫得很好。').ok, false);
    assert.equal(r.parseReviewJson('{"summary":"x"}').ok, false);
  });

  // 轉寫模型該把結論對到程式碼；漏對、照抄了中文詞的也認，不當成認不出的結論整項降級。
  test('目標核對的結論認中文詞；引文可以是字串或 { quote }', () => {
    const p = r.parseReviewJson(JSON.stringify({
      items: [],
      goalReviews: [
        { id: 'g1', status: '已完成', description: 'd', evidence: ['甲乙丙丁'] },
        { id: 'g2', status: 'UNMET', description: 'd', evidence: [{ quote: '戊己庚辛' }] },
        { id: 'g3', status: '待核實', description: 'd', evidence: [] },
      ],
    }));
    assert.deepEqual(p.value.goalReviews.map((g) => [g.status, g.quotes]), [['completed', ['甲乙丙丁']], ['unmet', ['戊己庚辛']], ['unknown', []]]);
  });

  test('goalReviews 缺席與空陣列不同', () => {
    assert.equal(r.parseReviewJson('{"items":[]}').value.goalReviews, undefined);
    assert.deepEqual(r.parseReviewJson('{"items":[],"goalReviews":[]}').value.goalReviews, []);
  });
});

function raw(items, goalReviews) {
  return { summary: '總評', items, ...(goalReviews ? { goalReviews } : {}), warnings: [] };
}

describe('review.ts · 校驗', () => {
  const goals = r.freezeGoals('沈氏收下殘令；林昭決定北上；門外有人敲門');

  test('引文找得到的問題留下，找不到的丟掉並說明', () => {
    const { report, notes } = r.verifyReview(
      raw([
        { category: '劇情合理性', severity: 'error', quote: '她把那塊殘令收進了袖中', description: '殘令前文已經交出去了' },
        { category: '角色狀態', severity: 'warning', quote: '林昭拔出長劍指著她', description: '編出來的一句' },
        { category: '劇情連貫性', severity: 'warning', quote: '', description: '沒給引文' },
        { category: '前後章節串聯', severity: 'pass', quote: '', description: '接得上' },
      ]),
      { ...CTX, goals: [] }
    );
    assert.deepEqual(report.issues.map((i) => [i.id, i.category]), [['i1', '劇情合理性']]);
    assert.deepEqual(report.passes.map((p) => p.category), ['前後章節串聯']);
    assert.deepEqual(report.dropped.map((d) => d.why), ['引文在正文裡找不到', '沒有給引文']);
    assert.match(notes.join('\n'), /丟掉 2 條/);
  });

  test('目標：完成且引文找得到的留下', () => {
    const { report } = r.verifyReview(
      raw([], [
        { id: 'g1', status: 'completed', description: '收下了', quotes: ['她把那塊殘令收進了袖中'] },
        { id: 'g2', status: 'completed', description: '天亮就走', quotes: ['天一亮就走'] },
        { id: 'g3', status: 'unknown', description: '沒寫到敲門', quotes: [] },
      ]),
      { ...CTX, goals }
    );
    assert.deepEqual(report.goals.map((g) => g.status), ['completed', 'completed', 'unknown']);
    assert.equal(report.goals[2].judgment, '沒寫到敲門');
    assert.equal(report.coverage, 'complete');
  });

  test('目標：任何一句引文找不到，整項降成待核實，其餘幾句也救不回', () => {
    const { report, notes } = r.verifyReview(
      raw([], [
        { id: 'g1', status: 'completed', description: '收下了', quotes: ['她把那塊殘令收進了袖中', '她當場燒了殘令'] },
        { id: 'g2', status: 'completed', description: 'x', quotes: ['天一亮就走'] },
        { id: 'g3', status: 'unknown', description: 'y', quotes: [] },
      ]),
      { ...CTX, goals }
    );
    assert.equal(report.goals[0].status, 'unknown');
    assert.deepEqual(report.goals[0].quotes, []);
    assert.equal(report.goals[0].judgment, r.GOAL_UNVERIFIED);
    assert.match(notes.join(), /1 專案標/);
  });

  test('目標：「未完成」沒有證據 → 待核實（沒寫到不等於沒發生）', () => {
    const { report } = r.verifyReview(
      raw([], [
        { id: 'g1', status: 'completed', description: 'x', quotes: ['她把那塊殘令收進了袖中'] },
        { id: 'g2', status: 'unmet', description: '正文裡沒寫他決定北上', quotes: [] },
        { id: 'g3', status: 'unknown', description: 'y', quotes: [] },
      ]),
      { ...CTX, goals }
    );
    assert.equal(report.goals[1].status, 'unknown');
  });

  test('目標：漏項、重複、認不出的 id → 那幾項待核實，覆蓋不完整', () => {
    const { report, notes } = r.verifyReview(
      raw([], [
        { id: 'g1', status: 'completed', description: 'x', quotes: ['她把那塊殘令收進了袖中'] },
        { id: 'g1', status: 'completed', description: 'x', quotes: ['她把那塊殘令收進了袖中'] },
        { id: 'g9', status: 'completed', description: 'x', quotes: ['天一亮就走'] },
      ]),
      { ...CTX, goals }
    );
    assert.deepEqual(report.goals.map((g) => g.status), ['unknown', 'unknown', 'unknown']);
    assert.equal(report.coverage, 'partial');
    assert.match(notes.join(), /目標核對不完整/);
  });

  test('模型根本沒交目標核對：整張清單待核實', () => {
    const { report } = r.verifyReview(raw([]), { ...CTX, goals });
    assert.equal(report.coverage, 'partial');
    assert.ok(report.goals.every((g) => g.status === 'unknown'));
  });

  test('細綱沒有關鍵事件：覆蓋記 none', () => {
    const { report, notes } = r.verifyReview(raw([]), { ...CTX, goals: [] });
    assert.equal(report.coverage, 'none');
    assert.match(notes.join(), /沒有可核對的關鍵事件/);
  });

  test('超過 10 條的不收', () => {
    const items = Array.from({ length: 12 }, (_, k) => ({ category: `c${k}`, severity: 'pass', quote: '', description: 'ok' }));
    const { report, notes } = r.verifyReview(raw(items), { ...CTX, goals: [] });
    assert.equal(report.passes.length, 10);
    assert.match(notes.join(), /後面 2 條沒有收/);
  });
});

describe('review.ts · 勾選與清單', () => {
  const goals = r.freezeGoals('沈氏收下殘令；林昭決定北上；門外有人敲門');
  const { report } = r.verifyReview(
    raw(
      [
        { category: '劇情合理性', severity: 'error', quote: '她把那塊殘令收進了袖中', description: '殘令前文已交出' },
        { category: '角色狀態', severity: 'warning', quote: '林昭點了點頭', description: '他左臂有傷卻點頭如常' },
      ],
      [
        { id: 'g1', status: 'completed', description: 'x', quotes: ['她把那塊殘令收進了袖中'] },
        { id: 'g2', status: 'unmet', description: '他說的是明天走，細綱要他今晚就走', quotes: ['天一亮就走'] },
        { id: 'g3', status: 'unknown', description: '沒寫到敲門', quotes: [] },
      ]
    ),
    { ...CTX, goals }
  );

  test('預設勾：全部問題 + 未完成的目標；待核實不勾', () => {
    assert.deepEqual(r.defaultPicks(report), ['i1', 'i2', 'g2']);
    assert.deepEqual(r.pickableIds(report), ['i1', 'i2', 'g2', 'g3']);
  });

  test('清單隻有勾選項，帶原文', () => {
    const brief = r.renderRevisionBrief(report, ['i1', 'g2']);
    assert.match(brief, /【已確認納入本次修稿的審稿項】/);
    assert.match(brief, /1\. \[劇情合理性 \/ 嚴重\] 殘令前文已交出\n   相關原文：她把那塊殘令收進了袖中/);
    assert.match(brief, /2\. \[本章目標 \/ 未完成\] 關鍵事件：林昭決定北上/);
    assert.doesNotMatch(brief, /點頭如常/);
    assert.doesNotMatch(brief, /待核實項處理邊界/);
  });

  test('勾了待核實：前面帶邊界那一句', () => {
    const brief = r.renderRevisionBrief(report, ['g3']);
    assert.match(brief, /^【待核實項處理邊界】/);
    assert.match(brief, /關鍵事件：門外有人敲門/);
  });

  test('一條都沒勾：空串；已完成的目標勾了也不算', () => {
    assert.equal(r.renderRevisionBrief(report, []), '');
    assert.equal(r.renderRevisionBrief(report, ['g1']), '');
  });

  test('正文改過之後：引文不在了的那條作廢，目標不受影響', () => {
    const changed = TEXT.replace('她把那塊殘令收進了袖中。', '她把殘令推回給他。');
    const { kept, lost } = r.relocatePicks(report, ['i1', 'i2', 'g2', 'g1'], changed);
    assert.deepEqual(kept, ['i2', 'g2']);
    assert.deepEqual(lost.map((i) => i.id), ['i1']);
  });

  test('給人讀的一份與一句話概括', () => {
    const md = r.renderReport(report);
    assert.match(md, /^# 第 2 章《客棧》審稿/);
    assert.match(md, /## 嚴重（1）/);
    assert.match(md, /未完成｜關鍵事件：林昭決定北上/);
    assert.equal(r.describeReport(report), '1 嚴重 · 1 建議 · 目標 1/3 已完成（1 項待核實）');
  });

  test('使用者氣泡上的那幾行', () => {
    assert.deepEqual(r.describePicks(report, ['i2', 'g3']), ['[建議] 角色狀態：他左臂有傷卻點頭如常', '[待核實] 關鍵事件：門外有人敲門']);
  });
});

// 五期補遺 §3：報告卡的編輯模式。
describe('review.ts · 編輯報告', () => {
  const base = {
    chapterNo: 2,
    chapterTitle: '客棧',
    chapterRelPath: 'chapters/002-客棧.md',
    chapterHash: 'h',
    summary: '',
    issues: [
      { id: 'i1', category: '劇情合理性', severity: 'error', quote: '她把那塊殘令收進了袖中', description: '殘令早交出去了' },
      { id: 'i2', category: '角色狀態', severity: 'warning', quote: '林昭點了點頭', description: '左臂有傷' },
    ],
    passes: [],
    goals: [{ id: 'g1', text: '林昭回到客棧', status: 'unmet', judgment: '判斷', quotes: ['林昭推開客棧的門'] }],
    coverage: 'complete',
    dropped: [],
  };
  const plain = (x) => JSON.parse(JSON.stringify(x));

  test('模型給的：漏了就原樣留著；改過的標 edited；新加的接著編號 a1、a2，分類預設「作者補充」', () => {
    const { report, notes } = r.applyReviewEdits(
      base,
      [
        { id: 'i2', category: '角色狀態', severity: 'error', description: '左臂有傷，不該點頭如常', quote: '林昭點了點頭' },
        { category: '', severity: 'warning', description: '雨寫得太長', quote: '雨下了一整夜' },
        { severity: 'error', category: '節奏', description: '結尾太急' },
      ],
      TEXT
    );
    assert.deepEqual(notes, []);
    assert.deepEqual(
      plain(report.issues).map((i) => [i.id, i.category, i.severity, i.origin ?? '', !!i.edited]),
      [
        ['i1', '劇情合理性', 'error', '', false],
        ['i2', '角色狀態', 'error', '', true],
        ['a1', '作者補充', 'warning', 'author', false],
        ['a2', '節奏', 'error', 'author', false],
      ]
    );
    assert.equal(report.issues[3].quote, '');
    assert.deepEqual(report.goals.map((g) => g.id), ['g1']);
  });

  test('引文：作者加的找不到就清空，模型條目改出來的找不到就保留原句；都說明', () => {
    const { report, notes } = r.applyReviewEdits(
      base,
      [
        { id: 'i1', category: '劇情合理性', severity: 'error', description: '殘令早交出去了', quote: '正文裡沒有這一句話' },
        { category: '', severity: 'warning', description: '一條新的', quote: '也沒有這一句' },
      ],
      TEXT
    );
    assert.equal(report.issues[0].quote, '她把那塊殘令收進了袖中');
    assert.equal(report.issues[0].edited, undefined);
    assert.equal(report.issues[2].quote, '');
    assert.equal(notes.length, 2);
    assert.match(notes[0], /改過的引文在正文裡找不到，保留原來那一句/);
    assert.match(notes[1], /引文在正文裡找不到，按沒有引文處理/);
  });

  test('說明空的：模型條目保留原句，新加的整條不收；作者加的漏了就是刪掉', () => {
    const once = r.applyReviewEdits(base, [{ category: '', severity: 'warning', description: '先加一條' }], TEXT).report;
    const { report, notes } = r.applyReviewEdits(
      once,
      [
        { id: 'i1', category: '劇情合理性', severity: 'error', description: '  ', quote: '她把那塊殘令收進了袖中' },
        { category: '', severity: 'warning', description: '' },
      ],
      TEXT
    );
    assert.equal(report.issues[0].description, '殘令早交出去了');
    assert.deepEqual(report.issues.map((i) => i.id), ['i1', 'i2']);
    assert.ok(notes.some((n) => /說明不能是空的/.test(n)));
    assert.ok(notes.some((n) => /1 條新加的問題沒寫說明/.test(n)));
    assert.ok(notes.some((n) => /刪掉了 1 條作者加的問題/.test(n)));
  });

  test('作者加的：預設勾上；修稿清單裡沒有引文就不寫「相關原文」，分類不是預設的標「作者補充」', () => {
    const { report } = r.applyReviewEdits(
      base,
      [
        { category: '', severity: 'warning', description: '雨寫得太長' },
        { category: '節奏', severity: 'error', description: '結尾太急' },
      ],
      TEXT
    );
    assert.deepEqual(r.defaultPicks(report), ['i1', 'i2', 'a1', 'a2', 'g1']);
    const brief = r.renderRevisionBrief(report, ['a1', 'a2']);
    assert.match(brief, /1\. \[作者補充 \/ 建議\] 雨寫得太長\n2\. \[節奏 \/ 嚴重 · 作者補充\] 結尾太急/);
    assert.doesNotMatch(brief, /相關原文/);
    assert.match(r.renderReport(report), /- \[作者補充\] 雨寫得太長（作者補充）/);
  });

  test('會話檔案讀回來：作者加的沒有引文也認；模型條目沒有引文就不認', () => {
    const { report } = r.applyReviewEdits(base, [{ category: '', severity: 'warning', description: '雨寫得太長' }], TEXT);
    const back = r.normalizeReport(plain({ ...report, issues: [...report.issues, { id: 'i9', category: 'x', severity: 'error', quote: '', description: '壞的' }] }));
    assert.deepEqual(back.issues.map((i) => i.id), ['i1', 'i2', 'a1']);
    assert.equal(back.issues[2].origin, 'author');
  });

  test('正文改過之後重新定位：沒有引文的照舊交給模型', () => {
    const { report } = r.applyReviewEdits(base, [{ category: '', severity: 'warning', description: '雨寫得太長' }], TEXT);
    assert.deepEqual(r.relocatePicks(report, ['a1'], '完全換了一版正文。').kept, ['a1']);
  });
});
