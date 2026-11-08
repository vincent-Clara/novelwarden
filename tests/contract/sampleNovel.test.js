/**
 * 示例工程 `sample-novel/` 的資料一致性——夾具本身是不是自洽的。
 * 遷自 scripts/smoke.js 的 `== 示例工程資料一致性 ==` 一節。
 *
 * 這是**只讀**斷言：任何寫入類用例都不許碰 sample-novel（寫了這裡就會紅），
 * 需要寫盤的先經 helpers/tmpProject.js 的 copyFixture 複製一份。
 *
 * 一條軸：細綱號 = 章號。`chapters/NNN-標題.md` 是正文，細綱是 `summaries/` 根下同號的那一份，
 * 定稿時照正文反向更新的也是它。指紋鏈的三環都在這裡驗：大綱那一節 → 細綱（`upstreamHash`）、
 * 細綱 → 正文（`writtenFrom`，定稿時刷成更新之後的指紋）、正文 → 定稿（`sourceHash`）。
 * 架構三件（config / premise / world）都要是填過的——示例工程是一份走完整條
 * 鏈路、寫到第 3 章、第 4 章已經排好細綱還沒寫的書。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROOT, loadModule } = require('../helpers/load');

const SAMPLE = path.join(ROOT, 'sample-novel');

/** 與 project.ts 一致的指紋演算法：去 BOM → trim → 歸一 CRLF → sha1 → 前 16 位。 */
function contentHash(raw) {
  return crypto
    .createHash('sha1')
    .update(raw.replace(/^﻿/, '').trim().replace(/\r\n/g, '\n'))
    .digest('hex')
    .slice(0, 16);
}

const read = (rel) => fs.readFileSync(path.join(SAMPLE, rel), 'utf8');

/** 章節清單要在收集用例時就讀到（每章生成好幾條用例），所以放在模組頂層。 */
const manifest = JSON.parse(read('.novelwarden/project.json'));

/** 章節路徑 → 詞幹（`chapters/001-楔子.md` → `001-楔子`）。示例工程裡細綱與正文同名。 */
const stemOf = (file) => path.basename(file, path.extname(file));

/** `summaries/` 根下的細綱檔名（`global.md` 不是）。 */
function plotFiles() {
  const plotFile = loadModule('src/core/model/plotFile.ts');
  return fs.readdirSync(path.join(SAMPLE, '.novelwarden/summaries')).filter((f) => plotFile.isPlotFileName(f));
}

