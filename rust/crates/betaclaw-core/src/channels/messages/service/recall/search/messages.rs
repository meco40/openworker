//! Port of `src/server/channels/messages/service/recall/search/messages.ts`
//! (`recallFromChat`, FTS5 over the messages store).
//!
//! The `searchMessagesOverride` argument of the TypeScript `RecallService` is not
//! ported. Nothing in the TypeScript tree passes it.

use std::collections::HashSet;
use std::sync::Mutex;

use crate::messages_store::{
    Conversation, MessageRepositoryError, MessagesStore, SearchMessagesOptions, StoredMessage,
};

use super::super::ports::RecallChatSearch;
use super::super::utils::{chat_search_options, utf16_prefix};

/// The store's FTS5 search is the production implementation of the port.
///
/// `MessagesStore` wraps a `rusqlite::Connection`, which is not `Sync`. The port
/// requires `Sync` because the recall service is shared across tasks, so the
/// caller hands over the store inside a `Mutex`. `Mutex<T>` is `Sync` for `T: Send`.
impl RecallChatSearch for Mutex<MessagesStore> {
    fn search_messages(
        &self,
        query: &str,
        options: &SearchMessagesOptions<'_>,
    ) -> Result<Vec<StoredMessage>, MessageRepositoryError> {
        let store = self.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        store.search_messages(query, options)
    }
}

/// `recallFromChat`.
///
/// Drops echoes of the current query, collapses repeated agent answers (same
/// first 80 characters), puts user messages first and keeps ten. Without a
/// search port the result is empty. A search error is logged and also gives an
/// empty result.
pub fn recall_from_chat<C: RecallChatSearch>(
    chat: Option<&C>,
    conversation: &Conversation,
    user_input: &str,
) -> Vec<StoredMessage> {
    let Some(chat) = chat else {
        return Vec::new();
    };

    let input_norm: String =
        strip_trailing_punctuation(&user_input.trim().to_lowercase()).to_string();
    let raw = match chat.search_messages(user_input, &chat_search_options(conversation)) {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!(
                error = %crate::safe_error_message(&error),
                "Chat FTS5 recall failed"
            );
            return Vec::new();
        }
    };

    let filtered: Vec<StoredMessage> = raw
        .iter()
        .filter(|message| {
            strip_trailing_punctuation(&message.content.trim().to_lowercase()) != input_norm
        })
        .cloned()
        .collect();

    // Agent messages collapse by their first 80 UTF-16 units, lowercased.
    let mut seen: HashSet<String> = HashSet::new();
    let deduped: Vec<StoredMessage> = filtered
        .into_iter()
        .filter(|message| {
            if message.role == "user" {
                return true;
            }
            let fingerprint = utf16_prefix(&message.content, 80).to_lowercase();
            seen.insert(fingerprint)
        })
        .collect();

    let (users, others): (Vec<StoredMessage>, Vec<StoredMessage>) = deduped
        .into_iter()
        .partition(|message| message.role == "user");
    users.into_iter().chain(others).take(10).collect()
}

/// `.replace(/[?.!]+$/, '')`.
fn strip_trailing_punctuation(value: &str) -> &str {
    value.trim_end_matches(['?', '.', '!'])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::messages::service::recall::testing::{conversation, stored, FakeChat};

    #[test]
    fn echo_of_the_query_is_dropped_and_user_rows_come_first() {
        let conv = conversation("WebChat", Some("p1"));
        let chat = FakeChat::returning(vec![
            stored(
                "1",
                "agent",
                "Dein Plan ist Yoga.",
                "2026-10-05T10:00:00.000Z",
            ),
            stored(
                "2",
                "user",
                "Was war mein Plan?",
                "2026-10-05T09:00:00.000Z",
            ),
            stored(
                "3",
                "user",
                "Mein Plan war Yoga",
                "2026-10-04T09:00:00.000Z",
            ),
        ]);
        let hits = recall_from_chat(Some(&chat), &conv, "Was war mein Plan?!");
        let ids: Vec<&str> = hits.iter().map(|hit| hit.id.as_str()).collect();
        assert_eq!(ids, vec!["3", "1"]);
        assert_eq!(
            chat.queries.lock().unwrap().clone(),
            vec!["Was war mein Plan?!".to_string()]
        );
    }

    #[test]
    fn repeated_agent_answers_collapse_by_fingerprint() {
        let conv = conversation("WebChat", Some("p1"));
        // Longer than 80 units, so the fingerprint covers only the shared part.
        let same = "Ja, die Regeln sind klar definiert und gelten für alle Mitglieder dieses Teams ohne jede Ausnahme.";
        let chat = FakeChat::returning(vec![
            stored("a", "agent", same, "2026-10-05T10:00:00.000Z"),
            stored(
                "b",
                "agent",
                &format!("{same} Zusatz"),
                "2026-10-05T09:00:00.000Z",
            ),
            stored("c", "system", "Anderer Text", "2026-10-05T08:00:00.000Z"),
        ]);
        let hits = recall_from_chat(Some(&chat), &conv, "Regeln?");
        let ids: Vec<&str> = hits.iter().map(|hit| hit.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "c"]);
    }

    #[test]
    fn search_failure_and_missing_port_give_no_hits() {
        let conv = conversation("WebChat", Some("p1"));
        assert!(recall_from_chat(None::<&FakeChat>, &conv, "x").is_empty());
        assert!(recall_from_chat(Some(&FakeChat::failing()), &conv, "x").is_empty());
    }

    #[test]
    fn result_is_capped_at_ten() {
        let conv = conversation("WebChat", Some("p1"));
        let rows: Vec<StoredMessage> = (0..15)
            .map(|index| {
                stored(
                    &index.to_string(),
                    "user",
                    &format!("Eintrag {index}"),
                    "2026-10-05T10:00:00.000Z",
                )
            })
            .collect();
        let chat = FakeChat::returning(rows);
        assert_eq!(recall_from_chat(Some(&chat), &conv, "Eintrag").len(), 10);
    }
}
