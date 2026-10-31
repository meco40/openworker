//! Test doubles for the `model_hub` service layer.
//!
//! The TypeScript tests reach for `vi.mock` and in-memory `better-sqlite3`
//! databases. Rust gets explicit stubs instead, so a test states exactly which
//! repository rows and which HTTP responses the dispatch path will see, and can
//! assert which writes resulted.
//!
//! Everything here is compiled for tests only. Production wiring is the caller's
//! responsibility: the gateway passes a `reqwest` transport, a real observer and
//! the real Codex refresher.

use std::sync::OnceLock;

use http::{HeaderMap, Method, StatusCode};

use crate::model_hub::env::EnvOverrides;
use crate::model_hub::http::{HttpError, HttpRequest, HttpResponse, HttpTransport};
use crate::model_hub::repository::{
    CreatePipelineModelInput, CreateProviderAccountInput, ModelHubRepository, RepositoryError,
    UpdateAccountCredentialsInput,
};
use crate::model_hub::service::gateway::{
    DispatchObserver, DispatchStatus, ObserverError, PromptDispatchEvent, TokenCountSource,
    TokenUsageRecord,
};
pub use crate::model_hub::tests::StubAttachmentStore;
use crate::model_hub::types::{
    GatewayAuditKind, PipelineModelEntry, PipelineStatus, ProviderAccountRecord,
    ProviderAccountView,
};

/// An in-memory [`ModelHubRepository`].
///
/// `default()` yields an empty store; the `with_*` builders seed the rows the
/// dispatch path reads. Every write is recorded, which is the Rust equivalent of
/// asserting on the SQL statements `better-sqlite3` received in the TS tests.
#[derive(Default)]
pub struct StubRepository {
    accounts: std::sync::Mutex<Vec<ProviderAccountRecord>>,
    pipeline: std::sync::Mutex<Vec<PipelineModelEntry>>,
    credential_updates: std::sync::Mutex<Vec<UpdateAccountCredentialsInput>>,
    status_updates: std::sync::Mutex<Vec<(String, PipelineStatus)>>,
    pipeline_requests: std::sync::Mutex<Vec<String>>,
}

impl StubRepository {
    pub fn with_accounts(self, accounts: Vec<ProviderAccountRecord>) -> Self {
        *self.accounts.lock().expect("lock") = accounts;
        self
    }

    pub fn with_pipeline(self, pipeline: Vec<PipelineModelEntry>) -> Self {
        *self.pipeline.lock().expect("lock") = pipeline;
        self
    }

    /// How many times `update_account_credentials` was called.
    pub fn credential_updates(&self) -> usize {
        self.credential_updates.lock().expect("lock").len()
    }

    /// Every credentials payload that was persisted, in call order.
    pub fn recorded_credentials(&self) -> Vec<UpdateAccountCredentialsInput> {
        self.credential_updates.lock().expect("lock").clone()
    }

    /// `(pipeline model id, new status)` per `set_health_status` call.
    pub fn status_updates(&self) -> Vec<(String, PipelineStatus)> {
        self.status_updates.lock().expect("lock").clone()
    }

    /// The profile ids every pipeline read asked for, in call order.
    pub fn pipeline_requests(&self) -> Vec<String> {
        self.pipeline_requests.lock().expect("lock").clone()
    }
}

impl ModelHubRepository for StubRepository {
    fn create_account(
        &self,
        _input: CreateProviderAccountInput,
    ) -> Result<ProviderAccountView, RepositoryError> {
        Err(RepositoryError::MissingRow(
            "create_account is not stubbed".to_string(),
        ))
    }

    fn list_accounts(&self) -> Result<Vec<ProviderAccountView>, RepositoryError> {
        Ok(self
            .accounts
            .lock()
            .expect("lock")
            .iter()
            .map(ProviderAccountRecord::view)
            .collect())
    }

    fn get_account_record_by_id(
        &self,
        id: &str,
    ) -> Result<Option<ProviderAccountRecord>, RepositoryError> {
        Ok(self
            .accounts
            .lock()
            .expect("lock")
            .iter()
            .find(|account| account.id == id)
            .cloned())
    }

    fn update_account_credentials(
        &self,
        input: UpdateAccountCredentialsInput,
    ) -> Result<(), RepositoryError> {
        self.credential_updates.lock().expect("lock").push(input);
        Ok(())
    }

    fn set_health_status(
        &self,
        id: &str,
        ok: bool,
        _message: Option<&str>,
    ) -> Result<(), RepositoryError> {
        let status = if ok {
            PipelineStatus::Active
        } else {
            PipelineStatus::Offline
        };
        self.status_updates
            .lock()
            .expect("lock")
            .push((id.to_string(), status));
        Ok(())
    }

