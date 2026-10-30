//! Port of `src/server/skills/handlers/webSearch.ts`.
//!
//! Brave Search first, with `BRAVE_SEARCH_API_KEY`, then the DuckDuckGo instant-answer API
//! as the fallback. Both hosts are fixed, so these calls skip the SSRF guard, as in
//! TypeScript. The caller reads the key and passes it in.
//!
//! Deviation: TypeScript sends `Accept-Encoding: gzip` and lets `fetch` decompress the reply.
//! The transport does not decompress, so this port asks for an uncompressed reply.

use serde_json::{json, Map, Value};

use super::http_text::{form_urlencode, js_slice_to};
use super::types::{arg_number, arg_string, js_trim, SkillError};
use crate::model_hub::http::{fetch_with_timeout, HttpRequest, HttpTransport};

const BRAVE_API_BASE: &str = "https://api.search.brave.com/res/v1/web/search";
const DDG_API_BASE: &str = "https://api.duckduckgo.com/";
const RESULT_LIMIT: f64 = 8.0;
const RESULT_CEILING: f64 = 20.0;
const SNIPPET_MAX_CHARS: i64 = 300;

#[derive(Debug, Clone, PartialEq, Eq)]
struct SearchHit {
    title: String,
    url: String,
    snippet: String,
}

impl SearchHit {
    fn to_json(&self) -> Value {
        json!({ "title": self.title, "url": self.url, "snippet": self.snippet })
    }
}

/// `webSearchHandler`.
pub async fn web_search(
    transport: &dyn HttpTransport,
    args: &Map<String, Value>,
    brave_api_key: Option<&str>,
) -> Result<Value, SkillError> {
    let query = js_trim(&arg_string(args, "query")).to_string();
    if query.is_empty() {
        return Ok(json!({ "error": "query is required", "results": [] }));
    }

    // `Math.max(1, Math.min(Number(args.count) || 8, 20))`
    let requested = arg_number(args, "count", f64::NAN);
    let requested = if requested.is_nan() || requested == 0.0 {
        RESULT_LIMIT
    } else {
        requested
    };
    let count = requested.clamp(1.0, RESULT_CEILING).floor() as usize;
    let freshness = Some(arg_string(args, "freshness")).filter(|text| !text.is_empty());

    let (provider, hits) = match search_brave(
        transport,
        &query,
        count,
        freshness.as_deref(),
        brave_api_key,
    )
    .await
    {
        Ok(hits) => ("brave", hits),
        Err(brave_error) => match search_duckduckgo(transport, &query, count).await {
            Ok(hits) => ("duckduckgo", hits),
            Err(_) => {
                return Ok(json!({
                    "error": format!("Search failed: {} (DDG fallback also failed)", brave_error.0),
                    "results": [],
                }));
            }
        },
    };

    Ok(json!({
        "query": query,
        "provider": provider,
        "count": hits.len(),
        "results": hits.iter().map(SearchHit::to_json).collect::<Vec<_>>(),
    }))
}

async fn search_brave(
    transport: &dyn HttpTransport,
    query: &str,
    count: usize,
    freshness: Option<&str>,
    api_key: Option<&str>,
) -> Result<Vec<SearchHit>, SkillError> {
    let key = api_key
        .filter(|key| !key.is_empty())
        .ok_or_else(|| SkillError("BRAVE_SEARCH_API_KEY not set".to_string()))?;
    let count_text = count.min(20).to_string();
    let mut pairs = vec![
        ("q", query),
        ("count", count_text.as_str()),
        ("text_decorations", "0"),
        ("search_lang", "de"),
    ];
    if let Some(freshness) = freshness {
        pairs.push(("freshness", freshness));
    }
    let url = format!("{BRAVE_API_BASE}?{}", form_urlencode(&pairs));
    let request = HttpRequest::get(url)
        .header("Accept", "application/json")
        .header("X-Subscription-Token", key)
        .timeout_ms(15_000);

    let response = fetch_with_timeout(transport, request)
        .await
        .map_err(|error| SkillError(error.to_string()))?;
    if !response.is_ok() {
        return Err(SkillError(format!(
            "Brave Search API error: {} {}",
            response.status.as_u16(),
            response.status_text
        )));
    }
    let data: Value =
        serde_json::from_str(&response.body).map_err(|error| SkillError(error.to_string()))?;
    let results = data
        .pointer("/web/results")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    Ok(results
        .iter()
        .take(count)
        .map(|result| SearchHit {
            title: string_field(result, "title"),
            url: string_field(result, "url"),
            snippet: js_slice_to(&string_field(result, "description"), SNIPPET_MAX_CHARS)
                .to_string(),
        })
        .collect())
}

