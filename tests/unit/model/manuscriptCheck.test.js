/**
 * 寫完一章之後的幾項確定性檢查與續寫回退點（model/manuscriptCheck.ts，五期補遺 §1）。
 *
 * - 比喻詞按三個詞合計數，說明裡逐個列；
 * - 拉丁字母縮寫：兩個以上大寫字母連寫才算，全形折成半形，去重；
 * - 「本章不出場」：後面幾章才排到的人，本章與前面排過的不算；
 * - 提前登場：名字或兩個字以上的別名出現了，引那一句；
 * - 回退點：與鉤子最像的那一段起切；找不到切最後約四分之一；至少留一半；只有一段不切。
 * - 找位置（內建編輯器的寫作體檢也打包這幾個）：`locateTerms` 每個詞各找各的、不重疊，與 `split` 數的一樣多
 *   （計數都建在它上面）；`foldCase` 只折拉丁字母、長度不變；`latinAcronymRanges` 每一處都給、位置是原文的。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const m = loadModule('src/core/model/manuscriptCheck.ts');

describe('manuscriptCheck · 比喻詞', () => {
  test('三個詞合計', () => {
    assert.equal(m.countSimiles('彷彿一場夢。猶如隔世。宛如新生，彷彿未醒。'), 4);
    assert.equal(m.countSimiles('沒有比喻。'), 0);
  });

  test('說明裡逐個列，0 次的不列', () => {
    assert.equal(m.describeSimiles('彷彿，彷彿，宛如'), '「彷彿」2 次、「宛如」1 次');
  });
});

describe('manuscriptCheck · 對白佔比', () => {
  test('帶引號的段佔全部段的比例', () => {
    assert.equal(m.dialogueShare('他走了。\n\n“站住。”\n\n她說：「別走」。\n\n雨停了。'), 0.5);
  });

  test('沒有段時不提醒', () => {
    assert.equal(m.dialogueShare(''), 1);
  });
});

describe('manuscriptCheck · 停在半句', () => {
  test('結尾不是句末標點就算停在半句', () => {
    assert.equal(m.endsMidSentence('他已經到了極限，全身'), true);
    assert.equal(m.endsMidSentence('他已經到了極限，全身，'), true);
  });

  test('句號、問歎號、省略號、收引號、破折號收尾都不算；末尾空白先去掉', () => {
    for (const t of ['走了。', '走了？', '走了！', '走了……', '“走了。”', '「走了」', '他走了——', '走了。\n\n  ']) {
      assert.equal(m.endsMidSentence(t), false, t);
    }
  });

  test('空文字不算', () => {
    assert.equal(m.endsMidSentence(''), false);
    assert.equal(m.endsMidSentence('  \n'), false);
  });
});

describe('manuscriptCheck · 拉丁字母縮寫', () => {
  test('兩個以上大寫字母連寫才算，去重、按出現順序', () => {
    assert.deepEqual(m.latinAcronyms('他的PTSD又發作了，PTSD讓他頭暈，CPU也燒了。'), ['PTSD', 'CPU']);
  });

  test('單個字母、小寫、混寫的單詞不算', () => {
    assert.deepEqual(m.latinAcronyms('A 字頭，ok，iPhone，Hello'), []);
  });

  test('全形字母折成半形', () => {
    assert.deepEqual(m.latinAcronyms('嚴重的ＰＴＳＤ'), ['PTSD']);
  });
});

describe('manuscriptCheck · 找位置（計數都建在它上面）', () => {
  test('每個詞各找各的、從左往右、不重疊；疊在同一段字上的兩個詞各算各的', () => {
    const hits = m.locateTerms('資料庫裡的資料，資料資料', ['資料', '資料庫', '沒有']);
    assert.deepEqual(JSON.parse(JSON.stringify(hits)), [
      { term: '資料', offsets: [0, 5, 8, 10] },
      { term: '資料庫', offsets: [0] },
      { term: '沒有', offsets: [] },
    ]);
  });

  test('同一個詞不重疊：「aaa」裡的「aa」只有一處（與 split 一樣）', () => {
    assert.deepEqual(m.locateTerms('aaaa', ['aa'])[0].offsets, [0, 2]);
    assert.deepEqual(m.locateTerms('aaa', ['aa'])[0].offsets, [0]);
  });

  test('重複的詞各給一份、空串沒有命中、空文字不拋', () => {
    const hits = m.locateTerms('能量能量', ['能量', '', '能量']);
    assert.deepEqual(hits.map((h) => h.offsets), [[0, 2], [], [0, 2]]);
    assert.deepEqual(m.locateTerms(undefined, ['能量'])[0].offsets, []);
  });

  test('與 split 數出來的一樣多（固定樣本 + 隨機 300 段）', () => {
    const alphabet = ['能', '量', '數', '據', 'a', 'b', '，', '仿', '佛'];
    const terms = ['能量', '資料', '量能', 'ab', 'aa', '彷彿', '能'];
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let k = 0; k < 300; k++) {
      const text = Array.from({ length: Math.floor(rand() * 60) }, () => alphabet[Math.floor(rand() * alphabet.length)]).join('');
      const hits = m.locateTerms(text, terms);
      for (const h of hits) {
        assert.equal(h.offsets.length, text.split(h.term).length - 1, `${text} / ${h.term}`);
        for (const at of h.offsets) {
          assert.equal(text.slice(at, at + h.term.length), h.term);
        }
      }
    }
  });

  test('foldCase：英文不分大小寫、全形字母當半形；位置是原文的', () => {
    const text = 'Hello HELLO ｈｅｌｌｏ ＨＥＬＬＯ hello';
    assert.deepEqual(m.locateTerms(text, ['hello'], { foldCase: true })[0].offsets, [0, 6, 12, 18, 24]);
    assert.deepEqual(m.locateTerms(text, ['HeLLo'], { foldCase: true })[0].offsets, [0, 6, 12, 18, 24]);
    // 不折時區分大小寫（禁用詞就是這麼數的）。
    assert.deepEqual(m.locateTerms(text, ['hello'])[0].offsets, [24]);
  });

  test('foldLatin 只折拉丁字母、一個字換一個字', () => {
    const text = 'ABCｘｙｚＸＹＺ能量Ωé';
    const folded = m.foldLatin(text);
    assert.equal(folded, 'abcxyzxyz能量Ωé');
    assert.equal(folded.length, text.length);
  });

  test('countBanned / countSimiles / describeSimiles 的數與 locateTerms 一致', () => {
    const text = '能量湧動，彷彿潮水；能量退去，猶如夢醒，彷彿未醒。';
    assert.deepEqual(m.countBanned(text, ['能量', '神經']), [{ term: '能量', count: 2 }]);
    assert.equal(m.countSimiles(text), 3);
    assert.equal(m.describeSimiles(text), '「彷彿」2 次、「猶如」1 次');
    assert.deepEqual(m.locateSimiles(text).filter((h) => h.offsets.length).map((h) => [h.term, h.offsets]), [
      ['彷彿', [5, 20]],
      ['猶如', [15]],
    ]);
  });

  test('latinAcronymRanges：每一處都給、按出現順序、全形的位置是原文的', () => {
    const text = 'PTSD 與ＰＴＳＤ，還有CPU。';
    assert.deepEqual(JSON.parse(JSON.stringify(m.latinAcronymRanges(text))), [
      { term: 'PTSD', start: 0, end: 4 },
      { term: 'PTSD', start: 6, end: 10 },
      { term: 'CPU', start: 13, end: 16 },
    ]);
    assert.deepEqual(m.latinAcronyms(text), ['PTSD', 'CPU']);
  });
});

describe('manuscriptCheck · 本章不出場', () => {
  test('後面幾章才排到、本章與前面都沒排過的人，按第一次排到的章號', () => {
    const out = m.notYetOnStage({
      self: ['陸燼'],
      previous: [{ no: 1, characters: ['陸燼', '陳婆婆'] }],
      ahead: [
        { no: 5, characters: ['陸瑤', '沈秋'] },
        { no: 4, characters: ['陸燼', '沈秋', '陳婆婆'] },
      ],
    });
    assert.deepEqual(JSON.parse(JSON.stringify(out)), [
      { name: '沈秋', no: 4 },
      { name: '陸瑤', no: 5 },
    ]);
  });

  test('沒有後文就是空的', () => {
    assert.deepEqual(m.notYetOnStage({ self: ['甲'], previous: [], ahead: [] }), []);
  });
});

describe('manuscriptCheck · 提前登場', () => {
  test('名字出現了：引第一次出現的那一句', () => {
    const text = '霧越來越濃。\n\n巷子盡頭站著一個人。是沈秋。他沒有看陸燼。';
    const out = m.findEarlyEntrances(text, [{ name: '沈秋', no: 4 }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, '沈秋');
    assert.equal(out[0].no, 4);
    assert.equal(out[0].quote, '是沈秋。');
  });

  test('別名也認；單字別名不認', () => {
    const text = '“秋哥來了。”有人喊。';
    assert.equal(m.findEarlyEntrances(text, [{ name: '沈秋', no: 4, aliases: ['秋哥'] }]).length, 1);
    assert.equal(m.findEarlyEntrances('秋天到了。', [{ name: '沈秋', no: 4, aliases: ['秋'] }]).length, 0);
  });

  test('沒出現就是空的', () => {
    assert.deepEqual(m.findEarlyEntrances('陸燼獨自走了。', [{ name: '沈秋', no: 4 }]), []);
  });

  // 真實模型試跑：角色圖譜起的名字是「鎮守人（陳道源）」，正文裡寫的是「陳道源」或別名「陳老爺」。
  test('名字帶括號：括號裡外各一截也認', () => {
    assert.deepEqual(m.namesOf('鎮守人（陳道源）', ['陳老爺', '某']), ['鎮守人（陳道源）', '鎮守人', '陳道源', '陳老爺']);
    assert.equal(m.findEarlyEntrances('陳道源坐在太師椅上。', [{ name: '鎮守人（陳道源）', no: 4 }]).length, 1);
  });

  test('本章細綱自己提到的人不算「不出場」（按名字、括號裡外與別名認）', () => {
    const list = [
      { name: '鎮守人（陳道源）', no: 4, aliases: ['陳老爺'] },
      { name: '紅姑', no: 5, aliases: [] },
    ];
    const kept = m.dropMentioned(list, '老客提醒他祠堂裡的陳老爺正在到處搜尋火場裡的漏網之魚。');
    assert.deepEqual(kept.map((x) => x.name), ['紅姑']);
  });
});

// 章末鉤子並進「看點」之後不再按鉤子找收尾那一場，一律從末尾按比例切。
describe('manuscriptCheck · 回退點', () => {
  const para = (ch, n) => ch.repeat(n);

  test('從末尾切約四分之一', () => {
    const text = [para('甲', 400), para('乙', 300), para('丙', 200), para('丁', 100)].join('\n\n');
    const r = m.rewindPoint(text);
    assert.ok(r);
    // 最後兩段 300 字，正好過了四分之一（250）。
    assert.equal(r.paragraphs, 2);
    assert.equal(r.keep, [para('甲', 400), para('乙', 300)].join('\n\n'));
    assert.equal(r.cut, [para('丙', 200), para('丁', 100)].join('\n\n'));
  });

  test('至少留一半', () => {
    const text = [para('甲', 100), para('乙', 400), para('丙', 400)].join('\n\n');
    const r = m.rewindPoint(text);
    assert.ok(r);
    assert.ok(r.keep.length >= r.cut.length);
  });

  test('只有一段：沒法切', () => {
    assert.equal(m.rewindPoint(para('甲', 500)), undefined);
  });

  test('最多切 600 字', () => {
    const text = Array.from({ length: 20 }, (_, i) => para('甲乙丙丁戊己庚辛'[i % 8], 200)).join('\n\n');
    const r = m.rewindPoint(text);
    assert.ok(r);
    assert.equal(r.paragraphs, 3);
  });
});

// 百章實驗：全域要求寫著「嚴禁使用現代科學或心理學詞彙」，正文照樣寫了「能量」33 次——沒人數。
describe('manuscriptCheck · 禁用詞', () => {
  test('文風指南禁用詞表裡括起來的詞', () => {
    assert.deepEqual(m.bannedTerms({ styleBanList: '不使用「不禁」「頓時」“彷彿整個世界”這類套話' }), ['不禁', '頓時', '彷彿整個世界']);
  });

  test('全域要求：只收表禁止的那一個分句裡括起來的詞，要用的詞不收', () => {
    const guidance = '嚴禁使用“系統”“面板”一類詞，情緒須用“驚悸”、“心病”表達；不要寫「眾所周知」。';
    assert.deepEqual(m.bannedTerms({ guidance }), ['系統', '面板', '眾所周知']);
  });

  test('古代、修真一類題材帶上內建的現代說法；都市不帶', () => {
    assert.ok(m.bannedTerms({ genre: '仙俠 凡人流' }).includes('能量'));
    assert.ok(m.bannedTerms({ genre: '歷史' }).includes('神經'));
    assert.deepEqual(m.bannedTerms({ genre: '都市' }), []);
  });

  test('去重；太長的不算詞', () => {
    assert.deepEqual(m.bannedTerms({ styleBanList: '「能量」「這是一句很長很長的話不是詞」', genre: '仙俠' }).filter((t) => t === '能量').length, 1);
    assert.ok(!m.bannedTerms({ styleBanList: '「這是一句很長很長的話不是詞」' }).length);
  });

  test('數幾次，按次數排；說明裡逐個列', () => {
    const list = m.countBanned('能量湧動，神經一跳，能量又散了。', ['神經', '能量', '座標']);
    assert.deepEqual(list, [{ term: '能量', count: 2 }, { term: '神經', count: 1 }]);
    assert.equal(m.describeBanned(list), '「能量」2 次、「神經」1 次');
  });

  test('比喻詞也數「如同」「好似」', () => {
    assert.equal(m.countSimiles('如同死水，好似夢境，恍如隔世，宛若新生。'), 4);
  });
});
