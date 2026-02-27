'use client';

import React from 'react';
import { getFieldMetadata } from '@/shared/config/fieldMetadata';
import { readString, getOrCreateObject } from '@/components/config/utils/configHelpers';
import type { ConfigTabProps } from '@/components/config/components/tabs/types';

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

const LOG_LEVEL_DESCRIPTIONS: Record<LogLevel, string> = {
  debug: 'Verbose — all events including internal state',
  info: 'Standard — normal operations and key events',
  warn: 'Reduced — only warnings and errors',
  error: 'Minimal — only critical errors',
};

export const RuntimeTab: React.FC<ConfigTabProps> = ({
  parsedConfig,
  simpleModeDisabled,
  fieldErrorFor,
  updateConfigDraft,
}) => {
  const gateway =
    parsedConfig?.gateway && typeof parsedConfig.gateway === 'object'
      ? (parsedConfig.gateway as Record<string, unknown>)
      : {};

  const currentLevel = readString(gateway, 'logLevel', 'info') as LogLevel;
  const logLevelError = fieldErrorFor('gateway.logLevel');

  return (
    <div className="space-y-5">
      <div>
        <h3 className="mb-3 text-xs font-semibold tracking-wider text-zinc-500 uppercase">
          Runtime Settings
        </h3>

        {/* Log level */}
        <div className="max-w-sm">
          <label
            htmlFor="gateway-log-level"
            className="mb-1.5 block text-[11px] font-semibold tracking-wider text-zinc-400 uppercase"
          >
            Log Level
          </label>
          <select
            id="gateway-log-level"
            aria-label="Gateway log level"
            value={currentLevel}
            disabled={simpleModeDisabled}
            onChange={(event) => {
              const logLevel = event.target.value;
              updateConfigDraft((draft) => {
                const draftGateway = getOrCreateObject(draft, 'gateway');
                draftGateway.logLevel = logLevel;
              });
            }}
            className={`w-full rounded-lg border bg-zinc-900/80 px-3 py-2 text-sm text-zinc-200 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500 ${
              logLevelError ? 'border-red-600' : 'border-zinc-700 focus:border-indigo-600'
            } ${simpleModeDisabled ? 'cursor-not-allowed opacity-50' : ''}`}
          >
            {LOG_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
          {logLevelError && (
            <p className="mt-1 text-[11px] text-red-400">{logLevelError}</p>
          )}
          {!logLevelError && (
            <p className="mt-1 text-[11px] text-zinc-600">
              {LOG_LEVEL_DESCRIPTIONS[currentLevel] ?? getFieldMetadata('gateway.logLevel')?.helper}
            </p>
          )}
        </div>

        {/* Log level visual indicator */}
        <div className="mt-4 flex gap-2">
          {LOG_LEVELS.map((level) => (
            <div
              key={level}
              className={`flex-1 rounded-lg border px-2 py-2 text-center text-[10px] font-medium transition-colors ${
                level === currentLevel
                  ? 'border-indigo-600/60 bg-indigo-950/40 text-indigo-300'
                  : 'border-zinc-800 bg-zinc-900/40 text-zinc-600'
              }`}
            >
              {level}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
