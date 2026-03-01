# Verbesserungsplan: Weiblicher GLTF-Full-Body-Avatar (ohne 2D-Fallback)

## Ziel

Ein neues GLTF-basiertes weibliches Full-Body-Avatar-Modell im Master-Entry anzeigen (Kopf, Augen, Mund, Torso, Arme/Hände, Beine/Füße), mit prozeduralen Animationen für Gehen, Springen und Hinsetzen plus Gesichtsanimationen; weiterhin ohne schwarzen Hintergrund, ohne sichtbare Kasten-Umrandung, ohne hellblauen Kreis und ohne bewegte Scan-Linie sowie ohne Wechsel auf 2D-Fallback.

## Umsetzungsplan (inkl. Status)

### Phase 1: Neues 3D-Asset bereitstellen

- [x] Neues GLTF-Modell `public/models/hologram-female-face.gltf` erstellt.
- [x] Node-Namen für Runtime-Animation festgelegt: `HologramAvatarFullBody`, `Head_Main`, `Torso_Main`, `Arm_Left`, `Arm_Right`, `Leg_Left`, `Leg_Right`, `Hand_Left`, `Hand_Right`, `Foot_Left`, `Foot_Right`, `Eye_Left`, `Eye_Right`, `Mouth_Main`.
- [x] Generator-Skript hinzugefügt: `scripts/generate-hologram-female-face-gltf.mjs`.
- [x] Modell vollständig neu aufgebaut als Full-Body-Avatar mit hierarchischen Knoten für Arme/Hände und Beine/Füße.

### Phase 2: Master-Canvas auf neues Modell umstellen

- [x] Loader-Pfad in `MasterFaceCanvasThree.tsx` auf `/models/hologram-female-face.gltf` geändert.
- [x] Node-Hooks für Kopf/Gesicht/Körperteile per `getObjectByName(...)` ergänzt.
- [x] Animationen ergänzt:
  - [x] Blinzeln + subtile Augenbewegung
  - [x] Mundöffnung abhängig von `state` + `amplitude` beim Sprechen
  - [x] Full-Body-Lokomotion mit `walkCycle`, `jumpOffset`, `sitAmount`
  - [x] Raumbewegung des Avatars über X/Z-Ziele (Roaming innerhalb des sichtbaren Bereichs)

### Phase 3: Kein schwarzer Hintergrund

- [x] Schwarzer Scene/Canvas-Hintergrund entfernt (Renderer bleibt transparent).
- [x] Entry-Page-Container mit blauem holografischen Gradient statt schwarzer Fläche gestaltet.
- [x] Sichtbare Face-Box-Umrandung (`border/rounded/padded card`) entfernt.
- [x] Heller Kreis/Aura im Three-Canvas entfernt.
- [x] Bewegte horizontale Scan-Linie im Three-Canvas entfernt.

### Phase 4: 3D-only Fehlerpfad (kein 2D-Fallback)

- [x] Bei Ladefehlern bleibt die 3D-Komponente aktiv und zeigt Error-Overlay.
- [x] Retry lädt dasselbe GLTF neu.
- [x] Kein Import/Wechsel auf `MasterFaceCanvas` (2D).

### Phase 5: Qualitätssicherung

- [x] Contract-Tests für 3D-Verhalten und Modellknoten ergänzt.
- [x] Fokus-Tests grün.
- [x] Typecheck grün.
- [x] Lint grün mit bekannten vorbestehenden A11y-Warnungen in anderen Master-Form-Komponenten.

## Betroffene Dateien

- `src/modules/master/components/MasterFaceCanvasThree.tsx`
- `src/modules/master/components/MasterEntryPage.tsx`
- `public/models/hologram-female-face.gltf`
- `scripts/generate-hologram-female-face-gltf.mjs`
- `tests/unit/modules/master/master-face-canvas-three-interaction-contract.test.ts`
- `tests/unit/modules/master/master-hologram-female-face-model.test.ts`
