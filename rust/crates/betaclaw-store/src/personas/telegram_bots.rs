//! Port of `src/server/telegram/personaTelegramBotRegistry.ts`.
//!
//! The `persona_telegram_bots` table lives in the personas database
//! (`PERSONAS_DB_PATH`, default `.local/personas.db`). The TypeScript registry
//! opens its own connection to that file and creates the table in its
//! constructor. This module does the same, with the same table and the same
//! statements for the registry operations.
//!
//! Ceiling: an unknown `transport` value in the database reads as `polling`.
//! The TypeScript row mapper passes such a value through unchanged, which a Rust
//! enum cannot hold. Rows written by either backend only contain `webhook` or
//! `polling`.
//!
//! Not ported: the process-wide singleton `getPersonaTelegramBotRegistry`.

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::db::{self, OpenOptions};
use crate::stats::util::now_iso;

const CREATE_TABLE: &str = "CREATE TABLE IF NOT EXISTS persona_telegram_bots (
  bot_id         TEXT PRIMARY KEY,
  persona_id     TEXT NOT NULL UNIQUE,
  token          TEXT NOT NULL,
  webhook_secret TEXT NOT NULL,
  peer_name      TEXT,
  transport      TEXT NOT NULL DEFAULT 'polling',
  polling_offset INTEGER NOT NULL DEFAULT 0,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);";

const UPSERT: &str = "INSERT INTO persona_telegram_bots
       (bot_id, persona_id, token, webhook_secret, peer_name, transport, polling_offset, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
     ON CONFLICT(bot_id) DO UPDATE SET
       persona_id     = excluded.persona_id,
       token          = excluded.token,
       webhook_secret = excluded.webhook_secret,
       peer_name      = excluded.peer_name,
       transport      = excluded.transport,
       active         = 1,
       updated_at     = excluded.updated_at";

/// `'webhook' | 'polling'` in `personaTelegramBotRegistry.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PersonaTelegramTransport {
    Webhook,
    Polling,
}

impl PersonaTelegramTransport {
    fn as_str(self) -> &'static str {
        match self {
            Self::Webhook => "webhook",
            Self::Polling => "polling",
        }
    }

    fn from_column(value: &str) -> Self {
        if value == "webhook" {
            Self::Webhook
        } else {
            Self::Polling
        }
    }
}

/// `PersonaTelegramBot`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersonaTelegramBot {
    pub bot_id: String,
    pub persona_id: String,
    pub token: String,
    pub webhook_secret: String,
    pub peer_name: Option<String>,
    pub transport: PersonaTelegramTransport,
    pub polling_offset: i64,
    pub active: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// `UpsertPersonaTelegramBotInput`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpsertPersonaTelegramBotInput {
    pub bot_id: String,
    pub persona_id: String,
    pub token: String,
    pub webhook_secret: String,
    pub peer_name: Option<String>,
    pub transport: PersonaTelegramTransport,
}

