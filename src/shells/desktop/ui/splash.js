/**
 * 啟動頁：starting / failed。開啟資料夾改由 sidecar 頁面上的 HTML 選單負責。
 *
 * 狀態既 **拉** 也 **推**：頁面載入完成的時刻與 Rust 側 emit 的時刻沒有先後保證，
 * 只監聽會丟掉早於自己的那次推送，只拉又不知道後來變沒變。所以 load 時 invoke
 * 一次 `boot_state`，之後跟著 `boot-state` 事件更新。
 *
 * 依賴 tauri.conf.json 的 `withGlobalTauri: true`——這一頁是純靜態檔案，
 * 沒有打包步驟，只能用全域的 window.__TAURI__。
 */
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const el = (id) => document.getElementById(id);
const ui = {
  spinner: el('spinner'),
  title: el('title'),
  path: el('path'),
  detail: el('detail'),
  actions: el('actions'),
  retry: el('btnRetry'),
  logs: el('btnLogs'),
};

/** 每個按鈕在哪些狀態下出現。 */
const BUTTONS = {
  failed: ['retry', 'logs'],
  starting: [],
};

function render(state) {
  const phase = state?.phase ?? 'starting';
  const visible = BUTTONS[phase] ?? [];

  ui.spinner.hidden = phase !== 'starting';
  ui.path.textContent = '';
  ui.detail.hidden = !state?.message;
  ui.detail.textContent = state?.message ?? '';
  ui.actions.hidden = visible.length === 0;
  for (const key of ['retry', 'logs']) {
    ui[key].hidden = !visible.includes(key);
  }

  if (phase === 'failed') {
    ui.title.textContent = '內建服務沒起來';
  } else {
    ui.title.textContent = '正在啟動 Novelwarden…';
  }
}

/** 點了按鈕就回到「啟動中」：命令本身是非同步的，介面不該停在舊狀態上。 */
ui.retry.addEventListener('click', () => {
  render({ phase: 'starting' });
  invoke('retry').catch((err) => {
    render({ phase: 'failed', message: String(err) });
  });
});

// 「檢視日誌」不改狀態：它只是開一個檔案管理器視窗，失敗介面得留著。
ui.logs.addEventListener('click', () => {
  invoke('open_logs').catch((err) => {
    ui.detail.hidden = false;
    ui.detail.textContent = String(err);
  });
});

listen('boot-state', (event) => render(event.payload));
invoke('boot_state').then(render).catch(() => render({ phase: 'starting' }));
