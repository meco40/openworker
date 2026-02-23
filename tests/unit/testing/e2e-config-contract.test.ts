import { describe, expect, it } from 'vitest';
import e2eConfig from '../../../vitest.e2e.config';
import liveConfig from '../../../vitest.e2e.live.config';

describe('e2e vitest configs', () => {
  it('targets only tests/e2e lane files', () => {
    expect(e2eConfig.test?.include).toEqual(['tests/e2e/**/*.e2e.test.ts']);
    expect(e2eConfig.test?.exclude).toEqual(['tests/e2e/**/*.live.e2e.test.ts']);
  });

  it('keeps live lane opt-in and isolated', () => {
    expect(liveConfig.test?.include).toEqual(['tests/e2e/**/*.live.e2e.test.ts']);
  });
});
