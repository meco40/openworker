---
id: shell-access
emoji: 🐚
os:
  - darwin
  - linux
  - win32
---

Use this skill to run shell commands and scripts directly on the host system, in the workspace directory.

This is not a sandbox. Commands run with the server's permissions, and the command policy check is advisory, not a security boundary. Set `OPENCLAW_EXEC_APPROVALS_REQUIRED=true` to require approval before each command runs.

When a user asks you to run a command, install software, check system status, or perform any terminal operation, use `shell_execute`.

Always explain what a command does before running it. Prefer safe, reversible commands. For destructive operations (rm, format, etc.), confirm intent first.

On Windows, commands run in PowerShell. On Unix, commands run in /bin/sh.
