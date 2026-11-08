/**
 * 產物解析的三層降級 + 各條採納落盤路徑。
 *
 * 這一層最貴的失敗方式不是崩潰，而是**靜默寫錯地方或靜默覆蓋**——
 * 採納細綱把手寫的那份頂掉、生成角色圖譜把作者改得很細的角色卡抹掉。
 * 所以這裡的重點不是「能不能寫進去」，而是「不該寫的時候有沒有攔住」。
 *
 * 一章一綱之後的五條採納分支（`generation/accept.ts`）：
 *
 * | 產物 | 落點 | 已有內容時 |
 * |---|---|---|
 * | 小說配置 / 前提 / 世界觀 | `config.md` / `premise.md` / `world.md` | 覆蓋前審閱；配置的 frontmatter 合併 |
 * | 角色圖譜 | `characters/` 下每人一張卡 | **同名跳過**，絕不覆蓋，也就不必審閱 |
 * | 情節大綱 | `outline.md` | 覆蓋前審閱 |
 * | 細綱 | `summaries/NNN-標題.md` | 覆蓋前審閱；七節換新，標題 / 目標字數 / 定稿記的 sourceHash 與 cast 沿用磁碟那份 |
 * | 正文 | 同號的 `chapters/NNN-標題.txt` | **追加**；落盤後在細綱上記 `writtenFrom` |
 *
 * 落盤的守衛在 `workspace/`，這裡測的是分派與那幾條取捨。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');
const { writeOutline } = require('../../helpers/outline');

let bundle;
let A;
let plotFile;
let h;
let t;
let project;
/** `accept(target, artifact)`——綁好 project 的採納入口。 */
let accept;

/** 按區間分節的大綱：細綱的上游指紋記的是覆蓋本章的那一節。 */
const OUTLINE = '# 青雲劍錄 · 情節大綱\n\n## 第1–20章：第一幕 · 入局\n\n林昭進青雲宗，藏書閣裡有人在等他。\n';

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    artifact: './src/core/features/artifact.ts',
    accept: './src/core/generation/accept.ts',
    plotFile: './src/core/model/plotFile.ts',
    outlineFile: './src/core/model/outlineFile.ts',
    pipe: './src/core/views/pipeline.ts',
  });
  A = bundle.artifact;
  plotFile = bundle.plotFile;
  // 假宿主**沒有** reviewReplace，於是覆蓋審閱走 confirm 那條分支。
  // helper 預設帶 reviewReplace，不摘掉的話「保留原樣」這條路根本走不到。
  h = makeFakeHost({ settings: () => ({}), overrides: { reviewReplace: undefined } });
  bundle.host.initHost(h.host);
  t = await makeTempProject(bundle.project, {
    prefix: 'creation',
    title: '青雲劍錄',
    keepExamples: true,
  });
  project = t.project;
  writeOutline(t, OUTLINE);
  project.invalidate();
  accept = (target, artifact, opts) => bundle.accept.acceptArtifact(project, target, artifact, opts);
});

after(() => {
  if (t) cleanup(t.dir);
});

/** 排過的細綱七節（計劃時「連續性事實」空著，幾節可以不寫）。關鍵事件一條一行，與定稿的寫法一樣。 */
const SECTIONS = {
  梗概: '林昭進入青雲宗',
  出场人物: '林昭、沈青',
  时间地点: '',
  关键事件: '- 他在山門外踩點，失手驚動守衛，翻牆進了後院。\n- 收在藏書閣門口。',
  看点: '藏書閣裡亮著一盞燈。',
  状态变更: '',
  连续性事实: '',
};

const settingT = (doc) => ({ kind: 'setting', doc });

// ================================================================ 產物解析

