//! Port of `src/server/agent-v2/session/constants.ts`.

/// `QUEUE_PRIORITY.abort`. Higher values are processed first.
pub const QUEUE_PRIORITY_ABORT: i64 = 500;
/// `QUEUE_PRIORITY.approval`.
pub const QUEUE_PRIORITY_APPROVAL: i64 = 400;
/// `QUEUE_PRIORITY.steer`.
pub const QUEUE_PRIORITY_STEER: i64 = 300;
/// `QUEUE_PRIORITY.follow_up`.
pub const QUEUE_PRIORITY_FOLLOW_UP: i64 = 200;
/// `QUEUE_PRIORITY.input`.
pub const QUEUE_PRIORITY_INPUT: i64 = 100;

/// `DEFAULT_MAX_QUEUE_LENGTH`.
pub const DEFAULT_MAX_QUEUE_LENGTH: i64 = 64;
/// `MIN_QUEUE_LENGTH`.
pub const MIN_QUEUE_LENGTH: i64 = 4;
/// `MAX_QUEUE_LENGTH`.
pub const MAX_QUEUE_LENGTH: i64 = 512;
