//! Model Hub routes — the 10 handlers under `/api/model-hub/**`.
//!
//! Port of `app/api/model-hub/**/route.ts`. The migration surface of OP-9:
//!
//! | Method(s) | Path | TypeScript |
//! | --- | --- | --- |
//! | GET, POST | `/api/model-hub/accounts` | `accounts/route.ts` |
//! | POST | `/api/model-hub/accounts/test-all` | `accounts/test-all/route.ts` |
//! | DELETE | `/api/model-hub/accounts/{accountId}` | `accounts/[accountId]/route.ts` |
//! | GET | `/api/model-hub/accounts/{accountId}/models` | `accounts/[accountId]/models/route.ts` |
//! | POST | `/api/model-hub/accounts/{accountId}/test` | `accounts/[accountId]/test/route.ts` |
//! | POST | `/api/model-hub/gateway` | `gateway/route.ts` |
//! | GET | `/api/model-hub/oauth/callback` | `oauth/callback/route.ts` |
//! | GET | `/api/model-hub/oauth/start` | `oauth/start/route.ts` |
//! | GET, PUT, POST | `/api/model-hub/pipeline` | `pipeline/route.ts` |
//! | GET | `/api/model-hub/providers` | `providers/route.ts` |
//!
//! # Status — created, not yet wired
//!
//! Intentionally **not** registered in `routes/mod.rs` (this task is additive
//! while peers hold the router). Until it is wired and `AppState` carries the
//! repository plus a [`ReqwestTransport`], the module is not compiled and
//! therefore not verified. The handlers are direct translations of the
//! TypeScript bodies over the ported `betaclaw-core` façade.
//!
//! `codexLocalCallbackBridge.ts` (the `1455` loopback bridge) and
//! `fetchWithPolicy` (retry/timeout) are not ported; the callback exchanges use a
//! plain form POST through the shared transport instead.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use betaclaw_core::model_hub::codex_auth::{
    get_open_ai_codex_client_id, OPENAI_CODEX_AUTHORIZE_URL, OPENAI_CODEX_LOCAL_REDIRECT_URI,
    OPENAI_CODEX_SCOPE, OPENAI_CODEX_TOKEN_URL,
};
use betaclaw_core::model_hub::connectivity::test_provider_account_connectivity;
use betaclaw_core::model_hub::env::EnvOverrides;
use betaclaw_core::model_hub::http::{HttpRequest, HttpTransport};
use betaclaw_core::model_hub::oauth::{
    create_oauth_nonce, create_oauth_state, create_pkce_pair, parse_oauth_state, OauthStatePayload,
};
use betaclaw_core::model_hub::openai_compatible::NOOP_ATTACHMENT_STORE;
use betaclaw_core::model_hub::provider_catalog::{catalog, find_provider};
use betaclaw_core::model_hub::providers::ProviderCall;
use betaclaw_core::model_hub::runtime::{get_model_hub_encryption_key, get_model_hub_service};
use betaclaw_core::model_hub::service::gateway::NoopObserver;
use betaclaw_core::model_hub::service::refresh::{NoCodexRefresh, OpenAICodexTokenRefresher};
use betaclaw_core::model_hub::service::types::ConnectProviderAccountInput;
use betaclaw_core::model_hub::service::{ModelHubService, ServiceDependencies};
use betaclaw_core::model_hub::sqlite::SqliteModelHubRepository;
use betaclaw_core::model_hub::types::{
    CreatePipelineModelInput, GatewayMessage, GatewayRequest, PipelineReasoningEffort,
    ProviderAuthMethod,
};
use betaclaw_core::model_hub::url_origin::{
    build_model_hub_callback_url, normalize_browser_origin,
};

use crate::auth_gate::{unauthorized_response, user_id_from_headers};
use crate::model_hub_transport::ReqwestTransport;
use crate::state::SharedState;

