# OpenAI Worker Local Runbook

## Prerequisites

- Node dependencies installed (`npm install`)
- Python sidecar venv present at `services/openai_worker/.venv`
- `OPENAI_API_KEY` set

## Start Stack

1. Start sidecar:

```powershell
cd services/openai_worker
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8011
```

2. Start gateway/web:

```powershell
npm run dev
```

## Required Env

- `WORKER_RUNTIME=openai`
- `OPENAI_WORKER_SIDECAR_URL=http://127.0.0.1:8011`
- `OPENAI_WORKER_TOKEN=<shared-token>`
- `OPENAI_WORKER_ALLOWED_MCP_SERVERS=<comma-separated-server-ids>`
- `OPENAI_WORKER_MCP_SERVER_URLS={"<server-id>":"https://mcp-host/path"}`
- `GITHUB_TOKEN=<optional-github-token-for-write-actions>`

## Tool Activation (Enable/Disable)

All OpenAI worker tools are disabled by default and can be toggled immediately via API:

1. List tools:

```bash
curl -X GET http://127.0.0.1:3000/api/worker/openai/tools
```

2. Enable a tool:

```bash
curl -X PATCH http://127.0.0.1:3000/api/worker/openai/tools \
  -H "Content-Type: application/json" \
  -d '{"id":"github","enabled":true}'
```

3. Disable a tool:

```bash
curl -X PATCH http://127.0.0.1:3000/api/worker/openai/tools \
  -H "Content-Type: application/json" \
  -d '{"id":"github","enabled":false}'
```

Available tool ids:

- `shell`
- `browser`
- `files`
- `github`
- `mcp`
- `computerUse`

## Tool Behavior Summary

- `safe_shell`: executes shell commands with timeout/output limits and dangerous-command blocking.
- `safe_browser`: fetches URLs, extracts title/text, and can extract links.
- `safe_files`: read/write with optional root jail via `OPENAI_WORKER_FILES_ROOT`.
- `safe_github`: supports read operations (`get_repo`, `list_issues`, `get_issue`, `list_pull_requests`, `get_pull_request`, `list_commits`, `search_repositories`) and `create_issue` with token.
- `safe_mcp`: forwards allowlisted MCP actions to configured endpoints.
- `safe_computer_use`: guarded actions with HITL for destructive intents; includes browser-backed `open_url` and `extract_links`.

## Smoke Checks

- `GET /health` on sidecar returns `{ "ok": true }`
- `POST /runs/start` with all six `enabledTools` can complete successfully
- Create a worker task and verify status transitions:
  - `planning` -> `executing` -> `completed` or `waiting_approval`

## Rollback

Set `WORKER_RUNTIME=legacy` and restart gateway process.
