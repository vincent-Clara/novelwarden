/**
 * 全書查詢替換在一份檔案上的口徑（`src/core/model/bookFind.ts`）與範圍表（`model/bookFindScope.ts`）。
 * 讀盤、按範圍列檔案、上限在 tests/integration/views/bookFind.test.js；替換在 tests/integration/features/bookReplace.test.js。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 匹配口徑 | 與內建編輯器的查詢條同一份（`textFind`）：大小寫、正則、零長度跳過、跨行 |
 * | 護住的字 | frontmatter 的圍欄、鍵名、機器記的賬（指紋、章號、字數、水位、狀態位）不搜；名字 / 別名 / 標題 / cast 這些人寫的值照搜；解析器認的小節標題不搜（設定條目的「暗設」以它開頭就算）；大綱區間標題只護「第 a–b 章」那一截；正文、草稿一個字都不護 |
 * | 上下文 | 行號、列、同一行裡前後一截（截過帶「…」）、跨行畫成「↵」、`\r\n` 不進上下文 |
 * | 預覽 | 每一處換成什麼：字面量原樣，正則 `$1` 在全文裡逐處展開 |
 * | 範圍表 | 六個範圍、預設只勾正文、`isBookFindScope` |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const bf = loadModule('src/core/model/bookFind.ts');
const scope = loadModule('src/core/model/bookFindScope.ts');
const tf = loadModule('src/core/model/textFind.ts');

/** 一份檔案裡能搜到的字，按順序。 */
const found = (text, kind, query, opts) => bf.fileHits(text, kind, query, opts).matches.map((m) => text.slice(m.start, m.end));

describe('匹配口徑與查詢條同一份', () => {
  const text = '林晚推門。\n林晚霞沒說話。LIN lin\n';

  test('正文一個字都不護：結果與 textFind.findMatches 完全一樣', () => {
    for (const [q, o] of [['林晚', {}], ['lin', {}], ['lin', { caseSensitive: true }], ['^林', { regex: true }], ['a*', { regex: true }]]) {
      assert.deepEqual(bf.fileHits(text, 'chapter', q, o).matches, tf.findMatches(text, q, o).matches, `${q} ${JSON.stringify(o)}`);
    }
  });

  test('零長度匹配跳過；正則可以跨行', () => {
    assert.deepEqual(found(text, 'chapter', '^', { regex: true }), []);
    assert.deepEqual(found(text, 'chapter', '。\\n林', { regex: true }), ['。\n林']);
  });

  test('正則寫錯：error，不拋', () => {
    const r = bf.fileHits(text, 'chapter', '(', { regex: true });
    assert.ok(r.error);
    assert.deepEqual(r.matches, []);
  });
});

