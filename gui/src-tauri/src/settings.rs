//! docs/adr/0007: settings resolved from the environment, the repository .env, the config file and defaults,
//! and edits of the config file.

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub const DB: &str = "AI_CHAT_LOGS_DB";
pub const CLAUDE_CONFIG_DIR: &str = "CLAUDE_CONFIG_DIR";
pub const DESKTOP_DIR: &str = "AI_CHAT_LOGS_CLAUDE_DESKTOP_DIR";
pub const CLAUDE_AI_DIR: &str = "AI_CHAT_LOGS_CLAUDE_AI_DIR";
/// docs/adr/0010: where downloaded claude.ai exports are picked up.
pub const CLAUDE_AI_INBOX: &str = "AI_CHAT_LOGS_CLAUDE_AI_INBOX";
pub const REPO: &str = "AI_CHAT_LOGS_REPO";
pub const BUN: &str = "AI_CHAT_LOGS_BUN";

/// The settings shown and edited on the settings screen, in display order.
pub const KEYS: [&str; 7] = [
    DB,
    CLAUDE_CONFIG_DIR,
    DESKTOP_DIR,
    CLAUDE_AI_DIR,
    CLAUDE_AI_INBOX,
    REPO,
    BUN,
];

/// Settings passed to the CLI commands as environment variables.
pub const CLI_KEYS: [&str; 5] = [
    DB,
    CLAUDE_CONFIG_DIR,
    DESKTOP_DIR,
    CLAUDE_AI_DIR,
    CLAUDE_AI_INBOX,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    Environment,
    EnvFile,
    ConfigFile,
    Default,
}

/// Values from the environment, the repository .env and the config file, highest priority first.
pub struct Layers {
    pub env: HashMap<String, String>,
    pub env_file: Vec<(String, String)>,
    pub config: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Setting {
    pub key: String,
    pub value: Option<String>,
    pub origin: Origin,
}

/// The first non-empty value of `key` and where it came from.
pub fn lookup(layers: &Layers, key: &str) -> Option<(String, Origin)> {
    let in_pairs = |pairs: &[(String, String)]| {
        pairs
            .iter()
            .rev()
            .find(|(k, v)| k == key && !v.is_empty())
            .map(|(_, v)| v.clone())
    };
    layers
        .env
        .get(key)
        .filter(|v| !v.is_empty())
        .cloned()
        .map(|v| (v, Origin::Environment))
        .or_else(|| in_pairs(&layers.env_file).map(|v| (v, Origin::EnvFile)))
        .or_else(|| in_pairs(&layers.config).map(|v| (v, Origin::ConfigFile)))
}

/// Every setting of KEYS. `repo_default` is the repository at build time; `bun_default` is the bun found
/// on the machine.
pub fn resolve(layers: &Layers, repo_default: &Path, bun_default: Option<&Path>) -> Vec<Setting> {
    let get = |key: &str| lookup(layers, key).map(|(v, _)| v);
    let home = get("HOME").map(PathBuf::from);
    let data_home = get("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| home.as_ref().map(|h| h.join(".local/share")));
    let text = |p: PathBuf| p.to_string_lossy().into_owned();
    let default = |key: &str| -> Option<String> {
        match key {
            DB => data_home
                .clone()
                .map(|d| text(d.join("ai-chat-logs/logs.sqlite"))),
            CLAUDE_CONFIG_DIR => home.clone().map(|h| text(h.join(".claude"))),
            DESKTOP_DIR => home
                .clone()
                .map(|h| text(h.join("Library/Application Support/Claude"))),
            CLAUDE_AI_DIR => data_home
                .clone()
                .map(|d| text(d.join("ai-chat-logs/claude-ai"))),
            CLAUDE_AI_INBOX => home.clone().map(|h| text(h.join("Downloads"))),
            REPO => Some(text(repo_default.to_path_buf())),
            BUN => bun_default.map(|b| text(b.to_path_buf())),
            _ => None,
        }
    };
    KEYS.iter()
        .map(|&key| match lookup(layers, key) {
            Some((value, origin)) => Setting {
                key: key.to_owned(),
                value: Some(value),
                origin,
            },
            None => Setting {
                key: key.to_owned(),
                value: default(key),
                origin: Origin::Default,
            },
        })
        .collect()
}

/// The value of a resolved setting.
pub fn value<'a>(settings: &'a [Setting], key: &str) -> Option<&'a str> {
    settings
        .iter()
        .find(|s| s.key == key)
        .and_then(|s| s.value.as_deref())
}

