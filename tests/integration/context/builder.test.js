/**
 * 上下文裝配全鏈路：優先順序、預算、降級鏈、手動排除、附件截斷、多輪歷史封頂、
 * 四階段配方與身份（架構 / 大綱 / 細綱 / 正文）、provider 配額壓縮，外加工程頁
 * 快照與出場人物索引。
 *
 * 軸是**章**，而且只有一條：細綱號 = 章號。`summaries/NNN-標題.md` 是那一章的細綱
 * （梗概 / 出場人物 / 時間地點 / 關鍵事件 / 看點 / 狀態變更 / 連續性事實；
 * 寫正文之前是計劃，定稿時照正文反向更新成正文寫成的樣子），`chapters/NNN-標題.md` 是
 * 那一章的正文（裝配器讀它），架構三件是 `config.md` / `premise.md` / `world.md`。從前的
 * 卷、劇情段、中轉站 `manuscripts/`、拆章與單獨一份的單章摘要都刪掉了。
 *
 * 示例工程（sample-novel）：config 30 章 × 400 字，大綱三段區間，第 1–3 章細綱與
 * 正文都在、細綱都定稿過且與正文對得上；第 4 章《空匣》只排了細綱（計劃），還沒寫正文。
 *
 * ## 寫盤用例一律跑臨時副本
 *
 * `sample-novel/` 有 hash 斷言（tests/contract/sampleNovel.test.js），任何寫入都會
 * 把它弄紅。需要寫盤的經 `copyFixture()` 複製一份出來跑。
 *
 * ## 那份 vscode 樁其實是死程式碼
 *
 * `src/core/` 早已零 vscode 依賴（tests/contract/corePurity.test.js 守著這條），
 * `project.ts` 走 `node:fs/promises` 讀盤，而 `external: ['vscode']` 讓 bundle 裡
 * 連一句 `require('vscode')` 都不剩。這裡仍然裝上：將來 core 若回退出 vscode
 * 依賴，有樁會照常跑過、沒樁會當場炸，炸出來遠好過靜默改變行為。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadBundle } = require('../../helpers/load');
const { installVscodeStub } = require('../../helpers/vscodeStub');
const { SAMPLE, copyFixture } = require('../../helpers/tmpProject');
const { cleanup } = require('../../helpers/teardown');

// 裝配請求帶 action（階段 × 能力）與 target（在改哪個產物）。
const WRITE = { stage: 'manuscript', capability: 'generate' };
const DISCUSS = { stage: 'manuscript', capability: 'discuss' };

const baseConfig = {
  providers: [
    { id: 'openai', kind: 'openai', baseUrl: 'https://api.openai.com/v1', models: [{ name: 'gpt-4o' }] },
  ],
  model: 'openai/gpt-4o',
  active: {
    ref: 'openai/gpt-4o',
    profile: { id: 'openai', kind: 'openai', baseUrl: 'https://api.openai.com/v1', models: [{ name: 'gpt-4o' }] },
    model: { name: 'gpt-4o' },
  },
  contextWindow: 128000,
  maxOutputTokens: 4096,
  temperature: 0.8,
  chaptersDir: 'chapters',
  draftsDir: 'drafts',
  summaryBatchSize: 15,
  requestTimeoutMs: 300000,
};

const PLOT1 = '.novelwarden/summaries/001-楔子.md';
const PLOT2 = '.novelwarden/summaries/002-客栈里的女人.md';
const PLOT3 = '.novelwarden/summaries/003-夜访.md';
/** 第 4 章的細綱：排好了（計劃），還沒寫正文——全書的下一步就是寫它。 */
const PLOT4 = '.novelwarden/summaries/004-空匣.md';
const CH1 = 'chapters/001-楔子.md';
const CH3 = 'chapters/003-夜访.md';

/**
 * 預設目標是「第 4 章的正文」——細綱排好了、正文還沒寫，裝配器按細綱的章號定位
 * 「前文」邊界。這正是往下寫新一章的真實情形。
 */
function req(ask, extra = {}) {
  return {
    action: WRITE,
    target: { kind: 'manuscript', plotRelPath: PLOT4 },
    ask,
    ...extra,
  };
}

const ids = (built) => new Map(built.items.map((i) => [i.id, i]));
/** 樹是分層的，斷言大多針對葉子，先攤平。 */
const flat = (nodes) => nodes.flatMap((n) => (n.kind === 'dir' ? flat(n.children) : [n]));

let vs;
let projectMod;
let builderMod;
let tokenizerMod;
let projectViewMod;
let castMod;
let project;

// 預算充裕那一輪的結果被後面幾節反覆引用（降級閾值、排除前後的用量對比），
// 只算一次。`ASK` 是作者這一輪說的話——正文層裡它是「這一章的補充要求」，
// 寫正文的依據是那一章的細綱。
const ASK ='林昭答應給年輕守衛看令牌，兩人約定天亮後去見他母親。沈氏在樓下聽見了動靜。';
let built;
let byId;
let inc;
let upToP2Tokens;
let p3Full;
let p3OutlineTokens;

before(async () => {
  vs = installVscodeStub({ level: 'full', root: SAMPLE, config: {} });
  // 一個 bundle 裝全部：分開 bundle 會讓每份產物各帶一份 project.ts，
  // builder / projectView / cast 拿到的就不是同一個類了。
  const bundle = loadBundle({
    project: './src/core/model/project.ts',
    builder: './src/core/context/builder.ts',
    tokenizer: './src/core/context/tokenizer.ts',
    projectView: './src/core/views/projectView.ts',
    cast: './src/core/views/cast.ts',
    render: './src/core/context/layers/render.ts',
  });
  projectMod = bundle.project;
  builderMod = bundle.builder;
  tokenizerMod = bundle.tokenizer;
  projectViewMod = bundle.projectView;
  castMod = bundle.cast;

  project = projectMod.NovelProject.open(SAMPLE);

  built = await builderMod.buildContext(project, req(ASK, { targetWords: 2000 }), baseConfig);
  byId = ids(built);
  inc = (id) => byId.get(id) && (byId.get(id).status === 'included' || byId.get(id).status === 'degraded');

  const sumTokens = (pred) => built.items.filter(pred).reduce((s, i) => s + i.tokens, 0);
  upToP2Tokens = sumTokens((i) => i.priority <= 2);
  p3Full = built.items.find((i) => i.id === 'manuscriptFull:3').tokens;
  // 整章正文放不下時降級成的那一塊：第 3 章定稿過的細綱（有內容的那幾節）。
  const p3Outline = bundle.render.renderPlotSections(await project.getPlot(3));
  p3OutlineTokens = tokenizerMod.estimateTokens(`【第 3 章《夜訪》 · 細綱】\n${p3Outline}`);
});

after(() => vs.restore());

// ---------------------------------------------------------------------------

describe('NovelProject 讀取示例工程', () => {
  let plots;
  let stale;
  let cards;
  let lin;
  let lore;
  let style;
  let global;
  let nextNo;
  let manuscript;
  let bookConfig;
  let filled;

  before(async () => {
    plots = await project.listPlots();
    stale = await project.staleChapters();
    cards = await project.listCharacters();
    lin = cards.find((c) => c.name === '林昭');
    lore = await project.listLore();
    style = await project.readStyleGuide();
    global = await project.readGlobalSummary();
    nextNo = await project.nextPlotNo();
    manuscript = await project.readChapterText(
      (await project.listChapters()).find((c) => c.order === 1)
    );
    bookConfig = await project.readBookConfig();
    filled = await project.settingFilled();
  });

  // 第 5–10 章是隻有梗概的空殼：情節大綱排到了第 10 章（大綱是各章細綱梗概的彙總）。
  test('掃描到 10 章細綱（第 5–10 章只有梗概）', () => {
    assert.equal(plots.length, 10);
  });

  test('細綱按章號排序', () => {
    assert.equal(plots.map((p) => p.no).join(','), '1,2,3,4,5,6,7,8,9,10');
  });

  // 全文大綱 `summaries/global.md` 與細綱同目錄，但它不是數字開頭，不算細綱。
  test('細綱平鋪在 summaries/ 根下，global.md 不算', () => {
    assert.deepEqual(plots.slice(0, 4).map((p) => p.relPath), [PLOT1, PLOT2, PLOT3, PLOT4]);
    assert.ok(plots.every((p) => !p.relPath.endsWith('global.md')));
  });

  test('標題取自 frontmatter', () => {
    assert.equal(plots[1].title, '客棧裡的女人');
  });

  // 「關鍵事件」是判「排過沒有」的唯一判據。
  test('關鍵事件非空（第 1–4 章都排過），第 5–10 章只有梗概', () => {
    assert.ok(plots.slice(0, 4).every((p) => p.sections.关键事件.trim()), plots.map((p) => p.no).join(','));
    assert.ok(plots.slice(4).every((p) => !p.sections.关键事件.trim() && p.sections.梗概.trim()));
  });

  test('定稿過的細綱：出場的人取 frontmatter 的 cast，帶 targetWords 與 sourceHash', () => {
    assert.deepEqual(plots[2].characters, ['林昭', '年輕守衛']);
    assert.equal(plots[2].targetWords, 650);
    assert.ok(plots[2].sourceHash, '第 3 章同步過');
  });

  test('沒定稿的細綱：出場的人取「出場人物」一節（計劃），沒有 sourceHash', () => {
    assert.deepEqual(plots[3].characters, ['林昭', '年輕守衛', '李叔']);
    assert.equal(plots[3].sourceHash, '');
  });

  test('正文讀得到，字數統計合理', () => {
    assert.ok(manuscript.length > 200 && manuscript.length < 600, String(manuscript.length));
  });

  // 待定稿 = 有正文、細綱沒有對得上的 sourceHash。第 4 章還沒寫正文，不算。
  test('示例工程沒有待定稿的章', () => {
    assert.equal(stale.length, 0, `stale: ${stale.map((c) => c.order).join(',')}`);
  });

  // 整條鏈的兩個長度錨點。
  test('小說配置讀得到規模引數', () => {
    assert.equal(bookConfig.totalChapters, 30);
    assert.equal(bookConfig.wordsPerChapter, 400);
  });

  // 設定清單：示例工程已經寫了正文，這一件算填過（在寫的書不被推回架構）。
  test('架構五件都填過', () => {
    assert.deepEqual(filled, { config: true, premise: true, characters: true, world: true, lore: true });
  });

  test('讀到 4 張角色卡', () => {
    assert.equal(cards.length, 4);
  });

  test('林昭卡有別名', () => {
    assert.ok(lin && lin.aliases.includes('阿昭'));
  });

  test('林昭卡標記為主角', () => {
    assert.ok(lin && lin.tags.includes('主角'));
  });

  test('林昭卡「當前狀態」非空', () => {
    assert.ok(lin && lin.sections.当前状态.includes('停舟'));
  });

  test('讀到 2 條設定', () => {
    assert.equal(lore.length, 2);
  });

  test('設定有 keywords', () => {
    assert.ok(lore.some((l) => l.keywords.includes('令牌')));
  });

  test('讀到文風指南', () => {
    assert.ok(style.includes('禁用清單'));
  });

  // 全文大綱（原全書摘要）只剩「主線進展」一節：伏筆與關係的變動歸敘事線。
  test('讀到全文大綱：只有主線進展', () => {
    assert.ok(global.startsWith('## 主線進展') && global.includes('林昭揹著舊藤箱'), global.slice(0, 80));
    assert.ok(!global.includes('未收伏筆') && !global.includes('# 全文大綱'), global.slice(0, 80));
  });

  test('下一個細綱號為 11（大綱排到了第 10 章）', () => {
    assert.equal(nextNo, 11);
  });
});

// ---------------------------------------------------------------------------

