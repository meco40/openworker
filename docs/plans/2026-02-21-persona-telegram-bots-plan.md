# Implementierungsplan: Persona-gebundene Telegram Bots

**Datum:** 2026-02-21  
**Design:** [2026-02-21-persona-telegram-bots-design.md](./2026-02-21-persona-telegram-bots-design.md)  
**Methode:** TDD, inkrementelle Batches

---

## Task 1: PersonaTelegramBotRegistry

**Dateien:**

- Erstellen: `src/server/telegram/personaTelegramBotRegistry.ts`
- Test: `tests/unit/telegram/persona-telegram-bot-registry.test.ts`

### Schritt 1: Test schreiben

```typescript
// tests/unit/telegram/persona-telegram-bot-registry.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { PersonaTelegramBotRegistry } from '@/server/telegram/personaTelegramBotRegistry';

describe('PersonaTelegramBotRegistry', () => {
  let registry: PersonaTelegramBotRegistry;

  beforeEach(() => {
    registry = new PersonaTelegramBotRegistry(':memory:');
  });

  it('returns null for unknown botId', () => {
    expect(registry.getBot('unknown')).toBeNull();
  });

  it('returns null for unknown personaId', () => {
    expect(registry.getBotByPersonaId('persona-x')).toBeNull();
  });

  it('upserts and retrieves a bot', () => {
    registry.upsertBot({
      botId: 'girl',
      personaId: 'persona-1',
      token: 'tok-abc',
      webhookSecret: 'sec-abc',
      peerName: 'girl_bot',
      transport: 'polling',
    });
    const bot = registry.getBot('girl');
    expect(bot?.personaId).toBe('persona-1');
    expect(bot?.token).toBe('tok-abc');
    expect(bot?.peerName).toBe('girl_bot');
    expect(bot?.active).toBe(true);
  });

  it('getBotByPersonaId works after upsert', () => {
    registry.upsertBot({
      botId: 'nexus',
      personaId: 'persona-2',
      token: 'tok-nexus',
      webhookSecret: 'sec-nexus',
      transport: 'webhook',
    });
    const bot = registry.getBotByPersonaId('persona-2');
    expect(bot?.botId).toBe('nexus');
  });

  it('removes a bot', () => {
    registry.upsertBot({
      botId: 'temp',
      personaId: 'persona-3',
      token: 'tok',
      webhookSecret: 'sec',
      transport: 'polling',
    });
    registry.removeBot('temp');
    expect(registry.getBot('temp')).toBeNull();
  });

  it('lists only active bots', () => {
    registry.upsertBot({
      botId: 'a',
      personaId: 'p1',
      token: 't',
      webhookSecret: 's',
      transport: 'polling',
    });
    registry.upsertBot({
      botId: 'b',
      personaId: 'p2',
      token: 't',
      webhookSecret: 's',
      transport: 'webhook',
    });
    registry.setActive('b', false);
    const active = registry.listActiveBots();
    expect(active).toHaveLength(1);
    expect(active[0].botId).toBe('a');
  });

  it('updates polling offset', () => {
    registry.upsertBot({
      botId: 'x',
      personaId: 'px',
      token: 't',
      webhookSecret: 's',
      transport: 'polling',
    });
    registry.setPollingOffset('x', 42);
    expect(registry.getBot('x')?.pollingOffset).toBe(42);
  });
});
```

### Schritt 2: Test fehlschlagen lassen

```
npm test -- tests/unit/telegram/persona-telegram-bot-registry.test.ts
```

Erwartet: FAIL (Modul existiert nicht)

### Schritt 3: Implementierung

