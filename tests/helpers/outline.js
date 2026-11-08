/**
 * 情節大綱的夾具。大綱一章一條（docs/design/plans/2026-10-21-outline-per-chapter.md），而且**沒有檔案**：它是各章細綱
 * 「梗概」的彙總（docs/design/plans/2026-10-22-outline-from-plots.md）。要「大綱覆蓋到第 20 章」，就得有第 1–20 章
 * 各一份帶梗概的細綱——`writeOutline` 照一份大綱文字把它們寫出來。
 *
 * ```js
 * outlineOf(20)                                    // 第 1–20 章，每條一行「第N章的事。」
 * outlineOf(20, { text: { 1: '林昭進青雲宗。' } })  // 第 1 章換成指定的正文
 * outlineOf(40, { from: 21, heading: false })      // 只要第 21–40 章那幾條，不帶 `# 情節大綱`
 * writeOutline(t, outlineOf(20))                   // 寫成第 1–20 章的細綱空殼（t 是 tmpProject 的路徑助手）
 * ```
 */
const fs = require('fs');
const path = require('path');

function outlineOf(to, { from = 1, title = '情節大綱', heading = true, text = {}, titles = {} } = {}) {
  const entries = [];
  for (let no = from; no <= to; no++) {
    entries.push(`## 第${no}章${titles[no] ? `：${titles[no]}` : ''}\n${text[no] ?? `第${no}章的事。`}`);
  }
  return `${heading ? `# ${title}\n\n` : ''}${entries.join('\n\n')}\n`;
}

/** 一章一條認出來：`## 第N章：標題` 下面到下一個 `#` 標題之前。區間標題、認不出的段落不算。 */
function entriesOf(text) {
  const out = [];
  let cur;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const m = /^#{2,3}\s*第\s*(\d+)\s*章\s*[:：]?\s*(.*?)\s*$/.exec(line);
    if (m) {
      cur = { no: Number(m[1]), title: m[2], lines: [] };
      if (!out.some((e) => e.no === cur.no)) {
        out.push(cur);
      }
      continue;
    }
    if (/^#{1,3}\s/.test(line)) {
      cur = undefined;
      continue;
    }
    cur?.lines.push(line);
  }
  return out.map((e) => ({ no: e.no, title: e.title, text: e.lines.join('\n').trim() })).filter((e) => e.text);
}

/** 只有標題與梗概的一份細綱（與閘道器拆大綱時建的空殼同一個樣子，只是不帶空的那幾節）。 */
function stubOf({ no, title, text }) {
  return `---\nno: ${no}\ntitle: ${title}\ngeneratedBy: novelwarden\n---\n\n# 第${no}章${title ? ` ${title}` : ''}\n\n## 梗概\n\n${text}\n`;
}

/**
 * 照一份大綱文字寫各章細綱：這一章還沒有細綱（`summaries/` 下沒有同號的 .md）就建一份空殼——有正文落正文的映象
 * （`chapters/003-夜访.md` → `summaries/003-夜访.md`），沒有就是 `summaries/NNN.md`；已經有了就只換它的「梗概」一節
 * （與閘道器存大綱時同一個口徑）。`t` 是 tmpProject 的路徑助手（`write` / `rel`）；章節根按預設的 `chapters/` 認。
 */
function writeOutline(t, text) {
  const dir = t.rel('.novelwarden/summaries');
  const existing = fs.existsSync(dir) ? listDeep(dir) : [];
  const chaptersDir = t.rel('chapters');
  const chapters = fs.existsSync(chaptersDir) ? listDeep(chaptersDir, () => true) : [];
  for (const e of entriesOf(text)) {
    const hit = existing.find((abs) => Number(/^(\d{1,5})/.exec(path.basename(abs))?.[1]) === e.no);
    if (!hit) {
      const chapter = chapters.find((abs) => Number(/^(\d{1,5})/.exec(path.basename(abs))?.[1]) === e.no);
      const mirror = chapter
        ? path.relative(chaptersDir, chapter).split(path.sep).join('/').replace(/\.[^./]*$/, '') + '.md'
        : `${String(e.no).padStart(3, '0')}.md`;
      t.write(`.novelwarden/summaries/${mirror}`, stubOf(e));
      continue;
    }
    const raw = fs.readFileSync(hit, 'utf8');
    const re = /(^##\s*梗概\s*\n)([\s\S]*?)(?=^#{1,2}\s|(?![\s\S]))/m;
    const next = re.test(raw) ? raw.replace(re, `$1\n${e.text}\n\n`) : raw.replace(/\s*$/, `\n\n## 梗概\n\n${e.text}\n`);
    fs.writeFileSync(hit, next, 'utf8');
  }
}

/** 目錄下各級以數字開頭的檔案（預設只要 .md）。 */
function listDeep(dir, keep = (name) => /\.md$/i.test(name)) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listDeep(abs, keep));
    } else if (/^\d{1,5}/.test(entry.name) && keep(entry.name)) {
      out.push(abs);
    }
  }
  return out;
}

module.exports = { outlineOf, writeOutline };
