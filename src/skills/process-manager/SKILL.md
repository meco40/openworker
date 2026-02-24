---
id: process-manager
emoji: ⚙️
os:
  - darwin
  - linux
  - win32
---

Use this skill to manage long-running processes (start, stop, monitor).

When a user wants to start a server, run a background job, or check on a running process, use the process manager functions (`process_start`, `process_stop`, `process_status`, `process_logs`).

Always check existing processes before starting new ones to avoid conflicts. Include the process logs when reporting errors.
