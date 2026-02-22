# 🚀 OpenClaw Gateway – Improvement Roadmap

> **Erstellt:** 11. Februar 2026
> **Version:** v1.2.5
> **Plattform:** Next.js 16 (App Router) · React 19 · TypeScript 5.8 (strict)

---

## 📊 Aktueller Stand

| Feature                                                                  | Status                              |
| ------------------------------------------------------------------------ | ----------------------------------- |
| 12 Views in der Sidebar                                                  | ✅ Implementiert                    |
| Multi-Provider AI Hub (11 Provider)                                      | ✅ mit Fallback-Pipeline            |
| Multi-Channel Messaging (Telegram, WhatsApp, Discord, iMessage, WebChat) | ✅ SSE-basiert                      |
| Autonomer Worker                                                         | ✅ Sequential Queue                 |
| Voice Mode (Gemini Native Audio)                                         | ✅                                  |
| Vision Skill (`vision_analyze`)                                          | ✅                                  |
| Skills System (7 Built-In)                                               | ✅ Persistent in SQLite             |
| Logs, Stats, Security Panel                                              | ✅                                  |
| SQLite Persistenz                                                        | ✅ Messages, Credentials, Model Hub |

---

## 🏆 Killer Features – Was OpenClaw einzigartig macht

### 1. 🧠 AI Prompt Chain Builder (Visual Pipeline Editor)

**Was:** Ein visueller Drag-and-Drop Editor, in dem Nutzer **multi-step AI Workflows** zusammenbauen können – wie ein Mini-Langchain/LangGraph direkt im Browser.

**Beispiel-Flow:**

```
[Trigger: Telegram msg] → [Classify Intent] → [If "code-question" → Gemini Pro]
                                              [If "creative" → Claude 3.5]
                                              [If "analysis" → GPT-4o]
                        → [Enrich with Memory] → [Send Reply via SSE]
```

**Warum einzigartig:** Das Model Hub hat bereits 11 Provider + Pipeline-Fallback. Jetzt fehlt der nächste Schritt: **intelligentes Routing basierend auf Nachrichteninhalt**, nicht nur Fehler-Fallback. Kein anderes Open-Source-Gateway bietet das so nativ als Visual Editor.

**Technische Basis:**

- `ModelHubService.dispatchWithFallback()` ist bereits implementiert → erweitern um Conditional Routing
- Neue API-Route: `/api/pipelines` für CRUD der Flow-Definitionen
- Frontend: React-basierter Node-Editor (z.B. mit ReactFlow oder eigenem Lightweight-System)
- Persistierung der Flow-Definitionen in SQLite

---

### 2. 📊 Real-Time Cost Tracker mit Budget Alerts

**Was:** Automatische Berechnung der **$ Kosten** pro Provider/Modell und intelligentes Budget-Management.

**Features:**

- Automatische **$ Kosten-Berechnung** basierend auf aktuellen Provider-Pricing-Tabellen
- **Budget-Limits** setzen pro Tag/Woche/Monat
- **Alert-System**: Benachrichtigung bei 80% Verbrauch, Auto-Pause bei 100%
- **Cost Comparison**: "Diese Query hätte bei GPT-4o $0.12 gekostet, bei Gemini Flash nur $0.001"
- **Cost Dashboard Widget** mit Trend-Grafik

**Technische Basis:**

- `StatsView.tsx` hat bereits Token-Tracking via `/api/stats` → erweitern um Pricing-Daten
- Pricing-Tabelle als JSON-Config (Cent pro 1K Input/Output Tokens pro Modell)
- Neues SQLite-Table: `cost_tracking` (timestamp, model, provider, tokens_in, tokens_out, cost_usd)
- Budget-Config in Gateway Config Editor integrieren

**Warum:** Wer mehrere AI-Provider nutzt, braucht dringend Kostenkontrolle. Kein anderes Self-Hosted Gateway bietet das nativ.

---

### 3. 📋 Knowledge Base / RAG-System

**Was:** Dokumenten-basierte Wissensbasis, die der AI-Agent automatisch durchsucht.

**Features:**

- **Dokument-Upload** (PDF, TXT, MD, DOCX) → automatisch ge-chunked + embedded
- **Vector Store** mit dem bestehenden `ModelHubService.dispatchEmbedding()`
- Der AI-Agent **durchsucht automatisch** die Knowledge Base bei relevanten Fragen
- Dashboard-Widget zeigt Top-5 am häufigsten referenzierte Dokumente
- **Namespace-Support**: Verschiedene Knowledge Bases pro Team/Workspace

**Technische Basis:**

- `dispatchEmbedding()` in `ModelHubService` ist bereits implementiert
- `core_memory_store` / `core_memory_recall` existiert → erweitern um Document Chunks
- SQLite-Tables: `kb_documents`, `kb_chunks`, `kb_embeddings`
- Neue View: Knowledge Base Manager (Upload, Browse, Search)
- Skill-Handler: `kb_search` für den AI-Agent

---

## ⚡ Smart Improvements – Bestehende Features upgraden

### 4. 💬 Chat: Streaming Responses + Markdown Rendering

**Was:** AI-Antworten werden **Token für Token** gestreamt statt als Block geliefert. Dazu vollständiges Markdown-Rendering.

**Features:**

- **SSE Streaming** für AI-Antworten (Token-by-Token Output)
- **Markdown** Rendering mit Syntax-Highlighting für Code-Blöcke
- **Copy-to-Clipboard** Button für Code-Blöcke
- **Reaction Buttons** (👍 👎) für Feedback / RLHF
- **Message Actions**: Reply, Edit, Delete, Forward

**Technische Basis:**