/// `MODEL_HUB_DB_PATH`, resolved like the TypeScript repository.
fn model_hub_db_path(env: &EnvOverrides) -> String {
    env.get("MODEL_HUB_DB_PATH")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "model-hub.db".to_string())
}

/// Everything a handler needs, assembled per request.
struct ModelHubContext {
    repository: SqliteModelHubRepository,
    transport: ReqwestTransport,
    env: EnvOverrides,
    encryption_key: String,
}

impl ModelHubContext {
    fn build(state: &SharedState) -> Result<Self, Response> {
        let env = EnvOverrides::new();
        let repository = SqliteModelHubRepository::open(&model_hub_db_path(&env))
            .map_err(|error| server_error(&error.to_string()))?;
        let encryption_key = get_model_hub_encryption_key(&env)
            .map_err(|error| bad_request(&error.to_string()))?;
        Ok(Self {
            repository,
            transport: ReqwestTransport::with_client(state.upstream.clone()),
            env,
            encryption_key,
        })
    }

    fn service(&self) -> ModelHubService<'_> {
        let dependencies = ServiceDependencies {
            transport: &self.transport,
            attachments: &NOOP_ATTACHMENT_STORE,
            observer: &NoopObserver,
            env: &self.env,
            codex: &NoCodexRefresh,
        };
        get_model_hub_service(&self.repository, dependencies)
    }

    fn provider_call(&self) -> ProviderCall<'_> {
        ProviderCall {
            transport: &self.transport,
            attachments: &NOOP_ATTACHMENT_STORE,
            env: &self.env,
        }
    }
}

fn server_error(message: &str) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "ok": false, "error": message })),
    )
        .into_response()
}

fn bad_request(message: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "ok": false, "error": message })),
    )
        .into_response()
}

fn not_found(message: &str) -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "ok": false, "error": message })),
    )
        .into_response()
}

/// The router for `routes/mod.rs`. Passed to `merge` once the module is wired.
pub fn router() -> Router<SharedState> {
    Router::new()
        .route(
            "/api/model-hub/accounts",
            get(list_accounts).post(create_account),
        )
        .route("/api/model-hub/accounts/test-all", post(test_all_accounts))
        .route(
            "/api/model-hub/accounts/{accountId}",
            delete(delete_account),
        )
        .route(
            "/api/model-hub/accounts/{accountId}/models",
            get(fetch_models),
        )
        .route(
            "/api/model-hub/accounts/{accountId}/test",
            post(test_account),
        )
        .route("/api/model-hub/gateway", post(gateway))
        .route("/api/model-hub/oauth/callback", get(oauth_callback))
        .route("/api/model-hub/oauth/start", get(oauth_start))
        .route(
            "/api/model-hub/pipeline",
            get(list_pipeline).put(save_pipeline).post(mutate_pipeline),
        )
        .route("/api/model-hub/providers", get(list_providers))
}


fn ensure_auth(headers: &HeaderMap) -> Option<Response> {
    if user_id_from_headers(headers).is_none() {
        Some(unauthorized_response())
    } else {
        None
    }
}

