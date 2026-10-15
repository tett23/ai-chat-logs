//! docs/adr/0004, docs/adr/0007: the .env syntax, matching src/dotenv.cjs of the CLI.
//! No variable or ~ expansion, no multi-line values.

#[derive(Debug, Clone, PartialEq)]
pub struct ParseError {
    pub line: usize,
    pub message: String,
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "line {}: {}", self.line, self.message)
    }
}

pub type Pairs = Vec<(String, String)>;

fn fail<T>(line: usize, message: &str) -> Result<T, ParseError> {
    Err(ParseError {
        line,
        message: message.to_owned(),
    })
}

/// Only whitespace or a # comment may follow a closing quote.
fn check_rest(rest: &str, line: usize) -> Result<(), ParseError> {
    let rest = rest.trim_start();
    if rest.is_empty() || rest.starts_with('#') {
        Ok(())
    } else {
        fail(line, "unexpected characters after the closing quote")
    }
}

/// The body after an opening `"`: up to the next unescaped `"`, with \n, \" and \\ unescaped.
fn double_quoted(body: &str, line: usize) -> Result<String, ParseError> {
    let chars: Vec<char> = body.chars().collect();
    let close = (0..chars.len())
        .try_fold(false, |escaped, i| match (escaped, chars[i]) {
            (true, _) => Ok(false),
            (false, '\\') => Ok(true),
            (false, '"') => Err(i),
            (false, _) => Ok(false),
        })
        .err();
    let Some(close) = close else {
        return fail(line, "unterminated double quote");
    };
    check_rest(&chars[close + 1..].iter().collect::<String>(), line)?;
    let inner = &chars[..close];
    let mut out = String::new();
    let mut i = 0;
    while i < inner.len() {
        match (inner[i], inner.get(i + 1)) {
            ('\\', Some('n')) => {
                out.push('\n');
                i += 2;
            }
            ('\\', Some(&c @ ('"' | '\\'))) => {
                out.push(c);
                i += 2;
            }
            ('\\', Some(&c)) => {
                out.push('\\');
                out.push(c);
                i += 2;
            }
            (c, _) => {
                out.push(c);
                i += 1;
            }
        }
    }
    Ok(out)
}

fn single_quoted(body: &str, line: usize) -> Result<String, ParseError> {
    match body.find('\'') {
        Some(close) => {
            check_rest(&body[close + 1..], line)?;
            Ok(body[..close].to_owned())
        }
        None => fail(line, "unterminated single quote"),
    }
}

/// An unquoted value without the comment that starts at a # after whitespace.
fn unquoted(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let end = (1..chars.len())
        .find(|&i| chars[i] == '#' && chars[i - 1].is_whitespace())
        .unwrap_or(chars.len());
    chars[..end]
        .iter()
        .collect::<String>()
        .trim_end()
        .to_owned()
}

fn parse_value(raw: &str, line: usize) -> Result<String, ParseError> {
    let value = raw.trim();
    if let Some(body) = value.strip_prefix('"') {
        double_quoted(body, line)
    } else if let Some(body) = value.strip_prefix('\'') {
        single_quoted(body, line)
    } else {
        Ok(unquoted(value))
    }
}

fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn parse_line(line: &str, number: usize) -> Result<(String, String), ParseError> {
    let trimmed = line.trim();
    let body = trimmed
        .strip_prefix("export")
        .filter(|rest| rest.starts_with(char::is_whitespace))
        .map_or(trimmed, str::trim_start);
    let Some((name, value)) = body.split_once('=') else {
        return fail(number, "expected NAME=VALUE");
    };
    let name = name.trim();
    if !valid_name(name) {
        return fail(number, &format!("invalid name: {name}"));
    }
    Ok((name.to_owned(), parse_value(value, number)?))
}

fn is_skipped(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.is_empty() || trimmed.starts_with('#')
}

/// [name, value] pairs in first-appearance order; a later assignment overrides an earlier one.
pub fn parse(text: &str) -> Result<Pairs, ParseError> {
    let pairs = text
        .split('\n')
        .enumerate()
        .map(|(i, line)| (i + 1, line.strip_suffix('\r').unwrap_or(line)))
        .filter(|(_, line)| !is_skipped(line))
        .map(|(number, line)| parse_line(line, number))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(pairs.iter().fold(Vec::new(), |mut acc: Pairs, (k, v)| {
        match acc.iter_mut().find(|(name, _)| name == k) {
            Some(slot) => slot.1 = v.clone(),
            None => acc.push((k.clone(), v.clone())),
        }
        acc
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Case {
        name: String,
        input: String,
        pairs: Option<Vec<(String, String)>>,
        error_line: Option<usize>,
    }

    /// The cases shared with the CLI's tests (tests/dotenv.test.ts).
    #[test]
    fn matches_the_shared_cases() {
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../../../tests/fixtures/dotenv-cases.json"))
                .unwrap();
        assert!(!cases.is_empty());
        cases.into_iter().for_each(|c| match c.error_line {
            None => assert_eq!(
                parse(&c.input).ok(),
                Some(c.pairs.unwrap_or_default()),
                "{}",
                c.name
            ),
            Some(line) => assert_eq!(
                parse(&c.input).err().map(|e| e.line),
                Some(line),
                "{}",
                c.name
            ),
        });
    }
}
