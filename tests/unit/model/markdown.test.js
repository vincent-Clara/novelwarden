/**
 * Markdown 解析：frontmatter、小節抽取、H1 處理、序列化往返。
 * 遷自 scripts/smoke.js 的 `== markdown.ts ==` 一節。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT, loadModule } = require('../../helpers/load');

const SAMPLE = path.join(ROOT, 'sample-novel');

describe('markdown.ts', () => {
  let md;
  let parsed;

  before(() => {
    md = loadModule('src/core/model/markdown.ts');
    const raw = fs.readFileSync(path.join(SAMPLE, '.novelwarden/characters/林昭.md'), 'utf8');
    parsed = md.parseMarkdown(raw);
  });

  test('解析 frontmatter name', () => {
    assert.equal(parsed.frontmatter.name, '林昭');
  });

  test('解析行內陣列 aliases', () => {
    assert.ok(Array.isArray(parsed.frontmatter.aliases), JSON.stringify(parsed.frontmatter.aliases));
    assert.equal(parsed.frontmatter.aliases[0], '阿昭');
  });

  test('解析數字欄位 firstAppear', () => {
    assert.equal(parsed.frontmatter.firstAppear, '1');
  });

  test('body 不含 frontmatter', () => {
    assert.ok(!parsed.body.startsWith('---'));
  });

  describe('pickSections', () => {
    let sections;
    before(() => {
      sections = md.pickSections(parsed.body, ['身份', '语言习惯', '当前状态', '不存在的小節']);
    });

    test('抽取「身份」小節', () => {
      assert.ok(sections.身份.includes('七年前那場火的倖存者'), sections.身份);
    });

    test('抽取「語言習慣」小節', () => {
      assert.ok(sections.语言习惯.includes('答話極短'), sections.语言习惯);
    });

    test('抽取「當前狀態」小節', () => {
      assert.ok(sections.当前状态.includes('停舟'), sections.当前状态);
    });

    test('缺失小節返回空串', () => {
      assert.equal(sections.不存在的小節, '');
    });
  });

  describe('塊狀陣列寫法', () => {
    let block;
    before(() => {
      block = md.parseMarkdown('---\ntags:\n  - 主角\n  - 視角人物\nname: 甲\n---\n\n正文');
    });

    test('解析塊狀陣列', () => {
      assert.ok(Array.isArray(block.frontmatter.tags), JSON.stringify(block.frontmatter.tags));
      assert.equal(block.frontmatter.tags.length, 2, JSON.stringify(block.frontmatter.tags));
    });

    test('塊狀陣列後的鍵仍能解析', () => {
      assert.equal(block.frontmatter.name, '甲');
    });
  });

  describe('H1 處理', () => {
    test('extractH1', () => {
      assert.equal(md.extractH1('# 楔子\n\n正文'), '楔子');
    });

    test('stripH1 去掉標題', () => {
      assert.ok(md.stripH1('# 楔子\n\n雨下了三天').startsWith('雨下了三天'));
    });

    test('stripH1 不誤傷無標題正文', () => {
      assert.equal(md.stripH1('雨下了三天'), '雨下了三天');
    });
  });

  describe('容錯：作者會手改任何 Markdown', () => {
    test('無 frontmatter 不拋錯', () => {
      assert.equal(md.parseMarkdown('# 標題\n正文').frontmatter.name, undefined);
    });

    test('畸形行被跳過而非拋錯', () => {
      const messy = md.parseMarkdown('---\n這行不是鍵值對\nname: 乙\n---\n正文');
      assert.equal(messy.frontmatter.name, '乙');
    });
  });

  describe('序列化往返', () => {
    test('frontmatter 序列化往返', () => {
      const fm = md.stringifyFrontmatter({ name: '丙', aliases: ['x', 'y'], firstAppear: 3, skip: undefined });
      const round = md.parseMarkdown(`${fm}\n\n正文`);
      assert.equal(round.frontmatter.name, '丙');
      assert.equal(round.frontmatter.aliases.length, 2);
    });

    test('undefined 欄位被跳過', () => {
      const fm = md.stringifyFrontmatter({ name: '丙', aliases: ['x', 'y'], firstAppear: 3, skip: undefined });
      assert.ok(!fm.includes('skip'));
    });
  });
});
