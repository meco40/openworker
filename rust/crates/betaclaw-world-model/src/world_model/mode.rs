//! Port of `src/server/world-model/mode.ts:1-49` — the single World-Model mode plus
//! the legacy flag switches it supersedes.
//!
//! # Verified JavaScript detail
//!
//! `mode.ts:33` tests `normalized in MODE_ALIASES`. `in` walks the prototype
//! chain, so `WORLD_MODEL_MODE=toString` (or `constructor`, `valueOf`, …) is
//! *reported as a key* and `MODE_ALIASES['toString']` yields
//! `Object.prototype.toString` — a function, not a mode. The TypeScript then
//! returns that function from `parseWorldModelMode`, and every downstream
//! predicate (`isWorldModelActive` and friends) compares it against string
//! literals, so the effective behaviour is "not active".
//!
//! The port has an enum instead of a string union, so it cannot reproduce the
//! leak. It resolves a prototype name like `toString` to
//! [`WorldModelMode::Off`], which is the behaviour the TypeScript exhibits
//! downstream. Pinned by `tests::prototype_names_fall_back_to_off`.

/// `WorldModelMode` from `mode.ts:1`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WorldModelMode {
    Off,
    Shadow,
    Required,
    Canonical,
}

/// `WORLD_MODEL_MODES` from `mode.ts:13-18`.
pub const WORLD_MODEL_MODES: [WorldModelMode; 4] = [
    WorldModelMode::Off,
    WorldModelMode::Shadow,
    WorldModelMode::Required,
    WorldModelMode::Canonical,
];

/// `WORLD_MODEL_DEFAULT_MODE` from `mode.ts:28`.
pub const WORLD_MODEL_DEFAULT_MODE: WorldModelMode = WorldModelMode::Off;

impl WorldModelMode {
    /// The discriminant as it appears in the TypeScript union.
    pub fn as_str(self) -> &'static str {
        match self {
            WorldModelMode::Off => "off",
            WorldModelMode::Shadow => "shadow",
            WorldModelMode::Required => "required",
            WorldModelMode::Canonical => "canonical",
        }
    }

    /// `isWorldModelActive` (`mode.ts:37-39`).
    pub fn is_active(self) -> bool {
        matches!(
            self,
            WorldModelMode::Shadow | WorldModelMode::Required | WorldModelMode::Canonical
        )
    }

    /// `isWorldModelRequired` (`mode.ts:41-43`).
    pub fn is_required(self) -> bool {
        matches!(self, WorldModelMode::Required | WorldModelMode::Canonical)
    }

    /// `isWorldModelCanonical` (`mode.ts:45-47`).
    pub fn is_canonical(self) -> bool {
        matches!(self, WorldModelMode::Canonical)
    }
}

/// `MODE_ALIASES` from `mode.ts:20-26` — the five *own* keys only.
const MODE_ALIASES: [(&str, WorldModelMode); 5] = [
    ("off", WorldModelMode::Off),
    ("disabled", WorldModelMode::Off),
    ("shadow", WorldModelMode::Shadow),
    ("required", WorldModelMode::Required),
    ("canonical", WorldModelMode::Canonical),
];

/// `parseWorldModelMode` (`mode.ts:30-35`).
pub fn parse_world_model_mode(value: Option<&str>) -> WorldModelMode {
    let Some(value) = value else {
        return WORLD_MODEL_DEFAULT_MODE;
    };
    let normalized = value.trim().to_lowercase();
    if normalized.is_empty() {
        return WORLD_MODEL_DEFAULT_MODE;
    }
    MODE_ALIASES
        .iter()
        .find(|(alias, _)| *alias == normalized)
        .map(|(_, mode)| *mode)
        .unwrap_or(WORLD_MODEL_DEFAULT_MODE)
}

/// `modeFromLegacyFlags` (`mode.ts:49-58`).
///
/// The order of the branches is the contract: `mem0PreferencesOnly` wins over
/// `ingestionBridgeEnabled`, and an installation that is neither enabled nor
/// bridged is `off` even when the bridge flag is set.
pub fn mode_from_legacy_flags(
    enabled: bool,
    ingestion_bridge_enabled: bool,
    mem0_preferences_only: bool,
) -> WorldModelMode {
    if !enabled && !ingestion_bridge_enabled {
        return WorldModelMode::Off;
    }
    if mem0_preferences_only {
        return WorldModelMode::Canonical;
    }
    if ingestion_bridge_enabled {
        return WorldModelMode::Shadow;
    }
    WorldModelMode::Off
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aliases_and_defaults_match_the_source() {
        assert_eq!(parse_world_model_mode(None), WorldModelMode::Off);
        assert_eq!(parse_world_model_mode(Some("")), WorldModelMode::Off);
        assert_eq!(parse_world_model_mode(Some("  ")), WorldModelMode::Off);
        assert_eq!(
            parse_world_model_mode(Some(" DISABLED ")),
            WorldModelMode::Off
        );
        assert_eq!(
            parse_world_model_mode(Some("Shadow")),
            WorldModelMode::Shadow
        );
        assert_eq!(
            parse_world_model_mode(Some("required")),
            WorldModelMode::Required
        );
        assert_eq!(
            parse_world_model_mode(Some("canonical")),
            WorldModelMode::Canonical
        );
        // Unknown values fall back to the default (`mode.ts:34`).
        assert_eq!(parse_world_model_mode(Some("live")), WorldModelMode::Off);
    }

    #[test]
    fn prototype_names_fall_back_to_off() {
        // `'toString' in MODE_ALIASES` is true in JavaScript (prototype chain),
        // but the value is not a mode. The port resolves it to `off`, which is
        // the behaviour the TypeScript predicates produce downstream.
        assert_eq!(
            parse_world_model_mode(Some("toString")),
            WorldModelMode::Off
        );
        assert_eq!(
            parse_world_model_mode(Some("constructor")),
            WorldModelMode::Off
        );
        assert_eq!(parse_world_model_mode(Some("valueOf")), WorldModelMode::Off);
    }

    #[test]
    fn predicates_cover_the_three_active_modes() {
        assert!(!WorldModelMode::Off.is_active());
        assert!(WorldModelMode::Shadow.is_active());
        assert!(WorldModelMode::Required.is_active());
        assert!(WorldModelMode::Canonical.is_active());

        assert!(!WorldModelMode::Shadow.is_required());
        assert!(WorldModelMode::Required.is_required());
        assert!(WorldModelMode::Canonical.is_required());

        assert!(!WorldModelMode::Required.is_canonical());
        assert!(WorldModelMode::Canonical.is_canonical());
    }

    #[test]
    fn legacy_flags_reproduce_every_branch() {
        assert_eq!(
            mode_from_legacy_flags(false, false, false),
            WorldModelMode::Off
        );
        assert_eq!(
            mode_from_legacy_flags(true, false, false),
            WorldModelMode::Off
        );
        assert_eq!(
            mode_from_legacy_flags(false, true, false),
            WorldModelMode::Shadow
        );
        assert_eq!(
            mode_from_legacy_flags(true, true, false),
            WorldModelMode::Shadow
        );
        assert_eq!(
            mode_from_legacy_flags(false, true, true),
            WorldModelMode::Canonical
        );
        assert_eq!(
            mode_from_legacy_flags(true, false, true),
            WorldModelMode::Canonical
        );
    }

    #[test]
    fn modes_are_listed_in_source_order() {
        let listed: Vec<&str> = WORLD_MODEL_MODES.iter().map(|mode| mode.as_str()).collect();
        assert_eq!(listed, vec!["off", "shadow", "required", "canonical"]);
    }
}
