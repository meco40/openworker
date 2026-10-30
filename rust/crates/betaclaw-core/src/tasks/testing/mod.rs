//! Port of `src/server/tasks/testing/`. Submodules name their TypeScript source.
//!
//! Ported: the test-job table and its state transitions (`jobs.rs`), the result
//! summary with the status and activity writes after a run (`summary.rs`), and the
//! queue with the run of each job (`queue.rs`).
//!
//! Not ported: the Playwright check of each deliverable (`deliverableTester.ts`,
//! and `service.ts:254-264`), which needs a Chromium runtime, and the CSS check
//! (`cssValidation.ts`), which needs `css-tree` and no such crate is in the
//! workspace. [`queue::DeliverableRunner`] is the seam for the browser check.

pub mod jobs;
pub mod queue;
pub mod summary;

/// The deliverable that a result belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeliverableRef {
    pub id: String,
    pub title: String,
    pub path: String,
    /// `file` or `url`.
    pub kind: String,
}

/// One deliverable's result (`src/server/tasks/testing/types.ts:13-29`). The
/// problems are kept as messages. `http_status`, `duration` and `error` are not
/// carried, because nothing in the summary reads them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TestResult {
    pub passed: bool,
    pub deliverable: DeliverableRef,
    pub console_errors: Vec<String>,
    pub css_errors: Vec<String>,
    pub resource_errors: Vec<String>,
    pub screenshot_path: Option<String>,
}
