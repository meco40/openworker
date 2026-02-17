'use client';

import React from 'react';
import {
  ALLOWED_UI_DEFAULT_VIEWS,
  ALLOWED_UI_DENSITIES,
  ALLOWED_UI_TIME_FORMATS,
} from '../../../../src/shared/config/uiSchema';
import { readString, getOrCreateObject } from '../../utils/configHelpers';
import type { ConfigTabProps } from './types';

export const UITab: React.FC<ConfigTabProps> = ({
  parsedConfig,
  simpleModeDisabled,
  updateConfigDraft,
}) => {
  const ui = parsedConfig?.ui && typeof parsedConfig.ui === 'object'
    ? parsedConfig.ui as Record<string, unknown>
    : {};

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <label className="space-y-2">
        <span className="text-[10px] tracking-widest text-zinc-500 uppercase">Default View</span>
        <select
          aria-label="Default view"
          value={readString(ui, 'defaultView', 'dashboard')}
          disabled={simpleModeDisabled}
          onChange={(event) => {
            updateConfigDraft((draft) => {
              getOrCreateObject(draft, 'ui').defaultView = event.target.value;
            });
          }}
          className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white"
        >
          {ALLOWED_UI_DEFAULT_VIEWS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <label className="space-y-2">
        <span className="text-[10px] tracking-widest text-zinc-500 uppercase">Density</span>
        <select
          aria-label="UI density"
          value={readString(ui, 'density', 'comfortable')}
          disabled={simpleModeDisabled}
          onChange={(event) => {
            updateConfigDraft((draft) => {
              getOrCreateObject(draft, 'ui').density = event.target.value;
            });
          }}
          className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white"
        >
          {ALLOWED_UI_DENSITIES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <label className="space-y-2">
        <span className="text-[10px] tracking-widest text-zinc-500 uppercase">Language</span>
        <input
          aria-label="UI language"
          value={readString(ui, 'language', 'de-DE')}
          disabled={simpleModeDisabled}
          onChange={(event) => {
            updateConfigDraft((draft) => {
              getOrCreateObject(draft, 'ui').language = event.target.value;
            });
          }}
          className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white"
        />
      </label>
      <label className="space-y-2">
        <span className="text-[10px] tracking-widest text-zinc-500 uppercase">Time Format</span>
        <select
          aria-label="UI time format"
          value={readString(ui, 'timeFormat', '24h')}
          disabled={simpleModeDisabled}
          onChange={(event) => {
            updateConfigDraft((draft) => {
              getOrCreateObject(draft, 'ui').timeFormat = event.target.value;
            });
          }}
          className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white"
        >
          {ALLOWED_UI_TIME_FORMATS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
};
