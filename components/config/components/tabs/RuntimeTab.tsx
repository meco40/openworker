'use client';

import React from 'react';
import { getFieldMetadata } from '../../../../src/shared/config/fieldMetadata';
import { readString, getOrCreateObject } from '../../utils/configHelpers';
import type { ConfigTabProps } from './types';

export const RuntimeTab: React.FC<ConfigTabProps> = ({
  parsedConfig,
  simpleModeDisabled,
  fieldErrorFor,
  updateConfigDraft,
}) => {
  const gateway = parsedConfig?.gateway && typeof parsedConfig.gateway === 'object'
    ? parsedConfig.gateway as Record<string, unknown>
    : {};

  return (
    <label className="space-y-2">
      <span className="text-[10px] tracking-widest text-zinc-500 uppercase">Log Level</span>
      <select
        aria-label="Gateway log level"
        value={readString(gateway, 'logLevel', 'info')}
        disabled={simpleModeDisabled}
        onChange={(event) => {
          const logLevel = event.target.value;
          updateConfigDraft((draft) => {
            const draftGateway = getOrCreateObject(draft, 'gateway');
            draftGateway.logLevel = logLevel;
          });
        }}
        className={`w-full rounded border bg-zinc-900 px-3 py-2 text-sm text-white ${fieldErrorFor('gateway.logLevel') ? 'border-rose-500' : 'border-zinc-700'}`}
      >
        <option value="debug">debug</option>
        <option value="info">info</option>
        <option value="warn">warn</option>
        <option value="error">error</option>
      </select>
      <div className="text-[11px] text-zinc-500">
        {getFieldMetadata('gateway.logLevel')?.helper}
      </div>
    </label>
  );
};
