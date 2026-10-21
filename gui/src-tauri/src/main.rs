//! docs/adr/0003, docs/adr/0007: a viewer for the chat logs database with a settings and setup screen.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod blocks;
mod dotenv;
mod query;
mod settings;
mod setup;
mod store;

use rusqlite::Connection;
use serde::Serialize;
use settings::{Layers, Setting};
use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use store::{Project, SearchResult, SessionSummary, StoreError};

/// The repository this app was built from: the default of AI_CHAT_LOGS_REPO.
const REPO_AT_BUILD: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");

/// Settings and the database opened with them.
struct Loaded {
    settings: Vec<Setting>,
    config_path: Option<PathBuf>,
    db: Result<Connection, StoreError>,
}

struct AppState {
    loaded: Mutex<Loaded>,
    running: AtomicBool,
}

type CommandResult<T> = Result<T, StoreError>;

fn settings_error(message: impl Into<String>) -> StoreError {
    StoreError::Settings {
        message: message.into(),
    }
}

fn read_pairs(path: &Path) -> Result<dotenv::Pairs, StoreError> {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            dotenv::parse(&text).map_err(|e| settings_error(format!("{}: {e}", path.display())))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(settings_error(format!("{}: {e}", path.display()))),
    }
}

fn is_executable(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

fn repo_at_build() -> PathBuf {
    let path = PathBuf::from(REPO_AT_BUILD);
    path.canonicalize().unwrap_or(path)
}

/// Reads the environment, the config file and the repository .env, highest priority first (docs/adr/0007).
fn load_settings() -> Result<(Vec<Setting>, Option<PathBuf>), StoreError> {
    let env: HashMap<String, String> = std::env::vars().collect();
    let config_path = settings::config_path(&env);
    let config = config_path
        .as_deref()
        .map(read_pairs)
        .transpose()?
        .unwrap_or_default();
    let repo = env
        .get(settings::REPO)
        .filter(|v| !v.is_empty())
        .cloned()
        .or_else(|| {
            config
                .iter()
                .rev()
                .find(|(k, v)| k == settings::REPO && !v.is_empty())
                .map(|(_, v)| v.clone())
        })
        .map(PathBuf::from)
        .unwrap_or_else(repo_at_build);
    let env_file_path = env
        .get("AI_CHAT_LOGS_ENV_FILE")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| repo.join(".env"));
    let env_file = read_pairs(&env_file_path)?;
    let bun = settings::find_executable(
        &settings::bun_candidates(
            env.get("PATH").map(String::as_str),
            env.get("HOME").map(String::as_str),
        ),
        is_executable,
    );
    let layers = Layers {
        env,
        env_file,
        config,
    };
    Ok((
        settings::resolve(&layers, &repo_at_build(), bun.as_deref()),
        config_path,
    ))
}

fn load() -> Loaded {
    match load_settings() {
        Ok((settings, config_path)) => {
            let db = match settings::value(&settings, settings::DB) {
                Some(path) => store::open_read_only(Path::new(path)),
                None => Err(settings_error(
                    "the database path is unknown (HOME is not set)",
                )),
            };
            Loaded {
                settings,
                config_path,
                db,
            }
        }
        Err(e) => Loaded {
            settings: vec![],
            config_path: None,
            db: Err(e),
        },
    }
}

fn reload(state: &AppState) -> CommandResult<()> {
    let fresh = load();
    *state
        .loaded
        .lock()
        .map_err(|e| settings_error(e.to_string()))? = fresh;
    Ok(())
}

fn with_loaded<T>(
    state: &AppState,
    f: impl FnOnce(&Loaded) -> CommandResult<T>,
) -> CommandResult<T> {
    let loaded = state
        .loaded
        .lock()
        .map_err(|e| settings_error(e.to_string()))?;
    f(&loaded)
}

fn with_db<T>(
    state: &AppState,
    f: impl FnOnce(&Connection) -> store::Result<T>,
) -> CommandResult<T> {
    with_loaded(state, |l| match &l.db {
        Ok(conn) => f(conn),
        Err(e) => Err(e.clone()),
    })
}

#[derive(Serialize)]
struct Status {
    path: Option<String>,
    error: Option<StoreError>,
}

#[tauri::command]
fn status(state: tauri::State<'_, AppState>) -> CommandResult<Status> {
    with_loaded(&state, |l| {
        Ok(Status {
            path: settings::value(&l.settings, settings::DB).map(str::to_owned),
            error: l.db.as_ref().err().cloned(),
        })
    })
}

#[tauri::command(async)]
fn list_sessions(
    state: tauri::State<'_, AppState>,
    provider: Option<String>,
    cwd: Option<String>,
    offset: i64,
    limit: i64,
) -> CommandResult<Vec<SessionSummary>> {
    with_db(&state, |c| {
        store::list_sessions(c, provider.as_deref(), cwd.as_deref(), offset, limit)
    })
}

#[tauri::command(async)]
fn list_projects(state: tauri::State<'_, AppState>) -> CommandResult<Vec<Project>> {
    with_db(&state, store::list_projects)
}

