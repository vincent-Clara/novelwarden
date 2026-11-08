/**
 * 重演檢測（context/replay.ts）：新寫的一章開頭，是不是把上一章結尾又演了一遍。
 *
 * 判法移植自 AI-Novel-Writer：兩邊歸一後按 8 字 n-gram 比對，新稿前 1200 字裡**連續覆蓋
 * ≥ 80 字**才算。這組用例釘住三件事：
 *
 * 1. 真重演（整段搬過來、只改了標點空白）一定報；
 * 2. 零星撞詞、刻意呼應的一句臺詞不報——否則卡片天天標紅，作者很快就不看了；
 * 3. 報出來的 `quote` 是新稿裡的原文（帶標點），作者一眼認得出是哪一段。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const replay = loadModule('src/core/context/replay.ts');

/** 上一章結尾：一段足夠長、互不重複的敘述。 */
const PREV = [
  '雪下到半夜才停。林昭把殘令揣進懷裡，沿著河堤往回走，腳下的冰殼一踩就碎。',
  '客棧的燈還亮著，沈氏坐在櫃檯後面撥算盤，看見他進門，手指停在半空，半晌才說了一句：“李叔來過，問你去了哪裡。”',
  '林昭沒有答話，只把溼透的斗篷掛在門後，從灶上端下那碗早就涼了的薑湯，一口一口喝完。',
].join('\n\n');

describe('replay · 判重演', () => {
  test('新稿開頭整段搬了上一章結尾（標點與空白改過）→ 命中', () => {
    // 第二、三兩段連著搬過來：一段只有五十來字，夠不上 80 字的門檻。
    const moved = PREV.split('\n\n').slice(1).join('\n').replace(/，/g, ',').replace(/。/g, '. ');
    const draft = `${moved}\n\n天亮之後，他去了鎮東的井邊，那裡圍著一圈人，誰也不說話。`;
    const v = replay.detectReplay(PREV, draft);
    assert.equal(v.hit, true);
    assert.ok(v.run >= replay.REPLAY_RUN, String(v.run));
    // 給作者看的是新稿裡的原文，不是歸一之後的那串字。
    assert.ok(draft.includes(v.quote), v.quote);
    assert.match(v.quote, /沈氏坐在櫃檯後面/);
  });

  test('只撞了幾個詞（人名、地名）→ 不命中', () => {
    const draft =
      '林昭一早就出了客棧。沈氏在後院劈柴，沒有抬頭看他。鎮東的井邊圍著一圈人，李叔站在最前面，手裡攥著一截燒黑的木頭。';
    assert.equal(replay.detectReplay(PREV, draft).hit, false);
  });

  test('刻意呼應一句臺詞（不到 80 字）→ 不命中', () => {
    const draft = `“李叔來過，問你去了哪裡。”這句話他在心裡又過了一遍，然後推開了井邊那扇門。門後面是一段向下的石階，潮氣撲面而來。`;
    assert.equal(replay.detectReplay(PREV, draft).hit, false);
  });

  test('重演出在 1200 字之後 → 不判（只查開頭）', () => {
    const lead = '他走了很久。'.repeat(220); // 1320 字，把重演推到 1200 之外
    const draft = `${lead}${PREV.split('\n\n')[1]}`;
    assert.equal(replay.detectReplay(PREV, draft).hit, false);
  });

  test('任一邊太短 → 不判，不拋', () => {
    assert.deepEqual(replay.detectReplay('', '隨便什麼'), { hit: false });
    assert.deepEqual(replay.detectReplay(PREV, '短。'), { hit: false });
    assert.deepEqual(replay.detectReplay('雪。', PREV), { hit: false });
  });

  test('全形半形、大小寫差異照樣認得出（NFKC + 小寫）', () => {
    const body = '公司的招牌在雨裡晃了一整夜，樓下的保安換了三撥，誰也說不清那輛黑車是幾點開走的，只記得車牌尾號是七七三，車窗上貼著一張褪色的通行證，副駕駛座上放著半包沒拆的煙和一把折斷的傘。';
    const prev = `ＡＢＣ${body}`;
    const draft = `abc${body}\n\n第二天一早，警察來了。`;
    assert.equal(replay.detectReplay(prev, draft).hit, true);
  });
});

describe('replay · 上一章結尾', () => {
  test('不長就原樣', () => {
    assert.equal(replay.previousEnding('  一句話。  '), '一句話。');
  });

  test('長了取最後約 1000 字，開頭對齊到句子邊界', () => {
    const long = `${'前面的事。'.repeat(300)}最後一句在這裡。`;
    const end = replay.previousEnding(long);
    assert.ok(end.length <= replay.PREVIOUS_ENDING_CHARS, String(end.length));
    assert.ok(end.endsWith('最後一句在這裡。'));
    // 從句子開頭起，不從半句「的事。」起。
    assert.ok(end.startsWith('前面的事。'), end.slice(0, 10));
  });
});
