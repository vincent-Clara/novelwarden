/**
 * 落定設定（完善設定二期）的解碼、截斷、過濾、認已有條目與氣泡往返（features/loreSettle.ts），它在產物層
 * （features/artifact.ts）與提示詞（context/loreSettlePrompt.ts、prompts.ts）裡的樣子。全部是純函式。生成鏈與落盤在
 * tests/integration/generation/loreSettle.test.js。
 *
 * | 用例組 | 釘的是什麼 |
 * |---|---|
 * | 解碼 | 一批條目各自截（明面合計 600、暗設 200、一句話 40），截了說是哪一條；沒名字、重名、人名、明面一節都沒有的丟掉並說出來；最多 12 條；不是 JSON 的解析不了（不做全文兜底）；裸陣列也認 |
 * | 認已有條目 | 路徑 → 同名（同名不同分類的按分類挑）→ 關鍵詞；認出來的換成那一條的標題、分類、路徑；同一條被認兩次只留第一次 |
 * | 關鍵詞 | 不收人名、別的條目的標題（已有的、這一批裡別的）、名錄裡另記著的；最多 8 個 |
 * | 往返 | 渲染進氣泡的文字解析回來一字不差，改已有的帶 `relPath`；一條都沒定下來時是一段人話 |
 * | 產物 | 架構那一層的 settle 解析成帶 `settle` 的 `loreEntries`，排在設定清單之前；展開、設定清單不受影響 |
 * | 提示詞 | 任務與原則是落定設定那一份（不說「這一章」，沒定的進 questions 欄位）；合同帶上限；落定細綱不受影響 |
 * | 配方 | 歷史照落定細綱抬到 P0、封頂 60%；`lore` 提到歷史後面（P1），不讓角色卡先拿預算；生成設定清單的配方不動 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const S = loadModule('src/core/features/loreSettle.ts');
const A = loadModule('src/core/features/artifact.ts');
const P = loadModule('src/core/context/prompts.ts');
const R = loadModule('src/core/context/recipes.ts');
const LP = loadModule('src/core/context/loreSettlePrompt.ts');

const entry = (title, keywords = [], over = {}) => ({
  slug: title,
  relPath: `.novelwarden/lore/${over.category ? `${over.category}/` : ''}${title}.md`,
  title,
  keywords,
  brief: '',
  category: '',
  body: '',
  ...over,
});
const TJG = entry('天機閣', ['閣裡'], { category: '宗門' });
const KNOWN = {
  entries: [TJG, entry('青雲宗', ['青雲門'], { category: '宗門' }), entry('後山', [], { category: '地域' }), entry('後山', [], { category: '青雲宗' })],
  people: ['林昭', '阿昭'],
  recorded: ['寒冰鎖'],
};
const row = (title, over = {}) => ({
  title,
  category: '地域',
  keywords: [],
  brief: `${title}的一句話`,
  body: { 概要: `${title}是什麼。`, 规则与边界: '（未交代）', 现状: '（未交代）', 暗设: '' },
  ...over,
});
const settle = (entries, questions = []) => JSON.stringify({ entries, questions });

describe('解碼', () => {
  test('一批條目：四節、一句話、關鍵詞收下；問題收下', () => {
    const d = S.decodeLoreSettle(
      settle([row('鬼市', { keywords: ['夜市'], body: { 概要: '城下的夜市。', 规则与边界: '子時開張。', 现状: '（未交代）', 暗设: '鬼市主人是天機閣二當家。' } })], ['鬼市在哪座城下？']),
      KNOWN
    );
    assert.ok(d.ok, d.message);
    assert.equal(d.value.entries.length, 1);
    const [e] = d.value.entries;
    assert.equal(e.title, '鬼市');
    assert.equal(e.category, '地域');
    assert.equal(e.relPath, undefined);
    assert.deepEqual(e.keywords, ['夜市']);
    assert.equal(e.brief, '鬼市的一句話');
    assert.equal(e.body, '## 概要\n城下的夜市。\n\n## 規則與邊界\n子時開張。\n\n## 現狀\n（未交代）\n\n## 暗設\n鬼市主人是天機閣二當家。');
    assert.deepEqual(d.value.questions, ['鬼市在哪座城下？']);
  });

  test('截長：每一條按上限截，說清是哪一條', () => {
    const long = '長'.repeat(400);
    const d = S.decodeLoreSettle(settle([row('鬼市', { brief: '短'.repeat(50), body: { 概要: long, 规则与边界: long, 现状: long, 暗设: '暗'.repeat(300) } })]), KNOWN);
    assert.ok(d.ok);
    const { body, brief } = d.value.entries[0];
    assert.equal(Array.from(brief).length, 40);
    const visible = body.split('## 暗設')[0].replace(/## \S+\n/g, '').replace(/\s/g, '');
    assert.ok(Array.from(visible).length <= 600, String(Array.from(visible).length));
    assert.equal(body.split('## 暗設\n')[1].length, 200);
    assert.ok(d.warnings.some((w) => w.startsWith('「鬼市」正文超長')), d.warnings.join('|'));
    assert.ok(d.warnings.some((w) => w.startsWith('「鬼市」暗設超過 200 字')), d.warnings.join('|'));
    assert.ok(d.warnings.some((w) => w.includes('「鬼市」的一句話超過 40 字')), d.warnings.join('|'));
  });

  test('沒名字、重名、人名、明面一節都沒有的丟掉，並說出來', () => {
    const d = S.decodeLoreSettle(
      settle([
        row(''),
        row('鬼市'),
        row('鬼 市'),
        row('阿昭'),
        row('黑水渡', { body: { 概要: '', 规则与边界: '', 现状: '', 暗设: '只有暗設。' } }),
      ]),
      KNOWN
    );
    assert.ok(d.ok);
    assert.deepEqual(d.value.entries.map((e) => e.title), ['鬼市']);
    const w = d.warnings.join('|');
    assert.ok(w.includes('有一條沒寫名字'), w);
    assert.ok(w.includes('「鬼 市」在這一批裡重複了'), w);
    assert.ok(w.includes('「阿昭」是角色卡上的人'), w);
    assert.ok(w.includes('「黑水渡」正文三節一節內容都沒有'), w);
  });

  test(`最多 12 條，多出來的說出來`, () => {
    const rows = Array.from({ length: 14 }, (_, i) => row(`地名${i + 1}`));
    const d = S.decodeLoreSettle(settle(rows), KNOWN);
    assert.equal(d.value.entries.length, 12);
    assert.ok(d.warnings.some((w) => w.includes('一次最多落定 12 條，「地名13」及之後的沒收')), d.warnings.join('|'));
  });

  test('不是 JSON 的解析不了；裸陣列也認；一條都沒有也算解析成功', () => {
    assert.equal(S.decodeLoreSettle('討論裡定下了鬼市。').ok, false);
    assert.equal(S.decodeLoreSettle('{"questions":["a"]}').ok, false);
    const bare = S.decodeLoreSettle(JSON.stringify([row('鬼市')]));
    assert.ok(bare.ok);
    assert.equal(bare.value.entries[0].title, '鬼市');
    const none = S.decodeLoreSettle(settle([], ['鬼市在哪？']));
    assert.ok(none.ok);
    assert.deepEqual(none.value.entries, []);
    assert.deepEqual(none.value.questions, ['鬼市在哪？']);
  });
});

describe('認已有條目', () => {
  test('同名：換成那一條的標題、分類、路徑（模型寫錯分類也認）', () => {
    const d = S.decodeLoreSettle(settle([row('天機閣', { category: '地域' })]), KNOWN);
    const [e] = d.value.entries;
    assert.equal(e.relPath, TJG.relPath);
    assert.equal(e.category, '宗門');
    assert.equal(e.title, '天機閣');
  });

  test('關鍵詞：認成那一條，說出來', () => {
    const d = S.decodeLoreSettle(settle([row('青雲門')]), KNOWN);
    const [e] = d.value.entries;
    assert.equal(e.title, '青雲宗');
    assert.equal(e.relPath, '.novelwarden/lore/宗門/青雲宗.md');
    assert.ok(d.warnings.some((w) => w.includes('「青雲門」認成了已有條目「青雲宗」')), d.warnings.join('|'));
  });

  test('同名不同分類：按分類挑，挑不出取第一條', () => {
    const pick = (category) => S.findSettledEntry(KNOWN.entries, { title: '後山', category });
    assert.equal(pick('青雲宗').relPath, '.novelwarden/lore/青雲宗/後山.md');
    assert.equal(pick('地域').relPath, '.novelwarden/lore/地域/後山.md');
    assert.equal(pick('別處').relPath, '.novelwarden/lore/地域/後山.md');
  });

  test('給了路徑且那條還在：按路徑認（作者改了名也認得出）', () => {
    const renamed = { ...TJG, title: '天機樓閣' };
    assert.equal(S.findSettledEntry([renamed], { relPath: TJG.relPath, title: '天機閣', category: '' }).title, '天機樓閣');
    assert.equal(S.findSettledEntry([renamed], { relPath: '.novelwarden/lore/沒了.md', title: '鬼市', category: '' }), undefined);
  });

  // 真跑：討論只提到、沒改的條目，模型照抄正文、順手改了一句話或關鍵詞——一次落定彈了三張沒意思的對比。
  test('認出是已有條目、正文和原來一字不差：丟掉，說出來', () => {
    const known = { ...KNOWN, entries: [{ ...TJG, body: '## 概要\n一座賣訊息的樓。\n\n## 規則與邊界\n（未交代）\n\n## 現狀\n（未交代）' }, ...KNOWN.entries.slice(1)] };
    const same = row('天機閣', { brief: '換了一句話', keywords: ['天機樓'], body: { 概要: '一座賣訊息的樓。', 规则与边界: '（未交代）', 现状: '（未交代）', 暗设: '' } });
    const d = S.decodeLoreSettle(settle([same, row('鬼市')]), known);
    assert.deepEqual(d.value.entries.map((e) => e.title), ['鬼市']);
    assert.ok(d.warnings.some((w) => w.includes('「天機閣」的正文和原來一樣')), d.warnings.join('|'));
  });

  // 真跑：模型照抄上下文裡一行帶的樣子，把「土地廟〔地點/青羊鎮域〕」整個寫進 title，另建了一份。
  test('名字後面夾帶的〔分類〕剝掉，裡面的當分類；照樣認得出已有條目', () => {
    const d = S.decodeLoreSettle(settle([row('天機閣〔宗門〕', { category: '' }), row('鬼市【地域/城下】', { category: '' })]), KNOWN);
    assert.deepEqual(d.value.entries.map((e) => [e.title, e.category, e.relPath]), [
      ['天機閣', '宗門', TJG.relPath],
      ['鬼市', '地域/城下', undefined],
    ]);
    const plain = S.decodeLoreSettle(settle([row('〔無名〕')]), KNOWN);
    assert.equal(plain.value.entries[0].title, '〔無名〕');
  });

  test('同一條被認兩次：只留第一次', () => {
    const d = S.decodeLoreSettle(settle([row('天機閣'), row('閣裡')]), KNOWN);
    assert.deepEqual(d.value.entries.map((e) => e.title), ['天機閣']);
    assert.ok(d.warnings.some((w) => w.includes('「閣裡」認成了已有條目「天機閣」，前面已經有一條改它了')), d.warnings.join('|'));
  });
});

describe('关键词', () => {
  test('不收人名、別的條目的標題、這一批裡別的、名錄裡另記著的；最多 8 個', () => {
    const d = S.decodeLoreSettle(
      settle([
        row('鬼市', { keywords: ['夜市', '林昭', '青雲宗', '黑水渡', '寒冰鎖', '鬼市', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'] }),
        row('黑水渡'),
      ]),
      KNOWN
    );
    const kw = d.value.entries[0].keywords;
    for (const bad of ['林昭', '青雲宗', '黑水渡', '寒冰鎖', '鬼市']) {
      assert.ok(!kw.includes(bad), `${bad} ∈ ${kw.join(',')}`);
    }
    assert.equal(kw[0], '夜市');
    assert.equal(kw.length, 8);
  });
});

describe('往返', () => {
  test('渲染進氣泡的文字解析回來一字不差；改已有的帶 relPath', () => {
    const d = S.decodeLoreSettle(settle([row('天機閣'), row('鬼市', { keywords: ['夜市'] })], ['問一句？']), KNOWN);
    const raw = S.renderLoreSettle(d.value);
    assert.ok(raw.includes(`"relPath": "${TJG.relPath}"`), raw);
    assert.deepEqual(S.parseLoreSettle(raw), d.value);
  });

  test('一條都沒定下來：一段人話，列出還沒定的；它解析不出條目', () => {
    const text = S.renderNothingSettled(['鬼市在哪？', '誰開的？']);
    assert.ok(text.startsWith('討論裡還沒有定下來的設定'), text);
    assert.ok(text.includes('1. 鬼市在哪？') && text.includes('2. 誰開的？'), text);
    assert.deepEqual(S.parseLoreSettle(text), { entries: [], questions: [] });
  });
});

describe('產物', () => {
  const action = { stage: 'setting', capability: 'settle' };
  const LORE_DIR = { kind: 'setting', doc: 'lore' };

  test('架構那一層的 settle → 帶 settle 的 loreEntries，不是設定清單', () => {
    const art = A.parseArtifact(action, settle([row('鬼市'), { ...row('天機閣'), relPath: TJG.relPath }], ['問？']), LORE_DIR);
    assert.equal(art.kind, 'loreEntries');
    assert.equal(art.settle, true);
    assert.deepEqual(art.entries.map((e) => e.title), ['鬼市', '天機閣']);
    assert.equal(art.entries[1].relPath, TJG.relPath);
    assert.equal(A.describeArtifact(art), '落定設定 · 2 條（改已有的 1 條） · 還沒定的 1 問');
  });

  test('解析不了 / 一條都沒有：空產物（沒有落盤卡片）', () => {
    assert.ok(A.isArtifactEmpty(A.parseArtifact(action, '我覺得鬼市應該……', LORE_DIR)));
    assert.ok(A.isArtifactEmpty(A.parseArtifact(action, S.renderNothingSettled(['問？']), LORE_DIR)));
  });

  test('設定清單、展開不受影響', () => {
    const list = A.parseArtifact({ stage: 'setting', capability: 'generate' }, '{"categories":["地域"],"entries":[{"title":"鬼市","category":"地域","keywords":[],"brief":"夜市"}]}', LORE_DIR);
    assert.equal(list.kind, 'loreList');
    const expand = A.parseArtifact(
      { stage: 'setting', capability: 'generate' },
      JSON.stringify({ brief: '樓', keywords: [], body: { 概要: '樓。' }, children: [], questions: [] }),
      { kind: 'lore', relPath: TJG.relPath }
    );
    assert.equal(expand.kind, 'loreEntries');
    assert.equal(expand.settle, undefined);
  });
});

describe('提示詞', () => {
  const config = { model: 'p/m', contextWindow: 100000, maxOutputTokens: 4096 };
  const sys = (action, target) => P.buildSystemPrompt(action, config, { target });
  const LORE_DIR = { kind: 'setting', doc: 'lore' };

  test('系統提示：落定設定的原則與任務，不說「這一章」，沒定的進「還沒定的問題」', () => {
    const s = sys({ stage: 'setting', capability: 'settle' }, LORE_DIR);
    assert.ok(s.includes('這一次只把討論裡已經定下來的設定落成條目'), s.slice(0, 400));
    assert.ok(s.includes('已經定下來的設定**整理成一批設定條目'), s);
    assert.ok(s.includes('寫進最後「還沒定的問題」一節'), s);
    // 真跑：「殘米」只差來源沒定，模型整條沒寫。
    assert.ok(s.includes('不要因為有一處沒定就整條不寫'), s);
    assert.ok(!s.includes('你和作者剛討論完這一章'), s);
    assert.ok(!s.includes('在產物之外用一兩句話說明'), s);
  });

  test('落定細綱不受影響', () => {
    const s = sys({ stage: 'plot', capability: 'settle' }, { kind: 'plot', plotRelPath: 'x' });
    assert.ok(s.includes('你和作者剛討論完這一章'), s);
  });

  test('合同：落定設定那一份，帶上限；不是設定清單', () => {
    const c = P.buildOutputContract({ stage: 'setting', capability: 'settle' }, { target: LORE_DIR });
    // 2026-10-25 起按小標題寫，JSON 合同挪給轉寫那一步。
    assert.ok(c.includes('【落定格式】') && c.includes('## 還沒定的問題') && !c.includes('{"entries"'), c);
    assert.ok(c.includes('最多 12 條'), c);
    assert.ok(c.includes('三節合計 ≤ 600 字') && c.includes('暗設 ≤ 200 字'), c);
    assert.ok(c.includes('**人不是設定**'), c);
    assert.ok(c.includes('討論沒碰的部分照抄原文，一處都不許丟'), c);
    assert.ok(c.includes('「暗設（讀者還不知道）」'), c);
    // 真跑（gemini-3-flash-lite）：模型把「法器」「防線」「硬通貨」寫成關鍵詞，正文一提就整條帶進來。
    assert.ok(c.includes('不放別的東西也叫得上的泛稱'), c);
    // 真跑：討論只提到的已有條目也被列進來；一個沒想好的問題被寫成了暗設。
    assert.ok(c.includes('討論裡只是提到、沒有改動的已有條目不要列'), c);
    assert.ok(c.includes('不是還沒想好的事'), c);
    assert.ok(!c.includes('【設定清單格式】'), c);
  });

  test('轉寫合同：形狀是解碼認的那一份，文字一律照抄', () => {
    const j = LP.loreSettleJsonContract();
    assert.ok(j.includes('【落定設定 JSON 合同】') && j.includes('{"entries":[{"title"') && j.includes('"questions"'), j);
    assert.ok(j.includes('原文只有「還沒定的問題」一節時 entries 給 []'), j);
    assert.ok(j.includes('文字一律從原文照抄'), j);
  });
});

describe('配方', () => {
  test('歷史抬到 P0、封頂 60%；lore 緊跟歷史、P1；設定清單不動', () => {
    const r = R.recipeFor('setting', 'settle');
    const at = (layer) => r.findIndex((x) => x.layer === layer);
    const history = r[at('history')];
    assert.equal(history.priority, 0);
    assert.equal(history.cap, 0.6);
    assert.equal(at('lore'), at('history') + 1);
    assert.equal(r[at('lore')].priority, 1);
    assert.ok(at('lore') < at('characters'));
    const plain = R.recipeFor('setting', 'generate');
    assert.equal(plain.at(-1).layer, 'lore');
    assert.equal(plain.at(-1).priority, 2);
    const plot = R.recipeFor('plot', 'settle');
    assert.equal(plot.find((x) => x.layer === 'history').cap, 0.6);
    assert.equal(plot.find((x) => x.layer === 'lore').priority, 2);
  });
});
