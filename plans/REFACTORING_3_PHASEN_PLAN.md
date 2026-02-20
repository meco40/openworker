# Refactoring Plan: 3 Phasen für professionelle Ordnerstruktur

## Übersicht

Dieses Dokument beschreibt ein 3-Phasen Refactoring der aktuellen Projektstruktur zu einer professionellen, logischen Architektur nach Best-Case-Prinzipien.

---

## ✅ Phase 1: Grundstruktur bereinigen (ABGESCHLOSSEN)

### Ziel

Klare Trennung zwischen Root und Source-Code schaffen, temporäre/backup-Dateien entfernen.

### Durchgeführt

1. **Root-Dateien konsolidiert:**
   - `types.ts` → `src/shared/types.ts` + Re-Export
   - `constants.ts` → `src/shared/constants.ts` + Re-Export
   - `server.ts` → `src/server/index.ts` + Re-Export
   - `scheduler.ts` → `src/server/scheduler.ts` + Re-Export
   - `App.tsx` → `src/app/App.tsx` + Re-Export

2. **Temporäre Ordner bereinigt:**
   - `.tmp/` gelöscht
   - `.tmp_clawhub_probe_*/` gelöscht

3. **AppShell.tsx Import aktualisiert:**
   - Pfad zu `@/app/App` geändert

---

## Phase 2: Feature-basierte Architektur einführen (NICHT UMSETZEN - NUR PLAN)

### ⚠️ Warnung

Diese Phase darf NICHT umgesetzt werden, ohne alle Importe in der gesamten Codebasis zu aktualisieren. Es besteht ein hohes Risiko, den Code zu beschädigen.

### Ziel

Monolithische `src/server/` Struktur in eigenständige Feature-Module aufteilen.

### 2.1 Mapping: src/server → src/features

| Aktuell                  | Empfohlenes Ziel            |
| ------------------------ | --------------------------- |
| `src/server/automation/` | `src/features/automations/` |
| `src/server/channels/`   | `src/features/channels/`    |
| `src/server/personas/`   | `src/features/personas/`    |
| `src/server/rooms/`      | `src/features/rooms/`       |
| `src/server/memory/`     | `src/features/memory/`      |
| `src/server/knowledge/`  | `src/features/knowledge/`   |
| `src/server/skills/`     | `src/features/skills/`      |
| `src/server/model-hub/`  | `src/features/model-hub/`   |
| `src/server/security/`   | `src/features/security/`    |
| `src/server/gateway/`    | `src/features/gateway/`     |
| `src/server/stats/`      | `src/features/stats/`       |
| `src/server/clawhub/`    | `src/features/clawhub/`     |
| `src/server/telemetry/`  | `src/features/telemetry/`   |
| `src/server/proactive/`  | `src/features/proactive/`   |

### 2.2 Wenn Phase 2 umgesetzt werden soll:

**Schritt 1: Backup erstellen**

```bash
git commit -m "Backup vor Phase 2 Refactoring"
```

**Schritt 2: Alle Importe finden und dokumentieren**

```bash
# Alle Dateien finden, die aus src/server importieren
grep -r "from.*src/server" --include="*.ts" --include="*.tsx" .
```

**Schritt 3: Feature-Ordner erstellen**

```bash
mkdir -p src/features/automations
mkdir -p src/features/channels
# ... usw.
```

**Schritt 4: Code verschieben und Importe anpassen**

- Jede Datei einzeln verschieben
- Alle Importe in allen Dateien aktualisieren
- Tests laufen lassen nach jeder Änderung

### 2.3 core/ und infrastructure/ Struktur

```
src/
├── core/                  # ✎ NEU: Domain-Logik (nach Phase 2)
│   ├── entities/          # Business-Entities
│   ├── value-objects/    # Value Objects
│   ├── services/         # Domain-Services
│   └── events/           # Domain-Events
│
├── infrastructure/       # ✎ NEU: Framework/DB
│   ├── database/         # SQLite Repositories
│   ├── external/         # External APIs
│   └── messaging/        # Message Queue
```

---

## Phase 3: Klare Schichtenarchitektur (NICHT UMSETZEN - NUR PLAN)

### ⚠️ Warnung

