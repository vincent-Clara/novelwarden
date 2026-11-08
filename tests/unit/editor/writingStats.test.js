/**
 * 碼字統計的純邏輯（`media/src/editor/writingStats.ts`，零 DOM）與字數口徑（`media/src/editor/words.ts`）。
 * 狀態列、面板、localStorage 那一整條鏈路在 tests/dom/standalone/stats.test.js，這裡釘口徑：
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | `countWords` 與 core 對拍 | 編輯器一趟迴圈的寫法與後端正則的寫法一字不差（狀態列要與工程頁對得上） |
 * | `wordDelta` | 只數改動那一段，等於前後各數一遍全文再相減（英文詞被接長、劈開、並起來都對） |
 * | 哪些算碼字 | 打字、輸入法上屏算；貼上、程式改寫、組字中途、撤銷重做不在這裡算 |
 * | `StepLedger` | 撤銷自己打的字減回去、重做加上；撤銷貼上不動 |
 * | 時長 | 停筆不超過 2 分鐘的那段才算，記在後一下落筆的檔案上，各檔案加起來等於總數 |
 * | 速度、目標、時長的說法 | 不到 1 分鐘不報速度；還差 / 超出 / 正好；八成換色 |
 * | 標題行 | 章節開頭的 `# 標題` 不算字，與 core `stripH1` 同一條規則 |
 * | 今日碼字 | 本地日期、跨午夜、壞值回落、多視窗只加增量、只留 30 天 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const {
  IDLE_MS,
  MIN_SPEED_MS,
  DAILY_KEEP,
  StepLedger,
  WritingSession,
  addDaily,
  bumpDaily,
  countsAsWriting,
  dayKey,
  formatDuration,
  goalProgress,
  headingWords,
  isWritingActivity,
  parseDaily,
  serializeDaily,
  signedWords,
  speedPerHour,
  wordDelta,
} = loadModule('media/src/editor/writingStats.ts');
const { countWords, groupDigits } = loadModule('media/src/editor/words.ts');
const { EditHistory, diffText } = loadModule('media/src/editor/history.ts');
const core = loadModule('src/core/model/fs.ts');
const { stripH1 } = loadModule('src/core/model/markdown.ts');

/** 可復現的偽隨機（mulberry32）。 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 各種會讓字數口徑出岔子的字元：漢字（含擴充套件 A）、英文、數字、撇號、空白、中英文標點、全形字母、emoji。 */
const ALPHABET = ['林', '昭', '雨', '㐀', 'a', 'B', 'z', '9', "'", ' ', '\n', '\r', '\t', '　', '，', '。', '"', '-', 'Ａ', '😀', '_'];
function randomText(rand, len) {
  let s = '';
  for (let i = 0; i < len; i++) {
    s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  }
  return s;
}

describe('countWords：與 core 一字不差', () => {
  const samples = [
    '',
    '林昭推開門，雨下了三天。',
    'He said "OK" 3 times, it\'s fine.',
    '第3章 He走了。',
    '㐀㐁 擴充套件A區也算',
    'ＡＢＣ全形字母不算詞',
    '😀 emoji 不算字',
    'line1\r\nline2\n\n　　段首縮排',
    "don't won't  rock'n'roll",
  ];
  for (const text of samples) {
    test(`「${text.slice(0, 16).replace(/\s/g, '·')}」`, () => {
      assert.equal(countWords(text), core.countWords(text));
    });
  }

  test('隨機拼出來的 300 段也一樣', () => {
    const rand = rng(7);
    for (let i = 0; i < 300; i++) {
      const text = randomText(rand, 1 + Math.floor(rand() * 60));
      assert.equal(countWords(text), core.countWords(text), JSON.stringify(text));
    }
  });
});

