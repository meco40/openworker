# Master Hologram Interaction Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Das Master-Hologramm in der Entry-Page soll korrekt animieren und per Maus/Touch/Wheel interaktiv steuerbar sein, ohne 2D-Fallback.

**Architecture:** Die bestehende Three.js-Komponente `MasterFaceCanvasThree` bleibt zentral. Wir beheben zuerst den Referenzfehler im GLTF-Load-Pfad, erweitern danach die Runtime um kontrollierte Orbit-/Zoom-Interaktion und ergänzen einen robusten 3D-Error-Pfad mit Retry innerhalb derselben Komponente (kein Wechsel auf 2D). Die Änderungen werden durch source-contract-Tests abgesichert.

**Tech Stack:** React, Three.js, GLTFLoader, Vitest

---

### Task 1: Failing Tests für Verhalten schreiben (TDD RED)

**Files:**

- Create: `tests/unit/modules/master/master-face-canvas-three-interaction-contract.test.ts`
- Test: `tests/unit/modules/master/master-face-canvas-three-interaction-contract.test.ts`

**Step 1: Write the failing test**

- Verlangt explizite Aktualisierung von `sceneRef.current.humanGroup` nach GLTF-Load.
- Verlangt Pointer-/Wheel-Interaktion (Drag/Zoom).
- Verlangt Error-State + Retry ohne 2D-Fallback.

**Step 2: Run test to verify it fails**

- Run: `npm test -- tests/unit/modules/master/master-face-canvas-three-interaction-contract.test.ts`
- Expected: FAIL auf mindestens einen fehlenden Contract.

### Task 2: 3D-Komponente minimal implementieren (TDD GREEN)

**Files:**

- Modify: `src/modules/master/components/MasterFaceCanvasThree.tsx`

**Step 1: Bugfix GLTF-Referenzpfad**

- `sceneRef.current.humanGroup` im Loader-Success-Callback auf geladenes `gltf.scene` setzen.

**Step 2: Interaktionssteuerung ergänzen**

- Pointer-Drag: Yaw/Pitch-Offsets mit Damping/Clamping.
- Wheel-Zoom: Kamera-Z entlang Min/Max-Grenzen.
- Touch: über Pointer-Events abgedeckt (kein separater 2D-Pfad).

**Step 3: Error/Retry ergänzen (ohne Fallback)**

- Bei Load-Error Overlay mit Hinweis + Retry-Button.
- Retry lädt dasselbe 3D-Asset erneut.

**Step 4: Run test to verify it passes**

- Run: `npm test -- tests/unit/modules/master/master-face-canvas-three-interaction-contract.test.ts`
- Expected: PASS.

### Task 3: Regression-Sicherheit und Abschluss

**Files:**

- Optionally verify: `tests/unit/modules/master/grok-voice-agent-lazy-connect.test.ts`

**Step 1: Typecheck**

- Run: `npm run typecheck`
- Expected: 0 errors.

**Step 2: Focused regression check**

- Run: `npm test -- tests/unit/modules/master/grok-voice-agent-lazy-connect.test.ts`
- Expected: PASS.

**Step 3: Dokumentation/Kontinuität aktualisieren**

- `.agent/CONTINUITY.md` um neue Entscheidungen/Outcomes ergänzen.
