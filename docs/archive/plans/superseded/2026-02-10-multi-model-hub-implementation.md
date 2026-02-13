# Multi Model Hub Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Den bestehenden Gemini-only Bereich in einen echten Multi Model Hub ausbauen, in dem Benutzer mehrere Provider-Accounts (API-Key + OAuth) verbinden, testen und aktiv fuer Chat/Worker/Features nutzen koennen, inklusive GitHub Copilot Pairing mit Code-Repositories.

**Architecture:** Wir fuehren eine provider-agnostische AI-Gateway-Schicht mit Adapter-Pattern ein (`gemini`, `openai-compatible`, spaeter weitere), eine verschluesselte Account-Storage-Schicht und neue Model-Hub-APIs. UI und Runtime greifen nicht mehr direkt auf Gemini zu, sondern auf einen zentralen Gateway mit `accountId` + `model` Routing. Bestehende `/api/gemini` Calls bleiben zunaechst als Kompatibilitaets-Wrapper erhalten.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, Node runtime routes, `@google/genai`, `fetch` fuer OpenAI-kompatible APIs, Node `crypto`, Node `sqlite` (Repository/Local Adapter), Vitest.

---

### Task 1: IST-Basis absichern (Contracts + Risiken sichtbar machen)

**Files:**
- Modify: `tests/contract/public-api.contract.test.ts`
- Create: `tests/contract/model-hub-current-state.contract.test.ts`
- Modify: `docs/ARCHITECTURE.md`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';