describe('artifact.ts · 細綱三層降級', () => {
  const act = { stage: 'plot', capability: 'generate' };
  let json;
  let english;
  let wrapped;
  let md;
  let plain;
  let irrelevant;

  before(() => {
    json = A.parseArtifact(act, JSON.stringify({
      title: '夜入青雲',
      targetWords: 3000,
      ...SECTIONS,
    }));
    // 藍圖合同用的是英文鍵；`characters` 寫成一個串、字數寫成字串也得認。
    english = A.parseArtifact(act, JSON.stringify({
      title: '林昭在暴雨的深夜翻越青雲宗的側峰圍牆並且成功進入了藏書閣',
      synopsis: '進宗門',
      keyEvents: ['踩點', '翻牆'],
      highlights: ['門後有人'],
      characters: '林昭，沈青',
      targetWords: '3000',
    }));
    // 單章也用批次合同的單項形式（第 22 條）：`{"blueprints":[{…}]}` 取裡面那一項。
    // 關鍵事件給成一段字（老合同的形狀）也照收，與批次一樣按分號切成條。
    wrapped = A.parseArtifact(act, JSON.stringify({
      blueprints: [{ chapterNumber: 12, title: '夜入青雲', synopsis: '進宗門', characters: ['林昭', '沈青'], keyEvents: '踩點；翻牆' }],
    }));
    // 模型忘了 JSON，改回 Markdown 小節——這是最常見的不聽話方式。
    md = A.parseArtifact(act, '## 梗概\n\n林昭進入青雲宗\n\n## 關鍵事件\n\n踩點、失手、翻牆');
    // 什麼結構都沒有：全文塞進主欄位，好過整次生成作廢。
    plain = A.parseArtifact(act, '這一章講林昭翻牆進宗門。');
    // 語法合法但完全不相干的 JSON 不能認下來——認了會得到一份空細綱**且不再降級**。
    irrelevant = A.parseArtifact(act, '{"text":"林昭翻牆進宗門"}');
  });

  test('第一層 JSON', () => {
    assert.equal(json.kind, 'plot');
    assert.equal(json.sections.梗概, '林昭進入青雲宗');
  });

  test('JSON 七節都收下', () => {
    assert.equal(json.sections.看点, '藏書閣裡亮著一盞燈。');
    assert.equal(json.sections.关键事件, SECTIONS.关键事件);
  });

  test('JSON 帶的規劃欄位也收下', () => {
    assert.equal(json.title, '夜入青雲');
    assert.equal(json.targetWords, 3000);
  });

  // 關鍵事件是一條一件事的列表，落盤成 `- 一條` 一行（與定稿寫法一致）。
  test('英文鍵也認，關鍵事件陣列落成一條一行', () => {
    assert.equal(english.sections.梗概, '進宗門');
    assert.equal(english.sections.关键事件, '- 踩點\n- 翻牆');
  });

  // 看點是一條一句的列表，落盤成 `- 一條` 一行（與定稿寫法一致）。
  test('看點陣列落成一條一行', () => {
    assert.equal(english.sections.看点, '- 門後有人');
  });

  // 出場人物是一行名單（「林昭、沈青」），不是一條一行的列表——與藍圖落盤的樣子一致。
  test('寫成一個串的出場人物拆開後落成一行名單', () => {
    assert.equal(english.sections.出场人物, '林昭、沈青');
  });

  test('批次合同的單項形式也認；一段字的關鍵事件按分號切成一條一行', () => {
    assert.equal(wrapped.title, '夜入青雲');
    assert.equal(wrapped.sections.出场人物, '林昭、沈青');
    assert.equal(wrapped.sections.关键事件, '- 踩點\n- 翻牆');
  });

  test('字串的目標字數轉成數字', () => {
    assert.equal(english.targetWords, 3000);
  });

  // 標題會變成檔名（`012-<標題>.md`），而模型很愛把一整句梗概當標題。
  test('過長的標題被收口', () => {
    assert.ok(english.title.length <= 18, english.title);
  });

  test('第二層 Markdown 小節', () => {
    assert.equal(md.sections.梗概, '林昭進入青雲宗');
    assert.equal(md.sections.关键事件, '踩點、失手、翻牆');
  });

  // 兜底落「關鍵事件」而不是「梗概」：isPlotFilled 只看關鍵事件，兜底進別的
  // 那一節的話，這一章採納後會顯示成「還沒排細綱」的空殼。
  test('第三層全文兜底進關鍵事件', () => {
    assert.equal(plain.sections.关键事件, '這一章講林昭翻牆進宗門。');
  });

  test('兜底進去的細綱算「排過」', () => {
    assert.ok(plotFile.isPlotFilled(plain.sections), JSON.stringify(plain.sections));
  });

  // 嚴格解析不做全文兜底。批次路徑（工程頁一次給幾十章寫細綱）用它：
  // 那裡沒有人逐份過目，兜底會把模型的一句「我不太確定」變成一份「已規劃」
  // 的細綱，緊接著的批次寫正文還會照著它寫出一整章。
  test('嚴格解析不兜底', () => {
    assert.equal(A.parsePlotStrict('這一章講林昭翻牆進宗門。'), undefined);
  });

  test('嚴格解析仍認 JSON', () => {
    assert.equal(A.parsePlotStrict('{"关键事件":"進宗門"}')?.sections.关键事件, '- 進宗門');
  });

  // Markdown 小節是作者（或不聽話的模型）寫的原文，原樣收，不切。
  test('嚴格解析仍認 Markdown 小節', () => {
    assert.equal(A.parsePlotStrict('## 關鍵事件\n\n進宗門')?.sections.关键事件, '進宗門');
  });

  test('不相干的 JSON 退到全文兜底', () => {
    assert.ok(irrelevant.sections.关键事件.includes('林昭翻牆'), JSON.stringify(irrelevant.sections));
  });

  test('程式碼塊包裹能剝掉', () => {
    assert.equal(
      A.parseArtifact(act, '```json\n{"关键事件":"進宗門"}\n```').sections.关键事件,
      '- 進宗門'
    );
  });

  test('JSON 前後的廢話不影響解析', () => {
    assert.equal(
      A.parseArtifact(act, '好的，以下是細綱：\n{"关键事件":"進宗門"}\n希望有幫助').sections.关键事件,
      '- 進宗門'
    );
  });

  // 落定與寫細綱產出的是同一種產物，走的是同一條解析路（第 22 條）。
  test('落定與寫細綱解析成同一種產物', () => {
    const settled = A.parseArtifact({ stage: 'plot', capability: 'settle' }, '{"关键事件":["進宗門"]}');
    assert.equal(settled.kind, 'plot');
    assert.equal(settled.sections.关键事件, '- 進宗門');
  });
});

/**
 * 架構四件同屬一個階段，**要看 target 才分得清是哪一件**：三件是一份文件，
 * 「角色圖譜」產出的是一組角色卡。本期是過渡版解析（JSON 同名鍵 / Markdown 小節），
 * 移植過來的合同是二期的事。
 */
