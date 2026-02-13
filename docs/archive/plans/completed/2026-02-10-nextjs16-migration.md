# Next.js 16 Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Die bestehende Vite-React-App auf Next.js 16.1.x (stable) migrieren und einen erfolgreichen `next build` sicherstellen.

**Architecture:** App Router wird als dünne Hülle eingeführt (`app/layout.tsx`, `app/page.tsx`), die bestehende Client-App (`App.tsx`) bleibt weitgehend unverändert. Tooling und Scripts werden auf Next umgestellt, Vite-spezifische Konfiguration wird entfernt.

**Tech Stack:** Next.js 16.1.6, React 19, TypeScript, ESLint (flat config), Vitest.

---

### Task 1: Runtime und Build-Tooling umstellen

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `next.config.ts`
- Create: `next-env.d.ts`
- Modify: `tsconfig.json`

1. `next@16.1.6` installieren und Vite entfernen.
2. Scripts auf `next dev/build/start` umstellen.
3. TypeScript für Next-App-Router ergänzen.

### Task 2: App Router Entry aufsetzen

**Files:**

- Create: `app/layout.tsx`
- Create: `app/page.tsx`
- Create/Modify: `app/globals.css`
- Modify: `App.tsx`

1. Globales HTML-Layout inkl. Tailwind-CDN/FONTS übernehmen.
2. Client-Boundary setzen und bestehende App in `app/page.tsx` rendern.
3. Fehlende/duplizierte Legacy-Entrypoints bereinigen.

### Task 3: Env-Handling für Next kompatibel machen

**Files:**

- Modify: `services/gemini.ts`
- Modify: `.env.local` (optional Dokumentation)

1. `GEMINI_API_KEY` serverseitig lesen.
2. Keine `NEXT_PUBLIC_*` Secrets für Gemini verwenden.

### Task 4: Verifikation

**Files:**

- Modify: `README.md`

1. `npm run lint`
2. `npm run test`
3. `npm run build`
4. Ergebnis berichten (inkl. möglicher Warnungen)
