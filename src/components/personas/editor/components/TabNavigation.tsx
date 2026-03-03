'use client';

import React from 'react';
import { PERSONA_TAB_NAMES } from '@/server/personas/personaTypes';
import { TAB_LABELS } from '@/components/personas/personaLabels';
import { useConfirmDialog } from '@/components/shared/ConfirmDialogProvider';
import type { TabNavigationProps } from '../types';

export function TabNavigation({ activeTab, setActiveTab, dirty }: TabNavigationProps) {
  const confirm = useConfirmDialog();

  return (
    <div className="flex overflow-x-auto border-b border-zinc-800 px-4">
      {PERSONA_TAB_NAMES.map((tabName) => (
        <button
          key={tabName}
          onClick={async () => {
            if (tabName === activeTab) {
              return;
            }
            if (dirty) {
              const shouldDiscard = await confirm({
                title: 'Änderungen verwerfen?',
                description: 'Ungespeicherte Änderungen verwerfen?',
                confirmLabel: 'Verwerfen',
                tone: 'danger',
              });
              if (!shouldDiscard) {
                return;
              }
            }
            setActiveTab(tabName);
          }}
          className={`border-b-2 px-4 py-2.5 text-xs font-bold tracking-wider whitespace-nowrap uppercase transition-colors ${
            activeTab === tabName
              ? 'border-indigo-500 text-indigo-400'
              : 'border-transparent text-zinc-500 hover:text-zinc-300'
          }`}
        >
          {TAB_LABELS[tabName]}
        </button>
      ))}
    </div>
  );
}
