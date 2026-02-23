import http, { type IncomingMessage, type ServerResponse } from 'node:http';

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

async function readBody(req: IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function startMem0Mock(port: number): http.Server {
  const server = http.createServer(async (req, res) => {
    const method = req.method || 'GET';
    const url = req.url || '/';

    if (url.startsWith('/v2/memories/search') && method === 'POST') {
      sendJson(res, 200, { memories: [] });
      return;
    }

    if (url.startsWith('/v2/memories') && method === 'POST') {
      sendJson(res, 200, { memories: [], total: 0, page: 1, page_size: 1 });
      return;
    }

    if (url.startsWith('/v1/search') && method === 'POST') {
      sendJson(res, 200, { memories: [] });
      return;
    }

    if (url.startsWith('/v1/memories') && method === 'GET') {
      sendJson(res, 200, { memories: [] });
      return;
    }

    if (url === '/v1/memories' && method === 'POST') {
      await readBody(req).catch(() => '');
      sendJson(res, 200, [{ id: `mem-${Date.now()}` }]);
      return;
    }

    if (url.startsWith('/v1/memories/') && method === 'GET' && url.endsWith('/history')) {
      sendJson(res, 200, { history: [] });
      return;
    }

    if (url.startsWith('/v1/memories/') && method === 'GET') {
      sendJson(res, 200, { id: 'mem-any', memory: 'fixture memory', metadata: {} });
      return;
    }

    if (url.startsWith('/v1/memories/') && (method === 'PUT' || method === 'DELETE')) {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url === '/v1/memories' && method === 'DELETE') {
      sendJson(res, 200, { deleted: 0 });
      return;
    }

    sendJson(res, 200, { ok: true });
  });

  server.listen(port, '127.0.0.1');
  return server;
}

async function main(): Promise<void> {
  const appPort = Number(process.env.PORT || 3000);
  const mem0Port = Number(process.env.MEM0_MOCK_PORT || 18010);
  const env = process.env as Record<string, string | undefined>;

  env.NODE_ENV = env.NODE_ENV || 'production';
  // Docker injects HOSTNAME with a container id; force loopback for Playwright health checks.
  env.HOSTNAME = '127.0.0.1';
  env.PORT = String(appPort);
  env.REQUIRE_AUTH = 'false';
  env.MODEL_HUB_TEST_MODE = '1';
  env.OPENCLAW_EXEC_APPROVALS_REQUIRED = 'false';
  env.MEMORY_PROVIDER = 'mem0';
  env.MEM0_BASE_URL = `http://127.0.0.1:${mem0Port}`;
  env.MEM0_API_KEY = env.MEM0_API_KEY || 'test-mem0-key';
  env.MEM0_API_PATH = '/v1';

  const mem0Server = startMem0Mock(mem0Port);

  const shutdown = () => {
    mem0Server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await import('../../server.ts');
}

void main();
