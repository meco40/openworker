//! Port of `src/server/channels/messages/attachments.ts`, the part that reads the attachment
//! list of a stored message: `extractStoredAttachmentsFromMetadata` and its `toStoredAttachment`.
//!
//! The persist, read and delete functions of that file need the attachment storage and are
//! not part of this module. The gateway's attachment store owns them.

use serde_json::Value;

use crate::model_hub::types::GatewayMessageAttachment;

/// `extractStoredAttachmentsFromMetadata(metadata)` (`attachments.ts:154-166`).
///
/// Empty metadata, metadata that is not JSON, a missing or non-array `attachments` key, and
/// entries without a string `name`, `mimeType` or `storagePath` all yield no attachment.
/// `size` is clamped to zero, and `sha256` is kept only when it is not empty.
pub fn extract_stored_attachments_from_metadata(
    metadata: Option<&str>,
) -> Vec<GatewayMessageAttachment> {
    let Some(text) = metadata.map(str::trim).filter(|text| !text.is_empty()) else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    parsed
        .get("attachments")
        .and_then(Value::as_array)
        .map(|entries| entries.iter().filter_map(to_stored_attachment).collect())
        .unwrap_or_default()
}

/// `toStoredAttachment(entry)` (`attachments.ts:127-152`).
fn to_stored_attachment(entry: &Value) -> Option<GatewayMessageAttachment> {
    let object = entry.as_object()?;
    let name = object.get("name")?.as_str()?;
    let mime_type = object.get("mimeType")?.as_str()?;
    let storage_path = object.get("storagePath")?.as_str()?;
    let size = object
        .get("size")
        .and_then(Value::as_f64)
        .filter(|size| size.is_finite())
        .map_or(0, |size| size.max(0.0) as i64);
    let sha256 = object
        .get("sha256")
        .and_then(Value::as_str)
        .filter(|sha256| !sha256.is_empty())
        .map(str::to_string);
    Some(GatewayMessageAttachment {
        name: name.to_string(),
        mime_type: mime_type.to_string(),
        size,
        storage_path: storage_path.to_string(),
        sha256,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_attachments_are_read_and_bad_entries_are_skipped() {
        let metadata = r#"{"attachments":[
            {"name":"a.png","mimeType":"image/png","size":12,"storagePath":"u/c/a.png","sha256":"ab"},
            {"name":"no-path.txt","mimeType":"text/plain"},
            "not an object"
        ]}"#;
        let attachments = extract_stored_attachments_from_metadata(Some(metadata));
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].name, "a.png");
        assert_eq!(attachments[0].size, 12);
        assert_eq!(attachments[0].sha256.as_deref(), Some("ab"));
    }

    #[test]
    fn missing_or_empty_lists_and_unparsable_metadata_yield_nothing() {
        assert!(extract_stored_attachments_from_metadata(None).is_empty());
        assert!(extract_stored_attachments_from_metadata(Some("  ")).is_empty());
        assert!(extract_stored_attachments_from_metadata(Some("nicht json")).is_empty());
        assert!(extract_stored_attachments_from_metadata(Some(r#"{"attachments":[]}"#)).is_empty());
    }
}
