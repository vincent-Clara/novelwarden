/**
 * 工程頁重新整理的讀盤次數。
 *
 * `buildProjectTree` 由檔案監聽觸發（兩個殼各去抖 250ms），**作者每存一次盤就跑一次**。
 * 它一次要把全書的產物聚合出來，所以「每章多讀一個檔案」在五百章工程上就是
 * 多五百次讀盤——這條路上的浪費不會報錯、不會變紅，只會讓工程頁越用越慢。
 *
 * 因此這裡斷言的不是耗時（機器一換就飄），而是**讀盤次數**：
 *
 * 1. 同一個檔案在一次重新整理裡至多讀一次——重複讀盤一律是取數方各讀各的，
 *    而不是真的需要讀兩遍；
 * 2. 每章的 fs 呼叫數有上限——擋住「新加一層產物順手每章多掃一個目錄」。
 *
 * 計數靠替換 `node:fs/promises` 上的方法。core 的讀盤全部經 `model/fs.ts`，
 * 而那裡只用 `fs.readFile` / `fs.stat` / `fs.readdir`，所以替換這三個就夠。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

/** 造多少章。夠大到能把「每章 +1」與常數項區分開，又不至於讓用例變慢。 */
const PLOTS = 40;

let bundle;
let t;
let project;

/** 本輪記到的讀盤：絕對路徑 → 次數。 */
let reads;
/** 本輪 fs 呼叫總數（含 readdir / stat）。 */
let calls;
let counting = false;
let restore;

/** 把三個讀方法換成會計數的版本，返回還原函式。 */
function instrument() {
  const original = { readFile: fsp.readFile, stat: fsp.stat, readdir: fsp.readdir };
  fsp.readFile = async (...args) => {
    if (counting) {
      calls++;
      const key = path.resolve(String(args[0]));
      reads.set(key, (reads.get(key) ?? 0) + 1);
    }
    return original.readFile.apply(fsp, args);
  };
  fsp.stat = async (...args) => {
    if (counting) calls++;
    return original.stat.apply(fsp, args);
  };
  fsp.readdir = async (...args) => {
    if (counting) calls++;
    return original.readdir.apply(fsp, args);
  };
  return () => Object.assign(fsp, original);
}

/** 跑一次全量重新整理並統計。`project.invalidate()` 模擬「磁碟變過了」。 */
async function measure() {
  project.invalidate();
  reads = new Map();
  calls = 0;
  counting = true;
  try {
    return await bundle.projectView.buildProjectTree(project);
  } finally {
    counting = false;
  }
}

/**
 * 一章「全都齊了」的內容：定稿過的細綱 + 同號章節，各條取數路徑（流水線、出場索引、定稿新鮮度）
 * 都會走到。一章一綱之後沒有中轉站那一份了，正文就是章節；定稿反向更新的也是同一份細綱，
 * 不再另讀一份單章摘要。
 */
async function writePlot(i, { full = true } = {}) {
  const n = String(i).padStart(3, '0');
  const stem = `${n}-第${i}章`;
  const chapterRel = `chapters/${stem}.md`;
  t.write(chapterRel, `# 第${i}章\n\n${'正文。'.repeat(50)}`);
  project.invalidate();
  // sourceHash 要對上章節，否則停在「待定稿」，走不到「已完成」；帶 cast 才讓出場索引真的幹活。
  // 不寫 writtenFrom：從沒記錄過指紋的正文永不標髒（第 18a 條），這裡不必去算細綱的內容指紋。
  const sourceHash =
    (await project.listChapters()).find((c) => c.relPath === chapterRel)?.contentHash ?? '';
  t.write(
    `.novelwarden/summaries/${stem}.md`,
    `---\nno: ${i}\ntitle: 第${i}章\nupstreamHash: h\nsourceHash: ${sourceHash}\ncast: [林昭]\n---\n\n` +
      `# 第${i}章\n\n## 梗概\n梗概\n\n## 出場人物\n林昭\n\n## 關鍵事件\n事件\n` +
      (full ? '\n## 看點\n看點\n' : '')
  );
}

before(async () => {
  restore = instrument();
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    projectView: './src/core/views/projectView.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  t = await makeTempProject(bundle.project, { prefix: 'tree-reads', title: '讀盤計數' });
  project = t.project;

  for (let i = 1; i <= PLOTS; i++) {
    await writePlot(i);
  }
  // 敘事線（一條線一個檔案）：有這幾份，下面「至多讀一次」那條才管得到它們。七期的 threads.md 不認、不讀。
  t.write('.novelwarden/threads/玉佩.md', '---\nkind: 支線\nplan: 1-2\n---\n\n# 玉佩\n\n## 進展\n- 第 1 章 · 推進：玉佩露面 〔證據：「玉佩」〕\n');
  t.write('.novelwarden/threads/未归属的伏笔.md', '# 未歸屬的伏筆\n\n## 伏筆\n- 斷劍\n');
  t.write('.novelwarden/threads.md', '# 敘事線\n\n## 舊格式\n');
  // 四十章定稿時敘事線都判過了（四期的水位在 project.json）：線的狀態按判到的那一章算。
  await project.writeManifest({ ...(await project.readManifest()), threadsThrough: PLOTS });
});

