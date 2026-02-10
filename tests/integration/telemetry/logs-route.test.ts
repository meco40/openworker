import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LogRepository } from '../../../src/server/telemetry/logRepository';

// Mock SSE manager so logService doesn't try to broadcast
vi.mock('../../../src/server/channels/sse/manager', () => ({
  getSSEManager: () => ({
    broadcast: vi.fn(),
    addClient: vi.fn(),
    removeClient: vi.fn(),
  }),
}));

describe('GET /api/logs', () => {
  let repo: LogRepository;

  beforeEach(() => {
    repo = new LogRepository(':memory:');
    // Seed some logs
    repo.insertLog('info', 'SYS', 'Gateway started');
    repo.insertLog('warn', 'BRIDGE', 'Latency spike');
    repo.insertLog('error', 'AUTH', 'Token expired');

    // Replace singleton for tests
    globalThis.__logRepository = repo;
  });

  afterEach(() => {
    repo.close();
    globalThis.__logRepository = undefined;
  });

  it('returns logs from the repository', async () => {
    const { GET } = await import('../../../app/api/logs/route');
    const request = new Request('http://localhost/api/logs');
    const response = await GET(request);
    const data = await response.json();

    expect(data.ok).toBe(true);
    expect(data.logs).toHaveLength(3);
    expect(data.total).toBe(3);
    // Should be in chronological order (oldest first)
    expect(data.logs[0].message).toBe('Gateway started');
    expect(data.logs[2].message).toBe('Token expired');
  });

  it('filters by level', async () => {
    const { GET } = await import('../../../app/api/logs/route');
    const request = new Request('http://localhost/api/logs?level=error');
    const response = await GET(request);
    const data = await response.json();

    expect(data.ok).toBe(true);
    expect(data.logs).toHaveLength(1);
    expect(data.logs[0].level).toBe('error');
  });

  it('filters by source', async () => {
    const { GET } = await import('../../../app/api/logs/route');
    const request = new Request('http://localhost/api/logs?source=SYS');
    const response = await GET(request);
    const data = await response.json();

    expect(data.ok).toBe(true);
    expect(data.logs).toHaveLength(1);
    expect(data.logs[0].source).toBe('SYS');
  });

  it('supports search', async () => {
    const { GET } = await import('../../../app/api/logs/route');
    const request = new Request('http://localhost/api/logs?search=spike');
    const response = await GET(request);
    const data = await response.json();

    expect(data.ok).toBe(true);
    expect(data.logs).toHaveLength(1);
    expect(data.logs[0].source).toBe('BRIDGE');
  });

  it('returns sources list', async () => {
    const { GET } = await import('../../../app/api/logs/route');
    const request = new Request('http://localhost/api/logs?sources=1');
    const response = await GET(request);
    const data = await response.json();

    expect(data.ok).toBe(true);
    expect(data.sources).toEqual(['AUTH', 'BRIDGE', 'SYS']);
  });
});

describe('DELETE /api/logs', () => {
  let repo: LogRepository;

  beforeEach(() => {
    repo = new LogRepository(':memory:');
    repo.insertLog('info', 'SYS', 'Test entry');
    globalThis.__logRepository = repo;
  });

  afterEach(() => {
    repo.close();
    globalThis.__logRepository = undefined;
  });

  it('clears all logs', async () => {
    const { DELETE } = await import('../../../app/api/logs/route');
    const response = await DELETE();
    const data = await response.json();

    expect(data.ok).toBe(true);
    expect(data.deleted).toBe(1);
    expect(repo.listLogs()).toHaveLength(0);
  });
});
