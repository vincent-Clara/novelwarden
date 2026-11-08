/**
 * 設定名錄的「待完善」（views/lore.ts 的 `thin`，完善設定 · 2026-10-19）：接下來幾章要用、卻還是空的設定。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 只認沒定稿、也還沒寫正文（沒有章節檔案或 0 字）的細綱「設定」一節 | 往前看：定稿過的是往回記那一半；寫了正文的章已經寫過去了 |
 * | 沒有條目的、條目是薄的（空的 / 佔位 / 三節全是未交代 / 只有暗設）都算，寫得有內容的不算 | 作者寫了兩行就是作者認為夠了（不按字數猜） |
 * | 人名不算 | 同名錄別處 |
 * | 關鍵詞認得出條目就算那一條，名字給條目標題、分類給條目所在目錄 | 與名錄別處同一個認法 |
 * | 沒有條目的分類取「設定」一節多數票，名字取出現最多的寫法 | 「展開」時後端按它建空條目 |
 * | 要用到的章升序，按最早那一章升序，同一章按名字 | 最先要寫到的排在最前面 |
 * | 預設不算（`opts.thin` 才算），只要出現章的呼叫方不付這份錢；不改動定稿那一半 | 按需算 |
 * | 工程樹快照帶上它，一行的說明是「第 N 章起要用 · 種類」 | 工程頁「待完善」那一組照抄 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let index;

function plot(no, title, { finalized = false, lore } = {}) {
  return [
    '---',
    `no: ${no}`,
    `title: ${title}`,
    ...(finalized ? ['sourceHash: h' + no] : []),
    '---',
    '',
    `# 第${no}章 ${title}`,
    '',
    '## 關鍵事件',
    '',
    '- 有事發生',
    ...(lore === undefined ? [] : ['', '## 設定', '', lore]),
    '',
  ].join('\n');
}

function entry(title, body, keywords = []) {
  return `---\ntitle: ${title}\nkeywords: [${keywords.join(', ')}]\n---\n\n# ${title}\n\n${body}\n`;
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    lore: './src/core/views/lore.ts',
    projectView: './src/core/views/projectView.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  t = await makeTempProject(bundle.project, { prefix: 'lorethin' });
  // 條目：天機閣是空的（關鍵詞「天機」），鎮魂鍾是新建設定的佔位，閣規三節全是未交代，舊事只有暗設，青崖鎮寫得有內容。
  t.write('.novelwarden/lore/宗門/天機閣.md', entry('天機閣', '', ['天機']));
  t.write('.novelwarden/lore/法寶/鎮魂鍾.md', entry('鎮魂鍾', '（在這裡寫這條設定：它是什麼、有什麼規矩……）'));
  t.write(
    '.novelwarden/lore/規矩/閣規.md',
    entry('閣規', '## 概要\n\n（未交代）\n\n## 規則與邊界\n\n- （未交代）\n\n## 現狀\n\n（未交代）')
  );
  t.write('.novelwarden/lore/秘聞/舊事.md', entry('舊事', '## 暗設\n\n二十年前的大火是閣主放的。'));
  t.write('.novelwarden/lore/地域/青崖镇.md', entry('青崖鎮', '偏僻小鎮，鎮口設卡。'));
  t.write('.novelwarden/characters/林昭.md', '---\nname: 林昭\naliases: [阿昭]\n---\n\n# 林昭\n');

  // 第 1 章定稿過；第 2 章寫了正文沒定稿；第 3 章有章節檔案但 0 字；第 4、5 章還沒有章節檔案。
  t.write('chapters/001-雨夜.md', '# 雨夜\n\n第一章的正文。\n');
  t.write('chapters/002-客棧.md', '# 客棧\n\n第二章的正文。\n');
  t.write('chapters/003-空章.md', '');
  t.write('.novelwarden/summaries/001-雨夜.md', plot(1, '雨夜', { finalized: true, lore: '- 天機閣〔宗門〕\n- 斷魂香〔物品〕' }));
  t.write('.novelwarden/summaries/002-客棧.md', plot(2, '客棧', { lore: '- 黑市〔地域〕\n- 天機閣' }));
  t.write(
    '.novelwarden/summaries/003-空章.md',
    plot(3, '空章', { lore: '- 天機閣〔宗門〕\n- 九層樓〔建築〕\n- 林昭〔人物〕' })
  );
  t.write(
    '.novelwarden/summaries/004-登樓.md',
    plot(4, '登樓', { lore: '- 九層樓〔地標〕\n- 青崖鎮〔地域〕\n- 鎮魂鍾〔法寶〕\n- 閣規' })
  );
  t.write('.novelwarden/summaries/005-舊案.md', plot(5, '舊案', { lore: '- 九層樓〔建築〕\n- 舊事〔秘聞〕\n- 天機〔宗門〕' }));
  t.project.invalidate();

  index = await bundle.lore.buildLoreIndex(t.project, {}, { thin: true });
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

const item = (name) => index.thin.find((x) => x.name === name);

describe('待完善：認哪些', () => {
  test('按最早要用到的章升序，同一章按名字；寫得有內容的、人名、定稿過的與已經寫了正文的章都不算', () => {
    assert.deepEqual(
      index.thin.map((x) => [x.name, x.first]),
      [
        ['九層樓', 3],
        ['天機閣', 3],
        ['閣規', 4],
        ['鎮魂鍾', 4],
        ['舊事', 5],
      ]
    );
  });

  test('四種：還沒有條目 / 空的 / 佔位 / 三節全是未交代；只有暗設的明面是空的，算空的', () => {
    assert.deepEqual(
      Object.fromEntries(index.thin.map((x) => [x.name, x.kind])),
      { 九層樓: 'missing', 天機閣: 'empty', 閣規: 'untold', 鎮魂鍾: 'placeholder', 舊事: 'empty' }
    );
  });
});

describe('待完善：每一條給什麼', () => {
  test('有條目的：名字是條目標題、分類是條目所在目錄、帶路徑；關鍵詞認出來的章也算它的', () => {
    const x = item('天機閣');
    assert.equal(x.category, '宗門');
    assert.equal(x.relPath, '.novelwarden/lore/宗門/天機閣.md');
    // 第 2 章已經寫了正文、第 1 章定稿過：都不算；第 5 章寫的是關鍵詞「天機」。
    assert.deepEqual(x.chapters, [3, 5]);
    assert.equal(x.first, 3);
  });

  test('沒有條目的：分類取「設定」一節的多數票，不帶路徑', () => {
    const x = item('九層樓');
    assert.equal(x.category, '建築');
    assert.equal(x.relPath, undefined);
    assert.deepEqual(x.chapters, [3, 4, 5]);
  });

  test('「設定」一節沒寫分類、又有條目的，分類照樣是條目所在目錄', () => {
    assert.equal(item('閣規').category, '規矩');
  });
});

describe('按需算', () => {
  test('預設不算：thin 是空的', async () => {
    const plain = await bundle.lore.buildLoreIndex(t.project);
    assert.deepEqual(plain.thin, []);
  });

  test('定稿那一半不受影響：未建條目只認定稿過的「設定」一節', () => {
    assert.deepEqual(
      index.unknown.map((u) => u.name),
      ['斷魂香']
    );
    assert.equal(index.finalizedCount, 1);
  });

  test('種類的文案', () => {
    assert.deepEqual(bundle.lore.THIN_LORE_LABEL, {
      missing: '還沒有條目',
      empty: '只有一句話',
      placeholder: '只有佔位',
      untold: '三節全是未交代',
    });
  });
});

describe('工程樹快照', () => {
  test('loreThin 照名錄的順序，一行的說明是「第 N 章起要用 · 種類」，有條目的帶路徑', async () => {
    t.project.invalidate();
    const tree = await bundle.projectView.buildProjectTree(t.project);
    assert.deepEqual(
      tree.loreThin.map((x) => [x.name, x.category, x.detail]),
      [
        ['九層樓', '建築', '第 3 章起要用 · 還沒有條目'],
        ['天機閣', '宗門', '第 3 章起要用 · 只有一句話'],
        ['閣規', '規矩', '第 4 章起要用 · 三節全是未交代'],
        ['鎮魂鍾', '法寶', '第 4 章起要用 · 只有佔位'],
        ['舊事', '秘聞', '第 5 章起要用 · 只有一句話'],
      ]
    );
    const tianji = tree.loreThin.find((x) => x.name === '天機閣');
    assert.equal(tianji.relPath, '.novelwarden/lore/宗門/天機閣.md');
    assert.equal(tianji.kind, 'empty');
    assert.deepEqual(tianji.chapters, [3, 5]);
    assert.equal('relPath' in tree.loreThin[0], false);
  });
});