```typescript
// src/server/telegram/personaTelegramBotRegistry.ts
import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';

export interface PersonaTelegramBot {
  botId: string;
  personaId: string;
  token: string;
  webhookSecret: string;
  peerName: string | null;
  transport: 'webhook' | 'polling';
  pollingOffset: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertPersonaTelegramBotInput {
  botId: string;
  personaId: string;
  token: string;
  webhookSecret: string;
  peerName?: string;
  transport: 'webhook' | 'polling';
}

function toBot(row: Record<string, unknown>): PersonaTelegramBot {
  return {
    botId: row.bot_id as string,
    personaId: row.persona_id as string,
    token: row.token as string,
    webhookSecret: row.webhook_secret as string,
    peerName: (row.peer_name as string) || null,
    transport: (row.transport as 'webhook' | 'polling') || 'polling',
    pollingOffset: (row.polling_offset as number) || 0,
    active: (row.active as number) === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export class PersonaTelegramBotRegistry {
  private readonly db: ReturnType<typeof BetterSqlite3>;

  constructor(dbPath = process.env.PERSONAS_DB_PATH || '.local/personas.db') {
    if (dbPath === ':memory:') {
      this.db = new BetterSqlite3(':memory:');
    } else {
      const fullPath = path.resolve(dbPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      this.db = new BetterSqlite3(fullPath);
    }
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS persona_telegram_bots (
        bot_id         TEXT PRIMARY KEY,
        persona_id     TEXT NOT NULL UNIQUE,
        token          TEXT NOT NULL,
        webhook_secret TEXT NOT NULL,
        peer_name      TEXT,
        transport      TEXT NOT NULL DEFAULT 'polling',
        polling_offset INTEGER NOT NULL DEFAULT 0,
        active         INTEGER NOT NULL DEFAULT 1,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
    `);
  }

  getBot(botId: string): PersonaTelegramBot | null {
    const row = this.db
      .prepare('SELECT * FROM persona_telegram_bots WHERE bot_id = ?')
      .get(botId) as Record<string, unknown> | undefined;
    return row ? toBot(row) : null;
  }

  getBotByPersonaId(personaId: string): PersonaTelegramBot | null {
    const row = this.db
      .prepare('SELECT * FROM persona_telegram_bots WHERE persona_id = ?')
      .get(personaId) as Record<string, unknown> | undefined;
    return row ? toBot(row) : null;
  }

  listActiveBots(): PersonaTelegramBot[] {
    const rows = this.db
      .prepare('SELECT * FROM persona_telegram_bots WHERE active = 1 ORDER BY created_at')
      .all() as Array<Record<string, unknown>>;
    return rows.map(toBot);
  }

  listAllBots(): PersonaTelegramBot[] {
    const rows = this.db
      .prepare('SELECT * FROM persona_telegram_bots ORDER BY created_at')
      .all() as Array<Record<string, unknown>>;
    return rows.map(toBot);
  }

  upsertBot(input: UpsertPersonaTelegramBotInput): PersonaTelegramBot {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO persona_telegram_bots
           (bot_id, persona_id, token, webhook_secret, peer_name, transport, polling_offset, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
         ON CONFLICT(bot_id) DO UPDATE SET
           persona_id     = excluded.persona_id,
           token          = excluded.token,
           webhook_secret = excluded.webhook_secret,
           peer_name      = excluded.peer_name,
           transport      = excluded.transport,
           active         = 1,
           updated_at     = excluded.updated_at`,
      )
      .run(
        input.botId,
        input.personaId,
        input.token,
        input.webhookSecret,
        input.peerName ?? null,
        input.transport,
        now,
        now,
      );
    return this.getBot(input.botId)!;
  }

  setPollingOffset(botId: string, offset: number): void {
    this.db
      .prepare('UPDATE persona_telegram_bots SET polling_offset = ? WHERE bot_id = ?')
      .run(offset, botId);
  }

  setActive(botId: string, active: boolean): void {
    this.db
      .prepare('UPDATE persona_telegram_bots SET active = ?, updated_at = ? WHERE bot_id = ?')
      .run(active ? 1 : 0, new Date().toISOString(), botId);
  }

  removeBot(botId: string): void {
    this.db.prepare('DELETE FROM persona_telegram_bots WHERE bot_id = ?').run(botId);
  }

  removeByPersonaId(personaId: string): void {
    this.db.prepare('DELETE FROM persona_telegram_bots WHERE persona_id = ?').run(personaId);
  }
}

// ─── Singleton ───────────────────────────────────────────────

declare global {
  var __personaTelegramBotRegistry: PersonaTelegramBotRegistry | undefined;
}

export function getPersonaTelegramBotRegistry(): PersonaTelegramBotRegistry {
  if (!globalThis.__personaTelegramBotRegistry) {
    globalThis.__personaTelegramBotRegistry = new PersonaTelegramBotRegistry();
  }
  return globalThis.__personaTelegramBotRegistry;
}
```

### Schritt 4: Tests laufen lassen

```
npm test -- tests/unit/telegram/persona-telegram-bot-registry.test.ts
```

Erwartet: PASS

### Schritt 5: Commit

```
git add src/server/telegram/personaTelegramBotRegistry.ts tests/unit/telegram/persona-telegram-bot-registry.test.ts
git commit -m "feat(telegram): persona telegram bot registry"
```

---

## Task 2: Persona Telegram Pairing Service

**Dateien:**

- Erstellen: `src/server/telegram/personaTelegramPairing.ts`
- Test: `tests/unit/telegram/persona-telegram-pairing.test.ts`

### Schritt 1: Test schreiben

```typescript
// tests/unit/telegram/persona-telegram-pairing.test.ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PersonaTelegramBotRegistry } from '@/server/telegram/personaTelegramBotRegistry';

vi.mock('@/server/telegram/personaTelegramBotRegistry', () => {
  const registry = {
    upsertBot: vi
      .fn()
      .mockReturnValue({
        botId: 'girl',
        personaId: 'p1',
        transport: 'polling',
        peerName: 'girl_bot',
      }),
    removeByPersonaId: vi.fn(),
    getBotByPersonaId: vi.fn(),
  };
  return {
    getPersonaTelegramBotRegistry: () => registry,
    PersonaTelegramBotRegistry: vi.fn(),
  };
});

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

describe('pairPersonaTelegram', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('throws on invalid token', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ ok: false, description: 'Unauthorized' }),
    });
    const { pairPersonaTelegram } = await import('@/server/telegram/personaTelegramPairing');
    await expect(pairPersonaTelegram('p1', 'bad-token')).rejects.toThrow('Telegram auth failed');
  });

  it('returns peerName on success (polling mode)', async () => {
    // getMe succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, result: { username: 'girl_bot', id: 99 } }),
    });
    // deleteWebhook succeeds (polling mode, no APP_URL)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
    });

    delete process.env.APP_URL;
    const { pairPersonaTelegram } = await import('@/server/telegram/personaTelegramPairing');
    const result = await pairPersonaTelegram('p1', 'valid-token');
    expect(result.peerName).toBe('girl_bot');
    expect(result.transport).toBe('polling');
  });
});

describe('unpairPersonaTelegram', () => {
  it('removes bot from registry', async () => {
    const { unpairPersonaTelegram } = await import('@/server/telegram/personaTelegramPairing');
    const registry = (
      await import('@/server/telegram/personaTelegramBotRegistry')
    ).getPersonaTelegramBotRegistry();
    await unpairPersonaTelegram('p1');
    expect(registry.removeByPersonaId).toHaveBeenCalledWith('p1');
  });
});
```

### Schritt 2: Test fehlschlagen lassen

```
npm test -- tests/unit/telegram/persona-telegram-pairing.test.ts
```

### Schritt 3: Implementierung

```typescript
// src/server/telegram/personaTelegramPairing.ts
import crypto from 'node:crypto';
import { createId } from '@/shared/lib/createId';
import { getPersonaTelegramBotRegistry } from '@/server/telegram/personaTelegramBotRegistry';
import {
  startPersonaBotPolling,
  stopPersonaBotPolling,
} from '@/server/telegram/personaTelegramPoller';
import { serializeTelegramAllowedUpdates } from '@/server/channels/telegram/allowedUpdates';

export interface PairPersonaTelegramResult {
  botId: string;
  peerName: string;
  transport: 'webhook' | 'polling';
}

export async function pairPersonaTelegram(
  personaId: string,
  token: string,
): Promise<PairPersonaTelegramResult> {
  if (!token) throw new Error('Token is required.');

  // 1. Validate token
  const meResponse = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const meData = (await meResponse.json()) as {
    ok?: boolean;
    result?: { username?: string; id?: number };
  };
  if (!meResponse.ok || !meData.ok) {
    throw new Error(`Telegram auth failed: ${JSON.stringify(meData)}`);
  }

  const peerName = meData.result?.username ?? `bot-${meData.result?.id ?? 'unknown'}`;
  const botId = createId('tgbot');
  const webhookSecret = crypto.randomBytes(32).toString('hex');

  let transport: 'webhook' | 'polling' = 'polling';

  const appUrl = process.env.APP_URL || process.env.NEXTAUTH_URL || process.env.VERCEL_URL;
  if (appUrl) {
    const webhookUrl = `${appUrl.replace(/\/$/, '')}/api/channels/telegram/bots/${botId}/webhook`;
    const whResponse = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: webhookSecret,
        allowed_updates: JSON.parse(serializeTelegramAllowedUpdates()),
      }),
    });
    const whData = (await whResponse.json()) as { ok?: boolean };
    if (whData.ok) {
      transport = 'webhook';
    }
  }

  if (transport === 'polling') {
    try {
      await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drop_pending_updates: true }),
      });
    } catch {
      // ignore
    }
  }

  // 2. Stop any existing bot for this persona
  const registry = getPersonaTelegramBotRegistry();
  const existing = registry.getBotByPersonaId(personaId);
  if (existing) {
    stopPersonaBotPolling(existing.botId);
  }

  // 3. Save to registry
  registry.upsertBot({
    botId,
    personaId,
    token,
    webhookSecret,
    peerName,
    transport,
  });

  // 4. Start polling if needed
  if (transport === 'polling') {
    await startPersonaBotPolling(botId);
  }

  return { botId, peerName, transport };
}

export async function unpairPersonaTelegram(personaId: string): Promise<void> {
  const registry = getPersonaTelegramBotRegistry();
  const bot = registry.getBotByPersonaId(personaId);
  if (!bot) return;

  stopPersonaBotPolling(bot.botId);

  // Delete webhook
  try {
    await fetch(`https://api.telegram.org/bot${bot.token}/deleteWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ drop_pending_updates: false }),
    });
  } catch {
    // ignore
  }

  registry.removeByPersonaId(personaId);
}
```

### Schritt 4: Test laufen lassen

```
npm test -- tests/unit/telegram/persona-telegram-pairing.test.ts
```

### Schritt 5: Commit

```
git commit -m "feat(telegram): persona telegram pairing service"
```

---

## Task 3: Persona Bot Poller (Multi-Poller)

**Dateien:**

- Erstellen: `src/server/telegram/personaTelegramPoller.ts`
- Test: `tests/unit/telegram/persona-telegram-poller.test.ts`

### Schritt 1: Test schreiben

```typescript
// tests/unit/telegram/persona-telegram-poller.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  startPersonaBotPolling,
  stopPersonaBotPolling,
  isPersonaBotPollingActive,
} from '@/server/telegram/personaTelegramPoller';
import { PersonaTelegramBotRegistry } from '@/server/telegram/personaTelegramBotRegistry';

