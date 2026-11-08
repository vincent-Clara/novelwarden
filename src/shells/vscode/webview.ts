import * as vscode from 'vscode';
import { renderHtml } from './webviewHtml';

/**
 * 兩個 webview 宿主（側邊欄與編輯器標籤頁）共用的接線：能載入哪些目錄、
 * 以及把頁面模板接到 `webview.asWebviewUri`。
 *
 * 這兩件事從前在 chatViewProvider.ts 與 chatPanel.ts 裡各寫了一份，
 * `localResourceRoots` 少一條就是一片 404，不該有兩個地方能寫錯。
 */

/** icon.svg 在 `media/`，指令碼與樣式在 `dist/media/`（構建產物）。 */
export function localResourceRoots(extensionUri: vscode.Uri): vscode.Uri[] {
  return [
    vscode.Uri.joinPath(extensionUri, 'media'),
    vscode.Uri.joinPath(extensionUri, 'dist', 'media'),
  ];
}

/** 建 webview 的標準 options（兩個宿主再各自補 retainContextWhenHidden 之類）。 */
export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return { enableScripts: true, localResourceRoots: localResourceRoots(extensionUri) };
}

/**
 * 渲染頁面。F5 除錯前必須跑過 `npm run compile`——`dist/media/` 是構建產物，
 * 缺了它這裡出來的 URI 全部 404，頁面一片白。
 */
export function htmlFor(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  return renderHtml({
    asset: (name) =>
      webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'media', name)).toString(),
    cspSource: webview.cspSource,
  });
}
