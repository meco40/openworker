---
id: multi-tool-use-parallel
emoji: ⚡
os:
  - darwin
  - linux
  - win32
---

Use this skill to execute multiple tool calls in parallel within a single response turn.

When you need to call several independent tools at once (e.g., reading multiple files, running multiple searches), use `multi_tool_use_parallel` to batch them. This significantly reduces latency.

Only use for truly independent operations — do not batch calls where the result of one is needed as input to another.
