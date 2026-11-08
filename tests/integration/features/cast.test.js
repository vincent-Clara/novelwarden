/**
 * 「誰是誰」這條鏈路：泛稱過濾、同一人聚類、出場索引、維護命令。
 * 遷自 scripts/smoke-cast.js（47 條斷言）。
 *
 * 這條鏈路是一次實戰事故的產物——定稿的出場人物裡 `方源` 與 `古月方源` 交替出現，
 * 「全部建卡」於是給同一個人建了兩張卡；與此同時 aliases 裡堆滿了 `她`、
 * `姐姐`、`少女`，其中還混進了她孿生弟弟的名字。
 *
 * 最要緊的一條斷言是**反向**的：`方源` 與 `方正` 哪怕有一條別名把他們連起來，
 * 也必須仍然是兩個人。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let naming;
let identity;
let castMod;
let markdown;
let projectMod;
let maintenance;
let wsMod;
let h;
let t;

/**
 * 給 `Workspace` 的某幾個方法記一筆再照常執行（同一個 bundle 裡的類，維護命令 new 出來的就是它）。
 * 用來證明維護命令的寫盤經閘道器（AGENTS 第 7 條），返回記下的 `[方法名, 路徑]`。
 */
async function spyWorkspace(names, fn) {
  const proto = wsMod.Workspace.prototype;
  const calls = [];
  const originals = Object.fromEntries(names.map((n) => [n, proto[n]]));
  for (const n of names) {
    proto[n] = function (rel, ...rest) {
      calls.push([n, rel]);
      return originals[n].call(this, rel, ...rest);
    };
  }
  try {
    await fn();
  } finally {
    Object.assign(proto, originals);
  }
  return calls;
}

/** 這份檔案在歷史版本裡的快照全文（`.novelwarden/history/<相對路徑>/`），新舊不論。 */
function snapshotTexts(rel) {
  const dir = t.rel('.novelwarden/history', rel);
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((n) => fs.readFileSync(`${dir}/${n}`, 'utf8')) : [];
}

/**
 * 造一份定稿過的細綱（帶 sourceHash 與 cast）。cast 用 `名(別名、別名)` 的寫法。
 *
 * 出場索引掃的是**定稿過的細綱**（`buildCastIndex` 走 `listPlots()`，只認有 sourceHash 的），
 * 不看同號正文在不在、對不對得上——那是最後一次定稿時的實際出場，比沒有強。
 */
function makePlot(no, cast, dir = t) {
  const n = String(no).padStart(3, '0');
  dir.write(
    `.novelwarden/summaries/${n}-第${no}章.md`,
    `---\nno: ${no}\ntitle: 第${no}章\nsourceHash: x\ncast: [${cast.join(', ')}]\n---\n\n` +
      `# 第${no}章 第${no}章\n\n## 梗概\n\n略。\n\n## 出場人物\n\n${cast.join('、')}\n\n## 關鍵事件\n\n甲乙丙。\n`
  );
}

function makeCard(name, aliases, extra = {}, dir = t) {
  const fm = [
    `name: ${name}`,
    `aliases: [${aliases.join(', ')}]`,
    'tags: [配角]',
    ...Object.entries(extra).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`),
  ].join('\n');
  dir.write(
    `.novelwarden/characters/${name}.md`,
    `---\n${fm}\n---\n\n# ${name}\n\n## 身份\n\n作者手寫的這一段一個字都不許動。\n`
  );
}

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    naming: './src/core/model/naming.ts',
    identity: './src/core/model/identity.ts',
    cast: './src/core/views/cast.ts',
    markdown: './src/core/model/markdown.ts',
    project: './src/core/model/project.ts',
    maintenance: './src/core/features/characterMaintenance.ts',
    ws: './src/core/workspace/index.ts',
  });
  ({ naming, identity, cast: castMod, markdown, project: projectMod, maintenance, ws: wsMod } = bundle);

  // 原指令碼的假宿主沒有 reviewReplace，摘掉它才與原行為一致。
  h = makeFakeHost({
    settings: () => ({ providers: [], models: [], concurrency: 1 }),
    overrides: { reviewReplace: undefined },
  });
  bundle.host.initHost(h.host);

  // 原指令碼從不 initialize()，隻手寫一份 project.md，再用**建構函式**開工程。
  t = makeTempDir('cast');
});

