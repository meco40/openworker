import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockUserContext = { userId: string; authenticated: boolean } | null;

function mockUserContext(context: MockUserContext): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));

  // Mock persona repository so persona ownership checks pass in tests.
  // Every persona lookup returns a persona owned by the mocked user.
  vi.doMock('../../../src/server/personas/personaRepository', () => ({
    getPersonaRepository: () => ({
      getPersona: (id: string) => ({
        id,
        userId: context?.userId ?? 'legacy-local-user',
        name: `Test Persona ${id}`,
        emoji: '🤖',
      }),
      getPersonaSystemInstruction: () => null,
    }),
  }));
}

describe('rooms routes', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.ROOMS_DB_PATH;
  });

  it('returns 401 for unauthenticated requests', async () => {
    mockUserContext(null);
    const { GET } = await import('../../../app/api/rooms/route');
    const response = await GET();
    const data = (await response.json()) as { ok: boolean; error: string };

    expect(response.status).toBe(401);
    expect(data.ok).toBe(false);
    expect(data.error).toContain('Unauthorized');
  });

  it('creates and lists rooms for current user', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });

    const roomsRoute = await import('../../../app/api/rooms/route');
    const createRes = await roomsRoute.POST(
      new Request('http://localhost/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Office',
          goalMode: 'planning',
          routingProfileId: 'p1',
        }),
      }),
    );

    expect(createRes.status).toBe(201);

    const listRes = await roomsRoute.GET();
    const listData = (await listRes.json()) as {
      ok: boolean;
      rooms: Array<{ id: string; name: string; goalMode: string }>;
    };
    expect(listData.ok).toBe(true);
    expect(listData.rooms).toHaveLength(1);
    expect(listData.rooms[0]?.name).toBe('Office');
  });

  it('adds members and transitions run state via start/stop routes', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });

    const roomsRoute = await import('../../../app/api/rooms/route');
    const createRes = await roomsRoute.POST(
      new Request('http://localhost/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Home',
          goalMode: 'simulation',
          routingProfileId: 'p1',
        }),
      }),
    );
    const created = (await createRes.json()) as { ok: boolean; room: { id: string } };

    const roomId = created.room.id;

    const membersRoute = await import('../../../app/api/rooms/[id]/members/route');
    const addMemberRes = await membersRoute.POST(
      new Request(`http://localhost/api/rooms/${roomId}/members`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          personaId: 'persona-1',
          roleLabel: 'Mutter',
          modelOverride: 'grok-4',
        }),
      }),
      { params: Promise.resolve({ id: roomId }) },
    );
    expect(addMemberRes.status).toBe(201);

    const startRoute = await import('../../../app/api/rooms/[id]/start/route');
    const stopRoute = await import('../../../app/api/rooms/[id]/stop/route');
    const stateRoute = await import('../../../app/api/rooms/[id]/state/route');

    const startRes = await startRoute.POST(
      new Request(`http://localhost/api/rooms/${roomId}/start`, { method: 'POST' }),
      { params: Promise.resolve({ id: roomId }) },
    );
    expect(startRes.status).toBe(200);

    const stateAfterStart = await stateRoute.GET(
      new Request(`http://localhost/api/rooms/${roomId}/state`),
      { params: Promise.resolve({ id: roomId }) },
    );
    const started = (await stateAfterStart.json()) as { ok: boolean; state: { runState: string } };
    expect(started.ok).toBe(true);
    expect(started.state.runState).toBe('running');

    const stopRes = await stopRoute.POST(
      new Request(`http://localhost/api/rooms/${roomId}/stop`, { method: 'POST' }),
      { params: Promise.resolve({ id: roomId }) },
    );
    expect(stopRes.status).toBe(200);
  });

  it('stores interventions and supports room message pagination', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });

    const roomsRoute = await import('../../../app/api/rooms/route');
    const createRes = await roomsRoute.POST(
      new Request('http://localhost/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Home',
          goalMode: 'simulation',
          routingProfileId: 'p1',
        }),
      }),
    );
    const created = (await createRes.json()) as { room: { id: string } };
    const roomId = created.room.id;

    const interventionsRoute = await import('../../../app/api/rooms/[id]/interventions/route');
    const interventionRes = await interventionsRoute.POST(
      new Request(`http://localhost/api/rooms/${roomId}/interventions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: 'Bitte fokussiert auf Solar-Recherche.' }),
      }),
      { params: Promise.resolve({ id: roomId }) },
    );
    expect(interventionRes.status).toBe(201);

    const interventionListRes = await interventionsRoute.GET(
      new Request(`http://localhost/api/rooms/${roomId}/interventions?limit=10`),
      { params: Promise.resolve({ id: roomId }) },
    );
    const interventionList = (await interventionListRes.json()) as {
      interventions: Array<{ note: string }>;
    };
    expect(interventionList.interventions[0]?.note).toContain('Solar');

    const { getRoomRepository } = await import('../../../src/server/rooms/runtime');
    const repo = getRoomRepository();
    repo.appendMessage({
      roomId,
      speakerType: 'persona',
      speakerPersonaId: 'persona-1',
      content: 'm1',
      metadata: {},
    });
    repo.appendMessage({
      roomId,
      speakerType: 'persona',
      speakerPersonaId: 'persona-2',
      content: 'm2',
      metadata: {},
    });
    repo.appendMessage({
      roomId,
      speakerType: 'persona',
      speakerPersonaId: 'persona-3',
      content: 'm3',
      metadata: {},
    });

    const messagesRoute = await import('../../../app/api/rooms/[id]/messages/route');
    const pageRes = await messagesRoute.GET(
      new Request(`http://localhost/api/rooms/${roomId}/messages?limit=2&beforeSeq=3`),
      { params: Promise.resolve({ id: roomId }) },
    );
    const page = (await pageRes.json()) as { messages: Array<{ content: string }> };
    expect(page.messages.map((item) => item.content)).toEqual(['m1', 'm2']);
  });

  it('rejects invalid beforeSeq values', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });

    const roomsRoute = await import('../../../app/api/rooms/route');
    const createRes = await roomsRoute.POST(
      new Request('http://localhost/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Invalid beforeSeq',
          goalMode: 'simulation',
          routingProfileId: 'p1',
        }),
      }),
    );
    const created = (await createRes.json()) as { room: { id: string } };
    const roomId = created.room.id;

    const messagesRoute = await import('../../../app/api/rooms/[id]/messages/route');
    const invalidRes = await messagesRoute.GET(
      new Request(`http://localhost/api/rooms/${roomId}/messages?limit=2&beforeSeq=NaN`),
      { params: Promise.resolve({ id: roomId }) },
    );

    expect(invalidRes.status).toBe(400);
    const invalidPayload = (await invalidRes.json()) as { ok: boolean; error: string };
    expect(invalidPayload.ok).toBe(false);
    expect(invalidPayload.error).toContain('beforeSeq');
  });

  it('returns active room counts per persona for global busy indicators', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });

    const roomsRoute = await import('../../../app/api/rooms/route');
    const r1 = await roomsRoute.POST(
      new Request('http://localhost/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Office', goalMode: 'planning', routingProfileId: 'p1' }),
      }),
    );
    const r2 = await roomsRoute.POST(
      new Request('http://localhost/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Home', goalMode: 'simulation', routingProfileId: 'p1' }),
      }),
    );
    const room1 = (await r1.json()) as { room: { id: string } };
    const room2 = (await r2.json()) as { room: { id: string } };

    const membersRoute = await import('../../../app/api/rooms/[id]/members/route');
    await membersRoute.POST(
      new Request('http://localhost/api/rooms/x/members', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ personaId: 'persona-1', roleLabel: 'Analyst' }),
      }),
      { params: Promise.resolve({ id: room1.room.id }) },
    );
    await membersRoute.POST(
      new Request('http://localhost/api/rooms/x/members', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ personaId: 'persona-1', roleLabel: 'Vater' }),
      }),
      { params: Promise.resolve({ id: room2.room.id }) },
    );

    const startRoute = await import('../../../app/api/rooms/[id]/start/route');
    await startRoute.POST(new Request('http://localhost/api/rooms/x/start', { method: 'POST' }), {
      params: Promise.resolve({ id: room1.room.id }),
    });
    await startRoute.POST(new Request('http://localhost/api/rooms/x/start', { method: 'POST' }), {
      params: Promise.resolve({ id: room2.room.id }),
    });

    const countsRoute = await import('../../../app/api/rooms/membership-counts/route');
    const countsRes = await countsRoute.GET();
    const counts = (await countsRes.json()) as { ok: boolean; counts: Record<string, number> };

    expect(countsRes.status).toBe(200);
    expect(counts.ok).toBe(true);
    expect(counts.counts['persona-1']).toBe(2);
  });

  it('removes room member and deletes room', async () => {
    mockUserContext({ userId: 'legacy-local-user', authenticated: false });
    const roomsRoute = await import('../../../app/api/rooms/route');
    const createdRes = await roomsRoute.POST(
      new Request('http://localhost/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Cleanup', goalMode: 'planning', routingProfileId: 'p1' }),
      }),
    );
    const created = (await createdRes.json()) as { room: { id: string } };
    const roomId = created.room.id;

    const membersRoute = await import('../../../app/api/rooms/[id]/members/route');
    await membersRoute.POST(
      new Request('http://localhost/api/rooms/x/members', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ personaId: 'persona-1', roleLabel: 'Analyst' }),
      }),
      { params: Promise.resolve({ id: roomId }) },
    );

    const memberDeleteRoute = await import('../../../app/api/rooms/[id]/members/[personaId]/route');
    const memberDeleteRes = await memberDeleteRoute.DELETE(
      new Request('http://localhost/api/rooms/x/members/persona-1', { method: 'DELETE' }),
      { params: Promise.resolve({ id: roomId, personaId: 'persona-1' }) },
    );
    expect(memberDeleteRes.status).toBe(200);

    const roomDeleteRoute = await import('../../../app/api/rooms/[id]/route');
    const roomDeleteRes = await roomDeleteRoute.DELETE(
      new Request('http://localhost/api/rooms/x', { method: 'DELETE' }),
      { params: Promise.resolve({ id: roomId }) },
    );
    expect(roomDeleteRes.status).toBe(200);
  });
});