#[tauri::command(async)]
fn get_messages(
    state: tauri::State<'_, AppState>,
    session_id: String,
    from: usize,
    limit: usize,
) -> CommandResult<store::MessagePage> {
    with_db(&state, |c| store::get_messages(c, &session_id, from, limit))
}

#[tauri::command(async)]
fn get_block(
    state: tauri::State<'_, AppState>,
    rowid: i64,
    index: usize,
) -> CommandResult<blocks::Block> {
    with_db(&state, |c| store::get_block(c, rowid, index))
}

#[tauri::command(async)]
fn search(
    state: tauri::State<'_, AppState>,
    query: String,
    provider: Option<String>,
    cwd: Option<String>,
    offset: i64,
    limit: i64,
) -> CommandResult<SearchResult> {
    let plan = query::plan_search(&query);
    with_db(&state, |c| {
        store::search(c, &plan, provider.as_deref(), cwd.as_deref(), offset, limit)
    })
}

#[derive(Serialize)]
struct SettingsView {
    config_path: Option<String>,
    settings: Vec<Setting>,
    error: Option<StoreError>,
}

fn settings_view(state: &AppState) -> CommandResult<SettingsView> {
    with_loaded(state, |l| {
        Ok(SettingsView {
            config_path: l.config_path.as_ref().map(|p| p.display().to_string()),
            settings: l.settings.clone(),
            error: match &l.db {
                Err(e @ StoreError::Settings { .. }) => Some(e.clone()),
                _ => None,
            },
        })
    })
}

#[tauri::command]
fn get_settings(state: tauri::State<'_, AppState>) -> CommandResult<SettingsView> {
    settings_view(&state)
}

/// Writes `key` into the config file (removes it when empty) and reopens the database.
#[tauri::command]
fn save_setting(
    state: tauri::State<'_, AppState>,
    key: String,
    value: Option<String>,
) -> CommandResult<SettingsView> {
    let path = with_loaded(&state, |l| {
        l.config_path
            .clone()
            .ok_or_else(|| settings_error("the config file path is unknown (HOME is not set)"))
    })?;
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(settings_error(e.to_string())),
    };
    let updated = settings::update_config(&text, &key, value.as_deref()).map_err(settings_error)?;
    settings::save_config(&path, &updated).map_err(|e| settings_error(e.to_string()))?;
    reload(&state)?;
    settings_view(&state)
}

#[derive(Serialize)]
struct ToolCheck {
    path: Option<String>,
    detail: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
struct EnvironmentCheck {
    paths: Vec<setup::PathCheck>,
    database: setup::DatabaseCheck,
    bun: ToolCheck,
    pm2: ToolCheck,
    pm2_registered: Option<bool>,
    launch_agent: bool,
}

fn run_captured(program: &Path, args: &[&str]) -> Result<String, String> {
    std::process::Command::new(program)
        .args(args)
        .output()
        .map_err(|e| e.to_string())
        .and_then(|o| {
            if o.status.success() {
                Ok(String::from_utf8_lossy(&o.stdout).into_owned())
            } else {
                Err(setup::tail(&String::from_utf8_lossy(&o.stderr), 5))
            }
        })
}

fn launch_agent_exists(home: Option<&str>) -> bool {
    home.map(|h| Path::new(h).join("Library/LaunchAgents"))
        .and_then(|dir| std::fs::read_dir(dir).ok())
        .is_some_and(|entries| {
            entries.flatten().any(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                name.starts_with("pm2.") && name.ends_with(".plist")
            })
        })
}

/// Reads only; changes nothing (docs/adr/0007).
#[tauri::command(async)]
fn check_environment(state: tauri::State<'_, AppState>) -> CommandResult<EnvironmentCheck> {
    let settings = with_loaded(&state, |l| Ok(l.settings.clone()))?;
    let home = std::env::var("HOME").ok();
    let path_env = std::env::var("PATH").ok();
    let bun = settings::value(&settings, settings::BUN).map(PathBuf::from);
    let bun_check = match &bun {
        Some(b) => match run_captured(b, &["--version"]) {
            Ok(v) => ToolCheck {
                path: Some(b.display().to_string()),
                detail: Some(v.trim().to_owned()),
                error: None,
            },
            Err(e) => ToolCheck {
                path: Some(b.display().to_string()),
                detail: None,
                error: Some(e),
            },
        },
        None => ToolCheck {
            path: None,
            detail: None,
            error: Some("bun が見つかりません".to_owned()),
        },
    };
    let pm2 = settings::find_executable(
        &setup::pm2_candidates(bun.as_deref(), path_env.as_deref(), home.as_deref()),
        is_executable,
    );
    // pm2 is a Node.js script; run it with bun because an app started from Finder has no node on PATH.
    let jlist = match (&bun, &pm2) {
        (Some(b), Some(p)) => Some(run_captured(b, &[&p.to_string_lossy(), "jlist"])),
        _ => None,
    };
    let registered = jlist.as_ref().and_then(|r| r.as_ref().ok()).map(|out| {
        serde_json::from_str::<Vec<serde_json::Value>>(out.trim())
            .map(|apps| {
                apps.iter()
                    .any(|a| a.get("name").and_then(|n| n.as_str()) == Some("ai-chat-logs-sync"))
            })
            .unwrap_or(false)
    });
    let pm2_check = ToolCheck {
        path: pm2.as_ref().map(|p| p.display().to_string()),
        detail: None,
        error: match (&pm2, jlist) {
            (None, _) => Some("pm2 が見つかりません".to_owned()),
            (Some(_), Some(Err(e))) => Some(e),
            _ => None,
        },
    };
    Ok(EnvironmentCheck {
        paths: setup::check_paths(&settings),
        database: setup::check_database(Path::new(
            settings::value(&settings, settings::DB).unwrap_or_default(),
        )),
        bun: bun_check,
        pm2: pm2_check,
        pm2_registered: registered,
        launch_agent: launch_agent_exists(home.as_deref()),
    })
}

