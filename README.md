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

### Optional Integrations

- `GITHUB_TOKEN`: Enables authenticated GitHub skill calls (`github_query`).
- `SQLITE_DB_PATH`: Relative path to a SQLite database file for `db_query` (read-only).
- `WHATSAPP_BRIDGE_URL`: Health-checkable bridge URL (`/health`) for WhatsApp pairing.
- `IMESSAGE_BRIDGE_URL`: Health-checkable bridge URL (`/health`) for iMessage pairing.

## Production

1. Build:
   `npm run build`
2. Start:
   `npm run start`
