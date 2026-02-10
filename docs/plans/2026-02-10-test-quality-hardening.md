# Test & Quality Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Vitest + ESLint (Security/Code-Qualität) integrieren, reale Fehler finden/fixen und einen erfolgreichen Production-Build sicherstellen.

**Architecture:** Die bestehenden Kernmodule bleiben bestehen; wir ergänzen Tooling über Konfigurationsdateien und fokussieren Tests auf reine Utility-Logik. Funktionale Lücken in der Messenger-Ansicht werden direkt in bestehender Komponentenstruktur geschlossen.

**Tech Stack:** Vite, React 19, TypeScript, Vitest, ESLint 9 (flat config), eslint-plugin-security, eslint-plugin-sonarjs.

---

### Task 1: Baseline erfassen

**Files:**
- Modify: `package.json`

1. `npm install` ausführen
2. Build/Typecheck laufen lassen
3. Ausgangsstatus dokumentieren

### Task 2: Vitest per TDD integrieren

**Files:**
- Create: `vitest.config.ts`
- Create: `tests/audio.test.ts`
- Create: `tests/skills-definitions.test.ts`

1. Failing Tests für vorhandene Utility-Logik schreiben
2. `npm run test` ausführen und Failures prüfen
3. Minimalen Code-Fix implementieren
4. Tests erneut ausführen bis grün

### Task 3: Linting mit Security/Quality Plugins

**Files:**
- Create: `eslint.config.js`
- Modify: `package.json`

1. ESLint + Plugins installieren
2. Regeln für Security/Quality aktivieren
3. `npm run lint` ausführen
4. Befunde im Code fixen

### Task 4: App vervollständigen und Abschlussverifikation

**Files:**
- Modify: `messenger/ChannelPairing.tsx`
- Create: `messenger/shared/GenericChannelHandler.tsx`
- Create: `index.css`

1. Platzhalter-UI für Discord/iMessage durch funktionale Handler ersetzen
2. Fehlende CSS-Datei ergänzen
3. `npm run lint && npm run test && npm run build` ausführen
4. Ergebnisse berichten
