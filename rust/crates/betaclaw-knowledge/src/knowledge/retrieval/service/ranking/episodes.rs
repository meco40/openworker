//! Port of `src/server/knowledge/retrieval/service/ranking/episodes.ts` (1-5)
//! — re-exports of the episode ranking.

pub use crate::knowledge::retrieval::ranking::episode_ranker::{
    compute_episode_age, rank_episodes_by_query,
};
