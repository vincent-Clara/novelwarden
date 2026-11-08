/**
 * 角色卡的「性別」（frontmatter 的 `gender`）：同義寫法收口、空話當沒寫、卡上寫了的不讓模型改，
 * 以及裝配時跟著名字進上下文——寫正文的模型不用再拿名字猜。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const G = loadModule('src/core/model/gender.ts');
const R = loadModule('src/core/context/layers/render.ts');

const card = (over = {}) => ({
  slug: '陸清河',
  relPath: '.novelwarden/characters/陸清河.md',
  name: '陸清河',
  aliases: [],
  tags: ['配角'],
  appearsIn: [],
  body: '',
  sections: { 身份: '散修陣法師', 外貌: '', 性格: '', 语言习惯: '', 人物关系: '', 当前状态: '在溶洞療傷', 暗设: '' },
  ...over,
});

describe('gender.ts · 規範寫法', () => {
  test('同義寫法收成「男」「女」', () => {
    for (const v of ['男', '男性', 'male', 'M', ' man ']) {
      assert.equal(G.normalizeGender(v), '男', v);
    }
    for (const v of ['女', '女性', 'Female', 'f', 'woman']) {
      assert.equal(G.normalizeGender(v), '女', v);
    }
  });

  test('空、「未知」「不詳」與非字串當沒寫', () => {
    for (const v of ['', '  ', '未知', '不詳', '無', 'unknown', undefined, 1, ['女']]) {
      assert.equal(G.normalizeGender(v), undefined, String(v));
    }
  });

  test('認不出的照原樣留著，截到 8 個字', () => {
    assert.equal(G.normalizeGender('無性別'), '無性別');
    assert.equal(G.normalizeGender('一二三四五六七八九十'), '一二三四五六七八');
  });

  test('卡上寫了的不動，沒寫才用新給的', () => {
    assert.equal(G.keepGender('女', '男'), '女');
    assert.equal(G.keepGender(undefined, 'female'), '女');
    assert.equal(G.keepGender(undefined, '未知'), undefined);
  });
});

describe('render.ts · 性別跟著名字進上下文', () => {
  test('完整角色卡與只帶三節的精簡版，抬頭都帶性別與別名', () => {
    const c = card({ gender: '女', aliases: ['清河'] });
    assert.ok(R.renderCharacter(c, false, true).startsWith('【陸清河（女；又稱 清河）】'), R.renderCharacter(c, false, true));
    assert.ok(R.renderCharacter(c, true, true).startsWith('【陸清河（女；又稱 清河）】'));
    assert.ok(R.renderCharacter(card({ gender: '女' }), true, false).startsWith('【陸清河（女）】'));
  });

  test('沒寫性別、沒有別名：與從前一樣只有名字', () => {
    assert.ok(R.renderCharacter(card(), false, false).startsWith('【陸清河】'));
    assert.ok(R.renderCharacter(card({ aliases: ['清河'] }), false, true).startsWith('【陸清河（又稱 清河）】'));
  });

  test('角色圖譜一覽：名字後面是性別與別名，再是定位', () => {
    assert.ok(R.renderRosterLine(card({ gender: '女' })).startsWith('- 陸清河（女）［配角］'));
    assert.ok(R.renderRosterLine(card()).startsWith('- 陸清河［配角］'));
  });
});
