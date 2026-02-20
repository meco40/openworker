import { describe, expect, it } from 'vitest';
import { View } from '@/shared/domain/types';
import {
  ALLOWED_UI_DEFAULT_VIEWS,
  ALLOWED_UI_DENSITIES,
  ALLOWED_UI_TIME_FORMATS,
} from '@/shared/config/uiSchema';

describe('ui schema constants', () => {
  it('shares default views with View enum values', () => {
    expect(ALLOWED_UI_DEFAULT_VIEWS).toEqual(Object.values(View));
  });

  it('defines supported density and time format values', () => {
    expect(ALLOWED_UI_DENSITIES).toEqual(['comfortable', 'compact']);
    expect(ALLOWED_UI_TIME_FORMATS).toEqual(['12h', '24h']);
  });
});
