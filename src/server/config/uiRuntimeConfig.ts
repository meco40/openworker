import { View } from '@/shared/domain/types';
import { resolveViewFromConfig } from '@/modules/app-shell/useAppShellState';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function resolveDefaultViewFromConfig(config: unknown): View {
  if (!isObject(config)) {
    return View.DASHBOARD;
  }
  const ui = config.ui;
  if (!isObject(ui)) {
    return View.DASHBOARD;
  }
  return resolveViewFromConfig(ui.defaultView);
}
