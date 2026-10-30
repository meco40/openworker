//! Port of `src/server/agent-v2/repository/extensionRepository.ts`.
//!
//! Rows are keyed by `(id, version, digest)`. The manifest is stored as JSON. A
//! stored manifest that no longer parses is skipped by the list call, as
//! `safeJsonParse(...).filter(Boolean)` skips it in the TypeScript.

use rusqlite::{params, Connection};

use super::errors::AgentV2Error;
use super::types::ExtensionManifestV1;
use crate::stats::util::now_iso;

pub fn upsert_extension_manifest(
    connection: &Connection,
    manifest: &ExtensionManifestV1,
    enabled: bool,
) -> Result<(), AgentV2Error> {
    let now = now_iso();
    let serialized = serde_json::to_string(manifest)?;
    connection.execute(
        "INSERT INTO agent_v2_extensions (
           id, version, digest, manifest_json, enabled, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id, version, digest)
         DO UPDATE SET
           manifest_json = excluded.manifest_json,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at",
        params![
            manifest.id,
            manifest.version,
            manifest.digest,
            serialized,
            i64::from(enabled),
            now,
            now,
        ],
    )?;
    Ok(())
}

pub fn list_enabled_extension_manifests(
    connection: &Connection,
) -> Result<Vec<ExtensionManifestV1>, AgentV2Error> {
    let texts = {
        let mut statement = connection.prepare(
            "SELECT manifest_json FROM agent_v2_extensions
             WHERE enabled = 1
             ORDER BY id ASC, version ASC",
        )?;
        let mapped = statement.query_map([], |row| row.get::<_, String>(0))?;
        mapped.collect::<rusqlite::Result<Vec<_>>>()?
    };
    Ok(texts
        .iter()
        .filter_map(|text| serde_json::from_str::<ExtensionManifestV1>(text).ok())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_v2::migrations::run_migrations;
    use crate::agent_v2::types::LifecycleHookStage;

    fn manifest(version: &str) -> ExtensionManifestV1 {
        ExtensionManifestV1 {
            schema_version: "1".into(),
            id: "demo".into(),
            version: version.into(),
            name: "Demo".into(),
            description: "d".into(),
            author: "a".into(),
            digest: format!("digest-{version}"),
            key_id: "key-1".into(),
            signature: "sig".into(),
            module_path: "dist/index.js".into(),
            hook_stages: vec![LifecycleHookStage::ToolAfterExecute],
            fail_closed_stages: None,
            timeout_ms: None,
        }
    }

    #[test]
    fn only_enabled_manifests_are_listed_in_id_and_version_order() {
        let connection = Connection::open_in_memory().expect("open");
        run_migrations(&connection).expect("migrate");
        upsert_extension_manifest(&connection, &manifest("2.0.0"), true).expect("v2");
        upsert_extension_manifest(&connection, &manifest("1.0.0"), true).expect("v1");
        upsert_extension_manifest(&connection, &manifest("3.0.0"), false).expect("v3 off");

        let listed = list_enabled_extension_manifests(&connection).expect("list");
        let versions: Vec<&str> = listed.iter().map(|item| item.version.as_str()).collect();
        assert_eq!(versions, vec!["1.0.0", "2.0.0"]);
        assert_eq!(listed[0], manifest("1.0.0"));
    }
}
