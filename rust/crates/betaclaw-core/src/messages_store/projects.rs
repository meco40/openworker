//! Port of `src/server/channels/messages/repository/queries/projects.ts`.
//!
//! | TypeScript member                      | Rust member                                  |
//! | -------------------------------------- | -------------------------------------------- |
//! | `createProject`                        | [`ProjectQueries::create_project`]           |
//! | `listProjectsByPersona`                | [`ProjectQueries::list_projects_by_persona`] |
//! | `getProjectByIdOrSlug`                 | [`ProjectQueries::get_project_by_id_or_slug`] |
//! | `deleteProjectByIdOrSlug`              | [`ProjectQueries::delete_project_by_id_or_slug`] |
//! | `setActiveProjectForConversation`      | [`ProjectQueries::set_active_project_for_conversation`] |
//! | `getConversationProjectState`          | [`ProjectQueries::get_conversation_project_state`] |
//! | `setConversationProjectGuardApproved`  | [`ProjectQueries::set_conversation_project_guard_approved`] |
//! | `getProjectById` (private)             | [`ProjectQueries::get_project_by_id`]        |
//! | `resolveUniqueProjectSlug` (private)   | [`ProjectQueries::resolve_unique_project_slug`] |
//! | `toPersonaProjectRecord`               | [`to_persona_project_record`]                |
//! | `slugify`                              | [`slugify`]                                  |
//!
//! # Slug rules
//!
//! `slugify` lowercases, replaces every run of non-`[a-z0-9]` characters with a
//! single `_` and trims the underscores. Because the filter is ASCII-only, a
//! name such as "Öl Projekt" collapses to `l_projekt`. The unique-slug resolver
//! appends `_2`, `_3`, … until the `(user_id, persona_id, slug)` tuple is free,
//! which the `idx_persona_projects_unique_slug` index enforces as well.

use rusqlite::{params, Connection, OptionalExtension};

use super::types::{
    normalize_user_id, now_iso, ConversationProjectState, CreateProjectInput,
    MessageRepositoryError, PersonaProjectRecord,
};

/// `ProjectQueries` from `projects.ts:8`.
pub struct ProjectQueries<'a> {
    db: &'a Connection,
}

impl<'a> ProjectQueries<'a> {
    pub fn new(db: &'a Connection) -> Self {
        Self { db }
    }