describe('裝配：預算充裕（128k）', () => {
  test('P0 系統提示已注入', () => {
    assert.ok(inc('system'));
  });

  test('P0 這一輪的要求已注入', () => {
    assert.ok(inc('ask'));
  });

  test('P0 文風指南已注入', () => {
    assert.ok(inc('style'));
  });

  test('P2 全文大綱已注入', () => {
    assert.ok(inc('globalSummary'));
  });

  test('P3 第 3 章正文已注入', () => {
    assert.ok(inc('manuscriptFull:3'));
  });

  test('P3 第 2 章正文已注入', () => {
    assert.ok(inc('manuscriptFull:2'));
  });

  // 寫正文只帶前幾章細綱（上文，預設 3 章），單列「前幾章細綱」；更早幾十章的細綱與大綱都不帶（2026-10-21）。
  test('P1 前 3 章細綱（上文）都在，記成 plotSummary 單列一節', () => {
    for (const p of [PLOT1, PLOT2, PLOT3]) {
      assert.ok(inc(`plot:${p}`), [...byId.keys()].join(','));
      assert.equal(byId.get(`plot:${p}`).kind, 'plotSummary');
      assert.equal(byId.get(`plot:${p}`).priority, 1);
    }
    assert.ok(byId.get(`plot:${PLOT1}`).text.startsWith('【第 1 章《楔子》 · 上文】'), byId.get(`plot:${PLOT1}`).text.slice(0, 40));
  });

  test('寫正文不帶情節大綱', () => {
    assert.ok(![...byId.keys()].some((id) => id.startsWith('outline')), [...byId.keys()].join(','));
  });

  test('第 4 章的細綱作為寫作依據注入', () => {
    assert.ok(inc(`plot:${PLOT4}`), [...byId.keys()].join(','));
  });

  // 預算充裕時整章正文已含結尾，P0 的結尾片段應被撤掉以免重複。
  test('整章正文注入後結尾片段被撤銷', () => {
    assert.equal(byId.get('prevTail:3').status, 'dropped');
  });

  test('撤銷原因寫明瞭重複', () => {
    assert.ok(byId.get('prevTail:3').note.includes('無需重複'));
  });

  test('第 3 章正文標註為接續點', () => {
    assert.ok(byId.get('manuscriptFull:3').note.includes('續寫將從此處接續'));
  });

  test('上一章結尾在 prompt 中只出現一次', () => {
    const occurrences = built.messages[1].content.split('雨已經停了。窗外月亮出來').length - 1;
    assert.equal(occurrences, 1);
  });

  test('user 含接續指示', () => {
    assert.ok(built.messages[1].content.includes('無縫接下去'));
  });

  test('要求裡點名的角色 林昭', () => {
    assert.ok(inc('character:林昭'));
  });

  test('要求裡點名的角色 沈氏', () => {
    assert.ok(inc('character:沈氏'));
  });

  test('要求裡點名的角色 年輕守衛', () => {
    assert.ok(inc('character:年轻守卫'));
  });

  test('命中角色帶命中原因', () => {
    assert.ok(byId.get('character:沈氏').note.includes('沈氏'));
  });

  test('設定「崖字令牌」被關鍵詞命中', () => {
    assert.ok(inc('lore:崖字令牌'), '要求裡含「令牌」');
  });

  test('設定「青崖鎮」未被誤命中', () => {
    assert.ok(!inc('lore:青崖鎮'), '要求裡不含青崖/停舟');
  });

  test('用量不超預算', () => {
    assert.ok(built.usedTokens <= built.budget, `${built.usedTokens} / ${built.budget}`);
  });

  test('預算 = 視窗 - 輸出 - 餘量', () => {
    assert.equal(built.budget, 128000 - 4096 - 512);
  });

  test('未被 provider 壓縮', () => {
    assert.equal(built.budgetClampedByProvider, false);
  });

  test('訊息為 system + user 兩條', () => {
    assert.equal(built.messages.length, 2);
  });

  test('首條為 system', () => {
    assert.equal(built.messages[0].role, 'system');
  });

  test('user 含文風指南段', () => {
    assert.ok(built.messages[1].content.includes('# 文風指南'));
  });

  test('user 含全文大綱段（從前叫「全書前情提要」）', () => {
    assert.ok(built.messages[1].content.includes('# 全文大綱\n'));
  });

  test('user 含角色設定段', () => {
    assert.ok(built.messages[1].content.includes('# 相關角色設定'));
  });

  test('user 含這一輪的要求', () => {
    assert.ok(built.messages[1].content.includes(ASK));
  });

  // 正文層的依據是細綱，作者這一句是補充要求——從前這裡叫「本段劇情綱要」，
  // 那是細綱還不存在時的說法。
  test('要求那一段的小標題是「這一章的補充要求」', () => {
    assert.ok(built.messages[1].content.includes('# 這一章的補充要求'), built.messages[1].content.slice(-600));
  });

  test('user 含目標字數', () => {
    assert.ok(built.messages[1].content.includes('2000 字'));
  });

  test('正文原文確實在 user 裡', () => {
    assert.ok(built.messages[1].content.includes('三更，林昭醒了'), '第 3 章正文');
  });

  test('前文正文按由遠及近排列', () => {
    const user = built.messages[1].content;
    assert.ok(user.indexOf('【第 2 章') < user.indexOf('【第 3 章'));
  });
});

// ---------------------------------------------------------------------------

// 預算閾值由實測的條目大小反推，避免示例文字長度變化後測試失效。
// 注意要把 P0~P2 已佔用的量都算進去，否則輪到 P3 時剩餘預算不是預期值。
describe('裝配：預算剛好放不下整章正文（應降級為細綱）', () => {
  let deg;
  let dById;
  let item;

  before(async () => {
    // 關掉結尾片段，單獨考察 manuscriptFull 的降級鏈。
    const mid = p3OutlineTokens + Math.floor((p3Full - p3OutlineTokens) / 2);
    const window = upToP2Tokens + mid + 2000 + 512;
    const cfg = { ...baseConfig, contextOverrides: { prevTailChars: 0 }, maxOutputTokens: 2000, contextWindow: window };
    deg = await builderMod.buildContext(project, req(ASK), cfg);
    dById = ids(deg);
    item = dById.get('manuscriptFull:3');
  });

  test('結尾片段已關閉時不注入 prevTail', () => {
    assert.ok(!dById.has('prevTail:3'));
  });

  test('第 3 章正文降級為細綱', () => {
    assert.equal(
      item.status,
      'degraded',
      `full=${p3Full}, outline=${p3OutlineTokens}, budget=${deg.budget}, note=${item.note}`
    );
  });

  // 第 3 章定稿過、對得上正文：不標「計劃」。
  test('降級後內容確實是那一章定稿過的細綱', () => {
    assert.ok(item.text.startsWith('【第 3 章《夜訪》 · 細綱】\n## 梗概'), item.text.slice(0, 40));
  });

  test('降級後不含原文句子', () => {
    assert.ok(!item.text.includes('三更，林昭醒了'));
  });

  test('降級說明寫明瞭原因', () => {
    assert.equal(item.note, `正文需 ${p3Full} token 放不下，已降級為細綱`);
  });

  test('降級後 tokens 小於原文', () => {
    assert.ok(item.tokens < p3Full, `${item.tokens} vs ${p3Full}`);
  });

  test('降級項進入了 messages', () => {
    assert.ok(deg.messages[1].content.includes(item.text.slice(0, 30)));
  });

  test('用量不超預算', () => {
    assert.ok(deg.usedTokens <= deg.budget, `${deg.usedTokens} / ${deg.budget}`);
  });
});

/**
 * 降級成的那份細綱標不標「計劃」，只看這一章定稿過沒有（有沒有 sourceHash）：從沒定稿的是寫之前的
 * 計劃；定稿過、之後正文又改過的仍是照正文更新過的那一版，不是計劃。
 */
describe('裝配：降級成細綱時，「計劃」只標沒定稿過的章', () => {
  /** 第 3 章正文差 5 個 token 放不下時，它降級成的那一條。 */
  async function degradedP3(edit) {
    const fixture = copyFixture('builder-degrade-plan');
    try {
      edit(fixture);
      const p = projectMod.NovelProject.open(fixture.dir);
      const cfg = { ...baseConfig, contextOverrides: { prevTailChars: 0 }, maxOutputTokens: 2000 };
      const roomy = await builderMod.buildContext(p, req(ASK), cfg);
      const upToP2 = roomy.items.filter((i) => i.priority <= 2).reduce((sum, i) => sum + i.tokens, 0);
      const full = roomy.items.find((i) => i.id === 'manuscriptFull:3').tokens;
      const tight = await builderMod.buildContext(p, req(ASK), { ...cfg, contextWindow: upToP2 + full - 5 + 2000 + 512 });
      return tight.items.find((i) => i.id === 'manuscriptFull:3');
    } finally {
      cleanup(fixture.dir);
    }
  }

  test('定稿之後正文又改過：不標「計劃」', async () => {
    const item = await degradedP3((f) => f.write(CH3, `${f.read(CH3)}\n\n作者後來補的一句。\n`));
    assert.equal(item.status, 'degraded', item.note);
    assert.ok(item.text.startsWith('【第 3 章《夜訪》 · 細綱】\n'), item.text.slice(0, 40));
  });

  test('從沒定稿過：塊頭與說明都寫明是計劃', async () => {
    const item = await degradedP3((f) => f.write(PLOT3, f.read(PLOT3).replace(/^sourceHash: .*\r?\n/m, '')));
    assert.equal(item.status, 'degraded', item.note);
    assert.ok(item.text.startsWith('【第 3 章《夜訪》 · 細綱（計劃，沒定稿）】\n'), item.text.slice(0, 40));
    assert.match(item.note, /已降級為細綱（還沒同步，是寫之前的計劃）$/);
  });
});

// ---------------------------------------------------------------------------

describe('裝配：預算極小（P0 之外幾乎全丟）', () => {
  let small;
  let sById;
  let degradedOrDropped;

  before(async () => {
    const tight = { ...baseConfig, contextWindow: 3000, maxOutputTokens: 2000, contextOverrides: { prevTailChars: 300 } };
    small = await builderMod.buildContext(project, req(ASK), tight);
    sById = ids(small);
    degradedOrDropped = small.items.filter((i) => i.status === 'degraded' || i.status === 'dropped');
  });

  test('P0 這一輪的要求仍然注入', () => {
    assert.equal(sById.get('ask').status, 'included');
  });

  test('P0 上一章結尾仍然注入', () => {
    assert.equal(sById.get('prevTail:3').status, 'included');
  });

  test('結尾片段確實帶正文', () => {
    assert.ok(sById.get('prevTail:3').text.includes('月亮出來'));
  });

  test('user 含上一章結尾段', () => {
    assert.ok(small.messages[1].content.includes('上一章結尾原文'));
  });

  test('預算不足時整章正文不與結尾片段合併', () => {
    assert.equal(sById.get('manuscriptFull:3').status, 'dropped');
  });

  test('存在被降級/丟棄的條目', () => {
    assert.ok(degradedOrDropped.length > 0, `got ${degradedOrDropped.length}`);
  });

  test('每個降級/丟棄條目都帶原因', () => {
    assert.ok(
      degradedOrDropped.every((i) => !!i.note),
      JSON.stringify(degradedOrDropped.filter((i) => !i.note).map((i) => i.id))
    );
  });

  test('被丟棄的條目 tokens 歸零', () => {
    assert.ok(small.items.filter((i) => i.status === 'dropped').every((i) => i.tokens === 0));
  });

  test('被丟棄的條目 text 為空', () => {
    assert.ok(small.items.filter((i) => i.status === 'dropped').every((i) => i.text === ''));
  });

  test('丟棄項不進 messages', () => {
    assert.ok(!small.messages[1].content.includes('三更，林昭醒了'));
  });

  // 逐條核對：進 messages 的文字必須全部來自 included/degraded 條目
  test('丟棄/排除項一律不帶 text', () => {
    const droppedWithText = small.items.filter(
      (i) => (i.status === 'dropped' || i.status === 'excluded') && i.text.trim()
    );
    assert.equal(droppedWithText.length, 0, JSON.stringify(droppedWithText.map((i) => i.id)));
  });

  test('所有存活條目的文字都進了 messages', () => {
    const liveTexts = small.items
      .filter((i) => (i.status === 'included' || i.status === 'degraded') && i.text.trim())
      .map((i) => i.text);
    assert.ok(liveTexts.every((t) => small.messages.some((m) => m.content.includes(t.slice(0, 30)))));
  });
});

// ---------------------------------------------------------------------------

describe('裝配：手動排除條目', () => {
  let excluded;
  let eById;

  before(async () => {
    excluded = await builderMod.buildContext(
      project,
      req(ASK, { excludedIds: ['style', 'character:沈氏', 'manuscriptFull:2'] }),
      baseConfig
    );
    eById = ids(excluded);
  });

  test('style 被標記 excluded', () => {
    assert.equal(eById.get('style').status, 'excluded');
  });

  test('沈氏被標記 excluded', () => {
    assert.equal(eById.get('character:沈氏').status, 'excluded');
  });

  test('第 2 章正文被標記 excluded', () => {
    assert.equal(eById.get('manuscriptFull:2').status, 'excluded');
  });

  test('excluded 項 tokens 為 0', () => {
    assert.equal(eById.get('style').tokens, 0);
  });

  test('excluded 項不進 messages', () => {
    assert.ok(!excluded.messages[1].content.includes('# 文風指南'));
  });

  test('排除後總用量下降', () => {
    assert.ok(excluded.usedTokens < built.usedTokens, `${excluded.usedTokens} vs ${built.usedTokens}`);
  });

  test('未被排除的項仍在', () => {
    assert.equal(eById.get('character:林昭').status, 'included');
  });
});

// ---------------------------------------------------------------------------

describe('裝配：provider 配額壓縮', () => {
  let clamped;

  before(async () => {
    // 上限要蓋得住強制項（系統提示、文風、本章細綱、上一章結尾……約 3.7k token）：強制項本來就
    // 可以超預算，這裡考察的是壓縮之後其餘條目照新預算取捨。
    clamped = await builderMod.buildContext(
      project,
      req(ASK, { providerMaxInputTokens: 10000 }),
      baseConfig
    );
  });

  test('標記為被 provider 壓縮', () => {
    assert.equal(clamped.budgetClampedByProvider, true);
  });

  test('預算按 provider 上限算', () => {
    assert.equal(clamped.budget, 10000 - 4096 - 512);
  });

  test('用量不超壓縮後預算', () => {
    assert.ok(clamped.usedTokens <= clamped.budget, `${clamped.usedTokens} / ${clamped.budget}`);
  });
});

// ---------------------------------------------------------------------------

describe('裝配：帶修改意見重寫', () => {
  let rev;
  let rById;

  before(async () => {
    rev = await builderMod.buildContext(
      project,
      req(ASK, {
        revision: { previousDraft: '上一版的正文內容，寫得太文氣了。', feedback: '對白改口語一些' },
      }),
      baseConfig
    );
    rById = ids(rev);
  });

  test('revision 條目已注入', () => {
    assert.equal(rById.get('revision').status, 'included');
  });

  test('user 含修訂要求段', () => {
    assert.ok(rev.messages[1].content.includes('# 修訂要求'));
  });

  test('user 含上一版草稿', () => {
    assert.ok(rev.messages[1].content.includes('寫得太文氣了'));
  });

  test('user 含修改意見', () => {
    assert.ok(rev.messages[1].content.includes('對白改口語一些'));
  });
});

