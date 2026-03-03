# Next.js Code- und Architektur-Review

- **Datum:** 2026-03-03
- **Projekt:** `D:\web\clawtest`
- **Scope:** Next.js App Router + API Layer + Kern-Frontend + Infrastruktur-Anbindung
- **Verifikation:** `npm run check`, `npm test`, `npm run build`, `npm run -s knip`

## 1) Executive Summary

- Sicherheitskritisch: Datei-Endpunkte erlauben unsichere Pfadfreigabe (`startsWith`) plus Shell-Execution mit interpoliertem Pfad.
- Auth-Zustand ist uneinheitlich: `proxy` schützt nur ein API-Subset, Auth-Fallbacks sind env-abhängig und können unbeabsichtigt offen laufen.
- Webhook-Authentifizierung ist fail-open, wenn Secrets fehlen (`verify*` gibt `true` zurück).
- Input-Validierung ist inkonsistent: viele `request.json()`-Handler, aber nur wenige Zod-`safeParse`-Pfade.
- Mehrere externe/critical `fetch`-Calls laufen ohne explizites Timeout/Retry-Pattern.
- Rendering ist stark CSR-lastig; RSC/Server-Fetching wird in zentralen Flows kaum genutzt.
- SSE-Broadcast ist in-memory und damit nicht horizontal skalierbar.
- Next.js-Optimierungen sind untergenutzt (`next/image`, `next/font`, segmentierte Loading/Error-Boundaries).
- Lint ist formal grün, aber mit hoher Warnlast (1432 Warnungen) und damit schwacher Signalqualität.
- Wartbarkeit leidet unter vielen ungenutzten Exports/Artefakten (knip-Befund).
- Testbasis ist stark (2094 Tests grün), aber Architektur-/Perf-Risiken werden damit nicht automatisch abgedeckt.

## 2) Architecture Map

```text
Browser
  -> / (Server Component) [auth + initial config]
     -> AppShell (Client) [view switching + dynamic imports + local/UI state]
        -> viele CSR-Fetches auf /api/*

Mission-Control Subapp
  -> /mission-control (static page -> client dashboard)
  -> /mission-control/workspace/[slug] (dynamic, client data loading + SSE)

API Layer (App Router route handlers)
  -> teils direkt DB-Zugriff in Route-Handlern
  -> teils Service-Layer (z.B. model-hub/master/channels)

Data/Infra
  -> SQLite (better-sqlite3), Filesystem, External APIs (xAI/OpenRouter/GitHub/OpenAI)
  -> SSE in-memory broadcaster

Auth
  -> NextAuth credentials + resolveRequestUserContext
  -> proxy.ts token middleware (nur matcher-Subset)
```

## 3) Findings (priorisiert)

