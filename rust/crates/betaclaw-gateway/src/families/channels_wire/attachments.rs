//! Port of `src/server/channels/messages/attachments.ts`: chat attachments as data
//! URLs in, files on disk, and `{ name, mimeType, size, storagePath, sha256 }`
//! records in the message metadata.
//!
//! Files go to `CHAT_ATTACHMENTS_DIR` (default `.local/uploads/chat`), or to the
//! persona workspace when the conversation has a persona. Stored paths are
//! relative, so the root can move. A path that escapes the root is refused.

use std::path::{Component, Path, PathBuf};

use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use betaclaw_core::personas::workspace::{
    create_persona_attachment_storage_path, is_persona_scoped_storage_path,
    resolve_persona_scoped_storage_path,
};
use betaclaw_core::personas::PersonaWorkspace;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// `MAX_ATTACHMENT_BYTES` in `attachments.ts`.
pub const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
const DEFAULT_ATTACHMENT_ROOT: &str = ".local/uploads/chat";

/// `ALLOWED_MIME_TYPES` with their extensions (`EXTENSION_BY_MIME_TYPE`).
const ALLOWED_MIME_TYPES: [(&str, &str); 12] = [
    ("image/png", "png"),
    ("image/jpeg", "jpg"),
    ("image/gif", "gif"),
    ("image/webp", "webp"),
    ("image/svg+xml", "svg"),
    ("application/pdf", "pdf"),
    ("text/plain", "txt"),
    ("text/csv", "csv"),
    ("text/markdown", "md"),
    ("application/json", "json"),
    ("application/msword", "doc"),
    (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "docx",
    ),
];

/// `IncomingMessageAttachmentPayload`. `size` is the declared size; the route
/// passes 0 when the client sent no number, which then fails the size check, as
/// it does in TypeScript.
#[derive(Debug, Clone)]
pub struct IncomingAttachment {
    pub name: String,
    pub mime_type: String,
    pub size: u64,
    pub data_url: String,
}

/// `StoredMessageAttachment`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAttachment {
    pub name: String,
    pub mime_type: String,
    pub size: u64,
    pub storage_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

/// The attachment files of one gateway.
pub struct AttachmentStore {
    root: PathBuf,
    workspace: PersonaWorkspace,
}

impl AttachmentStore {
    /// `configured_root` is `CHAT_ATTACHMENTS_DIR`. A relative value is taken
    /// from the working directory, as `path.resolve` does.
    pub fn new(configured_root: Option<&str>, personas_root: &str) -> Result<Self, String> {
        let base = std::env::current_dir().map_err(|error| error.to_string())?;
        let configured = configured_root
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(DEFAULT_ATTACHMENT_ROOT);
        Ok(Self {
            root: lexical_normalize(&base.join(configured)),
            workspace: PersonaWorkspace::new(personas_root),
        })
    }