vi.mock('@/server/telegram/personaTelegramBotRegistry', () => ({
  getPersonaTelegramBotRegistry: () => ({
    getBot: vi.fn().mockReturnValue({
      botId: 'test-bot',
      personaId: 'p1',
      token: 'tok',
      transport: 'polling',
      pollingOffset: 0,
      active: true,
    }),
    setPollingOffset: vi.fn(),
  }),
}));

vi.mock('@/server/channels/pairing/telegramInbound', () => ({
  processTelegramInboundUpdate: vi.fn().mockResolvedValue({ handled: true, codeIssued: false }),
}));

const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({ ok: true, result: [] }),
});
globalThis.fetch = mockFetch;

describe('PersonaBotPoller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stopPersonaBotPolling('test-bot');
  });

  it('starts and marks active', async () => {
    await startPersonaBotPolling('test-bot');
    expect(isPersonaBotPollingActive('test-bot')).toBe(true);
    stopPersonaBotPolling('test-bot');
  });

  it('stops and marks inactive', async () => {
    await startPersonaBotPolling('test-bot');
    stopPersonaBotPolling('test-bot');
    expect(isPersonaBotPollingActive('test-bot')).toBe(false);
  });
});
```

### Schritt 2: Test fehlschlagen lassen

```
npm test -- tests/unit/telegram/persona-telegram-poller.test.ts
```

### Schritt 3: Implementierung

```typescript
// src/server/telegram/personaTelegramPoller.ts
import { getPersonaTelegramBotRegistry } from '@/server/telegram/personaTelegramBotRegistry';
import { processTelegramInboundUpdate } from '@/server/channels/pairing/telegramInbound';
import { serializeTelegramAllowedUpdates } from '@/server/channels/telegram/allowedUpdates';