/// `toBot` in `personaTelegramBotRegistry.ts`. An empty `peer_name` reads as absent.
fn bot_from_row(row: &Row<'_>) -> rusqlite::Result<PersonaTelegramBot> {
    let peer_name: Option<String> = row.get("peer_name")?;
    let transport: String = row.get("transport")?;
    let active: i64 = row.get("active")?;
    Ok(PersonaTelegramBot {
        bot_id: row.get("bot_id")?,
        persona_id: row.get("persona_id")?,
        token: row.get("token")?,
        webhook_secret: row.get("webhook_secret")?,
        peer_name: peer_name.filter(|name| !name.is_empty()),
        transport: PersonaTelegramTransport::from_column(&transport),
        polling_offset: row.get("polling_offset")?,
        active: active == 1,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// `PersonaTelegramBotRegistry`. One connection to the personas database.
pub struct PersonaTelegramBotRegistry {
    connection: Connection,
}

impl PersonaTelegramBotRegistry {
    /// Mirrors `new PersonaTelegramBotRegistry(dbPath)` and its `migrate()`. The
    /// caller passes the path; the default is `PERSONAS_DB_PATH` or `.local/personas.db`.
    pub fn open(db_path: &str) -> rusqlite::Result<Self> {
        let connection = db::open(OpenOptions::new(db_path))?;
        connection.execute_batch(CREATE_TABLE)?;
        Ok(Self { connection })
    }

    /// `getBot`.
    pub fn get_bot(&self, bot_id: &str) -> rusqlite::Result<Option<PersonaTelegramBot>> {
        self.connection
            .query_row(
                "SELECT * FROM persona_telegram_bots WHERE bot_id = ?",
                [bot_id],
                bot_from_row,
            )
            .optional()
    }

    /// `getBotByPersonaId`.
    pub fn get_bot_by_persona_id(
        &self,
        persona_id: &str,
    ) -> rusqlite::Result<Option<PersonaTelegramBot>> {
        self.connection
            .query_row(
                "SELECT * FROM persona_telegram_bots WHERE persona_id = ?",
                [persona_id],
                bot_from_row,
            )
            .optional()
    }

    /// `listActiveBots`.
    pub fn list_active_bots(&self) -> rusqlite::Result<Vec<PersonaTelegramBot>> {
        self.list("SELECT * FROM persona_telegram_bots WHERE active = 1 ORDER BY created_at")
    }

    /// `listAllBots`.
    pub fn list_all_bots(&self) -> rusqlite::Result<Vec<PersonaTelegramBot>> {
        self.list("SELECT * FROM persona_telegram_bots ORDER BY created_at")
    }

    fn list(&self, sql: &str) -> rusqlite::Result<Vec<PersonaTelegramBot>> {
        let mut statement = self.connection.prepare(sql)?;
        let rows = statement.query_map([], bot_from_row)?;
        rows.collect()
    }

    /// `upsertBot`. A conflict on `bot_id` keeps the polling offset and `created_at`,
    /// and sets the bot active again.
    pub fn upsert_bot(
        &self,
        input: &UpsertPersonaTelegramBotInput,
    ) -> rusqlite::Result<PersonaTelegramBot> {
        let now = now_iso();
        self.connection.execute(
            UPSERT,
            params![
                input.bot_id,
                input.persona_id,
                input.token,
                input.webhook_secret,
                input.peer_name.as_deref(),
                input.transport.as_str(),
                now,
                now
            ],
        )?;
        self.get_bot(&input.bot_id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    /// `setPollingOffset`.
    pub fn set_polling_offset(&self, bot_id: &str, offset: i64) -> rusqlite::Result<()> {
        self.connection.execute(
            "UPDATE persona_telegram_bots SET polling_offset = ? WHERE bot_id = ?",
            params![offset, bot_id],
        )?;
        Ok(())
    }

    /// `setActive`.
    pub fn set_active(&self, bot_id: &str, active: bool) -> rusqlite::Result<()> {
        self.connection.execute(
            "UPDATE persona_telegram_bots SET active = ?, updated_at = ? WHERE bot_id = ?",
            params![i64::from(active), now_iso(), bot_id],
        )?;
        Ok(())
    }

    /// `removeBot`.
    pub fn remove_bot(&self, bot_id: &str) -> rusqlite::Result<()> {
        self.connection.execute(
            "DELETE FROM persona_telegram_bots WHERE bot_id = ?",
            [bot_id],
        )?;
        Ok(())
    }

    /// `removeByPersonaId`.
    pub fn remove_by_persona_id(&self, persona_id: &str) -> rusqlite::Result<()> {
        self.connection.execute(
            "DELETE FROM persona_telegram_bots WHERE persona_id = ?",
            [persona_id],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> PersonaTelegramBotRegistry {
        PersonaTelegramBotRegistry::open(":memory:").expect("open in-memory registry")
    }

    fn input(bot_id: &str, persona_id: &str) -> UpsertPersonaTelegramBotInput {
        UpsertPersonaTelegramBotInput {
            bot_id: bot_id.to_string(),
            persona_id: persona_id.to_string(),
            token: format!("token-{bot_id}"),
            webhook_secret: "secret".to_string(),
            peer_name: Some("@persona_bot".to_string()),
            transport: PersonaTelegramTransport::Polling,
        }
    }

    #[test]
    fn creates_the_table_with_the_typescript_columns() {
        let registry = registry();
        let columns: Vec<String> = registry
            .connection
            .prepare("PRAGMA table_info(persona_telegram_bots)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>("name"))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            columns,
            [
                "bot_id",
                "persona_id",
                "token",
                "webhook_secret",
                "peer_name",
                "transport",
                "polling_offset",
                "active",
                "created_at",
                "updated_at"
            ]
        );
    }

    #[test]
    fn upsert_on_an_existing_bot_keeps_the_offset_and_reactivates_it() {
        let registry = registry();
        let created = registry.upsert_bot(&input("bot-1", "persona-1")).unwrap();
        assert_eq!(created.transport, PersonaTelegramTransport::Polling);
        assert_eq!(created.polling_offset, 0);
        assert!(created.active);

        registry.set_polling_offset("bot-1", 42).unwrap();
        registry.set_active("bot-1", false).unwrap();
        let mut changed = input("bot-1", "persona-1");
        changed.token = "rotated".to_string();
        changed.transport = PersonaTelegramTransport::Webhook;
        let updated = registry.upsert_bot(&changed).unwrap();

        assert_eq!(updated.token, "rotated");
        assert_eq!(updated.transport, PersonaTelegramTransport::Webhook);
        assert_eq!(updated.polling_offset, 42);
        assert!(updated.active);
        assert_eq!(updated.created_at, created.created_at);
        let by_persona = registry.get_bot_by_persona_id("persona-1").unwrap();
        assert_eq!(by_persona.map(|bot| bot.bot_id).as_deref(), Some("bot-1"));
    }

    #[test]
    fn active_listing_skips_inactive_bots_and_removal_is_by_persona() {
        let registry = registry();
        registry.upsert_bot(&input("bot-1", "persona-1")).unwrap();
        registry.upsert_bot(&input("bot-2", "persona-2")).unwrap();
        registry.set_active("bot-2", false).unwrap();

        let active: Vec<String> = registry
            .list_active_bots()
            .unwrap()
            .into_iter()
            .map(|bot| bot.bot_id)
            .collect();
        assert_eq!(active, ["bot-1"]);
        assert_eq!(registry.list_all_bots().unwrap().len(), 2);

        registry.remove_by_persona_id("persona-1").unwrap();
        assert!(registry.get_bot("bot-1").unwrap().is_none());
        assert!(registry.get_bot("bot-2").unwrap().is_some());
    }
}
