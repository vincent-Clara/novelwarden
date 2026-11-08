/**
 * 「暗設」寫進提示詞的幾條規矩（完善設定，2026-10-19）。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 細綱合同：不揭開就不寫進梗概 / 關鍵事件 / 看點 / 「設定」一節的說明，要鋪墊在敘事線那一節寫一條「埋」（敘事線二期，原來寫進新增伏筆），揭開寫明「揭開：……」 | 細綱進寫正文的上下文，正文看不見暗設，揭開只能從細綱知道 |
 * | 寫細綱、落定細綱、批次拆細綱是同一句 | 第 22 條：幾條路輸出一字不差 |
 * | 大綱合同同一個口徑 | 大綱覆蓋這一章的那幾節也進寫正文的上下文（正文配方的 `outlineSlice`） |
 * | 提示詞指的標記與上下文裡寫的是同一個 | 兩邊各寫一份，改一邊就對不上 |
 * | 建條目 / 整合：暗設原樣留作第四節、≤200 字、不算進 600；正文揭開的挪回明面；建條目不寫暗設 | 第 27 條：條目不能無限膨脹，機器只並不刪作者的字 |
 * | 建條目 / 整合：統稱只寫共通的，具體東西獨有的不寫進來 | 第 27 條：上位概念不能整合成各個具體東西的彙總 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const p = loadModule('src/core/context/prompts.ts');
const lp = loadModule('src/core/features/lorePrompt.ts');
const lf = loadModule('src/core/model/loreFile.ts');

const MARK = '「暗設（讀者還不知道）」';

describe('細綱合同裡的暗設', () => {
  const plot = (capability, facts) => p.buildOutputContract({ stage: 'plot', capability }, facts);

  test('不揭開就別寫進去，要鋪墊在敘事線那一節寫一條「埋」，揭開寫明「揭開：……」', () => {
    const c = plot('generate', { no: 6 });
    assert.ok(c.includes('【暗設】'), c);
    // 角色卡的暗設（敘事線重做第 10 個提交）同一個標題、同一條規矩。
    assert.ok(c.includes(`上面「相關世界觀設定」「相關角色設定」裡標著${MARK}的，是讀者還不知道的真相`), c);
    assert.match(c, /不打算在這一章揭開：別寫進梗概、關鍵事件、看點，設定那一節的說明也不寫/);
    // 敘事線二期：伏筆並進了敘事線，鋪墊的去向從細綱的「新增伏筆」換成敘事線計劃裡的一條「埋」。
    assert.match(c, /要鋪墊，在敘事線那一節寫一條「埋」，只寫讀者看得到的那一面/);
    assert.ok(!c.includes('foreshadowing 是字串陣列'), c);
    assert.match(c, /在關鍵事件裡單列一條「揭開：……」/);
  });

  test('寫細綱、落定細綱、批次拆細綱同一句（第 22 條）', () => {
    const single = plot('generate', { no: 6 });
    assert.equal(plot('settle', { no: 6 }), single);
    const rule = single.slice(single.indexOf('【暗設】')).split('\n\n')[0];
    assert.ok(plot('generate', { range: { from: 6, to: 10 } }).includes(rule));
  });

  test('標記與上下文裡寫的同一個', () => {
    assert.equal(`「${lf.LORE_HIDDEN_MARK}」`, MARK);
  });
});

describe('大綱合同裡的暗設', () => {
  test('哪一章揭開寫明「揭開：……」，之前只寫讀者看得到的那一面', () => {
    const c = p.buildOutputContract({ stage: 'outline', capability: 'generate' }, { range: { from: 1, to: 20 } });
    assert.ok(c.includes(`10. 上面「相關世界觀設定」「相關角色設定」裡標著${MARK}的是讀者還不知道的真相`), c);
    assert.match(c, /打算在哪一章揭開，就在那一章寫明「揭開：……」/);
    assert.match(c, /揭開之前的各章只寫讀者看得到的那一面/);
    assert.match(c, /11\. 只輸出情節大綱本身/);
  });
});

describe('建條目與整合的提示詞', () => {
  const s = lp.LORE_ENTRY_SYSTEM;

  test('600 字只指明面三節', () => {
    assert.match(s, /這三節合計不超過 600 字/);
  });

  test('暗設原樣留作第四節、200 字以內、不算進 600', () => {
    assert.match(s, /現有條目可能帶第四節「## 暗設」/);
    assert.match(s, /原樣保留為第四節（200 字以內，不算進上面的 600 字）/);
  });

  test('正文揭開的挪進前三節，沒揭開的不改；建條目不寫暗設；不進一句話與關鍵詞', () => {
    assert.match(s, /記錄表明正文已經揭開了其中某件事，就把它挪進前三節、從暗設裡刪掉/);
    assert.match(s, /沒揭開的一個字不改/);
    assert.match(s, /沒有現有條目、或現有條目沒有這一節時，不寫暗設/);
    assert.match(s, /暗設裡的東西不寫進一句話與關鍵詞/);
  });

  // 2026-10-25 外部報告：「秘境」那一條整合成了各個具體秘境規則與現狀的彙總。
  test('統稱只寫共通的，具體東西獨有的不寫進來；現有的照第 3 條不刪', () => {
    assert.match(s, /5\. 它是一個統稱（概念、類別，底下有一個個叫得出名字的具體地方、物品、組織）時，只寫它們共通的規矩與整體的樣子/);
    assert.match(s, /某一個具體的東西獨有的規則、經過、現狀不寫進來/);
    assert.match(s, /現有條目裡已經有的照第 3 條不刪/);
    assert.match(s, /3\. 給了「現有條目」時，那是作者認可過的內容/);
  });
});
