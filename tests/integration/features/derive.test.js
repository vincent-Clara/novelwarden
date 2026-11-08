/**
 * 從已寫正文補齊（拆書 A 的後一半，features/derive.ts）。
 *
 * | 用例組 | 釘的是什麼 |
 * |---|---|
 * | 全套 | 兩次確認（先只報細綱，細綱出來再報其餘）；按 細綱 → 配置 → 前提 → 角色卡 → 世界觀 → 大綱 → 全文大綱 → 敘事線（排線 + 逐章補記）的順序；第一步照正文寫出 `summaries/NNN-<章名>.md`、帶 sourceHash，直接算定稿過（不再另排一遍細綱）；之後主按鈕照常續寫大綱 |
 * | 敘事線（四期） | 一條線都沒有：補完情節大綱之後先排線、再從第 1 章逐章補記，次數並進第二次確認；水位推到第 N 章；補記停在半路不算補齊失敗，完成提示說一句、失敗掛在那一章上 |
 * | 設定條目 | 一條條目都沒有時，建卡之後從名錄建（出現 ≥2 章，沒有就降到 1 章），次數算進第二次確認；沒建成掛黃 ❗、後面照常補 |
 * | 再來一次 | 什麼都齊了：零呼叫 |
 * | 只補空白 | 作者寫過的前提、定稿過的細綱一個字不動；只排過計劃的那一章拿著計劃對照正文改，舊版進回收站 |
 * | 一件失敗就停 | 大綱沒整理成就不更新全文大綱，失敗掛在大綱上（第 16 條） |
 * | 取消 | 細綱那一步不同意就一次都不調 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let fake;
let replyFn;
const projects = [];

const TITLES = ['入宗', '雪夜', '舊案', '夜探', '執法堂', '下山', '渡口'];
const pad3 = (n) => String(n).padStart(3, '0');
const CH = (no) => `chapters/${pad3(no)}-${TITLES[no - 1]}.md`;
const PLOT = (no) => `.novelwarden/summaries/${pad3(no)}-${TITLES[no - 1]}.md`;
/** 第 no 章的正文：長短不一，好看出每章字數取的是已寫各章的平均。 */
const text = (no) => `林昭第${no}次見到沈青。${'山門很高。'.repeat(40 + no * 10)}門外有人敲了三下。`;

const CONFIG_JSON = JSON.stringify({
  genre: '玄幻',
  targetAudience: '男頻',
  subGenre: '宗門',
  plotStructure: 'three_act',
  narrativePOV: 'third_limited',
  coreOutline: '少年揹著舊案入宗，查出宗門與舊案的關係。',
  worldSetting: '靈脈枯竭的九州。',
  goldenFinger: '殘令。',
  protagonistProfile: '林昭，隱忍。',
  globalGuidance: '1. 不寫上帝視角\n2. 每章留鉤子\n3. 金手指有代價\n4. 對白分得出是誰',
  writingStyle: '冷峻剋制。',
});

/** 這一次呼叫是哪一步。整理細綱（定稿的第一步）有沒有當前細綱都以同一句開頭。 */
function kindOf(messages) {
  const sys = messages[0]?.content ?? '';
  const user = messages[messages.length - 1].content;
  if (sys.includes('只從作者給的小說配置、故事前提、角色圖譜與情節大綱裡排出這本書的敘事線')) return 'threadPlan';
  if (sys.includes('你是小說定稿事實審查員')) return 'threads';
  if (sys.includes('給每一條寫一兩句「當前進度」')) return 'threadProgress';
  if (sys.includes('判斷它們是不是已有的某一條換了個說法')) return 'threadMerge';
  if (sys.includes('建立可檢索的章節檔案')) return 'plot';
  if (sys.includes('負責維護一部長篇小說的人物檔案')) return 'card';
  if (sys.includes('把定稿細綱裡關於一個設定的記錄整理成一條設定條目')) return 'lore';
  if (sys.includes('全文大綱')) return 'global';
  if (user.includes('【小說配置格式】')) return 'config';
  if (user.includes('整理出這一段的情節大綱')) return 'outline';
  if (user.includes('「故事前提」')) return 'premise';
  if (user.includes('「世界觀」')) return 'world';
  return '?';
}

