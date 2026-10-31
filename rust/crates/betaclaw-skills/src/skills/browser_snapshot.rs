//! Port of `src/server/skills/handlers/browserSnapshot.ts`.
//!
//! A lightweight page snapshot: the title, the meta description and a short plain-text
//! excerpt, fetched through the SSRF guard with the default redirect limit.
//!
//! Deviation: TypeScript sets no timeout on this fetch. This port uses
//! [`UNBOUNDED_FETCH_CAP_MS`], which matches undici's default headers timeout.

use std::sync::LazyLock;

use chrono::{SecondsFormat, Utc};
use regex::Regex;
use serde_json::{json, Map, Value};

use super::http_text::js_slice_to;
use super::types::{arg_string, js_trim, SkillError};
use super::web_fetch::html_title;
use crate::model_hub::http::{HttpRequest, HttpTransport};
use crate::net_guard::ssrf_guard::{
    check_body_limit, fetch_with_ssrf_guard, Resolver, DEFAULT_MAX_REDIRECTS,
    UNBOUNDED_FETCH_CAP_MS,
};

const DEFAULT_URL: &str = "https://example.com";
const BODY_LIMIT_BYTES: usize = 1_000_000;
const EXCERPT_CHARS: i64 = 800;

static DESCRIPTION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>"#)
        .expect("static regex")
});
static SCRIPT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<script.*?</script>").expect("static regex"));
static STYLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<style.*?</style>").expect("static regex"));
static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]+>").expect("static regex"));
static WHITESPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").expect("static regex"));

/// `browserSnapshotHandler`.
pub async fn browser_snapshot(
    transport: &dyn HttpTransport,
    resolver: &dyn Resolver,
    args: &Map<String, Value>,
) -> Result<Value, SkillError> {
    let requested = js_trim(&arg_string(args, "url")).to_string();
    let url = if requested.is_empty() {
        DEFAULT_URL.to_string()
    } else {
        requested
    };

    let request = HttpRequest::get(url.clone())
        .header("User-Agent", "betaclaw-browser-skill")
        .timeout_ms(UNBOUNDED_FETCH_CAP_MS);
    let guarded = fetch_with_ssrf_guard(transport, resolver, request, DEFAULT_MAX_REDIRECTS)
        .await
        .map_err(|error| SkillError(error.to_string()))?;
    let response = &guarded.response;
    if !response.is_ok() {
        return Err(SkillError(format!(
            "Failed to fetch URL ({}).",
            response.status.as_u16()
        )));
    }
    check_body_limit(response, BODY_LIMIT_BYTES).map_err(|error| SkillError(error.to_string()))?;

    let html = response.body.as_str();
    let description = DESCRIPTION
        .captures(html)
        .map(|captures| js_trim(&captures[1]).to_string())
        .unwrap_or_default();
    let plain = plain_text(html);

    Ok(json!({
        "url": url,
        "status": response.status.as_u16(),
        "title": html_title(html),
        "description": description,
        "excerpt": js_slice_to(&plain, EXCERPT_CHARS),
        "fetchedAt": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    }))
}

/// Scripts and styles are removed, tags become spaces, whitespace runs collapse.
fn plain_text(html: &str) -> String {
    let text = SCRIPT.replace_all(html, " ");
    let text = STYLE.replace_all(&text, " ");
    let text = TAG.replace_all(&text, " ");
    let text = WHITESPACE.replace_all(&text, " ");
    js_trim(&text).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net_guard::test_support::{response_with, FakeResolver, FakeTransport};

    fn resolver() -> FakeResolver {
        FakeResolver::with(vec![
            ("example.com", vec!["93.184.216.34"]),
            ("site.test", vec!["93.184.216.35"]),
        ])
    }

    fn args(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    #[tokio::test]
    async fn the_snapshot_holds_title_description_and_a_short_excerpt() {
        let page = r#"<html><head><title> Shop </title><meta name="description" content="Things to buy"><style>p{}</style></head><body><script>x()</script><p>Hello    <b>world</b></p></body></html>"#;
        let transport = FakeTransport::with(vec![Ok(response_with(200, &[], page))]);
        let out = browser_snapshot(
            &transport,
            &resolver(),
            &args(json!({"url": "https://site.test/"})),
        )
        .await
        .expect("snapshot");
        assert_eq!(out["url"], "https://site.test/");
        assert_eq!(out["status"], 200);
        assert_eq!(out["title"], "Shop");
        assert_eq!(out["description"], "Things to buy");
        assert_eq!(out["excerpt"], "Shop Hello world");
        let fetched = out["fetchedAt"].as_str().expect("timestamp");
        assert!(fetched.ends_with('Z') && fetched.len() == 24, "{fetched}");
    }

    #[tokio::test]
    async fn an_empty_url_falls_back_to_example_com() {
        let transport = FakeTransport::with(vec![Ok(response_with(200, &[], "<p>x</p>"))]);
        let out = browser_snapshot(&transport, &resolver(), &args(json!({"url": "  "})))
            .await
            .expect("snapshot");
        assert_eq!(out["url"], DEFAULT_URL);
        assert_eq!(transport.requests()[0].url, "https://example.com/");
    }

    #[tokio::test]
    async fn a_failed_status_is_an_error() {
        let transport = FakeTransport::with(vec![Ok(response_with(404, &[], "gone"))]);
        let error = browser_snapshot(
            &transport,
            &resolver(),
            &args(json!({"url": "https://site.test/"})),
        )
        .await
        .unwrap_err();
        assert_eq!(error.0, "Failed to fetch URL (404).");
    }

    #[tokio::test]
    async fn a_private_target_is_refused() {
        let transport = FakeTransport::with(vec![]);
        let error = browser_snapshot(
            &transport,
            &resolver(),
            &args(json!({"url": "http://192.168.0.1/"})),
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.0,
            "SSRF guard: blocked private/loopback address \"192.168.0.1\""
        );
    }
}
