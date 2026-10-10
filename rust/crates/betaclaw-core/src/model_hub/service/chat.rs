//! Port of `src/server/model-hub/service/dispatch/chat.ts`.
//!
//! Three functions and one piece of pipeline ordering matter:
//!
//! - [`dispatch_chat`] (`chat.ts:11-32`) — a single account, no fallback.
//! - [`dispatch_with_fallback`] (`chat.ts:41-164`) — the critical path: the
//!   priority-ordered fallback chain, the error classification, and the
//!   `rate-limited` side effect.
//! - [`with_pipeline_model`] — the `{ ...request, model, reasoning_effort }`
//!   merge that both paths perform.
//!
//! ## Ordering subtleties that are easy to get wrong
//!
//! 1. `pipeline.filter((m) => m.status === 'active')` runs **before** anything
//!    else, and the filter preserves the repository's `ORDER BY priority ASC`
//!    order. The port does the same with `filter`, never with a sort.
//! 2. The abort check sits in front of each *fallback* attempt
//!    (`chat.ts:122`), but **not** in front of the preferred-model attempt. An
//!    already-aborted signal therefore still dispatches the override and only
//!    short-circuits the chain. The golden test
//!    `service-core.test.ts:342` pins exactly that: no `modelOverride` means no
//!    dispatch at all, because the loop is the only place the check lives.
//! 3. `attemptedModels` is keyed by **model name**, not by pipeline id. A
//!    pipeline that lists the same `modelName` twice under two accounts only
//!    tries the first one.
//! 4. An entry whose account is missing is *skipped silently* in the loop
//!    (`chat.ts:127`), while the preferred branch records
//!    `Account not found`. That is why a single-entry pipeline with a dangling
//!    account reports `All models failed: ` with an empty list.

use std::collections::HashSet;

use crate::model_hub::repository::ModelHubRepository;
use crate::model_hub::types::{
    GatewayReasoningEffort, GatewayRequest, GatewayResponse, PipelineModelEntry, PipelineStatus,
};

use super::gateway::dispatch_gateway_request;
use super::refresh::maybe_refresh_open_ai_codex_account;
use super::types::DispatchWithFallbackOptions;
use super::utils::map_pipeline_reasoning_effort;
use super::{ServiceDependencies, ServiceError};

/// `dispatchChat` from `chat.ts:11-32`.
pub async fn dispatch_chat(
    repository: &dyn ModelHubRepository,
    account_id: &str,
    encryption_key: &str,
    request: &GatewayRequest,
    dependencies: &ServiceDependencies<'_>,
) -> Result<GatewayResponse, ServiceError> {
    let Some(account) = repository.get_account_record_by_id(account_id)? else {
        return Ok(GatewayResponse::failure(
            request.model.clone(),
            "unknown",
            format!("Account {account_id} not found."),
        ));
    };
    let usable_account = maybe_refresh_open_ai_codex_account(
        repository,
        &account,
        encryption_key,
        dependencies.codex,
    )
    .await?;

    dispatch_gateway_request(&usable_account, encryption_key, request, None, dependencies).await
}