/** 整理細綱時第 no 章記下的「設定」（「設定」一節）。預設一條都沒有。 */
let loreOf = () => [];

function defaultReply(messages) {
  const user = messages[messages.length - 1].content;
  switch (kindOf(messages)) {
    case 'plot': {
      const no = Number(/第\s*(\d+)\s*章/.exec(user)?.[1] ?? 0);
      return JSON.stringify({
        梗概: `第 ${no} 章：林昭與沈青查舊案。`,
        出场人物: [{ name: '林昭', aliases: [] }, { name: '沈青', aliases: [] }],
        关键事件: [`第 ${no} 章查到一條線索`],
        连续性事实: [],
        设定: loreOf(no),
      });
    }
    case 'card':
      return JSON.stringify({ aliases: [], tags: ['主角'], 身份: '宗門弟子', 性格: '隱忍', 当前状态: '在渡口' });
    case 'lore':
      return JSON.stringify({ brief: '青雲宗的山門', keywords: ['山門'], body: '## 概要\n山門很高。\n\n## 規則與邊界\n（未交代）\n\n## 現狀\n（未交代）' });
    case 'global':
      return '## 主線\n\n林昭入宗查舊案，到了渡口。';
    case 'config':
      return CONFIG_JSON;
    case 'premise':
      return '## 一句話前提\n\n當孤兒遭遇滅門，必須入宗查案。\n\n## 核心衝突鏈\n\n滅門 → 入宗 → 查案。\n\n## 爽點迴圈\n\n殘令。\n\n## 懸念骨架\n\n誰放的火。';
    case 'world':
      return '## 規則與漏洞\n\n靈脈決定修為。\n\n## 階層與資源\n\n宗門壟斷靈脈。\n\n## 深層危機\n\n靈脈在枯竭。';
    // 敘事線（四期）：排出一條主線；每章認事件記一條推進（證據是正文開頭那一句），當前進度照線名回。
    case 'threadPlan':
      return JSON.stringify({ threads: [{ title: '青雲舊案', kind: '主线', from: 1, to: 100, intent: '查清舊案。' }] });
    case 'threads': {
      const no = Number(/【第(\d+)章/.exec(user)?.[1] ?? 0);
      return JSON.stringify({
        events: [{ line: '青雲舊案', type: '推进', what: `第 ${no} 章又見沈青`, evidence: `林昭第${no}次見到沈青。` }],
        newThreads: [],
        newForeshadowing: [],
      });
    }
    case 'threadProgress': {
      const lines = [...user.matchAll(/^【線】(.+)$/gm)].map((m) => m[1]);
      return JSON.stringify({ progress: lines.map((line) => ({ line, text: `${line}查到了這裡。` })) });
    }
    case 'threadMerge':
      return JSON.stringify({ merges: [] });
    case 'outline': {
      const m = /裡第 (\d+)(?:–(\d+))? 章實際發生/.exec(user);
      const from = Number(m[1]);
      const to = Number(m[2] ?? m[1]);
      // 一章一條。
      const entries = [];
      for (let no = from; no <= to; no++) {
        entries.push(`## 第${no}章：查案\n林昭在第 ${no} 章一路查下去。`);
      }
      return entries.join('\n\n');
    }
    default:
      return '';
  }
}

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    derive: './src/core/features/derive.ts',
    pipe: './src/core/views/pipeline.ts',
    lore: './src/core/views/lore.ts',
    pipeline: './src/core/model/pipeline.ts',
    outlineFile: './src/core/model/outlineFile.ts',
    errorLog: './src/core/runtime/errorLog.ts',
    db: './src/core/runtime/db.ts',
  });
  h = makeFakeHost({
    supportsVscodeLm: true,
    settings: () => ({ providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }], models: ['p/m'], concurrency: 1 }),
    overrides: { reviewReplace: undefined },
  });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, { reply: (messages) => replyFn(messages) });
});

after(() => {
  for (const t of projects) cleanup(t.dir, bundle?.db);
});

