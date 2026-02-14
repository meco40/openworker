# Worker Auto + 4 Presets Decision And Optimization Roadmap

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Worker-UX und Output-Qualität verbessern, bei gleichzeitiger Vereinfachung der Preset-Strategie auf `Auto + 4 Presets`.

**Architecture:** `Auto` wird Standard-Modus und kann alle verfügbaren Tools/CLI nutzen. Presets bleiben als optionale Profile (Research, WebApp, Daten, Allgemein) mit sinnvollen Defaults für Scaffold, Qualitäts-Gates und Ergebnisformate. `Kreativ` wird entfernt.

**Tech Stack:** Next.js/React UI, Worker Agent (`workerAgent`/`workerPlanner`/`workerExecutor`), SQLite Worker Repository, Workspace-Dateisystem.

---

## 1. Entscheidung (verbindlich)

Ab 2026-02-13 gilt für die Worker-Funktion:

1. Standardmodus ist `Auto (Empfohlen)`.
2. Presets bleiben optional als Profile erhalten:

- `Research`
- `WebApp`
- `Daten`
- `Allgemein`

3. `Kreativ` wird aus der UI und der Preset-Liste entfernt.
4. Presets begrenzen nicht die Kernfähigkeit der KI, sondern liefern bessere Defaults und Governance.

## 2. Warum diese Entscheidung

1. `Auto` deckt die meisten Aufgaben ohne zusätzliche Nutzereingaben ab.
2. Presets sind weiterhin nützlich für:

- Vorhersagbarkeit (Kosten/Laufzeit)
- Reproduzierbarkeit
- Domain-spezifische Qualitätsregeln
- Output-Vorgaben (z. B. bevorzugte Dateiformate)

3. `Kreativ` ist aktuell technisch nicht stabil genug als eigenes Preset, weil Bild-/Video-Erzeugung in der bestehenden Toolchain nicht konsistent abgesichert ist.

## 3. Produktprinzipien für den Worker

1. Outcome vor Prozess: Nutzer soll verwertbare Ergebnisdateien bekommen, nicht nur Plan-/Log-Artefakte.
2. Auto-first UX: Einfache Standardnutzung, erweiterte Steuerung optional.
3. Profile statt Einschränkungen: Presets steuern Defaults, nicht harte Capability-Silos.
4. Transparenz mit Sicherheit: Status klar sichtbar, sensible Rohdaten kontrolliert.

## 4. Priorisierte Verbesserungsfelder

### P0 - Preset-Strategie konsolidieren

1. `Kreativ` aus `Workspace-Typ` Auswahl entfernen.
2. UI-Default auf `Auto` setzen.
3. Presets unter "Erweitert" platzieren und als "Profile" benennen.
4. Dokumentation (`docs/WORKER_SYSTEM.md`) auf neuen Modus aktualisieren.

### P1 - Ergebnisorientierter Output (höchster Nutzen)

1. Deliverable-Contract einführen (vom Planner ableitbar): gewünschte Ausgabeformate und Ziel-Dateien.
2. Mindeststandard: Jede abgeschlossene Task erzeugt `output/final.md`.
3. Bei explizitem Nutzerwunsch automatische Generierung zusätzlicher Dateien, z. B.:

- `final.pdf`
- `final.docx`
- `final.xlsx` (bei tabellarischen Daten)

4. Output-Tab um "Ergebnisdateien" erweitern (direkter Download pro Datei).
5. ZIP als "Workspace/Debug Export" klar getrennt kennzeichnen.

### P2 - Qualitäts- und Abschlusskriterien

1. Task nur dann `completed`, wenn alle required Deliverables existieren.
2. Falls Deliverables fehlen: Status `review` mit klarer Begründung.
3. Verifikation je Deliverable:

- Dateiexistenz
- sinnvolle Größe
- MIME/Extension Konsistenz

### P3 - Beobachtbarkeit und Nachvollziehbarkeit

1. Activities um Deliverable-Events ergänzen (`created`, `verified`, `failed`).
2. Terminal/Statusmeldungen um "Output erstellt" Ereignisse erweitern.
3. Endzusammenfassung auf Ergebnisdateien fokussieren (nicht nur Schritte).

### P4 - Sicherheits- und Governance-Rahmen

1. Tool-/CLI-Nutzung weiterhin über bestehende Approval-/Policy-Pfade.
2. Für Auto-Install/Tooling klare Guardrails:

- Timeout
- erlaubte Pfade
- Ressourcengrenzen
- Audit-Logging

3. Kein ungeprüftes Persistieren sensibler Inhalte in nutzerseitigen Outputdateien.

## 5. Konkrete nächste Umsetzungssequenz

1. Decision Freeze umsetzen (`Auto + 4 Presets`, `Kreativ` raus).
2. Deliverable-MVP implementieren (`output/final.md` + UI-Download + klare ZIP-Beschriftung).
3. Deliverable-Contract im Planner ergänzen.
4. Output-Generierung für PDF/DOCX/XLSX stufenweise ausrollen.
5. Abschlusspolicy auf required Deliverables umstellen.

## 6. Erfolgskriterien

1. Nutzer können Ergebnisdateien direkt herunterladen, ohne ZIP durchsuchen zu müssen.
2. ZIP enthält weiterhin vollständigen Workspace, ist aber nicht der primäre Ergebnisweg.
3. Anteil Tasks mit mindestens einer verwertbaren Ergebnisdatei steigt deutlich.
4. Support-Aufkommen "Output nicht auffindbar" sinkt.

## 7. Offene Entscheidungen (für nächste Review)

1. Soll `Auto` bei fehlendem Formatwunsch standardmäßig zusätzlich `pdf` erzeugen oder nur `md`?
2. Welche Dateiformate gelten je Preset als "Default required"?
3. Welche Maximalgröße gilt pro Deliverable in der ersten Version?