describe('artifact.ts · 架構四件', () => {
  const act = { stage: 'setting', capability: 'generate' };
  let config;
  let configMd;
  let configPlain;
  let premise;
  let roster;
  let rosterMd;
  let bareRoster;

  before(() => {
    config = A.parseArtifact(act, JSON.stringify({
      genre: '武俠',
      structure: 'THREE_ACT',
      totalChapters: '30',
      wordsPerChapter: 3000,
      一句话: '一個從火裡活下來的人回到起火的地方。',
      核心梗概: '林昭回青崖鎮查七年前那場火。',
    }), settingT('config'));
    configMd = A.parseArtifact(act, '## 核心梗概\n\n回鎮查火。\n\n## 金手指\n\n一塊殘缺的令牌。', settingT('config'));
    configPlain = A.parseArtifact(act, '一個回鎮查火的故事。', settingT('config'));
    premise = A.parseArtifact(act, '## 核心衝突鏈\n\n回鎮 → 被認出 → 被盯上', settingT('premise'));
    roster = A.parseArtifact(act, JSON.stringify({
      characters: [
        { name: '林昭', role: '主角', 身份: '火場裡活下來的孤兒', aliases: '阿昭、小昭' },
        { name: '林昭', role: '重複的那一個' },
        { name: '沈青', role: '盟友', identity: '客棧老闆娘' },
      ],
    }), settingT('characters'));
    rosterMd = A.parseArtifact(act, '## 林昭（主角）\n\n火場裡活下來的孤兒。\n\n## 沈青\n\n客棧老闆娘。', settingT('characters'));
    // 模型漏掉外層鍵，直接給陣列。
    bareRoster = A.parseArtifact(act, '[{"name":"林昭"},{"name":"沈青"}]', settingT('characters'));
  });

  test('配置解析成一份架構檔案', () => {
    assert.equal(config.kind, 'settingDoc');
    assert.equal(config.doc, 'config');
  });

  test('配置的小節收下', () => {
    assert.equal(config.sections.核心梗概, '林昭回青崖鎮查七年前那場火。');
  });

  // 總章數與每章字數是整條鏈的長度錨點：大綱按它算區間，正文按它判寫夠沒有。
  test('配置的規模引數轉成數字', () => {
    assert.equal(config.config.totalChapters, 30);
    assert.equal(config.config.wordsPerChapter, 3000);
  });

  test('配置的列舉欄位不分大小寫', () => {
    assert.equal(config.config.structure, 'three_act');
  });

  test('配置的 Markdown 小節也認', () => {
    assert.equal(configMd.sections.金手指, '一塊殘缺的令牌。');
  });

  // 兜底進「核心梗概」：那是判配置「填過沒有」看的那一節。
  test('配置的全文兜底進核心梗概', () => {
    assert.equal(configPlain.sections.核心梗概, '一個回鎮查火的故事。');
  });

  test('前提按它自己的小節表解析', () => {
    assert.equal(premise.doc, 'premise');
    assert.equal(premise.sections.核心冲突链, '回鎮 → 被認出 → 被盯上');
  });

  test('沒給 target 時當作配置（架構的第一件）', () => {
    assert.equal(A.parseArtifact(act, '## 核心梗概\n\nx').doc, 'config');
  });

  test('角色圖譜解析成一組人', () => {
    assert.equal(roster.kind, 'characterRoster');
    assert.deepEqual(roster.characters.map((c) => c.name), ['林昭', '沈青']);
  });

  test('同名的只收第一個', () => {
    assert.equal(roster.characters[0].role, '主角');
  });

  test('角色的定位、別名與身份都收下', () => {
    assert.deepEqual(roster.characters[0].aliases, ['阿昭', '小昭']);
    assert.equal(roster.characters[0].sections.身份, '火場裡活下來的孤兒');
  });

  test('身份的英文鍵也認', () => {
    assert.equal(roster.characters[1].sections.身份, '客棧老闆娘');
  });

  // 模型不按 JSON 答時，能留住的就是「這個人是誰」這一段。
  test('角色圖譜的 Markdown 兜底：每個 ## 一人，括號裡的定位剝掉', () => {
    assert.deepEqual(rosterMd.characters.map((c) => c.name), ['林昭', '沈青']);
    assert.equal(rosterMd.characters[1].sections.身份, '客棧老闆娘。');
  });

  test('角色圖譜的裸陣列也認', () => {
    assert.deepEqual(bareRoster.characters.map((c) => c.name), ['林昭', '沈青']);
  });

  // 裸陣列**只有一個人**時，「第一個 `{` 到最後一個 `}`」恰好是那個人自己——當成
  // 外層物件去取陣列鍵會取到他的 `aliases`，名單就成了空的。整段以 `[` 開頭時先認陣列。
  test('裸陣列只有一個人、且帶 aliases 時也認得出來', () => {
    const one = A.parseArtifact(act, '[{"name":"林昭","aliases":["阿昭"],"role":"主角"}]', settingT('characters'));
    assert.deepEqual(one.characters.map((c) => c.name), ['林昭'], JSON.stringify(one));
  });
});

describe('artifact.ts · 空產物與描述', () => {
  test('正文原樣收下', () => {
    assert.equal(
      A.parseArtifact({ stage: 'manuscript', capability: 'generate' }, '雨下了三天。').text,
      '雨下了三天。'
    );
  });

  test('大綱原樣收下', () => {
    const a = A.parseArtifact({ stage: 'outline', capability: 'generate' }, '## 第1–20章：入局\n\n進宗門。');
    assert.equal(a.kind, 'outlineDoc');
    assert.ok(a.text.startsWith('## 第1–20章'), a.text);
  });

  test('空正文算空產物', () => {
    assert.ok(A.isArtifactEmpty({ kind: 'manuscript', text: '   ' }));
  });

  test('一個人都沒有的角色圖譜算空產物', () => {
    assert.ok(A.isArtifactEmpty({ kind: 'characterRoster', characters: [] }));
  });

  test('小節全空的架構檔案算空產物', () => {
    assert.ok(A.isArtifactEmpty({ kind: 'settingDoc', doc: 'world', sections: { 规则与漏洞: ' ' } }));
  });

  test('有內容的不算空', () => {
    assert.ok(!A.isArtifactEmpty(A.parseArtifact({ stage: 'plot', capability: 'generate' }, '{"关键事件":"x"}')));
  });

  test('細綱描述帶填了幾節', () => {
    const a = A.parseArtifact({ stage: 'plot', capability: 'generate' }, '{"梗概":"x","关键事件":"y"}');
    assert.equal(A.describeArtifact(a), '細綱 · 2/7 節');
  });

  test('架構檔案描述帶填了幾節', () => {
    assert.equal(
      A.describeArtifact({ kind: 'settingDoc', doc: 'config', sections: { 核心梗概: 'x', 金手指: 'y' } }),
      '小說配置 · 2/8 節'
    );
  });

  // 卡片上要說清「新建幾張角色卡」，而不是一句光禿禿的「確定嗎」。
  test('角色圖譜描述報人數', () => {
    assert.equal(
      A.describeArtifact({ kind: 'characterRoster', characters: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }),
      '角色圖譜 · 3 人'
    );
  });
});