/// `dispatchWithFallback` from `chat.ts:41-164`.
///
/// Tries each active model in priority order until one succeeds. When
/// `options.modelOverride` is set, that model goes first; every other active
/// model follows in pipeline order.
pub async fn dispatch_with_fallback(
    repository: &dyn ModelHubRepository,
    profile_id: &str,
    encryption_key: &str,
    request: &GatewayRequest,
    options: Option<&DispatchWithFallbackOptions>,
    dependencies: &ServiceDependencies<'_>,
) -> Result<GatewayResponse, ServiceError> {
    let pipeline = repository.list_pipeline_models(profile_id)?;
    let active_models: Vec<&PipelineModelEntry> = pipeline
        .iter()
        .filter(|entry| entry.status == PipelineStatus::Active)
        .collect();

    if active_models.is_empty() {
        return Ok(GatewayResponse::failure(
            "",
            "",
            "No active models in pipeline.",
        ));
    }

    let mut errors: Vec<String> = Vec::new();
    let mut attempted_models: HashSet<String> = HashSet::new();

    // ─── Preferred model first ───────────────────────────────────────────────
    if let Some(model_override) = options.and_then(|options| options.model_override.as_deref()) {
        match active_models
            .iter()
            .find(|entry| entry.model_name == model_override)
        {
            None => {
                errors.push(format!(
                    "Override model \"{model_override}\" not found in active pipeline."
                ));
            }
            Some(preferred) => match repository.get_account_record_by_id(&preferred.account_id)? {
                None => {
                    errors.push(format!(
                        "{}@{}: Account not found",
                        preferred.model_name, preferred.provider_id
                    ));
                }
                Some(account) => {
                    let usable_account = maybe_refresh_open_ai_codex_account(
                        repository,
                        &account,
                        encryption_key,
                        dependencies.codex,
                    )
                    .await?;
                    let merged = with_pipeline_model(
                        request,
                        preferred,
                        map_pipeline_reasoning_effort(
                            preferred.reasoning_effort.as_ref(),
                            &preferred.provider_id,
                        ),
                    );

                    let result = dispatch_gateway_request(
                        &usable_account,
                        encryption_key,
                        &merged,
                        options,
                        dependencies,
                    )
                    .await?;

                    if result.ok {
                        return Ok(result);
                    }

                    // Preferred model failed — record error and mark as
                    // rate-limited if needed.
                    errors.push(format!(
                        "{}@{}: {}",
                        preferred.model_name,
                        preferred.provider_id,
                        javascript_template_error(&result.error)
                    ));
                    attempted_models.insert(preferred.model_name.clone());

                    if indicates_rate_limit(result.error.as_deref()) {
                        repository.update_pipeline_model_status(
                            &preferred.id,
                            PipelineStatus::RateLimited,
                        )?;
                    }
                }
            },
        }
    }

    // ─── Fallback chain ──────────────────────────────────────────────────────
    for entry in &active_models {
        // Skip if already attempted (preferred model).
        if attempted_models.contains(&entry.model_name) {
            continue;
        }

        // Check abort before each model attempt.
        if options.is_some_and(DispatchWithFallbackOptions::is_aborted) {
            return Ok(GatewayResponse::failure("", "", "Aborted"));
        }

        let Some(account) = repository.get_account_record_by_id(&entry.account_id)? else {
            continue;
        };
        let usable_account = maybe_refresh_open_ai_codex_account(
            repository,
            &account,
            encryption_key,
            dependencies.codex,
        )
        .await?;
        let merged = with_pipeline_model(
            request,
            entry,
            map_pipeline_reasoning_effort(entry.reasoning_effort.as_ref(), &entry.provider_id),
        );

        let result = dispatch_gateway_request(
            &usable_account,
            encryption_key,
            &merged,
            options,
            dependencies,
        )
        .await?;

        if result.ok {
            return Ok(result);
        }

        errors.push(format!(
            "{}@{}: {}",
            entry.model_name,
            entry.provider_id,
            javascript_template_error(&result.error)
        ));

        // Mark as rate-limited if the error suggests it.
        if indicates_rate_limit(result.error.as_deref()) {
            repository.update_pipeline_model_status(&entry.id, PipelineStatus::RateLimited)?;
        }
    }

    Ok(GatewayResponse::failure(
        "",
        "",
        format!("All models failed: {}", errors.join(" | ")),
    ))
}

/// `{ ...request, model: entry.modelName, reasoning_effort: effort ?? request.reasoning_effort }`
/// from `chat.ts:84-88` and `chat.ts:136-140`.
///
/// The `??` means the pipeline effort only replaces the caller's effort when one
/// is mapped; `mapPipelineReasoningEffort` returning `None` (an unknown effort,
/// or `off` on a non-OpenCode provider) keeps the caller's value.
fn with_pipeline_model(
    request: &GatewayRequest,
    entry: &PipelineModelEntry,
    reasoning_effort: Option<GatewayReasoningEffort>,
) -> GatewayRequest {
    GatewayRequest {
        model: entry.model_name.clone(),
        reasoning_effort: reasoning_effort.or(request.reasoning_effort),
        ..request.clone()
    }
}

/// `result.error?.includes('429') || result.error?.toLowerCase().includes('rate')`
/// from `chat.ts:152` (and `chat.ts:103` for the preferred branch).
///
/// The lowercase step applies to the `rate` probe only, so `429` and `RATE` are
/// both matched but a bare `Rate` is found through the lowercased copy.
fn indicates_rate_limit(error: Option<&str>) -> bool {
    let Some(error) = error else {
        return false;
    };
    error.contains("429") || error.to_lowercase().contains("rate")
}