after(() => {
  if (t) cleanup(t.dir);
});

// ================================================================ 泛稱過濾

describe('別名：什麼算專屬稱呼', () => {
  let keptGeneric;
  let droppedProper;
  let sanitized;
  let dropped;

  before(() => {
    const generic = ['她', '姐姐', '少女', '丫頭', '小姐', '公子', '學妹', '小丫頭', '臭丫頭',
      '這位小姐', '此女', '本屆狀元', '滿身血跡的少女', '好運的小丫頭', '小崽子', '小狼崽子',
      '少女新人', '中年男人', '舅父', '心腹之士'];
    const proper = ['方老魔女', '魔頭', '古月方源', '魔道巨擘', '方源妹子', '赤城少爺',
      '賈公子', '甘德·奧塔', '店小二', '家老', '房東', '族長'];
    keptGeneric = generic.filter((w) => !naming.isGenericAppellation(w));
    droppedProper = proper.filter((w) => naming.isGenericAppellation(w));
    sanitized = naming.sanitizeAliases(['方老魔女', '姐姐', '方源', '她', '方老魔女', '古月方源'], '方源');
    dropped = naming.explainDroppedAliases(['姐姐', '她', '滿身血跡的少女'], '方源');
  });

  test('泛稱一個不留', () => {
    assert.equal(keptGeneric.length, 0, keptGeneric.join('、'));
  });

  test('專屬稱呼一個不丟', () => {
    assert.equal(droppedProper.length, 0, droppedProper.join('、'));
  });

  // 以泛稱當正式名的角色確實存在（店小二、家老、房東），過濾只對別名生效。
  test('sanitizeAliases 去泛稱、去本名、去重', () => {
    assert.deepEqual(sanitized, ['方老魔女', '古月方源']);
  });

  test('說得出為什麼丟', () => {
    assert.equal(dropped.length, 3, JSON.stringify(dropped));
    assert.ok(dropped.every((d) => d.reason.length > 0), JSON.stringify(dropped));
  });
});

// ================================================================ 同一人聚類

