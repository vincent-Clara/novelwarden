import { PickChoice } from '../host';
import { NovelProject } from '../model/project';
import { loreBrief } from '../model/loreFile';
import { Attachment, AttachmentKind } from '../model/session';
import { normalizeRel } from '../workspace/kind';

/**
 * 構建 @ 引用的候選列表；展示與選擇交給 Host.pick。
 * 「瀏覽工作區」入口只存在於外掛的 QuickPick 實現裡（Host.browseFile）。
 */
export async function listAttachmentChoices(project: NovelProject): Promise<PickChoice<Attachment>[]> {
  const choices: PickChoice<Attachment>[] = [];

  const chapters = await project.listChapters();
  for (const c of [...chapters].reverse()) {
    choices.push({
      label: `${String(c.order).padStart(3, '0')} ${c.title}`,
      description: `${c.wordCount} 字`,
      detail: c.relPath,
      group: '章節',
      value: fileAttachment('chapter', `第${c.order}章 ${c.title}`, c.relPath),
    });
  }

  // 草稿單列一組。**只列磁碟上已存在的**——沒建過草稿的章節列出來只會是
  // 一堆點了報錯的空條目。草稿永遠不自動進上下文，想用就在這裡手動挑。
  const draftPaths = await project.listDraftPaths();
  for (const c of [...chapters].reverse()) {
    const draft = project.draftRelPathFor(c.relPath);
    if (!draft || !draftPaths.has(draft)) {
      continue;
    }
    choices.push({
      label: `${String(c.order).padStart(3, '0')} ${c.title} · 草稿`,
      detail: draft,
      group: '草稿',
      value: fileAttachment('file', `第${c.order}章 ${c.title} · 草稿`, draft),
    });
  }

  for (const card of await project.listCharacters()) {
    choices.push({
      label: card.name,
      description: card.tags.join(' · '),
      detail: card.relPath,
      group: '角色',
      value: fileAttachment('character', `角色 ${card.name}`, card.relPath),
    });
  }

  for (const entry of await project.listLore()) {
    choices.push({
      label: entry.title,
      // 一句話簡介比關鍵詞更說得清這是什麼；都沒有才退回關鍵詞。
      description: loreBrief(entry) || entry.keywords.join('/'),
      detail: entry.relPath,
      group: '设定',
      value: fileAttachment('lore', `設定 ${entry.title}`, entry.relPath),
    });
  }

  const outlineRel = project.relPath(project.outlinePath);
  choices.push({
    label: '情節大綱',
    detail: outlineRel,
    group: '其他',
    value: fileAttachment('file', '情節大綱', outlineRel),
  });
  const styleRel = project.relPath(project.stylePath);
  choices.push({
    label: '文風指南',
    detail: styleRel,
    group: '其他',
    value: fileAttachment('file', '文風指南', styleRel),
  });

  return choices;
}

function fileAttachment(kind: AttachmentKind, label: string, relPath: string): Attachment {
  return { id: `${kind}:${relPath}`, kind, label, relPath };
}

/**
 * 對話頁從內建編輯器（獨立版）帶上來的一處選區 → 附件。存快照：選的時候是那個樣子，之後檔案改了
 * 不該讓歷史對話跟著變。id 與名字和外掛殼讀 VS Code 選區的那一份（shells/vscode/attachments.ts）一個樣：
 * 同一處選區重複新增時 id 相同，前端去重。路徑越界（絕對路徑、`..`）就只留文字，不留一個點不開的路徑。
 */
export function selectionAttachmentOf(relPath: string, text: string, range: { start: number; end: number }): Attachment {
  const rel = normalizeRel(relPath);
  if (!rel) {
    return { id: `sel:${Date.now().toString(36)}`, kind: 'selection', label: '選區', text };
  }
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  return {
    id: `sel:${rel}:${range.start}-${range.end}`,
    kind: 'selection',
    label: `${name}:${range.start}-${range.end}`,
    relPath: rel,
    range: { start: range.start, end: range.end },
    text,
  };
}
