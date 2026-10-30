/**
 * `/api/personas` parity (S2): list, create, update, delete and the template
 * list.
 *
 * The TypeScript side drives the same `PersonaRepository` the routes delegate
 * to, in-process against a temporary database, and reproduces the response
 * mapping of `app/api/personas/route.ts` and `app/api/personas/[id]/route.ts`.
 * The Rust side goes over HTTP. Volatile fields (ids, timestamps) are
 * normalised; everything else must match.
 *
 * `preferredModelId` is not exercised here because it needs a populated
 * model-hub pipeline `p1` on both sides; that is the model-hub slice.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, rustRequest, bestEffortRemoveDir } from '../harness.mjs';

export const name = 'personas';

const FILE_NAMES = ['SOUL.md', 'IDENTITY.md', 'AGENTS.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md'];
const MEMORY_TYPES = ['general', 'roleplay', 'builder', 'assistant'];
const MODEL_HUB_PROFILE_ERROR =
  'modelHubProfileId must be a non-empty string (letters, numbers, ".", "_" or "-").';
const MEMORY_TYPE_ERROR = `Invalid memoryPersonaType. Allowed: ${MEMORY_TYPES.join(', ')}`;

function normSummary(persona) {
  return {
    name: persona.name,
    slug: persona.slug,
    emoji: persona.emoji,
    vibe: persona.vibe,
    systemPersonaKey: persona.systemPersonaKey ?? null,
    preferredModelId: persona.preferredModelId ?? null,
    modelHubProfileId: persona.modelHubProfileId ?? null,
    memoryPersonaType: persona.memoryPersonaType,
    isAutonomous: persona.isAutonomous,
    maxToolCalls: persona.maxToolCalls,
    allowedToolFunctionNames: persona.allowedToolFunctionNames ?? [],
    hasId: typeof persona.id === 'string' && persona.id.length > 0,
    hasUpdatedAt: typeof persona.updatedAt === 'string',
  };
}

function normProfile(persona) {
  return {
    ...normSummary(persona),
    // The identity itself is not compared: the Rust fallback principal
    // (`local-user`) and the TypeScript one (`legacy-local-user`) still differ,
    // which is a known auth drift outside this route family.
    hasUserId: typeof persona.userId === 'string' && persona.userId.length > 0,
    hasTimestampFields:
      typeof persona.createdAt === 'string' && typeof persona.updatedAt === 'string',
  };
}

function normFiles(files) {
  const out = {};
  for (const filename of FILE_NAMES) {
    out[filename] = typeof files?.[filename] === 'string' ? files[filename] : null;
  }
  return out;
}

/** The response mapping of the TypeScript routes around a successful call. */
async function typescriptSide() {
  const dir = mkdtempSync(join(tmpdir(), 'betaclaw-parity-personas-'));
  process.env.PERSONAS_DB_PATH = join(dir, 'personas.db');
  process.env.PERSONAS_ROOT_PATH = join(dir, 'personas');
  const { PersonaRepository } =
    await import('../../../../src/server/personas/personaRepository.ts');
  const { getPrincipalUserId } = await import('../../../../src/server/auth/principal.ts');

  const userId = getPrincipalUserId();
  const repo = new PersonaRepository(process.env.PERSONAS_DB_PATH);

  const created = repo.createPersona({
    userId,
    name: 'Parity Persona',
    emoji: '🐙',
    vibe: 'curious',
    files: { 'SOUL.md': 'hello' },
  });
  const createdFull = repo.getPersonaWithFiles(created.id);
  const listed = repo.listPersonas(userId).find((persona) => persona.name === 'Parity Persona');

  repo.updatePersona(created.id, {
    name: 'Parity Renamed',
    maxToolCalls: 42,
    isAutonomous: true,
  });
  const updated = true;
  const afterUpdate = repo.getPersonaWithFiles(created.id);

  let duplicateNameStatus = null;
  let duplicateNameError = null;
  try {
    repo.createPersona({ userId, name: 'Parity Renamed', emoji: '🤖', vibe: '' });
  } catch (error) {
    duplicateNameStatus = /slug already exists/i.test(String(error?.message)) ? 409 : 500;
    duplicateNameError = error instanceof Error ? error.message : String(error);
  }

  const deleted = repo.deletePersona(created.id);
  const afterDelete = repo.getPersonaWithFiles(created.id);

  const { PERSONA_TEMPLATES } = await import('../../../../src/lib/persona-templates.ts');
  const templates = PERSONA_TEMPLATES.map((template) => ({
    id: template.id,
    name: template.name,
    emoji: template.emoji,
    vibe: template.vibe,
  }));

  const result = {
    createdStatus: 201,
    created: normProfile(createdFull),
    createdFiles: normFiles(createdFull.files),
    listed: listed ? normSummary(listed) : null,
    updated: updated === true,
    afterUpdate: normProfile(afterUpdate),
    duplicateNameStatus,
    duplicateNameError,
    deleted,
    afterDelete: afterDelete === null ? 404 : normProfile(afterDelete),
    templates,
    // Validation replies of the route handlers; the bodies are literals in
    // `app/api/personas/route.ts:57-102`.
    missingName: { status: 400, error: 'name is required' },
    badProfile: { status: 400, error: MODEL_HUB_PROFILE_ERROR },
    badMemoryType: { status: 400, error: MEMORY_TYPE_ERROR },
  };
  repo.close();
  bestEffortRemoveDir(dir);
  return result;
}

