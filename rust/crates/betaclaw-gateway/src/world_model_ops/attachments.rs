//! `betaclaw-scheduler attachments-consistency [--repair] [--repair-prune-missing]
//! [--repair-normalize-buckets] [--json]` replaces `pnpm run attachments:consistency`
//! (`scripts/attachments-consistency.ts` and `src/server/channels/messages/attachmentConsistency.ts`).
//!
//! It walks the attachments of every stored message and checks that the file exists
//! and sits in the bucket its MIME type expects (`images` or `docs`) inside the persona
//! workspace. The repair flags prune entries of missing files and move files into the
//! expected bucket; they rewrite the `metadata` of the message, as the audit does.
//!
//! Paths come from `MESSAGES_DB_PATH`, `PERSONAS_DB_PATH`, `CHAT_ATTACHMENTS_DIR` and
//! `PERSONAS_ROOT_PATH`, as in the TypeScript.

use std::path::{Path, PathBuf};

use betaclaw_core::channels::messages::attachments::extract_stored_attachments_from_metadata;
use betaclaw_core::model_hub::types::GatewayMessageAttachment;
use betaclaw_core::personas::workspace::{
    is_persona_scoped_storage_path, resolve_attachment_bucket_by_mime,
    resolve_persona_scoped_storage_path, PersonaWorkspace,
};
use rusqlite::Connection;
use serde_json::{json, Map, Value};

use super::{env_or, messages_db_path};

/// `DEFAULT_ATTACHMENT_ROOT` of the TypeScript (`.local/uploads/chat`).
const DEFAULT_ATTACHMENT_ROOT: &str = ".local/uploads/chat";

/// The flags (`parseArgs`, `attachments-consistency.ts:15-40`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AuditOptions {
    pub repair_prune_missing: bool,
    pub repair_normalize_persona_buckets: bool,
    pub json: bool,
}

/// `--repair` means both repairs; unknown arguments are ignored, as in the script.
pub fn parse_args(args: &[String]) -> AuditOptions {
    let mut options = AuditOptions::default();
    for arg in args {
        match arg.as_str() {
            "--repair" => {
                options.repair_prune_missing = true;
                options.repair_normalize_persona_buckets = true;
            }
            "--repair-prune-missing" => options.repair_prune_missing = true,
            "--repair-normalize-buckets" => options.repair_normalize_persona_buckets = true,
            "--json" => options.json = true,
            _ => {}
        }
    }
    options
}

/// `AttachmentConsistencyReport` (`attachmentConsistency.ts:23-31`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AuditReport {
    pub scanned_messages: i64,
    pub scanned_attachments: i64,
    pub missing_files: i64,
    pub bucket_mismatches: i64,
    pub repaired_missing_pruned: i64,
    pub repaired_bucket_moves: i64,
    pub updated_messages: i64,
}

impl AuditReport {
    fn json(&self) -> Value {
        json!({
            "scannedMessages": self.scanned_messages,
            "scannedAttachments": self.scanned_attachments,
            "missingFiles": self.missing_files,
            "bucketMismatches": self.bucket_mismatches,
            "repairedMissingPruned": self.repaired_missing_pruned,
            "repairedBucketMoves": self.repaired_bucket_moves,
            "updatedMessages": self.updated_messages,
        })
    }
}

/// The locations an audit reads and writes.
#[derive(Debug, Clone)]
pub struct AuditPaths {
    pub messages_db: String,
    pub personas_db: String,
    pub attachment_root: PathBuf,
    pub persona_workspace: PersonaWorkspace,
}

impl AuditPaths {
    /// The paths of the process environment, as the script resolves them.
    pub fn from_env() -> Self {
        let root = std::env::var("CHAT_ATTACHMENTS_DIR")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| DEFAULT_ATTACHMENT_ROOT.to_string());
        Self {
            messages_db: messages_db_path(),
            personas_db: env_or("PERSONAS_DB_PATH", ".local/personas.db"),
            attachment_root: absolute(Path::new(&root)),
            persona_workspace: PersonaWorkspace::from_env(),
        }
    }
}

/// `path.normalize`: drops `.` and resolves `..` against the preceding component, without
/// touching the file system.
pub fn lexical_normalize(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push(component.as_os_str());
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn absolute(path: &Path) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
}