/// `providers/route.ts`: the catalog with OAuth readiness applied and the auth
/// methods sorted `none` < `api_key` < `oauth`.
async fn list_providers(
    State(_state): State<SharedState>,
    headers: HeaderMap,
) -> Response {
    if let Some(response) = ensure_auth(&headers) {
        return response;
    }
    let env = EnvOverrides::new();
    let github_ready = env
        .get("GITHUB_OAUTH_CLIENT_ID")
        .is_some_and(|value| !value.trim().is_empty());

    let providers: Vec<Value> = catalog()
        .iter()
        .map(|provider| {
            let oauth_ready = match provider.id.as_str() {
                "openai-codex" | "openrouter" => true,
                other => other == "github-copilot" && github_ready,
            };
            let mut methods: Vec<&ProviderAuthMethod> = provider
                .auth_methods
                .iter()
                .filter(|method| match method {
                    ProviderAuthMethod::None | ProviderAuthMethod::ApiKey => true,
                    ProviderAuthMethod::Oauth => {
                        provider.id == "openai-codex"
                            || provider.id == "openrouter"
                            || oauth_ready
                    }
                })
                .collect();
            methods.sort_by_key(|method| match method {
                ProviderAuthMethod::None => 0,
                ProviderAuthMethod::ApiKey => 1,
                ProviderAuthMethod::Oauth => 2,
            });
            if methods.is_empty() {
                methods.push(&ProviderAuthMethod::ApiKey);
            }
            let mut value = serde_json::to_value(provider).unwrap_or(Value::Null);
            value["authMethods"] = json!(methods);
            value["oauthConfigured"] = json!(if provider.id == "openrouter" {
                true
            } else {
                oauth_ready
            });
            value
        })
        .collect();

    (StatusCode::OK, Json(json!({ "ok": true, "providers": providers }))).into_response()
}

