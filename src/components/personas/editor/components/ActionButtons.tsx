'use client';

import React from 'react';
import type { ActionButtonsProps } from '../types';

interface StatusBarProps {
  isGatewayTab: boolean;
  dirty: boolean;
  activeFile: string | null;
}

function StatusBar({ isGatewayTab, dirty, activeFile }: StatusBarProps) {
  return (
    <div className="font-mono text-[10px] text-zinc-600">
      {isGatewayTab ? (
        <span className="text-indigo-400">Gateway Konfiguration</span>
      ) : (
        <>
          {activeFile}
          {dirty && <span className="ml-2 text-amber-500">● Ungespeichert</span>}
        </>
      )}
    </div>
  );
}

export function ActionButtons({
  isGatewayTab,
  dirty,
  saving,
  savingPreferredModel,
  systemManaged,
  systemManagementHint,
  selectedId,
  editorContent,
  preferredModelId,
  onPreferredModelChange,
  saveFile,
}: ActionButtonsProps) {
  const activeFile = isGatewayTab ? null : 'FILE';

  return (
    <div className="flex items-center justify-between border-t border-zinc-800 bg-zinc-900/40 px-4 py-2">
      <StatusBar isGatewayTab={isGatewayTab} dirty={dirty} activeFile={activeFile} />
      <div className="flex items-center gap-3">
        {systemManaged && (
          <span className="text-[10px] text-amber-300/80">{systemManagementHint}</span>
        )}
        {!isGatewayTab && (
          <span className="text-[10px] text-zinc-600">{editorContent.length} Zeichen</span>
        )}
        <button
          onClick={isGatewayTab ? () => onPreferredModelChange(preferredModelId) : saveFile}
          disabled={
            systemManaged || (isGatewayTab ? savingPreferredModel : !dirty || saving || !selectedId)
          }
          className={`rounded-lg px-4 py-1.5 text-xs font-bold tracking-wider uppercase transition-all ${
            systemManaged
              ? 'cursor-not-allowed bg-zinc-800 text-zinc-600'
              : isGatewayTab
                ? savingPreferredModel
                  ? 'cursor-not-allowed bg-zinc-800 text-zinc-600'
                  : 'bg-indigo-600 text-white hover:bg-indigo-500'
                : dirty
                  ? 'bg-indigo-600 text-white hover:bg-indigo-500'
                  : 'cursor-not-allowed bg-zinc-800 text-zinc-600'
          }`}
        >
          {systemManaged
            ? 'Gesperrt'
            : isGatewayTab
              ? savingPreferredModel
                ? 'Speichern...'
                : 'Speichern'
              : saving
                ? 'Speichern...'
                : 'Speichern'}
        </button>
      </div>
    </div>
  );
}
