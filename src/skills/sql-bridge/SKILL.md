---
id: sql-bridge
emoji: 🗄️
requires:
  env:
    - SQLITE_DB_PATH
---

Use this skill to query SQLite databases using SQL.

When a user asks questions that can be answered by querying a database, use `db_query`. The database path is configured via `SQLITE_DB_PATH`.

Only SELECT queries are permitted (read-only). Always use parameterized arguments when filtering by user input. Explain results in natural language after running queries.