/// `accounts/route.ts` GET.
async fn list_accounts(
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> Response {
    if let Some(response) = ensure_auth(&headers) {
        return response;
    }
    let context = match ModelHubContext::build(&state) {
        Ok(context) => context,
        Err(response) => return response,
    };
    match context.service().list_accounts() {
        Ok(accounts) => {
            (StatusCode::OK, Json(json!({ "ok": true, "accounts": accounts }))).into_response()
        }
        Err(error) => server_error(&error.to_string()),
    }
}

/// `accounts/route.ts` POST.
#[derive(Debug, Deserialize)]
pub struct CreateAccountBody {
    #[serde(rename = "providerId")]
    provider_id: Option<String>,
    label: Option<String>,
    #[serde(rename = "authMethod")]
    auth_method: Option<String>,
    secret: Option<String>,
    #[serde(rename = "refreshToken")]
    refresh_token: Option<String>,
}

/// `validateCreateInput` from `accounts/route.ts:16-43`.
fn validate_create_input(body: &CreateAccountBody) -> Result<ConnectProviderAccountInput, String> {
    let provider_id = body.provider_id.clone().unwrap_or_default().trim().to_string();
    let label = body.label.clone().unwrap_or_default().trim().to_string();
    let auth_method = body.auth_method.clone().unwrap_or_default();
    let secret = body.secret.clone().unwrap_or_default().trim().to_string();
    let refresh_token = body.refresh_token.clone().filter(|value| !value.is_empty());

    if provider_id.is_empty() {
        return Err("providerId is required.".to_string());
    }
    if label.is_empty() {
        return Err("label is required.".to_string());
    }
    let method = match auth_method.as_str() {
        "none" => ProviderAuthMethod::None,
        "api_key" => ProviderAuthMethod::ApiKey,
        "oauth" => ProviderAuthMethod::Oauth,
        _ => return Err("authMethod must be none, api_key or oauth.".to_string()),
    };
    if method != ProviderAuthMethod::None && secret.is_empty() {
        return Err("secret is required.".to_string());
    }
    let Some(provider) = find_provider(&provider_id) else {
        return Err(format!("Unsupported providerId: {provider_id}"));
    };
    if !provider.has_auth_method(method) {
        return Err(format!(
            "{} does not support auth method {}.",
            provider.name,
            auth_method
        ));
    }

    Ok(ConnectProviderAccountInput {
        provider_id,
        label,
        auth_method: method,
        secret: if method == ProviderAuthMethod::None {
            String::new()
        } else {
            secret
        },
        refresh_token,
        encryption_key: String::new(),
    })
}

async fn create_account(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(body): Json<CreateAccountBody>,
) -> Response {
    if let Some(response) = ensure_auth(&headers) {
        return response;
    }
    let mut input = match validate_create_input(&body) {
        Ok(input) => input,
        Err(message) => return bad_request(&message),
    };
    let context = match ModelHubContext::build(&state) {
        Ok(context) => context,
        Err(response) => return response,
    };
    input.encryption_key = context.encryption_key.clone();

    match context.service().connect_account(input) {
        Ok(account) => {
            (StatusCode::OK, Json(json!({ "ok": true, "account": account }))).into_response()
        }
        Err(error) => bad_request(&error.to_string()),
    }
}


/// `accounts/[accountId]/route.ts` DELETE.
async fn delete_account(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(account_id): Path<String>,
) -> Response {
    if let Some(response) = ensure_auth(&headers) {
        return response;
    }
    let account_id = account_id.trim().to_string();
    if account_id.is_empty() {
        return bad_request("Missing accountId.");
    }
    let context = match ModelHubContext::build(&state) {
        Ok(context) => context,
        Err(response) => return response,
    };
    match context.service().delete_account(&account_id) {
        Ok(true) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Ok(false) => not_found("Account not found."),
        Err(error) => server_error(&error.to_string()),
    }
}

/// `accounts/[accountId]/models/route.ts` GET.
async fn fetch_models(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(account_id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<ModelsQuery>,
) -> Response {
    if let Some(response) = ensure_auth(&headers) {
        return response;
    }
    let account_id = account_id.trim().to_string();
    if account_id.is_empty() {
        return bad_request("Missing accountId.");
    }
    let purpose = match query
        .purpose
        .as_deref()
        .map(str::trim)
        .map(str::to_lowercase)
    {
        Some(value) if value == "embedding" => FetchPurpose::Embedding,
        _ => FetchPurpose::General,
    };
    let context = match ModelHubContext::build(&state) {
        Ok(context) => context,
        Err(response) => return response,
    };
    match context
        .service()
        .fetch_models_for_account_by_purpose(&account_id, &context.encryption_key, purpose)
        .await
    {
        Ok(models) => {
            (StatusCode::OK, Json(json!({ "ok": true, "models": models }))).into_response()
        }
        Err(error) => server_error(&error.to_string()),
    }
}

/// Query of `accounts/[accountId]/models/route.ts:14-15`.
#[derive(Debug, Deserialize)]
pub struct ModelsQuery {
    purpose: Option<String>,
}


/// `gateway/route.ts:8-25` request body.
#[derive(Debug, Default, Deserialize)]
pub struct GatewayBody {
    #[serde(rename = "accountId")]
    account_id: Option<String>,
    model: Option<String>,
    #[serde(rename = "profileId")]
    profile_id: Option<String>,
    #[serde(default)]
    messages: Vec<GatewayMessage>,
    #[serde(rename = "max_tokens")]
    max_tokens: Option<i64>,
    temperature: Option<f64>,
    reasoning_effort: Option<String>,
    #[serde(rename = "systemInstruction")]
    system_instruction: Option<String>,
    tools: Option<Vec<Value>>,
    #[serde(rename = "responseMimeType")]
    response_mime_type: Option<String>,
    operation: Option<String>,
    payload: Option<Value>,
}

/// `gateway/route.ts` POST.
async fn gateway(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(body): Json<GatewayBody>,
) -> Response {
    if let Some(response) = ensure_auth(&headers) {
        return response;
    }
    let context = match ModelHubContext::build(&state) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let service = context.service();

    // ─── Embeddings pass-through (`gateway/route.ts:31-40`) ────────────────
    if matches!(body.operation.as_deref(), Some("embedContent") | Some("batchEmbedContents")) {
        let input = betaclaw_core::model_hub::service::types::EmbeddingInput {
            operation: betaclaw_core::model_hub::service::types::EmbeddingOperation::parse(
                body.operation.as_deref().unwrap_or_default(),
            ),
            payload: body.payload.clone().unwrap_or(Value::Object(Default::default())),
        };
        return match service
            .dispatch_embedding(&context.encryption_key, &input)
            .await
        {
            Ok(result) => (StatusCode::OK, Json(result)).into_response(),
            Err(error) => server_error(&error.to_string()),
        };
    }

    if body.messages.is_empty() {
        return bad_request("messages array is required and must not be empty.");
    }

    let mut request = GatewayRequest::new(body.model.clone().unwrap_or_default(), body.messages.clone());
    request.max_tokens = body.max_tokens;
    request.temperature = body.temperature;
    request.reasoning_effort = body
        .reasoning_effort
        .as_deref()
        .and_then(|value| serde_json::from_value(Value::String(value.to_string())).ok());
    request.system_instruction = body.system_instruction.clone();
    request.tools = body.tools.clone();
    request.response_mime_type = body.response_mime_type.clone();
    request.audit_context = Some(betaclaw_core::model_hub::types::GatewayAuditContext {
        kind: betaclaw_core::model_hub::types::GatewayAuditKind::ApiGateway,
        task_id: None,
        step_id: None,
        node_id: None,
    });

    let result = match (body.account_id.as_deref(), body.model.as_deref()) {
        (Some(account_id), Some(_)) => {
            service
                .dispatch_chat(account_id, &context.encryption_key, &request)
                .await
        }
        _ => {
            let profile_id = body
                .profile_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("p1");
            service
                .dispatch_with_fallback(profile_id, &context.encryption_key, &request, None)
                .await
        }
    };

    match result {
        Ok(response) => {
            let status = if response.ok {
                StatusCode::OK
            } else {
                StatusCode::BAD_GATEWAY
            };
            (status, Json(response)).into_response()
        }
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "text": "", "model": "", "provider": "", "error": error.to_string() })),
        )
            .into_response(),
    }
}


