import { traditionalLabel } from '../../model/labels';
/**
 * `plain` handler：純文字進出，無記賬。
 *
 * 接 `other`（工程裡的普通文字）、`draft`（草稿）與 `skill`（本工程的寫作技能與階段繫結：
 * 作者手寫的 `SKILL.md` 與一份 JSON，都不該被加 frontmatter）。
 *
 * 草稿在這裡而不在 `doc` 裡，是因為它**永不自動進上下文**（AGENTS 第 10 條）：
 * `context/builder.ts` 裡沒有任何一處讀 `drafts/`，草稿只能經作者顯式 `@`
 * 引用進 prompt。給它加任何 frontmatter 記賬都是往那條約束上開口子。
 */
import { Handler, HandlerCtx } from './types';

export const plainHandler: Handler = {
  async render(_ctx: HandlerCtx, artifact) {
    // 純文字區沒有結構化產物可渲染——落到這裡說明呼叫方把 artifact 寫錯了地方。
    throw new Error(`這個路徑不接結構化產物（${traditionalLabel(artifact.kind)}）`);
  },
};
