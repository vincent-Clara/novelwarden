/**
 * 情節大綱一章一條（model/outlineFile.ts，docs/design/plans/2026-10-21-outline-per-chapter.md）。
 *
 * 幾處要用它：續寫大綱時判「覆蓋到第幾章」、細綱按「這一章那一條」記上游指紋、裝配時按遠近帶
 * （最近 10 章整條，再往前一章一行、最多 N 章，更早的交給全文大綱；拆細綱只帶要拆的）、續寫的那一段落盤時按章號合併。區間標題（舊格式）不認。
 * 解析一律不拋（第 1 條）。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

let O;
before(() => {
  O = loadModule('src/core/model/outlineFile.ts');
});

const OUTLINE = [
  '# 情節大綱',
  '',
  '全書一句話：少年夜渡青河。',
  '',
  '## 第1章：雪夜',
  '林昭出逃，在渡口被沈青攔下。',
  '沈青放他過河，要他欠一個人情。',
  '',
  '### 第2章 入宗',
  '林昭拿半枚令牌入宗。',
  '',
  '## 第3章',
  '',
  '## 後續概覽',
  '第二幕只寫一行。',
].join('\n');

/** 第 1–n 章，一章一條，第一行「第N章的事。」，第二行「第N章的後果。」 */
function entries(n, from = 1) {
  const out = [];
  for (let no = from; no <= n; no++) {
    out.push(`## 第${no}章：標題${no}`, `第${no}章的事。`, `第${no}章的後果。`, '');
  }
  return out.join('\n');
}

describe('parseOutline', () => {
  test('認出全部章標題，按出現順序；標題取冒號後面那一段（冒號可有可無）', () => {
    assert.deepEqual(
      O.parseOutline(OUTLINE).map((e) => [e.no, e.title]),
      [
        [1, '雪夜'],
        [2, '入宗'],
        [3, ''],
      ]
    );
  });

  test('一條到下一個同級或更高階標題為止；「## 後續概覽」不算進第 3 章', () => {
    const [first, , third] = O.parseOutline(OUTLINE);
    assert.equal(first.text, '林昭出逃，在渡口被沈青攔下。\n沈青放他過河，要他欠一個人情。');
    assert.equal(third.text, '');
  });

  for (const line of ['## 第12章：標題', '## 第 12 章 標題', '### 第12章:標題', '##第12章']) {
    test(`寫法：${line}`, () => {
      assert.deepEqual(O.parseOutline(`${line}\n正文`).map((e) => e.no), [12]);
    });
  }

  for (const line of ['## 第1–20章：第一幕', '## 第1章-第4章：區間', '## 第21 至 40 章', '## 第一章：中文數字', '# 第12章：一級標題', '## 第3節']) {
    test(`不認：${line}`, () => {
      assert.deepEqual(O.parseOutline(`${line}\n正文`), []);
    });
  }

  test('區間標題結束上一條，自己那一節被忽略', () => {
    const text = '## 第1章：甲\n甲的事。\n\n## 第2–4章：舊格式\n舊的事。\n\n## 第5章：乙\n乙的事。';
    assert.deepEqual(
      O.parseOutline(text).map((e) => [e.no, e.text]),
      [
        [1, '甲的事。'],
        [5, '乙的事。'],
      ]
    );
    assert.equal(O.outlineRangeHeadings(text), 1);
  });

  test('空串、undefined、只有 BOM 都不拋', () => {
    assert.deepEqual(O.parseOutline(''), []);
    assert.deepEqual(O.parseOutline(undefined), []);
    assert.deepEqual(O.parseOutline('﻿'), []);
  });

  test('CRLF 也認', () => {
    assert.deepEqual(O.parseOutline('## 第1章：甲\r\n甲的事。\r\n').map((e) => [e.no, e.text]), [[1, '甲的事。']]);
  });
});

describe('outlineCoverage / isOutlineFilled / hasOutlineContent', () => {
  test('覆蓋到最大的章號', () => {
    assert.equal(O.outlineCoverage(OUTLINE), 3);
    assert.equal(O.outlineCoverage(entries(20)), 20);
  });

  test('舊格式（只有區間標題）：沒寫過、覆蓋 0，但有內容', () => {
    const old = '## 第1–20章：第一幕\n林昭入宗。';
    assert.equal(O.isOutlineFilled(old), false);
    assert.equal(O.outlineCoverage(old), 0);
    assert.equal(O.hasOutlineContent(old), true);
  });

  test('散文式（一個章標題都沒有）：沒寫過、覆蓋 0，但有內容', () => {
    assert.equal(O.isOutlineFilled('林昭入宗，後來下山。'), false);
    assert.equal(O.outlineCoverage('林昭入宗，後來下山。'), 0);
    assert.equal(O.hasOutlineContent('林昭入宗，後來下山。'), true);
  });

  test('模板腳手架（> 說明、括號提示、空的 1. 與 -）：沒寫過，也沒有內容', () => {
    const scaffold = '# 情節大綱\n\n> 一章一條。\n\n（寫一句話概括全書。）\n\n1.\n-\n';
    assert.equal(O.isOutlineFilled(scaffold), false);
    assert.equal(O.hasOutlineContent(scaffold), false);
    assert.equal(O.outlineCoverage(scaffold), 0);
  });

  test('認得出一章就算寫過（只有標題也算）', () => {
    assert.equal(O.isOutlineFilled('## 第3章：甲'), true);
  });
});

