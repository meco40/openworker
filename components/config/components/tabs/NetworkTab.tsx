'use client';

import React from 'react';
import { getFieldMetadata } from '../../../../src/shared/config/fieldMetadata';
import {
  readString,
  readNumber,
  getOrCreateObject,
  normalizeHostFromBind,
  normalizeBindFromHost,
} from '../../utils/configHelpers';
import type { ConfigTabProps } from './types';

export const NetworkTab: React.FC<ConfigTabProps> = ({
  parsedConfig,
  simpleModeDisabled,
  fieldErrorFor,
  updateConfigDraft,
}) => {
  const gateway =
    parsedConfig?.gateway && typeof parsedConfig.gateway === 'object'
      ? (parsedConfig.gateway as Record<string, unknown>)
      : {};

  const bindValue = readString(
    gateway,
    'bind',
    normalizeBindFromHost(readString(gateway, 'host', '0.0.0.0')),
  );
  const bindPreset = bindValue === 'loopback' || bindValue === 'all' ? bindValue : 'custom';
  const hostValue = readString(gateway, 'host', normalizeHostFromBind(bindValue));

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <label className="space-y-2">
        <span className="text-[10px] tracking-widest text-zinc-500 uppercase">Port</span>
        <input
          aria-label="Gateway port"
          type="number"
          min={1}
          max={65535}
          value={readNumber(gateway, 'port', 8080)}
          disabled={simpleModeDisabled}
          onChange={(event) => {
            const port = Number.parseInt(event.target.value, 10);
            if (!Number.isFinite(port)) return;
            updateConfigDraft((draft) => {
              const draftGateway = getOrCreateObject(draft, 'gateway');
              draftGateway.port = port;
            });
          }}
          className={`w-full rounded border bg-zinc-900 px-3 py-2 text-sm text-white ${fieldErrorFor('gateway.port') ? 'border-rose-500' : 'border-zinc-700'}`}
        />
        <div className="text-[11px] text-zinc-500">{getFieldMetadata('gateway.port')?.helper}</div>
      </label>
      <label className="space-y-2">
        <span className="text-[10px] tracking-widest text-zinc-500 uppercase">Bind Preset</span>
        <select
          aria-label="Gateway bind preset"
          value={bindPreset}
          disabled={simpleModeDisabled}
          onChange={(event) => {
            const bind = event.target.value;
            updateConfigDraft((draft) => {
              const draftGateway = getOrCreateObject(draft, 'gateway');
              if (bind === 'loopback' || bind === 'all') {
                draftGateway.bind = bind;
                draftGateway.host = normalizeHostFromBind(bind);
              }
            });
          }}
          className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white"
        >
          <option value="loopback">Loopback (127.0.0.1)</option>
          <option value="all">All Interfaces (0.0.0.0)</option>
          <option value="custom">Custom</option>
        </select>
        <div className="text-[11px] text-zinc-500">{getFieldMetadata('gateway.bind')?.helper}</div>
      </label>
      <label className="space-y-2 md:col-span-2">
        <span className="text-[10px] tracking-widest text-zinc-500 uppercase">Host</span>
        <input
          aria-label="Gateway host"
          type="text"
          value={hostValue}
          disabled={simpleModeDisabled}
          onChange={(event) => {
            const host = event.target.value;
            updateConfigDraft((draft) => {
              const draftGateway = getOrCreateObject(draft, 'gateway');
              draftGateway.host = host;
              draftGateway.bind = normalizeBindFromHost(host);
            });
          }}
          className={`w-full rounded border bg-zinc-900 px-3 py-2 text-sm text-white ${fieldErrorFor('gateway.host') ? 'border-rose-500' : 'border-zinc-700'}`}
        />
        <div className="text-[11px] text-zinc-500">{getFieldMetadata('gateway.host')?.helper}</div>
      </label>
    </div>
  );
};
