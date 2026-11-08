/**
 * 續寫的純函式（generation/continuation.ts）：該不該續、續出來的那段怎麼接。
 *
 * 判據移植自 AI-Novel-Writer 的 `shouldAutoContinue`；拼接移植自
 * `appendVisibleTextContinuation`。這裡釘的是邊界：
 *
 * - 被截斷就續（哪怕字數夠了）、不到八成就續、別的原因停了不續、沒有目標不續、7 輪封頂；
 * - 續寫把已寫的最後幾句複述一遍時，那一截要去掉（≥ 48 個非空白字元才算）；
 * - 整段一字不差地重複一遍的，去掉；介面話術（「未完待續」）去掉；正文一個字不碰。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const c = loadModule('src/core/generation/continuation.ts');

describe('continuation · 該不該續', () => {
  const at = (over) => c.shouldContinue({ words: 1000, target: 3000, stop: 'end', rounds: 0, ...over });

  test('不到八成 → 續', () => {
    assert.equal(at({ words: 2399 }), true);
    assert.equal(c.lowerBound(3000), 2400);
  });

  test('到了八成、正常收尾 → 不續', () => {
    assert.equal(at({ words: 2400 }), false);
  });

  test('被截斷 → 續，哪怕字數夠了（結尾停在半句上）', () => {
    assert.equal(at({ words: 3500, stop: 'maxTokens' }), true);
  });

  test('別的原因停了（內容審查一類）→ 不續', () => {
    assert.equal(at({ words: 100, stop: 'other' }), false);
  });

  test('閘道器不報收尾原因 → 按字數判', () => {
    assert.equal(at({ words: 100, stop: undefined }), true);
    assert.equal(at({ words: 2800, stop: undefined }), false);
  });

  test('沒有目標字數 → 不續（有字就算寫夠）', () => {
    assert.equal(at({ target: undefined, words: 10, stop: 'maxTokens' }), false);
  });

  test('7 輪封頂', () => {
    assert.equal(at({ rounds: 6 }), true);
    assert.equal(at({ rounds: 7 }), false);
  });
});

describe('continuation · 拼接', () => {
  const EXISTING = [
    '雪下到半夜才停。',
    '林昭把殘令揣進懷裡，沿著河堤往回走，腳下的冰殼一踩就碎。客棧的燈還亮著，沈氏坐在櫃檯後面撥算盤，看見他進門，手指停在半空。',
  ].join('\n\n');

  test('開頭複述了已寫末尾（≥48 字）→ 那一截去掉', () => {
    const addition =
      '沿著河堤往回走，腳下的冰殼一踩就碎。客棧的燈還亮著，沈氏坐在櫃檯後面撥算盤，看見他進門，手指停在半空。\n\n“李叔來過。”她說。';
    const { text, added } = c.joinContinuation(EXISTING, addition);
    assert.equal(added, '“李叔來過。”她說。');
    assert.equal(text, `${EXISTING}\n\n“李叔來過。”她說。`);
  });

  test('只重合了一小截（<48 字）→ 不動', () => {
    const addition = '手指停在半空。她把算盤推到一邊。';
    assert.equal(c.stripOverlap(EXISTING, addition), addition);
  });

  test('整段一字不差地重複（≥40 字）→ 去掉；短段（如一句對白）重複不算', () => {
    const para = '林昭把殘令揣進懷裡，沿著河堤往回走，腳下的冰殼一踩就碎。客棧的燈還亮著，沈氏坐在櫃檯後面撥算盤，看見他進門，手指停在半空。';
    const addition = `“嗯。”\n\n${para}\n\n“嗯。”\n\n他坐下了。`;
    const { added } = c.joinContinuation('雪下到半夜才停。', `前言。\n\n${para}`);
    assert.ok(added.includes(para));
    const again = c.joinContinuation(EXISTING, addition);
    assert.equal(again.added, '“嗯。”\n\n“嗯。”\n\n他坐下了。');
  });

  test('介面話術去掉，正文不碰', () => {
    const { added } = c.joinContinuation('', '他走了。\n\n未完待續……\n\n\n\n點我繼續生成後續內容\n她留下了。');
    assert.equal(added, '他走了。\n\n她留下了。');
  });

  test('已寫為空 → 就是這一段', () => {
    assert.deepEqual(c.joinContinuation('', '第一句。'), { text: '第一句。', added: '第一句。' });
  });

  test('續寫全是重複 → 新增為空', () => {
    const { added, text } = c.joinContinuation(EXISTING, EXISTING);
    assert.equal(added, '');
    assert.equal(text, EXISTING);
  });
});

describe('continuation · 帶進提示詞的已寫末尾', () => {
  test('不長就原樣；長了取最後 1600 字，開頭對齊到段落', () => {
    assert.equal(c.continuationTail('短。'), '短。');
    const long = `${'甲'.repeat(300)}\n${'乙'.repeat(1500)}`;
    const tail = c.continuationTail(long);
    assert.ok(tail.startsWith('乙'), tail.slice(0, 5));
    assert.equal(tail.length, 1500);
  });

  test('字數連已有的一起算', () => {
    assert.equal(c.wordsOf('一二三', '四五'), 5);
  });
});
