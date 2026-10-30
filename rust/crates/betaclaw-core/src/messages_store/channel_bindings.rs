//! Port of `src/server/channels/messages/repository/queries/channelBindings.ts`.
//!
//! | TypeScript member                  | Rust member                                       |
//! | ---------------------------------- | ------------------------------------------------ |
//! | `upsertChannelBinding`             | [`ChannelBindingQueries::upsert_channel_binding`] |
//! | `listChannelBindings`              | [`ChannelBindingQueries::list_channel_bindings`]  |
//! | `getChannelBinding`                | [`ChannelBindingQueries::get_channel_binding`]    |
//! | `updateChannelBindingPersona`      | [`ChannelBindingQueries::update_channel_binding_persona`] |
//! | `touchChannelLastSeen`             | [`ChannelBindingQueries::touch_channel_last_seen`] |
//!
//! `upsertChannelBinding` deliberately does **not** update `last_seen_at`: it
//! binds `NULL` on insert and leaves the column out of the `DO UPDATE SET`
//! list, so an explicit binding update never resets the liveness timestamp.
//! `touchChannelLastSeen` is the only writer for that column.

use rusqlite::{params, Connection, OptionalExtension};

use super::row_mappers::to_channel_binding;
use super::types::{
    normalize_user_id, now_iso, ChannelBinding, MessageRepositoryError, UpsertChannelBindingInput,
};

/// `ChannelBindingQueries` from `channelBindings.ts:10`.
pub struct ChannelBindingQueries<'a> {
    db: &'a Connection,
}

impl<'a> ChannelBindingQueries<'a> {
    pub fn new(db: &'a Connection) -> Self {
        Self { db }
    }

    /// `upsertChannelBinding` from `channelBindings.ts:16-63`.
    pub fn upsert_channel_binding(
        &self,
        input: &UpsertChannelBindingInput<'_>,
    ) -> Result<ChannelBinding, MessageRepositoryError> {
        let user_id = normalize_user_id(Some(input.user_id));
        let now = now_iso();
        let metadata = input
            .metadata
            .map(|value| {
                serde_json::to_string(value)
                    .map_err(|error| MessageRepositoryError::Json(error.to_string()))
            })
            .transpose()?;

        self.db.execute(
            "
            INSERT INTO channel_bindings (
              user_id,
              channel,
              status,
              external_peer_id,
              peer_name,
              transport,
              metadata,
              last_seen_at,
              created_at,
              updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            ON CONFLICT(user_id, channel)
            DO UPDATE SET
              status = excluded.status,
              external_peer_id = excluded.external_peer_id,
              peer_name = excluded.peer_name,
              transport = excluded.transport,
              metadata = excluded.metadata,
              updated_at = excluded.updated_at
          ",
            params![
                user_id,
                input.channel,
                input.status,
                input.external_peer_id.filter(|value| !value.is_empty()),
                input.peer_name.filter(|value| !value.is_empty()),
                input.transport.filter(|value| !value.is_empty()),
                metadata,
                Option::<String>::None,
                now,
                now
            ],
        )?;

        self.get_channel_binding(&user_id, input.channel)?.ok_or(
            MessageRepositoryError::MissingRow {
                context: "channel_bindings.upsert",
            },
        )
    }

    /// `listChannelBindings` from `channelBindings.ts:65-71`.
    pub fn list_channel_bindings(
        &self,
        user_id: &str,
    ) -> Result<Vec<ChannelBinding>, MessageRepositoryError> {
        let normalized_user_id = normalize_user_id(Some(user_id));
        let mut statement = self.db.prepare(
            "SELECT * FROM channel_bindings WHERE user_id = ?1 ORDER BY updated_at DESC",
        )?;
        let rows = statement.query_map(params![normalized_user_id], to_channel_binding)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// `getChannelBinding` from `channelBindings.ts:73-79`.
    pub fn get_channel_binding(
        &self,
        user_id: &str,
        channel: &str,
    ) -> Result<Option<ChannelBinding>, MessageRepositoryError> {
        let normalized_user_id = normalize_user_id(Some(user_id));
        self.db
            .query_row(
                "SELECT * FROM channel_bindings WHERE user_id = ?1 AND channel = ?2",
                params![normalized_user_id, channel],
                to_channel_binding,
            )
            .optional()
            .map_err(Into::into)
    }

    /// `updateChannelBindingPersona` from `channelBindings.ts:81-89`.
    pub fn update_channel_binding_persona(
        &self,
        user_id: &str,
        channel: &str,
        persona_id: Option<&str>,
    ) -> Result<(), MessageRepositoryError> {
        let normalized_user_id = normalize_user_id(Some(user_id));
        self.db.execute(
            "UPDATE channel_bindings SET persona_id = ?1, updated_at = ?2 WHERE user_id = ?3 AND channel = ?4",
            params![persona_id, now_iso(), normalized_user_id, channel],
        )?;
        Ok(())
    }

    /// `touchChannelLastSeen` from `channelBindings.ts:91-123`.
    ///
    /// Upserts a binding row with only the liveness fields populated, so an
    /// inbound channel that has never been bound still gets a row.
    pub fn touch_channel_last_seen(
        &self,
        user_id: &str,
        channel: &str,
        at_iso: &str,
        status: &str,
    ) -> Result<(), MessageRepositoryError> {
        let normalized_user_id = normalize_user_id(Some(user_id));
        let now = now_iso();
        self.db.execute(
            "
            INSERT INTO channel_bindings (
              user_id,
              channel,
              status,
              external_peer_id,
              peer_name,
              transport,
              metadata,
              last_seen_at,
              created_at,
              updated_at
            )
            VALUES (?1, ?2, ?3, NULL, NULL, NULL, NULL, ?4, ?5, ?6)
            ON CONFLICT(user_id, channel)
            DO UPDATE SET
              status = excluded.status,
              last_seen_at = excluded.last_seen_at,
              updated_at = excluded.updated_at
          ",
            params![normalized_user_id, channel, status, at_iso, now, now],
        )?;
        Ok(())
    }
}
