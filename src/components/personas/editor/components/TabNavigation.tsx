'use client';

import React from 'react';
import { PERSONA_TAB_NAMES } from '@/server/personas/personaTypes';
import { TAB_LABELS } from '@/components/personas/personaLabels';
import type { TabNavigationProps } from '../types';

export function TabNavigation({ activeTab, setActiveTab, dirty }: TabNavigationProps) {
  return (
    <div className="flex overflow-x-auto border-b border-zinc-800 px-4">
      {PERSONA_TAB_NAMES.map((tabName) => (
        <button
          key={tabName}
          onClick={() => {
            if (
              dirty &&
              typeof window !== 'undefined' &&
              !window.confirm('Ungespeicherte Änderungen verwerfen?')
            )
              return;
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