/// `pipeline/route.ts:12-18` model payload.
#[derive(Debug, Clone, Deserialize)]
pub struct PipelineModelPayload {
    #[serde(rename = "accountId")]
    account_id: String,
    #[serde(rename = "providerId")]
    provider_id: String,
    #[serde(rename = "modelName")]
    model_name: String,
    #[serde(rename = "reasoningEffort")]
    reasoning_effort: Option<String>,
    #[serde(default)]
    priority: Option<i64>,
}

fn parse_reasoning_effort(value: Option<&str>) -> Result<Option<PipelineReasoningEffort>, ()> {
    match value.map(str::trim) {
        None | Some("") => Ok(None),
        Some(raw) => PipelineReasoningEffort::parse(&raw.to_lowercase())
            .map(Some)
            .ok_or(()),
    }
}

/// `pipeline/route.ts` GET query.
#[derive(Debug, Default, Deserialize)]
pub struct PipelineQuery {
    #[serde(rename = "profileId")]
    profile_id: Option<String>,
    #[serde(rename = "includeEmbeddings")]
    include_embeddings: Option<String>,
    #[serde(rename = "includeGraphiti")]
    include_graphiti: Option<String>,
}

async fn list_pipeline(
    State(state): State<SharedState>,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<PipelineQuery>,
) -> Response {
    if let Some(response) = ensure_auth(&headers) {
        return response;
    }
    let context = match ModelHubContext::build(&state) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let service = context.service();
    let profile_id = query
        .profile_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("p1");

    let models = match service.list_pipeline(profile_id) {
        Ok(models) => models,
        Err(error) => return server_error(&error.to_string()),
    };
    let mut body = json!({ "ok": true, "profileId": profile_id, "models": models });
    if query.include_embeddings.as_deref() == Some("true") {
        body["embeddingModels"] = json!(service.list_pipeline("p1-embeddings").unwrap_or_default());
    }
    if query.include_graphiti.as_deref() == Some("true") {
        body["graphitiModels"] = json!(service.list_pipeline("p1-graphiti").unwrap_or_default());
    }
    (StatusCode::OK, Json(body)).into_response()
}


