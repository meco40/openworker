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

## Smoke Checks

- `GET /health` on sidecar returns `{ "ok": true }`
- Create a worker task and verify status transitions:
  - `planning` -> `executing` -> `completed` or `waiting_approval`

## Rollback

Set `WORKER_RUNTIME=legacy` and restart gateway process.
