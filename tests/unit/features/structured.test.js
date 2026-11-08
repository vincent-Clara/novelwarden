/**
 * 結構化產物的解碼：細綱批次、角色圖譜兩段式、小說配置，以及轉寫要的取 JSON 與「出自原文」比對。
 *
 * 全部是純函式（features/structuredJson.ts、blueprint.ts、roster.ts、novelConfig.ts），
 * 生成鏈怎麼用它們在 tests/integration/generation/structuredChain.test.js。
 *
 * | 用例組 | 釘的是什麼 |
 * |---|---|
 * | 取 JSON | 看起來是 JSON 卻解析不了的認得出（轉寫照轉）；「唯一一個完整物件」：兩個就說不清哪個是答案 |
 * | 轉寫有沒有照抄 | 細綱試點：轉寫的每段文字都得出自原文，去掉列表記號、並條拆條、換引號不算改；「無」換成空的 |
 * | 細綱批次 | 缺必填欄位報診斷（交給拆半 / 緊湊重建）；可以空著的四個欄位寬鬆收；超長截斷不作廢；新角色必須在出場名單裡；關鍵事件是一條一件事的陣列，給成一段字按換行與分號切 |
 * | 角色圖譜 | 清單裡關係不閉合、沒標主角照收並說明；詳情以凍結清單為準；關係由清單生成到雙方卡上 |
 * | 設定清單 | 分類規範成目錄路徑；已有條目照抄名字、以實際目錄為準；人名丟掉；超過 30 條只留 30 條；詳情以凍結清單為準、三節合計 300 字 |
 * | 小說配置 | 英文鍵對映到七節；「全域要求」的合同；保留作者原文；規範化草稿能按 config.md 讀回來 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const J = loadModule('src/core/features/structuredJson.ts');
const B = loadModule('src/core/features/blueprint.ts');
const R = loadModule('src/core/features/roster.ts');
const L = loadModule('src/core/features/loreList.ts');
const C = loadModule('src/core/features/novelConfig.ts');
const A = loadModule('src/core/features/artifact.ts');
const S = loadModule('src/core/model/settingFile.ts');

const item = (no, over = {}) => ({
  chapterNumber: no,
  title: `第${no}章標題`,
  synopsis: `第 ${no} 章的梗概`,
  characters: ['林昭', '沈青'],
  timePlace: `第 ${no} 章的時間地點`,
  keyEvents: [`第 ${no} 章林昭在山門外踩點`, `第 ${no} 章翻牆進了後院`],
  highlights: [`第 ${no} 章的爽點`, `第 ${no} 章的鉤子`],
  stateChange: `第 ${no} 章之後的處境`,
  threads: [{ line: '林昭與沈青', type: '推进', what: `第 ${no} 章兩人聯手` }],
  ...over,
});

describe('structuredJson.ts · 取 JSON', () => {
  test('看起來是 JSON 卻解析不了的認得出（轉寫照轉，不當成「不像這一步的輸出」）', () => {
    assert.equal(J.isRepairableJsonSyntax('{"a": 1,}'), true);
    assert.equal(J.isRepairableJsonSyntax('```json\n{"a": [1, 2}\n```'), true);
    assert.equal(J.isRepairableJsonSyntax('{"a": 1}'), false);
    assert.equal(J.isRepairableJsonSyntax('好的，這是細綱：{"a": 1'), false);
  });

  test('唯一一個完整物件：兩個就說不清哪個是答案', () => {
    assert.deepEqual(J.singleJsonObject('前言 {"a": 1} 後記').value, { a: 1 });
    assert.equal(J.singleJsonObject('{"a": 1} {"b": 2}').reason, 'multiple');
    assert.equal(J.singleJsonObject('{"a": {"b": 1}').reason, 'truncated');
  });
});

// 細綱試點（2026-10-25）：寫細綱的模型按小標題寫，轉寫模型照抄成 JSON——每一段文字都得出自原文。
describe('structuredJson.ts · 轉寫有沒有照抄', () => {
  const SKIP = new Set(['chapterNumber', 'type']);
  const source = ['## 第3章：雨夜', '### 關鍵事件', '- 林昭在山門外踩點。', '- 他翻牆進了後院，落在「藏書閣」門口。', '### 敘事線', '- 青雲舊案·推進：林昭摸到藏書閣。'].join('\n');

  test('去掉行首的「-」、把兩行併成一條、換個引號：都算照抄', () => {
    const value = {
      title: '雨夜',
      keyEvents: ['林昭在山門外踩點', '林昭在山門外踩點。他翻牆進了後院，落在"藏書閣"門口'],
      threads: [{ line: '青雲舊案', type: '推进', what: '林昭摸到藏書閣。' }],
    };
    assert.deepEqual(J.unfaithfulStrings(source, value, SKIP), []);
  });

  test('改了一個字、補了原文沒有的一句：交回那幾段', () => {
    const value = { keyEvents: ['林昭在山門外踩點。', '林昭在山門外踩了點。', '沈青在井邊等他。'] };
    assert.deepEqual(J.unfaithfulStrings(source, value, SKIP), ['林昭在山門外踩了點。', '沈青在井邊等他。']);
  });

  test('按對應關係填的鍵不比；交回的最多幾段，長的截到 30 字', () => {
    assert.deepEqual(J.unfaithfulStrings(source, { chapterNumber: 3, threads: [{ type: '收束' }] }, SKIP), []);
    const long = '這一句是原文里根本沒有的很長很長的一段話，轉寫模型自己編出來的，比三十個字還要長一些。';
    const off = J.unfaithfulStrings(source, { a: [long, '甲', '乙', '丙'] }, SKIP);
    assert.equal(off.length, 3);
    assert.ok(off[0].endsWith('…') && Array.from(off[0]).length === 31, off[0]);
  });

  // 壞了語法的 JSON 也交給轉寫理順：原文裡的 \n 還是轉義的樣子，還原了再比。
  test('原文是壞了語法的 JSON：轉義還原了再比', () => {
    const broken = '{"blueprints":[{"keyEvents":"林昭踩點；\\n翻牆進了後院",}]}';
    assert.deepEqual(J.unfaithfulStrings(broken, { keyEvents: ['林昭踩點', '翻牆進了後院'] }, SKIP), []);
  });

  test('「無」換成空的，列表裡的去掉', () => {
    assert.deepEqual(J.withoutNone({ a: '無', b: ['無', '甲', '（無）'], c: { d: '無。' }, e: 3, f: '無名氏' }), {
      a: '',
      b: ['甲'],
      c: { d: '' },
      e: 3,
      f: '無名氏',
    });
  });

  test('整段是 JSON 就取它，否則取唯一一個完整物件；都不是給 undefined', () => {
    assert.deepEqual(J.jsonValueOf('[1, 2]'), [1, 2]);
    assert.deepEqual(J.jsonValueOf('好的：{"a": 1}'), { a: 1 });
    assert.equal(J.jsonValueOf('## 第3章：雨夜'), undefined);
  });
});

describe('blueprint.ts · 細綱批次', () => {
  test('合格的一批：欄位對上細綱七節，新角色帶出來', () => {
    const r = B.decodeBlueprints(JSON.stringify({
      blueprints: [item(1, { newCharacters: [{ name: '沈青', role: 'supporting' }] }), item(2)],
    }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.items.map((b) => b.no), [1, 2]);
    assert.deepEqual(r.items[0].newCharacters, [{ name: '沈青', role: '配角' }]);
    const plot = B.blueprintToPlot(r.items[0]);
    assert.deepEqual(plot.sections, {
      梗概: '第 1 章的梗概',
      出场人物: '林昭、沈青',
      时间地点: '第 1 章的時間地點',
      关键事件: '- 第 1 章林昭在山門外踩點\n- 第 1 章翻牆進了後院',
      看点: '- 第 1 章的爽點\n- 第 1 章的鉤子',
      状态变更: '第 1 章之後的處境',
      连续性事实: '',
    });
    assert.equal(plot.title, '第1章標題');
    // 敘事線的計劃（二期）不進細綱：隨產物帶著，寫入時寫進各條線。
    assert.deepEqual(plot.threads, [{ line: '林昭與沈青', type: '推进', what: '第 1 章兩人聯手' }]);
  });

  // 設定名錄：settings 可選、寬鬆收；isNew 的隨細綱建空條目，其餘只進「設定」一節。
  test('settings：可選、寬鬆收，落盤成「設定」一節；超過 8 條只留前 8 條', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ name: `地名${i}`, category: '地域' }));
    const r = B.decodeBlueprints(JSON.stringify({
      blueprints: [
        item(1, { settings: [{ name: '古井', category: '地域/青崖', isNew: true, note: '鎮北的枯井' }, '青崖鎮〔地域〕'] }),
        item(2),
        item(3, { settings: many }),
        item(4, { settings: '不是陣列也不作廢' }),
      ],
    }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.items[0].settings, [
      { name: '古井', category: '地域/青崖', note: '鎮北的枯井', isNew: true },
      { name: '青崖鎮', category: '地域', note: '', isNew: false },
    ]);
    assert.deepEqual(B.blueprintToPlot(r.items[0]).lore, [
      { name: '古井', category: '地域/青崖', note: '鎮北的枯井' },
      { name: '青崖鎮', category: '地域', note: '' },
    ]);
    assert.deepEqual(r.items[1].settings, []);
    assert.equal(r.items[2].settings.length, 8);
    assert.ok(r.warnings.some((w) => w.includes('第 3 章列了 10 條設定')), r.warnings.join('\n'));
    assert.equal(r.items[3].settings.length, 1);
    // 生成鏈交給氣泡、採納時重新解析的是規範化的那一份：settings 不能在這一步丟掉。
    assert.deepEqual(B.decodeBlueprints(B.renderBlueprints(r.items)).items[0].settings, r.items[0].settings);
  });

  test('單章（落定 / 寫細綱）也認 settings；沒寫就不帶，落盤時沿用磁碟那份', () => {
    const withLore = A.parsePlotStrict(JSON.stringify({ blueprints: [item(1, { settings: [{ name: '古井', category: '地域' }] })] }));
    assert.deepEqual(withLore.lore, [{ name: '古井', category: '地域', note: '' }]);
    const without = A.parsePlotStrict(JSON.stringify({ blueprints: [item(1)] }));
    assert.equal(without.lore, undefined);
  });

  // 過渡章不動哪條線是常事：為一個空陣列作廢整批再調一次不划算。
  test('時間地點 / 看點 / 狀態變更 / threads 可以缺、可以空，形狀寫錯了照收', () => {
    const { timePlace, highlights, threads, stateChange, ...bare } = item(1);
    void timePlace;
    void highlights;
    void threads;
    void stateChange;
    const r = B.decodeBlueprints(JSON.stringify({ blueprints: [bare, item(2, { highlights: '一行寫成的看點', threads: '不是陣列', stateChange: ['甲', '乙'] })] }));
    assert.equal(r.ok, true);
    assert.deepEqual([r.items[0].timePlace, r.items[0].highlights, r.items[0].stateChange], ['', [], '']);
    // 沒寫 threads：不帶這個欄位（寫入時不動原來的計劃）；寫成別的形狀：當空的，說一句。
    assert.equal(r.items[0].threads, undefined);
    assert.deepEqual(r.items[1].threads, []);
    assert.match(r.warnings.join('\n'), /第 2 章的敘事線計劃（threads）不是列表/);
    assert.deepEqual(r.items[1].highlights, ['一行寫成的看點']);
    assert.equal(r.items[1].stateChange, '甲；乙');
  });

  test('看點超過條數與字數：截斷並說明', () => {
    const r = B.decodeBlueprints(JSON.stringify({
      blueprints: [item(1, { highlights: Array.from({ length: 7 }, (_, i) => `看點${i}`) })],
    }));
    assert.equal(r.items[0].highlights.length, 5);
    assert.match(r.warnings.join('\n'), /highlights 列了 7 條/);
  });

  // 敘事線二期：原來的 foreshadowing 換成 threads（一章最多 6 條）。合同的形狀在解碼這一步只認結構，線認不認得出落盤時才知道。
  test('threads：型別、伏筆名、線名逐條校驗，沒收的寫進說明；同一條只留一條，一章最多 6 條；規範化輸出原樣認得', () => {
    const r = B.decodeBlueprints(JSON.stringify({
      blueprints: [
        item(1, {
          threads: [
            { line: '林昭與沈青', type: '推进', what: '兩人聯手' },
            { line: '林昭與沈青', type: '推进', what: '同一條線同一種型別，重複' },
            { line: '', type: '埋', foreshadowing: '玉佩的來歷', what: '玉佩露面', resolve: 9 },
            { line: '青崖舊案', type: '收', foreshadowing: '斷劍', what: '斷劍出水', resolve: 9 },
            { line: '青崖舊案', type: '放弃', what: '計劃裡不認' },
            { line: '青崖舊案', type: '埋', what: '沒寫是哪一條伏筆' },
            { type: '关系', what: '沒寫是哪一條線' },
            { line: '青崖舊案', type: '收束', what: '這條線走完了' },
            { line: '甲', type: '推进', what: '第 5 條' },
            { line: '乙', type: '推进', what: '第 6 條' },
            { line: '丙', type: '推进', what: '第 7 條，超了' },
          ],
        }),
      ],
    }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.items[0].threads, [
      { line: '林昭與沈青', type: '推进', what: '兩人聯手' },
      { line: '', type: '埋', foreshadowing: '玉佩的來歷', what: '玉佩露面', resolve: 9 },
      { line: '青崖舊案', type: '收', foreshadowing: '斷劍', what: '斷劍出水' },
      { line: '青崖舊案', type: '收束', what: '這條線走完了' },
      { line: '甲', type: '推进', what: '第 5 條' },
      { line: '乙', type: '推进', what: '第 6 條' },
    ]);
    const w = r.warnings.join('\n');
    assert.match(w, /青崖舊案 放棄：型別不是推進 \/ 關係 \/ 收束 \/ 埋 \/ 收之一，沒收/);
    assert.match(w, /青崖舊案 埋：沒寫是哪一條伏筆，沒收/);
    assert.match(w, /？ 關係：沒寫是哪一條線，沒收/);
    assert.match(w, /丙 推進：一章最多寫 6 條，沒收/);
    assert.deepEqual(B.decodeBlueprints(B.renderBlueprints(r.items)).items[0].threads, r.items[0].threads);
  });

  test('單章（落定 / 寫細綱）也認 threads，沒寫就不帶', () => {
    const one = A.parsePlotStrict(JSON.stringify({ blueprints: [item(3, { threads: [{ line: '林昭與沈青', type: '关系', what: '結盟' }, { type: '收' }] })] }));
    assert.deepEqual(one.threads, [{ line: '林昭與沈青', type: '关系', what: '結盟' }]);
    assert.match(one.planNotes.join('\n'), /第 3 章的敘事線計劃 ？ 收：沒寫是哪一條伏筆/);
    const without = A.parsePlotStrict(JSON.stringify({ blueprints: [item(3, { threads: undefined })] }));
    assert.equal(without.threads, undefined);
    assert.equal(without.planNotes, undefined);
  });

  test('裸陣列、圍欄、JSON 前後的廢話都認', () => {
    assert.equal(B.decodeBlueprints(JSON.stringify([item(3)])).ok, true);
    assert.equal(B.decodeBlueprints('```json\n' + JSON.stringify({ blueprints: [item(3)] }) + '\n```').ok, true);
    assert.equal(B.decodeBlueprints('好的：' + JSON.stringify({ blueprints: [item(3)] }) + '祝順利').ok, true);
  });

  test('缺必填欄位、梗概為空、沒有出場角色：報診斷，路徑說得出是哪一格', () => {
    const noSynopsis = B.decodeBlueprints(JSON.stringify({ blueprints: [item(1), item(2, { synopsis: '' })] }));
    assert.equal(noSynopsis.ok, false);
    assert.equal(noSynopsis.diagnostic.code, 'empty_value');
    assert.equal(noSynopsis.diagnostic.path, 'blueprints[1].synopsis');

    const { keyEvents, ...rest } = item(1);
    void keyEvents;
    const missing = B.decodeBlueprints(JSON.stringify({ blueprints: [rest] }));
    assert.equal(missing.diagnostic.code, 'missing_field');
    assert.equal(missing.diagnostic.path, 'blueprints[0].keyEvents');
    assert.equal(B.decodeBlueprints(JSON.stringify({ blueprints: [item(1, { characters: [] })] })).diagnostic.path, 'blueprints[0].characters');
    assert.equal(B.decodeBlueprints('{"blueprints": [').diagnostic.code, 'not_json');
    assert.equal(B.decodeBlueprints('{"x": 1}').diagnostic.code, 'no_list');
  });

  test('標題在標點處斷開', () => {
    const r = B.decodeBlueprints(JSON.stringify({
      blueprints: [item(1, { title: '夜入青雲。林昭在雨夜翻進了宗門的後牆' })],
    }));
    assert.equal(r.ok, true);
    assert.equal(r.items[0].title, '夜入青雲');
  });

  // 關鍵事件和定稿寫出來的一樣是一條一件事的列表（⚑B）：定稿才能逐條改，而不是把一整段重寫一遍。
  describe('關鍵事件：一條一件事的列表', () => {
    const events = (keyEvents) => B.decodeBlueprints(JSON.stringify({ blueprints: [item(1, { keyEvents })] }));

    test('陣列按條收，去掉行首的編號與「-」，空條不算', () => {
      const r = events(['1. 林昭踩點', '- 失手驚動守衛', '  ', '翻牆進了後院']);
      assert.equal(r.ok, true);
      assert.deepEqual(r.items[0].keyEvents, ['林昭踩點', '失手驚動守衛', '翻牆進了後院']);
      assert.deepEqual(r.warnings, []);
    });

    test('一條裡帶了換行就按行拆開：落盤後一行就是一條', () => {
      assert.deepEqual(events(['林昭踩點\n失手驚動守衛']).items[0].keyEvents, ['林昭踩點', '失手驚動守衛']);
    });

    // 一條裡的分號不切：一件事可以有前後兩拍。
    test('陣列裡一條帶分號不切', () => {
      assert.deepEqual(events(['林昭翻牆；落在後院']).items[0].keyEvents, ['林昭翻牆；落在後院']);
    });

    test('給成一段字照收：按換行與分號切成條，去掉列表記號', () => {
      assert.deepEqual(events('林昭踩點；失手驚動守衛;翻牆進了後院').items[0].keyEvents, ['林昭踩點', '失手驚動守衛', '翻牆進了後院']);
      assert.deepEqual(events('- 林昭踩點\n- 翻牆進了後院').items[0].keyEvents, ['林昭踩點', '翻牆進了後院']);
      assert.deepEqual(events('一整段寫成的關鍵事件，沒有分號。').items[0].keyEvents, ['一整段寫成的關鍵事件，沒有分號。']);
    });

    test('空陣列、只有空白或記號：empty_value', () => {
      for (const v of [[], [''], ['  ', '-'], '', '；', '- \n-']) {
        const r = events(v);
        assert.equal(r.ok, false, JSON.stringify(v));
        assert.equal(r.diagnostic.code, 'empty_value', JSON.stringify(v));
        assert.equal(r.diagnostic.path, 'blueprints[0].keyEvents');
      }
    });

    test('形狀不對：invalid_type', () => {
      for (const v of [42, { a: '林昭踩點' }, ['林昭踩點', 3], [{ event: '林昭踩點' }], null, true]) {
        const r = events(v);
        assert.equal(r.ok, false, JSON.stringify(v));
        assert.equal(r.diagnostic.code, 'invalid_type', JSON.stringify(v));
        assert.equal(r.diagnostic.path, 'blueprints[0].keyEvents');
      }
    });

    test('超過 8 條：只留前面的，並說明', () => {
      assert.equal(B.BLUEPRINT_LIMITS.keyEventItems, 8);
      const r = events(Array.from({ length: 10 }, (_, i) => `事件${i}`));
      assert.equal(r.ok, true);
      assert.deepEqual(r.items[0].keyEvents, Array.from({ length: 8 }, (_, i) => `事件${i}`));
      assert.match(r.warnings.join('\n'), /第 1 章的 keyEvents 列了 10 條，只留前 8 條/);
    });

    test('合計超過 1200 字：從超出的那一條起截掉，並說明', () => {
      const r = events(['甲'.repeat(500), '乙'.repeat(500), '丙'.repeat(500), '丁'.repeat(10)]);
      assert.equal(r.ok, true);
      assert.deepEqual(r.items[0].keyEvents, ['甲'.repeat(500), '乙'.repeat(500), '丙'.repeat(200)]);
      assert.equal(r.items[0].keyEvents.join('').length, 1200);
      assert.match(r.warnings.join('\n'), /第 1 章的 keyEvents 超過 1200 字，已截斷/);
    });

    test('合計正好 1200 字：不截、不說明', () => {
      const r = events(['甲'.repeat(600), '乙'.repeat(600)]);
      assert.equal(r.items[0].keyEvents.join('').length, 1200);
      assert.deepEqual(r.warnings, []);
    });

    test('一段字超長：切完再按合計字數截', () => {
      const r = events('事'.repeat(1300));
      assert.deepEqual(r.items[0].keyEvents, ['事'.repeat(1200)]);
      assert.match(r.warnings.join('\n'), /第 1 章的 keyEvents 超過 1200 字/);
    });

    test('落盤成一條一行，規範化輸出寫回陣列', () => {
      const r = events('林昭踩點；翻牆進了後院');
      assert.equal(B.blueprintToPlot(r.items[0]).sections.关键事件, '- 林昭踩點\n- 翻牆進了後院');
      assert.deepEqual(JSON.parse(B.renderBlueprints(r.items)).blueprints[0].keyEvents, ['林昭踩點', '翻牆進了後院']);
    });
  });

  test('新角色不在出場名單裡：不建卡，並說明', () => {
    const r = B.decodeBlueprints(JSON.stringify({ blueprints: [item(1, { newCharacters: [{ name: '周嶽', role: 'minor' }] })] }));
    assert.deepEqual(r.items[0].newCharacters, []);
    assert.match(r.warnings[0], /周嶽/);
  });

  test('覆蓋檢查：漏章、重複、越界', () => {
    const r = B.decodeBlueprints(JSON.stringify({ blueprints: [item(1), item(1), item(7)] }));
    assert.deepEqual(B.checkCoverage(r.items, [1, 2, 3]), { missing: [2, 3], duplicate: [1], unexpected: [7] });
  });

  test('規範化輸出能原樣解回來', () => {
    const r = B.decodeBlueprints(JSON.stringify({ blueprints: [item(4, { newCharacters: [{ name: '沈青', role: '配角' }] })] }));
    const again = B.decodeBlueprints(B.renderBlueprints(r.items));
    assert.deepEqual(again.items, r.items);
  });

  test('新角色帶性別：規範成「男」「女」，原樣解回來；沒給的不多一個鍵', () => {
    const r = B.decodeBlueprints(JSON.stringify({
      blueprints: [item(4, { characters: ['林昭', '沈青', '周嶽'], newCharacters: [{ name: '沈青', role: 'supporting', gender: 'female' }, { name: '周嶽', role: 'minor' }] })],
    }));
    assert.deepEqual(r.items[0].newCharacters, [{ name: '沈青', role: '配角', gender: '女' }, { name: '周嶽', role: '次要' }]);
    assert.deepEqual(B.decodeBlueprints(B.renderBlueprints(r.items)).items, r.items);
  });
});

describe('roster.ts · 角色圖譜兩段式', () => {
  const manifest = {
    slots: [
      { slotId: '1', name: '林昭', role: 'protagonist', narrativeDuty: '揹著舊案入宗', relations: [{ targetSlotId: '2', relation: '同門，互相試探' }] },
      { slotId: '2', name: '沈青', role: 'supporting', narrativeDuty: '引路人', relations: [] },
      { slotId: '3', name: '周嶽', role: 'antagonist', narrativeDuty: '執法堂首座', relations: [{ targetSlotId: '9', relation: '？' }, { targetSlotId: '3', relation: '自己' }] },
    ],
  };

  test('清單：關係指向清單外或自己的丟掉並說明，定位換成中文', () => {
    const r = R.decodeManifest(JSON.stringify(manifest));
    assert.equal(r.ok, true);
    assert.deepEqual(r.slots.map((s) => s.role), ['主角', '配角', '反派']);
    assert.deepEqual(r.slots[2].relations, []);
    assert.equal(r.warnings.filter((w) => /周嶽/.test(w)).length, 2);
  });

  test('清單：人太少、沒標主角照收，寫進說明；一個人都沒有才失敗', () => {
    const two = R.decodeManifest(JSON.stringify({ slots: [{ slotId: 'a', name: '甲', role: 'minor', relations: [] }, { slotId: 'b', name: '乙', role: 'x', relations: [] }] }));
    assert.equal(two.ok, true);
    assert.match(two.warnings.join('\n'), /2 人/);
    assert.match(two.warnings.join('\n'), /沒有標出主角/);
    assert.equal(R.decodeManifest('{"slots": []}').ok, false);
    assert.equal(R.decodeManifest('不是 JSON').ok, false);
  });

  test('詳情：以凍結清單為準，清單外的人丟掉，超長截斷', () => {
    const { slots } = R.decodeManifest(JSON.stringify(manifest));
    const r = R.decodeDetails(JSON.stringify({
      entries: [
        { slotId: '1', name: '林昭', 身份: '青河鎮孤兒', 性格: '隱忍', 当前状态: '在宗門外', aliases: ['阿昭', '林昭'] },
        { name: '沈青', 外貌: '青衫'.repeat(80) },
        { slotId: '99', name: '路人' },
      ],
    }), slots.slice(0, 2));
    assert.equal(r.ok, true);
    assert.deepEqual(r.items.map((d) => d.slotId), ['1', '2']);
    assert.deepEqual(r.items[0].aliases, ['阿昭']);
    assert.equal(r.items[1].sections.外貌.length, 120);
    assert.match(r.warnings.join('\n'), /路人/);
  });

  test('拼卡：關係寫到雙方卡上，敘事職責接在身份後，詳情缺席的人照樣建卡', () => {
    const { slots } = R.decodeManifest(JSON.stringify(manifest));
    const { items } = R.decodeDetails(JSON.stringify({ entries: [{ slotId: '1', 身份: '青河鎮孤兒' }] }), slots);
    const { entries, warnings } = R.assembleRoster(slots, items);
    assert.equal(entries.length, 3);
    assert.equal(entries[0].sections.身份, '青河鎮孤兒\n敘事職責：揹著舊案入宗');
    assert.equal(entries[0].sections.人物关系, '- 與沈青：同門，互相試探');
    assert.equal(entries[1].sections.人物关系, '- 與林昭：林昭眼中——同門，互相試探');
    assert.match(warnings.join('\n'), /沈青.*詳情沒有生成/);
    // 規範化輸出能被 artifact.ts 的 parseRoster 讀回來（採納時重新解析的那一份）。
    const back = A.parseRoster(R.renderRoster(entries));
    assert.deepEqual(back.map((e) => [e.name, e.role]), [['林昭', '主角'], ['沈青', '配角'], ['周嶽', '反派']]);
    assert.equal(back[0].sections.人物关系, entries[0].sections.人物关系);
  });

  test('性別在清單裡定：規範寫法、拼卡帶上、規範化輸出讀得回來；沒給的就沒有', () => {
    const withGender = {
      slots: [
        { ...manifest.slots[0], gender: 'male' },
        { ...manifest.slots[1], gender: '女性' },
        { ...manifest.slots[2], gender: '未知' },
      ],
    };
    const { slots } = R.decodeManifest(JSON.stringify(withGender));
    assert.deepEqual(slots.map((s) => s.gender), ['男', '女', undefined]);
    const { entries } = R.assembleRoster(slots, []);
    assert.deepEqual(entries.map((e) => e.gender), ['男', '女', undefined]);
    const text = R.renderRoster(entries);
    assert.match(text, /"性别": "女"/);
    assert.deepEqual(A.parseRoster(text).map((e) => e.gender), ['男', '女', undefined]);
  });
});

describe('loreList.ts · 設定清單兩段式', () => {
  /** 已有條目的最小形狀（listLore 讀出來的樣子）。 */
  const entry = (title, category = '', keywords = []) => ({
    slug: `${category ? `${category}/` : ''}${title}`,
    relPath: `.novelwarden/lore/${category ? `${category}/` : ''}${title}.md`,
    title,
    keywords,
    brief: '',
    category,
    body: '',
  });
  const none = { categories: [], entries: [], people: [] };
  const row = (title, category, over = {}) => ({ title, category, keywords: [], brief: `${title}是什麼`, ...over });
  const twelve = Array.from({ length: 12 }, (_, i) => row(`地點${i + 1}`, '地域'));

  test('清單：分類規範成目錄路徑，條目帶一句話與關鍵詞；人名丟掉並說明', () => {
    const r = L.decodeLoreManifest(
      JSON.stringify({
        categories: ['宗門／正道', ' 地域 ', '丹藥法寶', '宗門/正道', '..'],
        entries: [
          row('青雲宗', '宗門/正道', { keywords: ['青雲門', '青雲宗', '林昭'], brief: '正道第一大宗'.repeat(10) }),
          row('林昭', '地域'),
          row('青崖鎮', ''),
          row('青雲宗', '宗門/正道'),
          ...twelve,
        ],
      }),
      { ...none, people: ['林昭'] }
    );
    assert.equal(r.ok, true);
    assert.deepEqual(r.categories, ['宗門/正道', '地域', '丹藥法寶']);
    const qy = r.slots.find((s) => s.title === '青雲宗');
    assert.equal(qy.category, '宗門/正道');
    // 關鍵詞去掉標題本身與人名；一句話截到 40 字。
    assert.deepEqual(qy.keywords, ['青雲門']);
    assert.equal(Array.from(qy.brief).length, 40);
    assert.ok(!r.slots.some((s) => s.title === '林昭'));
    assert.equal(r.slots.find((s) => s.title === '青崖鎮').category, '');
    const warnings = r.warnings.join('\n');
    assert.match(warnings, /林昭.*人不是設定/);
    assert.match(warnings, /青崖鎮.*未分類/);
    assert.match(warnings, /青雲宗.*不止一次/);
    assert.match(warnings, /「\.\.」當不了目錄名/);
    assert.match(warnings, /一句話超過 40 字/);
  });

  test('清單：已有條目照抄名字、分類以實際目錄為準；分類不在表裡的補進目錄樹並說明', () => {
    const known = { categories: ['宗門'], entries: [entry('青雲宗', '宗門', ['青雲門'])], people: [] };
    const r = L.decodeLoreManifest(
      JSON.stringify({ categories: ['地域'], entries: [row('青雲門', '地域'), row('鎮妖塔', '禁地'), ...twelve] }),
      known
    );
    assert.equal(r.ok, true);
    assert.equal(r.slots[0].title, '青雲宗');
    assert.equal(r.slots[0].category, '宗門');
    assert.equal(r.slots[1].category, '禁地');
    assert.deepEqual(r.categories, ['地域', '禁地']);
    assert.match(r.warnings.join('\n'), /鎮妖塔.*禁地.*不在 categories 裡/);
    // 一級分類按本書已有的加這次新排的數：宗門 + 地域 + 禁地 = 3 個，夠數不報。
    assert.ok(!/一級分類/.test(r.warnings.join('\n')), r.warnings.join('\n'));
  });

  test('清單：條數不夠照收並說明，超過 30 條只留前 30 條（次數是按 30 條報的）；一條能用的都沒有才失敗', () => {
    const few = L.decodeLoreManifest(JSON.stringify({ categories: ['甲', '乙', '丙'], entries: [row('青崖鎮', '甲')] }), none);
    assert.equal(few.ok, true);
    assert.match(few.warnings.join('\n'), /1 條，合同要求 12–30 條/);
    const many = L.decodeLoreManifest(
      JSON.stringify({ categories: ['甲', '乙', '丙'], entries: Array.from({ length: 33 }, (_, i) => row(`物${i + 1}`, '甲')) }),
      none
    );
    assert.equal(many.slots.length, 30);
    assert.match(many.warnings.join('\n'), /超過 30 條，「物31」及之後的沒收/);
    assert.equal(L.decodeLoreManifest('{"categories":[],"entries":[]}', none).ok, false);
    assert.equal(L.decodeLoreManifest('不是 JSON', none).ok, false);
    assert.equal(L.decodeLoreManifest('{"slots":[{"name":"甲"}]}', none).ok, false);
  });

  test('詳情：以凍結清單為準，清單外的丟掉；三節規範化，超過 300 字截斷並說明', () => {
    const { slots } = L.decodeLoreManifest(
      JSON.stringify({ categories: ['地域', '宗門', '法寶'], entries: [row('青崖鎮', '地域'), row('青雲宗', '宗門'), row('崖字令', '法寶')] }),
      none
    );
    const r = L.decodeLoreDetails(
      JSON.stringify({
        entries: [
          { title: '青崖鎮', body: '## 概要\n偏僻小鎮。\n\n## 規則與邊界\n鎮口設卡查過所。' },
          { title: '青雲宗', body: { 概要: '正道大宗。', 规则与边界: '門規森嚴。'.repeat(60), 现状: '封山。' } },
          { title: '路人甲', body: '## 概要\n隨便' },
        ],
      }),
      slots
    );
    assert.equal(r.ok, true);
    assert.deepEqual(r.items.map((d) => d.title), ['青崖鎮', '青雲宗']);
    // 沒寫的那一節寫「（未交代）」：節在，作者一眼看得出這裡還沒東西。
    assert.equal(r.items[0].body, '## 概要\n偏僻小鎮。\n\n## 規則與邊界\n鎮口設卡查過所。\n\n## 現狀\n（未交代）');
    const qy = r.items[1].body;
    assert.match(qy, /^## 概要\n正道大宗。\n\n## 規則與邊界\n/);
    // 規則與邊界單節上限 250 字。
    assert.equal(Array.from(/## 規則與邊界\n([^\n]*)/.exec(qy)[1]).length, 250);
    const warnings = r.warnings.join('\n');
    assert.match(warnings, /青雲宗.*正文超長，已截斷/);
    assert.match(warnings, /路人甲/);
    assert.equal(L.decodeLoreDetails('{"items":[]}', slots).ok, false);
  });

  test('正文：三節合計不超過 300 字，從超出的那一節起截掉；一節都認不出的整段當概要', () => {
    const long = L.normalizeLoreBody({ 概要: '甲'.repeat(150), 规则与边界: '乙'.repeat(200), 现状: '丙'.repeat(100) });
    assert.equal(long.clipped, true);
    const chars = long.body.replace(/## \S+\n/g, '').replace(/（未交代）/g, '').replace(/\n/g, '');
    assert.equal(Array.from(chars).length, 300);
    assert.match(long.body, /## 現狀\n（未交代）/);
    assert.deepEqual(L.normalizeLoreBody('一座塔，鎮著妖。'), { body: '## 概要\n一座塔，鎮著妖。\n\n## 規則與邊界\n（未交代）\n\n## 現狀\n（未交代）', clipped: false });
    assert.deepEqual(L.normalizeLoreBody(''), { body: '', clipped: false });
  });

  test('拼條目：正文缺席的照樣建（只有一句話）；規範化輸出能被採納時讀回來', () => {
    const { categories, slots } = L.decodeLoreManifest(
      JSON.stringify({ categories: ['地域', '宗門', '法寶'], entries: [row('青崖鎮', '地域', { keywords: ['青崖'] }), row('青雲宗', '宗門')] }),
      none
    );
    const { entries, warnings } = L.assembleLoreList(slots, [{ title: '青崖鎮', body: '## 概要\n偏僻小鎮。' }]);
    assert.deepEqual(entries.map((e) => [e.title, e.category, !!e.body]), [['青崖鎮', '地域', true], ['青雲宗', '宗門', false]]);
    assert.match(warnings.join('\n'), /青雲宗.*正文沒有生成出來/);
    const art = A.parseArtifact(
      { stage: 'setting', capability: 'generate' },
      L.renderLoreList(categories, entries),
      { kind: 'setting', doc: 'lore' }
    );
    assert.equal(art.kind, 'loreList');
    assert.deepEqual(art.categories, ['地域', '宗門', '法寶']);
    assert.deepEqual(art.entries[0].keywords, ['青崖']);
    assert.equal(art.entries[0].brief, '青崖鎮是什麼');
    assert.equal(A.describeArtifact(art), '設定清單 · 2 條 · 3 個分類');
    assert.equal(A.isArtifactEmpty(art), false);
    // 模型第一次呼叫的原樣清單（agent 那條路）也認：沒有正文就是空的。
    const raw = A.parseArtifact({ stage: 'setting', capability: 'generate' }, JSON.stringify({ entries: [row('青崖鎮', '地域')] }), {
      kind: 'setting',
      doc: 'lore',
    });
    assert.deepEqual(raw.categories, ['地域']);
    assert.equal(raw.entries[0].body, '');
    assert.equal(A.isArtifactEmpty(A.parseArtifact({ stage: 'setting', capability: 'generate' }, '沒有清單', { kind: 'setting', doc: 'lore' })), true);
  });
});

describe('novelConfig.ts · 小說配置', () => {
  const generated = {
    genre: '玄幻',
    targetAudience: '男頻',
    subGenre: '東方玄幻 · 宗門',
    plotStructure: 'three_act',
    narrativePOV: 'third_limited',
    coreOutline: '少年揹著舊案入宗，查出宗門與滅門案的關係。',
    sellingPoints: '殘令回放死者最後一刻：每次都在眾人面前翻案。',
    worldSetting: '靈脈枯竭的九州。',
    goldenFinger: '一塊能回放死者最後一刻的殘令。',
    protagonistProfile: '林昭，隱忍，想替父洗冤。',
    globalGuidance: '1. 不寫上帝視角\n2. 每章留鉤子\n3. 金手指每次使用都有代價\n4. 對白要分得出是誰在說',
    writingStyle: '冷峻剋制，短句為主。',
  };

  test('英文鍵對映到八節，文風單獨拿出來', () => {
    const r = C.decodeNovelConfig(JSON.stringify(generated));
    assert.equal(r.ok, true);
    assert.deepEqual(r.missing, []);
    assert.equal(r.value.sections.金手指, generated.goldenFinger);
    assert.equal(r.value.structure, 'three_act');
    assert.equal(r.value.writingStyle, '冷峻剋制，短句為主。');
    assert.equal(r.value.sections.核心卖点, generated.sellingPoints);
    assert.equal(r.value.sections.一句话, undefined);
  });

  test('logline 只在作者沒寫一句話時補上', () => {
    const r = C.decodeNovelConfig(JSON.stringify({ ...generated, logline: '模型補的一句話' }));
    assert.equal(r.value.sections.一句话, '模型補的一句話');
    const empty = { sections: {} };
    assert.equal(C.mergeWithAuthor(empty, r.value, { preserve: false }).sections.一句话, '模型補的一句話');
    const authored = { sections: { 一句话: '作者的腦洞' } };
    assert.equal(C.mergeWithAuthor(authored, r.value, { preserve: false }).sections.一句话, '作者的腦洞');
    assert.equal(C.mergeWithAuthor(authored, r.value, { preserve: false, idea: '新腦洞' }).sections.一句话, '新腦洞');
  });

  test('缺欄位、列舉寫錯：照收並說明，不作廢', () => {
    const r = C.decodeNovelConfig(JSON.stringify({ ...generated, goldenFinger: undefined, plotStructure: '三段式' }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.missing, ['goldenFinger']);
    assert.equal(r.value.structure, undefined);
    assert.match(r.warnings[0], /三段式/);
    assert.equal(C.decodeNovelConfig('我覺得這個腦洞可以這樣寫').ok, false);
  });

  test('「全域要求」的合同：4–8 條、600 字內、不逐章列大綱', () => {
    assert.equal(C.isGuidanceValid(generated.globalGuidance), true);
    assert.match(C.guidanceProblem('只有一條'), /1 條/);
    assert.match(C.guidanceProblem('字'.repeat(601)), /601 字/);
    assert.match(C.guidanceProblem('第1章：入宗\n第2章：試煉\n規則三\n規則四'), /逐章列大綱/);
  });

  test('保留作者原文：長文字原文在前、生成的追加在後；作者選過的型別不改', () => {
    const existing = S.parseBookConfig(
      ['---', 'genre: 仙俠', 'totalChapters: 60', '---', '# 小說配置', '## 一句話', '少年入宗', '## 金手指', '殘令能看見死者最後一眼'].join('\n'),
      '.novelwarden/config.md'
    );
    const { value } = C.decodeNovelConfig(JSON.stringify(generated));
    const merged = C.mergeWithAuthor(existing, value, {
      idea: '少年入宗查舊案',
      setup: { totalChapters: 100, wordsPerChapter: 3000 },
      preserve: true,
    });
    assert.equal(merged.genre, '仙俠');
    assert.equal(merged.subGenre, '東方玄幻 · 宗門');
    assert.equal(merged.totalChapters, 100);
    assert.equal(merged.sections.金手指, `殘令能看見死者最後一眼\n\n${generated.goldenFinger}`);
    // 新的一句話包含了舊的，就用新的，不疊兩遍。
    assert.equal(merged.sections.一句话, '少年入宗查舊案');
  });

  test('不保留原文時（對話裡的修改意見）生成的那一份就是新版，漏掉的節沿用舊的', () => {
    const existing = S.parseBookConfig('# 小說配置\n## 參考作品\n《雪中》\n## 金手指\n舊金手指', '');
    const { value } = C.decodeNovelConfig(JSON.stringify(generated));
    const merged = C.mergeWithAuthor(existing, value, { preserve: false });
    assert.equal(merged.sections.金手指, generated.goldenFinger);
    assert.equal(merged.sections.参考作品, '《雪中》');
  });

  test('規範化草稿按 config.md 讀回來，文風那一節單獨拿出', () => {
    const { value } = C.decodeNovelConfig(JSON.stringify(generated));
    const merged = C.mergeWithAuthor(S.parseBookConfig('', ''), value, { idea: '少年入宗', setup: { totalChapters: 100, wordsPerChapter: 3000 }, preserve: true });
    const draft = C.renderConfigDraft(merged, value.writingStyle);
    const art = A.parseArtifact({ stage: 'setting', capability: 'generate' }, draft, { kind: 'setting', doc: 'config' });
    assert.equal(art.kind, 'settingDoc');
    assert.equal(art.sections.一句话, '少年入宗');
    assert.equal(art.sections.金手指, generated.goldenFinger);
    assert.equal(art.config.totalChapters, 100);
    assert.equal(art.config.structure, 'three_act');
    assert.equal(art.style, '冷峻剋制，短句為主。');
    // 文風不混進配置的任何一節（D14）。
    assert.ok(!Object.values(art.sections).some((v) => /冷峻剋制/.test(v)));
  });

  test('重寫配置：作者在編輯器裡切的分段格式原樣帶過去（模型不生成它）', () => {
    const existing = S.parseBookConfig('---\nparagraphStyle: indent\n---\n# 小說配置\n## 一句話\n少年入宗', '');
    const { value } = C.decodeNovelConfig(JSON.stringify(generated));
    for (const preserve of [true, false]) {
      const merged = C.mergeWithAuthor(existing, value, { preserve });
      assert.equal(merged.paragraphStyle, 'indent');
      const art = A.parseArtifact({ stage: 'setting', capability: 'generate' }, C.renderConfigDraft(merged), { kind: 'setting', doc: 'config' });
      assert.equal(art.config.paragraphStyle, 'indent', '草稿讀回來那份也帶著');
    }
  });

  test('模型第一次呼叫的原樣輸出（英文鍵 JSON）也認得', () => {
    const art = A.parseArtifact({ stage: 'setting', capability: 'generate' }, JSON.stringify(generated), { kind: 'setting', doc: 'config' });
    assert.equal(art.sections.核心梗概, generated.coreOutline);
    assert.equal(art.config.pov, 'third_limited');
  });
});

describe('artifact.ts · 細綱批次與單章', () => {
  const act = { stage: 'plot', capability: 'generate' };

  test('給了區間就是一批：只留區間內的章，按章號升序', () => {
    const raw = JSON.stringify({ blueprints: [item(3), item(1), item(9), item(2)] });
    const art = A.parseArtifact(act, raw, { kind: 'plot', plotRelPath: '.novelwarden/summaries/001.md' }, { from: 1, to: 3 });
    assert.equal(art.kind, 'plotBatch');
    assert.deepEqual(art.items.map((b) => b.no), [1, 2, 3]);
    assert.match(A.describeArtifact(art), /第 1–3 章（3 章）/);
  });

  // 批次路徑不做全文兜底：解不出來就是空的，採納時說「解析不出」，什麼都不寫。
  test('一批解不出來就是空產物', () => {
    const art = A.parseArtifact(act, '這幾章我覺得可以這樣排……', undefined, { from: 1, to: 5 });
    assert.equal(A.isArtifactEmpty(art), true);
  });

  test('單章也認批次合同的單項形式（生成與落定契約一致）', () => {
    const raw = JSON.stringify({ blueprints: [item(4)] });
    for (const capability of ['generate', 'settle']) {
      const art = A.parseArtifact({ stage: 'plot', capability }, raw);
      assert.equal(art.kind, 'plot');
      assert.equal(art.sections.关键事件, '- 第 4 章林昭在山門外踩點\n- 第 4 章翻牆進了後院');
      assert.equal(art.sections.梗概, '第 4 章的梗概');
      assert.equal(art.sections.出场人物, '林昭、沈青');
      assert.equal(art.sections.看点, '- 第 4 章的爽點\n- 第 4 章的鉤子');
      assert.equal(art.title, '第4章標題');
    }
  });

  test('大綱帶區間', () => {
    const art = A.parseArtifact({ stage: 'outline', capability: 'generate' }, '## 第21–40章：風起\n……', undefined, { from: 21, to: 40 });
    assert.deepEqual(art.range, { from: 21, to: 40 });
  });
});
