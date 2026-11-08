/**
 * 定稿解析的兩層：JSON → Markdown 小節；兩層都不中就什麼都不收。
 * 遷自 scripts/smoke.js 的 `== summarize.ts · parseSummaryResponse ==` 一節。
 *
 * 能解析的一定要解析出來：解析失敗等於這一章的連續性事實與出場人物進不了上下文。
 * 解析不了的一個字都不收：定稿寫回的是這一章的細綱，把沒解析開的原文塞進去等於毀掉作者的計劃。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT, loadModule } = require('../../helpers/load');

const SAMPLE = path.join(ROOT, 'sample-novel');

const JSON_REPLY = JSON.stringify({
  梗概: '林昭進鎮。',
  出场人物: [{ name: '林昭', aliases: ['阿昭'] }, { name: '李叔', aliases: [] }],
  时间地点: '傍晚，鎮口',
  关键事件: ['遞上令牌', '掌櫃多看了他兩眼'],
  状态变更: '',
});

const STANDARD_MD = `## 梗概\n\n林昭進鎮。\n\n## 出場人物\n\n林昭、李叔\n\n## 時間地點\n\n傍晚，鎮口\n\n## 關鍵事件\n\n- 遞上令牌\n\n## 狀態變更\n\n無`;

describe('summarize.ts · parseSummaryResponse', () => {
  let sum;
  before(() => {
    sum = loadModule('src/core/features/summarize.ts');
  });

  describe('第一層：JSON 路徑（現在的提示詞要求的形狀）', () => {
    let j;
    before(() => {
      j = sum.parseSummaryResponse(JSON_REPLY);
    });

    test('JSON：解析梗概', () => {
      assert.equal(j.sections.梗概, '林昭進鎮。');
    });

    test('JSON：陣列小節渲染成列表', () => {
      assert.equal(j.sections.关键事件, '- 遞上令牌\n- 掌櫃多看了他兩眼');
    });

    test('JSON：空欄位為空串而非「無」', () => {
      assert.equal(j.sections.状态变更, '');
    });

    // 四期：連續性事實是字串陣列，解析成一條一行；證據在定稿時另掛（summarizeChapter）。
    test('JSON：連續性事實一條一行；老提示詞沒有這一項時是空的', () => {
      const withFacts = sum.parseSummaryResponse(JSON.stringify({ ...JSON.parse(JSON_REPLY), 连续性事实: ['林昭左臂受傷', '李叔認出了令牌'] }));
      assert.equal(withFacts.sections.连续性事实, '- 林昭左臂受傷\n- 李叔認出了令牌');
      assert.equal(j.sections.连续性事实, '');
    });

    test('JSON：看點一條一行；老摘要沒有這一項時是空的', () => {
      const withHighlight = sum.parseSummaryResponse(JSON.stringify({ ...JSON.parse(JSON_REPLY), 看点: ['掌櫃當眾認出令牌，滿堂譁然', '李叔為何變了臉色'] }));
      assert.equal(withHighlight.sections.看点, '- 掌櫃當眾認出令牌，滿堂譁然\n- 李叔為何變了臉色');
      assert.equal(j.sections.看点, '');
    });

    test('JSON：出場人物結構化', () => {
      assert.equal(j.cast.length, 2, JSON.stringify(j.cast));
      assert.equal(j.cast[0].name, '林昭', JSON.stringify(j.cast));
    });

    test('JSON：保留 cast 別名', () => {
      assert.equal(j.cast[0].aliases[0], '阿昭');
    });

    // 出場人物小節從 cast 渲染回來，兩者始終一致。
    test('JSON：出場人物小節由 cast 渲染', () => {
      assert.equal(j.sections.出场人物, '林昭(阿昭)、李叔');
    });

    test('JSON：程式碼塊包裹', () => {
      assert.equal(sum.parseSummaryResponse('```json\n' + JSON_REPLY + '\n```').sections.梗概, '林昭進鎮。');
    });

    test('JSON：前後有廢話', () => {
      assert.equal(sum.parseSummaryResponse('好的：\n' + JSON_REPLY + '\n以上。').cast.length, 2);
    });

    // 出場人物寫成字串（模型沒照做）也要收下。
    test('JSON：出場人物寫成字串也解析', () => {
      const loose = sum.parseSummaryResponse('{"梗概":"x","出场人物":"林昭、沈氏","关键事件":[]}');
      assert.equal(loose.cast.length, 2, JSON.stringify(loose.cast));
      assert.equal(loose.cast[1].name, '沈氏', JSON.stringify(loose.cast));
    });

    // 正文裡夾著作者筆記時模型會把稱謂當名字：換成別名裡的真名，同一個人併成一條，光一個稱謂的不列。
    test('JSON：出場人物裡的劇作稱謂換成真名', () => {
      const labeled = sum.parseSummaryResponse(
        JSON.stringify({
          梗概: 'x',
          关键事件: ['甲'],
          出场人物: [{ name: '林昭', aliases: [] }, { name: '主角', aliases: ['林昭', '阿昭'] }, { name: '反派', aliases: [] }],
        })
      );
      assert.deepEqual(labeled.cast, [{ name: '林昭', aliases: ['阿昭'] }]);
      assert.equal(labeled.sections.出场人物, '林昭(阿昭)');
    });

    // 語法合法但不相干的 JSON 不能被認成一份細綱：降級到小節解析也拿不到東西，七節全空，
    // 定稿那一步據此報失敗、細綱不動。
    test('JSON：不相干的 JSON 不被當成細綱', () => {
      const irrelevant = sum.parseSummaryResponse('{"text":"模型答非所問"}');
      assert.ok(Object.values(irrelevant.sections).every((v) => v === ''), JSON.stringify(irrelevant.sections));
    });

    // 真實模型試跑裡撞上的：陣列最後一項後面多一個逗號。JSON.parse 不認，自己去掉再解析。
    test('JSON：尾逗號去掉再解析', () => {
      const trailing = sum.parseSummaryResponse('{"梗概":"沈安回鎮。","关键事件":["遇見雲娘，",\n  "決定同行。",\n],"出场人物":[{"name":"沈安","aliases":[]},],}');
      assert.equal(trailing.sections.梗概, '沈安回鎮。');
      assert.equal(trailing.sections.关键事件, '- 遇見雲娘，\n- 決定同行。');
      assert.equal(trailing.cast.length, 1, JSON.stringify(trailing.cast));
    });

    // 同上：模型把六小節寫成 markdown 但外面裹了個 JSON 殼時，仍要拿到小節。
    test('JSON：殼外的小節仍能解析', () => {
      const wrapped = sum.parseSummaryResponse('{"summary": "x"}\n\n## 梗概\n\n林昭進鎮。\n\n## 關鍵事件\n\n- 遞上令牌');
      assert.equal(wrapped.sections.梗概, '林昭進鎮。');
    });
  });

  describe('第二層：Markdown 降級（舊格式 / 模型不聽話 / 作者手改）', () => {
    let parsed;
    before(() => {
      parsed = sum.parseSummaryResponse(STANDARD_MD);
    });

    test('降級：解析標準六小節', () => {
      assert.equal(parsed.sections.梗概, '林昭進鎮。');
      assert.equal(parsed.sections.出场人物, '林昭、李叔');
    });

    test('降級：關鍵事件保留列表', () => {
      assert.equal(parsed.sections.关键事件, '- 遞上令牌');
    });

    // 沒有結構化 cast 時從「出場人物」小節文字反解，角色頁不該因此少人。
    test('降級：從小節文字反解出場人物', () => {
      assert.equal(parsed.cast.length, 2, JSON.stringify(parsed.cast));
      assert.equal(parsed.cast[0].name, '林昭', JSON.stringify(parsed.cast));
    });

    test('降級：剝離程式碼塊圍欄', () => {
      assert.equal(sum.parseSummaryResponse('```markdown\n' + STANDARD_MD + '\n```').sections.梗概, '林昭進鎮。');
    });

    test('降級：行內寫法兜底', () => {
      const inline = sum.parseSummaryResponse('梗概：林昭進鎮。\n出場人物：林昭、李叔\n關鍵事件：遞上令牌');
      assert.equal(inline.sections.梗概, '林昭進鎮。');
      assert.equal(inline.sections.出场人物, '林昭、李叔');
    });

    test('降級：加粗行內寫法兜底', () => {
      assert.equal(sum.parseSummaryResponse('**梗概**：林昭進鎮。\n**出場人物**：林昭').sections.梗概, '林昭進鎮。');
    });
  });

  describe('兩層都不中：什麼都不收', () => {
    test('完全無結構時七節全空（定稿報失敗，細綱不動）', () => {
      const none = sum.parseSummaryResponse('模型胡說了一通完全沒有結構的內容。');
      assert.ok(Object.values(none.sections).every((v) => v === ''), JSON.stringify(none.sections));
    });

    test('無結構時 cast 為空', () => {
      assert.equal(sum.parseSummaryResponse('模型胡說了一通完全沒有結構的內容。').cast.length, 0);
    });

    // 「無」這類佔位不是人名。
    test('降級：出場人物寫「無」不產生假人', () => {
      assert.equal(sum.parseSummaryResponse('## 梗概\n\nx\n\n## 出場人物\n\n無').cast.length, 0);
    });
  });

  describe('真實示例摘要檔案', () => {
    let realParsed;
    before(() => {
      const real = fs.readFileSync(path.join(SAMPLE, '.novelwarden/summaries/002-客栈里的女人.md'), 'utf8');
      const md = loadModule('src/core/model/markdown.ts');
      realParsed = sum.parseSummaryResponse(md.parseMarkdown(real).body);
    });

    test('解析真實摘要檔案', () => {
      assert.ok(realParsed.sections.出场人物.includes('沈氏'), realParsed.sections.出场人物);
    });

    test('真實摘要的關鍵事件非空；沒有「新增伏筆」這一節了（敘事線二期）', () => {
      assert.ok(realParsed.sections.关键事件.length > 10);
      assert.ok(!('新增伏筆' in realParsed.sections));
    });

    test('真實摘要能反解出出場人物', () => {
      assert.ok(realParsed.cast.some((c) => c.name === '沈氏'), JSON.stringify(realParsed.cast));
    });
  });
});
