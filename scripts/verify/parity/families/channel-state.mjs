/**
 * `/api/channels/state` parity (S3): every channel with its capability flags,
 * the caller's binding and the bridge accounts of `whatsapp`/`imessage`.
 *
 * The reference is `golden/channel-state.json`, recorded from the TypeScript sources
 * before their removal; the Rust side goes over HTTP. A fresh database has no bindings, so every channel reports `idle`.
 * `generatedAt` is normalised to a presence flag.
 */
import { check, goldenReference, rustRequest } from '../harness.mjs';

export const name = 'channel-state';

function normAccounts(accounts) {
  return (accounts ?? []).map((account) => ({
    accountId: account.accountId,
    pairingStatus: account.pairingStatus ?? null,
    peerName: account.peerName ?? null,
    lastSeenAt: account.lastSeenAt ?? null,
    allowFrom: account.allowFrom ?? [],
  }));
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
  const ts = await goldenReference(name, 'typescript');
  const rust = await rustCollect();

  check('ok', rust.ok, ts.ok);
  check('Anzahl Kanäle', rust.channels.length, ts.channels.length);
  for (let index = 0; index < ts.channels.length; index += 1) {
    check(`Kanal ${ts.channels[index].channel}`, rust.channels[index], ts.channels[index]);
  }
}
