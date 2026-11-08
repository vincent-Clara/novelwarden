/**
 * 轉寫的整條走法（features/transcribe.ts 的 `transcribeJson`，2026-10-25 起所有結構化產物都走它）。呼叫是假的：
 * 一個按順序交回應答的函式，記下每次收到的訊息。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 原文就是 JSON | 不轉，按這一步的解碼直接判（與改之前一樣）；判不過照樣不轉 |
 * | 不像這一步的輸出 | 不花轉寫那一次；壞了語法的 JSON 照轉 |
 * | 照抄 | 一次過；「無」換成空的；交回規範化的 JSON |
 * | 改了字 / 解碼不過 / 截斷 | 重轉一次，說清上次哪裡不對；還不過交回原因與兩條說明 |
 * | 轉寫呼叫失敗 | 不往外拋，交回 `failed`；取消照舊往外拋 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');

// 同一個 bundle：用例裡拋的 CancelledError 與 transcribe.ts 認的是同一個類。
const { t: T, p: P } = loadBundle({ t: './src/core/features/transcribe.ts', p: './src/core/llm/provider.ts' });

const SOURCE = ['## 林昭', '- 身份：青雲宗外門弟子', '- 當前狀態：左臂受傷，藏在後院', '- 定位：主角'].join('\n');
const spec = (over = {}) => ({
  label: '角色狀態',
  contract: '【合同】{"name":"…","state":"…","role":"protagonist|supporting"}',
  decode: (json) => {
    const v = JSON.parse(json);
    return v.name && v.state ? { ok: true, value: v } : { ok: false, message: '缺 name 或 state' };
  },
  mapped: ['role'],
  ...over,
});
const scripted = (...replies) => {
  const seen = [];
  const call = async (messages, label) => {
    seen.push({ messages, label });
    const r = replies.shift();
    if (r instanceof Error) throw r;
    return typeof r === 'string' ? { text: r, stop: 'end' } : r;
  };
  return { call, seen };
};
const GOOD = JSON.stringify({ name: '林昭', state: '左臂受傷，藏在後院', role: 'protagonist' });

describe('features/transcribe.ts · transcribeJson', () => {
  test('原文就是 JSON：不轉，按解碼直接判；判不過照樣不轉', async () => {
    const { call, seen } = scripted();
    const r = await T.transcribeJson(GOOD, spec(), call);
    assert.equal(r.ok, true);
    assert.equal(r.direct, true);
    assert.equal(r.calls, 0);
    const bad = await T.transcribeJson('{"name":"林昭"}', spec(), call);
    assert.deepEqual([bad.ok, bad.message, bad.calls], [false, '缺 name 或 state', 0]);
    assert.equal(seen.length, 0);
  });

  test('不像這一步的輸出：不花轉寫那一次；壞了語法的 JSON 照轉', async () => {
    const { call, seen } = scripted(GOOD);
    const looksLike = (s) => s.includes('當前狀態');
    const r = await T.transcribeJson('我不太確定。', spec({ looksLike }), call);
    assert.deepEqual([r.ok, r.calls, seen.length], [false, 0, 0]);
    const fixed = await T.transcribeJson('{"name":"林昭","state":"左臂受傷，藏在後院",', spec({ looksLike }), call);
    assert.equal(fixed.ok, true);
    assert.equal(seen.length, 1);
  });

  test('照抄：一次過，「無」換成空的，交回規範化的 JSON；轉寫只帶合同與原文', async () => {
    const { call, seen } = scripted(`好的：${JSON.stringify({ name: '林昭', state: '左臂受傷，藏在後院', role: 'protagonist', note: '無' })}`);
    const r = await T.transcribeJson(SOURCE, spec(), call);
    assert.equal(r.ok, true);
    assert.equal(r.calls, 1);
    assert.equal(r.value.note, '');
    assert.equal(JSON.parse(r.json).state, '左臂受傷，藏在後院');
    assert.equal(seen[0].label, '角色狀態轉寫成 JSON');
    assert.ok(seen[0].messages[0].content.includes('格式轉寫員'));
    assert.ok(seen[0].messages[1].content.includes('【合同】') && seen[0].messages[1].content.includes('【原文】\n## 林昭'));
  });

  test('改了字：重轉一次，說清哪幾處；第二次照抄就收下', async () => {
    const { call, seen } = scripted(JSON.stringify({ name: '林昭', state: '左臂重傷，躲在柴房' }), GOOD);
    const r = await T.transcribeJson(SOURCE, spec(), call);
    assert.equal(r.ok, true);
    assert.equal(r.calls, 2);
    assert.ok(seen[1].messages[1].content.includes('【上次轉寫不合格】這幾處不是原文裡的字：「左臂重傷，躲在柴房」'), seen[1].messages[1].content);
    assert.deepEqual(r.notes, ['角色狀態轉寫不合格（這幾處不是原文裡的字：「左臂重傷，躲在柴房」），重轉一次']);
  });

  test('解碼不過、被截斷：重轉一次，還不過交回原因與兩條說明', async () => {
    const { call } = scripted({ text: '{"name":"林昭"', stop: 'maxTokens' }, JSON.stringify({ name: '林昭' }));
    const r = await T.transcribeJson(SOURCE, spec(), call);
    assert.deepEqual([r.ok, r.failed, r.calls, r.message], [false, false, 2, '缺 name 或 state']);
    assert.deepEqual(r.notes, ['角色狀態轉寫不合格（轉寫被輸出上限截斷），重轉一次', '角色狀態重轉仍不合格（缺 name 或 state）']);
  });

  test('retries: 0 只轉一次', async () => {
    const { call } = scripted('不是 JSON');
    const r = await T.transcribeJson(SOURCE, spec({ retries: 0 }), call);
    assert.deepEqual([r.ok, r.calls], [false, 1]);
  });

  test('轉寫呼叫失敗：不往外拋，交回 failed；取消照舊往外拋', async () => {
    const failed = await T.transcribeJson(SOURCE, spec(), scripted(new Error('429 限流')).call);
    assert.deepEqual([failed.ok, failed.failed, failed.calls], [false, true, 1]);
    assert.ok(failed.message.startsWith('轉寫呼叫失敗（'), failed.message);
    await assert.rejects(T.transcribeJson(SOURCE, spec(), scripted(new P.CancelledError()).call), (e) => e instanceof P.CancelledError);
  });
});
