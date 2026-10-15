//! docs/adr/0007: the environment check and the commands the setup section runs.

use crate::settings::{self, Setting};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// A command to run: program, arguments and extra environment variables.
#[derive(Debug, PartialEq)]
pub struct CommandSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// `bin/sync` of the repository, with bun's directory first on PATH and the settings as environment variables.
/// PATH with bun's directory first, and the CLI settings, as environment variables for a command.
fn command_env(settings: &[Setting], bun: &Path, path: Option<&str>) -> Vec<(String, String)> {
    let bun_dir = bun
        .parent()
        .map(|d| d.to_string_lossy().into_owned())
        .unwrap_or_default();
    let path = match path.filter(|p| !p.is_empty()) {
        Some(p) => format!("{bun_dir}:{p}"),
        None => bun_dir,
    };
    std::iter::once(("PATH".to_owned(), path))
        .chain(settings::CLI_KEYS.iter().filter_map(|&key| {
            settings::value(settings, key).map(|v| (key.to_owned(), v.to_owned()))
        }))
        .collect()
}

fn required<'a>(settings: &'a [Setting], key: &str, what: &str) -> Result<&'a str, String> {
    settings::value(settings, key).ok_or_else(|| format!("{what} is not set ({key})"))
}

pub fn sync_command(settings: &[Setting], path: Option<&str>) -> Result<CommandSpec, String> {
    let bun = required(settings, settings::BUN, "bun")?;
    let repo = required(settings, settings::REPO, "the repository")?;
    Ok(CommandSpec {
        program: PathBuf::from("/bin/sh"),
        args: vec![
            Path::new(repo)
                .join("bin/sync")
                .to_string_lossy()
                .into_owned(),
        ],
        env: command_env(settings, Path::new(bun), path),
    })
}

