/**
 * 正文層的裝配（三期）：移植自 AI-Novel-Writer `first_chapter_draft` / `next_chapter_draft`
 * 的材料包與提示詞。
 *
 * | 釘住什麼 | 為什麼 |
 * |---|---|
 * | 全域要求單獨強制帶，且不在架構那幾條裡重複 | 作者定的跨章規矩，每一章都得守；重複一遍就是兩份 |
 * | 後 5 章細綱作邊界，按章號視窗、只帶排過的 | 沒有邊界，模型會把下一章的事提前演掉 |
 * | 執行卡在訊息最末，只帶必需事件與作者指導，沒有章節鉤子 | 模型對末尾最敏感；章末鉤子並進了「看點」，看點不是一件件到期的動作 |
 * | 更早幾章的細綱都帶：沒定稿的標「計劃」，定稿過的不標；定稿之後正文又改過的打 ⚠ | 先排完細綱再回頭寫時，計劃就是唯一的前情；標出來模型才不把計劃當已發生 |
 * | 第 1 章與後續章各一套法則，D8 禁令都在系統提示裡 | 上游兩套提示詞（PT:720-855） |
 * | 上一章結尾寫明「不可重演」 | 最常見的失敗是把上一章最後一場重演一遍 |
 * | 接著寫只要新增的那一段，從本章已寫的末尾接 | 落盤是追加，模型要是重寫整章就疊成兩份 |
 * | 續寫那幾輪用精簡配方，但帶近幾章的連續性事實 | 每一輪都付一次全價的材料包不值；一條前情都不帶，死了的人會在續寫裡活過來 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadBundle } = require('../../helpers/load');
const { installVscodeStub } = require('../../helpers/vscodeStub');
const { copyFixture } = require('../../helpers/tmpProject');
const { cleanup } = require('../../helpers/teardown');

const WRITE = { stage: 'manuscript', capability: 'generate' };

const config = {
  providers: [{ id: 'p', kind: 'openai', baseUrl: 'https://x/v1', models: [{ name: 'm' }] }],
  model: 'p/m',
  contextWindow: 128000,
  maxOutputTokens: 4096,
  temperature: 0.8,
  chaptersDir: 'chapters',
  draftsDir: 'drafts',
  summaryBatchSize: 15,
  requestTimeoutMs: 300000,
};

const ASK = '李叔這一章也要露一面。';

/** 第 N 章的細綱（計劃，七節裡填了梗概、出場人物、關鍵事件、看點）。`events` 為空就是一個空殼。 */
function plotText(no, title, events) {
  return [
    '---',
    `no: ${no}`,
    `title: ${title}`,
    'targetWords: 1200',
    '---',
    '',
    `# 第${no}章 ${title}`,
    '',
    '## 梗概',
    '',
    events ? `第${no}章的梗概` : '',
    '',
    '## 出場人物',
    '',
    events ? '林昭' : '',
    '',
    '## 關鍵事件',
    '',
    events,
    '',
    '## 看點',
    '',
    events ? `- 第${no}章的看點` : '',
    '',
  ].join('\n');
}

let t;
let project;
let builderMod;
let vs;

const PLOT = (no, title) => `.novelwarden/summaries/${String(no).padStart(3, '0')}-${title}.md`;
const lastUser = (b) => b.messages[b.messages.length - 1].content;
const ids = (b) => new Map(b.items.map((i) => [i.id, i]));

before(async () => {
  t = copyFixture('manuscript-recipe');
  vs = installVscodeStub({ level: 'full', root: t.dir, config: {} });
  // 第 4 章《空匣》示例工程裡本來就排好了細綱（計劃，還沒寫正文）；後面幾章在這裡補上。
  const plots = path.join(t.dir, '.novelwarden/summaries');
  // 示例工程第 5–10 章是隻有梗概的空殼（大綱排到了第 10 章）：換成下面這幾份，免得同一章兩份細綱。
  for (const name of fs.readdirSync(plots).filter((f) => /^0(0[5-9]|10)/.test(f))) {
    fs.rmSync(path.join(plots, name));
  }
  // 關鍵事件一條一行（與定稿的寫法一樣）；邊界裡一章一行，條與條之間用「；」接。
  fs.writeFileSync(path.join(plots, '005-名冊.md'), plotText(5, '名冊', '- 沈氏拿出一本殘缺的名冊。\n- 名冊上第三個名字被劃掉了。'));
  // 第 6 章只是個空殼：邊界裡沒有可寫的事，不帶。
  fs.writeFileSync(path.join(plots, '006.md'), plotText(6, '', ''));
  fs.writeFileSync(path.join(plots, '007-火場.md'), plotText(7, '火場', '七年前那場火的第一個證人開口。'));
  fs.writeFileSync(path.join(plots, '008-守衛.md'), plotText(8, '守衛', '年輕守衛的母親失蹤。'));
  fs.writeFileSync(path.join(plots, '009-令牌.md'), plotText(9, '令牌', '第三塊令牌出現在李叔手裡。'));
  // 第 10 章在「後 5 章」視窗之外（4 + 5 = 9）。
  fs.writeFileSync(path.join(plots, '010-夜雨.md'), plotText(10, '夜雨', '視窗外的第十章。'));

  const bundle = loadBundle({
    project: './src/core/model/project.ts',
    builder: './src/core/context/builder.ts',
    prompts: './src/core/context/prompts.ts',
  });
  builderMod = bundle.builder;
  project = bundle.project.NovelProject.open(t.dir);
  project.prompts = bundle.prompts;
});

