/**
 * 與後端的 WebSocket 連線，外加斷線重連與那條提示條。
 *
 * 對外只暴露一個 `send`：連線沒就緒時先攢著，連上再一次性發出去——
 * 頁面載入後第一條訊息（view.js 的 `ready`）幾乎必然早於握手完成，
 * 丟掉它整個介面就是空的。
 */
import { el } from '../dom';

export interface Socket {
  send(message: unknown): void;
}

/** 重連間隔。夠短到使用者幾乎察覺不到，又不至於把服務打滿。 */
const RETRY_DELAY_MS = 1500;

export function connect(): Socket {
  let ws: WebSocket | undefined;
  /** 連線未就緒時暫存的訊息。 */
  const outbox: unknown[] = [];
  const banner = offlineBanner();

  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    // 視窗開的是哪個工程：網址上的 `?project=` 原樣帶進握手。每次重連現讀，網址跟著工程換過之後連回新的那個。
    const project = new URLSearchParams(location.search).get('project');
    const query = project ? `?project=${encodeURIComponent(project)}` : '';
    ws = new WebSocket(`${proto}://${location.host}/ws${query}`);

    ws.onopen = () => {
      banner.hide();
      const socket = ws;
      if (!socket) {
        return;
      }
      for (const msg of outbox.splice(0)) {
        socket.send(JSON.stringify(msg));
      }
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      // 前端各處都用 window.addEventListener('message', e => e.data) 收訊息，
      // 派一個 MessageEvent 與 webview 的行為完全一致。
      window.dispatchEvent(new MessageEvent('message', { data: JSON.parse(event.data) }));
    };

    ws.onclose = () => {
      banner.show();
      setTimeout(open, RETRY_DELAY_MS);
    };
  };

  open();

  return {
    send(message) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      } else {
        outbox.push(message);
      }
    },
  };
}

/**
 * 斷線提示條。惰性建立——正常連著的時候頁面上不該有這個節點。
 * 樣式走 standalone.css 的主題變數，不寫死顏色。
 */
function offlineBanner() {
  let node: HTMLElement | undefined;
  return {
    show() {
      if (!node) {
        node = el(
          'div',
          'wb-offline',
          '與伺服器的連線已斷開，正在重連…（未儲存的內容仍在頁面裡）'
        );
        document.body.appendChild(node);
      }
      node.style.display = '';
    },
    hide() {
      if (node) {
        node.style.display = 'none';
      }
    },
  };
}
