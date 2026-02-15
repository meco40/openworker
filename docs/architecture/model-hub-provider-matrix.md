# Model Hub Provider Matrix (Production Reference)

Stand: 2026-02-10

## Ziel

Dieses Dokument fixiert die offiziell verifizierten Auth-/API-Baselines fuer den Multi-Provider Model Hub.

## Provider (11)

| Provider                | Prim. Auth       | OAuth                                                        | API Base (Healthcheck)                                           | Notes                                    |
| ----------------------- | ---------------- | ------------------------------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------- |
| OpenAI                  | API Key          | Nein                                                         | `https://api.openai.com/v1/models`                               | Standard OpenAI Platform API              |
| OpenAI Codex            | OAuth            | Ja (PKCE)                                                     | `https://api.openai.com/v1/models`                               | OAuth via öffentlicher Codex-App-ID, default Redirect `http://localhost:1455/auth/callback` |
| Google Gemini           | API Key          | Nein                                                         | Gemini SDK / GenerateContent                                     | Native Google GenAI SDK                  |
| Anthropic               | API Key          | Nein                                                         | `POST https://api.anthropic.com/v1/messages`                     | Header `x-api-key` + `anthropic-version` |
| OpenRouter              | API Key          | Ja (PKCE)                                                    | `GET https://openrouter.ai/api/v1/key`                           | OAuth ueber `/auth` + Token-Exchange     |
| xAI                     | API Key          | Nein                                                         | `GET https://api.x.ai/v1/models`                                 | API key auth                             |
| Mistral                 | API Key          | Nein                                                         | `GET https://api.mistral.ai/v1/models`                           | API key auth                             |
| Cohere                  | API Key          | Nein                                                         | `GET https://api.cohere.com/v2/models`                           | API key auth                             |
| Z.AI                    | API Key          | Nein                                                         | `POST https://api.z.ai/api/paas/v4/chat/completions`             | OpenAI-kompatibler Flow                  |
| Kimi (Moonshot)         | API Key          | Nein                                                         | `GET https://api.moonshot.cn/v1/models`                          | OpenAI-kompatible API                    |
| ByteDance ModelArk      | API Key          | Nein                                                         | `POST https://ark.cn-beijing.volces.com/api/v3/chat/completions` | Model/Endpoint-ID erforderlich           |
| GitHub Copilot / Models | OAuth oder Token | Ja (GitHub OAuth App)                                        | `GET https://api.github.com/user`                                | Fuer Account-Pairing + GitHub Identity   |

## Offizielle Quellen

- OpenAI API Auth + API Reference: https://platform.openai.com/docs/api-reference/authentication
- OpenAI OAuth (Sign-in / OAuth-kontext): https://platform.openai.com/docs/actions/authentication
- Gemini API docs: https://ai.google.dev/gemini-api/docs
- Anthropic Messages API: https://docs.anthropic.com/en/api/messages
- OpenRouter Quickstart + OAuth PKCE: https://openrouter.ai/docs/quickstart und https://openrouter.ai/docs/use-cases/oauth-pkce
- xAI API docs: https://docs.x.ai/docs/overview
- Mistral docs: https://docs.mistral.ai
- Cohere docs: https://docs.cohere.com
- Z.AI docs: https://docs.z.ai
- Kimi API docs (Moonshot): https://platform.moonshot.cn/docs/guide/start-using-kimi-api
- ByteDance/BytePlus ModelArk Auth + Endpoints: https://docs.byteplus.com/id/docs/ModelArk/Authentication und https://docs.byteplus.com/id/docs/ModelArk/API_reference
- GitHub OAuth + GitHub Models REST: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps und https://docs.github.com/en/rest/models
