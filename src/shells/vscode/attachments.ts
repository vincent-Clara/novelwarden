import * as vscode from 'vscode';
import { NovelProject } from '../../core/model/project';
import { Attachment } from '../../core/model/session';

/**
 * 把當前編輯器的選區做成附件（外掛專屬能力，由 VsCodeHost 暴露給 core）。
 *
 * 存快照而非路徑+行號：使用者選的時候是那個樣子，之後檔案改了
 * 不該讓歷史對話裡的引用跟著變。
 */
export function selectionAttachment(project: NovelProject): Attachment | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    return undefined;
  }
  const text = editor.document.getText(editor.selection).trim();
  if (!text) {
    return undefined;
  }
  const start = editor.selection.start.line + 1;
  const end = editor.selection.end.line + 1;
  const rel = project.relPath(editor.document.uri.fsPath);
  const name = baseName(rel);
  return {
    // 同一處選區重複新增時 id 相同，前端會去重。
    id: `sel:${rel}:${start}-${end}`,
    kind: 'selection',
    label: `${name}:${start}-${end}`,
    relPath: rel,
    range: { start, end },
    text,
  };
}

function baseName(relPath: string): string {
  const segs = relPath.split('/');
  return segs[segs.length - 1];
}
