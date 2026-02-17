# Model Hub Provider Matrix (Production Reference)

Stand: 2026-02-17

## Ziel

Dieses Dokument hält die aktuellen Provider-, Auth- und Endpoint-Baselines des produktiven Model Hub fest.

## Provider (14)

| Provider                | Primäre Auth  | OAuth | API Base / Health-Orientierung             | Notes                               |
| ----------------------- | ------------- | ----- | ------------------------------------------ | ----------------------------------- |
| OpenAI                  | API Key       | Nein  | `https://api.openai.com/v1`                | Native OpenAI Adapter               |
| OpenAI Codex            | OAuth         | Ja    | `https://chatgpt.com/backend-api`          | Codex-spezifischer OAuth-Flow       |
| Google Gemini           | API Key       | Nein  | SDK-basiert                                | Native GenAI-Integration            |
| Anthropic               | API Key       | Nein  | `https://api.anthropic.com/v1`             | Native Messages API                 |
| OpenRouter              | API Key       | Ja    | `https://openrouter.ai/api/v1`             | OpenAI-kompatibel + OAuth           |
| Ollama (Local)          | none/API Key  | Nein  | `http://localhost:11434/v1`                | Lokaler OpenAI-kompatibler Endpoint |
| LM Studio (Local)       | none/API Key  | Nein  | `http://localhost:1234/v1`                 | Lokaler OpenAI-kompatibler Endpoint |
| xAI                     | API Key       | Nein  | `https://api.x.ai/v1`                      | Native xAI-Adapter                  |
| Mistral                 | API Key       | Nein  | `https://api.mistral.ai/v1`                | Native Mistral-Adapter              |
| Cohere                  | API Key       | Nein  | `https://api.cohere.com/v2`                | Native Cohere-Adapter               |
| Z.AI                    | API Key       | Nein  | `https://api.z.ai/api/paas/v4`             | OpenAI-kompatibel                   |
| Kimi Code               | API Key       | Nein  | `https://api.kimi.com/coding/v1`           | OpenAI-kompatibel                   |
| ByteDance ModelArk      | API Key       | Nein  | `https://ark.cn-beijing.volces.com/api/v3` | OpenAI-kompatibel                   |
| GitHub Copilot / Models | OAuth/API Key | Ja    | `https://api.github.com`                   | GitHub-native Adapter               |

## Quelle im Code

- Provider-Katalog: `src/server/model-hub/providerCatalog.ts`
- Adapter-Registry: `src/server/model-hub/Models/registry.ts`

## Offizielle Referenzen

- OpenAI: https://platform.openai.com/docs/api-reference
- OpenAI Codex: https://platform.openai.com/docs/guides/codex
- Gemini: https://ai.google.dev/gemini-api/docs
- Anthropic: https://docs.anthropic.com/en/api/messages
- OpenRouter: https://openrouter.ai/docs/quickstart
- Ollama: https://ollama.com/blog/openai-compatibility
- LM Studio: https://lmstudio.ai/docs/app/api/endpoints/openai
- xAI: https://docs.x.ai/docs/overview
- Mistral: https://docs.mistral.ai
- Cohere: https://docs.cohere.com
- Z.AI: https://docs.z.ai
- Kimi: https://www.kimi.com/code/docs/en/
- ByteDance/BytePlus: https://docs.byteplus.com/id/docs/ModelArk/Authentication
- GitHub Models: https://docs.github.com/en/rest/models