describe('wordDelta：只數改動那一段', () => {
  /** 把一處改動套到 before 上，返回改動之後的全文與 wordDelta。 */
  const apply = (before, at, removed, inserted) => {
    assert.equal(before.slice(at, at + removed.length), removed, '夾具寫錯了');
    const after = before.slice(0, at) + inserted + before.slice(at + removed.length);
    return { after, delta: wordDelta(after, { at, removed, inserted }) };
  };
  const exact = (before, at, removed, inserted) => {
    const { after, delta } = apply(before, at, removed, inserted);
    assert.equal(delta, countWords(after) - countWords(before), JSON.stringify({ before, at, removed, inserted }));
    return delta;
  };

  test('打中文：一個字一個', () => {
    assert.equal(exact('林昭推開門。', 5, '', '，雨下了'), 3);
  });

  test('英文詞中間再打一個字母：詞數不變', () => {
    assert.equal(exact('hello world', 2, '', 'x'), 0);
  });

  test('詞中間打一個空格：一個詞劈成兩個', () => {
    assert.equal(exact('helloworld', 5, '', ' '), 1);
  });

  test('刪掉兩個詞之間的空格：併成一個', () => {
    assert.equal(exact('hello world', 5, ' ', ''), -1);
  });

  test('退格刪字：倒扣', () => {
    assert.equal(exact('林昭推開門。', 3, '開門', ''), -2);
  });

  test('打字蓋掉選區：刪掉的扣、打的加', () => {
    assert.equal(exact('林昭推開門。', 0, '林昭', 'Lin Zhao'), 0);
    assert.equal(exact('林昭推開門。', 2, '推開門', '走'), -2);
  });

  test('文首、文末、空檔案', () => {
    assert.equal(exact('', 0, '', '雨夜'), 2);
    assert.equal(exact('abc', 0, '', 'x'), 0);
    assert.equal(exact('abc', 3, '', ' d'), 1);
  });

  test('隨機的 500 處改動：都等於前後各數一遍全文再相減', () => {
    const rand = rng(42);
    for (let i = 0; i < 500; i++) {
      const before = randomText(rand, Math.floor(rand() * 40));
      const at = Math.floor(rand() * (before.length + 1));
      const len = Math.floor(rand() * (before.length - at + 1));
      exact(before, at, before.slice(at, at + len), randomText(rand, Math.floor(rand() * 6)));
    }
  });
});

describe('哪些改動算碼字', () => {
  const change = { at: 0, removed: '', inserted: '林' };

  test('鍵盤打字、輸入法上屏（帶 change）算', () => {
    assert.equal(countsAsWriting('typing', change), true);
    assert.equal(countsAsWriting('composition', change), true);
  });

  test('組字中途（不帶 change）不算字，但算「在寫」', () => {
    assert.equal(countsAsWriting('composition', undefined), false);
    assert.equal(isWritingActivity('composition'), true);
  });

  test('名詞補全裡挑的名字補上的字算（⚑ 與輸入法挑候選詞同理），也算「在寫」', () => {
    assert.equal(countsAsWriting('completion', change), true);
    assert.equal(isWritingActivity('completion'), true);
  });

  test('貼上 / 剪下 / 拖放、程式改寫、撤銷重做都不按「打的字」算', () => {
    for (const source of ['input', 'program', 'undo', 'redo']) {
      assert.equal(countsAsWriting(source, change), false, source);
      assert.equal(isWritingActivity(source), false, source);
    }
  });
});

describe('StepLedger：撤銷 / 重做跟著那一步走', () => {
  /** 用真的 EditHistory 走一遍：記一步（或並進去），再讓賬本看棧頂。 */
  function harness() {
    const history = new EditHistory();
    const ledger = new StepLedger();
    let text = '';
    let t = 0;
    const edit = (next, words, opts = {}) => {
      const change = diffText(text, next, next.length);
      history.record(change, { start: text.length, end: text.length }, { start: next.length, end: next.length }, { now: (t += 100), ...opts });
      text = next;
      ledger.afterEdit(history.topId, words);
    };
    const undo = () => {
      text = history.undo(text).text;
      return ledger.afterUndo(history.topId);
    };
    const redo = () => {
      text = history.redo(text).text;
      return ledger.afterRedo(history.topId);
    };
    return { history, edit, undo, redo, text: () => text };
  }

  test('撤銷一次貼上：碼字數不動；再撤銷自己打的字：減回去', () => {
    const h = harness();
    h.edit('林昭', 2, { merge: true });
    h.edit('林昭推開門', 0); // 貼上：不計入
    assert.equal(h.undo(), 0);
    assert.equal(h.undo(), -2);
    assert.equal(h.text(), '');
  });

  test('重做：自己打的加回來，貼上的還是不算', () => {
    const h = harness();
    h.edit('林昭', 2, { merge: true });
    h.edit('林昭推開門', 0);
    h.undo();
    h.undo();
    assert.equal(h.redo(), 2);
    assert.equal(h.redo(), 0);
  });

  test('連續打字併成一步：撤銷一次退掉整串的字數', () => {
    const h = harness();
    h.edit('林', 1, { merge: true });
    h.edit('林昭', 1, { merge: true });
    h.edit('林昭來', 1, { merge: true });
    assert.equal(h.history.size, 1);
    assert.equal(h.undo(), -3);
  });

  test('程式改寫並進剛打的那一步（成對符號補的後半個）：那一步的字數不變', () => {
    const h = harness();
    h.edit('“林', 1, { merge: true });
    h.edit('“林”', 0, { join: true });
    assert.equal(h.undo(), -1);
  });

  test('賬本開始之前就有的步（重新開始計時之前打的）：撤銷不動這次的數', () => {
    const history = new EditHistory();
    history.record({ at: 0, removed: '', inserted: '林昭' }, { start: 0, end: 0 }, { start: 2, end: 2 });
    const ledger = new StepLedger();
    history.undo('林昭');
    assert.equal(ledger.afterUndo(history.topId), 0);
    history.redo('');
    assert.equal(ledger.afterRedo(history.topId), 0);
  });
});