describe('聚類：同一人 / 兩個人', () => {
  let sameMan;
  let twins;
  let oneVote;
  let twoVotes;
  let genericAlias;

  before(() => {
    // 同一個人兩種寫法交替出現——這正是當初一人兩卡的成因。
    sameMan = identity.buildIdentityGroups([
      { order: 1, cast: [{ name: '方源', aliases: ['古月方源', '方老魔女'] }] },
      { order: 2, cast: [{ name: '古月方源', aliases: ['方源'] }] },
      { order: 3, cast: [{ name: '古月方源', aliases: [] }] },
    ]);

    // ★ 迴歸：模型幻覺把孿生姐弟連起來，同章共現必須把它攔下。
    twins = identity.buildIdentityGroups([
      { order: 1, cast: [{ name: '方源', aliases: [] }, { name: '方正', aliases: [] }] },
      { order: 2, cast: [{ name: '方源', aliases: [] }, { name: '方正', aliases: [] }] },
      { order: 3, cast: [{ name: '方源', aliases: ['方正'] }] },
    ]);

    // 從沒共現過，但兩邊戲份都重、只有一章說他們是同一人 → 證據不足。
    const chapters = [];
    for (let i = 1; i <= 3; i++) chapters.push({ order: i, cast: [{ name: '甲', aliases: [] }] });
    for (let i = 4; i <= 6; i++) chapters.push({ order: i, cast: [{ name: '乙', aliases: [] }] });
    chapters.push({ order: 7, cast: [{ name: '甲', aliases: ['乙'] }] });
    oneVote = identity.buildIdentityGroups(chapters);
    // 補一票就夠了：兩章都這麼說，那就是同一個人。
    chapters.push({ order: 8, cast: [{ name: '甲', aliases: ['乙'] }] });
    twoVotes = identity.buildIdentityGroups(chapters);

    // 泛稱不能當判據，否則幾個女角色會被 `姐姐` 串成一個。
    genericAlias = identity.buildIdentityGroups([
      { order: 1, cast: [{ name: '甲', aliases: ['姐姐'] }] },
      { order: 2, cast: [{ name: '乙', aliases: ['姐姐'] }] },
    ]);
  });

  test('兩種寫法歸成一個人', () => {
    assert.equal(sameMan.groups.length, 1, JSON.stringify(sameMan.groups));
  });

  test('出場章節取並集', () => {
    assert.equal(sameMan.groups[0].chapters.join(','), '1,2,3');
  });

  test('展示名取領銜最多的寫法', () => {
    assert.equal(sameMan.groups[0].primary, '古月方源', sameMan.groups[0].primary);
  });

  test('同章共現的兩人絕不合併', () => {
    assert.equal(twins.groups.length, 2, JSON.stringify(twins.groups.map((g) => g.names)));
  });

  test('攔下的連結說得出理由', () => {
    assert.ok(
      twins.rejected.some((r) => r.reason.includes('同一章')),
      JSON.stringify(twins.rejected)
    );
  });

  test('areDifferent 認得出這兩人', () => {
    assert.equal(twins.areDifferent('方源', '方正'), true);
  });

  test('重要角色之間單票不足以合併', () => {
    assert.equal(oneVote.groups.length, 2, JSON.stringify(oneVote.groups.map((g) => g.names)));
  });

  test('兩票就合併', () => {
    assert.equal(twoVotes.groups.length, 1);
  });

  test('泛稱別名不把兩個人串起來', () => {
    assert.equal(
      genericAlias.groups.length,
      2,
      JSON.stringify(genericAlias.groups.map((g) => g.names))
    );
  });
});

// ================================================================ 出場索引

describe('出場索引', () => {
  let fangyuan;
  let unknownNames;
  let byName;
  let conflicts2;
  let crossed;
  let conflicts3;

  before(async () => {
    t.remove('.novelwarden');
    t.write('.novelwarden/project.md', '---\ntitle: 測\n---\n\n# 測\n');
    makePlot(1, ['方源(古月方源、姐姐)', '方正']);
    makePlot(2, ['古月方源(方源)', '方正']);
    makePlot(3, ['古月方源']);
    const project = new projectMod.NovelProject(t.dir);

    // ---- 一張卡都沒有：兩種寫法只該冒出一個「未建卡」的人。
    let index = await castMod.buildCastIndex(project);
    fangyuan = index.unknown.filter((m) => m.name.includes('方源'));
    unknownNames = index.unknown.map((m) => m.name);

    // ---- 正式名壓過別名：方源的卡上錯掛了 `方正`，搶不走方正的章節。
    makeCard('方源', ['方老魔女', '古月方源', '方正', '姐姐']);
    makeCard('方正', []);
    project.invalidate();
    index = await castMod.buildCastIndex(project);
    const find = (n) => index.known.find((m) => m.card.name === n);
    byName = { 方正: find('方正'), 方源: find('方源') };
    conflicts2 = index.conflicts;

    // ---- 同一個人兩張卡：名字不同、別名互指，兩個方向都要報出來。
    makeCard('古月方源', ['方源']);
    project.invalidate();
    index = await castMod.buildCastIndex(project);
    conflicts3 = index.conflicts;
    crossed = index.conflicts.filter(
      (c) => (c.name === '古月方源' || c.name === '方源') && c.slugs.length >= 2
    );
  });

  test('未建卡的同一人只出現一次', () => {
    assert.equal(fangyuan.length, 1, unknownNames.join('、'));
  });

  test('出場段合到一起', () => {
    assert.ok(
      fangyuan[0] && fangyuan[0].plots.join(',') === '1,2,3',
      fangyuan[0] && fangyuan[0].plots.join(',')
    );
  });

  test('方正仍是獨立的一個人', () => {
    assert.ok(unknownNames.includes('方正'));
  });

  test('方正的段記在方正名下', () => {
    assert.equal(byName.方正.plots.join(','), '1,2', byName.方正.plots.join(','));
  });

  test('方源不多吃方正的段', () => {
    assert.equal(byName.方源.plots.join(','), '1,2,3', byName.方源.plots.join(','));
  });

  test('別名撞正式名記進 conflicts', () => {
    assert.ok(
      conflicts2.some((c) => c.name === '方正' && c.kind === 'alias'),
      JSON.stringify(conflicts2)
    );
  });

  test('一人兩卡的互指衝突被記下', () => {
    assert.equal(crossed.length, 2, JSON.stringify(conflicts3));
  });
});