| Kategorie | Titel                                                  | Pfad/Ort                                                                                                                                                                  | Impact   | Aufwand | Risiko | Empfehlung                                                                                                                                                                                                                                   |
| --------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E         | Unsichere Dateipfad-Prüfung + `exec`                   | `app/api/files/reveal/route.ts`, `app/api/files/preview/route.ts`                                                                                                         | High     | M       | High   | `realpath` + `path.relative` statt `startsWith`; symlink-safe allowlist; `execFile` statt `exec`. Nächster Schritt: Security-Patch + Integrationstest für Prefix-/Traversal-/Quote-Cases.                                                    |
| E         | Auth-Perimeter inkonsistent                            | `proxy.ts`, `src/server/auth/userContext.ts`, `src/auth.ts`                                                                                                               | High     | M-L     | High   | Ein zentrales Auth-Gate für alle privilegierten APIs; `proxy` auf `/api/:path*` + explizite Public-Allowlist; production fail-fast bei schwachen Auth-Secrets. Nächster Schritt: Auth-Matrix definieren und matcher/allowlist harmonisieren. |
| E         | Webhook-Verifikation fail-open bei fehlendem Secret    | `src/server/channels/webhookAuth.ts`                                                                                                                                      | High     | S       | High   | Default fail-closed; optional nur via explizitem Dev-Flag öffnen. Nächster Schritt: `if (!secret) return false` + klare Startup-Warnung/Health-Flag.                                                                                         |
| D         | Geringe Schema-Validierungsabdeckung                   | z.B. `app/api/workspaces/route.ts`, `app/api/agents/route.ts`, nur wenige Zod-Routen wie `app/api/tasks/route.ts`                                                         | High     | M       | Med    | Für alle mutierenden Endpunkte Zod-Schemas + einheitlicher Parse-Helper. Nächster Schritt: Top-20 write-Routes priorisiert auf Zod umstellen.                                                                                                |
| F         | Fehlende Timeout-Policy bei externen Calls             | `app/api/master/voice-session/route.ts`, `app/api/model-hub/oauth/callback/route.ts`, `app/api/tasks/[id]/planning/poll/route.ts`                                         | High     | S-M     | Med    | Shared `fetchWithTimeout` + Retry nur bei transienten Fehlern. Nächster Schritt: Wrapper einführen und sukzessive ausrollen.                                                                                                                 |
| B/C       | Zu CSR-lastig, RSC-Potenzial ungenutzt                 | `app/page.tsx`, `src/modules/app-shell/App.tsx`, `app/mission-control/workspace/[slug]/page.tsx`                                                                          | Med-High | L       | Med    | Initialdaten in Server Components laden; Client nur interaktiv machen. Nächster Schritt: Mission-Control Workspace initial SSR/RSC, danach AppShell-Datenfluss entkoppeln.                                                                   |
| F         | SSE nur pro Prozess (nicht horizontal robust)          | `src/lib/events.ts`, `app/api/events/stream/route.ts`                                                                                                                     | Med      | M-L     | Med    | Pub/Sub-Backplane (Redis/NATS) oder klarer Single-Node-Betriebsmodus dokumentieren. Nächster Schritt: Infrastrukturentscheidung + Adapter-Prototyp.                                                                                          |
| B/H       | Fehlende segmentierte Loading/Error-Boundaries         | `app/` (keine `loading.tsx`/`error.tsx` Segmente), nur View-Boundaries im Client                                                                                          | Med      | S-M     | Low    | Route-Segmente mit `loading.tsx`/`error.tsx` ergänzen. Nächster Schritt: zuerst `/mission-control` und `/mission-control/workspace/[slug]`.                                                                                                  |
| C         | Bild-/Font-Optimierungen ungenutzt                     | `src/modules/chat/components/ChatInputArea.tsx`, `src/modules/chat/components/ChatMessageAttachment.tsx`, `src/messenger/whatsapp/WhatsAppHandler.tsx`, `app/globals.css` | Med      | S       | Low    | `next/image` (oder sauber begründete Ausnahme), `next/font` für konsistente LCP/CLS. Nächster Schritt: 3 vorhandene `<img>`-Stellen migrieren.                                                                                               |
| A         | Route-Handler enthalten teils Business/DB-Logik direkt | `app/api/tasks/[id]/route.ts`, `app/api/workspaces/route.ts`, `app/api/agents/route.ts`                                                                                   | Med      | L       | Med    | Thin Controller + Application Services + Repository-Grenzen konsistent. Nächster Schritt: zuerst `workspaces` und `agents` in Service-Layer extrahieren.                                                                                     |
| G         | Lint-Signalqualität niedrig (1432 Warnungen)           | Repo-weit (viele Typ-Interfaces/Signaturen)                                                                                                                               | Med      | M       | Low    | Warn-Budget und gezielte Rule-Konfiguration (`unused-imports` für Typ-Signaturen). Nächster Schritt: Baseline einfrieren, pro PR abbauen.                                                                                                    |
| I         | Maintenance-Debt: viele ungenutzte Exports/Artefakte   | knip-Befund (`402 unused exports`, mehrere unused files/deps)                                                                                                             | Med      | M       | Low    | Knip-Triage in „sicher löschen“ vs „False Positive“. Nächster Schritt: Top-30 high-confidence Treffer bereinigen.                                                                                                                            |
| H         | `window.confirm/alert` in kritischen Flows             | z.B. `src/modules/app-shell/App.tsx`, `src/components/WorkspaceDashboard.tsx`                                                                                             | Med      | S-M     | Low    | Einheitliche dialog-Komponente mit Fokusfalle, Keyboard-Handling, ARIA. Nächster Schritt: Confirm-Wrapper-Komponente bauen und inkrementell ersetzen.                                                                                        |

## 4) Quick Wins vs Short Projects vs Initiativen

### Quick Wins (<=1h)

- Webhook fail-close default setzen.
- `exec` -> `execFile` in File-Reveal.
- Timeout-Wrapper für 3 kritische Routen einführen.
- `loading.tsx` + `error.tsx` für Mission-Control-Segmente anlegen.
- Drei vorhandene `<img>`-Stellen auf `next/image` migrieren.

### Short Projects (1-2 Tage)

