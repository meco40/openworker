# Single-User Security-First v3 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Konsolidiere die App auf ein Single-Principal-Modell mit unveraendert starken `user_id`-Sicherheitsgrenzen.

**Architecture:** Wir reduzieren Team-/Legacy-Komplexitaet, ohne Auth- oder Ownership-Schutz zu lockern. `user_id` bleibt in allen Repositories und Guards bestehen. Login-Haertung ist vorbereitet, aber **nicht** Teil dieser Umsetzung.

**Tech Stack:** Next.js App Router, TypeScript, Vitest, SQLite-Repositories, NextAuth, Gateway/WebSocket.

---

## Mandatory Constraints

- `user_id` bleibt in DB-Schema, Queries, Repositories und Domain-Checks.
- `resolveRequestUserContext()` behaelt `REQUIRE_AUTH=true` -> `null`/401-Verhalten.
- Kein Ausbau zu Multi-User/Team-Architektur.
- Kein Aktivieren/Erzwingen von Login in dieser Umsetzungsrunde.
- `ChannelType.TEAMS` bleibt unveraendert (separater Messenger-Adapter, kein Team-Collaboration-Feature).

---

## Scope Split

### Now (v3 execution scope)
- Security-Contract-Hardening fuer Single-Principal.
- Entkopplung fachfremder Flag-Abhaengigkeiten.
- Konsistente Identity-Pfade in Channels/Automation/WS.
- Terminologie-Cleanup.

### Later (explicitly deferred)
- Login verpflichtend aktivieren.
- Principal-Only Login Enforcement.
- Datenmigration von `legacy-local-user` auf finale Principal-ID.

---

### Task 1: Security Contract Freeze (Auth + user_id)

**Files:**
- Modify: `tests/unit/auth/user-context.test.ts`
- Modify: `tests/integration/channels/state-route.test.ts`
- Modify: `tests/integration/channels/inbox-route.test.ts`
- Modify: `tests/integration/automation/automations-routes.test.ts`
- Modify: `tests/integration/worker/orchestra-user-scope.test.ts`

**Step 1: Write the failing test**

```ts
it('returns 401 when REQUIRE_AUTH is true and no session exists', async () => {
  process.env.REQUIRE_AUTH = 'true';
  const res = await GET(new Request('http://localhost/api/channels/state'));
  expect(res.status).toBe(401);
});
```

```ts
it('keeps user scope isolation in orchestra routes', async () => {
  // user-a can access only user-a flow/task artifacts
  // user-b must not access user-a artifacts
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/integration/channels/state-route.test.ts -t "returns 401 when REQUIRE_AUTH is true and no session exists"`
Expected: FAIL if guard is missing in affected path.

**Step 3: Write minimal implementation**

```ts
// Prefer test hardening first; production changes only where gaps are found.
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/auth/user-context.test.ts tests/integration/channels/state-route.test.ts tests/integration/channels/inbox-route.test.ts tests/integration/automation/automations-routes.test.ts tests/integration/worker/orchestra-user-scope.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add tests/unit/auth/user-context.test.ts tests/integration/channels/state-route.test.ts tests/integration/channels/inbox-route.test.ts tests/integration/automation/automations-routes.test.ts tests/integration/worker/orchestra-user-scope.test.ts
git commit -m "test: freeze single-principal auth and user_id security contracts"
```

---

### Task 2: Principal Fallback Helper (no login activation)

**Files:**
- Create: `src/server/auth/principal.ts`
- Modify: `src/server/auth/userContext.ts`
- Modify: `src/server/automation/httpAuth.ts`
- Modify: `src/server/auth/constants.ts` (optional cleanup/re-export only)
- Test: `tests/unit/auth/user-context.test.ts`

**Step 1: Write the failing test**

```ts
it('uses principal fallback id only when auth is optional and session is missing', async () => {
  process.env.REQUIRE_AUTH = 'false';
  process.env.PRINCIPAL_USER_ID = 'single-principal';
  const ctx = await resolveRequestUserContext();
  expect(ctx?.userId).toBe('single-principal');
});
```

```ts
it('still returns null when REQUIRE_AUTH is true and session is missing', async () => {
  process.env.REQUIRE_AUTH = 'true';
  const ctx = await resolveRequestUserContext();
  expect(ctx).toBeNull();
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/auth/user-context.test.ts -t "principal fallback id"`
Expected: FAIL.

**Step 3: Write minimal implementation**

