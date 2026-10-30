//! Port of `src/server/skills/handlers/webFetch.ts`.
//!
//! `web_fetch` fetches a URL through the SSRF guard and returns its text. HTML is reduced to
//! readable text with the same regular-expression pipeline as the TypeScript handler.
//!
//! The handler answers with `{ "error": ... }` for input problems and for failed fetches,
//! as the TypeScript handler does.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{json, Map, Value};

use super::http_text::{js_slice_to, utf16_len};
use super::types::{arg_number, arg_string, js_trim, SkillError};
use crate::model_hub::http::{HttpRequest, HttpTransport};
use crate::net_guard::ssrf_guard::{
    check_body_limit, fetch_with_ssrf_guard, parse_http_url, NetError, Resolver,
};

/// `FETCH_MAX_CHARS`.
const FETCH_MAX_CHARS: f64 = 20_000.0;
/// The hard upper bound for `max_chars`.
const FETCH_MAX_CHARS_CEILING: f64 = 50_000.0;
/// `FETCH_TIMEOUT_MS`.
const FETCH_TIMEOUT_MS: u64 = 20_000;
/// The body limit of `readResponseTextLimited(res, 2_000_000)`.
const FETCH_BODY_LIMIT_BYTES: usize = 2_000_000;
const MAX_REDIRECTS: usize = 3;

macro_rules! static_regex {
    ($pattern:expr) => {
        LazyLock::new(|| Regex::new($pattern).expect("static regex"))
    };
}

