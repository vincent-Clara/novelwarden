//! sidecar（`novelwarden` 單檔案可執行）的生命週期。
//!
//! ## 就緒訊號為什麼是 stdout 裡那行 URL
//!
//! `src/standalone/server.ts` 在 `Bun.serve` 返回**之後**打一行
//! `服務已啟動：http://127.0.0.1:PORT/`。返回意味著 listen 已完成，所以這一行
//! 既給出埠、又證明埠已經能連——不需要再輪詢探活。
//!
//! 這裡刻意只匹配 URL 那一段，不匹配「服務已啟動」這幾個中文字：日誌文案將來
//! 改了不該把殼弄壞。
//!
//! ## 為什麼還要預挑埠
//!
//! sidecar 自己在埠被佔時會順延重試（`main.ts`），順延之後的埠只有它知道。
//! 預挑一個空閒埠傳給它，是為了讓「碰撞」幾乎不發生；真發生了也不怕，
//! 因為埠的**權威來源始終是 stdout 那行 URL**，不是我們挑的這個數。
//! 預挑的值只用在一處：stdout 遲遲不來時的 TCP 兜底探測。

use std::io::Write;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// tauri.conf.json 裡 `externalBin` 的末段，也是 scripts/build-sidecar.js 的 BASE。
const BIN: &str = "novelwarden";
const URL_PREFIX: &str = "http://127.0.0.1:";

/// 輪詢間隔與兩個閾值。
const TICK: Duration = Duration::from_millis(100);
/// 8 秒還沒等到 stdout 就開始 TCP 兜底探測（管道緩衝異常之類）。
const PROBE_AFTER_TICKS: u32 = 80;
/// 30 秒仍不就緒就認定失敗——比 sidecar 自己順延 20 次埠的最壞情況還寬。
const GIVE_UP_TICKS: u32 = 300;

/// 持有正在跑的 sidecar 子程序。退出時從這裡取。
#[derive(Default)]
pub struct Sidecar {
    child: Mutex<Option<CommandChild>>,
}

/// 收掉當前 sidecar。**退出時必須調**：Windows 上留下孤兒程序會佔著埠，
/// 還會佔著 `.novelwarden/novelwarden.db`（`src/core/runtime/db.ts` 裡記過這個 EBUSY 坑）。
///
/// 冪等——沒有在跑的子程序時什麼都不做。
pub fn kill(app: &AppHandle) {
    let Some(state) = app.try_state::<Sidecar>() else {
        return;
    };
    // 鎖中毒也要把子程序收掉，所以不用 unwrap。
    let mut guard = state.child.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(child) = guard.take() {
        let _ = child.kill();
    }
}

pub fn log_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_log_dir().ok()
}

fn log_path(app: &AppHandle) -> Option<PathBuf> {
    Some(log_dir(app)?.join("sidecar.log"))
}

/// 起一個 sidecar，等它就緒，返回該訪問的 URL。
///
/// 會先收掉已有的 sidecar，所以失敗後點「重試」直接調它即可。
pub async fn start(app: AppHandle) -> Result<String, String> {
    kill(&app);

    let port = free_port()?;
    let log = log_path(&app);
    // 每次啟動截斷重來：這是「上次為什麼起不來」的排查依據，不需要歷史。
    if let Some(path) = &log {
        reset_log(path, port);
    }

    let (mut rx, child) = app
        .shell()
        .sidecar(BIN)
        .map_err(|e| format!("找不到內建服務程式：{e}"))?
        .args([
            "--no-open".to_string(),
            "--port".to_string(),
            port.to_string(),
        ])
        .spawn()
        .map_err(|e| format!("啟動內建服務失敗：{e}"))?;

    if let Some(state) = app.try_state::<Sidecar>() {
        let mut guard = state.child.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(child);
    }

    // sidecar 的 stdout/stderr 全量落盤，同時從裡面撈就緒訊號。
    let (tx, mut ready) = tokio::sync::mpsc::channel::<Result<String, String>>(4);
    let log_for_task = log.clone();
    tauri::async_runtime::spawn(async move {
        let mut reported = false;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                    let text = String::from_utf8_lossy(&bytes).to_string();
                    append(&log_for_task, &text);
                    if !reported {
                        if let Some(url) = text.lines().find_map(parse_url) {
                            reported = true;
                            let _ = tx.send(Ok(url)).await;
                        }
                    }
                }
                CommandEvent::Error(message) => {
                    append(&log_for_task, &format!("[殼] 子程序錯誤：{message}"));
                    if !reported {
                        reported = true;
                        let _ = tx.send(Err(message)).await;
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let message = format!(
                        "內建服務退出（code={:?}, signal={:?}）",
                        payload.code, payload.signal
                    );
                    append(&log_for_task, &format!("[殼] {message}"));
                    if !reported {
                        reported = true;
                        let _ = tx.send(Err(message)).await;
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    for tick in 0..GIVE_UP_TICKS {
        match ready.try_recv() {
            Ok(Ok(url)) => return Ok(url),
            Ok(Err(message)) => return Err(message),
            Err(_) => {}
        }
        // stdout 沒來但埠在聽：按預挑的埠走，別乾等著。
        if tick >= PROBE_AFTER_TICKS && tick % 10 == 0 && port_alive(port) {
            append(
                &log,
                "[殼] 沒等到 stdout 的就緒行，但埠已在監聽，按預挑埠繼續。",
            );
            return Ok(format!("{URL_PREFIX}{port}/"));
        }
        tokio::time::sleep(TICK).await;
    }

    Err("內建服務 30 秒內沒有就緒".to_string())
}

/// 挑一個空閒埠：綁 0 號口讓系統分配，取到號就放掉。
fn free_port() -> Result<u16, String> {
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("挑不到空閒埠：{e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("取不到埠號：{e}"))?
        .port();
    drop(listener);
    Ok(port)
}

fn port_alive(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

/// 從一行日誌裡摳出 `http://127.0.0.1:PORT/`。認不出返回 None。
fn parse_url(line: &str) -> Option<String> {
    let at = line.find(URL_PREFIX)?;
    let digits: String = line[at + URL_PREFIX.len()..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    if digits.is_empty() {
        return None;
    }
    Some(format!("{URL_PREFIX}{digits}/"))
}

fn reset_log(path: &Path, port: u16) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(
        path,
        format!("[殼] 啟動內建服務，預挑埠 {port}\n"),
    );
}

/// 追加一段 sidecar 輸出。**所有錯誤都吞掉**——日誌是排查手段，不該成為
/// 新的失敗源（與 src/core/runtime/db.ts 裡對 SQLite 的態度一致）。
fn append(path: &Option<PathBuf>, text: &str) {
    let Some(path) = path else {
        return;
    };
    let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let _ = file.write_all(text.as_bytes());
    if !text.ends_with('\n') {
        let _ = file.write_all(b"\n");
    }
}