/** 一個只有 7 章正文的工程（匯入原稿之後的樣子）。 */
async function fresh(prefix) {
  const t = await makeTempProject(bundle.project, { prefix, title: '補齊測試' });
  projects.push(t);
  for (let no = 1; no <= TITLES.length; no++) {
    t.write(CH(no), `# ${TITLES[no - 1]}\n\n${text(no)}\n`);
  }
  t.project.invalidate();
  fake.reset();
  replyFn = defaultReply;
  loreOf = () => [];
  return t;
}
const kinds = () => fake.calls.map(kindOf);

describe('從已寫正文補齊 · 全套', () => {
  let t;
  let calls;
  before(async () => {
    t = await fresh('derive-all');
    // 先整理細綱 → 總章數 → 開始補齊
    h.expect('先整理細綱', '100', '開始補齊');
    calls = await bundle.derive.deriveFromText(t.project);
  });

  test('第一次只報細綱的次數', () => {
    assert.equal(
      h.confirms[0].message,
      '從已寫正文補齊第 1–7 章：先照正文給 7 章整理細綱（沒同步的、同步後正文改過的），預計 14 次呼叫，最多 21 次。現在開始？'
    );
    // 2026-10-25 起每章寫 1 次、轉寫 1 次，不合格重轉 1 次；確認框單列轉寫那一檔。
    assert.match(h.confirms[0].detail, /每章 2 次，最多 3 次（寫 1 次、轉寫模型照抄成 JSON 1 次/);
    assert.ok(h.confirms[0].call.fixed?.some((f) => f.startsWith('轉寫') && f.endsWith('（不跟這一次挑的模型）')), JSON.stringify(h.confirms[0].call));
  });

  test('第一次說清其餘幾樣細綱出來再問：建卡次數要看細綱裡認出了誰', () => {
    assert.match(h.confirms[0].detail, /細綱出來之後再算建卡與設定要調幾次/);
  });

  test('總章數沒寫就問一句，預設 100', () => {
    assert.equal(h.inputs.length, 1);
    assert.equal(h.inputs[0].value, '100');
    assert.equal(h.inputs[0].validate('3'), '填一個不小於 7 的整數');
    assert.equal(h.inputs[0].validate('120'), undefined);
  });

  test('第二次把其餘幾樣一次列全，次數按細綱算準；不再另排細綱', () => {
    // 2026-10-25 起結構化的每一次都多一次轉寫：配置 2（上限 5）+ 前提 1 + 兩批卡 × 2（上限 × 3）+ 世界觀 1 + 全文大綱 1（上限 5）
    // + 敘事線：排線 2（上限 3）+ 7 章 × 2–6（上限 9）。
    // 情節大綱不另外整理：它是各章細綱梗概的彙總，第一步整理出細綱它就齊了。
    assert.equal(
      h.confirms[1].message,
      '從已寫正文補齊第 1–7 章：小說配置、故事前提、角色卡、世界觀、全文大綱、敘事線，預計 25–53 次呼叫，最多 84 次。現在補？'
    );
  });

  test('第二次的說明：配置按總章數與已寫的平均字數展開', () => {
    assert.match(h.confirms[1].detail, /按 100 章 × \d+ 字展開/);
  });

  test('第二次的說明：建卡的人取細綱裡出場 2 章以上的', () => {
    assert.match(h.confirms[1].detail, /給林昭、沈青建卡（細綱裡出場 2 章以上/);
  });

  test('第二次的說明：情節大綱不另外整理（細綱的梗概就是它）', () => {
    assert.match(h.confirms[1].detail, /情節大綱不用另外整理：它是各章細綱梗概的彙總/);
    assert.doesNotMatch(h.confirms[1].detail, /照細綱整理第/);
  });

  test('第二次的說明：敘事線一條都沒有，先從情節大綱排、再逐章補記；沒判成不算補齊失敗', () => {
    assert.match(
      h.confirms[1].detail,
      /敘事線：還沒有一條線，先從情節大綱排一次（排 1 次、轉寫 1 次）；再逐章認第 1–7 章在敘事線上發生了什麼（7 章，每章 2–6 次，按章號序列）；一章沒判成就停在那裡，不算補齊失敗/
    );
    assert.match(h.confirms[1].detail, /→ 全文大綱 → 敘事線 的順序/);
  });

  test('第二次的確認框列出用到的檔：劇情細綱（大綱、排線）與定稿（全文大綱、敘事線）', () => {
    assert.ok(h.confirms[1].call.tiers.length >= 4, JSON.stringify(h.confirms[1].call.tiers));
  });

  test('按鏈路順序一件一件來：敘事線排在最後，先排線、再按章號逐章認事件與當前進度', () => {
    assert.deepEqual(kinds(), [
      ...Array(7).fill('plot'),
      'config',
      'premise',
      'card',
      'card',
      'world',
      'global',
      'threadPlan',
      ...Array(7).fill(['threads', 'threadProgress']).flat(),
    ]);
    const asked = fake.calls.filter((m) => kindOf(m) === 'threads').map((m) => Number(/【第(\d+)章/.exec(m[m.length - 1].content)[1]));
    assert.deepEqual(asked, [1, 2, 3, 4, 5, 6, 7]);
  });

  test('返回實際次數', () => {
    assert.equal(calls, 28);
  });

  test('敘事線：排出的線裡記下了七章的推進，水位推到第 7 章', async () => {
    const raw = t.read('.novelwarden/threads/青雲舊案.md');
    for (let no = 1; no <= 7; no++) {
      assert.ok(raw.includes(`第 ${no} 章 · 推進：第 ${no} 章又見沈青 〔證據：「林昭第${no}次見到沈青。」〕`), raw);
    }
    assert.deepEqual(await t.project.readThreadsMark(), { through: 7, judged: [] });
  });

  test('沒有細綱的章照正文從頭整理：一次都沒帶「當前細綱」', () => {
    const plotCalls = fake.calls.filter((m) => kindOf(m) === 'plot');
    assert.ok(plotCalls.every((m) => m[m.length - 1].content.includes('請為下面這一章整理細綱')));
  });

  // 設定清單不在補齊的件數里：有正文的書那一件本來就算填過。
  test('架構幾件都補上了；配置的規模按作者給的總章數與已寫的平均字數', async () => {
    t.project.invalidate();
    const facts = await bundle.pipe.buildBookFacts(t.project);
    assert.deepEqual(facts.settings, { config: true, premise: true, characters: true, world: true, lore: true });
    const book = await t.project.readBookConfig();
    assert.equal(book.totalChapters, 100);
    assert.ok(book.wordsPerChapter >= 100 && book.wordsPerChapter % 100 === 0, String(book.wordsPerChapter));
    assert.ok(t.has('.novelwarden/characters/林昭.md') && t.has('.novelwarden/characters/沈青.md'));
  });

  test('大綱覆蓋到已寫的最後一章', async () => {
    const facts = await bundle.pipe.buildBookFacts(t.project);
    assert.equal(facts.outlineCoverage, 7);
  });

  test('細綱落在 summaries/NNN-<章名>.md，一章一份', () => {
    const missing = [1, 2, 3, 4, 5, 6, 7].filter((no) => !t.has(PLOT(no)));
    assert.deepEqual(missing, []);
  });

  test('細綱的標題用章節自己的', async () => {
    t.project.invalidate();
    const titles = [];
    for (let no = 1; no <= 7; no++) titles.push((await t.project.getPlot(no)).title);
    assert.deepEqual(titles, TITLES);
  });

  test('細綱帶著正文的 sourceHash：這幾章直接算定稿過', async () => {
    const chapters = await t.project.listChapters();
    const unfinalized = [];
    for (const chapter of chapters) {
      if (!(await t.project.finalizedPlotOf(chapter))) unfinalized.push(chapter.order);
    }
    assert.deepEqual(unfinalized, []);
  });

  test('照正文整理出來的細綱不記目標字數（那是計劃那一側的賬）', async () => {
    const plot = await t.project.getPlot(3);
    assert.equal(plot.targetWords, undefined);
  });

  test('流水線：每一章都是完成，正文不掛 ⟳', async () => {
    const rows = [];
    for (let no = 1; no <= 7; no++) {
      const plot = await t.project.getPlot(no);
      const row = await bundle.pipe.buildPlotPipeline(t.project, { no, plot });
      rows.push(`${row.stage}${row.chapter?.upstreamStale ? '⟳' : ''}`);
    }
    assert.deepEqual(rows, Array(7).fill('done'));
  });

  test('情節大綱就是第一步整理出來的細綱的梗概：覆蓋到第 7 章，沒為它另調模型', async () => {
    assert.ok(!kinds().includes('outline'), kinds().join(','));
    t.project.invalidate();
    const outline = bundle.outlineFile.parseOutline(await t.project.readOutline());
    assert.deepEqual(outline.map((e) => e.no), [1, 2, 3, 4, 5, 6, 7]);
  });

  test('之後主按鈕照常往後規劃：續寫第 8 章起的大綱', async () => {
    t.project.invalidate();
    const facts = await bundle.pipe.buildBookFacts(t.project);
    const stage = bundle.pipeline.deriveBookStage(facts);
    const step = bundle.pipeline.deriveBookNextStep(stage, facts);
    assert.equal(step.label, '續寫情節大綱（第 8–27 章）');
    assert.equal(step.projectAction, undefined);
  });

  test('全文大綱更新到第 7 章', async () => {
    assert.equal((await t.project.readManifest()).globalSummaryThrough, 7);
  });

  test('完成提示報出補了什麼與次數', () => {
    assert.ok(
      h.toasts.some((x) => x.includes('已從第 1–7 章補上：7 章細綱、') && x.includes('全文大綱、敘事線 7 章') && x.includes('呼叫 28 次')),
      h.toasts.join('|')
    );
  });

  test('再來一次：什麼都齊了，零呼叫、不彈框', async () => {
    fake.reset();
    h.expect();
    const n = await bundle.derive.deriveFromText(t.project);
    assert.equal(n, 0);
    assert.equal(fake.callCount(), 0);
    assert.equal(h.confirms.length, 0);
    assert.ok(h.toasts.some((x) => x.includes('都已經有了')), h.toasts.join('|'));
  });
});

