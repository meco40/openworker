//! Runtime switch between the Rust route and the TypeScript proxy, one switch per route family.
//!
//! A family that Rust serves goes to its Rust handler unchanged. A family that is switched
//! off is handed to the reverse proxy (`proxy.rs`), so Next.js answers it again. The switch is
//! read on every request, so a family can be moved back and forth without restarting Rust.
//!
//! Wiring for the integrator:
//! - Startup: `CutoverPolicy::from_env()?` inside an `Arc`, attached with `Extension(policy)`
//!   to the outer router. An unknown family name in `BETACLAW_RUST_FAMILIES` fails here.
//! - Proxy: attach `Extension(ProxyFallback::new(move |req| proxy_to_upstream(State(state.clone()), req)))`
//!   to the same outer router.
//! - Per family: `.route_layer(from_fn(...))` calling `gate("<family>", policy, req, next)`.
//!   Use `route_layer`, not `layer`, so unmatched paths keep going to the proxy fallback.

use std::collections::BTreeSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, PoisonError, RwLock};

use axum::extract::{Extension, Request};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use thiserror::Error;

/// Environment variable that lists the families Rust serves.
const ENV_VAR: &str = "BETACLAW_RUST_FAMILIES";

/// Every family the gate knows, matching the modules in `families/mod.rs`.
const KNOWN_FAMILIES: &[&str] = &[
    "auth",
    "master",
    "tasks",
    "channels_wire",
    "skills_wire",
    "stats_wire",
    "ops_wire",
    "hardening",
    "migrations_wire",
];

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CutoverError {
    #[error("unknown route family `{0}`, expected one of: {known}", known = KNOWN_FAMILIES.join(", "))]
    UnknownFamily(String),
}

/// Per-family switch. `true` means Rust serves the family, `false` means the proxy does.
#[derive(Debug)]
pub struct CutoverPolicy {
    rust_served: RwLock<BTreeSet<&'static str>>,
}

impl CutoverPolicy {
    /// Parses a comma-separated list of families that Rust serves. Blanks and letter case are
    /// ignored. An empty list means no family is served by Rust.
    pub fn from_list(list: &str) -> Result<Self, CutoverError> {
        let mut served = BTreeSet::new();
        for entry in list
            .split(',')
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
        {
            let name =
                canonical(entry).ok_or_else(|| CutoverError::UnknownFamily(entry.to_owned()))?;
            served.insert(name);
        }
        Ok(Self {
            rust_served: RwLock::new(served),
        })
    }

    /// Reads `BETACLAW_RUST_FAMILIES`. Unset or blank means every family is served by Rust.
    pub fn from_env() -> Result<Self, CutoverError> {
        Self::from_optional(std::env::var(ENV_VAR).ok().as_deref())
    }

    fn from_optional(raw: Option<&str>) -> Result<Self, CutoverError> {
        match raw.map(str::trim).filter(|value| !value.is_empty()) {
            Some(list) => Self::from_list(list),
            None => Ok(Self {
                rust_served: RwLock::new(KNOWN_FAMILIES.iter().copied().collect()),
            }),
        }
    }

    /// Whether Rust serves `family` right now. Unknown names count as not served.
    pub fn is_rust_served(&self, family: &str) -> bool {
        let served = self
            .rust_served
            .read()
            .unwrap_or_else(PoisonError::into_inner);
        canonical(family).is_some_and(|name| served.contains(&name))
    }

    /// Switches one family at runtime. Takes effect on the next request, without a restart.
    pub fn set_rust_served(&self, family: &str, served: bool) -> Result<(), CutoverError> {
        let name = canonical(family)
            .ok_or_else(|| CutoverError::UnknownFamily(family.trim().to_owned()))?;
        let mut set = self
            .rust_served
            .write()
            .unwrap_or_else(PoisonError::into_inner);
        if served {
            set.insert(name);
        } else {
            set.remove(&name);
        }
        Ok(())
    }
}

/// Maps a name to its canonical static spelling, ignoring case and surrounding blanks.
fn canonical(name: &str) -> Option<&'static str> {
    let name = name.trim();
    KNOWN_FAMILIES
        .iter()
        .copied()
        .find(|known| known.eq_ignore_ascii_case(name))
}

type ProxyFuture = Pin<Box<dyn Future<Output = Response> + Send>>;

/// The reverse proxy that serves a family while it is switched off.
///
/// The integrator attaches it as an extension on the outer router. Tests attach a double.
#[derive(Clone)]
pub struct ProxyFallback(Arc<dyn Fn(Request) -> ProxyFuture + Send + Sync>);