/// `` `${model}@${provider}: ${result.error}` `` — a JavaScript template literal
/// renders `undefined` for a missing value, so the port reproduces that rather
/// than dropping the segment. Only reachable for a `GatewayResponse` without an
/// `error` string, which the provider parsers never produce in practice.
fn javascript_template_error(error: &Option<String>) -> &str {
    error.as_deref().unwrap_or("undefined")
}

#[cfg(test)]
mod tests {
    use http::StatusCode;

    use super::*;
    use crate::model_hub::crypto::encrypt_secret_with_iv;
    use crate::model_hub::service::test_doubles::{
        no_attachments, RecordingObserver, StubRepository, StubTransport,
    };
    use crate::model_hub::types::{
        EncryptedSecretPayloadJson, GatewayMessage, PipelineStatus, ProviderAccountRecord,
        ProviderAuthMethod,
    };

    const KEY: &str = "test-only-encryption-key-32bytes";

    fn account(provider_id: &str) -> ProviderAccountRecord {
        let encrypted =
            encrypt_secret_with_iv("sk-test", KEY, "default", &[4u8; 12]).expect("encrypt");
        ProviderAccountRecord {
            id: format!("acc-{provider_id}"),
            provider_id: provider_id.to_string(),
            label: provider_id.to_string(),
            auth_method: ProviderAuthMethod::ApiKey,
            secret_masked: "****".to_string(),
            has_refresh_token: false,
            created_at: String::new(),
            updated_at: String::new(),
            last_check_at: None,
            last_check_ok: None,
            last_check_message: None,
            encrypted_secret: EncryptedSecretPayloadJson::from_payload(&encrypted),
            encrypted_refresh_token: None,
        }
    }

