//! Port of `src/server/knowledge/multilingualAliases.ts` (1-39).
//!
//! | TypeScript                                          | Rust |
//! | --------------------------------------------------- | ---- |
//! | `multilingualAliases.ts:7-19` (`MULTILINGUAL_EQUIVALENTS`) | [`multilingual_equivalents`] |
//! | `multilingualAliases.ts:26-39` (`expandMultilingualAliases`) | [`expand_multilingual_aliases`] |
//!
//! Pure function, no service dependency. Dependency of
//! `ingestion/entityExtractor.ts` (S6-owned).
//!
//! # JavaScript semantics that are reproduced explicitly
//!
//! * `new Set([alias])` preserves insertion order and `Object.entries` iterates
//!   the object literal in declaration order, so the result order is
//!   deterministic: the original alias first, then — for **every** matching
//!   German key in table order — the German word followed by its English list.
//!   `expandMultilingualAliases('friend')` therefore yields
//!   `["friend", "freund", "buddy", "freundin", "girlfriend"]` (`'friend'` is in
//!   the English list of two keys, and a repeated insertion is a no-op). The
//!   expected values in the tests below were produced with Node 24.
//! * A duplicate insertion is a no-op for a `Set`; the port checks membership
//!   before pushing, which keeps the same order *and* the same uniqueness.
//! * The comparison is `lowercase(alias) === key` — exact, never a prefix or
//!   substring match, so `'Bruderherz'` does not expand.
//!
//! # Deviation
//!
//! The table is a `&'static [(&str, &[&str])]` instead of a `Record`, so the
//! declaration order the algorithm depends on is part of the type rather than a
//! property of the object literal.

/// `MULTILINGUAL_EQUIVALENTS` (`multilingualAliases.ts:7-19`), in declaration
/// order.
pub fn multilingual_equivalents() -> &'static [(&'static str, &'static [&'static str])] {
    &[
        ("bruder", &["brother", "bro"]),
        ("schwester", &["sister", "sis"]),
        ("mutter", &["mother", "mom", "mama"]),
        ("vater", &["father", "dad", "papa"]),
        ("freund", &["friend", "buddy"]),
        ("freundin", &["girlfriend", "friend"]),
        ("projekt", &["project"]),
        ("aufgabe", &["task", "todo"]),
        ("familie", &["family"]),
        ("arbeit", &["work", "job"]),
        ("kollege", &["colleague", "coworker"]),
    ]
}

/// `expandMultilingualAliases(alias)` (`multilingualAliases.ts:26-39`).
///
/// "brother" → `["brother", "bruder", "bro"]`; an unknown word returns only
/// itself.
pub fn expand_multilingual_aliases(alias: &str) -> Vec<String> {
    let lower = alias.to_lowercase();
    let mut expanded: Vec<String> = Vec::new();
    push_unique(&mut expanded, alias);

    for (german, english) in multilingual_equivalents() {
        let matches = lower == *german || english.iter().any(|entry| *entry == lower);
        if !matches {
            continue;
        }
        push_unique(&mut expanded, german);
        for entry in *english {
            push_unique(&mut expanded, entry);
        }
    }

    expanded
}

/// `Set.add` — append only when the value is not already present.
fn push_unique(values: &mut Vec<String>, value: &str) {
    if !values.iter().any(|existing| existing == value) {
        values.push(value.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_english_word_also_yields_its_german_counterpart() {
        assert_eq!(
            expand_multilingual_aliases("brother"),
            vec!["brother", "bruder", "bro"]
        );
        assert_eq!(
            expand_multilingual_aliases("Bruder"),
            vec!["Bruder", "bruder", "brother", "bro"]
        );
    }

    #[test]
    fn a_word_in_two_tables_expands_through_both_in_table_order() {
        // `friend` is listed under `freund` and under `freundin`.
        assert_eq!(
            expand_multilingual_aliases("friend"),
            vec!["friend", "freund", "buddy", "freundin", "girlfriend"]
        );
    }

    #[test]
    fn the_original_alias_keeps_its_spelling_and_position() {
        let expanded = expand_multilingual_aliases("SIS");
        assert_eq!(expanded[0], "SIS");
        assert_eq!(expanded, vec!["SIS", "schwester", "sister", "sis"]);
    }

    #[test]
    fn an_unknown_word_returns_only_itself() {
        assert_eq!(expand_multilingual_aliases("Nata"), vec!["Nata"]);
        // Exact match, not a prefix.
        assert_eq!(
            expand_multilingual_aliases("bruderherz"),
            vec!["bruderherz"]
        );
    }

    #[test]
    fn the_table_has_the_eleven_keys_of_the_source() {
        let keys: Vec<&str> = multilingual_equivalents()
            .iter()
            .map(|(german, _)| *german)
            .collect();
        assert_eq!(
            keys,
            vec![
                "bruder",
                "schwester",
                "mutter",
                "vater",
                "freund",
                "freundin",
                "projekt",
                "aufgabe",
                "familie",
                "arbeit",
                "kollege"
            ]
        );
    }
}