after(() => {
  vs?.restore?.();
  cleanup(t.dir);
});

describe('正文配方 · 寫第 4 章（後續章）', () => {
  let b;
  let byId;
  before(async () => {
    b = await builderMod.buildContext(
      project,
      { action: WRITE, target: { kind: 'manuscript', plotRelPath: PLOT(4, '空匣') }, ask: ASK, targetWords: 1200 },
      config
    );
    byId = ids(b);
  });

  test('全域要求單獨成段、強制帶', () => {
    const g = byId.get('guidance');
    assert.equal(g.status, 'included');
    assert.equal(g.priority, 0);
    assert.match(g.text, /懸疑靠資訊差推進/);
    assert.ok(lastUser(b).includes('# 全域要求（每一章都要遵守）'));
  });

  test('架構那幾條（P1）裡不再重複全域要求', () => {
    const cfg = byId.get('setting:config');
    assert.equal(cfg.priority, 1);
    assert.ok(!cfg.text.includes('懸疑靠資訊差推進'), cfg.text);
    assert.match(cfg.note, /全域要求/);
    assert.ok(byId.has('setting:premise'));
    assert.ok(byId.has('setting:world'));
    // 全域要求在整條訊息裡只出現一次。
    assert.equal(lastUser(b).split('懸疑靠資訊差推進').length, 2);
  });

  test('後 5 章細綱作邊界：按章號視窗（5–9），空殼不帶，視窗外的不帶', () => {
    const ahead = b.items.find((i) => i.kind === 'boundary');
    assert.ok(ahead, b.items.map((i) => i.id).join(','));
    assert.equal(ahead.priority, 0);
    assert.equal(ahead.status, 'included');
    for (const no of [5, 7, 8, 9]) {
      assert.ok(ahead.text.includes(`第${no}章`), ahead.text);
    }
    assert.ok(!ahead.text.includes('第6章'), ahead.text);
    assert.ok(!ahead.text.includes('視窗外的第十章'), ahead.text);
    assert.ok(ahead.text.includes('第5章 名冊：沈氏拿出一本殘缺的名冊。；名冊上第三個名字被劃掉了。\n'), ahead.text);
  });

  test('邊界在本章細綱之後、補充要求之前，寫明不許提前寫', () => {
    const user = lastUser(b);
    const [plot, boundary, askAt] = ['# 細綱', '# 後續章節預告', '# 這一章的補充要求'].map((h) => user.indexOf(h));
    assert.ok(plot >= 0 && plot < boundary && boundary < askAt, `${plot} / ${boundary} / ${askAt}`);
    assert.match(user, /絕對不要在本章提前寫出/);
  });

  // 關鍵事件是一條一行的列表：多條時縮排列在「必需事件」下面，按原來的順序，一條一項地核對。
  test('執行卡壓在訊息最末：必需事件、作者本章指導', () => {
    const user = lastUser(b);
    const card = user.slice(user.indexOf('【本章執行卡'));
    assert.ok(user.indexOf('【本章執行卡') > user.indexOf('【本章篇幅】'));
    assert.ok(
      card.includes(
        '- 必需事件：\n  - 林昭隨年輕守衛趕到鎮西舊宅，門虛掩、屋裡無人，衣櫃被翻得一團亂，裝令牌的木匣空著。\n' +
          '  - 年輕守衛承認左臉的傷是昨夜在家門口挨的，打他的人蒙著臉、只問令牌在哪。\n' +
          '  - 兩人回鎮口當面問李叔，李叔先裝不認識。\n' +
          '  - 林昭亮出自己那塊牌子，李叔才壓低聲音說出持牌的人七年前都在那場火裡，隨即把兩人趕走。\n'
      ),
      card
    );
    assert.ok(card.includes(`- 作者本章指導：${ASK}`), card);
    assert.match(user.trimEnd(), /現在開始寫作。[^\n]*$/);
  });

  // 章末鉤子並進了「看點」：爽點與章末懸念混在一起，不是一件件到期的動作，細綱整份已經在上面。
  test('執行卡裡沒有章節鉤子', () => {
    const user = lastUser(b);
    const card = user.slice(user.indexOf('【本章執行卡'));
    assert.doesNotMatch(card, /章節鉤子|看點/);
  });

  test('篇幅只給大概：約 N 字，不必精確，不給區間', () => {
    assert.ok(lastUser(b).includes('約 1200 字，不必精確，也不用數字數'));
    assert.ok(!/±\d+%/.test(lastUser(b)));
  });

  test('後續章：連載更新法則，不是黃金第一章', () => {
    const user = lastUser(b);
    assert.match(user, /【網文連載更新核心法則】/);
    assert.ok(!user.includes('黃金第一章'));
    assert.match(user, /不得引用、摘要、回放或重演上一章結尾/);
  });

  test('上一章結尾寫明「只作邊界，不可重演」', () => {
    const user = lastUser(b);
    // 第 3 章正文整章注入時結尾片段被取代，那時換一種說法，同樣寫明不許重演。
    assert.ok(
      user.includes('# 上一章結尾原文（只作邊界，不可重演）') || /結尾的最終狀態之後無縫接下去，不要重演它的結尾/.test(user),
      user.slice(0, 400)
    );
  });

  test('系統提示：D8 四條禁令、作者事實、文風邊界、格式、視角', () => {
    const system = b.messages[0].content;
    for (const rule of project.prompts.ANTI_AI_RULES) {
      assert.ok(system.includes(rule), rule);
    }
    assert.match(system, /【不可偏離的作者事實】/);
    assert.match(system, /【文風適用邊界】/);
    assert.match(system, /中文雙引號/);
    assert.match(system, /敘事視角：第三人稱限知/);
    assert.match(system, /按本章細綱約定的結束狀態收束/);
    assert.doesNotMatch(system, /章末鉤子/);
    assert.ok(!system.includes('留出繼續往下寫的餘地'), '一章一綱之後這一章該停在細綱約定的結束狀態上');
  });

  // 寫正文不帶情節大綱（細綱已經是它這一章的展開），也不帶更早幾十章的細綱（2026-10-21）。
  test('P1：出場角色、前幾章細綱；不帶情節大綱', () => {
    assert.ok(b.items.some((i) => i.kind === 'character' && i.priority === 1));
    assert.ok(b.items.some((i) => i.kind === 'plotSummary' && i.priority === 1));
    assert.ok(!b.items.some((i) => i.kind === 'outlineDoc'), b.items.map((i) => i.id).join(','));
  });
});

