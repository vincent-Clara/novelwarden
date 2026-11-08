/**
 * Markdown 預覽的純函式（`media/src/editor/previewCore.ts`，零 DOM）：切塊時每一塊記下的源行號（標題、段落、列表、程式碼塊、
 * frontmatter、分隔線、引用），以及切預覽 / 切回編輯時兩邊滾到同一處的換算——編輯區裡「縱向位置 ↔ 第幾行（帶小數）」
 * 與預覽裡「第幾行 ↔ 縱向位置」。按標籤記住、真的滾到哪在 tests/dom/standalone/preview.test.js。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const { previewBlocks, sourceToPreviewY, previewYToSource, lineAtY, yOfLine, lineStarts, lineOfOffset } = loadModule(
  'media/src/editor/previewCore.ts'
);

/** 每一塊：種類與 [start, end)（列表另列每一項）。 */
const spans = (text) =>
  previewBlocks(text).map((b) =>
    b.kind === 'list' ? [b.kind, b.start, b.end, b.items.map((i) => [i.start, i.end, i.text])] : [b.kind, b.start, b.end]
  );

describe('previewBlocks：每一塊是原始檔的第幾行到第幾行', () => {
  test('frontmatter 是開頭那一段連同兩條 ---；標題一行一塊（h4 以下當 h3）', () => {
    const text = '---\ntitle: 夜訪\nno: 3\n---\n# 第三章\n\n#### 小節\n';
    assert.deepEqual(spans(text), [
      ['frontmatter', 0, 4],
      ['heading', 4, 5],
      ['heading', 6, 7],
    ]);
    const blocks = previewBlocks(text);
    assert.equal(blocks[0].text, 'title: 夜訪\nno: 3');
    assert.deepEqual([blocks[1].level, blocks[2].level], [1, 3]);
  });

  test('沒有收尾的 --- 不算 frontmatter（第一行當分隔線）', () => {
    assert.deepEqual(spans('---\n正文第一行'), [
      ['hr', 0, 1],
      ['paragraph', 1, 2],
    ]);
  });

  test('段落：連著的幾行是一段，空行斷開；段首縮排的正文沒有空行，整段連成一塊', () => {
    assert.deepEqual(spans('雨下了三天。\n\n林昭推門進來，\n帶進一身溼氣。\n\n'), [
      ['paragraph', 0, 1],
      ['paragraph', 2, 4],
    ]);
    assert.deepEqual(spans('　　第一段。\n　　第二段。\n　　第三段。'), [['paragraph', 0, 3]]);
  });

  test('程式碼塊從開頭那條 ``` 到收尾那條；沒收尾就到文末', () => {
    assert.deepEqual(spans('前\n```\na\nb\n```\n後'), [
      ['paragraph', 0, 1],
      ['code', 1, 5],
      ['paragraph', 5, 6],
    ]);
    assert.equal(previewBlocks('```\na\nb\n```').at(0).text, 'a\nb');
    assert.deepEqual(spans('前\n```\na\nb'), [
      ['paragraph', 0, 1],
      ['code', 1, 4],
    ]);
  });

  test('列表：連著的同一種列表項是一張表，每一項一行；換一種另起一張，空行結束', () => {
    assert.deepEqual(spans('- 甲\n- 乙\n1. 一\n2) 二\n\n* 丙'), [
      ['list', 0, 2, [[0, 1, '甲'], [1, 2, '乙']]],
      ['list', 2, 4, [[2, 3, '一'], [3, 4, '二']]],
      ['list', 5, 6, [[5, 6, '丙']]],
    ]);
  });

  test('引用一行一塊；分隔線一行一塊；段落碰到它們就斷開', () => {
    assert.deepEqual(spans('一段\n> 引一\n> 引二\n***\n又一段'), [
      ['paragraph', 0, 1],
      ['quote', 1, 2],
      ['quote', 2, 3],
      ['hr', 3, 4],
      ['paragraph', 4, 5],
    ]);
  });

  test('\\r\\n 與 \\n 切出來的行號一樣（textarea 裡是 \\n）', () => {
    const lf = '---\na: 1\n---\n# 題\n\n正文\n- 項';
    assert.deepEqual(spans(lf.replace(/\n/g, '\r\n')), spans(lf));
  });

  test('各塊（列表按項）互不重疊、按行號排好', () => {
    const text = '---\na: 1\n---\n# 題\n\n一段\n兩行\n\n- 甲\n- 乙\n\n```\ncode\n```\n> 引\n---\n尾';
    const leaves = previewBlocks(text).flatMap((b) => (b.kind === 'list' ? b.items : [b]));
    for (let i = 1; i < leaves.length; i++) {
      assert.ok(leaves[i].start >= leaves[i - 1].end, JSON.stringify([leaves[i - 1], leaves[i]]));
    }
  });
});

