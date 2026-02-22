import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted() ensures mockService is initialized before vi.mock factories run
const mockService = vi.hoisted(() => ({
  getFlowGraph: vi.fn(),
  saveFlowGraph: vi.fn(),
}));

vi.mock('@/server/automation/runtime', () => ({
  getAutomationService: () => mockService,
}));

vi.mock('@/server/automation/httpAuth', () => ({
  resolveAutomationUserId: vi.fn(async () => 'user-1'),
}));

// Top-level await import runs after vi.mock hoisting
const { GET, PUT } = await import('../../app/api/automations/[id]/flow/route');

describe('GET /api/automations/[id]/flow', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns flowGraph for existing rule', async () => {
    const graph = { version: 1 as const, nodes: [], edges: [] };
    mockService.getFlowGraph.mockReturnValue(graph);
    const req = new Request('http://localhost/api/automations/rule-1/flow');
    const res = await GET(req, { params: Promise.resolve({ id: 'rule-1' }) });
    const body = (await res.json()) as { ok: boolean; flowGraph: unknown };
    expect(body.ok).toBe(true);
    expect(body.flowGraph).toEqual(graph);
  });

  it('returns null flowGraph when rule has no flow', async () => {
    mockService.getFlowGraph.mockReturnValue(null);
    const req = new Request('http://localhost/api/automations/rule-1/flow');
    const res = await GET(req, { params: Promise.resolve({ id: 'rule-1' }) });
    const body = (await res.json()) as { ok: boolean; flowGraph: unknown };
    expect(body.ok).toBe(true);
    expect(body.flowGraph).toBeNull();
  });
});

describe('PUT /api/automations/[id]/flow', () => {
  beforeEach(() => vi.clearAllMocks());

  it('validates and saves valid flow_graph', async () => {
    const graph = {
      version: 1 as const,
      nodes: [
        {
          id: 'n1',
          type: 'trigger.cron' as const,
          position: { x: 0, y: 0 },
          data: { label: 'T', config: { cronExpression: '0 * * * *', timezone: 'UTC' } },
        },
      ],
      edges: [],
    };
    mockService.saveFlowGraph.mockReturnValue({ id: 'rule-1', flowGraph: graph });
    const req = new Request('http://localhost/api/automations/rule-1/flow', {
      method: 'PUT',
      body: JSON.stringify({ flowGraph: graph }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await PUT(req, { params: Promise.resolve({ id: 'rule-1' }) });
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('returns 422 for invalid graph (no trigger)', async () => {
    const graph = { version: 1 as const, nodes: [], edges: [] };
    const req = new Request('http://localhost/api/automations/rule-1/flow', {
      method: 'PUT',
      body: JSON.stringify({ flowGraph: graph }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await PUT(req, { params: Promise.resolve({ id: 'rule-1' }) });
    expect(res.status).toBe(422);
  });

  it('returns 400 for malformed JSON', async () => {
    const req = new Request('http://localhost/api/automations/rule-1/flow', {
      method: 'PUT',
      body: 'not-json',
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await PUT(req, { params: Promise.resolve({ id: 'rule-1' }) });
    expect(res.status).toBe(400);
  });

  it('returns 413 when Content-Length exceeds 500 KB', async () => {
    const req = new Request('http://localhost/api/automations/rule-1/flow', {
      method: 'PUT',
      body: JSON.stringify({ flowGraph: { version: 1, nodes: [], edges: [] } }),
      headers: {
        'Content-Type': 'application/json',
        'content-length': String(600 * 1024), // oversized header
      },
    });
    const res = await PUT(req, { params: Promise.resolve({ id: 'rule-1' }) });
    expect(res.status).toBe(413);
  });
});