- `ModelHubService.dispatchChat()` → Streaming-Variante hinzufügen
- Gateway dispatch auf `stream: true` erweitern (Gemini SDK unterstützt `generateContentStream`)
- Chat UI: Token-Buffer + progressive Markdown-Rendering
- Library: `react-markdown` + `react-syntax-highlighter` oder `shiki`

**Impact:** Der Chat fühlt sich sofort 10x moderner an. Streaming ist heute Standard und fehlt komplett.

---

### 5. 🧩 Skill Marketplace mit GitHub Integration

**Was:** Die Skill-Installation via GitHub/npm ist vorbereitet, aber nur ein Input-Feld. Upgrade zu einem kuratierten Skill Catalog.

**Features:**

- Kuratierter **Skill Catalog** mit vordefinierten Community-Skills
- **One-Click Install** für populäre Skills (Web Scraper, PDF Parser, Image Gen, etc.)
- **Versionsmanagement**: Upgrade/Downgrade-Notifications
- **Skill Analytics**: Wie oft wurde welcher Skill benutzt? Durchschnittliche Ausführungszeit?
- **Skill Testing**: Sandbox-Modus zum Testen vor der Aktivierung

**Technische Basis:**

- `skillInstaller.ts` + `skillRepository.ts` sind bereits implementiert
- `SkillsRegistry` Component hat ein Install-Modal → erweitern zu einem Browse-Catalog
- Skills-Catalog als JSON-Manifest (hosted auf GitHub oder lokal)
- Neues SQLite-Table: `skill_usage_stats` (skill_id, invocation_count, avg_duration, last_used)

---

### 6. ⏱️ Advanced Automation & Scheduled Workflows

**Was:** Task Scheduling von rudimentärem Level auf CRON-Level bringen.

**Features:**

- **Recurring Tasks**: "Jeden Montag 9:00 → Zusammenfassung der letzten Woche via Telegram senden"
- **Webhook-Trigger**: Externe Events starten Worker-Tasks
- **Conditional Logic**: If/Then-Flows ("Wenn GPU-Kosten > $10, wechsle zu Gemini Flash")
- **Visuelle Timeline-Ansicht** im Task Monitor
- **Task Templates**: Vordefinierte Automatisierungen als Vorlagen

**Technische Basis:**

- `useTaskScheduler` Hook + `ScheduledTask` Type existieren bereits
- Worker Agent (`workerAgent.ts`) hat Queue-Processing → erweitern um CRON-Expressions
- Neues SQLite-Table: `automation_rules` (trigger, conditions, actions, schedule)
- API: `/api/automations` für CRUD

---

## 🎯 Quick Wins – Sofort umsetzbar, hoher Impact

| #   | Quick Win                                                            | Aufwand | Impact |
| --- | -------------------------------------------------------------------- | ------- | ------ |
| 1   | **Notification Center** (Glocke im Header, ungelesene Alerts)        | 2-3h    | 🔥🔥🔥 |
| 2   | **Breadcrumb Navigation** in der Header-Area                         | 1h      | 🔥🔥   |
| 3   | **Export Conversations** als PDF/Markdown                            | 2h      | 🔥🔥   |
| 4   | **Suche über alle Conversations** (Full-Text SQLite FTS5)            | 3-4h    | 🔥🔥🔥 |
| 5   | **Loading Skeletons** statt leerer States                            | 2h      | 🔥🔥   |
| 6   | **Onboarding Tutorial** (First-Time User Guide)                      | 3h      | 🔥🔥   |
| 7   | **Error Toasts** statt `alert()` (ConfigEditor nutzt noch `alert()`) | 1h      | 🔥🔥   |

### Quick Win Details

#### Notification Center

- Glocke-Icon rechts oben im `AppShellHeader`
- Badge mit Anzahl ungelesener Benachrichtigungen
- Dropdown mit Timeline: "Worker Task #3 completed", "Telegram Channel disconnected", "Budget 80% reached"
- Quellen: Worker-Events, Channel-Status-Changes, Budget-Alerts, Skill-Fehler

#### Full-Text Suche

- SQLite FTS5 Extension für Message-Tabelle
- Search-Bar im Chat-Interface (Ctrl+F oder eigenes Suchfeld)
- Highlight der Treffer in der Conversation-Liste
- Filter: nach Channel, Zeitraum, Rolle (user/agent)

#### Error Toast System

- Globale Toast-Komponente (Bottom-Right oder Top-Right)
- Typen: `success`, `error`, `warning`, `info`
- Auto-Dismiss nach 5 Sekunden
- Ersetzt alle `alert()` Aufrufe im Projekt (ConfigEditor, etc.)

---

## 📋 Priorisierte Roadmap

### **Phase 1 – Quick Wins & Chat Upgrade (1-2 Wochen)**

1. ✅ Toast-System statt `alert()`
2. ✅ Notification Center
3. ✅ Streaming Responses im Chat
4. ✅ Markdown Rendering + Code Highlighting
5. ✅ Loading Skeletons
6. ✅ Full-Text Suche über Conversations

### **Phase 2 – Differentiators (2-3 Wochen)**

7. 💰 Real-Time Cost Tracker mit Budget Alerts
8. 📋 Knowledge Base / RAG-System
9. 🧩 Skill Marketplace mit Catalog

### **Phase 3 – Vision Features (3-4 Wochen)**

10. 🧠 Visual AI Pipeline Builder
11. ⏱️ Advanced Automation (CRON + Webhook-Trigger)
12. 📤 Export Conversations (PDF/MD)
13. 🗺️ Onboarding Tutorial

---

_Dieses Dokument wird fortlaufend aktualisiert._
_Stand: 11. Februar 2026_
