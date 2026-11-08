import * as vscode from 'vscode';
import { generate } from '../../core/generation/generate';
import { NovelProject } from '../../core/model/project';
import { buildBookFacts } from '../../core/views/pipeline';

/** 供命令面板走的極簡續寫（不開 Webview），結果流式寫入新文件。 */
export async function quickContinue(project: NovelProject): Promise<void> {
  const outline = await vscode.window.showInputBox({
    title: 'Novel: 快速續寫',
    prompt: '輸入接下來的劇情綱要（詳細的寫作請用續寫面板）',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : '綱要不能為空'),
  });
  if (!outline) {
    return;
  }

  // 寫的是**下一可寫章**：從第 1 章起連續有正文的最大章號 + 1，與主按鈕同一個判據
  // （第 20 條）。從前用「細綱號與章號裡最大的 + 1」，排了十章細綱只寫了三章時，
  // 快速續寫會跳到第 11 章去。
  const no = (await buildBookFacts(project)).nextChapterNo;
  const plotRelPath = await project.plotPathOfNo(no);
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: '' });
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  // 這條路不開面板，也就沒有 controller 替它管併發——自帶一個 abort 即可。
  const abort = new AbortController();

  /** 整份換掉：續寫丟棄過的那一輪、以及收尾時的去重，都要反映到文件裡。 */
  const replaceAll = (text: string) =>
    editor.edit((b) => b.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text));

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Novelwarden：生成中', cancellable: true },
    async (progress, token) => {
      token.onCancellationRequested(() => abort.abort());
      await generate(
        project,
        {
          action: { stage: 'manuscript', capability: 'generate' },
          // 那一章的細綱多半還不存在，target 指向它**應該**在的位置（跟上一章放在一起），
          // 裝配器按這個號定位前文。目標字數由生成層兜底（細綱 → 配置的每章字數）。
          target: { kind: 'manuscript', plotRelPath },
          targetNo: no,
          ask: outline,
          // 這一章已經寫了一半時從末尾接著寫；還沒有正文時生成層會按新寫處理。
          writeMode: 'continue',
        },
        {
          onDelta: (delta) => {
            void editor.edit(
              (b) => b.insert(doc.lineAt(doc.lineCount - 1).range.end, delta),
              { undoStopBefore: false, undoStopAfter: false }
            );
          },
          onReset: (full) => void replaceAll(full),
          onProgress: (p) =>
            progress.report({
              message: `${p.round > 0 ? `續寫第 ${p.round} 輪 · ` : ''}${p.words}${p.target ? ` / ${p.target}` : ''} 字`,
            }),
          onDone: (full) => {
            void replaceAll(full);
            void vscode.window.showInformationMessage('Novelwarden：生成完成。');
          },
          onError: (msg) => void vscode.window.showErrorMessage(`Novelwarden：${msg}`),
          onCancelled: () => void vscode.window.showInformationMessage('Novelwarden：已取消。'),
        },
        { signal: abort.signal }
      );
    }
  );
}
