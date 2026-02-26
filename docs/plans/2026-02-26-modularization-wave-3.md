# Large File Modularization Wave 3 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Modularize six remaining oversized files by extracting implementations into dedicated module paths while preserving backward-compatible import surfaces.

**Architecture:** Keep public entrypoints stable at current file paths. Move logic into feature folders (`planning`, `stats`, `messenger/channel-pairing`, `gateway/methods/agent-v2`, `knowledge/ingestion`, `config/gateway`) and leave thin wrappers/re-exports in the original files.

**Tech Stack:** TypeScript, React, Node server modules, existing project test/build scripts.

---

### Task 1: Snapshot backups before edits

**Files:**
- Create: `backups/modularization-wave3-<timestamp>/...` (6 mirrored files)

1. Copy each target file into backup folder with original relative path.
2. Verify backup files exist.

### Task 2: Extract server modules

**Files:**
- Create: `src/server/knowledge/ingestion/service.ts`
- Modify: `src/server/knowledge/ingestionService.ts`
- Create: `src/server/gateway/methods/agent-v2/registerMethods.ts`
- Modify: `src/server/gateway/methods/agent-v2.ts`
- Create: `src/server/config/gateway/gatewayConfig.ts`
- Modify: `src/server/config/gatewayConfig.ts`

1. Move existing implementations into new files.
2. Keep old file paths as wrappers (`export *` / side-effect import).
3. Ensure compile-time exports remain intact.

### Task 3: Extract frontend modules

**Files:**
- Create: `src/components/planning/PlanningTab.tsx`
- Modify: `src/components/PlanningTab.tsx`
- Create: `src/components/stats/StatsView.tsx`
- Modify: `src/components/StatsView.tsx`
- Create: `src/messenger/channel-pairing/ChannelPairing.tsx`
- Modify: `src/messenger/ChannelPairing.tsx`

1. Move full component implementations to new module paths.
2. Keep old paths as wrappers/re-exports.
3. Keep named/default exports identical.

### Task 4: Verification

**Files:**
- Update if needed: `.agent/CONTINUITY.md`

1. Run `npm run typecheck`.
2. Run `npm run lint`.
3. Run focused tests for impacted areas.
4. Run `npm run build`.
5. Record outcomes and unresolved gaps.