static SCRIPT: LazyLock<Regex> = static_regex!(r"(?is)<script.*?</script>");
static STYLE: LazyLock<Regex> = static_regex!(r"(?is)<style.*?</style>");
static NAV: LazyLock<Regex> = static_regex!(r"(?is)<nav.*?</nav>");
static HEADER: LazyLock<Regex> = static_regex!(r"(?is)<header.*?</header>");
static FOOTER: LazyLock<Regex> = static_regex!(r"(?is)<footer.*?</footer>");
static HEADING: LazyLock<Regex> = static_regex!(r"(?is)<h[1-6][^>]*>(.*?)</h[1-6]>");
static BLOCK_BREAK: LazyLock<Regex> = static_regex!(r"(?i)</p>|</div>|<br\s*/?>");
static LINK: LazyLock<Regex> = static_regex!(r#"(?is)<a[^>]+href=["']([^"']*)["'][^>]*>(.*?)</a>"#);
static TAG: LazyLock<Regex> = static_regex!(r"<[^>]+>");
static SPACE_RUN: LazyLock<Regex> = static_regex!(r"[ \t]+");
static BLANK_RUN: LazyLock<Regex> = static_regex!(r"\n{3,}");
static TITLE: LazyLock<Regex> = static_regex!(r"(?i)<title[^>]*>([^<]*)</title>");

/// `web_fetch`.
pub async fn web_fetch(
    transport: &dyn HttpTransport,
    resolver: &dyn Resolver,
    args: &Map<String, Value>,
) -> Result<Value, SkillError> {
    let url = js_trim(&arg_string(args, "url")).to_string();
    if url.is_empty() {
        return Ok(json!({ "error": "url is required" }));
    }
    match parse_http_url(&url) {
        Err(NetError::InvalidUrl) => return Ok(json!({ "error": format!("Invalid URL: {url}") })),
        Err(NetError::UnsupportedProtocol(protocol)) => {
            return Ok(json!({ "error": format!("Unsupported protocol: {protocol}") }));
        }
        _ => {}
    }

    // `Math.min(Number(args.max_chars) || FETCH_MAX_CHARS, 50_000)`: NaN and 0 fall back.
    let requested = arg_number(args, "max_chars", f64::NAN);
    let max_chars = if requested.is_nan() || requested == 0.0 {
        FETCH_MAX_CHARS
    } else {
        requested.min(FETCH_MAX_CHARS_CEILING)
    };

    let request = HttpRequest::get(url)
        .header(
            "User-Agent",
            "betaclaw-web-fetch/1.0 (compatible; +https://github.com/meco40/openworker)",
        )
        .header("Accept", "text/html,application/xhtml+xml,text/plain,*/*")
        .timeout_ms(FETCH_TIMEOUT_MS);
    let guarded = match fetch_with_ssrf_guard(transport, resolver, request, MAX_REDIRECTS).await {
        Ok(guarded) => guarded,
        Err(error) => return Ok(fetch_failed(&error)),
    };
    if let Err(error) = check_body_limit(&guarded.response, FETCH_BODY_LIMIT_BYTES) {
        return Ok(fetch_failed(&error));
    }

    let response = &guarded.response;
    let content_type = response.header("content-type").to_string();
    let raw = response.body.as_str();
    let content = if content_type.contains("text/html") {
        let title = html_title(raw);
        let prefix = if title.is_empty() {
            String::new()
        } else {
            format!("# {title}\n\n")
        };
        format!("{prefix}{}", extract_text_from_html(raw))
    } else {
        raw.to_string()
    };

    let length = utf16_len(&content);
    // `content.slice(0, maxChars)`. A fractional limit is truncated, as JavaScript does.
    let limit = max_chars.trunc() as i64;
    Ok(json!({
        "url": guarded.url,
        "status": response.status.as_u16(),
        "contentType": content_type,
        "length": length,
        "content": js_slice_to(&content, limit),
        "truncated": (length as f64) > max_chars,
    }))
}

fn fetch_failed(error: &NetError) -> Value {
    json!({ "error": format!("Fetch failed: {error}") })
}

/// The text of the first `<title>` element, trimmed. Entities are not decoded, as in
/// TypeScript.
pub(crate) fn html_title(html: &str) -> String {
    TITLE
        .captures(html)
        .map(|captures| js_trim(&captures[1]).to_string())
        .unwrap_or_default()
}

/// `extractTextFromHtml` (webFetch.ts:12-43).
pub(crate) fn extract_text_from_html(html: &str) -> String {
    let text = replace(&SCRIPT, html, " ");
    let text = replace(&STYLE, &text, " ");
    let text = replace(&NAV, &text, " ");
    let text = replace(&HEADER, &text, " ");
    let text = replace(&FOOTER, &text, " ");
    let text = replace(&HEADING, &text, "\n\n## ${1}\n\n");
    let text = replace(&BLOCK_BREAK, &text, "\n");
    let text = LINK
        .replace_all(&text, |captures: &regex::Captures| {
            let href = &captures[1];
            let inner = js_trim(&captures[2]);
            if inner.is_empty() {
                href.to_string()
            } else {
                format!("[{inner}]({href})")
            }
        })
        .into_owned();
    let text = replace(&TAG, &text, " ");
    let text = text
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");
    let text = replace(&SPACE_RUN, &text, " ");
    let text = replace(&BLANK_RUN, &text, "\n\n");
    js_trim(&text).to_string()
}

fn replace(pattern: &Regex, text: &str, replacement: &str) -> String {
    pattern.replace_all(text, replacement).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net_guard::test_support::{response_with, FakeResolver, FakeTransport};

    fn resolver() -> FakeResolver {
        FakeResolver::with(vec![("example.test", vec!["93.184.216.34"])])
    }

    fn args(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn html_becomes_readable_text() {
        let html = "<script>var x = 1;</script><nav>menu</nav><h1>Hello</h1><p>World <a href=\"/a\">link</a></p>";
        assert_eq!(
            extract_text_from_html(html),
            "## Hello\n\n World [link](/a)"
        );
    }

    #[test]
    fn a_link_without_text_shows_its_target() {
        assert_eq!(
            extract_text_from_html("<a href=\"https://x.test/\">  </a>"),
            "https://x.test/"
        );
    }

    #[test]
    fn the_title_is_trimmed_and_entities_are_kept() {
        assert_eq!(
            html_title("<TITLE> Demo &amp; Co </TITLE>"),
            "Demo &amp; Co"
        );
        assert_eq!(html_title("<p>none</p>"), "");
    }

    #[tokio::test]
    async fn input_problems_are_reported_as_error_objects() {
        let transport = FakeTransport::with(vec![]);
        let resolver = resolver();
        assert_eq!(
            web_fetch(&transport, &resolver, &args(json!({})))
                .await
                .expect("ok"),
            json!({ "error": "url is required" })
        );
        assert_eq!(
            web_fetch(&transport, &resolver, &args(json!({"url": "not a url"})))
                .await
                .expect("ok"),
            json!({ "error": "Invalid URL: not a url" })
        );
        assert_eq!(
            web_fetch(
                &transport,
                &resolver,
                &args(json!({"url": "ftp://example.test/"}))
            )
            .await
            .expect("ok"),
            json!({ "error": "Unsupported protocol: ftp:" })
        );
        assert!(transport.requests().is_empty());
    }

    #[tokio::test]
    async fn private_targets_are_refused_with_the_guard_message() {
        let transport = FakeTransport::with(vec![]);
        let out = web_fetch(
            &transport,
            &resolver(),
            &args(json!({"url": "http://localhost:8080/"})),
        )
        .await
        .expect("ok");
        assert_eq!(
            out,
            json!({ "error": "Fetch failed: SSRF guard: blocked local hostname \"localhost\"" })
        );
        assert!(transport.requests().is_empty());
    }

    #[tokio::test]
    async fn an_html_page_is_returned_as_text_with_its_title() {
        let transport = FakeTransport::with(vec![Ok(response_with(
            200,
            &[("content-type", "text/html; charset=utf-8")],
            "<html><head><title>Demo</title></head><body><h1>Hi</h1></body></html>",
        ))]);
        let out = web_fetch(
            &transport,
            &resolver(),
            &args(json!({"url": "https://example.test/page"})),
        )
        .await
        .expect("ok");
        assert_eq!(out["url"], "https://example.test/page");
        assert_eq!(out["status"], 200);
        // Tags become spaces, so the title text stays in the body, as in TypeScript.
        assert_eq!(out["content"], "# Demo\n\nDemo \n\n## Hi");
        assert_eq!(out["length"], 20);
        assert_eq!(out["truncated"], false);
    }

    #[tokio::test]
    async fn the_content_is_cut_to_max_chars_and_flagged() {
        let transport = FakeTransport::with(vec![Ok(response_with(
            200,
            &[("content-type", "text/plain")],
            "abcdefghijklmnop",
        ))]);
        let out = web_fetch(
            &transport,
            &resolver(),
            &args(json!({"url": "https://example.test/", "max_chars": 10})),
        )
        .await
        .expect("ok");
        assert_eq!(out["content"], "abcdefghij");
        assert_eq!(out["length"], 16);
        assert_eq!(out["truncated"], true);
    }

    #[tokio::test]
    async fn a_body_over_the_limit_is_a_fetch_failure() {
        let big = "a".repeat(FETCH_BODY_LIMIT_BYTES + 1);
        let transport = FakeTransport::with(vec![Ok(response_with(200, &[], &big))]);
        let out = web_fetch(
            &transport,
            &resolver(),
            &args(json!({"url": "https://example.test/"})),
        )
        .await
        .expect("ok");
        assert_eq!(
            out,
            json!({ "error": format!("Fetch failed: Response body exceeds the {FETCH_BODY_LIMIT_BYTES}-byte limit.") })
        );
    }
}
