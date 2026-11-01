//! Migrated API routes.
//!
//! Every route here replaces the identically shaped `app/api/**/route.ts`.
//! Unmigrated paths fall through to the reverse proxy, so this list is the exact
//! migration surface. Removal criterion per route: the contract test in
//! `tests/route_parity.rs` passes against the TypeScript implementation and the
//! route has run in production without incident for one release.

pub mod auth;
pub mod channel_state;
pub mod channel_support;
pub mod config;
pub mod conversations;
pub mod inbox;
pub mod logs;
pub mod memory;
pub mod messages;
pub mod model_hub;
pub mod personas;
pub mod security;

#[cfg(test)]
mod test_support;

use std::sync::Arc;

use axum::extract::{Extension, Request};
use axum::middleware::{from_fn, Next};
use axum::Router;

use crate::families::cutover::{gate, CutoverPolicy};
use crate::families::{channels_wire, master, ops_wire, skills_wire, stats_wire, tasks};

/// Puts one family's routes behind the cutover switch. `route_layer` runs only for
/// matched routes, so an unmatched path keeps its fallback to the proxy.
fn gated(
    family: &'static str,
    routes: Router<crate::state::SharedState>,
) -> Router<crate::state::SharedState> {
    routes.route_layer(from_fn(
        move |policy: Extension<Arc<CutoverPolicy>>, request: Request, next: Next| {
            gate(family, policy, request, next)
        },
    ))
}

pub fn router() -> Router<crate::state::SharedState> {
    Router::new()
        .merge(channel_state::router())
        .merge(config::router())
        .merge(conversations::router())
        .merge(inbox::router())
        .merge(logs::router())
        .merge(memory::router())
        .merge(messages::router())
        .merge(model_hub::router())
        .merge(personas::router())
        .merge(security::router())
        .merge(gated("auth", auth::router()))
        .merge(gated("master", master::router()))
        .merge(gated("channels_wire", channels_wire::router()))
        .merge(gated("skills_wire", skills_wire::router()))
        .merge(gated("stats_wire", stats_wire::router()))
        .merge(gated("ops_wire", ops_wire::router()))
        .merge(gated("tasks", tasks::router()))
}

#[cfg(test)]
mod privileged_route_tests {
    //! Port of `tests/integration/security/privileged-routes-auth.test.ts`. The full
    //! router with the auth gate answers every privileged route with 401 when no user
    //! context resolves, and the legacy-local context still reads the pipeline.

    use axum::body::Body;
    use axum::http::{Method, Request, StatusCode};
    use tower::ServiceExt;

    use super::test_support::{state_with, ScratchDir};
    use crate::state::SharedState;

    async fn status_of(
        state: &SharedState,
        method: Method,
        uri: &str,
        body: Option<&str>,
    ) -> StatusCode {
        let mut builder = Request::builder().method(method).uri(uri);
        let request_body = match body {
            Some(text) => {
                builder = builder.header("content-type", "application/json");
                Body::from(text.to_string())
            }
            None => Body::empty(),
        };
        let request = builder.body(request_body).expect("valid request");
        crate::proxy::build_router(state.clone())
            .oneshot(request)
            .await
            .expect("infallible service")
            .status()
    }

    #[tokio::test]
    async fn privileged_routes_answer_401_without_a_user_context() {
        let scratch = ScratchDir::new();
        let state = state_with(&scratch, |config| config.require_auth = true);
        let cases: [(Method, &str, Option<&str>); 13] = [
            (
                Method::POST,
                "/api/model-hub/gateway",
                Some(r#"{"profileId":"p1","messages":[{"role":"user","content":"hello"}]}"#),
            ),
            (Method::GET, "/api/model-hub/accounts", None),
            (Method::GET, "/api/model-hub/providers", None),
            (Method::DELETE, "/api/model-hub/accounts/a1", None),
            (Method::GET, "/api/model-hub/accounts/a1/models", None),
            (Method::POST, "/api/model-hub/accounts/a1/test", None),
            (Method::POST, "/api/model-hub/accounts/test-all", None),
            (Method::GET, "/api/model-hub/pipeline?profileId=p1", None),
            (
                Method::GET,
                "/api/model-hub/oauth/start?providerId=openrouter&label=OpenRouter",
                None,
            ),
            (
                Method::GET,
                "/api/model-hub/oauth/callback?code=abc&state=invalid",
                None,
            ),
            (Method::GET, "/api/skills", None),
            (
                Method::POST,
                "/api/skills/execute",
                Some(r#"{"name":"list_files","args":{}}"#),
            ),
            (
                Method::PATCH,
                "/api/skills/s1",
                Some(r#"{"installed":true}"#),
            ),
        ];
        for (method, uri, body) in cases {
            assert_eq!(
                status_of(&state, method.clone(), uri, body).await,
                StatusCode::UNAUTHORIZED,
                "{method} {uri}"
            );
        }
    }

    #[tokio::test]
    async fn legacy_local_context_keeps_model_hub_routes_readable() {
        // Port of "keeps legacy-local behavior when context resolves successfully"
        // (privileged-routes-auth.test.ts, which read the pipeline). The providers
        // route runs the same `ensure_auth` check but opens no model-hub database
        // and needs no MODEL_HUB_ENCRYPTION_KEY, so the test stays hermetic.
        let scratch = ScratchDir::new();
        // Pinned: a REQUIRE_AUTH set in the developer's environment must not apply.
        let state = state_with(&scratch, |config| config.require_auth = false);
        // The gate strips any client-supplied identity header and resolves the
        // legacy-local principal itself, which needs a loopback socket peer and a
        // loopback `Host` (`should_allow_anonymous_local_principal`).
        let mut request = Request::builder()
            .uri("/api/model-hub/providers")
            .header("host", "127.0.0.1:3000")
            .body(Body::empty())
            .expect("valid request");
        request
            .extensions_mut()
            .insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
                [127, 0, 0, 1],
                4000,
            ))));
        let response = crate::proxy::build_router(state)
            .oneshot(request)
            .await
            .expect("infallible service");
        assert_eq!(response.status(), StatusCode::OK);
    }
}