describe('從已寫正文補齊 · 設定條目（從名錄建）', () => {
  let t;
  let calls;
  let failures;
  before(async () => {
    t = await fresh('derive-lore');
    // 每一章都記下「山門」（7 章）；「門外」只在第 3 章記過（1 章）。門檻是 1 章，兩條都建。
    loreOf = (no) => [
      { name: '山門', category: '地域', fact: '山門很高' },
      ...(no === 3 ? [{ name: '門外', category: '地域', fact: '' }] : []),
    ];
    h.expect('先整理細綱', '100', '開始補齊');
    calls = await bundle.derive.deriveFromText(t.project);
    failures = await bundle.errorLog.listActiveFailures(t.project);
  });

  test('確認框把設定條目算進去：出現過的都建，每條寫 1 次、轉寫 1 次，整理不出來的重寫一次', () => {
    // 配置 2（上限 5）+ 前提 1 + 兩批卡 × 2（上限 × 3）+ 世界觀 1 + 設定條目 2 × 2（上限 × 6）+ 全文大綱 1（上限 5）+ 敘事線 2（上限 3）+ 7 × 2–6（上限 9）
    assert.equal(
      h.confirms[1].message,
      '從已寫正文補齊第 1–7 章：小說配置、故事前提、角色卡、世界觀、設定條目、全文大綱、敘事線，預計 29–57 次呼叫，最多 96 次。現在補？'
    );
    assert.match(h.confirms[1].detail, /設定條目：給山門、門外建條目（細綱裡出現 1 章以上、還沒有條目/);
    assert.match(h.confirms[1].detail, /只讀同步過的細綱裡提到它們的那幾行，預計 4 次呼叫，最多 12 次/);
  });

  test('建卡之後、全文大綱之前建條目', () => {
    assert.deepEqual(kinds().slice(0, 15), [...Array(7).fill('plot'), 'config', 'premise', 'card', 'card', 'world', 'lore', 'lore', 'global']);
    // 後面是敘事線：排線 1 + 7 章各認事件、當前進度 2。
    assert.equal(calls, 15 + 1 + 14);
  });

  test('條目建在名錄給的分類目錄裡：標題、關鍵詞、一句話、機器寫的指紋、水位到最後一章定稿', async () => {
    t.project.invalidate();
    const entries = await t.project.listLore();
    assert.ok(entries.some((e) => e.relPath === '.novelwarden/lore/地域/山門.md'));
    const e = entries.find((e) => e.title === '山門');
    assert.equal(e.category, '地域');
    assert.equal(e.brief, '青雲宗的山門');
    assert.equal(e.updatedThrough, 7);
    assert.ok(e.bodyHash && e.body.includes('山門很高'));
    // 建條目的原料只是定稿細綱裡提到它的那幾行，不重讀正文。
    const lore = fake.calls.find((m) => kindOf(m) === 'lore');
    assert.match(lore[lore.length - 1].content, /- 第 1 章：山門很高/);
  });

  test('完成提示報出建了幾條；沒有掛失敗', () => {
    assert.ok(h.toasts.some((x) => x.includes('設定條目 2 條')), h.toasts.join('|'));
    assert.equal(failures['.novelwarden/lore'], undefined);
  });

  test('之後名錄裡兩條都有了條目，沒有未建條目', async () => {
    const index = await bundle.lore.buildLoreIndex(t.project);
    assert.deepEqual(index.unknown.map((u) => u.name), []);
    assert.ok(index.known.some((r) => r.entry.title === '山門'));
    assert.ok(index.known.some((r) => r.entry.title === '門外'));
  });
});

