import type { ManagedServer } from './managedServer';

/**
 * Creates a persona through the gateway and returns its generated id. The Rust gateway
 * binds a chat only to a persona that exists for the user, so the chat tests create the
 * persona they bind instead of naming an id.
 */
export async function createPersona(server: ManagedServer, name: string): Promise<string> {
  const response = await fetch(server.httpUrl('/api/personas'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, vibe: 'E2E fixture' }),
  });
  const body = (await response.json().catch(() => null)) as {
    persona?: { id?: unknown };
  } | null;
  const id = body?.persona?.id;
  if (!response.ok || typeof id !== 'string' || id.length === 0) {
    throw new Error(
      `Persona fixture ${name} failed: HTTP ${response.status} ${JSON.stringify(body)}`,
    );
  }
  return id;
}
