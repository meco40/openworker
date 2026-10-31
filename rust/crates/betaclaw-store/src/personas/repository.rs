//! Port of `src/server/personas/personaRepository.ts`.
//!
//! The `personas` and `persona_tool_permissions` schemas, the `ALTER TABLE` upgrade
//! ladder and the four indexes are reproduced statement for statement and in the
//! same order, so an existing `.local/personas.db` created by the TypeScript
//! backend is upgraded identically by this module and the other way round.
//!
//! TypeScript wraps multi-statement mutations in `db.transaction(...)`.
//! `rusqlite` has no combinator for that, so the equivalent is an explicit
//! `BEGIN IMMEDIATE` / `COMMIT` pair with a rollback on error.

use std::collections::{BTreeSet, HashMap};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use crate::db::{open, OpenOptions};

use super::types::{
    CreatePersonaInput, MemoryPersonaType, PersonaFileName, PersonaProfile, PersonaSummary,
    PersonaWithFiles, SystemPersonaKey, MAX_PERSONA_INSTRUCTION_CHARS, PERSONA_FILE_NAMES,
    PERSONA_INSTRUCTION_FILES,
};
use super::workspace::{slugify_persona_name, PersonaWorkspace};

/// `DEFAULT_MAX_TOOL_CALLS` — the fallback used by the row mappers in
/// `personaRepository.ts:42` and by `createPersona`.
const DEFAULT_MAX_TOOL_CALLS: i64 = 120;
const MIN_MAX_TOOL_CALLS: i64 = 3;
const MAX_MAX_TOOL_CALLS: i64 = 500;

/// Partial update accepted by [`PersonaRepository::update_persona`].
///
/// `preferred_model_id` and `model_hub_profile_id` use
/// `Option<Option<String>>`: the outer `Option` means "not supplied", the inner
/// one means "supplied as null", which is how `personaRepository.ts:283-290`
/// distinguishes an absent key from an explicit `null`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PersonaUpdate {
    pub name: Option<String>,
    pub emoji: Option<String>,
    pub vibe: Option<String>,
    pub preferred_model_id: Option<Option<String>>,
    pub model_hub_profile_id: Option<Option<String>>,
    pub memory_persona_type: Option<MemoryPersonaType>,
    pub is_autonomous: Option<bool>,
    pub max_tool_calls: Option<i64>,
}

#[derive(Debug, thiserror::Error)]
pub enum PersonaRepositoryError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("Persona slug already exists: \"{slug}\".")]
    SlugConflict { slug: String },
    #[error("Cannot delete a system persona.")]
    SystemPersonaDelete,
    #[error("Cannot rename a system persona.")]
    SystemPersonaRename,
    #[error("workspace error: {0}")]
    Workspace(#[from] super::workspace::PersonaWorkspaceError),
}

/// SQLite-backed persona store.
pub struct PersonaRepository {
    connection: Connection,
    workspace: PersonaWorkspace,
}

impl PersonaRepository {
    /// Mirrors `new PersonaRepository(process.env.PERSONAS_DB_PATH || '.local/personas.db')`.
    pub fn open(db_path: &str) -> Result<Self, PersonaRepositoryError> {
        Self::open_with_workspace(db_path, PersonaWorkspace::from_env())
    }

    /// Opens the repository against an explicit workspace root. Tests use this so
    /// they never have to mutate `PERSONAS_ROOT_PATH` process-wide.
    pub fn open_with_workspace(
        db_path: &str,
        workspace: PersonaWorkspace,
    ) -> Result<Self, PersonaRepositoryError> {
        let connection = open(OpenOptions::new(db_path))?;
        let repository = Self {
            connection,
            workspace,
        };
        repository.migrate()?;
        Ok(repository)
    }

    /// `close()` from `personaRepository.ts:382-384`. Dropping the connection has
    /// the same effect; this exists so the lifecycle reads like the source.
    pub fn close(self) {
        drop(self.connection);
    }

    pub fn workspace(&self) -> &PersonaWorkspace {
        &self.workspace
    }

    // ─── Migration ─────────────────────────────────────────────────────────

    /// `migrate()` from `personaRepository.ts:78-157`.
    ///
    /// The TypeScript source runs the `ALTER TABLE` statements inside
    /// `try {} catch {}` and ignores "duplicate column name". The port checks
    /// `PRAGMA table_info` first, which is equivalent and surfaces real errors
    /// instead of hiding them.
    fn migrate(&self) -> Result<(), PersonaRepositoryError> {
        self.connection.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS personas (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              emoji TEXT NOT NULL DEFAULT '🤖',
              vibe TEXT NOT NULL DEFAULT '',
              system_persona_key TEXT,
              preferred_model_id TEXT,
              model_hub_profile_id TEXT,
              user_id TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            "#,
        )?;

        for (column, definition) in ADDITIVE_COLUMNS {
            if !self.has_column("personas", column)? {
                self.connection
                    .execute_batch(&format!("ALTER TABLE personas ADD COLUMN {definition};"))?;
            }
        }

        self.connection.execute_batch(
            r#"
            CREATE UNIQUE INDEX IF NOT EXISTS idx_personas_slug_unique
              ON personas (slug);
            "#,
        )?;
        self.connection.execute_batch(
            r#"
            CREATE UNIQUE INDEX IF NOT EXISTS idx_personas_user_system_key_unique
              ON personas (user_id, system_persona_key)
              WHERE system_persona_key IS NOT NULL;
            "#,
        )?;
        self.connection.execute_batch(
            r#"
            CREATE INDEX IF NOT EXISTS idx_personas_user
              ON personas (user_id, updated_at DESC);
            "#,
        )?;
        self.connection.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS persona_tool_permissions (
              persona_id TEXT NOT NULL,
              function_name TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              PRIMARY KEY (persona_id, function_name)
            );
            "#,
        )?;