describe('outlineEntryFor / outlineOverlaps', () => {
  test('第 N 章那一條；出現兩次取先出現的；沒有就 undefined', () => {
    const text = '## 第2章：先\n先的事。\n\n## 第2章：後\n後的事。';
    assert.equal(O.outlineEntryFor(text, 2).title, '先');
    assert.equal(O.outlineEntryFor(text, 3), undefined);
  });

  test('區間裡有沒有條目', () => {
    assert.equal(O.outlineOverlaps(entries(20), { from: 18, to: 25 }), true);
    assert.equal(O.outlineOverlaps(entries(20), { from: 21, to: 40 }), false);
  });
});

describe('outlineBrief', () => {
  test('只取第一行，去掉列表記號；標題跟在章號後面', () => {
    assert.equal(O.outlineBrief({ no: 3, title: '火折', text: '- 沈默逼退沈懷山。\n第二句。' }), '第3章 火折：沈默逼退沈懷山。');
  });

  test('沒有正文只剩章號與標題；太長截到 100 字', () => {
    assert.equal(O.outlineBrief({ no: 3, title: '', text: '' }), '第3章');
    const long = O.outlineBrief({ no: 1, title: '', text: '字'.repeat(150) });
    assert.equal(long, `第1章：${'字'.repeat(100)}…`);
  });
});

describe('outlineWindow · 按遠近帶', () => {
  const nos = (list) => list.map((e) => e.no);
  const seq = (from, n) => Array.from({ length: n }, (_, i) => from + i);
  const render = (w) => O.renderOutlineWindow(w);

  test('一條都認不出：undefined', () => {
    assert.equal(O.outlineWindow('## 第1–20章：舊\n舊的事。', { range: { from: 21, to: 40 } }), undefined);
  });

  test('續寫第 31–40 章：第 21–30 章整條，第 1–20 章只帶第一行', () => {
    const w = O.outlineWindow(entries(30), { range: { from: 31, to: 40 }, after: true });
    assert.deepEqual(nos(w.near), seq(21, 10));
    assert.deepEqual(nos(w.before), seq(1, 20));
    assert.deepEqual(w.folded, []);
    const text = render(w);
    assert.ok(text.includes('- 第1章 標題1：第1章的事。'), text);
    assert.ok(!text.includes('第1章的後果。'), '更早的不帶第二行');
    assert.ok(text.includes('## 第21章：標題21\n第21章的事。\n第21章的後果。'), '最近 10 章整條');
    assert.ok(text.indexOf('第20章') < text.indexOf('## 第21章'), '只帶第一行的排在前面');
  });

  // 2026-10-22 分三段：只帶第一行的那一段按 maxBefore 封頂，更早的不逐章列（交給全文大綱）。
  test('maxBefore：中段只留最近 N 章，更早的進 folded', () => {
    const w = O.outlineWindow(entries(300), { range: { from: 301, to: 320 }, after: true, maxBefore: 100 });
    assert.deepEqual(nos(w.near), seq(291, 10));
    assert.deepEqual(nos(w.before), seq(191, 100));
    assert.deepEqual(w.folded, seq(1, 190));
    assert.ok(!render(w).includes('第190章'), '遠段不逐章列');
  });

  test('maxBefore 為 0：中段一章都不帶；預設與 Infinity 不限', () => {
    assert.equal(O.outlineWindow(entries(30), { range: { from: 31, to: 40 }, maxBefore: 0 }).before.length, 0);
    assert.equal(O.outlineWindow(entries(30), { range: { from: 31, to: 40 }, maxBefore: Infinity }).before.length, 20);
    assert.equal(O.outlineWindow(entries(30), { range: { from: 31, to: 40 } }).folded.length, 0);
  });

  test('拆第 41–45 章：本批與前 10 章是近段，本批之後的不帶', () => {
    const w = O.outlineWindow(entries(60), { range: { from: 41, to: 45 } });
    assert.deepEqual(nos(w.near), seq(31, 15));
    assert.equal(w.before.length, 30);
    assert.equal(w.later.length, 0);
  });

  test('重寫第 21–40 章（after）：之後已有的只帶第一行，接在最後', () => {
    const w = O.outlineWindow(entries(60), { range: { from: 21, to: 40 }, after: true });
    assert.deepEqual(nos(w.near), seq(11, 30));
    assert.deepEqual(nos(w.before), seq(1, 10));
    assert.deepEqual(nos(w.later), seq(41, 20));
    assert.ok(render(w).includes('後面已經排好的（只列第一行）：\n- 第41章 標題41：第41章的事。'), render(w).slice(-300));
  });

  test('沒給區間：最後 10 條整條，更早的只帶第一行', () => {
    const w = O.outlineWindow(entries(25));
    assert.deepEqual(nos(w.near), seq(16, 10));
    assert.equal(w.before.length, 15);
  });

  test('同一章出現兩次只帶先出現的；按章號升序', () => {
    const w = O.outlineWindow('## 第2章：乙\n乙。\n\n## 第1章：甲\n甲。\n\n## 第2章：重複\n重複。');
    assert.equal(render(w), '## 第1章：甲\n甲。\n\n## 第2章：乙\n乙。');
  });

  test('outlineBriefs：整份每章一行', () => {
    assert.equal(O.outlineBriefs(entries(2)), '- 第1章 標題1：第1章的事。\n- 第2章 標題2：第2章的事。');
  });
});

