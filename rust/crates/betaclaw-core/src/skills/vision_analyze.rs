//! Port of `src/server/skills/handlers/visionAnalyze.ts`.
//!
//! Sends one image and a focus question to the Gemini `generateContent` API. The caller
//! resolves the key (`vision.gemini_api_key`, falling back to `GEMINI_API_KEY`) and passes it
//! in. The key travels only in the `x-goog-api-key` header, never in the URL or in an error.
//!
//! `imageUrl` is fetched as in TypeScript: the SSRF guard with no redirects, a 10 MiB cap, and
//! the raw bytes from `HttpResponse::body_bytes`, base64-encoded.
//!
//! Deviation: the Gemini call has a 60 s timeout. The TypeScript SDK sets none.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Map, Value};

use super::types::{arg_string, js_trim, SkillError};
use crate::model_hub::http::{fetch_with_timeout, parse_error_message, HttpRequest, HttpTransport};
use crate::net_guard::ssrf_guard::{fetch_with_ssrf_guard, Resolver, SystemResolver};

const GEMINI_ENDPOINT: &str =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-latest:generateContent";
const GEMINI_TIMEOUT_MS: u64 = 60_000;
const DEFAULT_FOCUS: &str = "Describe the image, important objects, and any visible text.";
const DEFAULT_MIME_TYPE: &str = "image/png";
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const NEEDS_IMAGE: &str = "vision_analyze requires imageBase64 or imageUrl.";
const KEY_MISSING: &str = "Vision API key missing. Configure \"Vision (Gemini) API Key\" in Skill Registry > Tool Configuration or set GEMINI_API_KEY.";

/// `vision_analyze`.
pub async fn vision_analyze(
    transport: &dyn HttpTransport,
    args: &Map<String, Value>,
    api_key: Option<&str>,
) -> Result<Value, SkillError> {
    vision_analyze_with_resolver(transport, &SystemResolver, args, api_key).await
}

/// `vision_analyze` with the resolver for the image download injected, so tests can
/// point a host at a chosen address.
async fn vision_analyze_with_resolver(
    transport: &dyn HttpTransport,
    resolver: &dyn Resolver,
    args: &Map<String, Value>,
    api_key: Option<&str>,
) -> Result<Value, SkillError> {
    let image_url = js_trim(&arg_string(args, "imageUrl")).to_string();
    let image_base64 = js_trim(&arg_string(args, "imageBase64")).to_string();
    let focus = match js_trim(&arg_string(args, "focus")) {
        "" => DEFAULT_FOCUS.to_string(),
        focus => focus.to_string(),
    };
    // `String(args.mimeType || 'image/png').trim()`: the default applies before the trim.
    let raw_mime = arg_string(args, "mimeType");
    let mime_source: &str = if raw_mime.is_empty() {
        DEFAULT_MIME_TYPE
    } else {
        raw_mime.as_str()
    };
    let mime_type = js_trim(mime_source).to_string();

    // `if (!data && imageUrl)`: the download runs before the key check, as in TypeScript.
    let (data, mime_type) = if !image_base64.is_empty() {
        (image_base64, mime_type)
    } else if !image_url.is_empty() {
        download_image(transport, resolver, &image_url, mime_type).await?
    } else {
        return Err(SkillError(NEEDS_IMAGE.to_string()));
    };
    if data.is_empty() {
        return Err(SkillError(NEEDS_IMAGE.to_string()));
    }

    let key = api_key
        .filter(|key| !key.is_empty())
        .ok_or_else(|| SkillError(KEY_MISSING.to_string()))?;
    let payload = json!({
        "contents": [{
            "role": "user",
            "parts": [
                { "text": focus },
                { "inlineData": { "mimeType": mime_type, "data": data } }
            ]
        }]
    });
    let request = HttpRequest::post(GEMINI_ENDPOINT)
        .header("Content-Type", "application/json")
        .header("x-goog-api-key", key)
        .json_body(&payload)
        .timeout_ms(GEMINI_TIMEOUT_MS);

    let response = fetch_with_timeout(transport, request)
        .await
        .map_err(|error| SkillError(error.to_string()))?;
    if !response.is_ok() {
        return Err(SkillError(parse_error_message(&response)));
    }
    let data: Value =
        serde_json::from_str(&response.body).map_err(|error| SkillError(error.to_string()))?;

    // `result.text`: the text parts of the first candidate, concatenated.
    let analysis: String = data
        .pointer("/candidates/0/content/parts")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect()
        })
        .unwrap_or_default();

    Ok(json!({
        "analysis": analysis,
        "mimeType": mime_type,
    }))
}