describe('正文配方 · 寫第 1 章', () => {
  let b;
  before(async () => {
    b = await builderMod.buildContext(
      project,
      { action: WRITE, target: { kind: 'manuscript', plotRelPath: PLOT(1, '楔子') }, ask: '', targetWords: 800 },
      config
    );
  });

  test('黃金第一章法則，不是連載法則', () => {
    const user = lastUser(b);
    assert.match(user, /【網文「黃金第一章」創作法則】/);
    assert.ok(!user.includes('連載更新核心法則'));
  });

  test('系統提示不說「從上一章結尾接續」', () => {
    assert.ok(!b.messages[0].content.includes('直接從上一章結尾的情境自然接續'));
    assert.match(b.messages[0].content, /正在為一部新作寫第一章/);
  });

  test('作者沒說話時執行卡裡沒有「作者本章指導」', () => {
    assert.ok(!lastUser(b).includes('作者本章指導'));
  });
});

describe('正文配方 · 寫第 5 章（第 4 章只排了細綱、還沒寫正文）', () => {
  let b;
  let byId;
  before(async () => {
    b = await builderMod.buildContext(
      project,
      { action: WRITE, target: { kind: 'manuscript', plotRelPath: PLOT(5, '名冊') }, ask: '', targetWords: 1200 },
      config
    );
    byId = ids(b);
  });

  // 近章全文的視窗是第 3、4 章：第 4 章沒有正文，它的細綱由前幾章細綱那一層（第 2–4 章）帶。
  test('第 4 章沒有正文：近章全文不帶它', () => {
    assert.ok(!byId.has('manuscriptFull:4'));
    assert.equal(byId.get('manuscriptFull:3').status, 'included');
  });

  test('沒定稿的第 4 章照樣帶它的細綱，塊頭標「計劃」並寫明', () => {
    const p4 = byId.get(`plot:${PLOT(4, '空匣')}`);
    assert.equal(p4.status, 'included');
    assert.equal(p4.kind, 'plotSummary');
    assert.equal(p4.label, '第 4 章《空匣》 · 細綱（上文）');
    assert.equal(p4.source, PLOT(4, '空匣'));
    assert.ok(p4.text.startsWith('【第 4 章《空匣》 · 上文 · 計劃】\n梗概：'), p4.text.slice(0, 80));
    assert.equal(p4.note, '還沒同步：帶的是寫之前的計劃');
  });

  test('定稿過、對得上正文的第 2 章不標「計劃」，也沒有說明；第 1 章在前 3 章之外，不帶', () => {
    const p2 = byId.get(`plot:${PLOT(2, '客栈里的女人')}`);
    assert.equal(p2.status, 'included');
    assert.ok(p2.text.startsWith('【第 2 章《客棧裡的女人》 · 上文】\n'), p2.text.slice(0, 40));
    assert.equal(p2.note, undefined);
    assert.ok(!byId.has(`plot:${PLOT(1, '楔子')}`), [...byId.keys()].join(','));
  });

  // 第 4 章還沒寫，第 5 章不該「從第 3 章結尾無縫接下去」——那等於讓模型跳過第 4 章的事件。
  // builder.ts 的兜底提示只在「結尾片段被整章正文取代」時才說。
  test('前一章還沒寫時，不帶上一章結尾，也不讓模型從更早那一章的結尾無縫接下去', () => {
    const user = lastUser(b);
    assert.ok(!b.items.some((i) => i.kind === 'prevTail'));
    assert.ok(!user.includes('結尾的最終狀態之後無縫接下去'), user.slice(-300));
  });

  test('訊息裡一節「前幾章細綱」，說清標「計劃」的還沒定稿，由遠及近', () => {
    const user = lastUser(b);
    const at = user.indexOf('# 前幾章細綱（前情，不要在本章重演；標「計劃」的還沒定稿，不一定是正文寫成的樣子）');
    assert.ok(at >= 0, user.slice(0, 400));
    const section = user.slice(at, user.indexOf('\n---\n', at));
    assert.ok(section.indexOf('【第 2 章《客棧裡的女人》 · 上文】') < section.indexOf('【第 4 章《空匣》 · 上文 · 計劃】'), section.slice(0, 200));
  });
});

