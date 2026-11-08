/**
 * 上下文詳細度（model/contextDetail.ts）的級別表，以及 config.ts 怎麼讀寫它。
 *
 * 幾條硬約束在這裡釘住：
 * - **第 3 級逐項等於從前寫死的常量**——預設是它，升級不該改別的；
 * - **級別越高，每一項都不少**（只有「角色卡只帶要點」反過來）：表裡填錯一格，開關就不再單調；
 * - **認不出的值回落第 3 級**，不拋；
 * - **舊的兩個鍵不再讀**，下一次儲存時從檔案裡清掉。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule, loadBundle } = require('../../helpers/load');

let m;
before(() => {
  m = loadModule('src/core/model/contextDetail.ts');
});

describe('model/contextDetail · 級別表', () => {
  test('四級，預設第 3 級「詳細」', () => {
    assert.deepEqual(m.CONTEXT_DETAILS, [1, 2, 3, 4]);
    assert.equal(m.DEFAULT_CONTEXT_DETAIL, 3);
    assert.deepEqual(
      m.CONTEXT_DETAILS.map((d) => m.CONTEXT_DETAIL_LABEL[d]),
      ['精簡', '標準', '詳細', '完整']
    );
  });

  // 設定那四項是新加的：從前命中就整條塞、不封頂，幾百條的書會把視窗填滿（設定名錄，2026-10-18）。
  // 拆細綱帶敘事線那三項（`plotThread*` / `plotForeshadowCount`）是敘事線二期加的：從前拆細綱一條線都不帶。
  // 「更早章細綱最多帶幾章」（`summaryChapters`）2026-10-21 刪了：寫正文、寫大綱都不再帶更早幾十章的細綱。
  // 2026-10-24：前序細綱一覽從 100 降到 30（大綱的中段另成 `outlineBriefMax`，仍是 100）；角色圖譜規劃時只給近 20 章出場的一段。
  test('第 3 級逐項等於從前寫死的常量，外加設定封頂、細綱一覽與角色圖譜', () => {
    assert.deepEqual(
      { ...m.CONTEXT_DETAIL_LIMITS[3] },
      {
        fullTextChapters: 2,
        prevTailChars: 1500,
        evidenceRecent: 5,
        evidenceChapters: 12,
        evidenceChars: 6000,
        factsChapters: 12,
        factsChars: 3000,
        threadCount: 6,
        threadChars: 1200,
        plotThreadCount: 8,
        plotForeshadowCount: 14,
        plotThreadChars: 1800,
        outlineBriefMax: 100,
        plotListMax: 30,
        rosterRecent: 20,
        prevPlots: 3,
        nextPlots: 1,
        historyCap: 0.3,
        essentialCards: false,
        castSummaries: 2,
        deriveSamples: 5,
        styleSamples: 2,
        characterChapters: 3,
        referenceSamples: 5,
        threadPlanOutlineChars: 8000,
        threadJudge: 12,
        foreshadowJudge: 16,
        loreFull: 6,
        loreLines: 40,
        loreChars: 5000,
        loreTail: 3,
      }
    );
  });

  test('級別越高每一項都不少（只有「只帶要點」反過來）', () => {
    const rows = m.CONTEXT_DETAILS.map((d) => m.CONTEXT_DETAIL_LIMITS[d]);
    for (const key of Object.keys(rows[0])) {
      for (let i = 1; i < rows.length; i++) {
        const [lo, hi] = [rows[i - 1][key], rows[i][key]];
        if (key === 'essentialCards') {
          assert.ok(!(hi && !lo), `${key} 在第 ${i + 1} 級反而開啟了`);
        } else {
          assert.ok(hi >= lo, `${key}：第 ${i} 級 ${lo} > 第 ${i + 1} 級 ${hi}`);
        }
      }
    }
  });

  test('只有「精簡」不帶定稿原文片段、只帶要點；沒有哪一級再帶更早幾十章的細綱', () => {
    assert.equal(m.CONTEXT_DETAIL_LIMITS[1].evidenceChapters, 0);
    assert.equal(m.CONTEXT_DETAIL_LIMITS[1].essentialCards, true);
    assert.ok([1, 2, 3, 4].every((d) => !('summaryChapters' in m.CONTEXT_DETAIL_LIMITS[d])));
  });

  test('表是凍結的：誰也不能順手改掉一格', () => {
    assert.ok(Object.isFrozen(m.CONTEXT_DETAIL_LIMITS) && Object.isFrozen(m.CONTEXT_DETAIL_LIMITS[3]));
  });
});

describe('model/contextDetail · 容錯與解析', () => {
  test('認不出的一律回落第 3 級', () => {
    for (const bad of [undefined, null, 0, 5, 2.5, NaN, '3', 'high', {}]) {
      assert.equal(m.normalizeContextDetail(bad), 3, String(bad));
    }
    assert.equal(m.normalizeContextDetail(1), 1);
  });

  test('contextLimitsOf：沒寫級別 = 第 3 級那一行；單項覆蓋疊在上面', () => {
    assert.equal(m.contextLimitsOf({}), m.CONTEXT_DETAIL_LIMITS[3]);
    const l = m.contextLimitsOf({ contextDetail: 1, contextOverrides: { fullTextChapters: 4 } });
    assert.equal(l.fullTextChapters, 4);
    assert.equal(l.prevPlots, 1);
  });

  test('takeLast：0 是空（不是 slice(-0) 的整份），Infinity 是全部', () => {
    const list = [1, 2, 3];
    assert.deepEqual(m.takeLast(list, 0), []);
    assert.deepEqual(m.takeLast(list, -1), []);
    assert.deepEqual(m.takeLast(list, 2), [2, 3]);
    assert.deepEqual(m.takeLast(list, Infinity), [1, 2, 3]);
    assert.notEqual(m.takeLast(list, Infinity), list, '拿到的是副本');
  });

  test('說明文字：0 寫「不帶」，不出現 Infinity', () => {
    assert.match(m.describeContextDetail(1), /近章全文 不帶/);
    assert.match(m.describeContextDetail(1), /原文片段 不帶/);
    assert.match(m.describeContextDetail(1), /角色卡只帶要點/);
    assert.match(m.describeContextDetail(1), /前幾章細綱 1 章/);
    assert.match(m.describeContextDetail(3), /大綱一章一行 100 章 · 細綱一覽 30 章 · 角色圖譜 近 20 章出場的/);
    assert.match(m.describeContextDetail(4), /大綱一章一行 不限 · 細綱一覽 不限 · 角色圖譜 全員/);
    assert.doesNotMatch(m.describeContextDetail(4), /Infinity/);
  });

  // 2026-10-21 起寫正文、寫大綱都不帶更早幾十章的細綱：設定頁的說明不能再說「最近 60 章細綱」。
  test('設定頁的說明不提已經刪掉的細綱封頂', () => {
    for (const d of m.CONTEXT_DETAILS) {
      assert.doesNotMatch(m.CONTEXT_DETAIL_HINT[d], /60 章|細綱不封頂/);
    }
  });
});

describe('config · 上下文詳細度的讀寫', () => {
  let config;
  let settings;
  before(() => {
    config = loadBundle({ config: './src/core/config.ts' }).config;
    config.initConfigFromHost({
      config: {
        read: () => settings,
        write: async (s) => {
          settings = s;
        },
      },
    });
  });

  test('缺席 = 第 3 級；認不出 = 第 3 級', () => {
    settings = {};
    assert.equal(config.readConfig().contextDetail, 3);
    settings = { contextDetail: 9 };
    assert.equal(config.readConfig().contextDetail, 3);
    settings = { contextDetail: 1 };
    assert.equal(config.readConfig().contextDetail, 1);
  });

  test('舊的兩個鍵不再讀：留著 recentChaptersFullText: 0 也不生效', () => {
    settings = { recentChaptersFullText: 0, prevChapterTailChars: 100 };
    const cfg = config.readConfig();
    assert.ok(!('recentChaptersFullText' in cfg) && !('prevChapterTailChars' in cfg));
    const limits = m.contextLimitsOf(cfg);
    assert.equal(limits.fullTextChapters, 2);
    assert.equal(limits.prevTailChars, 1500);
  });

  test('下一次儲存時把舊的兩個鍵從檔案裡清掉', async () => {
    settings = { recentChaptersFullText: 0, prevChapterTailChars: 100, temperature: 0.5 };
    await config.updateSettings({ contextDetail: 2 });
    assert.ok(!('recentChaptersFullText' in settings) && !('prevChapterTailChars' in settings), JSON.stringify(settings));
    assert.equal(settings.contextDetail, 2);
    assert.equal(settings.temperature, 0.5);
  });

  test('測試用的單項覆蓋經 readConfig 帶出來，清掉就沒了；config.json 裡同名的鍵不認', () => {
    settings = { contextOverrides: { fullTextChapters: 7 } };
    assert.equal(config.readConfig().contextOverrides, undefined);
    config.setContextLimitsOverride({ fullTextChapters: 0 });
    assert.deepEqual(config.readConfig().contextOverrides, { fullTextChapters: 0 });
    config.setContextLimitsOverride(undefined);
    assert.equal(config.readConfig().contextOverrides, undefined);
  });
});
