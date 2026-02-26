---
id: playwright-cli
emoji: 🎭
os:
  - darwin
  - linux
  - win32
---

Use this skill when browser tasks should run through the Playwright CLI directly (CLI-first flow).

Prefer `playwright_cli` over MCP browser tooling when the goal is test automation, trace/report inspection, or reproducible CI-like execution.

Examples:

- run focused tests: `args: ["test", "tests/e2e/login.spec.ts"]`
- open traces: `args: ["show-trace", "trace.zip"]`
- generate interactions: `args: ["codegen", "https://example.com"]`

Keep commands scoped to the current workspace and use explicit arguments for deterministic runs.
