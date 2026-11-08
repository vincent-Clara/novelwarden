/**
 * 內建編輯器怎麼稱呼一份檔案（`views/editorLabel.ts`）：標籤上的型別短標記與名字、工具欄上的麵包屑。
 * 規則只在後端（`kindOfPath` 與章節 / 細綱的檔名規則），前端不拿路徑猜——與 `kind`、`draftPath` 同一條原則。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 同一章的正文 / 細綱 / 草稿三份短標記各不相同、名字一樣 | 從前三個標籤都只寫「003-夜訪.md」 |
 * | 麵包屑寫「第 3 章 夜訪」，分卷目錄各佔一段且可點 | 原始路徑 `.novelwarden/summaries/…` 看不懂 |
 * | 架構幾件、大綱、文風是中文稱呼 | `config.md` 在標籤上叫 config 等於沒說 |
 * | 認不出的副檔名留著 | `project.json` 去掉副檔名就認不出了 |
 * | 越界、空串不拋 | 輸入是前端傳上來的路徑 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let t;
let describeFile;

before(async () => {
  const bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    label: './src/core/views/editorLabel.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  t = await makeTempProject(bundle.project, { prefix: 'edlabel' });
  describeFile = (rel) => bundle.label.describeEditorFile(t.project, rel);
});

after(() => {
  if (t) cleanup(t.dir);
});

/** 麵包屑寫成一行字，目錄段後面標 `[dir]`。 */
const crumbs = (rel) =>
  describeFile(rel)
    .crumbs.map((c) => (c.dir !== undefined ? `${c.label}[${c.dir}]` : c.label))
    .join(' › ');

describe('editorLabel · 正文 / 細綱 / 草稿', () => {
  test('正文不帶短標記，名字去掉副檔名', () => {
    const l = describeFile('chapters/003-夜訪.md');
    assert.deepEqual({ tag: l.tag, title: l.title }, { tag: '', title: '003-夜訪' });
  });

  test('正文的麵包屑：正文 › 第 3 章 夜訪', () => {
    assert.equal(crumbs('chapters/003-夜訪.md'), '正文[chapters] › 第 3 章 夜訪');
  });

  test('分卷目錄裡的正文：卷目錄各佔一段、可點', () => {
    assert.equal(crumbs('chapters/第一卷/003-夜訪.txt'), '正文[chapters] › 第一卷[chapters/第一卷] › 第 3 章 夜訪');
    assert.equal(describeFile('chapters/第一卷/003-夜訪.txt').title, '003-夜訪');
  });

  test('細綱帶「細綱」，麵包屑從細綱根起、卷目錄照樣一段', () => {
    const l = describeFile('.novelwarden/summaries/第一卷/003-夜訪.md');
    assert.deepEqual({ tag: l.tag, title: l.title }, { tag: '細綱', title: '003-夜訪' });
    assert.equal(
      crumbs('.novelwarden/summaries/第一卷/003-夜訪.md'),
      '細綱[.novelwarden/summaries] › 第一卷[.novelwarden/summaries/第一卷] › 第 3 章 夜訪'
    );
  });

  test('草稿帶「草稿」，麵包屑同樣寫第幾章', () => {
    const l = describeFile('drafts/003-夜訪.md');
    assert.deepEqual({ tag: l.tag, title: l.title }, { tag: '草稿', title: '003-夜訪' });
    assert.equal(crumbs('drafts/003-夜訪.md'), '草稿[drafts] › 第 3 章 夜訪');
  });

  test('同一章的三份：名字一樣、短標記各不相同', () => {
    const tags = ['chapters/003-夜訪.md', '.novelwarden/summaries/003-夜訪.md', 'drafts/003-夜訪.md'].map(
      (p) => describeFile(p).tag
    );
    assert.equal(new Set(tags).size, 3, JSON.stringify(tags));
  });

  test('檔名裡沒有標題：麵包屑寫「第 N 章」', () => {
    assert.equal(crumbs('chapters/007.md'), '正文[chapters] › 第 7 章');
  });

  test('沒有副檔名的章節照樣認', () => {
    assert.equal(describeFile('chapters/012-雪夜').title, '012-雪夜');
    assert.equal(crumbs('chapters/012-雪夜'), '正文[chapters] › 第 12 章 雪夜');
  });
});