async fn search_duckduckgo(
    transport: &dyn HttpTransport,
    query: &str,
    count: usize,
) -> Result<Vec<SearchHit>, SkillError> {
    let url = format!(
        "{DDG_API_BASE}?{}",
        form_urlencode(&[
            ("q", query),
            ("format", "json"),
            ("no_html", "1"),
            ("skip_disambig", "1"),
        ])
    );
    let request = HttpRequest::get(url)
        .header("User-Agent", "betaclaw-web-search/1.0")
        .timeout_ms(10_000);
    let response = fetch_with_timeout(transport, request)
        .await
        .map_err(|error| SkillError(error.to_string()))?;
    if !response.is_ok() {
        return Err(SkillError(format!(
            "DuckDuckGo API error: {}",
            response.status.as_u16()
        )));
    }
    let data: Value =
        serde_json::from_str(&response.body).map_err(|error| SkillError(error.to_string()))?;

    let mut results = Vec::new();
    let abstract_url = string_field(&data, "AbstractURL");
    let abstract_text = string_field(&data, "AbstractText");
    if !abstract_url.is_empty() && !abstract_text.is_empty() {
        // `data.Heading ?? query`: only a missing or null heading falls back.
        let title = match data.get("Heading") {
            Some(Value::String(heading)) => heading.clone(),
            _ => query.to_string(),
        };
        results.push(SearchHit {
            title,
            url: abstract_url,
            snippet: js_slice_to(&abstract_text, SNIPPET_MAX_CHARS).to_string(),
        });
    }

    let topics = data
        .get("RelatedTopics")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    for topic in topics {
        let first_url = string_field(topic, "FirstURL");
        let text = string_field(topic, "Text");
        if first_url.is_empty() || text.is_empty() {
            continue;
        }
        results.push(SearchHit {
            title: String::new(),
            url: first_url,
            snippet: js_slice_to(&text, SNIPPET_MAX_CHARS).to_string(),
        });
        if results.len() >= count {
            break;
        }
    }
    results.truncate(count);
    Ok(results)
}

/// `value[key] ?? ''` for a string field. Other JSON types read as empty.
fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net_guard::test_support::{response_with, FakeTransport};

    fn args(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    const DDG_BODY: &str = r#"{"AbstractURL":"https://en.test/rust","AbstractText":"Rust is a language.","Heading":"Rust","RelatedTopics":[{"Text":"Cargo tool","FirstURL":"https://en.test/cargo"},{"Topics":[]},{"Text":"no url"}]}"#;

    #[tokio::test]
    async fn an_empty_query_is_an_error_with_no_results() {
        let transport = FakeTransport::with(vec![]);
        let out = web_search(&transport, &args(json!({"query": "  "})), None)
            .await
            .expect("ok");
        assert_eq!(out, json!({ "error": "query is required", "results": [] }));
    }

    #[tokio::test]
    async fn without_a_brave_key_the_duckduckgo_answer_is_used() {
        let transport = FakeTransport::with(vec![Ok(response_with(200, &[], DDG_BODY))]);
        let out = web_search(&transport, &args(json!({"query": "rust lang"})), None)
            .await
            .expect("ok");
        assert_eq!(out["provider"], "duckduckgo");
        assert_eq!(out["count"], 2);
        assert_eq!(out["results"][0]["title"], "Rust");
        assert_eq!(out["results"][1]["url"], "https://en.test/cargo");
        assert_eq!(transport.requests().len(), 1, "no Brave call without a key");
        assert!(transport.requests()[0].url.contains("q=rust+lang"));
    }

    #[tokio::test]
    async fn brave_results_are_used_with_the_key_and_the_query_encoded() {
        let brave = r#"{"web":{"results":[{"title":"A","url":"https://a.test/","description":"d"},{"title":"B","url":"https://b.test/"}]}}"#;
        let transport = FakeTransport::with(vec![Ok(response_with(200, &[], brave))]);
        let out = web_search(
            &transport,
            &args(json!({"query": "a&b", "count": 1, "freshness": "pw"})),
            Some("brave-key"),
        )
        .await
        .expect("ok");
        assert_eq!(out["provider"], "brave");
        assert_eq!(out["count"], 1, "count caps the results");
        assert_eq!(out["results"][0]["snippet"], "d");
        let sent = &transport.requests()[0];
        assert!(sent.url.contains("q=a%26b"), "{}", sent.url);
        assert!(sent.url.contains("search_lang=de"));
        assert!(sent.url.contains("freshness=pw"));
        assert_eq!(
            sent.headers.get("x-subscription-token").expect("token"),
            "brave-key"
        );
    }

    #[tokio::test]
    async fn a_failing_brave_call_falls_back_to_duckduckgo() {
        let transport = FakeTransport::with(vec![
            Ok(response_with(500, &[], "boom")),
            Ok(response_with(200, &[], DDG_BODY)),
        ]);
        let out = web_search(&transport, &args(json!({"query": "rust"})), Some("k"))
            .await
            .expect("ok");
        assert_eq!(out["provider"], "duckduckgo");
    }

    #[tokio::test]
    async fn when_both_fail_the_error_names_the_brave_failure() {
        let transport = FakeTransport::with(vec![
            Ok(response_with(429, &[], "")),
            Ok(response_with(503, &[], "")),
        ]);
        let out = web_search(&transport, &args(json!({"query": "rust"})), Some("k"))
            .await
            .expect("ok");
        assert_eq!(
            out,
            json!({
                "error": "Search failed: Brave Search API error: 429 Too Many Requests (DDG fallback also failed)",
                "results": []
            })
        );
    }
}