// ---------------------------------------------------------------------------

describe('裝配：從第 1 章開始寫（無前文）', () => {
  let first;
  let fById;

  before(async () => {
    // target 裡沒有路徑可認章號（老會話、手搓的請求）時，靠 targetNo 定位前文邊界。
    first = await builderMod.buildContext(
      project,
      req('開篇：主角進城。', { target: { kind: 'manuscript', plotRelPath: '' }, targetNo: 1 }),
      baseConfig
    );
    fById = ids(first);
  });

  test('無前一章時不注入 prevTail', () => {
    assert.ok(![...fById.keys()].some((k) => k.startsWith('prevTail:')));
  });

  test('無前文時不注入正文原文', () => {
    assert.ok(![...fById.keys()].some((k) => k.startsWith('manuscriptFull:')));
  });

  test('仍然注入系統提示與這一輪的要求', () => {
    assert.ok(fById.get('system').status === 'included' && fById.get('ask').status === 'included');
  });

  test('仍然注入文風指南', () => {
    assert.equal(fById.get('style').status, 'included');
  });

  test('主角仍被注入（tags 含主角）', () => {
    assert.equal(fById.get('character:林昭').status, 'included');
  });

  test('主角注入原因為「主角，始終注入」', () => {
    assert.ok(fById.get('character:林昭').note.includes('主角'));
  });
});

// ---------------------------------------------------------------------------

describe('裝配：接著寫第 3 章（target 指向它自己）', () => {
  let aById;

  before(async () => {
    // 接著寫已經落盤的第 3 章：target 指向它自己，章號由磁碟上的細綱決定。
    const append = await builderMod.buildContext(
      project,
      req('接著寫下去。', { target: { kind: 'manuscript', plotRelPath: PLOT3 } }),
      baseConfig
    );
    aById = ids(append);
  });

  test('前文只取到第 2 章', () => {
    assert.ok(aById.has('prevTail:2') && !aById.has('prevTail:3'));
  });

  test('第 3 章自身不作為前文注入', () => {
    assert.ok(!aById.has('manuscriptFull:3'));
  });

  test('第 3 章的細綱作為寫作依據注入', () => {
    assert.equal(aById.get(`plot:${PLOT3}`).status, 'included');
  });
});

// ---------------------------------------------------------------------------

describe('裝配：使用者 @ 的引用', () => {
  let att;
  let m;
  let manuallyExcluded;

  before(async () => {
    att = await builderMod.buildContext(
      project,
      req('繼續寫。', {
        attachments: [
          { id: 'sel1', kind: 'selection', label: '003-夜访.md:5-9',
            relPath: CH3,
            range: { start: 5, end: 9 }, text: '這是我選中的一段話，請針對它修改。' },
          { id: 'file1', kind: 'character', label: '林昭.md', relPath: '.novelwarden/characters/林昭.md' },
          { id: 'gone', kind: 'file', label: '不存在.md', relPath: 'chapters/不存在.md' },
        ],
      }),
      baseConfig
    );
    m = ids(att);
    manuallyExcluded = await builderMod.buildContext(
      project,
      req('x', {
        attachments: [{ id: 'sel1', kind: 'selection', label: 'a', text: '內容' }],
        excludedIds: ['attachment:sel1'],
      }),
      baseConfig
    );
  });

  test('選區附件已注入', () => {
    assert.equal(m.get('attachment:sel1').status, 'included');
  });

  test('選區用的是快照文字', () => {
    assert.ok(m.get('attachment:sel1').text.includes('這是我選中的一段話'));
  });

  test('檔案附件讀盤注入', () => {
    assert.ok(m.get('attachment:file1').text.includes('林昭'));
  });

  test('檔案附件為 P0', () => {
    assert.equal(m.get('attachment:file1').priority, 0);
  });

  test('檔案不存在時判 dropped', () => {
    assert.equal(m.get('attachment:gone').status, 'dropped');
  });

  test('缺失附件帶原因', () => {
    assert.ok(m.get('attachment:gone').note.includes('不存在'));
  });

  test('user 含引用段', () => {
    assert.ok(att.messages[att.messages.length - 1].content.includes('# 我引用的內容'));
  });

  test('附件可被手動排除', () => {
    assert.equal(manuallyExcluded.items.find((i) => i.id === 'attachment:sel1').status, 'excluded');
  });
});

// ---------------------------------------------------------------------------

describe('裝配：超大附件應截斷而非丟棄', () => {
  let att;
  let item;

  before(async () => {
    const huge = '很長的引用內容。'.repeat(4000);
    att = await builderMod.buildContext(
      project,
      req('繼續寫。', { attachments: [{ id: 'big', kind: 'file', label: '大檔案.md', text: huge }] }),
      { ...baseConfig, contextWindow: 20000, maxOutputTokens: 2000 }
    );
    item = att.items.find((i) => i.id === 'attachment:big');
  });

  test('超大附件降級而非丟棄', () => {
    assert.equal(item.status, 'degraded');
  });

  test('降級說明寫明截斷', () => {
    assert.ok(item.note.includes('截斷'), item.note);
  });

  test('截斷後不超過預算 35%', () => {
    assert.ok(
      item.tokens <= Math.floor(att.budget * 0.35) + 5,
      `${item.tokens} vs ${Math.floor(att.budget * 0.35)}`
    );
  });

  test('用量不超預算', () => {
    assert.ok(att.usedTokens <= att.budget, `${att.usedTokens} / ${att.budget}`);
  });

  test('前文仍有空間注入', () => {
    assert.ok(att.items.some((i) => i.kind === 'manuscriptFull' && i.status !== 'dropped'));
  });
});

// ---------------------------------------------------------------------------

describe('裝配：多輪對話歷史', () => {
  const history = [
    { id: 'h1', role: 'user', content: '先寫林昭進城。', at: '2026-08-01T10:00:00Z' },
    { id: 'h2', role: 'assistant', content: '林昭在辰時進了城門。', at: '2026-08-01T10:01:00Z' },
    { id: 'h3', role: 'user', content: '語氣再冷一點。', at: '2026-08-01T10:02:00Z' },
  ];
  let conv;
  let m;
  let someExcluded;

  before(async () => {
    conv = await builderMod.buildContext(project, req('接著寫夜裡的部分。', { history }), baseConfig);
    m = ids(conv);
    someExcluded = await builderMod.buildContext(
      project,
      req('x', { history, excludedIds: ['history:h2'] }),
      baseConfig
    );
  });

  test('三輪歷史都已注入', () => {
    assert.ok(['h1', 'h2', 'h3'].every((h) => m.get(`history:${h}`).status === 'included'));
  });

  test('歷史為 P1', () => {
    assert.equal(m.get('history:h1').priority, 1);
  });

  test('歷史明細按時間正序', () => {
    assert.equal(
      conv.items.filter((i) => i.kind === 'history').map((i) => i.id).join(','),
      'history:h1,history:h2,history:h3'
    );
  });

  // 歷史必須作為真正的多輪訊息發出，而不是塞進一段文字
  test('訊息數為 system + 3 輪歷史 + 本輪', () => {
    assert.equal(conv.messages.length, 5);
  });

  test('歷史保持 role 交替', () => {
    assert.equal(conv.messages.slice(1, 4).map((x) => x.role).join(','), 'user,assistant,user');
  });

  test('歷史內容原樣', () => {
    assert.equal(conv.messages[2].content, '林昭在辰時進了城門。');
  });

  test('本輪在最後一條', () => {
    assert.ok(conv.messages[4].content.includes('接著寫夜裡的部分'));
  });

  test('歷史不重複出現在本輪文字裡', () => {
    assert.ok(!conv.messages[4].content.includes('語氣再冷一點'));
  });

  test('歷史可被手動排除', () => {
    assert.equal(someExcluded.items.find((i) => i.id === 'history:h2').status, 'excluded');
  });

  test('排除後該輪不進 messages', () => {
    assert.ok(!someExcluded.messages.some((x) => x.content === '林昭在辰時進了城門。'));
  });
});

describe('裝配：已寫入的產物不隨歷史回灌（五期補遺 §1.4）', () => {
  // 跟著主按鈕寫完第 1 章、寫入；又討論了一句；這一輪寫第 2 章。
  const history = [
    { id: 'w1', role: 'user', content: '多寫點雪。', command: '寫正文', at: '2026-08-01T10:00:00Z' },
    { id: 'w2', role: 'assistant', content: '雪下了一夜。第 1 章正文全文……', acceptedTo: 'chapters/001-夜入青雲.md', at: '2026-08-01T10:01:00Z' },
    { id: 'd1', role: 'user', content: '第 2 章要不要讓沈氏先開口？', at: '2026-08-01T10:02:00Z' },
    { id: 'd2', role: 'assistant', content: '可以，讓她先問殘令的下落。', at: '2026-08-01T10:03:00Z' },
    { id: 'x1', role: 'user', content: '再來一版。', command: '寫正文', at: '2026-08-01T10:04:00Z' },
    { id: 'x2', role: 'assistant', content: '沒採納的那一版正文……', artifact: { where: '第 1 章', summary: '正文', overwrites: true, declined: true }, at: '2026-08-01T10:05:00Z' },
  ];
  let conv;
  let m;

  before(async () => {
    conv = await builderMod.buildContext(project, req('寫第 2 章。', { history }), baseConfig);
    m = ids(conv);
  });

  test('寫入了的那一輪與發起它的命令都不帶，明細裡說清落在哪', () => {
    assert.equal(m.get('history:w2').status, 'dropped');
    assert.match(m.get('history:w2').note, /已寫入「chapters\/001-夜入青雲\.md」，以磁碟上那一份為準/);
    assert.equal(m.get('history:w1').status, 'dropped');
    assert.match(m.get('history:w1').note, /產物已寫入/);
  });

  test('討論與沒採納的那一版照舊帶', () => {
    for (const id of ['d1', 'd2', 'x1', 'x2']) {
      assert.equal(m.get(`history:${id}`).status, 'included', id);
    }
  });

  test('messages 裡沒有寫入了的那份正文', () => {
    assert.ok(!conv.messages.some((x) => x.content.includes('第 1 章正文全文')));
    assert.ok(conv.messages.some((x) => x.content === '沒採納的那一版正文……'));
  });
});

describe('裝配：已經移除的內建 agent 那幾輪不隨歷史帶', () => {
  // 舊會話：先讓內建 agent 幹了兩次活（一次說了話、一次一句沒說就停了），後來作者回到討論。
  const tool = (callId) => ({
    kind: 'tool',
    call: { callId, name: 'read', title: 'read', ok: true, summary: '20 行', elapsedMs: 1 },
  });
  const history = [
    { id: 'g1', role: 'user', content: '幫我把第 2 章寫了。', at: '2026-08-01T10:00:00Z' },
    {
      id: 'g2',
      role: 'assistant',
      content: '我先讀一下第 1 章。寫好了。',
      segments: [tool('c1'), { kind: 'text', text: '我先讀一下第 1 章。寫好了。' }],
      at: '2026-08-01T10:01:00Z',
    },
    { id: 'g3', role: 'user', content: '再查一遍伏筆。', at: '2026-08-01T10:02:00Z' },
    { id: 'g4', role: 'assistant', content: '', segments: [tool('c2')], at: '2026-08-01T10:03:00Z' },
    { id: 'd1', role: 'user', content: '第 2 章要不要讓沈氏先開口？', at: '2026-08-01T10:04:00Z' },
    { id: 'd2', role: 'assistant', content: '可以，讓她先問殘令的下落。', at: '2026-08-01T10:05:00Z' },
    { id: 'm1', role: 'assistant', content: '', mcp: true, segments: [tool('c3')], at: '2026-08-01T10:06:00Z' },
  ];
  let conv;
  let m;

  before(async () => {
    conv = await builderMod.buildContext(project, req('接著聊。', { history }), baseConfig);
    m = ids(conv);
  });

  test('agent 那一輪與交給它的指令都不帶，明細裡說清為什麼', () => {
    for (const id of ['g2', 'g4']) {
      assert.equal(m.get(`history:${id}`).status, 'dropped', id);
      assert.match(m.get(`history:${id}`).note, /內建 agent 跑的一輪/, id);
    }
    for (const id of ['g1', 'g3']) {
      assert.equal(m.get(`history:${id}`).status, 'dropped', id);
      assert.match(m.get(`history:${id}`).note, /交給已經移除的內建 agent 的指令/, id);
    }
  });

  test('之後的討論照舊帶', () => {
    for (const id of ['d1', 'd2']) {
      assert.equal(m.get(`history:${id}`).status, 'included', id);
    }
  });

  // MCP 的氣泡沒有正文，按「空訊息」處理，不冒充內建 agent。
  test('MCP 的氣泡不算內建 agent', () => {
    assert.doesNotMatch(m.get('history:m1').note, /內建 agent/);
  });

  test('messages 裡沒有 agent 說過的話', () => {
    assert.ok(!conv.messages.some((x) => x.content.includes('我先讀一下第 1 章')));
    assert.ok(!conv.messages.some((x) => x.content.includes('幫我把第 2 章寫了')));
  });
});