const POLL_INTERVAL_MS = 2_000;

interface PollerState {
  timer: ReturnType<typeof setTimeout> | null;
  active: boolean;
}

// Module-level map — keyed by botId
const pollers = new Map<string, PollerState>();

export async function startPersonaBotPolling(botId: string): Promise<void> {
  const existing = pollers.get(botId);
  if (existing?.active) return;

  pollers.set(botId, { timer: null, active: true });
  schedulePersonaBotPoll(botId);
}

export function stopPersonaBotPolling(botId: string): void {
  const state = pollers.get(botId);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  state.active = false;
  pollers.delete(botId);
}

export function isPersonaBotPollingActive(botId: string): boolean {
  return pollers.get(botId)?.active ?? false;
}

export function stopAllPersonaBotPolling(): void {
  for (const botId of pollers.keys()) {
    stopPersonaBotPolling(botId);
  }
}

function schedulePersonaBotPoll(botId: string): void {
  const state = pollers.get(botId);
  if (!state?.active) return;

  const timer = setTimeout(() => {
    void pollPersonaBotOnce(botId).then(() => {
      if (pollers.get(botId)?.active) {
        schedulePersonaBotPoll(botId);
      }
    });
  }, POLL_INTERVAL_MS);

  if (state) state.timer = timer;
}

