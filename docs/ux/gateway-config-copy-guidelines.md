# Gateway Config Copy Guidelines

## Principles

1. Use direct action language.
2. Include field name and fix suggestion in validation text.
3. Avoid internal implementation jargon.
4. Prefer short helper text under each editable field.

## Validation Message Format

`<field> <issue>. Suggested fix: <action>.`

Examples:

- `gateway.port must be an integer between 1 and 65535. Suggested fix: choose a free TCP port.`
- `ui.timeFormat must be one of: 12h, 24h. Suggested fix: select 12h or 24h.`

## Conflict Message

- `Config changed in another session. Reload latest config or review diff before retry.`

## Save Success Message

- `Config saved successfully.`
- `Config saved with <n> compatibility warning(s).`