- Zod-Validierung für Top-20 mutierende APIs.
- Auth-Matcher/Allowlist konsolidieren und dokumentieren.
- Lint-Warnbudget + Rule-Tuning + erste 300 Warnungen abbauen.
- Knip high-confidence Cleanup (unused exports/files).

### Initiativen (1-2 Wochen)

- RSC-first Datenfluss für Mission-Control/AppShell.
- Service-Layer-Standardisierung für API-Routen (thin handlers).
- SSE-Backplane für Multi-Instance-Robustheit.

## 5) Konkreter Maßnahmenplan für die nächsten 14 Tage

1. Tag 1-2: Security-Hotfixes (`files/reveal`, `files/preview`, webhook fail-close) + Tests.
2. Tag 3-4: Auth-Perimeter vereinheitlichen (`proxy` matcher + public allowlist + secret policy).
3. Tag 5-6: Validation Sprint 1 (Top-10 write-Routes mit Zod + shared parse helper).
4. Tag 7: Timeout/Retry-Utility einführen, in OAuth/voice/planning nutzen.
5. Tag 8-9: Validation Sprint 2 (weitere 10 write-Routes).
6. Tag 10-11: Mission-Control RSC-Initialdaten + segment `loading/error`.
7. Tag 12: `next/image`/`next/font` Migration (kritische Views).
8. Tag 13: Lint/Knip Cleanup (warn budget + dead exports phase 1).
9. Tag 14: Regressionlauf, Dokumentation (ADR für Auth/Validation/Rendering), Rollout-Plan.

## 6) Stop Doing-Liste

- Keine neuen mutierenden APIs ohne Schema-Validierung.
- Kein `exec` mit String-Interpolation für User-/Request-Pfade.
- Keine neuen „privileged“ Routen außerhalb eines zentralen Auth-Gates.
- Keine fail-open Security-Checks bei fehlender Konfiguration.
- Keine neuen `window.confirm/alert`-Flows in produktiven UIs.
- Kein pauschales Deaktivieren von `@next/next/no-img-element` ohne messbaren Grund.

## Verifikationsstand (zum Review-Zeitpunkt)

- `npm run check` erfolgreich (1432 Lint-Warnungen, 0 Fehler).
- `npm test` erfolgreich (471/471 Dateien, 2094/2094 Tests).
- `npm run build` erfolgreich (Next.js 16.1.6).
- `npm run -s knip` meldet weiterhin Maintenance-Debt (u.a. 402 ungenutzte Exports).

## Selbstkritische Nachprüfung (IST vs Annahmen)

- **Status:** 2026-03-03 (nach erneuter Codeprüfung)

### Korrigierte Einordnung

- **Auth-Finding war zu breit formuliert.**
  Die Aussage "Auth-Perimeter inkonsistent" bleibt korrekt, aber nicht in der pauschalen Breite.
  Tatsächlich sind viele Nicht-Matcher-Routen trotzdem über Route-Auth abgesichert (`withUserContext`, `resolveMasterUserId`, `resolveAutomationUserId`).
  Konkrete aktuell nicht abgesicherte Nicht-Matcher-Routen sind:
  - `/api/security/status`
  - `/api/security/policy-explain`
  - `/api/stats`
  - `/api/mission-control/status`
  - `/api/channels/telegram/pairing/poll`
  - `/api/personas/templates`
  - `/api/auth/[...nextauth]` (hier ist Public-Access expected)

- **Validation-Finding ist korrekt, aber mit Nuance.**
  57 Route-Handler nutzen `request.json()`, 4 nutzen `safeParse`.
  Es gibt zusätzlich mehrere manuelle Guards; die Aussage ist daher "inkonsistent", nicht "gar nicht vorhanden".

- **Knip-Finding ist indikativ, nicht absolut.**
  Die Größenordnung (`unused exports`) ist real als Wartungssignal, enthält aber bekannte False Positives (v.a. dynamische/runtime Referenzen).
  Empfehlung bleibt: Triage statt blindes Löschen.

### Unverändert bestätigt

- Unsichere Pfadprüfung + `exec` in `files/reveal|preview`.
- Fail-open Webhook-Verifikation bei fehlenden Secrets.
- Fehlende segmentierte `loading.tsx`/`error.tsx`.
- Unterausnutzung von `next/image` / kein `next/font`.
- In-Memory SSE-Broadcast (Single-Process-Grenze).
- Hohe Lint-Warnlast (1432 Warnungen).