// ================================================================ 採納落盤

/**
 * 配置的小節整份換新，**frontmatter 合併**：產物給了的欄位用產物的，沒給的沿用
 * 磁碟那份。作者手定的「全書 100 章」不該因為重寫一次梗概就被抹掉。
 */
describe('採納 · 小說配置（覆蓋要審閱，frontmatter 合併）', () => {
  const rel = '.novelwarden/config.md';
  const artifact = () =>
    A.parseArtifact({ stage: 'setting', capability: 'generate' }, JSON.stringify({
      genre: '武俠',
      wordsPerChapter: 3000,
      一句话: '一個從火裡活下來的人回到起火的地方。',
      核心梗概: '新寫的梗概：林昭回青崖鎮查火。',
    }), settingT('config'));
  let kept;
  let afterKept;
  let written;
  let config;

  before(async () => {
    // 作者手寫過一份：定了型別與總章數。
    t.write(rel, '---\ngenre: 玄幻\ntotalChapters: 100\n---\n\n# 小說配置\n\n## 核心梗概\n\n作者自己寫的梗概。\n');
    project.invalidate();

    h.expect('保留原樣');
    kept = await accept(settingT('config'), artifact());
    afterKept = t.read(rel);

    h.expect('覆蓋');
    written = await accept(settingT('config'), artifact());
    config = await project.readBookConfig();
  });

  test('拒絕覆蓋時不寫盤', () => {
    assert.equal(kept.skipped, true, kept.message);
    assert.ok(afterKept.includes('作者自己寫的梗概'), afterKept);
  });

  test('確認後寫回 config.md', () => {
    assert.equal(written.relPath, rel, written.message);
  });

  test('小節換成新的', () => {
    assert.equal(config.sections.核心梗概, '新寫的梗概：林昭回青崖鎮查火。');
  });

  test('產物給了的欄位用產物的', () => {
    assert.equal(config.genre, '武俠');
    assert.equal(config.wordsPerChapter, 3000);
  });

  test('產物沒給的欄位沿用磁碟那份', () => {
    assert.equal(config.totalChapters, 100);
  });

  test('填過之後狀態機認它', async () => {
    assert.equal((await project.settingFilled()).config, true);
  });
});

describe('採納 · 故事前提 / 世界觀', () => {
  let premise;
  let world;
  let filled;

  let reviewsOnBlank;

  before(async () => {
    // 初始化寫的是空模板（全是佔位）：拿它跟產物 diff 一遍沒有意義，不審閱。
    const before = h.confirms.length;
    premise = await accept(settingT('premise'), {
      kind: 'settingDoc', doc: 'premise', sections: { 核心冲突链: '回鎮 → 被認出 → 被盯上' },
    });
    world = await accept(settingT('world'), {
      kind: 'settingDoc', doc: 'world', sections: { 规则与漏洞: '過所制度：沒有過所不得進鎮。' },
    });
    reviewsOnBlank = h.confirms.length - before;
    filled = await project.settingFilled();
  });

  test('覆蓋空模板不彈審閱', () => {
    assert.equal(reviewsOnBlank, 0, `彈了 ${reviewsOnBlank} 次`);
  });

  // 作者哪怕只填了一節，再生成就要先問（第 3 條）。
  test('已有內容時再採納要先問，拒絕就一字不改', async () => {
    h.expect('保留原樣');
    const kept = await accept(settingT('premise'), {
      kind: 'settingDoc', doc: 'premise', sections: { 核心冲突链: '另一條衝突鏈' },
    });
    assert.equal(kept.skipped, true, kept.message);
    assert.ok(t.read('.novelwarden/premise.md').includes('回鎮 → 被認出'), t.read('.novelwarden/premise.md'));
  });

  test('前提寫進 premise.md', () => {
    assert.equal(premise.relPath, '.novelwarden/premise.md', premise.message);
    assert.ok(t.read('.novelwarden/premise.md').includes('回鎮 → 被認出'), t.read('.novelwarden/premise.md'));
  });

  test('世界觀寫進 world.md', () => {
    assert.equal(world.relPath, '.novelwarden/world.md', world.message);
  });

  // 空小節保留佔位：作者手改時知道該往哪填。
  test('沒給的小節留著標題', () => {
    assert.ok(t.read('.novelwarden/premise.md').includes('## 懸念骨架'), t.read('.novelwarden/premise.md'));
  });

  test('兩件都算填過了', () => {
    assert.equal(filled.premise, true);
    assert.equal(filled.world, true);
  });
});

/**
 * 角色圖譜：每人一張卡。
 *
 * - 沒有卡的人直接建：新卡沒有可覆蓋的東西，不走審閱。
 * - **同名（或別名撞上）已有卡的走覆蓋審閱，一張一審**（二期）：作者可能已經把那張卡
 *   改得很細，重新生成一次圖譜不該靜默抹掉它；同意了才換，新圖譜裡空著的節沿用舊卡。
 *   從前是一律跳過——那樣作者想重做角色圖譜時，已有的卡永遠換不掉。
 */
