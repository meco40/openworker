import { afterEach, describe, expect, it, vi } from 'vitest';
import { getModelHubEncryptionKey } from '@/server/model-hub/runtime';

afterEach(() => vi.unstubAllEnvs());

describe('Model Hub encryption configuration', () => {
  it.each(['development', 'production'])('requires a key in %s', (mode) => {
    vi.stubEnv('NODE_ENV', mode);
    vi.stubEnv('MODEL_HUB_ENCRYPTION_KEY', '');
    expect(() => getModelHubEncryptionKey()).toThrow('Missing MODEL_HUB_ENCRYPTION_KEY');
  });

  it.each([
    '0123456789abcdef0123456789abcdef',
    Buffer.from('0123456789abcdef0123456789abcdef').toString('hex'),
  ])('rejects both encodings of the public example outside tests', (key) => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('MODEL_HUB_ENCRYPTION_KEY', key);
    expect(() => getModelHubEncryptionKey()).toThrow('Public example');
  });

  it('validates key length and accepts a valid configured key', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('MODEL_HUB_ENCRYPTION_KEY', 'too-short');
    expect(() => getModelHubEncryptionKey()).toThrow('Encryption key must be');
    const key = Buffer.alloc(32, 42).toString('hex');
    vi.stubEnv('MODEL_HUB_ENCRYPTION_KEY', key);
    expect(getModelHubEncryptionKey()).toBe(key);
  });

  it('limits the synthetic fallback to unit tests', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('MODEL_HUB_ENCRYPTION_KEY', '');
    expect(Buffer.byteLength(getModelHubEncryptionKey())).toBe(32);
  });
});