    /// `persistIncomingAttachment`. The error text is the TypeScript message.
    pub fn persist(
        &self,
        user_id: &str,
        conversation_id: &str,
        persona_slug: Option<&str>,
        attachment: &IncomingAttachment,
    ) -> Result<StoredAttachment, String> {
        let declared = attachment.mime_type.trim().to_lowercase();
        let parsed = parse_data_url(&attachment.data_url)?;
        let mime_type = if declared.is_empty() {
            parsed.mime_type
        } else {
            declared
        };
        let Some(extension) = extension_for(&mime_type) else {
            let shown = if mime_type.is_empty() {
                "unknown"
            } else {
                mime_type.as_str()
            };
            return Err(format!("Attachment MIME type is not allowed: {shown}"));
        };
        if parsed.bytes.len() > MAX_ATTACHMENT_BYTES {
            return Err(format!(
                "Attachment is too large (max {MAX_ATTACHMENT_BYTES} bytes)."
            ));
        }
        if attachment.size != parsed.bytes.len() as u64 {
            return Err("Attachment size mismatch between metadata and payload.".to_string());
        }

        let safe_name = sanitize_file_name(&attachment.name, extension);
        let persona = persona_slug.map(str::trim).filter(|slug| !slug.is_empty());
        let (storage_path, absolute) = match persona {
            Some(slug) => {
                let path = create_persona_attachment_storage_path(
                    slug,
                    conversation_id,
                    &mime_type,
                    &safe_name,
                );
                let absolute = resolve_persona_scoped_storage_path(&self.workspace, &path)
                    .map_err(|error| error.to_string())?;
                (path, absolute)
            }
            None => {
                let unique = format!(
                    "{}-{}",
                    now_millis(),
                    &uuid::Uuid::new_v4().simple().to_string()[..8]
                );
                let path = format!(
                    "{}/{}/{}-{}",
                    to_base64_url(user_id),
                    to_base64_url(conversation_id),
                    unique,
                    safe_name
                );
                let absolute = self.ensure_within_root(&self.root.join(&path))?;
                (path, absolute)
            }
        };

        if let Some(parent) = absolute.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::write(&absolute, &parsed.bytes).map_err(|error| error.to_string())?;
        Ok(StoredAttachment {
            name: safe_name,
            mime_type,
            size: parsed.bytes.len() as u64,
            storage_path,
            sha256: Some(hex(&Sha256::digest(&parsed.bytes))),
        })
    }

    /// `readStoredAttachmentBuffer`.
    pub fn read(&self, attachment: &StoredAttachment) -> Result<Vec<u8>, String> {
        let path = self.resolve_storage_path(&attachment.storage_path)?;
        std::fs::read(path).map_err(|error| error.to_string())
    }

    /// `deleteStoredAttachmentFile`: best effort, a missing file is not an error.
    pub fn delete(&self, attachment: &StoredAttachment) {
        if let Ok(path) = self.resolve_storage_path(&attachment.storage_path) {
            let _ = std::fs::remove_file(path);
        }
    }

    /// `resolveStoredAttachmentPath`.
    fn resolve_storage_path(&self, storage_path: &str) -> Result<PathBuf, String> {
        let normalized = storage_path.trim();
        if normalized.is_empty() {
            return Err("Attachment storage path is empty.".to_string());
        }
        let path = Path::new(normalized);
        if path.is_absolute() {
            return Ok(lexical_normalize(path));
        }
        if is_persona_scoped_storage_path(normalized) {
            return resolve_persona_scoped_storage_path(&self.workspace, normalized)
                .map_err(|error| error.to_string());
        }
        self.ensure_within_root(&self.root.join(normalized))
    }

    /// `ensureWithinRoot`. Compares whole path components, so `root-other` does
    /// not pass as inside `root`.
    fn ensure_within_root(&self, candidate: &Path) -> Result<PathBuf, String> {
        let resolved = lexical_normalize(candidate);
        if resolved != self.root && !resolved.starts_with(&self.root) {
            return Err("Attachment path is outside of configured storage root.".to_string());
        }
        Ok(resolved)
    }
}

/// `extractStoredAttachmentsFromMetadata`. Entries without a name, MIME type or
/// storage path are skipped.
pub fn extract_from_metadata(metadata: Option<&str>) -> Vec<StoredAttachment> {
    let Some(raw) = metadata.map(str::trim).filter(|text| !text.is_empty()) else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    let Some(entries) = parsed.get("attachments").and_then(Value::as_array) else {
        return Vec::new();
    };
    entries.iter().filter_map(stored_from_value).collect()
}

fn stored_from_value(entry: &Value) -> Option<StoredAttachment> {
    let name = entry.get("name")?.as_str()?;
    let mime_type = entry.get("mimeType")?.as_str()?;
    let storage_path = entry.get("storagePath")?.as_str()?;
    let size = entry
        .get("size")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .map_or(0, |value| value.max(0.0) as u64);
    let sha256 = entry
        .get("sha256")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Some(StoredAttachment {
        name: name.to_string(),
        mime_type: mime_type.to_string(),
        size,
        storage_path: storage_path.to_string(),
        sha256,
    })
}

