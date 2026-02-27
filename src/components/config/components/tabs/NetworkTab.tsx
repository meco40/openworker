'use client';

import React from 'react';
import { getFieldMetadata } from '@/shared/config/fieldMetadata';
import {
  readString,
  readNumber,
  getOrCreateObject,
  normalizeHostFromBind,
  normalizeBindFromHost,
} from '@/components/config/utils/configHelpers';
import type { ConfigTabProps } from '@/components/config/components/tabs/types';

// ─── Shared field wrapper ─────────────────────────────────────────────────────

interface FieldGroupProps {
  label: string;
  htmlFor?: string;
  helper?: string;
  error?: string | null;
  children: React.ReactNode;
  colSpan?: 'full' | 'half';
}

const FieldGroup: React.FC<FieldGroupProps> = ({
  label,
  htmlFor,
  helper,
  error,
  children,
  colSpan = 'half',
}) => (
  <div className={colSpan === 'full' ? 'md:col-span-2' : ''}>
    <label
      htmlFor={htmlFor}
      className="mb-1.5 block text-[11px] font-semibold tracking-wider text-zinc-400 uppercase"
    >
      {label}
    </label>
    {children}
    {error && <p className="mt-1 text-[11px] text-red-400">{error}</p>}
    {!error && helper && <p className="mt-1 text-[11px] text-zinc-600">{helper}</p>}
  </div>
);

const inputClass = (hasError: boolean, disabled: boolean) =>
  `w-full rounded-lg border bg-zinc-900/80 px-3 py-2 text-sm text-zinc-200 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500 ${
    hasError ? 'border-red-600' : 'border-zinc-700 focus:border-indigo-600'
  } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`;

// ─── Component ────────────────────────────────────────────────────────────────

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

  const portError = fieldErrorFor('gateway.port');
  const hostError = fieldErrorFor('gateway.host');

  return (
    <div className="space-y-5">
      <div>
        <h3 className="mb-3 text-xs font-semibold tracking-wider text-zinc-500 uppercase">
          Gateway Network Settings
        </h3>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* Port */}
          <FieldGroup
            label="Port"
            htmlFor="gateway-port"
            helper={getFieldMetadata('gateway.port')?.helper}
            error={portError}
          >
            <input
              id="gateway-port"
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
              className={inputClass(!!portError, simpleModeDisabled)}
            />
          </FieldGroup>

          {/* Bind preset */}
          <FieldGroup
            label="Bind Preset"
            htmlFor="gateway-bind"
            helper={getFieldMetadata('gateway.bind')?.helper}
          >
            <select
              id="gateway-bind"
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
              className={inputClass(false, simpleModeDisabled)}
            >
              <option value="loopback">Loopback (127.0.0.1)</option>
              <option value="all">All Interfaces (0.0.0.0)</option>
              <option value="custom">Custom</option>
            </select>
          </FieldGroup>

          {/* Host */}
          <FieldGroup
            label="Host"
            htmlFor="gateway-host"
            helper={getFieldMetadata('gateway.host')?.helper}
            error={hostError}
            colSpan="full"
          >
            <input
              id="gateway-host"
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
              className={inputClass(!!hostError, simpleModeDisabled)}
            />
          </FieldGroup>
        </div>
      </div>
    </div>
  );
};