/// `resolveStoredAttachmentPath` (`attachments.ts:175-190`): absolute paths stay, persona
/// paths go to the persona workspace, others are joined to the attachment root and must
/// stay inside it.
pub fn resolve_stored_attachment_path(
    attachment_root: &Path,
    persona_workspace: &PersonaWorkspace,
    storage_path: &str,
) -> Result<PathBuf, String> {
    let normalized = storage_path.trim();
    if normalized.is_empty() {
        return Err("Attachment storage path is empty.".to_string());
    }
    if Path::new(normalized).is_absolute() {
        return Ok(lexical_normalize(Path::new(normalized)));
    }
    if is_persona_scoped_storage_path(normalized) {
        return resolve_persona_scoped_storage_path(persona_workspace, normalized)
            .map_err(|error| error.to_string());
    }
    // `path.resolve` removes `..` before the containment check; std::path::absolute does not.
    let resolved = lexical_normalize(&attachment_root.join(normalized));
    if resolved != attachment_root && !resolved.starts_with(attachment_root) {
        return Err("Attachment path is outside of configured storage root.".to_string());
    }
    Ok(resolved)
}

/// `runAttachmentConsistencyAudit(options)` with the paths of the environment.
pub fn run_audit(options: &AuditOptions) -> Result<AuditReport, String> {
    audit(options, &AuditPaths::from_env())
}

/// `runAttachmentConsistencyAudit` (`attachmentConsistency.ts:33-118`).
pub fn audit(options: &AuditOptions, paths: &AuditPaths) -> Result<AuditReport, String> {
    let mut report = AuditReport::default();
    let persona_slugs = load_persona_slugs(&paths.personas_db)?;
    let connection = Connection::open(&paths.messages_db).map_err(|error| error.to_string())?;

    let rows: Vec<(String, String, Option<String>)> = {
        let mut statement = connection
            .prepare(
                "SELECT m.id AS message_id, m.metadata, c.persona_id
                 FROM messages m
                 JOIN conversations c ON c.id = m.conversation_id
                 WHERE m.metadata IS NOT NULL AND m.metadata != ''
                 ORDER BY m.created_at ASC",
            )
            .map_err(|error| error.to_string())?;
        let mapped = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    report.scanned_messages = rows.len() as i64;

    for (message_id, metadata, persona_id) in rows {
        let attachments = extract_stored_attachments_from_metadata(Some(&metadata));
        if attachments.is_empty() {
            continue;
        }
        let persona_slug = persona_id
            .as_ref()
            .and_then(|id| persona_slugs.iter().find(|(key, _)| key == id))
            .map(|(_, slug)| slug.clone());
        let mut changed = false;
        let mut next_attachments: Vec<GatewayMessageAttachment> = Vec::new();

        for attachment in attachments {
            report.scanned_attachments += 1;
            let absolute_path = resolve_if_exists(paths, &attachment.storage_path);
            if absolute_path.is_none() {
                report.missing_files += 1;
                if options.repair_prune_missing {
                    report.repaired_missing_pruned += 1;
                    changed = true;
                    continue;
                }
            }
            let normalized = attachment.storage_path.replace('\\', "/");
            if let Some(slug) = &persona_slug {
                if normalized.starts_with("personas/") {
                    match (&absolute_path, options.repair_normalize_persona_buckets) {
                        (Some(absolute_path), true) => {
                            if let Some(moved) =
                                normalize_persona_bucket(paths, &attachment, slug, absolute_path)?
                            {
                                report.bucket_mismatches += 1;
                                report.repaired_bucket_moves += 1;
                                changed = true;
                                next_attachments.push(moved);
                                continue;
                            }
                        }
                        _ => {
                            if is_persona_bucket_mismatch(&normalized, &attachment.mime_type, slug)
                            {
                                report.bucket_mismatches += 1;
                            }
                        }
                    }
                }
            }
            next_attachments.push(attachment);
        }

        if !changed {
            continue;
        }
        // `{ ...parsedMetadata, attachments }`: the other keys keep their order.
        let mut object = match serde_json::from_str::<Value>(&metadata) {
            Ok(Value::Object(map)) => map,
            _ => Map::new(),
        };
        object.insert(
            "attachments".to_string(),
            serde_json::to_value(&next_attachments).map_err(|error| error.to_string())?,
        );
        connection
            .execute(
                "UPDATE messages SET metadata = ? WHERE id = ?",
                rusqlite::params![Value::Object(object).to_string(), message_id],
            )
            .map_err(|error| error.to_string())?;
        report.updated_messages += 1;
    }
    Ok(report)
}

/// `loadPersonaSlugMap` (`attachmentConsistency.ts:120-138`): `(id, slug)` pairs with a
/// non-empty slug. A missing personas.db yields none.
fn load_persona_slugs(path: &str) -> Result<Vec<(String, String)>, String> {
    if !Path::new(path).exists() {
        return Ok(Vec::new());
    }
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare("SELECT id, slug FROM personas")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(id, slug)| (id, slug.trim().to_string()))
        .filter(|(_, slug)| !slug.is_empty())
        .collect())
}

