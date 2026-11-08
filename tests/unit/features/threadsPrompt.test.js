/**
 * 敘事線四段系統提示裡，2026-10-21 真實模型試跑之後補上的幾句（設計稿「實施狀態（試跑之後的修復）」）。提示詞的效果只能靠
 * 真實模型試，這裡只釘住「這幾句還在」：改提示詞時別把它們抹掉。
 *
 * | 斷言 | 試跑裡看到的 |
 * |---|---|
 * | 認事件講清什麼算伏筆、什麼不算；上限跟著常量走 | 22 條新伏筆多半是章末危機、本章已經揭開的事、普通情節 |
 * | 證據要直接寫出這件事本身 | 證據句在正文裡有，卻和它要證明的事不沾邊 |
 * | 當前進度只照抄【線】後面的名字 | 「名字（種類）」照抄回來，22 條只落盤 1 條 |
 * | 歸併只有同一件事才並，同一個物件 / 同一個人身上的兩件事不算 | 約一半並錯 |
 * | 排線：有感情發展、成長或墮落弧線的分別排成感情線、人物線 | 沒有感情線、漏了一條現成的人物線 |
 *
 * 2026-10-24 一份 80 多章真實工程的報告之後補的：
 *
 * | 斷言 | 報告裡看到的 |
 * |---|---|
 * | 當前進度按【人物】的性別寫人稱，原來寫錯的改過來；【人物】是寫了性別的卡裡的主角與出現過名字的人 | 女主角的當前進度一路寫成「他」 |
 * | 認事件：只圍著一件事轉的線，那件事揭開了另報「收束」 | 第 7 章只報了「收〈伏筆〉」，線掛了「斷了 75 章」 |
 * | 認事件：收束、放棄時把掛在線上的的伏筆收掉或棄掉 | 「已收束 · 1 條伏筆沒收」 |
 * | 認事件：什麼不算新線（一章內的事、連著幾章的同一場比試、路人閒聊），拿不準不報 | 路人一句閒聊、一場比試拆成兩條都立成了線 |
 * | 認事件：收、棄未歸屬的伏筆時線名寫它屬於哪條線（程式據此挪過去） | 第 53 章埋下沒掛上線，第 61 章導師揭開了，仍留在未歸屬裡 |
 *
 * 2026-10-25 起改成轉寫（四段都按格式寫自然語言，轉寫模型照各自的合同照抄成原來那份 JSON）：
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 四段都不再要 JSON（沒有「只輸出一個 JSON 物件」、英文欄位名），各有格式與示例 | 作者實測要模型直接出 JSON 寫出來的東西更差 |
 * | 認事件：證據用「」引出正文原句 | 轉寫照抄，之後照舊由 verifyFinds 對正文逐字核 |
 * | 四份轉寫合同：形狀正好是原來解碼認的那一份，種類 / 型別怎麼對、證據一個字都不能改 | 解碼一行沒改 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const mod = () => loadModule('src/core/features/threadsPrompt.ts');
const tf = () => loadModule('src/core/model/threadFile.ts');

describe('threadsPrompt.ts · 試跑之後補上的幾句', () => {
  test('認事件：什麼算伏筆、什麼不算；證據要直接寫出這件事；上限跟著常量走（新伏筆 3 條）', () => {
    const { THREAD_FIND_SYSTEM } = mod();
    for (const s of [
      '讀者看見了、還沒得到解釋或交代、後文要回收的線索、疑問或承諾',
      '章末懸念、章末的危機（那是看點',
      '本章內已經揭開、交代清楚的事（揭開的是給出的伏筆，就報一條「收」）',
      '單純發生了的事件',
      '證據必須直接寫出這件事本身',
      '「他」不要換成人名',
      '給出的伏筆已經埋下的不要再報「埋」',
      // 復跑之後：「計劃」狀態的伏筆第 1 章就被報了「收」。
      '還沒埋下的伏筆不能直接報「收」「棄」',
    ]) {
      assert.ok(THREAD_FIND_SYSTEM.includes(s), s);
    }
    const { FINALIZE_EVENT_LIMIT, FINALIZE_NEW_THREAD_LIMIT, FINALIZE_NEW_FORESHADOW_LIMIT } = tf();
    assert.equal(FINALIZE_NEW_FORESHADOW_LIMIT, 3);
    assert.ok(
      THREAD_FIND_SYSTEM.includes(`事件最多 ${FINALIZE_EVENT_LIMIT} 條，新線最多 ${FINALIZE_NEW_THREAD_LIMIT} 條，新伏筆最多 3 條`),
      THREAD_FIND_SYSTEM.slice(-80)
    );
  });

  test('當前進度：線名只照抄【線】後面的名字，不帶種類', () => {
    const { THREAD_PROGRESS_SYSTEM } = mod();
    assert.ok(THREAD_PROGRESS_SYSTEM.includes('每條線以「【線】線名」開頭'));
    assert.ok(THREAD_PROGRESS_SYSTEM.includes('線名只照抄【線】後面那個名字，一字不改：不帶種類，不加括號、引號或別的字'));
  });

  test('認事件：線的事揭開了就收束；收束時收掉或棄掉掛在線上的的伏筆；什麼不算新線', () => {
    const { THREAD_FIND_SYSTEM } = mod();
    for (const s of [
      '那件事在本章揭開了，線也就走完了：「收」那條伏筆之外，另報一條「收束」',
      '報一條線「收束」「放棄」時，把【還沒收的伏筆】裡掛在這條線上的逐條看一遍',
      '正文讓它跟著這條線一起作廢了的（例如那一整段經歷原來是幻覺）報「棄」',
      '什麼算新線：一件要跨很多章才走得完的事',
      '一章之內就開始又結束的事',
      '換了人上場也還是同一件事',
      '路人、龍套的閒聊',
      '拿不準是不是新線，就不要報',
      '收、棄一條掛在「未歸屬的伏筆」上的伏筆時，線名寫它在本章揭開時屬於給出的哪一條線',
    ]) {
      assert.ok(THREAD_FIND_SYSTEM.includes(s), s);
    }
  });

  test('當前進度：人稱照【人物】的性別寫，原來寫錯的改過來', () => {
    const { THREAD_PROGRESS_SYSTEM } = mod();
    assert.ok(THREAD_PROGRESS_SYSTEM.includes('人稱照那裡寫的性別：女的用「她」，男的用「他」；原來的當前進度裡用錯了的，這一次改過來'));
  });

  test('歸併：只有確實是同一件事才並；同一個物件、同一個人身上的兩件事不算；拿不準不併', () => {
    const { THREAD_MERGE_SYSTEM } = mod();
    for (const s of ['只有確實是同一件事、同一條線，才並進已有的那一條', '同一個物件、同一個人身上的兩件事不算同一件事', '拿不準就不要並', '兩條共同指向的那一個謎底或那一件事']) {
      assert.ok(THREAD_MERGE_SYSTEM.includes(s), s);
    }
    // 復跑之後：並錯的兩次理由都是「兩者均指……」——同一類，不是同一件事。
    for (const s of ['只是同一類的不算', '理由必須說出兩條共同指向的那一個謎底或那一件事', '「兩者均指向……」這種同一類的，就是不該並']) {
      assert.ok(THREAD_MERGE_SYSTEM.includes(s), s);
    }
  });

  test('排線：有感情發展、成長或墮落弧線的分別排成感情線、人物線，沒有就不湊數', () => {
    const { threadPlanSystem } = mod();
    assert.ok(threadPlanSystem(30, false).includes('故事裡有感情發展、主角明顯的成長或墮落弧線的，分別排成感情線、人物線；沒有就不湊數。'));
  });
});

describe('threadsPrompt.ts · 2026-10-25 起按格式寫、轉寫成 JSON', () => {
  const systems = () => {
    const m = mod();
    return { 排線: m.threadPlanSystem(30, false), 認事件: m.THREAD_FIND_SYSTEM, 当前进度: m.THREAD_PROGRESS_SYSTEM, 歸併: m.THREAD_MERGE_SYSTEM };
  };

  test('四段都不再要 JSON：沒有 JSON 形狀與英文欄位名，各有【輸出格式】與【格式示例】、說不寫 JSON', () => {
    for (const [name, s] of Object.entries(systems())) {
      assert.ok(!s.includes('只輸出一個 JSON 物件') && !s.includes('{"') && !/"(?:threads|events|progress|merges)"/.test(s), `${name}：${s.slice(0, 400)}`);
      assert.ok(s.includes('【輸出格式】') && s.includes('【格式示例】') && s.includes('不寫 JSON'), name);
    }
  });

  test('排線：一條線一段「## 線名」，種類、章節、意圖、伏筆（第 N 章埋，第 M 章前收）；章號範圍跟著總章數', () => {
    const s = mod().threadPlanSystem(30, true);
    for (const x of ['以「## 線名」開頭', '種類：主線、支線、感情線、人物線之一', '寫成「第 3 章—第 40 章」', '（第 N 章埋，第 M 章前收）', '1–30 之間的整數', '已經有了，這一次不要再排主線', '每條線最多 5 條伏筆']) {
      assert.ok(s.includes(x), x);
    }
  });

  test('認事件：三節「## 事件」「## 新線」「## 新伏筆」，一條一行「型別｜線名：……。證據：「正文原句」」，證據用「」引起來', () => {
    const s = mod().THREAD_FIND_SYSTEM;
    for (const x of ['「## 事件」「## 新線」「## 新伏筆」', '「型別｜線名：發生了什麼。證據：「正文原句」」', '「埋〈伏筆名〉」', '證據一律用「」引起來', '哪一節沒有就寫「無」']) {
      assert.ok(s.includes(x), x);
    }
  });

  test('當前進度一段「【線】線名」「當前進度：……」；歸併一行「新 → 已有：理由」，一條都不併寫「無」', () => {
    const m = mod();
    assert.ok(m.THREAD_PROGRESS_SYSTEM.includes('第一行「【線】線名」，第二行「當前進度：……」（150 字以內）'));
    assert.ok(m.THREAD_MERGE_SYSTEM.includes('「新認出的名字 → 已有的名字：兩條共同指向的那一個謎底或那一件事」'));
    assert.ok(m.THREAD_MERGE_SYSTEM.includes('一條都不該並就只寫「無」'));
  });

  test('四份轉寫合同：形狀是原來那一份；種類、型別只能是那幾個詞；證據一個字都不能改；文字照抄', () => {
    const m = mod();
    const plan = m.threadPlanJsonContract();
    assert.ok(plan.includes('{"threads":[{"title":"…","kind":"感情线","from":3,"to":18,"intent":"…","foreshadowing":[{"title":"…","what":"…","plant":3,"resolve":18}]}]}'), plan);
    assert.ok(plan.includes('只能是主線、支線、感情線、人物線這四個詞之一'), plan);
    const find = m.threadFindJsonContract();
    assert.ok(find.includes('{"events":[...],"newThreads":[...],"newForeshadowing":[...]}') && find.includes('只能是推進、關係、收束、放棄、埋、收、棄之一'), find);
    assert.ok(find.includes('不帶最外面那一對「」；一個字都不能改、不能補、不能刪'), find);
    assert.ok(m.threadProgressJsonContract().includes('{"progress":[{"line":"…","text":"…"}]}'));
    assert.ok(m.threadMergeJsonContract().includes('{"merges":[{"new":"…","into":"…","reason":"…"}]}'));
    for (const c of [plan, find, m.threadProgressJsonContract(), m.threadMergeJsonContract()]) {
      assert.ok(c.includes('文字一律從原文照抄：不改寫、不總結、不潤色') && c.includes('寫「無」或沒有這一項的：文字給 ""，列表給 []'), c);
    }
  });
});

describe('threads.ts · 當前進度的【人物】', () => {
  const card = (name, extra = {}) => ({ name, aliases: [], tags: [], sections: {}, ...extra });
  const people = (cards, text) => loadModule('src/core/features/threads.ts').progressPeople(cards, text);

  test('寫了性別的：主角在前（名字沒出現也在），其餘名字或別名出現過才列；帶別名', () => {
    const cards = [
      card('沈青', { gender: '男' }),
      card('林昭', { gender: '女', tags: ['主角'], aliases: ['小昭'] }),
      card('李叔', { gender: '男' }),
      card('阿婆', { aliases: ['婆婆'] }),
      card('柳', { gender: '女' }),
    ];
    const text = '【線】沈家舊案\n原來的當前進度：讀者已知他已身處局內，婆婆不肯說，柳樹下埋著東西。';
    assert.deepEqual(people(cards, text), ['- 林昭（女；又稱 小昭）']);
    assert.deepEqual(people(cards, `${text}沈青追問李叔。`), ['- 林昭（女；又稱 小昭）', '- 沈青（男）', '- 李叔（男）']);
    assert.deepEqual(people([], text), []);
  });
});
