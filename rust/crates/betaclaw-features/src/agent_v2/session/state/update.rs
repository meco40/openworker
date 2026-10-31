//! Port of `src/server/agent-v2/session/state/update.ts`.

use std::collections::HashMap;

use crate::agent_v2::errors::{AgentV2Error, ErrorCode};
use crate::agent_v2::repository::AgentV2Repository;
use crate::agent_v2::session::types::AgentSessionHandle;
use crate::agent_v2::types::AgentSessionSnapshot;

/// `getSession`: the user's session, or `NOT_FOUND`. A session that is found also
/// refreshes its entry in the active handles.
pub fn get_session(
    repository: &AgentV2Repository,
    active_handles: &mut HashMap<String, AgentSessionHandle>,
    session_id: &str,
    user_id: &str,
) -> Result<AgentSessionSnapshot, AgentV2Error> {
    let session = repository
        .get_session(session_id, user_id)?
        .ok_or_else(|| AgentV2Error::new(ErrorCode::NotFound, "Session not found."))?;
    active_handles.insert(
        session_id.to_string(),
        AgentSessionHandle {
            session_id: session_id.to_string(),
            user_id: user_id.to_string(),
            snapshot: session.clone(),
        },
    );
    Ok(session)
}

/// `listSessions`. The limit is passed on as it is; the default is applied by the caller
/// (see [`crate::agent_v2::session::list_limit`]).
pub fn list_sessions(
    repository: &AgentV2Repository,
    user_id: &str,
    limit: i64,
) -> Result<Vec<AgentSessionSnapshot>, AgentV2Error> {
    repository.list_sessions(user_id, Some(limit))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_v2::types::CreateSessionInput;

    fn session(repository: &AgentV2Repository, user: &str) -> String {
        repository
            .create_session(&CreateSessionInput {
                user_id: user.into(),
                conversation_id: "conv".into(),
                status: None,
            })
            .expect("create session")
            .session
            .id
    }

    #[test]
    fn get_session_is_owner_scoped_and_refreshes_the_handle() {
        let repository = AgentV2Repository::in_memory().expect("open");
        let session_id = session(&repository, "owner");
        let mut handles = HashMap::new();

        let error = get_session(&repository, &mut handles, &session_id, "stranger")
            .expect_err("not the owner");
        assert_eq!(error.code(), Some(ErrorCode::NotFound));
        assert!(handles.is_empty());

        let found = get_session(&repository, &mut handles, &session_id, "owner").expect("owner");
        let handle = handles.get(&session_id).expect("handle cached");
        assert_eq!(handle.user_id, "owner");
        assert_eq!(handle.snapshot, found);
    }

    #[test]
    fn list_sessions_returns_the_users_sessions_within_the_limit() {
        let repository = AgentV2Repository::in_memory().expect("open");
        session(&repository, "lister");
        session(&repository, "lister");
        session(&repository, "someone-else");

        assert_eq!(
            list_sessions(&repository, "lister", 1).expect("list").len(),
            1
        );
        assert_eq!(
            list_sessions(&repository, "lister", 50)
                .expect("list")
                .len(),
            2
        );
    }
}
