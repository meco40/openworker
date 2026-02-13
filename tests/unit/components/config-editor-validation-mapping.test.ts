import { describe, expect, it } from 'vitest';
import { getFieldMetadata, mapValidationMessageToFieldPath } from '../../../src/shared/config/fieldMetadata';

describe('config editor validation mapping', () => {
  it('maps backend validation messages to known field paths', () => {
    expect(mapValidationMessageToFieldPath('gateway.port must be an integer between 1 and 65535.')).toBe(
      'gateway.port',
    );
    expect(mapValidationMessageToFieldPath('ui.timeFormat must be one of: 12h, 24h.')).toBe('ui.timeFormat');
  });

  it('provides helper copy for key fields', () => {
    expect(getFieldMetadata('gateway.host')?.helper).toContain('Gateway');
    expect(getFieldMetadata('gateway.logLevel')?.helper).toContain('Logs');
    expect(getFieldMetadata('ui.defaultView')?.helper).toContain('Startansicht');
  });
});