/**
 * 出場統計**只認定稿過的細綱**（第 14 條）。沒定稿的細綱裡「出場人物」寫的是計劃：排細綱的模型
 * 想讓他出場，正文裡未必真寫到了——混進出場統計會汙染角色卡的出場章與語料（D13）。
 * 老工程 `summaries/` 根下的單章摘要（frontmatter `chapter:`、帶 sourceHash 與 cast）本來就是
 * 定稿留下的，照樣算。
 */
describe('出場索引 · 只認定稿過的細綱', () => {
  let d;
  let index;
  let castPlots;

  before(async () => {
    d = makeTempDir('cast-finalized');
    d.write('.novelwarden/project.md', '---\ntitle: 測\n---\n\n# 測\n');
    // 第 1 章：定稿過（新格式細綱）。
    makePlot(1, ['林昭(阿昭)', '沈氏'], d);
    // 第 2 章：還沒定稿的計劃，出場人物裡排了林昭與韓七。
    d.write(
      '.novelwarden/summaries/002-第2章.md',
      '---\nno: 2\ntitle: 第2章\n---\n\n# 第2章 第2章\n\n## 梗概\n\n略。\n\n## 出場人物\n\n林昭、韓七\n\n## 關鍵事件\n\n甲乙丙。\n'
    );
    // 第 3 章：老工程留下的單章摘要，放在 summaries/ 根下。
    d.write(
      '.novelwarden/summaries/003-第3章.md',
      '---\nchapter: 3\ntitle: 第3章\nsourceHash: y\ncast: [林昭, 李叔]\n---\n\n# 第3章 · 摘要\n\n## 梗概\n\n略。\n\n## 出場人物\n\n林昭、李叔\n'
    );
    makeCard('林昭', [], {}, d);
    const project = new projectMod.NovelProject(d.dir);
    index = await castMod.buildCastIndex(project);
    castPlots = await castMod.readCastPlots(project);
  });

  after(() => {
    if (d) cleanup(d.dir);
  });

  test('已建卡的角色只記定稿過的章', () => {
    assert.deepEqual(index.known.find((m) => m.name === '林昭')?.plots, [1, 3]);
  });

  test('只在計劃裡出場的人不進出場統計', () => {
    assert.ok(!index.unknown.some((m) => m.name === '韓七'), index.unknown.map((m) => m.name).join('、'));
  });

  test('定稿過的細綱裡沒建卡的人照樣列出來', () => {
    assert.ok(index.unknown.some((m) => m.name === '沈氏'), index.unknown.map((m) => m.name).join('、'));
  });

  test('summaries/ 根下的老摘要算定稿過的細綱', () => {
    assert.ok(index.unknown.some((m) => m.name === '李叔'), index.unknown.map((m) => m.name).join('、'));
  });

  // 上層據此決定說「沒有出場人物」還是「還沒定稿過」：計劃不算數。
  test('參與統計的細綱數不含計劃', () => {
    assert.equal(index.summaryCount, 2);
  });

  // 維護命令的聚類原料與出場索引同一個口徑。
  test('readCastPlots 也只給定稿過的章', () => {
    assert.deepEqual(castPlots.map((c) => c.order), [1, 3]);
  });
});

