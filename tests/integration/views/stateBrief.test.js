/**
 * `views/stateBrief.ts`：MCP 貼在工具結果末尾的那段「# 當前工程」。
 *
 * 這一段是 AGENTS 第 20 條在外部 agent 上的落點：**介面永遠只推薦一個下一步，
 * 且由狀態機算出來**。所以最要緊的斷言不是「文案好不好看」，而是
 * **注入的 label / hint 與狀態機的輸出一字不差**——單章看 `deriveNextStep`，
 * 全書看 `deriveBookStage` / `deriveBookNextStep`。兩處各判各的，介面上就會出現
 * 「徽章說待寫細綱，agent 讓你寫正文」。
 *
 * 一本書從零走一遍：全新工程（推架構第一件）→ 架構齊了（推大綱）→ 大綱有了（推拆細綱）
 * → 選中一章，細綱 / 正文 / 定稿逐檔往前 → 這一章做完，轉去報全書的下一步 → 全書寫完，
 * 照實說沒有下一步。另起一個老工程（99 章成品、從沒用過本工具）驗 D11：它被推回架構，
 * 但選中的章按章號認、不被倒回去要求補細綱。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');
const { outlineOf, writeOutline } = require('../../helpers/outline');

let bundle;
let t;
let project;
let ws;

const PLOT1 = '.novelwarden/summaries/001-北行.md';
const CH1 = 'chapters/001-北行.md';

const brief = (target) => bundle.stateBrief.buildStateBrief(project, target);

/** 直接問單章狀態機：注入的那句必須與它一字不差。 */
async function nextStepOf(relPath, p = project) {
  const view = await bundle.views.buildPlotPipelineView(p, relPath);
  return bundle.pipeline.deriveNextStep(view.stage, bundle.viewsPipeline.factsOf(view));
}

/** 直接問全書狀態機（與創作頁主按鈕吃同一份事實）。 */
async function bookStepOf(p = project) {
  const facts = await bundle.viewsPipeline.buildBookFacts(p);
  const stage = bundle.pipeline.deriveBookStage(facts);
  return { stage, step: bundle.pipeline.deriveBookNextStep(stage, facts) };
}