describe('從已寫正文補齊 · 設定條目沒建成也不停', () => {
  let t;
  let failures;
  before(async () => {
    t = await fresh('derive-lore-fail');
    // 只有一章記過設定：門檻降到 1 章。
    loreOf = (no) => (no === 3 ? [{ name: '山門', category: '地域', fact: '' }] : []);
    replyFn = (messages) => (kindOf(messages) === 'lore' ? '不是 JSON' : defaultReply(messages));
    h.expect('先整理細綱', '100', '開始補齊');
    await bundle.derive.deriveFromText(t.project);
    failures = await bundle.errorLog.listActiveFailures(t.project);
  });

  test('只出現過 1 章也正常建', () => {
    assert.match(h.confirms[1].detail, /給山門建條目（細綱裡出現 1 章以上/);
  });

  test('後面的全文大綱照常補', () => {
    assert.deepEqual(kinds().filter((k) => ['lore', 'global'].includes(k)).slice(-2), ['lore', 'global']);
    assert.ok(!h.toasts.some((x) => x.startsWith('error:')), h.toasts.join('|'));
  });

  test('黃 ❗ 掛在「設定清單」那一行（設定目錄）上；一條都沒建', async () => {
    const onLore = failures['.novelwarden/lore'] ?? [];
    assert.ok(onLore.some((f) => f.severity === 'warn' && f.message.includes('設定條目一條都沒建成')), JSON.stringify(failures));
    assert.deepEqual(await t.project.listLore(), []);
  });
});

