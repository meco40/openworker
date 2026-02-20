import { describe, expect, it } from 'vitest';
import { pairChannel } from '@/server/channels/pairing';

describe('pairChannel', () => {
  it('rejects unsupported channels', async () => {
    await expect(pairChannel('unknown' as never, '')).rejects.toThrow();
  });
});
