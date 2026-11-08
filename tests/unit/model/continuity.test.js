/**
 * 連續性事實（D18）：定稿時掛證據、寫正文時定位原文，兩頭都不調模型。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 證據是正文裡的原句 | 寫正文時要拿它回到正文裡逐字定位 |
 * | 事實裡的人名不算命中 | 「林昭」兩個字不該讓任何一句提到林昭的話都當證據 |
 * | 找不到證據的事實丟掉 | 沒有原文撐著的「事實」多半是模型編的（上游同） |
 * | 手改的寫法都認 | 第 1 條：作者會手改 |
 * | 定位不到的那條報出來 | 第 2 條：呼叫方要把它降級並寫進明細 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const c = loadModule('src/core/model/continuity.ts');

const TEXT = [
  '雨下了一整夜。林昭推開客棧的門，簷下的燈籠被風吹得直晃。',
  '青鱗從暗處撲出來，他側身躲開，血順著左臂往下淌，他把袖子紮緊了。',
  '沈氏在櫃檯後看著他，沒說話。她把那塊殘令收進了袖中。',
  '天亮時，林昭離開了青崖鎮，往北去了。',
].join('\n\n');

describe('continuity.ts · 掛證據', () => {
  test('找到的是正文裡的原句', () => {
    const { facts, dropped } = c.attachEvidence(['林昭左臂被青鱗劃傷，血流不止'], TEXT, ['林昭', '沈氏']);
    assert.deepEqual(dropped, []);
    assert.equal(facts.length, 1);
    assert.ok(TEXT.includes(facts[0].evidence), facts[0].evidence);
    assert.match(facts[0].evidence, /左臂/);
  });

  // 人名出現一次之後正文多半換成「他」：只在含人名的句子裡找，最該當證據的那句反而找不到。
  test('含人名的句子裡沒有，就在全部句子裡按更嚴的門檻找', () => {
    const { facts } = c.attachEvidence(['沈氏把殘令收進袖中'], TEXT, ['林昭', '沈氏']);
    assert.equal(facts[0].evidence, '她把那塊殘令收進了袖中。');
  });

  test('含人名的句子優先', () => {
    const text = '沈氏也離開了青崖鎮。\n\n天亮時，林昭離開了青崖鎮，往北去了。';
    const { facts } = c.attachEvidence(['林昭離開青崖鎮'], text, ['林昭', '沈氏']);
    assert.match(facts[0].evidence, /林昭/);
  });

  test('只有人名對得上不算證據', () => {
    const { facts, dropped } = c.attachEvidence(['林昭學會了御劍飛行'], TEXT, ['林昭']);
    assert.deepEqual(facts, []);
    assert.deepEqual(dropped, ['林昭學會了御劍飛行']);
  });

  test('找不到證據的事實丟掉，報出來', () => {
    const { facts, dropped } = c.attachEvidence(['城主暗中投靠了魔教', '林昭離開青崖鎮往北'], TEXT, ['林昭']);
    assert.equal(facts.length, 1);
    assert.deepEqual(dropped, ['城主暗中投靠了魔教']);
  });

  test('一章最多留 12 條，多出來的也報出來', () => {
    const many = Array.from({ length: 14 }, () => '林昭離開青崖鎮往北');
    const { facts, dropped } = c.attachEvidence(many, TEXT, ['林昭']);
    assert.equal(facts.length, c.CONTINUITY_FACT_LIMIT);
    assert.equal(dropped.length, 2);
  });

  test('模型自己加的「- 」「1.」去掉', () => {
    const { facts } = c.attachEvidence(['- 林昭離開青崖鎮往北', '2. 沈氏把殘令收進袖中'], TEXT, ['林昭', '沈氏']);
    assert.deepEqual(facts.map((f) => f.statement), ['林昭離開青崖鎮往北', '沈氏把殘令收進袖中']);
  });
});

describe('continuity.ts · 渲染與讀回', () => {
  test('往返', () => {
    const facts = [
      { statement: '林昭左臂受傷', evidence: '血順著左臂往下淌，他把袖子紮緊了。' },
      { statement: '沈氏收起了殘令' },
    ];
    const text = c.renderContinuityFacts(facts);
    assert.equal(text, '- 林昭左臂受傷 〔證據：「血順著左臂往下淌，他把袖子紮緊了。」〕\n- 沈氏收起了殘令');
    assert.deepEqual(c.parseContinuityFacts(text), facts);
  });

  test('手改的寫法都認：半形括號、沒有引號、沒有「- 」', () => {
    const text = [
      '- 林昭左臂受傷 [證據: 血順著左臂往下淌]',
      '沈氏收起了殘令（證據：“她把那塊殘令收進了袖中”）',
      '',
      '（待補充）',
    ].join('\n');
    assert.deepEqual(c.parseContinuityFacts(text), [
      { statement: '林昭左臂受傷', evidence: '血順著左臂往下淌' },
      { statement: '沈氏收起了殘令', evidence: '她把那塊殘令收進了袖中' },
    ]);
  });

  test('證據裡帶引號的對白也讀得回來', () => {
    const facts = [{ statement: '沈氏答應了', evidence: '她說：「好。」' }];
    assert.deepEqual(c.parseContinuityFacts(c.renderContinuityFacts(facts)), facts);
  });
});

describe('continuity.ts · 寫正文時定位原文', () => {
  test('取命中那一段與前後各一段', () => {
    const { passages, hits } = c.locateEvidence(TEXT, ['她把那塊殘令收進了袖中']);
    assert.deepEqual(hits, [true]);
    assert.equal(passages.length, 1);
    assert.match(passages[0], /血順著左臂/);
    assert.match(passages[0], /天亮時/);
    assert.doesNotMatch(passages[0], /雨下了一整夜/);
  });

  test('相鄰的視窗合併成一段，不重複', () => {
    const { passages } = c.locateEvidence(TEXT, ['血順著左臂往下淌', '她把那塊殘令收進了袖中']);
    assert.equal(passages.length, 1);
    assert.equal(passages[0], TEXT);
  });

  test('空白不計：正文換了行也認得', () => {
    const { hits } = c.locateEvidence(TEXT.replace('往下淌，', '往下淌，\n'), ['血順著左臂往下淌，他把袖子紮緊了']);
    assert.deepEqual(hits, [true]);
  });

  test('作者改過正文：那一句報找不到', () => {
    const { passages, hits } = c.locateEvidence(TEXT, ['他拔出了劍', '天亮時，林昭離開了青崖鎮']);
    assert.deepEqual(hits, [false, true]);
    assert.equal(passages.length, 1);
  });
});

// ⚑ 復跑之後（敘事線定稿 a 的證據）：逐字找不到的 7 條多半隻是把「他」換成了人名、刪了幾個字、兩句拼成一句。找最接近的原句，
// 兩字詞 Dice ≥ 0.6 才算；意譯、編的在 0.4 以下。例子照復跑裡的幾條改寫。
describe('continuity.ts · 引文逐字找不到時找最接近的原句', () => {
  const text = [
    '霧氣越來越濃，壓得人喘不過氣，絕望到了極點。沈默猛地抬頭，盯著霧氣中那團模糊的黑影，眼中沒有絲毫怯意，只有一種絕望的狠戾。',
    '“你怕火。”沈默聲音乾癟。',
    '她沒有廢話，直接將手中一根尖細的骨片探了過來，那骨片尖端泛著一股陰冷的灰白。',
    '阿婆的右臂，根本不是活人的手。他瞬間明白了，這個滿口民俗禁忌、看似唯一的倖存者阿婆，同樣不是個純粹的活人。',
  ].join('\n\n');

  test('刪了幾個字、代詞換人名：換成那一句原文', () => {
    assert.equal(
      c.nearestSentence(text, '沈默死死盯著霧氣中那團模糊的黑影，眼中沒有絲毫怯意，只有一種絕望的狠戾。').sentence,
      '沈默猛地抬頭，盯著霧氣中那團模糊的黑影，眼中沒有絲毫怯意，只有一種絕望的狠戾。'
    );
    assert.equal(
      c.nearestSentence(text, '阿婆直接將手中一根尖細的骨片探了過來，那骨片尖端泛著一股陰冷的灰白。').sentence,
      '她沒有廢話，直接將手中一根尖細的骨片探了過來，那骨片尖端泛著一股陰冷的灰白。'
    );
    const r = c.nearestSentence(text, '沈默瞬間明白了，這個滿口民俗禁忌、看似唯一的倖存者阿婆，同樣不是個純粹的活人。');
    assert.equal(r.sentence, '他瞬間明白了，這個滿口民俗禁忌、看似唯一的倖存者阿婆，同樣不是個純粹的活人。');
    assert.ok(r.score >= c.NEAR_QUOTE_MIN && r.score < 1, String(r.score));
  });

  test('兩句拼成一句：取連著的兩句；句末的右引號跟著前一句', () => {
    assert.equal(
      c.nearestSentence(text, '阿婆的右臂，根本不是活人的手。沈默瞬間明白了，這個倖存者阿婆，同樣不是個純粹的活人。').sentence,
      '阿婆的右臂，根本不是活人的手。他瞬間明白了，這個滿口民俗禁忌、看似唯一的倖存者阿婆，同樣不是個純粹的活人。'
    );
    assert.equal(c.nearestSentence(text, '“你怕火。”沈默的聲音乾癟極了，像砂紙。')?.sentence, '“你怕火。”沈默聲音乾癟。');
  });

  test('意譯、編的、太短的：不認', () => {
    assert.equal(c.nearestSentence(text, '沈默盯著霧中的黑影，眼中滿是狠戾。'), undefined);
    assert.equal(c.nearestSentence(text, '沈默用火摺子點燃了祭壇，火光沖天。'), undefined);
    assert.equal(c.nearestSentence(text, '他瞬間明白了'), undefined, '歸一之後不到 10 個字');
    // 兩句加起來超過上限的那一段不要，只在單句裡挑。
    assert.equal(c.nearestSentence(text, '阿婆的右臂，根本不是活人的手。他瞬間明白了，這個滿口民俗禁忌。', 20)?.sentence, '阿婆的右臂，根本不是活人的手。');
  });
});
