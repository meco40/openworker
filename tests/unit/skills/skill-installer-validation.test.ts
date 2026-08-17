import { describe, expect, it } from 'vitest';
import { validateManifest } from '@/server/skills/skillInstaller';

const validManifest = {
  id: 'external-demo',
  name: 'External Demo',
  description: 'A test skill.',
  version: '1.0.0',
  category: 'utility',
  functionName: 'external_demo',
  tool: {
    name: 'external_demo',
    description: 'A test skill.',
    parameters: { type: 'object', properties: {} },
  },
};

describe('skill installer manifest validation', () => {
  it('accepts a relative handler path', () => {
    expect(validateManifest({ ...validManifest, handler: './handler.mjs' }).handler).toBe(
      './handler.mjs',
    );
  });

  it.each(['../handler.mjs', 'C:\\outside.mjs', '/outside.mjs', '\\\\server\\share\\handler.mjs'])(
    'rejects handler path escape %s',
    (handler) => {
      expect(() => validateManifest({ ...validManifest, handler })).toThrow(
        'handler" must stay inside',
      );
    },
  );

  it.each(['../skill', 'skill/name', 'skill\\name'])('rejects unsafe skill id %s', (id) => {
    expect(() => validateManifest({ ...validManifest, id })).toThrow(
      '"id" contains unsupported characters',
    );
  });
});
