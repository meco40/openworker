---
id: subagents
emoji: 🤖
os:
  - darwin
  - linux
  - win32
---

Use this skill to spawn sub-agents that handle complex, long-running tasks autonomously.

When a task is too complex for a single response or requires multiple sequential steps, delegate it with `subagents` action `spawn`. The subagent receives its own system prompt and conversation context.

Use `subagents` action `profiles` to inspect available agent profiles and their default tools/skills before spawning.

Good use cases: multi-step research, iterative code writing, data pipeline execution. Keep subagent prompts focused and give clear success criteria.