impl ProxyFallback {
    pub fn new<F, Fut>(handler: F) -> Self
    where
        F: Fn(Request) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Response> + Send + 'static,
    {
        Self(Arc::new(move |req: Request| -> ProxyFuture {
            Box::pin(handler(req))
        }))
    }

    async fn call(&self, req: Request) -> Response {
        (*self.0)(req).await
    }
}

/// Serves one request of `family`: the Rust handler when the family is on, the proxy when it
/// is off. Without a [`ProxyFallback`] attached, an off family answers 503 rather than silently
/// running the Rust handler.
pub async fn gate(
    family: &'static str,
    policy: Extension<Arc<CutoverPolicy>>,
    req: Request,
    next: Next,
) -> Response {
    if policy.0.is_rust_served(family) {
        return next.run(req).await;
    }
    match req.extensions().get::<ProxyFallback>().cloned() {
        Some(proxy) => proxy.call(req).await,
        None => {
            tracing::error!(
                family,
                "route family is switched to the proxy, but no ProxyFallback is attached"
            );
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "route family is served by the proxy, which is not attached",
            )
                .into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::body::Body;
    use axum::middleware::from_fn;
    use axum::routing::get;
    use axum::Router;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;

    /// Router with one family route ("tasks") behind the gate, mirroring the integrator wiring.
    fn router(policy: Arc<CutoverPolicy>, proxy: Option<ProxyFallback>) -> Router {
        let router = Router::new()
            .route("/api/tasks", get(|| async { "rust" }))
            .route_layer(from_fn(
                |policy: Extension<Arc<CutoverPolicy>>, req: Request, next: Next| {
                    gate("tasks", policy, req, next)
                },
            ))
            .layer(Extension(policy));
        match proxy {
            Some(proxy) => router.layer(Extension(proxy)),
            None => router,
        }
    }

    /// Proxy double that counts calls and answers "proxy".
    fn counting_proxy(calls: Arc<AtomicUsize>) -> ProxyFallback {
        ProxyFallback::new(move |_req: Request| {
            let calls = calls.clone();
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                "proxy".into_response()
            }
        })
    }

    async fn send(app: &Router) -> (StatusCode, String) {
        let request = Request::builder()
            .uri("/api/tasks")
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    #[test]
    fn list_ignores_case_and_blanks() {
        let policy = CutoverPolicy::from_list(" Master , TASKS,,skills_wire ").unwrap();
        assert!(policy.is_rust_served("master"));
        assert!(policy.is_rust_served("tasks"));
        assert!(policy.is_rust_served("skills_wire"));
        assert!(!policy.is_rust_served("stats_wire"));
    }

    #[test]
    fn list_rejects_unknown_family() {
        assert_eq!(
            CutoverPolicy::from_list("master, Bogus").unwrap_err(),
            CutoverError::UnknownFamily("Bogus".to_owned())
        );
    }

    #[test]
    fn unset_or_blank_env_serves_every_family() {
        for raw in [None, Some(""), Some("  ")] {
            let policy = CutoverPolicy::from_optional(raw).unwrap();
            for &family in KNOWN_FAMILIES {
                assert!(
                    policy.is_rust_served(family),
                    "{family} should be served by default"
                );
            }
        }
    }

    #[test]
    fn unknown_name_in_env_fails_at_startup() {
        assert!(CutoverPolicy::from_optional(Some("master,nope")).is_err());
    }

    #[tokio::test]
    async fn switched_off_family_goes_to_the_proxy() {
        let policy = Arc::new(CutoverPolicy::from_list("master").unwrap());
        let calls = Arc::new(AtomicUsize::new(0));
        let app = router(policy, Some(counting_proxy(calls.clone())));

        assert_eq!(send(&app).await, (StatusCode::OK, "proxy".to_owned()));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn rollback_to_proxy_and_back_without_restart() {
        let policy = Arc::new(CutoverPolicy::from_list("tasks").unwrap());
        let calls = Arc::new(AtomicUsize::new(0));
        let app = router(policy.clone(), Some(counting_proxy(calls.clone())));

        assert_eq!(send(&app).await, (StatusCode::OK, "rust".to_owned()));

        policy.set_rust_served("tasks", false).unwrap();
        assert_eq!(send(&app).await, (StatusCode::OK, "proxy".to_owned()));

        policy.set_rust_served(" TASKS ", true).unwrap();
        assert_eq!(send(&app).await, (StatusCode::OK, "rust".to_owned()));

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(policy.set_rust_served("bogus", true).is_err());
    }

    #[tokio::test]
    async fn switched_off_family_without_proxy_fails_loudly() {
        let policy = Arc::new(CutoverPolicy::from_list("").unwrap());
        let app = router(policy, None);

        let (status, _) = send(&app).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    }
}