describe('採納 · 角色圖譜（新卡直接建，同名的先審閱）', () => {
  const MINE = '.novelwarden/characters/林昭.md';
  const handWritten = '---\nname: 林昭\naliases: [阿昭]\n---\n\n# 林昭\n\n## 身份\n\n作者改得很細的一段。\n\n## 性格\n\n作者寫的性格。\n';
  const roster = {
    kind: 'characterRoster',
    characters: [
      { name: '林昭', role: '主角', aliases: [], sections: { 身份: '模型寫的林昭' } },
      // 撞上的是已有卡的**別名**，同樣是那一張：只審一次，不另建。
      { name: '阿昭', role: '主角', aliases: [], sections: {} },
      { name: '沈青', role: '盟友', aliases: ['青姐'], sections: { 身份: '客棧老闆娘' } },
      { name: '韓七', role: '對手', aliases: [], sections: {} },
    ],
  };
  let kept;
  let keptText;
  let replaced;
  let reviewed;
  let again;
  let cards;

  before(async () => {
    t.write(MINE, handWritten);
    project.invalidate();
    // 第一次：作者在審閱裡選「保留原樣」（這個檔案的假宿主沒有 reviewReplace，
    // 審閱走 confirm）。
    h.expect('保留原樣', '保留原樣');
    kept = await accept(settingT('characters'), roster);
    keptText = t.read(MINE);
    reviewed = h.confirms.map((c) => c.message);
    // 第二次：同一份圖譜，作者同意覆蓋。
    h.expect('覆蓋', '覆蓋');
    replaced = await accept(settingT('characters'), roster);
    again = h.confirms.length;
    cards = await project.listCharacters();
  });

  test('新卡直接建，說出建了幾張', () => {
    assert.ok(kept.message.includes('新建 2 張角色卡'), kept.message);
  });

  // 第 3 條：已有的卡先給作者看 diff。別名撞上的也是這一張，一共只審它一次。
  // 別名撞上的也是這一張：一共只審它一次，不會審兩次、寫兩次。
  test('同名的卡先審閱，別名撞上的不另審一次', () => {
    assert.equal(reviewed.length, 1, JSON.stringify(reviewed));
    assert.ok(reviewed[0].includes('角色卡「林昭」'), reviewed[0]);
  });

  test('作者選保留：那張卡一個位元組都沒動，並且說出來', () => {
    assert.equal(keptText, handWritten);
    assert.ok(kept.message.includes('保留原樣的 林昭'), kept.message);
  });

  test('撞上別名的不另建一張', () => {
    assert.ok(!t.has('.novelwarden/characters/阿昭.md'));
  });

  test('新卡帶上定位、別名與身份', async () => {
    const shen = cards.find((c) => c.name === '沈青');
    assert.deepEqual(shen?.tags, ['盟友'], JSON.stringify(shen));
    assert.deepEqual(shen?.aliases, ['青姐'], JSON.stringify(shen));
    assert.equal(shen?.sections.身份, '客棧老闆娘', JSON.stringify(shen?.sections));
  });

  test('作者同意覆蓋：新圖譜裡有的節換新，空著的節沿用舊卡，別名留著', async () => {
    const lin = cards.find((c) => c.name === '林昭');
    assert.equal(lin.sections.身份, '模型寫的林昭');
    assert.equal(lin.sections.性格, '作者寫的性格。');
    assert.deepEqual(lin.aliases, ['阿昭']);
    assert.ok(replaced.message.includes('覆蓋 林昭'), replaced.message);
  });

  test('第二次不再新建（沈青、韓七已經有卡了），也不多出卡', () => {
    assert.ok(!replaced.message.includes('新建'), replaced.message);
    assert.equal(cards.length, 3, cards.map((c) => c.name).join('、'));
    assert.equal(again, 1);
  });

  test('有卡就算角色圖譜填過了', async () => {
    assert.equal((await project.settingFilled()).characters, true);
  });
});

/**
 * 拆細綱給下一章找的落點是**純序號的佔位路徑**（`summaries/012.md`）：標題要等細綱
 * 出來才定得下來。採納時按章號與產物帶的標題新建。
 */
describe('採納 · 細綱（新建：落點是佔位路徑）', () => {
  const placeholder = { kind: 'plot', plotRelPath: '.novelwarden/summaries/012.md' };
  const REL = '.novelwarden/summaries/012-夜入青雲.md';
  let result;
  let confirms;
  let plot;
  let pipe;

  before(async () => {
    h.expect();
    result = await accept(placeholder, {
      kind: 'plot',
      title: '夜入青雲',
      targetWords: 3000,
      sections: { ...SECTIONS },
    });
    confirms = h.confirms.length;
    plot = await project.readPlot(REL);
    pipe = await bundle.pipe.buildPlotPipeline(project, { no: 12, plot });
  });

  // 檔名裡的標題等這一刻才定得下來，所以落點不是 target 上那個佔位路徑。
  test('按章號與產物的標題落盤', () => {
    assert.equal(result.relPath, REL, result.message);
  });

  test('佔位路徑沒有被當成檔名', () => {
    assert.ok(!t.has(placeholder.plotRelPath));
  });

  test('訊息說的是新建', () => {
    assert.ok(result.message.includes('已新建'), result.message);
  });

  test('新建不彈審閱', () => {
    assert.equal(confirms, 0);
  });

  test('目標字數落進 frontmatter', () => {
    assert.equal(plot.targetWords, 3000);
  });

  // 沒定稿時「出場人物」寫的是計劃出場：挑角色卡、預檢用。
  test('計劃出場從「出場人物」一節讀得回來', () => {
    assert.deepEqual(plot.characters, ['林昭', '沈青']);
  });

  // 上游是這一章的梗概（大綱裡這一章那一條）：改別的章那一條不該讓這一章掛 ⟳。
  test('記下這一章梗概的指紋', () => {
    assert.equal(plot.upstreamHash, bundle.plotFile.plotSynopsisHash(plot.sections.梗概));
  });

  test('H1 是「第N章 標題」', () => {
    assert.ok(t.read(REL).includes('# 第12章 夜入青雲'), t.read(REL).slice(0, 300));
  });

  test('寫完就算排過細綱', () => {
    assert.ok(plotFile.isPlotFilled(plot.sections), JSON.stringify(plot.sections));
  });

  test('這一章的下一步是寫正文', () => {
    assert.equal(pipe.stage, 'manuscript', pipe.stage);
  });

  // 佔位路徑（`013.md`）上採納過一次，檔案已經按標題落成 `013-藏書閣.md`。再按同一個
  // 佔位路徑採納，acceptPlot 要按章號認出那一份、走覆蓋審閱——從前它認成「還沒有」，
  // 走新建那條路，writePlot 把同號那份**不經審閱**頂掉（第 3 條）。
  // 用第 13 章演示，免得後面幾組要用的第 12 章被改掉。
  test(
    '同號已有細綱時，按佔位路徑再採納一次也要先問覆蓋',
    async () => {
      await accept({ kind: 'plot', plotRelPath: '.novelwarden/summaries/013.md' }, {
        kind: 'plot', title: '藏書閣', sections: { ...SECTIONS, 关键事件: '第一版。' },
      });
      h.expect(); // 不排答案：真彈了審閱就當取消
      const second = await accept({ kind: 'plot', plotRelPath: '.novelwarden/summaries/013.md' }, {
        kind: 'plot', title: '藏書閣', sections: { ...SECTIONS, 关键事件: '第二版。' },
      });
      assert.equal(h.confirms.length, 1, `彈了 ${h.confirms.length} 次審閱：${second.message}`);
      assert.ok(t.read('.novelwarden/summaries/013-藏書閣.md').includes('第一版'), '第一版被靜默覆蓋了');
    }
  );
});