// 拆細綱時大綱只帶這一次要拆的：已經拆過的章前序細綱一覽帶了，同一份細綱不帶兩遍（2026-10-22）。
describe('outlineToSplit · 拆細綱帶哪幾條', () => {
  const nos = (list) => list.map((e) => e.no);

  test('批次：區間裡的，外加區間前還沒拆的空殼；區間之後的不帶', () => {
    const got = O.outlineToSplit(entries(60), { from: 41, to: 45 }, { stubs: new Set([12, 40, 50]) });
    assert.deepEqual(nos(got), [12, 40, 41, 42, 43, 44, 45]);
  });

  test('單章：這一章自己的梗概在本章細綱裡，跳過', () => {
    assert.deepEqual(nos(O.outlineToSplit(entries(10), { from: 5, to: 5 }, { stubs: new Set(), skip: 5 })), []);
    assert.deepEqual(nos(O.outlineToSplit(entries(10), { from: 5, to: 5 }, { stubs: new Set([3]), skip: 5 })), [3]);
  });
});

describe('mergeOutline · 按章號合併', () => {
  const EXISTING = ['# 情節大綱', '', '前言。', '', entries(3).trim(), '', '## 附註', '作者自己的附註。'].join('\n');

  test('舊大綱一條都認不出（沒寫過、舊格式）：直接用新的', () => {
    assert.equal(O.mergeOutline('# 情節大綱\n\n> 說明\n', '## 第1章：甲\n甲。', { from: 1, to: 1 }), '## 第1章：甲\n甲。\n');
    assert.equal(O.mergeOutline('## 第1–20章：舊\n舊的事。', '## 第1章：甲\n甲。', { from: 1, to: 20 }), '## 第1章：甲\n甲。\n');
  });

  test('替換落在區間裡的條目；前言、別的條目與附註原樣保留；新產出的 # 標題丟掉', () => {
    const next = O.mergeOutline(EXISTING, '# 情節大綱\n\n## 第2章：新二\n新的事。', { from: 2, to: 2 });
    assert.deepEqual(O.parseOutline(next).map((e) => [e.no, e.title]), [
      [1, '標題1'],
      [2, '新二'],
      [3, '標題3'],
    ]);
    assert.ok(next.includes('前言。') && next.includes('作者自己的附註。'));
    assert.equal(next.split('# 情節大綱').length, 2, '開頭只有一個標題');
  });

  test('續寫：接在最後一條之後、附註之前', () => {
    const next = O.mergeOutline(EXISTING, '## 第4章：四\n四。\n\n## 第5章：五\n五。', { from: 4, to: 5 });
    assert.deepEqual(O.parseOutline(next).map((e) => e.no), [1, 2, 3, 4, 5]);
    assert.ok(next.indexOf('## 第5章') < next.indexOf('## 附註'));
  });

  test('插在前後兩條之間', () => {
    const next = O.mergeOutline('## 第1章：甲\n甲。\n\n## 第5章：戊\n戊。', '## 第3章：丙\n丙。', { from: 2, to: 4 });
    assert.deepEqual(O.parseOutline(next).map((e) => e.no), [1, 3, 5]);
  });

  test('新產出寫過了界、舊大綱已有的那一章不並進來（不靜默換掉）', () => {
    const next = O.mergeOutline(entries(5), '## 第4章：新四\n新。\n\n## 第5章：新五\n新。', { from: 4, to: 4 });
    assert.equal(O.outlineEntryFor(next, 4).title, '新四');
    assert.equal(O.outlineEntryFor(next, 5).title, '標題5');
    assert.equal(O.parseOutline(next).filter((e) => e.no === 5).length, 1);
  });
});

