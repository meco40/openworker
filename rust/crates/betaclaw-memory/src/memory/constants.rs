//! Port of `src/server/memory/constants.ts`.

/// `MIN_CONFIDENCE` from `constants.ts:1`.
pub const MIN_CONFIDENCE: f64 = 0.1;
/// `MAX_CONFIDENCE` from `constants.ts:2`.
pub const MAX_CONFIDENCE: f64 = 1.0;
/// `MIN_IMPORTANCE` from `constants.ts:3`.
pub const MIN_IMPORTANCE: f64 = 1.0;
/// `MAX_IMPORTANCE` from `constants.ts:4`.
pub const MAX_IMPORTANCE: f64 = 5.0;
/// `FORGET_NEGATIVE_FEEDBACK_THRESHOLD` from `constants.ts:5`.
pub const FORGET_NEGATIVE_FEEDBACK_THRESHOLD: f64 = 3.0;
/// `FORGET_CONFIDENCE_THRESHOLD` from `constants.ts:6`.
pub const FORGET_CONFIDENCE_THRESHOLD: f64 = 0.15;
/// `MEM0_SCORE_THRESHOLD` from `constants.ts:7`.
pub const MEM0_SCORE_THRESHOLD: f64 = 0.3;

#[cfg(test)]
mod tests {
    use super::*;

    /// The numeric constants are part of the recall and feedback contract: a
    /// drifted threshold silently changes which memories a prompt sees.
    #[test]
    fn the_thresholds_match_the_typescript_values() {
        assert_eq!(MIN_CONFIDENCE, 0.1);
        assert_eq!(MAX_CONFIDENCE, 1.0);
        assert_eq!(MIN_IMPORTANCE, 1.0);
        assert_eq!(MAX_IMPORTANCE, 5.0);
        assert_eq!(FORGET_NEGATIVE_FEEDBACK_THRESHOLD, 3.0);
        assert_eq!(FORGET_CONFIDENCE_THRESHOLD, 0.15);
        assert_eq!(MEM0_SCORE_THRESHOLD, 0.3);
    }
}