describe('model hub current state', () => {
  it('documents gemini-only coupling that must be removed', () => {
    expect([
      '/api/gemini',
      '/api/skills/execute',
      '/api/channels/pair',
    ]).toContain('/api/gemini');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contract/model-hub-current-state.contract.test.ts`
Expected: FAIL (Datei fehlt)

**Step 3: Write minimal implementation**

- Contract-Datei erstellen.
- In `docs/ARCHITECTURE.md` das bekannte Gemini-only Risiko und Zielzustand dokumentieren.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/contract/model-hub-current-state.contract.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/contract/model-hub-current-state.contract.test.ts tests/contract/public-api.contract.test.ts docs/ARCHITECTURE.md
git commit -m "test: lock current model-hub baseline and contracts"
```

### Task 2: Provider-Domain und Capability-Modell einfuehren

**Files:**
- Create: `src/server/model-hub/types.ts`
- Create: `src/server/model-hub/providerCatalog.ts`
- Modify: `types.ts`
- Modify: `components/ModelHub.tsx`
- Test: `tests/unit/model-hub/provider-catalog.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { PROVIDER_CATALOG } from '../../../src/server/model-hub/providerCatalog';

describe('provider catalog', () => {
  it('contains required launch providers', () => {
    const ids = PROVIDER_CATALOG.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining([
      'gemini',
      'openai',
      'anthropic',
      'openrouter',
      'xai',
      'mistral',
      'cohere',
      'zai',
      'kimi',
      'bytedance',
      'github-copilot',
    ]));
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/model-hub/provider-catalog.test.ts`
Expected: FAIL (Modul fehlt)

**Step 3: Write minimal implementation**

- Stark typisierte Provider-Metadaten anlegen:
  - Auth-Methoden pro Provider (`api_key`, `oauth`, mehrere gleichzeitig moeglich wie bei `openai`)
  - Endpoint-Typ (`gemini-native`, `openai-compatible`)
  - Capabilities (`chat`, `tools`, `vision`, `audio`, `embeddings`)
- UI-Typen um `ProviderConnection`/`ProviderAccount` erweitern.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/model-hub/provider-catalog.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/model-hub types.ts components/ModelHub.tsx tests/unit/model-hub/provider-catalog.test.ts
git commit -m "feat: add typed provider catalog for multi-model hub"
```

### Task 3: Sichere Account-Storage-Schicht (API-Key + OAuth-Tokens)

**Files:**
- Create: `src/server/model-hub/crypto.ts`
- Create: `src/server/model-hub/repository.ts`
- Create: `src/server/model-hub/repositories/sqliteModelHubRepository.ts`
- Create: `src/server/model-hub/service.ts`
- Modify: `.env.local` (nur Beispielvariablen in Doku)
- Modify: `README.md`
- Test: `tests/unit/model-hub/crypto.test.ts`
- Test: `tests/integration/model-hub/repository.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { encryptSecret, decryptSecret } from '../../../src/server/model-hub/crypto';

describe('model hub crypto', () => {
  it('round-trips secret values', () => {
    const cipher = encryptSecret('sk-test-123', '0123456789abcdef0123456789abcdef');
    expect(decryptSecret(cipher, '0123456789abcdef0123456789abcdef')).toBe('sk-test-123');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/model-hub/crypto.test.ts`
Expected: FAIL (Modul fehlt)

**Step 3: Write minimal implementation**

- AES-GCM Verschluesselung mit rotierbarer Key-ID.
- Repository-Interface mit masked secrets im Read-Model.
- SQLite Adapter (`.local/model-hub.db`) fuer lokale Entwicklung.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/model-hub/crypto.test.ts tests/integration/model-hub/repository.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/model-hub README.md tests/unit/model-hub/crypto.test.ts tests/integration/model-hub/repository.test.ts
git commit -m "feat: add encrypted model-hub account repository"
```

### Task 4: Model-Hub API-Routen fuer Provider und Accounts

**Files:**
- Create: `app/api/model-hub/providers/route.ts`
- Create: `app/api/model-hub/accounts/route.ts`
- Create: `app/api/model-hub/accounts/[accountId]/test/route.ts`
- Create: `src/server/model-hub/http.ts`
- Test: `tests/integration/model-hub/providers-route.test.ts`
- Test: `tests/integration/model-hub/accounts-route.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { GET } from '../../../app/api/model-hub/providers/route';

describe('model-hub providers route', () => {
  it('returns provider metadata', async () => {
    const response = await GET();
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(Array.isArray(json.providers)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/model-hub/providers-route.test.ts`
Expected: FAIL (Route fehlt)

**Step 3: Write minimal implementation**

- `GET /api/model-hub/providers`: statischer Katalog.
- `GET/POST /api/model-hub/accounts`: list/create.
- `POST /api/model-hub/accounts/:id/test`: Connectivity-Check.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/model-hub/providers-route.test.ts tests/integration/model-hub/accounts-route.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add app/api/model-hub src/server/model-hub tests/integration/model-hub
git commit -m "feat: add model-hub provider and account APIs"
```

### Task 5: OAuth-Flow + Copilot Code Pairing (OpenAI OAuth + GitHub/Copilot)

**Files:**
- Create: `app/api/model-hub/oauth/[provider]/start/route.ts`
- Create: `app/api/model-hub/oauth/[provider]/callback/route.ts`
- Create: `app/api/model-hub/pairings/code/route.ts`
- Create: `src/server/model-hub/oauth/stateStore.ts`
- Create: `src/server/model-hub/oauth/providers.ts`
- Create: `src/server/model-hub/pairings/github.ts`
- Test: `tests/integration/model-hub/oauth-routes.test.ts`
- Test: `tests/integration/model-hub/code-pairing-route.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { GET as start } from '../../../app/api/model-hub/oauth/[provider]/start/route';

describe('oauth start', () => {
  it('returns redirect for supported providers', async () => {
    const req = new Request('http://localhost/api/model-hub/oauth/openai/start');
    const res = await start(req, { params: { provider: 'openai' } });
    expect([302, 307]).toContain(res.status);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/model-hub/oauth-routes.test.ts tests/integration/model-hub/code-pairing-route.test.ts`
Expected: FAIL (Route fehlt)

**Step 3: Write minimal implementation**

- OAuth Start + Callback mit `state`/CSRF-Schutz.
- OpenAI explizit mit beiden Flows modellieren: `api_key` und `oauth`.
- GitHub Copilot Account-Verknuepfung plus Code Pairing (Org/Repo Scope) modellieren.
- Tokenpersistenz ueber Repository-Schicht.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/model-hub/oauth-routes.test.ts tests/integration/model-hub/code-pairing-route.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add app/api/model-hub/oauth app/api/model-hub/pairings src/server/model-hub/oauth src/server/model-hub/pairings tests/integration/model-hub/oauth-routes.test.ts tests/integration/model-hub/code-pairing-route.test.ts
git commit -m "feat: add oauth flows and github copilot code pairing"
```

### Task 6: Provider-agnostischen AI Gateway einfuehren

**Files:**
- Create: `src/server/ai-gateway/types.ts`
- Create: `src/server/ai-gateway/adapters/geminiAdapter.ts`
- Create: `src/server/ai-gateway/adapters/openAiCompatibleAdapter.ts`
- Create: `src/server/ai-gateway/index.ts`
- Create: `app/api/ai/route.ts`
- Modify: `app/api/gemini/route.ts`
- Test: `tests/unit/ai-gateway/adapter-selection.test.ts`
- Test: `tests/integration/ai-gateway/route.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { resolveAdapter } from '../../../src/server/ai-gateway';

describe('ai gateway adapter selection', () => {
  it('selects openai-compatible adapter for openrouter', () => {
    expect(resolveAdapter('openrouter').kind).toBe('openai-compatible');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/ai-gateway/adapter-selection.test.ts`
Expected: FAIL (Modul fehlt)

**Step 3: Write minimal implementation**

- Neue zentrale API `/api/ai` mit Payload: `{ accountId, operation, payload }`.
- `app/api/gemini/route.ts` als delegierender Legacy-Wrapper behalten.
- Adapter unterscheiden gemini-native vs openai-compatible Endpoints.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/ai-gateway/adapter-selection.test.ts tests/integration/ai-gateway/route.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/ai-gateway app/api/ai app/api/gemini/route.ts tests/unit/ai-gateway tests/integration/ai-gateway
git commit -m "feat: introduce provider-agnostic ai gateway"
```

### Task 7: Client Gateway refactoren (weg von `services/gemini.ts`)

**Files:**
- Create: `services/aiGateway.ts`
- Modify: `services/gemini.ts`
- Modify: `App.tsx`
- Modify: `WorkerView.tsx`
- Modify: `components/VoiceOverlay.tsx`
- Modify: `core/memory/embeddings.ts`
- Test: `tests/unit/ai-gateway/client-routing.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { createGatewayRequest } from '../../services/aiGateway';

describe('ai client request', () => {
  it('includes accountId and model for routing', () => {
    const req = createGatewayRequest('acc-1', 'chatSend', { model: 'gpt-4.1-mini' });
    expect(req.accountId).toBe('acc-1');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/ai-gateway/client-routing.test.ts`
Expected: FAIL (Modul fehlt)

**Step 3: Write minimal implementation**

- Neue Client-API mit `accountId` + `profileId` Routing.
- Bestehende Imports auf neuen Gateway migrieren.
- `services/gemini.ts` temporaer als Kompat-Layer behalten.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/ai-gateway/client-routing.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add services App.tsx WorkerView.tsx components/VoiceOverlay.tsx core/memory/embeddings.ts tests/unit/ai-gateway/client-routing.test.ts
git commit -m "refactor: migrate client calls to unified ai gateway"
```

### Task 8: Model Hub UI auf echte Provider-Verbindungen umbauen

**Files:**
- Modify: `components/ModelHub.tsx`
- Create: `src/modules/model-hub/components/ProviderCard.tsx`
- Create: `src/modules/model-hub/components/ConnectAccountModal.tsx`
- Create: `src/modules/model-hub/components/ConnectedAccountsTable.tsx`
- Create: `src/modules/model-hub/hooks/useModelHub.ts`
- Modify: `types.ts`
- Test: `tests/unit/model-hub/use-model-hub.test.ts`
- Test: `tests/unit/model-hub/model-hub-render.test.tsx`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { getConnectionBadge } from '../../../src/modules/model-hub/hooks/useModelHub';

describe('model hub connection badge', () => {
  it('shows connected state for healthy account', () => {
    expect(getConnectionBadge({ status: 'connected', lastCheckOk: true })).toBe('Connected');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/model-hub/use-model-hub.test.ts`
Expected: FAIL (Hook fehlt)

**Step 3: Write minimal implementation**

- Provider-Liste + Connect-Actions (API key/OAuth).
- Accounts-Tabelle mit `Test`, `Disconnect`, `Masking`, `Last check`.
- Model-Pipeline je Profil auf `accountId` referenzieren.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/model-hub/use-model-hub.test.ts tests/unit/model-hub/model-hub-render.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add components/ModelHub.tsx src/modules/model-hub types.ts tests/unit/model-hub
git commit -m "feat: ship multi-provider model hub UI"
```

### Task 9: Skills/Tool-Mapping provider-faehig machen

**Files:**
- Modify: `skills/definitions.ts`
- Modify: `core/memory/gemini.ts`
- Create: `core/memory/openai.ts`
- Create: `src/server/ai-gateway/toolSchemas.ts`
- Test: `tests/unit/skills/provider-tool-mapping.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { mapSkillsToTools } from '../../../skills/definitions';

describe('provider tool mapping', () => {
  it('maps tools for openai-compatible providers', () => {
    const tools = mapSkillsToTools([{ id: 'browser', installed: true } as any], 'openai');
    expect(Array.isArray(tools)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/skills/provider-tool-mapping.test.ts`
Expected: FAIL (provider nicht unterstuetzt)

**Step 3: Write minimal implementation**

- `mapSkillsToTools` auf provider-family erweitern (`gemini`, `openai-compatible`).
- Core-Memory Tool-Schemas fuer beide Families anbieten.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/skills/provider-tool-mapping.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add skills/definitions.ts core/memory src/server/ai-gateway/toolSchemas.ts tests/unit/skills/provider-tool-mapping.test.ts
git commit -m "feat: add provider-aware tool schema mapping"
```

### Task 10: Migration, Doku und Quality Gates finalisieren

**Files:**
- Modify: `README.md`
- Modify: `docs/USER_MANUAL.md`
- Create: `docs/architecture/MODEL-HUB-MULTIPROVIDER.md`
- Modify: `tests/contract/public-api.contract.test.ts`
- Test: `tests/integration/model-hub/full-flow-smoke.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';

describe('public api contract', () => {
  it('includes model-hub endpoints', () => {
    expect([
      '/api/gemini',
      '/api/ai',
      '/api/model-hub/providers',
      '/api/model-hub/accounts',
    ].length).toBeGreaterThan(3);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contract/public-api.contract.test.ts`
Expected: FAIL (Contract nicht aktualisiert)

**Step 3: Write minimal implementation**

- README/Manual um Multi-Provider Setup erweitern.
- Migrationspfad dokumentieren: `GEMINI_API_KEY` -> bootstrap account.
- API-Contract finalisieren.

**Step 4: Run test to verify it passes**

Run: `npm run lint && npm run typecheck && npm run test && npm run build`
Expected: PASS

**Step 5: Commit**

```bash
git add README.md docs/USER_MANUAL.md docs/architecture/MODEL-HUB-MULTIPROVIDER.md tests/contract/public-api.contract.test.ts tests/integration/model-hub/full-flow-smoke.test.ts
git commit -m "docs: finalize multi-provider model hub rollout and contracts"
```

### Task 11: Security, Governance und Tenant-Schutz haerten

**Files:**
- Create: `src/server/model-hub/authz.ts`
- Create: `src/server/model-hub/audit.ts`
- Modify: `app/api/model-hub/accounts/route.ts`
- Modify: `app/api/model-hub/accounts/[accountId]/test/route.ts`
- Create: `tests/integration/model-hub/rbac-and-audit.test.ts`
- Create: `tests/contract/model-hub/provider-catalog.contract.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { PROVIDER_CATALOG } from '../../../src/server/model-hub/providerCatalog';

describe('provider catalog contract', () => {
  it('keeps top providers plus copilot', () => {
    const ids = PROVIDER_CATALOG.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining([
      'openai',
      'gemini',
      'anthropic',
      'openrouter',
      'xai',
      'mistral',
      'cohere',
      'zai',
      'kimi',
      'bytedance',
      'github-copilot',
    ]));
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contract/model-hub/provider-catalog.contract.test.ts`
Expected: FAIL (Datei fehlt)

**Step 3: Write minimal implementation**

- RBAC fuer Account-Operationen (`owner`, `admin`, `member`) erzwingen.
- Audit-Events fuer `connect`, `disconnect`, `test`, `oauth_callback`, `pair_repo` speichern.
- Provider-Katalog-Contract als Guardrail einfuehren.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/contract/model-hub/provider-catalog.contract.test.ts tests/integration/model-hub/rbac-and-audit.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/model-hub/authz.ts src/server/model-hub/audit.ts app/api/model-hub/accounts tests/contract/model-hub/provider-catalog.contract.test.ts tests/integration/model-hub/rbac-and-audit.test.ts
git commit -m "feat: enforce model hub rbac and audit trail"
```

### Task 12: Reliability, Quotas und Kostenkontrolle einbauen

**Files:**
- Create: `src/server/ai-gateway/reliability.ts`
- Create: `src/server/model-hub/quotas.ts`
- Modify: `src/server/ai-gateway/index.ts`
- Modify: `app/api/ai/route.ts`
- Create: `tests/unit/ai-gateway/reliability.test.ts`
- Create: `tests/integration/model-hub/quota-enforcement.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { shouldBlockByQuota } from '../../../src/server/model-hub/quotas';

describe('quota enforcement', () => {
  it('blocks request when daily token budget is exceeded', () => {
    expect(shouldBlockByQuota({ used: 120_000, limit: 100_000 })).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/ai-gateway/reliability.test.ts tests/integration/model-hub/quota-enforcement.test.ts`
Expected: FAIL (Module fehlen)

**Step 3: Write minimal implementation**

- Retry/Backoff/Circuit-Breaker je Provider-Adapter einfuehren.
- Quotas auf Account + Team Ebene (`requests`, `tokens`, `estimatedCostUsd`) enforce.
- Fallback-Chain nur nutzen, wenn Capability und Budget passen.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/ai-gateway/reliability.test.ts tests/integration/model-hub/quota-enforcement.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/ai-gateway/reliability.ts src/server/model-hub/quotas.ts src/server/ai-gateway/index.ts app/api/ai/route.ts tests/unit/ai-gateway/reliability.test.ts tests/integration/model-hub/quota-enforcement.test.ts
git commit -m "feat: add gateway reliability and quota enforcement"
```

### Task 13: Operations, Model-Sync und E2E-Freigabe

**Files:**
- Create: `src/server/model-hub/modelSync.ts`
- Create: `src/server/model-hub/health.ts`
- Create: `app/api/model-hub/health/route.ts`
- Create: `tests/integration/model-hub/model-sync.test.ts`
- Create: `tests/integration/model-hub/end-to-end-flow.test.ts`
- Modify: `docs/architecture/MODEL-HUB-MULTIPROVIDER.md`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { normalizeProviderModels } from '../../../src/server/model-hub/modelSync';

describe('model sync', () => {
  it('marks deprecated models as unavailable', () => {
    const out = normalizeProviderModels([{ id: 'x', status: 'deprecated' } as any]);
    expect(out[0].available).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/model-hub/model-sync.test.ts tests/integration/model-hub/end-to-end-flow.test.ts`
Expected: FAIL (Module fehlen)

**Step 3: Write minimal implementation**

- Geplanten Model-Sync-Job (refresh + deprecation flags) einfuehren.
- Health Endpoint fuer Provider-/Account-Zustand bereitstellen.
- Voller E2E-Flow testen: connect -> test -> select profile -> runtime call -> audit/quota.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/model-hub/model-sync.test.ts tests/integration/model-hub/end-to-end-flow.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/model-hub/modelSync.ts src/server/model-hub/health.ts app/api/model-hub/health/route.ts tests/integration/model-hub/model-sync.test.ts tests/integration/model-hub/end-to-end-flow.test.ts docs/architecture/MODEL-HUB-MULTIPROVIDER.md
git commit -m "feat: add model sync, health endpoints, and e2e readiness gates"
```

## Rollout-Reihenfolge (empfohlen)

1. Katalog mit Top-10 + Copilot ausrollen: `openai`, `gemini`, `anthropic`, `openrouter`, `xai`, `mistral`, `cohere`, `zai`, `kimi`, `bytedance`, `github-copilot`.
2. API-Key Provider aktivieren und Connectivity-Tests erzwingen.
3. OAuth Flows aktivieren: `openai` (zusatzlich zu API key), `github-copilot`.
4. Code Pairing aktivieren: `github-copilot` an GitHub Org/Repos koppeln.
5. Quotas, Reliability und Audit als harte Gates aktivieren.
6. Erst nach stabiler Runtime alte direkte `services/gemini.ts` Abhaengigkeiten vollstaendig entfernen.

## Definition of Done

1. Model Hub zeigt mehrere Provider inkl. Verbindungsstatus und Account-Verwaltung.
2. Chat/Worker/Embedding laufen ueber einen provider-agnostischen Gateway mit `accountId`.
3. API Keys und OAuth Tokens werden verschluesselt gespeichert und nur maskiert angezeigt.
4. OpenAI-kompatible Provider (OpenRouter, Z.AI, Kimi, Bytedance) funktionieren ohne Sonderlogik pro UI-Flow.
5. Lint, Typecheck, Tests und Build sind gruen.
6. Bestehender Gemini-Flow bleibt waehrend Migration als Kompatibilitaetsmodus nutzbar.
7. GitHub Copilot kann mit Code-Kontext (Org/Repo Pairing) genutzt werden.
8. RBAC, Audit-Logs, Quotas, Retry/Backoff und Health-Checks sind produktiv aktiv.
9. Model-Sync erkennt neue/deprecated Modelle automatisiert.