describe('採納 · 細綱（覆蓋要審閱）', () => {
  const target = { kind: 'plot', plotRelPath: '.novelwarden/summaries/012-夜入青雲.md' };
  const FINALIZED = '.novelwarden/summaries/014-定稿過.md';
  const next = {
    ...SECTIONS,
    关键事件: '改成三拍：踩點、被狗驚動、翻牆；收在藏書閣門口。',
  };
  let kept;
  let afterKept;
  let written;
  let plot;
  let same;
  let sameConfirms;
  let refinalized;

  before(async () => {
    // 已有內容且不同 → 必須問。答「保留原樣」就不能寫。
    h.expect('保留原樣');
    kept = await accept(target, { kind: 'plot', sections: next });
    afterKept = t.read(target.plotRelPath);

    // 產物帶的標題與目標字數都與磁碟不同：「重寫細綱」改的是這一章怎麼走，
    // 不該順手把作者起的名字、定的字數抹掉。
    h.expect('覆蓋');
    written = await accept(target, { kind: 'plot', title: '別的名字', targetWords: 5000, sections: next });
    plot = await project.readPlot(target.plotRelPath);

    // 一字未變時不該彈框——彈了只會讓人以為自己點錯了。
    h.expect();
    same = await accept(target, { kind: 'plot', sections: next });
    sameConfirms = h.confirms.length;

    // 一份定稿過的細綱（有 sourceHash 與 cast）被重寫。
    t.write(FINALIZED, plotFile.renderPlotFile({
      no: 14, title: '定稿過', upstreamHash: '', done: false,
      sourceHash: 'SRC14', cast: [{ name: '林昭', aliases: ['阿昭'] }], sections: { ...SECTIONS },
    }));
    project.invalidate();
    h.expect('覆蓋');
    await accept({ kind: 'plot', plotRelPath: FINALIZED }, { kind: 'plot', sections: next });
    refinalized = await project.readPlot(FINALIZED);
  });

  test('拒絕覆蓋時不寫盤', () => {
    assert.equal(kept.skipped, true, kept.message);
  });

  test('拒絕後磁碟上還是舊的', () => {
    assert.ok(!afterKept.includes('改成三拍'), afterKept);
  });

  test('確認後才寫', () => {
    assert.equal(written.relPath, target.plotRelPath, written.message);
    assert.ok(t.read(target.plotRelPath).includes('改成三拍'));
  });

  test('標題沿用磁碟那份（檔名不變）', () => {
    assert.equal(plot.title, '夜入青雲');
    assert.ok(!t.has('.novelwarden/summaries/012-別的名字.md'));
  });

  test('目標字數沿用磁碟那份', () => {
    assert.equal(plot.targetWords, 3000);
  });

  // 定稿過的章重寫細綱：定稿記的賬沿用磁碟那份——這一章不被拉回「待定稿」，正文只掛 ⟳（第 18 條）。
  test('重寫定稿過的細綱：sourceHash 沿用磁碟那份', () => {
    assert.equal(refinalized.sourceHash, 'SRC14');
  });

  test('重寫定稿過的細綱：cast 沿用磁碟那份', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(refinalized.cast)), [{ name: '林昭', aliases: ['阿昭'] }]);
  });

  test('重寫定稿過的細綱：七節照樣換新', () => {
    assert.ok(refinalized.sections.关键事件.includes('改成三拍'), refinalized.sections.关键事件);
  });

  test('內容相同不彈框直接通過', () => {
    assert.notEqual(same.skipped, true, same.message);
    assert.equal(sameConfirms, 0);
  });

  // 落定走的是同一條落盤路（`acceptPlot`），只是上游那次呼叫的提示詞不同。
  test('落定產出的細綱走同一條落盤路', async () => {
    h.expect('覆蓋');
    const r = await accept(target, { kind: 'plot', sections: { ...next, 看点: '討論裡定下的：燈滅了' } });
    assert.equal(r.relPath, target.plotRelPath, r.message);
    assert.ok(t.read(target.plotRelPath).includes('討論裡定下的'));
  });
});

/**
 * 正文落在**同號的章節**上：沒有就新建 `chapters/NNN-<細綱標題>.txt`；有了按寫法落——
 * 「接著寫」追加、其餘覆蓋（寫入前審閱）。落盤之後在細綱上記 `writtenFrom`——少了這一步，
 * 這一章會永遠顯示（或永遠不顯示）「正文與細綱對不上」。
 */