    fn delete_account(&self, id: &str) -> Result<bool, RepositoryError> {
        let mut accounts = self.accounts.lock().expect("lock");
        let before = accounts.len();
        accounts.retain(|account| account.id != id);
        Ok(accounts.len() != before)
    }

    fn list_pipeline_models(
        &self,
        profile_id: &str,
    ) -> Result<Vec<PipelineModelEntry>, RepositoryError> {
        self.pipeline_requests
            .lock()
            .expect("lock")
            .push(profile_id.to_string());
        Ok(self.pipeline.lock().expect("lock").clone())
    }

    fn add_pipeline_model(
        &self,
        _input: CreatePipelineModelInput,
    ) -> Result<PipelineModelEntry, RepositoryError> {
        Err(RepositoryError::MissingRow(
            "add_pipeline_model is not stubbed".to_string(),
        ))
    }

    fn remove_pipeline_model(&self, _id: &str) -> Result<bool, RepositoryError> {
        Ok(false)
    }

    fn update_pipeline_model_status(
        &self,
        id: &str,
        status: PipelineStatus,
    ) -> Result<(), RepositoryError> {
        self.status_updates
            .lock()
            .expect("lock")
            .push((id.to_string(), status));
        Ok(())
    }

    fn update_pipeline_model_priority(
        &self,
        _id: &str,
        _priority: i64,
    ) -> Result<(), RepositoryError> {
        Ok(())
    }

    fn replace_pipeline(
        &self,
        _profile_id: &str,
        _models: &[CreatePipelineModelInput],
    ) -> Result<Vec<PipelineModelEntry>, RepositoryError> {
        Ok(Vec::new())
    }
}

/// A recorded HTTP exchange, for asserting on the request the adapters built.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct RecordedRequest {
    pub url: String,
    pub method: Method,
    pub body: Option<String>,
}

/// What the transport answers with on its next call.
#[allow(dead_code)]
enum Scripted {
    Response(HttpResponse),
    Failure(String),
    Status(StatusCode),
}

/// A scripted [`HttpTransport`].
///
/// * [`StubTransport::default`] fails every call with a transport error.
/// * [`StubTransport::json`] answers every call with one status and JSON body.
/// * [`StubTransport::replay`] answers a fixed sequence, which is how the
///   fallback chain is exercised: a `429` then a `403` in, two failures out.
/// * [`StubTransport::event_stream`] answers with a Server-Sent-Events body.
#[derive(Default)]
pub struct StubTransport {
    script: std::sync::Mutex<Vec<Scripted>>,
    recorded: std::sync::Mutex<Vec<RecordedRequest>>,
}

