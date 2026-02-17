<!--
Sync Impact Report
- Version change: 1.0.0 -> 1.1.0
- Modified principles: I. Spec-First Delivery (added Solo Lite path)
- Added sections: Solo Lite Path (within Delivery Workflow & Quality Gates)
- Removed sections: None
- Templates requiring updates:
  - ✅ .specify/templates/plan-template.md
  - ✅ .specify/templates/tasks-template.md
  - ✅ .specify/templates/spec-template.md (reviewed; no structural changes needed)
- Follow-up TODOs: None
-->

# OpenClaw Gateway Control Plane Constitution

## Core Principles

### I. Spec-First Delivery

Every non-trivial change MUST start with a feature specification in `specs/[###-feature-name]/spec.md`.
Before implementation, the engineer MUST produce `plan.md` and `tasks.md` for the same feature,
unless the change qualifies for Solo Lite Path.
Hotfixes MAY bypass this only for production incidents, but MUST be backfilled with a retroactive spec.

### II. Test-First Behavioral Changes

Behavior-changing code MUST follow red-green-refactor: write a failing test first, implement minimal code, then refactor.
`docs/` and tooling-only configuration changes MAY skip test-first, but MUST include command-level verification evidence in the change note.

### III. Security and Secret Discipline

Secrets MUST NOT be committed to source control.
Auth, session, and API-surface changes MUST include explicit abuse-case handling and safe failure behavior.
Changes touching security-sensitive paths MUST include updated runbook or ops notes when operator behavior changes.

### IV. Operability and Observability

Production-relevant features MUST preserve or improve diagnosability through logs, error context, and actionable operator guidance.
When runtime behavior changes, corresponding docs in `docs/runbooks/` or `docs/` MUST be updated in the same change.

### V. Simplicity and Modular Boundaries

Designs MUST prefer minimal, composable changes over broad refactors.
New modules MUST have a clear boundary and ownership rationale.
YAGNI applies by default: no speculative abstractions without an active requirement.

## Technical Constraints

- Primary stack is TypeScript with strict typing, Next.js/React frontend, and Node runtime services.
- New code MUST integrate with existing lint/format/type/test workflows (`npm run check`, `npm test`).
- API and contract changes SHOULD be additive; breaking behavior requires migration notes and explicit rollout guidance.
- Repository structure and existing domain boundaries (`app/`, `components/`, `lib/`, `services/`, `src/`, `tests/`) MUST be respected.

## Delivery Workflow & Quality Gates

1. Start work by creating a numbered feature branch and spec folder (`###-short-name`).
2. Validate spec quality and resolve critical clarifications before planning.
3. Produce implementation plan and task list before coding.
4. Implement in small, reviewable increments with verification evidence.
5. Before merge, run the applicable verification commands and ensure documentation alignment.

Solo Lite Path (allowed for solo development):

- Allowed only when scope is small, non-breaking, and non-security-critical.
- Required artifacts: `spec.md` with one main story, 3-5 functional requirements, 2-3 success criteria, key edge cases.
- Required plan: concise `plan.md` with summary, technical context, constitution check, and 3-7 implementation steps.
- `tasks.md` MAY be replaced by a short checklist in `plan.md` for Solo Lite changes.
- If scope grows during implementation, workflow MUST switch back to full flow.

Minimum gate before merge:

- Relevant tests pass (`npm test` or scoped subset for changed behavior)
- Static checks pass for changed scope (`npm run typecheck`, lint/format as applicable)
- Updated docs/spec artifacts are committed when behavior/process changed

## Governance

This constitution overrides informal workflow preferences for this repository.
All reviews MUST validate compliance with these principles.

Amendment policy:

- Propose amendments in a dedicated change that explains rationale and migration impact.
- Approve amendments through normal code review with at least one maintainer sign-off.

Versioning policy:

- MAJOR for incompatible governance changes or principle removals/redefinitions
- MINOR for new principles or materially expanded requirements
- PATCH for clarifications without semantic policy changes

Compliance expectations:

- Each feature plan SHOULD include an explicit constitution check.
- Non-compliant exceptions MUST be documented with scope and expiry.

**Version**: 1.1.0 | **Ratified**: 2026-02-15 | **Last Amended**: 2026-02-15
