/**
 * 編輯器「名詞補全」的名詞表（`src/core/views/nameIndex.ts`），真臨時工程。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 角色卡 | 名字、別名（名字裡括號內外各一截也算；一個字的不要）、一句話取「身份」第一句（沒寫取標籤）、路徑 |
 * | 設定條目 | 標題、關鍵詞當別名、分類就是目錄（根下是空串）、一句話取 `brief`（沒寫取正文第一句） |
 * | 未建條目 | 名錄裡定稿過的「設定」一節出現過、沒有條目的名字：建議分類、一句話取最近那一章的說明；人名、已有條目不算 |
 * | 順序 | 角色卡 → 設定條目 → 未建條目 |
 * | 卡改了會更新 | 改別名、新建一條設定、刪一張卡，表跟著變，指紋跟著變；沒變時指紋不變 |
 * | 讀盤 | 沒變的時候一份卡、一條設定、一份細綱都不讀；變了只重讀卡與條目 |
 * | 還不是小說工程 | `initialized: false`，表是空的 |
 * | controller | `requestNameIndex` 回 `nameIndex`（同一個 `requestId` 與指紋）；帶著對得上的 `have` 時不帶表 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let project;

/** 一份定稿過的細綱（有 `sourceHash`），「設定」一節照給。 */
const finalizedPlot = (no, title, lore) =>
  `---\nno: ${no}\ntitle: ${title}\nsourceHash: done${no}\n---\n\n# ${title}\n\n## 梗概\n梗概\n\n## 關鍵事件\n事件\n\n## 設定\n\n${lore}\n`;

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    names: './src/core/views/nameIndex.ts',
    controller: './src/core/controller/index.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  t = await makeTempProject(bundle.project, { prefix: 'name-index', title: '青雲劍錄' });
  project = t.project;

  t.write(
    '.novelwarden/characters/林昭.md',
    '---\nname: 林昭\naliases: [阿昭, 小林]\n---\n\n# 林昭\n\n## 身份\n青雲宗外門弟子，十七歲。父母早亡，由李叔帶大。\n'
  );
  t.write('.novelwarden/characters/配角/李叔.md', '---\ntags: [鎮上鐵匠, 長輩]\n---\n\n# 李叔\n');
  t.write('.novelwarden/characters/沈懷山.md', '---\nname: 沈懷山（老沈）\naliases: [沈, 沈先生]\n---\n\n# 沈懷山\n');
  t.write(
    '.novelwarden/lore/門派/青雲宗.md',
    '---\ntitle: 青雲宗\nkeywords: [青雲門, 宗門, 宗]\nbrief: 正道第一大宗，坐落在青雲山上\n---\n\n# 青雲宗\n'
  );
  t.write('.novelwarden/lore/地點/青崖镇.md', '# 青崖鎮\n\n## 概要\n\n青雲山腳下的小鎮。鎮上多鐵匠。\n');
  t.write('.novelwarden/lore/天書.md', '---\ntitle: 天書\n---\n\n# 天書\n');

  // 兩章定稿過的細綱：黑水河沒有條目（未建），青雲宗有，林昭是人（不算設定）。
  t.write('chapters/001-楔子.md', '# 楔子\n\n雨下了三天。');
  t.write(
    '.novelwarden/summaries/001-楔子.md',
    finalizedPlot(1, '楔子', '- 黑水河〔地點〕：鎮外那條終年發黑的河\n- 青雲宗〔門派〕：收徒\n- 林昭〔人物〕：主角')
  );
  t.write('chapters/002-入鎮.md', '# 入鎮\n\n他走進鎮子。');
  t.write('.novelwarden/summaries/002-入鎮.md', finalizedPlot(2, '入鎮', '- 黑水河〔地點〕：河上起了霧\n- 照骨鏡〔物品〕'));
  project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle.db);
});

