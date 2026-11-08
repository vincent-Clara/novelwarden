/**
 * 刪修飾的純函式（model/trimProse.ts）：編號、讀回、只許刪的驗收、八成保底。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 編號讀回：越界、重複的丟，缺的就是沒交回來 | 模型會漏段、多段、重複編號 |
 * | 新增的字按 LCS 算 | 只刪不加是這一輪唯一的合同 |
 * | 加字、動對白、刪太狠、改段尾都退回 | 一段改壞不連累整章，退回原文 |
 * | 刪到八成以下從刪得最多的段退回 | 不然主按鈕轉去推「接著寫」，等於白刪 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const tp = loadModule('src/core/model/trimProse.ts');
const han = (s) => (s.match(/[一-鿿]/g) ?? []).length;

describe('trimProse.ts · 編號與讀回', () => {
  test('按空行切段、編號', () => {
    const paras = tp.trimParagraphs('甲。\n\n  乙。\r\n\r\n\n丙。');
    assert.deepEqual(paras, ['甲。', '乙。', '丙。']);
    assert.equal(tp.numberParagraphs(paras), '[1] 甲。\n\n[2] 乙。\n\n[3] 丙。');
  });

  test('讀回：越界與重複的丟掉（取第一個），缺的不在表裡', () => {
    const m = tp.parseNumbered('[1] 甲\n[3] 丙\n[3] 丙二\n[9] 越界\n說明文字', 3);
    assert.deepEqual([...m], [[1, '甲'], [3, '丙']]);
  });
});

describe('trimProse.ts · 只許刪', () => {
  const before = '錢執事那肥碩的身軀帶著一股濃重的靈草香氣壓了過來。';

  test('新增的字按最長公共子序列算', () => {
    assert.equal(tp.addedChars(before, '錢執事帶著靈草香氣壓了過來。'), '');
    assert.equal(tp.addedChars('他走了。', '他慢慢走了。'), '慢慢');
  });

  test('只刪：合格', () => {
    assert.equal(tp.trimProblem(before, '錢執事帶著靈草香氣壓了過來。'), undefined);
  });

  test('補一兩個字算合格，多了退回', () => {
    assert.equal(tp.trimProblem('他狠狠碾壓下去。', '他碾了下去。'), undefined);
    assert.equal(tp.trimProblem(before, '錢執事走過來，一身藥味。'), '加了原文沒有的字');
  });

  test('對白一字不許動', () => {
    assert.equal(tp.trimProblem('他冷冷地說：“你這廢物，磨蹭什麼。”', '他說：“廢物，磨蹭什麼。”'), '動了對白');
    assert.equal(tp.trimProblem('他冷冷地說：“你這廢物。”', '他說：“你這廢物。”'), undefined);
  });

  test('刪得太狠、刪光、改了段尾都退回', () => {
    assert.equal(tp.trimProblem(before, '錢執事。'), '刪得太多');
    assert.equal(tp.trimProblem(before, ''), '整段刪光了');
    assert.equal(tp.trimProblem(before, '錢執事帶著靈草香氣壓了過來'), '改了段尾');
  });
});

describe('trimProse.ts · 寫正文的篇幅', () => {
  test('開著刪修飾放大兩成、取整到百字；關著或沒有目標原樣', () => {
    assert.equal(tp.writingAim(3000, true), 3600);
    assert.equal(tp.writingAim(1250, true), 1500);
    assert.equal(tp.writingAim(3000, false), 3000);
    assert.equal(tp.writingAim(undefined, true), undefined);
  });
});

describe('trimProse.ts · 拼回正文', () => {
  const paras = ['甲乙丙丁戊己庚辛壬癸。', '子醜寅卯辰巳午未申酉。', '“這句對白不動。”'];

  test('逐段驗收，不合格的退回原文，原因計數', () => {
    const edits = new Map([
      [1, '甲乙丙丁戊己。'],
      [2, '子醜寅卯辰巳午未申酉外加許多字。'],
    ]);
    const out = tp.applyTrim(paras, edits);
    assert.equal(out.text, ['甲乙丙丁戊己。', paras[1], paras[2]].join('\n\n'));
    assert.equal(out.changed, 1);
    assert.deepEqual([...out.rejected], [['加了原文沒有的字', 1], ['沒交回來', 1]]);
    assert.equal(out.restored, 0);
  });

  test('刪到保底以下：從刪得最多的段開始退回，夠數就停', () => {
    const edits = new Map([
      [1, '甲乙丙丁戊。'],
      [2, '子醜寅卯辰巳午未。'],
      [3, paras[2]],
    ]);
    const full = han(paras.join(''));
    // 第 1 段刪了 5 字，第 2 段刪了 2 字：差 3 字夠數，退回第 1 段就夠。
    const out = tp.applyTrim(paras, edits, { floor: full - 3, countWords: han });
    assert.equal(out.restored, 1);
    assert.equal(out.text, [paras[0], '子醜寅卯辰巳午未。', paras[2]].join('\n\n'));
    assert.equal(out.changed, 1);
  });
});
