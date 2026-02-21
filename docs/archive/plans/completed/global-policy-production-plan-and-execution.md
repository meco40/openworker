# Global Policy Production Plan and Execution

## Goal

Make tool and security policy globally enforced as a single source of truth, while personas only influence behavior/skills/workspace start.

## Scope

- Keep OpenAI-based architecture.
- Remove persona-level tool enforcement from runtime paths.
- Enforce global tool/security policy in legacy worker execution.
- Remove channel inconsistency where sidecar tools were Web-only.
- Remove active persona-permission gating in Rooms tool execution.

## Production Plan

1. Baseline audit
   - Identify all runtime gates that can allow/deny tool calls.
   - Identify persona-level and room-level overrides.

2. Policy model hardening
   - Define global policy as runtime authority.
   - Treat persona TOOLS.md as guidance, not permissions.

3. Runtime convergence
   - Legacy worker uses global policy to build effective tool list.
   - Shell approval mode derives from global security policy.
   - Chat sidecar dispatch not restricted to Web only.

4. Rooms convergence
   - Remove persona permission gate from room tool execution path.
   - Remove persona permissions API endpoint.

5. Validation
   - Run targeted tests for touched runtime paths.
   - Run targeted lint checks for changed files.

6. Production-readiness review
   - Verify hard-gate behavior, explainability, fallback behavior.
   - Identify residual risks and remaining hardening tasks.

## Best-Case Review (Target Behavior)

Best-case means:

- A tool is allowed or denied by one global authority.
- Persona text cannot silently block or grant tools.
- WebUI and Telegram share the same sidecar tool path behavior.
- Rooms do not apply hidden per-persona permission gates.
- Shell approval behavior follows global security mode.

## Execution Status

All scoped steps above have been executed in code.

### Implemented changes

1. Persona tool restrictions removed from worker execution path.
   - `src/server/worker/personaIntegration.ts`
   - `src/server/worker/workerExecutor.ts`

2. Legacy worker now derives effective tools from global config.
   - Added global policy resolver and tool filtering in:
   - `src/server/worker/workerExecutor.ts`

3. Legacy shell approval now respects global security mode (`deny|ask_approve|approve_always`).
   - `src/server/worker/workerExecutor.ts`

4. Sidecar dispatch no longer Web-only.
   - `src/server/channels/messages/service.ts`

5. Rooms tool execution no longer applies persona permission deny gate.
   - `src/server/rooms/toolExecutor.ts`
   - `src/server/rooms/orchestrator.ts`

6. Legacy persona-permissions surface removed.
   - Deleted `app/api/personas/[id]/permissions/route.ts`
   - Deleted `src/server/rooms/repositories/permissionRepository.ts`
   - Removed repository/interface/migration hooks for `persona_permissions`

7. Effective policy explainability endpoint added.
   - `src/server/security/policyExplain.ts`
   - `app/api/security/policy-explain/route.ts`

## Verification Results

1. Targeted tests passed:
   - `tests/unit/security/policy-explain.test.ts`
   - `tests/unit/worker/persona-integration.test.ts`
   - `tests/unit/rooms/room-repository.test.ts`
   - `tests/integration/rooms/rooms-runtime.test.ts`
   - `tests/integration/rooms/orchestrator-clawhub-prompt.test.ts`

2. Targeted eslint passed for changed files.

3. Full repo typecheck currently fails due pre-existing unrelated errors in other modules/scripts.
   - Not introduced by this change set.

## Production-Readiness Assessment

Status: Ready for controlled rollout.

Why:

- Central runtime behavior now aligns with global tool/security authority.
- Persona-level hidden tool denies removed from active execution paths.
- Cross-channel sidecar behavior is now consistent by design.

## Residual Risks and Follow-ups

1. Global policy mapping for legacy worker tools is explicit but minimal.
   - Current mapping: `shell/files/browser` to legacy tool names.
   - If new legacy tools are added, mapping must be updated.

2. Explain endpoint currently reports global/effective tool-security state, not per-request channel/user exceptions.
   - Extend if per-user/channel policy layers are introduced.

## Suggested Next Hardening (short list)

1. Add audit events tied to policy decisions (`allowed/denied + reason`).
2. Add integration tests for Telegram sidecar tool execution path.
3. Add e2e tests for global shell approval modes (`deny`, `ask_approve`, `approve_always`).