// ---------------------------------------------------------------------------

describe('裝配：歷史預算封頂（由近及遠保留）', () => {
  let conv;
  let kept;
  let droppedH;

  before(async () => {
    const many = [];
    for (let i = 1; i <= 40; i++) {
      many.push({
        id: `m${i}`,
        role: i % 2 === 1 ? 'user' : 'assistant',
        content: `第 ${i} 輪的內容。`.repeat(60),
        at: '2026-08-01T10:00:00Z',
      });
    }
    // 128k 視窗下 40 輪也吃不滿 30%，用一個更貼近實際的小視窗來考察封頂。
    conv = await builderMod.buildContext(
      project,
      req('繼續。', { history: many }),
      { ...baseConfig, contextWindow: 40000 }
    );
    const hist = conv.items.filter((i) => i.kind === 'history');
    kept = hist.filter((i) => i.status === 'included' || i.status === 'degraded');
    droppedH = hist.filter((i) => i.status === 'dropped');
  });

  test('歷史總量被封頂', () => {
    assert.ok(droppedH.length > 0, `kept=${kept.length}, dropped=${droppedH.length}`);
  });

  test('確有部分歷史保留', () => {
    assert.ok(kept.length > 0, `kept=${kept.length}`);
  });

  test('保留的是最近幾輪', () => {
    assert.ok(
      kept.every((k) => Number(k.id.slice(9)) > Math.max(...droppedH.map((d) => Number(d.id.slice(9))))),
      `kept=${kept.map((k) => k.id).join(',')}`
    );
  });

  test('歷史佔用不超過預算 30%', () => {
    assert.ok(kept.reduce((s, i) => s + i.tokens, 0) <= Math.floor(conv.budget * 0.3) + 5);
  });

  test('被丟棄的歷史帶原因', () => {
    assert.ok(droppedH.every((d) => d.note.includes('歷史對話預算已滿')));
  });

  test('用量不超預算', () => {
    assert.ok(conv.usedTokens <= conv.budget, `${conv.usedTokens} / ${conv.budget}`);
  });

  test('封頂後前文仍能注入', () => {
    assert.ok(conv.items.some((i) => i.kind === 'manuscriptFull' && i.status !== 'dropped'));
  });
});

// ---------------------------------------------------------------------------

describe('裝配：單輪過長時取結尾', () => {
  let conv;
  let item;

  before(async () => {
    const long = {
      id: 'big',
      role: 'assistant',
      content: `開頭的部分。${'中間的廢話。'.repeat(3000)}這是結尾的部分。`,
      at: '2026-08-01T10:00:00Z',
    };
    conv = await builderMod.buildContext(
      project,
      req('繼續。', { history: [long] }),
      { ...baseConfig, contextWindow: 40000 }
    );
    item = conv.items.find((i) => i.id === 'history:big');
  });

  test('過長的一輪降級而非丟棄', () => {
    assert.equal(item.status, 'degraded');
  });

  test('降級說明寫明只取結尾', () => {
    assert.ok(item.note.includes('僅注入結尾部分'), item.note);
  });

  test('保留了結尾', () => {
    assert.ok(item.text.includes('這是結尾的部分'));
  });

  test('丟掉了開頭', () => {
    assert.ok(!item.text.includes('開頭的部分'));
  });

  test('用量不超預算', () => {
    assert.ok(conv.usedTokens <= conv.budget, `${conv.usedTokens} / ${conv.budget}`);
  });
});

// ---------------------------------------------------------------------------

describe('裝配：discuss 模式', () => {
  let d;
  let last;
  let writeMode;

  before(async () => {
    d = await builderMod.buildContext(
      project,
      req('林昭這個人物到目前為止立住了嗎？', { action: DISCUSS, targetWords: 2000 }),
      baseConfig
    );
    last = d.messages[d.messages.length - 1].content;
    writeMode = await builderMod.buildContext(project, req('x'), baseConfig);
  });

  // 正文階段的討論物件仍是「作者」這個身份——找編輯聊要切到大綱階段去，
  // 那是身份換人的地方（見下面的四階段配方）。
  test('系統提示保持正文階段的身份', () => {
    assert.ok(d.messages[0].content.includes('作者'), d.messages[0].content.slice(0, 30));
  });

  // 發生什麼由細綱定，正文層只管怎麼寫——討論時也是這個身份。
  test('系統提示寫明本層職責', () => {
    assert.ok(d.messages[0].content.includes('發生什麼不由你決定'), d.messages[0].content.slice(0, 200));
  });

  test('discuss 不強制只輸出正文', () => {
    assert.ok(!d.messages[0].content.includes('只輸出正文'));
  });

  test('discuss 禁止順手改寫產物', () => {
    assert.ok(d.messages[0].content.includes('不要輸出改寫後的完整產物'));
  });

  test('末尾指令為「直接回答」', () => {
    assert.ok(last.includes('請直接回答上面的問題'));
  });

  test('discuss 忽略目標字數', () => {
    assert.ok(!last.includes('2000 字'));
  });

  test('discuss 仍注入文風與角色', () => {
    assert.ok(last.includes('# 文風指南') && last.includes('# 相關角色設定'));
  });

  test('write 模式仍要求只輸出正文', () => {
    assert.ok(writeMode.messages[0].content.includes('只輸出正文'));
  });
});

// ---------------------------------------------------------------------------

/**
 * 四階段配方：架構 → 大綱 → 細綱 → 正文（context/recipes.ts）。
 *
 * 卷那一層刪掉之後配方換成這四張。每一檔釘的都是「這一層該帶什麼、不該帶什麼」，
 * 而不是「裝配器能不能跑」：
 *
 * - **架構層**帶 `settingDocs`（P0 force）：四件一件吃一件，前提要照著配置寫、世界觀
 *   要照著前提與角色寫，少了上一件，這一件就是憑空編的。它**不看正文**——這一層在
 *   第一章之前，也不該被已經寫出來的東西帶著走。
 * - **大綱層**看全域：架構三件 + 大綱全文 + 全文大綱 + 各章細綱，不讀正文原文。
 * - **細綱層**看這一章在大綱裡的位置、前幾章排到哪（上文）、下一章要接到哪（下文），
 *   不讀正文原文——排細綱要的是走向，不是措辭。更早幾章不再另帶一份（`plotSummary`）：
 *   細綱與定稿是同一份檔案，上文與前序細綱一覽已經帶了。
 * - **正文層**的 `plotSelf` 與文風指南都是 P0 force：細綱**就是**寫正文的依據，
 *   文風是「讀者感覺不到換人執筆」的唯一保障。
 */