/** Reads the same observations from the running Rust gateway. */
async function rustCollect() {
  const created = await rustRequest('POST', '/api/personas', {
    body: {
      name: 'Parity Persona',
      emoji: '🐙',
      vibe: 'curious',
      files: { 'SOUL.md': 'hello' },
    },
  });
  const persona = created.json?.persona ?? {};
  const id = persona.id;

  const listedResponse = await rustRequest('GET', '/api/personas');
  const listed = (listedResponse.json?.personas ?? []).find(
    (entry) => entry.name === 'Parity Persona' || entry.name === 'Parity Renamed',
  );

  const afterUpdate = await rustRequest('PUT', `/api/personas/${id}`, {
    body: { name: 'Parity Renamed', maxToolCalls: 42, isAutonomous: true },
  });

  const duplicate = await rustRequest('POST', '/api/personas', {
    body: { name: 'Parity Renamed' },
  });

  const deleted = await rustRequest('DELETE', `/api/personas/${id}`);
  const afterDelete = await rustRequest('GET', `/api/personas/${id}`);

  const missingName = await rustRequest('POST', '/api/personas', { body: {} });
  const badProfile = await rustRequest('POST', '/api/personas', {
    body: { name: 'X', modelHubProfileId: 'bad id' },
  });
  const badMemoryType = await rustRequest('POST', '/api/personas', {
    body: { name: 'X', memoryPersonaType: 'wizard' },
  });

  const templates = await rustRequest('GET', '/api/personas/templates');

  return {
    createdStatus: created.status,
    created: normProfile(persona),
    createdFiles: normFiles(persona.files),
    listed: listed ? normSummary(listed) : null,
    updated: afterUpdate.status === 200,
    afterUpdate: normProfile(afterUpdate.json?.persona ?? {}),
    duplicateNameStatus: duplicate.status,
    duplicateNameError: duplicate.json?.error,
    deleted: deleted.status === 200 && deleted.json?.ok === true,
    afterDelete: afterDelete.status === 404 ? 404 : normProfile(afterDelete.json?.persona ?? {}),
    templates: templates.json?.templates ?? [],
    missingName: { status: missingName.status, error: missingName.json?.error },
    badProfile: { status: badProfile.status, error: badProfile.json?.error },
    badMemoryType: { status: badMemoryType.status, error: badMemoryType.json?.error },
  };
}

export async function run() {
  const ts = await typescriptSide();
  const rust = await rustCollect();

  console.log('--- Templates ---');
  check('templates', rust.templates, ts.templates);

  console.log('\n--- POST ---');
  check('POST status', rust.createdStatus, ts.createdStatus);
  check('POST persona', rust.created, ts.created);
  check('POST files', rust.createdFiles, ts.createdFiles);

  console.log('\n--- GET Liste ---');
  check('Listeneintrag', rust.listed, ts.listed);

  console.log('\n--- PUT ---');
  check('PUT angewandt', rust.updated, ts.updated);
  check('PUT persona', rust.afterUpdate, ts.afterUpdate);

  console.log('\n--- POST Konflikt ---');
  check('Slug-Konflikt status', rust.duplicateNameStatus, ts.duplicateNameStatus);
  check(
    'Slug-Konflikt Fehler',
    String(rust.duplicateNameError).replace(/\\?"/g, "'"),
    String(ts.duplicateNameError).replace(/\\?"/g, "'"),
  );

  console.log('\n--- DELETE ---');
  check('DELETE ok', rust.deleted, ts.deleted);
  check('GET nach DELETE', rust.afterDelete, ts.afterDelete);

  console.log('\n--- Validierung ---');
  check('POST ohne Name', rust.missingName, ts.missingName);
  check('POST falscher Profil-Id', rust.badProfile, ts.badProfile);
  check('POST falscher Memory-Typ', rust.badMemoryType, ts.badMemoryType);
}