```ts
// src/server/auth/principal.ts
export function getPrincipalUserId(): string {
  const value = String(process.env.PRINCIPAL_USER_ID || 'legacy-local-user').trim();
  return value || 'legacy-local-user';
}
```

```ts
// src/server/auth/userContext.ts
// Keep REQUIRE_AUTH logic exactly as-is.
// Replace only non-auth fallback source with getPrincipalUserId().
```

```ts
// src/server/automation/httpAuth.ts
// Keep 401-capable behavior path via resolveRequestUserContext().
// Use getPrincipalUserId() only for optional-auth fallback mode.
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/auth/user-context.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/server/auth/principal.ts src/server/auth/userContext.ts src/server/automation/httpAuth.ts src/server/auth/constants.ts tests/unit/auth/user-context.test.ts
git commit -m "refactor: introduce principal fallback helper without changing auth enforcement"
```

---

### Task 3: Decouple Automation Identity from Chat Session Flag

**Files:**
- Modify: `src/server/automation/httpAuth.ts`
- Modify: `app/api/automations/route.ts`
- Modify: `app/api/automations/[id]/route.ts`
- Modify: `app/api/automations/[id]/run/route.ts`
- Modify: `app/api/automations/[id]/runs/route.ts`
- Test: `tests/integration/automation/automations-routes.test.ts`
- Test: `tests/integration/automation/scheduler-runtime.test.ts`

**Step 1: Write the failing test**

```ts
it('automation auth behavior is independent from CHAT_PERSISTENT_SESSION_V2', async () => {
  process.env.REQUIRE_AUTH = 'false';
  process.env.CHAT_PERSISTENT_SESSION_V2 = 'false';
  const a = await GET(new Request('http://localhost/api/automations'));
  process.env.CHAT_PERSISTENT_SESSION_V2 = 'true';
  const b = await GET(new Request('http://localhost/api/automations'));
  expect(a.status).toBe(200);
  expect(b.status).toBe(200);
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/integration/automation/automations-routes.test.ts -t "independent from CHAT_PERSISTENT_SESSION_V2"`
Expected: FAIL.

**Step 3: Write minimal implementation**

```ts
// remove isPersistentSessionV2Enabled() dependency from automation identity resolution
// use resolveRequestUserContext() + principal fallback semantics only
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/integration/automation/automations-routes.test.ts tests/integration/automation/scheduler-runtime.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/server/automation/httpAuth.ts app/api/automations/route.ts app/api/automations/[id]/route.ts app/api/automations/[id]/run/route.ts app/api/automations/[id]/runs/route.ts tests/integration/automation/automations-routes.test.ts tests/integration/automation/scheduler-runtime.test.ts
git commit -m "refactor: decouple automation auth path from chat session feature flag"
```

---

### Task 4: Channels + Gateway Identity Consistency (REST and WS)

**Files:**
- Modify: `app/api/channels/state/route.ts`
- Modify: `app/api/channels/messages/route.ts`
- Modify: `app/api/channels/conversations/route.ts`
- Modify: `app/api/channels/inbox/route.ts`
- Modify: `server.ts`
- Modify: `tests/integration/channels/state-route.test.ts`
- Modify: `tests/integration/channels/inbox-route.test.ts`
- Modify: `tests/integration/channels/stream-route.contract.test.ts`
- Modify: `tests/unit/gateway/gateway-contract.test.ts`

**Step 1: Write the failing test**

```ts
it('ws and rest both reject unauthenticated access when REQUIRE_AUTH=true', async () => {
  // assert REST 401
  // assert WS upgrade rejection/no registration
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/integration/channels/state-route.test.ts tests/integration/channels/stream-route.contract.test.ts`
Expected: FAIL in at least one path before alignment.

**Step 3: Write minimal implementation**

```ts
// unify identity source across REST/WS:
// - keep REQUIRE_AUTH semantics
// - use principal fallback only when auth optional
// - no anonymous branch when REQUIRE_AUTH=true
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/integration/channels/state-route.test.ts tests/integration/channels/inbox-route.test.ts tests/integration/channels/stream-route.contract.test.ts tests/unit/gateway/gateway-contract.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add app/api/channels/state/route.ts app/api/channels/messages/route.ts app/api/channels/conversations/route.ts app/api/channels/inbox/route.ts server.ts tests/integration/channels/state-route.test.ts tests/integration/channels/inbox-route.test.ts tests/integration/channels/stream-route.contract.test.ts tests/unit/gateway/gateway-contract.test.ts
git commit -m "refactor: align channels and ws identity handling under single-principal security rules"
```

