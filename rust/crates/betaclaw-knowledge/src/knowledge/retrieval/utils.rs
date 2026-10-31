//! Port of `src/server/knowledge/retrieval/utils/arrayUtils.ts` (1-13).
//!
//! The TypeScript directory has no `index.ts`, so the Rust mirror is a single
//! module file instead of a directory with `mod.rs`.
//!
//! | TypeScript                              | Rust |
//! | --------------------------------------- | ---- |
//! | `utils/arrayUtils.ts:1-13` (`uniqueStrings`) | [`unique_strings`] |
//!
//! The dedup key is `normalized.toLowerCase()` while the *returned* value is
//! the trimmed original spelling, which is why the same list can hold `Max` and
//! `max` only once.

/// `uniqueStrings` from `utils/arrayUtils.ts:1-13`.
///
/// Trims every value, drops the empty ones and keeps the first spelling per
/// case-insensitive key. `String(value || '')` has no counterpart here: a Rust
/// `&str` cannot be `null`/`undefined`.
pub fn unique_strings<I, S>(values: I) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut seen: Vec<String> = Vec::new();
    let mut output: Vec<String> = Vec::new();
    for value in values {
        let normalized = value.as_ref().trim();
        if normalized.is_empty() {
            continue;
        }
        let key = normalized.to_lowercase();
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        output.push(normalized.to_string());
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicates_are_dropped_case_insensitively_and_the_first_spelling_wins() {
        assert_eq!(
            unique_strings(["Max", " max ", "MAX", "Nata", ""]),
            vec!["Max".to_string(), "Nata".to_string()]
        );
        assert_eq!(unique_strings(Vec::<String>::new()), Vec::<String>::new());
        assert_eq!(unique_strings(["   "]), Vec::<String>::new());
    }
}
