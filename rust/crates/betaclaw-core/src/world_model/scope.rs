//! Port of `src/server/world-model/scope.ts` — the mandatory tenant scope.
//!
//! Every productive access to World-Model data carries `user_id`, `persona_id`
//! and `workspace_id`, and the RLS policies of the canonical database enforce
//! it (`docs/RUST_MIGRATION.md:19`, `:199-201`). The four helpers of the source
//! are the only places that spell the tenant triple out.

/// `WorldModelScope` from `scope.ts:6-10`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct WorldModelScope {
    pub user_id: String,
    pub persona_id: String,
    /// `workspaceId?: string` — absent and empty are the same tenant.
    pub workspace_id: Option<String>,
}

impl WorldModelScope {
    pub fn new(
        user_id: impl Into<String>,
        persona_id: impl Into<String>,
        workspace_id: Option<String>,
    ) -> Self {
        Self {
            user_id: user_id.into(),
            persona_id: persona_id.into(),
            workspace_id,
        }
    }

    /// `normalizedScope` (`db.ts:30-36`) — the shape every scope call uses.
    pub fn parts(&self) -> ScopeParts {
        ScopeParts {
            user_id: self.user_id.clone(),
            persona_id: self.persona_id.clone(),
            workspace_id: self.workspace_id.clone().unwrap_or_default(),
        }
    }
}

/// `Required<WorldModelScope>` from `db.ts:30` — `workspaceId` is a string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeParts {
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: String,
}

/// `scopeParts` (`scope.ts:12-22`).
pub fn scope_parts(scope: &WorldModelScope) -> ScopeParts {
    scope.parts()
}

/// `scopeKey` (`scope.ts:24-26`).
pub fn scope_key(scope: &WorldModelScope) -> String {
    format!(
        "{}:{}:{}",
        scope.user_id,
        scope.persona_id,
        scope.workspace_id.clone().unwrap_or_default()
    )
}

/// `sameScope` (`scope.ts:28-34`).
pub fn same_scope(a: &WorldModelScope, b: &WorldModelScope) -> bool {
    a.user_id == b.user_id
        && a.persona_id == b.persona_id
        && a.workspace_id.clone().unwrap_or_default() == b.workspace_id.clone().unwrap_or_default()
}

/// The `WHERE` fragment `scopeWhere` (`scope.ts:41-59`) returns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeWhere {
    pub clause: String,
    pub values: Vec<String>,
    pub next_index: usize,
}

/// `scopeWhere` (`scope.ts:41-59`).
///
/// The clause is built from three literals in source order
/// (`['user_id', 'persona_id', 'workspace_id']`) and the placeholders start at
/// `start_index`; `nextIndex` is `startIndex + 3`, which the callers use to
/// continue a statement that already bound parameters.
pub fn scope_where(scope: &WorldModelScope, start_index: usize) -> ScopeWhere {
    let parts = scope.parts();
    let values = vec![parts.user_id, parts.persona_id, parts.workspace_id];
    const COLUMNS: [&str; 3] = ["user_id", "persona_id", "workspace_id"];
    let clause = values
        .iter()
        .enumerate()
        .map(|(index, _)| format!("{} = ${}", COLUMNS[index], start_index + index))
        .collect::<Vec<String>>()
        .join(" AND ");
    ScopeWhere {
        clause,
        next_index: start_index + values.len(),
        values,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope() -> WorldModelScope {
        WorldModelScope::new("u1", "p1", Some("w1".to_string()))
    }

    #[test]
    fn parts_normalize_a_missing_workspace_to_an_empty_string() {
        let without = WorldModelScope::new("u1", "p1", None);
        assert_eq!(scope_parts(&without).workspace_id, "");
        assert_eq!(
            scope_parts(&scope()),
            ScopeParts {
                user_id: "u1".to_string(),
                persona_id: "p1".to_string(),
                workspace_id: "w1".to_string(),
            }
        );
    }

    #[test]
    fn scope_key_matches_the_template_literal() {
        assert_eq!(scope_key(&scope()), "u1:p1:w1");
        assert_eq!(scope_key(&WorldModelScope::new("u1", "p1", None)), "u1:p1:");
    }

    #[test]
    fn same_scope_treats_absent_and_empty_workspace_as_equal() {
        assert!(same_scope(&scope(), &scope()));
        assert!(same_scope(
            &WorldModelScope::new("u", "p", None),
            &WorldModelScope::new("u", "p", Some(String::new()))
        ));
        assert!(!same_scope(
            &scope(),
            &WorldModelScope::new("u2", "p1", None)
        ));
        assert!(!same_scope(
            &scope(),
            &WorldModelScope::new("u1", "p2", None)
        ));
        assert!(!same_scope(
            &scope(),
            &WorldModelScope::new("u1", "p1", None)
        ));
    }

    #[test]
    fn scope_where_starts_at_the_requested_index() {
        let where_clause = scope_where(&scope(), 1);
        assert_eq!(
            where_clause.clause,
            "user_id = $1 AND persona_id = $2 AND workspace_id = $3"
        );
        assert_eq!(
            where_clause.values,
            vec!["u1".to_string(), "p1".to_string(), "w1".to_string()]
        );
        assert_eq!(where_clause.next_index, 4);
    }

    #[test]
    fn scope_where_continues_an_existing_statement() {
        let where_clause = scope_where(&scope(), 5);
        assert_eq!(
            where_clause.clause,
            "user_id = $5 AND persona_id = $6 AND workspace_id = $7"
        );
        assert_eq!(where_clause.next_index, 8);
    }
}