/** 一份細綱（七節）。`events`（關鍵事件）為空時這一章就還沒排過。 */
function writePlot1(events) {
  return ws.writePlot({
    no: 1,
    title: '北行',
    upstreamHash: '',
    done: false,
    sections: { ...bundle.plotFile.emptyPlotSections(), 梗概: '林昭北上', 出场人物: '林昭', 关键事件: events },
  });
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    stateBrief: './src/core/views/stateBrief.ts',
    pipeline: './src/core/model/pipeline.ts',
    views: './src/core/views/projectView.ts',
    viewsPipeline: './src/core/views/pipeline.ts',
    serialize: './src/core/controller/serialize.ts',
    plotFile: './src/core/model/plotFile.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  t = await makeTempProject(bundle.project, { prefix: 'agentstate', title: '青雲志' });
  project = t.project;
  ws = new bundle.ws.Workspace(project);
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('全新工程 · 架構五件一件都沒有', () => {
  let text;
  let expected;

  before(async () => {
    text = await brief();
    ({ step: expected } = await bookStepOf());
  });

  test('報出工程名', () => {
    assert.ok(text.includes('《青雲志》'), text);
  });

  test('說清已寫幾章', () => {
    assert.ok(text.includes('已寫 0 章'), text);
  });

  test('沒選中章時照實說', () => {
    assert.ok(text.includes('當前目標：還沒選定某一章'), text);
  });

  // 全書那一層：架構五件按 配置 → 前提 → 角色圖譜 → 世界觀 → 設定清單 的順序，缺哪件推哪件。
  test('下一步是生成小說配置', () => {
    assert.ok(text.includes('生成小說配置'), text);
  });

  test('下一步的 label 與全書狀態機一字不差', () => {
    assert.ok(text.includes(expected.label), `${text}\n期望含 ${expected.label}`);
  });

  test('hint 也一字不差', () => {
    assert.ok(text.includes(expected.hint), `${text}\n期望含 ${expected.hint}`);
  });

  test('把「不要另做判斷」寫給模型', () => {
    assert.ok(text.includes('不要另做判斷'), text);
  });

  // 作者還在架構那一層時，當前目標說「故事架構」，下一步仍然來自全書。
  test('target 在架構層時說「故事架構」', async () => {
    const s = await brief({ kind: 'setting', doc: 'config' });
    assert.ok(s.includes('當前目標：故事架構'), s);
    assert.ok(s.includes(expected.label), s);
  });
});

describe('架構齊了、還沒有大綱', () => {
  let text;
  let expected;
  let beforeLore;

  before(async () => {
    t.write(
      '.novelwarden/config.md',
      '---\ngenre: 玄幻\ntotalChapters: 30\nwordsPerChapter: 400\n---\n\n# 小說配置\n\n## 核心梗概\n\n少年林昭北上入宗。\n'
    );
    t.write('.novelwarden/premise.md', '# 故事前提\n\n## 核心衝突鏈\n\n入宗 → 被疑 → 自證。\n');
    t.write('.novelwarden/world.md', '# 世界觀\n\n## 規則與漏洞\n\n宗門認令牌不認人。\n');
    t.write('.novelwarden/characters/林昭.md', '---\nname: 林昭\ntags: [主角]\n---\n\n# 林昭\n\n## 身份\n\n北地少年。\n');
    project.invalidate();
    beforeLore = await brief();
    // 第五件設定清單：一條條目就算填過。
    t.write('.novelwarden/lore/宗門/青雲宗.md', '---\ntitle: 青雲宗\nkeywords: [青雲宗]\n---\n\n# 青雲宗\n');
    project.invalidate();
    text = await brief();
    ({ step: expected } = await bookStepOf());
  });

  test('前四件齊了、還沒有設定條目：agent 聽到的下一步是生成設定清單', () => {
    assert.ok(beforeLore.includes('下一步（由狀態機算出，不要另做判斷）：生成設定清單'), beforeLore);
  });

  test('報出計劃章數（config.md 的總章數）', () => {
    assert.ok(text.includes('（計劃 30 章）'), text);
  });

  // `initialize()` 撒的大綱模板只有標題與說明，不算有內容。
  test('下一步是生成情節大綱，帶章號區間', () => {
    assert.ok(text.includes('生成情節大綱（第 1–20 章）'), text);
  });

  test('與全書狀態機一字不差', () => {
    assert.ok(text.includes(expected.label) && text.includes(expected.hint), `${text}\n期望含 ${expected.label}`);
  });
});

describe('大綱有了、還沒有細綱', () => {
  let text;
  let expected;

  before(async () => {
    writeOutline(t, outlineOf(20, { title: '大綱', text: { 1: '少年入宗，一路向北。' } }));
    project.invalidate();
    text = await brief();
    ({ step: expected } = await bookStepOf());
  });

  test('下一步是拆細綱，區間從第 1 章起', () => {
    assert.ok(text.includes('拆細綱（第 1–5 章）'), text);
  });

  test('與全書狀態機一字不差', () => {
    assert.ok(text.includes(expected.label) && text.includes(expected.hint), `${text}\n期望含 ${expected.label}`);
  });
});

describe('選中一章 · 注入的下一步與單章狀態機一字不差', () => {
  let text;
  let expected;

  before(async () => {
    await writePlot1('');
    project.invalidate();
    expected = await nextStepOf(PLOT1);
    text = await brief({ kind: 'plot', plotRelPath: PLOT1 });
  });

  // 細綱號 = 章號：說「第 1 章」，與工程頁那一行、創作頁的麵包屑是同一個說法。
  test('報出當前目標那一章', () => {
    assert.ok(text.includes('當前目標：第 1 章《北行》'), text);
  });

  test('報出目標的路徑', () => {
    assert.ok(text.includes(PLOT1), text);
  });

  // 「關鍵事件」空著就不算排過——只寫了梗概的骨架，狀態機如實說待寫細綱。
  test('狀態用的是狀態機的說法', () => {
    assert.ok(text.includes('狀態：待寫細綱'), text);
  });

  // 第 20 條的硬斷言：兩處各判各的，介面上就會出現「徽章說 A、agent 讓你做 B」。
  test('下一步的 label 與 deriveNextStep 一字不差', () => {
    assert.ok(text.includes(expected.label), `${text}\n期望含「${expected.label}」`);
  });

  test('下一步的 hint 也一字不差', () => {
    assert.ok(text.includes(expected.hint), `${text}\n期望含「${expected.hint}」`);
  });

  test('細綱排完之後下一步跟著變：待寫正文', async () => {
    await writePlot1('出城、遇雪、投宿；收在客棧門口。');
    project.invalidate();
    const after = await brief({ kind: 'plot', plotRelPath: PLOT1 });
    const now = await nextStepOf(PLOT1);
    assert.ok(after.includes('狀態：待寫正文'), after);
    assert.ok(after.includes(now.label) && now.label === '寫第 1 章', `${after}\n期望含「${now.label}」`);
  });

  // 全書那一層走到「在寫」時不自己給按鈕，轉去問下一個該寫的那一章——
  // 沒選中章時 agent 聽到的就是那一章的下一步。
  test('沒選中章時，全書轉去報下一個該寫的章', async () => {
    const s = await brief();
    const { stage } = await bookStepOf();
    assert.equal(stage, 'writing');
    assert.ok(s.includes('寫第 1 章'), s);
  });

  test('寫了一部分還沒寫夠：接著寫', async () => {
    t.write(CH1, `# 北行\n\n${'字'.repeat(100)}\n`);
    project.invalidate();
    const s = await brief({ kind: 'plot', plotRelPath: PLOT1 });
    const now = await nextStepOf(PLOT1);
    assert.equal(now.label, '接著寫');
    assert.ok(s.includes('狀態：待寫正文') && s.includes(now.label) && s.includes(now.hint), `${s}\n期望含「${now.hint}」`);
  });

  // 正文那一章的路徑也認得到同一章（細綱號 = 章號）。
  test('給章節路徑也認到同一章', async () => {
    const s = await brief({ kind: 'manuscript', plotRelPath: CH1 });
    assert.ok(s.includes('當前目標：第 1 章《北行》'), s);
  });

  test('寫夠了：待定稿，下一步是定稿第 1 章', async () => {
    t.write(CH1, `# 北行\n\n${'字'.repeat(400)}\n`);
    project.invalidate();
    const s = await brief({ kind: 'plot', plotRelPath: PLOT1 });
    const now = await nextStepOf(PLOT1);
    assert.ok(s.includes('狀態：待同步'), s);
    assert.ok(s.includes(now.label) && now.label === '同步第 1 章', s);
  });
});

/**
 * ★ 單章做完之後**不沉默**：從前 `done` 之後沒有下一步，agent 只會說「這一章做完了」，
 * 作者得自己去找下一章。現在與創作頁主按鈕同一條路（controller/chat.ts 的 `pushPipeline`）：
 * 那一章做完了就轉去問全書，落到下一個該做的事上。
 */
describe('這一章定稿之後轉去報全書的下一步', () => {
  let text;
  let expected;

  before(async () => {
    // 定稿：細綱照正文反向更新，記下正文的 contentHash。
    project.invalidate();
    const chapter = (await project.listChapters()).find((c) => c.order === 1);
    await ws.finalizePlot(
      chapter,
      { ...bundle.plotFile.emptyPlotSections(), 梗概: '林昭出城北上。', 出场人物: '林昭', 关键事件: '出城、遇雪、投宿。' },
      [{ name: '林昭', aliases: [] }]
    );
    project.invalidate();
    text = await brief({ kind: 'plot', plotRelPath: PLOT1 });
    ({ step: expected } = await bookStepOf());
  });

  test('這一章的狀態是已完成', () => {
    assert.ok(text.includes('狀態：已完成'), text);
  });

  test('說清這一章做完了', () => {
    assert.ok(text.includes('這一章都做完了'), text);
  });

  // 第 2 章還沒有細綱：全書下一步是從第 2 章起拆細綱。
  test('轉去報的是全書的下一步（拆第 2 章起的細綱）', () => {
    assert.ok(text.includes('拆細綱（第 2–6 章）'), text);
  });

  test('與全書狀態機一字不差', () => {
    assert.ok(text.includes(expected.label) && text.includes(expected.hint), `${text}\n期望含 ${expected.label}`);
  });

  test('已寫章數跟著變', () => {
    assert.ok(text.includes('已寫 1 章'), text);
  });

  // 第 20 條 (c)：做完了就不給下一步。造一個假的出來，agent 會自作主張挑一章開始燒錢。
  test('全書寫完了就照實說，不造一個下一步', async () => {
    const saved = t.read('.novelwarden/config.md');
    t.write('.novelwarden/config.md', saved.replace('totalChapters: 30', 'totalChapters: 1'));
    project.invalidate();
    const s = await brief({ kind: 'plot', plotRelPath: PLOT1 });
    t.write('.novelwarden/config.md', saved);
    project.invalidate();
    assert.ok(s.includes('全書都寫完了'), s);
    assert.ok(!s.includes('由狀態機算出'), s);
  });
});

/**
 * 主按鈕點下「拆細綱（第 2–6 章）」之後，會話的 target 是第 2 章細綱**應該**在的位置
 * （檔案還不存在，見 controller/chat.ts 的 `bookNextStep`）。這時創作頁的流水線按
 * `buildPlotPipelineView` 給一份空殼，主按鈕說「寫第 2 章細綱」；狀態注入也必須說同一句。
 */
describe('target 是還沒落盤的下一章細綱', () => {
  const pending = '.novelwarden/summaries/002.md';

  // 索引裡只有「有檔案」的章號；那一號既無細綱也無正文時，findPipeline 要自己補一份
  // 空殼，否則會報成「還沒選定某一章」+ 全書的「拆細綱」，與主按鈕分叉（第 20 條）。
  test(
    '與創作頁主按鈕一致（寫第 2 章細綱）',
    async () => {
      const s = await brief({ kind: 'plot', plotRelPath: pending });
      const now = await nextStepOf(pending);
      assert.ok(s.includes('當前目標：第 2 章'), s);
      assert.ok(s.includes(now.label), `${s}\n期望含「${now.label}」`);
    }
  );
});

describe('⟳ 上游變更提醒', () => {
  // 細綱的上游是它自己的梗概（情節大綱裡這一章那一條，docs/design/plans/2026-10-22-outline-from-plots.md）：
  // 記過的指紋對不上此刻梗概的指紋才標髒。
  async function stalePlot(no) {
    // 細綱記了 upstreamHash 才會標髒（手寫的產物永不標髒）；'old-hash' 對不上梗概「x」的指紋。
    await ws.writePlot({
      no,
      title: `第${no}章`,
      upstreamHash: 'old-hash',
      done: false,
      sections: { ...bundle.plotFile.emptyPlotSections(), 梗概: 'x', 关键事件: 'y' },
    });
  }

  test('改過上游之後點名列出受影響的章', async () => {
    for (const no of [201, 202, 203]) {
      await stalePlot(no);
    }
    project.invalidate();
    const text = await brief();
    assert.ok(text.includes('第 201 章、第 202 章、第 203 章'), text);
    assert.ok(text.includes('⟳'), text);
  });

  test('超過 5 章時寫「等 N 章」，不把全書列一遍', async () => {
    for (let no = 220; no <= 230; no++) {
      await stalePlot(no);
    }
    project.invalidate();
    const text = await brief();
    assert.ok(text.includes('等 14 章'), text);
  });

  test('提醒那一行不會長到把狀態擠掉', async () => {
    const text = await brief();
    const line = text.split('\n').find((l) => l.startsWith('提醒：'));
    assert.ok(line.length < 120, `${line.length} 字：${line}`);
  });
});

describe('整段的體量', () => {
  test('狀態注入不超過十來行', async () => {
    const text = await brief({ kind: 'plot', plotRelPath: PLOT1 });
    assert.ok(text.split('\n').length <= 12, `${text.split('\n').length} 行：\n${text}`);
  });
});

/**
 * D11：老工程（幾十章正文、從沒有過架構）會被推回架構第一件——新鏈路寫正文要讀前提、
 * 角色與世界觀，沒有它們上下文就是空的。但**選中的某一章**按章號認，報的是它自己的
 * 狀態：有字就是待定稿 / 已完成，不被倒回去要求補細綱。
 */
describe('老工程 · 99 章成品、沒有架構也沒有細綱', () => {
  let t2;
  let old;
  let text;

  before(async () => {
    t2 = await makeTempProject(bundle.project, { prefix: 'agentstate-old', title: '舊書' });
    old = t2.project;
    for (let i = 1; i <= 99; i++) {
      t2.write(`chapters/${String(i).padStart(3, '0')}-第${i}章.md`, `# 第${i}章\n\n${'字'.repeat(3000)}\n`);
    }
    writeOutline(t2, '# 大綱\n\n少年入宗，一路向北。\n');
    old.invalidate();
    text = await bundle.stateBrief.buildStateBrief(old);
  });

  after(() => {
    if (t2) cleanup(t2.dir);
  });

  test('說「已寫 99 章」', () => {
    assert.ok(text.includes('已寫 99 章'), text);
  });

  test('總字數按萬字報', () => {
    assert.ok(/\d+\.\d 萬字/.test(text), text);
  });

  // 從前（D11）推的是「生成小說配置」：憑一句話編一套與這 99 章無關的設定。拆書 A 之後改成照正文整理。
  test('全書下一步是「從已寫正文補齊」，是工程動作、不帶呼叫次數（框裡再報）', async () => {
    const { step } = await bookStepOf(old);
    assert.equal(step.label, '從已寫正文補齊…');
    assert.equal(step.projectAction, 'deriveFromText');
    assert.equal(step.calls, undefined);
    assert.ok(step.hint.includes('第 1–99 章') && step.hint.includes('小說配置'), step.hint);
    assert.ok(text.includes(step.label) && text.includes(step.hint), text);
  });

  test('選中某一章按章號認，報它自己的狀態', async () => {
    const rel = 'chapters/099-第99章.md';
    const s = await bundle.stateBrief.buildStateBrief(old, { kind: 'manuscript', plotRelPath: rel });
    const now = await nextStepOf(rel, old);
    assert.ok(s.includes('當前目標：第 99 章') && s.includes(rel), s);
    assert.ok(s.includes('狀態：待同步'), s);
    assert.ok(s.includes(now.label), `${s}\n期望含「${now.label}」`);
  });

  // 老工程寫了 99 章、從沒碰過這個工具，不該被倒回去要求補細綱。
  test('不說「待寫細綱」', async () => {
    const s = await bundle.stateBrief.buildStateBrief(old, { kind: 'manuscript', plotRelPath: 'chapters/050-第50章.md' });
    assert.ok(!s.includes('待寫細綱'), s);
  });
});

// 判據各寫一遍的話，創作頁主按鈕會說「寫第 12 章」而 agent 去寫了第 13 章——
// 這種分叉沒有任何測試攔得住，只能靠「只有一份」來防。
describe('主按鈕與狀態注入吃的是同一個 factsOf', () => {
  test('controller 那一側轉發到 views/pipeline 的同一份實現', () => {
    assert.equal(bundle.serialize.factsOf, bundle.viewsPipeline.factsOf);
  });
});