/// `resolveIfExists` (`attachmentConsistency.ts:150-160`).
fn resolve_if_exists(paths: &AuditPaths, storage_path: &str) -> Option<PathBuf> {
    let resolved = resolve_stored_attachment_path(
        &paths.attachment_root,
        &paths.persona_workspace,
        storage_path,
    )
    .ok()?;
    resolved.exists().then_some(resolved)
}

/// `isPersonaBucketMismatch` (`attachmentConsistency.ts:162-176`).
fn is_persona_bucket_mismatch(storage_path: &str, mime_type: &str, slug: &str) -> bool {
    let parts: Vec<&str> = storage_path.split('/').collect();
    if parts.len() < 6 || parts[0] != "personas" || parts[1] != slug || parts[2] != "uploads" {
        return false;
    }
    parts[3] != resolve_attachment_bucket_by_mime(mime_type)
}

/// `normalizePersonaBucketIfNeeded` (`attachmentConsistency.ts:178-212`). Returns the
/// attachment with its new path when the file was moved, `None` when nothing changed.
fn normalize_persona_bucket(
    paths: &AuditPaths,
    attachment: &GatewayMessageAttachment,
    slug: &str,
    absolute_path: &Path,
) -> Result<Option<GatewayMessageAttachment>, String> {
    let normalized = attachment.storage_path.replace('\\', "/");
    let mut parts: Vec<String> = normalized.split('/').map(str::to_string).collect();
    if parts.len() < 6 || parts[0] != "personas" || parts[1] != slug || parts[2] != "uploads" {
        return Ok(None);
    }
    let expected = resolve_attachment_bucket_by_mime(&attachment.mime_type);
    if parts[3] == expected {
        return Ok(None);
    }
    parts[3] = expected.to_string();
    let next_storage_path = parts.join("/");
    let next_absolute =
        resolve_persona_scoped_storage_path(&paths.persona_workspace, &next_storage_path)
            .map_err(|error| error.to_string())?;
    if let Some(parent) = next_absolute.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    move_file(absolute_path, &next_absolute)?;
    Ok(Some(GatewayMessageAttachment {
        storage_path: next_storage_path,
        ..attachment.clone()
    }))
}

/// `moveFile` (`attachmentConsistency.ts:214-227`): rename, or copy and remove across
/// devices.
fn move_file(source: &Path, target: &Path) -> Result<(), String> {
    if source == target {
        return Ok(());
    }
    match std::fs::rename(source, target) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::CrossesDevices => {
            std::fs::copy(source, target).map_err(|error| error.to_string())?;
            std::fs::remove_file(source).map_err(|error| error.to_string())
        }
        Err(error) => Err(error.to_string()),
    }
}

/// The text report of the script.
pub fn report_lines(report: &AuditReport) -> Vec<String> {
    vec![
        "[attachments-consistency]".to_string(),
        format!("  scannedMessages: {}", report.scanned_messages),
        format!("  scannedAttachments: {}", report.scanned_attachments),
        format!("  missingFiles: {}", report.missing_files),
        format!("  bucketMismatches: {}", report.bucket_mismatches),
        format!(
            "  repairedMissingPruned: {}",
            report.repaired_missing_pruned
        ),
        format!("  repairedBucketMoves: {}", report.repaired_bucket_moves),
        format!("  updatedMessages: {}", report.updated_messages),
    ]
}

/// The JSON of `console.log(JSON.stringify({ options, report }, null, 2))`.
pub fn output_json(options: &AuditOptions, report: &AuditReport) -> Value {
    json!({
        "options": {
            "repairPruneMissing": options.repair_prune_missing,
            "repairNormalizePersonaBuckets": options.repair_normalize_persona_buckets,
            "json": options.json,
        },
        "report": report.json(),
    })
}

