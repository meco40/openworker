//! Port of `src/server/master/notes.ts:1-21`.
//!
//! A two-method facade over the repository: create a note and list the notes of
//! one scope. There is no logic beyond `input.tags || []`, which the port turns
//! into an explicit `Vec` because Rust has no optional property with a default.
//!
//! # The service borrows the repository
//!
//! `constructor(private readonly repo: MasterRepository)` takes the interface by
//! reference, and the SQLite handle behind it is single-threaded
//! (`rusqlite::Connection` is `Send` but not `Sync`), so the port holds
//! `&'a dyn MasterRepository` instead of an owned handle. That keeps the two
//! service classes of this package usable with the facade *and* with a test
//! double, without an `Arc` that would promise a sharing the connection cannot
//! give.

use crate::master::repository::MasterRepository;
use crate::master::types::{MasterNote, WorkspaceScope};

/// `listNotes` default from `notes.store.ts:35` (`limit = 100`).
///
/// `notes.ts:19` calls `listNotes(scope)` without a limit, so the store default
/// is the effective limit and the port names it here.
pub const DEFAULT_NOTE_LIMIT: i64 = 100;

/// `input` of `MasterNotesService.create` — `notes.ts:9`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MasterNoteCreateInput {
    pub title: String,
    pub content: String,
    /// `tags?` — the source substitutes `[]` for an absent value.
    pub tags: Vec<String>,
}

/// `MasterNotesService` from `notes.ts:4-20`.
pub struct MasterNotesService<'a> {
    repo: &'a dyn MasterRepository,
}

impl<'a> MasterNotesService<'a> {
    /// `constructor(private readonly repo: MasterRepository)` — `notes.ts:5`.
    pub fn new(repo: &'a dyn MasterRepository) -> Self {
        Self { repo }
    }

    /// `create` — `notes.ts:7-16`.
    pub fn create(
        &self,
        scope: &WorkspaceScope,
        input: &MasterNoteCreateInput,
    ) -> rusqlite::Result<MasterNote> {
        self.repo.create_note(
            scope,
            &crate::master::repository::notes_store::MasterNoteInput {
                title: input.title.clone(),
                content: input.content.clone(),
                tags: input.tags.clone(),
            },
        )
    }

    /// `list` — `notes.ts:18-20`.
    pub fn list(&self, scope: &WorkspaceScope) -> rusqlite::Result<Vec<MasterNote>> {
        self.repo.list_notes(scope, DEFAULT_NOTE_LIMIT)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::master::repository::sqlite_master_repository::SqliteMasterRepository;

    fn scope() -> WorkspaceScope {
        WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
        }
    }

    fn service(repo: &SqliteMasterRepository) -> MasterNotesService<'_> {
        MasterNotesService::new(repo)
    }

    #[test]
    fn create_stores_the_note_with_its_tags() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let notes = service(&repo);
        let note = notes
            .create(
                &scope(),
                &MasterNoteCreateInput {
                    title: "Title".to_string(),
                    content: "Body".to_string(),
                    tags: vec!["a".to_string(), "b".to_string()],
                },
            )
            .unwrap();

        assert_eq!(note.title, "Title");
        assert_eq!(note.content, "Body");
        assert_eq!(note.tags, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(note.user_id, "u1");
        assert_eq!(note.workspace_id, "w1");
    }

    #[test]
    fn an_absent_tag_list_is_an_empty_list() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let notes = service(&repo);
        let note = notes
            .create(
                &scope(),
                &MasterNoteCreateInput {
                    title: "T".to_string(),
                    content: "C".to_string(),
                    ..MasterNoteCreateInput::default()
                },
            )
            .unwrap();
        assert!(note.tags.is_empty());
    }

    #[test]
    fn list_returns_the_notes_of_the_scope_only() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let notes = service(&repo);
        for title in ["one", "two"] {
            notes
                .create(
                    &scope(),
                    &MasterNoteCreateInput {
                        title: title.to_string(),
                        content: "c".to_string(),
                        ..MasterNoteCreateInput::default()
                    },
                )
                .unwrap();
        }
        notes
            .create(
                &WorkspaceScope {
                    user_id: "u1".to_string(),
                    workspace_id: "other".to_string(),
                },
                &MasterNoteCreateInput {
                    title: "elsewhere".to_string(),
                    content: "c".to_string(),
                    ..MasterNoteCreateInput::default()
                },
            )
            .unwrap();

        let listed = notes.list(&scope()).unwrap();
        assert_eq!(listed.len(), 2);
        // The store orders by `updated_at DESC` with millisecond timestamps; the
        // set is what the service guarantees, so compare it as a set.
        let mut titles: Vec<&str> = listed.iter().map(|note| note.title.as_str()).collect();
        titles.sort_unstable();
        assert_eq!(titles, vec!["one", "two"]);
    }

    #[test]
    fn the_service_also_works_through_a_dyn_repository() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let dynamic: &dyn MasterRepository = &repo;
        let notes = MasterNotesService::new(dynamic);
        assert!(notes.list(&scope()).unwrap().is_empty());
    }
}
