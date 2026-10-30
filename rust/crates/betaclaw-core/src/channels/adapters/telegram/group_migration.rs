//! Port of the pure part of `src/server/channels/telegram/groupMigration.ts`
//! (`resolveTelegramGroupMigration`).
//!
//! The step that rewrites the stored chat ids, `applyTelegramGroupMigration`,
//! needs the credential store. It lives in `pairing::telegram_inbound`.

/// `{ oldChatId, newChatId }` of a group that became a supergroup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupMigration {
    pub old_chat_id: String,
    pub new_chat_id: String,
}

/// `resolveTelegramGroupMigration`. A `migrate_to_chat_id` on the old chat wins
/// over a `migrate_from_chat_id` on the new one, as in the source.
pub fn resolve_telegram_group_migration(
    chat_id: i64,
    migrate_to_chat_id: Option<i64>,
    migrate_from_chat_id: Option<i64>,
) -> Option<GroupMigration> {
    if let Some(new_chat_id) = migrate_to_chat_id {
        return Some(GroupMigration {
            old_chat_id: chat_id.to_string(),
            new_chat_id: new_chat_id.to_string(),
        });
    }
    migrate_from_chat_id.map(|old_chat_id| GroupMigration {
        old_chat_id: old_chat_id.to_string(),
        new_chat_id: chat_id.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_old_chat_reports_the_migration_target() {
        let migration = resolve_telegram_group_migration(-100, Some(-200), None)
            .expect("migration is reported");
        assert_eq!(migration.old_chat_id, "-100");
        assert_eq!(migration.new_chat_id, "-200");
    }

    #[test]
    fn the_new_chat_reports_the_source_chat() {
        let migration = resolve_telegram_group_migration(-200, None, Some(-100))
            .expect("migration is reported");
        assert_eq!(migration.old_chat_id, "-100");
        assert_eq!(migration.new_chat_id, "-200");
    }

    #[test]
    fn a_plain_message_is_not_a_migration() {
        assert_eq!(resolve_telegram_group_migration(-100, None, None), None);
    }
}
