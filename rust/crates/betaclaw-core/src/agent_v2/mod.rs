//! Port of `src/server/agent-v2/` (S12b, persistence and signing part). Submodules
//! name their TypeScript source.
//!
//! Not ported here: `session/*` and `runtime.ts` (they call the S8 channel runtime
//! and personas), and `extensions/host.ts` and `workerHost.ts` (process lifecycle,
//! wired with the runtime later).

/// A fieldless enum whose variants are the TypeScript string literals.
///
/// Serde and the SQLite columns both use the literal text. Reading an unknown
/// text is an error here; the TypeScript side passes such a value through
/// without a check.
macro_rules! text_enum {
    ($name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub enum $name {
            $($variant),+
        }

        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$variant),+];

            pub fn as_str(self) -> &'static str {
                match self {
                    $($name::$variant => $text),+
                }
            }

            pub fn parse(text: &str) -> Option<Self> {
                Self::ALL.iter().copied().find(|value| value.as_str() == text)
            }
        }

        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(self.as_str())
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let text = <String as serde::Deserialize>::deserialize(deserializer)?;
                Self::parse(&text)
                    .ok_or_else(|| <D::Error as serde::de::Error>::custom("unknown value"))
            }
        }
    };
}

pub mod command_repository;
pub mod errors;
pub mod event_repository;
pub mod extension_repository;
pub mod extension_security;
pub mod migrations;
pub mod recovery_repository;
pub mod repository;
pub mod session;
pub mod session_repository;
pub mod signing_key_repository;
pub mod types;
pub mod utils;
