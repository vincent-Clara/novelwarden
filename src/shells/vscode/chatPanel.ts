import * as vscode from 'vscode';
import { ChatController, ViewHost } from '../../core/controller';
import { InMessage, OutMessage } from '../../core/protocol';
import { htmlFor, localResourceRoots } from './webview';

/**
 * 編輯器宿主：把同一個對話面板作為標籤頁在編輯器區開啟。
 *
 * 側邊欄太窄時用這個——兩邊掛的是同一個 controller，看到的是同一個會話。
 */
export class ChatPanel implements ViewHost {
  private static instance: ChatPanel | undefined;

  readonly kind = 'editor' as const;

  static show(extensionUri: vscode.Uri, controller: ChatController): void {
    if (ChatPanel.instance) {
      ChatPanel.instance.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'novelForge.chatPanel',
      'Novelwarden',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: localResourceRoots(extensionUri),
      }
    );
    ChatPanel.instance = new ChatPanel(panel, extensionUri, controller);
  }

  static disposeInstance(): void {
    ChatPanel.instance?.panel.dispose();
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly controller: ChatController
  ) {
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.svg');
    panel.webview.html = htmlFor(panel.webview, extensionUri);
    panel.webview.onDidReceiveMessage((msg: InMessage) => void this.controller.handle(msg));

    this.controller.attach(this);
    panel.onDidDispose(() => {
      this.controller.detach(this);
      ChatPanel.instance = undefined;
    });
  }

  post(message: OutMessage): void {
    void this.panel.webview.postMessage(message);
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Beside);
  }
}