describe('示例工程資料一致性', () => {
  let md;

  before(() => {
    md = loadModule('src/core/model/markdown.ts');
  });

  test('manifest 章數與磁碟一致', () => {
    const chapterFile = loadModule('src/core/model/chapterFile.ts');
    const files = fs
      .readdirSync(path.join(SAMPLE, 'chapters'))
      .filter((f) => chapterFile.isChapterFileName(f));
    assert.equal(manifest.chapters.length, files.length);
  });

  test('manifest 索引的是章節', () => {
    assert.equal(manifest.version, 1, JSON.stringify(manifest.version));
    assert.ok(Array.isArray(manifest.chapters), typeof manifest.chapters);
    assert.equal(manifest.plots, undefined);
  });

  /** 卷與中轉站兩層都刪了，細綱也並進了 summaries/：示例工程裡不該再出現它們。 */
  test('沒有 volumes/、manuscripts/ 與 plots/', () => {
    assert.ok(!fs.existsSync(path.join(SAMPLE, '.novelwarden/volumes')));
    assert.ok(!fs.existsSync(path.join(SAMPLE, '.novelwarden/manuscripts')));
    assert.ok(!fs.existsSync(path.join(SAMPLE, '.novelwarden/plots')));
  });

  /** 每一章都有同號的細綱（示例工程是走完整條流水線寫出來的），外加第 4 章排好了還沒寫、第 5–10 章只有梗概（大綱排到了）。 */
  test('寫過的每一章都有同號的細綱，第 4–10 章只有細綱（細綱號 = 章號）', () => {
    const plotFile = loadModule('src/core/model/plotFile.ts');
    const nos = plotFiles().map((f) => plotFile.parsePlotFileName(f).no).sort((a, b) => a - b);
    assert.deepEqual(nos, [...manifest.chapters.map((c) => c.order).sort((a, b) => a - b), 4, 5, 6, 7, 8, 9, 10]);
  });

  test('manifest 不再記 summaryHash（定稿記在細綱上）', () => {
    for (const entry of manifest.chapters) {
      assert.equal(entry.summaryHash, undefined, entry.file);
    }
  });

  test('架構三件都填過，配置能解析出規模引數', () => {
    const setting = loadModule('src/core/model/settingFile.ts');
    for (const doc of setting.SETTING_FILE_DOCS) {
      const parsed = setting.parseSettingDoc(doc, read(`.novelwarden/${doc}.md`), doc);
      assert.ok(setting.isSettingFilled(doc, parsed.sections), doc);
    }
    const config = setting.parseBookConfig(read('.novelwarden/config.md'), 'config');
    assert.equal(config.totalChapters, 30);
    assert.equal(config.wordsPerChapter, 400);
    assert.equal(config.structure, 'three_act');
  });

  // 情節大綱沒有檔案：各章細綱梗概的彙總（docs/design/plans/2026-10-22-outline-from-plots.md）。第 5–10 章是隻有梗概的空殼。
  test('情節大綱是各章細綱梗概的彙總，覆蓋到第 10 章；沒有 outline.md', () => {
    const outline = loadModule('src/core/model/outlineFile.ts');
    const plotFile = loadModule('src/core/model/plotFile.ts');
    const plots = plotFiles().map((f) => plotFile.parsePlotFile(read(`.novelwarden/summaries/${f}`), `.novelwarden/summaries/${f}`));
    assert.equal(outline.outlineCoverage(outline.renderOutline(outline.outlineEntriesOf(plots))), 10);
    assert.ok(!fs.existsSync(path.join(SAMPLE, '.novelwarden/outline.md')));
    for (const p of plots.filter((x) => x.no >= 5)) {
      assert.ok(plotFile.isPlotStub(p), `第 ${p.no} 章是空殼`);
    }
  });

  describe('每章的指紋鏈', () => {
    for (const entry of manifest.chapters) {
      const plotRel = `.novelwarden/summaries/${stemOf(entry.file)}.md`;

      test(`第 ${entry.order} 章有正文`, () => {
        assert.ok(fs.existsSync(path.join(SAMPLE, entry.file)), entry.file);
      });

      test(`第 ${entry.order} 章有細綱`, () => {
        assert.ok(fs.existsSync(path.join(SAMPLE, plotRel)), plotRel);
      });

      // 細綱的兩個指紋都對得上：梗概（大綱裡這一章那一條）沒在排細綱之後改過，定稿之後細綱也沒再改過。
      test(`第 ${entry.order} 章細綱的 upstreamHash / writtenFrom 都是新鮮的`, () => {
        const plotFile = loadModule('src/core/model/plotFile.ts');
        const fsm = loadModule('src/core/model/fs.ts');
        const plot = plotFile.parsePlotFile(read(plotRel), plotRel);
        assert.equal(plot.upstreamHash, plotFile.plotSynopsisHash(plot.sections.梗概));
        const content = fsm.hash(plotFile.PLOT_SECTION_KEYS.map((k) => plot.sections[k]).join('\n---\n'));
        assert.equal(plot.writtenFrom, content);
      });

      // 雜湊的是**整份正文**（含標題行）：與 `listChapters` 一字對齊。
      test(`第 ${entry.order} 章 contentHash 正確`, () => {
        assert.equal(contentHash(read(entry.file)), entry.contentHash);
      });

      test(`第 ${entry.order} 章定稿過：細綱的 sourceHash 匹配正文`, () => {
        assert.equal(md.parseMarkdown(read(plotRel)).frontmatter.sourceHash, entry.contentHash);
      });

      // 細綱的 frontmatter 指回它屬於哪一章（身份仍以檔名為準，這一行給人看）。
      test(`第 ${entry.order} 章細綱指回章號`, () => {
        const fm = md.parseMarkdown(read(plotRel)).frontmatter;
        assert.equal(String(fm.no), String(entry.order), JSON.stringify(fm.no));
      });
    }

    test('第 4 章是計劃：關鍵事件排好了，沒有正文、沒定稿、沒記 writtenFrom，上游指紋新鮮', () => {
      const plotFile = loadModule('src/core/model/plotFile.ts');
      const [name] = plotFiles().filter((f) => plotFile.parsePlotFileName(f).no === 4);
      const plot = plotFile.parsePlotFile(read(`.novelwarden/summaries/${name}`), `.novelwarden/summaries/${name}`);
      assert.ok(plotFile.isPlotFilled(plot.sections));
      assert.equal(plot.sourceHash, '');
      assert.equal(plot.writtenFrom, '');
      assert.equal(plot.upstreamHash, plotFile.plotSynopsisHash(plot.sections.梗概));
      assert.ok(!manifest.chapters.some((c) => c.order === 4));
    });
  });

  test('示例綱要能命中 3 個角色（林昭/沈氏/年輕守衛）', () => {
    // 角色卡的 aliases 應能在示例綱要中被命中（驗證角色篩選可用）
    const outline = '林昭帶年輕守衛去見他母親，沈氏在暗處跟著。';
    const cards = fs.readdirSync(path.join(SAMPLE, '.novelwarden/characters'));
    let hitCount = 0;
    for (const f of cards) {
      const fm = md.parseMarkdown(
        fs.readFileSync(path.join(SAMPLE, '.novelwarden/characters', f), 'utf8')
      ).frontmatter;
      const names = [fm.name, ...(Array.isArray(fm.aliases) ? fm.aliases : [])];
      if (names.some((n) => n && n.length >= 2 && outline.includes(n))) hitCount++;
    }
    assert.equal(hitCount, 3);
  });
});
