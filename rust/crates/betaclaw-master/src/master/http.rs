//! Port of `src/server/master/http.ts:1-33`.
//!
//! Two helpers the master routes use to turn a request into a
//! `MasterWorkspaceBinding`:
//!
//! * `resolveMasterUserId` (`http.ts:13-16`) resolves the request identity.
//! * `resolveScopeFromRequest` (`http.ts:18-33`) merges the JSON body over the
//!   URL query (`body?.x ?? url.searchParams.get('x')`) and hands the result to
//!   `resolveMasterWorkspaceScope`.
//!
//! # Two deliberate deviations
//!
//! 1. **The workspace resolver is a seam.** `resolveMasterWorkspaceScope` lives
//!    in `workspaceScope.ts`, which is package P2 (it opens the persona
//!    repository, the master repository and the filesystem). `http.ts` is P0,
//!    so the direct import is expressed as the
//!    [`MasterWorkspaceScopeResolver`] trait: the route layer passes the P2
//!    implementation, and the merge logic here is unchanged. The error type is
//!    the trait's associated `Error`, so the `throw new Error(...)` messages
//!    stay in the module that owns them.
//! 2. **The URL is not parsed here.** The TypeScript reads
//!    `new URL(request.url).searchParams`. The transport layer already has the
//!    parsed query when it reaches this seam, so the port takes a
//!    [`QueryParams`] (with a `URLSearchParams`-compatible [`QueryParams::parse`])
//!    instead of a raw URL string.
//!
//! `resolveMasterUserId` is `async` in the source because it awaits the session.
//! In Rust the identity is resolved from the transport headers first; the caller
//! passes the resulting [`RequestAuthInput`], matching
//! [`crate::auth::user_context`].

use serde::Deserialize;

use crate::auth::user_context::{resolve_request_user_context, RequestAuthInput};

/// `MasterWorkspaceBinding` from `src/server/master/workspaceScope.ts:10-14`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MasterWorkspaceBinding {
    pub user_id: String,
    pub workspace_id: String,
    pub persona_id: String,
    pub persona_workspace_root: String,
    pub workspace_cwd: String,
}

/// `ScopeBody` from `http.ts:7-11`.
///
/// All three fields are optional and nullable; `null` is equivalent to absent
/// for the `??` merge below.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeBody {
    #[serde(default)]
    pub persona_id: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_cwd: Option<String>,
}

/// A parsed URL query, compatible with the subset of `URLSearchParams` used by
/// `http.ts`: first-value lookup by decoded key.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QueryParams {
    pairs: Vec<(String, String)>,
}

impl QueryParams {
    /// Builds the query from already-decoded pairs.
    pub fn from_pairs(pairs: Vec<(String, String)>) -> Self {
        Self { pairs }
    }

    /// Parses an `application/x-www-form-urlencoded` query string the way
    /// `URLSearchParams` does: `&` separators, first `=` splits the pair, `+`
    /// becomes a space and `%XX` is percent-decoded; a malformed escape is kept
    /// verbatim.
    pub fn parse(query: &str) -> Self {
        let trimmed = query.strip_prefix('?').unwrap_or(query);
        if trimmed.is_empty() {
            return Self::default();
        }
        let pairs = trimmed
            .split('&')
            .map(|segment| {
                let (key, value) = match segment.split_once('=') {
                    Some((key, value)) => (key, value),
                    None => (segment, ""),
                };
                (decode_component(key), decode_component(value))
            })
            .collect();
        Self { pairs }
    }

    /// `URLSearchParams.get(name)` — the first value for a decoded key.
    pub fn get(&self, name: &str) -> Option<String> {
        self.pairs
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.clone())
    }
}

/// One percent-decoded hex digit, or `None`.
fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// `application/x-www-form-urlencoded` decoding for one component.
fn decode_component(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                match (hex_digit(bytes[index + 1]), hex_digit(bytes[index + 2])) {
                    (Some(high), Some(low)) => {
                        out.push(high * 16 + low);
                        index += 3;
                    }
                    _ => {
                        out.push(bytes[index]);
                        index += 1;
                    }
                }
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}
/// The argument of `resolveMasterWorkspaceScope` from
/// `src/server/master/workspaceScope.ts:16-21`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeResolutionInput {
    pub user_id: String,
    pub persona_id: Option<String>,
    pub workspace_id: Option<String>,
    pub workspace_cwd: Option<String>,
}

/// Rust stand-in for the `resolveMasterWorkspaceScope` import.
///
/// Package P2 (`master/workspace_scope.rs`) implements this trait; `http.ts`
/// only needs the call. The error type stays associated so the
/// `throw new Error(...)` messages remain owned where the TypeScript raises
/// them.
pub trait MasterWorkspaceScopeResolver {
    type Error;

    fn resolve_master_workspace_scope(
        &self,
        input: ScopeResolutionInput,
    ) -> Result<MasterWorkspaceBinding, Self::Error>;
}