/// `fetchWithSsrfGuard(imageUrl, undefined, { maxRedirects: 0 })` and `readResponseBytesLimited`.
/// Returns the base64 payload and the MIME type: the response's content type when it has one,
/// otherwise `mime_type`.
async fn download_image(
    transport: &dyn HttpTransport,
    resolver: &dyn Resolver,
    url: &str,
    mime_type: String,
) -> Result<(String, String), SkillError> {
    let request = HttpRequest::get(url).max_body_bytes(MAX_IMAGE_BYTES);
    let response = fetch_with_ssrf_guard(transport, resolver, request, 0)
        .await
        .map_err(|error| SkillError(error.to_string()))?
        .response;
    if !response.is_ok() {
        return Err(SkillError(format!(
            "Unable to download image ({}).",
            response.status.as_u16()
        )));
    }
    let content_type = response
        .header("content-type")
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    if !content_type.is_empty() && !content_type.starts_with("image/") {
        return Err(SkillError(format!(
            "Unable to download image: unexpected content type {content_type}."
        )));
    }
    let mime_type = if content_type.is_empty() {
        mime_type
    } else {
        content_type
    };
    Ok((STANDARD.encode(&response.body_bytes), mime_type))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_hub::http::HttpResponse;
    use crate::net_guard::test_support::{response_with, FakeResolver, FakeTransport};

    /// A PNG header with NUL and 0xFF bytes, which the UTF-8 text body would corrupt.
    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF];

    fn resolver() -> FakeResolver {
        FakeResolver::with(vec![
            ("images.test", vec!["93.184.216.34"]),
            ("internal.test", vec!["127.0.0.1"]),
        ])
    }

    /// An image answer whose payload is the raw `PNG` bytes.
    fn image_response(content_type: &str) -> HttpResponse {
        let mut response = response_with(200, &[("content-type", content_type)], "");
        response.body_bytes = PNG.to_vec();
        response
    }

    fn args(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    #[tokio::test]
    async fn missing_image_input_is_an_error() {
        let transport = FakeTransport::with(vec![]);
        let error = vision_analyze(&transport, &args(json!({})), Some("k"))
            .await
            .unwrap_err();
        assert_eq!(error.0, "vision_analyze requires imageBase64 or imageUrl.");
    }

    /// The image is downloaded as bytes; Gemini gets the base64 of exactly those bytes.
    #[tokio::test]
    async fn an_image_url_is_downloaded_as_bytes_and_sent_as_base64() {
        let transport = FakeTransport::with(vec![
            Ok(image_response("image/png; charset=binary")),
            Ok(response_with(
                200,
                &[("content-type", "application/json")],
                r#"{"candidates":[{"content":{"parts":[{"text":"A PNG."}]}}]}"#,
            )),
        ]);
        let out = vision_analyze_with_resolver(
            &transport,
            &resolver(),
            &args(json!({"imageUrl": "https://images.test/cat.png"})),
            Some("k"),
        )
        .await
        .expect("analysis");
        assert_eq!(out["analysis"], "A PNG.");
        assert_eq!(out["mimeType"], "image/png");

        let sent = transport.requests();
        assert!(
            sent[0].url.contains("images.test/cat.png"),
            "{}",
            sent[0].url
        );
        let body: Value =
            serde_json::from_str(sent[1].body.as_deref().expect("body")).expect("json");
        assert_eq!(
            body["contents"][0]["parts"][1]["inlineData"]["data"].as_str(),
            Some(STANDARD.encode(PNG).as_str())
        );
    }

    #[tokio::test]
    async fn a_download_that_is_not_an_image_is_refused() {
        let transport = FakeTransport::with(vec![Ok(response_with(
            200,
            &[("content-type", "text/html; charset=utf-8")],
            "<html>",
        ))]);
        let error = vision_analyze_with_resolver(
            &transport,
            &resolver(),
            &args(json!({"imageUrl": "https://images.test/page"})),
            Some("k"),
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.0,
            "Unable to download image: unexpected content type text/html."
        );
    }

    /// The SSRF guard refuses a name that resolves to a private address before any request.
    #[tokio::test]
    async fn an_image_url_on_a_private_address_is_refused_before_the_request() {
        let transport = FakeTransport::with(vec![]);
        let error = vision_analyze_with_resolver(
            &transport,
            &resolver(),
            &args(json!({"imageUrl": "https://internal.test/a.png"})),
            Some("k"),
        )
        .await
        .unwrap_err();
        assert!(
            error.0.contains("resolves to private address"),
            "{}",
            error.0
        );
        assert!(transport.requests().is_empty());
    }

    #[tokio::test]
    async fn a_missing_key_is_reported_before_the_call() {
        let transport = FakeTransport::with(vec![]);
        let error = vision_analyze(&transport, &args(json!({"imageBase64": "QUJD"})), None)
            .await
            .unwrap_err();
        assert_eq!(error.0, KEY_MISSING);
        assert!(transport.requests().is_empty());
    }

    #[tokio::test]
    async fn the_key_goes_in_a_header_and_the_text_parts_are_joined() {
        let transport = FakeTransport::with(vec![Ok(response_with(
            200,
            &[("content-type", "application/json")],
            r#"{"candidates":[{"content":{"parts":[{"text":"A cat."},{"text":" On a mat."}]}}]}"#,
        ))]);
        let out = vision_analyze(
            &transport,
            &args(json!({"imageBase64": "QUJD", "mimeType": " image/jpeg "})),
            Some("secret-key"),
        )
        .await
        .expect("analysis");
        assert_eq!(out["analysis"], "A cat. On a mat.");
        assert_eq!(out["mimeType"], "image/jpeg");

        let sent = &transport.requests()[0];
        assert!(
            !sent.url.contains("secret-key"),
            "the key never appears in the URL"
        );
        assert_eq!(
            sent.headers.get("x-goog-api-key").expect("key header"),
            "secret-key"
        );
        let body: Value = serde_json::from_str(sent.body.as_deref().expect("body")).expect("json");
        assert_eq!(
            body["contents"][0]["parts"][1]["inlineData"]["data"],
            "QUJD"
        );
        assert_eq!(
            body["contents"][0]["parts"][1]["inlineData"]["mimeType"],
            "image/jpeg"
        );
    }

    #[tokio::test]
    async fn an_api_error_is_reported_with_its_message_and_no_key() {
        let transport = FakeTransport::with(vec![Ok(response_with(
            400,
            &[("content-type", "application/json")],
            r#"{"error":{"message":"bad image"}}"#,
        ))]);
        let error = vision_analyze(
            &transport,
            &args(json!({"imageBase64": "QUJD"})),
            Some("secret-key"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.0, "bad image");
    }
}