    /// `createProject` from `projects.ts:14-55`.
    pub fn create_project(
        &self,
        input: &CreateProjectInput<'_>,
    ) -> Result<PersonaProjectRecord, MessageRepositoryError> {
        let user_id = normalize_user_id(Some(input.user_id));
        let persona_id = input.persona_id.trim();
        let name = input.name.trim();
        if persona_id.is_empty() {
            return Err(MessageRepositoryError::Validation("personaId is required"));
        }
        if name.is_empty() {
            return Err(MessageRepositoryError::Validation(
                "project name is required",
            ));
        }
        if input.workspace_path.trim().is_empty() {
            return Err(MessageRepositoryError::Validation(
                "workspacePath is required",
            ));
        }

        let id = format!("project-{}", uuid::Uuid::new_v4());
        let now = now_iso();
        let slug = self.resolve_unique_project_slug(&user_id, persona_id, name)?;

        self.db.execute(
            "
            INSERT INTO persona_projects (
              id, user_id, persona_id, name, slug,
              workspace_path, workspace_relative_path, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
          ",
            params![
                id,
                user_id,
                persona_id,
                name,
                slug,
                input.workspace_path.trim(),
                input
                    .workspace_relative_path
                    .map(str::trim)
                    .filter(|value| !value.is_empty()),
                now,
                now
            ],
        )?;

        self.get_project_by_id(&id, &user_id)?
            .ok_or(MessageRepositoryError::MissingRow {
                context: "persona_projects.create",
            })
    }

    /// `listProjectsByPersona` from `projects.ts:57-69`.
    pub fn list_projects_by_persona(
        &self,
        persona_id: &str,
        user_id: &str,
    ) -> Result<Vec<PersonaProjectRecord>, MessageRepositoryError> {
        let normalized_user_id = normalize_user_id(Some(user_id));
        let mut statement = self.db.prepare(
            "
            SELECT * FROM persona_projects
            WHERE persona_id = ?1 AND user_id = ?2
            ORDER BY updated_at DESC
          ",
        )?;
        let rows = statement.query_map(
            params![persona_id, normalized_user_id],
            to_persona_project_record,
        )?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// `getProjectByIdOrSlug` from `projects.ts:71-92`.
    pub fn get_project_by_id_or_slug(
        &self,
        persona_id: &str,
        user_id: &str,
        id_or_slug: &str,
    ) -> Result<Option<PersonaProjectRecord>, MessageRepositoryError> {
        let normalized_user_id = normalize_user_id(Some(user_id));
        let normalized = id_or_slug.trim();
        if normalized.is_empty() {
            return Ok(None);
        }

        self.db
            .query_row(
                "
                SELECT * FROM persona_projects
                WHERE user_id = ?1 AND persona_id = ?2 AND (id = ?3 OR slug = ?3)
                LIMIT 1
              ",
                params![normalized_user_id, persona_id, normalized],
                to_persona_project_record,
            )
            .optional()
            .map_err(Into::into)
    }

    /// `deleteProjectByIdOrSlug` from `projects.ts:94-123`.
    ///
    /// The `db.transaction(...)` of the source becomes an explicit
    /// `BEGIN IMMEDIATE` / `COMMIT` pair: clearing the conversation state and
    /// deleting the row must not be observable half-done.
    pub fn delete_project_by_id_or_slug(
        &self,
        persona_id: &str,
        user_id: &str,
        id_or_slug: &str,
    ) -> Result<Option<PersonaProjectRecord>, MessageRepositoryError> {
        let normalized_user_id = normalize_user_id(Some(user_id));
        let Some(project) =
            self.get_project_by_id_or_slug(persona_id, &normalized_user_id, id_or_slug)?
        else {
            return Ok(None);
        };

        let now = now_iso();
        self.db.execute_batch("BEGIN IMMEDIATE")?;
        let outcome = (|| -> rusqlite::Result<()> {
            self.db.execute(
                "
                UPDATE conversation_project_state
                SET active_project_id = NULL, updated_at = ?1
                WHERE user_id = ?2 AND active_project_id = ?3
              ",
                params![now, normalized_user_id, project.id],
            )?;
            self.db.execute(
                "DELETE FROM persona_projects WHERE id = ?1 AND user_id = ?2",
                params![project.id, normalized_user_id],
            )?;
            Ok(())
        })();

        match outcome {
            Ok(()) => {
                self.db.execute_batch("COMMIT")?;
                Ok(Some(project))
            }
            Err(error) => {
                let _ = self.db.execute_batch("ROLLBACK");
                Err(error.into())
            }
        }
    }

    /// `setActiveProjectForConversation` from `projects.ts:125-172`.
    ///
    /// The four guards of the source are kept in the same order: the
    /// conversation must exist and belong to the user, the project must exist,
    /// the conversation must have a persona, and that persona must match the
    /// project's.
    pub fn set_active_project_for_conversation(
        &self,
        conversation_id: &str,
        user_id: &str,
        project_id: Option<&str>,
    ) -> Result<(), MessageRepositoryError> {
        let normalized_user_id = normalize_user_id(Some(user_id));
        let conversation: Option<(String, Option<String>)> = self
            .db
            .query_row(
                "SELECT id, persona_id FROM conversations WHERE id = ?1 AND user_id = ?2 LIMIT 1",
                params![conversation_id, normalized_user_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((_, conversation_persona_id)) = conversation else {
            return Err(MessageRepositoryError::Validation(
                "Conversation not found.",
            ));
        };

        let mut next_project_id: Option<String> = None;
        if let Some(project_id) = project_id.filter(|value| !value.is_empty()) {
            let Some(project) = self.get_project_by_id(project_id, &normalized_user_id)? else {
                return Err(MessageRepositoryError::Validation("Project not found."));
            };
            let Some(conversation_persona_id) =
                conversation_persona_id.filter(|value| !value.is_empty())
            else {
                return Err(MessageRepositoryError::Validation(
                    "Conversation has no active persona.",
                ));
            };
            if project.persona_id != conversation_persona_id {
                return Err(MessageRepositoryError::Validation(
                    "Project persona does not match conversation persona.",
                ));
            }
            next_project_id = Some(project.id);
        }

        let now = now_iso();
        self.db.execute(
            "
            INSERT INTO conversation_project_state (
              conversation_id, user_id, active_project_id, guard_approved_without_project, updated_at
            )
            VALUES (?1, ?2, ?3, 0, ?4)
            ON CONFLICT(conversation_id)
            DO UPDATE SET
              user_id = excluded.user_id,
              active_project_id = excluded.active_project_id,
              guard_approved_without_project = 0,
              updated_at = excluded.updated_at
          ",
            params![
                conversation_id,
                normalized_user_id,
                next_project_id,
                now
            ],
        )?;
        Ok(())
    }

    /// `getConversationProjectState` from `projects.ts:174-202`.
    ///
    /// A conversation without a state row reports the "no project, not approved"
    /// default rather than `null`, which is what the project guard expects.
    pub fn get_conversation_project_state(
        &self,
        conversation_id: &str,
        user_id: &str,
    ) -> Result<ConversationProjectState, MessageRepositoryError> {
        let normalized_user_id = normalize_user_id(Some(user_id));
        let row: Option<ConversationProjectState> = self
            .db
            .query_row(
                "
                SELECT conversation_id, active_project_id, guard_approved_without_project, updated_at
                FROM conversation_project_state
                WHERE conversation_id = ?1 AND user_id = ?2
                LIMIT 1
              ",
                params![conversation_id, normalized_user_id],
                |row| {
                    Ok(ConversationProjectState {
                        conversation_id: row.get("conversation_id")?,
                        active_project_id: row
                            .get::<_, Option<String>>("active_project_id")?
                            .filter(|value| !value.is_empty()),
                        guard_approved_without_project: row
                            .get::<_, Option<i64>>("guard_approved_without_project")?
                            .unwrap_or(0)
                            == 1,
                        updated_at: row
                            .get::<_, Option<String>>("updated_at")?
                            .filter(|value| !value.is_empty()),
                    })
                },
            )
            .optional()?;

        Ok(row.unwrap_or(ConversationProjectState {
            conversation_id: conversation_id.to_string(),
            active_project_id: None,
            guard_approved_without_project: false,
            updated_at: None,
        }))
    }

    /// `setConversationProjectGuardApproved` from `projects.ts:204-228`.
    pub fn set_conversation_project_guard_approved(
        &self,
        conversation_id: &str,
        user_id: &str,
        approved: bool,
    ) -> Result<(), MessageRepositoryError> {
        let normalized_user_id = normalize_user_id(Some(user_id));
        let now = now_iso();
        let existing = self.get_conversation_project_state(conversation_id, &normalized_user_id)?;
        self.db.execute(
            "
            INSERT INTO conversation_project_state (
              conversation_id, user_id, active_project_id, guard_approved_without_project, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(conversation_id)
            DO UPDATE SET
              user_id = excluded.user_id,
              active_project_id = excluded.active_project_id,
              guard_approved_without_project = excluded.guard_approved_without_project,
              updated_at = excluded.updated_at
          ",
            params![
                conversation_id,
                normalized_user_id,
                existing.active_project_id,
                if approved { 1 } else { 0 },
                now
            ],
        )?;
        Ok(())
    }

    /// `getProjectById` from `projects.ts:230-235`.
    pub fn get_project_by_id(
        &self,
        project_id: &str,
        user_id: &str,
    ) -> Result<Option<PersonaProjectRecord>, MessageRepositoryError> {
        self.db
            .query_row(
                "SELECT * FROM persona_projects WHERE id = ?1 AND user_id = ?2 LIMIT 1",
                params![project_id, user_id],
                to_persona_project_record,
            )
            .optional()
            .map_err(Into::into)
    }

    /// `resolveUniqueProjectSlug` from `projects.ts:237-254`.
    pub fn resolve_unique_project_slug(
        &self,
        user_id: &str,
        persona_id: &str,
        name: &str,
    ) -> Result<String, MessageRepositoryError> {
        let base = slugify(name);
        let mut candidate = base.clone();
        let mut counter: i64 = 1;

        while self.slug_taken(user_id, persona_id, &candidate)? {
            counter += 1;
            candidate = format!("{base}_{counter}");
        }

        Ok(candidate)
    }

    fn slug_taken(
        &self,
        user_id: &str,
        persona_id: &str,
        slug: &str,
    ) -> Result<bool, MessageRepositoryError> {
        let exists: Option<i64> = self
            .db
            .query_row(
                "SELECT 1 FROM persona_projects WHERE user_id = ?1 AND persona_id = ?2 AND slug = ?3 LIMIT 1",
                params![user_id, persona_id, slug],
                |row| row.get(0),
            )
            .optional()?;
        Ok(exists.is_some())
    }
}

/// `toPersonaProjectRecord` from `projects.ts:257-269`.
fn to_persona_project_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<PersonaProjectRecord> {
    Ok(PersonaProjectRecord {
        id: row.get("id")?,
        user_id: row.get("user_id")?,
        persona_id: row.get("persona_id")?,
        name: row.get("name")?,
        slug: row.get("slug")?,
        workspace_path: row.get("workspace_path")?,
        workspace_relative_path: row
            .get::<_, Option<String>>("workspace_relative_path")?
            .filter(|value| !value.is_empty()),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// `slugify` from `projects.ts:271-279`.
///
/// The JavaScript chain is
/// `trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')`.
/// Lowercasing before the filter is why a non-ASCII letter disappears instead of
/// being transliterated.
pub fn slugify(value: &str) -> String {
    let lowered = value.trim().to_lowercase();

    let mut collapsed = String::with_capacity(lowered.len());
    let mut pending_separator = false;
    for ch in lowered.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            if pending_separator && !collapsed.is_empty() {
                collapsed.push('_');
            }
            pending_separator = false;
            collapsed.push(ch);
        } else {
            pending_separator = true;
        }
    }

    if collapsed.is_empty() {
        return "project".to_string();
    }
    collapsed
}

#[cfg(test)]
mod tests {
    use super::slugify;

    #[test]
    fn slugify_matches_the_javascript_chain() {
        assert_eq!(slugify("My Project"), "my_project");
        assert_eq!(slugify("  Spaced  Out  "), "spaced_out");
        assert_eq!(slugify("a---b"), "a_b", "runs collapse into one underscore");
        assert_eq!(slugify("__leading"), "leading");
        assert_eq!(slugify("trailing__"), "trailing");
        assert_eq!(slugify("v1.2.3"), "v1_2_3");
        assert_eq!(slugify("Öl Projekt"), "l_projekt", "non-ASCII is dropped");
        assert_eq!(slugify("!!!"), "project", "the empty fallback");
        assert_eq!(slugify(""), "project");
    }
}
