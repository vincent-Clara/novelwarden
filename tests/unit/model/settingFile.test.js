/**
 * 架構層三份文件（model/settingFile.ts）：小說配置、故事前提、世界觀。
 *
 * 守的是三件事：作者手改 frontmatter 不崩（第 1 條）；模板裡的佔位不算「填過」
 * （否則主按鈕從第一天起就跳過配置）；渲染再解析回來一字不差。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

let S;
before(() => {
  S = loadModule('src/core/model/settingFile.ts');
});

const CONFIG = [
  '---',
  'genre: 玄幻',
  'subGenre: 東方玄幻',
  'audience: 男頻',
  'structure: three_act',
  'pov: third_limited',
  'totalChapters: 100',
  'wordsPerChapter: 3000',
  '---',
  '# 小說配置',
  '',
  '## 一句話',
  '少年夜渡青河。',
  '',
  '## 核心梗概',
  '林昭在青河翻船後得到一枚玉佩。',
].join('\n');

describe('parseBookConfig', () => {
  test('frontmatter 各欄位', () => {
    const c = S.parseBookConfig(CONFIG, '.novelwarden/config.md');
    assert.equal(c.genre, '玄幻');
    assert.equal(c.subGenre, '東方玄幻');
    assert.equal(c.audience, '男頻');
    assert.equal(c.structure, 'three_act');
    assert.equal(c.pov, 'third_limited');
    assert.equal(c.totalChapters, 100);
    assert.equal(c.wordsPerChapter, 3000);
  });

  test('小節按固定表抽取，缺的是空串', () => {
    const c = S.parseBookConfig(CONFIG, '.novelwarden/config.md');
    assert.equal(c.sections.一句话, '少年夜渡青河。');
    assert.equal(c.sections.核心梗概, '林昭在青河翻船後得到一枚玉佩。');
    assert.equal(c.sections.金手指, '');
  });

  test('列舉寫中文標籤也認', () => {
    const c = S.parseBookConfig('---\nstructure: 起承轉合\npov: 第一人稱\n---\n', 'x');
    assert.equal(c.structure, 'kishotenketsu');
    assert.equal(c.pov, 'first_person');
  });

  test('認不出的列舉、寫壞的數字一律退化成缺席', () => {
    const c = S.parseBookConfig(
      '---\nstructure: 隨便寫\npov: 上帝視角\ntotalChapters: 一百\nwordsPerChapter: -5\n---\n',
      'x'
    );
    assert.equal(c.structure, undefined);
    assert.equal(c.pov, undefined);
    assert.equal(c.totalChapters, undefined);
    assert.equal(c.wordsPerChapter, undefined);
  });

  test('小數與 0 不算合法章數', () => {
    const c = S.parseBookConfig('---\ntotalChapters: 0\nwordsPerChapter: 2500.5\n---\n', 'x');
    assert.equal(c.totalChapters, undefined);
    assert.equal(c.wordsPerChapter, undefined);
  });

  test('整份不是 Markdown 也不拋', () => {
    const c = S.parseBookConfig('就一句大白話', 'x');
    assert.equal(c.genre, '');
    assert.equal(c.sections.核心梗概, '');
  });
});

describe('renderBookConfig 往返', () => {
  test('渲染再解析，欄位與小節一致', () => {
    const c = S.parseBookConfig(CONFIG, 'x');
    const again = S.parseBookConfig(S.renderBookConfig(c), 'x');
    for (const k of ['genre', 'subGenre', 'audience', 'structure', 'pov', 'totalChapters', 'wordsPerChapter']) {
      assert.equal(again[k], c[k], k);
    }
    assert.deepEqual(again.sections, c.sections);
  });

  test('空字串欄位也寫出鍵（這是給人填的表）', () => {
    const text = S.settingTemplate('config');
    assert.match(text, /^genre: *$/m);
    assert.match(text, /^audience: *$/m);
  });
});

describe('前提 / 世界觀', () => {
  test('按各自的小節表抽取', () => {
    const p = S.parseSettingDoc('premise', '## 核心衝突鏈\n甲→乙→丙', 'x');
    assert.equal(p.sections.核心冲突链, '甲→乙→丙');
    assert.equal(p.sections.悬念骨架, '');
    const w = S.parseSettingDoc('world', '## 深層危機\n靈脈將枯', 'x');
    assert.equal(w.sections.深层危机, '靈脈將枯');
  });

  test('renderSettingDoc 往返', () => {
    const sections = { 一句话前提: '當少年遭遇翻船，必須活下來否則家族覆滅', 核心冲突链: '甲', 爽点循环: '', 悬念骨架: '乙' };
    const text = S.renderSettingDoc('premise', sections);
    assert.deepEqual(S.parseSettingDoc('premise', text, 'x').sections, sections);
  });
});

describe('isSettingFilled', () => {
  test('三份模板都不算填過', () => {
    for (const doc of S.SETTING_FILE_DOCS) {
      const parsed = S.parseSettingDoc(doc, S.settingTemplate(doc), 'x');
      assert.equal(S.isSettingFilled(doc, parsed.sections), false, doc);
    }
  });

  test('配置只寫了「一句話」不算填過；有「核心梗概」才算', () => {
    assert.equal(S.isSettingFilled('config', { 一句话: '少年夜渡青河' }), false);
    assert.equal(S.isSettingFilled('config', { 核心梗概: '展開了' }), true);
  });

  test('前提看衝突鏈', () => {
    assert.equal(S.isSettingFilled('premise', { 一句话前提: '只有標題' }), false);
    assert.equal(S.isSettingFilled('premise', { 核心冲突链: '甲→乙' }), true);
  });

  test('世界觀任意一節有內容就算', () => {
    assert.equal(S.isSettingFilled('world', { 阶层与资源: '九品' }), true);
  });

  test('佔位文字不算內容', () => {
    assert.equal(S.isSettingFilled('config', { 核心梗概: '（待補充）' }), false);
    assert.equal(S.isSettingFilled('config', { 核心梗概: '(待补充)' }), false);
  });

  // 不然「金手指：（待補充）」會被當成內容一路送進 prompt。
  test('解析時佔位文字讀回來就是空串', () => {
    const c = S.parseBookConfig(S.settingTemplate('config'), 'x');
    assert.ok(Object.values(c.sections).every((v) => v === ''), JSON.stringify(c.sections));
  });
});

describe('分段格式 paragraphStyle', () => {
  test('英文值與中文說法都認', () => {
    assert.equal(S.parseBookConfig('---\nparagraphStyle: indent\n---\n', 'x').paragraphStyle, 'indent');
    assert.equal(S.parseBookConfig('---\nparagraphStyle: 縮排加空行\n---\n', 'x').paragraphStyle, 'both');
  });

  test('沒寫、寫壞了都是缺席（第 1 條）', () => {
    assert.equal(S.parseBookConfig(CONFIG, 'x').paragraphStyle, undefined);
    assert.equal(S.parseBookConfig('---\nparagraphStyle: 隨便\n---\n', 'x').paragraphStyle, undefined);
  });

  test('渲染：有值才寫這一行，往返一致', () => {
    const c = S.parseBookConfig(CONFIG, 'x');
    assert.doesNotMatch(S.renderBookConfig(c), /paragraphStyle/);
    const text = S.renderBookConfig({ ...c, paragraphStyle: 'both' });
    assert.match(text, /^paragraphStyle: both$/m);
    assert.equal(S.parseBookConfig(text, 'x').paragraphStyle, 'both');
  });

  test('只改這一行：已有就換值，別的位元組一個不動', () => {
    const text = '---\ngenre: 玄幻  # 作者的註釋\nparagraphStyle: blank\ntotalChapters: 100\n---\n\n# 小說配置\n\n## 自己加的一節\n隨便寫\n';
    assert.equal(S.setConfigParagraphStyle(text, 'indent'), text.replace('paragraphStyle: blank', 'paragraphStyle: indent'));
  });

  test('有 frontmatter 沒有這一行：加在收尾的 --- 之前', () => {
    const text = '---\ngenre: 玄幻\n---\n# 小說配置\n';
    assert.equal(S.setConfigParagraphStyle(text, 'both'), '---\ngenre: 玄幻\nparagraphStyle: both\n---\n# 小說配置\n');
  });

  test('沒有 frontmatter：最前面補一段只有這一行的，正文原樣接在後面', () => {
    assert.equal(S.setConfigParagraphStyle('# 小說配置\n## 一句話\n少年\n', 'indent'), '---\nparagraphStyle: indent\n---\n# 小說配置\n## 一句話\n少年\n');
  });

  test('空檔案：只有那一段 frontmatter，且「小說配置」照舊算沒填', () => {
    const text = S.setConfigParagraphStyle('', 'indent');
    assert.equal(text, '---\nparagraphStyle: indent\n---\n');
    const c = S.parseBookConfig(text, 'x');
    assert.equal(c.paragraphStyle, 'indent');
    assert.equal(S.isSettingFilled('config', c.sections), false);
  });

  test('CRLF 與 BOM 原樣留著', () => {
    const text = '﻿---\r\ngenre: 玄幻\r\n---\r\n正文\r\n';
    assert.equal(S.setConfigParagraphStyle(text, 'both'), '﻿---\r\ngenre: 玄幻\r\nparagraphStyle: both\r\n---\r\n正文\r\n');
  });
});