// ================================================================ 劇作稱謂

describe('劇作稱謂：不是名字，也不是別名', () => {
  let d;
  let index;

  before(async () => {
    // 正文裡夾著作者的筆記時，模型寫下的出場人物會是 `主角(林昭)`、光一個 `反派`。
    d = makeTempDir('cast-labels');
    d.write('.novelwarden/project.md', '---\ntitle: 測\n---\n\n# 測\n');
    makePlot(1, ['主角(林昭、阿昭)', '反派', '沈氏'], d);
    makePlot(2, ['林昭(主角)', '沈氏'], d);
    index = await castMod.buildCastIndex(new projectMod.NovelProject(d.dir));
  });

  after(() => {
    if (d) cleanup(d.dir);
  });

  test('只認整詞：稱謂是，故事裡真有人這麼叫的不是', () => {
    assert.deepEqual(
      ['主角', '反派', '男主角', '路人甲', '韓厲', '掌櫃', '頭領', '反派韓厲'].map((w) => naming.isRoleLabel(w)),
      [true, true, true, true, false, false, false, false]
    );
  });

  test('別名裡的稱謂被剔掉（帶修飾語的也算），說得出為什麼', () => {
    assert.deepEqual(naming.sanitizeAliases(['主角', '阿昭', '小反派'], '林昭'), ['阿昭']);
    assert.match(naming.explainDroppedAliases(['主角'], '林昭')[0].reason, /劇作稱謂/);
  });

  test('名字是稱謂：別名裡第一個真名升上來，稱謂交回去', () => {
    assert.deepEqual(naming.resolveRoleLabelName('反派', ['她', '韓厲', '頭領']), {
      name: '韓厲',
      aliases: ['頭領'],
      label: '反派',
    });
  });

  test('名字是稱謂、別名裡沒有真名：不是一個人', () => {
    assert.equal(naming.resolveRoleLabelName('主角', ['他']), undefined);
  });

  test('名字不是稱謂：原樣返回（泛稱當正式名的也不動）', () => {
    assert.deepEqual(naming.resolveRoleLabelName('掌櫃', ['老周']), { name: '掌櫃', aliases: ['老周'] });
  });

  test('細綱裡的 `主角(林昭)` 記到林昭頭上，光一個 `反派` 不列', () => {
    const names = index.unknown.map((m) => m.name);
    assert.ok(!names.includes('主角') && !names.includes('反派'), names.join('、'));
    assert.deepEqual(index.unknown.find((m) => m.name === '林昭')?.plots, [1, 2]);
  });
});

describe('維護：稱謂卡並進真名那張', () => {
  let d;
  let groups;
  let confirms;
  let names;
  let keeper;

  before(async () => {
    d = makeTempDir('cast-label-cards');
    d.write('.novelwarden/project.md', '---\ntitle: 測\n---\n\n# 測\n');
    // 提取角色時建出來的那一對：`反派.md` 掛著真名，戲份反而記得比真名那張多。
    makeCard('韓厲', [], { appearsIn: [3], updatedThrough: 3, firstAppear: 3, lastSeen: 3 }, d);
    makeCard('反派', ['韓厲', '頭領'], { appearsIn: [3, 4, 5], updatedThrough: 5, firstAppear: 3, lastSeen: 5 }, d);
    // 光一個稱謂、對不上任何一張真名卡：只能請作者自己改名或刪掉。
    makeCard('主角', [], {}, d);
    const project = new projectMod.NovelProject(d.dir);
    groups = await maintenance.findDuplicateCards(project);
    h.confirms.length = 0;
    h.expect('逐組處理', '保留「韓厲」');
    await maintenance.mergeDuplicateCharacterCards(project);
    confirms = [...h.confirms];
    const cards = await project.listCharacters();
    names = cards.map((c) => c.name).sort();
    keeper = cards.find((c) => c.name === '韓厲');
  });

  after(() => {
    if (d) cleanup(d.dir);
  });

  test('認出韓厲 / 反派是一組，算強證據', () => {
    assert.deepEqual(
      groups.map((g) => [g.strength, g.cards.map((c) => c.name)]),
      [['summary', ['韓厲', '反派']]]
    );
  });

  test('保留哪一張的按鈕裡真名那張排第一，哪怕稱謂卡戲份多', () => {
    const ask = confirms.find((c) => c.message.startsWith('合併'));
    assert.deepEqual(ask?.actions, ['保留「韓厲」', '保留「反派」']);
  });

  test('合併後只剩真名卡與光稱謂的那張；真名卡收下「頭領」，不收「反派」', () => {
    assert.deepEqual(names, ['主角', '韓厲']);
    assert.deepEqual(keeper.aliases, ['頭領']);
  });

  test('光稱謂的那張寫進了確認框，請作者改名或刪掉', () => {
    const first = confirms.find((c) => c.message.includes('組疑似重複'));
    assert.match(first?.detail ?? '', /「主角」的名字是劇作稱謂/);
  });
});

