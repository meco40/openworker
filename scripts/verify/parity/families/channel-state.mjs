/**
 * `/api/channels/state` parity (S3): every channel with its capability flags,
 * the caller's binding and the bridge accounts of `whatsapp`/`imessage`.
 *
 * The TypeScript side uses the same `CHANNEL_CAPABILITIES`, the same repository
 * bindings and `listBridgeAccounts` the route delegates to; the Rust side goes
 * over HTTP. A fresh database has no bindings, so every channel reports `idle`.
 * `generatedAt` is normalised to a presence flag.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, rustRequest, bestEffortRemoveDir } from '../harness.mjs';

export const name = 'channel-state';

const BRIDGE_CHANNELS = ['whatsapp', 'imessage'];

function normAccounts(accounts) {
  return (accounts ?? []).map((account) => ({
    accountId: account.accountId,
    pairingStatus: account.pairingStatus ?? null,
    peerName: account.peerName ?? null,
    lastSeenAt: account.lastSeenAt ?? null,
    allowFrom: account.allowFrom ?? [],
  }));
}

function tsChannel(channel, capabilities, accounts, binding) {
  return {
    channel,
    status: binding?.status ?? 'idle',
    externalPeerId: binding?.externalPeerId ?? null,
    peerName: binding?.peerName ?? null,
    transport: binding?.transport ?? null,
    lastSeenAt: binding?.lastSeenAt ?? null,
    accounts: accounts ?? null,
    supportsInbound: capabilities.supportsInbound,
    supportsOutbound: capabilities.supportsOutbound,
    supportsPairing: capabilities.supportsPairing,
    supportsStreaming: capabilities.supportsStreaming,
  };
}

function normRustChannel(channel) {
  return {
    channel: channel.channel,
    status: channel.status,
    externalPeerId: channel.externalPeerId ?? null,
    peerName: channel.peerName ?? null,
    transport: channel.transport ?? null,
    lastSeenAt: channel.lastSeenAt ?? null,
    accounts: channel.accounts === undefined ? null : normAccounts(channel.accounts),
    supportsInbound: channel.supportsInbound,
    supportsOutbound: channel.supportsOutbound,
    supportsPairing: channel.supportsPairing,
    supportsStreaming: channel.supportsStreaming,
  };
}

async function typescriptSide() {
  const dir = mkdtempSync(join(tmpdir(), 'betaclaw-parity-channel-state-'));
  process.env.MESSAGES_DB_PATH = join(dir, 'messages.db');
  const { SqliteMessageRepository } =
    await import('../../../../src/server/channels/messages/sqliteMessageRepository.ts');
  const { CHANNEL_CAPABILITIES } =
    await import('../../../../src/server/channels/adapters/capabilities.ts');
  const { listBridgeAccounts } =
    await import('../../../../src/server/channels/pairing/bridgeAccounts.ts');
  const { getPrincipalUserId } = await import('../../../../src/server/auth/principal.ts');

  const userId = getPrincipalUserId();
  const repo = new SqliteMessageRepository(process.env.MESSAGES_DB_PATH);
  const bindings = repo.listChannelBindings?.(userId) ?? [];
  const bindingMap = new Map(bindings.map((binding) => [binding.channel, binding]));

  const channels = Object.entries(CHANNEL_CAPABILITIES).map(([channel, capabilities]) => {
    const binding = bindingMap.get(channel);
    const accounts = BRIDGE_CHANNELS.includes(channel)
      ? normAccounts(listBridgeAccounts(channel))
      : null;
    return tsChannel(channel, capabilities, accounts, binding);
  });

  repo.close();
  bestEffortRemoveDir(dir);
  return { ok: true, channels };
}

async function rustCollect() {
  const response = await rustRequest('GET', '/api/channels/state');
  const body = response.json ?? {};
  return {
    ok: body.ok,
    hasGeneratedAt: typeof body.generatedAt === 'string',
    channels: (body.channels ?? []).map(normRustChannel),
  };
}

export async function run() {
  const ts = await typescriptSide();
  const rust = await rustCollect();

  check('ok', rust.ok, ts.ok);
  check('Anzahl Kanäle', rust.channels.length, ts.channels.length);
  for (let index = 0; index < ts.channels.length; index += 1) {
    check(`Kanal ${ts.channels[index].channel}`, rust.channels[index], ts.channels[index]);
  }
}