/// `pipeline/route.ts:20-32` PUT body.
#[derive(Debug, Default, Deserialize)]
pub struct SavePipelineBody {
    #[serde(rename = "profileId")]
    profile_id: Option<String>,
    #[serde(default)]
    models: Option<Vec<PipelineModelPayload>>,
}

/// `pipeline/route.ts` PUT.
async fn save_pipeline(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(body): Json<SavePipelineBody>,
) -> Response {
    if let Some(response) = ensure_auth(&headers) {
        return response;
    }
    let Some(models) = body.models else {
        return bad_request("models array is required.");
    };
    let profile_id = body
        .profile_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("p1")
        .to_string();

    let mut normalized: Vec<CreatePipelineModelInput> = Vec::new();
    for (index, model) in models.iter().enumerate() {
        if model.account_id.is_empty() || model.provider_id.is_empty() || model.model_name.is_empty()
        {
            return bad_request("Each model needs accountId, providerId, modelName.");
        }
        let reasoning_effort = match parse_reasoning_effort(model.reasoning_effort.as_deref()) {
            Ok(value) => value,
            Err(()) => {
                return bad_request(
                    "reasoningEffort must be one of: off, minimal, low, medium, high, xhigh.",
                )
            }
        };
        normalized.push(CreatePipelineModelInput {
            profile_id: profile_id.clone(),
            account_id: model.account_id.clone(),
            provider_id: model.provider_id.clone(),
            model_name: model.model_name.clone(),
            reasoning_effort,
            priority: model.priority.unwrap_or(index as i64 + 1),
        });
    }

    let context = match ModelHubContext::build(&state) {
        Ok(context) => context,
        Err(response) => return response,
    };
    match context.service().replace_pipeline(&profile_id, &normalized) {
        Ok(saved) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "profileId": profile_id, "models": saved })),
        )
            .into_response(),
        Err(error) => server_error(&error.to_string()),
    }
}


/// `pipeline/route.ts:49-52` POST body.
#[derive(Debug, Default, Deserialize)]
pub struct MutatePipelineBody {
    action: Option<String>,
    #[serde(rename = "profileId")]
    profile_id: Option<String>,
    #[serde(rename = "accountId")]
    account_id: Option<String>,
    #[serde(rename = "providerId")]
    provider_id: Option<String>,
    #[serde(rename = "modelName")]
    model_name: Option<String>,
    #[serde(rename = "reasoningEffort")]
    reasoning_effort: Option<String>,
    priority: Option<i64>,
    #[serde(rename = "modelId")]
    model_id: Option<String>,
    status: Option<String>,
    direction: Option<String>,
}

