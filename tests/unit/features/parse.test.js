const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

describe('features/parse', () => {
  let p;
  before(() => { p = loadModule('src/core/features/parse.ts'); });

  test('stripCodeFence 剝掉 json fence', () => {
    assert.equal(p.stripCodeFence('```json\n{"a":1}\n```'), '{"a":1}');
  });
  test('stripCodeFence 無 fence 原樣 trim', () => {
    assert.equal(p.stripCodeFence('  hello  '), 'hello');
  });
  test('extractJsonObject 取最外層物件', () => {
    assert.equal(p.extractJsonObject('好的：{"梗概":"x}y"} 以上'), '{"梗概":"x}y"}');
  });
  test('extractJsonArray 取最外層陣列', () => {
    assert.equal(p.extractJsonArray('x [1,2] y'), '[1,2]');
  });
  test('extractJson 物件與陣列取更靠前的', () => {
    assert.equal(p.extractJson('{"a":1}'), '{"a":1}');
    assert.equal(p.extractJson('[1]{"a":1}'), '[1]');
  });
  test('unique / uniqueNumbers', () => {
    assert.deepEqual(p.unique(['a', '', 'a', ' b ']), ['a', 'b']);
    assert.deepEqual(p.uniqueNumbers([3, 1, 3, 2]), [1, 2, 3]);
  });
  test('stringArray 認陣列與頓號串', () => {
    assert.deepEqual(p.stringArray(['a', 1, 'b']), ['a', 'b']);
    assert.deepEqual(p.stringArray('林昭、沈氏'), ['林昭', '沈氏']);
  });
  test('jsonList 取指定的那一組，也認 candidates、直接一個陣列與夾著廢話的', () => {
    assert.deepEqual(p.jsonList('```json\n{"events":[1,2]}\n```', 'events'), [1, 2]);
    assert.deepEqual(p.jsonList('{"candidates":[{"a":1}]}', 'threads'), [{ a: 1 }]);
    assert.deepEqual(p.jsonList('[3]', 'conflicts'), [3]);
    assert.deepEqual(p.jsonList('好的，結果如下：{"conflicts":[]} 以上', 'conflicts'), []);
  });
  test('jsonList 解不出、或那一組不是陣列時返回 undefined', () => {
    assert.equal(p.jsonList('不是 JSON', 'events'), undefined);
    assert.equal(p.jsonList('{"events":"無"}', 'events'), undefined);
  });
});
