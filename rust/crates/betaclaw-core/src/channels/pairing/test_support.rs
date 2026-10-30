//! Test doubles for the channel ports: an in-memory credential store, a scripted
//! HTTP transport, a recording inbound port and an environment with the
//! channel variables cleared. Compiled for tests only.

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use http::StatusCode;
use serde_json::Value;

use super::credentials::{ChannelCredential, ChannelCredentialStore, ChannelEnv};
use super::telegram_inbound::{TelegramDispatch, TelegramInboundPort};
use crate::channels::adapters::telegram::types::TelegramCallbackQuery;
use crate::channels::adapters::types::{response_json, ChannelError};
use crate::messages_store::now_iso;
use crate::model_hub::http::{BoxFuture, HttpError, HttpRequest, HttpResponse, HttpTransport};

/// In-memory `channel_credentials`, ordered like the SQL `ORDER BY key`.
#[derive(Default)]
pub struct MemoryStore {
    rows: Mutex<BTreeMap<(String, String), (String, String)>>,
}

pub fn memory_store() -> Arc<dyn ChannelCredentialStore> {
    Arc::new(MemoryStore::default())
}

impl MemoryStore {
    fn rows(&self) -> MutexGuard<'_, BTreeMap<(String, String), (String, String)>> {
        self.rows.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl ChannelCredentialStore for MemoryStore {
    fn get_credential(&self, channel: &str, key: &str) -> Option<String> {
        self.rows()
            .get(&(channel.to_string(), key.to_string()))
            .map(|(value, _)| value.clone())
    }

    fn set_credential(&self, channel: &str, key: &str, value: &str) {
        self.rows().insert(
            (channel.to_string(), key.to_string()),
            (value.to_string(), now_iso()),
        );
    }

    fn delete_credential(&self, channel: &str, key: &str) {
        self.rows().remove(&(channel.to_string(), key.to_string()));
    }

    fn delete_credentials(&self, channel: &str) {
        self.rows()
            .retain(|(row_channel, _), _| row_channel != channel);
    }

    fn list_credentials(&self, channel: &str) -> Vec<ChannelCredential> {
        self.rows()
            .iter()
            .filter(|((row_channel, _), _)| row_channel == channel)
            .map(
                |((row_channel, key), (value, updated_at))| ChannelCredential {
                    channel: row_channel.clone(),
                    key: key.clone(),
                    value: value.clone(),
                    updated_at: updated_at.clone(),
                },
            )
            .collect()
    }
}

/// An environment in which every channel variable reads as absent, so the
/// developer's real environment cannot leak into a test.
pub fn isolated_env() -> Arc<ChannelEnv> {
    let env = ChannelEnv::new();
    for name in [
        "APP_URL",
        "NEXTAUTH_URL",
        "VERCEL_URL",
        "TELEGRAM_BOT_TOKEN",
        "TELEGRAM_WEBHOOK_SECRET",
        "DISCORD_BOT_TOKEN",
        "SLACK_BOT_TOKEN",
        "WHATSAPP_BRIDGE_URL",
        "IMESSAGE_BRIDGE_URL",
        "WHATSAPP_WEBHOOK_SECRET",
        "IMESSAGE_WEBHOOK_SECRET",
    ] {
        env.set(name, "");
    }
    Arc::new(env)
}

/// A JSON answer with the given status.
pub fn json_response(status: u16, body: Value) -> HttpResponse {
    HttpResponse::json(StatusCode::from_u16(status).expect("valid status"), &body)
}

struct Route {
    needle: String,
    responses: VecDeque<Result<HttpResponse, HttpError>>,
}

/// Answers each request with the first route whose needle occurs in the URL.
/// A route with several answers gives them out in order and then repeats the
/// last one. A request without a route fails with a transport error.
#[derive(Default)]
pub struct ScriptedTransport {
    routes: Mutex<Vec<Route>>,
    requests: Mutex<Vec<HttpRequest>>,
}

impl ScriptedTransport {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Queues an answer for requests whose URL contains `needle`.
    pub fn then(&self, needle: &str, response: HttpResponse) {
        self.then_result(needle, Ok(response));
    }

    fn then_result(&self, needle: &str, result: Result<HttpResponse, HttpError>) {
        let mut routes = self.routes.lock().unwrap_or_else(PoisonError::into_inner);
        let position = routes.iter().position(|route| route.needle == needle);
        match position {
            Some(index) => routes[index].responses.push_back(result),
            None => routes.push(Route {
                needle: needle.to_string(),
                responses: VecDeque::from([result]),
            }),
        }
    }

    /// Every request sent so far.
    pub fn requests(&self) -> Vec<HttpRequest> {
        self.requests
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// The requests whose URL contains `needle`.
    pub fn calls(&self, needle: &str) -> Vec<HttpRequest> {
        self.requests()
            .into_iter()
            .filter(|request| request.url.contains(needle))
            .collect()
    }

    /// The JSON body of a request, or `null` when it has none.
    pub fn body_of(request: &HttpRequest) -> Value {
        response_json(&HttpResponse::text(
            StatusCode::OK,
            request.body.clone().unwrap_or_default(),
        ))
    }
}

impl HttpTransport for ScriptedTransport {
    fn send<'a>(&'a self, request: HttpRequest) -> BoxFuture<'a, Result<HttpResponse, HttpError>> {
        Box::pin(async move {
            self.requests
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(request.clone());
            let mut routes = self.routes.lock().unwrap_or_else(PoisonError::into_inner);
            match routes
                .iter_mut()
                .find(|route| request.url.contains(&route.needle))
            {
                Some(route) if route.responses.len() > 1 => route
                    .responses
                    .pop_front()
                    .unwrap_or_else(|| Err(HttpError::Transport("no answer".into()))),
                Some(route) => route
                    .responses
                    .front()
                    .cloned()
                    .unwrap_or_else(|| Err(HttpError::Transport("no answer".into()))),
                None => Err(HttpError::Transport(format!(
                    "no scripted route for {}",
                    request.method
                ))),
            }
        })
    }
}

/// Records the inbound calls and answers as configured.
#[derive(Default)]
pub struct RecordingPort {
    pub native_command_handled: bool,
    pub dispatched: Mutex<Vec<String>>,
    pub callbacks: Mutex<Vec<String>>,
}

impl TelegramInboundPort for RecordingPort {
    fn handle_native_command<'a>(
        &'a self,
        _chat_id: &'a str,
        _text: &'a str,
        _external_chat_id: &'a str,
    ) -> BoxFuture<'a, Result<bool, ChannelError>> {
        Box::pin(async move { Ok(self.native_command_handled) })
    }

    fn handle_model_callback<'a>(
        &'a self,
        query: &'a TelegramCallbackQuery,
    ) -> BoxFuture<'a, Result<bool, ChannelError>> {
        Box::pin(async move {
            self.callbacks
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(query.id.clone());
            Ok(true)
        })
    }

    fn dispatch_message<'a>(
        &'a self,
        dispatch: TelegramDispatch<'a>,
    ) -> BoxFuture<'a, Result<bool, ChannelError>> {
        Box::pin(async move {
            self.dispatched
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(dispatch.external_chat_id.to_string());
            Ok(true)
        })
    }
}