/// Runs the audit and prints the report. Returns the exit status.
pub async fn run(args: &[String]) -> i32 {
    let options = parse_args(args);
    match run_audit(&options) {
        Ok(report) => {
            if options.json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&output_json(&options, &report))
                        .unwrap_or_default()
                );
            } else {
                for line in report_lines(&report) {
                    println!("{line}");
                }
            }
            0
        }
        Err(message) => {
            eprintln!("{message}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn repair_switches_both_repairs_and_unknown_flags_are_ignored() {
        assert_eq!(
            parse_args(&args(&["--repair", "--json", "--other"])),
            AuditOptions {
                repair_prune_missing: true,
                repair_normalize_persona_buckets: true,
                json: true,
            }
        );
        let only = parse_args(&args(&["--repair-normalize-buckets"]));
        assert!(!only.repair_prune_missing && only.repair_normalize_persona_buckets);
    }

    #[test]
    fn a_bucket_mismatch_is_an_image_in_docs_or_a_document_in_images() {
        let image_in_docs = "personas/ada/uploads/docs/a/pic.png";
        assert!(is_persona_bucket_mismatch(
            image_in_docs,
            "image/png",
            "ada"
        ));
        assert!(!is_persona_bucket_mismatch(
            image_in_docs,
            "application/pdf",
            "ada"
        ));
        assert!(!is_persona_bucket_mismatch(
            "personas/bob/uploads/docs/a/x",
            "image/png",
            "ada"
        ));
        assert!(!is_persona_bucket_mismatch(
            "personas/ada/uploads/docs",
            "image/png",
            "ada"
        ));
    }

    #[test]
    fn a_relative_path_must_stay_inside_the_root() {
        let root = std::env::temp_dir().join("attachment-root-test");
        let workspace = PersonaWorkspace::new(root.join("personas"));
        let inside =
            resolve_stored_attachment_path(&root, &workspace, "chat/a.txt").expect("inside");
        assert!(inside.starts_with(&root));
        let outside = resolve_stored_attachment_path(&root, &workspace, "../escape.txt");
        assert_eq!(
            outside.unwrap_err(),
            "Attachment path is outside of configured storage root."
        );
        assert!(resolve_stored_attachment_path(&root, &workspace, "  ").is_err());
    }

    #[test]
    fn the_audit_prunes_missing_files_and_reports_them() {
        let directory =
            std::env::temp_dir().join(format!("attachments-audit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(directory.join("root")).expect("root");
        let db = directory.join("messages.db");
        let connection = Connection::open(&db).expect("db");
        connection
            .execute_batch(
                "CREATE TABLE conversations (id TEXT PRIMARY KEY, persona_id TEXT);
                 CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, created_at TEXT, metadata TEXT);
                 INSERT INTO conversations VALUES ('c1', NULL);
                 INSERT INTO messages VALUES ('m1', 'c1', '2026-01-01', '{\"note\":1,\"attachments\":[{\"name\":\"gone.txt\",\"mimeType\":\"text/plain\",\"size\":3,\"storagePath\":\"chat/gone.txt\"}]}');",
            )
            .expect("schema");
        drop(connection);
        let paths = AuditPaths {
            messages_db: db.to_string_lossy().to_string(),
            personas_db: directory.join("none.db").to_string_lossy().to_string(),
            attachment_root: directory.join("root"),
            persona_workspace: PersonaWorkspace::new(directory.join("personas")),
        };
        let options = AuditOptions {
            repair_prune_missing: true,
            ..AuditOptions::default()
        };
        let report = audit(&options, &paths).expect("audit");
        assert_eq!(report.scanned_messages, 1);
        assert_eq!(report.missing_files, 1);
        assert_eq!(report.repaired_missing_pruned, 1);
        assert_eq!(report.updated_messages, 1);
        let metadata: String = Connection::open(&db)
            .expect("reopen")
            .query_row("SELECT metadata FROM messages WHERE id = 'm1'", [], |row| {
                row.get(0)
            })
            .expect("row");
        let parsed: Value = serde_json::from_str(&metadata).expect("json");
        assert_eq!(parsed["note"], 1, "other metadata keys are kept");
        assert_eq!(parsed["attachments"], json!([]));
        let _ = std::fs::remove_dir_all(&directory);
    }
}
