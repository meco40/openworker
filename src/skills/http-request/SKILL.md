---
id: http-request
emoji: 🔗
requires:
  env:
    - OPENCLAW_HTTP_SKILL_ENABLED
---

Use this skill to make arbitrary HTTP requests to external APIs.

When a user needs to call a REST API, send data to a webhook, or interact with any HTTP endpoint, use `http_request`. Supports GET, POST, PUT, DELETE, PATCH with custom headers and body.

Always validate URLs are external (not internal/localhost) before proceeding. Include relevant auth headers when needed. Show the user the response status and body.