    fn entry(id: &str, model: &str, priority: i64, status: PipelineStatus) -> PipelineModelEntry {
        PipelineModelEntry {
            id: id.to_string(),
            profile_id: "p1".to_string(),
            account_id: "acc-openai".to_string(),
            provider_id: "openai".to_string(),
            model_name: model.to_string(),
            reasoning_effort: None,
            priority,
            status,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn request() -> GatewayRequest {
        GatewayRequest::new("gpt-4.1", vec![GatewayMessage::user("hello")])
    }

    /// An empty pipeline and an all-offline pipeline produce the same message,
    /// which is what `service-dispatch.test.ts:30` and `:46` assert.
    #[tokio::test]
    async fn no_active_models_is_reported() {
        for pipeline in [
            Vec::new(),
            vec![entry("m1", "gpt-4", 1, PipelineStatus::Offline)],
        ] {
            let repository = StubRepository::default().with_pipeline(pipeline);
            let transport = StubTransport::default();
            let deps = ServiceDependencies::for_test(&transport, no_attachments());

            let response = dispatch_with_fallback(&repository, "p1", KEY, &request(), None, &deps)
                .await
                .expect("no repository failure");

            assert!(!response.ok);
            assert!(response
                .error
                .as_deref()
                .is_some_and(|error| error.contains("No active models")));
            assert_eq!(transport.request_count(), 0);
        }
    }

    /// A dangling account is skipped without an error entry, so the summary is
    /// an empty list after the colon (`chat.ts:127`).
    #[tokio::test]
    async fn a_missing_account_is_skipped_silently() {
        let repository = StubRepository::default().with_pipeline(vec![entry(
            "m1",
            "gemini-2.5-flash",
            1,
            PipelineStatus::Active,
        )]);
        let transport = StubTransport::default();
        let deps = ServiceDependencies::for_test(&transport, no_attachments());

        let response = dispatch_with_fallback(&repository, "p1", KEY, &request(), None, &deps)
            .await
            .expect("no repository failure");

        assert!(!response.ok);
        assert_eq!(
            response.error.as_deref(),
            Some("All models failed: "),
            "the loop pushes no error for a skipped account"
        );
        assert_eq!(transport.request_count(), 0);
    }

    /// An already-aborted signal returns `Aborted` before the first fallback
    /// attempt. Mirrors `service-core.test.ts:342`, which compares the whole
    /// response object.
    #[tokio::test]
    async fn an_aborted_signal_short_circuits_the_chain() {
        let repository = StubRepository::default()
            .with_pipeline(vec![entry("p1", "gpt-4.1", 1, PipelineStatus::Active)])
            .with_accounts(vec![account("openai")]);
        let transport = StubTransport::default();
        let observer = RecordingObserver::succeeding();
        let deps =
            ServiceDependencies::for_test(&transport, no_attachments()).with_observer(&observer);

        let signal = crate::model_hub::http::AbortSignal::new();
        signal.abort();
        let options = DispatchWithFallbackOptions {
            abort: Some(signal),
            ..DispatchWithFallbackOptions::default()
        };

        let response =
            dispatch_with_fallback(&repository, "p1", KEY, &request(), Some(&options), &deps)
                .await
                .expect("no repository failure");

        assert_eq!(
            response,
            GatewayResponse::failure("", "", "Aborted"),
            "the golden test compares the whole object"
        );
        assert_eq!(transport.request_count(), 0);
        assert!(observer.prompt_dispatches().is_empty());
    }

    /// A preferred model that is not in the pipeline does not block the chain:
    /// the loop still walks every active entry (`service-core.test.ts:308`).
    #[tokio::test]
    async fn an_absent_override_falls_back_to_the_pipeline() {
        let repository = StubRepository::default()
            .with_pipeline(vec![entry("p1", "gpt-4.1", 1, PipelineStatus::Active)])
            .with_accounts(vec![account("openai")]);
        let transport = StubTransport::json(
            StatusCode::OK,
            &serde_json::json!({ "choices": [{ "message": { "content": "ok" } }] }),
        );
        let deps = ServiceDependencies::for_test(&transport, no_attachments());

        let options = DispatchWithFallbackOptions::with_model_override("missing-model");
        let response = dispatch_with_fallback(
            &repository,
            "profile-1",
            KEY,
            &request(),
            Some(&options),
            &deps,
        )
        .await
        .expect("no repository failure");

        assert!(response.ok, "{response:?}");
        assert_eq!(response.model, "gpt-4.1");
        assert_eq!(
            transport.request_count(),
            1,
            "the override never dispatched"
        );
    }

    /// A 429 marks the entry as rate-limited and the other error does not.
    /// Mirrors `service-core.test.ts:375`.
    #[tokio::test]
    async fn rate_errors_mark_the_entries_and_are_summarised() {
        let repository = StubRepository::default()
            .with_pipeline(vec![
                entry("p1", "gpt-4.1", 1, PipelineStatus::Active),
                entry("p2", "gpt-4.1-mini", 2, PipelineStatus::Active),
            ])
            .with_accounts(vec![account("openai")]);
        let transport = StubTransport::replay(vec![
            Err(StatusCode::TOO_MANY_REQUESTS),
            Err(StatusCode::FORBIDDEN),
        ]);
        let deps = ServiceDependencies::for_test(&transport, no_attachments());

        let options = DispatchWithFallbackOptions::with_model_override("gpt-4.1");
        let response = dispatch_with_fallback(
            &repository,
            "profile-1",
            KEY,
            &request(),
            Some(&options),
            &deps,
        )
        .await
        .expect("no repository failure");

        assert!(!response.ok);
        assert!(response
            .error
            .as_deref()
            .is_some_and(|error| error.starts_with("All models failed")));
        assert_eq!(transport.request_count(), 2);
        assert_eq!(
            repository.status_updates(),
            vec![("p1".to_string(), PipelineStatus::RateLimited)],
            "only the 429 marks an entry; 403 is not a rate limit"
        );
    }

    /// A successful entry ends the chain immediately, so the second entry is
    /// never touched.
    #[tokio::test]
    async fn the_first_success_stops_the_chain() {
        let repository = StubRepository::default()
            .with_pipeline(vec![
                entry("p1", "gpt-4.1", 1, PipelineStatus::Active),
                entry("p2", "gpt-4.1-mini", 2, PipelineStatus::Active),
            ])
            .with_accounts(vec![account("openai")]);
        let transport = StubTransport::json(
            StatusCode::OK,
            &serde_json::json!({ "choices": [{ "message": { "content": "first" } }] }),
        );
        let deps = ServiceDependencies::for_test(&transport, no_attachments());

        let response = dispatch_with_fallback(&repository, "p1", KEY, &request(), None, &deps)
            .await
            .expect("no repository failure");

        assert!(response.ok);
        assert_eq!(transport.request_count(), 1);
        assert_eq!(
            transport.recorded()[0].url,
            "https://api.openai.com/v1/chat/completions"
        );
    }

    /// The fallback chain skips a model name that the preferred attempt already
    /// tried, even when it is a different pipeline entry.
    #[tokio::test]
    async fn an_already_attempted_model_name_is_skipped() {
        let repository = StubRepository::default()
            .with_pipeline(vec![
                entry("p1", "gpt-4.1", 1, PipelineStatus::Active),
                entry("p2", "gpt-4.1", 2, PipelineStatus::Active),
            ])
            .with_accounts(vec![account("openai")]);
        let transport = StubTransport::replay(vec![Err(StatusCode::BAD_REQUEST)]);
        let deps = ServiceDependencies::for_test(&transport, no_attachments());

        let options = DispatchWithFallbackOptions::with_model_override("gpt-4.1");
        let response =
            dispatch_with_fallback(&repository, "p1", KEY, &request(), Some(&options), &deps)
                .await
                .expect("no repository failure");

        assert!(!response.ok);
        assert_eq!(transport.request_count(), 1, "the second entry is skipped");
    }

    /// `dispatchChat` mirrors the service-level account-not-found response.
    #[tokio::test]
    async fn dispatch_chat_reports_a_missing_account() {
        let repository = StubRepository::default();
        let transport = StubTransport::default();
        let deps = ServiceDependencies::for_test(&transport, no_attachments());

        let response = dispatch_chat(&repository, "missing", KEY, &request(), &deps)
            .await
            .expect("no repository failure");

        assert!(!response.ok);
        assert_eq!(
            response.error.as_deref(),
            Some("Account missing not found.")
        );
        assert_eq!(response.provider, "unknown");
        assert_eq!(transport.request_count(), 0);
    }

    /// `dispatchChat` dispatches a usable account directly.
    #[tokio::test]
    async fn dispatch_chat_dispatches_a_usable_account() {
        let repository = StubRepository::default().with_accounts(vec![account("openai")]);
        let transport = StubTransport::json(
            StatusCode::OK,
            &serde_json::json!({ "choices": [{ "message": { "content": "direct" } }] }),
        );
        let deps = ServiceDependencies::for_test(&transport, no_attachments());

        let request = request();
        let response = dispatch_chat(&repository, "acc-openai", KEY, &request, &deps)
            .await
            .expect("no repository failure");

        assert!(response.ok);
        assert_eq!(response.text, "direct");
        assert_eq!(
            response.model, "gpt-4.1",
            "dispatchChat keeps request.model"
        );
    }

    /// The rate-limit classifier matches on `429`, on `rate` after lowercasing,
    /// and on neither when the error is absent.
    #[test]
    fn rate_limit_classification_matches_the_typescript_probe() {
        assert!(indicates_rate_limit(Some("429 Too Many Requests")));
        assert!(indicates_rate_limit(Some("rate limit exceeded")));
        assert!(indicates_rate_limit(Some("RATE LIMIT EXCEEDED")));
        assert!(!indicates_rate_limit(Some("400 Bad Request")));
        assert!(!indicates_rate_limit(Some("per-minute quota")));
        assert!(!indicates_rate_limit(None));
    }

    /// `reasoning_effort` is overridden only when the pipeline maps one.
    #[test]
    fn the_pipeline_effort_overrides_only_when_mapped() {
        let base = request();
        let entry = entry("p1", "m", 1, PipelineStatus::Active);

        let unmapped = with_pipeline_model(&base, &entry, None);
        assert_eq!(unmapped.model, "m");
        assert_eq!(unmapped.reasoning_effort, base.reasoning_effort);

        let mapped = with_pipeline_model(&base, &entry, Some(GatewayReasoningEffort::High));
        assert_eq!(mapped.reasoning_effort, Some(GatewayReasoningEffort::High));
        assert_eq!(mapped.messages, base.messages, "everything else is spread");
    }
}