describe('本次碼字：時長只算在寫的那段', () => {
  test('第一下落筆不算時長；之後兩下之間不超過 2 分鐘的那段算', () => {
    const s = new WritingSession(0);
    assert.equal(s.touch('a.md', 'A', 1_000), 0);
    assert.equal(s.touch('a.md', 'A', 31_000), 30_000);
    assert.equal(s.touch('a.md', 'A', 31_000 + IDLE_MS), IDLE_MS, '正好 2 分鐘還算');
    assert.equal(s.ms, 30_000 + IDLE_MS);
  });

  test('停筆超過 2 分鐘：那一段整個不算，回來之後接著算', () => {
    const s = new WritingSession(0);
    s.touch('a.md', 'A', 0);
    assert.equal(s.touch('a.md', 'A', IDLE_MS + 1), 0);
    assert.equal(s.touch('a.md', 'A', IDLE_MS + 10_001), 10_000);
    assert.equal(s.ms, 10_000);
  });

  test('兩下落筆之間的那段記在後一下的檔案上，各檔案加起來等於總數', () => {
    const s = new WritingSession(0);
    s.touch('a.md', 'A', 0);
    s.touch('b.md', 'B', 20_000);
    s.touch('a.md', 'A', 50_000);
    assert.equal(s.files.get('a.md').ms, 30_000);
    assert.equal(s.files.get('b.md').ms, 20_000);
    assert.equal(s.ms, 50_000);
  });

  test('時鐘往回呼不倒扣、也不憑空多出一段', () => {
    const s = new WritingSession(0);
    s.touch('a.md', 'A', 100_000);
    assert.equal(s.touch('a.md', 'A', 50_000), 0);
    assert.equal(s.touch('a.md', 'A', 110_000), 10_000);
  });

  test('字數按檔案分別記、彙總；明細按字數排；改名跟著走', () => {
    const s = new WritingSession(0);
    s.add('a.md', '第 1 章', 30);
    s.add('b.md', '第 2 章', 120);
    s.add('a.md', '第 1 章', -5);
    assert.equal(s.words, 145);
    assert.deepEqual(s.breakdown().map((f) => [f.path, f.words]), [['b.md', 120], ['a.md', 25]]);
    s.rename('a.md', 'c.md');
    assert.deepEqual([...s.files.keys()].sort(), ['b.md', 'c.md']);
    assert.equal(s.files.get('c.md').words, 25);
  });

  test('改名到一個已經有明細的路徑：並進去', () => {
    const s = new WritingSession(0);
    s.add('a.md', 'A', 10);
    s.add('b.md', 'B', 5);
    s.rename('a.md', 'b.md');
    assert.equal(s.files.size, 1);
    assert.equal(s.files.get('b.md').words, 15);
  });
});

describe('速度、時長、目標的說法', () => {
  test('速度按每小時算；不到 1 分鐘、或者淨字數不是正的不報', () => {
    assert.equal(speedPerHour(600, 30 * 60_000), 1200);
    assert.equal(speedPerHour(600, MIN_SPEED_MS - 1), undefined);
    assert.equal(speedPerHour(0, 30 * 60_000), undefined);
    assert.equal(speedPerHour(-40, 30 * 60_000), undefined);
  });

  test('時長：不到 1 分鐘 / N 分鐘 / H 小時 M 分', () => {
    assert.equal(formatDuration(59_000), '不到 1 分鐘');
    assert.equal(formatDuration(42 * 60_000 + 5_000), '42 分鐘');
    assert.equal(formatDuration(125 * 60_000), '2 小時 5 分');
    assert.equal(formatDuration(120 * 60_000), '2 小時');
  });

  test('千分位與帶符號的字數', () => {
    assert.equal(groupDigits(3120), '3,120');
    assert.equal(groupDigits(1234567), '1,234,567');
    assert.equal(groupDigits(-1200), '-1,200');
    assert.equal(signedWords(356), '+356');
    assert.equal(signedWords(-12), '-12');
    assert.equal(signedWords(0), '0');
  });

  test('還差多少', () => {
    const g = goalProgress(3120, 4000);
    assert.equal(`${g.count}，${g.rest}`, '3,120 / 4,000 字，還差 880');
    assert.equal(g.enough, false);
    assert.equal(g.over, false);
  });

  test('到了八成算寫夠（後端判「寫夠了」的線），進度條換色', () => {
    assert.equal(goalProgress(3200, 4000).enough, true);
    assert.equal(goalProgress(3199, 4000).enough, false);
  });

  test('超了說超了多少；正好寫夠', () => {
    const g = goalProgress(4120, 4000);
    assert.equal(g.rest, '超出 120');
    assert.equal(g.over, true);
    assert.equal(goalProgress(4000, 4000).rest, '正好寫夠');
  });

  test('沒有目標（缺席、0、負數）：不報', () => {
    assert.equal(goalProgress(100, undefined), undefined);
    assert.equal(goalProgress(100, 0), undefined);
    assert.equal(goalProgress(100, -5), undefined);
  });
});