describe('裝配：四階段配方', () => {
  let sc;
  let sIds;
  let sq;
  let sqIds;
  let sx;
  let sxIds;
  let sChars;
  let sConfig;
  let oc;
  let oIds;
  let og;
  let pc;
  let pIds;
  let pg;
  let mcSame;
  let mc;
  let mIds;
  let squeezed;
  let qIds;
  const SETTING_IDS = ['setting:config', 'setting:premise', 'setting:world'];
  const tiny = { ...baseConfig, contextWindow: 3000, maxOutputTokens: 2000 };
  const alive = (m, id) => m.has(id) && m.get(id).status !== 'dropped' && m.get(id).status !== 'excluded';
  const fullTokens = (b) => b.items.filter((i) => i.kind === 'manuscriptFull').reduce((s, i) => s + i.tokens, 0);
  const lastOf = (b) => b.messages[b.messages.length - 1].content;
  const keysOf = (m, prefix) => [...m.keys()].filter((k) => k.startsWith(prefix));
  const build = (request, cfg = baseConfig) => builderMod.buildContext(project, request, cfg);
  const settingReq = (doc, extra = {}) => ({
    action: { stage: 'setting', capability: 'generate' },
    target: { kind: 'setting', doc },
    ask: '前提要更狠一點。',
    ...extra,
  });

  before(async () => {
    // ------------------------------------------------------------ 架構階段
    sc = await build(settingReq('premise'));
    sIds = ids(sc);
    sq = await build(settingReq('premise'), tiny);
    sqIds = ids(sq);
    sx = await build(settingReq('premise', { excludedIds: ['setting:premise'] }));
    sxIds = ids(sx);
    sChars = await build(settingReq('characters', { ask: '' }));
    sConfig = await build(settingReq('config', { ask: '懸疑武俠' }));

    // ------------------------------------------------------------ 大綱階段
    oc = await build({
      action: { stage: 'outline', capability: 'discuss' },
      target: { kind: 'outline' },
      ask: '第一幕的衝突升級夠不夠？',
    });
    oIds = ids(oc);
    og = await build({
      action: { stage: 'outline', capability: 'generate' },
      target: { kind: 'outline' },
      ask: '續寫第二幕。',
    });

    // ------------------------------------------------------------ 細綱階段
    // 選第 2 章：它前後都有細綱，上文與下文兩層才都有東西可裝。
    pc = await build({
      action: { stage: 'plot', capability: 'discuss' },
      target: { kind: 'plot', plotRelPath: PLOT2 },
      ask: '這一章的節奏是不是太平？',
    });
    pIds = ids(pc);
    pg = await build({
      action: { stage: 'plot', capability: 'generate' },
      target: { kind: 'plot', plotRelPath: PLOT2 },
      ask: '沈氏的試探再狠一點。',
      targetWords: 650,
    });
    // 同一個問題，正文階段要為前幾章的整章正文付錢，細綱階段一個字都不付。
    mcSame = await build({
      action: WRITE,
      target: { kind: 'manuscript', plotRelPath: PLOT2 },
      ask: '這一章的節奏是不是太平？',
    });

    // ------------------------------------------------------------ 正文階段
    mc = await build({
      action: WRITE,
      target: { kind: 'manuscript', plotRelPath: PLOT3 },
      ask: '多寫一點雨停之後的靜。',
      targetWords: 1200,
    });
    mIds = ids(mc);
    squeezed = await build({ action: WRITE, target: { kind: 'manuscript', plotRelPath: PLOT3 }, ask: '繼續。' }, tiny);
    qIds = ids(squeezed);
  });

  // ------------------------------------------------------------ 架構

  test('架構階段身份是網文策劃編輯', () => {
    assert.ok(sc.messages[0].content.includes('資深網文策劃編輯'), sc.messages[0].content.slice(0, 40));
  });

  test('架構階段說清不排章節、不寫正文', () => {
    assert.ok(sc.messages[0].content.includes('你不排章節，也不寫正文'), sc.messages[0].content.slice(0, 400));
  });

  // ★ 這一層的全部依據。正在生成的那一件（前提）也照帶：目標已有內容時，
  //   那一版就是修改的底稿。
  test('★ 架構三件都帶上了', () => {
    assert.ok(SETTING_IDS.every((id) => alive(sIds, id)), keysOf(sIds, 'setting:').join(','));
  });

  test('架構三件是 P0', () => {
    assert.ok(SETTING_IDS.every((id) => sIds.get(id).priority === 0));
  });

  test('架構三件進了「# 故事架構」段', () => {
    const user = lastOf(sc);
    assert.ok(user.includes('# 故事架構') && user.includes('【故事前提】'), user.slice(0, 200));
    assert.ok(user.includes('林昭帶著一塊殘缺'), '配置的核心梗概應在裡面');
  });

  test('架構階段帶上已有的角色', () => {
    assert.ok(alive(sIds, 'character:林昭'), keysOf(sIds, 'character:').join(','));
  });

  test('架構階段不帶任何正文原文', () => {
    assert.ok(
      keysOf(sIds, 'manuscriptFull:').length === 0 && keysOf(sIds, 'prevTail:').length === 0,
      [...sIds.keys()].join(',')
    );
  });

  test('架構階段也不帶早前細綱與全文大綱（不被已經寫出來的東西帶著走）', () => {
    assert.ok(keysOf(sIds, 'plotSummary:').length === 0 && !sIds.has('globalSummary'), [...sIds.keys()].join(','));
  });

  // ★ 預算緊到只剩強制項時它們必須仍然在：少了上一件，這一件就是憑空編的。
  test('★ 預算極小時架構三件仍強制注入', () => {
    assert.ok(
      SETTING_IDS.every((id) => sqIds.get(id).status === 'included'),
      JSON.stringify(SETTING_IDS.map((id) => sqIds.get(id)?.status))
    );
  });

  test('預算極小時擠掉的是角色與大綱，且寫明原因', () => {
    const lost = sq.items.filter((i) => i.status === 'dropped');
    assert.ok(lost.some((i) => i.kind === 'character') && lost.every((i) => i.note), JSON.stringify(lost.map((i) => i.id)));
  });

  // 一件一條：重寫前提時作者可能不想讓舊前提帶偏模型。
  test('架構檔案一件一條，可以單獨取消', () => {
    assert.equal(sxIds.get('setting:premise').status, 'excluded');
    assert.ok(!lastOf(sx).includes('【故事前提】') && lastOf(sx).includes('【小說配置】'));
  });

  test('輸出契約按這一件的小節來', () => {
    const user = lastOf(sc);
    assert.ok(user.includes('「故事前提」') && user.includes('## 核心衝突鏈') && user.includes('## 懸念骨架'), user.slice(-500));
  });

  // 角色圖譜分兩步（上游 AI-Novel-Writer 的兩段式）：第一步只出一張身份清單。
  test('角色圖譜第一步的契約是身份清單', () => {
    const user = lastOf(sChars);
    // 2026-10-25 起按格式寫（一人一份「## 名字」），不寫 JSON；JSON 合同挪給轉寫那一步。
    assert.ok(user.includes('角色圖譜') && user.includes('【身份清單格式】') && user.includes('- 敘事職責：'), user.slice(-600));
    assert.ok(user.includes('不寫 JSON') && !user.includes('{"slots"'), user.slice(-600));
  });

  // ★ 上游內建模板裡的這段設計原則從來沒發出去過（只發 taskGuidance）。這裡補上。
  test('★ 角色圖譜帶上設計原則：盟友、對手、避免臉譜化', () => {
    const user = lastOf(sChars);
    assert.ok(
      user.includes('至少 1 位與主角有深度羈絆的盟友') && user.includes('至少 1 位與主角理念對立的競爭者') && user.includes('切忌臉譜化'),
      user.slice(-1600)
    );
  });

  // 「全域要求」會被每一章讀一遍：逐章大綱寫在這裡是最貴的越界。
  test('小說配置的契約禁止逐章列大綱', () => {
    assert.ok(lastOf(sConfig).includes('不要逐章列大綱'), lastOf(sConfig).slice(-500));
  });

  test('架構階段不寫「只輸出正文」', () => {
    assert.ok(!sc.messages[0].content.includes('只輸出正文'));
  });

  // ------------------------------------------------------------ 大綱

  test('大綱階段身份是長篇策劃編輯', () => {
    assert.ok(oc.messages[0].content.includes('資深長篇小說策劃編輯'), oc.messages[0].content.slice(0, 40));
  });

  test('大綱階段注入大綱（P0，按遠近帶）', () => {
    assert.ok(alive(oIds, 'outlineDoc'));
    assert.equal(oIds.get('outlineDoc').priority, 0);
  });

  test('大綱進了「# 情節大綱」段：沒給區間時最後 10 條整條', () => {
    const user = lastOf(oc);
    assert.ok(user.includes('# 情節大綱') && user.includes('## 第1章：楔子\n林昭帶著殘缺的令牌進青崖鎮'), user.slice(0, 400));
  });

  test('大綱階段帶架構三件（P0）', () => {
    assert.ok(SETTING_IDS.every((id) => alive(oIds, id) && oIds.get(id).priority === 0), keysOf(oIds, 'setting:').join(','));
  });

  // 這是分階段裝配最直接的成本收益：討論故事結構時不該讀三章正文。
  test('大綱階段不帶任何正文原文', () => {
    assert.ok(keysOf(oIds, 'manuscriptFull:').length === 0, keysOf(oIds, 'manuscriptFull:').join(','));
  });

  // 續寫到後面每一次都在為前面幾十章付錢：大綱階段不再帶前面各章的細綱（2026-10-21），已經寫過的由全文大綱交代。
  test('大綱階段不帶各章細綱', () => {
    assert.ok(![...oIds.values()].some((i) => i.kind === 'plotSummary' || i.kind === 'plot'), [...oIds.keys()].join(','));
    assert.ok(alive(oIds, 'globalSummary'), [...oIds.keys()].join(','));
  });

  test('大綱階段不寫「只輸出正文」', () => {
    assert.ok(!oc.messages[0].content.includes('只輸出正文'));
  });

  test('大綱的輸出契約要求一章一條、寫成提綱', () => {
    const user = lastOf(og);
    assert.ok(user.includes('「## 第N章：標題」') && user.includes('一章一條'), user.slice(-1600));
    assert.ok(user.includes('寫成提綱') && user.includes('不寫描寫、比喻、心理渲染和對白'), user.slice(-1600));
  });

  // ------------------------------------------------------------ 細綱

  test('細綱階段身份是劇情編劇', () => {
    assert.ok(pc.messages[0].content.includes('劇情編劇'), pc.messages[0].content.slice(0, 24));
  });

  // ★ 一章一綱的落點：從前這一層禁止寫畫面、只許寫抽象的因果鏈，跑出來的正文是
  //   梗概體的流水賬。現在「關鍵事件」可以寫到具體場面。
  test('★ 細綱可以寫具體場面（不再禁止寫畫面）', () => {
    const system = pc.messages[0].content;
    assert.ok(system.includes('關鍵事件可以寫具體場面'), system.slice(0, 500));
    assert.ok(!system.includes('不寫畫面'), system.slice(0, 500));
  });

  test('但細綱仍然不是正文', () => {
    assert.ok(pc.messages[0].content.includes('不是正文'), pc.messages[0].content.slice(0, 500));
  });

  test('細綱階段注入本章細綱（P0）', () => {
    assert.ok(alive(pIds, `plot:${PLOT2}`));
    assert.equal(pIds.get(`plot:${PLOT2}`).priority, 0);
  });

  test('注入上一章細綱（上文）', () => {
    assert.ok(alive(pIds, `plot:${PLOT1}`) && pIds.get(`plot:${PLOT1}`).label.includes('上文'), keysOf(pIds, 'plot:').join(','));
  });

  // ★ 少了它，改中間某一章時模型不知道後面已經排好了什麼，收尾會與下一章的開頭
  //   撞車或斷裂——「轉折突兀」多半出在這裡。
  test('★ 注入下一章細綱（下文）', () => {
    assert.ok(alive(pIds, `plot:${PLOT3}`) && pIds.get(`plot:${PLOT3}`).label.includes('下文'), keysOf(pIds, 'plot:').join(','));
  });

  // 前後章只注入幾節：上文要「發生了什麼、人物落在什麼處境」，下文要「要去哪、要發生什麼」。
  test('上文給梗概、關鍵事件與狀態變更', () => {
    const text = pIds.get(`plot:${PLOT1}`).text;
    assert.ok(text.includes('梗概：') && text.includes('關鍵事件：') && text.includes('狀態變更：'), text);
    // 關鍵事件是一條一行的列表：另起一行照原樣列，第一條不擠在冒號後面。
    assert.ok(text.includes('關鍵事件：\n- 林昭進入青崖鎮，自稱從「江那邊」來。\n- 林昭以一塊'), text);
  });

  test('上文不帶那一章自己的賬（看點、伏筆、出場人物）', () => {
    const text = pIds.get(`plot:${PLOT1}`).text;
    assert.ok(!text.includes('看點：') && !text.includes('新增伏筆：') && !text.includes('出場人物：'), text);
  });

  test('下文只給梗概與關鍵事件', () => {
    const text = pIds.get(`plot:${PLOT3}`).text;
    assert.ok(text.includes('梗概：') && text.includes('關鍵事件：') && !text.includes('狀態變更：') && !text.includes('看點：'), text);
  });

  // `role` 刪了：標題行只剩「第 N 章《標題》 · 細綱」。
  test('三份細綱都進了「# 細綱」段，標題行不帶 role', () => {
    const user = lastOf(pc);
    assert.ok(user.includes('# 細綱'), user.slice(-800));
    assert.ok(
      user.includes('【第 2 章《客棧裡的女人》 · 細綱】\n## 梗概') &&
        user.includes('【第 1 章《楔子》 · 上文】') &&
        user.includes('【第 3 章《夜訪》 · 下文】'),
      user.slice(-1500)
    );
  });

  // 單章：這一章的梗概在本章細綱裡，前面拆過的章由上文與前序細綱一覽帶——大綱沒有要另帶的（2026-10-22）。
  test('細綱單章不另帶大綱（前面也沒有還沒拆的空殼）', () => {
    assert.ok(!pIds.has('outlineDoc'), keysOf(pIds, 'outline').join(','));
    assert.ok(!lastOf(pc).includes('# 情節大綱'), lastOf(pc).slice(0, 600));
  });

  // 細綱是從架構與大綱裡拆出來的：設定四件在這一層也是 P0（總計劃 §2.3）。
  test('細綱階段帶架構三件（P0）', () => {
    assert.ok(SETTING_IDS.every((id) => alive(pIds, id) && pIds.get(id).priority === 0), keysOf(pIds, 'setting:').join(','));
  });

  test('細綱階段不帶正文原文', () => {
    assert.ok(keysOf(pIds, 'manuscriptFull:').length === 0, keysOf(pIds, 'manuscriptFull:').join(','));
  });

  // 細綱與定稿是同一份檔案：前幾章已經由上文（plotPrev）與前序細綱一覽帶了，同一份不帶兩遍。
  test('細綱階段不帶早前細綱那一層', () => {
    assert.equal(keysOf(pIds, 'plotSummary:').length, 0, keysOf(pIds, 'plotSummary:').join(','));
    assert.ok(!lastOf(pc).includes('# 早前各章細綱'));
  });

  // 拆書的「補細綱」一步刪了，細綱配方不再掛 `written`（已寫正文）層。
  test('細綱階段不帶已寫正文', () => {
    assert.equal(pc.items.filter((i) => i.kind === 'written').length, 0);
  });

  // 這裡不比總量：示例工程一章才三四百字，省下的絕對值看不出來；
  // 真實工程一章三千字 × 近兩章，差的就是一個數量級。
  test('正文階段確實為整章正文花了 token', () => {
    assert.ok(fullTokens(mcSame) > 0, String(fullTokens(mcSame)));
  });

  test('細綱階段一個字的正文都不花', () => {
    assert.equal(fullTokens(pc), 0);
  });

  // 單章也用批次格式的單章形式（第 22 條：兩個入口契約一致），小標題對到細綱的七節（連續性事實除外）。
  // 細綱試點（2026-10-25）：按小標題寫自然語言，JSON 由轉寫模型照抄。原來的 foreshadowing 換成了敘事線那一節（敘事線二期，不進細綱）。
  test('細綱的輸出契約是按小標題寫的單章形式，小標題對到七節', () => {
    const user = lastOf(pg);
    assert.ok(user.includes('寫第 2 章的細綱：以「## 第2章：標題」開頭（章號用阿拉伯數字）。'), user.slice(-2400));
    assert.ok(user.includes('### 梗概') && user.includes('### 關鍵事件') && user.includes('### 敘事線'), user.slice(-1600));
    assert.ok(!user.includes('{"blueprints"'), user.slice(-1600));
  });

  test('契約的關鍵事件按發生順序一條一件事，必填項只要至少一條', () => {
    const user = lastOf(pg);
    assert.ok(user.includes('- 關鍵事件：一條一行、行首寫「- 」，按發生的順序一條一件事，3–6 條，合計 100–300 字'), user.slice(-2400));
    assert.ok(user.includes('一個都不能少，哪一節沒有內容就寫「無」'), user.slice(-2400));
    assert.ok(user.includes('在關鍵事件末尾追加一條「容量衝突：…」'), user.slice(-3200));
  });

  // role 刪了（上面的 JSON 形狀裡沒有它；newCharacters 裡那個 role 是角色定位，另一回事）。
  test('契約不再要 purpose 與 suspenseHook', () => {
    const user = lastOf(pg);
    assert.ok(!user.includes('purpose') && !user.includes('suspenseHook'), user.slice(-1600));
  });

  // 章末鉤子並進了「看點」：不單列，也不再逼每章都有一條（作者：單列的鉤子反而帶偏模型）。
  test('契約的看點照摘要的寫法，不強制每章一條章末鉤子', () => {
    const user = lastOf(pg);
    assert.ok(user.includes('過渡章沒有爽點就只寫鉤子'), user.slice(-1600));
    assert.ok(!user.includes('每章都要有一條章末的鉤子'), user.slice(-1600));
  });

  // 容量合同（上游 DC:131-142）：單章按細綱自己的目標字數算 ±20%。
  test('給了目標字數時契約裡有容量合同', () => {
    assert.ok(lastOf(pg).includes('每章正文目標約 650 字，可接受範圍 520–780 字'), lastOf(pg).slice(-2400));
  });

  // ------------------------------------------------------------ 正文

  test('正文階段仍帶整章正文', () => {
    assert.ok(keysOf(mIds, 'manuscriptFull:').length > 0, [...mIds.keys()].join(','));
  });

  // ★ 細綱**就是**寫正文的依據——所以它是 P0 force。
  //   少了它，模型手上只有文風與前文尾巴，會自己編一章出來。
  test('★ 正文階段帶本章細綱', () => {
    assert.ok(alive(mIds, `plot:${PLOT3}`), [...mIds.keys()].join(','));
  });

  test('正文階段的本章細綱是 P0', () => {
    assert.equal(mIds.get(`plot:${PLOT3}`).priority, 0);
  });

  // 預算緊到只剩強制項時它必須仍然在：沒有細綱的正文是憑空編的。
  test('預算極小時本章細綱仍強制注入', () => {
    assert.equal(qIds.get(`plot:${PLOT3}`).status, 'included', JSON.stringify(qIds.get(`plot:${PLOT3}`)));
  });

  test('正文階段文風指南升到 P0', () => {
    assert.equal(mIds.get('style').priority, 0);
  });

  // ★ 另一條質量收益：文風指南不再與一段長對話搶預算。預算緊到只剩強制項時，
  //   它必須仍然在——「讀者感覺不到換人執筆」全靠它。
  test('預算極小時文風指南仍強制注入', () => {
    assert.equal(qIds.get('style').status, 'included');
  });

  test('預算極小時確實擠掉了別的東西', () => {
    assert.ok(squeezed.items.some((i) => i.status === 'dropped'));
  });

  test('文風指南進了 user 段', () => {
    assert.ok(squeezed.messages[1].content.includes('# 文風指南'));
  });

  // 本層產物緊挨著指令：模型對末尾的東西最敏感，這一章的細綱該在它讀完前文之後、
  // 讀到「現在請你做什麼」之前。
  test('本章細綱在前文之後、補充要求之前', () => {
    const user = lastOf(mc);
    const [full, plot, askAt] = ['# 前文正文', '# 細綱', '# 這一章的補充要求'].map((h) => user.indexOf(h));
    assert.ok(full >= 0 && full < plot && plot < askAt, `${full} / ${plot} / ${askAt}`);
  });

  // 篇幅只給一個大概，不給區間：字數夠不夠由續寫鏈按磁碟數，不讓模型在數字數上花心思。
  test('目標字數寫進系統提示與篇幅，只給大概', () => {
    assert.ok(mc.messages[0].content.includes('篇幅約 1200 字，不必精確'), mc.messages[0].content);
    assert.ok(lastOf(mc).includes('【本章篇幅】\n約 1200 字，不必精確'), lastOf(mc).slice(-600));
    assert.ok(!/±\d+%/.test(lastOf(mc)));
  });

  // 五期補遺 §1.5：民國背景的書裡冒出 PTSD。正文與前面幾個階段的系統提示都帶這一條。
  test('系統提示要求用詞貼合年代（正文與細綱都有）', async () => {
    assert.match(mc.messages[0].content, /用詞貼合故事的年代與世界觀.*PTSD/);
    const plotCtx = await builderMod.buildContext(
      project,
      { action: { stage: 'plot', capability: 'generate' }, target: { kind: 'plot', plotRelPath: PLOT4 }, ask: '' },
      baseConfig
    );
    assert.match(plotCtx.messages[0].content, /4\. 用詞貼合故事的年代與世界觀/);
  });
});

