/**
 * `written` 層：已寫正文（拆書 A）。從作者已經寫成的章裡整理架構時，模型要看的那幾章。
 *
 * **只在 `BuildRequest.derive` 時有內容**：架構那張配方掛著這一層，平時什麼都不帶。
 * 「這些章已經寫成、是權威事實」那句話在 builder 的小標題與契約裡說。
 *
 * 帶第 1–N 章的梗概與看點（一章一行），加均勻抽樣幾章（上下文詳細度的 `deriveSamples`，預設 5）的開頭節選。
 * 節選按配方（強制）；梗概放不下就隔章抽，寫明抽了幾章。
 *
 * 從前大綱那張配方也掛著它（照區間裡各章定稿過的細綱整理大綱）。情節大綱改成各章細綱梗概的彙總之後，寫過的章那一條
 * 就是定稿寫下的梗概，不再另整理（docs/design/plans/2026-10-22-outline-from-plots.md）。
 *
 * 只認**定稿過**的細綱（有 `sourceHash`）：沒定稿的是寫之前的計劃，不是「已經寫成的東西」。
 *
 * 上游（AI-Novel-Writer 的 `import-novel.command.ts`）推演設定只看首末兩章各 3000 字——長書的中段
 * 都丟了。這裡設定看全書梗概加均勻抽樣。
 */
import { plotLabel } from '../../model/pipeline';
import { evenSample, headOf } from '../../model/importText';
import { Plot } from '../../model/plotFile';
import { NovelProject } from '../../model/project';
import { Chapter } from '../../model/types';
import { estimateTokens } from '../tokenizer';
import type { LayerFn } from './assembly';

/** 首章的節選長一點：開篇交代的東西最多。 */
export const SAMPLE_HEAD_FIRST = 3000;
export const SAMPLE_HEAD = 2000;

export const written: LayerFn = async (a, spec) => {
  const derive = a.request.derive;
  if (!derive) {
    return;
  }
  const chapters = (await a.project.listChapters()).filter((c) => c.wordCount > 0 && c.order <= derive.through);
  if (chapters.length === 0) {
    return;
  }
  if (a.request.action.stage === 'setting') {
    await settingMaterial(a, spec, chapters);
  }
};

/** 這一章定稿過的細綱（正文映象的那一份，有 `sourceHash`）。沒定稿過的是計劃，不當已寫的東西。 */
async function finalizedPlot(project: NovelProject, chapter: Chapter): Promise<Plot | undefined> {
  const plot = await project.plotOfChapter(chapter);
  return plot?.sourceHash ? plot : undefined;
}

/** 架構那幾件：全書梗概 + 抽樣節選。 */
async function settingMaterial(a: Parameters<LayerFn>[0], spec: Parameters<LayerFn>[1], chapters: Chapter[]): Promise<void> {
  // 節選先進（強制）：它們是「這本書讀起來什麼樣」的唯一證據，梗概再長也替不了。
  const samples = a.limits.deriveSamples;
  for (const i of evenSample(chapters.length, samples)) {
    const chapter = chapters[i];
    const text = await a.project.readChapterText(chapter);
    const head = i === 0 ? SAMPLE_HEAD_FIRST : SAMPLE_HEAD;
    a.admit(
      {
        id: `written:${chapter.order}`,
        kind: 'written',
        priority: spec.priority,
        label: `${plotLabel(chapter.order, chapter.title)} · 開頭節選`,
        source: chapter.relPath,
        text: `【${plotLabel(chapter.order, chapter.title)} · 開頭節選】\n${headOf(text, head)}`,
        note: `均勻抽樣 ${samples} 章之一，開頭 ${head} 字`,
      },
      { force: spec.force }
    );
  }

  const lines: { no: number; line: string }[] = [];
  let missing = 0;
  for (const chapter of chapters) {
    const sections = (await finalizedPlot(a.project, chapter))?.sections;
    const synopsis = sections?.梗概?.trim();
    if (synopsis) {
      // 看點跟在梗概後面：賣點與爽點只能從這裡提煉，梗概只寫發生了什麼。
      const highlight = (sections?.看点 ?? '')
        .split(/\r?\n/)
        .map((l) => l.replace(/^\s*[-*·]\s*/, '').trim())
        .filter(Boolean)
        .join('；');
      const tail = highlight ? `｜看點：${highlight}` : '';
      lines.push({ no: chapter.order, line: `${plotLabel(chapter.order, chapter.title)}：${synopsis.replace(/\s+/g, ' ')}${tail}` });
    } else {
      missing++;
    }
  }
  if (lines.length === 0) {
    return;
  }
  const last = chapters[chapters.length - 1].order;
  const base = {
    id: 'written:synopsis',
    kind: 'written' as const,
    priority: spec.priority,
    label: `第 1–${last} 章梗概與看點`,
  };
  const all = `【第 1–${last} 章梗概與看點（一章一行）】\n${lines.map((l) => l.line).join('\n')}`;
  const missingNote = missing > 0 ? `；${missing} 章還沒同步，沒有梗概可帶` : '';
  if (estimateTokens(all) <= a.remaining) {
    a.admit({ ...base, text: all, note: `${lines.length} 章${missingNote}` });
    return;
  }
  // 放不下就隔章抽：每 k 章留一章，首尾都在。寧可稀一點，也不要只剩前半本。
  for (let stride = 2; stride <= lines.length; stride++) {
    const kept = lines.filter((_, i) => i % stride === 0 || i === lines.length - 1);
    const text = `【第 1–${last} 章梗概與看點（每 ${stride} 章取一章）】\n${kept.map((l) => l.line).join('\n')}`;
    const tokens = estimateTokens(text);
    if (tokens <= a.remaining) {
      a.accept({ ...base, text, status: 'degraded', note: `預算不足，${lines.length} 章裡每 ${stride} 章取一章，帶了 ${kept.length} 章${missingNote}` }, tokens);
      return;
    }
  }
  a.reject({ ...base, text: '' }, 'dropped', `預算不足，梗概一章都放不下${missingNote}`);
}
