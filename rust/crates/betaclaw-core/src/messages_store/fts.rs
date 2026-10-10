//! Port of `src/server/channels/messages/repository/utils/ftsHelpers.ts`.
//!
//! Converts a free-text user query into an FTS5 `MATCH` expression. Raw
//! punctuation must never reach `MATCH`, otherwise SQLite raises a syntax error
//! and the whole search request fails; the tokenizer below is what guarantees
//! that.
//!
//! | Behaviour                          | Source                                       |
//! | ---------------------------------- | -------------------------------------------- |
//! | tokens are letter/number runs      | `/[\p{L}\p{N}]+(?:\*)?/gu`                    |
//! | trailing `*` keeps prefix search   | `renderFtsToken` returns the token unchanged  |
//! | stop words are dropped             | `STOP_WORDS`                                  |
//! | one remaining token is a phrase    | `tokens.length === 1`                         |
//! | several tokens are `OR`-ed         | recall-friendly ranking, `bm25` orders hits   |
//! | only stop words remain -> `AND`    | prevents one stop word from matching nothing  |

use super::stop_words::STOP_WORDS;

/// `renderFtsToken` from `ftsHelpers.ts:3-6`.
fn render_fts_token(token: &str) -> String {
    if token.ends_with('*') {
        return token.to_string();
    }
    format!("\"{}\"", token.replace('"', "\"\""))
}

/// `allTokens` from `ftsHelpers.ts:18-24`: the runs of Unicode letters and
/// numbers, each optionally followed by a `*` that survives into the token.
///
/// `char::is_alphabetic` / `char::is_numeric` are the Rust equivalents of
/// `\p{L}` / `\p{N}`.
fn extract_all_tokens(raw: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();

    for ch in raw.chars() {
        if ch.is_alphabetic() || ch.is_numeric() {
            current.push(ch);
        } else if ch == '*' {
            // A wildcard only attaches to a run that is already open, so
            // `*max` still yields the plain token `max`.
            if current.is_empty() {
                continue;
            }
            current.push('*');
            tokens.push(std::mem::take(&mut current));
        } else if !current.is_empty() {
            tokens.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }

    tokens
}

/// `buildFtsQuery` from `ftsHelpers.ts:15-37`.
pub fn build_fts_query(raw: &str) -> String {
    let all_tokens = extract_all_tokens(raw);
    let tokens: Vec<&String> = all_tokens
        .iter()
        .filter(|token| !is_stop_word(token))
        .collect();

    if tokens.is_empty() {
        // If there are no safe tokens at all (punctuation-only input), skip
        // MATCH entirely.
        if all_tokens.is_empty() {
            return String::new();
        }
        // All safe words were stop words — fall back to the safe token list only.
        return if all_tokens.len() <= 1 {
            render_fts_token(&all_tokens[0])
        } else {
            all_tokens
                .iter()
                .map(|token| render_fts_token(token))
                .collect::<Vec<_>>()
                .join(" AND ")
        };
    }

    if tokens.len() == 1 {
        return render_fts_token(tokens[0]);
    }

    // Use OR semantics for recall — BM25 ranking surfaces multi-match hits first.
    tokens
        .iter()
        .map(|token| render_fts_token(token))
        .collect::<Vec<_>>()
        .join(" OR ")
}

/// `STOP_WORDS.has(token.replace(/\*$/, '').toLowerCase())`.
fn is_stop_word(token: &str) -> bool {
    let base = token.strip_suffix('*').unwrap_or(token);
    STOP_WORDS.contains(&base.to_lowercase().as_str())
}

#[cfg(test)]
mod tests {
    use super::build_fts_query;

    #[test]
    fn returns_an_empty_string_for_punctuation_only_input() {
        // The caller skips the MATCH clause entirely for this result.
        assert_eq!(build_fts_query(""), "");
        assert_eq!(build_fts_query("?!.,;:()"), "");
        assert_eq!(build_fts_query("*"), "");
        assert_eq!(build_fts_query("**max*"), "max*");
        assert_eq!(build_fts_query("(*max*)"), "max*");
    }

    #[test]
    fn quotes_a_single_token() {
        assert_eq!(build_fts_query("rust"), "\"rust\"");
        // `toLowerCase()` only feeds the STOP_WORDS probe
        // (`ftsHelpers.ts:25`); the emitted token keeps its original case.
        assert_eq!(build_fts_query("  SQLite  "), "\"SQLite\"");
    }

    #[test]
    fn or_joins_several_tokens_for_recall() {
        assert_eq!(build_fts_query("rust sqlite"), "\"rust\" OR \"sqlite\"");
        assert_eq!(build_fts_query("a1 b2 c3"), "\"a1\" OR \"b2\" OR \"c3\"");
    }

    #[test]
    fn drops_stop_words_before_joining() {
        assert_eq!(build_fts_query("der rust"), "\"rust\"");
        assert_eq!(
            build_fts_query("the and or"),
            "\"the\" AND \"and\" AND \"or\""
        );
        assert_eq!(build_fts_query("ich und die sqlite"), "\"sqlite\"");
    }

    #[test]
    fn keeps_the_trailing_wildcard_unquoted() {
        assert_eq!(build_fts_query("type*"), "type*");
        assert_eq!(build_fts_query("data base*"), "\"data\" OR base*");
        assert_eq!(build_fts_query("der type*"), "type*");
    }

    #[test]
    fn splits_on_inner_punctuation() {
        // `a` is a German/English stop word (`stopWords.ts:115`), so the filter
        // removes it before the OR join and only `b` survives.
        assert_eq!(build_fts_query("a:b"), "\"b\"");
        assert_eq!(build_fts_query("\"quoted\""), "\"quoted\"");
        assert_eq!(build_fts_query("mail.js"), "\"mail\" OR \"js\"");
        // Neither fragment is a stop word, so the punctuation is the only
        // reason this splits.
        assert_eq!(build_fts_query("a1:b2"), "\"a1\" OR \"b2\"");
    }

    #[test]
    fn keeps_non_latin_tokens() {
        // `müsste` IS a German stop word (`stopWords.ts:56`), so on its own it
        // reaches the all-stop-words fallback and is rendered verbatim.
        assert_eq!(build_fts_query("müsste"), "\"müsste\"");
        // With a second, non-stop-word token the stop word is dropped first.
        assert_eq!(build_fts_query("müsste kaffee"), "\"kaffee\"");
        assert_eq!(build_fts_query("kaffee schön"), "\"kaffee\" OR \"schön\"");
    }
}