// ---------------------------------------------------------------------------

/**
 * 架構三件「填過的才帶」：模板裡的佔位（`（待補充）`）不是內容，送進 prompt 等於
 * 告訴模型「世界觀：（待補充）」。檔案整個不在也只是少一條，**絕不拋**（第 1 條）。
 */
describe('裝配：架構檔案填過的才帶', () => {
  let fixture;
  let b;
  let bIds;

  before(async () => {
    fixture = copyFixture('builder-setting');
    fixture.write(
      '.novelwarden/world.md',
      '---\ngeneratedBy: novelwarden\n---\n\n# 世界觀\n\n## 規則與漏洞\n\n（待補充）\n\n## 階層與資源\n\n（待補充）\n\n## 深層危機\n\n（待補充）\n'
    );
    fixture.remove('.novelwarden/premise.md');
    const p = projectMod.NovelProject.open(fixture.dir);
    b = await builderMod.buildContext(
      p,
      { action: { stage: 'setting', capability: 'generate' }, target: { kind: 'setting', doc: 'world' }, ask: '' },
      baseConfig
    );
    bIds = ids(b);
  });

  after(() => cleanup(fixture.dir));

  test('只有佔位的世界觀不帶', () => {
    assert.ok(!bIds.has('setting:world'), [...bIds.keys()].join(','));
  });

  test('檔案不在的前提不帶，也不拋', () => {
    assert.ok(!bIds.has('setting:premise'), [...bIds.keys()].join(','));
  });

  test('填過的配置照帶', () => {
    assert.equal(bIds.get('setting:config').status, 'included');
  });

  test('佔位文字沒有進 prompt', () => {
    assert.ok(!b.messages[b.messages.length - 1].content.includes('（待補充）'));
  });
});

// ---------------------------------------------------------------------------

/**
 * 挑角色卡：**第一優先是本章細綱的 `characters[]`**（D13）。細綱裡明寫了這一章
 * 有誰，那比在作者那句話裡做子串匹配準得多——作者說「接著寫」，一個名字都沒提，
 * 該出場的人仍然要在。其後才是這一輪的要求、前兩章定稿過的細綱裡的出場人物與主角。
 */
describe('裝配：挑角色卡先看本章細綱的計劃出場（D13）', () => {
  let plain;
  let pById;
  let named;
  let nById;
  let plotStage;
  const charIds = (b) => b.items.filter((i) => i.kind === 'character').map((i) => i.id);

  before(async () => {
    // 第 2 章細綱計劃出場：林昭、沈氏。作者這一句一個名字都沒提。
    plain = await builderMod.buildContext(
      project,
      { action: WRITE, target: { kind: 'manuscript', plotRelPath: PLOT2 }, ask: '接著寫。' },
      baseConfig
    );
    pById = ids(plain);
    named = await builderMod.buildContext(
      project,
      { action: WRITE, target: { kind: 'manuscript', plotRelPath: PLOT2 }, ask: '李叔也要露一面。' },
      baseConfig
    );
    nById = ids(named);
    plotStage = ids(
      await builderMod.buildContext(
        project,
        { action: { stage: 'plot', capability: 'generate' }, target: { kind: 'plot', plotRelPath: PLOT2 }, ask: '重排一下。' },
        baseConfig
      )
    );
  });

  test('計劃出場的人都帶上了', () => {
    assert.ok(pById.get('character:林昭').status === 'included' && pById.get('character:沈氏').status === 'included');
  });

  test('原因寫明是本章細綱計劃出場', () => {
    assert.ok(pById.get('character:沈氏').note.includes('本章細綱計劃出場'), pById.get('character:沈氏').note);
  });

  // 主角也在計劃裡時，原因說的是計劃——那是更具體的依據。
  test('計劃出場優先於「主角始終注入」', () => {
    assert.ok(pById.get('character:林昭').note.includes('本章細綱計劃出場'), pById.get('character:林昭').note);
  });

  // 順序即填充順序：預算緊的時候，計劃出場的人先拿到預算。
  test('計劃出場的排在最前面', () => {
    assert.deepEqual(charIds(plain).slice(0, 2), ['character:林昭', 'character:沈氏']);
  });

  test('其餘的仍按原有判據補上（前一章出場）', () => {
    assert.ok(pById.get('character:李叔').note.includes('第 1 章出場'), pById.get('character:李叔').note);
  });

  test('要求裡點名的人排第二優先', () => {
    assert.ok(nById.get('character:李叔').note.includes('李叔'), nById.get('character:李叔').note);
    assert.deepEqual(charIds(named).slice(0, 3), ['character:林昭', 'character:沈氏', 'character:李叔']);
  });

  test('細綱層同樣按計劃出場挑', () => {
    assert.ok(plotStage.get('character:沈氏').note.includes('本章細綱計劃出場'), plotStage.get('character:沈氏').note);
  });
});

// ---------------------------------------------------------------------------

/**
 * 「落定細綱」的歷史封頂。
 *
 * `settle` 要沉澱的**就是那段對話**——按常規的 30% 裝，一段聊了十幾輪的討論會
 * 被由遠及近截掉開頭，而開頭往往正是定調子的地方。這是本次唯一的按能力
 * 調整裝配策略，所以單獨釘一條。
 */
describe('裝配：落定細綱時歷史保得住', () => {
  const many = [];
  for (let i = 1; i <= 40; i++) {
    many.push({
      id: `s${i}`,
      role: i % 2 === 1 ? 'user' : 'assistant',
      content: `第 ${i} 輪討論的內容。`.repeat(60),
      at: '2026-08-01T10:00:00Z',
    });
  }
  const cfg = { ...baseConfig, contextWindow: 40000 };
  let settle;
  let generate;
  const historyTokens = (b) =>
    b.items
      .filter((i) => i.kind === 'history' && (i.status === 'included' || i.status === 'degraded'))
      .reduce((s, i) => s + i.tokens, 0);

  before(async () => {
    const base = {
      target: { kind: 'plot', plotRelPath: PLOT3 },
      ask: '按剛才討論的落定。',
      history: many,
    };
    settle = await builderMod.buildContext(
      project,
      { ...base, action: { stage: 'plot', capability: 'settle' } },
      cfg
    );
    generate = await builderMod.buildContext(
      project,
      { ...base, action: { stage: 'plot', capability: 'generate' } },
      cfg
    );
  });

  test('落定時歷史優先順序抬到 P0', () => {
    assert.equal(ids(settle).get('history:s40').priority, 0);
  });

  test('寫細綱時歷史仍是 P1', () => {
    assert.equal(ids(generate).get('history:s40').priority, 1);
  });

  test('落定裝進去的歷史比寫細綱多', () => {
    assert.ok(
      historyTokens(settle) > historyTokens(generate),
      `settle=${historyTokens(settle)} generate=${historyTokens(generate)}`
    );
  });

  test('落定的歷史封頂是 60%', () => {
    assert.ok(
      historyTokens(settle) <= Math.floor(settle.budget * 0.6) + 5,
      `${historyTokens(settle)} / ${settle.budget}`
    );
  });

  test('寫細綱的歷史封頂仍是 30%', () => {
    assert.ok(
      historyTokens(generate) <= Math.floor(generate.budget * 0.3) + 5,
      `${historyTokens(generate)} / ${generate.budget}`
    );
  });

  // 不抬到 100%：大綱與本章細綱仍然要帶，不然模型會把討論裡沒提到的
  // 既有設定重新發明一遍。
  test('落定仍帶上本章細綱', () => {
    assert.notEqual(ids(settle).get(`plot:${PLOT3}`).status, 'dropped');
  });

  // 兩條路產出的是同一種產物，所以**輸出契約相同**；差別在系統提示裡的
  // 「以哪邊為準」——一條從作者的描述出發，一條從剛發生過的討論出發。
  // 說不清這一點，模型會把兩者混著編。
  test('兩條路的輸出契約相同（產物是同一種）', () => {
    const s = settle.messages[settle.messages.length - 1].content;
    const g = generate.messages[generate.messages.length - 1].content;
    assert.equal(s.slice(-400), g.slice(-400));
  });

  test('兩條路的系統提示不同', () => {
    assert.notEqual(settle.messages[0].content, generate.messages[0].content);
  });

  test('落定的系統提示說「以討論裡定下的為準」', () => {
    assert.ok(settle.messages[0].content.includes('討論'), settle.messages[0].content.slice(0, 600));
  });

  test('落定明說不要塞進被否掉的方案', () => {
    assert.ok(settle.messages[0].content.includes('否掉'), settle.messages[0].content.slice(0, 600));
  });

  test('寫細綱的系統提示說「按他說的產出」', () => {
    assert.ok(generate.messages[0].content.includes('按他說的產出'), generate.messages[0].content.slice(0, 600));
  });
});

// ---------------------------------------------------------------------------