// 敘事線（四期）是額外的一道：第 4 章認事件沒成，補記停在那裡、不算補齊失敗；已經判過的留著，水位停在第 3 章，失敗掛在第 4 章上。
describe('從已寫正文補齊 · 敘事線補記停在半路也不算補齊失敗', () => {
  let t;
  let failures;
  before(async () => {
    t = await fresh('derive-threads-stop');
    replyFn = (messages) =>
      kindOf(messages) === 'threads' && messages[messages.length - 1].content.includes('【第4章') ? '不是 JSON' : defaultReply(messages);
    h.expect('先整理細綱', '100', '開始補齊');
    await bundle.derive.deriveFromText(t.project);
    failures = await bundle.errorLog.listActiveFailures(t.project);
  });

  test('前面幾樣都補上了；敘事線判到第 3 章，第 5–7 章一次都沒調', async () => {
    assert.ok(kinds().includes('global'));
    const asked = fake.calls.filter((m) => kindOf(m) === 'threads').map((m) => Number(/【第(\d+)章/.exec(m[m.length - 1].content)[1]));
    assert.deepEqual(asked, [1, 2, 3, 4]);
    assert.deepEqual(await t.project.readThreadsMark(), { through: 3, judged: [] });
  });

  test('失敗掛在第 4 章上；完成提示照樣報補上了什麼，另說敘事線停在第 4 章', () => {
    const onCh4 = failures[CH(4)] ?? [];
    assert.ok(onCh4.some((f) => f.op === 'threads' && f.message.includes('從已寫正文補記敘事線沒成')), JSON.stringify(failures));
    const toast = h.toasts.find((x) => x.includes('已從第 1–7 章補上：'));
    assert.ok(toast && toast.includes('敘事線 3 章'), h.toasts.join('|'));
    assert.ok(toast.includes('第 4 章沒判成') && toast.includes('後面 3 章沒判'), toast);
    assert.ok(toast.includes('接下來可以續寫大綱'), toast);
  });
});

