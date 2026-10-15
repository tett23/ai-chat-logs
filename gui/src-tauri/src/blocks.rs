//! docs/adr/0003: content blocks of a message, as the frontend renders them.

use serde::Serialize;
use serde_json::Value;

/// `full_length` is the length in characters before truncation, `None` when the body is whole.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Block {
    Text {
        text: String,
    },
    Thinking {
        text: String,
        full_length: Option<usize>,
    },
    ToolUse {
        name: String,
        input: String,
        full_length: Option<usize>,
    },
    ToolResult {
        text: String,
        is_error: bool,
        full_length: Option<usize>,
    },
    Other {
        label: String,
        json: String,
        full_length: Option<usize>,
    },
}

/// The first `max` characters of `body` and its full length when it is longer.
fn cut(body: String, max: usize) -> (String, Option<usize>) {
    let len = body.chars().count();
    if len <= max {
        (body, None)
    } else {
        (body.chars().take(max).collect(), Some(len))
    }
}

/// docs/adr/0005: folded blocks longer than `max` characters are cut; text blocks are kept whole.
pub fn truncate(block: Block, max: usize) -> Block {
    match block {
        Block::Text { .. } => block,
        Block::Thinking { text, .. } => {
            let (text, full_length) = cut(text, max);
            Block::Thinking { text, full_length }
        }
        Block::ToolUse { name, input, .. } => {
            let (input, full_length) = cut(input, max);
            Block::ToolUse {
                name,
                input,
                full_length,
            }
        }
        Block::ToolResult { text, is_error, .. } => {
            let (text, full_length) = cut(text, max);
            Block::ToolResult {
                text,
                is_error,
                full_length,
            }
        }
        Block::Other { label, json, .. } => {
            let (json, full_length) = cut(json, max);
            Block::Other {
                label,
                json,
                full_length,
            }
        }
    }
}

fn str_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}

/// Text of a tool result's content: a string, or the text blocks of an array.
fn tool_result_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item.get("type").and_then(Value::as_str) {
                Some("text") => str_field(item, "text"),
                _ => pretty(item),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        other => pretty(other),
    }
}

fn to_block(item: &Value) -> Block {
    match item.get("type").and_then(Value::as_str) {
        Some("text") => Block::Text {
            text: str_field(item, "text"),
        },
        Some("thinking") => Block::Thinking {
            text: str_field(item, "thinking"),
            full_length: None,
        },
        Some("tool_use") => Block::ToolUse {
            name: str_field(item, "name"),
            input: item.get("input").map(pretty).unwrap_or_default(),
            full_length: None,
        },
        Some("tool_result") => Block::ToolResult {
            text: item
                .get("content")
                .map(tool_result_text)
                .unwrap_or_default(),
            is_error: item
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            full_length: None,
        },
        other => Block::Other {
            label: other.unwrap_or("unknown").to_owned(),
            json: pretty(item),
            full_length: None,
        },
    }
}

/// Blocks of `message.content`: a string becomes one text block.
pub fn to_blocks(content: Option<&Value>) -> Vec<Block> {
    match content {
        Some(Value::String(s)) => vec![Block::Text { text: s.clone() }],
        Some(Value::Array(items)) => items.iter().map(to_block).collect(),
        Some(Value::Null) | None => vec![],
        Some(other) => vec![Block::Other {
            label: "content".to_owned(),
            json: pretty(other),
            full_length: None,
        }],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn string_content_is_one_text_block() {
        assert_eq!(
            to_blocks(Some(&json!("hi"))),
            vec![Block::Text { text: "hi".into() }]
        );
    }

    #[test]
    fn keeps_the_kind_of_each_block() {
        let content = json!([
            {"type": "thinking", "thinking": "hmm"},
            {"type": "text", "text": "answer"},
            {"type": "tool_use", "name": "Bash", "input": {"command": "ls"}},
            {"type": "tool_result", "content": [{"type": "text", "text": "out"}], "is_error": true},
            {"type": "image", "source": {}}
        ]);
        let blocks = to_blocks(Some(&content));
        assert_eq!(
            blocks[0],
            Block::Thinking {
                text: "hmm".into(),
                full_length: None
            }
        );
        assert_eq!(
            blocks[1],
            Block::Text {
                text: "answer".into()
            }
        );
        assert_eq!(
            blocks[2],
            Block::ToolUse {
                name: "Bash".into(),
                input: "{\n  \"command\": \"ls\"\n}".into(),
                full_length: None
            }
        );
        assert_eq!(
            blocks[3],
            Block::ToolResult {
                text: "out".into(),
                is_error: true,
                full_length: None
            }
        );
        assert!(matches!(&blocks[4], Block::Other { label, .. } if label == "image"));
    }

    #[test]
    fn missing_content_has_no_blocks() {
        assert_eq!(to_blocks(None), vec![]);
    }

    #[test]
    fn truncates_long_folded_blocks() {
        let long = "あ".repeat(5000);
        let block = truncate(
            Block::ToolResult {
                text: long.clone(),
                is_error: false,
                full_length: None,
            },
            4000,
        );
        assert_eq!(
            block,
            Block::ToolResult {
                text: "あ".repeat(4000),
                is_error: false,
                full_length: Some(5000)
            }
        );
        let thinking = truncate(
            Block::Thinking {
                text: long,
                full_length: None,
            },
            4000,
        );
        assert!(matches!(
            thinking,
            Block::Thinking {
                full_length: Some(5000),
                ..
            }
        ));
    }

    #[test]
    fn keeps_short_blocks_and_text_blocks() {
        let exact = Block::ToolUse {
            name: "Bash".into(),
            input: "x".repeat(4000),
            full_length: None,
        };
        assert_eq!(truncate(exact.clone(), 4000), exact);
        let text = Block::Text {
            text: "y".repeat(5000),
        };
        assert_eq!(truncate(text.clone(), 4000), text);
    }

    #[test]
    fn serializes_with_a_kind_tag() {
        let json = serde_json::to_value(Block::Text { text: "a".into() }).unwrap();
        assert_eq!(json, json!({"kind": "text", "text": "a"}));
    }
}
