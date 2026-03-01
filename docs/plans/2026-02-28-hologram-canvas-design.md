# Implementierungsplan: Hologramm-Canvas (MasterFaceCanvas)

Datum: 2026-02-28

---

## Ziel

Ein hochdetailliertes, holografisches Wireframe-Mesh eines weiblichen Torsos/Kopfes im Canvas, mit elektrischer Cyan-Farbe, glühenden Knotenpunkten, AdditiveBlending, Scan-Line-Effekt, Glitch-Flimmern, Rauschen, sanfter Rotation und "Atmen"-Animation. Die Geometrie basiert auf einer modifizierten Icosahedron oder Punktwolke.

---

## Task 1: Hologramm-Canvas (MasterFaceCanvas)

**Files:**

- Modify: src/modules/app-shell/MasterFaceCanvas.tsx
- Test: Manuelle visuelle Prüfung, Typecheck

### Step 1: Schreibe die neue Canvas-Komponente

- React + drei/fiber + drei
- Schwarzer Hintergrund
- IcosahedronGeometry mit subdivisions=7
- Modifiziere Vertex-Positionen für weibliche Silhouette (Kopf, Hals, Brust, Schultern)
- Wireframe und Points-Rendering
- Material: elektrisches Cyan, AdditiveBlending, glühende Knoten
- Scan-Line-Effekt: ShaderMaterial mit animierter Opacity/Color entlang Y-Achse
- Glitch-Flimmern: Shader-Noise/Random Opacity
- "Atmen": Sinus-Skalierung, Rotation

### Step 2: Führe Typecheck aus

- Run: npx tsc --noEmit
- Expected: 0 errors

### Step 3: Starte Dev-Server und prüfe visuell

- Run: npm run dev
- Expected: Canvas zeigt holografisches Wireframe, Scan-Line, Glitch, Atmen, Rotation

### Step 4: Commit

---

## Hinweise

- Shader-Code für Scan-Line und Glitch wird direkt in der Komponente definiert.
- Keine externen Assets, alles generativ.
- Fallback: Zeige Icosahedron ohne Modifikation, falls Shader nicht unterstützt.
- Visuelle Prüfung ist entscheidend.

---

## Definition of Done

- Canvas zeigt ein holografisches Wireframe mit allen Effekten und Animationen.
- Typecheck und Dev-Server laufen fehlerfrei.
- Code ist modular und wartbar.
- Plan und Umsetzung sind dokumentiert.
