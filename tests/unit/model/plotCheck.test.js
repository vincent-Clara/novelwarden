/**
 * 寫前衝突檢查（model/plotCheck.ts）：選哪些事實、校驗模型交回來的衝突。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 提到計劃出場的人的事實不論多早都帶；其餘只帶近 12 章 | 錢執事第 10 章死、第 26 章又被排出場 |
 * | 兩句原文都對得上才算 | 這一步會讓批次停下：拿編出來的矛盾攔作者比漏掉一條更糟 |
 * | 章號以對上的那一條為準 | 模型常寫錯章號 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const m = loadModule('src/core/model/plotCheck.ts');

describe('plotCheck · 選事實', () => {
  const chapters = Array.from({ length: 30 }, (_, i) => ({
    no: i + 1,
    statements: i + 1 === 10 ? ['錢執事已被大陣吞噬，屍骨無存', '陸沉奪得聚靈囊'] : [`第${i + 1}章的事`],
  }));

  test('提到本章計劃出場的人的事實不論多早都帶；其餘只帶最近 12 章；按章號升序', () => {
    const picked = m.selectCheckFacts(chapters, ['錢執事', '陸沉']);
    const nos = picked.map((c) => c.no);
    assert.equal(nos[0], 10);
    assert.deepEqual(nos.slice(1), Array.from({ length: 12 }, (_, i) => 19 + i));
    assert.deepEqual(picked[0].statements, ['錢執事已被大陣吞噬，屍骨無存', '陸沉奪得聚靈囊']);
  });

  test('早於近 12 章、又沒提到這幾個人的，不帶', () => {
    const picked = m.selectCheckFacts(chapters, ['沈秋']);
    assert.ok(!picked.some((c) => c.no === 10));
  });

  test('近幾章、一共幾字按傳進來的上限（上下文詳細度）', () => {
    const nos = m.selectCheckFacts(chapters, ['沈秋'], { recent: 6 }).map((c) => c.no);
    assert.deepEqual(nos, Array.from({ length: 6 }, (_, i) => 25 + i));
    const long = Array.from({ length: 12 }, (_, i) => ({ no: i + 1, statements: ['字'.repeat(400)] }));
    const total = m.selectCheckFacts(long, [], { chars: 1500 }).reduce((n, c) => n + c.statements.join('').length, 0);
    assert.ok(total <= 1500 && total > 0, String(total));
  });

  test('一共不超過預算', () => {
    const long = Array.from({ length: 12 }, (_, i) => ({ no: i + 1, statements: ['字'.repeat(400)] }));
    const total = m.selectCheckFacts(long, []).reduce((n, c) => n + c.statements.join('').length, 0);
    assert.ok(total <= m.PLOT_CHECK_BUDGET_CHARS, String(total));
  });
});

describe('plotCheck · 校驗衝突', () => {
  const facts = [{ no: 10, statements: ['錢執事已被大陣吞噬，屍骨無存'] }];
  const plot = '陸沉潛入錢執事居所，以劇毒靈液偷襲，錢執事在驚恐中斃命。';

  test('兩句都對得上：收下，章號以對上的那一條為準', () => {
    const r = m.verifyConflicts([{ plot: '錢執事在驚恐中斃命', fact: '錢執事已被大陣吞噬', chapter: 3, why: '他第 10 章已經死了' }], plot, facts);
    assert.equal(r.dropped, 0);
    assert.deepEqual(r.conflicts, [{ plot: '錢執事在驚恐中斃命', fact: '錢執事已被大陣吞噬，屍骨無存', chapter: 10, why: '他第 10 章已經死了' }]);
    assert.equal(m.describeConflict(r.conflicts[0]), '細綱「錢執事在驚恐中斃命」與第 10 章同步下來的事實「錢執事已被大陣吞噬，屍骨無存」矛盾：他第 10 章已經死了');
  });

  test('標點、空白不同照樣認', () => {
    const r = m.verifyConflicts([{ plot: '錢執事 在驚恐中斃命！', fact: '錢執事已被大陣吞噬,屍骨無存', chapter: 10, why: '' }], plot, facts);
    assert.equal(r.conflicts.length, 1);
  });

  test('細綱裡找不到、事實對不上、引文太短、欄位缺了：一律丟掉', () => {
    const r = m.verifyConflicts(
      [
        { plot: '細綱裡沒有這句話', fact: '錢執事已被大陣吞噬', chapter: 10, why: '' },
        { plot: '錢執事在驚恐中斃命', fact: '錢執事還活著', chapter: 10, why: '' },
        { plot: '斃命', fact: '錢執事已被大陣吞噬', chapter: 10, why: '' },
        { why: '只有理由' },
        '一句话',
      ],
      plot,
      facts
    );
    assert.deepEqual(r.conflicts, []);
    assert.equal(r.dropped, 5);
  });

  test('提示詞與使用者訊息', () => {
    assert.match(m.PLOT_CHECK_SYSTEM, /硬矛盾/);
    const user = m.plotCheckUser({ no: 26, title: '執事之死', text: plot }, facts);
    assert.match(user, /【第10章】\n- 錢執事已被大陣吞噬，屍骨無存/);
    assert.match(user, /# 本章細綱（第26章 執事之死）/);
  });

  // 2026-10-25 起改成轉寫：比對的模型按格式寫，JSON 由轉寫模型照抄（合同在 PLOT_CHECK_JSON_CONTRACT）。
  test('寫的那一次不要 JSON：按格式寫，兩句原句用「」括起來，最多 5 處', () => {
    assert.doesNotMatch(m.PLOT_CHECK_SYSTEM, /\{"conflicts"|只輸出 JSON/);
    assert.match(m.PLOT_CHECK_SYSTEM, /不寫 JSON/);
    assert.match(m.PLOT_CHECK_SYSTEM, /沒有矛盾就只寫「無矛盾」/);
    assert.match(m.PLOT_CHECK_SYSTEM, /兩句原句都用「」括起來，必須逐字摘自下面給的原文/);
    assert.match(m.PLOT_CHECK_SYSTEM, new RegExp(`最多 ${m.PLOT_CHECK_MAX} 處`));
    assert.doesNotMatch(m.plotCheckUser({ no: 26, title: '', text: plot }, facts), /JSON/);
    assert.match(m.PLOT_CHECK_JSON_CONTRACT, /\{"conflicts":\[/);
  });

  test('只寫了「無矛盾」不必轉寫；連矛盾、細綱、事實都不提的不像比對結果', () => {
    for (const s of ['無矛盾', '無矛盾。', '**無矛盾**', '沒有硬矛盾', '無']) {
      assert.equal(m.saysNoConflict(s), true, s);
    }
    assert.equal(m.saysNoConflict('### 矛盾 1\n細綱：「錢執事在驚恐中斃命」'), false);
    assert.equal(m.saysNoConflict('無矛盾，但細綱裡「錢執事在驚恐中斃命」要留意'), false);
    assert.equal(m.looksLikePlotCheck('### 矛盾 1\n細綱：「錢執事在驚恐中斃命」'), true);
    assert.equal(m.looksLikePlotCheck('我不太確定。'), false);
  });
});
