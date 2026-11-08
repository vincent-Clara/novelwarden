import { makeNonce } from '../../core/protocol';
import {
  chatPane,
  historyPane,
  logsPane,
  projectPane,
  providerModal,
  settingsPane,
  tabbar,
  taskBar,
  toastSlot,
} from '../shared/panes';

/**
 * 兩個 webview 宿主共用的 HTML。只載入本地資源，CSP 裡不開任何外部來源。
 * bridge.js 在 view.js 之前載入：webview 裡它檢測到 acquireVsCodeApi 存在就直通。
 *
 * pane 的 DOM 全部來自 [../shared/panes.ts](../shared/panes.ts)——這裡只剩
 * head / CSP / 標籤欄與裝配順序。**這個函式不碰 vscode API**：`asset` 與
 * `cspSource` 由呼叫方（[webview.ts](webview.ts)）給，於是頁面模板可以被
 * jsdom 直接執行（tests/helpers/dom.js 就是這麼拿真實頁面的）。
 *
 * body 上的 `data-vscode-context` 關掉 VS Code 給 webview 右鍵選單加的
 * 複製/貼上項：右鍵全部由 view.js 自己接管（見 media/README.md），
 * 不關掉的話點一下會同時冒出兩層選單——JS 的 preventDefault 壓不住那一層。
 */
export interface WebviewHtmlOptions {
  /** 把 `dist/media/` 下的產物名換成 webview 能載入的 URI。 */
  asset: (name: string) => string;
  /** `webview.cspSource`。 */
  cspSource: string;
}

export function renderHtml(opts: WebviewHtmlOptions): string {
  const nonce = makeNonce();
  const { asset, cspSource } = opts;

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}'; font-src ${cspSource}; img-src ${cspSource};">
<link href="${asset('view.css')}" rel="stylesheet">
<title>Novelwarden</title>
</head>
<body data-vscode-context='{"preventDefaultContextMenuItems": true}'>
${tabbar([
  { tab: 'chat', label: '對話' },
  { tab: 'project', label: '工程' },
  { tab: 'history', label: '歷史' },
  { tab: 'logs', label: '日誌' },
  { tab: 'settings', label: '設定' },
])}

${taskBar()}

${chatPane({ selectionFromEditor: true })}

${projectPane()}

${historyPane()}

${logsPane()}

${settingsPane({ nativeSettings: true })}

${providerModal()}

${toastSlot()}
<script nonce="${nonce}" src="${asset('bridge.js')}"></script>
<script nonce="${nonce}" src="${asset('view.js')}"></script>
</body>
</html>`;
}
