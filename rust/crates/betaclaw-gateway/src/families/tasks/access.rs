//! Caller resolution and workspace access. Ported from `withUserContext`
//! (`app/api/_shared/withUserContext.ts`) and from `src/server/auth/workspaceAccess.ts`.
//!
//! The gate in `auth_gate.rs` attaches the identity headers. Whether the caller
//! holds a valid session is read from the cookies here, as the TypeScript
//! `resolveRequestUserContext` does, because the workspace rules depend on it.

use axum::http::{header, HeaderMap};
use betaclaw_core::auth::user_context::{resolve_request_user_context, RequestAuthInput};
use rusqlite::{params, Connection, OptionalExtension};

use super::wire::utf16_len;
use crate::auth_gate::{parse_cookies, user_id_from_headers, USER_SERVICE_HEADER};
use crate::state::AppState;

/// `RequestUserContext` of the TypeScript code, plus the REQUIRE_AUTH setting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Access {
    pub user_id: String,
    pub service: bool,
    pub authenticated: bool,
    pub require_auth: bool,
}

/// `withUserContext`: `None` when the gate attached no identity, which answers 401.
pub fn resolve(state: &AppState, headers: &HeaderMap) -> Option<Access> {
    let user_id = user_id_from_headers(headers)?;
    let service = headers
        .get(USER_SERVICE_HEADER)
        .and_then(|value| value.to_str().ok())
        == Some("1");
    let authenticated = service || has_session(state, headers);
    Some(Access {
        user_id,
        service,
        authenticated,
        require_auth: state.config.require_auth,
    })
}

fn has_session(state: &AppState, headers: &HeaderMap) -> bool {
    let cookies = parse_cookies(headers);
    let cookie_names = state.config.session_cookie_names();
    let input = RequestAuthInput {
        cookies: &cookies,
        authorization: headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok()),
        internal_token_header: headers
            .get("x-mc-internal-token")
            .and_then(|value| value.to_str().ok()),
        session_cookie_names: &cookie_names,
        auth_secret: &state.config.auth_secret,
        mc_api_token: state.config.mc_api_token.as_deref(),
        internal_token: &state.config.internal_token,
        require_auth: state.config.require_auth,
        now_seconds: chrono::Utc::now().timestamp(),
    };
    resolve_request_user_context(&input).is_some_and(|context| context.authenticated)
}

/// `normalizeWorkspaceId`: trimmed, 1 to 200 characters.
pub fn normalize_workspace_id(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty() && utf16_len(trimmed) <= 200).then(|| trimmed.to_string())
}

impl Access {
    /// Optional-auth mode without a session, or a service token: every workspace.
    fn sees_every_workspace(&self) -> bool {
        self.service || (!self.require_auth && !self.authenticated)
    }

    /// `hasWorkspaceAccess`: the workspace exists and the caller may see it.
    pub fn has_workspace(
        &self,
        connection: &Connection,
        workspace_id: &str,
    ) -> rusqlite::Result<bool> {
        let Some(id) = normalize_workspace_id(workspace_id) else {
            return Ok(false);
        };
        let exists = connection
            .query_row("SELECT 1 FROM workspaces WHERE id = ?", [&id], |_| Ok(()))
            .optional()?
            .is_some();
        if !exists {
            return Ok(false);
        }
        if self.sees_every_workspace() {
            return Ok(true);
        }
        let member = connection
            .query_row(
                "SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
                params![id, self.user_id],
                |_| Ok(()),
            )
            .optional()?;
        Ok(member.is_some())
    }

    /// `getAccessibleWorkspaceIds`.
    pub fn accessible_workspace_ids(
        &self,
        connection: &Connection,
    ) -> rusqlite::Result<Vec<String>> {
        let ids = if self.sees_every_workspace() {
            let mut statement = connection.prepare("SELECT id FROM workspaces ORDER BY name")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<String>>>()?
        } else {
            let mut statement = connection.prepare(
                "SELECT workspace_id FROM workspace_members WHERE user_id = ? ORDER BY workspace_id",
            )?;
            let rows = statement.query_map([&self.user_id], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<String>>>()?
        };
        Ok(ids)
    }

    /// `canAccessTask`: the task exists and its workspace is visible.
    pub fn can_access_task(
        &self,
        connection: &Connection,
        task_id: &str,
    ) -> rusqlite::Result<bool> {
        match task_workspace(connection, task_id)? {
            Some(workspace) => self.has_workspace(connection, &workspace),
            None => Ok(false),
        }
    }

    /// `canAccessAgent`: the agent exists and its workspace is visible.
    pub fn can_access_agent(
        &self,
        connection: &Connection,
        agent_id: &str,
    ) -> rusqlite::Result<bool> {
        match agent_workspace(connection, agent_id)? {
            Some(workspace) => self.has_workspace(connection, &workspace),
            None => Ok(false),
        }
    }
}

/// `getTaskWorkspaceId`.
pub fn task_workspace(connection: &Connection, task_id: &str) -> rusqlite::Result<Option<String>> {
    connection
        .query_row(
            "SELECT workspace_id FROM tasks WHERE id = ?",
            [task_id],
            |row| row.get(0),
        )
        .optional()
}

/// `getAgentWorkspaceId`.
pub fn agent_workspace(
    connection: &Connection,
    agent_id: &str,
) -> rusqlite::Result<Option<String>> {
    connection
        .query_row(
            "SELECT workspace_id FROM agents WHERE id = ?",
            [agent_id],
            |row| row.get(0),
        )
        .optional()
}

/// `grantWorkspaceOwner`.
pub fn grant_workspace_owner(
    connection: &Connection,
    workspace_id: &str,
    user_id: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO workspace_members (workspace_id, user_id, role)
         VALUES (?, ?, 'owner')
         ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = 'owner'",
        params![workspace_id, user_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn access(user: &str, service: bool, authenticated: bool, require_auth: bool) -> Access {
        Access {
            user_id: user.to_string(),
            service,
            authenticated,
            require_auth,
        }
    }

    #[test]
    fn workspace_ids_are_trimmed_and_bounded() {
        assert_eq!(normalize_workspace_id("  team  "), Some("team".to_string()));
        assert_eq!(normalize_workspace_id("   "), None);
        assert_eq!(normalize_workspace_id(&"x".repeat(201)), None);
    }

    #[test]
    fn open_mode_and_service_see_every_workspace() {
        assert!(access("u", true, false, true).sees_every_workspace());
        assert!(access("u", false, false, false).sees_every_workspace());
        assert!(!access("u", false, true, false).sees_every_workspace());
        assert!(!access("u", false, false, true).sees_every_workspace());
    }

    #[test]
    fn membership_decides_access_under_required_auth() {
        let connection = crate::families::tasks::test_support::memory_connection();
        grant_workspace_owner(&connection, "default", "member").unwrap();
        assert!(access("member", false, true, true)
            .has_workspace(&connection, "default")
            .unwrap());
        assert!(!access("stranger", false, false, true)
            .has_workspace(&connection, "default")
            .unwrap());
        assert!(!access("member", false, true, true)
            .has_workspace(&connection, "missing")
            .unwrap());
    }
}
