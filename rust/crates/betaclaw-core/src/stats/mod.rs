//! Port of `src/server/stats/` (S12). Submodules name their TypeScript source.
//!
//! Ported here: the pure logic, the SQLite repositories, the engineering
//! migrations 009 to 012 ([`engineering_migrations`]), the OpenRouter price fetch
//! over [`crate::model_hub::http::HttpTransport`], and the engineering signal
//! reads behind the master and task traits ([`engineering_signal_sources`]).
//! Not ported on purpose: the master repository (S9) and the tasks tables (S10)
//! that implement those traits, and the process-wide singletons
//! (`getTokenUsageRepository` and friends), which belong to `state.rs`.

use serde::Serialize;

/// A closed set of strings that the TypeScript side stores verbatim.
macro_rules! string_enum {
    ($name:ident { $($variant:ident = $text:literal),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, ::serde::Serialize)]
        pub enum $name {
            $(
                #[serde(rename = $text)]
                $variant,
            )+
        }

        impl $name {
            pub fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $text,)+
                }
            }

            pub fn parse(value: &str) -> Option<Self> {
                match value {
                    $($text => Some(Self::$variant),)+
                    _ => None,
                }
            }
        }
    };
}

// Path-based re-export, so `clawhub` can use the same macro.
pub(crate) use string_enum;

pub mod engineering_metrics;
pub mod engineering_metrics_service;
pub mod engineering_migrations;
pub mod engineering_signal_sources;
pub mod engineering_snapshot_repository;
pub mod harness_rollout;
pub mod openrouter_pricing;
pub mod pr_risk;
pub mod prompt_audit;
pub mod prompt_dispatch;
pub mod prompt_dispatch_diagnostics;
pub mod token_usage;
pub mod util;
pub mod xai_pricing;

/// Price of one model, shared by the OpenRouter and xAI pricing modules.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPricing {
    pub prompt_price_per_token_usd: f64,
    pub completion_price_per_token_usd: f64,
    pub request_price_usd: f64,
}

#[derive(Debug, thiserror::Error)]
pub enum StatsError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("windowDays must be 7 or 30")]
    InvalidWindowDays,
}

/// `process.env.STATS_DB_PATH || '.local/stats.db'`.
pub fn default_stats_db_path() -> String {
    std::env::var("STATS_DB_PATH")
        .ok()
        .filter(|path| !path.trim().is_empty())
        .unwrap_or_else(|| crate::db::default_db_path("stats.db"))
}