describe('editorLabel · 角色與設定', () => {
  test('角色卡：角色 › 林晚', () => {
    const l = describeFile('.novelwarden/characters/林晚.md');
    assert.deepEqual({ tag: l.tag, title: l.title }, { tag: '角色', title: '林晚' });
    assert.equal(crumbs('.novelwarden/characters/林晚.md'), '角色[.novelwarden/characters] › 林晚');
  });

  test('子目錄裡的角色卡：子目錄一段', () => {
    assert.equal(
      crumbs('.novelwarden/characters/配角/李叔.md'),
      '角色[.novelwarden/characters] › 配角[.novelwarden/characters/配角] › 李叔'
    );
  });

  test('設定條目：設定 › 地點 › 青石鎮', () => {
    const l = describeFile('.novelwarden/lore/地點/青石鎮.md');
    assert.equal(l.tag, '設定');
    assert.equal(crumbs('.novelwarden/lore/地點/青石鎮.md'), '設定[.novelwarden/lore] › 地點[.novelwarden/lore/地點] › 青石鎮');
  });
});

describe('editorLabel · 有中文稱呼的固定檔案', () => {
  test('小說配置：標籤上是中文稱呼、不帶短標記，麵包屑歸在故事架構', () => {
    const l = describeFile('.novelwarden/config.md');
    assert.deepEqual({ tag: l.tag, title: l.title }, { tag: '', title: '小說配置' });
    assert.equal(crumbs('.novelwarden/config.md'), '故事架構[.novelwarden] › 小說配置');
  });

  test('故事前提、世界觀、情節大綱', () => {
    assert.equal(describeFile('.novelwarden/premise.md').title, '故事前提');
    assert.equal(describeFile('.novelwarden/world.md').title, '世界觀');
    assert.equal(crumbs('.novelwarden/outline.md'), '故事架構[.novelwarden] › 情節大綱');
  });

  test('文風指南、全文大綱歸在文風與摘要（與工程頁、「轉到…」同一個叫法）', () => {
    assert.equal(describeFile('.novelwarden/style.md').title, '文風指南');
    assert.equal(describeFile('.novelwarden/summaries/global.md').title, '全文大綱');
  });

  test('敘事線一條線一個檔案：標籤是線名、短標記「敘事線」，麵包屑從敘事線目錄起', () => {
    const l = describeFile('.novelwarden/threads/林昭與沈青.md');
    assert.deepEqual({ tag: l.tag, title: l.title }, { tag: '敘事線', title: '林昭與沈青' });
    assert.equal(crumbs('.novelwarden/threads/林昭與沈青.md'), '敘事線[.novelwarden/threads] › 林昭與沈青');
    assert.equal(describeFile('.novelwarden/threads.md').title, 'threads.md', '七期的單檔案是 other');
  });

  test('敏感詞表（寫作體檢用）也是中文稱呼、歸在文風與摘要', () => {
    const l = describeFile('.novelwarden/sensitive.txt');
    assert.deepEqual({ tag: l.tag, title: l.title }, { tag: '', title: '敏感詞表' });
    assert.equal(crumbs('.novelwarden/sensitive.txt'), '文風與摘要[.novelwarden] › 敏感詞表');
  });
});

describe('editorLabel · 其他檔案', () => {
  test('寫作技能：SKILL.md 叫技能目錄的名字', () => {
    const l = describeFile('.novelwarden/skills/快節奏/SKILL.md');
    assert.deepEqual({ tag: l.tag, title: l.title }, { tag: '技能', title: '快節奏' });
  });

  test('認不出的檔案：原檔名、副檔名留著、目錄一段一段', () => {
    const l = describeFile('.novelwarden/project.json');
    assert.deepEqual({ tag: l.tag, title: l.title }, { tag: '', title: 'project.json' });
    assert.equal(crumbs('.novelwarden/project.json'), '.novelwarden[.novelwarden] › project.json');
  });

  test('工程根下的隨手檔案只有一段', () => {
    assert.equal(crumbs('notes.txt'), 'notes.txt');
  });

  test('越界、空串不拋', () => {
    assert.doesNotThrow(() => describeFile('../外面.md'));
    assert.doesNotThrow(() => describeFile(''));
  });
});

test('固定保留檔案顯示繁體，路徑與作者自訂的線名不轉換', () => {
  assert.equal(describeFile('.novelwarden/threads/未归属的伏笔.md').title, '未歸屬的伏筆');
  assert.equal(describeFile('.novelwarden/threads/时间线.md').title, '時間線');
  assert.equal(describeFile('.novelwarden/threads/主线.md').title, '主线');
});
