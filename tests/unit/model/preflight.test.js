/**
 * 一致性預檢（五期）：細綱把角色卡上已經死了的人排進本章，寫之前先說一聲。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 句首是終態說法才算 | 「險些喪命」「為已死的師父報仇」不是這個人死了 |
 * | 帶主語、「已 / 於第 k 章 / 被……」字首的照認 | 卡上的狀態是各種寫法 |
 * | 按名字與別名認卡 | 細綱裡寫的可能是別名 |
 * | 狀態寫到本章或更晚的不判 | 重寫早前的章時，那個「已死亡」說的可能正是本章以後的事 |
 * | 沒記過寫到第幾章的手寫卡照判 | 寧可誤報一條讓作者點一下，也別漏報 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const p = loadModule('src/core/model/preflight.ts');

describe('preflight.ts · 終態判定', () => {
  const dead = [
    '已死亡',
    '已死亡（第 5 章被沈秋刺殺）',
    '身亡',
    '於第五章中身亡',
    '第3章末戰死',
    '被沈秋一劍刺死，屍體留在渡口',
    '已被處決',
    '早已死去多年',
    '他已經死了',
    '重傷不治，已於第 4 章去世',
    '死於青崖鎮的大火',
    '確認死亡',
    '屍骨無存',
    '已隕落',
    '魂飛魄散，再無轉世可能',
    '再無半點生息',
    '被大陣吞噬，化作飛灰',
  ];
  for (const s of dead) {
    test(`算：${s}`, () => assert.ok(p.terminalClause(s)));
  }

  const alive = [
    '左臂重傷，被關押在地牢',
    '險些喪命，被沈氏救下',
    '假死脫身，藏在城西',
    '為已死的師父報仇，一路北上',
    '生死未卜',
    '疑似身亡，下落不明',
    '死守城門三日',
    '傳言已死，其實在京城',
    '瀕臨死亡，昏迷不醒',
    '隕落的宗門遺蹟裡藏身',
    '死亡的陰影一直跟著他',
  ];
  for (const s of alive) {
    test(`不算：${s}`, () => assert.equal(p.terminalClause(s), undefined));
  }

  test('以自己的名字開頭也認', () => {
    assert.equal(p.terminalClause('沈秋已於第五章身亡', ['沈秋']), '沈秋已於第五章身亡');
  });

  test('判出來的是那一句，不是整段', () => {
    assert.equal(p.terminalClause('左臂重傷；已死亡，屍體未尋回'), '已死亡');
  });
});

describe('preflight.ts · 找風險', () => {
  const cards = [
    { name: '沈秋', aliases: ['阿秋'], state: '已死亡（第 2 章被刺殺）', stateThrough: 2, relPath: 'c/沈秋.md' },
    { name: '林昭', aliases: [], state: '左臂受傷，往北去了', stateThrough: 2 },
    { name: '老周', aliases: [], state: '病逝' },
  ];

  test('細綱裡排著的死人：一條', () => {
    const risks = p.findPreflightRisks({ no: 3, planned: ['林昭', '阿秋'], cards });
    assert.equal(risks.length, 1);
    assert.equal(risks[0].name, '沈秋');
    assert.equal(risks[0].through, 2);
    assert.equal(risks[0].relPath, 'c/沈秋.md');
    assert.equal(p.describeRisk(risks[0]), '沈秋的當前狀態（截至第 2 章）寫著「已死亡」，本章細綱仍安排這個人出場');
  });

  test('狀態已經寫到本章或更晚：不判', () => {
    assert.deepEqual(p.findPreflightRisks({ no: 2, planned: ['沈秋'], cards }), []);
    assert.deepEqual(p.findPreflightRisks({ no: 1, planned: ['沈秋'], cards }), []);
  });

  test('沒記過寫到第幾章的手寫卡照判', () => {
    const risks = p.findPreflightRisks({ no: 1, planned: ['老周'], cards });
    assert.equal(risks.length, 1);
    assert.match(p.describeRisk(risks[0]), /^老周的當前狀態寫著「病逝」/);
  });

  test('沒有卡的人不查；同一個人名字與別名都排了只報一次', () => {
    assert.deepEqual(p.findPreflightRisks({ no: 5, planned: ['路人甲'], cards }), []);
    assert.equal(p.findPreflightRisks({ no: 5, planned: ['沈秋', '阿秋'], cards }).length, 1);
  });

  test('開篇狀態的說法', () => {
    const risks = p.findPreflightRisks({ no: 1, planned: ['甲'], cards: [{ name: '甲', aliases: [], state: '身亡', stateThrough: 0 }] });
    assert.match(p.describeRisk(risks[0]), /（開篇狀態）/);
  });
});

// 百章實驗：錢執事第 10 章「屍骨無存」，第 26 章細綱照排——他沒有卡。
describe('preflight.ts · 定稿事實', () => {
  const facts = [
    { no: 10, relPath: 's/010.md', statements: ['陸沉奪得了錢執事的聚靈囊', '錢執事已被禁區大陣的魔氣徹底吞噬，屍骨無存'] },
    { no: 12, statements: ['錢執事的魂燈碎了，執法堂開始追查'] },
  ];

  test('沒有卡的人：以他做主語的事實判出終態，一條，說清是第幾章', () => {
    const risks = p.findPreflightRisks({ no: 26, planned: ['陸沉', '錢執事'], cards: [], facts });
    assert.equal(risks.length, 1);
    assert.equal(risks[0].source, 'fact');
    assert.equal(risks[0].chapter, 10);
    assert.equal(risks[0].relPath, 's/010.md');
    assert.equal(p.describeRisk(risks[0]), '錢執事在第 10 章同步下來的事實裡寫著「屍骨無存」，本章細綱仍安排這個人出場');
  });

  test('「錢執事的……」不算以他做主語', () => {
    assert.equal(p.factTerminal(['錢執事'], [{ no: 3, statements: ['錢執事的儲物袋被陸沉奪走'] }], 5), undefined);
  });

  test('只看本章之前的章', () => {
    assert.deepEqual(p.findPreflightRisks({ no: 10, planned: ['錢執事'], cards: [], facts }), []);
  });

  test('以他做主語的最近一條說了算：後來又寫他在活動，就不算', () => {
    const later = [...facts, { no: 20, statements: ['錢執事假死脫身，藏身外門'] }];
    assert.deepEqual(p.findPreflightRisks({ no: 26, planned: ['錢執事'], cards: [], facts: later }), []);
  });

  test('卡上狀態沒跟上（還寫著活著）：事實照判；卡上判出來了就只報卡上那一條', () => {
    const alive = [{ name: '錢執事', aliases: ['錢老鬼'], state: '在藥園剋扣靈草', stateThrough: 9 }];
    const byFact = p.findPreflightRisks({ no: 26, planned: ['錢老鬼'], cards: alive, facts });
    assert.equal(byFact.length, 1);
    assert.equal(byFact[0].name, '錢執事');
    assert.equal(byFact[0].source, 'fact');
    const dead = [{ name: '錢執事', aliases: [], state: '已死亡', stateThrough: 10 }];
    const byCard = p.findPreflightRisks({ no: 26, planned: ['錢執事'], cards: dead, facts });
    assert.equal(byCard.length, 1);
    assert.equal(byCard[0].source, 'card');
  });
});

// 五期補遺 §2：永久放行記在細綱 frontmatter 的 `preflightOk` 裡，一行「名字：理由」。
describe('preflight.ts · 永久放行', () => {
  const plotFile = loadModule('src/core/model/plotFile.ts');
  const risks = p.findPreflightRisks({
    no: 8,
    planned: ['沈秋', '李叔'],
    cards: [
      { name: '沈秋', aliases: [], state: '已死亡', stateThrough: 5 },
      { name: '李叔', aliases: [], state: '已於第 6 章病逝', stateThrough: 6 },
    ],
  });

  test('記過的人分出去，帶著理由；沒記過的照舊是風險', () => {
    const r = p.splitExempt(risks, [{ name: '沈秋', reason: '回憶裡的一場' }]);
    assert.deepEqual(r.risks.map((x) => x.name), ['李叔']);
    assert.equal(r.exempted.length, 1);
    assert.equal(r.exempted[0].risk.name, '沈秋');
    assert.match(p.describeExempted(r.exempted[0]), /沈秋按你記下的安排放行（回憶裡的一場）。要撤銷，刪掉這一章細綱 preflightOk 裡那一行/);
  });

  test('沒寫理由也算放行', () => {
    const r = p.splitExempt(risks, [{ name: '李叔', reason: '' }]);
    assert.deepEqual(r.risks.map((x) => x.name), ['沈秋']);
    assert.match(p.describeExempted(r.exempted[0]), /（沒寫理由）/);
  });

  test('「名字：理由」解析：全形半形冒號都認，沒冒號整行是名字，同名只留第一條', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(plotFile.parsePreflightOk(['沈秋：回憶', '李叔:託夢', '王五', '沈秋：又一條', '  ']))), [
      { name: '沈秋', reason: '回憶' },
      { name: '李叔', reason: '託夢' },
      { name: '王五', reason: '' },
    ]);
    assert.deepEqual(plotFile.renderPreflightOk([{ name: '沈秋', reason: '回憶' }, { name: '王五', reason: '' }]), ['沈秋：回憶', '王五']);
  });

  test('細綱讀回來帶著它；渲染時給了才寫', () => {
    const empty = plotFile.emptyPlotSections();
    const base = { no: 8, title: '渡口', upstreamHash: '', done: false, sections: { ...empty, 出场人物: '沈秋', 关键事件: '事' } };
    const withOk = plotFile.renderPlotFile({ ...base, preflightOk: [{ name: '沈秋', reason: '回憶' }] });
    assert.match(withOk, /preflightOk: \[沈秋：回憶\]/);
    assert.deepEqual(JSON.parse(JSON.stringify(plotFile.parsePlotFile(withOk, '.novelwarden/summaries/008-渡口.md').preflightOk)), [{ name: '沈秋', reason: '回憶' }]);
    assert.doesNotMatch(plotFile.renderPlotFile(base), /preflightOk/);
  });
});