describe('從已寫正文補齊 · 只補空白', () => {
  let t;
  /** 第 2 章：作者定稿過、sourceHash 對得上正文的細綱。 */
  let finalizedText;
  /** 第 3 章：作者排過、還沒定稿的計劃。 */
  let planText;
  before(async () => {
    t = await fresh('derive-blank');
    t.write('.novelwarden/config.md', '---\ntotalChapters: 50\nwordsPerChapter: 2000\n---\n\n# 小說配置\n\n## 核心梗概\n\n作者自己寫的梗概。\n');
    t.write('.novelwarden/premise.md', '# 故事前提\n\n## 一句話前提\n\n作者寫的前提。\n\n## 核心衝突鏈\n\n作者寫的衝突鏈。\n');
    const ch2 = (await t.project.listChapters()).find((c) => c.order === 2);
    finalizedText = [
      '---', 'no: 2', 'title: 作者的標題', `sourceHash: ${ch2.contentHash}`, 'cast: [林昭, 沈青]', '---', '',
      '# 第2章 作者的標題', '', '## 梗概', '', '作者定稿的梗概。', '', '## 出場人物', '', '林昭、沈青', '',
      '## 關鍵事件', '', '作者定稿的事件。', '',
    ].join('\n');
    t.write(PLOT(2), finalizedText);
    planText = [
      '---', 'no: 3', 'title: 作者排的', 'targetWords: 999', '---', '',
      '# 第3章 作者排的', '', '## 梗概', '', '作者排的梗概。', '', '## 關鍵事件', '', '作者排的事件。', '',
      '## 看點', '', '- 作者想的看點。', '',
    ].join('\n');
    t.write(PLOT(3), planText);
    t.project.invalidate();
    h.expect('先整理細綱', '開始補齊');
    await bundle.derive.deriveFromText(t.project);
  });

  test('配置與前提已經有了：不問總章數、不調那兩件', () => {
    assert.equal(h.inputs.length, 0);
    assert.ok(!kinds().includes('config') && !kinds().includes('premise'), kinds().join(','));
    assert.match(t.read('.novelwarden/config.md'), /作者自己寫的梗概/);
    assert.match(t.read('.novelwarden/premise.md'), /作者寫的衝突鏈/);
  });

  test('定稿過、對得上正文的第 2 章不算在內：只給 6 章整理細綱', () => {
    assert.match(h.confirms[0].message, /先照正文給 6 章整理細綱/);
  });

  test('定稿過的第 2 章細綱一個字不動', () => {
    assert.equal(t.read(PLOT(2)), finalizedText);
  });

  test('排過計劃的第 3 章：拿著當前細綱與正文對照著改', () => {
    const call = fake.calls.find((m) => kindOf(m) === 'plot' && m[m.length - 1].content.includes('【第3章 舊案 · 當前細綱】'));
    assert.match(call[call.length - 1].content, /## 梗概\n作者排的梗概。/);
  });

  test('第 3 章的計劃原樣進了回收站', () => {
    assert.equal(t.read(`.novelwarden/.trash/${PLOT(3)}`), planText);
  });

  test('第 3 章反向更新之後：作者起的標題與目標字數留著', async () => {
    t.project.invalidate();
    const plot = await t.project.getPlot(3);
    assert.deepEqual({ title: plot.title, targetWords: plot.targetWords }, { title: '作者排的', targetWords: 999 });
  });

  test('第 3 章反向更新之後：七節換成照正文整理的那一版', async () => {
    const plot = await t.project.getPlot(3);
    assert.equal(plot.sections.梗概, '第 3 章：林昭與沈青查舊案。');
  });
});

describe('從已寫正文補齊 · 一件失敗就停', () => {
  let t;
  before(async () => {
    t = await fresh('derive-fail');
    replyFn = (messages) => (kindOf(messages) === 'world' ? '' : defaultReply(messages));
    h.expect('先整理細綱', '100', '開始補齊');
    await bundle.derive.deriveFromText(t.project);
  });

  test('世界觀沒整理成：不更新全文大綱，也不排線、不補記敘事線', () => {
    assert.ok(!kinds().includes('global'), kinds().join(','));
    assert.ok(!kinds().some((k) => k.startsWith('thread')), kinds().join(','));
  });

  test('第一步整理好的細綱留著', () => {
    assert.ok(t.has(PLOT(1)));
  });

  test('失敗掛在世界觀上，提示說清停在哪、前面補上了什麼', async () => {
    const failures = await bundle.errorLog.listActiveFailures(t.project);
    const onWorld = failures['.novelwarden/world.md'] ?? [];
    assert.ok(onWorld.some((f) => f.message.includes('世界觀')), JSON.stringify(failures));
    assert.ok(
      h.toasts.some((x) => x.startsWith('error:') && x.includes('小說配置') && x.includes('世界觀沒補上')),
      h.toasts.join('|')
    );
  });
});

describe('從已寫正文補齊 · 取消與沒有正文', () => {
  test('細綱那一步不同意：一次都不調', async () => {
    const t = await fresh('derive-cancel');
    h.expect(undefined);
    const n = await bundle.derive.deriveFromText(t.project);
    assert.equal(n, 0);
    assert.equal(fake.callCount(), 0);
  });

  test('第 1 章沒有正文：說清要從第 1 章起連續', async () => {
    const t = await fresh('derive-gap');
    t.remove(CH(1));
    t.project.invalidate();
    h.expect();
    const n = await bundle.derive.deriveFromText(t.project);
    assert.equal(n, 0);
    assert.ok(h.toasts.some((x) => x.startsWith('error:') && x.includes('從第 1 章起連續')), h.toasts.join('|'));
  });

  // 第 3、4 章沒有正文、後面還有 3 章：多半是章號沒接上，先問一句再只照第 1–2 章做。
  test('中間斷了一截：先問要不要只照前一截做，不同意就一次都不調', async () => {
    const t = await fresh('derive-mid-gap');
    t.remove(CH(3));
    t.remove(CH(4));
    t.write('chapters/005-番外.md', '番外一則');
    t.project.invalidate();
    const chapters = await t.project.listChapters();
    assert.deepEqual(bundle.pipe.chapterGapOf(chapters), { from: 3, to: 4, later: 3, last: 7 });
    assert.deepEqual(bundle.pipe.duplicateChapterNos(chapters), [5]);
    const facts = await bundle.pipe.buildBookFacts(t.project);
    assert.equal(bundle.pipeline.deriveBookNextStep(bundle.pipeline.deriveBookStage(facts), facts).projectAction, 'chapterGap');

    const before = h.confirms.length;
    h.expect(undefined);
    const n = await bundle.derive.deriveFromText(t.project);
    assert.equal(n, 0);
    assert.equal(fake.callCount(), 0);
    const c = h.confirms[before];
    assert.match(c.message, /第 3–4 章沒有正文，後面還有 3 章已寫（寫到第 7 章）/);
    assert.deepEqual(c.actions, ['仍然繼續']);
  });

  test('只到末尾沒寫完不算斷：照常補齊', async () => {
    const t = await fresh('derive-tail');
    t.remove(CH(7));
    t.project.invalidate();
    assert.equal(bundle.pipe.chapterGapOf(await t.project.listChapters()), undefined);
  });
});
