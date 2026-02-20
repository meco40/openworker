2# Persona Policy and Runtime Plan

## Purpose
This file defines a concrete target architecture so personas can reliably use the agent from WebUI and Telegram with:

- global rights and global tools as one source of truth
- persona-specific skills
- persona-specific start workspace
- global full filesystem access (persona starts in own workspace, can work outside)
- clear separation between policy enforcement and persona behavior

## Current State
- Rights, tools, and persona behavior are partially coupled.
- Tool availability is not always derived from one central policy path.
- WebUI and Telegram can drift when runtime paths differ.

## Target State
1. Global rights and global tools are managed in one central policy (`global_policy`).
2. Persona files (`SOUL.md`, `AGENTS.md`, `TOOLS.md`) influence behavior only.
3. Skills are configured per persona (`persona_skill_profiles`).
4. WebUI and Telegram use the same policy and runtime decision path.
5. No persona can add or expand tool rights.
6. Each persona has its own default workspace path as starting `cwd`.
7. Global policy can run in full-access mode so personas can read/write outside their start workspace.

## Architecture Principles
1. One source of truth for rights and tools: global policy only.
2. `deny` always wins.
3. No implicit rights from free text.
4. Runtime gates are hard (policy), prompts are guidance.
5. Persona is a behavior and quality profile plus skill profile, not a rights container.
6. Workspace start location is persona-specific; filesystem rights are still global.

## Persona Model (Employee Concept)
Each persona represents an "employee" with:

- `role` (for example analyst, builder, support, researcher)
- `quality_profile` (for example speed, precision, autonomy)
- `skill_profile` (skills that this persona should use)

### Example Profiles
1. Analyst
   - Skills: research, reporting
2. Builder
   - Skills: codegen, refactor, test
3. Support
   - Skills: FAQ, ticket templates

## Workspace Model
- Every persona has a dedicated start workspace (its default `cwd`).
- Start workspace improves separation and organization of work context.
- In `full_access` mode, the agent may operate in other folders too (same behavior as Codex full access).
- Workspace choice is routing/context, not a permission boundary.

## Data Model (Target)
Note: names are suggestions and can be adapted to existing DB.

1. `global_policy`
   - `tools_allow` (string[])
   - `tools_deny` (string[])
   - `security` (json)
   - `filesystem_mode` (`sandbox` | `full_access`)
   - `cross_workspace_access` (bool)
   - `updated_at`

2. `global_skills_catalog`
   - `skill_id`
   - `name`
   - `enabled` (bool)
   - `updated_at`

3. `persona_skill_profiles`
   - `persona_id`
   - `skills_active` (string[])
   - `updated_at`

4. `persona_quality_profiles`
   - `persona_id`
   - `autonomy_level`
   - `reasoning_level`
   - `cost_tier`
   - `latency_tier`

5. `persona_workspaces`
   - `persona_id`
   - `workspace_root` (absolute path)
   - `start_cwd` (absolute path, default = `workspace_root`)
   - `updated_at`

## EffectivePolicy Resolution
Recommended order:

1. `global_policy` (hard tool/security rights)
2. `global_skills_catalog` (which skills exist and are enabled)
3. `persona_skill_profiles.skills_active` (subset of enabled global skills)
4. `persona_workspaces` (start location only)
5. optional session restrictions (only narrower, never broader)
6. hard runtime safety gates

Conflict rules:
- `deny` wins over `allow`.
- Persona cannot bypass global `deny`.
- Persona cannot grant new tools.
- Persona workspace does not limit access when `filesystem_mode=full_access`.

## Token and Context Strategy
1. Tools remain globally available according to global policy.
2. Skill context is reduced per persona:
   - discover/inject only persona active skills.
3. Keep policy text short in prompt:
   - enforcement stays outside prompt.
4. Measure:
   - prompt tokens, tool-call rate, success rate per persona.

## UI and Product Behavior
### Persona Editor
- Section "Skill profile": per-skill toggle (`active/inactive`) within enabled global skills.
- Section "Quality": speed vs precision vs autonomy.
- Section "Workspace": default workspace path / start `cwd` per persona.

### Tools Page
- Defines global tool rights (`allow/deny`) as single source of truth.
- No persona-specific tool rights.

### Security Page
- Defines global security rights as single source of truth.
- No persona-level rights escalation.
- Includes global filesystem mode (`sandbox` or `full_access`).

### Skills Page
- Manages global skill catalog (installed/enabled).
- Persona chooses active subset from globally enabled skills.

## Implementation Phases
1. Decoupling
   - stop using persona free text as hard tool allowlist.
2. Central policy
   - enforce `global_policy` as only rights source for tools and security.
3. Skill layering
   - add `global_skills_catalog` + `persona_skill_profiles` resolution.
4. Workspace routing
   - add `persona_workspaces` and start each run in persona-specific `cwd`.
5. Runtime gates
   - all tool dispatch checks use `EffectivePolicy` only.
6. Prompt build
   - inject persona active skills only.
7. UI integration
   - Tools/Security update global policy; Persona updates skills + quality + workspace.
8. Telemetry
   - track tokens and tool metrics per persona.

## Acceptance Criteria
1. Global rights/tools change in WebUI applies immediately for all personas.
2. WebUI and Telegram behave the same for same persona and global policy.
3. Persona-specific skills are applied consistently.
4. Blocked tools are rejected consistently with clear reason.
5. Token usage decreases measurably through persona-specific skill context.
6. Each persona starts in its own workspace path.
7. With `filesystem_mode=full_access`, persona can operate in other folders when requested.

## Tests (Minimum)
1. E2E WebUI:
   - "How many files are on my desktop?" uses tools only if globally allowed.
2. E2E WebUI:
   - "Create a web app" uses allowed tools and persona-specific skills.
3. E2E Telegram:
   - same requests, same decisions.
4. Policy unit tests:
   - resolution order + deny precedence + no escalation.
5. Prompt/skill unit tests:
   - only persona active skills are injected.
6. Workspace tests:
   - persona A and B start in different `cwd` values.
   - in `full_access`, agent can read/write outside start workspace.

## Risks
1. Partial migration: old and new policy logic in parallel causes inconsistent behavior.
2. UI writes partial skill profile while runtime expects complete profile.
3. Low visibility without policy explain endpoint.

## Recommended Guardrails
1. Explain endpoint:
   - output effective policy and effective skill set per session/persona.
2. Audit log:
   - why a tool was allowed/denied and which skill profile was loaded.
3. Safe defaults:
   - new persona starts with minimal skill set.

## Next Concrete Step
Create a technical delta spec:
- which existing files/functions are replaced or decoupled.
- which central policy function is introduced.
- which API fields WebUI/Telegram must send.
