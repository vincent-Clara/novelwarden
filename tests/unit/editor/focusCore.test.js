/**
 * 段落聚焦認「游標在哪一段」與打字機滾動算「該滾到哪」（`media/src/editor/focusCore.ts`，純函式、零 DOM）。
 * 分段按工程的三種分段格式認：空行分段（`blank`）/ 段首縮排（`indent`）/ 兩者都要（`both`）。
 * 圖層與滾動本身在 tests/dom/standalone/focus.test.js。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const { paragraphRangeAt, typewriterScrollTop } = loadModule('media/src/editor/focusCore.ts');

const I = '　　';
/** 游標停在 `marker` 那幾個字前面時，當前段的文字。 */
const paraAt = (text, marker, style, offset = 0) => {
  const caret = text.indexOf(marker) + offset;
  assert.ok(caret >= 0, `找不到 ${marker}`);
  const r = paragraphRangeAt(text, caret, style);
  return text.slice(r.start, r.end);
};

describe('段落聚焦：空行分段（blank）', () => {
  const text = '第一段。\n\n第二段前半，\n續行（Shift+Enter 打的）。\n\n第三段。';

  test('空行隔開的一整塊是一段', () => {
    assert.equal(paraAt(text, '第一段', 'blank'), '第一段。');
  });

  test('塊裡不空行的換行仍在這一段裡（游標在第一行）', () => {
    assert.equal(paraAt(text, '第二段', 'blank'), '第二段前半，\n續行（Shift+Enter 打的）。');
  });

  test('游標在續行裡：同一段', () => {
    assert.equal(paraAt(text, '續行', 'blank'), '第二段前半，\n續行（Shift+Enter 打的）。');
  });

  test('最後一段（文末沒有換行）', () => {
    assert.equal(paraAt(text, '第三段', 'blank'), '第三段。');
  });

  test('游標在行尾（換行之前）仍算這一段', () => {
    assert.equal(paraAt(text, '第一段。', 'blank', 4), '第一段。');
  });

  test('游標落在空行上：那一段就是這一行（空的）', () => {
    const r = paragraphRangeAt(text, text.indexOf('\n\n') + 1, 'blank');
    assert.deepEqual(r, { start: text.indexOf('\n\n') + 1, end: text.indexOf('\n\n') + 1 });
  });

  test('空行分段裡行首有縮排也不另起一段', () => {
    const t = `${I}甲。\n${I}乙。\n\n丙。`;
    assert.equal(paraAt(t, '乙', 'blank'), `${I}甲。\n${I}乙。`);
  });

  test('標題行自成一段（後面緊跟正文也不連上）', () => {
    const t = '# 第一章\n正文第一行。\n正文第二行。';
    assert.deepEqual([paraAt(t, '第一章', 'blank'), paraAt(t, '正文第二行', 'blank')], ['# 第一章', '正文第一行。\n正文第二行。']);
  });

  test('場景分隔行自成一段', () => {
    const t = '前文。\n* * *\n後文。';
    assert.deepEqual([paraAt(t, '* * *', 'blank'), paraAt(t, '後文', 'blank')], ['* * *', '後文。']);
  });

  test('只有空白的行算空行（全形空格、製表符）', () => {
    const t = `甲。\n${I}\t\n乙。`;
    assert.equal(paraAt(t, '乙', 'blank'), '乙。');
  });

  test('空檔案：游標在 0，段是空的', () => {
    assert.deepEqual(paragraphRangeAt('', 0, 'blank'), { start: 0, end: 0 });
  });

  test('游標越界夾進去，不拋', () => {
    assert.deepEqual(paragraphRangeAt('甲\n乙', 99, 'blank'), { start: 0, end: 3 });
  });
});

describe('段落聚焦：段首縮排（indent）', () => {
  const text = `${I}第一段。\n${I}第二段前半，\n續行（Shift+Enter 打的）。\n${I}第三段。`;

  test('行首有縮排的那一行另起一段', () => {
    assert.equal(paraAt(text, '第一段', 'indent'), `${I}第一段。`);
  });

  test('行首沒縮排、緊跟在一行字後面的是上一段的續行', () => {
    assert.equal(paraAt(text, '續行', 'indent'), `${I}第二段前半，\n續行（Shift+Enter 打的）。`);
  });

  test('游標在段首的縮排裡：仍是這一段', () => {
    assert.equal(paraAt(text, `${I}第三段`, 'indent', 1), `${I}第三段。`);
  });

  test('半形空格縮排也認', () => {
    const t = '  甲。\n  乙。';
    assert.equal(paraAt(t, '乙', 'indent'), '  乙。');
  });

  test('空行也隔開段落', () => {
    const t = `${I}甲。\n\n乙。`;
    assert.equal(paraAt(t, '乙', 'indent'), '乙。');
  });

  test('標題後面的第一段（有縮排）與標題分開', () => {
    const t = `# 第一章\n${I}正文。`;
    assert.equal(paraAt(t, '正文', 'indent'), `${I}正文。`);
  });

  test('文首那一行沒縮排（章名）自成一段，下一行有縮排另起', () => {
    const t = `第一章 風起\n${I}正文。`;
    assert.deepEqual([paraAt(t, '風起', 'indent'), paraAt(t, '正文', 'indent')], ['第一章 風起', `${I}正文。`]);
  });
});

describe('段落聚焦：縮排加空行（both）', () => {
  test('空行隔開', () => {
    const t = `${I}甲。\n\n${I}乙。`;
    assert.equal(paraAt(t, '乙', 'both'), `${I}乙。`);
  });

  test('塊裡行首有縮排的那一行也另起一段', () => {
    const t = `${I}甲。\n${I}乙。\n\n${I}丙。`;
    assert.deepEqual([paraAt(t, '甲', 'both'), paraAt(t, '乙', 'both')], [`${I}甲。`, `${I}乙。`]);
  });

  test('塊裡行首沒縮排的是續行', () => {
    const t = `${I}甲，\n接著甲。\n\n${I}乙。`;
    assert.equal(paraAt(t, '接著', 'both'), `${I}甲，\n接著甲。`);
  });

  test('同一份文字，空行分段把兩行縮排當一段、兩者都要分成兩段', () => {
    const t = `${I}甲。\n${I}乙。`;
    assert.deepEqual([paraAt(t, '乙', 'blank'), paraAt(t, '乙', 'both')], [t, `${I}乙。`]);
  });
});

describe('打字機滾動：該滾到哪', () => {
  test('游標那一行的中線落在視口中間', () => {
    // 行頂 600、行高 30，視口 300：中線 615 - 150 = 465。
    assert.equal(typewriterScrollTop(600, 30, 300, 0), 465);
  });

  test('已經在中間（差不到 1px）：不動', () => {
    assert.equal(typewriterScrollTop(600, 30, 300, 465), undefined);
  });

  test('開頭幾行滾不到中間：夾到 0', () => {
    assert.equal(typewriterScrollTop(18, 30, 300, 120), 0);
  });

  test('已經在 0、游標在開頭：不動', () => {
    assert.equal(typewriterScrollTop(18, 30, 300, 0), undefined);
  });

  test('取整畫素', () => {
    assert.equal(typewriterScrollTop(100.4, 29.5, 300, 50), 0);
    assert.equal(typewriterScrollTop(400.4, 29.5, 300, 0), 265);
  });
});