#[derive(Serialize)]
struct RunResult {
    exit_code: Option<i32>,
    output: String,
}

fn capture(
    spec: &setup::CommandSpec,
    cwd: Option<&str>,
) -> Result<std::process::Output, StoreError> {
    let mut command = std::process::Command::new(&spec.program);
    command.args(&spec.args).envs(spec.env.iter().cloned());
    if let Some(dir) = cwd {
        command.current_dir(dir);
    }
    command
        .output()
        .map_err(|e| settings_error(format!("{}: {e}", spec.program.display())))
}

fn to_run_result(output: &std::process::Output) -> RunResult {
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    RunResult {
        exit_code: output.status.code(),
        output: setup::tail(&text, 20),
    }
}

fn execute(spec: &setup::CommandSpec, cwd: Option<&str>) -> Result<RunResult, StoreError> {
    capture(spec, cwd).map(|o| to_run_result(&o))
}

/// Runs `f` unless another command is running, then reopens the database.
fn exclusive<T>(
    state: &AppState,
    f: impl FnOnce(&[Setting]) -> CommandResult<T>,
) -> CommandResult<T> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err(settings_error("別の処理を実行中です"));
    }
    let result = with_loaded(state, |l| Ok(l.settings.clone())).and_then(|s| f(&s));
    let reloaded = reload(state);
    state.running.store(false, Ordering::SeqCst);
    reloaded.and(result)
}

#[tauri::command(async)]
fn run_sync(state: tauri::State<'_, AppState>) -> CommandResult<RunResult> {
    let path = std::env::var("PATH").ok();
    exclusive(&state, |s| {
        let spec = setup::sync_command(s, path.as_deref()).map_err(settings_error)?;
        execute(&spec, settings::value(s, settings::REPO))
    })
}

#[tauri::command(async)]
fn import_claude_ai_export(
    state: tauri::State<'_, AppState>,
    zip: String,
) -> CommandResult<RunResult> {
    let path = std::env::var("PATH").ok();
    exclusive(&state, |s| {
        let repo = settings::value(s, settings::REPO);
        let convert = execute(
            &setup::convert_command(s, path.as_deref(), Path::new(&zip)).map_err(settings_error)?,
            repo,
        )?;
        if convert.exit_code != Some(0) {
            return Ok(convert);
        }
        let sync = execute(
            &setup::sync_command(s, path.as_deref()).map_err(settings_error)?,
            repo,
        )?;
        Ok(RunResult {
            exit_code: sync.exit_code,
            output: setup::tail(&format!("{}\n{}", convert.output, sync.output), 20),
        })
    })
}

#[derive(Serialize)]
struct ScanResult {
    /// Export directories converted by this scan.
    imported: Vec<String>,
    scan_exit_code: Option<i32>,
    /// The exit code of bin/sync.
    exit_code: Option<i32>,
    output: String,
}

/// docs/adr/0010: convert downloaded claude.ai exports, then import.
#[tauri::command(async)]
fn scan_claude_ai_exports(state: tauri::State<'_, AppState>) -> CommandResult<ScanResult> {
    let path = std::env::var("PATH").ok();
    exclusive(&state, |s| {
        let repo = settings::value(s, settings::REPO);
        let scan = capture(
            &setup::scan_command(s, path.as_deref()).map_err(settings_error)?,
            repo,
        )?;
        let sync = execute(
            &setup::sync_command(s, path.as_deref()).map_err(settings_error)?,
            repo,
        )?;
        let scan_text = to_run_result(&scan).output;
        Ok(ScanResult {
            imported: setup::scanned_exports(&String::from_utf8_lossy(&scan.stdout)),
            scan_exit_code: scan.status.code(),
            exit_code: sync.exit_code,
            output: setup::tail(&format!("{scan_text}\n{}", sync.output), 20),
        })
    })
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            loaded: Mutex::new(load()),
            running: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            status,
            list_sessions,
            list_projects,
            get_messages,
            get_block,
            search,
            get_settings,
            save_setting,
            check_environment,
            run_sync,
            import_claude_ai_export,
            scan_claude_ai_exports
        ])
        .run(tauri::generate_context!())
        .expect("error while running the application");
}
