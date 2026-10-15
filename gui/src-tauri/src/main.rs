//! docs/adr/0003: a read-only viewer for the chat logs database.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod blocks;
mod paths;
mod query;
mod store;

use rusqlite::Connection;
use serde::Serialize;
use std::sync::Mutex;
use store::{Message, Project, SearchResult, SessionSummary, StoreError};

/// The database connection, or why it could not be opened.
struct AppState {
    path: Option<String>,
    db: Result<Mutex<Connection>, StoreError>,
}

#[derive(Serialize)]
struct Status {
    path: Option<String>,
    error: Option<StoreError>,
}

type CommandResult<T> = Result<T, StoreError>;

fn open_state() -> AppState {
    let path = paths::database_path(|name| std::env::var(name).ok());
    let db = match &path {
        Some(p) => store::open_read_only(p).map(Mutex::new),
        None => Err(StoreError::NotFound {
            path: "(AI_CHAT_LOGS_DB and HOME are not set)".to_owned(),
        }),
    };
    AppState {
        path: path.map(|p| p.display().to_string()),
        db,
    }
}

fn with_db<T>(
    state: &AppState,
    f: impl FnOnce(&Connection) -> store::Result<T>,
) -> CommandResult<T> {
    match &state.db {
        Ok(conn) => {
            let conn = conn.lock().map_err(|e| StoreError::Sqlite {
                message: e.to_string(),
            })?;
            f(&conn)
        }
        Err(e) => Err(e.clone()),
    }
}

#[tauri::command]
fn status(state: tauri::State<'_, AppState>) -> Status {
    Status {
        path: state.path.clone(),
        error: with_db(&state, |_| Ok(())).err(),
    }
}

#[tauri::command(async)]
fn list_sessions(
    state: tauri::State<'_, AppState>,
    cwd: Option<String>,
    offset: i64,
    limit: i64,
) -> CommandResult<Vec<SessionSummary>> {
    with_db(&state, |c| {
        store::list_sessions(c, cwd.as_deref(), offset, limit)
    })
}

#[tauri::command(async)]
fn list_projects(state: tauri::State<'_, AppState>) -> CommandResult<Vec<Project>> {
    with_db(&state, store::list_projects)
}

#[tauri::command(async)]
fn get_session(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> CommandResult<Vec<Message>> {
    with_db(&state, |c| store::get_session(c, &session_id))
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
    cwd: Option<String>,
    offset: i64,
    limit: i64,
) -> CommandResult<SearchResult> {
    let plan = query::plan_search(&query);
    with_db(&state, |c| {
        store::search(c, &plan, cwd.as_deref(), offset, limit)
    })
}

fn main() {
    tauri::Builder::default()
        .manage(open_state())
        .invoke_handler(tauri::generate_handler![
            status,
            list_sessions,
            list_projects,
            get_session,
            get_block,
            search
        ])
        .run(tauri::generate_context!())
        .expect("error while running the application");
}
