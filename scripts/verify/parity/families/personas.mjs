/**
 * `/api/personas` parity (S2): list, create, update, delete and the template
 * list.
 *
 * The reference is `golden/personas.json`, recorded from the TypeScript routes before
 * their removal. The Rust side goes over HTTP. Volatile fields (ids, timestamps) are
 * normalised; everything else must match.
 *
 * `preferredModelId` is not exercised here because it needs a populated
 * model-hub pipeline `p1` on both sides; that is the model-hub slice.
 */
import { check, goldenReference, rustRequest } from '../harness.mjs';

export const name = 'personas';

const FILE_NAMES = ['SOUL.md', 'IDENTITY.md', 'AGENTS.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md'];

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

/** The response shape of the route. */
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
  const ts = await goldenReference(name, 'typescript');
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