describe('正文配方 · 接著寫第 3 章', () => {
  let b;
  let chapterText;
  before(async () => {
    const chapter = (await project.listChapters()).find((c) => c.order === 3);
    chapterText = await project.readChapterText(chapter);
    b = await builderMod.buildContext(
      project,
      {
        action: WRITE,
        target: { kind: 'manuscript', plotRelPath: PLOT(3, '夜訪') },
        ask: '',
        targetWords: 2000,
        writeMode: 'continue',
      },
      config
    );
  });

  test('帶上本章已寫正文的末尾，緊挨著指令', () => {
    const so = b.items.find((i) => i.kind === 'chapterSoFar');
    assert.equal(so.status, 'included');
    assert.ok(chapterText.trim().endsWith(so.text.slice(-20)), so.text.slice(-40));
    const user = lastUser(b);
    assert.ok(user.indexOf('# 本章已寫正文') > user.indexOf('# 細綱'));
    assert.ok(user.indexOf('# 本章已寫正文') < user.indexOf('【本章執行卡'));
  });

  test('契約：只寫新增的那一段，報剩餘字數，不再給整章的篇幅合同', () => {
    const user = lastUser(b);
    assert.match(user, /請無縫續寫當前章節正文/);
    assert.match(user, /只輸出新增正文，不要複述已寫內容/);
    assert.match(user, /大約再寫 \d+ 字，不必精確/);
    assert.ok(!user.includes('【本章篇幅】'));
    assert.match(user.trimEnd(), /現在接著寫。/);
  });

  test('不帶上一章結尾，也不說「從上一章結尾接下去」', () => {
    assert.ok(!b.items.some((i) => i.kind === 'prevTail'));
    assert.ok(!lastUser(b).includes('無縫接下去，不要重演它的結尾'));
  });

  test('不是接著寫時不帶本章已寫正文', async () => {
    const plain = await builderMod.buildContext(
      project,
      { action: WRITE, target: { kind: 'manuscript', plotRelPath: PLOT(3, '夜訪') }, ask: '', targetWords: 2000 },
      config
    );
    assert.ok(!plain.items.some((i) => i.kind === 'chapterSoFar'));
  });
});