describe('views/nameIndex › 名詞表', () => {
  let index;
  const byName = (name) => index.names.find((n) => n.name === name);
  before(async () => {
    index = await bundle.names.buildNameIndex(project);
  });

  test('是小說工程', () => {
    assert.equal(index.initialized, true);
  });

  test('角色卡：名字、別名、來源、型別空串、一句話取「身份」第一句、路徑', () => {
    assert.deepEqual(byName('林昭'), {
      name: '林昭',
      aliases: ['阿昭', '小林'],
      source: 'character',
      category: '',
      brief: '青雲宗外門弟子，十七歲。',
      path: '.novelwarden/characters/林昭.md',
    });
  });

  test('沒寫「身份」的卡：一句話取標籤', () => {
    assert.equal(byName('李叔').brief, '鎮上鐵匠、長輩');
    assert.equal(byName('李叔').path, '.novelwarden/characters/配角/李叔.md');
  });

  test('名字裡括號內外各一截都當別名；一個字的別名不要', () => {
    assert.deepEqual(byName('沈懷山（老沈）').aliases, ['沈懷山', '老沈', '沈先生']);
  });

  test('設定條目：關鍵詞當別名（一個字的不要）、分類就是目錄、一句話取 brief', () => {
    assert.deepEqual(byName('青雲宗'), {
      name: '青雲宗',
      aliases: ['青雲門', '宗門'],
      source: 'lore',
      category: '門派',
      brief: '正道第一大宗，坐落在青雲山上',
      path: '.novelwarden/lore/門派/青雲宗.md',
    });
  });

  test('沒寫 brief 的條目取正文第一句；根目錄下的條目分類是空串', () => {
    assert.equal(byName('青崖鎮').brief, '青雲山腳下的小鎮。');
    assert.equal(byName('青崖鎮').category, '地點');
    assert.equal(byName('天書').category, '');
    assert.equal(byName('天書').brief, '');
  });

  test('未建條目：建議的分類、一句話取最近那一章的說明、沒有路徑與別名', () => {
    assert.deepEqual(byName('黑水河'), { name: '黑水河', aliases: [], source: 'unfiled', category: '地點', brief: '河上起了霧' });
  });

  test('只出現、沒說明的未建條目一句話是空串', () => {
    assert.equal(byName('照骨鏡').brief, '');
    assert.equal(byName('照骨鏡').category, '物品');
  });

  test('「設定」一節裡的人名、已有條目不算未建條目', () => {
    assert.deepEqual(
      index.names.filter((n) => n.source === 'unfiled').map((n) => n.name).sort(),
      ['照骨鏡', '黑水河']
    );
  });

  test('順序：角色卡（按名字）→ 設定條目 → 未建條目', () => {
    assert.deepEqual(
      index.names.map((n) => n.source),
      ['character', 'character', 'character', 'lore', 'lore', 'lore', 'unfiled', 'unfiled']
    );
  });
});

describe('views/nameIndex › 卡改了會更新', () => {
  test('沒變時指紋不變', async () => {
    const a = bundle.names.nameIndexSig(await bundle.names.buildNameIndex(project));
    const b = bundle.names.nameIndexSig(await bundle.names.buildNameIndex(project));
    assert.equal(a, b);
  });

  test('改了一張卡的別名：表裡換成新的，指紋跟著變', async () => {
    const before = bundle.names.nameIndexSig(await bundle.names.buildNameIndex(project));
    t.write(
      '.novelwarden/characters/林昭.md',
      '---\nname: 林昭\naliases: [阿昭, 小林, 林師兄]\n---\n\n# 林昭\n\n## 身份\n青雲宗外門弟子，十七歲。父母早亡，由李叔帶大。\n'
    );
    const index = await bundle.names.buildNameIndex(project);
    assert.deepEqual(index.names.find((n) => n.name === '林昭').aliases, ['阿昭', '小林', '林師兄']);
    assert.notEqual(bundle.names.nameIndexSig(index), before);
  });

  test('新建一條設定：表裡有了', async () => {
    t.write('.novelwarden/lore/物品/照骨鏡.md', '---\ntitle: 照骨鏡\nbrief: 照得出人骨相的銅鏡\n---\n\n# 照骨鏡\n');
    project.invalidate();
    const index = await bundle.names.buildNameIndex(project);
    const entry = index.names.find((n) => n.name === '照骨鏡');
    assert.equal(entry.source, 'lore', '建了條目就不再是未建條目');
    assert.equal(entry.category, '物品');
    assert.equal(index.names.filter((n) => n.name === '照骨鏡').length, 1);
  });

  test('刪掉一張卡：表裡沒了', async () => {
    fs.rmSync(t.rel('.novelwarden/characters/沈懷山.md'));
    const index = await bundle.names.buildNameIndex(project);
    assert.equal(index.names.some((n) => n.name.startsWith('沈懷山')), false);
  });
});