// ================================================================ 維護命令

describe('維護：清理別名', () => {
  let card;
  let beforeText;
  let afterText;
  let firstConfirms;
  let secondConfirms;
  let secondToasts;
  let calls;
  let snapshots;

  before(async () => {
    const project = new projectMod.NovelProject(t.dir);
    beforeText = t.read('.novelwarden/characters/方源.md');
    h.expect('清理');
    calls = await spyWorkspace(['write'], () => maintenance.cleanCharacterAliases(project));
    afterText = t.read('.novelwarden/characters/方源.md');
    snapshots = snapshotTexts('.novelwarden/characters/方源.md');
    card = (await project.listCharacters()).find((c) => c.name === '方源');
    firstConfirms = [...h.confirms];

    // ---- 已經乾淨了就別再煩作者。
    h.expect();
    await maintenance.cleanCharacterAliases(project);
    secondConfirms = [...h.confirms];
    secondToasts = [...h.toasts];
  });

  test('泛稱別名被刪', () => {
    assert.ok(!card.aliases.includes('姐姐'), card.aliases.join('、'));
  });

  test('別人的正式名被刪', () => {
    assert.ok(!card.aliases.includes('方正'), card.aliases.join('、'));
  });

  // 「古月方源」此刻也是另一張卡的正式名，同樣會被刪——那張卡是重複卡，
  // 該走合併流程解決，而合併的判據來自定稿過的細綱，不依賴這條別名。
  test('與另一張卡同名的別名也被刪', () => {
    assert.ok(!card.aliases.includes('古月方源'), card.aliases.join('、'));
  });

  test('專屬別名留著', () => {
    assert.ok(card.aliases.includes('方老魔女'), card.aliases.join('、'));
  });

  test('正文一個位元組都沒動', () => {
    assert.equal(
      afterText.slice(afterText.indexOf('# 方源')),
      beforeText.slice(beforeText.indexOf('# 方源'))
    );
  });

  test('動手前先報數', () => {
    assert.equal(firstConfirms.length, 1, JSON.stringify(firstConfirms.map((c) => c.message)));
    assert.ok(
      /個不該當別名的稱呼/.test(firstConfirms[0].message),
      JSON.stringify(firstConfirms.map((c) => c.message))
    );
  });

  test('沒得清理時不彈確認框', () => {
    assert.equal(secondConfirms.length, 0);
  });

  test('沒得清理時明說', () => {
    assert.ok(secondToasts.some((x) => x.includes('無需清理')), secondToasts.join(' | '));
  });

  // 從前直接 writeText（grep 把這份原始檔當成二進位制跳過了，上一次普查沒掃到）：不過守衛、覆蓋之前不存歷史。
  test('經閘道器寫回（第 7 條）', () => {
    assert.ok(calls.some(([n, rel]) => n === 'write' && rel === '.novelwarden/characters/方源.md'), JSON.stringify(calls));
  });

  test('清理之前的舊卡在歷史版本裡留了一份（刪掉的稱呼找得回來）', () => {
    assert.ok(snapshots.includes(beforeText), JSON.stringify(snapshots));
  });
});