describe('預覽裡：第幾行 ↔ 縱向位置', () => {
  // 第 2–3 行一塊（高 100，頂 40），第 6 行一塊（高 30，頂 200），第 7–9 行一塊（高 90，頂 250）。
  const boxes = [
    { start: 2, end: 4, top: 40, height: 100 },
    { start: 6, end: 7, top: 200, height: 30 },
    { start: 7, end: 10, top: 250, height: 90 },
  ];

  test('落在一塊裡：按它佔這一塊幾行的比例擺', () => {
    assert.equal(sourceToPreviewY(boxes, 2), 40);
    assert.equal(sourceToPreviewY(boxes, 3), 90);
    assert.equal(sourceToPreviewY(boxes, 8.5), 295);
  });

  test('落在兩塊之間的空行上：在上一塊的底與下一塊的頂之間按比例擺', () => {
    assert.equal(sourceToPreviewY(boxes, 4), 140);
    assert.equal(sourceToPreviewY(boxes, 5), 170);
  });

  test('第一塊之前從 0 擺到它的頂；最後一塊之後是它的底；一塊都沒有是 0', () => {
    assert.equal(sourceToPreviewY(boxes, 0), 0);
    assert.equal(sourceToPreviewY(boxes, 1), 20);
    assert.equal(sourceToPreviewY(boxes, 12), 340);
    assert.equal(sourceToPreviewY([], 5), 0);
  });

  test('反過來：縱向位置 → 第幾行', () => {
    assert.equal(previewYToSource(boxes, 0), 0);
    assert.equal(previewYToSource(boxes, 20), 1);
    assert.equal(previewYToSource(boxes, 90), 3);
    assert.equal(previewYToSource(boxes, 170), 5);
    assert.equal(previewYToSource(boxes, 999), 10);
    assert.equal(previewYToSource([], 50), 0);
  });

  test('來回換一遍回到原處（塊裡、空行上都是）', () => {
    for (const pos of [0, 0.5, 2, 2.25, 3.9, 4.5, 6, 7.75, 9.5]) {
      assert.ok(Math.abs(previewYToSource(boxes, sourceToPreviewY(boxes, pos)) - pos) < 1e-9, String(pos));
    }
  });

  test('高為 0 的塊（量不出高）不除以 0', () => {
    const flat = [{ start: 0, end: 2, top: 0, height: 0 }, { start: 3, end: 4, top: 0, height: 0 }];
    assert.equal(Number.isFinite(sourceToPreviewY(flat, 1)), true);
    assert.equal(Number.isFinite(previewYToSource(flat, 0)), true);
  });
});

describe('編輯區裡：縱向位置 ↔ 第幾行（帶小數）', () => {
  // 五行：第 2 行折成三行（高 90），其餘一行 30。
  const heights = [30, 30, 90, 30, 30];
  const tops = heights.reduce((acc, h) => [...acc, acc[acc.length - 1] + h], [0]);
  let measured = 0;
  const topOf = (i) => {
    measured++;
    return tops[i];
  };

  test('落在哪一行、往下幾成：第 2 行一半是 2.5', () => {
    assert.equal(lineAtY(5, topOf, 0), 0);
    assert.equal(lineAtY(5, topOf, 45), 1.5);
    assert.equal(lineAtY(5, topOf, 105), 2.5);
    assert.equal(lineAtY(5, topOf, 150), 3);
    assert.equal(lineAtY(5, topOf, 9999), 5);
  });

  test('反過來：第幾行 → 縱向位置；越界夾住', () => {
    assert.equal(yOfLine(5, topOf, 2.5), 105);
    assert.equal(yOfLine(5, topOf, 0), 0);
    assert.equal(yOfLine(5, topOf, 7), 210);
    assert.equal(yOfLine(5, topOf, -1), 0);
  });

  test('二分：一千行只量十來次', () => {
    measured = 0;
    lineAtY(1000, (i) => {
      measured++;
      return i * 30;
    }, 12345);
    assert.ok(measured <= 14, `量了 ${measured} 次`);
  });

  test('沒有行時是 0', () => {
    assert.equal(lineAtY(0, topOf, 50), 0);
    assert.equal(yOfLine(0, topOf, 3), 0);
  });
});

describe('行首與行號', () => {
  test('lineStarts：每一行開頭的下標；lineOfOffset：下標落在第幾行', () => {
    const starts = lineStarts('ab\n\ncd\n');
    assert.deepEqual(starts, [0, 3, 4, 7]);
    assert.deepEqual([0, 2, 3, 4, 6, 7].map((o) => lineOfOffset(starts, o)), [0, 0, 1, 2, 2, 3]);
  });
});