describe('工程頁資料', () => {
  let tree;
  let plots;
  let characters;
  let lore;
  let lin2;
  let linStats;

  before(async () => {
    tree = await projectViewMod.buildProjectTree(project);
    plots = tree.plots;
    characters = flat(tree.characters);
    lore = flat(tree.lore);
    lin2 = characters.find((c) => c.label === '林昭');
    linStats = tree.castByCard[lin2.relPath];
  });

  test('已初始化', () => {
    assert.equal(tree.initialized, true);
  });

  test('章數與磁碟一致（第 5–10 章只有梗概，也是一章一行）', () => {
    assert.equal(plots.length, 10);
  });

  test('章節組是扁平列表', () => {
    assert.ok(plots.every((p) => typeof p.no === 'number' && !!p.relPath));
  });

  // 工程頁正序展示（第 1 章在上），與檔名順序一致。
  test('章按章號正序', () => {
    assert.equal(plots.map((p) => p.no).join(','), '1,2,3,4,5,6,7,8,9,10');
  });

  test('每一章都帶階段徽章', () => {
    assert.ok(plots.every((p) => !!p.stage), JSON.stringify(plots.map((p) => p.stage)));
  });

  // 流水線條三格：細綱 · 正文 · 定稿。
  test('每一章都帶三段進度', () => {
    assert.ok(
      plots.every(
        (p) => p.progress && ['plot', 'manuscript', 'summary'].every((k) => typeof p.progress[k] === 'number')
      ),
      JSON.stringify(plots.map((p) => p.progress))
    );
  });

  // 示例工程第 1–3 章細綱、正文都在，細綱定稿過且對得上正文 → 已完成。
  test('定稿過且細綱與正文對得上的章 → 已完成', () => {
    assert.ok(plots.slice(0, 3).every((p) => p.stage === 'done'), JSON.stringify(plots.map((p) => p.stage)));
  });

  test('第 4 章細綱排好了、還沒寫正文 → 待寫', () => {
    assert.equal(plots[3].stage, 'manuscript');
    assert.equal(plots[3].chapterPath, '');
  });

  test('總字數為各章之和', () => {
    assert.equal(tree.totalWords, plots.reduce((s, p) => s + p.wordCount, 0));
  });

  test('示例工程沒有待定稿的章', () => {
    assert.ok(tree.staleCount === 0 && plots.every((p) => !p.stale));
  });

  // 前端畫進度條要分母：staleCount + summarizedCount 必須等於有正文的章數。
  test('已定稿數與待定稿數互補', () => {
    const withText = plots.filter((p) => p.chapterPath !== '').length;
    assert.equal(
      tree.staleCount + tree.summarizedCount,
      withText,
      `${tree.staleCount} + ${tree.summarizedCount} ≠ ${withText}`
    );
  });

  test('寫過的章帶正文路徑', () => {
    assert.equal(plots[0].chapterPath, CH1);
  });

  // 細綱號 = 章號：一行同時是細綱與正文的兩面。
  test('同一行帶著同號的細綱', () => {
    assert.ok(plots[0].plotPath === PLOT1 && plots[0].plotExists, JSON.stringify(plots[0]));
  });

  test('目標字數取細綱的 targetWords', () => {
    assert.equal(plots[1].targetWords, 650);
  });

  // 主路徑指正文：點這一行開啟的是作者真正在讀的那份文字。
  test('主路徑指向正文', () => {
    assert.equal(plots[0].relPath, plots[0].chapterPath);
  });

  test('沒有上游改動（⟳）', () => {
    assert.ok(plots.every((p) => !p.upstreamStale), JSON.stringify(plots.map((p) => p.upstreamStale)));
  });

  // 架構五件與大綱都齊了、第 1–3 章寫完，第 4 章細綱已經排好 → 全書下一步是寫正文。
  test('全書階段是「寫正文」', () => {
    assert.equal(tree.bookStage, 'writing', tree.bookStage);
  });

  test('下一個該寫的是第 4 章', () => {
    assert.equal(tree.nextChapterNo, 4);
  });

  // 「故事架構」組：五件文件 + 情節大綱，順序即生成順序。
  test('故事架構組六行，順序是 配置 → 前提 → 角色圖譜 → 世界觀 → 設定清單 → 大綱', () => {
    assert.deepEqual(tree.architecture.map((r) => r.key), ['config', 'premise', 'characters', 'world', 'lore', 'outline']);
  });

  test('示例工程的故事架構 6/6 都填過', () => {
    assert.ok(tree.architecture.every((r) => r.filled), JSON.stringify(tree.architecture));
  });

  test('角色圖譜那一行報人數、指向角色目錄', () => {
    const row = tree.architecture.find((r) => r.key === 'characters');
    assert.ok(row.detail === '4 人' && row.relPath === '.novelwarden/characters', JSON.stringify(row));
  });

  test('設定清單那一行報條數、指向設定目錄', () => {
    const row = tree.architecture.find((r) => r.key === 'lore');
    assert.equal(row.label, '設定清單');
    assert.equal(row.relPath, '.novelwarden/lore');
    assert.match(row.detail, /^\d+ 條$/);
  });

  test('情節大綱那一行報覆蓋到第幾章', () => {
    const row = tree.architecture.find((r) => r.key === 'outline');
    assert.equal(row.detail, '覆蓋到第 10 章');
  });

  test('角色數與磁碟一致', () => {
    assert.equal(characters.length, 4);
  });

  test('角色副標題含標籤與別名', () => {
    assert.ok(lin2 && lin2.detail.includes('主角') && lin2.detail.includes('阿昭'), lin2 && lin2.detail);
  });

  test('設定數與磁碟一致', () => {
    assert.equal(lore.length, 2);
  });

  // 幾百條的名錄裡要一眼看出它是什麼：副標題是一句話簡介，沒寫 brief 就取正文第一句。
  test('設定副標題是一句話簡介（沒寫 brief 取正文第一句）', () => {
    const token = lore.find((l) => l.label === '崖字令牌');
    assert.ok(token && token.detail.startsWith('巴掌大的木牌或銅牌'), token && token.detail);
  });

  // 示例工程的三章定稿細綱都早於「設定」一節，名錄是空的、三章都等著補記。
  test('設定名錄：已建條目都有一行統計，還沒記過設定的定稿章計數', () => {
    assert.deepEqual(Object.keys(tree.loreByEntry).sort(), lore.map((l) => l.relPath).sort());
    assert.equal(tree.loreByEntry[lore[0].relPath].detail, '');
    assert.deepEqual(tree.loreUnfiled, []);
    assert.equal(tree.loreUnrecorded, 3);
  });

  test('給出各區的根目錄', () => {
    assert.ok(
      tree.chaptersRoot === 'chapters' && tree.charactersRoot === '.novelwarden/characters' && tree.loreRoot === '.novelwarden/lore',
      [tree.chaptersRoot, tree.charactersRoot, tree.loreRoot].join(' ')
    );
  });

  // 出場人物：已建卡的掛 castByCard（按 relPath 索引），未建卡的進 cast。
  // 只數定稿過的細綱：第 4 章是計劃，不算。
  test('已建卡角色帶出場統計', () => {
    assert.ok(!!linStats && linStats.plots.length > 0, JSON.stringify(linStats));
  });

  test('出場統計帶人類可讀描述', () => {
    assert.ok(
      linStats && linStats.detail.startsWith('第') && linStats.detail.endsWith('章'),
      linStats && linStats.detail
    );
  });

  // 示例工程的角色卡沒有 updatedThrough，因此全部出場章都算「待更新」。
  test('從未更新過的卡 updatedThrough 為 0', () => {
    assert.ok(linStats && linStats.updatedThrough === 0);
  });

  test('待更新章數等於出場章數', () => {
    assert.ok(
      linStats && linStats.pending === linStats.plots.length,
      `${linStats && linStats.pending} vs ${linStats && linStats.plots.length}`
    );
  });

  test('未建卡人物單列在 cast 裡', () => {
    assert.ok(tree.cast.length > 0, String(tree.cast.length));
  });

  test('cast 條目帶名字與描述', () => {
    assert.ok(tree.cast.every((c) => c.name && c.detail && Array.isArray(c.plots)));
  });

  test('cast 裡不含已建卡的角色', () => {
    assert.ok(
      !tree.cast.some((c) => characters.some((f) => f.label === c.name)),
      tree.cast.map((c) => c.name).join('、')
    );
  });

  test('全文大綱覆蓋章數來自 manifest', () => {
    assert.equal(tree.globalSummaryThrough, 3);
  });

  test('後設資料路徑都在 .novelwarden 下', () => {
    assert.ok(
      [tree.styleGuidePath, tree.globalSummaryPath].every((p) => p.startsWith('.novelwarden/')),
      [tree.styleGuidePath, tree.globalSummaryPath].join(' ')
    );
  });

  // 改動正文後，對應那一章必須立刻顯示為過期——這正是工程頁存在的意義之一。
  describe('改動正文後立刻顯示為過期', () => {
    let fixture;
    let dirty;
    let restored;
    const byNo = (list, no) => list.find((p) => p.no === no);

    before(async () => {
      fixture = copyFixture('builder-stale');
      const staleProject = projectMod.NovelProject.open(fixture.dir);
      const base = await projectViewMod.buildProjectTree(staleProject);
      // 細綱 sourceHash 的上游是 chapters/ 下那份正文（指紋鏈的最後一環）。
      const target = path.join(fixture.dir, byNo(base.plots, 3).chapterPath);
      const backup = fs.readFileSync(target, 'utf8');

      fs.writeFileSync(target, `${backup}\n\n臨時追加的一句話。\n`);
      staleProject.invalidate();
      dirty = await projectViewMod.buildProjectTree(staleProject);

      fs.writeFileSync(target, backup);
      staleProject.invalidate();
      restored = await projectViewMod.buildProjectTree(staleProject);
    });

    after(() => cleanup(fixture.dir));

    test('改正文後那一章標記為待定稿（過期）', () => {
      assert.equal(byNo(dirty.plots, 3).stale, true);
    });

    test('過期計數為 1', () => {
      assert.equal(dirty.staleCount, 1);
    });

    test('已定稿計數跟著減 1', () => {
      assert.equal(dirty.summarizedCount, 2);
    });

    test('過期的章仍指向它那份定稿過的細綱（可點開對照）', () => {
      assert.equal(byNo(dirty.plots, 3).plotPath, PLOT3);
    });

    // 寫完的判據是「細綱定稿過且 sourceHash 對得上正文」：正文改過，這一章就不再算已完成。
    test('過期的章不再算已完成', () => {
      assert.notEqual(byNo(dirty.plots, 3).stage, 'done', byNo(dirty.plots, 3).stage);
    });

    test('其他章不受影響', () => {
      assert.ok(!byNo(dirty.plots, 1).stale && !byNo(dirty.plots, 2).stale);
    });

    test('還原後不再過期', () => {
      assert.equal(restored.staleCount, 0);
    });
  });
});

// ---------------------------------------------------------------------------

describe('出場人物索引', () => {
  // 示例工程刻意混了兩種定稿過的細綱：第 3 章帶 frontmatter.cast，第 1、2 章沒有
  // （手寫的、或老工程裡的單章摘要直接當細綱讀進來就是這樣）。索引必須同時吃下兩種，
  // 否則老章節的人會在角色頁上憑空消失。第 4 章是計劃，不進統計。
  let s3;
  let s1;
  let index;
  let lin;
  let linCard;

  before(async () => {
    s3 = await project.getPlot(3);
    s1 = await project.getPlot(1);
    index = await castMod.buildCastIndex(project);
    lin = index.known.find((m) => m.card && m.card.name === '林昭');
    linCard = (await project.listCharacters()).find((c) => c.name === '林昭');
  });

  test('frontmatter 帶 cast 的細綱讀到結構化出場', () => {
    assert.equal(s3.cast.length, 2, JSON.stringify(s3.cast));
  });

  test('cast 帶別名', () => {
    assert.ok(s3.cast.find((c) => c.name === '年輕守衛').aliases.includes('那個年輕人'), JSON.stringify(s3.cast));
  });

  test('沒有 cast 的細綱從「出場人物」一節反解', () => {
    assert.equal(s1.cast.length, 3, JSON.stringify(s1.cast));
  });

  test('反解出的名字正確', () => {
    assert.equal(s1.cast.map((c) => c.name).join('、'), '林昭、李叔、年輕守衛');
  });

  test('統計到 3 份定稿過的細綱（第 4 章的計劃不算）', () => {
    assert.equal(index.summaryCount, 3);
  });

  test('林昭被識別為已建卡', () => {
    assert.ok(!!lin);
  });

  test('林昭有出場章', () => {
    assert.ok(lin && lin.plots.length > 0, lin && lin.plots.join(','));
  });

  test('出場章升序去重', () => {
    assert.ok(lin && lin.plots.every((o, i, a) => i === 0 || o > a[i - 1]), lin && lin.plots.join(','));
  });

  // 別名匹配：某一章細綱裡寫「阿昭」也該記到林昭頭上，不該多出一個人。
  test('未建卡列表裡沒有已知別名', () => {
    assert.ok(!index.unknown.some((m) => m.name === '阿昭'), index.unknown.map((m) => m.name).join('、'));
  });

  // 定稿過的細綱裡出現、沒有角色卡的人（示例工程裡是「客棧掌櫃」）。
  test('未建卡人物被單列', () => {
    assert.ok(index.unknown.some((m) => m.name.includes('掌櫃')), index.unknown.map((m) => m.name).join('、'));
  });

  test('未建卡按出場章數降序', () => {
    assert.ok(index.unknown.every((m, i, a) => i === 0 || a[i - 1].plots.length >= m.plots.length));
  });

  test('未建卡的人都帶出場章', () => {
    assert.ok(index.unknown.every((m) => m.plots.length > 0));
  });

  test('已建卡與未建卡不重疊', () => {
    assert.ok(!index.unknown.some((u) => index.known.some((k) => k.card && k.card.name === u.name)));
  });

  test('示例工程沒有名字衝突', () => {
    assert.equal(index.conflicts.length, 0, index.conflicts.map((c) => c.name).join('、'));
  });

  // appearancesOf 是「更新角色卡」取章的入口，必須與索引一致。
  test('appearancesOf 與索引一致', () => {
    assert.equal(castMod.appearancesOf(index, linCard).join(','), lin.plots.join(','));
  });

  test('查不到的角色返回空陣列', () => {
    const missing = {
      slug: '不存在', name: '不存在', aliases: [], tags: [], appearsIn: [],
      relPath: 'x', body: '', sections: {},
    };
    assert.equal(castMod.appearancesOf(index, missing).length, 0);
  });

  test('describePlots 短列表全列', () => {
    assert.equal(castMod.describePlots([1, 2, 3]), '第 1、2、3 章');
  });

  test('describePlots 長列表摺疊', () => {
    assert.equal(castMod.describePlots([1, 2, 3, 4, 5, 6, 7, 8]), '第 1、2、3、4、5、6 章等 8 章');
  });

  test('describePlots 空列表有說法', () => {
    assert.equal(castMod.describePlots([]), '未在同步過的章裡出現');
  });
});

// ---------------------------------------------------------------------------

/**
 * D13 的另一半：沒定稿的細綱裡「出場人物」一節是**計劃**出場，**只給裝配器挑角色卡用**。
 * 出場統計只認定稿過的細綱（第 14 條）——計劃與實際混在一起，角色頁上會冒出「第 4 章出場」
 * 而那一章其實還沒寫，或者計劃裡有、寫的時候被刪掉的人。
 */
