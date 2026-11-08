import * as vscode from 'vscode';
import { ChatController, ViewHost } from '../../core/controller';
import { InMessage, OutMessage } from '../../core/protocol';
import { htmlFor, webviewOptions } from './webview';

/**
 * 側邊欄宿主。檢視在 package.json 裡註冊為 `novelForge.chat`，
 * 與樹檢視同處 Novelwarden 活動欄容器。
 *
 * 面板內部用 tabbar 切換 對話/歷史/設定，參考 Roo 的做法——
 * 側邊欄本來就窄，多開幾個 view 不如一個檢視內切頁。
 */
export class ChatViewProvider implements vscode.WebviewViewProvider, ViewHost {
  static readonly viewType = 'novelForge.chat';

  readonly kind = 'sidebar' as const;
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: ChatController
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = webviewOptions(this.extensionUri);
    view.webview.html = htmlFor(view.webview, this.extensionUri);
    view.webview.onDidReceiveMessage((msg: InMessage) => void this.controller.handle(msg));

    this.controller.attach(this);
    view.onDidDispose(() => {
      this.controller.detach(this);
      this.view = undefined;
    });
  }

  post(message: OutMessage): void {
    void this.view?.webview.postMessage(message);
  }

  reveal(): void {
    if (this.view) {
      this.view.show?.(true);
    } else {
      // 檢視還沒被建立過（使用者沒點開過側邊欄），先讓容器聚焦。
      void vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    }
  }
}