describe('章節開頭的「# 標題」不算字：與 core stripH1 同一條規則', () => {
  const samples = [
    '# 第三章 夜訪\n\n林昭推開門。',
    '\n\n# Night Visit 3\r\n正文 here.',
    '#沒有空格不是標題\n正文。',
    '## 二級標題不是\n正文。',
    '   # 前面有空白\n正文。',
    '#\n第一行被當成標題內容\n第二行。',
    '# 只有標題',
    '正文裡的\n# 不在開頭\n不算標題。',
  ];
  for (const text of samples) {
    test(`「${text.slice(0, 14).replace(/\s/g, '·')}」`, () => {
      assert.equal(countWords(text) - headingWords(text), core.countWords(stripH1(text.trim())));
    });
  }
});

describe('今日碼字：按本地日期、壞值回落、多視窗只加增量', () => {
  const at = (h, m) => new Date(2026, 9, 18, h, m).getTime();

  test('日期是本地的：23:59 是這一天，過了零點是下一天', () => {
    assert.equal(dayKey(at(23, 59)), '2026-10-18');
    assert.equal(dayKey(at(23, 59) + 2 * 60_000), '2026-10-19');
  });

  test('一筆增量跨午夜：各記各的那一天', () => {
    const inc = {};
    bumpDaily(inc, at(23, 58), 30, 60_000);
    bumpDaily(inc, at(23, 59) + 2 * 60_000, 12, 30_000);
    assert.deepEqual(inc, { '2026-10-18': { words: 30, ms: 60_000 }, '2026-10-19': { words: 12, ms: 30_000 } });
  });

  test('讀寫往返', () => {
    const rec = { '2026-10-18': { words: 1820, ms: 7_500_000 } };
    assert.deepEqual(parseDaily(serializeDaily(rec)), rec);
  });

  test('壞值一律回落成沒有，不拋', () => {
    for (const raw of [null, undefined, '', '不是 JSON', '[]', '42', '{"days":[]}', '{"days":"x"}', '{"v":1}']) {
      assert.deepEqual(parseDaily(raw), {}, String(raw));
    }
  });

  test('某一天的數寫壞了只丟那一天', () => {
    const raw = JSON.stringify({
      v: 1,
      days: {
        '2026-10-17': { words: '30', ms: 1 },
        '2026-10-16': { words: 10, ms: -1 },
        '昨天': { words: 10, ms: 1 },
        '2026-10-15': null,
        '2026-10-18': { words: 12.4, ms: 60_000.6 },
      },
    });
    assert.deepEqual(parseDaily(raw), { '2026-10-18': { words: 12, ms: 60_001 } });
  });

  test('是加不是覆蓋：兩個視窗各寫自己的增量，加起來不丟不重', () => {
    let shared = parseDaily(null);
    // 視窗 A 先寫 10 字，視窗 B 再寫 5 字：B 寫的時候現讀 A 寫下的那一份。
    shared = parseDaily(serializeDaily(addDaily(shared, { '2026-10-18': { words: 10, ms: 1000 } })));
    shared = parseDaily(serializeDaily(addDaily(shared, { '2026-10-18': { words: 5, ms: 500 } })));
    assert.deepEqual(shared, { '2026-10-18': { words: 15, ms: 1500 } });
  });

  test('不改傳進來的兩份', () => {
    const stored = { '2026-10-18': { words: 1, ms: 1 } };
    const inc = { '2026-10-18': { words: 2, ms: 2 } };
    addDaily(stored, inc);
    assert.deepEqual(stored, { '2026-10-18': { words: 1, ms: 1 } });
    assert.deepEqual(inc, { '2026-10-18': { words: 2, ms: 2 } });
  });

  test(`只留最近 ${DAILY_KEEP} 天`, () => {
    const stored = {};
    for (let d = 1; d <= DAILY_KEEP; d++) {
      bumpDaily(stored, new Date(2026, 8, d, 12).getTime(), d, 0);
    }
    const out = addDaily(stored, { '2026-10-18': { words: 1, ms: 0 } });
    assert.equal(Object.keys(out).length, DAILY_KEEP);
    assert.equal('2026-09-01' in out, false);
    assert.equal('2026-10-18' in out, true);
  });
});
