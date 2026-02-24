---
id: web-search
emoji: 🔎
requires:
  env:
    - BRAVE_API_KEY
---

Use this skill to perform web searches using the Brave Search API.

When a user asks for current information, news, or facts not in your training data, use `web_search` to retrieve up-to-date results. Returns titles, URLs, and snippets.

Prefer specific queries. Chain with `web_fetch` to read full article content when a snippet is insufficient.
