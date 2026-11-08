// Windows 的 release 構建不要掛控制檯視窗。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Novelwarden 桌面殼。
//!
//! 它做三件事，沒有第四件：
//!
//! 1. 起 sidecar（`src/standalone` 編出來的那個單檔案可執行），**不傳工程路徑**
//! 2. 等它就緒，把視窗從本地 splash 頁導航到 `http://127.0.0.1:PORT/`
//! 3. 退出時把 sidecar 收掉
//!
//! 上次開啟的工程由 sidecar 讀 `~/.novelwarden/window.json`（舊 `~/.novelforge/` 兜底）恢復，與瀏覽器裡
//! 跑 `novelwarden` 同一條路。開啟/關閉資料夾不重啟 sidecar。

mod project;
mod sidecar;

use std::path::Path;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Url};

/// splash 頁要顯示的狀態。
///
/// 既 emit（狀態變了推一次）又能 invoke 拉取（`boot_state`）：頁面載入完成的時刻
/// 與 boot 任務推送的時刻沒有先後保證，只推會丟事件，只拉又不知道何時更新。
#[derive(Clone, Serialize)]
struct BootState {
    /// `starting` 正在起服務 / `failed` 起失敗了
    phase: String,
    message: Option<String>,
}

impl Default for BootState {
    fn default() -> Self {
        Self {
            phase: "starting".to_string(),
            message: None,
        }
    }
}

#[derive(Default)]
struct Boot(Mutex<BootState>);

fn set_state(app: &AppHandle, phase: &str, message: Option<String>) {
    let state = BootState {
        phase: phase.to_string(),
        message,
    };
    if let Some(boot) = app.try_state::<Boot>() {
        let mut guard = boot.0.lock().unwrap_or_else(|e| e.into_inner());
        *guard = state.clone();
    }
    let _ = app.emit("boot-state", state);
}

/// 起服務並導航過去。失敗則把原因交給 splash 頁顯示。
async fn launch(app: AppHandle) {
    set_state(&app, "starting", None);

    match sidecar::start(app.clone()).await {
        Ok(url) => match Url::parse(&url) {
            Ok(parsed) => {
                if let Some(mut window) = app.get_webview_window("main") {
                    if let Err(err) = window.navigate(parsed) {
                        set_state(&app, "failed", Some(format!("視窗導航失敗：{err}")));
                    }
                }
            }
            Err(err) => set_state(
                &app,
                "failed",
                Some(format!("服務給出的地址無法解析（{url}）：{err}")),
            ),
        },
        Err(message) => set_state(&app, "failed", Some(message)),
    }
}

#[tauri::command]
fn boot_state(app: AppHandle) -> BootState {
    app.try_state::<Boot>()
        .map(|boot| {
            boot.0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
        })
        .unwrap_or_default()
}

/// 「重試」只再起 sidecar，不傳路徑。
#[tauri::command]
fn retry(app: AppHandle) {
    tauri::async_runtime::spawn(launch(app));
}

#[tauri::command]
fn open_logs(app: AppHandle) -> Result<String, String> {
    let dir = sidecar::log_dir(&app).ok_or_else(|| "取不到日誌目錄".to_string())?;
    let _ = std::fs::create_dir_all(&dir);
    reveal(&dir);
    Ok(dir.display().to_string())
}

/// 用系統檔案管理器開啟一個目錄。與 src/standalone/fileHost.ts 裡的做法一致。
fn reveal(path: &Path) {
    #[cfg(target_os = "windows")]
    let program = "explorer";
    #[cfg(target_os = "linux")]
    let program = "xdg-open";
    #[cfg(target_os = "macos")]
    let program = "open";

    let _ = std::process::Command::new(program).arg(path).spawn();
}

fn main() {
    tauri::Builder::default()
        // single-instance 必須第一個註冊。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(sidecar::Sidecar::default())
        .manage(Boot::default())
        .invoke_handler(tauri::generate_handler![boot_state, retry, open_logs])
        .setup(|app| {
            let handle = app.handle().clone();
            if let Err(err) = project::migrate_shell_json_once(&handle) {
                eprintln!("遷移 shell.json 失敗：{err}");
            }
            tauri::async_runtime::spawn(async move {
                launch(handle).await;
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("構建 Tauri 應用失敗")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                sidecar::kill(app);
            }
        });
}
