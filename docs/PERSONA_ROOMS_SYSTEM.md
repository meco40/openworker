# Persona & Rooms System — Technische Dokumentation

> **OpenClaw** — Multi-Persona Gruppendiskussions-Engine  
> Letzte Aktualisierung: 2026-02

---

## Inhaltsverzeichnis

1. [Systemübersicht](#1-systemübersicht)
2. [Persona-System](#2-persona-system)
   - 2.1 [Datenbank-Schema](#21-datenbank-schema)
   - 2.2 [Persona-Dateien (SOUL.md / AGENTS.md / USER.md)](#22-persona-dateien)
   - 2.3 [System Instruction — Komposition](#23-system-instruction--komposition)
   - 2.4 [Repository-Methoden](#24-repository-methoden)
3. [Rooms-System](#3-rooms-system)
   - 3.1 [Datenbank-Schema (11 Tabellen)](#31-datenbank-schema-11-tabellen)
   - 3.2 [Typen & Zustände](#32-typen--zustände)
   - 3.3 [RoomService — API-Schicht](#33-roomservice--api-schicht)
   - 3.4 [Model-Routing](#34-model-routing)
4. [Orchestrator — Die KI-Dispatch-Engine](#4-orchestrator--die-ki-dispatch-engine)
   - 4.1 [Scheduling & Lease-System](#41-scheduling--lease-system)
   - 4.2 [Zyklus-Ablauf (runOnce)](#42-zyklus-ablauf-runonce)
   - 4.3 [Round-Robin Rednerwahl](#43-round-robin-rednerwahl)
   - 4.4 [System-Prompt-Aufbau](#44-system-prompt-aufbau)
   - 4.5 [Nachrichtenformat für KI](#45-nachrichtenformat-für-ki)
   - 4.6 [Tool-Ausführung](#46-tool-ausführung)
5. [WebSocket-Synchronisation](#5-websocket-synchronisation)
   - 5.1 [Gateway Events](#51-gateway-events)
   - 5.2 [Client-Side Sync (useRoomSync)](#52-client-side-sync-useroomsync)
6. [Datenfluss — End-to-End](#6-datenfluss--end-to-end)
7. [Architektur-Diagramme](#7-architektur-diagramme)

---

## 1. Systemübersicht

Das Persona & Rooms System ermöglicht **autonome Gruppendiskussionen** zwischen KI-Personas. Jede Persona hat eine eigene Persönlichkeit (definiert über Markdown-Dateien), ein zugewiesenes KI-Modell und kann in mehreren Räumen gleichzeitig teilnehmen.

**Kernkonzepte:**

| Konzept | Beschreibung |
|---|---|
| **Persona** | Eine KI-Persönlichkeit mit Name, Emoji, Vibe und konfigurierbaren Dateien (SOUL.md, etc.) |
| **Room** | Ein Gruppenchat-Raum mit mehreren Persona-Mitgliedern |
| **Orchestrator** | Die Engine, die alle 30 Sekunden den nächsten Sprecher wählt und die KI ansteuert |
| **Lease** | Verteilte Sperre, die sicherstellt, dass nur eine Instanz einen Raum gleichzeitig verarbeitet |
| **Round-Robin** | Rotationsverfahren zur fairen Rednerwahl |

**Technologie-Stack:**
- **Runtime:** Node.js + TypeScript
- **Framework:** Next.js 16 (App Router)
- **Datenbank:** SQLite (better-sqlite3) — `personas.db` + `messages.db`
- **Echtzeit:** WebSocket via Gateway
- **KI-Anbindung:** Model Hub mit Provider-Adaptern (OpenRouter, OpenAI, xAI, Gemini, etc.)

---

## 2. Persona-System

### 2.1 Datenbank-Schema

**Datei:** `.local/personas.db`

#### Tabelle `personas`

| Spalte | Typ | Constraints |
|---|---|---|
| `id` | TEXT | PRIMARY KEY |
| `name` | TEXT | NOT NULL |
| `emoji` | TEXT | NOT NULL DEFAULT '🤖' |
| `vibe` | TEXT | NOT NULL DEFAULT '' |
| `user_id` | TEXT | NOT NULL |
| `created_at` | TEXT | NOT NULL |
| `updated_at` | TEXT | NOT NULL |

#### Tabelle `persona_files`

| Spalte | Typ | Constraints |
|---|---|---|
| `persona_id` | TEXT | NOT NULL, FK → personas(id) ON DELETE CASCADE |
| `filename` | TEXT | NOT NULL |
| `content` | TEXT | NOT NULL DEFAULT '' |
| | | PRIMARY KEY (persona_id, filename) |

### 2.2 Persona-Dateien

Jede Persona kann bis zu **6 Markdown-Dateien** besitzen (`PERSONA_FILE_NAMES`):

| Datei | Zweck |
|---|---|
| **SOUL.md** | Kernpersönlichkeit, Charakter, Hintergrundgeschichte |
| **AGENTS.md** | Agentenspezifische Anweisungen und Verhaltensregeln |
| **USER.md** | Benutzerbezogene Kontextinformationen |
| **SKILLS.md** | Fähigkeiten und Kompetenzbereiche |
| **KNOWLEDGE.md** | Wissensbasis und Fakten |
| **STYLE.md** | Sprach- und Schreibstil-Vorgaben |

Für die **System Instruction** werden nur die ersten drei verwendet: `SOUL.md`, `AGENTS.md`, `USER.md` (`PERSONA_INSTRUCTION_FILES`).

### 2.3 System Instruction — Komposition

Die Methode `getPersonaSystemInstruction(personaId)` baut die System Instruction wie folgt auf:

```
--- SOUL.md ---
Du bist Pia, 19 Jahre alt, Schwester von Mark...

--- AGENTS.md ---
Sei höflich und hilfsbereit...

--- USER.md ---
Der Benutzer bevorzugt kurze Antworten...
```

**Regeln:**
1. Iteriert über `SOUL.md` → `AGENTS.md` → `USER.md`
2. Jede Datei bekommt einen `--- Dateiname ---` Header
3. Teile werden mit `\n\n` verbunden
4. **Maximallänge:** 4.000 Zeichen (`MAX_PERSONA_INSTRUCTION_CHARS`) — wird abgeschnitten falls überschritten
5. Leere Dateien werden übersprungen

### 2.4 Repository-Methoden

`PersonaRepository` (`src/modules/personas/PersonaRepository.ts`):

| Methode | Funktion |
|---|---|
| `listPersonas(userId)` | Alle Personas eines Benutzers |
| `getPersona(id)` | Einzelne Persona |
| `getPersonaWithFiles(id)` | Persona mit allen Dateien |
| `createPersona(input)` | Neue Persona anlegen |
| `updatePersona(id, input)` | Persona aktualisieren |
| `deletePersona(id)` | Persona löschen (CASCADE löscht Dateien mit) |
| `getFile(personaId, filename)` | Einzelne Datei lesen |
| `saveFile(personaId, filename, content)` | Datei speichern (UPSERT) |
| `getPersonaSystemInstruction(id)` | Komponierte System Instruction |

---

## 3. Rooms-System

### 3.1 Datenbank-Schema (11 Tabellen)

**Datei:** `.local/messages.db`

#### Tabelle `rooms`

| Spalte | Typ | Constraints |
|---|---|---|
| `id` | TEXT | PRIMARY KEY |
| `name` | TEXT | NOT NULL |
| `description` | TEXT | NOT NULL DEFAULT '' |
| `goal_mode` | TEXT | NOT NULL DEFAULT 'free', CHECK IN ('planning','simulation','free') |
| `routing_profile_id` | TEXT | NOT NULL DEFAULT 'p1' |
| `run_state` | TEXT | NOT NULL DEFAULT 'stopped', CHECK IN ('stopped','running','degraded') |
| `user_id` | TEXT | NOT NULL |
| `created_at` | TEXT | NOT NULL |
| `updated_at` | TEXT | NOT NULL |

#### Tabelle `room_members`

| Spalte | Typ | Constraints |
|---|---|---|
| `room_id` | TEXT | NOT NULL, FK → rooms(id) ON DELETE CASCADE |
| `persona_id` | TEXT | NOT NULL |
| `role_label` | TEXT | NOT NULL DEFAULT '' |
| `turn_priority` | INTEGER | NOT NULL DEFAULT 0 |
| `model_override` | TEXT | |
| `created_at` | TEXT | NOT NULL |
| `updated_at` | TEXT | NOT NULL |
| | | PRIMARY KEY (room_id, persona_id) |

#### Tabelle `room_messages`

| Spalte | Typ | Constraints |
|---|---|---|
| `id` | TEXT | PRIMARY KEY |
| `room_id` | TEXT | NOT NULL, FK → rooms(id) ON DELETE CASCADE |
| `seq` | INTEGER | NOT NULL |
| `speaker_type` | TEXT | NOT NULL, CHECK IN ('persona','system','user') |
| `speaker_persona_id` | TEXT | |
| `content` | TEXT | NOT NULL |
| `metadata_json` | TEXT | |
| `created_at` | TEXT | NOT NULL |
| | | UNIQUE (room_id, seq) |

#### Tabelle `room_message_sequences`

| Spalte | Typ | Constraints |
|---|---|---|
| `room_id` | TEXT | PRIMARY KEY, FK → rooms(id) ON DELETE CASCADE |
| `last_seq` | INTEGER | NOT NULL DEFAULT 0 |

#### Tabelle `room_runs` (Lease-System)

| Spalte | Typ | Constraints |
|---|---|---|
| `id` | TEXT | PRIMARY KEY |
| `room_id` | TEXT | NOT NULL, FK → rooms(id) ON DELETE CASCADE |
| `run_state` | TEXT | NOT NULL, CHECK IN ('running','degraded','stopped') |
| `lease_owner` | TEXT | |
| `lease_expires_at` | TEXT | |
| `heartbeat_at` | TEXT | |
| `failure_reason` | TEXT | |
| `started_at` | TEXT | NOT NULL |
| `ended_at` | TEXT | |
| `created_at` | TEXT | NOT NULL |
| `updated_at` | TEXT | NOT NULL |
| | | UNIQUE INDEX (room_id) WHERE ended_at IS NULL |

#### Tabelle `room_member_runtime`

| Spalte | Typ | Constraints |
|---|---|---|
| `room_id` | TEXT | NOT NULL |
| `persona_id` | TEXT | NOT NULL |
| `status` | TEXT | NOT NULL DEFAULT 'idle', CHECK IN ('idle','busy','interrupting','interrupted','error') |
| `busy_reason` | TEXT | |
| `busy_until` | TEXT | |
| `current_task` | TEXT | |
| `last_model` | TEXT | |
| `last_profile_id` | TEXT | |
| `last_tool` | TEXT | |
| `updated_at` | TEXT | NOT NULL |
| | | PRIMARY KEY (room_id, persona_id) |

#### Tabelle `room_persona_sessions`

| Spalte | Typ | Constraints |
|---|---|---|
| `room_id` | TEXT | NOT NULL, FK → rooms(id) ON DELETE CASCADE |
| `persona_id` | TEXT | NOT NULL |
| `provider_id` | TEXT | NOT NULL |
| `model` | TEXT | NOT NULL |
| `session_id` | TEXT | NOT NULL |
| `updated_at` | TEXT | NOT NULL |
| | | PRIMARY KEY (room_id, persona_id) |

#### Tabelle `room_persona_context`

| Spalte | Typ | Constraints |
|---|---|---|
| `room_id` | TEXT | NOT NULL, FK → rooms(id) ON DELETE CASCADE |
| `persona_id` | TEXT | NOT NULL |
| `summary_text` | TEXT | NOT NULL DEFAULT '' |
| `last_message_seq` | INTEGER | NOT NULL DEFAULT 0 |
| `updated_at` | TEXT | NOT NULL |
| | | PRIMARY KEY (room_id, persona_id) |

#### Tabelle `persona_permissions`

| Spalte | Typ | Constraints |
|---|---|---|
| `persona_id` | TEXT | PRIMARY KEY |
| `tools_json` | TEXT | NOT NULL (JSON `Record<string, boolean>`) |
| `updated_at` | TEXT | NOT NULL |

#### Tabelle `room_interventions`

| Spalte | Typ | Constraints |
|---|---|---|
| `id` | TEXT | PRIMARY KEY |
| `room_id` | TEXT | NOT NULL, FK → rooms(id) ON DELETE CASCADE |
| `user_id` | TEXT | NOT NULL |
| `note` | TEXT | NOT NULL |
| `created_at` | TEXT | NOT NULL |

### 3.2 Typen & Zustände

```typescript
type RoomGoalMode    = 'planning' | 'simulation' | 'free';
type RoomRunState    = 'stopped' | 'running' | 'degraded';
type RoomSpeakerType = 'persona' | 'system' | 'user';
type RoomMemberRuntimeStatus = 'idle' | 'busy' | 'interrupting' | 'interrupted' | 'error';
```

**Zustandsübergänge des Raums:**

```
stopped ──▶ running ──▶ stopped
                │
                ▼
            degraded ──▶ stopped
```

- `stopped → running`: Benutzer startet den Raum
- `running → stopped`: Benutzer stoppt den Raum
- `running → degraded`: Kein Mitglied hat ein auflösbares Modell oder ein kritischer Fehler tritt auf
- `degraded → stopped`: Automatisch bei nächstem Stop oder Neustart

**Zustandsübergänge eines Mitglieds (Runtime):**

```
idle ──▶ busy ──▶ idle
           │
           ▼
      interrupting ──▶ interrupted ──▶ idle
           
busy ──▶ error ──▶ idle
```

### 3.3 RoomService — API-Schicht

`RoomService` (`src/server/rooms/service.ts`) — die zentrale API-Schicht zwischen HTTP-Routen und Repository:

| Methode | Beschreibung |
|---|---|
| `createRoom(userId, input)` | Raum erstellen, sendet ROOM_RUN_STATUS |
| `listRooms(userId)` | Alle Räume des Benutzers |
| `getRoom(userId, roomId)` | Einzelnen Raum laden (prüft Eigentümer) |
| `deleteRoom(userId, roomId)` | **Stoppt laufende Räume automatisch**, dann löschen |
| `addMember(userId, roomId, input)` | Mitglied hinzufügen (Persona-Eigentum wird geprüft) |
| `removeMember(userId, roomId, personaId)` | Mitglied entfernen |
| `interruptMember(userId, roomId, personaId)` | Laufende Generierung unterbrechen (nur bei 'busy') |
| `updateRunState(userId, roomId, runState)` | Raum starten/stoppen |
| `getRoomState(userId, roomId)` | Raum + Mitglieder + Runtime-Status |
| `listMessages(userId, roomId, limit?, beforeSeq?)` | Nachrichten laden |
| `sendUserMessage(userId, roomId, content)` | Benutzernachricht senden, broadcast |
| `addIntervention(userId, roomId, note)` | Benutzer-Intervention (Lenkungshinweis) |

### 3.4 Model-Routing

Die Funktion `resolveRoomRouting()` bestimmt, welches KI-Modell für ein Mitglied verwendet wird:

```
1. Hat das Mitglied ein model_override UND ist dieses im Raum-Profil aktiv?
   → Verwende model_override

2. Hat das Raum-Profil aktive Modelle?
   → Verwende das erste aktive Modell (Fallback)

3. Hat das Default-Profil "p1" aktive Modelle?
   → Verwende das erste Modell von p1

4. Keines der obigen?
   → null (Mitglied wird übersprungen, ggf. degraded)
```

---

## 4. Orchestrator — Die KI-Dispatch-Engine

**Datei:** `src/server/rooms/orchestrator.ts` (~532 Zeilen)

Der Orchestrator ist das Herzstück des Rooms-Systems. Er läuft als Hintergrundprozess und steuert die KI-Generierung für alle aktiven Räume.

### 4.1 Scheduling & Lease-System

**Konfiguration:**

```typescript
interface RoomOrchestratorOptions {
  instanceId?: string;          // default: 'room-orchestrator-{pid}'
  leaseTtlMs?: number;         // default: 30.000ms (30 Sekunden)
  activeModelsByProfile?: Record<string, string[]>;
  now?: () => Date;
}
```

**Scheduling** (in `server.ts`):
- Intervall: `ROOM_INTERVAL_MS` = 30 Sekunden (konfigurierbar via `ROOM_ORCHESTRATOR_INTERVAL_MS`)
- Start: `startRoomScheduler()` wird abhängig von `ROOMS_RUNNER` gestartet (`web`, `scheduler`, `both`)
  - `shouldRunRooms(processRole)` in `src/server/rooms/runtimeRole.ts`
  - Env-Variable `ROOMS_RUNNER`: `web` | `scheduler` | `both` (Default: `both`)
- Ausführung: sofort + dann per `setInterval`
- Timer: `.unref()` — hält den Prozess nicht am Leben

**Reentrancy-Schutz:**
- `runOnce()` besitzt einen In-Process-Guard (`runInProgress` Flag), der überlappende Aufrufe auf derselben Orchestrator-Instanz überspringt.

**Stop-Race-Schutz:**
- `canMarkRoomDegraded(roomId)` prüft vor jeder Degradierung:
  1. Raum existiert noch und ist nicht bereits `stopped`
  2. Es gibt einen aktiven Run
  3. Lease-Owner ist leer oder gehört dieser Instanz
- Verhindert, dass ein User-Stop vom Orchestrator auf `degraded` überschrieben wird.

**Lease-Mechanismus:**
- Verhindert parallele Verarbeitung desselben Raums bei Multi-Instanz-Betrieb
- `acquireRoomLease(roomId, instanceId, leaseExpiry)` — atomare Sperre
- Lease läuft nach `leaseTtlMs` ab → andere Instanzen können übernehmen
- Heartbeat verlängert die Lease während der Verarbeitung

### 4.2 Zyklus-Ablauf (runOnce)

Jeder Zyklus (`runOnce()`) durchläuft folgende Schritte für **jeden laufenden Raum**:

```
1.  listRunningRooms()              → Alle Räume mit run_state='running'
2.  acquireRoomLease()              → Verteilte Sperre (skip bei Konflikt)
3.  heartbeatRoomLease()            → Lease verlängern
4.  listMembers() + resolveRouting  → Aktive Mitglieder mit Modellen ermitteln
5.  Degraded-Check                  → Kein Modell? → 'degraded'
6.  Round-Robin Rednerwahl          → Nächsten Sprecher bestimmen
7.  upsertMemberRuntime('busy')     → Status auf 'busy' + broadcast
8.  upsertPersonaSession()          → Session-ID setzen
9.  System-Prompt bauen             → SOUL.md + Kontext + Gruppenanweisung
10. Konversationshistorie bauen     → Letzte 20 Nachrichten mit Rollenformat
11. Tool-Definitionen laden         → Skills → OpenAI-Tool-Format
12. Lease-Keepalive starten         → setInterval(leaseTtl/3), AbortController
13. KI-Dispatch-Loop                → Max. 3 Tool-Runden
    ├── Lease-Verlust?              → Abort + skip Persistierung
    ├── Interrupt-Check             → 'interrupting' → Abbruch
    ├── dispatchWithFallback()      → KI-Provider-Aufruf (mit AbortSignal)
    ├── Tool-Calls?                 → executeRoomTool(), Loop
    └── Text-Antwort?              → Capture, Break
14. Lease-Keepalive stoppen         → clearInterval
15. Antwort bereinigen              → [Name]: Prefix entfernen
16. appendMessage()                 → Persistieren + broadcast (atomar via room_message_sequences)
17. upsertPersonaContext()          → Rolling Summary (max 1000 Zeichen)
18. Status auf 'idle' + broadcast
```

**Rückgabe:** `{ processedRooms: number, createdMessages: number }`

**Wichtige Guards (V1-Hardening):**
- **Reentrancy-Guard:** `runInProgress` Flag verhindert parallele `runOnce()`-Aufrufe.
- **Stop-Race-Schutz:** `canMarkRoomDegraded()` prüft ob Raum nicht bereits gestoppt wurde.
- **Lease-Keepalive:** `setInterval(leaseTtl/3)` erneuert Lease während langer Dispatch-Phasen.
- **Lease-Abort:** Bei Lease-Verlust wird `AbortController.abort()` aufgerufen, Persistierung übersprungen.
- **Atomare Sequenz:** `room_message_sequences` Tabelle statt `MAX(seq)+1`.

### 4.3 Round-Robin Rednerwahl

Die Rednerwahl folgt einem strikten Rotationsprinzip:

1. Letzte 5 Nachrichten abrufen (neueste 5 in chronologischer Reihenfolge via Subquery)
2. Rückwärts nach dem letzten Persona-Sprecher suchen
3. Dessen Index in `validMembers[]` finden
4. Nächster Sprecher: `(index + 1) % validMembers.length`
5. Falls noch nie jemand gesprochen hat → `validMembers[0]`

**SQL für Nachrichten-Abruf (neueste N in ASC):**
```sql
SELECT * FROM (
  SELECT * FROM room_messages 
  WHERE room_id = ? 
  ORDER BY seq DESC 
  LIMIT ?
) sub ORDER BY seq ASC
```

### 4.4 System-Prompt-Aufbau

Der System-Prompt wird als `{ role: 'system' }` Message an den Anfang der Message-Liste gestellt (identisch zum normalen Chat-Verfahren via `contextBuilder.ts`):

```
┌─────────────────────────────────────────────────┐
│ Teil 1: Persona System Instruction              │
│                                                 │
│ --- SOUL.md ---                                 │
│ Du bist Next.js Dev, WebApp developer...        │
│                                                 │
│ --- AGENTS.md ---                               │
│ Sei höflich und hilfsbereit...                  │
│                                                 │
│ --- USER.md ---                                 │
│ Der Benutzer bevorzugt kurze Antworten...       │
├─────────────────────────────────────────────────┤
│ Teil 2: Raum-Kontext (optional)                 │
│                                                 │
│ ---                                             │
│ Kontext: Diskussion über WebApp                 │
│ ---                                             │
├─────────────────────────────────────────────────┤
│ Teil 3: Gruppenverhalten (immer)                │
│                                                 │
│ Du bist in einer Gruppendiskussion.             │
│ Antworte nur als du selbst.                     │
└─────────────────────────────────────────────────┘
```

**Fallback** (wenn keine Dateien vorhanden):
```
Dein Name ist "Next.js Dev". Vibe: freundlich und neugierig
```

### 4.5 Nachrichtenformat für KI

Die Konversationshistorie (letzte 20 Nachrichten) wird in `GatewayMessage[]`-Format konvertiert:

| Nachricht von | Rolle | Format |
|---|---|---|
| **Eigene** (aktueller Sprecher) | `assistant` | Rohinhalt (kein Prefix) |
| **Andere Persona** | `user` | `[PersonaName]: Inhalt` |
| **Benutzer** | `user` | `[User]: Inhalt` |
| **System** | `user` | `[System]: Inhalt` |

**Seed-Nachricht** (wenn Raum leer):
1. Vorheriger Kontext-Summary → `{ role: 'user', content: 'Context summary:\n...' }`
2. Oder Raum-Beschreibung
3. Oder Fallback: `'Beginne die Diskussion.'`

**Response-Bereinigung vor Speicherung:**
```typescript
responseText.replace(/^\[[^\]]{1,30}\]:\s*/g, '').trim()
```
→ Entfernt echoed `[Name]:` Prefixe, die Modelle manchmal zurückgeben.

### 4.6 Tool-Ausführung

**Datei:** `src/server/rooms/toolExecutor.ts`

```typescript
interface ToolExecutionInput {
  functionName: string;
  args: Record<string, unknown>;
  permissions: PersonaPermissions | null;
}

interface ToolExecutionResult {
  ok: boolean;
  output: string;
}
```

**Ablauf:**
1. Berechtigung prüfen: `permissions.tools[functionName]` muss `true` sein
2. Skills aus `SkillRepository` laden
3. An `executeSkillFunctionCall()` delegieren
4. Tool-Ergebnis als `{ role: 'user', content: 'Tool "name" result:\n...' }` anhängen
5. Maximal **3 Tool-Runden** pro Orchestrator-Zyklus (`MAX_TOOL_ROUNDS = 3`)

---

## 5. WebSocket-Synchronisation

### 5.1 Gateway Events

**Datei:** `src/server/gateway/events.ts`

| Event-Konstante | Event-String | Payload |
|---|---|---|
| `ROOM_MESSAGE` | `room.message` | `{ id, roomId, seq, speakerType, speakerPersonaId, content, createdAt }` |
| `ROOM_MEMBER_STATUS` | `room.member.status` | `{ roomId, personaId, status, reason, updatedAt }` |
| `ROOM_RUN_STATUS` | `room.run.status` | `{ roomId, runState, updatedAt }` |
| `ROOM_INTERVENTION` | `room.intervention` | `{ roomId, interventionId, note, createdAt }` |
| `ROOM_METRICS` | `room.metrics` | `{ roomId, messageCount, memberCount, generatedAt }` |

**Broadcast-Mechanismus** (`src/server/gateway/broadcast.ts`):
- `broadcastToUser(userId, event, payload)` sendet an **alle WebSocket-Verbindungen** eines Benutzers
- Jeder Client bekommt eine fortlaufende `seq`-Nummer (Lücken-Erkennung clientseitig)
- **Slow-Consumer-Erkennung:** Bei `socket.bufferedAmount > MAX_BUFFERED_BYTES` wird der Socket mit Code 1008 geschlossen

### 5.2 Client-Side Sync (useRoomSync)

**Datei:** `src/modules/rooms/useRoomSync.ts`

```typescript
useRoomSync(roomId: string | null, initialMessages: RoomMessage[])
  → { messages, memberStatus, runStatus, interventions, metrics }
```

| Event | Verarbeitung |
|---|---|
| `room.message` | Deduplizierung nach `id` + `seq`, sortiert nach seq ASC |
| `room.member.status` | Key-Value nach `personaId` (`Record<string, RoomMemberStatus>`) |
| `room.run.status` | Einzelner neuester Zustand |
| `room.intervention` | Prepend (neueste zuerst), max. 100 Einträge |
| `room.metrics` | Einzelner neuester Stand |

Alle Events werden nach `roomId` gefiltert.

---

## 6. Datenfluss — End-to-End

### Benutzer sendet Nachricht

```
Browser (UI)
  │
  ▼
HTTP POST /api/rooms/{roomId}/messages
  │
  ▼
RoomService.sendUserMessage()
  ├── repository.appendMessage(speakerType: 'user')
  └── broadcastToUser(ROOM_MESSAGE)
        │
        ▼
      WebSocket → useRoomSync → UI aktualisiert
```

### Orchestrator-Zyklus (alle 30 Sekunden)

```
setInterval (30s)
  │
  ▼
RoomOrchestrator.runOnce()
  │
  ▼
Für jeden Raum mit run_state='running':
  │
  ├── 1. acquireRoomLease()  ────────────── Verteilte Sperre
  │
  ├── 2. Round-Robin Rednerwahl  ────────── Nächste Persona bestimmen
  │
  ├── 3. Status → 'busy'  ──────────────── broadcast ROOM_MEMBER_STATUS
  │       │                                 → UI zeigt "Denkt nach..."
  │       ▼
  ├── 4. System-Prompt bauen  ───────────── SOUL.md + Kontext + Gruppenanweisung
  │
  ├── 5. Konversationshistorie  ─────────── Letzte 20 Nachrichten → Role-Mapping
  │
  ├── 6. dispatchWithFallback()  ────────── Model Hub → Provider → KI-API
  │       │
  │       ├── Tool-Call? → executeRoomTool() → Loop (max 3x)
  │       └── Text? → responseText
  │
  ├── 7. Antwort bereinigen  ────────────── [Name]: Prefix entfernen
  │
  ├── 8. appendMessage()  ──────────────── Persistieren in SQLite
  │       └── broadcast ROOM_MESSAGE  ──── → UI zeigt neue Nachricht
  │
  ├── 9. upsertPersonaContext()  ────────── Rolling Summary (1000 Zeichen)
  │
  └── 10. Status → 'idle'  ─────────────── broadcast ROOM_MEMBER_STATUS
          └── broadcast ROOM_METRICS  ──── → UI aktualisiert Zähler
```

---

## 7. Architektur-Diagramme

### Komponentenübersicht

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Browser (Next.js)                          │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────────┐ │
│  │ RoomDetail   │  │ ChatInterface│  │ useRoomSync (WebSocket)   │ │
│  │ Panel        │──│              │──│ messages, memberStatus,   │ │
│  │              │  │              │  │ runStatus, metrics        │ │
│  └──────────────┘  └──────────────┘  └───────────┬───────────────┘ │
└──────────────────────────────────────────────────┼─────────────────┘
                                                   │ WebSocket
                     ┌─────────────────────────────┤
                     │                             │
┌────────────────────┼─────────────────────────────┼─────────────────┐
│                Server (Node.js)                  │                 │
│                    │                             │                 │
│  ┌─────────────────┼──────┐    ┌─────────────────┼──────────────┐ │
│  │   API Routes           │    │    Gateway (WebSocket)         │ │
│  │   /api/rooms/*         │    │    broadcastToUser()           │ │
│  └─────────┬──────────────┘    └────────────────────────────────┘ │
│            │                                    ▲                  │
│            ▼                                    │                  │
│  ┌─────────────────────┐   ┌────────────────────┴──────────────┐ │
│  │   RoomService       │   │   RoomOrchestrator (30s)          │ │
│  │   - CRUD            │   │   - Lease → Round-Robin           │ │
│  │   - State mgmt      │   │   - System Prompt                 │ │
│  │   - Messages        │   │   - AI Dispatch                   │ │
│  └─────────┬───────────┘   │   - Tool Execution                │ │
│            │               └──────────┬────────────────────────┘ │
│            │                          │                           │
│            ▼                          ▼                           │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │              RoomRepository (SQLite)                         │ │
│  │              .local/messages.db                              │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ┌──────────────────────┐    ┌──────────────────────────────────┐ │
│  │  PersonaRepository   │    │  Model Hub                       │ │
│  │  .local/personas.db  │    │  dispatchWithFallback()          │ │
│  │  SOUL.md / AGENTS.md │    │  Provider-Adapter (OpenAI,       │ │
│  │  / USER.md           │    │   OpenRouter, Gemini, xAI, ...)  │ │
│  └──────────────────────┘    └──────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────┘
```

### Datenbank-Beziehungen

```
personas.db                          messages.db
┌──────────────┐                     ┌──────────────────┐
│   personas   │                     │      rooms       │
│──────────────│                     │──────────────────│
│ id (PK)      │◄─────────┐         │ id (PK)          │
│ name         │          │         │ name             │
│ emoji        │          │         │ description      │
│ vibe         │          │         │ goal_mode        │
│ user_id      │          │         │ run_state        │
└──────┬───────┘          │         │ user_id          │
       │                  │         └────────┬─────────┘
       │ 1:N              │                  │
       ▼                  │                  │ 1:N
┌──────────────┐          │         ┌────────┴─────────┐
│ persona_files│          │         │  room_members    │
│──────────────│          │         │──────────────────│
│ persona_id   │          └─────────│ persona_id       │
│ filename     │                    │ room_id (FK)     │
│ content      │                    │ role_label       │
└──────────────┘                    │ model_override   │
                                    └──────────────────┘
                                             │
                            ┌────────────────┼────────────────┐
                            │                │                │
                            ▼                ▼                ▼
                    ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
                    │room_messages │ │ room_runs    │ │room_member   │
                    │──────────────│ │──────────────│ │_runtime      │
                    │ room_id (FK) │ │ room_id (FK) │ │──────────────│
                    │ seq          │ │ instance_id  │ │ room_id      │
                    │ speaker_type │ │ lease_expires│ │ persona_id   │
                    │ content      │ │ ended_at     │ │ status       │
                    └──────────────┘ └──────────────┘ └──────────────┘
```

---

## Anhang: Runtime-Singletons

**Datei:** `src/server/rooms/runtime.ts`

| Funktion | Rückgabe | Hinweise |
|---|---|---|
| `getRoomRepository()` | `SqliteRoomRepository` | Lazy Singleton |
| `getRoomService()` | `RoomService` | Verwendet `getRoomRepository()` |
| `getRoomOrchestrator(options?)` | `RoomOrchestrator` | Verwendet `getRoomRepository()` |

**DB-Pfad-Auflösung:**
1. `ROOMS_DB_PATH` (Env-Variable)
2. Test-Modus? → `:memory:`
3. `MESSAGES_DB_PATH` (Env-Variable)
4. Fallback: `.local/messages.db`

---

## Anhang: Test-Abdeckung

| Testdatei | Tests | Fokus |
|---|---|---|
| `room-repository.test.ts` | 5 | CRUD, Members, Messages |
| `room-service.test.ts` | 4 | Service-Schicht, Owner-Checks |
| `runtime-role.test.ts` | 4 | `ROOMS_RUNNER` Parsing |
| `orchestrator-reentrancy.test.ts` | 1 | Reentrancy-Guard |
| `orchestrator-stop-race.test.ts` | 1 | Stop-Race-Schutz |
| `rooms-runtime.test.ts` | 6 | Orchestrator Round-Robin, Dispatch |
| `rooms-routes.test.ts` | 7 | HTTP-API, Auth, Validation |
| `rooms-hardening-baseline.test.ts` | 1 | Baseline-Szenario |
| `room-message-seq-concurrency.test.ts` | 1 | Atomare Sequenz-Vergabe |
| `orchestrator-lease-keepalive.test.ts` | 1 | Lease-Keepalive während Dispatch |
| **Gesamt** | **31** | |
