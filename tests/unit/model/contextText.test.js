/**
 * 「複製完整上下文」的純函式一半：會話檔案裡那份完整訊息怎麼認、拼出來的文字長什麼樣，
 * 以及 `serializeTurn` 只帶標記不帶正文。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 只有訊息本身，不寫估算 token、詳細度、幾條訊息、調了幾次 | 拿去粘進網頁版 AI 接著做，多一行說明模型就當成要求 |
 * | 訊息正文原樣，按傳送順序、`---` 隔開 | 改一個字就不是當時那一輪了 |
 * | 帶了歷史才標【我】/【你】，系統提示不標 | 網頁 AI 得分得清哪段是它自己上一輪說的；只有一問時標了是多餘的字 |
 * | 手改壞了就當沒有 | 不拼半份冒充全份（第 1 條：不拋） |
 * | `serializeTurn` 只給 `fullContext`，不帶訊息 | 一輪幾萬字，隨每次推會話來回搬是純浪費 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const { contextMessagesOf, renderContextText } = loadModule('src/core/model/session.ts');
const { serializeTurn } = loadModule('src/core/controller/serialize.ts');

const messages = [
  { role: 'system', content: '你是作者。\n\n# 全域要求（每一章都要遵守）\n不寫現代詞。' },
  { role: 'user', content: '上一輪的要求' },
  { role: 'assistant', content: '上一輪的回答' },
  { role: 'user', content: '# 本章細綱\n林昭夜入青雲。' },
];

const assistant = (extra) => Object.assign({ id: 'a1', role: 'assistant', content: '正文', at: 'x' }, extra);

const digest = { usedTokens: 1234, budget: 100000, clamped: false, detail: 3, items: [] };

describe('拼出來的完整上下文', () => {
  test('只有一問：系統提示與這一輪的話原樣相接，什麼都不加', () => {
    const text = renderContextText(assistant({ context: digest, contextMessages: [messages[0], messages[3]] }));
    assert.equal(text, `${messages[0].content}\n\n---\n\n${messages[3].content}`);
  });

  test('帶了歷史：系統提示不標，其餘每條前面標【我】/【你】，正文原樣、按順序', () => {
    const text = renderContextText(assistant({ context: digest, contextMessages: messages }));
    assert.equal(
      text,
      [
        messages[0].content,
        `【我】\n${messages[1].content}`,
        `【你】\n${messages[2].content}`,
        `【我】\n${messages[3].content}`,
      ].join('\n\n---\n\n')
    );
  });

  test('不寫估算 token、詳細度、幾條訊息，調了幾次模型也不說', () => {
    const multi = renderContextText(
      assistant({ context: digest, contextMessages: messages, artifact: { where: 'x', summary: 'y', overwrites: false, calls: 3 } })
    );
    assert.equal(multi, renderContextText(assistant({ contextMessages: messages })));
    assert.doesNotMatch(multi, /完整上下文|token|詳細度|條訊息|調了|system|assistant/);
  });
});

describe('認不出就當沒有', () => {
  test('沒有這個欄位（功能加上之前的回覆）', () => {
    assert.equal(renderContextText(assistant({ context: digest })), undefined);
  });

  test('空陣列', () => {
    assert.equal(contextMessagesOf(assistant({ contextMessages: [] })), undefined);
  });

  test('不是陣列', () => {
    assert.equal(contextMessagesOf(assistant({ contextMessages: '一段字' })), undefined);
  });

  test('有一條角色認不出或正文不是字串，整份不認', () => {
    assert.equal(contextMessagesOf(assistant({ contextMessages: [...messages, { role: 'tool', content: 'x' }] })), undefined);
    assert.equal(contextMessagesOf(assistant({ contextMessages: [...messages, { role: 'user' }] })), undefined);
    assert.equal(contextMessagesOf(assistant({ contextMessages: [null] })), undefined);
  });
});

describe('serializeTurn：只帶標記，不帶正文', () => {
  test('留著完整訊息的標 fullContext', () => {
    const out = serializeTurn(assistant({ context: digest, contextMessages: messages }));
    assert.equal(out.fullContext, true);
    assert.equal(out.contextMessages, undefined);
    assert.doesNotMatch(JSON.stringify(out), /林昭夜入青雲/);
  });

  test('沒留下（或認不出）的不標', () => {
    assert.equal(serializeTurn(assistant({ context: digest })).fullContext, undefined);
    assert.equal(serializeTurn(assistant({ context: digest, contextMessages: [{ role: 'x' }] })).fullContext, undefined);
  });
});
