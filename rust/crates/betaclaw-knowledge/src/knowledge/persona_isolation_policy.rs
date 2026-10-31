//! Port of `src/server/knowledge/personaIsolationPolicy.ts` (1-57).
//!
//! | TypeScript                                          | Rust |
//! | --------------------------------------------------- | ---- |
//! | `personaIsolationPolicy.ts:9-13` (`PersonaMessage`)  | [`PersonaMessage`] |
//! | `personaIsolationPolicy.ts:15-18` (`PersonaSwitchResult`) | [`PersonaSwitchResult`] |
//! | `personaIsolationPolicy.ts:20-35` (`PersonaIsolationPolicy`) | [`PersonaIsolationPolicy`] |
//! | `personaIsolationPolicy.ts:40-57` (`createPersonaIsolationPolicy`) | [`create_persona_isolation_policy`] |
//!
//! Prevents cross-persona memory leaks. Dependency of
//! [`super::ingestion_cursor`] and of `ingestion/service.ts` (S6-owned).
//!
//! # JavaScript semantics that are reproduced explicitly
//!
//! * `if (!lastMessagePersonaId)` (`:46`) is a **truthiness** test, so `null`,
//!   `undefined` **and the empty string** all mean "no previous persona". The
//!   port takes `Option<&str>` and treats `Some("")` like `None`.
//! * `m.personaAtMessage` is filtered with `!m.personaAtMessage || …` (`:54`) —
//!   the same truthiness, so an untagged message and an empty-string tag are both
//!   kept for every persona.
//! * `switched` and `requireNewConversation` are always the same value
//!   (`:49-50`); the port keeps both fields.
//!
//! # Deviation
//!
//! The TypeScript factory returns an object literal of closures. The port is a
//! zero-sized struct with two methods and keeps
//! [`create_persona_isolation_policy`] as the name a caller knows from the
//! source; the policy holds no state in either implementation.

/// `PersonaMessage` (`personaIsolationPolicy.ts:9-13`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersonaMessage {
    pub id: String,
    pub content: String,
    pub persona_at_message: Option<String>,
}

/// `PersonaSwitchResult` (`personaIsolationPolicy.ts:15-18`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PersonaSwitchResult {
    pub switched: bool,
    pub require_new_conversation: bool,
}

/// `PersonaIsolationPolicy` (`personaIsolationPolicy.ts:20-35`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PersonaIsolationPolicy;

/// `createPersonaIsolationPolicy()` (`personaIsolationPolicy.ts:40-57`).
pub fn create_persona_isolation_policy() -> PersonaIsolationPolicy {
    PersonaIsolationPolicy
}

impl PersonaIsolationPolicy {
    /// `checkPersonaSwitch(currentPersonaId, lastMessagePersonaId)`
    /// (`personaIsolationPolicy.ts:42-51`).
    ///
    /// If a persona switch happened since the last message, a new conversation
    /// should be started.
    pub fn check_persona_switch(
        &self,
        current_persona_id: &str,
        last_message_persona_id: Option<&str>,
    ) -> PersonaSwitchResult {
        let Some(last_message_persona_id) =
            last_message_persona_id.filter(|value| !value.is_empty())
        else {
            return PersonaSwitchResult {
                switched: false,
                require_new_conversation: false,
            };
        };
        let switched = current_persona_id != last_message_persona_id;
        PersonaSwitchResult {
            switched,
            require_new_conversation: switched,
        }
    }

    /// `filterByPersona(messages, personaId)` (`personaIsolationPolicy.ts:53-55`).
    ///
    /// Messages without a `personaAtMessage` are included (legacy/untagged
    /// messages).
    pub fn filter_by_persona(
        &self,
        messages: &[PersonaMessage],
        persona_id: &str,
    ) -> Vec<PersonaMessage> {
        messages
            .iter()
            .filter(|message| match &message.persona_at_message {
                None => true,
                Some(value) => value.is_empty() || value == persona_id,
            })
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(id: &str, persona: Option<&str>) -> PersonaMessage {
        PersonaMessage {
            id: id.to_string(),
            content: id.to_string(),
            persona_at_message: persona.map(str::to_string),
        }
    }

    #[test]
    fn a_switch_needs_a_previous_persona() {
        let policy = create_persona_isolation_policy();
        let none = policy.check_persona_switch("persona-a", None);
        assert_eq!(
            none,
            PersonaSwitchResult {
                switched: false,
                require_new_conversation: false
            }
        );
        // The empty string is falsy in the source too.
        let empty = policy.check_persona_switch("persona-a", Some(""));
        assert_eq!(empty, none);
    }

    #[test]
    fn a_different_persona_requires_a_new_conversation() {
        let policy = create_persona_isolation_policy();
        let switched = policy.check_persona_switch("persona-a", Some("persona-b"));
        assert!(switched.switched);
        assert!(switched.require_new_conversation);

        let same = policy.check_persona_switch("persona-a", Some("persona-a"));
        assert!(!same.switched);
        assert!(!same.require_new_conversation);
    }

    #[test]
    fn untagged_and_empty_tagged_messages_pass_every_filter() {
        let policy = create_persona_isolation_policy();
        let messages = vec![
            message("untagged", None),
            message("empty", Some("")),
            message("mine", Some("persona-a")),
            message("foreign", Some("persona-b")),
        ];
        let filtered = policy.filter_by_persona(&messages, "persona-a");
        let kept: Vec<&str> = filtered.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(kept, vec!["untagged", "empty", "mine"]);
    }
}
