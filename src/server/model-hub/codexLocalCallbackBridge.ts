import http from 'node:http';
import { normalizeBrowserOrigin } from './urlOrigin';

const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = '/auth/callback';

interface BridgeState {
  server: http.Server;
  appOrigin: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __codexLocalCallbackBridge: BridgeState | undefined;
}

function htmlResponse(message: string): string {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Codex OAuth</title></head>
  <body><p>${message}</p></body>
</html>`;
}

function buildForwardUrl(appOrigin: string, incomingUrl: URL): string {
  const forward = new URL('/api/model-hub/oauth/callback', appOrigin);
  const keys = ['code', 'state', 'error', 'error_description'];
  for (const key of keys) {
    const value = incomingUrl.searchParams.get(key);
    if (value) {
      forward.searchParams.set(key, value);
    }
  }
  return forward.toString();
}

export async function ensureCodexLocalCallbackBridge(appOrigin: string): Promise<void> {
  const normalizedOrigin = normalizeBrowserOrigin(appOrigin);
  if (globalThis.__codexLocalCallbackBridge) {
    globalThis.__codexLocalCallbackBridge.appOrigin = normalizedOrigin;
    return;
  }

  await new Promise<void>((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };

    const server = http.createServer((req, res) => {
      try {
        const reqUrl = new URL(req.url || '/', `http://${CALLBACK_HOST}:${CALLBACK_PORT}`);
        if (reqUrl.pathname !== CALLBACK_PATH) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(htmlResponse('Not found.'));
          return;
        }

        const activeOrigin = globalThis.__codexLocalCallbackBridge?.appOrigin || normalizedOrigin;
        const forwardUrl = buildForwardUrl(activeOrigin, reqUrl);
        res.statusCode = 302;
        res.setHeader('Location', forwardUrl);
        res.end();
      } catch {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(htmlResponse('OAuth callback bridge failed.'));
      }
    });

    server.on('error', (error: NodeJS.ErrnoException) => {
      // If the port is already in use we keep going.
      // This mirrors CLI behavior where another local listener may already exist.
      if (error.code === 'EADDRINUSE') {
        finish();
        return;
      }
      finish();
    });

    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
      server.unref();
      globalThis.__codexLocalCallbackBridge = {
        server,
        appOrigin: normalizedOrigin,
      };
      finish();
    });
  });
}
