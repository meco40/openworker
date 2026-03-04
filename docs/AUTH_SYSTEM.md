# Auth System

## Metadata

- Purpose: Verbindliche Referenz fuer Authentifizierung, User-Kontext-Aufloesung und Auth-Runtime-Modi.
- Scope: NextAuth-Route, Session/JWT-Strategie, Fallback-Principal, zentrale Auth-Module.
- Source of Truth: This is the active system documentation for this domain and overrides archived documents on conflicts.
- Last Reviewed: 2026-03-04
- Related Runbooks: docs/runbooks/chat-cli-smoke-approval.md

---

## 1. Aktueller IST-Zustand

Das System nutzt NextAuth mit Credentials-Provider und JWT-Sessionstrategie.

- API-Entry: `app/api/auth/[...nextauth]/route.ts`
- NextAuth-Konfiguration: `src/auth.ts`
- Request-Auth-Resolver: `src/server/auth/userContext.ts`
- Route-Wrapper fuer API-Guards: `app/api/_shared/withUserContext.ts`
- Principal-Fallback: `src/server/auth/principal.ts`

Die Route exportiert `GET` und `POST` ueber denselben NextAuth-Handler.

## 2. Auth-Modi

### 2.1 `REQUIRE_AUTH=true`

- Requests ohne valide Session sind `401 Unauthorized`.
- `resolveRequestUserContext()` liefert nur dann einen Kontext, wenn Session-User-ID vorhanden ist.

### 2.2 `REQUIRE_AUTH=false`

- Das System erlaubt einen Fallback auf einen Single-Principal.
- Fallback-User:
  - `PRINCIPAL_USER_ID` (wenn gesetzt)
  - sonst `legacy-local-user` (`LEGACY_LOCAL_USER_ID`)

Damit bleibt das lokale/dev-nahe Arbeiten ohne erzwungenen Login moeglich.

## 3. API-Referenz

| Methode | Pfad                      | Zweck                                  |
| ------- | ------------------------- | -------------------------------------- |
| GET     | `/api/auth/[...nextauth]` | NextAuth Session/Provider Flows (read) |
| POST    | `/api/auth/[...nextauth]` | Login/Callback-Flows ueber NextAuth    |

Hinweis: Fachliche Autorisierung fuer API-Routen erfolgt domain-spezifisch ueber die Wrapper `withUserContext(...)` bzw. `withResolvedUserContext(...)`, die intern auf `resolveRequestUserContext()` aufbauen.

## 4. Relevante Konfiguration

| Variable            | Bedeutung                                      |
| ------------------- | ---------------------------------------------- |
| `REQUIRE_AUTH`      | Erzwingt Session-Auth bei API-Zugriffen        |
| `NEXTAUTH_SECRET`   | Primarer Signatur-Secret fuer NextAuth JWT     |
| `AUTH_SECRET`       | Fallback-Secret, falls `NEXTAUTH_SECRET` fehlt |
| `PRINCIPAL_USER_ID` | Optionaler Fallback-Principal im offenen Modus |

## 5. Verifikation

```bash
rg -n "NextAuth|authOptions|Credentials" src/auth.ts app/api/auth/[...nextauth]/route.ts
rg -n "resolveRequestUserContext|REQUIRE_AUTH|LEGACY_LOCAL_USER_ID" src/server/auth
rg -n "withUserContext|withResolvedUserContext" app/api
npm run typecheck
npm run lint
```

## 6. Siehe auch

- `docs/SECURITY_SYSTEM.md`
- `docs/SESSION_MANAGEMENT.md`
- `docs/API_REFERENCE.md`