/// `buildMessageAttachmentMetadata`: `{ attachments }`, or nothing when empty.
pub fn metadata_for(attachments: &[StoredAttachment]) -> Option<Value> {
    if attachments.is_empty() {
        None
    } else {
        Some(json!({ "attachments": attachments }))
    }
}

struct ParsedDataUrl {
    mime_type: String,
    bytes: Vec<u8>,
}

/// `parseDataUrl`: `data:<mime>;base64,<payload>`. The payload may contain
/// whitespace, which is removed before decoding.
fn parse_data_url(raw: &str) -> Result<ParsedDataUrl, String> {
    const NOT_A_DATA_URL: &str = "Attachment payload must be a base64 data URL.";
    const MALFORMED: &str = "Attachment data URL is malformed.";

    let trimmed = raw.trim();
    let rest = match trimmed.get(..5) {
        Some(prefix) if prefix.eq_ignore_ascii_case("data:") => &trimmed[5..],
        _ => return Err(NOT_A_DATA_URL.to_string()),
    };
    let (header, payload) = rest
        .split_once(',')
        .ok_or_else(|| NOT_A_DATA_URL.to_string())?;
    let header = header.to_ascii_lowercase();
    let mime_type = header
        .strip_suffix(";base64")
        .ok_or_else(|| NOT_A_DATA_URL.to_string())?
        .trim()
        .to_string();
    if mime_type.is_empty() || mime_type.contains(';') {
        return Err(NOT_A_DATA_URL.to_string());
    }
    if payload.chars().any(|ch| {
        !(ch.is_ascii_alphanumeric() || matches!(ch, '+' | '/' | '=') || ch.is_whitespace())
    }) {
        return Err(NOT_A_DATA_URL.to_string());
    }
    let cleaned: String = payload.chars().filter(|ch| !ch.is_whitespace()).collect();
    if cleaned.is_empty() {
        return Err(MALFORMED.to_string());
    }
    let bytes = STANDARD
        .decode(&cleaned)
        .or_else(|_| STANDARD_NO_PAD.decode(cleaned.trim_end_matches('=')))
        .map_err(|_| "Attachment base64 payload is invalid.".to_string())?;
    Ok(ParsedDataUrl { mime_type, bytes })
}

fn extension_for(mime_type: &str) -> Option<&'static str> {
    ALLOWED_MIME_TYPES
        .iter()
        .find(|(allowed, _)| *allowed == mime_type)
        .map(|(_, extension)| *extension)
}

/// `sanitizeFileName`: the base name only, unsafe characters become `-`, runs of
/// `-` collapse, leading dots go, and the name is capped at 120 characters. A name
/// without an extension gets the one of its MIME type.
fn sanitize_file_name(name: &str, extension: &str) -> String {
    let base_name = name.rsplit(['/', '\\']).next().unwrap_or("");
    let mut cleaned: String = base_name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '-'
            }
        })
        .collect();
    while cleaned.contains("--") {
        cleaned = cleaned.replace("--", "-");
    }
    let mut base: String = cleaned.trim_start_matches('.').chars().take(120).collect();
    if base.is_empty() {
        return format!("attachment.{extension}");
    }
    if !base.contains('.') {
        base.push('.');
        base.push_str(extension);
    }
    base
}

