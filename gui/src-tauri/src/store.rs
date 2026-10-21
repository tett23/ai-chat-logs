//! docs/adr/0003, docs/adr/0005: read-only queries over the database written by chat-log-import.

use crate::blocks::{Block, to_blocks, truncate};
use crate::query::{HIT_END, HIT_START, SearchPlan, make_snippet};
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params, params_from_iter};
use serde::Serialize;
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;

/// The schema version (PRAGMA user_version) whose tables the GUI reads.
pub const REQUIRED_SCHEMA_VERSION: i64 = 2;

const SNIPPET_CONTEXT: usize = 32;

/// Folded blocks longer than this many characters are cut in get_session (docs/adr/0005).
const MAX_BLOCK_CHARS: usize = 4000;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StoreError {
    NotFound {
        path: String,
    },
    OldSchema {
        found: i64,
        required: i64,
    },
    Sqlite {
        message: String,
    },
    /// The settings could not be read (docs/adr/0007).
    Settings {
        message: String,
    },
}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        StoreError::Sqlite {
            message: e.to_string(),
        }
    }
}

pub type Result<T> = std::result::Result<T, StoreError>;

pub fn open_read_only(path: &Path) -> Result<Connection> {
    if !path.is_file() {
        return Err(StoreError::NotFound {
            path: path.display().to_string(),
        });
    }
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(std::time::Duration::from_secs(10))?;
    let found: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if found < REQUIRED_SCHEMA_VERSION {
        return Err(StoreError::OldSchema {
            found,
            required: REQUIRED_SCHEMA_VERSION,
        });
    }
    Ok(conn)
}

#[derive(Debug, PartialEq, Serialize)]
pub struct SessionSummary {
    pub provider: String,
    pub session_id: String,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub first_at: Option<String>,
    pub last_at: Option<String>,
    pub message_count: i64,
}