/// The config file: AI_CHAT_LOGS_CONFIG, or ${XDG_CONFIG_HOME:-$HOME/.config}/ai-chat-logs/config.env.
pub fn config_path(env: &HashMap<String, String>) -> Option<PathBuf> {
    let get = |k: &str| env.get(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    get("AI_CHAT_LOGS_CONFIG").or_else(|| {
        get("XDG_CONFIG_HOME")
            .or_else(|| get("HOME").map(|h| h.join(".config")))
            .map(|base| base.join("ai-chat-logs/config.env"))
    })
}

/// The name a config line assigns, if any (`NAME=...` or `export NAME=...`).
fn assigned_name(line: &str) -> Option<&str> {
    let trimmed = line.trim();
    let body = trimmed
        .strip_prefix("export")
        .filter(|rest| rest.starts_with(char::is_whitespace))
        .map_or(trimmed, str::trim_start);
    body.split_once('=').map(|(name, _)| name.trim())
}

fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The config file text with `key` set to `value`, or removed when `value` is empty or `None`.
pub fn update_config(text: &str, key: &str, value: Option<&str>) -> Result<String, String> {
    if !KEYS.contains(&key) {
        return Err(format!("{key} cannot be set here"));
    }
    let value = value.filter(|v| !v.is_empty());
    if value.is_some_and(|v| v.contains(['\n', '\r'])) {
        return Err(format!("{key} must not contain a line break"));
    }
    let replacement = value.map(|v| format!("{key}={}", quote(v)));
    let lines: Vec<&str> = text.lines().collect();
    let first = lines.iter().position(|l| assigned_name(l) == Some(key));
    let kept: Vec<String> = lines
        .iter()
        .enumerate()
        .filter_map(
            |(i, l)| match (assigned_name(l) == Some(key), Some(i) == first) {
                (false, _) => Some(l.to_string()),
                (true, true) => replacement.clone(),
                (true, false) => None,
            },
        )
        .collect();
    let all = match (first, replacement) {
        (None, Some(line)) => [kept, vec![line]].concat(),
        _ => kept,
    };
    Ok(all.iter().map(|l| format!("{l}\n")).collect())
}

/// Writes the config file through a temporary file, creating its directory.
pub fn save_config(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let partial = path.with_extension("env.tmp");
    std::fs::write(&partial, text)?;
    std::fs::rename(&partial, path)
}

/// Where to look for bun after AI_CHAT_LOGS_BUN: PATH, then common install locations.
pub fn bun_candidates(path: Option<&str>, home: Option<&str>) -> Vec<PathBuf> {
    let from_path = path
        .into_iter()
        .flat_map(|p| p.split(':'))
        .filter(|dir| !dir.is_empty())
        .map(|dir| Path::new(dir).join("bun"));
    let from_home = home.into_iter().flat_map(|h| {
        [".bun/bin/bun", ".local/share/mise/shims/bun"].map(|rel| Path::new(h).join(rel))
    });
    let fixed = ["/opt/homebrew/bin/bun", "/usr/local/bin/bun"].map(PathBuf::from);
    from_path.chain(from_home).chain(fixed).collect()
}

/// The first candidate accepted by `is_executable`.
pub fn find_executable(
    candidates: &[PathBuf],
    is_executable: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    candidates.iter().find(|p| is_executable(p)).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dotenv;

    fn layers(env: &[(&str, &str)], env_file: &[(&str, &str)], config: &[(&str, &str)]) -> Layers {
        let pairs = |v: &[(&str, &str)]| {
            v.iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
        };
        Layers {
            env: env
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            env_file: pairs(env_file),
            config: pairs(config),
        }
    }

    #[test]
    fn looks_up_in_priority_order_skipping_empty_values() {
        let l = layers(
            &[("A", "env"), ("E", "")],
            &[("A", "file"), ("B", "file"), ("E", "file")],
            &[("B", "conf"), ("C", "conf")],
        );
        assert_eq!(lookup(&l, "A"), Some(("env".into(), Origin::Environment)));
        assert_eq!(lookup(&l, "B"), Some(("file".into(), Origin::EnvFile)));
        assert_eq!(lookup(&l, "C"), Some(("conf".into(), Origin::ConfigFile)));
        assert_eq!(lookup(&l, "E"), Some(("file".into(), Origin::EnvFile)));
        assert_eq!(lookup(&l, "D"), None);
    }

    #[test]
    fn resolves_defaults_from_home_and_xdg_data_home() {
        let l = layers(&[("HOME", "/h")], &[], &[("XDG_DATA_HOME", "/data")]);
        let s = resolve(&l, Path::new("/repo"), Some(Path::new("/bin/bun")));
        let get = |k: &str| s.iter().find(|x| x.key == k).cloned().unwrap();
        assert_eq!(
            get(DB),
            Setting {
                key: DB.into(),
                value: Some("/data/ai-chat-logs/logs.sqlite".into()),
                origin: Origin::Default
            }
        );
        assert_eq!(get(CLAUDE_CONFIG_DIR).value.as_deref(), Some("/h/.claude"));
        assert_eq!(
            get(DESKTOP_DIR).value.as_deref(),
            Some("/h/Library/Application Support/Claude")
        );
        assert_eq!(
            get(CLAUDE_AI_DIR).value.as_deref(),
            Some("/data/ai-chat-logs/claude-ai")
        );
        assert_eq!(get(CLAUDE_AI_INBOX).value.as_deref(), Some("/h/Downloads"));
        assert_eq!(get(REPO).value.as_deref(), Some("/repo"));
        assert_eq!(get(BUN).value.as_deref(), Some("/bin/bun"));
        assert_eq!(
            s.iter().map(|x| x.key.as_str()).collect::<Vec<_>>(),
            KEYS.to_vec()
        );
    }

    #[test]
    fn resolves_set_values_with_their_origin() {
        let l = layers(
            &[("HOME", "/h"), (DB, "/env.sqlite")],
            &[(CLAUDE_CONFIG_DIR, "/file")],
            &[(DB, "/conf.sqlite"), (BUN, "/conf/bun")],
        );
        let s = resolve(&l, Path::new("/repo"), None);
        let get = |k: &str| s.iter().find(|x| x.key == k).cloned().unwrap();
        assert_eq!(
            (get(DB).value.unwrap(), get(DB).origin),
            ("/env.sqlite".into(), Origin::Environment)
        );
        assert_eq!(get(CLAUDE_CONFIG_DIR).origin, Origin::EnvFile);
        assert_eq!(
            (get(BUN).value.unwrap(), get(BUN).origin),
            ("/conf/bun".into(), Origin::ConfigFile)
        );
    }

    #[test]
    fn bun_has_no_value_when_nothing_is_found() {
        let s = resolve(
            &layers(&[("HOME", "/h")], &[], &[]),
            Path::new("/repo"),
            None,
        );
        assert_eq!(value(&s, BUN), None);
    }

    #[test]
    fn config_path_follows_the_environment() {
        let env = |pairs: &[(&str, &str)]| {
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
        };
        assert_eq!(
            config_path(&env(&[("HOME", "/h")])),
            Some(PathBuf::from("/h/.config/ai-chat-logs/config.env"))
        );
        assert_eq!(
            config_path(&env(&[("HOME", "/h"), ("XDG_CONFIG_HOME", "/x")])),
            Some(PathBuf::from("/x/ai-chat-logs/config.env"))
        );
        assert_eq!(
            config_path(&env(&[("HOME", "/h"), ("AI_CHAT_LOGS_CONFIG", "/c.env")])),
            Some(PathBuf::from("/c.env"))
        );
        assert_eq!(config_path(&env(&[])), None);
    }

    #[test]
    fn updates_the_first_line_and_removes_duplicates_keeping_others() {
        let text =
            "# settings\nOTHER=1\nAI_CHAT_LOGS_DB=/old\nexport AI_CHAT_LOGS_DB=\"/dup\"\nLAST=2\n";
        assert_eq!(
            update_config(text, DB, Some("/new path")).unwrap(),
            "# settings\nOTHER=1\nAI_CHAT_LOGS_DB=\"/new path\"\nLAST=2\n"
        );
    }

    #[test]
    fn appends_missing_keys_and_removes_empty_ones() {
        assert_eq!(
            update_config("A=1", DB, Some("/x")).unwrap(),
            "A=1\nAI_CHAT_LOGS_DB=\"/x\"\n"
        );
        assert_eq!(
            update_config("", DB, Some("/x")).unwrap(),
            "AI_CHAT_LOGS_DB=\"/x\"\n"
        );
        assert_eq!(
            update_config("A=1\nAI_CHAT_LOGS_DB=/x\n", DB, Some("")).unwrap(),
            "A=1\n"
        );
        assert_eq!(
            update_config("A=1\nAI_CHAT_LOGS_DB=/x\n", DB, None).unwrap(),
            "A=1\n"
        );
    }

    #[test]
    fn escapes_values_so_that_they_read_back() {
        let tricky = r#"C:\dir "quoted" # not a comment 日本語"#;
        let text = update_config("", DB, Some(tricky)).unwrap();
        assert_eq!(
            dotenv::parse(&text).unwrap(),
            vec![(DB.to_string(), tricky.to_string())]
        );
    }

    #[test]
    fn rejects_newlines_and_unknown_keys() {
        assert!(update_config("", DB, Some("a\nb")).is_err());
        assert!(update_config("", DB, Some("a\rb")).is_err());
        assert!(update_config("", "PATH", Some("/x")).is_err());
    }

    #[test]
    fn saves_through_a_temporary_file_creating_the_directory() {
        let dir = std::env::temp_dir().join(format!(
            "ai-chat-logs-settings-{}-{}",
            std::process::id(),
            line!()
        ));
        let path = dir.join("nested/config.env");
        save_config(&path, "A=1\n").unwrap();
        save_config(&path, "A=2\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "A=2\n");
        assert_eq!(
            std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
            1
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn lists_bun_candidates_in_order() {
        assert_eq!(
            bun_candidates(Some("/a:/b"), Some("/h")),
            vec![
                PathBuf::from("/a/bun"),
                PathBuf::from("/b/bun"),
                PathBuf::from("/h/.bun/bin/bun"),
                PathBuf::from("/h/.local/share/mise/shims/bun"),
                PathBuf::from("/opt/homebrew/bin/bun"),
                PathBuf::from("/usr/local/bin/bun"),
            ]
        );
        assert_eq!(
            bun_candidates(None, None),
            vec![
                PathBuf::from("/opt/homebrew/bin/bun"),
                PathBuf::from("/usr/local/bin/bun")
            ]
        );
    }

    #[test]
    fn finds_the_first_executable() {
        let c = vec![
            PathBuf::from("/a/bun"),
            PathBuf::from("/b/bun"),
            PathBuf::from("/c/bun"),
        ];
        assert_eq!(
            find_executable(&c, |p| p != Path::new("/a/bun")),
            Some(PathBuf::from("/b/bun"))
        );
        assert_eq!(find_executable(&c, |_| false), None);
    }
}
