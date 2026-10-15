//! docs/adr/0005: where the GUI looks for the database (the same rule as docs/adr/0001, without .env).

use std::path::PathBuf;

/// `AI_CHAT_LOGS_DB`, or `${XDG_DATA_HOME:-$HOME/.local/share}/ai-chat-logs/logs.sqlite`.
/// `None` when neither the database path nor a base directory can be determined.
pub fn database_path(var: impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    let non_empty = |name: &str| var(name).filter(|v| !v.is_empty());
    non_empty("AI_CHAT_LOGS_DB").map(PathBuf::from).or_else(|| {
        non_empty("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| non_empty("HOME").map(|home| PathBuf::from(home).join(".local/share")))
            .map(|base| base.join("ai-chat-logs/logs.sqlite"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn lookup(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |name| map.get(name).cloned()
    }

    #[test]
    fn defaults_to_logs_sqlite_under_the_home_directory() {
        assert_eq!(
            database_path(lookup(&[("HOME", "/home/u")])),
            Some(PathBuf::from(
                "/home/u/.local/share/ai-chat-logs/logs.sqlite"
            ))
        );
    }

    #[test]
    fn uses_xdg_data_home() {
        assert_eq!(
            database_path(lookup(&[("HOME", "/home/u"), ("XDG_DATA_HOME", "/data")])),
            Some(PathBuf::from("/data/ai-chat-logs/logs.sqlite"))
        );
    }

    #[test]
    fn prefers_ai_chat_logs_db() {
        assert_eq!(
            database_path(lookup(&[
                ("HOME", "/home/u"),
                ("XDG_DATA_HOME", "/data"),
                ("AI_CHAT_LOGS_DB", "/x/y.sqlite")
            ])),
            Some(PathBuf::from("/x/y.sqlite"))
        );
    }

    #[test]
    fn ignores_empty_values_and_needs_some_base() {
        assert_eq!(database_path(lookup(&[("AI_CHAT_LOGS_DB", "")])), None);
    }
}
