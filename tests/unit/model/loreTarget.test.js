/**
 * 單條設定這個生成目標（完善設定，2026-10-19，設計稿 §1「生成目標」方案 A）：`{ kind: 'lore', relPath }`。
 *
 * | 用例組 | 釘的是什麼 |
 * |---|---|
 * | 目標 | 階段是架構（`setting`）；key、描述、取路徑各認它；與整批設定清單不是同一個目標 |
 * | 歸一 | 能存能讀回；缺路徑回落到大綱，**不落到設定清單**（隨會話存下的草稿重開後不能被當成整批清單採納） |
 * | 說法 | 生成在這個目標上叫「展開這條設定」（`/展開`），設定清單、世界觀等幾件的說法不動；呼叫次數 1 次、最多 2 次 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const pipeline = loadModule('src/core/model/pipeline.ts');

const L = { kind: 'lore', relPath: '.novelwarden/lore/宗門/天機閣.md' };

describe('單條設定目標', () => {
  test('階段是架構，取得到路徑，不歸屬任何一章', () => {
    assert.equal(pipeline.stageOfTarget(L), 'setting');
    assert.equal(pipeline.loreOfTarget(L), L.relPath);
    assert.equal(pipeline.plotOfTarget(L), undefined);
    assert.equal(pipeline.settingOfTarget(L), undefined);
    assert.equal(pipeline.loreOfTarget({ kind: 'setting', doc: 'lore' }), undefined);
  });

  test('key 帶路徑，與設定清單、別的條目都不同', () => {
    assert.equal(pipeline.targetKey(L), `lore:${L.relPath}`);
    assert.notEqual(pipeline.targetKey(L), pipeline.targetKey({ kind: 'setting', doc: 'lore' }));
    assert.equal(pipeline.isSameTarget(L, { kind: 'lore', relPath: L.relPath }), true);
    assert.equal(pipeline.isSameTarget(L, { kind: 'lore', relPath: '.novelwarden/lore/宗門/青雲宗.md' }), false);
  });

  // 名字：呼叫方讀得到條目時給標題，沒給取檔名。
  test('描述：給了標題用標題，沒給取檔名', () => {
    assert.equal(pipeline.describeTarget(L), '設定 · 天機閣');
    assert.equal(pipeline.describeTarget(L, { title: '天機閣（舊稱）' }), '設定 · 天機閣（舊稱）');
    assert.equal(pipeline.describeTarget({ kind: 'lore', relPath: '.novelwarden/lore/九層樓.markdown' }), '設定 · 九層樓');
  });
});

describe('單條設定目標 · 歸一', () => {
  test('能讀回，路徑去掉首尾空白', () => {
    assert.deepEqual(pipeline.normalizeTarget(L), L);
    assert.deepEqual(pipeline.normalizeTarget({ kind: 'lore', relPath: `  ${L.relPath}  ` }), L);
    assert.deepEqual(pipeline.normalizeTarget(JSON.parse(JSON.stringify(L))), L);
  });

  test('缺路徑回落到大綱，不落到設定清單', () => {
    assert.deepEqual(pipeline.normalizeTarget({ kind: 'lore' }), { kind: 'outline' });
    assert.deepEqual(pipeline.normalizeTarget({ kind: 'lore', relPath: '   ' }), { kind: 'outline' });
    assert.deepEqual(pipeline.normalizeTarget({ kind: 'lore', relPath: 3 }), { kind: 'outline' });
  });
});

describe('單條設定目標 · 說法與呼叫次數', () => {
  test('生成叫「展開這條設定」，/展開 認得出；能力按階段與目標算（討論 + 生成，單條設定上沒有落定）', () => {
    const cmds = pipeline.commandsFor('setting', L);
    // 末尾那兩條 `/續寫大綱`、`/落定設定` 是哪一層都有的（完善設定二期、2026-10-24），不是這一條自己的。
    assert.deepEqual(cmds.map((c) => c.label), ['展開這條設定', '續寫大綱', '落定設定']);
    assert.deepEqual(pipeline.capabilitiesOn('setting', L), ['discuss', 'generate']);
    assert.ok(cmds[0].keys.includes('expand') && cmds[0].keys.includes('zk'), cmds[0].keys.join(','));
    assert.ok(cmds[0].keys.includes('generate'));
    assert.equal(pipeline.labelOf('setting', 'generate', L), '展開這條設定');
    assert.equal(pipeline.commandOf('setting', 'generate', L).label, '展開這條設定');
    assert.equal(pipeline.commandOf('setting', 'settle', L), undefined);
  });

  test('設定清單、世界觀等幾件的說法不動', () => {
    assert.equal(pipeline.labelOf('setting', 'generate'), '生成這份架構檔案');
    assert.equal(pipeline.labelOf('setting', 'generate', { kind: 'setting', doc: 'lore' }), '生成這份架構檔案');
    assert.deepEqual(pipeline.commandsFor('setting').map((c) => c.label), ['生成這份架構檔案', '續寫大綱', '落定設定']);
    assert.ok(!pipeline.commandsFor('setting').some((c) => c.keys.includes('expand')));
    assert.deepEqual(pipeline.commandsFor('plot', { kind: 'plot', plotRelPath: 'x' }).map((c) => c.label), ['落定細綱', '寫細綱', '續寫大綱', '落定設定']);
  });

  // 2026-10-25 起寫完轉寫一次，不合格重轉一次。
  test('展開預計 2 次，最多 3 次（寫 1 次、轉寫 1 次，重轉 1 次）', () => {
    const c = pipeline.LORE_EXPAND_CALLS;
    assert.deepEqual([c.low, c.high, c.max], [2, 2, 3]);
    assert.ok(pipeline.describeCalls(c).startsWith('預計 2 次呼叫，最多 3 次（寫 1 次、轉寫模型照抄成 JSON 1 次'), pipeline.describeCalls(c));
  });
});
