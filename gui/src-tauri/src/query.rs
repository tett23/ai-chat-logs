//! docs/adr/0003, docs/adr/0005: turning the search box input into SQL parameters, and snippets.

/// Delimiters around highlighted parts of a snippet (private-use characters).
pub const HIT_START: char = '\u{E000}';
pub const HIT_END: char = '\u{E001}';

/// Terms of at least this many characters are looked up through the trigram index.
const MIN_INDEXED_CHARS: usize = 3;

/// How the search input is matched.
#[derive(Debug, PartialEq, Eq)]
pub struct SearchPlan {
    /// FTS5 query for the terms the trigram index can look up; `None` when there are none.
    pub fts: Option<String>,
    /// `LIKE` patterns (escaped with `\`) for terms shorter than three characters.
    pub likes: Vec<String>,
    /// Terms as typed, used to cut snippets when there is no FTS5 query.
    pub terms: Vec<String>,
}

impl SearchPlan {
    pub fn is_empty(&self) -> bool {
        self.terms.is_empty()
    }

    /// Short terms force a scan of the whole text table.
    pub fn is_slow(&self) -> bool {
        !self.likes.is_empty()
    }
}

/// A term quoted as an FTS5 string so that no input is parsed as query syntax.
pub fn fts_phrase(term: &str) -> String {
    format!("\"{}\"", term.replace('"', "\"\""))
}

/// A `LIKE` pattern matching `term` literally anywhere, to be used with `ESCAPE '\'`.
pub fn like_pattern(term: &str) -> String {
    let escaped: String = term
        .chars()
        .flat_map(|c| match c {
            '%' | '_' | '\\' => vec!['\\', c],
            _ => vec![c],
        })
        .collect();
    format!("%{escaped}%")
}

pub fn plan_search(input: &str) -> SearchPlan {
    let terms: Vec<String> = input.split_whitespace().map(str::to_owned).collect();
    let (long, short): (Vec<&String>, Vec<&String>) = terms
        .iter()
        .partition(|t| t.chars().count() >= MIN_INDEXED_CHARS);
    let fts = (!long.is_empty()).then(|| {
        long.iter()
            .map(|t| fts_phrase(t))
            .collect::<Vec<_>>()
            .join(" AND ")
    });
    let likes = short.iter().map(|t| like_pattern(t)).collect();
    SearchPlan { fts, likes, terms }
}

/// Position (in chars) of the first occurrence of `needle` in `hay` at or after `from`,
/// comparing ASCII letters case-insensitively like SQLite's `LIKE`.
fn find_chars(hay: &[char], needle: &[char], from: usize) -> Option<usize> {
    if needle.is_empty() || needle.len() > hay.len() {
        return None;
    }
    (from..=hay.len() - needle.len()).find(|&i| {
        hay[i..i + needle.len()]
            .iter()
            .zip(needle)
            .all(|(a, b)| a.eq_ignore_ascii_case(b))
    })
}

/// Ranges [start, end) of non-overlapping occurrences of any term, in order.
fn occurrences(hay: &[char], terms: &[Vec<char>]) -> Vec<(usize, usize)> {
    let next = |from: usize| {
        terms
            .iter()
            .filter_map(|t| find_chars(hay, t, from).map(|i| (i, i + t.len())))
            .min()
    };
    std::iter::successors(next(0), |&(_, end)| next(end)).collect()
}

/// A snippet around the first occurrence of any term, with every occurrence in it highlighted.
/// Used when FTS5's `snippet()` is unavailable (no `MATCH`).
pub fn make_snippet(text: &str, terms: &[String], context: usize) -> String {
    let hay: Vec<char> = text.chars().collect();
    let needles: Vec<Vec<char>> = terms.iter().map(|t| t.chars().collect()).collect();
    let hits = occurrences(&hay, &needles);
    let first = hits.first().map_or(0, |&(start, _)| start);
    let start = first.saturating_sub(context);
    let end = hits
        .first()
        .map_or(context * 2, |&(_, e)| e + context)
        .min(hay.len());
    let in_window: Vec<(usize, usize)> = hits
        .into_iter()
        .filter(|&(s, e)| s >= start && e <= end)
        .collect();
    let (pos, body) = in_window
        .iter()
        .fold((start, String::new()), |(pos, mut acc), &(s, e)| {
            acc.extend(&hay[pos..s]);
            acc.push(HIT_START);
            acc.extend(&hay[s..e]);
            acc.push(HIT_END);
            (e, acc)
        });
    let tail: String = hay[pos..end].iter().collect();
    let prefix = if start > 0 { "…" } else { "" };
    let suffix = if end < hay.len() { "…" } else { "" };
    format!("{prefix}{body}{tail}{suffix}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_terms_so_that_fts5_syntax_is_literal() {
        assert_eq!(fts_phrase("abc"), "\"abc\"");
        assert_eq!(fts_phrase("a\"b"), "\"a\"\"b\"");
        let plan = plan_search("NEAR OR foo* \"quoted\" AND");
        assert_eq!(
            plan.fts.as_deref(),
            Some("\"NEAR\" AND \"foo*\" AND \"\"\"quoted\"\"\" AND \"AND\"")
        );
        // "OR" is two characters, so it becomes a LIKE term instead of an operator
        assert_eq!(plan.likes, vec!["%OR%"]);
    }

    #[test]
    fn escapes_like_wildcards() {
        assert_eq!(like_pattern("a%"), "%a\\%%");
        assert_eq!(like_pattern("_"), "%\\_%");
        assert_eq!(like_pattern("\\"), "%\\\\%");
        assert_eq!(like_pattern("検索"), "%検索%");
    }

    #[test]
    fn splits_terms_by_length_in_characters() {
        let plan = plan_search("  全文検索  が abc ");
        assert_eq!(plan.fts.as_deref(), Some("\"全文検索\" AND \"abc\""));
        assert_eq!(plan.likes, vec!["%が%"]);
        assert_eq!(plan.terms, vec!["全文検索", "が", "abc"]);
        assert!(plan.is_slow());
        assert!(!plan_search("全文検索").is_slow());
        assert!(plan_search("   ").is_empty());
        assert_eq!(plan_search("ab").fts, None);
    }

    #[test]
    fn snippet_highlights_the_first_occurrence_with_context() {
        let s = make_snippet("0123456789検索ABCDEFGHIJ", &["検索".into()], 3);
        assert_eq!(s, "…789\u{E000}検索\u{E001}ABC…");
    }

    #[test]
    fn snippet_highlights_every_occurrence_in_the_window() {
        let s = make_snippet("ab ab", &["ab".into()], 10);
        assert_eq!(s, "\u{E000}ab\u{E001} \u{E000}ab\u{E001}");
    }

    #[test]
    fn snippet_matches_ascii_case_insensitively() {
        assert_eq!(make_snippet("Xy", &["xY".into()], 5), "\u{E000}Xy\u{E001}");
    }

    #[test]
    fn snippet_without_hits_shows_the_beginning() {
        assert_eq!(make_snippet("abcdef", &["zz".into()], 1), "ab…");
    }
}