        self.backfill_persona_slugs_and_workspaces()?;
        self.migrate_persona_files_to_filesystem()?;
        Ok(())
    }

    fn has_column(&self, table: &str, column: &str) -> Result<bool, PersonaRepositoryError> {
        let mut statement = self
            .connection
            .prepare(&format!("PRAGMA table_info({table})"))?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let name: Option<String> = row.get(1)?;
            if name.as_deref() == Some(column) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// `backfillPersonaSlugsAndWorkspaces` from `personaRepository.ts:463-492`.
    fn backfill_persona_slugs_and_workspaces(&self) -> Result<(), PersonaRepositoryError> {
        let mut statement = self
            .connection
            .prepare("SELECT id, name, slug FROM personas ORDER BY created_at ASC")?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut used: BTreeSet<String> = rows
            .iter()
            .filter_map(|(_, _, slug)| slug.as_deref().map(str::trim).map(str::to_string))
            .filter(|slug| !slug.is_empty())
            .collect();

        for (id, name, slug) in rows {
            let current = slug.unwrap_or_default().trim().to_string();
            if !current.is_empty() {
                self.workspace.ensure_workspace(&current)?;
                continue;
            }

            let base_slug = slugify_persona_name(&name);
            let mut next_slug = base_slug.clone();
            let mut suffix = 1;
            while used.contains(&next_slug) {
                suffix += 1;
                next_slug = format!("{base_slug}_{suffix}");
            }

            self.connection.execute(
                "UPDATE personas SET slug = ?1 WHERE id = ?2",
                params![next_slug, id],
            )?;
            used.insert(next_slug.clone());
            self.workspace.ensure_workspace(&next_slug)?;
        }
        Ok(())
    }

    /// `migratePersonaFilesToFilesystem` from `personaRepository.ts:494-548`.
    fn migrate_persona_files_to_filesystem(&self) -> Result<(), PersonaRepositoryError> {
        let mut statement = self.connection.prepare("SELECT id, slug FROM personas")?;
        let personas = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let has_legacy_table: bool = self
            .connection
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'persona_files'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some();

        if !has_legacy_table {
            for (_, slug) in personas {
                let slug = slug.unwrap_or_default().trim().to_string();
                if slug.is_empty() {
                    continue;
                }
                self.workspace.ensure_files(&slug, None)?;
            }
            return Ok(());
        }

        let mut statement = self
            .connection
            .prepare("SELECT persona_id, filename, content FROM persona_files")?;
        let legacy_rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut legacy_by_persona: HashMap<String, Vec<(String, String)>> = HashMap::new();
        for (persona_id, filename, content) in legacy_rows {
            // Unknown filenames are dropped, matching
            // `!PERSONA_FILE_NAMES.includes(...)` at personaRepository.ts:519.
            if PersonaFileName::parse(&filename).is_none() {
                continue;
            }
            let entry = legacy_by_persona.entry(persona_id).or_default();
            match entry.iter_mut().find(|(name, _)| *name == filename) {
                Some(existing) => existing.1 = content,
                None => entry.push((filename, content)),
            }
        }

        for (id, slug) in personas {
            let slug = slug.unwrap_or_default().trim().to_string();
            if slug.is_empty() {
                continue;
            }
            let legacy = legacy_by_persona.get(&id);
            self.workspace
                .ensure_files(&slug, legacy.map(Vec::as_slice))?;

            let Some(legacy) = legacy else {
                continue;
            };
            for filename in PERSONA_FILE_NAMES {
                let Some((_, legacy_content)) =
                    legacy.iter().find(|(name, _)| name == filename.as_str())
                else {
                    continue;
                };
                if legacy_content.is_empty() {
                    continue;
                }
                let current = self.workspace.read_file(&slug, *filename)?;
                if current
                    .as_deref()
                    .is_some_and(|text| text.trim().is_empty())
                {
                    self.workspace
                        .write_file(&slug, *filename, legacy_content)?;
                }
            }
        }

        self.connection
            .execute_batch("DROP TABLE IF EXISTS persona_files")?;
        Ok(())
    }

    // ─── Persona CRUD ─────────────────────────────────────────────────────

    /// `listPersonas` from `personaRepository.ts:161-166`.
    pub fn list_personas(
        &self,
        user_id: &str,
    ) -> Result<Vec<PersonaSummary>, PersonaRepositoryError> {
        let mut statement = self
            .connection
            .prepare("SELECT * FROM personas WHERE user_id = ?1 ORDER BY updated_at DESC")?;
        let rows = statement
            .query_map(params![user_id], map_summary_row)?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|summary| self.attach_allowed_tool_functions(summary))
            .collect()
    }

    /// `listAllPersonas` from `personaRepository.ts:168-173`.
    pub fn list_all_personas(&self) -> Result<Vec<PersonaSummary>, PersonaRepositoryError> {
        let mut statement = self
            .connection
            .prepare("SELECT * FROM personas ORDER BY updated_at DESC")?;
        let rows = statement
            .query_map([], map_summary_row)?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|summary| self.attach_allowed_tool_functions(summary))
            .collect()
    }

    /// `getPersona` from `personaRepository.ts:175-180`.
    pub fn get_persona(&self, id: &str) -> Result<Option<PersonaProfile>, PersonaRepositoryError> {
        let row = self
            .connection
            .query_row(
                "SELECT * FROM personas WHERE id = ?1",
                params![id],
                map_profile_row,
            )
            .optional()?;
        match row {
            Some(profile) => Ok(Some(self.attach_allowed_tool_functions(profile)?)),
            None => Ok(None),
        }
    }

    /// `getSystemPersona` from `personaRepository.ts:182-187`.
    pub fn get_system_persona(
        &self,
        user_id: &str,
        key: SystemPersonaKey,
    ) -> Result<Option<PersonaProfile>, PersonaRepositoryError> {
        let row = self
            .connection
            .query_row(
                "SELECT * FROM personas WHERE user_id = ?1 AND system_persona_key = ?2 LIMIT 1",
                params![user_id, key.as_str()],
                map_profile_row,
            )
            .optional()?;
        match row {
            Some(profile) => Ok(Some(self.attach_allowed_tool_functions(profile)?)),
            None => Ok(None),
        }
    }

    /// `getPersonaWithFiles` from `personaRepository.ts:189-199`.
    pub fn get_persona_with_files(
        &self,
        id: &str,
    ) -> Result<Option<PersonaWithFiles>, PersonaRepositoryError> {
        let Some(persona) = self.get_persona(id)? else {
            return Ok(None);
        };
        let mut files = Vec::with_capacity(PERSONA_FILE_NAMES.len());
        for filename in PERSONA_FILE_NAMES {
            let content = self
                .workspace
                .read_file(&persona.slug, *filename)?
                .unwrap_or_default();
            files.push(((*filename).as_str().to_string(), content));
        }
        Ok(Some(PersonaWithFiles { persona, files }))
    }

    /// `createPersona` from `personaRepository.ts:201-238`.
    pub fn create_persona(
        &self,
        input: &CreatePersonaInput,
    ) -> Result<PersonaProfile, PersonaRepositoryError> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_iso();
        let memory_persona_type = input
            .memory_persona_type
            .unwrap_or(MemoryPersonaType::General);
        let slug = self.resolve_unique_slug_or_throw(&input.name)?;
        let allowed =
            normalize_allowed_tool_function_names(input.allowed_tool_function_names.as_deref());

        self.transaction(|connection| {
            connection.execute(
                "INSERT INTO personas (id, name, slug, emoji, vibe, system_persona_key, preferred_model_id, model_hub_profile_id, memory_persona_type, is_autonomous, max_tool_calls, user_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    id,
                    input.name,
                    slug,
                    input.emoji,
                    input.vibe,
                    input.system_persona_key.map(SystemPersonaKey::as_str),
                    input.preferred_model_id,
                    input.model_hub_profile_id,
                    memory_persona_type.as_str(),
                    i64::from(input.is_autonomous.unwrap_or(false)),
                    input.max_tool_calls.unwrap_or(DEFAULT_MAX_TOOL_CALLS),
                    input.user_id,
                    now,
                    now,
                ],
            )?;
            Ok(())
        })?;

        self.replace_allowed_tool_function_names(&id, &allowed, &now)?;
        self.workspace.ensure_files(&slug, input.files.as_deref())?;

        self.get_persona(&id)?
            .ok_or(PersonaRepositoryError::Database(
                rusqlite::Error::QueryReturnedNoRows,
            ))
    }

    /// `updatePersona` from `personaRepository.ts:240-316`.
    ///
    /// Returns `false` when the persona does not exist, matching the early
    /// `return` in the TypeScript method.
    pub fn update_persona(
        &self,
        id: &str,
        updates: &PersonaUpdate,
    ) -> Result<bool, PersonaRepositoryError> {
        let Some(current) = self.get_persona(id)? else {
            return Ok(false);
        };
        self.assert_system_persona_mutation_allowed(&current, updates)?;

        let now = now_iso();
        let mut set_clauses: Vec<String> = vec!["updated_at = ?1".to_string()];
        let mut values: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(now.clone())];

        let mut next_slug = current.slug.clone();
        let mut should_rename_workspace = false;

        if let Some(name) = &updates.name {
            push_set(
                &mut set_clauses,
                &mut values,
                "name",
                Box::new(name.clone()),
            );
            let candidate_slug = slugify_persona_name(name);
            if candidate_slug != current.slug {
                self.assert_unique_persona_slug(&candidate_slug, Some(id))?;
                next_slug = candidate_slug.clone();
                should_rename_workspace = true;
                push_set(
                    &mut set_clauses,
                    &mut values,
                    "slug",
                    Box::new(candidate_slug),
                );
            }
        }
        if let Some(emoji) = &updates.emoji {
            push_set(
                &mut set_clauses,
                &mut values,
                "emoji",
                Box::new(emoji.clone()),
            );
        }
        if let Some(vibe) = &updates.vibe {
            push_set(
                &mut set_clauses,
                &mut values,
                "vibe",
                Box::new(vibe.clone()),
            );
        }
        if let Some(preferred_model_id) = &updates.preferred_model_id {
            push_set(
                &mut set_clauses,
                &mut values,
                "preferred_model_id",
                Box::new(preferred_model_id.clone()),
            );
        }
        if let Some(model_hub_profile_id) = &updates.model_hub_profile_id {
            push_set(
                &mut set_clauses,
                &mut values,
                "model_hub_profile_id",
                Box::new(model_hub_profile_id.clone()),
            );
        }
        if let Some(memory_persona_type) = updates.memory_persona_type {
            push_set(
                &mut set_clauses,
                &mut values,
                "memory_persona_type",
                Box::new(memory_persona_type.as_str().to_string()),
            );
        }
        if let Some(is_autonomous) = updates.is_autonomous {
            push_set(
                &mut set_clauses,
                &mut values,
                "is_autonomous",
                Box::new(i64::from(is_autonomous)),
            );
        }
        if let Some(max_tool_calls) = updates.max_tool_calls {
            // `Math.max(3, Math.min(500, Math.floor(v)))` at personaRepository.ts:302.
            let clamped = max_tool_calls.clamp(MIN_MAX_TOOL_CALLS, MAX_MAX_TOOL_CALLS);
            push_set(
                &mut set_clauses,
                &mut values,
                "max_tool_calls",
                Box::new(clamped),
            );
        }

        let id_parameter = values.len() + 1;
        values.push(Box::new(id.to_string()));
        let sql = format!(
            "UPDATE personas SET {} WHERE id = ?{id_parameter}",
            set_clauses.join(", ")
        );

        self.transaction(|connection| {
            connection.execute(&sql, rusqlite::params_from_iter(values.iter()))?;
            Ok(())
        })?;

        if should_rename_workspace {
            self.workspace.rename_workspace(&current.slug, &next_slug)?;
        } else {
            self.workspace.ensure_files(&current.slug, None)?;
        }
        Ok(true)
    }

    /// `deletePersona` from `personaRepository.ts:318-330`.
    pub fn delete_persona(&self, id: &str) -> Result<bool, PersonaRepositoryError> {
        let Some(existing) = self.get_persona(id)? else {
            return Ok(false);
        };
        if existing.system_persona_key.is_some() {
            return Err(PersonaRepositoryError::SystemPersonaDelete);
        }

        let changes = self
            .connection
            .execute("DELETE FROM personas WHERE id = ?1", params![id])?;
        if changes > 0 {
            self.workspace.remove_workspace(&existing.slug)?;
        }
        Ok(changes > 0)
    }

    // ─── File CRUD ─────────────────────────────────────────────────────────

    /// `getFile` from `personaRepository.ts:334-338`.
    pub fn get_file(
        &self,
        persona_id: &str,
        filename: PersonaFileName,
    ) -> Result<Option<String>, PersonaRepositoryError> {
        let Some(persona) = self.get_persona(persona_id)? else {
            return Ok(None);
        };
        Ok(self.workspace.read_file(&persona.slug, filename)?)
    }

    /// `saveFile` from `personaRepository.ts:340-349`.
    pub fn save_file(
        &self,
        persona_id: &str,
        filename: PersonaFileName,
        content: &str,
    ) -> Result<(), PersonaRepositoryError> {
        let Some(persona) = self.get_persona(persona_id)? else {
            return Ok(());
        };

        let now = now_iso();
        self.workspace
            .write_file(&persona.slug, filename, content)?;
        self.connection.execute(
            "UPDATE personas SET updated_at = ?1 WHERE id = ?2",
            params![now, persona_id],
        )?;
        Ok(())
    }

    /// `getPersonaSystemInstruction` from `personaRepository.ts:358-378`.
    ///
    /// Concatenates `--- <file> ---` blocks for the non-empty instruction files
    /// and truncates the result to [`MAX_PERSONA_INSTRUCTION_CHARS`].
    pub fn persona_system_instruction(
        &self,
        persona_id: &str,
    ) -> Result<Option<String>, PersonaRepositoryError> {
        if self.get_persona(persona_id)?.is_none() {
            return Ok(None);
        }

        let mut parts: Vec<String> = Vec::new();
        for filename in PERSONA_INSTRUCTION_FILES {
            let content = self.get_file(persona_id, *filename)?;
            if let Some(text) = content.filter(|text| !text.trim().is_empty()) {
                parts.push(format!("--- {filename} ---\n{}", text.trim()));
            }
        }
        if parts.is_empty() {
            return Ok(None);
        }

        let mut combined = parts.join("\n\n");
        if combined.chars().count() > MAX_PERSONA_INSTRUCTION_CHARS {
            combined = format!(
                "{}\n\n[... truncated]",
                combined
                    .chars()
                    .take(MAX_PERSONA_INSTRUCTION_CHARS)
                    .collect::<String>()
            );
        }
        Ok(Some(combined))
    }

    /// `setAllowedToolFunctionNames` from `personaRepository.ts:386-396`.
    pub fn set_allowed_tool_function_names(
        &self,
        persona_id: &str,
        function_names: &[String],
    ) -> Result<(), PersonaRepositoryError> {
        if self.get_persona(persona_id)?.is_none() {
            return Ok(());
        }
        let now = now_iso();
        let normalized = normalize_allowed_tool_function_names(Some(function_names));
        self.replace_allowed_tool_function_names(persona_id, &normalized, &now)?;
        self.connection.execute(
            "UPDATE personas SET updated_at = ?1 WHERE id = ?2",
            params![now, persona_id],
        )?;
        Ok(())
    }

    // ─── Internals ─────────────────────────────────────────────────────────

    /// Runs `body` inside `BEGIN IMMEDIATE` / `COMMIT`, rolling back on error.
    fn transaction<T>(
        &self,
        body: impl FnOnce(&Connection) -> Result<T, PersonaRepositoryError>,
    ) -> Result<T, PersonaRepositoryError> {
        self.connection
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(PersonaRepositoryError::Database)?;
        match body(&self.connection) {
            Ok(value) => {
                self.connection
                    .execute_batch("COMMIT")
                    .map_err(PersonaRepositoryError::Database)?;
                Ok(value)
            }
            Err(error) => {
                let _ = self.connection.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    /// `resolveUniqueSlugOrThrow` from `personaRepository.ts:398-402`.
    fn resolve_unique_slug_or_throw(&self, name: &str) -> Result<String, PersonaRepositoryError> {
        let slug = slugify_persona_name(name);
        self.assert_unique_persona_slug(&slug, None)?;
        Ok(slug)
    }

    /// `assertUniquePersonaSlug` from `personaRepository.ts:404-411`.
    fn assert_unique_persona_slug(
        &self,
        slug: &str,
        exclude_persona_id: Option<&str>,
    ) -> Result<(), PersonaRepositoryError> {
        let existing: Option<String> = self
            .connection
            .query_row(
                "SELECT id FROM personas WHERE slug = ?1 LIMIT 1",
                params![slug],
                |row| row.get(0),
            )
            .optional()?;
        let Some(existing) = existing else {
            return Ok(());
        };
        if exclude_persona_id == Some(existing.as_str()) {
            return Ok(());
        }
        Err(PersonaRepositoryError::SlugConflict {
            slug: slug.to_string(),
        })
    }

    /// `assertSystemPersonaMutationAllowed` from `personaRepository.ts:444-461`.
    fn assert_system_persona_mutation_allowed(
        &self,
        persona: &PersonaProfile,
        updates: &PersonaUpdate,
    ) -> Result<(), PersonaRepositoryError> {
        if persona.system_persona_key.is_none() {
            return Ok(());
        }
        if updates.name.is_some() {
            return Err(PersonaRepositoryError::SystemPersonaRename);
        }
        Ok(())
    }

    /// `listAllowedToolFunctionNames` from `personaRepository.ts:420-427`.
    fn list_allowed_tool_function_names(
        &self,
        persona_id: &str,
    ) -> Result<Vec<String>, PersonaRepositoryError> {
        let mut statement = self.connection.prepare(
            "SELECT function_name FROM persona_tool_permissions WHERE persona_id = ?1 ORDER BY function_name ASC",
        )?;
        let rows = statement
            .query_map(params![persona_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// `replaceAllowedToolFunctionNames` from `personaRepository.ts:429-442`.
    fn replace_allowed_tool_function_names(
        &self,
        persona_id: &str,
        function_names: &[String],
        now: &str,
    ) -> Result<(), PersonaRepositoryError> {
        self.transaction(|connection| {
            connection.execute(
                "DELETE FROM persona_tool_permissions WHERE persona_id = ?1",
                params![persona_id],
            )?;
            for function_name in function_names {
                connection.execute(
                    "INSERT INTO persona_tool_permissions (persona_id, function_name, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![persona_id, function_name, now, now],
                )?;
            }
            Ok(())
        })
    }

    /// `attachAllowedToolFunctions` from `personaRepository.ts:413-418`.
    fn attach_allowed_tool_functions<T: AllowedToolFunctions>(
        &self,
        mut value: T,
    ) -> Result<T, PersonaRepositoryError> {
        let names = self.list_allowed_tool_function_names(value.allowed_tools_id())?;
        value.set_allowed_tool_function_names(names);
        Ok(value)
    }
}

/// Shared shape of [`PersonaProfile`] and [`PersonaSummary`] for the permission
/// attachment step.
trait AllowedToolFunctions {
    fn allowed_tools_id(&self) -> &str;
    fn set_allowed_tool_function_names(&mut self, names: Vec<String>);
}

impl AllowedToolFunctions for PersonaProfile {
    fn allowed_tools_id(&self) -> &str {
        &self.id
    }

    fn set_allowed_tool_function_names(&mut self, names: Vec<String>) {
        self.allowed_tool_function_names = names;
    }
}

impl AllowedToolFunctions for PersonaSummary {
    fn allowed_tools_id(&self) -> &str {
        &self.id
    }

    fn set_allowed_tool_function_names(&mut self, names: Vec<String>) {
        self.allowed_tool_function_names = names;
    }
}

/// Appends `<column> = ?N` to the dynamic `UPDATE` of `updatePersona`.
fn push_set(
    clauses: &mut Vec<String>,
    values: &mut Vec<Box<dyn rusqlite::ToSql>>,
    column: &str,
    value: Box<dyn rusqlite::ToSql>,
) {
    values.push(value);
    clauses.push(format!("{column} = ?{}", values.len()));
}

/// `normalizeAllowedToolFunctionNames` from `personaRepository.ts:551-556`.
///
/// Trims, drops empties, de-duplicates and sorts. `sort()` is a byte-order
/// comparison where TypeScript uses `localeCompare`; the two agree for the
/// lowercase snake_case identifiers this field holds.
fn normalize_allowed_tool_function_names(function_names: Option<&[String]>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    for name in function_names.unwrap_or_default() {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            seen.insert(trimmed.to_string());
        }
    }
    seen.into_iter().collect()
}

/// The `ALTER TABLE` ladder of `personaRepository.ts:94-130`, in order.
const ADDITIVE_COLUMNS: &[(&str, &str)] = &[
    ("preferred_model_id", "preferred_model_id TEXT"),
    ("model_hub_profile_id", "model_hub_profile_id TEXT"),
    (
        "memory_persona_type",
        "memory_persona_type TEXT NOT NULL DEFAULT 'general'",
    ),
    ("slug", "slug TEXT"),
    ("is_autonomous", "is_autonomous INTEGER NOT NULL DEFAULT 0"),
    (
        "max_tool_calls",
        "max_tool_calls INTEGER NOT NULL DEFAULT 120",
    ),
    ("system_persona_key", "system_persona_key TEXT"),
];

/// `toPersona` row mapper from `personaRepository.ts:30-48`.
fn map_profile_row(row: &rusqlite::Row<'_>) -> Result<PersonaProfile, rusqlite::Error> {
    let name: String = row.get(1)?;
    let slug: Option<String> = row.get("slug")?;
    Ok(PersonaProfile {
        id: row.get("id")?,
        slug: slug
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| slugify_persona_name(&name)),
        name,
        emoji: row.get("emoji")?,
        vibe: row.get("vibe")?,
        system_persona_key: row
            .get::<_, Option<String>>("system_persona_key")?
            .and_then(|raw| SystemPersonaKey::parse(&raw)),
        preferred_model_id: row.get::<_, Option<String>>("preferred_model_id")?,
        model_hub_profile_id: row.get::<_, Option<String>>("model_hub_profile_id")?,
        memory_persona_type: row
            .get::<_, Option<String>>("memory_persona_type")?
            .as_deref()
            .and_then(MemoryPersonaType::parse)
            .unwrap_or(MemoryPersonaType::General),
        is_autonomous: row.get::<_, Option<i64>>("is_autonomous")?.unwrap_or(0) != 0,
        max_tool_calls: row
            .get::<_, Option<i64>>("max_tool_calls")?
            .unwrap_or(DEFAULT_MAX_TOOL_CALLS),
        allowed_tool_function_names: Vec::new(),
        user_id: row.get("user_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// `toSummary` row mapper from `personaRepository.ts:50-66`.
fn map_summary_row(row: &rusqlite::Row<'_>) -> Result<PersonaSummary, rusqlite::Error> {
    let profile = map_profile_row(row)?;
    Ok(PersonaSummary {
        id: profile.id,
        name: profile.name,
        slug: profile.slug,
        emoji: profile.emoji,
        vibe: profile.vibe,
        system_persona_key: profile.system_persona_key,
        preferred_model_id: profile.preferred_model_id,
        model_hub_profile_id: profile.model_hub_profile_id,
        memory_persona_type: profile.memory_persona_type,
        is_autonomous: profile.is_autonomous,
        max_tool_calls: profile.max_tool_calls,
        allowed_tool_function_names: profile.allowed_tool_function_names,
        updated_at: profile.updated_at,
    })
}

/// `new Date().toISOString()`.
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Column value of a `SELECT *` row as JSON, used by diagnostics.
pub fn persona_row_as_json(row: &rusqlite::Row<'_>) -> Result<Value, rusqlite::Error> {
    let statement = row.as_ref();
    let mut map = serde_json::Map::new();
    for index in 0..statement.column_count() {
        let name = statement.column_name(index)?.to_string();
        let value = match row.get_ref(index)? {
            rusqlite::types::ValueRef::Null => Value::Null,
            rusqlite::types::ValueRef::Integer(number) => Value::from(number),
            rusqlite::types::ValueRef::Real(number) => Value::from(number),
            rusqlite::types::ValueRef::Text(bytes) => {
                Value::from(String::from_utf8_lossy(bytes).into_owned())
            }
            rusqlite::types::ValueRef::Blob(bytes) => {
                Value::from(String::from_utf8_lossy(bytes).into_owned())
            }
        };
        map.insert(name, value);
    }
    Ok(Value::Object(map))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::personas::workspace::PersonaWorkspace;

    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new() -> Self {
            let unique = uuid::Uuid::new_v4().simple().to_string();
            let path = std::env::temp_dir().join(format!("betaclaw-personas-repo-{unique}"));
            std::fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }

        fn db_path(&self) -> String {
            self.0.join("personas.db").to_string_lossy().into_owned()
        }

        fn workspace(&self) -> PersonaWorkspace {
            PersonaWorkspace::new(self.0.join("personas"))
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn open_repo(dir: &TempDir) -> PersonaRepository {
        PersonaRepository::open_with_workspace(&dir.db_path(), dir.workspace())
            .expect("open persona repository")
    }

    fn input(name: &str) -> CreatePersonaInput {
        CreatePersonaInput {
            name: name.to_string(),
            emoji: "🤖".to_string(),
            vibe: String::new(),
            user_id: "user-1".to_string(),
            ..Default::default()
        }
    }

    // ─── Anlegen ───────────────────────────────────────────────────────────

    #[test]
    fn creates_a_persona_and_all_six_files() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);

        let persona = repo.create_persona(&input("Ada Lovelace")).expect("create");
        assert_eq!(persona.slug, "ada_lovelace");
        assert_eq!(persona.memory_persona_type, MemoryPersonaType::General);
        assert_eq!(persona.max_tool_calls, DEFAULT_MAX_TOOL_CALLS);
        assert!(!persona.is_autonomous);
        assert_eq!(persona.system_persona_key, None);
        assert_eq!(persona.user_id, "user-1");
        assert!(persona.created_at.ends_with('Z'));

        let with_files = repo
            .get_persona_with_files(&persona.id)
            .expect("read")
            .expect("persona exists");
        let names: Vec<&str> = with_files.files.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "SOUL.md",
                "IDENTITY.md",
                "AGENTS.md",
                "USER.md",
                "TOOLS.md",
                "HEARTBEAT.md"
            ]
        );
        assert!(with_files
            .files
            .iter()
            .all(|(_, content)| content.is_empty()));
    }

    #[test]
    fn create_seeds_supplied_file_contents() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let mut create = input("Grace Hopper");
        create.files = Some(vec![("SOUL.md".into(), "I compile.".into())]);

        let persona = repo.create_persona(&create).expect("create");
        assert_eq!(
            repo.get_file(&persona.id, PersonaFileName::Soul)
                .expect("read")
                .as_deref(),
            Some("I compile.")
        );
    }

    #[test]
    fn duplicate_slugs_are_rejected() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        repo.create_persona(&input("Ada Lovelace")).expect("create");

        match repo.create_persona(&input("ada  lovelace!")) {
            Err(PersonaRepositoryError::SlugConflict { slug }) => assert_eq!(slug, "ada_lovelace"),
            other => panic!("expected a slug conflict, got {other:?}"),
        }
    }

    #[test]
    fn allowed_tool_functions_are_normalised_and_attached() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let mut create = input("Ada");
        create.allowed_tool_function_names = Some(vec![
            " shell ".into(),
            "read".into(),
            "shell".into(),
            "   ".into(),
        ]);

        let persona = repo.create_persona(&create).expect("create");
        assert_eq!(persona.allowed_tool_function_names, vec!["read", "shell"]);
    }

    // ─── Lesen ─────────────────────────────────────────────────────────────

    #[test]
    fn lists_per_user_newest_first() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        repo.create_persona(&input("Ada")).expect("create");
        let mut other = input("Grace");
        other.user_id = "user-2".into();
        repo.create_persona(&other).expect("create");

        let mine = repo.list_personas("user-1").expect("list");
        assert_eq!(mine.len(), 1);
        assert_eq!(mine[0].name, "Ada");
        assert_eq!(repo.list_all_personas().expect("list all").len(), 2);
    }

    #[test]
    fn returns_none_for_unknown_ids() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        assert!(repo.get_persona("nope").expect("get").is_none());
        assert!(repo.get_persona_with_files("nope").expect("get").is_none());
        assert!(repo
            .get_file("nope", PersonaFileName::Soul)
            .expect("get")
            .is_none());
        assert!(!repo.delete_persona("nope").expect("delete"));
    }

    #[test]
    fn system_personas_are_found_by_key() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let mut create = input("Master");
        create.system_persona_key = Some(SystemPersonaKey::Master);
        let persona = repo.create_persona(&create).expect("create");

        let found = repo
            .get_system_persona("user-1", SystemPersonaKey::Master)
            .expect("get")
            .expect("found");
        assert_eq!(found.id, persona.id);
    }

    // ─── Aktualisieren ─────────────────────────────────────────────────────

    #[test]
    fn updates_scalars_and_touches_updated_at() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let persona = repo.create_persona(&input("Ada")).expect("create");

        let update = PersonaUpdate {
            emoji: Some("🧠".into()),
            vibe: Some("analytical".into()),
            is_autonomous: Some(true),
            max_tool_calls: Some(9999),
            memory_persona_type: Some(MemoryPersonaType::Builder),
            ..Default::default()
        };
        assert!(repo.update_persona(&persona.id, &update).expect("update"));

        let updated = repo.get_persona(&persona.id).expect("get").unwrap();
        assert_eq!(updated.emoji, "🧠");
        assert_eq!(updated.vibe, "analytical");
        assert!(updated.is_autonomous);
        assert_eq!(updated.max_tool_calls, 500, "clamped to the upper bound");
        assert_eq!(updated.memory_persona_type, MemoryPersonaType::Builder);
    }

    #[test]
    fn max_tool_calls_is_clamped_at_both_ends() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let persona = repo.create_persona(&input("Ada")).expect("create");

        for (input_value, expected) in [(0, 3), (1, 3), (42, 42), (10_000, 500)] {
            repo.update_persona(
                &persona.id,
                &PersonaUpdate {
                    max_tool_calls: Some(input_value),
                    ..Default::default()
                },
            )
            .expect("update");
            assert_eq!(
                repo.get_persona(&persona.id)
                    .expect("get")
                    .unwrap()
                    .max_tool_calls,
                expected
            );
        }
    }

    #[test]
    fn renaming_moves_the_slug_and_the_workspace() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let persona = repo.create_persona(&input("Ada")).expect("create");
        repo.save_file(&persona.id, PersonaFileName::Soul, "soul")
            .expect("seed");

        repo.update_persona(
            &persona.id,
            &PersonaUpdate {
                name: Some("Ada Lovelace".into()),
                ..Default::default()
            },
        )
        .expect("rename");

        let updated = repo.get_persona(&persona.id).expect("get").unwrap();
        assert_eq!(updated.slug, "ada_lovelace");
        assert_eq!(
            repo.get_file(&persona.id, PersonaFileName::Soul)
                .expect("read")
                .as_deref(),
            Some("soul"),
            "the workspace follows the slug"
        );
        assert!(
            !repo
                .workspace()
                .resolve(&["ada"])
                .expect("resolve")
                .exists(),
            "the old directory is gone"
        );
    }

    #[test]
    fn renaming_onto_an_existing_slug_is_rejected() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        repo.create_persona(&input("Ada")).expect("create a");
        let grace = repo.create_persona(&input("Grace")).expect("create b");

        match repo.update_persona(
            &grace.id,
            &PersonaUpdate {
                name: Some("Ada".into()),
                ..Default::default()
            },
        ) {
            Err(PersonaRepositoryError::SlugConflict { slug }) => assert_eq!(slug, "ada"),
            other => panic!("expected a slug conflict, got {other:?}"),
        }
    }

    #[test]
    fn null_and_absent_model_ids_are_distinguished() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let mut create = input("Ada");
        create.preferred_model_id = Some("gemini-3-pro-preview".into());
        let persona = repo.create_persona(&create).expect("create");

        repo.update_persona(
            &persona.id,
            &PersonaUpdate {
                preferred_model_id: Some(None),
                ..Default::default()
            },
        )
        .expect("clear");
        assert_eq!(
            repo.get_persona(&persona.id)
                .expect("get")
                .unwrap()
                .preferred_model_id,
            None
        );

        repo.update_persona(
            &persona.id,
            &PersonaUpdate {
                model_hub_profile_id: Some(Some("profile-1".into())),
                ..Default::default()
            },
        )
        .expect("set");
        assert_eq!(
            repo.get_persona(&persona.id)
                .expect("get")
                .unwrap()
                .model_hub_profile_id
                .as_deref(),
            Some("profile-1")
        );
    }

    #[test]
    fn updating_an_unknown_persona_reports_false() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        assert!(!repo
            .update_persona(
                "nope",
                &PersonaUpdate {
                    emoji: Some("x".into()),
                    ..Default::default()
                }
            )
            .expect("update"));
    }

    #[test]
    fn system_personas_cannot_be_renamed_or_deleted() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let mut create = input("Master");
        create.system_persona_key = Some(SystemPersonaKey::Master);
        let persona = repo.create_persona(&create).expect("create");

        assert!(matches!(
            repo.update_persona(
                &persona.id,
                &PersonaUpdate {
                    name: Some("Renamed".into()),
                    ..Default::default()
                }
            ),
            Err(PersonaRepositoryError::SystemPersonaRename)
        ));
        assert!(matches!(
            repo.delete_persona(&persona.id),
            Err(PersonaRepositoryError::SystemPersonaDelete)
        ));
    }

    #[test]
    fn delete_removes_the_row_and_the_workspace() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let persona = repo.create_persona(&input("Ada")).expect("create");
        let slug = persona.slug.clone();

        assert!(repo.delete_persona(&persona.id).expect("delete"));
        assert!(repo.get_persona(&persona.id).expect("get").is_none());
        assert!(!repo
            .workspace()
            .resolve(&[slug.as_str()])
            .expect("resolve")
            .exists());
    }

    // ─── System instruction ────────────────────────────────────────────────

    #[test]
    fn composes_the_system_instruction_from_three_files() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let persona = repo.create_persona(&input("Ada")).expect("create");

        assert_eq!(
            repo.persona_system_instruction(&persona.id).expect("read"),
            None,
            "an empty persona yields no instruction"
        );

        repo.save_file(&persona.id, PersonaFileName::Soul, " be helpful ")
            .expect("save");
        repo.save_file(&persona.id, PersonaFileName::User, "call me Ada")
            .expect("save");
        repo.save_file(&persona.id, PersonaFileName::Tools, "ignored")
            .expect("save");

        let instruction = repo
            .persona_system_instruction(&persona.id)
            .expect("read")
            .expect("instruction");
        assert_eq!(
            instruction,
            "--- SOUL.md ---\nbe helpful\n\n--- USER.md ---\ncall me Ada"
        );
    }

    #[test]
    fn truncates_an_over_long_instruction() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let persona = repo.create_persona(&input("Ada")).expect("create");
        let long_soul = "x".repeat(5000);
        repo.save_file(&persona.id, PersonaFileName::Soul, long_soul.as_str())
            .expect("save");

        let instruction = repo
            .persona_system_instruction(&persona.id)
            .expect("read")
            .expect("instruction");
        assert!(instruction.ends_with("\n\n[... truncated]"));
        let body = instruction.trim_end_matches("\n\n[... truncated]");
        assert_eq!(body.chars().count(), MAX_PERSONA_INSTRUCTION_CHARS);
    }

    #[test]
    fn saving_a_file_touches_the_parent() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let persona = repo.create_persona(&input("Ada")).expect("create");
        let before = repo
            .get_persona(&persona.id)
            .expect("get")
            .unwrap()
            .updated_at;

        std::thread::sleep(std::time::Duration::from_millis(5));
        repo.save_file(&persona.id, PersonaFileName::Soul, "hi")
            .expect("save");

        assert_ne!(
            repo.get_persona(&persona.id)
                .expect("get")
                .unwrap()
                .updated_at,
            before
        );
    }

    // ─── Migration freshness and missing DB ────────────────────────────────

    #[test]
    fn missing_db_is_created_with_the_full_schema() {
        let dir = TempDir::new();
        let path = dir.db_path();
        assert!(
            !std::path::Path::new(&path).exists(),
            "the file starts absent"
        );

        let repo = open_repo(&dir);
        assert!(std::path::Path::new(&path).exists());
        assert!(repo.list_all_personas().expect("list").is_empty());

        let connection = repo.connection;
        let tables: Vec<String> = connection
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .expect("prepare")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query")
            .collect::<Result<Vec<_>, _>>()
            .expect("rows");
        assert_eq!(tables, vec!["persona_tool_permissions", "personas"]);
    }

    #[test]
    fn migration_adds_every_additive_column() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);

        let connection = repo.connection;
        let mut statement = connection
            .prepare("PRAGMA table_info(personas)")
            .expect("prepare");
        let columns: Vec<String> = statement
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query")
            .collect::<Result<Vec<_>, _>>()
            .expect("rows");

        for expected in [
            "id",
            "name",
            "emoji",
            "vibe",
            "system_persona_key",
            "preferred_model_id",
            "model_hub_profile_id",
            "user_id",
            "created_at",
            "updated_at",
            "memory_persona_type",
            "slug",
            "is_autonomous",
            "max_tool_calls",
        ] {
            assert!(
                columns.contains(&expected.to_string()),
                "missing column {expected}"
            );
        }
        assert_eq!(columns.len(), 14, "no duplicate ALTER steps ran");
    }

    #[test]
    fn migration_is_fresh_on_repeated_opens() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let persona = repo.create_persona(&input("Ada")).expect("create");
        repo.close();

        let reopened = open_repo(&dir);
        assert_eq!(
            reopened
                .get_persona(&persona.id)
                .expect("get")
                .map(|p| p.slug),
            Some("ada".to_string())
        );
        assert_eq!(reopened.list_all_personas().expect("list").len(), 1);
    }

    #[test]
    fn migration_backfills_missing_slugs_and_workspaces() {
        let dir = TempDir::new();
        let path = dir.db_path();
        {
            let connection = open(OpenOptions::new(&path)).expect("open");
            connection
                .execute_batch(
                    "CREATE TABLE personas (
                       id TEXT PRIMARY KEY, name TEXT NOT NULL, emoji TEXT NOT NULL,
                       vibe TEXT NOT NULL, system_persona_key TEXT, preferred_model_id TEXT,
                       model_hub_profile_id TEXT, user_id TEXT NOT NULL,
                       created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                     );
                     INSERT INTO personas VALUES
                       ('p1', 'Ada', '🤖', '', NULL, NULL, NULL, 'u', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
                       ('p2', 'Ada', '🤖', '', NULL, NULL, NULL, 'u', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');",
                )
                .expect("seed legacy table");
        }

        let repo = open_repo(&dir);
        let personas = repo.list_all_personas().expect("list");
        assert_eq!(personas.len(), 2);
        let slugs: BTreeSet<&str> = personas.iter().map(|p| p.slug.as_str()).collect();
        assert_eq!(
            slugs,
            BTreeSet::from(["ada", "ada_2"]),
            "collisions get a numeric suffix"
        );
        for persona in &personas {
            assert!(repo
                .workspace()
                .resolve(&[persona.slug.as_str()])
                .expect("resolve")
                .is_dir());
        }
    }

    #[test]
    fn migration_drains_the_legacy_persona_files_table() {
        let dir = TempDir::new();
        let path = dir.db_path();
        {
            let connection = open(OpenOptions::new(&path)).expect("open");
            connection
                .execute_batch(
                    "CREATE TABLE personas (
                       id TEXT PRIMARY KEY, name TEXT NOT NULL, emoji TEXT NOT NULL,
                       vibe TEXT NOT NULL, system_persona_key TEXT, preferred_model_id TEXT,
                       model_hub_profile_id TEXT, user_id TEXT NOT NULL,
                       created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                       slug TEXT, memory_persona_type TEXT NOT NULL DEFAULT 'general',
                       is_autonomous INTEGER NOT NULL DEFAULT 0,
                       max_tool_calls INTEGER NOT NULL DEFAULT 120
                     );
                     INSERT INTO personas VALUES
                       ('p1', 'Ada', '🤖', '', NULL, NULL, NULL, 'u', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'ada', 'general', 0, 120);
                     CREATE TABLE persona_files (persona_id TEXT, filename TEXT, content TEXT);
                     INSERT INTO persona_files VALUES ('p1', 'SOUL.md', 'legacy soul');
                     INSERT INTO persona_files VALUES ('p1', 'README.md', 'unknown file');",
                )
                .expect("seed legacy tables");
        }

        let repo = open_repo(&dir);
        assert_eq!(
            repo.get_file("p1", PersonaFileName::Soul)
                .expect("read")
                .as_deref(),
            Some("legacy soul")
        );
        let connection = repo.connection;
        let legacy_tables: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='persona_files'",
                [],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(legacy_tables, 0, "the legacy table is dropped");
    }

    #[test]
    fn pragmas_come_from_the_shared_opener() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let connection = repo.connection;
        let busy_timeout: i64 = connection
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .expect("busy_timeout");
        assert_eq!(busy_timeout, 30_000);
        let foreign_keys: i64 = connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .expect("foreign_keys");
        assert_eq!(foreign_keys, 1);
        let journal_mode: String = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .expect("journal_mode");
        assert_eq!(journal_mode, "wal");
    }

    #[test]
    fn set_allowed_tool_function_names_replaces_and_sorts() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let persona = repo.create_persona(&input("Ada")).expect("create");

        repo.set_allowed_tool_function_names(&persona.id, &["write".into(), "read".into()])
            .expect("set");
        repo.set_allowed_tool_function_names(&persona.id, &["Execute".into()])
            .expect("replace");

        assert_eq!(
            repo.get_persona(&persona.id)
                .expect("get")
                .unwrap()
                .allowed_tool_function_names,
            vec!["Execute"]
        );
    }

    #[test]
    fn allowed_tool_functions_sort_in_byte_order() {
        assert_eq!(
            normalize_allowed_tool_function_names(Some(&[
                "b".into(),
                "A".into(),
                " a ".into(),
                String::new()
            ])),
            vec!["A".to_string(), "a".to_string(), "b".to_string()]
        );
        assert!(normalize_allowed_tool_function_names(None).is_empty());
    }

    #[test]
    fn row_helper_produces_json_for_diagnostics() {
        let dir = TempDir::new();
        let repo = open_repo(&dir);
        let persona = repo.create_persona(&input("Ada")).expect("create");
        let connection = repo.connection;
        let mut statement = connection
            .prepare("SELECT * FROM personas WHERE id = ?1")
            .expect("prepare");
        let mut rows = statement.query(params![persona.id]).expect("query");
        let row = rows.next().expect("one row").expect("row");
        let json = persona_row_as_json(row).expect("json");
        assert_eq!(json["slug"], "ada");
        assert_eq!(json["is_autonomous"], 0);
    }
}