/// `pipeline/route.ts` POST — the `actionHandlers` table of `:106-201`.
async fn mutate_pipeline(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(body): Json<MutatePipelineBody>,
) -> Response {
    if let Some(response) = ensure_auth(&headers) {
        return response;
    }
    let context = match ModelHubContext::build(&state) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let service = context.service();
    let action = body.action.as_deref().unwrap_or("add");

    match action {
        "add" => {
            let (Some(account_id), Some(provider_id), Some(model_name)) = (
                body.account_id.clone(),
                body.provider_id.clone(),
                body.model_name.clone(),
            ) else {
                return bad_request("accountId, providerId and modelName are required.");
            };
            let reasoning_effort = match parse_reasoning_effort(body.reasoning_effort.as_deref()) {
                Ok(value) => value,
                Err(()) => return bad_request("Invalid reasoningEffort."),
            };
            let input = CreatePipelineModelInput {
                profile_id: body.profile_id.clone().unwrap_or_else(|| "p1".to_string()),
                account_id,
                provider_id,
                model_name,
                reasoning_effort,
                priority: body.priority.unwrap_or(1),
            };
            match service.add_model_to_pipeline(input) {
                Ok(model) => {
                    (StatusCode::OK, Json(json!({ "ok": true, "model": model }))).into_response()
                }
                Err(error) => server_error(&error.to_string()),
            }
        }
        "remove" => {
            let Some(model_id) = body.model_id.as_deref() else {
                return bad_request("modelId is required.");
            };
            match service.remove_model_from_pipeline(model_id) {
                Ok(removed) => {
                    (StatusCode::OK, Json(json!({ "ok": true, "removed": removed }))).into_response()
                }
                Err(error) => server_error(&error.to_string()),
            }
        }
        "update-status" => {
            let (Some(model_id), Some(status)) = (body.model_id.as_deref(), body.status.as_deref())
            else {
                return bad_request("modelId and status are required.");
            };
            let Some(status) = betaclaw_core::model_hub::types::PipelineStatus::parse(status) else {
                return bad_request("status must be active, rate-limited or offline.");
            };
            match service.update_model_status(model_id, status) {
                Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
                Err(error) => server_error(&error.to_string()),
            }
        }
        "reorder" => {
            let (Some(profile_id), Some(model_id)) =
                (body.profile_id.as_deref(), body.model_id.as_deref())
            else {
                return bad_request("profileId and modelId are required.");
            };
            let direction = match body.direction.as_deref() {
                Some("up") => {
                    betaclaw_core::model_hub::service::pipeline::update::PipelineDirection::Up
                }
                Some("down") => {
                    betaclaw_core::model_hub::service::pipeline::update::PipelineDirection::Down
                }
                _ => return bad_request("direction must be up or down."),
            };
            match service.move_pipeline_model(profile_id, model_id, direction) {
                Ok(moved) => {
                    (StatusCode::OK, Json(json!({ "ok": true, "moved": moved }))).into_response()
                }
                Err(error) => server_error(&error.to_string()),
            }
        }
        other => bad_request(&format!("Unknown action: {other}")),
    }
}


/// `oauth/start/route.ts:21-47`: the popup result page.
fn popup_result(ok: bool, message: &str, status: StatusCode) -> Response {
    let payload = json!({ "type": "MODEL_HUB_OAUTH_RESULT", "ok": ok, "message": message });
    let html = format!(
        "<!doctype html>\n<html>\n  <head><meta charset=\"utf-8\" /><title>Model Hub OAuth</title></head>\n  <body>\n    <script>\n      (function () {{\n        const payload = {payload};\n        if (window.opener) {{ window.opener.postMessage(payload, '*'); }}\n        document.body.innerText = payload.message;\n        setTimeout(function () {{ window.close(); }}, 250);\n      }})();\n    </script>\n  </body>\n</html>"
    );
    (
        status,
        [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
        html,
    )
        .into_response()
}

/// The absolute request URL, from the `Host`/`X-Forwarded-Proto` headers.
fn absolute_url(headers: &HeaderMap, uri: &axum::http::Uri) -> Option<String> {
    let host = headers
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())?;
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("http");
    let path = uri
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/");
    Some(format!("{scheme}://{host}{path}"))
}

/// `oauth/start/route.ts` GET query.
#[derive(Debug, Default, Deserialize)]
pub struct OauthStartQuery {
    #[serde(rename = "providerId")]
    provider_id: Option<String>,
    label: Option<String>,
}

/// `encodeURIComponent`-style encoding for the query values below.
fn urlencoding(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}


