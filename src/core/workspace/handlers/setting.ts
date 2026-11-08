import { traditionalLabel } from '../../model/labels';
/**
 * `setting` handler：架構層的三份文件（小說配置 / 故事前提 / 世界觀）。
 *
 * **渲染**：`Artifact{kind:'settingDoc'}` → 按那一件的小節表重排成檔案。
 * 小節換新；配置的 frontmatter（型別、結構、總章數、每章字數、分段格式……）**產物給了就用
 * 產物的，沒給就沿用磁碟那份**——作者手定的「全書 100 章」不該因為重寫一次梗概
 * 就被抹掉。
 *
 * **不記賬**：架構在指紋鏈的最上游，它自己沒有上游可記。它的下游（大綱）記它的
 * 指紋那一步留到二期（大綱的生成移植過來之後）。
 */
import { parseBookConfig, renderBookConfig, renderSettingDoc } from '../../model/settingFile';
import { readTextIfExists } from '../../model/fs';
import { Handler, HandlerCtx } from './types';

export const settingHandler: Handler = {
  async render(ctx: HandlerCtx, artifact) {
    if (artifact.kind !== 'settingDoc') {
      throw new Error(`「${ctx.rel}」不接 ${traditionalLabel(artifact.kind)} 產物`);
    }
    const doc = ctx.path.doc;
    if (!doc || doc === 'characters' || doc === 'lore' || doc !== artifact.doc) {
      throw new Error(`「${ctx.rel}」不是${artifact.doc}的落點`);
    }
    if (doc !== 'config') {
      return renderSettingDoc(doc, artifact.sections);
    }
    const raw = (await readTextIfExists(ctx.project.pathOf(ctx.rel)).catch(() => undefined)) ?? '';
    const current = parseBookConfig(raw, ctx.rel);
    const fields = artifact.config ?? {};
    return renderBookConfig({
      genre: fields.genre || current.genre,
      subGenre: fields.subGenre || current.subGenre,
      audience: fields.audience || current.audience,
      structure: fields.structure ?? current.structure,
      pov: fields.pov ?? current.pov,
      totalChapters: fields.totalChapters ?? current.totalChapters,
      wordsPerChapter: fields.wordsPerChapter ?? current.wordsPerChapter,
      // 分段格式：產物（配置草稿的 frontmatter）沒帶就沿用磁碟那份，絕不靜默丟掉。
      paragraphStyle: fields.paragraphStyle ?? current.paragraphStyle,
      sections: { ...current.sections, ...artifact.sections } as typeof current.sections,
    });
  },
};