impl StubTransport {
    /// Answers every request with `status` and `body`.
    pub fn json(status: StatusCode, body: &serde_json::Value) -> Self {
        Self {
            script: std::sync::Mutex::new(vec![Scripted::Response(HttpResponse {
                status,
                status_text: status.canonical_reason().unwrap_or_default().to_string(),
                headers: HeaderMap::new(),
                body: body.to_string(),
                body_bytes: body.to_string().into_bytes(),
            })]),
            recorded: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// Answers requests in order from `script`.
    pub fn replay(script: Vec<Result<StatusCode, StatusCode>>) -> Self {
        let mapped = script
            .into_iter()
            .map(|entry| match entry {
                Ok(status) => Scripted::Status(status),
                Err(status) => Scripted::Status(status),
            })
            .collect();
        Self {
            script: std::sync::Mutex::new(mapped),
            recorded: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// Answers with a Server-Sent-Events body.
    ///
    /// The body is returned verbatim, not JSON-encoded: wrapping it in a JSON
    /// string would escape the newlines and the SSE parser would see one line
    /// instead of a stream.
    pub fn event_stream(body: &str) -> Self {
        // The SSE path is only taken when the response carries
        // `content-type: text/event-stream`, so the header has to be set or the
        // dispatcher falls back to parsing the body as a single JSON document.
        let mut headers = HeaderMap::new();
        headers.insert(
            http::header::CONTENT_TYPE,
            http::HeaderValue::from_static("text/event-stream"),
        );
        Self {
            script: std::sync::Mutex::new(vec![Scripted::Response(HttpResponse {
                status: StatusCode::OK,
                status_text: "OK".to_string(),
                headers,
                body: body.to_string(),
                body_bytes: body.as_bytes().to_vec(),
            })]),
            recorded: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// How many requests this transport received.
    pub fn request_count(&self) -> usize {
        self.recorded.lock().expect("lock").len()
    }

    /// Every request the adapter sent, in order.
    pub fn recorded(&self) -> Vec<RecordedRequest> {
        self.recorded.lock().expect("lock").clone()
    }
}

impl HttpTransport for StubTransport {
    fn send<'a>(
        &'a self,
        request: HttpRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<HttpResponse, HttpError>> + Send + 'a>,
    > {
        self.recorded.lock().expect("lock").push(RecordedRequest {
            url: request.url.clone(),
            method: request.method.clone(),
            body: request.body.clone(),
        });
        Box::pin(async move {
            let mut script = self.script.lock().expect("lock");
            if script.is_empty() {
                return Err(HttpError::Transport(
                    "StubTransport has no scripted response left".to_string(),
                ));
            }
            let next = script.remove(0);
            match next {
                Scripted::Response(response) => Ok(response),
                Scripted::Status(status) => Ok(HttpResponse {
                    status,
                    status_text: status.canonical_reason().unwrap_or_default().to_string(),
                    headers: HeaderMap::new(),
                    body: String::new(),
                    body_bytes: Vec::new(),
                }),
                Scripted::Failure(message) => Err(HttpError::Transport(message)),
            }
        })
    }
}

/// An owned shadow of [`PromptDispatchEvent`], which borrows its inputs and so
/// cannot outlive the call it was handed.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct RecordedDispatch {
    pub model_name: String,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub status: DispatchStatus,
    pub prompt_tokens_source: TokenCountSource,
    pub dispatch_kind: GatewayAuditKind,
}

/// A [`DispatchObserver`] that records what it was told.
///
/// [`RecordingObserver::succeeding`] never fails; [`RecordingObserver::failing`]
/// returns an error on the first call, so a test can prove that a statistics
/// failure does not abort the dispatch. Both are the Rust equivalent of the
/// TypeScript tests that stub the stats repositories.
#[derive(Default)]
pub struct RecordingObserver {
    fail: bool,
    usages: std::sync::Mutex<Vec<TokenUsageRecord>>,
    dispatches: std::sync::Mutex<Vec<RecordedDispatch>>,
}

impl RecordingObserver {
    pub fn succeeding() -> Self {
        Self::default()
    }

    pub fn failing() -> Self {
        Self {
            fail: true,
            ..Self::default()
        }
    }

    pub fn usages(&self) -> Vec<TokenUsageRecord> {
        self.usages.lock().expect("lock").clone()
    }

    /// The dispatches this observer was told about.
    pub fn prompt_dispatches(&self) -> Vec<RecordedDispatch> {
        self.dispatches.lock().expect("lock").clone()
    }
}

impl DispatchObserver for RecordingObserver {
    fn on_usage(&self, usage: &TokenUsageRecord) -> Result<(), ObserverError> {
        // Record first, fail second. The TypeScript test stubs the stats
        // repository to throw *after* it has been handed the record, so the
        // observer is expected to have seen the call even when it reports a
        // failure — otherwise the "never breaks dispatch" assertion has nothing
        // to observe.
        self.usages.lock().expect("lock").push(usage.clone());
        if self.fail {
            return Err(ObserverError::new("scripted failure"));
        }
        Ok(())
    }

    fn on_prompt_dispatch(&self, event: &PromptDispatchEvent<'_>) -> Result<(), ObserverError> {
        self.dispatches
            .lock()
            .expect("lock")
            .push(RecordedDispatch {
                model_name: event.request.model.clone(),
                prompt_tokens: event.prompt_tokens,
                completion_tokens: event.completion_tokens,
                total_tokens: event.total_tokens,
                status: event.status,
                prompt_tokens_source: event.prompt_tokens_source,
                dispatch_kind: event.dispatch_kind,
            });
        if self.fail {
            return Err(ObserverError::new("scripted failure"));
        }
        Ok(())
    }
}

/// An [`EnvOverrides`] with no entries, for tests that do not care.
/// A promoted attachment store, so or_test can borrow it in a single
/// expression without a temporary dying at the semicolon.
pub fn no_attachments() -> &'static StubAttachmentStore {
    static STORE: OnceLock<StubAttachmentStore> = OnceLock::new();
    STORE.get_or_init(StubAttachmentStore::default)
}

#[allow(dead_code)]
pub fn empty_env() -> &'static EnvOverrides {
    static ENV: OnceLock<EnvOverrides> = OnceLock::new();
    ENV.get_or_init(EnvOverrides::new)
}
