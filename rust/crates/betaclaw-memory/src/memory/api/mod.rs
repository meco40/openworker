//! Port of `src/server/memory/api/**`: the five `/api/memory` handlers
//! (`getHandler.ts`, `postHandler.ts`, `putHandler.ts`, `patchHandler.ts`,
//! `deleteHandler.ts`), their parsers and types (`shared.ts`, `types.ts`) and the
//! barrel `index.ts`, as service functions.
//!
//! | TypeScript                                       | Rust |
//! | ------------------------------------------------ | ---- |
//! | `api/index.ts:1-5` (the five handler exports)    | [`MemoryApi::get`], [`MemoryApi::post`], [`MemoryApi::put`], [`MemoryApi::patch`], [`MemoryApi::delete`] |
//! | `api/getHandler.ts:15-110`                       | [`MemoryApi::get`] (in `handlers.rs`) |
//! | `api/postHandler.ts:11-56`                       | [`MemoryApi::post`] (in `handlers.rs`) |
//! | `api/putHandler.ts:11-56`                        | [`MemoryApi::put`] (in `handlers.rs`) |
//! | `api/patchHandler.ts:10-44`                      | [`MemoryApi::patch`] (in `handlers.rs`) |
//! | `api/deleteHandler.ts:13-46`                     | [`MemoryApi::delete`] (in `handlers.rs`) |
//! | `api/shared.ts`, `api/types.ts`                  | [`shared`] |
//! | `shared.ts:30-36` (`getReadyMemoryService`)      | [`MemoryApi::ready_service`] |
//! | `shared.ts:8-9` (the two error classes)          | [`MemoryApiError`] |
//! | `shared.ts:236` (`listConversations(500, userId)`) | [`ConversationDirectory`] |
//!
//! # Shape
//!
//! The TypeScript handlers take a `Request` and return a `NextResponse`. The port
//! takes what a handler reads (the decoded query pairs and the raw body text) and
//! returns an [`ApiResponse`]: the HTTP status and the JSON body. Those two are the
//! whole contract, so a route only has to forward them. Nothing mounts these
//! functions yet; the route wiring is open point OP-10.
//!
//! # Deviations
//!
//! 1. **No recovery side effect.** `getMemoryServiceIfReady` schedules the
//!    recovery probe on a degraded runtime (`runtime.ts:161-163`). [`MemoryApi`]
//!    only borrows the runtime, so the caller must drive
//!    `MemoryRuntime::recover_now` on its own timer (see `runtime.rs`, deviation 2).
//! 2. **Malformed JSON.** serde_json's message stands in for V8's `SyntaxError`
//!    text. The status (400) is the same.
//! 3. **Body shapes.** A `null` body throws in the source (`Cannot read properties
//!    of null`); the port answers 500 with that text. Every other non-object body
//!    reads as `{}`, as JavaScript property reads of it do.
//! 4. **One 409 mapping.** Only the update path throws
//!    `MemoryVersionConflictError`, so mapping the conflict to 409 on every route
//!    gives the same answers as the source.
//! 5. **Query pairs are decoded.** `URLSearchParams.get` returns the first pair of
//!    a key. The caller passes decoded pairs, and [`MemoryApi::get`] reads the first
//!    one for each key.

pub mod shared;

mod handlers;

use http::StatusCode;
use serde_json::{json, Value};

use crate::memory::errors::MemoryError;
use crate::memory::runtime::{MemoryRuntime, MemoryRuntimeError};
use crate::memory::service::{MemoryService, MemoryServiceDependencies};
use crate::messages_store::types::Conversation;
use crate::messages_store::MessagesStore;

use self::shared::MEMORY_RUNTIME_UNAVAILABLE_MESSAGE;

/// The message-store read that `resolveMemoryReadUserScopes` makes:
/// `getMessageRepository().listConversations(500, userId)` (`shared.ts:236`).
pub trait ConversationDirectory {
    fn list_user_conversations(
        &self,
        limit: i64,
        user_id: &str,
    ) -> Result<Vec<Conversation>, String>;
}

