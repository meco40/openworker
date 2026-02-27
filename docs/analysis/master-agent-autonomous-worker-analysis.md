# Analyse: Master Agent V4 – Als eigenständiger Arbeiter

## Einleitung

Der vorliegende Implementierungsplan beschreibt die Architektur eines **autonomen Master Agents**, der eigenständig Aufgaben erledigen kann. Diese Analyse untersucht, wie der Agent konzipiert sein sollte, um als _eigenständiger Arbeiter_ zu fungieren – also nicht als passives Werkzeug, sondern als proaktiver Akteur mit eigenem Lebenszyklus, Gedächtnis und Entscheidungsfähigkeiten.

---

## 1. Grundverständnis des Plans

### 1.1 Zielsetzung

Der Master Agent V4 soll:

- Aufgaben **End-to-End** ausführen (Contract → Execution → Verification → Result)
- Sichere **Gmail-Integration** bieten
- **Selbstständig Fähigkeiten erweitern** (z.B. Instagram-Connector)
- Den bestehenden **Agent Room** nicht beeinflussen
- **Autonomes Lernen** durch kontinuierliche Feedback-Schleifen

### 1.2 Architekturprinzipien

| Prinzip                | Beschreibung                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------- |
| **Isolation**          | Master läuft in separatem vertikalen Slice (`src/modules/master`, `src/server/master`) |
| **Safety First**       | Alle risikoreichen Aktionen erfordern Genehmigung + Audit Trail                        |
| **Confidence Scoring** | Jede Fähigkeit hat einen Vertrauenswert, der automatisch angepasst wird                |
| **Apprenticeship**     | Fehlende Fähigkeiten werden durch einen strukturierten Vorschlagsprozess erlernt       |

---

## 2. Kernkonzepte für autonome Agentenarbeit

### 2.1 Der Agent als _Arbeiter_ – философия

Ein Agent, der wie ein eigenständiger Arbeiter agiert, benötigt:

1. **Eigenes Gedächtnis** – Langzeit- und Kurzzeitspeicher für Aufgabenkontext
2. **Zielorientierung** – Fähigkeit, abstrakte Ziele in konkrete Schritte zu zerlegen
3. **Selbstreflexion** – Bewertung des eigenen Handelns und Anpassung
4. **Proaktivität** – Erkennen von Blockaden und selbstständiges Lösen
5. **Verantwortlichkeit** – Nachvollziehbare Dokumentation aller Aktionen

### 2.2 Die drei Lernschleifen (aus dem Plan)

Der Plan beschreibt drei ineinandergreifende Schleifen:

```
┌─────────────────────────────────────────────────────────────┐
│                    SYSTEM LEARNING LOOP                     │
│  • Tool-/Capability-Inventar beim Start aufbauen           │
│  • Micro-Benchmarks zur Semantik-Erkennung                 │
│  • Confidence Score pro Capability pflegen                  │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                   TOOL UNDERSTANDING LOOP                   │
│  • Test-Prompts und erwartete Ergebnisse pro Tool           │
│  • Automatische Regression-Erkennung                        │
│  • Vertrauenswert-Autoanpassung                             │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                CAPABILITY EXPANSION LOOP                    │
│  • Fehlende Fähigkeit → Apprenticeship Ticket               │
│  • Recherche offizieller APIs/Docs + Auth-Modell           │
│  • Connector-Spec + Tests + Minimal-Adapter Entwurf          │
│  • Sandbox-Test → Risk-Review → Genehmigung                 │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Vorschläge für die Agent-als-Arbeiter-Architektur

### 3.1 Lebenszyklus-Modell des Agenten

Der Master Agent sollte einem klaren Lebenszyklus folgen:

```typescript
type AgentLifecycleState =
  | 'IDLE' // Wartet auf Auftrag
  | 'ANALYZING' // Contract wird zerlegt
  | 'PLANNING' // Schritte werden geplant
  | 'EXECUTING' // Aktionen werden ausgeführt
  | 'VERIFYING' // Ergebnisse werden geprüft
  | 'REFINING' // Bei Fehlern: neu planen
  | 'COMPLETED' // Erfolgreich beendet
  | 'FAILED' // Endgültig fehlgeschlagen
  | 'AWAITING_APPROVAL'; // Warten auf menschliche Genehmigung
```

### 3.2 Kontrakt-Verarbeitung (Contract → Action)

Der Agent sollte einen _Contract_ (Auftrag) wie folgt verarbeiten:

```
Contract-Input
     │
     ▼
┌─────────────┐     ┌──────────────────┐
│  Parser &   │────▶│  Task Decomposer  │
│  Validator  │     │  (Zerlegung in    │
└─────────────┘     │   Teilaufgaben)   │
                   └──────────────────┘
                            │
                            ▼
                   ┌──────────────────┐
                   │  Executor Loop   │
                   │  (nächster Step) │
                   └──────────────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
        ┌──────────┐  ┌──────────┐  ┌──────────┐
        │ Verified │  │ Retry    │  │ Blocked  │
        │ ✓        │  │ ↻        │  │ ⏸        │
        └──────────┘  └──────────┘  └──────────┘
              │             │             │
              └─────────────┴─────────────┘
                            │
                            ▼
                   ┌──────────────────┐
                   │  Result Bundle   │
                   │  (Exportierbar)  │
                   └──────────────────┘