describe('採納 · 正文（落到同號章節）', () => {
  const plotRelPath = '.novelwarden/summaries/012-夜入青雲.md';
  const CHAPTER = 'chapters/012-夜入青雲.txt';
  const target = { kind: 'manuscript', plotRelPath };
  let result;
  let confirms;
  let plot;
  let entry;
  let pipe;

  before(async () => {
    h.expect();
    result = await accept(target, { kind: 'manuscript', text: '雨下了三天，青雲宗的石階泡得發白。' });
    confirms = h.confirms.length;
    plot = await project.readPlot(plotRelPath);
    entry = (await project.readManifest()).chapters.find((c) => c.order === 12);
    pipe = await bundle.pipe.buildPlotPipeline(project, { no: 12, plot });
  });

  test('正文落在同號的章節上', () => {
    assert.equal(result.relPath, CHAPTER, result.message);
  });

  test('正文確實寫進去了', () => {
    assert.ok(t.read(CHAPTER).includes('石階泡得發白'));
  });

  // 新建正文一律出 .txt（2026-10-24）：純文字不寫標題行，標題只在檔名裡。
  test('新建的章節是純文字，不帶標題行', () => {
    assert.ok(t.read(CHAPTER).startsWith('雨下了三天'), t.read(CHAPTER).slice(0, 40));
  });

  test('新建章節不彈審閱', () => {
    assert.equal(confirms, 0);
  });

  test('細綱上記下 writtenFrom = 細綱的內容指紋', () => {
    assert.equal(plot.writtenFrom, plotFile.plotContentHash(plot));
  });

  // 章節是作者的檔案：正文那一環的指紋記在細綱這一側，章節裡一筆都不記。
  test('章節裡不記任何指紋', () => {
    assert.ok(!/writtenFrom|upstreamHash/.test(t.read(CHAPTER)), t.read(CHAPTER));
  });

  test('章節進了 manifest', () => {
    assert.equal(entry?.file, CHAPTER, JSON.stringify(entry));
  });

  test('剛寫完的正文不標髒', () => {
    assert.equal(pipe.chapter.upstreamStale, false);
  });

  // 細綱定了 3000 字，寫了十幾個字——沒寫夠就留在「待寫正文」（接著寫）。
  test('沒寫夠目標字數時停在待寫正文', () => {
    assert.equal(pipe.stage, 'manuscript', pipe.stage);
    assert.ok(pipe.progress.manuscript < 1, String(pipe.progress.manuscript));
  });

  describe('接著寫一次', () => {
    let second;
    let text;
    let chapterCount;
    let confirmsAgain;

    before(async () => {
      h.expect();
      second = await accept(target, { kind: 'manuscript', text: '他數到第三盞燈才動。' }, { writeMode: 'continue' });
      confirmsAgain = h.confirms.length;
      text = t.read(CHAPTER);
      chapterCount = (await project.listChapters()).length;
    });

    // 「接著寫」不該丟掉前面那幾千字——所以是追加不是覆蓋。
    test('追加在同一章末尾，不覆蓋前一次', () => {
      assert.equal(second.relPath, CHAPTER, second.message);
      assert.ok(text.includes('石階泡得發白') && text.includes('第三盞燈'), text);
    });

    // 從前兩次追加之間插一行 `---` 當拆章的候選斷點；拆章刪了，現在只空一行。
    test('兩次之間只空一行，不插分隔線', () => {
      assert.ok(text.includes('泡得發白。\n\n他數到'), JSON.stringify(text));
      assert.ok(!/^\s*-{3,}\s*$/m.test(text), text);
    });

    test('沒有另建一章', () => {
      assert.equal(chapterCount, 1, String(chapterCount));
    });

    // 追加是唯一不走覆蓋審閱的落盤路徑——它不覆蓋任何東西。
    test('追加不彈審閱', () => {
      assert.equal(confirmsAgain, 0);
    });
  });

  describe('細綱改過 → 正文標髒 → 重寫後記新的指紋', () => {
    let stale;
    let declined;
    let stillStale;
    let rewritten;
    let fresh;
    let text;
    let asked;

    before(async () => {
      h.expect('覆蓋');
      await accept({ kind: 'plot', plotRelPath }, {
        kind: 'plot', sections: { ...SECTIONS, 关键事件: '整章推倒：他沒翻牆，是被人從正門請進去的。' },
      });
      stale = await bundle.pipe.buildPlotPipeline(project, { no: 12, plot: await project.readPlot(plotRelPath) });

      // 第一次作者在審閱裡選「保留原樣」：什麼都不改，也不記指紋。
      h.expect('保留原樣');
      declined = await accept(target, { kind: 'manuscript', text: '門開了，有人請他進去。' }, { writeMode: 'rewrite' });
      stillStale = await bundle.pipe.buildPlotPipeline(project, { no: 12, plot: await project.readPlot(plotRelPath) });

      h.expect('覆蓋');
      rewritten = await accept(target, { kind: 'manuscript', text: '門開了，有人請他進去。' }, { writeMode: 'rewrite' });
      asked = h.confirms.length;
      text = t.read(CHAPTER);
      fresh = await bundle.pipe.buildPlotPipeline(project, { no: 12, plot: await project.readPlot(plotRelPath) });
    });

    // 重寫細綱的那一步不許抹掉 writtenFrom：它對不上，正是「細綱在正文之後改過」的訊號。
    test('細綱改後正文標髒', () => {
      assert.equal(stale.chapter.upstreamStale, true, JSON.stringify(stale.chapter));
    });

    // 第 3 條：重寫吞掉的是一整章，寫入前必須先問。
    test('重寫覆蓋前先問；保留原樣就一個字不改、也不記指紋', () => {
      assert.equal(declined.skipped, true, declined.message);
      assert.equal(stillStale.chapter.upstreamStale, true);
    });

    test('答了覆蓋：整章換成新寫的，舊的不留', () => {
      assert.equal(asked, 1);
      assert.equal(rewritten.relPath, CHAPTER, rewritten.message);
      assert.ok(text.includes('門開了') && !text.includes('石階泡得發白'), text);
    });

    // 純文字的正文沒有標題行（標題在檔名裡），重寫也不憑空加一行。
    test('重寫之後照舊沒有標題行', () => {
      assert.ok(text.startsWith('門開了'), JSON.stringify(text.slice(0, 30)));
    });

    test('照著新細綱寫過之後不再標髒', () => {
      assert.equal(fresh.chapter.upstreamStale, false, JSON.stringify(fresh.chapter));
    });
  });
});

