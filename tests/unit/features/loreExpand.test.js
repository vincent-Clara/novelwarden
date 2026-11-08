/**
 * 展開一條設定（完善設定，2026-10-19）的解碼、截斷、過濾與氣泡往返（features/loreExpand.ts），以及它在產物層
 * （features/artifact.ts）的樣子；單章細綱「設定」一節裡 `isNew` 的那幾行（§3）。全部是純函式。生成鏈與落盤在
 * tests/integration/generation/loreExpand.test.js。
 *
 * | 用例組 | 釘的是什麼 |
 * |---|---|
 * | 解碼 | 四節按上限截（明面合計 600、暗設 200）、一句話截 40，截了都說出來；Markdown 寫的正文按「暗設」標題切；明面三節空的、不是 JSON 的都解析不了（不做全文兜底）；`]` 前多出來的逗號自己修 |
 * | 過濾 | 關鍵詞不收人名、別的條目的標題、名錄裡另記著的、拆出去的子條目；子條目丟掉已有的、人名、重名、與本條同名的，最多 3 條；問題最多 5 條、每條 60 字 |
 * | 往返 | 渲染進氣泡的文字解析回來一字不差，`questions` 也在 |
 * | 產物 | 單條設定目標上解析成 `loreEntries`（第一項按路徑認，其餘是子條目）；解析不了是空的；設定清單那一支不受影響 |
 * | 單章細綱 | `settings` 裡 `isNew` 的另記一份 `newLore`，不進「設定」一節以外的地方 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const E = loadModule('src/core/features/loreExpand.ts');
const A = loadModule('src/core/features/artifact.ts');
const F = loadModule('src/core/model/loreFile.ts');

const REL = '.novelwarden/lore/宗門/天機閣.md';
const entry = (title, keywords = [], over = {}) => ({
  slug: title,
  relPath: `.novelwarden/lore/${title}.md`,
  title,
  keywords,
  brief: '',
  category: '',
  body: '',
  ...over,
});
const KNOWN = {
  title: '天機閣',
  entries: [entry('天機閣', ['閣裡']), entry('青雲宗', ['青雲門']), entry('九層樓')],
  people: ['林昭', '阿昭'],
  recorded: ['寒冰鎖'],
};
const good = (over = {}) =>
  JSON.stringify({
    brief: '江湖上賣訊息的樓閣',
    keywords: ['天機樓', '閣中'],
    body: { 概要: '一座賣訊息的樓。', 规则与边界: '一問一價，不問來者。', 现状: '閣主閉關。', 暗设: '閣主是前朝太子。' },
    children: [{ name: '閣規', category: '制度', brief: '天機閣的十條規矩' }],
    questions: ['閣規是成文的還是口傳的？', '閣主閉關多久了？'],
    ...over,
  });

describe('解碼', () => {
  test('四節、一句話、關鍵詞、子條目、問題都收下', () => {
    const d = E.decodeLoreExpansion(good(), KNOWN);
    assert.ok(d.ok, d.message);
    assert.equal(d.value.brief, '江湖上賣訊息的樓閣');
    assert.equal(
      d.value.body,
      '## 概要\n一座賣訊息的樓。\n\n## 規則與邊界\n一問一價，不問來者。\n\n## 現狀\n閣主閉關。\n\n## 暗設\n閣主是前朝太子。'
    );
    assert.deepEqual(d.value.keywords, ['天機樓', '閣中']);
    assert.deepEqual(d.value.children, [{ name: '閣規', category: '制度', brief: '天機閣的十條規矩' }]);
    assert.deepEqual(d.value.questions, ['閣規是成文的還是口傳的？', '閣主閉關多久了？']);
    assert.deepEqual(d.warnings, []);
  });

  // 第 27 條：明面三節合計 600（每節 150 / 250 / 150），暗設另算 200；一句話 40。
  test('超長按上限截，截了都說出來', () => {
    const d = E.decodeLoreExpansion(
      good({
        brief: '長'.repeat(50),
        body: { 概要: '甲'.repeat(200), 规则与边界: '乙'.repeat(300), 现状: '丙'.repeat(200), 暗设: '丁'.repeat(260) },
      }),
      KNOWN
    );
    assert.ok(d.ok);
    const { visible, hidden } = F.splitLoreHidden(d.value.body);
    assert.ok(visible.includes(`## 概要\n${'甲'.repeat(150)}\n`), visible.slice(0, 200));
    assert.ok(visible.includes(`## 規則與邊界\n${'乙'.repeat(250)}\n`));
    assert.ok(visible.includes(`## 現狀\n${'丙'.repeat(150)}`));
    assert.equal(hidden, '丁'.repeat(200));
    assert.equal(Array.from(d.value.brief).length, 40);
    assert.ok(d.warnings.some((w) => w.includes('正文超長')), d.warnings.join('|'));
    assert.ok(d.warnings.some((w) => w.includes('暗設超過 200 字')), d.warnings.join('|'));
    assert.ok(d.warnings.some((w) => w.includes('一句話超過 40 字')), d.warnings.join('|'));
  });

  test('正文寫成 Markdown 也認，暗設按「暗設」開頭的標題切；沒寫到的節是「（未交代）」', () => {
    const d = E.decodeLoreExpansion(
      JSON.stringify({ brief: 'b', keywords: [], body: '## 概要\n一座樓。\n\n## 暗設（未揭示）\n樓下有密道。\n\n## 現狀\n還開著。' })
    );
    assert.ok(d.ok, d.message);
    assert.equal(d.value.body, '## 概要\n一座樓。\n\n## 規則與邊界\n（未交代）\n\n## 現狀\n還開著。\n\n## 暗設\n樓下有密道。');
  });

  test('暗設寫「無」「（未交代）」或空著都當沒有', () => {
    for (const none of ['', '無', '（未交代）', '（待補充）']) {
      const d = E.decodeLoreExpansion(good({ body: { 概要: '一座樓。', 规则与边界: '', 现状: '', 暗设: none } }));
      assert.ok(d.ok);
      assert.ok(!d.value.body.includes('暗設'), `${none} → ${d.value.body}`);
    }
  });

  // 不做全文兜底：一段沒解析開的原文蓋掉條目，比沒寫更糟。
  test('明面三節一節都沒有、不是 JSON 的，都解析不了', () => {
    assert.equal(E.decodeLoreExpansion(good({ body: { 暗设: '只有暗設' } })).ok, false);
    assert.equal(E.decodeLoreExpansion('我覺得天機閣應該是一座樓。').ok, false);
    assert.equal(E.decodeLoreExpansion('{"brief":"一座樓","body":{"概要":"一座樓。"').ok, false);
  });

  test('`}` 前多出來的逗號自己修，不調模型', () => {
    const d = E.decodeLoreExpansion('```json\n{"brief":"一座樓","keywords":["樓",],"body":{"概要":"一座樓。",},}\n```');
    assert.ok(d.ok, d.message);
    assert.equal(d.value.brief, '一座樓');
  });

  test('模型沒包一層 body、把幾節寫在頂層也認', () => {
    const d = E.decodeLoreExpansion(JSON.stringify({ brief: 'b', 概要: '一座樓。', 暗设: '樓下有密道。' }));
    assert.ok(d.ok, d.message);
    assert.ok(d.value.body.startsWith('## 概要\n一座樓。') && d.value.body.endsWith('## 暗設\n樓下有密道。'), d.value.body);
  });
});

describe('過濾', () => {
  test('關鍵詞：人名、別的條目的標題、名錄裡另記著的、拆出去的子條目、與本條同名的都不要，最多 8 個', () => {
    const d = E.decodeLoreExpansion(
      good({
        keywords: ['天機閣', '林昭', '青雲宗', '寒冰鎖', '閣規', '天機樓', '天機樓', '機', '閣中', ...Array.from({ length: 10 }, (_, i) => `別稱${i}`)],
      }),
      KNOWN
    );
    assert.ok(d.ok);
    assert.deepEqual(d.value.keywords, ['天機樓', '閣中', '別稱0', '別稱1', '別稱2', '別稱3', '別稱4', '別稱5']);
  });

  test('子條目：已有條目的（標題或關鍵詞）、人名、重名、與本條同名的丟掉並說明；最多 3 條；分類規範成目錄', () => {
    const d = E.decodeLoreExpansion(
      good({
        children: [
          { name: '青雲門', category: '宗門', brief: '已有條目的關鍵詞' },
          { name: '阿昭', category: '', brief: '人' },
          { name: '天機閣', category: '', brief: '本條' },
          { name: '閣規', category: '制度/門規', brief: '十條規矩' },
          { name: '閣規', category: '', brief: '重名' },
          { name: '暗樁', category: '／勢力 ', brief: '安插在各地的眼線' },
          '密道',
          { name: '信鴿', category: '物品', brief: '傳信' },
        ],
      }),
      KNOWN
    );
    assert.ok(d.ok);
    assert.deepEqual(d.value.children, [
      { name: '閣規', category: '制度/門規', brief: '十條規矩' },
      { name: '暗樁', category: '勢力', brief: '安插在各地的眼線' },
      { name: '密道', category: '', brief: '' },
    ]);
    assert.ok(d.warnings.some((w) => w.includes('「青雲門」已經有條目了（青雲宗）')), d.warnings.join('|'));
    assert.ok(d.warnings.some((w) => w.includes('「阿昭」是角色卡上的人')), d.warnings.join('|'));
    assert.ok(d.warnings.some((w) => w.includes('超過 3 條') && w.includes('信鴿')), d.warnings.join('|'));
  });

  test('問題：去重、每條截 60 字、最多 5 條；寫成一段字按換行拆（問題裡常有逗號）', () => {
    const many = E.decodeLoreExpansion(
      good({ questions: ['一？', '二？', '一？', '三？', '四？', '五？', '六？', '長'.repeat(80)] })
    );
    assert.deepEqual(many.value.questions, ['一？', '二？', '三？', '四？', '五？']);
    assert.ok(many.warnings.some((w) => w.includes('只留前 5 條')));
    const long = E.decodeLoreExpansion(good({ questions: ['長'.repeat(80)] }));
    assert.equal(Array.from(long.value.questions[0]).length, 60);
    const text = E.decodeLoreExpansion(good({ questions: '1. 閣規是成文的，還是口傳的？\n- 閣主閉關多久了？' }));
    assert.deepEqual(text.value.questions, ['閣規是成文的，還是口傳的？', '閣主閉關多久了？']);
  });
});

describe('氣泡往返', () => {
  test('渲染進氣泡的文字解析回來一字不差（questions 也在）', () => {
    const d = E.decodeLoreExpansion(
      good({ body: { 概要: '一座樓。', 规则与边界: '', 现状: '閣主閉關。', 暗设: '閣主是前朝太子。' } }),
      KNOWN
    );
    const text = E.renderLoreExpansion(d.value);
    const back = E.decodeLoreExpansion(text);
    assert.ok(back.ok, back.message);
    assert.deepEqual(back.value, d.value);
    assert.deepEqual(back.warnings, []);
    assert.equal(E.renderLoreExpansion(back.value), text);
    assert.deepEqual(JSON.parse(text).questions, ['閣規是成文的還是口傳的？', '閣主閉關多久了？']);
  });

  test('沒有暗設的往返不憑空多出一節', () => {
    const d = E.decodeLoreExpansion(good({ body: { 概要: '一座樓。' } }));
    const back = E.decodeLoreExpansion(E.renderLoreExpansion(d.value));
    assert.equal(back.value.body, d.value.body);
    assert.ok(!back.value.body.includes('暗設'));
  });

  test('解析成落盤的樣子：第一項是目標條目（按路徑認、標題取檔名），其餘是子條目（空正文）', () => {
    const { entries, questions } = E.parseLoreExpansion(good(), REL);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].relPath, REL);
    assert.equal(entries[0].title, '天機閣');
    assert.ok(entries[0].body.includes('## 暗設\n閣主是前朝太子。'));
    assert.deepEqual(entries[1], { title: '閣規', category: '制度', keywords: ['閣規'], brief: '天機閣的十條規矩', body: '' });
    assert.equal(questions.length, 2);
    assert.deepEqual(E.parseLoreExpansion('不是 JSON', REL), { entries: [], questions: [] });
  });
});

describe('產物', () => {
  const action = { stage: 'setting', capability: 'generate' };
  const target = { kind: 'lore', relPath: REL };

  test('單條設定目標上解析成 loreEntries，描述說得出幾節、拆出幾條、幾問', () => {
    const art = A.parseArtifact(action, good(), target);
    assert.equal(art.kind, 'loreEntries');
    assert.equal(art.entries[0].relPath, REL);
    assert.equal(A.isArtifactEmpty(art), false);
    assert.equal(A.describeArtifact(art), '設定 · 天機閣 · 展開 3/3 節 + 暗設 · 拆出 1 條 · 還沒定的 2 問');
  });

  test('寫成「（未交代）」的節不算展開了', () => {
    const art = A.parseArtifact(action, good({ body: { 概要: '一座樓。', 现状: '（未交代）' }, children: [], questions: [] }), target);
    assert.equal(A.describeArtifact(art), '設定 · 天機閣 · 展開 1/3 節');
  });

  test('解析不了就是空的（沒有落盤卡片），不做全文兜底', () => {
    const art = A.parseArtifact(action, '天機閣是一座樓，賣訊息。', target);
    assert.equal(art.kind, 'loreEntries');
    assert.equal(A.isArtifactEmpty(art), true);
  });

  test('設定清單那一支不受影響', () => {
    const art = A.parseArtifact(action, JSON.stringify({ categories: ['宗門'], entries: [{ title: '天機閣', category: '宗門' }] }), {
      kind: 'setting',
      doc: 'lore',
    });
    assert.equal(art.kind, 'loreList');
  });
});

describe('單章細綱 · 新設定（完善設定 §3）', () => {
  const action = { stage: 'plot', capability: 'generate' };
  const blueprint = (settings) =>
    JSON.stringify({
      blueprints: [{ chapterNumber: 3, title: '夜訪', synopsis: '林昭夜訪天機閣。', keyEvents: ['林昭入閣'], settings }],
    });

  test('isNew 的另記一份 newLore，「設定」一節照舊全收', () => {
    const art = A.parseArtifact(
      action,
      blueprint([
        { name: '天機閣', category: '宗門', isNew: false, note: '' },
        { name: '九層樓', category: '地域', isNew: true, note: '天機閣的藏書樓' },
        { name: '暗河', category: '地域', isNew: 'true', note: '城下的河' },
      ])
    );
    assert.equal(art.kind, 'plot');
    assert.deepEqual(art.lore.map((l) => l.name), ['天機閣', '九層樓', '暗河']);
    assert.deepEqual(art.newLore, [
      { name: '九層樓', category: '地域', note: '天機閣的藏書樓' },
      { name: '暗河', category: '地域', note: '城下的河' },
    ]);
  });

  test('沒有新設定就不帶這個欄位', () => {
    const art = A.parseArtifact(action, blueprint([{ name: '天機閣', category: '宗門', isNew: false, note: '' }]));
    assert.equal(art.newLore, undefined);
  });
});