/// `toBase64Url` in `attachments.ts`: an empty value becomes `default`.
fn to_base64_url(value: &str) -> String {
    let normalized = value.trim();
    if normalized.is_empty() {
        return "default".to_string();
    }
    URL_SAFE_NO_PAD.encode(normalized.as_bytes())
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Removes `.` and resolves `..` without touching the file system.
fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::families::channels_wire::test_support::ScratchDir;

    fn store_in(scratch: &ScratchDir) -> AttachmentStore {
        let uploads = scratch.path_string("uploads");
        let personas = scratch.path_string("personas");
        AttachmentStore::new(Some(uploads.as_str()), &personas).expect("store")
    }

    fn incoming(name: &str, mime: &str, data_url: &str, size: u64) -> IncomingAttachment {
        IncomingAttachment {
            name: name.to_string(),
            mime_type: mime.to_string(),
            size,
            data_url: data_url.to_string(),
        }
    }

    #[test]
    fn file_names_are_reduced_to_safe_base_names() {
        assert_eq!(
            sanitize_file_name("../../evil name.png", "png"),
            "evil-name.png"
        );
        assert_eq!(sanitize_file_name("notes", "md"), "notes.md");
        assert_eq!(sanitize_file_name("...", "txt"), "attachment.txt");
    }

    #[test]
    fn a_data_url_must_be_base64() {
        assert!(parse_data_url("data:text/plain,hello").is_err());
        assert!(parse_data_url("https://example.test/a.png").is_err());
        let parsed = parse_data_url("data:TEXT/PLAIN;base64,aGk=").expect("valid");
        assert_eq!(parsed.mime_type, "text/plain");
        assert_eq!(parsed.bytes, b"hi");
    }

    #[test]
    fn persisted_files_read_back_and_carry_a_digest() {
        let scratch = ScratchDir::new();
        let store = store_in(&scratch);
        let stored = store
            .persist(
                "user-1",
                "conv-1",
                None,
                &incoming("hello.txt", "text/plain", "data:text/plain;base64,aGk=", 2),
            )
            .expect("persisted");

        assert_eq!(stored.name, "hello.txt");
        assert_eq!(stored.size, 2);
        assert_eq!(store.read(&stored).expect("read"), b"hi");
        assert_eq!(
            stored.sha256.as_deref(),
            Some("8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4")
        );
        store.delete(&stored);
        assert!(store.read(&stored).is_err());
    }

    #[test]
    fn a_size_that_does_not_match_the_payload_is_refused() {
        let scratch = ScratchDir::new();
        let store = store_in(&scratch);
        let error = store
            .persist(
                "user-1",
                "conv-1",
                None,
                &incoming("a.txt", "text/plain", "data:text/plain;base64,aGk=", 0),
            )
            .expect_err("size mismatch");
        assert_eq!(
            error,
            "Attachment size mismatch between metadata and payload."
        );
    }

    #[test]
    fn a_disallowed_mime_type_is_refused() {
        let scratch = ScratchDir::new();
        let store = store_in(&scratch);
        let error = store
            .persist(
                "user-1",
                "conv-1",
                None,
                &incoming(
                    "a.exe",
                    "application/x-msdownload",
                    "data:application/x-msdownload;base64,aGk=",
                    2,
                ),
            )
            .expect_err("refused");
        assert_eq!(
            error,
            "Attachment MIME type is not allowed: application/x-msdownload"
        );
    }

    #[test]
    fn a_stored_path_outside_the_root_is_refused() {
        let scratch = ScratchDir::new();
        let store = store_in(&scratch);
        let attachment = StoredAttachment {
            name: "x".to_string(),
            mime_type: "text/plain".to_string(),
            size: 0,
            storage_path: "../../secret.txt".to_string(),
            sha256: None,
        };
        assert_eq!(
            store.read(&attachment).expect_err("outside"),
            "Attachment path is outside of configured storage root."
        );
    }

    #[test]
    fn metadata_round_trips_and_skips_broken_entries() {
        let attachment = StoredAttachment {
            name: "a.txt".to_string(),
            mime_type: "text/plain".to_string(),
            size: 2,
            storage_path: "u/c/a.txt".to_string(),
            sha256: None,
        };
        let metadata = metadata_for(std::slice::from_ref(&attachment)).expect("metadata");
        let raw = format!(
            "{{\"attachments\":[{{\"name\":1}},{}]}}",
            metadata["attachments"][0]
        );
        assert_eq!(extract_from_metadata(Some(&raw)), vec![attachment]);
        assert!(metadata_for(&[]).is_none());
    }
}