async function pollPersonaBotOnce(botId: string): Promise<void> {
  const registry = getPersonaTelegramBotRegistry();
  const bot = registry.getBot(botId);
  if (!bot || !bot.active) {
    stopPersonaBotPolling(botId);
    return;
  }

  try {
    const allowedUpdates = JSON.parse(serializeTelegramAllowedUpdates()) as string[];
    const url = new URL(`https://api.telegram.org/bot${bot.token}/getUpdates`);
    url.searchParams.set('timeout', '1');
    url.searchParams.set('limit', '20');
    url.searchParams.set('allowed_updates', JSON.stringify(allowedUpdates));
    if (bot.pollingOffset > 0) {
      url.searchParams.set('offset', String(bot.pollingOffset));
    }

    const response = await fetch(url.toString());
    if (!response.ok) return;

    const data = (await response.json()) as { ok: boolean; result?: Array<{ update_id: number }> };
    if (!data.ok || !data.result || data.result.length === 0) return;

    let maxUpdateId = bot.pollingOffset;
    for (const update of data.result) {
      if (update.update_id > maxUpdateId) maxUpdateId = update.update_id;
      await processTelegramInboundUpdate(update, {
        botId,
        personaId: bot.personaId,
        token: bot.token,
      });
    }

    const newOffset = maxUpdateId + 1;
    if (newOffset > bot.pollingOffset) {
      registry.setPollingOffset(botId, newOffset);
    }
  } catch (err) {
    console.error(`[PersonaBotPoller:${botId}] Poll error:`, err);
  }
}
```

### Schritt 4: Test + Commit

```
npm test -- tests/unit/telegram/persona-telegram-poller.test.ts
git commit -m "feat(telegram): multi-poller for persona telegram bots"
```

---

## Task 4: TelegramInbound — BotContext Support

**Dateien:**

- Modifizieren: `src/server/channels/pairing/telegramInbound.ts`

### Schritt 1: `TelegramBotContext` Interface + optionaler Parameter

Füge zu `processTelegramInboundUpdate(update, botContext?)` hinzu:

```typescript
export interface TelegramBotContext {
  botId: string;
  personaId: string;
  token: string;
}
```

Wenn `botContext` gesetzt:

- Code-Pairing überspringen (alle Chats sind authorisiert)
- `personaId` aus `botContext` direkt verwenden
- Token für Delivery aus `botContext` nehmen

### Schritt 2: Test

```
npm test -- tests/unit/telegram/
npm test -- tests/unit/channels/telegram-webhook-pairing.test.ts
```

### Schritt 3: Commit

```
git commit -m "feat(telegram): bot context support for persona inbound"
```

---

## Task 5: Outbound — Token-Option

**Dateien:**

- Modifizieren: `src/server/channels/outbound/telegram.ts`
- Modifizieren: `src/server/channels/outbound/router.ts`
- Modifizieren: `src/server/channels/messages/service.ts`

### Änderung in `telegram.ts`

```typescript
export async function deliverTelegram(
  chatIdOrTarget: string,
  text: string,
  options?: TelegramTextOptions & { token?: string; personaId?: string },
): Promise<void>;
```

Token-Auflösung:

1. `options.token` direkt → verwenden
2. `options.personaId` → Registry lookup → token
3. Fallback: globaler CredentialStore

### Schritt: Commit

```
git commit -m "feat(telegram): persona token routing in outbound delivery"
```

---

## Task 6: API-Routes

**Dateien:**

- Erstellen: `app/api/personas/[personaId]/telegram/route.ts`
- Erstellen: `app/api/channels/telegram/bots/[botId]/webhook/route.ts`

### Route 1: Persona Telegram API

```typescript
// app/api/personas/[personaId]/telegram/route.ts
export const runtime = 'nodejs';

