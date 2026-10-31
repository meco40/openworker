//! Port of `src/server/http/` (S11 dependency): the SSRF guard and the policy-bound
//! fetch used by the skill handlers. Submodules name their TypeScript source.
//!
//! Not here: the HTTP transport itself. It stays behind `model_hub::http::HttpTransport`,
//! and the production implementation is `betaclaw-gateway::model_hub_transport`.
//!
//! Requirement on that transport: the guard follows redirects itself, one hop at a time.
//! The transport must not follow redirects, because `reqwest` does so by default and the
//! redirect would then reach a host the guard never checked.

pub mod fetch_with_policy;
pub mod params;
pub mod ssrf_guard;

#[cfg(test)]
pub(crate) mod test_support;
