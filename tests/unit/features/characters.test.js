/**
 * 角色 JSON 解析的容錯。遷自 scripts/smoke.js 的
 * `== characters.ts · parseCharacterResponse ==` 一節。
 *
 * 容錯優先：解析失敗退化為忽略（空陣列），絕不拋崩。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const JSON_REPLY = JSON.stringify([
  { name: '林昭', aliases: ['阿昭'], tags: ['主角'], 身份: '倖存者', 语言习惯: '答話極短', 当前状态: '客棧中' },
  { name: '沈氏', aliases: [], tags: ['配角'], 人物关系: ['與林昭：試探', '與掌櫃：未知'] },
]);

describe('characters.ts · parseCharacterResponse', () => {
  let ch;
  let cards;

  before(() => {
    ch = loadModule('src/core/features/characters.ts');
    cards = ch.parseCharacterResponse(JSON_REPLY);
  });

  test('解析出兩個角色', () => {
    assert.equal(cards.length, 2);
  });

  test('保留 aliases', () => {
    assert.equal(cards[0].aliases[0], '阿昭');
  });

  test('對映小節欄位', () => {
    assert.equal(cards[0].sections.身份, '倖存者');
    assert.equal(cards[0].sections.语言习惯, '答話極短');
  });

  test('未提供的小節為空串', () => {
    assert.equal(cards[0].sections.外貌, '');
  });

  test('陣列欄位轉為列表', () => {
    assert.equal(cards[1].sections.人物关系, '- 與林昭：試探\n- 與掌櫃：未知');
  });

  describe('容錯', () => {
    test('程式碼塊包裹的 JSON', () => {
      assert.equal(ch.parseCharacterResponse('```json\n' + JSON_REPLY + '\n```').length, 2);
    });

    test('前後有廢話的 JSON', () => {
      assert.equal(ch.parseCharacterResponse('好的：\n' + JSON_REPLY + '\n以上。').length, 2);
    });

    test('非 JSON 返回空陣列', () => {
      assert.equal(ch.parseCharacterResponse('我無法完成').length, 0);
    });

    test('壞 JSON 返回空陣列而非拋錯', () => {
      assert.equal(ch.parseCharacterResponse('[{name: 缺引號}]').length, 0);
    });

    test('無 name 的條目被丟棄', () => {
      assert.equal(ch.parseCharacterResponse('[{"身份":"x"}]').length, 0);
    });

    test('字串形式的 aliases 被拆分', () => {
      assert.equal(ch.parseCharacterResponse('[{"name":"甲","aliases":"a、b"}]')[0].aliases.length, 2);
    });
  });

  // 正文裡混進作者的筆記（「反派在此處需要透露……」）時，模型會把稱謂填進 name、真名塞進別名。
  describe('劇作稱謂', () => {
    let labeled;

    before(() => {
      labeled = ch.parseCharacterResponse(
        JSON.stringify([
          { name: '反派', aliases: ['韓厲', '頭領'], tags: ['配角'] },
          { name: '林昭', aliases: ['主角', '阿昭'] },
          { name: '主角', aliases: [] },
        ])
      );
    });

    test('稱謂當名字的換成別名裡的真名，稱謂挪進 tags', () => {
      assert.deepEqual(
        { name: labeled[0].name, aliases: labeled[0].aliases, tags: labeled[0].tags },
        { name: '韓厲', aliases: ['頭領'], tags: ['配角', '反派'] }
      );
    });

    test('別名裡的稱謂被剔掉', () => {
      assert.deepEqual(labeled[1].aliases, ['阿昭']);
    });

    test('光一個稱謂、沒有真名的不建卡', () => {
      assert.deepEqual(labeled.map((c) => c.name), ['韓厲', '林昭']);
    });
  });
});

describe('characters.ts · mergeWithinBatch', () => {
  let ch;

  before(() => {
    ch = loadModule('src/core/features/characters.ts');
  });

  test('同名的兩條併成一條：別名標籤取並集，小節先到先得、空的用後一條補', () => {
    const merged = ch.mergeWithinBatch(
      ch.parseCharacterResponse(
        JSON.stringify([
          { name: '韓厲', aliases: [], tags: ['反派'], 身份: '黑風寨寨主' },
          { name: '反派', aliases: ['韓厲', '頭領'], 身份: '黑風寨頭領', 性格: '多疑', 性别: '男' },
        ])
      )
    );
    assert.equal(merged.length, 1);
    assert.deepEqual(
      { aliases: merged[0].aliases, tags: merged[0].tags, gender: merged[0].gender },
      { aliases: ['頭領'], tags: ['反派'], gender: '男' }
    );
    assert.equal(merged[0].sections.身份, '黑風寨寨主');
    assert.equal(merged[0].sections.性格, '多疑');
  });

  // 模型把兩個人列成兩條，就是認為他們是兩個人；那條別名才是錯的（方源的卡掛過孿生弟弟「方正」）。
  test('別名是同一批另一條的正式名：去掉別名，兩個人都留著', () => {
    const merged = ch.mergeWithinBatch(
      ch.parseCharacterResponse(JSON.stringify([{ name: '方源', aliases: ['方正', '古月方源'] }, { name: '方正', aliases: [] }]))
    );
    assert.deepEqual(
      merged.map((c) => [c.name, c.aliases]),
      [
        ['方源', ['古月方源']],
        ['方正', []],
      ]
    );
  });
});
