/**
 * `cast` 欄位的序列化往返與小節文字反解。
 * 遷自 scripts/smoke.js 的 `== castParse.ts · 出場人物欄位 ==` 一節。
 *
 * 摘要是出場人物的唯一真相：frontmatter 裡的 `林昭(阿昭、昭兒)` 與結構化條目
 * 必須互為逆運算，否則「誰是誰」會在一次讀寫之間漂移。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

describe('castParse.ts · 出場人物欄位', () => {
  let p;
  before(() => {
    p = loadModule('src/core/model/castParse.ts');
  });

  describe('parseCastEntry / renderCastEntry', () => {
    test('解析帶別名的 cast 條目', () => {
      const entry = p.parseCastEntry('林昭(阿昭、昭兒)');
      assert.equal(entry.name, '林昭', JSON.stringify(entry));
      assert.equal(entry.aliases.length, 2, JSON.stringify(entry));
    });

    test('解析無別名的 cast 條目', () => {
      assert.equal(p.parseCastEntry('沈氏').aliases.length, 0);
    });

    test('全形括號也認', () => {
      assert.equal(p.parseCastEntry('林昭（阿昭）').name, '林昭');
    });

    test('渲染帶別名', () => {
      assert.equal(p.renderCastEntry({ name: '林昭', aliases: ['阿昭'] }), '林昭(阿昭)');
    });

    test('渲染無別名不加括號', () => {
      assert.equal(p.renderCastEntry({ name: '沈氏', aliases: [] }), '沈氏');
    });

    test('渲染時別名與名字相同則丟棄', () => {
      assert.equal(p.renderCastEntry({ name: '沈氏', aliases: ['沈氏'] }), '沈氏');
    });

    test('cast 條目序列化往返', () => {
      const round = p.parseCastEntry(p.renderCastEntry({ name: '林昭', aliases: ['阿昭', '昭兒'] }));
      assert.equal(round.name, '林昭');
      assert.equal(round.aliases.join('、'), '阿昭、昭兒');
    });
  });

  describe('castFromText（舊摘要與手寫摘要走這條）', () => {
    test('文字反解頓號分隔', () => {
      assert.equal(p.castFromText('林昭、沈氏、客棧掌櫃').length, 3);
    });

    test('文字反解列表寫法', () => {
      assert.equal(p.castFromText('- 林昭\n- 沈氏').length, 2);
    });

    test('文字反解去重', () => {
      assert.equal(p.castFromText('林昭、林昭').length, 1);
    });

    test('文字反解跳過「無」', () => {
      assert.equal(p.castFromText('無').length, 0);
    });

    test('文字反解跳過整段描述', () => {
      assert.equal(p.castFromText('本章沒有新人物出場，只有林昭一人在客棧中獨坐').length, 0);
    });
  });
});
