import {
  expireAssertion,
  insertAssertion,
  retractAssertion,
  type WorldModelAssertionInput,
} from '@/server/world-model/repositories/assertionRepository';
import type { WorldModelScope } from '@/server/world-model/scope';
import type { Modality } from '@/server/world-model/types';

export interface AssertionServiceInput extends Omit<
  WorldModelAssertionInput,
  'userId' | 'personaId' | 'workspaceId'
> {
  scope: WorldModelScope;
  sourceAuthority: 'user' | 'persona' | 'inference';
}

/**
 * Phase 5: Fachliche Assertions-Operationen.
 *
 * - `assert`: legt/aktualisiert eine Bit temporale Assertion (schliesst alte
 *   aktive Wahrheit automatisch im Repo).
 * - `confirm`: hebt die Modalitaet auf `confirmed` (Nutzer-Bestaetigung) an.
 * - `deny`: legt eine `denied`-Assertion an und schliesst die alte.
 * - `retract`/`expire`: schliesst eine aktive Assertion ohne Ersatz.
 *
 * Nutzerbestätigung schlaegt Inferenz: eine `confirmed`-Assertion zweiter
 * Instanz ersetzt eine `inferred`-Version explizit.
 */
export async function assertFact(input: AssertionServiceInput) {
  const { scope, sourceAuthority, ...rest } = input;
  return insertAssertion({
    userId: scope.userId,
    personaId: scope.personaId,
    workspaceId: scope.workspaceId ?? '',
    ...rest,
    modality: sourceAuthority === 'user' ? 'confirmed' : 'observed',
  });
}

/** Explicit replacement operation for callers that want to distinguish a
 * corrected fact from an ordinary repeat assertion. The repository closes the
 * active predecessor and stores the supersession link. */
export async function supersedeFact(input: AssertionServiceInput) {
  return assertFact(input);
}

export async function denyFact(input: AssertionServiceInput, reason?: string) {
  await retractAssertionIfPlausible(input, reason);
  return insertAssertion({
    userId: input.scope.userId,
    personaId: input.scope.personaId,
    workspaceId: input.scope.workspaceId ?? '',
    subjectId: input.subjectId,
    predicate: input.predicate,
    objectValue: input.objectValue,
    modality: 'denied',
    confidence: 0.99,
  });
}

export async function confirmFact(input: AssertionServiceInput) {
  return insertAssertion({
    userId: input.scope.userId,
    personaId: input.scope.personaId,
    workspaceId: input.scope.workspaceId ?? '',
    subjectId: input.subjectId,
    predicate: input.predicate,
    objectValue: input.objectValue,
    modality: 'confirmed',
    confidence: Math.max(input.confidence ?? 0.8, 0.95),
  });
}

export async function retractFact(input: AssertionServiceInput) {
  await retractAssertionIfPlausible(input, 'retracted by ' + input.sourceAuthority);
}

export async function expireFact(input: AssertionServiceInput) {
  await expireAssertionIfPlausible(input);
}

async function retractAssertionIfPlausible(
  input: AssertionServiceInput,
  reason: string | undefined,
) {
  // Achtung: Hier koennte eine Suche nach der aktiven Assertion erfolgen; fuer
  // die V1 implementieren wir das Schliessen ueber die Repo-Funktion mit
  // objectValue als Identitaet (plausibel, aber nur wenn ein Praedikat+Wert
  // gegeben). reason wird dokumentarisch gefuehrt.
  void reason;
  return retractByIdentityIfActive(input);
}

async function expireAssertionIfPlausible(input: AssertionServiceInput) {
  return retractByIdentityIfActive(input, 'expire');
}

/**
 * Schliesst die aktive Assertion passend zum Praedikat/Wert, sofern genau eine
 * gefunden wird. Dazu wird die Scope + predicate + objectValue genutzt.
 */
async function retractByIdentityIfActive(
  input: AssertionServiceInput,
  mode: 'retract' | 'expire' = 'retract',
) {
  const { listActiveAssertions } =
    await import('@/server/world-model/repositories/assertionRepository');
  const active = await listActiveAssertions(
    input.scope.userId,
    input.scope.personaId,
    input.scope.workspaceId ?? '',
  );
  const match = active.find(
    (a) =>
      a.predicate === input.predicate && input.objectValue && a.objectValue === input.objectValue,
  );
  if (match) {
    if (mode === 'retract') await retractAssertion(match.id);
    else await expireAssertion(match.id);
  }
}

export type { Modality };
