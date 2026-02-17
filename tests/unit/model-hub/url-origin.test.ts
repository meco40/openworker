import { describe, expect, it } from 'vitest';
import {
  buildModelHubCallbackUrl,
  normalizeBrowserOrigin,
} from '../../../src/server/model-hub/urlOrigin';

describe('model-hub url origin normalization', () => {
  it('normalizes 0.0.0.0 origin to localhost', () => {
    expect(normalizeBrowserOrigin('http://0.0.0.0:3000')).toBe('http://localhost:3000');
  });

  it('normalizes :: origin to localhost', () => {
    expect(normalizeBrowserOrigin('http://[::]:3000')).toBe('http://localhost:3000');
  });

  it('builds callback URL with normalized localhost origin', () => {
    expect(buildModelHubCallbackUrl('http://0.0.0.0:3000/api/model-hub/oauth/start')).toBe(
      'http://localhost:3000/api/model-hub/oauth/callback',
    );
  });
});
