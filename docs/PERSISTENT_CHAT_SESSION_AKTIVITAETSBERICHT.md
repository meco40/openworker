# Taetigkeitsbericht: Persistent Chat Session v2

Stand: 11.02.2026  
Scope: Best-Case-Implementierung fuer persistente, user-isolierte Chat-Sessions

## Ziel

Umsetzung eines Chat-Systems mit Copilot-aehnlicher Kontinuitaet:
- Chatverlauf bleibt ueber Neustarts erhalten.
- Ein Conversation-Thread bleibt beim Model-/Provider-Wechsel erhalten.
- Strikte User-Isolation fuer Conversations, Messages und Stream.
- Keine Regression in bestehenden Chat-, Worker- und Workspace-Flows.

## Durchgefuehrte Taetigkeiten

1. Architektur aus dem Plan in Runtime-Komponenten umgesetzt:
- `SessionManager`
- `HistoryManager`
- `ContextBuilder`

2. Persistenzmodell erweitert:
- `conversations.user_id`
- `messages.seq`
- `conversation_context` fuer Summary-Zustand

3. API-Routen auf User-Kontext und Ownership-Pruefung umgestellt:
- Conversations
- Messages
- SSE Stream

4. Frontend-Chat-Sendepfad auf server-persistenten Flow umgestellt
- inkl. Fallback fuer verzogertes SSE

5. Auth-Basis integriert (lokaler Credentials-Flow)
- Session-Aufloesung serverseitig
- Login-Seite und API-Route angebunden
- Additive Auth.js-kompatible Tabellen (`users`, `accounts`, `sessions`, `verification_tokens`)

6. Fehlende Telemetrie-Endpoints ergaenzt (`/api/logs`, `/api/logs/ingest`)
- bestehende Integrationstests wieder gruene Basis

7. Testabdeckung fuer User-Scoping, Context-Building und Auth-User-Aufloesung erweitert.
8. Feature-Flag-Guardrail (`CHAT_PERSISTENT_SESSION_V2`) server- und clientseitig integriert.
9. Nacharbeiten aus Beschwerde-Review umgesetzt:
- Password-Hashing auf `scrypt` umgestellt (Legacy-`sha256` wird beim Login automatisch migriert)
- Zentrale Konstante fuer Legacy-User-ID eingefuehrt
- Keepalive auch im Legacy-SSE-Pfad aktiviert
- Summary-Refresh um AI-basierte Zusammenfassung erweitert (Fallback bleibt aktiv)

## Wichtige Aenderungen und Grund

### 1) Auth und Session-Aufloesung

Geaendert:
- `src/auth.ts`
- `app/api/auth/[...nextauth]/route.ts`
- `app/page.tsx`
- `app/login/page.tsx`
- `app/login/LoginForm.tsx`
- `src/server/auth/userContext.ts`
- `src/server/auth/userStore.ts`
- `types/next-auth.d.ts`

Grund:
- Ohne serverseitige Session-Aufloesung ist keine sichere User-Isolation moeglich.
- Login-Gate erlaubt klare Trennung zwischen `auth required` und Legacy-Fallback.
- v4-kompatible Auth-Konfiguration beseitigt Build-Blocker bei API-Route.

### 2) Conversation- und Message-Scoping

Geaendert:
- `types.ts`
- `src/server/channels/messages/repository.ts`
- `src/server/channels/messages/sqliteMessageRepository.ts`

Grund:
- `userId` an der Conversation ist notwendig fuer Ownership-Checks.
- `seq` garantiert stabile Reihenfolge pro Conversation.
- `conversation_context` ermoeglicht langzeitstabile Kontextkonsolidierung (Summary + recent history).

### 3) Service-Schicht mit klaren Verantwortungen

Geaendert:
- `src/server/channels/messages/service.ts`
- `src/server/channels/messages/sessionManager.ts`
- `src/server/channels/messages/historyManager.ts`
- `src/server/channels/messages/contextBuilder.ts`
- `src/server/channels/messages/featureFlag.ts`

Grund:
- Trennung von Session-Logik, Historie und Kontextaufbau reduziert Seiteneffekte.
- Modell-/Provider-Wechsel bleibt thread-unabhaengig (Conversation bleibt gleich).
- Bessere Wartbarkeit und gezielte Testbarkeit.

### 4) API und Streaming-Sicherheit

Geaendert:
- `app/api/channels/conversations/route.ts`
- `app/api/channels/messages/route.ts`
- `app/api/channels/stream/route.ts`
- `src/server/channels/sse/manager.ts`

Grund:
- Jede Anfrage wird auf User-Kontext aufgeloest.
- SSE-Broadcast wird auf Ziel-User begrenzt.
- Verhindert Cross-User-Datenlecks.

### 5) Frontend-Sendepfad auf persistente API

Geaendert:
- `App.tsx`

Grund:
- Nachrichtensenden laeuft ueber den serverseitigen Persistenzpfad.
- UI bleibt robust bei SSE-Verzoegerung durch API-Fallback-Append.

### 6) Test- und Qualitaetssicherung

Geaendert/neu:
- `tests/unit/auth/user-context.test.ts`
- `tests/unit/channels/message-repository-user-scope.test.ts`
- `tests/unit/channels/context-builder.test.ts`
- `tests/unit/channels/message-repository-migration.test.ts`
- `tests/unit/channels/sse-manager.test.ts`
- `tests/integration/persistent-chat-session-v2.contract.test.ts`
- `tests/unit/auth/constants.test.ts`
- `tests/unit/auth/user-store.test.ts`
- `tests/unit/channels/message-service-summary.test.ts`
- `tests/integration/channels/stream-route.contract.test.ts`

Grund:
- User-Isolation und Kontextlogik muessen explizit abgesichert werden.
- Regressionen in bestehenden Flows sollen frueh erkannt werden.

## Verifikation (letzter kompletter Lauf)

- `npm run build`: erfolgreich
- `npm run typecheck`: erfolgreich
- `npm run test`: erfolgreich (62 Testdateien, 299 Tests)
- `npm run lint`: erfolgreich (Warnings vorhanden, keine Errors)

## Risiko- und Regressionsbewertung

- Chat-Persistenz und User-Scoping sind technisch abgesichert.
- Workspace- und Worker-Hooks wurden nicht direkt umgebaut.
- Restrisiko bleibt bei fehlender dedizierter E2E-Abdeckung fuer den kompletten Workspace-Dateiflow.

## Kurzfazit

Die Umsetzung folgt der Best-Case-Architektur:
- Session-zentrierte User-Isolation
- Persistente, modellunabhaengige Conversation-Threads
- Zusammenhaengender Kontextaufbau ueber Summary + Verlauf
- Verifizierte Build-/Test-Basis ohne harte Regressionen in der vorhandenen Suite