/// `claude-ai-export-convert <zip>` with the same environment as sync_command.
pub fn convert_command(
    settings: &[Setting],
    path: Option<&str>,
    zip: &Path,
) -> Result<CommandSpec, String> {
    let bun = required(settings, settings::BUN, "bun")?;
    let repo = required(settings, settings::REPO, "the repository")?;
    Ok(CommandSpec {
        program: PathBuf::from(bun),
        args: vec![
            Path::new(repo)
                .join("src/cli/claude-ai-export-convert.ts")
                .to_string_lossy()
                .into_owned(),
            zip.to_string_lossy().into_owned(),
        ],
        env: command_env(settings, Path::new(bun), path),
    })
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PathKind {
    File,
    Directory,
    Missing,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct PathCheck {
    pub key: String,
    pub path: String,
    pub kind: PathKind,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct LastRun {
    pub started_at: String,
    pub finished_at: Option<String>,
    pub records_added: i64,
    pub errors: Option<String>,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct DatabaseCheck {
    pub exists: bool,
    pub schema_version: Option<i64>,
    pub records: Option<i64>,
    pub sessions: Option<i64>,
    pub last_run: Option<LastRun>,
    pub error: Option<String>,
}

pub fn check_paths(settings: &[Setting]) -> Vec<PathCheck> {
    settings
        .iter()
        .filter_map(|s| s.value.as_ref().map(|v| (s.key.clone(), v.clone())))
        .map(|(key, path)| {
            let p = Path::new(&path);
            let kind = if p.is_file() {
                PathKind::File
            } else if p.is_dir() {
                PathKind::Directory
            } else {
                PathKind::Missing
            };
            PathCheck { key, path, kind }
        })
        .collect()
}

fn database_stats(path: &Path) -> rusqlite::Result<DatabaseCheck> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let count = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0)).ok();
    let last_run = conn
        .query_row(
            "SELECT started_at, finished_at, records_added, errors FROM runs ORDER BY id DESC LIMIT 1",
            [],
            |r| {
                Ok(LastRun {
                    started_at: r.get(0)?,
                    finished_at: r.get(1)?,
                    records_added: r.get(2)?,
                    errors: r.get(3)?,
                })
            },
        )
        .ok();
    Ok(DatabaseCheck {
        exists: true,
        schema_version: Some(version),
        records: count("SELECT count(*) FROM records"),
        sessions: count("SELECT count(*) FROM session_summaries"),
        last_run,
        error: None,
    })
}

pub fn check_database(path: &Path) -> DatabaseCheck {
    if !path.is_file() {
        return DatabaseCheck {
            exists: false,
            schema_version: None,
            records: None,
            sessions: None,
            last_run: None,
            error: None,
        };
    }
    database_stats(path).unwrap_or_else(|e| DatabaseCheck {
        exists: true,
        schema_version: None,
        records: None,
        sessions: None,
        last_run: None,
        error: Some(e.to_string()),
    })
}

/// Where to look for pm2: bun's directory, PATH, then bun's global bin directories.
pub fn pm2_candidates(bun: Option<&Path>, path: Option<&str>, home: Option<&str>) -> Vec<PathBuf> {
    let beside_bun = bun.and_then(Path::parent).map(|d| d.join("pm2"));
    let from_path = path
        .into_iter()
        .flat_map(|p| p.split(':'))
        .filter(|dir| !dir.is_empty())
        .map(|dir| Path::new(dir).join("pm2"));
    let from_home = home
        .into_iter()
        .flat_map(|h| [".bun/bin/pm2", ".cache/.bun/bin/pm2"].map(|rel| Path::new(h).join(rel)));
    beside_bun
        .into_iter()
        .chain(from_path)
        .chain(from_home)
        .collect()
}

/// The last `lines` lines of `text`.
pub fn tail(text: &str, lines: usize) -> String {
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::Origin;

    fn setting(key: &str, value: &str) -> Setting {
        Setting {
            key: key.into(),
            value: Some(value.into()),
            origin: Origin::Default,
        }
    }

    fn sample() -> Vec<Setting> {
        vec![
            setting(settings::DB, "/d/logs.sqlite"),
            setting(settings::CLAUDE_CONFIG_DIR, "/h/.claude"),
            setting(settings::DESKTOP_DIR, "/h/desk"),
            setting(settings::CLAUDE_AI_DIR, "/d/claude-ai"),
            setting(settings::REPO, "/repo"),
            setting(settings::BUN, "/tools/bin/bun"),
        ]
    }

    #[test]
    fn builds_the_sync_command() {
        let spec = sync_command(&sample(), Some("/usr/bin:/bin")).unwrap();
        assert_eq!(spec.program, PathBuf::from("/bin/sh"));
        assert_eq!(spec.args, vec!["/repo/bin/sync"]);
        assert_eq!(
            spec.env,
            vec![
                ("PATH".to_string(), "/tools/bin:/usr/bin:/bin".to_string()),
                (settings::DB.to_string(), "/d/logs.sqlite".to_string()),
                (
                    settings::CLAUDE_CONFIG_DIR.to_string(),
                    "/h/.claude".to_string()
                ),
                (settings::DESKTOP_DIR.to_string(), "/h/desk".to_string()),
                (
                    settings::CLAUDE_AI_DIR.to_string(),
                    "/d/claude-ai".to_string()
                ),
            ]
        );
    }

    #[test]
    fn builds_the_convert_command() {
        let spec = convert_command(&sample(), None, Path::new("/dl/export.zip")).unwrap();
        assert_eq!(spec.program, PathBuf::from("/tools/bin/bun"));
        assert_eq!(
            spec.args,
            vec![
                "/repo/src/cli/claude-ai-export-convert.ts",
                "/dl/export.zip"
            ]
        );
        assert_eq!(spec.env[0], ("PATH".to_string(), "/tools/bin".to_string()));
    }

    #[test]
    fn needs_bun_and_the_repository() {
        let without = |key: &str| {
            sample()
                .into_iter()
                .filter(|s| s.key != key)
                .collect::<Vec<_>>()
        };
        assert!(sync_command(&without(settings::BUN), None).is_err());
        assert!(sync_command(&without(settings::REPO), None).is_err());
    }

    #[test]
    fn checks_paths() {
        let dir = std::env::temp_dir().join(format!("ai-chat-logs-setup-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("logs.sqlite");
        std::fs::write(&file, "").unwrap();
        let s = vec![
            setting(settings::DB, file.to_str().unwrap()),
            setting(settings::CLAUDE_CONFIG_DIR, dir.to_str().unwrap()),
            setting(settings::DESKTOP_DIR, "/definitely/missing"),
        ];
        let kinds: Vec<_> = check_paths(&s)
            .into_iter()
            .map(|c| (c.key, c.kind))
            .collect();
        assert_eq!(
            kinds,
            vec![
                (settings::DB.to_string(), PathKind::File),
                (settings::CLAUDE_CONFIG_DIR.to_string(), PathKind::Directory),
                (settings::DESKTOP_DIR.to_string(), PathKind::Missing),
            ]
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn checks_a_missing_an_old_and_a_current_database() {
        let missing = check_database(Path::new("/definitely/missing.sqlite"));
        assert!(!missing.exists);
        assert_eq!(missing.schema_version, None);

        let path = crate::store::scratch_path("check");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(include_str!("../../../schema/0001-initial.sql"))
            .unwrap();
        conn.execute_batch("PRAGMA user_version = 1").unwrap();
        let old = check_database(&path);
        assert_eq!((old.exists, old.schema_version), (true, Some(1)));

        conn.execute_batch(include_str!(
            "../../../schema/0002-search-and-summaries.sql"
        ))
        .unwrap();
        conn.execute_batch(include_str!("../../../schema/0003-other-providers.sql"))
            .unwrap();
        conn.execute_batch(
            "PRAGMA user_version = 3;
             INSERT INTO runs (started_at, finished_at, records_added) VALUES ('t1', 't2', 5), ('t3', 't4', 7);",
        )
        .unwrap();
        let current = check_database(&path);
        assert_eq!(current.schema_version, Some(3));
        assert_eq!(current.records, Some(0));
        assert_eq!(current.sessions, Some(0));
        assert_eq!(
            current.last_run,
            Some(LastRun {
                started_at: "t3".into(),
                finished_at: Some("t4".into()),
                records_added: 7,
                errors: None
            })
        );
    }

    #[test]
    fn lists_pm2_candidates_in_order() {
        assert_eq!(
            pm2_candidates(Some(Path::new("/tools/bin/bun")), Some("/a"), Some("/h")),
            vec![
                PathBuf::from("/tools/bin/pm2"),
                PathBuf::from("/a/pm2"),
                PathBuf::from("/h/.bun/bin/pm2"),
                PathBuf::from("/h/.cache/.bun/bin/pm2"),
            ]
        );
    }

    #[test]
    fn keeps_the_last_lines() {
        assert_eq!(tail("a\nb\nc\n", 2), "b\nc");
        assert_eq!(tail("a", 5), "a");
    }
}