after(() => {
  if (restore) restore();
  if (t) cleanup(t.dir);
});

describe('工程頁重新整理 · 讀盤次數', () => {
  test('夾具確實建出了全部章（否則下面的計數沒有意義）', async () => {
    const tree = await measure();
    assert.equal(tree.plotCount, PLOTS);
    // 敘事線頁籤一條線一行：「現在」是定稿到的第 40 章。
    assert.equal(tree.threads.current, PLOTS);
    assert.deepEqual(
      tree.threads.lines.map((l) => [l.name, l.detail, l.warnings.join('｜')]),
      [['玉佩', '支線 · 進行中 · 最近第 1 章', `斷了 ${PLOTS - 1} 章｜過了計劃收束的第 2 章`]]
    );
    assert.equal(tree.threads.unfiled?.total, 1);
  });

  test('敘事線目錄每份讀一次（頁籤那一列與別處共用這一趟）；七期的 threads.md 不讀', async () => {
    await measure();
    const rel = (p) => path.relative(t.dir, p).replace(/\\/g, '/');
    const touched = [...reads.keys()].map(rel).filter((f) => f.startsWith('.novelwarden/threads'));
    assert.deepEqual(touched.sort(), ['.novelwarden/threads/未归属的伏笔.md', '.novelwarden/threads/玉佩.md'].sort());
  });

  // 全齊了才說明各條取數路徑都真的走到了：只建細綱不寫正文、或者沒定稿的話，
  // 定稿新鮮度那一層會被跳過，這份計數就擋不住它回潮。
  test('夾具的各層都齊了', async () => {
    const tree = await measure();
    assert.ok(
      tree.plots.every((p) => p.stage === 'done'),
      tree.plots.map((p) => `${p.no}:${p.stage}`).join('|')
    );
  });

  const repeatedReads = () =>
    [...reads.entries()]
      .filter(([, n]) => n > 1)
      .map(([p, n]) => [path.relative(t.dir, p).replace(/\\/g, '/'), n]);

  // 一期大切換曾讓 `config.md` 讀兩次：`buildPipelineIndex` 讀一次，`buildBookFacts`
  // 的 `settingFilled()` 又讀一次。現在後者吃索引裡那一份。
  test('同一個檔案在一次重新整理裡至多讀一次（含 config.md）', async () => {
    await measure();
    const repeated = repeatedReads().map(([rel, n]) => `${rel} ×${n}`);
    assert.deepEqual(
      repeated,
      [],
      `這些檔案被讀了不止一次（取數方各讀各的，攤一次給所有人即可）：\n  ${repeated.join('\n  ')}`
    );
  });

  test('每章的 fs 呼叫數不超過 3 次', async () => {
    await measure();
    // 一章的下限是 2：細綱 1 + 同號章節 1，每份檔案恰好讀一次，再少就得砍功能了。
    //
    // 從前是 3（定稿另寫一份單章摘要），再往前是 4（還有中轉站那一份正文），有場景層時是 9。
    // 細綱並進摘要之後定稿改的就是那份細綱，每章又少讀一個檔案——這份用例正是那筆收益的度量。
    //
    // 上限 3 是給全書那幾次常數開銷（大綱、配置與架構三件、manifest、角色/設定/
    // 草稿目錄）攤下來的餘量，它們不隨章數增長，章數越多這個比值越貼近 2。
    // 真正要擋的是「每章再多讀一個檔案」那類回潮：那會讓這個數直接跳過 3。
    // （下限每降一檔上限跟著收緊一檔，否則多讀一個檔案也還在餘量裡，這條就擋不住了。）
    const perPlot = calls / PLOTS;
    assert.ok(
      perPlot <= 3,
      `每章 ${perPlot.toFixed(1)} 次 fs 呼叫（共 ${calls} 次 / ${PLOTS} 章），上限 3`
    );
  });

  test('章數翻倍時讀盤次數不超過線性增長', async () => {
    const before = calls;
    for (let i = PLOTS + 1; i <= PLOTS * 2; i++) {
      await writePlot(i, { full: false });
    }
    await measure();
    // 二次項（每章都去掃一遍全書）會讓這個比值遠超 2。
    assert.ok(
      calls <= before * 2.2,
      `${PLOTS} 章 ${before} 次 → ${PLOTS * 2} 章 ${calls} 次，超出線性增長`
    );
  });
});
