<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your Next.js app

This repository now runs on Next.js (App Router).

View your app in AI Studio: https://ai.studio/apps/drive/1IDnSo84qybNjnhUSlQK99l4xI7KnEPg6

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Project Structure

- `app/`: Next.js App Router entries and API route surfaces
- `src/modules/`: feature-first modules (`app-shell`, `chat`, `worker`, `telemetry`, `tasks`, `config`, `exposure`)
- `src/server/`: server-side handlers and dispatchers
- `src/shared/`: shared config, types, and utility helpers
- `tests/`: unit, integration, and contract tests

## Architecture Rules

1. UI components do not contain infrastructure execution logic.
2. API routes map request/response and delegate to server use-cases.
3. Business operations live in dedicated services/use-cases.
4. `src/shared` is consumed by modules/server, not the other way around.
5. New code should avoid `any`-first APIs and keep strict typing.

### Optional Integrations

- `GITHUB_TOKEN`: Enables authenticated GitHub skill calls (`github_query`).
- `SQLITE_DB_PATH`: Relative path to a SQLite database file for `db_query` (read-only).
- `WHATSAPP_BRIDGE_URL`: Health-checkable bridge URL (`/health`) for WhatsApp pairing.
- `IMESSAGE_BRIDGE_URL`: Health-checkable bridge URL (`/health`) for iMessage pairing.
- `MEMORY_DB_PATH`: Optional SQLite file path for persistent core memory (`/api/memory`). Defaults to `MESSAGES_DB_PATH` and then `.local/messages.db`.

Core memory (`core_memory_store` / `core_memory_recall`) is persisted server-side in SQLite and survives browser reloads and server restarts.

## Production

1. Build:
   `npm run build`
2. Start:
   `npm run start`

## Quality Gates

- Lint: `npm run lint`
- Typecheck: `npm run typecheck`
- Tests: `npm run test`
- Production build: `npm run build`