/// Sessions newest first, optionally narrowed to a provider and a cwd (docs/adr/0006).
pub fn list_sessions(
    conn: &Connection,
    provider: Option<&str>,
    cwd: Option<&str>,
    offset: i64,
    limit: i64,
) -> Result<Vec<SessionSummary>> {
    let mut stmt = conn.prepare_cached(
        "SELECT provider, session_id, cwd, title, first_at, last_at, message_count
         FROM session_summaries
         WHERE (?1 IS NULL OR provider = ?1) AND (?2 IS NULL OR cwd = ?2)
         ORDER BY last_at DESC, session_id
         LIMIT ?3 OFFSET ?4",
    )?;
    let rows = stmt.query_map(params![provider, cwd, limit, offset], |row| {
        Ok(SessionSummary {
            provider: row.get(0)?,
            session_id: row.get(1)?,
            cwd: row.get(2)?,
            title: row.get(3)?,
            first_at: row.get(4)?,
            last_at: row.get(5)?,
            message_count: row.get(6)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Project {
    pub provider: String,
    pub cwd: Option<String>,
    pub session_count: i64,
}

pub fn list_projects(conn: &Connection) -> Result<Vec<Project>> {
    let mut stmt = conn.prepare_cached(
        "SELECT provider, cwd, count(*) FROM session_summaries
         GROUP BY provider, cwd ORDER BY max(last_at) DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(Project {
            provider: row.get(0)?,
            cwd: row.get(1)?,
            session_count: row.get(2)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Message {
    /// records.rowid, for get_block
    pub rowid: i64,
    /// The number of the message in its session, from 1, without copies (docs/adr/0014).
    pub index: usize,
    pub uuid: Option<String>,
    pub timestamp: Option<String>,
    pub role: Option<String>,
    pub model: Option<String>,
    pub is_sidechain: bool,
    pub blocks: Vec<Block>,
}

fn content_blocks(value: &serde_json::Value) -> Vec<Block> {
    to_blocks(value.get("message").and_then(|m| m.get("content")))
}

fn to_message(
    rowid: i64,
    index: usize,
    uuid: Option<String>,
    timestamp: Option<String>,
    raw: &str,
) -> Message {
    let value: serde_json::Value = serde_json::from_str(raw).unwrap_or_default();
    let message = value.get("message");
    let text = |v: Option<&serde_json::Value>| v.and_then(|v| v.as_str()).map(str::to_owned);
    Message {
        rowid,
        index,
        uuid,
        timestamp,
        role: text(message.and_then(|m| m.get("role"))),
        model: text(message.and_then(|m| m.get("model"))),
        is_sidechain: value
            .get("isSidechain")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        blocks: content_blocks(&value)
            .into_iter()
            .map(|b| truncate(b, MAX_BLOCK_CHARS))
            .collect(),
    }
}

/// A page of the messages of a session and how many there are (docs/adr/0014).
#[derive(Debug, PartialEq, Serialize)]
pub struct MessagePage {
    pub total: usize,
    pub messages: Vec<Message>,
}

/// Messages numbered from 1 in file and line order, each copied record once (docs/adr/0005),
/// whose numbers are in [from, from + limit).
pub fn get_messages(
    conn: &Connection,
    session_id: &str,
    from: usize,
    limit: usize,
) -> Result<MessagePage> {
    // session_summaries.message_count counts the same rows (session_messages); counting them
    // again scans the whole session.
    let total = conn
        .query_row(
            "SELECT sum(message_count) FROM session_summaries WHERE session_id = ?1",
            params![session_id],
            |row| row.get::<_, Option<i64>>(0),
        )?
        .unwrap_or(0) as usize;
    let to = from.saturating_add(limit).saturating_sub(1);
    let mut stmt = conn.prepare_cached(
        "SELECT x.record_rowid, x.idx, r.uuid, r.timestamp, r.raw
         FROM (SELECT record_rowid, row_number() OVER (ORDER BY coalesce(timestamp, ''), path, generation, line_no) AS idx
               FROM session_messages WHERE session_id = ?1) x
         JOIN records r ON r.rowid = x.record_rowid
         WHERE x.idx BETWEEN ?2 AND ?3
         ORDER BY x.idx",
    )?;
    let rows = stmt.query_map(params![session_id, from as i64, to as i64], |row| {
        let raw: String = row.get(4)?;
        Ok(to_message(
            row.get(0)?,
            row.get::<_, i64>(1)? as usize,
            row.get(2)?,
            row.get(3)?,
            &raw,
        ))
    })?;
    Ok(MessagePage {
        total,
        messages: rows.collect::<rusqlite::Result<_>>()?,
    })
}

/// The number get_messages gives to the record at `rowid`, if it is a message.
fn message_index(conn: &Connection, rowid: i64) -> Result<Option<usize>> {
    let at = conn
        .query_row(
            "SELECT provider, session_id, coalesce(timestamp, ''), path, generation, line_no
             FROM session_messages WHERE record_rowid = ?1",
            params![rowid],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            },
        )
        .optional()?;
    match at {
        None => Ok(None),
        Some((provider, session, time, path, generation, line)) => Ok(Some(conn.query_row(
            "SELECT count(*) FROM session_messages
             WHERE provider = ?1 AND session_id = ?2 AND (coalesce(timestamp, ''), path, generation, line_no) <= (?3, ?4, ?5, ?6)",
            params![provider, session, time, path, generation, line],
            |row| row.get::<_, i64>(0),
        )? as usize)),
    }
}

/// The whole block at `index` of the record at `rowid` (docs/adr/0005).
pub fn get_block(conn: &Connection, rowid: i64, index: usize) -> Result<Block> {
    let raw: String = conn.query_row(
        "SELECT raw FROM records WHERE rowid = ?1",
        params![rowid],
        |row| row.get(0),
    )?;
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap_or_default();
    content_blocks(&value)
        .into_iter()
        .nth(index)
        .ok_or_else(|| StoreError::Sqlite {
            message: format!("no block {index} in record {rowid}"),
        })
}

#[derive(Debug, PartialEq, Serialize)]
pub struct SearchHit {
    pub provider: String,
    pub session_id: Option<String>,
    /// The number of the message in its session (docs/adr/0014).
    pub index: Option<usize>,
    pub uuid: Option<String>,
    pub timestamp: Option<String>,
    pub role: Option<String>,
    pub title: Option<String>,
    pub snippet: String,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    /// Some terms are shorter than three characters and the whole table was scanned.
    pub slow: bool,
}

/// SQL and parameters for a search plan.
fn search_sql(
    plan: &SearchPlan,
    provider: Option<&str>,
    cwd: Option<&str>,
    offset: i64,
    limit: i64,
) -> (String, Vec<SqlValue>) {
    let snippet = match plan.fts {
        Some(_) => format!("snippet(record_texts, 0, '{HIT_START}', '{HIT_END}', '…', 16)"),
        None => "record_texts.text".to_owned(),
    };
    let conditions: Vec<(String, SqlValue)> = plan
        .fts
        .iter()
        .map(|q| ("record_texts MATCH ?".to_owned(), SqlValue::Text(q.clone())))
        .chain(plan.likes.iter().map(|p| {
            (
                "record_texts.text LIKE ? ESCAPE '\\'".to_owned(),
                SqlValue::Text(p.clone()),
            )
        }))
        .chain(provider.map(|p| ("s.provider = ?".to_owned(), SqlValue::Text(p.to_owned()))))
        .chain(cwd.map(|c| ("ss.cwd = ?".to_owned(), SqlValue::Text(c.to_owned()))))
        .collect();
    let where_clause = conditions
        .iter()
        .map(|(c, _)| c.as_str())
        .collect::<Vec<_>>()
        .join(" AND ");
    let sql = format!(
        "SELECT s.provider, r.session_id, r.uuid, r.timestamp, r.raw ->> '$.message.role', ss.title, {snippet}, r.rowid
         FROM record_texts
         JOIN records r ON r.rowid = record_texts.rowid
         JOIN sources s ON s.id = r.source_id
         LEFT JOIN session_summaries ss ON ss.provider = s.provider AND ss.session_id = r.session_id
         WHERE {where_clause}
           AND NOT EXISTS (SELECT 1 FROM copied_records c WHERE c.record_rowid = r.rowid)
         ORDER BY r.timestamp DESC, r.rowid DESC
         LIMIT ? OFFSET ?"
    );
    let params = conditions
        .into_iter()
        .map(|(_, v)| v)
        .chain([SqlValue::Integer(limit), SqlValue::Integer(offset)])
        .collect();
    (sql, params)
}

pub fn search(
    conn: &Connection,
    plan: &SearchPlan,
    provider: Option<&str>,
    cwd: Option<&str>,
    offset: i64,
    limit: i64,
) -> Result<SearchResult> {
    if plan.is_empty() {
        return Ok(SearchResult {
            hits: vec![],
            slow: false,
        });
    }
    let (sql, values) = search_sql(plan, provider, cwd, offset, limit);
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(values), |row| {
        let text: String = row.get(6)?;
        let rowid: i64 = row.get(7)?;
        Ok((
            rowid,
            SearchHit {
                provider: row.get(0)?,
                session_id: row.get(1)?,
                index: None,
                uuid: row.get(2)?,
                timestamp: row.get(3)?,
                role: row.get(4)?,
                title: row.get(5)?,
                snippet: match plan.fts {
                    Some(_) => text,
                    None => make_snippet(&text, &plan.terms, SNIPPET_CONTEXT),
                },
            },
        ))
    })?;
    let found = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    let hits = found
        .into_iter()
        .map(|(rowid, hit)| message_index(conn, rowid).map(|index| SearchHit { index, ..hit }))
        .collect::<Result<Vec<_>>>()?;
    Ok(SearchResult {
        hits,
        slow: plan.is_slow(),
    })
}

/// A path for a scratch database used by tests.
#[cfg(test)]
pub fn scratch_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "ai-chat-logs-gui-{}-{}-{name}.sqlite",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::query::plan_search;
    use serde_json::json;

    const SCHEMA: [&str; 3] = [
        include_str!("../../../schema/0001-initial.sql"),
        include_str!("../../../schema/0002-search-and-summaries.sql"),
        include_str!("../../../schema/0003-other-providers.sql"),
    ];

    struct Line {
        kind: &'static str,
        path: &'static str,
        session: &'static str,
        uuid: &'static str,
        timestamp: &'static str,
        cwd: &'static str,
        role: &'static str,
        content: serde_json::Value,
    }

    fn line(
        path: &'static str,
        session: &'static str,
        uuid: &'static str,
        timestamp: &'static str,
        role: &'static str,
        content: serde_json::Value,
    ) -> Line {
        Line {
            kind: "claude-code/transcript",
            path,
            session,
            uuid,
            timestamp,
            cwd: "/work/a",
            role,
            content,
        }
    }

    /// Writes the schema and the lines into a scratch database, as chat-log-import would.
    fn build(lines: &[Line]) -> PathBuf {
        let path = scratch_path("store");
        let conn = Connection::open(&path).unwrap();
        SCHEMA
            .iter()
            .for_each(|sql| conn.execute_batch(sql).unwrap());
        conn.execute_batch("PRAGMA user_version = 3").unwrap();
        lines.iter().enumerate().for_each(|(i, l)| {
            conn.execute(
                "INSERT OR IGNORE INTO sources (kind, path, first_seen_at, last_seen_at)
                 VALUES (?2, ?1, 'n', 'n')",
                params![l.path, l.kind],
            )
            .unwrap();
            let raw = json!({
                "type": l.role, "uuid": l.uuid, "sessionId": l.session, "timestamp": l.timestamp,
                "cwd": l.cwd, "isSidechain": l.path.contains("subagents"),
                "message": {"role": l.role, "model": "m", "content": l.content}
            });
            conn.execute(
                "INSERT INTO records (source_id, line_no, raw, imported_at, type, uuid, session_id, timestamp)
                 SELECT id, ?2, ?3, 'n', ?4, ?5, ?6, ?7 FROM sources WHERE path = ?1",
                params![l.path, i as i64 + 1, raw.to_string(), l.role, l.uuid, l.session, l.timestamp],
            )
            .unwrap();
        });
        conn.execute_batch(
            "INSERT INTO record_texts (rowid, text) SELECT record_rowid, text FROM record_text_source WHERE text <> '';
             INSERT INTO session_summaries SELECT * FROM session_summary_source;",
        )
        .unwrap();
        path
    }

    fn sample() -> PathBuf {
        let mut cwd_b = line(
            "/p/s2.jsonl",
            "s2",
            "u3",
            "2026-01-03T00:00:00Z",
            "user",
            json!("別プロジェクトの全文検索"),
        );
        cwd_b.cwd = "/work/b";
        build(&[
            line(
                "/p/s1.jsonl",
                "s1",
                "u1",
                "2026-01-01T00:00:00Z",
                "user",
                json!("全文検索のテスト 100% done_x"),
            ),
            line(
                "/p/s1.jsonl",
                "s1",
                "a1",
                "2026-01-01T00:01:00Z",
                "assistant",
                json!([{"type": "thinking", "thinking": "考える"}, {"type": "text", "text": "検索の答え"},
                       {"type": "tool_use", "name": "Bash", "input": {}}]),
            ),
            line(
                "/p/s1/subagents/agent-1.jsonl",
                "s1",
                "a2",
                "2026-01-01T00:00:30Z",
                "assistant",
                json!([{"type": "text", "text": "サブエージェント"}]),
            ),
            cwd_b,
        ])
    }

    #[test]
    fn opens_read_only() {
        let conn = open_read_only(&sample()).unwrap();
        assert!(conn.execute("DELETE FROM session_summaries", []).is_err());
    }

    #[test]
    fn reports_a_missing_database() {
        let path = scratch_path("missing");
        assert_eq!(
            open_read_only(&path).err(),
            Some(StoreError::NotFound {
                path: path.display().to_string()
            })
        );
    }

    #[test]
    fn reports_an_old_schema() {
        let path = scratch_path("old");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(SCHEMA[0]).unwrap();
        conn.execute_batch("PRAGMA user_version = 1").unwrap();
        assert_eq!(
            open_read_only(&path).err(),
            Some(StoreError::OldSchema {
                found: 1,
                required: 2
            })
        );
    }

    #[test]
    fn lists_sessions_newest_first_with_paging_and_cwd() {
        let conn = open_read_only(&sample()).unwrap();
        let ids = |v: Vec<SessionSummary>| v.into_iter().map(|s| s.session_id).collect::<Vec<_>>();
        assert_eq!(
            ids(list_sessions(&conn, None, None, 0, 10).unwrap()),
            vec!["s2", "s1"]
        );
        assert_eq!(
            ids(list_sessions(&conn, None, None, 1, 1).unwrap()),
            vec!["s1"]
        );
        assert_eq!(
            ids(list_sessions(&conn, None, Some("/work/a"), 0, 10).unwrap()),
            vec!["s1"]
        );
        let s1 = list_sessions(&conn, None, Some("/work/a"), 0, 1)
            .unwrap()
            .remove(0);
        assert_eq!(s1.message_count, 3);
        assert_eq!(s1.title.as_deref(), Some("全文検索のテスト 100% done_x"));
    }

    #[test]
    fn lists_projects() {
        let conn = open_read_only(&sample()).unwrap();
        assert_eq!(
            list_projects(&conn).unwrap(),
            vec![
                Project {
                    provider: "claude-code".into(),
                    cwd: Some("/work/b".into()),
                    session_count: 1
                },
                Project {
                    provider: "claude-code".into(),
                    cwd: Some("/work/a".into()),
                    session_count: 1
                },
            ]
        );
    }

    #[test]
    fn gets_session_messages_in_time_order() {
        // docs/adr/0016: a2 (a subagent's record at 00:00:30) comes between u1 and a1.
        let conn = open_read_only(&sample()).unwrap();
        let messages = get_messages(&conn, "s1", 1, 1000)
            .map(|p| p.messages)
            .unwrap();
        let uuids: Vec<_> = messages.iter().map(|m| m.uuid.clone().unwrap()).collect();
        assert_eq!(uuids, vec!["u1", "a2", "a1"]);
        assert!(matches!(messages[2].blocks[0], Block::Thinking { .. }));
        assert!(matches!(messages[2].blocks[2], Block::ToolUse { .. }));
        assert!(messages[1].is_sidechain);
        assert_eq!(messages[2].model.as_deref(), Some("m"));
    }

    #[test]
    fn breaks_ties_of_time_by_path_and_line() {
        let path = build(&[
            line(
                "/p/s9.jsonl",
                "s9",
                "m1",
                "2026-01-01T00:00:00Z",
                "user",
                json!("a"),
            ),
            line(
                "/p/s9.jsonl",
                "s9",
                "m2",
                "2026-01-01T00:00:05Z",
                "assistant",
                json!([{"type": "text", "text": "b"}]),
            ),
            line(
                "/p/s9/subagents/x.jsonl",
                "s9",
                "x1",
                "2026-01-01T00:00:05Z",
                "user",
                json!("c"),
            ),
            line(
                "/p/s9/subagents/x.jsonl",
                "s9",
                "x2",
                "2026-01-01T00:00:02Z",
                "assistant",
                json!([{"type": "text", "text": "d"}]),
            ),
        ]);
        let conn = open_read_only(&path).unwrap();
        let uuids: Vec<_> = get_messages(&conn, "s9", 1, 10)
            .unwrap()
            .messages
            .into_iter()
            .map(|m| m.uuid.unwrap())
            .collect();
        assert_eq!(uuids, vec!["m1", "x2", "m2", "x1"]);
    }

    #[test]
    fn searches_with_match_newest_first() {
        let conn = open_read_only(&sample()).unwrap();
        let result = search(&conn, &plan_search("全文検索"), None, None, 0, 10).unwrap();
        assert!(!result.slow);
        let uuids: Vec<_> = result
            .hits
            .iter()
            .map(|h| h.uuid.clone().unwrap())
            .collect();
        assert_eq!(uuids, vec!["u3", "u1"]);
        assert!(result.hits[1].snippet.contains("\u{E000}全文検索\u{E001}"));
        assert_eq!(
            result.hits[1].title.as_deref(),
            Some("全文検索のテスト 100% done_x")
        );
    }

    #[test]
    fn searches_short_terms_with_like() {
        let conn = open_read_only(&sample()).unwrap();
        let result = search(&conn, &plan_search("検索"), None, None, 0, 10).unwrap();
        assert!(result.slow);
        let uuids: Vec<_> = result
            .hits
            .iter()
            .map(|h| h.uuid.clone().unwrap())
            .collect();
        assert_eq!(uuids, vec!["u3", "a1", "u1"]);
        assert!(result.hits[1].snippet.contains("\u{E000}検索\u{E001}"));
    }

    #[test]
    fn combines_match_and_like_and_filters_by_cwd() {
        let conn = open_read_only(&sample()).unwrap();
        let both = search(&conn, &plan_search("全文検索 テ"), None, None, 0, 10).unwrap();
        assert_eq!(both.hits.len(), 1);
        let cwd = search(
            &conn,
            &plan_search("全文検索"),
            None,
            Some("/work/b"),
            0,
            10,
        )
        .unwrap();
        assert_eq!(cwd.hits.len(), 1);
        assert_eq!(cwd.hits[0].uuid.as_deref(), Some("u3"));
    }

    #[test]
    fn like_wildcards_match_literally() {
        let conn = open_read_only(&sample()).unwrap();
        assert_eq!(
            search(&conn, &plan_search("0%"), None, None, 0, 10)
                .unwrap()
                .hits
                .len(),
            1
        );
        assert_eq!(
            search(&conn, &plan_search("e_"), None, None, 0, 10)
                .unwrap()
                .hits
                .len(),
            1
        );
        assert_eq!(
            search(&conn, &plan_search("%"), None, None, 0, 10)
                .unwrap()
                .hits
                .len(),
            1
        );
        assert_eq!(
            search(&conn, &plan_search("_"), None, None, 0, 10)
                .unwrap()
                .hits
                .len(),
            1
        );
        assert_eq!(
            search(&conn, &plan_search("\\"), None, None, 0, 10)
                .unwrap()
                .hits
                .len(),
            0
        );
    }

    #[test]
    fn fts5_syntax_in_input_is_literal() {
        let conn = open_read_only(&sample()).unwrap();
        for input in [
            "\"全文検索",
            "全文* OR",
            "NEAR(全文 検索)",
            "全文検索 AND",
            "-全文検索",
        ] {
            assert!(
                search(&conn, &plan_search(input), None, None, 0, 10).is_ok(),
                "{input}"
            );
        }
        assert_eq!(
            search(&conn, &plan_search("NEAR"), None, None, 0, 10)
                .unwrap()
                .hits
                .len(),
            0
        );
    }

    fn with_copy() -> PathBuf {
        build(&[
            line(
                "/p/s1.jsonl",
                "s1",
                "u1",
                "2026-01-01T00:00:00Z",
                "user",
                json!("全文検索の原本"),
            ),
            line(
                "/p/s1.jsonl",
                "s1",
                "a1",
                "2026-01-01T00:01:00Z",
                "assistant",
                json!([{"type": "text", "text": "答え"}]),
            ),
            line(
                "/q/fork.jsonl",
                "s1",
                "u1",
                "2026-01-01T00:00:00Z",
                "user",
                json!("全文検索の原本"),
            ),
            line(
                "/q/fork.jsonl",
                "s1",
                "a1",
                "2026-01-01T00:01:00Z",
                "assistant",
                json!([{"type": "text", "text": "答え"}]),
            ),
            line(
                "/q/fork.jsonl",
                "s1",
                "u9",
                "2026-01-01T00:02:00Z",
                "user",
                json!("写しにだけある"),
            ),
        ])
    }

    #[test]
    fn shows_a_copied_record_once() {
        let conn = open_read_only(&with_copy()).unwrap();
        let uuids: Vec<_> = get_messages(&conn, "s1", 1, 1000)
            .map(|p| p.messages)
            .unwrap()
            .into_iter()
            .map(|m| m.uuid.unwrap())
            .collect();
        assert_eq!(uuids, vec!["u1", "a1", "u9"]);
        let hits = search(&conn, &plan_search("全文検索"), None, None, 0, 10)
            .unwrap()
            .hits;
        assert_eq!(hits.len(), 1);
        let short = search(&conn, &plan_search("原本"), None, None, 0, 10)
            .unwrap()
            .hits;
        assert_eq!(short.len(), 1);
        assert_eq!(
            list_sessions(&conn, None, None, 0, 1).unwrap()[0].message_count,
            3
        );
    }

    #[test]
    fn truncates_long_blocks_and_returns_them_in_full() {
        let long = "結果".repeat(3000);
        let path = build(&[line(
            "/p/s1.jsonl",
            "s1",
            "u1",
            "2026-01-01T00:00:00Z",
            "user",
            json!([{"type": "text", "text": "短い"}, {"type": "tool_result", "content": long}]),
        )]);
        let conn = open_read_only(&path).unwrap();
        let message = get_messages(&conn, "s1", 1, 1000)
            .map(|p| p.messages)
            .unwrap()
            .remove(0);
        assert_eq!(
            message.blocks[0],
            Block::Text {
                text: "短い".into()
            }
        );
        match &message.blocks[1] {
            Block::ToolResult {
                text, full_length, ..
            } => {
                assert_eq!(text.chars().count(), 4000);
                assert_eq!(*full_length, Some(6000));
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(
            get_block(&conn, message.rowid, 1).unwrap(),
            Block::ToolResult {
                text: long,
                is_error: false,
                full_length: None
            }
        );
        assert!(matches!(
            get_block(&conn, message.rowid, 9),
            Err(StoreError::Sqlite { .. })
        ));
    }

    fn with_providers() -> PathBuf {
        let mut ai = line(
            "/ai/x/messages.jsonl",
            "c1",
            "m1",
            "2026-01-05T00:00:00Z",
            "user",
            json!([{"type": "text", "text": "claude.ai の全文検索"}]),
        );
        ai.kind = "claude-ai/conversation";
        let mut cowork = line(
            "/cw/s.jsonl",
            "w1",
            "x1",
            "2026-01-04T00:00:00Z",
            "user",
            json!("Cowork の全文検索"),
        );
        cowork.kind = "claude-cowork/transcript";
        build(&[
            line(
                "/p/s1.jsonl",
                "s1",
                "u1",
                "2026-01-01T00:00:00Z",
                "user",
                json!("Code の全文検索"),
            ),
            ai,
            cowork,
        ])
    }

    #[test]
    fn lists_projects_with_providers() {
        let conn = open_read_only(&with_providers()).unwrap();
        let providers: Vec<_> = list_projects(&conn)
            .unwrap()
            .into_iter()
            .map(|p| p.provider)
            .collect();
        assert_eq!(providers, vec!["claude-ai", "claude-cowork", "claude-code"]);
    }

    #[test]
    fn filters_sessions_and_hits_by_provider() {
        let conn = open_read_only(&with_providers()).unwrap();
        let ids = |v: Vec<SessionSummary>| v.into_iter().map(|s| s.session_id).collect::<Vec<_>>();
        assert_eq!(
            ids(list_sessions(&conn, Some("claude-ai"), None, 0, 10).unwrap()),
            vec!["c1"]
        );
        assert_eq!(
            ids(list_sessions(&conn, Some("claude-code"), Some("/work/a"), 0, 10).unwrap()),
            vec!["s1"]
        );
        assert_eq!(list_sessions(&conn, None, None, 0, 10).unwrap().len(), 3);
        let hits = search(
            &conn,
            &plan_search("全文検索"),
            Some("claude-cowork"),
            None,
            0,
            10,
        )
        .unwrap()
        .hits;
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].provider, "claude-cowork");
        assert_eq!(
            search(&conn, &plan_search("全文検索"), None, None, 0, 10)
                .unwrap()
                .hits
                .len(),
            3
        );
    }

    #[test]
    fn reads_claude_ai_conversations() {
        let conn = open_read_only(&with_providers()).unwrap();
        let messages = get_messages(&conn, "c1", 1, 1000)
            .map(|p| p.messages)
            .unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role.as_deref(), Some("user"));
        assert_eq!(
            messages[0].blocks,
            vec![Block::Text {
                text: "claude.ai の全文検索".into()
            }]
        );
    }

    // docs/adr/0014
    #[test]
    fn pages_messages_with_numbers_and_the_total() {
        let conn = open_read_only(&sample()).unwrap();
        let page = get_messages(&conn, "s1", 2, 1).unwrap();
        assert_eq!(page.total, 3);
        let picked: Vec<_> = page
            .messages
            .iter()
            .map(|m| (m.index, m.uuid.clone().unwrap()))
            .collect();
        assert_eq!(picked, vec![(2, "a2".to_string())]);
        let rest = get_messages(&conn, "s1", 3, 10).unwrap();
        assert_eq!(
            rest.messages.iter().map(|m| m.index).collect::<Vec<_>>(),
            vec![3]
        );
        let beyond = get_messages(&conn, "s1", 5, 10).unwrap();
        assert_eq!((beyond.total, beyond.messages.len()), (3, 0));
    }

    #[test]
    fn copies_do_not_take_numbers() {
        let conn = open_read_only(&with_copy()).unwrap();
        let page = get_messages(&conn, "s1", 1, 100).unwrap();
        assert_eq!(page.total, 3);
        let numbered: Vec<_> = page
            .messages
            .iter()
            .map(|m| (m.index, m.uuid.clone().unwrap()))
            .collect();
        assert_eq!(
            numbered,
            vec![(1, "u1".into()), (2, "a1".into()), (3, "u9".into())]
        );
    }

    #[test]
    fn search_hits_carry_the_message_number() {
        let conn = open_read_only(&sample()).unwrap();
        let hits = search(&conn, &plan_search("検索"), None, None, 0, 10)
            .unwrap()
            .hits;
        let numbered: Vec<_> = hits
            .iter()
            .map(|h| (h.uuid.clone().unwrap(), h.index))
            .collect();
        assert_eq!(
            numbered,
            vec![
                ("u3".to_string(), Some(1)),
                ("a1".to_string(), Some(3)),
                ("u1".to_string(), Some(1))
            ]
        );
        let copy = open_read_only(&with_copy()).unwrap();
        let hit = search(&copy, &plan_search("原本"), None, None, 0, 10)
            .unwrap()
            .hits
            .remove(0);
        assert_eq!(hit.index, Some(1));
    }

    #[test]
    fn empty_input_has_no_hits() {
        let conn = open_read_only(&sample()).unwrap();
        assert_eq!(
            search(&conn, &plan_search("  "), None, None, 0, 10).unwrap(),
            SearchResult {
                hits: vec![],
                slow: false
            }
        );
    }
}