describe('views/nameIndex › 讀盤', () => {
  /** 量一次構建讀了哪些檔案（相對工程根）、各幾次。 */
  async function measure() {
    const original = fsp.readFile;
    const reads = new Map();
    fsp.readFile = async (...args) => {
      const key = path.relative(t.dir, path.resolve(String(args[0]))).replace(/\\/g, '/');
      reads.set(key, (reads.get(key) ?? 0) + 1);
      return original.apply(fsp, args);
    };
    try {
      await bundle.names.buildNameIndex(project);
    } finally {
      fsp.readFile = original;
    }
    return reads;
  }
  const zone = (reads, prefix) => [...reads.keys()].filter((f) => f.startsWith(prefix));

  test('沒變的時候：一張卡、一條設定都不讀（細綱與章節借工程上的快取，熱的時候也一份不讀）', async () => {
    await bundle.names.buildNameIndex(project);
    await Promise.all([project.listChapters(), project.listPlots()]);
    const reads = await measure();
    assert.deepEqual(
      [...zone(reads, '.novelwarden/characters/'), ...zone(reads, '.novelwarden/lore/'), ...zone(reads, '.novelwarden/summaries/'), ...zone(reads, 'chapters/')],
      []
    );
  });

  test('改了一張卡：卡與條目各重讀一次，正文一章都不讀', async () => {
    t.write('.novelwarden/characters/配角/李叔.md', '---\ntags: [鎮上鐵匠, 長輩, 話少]\n---\n\n# 李叔\n');
    const reads = await measure();
    assert.ok(reads.get('.novelwarden/characters/配角/李叔.md') === 1);
    assert.deepEqual([...reads].filter(([, n]) => n > 1).map(([f]) => f), []);
    assert.deepEqual(zone(reads, 'chapters/'), []);
  });
});

describe('views/nameIndex › 還不是小說工程', () => {
  test('initialized: false，表是空的', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novelwarden-name-index-bare-'));
    try {
      fs.mkdirSync(path.join(dir, '.novelwarden', 'characters'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.novelwarden', 'characters', '林昭.md'), '# 林昭\n');
      const bare = bundle.project.NovelProject.open(dir);
      assert.deepEqual(await bundle.names.buildNameIndex(bare), { initialized: false, names: [] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('controller › requestNameIndex', () => {
  let controller;
  const posted = [];
  before(() => {
    controller = new bundle.controller.ChatController(project);
    controller.attach({ kind: 'sidebar', post: (m) => posted.push(m), reveal() {} });
  });
  after(() => controller.dispose());

  test('回 nameIndex：同一個 requestId、帶指紋與整張表', async () => {
    await controller.handle({ type: 'requestNameIndex', requestId: 'nm-1' });
    const reply = posted.find((m) => m.type === 'nameIndex' && m.requestId === 'nm-1');
    assert.ok(reply, JSON.stringify(posted.map((m) => m.type)));
    assert.equal(typeof reply.sig, 'string');
    assert.ok(reply.index.names.some((n) => n.name === '林昭'));
  });

  test('帶著對得上的 have：只回指紋、不帶表', async () => {
    const first = posted.find((m) => m.type === 'nameIndex' && m.requestId === 'nm-1');
    await controller.handle({ type: 'requestNameIndex', requestId: 'nm-2', have: first.sig });
    const reply = posted.find((m) => m.type === 'nameIndex' && m.requestId === 'nm-2');
    assert.equal(reply.sig, first.sig);
    assert.equal('index' in reply, false);
  });

  test('have 對不上（卡改過）：照發整張表', async () => {
    const first = posted.find((m) => m.type === 'nameIndex' && m.requestId === 'nm-1');
    t.write('.novelwarden/lore/天書.md', '---\ntitle: 天書\nbrief: 無字之書\n---\n\n# 天書\n');
    await controller.handle({ type: 'requestNameIndex', requestId: 'nm-3', have: first.sig });
    const reply = posted.find((m) => m.type === 'nameIndex' && m.requestId === 'nm-3');
    assert.notEqual(reply.sig, first.sig);
    assert.equal(reply.index.names.find((n) => n.name === '天書').brief, '無字之書');
  });
});
