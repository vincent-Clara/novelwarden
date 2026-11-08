/**
 * 「讓使用者挑一個」的清單構造（`src/core/choices.ts`）。
 *
 * 這兩份清單原先長在外掛殼的 extension.ts 裡，其中「＋N 章待讀」是算出來的：
 * 出場章（由定稿過的細綱關聯）裡章號大於卡上 `updatedThrough` 的有幾章。殼裡抄一份這種
 * 計算，遲早與工程頁上的同一行說明分叉，所以它回到了 core，並且有了這份測試。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let choices;
let t;

/** 一章：成品正文 + 一份定稿過（帶 sourceHash 與 cast）的細綱。 */
function makePlot(no, title, text, cast) {
  const n = String(no).padStart(3, '0');
  const stem = `${n}-${title}`;
  t.write(`chapters/${stem}.md`, `# ${title}\n\n${text}\n`);
  t.write(
    `.novelwarden/summaries/${stem}.md`,
    `---\nno: ${no}\ntitle: ${title}\nsourceHash: x\ncast: [${cast.join(', ')}]\n---\n\n` +
      `# 第${no}章 ${title}\n\n## 梗概\n\n略。\n\n## 出場人物\n\n${cast.join('、')}\n\n## 關鍵事件\n\n甲乙丙。\n\n## 看點\n\n略。\n`
  );
}

before(async () => {
  const bundle = loadBundle({
    host: './src/core/host.ts',
    choices: './src/core/choices.ts',
    project: './src/core/model/project.ts',
  });
  choices = bundle.choices;
  bundle.host.initHost(makeFakeHost().host);
  t = await makeTempProject(bundle.project, { prefix: 'choices' });

  makePlot(1, '楔子', '雨下了三天。', ['林昭']);
  makePlot(2, '夜訪', '門被敲響了兩次又停住。', ['林昭', '沈硯']);
  // 手寫檔案繞過了所有寫入口，快取要顯式作廢。
  t.project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir);
});

describe('plotChoices', () => {
  let list;
  before(async () => {
    list = await choices.plotChoices(t.project);
  });

  test('每章一條，按章序', () => {
    assert.deepEqual(
      list.map((c) => c.value),
      [1, 2]
    );
  });

  test('序號補零到三位——長篇下拉里才是一列', () => {
    assert.equal(list[0].label, '001 楔子');
  });

  test('說明是正文字數', () => {
    assert.match(list[0].description, /^\d+ 字$/);
  });

  // 只排了細綱、還沒寫正文的章照樣要列出來——那正是作者接下來要寫的那些。
  test('沒寫正文的章說「還沒有正文」', async () => {
    t.write('.novelwarden/summaries/003-空的.md', '## 梗概\n\n略。\n\n## 關鍵事件\n\n丁。\n');
    t.project.invalidate();
    const withEmpty = await choices.plotChoices(t.project);
    assert.equal(withEmpty.find((c) => c.value === 3).description, '還沒有正文');
  });

  test('空工程給空清單，不拋（「還沒有章」由呼叫方說）', async () => {
    const empty = await makeTempProject(loadBundle({ project: './src/core/model/project.ts' }).project, {
      prefix: 'choices-empty',
    });
    try {
      assert.deepEqual(await choices.plotChoices(empty.project), []);
    } finally {
      cleanup(empty.dir);
    }
  });
});

describe('characterChoices', () => {
  /** 一張卡：讀到第 `updatedThrough` 章為止。 */
  function makeCard(name, updatedThrough) {
    t.write(
      `.novelwarden/characters/${name}.md`,
      `---\nname: ${name}\naliases: []\ntags: [配角]\n` +
        (updatedThrough === undefined ? '' : `updatedThrough: ${updatedThrough}\n`) +
        `---\n\n# ${name}\n\n## 身份\n\n略。\n`
    );
  }

  test('value 是卡的相對路徑（updateCharacterCard 認這個）', async () => {
    makeCard('林昭', 2);
    const list = await choices.characterChoices(t.project);
    const zhao = list.find((c) => c.label === '林昭');
    assert.equal(zhao.value, '.novelwarden/characters/林昭.md');
  });

  test('讀全了就不掛「待讀」', async () => {
    t.project.invalidate();
    const list = await choices.characterChoices(t.project);
    assert.equal(list.find((c) => c.label === '林昭').description, undefined);
  });

  test('落後幾章就掛「＋N 章待讀」', async () => {
    makeCard('沈硯', 1); // 出場在第 2 章，只讀到第 1 章
    t.project.invalidate();
    const list = await choices.characterChoices(t.project);
    assert.equal(list.find((c) => c.label === '沈硯').description, '＋1 章待讀');
  });

  test('沒在任何定稿裡出現過的卡：不掛待讀，detail 說「未在定稿中出現」', async () => {
    // 從沒更新過（無 updatedThrough）也不該憑空催人——出場 0 段就是待讀 0 段。
    makeCard('無名', undefined);
    t.project.invalidate();
    const list = await choices.characterChoices(t.project);
    const anon = list.find((c) => c.label === '無名');
    assert.equal(anon.description, undefined);
    assert.equal(anon.detail, '未在同步過的章裡出現');
  });

  test('detail 是出場章的人話描述', async () => {
    t.project.invalidate();
    const list = await choices.characterChoices(t.project);
    assert.equal(list.find((c) => c.label === '林昭').detail, '第 1、2 章');
  });

  test('沒有角色卡時給空清單', async () => {
    const empty = await makeTempProject(loadBundle({ project: './src/core/model/project.ts' }).project, {
      prefix: 'choices-nocard',
    });
    try {
      assert.deepEqual(await choices.characterChoices(empty.project), []);
    } finally {
      cleanup(empty.dir);
    }
  });
});
