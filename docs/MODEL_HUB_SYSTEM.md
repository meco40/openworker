# Model Hub System

**Stand:** 2026-02-17

## 1. Funktionserläuterung

Der Model Hub bündelt Provider-Accounts, Pipeline-Dispatch mit Fallback, Modell-Abruf sowie OAuth-gestützte Account-Kopplung.

### Kernkonzepte

- **Provider-Katalog**: 14 unterstützte Provider (`providerCatalog.ts`)
- **Account**: Persistierter Zugang pro Provider
- **Pipeline**: Reihenfolge/Strategie für Fallback-Dispatch
- **Adapter-Registry**: Provider-spezifische Dispatch-/Fetch-Implementierungen
- **Connectivity**: Pro-Account Healthchecks

---

## 2. Architektur

### 2.1 Komponenten

- `src/server/model-hub/providerCatalog.ts`
- `src/server/model-hub/Models/registry.ts`
- `src/server/model-hub/modelFetcher.ts`
- `src/server/model-hub/runtime.ts`
- `src/server/model-hub/connectivity.ts`
- `src/server/model-hub/crypto.ts`
- `app/api/model-hub/*`

### 2.2 Unterstützte Provider (aktuell 14)

- `gemini`
- `openai`
- `openai-codex`
- `anthropic`
- `openrouter`
- `ollama`
- `lmstudio`
- `xai`
- `mistral`
- `cohere`
- `zai`
- `kimi`
- `bytedance`
- `github-copilot`

---

## 3. API-Referenz

### 3.1 Accounts

| Methode | Pfad                                         | Zweck                       |
| ------- | -------------------------------------------- | --------------------------- |
| GET     | `/api/model-hub/accounts`                    | Accounts auflisten          |
| POST    | `/api/model-hub/accounts`                    | Account anlegen             |
| DELETE  | `/api/model-hub/accounts/[accountId]`        | Account löschen             |
| GET     | `/api/model-hub/accounts/[accountId]/models` | Modelle für Account laden   |
| POST    | `/api/model-hub/accounts/[accountId]/test`   | Account-Connectivity prüfen |
| POST    | `/api/model-hub/accounts/test-all`           | Alle Accounts testen        |

### 3.2 Gateway, Pipeline, Provider, OAuth

| Methode | Pfad                            | Zweck                           |
| ------- | ------------------------------- | ------------------------------- |
| POST    | `/api/model-hub/gateway`        | Anfrage über Pipeline ausführen |
| GET     | `/api/model-hub/pipeline`       | Pipeline lesen                  |
| POST    | `/api/model-hub/pipeline`       | Pipeline speichern              |
| PUT     | `/api/model-hub/pipeline`       | Pipeline ersetzen               |
| GET     | `/api/model-hub/providers`      | Provider-Katalog laden          |
| GET     | `/api/model-hub/oauth/start`    | OAuth starten                   |
| GET     | `/api/model-hub/oauth/callback` | OAuth Callback verarbeiten      |

---

## 4. Konfiguration (Auswahl)

| Variable                   | Zweck                                     |
| -------------------------- | ----------------------------------------- |
| `MODEL_HUB_ENCRYPTION_KEY` | Verschlüsselung gespeicherter Secrets     |
| `OPENAI_API_KEY`           | OpenAI API-Key                            |
| `ANTHROPIC_API_KEY`        | Anthropic API-Key                         |
| `GEMINI_API_KEY`           | Gemini API-Key                            |
| `OPENROUTER_API_KEY`       | OpenRouter API-Key                        |
| `GITHUB_TOKEN`             | GitHub Token (optional, je Provider/Flow) |

Hinweis: Provider-spezifische Auth erfolgt primär über gespeicherte Account-Secrets in der Model-Hub-Persistenz.

---

## 5. Verifikation

```bash
npm run test -- tests/unit/model-hub
npm run test -- tests/integration/model-hub
npm run typecheck
npm run lint
```

---

## 6. Siehe auch

- `docs/architecture/model-hub-provider-matrix.md`
- `docs/API_REFERENCE.md`
- `docs/CORE_HANDBOOK.md`
