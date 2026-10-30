//! Caller resolution and workspace visibility.
//!
//! Ports `withUserContext` (`app/api/_shared/withUserContext.ts`) and the
//! workspace helpers of `src/server/auth/workspaceAccess.ts`. The gate in
//! `auth_gate.rs` rejects anonymous calls where identity is required, and it
//! sets `x-betaclaw-user-id` only for admitted callers. It does not forward the
//! `authenticated` flag, so the session cookie is checked again here.

use axum::http::HeaderMap;
use betaclaw_core::auth::jwe::decode_session_from_cookies;
use rusqlite::{params, OptionalExtension};

use super::MainStore;
use crate::auth_gate::{parse_cookies, user_id_from_headers, USER_SERVICE_HEADER};
use crate::state::AppState;

/// `RequestUserContext` of the TypeScript routes.
pub struct Caller {
    pub user_id: String,
    authenticated: bool,
    service: bool,
    require_auth: bool,
}

impl Caller {
    /// The identity of a request, or `None` when the gate attached none. The
    /// handler answers 401 then.
    pub fn from_request(state: &AppState, headers: &HeaderMap) -> Option<Self> {
        let user_id = user_id_from_headers(headers)?;
        let service = headers
            .get(USER_SERVICE_HEADER)
            .and_then(|value| value.to_str().ok())
            == Some("1");
        Some(Self {
            user_id,
            authenticated: service || session_is_valid(state, headers),
            service,
            require_auth: state.config.require_auth,
        })
    }

    /// `service || (!isAuthRequired() && !authenticated)`: these callers see every
    /// workspace.
    fn sees_every_workspace(&self) -> bool {
        self.service || (!self.require_auth && !self.authenticated)
    }
}

fn session_is_valid(state: &AppState, headers: &HeaderMap) -> bool {
    let cookies = parse_cookies(headers);
    decode_session_from_cookies(
        cookies
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str())),
        &state.config.session_cookie_names(),
        &state.config.auth_secret,
        chrono::Utc::now().timestamp(),
    )
    .is_ok()
}

impl MainStore {
    /// `getAccessibleWorkspaceIds`.
    pub fn accessible_workspace_ids(&self, caller: &Caller) -> rusqlite::Result<Vec<String>> {
        let connection = self.lock();
        if caller.sees_every_workspace() {
            let mut statement = connection.prepare("SELECT id FROM workspaces ORDER BY name")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect()
        } else {
            let mut statement = connection.prepare(
                "SELECT workspace_id FROM workspace_members WHERE user_id = ? ORDER BY workspace_id",
            )?;
            let rows =
                statement.query_map([caller.user_id.as_str()], |row| row.get::<_, String>(0))?;
            rows.collect()
        }
    }

    /// `hasWorkspaceAccess`: the workspace exists and the caller may see it.
    pub fn has_workspace_access(
        &self,
        caller: &Caller,
        workspace_id: &str,
    ) -> rusqlite::Result<bool> {
        let normalized = workspace_id.trim();
        // `normalizeWorkspaceId`: 1 to 200 characters, measured in UTF-16 units as JavaScript does.
        if normalized.is_empty() || normalized.encode_utf16().count() > 200 {
            return Ok(false);
        }
        let connection = self.lock();
        let exists = connection
            .query_row(
                "SELECT 1 FROM workspaces WHERE id = ?",
                [normalized],
                |_| Ok(()),
            )
            .optional()?;
        if exists.is_none() {
            return Ok(false);
        }
        if caller.sees_every_workspace() {
            return Ok(true);
        }
        let member = connection
            .query_row(
                "SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
                params![normalized, caller.user_id],
                |_| Ok(()),
            )
            .optional()?;
        Ok(member.is_some())
    }

    /// `getTaskWorkspaceId`.
    pub fn workspace_of_task(&self, task_id: &str) -> rusqlite::Result<Option<String>> {
        self.workspace_column("tasks", task_id)
    }

    /// `getAgentWorkspaceId`.
    pub fn workspace_of_agent(&self, agent_id: &str) -> rusqlite::Result<Option<String>> {
        self.workspace_column("agents", agent_id)
    }

    /// `canAccessAgent`.
    pub fn can_access_agent(&self, caller: &Caller, agent_id: &str) -> rusqlite::Result<bool> {
        match self.workspace_of_agent(agent_id)? {
            Some(workspace) => self.has_workspace_access(caller, &workspace),
            None => Ok(false),
        }
    }

    /// `canAccessTask`.
    pub fn can_access_task(&self, caller: &Caller, task_id: &str) -> rusqlite::Result<bool> {
        match self.workspace_of_task(task_id)? {
            Some(workspace) => self.has_workspace_access(caller, &workspace),
            None => Ok(false),
        }
    }

    /// `workspace_id` of one row of `agents` or `tasks`. `table` is one of the two
    /// literals above, never input.
    fn workspace_column(&self, table: &str, id: &str) -> rusqlite::Result<Option<String>> {
        let connection = self.lock();
        let sql = format!("SELECT workspace_id FROM {table} WHERE id = ?");
        let row = connection
            .query_row(&sql, [id], |row| row.get::<_, Option<String>>(0))
            .optional()?;
        Ok(row.flatten())
    }
}