```

### 3.3 Fähigkeiten-Inventar mit Vertrauenswerten

Der Agent sollte eine strukturierte Capabilities-Übersicht führen:

```typescript
interface Capability {
  id: string;
  name: string;
  type: 'tool' | 'connector' | 'skill';
  confidence: number; // 0.0 - 1.0
  lastVerified: Date;
  benchmarkResults: Benchmark[];
  status: 'active' | 'learning' | 'disabled';
  requiresApproval: boolean;
}

interface Benchmark {
  timestamp: Date;
  prompt: string;
  expectedOutput: string;
  actualOutput: string;
  passed: boolean;
  latencyMs: number;
}
```

### 3.4 Selbstorganisation: Der interne "Arbeiter"

Der Agent sollte intern folgende Rollen haben:

| Rolle              | Verantwortung                               |
| ------------------ | ------------------------------------------- |
| **Planner**        | Zerlegt Aufgaben in ausführbare Schritte    |
| **Executor**       | Führt die Schritte mit Tools/Connectors aus |
| **Verifier**       | Prüft Ergebnisse gegen Erwartungen          |
| **Learner**        | Passt Strategien basierend auf Feedback an  |
| **Safety Officer** | Prüft jede Aktion gegen Richtlinien         |

### 3.5 Apprenticeship-Workflow für neue Fähigkeiten

Wenn der Agent eine fehlende Fähigkeit erkennt:

```
┌─────────────────────────────────────────────────────────────┐
│              FEHLENDE FÄHIGKEIT ERKANNT                     │
│  (z.B. "Instagram-Post erstellen")                          │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│              APPRENTICESHIP TICKET ERSTELLT                 │
│  • Anfrage dokumentiert                                     │
│  • Priorität bestimmt                                       │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│              FORSCHUNGSPHASE                                │
│  • Offizielle Instagram Graph API Docs studieren            │
│  • Auth-Flow (OAuth2) analysieren                           │
│  • Rate Limits, Scopes, ToS prüfen                         │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│              PROPOSAL GENERIERUNG                            │
│  • Connector-Spezifikation (Types + Actions)               │
│  • Minimal-Adapter-Entwurf                                  │
│  • Tests + Sandbox                                          │
│  • Risk-Review (Sicherheit, Datenschutz, ToS)              │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│              GENEHMIGUNGSANFRAGE                             │
│  → Wartet auf menschliche Freigabe                         │
│  → Nach Genehmigung: Connector wird aktiviert               │
└─────────────────────────────────────────────────────────────┘
```

### 3.7 Sub-Agenten-Verwaltung (Delegation)

Ein eigenständiger Arbeiter sollte in der Lage sein, **Sub-Agenten** zu erstellen und zu beauftragen. Dies ermöglicht dem Master Agenten:

- Parallele Aufgabenbearbeitung durch mehrere spezialisierte Agenten
- **Stets erreichbar und reagierbar** zu bleiben, während Sub-Agenten arbeiten
- Komplexe Aufgaben in Teilaufgaben zu zerlegen und zu delegieren
- Ergebnisse der Sub-Agenten zu aggregieren und zu verifizieren

```typescript
interface SubAgent {
  id: string;
  name: string;
  type: 'specialized' | 'general' | 'one-off';
  capabilities: string[];
  status: 'idle' | 'busy' | 'completed' | 'failed';
  parentAgentId: string;
  createdAt: Date;
}

interface SubAgentTask {
  id: string;
  subAgentId: string;
  task: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: any;
  error?: string;
}
```

**Delegation-Workflow:**

```
Master Agent erhält Auftrag
         │
         ▼
┌────────────────────────────────┐
│  Aufgabenanalyse & Zerlegung  │
│  (welche Sub-Agents nötig?)   │
└────────────────────────────────┘
         │
         ▼
┌────────────────────────────────┐
│  Sub-Agent(en) erstellen      │
│  oder aus Pool auswählen      │
└────────────────────────────────┘
         │
         ▼
┌────────────────────────────────┐
│  Aufgaben delegieren           │
│  (mit klarer Spezifikation)   │
└────────────────────────────────┘
         │
         ▼
┌────────────────────────────────┐
│  Master bleibt erreichbar     │
│  für Rückfragen & Koordination│
└────────────────────────────────┘
         │
         ▼
┌────────────────────────────────┐
│  Ergebnisse sammeln           │
│  → Verifizieren               │
│  → Aggregieren                │
└────────────────────────────────┘
```

**Wichtige Aspekte:**

1. **Isolation**: Sub-Agenten laufen in separaten Kontexten
2. **Transparenz**: Jede Delegation wird protokolliert
3. **Erreichbarkeit**: Master Agent kann jederzeit Rückfragen beantworten
4. **Qualitätssicherung**: Master verifiziert Sub-Agent-Ergebnisse
5. **Ressourcen-Limits**: Sub-Agenten haben eigene Budgets und Timeouts

### 3.8 Sicherheitsarchitektur

Für einen eigenständigen Arbeiter sind Sicherheitsmechanismen essenziell:

```typescript
interface SafetyPolicy {
  // Was darf der Agent NIE tun?
  forbiddenActions: string[];

