/**
 * 路徑 → 種類。**純函式、零 I/O、絕不拋**——它會被前端傳上來的路徑呼叫。
 *
 * 判定邏輯從前散在三處（fileOps 的 sectionOf / isPlotPath、plotFile 的
 * parsePlotFileName、chapterFile 的 parseChapterFileName），各認一半。
 * 這組用例守的是「收成一張表之後口徑一字未變」。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let project;
let kindOf;

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    kind: './src/core/workspace/kind.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  t = await makeTempProject(bundle.project, { prefix: 'wskind' });
  project = t.project;
  kindOf = (rel) => bundle.kind.kindOfPath(project, rel);
});

after(() => {
  if (t) cleanup(t.dir);
});

describe('kindOfPath · 固定單檔案', () => {
  test('outline.md 是大綱', () => {
    assert.equal(kindOf('.novelwarden/outline.md').kind, 'outline');
  });

  test('大綱帶上創作層', () => {
    assert.equal(kindOf('.novelwarden/outline.md').stage, 'outline');
  });

  test('大綱帶上創作目標', () => {
    assert.deepEqual(kindOf('.novelwarden/outline.md').target, { kind: 'outline' });
  });

  test('style.md 是文風指南', () => {
    assert.equal(kindOf('.novelwarden/style.md').kind, 'style');
  });

  // 它就躺在 summaries/ 裡，與細綱同一個目錄，必須排在細綱之前判。
  test('summaries/global.md 是全文大綱而不是某一章的細綱', () => {
    assert.equal(kindOf('.novelwarden/summaries/global.md').kind, 'globalSummary');
  });

  // 敘事線（2026-10-20 重做）：一條線一個檔案，沒有創作階段，也不是哪一層的生成目標。
  test('threads/ 這一層的 .md 是敘事線，不帶創作層與目標', () => {
    for (const rel of ['.novelwarden/threads/林昭與沈青.md', '.novelwarden/threads/未归属的伏笔.md']) {
      const k = kindOf(rel);
      assert.equal(k.kind, 'threads', rel);
      assert.equal(k.stage, undefined);
      assert.equal(k.target, undefined);
    }
  });

  // 線不分子目錄；七期的單檔案不相容：判 other，不讀、不顯示、不刪。
  test('更深一層、別的副檔名、目錄本身、七期的 threads.md 都是 other', () => {
    for (const rel of ['.novelwarden/threads/舊/林昭.md', '.novelwarden/threads/備註.txt', '.novelwarden/threads', '.novelwarden/threads.md']) {
      assert.equal(kindOf(rel).kind, 'other', rel);
    }
  });

  // 寫作技能：階段繫結與本工程的技能目錄，都在鏈外，沒有創作階段。
  test('skills.json 與 skills/ 下的檔案是技能，不帶創作層與目標', () => {
    const kinds = ['.novelwarden/skills.json', '.novelwarden/skills/去AI味/SKILL.md', '.novelwarden/skills'].map(kindOf);
    assert.deepEqual(
      kinds.map((k) => [k.kind, k.stage, k.target]),
      [
        ['skill', undefined, undefined],
        ['skill', undefined, undefined],
        ['skill', undefined, undefined],
      ]
    );
  });

  // 敏感詞表（內建編輯器的寫作體檢用）：鏈外的固定檔案，單列一種（不落 other，好存歷史版本）；別處的同名檔案不算。
  test('.novelwarden/sensitive.txt 是敏感詞表，不帶創作層與目標；別處的 sensitive.txt 是 other', () => {
    const k = kindOf('.novelwarden/sensitive.txt');
    assert.deepEqual([k.kind, k.stage, k.target, k.rel], ['sensitive', undefined, undefined, '.novelwarden/sensitive.txt']);
    assert.equal(kindOf('sensitive.txt').kind, 'other');
    assert.equal(kindOf('.novelwarden/lore/sensitive.txt').kind, 'other');
  });

  // 架構三件與大綱同級：各自是一份固定檔案，帶著「是哪一件」。
  for (const doc of ['config', 'premise', 'world']) {
    test(`${doc}.md 是架構文件，帶上 doc 與創作目標`, () => {
      const k = kindOf(`.novelwarden/${doc}.md`);
      assert.equal(k.kind, 'setting');
      assert.equal(k.doc, doc);
      assert.equal(k.stage, 'setting');
      assert.deepEqual(k.target, { kind: 'setting', doc });
    });
  }
});

describe('kindOfPath · 細綱', () => {
  test('帶標題的細綱', () => {
    assert.equal(kindOf('.novelwarden/summaries/012-入宗.md').kind, 'plot');
  });

  test('細綱帶上章號', () => {
    assert.equal(kindOf('.novelwarden/summaries/012-入宗.md').no, 12);
  });

  test('細綱的創作層是 plot', () => {
    assert.equal(kindOf('.novelwarden/summaries/012-入宗.md').stage, 'plot');
  });

  test('細綱的創作目標指回自己', () => {
    assert.deepEqual(kindOf('.novelwarden/summaries/012-入宗.md').target, {
      kind: 'plot',
      plotRelPath: '.novelwarden/summaries/012-入宗.md',
    });
  });

  // 流水線新建出來的章就是純序號名——標題要等劇情排完才定。
  test('純序號名的細綱一樣認得出', () => {
    assert.equal(kindOf('.novelwarden/summaries/012.md').kind, 'plot');
  });

  test('純序號名的細綱章號仍是 12', () => {
    assert.equal(kindOf('.novelwarden/summaries/012.md').no, 12);
  });

  // 細綱只認 markdown 家族（它是外掛自己的資料格式，與「章節不認副檔名」相反）。
  test('summaries/ 下的 .txt 不是細綱', () => {
    assert.equal(kindOf('.novelwarden/summaries/012-入宗.txt').kind, 'other');
  });

  // 細綱映象正文在章節根下的相對路徑：分卷的書，細綱就在卷目錄裡（`chapters/卷一/003-樓道.md`
  // 的細綱是 `summaries/卷一/003-樓道.md`）。各級子目錄裡數字開頭的 markdown 家族都是細綱。
  test('summaries/ 下子目錄裡的檔案也是細綱', () => {
    const k = kindOf('.novelwarden/summaries/卷一/003-樓道.md');
    assert.equal(k.kind, 'plot');
    assert.equal(k.no, 3);
    assert.deepEqual(k.target, { kind: 'plot', plotRelPath: '.novelwarden/summaries/卷一/003-樓道.md' });
  });

  test('summaries/ 根下沒有數字字首的不是細綱', () => {
    assert.equal(kindOf('.novelwarden/summaries/說明.md').kind, 'other');
  });

  test('summaries/ 子目錄裡沒有數字字首的也不是細綱', () => {
    assert.equal(kindOf('.novelwarden/summaries/卷一/global.md').kind, 'other');
  });
});

// 細綱從 plots/ 搬進了 summaries/。老工程的 plots/ 原樣留在磁碟上，程式碼不認：判成 other、不拋，
// rel 照給（目錄守衛照舊攔著它，見 guard.test.js）。
describe('kindOfPath · 老工程留下的 plots/', () => {
  for (const rel of ['.novelwarden/plots/012-入宗.md', '.novelwarden/plots/01-覺醒之日/003-樓道.md']) {
    test(`${rel} 是 other、沒有創作層與目標`, () => {
      const k = kindOf(rel);
      assert.equal(k.kind, 'other');
      assert.equal(k.stage, undefined);
      assert.equal(k.target, undefined);
      assert.equal(k.rel, rel);
    });
  }
});


// 場景那一層已經刪掉（見 core/model/pipeline.ts 的檔案頭）。老工程磁碟上那個
// 目錄還在、而且是作者的檔案——程式碼裡徹底不認它，判成 `other`：工程頁不顯示、
// 裝配器不讀、閘道器按普通文字處理。**判成 other 而不是拋錯**，因為它確實存在。
describe('kindOfPath · 老工程留下的 scenes/', () => {
  test('映象目錄下的 .md 不再是產物', () => {
    assert.equal(kindOf('.novelwarden/scenes/012-入宗/02-翻越側峰.md').kind, 'other');
  });

  test('不認它屬於哪一層', () => {
    assert.equal(kindOf('.novelwarden/scenes/012-入宗/02-翻越側峰.md').stage, undefined);
  });

  test('也不給它一個創作目標', () => {
    assert.equal(kindOf('.novelwarden/scenes/012-入宗/02-翻越側峰.md').target, undefined);
  });

  // 越界才不給 rel。它沒越界，只是不再是產物——`rel` 照給，呼叫方仍然認得出
  // 這是工程內的一個普通檔案。
  test('仍然給出規範化的相對路徑', () => {
    assert.equal(
      kindOf('.novelwarden/scenes/012-入宗/02-翻越側峰.md').rel,
      '.novelwarden/scenes/012-入宗/02-翻越側峰.md'
    );
  });
});

// 卷與中轉站兩層也刪了，老工程裡那兩個目錄同 scenes/ 一樣：判成 other、不拋。
describe('kindOfPath · 老工程留下的 volumes/ 與 manuscripts/', () => {
  for (const rel of ['.novelwarden/volumes/01-覺醒之日.md', '.novelwarden/manuscripts/012-入宗.md']) {
    test(`${rel} 是 other、沒有創作層`, () => {
      const k = kindOf(rel);
      assert.equal(k.kind, 'other');
      assert.equal(k.stage, undefined);
      assert.equal(k.rel, rel);
    });
  }
});

describe('kindOfPath · 章節（不認副檔名，AGENTS 第 9 條）', () => {
  test('chapters/ 下的 .md 是章節', () => {
    assert.equal(kindOf('chapters/012-入宗.md').kind, 'chapter');
  });

  test('章節帶上章號', () => {
    assert.equal(kindOf('chapters/012-入宗.md').no, 12);
  });

  // 第 12 章的細綱在哪要按號去 summaries/ 裡認，那一步要讀盤——這裡是純函式，不給。
  test('章節不帶創作目標', () => {
    assert.equal(kindOf('chapters/012-入宗.md').target, undefined);
  });

  test('無副檔名也是章節', () => {
    assert.equal(kindOf('chapters/012-楔子').kind, 'chapter');
  });

  test('無副檔名的章號照樣取得到', () => {
    assert.equal(kindOf('chapters/012-楔子').no, 12);
  });

  test('.txt 也是章節', () => {
    assert.equal(kindOf('chapters/第一卷/013-夜訪.txt').kind, 'chapter');
  });

  // 層級只是收納，章號只看檔名字首（AGENTS 第 8 條）。
  test('分卷子目錄裡的章號不受層級影響', () => {
    assert.equal(kindOf('chapters/第一卷/013-夜訪.txt').no, 13);
  });

  test('二進位制黑名單裡的副檔名不是章節', () => {
    assert.equal(kindOf('chapters/cover.png').kind, 'other');
  });

  test('沒有數字字首的不是章節', () => {
    assert.equal(kindOf('chapters/說明.md').kind, 'other');
  });
});

describe('kindOfPath · 角色 / 設定 / 草稿', () => {
  test('characters/ 下是角色卡', () => {
    assert.equal(kindOf('.novelwarden/characters/林昭.md').kind, 'character');
  });

  test('lore/ 下是設定條目', () => {
    assert.equal(kindOf('.novelwarden/lore/青雲宗.md').kind, 'lore');
  });

  // 完善設定（2026-10-19）：一條條目是架構那一層的單條設定目標（展開），分類目錄裡的也是；MCP 的 generate 不用特判。
  test('設定條目給出架構層與單條設定目標', () => {
    const k = kindOf('.novelwarden/lore/宗門/正道/天機閣.md');
    assert.equal(k.kind, 'lore');
    assert.equal(k.stage, 'setting');
    assert.deepEqual(k.target, { kind: 'lore', relPath: '.novelwarden/lore/宗門/正道/天機閣.md' });
  });

  test('設定區裡不是 .md 的不是目標', () => {
    const k = kindOf('.novelwarden/lore/宗門/天機閣.txt');
    assert.equal(k.kind, 'other');
    assert.equal(k.target, undefined);
  });

  // 角色/設定區不跟著章節放寬副檔名，仍然只認 .md。
  test('角色區的 .txt 不是角色卡', () => {
    assert.equal(kindOf('.novelwarden/characters/林昭.txt').kind, 'other');
  });

  test('drafts/ 下是草稿', () => {
    assert.equal(kindOf('drafts/012-入宗.md').kind, 'draft');
  });
});

describe('kindOfPath · 越界一律 other 且不拋', () => {
  const bad = ['../etc/passwd', '/abs/path', 'C:\\Windows', '', '   ', '..'];

  for (const input of bad) {
    test(`${JSON.stringify(input)} 的種類是 other`, () => {
      assert.equal(kindOf(input).kind, 'other');
    });

    test(`${JSON.stringify(input)} 的 rel 是 undefined`, () => {
      assert.equal(kindOf(input).rel, undefined);
    });
  }

  test('null / undefined 也不拋', () => {
    assert.equal(kindOf(undefined).kind, 'other');
    assert.equal(kindOf(null).kind, 'other');
  });

  test('工程內的普通檔案是 other，但有 rel', () => {
    const k = kindOf('隨手記.md');
    assert.equal(k.kind, 'other');
    assert.equal(k.rel, '隨手記.md');
  });

  // 前端傳上來的路徑可能帶反斜槓，規範化成正斜槓。
  test('反斜槓被規範化成正斜槓', () => {
    assert.equal(kindOf('.novelwarden\\summaries\\012-入宗.md').kind, 'plot');
  });
});

describe('pathOfTarget · 與 kindOfPath 往返', () => {
  const targets = [
    { kind: 'setting', doc: 'config' },
    { kind: 'setting', doc: 'premise' },
    { kind: 'setting', doc: 'world' },
    { kind: 'outline' },
    { kind: 'plot', plotRelPath: '.novelwarden/summaries/012-入宗.md' },
    { kind: 'lore', relPath: '.novelwarden/lore/宗門/天機閣.md' },
  ];

  for (const target of targets) {
    test(`${JSON.stringify(target)} 的落點能反解回同一個目標`, () => {
      const rel = bundle.kind.pathOfTarget(project, target);
      assert.deepEqual(kindOf(rel).target, target, rel);
    });
  }

  test('大綱的落點就是 outline.md', () => {
    assert.equal(bundle.kind.pathOfTarget(project, { kind: 'outline' }), '.novelwarden/outline.md');
  });

  test('細綱的落點就是它自己', () => {
    assert.equal(
      bundle.kind.pathOfTarget(project, { kind: 'plot', plotRelPath: '.novelwarden/summaries/012-入宗.md' }),
      '.novelwarden/summaries/012-入宗.md'
    );
  });

  test('角色圖譜的落點是角色目錄', () => {
    assert.equal(bundle.kind.pathOfTarget(project, { kind: 'setting', doc: 'characters' }), '.novelwarden/characters');
  });

  // 設定清單同理：它是 lore/ 下那一組條目。目錄本身不是一件可寫的產物，種類表照舊判成 other。
  test('設定清單的落點是設定目錄，目錄本身仍是 other', () => {
    assert.equal(bundle.kind.pathOfTarget(project, { kind: 'setting', doc: 'lore' }), '.novelwarden/lore');
    assert.equal(kindOf('.novelwarden/lore').kind, 'other');
  });

  // 正文落在同號的章節上，那一章在不在、叫什麼要讀盤才知道——純函式不猜，
  // 拋出來讓呼叫方改用 chapterTargetOf。
  test('正文的落點不在這裡算', () => {
    assert.throws(
      () => bundle.kind.pathOfTarget(project, { kind: 'manuscript', plotRelPath: '.novelwarden/summaries/012-入宗.md' }),
      /chapterTargetOf/
    );
  });
});