// GET — Bot-Status laden (kein Token im Response)
export async function GET(request: Request, { params }: { params: Promise<{ personaId: string }> }) { ... }

// POST — Bot pairen: body { token: string }
export async function POST(request: Request, { params }: { params: Promise<{ personaId: string }> }) { ... }

// DELETE — Bot entfernen
export async function DELETE(request: Request, { params }: { params: Promise<{ personaId: string }> }) { ... }
```

### Route 2: Per-Bot Webhook

```typescript
// app/api/channels/telegram/bots/[botId]/webhook/route.ts
export const runtime = 'nodejs';

export async function POST(request: Request, { params }: { params: Promise<{ botId: string }> }) {
  const { botId } = await params;
  // 1. Verify secret header X-Telegram-Bot-Api-Secret-Token
  // 2. Registry lookup for botId
  // 3. processTelegramInboundUpdate(update, { botId, personaId, token })
}
```

### Schritt: Commit

```
git commit -m "feat(telegram): persona bot api routes and per-bot webhook"
```

---

## Task 7: Server-Start — Persona Bots aktivieren

**Datei:** `server.ts`

### Schritt

Beim Server-Start nach DB-Init:

```typescript
// Persona Telegram Bots starten
const { getPersonaTelegramBotRegistry } =
  await import('@/server/telegram/personaTelegramBotRegistry');
const { startPersonaBotPolling } = await import('@/server/telegram/personaTelegramPoller');
const activeBots = getPersonaTelegramBotRegistry().listActiveBots();
for (const bot of activeBots) {
  if (bot.transport === 'polling') {
    void startPersonaBotPolling(bot.botId);
    console.log(
      `[Startup] Telegram persona bot polling started: ${bot.botId} (${bot.peerName ?? 'unnamed'})`,
    );
  }
}
```

### Schritt: Commit

```
git commit -m "feat(telegram): auto-start persona bot polling on server startup"
```

---

## Task 8: UI-Komponente

**Dateien:**

- Erstellen: `src/modules/personas/components/PersonaTelegramBotSection.tsx`
- Modifizieren: Persona-Details-Panel (PersonasView oder PersonaDetailsPanel)

### Komponente

```tsx
// src/modules/personas/components/PersonaTelegramBotSection.tsx
'use client';

interface Props {
  personaId: string;
}

export function PersonaTelegramBotSection({ personaId }: Props) {
  // States: bot info, token input, loading, error
  // API calls: GET/POST/DELETE /api/personas/[personaId]/telegram
  // UI:
  //   - Wenn kein Bot: Token-Input + "Verbinden"-Button
  //   - Wenn Bot aktiv: Status-Badge (@username, Webhook/Polling), "Trennen"-Button
}
```

### Integration

In `PersonasView.tsx` oder dem Detail-Panel die Komponente einbinden:

```tsx
{
  selectedId && <PersonaTelegramBotSection personaId={selectedId} />;
}
```

### Schritt: Commit

```
git commit -m "feat(telegram): persona telegram bot UI section"
```

---

## Task 9: Vollständiger Test-Lauf

```bash
npm run test
npm run typecheck
npm run check
```

Alle Tests grün, TypeScript sauber, Lint clean.

### Commit

```
git commit -m "feat(telegram): persona-bound telegram bots — complete implementation"
```

---

## Checkliste

- [ ] Task 1: Registry (Service + Tests)
- [ ] Task 2: Pairing Service (Logic + Tests)
- [ ] Task 3: Multi-Poller (State Machine + Tests)
- [ ] Task 4: Inbound BotContext
- [ ] Task 5: Outbound Token-Option
- [ ] Task 6: API-Routes
- [ ] Task 7: Server-Start
- [ ] Task 8: UI-Komponente
- [ ] Task 9: Vollständiger Lauf