/**
 * 老工程裡只有正文、沒有細綱的章：target 上的細綱路徑是它**應該**在的位置
 * （正文的映象，`plotPathOfNo`），檔案並不存在。正文照樣落到那一章上，不憑空造細綱。
 */
describe('採納 · 正文（只有正文、沒有細綱的老章）', () => {
  const CHAPTER = 'chapters/020-舊章.md';
  let result;
  let plotPath;
  let unmarked;
  let asked;

  before(async () => {
    t.write(CHAPTER, '# 舊章\n\n作者早就寫好的。\n');
    project.invalidate();
    plotPath = await project.plotPathOfNo(20, '舊章');
    result = await accept({ kind: 'manuscript', plotRelPath: plotPath }, { kind: 'manuscript', text: '接著往下寫的一段。' }, { writeMode: 'continue' });
    // 老會話裡的 Draft 沒記寫法：寧可多問一句，也不把一整章疊到已有的後面。
    h.expect('保留原樣');
    unmarked = await accept({ kind: 'manuscript', plotRelPath: plotPath }, { kind: 'manuscript', text: '另起的一整章。' });
    asked = h.confirms.length;
  });

  test('接著寫：追加到那一章上', () => {
    assert.equal(result.relPath, CHAPTER, result.message);
    const text = t.read(CHAPTER);
    assert.ok(text.includes('作者早就寫好的') && text.includes('接著往下寫'), text);
  });

  test('沒記寫法：按覆蓋審閱，先問', () => {
    assert.equal(asked, 1);
    assert.equal(unmarked.skipped, true);
    assert.ok(!t.read(CHAPTER).includes('另起的一整章'));
  });

  test('不憑空造出一份細綱', () => {
    assert.ok(!t.has(plotPath), plotPath);
  });
});

describe('採納 · 大綱整篇替換', () => {
  let kept;
  let result;
  let outline;
  let oldFormat;

  before(async () => {
    project.invalidate();
    h.expect('保留原樣');
    kept = await accept({ kind: 'outline' }, { kind: 'outlineDoc', text: '## 第12章：入局\n不該寫進去' });
    h.expect('覆蓋');
    result = await accept({ kind: 'outline' }, { kind: 'outlineDoc', text: '## 第12章：第一幕\n林昭進宗門。' });
    project.invalidate();
    outline = await project.readOutline();
    oldFormat = await accept({ kind: 'outline' }, { kind: 'outlineDoc', text: '## 第1–20章：第一幕 · 入局\n\n- 林昭進宗門' }).catch((err) => err);
  });

  test('拒絕覆蓋時不寫盤', () => {
    assert.equal(kept.skipped, true, kept.message);
  });

  test('大綱寫回 outline.md', () => {
    assert.ok(result.relPath.endsWith('outline.md'), result.message);
  });

  // 大綱是各章細綱梗概的彙總：整篇換掉，就是換掉各章細綱的梗概。
  test('大綱內容已換', () => {
    assert.ok(outline.includes('## 第12章：第一幕\n林昭進宗門。') && !outline.includes('不該寫進去'), outline);
  });

  test('認不出章標題的（舊格式的區間分節）不寫，不把空殼刪光', async () => {
    assert.ok(oldFormat instanceof Error && /認不出「## 第N章：標題」/.test(oldFormat.message), String(oldFormat));
    project.invalidate();
    assert.equal(await project.readOutline(), outline);
  });
});

describe('採納 · 認不出是哪一章時報錯而不是亂寫', () => {
  let plotMessage = '';
  let manuscriptMessage = '';

  before(async () => {
    try {
      await accept({ kind: 'plot', plotRelPath: '.novelwarden/summaries/沒有章號.md' }, { kind: 'plot', sections: SECTIONS });
    } catch (err) {
      plotMessage = String(err.message ?? err);
    }
    try {
      await accept({ kind: 'manuscript', plotRelPath: '.novelwarden/summaries/沒有章號.md' }, { kind: 'manuscript', text: 'x' });
    } catch (err) {
      manuscriptMessage = String(err.message ?? err);
    }
  });

  test('細綱認不出章號時拋錯', () => {
    assert.ok(plotMessage.includes('認不出這份細綱的章號'), plotMessage);
  });

  test('正文認不出章號時拋錯', () => {
    assert.ok(manuscriptMessage.includes('認不出這份細綱的章號'), manuscriptMessage);
  });

  test('沒有憑空造出細綱或章節', () => {
    assert.ok(!t.has('.novelwarden/summaries/沒有章號.md'));
    assert.ok(!t.has('chapters/沒有章號.md'));
  });

  // 細綱與同號章節都不存在時：作者（或 agent 給了 `chapters/999.txt`）明確要寫這一章的
  // 正文，那就按號新建一個沒有標題的章節——不拿路徑裡的詞幹當標題（那不是作者起的），
  // 也不憑空造一份細綱；沒有細綱，writtenFrom 就無處可記，這一章永不標髒（第 18a 條）。
  test('細綱與同號章節都不存在時，按號新建章節、不造細綱', async () => {
    await accept({ kind: 'manuscript', plotRelPath: '.novelwarden/summaries/999-不存在.md' }, { kind: 'manuscript', text: '雨停了。' });
    assert.ok(t.has('chapters/999.txt'), '沒有按號新建章節');
    assert.ok(t.read('chapters/999.txt').includes('雨停了。'));
    assert.ok(!t.has('.novelwarden/summaries/999-不存在.md') && !t.has('.novelwarden/summaries/999.md'), '憑空造了細綱');
  });
});
