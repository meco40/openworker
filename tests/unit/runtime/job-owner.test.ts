import { describe, expect, it } from 'vitest';
import { resolveJobOwner } from '@/server/runtime/jobOwner';

describe('resolveJobOwner', () => {
  it('defaults to node when unset or empty', () => {
    expect(resolveJobOwner('BETACLAW_TELEGRAM_POLLER', 'node', {})).toBe('node');
    expect(
      resolveJobOwner('BETACLAW_TELEGRAM_POLLER', 'node', { BETACLAW_TELEGRAM_POLLER: '' }),
    ).toBe('node');
    expect(
      resolveJobOwner('BETACLAW_TELEGRAM_POLLER', 'node', { BETACLAW_TELEGRAM_POLLER: '  ' }),
    ).toBe('node');
  });

  it('resolves rust when set to rust with case-insensitivity and whitespace tolerance', () => {
    expect(
      resolveJobOwner('BETACLAW_TELEGRAM_POLLER', 'node', { BETACLAW_TELEGRAM_POLLER: 'rust' }),
    ).toBe('rust');
    expect(
      resolveJobOwner('BETACLAW_TELEGRAM_POLLER', 'node', { BETACLAW_TELEGRAM_POLLER: 'RUST' }),
    ).toBe('rust');
    expect(
      resolveJobOwner('BETACLAW_TELEGRAM_POLLER', 'node', { BETACLAW_TELEGRAM_POLLER: '  rust  ' }),
    ).toBe('rust');
  });

  it('resolves node when set to node', () => {
    expect(
      resolveJobOwner('BETACLAW_TELEGRAM_POLLER', 'node', { BETACLAW_TELEGRAM_POLLER: 'node' }),
    ).toBe('node');
    expect(
      resolveJobOwner('BETACLAW_TELEGRAM_POLLER', 'node', { BETACLAW_TELEGRAM_POLLER: 'NODE' }),
    ).toBe('node');
  });

  it('resolves off for off, false, 0', () => {
    expect(
      resolveJobOwner('BETACLAW_TELEGRAM_POLLER', 'node', { BETACLAW_TELEGRAM_POLLER: 'off' }),
    ).toBe('off');
    expect(
      resolveJobOwner('BETACLAW_TELEGRAM_POLLER', 'node', { BETACLAW_TELEGRAM_POLLER: 'OFF' }),
    ).toBe('off');
    expect(
      resolveJobOwner('BETACLAW_TELEGRAM_POLLER', 'node', { BETACLAW_TELEGRAM_POLLER: 'false' }),
    ).toBe('off');
    expect(
      resolveJobOwner('BETACLAW_TELEGRAM_POLLER', 'node', { BETACLAW_TELEGRAM_POLLER: '0' }),
    ).toBe('off');
  });

  it('forces node ownership to off if BETACLAW_NODE_BACKGROUND_JOBS is off', () => {
    expect(
      resolveJobOwner('BETACLAW_TELEGRAM_POLLER', 'node', {
        BETACLAW_TELEGRAM_POLLER: 'node',
        BETACLAW_NODE_BACKGROUND_JOBS: 'off',
      }),
    ).toBe('off');

    expect(
      resolveJobOwner('BETACLAW_TELEGRAM_POLLER', 'node', {
        BETACLAW_NODE_BACKGROUND_JOBS: 'off',
      }),
    ).toBe('off');

    // But explicit rust remains rust
    expect(
      resolveJobOwner('BETACLAW_TELEGRAM_POLLER', 'node', {
        BETACLAW_TELEGRAM_POLLER: 'rust',
        BETACLAW_NODE_BACKGROUND_JOBS: 'off',
      }),
    ).toBe('rust');
  });
});
