const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

describe('characterCardParse.ts · parseCardResponse', () => {
  test('解析性格並過濾泛稱別名', () => {
    const { parseCardResponse } = loadModule('src/core/features/characterCardParse.ts');
    const parsed = parseCardResponse(
      JSON.stringify({
        aliases: ['阿昭', '姐姐'],
        性格: '沉默寡言，遇事先觀察。',
      })
    );

    assert.equal(parsed.sections.性格, '沉默寡言，遇事先觀察。');
    assert.deepEqual(parsed.aliases, ['阿昭']);
  });

  test('性別規範成「男」「女」；看不出就沒有', () => {
    const { parseCardResponse } = loadModule('src/core/features/characterCardParse.ts');
    assert.equal(parseCardResponse(JSON.stringify({ 性别: '女性', 性格: '冷' })).gender, '女');
    assert.equal(parseCardResponse(JSON.stringify({ 性别: '', 性格: '冷' })).gender, undefined);
    // 只給了性別、七節全空：照舊算沒解出東西，不拿一張空卡去煩作者。
    assert.equal(parseCardResponse(JSON.stringify({ 性别: '男' })), undefined);
  });
});