---

### Task 5: Low-Risk Team Terminology Cleanup

**Files:**
- Modify: `components/ProfileView.tsx`
- Create: `tests/unit/components/profile-view-copy.test.tsx`
- Modify: `docs/plans/2026-02-15-organizations-team-collaboration-removal-implementation-plan.md`
- Modify: `docs/archive/legacy-core/USER_MANUAL.md`
- Modify: `docs/archive/reviews/SYSTEM_REVIEW.md`

**Step 1: Write the failing test**

```tsx
it('does not mention multi-tenant organization wording in profile view', () => {
  const html = renderToString(<ProfileView />);
  expect(html).not.toContain('multi-tenant organization');
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/components/profile-view-copy.test.tsx`
Expected: FAIL.

**Step 3: Write minimal implementation**

```tsx
<p>Manage your operator profile, subscription plan, and runtime settings.</p>
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/components/profile-view-copy.test.tsx tests/unit/components/sidebar-memory-item.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add components/ProfileView.tsx tests/unit/components/profile-view-copy.test.tsx docs/plans/2026-02-15-organizations-team-collaboration-removal-implementation-plan.md docs/archive/legacy-core/USER_MANUAL.md docs/archive/reviews/SYSTEM_REVIEW.md
git commit -m "docs: remove remaining team terminology from active and reference docs"
```

---

### Task 6: Deferred Pack (document only, do not implement now)

**Files:**
- Create: `docs/plans/2026-02-15-single-principal-login-activation-deferred.md`
- Modify: `docs/SECURITY_SYSTEM.md`
- Modify: `docs/SESSION_MANAGEMENT_IMPLEMENTATION.md`

**Step 1: Write deferred spec content**

Include:

- Future login activation checklist.
- Single-principal enforcement rule for authenticated sessions.
- Data migration plan from `legacy-local-user` to final principal ID.
- Rollback plan.

**Step 2: Do not change runtime behavior now**

Run: `rg -n "NEXTAUTH|REQUIRE_AUTH|getToken|resolveRequestUserContext" src/server app/api server.ts`
Expected: No login activation changes outside explicitly planned tasks.

**Step 3: Commit**

```bash
git add docs/plans/2026-02-15-single-principal-login-activation-deferred.md docs/SECURITY_SYSTEM.md docs/SESSION_MANAGEMENT_IMPLEMENTATION.md
git commit -m "docs: define deferred login activation and principal data migration plan"
```

---

## Non-Goals (v3)

- Kein Entfernen von `user_id` aus Tabellen/Queries.
- Keine Runtime-Aktivierung von verpflichtendem Login.
- Kein Umbau auf Multi-User/Team-Model.
- Kein Entfernen von Ownership-Checks (`assertRoomOwner`, user-scoped repository methods).

---

## Verification Checklist (required before completion)

Run in this order:

1. `npm test -- tests/unit/auth/user-context.test.ts`
2. `npm test -- tests/integration/automation/automations-routes.test.ts tests/integration/automation/scheduler-runtime.test.ts`
3. `npm test -- tests/integration/channels/state-route.test.ts tests/integration/channels/inbox-route.test.ts tests/integration/channels/stream-route.contract.test.ts`
4. `npm test -- tests/unit/gateway/gateway-contract.test.ts`
5. `npm test -- tests/integration/worker/orchestra-user-scope.test.ts tests/integration/rooms/rooms-routes.test.ts tests/integration/rooms/rooms-runtime.test.ts`
6. `npm test -- tests/unit/components/profile-view-copy.test.tsx tests/unit/components/sidebar-memory-item.test.ts`
7. `npm run typecheck`

Expected:

- `user_id`-Scope bleibt durchgaengig erhalten.
- `REQUIRE_AUTH=true` liefert weiterhin 401 ohne Session.
- `REQUIRE_AUTH=false` nutzt konsistent den Single-Principal-Fallback.
- Automation-Auth ist von Chat-Session-Feature-Flag entkoppelt.
- WS- und REST-Identitaetsregeln sind konsistent.

---

## Rollout Controls

- Kleine PRs: genau 1 Task pro PR.
- Nach jedem Task Guard-Tests + Typecheck ausfuehren.
- Login-Aktivierung bleibt explizit auf den Deferred-Plan begrenzt.