describe('護住的字：frontmatter', () => {
  const plot = [
    '---',
    'no: 3',
    'title: 林晚夜訪',
    'targetWords: 3000',
    'upstreamHash: a3f3',
    'writtenFrom: 33bb',
    'sourceHash: 3c3c',
    'cast: [林晚(阿晚), 老周]',
    'status: done',
    'generatedBy: novelwarden',
    '---',
    '',
    '# 第3章 林晚夜訪',
    '',
    '## 梗概',
    '林晚在第3個夜裡出門。',
    '',
  ].join('\n');

  test('人寫的值照搜：標題、cast；正文照搜', () => {
    assert.deepEqual(found(plot, 'plot', '林晚'), ['林晚', '林晚', '林晚', '林晚']);
  });

  test('機器記的賬不搜：章號、字數、指紋、狀態位裡的「3」一個都不列', () => {
    const at = bf.fileHits(plot, 'plot', '3').matches.map((m) => plot.slice(0, m.start).split('\n').length);
    // 只剩 `# 第3章` 那一行（第 13 行）與正文那一行（第 16 行）。
    assert.deepEqual(at, [13, 16]);
  });

  test('鍵名與圍欄不搜', () => {
    assert.deepEqual(found(plot, 'plot', 'title'), []);
    assert.deepEqual(found(plot, 'plot', '---'), []);
    assert.deepEqual(found(plot, 'plot', 'Hash'), []);
  });

  test('從人寫的值伸到下一行的匹配（跨行正則）不算', () => {
    assert.deepEqual(found(plot, 'plot', '夜訪\\ntargetWords', { regex: true }), []);
  });

  test('塊狀陣列：人寫的鍵下面的條目照搜，機器的鍵下面的不搜', () => {
    const card = ['---', 'name: 林晚', 'aliases:', '  - 阿晚', '  - 晚兒', 'appearsIn:', '  - 3', '  - 13', '---', '', '# 林晚', ''].join('\n');
    // name、兩條別名、`# 林晚` 標題行：四處；appearsIn 下面的 3、13 不列。
    assert.deepEqual(found(card, 'character', '晚'), ['晚', '晚', '晚', '晚']);
    assert.deepEqual(found(card, 'character', '3'), []);
  });

  test('CRLF 的 frontmatter 一樣認；值裡不含行尾的 \\r', () => {
    const crlf = '---\r\nname: 林晚\r\nstateHash: 3\r\n---\r\n\r\n# 林晚\r\n';
    assert.deepEqual(found(crlf, 'character', '林晚'), ['林晚', '林晚']);
    assert.deepEqual(found(crlf, 'character', '3'), []);
    assert.deepEqual(found('---\r\nname: 林晚\r\n---\r\n\r\n正文', 'character', '晚\\r', { regex: true }), []);
  });

  test('BOM 開頭的 frontmatter 一樣認', () => {
    const bom = '﻿---\nname: 林晚\nbodyHash: 33\n---\n\n正文 33';
    assert.deepEqual(bf.fileHits(bom, 'lore', '33').matches.length, 1);
  });

  test('正文與草稿不護：章節檔案開頭即使寫了 frontmatter 也照搜', () => {
    const chapter = '---\nno: 3\n---\n\n第3章';
    assert.equal(found(chapter, 'chapter', '3').length, 2);
    assert.equal(found(chapter, 'draft', '3').length, 2);
  });

  test('機器記的賬覆蓋第 18 條的五個指紋與水位、狀態位', () => {
    for (const key of ['upstreamHash', 'writtenFrom', 'sourceHash', 'stateHash', 'bodyHash', 'no', 'targetWords', 'updatedThrough', 'stateThrough', 'appearsIn', 'through', 'status', 'generatedBy', 'paragraphStyle']) {
      assert.ok(bf.MACHINE_FRONTMATTER_KEYS.has(key), key);
    }
    for (const key of ['name', 'aliases', 'title', 'cast', 'keywords', 'brief', 'tags']) {
      assert.ok(!bf.MACHINE_FRONTMATTER_KEYS.has(key), key);
    }
  });
});

describe('護住的字：解析器認的小節標題', () => {
  test('細綱的七節與「設定」一節的標題行不搜，內容照搜', () => {
    const plot = '## 關鍵事件\n- 發生關鍵事件\n\n## 設定\n- 關鍵〔物品〕：一把鑰匙\n\n### 關鍵事件：\n';
    assert.deepEqual(found(plot, 'plot', '關鍵'), ['關鍵', '關鍵']);
    assert.deepEqual(found(plot, 'plot', '設定'), []);
  });

  test('作者自加的小節標題照搜', () => {
    assert.deepEqual(found('## 關鍵事件補記\n', 'plot', '事件'), ['事件']);
  });

  test('角色卡、設定條目、架構、文風各認各的', () => {
    assert.deepEqual(found('## 當前狀態\n狀態良好', 'character', '狀態'), ['狀態']);
    assert.deepEqual(found('## 現狀\n現狀如此', 'lore', '現狀'), ['現狀']);
    assert.deepEqual(found('## 金手指\n他的金手指', 'setting', '金手指'), ['金手指']);
    assert.deepEqual(found('## 禁用詞表\n- 禁用「頓時」', 'style', '禁用'), ['禁用']);
    // 種類對不上就不護：正文裡的「## 當前狀態」是作者寫的字。
    assert.deepEqual(found('## 當前狀態\n', 'chapter', '狀態'), ['狀態']);
  });

  test('設定條目的「暗設」：以它開頭的標題整行不搜（「## 暗設（未揭示）」也算），內容照搜', () => {
    const entry = '## 現狀\n閣主閉關\n\n## 暗設（未揭示）\n閣主是暗設的主使\n\n## 暗設\n未揭示的舊事\n\n## 暗中\n暗中行事\n';
    assert.deepEqual(found(entry, 'lore', '暗設'), ['暗設']);
    assert.deepEqual(found(entry, 'lore', '未揭示'), ['未揭示']);
    // 只護設定條目：別的種類裡的「## 暗設」是作者寫的字。
    assert.deepEqual(found('## 暗設\n', 'plot', '暗設'), ['暗設']);
  });
});

