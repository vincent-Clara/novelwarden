/**
 * 百章實驗覆盤寫進提示詞的幾條約束：大綱一章一條、終局級事件只發生一次、境界有變化寫明；細綱以既成事實為準；
 * 摘要記境界變化與毀掉的東西；正文以定稿事實為準。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const p = loadModule('src/core/context/prompts.ts');
const sp = loadModule('src/core/features/summarizePrompt.ts');

describe('長篇約束 · 提示詞', () => {
  test('大綱：一章一條、終局級事件只發生一次、境界有變化的那一章寫明', () => {
    const c = p.buildOutputContract({ stage: 'outline', capability: 'generate' }, { range: { from: 1, to: 20 } });
    assert.match(c, /嚴格使用「## 第N章：標題」的格式/);
    assert.match(c, /不要寫成「## 第a–b章」把幾章合成一節/);
    assert.match(c, /這幾章一章一條，一條都不能少/);
    assert.match(c, /終局級事件.*全書只發生一次：寫明發生在哪一章/);
    assert.match(c, /主角境界或關鍵資源有變化的那一章寫明變成什麼/);
  });

  test('細綱（非開篇）：前面定稿的事實是既成歷史，終局級事件不再排', () => {
    const c = p.buildOutputContract({ stage: 'plot', capability: 'generate' }, { range: { from: 6, to: 10 } });
    assert.match(c, /既成歷史/);
    assert.match(c, /不得再排一次/);
    const first = p.buildOutputContract({ stage: 'plot', capability: 'generate' }, { range: { from: 1, to: 5 } });
    assert.doesNotMatch(first, /既成歷史/);
  });

  test('摘要：境界變化、毀掉的東西都記進連續性事實', () => {
    assert.match(sp.SUMMARY_SYSTEM, /境界、等級或能力在本章有變化/);
    assert.match(sp.SUMMARY_SYSTEM, /已經毀掉的地方、陣法、法寶也要記/);
  });
});

describe('長篇約束 · 本章邊界裡的禁用詞', () => {
  test('第一次呼叫：點名不許用的詞', () => {
    const c = p.buildOutputContract({ stage: 'manuscript', capability: 'generate' }, { banned: ['能量', '神經'] });
    assert.match(c, /- 禁用詞：「能量」「神經」一個都不用/);
  });

  test('續寫那一輪：說清已經用了哪幾個、幾次', () => {
    const step = { kind: 'continuation', tail: '……', written: 700, recovery: false, banned: [{ term: '能量', count: 2 }] };
    const c = p.buildOutputContract({ stage: 'manuscript', capability: 'generate' }, { banned: ['能量'], step });
    assert.match(c, /- 禁用詞：已寫部分用了「能量」2 次，續寫部分不許再用/);
  });

  test('比喻詞上限把「如同」也算進去', () => {
    assert.ok(p.ANTI_AI_RULES.some((r) => r.includes('「如同」') && r.includes('全章合計不超過 3 次')));
  });
});

// 敘事線二期（設計稿「二」）：細綱照著線排，計劃寫進每章的敘事線那一節（轉寫成 threads）；原來那句「伏筆強制回收與釋放」並進這一條。
describe('長篇約束 · 細綱合同裡的敘事線', () => {
  const plot = (capability, facts) => p.buildOutputContract({ stage: 'plot', capability }, facts);

  test('批次：照著「敘事線」排，標著「本批要收」/「已過第 N 章」的必須在本批收，收不了寫明推遲到第幾章', () => {
    const c = plot('generate', { range: { from: 6, to: 10 } });
    assert.ok(c.includes('【敘事線】'), c);
    assert.match(c, /標著「本批要收」或「已過第 N 章，還沒收」的伏筆，必須安排在本批某一章「收」/);
    assert.match(c, /寫明「〈伏筆名〉推遲到第 N 章收」和為什麼/);
    assert.match(c, /前面章節留下的危機，這裡該引爆或解決的要引爆或解決/);
    assert.doesNotMatch(c, /伏筆強制回收/);
  });

  // 復跑之後：模型只排「推進」，到期該埋的三條一條也沒排；給沒到期的伏筆寫了「推遲」；另起了一條換了名字的新伏筆。
  test('批次：標著「本批要埋」/「還沒埋」的必須在本批埋；收只能排在埋之後；推遲只給要埋、要收的用；已有的伏筆不另起', () => {
    const c = plot('generate', { range: { from: 6, to: 10 } });
    assert.match(c, /標著「本批要埋」或「還沒埋」的伏筆，必須安排在本批某一章「埋」/);
    assert.match(c, /寫明「〈伏筆名〉推遲到第 N 章埋」和為什麼/);
    assert.match(c, /「收」只能排在「埋」之後/);
    assert.match(c, /「推遲到第 N 章」只給上面標著要埋、要收的伏筆用；沒標的伏筆不寫推遲/);
    assert.match(c, /上面已經有的伏筆不要換個名字再起一條新的/);
    assert.match(plot('generate', { no: 6 }), /標著「本章要埋」或「還沒埋」的伏筆，必須安排在本章「埋」/);
  });

  test('單章與落定說「本章」，一字不差（第 22 條）', () => {
    const single = plot('generate', { no: 6 });
    assert.match(single, /標著「本章要收」或「已過第 N 章，還沒收」的伏筆，必須安排在本章「收」/);
    assert.match(single, /照著排，並把本章在敘事線上計劃發生的事寫在「### 敘事線」小標題下：/);
    assert.equal(plot('settle', { no: 6 }), single);
  });

  // 細綱試點（2026-10-25）：寫細綱的模型按小標題寫，不寫 JSON；JSON 合同挪給轉寫那一步。
  test('輸出格式：九個小標題，敘事線五種型別、一章最多 6 條，埋新伏筆寫明第幾章前收；不寫 JSON', () => {
    const c = plot('generate', { range: { from: 6, to: 10 } });
    assert.match(c, /每章下面依次是這九個小標題，一個都不能少，哪一節沒有內容就寫「無」：梗概、出場人物、時間地點、關鍵事件、看點、狀態變更、敘事線、新角色、設定。/);
    assert.match(c, /- 敘事線：本章在敘事線上的計劃，一條一行、行首寫「- 」，最多 6 條。每條寫清：哪條線（照抄線名）；是推進、關係、收束（這條線走完了）、埋、收哪一種/);
    assert.match(c, /埋一條新伏筆再寫明計劃第幾章前收/);
    assert.match(c, /不寫 JSON。/);
    assert.doesNotMatch(c, /\{"blueprints"/);
  });

  test('轉寫合同：threads 五種型別，foreshadowing 只在埋、收時給，resolve 只在原文寫了時給；文字一律照抄', () => {
    const c = p.blueprintJsonContract({ from: 6, to: 10 });
    assert.match(c, /threads：「敘事線」一節，一條一項 \{"line":"線名","type":"推進\|關係\|收束\|埋\|收","foreshadowing":"伏筆名","what":"這一章在這條線上發生什麼","resolve":N\}/);
    assert.match(c, /foreshadowing 只在埋、收時給；resolve 只在原文寫了第幾章前收時給/);
    assert.match(c, /文字一律從原文照抄：不改寫、不總結、不潤色/);
    assert.match(c, /原文寫的是第 6–10 章，一章一項/);
  });
});
