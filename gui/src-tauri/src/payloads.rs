//! docs/adr/0031: put the payloads taken out of records.raw back, byte for byte.
//! The importer (src/payloads.ts) replaces a JSON string literal of raw with the marker literal
//! "\u0000ai-chat-logs-payload:<sha256>" and keeps the literal in the payloads table.

use rusqlite::{Connection, OptionalExtension, params};

const MARKER_HEAD: &str = "\"\\u0000ai-chat-logs-payload:";
const HASH_LEN: usize = 64;

/// A row of the payloads table.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredPayload {
    pub encoding: String,
    pub content: Vec<u8>,
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding (RFC 4648, section 4).
pub fn base64_encode(bytes: &[u8]) -> String {
    bytes
        .chunks(3)
        .flat_map(|chunk| {
            let b = [
                chunk[0],
                chunk.get(1).copied().unwrap_or(0),
                chunk.get(2).copied().unwrap_or(0),
            ];
            let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
            (0..4).map(move |i| {
                if i <= chunk.len() {
                    BASE64[((n >> (18 - 6 * i)) & 63) as usize] as char
                } else {
                    '='
                }
            })
        })
        .collect()
}

/// The JSON string literal a payload stands for, quotes included.
pub fn literal_of(payload: &StoredPayload) -> Result<String, String> {
    match payload.encoding.as_str() {
        "base64" => Ok(format!("\"{}\"", base64_encode(&payload.content))),
        "zstd" => zstd::decode_all(payload.content.as_slice())
            .map_err(|e| e.to_string())
            .and_then(|bytes| String::from_utf8(bytes).map_err(|e| e.to_string())),
        other => Err(format!("unknown payload encoding: {other}")),
    }
}

/// The hash of a marker literal that starts at `at`, if one does.
fn marker_at(raw: &str, at: usize) -> Option<&str> {
    let start = at + MARKER_HEAD.len();
    let hash = raw.get(start..start + HASH_LEN)?;
    let closed = raw.get(start + HASH_LEN..start + HASH_LEN + 1) == Some("\"");
    (closed
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
    .then_some(hash)
}

/// raw with every marker literal replaced by the literal of its payload.
pub fn restore(
    raw: &str,
    mut lookup: impl FnMut(&str) -> Result<Option<StoredPayload>, String>,
) -> Result<String, String> {
    let mut out = String::with_capacity(raw.len());
    let mut rest = 0;
    let mut from = 0;
    while let Some(found) = raw[from..].find(MARKER_HEAD) {
        let at = from + found;
        match marker_at(raw, at) {
            Some(hash) => {
                let payload = lookup(hash)?.ok_or_else(|| format!("payload not found: {hash}"))?;
                out.push_str(&raw[rest..at]);
                out.push_str(&literal_of(&payload)?);
                rest = at + MARKER_HEAD.len() + HASH_LEN + 1;
                from = rest;
            }
            None => from = at + 1,
        }
    }
    out.push_str(&raw[rest..]);
    Ok(out)
}

/// raw of a record as it was imported, given its payload_state (1: raw holds markers).
pub fn restored_raw(
    conn: &Connection,
    raw: String,
    state: Option<i64>,
) -> rusqlite::Result<String> {
    if state != Some(1) {
        return Ok(raw);
    }
    let mut stmt =
        conn.prepare_cached("SELECT encoding, content FROM payloads WHERE sha256 = ?1")?;
    restore(&raw, |hash| {
        stmt.query_row(params![hash], |row| {
            Ok(StoredPayload {
                encoding: row.get(0)?,
                content: row.get(1)?,
            })
        })
        .optional()
        .map_err(|e| e.to_string())
    })
    .map_err(|message| rusqlite::Error::ToSqlConversionFailure(message.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HASH_B: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn marker(hash: &str) -> String {
        format!("{MARKER_HEAD}{hash}\"")
    }

    #[test]
    fn base64_matches_the_rfc_4648_test_vectors() {
        let cases = [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ];
        cases
            .iter()
            .for_each(|(input, expected)| assert_eq!(base64_encode(input.as_bytes()), *expected));
        assert_eq!(base64_encode(&[0xfb, 0xff, 0xbf]), "+/+/");
    }

    #[test]
    fn restores_zstd_and_base64_payloads() {
        let literal = "\"長い結果\\n\\\"引用\\\" 🎉\"";
        let zstd = StoredPayload {
            encoding: "zstd".into(),
            content: zstd::encode_all(literal.as_bytes(), 3).unwrap(),
        };
        let image = StoredPayload {
            encoding: "base64".into(),
            content: vec![0, 1, 2, 250, 251, 252, 253],
        };
        let raw = format!(
            "{{\"message\":{{\"content\":[{{\"type\":\"tool_result\",\"content\":{}}},{{\"data\":{}}},{{\"again\":{}}}]}}}}",
            marker(HASH_A),
            marker(HASH_B),
            marker(HASH_A)
        );
        let restored = restore(&raw, |hash| {
            Ok(match hash {
                HASH_A => Some(zstd.clone()),
                HASH_B => Some(image.clone()),
                _ => None,
            })
        })
        .unwrap();
        assert_eq!(
            restored,
            format!(
                "{{\"message\":{{\"content\":[{{\"type\":\"tool_result\",\"content\":{literal}}},{{\"data\":\"AAEC+vv8/Q==\"}},{{\"again\":{literal}}}]}}}}"
            )
        );
    }

    #[test]
    fn leaves_text_without_complete_markers_alone_and_fails_on_a_missing_payload() {
        let partial = format!("{{\"a\":{MARKER_HEAD}short\"}}");
        assert_eq!(restore(&partial, |_| Ok(None)).unwrap(), partial);
        assert_eq!(restore("{}", |_| Ok(None)).unwrap(), "{}");
        assert!(restore(&marker(HASH_A), |_| Ok(None)).is_err());
    }

    #[test]
    fn restored_raw_reads_payloads_only_for_records_that_hold_markers() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            include_str!("../../../schema/0006-payloads.sql")
                .split("ALTER TABLE")
                .next()
                .unwrap(),
        )
        .unwrap();
        conn.execute(
            "INSERT INTO payloads (sha256, size, encoding, content) VALUES (?1, 4, 'base64', ?2)",
            params![HASH_B, vec![1u8, 2, 3]],
        )
        .unwrap();
        let raw = format!("[{}]", marker(HASH_B));
        assert_eq!(
            restored_raw(&conn, raw.clone(), Some(1)).unwrap(),
            "[\"AQID\"]"
        );
        assert_eq!(restored_raw(&conn, raw.clone(), Some(0)).unwrap(), raw);
        assert_eq!(restored_raw(&conn, raw.clone(), None).unwrap(), raw);
    }
}