Diese Phase erfordert umfangreiche Codeänderungen und sollte nur nach Phase 2 durchgeführt werden.

### Ziel

Trennung zwischen Presentation, Application, Domain und Infrastructure Layer.

### 3.1 Schichten-Architektur

```
src/
├── app/                    # Next.js App Router (Presentation)
│   ├── api/                # API Routes
│   └── pages/
│
├── components/             # React Components
│   ├── ui/                # Base UI Components
│   └── features/           # Feature-spezifische Components
│
├── features/               # Feature-Module
│   ├── [feature]/
│   │   ├── api/           # REST-Endpunkte
│   │   ├── domain/        # Business-Logik
│   │   ├── application/   # Use-Cases
│   │   ├── infrastructure/# DB-Zugriff
│   │   └── index.ts      # Public API Export
│
├── core/                   # Domain-Logik
│   ├── entities/
│   ├── value-objects/
│   ├── services/
│   └── events/
│
├── infrastructure/         # Framework/DB
│   ├── database/
│   ├── external/
│   └── messaging/
│
├── lib/                   # Utilities
│   ├── utils/
│   ├── constants/
│   └── helpers/
│
├── cli/                   # CLI Commands
├── server/                # Server Entry Points
└── shared/                # Geteilter Code
```

### 3.2 Feature-Pattern

Jedes Feature sollte diesem Pattern folgen:

```typescript
// src/features/[feature]/index.ts
export { default } from './api/route';
export * from './domain/entities';
export * from './application/commands';
```

---

## Zusammenfassung: Zielstruktur

```
/
├── src/
│   ├── app/                    # Next.js App Router
│   │   ├── api/                # API Routes
│   │   └── page.tsx
│   │
│   ├── components/             # React Components (bleibt)
│   │   └── ...
│   │
│   ├── features/               # ✎ Feature-Module (nach Phase 2)
│   │   ├── automations/
│   │   ├── channels/
│   │   ├── personas/
│   │   ├── rooms/
│   │   ├── memory/
│   │   ├── knowledge/
│   │   ├── skills/
│   │   ├── model-hub/
│   │   └── security/
│   │
│   ├── core/                   # ✎ Domain-Logik (nach Phase 2)
│   │   ├── entities/
│   │   ├── value-objects/
│   │   └── services/
│   │
│   ├── infrastructure/         # ✎ Framework/DB (nach Phase 2)
│   │   ├── database/
│   │   └── external/
│   │
│   ├── lib/                    # Utilities
│   │   └── ...
│   │
│   ├── server/                 # Server Entry Points (existiert bereits)
│   │   ├── index.ts
│   │   └── scheduler.ts
│   │
│   ├── modules/                # Bestehende Module (bleiben)
│   │   └── ...
│   │
│   └── shared/                 # Geteilter Code
│       ├── types.ts
│       └── constants.ts
│
├── docker/                     # Docker Config
├── scripts/                    # Build/Deploy Scripts
├── tests/                      # Tests
├── docs/                       # Dokumentation
└── .github/                    # GitHub Actions
```

---

## Wichtige Hinweise

### Was NICHT geändert werden sollte:

1. **`src/modules/`** - Diese Module funktionieren und sollten vorerst bleiben
2. **`components/`** im Root - Funktioniert mit aktuellen Import-Pfaden
3. **`app/`** Next.js Struktur - Funktioniert korrekt

### Was sicher geändert werden kann:

1. **Neue Verzeichnisse hinzufügen** (z.B. `src/features/`)
2. **Neue Feature-Module erstellen** statt bestehende zu verschieben
3. **core/ und lib/ für neuen Code nutzen**

### Empfehlung für weitere Schritte:

**Option A: Inkrementelle Migration**

- Für jedes neue Feature: in `src/features/` erstellen
- Bestehenden Code nicht verschieben, nur neue Features in neuer Struktur
- Langsam alle Features migrieren

**Option B: Big Bang (NICHT empfohlen)**

- Alles auf einmal umstellen
- Sehr hohes Risiko für Code-Beschädigung
- Nur mit umfassenden Tests durchführbar

---

_Erstellt: 2026-02-20_
_Letzte Aktualisierung: 2026-02-20_
_Projekt: openclaw-gateway-control-plane_