describe('每一處那一行的上下文', () => {
  test('行號、列、前後一截', () => {
    const text = '第一行\n林晚推開門，走了進去。\n';
    const [h] = bf.describeHits(text, bf.fileHits(text, 'chapter', '推開').matches);
    assert.deepEqual(
      { line: h.line, col: h.col, before: h.before, text: h.text, after: h.after },
      { line: 2, col: 2, before: '林晚', text: '推開', after: '門，走了進去。' }
    );
  });

  test('長行截斷：前後帶「…」', () => {
    const text = `${'甲'.repeat(60)}林晚${'乙'.repeat(80)}`;
    const [h] = bf.describeHits(text, bf.fileHits(text, 'chapter', '林晚').matches);
    assert.ok(h.before.startsWith('…'));
    assert.ok(h.after.endsWith('…'));
    assert.equal(h.before.length, scope.BOOK_FIND_CONTEXT.before + 1);
    assert.equal(h.after.length, scope.BOOK_FIND_CONTEXT.after + 1);
  });

  test('同一行幾處、跨好幾行：行號逐處往下數', () => {
    const text = '林\n\n林林\n林';
    const lines = bf.describeHits(text, bf.fileHits(text, 'chapter', '林').matches).map((h) => [h.line, h.col]);
    assert.deepEqual(lines, [[1, 0], [3, 0], [3, 1], [4, 0]]);
  });

  test('跨行的匹配畫成「↵」；CRLF 的 \\r 不進上下文', () => {
    const text = '上一行末尾\r\n下一行開頭\r\n';
    const ms = bf.fileHits(text, 'chapter', '末尾\\r?\\n下', { regex: true }).matches;
    const [h] = bf.describeHits(text, ms);
    assert.equal(h.text, '末尾↵下');
    assert.equal(h.after, '一行開頭');
    const [g] = bf.describeHits(text, bf.fileHits(text, 'chapter', '下一行').matches);
    assert.equal(g.after, '開頭');
    assert.equal(g.line, 2);
  });
});

describe('預覽：每一處換成什麼', () => {
  test('字面量原樣；正則 $1 在全文裡逐處展開', () => {
    const text = '第1章 第2章';
    const lit = bf.fileHits(text, 'chapter', '章').matches;
    assert.deepEqual(bf.replacementsAt(text, lit, '章', '$1節'), ['$1節', '$1節']);
    const re = bf.fileHits(text, 'chapter', '第(\\d)章', { regex: true }).matches;
    assert.deepEqual(bf.replacementsAt(text, re, '第(\\d)章', 'Ch$1', { regex: true }), ['Ch1', 'Ch2']);
  });

  test('與 textFind.replaceSelectedIn 換出來的是同一個樣子', () => {
    const text = '林晚說：「晚了。」林晚走了。';
    const ms = bf.fileHits(text, 'chapter', '(林)晚', { regex: true }).matches;
    const shown = bf.replacementsAt(text, ms, '(林)晚', '$1婉', { regex: true });
    const applied = tf.replaceSelectedIn(text, ms, '(林)晚', '$1婉', { regex: true }).text;
    let rebuilt = '';
    let last = 0;
    ms.forEach((m, i) => {
      rebuilt += text.slice(last, m.start) + shown[i];
      last = m.end;
    });
    assert.equal(rebuilt + text.slice(last), applied);
  });
});

describe('範圍表', () => {
  test('六個範圍，預設只勾正文', () => {
    assert.deepEqual([...scope.BOOK_FIND_SCOPES], ['chapter', 'plot', 'draft', 'character', 'lore', 'doc']);
    assert.deepEqual([...scope.DEFAULT_BOOK_FIND_SCOPES], ['chapter']);
    for (const s of scope.BOOK_FIND_SCOPES) {
      assert.ok(scope.BOOK_FIND_SCOPE_LABEL[s] && scope.BOOK_FIND_SCOPE_HINT[s], s);
    }
  });

  test('isBookFindScope 只認表裡的', () => {
    assert.equal(scope.isBookFindScope('plot'), true);
    assert.equal(scope.isBookFindScope('skill'), false);
    assert.equal(scope.isBookFindScope(3), false);
  });
});