  // Was darf nur mit Genehmigung passieren?
  approvalRequiredActions: string[];

  // Was erfordert einen "Dry Run" zuerst?
  dryRunRequiredActions: string[];

  // Ressourcen-Limits
  maxRetries: number;
  timeoutMs: number;
  maxCostPerRun: number;
}
```

**Empfohlene Verbote:**

- Kein Zugriff auf Dateien außerhalb des Workspaces
- Keine Credentials von Drittanbietern ohne Vault
- Keine Änderungen an Systemkonfigurationen ohne explizite Erlaubnis
- Keine externen API-Aufrufe ohne Genehmigung

---

## 4. User Experience: Wie der Benutzer mit dem Agenten arbeitet

### 4.1 Auftrag erstellen

Der Benutzer erstellt einen **Contract** – eine strukturierte Auftragsbeschreibung:

```json
{
  "title": "Wöchentlicher Newsletter versenden",
  "goal": "Versende einen Newsletter an alle Abonnenten mit den neuesten Artikeln",
  "constraints": {
    "deadline": "2026-03-01T12:00:00Z",
    "maxEmailsPerHour": 100,
    "approvalRequiredFor": ["send", "newRecipients"]
  },
  "context": {
    "recentArticles": ["Article 1", "Article 2", "Article 3"]
  }
}
```

### 4.2 Transparente Fortschrittsanzeige

Der Agent sollte dem Benutzer jederzeit zeigen:

- **Aktueller Schritt**: Was wird gerade getan?
- **Fortschrittsbalken**: Wie viel ist erledigt?
- **Letzte Aktionen**: Was wurde zuletzt gemacht?
- **Offene Genehmigungen**: Was wartet auf Freigabe?
- **Confidence**: Wie sicher ist der Agent bei aktuellen Schritten?

### 4.3 Ergebnisse verifizieren

Der Agent liefert nicht nur ein Ergebnis, sondern:

- **Verifiable Output**: Konkrete Artefakte (E-Mails gesendet, Dateien erstellt)
- **Audit Trail**: Vollständige Dokumentation aller Schritte
- **Confidence Score**: Wie sicher ist das Ergebnis?
- **Verbesserungsvorschläge**: Was könnte besser sein?

---

## 5. Erfolgskennzahlen (aus dem Plan)

Der Plan definiert folgende Metriken, die auch für die Agent-als-Arbeiter-Philosophie relevant sind:

| Metrik                         | Beschreibung                                            |
| ------------------------------ | ------------------------------------------------------- |
| `run_completion_rate`          | Wie viele Aufträge werden erfolgreich beendet?          |
| `verify_pass_rate`             | Wie oft besteht das Ergebnis die Verifikation?          |
| `median_time_to_done`          | Wie lange dauert ein durchschnittlicher Auftrag?        |
| `rework_rate`                  | Wie oft muss nachgebessert werden?                      |
| `capability_growth_cycle_time` | Wie schnell kann eine neue Fähigkeit integriert werden? |
| `unsafe_action_block_rate`     | Wie oft werden unsichere Aktionen blockiert?            |

---

## 6. Empfehlungen für die Implementierung

### 6.1 Frühphasige Prioritäten

1. **Master Lifecycle Engine** (WS4) – Das Herzstück des Agenten
2. **Verification Gate** – Automatische Prüfung der Ergebnisse
3. **Basic Capabilities** – Web Search, Notes, Reminders

### 6.2 Erweiterte Fähigkeiten

1. **Gmail Connector** (WS6) – Für E-Mail-Delegation
2. **Safety Layer** (WS8) – Für sichere autonome Operationen

### 6.3 Lernfähigkeit

1. **Capability Inventory** (WS9) – Transparenz über Fähigkeiten
2. **Apprenticeship Loop** (WS10) – Selbstständige Erweiterung

---

## 7. Fazit

Der Master Agent V4 ist konzipiert als **autonomer Arbeiter**, der:

- Eigenständig Aufgaben von der Anfrage bis zum verifizierten Ergebnis durchführt
- Kontinuierlich aus Feedback lernt und seine Fähigkeiten erweitert
- Transparent arbeitet und dem Benutzer jederzeit Einblick gewährt
- Sicherheitsrichtlinien einhält und bei Unsicherheiten menschliche Hilfe sucht

Die drei Lernschleifen (System Learning, Tool Understanding, Capability Expansion) bilden das Fundament für einen **selbstverbessernden Agenten**, der mit der Zeit immer besser wird – genau wie ein menschlicher Arbeiter, der aus Erfahrung lernt.

Die klare Trennung vom Agent Room und die separaten vertikalen Slices stellen sicher, dass der Master Agent das bestehende System nicht beeinträchtigt und sicher erweitert werden kann.

---

_Erstellt am: 2026-02-27_
_Modus: Documentation Specialist_
