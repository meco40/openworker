//! Port of `src/server/clawhub/searchParser.ts`: the text output of
//! `clawhub search`, one `slug vVersion Title (score)` row per line.
//!
//! Digits are written `[0-9]` because JavaScript's `\d` is ASCII-only, while
//! Rust's `\d` matches every Unicode digit.

use std::sync::LazyLock;

use regex::Regex;

use super::types::{SearchItem, SearchParseResult};

static SEARCH_ROW: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([A-Za-z0-9._/-]+)\s+v([0-9A-Za-z.+-]+)\s+(.+?)\s+\(([-+]?[0-9]*\.?[0-9]+)\)\s*$")
        .expect("search row pattern is valid")
});

/// `parseClawHubSearchOutput`. Lines starting with `- ` are headers and skipped;
/// any other unparsable line becomes a warning.
pub fn parse_clawhub_search_output(output: &str) -> SearchParseResult {
    let mut items = Vec::new();
    let mut parse_warnings = Vec::new();

    for line in output
        .split('\n')
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if line.starts_with("- ") {
            continue;
        }
        let Some(captures) = SEARCH_ROW.captures(line) else {
            parse_warnings.push(format!("Unparsed clawhub search line: {line}"));
            continue;
        };
        items.push(SearchItem {
            slug: captures[1].to_string(),
            version: captures[2].to_string(),
            title: captures[3].trim().to_string(),
            score: captures[4].parse::<f64>().unwrap_or(0.0),
        });
    }

    SearchParseResult {
        items,
        parse_warnings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rows_and_skips_headers() {
        let output = "- Searching\n\
                      weather-tool v1.2.0  Weather Tool  (3.5)\n\
                      ops/deploy-helper v0.1.0 Deploy helper (-0.25)\n";
        let parsed = parse_clawhub_search_output(output);
        assert!(parsed.parse_warnings.is_empty());
        assert_eq!(parsed.items.len(), 2);
        assert_eq!(parsed.items[0].slug, "weather-tool");
        assert_eq!(parsed.items[0].title, "Weather Tool");
        assert_eq!(parsed.items[0].score, 3.5);
        assert_eq!(parsed.items[1].slug, "ops/deploy-helper");
        assert_eq!(parsed.items[1].score, -0.25);
    }

    #[test]
    fn unparsable_lines_become_warnings() {
        let parsed = parse_clawhub_search_output("no match here\n");
        assert!(parsed.items.is_empty());
        assert_eq!(
            parsed.parse_warnings,
            vec!["Unparsed clawhub search line: no match here".to_string()]
        );
    }
}