impl ConversationDirectory for MessagesStore {
    fn list_user_conversations(
        &self,
        limit: i64,
        user_id: &str,
    ) -> Result<Vec<Conversation>, String> {
        self.list_conversations(limit, Some(user_id))
            .map_err(|error| error.to_string())
    }
}

/// The error kinds the handlers tell apart, each with the status it answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MemoryApiError {
    /// `ValidationError` (`shared.ts:8`) → 400. A malformed JSON body
    /// (`SyntaxError`) gets the same status.
    Validation(String),
    /// `MemoryRuntimeUnavailableError` (`shared.ts:9`) → 503.
    Unavailable,
    /// `MemoryVersionConflictError` → 409.
    Conflict(String),
    /// Any other error the service or the runtime raises → 500.
    Internal(String),
}

impl MemoryApiError {
    /// The status of each handler's `catch` block, which all share one mapping
    /// (see deviation 4 in the module header).
    pub fn status(&self) -> StatusCode {
        match self {
            MemoryApiError::Validation(_) => StatusCode::BAD_REQUEST,
            MemoryApiError::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
            MemoryApiError::Conflict(_) => StatusCode::CONFLICT,
            MemoryApiError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    /// The `error` field of the body, which the handlers take from `error.message`.
    pub fn message(&self) -> String {
        match self {
            MemoryApiError::Validation(message)
            | MemoryApiError::Conflict(message)
            | MemoryApiError::Internal(message) => message.clone(),
            MemoryApiError::Unavailable => MEMORY_RUNTIME_UNAVAILABLE_MESSAGE.to_string(),
        }
    }
}

impl From<MemoryError> for MemoryApiError {
    fn from(error: MemoryError) -> Self {
        if error.version_conflict().is_some() {
            MemoryApiError::Conflict(error.to_string())
        } else {
            MemoryApiError::Internal(error.to_string())
        }
    }
}

impl From<MemoryRuntimeError> for MemoryApiError {
    fn from(error: MemoryRuntimeError) -> Self {
        match error {
            MemoryRuntimeError::Unavailable(_) => MemoryApiError::Unavailable,
            MemoryRuntimeError::Configuration(message) => MemoryApiError::Internal(message),
        }
    }
}

/// One finished handler call: the HTTP status and the JSON body the route sends.
#[derive(Debug, Clone, PartialEq)]
pub struct ApiResponse {
    pub status: StatusCode,
    pub body: Value,
}

impl ApiResponse {
    fn ok(body: Value) -> Self {
        Self {
            status: StatusCode::OK,
            body,
        }
    }

    /// `{ ok: false, error: 'Memory node not found.' }` with 404 (`putHandler.ts:37-39`).
    fn not_found() -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            body: json!({ "ok": false, "error": "Memory node not found." }),
        }
    }

    fn failure(error: MemoryApiError) -> Self {
        Self {
            status: error.status(),
            body: json!({ "ok": false, "error": error.message() }),
        }
    }
}

/// The `/api/memory` handlers bound to one runtime, one set of service
/// dependencies and one message store. It only borrows them, so it is cheap to
/// build per request.
pub struct MemoryApi<'a> {
    runtime: &'a MemoryRuntime,
    dependencies: MemoryServiceDependencies<'a>,
    conversations: &'a dyn ConversationDirectory,
}

impl<'a> MemoryApi<'a> {
    pub fn new(
        runtime: &'a MemoryRuntime,
        dependencies: MemoryServiceDependencies<'a>,
        conversations: &'a dyn ConversationDirectory,
    ) -> Self {
        Self {
            runtime,
            dependencies,
            conversations,
        }
    }

    /// `getReadyMemoryService` — `shared.ts:24-36`: the service, or the 503 error
    /// while the runtime is degraded.
    fn ready_service(&self) -> Result<MemoryService<'a>, MemoryApiError> {
        self.runtime
            .memory_service_if_ready(self.dependencies)?
            .ok_or(MemoryApiError::Unavailable)
    }
}