describe('正文配方 · 續寫那幾輪（精簡配方）', () => {
  let b;
  let recovery;
  const step = { kind: 'continuation', tail: '他推開了井邊那扇門。門後是一段向下的石階。', written: 700, remaining: 500, recovery: false };
  before(async () => {
    // 第 2 章的細綱定稿過、填上連續性事實：續寫那幾輪也要看見它（百章實驗裡續寫寫了一章的大半）。
    const s2 = path.join(t.dir, '.novelwarden/summaries/002-客栈里的女人.md');
    fs.writeFileSync(s2, fs.readFileSync(s2, 'utf8').replace(/(## 連續性事實\r?\n\r?\n)（待補充）/, '$1- 沈氏住進走廊盡頭的房間'));
    project.invalidate();
    const base = { action: WRITE, target: { kind: 'manuscript', plotRelPath: PLOT(4, '空匣') }, ask: ASK, targetWords: 1200 };
    b = await builderMod.buildContext(project, { ...base, step }, config);
    recovery = await builderMod.buildContext(project, { ...base, step: { ...step, recovery: true } }, config);
  });

  test('只帶接著寫要看的：細綱、邊界、已寫末尾、文風、全域要求、出場角色', () => {
    const kinds = new Set(b.items.map((i) => i.kind));
    for (const k of ['plot', 'boundary', 'chapterSoFar', 'style', 'guidance']) {
      assert.ok(kinds.has(k), k);
    }
    for (const k of ['manuscriptFull', 'plotSummary', 'globalSummary', 'prevTail', 'setting']) {
      assert.ok(!kinds.has(k), k);
    }
  });

  test('帶近幾章定稿的連續性事實', () => {
    assert.ok(b.items.some((i) => i.kind === 'facts' && i.status === 'included' && i.text.includes('沈氏住進走廊盡頭的房間')));
    assert.match(lastUser(b), /# 前幾章的連續性事實（已定稿/);
  });

  test('已寫末尾就是生成鏈給的那一段', () => {
    assert.equal(b.items.find((i) => i.kind === 'chapterSoFar').text, step.tail);
    assert.match(lastUser(b), /大約再寫 500 字/);
  });

  test('恢復那一輪開頭說清「上一輪已丟棄」', () => {
    assert.match(lastUser(recovery), /已被全部丟棄/);
    assert.match(lastUser(recovery), /唯一一次無進展恢復機會/);
    assert.ok(!lastUser(b).includes('已被全部丟棄'));
  });

  test('執行卡照樣在最末', () => {
    const user = lastUser(b);
    assert.ok(user.lastIndexOf('【本章執行卡') > user.lastIndexOf('# 本章已寫正文'));
  });
});

describe('正文配方 · 早前某章定稿之後正文又改過', () => {
  let item;
  before(async () => {
    const ch1 = path.join(t.dir, 'chapters/002-客栈里的女人.md');
    const backup = fs.readFileSync(ch1, 'utf8');
    fs.writeFileSync(ch1, `${backup}\n\n作者後來補的一句。\n`);
    project.invalidate();
    try {
      const b = await builderMod.buildContext(
        project,
        { action: WRITE, target: { kind: 'manuscript', plotRelPath: PLOT(5, '名冊') }, ask: '', targetWords: 1200 },
        config
      );
      item = ids(b).get(`plot:${PLOT(2, '客栈里的女人')}`);
    } finally {
      fs.writeFileSync(ch1, backup);
      project.invalidate();
    }
  });

  // 定稿過就不是計劃；但細綱是照改之前的正文更新的，明細裡要看得出它可能沒跟上。
  test('照樣帶，不標「計劃」，說明裡打 ⚠', () => {
    assert.equal(item.status, 'included');
    assert.ok(item.text.startsWith('【第 2 章《客棧裡的女人》 · 上文】\n'), item.text.slice(0, 40));
    assert.equal(item.note, '⚠ 同步之後正文又改過，這份細綱可能沒跟上');
  });
});