describe('維護：合併重複卡', () => {
  let groups;
  let dup;
  let cards;
  let keeper;
  let inTrash;
  let index;
  let calls;

  before(async () => {
    const project = new projectMod.NovelProject(t.dir);
    groups = await maintenance.findDuplicateCards(project);
    dup = groups.find(
      (g) => g.cards.some((c) => c.name === '方源') && g.cards.some((c) => c.name === '古月方源')
    );

    h.expect('逐組處理', '保留「方源」');
    calls = await spyWorkspace(['write', 'remove'], () => maintenance.mergeDuplicateCharacterCards(project));
    cards = await project.listCharacters();
    keeper = cards.find((c) => c.name === '方源');
    inTrash =
      fs.existsSync(t.rel('.novelwarden/.trash/.novelwarden/characters/古月方源.md')) ||
      fs.existsSync(t.rel('.novelwarden/.trash/characters/古月方源.md'));
    index = await castMod.buildCastIndex(project);
  });

  test('認出方源 / 古月方源是一組', () => {
    assert.ok(!!dup, JSON.stringify(groups.map((g) => g.cards.map((c) => c.name))));
  });

  test('這一組有定稿證據（strength 是 summary）', () => {
    assert.equal(dup && dup.strength, 'summary', dup && dup.strength);
  });

  test('絕不把方源和方正列成一組', () => {
    assert.ok(
      !groups.some((g) => g.cards.some((c) => c.name === '方源') && g.cards.some((c) => c.name === '方正')),
      JSON.stringify(groups.map((g) => g.cards.map((c) => c.name)))
    );
  });

  test('被合併的卡不在角色區了', () => {
    assert.ok(!cards.some((c) => c.name === '古月方源'), cards.map((c) => c.name).join('、'));
  });

  test('搬進了回收站而不是真刪', () => {
    assert.ok(
      inTrash,
      fs.existsSync(t.rel('.novelwarden/.trash'))
        ? fs.readdirSync(t.rel('.novelwarden/.trash')).join('、')
        : '（沒有回收站）'
    );
  });

  test('保留卡吸收了別名', () => {
    assert.ok(keeper.aliases.includes('古月方源'), keeper.aliases.join('、'));
  });

  test('保留卡的正文沒被重渲染', () => {
    assert.ok(t.read('.novelwarden/characters/方源.md').includes('作者手寫的這一段一個字都不許動'));
  });

  test('保留卡經閘道器寫回、被合併的卡經閘道器刪（第 7 條）', () => {
    assert.ok(calls.some(([n, rel]) => n === 'write' && rel === '.novelwarden/characters/方源.md'), JSON.stringify(calls));
    assert.ok(calls.some(([n, rel]) => n === 'remove' && rel === '.novelwarden/characters/古月方源.md'), JSON.stringify(calls));
  });

  test('被合併的卡在回收站裡保留原相對路徑（第 6 條）', () => {
    assert.ok(fs.existsSync(t.rel('.novelwarden/.trash/.novelwarden/characters/古月方源.md')));
  });

  test('合併後不再有搶名衝突', () => {
    assert.ok(!index.conflicts.some((c) => c.kind === 'name'), JSON.stringify(index.conflicts));
  });
});