describe('細綱的計劃出場：裝配時認別名，但不進出場統計（D13）', () => {
  let fixture;
  let p;
  let built4;
  let b4;
  let index;

  before(async () => {
    fixture = copyFixture('builder-planned');
    p = projectMod.NovelProject.open(fixture.dir);
    // 第 4 章只排了細綱（計劃）：把計劃出場改成別名「阿昭」，外加一個還沒有卡的人。
    const plot4 = fixture.read(PLOT4);
    fixture.write(PLOT4, plot4.replace(/(## 出場人物\r?\n\r?\n)林昭、年輕守衛、李叔/, '$1阿昭、陌生人甲'));
    assert.notEqual(fixture.read(PLOT4), plot4, '示例工程第 4 章的「出場人物」一節變了，這裡要跟著改');
    p.invalidate();
    built4 = await builderMod.buildContext(
      p,
      { action: WRITE, target: { kind: 'manuscript', plotRelPath: PLOT4 }, ask: '寫。' },
      baseConfig
    );
    b4 = ids(built4);
    index = await castMod.buildCastIndex(p);
  });

  after(() => cleanup(fixture.dir));

  test('計劃出場寫別名也認得到那張卡', () => {
    assert.ok(b4.get('character:林昭').note.includes('本章細綱計劃出場'), b4.get('character:林昭').note);
  });

  // 沒有卡的人不憑空造一條空卡進 prompt。
  test('沒有卡的人不產生角色條目', () => {
    assert.ok(![...b4.keys()].some((k) => k.includes('陌生人甲')), [...b4.keys()].join(','));
  });

  test('沒有卡的計劃出場者不進「未建卡」列表', () => {
    assert.ok(!index.unknown.some((m) => m.name === '陌生人甲'), index.unknown.map((m) => m.name).join('、'));
  });

  test('計劃出場不算進已建卡角色的出場章', () => {
    const lin = index.known.find((m) => m.card && m.card.name === '林昭');
    assert.ok(!lin.plots.includes(4), lin.plots.join(','));
  });
});

// ---------------------------------------------------------------------------

/**
 * 二期加的幾層與移植過來的契約（AI-Novel-Writer 的配置 / 前提 / 角色圖譜 / 世界觀 /
 * 情節大綱 / 細綱批次）。示例工程：三幕、30 章 × 400 字，大綱三段區間，第 1–4 章細綱都在
 * （第 4 章是計劃）。
 *
 * | 用例組 | 釘的是什麼 |
 * |---|---|
 * | 結構指導 | 大綱層 P0 force 帶按總章數算好的章號區間，並點明本批落在哪幾段 |
 * | 角色圖譜一覽 | 架構後幾件、大綱、細綱都知道「書裡有誰、彼此什麼關係」，不帶完整角色卡 |
 * | 大綱續寫 | 契約寫明本次只寫哪幾章、前面的不許重寫 |
 * | 細綱批次 | 沒有「本章」：plotSelf / plotPrev 不出場，前序細綱一覽全包，最後幾章帶看點 |
 * | 拆半後的後一半 | 看得見前一半剛排好、還沒落盤的那幾章 |
 * | 鏈裡的後幾步 | 角色詳情帶凍結清單；緊湊重建寫明上次哪裡不合格 |
 */
describe('裝配：二期的新層與移植的契約', () => {
  const build = (request) => builderMod.buildContext(project, request, baseConfig);
  const lastOf = (b) => b.messages[b.messages.length - 1].content;
  const GEN = (stage) => ({ stage, capability: 'generate' });
  let outline21;
  let batch;
  let bIds;
  let split;
  let details;
  let compact;
  let config;
  let world;

  before(async () => {
    outline21 = await build({ action: GEN('outline'), target: { kind: 'outline' }, ask: '', range: { from: 11, to: 25 } });
    batch = await build({
      action: GEN('plot'),
      target: { kind: 'plot', plotRelPath: PLOT4 },
      ask: '',
      range: { from: 4, to: 8 },
    });
    bIds = ids(batch);
    // 排第 5–8 章那一批拆了半：前一半（第 5、6 章）剛排好、還沒落盤，現在排後一半。
    split = await build({
      action: GEN('plot'),
      target: { kind: 'plot', plotRelPath: '.novelwarden/summaries/007.md' },
      ask: '',
      range: { from: 7, to: 8 },
      draftPlots: [
        { no: 5, title: '第二塊令牌', keyEvents: '- 林昭找到守衛的母親。', highlights: '- 她說令牌共有五塊。' },
        { no: 6, title: '雨夜', keyEvents: '- 持牌人墜井。\n- 有人在井口撿到半截簪子。', highlights: '- 井邊有沈氏的簪子。\n- 簪子是誰扔下的。' },
      ],
    });
    details = await build({
      action: GEN('setting'),
      target: { kind: 'setting', doc: 'characters' },
      ask: '',
      step: { kind: 'rosterDetails', manifest: '- 林昭（主角，男）：揹著舊案入宗', names: ['林昭'], done: '' },
    });
    compact = await build({
      action: GEN('plot'),
      target: { kind: 'plot', plotRelPath: PLOT4 },
      ask: '',
      range: { from: 4, to: 4 },
      step: { kind: 'blueprintCompact', diagnostic: '「關鍵事件」那一節缺了或是空的' },
    });
    config = await build({
      action: GEN('setting'),
      target: { kind: 'setting', doc: 'config' },
      ask: '一個從火裡活下來的人回到起火的地方。',
      setup: { totalChapters: 100, wordsPerChapter: 3000 },
    });
    world = await build({ action: GEN('setting'), target: { kind: 'setting', doc: 'world' }, ask: '' });
  });

  // ------------------------------------------------------------ 結構指導

  test('★ 大綱層帶故事結構指導（P0 force），按 30 章算好區間', () => {
    const item = ids(outline21).get('structure');
    assert.ok(item && item.status === 'included' && item.priority === 0, JSON.stringify(item));
    assert.ok(item.text.includes('第一幕 · 建置（第 1–6 章）') && item.text.includes('第三幕 · 高潮與結局（第 24–30 章）'), item.text);
    assert.ok(lastOf(outline21).includes('# 故事結構指導'));
  });

  test('結構指導點明本批落在哪幾段', () => {
    assert.ok(ids(outline21).get('structure').text.includes('本次只寫第 11–25 章，它們落在：第二幕'), ids(outline21).get('structure').text);
  });

  test('續寫大綱：契約寫明本次範圍，前面的不許重寫', () => {
    const user = lastOf(outline21);
    assert.ok(user.includes('本次必須寫第 11–25 章的情節大綱（全書共 30 章）'), user.slice(-2000));
    assert.ok(user.includes('第 1–10 章的大綱已在上面的「情節大綱」中給出（較早的只列了第一行）：不得重複、改寫或複述'), user.slice(-2000));
    assert.ok(user.includes('第 26 章以後本次不寫'), user.slice(-2000));
  });

  test('沒寫總章數時不帶結構指導，並在明細裡說為什麼', async () => {
    const fixture = copyFixture('builder-nototal');
    try {
      const cfg = fs.readFileSync(path.join(fixture.dir, '.novelwarden/config.md'), 'utf8').replace(/^totalChapters: .*\r?\n/m, '');
      fixture.write('.novelwarden/config.md', cfg);
      const p = projectMod.NovelProject.open(fixture.dir);
      const b = await builderMod.buildContext(p, { action: GEN('outline'), target: { kind: 'outline' }, ask: '' }, baseConfig);
      const item = ids(b).get('structure');
      assert.ok(item.status === 'dropped' && /總章數/.test(item.note), JSON.stringify(item));
    } finally {
      cleanup(fixture.dir);
    }
  });

  // ------------------------------------------------------------ 角色圖譜一覽

  test('世界觀那一件帶角色圖譜一覽：一人一段，寫明截短', () => {
    const roster = ids(world).get('roster');
    assert.ok(roster && roster.status === 'included' && roster.priority === 0, JSON.stringify(roster));
    assert.ok(roster.text.startsWith('【角色圖譜】') && roster.text.includes('- 林昭') && roster.note, roster.text);
    assert.ok(lastOf(world).includes('# 故事架構'));
  });

  test('世界觀契約：三節對上 world.md，自帶衝突點', () => {
    const user = lastOf(world);
    assert.ok(['## 規則與漏洞', '## 階層與資源', '## 深層危機', '自帶衝突點'].every((k) => user.includes(k)), user.slice(-1400));
  });

  // ------------------------------------------------------------ 細綱批次

  test('★ 批次沒有「本章」：不帶區間第一章的細綱，也不帶上文細綱', () => {
    assert.ok(!bIds.has(`plot:${PLOT4}`) && ![PLOT1, PLOT2, PLOT3].some((p) => bIds.has(`plot:${p}`)), [...bIds.keys()].join(','));
  });

  test('★ 前序細綱一覽全包：最後幾章帶看點', () => {
    const list = bIds.get('plotList');
    assert.ok(list && list.status === 'included', JSON.stringify(list));
    const lines = list.text.split('\n');
    assert.equal(lines.length, 3);
    assert.ok(lines.every((l) => l.includes('｜看點：')), list.text);
    assert.ok(lines[2].includes('第3章 夜訪：') && lines[2].includes('我娘手上有一塊一模一樣的牌子'), lines[2]);
    // 定稿過的關鍵事件是一條一行的列表，一章一行時用「；」接起來。
    assert.ok(lines[0].startsWith('第1章 楔子：林昭進入青崖鎮，自稱從「江那邊」來。；林昭以一塊殘缺「崖」字的舊牌子代替過所。'), lines[0]);
    assert.ok(lastOf(batch).includes('# 前序細綱一覽（已生成的目錄進度）'));
  });

  // 前面已經拆過的章前序細綱一覽帶了，大綱只帶這一次要拆的（2026-10-22）：同一份細綱不帶兩遍。
  test('批次只帶大綱裡這一批的條目：前面拆過的、之後的都不帶', () => {
    const item = bIds.get('outlineDoc');
    assert.ok(item && item.text.includes('## 第4章：空匣') && item.text.includes('## 第8章：鐵匠鋪'), [...bIds.keys()].join(','));
    assert.ok(!item.text.includes('第1章') && !item.text.includes('第3章') && !item.text.includes('第9章'), item.text);
    assert.match(item.note, /只帶這一次要拆的：已經拆過的章看前序細綱一覽，第 8 章以後的不帶/);
  });

  test('批次契約：覆蓋第 4–8 章、容量按每章字數', () => {
    const user = lastOf(batch);
    assert.ok(user.includes('為接下來的第 4–8 章生成極其嚴密的「保姆級執行目錄細綱」'), user.slice(-3000));
    assert.ok(user.includes('寫第 4–8 章的細綱：一章一份，按章號順序'), user.slice(-3000));
    assert.ok(user.includes('每章正文目標約 400 字，可接受範圍 320–480 字'), user.slice(-3000));
    // 第 4 章起已經過了黃金三章。
    assert.ok(!user.includes('黃金三章法則') && user.includes('小高潮迴圈'), user.slice(-3000));
  });

  test('開篇那一批帶黃金三章法則', async () => {
    const first = await build({ action: GEN('plot'), target: { kind: 'plot', plotRelPath: PLOT1 }, ask: '', range: { from: 1, to: 5 } });
    assert.ok(lastOf(first).includes('黃金三章法則') && lastOf(first).includes('這是全書開篇'), lastOf(first).slice(-3000));
  });

  test('拆半後的後一半看得見前一半剛排好、還沒落盤的那幾章', () => {
    const list = ids(split).get('plotList').text;
    assert.ok(list.includes('第5章 第二塊令牌（剛排好，還沒寫入檔案）') && list.includes('第6章 雨夜'), list);
    // 最後三章（第 4、5、6 章）帶看點：下一章要緊接著第 6 章往下排。
    // 關鍵事件、看點都是一條一行的列表：一章一行時條與條之間用「；」接，不留「- 」。
    assert.ok(list.includes('第6章 雨夜（剛排好，還沒寫入檔案）：持牌人墜井。；有人在井口撿到半截簪子。｜看點：井邊有沈氏的簪子。；簪子是誰扔下的。'), list);
    assert.ok(!list.includes('- '), list);
  });

  // ------------------------------------------------------------ 鏈裡的後幾步

  test('角色詳情那一步帶凍結清單與這一批的人，不寫關係', () => {
    const user = lastOf(details);
    assert.ok(user.includes('【凍結身份與關係清單】\n- 林昭（主角，男）：揹著舊案入宗') && user.includes('【本批要寫詳情的人】\n林昭'), user.slice(-1500));
    // 2026-10-25 起按小標題寫，不寫 JSON。
    assert.ok(user.includes('【角色詳情格式】') && user.includes('不寫 JSON') && !user.includes('{"entries"'), user.slice(-1500));
    assert.ok(user.includes('不寫人物關係——關係由凍結清單唯一生成'), user.slice(-800));
  });

  test('緊湊重建寫明上次哪裡不合格，只要這一章', () => {
    const user = lastOf(compact);
    assert.ok(user.includes('【上次輸出不合格】「關鍵事件」那一節缺了或是空的') && user.includes('只寫第 4 章這一章'), user.slice(-800));
  });

  // ------------------------------------------------------------ 小說配置

  test('一句話彈窗發起的配置：已經寫了正文就照正文整理，那句話是補充要求；規模按彈窗給的算，作者已有配置不許改寫', () => {
    const user = lastOf(config);
    assert.ok(user.includes('# 已寫正文') && user.includes('從已寫正文整理'), user.slice(0, 4000));
    assert.ok(user.includes('# 我的要求（最高優先順序）') && user.includes('一個從火裡活下來的人'), user.slice(-3500));
    assert.ok(!user.includes('# 我的腦洞'), user.slice(-3500));
    assert.ok(user.includes('計劃總章數：100 章') && user.includes('全書總字數約：100 × 3000 = 300000 字'), user.slice(0, 4000));
    assert.ok(user.includes('【作者已有配置】'), user.slice(-3500));
    // 規模是作者定的：不讓模型寫（2026-10-25 起按格式寫，原來是「totalChapters 若輸出必須嚴格等於 100」）。
    assert.ok(user.includes('【小說配置格式】') && !user.includes('## 規模'), user.slice(-1500));
    assert.ok(config.messages[0].content.includes('擅長從簡短靈感中提煉完整、一致且可執行的小說配置'), config.messages[0].content.slice(0, 200));
  });
});
