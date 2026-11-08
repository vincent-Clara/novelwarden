/**
 * 全書查詢替換面板的純函式（`media/src/editor/bookFindCore.ts`）。面板本身（按鍵、停頓再搜、點一處跳過去、預覽、兩段式、
 * 彙總）在 tests/dom/standalone/bookFind.test.js。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 分組 | 按範圍（面板上的順序）分組，組內順序原樣，每組幾處 |
 * | 勾選 | 檔案的三態；勾著幾個檔案幾處（未儲存的不算）；重推的結果裡沒有了的從「勾掉的」裡拿掉 |
 * | 替換請求 | 只帶勾著的那幾處與每份的 hash；未儲存的整份帶上並列進 `dirty`（後端跳過、彙總裡說） |
 * | 狀態與說明 | 「N 個檔案，M 處」、預覽時勾著幾處、到了上限說停在哪、沒搜的說為什麼、正則寫錯 |
 * | 彙總 | 替換了幾個檔案幾處、歷史版本是退路、跨檔案沒有一步撤銷、指紋鏈、角色卡改名、跳過了哪些 |
 * | 行列 → 下標 | 按「行 + 列」認回編輯區裡的位置（磁碟上的 \r\n 在編輯區裡是 \n）；越界夾住 |
 * | 條件比較 | 預覽之後改了輸入框、勾選範圍，就不是同一次 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const core = loadModule('media/src/editor/bookFindCore.ts');

const hit = (start, end, extra = {}) => ({ start, end, line: 1, col: start, before: '', text: '林晚', after: '', ...extra });
const file = (path, scope, hits, extra = {}) => ({ path, scope, label: path, hash: `h-${path}`, count: hits.length, hits, ...extra });

const files = [
  file('chapters/001.md', 'chapter', [hit(0, 2), hit(10, 12)]),
  file('.novelwarden/characters/林晚.md', 'character', [hit(5, 7)]),
  file('chapters/002.md', 'chapter', [hit(3, 5)]),
  file('.novelwarden/summaries/001.md', 'plot', [hit(1, 3)]),
];
const result = { files, listed: 5, scanned: 9, skipped: [] };

describe('分組', () => {
  test('按範圍分組（面板上的順序），組內順序原樣', () => {
    const groups = core.groupByScope(files);
    assert.deepEqual(groups.map((g) => [g.scope, g.label, g.files.map((f) => f.path), g.hits]), [
      ['chapter', '正文', ['chapters/001.md', 'chapters/002.md'], 3],
      ['plot', '細綱', ['.novelwarden/summaries/001.md'], 1],
      ['character', '角色卡', ['.novelwarden/characters/林晚.md'], 1],
    ]);
  });
});

describe('勾選', () => {
  const k = (f, i) => core.hitKey(f.path, f.hits[i]);

  test('檔案的三態', () => {
    assert.equal(core.fileCheck(files[0], new Set()), 'all');
    assert.equal(core.fileCheck(files[0], new Set([k(files[0], 0)])), 'some');
    assert.equal(core.fileCheck(files[0], new Set([k(files[0], 0), k(files[0], 1)])), 'none');
  });

  test('勾著幾個檔案幾處；未儲存的那幾份不算', () => {
    assert.deepEqual(core.pickedCount(files, new Set()), { files: 4, hits: 5 });
    assert.deepEqual(core.pickedCount(files, new Set([k(files[0], 0), k(files[0], 1)])), { files: 3, hits: 3 });
    assert.deepEqual(core.pickedCount(files, new Set(), new Set(['chapters/002.md'])), { files: 3, hits: 4 });
  });

  test('同一個位置、不同檔案的兩處不混', () => {
    assert.notEqual(core.hitKey('a.md', { start: 1, end: 2 }), core.hitKey('b.md', { start: 1, end: 2 }));
  });

  test('重推的結果裡已經沒有的那幾處，從「勾掉的」裡拿掉', () => {
    const stale = new Set([k(files[0], 0), core.hitKey('chapters/009.md', { start: 0, end: 2 })]);
    assert.deepEqual([...core.pruneExcluded(stale, files)], [k(files[0], 0)]);
  });
});

describe('替換請求', () => {
  const query = { query: '林晚', caseSensitive: false, regex: false, scopes: ['chapter', 'plot', 'character'], replacement: '林婉' };

  test('只帶勾著的那幾處與每份預覽時的 hash；一處都沒勾的檔案不帶', () => {
    const excluded = new Set([core.hitKey(files[0].path, files[0].hits[1]), core.hitKey(files[3].path, files[3].hits[0])]);
    const req = core.buildReplaceRequest(query, result, excluded, []);
    assert.deepEqual(req, {
      query: '林晚',
      caseSensitive: false,
      regex: false,
      replacement: '林婉',
      scopes: ['chapter', 'plot', 'character'],
      files: [
        { path: 'chapters/001.md', hash: 'h-chapters/001.md', hits: [{ start: 0, end: 2 }] },
        { path: '.novelwarden/characters/林晚.md', hash: 'h-.novelwarden/characters/林晚.md', hits: [{ start: 5, end: 7 }] },
        { path: 'chapters/002.md', hash: 'h-chapters/002.md', hits: [{ start: 3, end: 5 }] },
      ],
      dirty: [],
    });
  });

  test('未儲存的整份帶上、列進 dirty（後端跳過、彙總裡說）；沒在結果裡的未儲存檔案不列', () => {
    const excluded = new Set([core.hitKey(files[2].path, files[2].hits[0])]);
    const req = core.buildReplaceRequest(query, result, excluded, ['chapters/002.md', 'chapters/099.md']);
    assert.deepEqual(req.dirty, ['chapters/002.md']);
    assert.deepEqual(req.files.find((f) => f.path === 'chapters/002.md').hits, [{ start: 3, end: 5 }]);
  });

  test('替換框空著：換成空串（刪掉）', () => {
    assert.equal(core.buildReplaceRequest({ ...query, replacement: undefined }, result, new Set(), []).replacement, '');
  });
});

describe('狀態行與說明', () => {
  test('幾個檔案幾處；預覽時補上勾著幾處與未儲存的', () => {
    assert.equal(core.resultStatus(result), '4 個檔案，5 處');
    assert.equal(core.resultStatus(result, { files: 3, hits: 4 }, 1), '4 個檔案，5 處 · 勾著 3 個檔案 4 處；1 個檔案有未儲存的修改，會跳過');
  });

  test('沒找到、沒有可搜的、正則寫錯', () => {
    assert.equal(core.resultStatus({ files: [], listed: 0, scanned: 3, skipped: [] }), '全書沒有找到');
    assert.equal(core.resultStatus({ files: [], listed: 0, scanned: 0, skipped: [] }), '沒有可搜的檔案');
    assert.equal(core.resultStatus({ files: [], listed: 0, scanned: 0, skipped: [], error: 'x' }), '正則寫錯了');
  });

  test('到了上限：只列了前 N 處、停在哪一份上、替換隻作用於列出來的；沒搜的說為什麼', () => {
    const notes = core.resultNotes({
      ...result,
      truncated: { limit: 1000, at: '第 12 章 夜訪' },
      skipped: [{ path: 'chapters/020.md', label: '第 20 章', reason: '超過 2 MB，沒有搜' }],
    });
    assert.match(notes[0], /只列了前 1000 處：搜到「第 12 章 夜訪」就停了/);
    assert.match(notes[0], /替換也只作用於列出來的這些/);
    assert.equal(notes[1], '1 個檔案沒有搜：第 20 章（超過 2 MB，沒有搜）');
  });
});

describe('彙總', () => {
  const summary = {
    files: 3,
    hits: 7,
    replaced: [],
    skipped: [
      { path: 'chapters/002.md', label: '第 2 章 下山', reason: 'dirty', message: '編輯器裡有未儲存的修改：先儲存（或放棄修改），再替換一次。' },
    ],
    chainKept: ['第 1 章 入宗'],
    plotOnly: ['第 2 章 下山'],
    bodyOnly: ['第 3 章 夜訪'],
    renamedCards: [
      { path: '.novelwarden/characters/林晚.md', label: '角色 · 林晚', name: '林婉', nameChanged: true },
      { path: '.novelwarden/characters/老周.md', label: '角色 · 老周', name: '老周', nameChanged: false },
    ],
  };

  test('替換了幾個檔案幾處；歷史版本是退路；跨檔案沒有一步撤銷', () => {
    const lines = core.summaryLines(summary).map((l) => l.text);
    assert.equal(lines[0], '替換了 3 個檔案、共 7 處。');
    assert.match(lines[1], /每個改過的檔案都可以在「歷史」裡找回替換前那一版/);
    assert.match(lines[1], /跨檔案的替換沒有一步撤銷/);
  });

  test('指紋鏈、角色卡改名、跳過的說明都在，警告的那幾句標出來', () => {
    const lines = core.summaryLines(summary);
    const text = lines.map((l) => l.text).join('\n');
    assert.match(text, /第 1 章 入宗：細綱與正文這次一起改了，指紋跟著重新整理/);
    assert.match(text, /第 2 章 下山：只改了細綱、正文沒跟著改，正文會掛 ⟳/);
    assert.match(text, /第 3 章 夜訪：只改了正文、細綱沒跟著改，回到「待同步」/);
    assert.match(text, /角色 · 林晚：卡裡的名字改成了「林婉」，檔名沒跟著改/);
    assert.match(text, /角色 · 老周：別名改了/);
    assert.match(text, /跳過了 1 個檔案：/);
    assert.match(text, /第 2 章 下山——編輯器裡有未儲存的修改/);
    assert.equal(lines.find((l) => l.text.includes('只改了細綱')).tone, 'warn');
  });

  test('一處都沒換、整個沒做', () => {
    const none = core.summaryLines({ ...summary, files: 0, hits: 0, chainKept: [], plotOnly: [], bodyOnly: [], renamedCards: [], skipped: [] });
    assert.deepEqual(none.map((l) => l.text), ['一處都沒有替換。']);
    assert.deepEqual(core.summaryLines({ ...summary, error: '正則寫錯了' }), [{ text: '正則寫錯了', tone: 'error' }]);
  });

  test('章多了只點五個名', () => {
    assert.equal(core.listLabels(['1', '2', '3', '4', '5', '6', '7']), '1、2、3、4、5 等 7 個');
  });
});

describe('行列 → 編輯區裡的下標', () => {
  test('按行列認（磁碟上的 \\r\\n 到了編輯區裡是 \\n，按下標會差）', () => {
    const text = '第一行\n第二行林晚\n第三行';
    assert.equal(core.offsetAt(text, 2, 3), text.indexOf('林晚'));
    assert.equal(core.offsetAt(text, 1, 0), 0);
  });

  test('越界夾住', () => {
    const text = '甲\n乙';
    assert.equal(core.offsetAt(text, 1, 99), 1);
    assert.equal(core.offsetAt(text, 9, 0), text.length);
  });
});

describe('條件比較', () => {
  const q = { query: '林晚', caseSensitive: false, regex: false, scopes: ['chapter'], replacement: '林婉' };
  test('一樣的才算一樣', () => {
    assert.equal(core.sameQuery(q, { ...q }), true);
    assert.equal(core.sameQuery(q, { ...q, replacement: '林苑' }), false);
    assert.equal(core.sameQuery(q, { ...q, scopes: ['chapter', 'plot'] }), false);
    assert.equal(core.sameQuery(q, { ...q, regex: true }), false);
    assert.equal(core.sameQuery(null, q), false);
  });
});