describe('「已讀到」水位線', () => {
  let groups;
  let keeper;

  before(async () => {
    // 合併進來的章節從沒被保留卡讀過，水位線必須退回它們之前，
    // 否則增量更新會整批跳過，而介面上看不出任何異常。
    // 這一對在定稿裡一次都沒出現，走的是「名字包含」那條弱提示。
    t.remove('.novelwarden/characters');
    makeCard('張三', [], { appearsIn: [10, 11], updatedThrough: 11, firstAppear: 10, lastSeen: 11 });
    makeCard('古月張三', [], { appearsIn: [4, 5], updatedThrough: 5, firstAppear: 4, lastSeen: 5 });
    const project = new projectMod.NovelProject(t.dir);
    groups = await maintenance.findDuplicateCards(project);
    h.expect('逐組處理', '保留「張三」');
    await maintenance.mergeDuplicateCharacterCards(project);
    keeper = (await project.listCharacters()).find((c) => c.name === '張三');
  });

  test('名字包含只算弱提示', () => {
    assert.ok(
      groups.length === 1 && groups[0].strength === 'naming',
      JSON.stringify(groups.map((g) => [g.strength, g.cards.map((c) => c.name)]))
    );
  });

  test('出場章節取並集', () => {
    assert.equal(keeper.appearsIn.join(','), '4,5,10,11', keeper.appearsIn.join(','));
  });

  test('水位線退回第一章沒讀過的之前', () => {
    assert.equal(keeper.updatedThrough, 3, String(keeper.updatedThrough));
  });
});

describe('同一張卡出現在兩組候選裡', () => {
  let groupCount;
  let names;
  let confirms;

  before(async () => {
    // `家老` 同時是 `學堂家老` 與 `暗堂家老` 的字尾，於是它落進兩組候選。
    // 第一組把它並掉之後，第二組輪到它時檔案已經不在了——不能因此炸掉。
    t.remove('.novelwarden/characters');
    makeCard('家老', [], { appearsIn: [1], updatedThrough: 1, firstAppear: 1, lastSeen: 1 });
    makeCard('學堂家老', [], { appearsIn: [2, 3], updatedThrough: 3, firstAppear: 2, lastSeen: 3 });
    makeCard('暗堂家老', [], { appearsIn: [4], updatedThrough: 4, firstAppear: 4, lastSeen: 4 });
    const project = new projectMod.NovelProject(t.dir);
    groupCount = (await maintenance.findDuplicateCards(project)).length;
    h.expect('逐組處理', '保留「學堂家老」');
    await maintenance.mergeDuplicateCharacterCards(project);
    names = (await project.listCharacters()).map((c) => c.name);
    confirms = [...h.confirms];
  });

  test('兩組候選都列出來', () => {
    assert.equal(groupCount, 2);
  });

  test('第一組合併成功', () => {
    assert.ok(!names.includes('家老'), names.join('、'));
  });

  test('第二組因缺卡自動跳過而非報錯', () => {
    assert.ok(names.includes('暗堂家老'), names.join('、'));
  });

  // 名字說「一次」而斷言是 2：第一次是「怎麼處理這批候選」的總確認，
  // 第二次才是逐組確認；第二組因為卡沒了根本沒彈。原樣遷移，不改斷言。
  test('只彈了一次逐組確認', () => {
    assert.equal(confirms.length, 2, JSON.stringify(confirms.map((c) => c.message)));
  });
});

describe('rewriteFrontmatter', () => {
  let out;
  let block;

  before(() => {
    const text = '---\nname: 甲\naliases: [a, b]\n---\n\n# 甲\n\n正文  兩個空格結尾  \n';
    out = markdown.rewriteFrontmatter(text, { aliases: ['a'] });
    block = markdown.rewriteFrontmatter('---\naliases:\n  - a\n  - b\n---\n\n正文\n', { aliases: ['c'] });
  });

  test('只改目標欄位', () => {
    assert.ok(out.includes('aliases: [a]') && out.includes('name: 甲'), out);
  });

  test('正文逐字保留', () => {
    assert.ok(out.endsWith('# 甲\n\n正文  兩個空格結尾  \n'), JSON.stringify(out));
  });

  test('沒有 frontmatter 時返回 undefined', () => {
    assert.equal(markdown.rewriteFrontmatter('# 甲\n\n正文\n', { aliases: [] }), undefined);
  });

  test('塊狀陣列寫法也認', () => {
    assert.ok(block.includes('aliases: [c]') && !block.includes('- a'), block);
  });
});
