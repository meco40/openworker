//! Port of `src/server/channels/messages/messageRowMappers.ts`.
//!
//! The three mappers read `SELECT *` rows by column name. The TypeScript source
//! reaches for `Record<string, unknown>` and coerces with `as` casts plus a truthy
//! fallback (`(row.x as string) || null`, which turns `undefined` and `''` into
//! `null`). The port reproduces that coercion explicitly so the two
//! implementations cannot drift on empty-string handling.
//!
//! `toPersonaProjectRecord` lives in `repository/queries/projects.ts:257-269` and
//! stays there.

use rusqlite::Row;

use super::types::LEGACY_LOCAL_USER_ID;
use super::types::{Conversation, StoredMessage};

/// `(row.value as string) || null` — the TypeScript truthy-or-null coercion.
fn string_or_null(row: &Row<'_>, column: &str) -> rusqlite::Result<Option<String>> {
    Ok(row
        .get::<_, Option<String>>(column)?
        .filter(|value| !value.is_empty()))
}

/// `toConversation` from `messageRowMappers.ts:10-22`.
pub fn to_conversation(row: &Row<'_>) -> rusqlite::Result<Conversation> {
    let channel_type: String = row.get("channel_type")?;
    let title: String = row.get("title")?;
    Ok(Conversation {
        id: row.get("id")?,
        channel_type,
        external_chat_id: string_or_null(row, "external_chat_id")?,
        user_id: string_or_null(row, "user_id")?
            .unwrap_or_else(|| LEGACY_LOCAL_USER_ID.to_string()),
        title,
        workspace_id: None,
        model_override: string_or_null(row, "model_override")?,
        persona_id: string_or_null(row, "persona_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// `toMessage` from `messageRowMappers.ts:24-37`.
pub fn to_message(row: &Row<'_>) -> rusqlite::Result<StoredMessage> {
    Ok(StoredMessage {
        id: row.get("id")?,
        conversation_id: row.get("conversation_id")?,
        seq: row.get::<_, Option<i64>>("seq")?,
        role: row.get("role")?,
        content: row.get("content")?,
        platform: row.get("platform")?,
        external_msg_id: string_or_null(row, "external_msg_id")?,
        sender_name: string_or_null(row, "sender_name")?,
        metadata: string_or_null(row, "metadata")?,
        created_at: row.get("created_at")?,
    })
}

/// `toChannelBinding` from `messageRowMappers.ts:39-53`.
pub fn to_channel_binding(row: &Row<'_>) -> rusqlite::Result<super::types::ChannelBinding> {
    Ok(super::types::ChannelBinding {
        user_id: row.get("user_id")?,
        channel: row.get("channel")?,
        status: row.get("status")?,
        external_peer_id: string_or_null(row, "external_peer_id")?,
        peer_name: string_or_null(row, "peer_name")?,
        transport: string_or_null(row, "transport")?,
        metadata: string_or_null(row, "metadata")?,
        persona_id: string_or_null(row, "persona_id")?,
        last_seen_at: string_or_null(row, "last_seen_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open, OpenOptions};
    use crate::messages_store::migrations::run_migrations;

    fn seeded() -> rusqlite::Connection {
        let connection = open(OpenOptions::new(":memory:")).expect("open");
        // `messages` is created the way a pre-`seq` release left it. The fresh
        // DDL declares `seq INTEGER NOT NULL DEFAULT 0`
        // (`migrations/index.ts:75`), so only the additive ladder
        // `ALTER TABLE messages ADD COLUMN seq INTEGER` can leave the column
        // nullable — which is what makes a NULL `seq` representable at all.
        // `backfillMessageSeq` numbers the rows that already exist, so the row
        // below has to be inserted after the migration, with no `seq` at all.
        connection
            .execute_batch(
                r#"
                CREATE TABLE messages (
                  id TEXT PRIMARY KEY,
                  conversation_id TEXT NOT NULL REFERENCES conversations(id),
                  role TEXT NOT NULL CHECK(role IN ('user', 'agent', 'system')),
                  content TEXT NOT NULL DEFAULT '',
                  platform TEXT NOT NULL,
                  external_msg_id TEXT,
                  sender_name TEXT,
                  metadata TEXT,
                  created_at TEXT NOT NULL
                );
                "#,
            )
            .expect("seed legacy schema");
        run_migrations(&connection).expect("migrate");
        connection
            .execute_batch(
                r#"
                INSERT INTO conversations
                  (id, channel_type, external_chat_id, user_id, title, created_at, updated_at)
                VALUES ('c-1', 'WebChat', '', '', 'Title', 't0', 't0');
                INSERT INTO messages
                  (id, conversation_id, role, content, platform, sender_name, metadata, created_at)
                VALUES ('m-1', 'c-1', 'user', 'hi', 'WebChat', '', NULL, 't0');
                INSERT INTO channel_bindings
                  (user_id, channel, status, external_peer_id, created_at, updated_at)
                VALUES ('u-1', 'webchat', 'connected', '', 't0', 't0');
                "#,
            )
            .expect("seed");
        connection
    }

    #[test]
    fn empty_strings_become_null_like_the_typescript_coercion() {
        let connection = seeded();
        let conversation = connection
            .query_row(
                "SELECT * FROM conversations WHERE id = 'c-1'",
                [],
                to_conversation,
            )
            .expect("map");
        assert_eq!(conversation.external_chat_id, None);
        assert_eq!(
            conversation.user_id, "legacy-local-user",
            "an empty user_id falls back to the legacy constant"
        );
        assert_eq!(conversation.title, "Title");
        assert_eq!(conversation.model_override, None);
    }

    #[test]
    fn message_seq_and_metadata_keep_their_nullability() {
        let connection = seeded();
        let message = connection
            .query_row("SELECT * FROM messages WHERE id = 'm-1'", [], to_message)
            .expect("map");
        assert_eq!(message.seq, None, "a NULL seq stays null");
        assert_eq!(message.metadata, None);
        assert_eq!(message.sender_name, None, "an empty string becomes null");
        assert_eq!(message.role, "user");
    }

    #[test]
    fn channel_binding_keeps_the_raw_channel_and_status() {
        let connection = seeded();
        let binding = connection
            .query_row("SELECT * FROM channel_bindings", [], to_channel_binding)
            .expect("map");
        assert_eq!(binding.channel, "webchat");
        assert_eq!(binding.status, "connected");
        assert_eq!(binding.external_peer_id, None);
        assert_eq!(binding.persona_id, None);
    }
}
