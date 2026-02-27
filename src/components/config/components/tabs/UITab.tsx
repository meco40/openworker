'use client';

import React from 'react';
import {
  ALLOWED_UI_DEFAULT_VIEWS,
  ALLOWED_UI_DENSITIES,
  ALLOWED_UI_TIME_FORMATS,
} from '@/shared/config/uiSchema';
import { readString, getOrCreateObject } from '@/components/config/utils/configHelpers';
import type { ConfigTabProps } from '@/components/config/components/tabs/types';

interface FieldGroupProps {
  label: string;
  htmlFor: string;
  helper?: string;
  children: React.ReactNode;
}

const FieldGroup: React.FC<FieldGroupProps> = ({ label, htmlFor, helper, children }) => (
  <div>
    <label
      htmlFor={htmlFor}
      className="mb-1.5 block text-[11px] font-semibold tracking-wider text-zinc-400 uppercase"
    >
      {label}
    </label>
    {children}
    {helper && <p className="mt-1 text-[11px] text-zinc-600">{helper}</p>}
  </div>
);

const selectClass = (disabled: boolean) =>
  `w-full rounded-lg border border-zinc-700 bg-zinc-900/80 px-3 py-2 text-sm text-zinc-200 transition-colors focus:border-indigo-600 focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500 ${
    disabled ? 'cursor-not-allowed opacity-50' : ''
  }`;

const inputClass = (disabled: boolean) =>
  `w-full rounded-lg border border-zinc-700 bg-zinc-900/80 px-3 py-2 text-sm text-zinc-200 transition-colors focus:border-indigo-600 focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500 ${
    disabled ? 'cursor-not-allowed opacity-50' : ''
  }`;

export const UITab: React.FC<ConfigTabProps> = ({
  parsedConfig,
  simpleModeDisabled,
  updateConfigDraft,
}) => {
  const ui =
    parsedConfig?.ui && typeof parsedConfig.ui === 'object'
      ? (parsedConfig.ui as Record<string, unknown>)
      : {};

  return (
    <div className="space-y-5">
      <div>
        <h3 className="mb-3 text-xs font-semibold tracking-wider text-zinc-500 uppercase">
          Web UI Preferences
        </h3>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* Default view */}
          <FieldGroup label="Default View" htmlFor="ui-default-view">
            <select
              id="ui-default-view"
              aria-label="Default view"
              value={readString(ui, 'defaultView', 'dashboard')}
              disabled={simpleModeDisabled}
              onChange={(event) => {
                updateConfigDraft((draft) => {
                  getOrCreateObject(draft, 'ui').defaultView = event.target.value;
                });
              }}
              className={selectClass(simpleModeDisabled)}
            >
              {ALLOWED_UI_DEFAULT_VIEWS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </FieldGroup>

          {/* Density */}
          <FieldGroup
            label="Density"
            htmlFor="ui-density"
            helper="Controls spacing and element sizing throughout the UI."
          >
            <select
              id="ui-density"
              aria-label="UI density"
              value={readString(ui, 'density', 'comfortable')}
              disabled={simpleModeDisabled}
              onChange={(event) => {
                updateConfigDraft((draft) => {
                  getOrCreateObject(draft, 'ui').density = event.target.value;
                });
              }}
              className={selectClass(simpleModeDisabled)}
            >
              {ALLOWED_UI_DENSITIES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </FieldGroup>

          {/* Language */}
          <FieldGroup
            label="Language"
            htmlFor="ui-language"
            helper="BCP 47 language tag (e.g. en-US, de-DE)."
          >
            <input
              id="ui-language"
              aria-label="UI language"
              type="text"
              value={readString(ui, 'language', 'de-DE')}
              disabled={simpleModeDisabled}
              onChange={(event) => {
                updateConfigDraft((draft) => {
                  getOrCreateObject(draft, 'ui').language = event.target.value;
                });
              }}
              className={inputClass(simpleModeDisabled)}
            />
          </FieldGroup>

          {/* Time format */}
          <FieldGroup label="Time Format" htmlFor="ui-time-format">
            <select
              id="ui-time-format"
              aria-label="UI time format"
              value={readString(ui, 'timeFormat', '24h')}
              disabled={simpleModeDisabled}
              onChange={(event) => {
                updateConfigDraft((draft) => {
                  getOrCreateObject(draft, 'ui').timeFormat = event.target.value;
                });
              }}
              className={selectClass(simpleModeDisabled)}
            >
              {ALLOWED_UI_TIME_FORMATS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </FieldGroup>
        </div>
      </div>
    </div>
  );
};
