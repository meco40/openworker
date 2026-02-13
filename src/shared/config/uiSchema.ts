import { View } from '../../../types';

export const ALLOWED_UI_DEFAULT_VIEWS = Object.freeze(Object.values(View));
export const ALLOWED_UI_DENSITIES = Object.freeze(['comfortable', 'compact'] as const);
export const ALLOWED_UI_TIME_FORMATS = Object.freeze(['12h', '24h'] as const);

export type UiDensity = (typeof ALLOWED_UI_DENSITIES)[number];
export type UiTimeFormat = (typeof ALLOWED_UI_TIME_FORMATS)[number];

export function isAllowedUiDefaultView(value: string): boolean {
  return ALLOWED_UI_DEFAULT_VIEWS.includes(value as View);
}

export function isAllowedUiDensity(value: string): value is UiDensity {
  return (ALLOWED_UI_DENSITIES as readonly string[]).includes(value);
}

export function isAllowedUiTimeFormat(value: string): value is UiTimeFormat {
  return (ALLOWED_UI_TIME_FORMATS as readonly string[]).includes(value);
}