/// `oauth/start/route.ts` GET.
async fn oauth_start(
    State(state): State<SharedState>,
    headers: HeaderMap,
    uri: axum::http::Uri,
    axum::extract::Query(query): axum::extract::Query<OauthStartQuery>,
) -> Response {
    if let Some(response) = ensure_auth(&headers) {
        return response;
    }
    let _ = &state;
    let provider_id = query
        .provider_id
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    if provider_id.is_empty() {
        return popup_result(false, "providerId is required.", StatusCode::BAD_REQUEST);
    }
    let Some(provider) = find_provider(&provider_id) else {
        return popup_result(
            false,
            &format!("Unknown provider: {provider_id}"),
            StatusCode::BAD_REQUEST,
        );
    };
    if !provider.has_auth_method(ProviderAuthMethod::Oauth) {
        return popup_result(
            false,
            &format!("{} does not support OAuth.", provider.name),
            StatusCode::BAD_REQUEST,
        );
    }

    let env = EnvOverrides::new();
    let signing_key = match get_model_hub_encryption_key(&env) {
        Ok(key) => key,
        Err(error) => {
            return popup_result(
                false,
                &error.to_string(),
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };
    let callback_url = absolute_url(&headers, &uri)
        .and_then(|url| build_model_hub_callback_url(&url).ok())
        .unwrap_or_default();

    let label = query
        .label
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{} OAuth", provider.name));
    let nonce = match create_oauth_nonce() {
        Ok(nonce) => nonce,
        Err(error) => {
            return popup_result(
                false,
                &error.to_string(),
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };
    let base = OauthStatePayload {
        provider_id: provider_id.clone(),
        label,
        created_at: betaclaw_core::model_hub::oauth::now_ms(),
        nonce,
        code_verifier: None,
        oauth_redirect_uri: None,
    };

    if provider_id == "openrouter" {
        let pair = match create_pkce_pair() {
            Ok(pair) => pair,
            Err(error) => {
                return popup_result(
                    false,
                    &error.to_string(),
                    StatusCode::INTERNAL_SERVER_ERROR,
                )
            }
        };
        let state = OauthStatePayload {
            code_verifier: Some(pair.code_verifier),
            ..base
        };
        let state = create_oauth_state(&state, &signing_key);
        let authorize = format!(
            "https://openrouter.ai/auth?callback_url={}&code_challenge={}&code_challenge_method=S256&state={}",
            urlencoding(&callback_url),
            urlencoding(&pair.code_challenge),
            urlencoding(&state),
        );
        return (StatusCode::FOUND, [(axum::http::header::LOCATION, authorize)]).into_response();
    }

    if provider_id == "openai-codex" {
        // The loopback `1455` bridge (`codexLocalCallbackBridge.ts`) is not ported;
        // the configured redirect URI is used as-is.
        let redirect_uri = env
            .get("OPENAI_OAUTH_REDIRECT_URI")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| OPENAI_CODEX_LOCAL_REDIRECT_URI.to_string());
        let pair = match create_pkce_pair() {
            Ok(pair) => pair,
            Err(error) => {
                return popup_result(
                    false,
                    &error.to_string(),
                    StatusCode::INTERNAL_SERVER_ERROR,
                )
            }
        };
        let state = OauthStatePayload {
            code_verifier: Some(pair.code_verifier),
            oauth_redirect_uri: Some(redirect_uri.clone()),
            ..base
        };
        let state = create_oauth_state(&state, &signing_key);
        let client_id = get_open_ai_codex_client_id(&env);
        let authorize_url = env
            .get("OPENAI_OAUTH_AUTHORIZE_URL")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| OPENAI_CODEX_AUTHORIZE_URL.to_string());
        let scope = env
            .get("OPENAI_OAUTH_SCOPE")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| OPENAI_CODEX_SCOPE.to_string());
        let originator = env
            .get("OPENAI_OAUTH_ORIGINATOR")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "pi".to_string());
        let authorize = format!(
            "{authorize_url}?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}&code_challenge={}&code_challenge_method=S256&id_token_add_organizations=true&codex_cli_simplified_flow=true&originator={}",
            urlencoding(&client_id),
            urlencoding(&redirect_uri),
            urlencoding(&scope),
            urlencoding(&state),
            urlencoding(&pair.code_challenge),
            urlencoding(&originator),
        );
        return (StatusCode::FOUND, [(axum::http::header::LOCATION, authorize)]).into_response();
    }

    popup_result(
        false,
        &format!("OAuth flow for {} is not configured.", provider.name),
        StatusCode::BAD_REQUEST,
    )
}

