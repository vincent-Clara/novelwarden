//! 把舊桌面殼的 `<app_config_dir>/shell.json` 遷到 sidecar 會讀的
//! `~/.novelwarden/window.json`。只遷一次：window.json 已經在就不碰。
//!
//! 配置目錄改名後仍認舊目錄：`~/.novelforge/` 還在、`~/.novelwarden/` 還沒建時繼續用舊目錄
//! （不搬、不刪），否則老使用者升級後配置、金鑰與「最近工程」會憑空消失。

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Default, Serialize, Deserialize)]
struct ShellState {
    #[serde(default)]
    last_project: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct WindowRecent {
    root: String,
    name: String,
    #[serde(rename = "openedAt")]
    opened_at: u64,
}

#[derive(Serialize, Deserialize)]
struct WindowState {
    #[serde(rename = "lastOpen")]
    last_open: Option<String>,
    recents: Vec<WindowRecent>,
}

fn shell_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("取不到配置目錄：{e}"))?;
    Ok(dir.join("shell.json"))
}

fn home() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home))
}

/// 與 `src/core/stores.ts` 的 `homeDir()` 同一套判定：
/// `NOVELWARDEN_HOME` > `NOVELFORGE_HOME` > 已存在的 ~/.novelwarden >
/// 已存在的 ~/.novelforge > ~/.novelwarden。
fn config_dir() -> Option<PathBuf> {
    let explicit =
        std::env::var_os("NOVELWARDEN_HOME").or_else(|| std::env::var_os("NOVELFORGE_HOME"));
    if let Some(dir) = explicit {
        if !dir.is_empty() {
            return Some(PathBuf::from(dir));
        }
    }
    let home = home()?;
    let fresh = home.join(".novelwarden");
    if fresh.exists() {
        return Some(fresh);
    }
    let legacy = home.join(".novelforge");
    if legacy.exists() {
        return Some(legacy);
    }
    Some(fresh)
}

fn last_project(app: &AppHandle) -> Option<PathBuf> {
    let raw = std::fs::read_to_string(shell_path(app).ok()?).ok()?;
    let state: ShellState = serde_json::from_str(&raw).ok()?;
    let path = PathBuf::from(state.last_project?);
    if path.is_dir() {
        Some(path)
    } else {
        None
    }
}

/// 若 `window.json` 還不存在，且舊 `shell.json` 裡有還在的工程目錄，寫入一次。
pub fn migrate_shell_json_once(app: &AppHandle) -> Result<(), String> {
    let Some(dir) = config_dir() else {
        return Ok(());
    };
    let win_path = dir.join("window.json");
    if win_path.exists() {
        return Ok(());
    }
    let Some(root) = last_project(app) else {
        return Ok(());
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("建 {} 失敗：{e}", dir.display()))?;
    let root_str = root.to_string_lossy().to_string();
    let name = file_name(&root);
    let opened_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let state = WindowState {
        last_open: Some(root_str.clone()),
        recents: vec![WindowRecent {
            root: root_str,
            name,
            opened_at,
        }],
    };
    let text = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    std::fs::write(&win_path, format!("{text}\n")).map_err(|e| format!("寫 window.json 失敗：{e}"))
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| path.display().to_string())
}
