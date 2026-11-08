/**
 * 獨立版橋接：在 view.js 之前載入，把 WebSocket 偽裝成 webview API。
 *
 * webview 環境（VS Code）裡 `acquireVsCodeApi` 已經存在，本檔案直接退出——
 * 一個前端兩個殼，靠的就是這層偽裝，view / editor / explorer 裡沒有一行
 * 「我在哪個殼裡」的判斷。
 */
import { connect } from './socket';
import { installWebviewApi } from './webviewApi';

// 已經在 webview 裡了：宿主給的那個才是真的，別覆蓋。
if (typeof acquireVsCodeApi !== 'function') {
  installWebviewApi(connect());
}