/** 一份細綱（只給彙總、拆分用得到的那幾樣）。 */
function plot(no, synopsis, extra = {}) {
  const sections = { 梗概: synopsis, 出场人物: '', 时间地点: '', 关键事件: '', 看点: '', 状态变更: '', 连续性事实: '', ...(extra.sections ?? {}) };
  return { relPath: `.novelwarden/summaries/${String(no).padStart(3, '0')}.md`, no, title: extra.title ?? `標題${no}`, sections, sourceHash: extra.sourceHash ?? '', lore: extra.lore };
}

describe('從細綱彙總（docs/design/plans/2026-10-22-outline-from-plots.md）', () => {
  test('梗概非空的一章一條，按章號排；梗概空著（或是佔位文字）的那一章大綱裡沒有', () => {
    const entries = O.outlineEntriesOf([plot(3, '三。'), plot(1, '一。\n後果。  '), plot(2, ''), plot(4, '（待補充）')]);
    assert.deepEqual(entries.map((e) => e.no), [1, 3]);
    assert.equal(entries[0].text, '一。\n後果。');
    assert.equal(O.renderOutline(entries), '## 第1章：標題1\n一。\n後果。\n\n## 第3章：標題3\n三。');
  });

  test('給編輯器的整份：標題行、說明、一章一條；彙總出來的整份再拆回去一件事都不做', () => {
    const plots = [plot(1, '一。'), plot(2, '二。')];
    const doc = O.renderOutlineDoc(O.outlineEntriesOf(plots));
    assert.ok(doc.startsWith('# 情節大綱\n\n> '));
    assert.equal(O.outlineCoverage(doc), 2);
    assert.deepEqual(O.planOutlineSplit(doc, plots, new Set()), { ops: [], kept: [], empty: [] });
    assert.equal(O.renderOutlineDoc([]), `# 情節大綱\n\n${O.OUTLINE_DOC_NOTE}\n`);
  });
});

describe('按章號拆回各章細綱（planOutlineSplit）', () => {
  test('改梗概、改標題、新的一章；行尾空白與換行風格不算改動', () => {
    const plots = [plot(1, '一。'), plot(2, '二。'), plot(3, '三。')];
    const text = '## 第1章：標題1\n一。  \r\n\n## 第2章：新標題\n二。\n\n## 第3章：標題3\n三改了。\n\n## 第4章：四\n新的一章。';
    const { ops } = O.planOutlineSplit(text, plots, new Set());
    assert.deepEqual(ops, [
      { op: 'update', no: 2, rel: plots[1].relPath, title: '新標題' },
      { op: 'update', no: 3, rel: plots[2].relPath, synopsis: '三改了。' },
      { op: 'create', no: 4, title: '四', synopsis: '新的一章。' },
    ]);
  });

  test('標題空著 = 沿用細綱的標題', () => {
    assert.deepEqual(O.planOutlineSplit('## 第1章\n一。', [plot(1, '一。')], new Set()).ops, []);
  });

  test('刪掉的一條：空殼進回收站；排了細綱、定稿過、記過設定、寫了正文的不刪，記進 kept', () => {
    const plots = [
      plot(1, '一。'),
      plot(2, '二。', { sections: { 关键事件: '- 有事' } }),
      plot(3, '三。', { sourceHash: 'abc' }),
      plot(4, '四。', { lore: [{ name: '青河', category: '地點', fact: '' }] }),
      plot(5, '五。'),
      plot(6, ''),
    ];
    const plan = O.planOutlineSplit('## 第9章：九\n九。', plots, new Set([5]));
    assert.deepEqual(plan.ops.filter((o) => o.op === 'drop').map((o) => o.no), [1]);
    assert.deepEqual(plan.kept, [2, 3, 4, 5]);
  });

  test('只有標題、下面沒寫字：沒地方存，記進 empty；原來有梗概的當成刪掉', () => {
    const plan = O.planOutlineSplit('## 第1章：一\n\n## 第3章：三\n', [plot(1, '一。')], new Set());
    assert.deepEqual(plan.empty, [3]);
    assert.deepEqual(plan.ops, [{ op: 'drop', no: 1, rel: plot(1, '').relPath }]);
  });

  test('同一章寫了兩條取先出現的；區間標題與認不出的段落不算', () => {
    const text = '## 第1章：甲\n先。\n\n## 第1章：乙\n後。\n\n## 第2–3章：舊\n舊。\n\n隨手記的一段。';
    assert.deepEqual(O.planOutlineSplit(text, [], new Set()).ops, [{ op: 'create', no: 1, title: '甲', synopsis: '先。' }]);
  });
});