/// `resolveMasterUserId` from `http.ts:13-16`.
///
/// `context?.userId || null`: the identity is `None` when the request carries no
/// context or an empty id.
pub fn resolve_master_user_id(input: &RequestAuthInput<'_>) -> Option<String> {
    resolve_request_user_context(input)
        .map(|context| context.user_id)
        .filter(|user_id| !user_id.is_empty())
}

/// The merge step of `resolveScopeFromRequest` (`http.ts:22-26`).
///
/// `body?.x ?? url.searchParams.get('x')` — a body value that is `null` (or an
/// absent body) falls through to the query; any other body value, including the
/// empty string, wins.
pub fn scope_resolution_input(
    query: &QueryParams,
    user_id: &str,
    body: Option<&ScopeBody>,
) -> ScopeResolutionInput {
    let persona_id = body
        .and_then(|body| body.persona_id.clone())
        .or_else(|| query.get("personaId"));
    let workspace_id = body
        .and_then(|body| body.workspace_id.clone())
        .or_else(|| query.get("workspaceId"));
    let workspace_cwd = body
        .and_then(|body| body.workspace_cwd.clone())
        .or_else(|| query.get("workspaceCwd"));
    ScopeResolutionInput {
        user_id: user_id.to_string(),
        persona_id,
        workspace_id,
        workspace_cwd,
    }
}

/// `resolveScopeFromRequest` from `http.ts:18-33`.
///
/// Merges the body over the query and delegates to the workspace resolver.
pub fn resolve_scope_from_request<R: MasterWorkspaceScopeResolver>(
    resolver: &R,
    query: &QueryParams,
    user_id: &str,
    body: Option<&ScopeBody>,
) -> Result<MasterWorkspaceBinding, R::Error> {
    resolver.resolve_master_workspace_scope(scope_resolution_input(query, user_id, body))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct StubResolver;

    impl MasterWorkspaceScopeResolver for StubResolver {
        type Error = &'static str;

        fn resolve_master_workspace_scope(
            &self,
            input: ScopeResolutionInput,
        ) -> Result<MasterWorkspaceBinding, Self::Error> {
            if input.user_id.is_empty() {
                return Err("userId is required for master workspace scope.");
            }
            Ok(MasterWorkspaceBinding {
                user_id: input.user_id,
                workspace_id: input.workspace_id.unwrap_or_default(),
                persona_id: input.persona_id.unwrap_or_default(),
                persona_workspace_root: "root".to_string(),
                workspace_cwd: input.workspace_cwd.unwrap_or_else(|| "root".to_string()),
            })
        }
    }

    #[test]
    fn query_parse_matches_urlsearchparams() {
        let query = QueryParams::parse("?personaId=p%20one&workspaceId=w1&personaId=ignored");
        assert_eq!(query.get("personaId").as_deref(), Some("p one"));
        assert_eq!(query.get("workspaceId").as_deref(), Some("w1"));
        assert_eq!(query.get("missing"), None);
        // `+` decodes to a space; a malformed escape survives verbatim.
        let query = QueryParams::parse("a=b+c&d=%ZZ");
        assert_eq!(query.get("a").as_deref(), Some("b c"));
        assert_eq!(query.get("d").as_deref(), Some("%ZZ"));
    }

    #[test]
    fn body_overrides_query_unless_nullish() {
        let query = QueryParams::parse("personaId=qp&workspaceId=qw&workspaceCwd=qc");
        let body = ScopeBody {
            persona_id: Some("bp".to_string()),
            workspace_id: None,
            workspace_cwd: Some(String::new()),
        };
        let input = scope_resolution_input(&query, "u1", Some(&body));
        assert_eq!(input.persona_id.as_deref(), Some("bp"));
        assert_eq!(input.workspace_id.as_deref(), Some("qw"));
        // An empty-string body value is not nullish, so it wins over the query.
        assert_eq!(input.workspace_cwd.as_deref(), Some(""));
    }

    #[test]
    fn missing_body_falls_back_to_query() {
        let query = QueryParams::parse("personaId=qp");
        let input = scope_resolution_input(&query, "u1", None);
        assert_eq!(input.persona_id.as_deref(), Some("qp"));
        assert!(input.workspace_id.is_none());
    }

    #[test]
    fn resolve_scope_from_request_delegates() {
        let query = QueryParams::parse("personaId=p1&workspaceId=w1");
        let binding = resolve_scope_from_request(&StubResolver, &query, "u1", None).unwrap();
        assert_eq!(binding.user_id, "u1");
        assert_eq!(binding.persona_id, "p1");
        assert_eq!(binding.workspace_id, "w1");
        assert_eq!(binding.workspace_cwd, "root");
    }

    #[test]
    fn scope_body_deserialises_from_json() {
        let body: ScopeBody =
            serde_json::from_str(r#"{"personaId":"p","workspaceCwd":null}"#).unwrap();
        assert_eq!(body.persona_id.as_deref(), Some("p"));
        assert!(body.workspace_cwd.is_none());
        assert!(body.workspace_id.is_none());
    }
}
