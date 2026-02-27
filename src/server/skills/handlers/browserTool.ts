import { browserSnapshotHandler } from '@/server/skills/handlers/browserSnapshot';

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function browserToolHandler(args: Record<string, unknown>) {
  const action = (readString(args.action) || 'status').toLowerCase();

  if (action === 'status') {
    return {
      running: false,
      mode: 'stateless',
      supportedActions: ['status', 'snapshot', 'open', 'start', 'stop', 'tabs', 'profiles'],
      note: 'This compatibility browser tool is stateless. Use browser_snapshot/playwright_cli for active automation.',
    };
  }

  if (action === 'snapshot' || action === 'open') {
    const url = readString(args.url) || readString(args.targetUrl);
    if (!url) {
      throw new Error(`browser action=${action} requires url or targetUrl.`);
    }
    const snapshot = await browserSnapshotHandler({ url });
    return {
      running: false,
      action,
      snapshot,
    };
  }

  if (action === 'start' || action === 'stop') {
    return {
      ok: true,
      running: false,
      action,
      note: 'No persistent browser runtime is managed in compatibility mode.',
    };
  }

  if (action === 'tabs') {
    return {
      running: false,
      tabs: [],
    };
  }

  if (action === 'profiles') {
    return {
      profiles: ['stateless'],
    };
  }

  throw new Error(`Unsupported browser action: ${action}`);
}
